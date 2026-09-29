const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_ENV_KEY = 'BUILDERGATE_CONFIG_PATH';
const ROOT_ENV_KEY = 'BUILDERGATE_ROOT';
const SERVER_ROOT_ENV_KEY = 'BUILDERGATE_SERVER_ROOT';
const SHELL_INTEGRATION_ROOT_ENV_KEY = 'BUILDERGATE_SHELL_INTEGRATION_ROOT';
const WEB_ROOT_ENV_KEY = 'BUILDERGATE_WEB_ROOT';
const STATE_FILE_NAME = 'buildergate.daemon.json';
const LOG_FILE_NAME = 'buildergate-daemon.log';
const SENTINEL_LOG_FILE_NAME = 'buildergate-sentinel.log';
// OPS-BGSTAB-020: the MSI installs this file beside BuilderGate.exe. The portable zip does not
// carry it, so only an installed executable moves its user data to LocalAppData.
const INSTALL_MARKER_FILE_NAME = 'buildergate-install.json';
const INSTALLED_DATA_DIR_NAME = 'BuilderGate';

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

// The marker is looked up beside the executable, not under BUILDERGATE_ROOT: the launcher hands
// its children BUILDERGATE_ROOT, and parent and children must agree on where the data lives.
function isInstalledRuntime(options, env, isPackaged) {
  const platform = options.platform ?? process.platform;
  if (!isPackaged || platform !== 'win32') {
    return false;
  }

  const fileExists = options.fileExists ?? fs.existsSync;
  const execPath = options.execPath ?? process.execPath;
  return fileExists(path.join(path.dirname(execPath), INSTALL_MARKER_FILE_NAME));
}

function resolveInstalledDataRoot(env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, INSTALLED_DATA_DIR_NAME);
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
  const isInstalled = isInstalledRuntime(options, env, isPackaged);
  // Where config, data/, certs/ and runtime/ live. The install directory when portable.
  const dataRoot = isInstalled ? resolveInstalledDataRoot(env) : root;
  const codeRoot = isPackaged ? resolvePackagedCodeRoot() : root;
  const serverDir = path.join(codeRoot, 'server');
  const serverCwd = isPackaged ? dataRoot : serverDir;
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
  const configPath = resolveConfigPath(dataRoot, serverDir, env, isPackaged, isPortable);
  const runtimeDir = path.join(dataRoot, 'runtime');
  const logDir = runtimeDir;

  return {
    root,
    dataRoot,
    isInstalled,
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
  INSTALL_MARKER_FILE_NAME,
  LOG_FILE_NAME,
  ROOT_ENV_KEY,
  SERVER_ROOT_ENV_KEY,
  SENTINEL_LOG_FILE_NAME,
  SHELL_INTEGRATION_ROOT_ENV_KEY,
  STATE_FILE_NAME,
  WEB_ROOT_ENV_KEY,
  resolveRuntimePaths,
};
