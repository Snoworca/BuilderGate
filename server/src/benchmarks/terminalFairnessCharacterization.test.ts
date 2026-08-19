import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { config } from '../utils/config.js';
import { createWsTransportMessage } from '../ws/wsSendPolicy.js';

type FairnessModule = {
  createFairSchedulerDecisionArtifact(input: {
    clients: readonly number[];
    wanLatencyMs: number;
    wanJitterMs: number;
    wanLossPercent: number;
    seed: number;
    repeats: number;
    samples: number;
  }): {
    artifact: {
      schemaVersion: string;
      workload: unknown;
      prng: unknown;
      rawEvidencePaths: string[];
      aggregation: { laneMetrics: Record<string, unknown> };
      sourceDigest: string;
      policy: unknown;
      policyHash: string;
      configHash: string;
      [key: string]: unknown;
    };
    rawArtifacts: {
      execution: string;
      samples: Array<{
        clientCount: number;
        trial: number;
        baseline: { throughputBytesPerSecond: number };
        orcaHoldBypass: { throughputBytesPerSecond: number };
        candidate: {
          throughputBytesPerSecond: number;
          ackFaultRejectionCount: number;
          creditExhaustionObserved: boolean;
        };
        ackFault: string;
      }>;
      trialSchedules: Array<{ clientCount: number; trial: number }>;
      [key: string]: unknown;
    };
  };
  createFairSchedulerRuntimePolicyProfile(runtimeConfig: {
    getEditableValues(): { resourceLimits: { ws: {
      serverBufferedHighWaterBytes: number;
      perClientOutputQueueMaxBytes: number;
      perClientControlQueueMaxBytes: number;
      outputCoalesceWindowMs: number;
    } } };
  }): {
    policyHash: string;
    profileHash: string;
    [key: string]: unknown;
  };
  validateFairSchedulerDecisionArtifact(input: {
    artifact: unknown;
    rawArtifacts: unknown;
  }): { accepted: boolean; reason: string };
  validateFairSchedulerTrialArtifacts(input: {
    rawArtifacts: unknown;
    trialArtifacts: readonly unknown[];
  }): { accepted: boolean; reason: string };
  writeFairSchedulerDecisionArtifact(input: {
    outputPath: string;
    clients: readonly number[];
    wanLatencyMs: number;
    wanJitterMs: number;
    wanLossPercent: number;
    seed: number;
    repeats: number;
    samples: number;
    afterPublicationLockAcquired?: () => Promise<void>;
  }): Promise<{ artifactPath: string; digest: string }>;
  publishFairSchedulerAuthorityGeneration?: (input: {
    clients: readonly number[];
    wanLatencyMs: number;
    wanJitterMs: number;
    wanLossPercent: number;
    seed: number;
    repeats: number;
    samples: number;
    authorityRoot: string;
    beforeCurrentPointerPromotion?: () => Promise<void>;
  }) => Promise<{
    generationId: string;
    generationRoot: string;
    currentPointerPath: string;
  }>;
  createFairSchedulerEvidenceAuthorityResolver?: (input?: { repositoryRoot?: string }) => {
    validate(input: { expectedPolicyDigest: string }): {
      accepted: boolean;
      reason: string;
    };
  };
  getFairSchedulerBenchmarkSourceDigest(): string;
  getFairSchedulerBenchmarkPolicy(): unknown;
  getFairSchedulerBenchmarkContract(): {
    policy: unknown;
    policyHash: string;
    configHash: string;
  };
};

async function loadFairness(signature: string): Promise<FairnessModule> {
  try {
    return await import('./terminalFairnessCharacterization.js') as unknown as FairnessModule;
  } catch (error) {
    throw new Error(signature, { cause: error });
  }
}

const profile = {
  clients: [1, 2, 8],
  wanLatencyMs: 150,
  wanJitterMs: 20,
  wanLossPercent: 0,
  seed: 20260723,
  repeats: 5,
  samples: 30,
} as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawEvidenceDigest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value), 'utf8').digest('hex');
}

