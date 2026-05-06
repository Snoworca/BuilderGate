const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GRACEFUL_STOP_TIMEOUT_MS,
  stopDaemon,
  waitForHealthNonresponse,
} = require('./stop-client');
const { DEFAULT_HEARTBEAT_INTERVAL_MS } = require('./sentinel');
const { createRandomToken, readState, writeStateAtomic } = require('./state-store');

function createFixturePaths(prefix = 'buildergate-stop-client-') {
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
    launcherPath: path.join(root, 'BuilderGate.exe'),
    totpSecretPath: path.join(serverDir, 'data', 'totp.secret'),
    isPackaged: false,
  };
}

function createRunningState(paths, overrides = {}) {
  const now = new Date('2026-04-27T00:00:10.000Z').toISOString();
  return {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: 51001,
    sentinelPid: 51002,
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
    argvHash: 'hash',
    updatedAt: now,
    ...overrides,
  };
}

function createProcessInfoProvider(state, paths) {
  return async (pid) => {
    if (pid === state.appPid) {
      return {
        pid,
        running: true,
        executablePath: state.nodeBinPath,
        commandLine: `"${state.nodeBinPath}" "${state.serverEntryPath}"`,
        cwd: state.serverCwd,
        startTime: '2026-04-27T00:00:09.500Z',
      };
    }
    if (pid === state.sentinelPid) {
      return {
        pid,
        running: true,
        executablePath: state.launcherPath,
        commandLine: `"${state.launcherPath}" --internal-sentinel --internal-sentinel-state "${paths.statePath}" --internal-sentinel-start ${state.startAttemptId}`,
        cwd: path.dirname(state.serverCwd),
        startTime: '2026-04-27T00:00:09.500Z',
      };
    }
    return { pid, running: false };
  };
}

function createShutdownSuccessBody(overrides = {}) {
  return {
    ok: true,
    workspaceFlushed: true,
    workspaceDataPath: 'C:/runtime/workspaces.json',
    workspaceLastUpdated: '2026-04-27T00:00:12.000Z',
    workspaceLastCwdCount: 1,
    workspaceTabCount: 1,
    workspaceFlushMarker: '[Shutdown] Workspace state + CWDs saved',
    ...overrides,
  };
}

