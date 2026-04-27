const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createDaemonRuntimeEnv,
  createDaemonAppLaunchOptions,
  createLaunchContract,
  createForegroundLaunchOptions,
  createRuntimeEnv,
  createSentinelLaunchOptions,
  startDaemon,
  startForeground,
} = require('./launcher');
const { createRandomToken, readState, writeStateAtomic } = require('./state-store');

function createFixturePaths(prefix = 'buildergate-foreground-launcher-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const serverDir = path.join(root, 'server');
  const serverDistDir = path.join(serverDir, 'dist');
  fs.mkdirSync(serverDistDir, { recursive: true });

  return {
    root,
    serverDir,
    serverEntry: path.join(serverDistDir, 'index.js'),
    nodeBin: process.execPath,
    configPath: path.join(root, 'config.json5'),
    runtimeDir: path.join(root, 'runtime'),
    statePath: path.join(root, 'runtime', 'buildergate.daemon.json'),
    logPath: path.join(root, 'runtime', 'buildergate-daemon.log'),
    sentinelLogPath: path.join(root, 'runtime', 'buildergate-sentinel.log'),
    launcherPath: path.join(root, 'BuilderGate.exe'),
    totpSecretPath: path.join(serverDir, 'data', 'totp.secret'),
    isPackaged: false,
  };
}

test('createRuntimeEnv passes foreground-safe app env without daemon-only identity values', () => {
  const paths = createFixturePaths();
  const env = createRuntimeEnv(2002, ['127.0.0.1'], {
    PATH: process.env.PATH ?? '',
    BUILDERGATE_SUPPRESS_TOTP_QR: '1',
    BUILDERGATE_SHUTDOWN_TOKEN: 'leaked-token',
    BUILDERGATE_DAEMON_START_ID: 'leaked-start-id',
    BUILDERGATE_DAEMON_STATE_PATH: paths.statePath,
    BUILDERGATE_INTERNAL_MODE: 'app',
  }, paths);

  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.PORT, '2002');
  assert.equal(env.BUILDERGATE_CONFIG_PATH, paths.configPath);
  assert.equal(env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS, '127.0.0.1');
  assert.equal(env.BUILDERGATE_TOTP_SECRET_PATH, paths.totpSecretPath);
  assert.equal(env.BUILDERGATE_SUPPRESS_TOTP_QR, undefined);
  assert.equal(env.BUILDERGATE_SHUTDOWN_TOKEN, undefined);
  assert.equal(env.BUILDERGATE_DAEMON_START_ID, undefined);
  assert.equal(env.BUILDERGATE_DAEMON_STATE_PATH, undefined);
  assert.equal(env.BUILDERGATE_INTERNAL_MODE, undefined);
});

test('createForegroundLaunchOptions inherits stdio and never creates active daemon state', () => {
  const paths = createFixturePaths();
  const launch = createForegroundLaunchOptions(2002, ['127.0.0.1'], paths);

  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [paths.serverEntry]);
  assert.equal(launch.options.cwd, paths.serverDir);
  assert.equal(launch.options.stdio, 'inherit');
  assert.equal(launch.options.shell, false);
  assert.equal(fs.existsSync(paths.statePath), false);
});

