import assert from 'node:assert/strict';
import { test } from 'node:test';

type BenchmarkMode = 'NO_RENDER' | 'NO_ANALYZER' | 'NO_NETWORK' | 'ONE_CLIENT_SLOW';

const characterizationModuleUrl = new URL('./terminalCharacterization.js', import.meta.url);

interface CharacterizationContract {
  createTerminalCharacterizationManifest(): Record<string, unknown>;
  createTerminalWorkloadCorpus(): Array<{
    sessions: number;
    clients: number;
    viewMix: { active: number; hidden: number };
  }>;
  getTerminalCharacterizationModes(): Array<{
    id: string;
    disabledLayers: string[];
    replacedLayers: string[];
    retainedLayers: string[];
    controlComparator: string;
    fixture: string;
  }>;
  runTerminalCharacterization(input?: {
    deterministicMetrics?: boolean;
    modes?: string[];
    workloads?: Array<{
      sessions: 1 | 8 | 32 | 54;
      clients: 1 | 2 | 8;
      viewMix: { active: number; hidden: number };
    }>;
  }): Promise<{
    manifest: {
      workloadManifestId: string;
      metricSources: Array<{ metricName: string; source: string; unit: string; intervalDelta: boolean }>;
      modes?: Array<{ id: BenchmarkMode }>;
    };
    cases: Array<{
      mode: string;
      sessionCount: number;
      clientCount: number;
      ingressDigest: string;
      analyzerInvocationCount: number;
      networkSendCount: number;
      clientObservations: Array<{
        clientId: string;
        role: string;
        isolationEvidence: boolean;
        streamDigest: string;
        peerClientId?: string;
        pressureApplied: boolean;
        bufferedAmountBefore: number;
        deliveryBeforeDrainCount: number;
        deliveryAfterDrainCount: number;
      }>;
      workloadExecutionId: string;
      fixtureEvidence?: {
        fixtureExecutionId: string;
        fixtureResultDigest: string;
        ingressDigest: string;
        source: string;
      };
      semanticAnalyzerEvidence?: {
        actualOnDataPath: boolean;
        controlInvocationCount: number;
        bypassInvocationCount: number;
        controlDeliveryDigest: string;
        bypassDeliveryDigest: string;
      };
    }>;
    rawSamples: Array<{
      sampleId: string;
      workloadManifestRef: string;
      mode: string;
      sessionCount: number;
      clientCount: number;
      viewMix: { active: number; hidden: number };
      trialId: string;
      metricName: string;
      value: number;
      unit: string;
      timingPhase: string;
      metricSource: string;
      workloadExecutionRef: string;
      fixtureEvidenceRef?: { fixtureExecutionId: string; fixtureResultDigest: string };
      interval: {
        sequenceStart: number;
        sequenceEnd: number;
        deltaValue: number;
        unit: string;
        durationMs: number;
        valueSemantics: string;
      };
      comparator?: { clientRole: string; isolationEvidence: boolean; peerClientId?: string };
    }>;
    executionOrder: string[];
  }>;
}

const SINGLE_WORKLOAD = [{
  sessions: 1 as const,
  clients: 2 as const,
  viewMix: { active: 1, hidden: 0 },
}];

async function loadCharacterization(failureSignature: string): Promise<CharacterizationContract> {
  try {
    return await import(characterizationModuleUrl.href) as CharacterizationContract;
  } catch (error) {
    throw new Error(failureSignature, { cause: error });
  }
}

async function assertModeContract(contract: CharacterizationContract): Promise<void> {
  const modes = contract.getTerminalCharacterizationModes();
  assert.deepEqual(modes.map(mode => mode.id), [
    'NO_RENDER',
    'NO_ANALYZER',
    'NO_NETWORK',
    'ONE_CLIENT_SLOW',
  ]);
  for (const mode of modes) {
    assert.equal(mode.controlComparator.length > 0, true);
    assert.equal(mode.fixture.length > 0, true);
    assert.equal(mode.disabledLayers.length + mode.replacedLayers.length > 0, true);
    assert.equal(mode.retainedLayers.length > 0, true);
  }
}

