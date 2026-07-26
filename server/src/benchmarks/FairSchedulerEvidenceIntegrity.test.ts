import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    runtimePolicyProfile: RuntimePolicyProfile;
  }): { artifact: Record<string, unknown>; rawArtifacts: Record<string, unknown> };
  createFairSchedulerTrialArtifacts(rawArtifacts: Record<string, unknown>): unknown[];
  validateFairSchedulerDecisionArtifact(input: {
    artifact: unknown;
    rawArtifacts: unknown;
    runtimePolicyProfile?: RuntimePolicyProfile;
  }): { accepted: boolean; reason: string };
  validateFairSchedulerTrialArtifacts(input: {
    rawArtifacts: unknown;
    trialArtifacts: readonly unknown[];
  }): { accepted: boolean; reason: string };
  writeFairSchedulerDecisionArtifact(input: FairSchedulerBenchmarkInput & {
    outputPath: string;
    runtimePolicyProfile: RuntimePolicyProfile;
  }): Promise<{ artifactPath: string; digest: string }>;
  validateFairSchedulerPublicationDirectory(input: {
    artifactRoot: string;
  }): { accepted: boolean; reason: string };
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

const input: FairSchedulerBenchmarkInput = {
  clients: [1, 2, 8],
  wanLatencyMs: 150,
  wanJitterMs: 20,
  wanLossPercent: 0,
  seed: 20260723,
  repeats: 5,
  samples: 30,
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function loadFairness(): Promise<FairnessModule> {
  return await import('./terminalFairnessCharacterization.js') as unknown as FairnessModule;
}

function createRuntimePolicyProfile(fairness: FairnessModule): RuntimePolicyProfile {
  return fairness.createFairSchedulerRuntimePolicyProfile({
    getEditableValues: () => ({
      resourceLimits: {
        ws: {
          serverBufferedHighWaterBytes: 1_536,
          perClientOutputQueueMaxBytes: 8_192,
          perClientControlQueueMaxBytes: 2_048,
          outputCoalesceWindowMs: 4,
        },
      },
    }),
  });
}

test('PERF-BGSTAB-010 evidence validator rejects a self-consistent publication missing one trial schedule and sidecar', async () => {
  const fairness = await loadFairness();
  const runtimePolicyProfile = createRuntimePolicyProfile(fairness);
  const generated = fairness.createFairSchedulerDecisionArtifact({ ...input, runtimePolicyProfile });
  const rawArtifacts = structuredClone(generated.rawArtifacts) as Record<string, unknown> & {
    trialSchedules: unknown[];
  };
  const artifact = structuredClone(generated.artifact) as Record<string, unknown> & {
    rawEvidencePaths: unknown[];
    rawEvidenceDigest: string;
  };
  rawArtifacts.trialSchedules.pop();
  artifact.rawEvidencePaths.pop();
  artifact.rawEvidenceDigest = digest(rawArtifacts);

  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact,
    rawArtifacts,
    runtimePolicyProfile,
  }), { accepted: false, reason: 'raw-trial-coverage-mismatch' });
  assert.deepEqual(fairness.validateFairSchedulerTrialArtifacts({
    rawArtifacts,
    trialArtifacts: fairness.createFairSchedulerTrialArtifacts(rawArtifacts),
  }), { accepted: false, reason: 'trial-evidence-coverage-mismatch' });
});

test('PERF-BGSTAB-010 evidence validator rejects duplicate raw trial samples', async () => {
  const fairness = await loadFairness();
  const runtimePolicyProfile = createRuntimePolicyProfile(fairness);
  const generated = fairness.createFairSchedulerDecisionArtifact({ ...input, runtimePolicyProfile });
  const rawArtifacts = structuredClone(generated.rawArtifacts) as Record<string, unknown> & {
    samples: unknown[];
  };
  const artifact = structuredClone(generated.artifact) as Record<string, unknown> & {
    rawEvidenceDigest: string;
  };
  rawArtifacts.samples[1] = rawArtifacts.samples[0];
  artifact.rawEvidenceDigest = digest(rawArtifacts);

  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact,
    rawArtifacts,
    runtimePolicyProfile,
  }), { accepted: false, reason: 'raw-trial-coverage-mismatch' });
});

