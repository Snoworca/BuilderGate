import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type FairTerminalDelivery,
  type FairTerminalDeliveryInput,
} from './wsSendPolicy.js';

// 재선언하지 않고 프로덕션 타입을 그대로 쓴다 — 재선언하면 타입 변경이 조용히 통과한다.
type DeliveryInput = FairTerminalDeliveryInput;
type SentDelivery = FairTerminalDelivery;

interface SchedulerSnapshot {
  lanes: Record<string, {
    queuedBytes: number;
    socketQueuedBytes: number;
    creditBytes: number;
    sentDeliverySeqs: number[];
  }>;
  metrics: {
    lanes: Record<string, {
      enqueueToFirstServiceMs: { p50: number; p95: number; p99: number; max: number };
      enqueueToCompleteMs: { p50: number; p95: number; p99: number; max: number };
      maxNoServiceIntervalMs: number;
      peakApplicationQueuedBytes: number;
      peakSocketQueuedBytes: number;
    }>;
    controlLatency: { p50: number; p95: number; p99: number; max: number };
    aggregateThroughputBytesPerSecond: number;
  };
  policy: {
    strategy: { value: string; source: string };
    socketSoftGateBytes: { value: number; source: string };
    bulkSliceBytes: { value: number; source: string };
    smallOutputBypassBytes: { value: number; source: string };
    visibilityWeight: { value: number; source: string };
    driverWeight: { value: number; source: string };
    creditWindowBytes: { value: number; source: string };
    ackTimeoutMs: { value: number; source: string };
    queueMaxBytes: { value: number; source: string };
  };
  protocolErrors: Array<{ code: string; connectionEpoch: string; sessionId: string; deliverySeq: number }>;
  semanticStatusMutationCount: number;
  fallback: Record<string, { reason: string; producerBlocked: boolean; checkpointCount: number; closed: boolean }>;
  cleanup: { timers: number; heldBytes: number; ledgers: number; queues: number; releases: Record<string, number> };
}

interface FairTerminalDeliveryScheduler {
  enqueue(input: DeliveryInput): { accepted: boolean; deliverySeq?: number; reason?: string };
  drain(options?: { maxDeliveries?: number }): void;
  advanceTo(now: number): void;
  acknowledge(input: {
    connectionEpoch: string;
    sessionId: string;
    deliverySeq: number;
    clientBytes?: number;
  }): { accepted: boolean; creditedBytes: number; errorCode?: string };
  settleTransport(input: {
    connectionEpoch: string;
    sessionId: string;
    deliverySeq: number;
    error?: string;
  }): void;
  downgrade(input: { connectionEpoch: string; sessionId: string; reason: string }): void;
  closeConnection(connectionEpoch: string): void;
  terminateSession(input: { connectionEpoch: string; sessionId: string }): void;
  rollbackConnection(connectionEpoch: string): void;
  snapshot(): SchedulerSnapshot;
  decision(): {
    artifactPath: string;
    artifactSchemaVersion: string;
    artifactState: DecisionArtifactInput['state'];
    workloadSchemaHash: string;
    configHash: string;
    baseline: string;
    candidate: string;
    sampleCount: number;
    rawEvidencePaths: string[];
    thresholds: Record<string, { exact: number; tolerance: number; source: string }>;
    accepted: boolean;
    promotionAllowed: boolean;
    allRegisteredThresholdsPassed: boolean;
    hasUnboundedEligibleLaneStarvation: boolean;
    benchmarkContractSource: string;
    reason: string;
  };
}

interface SchedulerPolicy {
  strategy: { value: string; source: string };
  socketSoftGateBytes: { value: number; source: string };
  bulkSliceBytes: { value: number; source: string };
  smallOutputBypassBytes: { value: number; source: string };
  visibilityWeight: { value: number; source: string };
  driverWeight: { value: number; source: string };
  creditWindowBytes: { value: number; source: string };
  ackTimeoutMs: { value: number; source: string };
  queueMaxBytes: { value: number; source: string };
}

interface DecisionArtifactInput {
  state: 'missing' | 'incomplete' | 'complete';
  allRegisteredThresholdsPassed: boolean;
  hasUnboundedEligibleLaneStarvation: boolean;
}

interface FairTerminalDeliverySchedulerModule {
  createFairTerminalDeliveryScheduler(options: {
    now: () => number;
    policy: SchedulerPolicy;
    decisionArtifact: DecisionArtifactInput;
    send(delivery: SentDelivery): void;
    onSemanticStatusChange(change: { connectionEpoch: string; sessionId: string; status: 'idle' | 'running' }): void;
    onFallback?(fallback: { connectionEpoch: string; sessionId: string; reason: string }): void;
  }): FairTerminalDeliveryScheduler;
}

const policySource = 'TerminalResourcePolicy:fair-delivery-candidate';

function createPolicy(overrides: Partial<SchedulerPolicy> = {}): SchedulerPolicy {
  return {
    strategy: { value: 'policy-selected', source: policySource },
    socketSoftGateBytes: { value: 512, source: policySource },
    bulkSliceBytes: { value: 128, source: policySource },
    smallOutputBypassBytes: { value: 32, source: policySource },
    visibilityWeight: { value: 3, source: policySource },
    driverWeight: { value: 2, source: policySource },
    creditWindowBytes: { value: 2048, source: policySource },
    ackTimeoutMs: { value: 50, source: policySource },
    queueMaxBytes: { value: 2048, source: policySource },
    ...overrides,
  };
}

