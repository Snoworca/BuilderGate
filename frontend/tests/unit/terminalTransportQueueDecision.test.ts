import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveStaleSocketReconnectDecision } from '../../src/utils/terminalTransportQueueDecision.ts';

test('stale socket failure queues during the reconnect grace window', () => {
  const decision = resolveStaleSocketReconnectDecision({
    reconnectStartedAt: null,
    now: 10_000,
    reconnectTtlMs: 3000,
  });

  assert.deepEqual(decision, {
    action: 'queue',
    reconnectStartedAt: 10_000,
  });
});

test('stale socket failure remains queued while existing reconnect grace is active', () => {
  const decision = resolveStaleSocketReconnectDecision({
    reconnectStartedAt: 10_000,
    now: 12_999,
    reconnectTtlMs: 3000,
  });

  assert.deepEqual(decision, {
    action: 'queue',
    reconnectStartedAt: 10_000,
  });
});

test('stale socket failure rejects after reconnect grace expires', () => {
  const decision = resolveStaleSocketReconnectDecision({
    reconnectStartedAt: 10_000,
    now: 13_001,
    reconnectTtlMs: 3000,
  });

  assert.deepEqual(decision, {
    action: 'reject',
    reconnectStartedAt: 10_000,
  });
});
