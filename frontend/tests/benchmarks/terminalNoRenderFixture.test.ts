import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runNoRenderFixture,
  type TerminalOutputSchedulerPairedBenchmarkInput,
  type TerminalOutputSchedulerPairedBenchmarkResult,
} from './terminalNoRenderFixture.ts';
import {
  createTerminalNoRenderFixtureEvidence,
  createWave1BoundaryCorpus,
  createWave1MixedCorpus,
  WAVE1_BOUNDARY_CORPUS,
  WAVE1_MIXED_CORPUS,
  WAVE1_PAIRED_WORKLOAD,
  WAVE1_SCHEDULER_BENCHMARK_MANIFEST,
} from './terminalNoRenderFixtureEvidence.ts';

const AC8_RED_SIGNATURE = 'NO_RENDER paired benchmark RED 계약 RED AC-8: Wave-1 동일 seed·warm-up·trial manifest에서 before/post digest, bytes, invocation, encode/allocation counter와 paired bootstrap CI gate가 없으면 실패하는 benchmark tests를 추가한다. 두 test file을 독립 실행해 각 RED failure signature를 보존한다.';
const AC10_RED_SIGNATURE = 'NO_RENDER paired benchmark RED 계약 RED AC-10: Wave-1 동일 seed·warm-up·trial manifest에서 before/post digest, bytes, invocation, encode/allocation counter와 paired bootstrap CI gate가 없으면 실패하는 benchmark tests를 추가한다. 두 test file을 독립 실행해 각 RED failure signature를 보존한다.';

type FixtureModuleWithPairedRunner = typeof import('./terminalNoRenderFixture.ts') & {
  runPairedTerminalOutputSchedulerBenchmark?: (
    input: TerminalOutputSchedulerPairedBenchmarkInput,
  ) => Promise<TerminalOutputSchedulerPairedBenchmarkResult>;
};

function requirePairedRunner(
  fixtureModule: FixtureModuleWithPairedRunner,
  failureSignature: string,
): NonNullable<FixtureModuleWithPairedRunner['runPairedTerminalOutputSchedulerBenchmark']> {
  assert.equal(
    typeof fixtureModule.runPairedTerminalOutputSchedulerBenchmark,
    'function',
    failureSignature,
  );
  return fixtureModule.runPairedTerminalOutputSchedulerBenchmark;
}

function assertExactCounters(
  instrumentation: Awaited<ReturnType<typeof runNoRenderFixture>>['instrumentation'],
): void {
  for (const counters of [instrumentation.control, instrumentation.observation]) {
    assert.equal(counters.acceptedIngressCount, 1);
    assert.equal(counters.encodeCallCount, 1);
    assert.equal(counters.encoderResultAllocationCount, 1);
    assert.equal(counters.ingressEncodeCallCount, 1);
    assert.equal(counters.maxEncodeCallsPerAcceptedIngress, 1);
    assert.equal(counters.prefixLoopEncodeCallCount, 0);
    assert.equal(counters.prefixTemporaryAllocationCount, 0);
  }
}

async function assertWave1FixtureBaselines(): Promise<void> {
  const mixedIngress = createWave1MixedCorpus();
  const mixed = await runNoRenderFixture({ ingress: mixedIngress });
  assert.equal(Buffer.byteLength(mixedIngress.join(''), 'utf8'), WAVE1_MIXED_CORPUS.byteLength);
  assert.equal(mixed.ingressDigest, WAVE1_MIXED_CORPUS.digest);
  assert.equal(mixed.control.ingressDigest, WAVE1_MIXED_CORPUS.digest);
  assert.equal(mixed.observation.ingressDigest, WAVE1_MIXED_CORPUS.digest);
  assert.equal(Buffer.byteLength(mixed.control.output, 'utf8'), WAVE1_MIXED_CORPUS.byteLength);
  assert.equal(mixed.control.writeConsumerInvocationCount, WAVE1_MIXED_CORPUS.controlInvocations);
  assert.equal(mixed.observation.accountingConsumerInvocationCount, WAVE1_MIXED_CORPUS.observationInvocations);
  assert.equal(mixed.observation.consumedBytes, WAVE1_MIXED_CORPUS.byteLength);
  assertExactCounters(mixed.instrumentation);

  const mixedEvidence = await createTerminalNoRenderFixtureEvidence(mixedIngress);
  assert.equal(mixedEvidence.ingressDigest, WAVE1_MIXED_CORPUS.digest);
  assert.equal(mixedEvidence.contentDigest, 'sha256:c03f1bbd117a0c1a86a83f7945f35428cd9246d76358ecacc9aff0e014dad3b2');

  const boundaryIngress = createWave1BoundaryCorpus();
  const boundary = await runNoRenderFixture({ ingress: boundaryIngress });
  assert.equal(Buffer.byteLength(boundaryIngress.join(''), 'utf8'), WAVE1_BOUNDARY_CORPUS.byteLength);
  assert.equal(boundary.ingressDigest, WAVE1_BOUNDARY_CORPUS.digest);
  assert.equal(boundary.control.ingressDigest, WAVE1_BOUNDARY_CORPUS.digest);
  assert.equal(boundary.observation.ingressDigest, WAVE1_BOUNDARY_CORPUS.digest);
  assert.equal(Buffer.byteLength(boundary.control.output, 'utf8'), WAVE1_BOUNDARY_CORPUS.byteLength);
  assert.equal(boundary.control.writeConsumerInvocationCount, WAVE1_BOUNDARY_CORPUS.controlInvocations);
  assert.equal(boundary.observation.accountingConsumerInvocationCount, WAVE1_BOUNDARY_CORPUS.observationInvocations);
  assert.equal(boundary.observation.consumedBytes, WAVE1_BOUNDARY_CORPUS.byteLength);
  assertExactCounters(boundary.instrumentation);
}