async function createHarness(signature: string, options: {
  policy?: Partial<SchedulerPolicy>;
  decisionArtifact?: DecisionArtifactInput;
} = {}) {
  const modulePath = './wsSendPolicy.js';
  const module = await import(modulePath) as Partial<FairTerminalDeliverySchedulerModule>;
  const factory = module.createFairTerminalDeliveryScheduler;
  assert.equal(typeof factory, 'function', signature);

  let now = 1_000;
  const sent: SentDelivery[] = [];
  const externalSemanticStatuses: Record<string, 'idle' | 'running'> = { 'epoch-a/interactive-ai': 'idle' };
  const semanticStatusChanges: Array<{ connectionEpoch: string; sessionId: string; status: 'idle' | 'running' }> = [];
  const fallbacks: Array<{ connectionEpoch: string; sessionId: string; reason: string }> = [];
  const scheduler = factory!({
    now: () => now,
    policy: createPolicy(options.policy),
    decisionArtifact: options.decisionArtifact ?? {
      state: 'missing',
      allRegisteredThresholdsPassed: false,
      hasUnboundedEligibleLaneStarvation: true,
    },
    send(delivery) {
      sent.push(delivery);
    },
    onSemanticStatusChange(change) {
      semanticStatusChanges.push(change);
      externalSemanticStatuses[`${change.connectionEpoch}/${change.sessionId}`] = change.status;
    },
    onFallback(fallback) {
      fallbacks.push(fallback);
    },
  });

  return {
    scheduler,
    sent,
    semanticStatusChanges,
    fallbacks,
    externalSemanticStatuses,
    advance(ms: number) {
      now += ms;
      scheduler.advanceTo(now);
    },
  };
}

function requireAccepted(
  result: ReturnType<FairTerminalDeliveryScheduler['enqueue']>,
  signature: string,
): number {
  assert.equal(result.accepted, true, signature);
  assert.equal(typeof result.deliverySeq, 'number', signature);
  return result.deliverySeq!;
}

