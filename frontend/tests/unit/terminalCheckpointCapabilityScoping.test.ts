import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  TerminalCheckpointCapabilityMessage,
  RetainedTerminalMutationLease,
} from '../../src/types/ws-protocol.ts';
import {
  createTerminalCheckpointDispatcherRegistry,
  isTerminalCheckpointMutationLeaseReady,
  mergeTerminalCheckpointMutationLeases,
  reconcileTerminalCheckpointMutationLeases,
  type TerminalCheckpointRuntime,
  type TerminalCheckpointRuntimeState,
} from '../../src/utils/terminalCheckpointRuntime.ts';

const inactiveRuntimeState = (
  viewGeneration: number,
): Readonly<TerminalCheckpointRuntimeState> => ({
  active: false,
  ready: false,
  disposed: false,
  recoveryPending: false,
  legacyRecoveryPending: false,
  checkpointDeliveryPreparationPending: false,
  orderedRollbackPending: false,
  viewGeneration,
  registrationViewGeneration: viewGeneration,
});

const capability = (
  sessionId: string,
  authorityMode: 'legacy' | 'checkpoint',
): TerminalCheckpointCapabilityMessage => ({
  type: 'terminal-checkpoint:capability',
  protocolVersion: 1,
  accepted: true,
  authorityMode,
  checkpointDeliveryActive: authorityMode === 'checkpoint',
  ordinalEncoding: 'canonical-uint64-decimal',
  digestAlgorithms: ['sha256'],
  registeredViews: [{ sessionId, viewGeneration: 1 }],
});

function dispatcher(received: Array<TerminalCheckpointCapabilityMessage | null>): TerminalCheckpointRuntime {
  return {
    setCapability: next => {
      received.push(next);
      return { accepted: true };
    },
    handleMessage: () => ({ accepted: true }),
    submitInput: () => ({ accepted: true }),
    checkpointApplied: () => ({ accepted: true }),
    checkpointDrained: () => ({ accepted: true }),
    coordinatorRecoveryFailed: () => ({ accepted: true }),
    rollbackToLegacy: () => ({ accepted: true }),
    beginCompatibilityRollback: () => ({ accepted: true }),
    beginLegacyRecovery: () => ({ accepted: true }),
    completeLegacyRecovery: () => ({ accepted: true }),
    getState: () => inactiveRuntimeState(1),
    dispose: () => undefined,
  };
}

test('MIG-BGSTAB-002 capability updates are scoped per session and rollback cannot disable another session', () => {
  const a: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const b: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-a', dispatcher(a));
  registry.register('session-b', dispatcher(b));

  registry.setCapability(capability('session-a', 'checkpoint'));
  registry.setCapability(capability('session-b', 'checkpoint'));
  registry.setCapability(capability('session-b', 'legacy'));

  assert.equal(a.at(-1)?.authorityMode, 'checkpoint');
  assert.equal(b.at(-1)?.authorityMode, 'legacy');
  assert.equal(a.filter(value => value?.authorityMode === 'legacy').length, 0);
});

test('MIG-BGSTAB-002 checkpoint capability without a lease preserves other and suspended-session mutation leases', () => {
  const leaseA: RetainedTerminalMutationLease = {
    sessionId: 'session-a',
    authorityEpoch: '1',
    viewGeneration: 1,
    leaseGeneration: '11',
  };
  const leaseB: RetainedTerminalMutationLease = {
    sessionId: 'session-b',
    authorityEpoch: '1',
    viewGeneration: 1,
    leaseGeneration: '12',
  };
  const current = new Map([
    [leaseA.sessionId, leaseA],
    [leaseB.sessionId, leaseB],
  ]);

  const merged = mergeTerminalCheckpointMutationLeases(
    current,
    capability('session-a', 'checkpoint'),
  );

  assert.deepEqual([...merged.entries()], [...current.entries()]);
});