test('createForegroundLaunchOptions uses bundled Node in packaged runtime when present', () => {
  const paths = createFixturePaths('buildergate-foreground-packaged-node-present-');
  paths.isPackaged = true;
  paths.nodeBin = path.join(paths.serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.mkdirSync(path.dirname(paths.nodeBin), { recursive: true });
  fs.copyFileSync(process.execPath, paths.nodeBin);

  const launch = createForegroundLaunchOptions(2002, [], paths);

  assert.equal(launch.command, paths.nodeBin);
});

test('startForeground propagates app child exit code and leaves daemon state absent', async () => {
  const paths = createFixturePaths('buildergate-foreground-exit-code-');
  fs.writeFileSync(paths.serverEntry, 'process.exit(7);\n', 'utf8');

  const exitCode = await startForeground(2002, 'test', [], paths);

  assert.equal(exitCode, 7);
  assert.equal(fs.existsSync(paths.statePath), false);
});

test('startForeground forwards SIGTERM to app child and waits for graceful exit', async () => {
  const paths = createFixturePaths('buildergate-foreground-sigterm-forward-');
  const fakeProcess = new EventEmitter();
  const fakeChild = new EventEmitter();
  let forwardedSignal = null;

  fakeChild.kill = (signal) => {
    forwardedSignal = signal;
    process.nextTick(() => fakeChild.emit('exit', 0, null));
    return true;
  };

  const exitPromise = startForeground(2002, 'test', [], paths, {
    processObject: fakeProcess,
    signalForwardTimeoutMs: 100,
    spawnProcess: () => fakeChild,
  });

  assert.equal(fakeProcess.listenerCount('SIGTERM'), 1);
  fakeProcess.emit('SIGTERM');

  const exitCode = await exitPromise;
  assert.equal(forwardedSignal, 'SIGTERM');
  assert.equal(exitCode, 0);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
  assert.equal(fs.existsSync(paths.statePath), false);
});

test('createDaemonRuntimeEnv passes daemon identity and shutdown contract to app child', () => {
  const paths = createFixturePaths('buildergate-daemon-env-');
  const state = {
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 3,
  };

  const env = createDaemonRuntimeEnv(2002, ['127.0.0.1'], state, { PATH: process.env.PATH ?? '' }, paths);

  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.PORT, '2002');
  assert.equal(env.BUILDERGATE_CONFIG_PATH, paths.configPath);
  assert.equal(env.BUILDERGATE_TOTP_SECRET_PATH, paths.totpSecretPath);
  assert.equal(env.BUILDERGATE_SUPPRESS_TOTP_QR, '1');
  assert.equal(env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS, '127.0.0.1');
  assert.equal(env.BUILDERGATE_INTERNAL_MODE, 'app');
  assert.equal(env.BUILDERGATE_SHUTDOWN_TOKEN, state.shutdownToken);
  assert.equal(env.BUILDERGATE_DAEMON_START_ID, state.startAttemptId);
  assert.equal(env.BUILDERGATE_DAEMON_STATE_PATH, paths.statePath);
  assert.equal(env.BUILDERGATE_DAEMON_STATE_GENERATION, '3');
});

test('createDaemonAppLaunchOptions uses bundled Node for packaged daemon app child', () => {
  const paths = createFixturePaths('buildergate-daemon-packaged-app-node-');
  paths.isPackaged = true;
  paths.nodeBin = path.join(paths.serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.mkdirSync(path.dirname(paths.nodeBin), { recursive: true });
  fs.copyFileSync(process.execPath, paths.nodeBin);
  const state = {
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
  };

  const launch = createDaemonAppLaunchOptions(2002, [], state, paths);

  assert.equal(launch.command, paths.nodeBin);
  assert.deepEqual(launch.args, [paths.serverEntry]);
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.cwd, paths.serverDir);
});

test('createSentinelLaunchOptions uses bundled Node and physical sentinel entry in packaged runtime', () => {
  const paths = createFixturePaths('buildergate-daemon-packaged-sentinel-');
  paths.isPackaged = true;
  paths.sentinelEntry = path.join(paths.root, 'tools', 'daemon', 'sentinel-entry.js');
  const state = {
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
  };

  const launch = createSentinelLaunchOptions(state, paths);

  assert.equal(launch.command, paths.nodeBin);
  assert.deepEqual(launch.args, [
    paths.sentinelEntry,
    '--internal-sentinel-state',
    paths.statePath,
    '--internal-sentinel-start',
    state.startAttemptId,
  ]);
  assert.equal(launch.options.detached, true);
  assert.equal(launch.logPath, paths.sentinelLogPath);
  assert.equal(launch.options.env.BUILDERGATE_INTERNAL_MODE, 'sentinel');
  assert.equal(launch.options.env.BUILDERGATE_DAEMON_STATE_PATH, paths.statePath);
  assert.equal(launch.options.env.BUILDERGATE_DAEMON_LOG_PATH, paths.sentinelLogPath);
});