function assertPercentileMatrix(
  value: { p50: number; p95: number; p99: number; max: number },
  signature: string,
): void {
  assert.equal(value.p50 >= 0, true, signature);
  assert.equal(value.p50 <= value.p95, true, signature);
  assert.equal(value.p95 <= value.p99, true, signature);
  assert.equal(value.p99 <= value.max, true, signature);
}

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-1', async () => {
  const signature = 'PERF-BGSTAB-010 AC-1 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler, sent } = await createHarness(signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'A-1' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'A-2' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'A-3' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-b', kind: 'output', payload: 'B-1' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-b', kind: 'dataGap', payload: 'gap-b' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-b', kind: 'checkpoint', payload: 'checkpoint-b' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-b', kind: 'readyBarrier', payload: 'ready-b' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-b', sessionId: 'session-a', kind: 'output', payload: 'other-client-A-1' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'dataGap', payload: 'gap-a' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'checkpoint', payload: 'checkpoint-a' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'readyBarrier', payload: 'ready-a' }), signature);
  scheduler.drain();
  assert.deepEqual(sent.filter(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'session-a').map(item => [item.kind, item.payload]), [
    ['output', 'A-1'],
    ['output', 'A-2'],
    ['output', 'A-3'],
    ['dataGap', 'gap-a'],
    ['checkpoint', 'checkpoint-a'],
    ['readyBarrier', 'ready-a'],
  ], signature);
  assert.deepEqual(sent.filter(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'session-b').map(item => [item.kind, item.payload]), [
    ['output', 'B-1'],
    ['dataGap', 'gap-b'],
    ['checkpoint', 'checkpoint-b'],
    ['readyBarrier', 'ready-b'],
  ], signature);
  assert.equal(sent.some(item => item.connectionEpoch === 'epoch-b' && item.sessionId === 'session-a' && item.payload === 'other-client-A-1'), true, signature);
  const bIndex = sent.findIndex(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'session-b' && item.payload === 'B-1');
  const otherClientIndex = sent.findIndex(item => item.connectionEpoch === 'epoch-b' && item.sessionId === 'session-a' && item.payload === 'other-client-A-1');
  const a3Index = sent.findIndex(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'session-a' && item.payload === 'A-3');
  assert.equal(bIndex >= 0 && bIndex < a3Index, true, signature);
  assert.equal(otherClientIndex >= 0 && otherClientIndex < a3Index, true, signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-2', async () => {
  const signature = 'PERF-BGSTAB-010 AC-2 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler, sent, advance } = await createHarness(signature, {
    policy: { queueMaxBytes: { value: 2048, source: policySource } },
  });
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'flood', kind: 'output', payload: 'x'.repeat(120) }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'flood', kind: 'output', payload: 'y'.repeat(120) }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'flood', kind: 'output', payload: 'z'.repeat(120) }), signature);
  advance(4);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'normal', kind: 'output', payload: 'prompt> ' }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'normal', kind: 'output', payload: 'normal-bulk'.repeat(20) }), signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'normal', kind: 'control', payload: 'control' }), signature);
  advance(6);
  scheduler.drain();
  const metrics = scheduler.snapshot().metrics;
  assert.equal(sent.some(item => item.sessionId === 'normal' && item.kind === 'control'), true, signature);
  const lastFloodIndex = sent.reduce((last, item, index) => (
    item.connectionEpoch === 'epoch-a' && item.sessionId === 'flood' ? index : last
  ), -1);
  const normalIndex = sent.findIndex(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'normal' && item.kind === 'output');
  const normalBulkIndex = sent.findIndex(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'normal' && item.payload === 'normal-bulk'.repeat(20));
  const controlIndex = sent.findIndex(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'normal' && item.kind === 'control');
  assert.equal(normalIndex >= 0 && normalIndex < lastFloodIndex, true, signature);
  assert.equal(controlIndex >= 0 && controlIndex === normalBulkIndex + 1, true, signature);
  assert.equal(normalBulkIndex >= 0 && normalBulkIndex < controlIndex, true, signature);
  for (const laneId of ['epoch-a/flood', 'epoch-a/normal']) {
    const lane = metrics.lanes[laneId];
    assert.ok(lane, signature);
    assertPercentileMatrix(lane.enqueueToFirstServiceMs, signature);
    assertPercentileMatrix(lane.enqueueToCompleteMs, signature);
    assert.equal(lane.maxNoServiceIntervalMs <= 50, true, signature);
    assert.equal(lane.peakApplicationQueuedBytes > 0, true, signature);
    assert.equal(lane.peakSocketQueuedBytes >= 0, true, signature);
  }
  assert.equal(metrics.lanes['epoch-a/flood'].enqueueToFirstServiceMs.p50, 10, signature);
  assert.equal(metrics.lanes['epoch-a/normal'].enqueueToFirstServiceMs.p50, 6, signature);
  assertPercentileMatrix(metrics.controlLatency, signature);
  assert.equal(metrics.controlLatency.p50, 6, signature);
  assert.equal(metrics.controlLatency.max <= 50, true, signature);
  assert.equal(metrics.aggregateThroughputBytesPerSecond > 0, true, signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-3', async () => {
  const signature = 'PERF-BGSTAB-010 AC-3 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler: missingArtifactScheduler } = await createHarness(signature, {
    decisionArtifact: { state: 'missing', allRegisteredThresholdsPassed: false, hasUnboundedEligibleLaneStarvation: true },
  });
  const missing = missingArtifactScheduler.decision();
  assert.equal(missing.artifactState, 'missing', signature);
  assert.equal(missing.accepted, false, signature);
  assert.equal(missing.promotionAllowed, false, signature);
  const { scheduler: incompleteArtifactScheduler } = await createHarness(signature, {
    decisionArtifact: { state: 'incomplete', allRegisteredThresholdsPassed: true, hasUnboundedEligibleLaneStarvation: false },
  });
  const incomplete = incompleteArtifactScheduler.decision();
  assert.equal(incomplete.artifactState, 'incomplete', signature);
  assert.equal(incomplete.accepted, false, signature);
  assert.equal(incomplete.promotionAllowed, false, signature);
  const { scheduler } = await createHarness(signature, {
    decisionArtifact: { state: 'complete', allRegisteredThresholdsPassed: true, hasUnboundedEligibleLaneStarvation: false },
  });
  const decision = scheduler.decision();
  assert.equal(decision.artifactPath, 'docs/analysis/terminal-fairness-authority/current.json', signature);
  assert.equal(decision.artifactPath.includes('kiwi-coder-'), false, signature);
  assert.equal(decision.artifactSchemaVersion.length > 0, true, signature);
  assert.equal(decision.artifactState, 'complete', signature);
  assert.equal(decision.workloadSchemaHash.length > 0, true, signature);
  assert.equal(decision.configHash.length > 0, true, signature);
  assert.equal(decision.baseline.length > 0, true, signature);
  assert.equal(decision.candidate.length > 0, true, signature);
  assert.equal(decision.sampleCount > 0, true, signature);
  assert.equal(decision.rawEvidencePaths.length > 0, true, signature);
  assert.equal(Object.values(decision.thresholds).every(value => value.exact >= 0 && value.tolerance >= 0 && value.source.length > 0), true, signature);
  assert.equal(decision.benchmarkContractSource.length > 0, true, signature);
  assert.equal(decision.allRegisteredThresholdsPassed, true, signature);
  assert.equal(decision.hasUnboundedEligibleLaneStarvation, false, signature);
  assert.equal(decision.accepted, true, signature);
  assert.equal(decision.promotionAllowed, true, signature);
  assert.equal(decision.reason.length > 0, true, signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-4', async () => {
  const signature = 'PERF-BGSTAB-010 AC-4 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler } = await createHarness(signature);
  const policy = scheduler.snapshot().policy;
  assert.equal(policy.strategy.value.length > 0, true, signature);
  for (const value of Object.values(policy)) {
    assert.equal(value.source, policySource, signature);
  }
  assert.deepEqual(
    {
      socketSoftGateBytes: policy.socketSoftGateBytes.value,
      bulkSliceBytes: policy.bulkSliceBytes.value,
      smallOutputBypassBytes: policy.smallOutputBypassBytes.value,
      visibilityWeight: policy.visibilityWeight.value,
      driverWeight: policy.driverWeight.value,
      creditWindowBytes: policy.creditWindowBytes.value,
      ackTimeoutMs: policy.ackTimeoutMs.value,
      queueMaxBytes: policy.queueMaxBytes.value,
    },
    {
      socketSoftGateBytes: 512,
      bulkSliceBytes: 128,
      smallOutputBypassBytes: 32,
      visibilityWeight: 3,
      driverWeight: 2,
      creditWindowBytes: 2048,
      ackTimeoutMs: 50,
      queueMaxBytes: 2048,
    },
    signature,
  );
  const alternateSource = 'TerminalResourcePolicy:fair-delivery-candidate#alternate-decision';
  const { scheduler: constrainedScheduler, sent: constrainedSent } = await createHarness(signature, {
    policy: {
      strategy: { value: 'weighted-fair', source: alternateSource },
      socketSoftGateBytes: { value: 64, source: alternateSource },
      bulkSliceBytes: { value: 16, source: alternateSource },
      smallOutputBypassBytes: { value: 8, source: alternateSource },
      visibilityWeight: { value: 7, source: alternateSource },
      driverWeight: { value: 5, source: alternateSource },
      creditWindowBytes: { value: 1, source: alternateSource },
      ackTimeoutMs: { value: 25, source: alternateSource },
      queueMaxBytes: { value: 256, source: alternateSource },
    },
    decisionArtifact: { state: 'complete', allRegisteredThresholdsPassed: true, hasUnboundedEligibleLaneStarvation: false },
  });
  requireAccepted(constrainedScheduler.enqueue({
    connectionEpoch: 'epoch-a', sessionId: 'policy-probe', kind: 'output', payload: 'x'.repeat(40),
    capabilities: { ackCredit: true, legacyFallback: false },
  }), signature);
  constrainedScheduler.drain();
  assert.equal(constrainedSent.length, 0, signature);
  const constrainedPolicy = constrainedScheduler.snapshot().policy;
  assert.equal(constrainedPolicy.strategy.value, 'weighted-fair', signature);
  assert.equal(constrainedPolicy.creditWindowBytes.value, 1, signature);
  assert.equal(constrainedPolicy.bulkSliceBytes.value, 16, signature);
  assert.equal(Object.values(constrainedPolicy).every(value => value.source === alternateSource), true, signature);
});