test('PERF-BGSTAB-010 publication directory read-back rejects serialized raw evidence corruption', async () => {
  const fairness = await loadFairness();
  const runtimePolicyProfile = createRuntimePolicyProfile(fairness);
  const artifactRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-readback-'));
  const outputPath = join(artifactRoot, 'fair-scheduler-decision.json');
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...input, outputPath, runtimePolicyProfile });
    assert.deepEqual(fairness.validateFairSchedulerPublicationDirectory({ artifactRoot }), {
      accepted: true,
      reason: 'fair-scheduler-publication-verified',
    });

    const publication = JSON.parse(await readFile(`${outputPath}.publication.json`, 'utf8')) as { rawPath: string };
    const rawPath = join(artifactRoot, publication.rawPath);
    const raw = JSON.parse(await readFile(rawPath, 'utf8')) as Record<string, unknown>;
    await writeFile(rawPath, `${canonicalJson({ ...raw, samples: [] })}\n`, 'utf8');
    assert.deepEqual(fairness.validateFairSchedulerPublicationDirectory({ artifactRoot }), {
      accepted: false,
      reason: 'raw-evidence-digest-mismatch',
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 root raw mirrors cannot invalidate the pointer-selected generation', async () => {
  const fairness = await loadFairness();
  const runtimePolicyProfile = createRuntimePolicyProfile(fairness);
  const artifactRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-root-mirror-'));
  const outputPath = join(artifactRoot, 'fair-scheduler-decision.json');
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...input, outputPath, runtimePolicyProfile });
    await writeFile(`${outputPath}.raw.json`, '{"obsolete":true}\n', 'utf8');
    assert.deepEqual(fairness.validateFairSchedulerPublicationDirectory({ artifactRoot }), {
      accepted: true,
      reason: 'fair-scheduler-publication-verified',
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 writer refuses a corrupt existing generation without moving its canonical pointer', async () => {
  const fairness = await loadFairness();
  const runtimePolicyProfile = createRuntimePolicyProfile(fairness);
  const artifactRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-generation-collision-'));
  const outputPath = join(artifactRoot, 'fair-scheduler-decision.json');
  try {
    await fairness.writeFairSchedulerDecisionArtifact({ ...input, outputPath, runtimePolicyProfile });
    const pointerPath = `${outputPath}.publication.json`;
    const beforePointer = await readFile(pointerPath, 'utf8');
    const publication = JSON.parse(beforePointer) as { artifactPath: string };
    await writeFile(join(artifactRoot, publication.artifactPath), '{"corrupt":true}\n', 'utf8');

    await assert.rejects(
      fairness.writeFairSchedulerDecisionArtifact({ ...input, outputPath, runtimePolicyProfile }),
      /existing fair scheduler generation is invalid/u,
    );
    assert.equal(await readFile(pointerPath, 'utf8'), beforePointer);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 publication validation rejects a fixed pointer symlink that escapes its root', async () => {
  const fairness = await loadFairness();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-pointer-root-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-pointer-outside-'));
  const pointerPath = join(artifactRoot, 'fair-scheduler-decision.json.publication.json');
  try {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(outsideRoot, 'publication.json'), 'not-json\n', 'utf8');
    try {
      await symlink(join(outsideRoot, 'publication.json'), pointerPath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        await symlink(outsideRoot, pointerPath, 'junction');
      } else {
        throw error;
      }
    }
    assert.deepEqual(fairness.validateFairSchedulerPublicationDirectory({ artifactRoot }), {
      accepted: false,
      reason: 'publication-reference-invalid',
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
