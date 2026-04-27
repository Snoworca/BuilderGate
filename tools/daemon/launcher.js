const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { appendLog } = require('./log');
const { isActiveDaemonState, isProcessRunning, killProcess } = require('./process-info');
const { waitForReadiness } = require('./readiness');
const { CONFIG_ENV_KEY, ROOT_ENV_KEY, resolveRuntimePaths } = require('./runtime-paths');
const { runSentinelLoop } = require('./sentinel');
const {
  createFatalStateFromState,
  createRunningState,
  createStartingState,
  readState,
  writeStateAtomic,
} = require('./state-store');

const APP_NAME = 'buildergate';
const INTERNAL_MODE_KEY = 'BUILDERGATE_INTERNAL_MODE';
const DAEMON_START_ID_KEY = 'BUILDERGATE_DAEMON_START_ID';
const DAEMON_STATE_PATH_KEY = 'BUILDERGATE_DAEMON_STATE_PATH';
const DAEMON_STATE_GENERATION_KEY = 'BUILDERGATE_DAEMON_STATE_GENERATION';
const DAEMON_LOG_PATH_KEY = 'BUILDERGATE_DAEMON_LOG_PATH';
const SHUTDOWN_TOKEN_KEY = 'BUILDERGATE_SHUTDOWN_TOKEN';
const TOTP_SECRET_PATH_KEY = 'BUILDERGATE_TOTP_SECRET_PATH';
const SUPPRESS_TOTP_QR_KEY = 'BUILDERGATE_SUPPRESS_TOTP_QR';
const FOREGROUND_FORWARD_SIGNALS = ['SIGINT', 'SIGTERM'];
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

const FOREGROUND_DAEMON_ONLY_ENV_KEYS = [
  SUPPRESS_TOTP_QR_KEY,
  SHUTDOWN_TOKEN_KEY,
  DAEMON_START_ID_KEY,
  DAEMON_STATE_PATH_KEY,
  DAEMON_STATE_GENERATION_KEY,
  DAEMON_LOG_PATH_KEY,
  INTERNAL_MODE_KEY,
];

function getPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function withLocalBinPath(env, localBinDirs = []) {
  const pathKey = getPathKey(env);
  const existingPath = env[pathKey] ?? '';
  const localPath = localBinDirs.filter((binDir) => fs.existsSync(binDir)).join(path.delimiter);
  if (!localPath) {
    return env;
  }

  return {
    ...env,
    [pathKey]: existingPath ? `${localPath}${path.delimiter}${existingPath}` : localPath,
  };
}

function applyBootstrapAllowedIps(env, bootstrapAllowedIps) {
  if (bootstrapAllowedIps.length > 0) {
    env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS = bootstrapAllowedIps.join(',');
  } else {
    delete env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS;
  }

  return env;
}

function createRuntimeEnv(
  port,
  bootstrapAllowedIps = [],
  baseEnv = process.env,
  paths = resolveRuntimePaths(),
  localBinDirs = [],
) {
  const env = withLocalBinPath({
    ...baseEnv,
    NODE_ENV: 'production',
    PORT: String(port),
    [CONFIG_ENV_KEY]: paths.configPath,
    [TOTP_SECRET_PATH_KEY]: paths.totpSecretPath,
  }, localBinDirs);

  for (const key of FOREGROUND_DAEMON_ONLY_ENV_KEYS) {
    delete env[key];
  }

  return applyBootstrapAllowedIps(env, bootstrapAllowedIps);
}

function createDaemonRuntimeEnv(
  port,
  bootstrapAllowedIps = [],
  state,
  baseEnv = process.env,
  paths = resolveRuntimePaths(),
  localBinDirs = [],
) {
  const env = withLocalBinPath({
    ...baseEnv,
    NODE_ENV: 'production',
    PORT: String(port),
    [CONFIG_ENV_KEY]: paths.configPath,
    [TOTP_SECRET_PATH_KEY]: paths.totpSecretPath,
    [SUPPRESS_TOTP_QR_KEY]: '1',
    [INTERNAL_MODE_KEY]: 'app',
    [SHUTDOWN_TOKEN_KEY]: state.shutdownToken,
    [DAEMON_START_ID_KEY]: state.startAttemptId,
    [DAEMON_STATE_PATH_KEY]: paths.statePath,
    [DAEMON_STATE_GENERATION_KEY]: String(state.stateGeneration),
    [DAEMON_LOG_PATH_KEY]: paths.logPath,
  }, localBinDirs);

  return applyBootstrapAllowedIps(env, bootstrapAllowedIps);
}