test('PERF-BGSTAB-010 scheduler applies the projected slice, class weights, socket gate, and small-output bypass', async () => {
  const signature = 'PERF-BGSTAB-010 AC-4 projected policy values must alter scheduler admission and selection';
  const { scheduler, sent } = await createHarness(signature, {
    policy: {
      bulkSliceBytes: { value: 100, source: policySource },
      visibilityWeight: { value: 3, source: policySource },
      driverWeight: { value: 1, source: policySource },
      socketSoftGateBytes: { value: 250, source: policySource },
      smallOutputBypassBytes: { value: 128, source: policySource },
      creditWindowBytes: { value: 2_048, source: policySource },
    },
  });
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'policy', sessionId: 'driver', kind: 'output', payload: 'd'.repeat(160), serviceClass: 'driver',
  }), signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'policy', sessionId: 'visible', kind: 'output', payload: 'v'.repeat(160), serviceClass: 'visible',
  }), signature);
  scheduler.drain({ maxDeliveries: 1 });
  assert.equal(sent[0]?.sessionId, 'visible', signature);

  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'policy', sessionId: 'gated', kind: 'output', payload: 'g'.repeat(800), serviceClass: 'driver',
  }), signature);
  scheduler.drain();
  const firstGated = sent.find(delivery => delivery.sessionId === 'gated');
  assert.ok(firstGated, signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'policy', sessionId: 'gated', kind: 'output', payload: 'h'.repeat(800), serviceClass: 'driver',
  }), signature);
  scheduler.drain();
  assert.equal(sent.some(delivery => delivery.sessionId === 'gated' && delivery.payload.startsWith('h')), false, signature);

  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'policy', sessionId: 'small-bypass', kind: 'output', payload: 'b'.repeat(800), serviceClass: 'driver',
  }), signature);
  scheduler.drain();
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'policy', sessionId: 'small-bypass', kind: 'output', payload: 'tiny', serviceClass: 'driver',
  }), signature);
  scheduler.drain();
  assert.equal(sent.some(delivery => delivery.sessionId === 'small-bypass' && delivery.payload === 'tiny'), true, signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-5', async () => {
  const signature = 'PERF-BGSTAB-010 AC-5 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler, sent } = await createHarness(signature);
  const seq1 = requireAccepted(
    scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: '한글-alpha' }),
    signature,
  );
  const seq2 = requireAccepted(
    scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: '🙂-beta' }),
    signature,
  );
  scheduler.drain();
  assert.equal(seq2 > seq1, true, signature);
  const sent1 = sent.find(item => item.deliverySeq === seq1);
  const sent2 = sent.find(item => item.deliverySeq === seq2);
  assert.ok(sent1, signature);
  assert.ok(sent2, signature);
  // 독립 출처: 기대 본문 바이트를 맨 숫자로 적는다. Buffer.byteLength() 로 기대값을 뽑으면
  // 구현과 기대가 같은 함수에서 나와 도메인을 바꿔도 초록이 된다.
  // PERF-BGSTAB-011 AC-1: 도메인은 codec 무관 본문(body) 바이트다. 봉투 길이도 프레임 전체
  // 길이도 아니므로 deliverySeq 자릿수에 의존하지 않는다.
  const firstBodyBytes = 12; // '한글-alpha' = '한'·'글' 3B×2 + '-alpha' 6B
  const secondBodyBytes = 9; // '🙂-beta' = '🙂' 4B + '-beta' 5B
  const expectedBytes = firstBodyBytes + secondBodyBytes; // 21
  assert.equal(sent1.encodedBytes, firstBodyBytes, signature);
  assert.equal(sent2.encodedBytes, secondBodyBytes, signature);
  const ack = scheduler.acknowledge({
    connectionEpoch: 'epoch-a',
    sessionId: 'session-a',
    deliverySeq: seq2,
    clientBytes: 1,
  });
  assert.deepEqual(ack, { accepted: true, creditedBytes: expectedBytes }, signature);
  assert.equal(scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes, expectedBytes, signature);

  const seq3 = requireAccepted(
    scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'gamma' }),
    signature,
  );
  scheduler.drain();
  const thirdBodyBytes = 5; // 'gamma' = ASCII 5B
  const secondAck = scheduler.acknowledge({
    connectionEpoch: 'epoch-a',
    sessionId: 'session-a',
    deliverySeq: seq3,
    clientBytes: 1,
  });
  // creditedBytes 는 이번 ACK 가 정산한 델타이고, lane.creditBytes 는 누적이다.
  assert.deepEqual(secondAck, { accepted: true, creditedBytes: thirdBodyBytes }, signature);
  assert.equal(
    scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes,
    expectedBytes + thirdBodyBytes,
    signature,
  );
});