async function assertModeSelectionContract(contract: CharacterizationContract): Promise<void> {
  const single = await contract.runTerminalCharacterization({
    deterministicMetrics: true,
    modes: ['NO_NETWORK'],
    workloads: SINGLE_WORKLOAD,
  });
  assert.deepEqual(single.manifest.modes?.map(mode => mode.id), ['NO_NETWORK']);
  assert.deepEqual([...new Set(single.cases.map(item => item.mode))], ['NO_NETWORK']);

  const multiple = await contract.runTerminalCharacterization({
    deterministicMetrics: true,
    modes: ['NO_ANALYZER', 'ONE_CLIENT_SLOW'],
    workloads: SINGLE_WORKLOAD,
  });
  assert.deepEqual(multiple.manifest.modes?.map(mode => mode.id), ['NO_ANALYZER', 'ONE_CLIENT_SLOW']);
  assert.deepEqual([...new Set(multiple.cases.map(item => item.mode))], ['NO_ANALYZER', 'ONE_CLIENT_SLOW']);
  await assert.rejects(
    contract.runTerminalCharacterization({
      deterministicMetrics: true,
      modes: ['UNSUPPORTED_MODE'],
      workloads: SINGLE_WORKLOAD,
    }),
    /unsupported benchmark mode/i,
  );
}

