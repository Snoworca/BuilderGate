const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  INITIAL_RESTART_BACKOFF_MS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  runSentinelTick,
} = require('./sentinel');
const {
  createRunningState,
  createStartingState,
  readState,
  writeStateAtomic,
} = require('./state-store');

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-sentinel-'));
  const paths = {
    root,
    launcherPath: path.join(root, 'tools', 'start-runtime.js'),
    serverEntry: path.join(root, 'server', 'dist', 'index.js'),
    serverDir: path.join(root, 'server'),
    nodeBin: process.execPath,
    configPath: path.join(root, 'server', 'config.json5'),
    statePath: path.join(root, 'runtime', 'buildergate.daemon.json'),
    logPath: path.join(root, 'runtime', 'buildergate-daemon.log'),
    sentinelLogPath: path.join(root, 'runtime', 'buildergate-sentinel.log'),
    totpSecretPath: path.join(root, 'server', 'data', 'totp.secret'),
  };
  const starting = createStartingState({
    paths,
    port: 2002,
    argvHash: 'sentinel-test',
  });
  const running = createRunningState(starting, {
    appPid: options.appPid ?? process.pid,
    sentinelPid: options.sentinelPid ?? process.pid,
  });
  const state = {
    ...running,
    ...options.statePatch,
  };
  writeStateAtomic(paths.statePath, state);

  return { paths, running: state };
}

test('sentinel defaults to a 10 second heartbeat interval', () => {
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 10_000);
});

test('runSentinelTick refreshes heartbeat while daemon state is running', async () => {
  const { paths, running } = createFixture();

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.logPath,
    validateAppProcess: async () => ({ valid: true }),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'continue');
  assert.equal(nextState.status, 'running');
  assert.notEqual(nextState.updatedAt, running.updatedAt);
});

test('runSentinelTick exits when stop utility marks daemon state as stopping', async () => {
  const { paths, running } = createFixture();
  writeStateAtomic(paths.statePath, {
    ...running,
    status: 'stopping',
    updatedAt: new Date().toISOString(),
  });

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.logPath,
  });

  assert.equal(result, 'exit');
  assert.match(fs.readFileSync(paths.logPath, 'utf8'), /stopping marker observed/);
});

test('runSentinelTick does not overwrite a concurrent stopping state with heartbeat', async () => {
  const { paths, running } = createFixture();

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.logPath,
    validateAppProcess: async () => ({ valid: true }),
    beforeHeartbeatWrite: () => {
      writeStateAtomic(paths.statePath, {
        ...running,
        status: 'stopping',
        updatedAt: new Date().toISOString(),
      });
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'exit');
  assert.equal(nextState.status, 'stopping');
});

test('runSentinelTick restarts an abnormally exited app with backoff and restart state fields', async () => {
  const fixedNow = new Date('2026-04-27T00:00:00.000Z');
  const { paths, running } = createFixture({ appPid: 41001, sentinelPid: 41002 });
  const slept = [];
  const spawns = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 9 }),
    sleep: async (ms) => {
      slept.push(ms);
    },
    backoffPollIntervalMs: INITIAL_RESTART_BACKOFF_MS,
    now: () => fixedNow,
    restartPreflight: async ({ state }) => {
      assert.equal(state.appPid, running.appPid);
    },
    spawnApp: async ({ state, paths: spawnPaths }) => {
      spawns.push({ state, paths: spawnPaths });
      return { pid: 42001 };
    },
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'restart');
  assert.equal(slept.includes(INITIAL_RESTART_BACKOFF_MS), true);
  assert.equal(spawns.length, 1);
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.appPid, 42001);
  assert.equal(nextState.sentinelPid, running.sentinelPid);
  assert.equal(nextState.restartCount, 1);
  assert.equal(nextState.stateGeneration, running.stateGeneration + 1);
  assert.equal(nextState.lastRestartAt, fixedNow.toISOString());
  assert.equal(nextState.lastExitCode, 9);
  assert.equal(nextState.heartbeatAt, fixedNow.toISOString());
  assert.equal(spawns[0].paths.logPath, paths.logPath);
});

