// REL-BGSTAB-051 AC-3: lane latency records stay bounded on a long-lived connection, the
// snapshot still works after hundreds of thousands of deliveries, and the maximum is kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFairTerminalDeliveryScheduler } from './wsSendPolicy.js';

const src = 'TerminalResourcePolicy:fair-delivery-candidate';
const policy = {
  strategy: { value: 'policy-selected', source: src },
  socketSoftGateBytes: { value: 1 << 20, source: src },
  bulkSliceBytes: { value: 1 << 16, source: src },
  smallOutputBypassBytes: { value: 32, source: src },
  visibilityWeight: { value: 3, source: src },
  driverWeight: { value: 2, source: src },
  creditWindowBytes: { value: 1 << 20, source: src },
  ackTimeoutMs: { value: 1 << 30, source: src },
  queueMaxBytes: { value: 1 << 20, source: src },
};

test('REL-BGSTAB-051 AC-3: 210,000 deliveries on one lane still snapshot, and the maximum latency survives', () => {
  let now = 1_000;
  const scheduler = createFairTerminalDeliveryScheduler({
    now: () => now,
    policy: policy as never,
    decisionArtifact: { state: 'missing', allRegisteredThresholdsPassed: false, hasUnboundedEligibleLaneStarvation: true } as never,
    send() {},
    onSemanticStatusChange() {},
  } as never);
  const lane = { connectionEpoch: 'epoch-a', sessionId: 's1' };
  const deliver = (wait: number) => {
    const r = scheduler.enqueue({ ...lane, kind: 'output', payload: 'x', serviceClass: 'visible', capabilities: { ackCredit: true, legacyFallback: false } } as never);
    assert.equal(r.accepted, true);
    now += wait;
    scheduler.drain();
    scheduler.acknowledge({ ...lane, deliverySeq: r.deliverySeq!, clientBytes: 1 });
  };
  deliver(5_000);
  for (let i = 0; i < 210_000; i += 1) deliver(0);
  const snapshot = scheduler.snapshot() as { metrics: { lanes: Record<string, { enqueueToCompleteMs: { max: number; p99: number } }> } };
  const metrics = snapshot.metrics.lanes['epoch-a/s1'].enqueueToCompleteMs;
  assert.equal(metrics.max, 5_000, 'the slowest delivery is still the maximum');
  assert.equal(metrics.p99, 0);
});
