const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { preflightConfig } = require('./config-preflight');

test('preflightConfig rejects invalid existing config without default fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-config-preflight-invalid-'));
  const configPath = path.join(dir, 'config.json5');
  fs.writeFileSync(configPath, '{ server: ', 'utf8');

  await assert.rejects(
    () => preflightConfig({
      paths: {
        configPath,
        serverDir: path.resolve('server'),
      },
    }),
    /invalid|JSON5|Configuration/i,
  );
});

test('preflightConfig allows missing config bootstrap through the server strict loader', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-config-preflight-missing-'));
  const configPath = path.join(dir, 'config.json5');

  const result = await preflightConfig({
    paths: {
      configPath,
      serverDir: path.resolve('server'),
    },
  });

  assert.equal(result.config.server.port, 2002);
  assert.equal(fs.existsSync(configPath), true);
});