function findDistinctWindowsShortPath(directory: string): string | undefined {
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

test('PERF-BGSTAB-010 artifact source digest covers runtime delivery and admission gates', () => {
  const source = readFileSync(new URL('./terminalFairnessCharacterization.ts', import.meta.url), 'utf8');
  assert.match(source, /'src\/ws\/WsRouter\.ts'/u);
  assert.match(source, /'src\/services\/TerminalResourcePolicyCanary\.ts'/u);
  assert.match(source, /resolveFairTerminalDeliveryPolicy/u);
  // 소스 텍스트 매칭만으로는 시그니처 변경을 잡지 못한다. 실제 심볼을 가져와 이름을 파생시키고
  // (개명은 컴파일 에러로 드러난다), 벤치마크의 bytes 회계가 의존하는 계약을 직접 호출해 고정한다.
  assert.match(source, new RegExp(`\\b${createWsTransportMessage.name}\\b`, 'u'));
  const wire = '{"type":"output","sessionId":"session-a","data":"chunk"'
    + ',"connectionEpoch":"epoch-a","deliverySeq":1,"deliveryKind":"output"}';
  assert.equal(
    createWsTransportMessage({
      type: 'output',
      sessionId: 'session-a',
      data: 'chunk',
      connectionEpoch: 'epoch-a',
      deliverySeq: 1,
      deliveryKind: 'output',
    }).byteLength,
    Buffer.byteLength(wire, 'utf8'),
  );
});

test('PERF-BGSTAB-010 source provenance digest binds shared authority locator', async () => {
  const sourcePaths = [
    'src/benchmarks/terminalFairnessCharacterization.ts',
    'src/benchmarks/fairSchedulerAuthorityLocator.ts',
    'src/ws/wsSendPolicy.ts',
    'src/ws/WsRouter.ts',
    'src/services/TerminalResourcePolicy.ts',
    'src/services/TerminalResourcePolicyCanary.ts',
  ];
  const serverRoot = new URL('../../', import.meta.url);
  const source = readFileSync(new URL('./terminalFairnessCharacterization.ts', import.meta.url), 'utf8');
  const writer = readFileSync(new URL('../../tools/write-fair-scheduler-source-provenance.mjs', import.meta.url), 'utf8');
  const contents = sourcePaths.map(path => readFileSync(new URL(path, serverRoot), 'utf8'));
  const expectedDigest = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
  const driftedContents = [...contents];
  driftedContents[1] = `${driftedContents[1]}\n// locator-drift`;
  const driftedDigest = createHash('sha256').update(JSON.stringify(driftedContents)).digest('hex');
  const fairness = await loadFairness('source provenance must bind the shared authority locator');

  assert.match(source, /'src\/benchmarks\/fairSchedulerAuthorityLocator\.ts'/u);
  assert.match(writer, /'src\/benchmarks\/fairSchedulerAuthorityLocator\.ts'/u);
  assert.equal(fairness.getFairSchedulerBenchmarkSourceDigest(), expectedDigest);
  assert.notEqual(driftedDigest, expectedDigest);
});

test('PERF-BGSTAB-010 benchmark artifact records the same projected policy used by runtime admission', async () => {
  const fairness = await loadFairness('benchmark must expose its projected runtime policy contract');
  const generated = fairness.createFairSchedulerDecisionArtifact(profile).artifact;
  const contract = fairness.getFairSchedulerBenchmarkContract();
  assert.deepEqual(generated.policy, fairness.getFairSchedulerBenchmarkPolicy());
  assert.equal(generated.policyHash, contract.policyHash);
  assert.equal(generated.configHash, contract.configHash);
});


test('PERF-BGSTAB-010 published source digest is available to the runtime admission gate', async () => {
  const fairness = await loadFairness('runtime admission must read the benchmark source digest');
  const artifact = fairness.createFairSchedulerDecisionArtifact(profile).artifact;
  assert.equal(fairness.getFairSchedulerBenchmarkSourceDigest(), artifact.sourceDigest);
});

test('PERF-BGSTAB-010 source policy profile default admission uses current authority identity', async () => {
  const signature = 'PERF-BGSTAB-010 current source authority must bind the effective default RuntimeConfigStore WebSocket profile';
  const fairness = await loadFairness(signature);
  const runtimePolicyProfile = fairness.createFairSchedulerRuntimePolicyProfile(new RuntimeConfigStore(config));
  const authorityRoot = new URL('../../../docs/analysis/terminal-fairness-authority/', import.meta.url);
  const pointer = JSON.parse(await readFile(new URL('current.json', authorityRoot), 'utf8')) as {
    generation_id: string;
    publication_generation: string;
    decision_artifact: string;
    provenance_artifact: string;
  };
  const generationRoot = new URL(`generations/${pointer.generation_id}/`, authorityRoot);
  const decision = JSON.parse(await readFile(new URL(pointer.decision_artifact, generationRoot), 'utf8')) as {
    runtimePolicyProfile: unknown;
    policyHash: string;
  };
  const provenance = JSON.parse(await readFile(new URL(pointer.provenance_artifact, generationRoot), 'utf8')) as {
    policy_digest: string;
    publication_generation: string;
  };

  assert.deepEqual(decision.runtimePolicyProfile, runtimePolicyProfile, signature);
  assert.equal(decision.policyHash, runtimePolicyProfile.policyHash, signature);
  assert.equal(provenance.policy_digest, runtimePolicyProfile.policyHash, signature);
  assert.equal(provenance.publication_generation, pointer.publication_generation, signature);
  assert.equal(pointer.publication_generation, pointer.generation_id, signature);
});

test('PERF-BGSTAB-010 AC-2/AC-3 deterministic WAN fair-scheduler artifact contract', async () => {
  const signature = 'PERF-BGSTAB-010 AC-2/AC-3 fair scheduler benchmark 계약 부재 때문에 실패';
  const fairness = await loadFairness(signature);
  const first = fairness.createFairSchedulerDecisionArtifact(profile);
  const second = fairness.createFairSchedulerDecisionArtifact(profile);

  assert.deepEqual(first, second, signature);
  assert.equal(first.artifact.schemaVersion, 'fair-scheduler-decision/v1', signature);
  assert.deepEqual(first.artifact.baselines, ['fifo', 'orca-hold-bypass'], signature);
  assert.deepEqual(first.artifact.workload, {
    clients: [1, 2, 8],
    wan: { latencyMs: 150, jitterMs: 20, lossPercent: 0 },
    seed: 20260723,
    repeats: 5,
    samples: 30,
  }, signature);
  assert.deepEqual(first.artifact.prng, {
    algorithm: 'xorshift32',
    version: 1,
    rootSeed: 20260723,
    derivation: 'fnv1a-root-seed/trial/client/lane/fault',
  }, signature);
  assert.equal(Array.isArray(first.artifact.rawEvidencePaths), true, signature);
  assert.equal(first.artifact.rawEvidencePaths.length, 15, signature);
  assert.equal(Array.isArray(first.rawArtifacts.samples), true, signature);
  assert.equal(first.rawArtifacts.samples.length, 1_650, signature);
  assert.equal(first.rawArtifacts.execution, 'scheduler-execution', signature);
  assert.equal(first.rawArtifacts.samples.every(sample => (
    sample.baseline !== undefined
      && sample.orcaHoldBypass !== undefined
      && sample.candidate !== undefined
      && sample.candidate.ackFaultRejectionCount > 0
      && sample.candidate.creditExhaustionObserved
      && sample.ackFault !== 'none'
  )), true, signature);
  assert.equal((first.artifact as { aggregation?: Record<string, unknown> }).aggregation?.laneMetrics !== undefined, true, signature);
  assert.equal((first.artifact as { sourceDigest?: string }).sourceDigest?.length, 64, signature);
});

test('PERF-BGSTAB-010 AC-2 applies the same WAN and ACK-fault workload to FIFO, Orca hold/bypass, and DRR', async () => {
  const signature = 'PERF-BGSTAB-010 WAN and ACK-fault comparison must be symmetric across every strategy';
  const fairness = await loadFairness(signature);
  const lowLatency = fairness.createFairSchedulerDecisionArtifact({ ...profile, wanLatencyMs: 1 }).rawArtifacts.samples[0];
  const wanLatency = fairness.createFairSchedulerDecisionArtifact(profile).rawArtifacts.samples[0];

  assert.notEqual(lowLatency.candidate.throughputBytesPerSecond, wanLatency.candidate.throughputBytesPerSecond, signature);
  assert.notEqual(lowLatency.baseline.throughputBytesPerSecond, wanLatency.baseline.throughputBytesPerSecond, signature);
  assert.notEqual(lowLatency.orcaHoldBypass.throughputBytesPerSecond, wanLatency.orcaHoldBypass.throughputBytesPerSecond, signature);
});

test('PERF-BGSTAB-010 AC-3 measured artifact validator fails closed for tampering and accepts complete evidence', async () => {
  const signature = 'PERF-BGSTAB-010 AC-3 measured artifact validator 계약 부재 때문에 실패';
  const fairness = await loadFairness(signature);
  const generated = fairness.createFairSchedulerDecisionArtifact(profile);

  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact: { ...generated.artifact, sourceDigest: '0'.repeat(64) },
    rawArtifacts: generated.rawArtifacts,
  }), { accepted: false, reason: 'source-digest-mismatch' }, signature);
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact: { ...generated.artifact, policyHash: '0'.repeat(64) },
    rawArtifacts: generated.rawArtifacts,
  }), { accepted: false, reason: 'policy-hash-mismatch' }, signature);
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact: generated.artifact,
    rawArtifacts: { ...generated.rawArtifacts, samples: [] },
  }), { accepted: false, reason: 'raw-samples-missing' }, signature);
  const rawWithoutAckFaultEvidence = {
    ...generated.rawArtifacts,
    samples: generated.rawArtifacts.samples.map(sample => ({
      ...sample,
      candidate: {
        ...sample.candidate,
        ackFaultRejectionCount: 0,
        creditExhaustionObserved: false,
      },
    })),
  };
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact: { ...generated.artifact, rawEvidenceDigest: rawEvidenceDigest(rawWithoutAckFaultEvidence) },
    rawArtifacts: rawWithoutAckFaultEvidence,
  }), { accepted: false, reason: 'ack-fault-evidence-missing' }, signature);
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact(generated), {
    accepted: true,
    reason: 'decision-artifact-verified',
  }, signature);
});

