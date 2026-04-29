const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateReadmeContent, validateReadmeFile } = require('./docs-policy');
const { PACKAGE_VERSION } = require('../build-daemon-exe');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGED_README_TARGETS = [
  'win-amd64',
  'linux-amd64',
  'win-arm64',
  'linux-arm64',
  'macos-arm64',
];

test('root README documents packaged native daemon build/run/foreground/stop/config/QR policy', () => {
  validateReadmeFile(path.join(ROOT, 'README.md'), 'README.md');
});

test('packaged README mirrors native daemon documentation policy', () => {
  const packagedReadmes = [
    path.join(ROOT, 'dist', 'bin', 'README.md'),
    ...PACKAGED_README_TARGETS.map((target) => path.join(ROOT, 'dist', 'bin', `${target}-${PACKAGE_VERSION}`, 'README.md')),
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

test('README policy rejects source execution guidance', () => {
  assert.throws(
    () => validateReadmeContent('BuilderGate native daemon\nnode dev.js\n'),
    /forbidden pattern found: dev\.js execution command/i,
  );
  assert.throws(
    () => validateReadmeContent('BuilderGate native daemon\nnode tools/start-runtime.js\n'),
    /forbidden pattern found: source runtime launcher command/i,
  );
  assert.throws(
    () => validateReadmeContent('BuilderGate native daemon\nnode stop.js\n'),
    /forbidden pattern found: source stop command/i,
  );
});
