const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { preflightConfig } = require('./config-preflight');

function createFixturePaths(prefix = 'buildergate-config-preflight-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(path.join(serverDir, 'dist-pkg'), { recursive: true });

  return {
    root,
    serverDir,
    configPath: path.join(root, 'config.json5'),
  };
}

test('preflightConfig requires packaged CJS config loader when packaged path is supplied', async () => {
  const paths = createFixturePaths('buildergate-config-preflight-packaged-');
  paths.isPackaged = true;
  paths.configLoaderEntry = path.join(paths.serverDir, 'dist-pkg', 'configStrictLoader.cjs');
  fs.writeFileSync(paths.configPath, '{ server: { port: 2456 } }\n', 'utf8');
  fs.writeFileSync(paths.configLoaderEntry, `
exports.loadConfigFromPathStrict = function loadConfigFromPathStrict(configPath, platform) {
  return {
    server: { port: 2456 },
    configPath,
    platform,
  };
};
`, 'utf8');

  const result = await preflightConfig({ paths, platform: 'win32' });

  assert.equal(result.config.server.port, 2456);
  assert.equal(result.config.configPath, paths.configPath);
  assert.equal(result.config.platform, 'win32');
  assert.equal(result.paths, paths);
});

test('preflightConfig fails clearly when packaged CJS config loader is missing', async () => {
  const paths = createFixturePaths('buildergate-config-preflight-missing-');
  paths.isPackaged = true;
  paths.configLoaderEntry = path.join(paths.serverDir, 'dist-pkg', 'configStrictLoader.cjs');

  await assert.rejects(
    () => preflightConfig({ paths }),
    /Strict config loader is not built/u,
  );
});