function createSentinelRuntimeEnv(state, baseEnv = process.env, paths = resolveRuntimePaths(), localBinDirs = []) {
  const sentinelLogPath = paths.sentinelLogPath ?? paths.logPath;
  return withLocalBinPath({
    ...baseEnv,
    NODE_ENV: 'production',
    [CONFIG_ENV_KEY]: paths.configPath,
    [ROOT_ENV_KEY]: paths.root,
    BUILDERGATE_RUNTIME_ROOT: paths.root,
    [INTERNAL_MODE_KEY]: 'sentinel',
    [DAEMON_START_ID_KEY]: state.startAttemptId,
    [DAEMON_STATE_PATH_KEY]: paths.statePath,
    [DAEMON_STATE_GENERATION_KEY]: String(state.stateGeneration),
    [DAEMON_LOG_PATH_KEY]: sentinelLogPath,
  }, localBinDirs);
}

function resolveAppNodeCommand(paths = resolveRuntimePaths()) {
  if (fs.existsSync(paths.nodeBin)) {
    return paths.nodeBin;
  }

  if (paths.isPackaged ?? Boolean(process.pkg)) {
    throw new Error(`Bundled Node runtime missing: ${paths.nodeBin}`);
  }

  return process.execPath;
}

function resolveSentinelCommand(paths = resolveRuntimePaths()) {
  if (paths.isPackaged ?? Boolean(process.pkg)) {
    return {
      command: resolveAppNodeCommand(paths),
      args: [paths.sentinelEntry],
    };
  }

  return {
    command: resolveAppNodeCommand(paths),
    args: [paths.launcherPath, '--internal-sentinel'],
  };
}

function createForegroundLaunchOptions(
  port,
  bootstrapAllowedIps = [],
  paths = resolveRuntimePaths(),
  options = {},
) {
  return {
    command: resolveAppNodeCommand(paths),
    args: [paths.serverEntry],
    options: {
      cwd: paths.serverDir,
      env: createRuntimeEnv(
        port,
        bootstrapAllowedIps,
        options.baseEnv ?? process.env,
        paths,
        options.localBinDirs ?? [],
      ),
      stdio: 'inherit',
      shell: false,
    },
  };
}

function exitCodeForSignal(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

function createLaunchContract({ port, bootstrapAllowedIps = [], paths = resolveRuntimePaths() }) {
  const serverEntryPath = path.resolve(paths.serverEntry ?? paths.serverEntryPath);
  const configPath = path.resolve(paths.configPath);
  const argvHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      mode: 'daemon',
      port,
      bootstrapAllowedIps: [...bootstrapAllowedIps].sort(),
      serverEntryPath,
      configPath,
    }))
    .digest('hex');

  return {
    port,
    serverEntryPath,
    configPath,
    argvHash,
  };
}

function stateMatchesContract(state, contract) {
  return (
    state.port === contract.port
    && path.resolve(state.serverEntryPath) === contract.serverEntryPath
    && path.resolve(state.configPath) === contract.configPath
    && state.argvHash === contract.argvHash
  );
}

function createDaemonAppLaunchOptions(port, bootstrapAllowedIps, state, paths, options = {}) {
  return {
    role: 'app',
    command: resolveAppNodeCommand(paths),
    args: [paths.serverEntry],
    logPath: paths.logPath,
    options: {
      cwd: paths.serverDir,
      env: createDaemonRuntimeEnv(
        port,
        bootstrapAllowedIps,
        state,
        options.baseEnv ?? process.env,
        paths,
        options.localBinDirs ?? [],
      ),
      detached: true,
      shell: false,
    },
  };
}

