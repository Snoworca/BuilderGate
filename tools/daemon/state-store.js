const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { maskObject } = require('./log');

const VALID_STATUSES = new Set(['starting', 'running', 'stopping', 'stopped', 'fatal']);
const VALID_MODES = new Set(['daemon', 'foreground']);
const VALID_FATAL_STAGES = new Set(['preflight', 'totp-preflight', 'app-startup', 'sentinel-runtime', 'shutdown', 'unknown']);
const MIN_RANDOM_TOKEN_CHARS = 43;
const LOCK_STALE_MS = 30000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid daemon state: ${field} must be a non-empty string`);
  }
}

function createRandomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function assertRandomToken(value, field) {
  assertString(value, field);
  if (value.length < MIN_RANDOM_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid daemon state: ${field} must be a base64url token from at least 32 random bytes`);
  }
}

function assertNullableString(value, field) {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Invalid daemon state: ${field} must be a string or null`);
  }
}

function assertOptionalStringArray(value, field) {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`Invalid daemon state: ${field} must be an array of non-empty strings`);
  }
}

function assertNumber(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid daemon state: ${field} must be a non-negative integer`);
  }
}

function assertNullablePid(value, field) {
  if (value === null || value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid daemon state: ${field} must be null or a positive integer`);
  }
}

function assertIsoLikeString(value, field) {
  assertString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid daemon state: ${field} must be an ISO timestamp`);
  }
}

function validateCommonState(state) {
  if (state.version !== '1') {
    throw new Error('Invalid daemon state: version must be "1"');
  }

  assertString(state.appName, 'appName');

  if (!VALID_MODES.has(state.mode)) {
    throw new Error(`Invalid daemon state: mode must be one of ${[...VALID_MODES].join(', ')}`);
  }

  if (!VALID_STATUSES.has(state.status)) {
    throw new Error(`Invalid daemon state: status must be one of ${[...VALID_STATUSES].join(', ')}`);
  }

  assertString(state.launcherPath, 'launcherPath');
  assertString(state.serverEntryPath, 'serverEntryPath');
  assertString(state.serverCwd, 'serverCwd');
  assertString(state.nodeBinPath, 'nodeBinPath');
  assertString(state.configPath, 'configPath');
  assertString(state.totpSecretPath, 'totpSecretPath');
  assertIsoLikeString(state.startedAt, 'startedAt');
  assertString(state.argvHash, 'argvHash');
  assertRandomToken(state.shutdownToken, 'shutdownToken');
  assertString(state.startAttemptId, 'startAttemptId');
  assertNumber(state.stateGeneration, 'stateGeneration');
  assertNumber(state.restartCount, 'restartCount');
  assertNullableString(state.lastRestartAt, 'lastRestartAt');
  assertNullableString(state.restartWindowStartedAt ?? null, 'restartWindowStartedAt');
  assertNullableString(state.fatalReason, 'fatalReason');
  assertNullableString(state.fatalStage, 'fatalStage');
  assertString(state.updatedAt, 'updatedAt');
  assertOptionalStringArray(state.bootstrapAllowedIps, 'bootstrapAllowedIps');

  if (state.port !== null && (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535)) {
    throw new Error('Invalid daemon state: port must be null or a port between 1024 and 65535');
  }

  if (
    state.lastExitCode !== null
    && typeof state.lastExitCode !== 'string'
    && !Number.isInteger(state.lastExitCode)
  ) {
    throw new Error('Invalid daemon state: lastExitCode must be a number, string, or null');
  }
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Invalid daemon state: expected object');
  }

  validateCommonState(state);
  assertNullablePid(state.appPid, 'appPid');
  assertNullablePid(state.sentinelPid, 'sentinelPid');

  if (state.status === 'running' || state.status === 'stopping') {
    if (!Number.isInteger(state.appPid) || state.appPid <= 0) {
      throw new Error(`Invalid daemon state: appPid is required for ${state.status}`);
    }
    if (!Number.isInteger(state.sentinelPid) || state.sentinelPid <= 0) {
      throw new Error(`Invalid daemon state: sentinelPid is required for ${state.status}`);
    }
    assertString(state.appProcessStartedAt, 'appProcessStartedAt');
    assertIsoLikeString(state.heartbeatAt, 'heartbeatAt');
  }

  if (state.status === 'fatal') {
    assertString(state.fatalReason, 'fatalReason');
    assertString(state.fatalStage, 'fatalStage');
    if (!VALID_FATAL_STAGES.has(state.fatalStage)) {
      throw new Error(`Invalid daemon state: fatalStage must be one of ${[...VALID_FATAL_STAGES].join(', ')}`);
    }
    if (state.fatalStage !== 'preflight' && state.port === null) {
      throw new Error('Invalid daemon state: only preflight fatal state may have port=null');
    }
  }

  return state;
}

