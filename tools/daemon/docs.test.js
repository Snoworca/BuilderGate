const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateReadmeContent, validateReadmeFile } = require('./docs-policy');

const ROOT = path.resolve(__dirname, '..', '..');

test('root README documents native daemon build/run/foreground/stop/config/QR policy', () => {
  validateReadmeFile(path.join(ROOT, 'README.md'), 'README.md');
});

test('packaged README mirrors native daemon documentation policy', () => {
  const packagedReadme = path.join(ROOT, 'dist', 'bin', 'README.md');

  assert.equal(fs.existsSync(packagedReadme), true, 'dist/bin/README.md must exist after daemon exe build');
  validateReadmeFile(packagedReadme, 'dist/bin/README.md');
});

test('README policy rejects production PM2 guidance', () => {
  assert.throws(
    () => validateReadmeContent('BuilderGate native daemon\npm2 start BuilderGate\n'),
    /forbidden pattern found: pm2 token/i,
  );
});