async function assertActualFixtureEvidenceContract(contract: CharacterizationContract): Promise<void> {
  const result = await contract.runTerminalCharacterization({
    deterministicMetrics: true,
    modes: ['NO_RENDER', 'NO_ANALYZER'],
    workloads: SINGLE_WORKLOAD,
  });
  const noRender = result.cases.find(item => item.mode === 'NO_RENDER');
  assert.ok(noRender?.fixtureEvidence);
  assert.equal(noRender.fixtureEvidence.ingressDigest, noRender.ingressDigest);
  assert.match(noRender.fixtureEvidence.fixtureExecutionId, /^no-render-/);
  assert.match(noRender.fixtureEvidence.fixtureResultDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(noRender.fixtureEvidence.source, 'frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts');
  const noRenderSamples = result.rawSamples.filter(sample => sample.mode === 'NO_RENDER');
  assert.equal(noRenderSamples.length > 0, true);
  const noRenderEvidence = noRender.fixtureEvidence;
  assert.equal(noRenderSamples.every(sample => (
    sample.fixtureEvidenceRef?.fixtureExecutionId === noRenderEvidence.fixtureExecutionId
    && sample.fixtureEvidenceRef?.fixtureResultDigest === noRenderEvidence.fixtureResultDigest
  )), true);

  const noAnalyzer = result.cases.find(item => item.mode === 'NO_ANALYZER');
  assert.ok(noAnalyzer?.semanticAnalyzerEvidence);
  assert.equal(noAnalyzer.semanticAnalyzerEvidence.actualOnDataPath, true);
  assert.equal(noAnalyzer.semanticAnalyzerEvidence.controlInvocationCount > 0, true);
  assert.equal(noAnalyzer.semanticAnalyzerEvidence.bypassInvocationCount, 0);
  assert.equal(
    noAnalyzer.semanticAnalyzerEvidence.controlDeliveryDigest,
    noAnalyzer.semanticAnalyzerEvidence.bypassDeliveryDigest,
  );
  assert.equal(noAnalyzer.semanticAnalyzerEvidence.controlDeliveryDigest, noAnalyzer.ingressDigest);
}

async function assertActualSlowClientContract(contract: CharacterizationContract): Promise<void> {
  const result = await contract.runTerminalCharacterization({
    deterministicMetrics: true,
    modes: ['ONE_CLIENT_SLOW'],
    workloads: SINGLE_WORKLOAD,
  });
  const observed = result.cases[0];
  const slow = observed.clientObservations.find(client => client.role === 'slow');
  const normal = observed.clientObservations.find(client => client.role === 'normal');
  assert.ok(slow);
  assert.ok(normal);
  assert.equal(slow.pressureApplied, true);
  assert.equal(slow.bufferedAmountBefore > 0, true);
  assert.equal(slow.deliveryBeforeDrainCount, 0);
  assert.equal(slow.deliveryAfterDrainCount > 0, true);
  assert.equal(normal.pressureApplied, false);
  assert.equal(normal.deliveryBeforeDrainCount > 0, true);
  assert.equal(normal.deliveryAfterDrainCount, normal.deliveryBeforeDrainCount);
  assert.equal(slow.streamDigest, normal.streamDigest);
  assert.equal(slow.streamDigest, observed.ingressDigest);
}

async function assertActualMetricIntervalContract(contract: CharacterizationContract): Promise<void> {
  const result = await contract.runTerminalCharacterization({
    deterministicMetrics: false,
    modes: ['NO_ANALYZER'],
    workloads: [{ sessions: 1, clients: 1, viewMix: { active: 1, hidden: 0 } }],
  });
  const observed = result.cases[0];
  assert.equal(observed.workloadExecutionId.length > 0, true);
  assert.equal(result.rawSamples.every(sample => sample.workloadExecutionRef === observed.workloadExecutionId), true);
  assert.equal(result.rawSamples.every(sample => sample.interval.durationMs >= 250), true);
  const cpu = result.rawSamples.filter(sample => sample.metricName === 'process_cpu_one_core_percent');
  assert.equal(cpu.every(sample => sample.interval.valueSemantics === 'windowed-rate-value'), true);
  assert.equal(cpu.every(sample => sample.interval.deltaValue === sample.value), true);
  const headless = result.rawSamples.filter(sample => sample.metricName === 'headless_write_cumulative_ms');
  assert.equal(headless.every(sample => sample.interval.valueSemantics === 'after-minus-before-cumulative'), true);
  assert.equal(headless.some(sample => sample.interval.deltaValue > 0), true);
  const eventLoop = result.rawSamples.filter(sample => sample.metricName.startsWith('event_loop_delay_'));
  const eventLoopSources = new Map(result.manifest.metricSources
    .filter(source => source.metricName.startsWith('event_loop_delay_'))
    .map(source => [source.metricName, source.source]));
  assert.deepEqual(
    [...eventLoopSources.entries()],
    [
      ['event_loop_delay_mean', 'SessionManager.getObservabilitySnapshot.eventLoopDelay.mean'],
      ['event_loop_delay_p99', 'SessionManager.getObservabilitySnapshot.eventLoopDelay.p99'],
    ],
  );
  assert.equal(eventLoop.every(sample => (
    sample.metricSource === eventLoopSources.get(sample.metricName)
      && sample.interval.valueSemantics === 'session-manager-observability-interval-statistic'
  )), true);
  assert.equal(eventLoop.some(sample => sample.metricSource.includes('benchmarkInterval')), false);
}

async function assertModeIsolationContract(contract: CharacterizationContract): Promise<void> {
  const result = await contract.runTerminalCharacterization({ deterministicMetrics: true });
  const noAnalyzer = result.cases.filter(item => item.mode === 'NO_ANALYZER');
  const noNetwork = result.cases.filter(item => item.mode === 'NO_NETWORK');
  const slowClient = result.cases.filter(item => item.mode === 'ONE_CLIENT_SLOW');
  assert.equal(noAnalyzer.every(item => item.analyzerInvocationCount === 0), true);
  assert.equal(noNetwork.every(item => item.networkSendCount === 0), true);
  assert.equal(new Set(result.cases.map(item => item.ingressDigest)).size, 1);
  const isolationCases = slowClient.filter(item => item.clientCount >= 2);
  assert.equal(isolationCases.length > 0, true);
  for (const item of isolationCases) {
    const slow = item.clientObservations.find(client => client.role === 'slow');
    const normal = item.clientObservations.find(client => client.role === 'normal');
    assert.ok(slow);
    assert.ok(normal);
    assert.equal(slow.streamDigest, normal.streamDigest);
    assert.equal(slow.isolationEvidence, true);
    assert.equal(normal.isolationEvidence, true);
    assert.equal(slow.peerClientId, normal.clientId);
    assert.equal(normal.peerClientId, slow.clientId);
  }
}

async function assertWorkloadContract(contract: CharacterizationContract): Promise<void> {
  const corpus = contract.createTerminalWorkloadCorpus();
  const result = await contract.runTerminalCharacterization({ deterministicMetrics: true });
  assert.deepEqual([...new Set(corpus.map(item => item.sessions))].sort((a, b) => a - b), [1, 8, 32, 54]);
  assert.deepEqual([...new Set(corpus.map(item => item.clients))].sort((a, b) => a - b), [1, 2, 8]);
  assert.equal(corpus.length, 12);
  assert.equal(corpus.every(item => item.viewMix.active + item.viewMix.hidden === item.sessions), true);
  assert.equal(result.rawSamples.every(sample => sample.workloadManifestRef === result.manifest.workloadManifestId), true);
  const slowSamples = result.rawSamples.filter(sample => sample.mode === 'ONE_CLIENT_SLOW');
  assert.equal(slowSamples.filter(sample => sample.clientCount === 1).every(
    sample => sample.comparator?.clientRole === 'pressure-baseline'
      && sample.comparator.isolationEvidence === false,
  ), true);
  assert.equal(slowSamples.some(sample => sample.clientCount >= 2
    && sample.comparator?.clientRole === 'normal'
    && sample.comparator.isolationEvidence === true), true);
}

async function assertMetricContract(
  contract: CharacterizationContract,
  deterministicMetrics: boolean,
): Promise<void> {
  const result = await contract.runTerminalCharacterization({ deterministicMetrics });
  const expectedMetrics = [
    'event_loop_delay_mean',
    'event_loop_delay_p99',
    'process_cpu_one_core_percent',
    'headless_write_cumulative_ms',
  ];
  assert.deepEqual(result.manifest.metricSources.slice(0, 4).map(source => source.metricName), expectedMetrics);
  assert.deepEqual(result.manifest.metricSources.slice(4).map(source => source.metricName), [
    'client_delivery_before_drain_count',
    'client_delivery_after_drain_count',
  ]);
  assert.equal(result.manifest.metricSources.every(source => source.source.length > 0 && source.unit.length > 0), true);
  assert.equal(result.manifest.metricSources.some(
    source => source.metricName === 'headless_write_cumulative_ms' && source.intervalDelta,
  ), true);
  assert.equal(result.rawSamples.every(sample => Number.isFinite(sample.value)), true);
  assert.equal(result.rawSamples.every(sample => sample.metricSource.length > 0), true);
  assert.equal(result.rawSamples.every(sample => sample.interval.sequenceEnd > sample.interval.sequenceStart), true);
  assert.equal(result.rawSamples.every(sample => sample.interval.unit === sample.unit), true);
  assert.equal(result.executionOrder[0], 'manifest');
  assert.equal(result.executionOrder[1], 'raw-samples');
  assert.equal(result.executionOrder.includes('summary'), false);
}

test('PERF-BGSTAB-008 AC-1 RED contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-1 contract not implemented');
  await assertModeContract(contract);
});

