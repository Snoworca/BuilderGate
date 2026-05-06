const path = require('path');

const CONFIG_ENV_KEY = 'BUILDERGATE_CONFIG_PATH';
const ROOT_ENV_KEY = 'BUILDERGATE_ROOT';
const SERVER_ROOT_ENV_KEY = 'BUILDERGATE_SERVER_ROOT';
const SHELL_INTEGRATION_ROOT_ENV_KEY = 'BUILDERGATE_SHELL_INTEGRATION_ROOT';
const WEB_ROOT_ENV_KEY = 'BUILDERGATE_WEB_ROOT';
const STATE_FILE_NAME = 'buildergate.daemon.json';
const LOG_FILE_NAME = 'buildergate-daemon.log';
const SENTINEL_LOG_FILE_NAME = 'buildergate-sentinel.log';

function resolveRoot(options) {
  const env = options.env ?? process.env;
  if (env[ROOT_ENV_KEY]) {
    return path.resolve(env[ROOT_ENV_KEY]);
  }

  if (options.isPackaged ?? Boolean(process.pkg)) {
    return path.dirname(options.execPath ?? process.execPath);
  }

  return path.resolve(options.sourceRoot ?? path.join(__dirname, '..', '..'));
}

function resolvePackagedCodeRoot() {
  return path.resolve(__dirname, '..', '..');
}

function isPortableRuntime(env, isPackaged) {
  return !isPackaged && Boolean(env[ROOT_ENV_KEY]);
}

function resolveConfigPath(root, serverDir, env, isPackaged, isPortable) {
  if (env[CONFIG_ENV_KEY]) {
    return path.resolve(env[CONFIG_ENV_KEY]);
  }

  if (isPackaged || isPortable) {
    return path.join(root, 'config.json5');
  }

  return path.join(serverDir, 'config.json5');
}

function resolveNodeBinary(serverDir, platform = process.platform, isPackaged = Boolean(process.pkg), execPath = process.execPath) {
  if (!isPackaged) {
    return execPath;
  }

  return execPath;
}

function resolveRuntimePaths(options = {}) {
  const env = options.env ?? process.env;
  const isPackaged = options.isPackaged ?? Boolean(process.pkg);
  const isPortable = isPortableRuntime(env, isPackaged);
  const root = resolveRoot({ ...options, env, isPackaged });
  const codeRoot = isPackaged ? resolvePackagedCodeRoot() : root;
  const serverDir = path.join(codeRoot, 'server');
  const serverCwd = isPackaged ? root : serverDir;
  const serverDistDir = path.join(serverDir, 'dist');
  const serverDistPkgDir = path.join(serverDir, 'dist-pkg');
  const serverEntry = isPackaged
    ? path.join(serverDistPkgDir, 'index.cjs')
    : path.join(serverDistDir, 'index.js');
  const configLoaderEntry = isPackaged
    ? path.join(serverDistPkgDir, 'configStrictLoader.cjs')
    : path.join(serverDistDir, 'utils', 'configStrictLoader.js');
  const daemonTotpPreflightEntry = isPackaged
    ? path.join(serverDistPkgDir, 'daemonTotpPreflight.cjs')
    : path.join(serverDistDir, 'services', 'daemonTotpPreflight.js');
  const webDir = env[WEB_ROOT_ENV_KEY]
    ? path.resolve(env[WEB_ROOT_ENV_KEY])
    : isPackaged || isPortable
      ? path.join(root, 'web')
      : path.join(serverDistDir, 'public');
  const shellIntegrationDir = env[SHELL_INTEGRATION_ROOT_ENV_KEY]
    ? path.resolve(env[SHELL_INTEGRATION_ROOT_ENV_KEY])
    : isPackaged || isPortable
      ? path.join(root, 'shell-integration')
      : path.join(serverDistDir, 'shell-integration');
  const configPath = resolveConfigPath(root, serverDir, env, isPackaged, isPortable);
  const runtimeDir = path.join(root, 'runtime');
  const logDir = runtimeDir;

  return {
    root,
    codeRoot,
    frontendDir: path.join(root, 'frontend'),
    frontendDistDir: path.join(root, 'frontend', 'dist'),
    serverDir,
    serverCwd,
    serverDistDir,
    serverDistPkgDir,
    serverEntry,
    configLoaderEntry,
    daemonTotpPreflightEntry,
    shellIntegrationDir,
    serverPublicDir: webDir,
    webDir,
    webIndexPath: path.join(webDir, 'index.html'),
    configPath,
    runtimeDir,
    statePath: path.join(runtimeDir, STATE_FILE_NAME),
    logDir,
    logPath: path.join(logDir, LOG_FILE_NAME),
    sentinelLogPath: path.join(logDir, SENTINEL_LOG_FILE_NAME),
    sentinelEntry: path.join(root, 'tools', 'daemon', 'sentinel-entry.js'),
    nodeBin: resolveNodeBinary(serverDir, options.platform, isPackaged, options.execPath ?? process.execPath),
    launcherPath: isPackaged ? (options.execPath ?? process.execPath) : path.join(root, 'tools', 'start-runtime.js'),
    totpSecretPath: isPackaged || isPortable
      ? path.join(runtimeDir, 'totp.secret')
      : path.join(serverDir, 'data', 'totp.secret'),
    isPackaged,
  };
}

module.exports = {
  CONFIG_ENV_KEY,
  LOG_FILE_NAME,
  ROOT_ENV_KEY,
  SERVER_ROOT_ENV_KEY,
  SENTINEL_LOG_FILE_NAME,
  SHELL_INTEGRATION_ROOT_ENV_KEY,
  STATE_FILE_NAME,
  WEB_ROOT_ENV_KEY,
  resolveRuntimePaths,
};