test('NO_RENDER paired benchmark RED 계약 — AC-8', async () => {
  await assertWave1FixtureBaselines();

  const fixtureModule = await import('./terminalNoRenderFixture.ts') as FixtureModuleWithPairedRunner;
  const runPairedBenchmark = requirePairedRunner(fixtureModule, AC8_RED_SIGNATURE);
  const result = await runPairedBenchmark({
    manifest: WAVE1_SCHEDULER_BENCHMARK_MANIFEST,
    mixedIngress: createWave1MixedCorpus(),
    boundaryIngress: createWave1BoundaryCorpus(),
  });

  assert.equal(result.exactGates.outputDigestParity, true);
  assert.equal(result.exactGates.mixedByteLength, WAVE1_MIXED_CORPUS.byteLength);
  assert.equal(result.exactGates.mixedControlInvocations, WAVE1_MIXED_CORPUS.controlInvocations);
  assert.equal(result.exactGates.mixedObservationInvocations, WAVE1_MIXED_CORPUS.observationInvocations);
  assert.equal(result.exactGates.boundaryByteLength, WAVE1_BOUNDARY_CORPUS.byteLength);
  assert.equal(result.exactGates.boundaryControlInvocations, WAVE1_BOUNDARY_CORPUS.controlInvocations);
  assert.equal(result.exactGates.boundaryObservationInvocations, WAVE1_BOUNDARY_CORPUS.observationInvocations);
});

test('NO_RENDER paired benchmark RED 계약 — AC-10', async () => {
  await assertWave1FixtureBaselines();

  const fixtureModule = await import('./terminalNoRenderFixture.ts') as FixtureModuleWithPairedRunner;
  const runPairedBenchmark = requirePairedRunner(fixtureModule, AC10_RED_SIGNATURE);
  const result = await runPairedBenchmark({
    manifest: WAVE1_SCHEDULER_BENCHMARK_MANIFEST,
    mixedIngress: createWave1MixedCorpus(),
    boundaryIngress: createWave1BoundaryCorpus(),
  });

  assert.equal(result.exactGates.baselineAcceptedIngressCount > 0, true);
  assert.equal(
    result.exactGates.baselineEncoderResultAllocationCount
      - result.exactGates.baselineAcceptedIngressCount,
    result.exactGates.baselinePrefixLoopEncodeCount,
  );
  assert.equal(result.exactGates.baselinePrefixLoopEncodeCount > 0, true);
  assert.equal(
    result.exactGates.baselinePrefixTemporaryAllocationCount,
    result.exactGates.baselinePrefixLoopEncodeCount,
  );
  assert.equal(result.exactGates.candidateAcceptedIngressCount > 0, true);
  assert.equal(
    result.exactGates.candidateEncoderResultAllocationCount,
    result.exactGates.candidateAcceptedIngressCount,
  );
  assert.equal(result.exactGates.candidateAcceptedIngressMaxEncodeCount <= 1, true);
  assert.equal(result.exactGates.candidatePrefixLoopEncodeCount, 0);
  assert.equal(result.exactGates.candidatePrefixTemporaryAllocationCount, 0);
  assert.equal(
    result.rawSamples.length,
    WAVE1_SCHEDULER_BENCHMARK_MANIFEST.warmupIterations
      + WAVE1_SCHEDULER_BENCHMARK_MANIFEST.trialCount,
  );
  assert.equal(result.rawSamples.every(sample => sample.baselineOperations === sample.candidateOperations), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineInstrumentation.workloadDigest === WAVE1_PAIRED_WORKLOAD.digest
      && sample.candidateInstrumentation.workloadDigest === WAVE1_PAIRED_WORKLOAD.digest
      && sample.baselineInstrumentation.workloadBytesPerOperation
        === WAVE1_PAIRED_WORKLOAD.byteLengthPerOperation
      && sample.candidateInstrumentation.workloadBytesPerOperation
        === WAVE1_PAIRED_WORKLOAD.byteLengthPerOperation,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineInstrumentation.outputDigestParity
      && sample.candidateInstrumentation.outputDigestParity,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.baselineInstrumentation.maxEncodeCallsPerAcceptedIngress === 1
      && sample.baselineInstrumentation.encoderResultAllocationCount
        - sample.baselineInstrumentation.acceptedIngressCount
        === sample.baselineInstrumentation.prefixLoopEncodeCallCount
      && sample.baselineInstrumentation.prefixLoopEncodeCallCount > 0
      && sample.baselineInstrumentation.prefixTemporaryAllocationCount
        === sample.baselineInstrumentation.prefixLoopEncodeCallCount,
  ), true);
  assert.equal(result.rawSamples.every(
    sample => sample.candidateInstrumentation.encoderResultAllocationCount
        === sample.candidateInstrumentation.acceptedIngressCount
      && sample.candidateInstrumentation.maxEncodeCallsPerAcceptedIngress <= 1
      && sample.candidateInstrumentation.prefixLoopEncodeCallCount === 0
      && sample.candidateInstrumentation.prefixTemporaryAllocationCount === 0,
  ), true);
});
