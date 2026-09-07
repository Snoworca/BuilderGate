import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';
import { createFairTerminalDeliveryScheduler } from './wsSendPolicy.js';

// PERF-BGSTAB-011 AC-10: domain accounting uses the production scheduler type.
function harness() {
  const scheduler = createFairTerminalDeliveryScheduler({
    now: () => 1000,
    policy: resolveFairTerminalDeliveryPolicy({
      serverBufferedHighWaterBytes: 1024,
      perClientOutputQueueMaxBytes: 1024,
      perClientControlQueueMaxBytes: 1024,
      outputCoalesceWindowMs: 1,
    }),
    decisionArtifact: { state: 'complete', allRegisteredThresholdsPassed: true, hasUnboundedEligibleLaneStarvation: false },
    send() {},
    onSemanticStatusChange() { assert.fail('ACK accounting must not change session status'); },
  });
  return scheduler;
}

const lane = { connectionEpoch: 'connection-a', sessionId: 'session-a' };

// Compile-only contracts: this function is never invoked by the runtime tests.
function assertProductionAckParameterTypes() {
  type AckInput = Parameters<ReturnType<typeof createFairTerminalDeliveryScheduler>['acknowledge']>[0];
  const legacy: AckInput = { ...lane, deliverySeq: 1 };
  const explicitLegacy: AckInput = { ...lane, kind: 'deliverySeq', deliverySeq: 1 };
  const source: AckInput = { ...lane, kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '1' };
  // @ts-expect-error A source ACK cannot also carry the legacy delivery domain.
  const mixed: AckInput = { ...lane, kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '1', deliverySeq: 1 };
  // @ts-expect-error A source ACK must identify its stream epoch.
  const missingEpoch: AckInput = { ...lane, kind: 'sourceSeq', sourceSeq: '1' };
  return { legacy, explicitLegacy, source, mixed, missingEpoch };
}

function enqueue(scheduler: ReturnType<typeof harness>, sourceSeq: string, payload: string, streamEpoch = '7') {
  assert.equal(scheduler.enqueue({ ...lane, kind: 'output', streamEpoch, sourceSeq, payload }).accepted, true);
}

function acknowledgeSource(scheduler: ReturnType<typeof harness>, sourceSeq: string, streamEpoch = '7') {
  return scheduler.acknowledge({ ...lane, kind: 'sourceSeq', streamEpoch, sourceSeq });
}

test('ACK-04 source ACK returns first and second deltas without using the lane ceiling', () => {
  const scheduler = harness();
  enqueue(scheduler, '9007199254740993', 'abc');
  enqueue(scheduler, '9007199254740995', '12345');
  scheduler.drain();
  assert.deepEqual(acknowledgeSource(scheduler, '9007199254740993'), { accepted: true, creditedBytes: 3 });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 3);
  assert.deepEqual(acknowledgeSource(scheduler, '9007199254740995'), { accepted: true, creditedBytes: 5 });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 8);
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].socketQueuedBytes, 0);
});

test('ACK-05 source and legacy ACKs settle output and source-less dataGap once in either order', () => {
  for (const sourceFirst of [false, true]) {
    const scheduler = harness();
    enqueue(scheduler, '100', 'abc');
    assert.equal(scheduler.enqueue({ ...lane, kind: 'dataGap', payload: 'gap!' }).accepted, true);
    enqueue(scheduler, '103', '12345');
    scheduler.drain();
    if (sourceFirst) {
      assert.deepEqual(acknowledgeSource(scheduler, '103'), { accepted: true, creditedBytes: 12 });
      assert.equal(scheduler.acknowledge({ ...lane, deliverySeq: 2 }).errorCode, 'ACK_DUPLICATE');
    } else {
      assert.deepEqual(acknowledgeSource(scheduler, '100'), { accepted: true, creditedBytes: 3 });
      assert.deepEqual(scheduler.acknowledge({ ...lane, deliverySeq: 2, clientBytes: 999999 }), { accepted: true, creditedBytes: 4 });
      assert.deepEqual(acknowledgeSource(scheduler, '103'), { accepted: true, creditedBytes: 5 });
    }
    assert.equal(acknowledgeSource(scheduler, '100').errorCode, 'ACK_DUPLICATE');
    assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 12);
    assert.deepEqual(scheduler.snapshot().lanes['connection-a/session-a'].sentDeliverySeqs, []);
  }
});

test('ACK-04 adjacent source ordinals above Number precision return distinct deltas', () => {
  const scheduler = harness();
  enqueue(scheduler, '9007199254740992', 'abc');
  enqueue(scheduler, '9007199254740993', '12345');
  scheduler.drain();
  assert.deepEqual(acknowledgeSource(scheduler, '9007199254740992'), { accepted: true, creditedBytes: 3 });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].socketQueuedBytes, 5);
  assert.deepEqual(acknowledgeSource(scheduler, '9007199254740993'), { accepted: true, creditedBytes: 5 });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 8);
});

