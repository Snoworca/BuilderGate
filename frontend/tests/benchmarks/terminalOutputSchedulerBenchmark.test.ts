import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type {
  TerminalOutputSchedulerPairedBenchmarkInput,
  TerminalOutputSchedulerPairedRawSample,
  TerminalOutputSchedulerPairedBenchmarkResult,
} from './terminalNoRenderFixture.ts';
import {
  createWave1BoundaryCorpus,
  createWave1MixedCorpus,
  SEGMENTED_CANDIDATE_IMPLEMENTATION,
  WAVE1_BASELINE_IMPLEMENTATION,
  WAVE1_BOUNDARY_CORPUS,
  WAVE1_MIXED_CORPUS,
  WAVE1_PAIRED_WORKLOAD,
  WAVE1_SCHEDULER_BENCHMARK_MANIFEST,
} from './terminalNoRenderFixtureEvidence.ts';

const AC9_RED_SIGNATURE = 'NO_RENDER paired benchmark RED 계약 RED AC-9: Wave-1 동일 seed·warm-up·trial manifest에서 before/post digest, bytes, invocation, encode/allocation counter와 paired bootstrap CI gate가 없으면 실패하는 benchmark tests를 추가한다. 두 test file을 독립 실행해 각 RED failure signature를 보존한다.';

type FixtureModuleWithPairedRunner = typeof import('./terminalNoRenderFixture.ts') & {
  runPairedTerminalOutputSchedulerBenchmark?: (
    input: TerminalOutputSchedulerPairedBenchmarkInput,
  ) => Promise<TerminalOutputSchedulerPairedBenchmarkResult>;
};