test('PERF-BGSTAB-010 AC-3 validates every published trial sidecar against combined raw evidence', async () => {
  const signature = 'PERF-BGSTAB-010 trial sidecars must be bound to the combined raw evidence';
  const fairness = await loadFairness(signature);
  const generated = fairness.createFairSchedulerDecisionArtifact(profile);
  const trialArtifacts = generated.rawArtifacts.trialSchedules.map(schedule => ({
    schemaVersion: 'fair-scheduler-trial/v1',
    clientCount: schedule.clientCount,
    trial: schedule.trial,
    schedule,
    samples: generated.rawArtifacts.samples.filter(sample => (
      sample.clientCount === schedule.clientCount && sample.trial === schedule.trial
    )),
  }));

  assert.deepEqual(fairness.validateFairSchedulerTrialArtifacts({
    rawArtifacts: generated.rawArtifacts,
    trialArtifacts,
  }), { accepted: true, reason: 'trial-evidence-verified' }, signature);
  assert.deepEqual(fairness.validateFairSchedulerTrialArtifacts({
    rawArtifacts: generated.rawArtifacts,
    trialArtifacts: [{ ...trialArtifacts[0], samples: [] }, ...trialArtifacts.slice(1)],
  }), { accepted: false, reason: 'trial-evidence-mismatch' }, signature);
});

