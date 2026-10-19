// OPS-BGSTAB-022 (#149): start.sh skipped the build whenever a dist existed, so
// a checkout moved by git reset kept serving the old bundle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  decideDeploymentBuild,
  readBuildStamp,
  readSourceCommit,
  writeBuildStamp,
} = require('./build-freshness');

test('OPS-BGSTAB-022 AC-2: a dist built from another commit, or with no record, is rebuilt', () => {
  assert.equal(decideDeploymentBuild({ hasArtifacts: true, packaged: false, sourceCommit: 'bbb', stampCommit: 'aaa' }).action, 'rebuild');
  const noRecord = decideDeploymentBuild({ hasArtifacts: true, packaged: false, sourceCommit: 'bbb', stampCommit: null });
  assert.equal(noRecord.action, 'rebuild');
  assert.match(noRecord.reason, /bbb/u);
  assert.equal(decideDeploymentBuild({ hasArtifacts: true, packaged: false, sourceCommit: 'bbb', stampCommit: 'bbb' }).action, 'skip');
  assert.equal(decideDeploymentBuild({ hasArtifacts: false, packaged: false, sourceCommit: 'bbb', stampCommit: 'bbb' }).action, 'build');
});

test('OPS-BGSTAB-022 AC-3: packaged runs and runs without git keep skipping an existing dist', () => {
  assert.equal(decideDeploymentBuild({ hasArtifacts: true, packaged: true, sourceCommit: 'bbb', stampCommit: 'aaa' }).action, 'skip');
  assert.equal(decideDeploymentBuild({ hasArtifacts: true, packaged: false, sourceCommit: null, stampCommit: null }).action, 'skip');
});

test('OPS-BGSTAB-022 AC-1: the stamp round-trips, and a missing or broken stamp reads as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-stamp-'));
  try {
    const stamp = path.join(dir, '.build-source.json');
    assert.equal(readBuildStamp(stamp), null);
    writeBuildStamp(stamp, 'abc123');
    assert.equal(readBuildStamp(stamp), 'abc123');
    fs.writeFileSync(stamp, '{not json');
    assert.equal(readBuildStamp(stamp), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OPS-BGSTAB-022 AC-2 AC-3: the source commit comes from git, and a failing git reads as null', () => {
  const ok = readSourceCommit('/repo', () => ({ status: 0, stdout: 'deadbeef\n' }));
  assert.equal(ok, 'deadbeef');
  assert.equal(readSourceCommit('/repo', () => ({ status: 128, stdout: '' })), null);
  assert.equal(readSourceCommit('/repo', () => ({ error: new Error('ENOENT') })), null);
  assert.equal(readSourceCommit('/repo', () => { throw new Error('boom'); }), null);
});

test('OPS-BGSTAB-022: start-runtime consults the decision and writes the stamp after a build', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'start-runtime.js'), 'utf8');
  assert.match(source, /decideDeploymentBuild\(/u);
  const build = source.slice(source.indexOf('function ensureDependenciesAndBuild'));
  assert.ok(build.indexOf('writeBuildStamp(') > build.indexOf("label: 'server build'"), 'the stamp is written after the server build');
});
