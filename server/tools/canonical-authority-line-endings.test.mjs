import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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

  let result;
  try {
    writeFileSync(targetPath, mutated);
    result = runWriter();
  } finally {
    writeFileSync(targetPath, original);
  }

  assert.equal(
    sha256(readFileSync(targetPath)),
    sha256(original),
    'the boundary control failed to restore the canonical decision artifact',
  );
  assert.notEqual(result.status, 0, 'the writer accepted a digest-covered file whose content had changed');
  assert.match(result.stderr, /canonical authority digest mismatch/u);
});