test('MIG-BGSTAB-002 checkpoint input remains fenced until its exact view lease arrives', () => {
  const checkpointWithoutLease = capability('session-a', 'checkpoint');
  const checkpointWithExactLease: TerminalCheckpointCapabilityMessage = {
    ...checkpointWithoutLease,
    mutationLeases: [{
      sessionId: 'session-a',
      authorityEpoch: '1',
      viewGeneration: 1,
      leaseGeneration: '11',
    }],
  };
  const checkpointWithStaleLease: TerminalCheckpointCapabilityMessage = {
    ...checkpointWithExactLease,
    mutationLeases: [{
      sessionId: 'session-a',
      authorityEpoch: '1',
      viewGeneration: 2,
      leaseGeneration: '12',
    }],
  };

  assert.equal(isTerminalCheckpointMutationLeaseReady(checkpointWithoutLease, 'session-a', 1), false);
  assert.equal(isTerminalCheckpointMutationLeaseReady(checkpointWithStaleLease, 'session-a', 1), false);
  assert.equal(isTerminalCheckpointMutationLeaseReady(checkpointWithExactLease, 'session-a', 1), true);
  assert.equal(isTerminalCheckpointMutationLeaseReady(capability('session-a', 'legacy'), 'session-a', 1), false);
});

test('MIG-BGSTAB-002 rejected capability application cannot admit attributes or keep authority active', () => {
  const registry = createTerminalCheckpointDispatcherRegistry();
  const received: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const rejected = dispatcher(received);
  rejected.setCapability = next => {
    received.push(next);
    return next?.authorityMode === 'legacy'
      ? { accepted: false, reason: 'checkpoint-coordinator-unavailable' }
      : { accepted: true };
  };
  registry.register('session-a', rejected);
  assert.notEqual(registry.setCapability(capability('session-a', 'checkpoint')), null);

  assert.equal(registry.setCapability(capability('session-a', 'legacy')), null);
  assert.deepEqual(
    registry.route({
      type: 'terminal-checkpoint:rejected',
      supportedProtocolVersion: 1,
      sessionId: 'session-a',
      phase: 'ack',
      reason: 'checkpoint-not-active',
    }),
    { delivered: false, reason: 'checkpoint-delivery-inactive' },
  );
});

test('MIG-BGSTAB-002 retiring capability generation removes its old mutation lease', () => {
  const oldLease: RetainedTerminalMutationLease = {
    sessionId: 'session-a',
    authorityEpoch: '1',
    viewGeneration: 1,
    leaseGeneration: '11',
  };
  const otherLease: RetainedTerminalMutationLease = {
    sessionId: 'session-b',
    authorityEpoch: '1',
    viewGeneration: 1,
    leaseGeneration: '12',
  };
  const attempted = capability('session-a', 'legacy');
  const reconciled = reconcileTerminalCheckpointMutationLeases(
    new Map([
      [oldLease.sessionId, oldLease],
      [otherLease.sessionId, otherLease],
    ]),
    attempted,
    null,
  );

  assert.deepEqual([...reconciled.entries()], [[otherLease.sessionId, otherLease]]);
});

test('MIG-BGSTAB-002 empty authority withdrawal clears every retained mutation lease', () => {
  const lease: RetainedTerminalMutationLease = {
    sessionId: 'session-a',
    authorityEpoch: '1',
    viewGeneration: 1,
    leaseGeneration: '11',
  };
  const withdrawal: TerminalCheckpointCapabilityMessage = {
    ...capability('session-a', 'legacy'),
    registeredViews: [],
    mutationLeases: [],
  };

  assert.equal(
    reconcileTerminalCheckpointMutationLeases(new Map([[lease.sessionId, lease]]), withdrawal, withdrawal).size,
    0,
  );
});

test('MIG-BGSTAB-002 applied same-generation capability without a lease preserves its current lease', () => {
  const lease: RetainedTerminalMutationLease = {
    sessionId: 'session-a',
    authorityEpoch: '1',
    viewGeneration: 1,
    leaseGeneration: '11',
  };
  const applied = capability('session-a', 'checkpoint');

  assert.deepEqual(
    [...reconcileTerminalCheckpointMutationLeases(
      new Map([[lease.sessionId, lease]]),
      applied,
      applied,
    ).entries()],
    [[lease.sessionId, lease]],
  );
});