test('stopDaemon reports daemon not running when active daemon state is absent', async () => {
  const paths = createFixturePaths('buildergate-stop-absent-');
  const result = await stopDaemon(paths, {
    killProcess: () => {
      throw new Error('not-running stop must not kill any process');
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'not-running');
});

test('stopDaemon default timeout is the Phase 5 fixed 10 second graceful budget', () => {
  assert.equal(GRACEFUL_STOP_TIMEOUT_MS, 10_000);
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 10_000);
});

test('stopDaemon spends one 10 second budget across sentinel, shutdown, and health checks', async () => {
  const paths = createFixturePaths('buildergate-stop-single-budget-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);
  const originalNow = Date.now;
  let nowMs = 1_000_000;
  const timeouts = [];

  Date.now = () => nowMs;
  try {
    const result = await stopDaemon(paths, {
      now: new Date('2026-04-27T00:00:15.000Z'),
      processInfoProvider: createProcessInfoProvider(state, paths),
      processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
      waitForProcessExit: async (_pid, options) => {
        timeouts.push(options.timeoutMs);
        nowMs += 4_000;
        return { exited: true };
      },
      sendShutdownRequest: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        nowMs += 2_500;
        return { ok: true, statusCode: 200, body: createShutdownSuccessBody() };
      },
      waitForHealthNonresponse: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        return { stopped: true };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(timeouts, [10_000, 6_000, 3_500]);
  } finally {
    Date.now = originalNow;
  }
});

test('stopDaemon rejects stale heartbeat without killing recorded PIDs', async () => {
  const paths = createFixturePaths('buildergate-stop-stale-heartbeat-');
  const state = createRunningState(paths, { heartbeatAt: '2026-04-27T00:00:00.000Z' });
  writeStateAtomic(paths.statePath, state);
  const killed = [];

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:20.500Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
    killProcess: (pid) => killed.push(pid),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 2);
  assert.equal(result.status, 'validation-failed');
  assert.match(result.message, /heartbeat/i);
  assert.deepEqual(killed, []);
  assert.equal(nextState.status, 'running');
});

test('stopDaemon marks stopping, waits sentinel first, shuts app down internally, and records stopped', async () => {
  const paths = createFixturePaths('buildergate-stop-success-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);
  const events = [];

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
    waitForProcessExit: async (pid) => {
      events.push(`wait-exit:${pid}:${readState(paths.statePath).status}`);
      assert.equal(pid, state.sentinelPid);
      return { exited: true };
    },
    sendShutdownRequest: async ({ token }) => {
      events.push(`shutdown:${readState(paths.statePath).status}`);
      assert.equal(token, state.shutdownToken);
      return { ok: true, statusCode: 200, body: createShutdownSuccessBody({ flushed: true }) };
    },
    waitForHealthNonresponse: async () => {
      events.push('health-nonresponse');
      return { stopped: true };
    },
    killProcess: () => {
      throw new Error('successful graceful stop must not kill any process');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(events, [
    `wait-exit:${state.sentinelPid}:stopping`,
    'shutdown:stopping',
    'health-nonresponse',
  ]);
  assert.equal(nextState.status, 'stopped');
  assert.equal(nextState.appPid, null);
  assert.equal(nextState.sentinelPid, null);
  assert.equal(nextState.lastExitCode, 0);
  assert.match(result.message, /Workspace state \+ CWDs saved/);
});

test('stopDaemon requires health nonresponse after internal shutdown response', async () => {
  const paths = createFixturePaths('buildergate-stop-health-required-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
    waitForProcessExit: async () => ({ exited: true }),
    sendShutdownRequest: async () => ({ ok: true, statusCode: 200, body: createShutdownSuccessBody() }),
    waitForHealthNonresponse: async () => ({ stopped: false, reason: 'health still responds' }),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'graceful-failure');
  assert.match(result.message, /health still responds/);
  assert.equal(nextState.status, 'stopping');
});

test('stopDaemon marks stopped when app exits before internal shutdown can be requested', async () => {
  const paths = createFixturePaths('buildergate-stop-app-exited-before-shutdown-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: () => false,
    waitForProcessExit: async () => ({ exited: true }),
    sendShutdownRequest: async () => {
      throw new Error('shutdown route must not be called once the app process has already exited');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'stopped');
  assert.match(result.message, /already exited/i);
  assert.equal(nextState.status, 'stopped');
});

test('stopDaemon marks stopping before waiting sentinel when running state has no app process', async () => {
  const paths = createFixturePaths('buildergate-stop-running-state-app-gone-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);
  const events = [];

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processExists: (pid) => pid === state.sentinelPid,
    waitForProcessExit: async (pid) => {
      events.push(`wait-exit:${pid}:${readState(paths.statePath).status}`);
      return { exited: true };
    },
    validateAppProcess: async () => {
      throw new Error('app-gone state must be handled before app validation');
    },
    sendShutdownRequest: async () => {
      throw new Error('shutdown route must not be called for an already exited app');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(events, [`wait-exit:${state.sentinelPid}:stopping`]);
  assert.equal(nextState.status, 'stopped');
});

test('stopDaemon rejects successful HTTP shutdown response without workspace flush evidence', async () => {
  const paths = createFixturePaths('buildergate-stop-missing-flush-evidence-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
    waitForProcessExit: async () => ({ exited: true }),
    sendShutdownRequest: async () => ({ ok: true, statusCode: 200, body: { ok: true } }),
    waitForHealthNonresponse: async () => {
      throw new Error('health check must not run without flush evidence');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'graceful-failure');
  assert.match(result.message, /flush evidence/i);
  assert.equal(nextState.status, 'stopping');
});

test('waitForHealthNonresponse treats non-200 health responses as graceful failure, not stopped', async () => {
  const result = await waitForHealthNonresponse({
    port: 2002,
    timeoutMs: 10,
    intervalMs: 1,
    fetchHealth: async () => ({ ok: false, statusCode: 500, body: { status: 'error' } }),
  });

  assert.equal(result.stopped, false);
  assert.match(result.reason, /HTTP 500/);
});

test('stopDaemon resumes a previous stopping state instead of reporting not-running', async () => {
  const paths = createFixturePaths('buildergate-stop-resume-stopping-');
  const state = createRunningState(paths, { status: 'stopping' });
  writeStateAtomic(paths.statePath, state);

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:35.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
    waitForProcessExit: async (pid) => {
      assert.equal(pid, state.sentinelPid);
      return { exited: true };
    },
    sendShutdownRequest: async () => ({ ok: true, statusCode: 200, body: createShutdownSuccessBody() }),
    waitForHealthNonresponse: async () => ({ stopped: true }),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'stopped');
  assert.equal(nextState.status, 'stopped');
});

test('stopDaemon resumes a previous stopping state after sentinel already exited while app is still alive', async () => {
  const paths = createFixturePaths('buildergate-stop-resume-app-only-');
  const state = createRunningState(paths, { status: 'stopping' });
  writeStateAtomic(paths.statePath, state);
  const events = [];

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:35.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid,
    waitForProcessExit: async () => {
      throw new Error('sentinel already exited; stop resume must not wait for it');
    },
    sendShutdownRequest: async ({ token }) => {
      events.push(`shutdown:${readState(paths.statePath).status}`);
      assert.equal(token, state.shutdownToken);
      return { ok: true, statusCode: 200, body: createShutdownSuccessBody() };
    },
    waitForHealthNonresponse: async () => {
      events.push('health-nonresponse');
      return { stopped: true };
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(events, ['shutdown:stopping', 'health-nonresponse']);
  assert.equal(nextState.status, 'stopped');
  assert.equal(nextState.appPid, null);
  assert.equal(nextState.sentinelPid, null);
});

test('stopDaemon recovers a previous stopping state after app and sentinel already exited', async () => {
  const paths = createFixturePaths('buildergate-stop-resume-already-exited-');
  const state = createRunningState(paths, { status: 'stopping' });
  writeStateAtomic(paths.statePath, state);

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:35.000Z'),
    processExists: () => false,
    validateAppProcess: async () => {
      throw new Error('already-exited stopping state must be recovered before app validation');
    },
    sendShutdownRequest: async () => {
      throw new Error('already-exited stopping state must not call shutdown');
    },
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'stopped');
  assert.match(result.message, /already exited/i);
  assert.equal(nextState.status, 'stopped');
});

for (const statusCode of [401, 403, 404, 500]) {
  test(`stopDaemon reports HTTP ${statusCode} internal shutdown failure without stopped state`, async () => {
    const paths = createFixturePaths(`buildergate-stop-shutdown-${statusCode}-`);
    const state = createRunningState(paths);
    writeStateAtomic(paths.statePath, state);

    const result = await stopDaemon(paths, {
      now: new Date('2026-04-27T00:00:15.000Z'),
      processInfoProvider: createProcessInfoProvider(state, paths),
      processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
      waitForProcessExit: async () => ({ exited: true }),
      sendShutdownRequest: async () => ({
        ok: false,
        statusCode,
        body: { error: { message: `HTTP ${statusCode}` } },
      }),
    });
    const nextState = readState(paths.statePath);

    assert.equal(result.exitCode, 1);
    assert.equal(result.status, 'graceful-failure');
    assert.match(result.message, new RegExp(String(statusCode)));
    assert.equal(nextState.status, 'stopping');
  });
}

test('stopDaemon reports sentinel timeout as graceful failure without kill fallback', async () => {
  const paths = createFixturePaths('buildergate-stop-sentinel-timeout-');
  const state = createRunningState(paths);
  writeStateAtomic(paths.statePath, state);
  const killed = [];

  const result = await stopDaemon(paths, {
    now: new Date('2026-04-27T00:00:15.000Z'),
    processInfoProvider: createProcessInfoProvider(state, paths),
    processExists: (pid) => pid === state.appPid || pid === state.sentinelPid,
    waitForProcessExit: async () => ({ exited: false, reason: 'timeout' }),
    killProcess: (pid) => killed.push(pid),
  });
  const nextState = readState(paths.statePath);

  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'graceful-failure');
  assert.match(result.message, /timeout/i);
  assert.deepEqual(killed, []);
  assert.equal(nextState.status, 'stopping');
});
