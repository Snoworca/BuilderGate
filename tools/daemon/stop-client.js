const https = require('https');
const { spawnSync } = require('child_process');

const {
  isProcessRunning,
  killProcess,
  validateDaemonAppProcess,
  validateDaemonSentinelProcess,
} = require('./process-info');
const { resolveRuntimePaths } = require('./runtime-paths');
const {
  readState,
  updateStateAtomic,
} = require('./state-store');

const GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_PORT_OWNER_LOOKUP_TIMEOUT_MS = 2_000;
const SHUTDOWN_TOKEN_HEADER = 'X-BuilderGate-Shutdown-Token';
const WORKSPACE_FLUSH_MARKER = '[Shutdown] Workspace state + CWDs saved';
const SESSION_CLEANUP_EVIDENCE_FIELDS = [
  'sessionCleanupAttempted',
  'sessionCleanupCompleted',
  'sessionCleanupDegraded',
  'sessionCleanupSkippedUnverified',
  'remainingVerifiedDescendants',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeResult(exitCode, status, message, extra = {}) {
  return {
    exitCode,
    status,
    message,
    ...extra,
  };
}

function localAddressMatchesPort(localAddress, port) {
  return typeof localAddress === 'string' && localAddress.endsWith(`:${port}`);
}

function parseNetstatListeningPid(output, port) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') {
      continue;
    }

    const state = parts[3]?.toUpperCase();
    const pid = Number.parseInt(parts.at(-1), 10);
    if (state === 'LISTENING' && localAddressMatchesPort(parts[1], port) && Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }

  return null;
}

function findWindowsListeningProcessByPort(port, options = {}) {
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const result = spawnSyncFn('netstat', ['-ano'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options.portOwnerLookupTimeoutMs ?? DEFAULT_PORT_OWNER_LOOKUP_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return parseNetstatListeningPid(result.stdout, port);
}

function findListeningProcessByPort(port, options = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return findWindowsListeningProcessByPort(port, options);
  }

  return null;
}

function getRemainingTimeoutMs(deadlineMs) {
  return Math.max(0, deadlineMs - Date.now());
}

function getBudgetOrFailure(deadlineMs, totalTimeoutMs, stage) {
  const timeoutMs = getRemainingTimeoutMs(deadlineMs);
  if (timeoutMs <= 0) {
    return {
      timeoutMs: 0,
      failure: makeResult(
        1,
        'graceful-failure',
        `[stop] Graceful stop timed out after ${totalTimeoutMs}ms before ${stage}.`,
      ),
    };
  }

  return { timeoutMs, failure: null };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function getShutdownFlushEvidence(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'response body is missing' };
  }

  if (body.workspaceFlushed !== true) {
    return { valid: false, reason: 'workspaceFlushed is not true' };
  }

  if (!isNonEmptyString(body.workspaceDataPath)) {
    return { valid: false, reason: 'workspaceDataPath is missing' };
  }

  if (!isNonEmptyString(body.workspaceLastUpdated) || Number.isNaN(Date.parse(body.workspaceLastUpdated))) {
    return { valid: false, reason: 'workspaceLastUpdated is missing or invalid' };
  }

  if (!Number.isInteger(body.workspaceLastCwdCount) || body.workspaceLastCwdCount < 0) {
    return { valid: false, reason: 'workspaceLastCwdCount is missing or invalid' };
  }

  if (!Number.isInteger(body.workspaceTabCount) || body.workspaceTabCount < 0) {
    return { valid: false, reason: 'workspaceTabCount is missing or invalid' };
  }

  if (body.workspaceFlushMarker !== WORKSPACE_FLUSH_MARKER) {
    return { valid: false, reason: 'workspaceFlushMarker is missing or invalid' };
  }

  return {
    valid: true,
    evidence: {
      workspaceDataPath: body.workspaceDataPath,
      workspaceLastUpdated: body.workspaceLastUpdated,
      workspaceLastCwdCount: body.workspaceLastCwdCount,
      workspaceTabCount: body.workspaceTabCount,
      workspaceFlushMarker: body.workspaceFlushMarker,
    },
  };
}