test('PERF-BGSTAB-010 AC-2/AC-3 registers every measured delivery bound and rejects a changed threshold contract', async () => {
  const signature = 'PERF-BGSTAB-010 모든 측정 지표의 임계값 계약이 필요합니다';
  const fairness = await loadFairness(signature);
  const generated = fairness.createFairSchedulerDecisionArtifact(profile);
  const thresholds = generated.artifact.thresholds as Record<string, unknown>;

  assert.deepEqual(Object.keys(thresholds).sort(), [
    'aggregateThroughputBytesPerSecond',
    'controlLatencyMs',
    'eligibleLaneCompleteMs',
    'eligibleLaneMaxNoServiceIntervalMs',
    'eligibleLaneServiceMs',
    'peakApplicationQueuedBytes',
    'peakSocketQueuedBytes',
  ], signature);
  assert.equal(Object.values(thresholds).every(threshold => (
    typeof threshold === 'object'
      && threshold !== null
      && typeof (threshold as Record<string, unknown>).baselineRegressionTolerance === 'number'
  )), true, signature);
  assert.deepEqual(fairness.validateFairSchedulerDecisionArtifact({
    artifact: {
      ...generated.artifact,
      thresholds: { ...thresholds, controlLatencyMs: { exact: 31, tolerance: 0, source: 'tampered' } },
    },
    rawArtifacts: generated.rawArtifacts,
  }), { accepted: false, reason: 'threshold-contract-mismatch' }, signature);
});

