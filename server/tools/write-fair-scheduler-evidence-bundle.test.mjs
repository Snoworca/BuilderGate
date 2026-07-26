import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writerUrl = pathToFileURL(resolve(serverRoot, 'tools/write-fair-scheduler-evidence-bundle.mjs')).href;
const sourceRoot = resolve(
  serverRoot,
  '../docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness',
);

test('PERF-BGSTAB-010 bundle promotion keeps the last known-good deployment evidence when final admission rejects', async () => {
  const writer = await import(`${writerUrl}?bundle-atomic-red=${Date.now()}`);
  assert.equal(typeof writer.writeFairSchedulerEvidenceBundle, 'function');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-atomic-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  try {
    await cp(sourceRoot, outputRoot, { recursive: true });
    const markerPath = join(outputRoot, 'last-known-good.txt');
    await writeFile(markerPath, 'preserve-me\n', 'utf8');

    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: false, reason: 'runtime-rejected' }),
      }),
      /runtime-rejected/u,
    );
    assert.equal(await readFile(markerPath, 'utf8'), 'preserve-me\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 default bundle writer stages exactly one complete generation accepted by compiled runtime', async () => {
  const writer = await import(`${writerUrl}?bundle-success=${Date.now()}`);
  const result = await writer.writeFairSchedulerEvidenceBundle();
  const outputRoot = resolve(serverRoot, 'dist/benchmarks/fair-scheduler-evidence');
  const pointer = JSON.parse(await readFile(join(outputRoot, 'fair-scheduler-decision.json.publication.json'), 'utf8'));
  const artifact = JSON.parse(await readFile(join(outputRoot, ...pointer.artifactPath.split('/')), 'utf8'));
  const generationDirectory = join(outputRoot, ...pointer.artifactPath.split('/').slice(0, 2));
  const canary = await import(pathToFileURL(
    resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
  ).href);

  assert.equal(result.fileCount, 18);
  assert.equal((await readdir(generationDirectory, { recursive: true })).filter(entry => entry.endsWith('.json')).length, 17);
  assert.deepEqual(canary.validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy: artifact.policy }), {
    accepted: true,
    reason: 'decision-artifact-verified',
  });
});
