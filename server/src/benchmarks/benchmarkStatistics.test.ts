import assert from 'node:assert/strict';
import { test } from 'node:test';

const statisticsModuleUrl = new URL('./benchmarkStatistics.js', import.meta.url);

interface StatisticsContract {
  validateExecutionManifest(value: unknown): void;
  aggregateBenchmarkSamples(manifest: unknown, samples: unknown[]): unknown[];
  canonicalJson(value: unknown): string;
}

async function loadStatistics(failureSignature: string): Promise<StatisticsContract> {
  try {
    return await import(statisticsModuleUrl.href) as StatisticsContract;
  } catch (error) {
    throw new Error(failureSignature, { cause: error });
  }
}

function createManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'wave1-benchmark-contract',
    randomSeed: 7008,
    payload: {
      generator: 'seeded-terminal-mixed-v1',
      digest: 'sha256:54e0f6cc63c47842541274022f188608f9b4948bdf23f722f660bf8417755f24',
      size: 256,
      unit: 'bytes',
    },
    warmup: { kind: 'iterations', value: 1 },
    trials: { count: 3, durationMs: 25 },
    build: { identifier: 'test-build', commit: '0000000000000000000000000000000000000000' },
    environment: {
      hardware: { architecture: 'x64', cpuModel: 'test-cpu', logicalCores: 8, memoryBytes: 16_000_000_000 },
      os: { platform: 'win32', release: 'test-release' },
      browser: { name: 'chromium', version: 'test-version' },
    },
    config: {
      serverDigest: 'sha256:server-config',
      frontendDigest: 'sha256:frontend-config',
    },
    workloadManifestId: 'workload-wave1-v1',
    workloads: [{ sessions: 1, clients: 1, viewMix: { active: 1, hidden: 0 } }],
    metricSources: [{
      metricName: 'event_loop_delay_p99',
      source: 'SessionManager.getObservabilitySnapshot.eventLoopDelay.p99Ms',
      unit: 'ms',
      intervalDelta: false,
    }],
  };
}

function createSamples(): Array<Record<string, unknown>> {
  return [1, 3, 2, 8, 5].map((value, index) => ({
    sampleId: `sample-${index + 1}`,
    workloadManifestRef: 'workload-wave1-v1',
    mode: 'NO_ANALYZER',
    sessionCount: 1,
    clientCount: 1,
    viewMix: { active: 1, hidden: 0 },
    trialId: 'trial-1',
    metricName: 'event_loop_delay_p99',
    value,
    unit: 'ms',
    timingPhase: 'measurement',
  }));
}

function deletePath(value: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let current = value;
  for (const part of parts.slice(0, -1)) {
    current = current[part] as Record<string, unknown>;
  }
  delete current[parts.at(-1) as string];
}

function assertCompleteManifestValidation(contract: StatisticsContract): void {
  const manifest = createManifest();
  assert.doesNotThrow(() => contract.validateExecutionManifest(manifest));
  const requiredPaths = [
    'randomSeed',
    'payload.generator',
    'payload.digest',
    'payload.size',
    'payload.unit',
    'warmup.kind',
    'warmup.value',
    'trials.count',
    'trials.durationMs',
    'build.identifier',
    'build.commit',
    'environment.hardware.architecture',
    'environment.hardware.cpuModel',
    'environment.hardware.logicalCores',
    'environment.hardware.memoryBytes',
    'environment.os.platform',
    'environment.os.release',
    'environment.browser.name',
    'environment.browser.version',
    'config.serverDigest',
    'config.frontendDigest',
  ];
  for (const path of requiredPaths) {
    const incomplete = structuredClone(manifest);
    deletePath(incomplete, path);
    assert.throws(
      () => contract.validateExecutionManifest(incomplete),
      /./,
      `missing ${path} must be rejected`,
    );
  }
}