test('ACK-04 adjacent stream epochs above Number precision keep identical source ordinals distinct', () => {
  const scheduler = harness();
  enqueue(scheduler, '0', 'abc', '9007199254740992');
  enqueue(scheduler, '0', '12345', '9007199254740993');
  scheduler.drain();
  assert.deepEqual(acknowledgeSource(scheduler, '0', '9007199254740992'), { accepted: true, creditedBytes: 3 });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].socketQueuedBytes, 5);
  assert.deepEqual(acknowledgeSource(scheduler, '0', '9007199254740993'), { accepted: true, creditedBytes: 5 });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 8);
});

test('ACK-05 a legacy cumulative ACK settles source output before a repeated source ACK', () => {
  const scheduler = harness();
  enqueue(scheduler, '100', 'abc');
  assert.equal(scheduler.enqueue({ ...lane, kind: 'dataGap', payload: 'gap!' }).accepted, true);
  enqueue(scheduler, '103', '12345');
  scheduler.drain();
  assert.deepEqual(scheduler.acknowledge({ ...lane, deliverySeq: 3 }), { accepted: true, creditedBytes: 12 });
  assert.deepEqual(acknowledgeSource(scheduler, '103'), { accepted: false, creditedBytes: 0, errorCode: 'ACK_DUPLICATE' });
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 12);
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].socketQueuedBytes, 0);
  assert.deepEqual(scheduler.snapshot().lanes['connection-a/session-a'].sentDeliverySeqs, []);
});

test('ACK-06 source distinguishes issued-but-unsent, holes and over-ACK without releasing credit', () => {
  const scheduler = harness();
  enqueue(scheduler, '100', 'abc');
  enqueue(scheduler, '103', '12345');
  scheduler.drain({ maxDeliveries: 1 });
  assert.equal(acknowledgeSource(scheduler, '103').errorCode, 'ACK_OUT_OF_ORDER');
  assert.equal(acknowledgeSource(scheduler, '101').errorCode, 'ACK_OUT_OF_ORDER');
  assert.equal(acknowledgeSource(scheduler, '104').errorCode, 'ACK_OVER_ACK');
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 0);
  assert.deepEqual(acknowledgeSource(scheduler, '100'), { accepted: true, creditedBytes: 3 });
  scheduler.drain();
  assert.deepEqual(acknowledgeSource(scheduler, '103'), { accepted: true, creditedBytes: 5 });
});

test('ACK-06 rollover preserves an outstanding old-epoch entry and accepts source zero in the next epoch', () => {
  const scheduler = harness();
  enqueue(scheduler, '18446744073709551615', 'old');
  enqueue(scheduler, '0', 'new!', '9');
  enqueue(scheduler, '1', 'tail!', '9');
  scheduler.drain();
  assert.deepEqual(acknowledgeSource(scheduler, '18446744073709551615'), { accepted: true, creditedBytes: 3 });
  assert.deepEqual(acknowledgeSource(scheduler, '0', '9'), { accepted: true, creditedBytes: 4 });
  assert.deepEqual(acknowledgeSource(scheduler, '1', '9'), { accepted: true, creditedBytes: 5 });
  assert.equal(acknowledgeSource(scheduler, '18446744073709551615').errorCode, 'ACK_DUPLICATE');
});

test('ACK-06 a source-less lane cannot acknowledge an invented source identity', () => {
  const scheduler = harness();
  scheduler.enqueue({ ...lane, kind: 'dataGap', payload: 'gap' });
  scheduler.drain();
  assert.equal(acknowledgeSource(scheduler, '1').errorCode, 'ACK_OVER_ACK');
  assert.deepEqual(scheduler.acknowledge({ ...lane, deliverySeq: 1 }), { accepted: true, creditedBytes: 3 });
});

test('ACK-02 recreated delivery lane retains the new session source floor and two delta credits', () => {
  const first = harness();
  enqueue(first, '40', 'old');
  first.drain();
  first.closeConnection(lane.connectionEpoch);
  assert.equal(acknowledgeSource(first, '40').errorCode, 'ACK_STALE_EPOCH');
  const next = harness();
  enqueue(next, '43', 'one');
  enqueue(next, '44', 'two!');
  next.drain();
  assert.deepEqual(next.snapshot().lanes['connection-a/session-a'].sentDeliverySeqs, [1, 2]);
  assert.equal(acknowledgeSource(next, '42').errorCode, 'ACK_DUPLICATE');
  assert.deepEqual(acknowledgeSource(next, '43'), { accepted: true, creditedBytes: 3 });
  assert.deepEqual(acknowledgeSource(next, '44'), { accepted: true, creditedBytes: 4 });
});