test('PERF-BGSTAB-010 ledger measures the exact delivery identity envelope placed on the wire', async () => {
  const signature = 'PERF-BGSTAB-010 AC-5 delivery ledger must include the output wire identity';
  const { scheduler, sent } = await createHarness(signature);
  const deliverySeq = requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-wire',
    sessionId: 'session-wire',
    kind: 'output',
    payload: '🙂 exact wire bytes',
  }), signature);

  scheduler.drain();
  const delivery = sent.find(item => item.deliverySeq === deliverySeq);
  assert.ok(delivery, signature);
  // PERF-BGSTAB-011 AC-1: 원장은 본문 바이트만 센다.
  const exactBodyBytes = 21; // '🙂 exact wire bytes' = '🙂' 4B + ' exact wire bytes' 17B
  assert.equal(delivery.encodedBytes, exactBodyBytes, signature);
  assert.equal(
    scheduler.acknowledge({
      connectionEpoch: 'epoch-wire',
      sessionId: 'session-wire',
      deliverySeq,
    }).creditedBytes,
    exactBodyBytes,
    signature,
  );
});

test('PERF-BGSTAB-010 ledger retains recovery ordering metadata in the fair wire envelope', async () => {
  const signature = 'PERF-BGSTAB-010 AC-1 fair delivery must preserve output recovery metadata';
  const { scheduler, sent } = await createHarness(signature);
  const deliverySeq = requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-recovery-metadata',
    sessionId: 'session-recovery-metadata',
    kind: 'output',
    payload: 'authoritative output',
    screenSeq: 42,
    authorityEpoch: 'authority-42',
    authorityRevision: 9,
    chunkId: 'chunk-42',
  }), signature);

  scheduler.drain();
  const delivery = sent.find(item => item.deliverySeq === deliverySeq);
  assert.ok(delivery, signature);
  assert.deepEqual({
    screenSeq: delivery.screenSeq,
    authorityEpoch: delivery.authorityEpoch,
    authorityRevision: delivery.authorityRevision,
    chunkId: delivery.chunkId,
  }, {
    screenSeq: 42,
    authorityEpoch: 'authority-42',
    authorityRevision: 9,
    chunkId: 'chunk-42',
  }, signature);
  // PERF-BGSTAB-011 AC-1: 위 네 개의 복구 메타데이터는 봉투에 실려도 크레딧을 소모하지 않는다.
  const exactBodyBytes = 20; // 'authoritative output' = ASCII 20B
  assert.equal(delivery.encodedBytes, exactBodyBytes, signature);
  assert.equal(
    scheduler.acknowledge({
      connectionEpoch: 'epoch-recovery-metadata',
      sessionId: 'session-recovery-metadata',
      deliverySeq,
    }).creditedBytes,
    exactBodyBytes,
    signature,
  );
});

test('PERF-BGSTAB-010 transport failure releases the unacknowledgeable ledger entry before authoritative recovery', async () => {
  const signature = 'PERF-BGSTAB-010 AC-5/AC-7 failed transport must not retain ACK credit';
  const { scheduler, fallbacks } = await createHarness(signature);
  const deliverySeq = requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-failed-wire',
    sessionId: 'session-failed-wire',
    kind: 'output',
    payload: 'cannot reach browser',
  }), signature);

  scheduler.drain();
  scheduler.settleTransport({
    connectionEpoch: 'epoch-failed-wire',
    sessionId: 'session-failed-wire',
    deliverySeq,
    error: 'socket-send-failed',
  });
  scheduler.drain();

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.lanes['epoch-failed-wire/session-failed-wire'], undefined, signature);
  assert.equal(snapshot.fallback['epoch-failed-wire/session-failed-wire'].reason, 'transport-send-failed', signature);
  assert.deepEqual(fallbacks, [{
    connectionEpoch: 'epoch-failed-wire',
    sessionId: 'session-failed-wire',
    reason: 'transport-send-failed',
  }], signature);
});

test('PERF-BGSTAB-010 per-session delivery identities stay monotonic when a control frame is queued', async () => {
  const signature = 'PERF-BGSTAB-010 AC-1 control frames must not reorder cumulative ACK identities';
  const { scheduler, sent } = await createHarness(signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-monotonic', sessionId: 'session-monotonic', kind: 'output', payload: 'output-first',
  }), signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-monotonic', sessionId: 'session-monotonic', kind: 'control', payload: 'control-second',
  }), signature);

  scheduler.drain();

  assert.deepEqual(
    sent.map(delivery => [delivery.deliverySeq, delivery.kind]),
    [[1, 'output'], [2, 'control']],
    signature,
  );
  assert.equal(scheduler.acknowledge({
    connectionEpoch: 'epoch-monotonic', sessionId: 'session-monotonic', deliverySeq: 2,
  }).accepted, true, signature);
});