test('PERF-BGSTAB-008 AC-2 RED contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-2 contract not implemented');
  await assertModeIsolationContract(contract);
});

test('PERF-BGSTAB-008 AC-4 RED contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-4 contract not implemented');
  await assertWorkloadContract(contract);
});

test('PERF-BGSTAB-008 AC-6 RED contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-6 contract not implemented');
  await assertMetricContract(contract, true);
});

test('PERF-BGSTAB-008 AC-1 GREEN contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-1 contract not implemented');
  await assertModeContract(contract);
  await assertModeSelectionContract(contract);
});

test('PERF-BGSTAB-008 AC-2 GREEN contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-2 contract not implemented');
  await assertModeIsolationContract(contract);
  await assertActualFixtureEvidenceContract(contract);
  await assertActualSlowClientContract(contract);
});

test('PERF-BGSTAB-008 AC-4 GREEN contract', async () => {
  await assertWorkloadContract(await loadCharacterization('PERF-BGSTAB-008 AC-4 contract not implemented'));
});

test('PERF-BGSTAB-008 AC-6 GREEN contract', async () => {
  const contract = await loadCharacterization('PERF-BGSTAB-008 AC-6 contract not implemented');
  await assertMetricContract(contract, true);
  await assertActualMetricIntervalContract(contract);
});
