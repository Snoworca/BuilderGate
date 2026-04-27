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
  const packagedReadmes = [
    path.join(ROOT, 'dist', 'bin', 'README.md'),
    path.join(ROOT, 'dist', 'bin', 'win-arm64', 'README.md'),
    path.join(ROOT, 'dist', 'bin', 'linux-arm64', 'README.md'),
    path.join(ROOT, 'dist', 'bin', 'macos-arm64', 'README.md'),
  ].filter((filePath) => fs.existsSync(filePath));

  assert.notEqual(packagedReadmes.length, 0, 'at least one packaged README.md must exist after daemon exe build');
  for (const packagedReadme of packagedReadmes) {
    validateReadmeFile(packagedReadme, path.relative(ROOT, packagedReadme));
  }
});

test('README policy rejects production PM2 guidance', () => {
  assert.throws(
    () => validateReadmeContent('BuilderGate native daemon\npm2 start BuilderGate\n'),
    /forbidden pattern found: pm2 token/i,
  );
});
