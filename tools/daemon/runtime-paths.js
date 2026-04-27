const path = require('path');

const CONFIG_ENV_KEY = 'BUILDERGATE_CONFIG_PATH';
const ROOT_ENV_KEY = 'BUILDERGATE_ROOT';
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

function resolveConfigPath(root, serverDir, env, isPackaged) {
  if (env[CONFIG_ENV_KEY]) {
    return path.resolve(env[CONFIG_ENV_KEY]);
  }

  if (isPackaged) {
    return path.join(root, 'config.json5');
  }

  return path.join(serverDir, 'config.json5');
}

function resolveNodeBinary(serverDir, platform = process.platform, isPackaged = Boolean(process.pkg)) {
  if (!isPackaged) {
    return process.execPath;
  }

  const executableName = platform === 'win32' ? 'node.exe' : 'node';
  const bundledNode = path.join(serverDir, 'node_modules', '.bin', executableName);
  return bundledNode;
}

function resolveRuntimePaths(options = {}) {
  const env = options.env ?? process.env;
  const isPackaged = options.isPackaged ?? Boolean(process.pkg);
  const root = resolveRoot({ ...options, env, isPackaged });
  const serverDir = path.join(root, 'server');
  const configPath = resolveConfigPath(root, serverDir, env, isPackaged);
  const runtimeDir = path.join(root, 'runtime');
  const logDir = runtimeDir;

  return {
    root,
    frontendDir: path.join(root, 'frontend'),
    frontendDistDir: path.join(root, 'frontend', 'dist'),
    serverDir,
    serverDistDir: path.join(serverDir, 'dist'),
    serverEntry: path.join(serverDir, 'dist', 'index.js'),
    serverPublicDir: path.join(serverDir, 'dist', 'public'),
    configPath,
    runtimeDir,
    statePath: path.join(runtimeDir, STATE_FILE_NAME),
    logDir,
    logPath: path.join(logDir, LOG_FILE_NAME),
    sentinelLogPath: path.join(logDir, SENTINEL_LOG_FILE_NAME),
    sentinelEntry: path.join(root, 'tools', 'daemon', 'sentinel-entry.js'),
    nodeBin: resolveNodeBinary(serverDir, options.platform, isPackaged),
    launcherPath: isPackaged ? (options.execPath ?? process.execPath) : path.join(root, 'tools', 'start-runtime.js'),
    totpSecretPath: path.join(serverDir, 'data', 'totp.secret'),
    isPackaged,
  };
}

module.exports = {
  CONFIG_ENV_KEY,
  LOG_FILE_NAME,
  ROOT_ENV_KEY,
  SENTINEL_LOG_FILE_NAME,
  STATE_FILE_NAME,
  resolveRuntimePaths,
};