function getShutdownSessionCleanupEvidence(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'response body is missing' };
  }

  for (const field of SESSION_CLEANUP_EVIDENCE_FIELDS) {
    if (!Number.isInteger(body[field]) || body[field] < 0) {
      return { valid: false, reason: `${field} is missing or invalid` };
    }
  }

  const evidence = {
    sessionCleanupAttempted: body.sessionCleanupAttempted,
    sessionCleanupCompleted: body.sessionCleanupCompleted,
    sessionCleanupDegraded: body.sessionCleanupDegraded,
    sessionCleanupSkippedUnverified: body.sessionCleanupSkippedUnverified,
    remainingVerifiedDescendants: body.remainingVerifiedDescendants,
  };
  const accounted = evidence.sessionCleanupCompleted
    + evidence.sessionCleanupDegraded
    + evidence.sessionCleanupSkippedUnverified;
  if (accounted > evidence.sessionCleanupAttempted) {
    return {
      valid: false,
      reason: 'session cleanup completed + degraded + skipped-unverified exceeds attempted',
    };
  }

  return { valid: true, evidence };
}

function getSessionCleanupStopPolicy(evidence, options = {}) {
  if (evidence.remainingVerifiedDescendants > 0) {
    return {
      ok: false,
      warnings: [],
      reason: `remaining verified descendants=${evidence.remainingVerifiedDescendants}`,
    };
  }

  const warnings = [];
  if (evidence.sessionCleanupDegraded > 0) {
    warnings.push(`session cleanup degraded=${evidence.sessionCleanupDegraded}`);
  }
  if (evidence.sessionCleanupSkippedUnverified > 0) {
    warnings.push(`session cleanup skipped-unverified=${evidence.sessionCleanupSkippedUnverified}`);
  }

  if (options.strictSessionCleanupEvidence && warnings.length > 0) {
    return {
      ok: false,
      warnings,
      reason: `strict session cleanup evidence failed: ${warnings.join('; ')}`,
    };
  }

  return { ok: true, warnings, reason: null };
}

function formatShutdownSessionCleanupEvidence(evidence) {
  return [
    `attempted=${evidence.sessionCleanupAttempted}`,
    `completed=${evidence.sessionCleanupCompleted}`,
    `degraded=${evidence.sessionCleanupDegraded}`,
    `skippedUnverified=${evidence.sessionCleanupSkippedUnverified}`,
    `remainingVerifiedDescendants=${evidence.remainingVerifiedDescendants}`,
  ].join(' ');
}

function formatStopSuccessMessage(state, evidence, sessionCleanupEvidence, warnings = []) {
  const lines = [
    '[stop] BuilderGate daemon stopped gracefully.',
    `[stop] App PID ${state.appPid}; Sentinel PID ${state.sentinelPid}; /health nonresponse confirmed.`,
    `[stop] Workspace data: ${evidence.workspaceDataPath}`,
    `[stop] ${evidence.workspaceFlushMarker} lastUpdated=${evidence.workspaceLastUpdated} lastCwdCount=${evidence.workspaceLastCwdCount}/${evidence.workspaceTabCount}`,
    `[stop] Session cleanup ${formatShutdownSessionCleanupEvidence(sessionCleanupEvidence)}`,
  ];
  for (const warning of warnings) {
    lines.push(`[stop] WARNING: ${warning}`);
  }
  return lines.join('\n');
}

function isSameDaemonState(left, right) {
  return Boolean(
    left
    && right
    && left.mode === 'daemon'
    && left.startAttemptId === right.startAttemptId
    && left.stateGeneration === right.stateGeneration
    && left.appPid === right.appPid
    && left.sentinelPid === right.sentinelPid,
  );
}

function isStoppableDaemonState(state) {
  return Boolean(state && state.mode === 'daemon' && (state.status === 'running' || state.status === 'stopping'));
}

function isRecoverableFatalPortOwnerState(state) {
  return Boolean(
    state
    && state.mode === 'daemon'
    && state.status === 'fatal'
    && state.fatalStage === 'app-startup'
    && Number.isInteger(state.port)
    && state.port >= 1024
    && state.port <= 65535,
  );
}

function toStoppingState(state, now = new Date()) {
  return {
    ...state,
    status: 'stopping',
    updatedAt: now.toISOString(),
  };
}

function toStoppedState(state, now = new Date()) {
  return {
    ...state,
    status: 'stopped',
    appPid: null,
    sentinelPid: null,
    appProcessStartedAt: null,
    heartbeatAt: null,
    lastExitCode: 0,
    updatedAt: now.toISOString(),
  };
}

function formatOrphanStopSuccessMessage(state, ownerPid) {
  return [
    `[stop] BuilderGate daemon state was fatal, but validated app PID ${ownerPid} was still listening on port ${state.port}.`,
    '[stop] Terminated orphaned BuilderGate app process and recorded stopped state.',
  ].join('\n');
}