test('runSentinelTick treats app PID identity mismatch as exited instead of refreshing heartbeat', async () => {
  const fixedNow = new Date('2026-04-27T00:01:00.000Z');
  const { paths, running } = createFixture({ appPid: 42501, sentinelPid: 42502 });

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    processInfoProvider: async () => ({
      pid: running.appPid,
      running: true,
      executablePath: running.nodeBinPath,
      commandLine: '"unrelated.exe"',
      cwd: running.serverCwd,
      startTime: running.appProcessStartedAt,
    }),
    now: () => fixedNow,
    sleep: async () => {},
    restartPreflight: async () => {},
    spawnApp: async () => ({ pid: 42503 }),
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'restart');
  assert.equal(nextState.appPid, 42503);
  assert.equal(nextState.restartCount, 1);
  assert.match(fs.readFileSync(paths.sentinelLogPath, 'utf8'), /app command line does not include server entry/);
});

test('runSentinelTick does not restart after max restart count within the policy window', async () => {
  const now = new Date('2026-04-27T00:10:00.000Z');
  const windowStart = new Date(now.getTime() - RESTART_WINDOW_MS + 1000).toISOString();
  const { paths, running } = createFixture({
    appPid: 43001,
    sentinelPid: 43002,
    statePatch: {
      restartCount: MAX_RESTARTS_PER_WINDOW,
      lastRestartAt: windowStart,
      restartWindowStartedAt: windowStart,
    },
  });
  const spawns = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    now: () => now,
    appExitProvider: async () => ({ exited: true, lastExitCode: 'SIGABRT' }),
    sleep: async () => {
      throw new Error('restart limit must not sleep before fatal state');
    },
    spawnApp: async () => {
      spawns.push('spawned');
      return { pid: 43003 };
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'fatal');
  assert.deepEqual(spawns, []);
  assert.equal(nextState.status, 'fatal');
  assert.equal(nextState.fatalStage, 'sentinel-runtime');
  assert.match(nextState.fatalReason, /restart limit/i);
  assert.equal(nextState.lastExitCode, 'SIGABRT');
});

test('runSentinelTick exits without restart when state becomes stopping during restart backoff', async () => {
  const { paths, running } = createFixture({ appPid: 44001, sentinelPid: 44002 });
  const spawns = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    sleep: async () => {
      writeStateAtomic(paths.statePath, {
        ...readState(paths.statePath),
        status: 'stopping',
        updatedAt: new Date().toISOString(),
      });
    },
    spawnApp: async () => {
      spawns.push('spawned');
      return { pid: 44003 };
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'exit');
  assert.deepEqual(spawns, []);
  assert.equal(nextState.status, 'stopping');
});

test('runSentinelTick polls stopping state during long restart backoff instead of waiting full backoff', async () => {
  const now = new Date('2026-04-27T00:20:00.000Z');
  const { paths, running } = createFixture({
    appPid: 44101,
    sentinelPid: 44102,
    statePatch: {
      restartCount: 4,
      lastRestartAt: now.toISOString(),
      restartWindowStartedAt: now.toISOString(),
    },
  });
  const slept = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    now: () => now,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    backoffPollIntervalMs: 100,
    sleep: async (ms) => {
      slept.push(ms);
      writeStateAtomic(paths.statePath, {
        ...readState(paths.statePath),
        status: 'stopping',
        updatedAt: new Date().toISOString(),
      });
    },
    spawnApp: async () => {
      throw new Error('long backoff stop must exit before spawning');
    },
  });

  assert.equal(result, 'exit');
  assert.deepEqual(slept, [100]);
});

test('runSentinelTick records fatal state without restart when restart preflight fails', async () => {
  const { paths, running } = createFixture({ appPid: 45001, sentinelPid: 45002 });
  const fatalError = new Error('invalid config schema');
  fatalError.fatalStage = 'preflight';
  const spawns = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    sleep: async () => {},
    restartPreflight: async () => {
      throw fatalError;
    },
    spawnApp: async () => {
      spawns.push('spawned');
      return { pid: 45003 };
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'fatal');
  assert.deepEqual(spawns, []);
  assert.equal(nextState.status, 'fatal');
  assert.equal(nextState.fatalStage, 'preflight');
  assert.match(nextState.fatalReason, /invalid config schema/);
  assert.equal(nextState.lastExitCode, 1);
});

