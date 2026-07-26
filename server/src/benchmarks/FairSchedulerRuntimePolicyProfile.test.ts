import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

type RuntimePolicyProfile = {
  schemaVersion: string;
  authority: string;
  policy: Record<string, unknown>;
  policyHash: string;
  profileHash: string;
};

type FairnessModule = {
  createFairSchedulerRuntimePolicyProfile(runtimeConfig: {
    getEditableValues(): { resourceLimits: { ws: {
      serverBufferedHighWaterBytes: number;
      perClientOutputQueueMaxBytes: number;
      perClientControlQueueMaxBytes: number;
      outputCoalesceWindowMs: number;
    } } };
  }): RuntimePolicyProfile;
  createFairSchedulerDecisionArtifact(input: FairSchedulerBenchmarkInput & {
    runtimePolicyProfile?: RuntimePolicyProfile;
  }): {
    artifact: Record<string, unknown>;
    rawArtifacts: Record<string, unknown>;
  };
  validateFairSchedulerDecisionArtifact(input: {
    artifact: unknown;
    rawArtifacts: unknown;
    runtimePolicyProfile?: RuntimePolicyProfile;
  }): { accepted: boolean; reason: string };
  writeFairSchedulerDecisionArtifact(input: FairSchedulerBenchmarkInput & {
    outputPath: string;
    runtimePolicyProfile?: RuntimePolicyProfile;
    afterPublicationLockAcquired?: () => Promise<void>;
  }): Promise<{ artifactPath: string; digest: string }>;
};

type FairSchedulerBenchmarkInput = {
  clients: readonly number[];
  wanLatencyMs: number;
  wanJitterMs: number;
  wanLossPercent: number;
  seed: number;
  repeats: number;
  samples: number;
};

const benchmarkInput: FairSchedulerBenchmarkInput = {
  clients: [1, 2, 8],
  wanLatencyMs: 150,
  wanJitterMs: 20,
  wanLossPercent: 0,
  seed: 20260723,
  repeats: 5,
  samples: 30,
};

async function loadFairness(signature: string): Promise<FairnessModule> {
  try {
    return await import('./terminalFairnessCharacterization.js') as unknown as FairnessModule;
  } catch (error) {
    throw new Error(signature, { cause: error });
  }
}

function createRuntimeConfig(perClientOutputQueueMaxBytes: number) {
  return {
    getEditableValues: () => ({
      resourceLimits: {
        ws: {
          serverBufferedHighWaterBytes: 1_536,
          perClientOutputQueueMaxBytes,
          perClientControlQueueMaxBytes: 2_048,
          outputCoalesceWindowMs: 4,
        },
      },
    }),
  };
}

test('PERF-BGSTAB-010 RuntimeConfigStore profile is non-secret and binds raw plus decision evidence', async () => {
  const signature = 'PERF-BGSTAB-010 runtime policy profile must bind one effective RuntimeConfigStore projection';
  const fairness = await loadFairness(signature);
  const runtimePolicyProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const generated = fairness.createFairSchedulerDecisionArtifact({ ...benchmarkInput, runtimePolicyProfile });

  assert.equal(runtimePolicyProfile.schemaVersion, 'fair-scheduler-runtime-policy-profile/v1', signature);
  assert.equal(runtimePolicyProfile.authority, 'runtime-config-store/v1', signature);
  assert.match(runtimePolicyProfile.policyHash, /^[a-f0-9]{64}$/u, signature);
  assert.match(runtimePolicyProfile.profileHash, /^[a-f0-9]{64}$/u, signature);
  assert.equal('resourceLimits' in runtimePolicyProfile, false, signature);
  assert.deepEqual(generated.artifact.runtimePolicyProfile, runtimePolicyProfile, signature);
  assert.deepEqual(generated.rawArtifacts.runtimePolicyProfile, runtimePolicyProfile, signature);
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    ...generated,
    runtimePolicyProfile,
  }), { accepted: true, reason: 'decision-artifact-verified' }, signature);
});

