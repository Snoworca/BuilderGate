const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createFatalState,
  createRandomToken,
  createRestartedRunningState,
  maskStateForLog,
  readState,
  setOwnerOnlyPermissions,
  validateState,
  writeStateAtomic,
} = require('./state-store');

function createPathFixture(root = 'C:/app') {
  return {
    launcherPath: path.join(root, 'BuilderGate.exe'),
    serverEntry: path.join(root, 'server', 'dist', 'index.js'),
    serverDir: path.join(root, 'server'),
    nodeBin: path.join(root, 'server', 'node_modules', '.bin', 'node.exe'),
    configPath: path.join(root, 'config.json5'),
    totpSecretPath: path.join(root, 'server', 'data', 'totp.secret'),
    logPath: path.join(root, 'runtime', 'logs', 'buildergate-daemon.log'),
  };
}

test('validateState accepts preflight fatal state before port and pid are known', () => {
  const state = createFatalState({
    appName: 'buildergate',
    stage: 'preflight',
    message: 'invalid config',
    paths: createPathFixture(),
  });

  assert.equal(state.status, 'fatal');
  assert.equal(state.port, null);
  assert.equal(state.version, '1');
  assert.equal(state.appPid, null);
  assert.equal(state.fatalReason, 'invalid config');
  assert.equal(state.serverEntryPath, path.join('C:/app', 'server', 'dist', 'index.js'));
  assert.equal(typeof state.shutdownToken, 'string');
  assert.equal(Buffer.from(state.shutdownToken, 'base64url').length, 32);
  assert.equal(typeof state.startAttemptId, 'string');
  assert.equal(state.stateGeneration, 1);
  assert.equal(validateState(state), state);
});

test('readState reports corrupt state without side effects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-state-corrupt-'));
  const statePath = path.join(dir, 'buildergate.daemon.json');
  fs.writeFileSync(statePath, '{not valid json', 'utf8');

  assert.throws(() => readState(statePath), /Failed to parse daemon state/);
});

test('writeStateAtomic writes readable state and masks shutdown token for logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-state-'));
  const statePath = path.join(dir, 'buildergate.daemon.json');
  const state = validateState({
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: process.pid,
    sentinelPid: process.pid,
    port: 2002,
    launcherPath: path.join(dir, 'BuilderGate.exe'),
    serverEntryPath: path.join(dir, 'server', 'dist', 'index.js'),
    serverCwd: path.join(dir, 'server'),
    nodeBinPath: path.join(dir, 'server', 'node_modules', '.bin', 'node.exe'),
    configPath: path.join(dir, 'config.json5'),
    totpSecretPath: path.join(dir, 'server', 'data', 'totp.secret'),
    logPath: path.join(dir, 'runtime', 'logs', 'buildergate.log'),
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 2,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    argvHash: 'argv-hash',
    updatedAt: new Date().toISOString(),
  });

  const permission = writeStateAtomic(statePath, state);
  const read = readState(statePath);

  assert.equal(Buffer.from(read.shutdownToken, 'base64url').length, 32);
  assert.equal(permission.applied || permission.skipped, true);
});

test('createRestartedRunningState increments generation and records restart fields', () => {
  const now = new Date('2026-04-27T00:00:00.000Z');
  const state = validateState({
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 51001,
    sentinelPid: 51002,
    port: 2002,
    launcherPath: path.join('C:/app', 'BuilderGate.exe'),
    serverEntryPath: path.join('C:/app', 'server', 'dist', 'index.js'),
    serverCwd: path.join('C:/app', 'server'),
    nodeBinPath: process.execPath,
    configPath: path.join('C:/app', 'config.json5'),
    totpSecretPath: path.join('C:/app', 'server', 'data', 'totp.secret'),
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 2,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    startedAt: now.toISOString(),
    argvHash: 'argv-hash',
    updatedAt: now.toISOString(),
  });

  const restarted = createRestartedRunningState(state, {
    appPid: 51003,
    restartCount: 1,
    restartWindowStartedAt: now.toISOString(),
    lastExitCode: 'SIGTERM',
    now,
  });

  assert.equal(restarted.appPid, 51003);
  assert.equal(restarted.stateGeneration, 3);
  assert.equal(restarted.restartCount, 1);
  assert.equal(restarted.restartWindowStartedAt, now.toISOString());
  assert.equal(restarted.lastRestartAt, now.toISOString());
  assert.equal(restarted.lastExitCode, 'SIGTERM');
  assert.equal(restarted.heartbeatAt, now.toISOString());
});

test('validateState rejects low-entropy shutdown tokens', () => {
  const state = createFatalState({
    stage: 'preflight',
    message: 'invalid config',
    paths: createPathFixture(),
  });

  assert.throws(
    () => validateState({ ...state, shutdownToken: 'not-random-enough' }),
    /at least 32 random bytes/,
  );
});

test('maskStateForLog redacts shutdown token without changing identity fields', () => {
  const state = createFatalState({
    stage: 'preflight',
    message: 'invalid config',
    paths: createPathFixture(),
  });

  const masked = maskStateForLog(state);

  assert.equal(masked.shutdownToken, '[REDACTED]');
  assert.equal(masked.startAttemptId, state.startAttemptId);
  assert.equal(masked.configPath, state.configPath);
});

test('setOwnerOnlyPermissions applies owner-only mode or returns an explicit skip reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-state-permission-'));
  const filePath = path.join(dir, 'state.json');
  fs.writeFileSync(filePath, '{}', 'utf8');

  const result = setOwnerOnlyPermissions(filePath, process.platform);

  if (process.platform === 'win32') {
    assert.equal(result.skipped, true);
    assert.match(result.reason, /Windows ACL/);
  } else {
    assert.equal(result.applied, true);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});