test('startDaemon spawns detached app and sentinel, writes running state, and waits for identity readiness', async () => {
  const paths = createFixturePaths('buildergate-daemon-start-');
  const spawns = [];

  const exitCode = await startDaemon(2002, 'cli', ['127.0.0.1'], paths, {
    spawnDetached: (launch) => {
      spawns.push(launch);
      return { pid: spawns.length === 1 ? 32001 : 32002 };
    },
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => false,
  });

  assert.equal(exitCode, 0);
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[0].args, [paths.serverEntry]);
  assert.equal(spawns[0].options.cwd, paths.serverDir);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.env.BUILDERGATE_INTERNAL_MODE, 'app');
  assert.equal(spawns[0].options.env.BUILDERGATE_SUPPRESS_TOTP_QR, '1');
  assert.equal(spawns[0].options.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS, '127.0.0.1');
  assert.equal(spawns[1].args.includes('--internal-sentinel'), true);
  assert.equal(spawns[1].options.detached, true);
  assert.equal(spawns[1].options.env.BUILDERGATE_INTERNAL_MODE, 'sentinel');

  const state = readState(paths.statePath);
  assert.equal(state.status, 'running');
  assert.equal(state.appPid, 32001);
  assert.equal(state.sentinelPid, 32002);
  assert.equal(state.port, 2002);
  assert.equal(state.configPath, paths.configPath);
  assert.equal(Buffer.from(state.shutdownToken, 'base64url').length, 32);
});

test('startDaemon runs TOTP daemon preflight before spawning app and sentinel children', async () => {
  const paths = createFixturePaths('buildergate-daemon-preflight-order-');
  const events = [];
  const spawnPids = [32101, 32102];

  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    daemonPreflight: async ({ paths: receivedPaths, state }) => {
      assert.equal(receivedPaths, paths);
      assert.equal(state.status, 'starting');
      events.push('preflight');
    },
    spawnDetached: (launch) => {
      events.push(launch.role);
      return { pid: spawnPids.shift() };
    },
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => false,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['preflight', 'app', 'sentinel']);
});

test('startDaemon records TOTP preflight failure without spawning or killing children', async () => {
  const paths = createFixturePaths('buildergate-daemon-preflight-failure-');
  const killed = [];
  const spawns = [];

  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    daemonPreflight: async () => {
      throw new Error('TOTP preflight failed');
    },
    spawnDetached: (launch) => {
      spawns.push(launch);
      return { pid: 32201 };
    },
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => false,
    killProcess: (pid) => killed.push(pid),
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 1);
  assert.deepEqual(spawns, []);
  assert.deepEqual(killed, []);
  assert.equal(state.status, 'fatal');
  assert.equal(state.fatalStage, 'totp-preflight');
  assert.match(state.fatalReason, /TOTP preflight failed/);
  assert.equal(state.appPid, null);
  assert.equal(state.sentinelPid, null);
});

test('startDaemon treats identical active state as idempotent without replacing child processes', async () => {
  const paths = createFixturePaths('buildergate-daemon-idempotent-');
  const spawnPids = [33001, 33002];
  await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => ({ pid: spawnPids.shift() }),
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => false,
  });
  const originalState = readState(paths.statePath);

  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => {
      throw new Error('idempotent start must not spawn new children');
    },
    waitForReadiness: async ({ state }) => ({ ok: state.appPid === originalState.appPid }),
    processExists: () => true,
  });
  const nextState = readState(paths.statePath);

  assert.equal(exitCode, 0);
  assert.equal(nextState.appPid, originalState.appPid);
  assert.equal(nextState.sentinelPid, originalState.sentinelPid);
  assert.equal(nextState.startAttemptId, originalState.startAttemptId);
});