test('PERF-BGSTAB-010 policy profile deeply freezes leaves and changes measured evidence for a non-default policy', async () => {
  const signature = 'PERF-BGSTAB-010 profile leaves and measured evidence must remain policy-bound';
  const fairness = await loadFairness(signature);
  const baselineProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const nonDefaultProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  const baseline = fairness.createFairSchedulerDecisionArtifact({
    ...benchmarkInput,
    runtimePolicyProfile: baselineProfile,
  });
  const nonDefault = fairness.createFairSchedulerDecisionArtifact({
    ...benchmarkInput,
    runtimePolicyProfile: nonDefaultProfile,
  });
  const nestedPolicyValue = nonDefaultProfile.policy.socketSoftGateBytes as { value: number };

  assert.throws(() => {
    nestedPolicyValue.value = 999;
  }, TypeError, signature);
  assert.notEqual(
    ((baseline.artifact.thresholds as Record<string, { exact: number }>).peakApplicationQueuedBytes.exact),
    ((nonDefault.artifact.thresholds as Record<string, { exact: number }>).peakApplicationQueuedBytes.exact),
    signature,
  );
  assert.notEqual(
    ((baseline.rawArtifacts.samples as Array<{ candidate: { throughputBytesPerSecond: number } }>)[0])
      ?.candidate.throughputBytesPerSecond,
    ((nonDefault.rawArtifacts.samples as Array<{ candidate: { throughputBytesPerSecond: number } }>)[0])
      ?.candidate.throughputBytesPerSecond,
    signature,
  );
});

test('PERF-BGSTAB-010 one-field policy profile drift rejects fair-delivery evidence', async () => {
  const signature = 'PERF-BGSTAB-010 one-field runtime policy drift must fail closed';
  const fairness = await loadFairness(signature);
  const benchmarkProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const driftedProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  const generated = fairness.createFairSchedulerDecisionArtifact({
    ...benchmarkInput,
    runtimePolicyProfile: benchmarkProfile,
  });

  assert.notEqual(benchmarkProfile.profileHash, driftedProfile.profileHash, signature);
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    ...generated,
    runtimePolicyProfile: driftedProfile,
  }), { accepted: false, reason: 'runtime-policy-profile-mismatch' }, signature);
});

