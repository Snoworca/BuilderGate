import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writerUrl = pathToFileURL(resolve(serverRoot, 'tools/write-fair-scheduler-evidence-bundle.mjs')).href;

async function captureAttempt(action) {
  try {
    await action();
    return { outcome: 'resolved' };
  } catch (error) {
    return { outcome: error instanceof Error ? error.message : String(error) };
  }
}

async function readSentinel(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    return `unreadable:${error?.code ?? 'unknown'}`;
  }
}

test('PERF-BGSTAB-010 canonical bundle writer rejects source-root override and copies only current immutable generation', async () => {
  const writer = await import(`${writerUrl}?canonical-authority-root=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-canonical-authority-writer-'));
  const outputCases = [
    { name: 'same', outputRoot: join(temporaryRoot, 'same', 'compiled-bundle') },
    { name: 'ancestor', outputRoot: join(temporaryRoot, 'ancestor') },
    { name: 'descendant', outputRoot: join(temporaryRoot, 'descendant', 'compiled-bundle', 'nested') },
    { name: 'non-overlap', outputRoot: join(temporaryRoot, 'non-overlap', 'alternate-bundle') },
  ].map(item => ({ ...item, sentinelPath: join(item.outputRoot, 'unrelated-sentinel.txt') }));
  const alternateRepositoryRoot = join(temporaryRoot, 'alternate-repository');
  const alternateRepositorySentinel = join(alternateRepositoryRoot, 'alternate-authority-sentinel.txt');
  const alternateOutputRoot = join(temporaryRoot, 'alternate-output');
  const alternateOutputSentinel = join(alternateOutputRoot, 'unrelated-sentinel.txt');

  try {
    await Promise.all([
      ...outputCases.map(async ({ outputRoot, sentinelPath }) => {
        await mkdir(outputRoot, { recursive: true });
        await writeFile(sentinelPath, 'preserve-output\n', 'utf8');
      }),
      mkdir(alternateRepositoryRoot, { recursive: true }).then(() => writeFile(alternateRepositorySentinel, 'preserve-repository\n', 'utf8')),
      mkdir(alternateOutputRoot, { recursive: true }).then(() => writeFile(alternateOutputSentinel, 'preserve-output\n', 'utf8')),
    ]);

    const [outputAttempts, sourceRootAttempt, repositoryRootAttempt] = await Promise.all([
      Promise.all(outputCases.map(async ({ name, outputRoot }) => ({
        name,
        result: await captureAttempt(() => writer.writeFairSchedulerEvidenceBundle({ outputRoot })),
      }))),
      captureAttempt(() => writer.writeFairSchedulerEvidenceBundle({ sourceRoot: alternateRepositoryRoot })),
      captureAttempt(() => writer.writeFairSchedulerEvidenceBundle({
        repositoryRoot: alternateRepositoryRoot,
        outputRoot: alternateOutputRoot,
      })),
    ]);

    const canonicalAuthorityRoot = resolve(serverRoot, '..', 'docs', 'analysis', 'terminal-fairness-authority');
    const canonicalCurrent = await readFile(join(canonicalAuthorityRoot, 'current.json'), 'utf8');
    const canonicalPointer = JSON.parse(canonicalCurrent);
    const compiledAuthorityRoot = resolve(serverRoot, 'dist', 'benchmarks', 'fair-scheduler-evidence');
    const normalResult = await writer.writeFairSchedulerEvidenceBundle();
    const rawManifest = JSON.parse(await readFile(join(
      canonicalAuthorityRoot,
      'generations',
      canonicalPointer.generation_id,
      'raw',
      'manifest.json',
    ), 'utf8'));
    const immutableGenerationFiles = [
      'fair-scheduler-decision.json',
      'provenance.json',
      'raw/manifest.json',
      ...rawManifest.entries.map(entry => entry.path),
    ];

    assert.equal(normalResult.generationId, canonicalPointer.generation_id);
    assert.equal(await readFile(join(compiledAuthorityRoot, 'current.json'), 'utf8'), canonicalCurrent);
    for (const relativePath of immutableGenerationFiles) {
      assert.equal(
        await readFile(join(compiledAuthorityRoot, 'generations', canonicalPointer.generation_id, ...relativePath.split('/')), 'utf8'),
        await readFile(join(canonicalAuthorityRoot, 'generations', canonicalPointer.generation_id, ...relativePath.split('/')), 'utf8'),
        relativePath,
      );
    }

    assert.deepEqual({
      outputAttempts,
      sourceRootAttempt,
      repositoryRootAttempt,
      outputSentinels: await Promise.all(outputCases.map(({ name, sentinelPath }) => readSentinel(sentinelPath).then(contents => ({ name, contents })))),
      alternateRepositorySentinel: await readSentinel(alternateRepositorySentinel),
      alternateOutputSentinel: await readSentinel(alternateOutputSentinel),
    }, {
      outputAttempts: outputCases.map(({ name }) => ({
        name,
        result: { outcome: 'outputRoot override is forbidden; compiled bundle destination is fixed' },
      })),
      sourceRootAttempt: { outcome: 'sourceRoot override is forbidden; canonical authority is the only supported source root' },
      repositoryRootAttempt: { outcome: 'repositoryRoot override is forbidden; canonical authority is bound to this repository' },
      outputSentinels: outputCases.map(({ name }) => ({ name, contents: 'preserve-output\n' })),
      alternateRepositorySentinel: 'preserve-repository\n',
      alternateOutputSentinel: 'preserve-output\n',
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
