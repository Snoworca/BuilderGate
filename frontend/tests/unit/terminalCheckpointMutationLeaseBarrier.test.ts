import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TerminalCheckpointCapabilityMessage } from '../../src/types/ws-protocol.ts';
import { resolveTerminalCheckpointMutationLeaseBarrier } from '../../src/utils/terminalCheckpointRuntime.ts';

const capability = (
  overrides: Partial<TerminalCheckpointCapabilityMessage> = {},
): TerminalCheckpointCapabilityMessage => ({
  type: 'terminal-checkpoint:capability',
  protocolVersion: 1,
  accepted: true,
  authorityMode: 'checkpoint',
  checkpointDeliveryActive: true,
  ordinalEncoding: 'canonical-uint64-decimal',
  digestAlgorithms: ['sha256'],
  registeredViews: [{ sessionId: 'session-a', viewGeneration: 1 }],
  ...overrides,
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a granted lease for this exact view lowers the mutation-lease barrier', () => {
  const decision = resolveTerminalCheckpointMutationLeaseBarrier(
    capability({
      mutationLeases: [{
        sessionId: 'session-a',
        authorityEpoch: '1',
        viewGeneration: 1,
        leaseGeneration: '11',
      }],
    }),
    'session-a',
    1,
  );
  assert.deepEqual(decision, { held: false, reason: 'lease-granted' });
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a capability that registers this view but carries no lease must not hold input forever', () => {
  // Measured 2026-09-19 against https://localhost:2222: the server accepted the view,
  // refused the mutation lease, and sent a lease-less capability with no reason. The
  // browser held every keystroke for the full 60s poll with barrierReason
  // "checkpoint-pending". Registration is the server's answer; a missing lease in that
  // answer is a refusal, not an unfinished negotiation.
  const decision = resolveTerminalCheckpointMutationLeaseBarrier(capability(), 'session-a', 1);
  assert.equal(decision.held, false);
  assert.equal(decision.reason, 'lease-refused');
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 the wire-carried refusal reason reaches the barrier decision', () => {
  const decision = resolveTerminalCheckpointMutationLeaseBarrier(
    capability({
      mutationLeaseRefusals: [{
        sessionId: 'session-a',
        viewGeneration: 1,
        reason: 'driver-owned-by-other-client',
      }],
    }),
    'session-a',
    1,
  );
  assert.deepEqual(decision, {
    held: false,
    reason: 'lease-refused',
    refusalReason: 'driver-owned-by-other-client',
  });
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a capability that does not register this view is still an unfinished negotiation', () => {
  const otherView = resolveTerminalCheckpointMutationLeaseBarrier(
    capability({ registeredViews: [{ sessionId: 'session-b', viewGeneration: 1 }] }),
    'session-a',
    1,
  );
  assert.deepEqual(otherView, { held: true, reason: 'view-not-registered' });

  const staleGeneration = resolveTerminalCheckpointMutationLeaseBarrier(
    capability({ registeredViews: [{ sessionId: 'session-a', viewGeneration: 1 }] }),
    'session-a',
    2,
  );
  assert.deepEqual(staleGeneration, { held: true, reason: 'view-not-registered' });

  const emptyNegotiate = resolveTerminalCheckpointMutationLeaseBarrier(
    capability({ registeredViews: undefined, authorityMode: 'legacy', checkpointDeliveryActive: false }),
    'session-a',
    1,
  );
  assert.deepEqual(emptyNegotiate, { held: true, reason: 'view-not-registered' });
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a lease for a different view generation does not satisfy this one', () => {
  const decision = resolveTerminalCheckpointMutationLeaseBarrier(
    capability({
      mutationLeases: [{
        sessionId: 'session-a',
        authorityEpoch: '1',
        viewGeneration: 2,
        leaseGeneration: '12',
      }],
    }),
    'session-a',
    1,
  );
  assert.equal(decision.held, false);
  assert.equal(decision.reason, 'lease-refused');
});
