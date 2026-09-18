import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serverRoot, '..');
const authorityRelativePath = 'docs/analysis/terminal-fairness-authority';
const authorityRoot = resolve(repositoryRoot, ...authorityRelativePath.split('/'));
const writerScript = resolve(serverRoot, 'tools', 'write-fair-scheduler-evidence-bundle.mjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPointer() {
  return JSON.parse(readFileSync(join(authorityRoot, 'current.json'), 'utf8'));
}

function generationRoot(pointer) {
  return join(authorityRoot, 'generations', pointer.generation_id);
}

function checkAttribute(attribute, relativePath) {
  const result = spawnSync('git', ['check-attr', attribute, '--', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `git check-attr failed to run for ${relativePath}`);
  assert.equal(result.status, 0, `git check-attr exited ${result.status} for ${relativePath}: ${result.stderr}`);
  return result.stdout.trim();
}

function runWriter() {
  return spawnSync(process.execPath, [writerScript], { cwd: repositoryRoot, encoding: 'utf8' });
}

// #51: heal before ANY test reads the artifact.
//
// A leftover backup means a previous run of the boundary control below was killed between its
// mutation and its restore, leaving a TRACKED file dirty. This used to be a `finally`, which
// cannot survive SIGKILL or OOM.
//
// It runs at module scope rather than inside the boundary-control test on purpose: the first
// attempt healed inside that test, which is the FOURTH one, so the three tests before it read the
// corrupted artifact and failed first. Healing late is the same as not healing -- the run still
// goes red for a reason that has nothing to do with what it measures.
//
// It reports rather than repairing silently. A quiet repair would hide that the tracked artifact
// had been left dirty, which is the thing this issue is about.
(function healOrphanedBoundaryControlBackup() {
  const pointer = readPointer();
  const targetPath = join(generationRoot(pointer), pointer.decision_artifact);
  const backupPath = `${targetPath}.51-restore-backup`;
  if (!existsSync(backupPath)) return;
  writeFileSync(targetPath, readFileSync(backupPath));
  rmSync(backupPath, { force: true });
  process.stderr.write(
    `#51: restored ${pointer.decision_artifact} from an orphaned backup; a previous run of the `
    + 'boundary control was interrupted between its mutation and its restore.\n',
  );
})();

test('OPS-BGSTAB-008 the canonical authority path is pinned to -text so checkout converts no line endings', () => {
  const pointer = readPointer();
  const pinnedPaths = [
    `${authorityRelativePath}/current.json`,
    `${authorityRelativePath}/generations/${pointer.generation_id}/fair-scheduler-decision.json`,
    `${authorityRelativePath}/generations/${pointer.generation_id}/provenance.json`,
    `${authorityRelativePath}/generations/${pointer.generation_id}/raw/manifest.json`,
    `${authorityRelativePath}/generations/${pointer.generation_id}/raw/fair-scheduler-raw/clients-1/trial-0.json`,
  ];

  for (const relativePath of pinnedPaths) {
    assert.equal(
      checkAttribute('text', relativePath),
      `${relativePath}: text: unset`,
      `${relativePath} must carry the -text attribute so checkout writes the committed bytes verbatim`,
    );
  }
});

test('OPS-BGSTAB-008 working-tree bytes match every digest recorded in current.json', () => {
  const pointer = readPointer();
  const generation = generationRoot(pointer);

  assert.equal(
    sha256(readFileSync(join(generation, pointer.decision_artifact))),
    pointer.decision_sha256,
    'decision artifact bytes on disk differ from the digest in current.json',
  );
  assert.equal(
    sha256(readFileSync(join(generation, pointer.provenance_artifact))),
    pointer.provenance_sha256,
    'provenance bytes on disk differ from the digest in current.json',
  );
  const manifestPath = join(generation, 'raw', 'manifest.json');
  assert.equal(
    sha256(readFileSync(manifestPath)),
    pointer.raw_manifest_sha256,
    'raw manifest bytes on disk differ from the digest in current.json',
  );

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.entries.length, 15, 'the raw manifest must still enumerate the 15 trial sidecars');
  const mismatched = manifest.entries
    .filter(entry => sha256(readFileSync(join(generation, ...entry.path.split('/')))) !== entry.sha256)
    .map(entry => entry.path);
  assert.deepEqual(mismatched, [], 'raw sidecar bytes on disk differ from the digests in the raw manifest');
});

test('OPS-BGSTAB-008 the bundle writer completes on this working tree', () => {
  const pointer = readPointer();
  const result = runWriter();

  assert.equal(result.error, undefined, 'the bundle writer failed to start');
  assert.equal(result.status, 0, `the bundle writer exited ${result.status}: ${result.stderr}`);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.generationId, pointer.generation_id);
  assert.equal(summary.fileCount, 19);
});

test('OPS-BGSTAB-008 boundary control: the writer still rejects a digest-covered file whose content changed', () => {
  const pointer = readPointer();
  const targetPath = join(generationRoot(pointer), pointer.decision_artifact);
  const original = readFileSync(targetPath);
  const mutated = Buffer.from(original);
  mutated[mutated.length - 1] = mutated[mutated.length - 1] === 0x20 ? 0x09 : 0x20;
  assert.notEqual(sha256(mutated), sha256(original), 'the boundary control must actually change the file content');

  // #51: this mutates a TRACKED artifact in place. That is structurally required, not laziness --
  // write-fair-scheduler-evidence-bundle.mjs forbids a repositoryRoot override by design
  // ('canonical authority is bound to this repository', :194-195), so the boundary control cannot
  // be pointed at a copy. The risk the issue names is real: kill the process between the write and
  // the finally, and a tracked file stays dirty in the working tree.
  //
  // Closed in two layers, because `finally` alone cannot survive SIGKILL or OOM:
  //   1. A backup file is written BEFORE the mutation. Any later run finds it and restores,
  //      so the damage self-heals instead of waiting to be noticed in a diff.
  //   2. Signal handlers restore on SIGINT/SIGTERM, which covers Ctrl+C and timeout kills.
  // Layer 1 is what actually closes it; layer 2 only makes the common cases quiet.
  const backupPath = `${targetPath}.51-restore-backup`;
  const restore = () => {
    try {
      if (existsSync(backupPath)) {
        writeFileSync(targetPath, readFileSync(backupPath));
        rmSync(backupPath, { force: true });
      }
    } catch { /* restoring must never mask the assertion that sent us here */ }
  };
  const onSignal = () => { restore(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result;
  try {
    writeFileSync(backupPath, original);
    writeFileSync(targetPath, mutated);
    result = runWriter();
  } finally {
    restore();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  assert.equal(
    sha256(readFileSync(targetPath)),
    sha256(original),
    'the boundary control failed to restore the canonical decision artifact',
  );
  assert.notEqual(result.status, 0, 'the writer accepted a digest-covered file whose content had changed');
  assert.match(result.stderr, /canonical authority digest mismatch/u);
});
