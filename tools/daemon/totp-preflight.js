const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { resolveRuntimePaths } = require('./runtime-paths');

function resolveDaemonTotpPreflightModulePath(serverDir) {
  return path.join(serverDir, 'dist', 'services', 'daemonTotpPreflight.js');
}

async function loadDaemonTotpPreflightModule(paths) {
  const modulePath = paths.daemonTotpPreflightEntry ?? resolveDaemonTotpPreflightModulePath(paths.serverDir);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`TOTP daemon preflight helper is not built: ${modulePath}`);
  }

  const module = paths.isPackaged ? require(modulePath) : await import(pathToFileURL(modulePath).href);
  if (typeof module.runDaemonTotpPreflight !== 'function') {
    throw new Error(`Built TOTP daemon preflight helper does not export runDaemonTotpPreflight: ${modulePath}`);
  }

  return module;
}

async function runDaemonTotpPreflight(options = {}) {
  const paths = options.paths ?? resolveRuntimePaths(options);
  const config = options.config;

  if (config && config.twoFactor?.enabled !== true) {
    return {
      enabled: false,
      secretFilePath: paths.totpSecretPath,
    };
  }

  const module = await loadDaemonTotpPreflightModule(paths);
  return module.runDaemonTotpPreflight({
    configPath: paths.configPath,
    secretFilePath: paths.totpSecretPath,
    platform: options.platform ?? process.platform,
    config,
    suppressConsoleQr: options.suppressConsoleQr,
  });
}

module.exports = {
  loadDaemonTotpPreflightModule,
  resolveDaemonTotpPreflightModulePath,
  runDaemonTotpPreflight,
};