test('ACK-07 both and missing domains are rejected before unknown-lane validation', () => {
  const scheduler = harness();
  assert.equal(scheduler.acknowledge({ ...lane, kind: 'sourceSeq', sourceSeq: '1', streamEpoch: '7', deliverySeq: 1 } as never).errorCode, 'ACK_DOMAIN_CONFLICT');
  assert.equal(scheduler.acknowledge({ ...lane } as never).errorCode, 'ACK_DOMAIN_MISSING');
  assert.equal(acknowledgeSource(scheduler, '1').errorCode, 'ACK_UNKNOWN_LANE');
});

test('ACK-07 malformed source values and unknown kind take precedence over an unknown lane', () => {
  const scheduler = harness();
  for (const identity of [
    { kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '01' },
    { kind: 'sourceSeq', streamEpoch: '18446744073709551616', sourceSeq: '1' },
    { kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '18446744073709551616' },
    { kind: 'sourceSeq', sourceSeq: '1' },
    { kind: 'unknown', streamEpoch: '7', sourceSeq: '1' },
  ]) {
    assert.equal(scheduler.acknowledge({ ...lane, ...identity } as never).errorCode, 'ACK_DOMAIN_INVALID');
  }
  assert.deepEqual(scheduler.snapshot().lanes, {}, 'invalid domains must not create a lane');
});

test('ACK-07 invalid source domain values are observable and do not mutate the ledger', () => {
  const scheduler = harness();
  enqueue(scheduler, '1', 'abc');
  scheduler.drain();
  for (const identity of [
    { kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '01' },
    { kind: 'sourceSeq', streamEpoch: '18446744073709551616', sourceSeq: '1' },
    { kind: 'sourceSeq', streamEpoch: '7' },
    { kind: 'unknown', streamEpoch: '7', sourceSeq: '1' },
  ]) {
    assert.equal(scheduler.acknowledge({ ...lane, ...identity } as never).errorCode, 'ACK_DOMAIN_INVALID');
  }
  assert.equal(scheduler.snapshot().lanes['connection-a/session-a'].creditBytes, 0);
  assert.deepEqual(acknowledgeSource(scheduler, '1'), { accepted: true, creditedBytes: 3 });
});

test('ACK-07 the first source tuple at the absolute zero boundary is acknowledged', () => {
  const scheduler = harness();
  enqueue(scheduler, '0', '', '0');
  scheduler.drain();
  assert.deepEqual(acknowledgeSource(scheduler, '0', '0'), { accepted: true, creditedBytes: 1 });
  assert.equal(acknowledgeSource(scheduler, '0', '0').errorCode, 'ACK_DUPLICATE');
});

test('ACK-10 source error diagnostics preserve the provided tuple', () => {
  const scheduler = harness();
  enqueue(scheduler, '10', 'abc');
  scheduler.drain();
  acknowledgeSource(scheduler, '11');
  const diagnostic = scheduler.snapshot().protocolErrors.at(-1)!;
  assert.ok(diagnostic, 'a rejected source ACK must leave an observable diagnostic');
  assert.equal(diagnostic.code, 'ACK_OVER_ACK');
  assert.equal(Reflect.get(diagnostic, 'kind'), 'sourceSeq');
  assert.equal(Reflect.get(diagnostic, 'streamEpoch'), '7');
  assert.equal(Reflect.get(diagnostic, 'sourceSeq'), '11');
  assert.equal(diagnostic.connectionEpoch, lane.connectionEpoch);
  assert.equal(diagnostic.sessionId, lane.sessionId);
});

test('legacy ACK guard precedence and issued-but-unsent distinction remain unchanged', () => {
  const scheduler = harness();
  enqueue(scheduler, '10', 'one');
  enqueue(scheduler, '11', 'two');
  scheduler.drain({ maxDeliveries: 1 });
  assert.equal(scheduler.acknowledge({ ...lane, deliverySeq: 0 }).errorCode, 'ACK_DUPLICATE');
  assert.equal(scheduler.acknowledge({ ...lane, deliverySeq: 3 }).errorCode, 'ACK_OVER_ACK');
  assert.equal(scheduler.acknowledge({ ...lane, deliverySeq: 2 }).errorCode, 'ACK_OUT_OF_ORDER');
  assert.deepEqual(scheduler.acknowledge({ ...lane, deliverySeq: 1 }), { accepted: true, creditedBytes: 3 });
});