test('startDaemon rejects reset-password style fresh-start requests while an active daemon exists', async () => {
  const paths = createFixturePaths('buildergate-daemon-active-reset-');
  const spawnPids = [33101, 33102];
  await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => ({ pid: spawnPids.shift() }),
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => false,
  });

  let beforeSpawnCalled = false;
  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    beforeSpawn: () => {
      beforeSpawnCalled = true;
    },
    requiresFreshStart: true,
    freshStartReason: '--reset-password requires a new daemon process',
    spawnDetached: () => {
      throw new Error('active daemon reset must not spawn new children');
    },
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => true,
  });

  assert.equal(exitCode, 2);
  assert.equal(beforeSpawnCalled, false);
});

test('startDaemon treats reused running PIDs as stale when health identity does not match', async () => {
  const paths = createFixturePaths('buildergate-daemon-pid-reuse-same-contract-');
  const runningContract = createLaunchContract({ port: 2002, bootstrapAllowedIps: [], paths });
  const now = new Date().toISOString();
  writeStateAtomic(paths.statePath, {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 37001,
    sentinelPid: 37002,
    port: 2002,
    launcherPath: paths.launcherPath,
    serverEntryPath: paths.serverEntry,
    serverCwd: paths.serverDir,
    nodeBinPath: paths.nodeBin,
    configPath: paths.configPath,
    totpSecretPath: paths.totpSecretPath,
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: runningContract.argvHash,
    updatedAt: now,
  });

  const spawnPids = [37011, 37012];
  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => ({ pid: spawnPids.shift() }),
    waitForReadiness: async ({ state }) => (
      state.appPid === 37011
        ? { ok: true, identity: state }
        : { ok: false, reason: 'identity mismatch' }
    ),
    processExists: () => true,
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 0);
  assert.equal(state.appPid, 37011);
  assert.equal(state.sentinelPid, 37012);
  assert.equal(state.stateGeneration, 2);
});

test('startDaemon does not report conflict for reused PIDs with mismatched health identity', async () => {
  const paths = createFixturePaths('buildergate-daemon-pid-reuse-different-contract-');
  const runningContract = createLaunchContract({ port: 2002, bootstrapAllowedIps: [], paths });
  const now = new Date().toISOString();
  writeStateAtomic(paths.statePath, {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 37101,
    sentinelPid: 37102,
    port: 2002,
    launcherPath: paths.launcherPath,
    serverEntryPath: paths.serverEntry,
    serverCwd: paths.serverDir,
    nodeBinPath: paths.nodeBin,
    configPath: paths.configPath,
    totpSecretPath: paths.totpSecretPath,
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: runningContract.argvHash,
    updatedAt: now,
  });

  const spawnPids = [37111, 37112];
  const exitCode = await startDaemon(2456, 'cli', [], paths, {
    spawnDetached: () => ({ pid: spawnPids.shift() }),
    waitForReadiness: async ({ state }) => (
      state.appPid === 37111
        ? { ok: true, identity: state }
        : { ok: false, reason: 'identity mismatch' }
    ),
    processExists: () => true,
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 0);
  assert.equal(state.port, 2456);
  assert.equal(state.appPid, 37111);
  assert.equal(state.sentinelPid, 37112);
});

test('startDaemon refuses to overwrite unknown running state when identity probe times out', async () => {
  const paths = createFixturePaths('buildergate-daemon-unknown-active-');
  const runningContract = createLaunchContract({ port: 2002, bootstrapAllowedIps: [], paths });
  const now = new Date().toISOString();
  const existingState = {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 37201,
    sentinelPid: 37202,
    port: 2002,
    launcherPath: paths.launcherPath,
    serverEntryPath: paths.serverEntry,
    serverCwd: paths.serverDir,
    nodeBinPath: paths.nodeBin,
    configPath: paths.configPath,
    totpSecretPath: paths.totpSecretPath,
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: runningContract.argvHash,
    updatedAt: now,
  };
  writeStateAtomic(paths.statePath, existingState);

  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => {
      throw new Error('unknown active daemon state must not be overwritten');
    },
    waitForReadiness: async () => ({ ok: false, reason: 'readiness timeout' }),
    processExists: () => true,
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 3);
  assert.equal(state.appPid, existingState.appPid);
  assert.equal(state.startAttemptId, existingState.startAttemptId);
});