test('PERF-BGSTAB-010 fallback delegates recovery without synthetic terminal output', async () => {
  const signature = 'PERF-BGSTAB-010 AC-7 fallback must delegate to the router recovery authority';
  const { scheduler, sent, fallbacks } = await createHarness(signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-fallback-wire',
    sessionId: 'session-fallback-wire',
    kind: 'output',
    payload: 'legacy delivery',
    capabilities: { ackCredit: false, legacyFallback: true },
  }), signature);
  scheduler.drain();
  assert.deepEqual(sent.map(delivery => [delivery.kind, delivery.payload]), [
    ['output', 'legacy delivery'],
  ], signature);
  assert.deepEqual(fallbacks, [{
    connectionEpoch: 'epoch-fallback-wire',
    sessionId: 'session-fallback-wire',
    reason: 'legacy-client',
  }], signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-6', async () => {
  const signature = 'PERF-BGSTAB-010 AC-6 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler } = await createHarness(signature);
  const oldSeq = requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-old', sessionId: 'session-a', kind: 'output', payload: 'old-epoch' }), signature);
  scheduler.drain();
  assert.equal(scheduler.acknowledge({ connectionEpoch: 'epoch-old', sessionId: 'session-a', deliverySeq: oldSeq }).accepted, true, signature);
  scheduler.closeConnection('epoch-old');
  const seq1 = requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'first' }), signature);
  const seq2 = requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'second' }), signature);
  scheduler.drain({ maxDeliveries: 1 });
  assert.deepEqual(
    scheduler.acknowledge({ connectionEpoch: 'epoch-a', sessionId: 'session-a', deliverySeq: seq2 }),
    { accepted: false, creditedBytes: 0, errorCode: 'ACK_OUT_OF_ORDER' },
    signature,
  );
  assert.equal(scheduler.acknowledge({ connectionEpoch: 'epoch-a', sessionId: 'session-a', deliverySeq: seq1 }).accepted, true, signature);
  scheduler.drain();
  assert.equal(scheduler.acknowledge({ connectionEpoch: 'epoch-a', sessionId: 'session-a', deliverySeq: seq2 }).accepted, true, signature);
  const before = scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes;
  for (const { input, errorCode } of [
    { input: { connectionEpoch: 'epoch-a', sessionId: 'session-a', deliverySeq: seq2 }, errorCode: 'ACK_DUPLICATE' },
    { input: { connectionEpoch: 'epoch-old', sessionId: 'session-a', deliverySeq: oldSeq }, errorCode: 'ACK_STALE_EPOCH' },
    { input: { connectionEpoch: 'epoch-a', sessionId: 'unknown', deliverySeq: seq2 }, errorCode: 'ACK_UNKNOWN_LANE' },
    { input: { connectionEpoch: 'epoch-a', sessionId: 'session-a', deliverySeq: seq2 + 100 }, errorCode: 'ACK_OVER_ACK' },
  ]) {
    const creditBeforeRejection = scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes;
    const rejected = scheduler.acknowledge(input);
    assert.deepEqual(rejected, { accepted: false, creditedBytes: 0, errorCode }, signature);
    assert.equal(scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes, creditBeforeRejection, signature);
  }
  assert.equal(scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes, before, signature);
  const errors = scheduler.snapshot().protocolErrors;
  assert.equal(errors.length, 5, signature);
  assert.deepEqual(errors.map(error => error.code), [
    'ACK_OUT_OF_ORDER',
    'ACK_DUPLICATE',
    'ACK_STALE_EPOCH',
    'ACK_UNKNOWN_LANE',
    'ACK_OVER_ACK',
  ], signature);
  assert.deepEqual(errors.map(error => [error.connectionEpoch, error.sessionId]), [
    ['epoch-a', 'session-a'],
    ['epoch-a', 'session-a'],
    ['epoch-old', 'session-a'],
    ['epoch-a', 'unknown'],
    ['epoch-a', 'session-a'],
  ], signature);
  assert.deepEqual(errors.map(error => error.deliverySeq), [seq2, seq2, oldSeq, seq2, seq2 + 100], signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-7', async () => {
  const signature = 'PERF-BGSTAB-010 AC-7 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler, sent, advance, fallbacks } = await createHarness(signature, {
    policy: {
      queueMaxBytes: { value: 700, source: policySource },
      creditWindowBytes: { value: 512, source: policySource },
    },
  });
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'legacy', sessionId: 'slow', kind: 'output', payload: 'x'.repeat(200),
    capabilities: { ackCredit: false, legacyFallback: true },
  }), signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-a', sessionId: 'slow-credit', kind: 'output', payload: 'x'.repeat(200),
    capabilities: { ackCredit: true, legacyFallback: false },
  }), signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-a', sessionId: 'slow-credit', kind: 'output', payload: 'y'.repeat(200),
    capabilities: { ackCredit: true, legacyFallback: false },
  }), signature);
  scheduler.drain();
  const delayedCreditDelivery = scheduler.enqueue({
    connectionEpoch: 'epoch-a', sessionId: 'slow-credit', kind: 'output', payload: 'z'.repeat(200),
    capabilities: { ackCredit: true, legacyFallback: false },
  });
  assert.equal(delayedCreditDelivery.accepted, true, signature);
  requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-a', sessionId: 'overflow', kind: 'output', payload: 'x'.repeat(400),
    capabilities: { ackCredit: true, legacyFallback: false },
  }), signature);
  const overflow = scheduler.enqueue({
    connectionEpoch: 'epoch-a', sessionId: 'overflow', kind: 'output', payload: 'y'.repeat(400),
    capabilities: { ackCredit: true, legacyFallback: false },
  });
  assert.deepEqual(overflow, { accepted: false, reason: 'queue-overflow' }, signature);
  requireAccepted(scheduler.enqueue({ connectionEpoch: 'modern', sessionId: 'fast', kind: 'output', payload: 'prompt> ' }), signature);
  scheduler.drain();
  const fastDelivery = sent.find(item => item.connectionEpoch === 'modern' && item.sessionId === 'fast' && item.payload === 'prompt> ');
  assert.ok(fastDelivery, signature);
  assert.equal(scheduler.acknowledge({
    connectionEpoch: fastDelivery.connectionEpoch,
    sessionId: fastDelivery.sessionId,
    deliverySeq: fastDelivery.deliverySeq,
  }).accepted, true, signature);
  assert.equal(sent.some(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'slow-credit' && item.payload === 'z'.repeat(200)), false, signature);
  assert.equal(sent.some(item => item.connectionEpoch === 'epoch-a' && item.sessionId === 'slow-credit' && item.kind === 'dataGap'), false, signature);
  assert.equal(
    scheduler.snapshot().lanes['epoch-a/slow-credit'].creditBytes < 200, // 'z'.repeat(200) 의 본문 바이트
    true,
    signature,
  );
  advance(60);
  scheduler.drain();
  assert.equal(sent.some(item => item.connectionEpoch === 'modern' && item.sessionId === 'fast'), true, signature);
  for (const laneId of ['legacy/slow', 'epoch-a/slow-credit']) {
    assert.equal(scheduler.snapshot().fallback[laneId].producerBlocked, false, signature);
    assert.equal(scheduler.snapshot().fallback[laneId].checkpointCount, 1, signature);
  }
  assert.equal(scheduler.snapshot().fallback['legacy/slow'].reason, 'legacy-client', signature);
  assert.equal(scheduler.snapshot().fallback['epoch-a/slow-credit'].reason, 'ack-timeout', signature);
  const overflowFallback = scheduler.snapshot().fallback['epoch-a/overflow'];
  assert.equal(overflowFallback.producerBlocked, false, signature);
  assert.equal(overflowFallback.reason, 'queue-overflow', signature);
  assert.equal(overflowFallback.checkpointCount, 1, signature);
  assert.deepEqual(fallbacks.map(fallback => `${fallback.connectionEpoch}/${fallback.sessionId}:${fallback.reason}`).sort(), [
    'epoch-a/overflow:queue-overflow',
    'epoch-a/slow-credit:ack-timeout',
    'legacy/slow:legacy-client',
  ], signature);
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-8', async () => {
  const signature = 'PERF-BGSTAB-010 AC-8 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const lifecycleTriggers: Array<readonly [name: string, connectionScoped: boolean, trigger: (scheduler: FairTerminalDeliveryScheduler) => void]> = [
    ['downgrade', false, scheduler => scheduler.downgrade({ connectionEpoch: 'epoch-a', sessionId: 'session-a', reason: 'capability-withdrawn' })],
    ['terminate', false, scheduler => scheduler.terminateSession({ connectionEpoch: 'epoch-a', sessionId: 'session-a' })],
    ['rollback', true, scheduler => scheduler.rollbackConnection('epoch-a')],
    ['disconnect', true, scheduler => scheduler.closeConnection('epoch-a')],
  ];

  for (const [, connectionScoped, trigger] of lifecycleTriggers) {
    const { scheduler, sent } = await createHarness(signature);
    const deliveredSeq = requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'delivered-before-release' }), signature);
    requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-a', kind: 'output', payload: 'abandoned-before-release' }), signature);
    if (connectionScoped) {
      requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-a', sessionId: 'session-b', kind: 'output', payload: 'connection-scoped-abandoned' }), signature);
    }
    scheduler.drain({ maxDeliveries: 1 });
    const beforeRelease = scheduler.snapshot();
    assert.equal(beforeRelease.cleanup.timers > 0, true, signature);
    assert.equal(beforeRelease.cleanup.heldBytes > 0, true, signature);
    assert.equal(beforeRelease.cleanup.ledgers > 0, true, signature);
    assert.equal(beforeRelease.cleanup.queues > 0, true, signature);
    trigger(scheduler);
    trigger(scheduler);
    const released = scheduler.snapshot();
    const expectedReleases = connectionScoped
      ? { 'epoch-a/session-a': 1, 'epoch-a/session-b': 1 }
      : { 'epoch-a/session-a': 1 };
    assert.deepEqual(released.cleanup, {
      timers: 0,
      heldBytes: 0,
      ledgers: 0,
      queues: 0,
      releases: expectedReleases,
    }, signature);
    assert.equal(scheduler.acknowledge({ connectionEpoch: 'epoch-a', sessionId: 'session-a', deliverySeq: deliveredSeq }).accepted, false, signature);
    const freshSeq = requireAccepted(scheduler.enqueue({ connectionEpoch: 'epoch-b', sessionId: 'session-a', kind: 'output', payload: 'fresh-epoch' }), signature);
    scheduler.drain();
    assert.equal(sent.some(item => item.connectionEpoch === 'epoch-a' && item.payload === 'abandoned-before-release'), false, signature);
    assert.equal(sent.some(item => item.connectionEpoch === 'epoch-a' && item.payload === 'connection-scoped-abandoned'), false, signature);
    assert.equal(scheduler.snapshot().lanes['epoch-b/session-a'].creditBytes, 0, signature);
    assert.equal(scheduler.acknowledge({ connectionEpoch: 'epoch-b', sessionId: 'session-a', deliverySeq: freshSeq }).accepted, true, signature);
  }
});