test('PERF-BGSTAB-010 AC-3 staged fair-scheduler artifact publish contract', async () => {
  const signature = 'PERF-BGSTAB-010 AC-3 staged fair scheduler artifact publish 계약 부재 때문에 실패';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-fairness-'));
  const outputPath = join(directory, 'fair-scheduler-decision.json');
  try {
    const written = await fairness.writeFairSchedulerDecisionArtifact({ ...profile, outputPath });
    const artifact = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>;
    assert.equal(written.artifactPath, outputPath, signature);
    assert.equal(written.digest.length, 64, signature);
    assert.equal(artifact.stagingValidated, true, signature);
    assert.equal(artifact.digest, written.digest, signature);
    const publication = JSON.parse(await readFile(`${outputPath}.publication.json`, 'utf8')) as Record<string, unknown>;
    assert.equal(publication.schemaVersion, 'fair-scheduler-publication/v1', signature);
    assert.equal(publication.digest, written.digest, signature);
    assert.match(publication.generationId as string, /^[a-f0-9]{64}$/u, signature);
    assert.equal(publication.artifactPath,
      `fair-scheduler-publications/${publication.generationId}/fair-scheduler-decision.json`, signature);
    assert.equal(publication.rawPath,
      `fair-scheduler-publications/${publication.generationId}/fair-scheduler-decision.raw.json`, signature);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 decision writer shares its publish lock across an NTFS 8.3 output-root alias', async (t) => {
  const signature = 'PERF-BGSTAB-010 writer must serialize NTFS 8.3 aliases';
  const fairness = await loadFairness(signature);
  const directory = await mkdtemp(join(process.cwd(), '.fair-scheduler-short-path-'));
  const aliasDirectory = findDistinctWindowsShortPath(directory);
  if (!aliasDirectory) {
    t.skip('NTFS 8.3 short path is unavailable for this test directory');
    await rm(directory, { recursive: true, force: true });
    return;
  }
  const outputPath = join(directory, 'fair-scheduler-decision.json');
  const aliasOutputPath = join(aliasDirectory, 'fair-scheduler-decision.json');
  let signalAtLock!: () => void;
  const atLock = new Promise<void>(resolve => { signalAtLock = resolve; });
  let releaseFirstWriter!: () => void;
  const releaseGate = new Promise<void>(resolve => { releaseFirstWriter = resolve; });
  let firstWriter: Promise<unknown> | undefined;
  try {
    firstWriter = fairness.writeFairSchedulerDecisionArtifact({
      ...profile,
      outputPath,
      afterPublicationLockAcquired: async () => {
        signalAtLock();
        await releaseGate;
      },
    });
    await atLock;
    await assert.rejects(
      fairness.writeFairSchedulerDecisionArtifact({ ...profile, outputPath: aliasOutputPath }),
      /publication lock exists/u,
      signature,
    );
  } finally {
    releaseFirstWriter();
    await firstWriter?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 canonical authority publisher creates current immutable generation', async () => {
  const signature = 'PERF-BGSTAB-010 canonical authority publisher contract is absent';
  const fairness = await loadFairness(signature);
  const publish = fairness.publishFairSchedulerAuthorityGeneration;
  assert.equal(typeof publish, 'function', signature);
  const authorityRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-authority-publish-'));
  const currentPointerPath = join(authorityRoot, 'current.json');
  const priorPointerBytes = '{"generation_id":"prior"}\n';
  try {
    await writeFile(currentPointerPath, priorPointerBytes, 'utf8');
    await assert.rejects(
      publish!({
        ...profile,
        authorityRoot,
        beforeCurrentPointerPromotion: async () => {
          assert.equal(await readFile(currentPointerPath, 'utf8'), priorPointerBytes,
            `${signature}: promotion hook must observe the prior pointer bytes before it throws`);
          throw new Error('stop before current pointer promotion');
        },
      }),
      /stop before current pointer promotion/u,
      signature,
    );
    assert.equal(await readFile(currentPointerPath, 'utf8'), priorPointerBytes,
      `${signature}: failed pre-promotion hook must leave the prior pointer bytes untouched`);

    const absentPointerAuthorityRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-authority-empty-'));
    const absentPointerPath = join(absentPointerAuthorityRoot, 'current.json');
    try {
      await assert.rejects(
        publish!({
          ...profile,
          authorityRoot: absentPointerAuthorityRoot,
          beforeCurrentPointerPromotion: async () => {
            assert.equal(existsSync(absentPointerPath), false,
              `${signature}: promotion hook must observe no pointer when no prior pointer exists`);
            throw new Error('stop absent pointer promotion');
          },
        }),
        /stop absent pointer promotion/u,
        signature,
      );
      assert.equal(existsSync(absentPointerPath), false,
        `${signature}: a failed first promotion must not create a current pointer`);
    } finally {
      await rm(absentPointerAuthorityRoot, { recursive: true, force: true });
    }

    const published = await publish!({ ...profile, authorityRoot });
    const current = JSON.parse(await readFile(currentPointerPath, 'utf8')) as Record<string, unknown>;
    assert.match(current.generation_id as string, /^[a-f0-9]{64}$/u, signature);
    assert.equal(published.generationId, current.generation_id, signature);
    assert.equal(published.currentPointerPath, currentPointerPath, signature);
    assert.equal(published.generationRoot, join(authorityRoot, 'generations', current.generation_id as string), signature);
    assert.equal(existsSync(join(published.generationRoot, 'fair-scheduler-decision.json')), true, signature);
    assert.equal(existsSync(join(published.generationRoot, 'provenance.json')), true, signature);
    assert.equal(existsSync(join(published.generationRoot, 'raw', 'manifest.json')), true, signature);
    assert.equal(existsSync(join(authorityRoot, 'fair-scheduler-decision.json')), false,
      `${signature}: publisher must not write the legacy flat decision artifact at authority root`);
    assert.equal(existsSync(join(authorityRoot, 'fair-scheduler-decision.raw.json')), false,
      `${signature}: publisher must not write the legacy flat raw evidence at authority root`);

    const immutableSnapshot = await Promise.all([
      readFile(join(published.generationRoot, 'fair-scheduler-decision.json'), 'utf8'),
      readFile(join(published.generationRoot, 'provenance.json'), 'utf8'),
      readFile(join(published.generationRoot, 'raw', 'manifest.json'), 'utf8'),
    ]);
    const secondProfile = { ...profile, seed: profile.seed + 1 };
    const repeated = await publish!({ ...secondProfile, authorityRoot });
    assert.deepEqual(await Promise.all([
      readFile(join(published.generationRoot, 'fair-scheduler-decision.json'), 'utf8'),
      readFile(join(published.generationRoot, 'provenance.json'), 'utf8'),
      readFile(join(published.generationRoot, 'raw', 'manifest.json'), 'utf8'),
    ]), immutableSnapshot, `${signature}: repeat publication must never overwrite an immutable generation`);
    assert.notEqual(repeated.generationId, published.generationId,
      `${signature}: materially different benchmark input must publish a distinct immutable generation`);
    assert.notEqual(repeated.generationRoot, published.generationRoot,
      `${signature}: distinct immutable generations must have distinct roots`);
    const repeatedSnapshot = await Promise.all([
      readFile(join(repeated.generationRoot, 'fair-scheduler-decision.json'), 'utf8'),
      readFile(join(repeated.generationRoot, 'provenance.json'), 'utf8'),
      readFile(join(repeated.generationRoot, 'raw', 'manifest.json'), 'utf8'),
    ]);
    assert.equal(existsSync(join(repeated.generationRoot, 'fair-scheduler-decision.json')), true,
      `${signature}: the second immutable generation must be preserved`);
    assert.deepEqual(await Promise.all([
      readFile(join(repeated.generationRoot, 'fair-scheduler-decision.json'), 'utf8'),
      readFile(join(repeated.generationRoot, 'provenance.json'), 'utf8'),
      readFile(join(repeated.generationRoot, 'raw', 'manifest.json'), 'utf8'),
    ]), repeatedSnapshot, `${signature}: the second immutable generation must remain preserved`);
    const promotedCurrent = JSON.parse(await readFile(currentPointerPath, 'utf8')) as Record<string, unknown>;
    assert.equal(promotedCurrent.generation_id, repeated.generationId,
      `${signature}: the second immutable generation must become the current authority`);
  } finally {
    await rm(authorityRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 source canonical bundle validates pointer provenance raw SHA and 1-2-8 decision', async () => {
  const signature = 'PERF-BGSTAB-010 canonical authority bundle publication contract is absent';
  const fairness = await loadFairness(signature);
  const publish = fairness.publishFairSchedulerAuthorityGeneration;
  const createResolver = fairness.createFairSchedulerEvidenceAuthorityResolver;
  assert.equal(typeof publish, 'function', `${signature}: publisher export is required`);
  assert.equal(typeof createResolver, 'function', `${signature}: canonical resolver export is required`);
  if (!publish || !createResolver) return;

  const repositoryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-authority-repository-'));
  const authorityRoot = join(repositoryRoot, 'docs', 'analysis', 'terminal-fairness-authority');
  const legacyOutputPath = join(repositoryRoot, 'legacy-fair-scheduler-decision.json');
  try {
    const published = await publish({ ...profile, authorityRoot });
    const pointerPath = join(authorityRoot, 'current.json');
    const decisionPath = join(published.generationRoot, 'fair-scheduler-decision.json');
    const provenancePath = join(published.generationRoot, 'provenance.json');
    const rawManifestPath = join(published.generationRoot, 'raw', 'manifest.json');
    const pointerBytes = await readFile(pointerPath, 'utf8');
    const decisionBytes = await readFile(decisionPath, 'utf8');
    const provenanceBytes = await readFile(provenancePath, 'utf8');
    const rawManifestBytes = await readFile(rawManifestPath, 'utf8');
    const pointer = JSON.parse(pointerBytes) as Record<string, unknown>;
    const decision = JSON.parse(decisionBytes) as Record<string, unknown>;
    const provenance = JSON.parse(provenanceBytes) as Record<string, unknown>;
    const rawManifest = JSON.parse(rawManifestBytes) as Record<string, unknown>;
    const rawEntries = rawManifest.entries as Array<Record<string, unknown>>;
    const trialInventory = provenance.trial_inventory as Array<Record<string, unknown>>;

    assert.deepEqual(pointer, {
      schema_version: 'fair-scheduler-current-authority/v1',
      generation_id: published.generationId,
      publication_generation: pointer.publication_generation,
      decision_artifact: 'fair-scheduler-decision.json',
      decision_sha256: rawEvidenceDigest(decisionBytes),
      provenance_artifact: 'provenance.json',
      provenance_sha256: rawEvidenceDigest(provenanceBytes),
      raw_root: 'raw/',
      raw_manifest_sha256: rawEvidenceDigest(rawManifestBytes),
    }, `${signature}: pointer must bind the exact immutable bundle bytes`);
    assert.equal(provenance.schema_version, 'fair-scheduler-source-provenance/v1', signature);
    assert.equal(provenance.generation_id, published.generationId, signature);
    assert.equal(provenance.canonical_locator,
      'docs/analysis/terminal-fairness-authority/current.json', signature);
    assert.equal(provenance.publication_generation, pointer.publication_generation, signature);
    assert.equal(provenance.decision_path, 'fair-scheduler-decision.json', signature);
    assert.equal(provenance.decision_sha256, rawEvidenceDigest(decisionBytes), signature);
    assert.equal(provenance.provenance_path, 'provenance.json', signature);
    assert.equal(provenance.raw_root, 'raw/', signature);
    assert.equal(provenance.raw_manifest_path, 'raw/manifest.json', signature);
    assert.equal(provenance.raw_manifest_sha256, rawEvidenceDigest(rawManifestBytes), signature);
    assert.equal(typeof provenance.policy_digest, 'string', signature);
    assert.match(provenance.policy_digest as string, /^[a-f0-9]{64}$/u, signature);
    assert.equal(rawManifest.schema_version, 'fair-scheduler-raw-manifest/v1', signature);
    assert.equal(rawManifest.generation_id, published.generationId, signature);
    assert.equal(Array.isArray(rawEntries), true, `${signature}: raw manifest must enumerate every raw file`);
    assert.equal(rawEntries.length > 0, true, `${signature}: raw manifest cannot be empty`);
    assert.equal(Array.isArray(trialInventory), true, `${signature}: provenance must retain trial inventory`);
    assert.deepEqual(
      trialInventory.map(entry => entry.path).sort(),
      profile.clients.flatMap(clientCount => Array.from({ length: profile.repeats }, (_, trial) => (
        `raw/fair-scheduler-raw/clients-${clientCount}/trial-${trial}.json`
      ))).sort(),
      `${signature}: provenance must retain the complete 1/2/8-client trial inventory`,
    );
    for (const entry of rawEntries) {
      assert.equal(typeof entry.path, 'string', `${signature}: raw manifest entry path is required`);
      assert.match(entry.path as string, /^raw\//u, `${signature}: raw entry must stay below raw/`);
      assert.equal(typeof entry.sha256, 'string', `${signature}: raw manifest entry SHA-256 is required`);
      assert.match(entry.sha256 as string, /^[a-f0-9]{64}$/u, signature);
      const rawPath = join(published.generationRoot, ...(entry.path as string).split('/'));
      assert.equal(rawEvidenceDigest(await readFile(rawPath, 'utf8')), entry.sha256,
        `${signature}: raw manifest SHA-256 must bind ${entry.path as string}`);
    }
    for (const entry of trialInventory) {
      assert.equal(typeof entry.path, 'string', `${signature}: trial inventory path is required`);
      assert.equal(typeof entry.sha256, 'string', `${signature}: trial inventory SHA-256 is required`);
      const trialPath = join(published.generationRoot, ...(entry.path as string).split('/'));
      assert.equal(rawEvidenceDigest(await readFile(trialPath, 'utf8')), entry.sha256,
        `${signature}: trial inventory SHA-256 must bind ${entry.path as string}`);
    }
    const expectedGenerationId = rawEvidenceDigest({
      schema_version: pointer.schema_version,
      decision_sha256: rawEvidenceDigest(decisionBytes),
      raw_entries_digest: rawEvidenceDigest(rawEntries),
      policy_digest: provenance.policy_digest,
      trial_inventory: trialInventory,
    });
    assert.equal(pointer.generation_id, expectedGenerationId,
      `${signature}: immutable generation id must be independently JCS-derived`);

    assert.equal(decision.schemaVersion, 'fair-scheduler-decision/v1', signature);
    assert.deepEqual((decision.workload as Record<string, unknown>).clients, [1, 2, 8],
      `${signature}: decision must cover the registered 1/2/8-client workload`);
    assert.equal(decision.rawSampleCount,
      profile.clients.reduce((total, clientCount) => total + clientCount * profile.repeats * profile.samples, 0),
      `${signature}: decision must account for every 1/2/8-client sample`);
    assert.deepEqual(Object.keys(decision.thresholds as Record<string, unknown>).sort(), [
      'aggregateThroughputBytesPerSecond',
      'controlLatencyMs',
      'eligibleLaneCompleteMs',
      'eligibleLaneMaxNoServiceIntervalMs',
      'eligibleLaneServiceMs',
      'peakApplicationQueuedBytes',
      'peakSocketQueuedBytes',
    ], `${signature}: decision must preserve every registered threshold`);
    assert.equal(decision.allRegisteredThresholdsPassed, true,
      `${signature}: decision must record the all-threshold acceptance calculation`);
    assert.equal(decision.hasUnboundedEligibleLaneStarvation, false,
      `${signature}: decision must record the bounded eligible-lane result`);
    assert.equal(decision.accepted, true, `${signature}: validated candidate decision must be accepted`);
    assert.equal(decision.promotionAllowed, true, `${signature}: accepted decision must permit promotion`);
    assert.equal(decision.validatorVerdict, 'accept', `${signature}: validator verdict must be recorded`);
    assert.equal(decision.reason, 'all-registered-thresholds-passed', signature);

    const resolver = createResolver({ repositoryRoot });
    assert.deepEqual(resolver.validate({ expectedPolicyDigest: provenance.policy_digest as string }), {
      accepted: true,
      evidenceRoot: published.generationRoot,
      generationId: published.generationId,
      locatorPath: pointerPath,
      logicalLocator: 'docs/analysis/terminal-fairness-authority/current.json',
      publicationGeneration: pointer.publication_generation,
      reason: 'authority-locator-verified',
    }, `${signature}: source resolver must accept the published canonical bundle`);

    await writeFile(pointerPath, '{', 'utf8');
    assert.deepEqual(resolver.validate({ expectedPolicyDigest: provenance.policy_digest as string }), {
      accepted: false,
      reason: 'authority-pointer-invalid-json',
    }, `${signature}: malformed current pointer must fail closed`);
    await writeFile(pointerPath, pointerBytes, 'utf8');
    await writeFile(provenancePath, `${provenanceBytes}\n`, 'utf8');
    assert.deepEqual(resolver.validate({ expectedPolicyDigest: provenance.policy_digest as string }), {
      accepted: false,
      reason: 'authority-provenance-sha256-mismatch',
    }, `${signature}: modified provenance bytes must fail closed`);
    await writeFile(provenancePath, provenanceBytes, 'utf8');
    await writeFile(rawManifestPath, `${rawManifestBytes}\n`, 'utf8');
    assert.deepEqual(resolver.validate({ expectedPolicyDigest: provenance.policy_digest as string }), {
      accepted: false,
      reason: 'authority-raw-manifest-sha256-mismatch',
    }, `${signature}: modified raw manifest bytes must fail closed`);
    await writeFile(rawManifestPath, rawManifestBytes, 'utf8');
    const firstRawEntry = rawEntries[0];
    const firstRawPath = join(published.generationRoot, ...(firstRawEntry.path as string).split('/'));
    const firstRawBytes = await readFile(firstRawPath, 'utf8');
    await writeFile(firstRawPath, `${firstRawBytes}\n`, 'utf8');
    assert.deepEqual(resolver.validate({ expectedPolicyDigest: provenance.policy_digest as string }), {
      accepted: false,
      reason: 'authority-raw-entry-sha256-mismatch',
    }, `${signature}: modified raw evidence bytes must fail closed`);
    await writeFile(firstRawPath, firstRawBytes, 'utf8');

    const legacyWritten = await fairness.writeFairSchedulerDecisionArtifact({ ...profile, outputPath: legacyOutputPath });
    assert.deepEqual(legacyWritten.artifactPath, legacyOutputPath,
      `${signature}: legacy decision writer API must retain its requested output path`);
    assert.equal(existsSync(legacyOutputPath), true,
      `${signature}: legacy decision writer must retain its flat output behavior`);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
