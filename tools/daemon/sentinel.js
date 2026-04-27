const fs = require('fs');
const path = require('path');
const { appendLog } = require('./log');
const {
  killProcess,
  validateDaemonAppProcess,
} = require('./process-info');
const { waitForReadiness } = require('./readiness');
const { LOG_FILE_NAME, SENTINEL_LOG_FILE_NAME } = require('./runtime-paths');
const {
  createFatalStateFromState,
  createRestartedRunningState,
  readState,
  updateStateAtomic,
} = require('./state-store');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_BACKOFF_POLL_INTERVAL_MS = 250;
const INITIAL_RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

function shouldExitForState(state, startAttemptId) {
  if (!state) {
    return true;
  }

  if (state.startAttemptId !== startAttemptId) {
    return true;
  }

  return state.status === 'stopping' || state.status === 'stopped' || state.status === 'fatal';
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid sentinel timestamp: ${value}`);
  }
  return date;
}

function getNow(options) {
  return toDate(typeof options.now === 'function' ? options.now() : new Date());
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRestartDecision(state, now, options = {}) {
  const windowMs = options.restartWindowMs ?? RESTART_WINDOW_MS;
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS_PER_WINDOW;
  const initialBackoffMs = options.initialBackoffMs ?? INITIAL_RESTART_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? MAX_RESTART_BACKOFF_MS;
  const nowMs = now.getTime();
  const windowStartValue = state.restartWindowStartedAt ?? state.lastRestartAt;
  const windowStartMs = windowStartValue ? Date.parse(windowStartValue) : Number.NaN;
  const withinWindow = Number.isFinite(windowStartMs) && nowMs - windowStartMs <= windowMs;
  const currentRestartCount = withinWindow ? state.restartCount : 0;
  const nextRestartCount = currentRestartCount + 1;
  const restartWindowStartedAt = withinWindow ? windowStartValue : now.toISOString();

  if (nextRestartCount > maxRestarts) {
    return {
      allowed: false,
      nextRestartCount,
      restartWindowStartedAt,
      reason: `restart limit exceeded: ${nextRestartCount}/${maxRestarts} within ${windowMs}ms`,
    };
  }

  return {
    allowed: true,
    nextRestartCount,
    restartWindowStartedAt,
    backoffMs: Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.max(0, nextRestartCount - 1)),
  };
}

function pathsFromState(state, statePath, sentinelLogPath, options = {}) {
  const runtimeDir = path.dirname(statePath);
  const root = path.dirname(state.serverCwd);
  return {
    root,
    serverDir: state.serverCwd,
    serverEntry: state.serverEntryPath,
    nodeBin: state.nodeBinPath,
    configPath: state.configPath,
    statePath,
    logPath: options.appLogPath ?? path.join(runtimeDir, LOG_FILE_NAME),
    sentinelLogPath: sentinelLogPath ?? path.join(runtimeDir, SENTINEL_LOG_FILE_NAME),
    launcherPath: state.launcherPath,
    totpSecretPath: state.totpSecretPath,
    isPackaged: state.nodeBinPath !== process.execPath || Boolean(process.pkg),
  };
}

async function defaultRestartPreflight({ paths, platform = process.platform }) {
  const { preflightConfig } = require('./config-preflight');
  const { runDaemonTotpPreflight } = require('./totp-preflight');

  let preflight;
  try {
    preflight = await preflightConfig({ paths, platform });
  } catch (error) {
    if (!error.fatalStage) {
      error.fatalStage = 'preflight';
    }
    throw error;
  }

  try {
    assertExistingTotpSecretForRestart(preflight.config, paths);
    await runDaemonTotpPreflight({
      paths,
      config: preflight.config,
      platform,
      suppressConsoleQr: true,
    });
  } catch (error) {
    if (!error.fatalStage) {
      error.fatalStage = 'totp-preflight';
    }
    throw error;
  }
}

function assertExistingTotpSecretForRestart(config, paths) {
  if (config.twoFactor?.enabled !== true) {
    return;
  }

  if (fs.existsSync(paths.totpSecretPath)) {
    return;
  }

  const error = new Error(`missing TOTP secret during sentinel restart: ${paths.totpSecretPath}`);
  error.fatalStage = 'totp-preflight';
  throw error;
}

async function defaultSpawnApp({ state, paths, options = {} }) {
  const { createDaemonAppLaunchOptions, spawnDetachedProcess } = require('./launcher');
  const launch = createDaemonAppLaunchOptions(
    state.port,
    state.bootstrapAllowedIps ?? [],
    state,
    paths,
    {
      baseEnv: options.baseEnv ?? process.env,
      localBinDirs: options.localBinDirs ?? [],
    },
  );
  return spawnDetachedProcess(launch);
}

async function inspectAppExit(state, options = {}) {
  if (typeof options.appExitProvider === 'function') {
    return options.appExitProvider(state);
  }

  const validation = await (options.validateAppProcess ?? validateDaemonAppProcess)(state, {
    now: options.now ? getNow(options) : undefined,
    maxHeartbeatAgeMs: options.maxHeartbeatAgeMs,
    platform: options.platform,
    processInfoProvider: options.processInfoProvider,
    skipHeartbeatFreshness: true,
  });
  return validation.valid
    ? { exited: false, lastExitCode: null }
    : { exited: true, lastExitCode: validation.reason };
}

function markFatalState({
  statePath,
  startAttemptId,
  logPath,
  stage,
  message,
  lastExitCode,
  now,
}) {
  let terminal = false;
  let updated = false;
  updateStateAtomic(statePath, (latestState) => {
    if (shouldExitForState(latestState, startAttemptId)) {
      terminal = true;
      return null;
    }

    if (!latestState || latestState.startAttemptId !== startAttemptId) {
      terminal = true;
      return null;
    }

    updated = true;
    return createFatalStateFromState(latestState, {
      stage,
      message,
      lastExitCode,
      now,
    });
  });

  if (updated) {
    appendLog(logPath, `[sentinel] fatal ${stage}: ${message}`);
    return 'fatal';
  }

  if (terminal) {
    appendLog(logPath, '[sentinel] terminal state observed before fatal write; exiting sentinel');
    return 'exit';
  }

  return 'continue';
}

function refreshHeartbeat({ statePath, startAttemptId, logPath, beforeHeartbeatWrite, now }) {
  const state = readState(statePath);
  if (shouldExitForState(state, startAttemptId)) {
    appendLog(logPath, '[sentinel] stopping marker observed; exiting sentinel');
    return 'exit';
  }

  if (state.status === 'running') {
    if (typeof beforeHeartbeatWrite === 'function') {
      beforeHeartbeatWrite();
    }

    let shouldExit = false;
    updateStateAtomic(statePath, (latestState) => {
      if (shouldExitForState(latestState, startAttemptId) || latestState.status !== 'running') {
        shouldExit = true;
        return null;
      }

      return {
        ...latestState,
        heartbeatAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });

    if (shouldExit) {
      appendLog(logPath, '[sentinel] stopping marker observed before heartbeat write; exiting sentinel');
      return 'exit';
    }
  }

  return 'continue';
}

async function waitForRestartBackoff({
  statePath,
  startAttemptId,
  logPath,
  backoffMs,
  options,
}) {
  const sleep = options.sleep ?? sleepMs;
  const pollIntervalMs = Math.max(1, options.backoffPollIntervalMs ?? DEFAULT_BACKOFF_POLL_INTERVAL_MS);
  let remainingMs = backoffMs;

  while (remainingMs > 0) {
    const currentSleepMs = Math.min(remainingMs, pollIntervalMs);
    await sleep(currentSleepMs);
    remainingMs -= currentSleepMs;

    const latestState = readState(statePath);
    if (shouldExitForState(latestState, startAttemptId)) {
      appendLog(logPath, '[sentinel] stopping marker observed during restart backoff; exiting sentinel');
      return 'exit';
    }

    if (!latestState || latestState.status !== 'running' || latestState.startAttemptId !== startAttemptId) {
      appendLog(logPath, '[sentinel] daemon state changed during restart backoff; exiting sentinel');
      return 'exit';
    }
  }

  return 'continue';
}

async function waitForReadinessWithStatePolling({
  waitForReadinessFn,
  readinessArgs,
  statePath,
  startAttemptId,
  logPath,
  options,
}) {
  let readinessSettled = false;
  const readinessPromise = waitForReadinessFn(readinessArgs)
    .then((readiness) => {
      readinessSettled = true;
      return { type: 'readiness', readiness };
    })
    .catch((error) => {
      readinessSettled = true;
      throw error;
    });

  const pollPromise = (async () => {
    const sleep = options.sleep ?? sleepMs;
    const pollIntervalMs = Math.max(1, options.readinessStatePollIntervalMs ?? DEFAULT_BACKOFF_POLL_INTERVAL_MS);

    while (!readinessSettled) {
      await sleep(pollIntervalMs);
      if (readinessSettled) {
        return null;
      }

      const latestState = readState(statePath);
      if (shouldExitForState(latestState, startAttemptId)) {
        appendLog(logPath, '[sentinel] stopping marker observed during restart readiness wait; exiting sentinel');
        return { type: 'exit' };
      }

      if (!latestState || latestState.status !== 'running' || latestState.startAttemptId !== startAttemptId) {
        appendLog(logPath, '[sentinel] daemon state changed during restart readiness wait; exiting sentinel');
        return { type: 'exit' };
      }
    }

    return null;
  })();

  const result = await Promise.race([readinessPromise, pollPromise]);
  if (result) {
    return result;
  }

  return readinessPromise;
}

async function restartApp({
  statePath,
  startAttemptId,
  logPath,
  state,
  lastExitCode,
  options,
}) {
  const firstDecision = getRestartDecision(state, getNow(options), options);
  if (!firstDecision.allowed) {
    return markFatalState({
      statePath,
      startAttemptId,
      logPath,
      stage: 'sentinel-runtime',
      message: firstDecision.reason,
      lastExitCode,
      now: getNow(options),
    });
  }

  appendLog(
    logPath,
    `[sentinel] app exit detected pid=${state.appPid} exit=${lastExitCode}; restarting after ${firstDecision.backoffMs}ms`,
  );
  const backoffResult = await waitForRestartBackoff({
    statePath,
    startAttemptId,
    logPath,
    backoffMs: firstDecision.backoffMs,
    options,
  });
  if (backoffResult === 'exit') {
    return 'exit';
  }

  const latestState = readState(statePath);
  if (shouldExitForState(latestState, startAttemptId)) {
    appendLog(logPath, '[sentinel] stopping marker observed during restart backoff; exiting sentinel');
    return 'exit';
  }

  if (!latestState || latestState.status !== 'running' || latestState.startAttemptId !== startAttemptId) {
    appendLog(logPath, '[sentinel] daemon state changed during restart backoff; exiting sentinel');
    return 'exit';
  }

  const now = getNow(options);
  const decision = getRestartDecision(latestState, now, options);
  if (!decision.allowed) {
    return markFatalState({
      statePath,
      startAttemptId,
      logPath,
      stage: 'sentinel-runtime',
      message: decision.reason,
      lastExitCode,
      now,
    });
  }

  const paths = pathsFromState(latestState, statePath, logPath, options);
  try {
    await (options.restartPreflight ?? defaultRestartPreflight)({
      paths,
      state: latestState,
      platform: options.platform ?? process.platform,
    });
  } catch (error) {
    return markFatalState({
      statePath,
      startAttemptId,
      logPath,
      stage: error?.fatalStage ?? 'app-startup',
      message: error instanceof Error ? error.message : String(error),
      lastExitCode,
      now: getNow(options),
    });
  }

  const plannedState = createRestartedRunningState(latestState, {
    appPid: latestState.appPid,
    restartCount: decision.nextRestartCount,
    restartWindowStartedAt: decision.restartWindowStartedAt,
    lastExitCode,
    now,
  });
  let spawnedPid = null;
  let restartedState = null;

  try {
    const spawnApp = options.spawnApp ?? defaultSpawnApp;
    const spawnResult = await spawnApp({
      state: plannedState,
      paths,
      options,
    });
    spawnedPid = spawnResult.pid;

    const update = updateStateAtomic(statePath, (currentState) => {
      if (
        shouldExitForState(currentState, startAttemptId)
        || !currentState
        || currentState.status !== 'running'
        || currentState.startAttemptId !== startAttemptId
        || currentState.appPid !== latestState.appPid
        || currentState.stateGeneration !== latestState.stateGeneration
      ) {
        return null;
      }

      return createRestartedRunningState(currentState, {
        appPid: spawnedPid,
        restartCount: decision.nextRestartCount,
        restartWindowStartedAt: decision.restartWindowStartedAt,
        lastExitCode,
        now,
      });
    });

    if (!update.updated) {
      (options.killProcess ?? killProcess)(spawnedPid);
      appendLog(logPath, '[sentinel] daemon state changed after restart spawn; killed new app child');
      return 'exit';
    }
    restartedState = update.state;

    const waitForReadinessFn = options.waitForReadiness ?? waitForReadiness;
    const readinessResult = await waitForReadinessWithStatePolling({
      waitForReadinessFn,
      readinessArgs: {
        port: restartedState.port,
        state: restartedState,
        timeoutMs: options.readinessTimeoutMs ?? 30000,
        intervalMs: options.readinessIntervalMs ?? 500,
      },
      statePath,
      startAttemptId,
      logPath,
      options,
    });

    if (readinessResult.type === 'exit') {
      return 'exit';
    }

    const latestAfterReadiness = readState(statePath);
    if (shouldExitForState(latestAfterReadiness, startAttemptId)) {
      appendLog(logPath, '[sentinel] stopping marker observed after restart readiness success; exiting sentinel');
      return 'exit';
    }

    const readiness = readinessResult.readiness;
    if (!readiness.ok) {
      (options.killProcess ?? killProcess)(spawnedPid);
      return markFatalState({
        statePath,
        startAttemptId,
        logPath,
        stage: 'app-startup',
        message: readiness.reason ?? 'readiness failed after sentinel restart',
        lastExitCode,
        now: getNow(options),
      });
    }

    appendLog(logPath, `[sentinel] restarted appPid=${spawnedPid} restartCount=${restartedState.restartCount}`);
    return 'restart';
  } catch (error) {
    if (spawnedPid !== null) {
      (options.killProcess ?? killProcess)(spawnedPid);
    }
    return markFatalState({
      statePath,
      startAttemptId,
      logPath,
      stage: error?.fatalStage ?? 'app-startup',
      message: error instanceof Error ? error.message : String(error),
      lastExitCode,
      now: getNow(options),
    });
  }
}

async function runSentinelTick(options) {
  const {
    statePath,
    startAttemptId,
    logPath,
    beforeHeartbeatWrite,
  } = options;
  const state = readState(statePath);
  if (shouldExitForState(state, startAttemptId)) {
    appendLog(logPath, '[sentinel] stopping marker observed; exiting sentinel');
    return 'exit';
  }

  if (!state || state.status !== 'running') {
    return 'continue';
  }

  const appExit = await inspectAppExit(state, options);
  if (appExit.exited) {
    return restartApp({
      statePath,
      startAttemptId,
      logPath,
      state,
      lastExitCode: appExit.lastExitCode ?? 'unknown',
      options,
    });
  }

  return refreshHeartbeat({
    statePath,
    startAttemptId,
    logPath,
    beforeHeartbeatWrite,
    now: getNow(options),
  });
}

function runSentinelLoop(options = {}) {
  const statePath = options.statePath ?? process.env.BUILDERGATE_DAEMON_STATE_PATH;
  const startAttemptId = options.startAttemptId ?? process.env.BUILDERGATE_DAEMON_START_ID;
  const logPath = options.logPath ?? process.env.BUILDERGATE_DAEMON_LOG_PATH;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const exit = options.exit ?? process.exit;

  if (!statePath || !startAttemptId || !logPath) {
    throw new Error('Sentinel requires BUILDERGATE_DAEMON_STATE_PATH, BUILDERGATE_DAEMON_START_ID, and BUILDERGATE_DAEMON_LOG_PATH');
  }

  appendLog(logPath, `[sentinel] started pid=${process.pid} startAttemptId=${startAttemptId}`);

  let timer = null;
  const schedule = () => {
    timer = setTimeout(async () => {
      let result = 'continue';
      try {
        result = await runSentinelTick({
          ...options,
          statePath,
          startAttemptId,
          logPath,
        });
      } catch (error) {
        appendLog(logPath, `[sentinel] fatal tick error: ${error instanceof Error ? error.message : String(error)}`);
        try {
          markFatalState({
            statePath,
            startAttemptId,
            logPath,
            stage: 'sentinel-runtime',
            message: error instanceof Error ? error.message : String(error),
            lastExitCode: null,
            now: new Date(),
          });
        } catch {
          // If the state file itself is unreadable, the log line above is the fallback evidence.
        }
        exit(1);
        return;
      }

      if (result === 'exit' || result === 'fatal') {
        exit(0);
        return;
      }

      schedule();
    }, intervalMs);
  };

  schedule();
  return timer;
}

module.exports = {
  DEFAULT_BACKOFF_POLL_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  INITIAL_RESTART_BACKOFF_MS,
  MAX_RESTART_BACKOFF_MS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  getRestartDecision,
  runSentinelLoop,
  runSentinelTick,
  shouldExitForState,
};