test('Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-9', async () => {
  const signature = 'PERF-BGSTAB-010 AC-9 Fair delivery scheduler and ACK credit 계약 부재 때문에 실패';
  const { scheduler, sent, semanticStatusChanges, externalSemanticStatuses } = await createHarness(signature, {
    policy: { queueMaxBytes: { value: 2048, source: policySource } },
  });
  for (const payload of ['echo', 'prompt> ', '\u001b[?25l', 'ticker', 'waiting-for-input']) {
    requireAccepted(scheduler.enqueue({
      connectionEpoch: 'epoch-a',
      sessionId: 'interactive-ai',
      kind: 'output',
      payload,
    }), signature);
  }
  scheduler.drain();
  const lastDelivery = sent.at(-1);
  assert.ok(lastDelivery, signature);
  assert.equal(scheduler.acknowledge({
    connectionEpoch: 'epoch-a', sessionId: 'interactive-ai', deliverySeq: lastDelivery.deliverySeq,
  }).accepted, true, signature);
  assert.equal(externalSemanticStatuses['epoch-a/interactive-ai'], 'idle', signature);
  assert.deepEqual(semanticStatusChanges, [], signature);
  assert.equal(scheduler.snapshot().semanticStatusMutationCount, 0, signature);
  assert.equal(scheduler.snapshot().protocolErrors.length, 0, signature);
});

