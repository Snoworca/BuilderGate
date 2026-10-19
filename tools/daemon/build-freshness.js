// OPS-BGSTAB-022: a source checkout must not keep serving a dist built from an
// older commit. start.sh used to skip the build whenever a dist existed, so a
// checkout moved by `git reset` went on serving the old bundle with nothing on
// screen to say so (#149).
const { spawnSync } = require('child_process');
const fs = require('fs');

const BUILD_STAMP_FILE_NAME = '.build-source.json';

/**
 * build: no usable dist. rebuild: a dist exists but was built from another
 * commit, or carries no record of one. skip: the dist matches, or there is no
 * way to tell (a packaged runtime, or no git), which keeps the old behaviour.
 */
function decideDeploymentBuild({ hasArtifacts, packaged, sourceCommit, stampCommit }) {
  if (!hasArtifacts) return { action: 'build', reason: 'deployment dist missing' };
  if (packaged || !sourceCommit) return { action: 'skip', reason: 'deployment dist exists' };
  if (stampCommit === sourceCommit) return { action: 'skip', reason: `deployment dist matches ${sourceCommit}` };
  return {
    action: 'rebuild',
    reason: stampCommit
      ? `deployment dist was built from ${stampCommit}, the checkout is at ${sourceCommit}`
      : `deployment dist has no record of its source commit, the checkout is at ${sourceCommit}`,
  };
}

function readSourceCommit(root, run = spawnSync) {
  try {
    const result = run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!result || result.error || result.status !== 0) return null;
    const commit = String(result.stdout ?? '').trim();
    return commit || null;
  } catch {
    return null;
  }
}

function readBuildStamp(stampPath) {
  try {
    const commit = JSON.parse(fs.readFileSync(stampPath, 'utf8')).commit;
    return typeof commit === 'string' && commit ? commit : null;
  } catch {
    return null;
  }
}

function writeBuildStamp(stampPath, commit) {
  fs.writeFileSync(stampPath, `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

module.exports = {
  BUILD_STAMP_FILE_NAME,
  decideDeploymentBuild,
  readBuildStamp,
  readSourceCommit,
  writeBuildStamp,
};
