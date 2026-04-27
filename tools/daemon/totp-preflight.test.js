const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runDaemonTotpPreflight, resolveDaemonTotpPreflightModulePath } = require('./totp-preflight');

function createFixturePaths(prefix = 'buildergate-totp-preflight-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(path.join(serverDir, 'dist', 'services'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'package.json'), '{"type":"module"}\n', 'utf8');

  return {
    root,
    serverDir,
    configPath: path.join(root, 'config.json5'),
    totpSecretPath: path.join(root, 'server', 'data', 'totp.secret'),
  };
}

test('runDaemonTotpPreflight imports the built server helper with config and secret paths', async () => {
  const paths = createFixturePaths('buildergate-totp-preflight-import-');
  const modulePath = resolveDaemonTotpPreflightModulePath(paths.serverDir);
  fs.writeFileSync(modulePath, `
export async function runDaemonTotpPreflight(options) {
  return {
    enabled: true,
    configPath: options.configPath,
    secretFilePath: options.secretFilePath,
    platform: options.platform,
    issuer: options.config.twoFactor.issuer,
    suppressConsoleQr: options.suppressConsoleQr,
  };
}
`, 'utf8');

  const result = await runDaemonTotpPreflight({
    paths,
    platform: 'win32',
    config: {
      twoFactor: {
        enabled: true,
        issuer: 'ImportedIssuer',
        accountName: 'admin',
      },
    },
    suppressConsoleQr: true,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.configPath, paths.configPath);
  assert.equal(result.secretFilePath, paths.totpSecretPath);
  assert.equal(result.platform, 'win32');
  assert.equal(result.issuer, 'ImportedIssuer');
  assert.equal(result.suppressConsoleQr, true);
});

test('runDaemonTotpPreflight fails clearly when the built server helper is missing', async () => {
  const paths = createFixturePaths('buildergate-totp-preflight-missing-');

  await assert.rejects(
    () => runDaemonTotpPreflight({ paths }),
    /TOTP daemon preflight helper is not built/u,
  );
});