test('PERF-BGSTAB-011 credit ledger floors an empty body at one budget byte', async () => {
  const signature = 'PERF-BGSTAB-011 AC-1 empty-body delivery must spend exactly one budget byte';
  const { scheduler, sent } = await createHarness(signature);
  const deliverySeq = requireAccepted(scheduler.enqueue({
    connectionEpoch: 'epoch-empty',
    sessionId: 'session-empty',
    kind: 'output',
    payload: '',
  }), signature);
  scheduler.drain();
  const delivery = sent.find(item => item.deliverySeq === deliverySeq);
  assert.ok(delivery, signature);
  // 0 이면 floor 가 붙지 않은 것이고, 119 면 도메인이 봉투로 남은 것이다.
  // 119 = {"type":"output","sessionId":"session-empty",...} 가 아니라 SSOT 가 계산한
  // 'session-a'/'epoch-a' 기준 값이므로 여기서는 두 오답을 값으로 열거하지 않고
  // 정답 하나만 단정한다 — 두 오답 모두 이 단정에서 갈린다.
  assert.equal(delivery.encodedBytes, 1, signature);
  assert.equal(
    scheduler.acknowledge({
      connectionEpoch: 'epoch-empty',
      sessionId: 'session-empty',
      deliverySeq,
    }).creditedBytes,
    1,
    signature,
  );
});

test('PERF-BGSTAB-011 body domain keeps small-output bypass open past the socket soft gate', async () => {
  const signature = 'PERF-BGSTAB-011 AC-1 body-domain deliveries must reach the small-output bypass';
  // 하네스 기본 bulkSliceBytes 128 × driverWeight 2 = quantum 256 이라 아래 어느
  // 본문 크기에서도 deficit 이 개입하지 않는다. soft gate 와 bypass 두 축만 남는다.
  async function sentCount(options: {
    socketSoftGateBytes: number;
    smallOutputBypassBytes: number;
    bodyBytes: number;
  }): Promise<number> {
    const { scheduler, sent } = await createHarness(signature, {
      policy: {
        socketSoftGateBytes: { value: options.socketSoftGateBytes, source: policySource },
        smallOutputBypassBytes: { value: options.smallOutputBypassBytes, source: policySource },
      },
    });
    for (let index = 0; index < 3; index += 1) {
      requireAccepted(scheduler.enqueue({
        connectionEpoch: 'epoch-gate',
        sessionId: 'session-gate',
        kind: 'output',
        payload: 'g'.repeat(options.bodyBytes),
      }), signature);
    }
    scheduler.drain();
    return sent.filter(item => item.sessionId === 'session-gate').length;
  }

  // socketQueuedBytes 는 전송 뒤에 누적되므로 3번째 판정 시점에 80 ≥ 64 가 되어
  // bypass 가지가 처음 필요해진다. 봉투 도메인이었다면 1번째 전송만으로 159 ≥ 64 이고
  // 159 ≤ 128 이 거짓이라 2번째부터 정체했다.
  assert.equal(await sentCount({ socketSoftGateBytes: 64, smallOutputBypassBytes: 128, bodyBytes: 40 }), 3, signature);
  // bypass 임계에 정확히 걸치는 본문은 통과해야 한다.
  assert.equal(await sentCount({ socketSoftGateBytes: 64, smallOutputBypassBytes: 128, bodyBytes: 128 }), 3, signature);
  // 경계 대조군: 1 바이트만 넘기면 첫 전송으로 소켓이 게이트를 넘긴 뒤 정체한다.
  assert.equal(await sentCount({ socketSoftGateBytes: 64, smallOutputBypassBytes: 128, bodyBytes: 129 }), 1, signature);
  // soft gate 경계: bypass 를 닫아 두면 socketQueuedBytes 가 게이트와 같아지는 순간
  // 멈춘다. 32 × 2 = 64 이므로 3번째에서 갈린다.
  assert.equal(await sentCount({ socketSoftGateBytes: 64, smallOutputBypassBytes: 16, bodyBytes: 32 }), 2, signature);
});

test('PERF-BGSTAB-011 body domain charges the deficit only above the bypass threshold', async () => {
  const signature = 'PERF-BGSTAB-011 AC-1 deficit charge must follow the body domain';
  const deficitPolicy = {
    bulkSliceBytes: { value: 8, source: policySource },
    visibilityWeight: { value: 1, source: policySource },
    driverWeight: { value: 1, source: policySource },
    smallOutputBypassBytes: { value: 64, source: policySource },
  };

  async function firstLaneAIndex(laneABodyBytes: number): Promise<number> {
    const { scheduler, sent } = await createHarness(signature, { policy: deficitPolicy });
    // lane A 를 먼저 등록한다 — roundRobinCursor 초기값 0 과 등록 순서가 결과를 정한다.
    requireAccepted(scheduler.enqueue({
      connectionEpoch: 'epoch-drr',
      sessionId: 'lane-a',
      kind: 'output',
      payload: 'a'.repeat(laneABodyBytes),
    }), signature);
    for (let index = 0; index < 9; index += 1) {
      requireAccepted(scheduler.enqueue({
        connectionEpoch: 'epoch-drr',
        sessionId: 'lane-b',
        kind: 'output',
        payload: 'b'.repeat(40),
      }), signature);
    }
    scheduler.drain();
    return sent.findIndex(item => item.sessionId === 'lane-a');
  }

  // 65 > 64 라 lane A 는 quantum 8 을 아홉 번 적립해야 선택된다. 그 사이 lane B 의
  // 40 B 는 40 ≤ 64 로 즉시 spendable 이라 8건이 먼저 나간다.
  assert.equal(await firstLaneAIndex(65), 8, signature);
  // 경계 대조군: 1 바이트만 낮추면 bypass 가 열려 첫 라운드에 선택된다.
  assert.equal(await firstLaneAIndex(64), 0, signature);
});