test('PERF-BGSTAB-010 official writer retains an earlier generation when a policy profile changes', async () => {
  const signature = 'PERF-BGSTAB-010 writer must retain prior generation while replacing only canonical pointers';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-profile-'));
  const outputPath = join(directory, 'fair-scheduler-decision.json');
  try {
    await fairness.writeFairSchedulerDecisionArtifact({
      ...benchmarkInput,
      outputPath,
      runtimePolicyProfile: fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192)),
    });
    const firstPublication = JSON.parse(await readFile(`${outputPath}.publication.json`, 'utf8')) as {
      generationId: string;
    };
    await fairness.writeFairSchedulerDecisionArtifact({
      ...benchmarkInput,
      outputPath,
      runtimePolicyProfile: fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288)),
    });
    const secondPublication = JSON.parse(await readFile(`${outputPath}.publication.json`, 'utf8')) as {
      generationId: string;
    };

    assert.notEqual(firstPublication.generationId, secondPublication.generationId, signature);
    assert.equal(existsSync(join(
      directory,
      'fair-scheduler-publications',
      firstPublication.generationId,
      'fair-scheduler-decision.json',
    )), true, signature);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 official writer reissues an already moved identical generation after a pointer-swap interruption', async () => {
  const signature = 'PERF-BGSTAB-010 pointer retry must reuse only the exact staged generation while preserving LKG';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-pointer-retry-'));
  const outputPath = join(directory, 'fair-scheduler-decision.json');
  const pointerPath = `${outputPath}.publication.json`;
  const firstProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const secondProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: firstProfile });
    const firstPointer = await readFile(pointerPath, 'utf8');
    await fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: secondProfile });
    const secondPointer = await readFile(pointerPath, 'utf8');
    const secondPublication = JSON.parse(secondPointer) as { generationId: string };

    await writeFile(pointerPath, firstPointer, 'utf8');
    await assert.doesNotReject(fairness.writeFairSchedulerDecisionArtifact({
      ...benchmarkInput,
      outputPath,
      runtimePolicyProfile: secondProfile,
    }), signature);
    assert.equal(await readFile(pointerPath, 'utf8'), secondPointer, signature);
    assert.equal(existsSync(join(
      directory,
      'fair-scheduler-publications',
      secondPublication.generationId,
      'fair-scheduler-decision.json',
    )), true, signature);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 official writer preserves an earlier pointer when the moved retry generation differs', async () => {
  const signature = 'PERF-BGSTAB-010 pointer retry must reject a corrupted moved generation';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-pointer-retry-corrupt-'));
  const outputPath = join(directory, 'fair-scheduler-decision.json');
  const pointerPath = `${outputPath}.publication.json`;
  const firstProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const secondProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: firstProfile });
    const firstPointer = await readFile(pointerPath, 'utf8');
    await fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: secondProfile });
    const secondPublication = JSON.parse(await readFile(pointerPath, 'utf8')) as { artifactPath: string };
    await writeFile(pointerPath, firstPointer, 'utf8');
    await writeFile(join(directory, secondPublication.artifactPath), '{"corrupt":true}\n', 'utf8');
    await assert.rejects(fairness.writeFairSchedulerDecisionArtifact({
      ...benchmarkInput,
      outputPath,
      runtimePolicyProfile: secondProfile,
    }), /existing fair scheduler generation is invalid/u, signature);
    assert.equal(await readFile(pointerPath, 'utf8'), firstPointer, signature);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 official writer fails closed on a stale output lock without changing LKG', async () => {
  const signature = 'PERF-BGSTAB-010 stale docs publication lock must preserve the active pointer';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-docs-stale-lock-'));
  const outputDirectory = join(directory, 'evidence');
  const outputPath = join(outputDirectory, 'fair-scheduler-decision.json');
  const pointerPath = `${outputPath}.publication.json`;
  const lockPath = join(outputDirectory, '.fair-scheduler-publication.publish.lock');
  const firstProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const secondProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: firstProfile });
    const pointerBefore = await readFile(pointerPath, 'utf8');
    await writeFile(lockPath, 'stale-lock\n', 'utf8');

    await assert.rejects(
      fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: secondProfile }),
      /publication lock exists/u,
      signature,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore, signature);
    await rm(lockPath);
    await assert.doesNotReject(
      fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: secondProfile }),
      signature,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 concurrent docs publication fails closed while its output lock is held', async () => {
  const signature = 'PERF-BGSTAB-010 concurrent docs publication must not replace LKG during an active publish';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-docs-exclusive-lock-'));
  const outputDirectory = join(directory, 'evidence');
  const outputPath = join(outputDirectory, 'fair-scheduler-decision.json');
  const pointerPath = `${outputPath}.publication.json`;
  const lockPath = join(outputDirectory, '.fair-scheduler-publication.publish.lock');
  const firstProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const secondProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  let releaseFirstWriter: (() => void) | undefined;
  let firstWriter: Promise<unknown> | undefined;
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: firstProfile });
    const pointerBefore = await readFile(pointerPath, 'utf8');
    let releaseFirstWriterAtLock: () => void = () => undefined;
    const firstWriterAtLock = new Promise<void>(resolve => { releaseFirstWriterAtLock = resolve; });
    const releaseGate = new Promise<void>(resolve => { releaseFirstWriter = resolve; });
    firstWriter = fairness.writeFairSchedulerDecisionArtifact({
      ...benchmarkInput,
      outputPath,
      runtimePolicyProfile: secondProfile,
      afterPublicationLockAcquired: async () => {
        releaseFirstWriterAtLock();
        await releaseGate;
      },
    });
    assert.equal(await Promise.race([
      firstWriterAtLock.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]), true, signature);
    await assert.rejects(
      fairness.writeFairSchedulerDecisionArtifact({ ...benchmarkInput, outputPath, runtimePolicyProfile: secondProfile }),
      /publication lock exists/u,
      signature,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore, signature);
    if (!releaseFirstWriter) throw new Error(`${signature}: first writer release was unavailable`);
    releaseFirstWriter();
    await firstWriter;
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' }, signature);
  } finally {
    releaseFirstWriter?.();
    await firstWriter?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 docs publication path aliases share one output lock', async () => {
  const signature = 'PERF-BGSTAB-010 normalized docs output aliases must not bypass an active publish lock';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-docs-alias-lock-'));
  const outputDirectory = join(directory, 'evidence');
  const outputPath = join(outputDirectory, 'fair-scheduler-decision.json');
  const aliasOutputPath = `${outputDirectory}${sep}.${sep}fair-scheduler-decision.json`;
  const firstProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(8_192));
  const secondProfile = fairness.createFairSchedulerRuntimePolicyProfile(createRuntimeConfig(12_288));
  let releaseFirstWriter: (() => void) | undefined;
  let firstWriter: Promise<unknown> | undefined;
  try {
    let releaseFirstWriterAtLock: () => void = () => undefined;
    const firstWriterAtLock = new Promise<void>(resolve => { releaseFirstWriterAtLock = resolve; });
    const releaseGate = new Promise<void>(resolve => { releaseFirstWriter = resolve; });
    firstWriter = fairness.writeFairSchedulerDecisionArtifact({
      ...benchmarkInput,
      outputPath,
      runtimePolicyProfile: firstProfile,
      afterPublicationLockAcquired: async () => {
        releaseFirstWriterAtLock();
        await releaseGate;
      },
    });
    assert.equal(await Promise.race([
      firstWriterAtLock.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]), true, signature);
    await assert.rejects(
      fairness.writeFairSchedulerDecisionArtifact({
        ...benchmarkInput,
        outputPath: aliasOutputPath,
        runtimePolicyProfile: secondProfile,
      }),
      /publication lock exists/u,
      signature,
    );
  } finally {
    releaseFirstWriter?.();
    await firstWriter?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