test('MIG-BGSTAB-002 future capability is applied once when the replacement dispatcher reaches its generation', () => {
  const registry = createTerminalCheckpointDispatcherRegistry();
  const generationOneReceived: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const generationTwoReceived: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const unregisterGenerationOne = registry.register('session-a', dispatcher(generationOneReceived));
  const futureCapability: TerminalCheckpointCapabilityMessage = {
    ...capability('session-a', 'checkpoint'),
    registeredViews: [{ sessionId: 'session-a', viewGeneration: 2 }],
  };

  assert.equal(registry.selectFreshCapability(futureCapability), null);
  assert.equal(
    generationOneReceived.some(value => value?.registeredViews?.[0]?.viewGeneration === 2),
    false,
  );

  unregisterGenerationOne();
  const generationTwoDispatcher = dispatcher(generationTwoReceived);
  generationTwoDispatcher.getState = () => inactiveRuntimeState(2);
  registry.register('session-a', generationTwoDispatcher);

  assert.equal(generationTwoReceived.at(-1)?.registeredViews?.[0]?.viewGeneration, 2);
  assert.deepEqual(registry.takeAppliedRegistrationCapability('session-a'), futureCapability);
  assert.equal(registry.takeAppliedRegistrationCapability('session-a'), null);
});

test('MIG-BGSTAB-002 same-turn replacement republishes its cached exact capability and lease once', () => {
  const registry = createTerminalCheckpointDispatcherRegistry();
  const firstReceived: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const replacementReceived: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const cachedCapability: TerminalCheckpointCapabilityMessage = {
    ...capability('session-a', 'checkpoint'),
    mutationLeases: [{
      sessionId: 'session-a',
      authorityEpoch: '3',
      viewGeneration: 1,
      leaseGeneration: '9',
    }],
  };
  const unregister = registry.register('session-a', dispatcher(firstReceived));
  assert.deepEqual(registry.setCapability(cachedCapability), cachedCapability);
  unregister();

  registry.register('session-a', dispatcher(replacementReceived));

  assert.deepEqual(registry.takeAppliedRegistrationCapability('session-a'), cachedCapability);
  assert.equal(registry.takeAppliedRegistrationCapability('session-a'), null);
});

test('MIG-BGSTAB-002 replacement capability publication is scoped to that session only', () => {
  const registry = createTerminalCheckpointDispatcherRegistry();
  const a: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const b: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const unregisterA = registry.register('session-a', dispatcher(a));
  registry.register('session-b', dispatcher(b));
  const multiSessionCapability: TerminalCheckpointCapabilityMessage = {
    ...capability('session-a', 'checkpoint'),
    registeredViews: [
      { sessionId: 'session-a', viewGeneration: 1 },
      { sessionId: 'session-b', viewGeneration: 1 },
    ],
    mutationLeases: [
      { sessionId: 'session-a', authorityEpoch: '3', viewGeneration: 1, leaseGeneration: '7' },
      { sessionId: 'session-b', authorityEpoch: '3', viewGeneration: 1, leaseGeneration: '8' },
    ],
  };
  registry.setCapability(multiSessionCapability);
  unregisterA();
  registry.register('session-a', dispatcher([]));

  const applied = registry.takeAppliedRegistrationCapability('session-a');
  assert.deepEqual(applied?.registeredViews, [{ sessionId: 'session-a', viewGeneration: 1 }]);
  assert.deepEqual(applied?.mutationLeases, [
    { sessionId: 'session-a', authorityEpoch: '3', viewGeneration: 1, leaseGeneration: '7' },
  ]);
});

test('MIG-BGSTAB-002 empty withdrawal cancels a deferred future capability before registration', () => {
  const registry = createTerminalCheckpointDispatcherRegistry();
  const generationOne: Array<TerminalCheckpointCapabilityMessage | null> = [];
  const unregister = registry.register('session-a', dispatcher(generationOne));
  const futureCapability: TerminalCheckpointCapabilityMessage = {
    ...capability('session-a', 'checkpoint'),
    registeredViews: [{ sessionId: 'session-a', viewGeneration: 2 }],
  };
  assert.equal(registry.selectFreshCapability(futureCapability), null);
  registry.setCapability({
    ...capability('session-a', 'legacy'),
    registeredViews: [],
    mutationLeases: [],
  });
  unregister();
  const generationTwo = dispatcher([]);
  generationTwo.getState = () => inactiveRuntimeState(2);
  registry.register('session-a', generationTwo);

  assert.equal(registry.takeAppliedRegistrationCapability('session-a'), null);
});
