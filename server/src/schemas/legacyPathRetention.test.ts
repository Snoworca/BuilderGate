import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configSchema } from './config.schema.js';
import { TERMINAL_PATH_GATE_KEYS } from './terminalPathGateKeys.js';
import {
  createFairTerminalDeliveryScheduler,
  type FairTerminalDelivery,
  type FairTerminalDeliveryPolicy,
} from '../ws/wsSendPolicy.js';

/**
 * OPS-BGSTAB-016 — the old terminal path must stay reachable while the new one is
 * promoted. #21 asks for the flip and the retention in one breath, and the retention half
 * is the one nobody notices going missing: it has no user visiting it until the day the
 * rollback is needed.
 *
 * @req OPS-BGSTAB-016
 */

/**
 * A config shaped the way one was before any terminal-path gate key existed: the three
 * blocks the schema has always required, and nothing else. `{}` is deliberately not used
 * -- it does not parse, which is a separate defect in `config.ts`'s fallback-defaults path
 * and not this requirement's subject.
 */
const LEGACY_SHAPED_CONFIG = { server: {}, pty: {}, session: {} } as const;

function readPath(root: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (node, part) => (node as Record<string, unknown> | undefined)?.[part],
    root,
  );
}

test('OPS-BGSTAB-016 AC-1: a config predating every gate key still parses, and each key lands on its inventoried default', () => {
  // Not a hand-written expectation beside the fixture: the expectation is read from the
  // single inventory expression, so a schema default that drifts away from what the
  // inventory documents fails here rather than being discovered during a rollback.
  const parsed = configSchema.parse(LEGACY_SHAPED_CONFIG);

  const drift: string[] = [];
  for (const [name, descriptor] of TERMINAL_PATH_GATE_KEYS) {
    const actual = readPath(parsed, descriptor.path);
    if (actual === undefined) {
      drift.push(`${name}: ${descriptor.path} is absent after parsing a config that omits it`);
      continue;
    }
    if (actual !== descriptor.schemaDefault) {
      drift.push(`${name}: inventory says ${descriptor.schemaDefault}, schema produced ${String(actual)}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('OPS-BGSTAB-016 AC-1: the guard is not vacuous -- the inventory is non-empty and every key was actually read', () => {
  // The cheapest thing that satisfies the test above is an empty inventory, so measure it.
  assert.ok(TERMINAL_PATH_GATE_KEYS.size >= 6, `inventory holds ${TERMINAL_PATH_GATE_KEYS.size} keys`);
  const parsed = configSchema.parse(LEGACY_SHAPED_CONFIG);
  for (const descriptor of TERMINAL_PATH_GATE_KEYS.values()) {
    assert.notEqual(readPath(parsed, descriptor.path), undefined, `${descriptor.path} unreadable`);
  }
});

function policy(): FairTerminalDeliveryPolicy {
  const at = <T>(value: T) => ({ value, source: 'OPS-BGSTAB-016 retention fixture' });
  return {
    strategy: at('deficit-round-robin'),
    socketSoftGateBytes: at(1 << 20),
    bulkSliceBytes: at(1 << 16),
    smallOutputBypassBytes: at(1 << 14),
    visibilityWeight: at(1),
    driverWeight: at(1),
    creditWindowBytes: at(1 << 20),
    ackTimeoutMs: at(10_000),
    queueMaxBytes: at(1 << 20),
  };
}

function scheduler() {
  const sent: FairTerminalDelivery[] = [];
  let now = 0;
  const instance = createFairTerminalDeliveryScheduler({
    now: () => (now += 1),
    policy: policy(),
    decisionArtifact: {
      state: 'complete',
      allRegisteredThresholdsPassed: true,
      hasUnboundedEligibleLaneStarvation: false,
    },
    send: (delivery) => { sent.push(delivery); },
    onSemanticStatusChange: () => {},
  });
  return { instance, sent };
}

test('OPS-BGSTAB-016 AC-2: an old client that cannot ack is served and marked for legacy fallback', () => {
  const { instance, sent } = scheduler();
  const lane = { connectionEpoch: 'mixed-version', sessionId: 'old-client' };

  const accepted = instance.enqueue({
    ...lane,
    kind: 'output',
    payload: 'output for a client that predates ack credit',
    capabilities: { ackCredit: false, legacyFallback: true },
  });
  assert.equal(accepted.accepted, true, `old client refused: ${accepted.reason}`);

  instance.drain();

  // Served, not merely accepted: the whole point of downgrade is that the old client still
  // sees output without ever acking.
  assert.equal(sent.length, 1, 'the old client was accepted into the queue but never served');
  assert.equal(instance.getFallbackReason(lane), 'legacy-client');
});

test('OPS-BGSTAB-016 AC-2: a new client on the same scheduler is not marked for legacy fallback', () => {
  // The control: without it, a scheduler that marks every lane legacy would pass above.
  const { instance } = scheduler();
  const lane = { connectionEpoch: 'mixed-version', sessionId: 'new-client' };
  instance.enqueue({
    ...lane,
    kind: 'output',
    payload: 'output for a client that acks',
    capabilities: { ackCredit: true, legacyFallback: false },
  });
  instance.drain();
  assert.equal(instance.getFallbackReason(lane), undefined);
});