function markStopping(statePath, expectedState, now = new Date(), updateStateFn = updateStateAtomic) {
  const result = updateStateFn(statePath, (latestState) => {
    if (!latestState || latestState.status !== 'running' || !isSameDaemonState(latestState, expectedState)) {
      return null;
    }

    return toStoppingState(latestState, now);
  });

  return result.updated ? result.state : null;
}

function markStopped(statePath, expectedState, now = new Date(), updateStateFn = updateStateAtomic) {
  const result = updateStateFn(statePath, (latestState) => {
    if (!latestState || !isSameDaemonState(latestState, expectedState)) {
      return null;
    }

    return toStoppedState(latestState, now);
  });

  return result.updated ? result.state : null;
}

function isProcessGone(pid, processExists = isProcessRunning) {
  return !processExists(pid);
}

function makeAlreadyExitedStoppedResult(paths, state, updateStateFn, options = {}) {
  const stoppedState = markStopped(paths.statePath, state, options.now ?? new Date(), updateStateFn);
  if (!stoppedState) {
    return makeResult(3, 'state-changed', '[stop] App process already exited, but state changed before stopped marker could be written.');
  }

  return makeResult(0, 'stopped', '[stop] BuilderGate daemon stopped; app process had already exited before internal shutdown.', {
    state: stoppedState,
  });
}

async function waitForProcessExit(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? STOP_POLL_INTERVAL_MS;
  const processExists = options.processExists ?? isProcessRunning;
  const deadline = Date.now() + timeoutMs;

  do {
    if (!processExists(pid)) {
      return { exited: true };
    }

    if (Date.now() < deadline) {
      await sleep(intervalMs);
    }
  } while (Date.now() < deadline);

  return { exited: false, reason: `process ${pid} did not exit within ${timeoutMs}ms` };
}