test('runSentinelTick records fatal when sentinel restart would silently recreate a missing TOTP secret', async () => {
  const { paths, running } = createFixture({ appPid: 45501, sentinelPid: 45502 });
  const utilsDir = path.join(paths.serverDir, 'dist', 'utils');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(
    path.join(utilsDir, 'configStrictLoader.js'),
    `exports.loadConfigFromPathStrict = async () => ({
  server: { port: 2002 },
  twoFactor: {
    enabled: true,
    externalOnly: false,
    issuer: 'MissingSecret',
    accountName: 'admin',
  },
});\n`,
    'utf8',
  );
  assert.equal(fs.existsSync(paths.totpSecretPath), false);
  const spawns = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    sleep: async () => {},
    spawnApp: async () => {
      spawns.push('spawned');
      return { pid: 45503 };
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'fatal');
  assert.deepEqual(spawns, []);
  assert.equal(nextState.status, 'fatal');
  assert.equal(nextState.fatalStage, 'totp-preflight');
  assert.match(nextState.fatalReason, /missing TOTP secret/i);
});

test('runSentinelTick records fatal state and kills restart child when readiness fails', async () => {
  const { paths, running } = createFixture({ appPid: 46001, sentinelPid: 46002 });
  const killed = [];

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    sleep: async () => {},
    restartPreflight: async () => {},
    spawnApp: async () => ({ pid: 46003 }),
    waitForReadiness: async () => ({ ok: false, reason: 'readiness identity mismatch' }),
    killProcess: (pid) => {
      killed.push(pid);
      return true;
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'fatal');
  assert.deepEqual(killed, [46003]);
  assert.equal(nextState.status, 'fatal');
  assert.equal(nextState.fatalStage, 'app-startup');
  assert.match(nextState.fatalReason, /readiness identity mismatch/);
});

test('runSentinelTick exits when stop begins during restart readiness wait', async () => {
  const { paths, running } = createFixture({ appPid: 47001, sentinelPid: 47002 });
  let sleepCount = 0;

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    backoffPollIntervalMs: INITIAL_RESTART_BACKOFF_MS,
    readinessStatePollIntervalMs: 100,
    sleep: async () => {
      sleepCount += 1;
      if (sleepCount === 2) {
        writeStateAtomic(paths.statePath, {
          ...readState(paths.statePath),
          status: 'stopping',
          updatedAt: new Date().toISOString(),
        });
      }
    },
    restartPreflight: async () => {},
    spawnApp: async () => ({ pid: 47003 }),
    waitForReadiness: async () => new Promise(() => {}),
    killProcess: () => {
      throw new Error('sentinel must not kill the app when stop-client is taking over');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'exit');
  assert.equal(nextState.status, 'stopping');
  assert.equal(nextState.appPid, 47003);
});

test('runSentinelTick exits when stop begins immediately after restart readiness succeeds', async () => {
  const { paths, running } = createFixture({ appPid: 48001, sentinelPid: 48002 });

  const result = await runSentinelTick({
    statePath: paths.statePath,
    startAttemptId: running.startAttemptId,
    logPath: paths.sentinelLogPath,
    appExitProvider: async () => ({ exited: true, lastExitCode: 1 }),
    sleep: async () => {},
    restartPreflight: async () => {},
    spawnApp: async () => ({ pid: 48003 }),
    waitForReadiness: async ({ state }) => {
      writeStateAtomic(paths.statePath, {
        ...readState(paths.statePath),
        status: 'stopping',
        updatedAt: new Date().toISOString(),
      });
      return { ok: true, identity: state };
    },
    killProcess: () => {
      throw new Error('sentinel must not kill the app when stop-client is taking over');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result, 'exit');
  assert.equal(nextState.status, 'stopping');
  assert.equal(nextState.appPid, 48003);
});
