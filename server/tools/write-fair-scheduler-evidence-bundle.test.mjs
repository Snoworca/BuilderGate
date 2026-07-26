import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writerUrl = pathToFileURL(resolve(serverRoot, 'tools/write-fair-scheduler-evidence-bundle.mjs')).href;
const sourceRoot = resolve(
  serverRoot,
  '../docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness',
);

async function readGenerationJsonFiles(root) {
  const files = (await readdir(root, { recursive: true }))
    .filter(filePath => filePath.endsWith('.json'))
    .sort();
  return await Promise.all(files.map(async filePath => [filePath, await readFile(join(root, filePath), 'utf8')]));
}

function findDistinctWindowsShortPath(directory) {
  if (process.platform !== 'win32' || !/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/u.test(directory)) return undefined;
  const shortPath = execFileSync(
    'cmd.exe',
    ['/d', '/c', `for %I in (${directory}) do @echo %~sI`],
    { encoding: 'utf8' },
  ).trim();
  return shortPath.length > 0 && shortPath.toLocaleLowerCase() !== directory.toLocaleLowerCase()
    ? shortPath
    : undefined;
}

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
    await assert.rejects(
      readFile(join(temporaryRoot, '.fair-scheduler-evidence.publish.lock'), 'utf8'),
      { code: 'ENOENT' },
    );
    await assert.doesNotReject(writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
    }));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 stale publish lock fails closed without changing the active pointer', async () => {
  const writer = await import(`${writerUrl}?bundle-stale-lock=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-stale-lock-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
  const lockPath = join(temporaryRoot, '.fair-scheduler-evidence.publish.lock');
  try {
    await cp(sourceRoot, outputRoot, { recursive: true });
    const pointerBefore = await readFile(pointerPath, 'utf8');
    await writeFile(lockPath, 'stale-owner\n', 'utf8');
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({ sourceRoot, outputRoot }),
      /publication lock exists/u,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore);
    assert.equal(await readFile(lockPath, 'utf8'), 'stale-owner\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 bundle writer rejects an output-root junction before reading its external lock', async () => {
  const writer = await import(`${writerUrl}?bundle-output-root-junction=${Date.now()}`);
  const aliasContainer = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-output-root-alias-'));
  const outsideParent = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-output-root-outside-'));
  const aliasParent = join(aliasContainer, 'redirected-parent');
  const outputRoot = join(aliasParent, 'fair-scheduler-evidence');
  const externalLockPath = join(outsideParent, '.fair-scheduler-evidence.publish.lock');
  try {
    await symlink(outsideParent, aliasParent, 'junction');
    await writeFile(externalLockPath, 'outside-lock\n', 'utf8');
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      }),
      /symbolic-link evidence root/u,
    );
    assert.equal(await readFile(externalLockPath, 'utf8'), 'outside-lock\n');
  } finally {
    await rm(aliasContainer, { recursive: true, force: true });
    await rm(outsideParent, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 bundle writer rejects an output root that overlaps its audit source', async () => {
  const writer = await import(`${writerUrl}?bundle-overlapping-roots=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-overlapping-roots-'));
  try {
    for (const [name, outputFrom] of [
      ['same-root', (auditRoot) => auditRoot],
      ['output-inside-source', (auditRoot) => join(auditRoot, 'nested-output')],
      ['source-inside-output', (auditRoot) => dirname(auditRoot)],
    ]) {
      const auditRoot = join(temporaryRoot, name, 'audit-source');
      await cp(sourceRoot, auditRoot, { recursive: true });
      const filesBefore = await readGenerationJsonFiles(auditRoot);
      const pointerBefore = await readFile(join(auditRoot, 'fair-scheduler-decision.json.publication.json'), 'utf8');
      await assert.rejects(
        writer.writeFairSchedulerEvidenceBundle({
          sourceRoot: auditRoot,
          outputRoot: outputFrom(auditRoot),
          validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
          validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
        }),
        /source and output roots overlap/u,
        name,
      );
      assert.equal(await readFile(join(auditRoot, 'fair-scheduler-decision.json.publication.json'), 'utf8'), pointerBefore, name);
      assert.deepEqual(await readGenerationJsonFiles(auditRoot), filesBefore, name);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 sibling output roots use independent staging directories', async () => {
  const writer = await import(`${writerUrl}?bundle-sibling-staging=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-sibling-staging-'));
  const outputA = join(temporaryRoot, 'evidence-a');
  const outputB = join(temporaryRoot, 'evidence-b');
  const fixedNow = Date.now;
  const firstAtStaging = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  let firstWriter;
  try {
    Date.now = () => 1_726_000_000_000;
    firstWriter = writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot: outputA,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      beforeStagedValidation: async () => {
        firstAtStaging.resolve();
        await releaseFirst.promise;
      },
    });
    await firstAtStaging.promise;
    await assert.doesNotReject(writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot: outputB,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
    }));
    releaseFirst.resolve();
    await assert.doesNotReject(firstWriter);
    assert.equal(await readFile(join(outputA, 'fair-scheduler-decision.json.publication.json'), 'utf8').then(Boolean), true);
    assert.equal(await readFile(join(outputB, 'fair-scheduler-decision.json.publication.json'), 'utf8').then(Boolean), true);
  } finally {
    Date.now = fixedNow;
    releaseFirst.resolve();
    await firstWriter?.catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 failed staged admission removes its inactive generation and preserves the active pointer', async () => {
  const writer = await import(`${writerUrl}?bundle-no-inactive-generation=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-inactive-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
  const previousPointer = '{"generationId":"previous"}\n';
  try {
    await mkdir(join(outputRoot, 'fair-scheduler-publications', 'previous'), { recursive: true });
    await writeFile(pointerPath, previousPointer, 'utf8');
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: false, reason: 'runtime-rejected' }),
      }),
      /runtime-rejected/u,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), previousPointer);
    assert.deepEqual(await readdir(join(outputRoot, 'fair-scheduler-publications')), ['previous']);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 inactive-generation cleanup failure never removes the already activated generation', async () => {
  const writer = await import(`${writerUrl}?bundle-cleanup-failure=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-cleanup-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
  try {
    await mkdir(join(outputRoot, 'fair-scheduler-publications', 'previous'), { recursive: true });
    await writeFile(pointerPath, '{"generationId":"previous"}\n', 'utf8');
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
        removeInactiveGenerations: async () => { throw new Error('cleanup-failed'); },
      }),
      /cleanup-failed/u,
    );
    const publication = JSON.parse(await readFile(pointerPath, 'utf8'));
    assert.equal((await readdir(join(outputRoot, ...publication.artifactPath.split('/').slice(0, 2)))).length > 0, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 existing output generation must byte-match the staged compiled-admitted generation', async () => {
  const writer = await import(`${writerUrl}?bundle-generation-collision=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-collision-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const sourcePointer = JSON.parse(await readFile(join(sourceRoot, 'fair-scheduler-decision.json.publication.json'), 'utf8'));
  const generationDirectory = sourcePointer.artifactPath.split('/').slice(0, 2);
  try {
    await mkdir(join(outputRoot, ...generationDirectory), { recursive: true });
    await writeFile(join(outputRoot, ...generationDirectory, 'fair-scheduler-decision.json'), '{"corrupt":true}\n', 'utf8');
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      }),
      /existing fair scheduler generation differs from staged evidence/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 existing output generation rejects unselected files before pointer replacement', async () => {
  const writer = await import(`${writerUrl}?bundle-generation-inventory=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-extra-generation-file-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
  try {
    await cp(sourceRoot, outputRoot, { recursive: true });
    const pointerBefore = await readFile(pointerPath, 'utf8');
    const publication = JSON.parse(pointerBefore);
    await writeFile(join(outputRoot, ...publication.artifactPath.split('/').slice(0, 2), 'unselected.json'), '{"unselected":true}\n', 'utf8');
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      }),
      /existing fair scheduler generation differs from staged evidence/u,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 concurrent bundle promotion fails closed without changing the active pointer', async () => {
  const writer = await import(`${writerUrl}?bundle-exclusive-publish=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-exclusive-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
  const lockPath = join(temporaryRoot, '.fair-scheduler-evidence.publish.lock');
  let releaseFirstWriter;
  const releaseGate = new Promise(resolve => { releaseFirstWriter = resolve; });
  let firstWriter;
  try {
    await cp(sourceRoot, outputRoot, { recursive: true });
    const pointerBefore = await readFile(pointerPath, 'utf8');
    const firstWriterAtLock = Promise.withResolvers();
    firstWriter = writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      afterPublishLockAcquired: async () => {
        firstWriterAtLock.resolve();
        await releaseGate;
      },
    });
    assert.equal(await Promise.race([
      firstWriterAtLock.promise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]), true);
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      }),
      /publication lock exists/u,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore);
    releaseFirstWriter();
    await firstWriter;
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
    await assert.doesNotReject(writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
    }));
  } finally {
    releaseFirstWriter?.();
    await firstWriter?.catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 bundle output path aliases share one publish lock', async () => {
  const writer = await import(`${writerUrl}?bundle-alias-lock=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-alias-lock-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const aliasOutputRoot = `${outputRoot}${sep}.`;
  let releaseFirstWriter;
  let firstWriter;
  try {
    const firstWriterAtLock = Promise.withResolvers();
    const releaseGate = new Promise(resolve => { releaseFirstWriter = resolve; });
    firstWriter = writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      afterPublishLockAcquired: async () => {
        firstWriterAtLock.resolve();
        await releaseGate;
      },
    });
    assert.equal(await Promise.race([
      firstWriterAtLock.promise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]), true);
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot: aliasOutputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      }),
      /publication lock exists/u,
    );
  } finally {
    releaseFirstWriter?.();
    await firstWriter?.catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 bundle writer shares its publish lock across an NTFS 8.3 output-root alias', async (t) => {
  const writer = await import(`${writerUrl}?bundle-short-path-lock=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(process.cwd(), '.fair-scheduler-short-path-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  await mkdir(outputRoot);
  const aliasOutputRoot = findDistinctWindowsShortPath(outputRoot);
  if (!aliasOutputRoot) {
    t.skip('NTFS 8.3 short path is unavailable for this test directory');
    await rm(temporaryRoot, { recursive: true, force: true });
    return;
  }
  let releaseFirstWriter;
  let firstWriter;
  try {
    const firstWriterAtLock = Promise.withResolvers();
    const releaseGate = new Promise(resolve => { releaseFirstWriter = resolve; });
    firstWriter = writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      afterPublishLockAcquired: async () => {
        firstWriterAtLock.resolve();
        await releaseGate;
      },
    });
    await firstWriterAtLock.promise;
    await assert.rejects(
      writer.writeFairSchedulerEvidenceBundle({
        sourceRoot,
        outputRoot: aliasOutputRoot,
        validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
        validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      }),
      /publication lock exists/u,
    );
  } finally {
    releaseFirstWriter?.();
    await firstWriter?.catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 bundle writer revalidates its output generation immediately before pointer promotion', async () => {
  const writer = await import(`${writerUrl}?bundle-final-promotion-validation=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-final-promotion-validation-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
  let hookCalled = false;
  try {
    await cp(sourceRoot, outputRoot, { recursive: true });
    const pointerBefore = await readFile(pointerPath, 'utf8');
    await assert.rejects(writer.writeFairSchedulerEvidenceBundle({
      sourceRoot,
      outputRoot,
      validateStaged: () => ({ accepted: true, reason: 'staged-verified' }),
      validateRuntime: () => ({ accepted: true, reason: 'runtime-verified' }),
      beforeCanonicalPointerPromotion: async ({ bundle }) => {
        hookCalled = true;
        await writeFile(join(outputRoot, ...bundle.publication.artifactPath.split('/')), '{"corrupt":true}\n', 'utf8');
      },
    }), /existing fair scheduler generation differs from staged evidence/u);
    assert.equal(hookCalled, true);
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 default staged validators reject serialized raw and sidecar corruption without changing LKG', async () => {
  const writer = await import(`${writerUrl}?bundle-default-staged-corruption=${Date.now()}`);
  for (const evidenceKind of ['raw', 'sidecar']) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), `buildergate-fair-bundle-${evidenceKind}-corruption-`));
    const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
    const pointerPath = join(outputRoot, 'fair-scheduler-decision.json.publication.json');
    try {
      await cp(sourceRoot, outputRoot, { recursive: true });
      const pointerBefore = await readFile(pointerPath, 'utf8');
      const publication = JSON.parse(pointerBefore);
      const artifactBefore = await readFile(join(outputRoot, ...publication.artifactPath.split('/')), 'utf8');
      const generationBefore = await readGenerationJsonFiles(
        join(outputRoot, ...publication.artifactPath.split('/').slice(0, 2)),
      );
      await assert.rejects(
        writer.writeFairSchedulerEvidenceBundle({
          sourceRoot,
          outputRoot,
          beforeStagedValidation: async ({ stagingRoot, bundle }) => {
            const evidencePath = evidenceKind === 'raw'
              ? bundle.publication.rawPath
              : bundle.artifact.rawEvidencePaths[0];
            await writeFile(join(stagingRoot, ...evidencePath.split('/')), '{"corrupt":true}\n', 'utf8');
          },
        }),
        /staged fair scheduler evidence rejected/u,
      );
      assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore);
      assert.equal(
        await readFile(join(outputRoot, ...publication.artifactPath.split('/')), 'utf8'),
        artifactBefore,
      );
      assert.deepEqual(
        await readGenerationJsonFiles(join(outputRoot, ...publication.artifactPath.split('/').slice(0, 2))),
        generationBefore,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test('PERF-BGSTAB-010 default bundle writer stages exactly one complete generation accepted by compiled runtime', async () => {
  const writer = await import(`${writerUrl}?bundle-success=${Date.now()}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-bundle-success-'));
  const outputRoot = join(temporaryRoot, 'fair-scheduler-evidence');
  try {
    const result = await writer.writeFairSchedulerEvidenceBundle({ sourceRoot, outputRoot });
    const pointer = JSON.parse(await readFile(join(outputRoot, 'fair-scheduler-decision.json.publication.json'), 'utf8'));
    const artifact = JSON.parse(await readFile(join(outputRoot, ...pointer.artifactPath.split('/')), 'utf8'));
    const generationDirectory = join(outputRoot, ...pointer.artifactPath.split('/').slice(0, 2));
    const canary = await import(pathToFileURL(
      resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
    ).href);

    assert.equal(result.fileCount, 18);
    assert.equal((await readdir(join(outputRoot, 'fair-scheduler-publications'))).length, 1);
    assert.equal((await readdir(outputRoot, { recursive: true })).filter(entry => entry.endsWith('.json')).length, 18);
    assert.equal((await readdir(generationDirectory, { recursive: true })).filter(entry => entry.endsWith('.json')).length, 17);
    assert.deepEqual(canary.validateStagedFairDeliveryCandidateArtifact({
      artifactRoot: outputRoot,
      runtimePolicy: artifact.policy,
    }), { accepted: true, reason: 'decision-artifact-verified' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