function requestJson(options, body = '') {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = chunks.join('');
        let parsed = {};
        if (text.trim()) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: parsed });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${options.timeout}ms`));
    });
    req.on('error', (error) => {
      resolve({ ok: false, statusCode: 0, error, nonresponse: true });
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function sendShutdownRequest({ port, token, timeoutMs = GRACEFUL_STOP_TIMEOUT_MS }) {
  const body = '{}';
  return requestJson({
    hostname: '127.0.0.1',
    port,
    path: '/api/internal/shutdown',
    method: 'POST',
    rejectUnauthorized: false,
    timeout: timeoutMs,
    headers: {
      [SHUTDOWN_TOKEN_HEADER]: token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

async function fetchHealth(port, timeoutMs) {
  return requestJson({
    hostname: '127.0.0.1',
    port,
    path: '/health',
    method: 'GET',
    rejectUnauthorized: false,
    timeout: timeoutMs,
  });
}

async function waitForHealthNonresponse({
  port,
  timeoutMs = GRACEFUL_STOP_TIMEOUT_MS,
  intervalMs = STOP_POLL_INTERVAL_MS,
  fetchHealth: fetchHealthFn = fetchHealth,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;

  do {
    const response = await fetchHealthFn(port, Math.min(intervalMs, 1000));
    lastResponse = response;
    if (response.nonresponse) {
      return { stopped: true };
    }
    if (response.statusCode !== 200) {
      return { stopped: false, reason: `health returned HTTP ${response.statusCode}` };
    }

    if (Date.now() < deadline) {
      await sleep(intervalMs);
    }
  } while (Date.now() < deadline);

  const status = lastResponse?.statusCode ?? 0;
  return { stopped: false, reason: `health still responds${status ? ` with ${status}` : ''}` };
}

async function tryStopFatalPortOwner(paths, state, options = {}) {
  if (!isRecoverableFatalPortOwnerState(state)) {
    return null;
  }

  const processExists = options.processExists ?? isProcessRunning;
  const findPortOwnerProcessFn = options.findPortOwnerProcess ?? findListeningProcessByPort;
  const ownerPid = await findPortOwnerProcessFn(state.port, options);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !processExists(ownerPid)) {
    return null;
  }

  const validationState = {
    ...state,
    status: 'running',
    appPid: ownerPid,
    appProcessStartedAt: state.appProcessStartedAt ?? state.startedAt,
    heartbeatAt: state.heartbeatAt ?? state.updatedAt,
  };
  const validation = await validateDaemonAppProcess(validationState, {
    now: options.now,
    maxHeartbeatAgeMs: options.maxHeartbeatAgeMs,
    platform: options.platform,
    processInfoProvider: options.processInfoProvider,
    skipHeartbeatFreshness: true,
  });
  if (!validation.valid) {
    return makeResult(2, 'validation-failed', `[stop] Refusing to stop daemon: port owner PID ${ownerPid} is not a validated BuilderGate app process: ${validation.reason}`, {
      validation,
    });
  }

  const totalTimeoutMs = options.timeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? Date.now() + totalTimeoutMs;
  const budget = getBudgetOrFailure(deadlineMs, totalTimeoutMs, 'orphan process termination');
  if (budget.failure) {
    return budget.failure;
  }

  const killProcessFn = options.killProcess ?? killProcess;
  const terminated = killProcessFn(ownerPid);
  if (!terminated && processExists(ownerPid)) {
    return makeResult(1, 'graceful-failure', `[stop] Failed to terminate orphaned BuilderGate app PID ${ownerPid}.`);
  }

  const waitForProcessExitFn = options.waitForProcessExit ?? waitForProcessExit;
  const ownerExit = await waitForProcessExitFn(ownerPid, {
    timeoutMs: budget.timeoutMs,
    intervalMs: options.intervalMs ?? STOP_POLL_INTERVAL_MS,
    processExists,
  });
  if (!ownerExit.exited) {
    return makeResult(1, 'graceful-failure', `[stop] Orphaned BuilderGate app PID ${ownerPid} did not exit: ${ownerExit.reason}`);
  }

  const healthBudget = getBudgetOrFailure(deadlineMs, totalTimeoutMs, 'health nonresponse verification');
  if (healthBudget.failure) {
    return healthBudget.failure;
  }
  const waitForHealthNonresponseFn = options.waitForHealthNonresponse ?? waitForHealthNonresponse;
  const health = await waitForHealthNonresponseFn({
    port: state.port,
    timeoutMs: healthBudget.timeoutMs,
    intervalMs: options.intervalMs ?? STOP_POLL_INTERVAL_MS,
  });
  if (!health.stopped) {
    return makeResult(1, 'graceful-failure', `[stop] Orphaned app terminated but ${health.reason}`, { health });
  }

  const updateStateFn = options.updateStateAtomic ?? updateStateAtomic;
  const stoppedState = markStopped(paths.statePath, state, options.now ?? new Date(), updateStateFn);
  if (!stoppedState) {
    return makeResult(3, 'state-changed', '[stop] Orphaned app stopped, but state changed before stopped marker could be written.', {
      health,
    });
  }

  return makeResult(0, 'orphan-stopped', formatOrphanStopSuccessMessage(state, ownerPid), {
    health,
    state: stoppedState,
  });
}

async function stopDaemon(paths = resolveRuntimePaths(), options = {}) {
  const readStateFn = options.readState ?? readState;
  const state = readStateFn(paths.statePath);
  const updateStateFn = options.updateStateAtomic ?? updateStateAtomic;
  const processExists = options.processExists ?? isProcessRunning;
  const waitForProcessExitFn = options.waitForProcessExit ?? waitForProcessExit;
  const totalTimeoutMs = options.timeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? Date.now() + totalTimeoutMs;
  if (!isStoppableDaemonState(state)) {
    const fatalPortOwnerStop = await tryStopFatalPortOwner(paths, state, {
      ...options,
      processExists,
      waitForProcessExit: waitForProcessExitFn,
      updateStateAtomic: updateStateFn,
      timeoutMs: totalTimeoutMs,
      deadlineMs,
    });
    if (fatalPortOwnerStop) {
      return fatalPortOwnerStop;
    }
    return makeResult(0, 'not-running', '[stop] BuilderGate daemon is not running.');
  }

  const resumingStop = state.status === 'stopping';
  const stopWarnings = [];
  let sentinelExitedBeforeShutdown = false;

  if (isProcessGone(state.appPid, processExists)) {
    const stoppingState = resumingStop
      ? state
      : markStopping(paths.statePath, state, options.now ?? new Date(), updateStateFn);
    if (!stoppingState) {
      return makeResult(3, 'state-changed', '[stop] App process already exited, but stopping marker could not be written.');
    }

    if (processExists(state.sentinelPid)) {
      const budget = getBudgetOrFailure(deadlineMs, totalTimeoutMs, 'sentinel exit');
      if (budget.failure) {
        return budget.failure;
      }
      const sentinelExit = await waitForProcessExitFn(state.sentinelPid, {
        timeoutMs: budget.timeoutMs,
        intervalMs: options.intervalMs ?? STOP_POLL_INTERVAL_MS,
        processExists,
      });
      if (!sentinelExit.exited) {
        return makeResult(1, 'graceful-failure', `[stop] Sentinel did not exit gracefully: ${sentinelExit.reason}`);
      }
    }

    return makeAlreadyExitedStoppedResult(paths, stoppingState, updateStateFn, options);
  }

  const validationOptions = {
    now: options.now,
    maxHeartbeatAgeMs: options.maxHeartbeatAgeMs,
    platform: options.platform,
    processInfoProvider: options.processInfoProvider,
    expectedStatePath: paths.statePath,
    allowStoppingState: resumingStop,
    allowUnknownProcessInfo: true,
    allowStaleHeartbeatWithUnknownProcessInfo: true,
    skipHeartbeatFreshness: resumingStop,
  };
  const appValidation = await (options.validateAppProcess ?? validateDaemonAppProcess)(state, validationOptions);
  if (!appValidation.valid) {
    return makeResult(2, 'validation-failed', `[stop] Refusing to stop daemon: ${appValidation.reason}`, {
      validation: appValidation,
    });
  }

  if (!resumingStop && processExists(state.sentinelPid)) {
    const sentinelValidation = await (options.validateSentinelProcess ?? validateDaemonSentinelProcess)(state, validationOptions);
    if (!sentinelValidation.valid) {
      return makeResult(2, 'validation-failed', `[stop] Refusing to stop daemon: ${sentinelValidation.reason}`, {
        validation: sentinelValidation,
      });
    }
  }

  const stoppingState = resumingStop
    ? state
    : markStopping(paths.statePath, state, options.now ?? new Date(), updateStateFn);
  if (!stoppingState) {
    return makeResult(3, 'state-changed', '[stop] Daemon state changed while stopping. No process was terminated.');
  }

  if (processExists(state.sentinelPid)) {
    const budget = getBudgetOrFailure(deadlineMs, totalTimeoutMs, 'sentinel exit');
    if (budget.failure) {
      return budget.failure;
    }
    const sentinelTimeoutMs = resumingStop
      ? Math.min(budget.timeoutMs, options.resumingSentinelGraceTimeoutMs ?? 1_000)
      : budget.timeoutMs;
    const sentinelExit = await waitForProcessExitFn(state.sentinelPid, {
      timeoutMs: sentinelTimeoutMs,
      intervalMs: options.intervalMs ?? STOP_POLL_INTERVAL_MS,
      processExists,
    });
    if (!sentinelExit.exited) {
      if (resumingStop) {
        stopWarnings.push(`sentinel did not exit before app shutdown: ${sentinelExit.reason}`);
      } else {
        return makeResult(1, 'graceful-failure', `[stop] Sentinel did not exit gracefully: ${sentinelExit.reason}`);
      }
    } else {
      sentinelExitedBeforeShutdown = true;
    }
  }

  if (isProcessGone(state.appPid, processExists)) {
    return makeAlreadyExitedStoppedResult(paths, stoppingState, updateStateFn, options);
  }

  const sendShutdownRequestFn = options.sendShutdownRequest ?? sendShutdownRequest;
  const shutdownBudget = getBudgetOrFailure(deadlineMs, totalTimeoutMs, 'internal shutdown request');
  if (shutdownBudget.failure) {
    return shutdownBudget.failure;
  }
  const shutdown = await sendShutdownRequestFn({
    port: state.port,
    token: state.shutdownToken,
    timeoutMs: shutdownBudget.timeoutMs,
  });
  if (!shutdown.ok || shutdown.statusCode !== 200 || shutdown.body?.ok === false) {
    if (shutdown.nonresponse && isProcessGone(state.appPid, processExists)) {
      return makeAlreadyExitedStoppedResult(paths, stoppingState, updateStateFn, options);
    }

    const detail = shutdown.error?.message
      ?? shutdown.body?.error?.message
      ?? shutdown.body?.raw
      ?? `HTTP ${shutdown.statusCode}`;
    return makeResult(1, 'graceful-failure', `[stop] Internal shutdown failed: ${detail}`, { shutdown });
  }

  const flushEvidence = getShutdownFlushEvidence(shutdown.body);
  if (!flushEvidence.valid) {
    return makeResult(
      1,
      'graceful-failure',
      `[stop] Internal shutdown response lacked workspace flush evidence: ${flushEvidence.reason}`,
      { shutdown },
    );
  }

  const sessionCleanupEvidence = getShutdownSessionCleanupEvidence(shutdown.body);
  if (!sessionCleanupEvidence.valid) {
    return makeResult(
      1,
      'graceful-failure',
      `[stop] Internal shutdown response lacked session cleanup evidence: ${sessionCleanupEvidence.reason}`,
      { shutdown, flushEvidence: flushEvidence.evidence },
    );
  }

  const sessionCleanupPolicy = getSessionCleanupStopPolicy(sessionCleanupEvidence.evidence, {
    strictSessionCleanupEvidence: options.strictSessionCleanupEvidence === true,
  });
  if (!sessionCleanupPolicy.ok) {
    return makeResult(
      1,
      'graceful-failure',
      `[stop] Internal shutdown session cleanup evidence failed: ${sessionCleanupPolicy.reason}`,
      {
        shutdown,
        flushEvidence: flushEvidence.evidence,
        sessionCleanupEvidence: sessionCleanupEvidence.evidence,
        sessionCleanupWarnings: sessionCleanupPolicy.warnings,
      },
    );
  }

  const waitForHealthNonresponseFn = options.waitForHealthNonresponse ?? waitForHealthNonresponse;
  const healthBudget = getBudgetOrFailure(deadlineMs, totalTimeoutMs, 'health nonresponse verification');
  if (healthBudget.failure) {
    return healthBudget.failure;
  }
  const health = await waitForHealthNonresponseFn({
    port: state.port,
    timeoutMs: healthBudget.timeoutMs,
    intervalMs: options.intervalMs ?? STOP_POLL_INTERVAL_MS,
  });
  if (!health.stopped) {
    return makeResult(1, 'graceful-failure', `[stop] Internal shutdown completed but ${health.reason}`, { shutdown, health });
  }

  if (!sentinelExitedBeforeShutdown && processExists(state.sentinelPid)) {
    const killProcessFn = options.killProcess ?? killProcess;
    const terminated = killProcessFn(state.sentinelPid);
    if (!terminated && processExists(state.sentinelPid)) {
      return makeResult(1, 'graceful-failure', `[stop] Failed to terminate stuck sentinel PID ${state.sentinelPid}.`, {
        shutdown,
        health,
      });
    }

    const sentinelExit = await waitForProcessExitFn(state.sentinelPid, {
      timeoutMs: options.sentinelForceExitTimeoutMs ?? 2_000,
      intervalMs: options.intervalMs ?? STOP_POLL_INTERVAL_MS,
      processExists,
    });
    if (!sentinelExit.exited) {
      return makeResult(1, 'graceful-failure', `[stop] Stuck sentinel PID ${state.sentinelPid} did not exit after termination: ${sentinelExit.reason}`, {
        shutdown,
        health,
      });
    }

    stopWarnings.push(`terminated stuck sentinel PID ${state.sentinelPid} after app shutdown`);
  }

  const stoppedState = markStopped(paths.statePath, stoppingState, options.now ?? new Date(), updateStateFn);
  if (!stoppedState) {
    return makeResult(3, 'state-changed', '[stop] Daemon stopped, but state changed before stopped marker could be written.', {
      shutdown,
      health,
    });
  }

  return makeResult(0, 'stopped', formatStopSuccessMessage(
    state,
    flushEvidence.evidence,
    sessionCleanupEvidence.evidence,
    [...sessionCleanupPolicy.warnings, ...stopWarnings],
  ), {
    flushEvidence: flushEvidence.evidence,
    sessionCleanupEvidence: sessionCleanupEvidence.evidence,
    sessionCleanupWarnings: sessionCleanupPolicy.warnings,
    stopWarnings,
    shutdown,
    health,
    state: stoppedState,
  });
}

module.exports = {
  GRACEFUL_STOP_TIMEOUT_MS,
  SHUTDOWN_TOKEN_HEADER,
  WORKSPACE_FLUSH_MARKER,
  findListeningProcessByPort,
  getShutdownSessionCleanupEvidence,
  getSessionCleanupStopPolicy,
  parseNetstatListeningPid,
  markStopped,
  markStopping,
  sendShutdownRequest,
  stopDaemon,
  waitForHealthNonresponse,
  waitForProcessExit,
};