function assertStatisticsRecalculation(contract: StatisticsContract): void {
  const manifest = createManifest();
  const samples = createSamples();
  assert.throws(() => contract.aggregateBenchmarkSamples(manifest, []), /raw sample/i);

  const first = contract.aggregateBenchmarkSamples(manifest, samples) as Array<Record<string, unknown>>;
  const second = contract.aggregateBenchmarkSamples(manifest, [...samples].reverse());
  assert.equal(contract.canonicalJson(first), contract.canonicalJson(second));
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].sourceSampleIds, ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5']);
  assert.deepEqual(first[0].percentiles, { p50: 3, p95: 7.3999999999999995, p99: 7.88 });
  assert.deepEqual(first[0].confidenceInterval, {
    lower: 1,
    upper: 8,
    confidenceLevel: 0.95,
    method: 'seeded-bootstrap-median-percentile',
    calculationSeed: 309247796,
  });

  const alternateMetric = {
    ...samples[0],
    sampleId: 'alternate-metric',
    metricName: 'process_cpu_one_core_percent',
    unit: 'percent_one_core',
  };
  const alternateMode = {
    ...samples[0],
    sampleId: 'alternate-mode',
    mode: 'NO_NETWORK',
  };
  const grouped = contract.aggregateBenchmarkSamples(manifest, [...samples, alternateMetric, alternateMode]);
  assert.equal(grouped.length, 3, 'summary must group independently by mode/workload/metric');

  const slowSample = {
    ...samples[0],
    sampleId: 'client-slow',
    mode: 'ONE_CLIENT_SLOW',
    clientCount: 2,
    comparator: {
      clientId: 'client-1',
      clientRole: 'slow',
      isolationEvidence: true,
      peerClientId: 'client-2',
    },
  };
  const normalSample = {
    ...slowSample,
    sampleId: 'client-normal',
    comparator: {
      clientId: 'client-2',
      clientRole: 'normal',
      isolationEvidence: true,
      peerClientId: 'client-1',
    },
  };
  const clientGroups = contract.aggregateBenchmarkSamples(manifest, [slowSample, normalSample]) as Array<Record<string, unknown>>;
  assert.equal(clientGroups.length, 2, 'slow and normal client observations must never share a summary group');
  assert.deepEqual(
    clientGroups.map(summary => (summary.comparator as Record<string, unknown>).clientId).sort(),
    ['client-1', 'client-2'],
  );

  const duplicateSameGroup = createSamples().slice(0, 2);
  duplicateSameGroup[1].sampleId = duplicateSameGroup[0].sampleId;
  assert.throws(
    () => contract.aggregateBenchmarkSamples(manifest, duplicateSameGroup),
    /duplicate raw sample ID/i,
  );
  const duplicateDifferentGroup = [
    createSamples()[0],
    { ...alternateMode, sampleId: createSamples()[0].sampleId },
  ];
  assert.throws(
    () => contract.aggregateBenchmarkSamples(manifest, duplicateDifferentGroup),
    /duplicate raw sample ID/i,
  );

  const unicodeSamples = createSamples().slice(0, 3).map((sample, index) => ({
    ...sample,
    sampleId: ['표본-한', 'échantillon', '🙂-sample'][index],
    metricName: ['지연', 'é-latency', '🙂-latency'][index],
  }));
  assert.equal(
    contract.canonicalJson(contract.aggregateBenchmarkSamples(manifest, unicodeSamples)),
    contract.canonicalJson(contract.aggregateBenchmarkSamples(manifest, [...unicodeSamples].reverse())),
    'non-ASCII keys and sample IDs must be byte-stable without locale ordering',
  );
  assert.equal(
    contract.canonicalJson({ 한글: 1, 'é': 2, ascii: 3 }),
    '{"ascii":3,"é":2,"한글":1}',
  );

  const requiredRawFields = [
    'sampleId',
    'workloadManifestRef',
    'mode',
    'sessionCount',
    'clientCount',
    'viewMix',
    'trialId',
    'metricName',
    'value',
    'unit',
    'timingPhase',
  ];
  for (const field of requiredRawFields) {
    const incomplete = structuredClone(samples[0]);
    delete incomplete[field];
    assert.throws(
      () => contract.aggregateBenchmarkSamples(manifest, [incomplete]),
      /./,
      `missing raw field ${field} must be rejected`,
    );
  }
}

function assertNoProductPromotion(contract: StatisticsContract): void {
  const manifest = createManifest();
  const forbiddenFields = [
    'threshold',
    'productThreshold',
    'slo',
    'passFail',
    'default',
    'retainedRows',
    'aggregateMemoryBytes',
    'checkpointChunkBytes',
    'inFlightBudget',
    'productThresholdMs',
    'passFailSlo',
    'retainedRowsLimit',
    'unknownBenchmarkDecision',
  ];
  for (const field of forbiddenFields) {
    assert.throws(
      () => contract.validateExecutionManifest({ ...manifest, [field]: 50 }),
      /product threshold|SLO|forbidden/i,
      `manifest promotion field ${field} must be rejected`,
    );
    const promotedRaw = { ...createSamples()[0], [field]: 50 };
    assert.throws(
      () => contract.aggregateBenchmarkSamples(manifest, [promotedRaw]),
      /product threshold|SLO|forbidden/i,
      `raw promotion field ${field} must be rejected`,
    );
  }

  const summary = contract.aggregateBenchmarkSamples(manifest, createSamples());
  assert.doesNotMatch(
    contract.canonicalJson(summary),
    /slo|threshold|passFail|default|retainedRows|aggregateMemory|checkpointChunk|inFlightBudget/i,
  );
}

test('PERF-BGSTAB-008 AC-3 RED contract', async () => {
  const contract = await loadStatistics('PERF-BGSTAB-008 AC-3 contract not implemented');
  assertCompleteManifestValidation(contract);
});

test('PERF-BGSTAB-008 AC-5 RED contract', async () => {
  const contract = await loadStatistics('PERF-BGSTAB-008 AC-5 contract not implemented');
  assertStatisticsRecalculation(contract);
});

test('PERF-BGSTAB-008 AC-7 RED contract', async () => {
  const contract = await loadStatistics('PERF-BGSTAB-008 AC-7 contract not implemented');
  assertNoProductPromotion(contract);
});

test('PERF-BGSTAB-008 AC-3 GREEN contract', async () => {
  const contract = await loadStatistics('PERF-BGSTAB-008 AC-3 contract not implemented');
  assertCompleteManifestValidation(contract);
});

test('PERF-BGSTAB-008 AC-5 GREEN contract', async () => {
  const contract = await loadStatistics('PERF-BGSTAB-008 AC-5 contract not implemented');
  assertStatisticsRecalculation(contract);
});

test('PERF-BGSTAB-008 AC-7 GREEN contract', async () => {
  const contract = await loadStatistics('PERF-BGSTAB-008 AC-7 contract not implemented');
  assertNoProductPromotion(contract);
});