function createSentinelLaunchOptions(state, paths, options = {}) {
  const sentinelCommand = resolveSentinelCommand(paths);
  const sentinelLogPath = paths.sentinelLogPath ?? paths.logPath;
  const sentinelArgs = sentinelCommand.args.length > 0
    ? [
      ...sentinelCommand.args,
      '--internal-sentinel-state',
      paths.statePath,
      '--internal-sentinel-start',
      state.startAttemptId,
    ]
    : [];

  return {
    role: 'sentinel',
    command: sentinelCommand.command,
    args: sentinelArgs,
    logPath: sentinelLogPath,
    options: {
      cwd: paths.root,
      env: createSentinelRuntimeEnv(
        state,
        options.baseEnv ?? process.env,
        paths,
        options.localBinDirs ?? [],
      ),
      detached: true,
      shell: false,
    },
  };
}

function spawnDetachedProcess(launch) {
  fs.mkdirSync(path.dirname(launch.logPath), { recursive: true });
  const stdoutFd = fs.openSync(launch.logPath, 'a');
  const stderrFd = fs.openSync(launch.logPath, 'a');

  try {
    const child = spawn(launch.command, launch.args, {
      ...launch.options,
      stdio: ['ignore', stdoutFd, stderrFd],
    });

    if (!child.pid) {
      throw new Error(`Failed to spawn ${launch.role} child: PID was not assigned`);
    }

    child.unref();
    return { pid: child.pid, child };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

function cleanupAttempt(pids, killProcessFn = killProcess) {
  for (const pid of pids.filter(Boolean)) {
    killProcessFn(pid);
  }
}

function markFatalStage(error, fatalStage) {
  const nextError = error instanceof Error ? error : new Error(String(error));
  if (!nextError.fatalStage) {
    nextError.fatalStage = fatalStage;
  }
  return nextError;
}

async function runPreSpawnHook(hook, fatalStage, args) {
  if (typeof hook !== 'function') {
    return;
  }

  try {
    await hook(args);
  } catch (error) {
    throw markFatalStage(error, fatalStage);
  }
}

function readExistingState(paths) {
  try {
    return readState(paths.statePath);
  } catch (error) {
    appendLog(paths.logPath, `[daemon] ignoring unreadable state: ${error.message}`);
    return null;
  }
}

async function isExistingDaemonActive(state, options = {}) {
  const inspection = await inspectExistingDaemonState(state, options);
  return inspection.status === 'active';
}

async function inspectExistingDaemonState(state, options = {}) {
  if (!state || state.mode !== 'daemon' || state.status !== 'running') {
    return { status: 'absent', state, reason: 'no running daemon state' };
  }

  const processExists = options.processExists ?? isProcessRunning;
  if (!isActiveDaemonState(state, processExists)) {
    return { status: 'stale', state, reason: 'recorded daemon pids are not running' };
  }

  const waitForReadinessFn = options.waitForReadiness ?? waitForReadiness;
  try {
    const readiness = await waitForReadinessFn({
      port: state.port,
      state,
      timeoutMs: options.timeoutMs ?? 1000,
      intervalMs: options.intervalMs ?? 100,
    });
    if (readiness.ok === true) {
      return { status: 'active', state, reason: null };
    }

    const reason = readiness.reason ?? 'readiness failed';
    if (/identity/i.test(reason)) {
      return { status: 'stale', state, reason };
    }

    return { status: 'unknown', state, reason };
  } catch {
    return { status: 'unknown', state, reason: 'readiness probe failed' };
  }
}

async function inspectExistingDaemon(paths, options = {}) {
  const state = readExistingState(paths);
  const inspection = await inspectExistingDaemonState(state, options);
  return {
    ...inspection,
    active: inspection.status === 'active',
  };
}

async function startDaemon(port, source, bootstrapAllowedIps = [], paths = resolveRuntimePaths(), options = {}) {
  const contract = createLaunchContract({ port, bootstrapAllowedIps, paths });
  const processExists = options.processExists ?? isProcessRunning;
  const spawnDetached = options.spawnDetached ?? spawnDetachedProcess;
  const waitForReadinessFn = options.waitForReadiness ?? waitForReadiness;
  const killProcessFn = options.killProcess ?? killProcess;
  const existing = await inspectExistingDaemon(paths, {
    processExists,
    waitForReadiness: options.waitForExistingReadiness ?? waitForReadinessFn,
    timeoutMs: options.existingReadinessTimeoutMs ?? 1000,
    intervalMs: options.existingReadinessIntervalMs ?? 100,
  });
  const previousState = existing.state;

  if (existing.status === 'unknown') {
    console.error('[start] Existing BuilderGate daemon state could not be verified.');
    console.error(`[start] ${existing.reason}`);
    console.error('[start] Refusing to overwrite daemon state while recorded PIDs are still running.');
    return 3;
  }

  if (existing.active) {
    if (options.requiresFreshStart) {
      console.error('[start] BuilderGate daemon is already running.');
      console.error(`[start] ${options.freshStartReason ?? 'Requested operation requires a new daemon process.'}`);
      console.error('[start] Stop the active daemon before retrying.');
      return 2;
    }

    if (stateMatchesContract(previousState, contract)) {
      console.log(`[start] BuilderGate daemon is already running on port ${previousState.port}.`);
      console.log(`[start] App PID: ${previousState.appPid}`);
      console.log(`[start] Sentinel PID: ${previousState.sentinelPid}`);
      return 0;
    }

    console.error('[start] A different BuilderGate daemon is already running.');
    console.error('[start] Stop the active daemon before starting with different options.');
    console.error(`[start] Active HTTPS: https://localhost:${previousState.port}`);
    return 2;
  }

  if (previousState?.status === 'running') {
    appendLog(paths.logPath, '[daemon] stale active state detected; starting a new daemon without killing old PIDs');
  }

  const startingState = createStartingState({
    appName: APP_NAME,
    paths,
    port,
    argvHash: contract.argvHash,
    previousState,
    bootstrapAllowedIps,
  });
  writeStateAtomic(paths.statePath, startingState);

  let appPid = null;
  let sentinelPid = null;
  try {
    await runPreSpawnHook(options.beforeSpawn, options.beforeSpawnFatalStage ?? 'app-startup', {
      paths,
      state: startingState,
      port,
      source,
      bootstrapAllowedIps,
    });
    await runPreSpawnHook(options.daemonPreflight, 'totp-preflight', {
      paths,
      state: startingState,
      port,
      source,
      bootstrapAllowedIps,
    });

    const appLaunch = createDaemonAppLaunchOptions(port, bootstrapAllowedIps, startingState, paths, options);
    appPid = spawnDetached(appLaunch).pid;

    const sentinelLaunch = createSentinelLaunchOptions(startingState, paths, options);
    sentinelPid = spawnDetached(sentinelLaunch).pid;

    const runningState = createRunningState(startingState, { appPid, sentinelPid });
    writeStateAtomic(paths.statePath, runningState);
    appendLog(paths.logPath, `[daemon] spawned appPid=${appPid} sentinelPid=${sentinelPid} port=${port} source=${source}`);

    const readiness = await waitForReadinessFn({
      port,
      state: runningState,
      timeoutMs: options.readinessTimeoutMs ?? 30000,
      intervalMs: options.readinessIntervalMs ?? 500,
    });

    if (!readiness.ok) {
      cleanupAttempt([sentinelPid, appPid], killProcessFn);
      const fatalState = createFatalStateFromState(runningState, {
        stage: 'app-startup',
        message: readiness.reason ?? 'readiness failed',
      });
      writeStateAtomic(paths.statePath, fatalState);
      appendLog(paths.logPath, `[daemon] readiness failed: ${fatalState.fatalReason}`);
      return 1;
    }

    console.log(`[start] BuilderGate daemon is running on https://localhost:${port} (${source}).`);
    console.log(`[start] App PID: ${appPid}`);
    console.log(`[start] Sentinel PID: ${sentinelPid}`);
    console.log(`[start] Config: ${paths.configPath}`);
    return 0;
  } catch (error) {
    cleanupAttempt([sentinelPid, appPid], killProcessFn);
    const fatalStage = error?.fatalStage ?? 'app-startup';
    const fatalState = createFatalStateFromState(startingState, {
      stage: fatalStage,
      message: error instanceof Error ? error.message : String(error),
    });
    writeStateAtomic(paths.statePath, fatalState);
    appendLog(paths.logPath, `[daemon] startup failed: ${fatalState.fatalReason}`);
    return 1;
  }
}

function startForeground(port, source, bootstrapAllowedIps = [], paths = resolveRuntimePaths(), options = {}) {
  const launch = createForegroundLaunchOptions(port, bootstrapAllowedIps, paths, options);
  console.log(`[start] Starting BuilderGate in foreground on port ${port} (${source})...`);
  console.log(`[start] Config: ${paths.configPath}`);
  console.log(`[start] HTTPS: https://localhost:${port}`);

  const spawnProcess = options.spawnProcess ?? spawn;
  const processObject = options.processObject ?? process;
  const platform = options.platform ?? process.platform;
  const signalForwardTimeoutMs = options.signalForwardTimeoutMs ?? 10000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let forwardedSignal = null;
    let forceKillTimer = null;
    const signalListeners = [];

    function cleanup() {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }

      if (typeof processObject.removeListener === 'function') {
        for (const [signal, listener] of signalListeners) {
          processObject.removeListener(signal, listener);
        }
      }
    }

    function settle(handler, value) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      handler(value);
    }

    let child;
    try {
      child = spawnProcess(launch.command, launch.args, launch.options);
    } catch (error) {
      settle(reject, error);
      return;
    }

    function forwardSignal(signal) {
      forwardedSignal = signal;
      const consoleShouldDeliverCtrlC = platform === 'win32' && signal === 'SIGINT';
      if (!consoleShouldDeliverCtrlC && typeof child.kill === 'function') {
        try {
          child.kill(signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[start] Failed to forward ${signal} to foreground app: ${message}`);
        }
      }

      if (signalForwardTimeoutMs > 0 && !forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          console.error(`[start] Foreground app did not exit after ${signal}; forcing termination.`);
          if (typeof child.kill === 'function') {
            try {
              child.kill('SIGKILL');
            } catch {
              // The child may have exited between timeout scheduling and force kill.
            }
          }
        }, signalForwardTimeoutMs);
        if (typeof forceKillTimer.unref === 'function') {
          forceKillTimer.unref();
        }
      }
    }

    if (typeof processObject.once === 'function') {
      for (const signal of FOREGROUND_FORWARD_SIGNALS) {
        const listener = () => forwardSignal(signal);
        signalListeners.push([signal, listener]);
        processObject.once(signal, listener);
      }
    }

    child.once('error', (error) => {
      settle(reject, error);
    });

    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`[start] Foreground app exited by signal ${signal}`);
        settle(resolve, exitCodeForSignal(signal));
        return;
      }

      if (forwardedSignal && code === null) {
        settle(resolve, exitCodeForSignal(forwardedSignal));
        return;
      }

      settle(resolve, code ?? 0);
    });
  });
}

module.exports = {
  APP_NAME,
  DAEMON_LOG_PATH_KEY,
  DAEMON_START_ID_KEY,
  DAEMON_STATE_GENERATION_KEY,
  DAEMON_STATE_PATH_KEY,
  FOREGROUND_DAEMON_ONLY_ENV_KEYS,
  INTERNAL_MODE_KEY,
  SHUTDOWN_TOKEN_KEY,
  SUPPRESS_TOTP_QR_KEY,
  TOTP_SECRET_PATH_KEY,
  cleanupAttempt,
  createDaemonAppLaunchOptions,
  createDaemonRuntimeEnv,
  createForegroundLaunchOptions,
  createLaunchContract,
  createRuntimeEnv,
  createSentinelLaunchOptions,
  createSentinelRuntimeEnv,
  exitCodeForSignal,
  getPathKey,
  inspectExistingDaemon,
  inspectExistingDaemonState,
  isExistingDaemonActive,
  resolveAppNodeCommand,
  resolveSentinelCommand,
  runSentinelLoop,
  spawnDetachedProcess,
  startDaemon,
  startForeground,
  stateMatchesContract,
  withLocalBinPath,
};
