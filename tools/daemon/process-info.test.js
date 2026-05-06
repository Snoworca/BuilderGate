const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  parseWindowsCreationDate,
  queryProcessInfo,
  validateDaemonAppProcess,
  validateDaemonSentinelProcess,
} = require('./process-info');

function createState(overrides = {}) {
  const root = path.join('C:', 'buildergate');
  const serverDir = path.join(root, 'server');
  const now = new Date('2026-04-27T00:00:10.000Z').toISOString();
  return {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 41001,
    sentinelPid: 41002,
    port: 2002,
    launcherPath: path.join(root, 'BuilderGate.exe'),
    serverEntryPath: path.join(serverDir, 'dist', 'index.js'),
    serverCwd: serverDir,
    nodeBinPath: path.join(serverDir, 'node_modules', '.bin', 'node.exe'),
    configPath: path.join(root, 'config.json5'),
    totpSecretPath: path.join(serverDir, 'data', 'totp.secret'),
    shutdownToken: 'a'.repeat(43),
    startAttemptId: 'attempt-1',
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: 'hash',
    updatedAt: now,
    ...overrides,
  };
}

test('validateDaemonAppProcess accepts matching process identity with fresh heartbeat', async () => {
  const state = createState();
  const result = await validateDaemonAppProcess(state, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: async () => ({
      pid: state.appPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${state.serverEntryPath}"`,
      cwd: state.serverCwd,
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(result.valid, true);
});

test('validateDaemonAppProcess accepts packaged internal app marker without server entry argument', async () => {
  const state = createState({
    nodeBinPath: path.join('C:', 'buildergate', 'BuilderGate.exe'),
    serverCwd: path.join('C:', 'buildergate'),
  });
  const result = await validateDaemonAppProcess(state, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: async () => ({
      pid: state.appPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" --internal-app`,
      cwd: path.dirname(state.nodeBinPath),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(result.valid, true);
});

test('validateDaemonAppProcess accepts packaged self executable without internal argv marker', async () => {
  const launcherPath = path.join('C:', 'buildergate', 'BuilderGate.exe');
  const state = createState({
    launcherPath,
    nodeBinPath: launcherPath,
    serverCwd: path.dirname(launcherPath),
  });
  const result = await validateDaemonAppProcess(state, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: async () => ({
      pid: state.appPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}"`,
      cwd: path.dirname(state.nodeBinPath),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(result.valid, true);
});

test('validateDaemonAppProcess rejects stale heartbeat without treating it as killable fallback', async () => {
  const state = createState({ heartbeatAt: '2026-04-27T00:00:00.000Z' });
  const result = await validateDaemonAppProcess(state, {
    now: new Date('2026-04-27T00:00:20.500Z'),
    maxHeartbeatAgeMs: 10_000,
    processInfoProvider: async () => ({
      pid: state.appPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${state.serverEntryPath}"`,
      cwd: state.serverCwd,
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /heartbeat/i);
});

test('validateDaemonAppProcess rejects PID reuse when process start time is newer than state identity', async () => {
  const state = createState();
  const result = await validateDaemonAppProcess(state, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: async () => ({
      pid: state.appPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${state.serverEntryPath}"`,
      cwd: state.serverCwd,
      startTime: '2026-04-27T00:00:30.000Z',
    }),
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /start time|PID reuse/i);
});

test('validateDaemonAppProcess falls back to command, cwd, and fresh heartbeat when start time is unavailable', async () => {
  const state = createState();
  const result = await validateDaemonAppProcess(state, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: async () => ({
      pid: state.appPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${state.serverEntryPath}"`,
      cwd: state.serverCwd,
      startTime: null,
    }),
  });

  assert.equal(result.valid, true);
});

test('validateDaemonSentinelProcess requires the internal sentinel marker', async () => {
  const state = createState();
  const valid = await validateDaemonSentinelProcess(state, {
    processInfoProvider: async () => ({
      pid: state.sentinelPid,
      running: true,
      executablePath: state.launcherPath,
      commandLine: `"${state.launcherPath}" --internal-sentinel --internal-sentinel-start ${state.startAttemptId}`,
      cwd: path.dirname(state.serverCwd),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });
  const invalid = await validateDaemonSentinelProcess(state, {
    processInfoProvider: async () => ({
      pid: state.sentinelPid,
      running: true,
      executablePath: state.launcherPath,
      commandLine: `"${state.launcherPath}"`,
      cwd: path.dirname(state.serverCwd),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(valid.valid, true);
  assert.equal(invalid.valid, false);
  assert.match(invalid.reason, /sentinel marker/i);
});

test('validateDaemonSentinelProcess accepts packaged sentinel entry marker', async () => {
  const state = createState();
  const statePath = path.join(path.dirname(state.serverCwd), 'runtime', 'buildergate.daemon.json');
  const sentinelEntryPath = path.join(path.dirname(state.serverCwd), 'tools', 'daemon', 'sentinel-entry.js');

  const result = await validateDaemonSentinelProcess(state, {
    expectedStatePath: statePath,
    processInfoProvider: async () => ({
      pid: state.sentinelPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${sentinelEntryPath}" --internal-sentinel-state "${statePath}" --internal-sentinel-start ${state.startAttemptId}`,
      cwd: path.dirname(state.serverCwd),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(result.valid, true);
});

test('validateDaemonSentinelProcess accepts packaged self executable without argv markers', async () => {
  const launcherPath = path.join('C:', 'buildergate', 'BuilderGate.exe');
  const state = createState({
    launcherPath,
    nodeBinPath: launcherPath,
    serverCwd: path.dirname(launcherPath),
  });
  const result = await validateDaemonSentinelProcess(state, {
    expectedStatePath: path.join(path.dirname(state.serverCwd), 'runtime', 'buildergate.daemon.json'),
    processInfoProvider: async () => ({
      pid: state.sentinelPid,
      running: true,
      executablePath: state.launcherPath,
      commandLine: `"${state.launcherPath}"`,
      cwd: state.serverCwd,
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(result.valid, true);
});

test('parseWindowsCreationDate handles JSON date and DMTF timezone formats', () => {
  assert.equal(parseWindowsCreationDate('/Date(1777248009500)/'), '2026-04-27T00:00:09.500Z');
  assert.equal(parseWindowsCreationDate('20260427090009.500000+540'), '2026-04-27T00:00:09.500Z');
});

test('queryProcessInfo hides the Windows PowerShell process probe', () => {
  const pid = process.pid;
  let observedCall = null;
  const result = queryProcessInfo(pid, {
    platform: 'win32',
    spawnSyncFn: (command, args, options) => {
      observedCall = { command, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          ProcessId: pid,
          ExecutablePath: path.join('C:', 'buildergate', 'node.exe'),
          CommandLine: '"node.exe" "server/dist/index.js"',
          CreationDate: '20260427090009.500000+540',
        }),
      };
    },
  });

  assert.equal(observedCall.command, 'powershell.exe');
  assert.deepEqual(observedCall.args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.equal(observedCall.options.windowsHide, true);
  assert.deepEqual(observedCall.options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(result.running, true);
  assert.equal(result.startTime, '2026-04-27T00:00:09.500Z');
});

test('queryProcessInfo treats a missing Windows process probe result as not running', () => {
  const pid = process.pid;
  const result = queryProcessInfo(pid, {
    platform: 'win32',
    spawnSyncFn: () => ({
      status: 2,
      stdout: '',
    }),
  });

  assert.deepEqual(result, { pid, running: false });
});

test('validateDaemonSentinelProcess requires state path and start attempt markers when expected', async () => {
  const state = createState();
  const statePath = path.join(path.dirname(state.serverCwd), 'runtime', 'buildergate.daemon.json');
  const valid = await validateDaemonSentinelProcess(state, {
    expectedStatePath: statePath,
    processInfoProvider: async () => ({
      pid: state.sentinelPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${state.launcherPath}" --internal-sentinel --internal-sentinel-state "${statePath}" --internal-sentinel-start ${state.startAttemptId}`,
      cwd: path.dirname(state.serverCwd),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });
  const missingStatePath = await validateDaemonSentinelProcess(state, {
    expectedStatePath: statePath,
    processInfoProvider: async () => ({
      pid: state.sentinelPid,
      running: true,
      executablePath: state.nodeBinPath,
      commandLine: `"${state.nodeBinPath}" "${state.launcherPath}" --internal-sentinel --internal-sentinel-start ${state.startAttemptId}`,
      cwd: path.dirname(state.serverCwd),
      startTime: '2026-04-27T00:00:09.500Z',
    }),
  });

  assert.equal(valid.valid, true);
  assert.equal(missingStatePath.valid, false);
  assert.match(missingStatePath.reason, /state path marker/i);
});