function digestNormalizedSource(source: string | Buffer): `sha256:${string}` {
  const normalized = source.toString().replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortJsonValue(value)), 'utf8')
    .digest('hex')}`;
}

function assertFrozenImplementationSources(): `sha256:${string}` {
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const baselineSource = execFileSync(
    'git',
    [
      'show',
      `${WAVE1_BASELINE_IMPLEMENTATION.sourceRevision}:${WAVE1_BASELINE_IMPLEMENTATION.sourcePath}`,
    ],
    { cwd: repositoryRoot },
  );
  const candidateSource = readFileSync(
    resolve(repositoryRoot, SEGMENTED_CANDIDATE_IMPLEMENTATION.sourcePath),
  );

  assert.equal(digestNormalizedSource(baselineSource), WAVE1_BASELINE_IMPLEMENTATION.sourceDigest);
  assert.equal(digestNormalizedSource(candidateSource), SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest);
  assert.notEqual(
    WAVE1_BASELINE_IMPLEMENTATION.sourceDigest,
    SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
  );
  assert.notEqual(
    WAVE1_BASELINE_IMPLEMENTATION.implementationId,
    SEGMENTED_CANDIDATE_IMPLEMENTATION.implementationId,
  );
  const executableSource = transpileModule(baselineSource.toString('utf8').replace(/\r\n/g, '\n'), {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
    },
  }).outputText;
  return `sha256:${createHash('sha256').update(executableSource, 'utf8').digest('hex')}`;
}

function percentile95(values: number[]): number {
  assert.ok(values.length > 0, 'p95 requires at least one measurement');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pairedBootstrapP95UpperDelta(
  samples: TerminalOutputSchedulerPairedRawSample[],
): number {
  assert.ok(samples.length > 0, 'paired bootstrap requires measurement pairs');
  const random = createSeededRandom(WAVE1_SCHEDULER_BENCHMARK_MANIFEST.randomSeed);
  const deltas: number[] = [];
  for (
    let iteration = 0;
    iteration < WAVE1_SCHEDULER_BENCHMARK_MANIFEST.bootstrapIterations;
    iteration += 1
  ) {
    const baseline: number[] = [];
    const candidate: number[] = [];
    for (let pair = 0; pair < samples.length; pair += 1) {
      const sampled = samples[Math.floor(random() * samples.length)];
      baseline.push(sampled.baselineElapsedMs);
      candidate.push(sampled.candidateElapsedMs);
    }
    deltas.push(percentile95(candidate) - percentile95(baseline));
  }
  return percentile95(deltas);
}

/** @req PERF-BGSTAB-009 */
test('NO_RENDER paired benchmark RED 계약 — AC-9', async () => {
  assert.deepEqual(WAVE1_SCHEDULER_BENCHMARK_MANIFEST, {
    randomSeed: 7008,
    warmupIterations: 1,
    trialCount: 3,
    trialDurationMs: 250,
    bootstrapIterations: 512,
    confidenceLevel: 0.95,
    regressionToleranceRatio: 0.05,
    toleranceClassification: 'measurement-noise-regression-tolerance',
    productSlo: false,
  });
  assert.deepEqual(WAVE1_BASELINE_IMPLEMENTATION, {
    role: 'baseline',
    implementationId: 'wave1-string-scheduler-reference-v1',
    sourcePath: 'frontend/src/utils/terminalOutputScheduler.ts',
    sourceRevision: 'ca111fef3b5a5a25d3aa488415c929e90ade46fd',
    sourceDigest: 'sha256:dc1edf2acaf16f57b6e517fb1499cd67e579508d12238b3a561aaada647ac1c3',
    frozen: true,
  });
  assert.deepEqual(SEGMENTED_CANDIDATE_IMPLEMENTATION, {
    role: 'candidate',
    implementationId: 'wave2-integrated-segmented-byte-deque-v2',
    sourcePath: 'frontend/src/utils/terminalOutputScheduler.ts',
    sourceRevision: 'S4-C4@dfca40cf506dcbc60a170a7f3ca4fbe9f426b9d9-worktree',
    sourceDigest: 'sha256:a1e88cf04e689f38c1a734b9795a93fafae8dbb71299c583f4398e4762fcb3e6',
    frozen: true,
  });
  const frozenBaselineExecutableDigest = assertFrozenImplementationSources();
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const artifactPath = resolve(
    repositoryRoot,
    'docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave2-hotpath/scheduler-benchmark.json',
  );
  const artifactBeforeRun = existsSync(artifactPath)
    ? readFileSync(artifactPath, 'utf8')
    : null;

  const fixtureModule = await import('./terminalNoRenderFixture.ts') as FixtureModuleWithPairedRunner;
  assert.equal(
    typeof fixtureModule.runPairedTerminalOutputSchedulerBenchmark,
    'function',
    AC9_RED_SIGNATURE,
  );
  const result = await fixtureModule.runPairedTerminalOutputSchedulerBenchmark({
    manifest: WAVE1_SCHEDULER_BENCHMARK_MANIFEST,
    mixedIngress: createWave1MixedCorpus(),
    boundaryIngress: createWave1BoundaryCorpus(),
  });

  assert.deepEqual(result.manifest, WAVE1_SCHEDULER_BENCHMARK_MANIFEST);
  assert.deepEqual(result.provenance.baseline, WAVE1_BASELINE_IMPLEMENTATION);
  assert.deepEqual(result.provenance.candidate, SEGMENTED_CANDIDATE_IMPLEMENTATION);
  assert.deepEqual(result.provenance.execution, {
    baseline: {
      loader: 'git-show-typescript-data-url',
      derivedFromSourceDigest: WAVE1_BASELINE_IMPLEMENTATION.sourceDigest,
      executableDigest: frozenBaselineExecutableDigest,
      timingModule: 'native-text-encoder',
      instrumentationModule: 'probed-text-encoder',
    },
    candidate: {
      loader: 'node-strip-types-module-import',
      derivedFromSourceDigest: SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
      executableDigest: SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
      timingModule: 'production-default-text-encoder',
      instrumentationModule: 'injected-probed-text-encoder',
    },
  });
  assert.ok(result.provenance.runId.length > 0);
  assert.equal(result.exactGates.outputDigestParity, true);
  assert.equal(result.exactGates.mixedByteLength, WAVE1_MIXED_CORPUS.byteLength);
  assert.equal(result.exactGates.mixedControlInvocations, WAVE1_MIXED_CORPUS.controlInvocations);
  assert.equal(
    result.exactGates.mixedObservationInvocations,
    WAVE1_MIXED_CORPUS.observationInvocations,
  );
  assert.equal(result.exactGates.boundaryByteLength, WAVE1_BOUNDARY_CORPUS.byteLength);
  assert.equal(
    result.exactGates.boundaryControlInvocations,
    WAVE1_BOUNDARY_CORPUS.controlInvocations,
  );
  assert.equal(
    result.exactGates.boundaryObservationInvocations,
    WAVE1_BOUNDARY_CORPUS.observationInvocations,
  );
  assert.deepEqual(result.provenance.calibration, {
    implementationId: WAVE1_BASELINE_IMPLEMENTATION.implementationId,
    targetDurationMs: 250,
    elapsedMs: result.provenance.calibration.elapsedMs,
    operationsPerTrial: result.provenance.calibration.operationsPerTrial,
  });
  assert.equal(Number.isFinite(result.provenance.calibration.elapsedMs), true);
  assert.equal(result.provenance.calibration.elapsedMs >= 250, true);
  assert.equal(Number.isInteger(result.provenance.calibration.operationsPerTrial), true);
  assert.equal(result.provenance.calibration.operationsPerTrial > 0, true);
  assert.equal(
    result.rawSamples.filter(sample => sample.phase === 'warmup').length,
    WAVE1_SCHEDULER_BENCHMARK_MANIFEST.warmupIterations,
  );
  assert.equal(
    result.rawSamples.filter(sample => sample.phase === 'measurement').length,
    WAVE1_SCHEDULER_BENCHMARK_MANIFEST.trialCount,
  );
  assert.deepEqual(
    result.rawSamples.map(sample => sample.pairIndex),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    result.rawSamples.map(sample => sample.phase),
    ['warmup', 'measurement', 'measurement', 'measurement'],
  );
  assert.equal(result.rawSamples.every(sample => sample.runId === result.provenance.runId), true);
  assert.equal(result.rawSamples.every(sample => sample.randomSeed === 7008), true);
  assert.equal(result.rawSamples.every(
    sample => sample.timingMode === 'native-encoder-no-probe'
      && sample.baselineTimedOutputDigestParity
      && sample.candidateTimedOutputDigestParity,
  ), true);
  assert.deepEqual(
    result.rawSamples.map(sample => sample.timingOrder),
    ['baseline-first', 'candidate-first', 'baseline-first', 'candidate-first'],
  );
  assert.equal(result.rawSamples.every(sample => sample.calibrationTargetDurationMs === 250), true);
  assert.equal(result.rawSamples.every(sample => Number.isFinite(sample.baselineElapsedMs)), true);
  assert.equal(result.rawSamples.every(sample => Number.isFinite(sample.candidateElapsedMs)), true);
  assert.equal(result.rawSamples.every(sample => sample.baselineElapsedMs > 0), true);
  assert.equal(result.rawSamples.every(sample => sample.candidateElapsedMs > 0), true);
  assert.equal(result.rawSamples.every(sample => Number.isInteger(sample.baselineOperations)), true);
  assert.equal(result.rawSamples.every(sample => Number.isInteger(sample.candidateOperations)), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineOperations === result.provenance.calibration.operationsPerTrial
      && sample.candidateOperations === result.provenance.calibration.operationsPerTrial,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineImplementationId === WAVE1_BASELINE_IMPLEMENTATION.implementationId
      && sample.baselineSourceDigest === WAVE1_BASELINE_IMPLEMENTATION.sourceDigest,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineExecutableDigest === frozenBaselineExecutableDigest,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.candidateImplementationId === SEGMENTED_CANDIDATE_IMPLEMENTATION.implementationId
      && sample.candidateSourceDigest === SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.candidateExecutableDigest === SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineInstrumentation.implementationId
        === WAVE1_BASELINE_IMPLEMENTATION.implementationId
      && sample.baselineInstrumentation.sourceDigest
        === WAVE1_BASELINE_IMPLEMENTATION.sourceDigest
      && sample.baselineInstrumentation.executableDigest === frozenBaselineExecutableDigest
      && sample.baselineInstrumentation.workloadDigest === WAVE1_PAIRED_WORKLOAD.digest
      && sample.baselineInstrumentation.workloadBytesPerOperation
        === WAVE1_PAIRED_WORKLOAD.byteLengthPerOperation
      && sample.baselineInstrumentation.outputDigestParity
      && sample.baselineInstrumentation.collectionMode === 'untimed-companion-counter-pass'
      && sample.baselineInstrumentation.linkedPairIndex === sample.pairIndex
      && sample.baselineInstrumentation.operations === sample.baselineOperations
      && sample.baselineInstrumentation.maxEncodeCallsPerAcceptedIngress === 1
      && sample.baselineInstrumentation.encoderResultAllocationCount
        - sample.baselineInstrumentation.acceptedIngressCount
        === sample.baselineInstrumentation.prefixLoopEncodeCallCount
      && sample.baselineInstrumentation.prefixLoopEncodeCallCount > 0
      && sample.baselineInstrumentation.prefixTemporaryAllocationCount
        === sample.baselineInstrumentation.prefixLoopEncodeCallCount,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.candidateInstrumentation.implementationId
        === SEGMENTED_CANDIDATE_IMPLEMENTATION.implementationId
      && sample.candidateInstrumentation.sourceDigest
        === SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest
      && sample.candidateInstrumentation.executableDigest
        === SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest
      && sample.candidateInstrumentation.workloadDigest === WAVE1_PAIRED_WORKLOAD.digest
      && sample.candidateInstrumentation.workloadBytesPerOperation
        === WAVE1_PAIRED_WORKLOAD.byteLengthPerOperation
      && sample.candidateInstrumentation.outputDigestParity
      && sample.candidateInstrumentation.collectionMode === 'untimed-companion-counter-pass'
      && sample.candidateInstrumentation.linkedPairIndex === sample.pairIndex
      && sample.candidateInstrumentation.operations === sample.candidateOperations
      && sample.candidateInstrumentation.encoderResultAllocationCount
        === sample.candidateInstrumentation.acceptedIngressCount
      && sample.candidateInstrumentation.maxEncodeCallsPerAcceptedIngress <= 1
      && sample.candidateInstrumentation.prefixLoopEncodeCallCount === 0
      && sample.candidateInstrumentation.prefixTemporaryAllocationCount === 0,
  ), true);
  assert.equal(result.rawSamples.every(sample => sample.process.pid === process.pid), true);
  assert.equal(result.rawSamples.every(sample => sample.process.nodeVersion === process.version), true);
  assert.equal(result.rawSamples.every(sample => sample.hardware.architecture.length > 0), true);
  assert.equal(result.rawSamples.every(sample => sample.hardware.cpuModel.length > 0), true);
  assert.equal(result.rawSamples.every(sample => sample.hardware.logicalCores > 0), true);
  assert.equal(
    new Set(result.rawSamples.map(sample => JSON.stringify(sample.hardware))).size,
    1,
  );

  const { summary } = result;
  const measurements = result.rawSamples.filter(sample => sample.phase === 'measurement');
  const baselineP95Ms = percentile95(measurements.map(sample => sample.baselineElapsedMs));
  const candidateP95Ms = percentile95(measurements.map(sample => sample.candidateElapsedMs));
  const pairedP95UpperDeltaMs = pairedBootstrapP95UpperDelta(measurements);
  assert.equal(summary.baselineP95Ms, baselineP95Ms);
  assert.equal(summary.candidateP95Ms, candidateP95Ms);
  assert.equal(summary.pairedP95UpperDeltaMs, pairedP95UpperDeltaMs);
  assert.equal(summary.bootstrap.method, 'paired-bootstrap-p95-delta');
  assert.equal(summary.bootstrap.confidenceLevel, 0.95);
  assert.equal(summary.bootstrap.iterations, 512);
  assert.equal(summary.bootstrap.randomSeed, 7008);
  assert.equal(summary.toleranceRatio, 0.05);
  assert.equal(summary.toleranceClassification, 'measurement-noise-regression-tolerance');
  assert.equal(summary.productSlo, false);
  const toleranceMs = baselineP95Ms * 0.05;
  assert.equal(summary.toleranceMs, toleranceMs);
  const independentlyPasses = pairedP95UpperDeltaMs <= toleranceMs;
  assert.equal(summary.passes, independentlyPasses);
  assert.equal(independentlyPasses, true);

  const artifactWithoutDigest = {
    schemaVersion: 1 as const,
    artifactType: 'terminal-output-scheduler-paired-benchmark' as const,
    requirementId: 'PERF-BGSTAB-009' as const,
    taskId: 'T-PH001-04' as const,
    recordedAt: new Date().toISOString(),
    result,
  };
  const artifact = {
    ...artifactWithoutDigest,
    contentDigest: digestCanonical(artifactWithoutDigest),
  };
  assert.equal(artifact.contentDigest, digestCanonical(artifactWithoutDigest));

  const recordArtifact = process.env.BUILDERGATE_RECORD_SCHEDULER_BENCHMARK === '1';
  if (recordArtifact) {
    const temporaryArtifactPath = `${artifactPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryArtifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
      renameSync(temporaryArtifactPath, artifactPath);
    } finally {
      if (existsSync(temporaryArtifactPath)) {
        unlinkSync(temporaryArtifactPath);
      }
    }
  } else {
    assert.notEqual(
      artifactBeforeRun,
      null,
      'default benchmark verification requires an already-recorded canonical artifact',
    );
  }

  const persistedText = readFileSync(artifactPath, 'utf8');
  const persisted = JSON.parse(persistedText) as typeof artifact;
  const { contentDigest, ...persistedWithoutDigest } = persisted;
  assert.equal(contentDigest, digestCanonical(persistedWithoutDigest));
  assert.deepEqual(persisted.result.manifest, WAVE1_SCHEDULER_BENCHMARK_MANIFEST);
  assert.deepEqual(persisted.result.provenance.baseline, WAVE1_BASELINE_IMPLEMENTATION);
  assert.deepEqual(persisted.result.provenance.candidate, SEGMENTED_CANDIDATE_IMPLEMENTATION);
  assert.equal(persisted.result.exactGates.outputDigestParity, true);
  assert.equal(persisted.result.summary.passes, true);
  if (!recordArtifact) {
    assert.equal(
      persistedText,
      artifactBeforeRun,
      'default benchmark verification must leave the canonical artifact byte-for-byte unchanged',
    );
  }
});