test('startDaemon rejects different active daemon contract without auto-replacing it', async () => {
  const paths = createFixturePaths('buildergate-daemon-conflict-');
  const runningContract = createLaunchContract({ port: 2002, bootstrapAllowedIps: [], paths });
  const now = new Date().toISOString();
  writeStateAtomic(paths.statePath, {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 34001,
    sentinelPid: 34002,
    port: 2002,
    launcherPath: paths.launcherPath,
    serverEntryPath: paths.serverEntry,
    serverCwd: paths.serverDir,
    nodeBinPath: paths.nodeBin,
    configPath: paths.configPath,
    totpSecretPath: paths.totpSecretPath,
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: runningContract.argvHash,
    updatedAt: now,
  });

  const exitCode = await startDaemon(2456, 'cli', [], paths, {
    spawnDetached: () => {
      throw new Error('conflicting active daemon must not be replaced');
    },
    waitForReadiness: async ({ state }) => ({ ok: state.appPid === 34001 }),
    processExists: () => true,
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 2);
  assert.equal(state.appPid, 34001);
  assert.equal(state.sentinelPid, 34002);
  assert.equal(state.port, 2002);
});

test('startDaemon ignores stale state without killing unrelated old PIDs', async () => {
  const paths = createFixturePaths('buildergate-daemon-stale-');
  const runningContract = createLaunchContract({ port: 2002, bootstrapAllowedIps: [], paths });
  const now = new Date().toISOString();
  writeStateAtomic(paths.statePath, {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 35001,
    sentinelPid: 35002,
    port: 2002,
    launcherPath: paths.launcherPath,
    serverEntryPath: paths.serverEntry,
    serverCwd: paths.serverDir,
    nodeBinPath: paths.nodeBin,
    configPath: paths.configPath,
    totpSecretPath: paths.totpSecretPath,
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: runningContract.argvHash,
    updatedAt: now,
  });

  const killed = [];
  const spawnPids = [35011, 35012];
  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => ({ pid: spawnPids.shift() }),
    waitForReadiness: async ({ state }) => ({ ok: true, identity: state }),
    processExists: () => false,
    killProcess: (pid) => killed.push(pid),
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 0);
  assert.deepEqual(killed, []);
  assert.equal(state.appPid, 35011);
  assert.equal(state.sentinelPid, 35012);
  assert.equal(state.stateGeneration, 2);
});

test('startDaemon readiness timeout cleans up only the children from the failed attempt', async () => {
  const paths = createFixturePaths('buildergate-daemon-readiness-timeout-');
  const killed = [];
  const spawnPids = [36001, 36002];

  const exitCode = await startDaemon(2002, 'cli', [], paths, {
    spawnDetached: () => ({ pid: spawnPids.shift() }),
    waitForReadiness: async () => ({ ok: false, reason: 'identity mismatch' }),
    processExists: () => false,
    killProcess: (pid) => killed.push(pid),
  });
  const state = readState(paths.statePath);

  assert.equal(exitCode, 1);
  assert.deepEqual(killed, [36002, 36001]);
  assert.equal(state.status, 'fatal');
  assert.equal(state.fatalStage, 'app-startup');
  assert.match(state.fatalReason, /identity mismatch/);
});