function makeStateBase({ appName = 'buildergate', mode = 'daemon', paths, port = null, argvHash = 'preflight' }) {
  const now = new Date().toISOString();
  return {
    version: '1',
    appName,
    mode,
    launcherPath: paths.launcherPath,
    serverEntryPath: paths.serverEntry ?? paths.serverEntryPath,
    serverCwd: paths.serverCwd ?? paths.serverDir,
    nodeBinPath: paths.nodeBin ?? paths.nodeBinPath,
    configPath: paths.configPath,
    totpSecretPath: paths.totpSecretPath,
    port,
    startedAt: now,
    argvHash,
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    updatedAt: now,
  };
}

function createFatalState({ appName = 'buildergate', stage, message, paths, port = null, argvHash = 'preflight' }) {
  return validateState({
    ...makeStateBase({ appName, mode: 'daemon', paths, port, argvHash }),
    status: 'fatal',
    appPid: null,
    sentinelPid: null,
    appProcessStartedAt: null,
    heartbeatAt: null,
    fatalStage: stage,
    fatalReason: message,
  });
}

function createStartingState({
  appName = 'buildergate',
  paths,
  port,
  argvHash,
  previousState = null,
  bootstrapAllowedIps = [],
}) {
  const state = {
    ...makeStateBase({ appName, mode: 'daemon', paths, port, argvHash }),
    status: 'starting',
    appPid: null,
    sentinelPid: null,
    appProcessStartedAt: null,
    heartbeatAt: null,
    stateGeneration: Number.isInteger(previousState?.stateGeneration)
      ? previousState.stateGeneration + 1
      : 1,
  };

  if (bootstrapAllowedIps.length > 0) {
    state.bootstrapAllowedIps = [...bootstrapAllowedIps];
  }

  return validateState(state);
}

function createRunningState(startingState, { appPid, sentinelPid }) {
  const now = new Date().toISOString();
  return validateState({
    ...startingState,
    status: 'running',
    appPid,
    sentinelPid,
    appProcessStartedAt: now,
    heartbeatAt: now,
    updatedAt: now,
  });
}

function toIsoTimestamp(value = new Date()) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid daemon state timestamp: ${value}`);
  }

  return parsed.toISOString();
}

function createRestartedRunningState(state, {
  appPid,
  restartCount,
  restartWindowStartedAt,
  lastExitCode = null,
  now = new Date(),
}) {
  const nowIso = toIsoTimestamp(now);
  const nextState = {
    ...state,
    status: 'running',
    appPid,
    stateGeneration: state.stateGeneration + 1,
    restartCount,
    lastRestartAt: nowIso,
    lastExitCode,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: nowIso,
    heartbeatAt: nowIso,
    updatedAt: nowIso,
  };

  if (restartWindowStartedAt) {
    nextState.restartWindowStartedAt = restartWindowStartedAt;
  }

  return validateState(nextState);
}

function createFatalStateFromState(state, {
  stage = 'unknown',
  message,
  lastExitCode = null,
  now = new Date(),
}) {
  return validateState({
    ...state,
    status: 'fatal',
    fatalStage: stage,
    fatalReason: message,
    lastExitCode,
    updatedAt: toIsoTimestamp(now),
  });
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse daemon state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return validateState(parsed);
}

function setOwnerOnlyPermissions(filePath, platform = process.platform) {
  if (platform === 'win32') {
    return {
      applied: false,
      skipped: true,
      reason: 'Windows ACL owner-only validation is not available through fs.chmod',
    };
  }

  fs.chmodSync(filePath, 0o600);
  return {
    applied: true,
    skipped: false,
  };
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function acquireStateLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      return fd;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for daemon state lock: ${lockPath}`);
      }

      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function withStateLock(statePath, callback) {
  const lockPath = `${statePath}.lock`;
  const fd = acquireStateLock(lockPath);
  try {
    return callback();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function writeStateAtomicUnlocked(statePath, state) {
  const validated = validateState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const permission = setOwnerOnlyPermissions(tempPath);
  fs.renameSync(tempPath, statePath);
  return permission;
}

function writeStateAtomic(statePath, state) {
  return withStateLock(statePath, () => writeStateAtomicUnlocked(statePath, state));
}

function updateStateAtomic(statePath, updater) {
  return withStateLock(statePath, () => {
    const currentState = readState(statePath);
    const nextState = updater(currentState);
    if (nextState === null || nextState === undefined) {
      return {
        updated: false,
        state: currentState,
      };
    }

    const permission = writeStateAtomicUnlocked(statePath, nextState);
    return {
      updated: true,
      permission,
      state: validateState(nextState),
    };
  });
}

function maskStateForLog(state) {
  return maskObject(state);
}

module.exports = {
  createFatalState,
  createFatalStateFromState,
  createRandomToken,
  createRestartedRunningState,
  createRunningState,
  createStartingState,
  maskStateForLog,
  readState,
  setOwnerOnlyPermissions,
  updateStateAtomic,
  validateState,
  writeStateAtomic,
};
