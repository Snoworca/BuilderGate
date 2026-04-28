const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { resolveRuntimePaths } = require('./runtime-paths');

function resolveConfigModulePath(serverDir) {
  return path.join(serverDir, 'dist', 'utils', 'configStrictLoader.js');
}

async function loadStrictConfigFromServerDist(paths, platform = process.platform) {
  const modulePath = paths.configLoaderEntry ?? resolveConfigModulePath(paths.serverDir);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Strict config loader is not built: ${modulePath}`);
  }

  const configModule = paths.isPackaged ? require(modulePath) : await import(pathToFileURL(modulePath).href);
  if (typeof configModule.loadConfigFromPathStrict !== 'function') {
    throw new Error(`Built config loader does not export loadConfigFromPathStrict: ${modulePath}`);
  }

  return configModule.loadConfigFromPathStrict(paths.configPath, platform);
}

async function preflightConfig(options = {}) {
  const paths = options.paths ?? resolveRuntimePaths(options);
  const config = await loadStrictConfigFromServerDist(paths, options.platform ?? process.platform);

  return {
    config,
    paths,
  };
}

module.exports = {
  loadStrictConfigFromServerDist,
  preflightConfig,
  resolveConfigModulePath,
};
