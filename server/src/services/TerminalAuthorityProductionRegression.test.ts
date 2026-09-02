import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createTerminalAuthorityController,
  type TerminalAuthorityControllerOptions,
  type TerminalAuthorityResponderIdentity,
  type TerminalAuthorityResponderViewIdentity,
} from './TerminalAuthorityController.js';
import {
  isServerOutputCoveredByPendingViewRecovery,
  isCheckpointOutputAuthorityMode,
  isValidCheckpointDrainWatermark,
  isSupersededTerminalCheckpointAck,
  terminalAuthorityFramePumpKey,
  shouldDeferTerminalAuthorityFrameDrain,
} from './TerminalAuthorityProductionAdapter.js';

const SESSION_ID = 'authority-production-regression';
const VIEW: TerminalAuthorityResponderViewIdentity = {
  connectionId: 'connection-a',
  viewGeneration: 1,
  responderLeaseId: 'responder-browser-1',
  queryReplyCapability: 'terminal.query-reply-input.v1',
  parserResponderCapability: 'terminal.parser-responder-disable.v1',
  driverLeaseGeneration: '1',
  acceptedViewAttributesGeneration: '1',
};

test('MIG-BGSTAB-002 a physically late ACK for a superseded rollback checkpoint is ignored', () => {
  const expected = {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    viewGeneration: 7,
    streamEpoch: '16',
    checkpointEpoch: '16001',
    sourceSeq: '13',
    snapshotSeq: '13',
    oldestRetainedSeq: '1',
    retentionPolicyId: 'retained-state-v1',
  };
  assert.equal(isSupersededTerminalCheckpointAck(expected, {
    ...expected,
    streamEpoch: '12',
    checkpointEpoch: '12001',
  }), true, 'an older physical ACK must not fail the currently installed checkpoint');
  assert.equal(isSupersededTerminalCheckpointAck(expected, {
    ...expected,
    sourceSeq: '12',
  }), false, 'a malformed ACK inside the current checkpoint identity must remain observable');
  assert.equal(isSupersededTerminalCheckpointAck(expected, {
    ...expected,
    streamEpoch: '17',
    checkpointEpoch: '17001',
  }), false, 'a future ACK must remain observable instead of being silently coerced');
});

test('MIG-BGSTAB-002 post-snapshot output remains on the checkpoint lane while promotion is settling', () => {
  assert.equal(isCheckpointOutputAuthorityMode('promoting'), true);
  assert.equal(isCheckpointOutputAuthorityMode('server'), true);
  assert.equal(isCheckpointOutputAuthorityMode('rolling-back'), true);
  assert.equal(isCheckpointOutputAuthorityMode('legacy'), false);
  assert.equal(isCheckpointOutputAuthorityMode('aborted'), false);
});

test('MIG-BGSTAB-002 only a pending replacement view recovery covers missing checkpoint output', () => {
  assert.equal(isServerOutputCoveredByPendingViewRecovery({
    messageType: 'output',
    authorityMode: 'server',
    hasCheckpoint: false,
    pendingViewRecovery: true,
  }), true);
  assert.equal(isServerOutputCoveredByPendingViewRecovery({
    messageType: 'output',
    authorityMode: 'server',
    hasCheckpoint: true,
    pendingViewRecovery: true,
  }), false, 'an installed checkpoint must keep using the ordered per-view tail pump');
  assert.equal(isServerOutputCoveredByPendingViewRecovery({
    messageType: 'output',
    authorityMode: 'server',
    hasCheckpoint: false,
    pendingViewRecovery: false,
  }), false, 'an unexplained current-view checkpoint loss must remain fail-closed');
  assert.equal(isServerOutputCoveredByPendingViewRecovery({
    messageType: 'output',
    authorityMode: 'promoting',
    hasCheckpoint: false,
    pendingViewRecovery: true,
  }), false, 'promotion views are frozen and cannot use replacement recovery coverage');
  assert.equal(isServerOutputCoveredByPendingViewRecovery({
    messageType: 'terminal-checkpoint:start',
    authorityMode: 'server',
    hasCheckpoint: false,
    pendingViewRecovery: true,
  }), false);
});

test('MIG-BGSTAB-002 control and terminal frame pumps use distinct lane-specific keys', () => {
  assert.notEqual(
    terminalAuthorityFramePumpKey(VIEW, 'control'),
    terminalAuthorityFramePumpKey(VIEW, 'terminal'),
  );
  assert.equal(
    terminalAuthorityFramePumpKey(VIEW, 'terminal'),
    terminalAuthorityFramePumpKey(VIEW, 'terminal'),
    'the same view/lane must retain FIFO ownership across a checkpoint transaction',
  );
});

test('MIG-BGSTAB-002 a mixed-lane frame batch defers only within its own lane FIFO', () => {
  const lanes = ['control', 'terminal', 'terminal', 'control'] as const;
  assert.deepEqual(
    lanes.map((lane, index) => shouldDeferTerminalAuthorityFrameDrain(lanes, index)),
    [true, true, false, false],
  );
  assert.deepEqual(
    (['control', 'terminal'] as const).map((lane, index, frames) => (
      shouldDeferTerminalAuthorityFrameDrain(frames, index)
    )),
    [false, false],
    'one frame per physical lane must start both pumps instead of leaving the first deferred forever',
  );
});

test('MIG-BGSTAB-002 rollback held query transfer invokes the exact compatibility responder port', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const callbackStart = source.indexOf('transferHeldQueryToLegacyResponder: effect =>');
  const callbackEnd = source.indexOf('writeTerminalQueryReply:', callbackStart);
  assert.notEqual(callbackStart, -1);
  assert.notEqual(callbackEnd, -1);
  const callback = source.slice(callbackStart, callbackEnd);

  assert.match(callback, /manager\.writeTerminalAuthorityCompatibilityQueryReply/u);
  assert.match(callback, /responderLeaseId:\s*effect\.responderLeaseId/u);
  assert.match(callback, /clientId:\s*effect\.clientId/u);
  assert.match(callback, /viewGeneration:\s*effect\.viewGeneration/u);
  assert.match(callback, /reply:\s*effect\.reply/u);
  assert.doesNotMatch(callback, /runtime\.expectedLegacyIdentity/u);
  assert.doesNotMatch(callback, /manager\.writeTerminalQueryReply/u);
});

test('MIG-BGSTAB-002 cumulative drain accepts snapshot-first ACK and rejects underflow or over-ACK', () => {
  assert.equal(isValidCheckpointDrainWatermark('83', '84', '83'), true);
  assert.equal(isValidCheckpointDrainWatermark('83', '84', '84'), true);
  assert.equal(isValidCheckpointDrainWatermark('83', '84', '82'), false);
  assert.equal(isValidCheckpointDrainWatermark('83', '84', '85'), false);
  assert.equal(isValidCheckpointDrainWatermark('83', '84', 'not-an-ordinal'), false);
});

function createHarness(snapshotSeq = '0') {
  const messages: Array<Record<string, unknown>> = [];
  const installedServerLeases: Array<{ responderLeaseId: string; driverLeaseId: string }> = [];
  const revokedResponderLeases: string[] = [];
  const revokedDriverLeases: string[] = [];
  const recoveryReasons: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let committedSourceSeq = '0';
  let rejectedMessageType: string | null = null;
  let rejectCompatibilityResponderRebind = false;
  let heldMessageType: string | null = null;
  const settleHeldMessages: Array<(accepted: boolean) => void> = [];
  let recoverySnapshotSeq = snapshotSeq;
  let safetyLimits = { maxHeldOutputBytes: 65_536, maxHeldOutputChunks: 64 };
  const options: TerminalAuthorityControllerOptions = {
    initial: {
      sessionId: SESSION_ID,
      authorityEpoch: 'authority-1',
      streamEpoch: '1',
      sessionGeneration: 'generation-1',
      legacyResponderLeaseId: 'responder-browser-1',
      legacyDriverLeaseId: 'driver-browser-1',
      sessionStatus: 'idle',
    },
    readPromotionGates: () => ({
      retainedStateParity: true,
      factParity: true,
      leaseParity: true,
      noLocalCacheParity: true,
      limitedSessionSelected: true,
      allRespondersCapable: true,
      replayRepairIdle: true,
    }),
    listRequiredResponderViews: () => [VIEW],
    readLastCommittedSourceSeq: () => committedSourceSeq,
    readPromotionSafetyLimits: () => ({
      ackDeadlineMs: 1_000,
      ...safetyLimits,
    }),
    now: () => 0,
    onOrderedCompatibilityRecoveryRequired: reason => { recoveryReasons.push(reason); },
    enqueueTerminalMessage: message => {
      const record = message as Record<string, unknown>;
      if (record.type === rejectedMessageType) return false;
      messages.push(record);
      if (record.type === heldMessageType) {
        return new Promise<boolean>(resolve => {
          settleHeldMessages.push(resolve);
        });
      }
      return true;
    },
    emit: event => { events.push({ ...event }); },
    loadAuthoritativeRecovery: () => ({
      retainedStateHash: 'sha256:checkpoint',
      checkpointEpoch: '2001',
      snapshotSeq: recoverySnapshotSeq,
      checkpointMessages: [
        { type: 'terminal-checkpoint:start', snapshotSeq: recoverySnapshotSeq },
        { type: 'terminal-checkpoint:commit', snapshotSeq: recoverySnapshotSeq },
      ],
      postSnapshotOutput: [],
    }),
    loadCompatibilityRecovery: () => ({
      snapshotSeq: recoverySnapshotSeq,
      checkpointMessages: [
        { type: 'terminal-checkpoint:start', snapshotSeq: recoverySnapshotSeq },
        { type: 'terminal-checkpoint:chunk', snapshotSeq: recoverySnapshotSeq },
        { type: 'terminal-checkpoint:commit', snapshotSeq: recoverySnapshotSeq },
      ],
    }),
    installServerAuthorityLeases: input => installedServerLeases.push(input),
    stopNewAdmission: () => undefined,
    setServerResponderEnabled: () => undefined,
    revokeServerResponderLease: input => { revokedResponderLeases.push(input.responderLeaseId); },
    revokeServerDriverLease: input => { revokedDriverLeases.push(input.driverLeaseId); },
    markAffectedViewStale: () => undefined,
    resetAffectedViewParser: () => undefined,
    purgeOldAckBacklog: () => undefined,
    rebindCompatibilityDriverLease: () => undefined,
    rebindCompatibilityResponderLease: () => {
      if (rejectCompatibilityResponderRebind) throw new Error('injected-responder-rebind-failure');
    },
    commitLegacyResponderIdentity: () => undefined,
    hasCompatibilityTailPhysicallyDrained: () => true,
    transferHeldQueryToLegacyResponder: () => undefined,
    writeTerminalQueryReply: () => undefined,
    writeLegacyBrowserQueryReply: () => undefined,
  };
  const controller = createTerminalAuthorityController(options);
  return {
    controller,
    messages,
    installedServerLeases,
    revokedResponderLeases,
    revokedDriverLeases,
    recoveryReasons,
    events,
    rejectMessageType(type: string | null) {
      rejectedMessageType = type;
    },
    rejectResponderRebind(reject: boolean) {
      rejectCompatibilityResponderRebind = reject;
    },
    holdMessageType(type: string | null) {
      heldMessageType = type;
    },
    releaseHeldMessage(accepted = true) {
      const settle = settleHeldMessages.shift();
      settle?.(accepted);
    },
    setCommittedSourceSeq(value: string) {
      committedSourceSeq = value;
    },
    setRecoverySnapshotSeq(value: string) {
      recoverySnapshotSeq = value;
    },
    setSafetyLimits(input: { maxHeldOutputBytes: number; maxHeldOutputChunks: number }) {
      safetyLimits = { ...input };
    },
  };
}

function disableIdentity(boundarySourceSeq: string): TerminalAuthorityResponderIdentity {
  return {
    ...VIEW,
    sessionId: SESSION_ID,
    transitionEpoch: '2',
    authorityEpoch: 'authority-1',
    streamEpoch: '2',
    boundarySourceSeq,
    responderLeaseId: 'responder-browser-1',
  };
}

async function promoteHarnessToServer(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);
}

function compatibilityRollbackRequest(epoch: '3' | '4') {
  return {
    transitionEpoch: epoch,
    nextStreamEpoch: epoch,
    compatibilityCheckpointEpoch: `${epoch}001`,
    nextCompatibilityResponderLeaseId: `responder-browser-${epoch}`,
    nextCompatibilityDriverLeaseId: `driver-browser-${epoch}`,
    nextCompatibilityDriverLeaseGeneration: epoch,
    nextAcceptedViewAttributesGeneration: epoch,
    selectedCompatibilityResponder: {
      ...VIEW,
      responderLeaseId: `responder-browser-${epoch}`,
      driverLeaseId: `driver-browser-${epoch}`,
      driverLeaseGeneration: epoch,
      acceptedViewAttributesGeneration: epoch,
    },
  };
}

test('MIG-BGSTAB-002 authority-capable legacy delivery remains exactly once on the authority lane', async () => {
  const harness = createHarness();
  const applied = await harness.controller.captureHeadlessOutput({ sourceSeq: '1', data: 'bootstrap-output' });
  assert.equal(applied.deliveryDisposition, 'legacy-delivered');
  assert.equal(harness.messages.filter(message => message.type === 'output').length, 1);
});

test('MIG-BGSTAB-002 held output already covered by the authoritative snapshot is not emitted twice', async () => {
  const harness = createHarness('2');
  harness.setCommittedSourceSeq('1');
  const promotion = await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  });
  assert.equal(promotion.ok, true);
  const held = await harness.controller.captureHeadlessOutput({ sourceSeq: '2', data: 'unique-marker' });
  assert.equal(held.deliveryDisposition, 'held-post-boundary');
  const acknowledged = await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'));
  assert.equal(acknowledged.completed, true);
  assert.deepEqual(
    harness.messages.filter(message => message.type === 'output'),
    [],
    'snapshotSeq=2 already contains sourceSeq=2, so releasing the held marker would duplicate terminal cells',
  );
});

test('MIG-BGSTAB-002 promotion installs concrete server driver and responder leases before checkpoint release', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  const promotion = await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  });
  assert.equal(promotion.ok, true);
  const acknowledged = await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'));
  assert.equal(acknowledged.completed, true);
  assert.deepEqual(harness.installedServerLeases, [{
    responderLeaseId: 'responder-server-2',
    driverLeaseId: 'driver-server-2',
  }]);
});

test('MIG-BGSTAB-002 server authority replaces stale frozen views before reconnect rollback', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);

  const replacement = {
    ...VIEW,
    connectionId: 'connection-reloaded',
    viewGeneration: 2,
    responderLeaseId: 'responder-server-2',
    driverLeaseGeneration: '2',
    acceptedViewAttributesGeneration: '2',
  };
  assert.deepEqual(harness.controller.replaceServerAuthorityViews([replacement]), {
    ok: true,
    viewCount: 1,
  });
  assert.equal((await harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: {
      ...replacement,
      responderLeaseId: 'responder-browser-3',
      driverLeaseId: 'driver-browser-3',
      driverLeaseGeneration: '3',
      acceptedViewAttributesGeneration: '3',
    },
  })).ok, true);
});

test('MIG-BGSTAB-002 checkpoint admission failure rolls installed server leases back and keeps the final ACK provisional', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  harness.rejectMessageType('terminal-checkpoint:commit');
  const acknowledged = await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'));
  assert.deepEqual(acknowledged, {
    accepted: true,
    completed: false,
    reason: 'authoritative-recovery-preflight-failed',
  });
  assert.equal(harness.controller.getState().acceptedDisableAckCount, 0);
  harness.rejectMessageType(null);
  const rollback = await harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: {
      ...VIEW,
      responderLeaseId: 'responder-browser-3',
      driverLeaseId: 'driver-browser-3',
      driverLeaseGeneration: '3',
      acceptedViewAttributesGeneration: '3',
    },
  });
  assert.equal(rollback.ok, true);
  assert.deepEqual(harness.revokedResponderLeases, ['responder-server-2']);
  assert.deepEqual(harness.revokedDriverLeases, ['driver-server-2']);
});

test('MIG-BGSTAB-002 failed compatibility rebind removes the provisional drain ACK and retries transactionally', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);
  const selected = {
    ...VIEW,
    responderLeaseId: 'responder-browser-3',
    driverLeaseId: 'driver-browser-3',
    driverLeaseGeneration: '3',
    acceptedViewAttributesGeneration: '3',
  };
  assert.equal((await harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: selected,
  })).ok, true);
  const drain = {
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
    transitionEpoch: '3',
    authorityEpoch: 'authority-1',
    streamEpoch: '3',
    responderLeaseId: 'responder-browser-3',
    boundarySourceSeq: '1',
    checkpointEpoch: '3001',
    drainedThroughSourceSeq: '1',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  };
  harness.rejectResponderRebind(true);
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain(drain), {
    accepted: false,
    completed: false,
    reason: 'compatibility-lease-rebind-failed',
  });
  assert.deepEqual(harness.events.find(event => event.type === 'compatibility-lease-rebind-failed'), {
    type: 'compatibility-lease-rebind-failed',
    kind: 'injected-responder-rebind-failure',
    sessionId: SESSION_ID,
  });
  assert.equal(
    harness.recoveryReasons.includes('compatibility-lease-rebind-failed'),
    true,
    'a failed provisional lease rebind must require a fresh epoch because compensation revokes its lease ids',
  );
  assert.equal(harness.controller.getState().mode, 'rolling-back');
  harness.rejectResponderRebind(false);
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain(drain), {
    accepted: false,
    completed: false,
    reason: 'compatibility-drain-identity-mismatch',
  });
  assert.deepEqual(await harness.controller.beginRollback(compatibilityRollbackRequest('4')), { ok: true });
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain({
    ...drain,
    transitionEpoch: '4',
    streamEpoch: '4',
    responderLeaseId: 'responder-browser-4',
    checkpointEpoch: '4001',
  }), {
    accepted: true,
    completed: true,
  });
  assert.equal(harness.controller.getState().mode, 'legacy');
});

test('MIG-BGSTAB-002 compatibility checkpoint rejection cannot report rollback success', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);
  harness.rejectMessageType('terminal-checkpoint:chunk');
  const result = await harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: {
      ...VIEW,
      responderLeaseId: 'responder-browser-3',
      driverLeaseId: 'driver-browser-3',
      driverLeaseGeneration: '3',
      acceptedViewAttributesGeneration: '3',
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'compatibility-checkpoint-enqueue-failed' });
});

test('MIG-BGSTAB-002 authority state commits only after final server and legacy delivery settlement', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  harness.holdMessageType('terminal-checkpoint:commit');
  const promotionCommit = harness.controller.acknowledgeLegacyDisable(disableIdentity('1'));
  await new Promise<void>(resolve => setImmediate(resolve));
  let duplicatePromotionSettled = false;
  const duplicatePromotionCommit = harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))
    .then(result => {
      duplicatePromotionSettled = true;
      return result;
    });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(harness.controller.getState().mode, 'promoting');
  assert.equal(harness.controller.getState().admissionOpen, 'none');
  assert.equal(duplicatePromotionSettled, false, 'a duplicate final disable ACK must share the unsettled promotion transaction');
  harness.releaseHeldMessage(true);
  assert.equal((await promotionCommit).completed, true);
  assert.deepEqual(await duplicatePromotionCommit, { accepted: true, duplicate: true, completed: true });
  assert.equal(harness.controller.getState().mode, 'server');

  const selected = {
    ...VIEW,
    responderLeaseId: 'responder-browser-3',
    driverLeaseId: 'driver-browser-3',
    driverLeaseGeneration: '3',
    acceptedViewAttributesGeneration: '3',
  };
  harness.holdMessageType(null);
  assert.equal((await harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: selected,
  })).ok, true);
  harness.holdMessageType('terminal-authority:legacy-responder-enabled');
  const legacyCommit = harness.controller.acknowledgeCompatibilityDrain({
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
    transitionEpoch: '3',
    authorityEpoch: 'authority-1',
    streamEpoch: '3',
    responderLeaseId: 'responder-browser-3',
    boundarySourceSeq: '1',
    checkpointEpoch: '3001',
    drainedThroughSourceSeq: '1',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  let duplicateLegacySettled = false;
  const duplicateLegacyCommit = harness.controller.acknowledgeCompatibilityDrain({
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
    transitionEpoch: '3',
    authorityEpoch: 'authority-1',
    streamEpoch: '3',
    responderLeaseId: 'responder-browser-3',
    boundarySourceSeq: '1',
    checkpointEpoch: '3001',
    drainedThroughSourceSeq: '1',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  }).then(result => {
    duplicateLegacySettled = true;
    return result;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(harness.controller.getState().mode, 'rolling-back');
  assert.equal(harness.controller.getState().admissionOpen, 'none');
  assert.equal(duplicateLegacySettled, false, 'a duplicate final drain ACK must share the unsettled legacy transaction');
  harness.releaseHeldMessage(true);
  assert.deepEqual(await legacyCommit, { accepted: true, completed: true });
  assert.deepEqual(await duplicateLegacyCommit, { accepted: true, duplicate: true, completed: true });
  assert.equal(harness.controller.getState().mode, 'legacy');
});

test('MIG-BGSTAB-002 rollback holds concurrent PTY output until the compatibility checkpoint settles', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);

  harness.messages.length = 0;
  harness.holdMessageType('terminal-authority:rollback-start');
  const rollback = harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: {
      ...VIEW,
      responderLeaseId: 'responder-browser-3',
      driverLeaseId: 'driver-browser-3',
      driverLeaseGeneration: '3',
      acceptedViewAttributesGeneration: '3',
    },
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  const concurrentOutput = await harness.controller.captureHeadlessOutput({
    sourceSeq: '2',
    data: 'concurrent-rollback-tail',
  });
  assert.equal(concurrentOutput.modelCommitted, true);
  assert.equal(
    harness.messages.some(message => message.type === 'output' && message.sourceSeq === '2'),
    false,
    'output newer than the snapshot must remain held while rollback-start/checkpoint is unsettled',
  );

  harness.releaseHeldMessage(true);
  assert.deepEqual(await rollback, { ok: true });
  const frameTypes = harness.messages
    .filter(message => message.type === 'terminal-checkpoint:start'
      || message.type === 'terminal-checkpoint:chunk'
      || message.type === 'terminal-checkpoint:commit'
      || (message.type === 'output' && message.sourceSeq === '2'))
    .map(message => message.type);
  assert.deepEqual(frameTypes, [
    'terminal-checkpoint:start',
    'terminal-checkpoint:chunk',
    'terminal-checkpoint:commit',
    'output',
  ]);
});

test('MIG-BGSTAB-002 authoritative headless apply does not await a slow client delivery callback', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);

  harness.holdMessageType('output');
  let appliedBeforeDeliverySettlement = false;
  const applied = harness.controller.captureHeadlessOutput({ sourceSeq: '2', data: 'slow-client-output' })
    .then(result => {
      appliedBeforeDeliverySettlement = true;
      return result;
    });
  await new Promise<void>(resolve => setImmediate(resolve));
  const observedBeforeRelease = appliedBeforeDeliverySettlement;
  harness.releaseHeldMessage(true);
  const result = await applied;
  assert.equal(observedBeforeRelease, true, 'authoritative model/fact commit must not wait for browser delivery settlement');
  assert.equal(result.modelCommitted, true);
  assert.equal(result.factCommitted, true);
});

test('MIG-BGSTAB-002 slow client delivery backlog is bounded without pausing PTY ingest', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);

  harness.holdMessageType('output');
  for (let sourceSeq = 2; sourceSeq <= 70; sourceSeq += 1) {
    const applied = await harness.controller.captureHeadlessOutput({
      sourceSeq: String(sourceSeq),
      data: 'x'.repeat(1_024),
    });
    assert.equal(applied.modelCommitted, true);
  }
  const state = harness.controller.getState();
  assert.equal(state.pendingDeliveryChunks <= 64, true);
  assert.equal(state.pendingDeliveryBytes <= 65_536, true);
  assert.equal(state.ptyPaused, false);
  assert.equal(state.mode, 'rolling-back');
  assert.deepEqual(harness.recoveryReasons, ['output-delivery-backlog-overflow']);

  harness.holdMessageType(null);
  harness.releaseHeldMessage(true);
  harness.controller.dispose();
});

test('MIG-BGSTAB-002 authority transition frames cannot overtake an already admitted output delivery', async () => {
  const harness = createHarness('2');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);
  harness.messages.length = 0;

  harness.holdMessageType('output');
  const first = await harness.controller.captureHeadlessOutput({ sourceSeq: '2', data: 'pre-rollback-output' });
  assert.equal(first.modelCommitted, true);
  harness.setCommittedSourceSeq('2');
  let rollbackSettled = false;
  const rollback = harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: {
      ...VIEW,
      responderLeaseId: 'responder-browser-3',
      driverLeaseId: 'driver-browser-3',
      driverLeaseGeneration: '3',
      acceptedViewAttributesGeneration: '3',
    },
  }).then(result => {
    rollbackSettled = true;
    return result;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(rollbackSettled, false);
  assert.deepEqual(
    harness.messages.map(message => message.type),
    ['output'],
    'rollback-start and its checkpoint must remain behind the unsettled pre-transition output',
  );

  harness.holdMessageType(null);
  harness.releaseHeldMessage(true);
  assert.deepEqual(await rollback, { ok: true });
  assert.deepEqual(harness.messages.map(message => message.type), [
    'output',
    'terminal-authority:rollback-start',
    'terminal-checkpoint:start',
    'terminal-checkpoint:chunk',
    'terminal-checkpoint:commit',
  ]);
});

test('MIG-BGSTAB-002 invalidated promotion commit cannot overwrite topology abort after settlement resumes', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  harness.holdMessageType('terminal-checkpoint:commit');
  const commit = harness.controller.acknowledgeLegacyDisable(disableIdentity('1'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(await harness.controller.notifyResponderTopologyChanged({
    transitionEpoch: '2',
    kind: 'disconnect',
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
  }), {
    aborted: true,
    restartRequired: true,
    reason: 'responder-topology-changed',
  });

  harness.releaseHeldMessage(true);
  assert.equal((await commit).completed, false);
  assert.equal(harness.controller.getState().mode, 'aborted');
  assert.ok(harness.revokedResponderLeases.includes('responder-server-2'));
  assert.ok(harness.revokedDriverLeases.includes('driver-server-2'));
});

test('MIG-BGSTAB-002 invalidated compatibility commit cannot overwrite restarted recovery after settlement resumes', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  assert.equal((await harness.controller.acknowledgeLegacyDisable(disableIdentity('1'))).completed, true);
  const selected = {
    ...VIEW,
    responderLeaseId: 'responder-browser-3',
    driverLeaseId: 'driver-browser-3',
    driverLeaseGeneration: '3',
    acceptedViewAttributesGeneration: '3',
  };
  assert.equal((await harness.controller.beginRollback({
    transitionEpoch: '3',
    nextStreamEpoch: '3',
    compatibilityCheckpointEpoch: '3001',
    nextCompatibilityResponderLeaseId: 'responder-browser-3',
    nextCompatibilityDriverLeaseId: 'driver-browser-3',
    nextCompatibilityDriverLeaseGeneration: '3',
    nextAcceptedViewAttributesGeneration: '3',
    selectedCompatibilityResponder: selected,
  })).ok, true);
  harness.holdMessageType('terminal-authority:legacy-responder-enabled');
  const commit = harness.controller.acknowledgeCompatibilityDrain({
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
    transitionEpoch: '3',
    authorityEpoch: 'authority-1',
    streamEpoch: '3',
    responderLeaseId: 'responder-browser-3',
    boundarySourceSeq: '1',
    checkpointEpoch: '3001',
    drainedThroughSourceSeq: '1',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(harness.controller.restartCompatibilityRecovery('injected-restart'), { ok: true });

  harness.releaseHeldMessage(true);
  assert.equal((await commit).completed, false);
  assert.equal(harness.controller.getState().mode, 'rolling-back');
  assert.ok(harness.revokedResponderLeases.includes('responder-browser-3'));
  assert.ok(harness.revokedDriverLeases.includes('driver-browser-3'));
});

test('MIG-BGSTAB-002 invalidated promotion boundary cannot report success after topology recovery starts', async () => {
  const harness = createHarness('1');
  harness.setCommittedSourceSeq('1');
  harness.holdMessageType('output');
  await harness.controller.captureHeadlessOutput({ sourceSeq: '1', data: 'prior-held-output' });
  const promotion = harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await harness.controller.notifyResponderTopologyChanged({
    transitionEpoch: '2',
    kind: 'generation-changed',
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
  })).aborted, true);
  assert.deepEqual(harness.controller.resumeAbortedPromotionRecovery('boundary-invalidated'), { ok: true });
  harness.releaseHeldMessage(true);
  assert.deepEqual(await promotion, { ok: false, reason: 'promotion-boundary-invalidated' });
  assert.equal(
    harness.messages.filter(message => message.type === 'terminal-authority:responder-disable-boundary').length,
    0,
    'a queued stale disable boundary must never reach the wire after topology abort',
  );
  assert.equal(harness.controller.getState().mode, 'rolling-back');
});

test('MIG-BGSTAB-002 invalidated rollback checkpoint cannot mutate a replacement rollback context', async () => {
  const harness = createHarness('1');
  await promoteHarnessToServer(harness);
  harness.holdMessageType('terminal-authority:rollback-start');
  const staleRollback = harness.controller.beginRollback(compatibilityRollbackRequest('3'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(harness.controller.restartCompatibilityRecovery('topology-restart'), { ok: true });
  harness.holdMessageType(null);
  const replacementRollback = harness.controller.beginRollback(compatibilityRollbackRequest('4'));
  harness.releaseHeldMessage(false);
  assert.deepEqual(await staleRollback, { ok: false, reason: 'rollback-transaction-invalidated' });
  assert.deepEqual(await replacementRollback, { ok: true });
  assert.equal(harness.recoveryReasons.includes('rollback-start-enqueue-failed'), false);
  assert.equal(harness.controller.getState().streamEpoch, '4');
  assert.equal(harness.controller.getState().mode, 'rolling-back');
});

test('MIG-BGSTAB-002 rollback pending output stays bounded and restarts from a fresh authoritative snapshot', async () => {
  const harness = createHarness('1');
  await promoteHarnessToServer(harness);
  harness.setSafetyLimits({ maxHeldOutputBytes: 5, maxHeldOutputChunks: 1 });
  harness.holdMessageType('terminal-authority:rollback-start');
  const staleRollback = harness.controller.beginRollback(compatibilityRollbackRequest('3'));
  await new Promise<void>(resolve => setImmediate(resolve));

  const first = await harness.controller.captureHeadlessOutput({ sourceSeq: '2', data: 'tail' });
  assert.equal(first.modelCommitted, true);
  assert.deepEqual(
    { bytes: harness.controller.getState().pendingDeliveryBytes, chunks: harness.controller.getState().pendingDeliveryChunks },
    { bytes: 4, chunks: 1 },
  );
  const overflow = await harness.controller.captureHeadlessOutput({ sourceSeq: '3', data: 'more' });
  assert.equal(overflow.modelCommitted, true);
  assert.equal(harness.controller.getState().ptyPaused, false);
  assert.equal(harness.controller.getState().pendingDeliveryBytes <= 5, true);
  assert.equal(harness.controller.getState().pendingDeliveryChunks <= 1, true);
  assert.ok(harness.recoveryReasons.includes('compatibility-output-hold-overflow'));

  harness.releaseHeldMessage(true);
  assert.deepEqual(await staleRollback, { ok: false, reason: 'rollback-transaction-invalidated' });
  harness.holdMessageType(null);
  harness.setCommittedSourceSeq('3');
  harness.setRecoverySnapshotSeq('3');
  assert.deepEqual(await harness.controller.beginRollback(compatibilityRollbackRequest('4')), { ok: true });
  const freshStarts = harness.messages.filter(message => (
    message.type === 'terminal-checkpoint:start' && message.snapshotSeq === '3'
  ));
  assert.equal(freshStarts.length, 1);
  assert.equal(harness.controller.getState().pendingDeliveryBytes, 0);
  assert.equal(harness.controller.getState().pendingDeliveryChunks, 0);
});

test('MIG-BGSTAB-002 compatibility snapshot releases aborted promotion held output', async () => {
  const harness = createHarness('2');
  harness.setCommittedSourceSeq('1');
  assert.equal((await harness.controller.beginPromotion({
    sessionId: SESSION_ID,
    authorityEpoch: 'authority-1',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'responder-browser-1',
    nextResponderLeaseId: 'responder-server-2',
    nextDriverLeaseId: 'driver-server-2',
  })).ok, true);
  const held = await harness.controller.captureHeadlessOutput({ sourceSeq: '2', data: 'promotion-held-tail' });
  assert.equal(held.deliveryDisposition, 'held-post-boundary');
  assert.equal(harness.controller.getState().heldPostBoundaryCount, 1);
  assert.equal((await harness.controller.notifyResponderTopologyChanged({
    transitionEpoch: '2',
    kind: 'generation-changed',
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
  })).aborted, true);
  assert.deepEqual(harness.controller.resumeAbortedPromotionRecovery('promotion-abort'), { ok: true });
  harness.setCommittedSourceSeq('2');
  assert.deepEqual(await harness.controller.beginRollback(compatibilityRollbackRequest('3')), { ok: true });
  assert.equal(harness.controller.getState().heldPostBoundaryCount, 0);
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain({
    connectionId: VIEW.connectionId,
    viewGeneration: VIEW.viewGeneration,
    transitionEpoch: '3',
    authorityEpoch: 'authority-1',
    streamEpoch: '3',
    responderLeaseId: 'responder-browser-3',
    boundarySourceSeq: '2',
    checkpointEpoch: '3001',
    drainedThroughSourceSeq: '2',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  }), { accepted: true, completed: true });
  assert.equal(harness.controller.getState().mode, 'legacy');
  assert.equal(harness.controller.getState().heldPostBoundaryCount, 0);
  assert.equal(harness.controller.getState().pendingDeliveryBytes, 0);
  assert.equal(harness.controller.getState().pendingDeliveryChunks, 0);
});

test('MIG-BGSTAB-002 production adapter hard reload rebinds the live view and sends fresh recovery', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const hookStart = source.indexOf('onViewAuthorityReady: registration =>');
  const hookEnd = source.indexOf('onClientFrame:', hookStart);
  assert.notEqual(hookStart, -1, 'the production router must notify the adapter about a new authority view');
  assert.notEqual(hookEnd, -1);
  const hook = source.slice(hookStart, hookEnd);
  assert.match(hook, /state\.mode !== 'server'/u);
  assert.match(hook, /registration\.authorityStreamEpoch !== state\.streamEpoch/u);
  assert.match(hook, /controller\.replaceServerAuthorityViews\(currentViews\)/u);
  assert.ok(
    hook.indexOf('replaceServerAuthorityViews(currentViews)')
      < hook.indexOf('enqueueFreshAuthoritativeRecovery(registration)'),
    'current server topology must be committed before the replacement checkpoint is sent',
  );
  assert.match(source, /readViewAuthorityMode: registration =>/u);
  assert.match(source, /state\.mode === 'promoting'[\s\S]*acceptedDisableAckCount === state\.frozenRequiredResponderCount/u);
  assert.match(source, /readViewAuthorityStreamEpoch: sessionId =>/u);
  assert.match(source, /activeCheckpointsByView\.get\(viewKey\(view\)\)/u);
  const outputReservationStart = source.indexOf('const activeCheckpoint =', source.indexOf('const sendTerminalFrame'));
  const outputReservationEnd = source.indexOf('return sent;', outputReservationStart);
  const outputReservation = source.slice(outputReservationStart, outputReservationEnd);
  assert.ok(outputReservationStart >= 0 && outputReservationEnd > outputReservationStart);
  assert.ok(
    outputReservation.indexOf('checkpointTailSourceSeqByView.set')
      < outputReservation.indexOf('enqueueSettledViewFrame'),
    'tail source sequence must be reserved before browser ACK can race the physical send callback',
  );
  assert.match(source, /await enqueueSettledViewFrameBatch\(/u);
  assert.match(source, /reservedCheckpointsByView/u);
  assert.match(
    source,
    /server-output-checkpoint-unavailable/u,
    'an unexplained current-view checkpoint gap must retain bounded fail-closed diagnostics',
  );
});

test('MIG-BGSTAB-002 promotion defers an acknowledged view until server authority is committed', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const hookStart = source.indexOf('onViewAuthorityReady: registration =>');
  const hookEnd = source.indexOf('onClientFrame:', hookStart);
  const emitStart = source.indexOf('emit: event =>');
  const emitEnd = source.indexOf('loadAuthoritativeRecovery:', emitStart);

  assert.notEqual(hookStart, -1);
  assert.notEqual(hookEnd, -1);
  assert.notEqual(emitStart, -1);
  assert.notEqual(emitEnd, -1);
  const hook = source.slice(hookStart, hookEnd);
  const emit = source.slice(emitStart, emitEnd);
  assert.match(hook, /state\.mode === 'promoting'/u);
  assert.match(hook, /pendingViewRecoveryKeys\.add\(registrationKey\)/u);
  assert.match(emit, /event\.type !== 'server-responder-enabled'/u);
  assert.match(emit, /pendingViewRecoveryKeys\.has\(key\)/u);
  assert.match(emit, /scheduleFreshAuthoritativeViewRecovery\(/u);
});

test('MIG-BGSTAB-002 rollback start stays on terminal delivery while legacy enable gates control replay', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const sendStart = source.indexOf('const sendTerminalFrame = async');
  const sendEnd = source.indexOf('const createCheckpoint =', sendStart);
  const sendTerminalFrame = source.slice(sendStart, sendEnd);
  const legacyStart = sendTerminalFrame.indexOf("if (record.type === 'terminal-authority:legacy-responder-enabled')");
  const deliveriesStart = sendTerminalFrame.indexOf('const deliveries = selectedViews.map', legacyStart);
  const refreshStart = sendTerminalFrame.indexOf('router.refreshReplaySnapshots(', legacyStart);

  assert.notEqual(legacyStart, -1);
  assert.notEqual(deliveriesStart, -1);
  assert.notEqual(refreshStart, -1);
  assert.match(
    sendTerminalFrame.slice(legacyStart, deliveriesStart),
    /buildCheckpointCapability\(sessionId, view, 'legacy', record,[\s\S]*?\),\s*'control'/u,
    'legacy capability must use the subscriber control socket',
  );
  assert.match(
    sendTerminalFrame.slice(legacyStart, deliveriesStart),
    /view\.connectionId === selectedConnection\s*\? 'selected-responder'\s*: 'passive-snapshot'/u,
    'only the selected view may complete rollback through responder enable',
  );
  assert.match(
    sendTerminalFrame.slice(deliveriesStart),
    /const deliveryLane = record\.type === 'terminal-authority:legacy-responder-enabled'\s*\? 'control'\s*:\s*'terminal'/u,
    'only legacy responder enable may use the control lane; rollback start remains terminal ordered',
  );
  assert.ok(
    refreshStart > deliveriesStart,
    'snapshot replay must be published only after capability and legacy enable settle',
  );
});

test('MIG-BGSTAB-002 rollback selects the suspended driver and withholds attributes challenges from passive peers', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const capabilityStart = source.indexOf('const buildCheckpointCapability =');
  const capabilityEnd = source.indexOf('const sendTerminalFrame = async', capabilityStart);
  const rollbackStart = source.indexOf('const rollbackSession = async');
  const rollbackEnd = source.indexOf('const scheduleTopologyRecovery', rollbackStart);
  const capability = source.slice(capabilityStart, capabilityEnd);
  const rollback = source.slice(rollbackStart, rollbackEnd);

  assert.match(
    capability,
    /passiveSnapshotPeer \? \{\} : \{[\s\S]*viewAttributesChallengeId/u,
    'a passive snapshot peer must not receive a query-driver attributes challenge',
  );
  assert.match(rollback, /getTerminalAuthoritySuspendedBrowserMutationLease\(sessionId\)/u);
  assert.match(rollback, /candidate\.clientId === suspended\.clientId/u);
  assert.match(rollback, /candidate\.viewGeneration === suspended\.viewGeneration/u);
});

test('MIG-BGSTAB-002 accepted owner keeps its attributes challenge for recovery capability refresh', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const readerStart = source.indexOf('readViewAttributesChallengeId: registration =>');
  const readerEnd = source.indexOf('onViewAuthorityReady: registration =>', readerStart);
  const reader = source.slice(readerStart, readerEnd);

  assert.notEqual(readerStart, -1);
  assert.match(
    reader,
    /accepted\.connectionId === registration\.connectionId[\s\S]*accepted\.clientId === registration\.clientId[\s\S]*accepted\.viewGeneration === registration\.viewGeneration[\s\S]*\? accepted\.challengeId/u,
    'only the exact accepted owner may reuse its one-shot challenge for a recovery refresh',
  );
});

test('MIG-BGSTAB-002 a stale precommit driver identity cannot reject a replacement view attributes push', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const ingressStart = source.indexOf("if (message.type === 'terminal-authority:view-attributes')");
  const ingressEnd = source.indexOf("if (message.type === 'terminal-authority:compatibility-drained')", ingressStart);
  const ingress = source.slice(ingressStart, ingressEnd);

  assert.ok(ingressStart >= 0 && ingressEnd > ingressStart);
  assert.match(
    ingress,
    /const matchingPrecommit = precommit !== null[\s\S]*?precommit\.connectionId === connectionId[\s\S]*?precommit\.viewGeneration === viewGeneration/u,
    'a precommit driver identity is valid only for the exact view that received legacy enable',
  );
  assert.match(
    ingress,
    /connectionId: matchingPrecommit \? precommit\.connectionId : connectionId[\s\S]*?viewGeneration: matchingPrecommit \? precommit\.viewGeneration : view\.viewGeneration/u,
    'a replacement view attributes push must use its own connection and generation',
  );
});

test('MIG-BGSTAB-002 a replacement attributes handshake takes precedence over a stale precommit driver', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const queryResponderStart = source.indexOf('readDriverViewIdentity: () =>');
  const runtimeStart = source.indexOf('const runtime = {', queryResponderStart);
  const queryResponder = source.slice(queryResponderStart, runtimeStart);

  assert.ok(queryResponderStart >= 0 && runtimeStart > queryResponderStart);
  assert.match(
    queryResponder,
    /const pending = runtime\?\.pendingViewAttributesHandshake[\s\S]*?const pendingConnectionId = pending\?\.connectionId[\s\S]*?const pendingView = pendingConnectionId !== null[\s\S]*?const view = pendingView[\s\S]*?\?\? \(precommit/u,
    'a current pending handshake must choose its registered view before any legacy precommit identity',
  );
  assert.match(
    queryResponder,
    /driverLeaseId: \(pendingView \? pending\?\.driverLeaseId : undefined\)[\s\S]*?matchingPrecommit\?\.driverLeaseId/u,
    'the query responder must validate attributes against the pending handshake or exact precommit driver lease',
  );
});

test('MIG-BGSTAB-002 an unrelated precommit lease cannot become the responder identity fallback', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const queryResponderStart = source.indexOf('readDriverViewIdentity: () =>');
  const runtimeStart = source.indexOf('const runtime = {', queryResponderStart);
  const queryResponder = source.slice(queryResponderStart, runtimeStart);

  assert.ok(queryResponderStart >= 0 && runtimeStart > queryResponderStart);
  assert.match(
    queryResponder,
    /const precommitView = precommit \? views\.find\(candidate => \(?[\s\S]*?candidate\.connectionId === precommit\.connectionId[\s\S]*?&& candidate\.viewGeneration === precommit\.viewGeneration[\s\S]*?\)\) : undefined;[\s\S]*?const matchingPrecommit = precommitView \? precommit : null;/u,
    'an obsolete precommit must be usable only when its exact connection and view remain negotiated',
  );
  assert.match(
    queryResponder,
    /\?\? matchingPrecommit\?\.driverLeaseId[\s\S]*?\?\? runtime\.controller\.getState\(\)\.activeDriverLeaseId/u,
    'the responder must fall back to the active lease instead of an unrelated precommit lease',
  );
});

test('MIG-BGSTAB-002 exact precommit and pending identities retain their full generation tuples', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const queryResponderStart = source.indexOf('readDriverViewIdentity: () =>');
  const runtimeStart = source.indexOf('const runtime = {', queryResponderStart);
  const queryResponder = source.slice(queryResponderStart, runtimeStart);
  const ingressStart = source.indexOf("if (message.type === 'terminal-authority:view-attributes')");
  const ingressEnd = source.indexOf("if (message.type === 'terminal-authority:compatibility-drained')", ingressStart);
  const ingress = source.slice(ingressStart, ingressEnd);

  assert.ok(queryResponderStart >= 0 && runtimeStart > queryResponderStart);
  assert.ok(ingressStart >= 0 && ingressEnd > ingressStart);
  assert.match(
    queryResponder,
    /driverLeaseGeneration: \(pendingView \? pending\?\.driverLeaseGeneration : undefined\)[\s\S]*?\?\? matchingPrecommit\?\.driverLeaseGeneration[\s\S]*?\?\? view\.driverLeaseGeneration/u,
    'the responder must use the exact pending or precommit driver generation before a live-view fallback',
  );
  assert.match(
    queryResponder,
    /expectedViewAttributesGeneration: \(pendingView \? pending\?\.viewAttributesGeneration : undefined\)[\s\S]*?\?\? matchingPrecommit\?\.viewAttributesGeneration[\s\S]*?\?\? view\.acceptedViewAttributesGeneration/u,
    'the responder must use the exact pending or precommit attributes generation before a live-view fallback',
  );
  assert.match(
    ingress,
    /driverLeaseGeneration: \(exactPendingChallenge[\s\S]*?\? pendingAtIngress\?\.driverLeaseGeneration[\s\S]*?\?\? \(matchingPrecommit \? precommit\.driverLeaseGeneration : undefined\)/u,
    'ingress must give an exact pending challenge precedence over an older precommit generation',
  );
  assert.match(
    ingress,
    /viewAttributesGeneration: \(exactPendingChallenge[\s\S]*?\? pendingAtIngress\?\.viewAttributesGeneration[\s\S]*?\?\? \(matchingPrecommit \? precommit\.viewAttributesGeneration : undefined\)/u,
    'ingress must give an exact pending challenge precedence over an older precommit attributes generation',
  );
});

test('MIG-BGSTAB-002 rollback topology churn coalesces to one leading-edge recovery window', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const scheduleStart = source.indexOf('const scheduleCompatibilityTopologyRecovery =');
  const wakeStart = source.indexOf('const wakeCompatibilityTopologyRecovery =', scheduleStart);
  const wakeEnd = source.indexOf('const uninstallHooks = router.installTerminalAuthorityHooks', wakeStart);
  const schedule = source.slice(scheduleStart, wakeStart);
  const wake = source.slice(wakeStart, wakeEnd);

  assert.ok(scheduleStart >= 0 && wakeStart > scheduleStart && wakeEnd > wakeStart);
  assert.match(
    schedule,
    /if \(runtime\.topologyRecoveryTimer\) \{\s*return;\s*\}/u,
    'a pending recovery window must coalesce repeated topology events',
  );
  assert.match(
    schedule,
    /restartCompatibilityRecovery\(\s*'responder-topology-changed-during-recovery'\s*\)/u,
    'only the quiet-window callback may invalidate the active rollback transaction',
  );
  assert.doesNotMatch(
    schedule,
    /clearTimeout\(runtime\.topologyRecoveryTimer\)/u,
    'coalescing must not perpetually re-arm recovery under connection churn',
  );
  assert.match(
    wake,
    /if \(activeRecovery\)[\s\S]*restartCompatibilityRecovery\(/u,
    'an active recovery is invalidated once when topology changes before the bounded retry window',
  );
});

test('MIG-BGSTAB-002 a subscription-ready observer cannot rotate a still-open browser mutation owner', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const serverModeStart = source.indexOf("if (state.mode === 'server')");
  const serverModeEnd = source.indexOf("if (state.mode === 'rolling-back')", serverModeStart);
  const serverMode = source.slice(serverModeStart, serverModeEnd);
  assert.match(
    serverMode,
    /const hasLiveMutationOwner = currentMutationLease !== null[\s\S]*?router\.getTerminalAuthorityNegotiatedViews\?\.\(change\.sessionId\)/u,
    'server authority must prove the old owner control view is absent before rotating a mutation lease',
  );
  assert.match(
    serverMode,
    /!hasLiveMutationOwner[\s\S]*?manager\.rotateTerminalAuthoritySuspendedBrowserMutationLease/u,
    'an observer must not rotate a mutation lease while the old owner control connection is still open',
  );
});

test('MIG-BGSTAB-002 an already reserved view recovery cannot create a second checkpoint lifecycle', async () => {
  const source = await readFile(
    new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url),
    'utf8',
  );
  const recoveryStart = source.indexOf('const enqueueFreshAuthoritativeRecovery = async');
  assert.notEqual(recoveryStart, -1, 'enqueueFreshAuthoritativeRecovery anchor is missing');
  // Without the keyword this also matches the call sites inside the function,
  // and without the guard a missing anchor silently slices to the end of file.
  const recoveryEnd = source.indexOf('const scheduleFreshAuthoritativeViewRecovery', recoveryStart);
  assert.notEqual(recoveryEnd, -1, 'scheduleFreshAuthoritativeViewRecovery anchor is missing');
  const recovery = source.slice(recoveryStart, recoveryEnd);
  const keyIndex = recovery.indexOf('const key = viewKey(input)');
  const checkpointIndex = recovery.indexOf('const recovery = createCheckpoint(');
  assert.ok(keyIndex >= 0 && checkpointIndex > keyIndex);
  const guard = recovery.slice(keyIndex, checkpointIndex);

  const guarded = /if \(([\s\S]{0,400}?)\)\s*return;/u.exec(guard);
  assert.ok(guarded, 'a guarded return must precede checkpoint creation');
  const condition = guarded[1];
  // Both ownership predicates must govern the return, in either order: the
  // operand order carries no contract and pinning it made this test fail on a
  // refactor that changed nothing about the guard.
  assert.equal(
    condition.includes('runtime.reservedCheckpointsByView.has(key)')
      && condition.includes('runtime.activeCheckpointsByView.has(key)'),
    true,
    'both reserved and active view-ownership predicates must govern that return',
  );
  assert.equal(
    /runtime\.reservedCheckpointsByView\.has\(key\)\s*&&/u.test(condition),
    false,
    'the reserved-checkpoint predicate must not be weakened by a further condition',
  );
  // A retained-stream rollover has to rebuild the view, so an active checkpoint
  // may be replaced -- but only along that explicit path.
  assert.match(
    condition,
    /runtime\.activeCheckpointsByView\.has\(key\) && !input\.replaceActiveCheckpoint/u,
    'an active checkpoint may only be bypassed by the explicit replacement path',
  );

  const teardownIndex = recovery.indexOf('runtime.activeCheckpointsByView.delete(key)');
  const reserveIndex = recovery.indexOf('runtime.reservedCheckpointsByView.set(key,');
  assert.ok(teardownIndex >= 0, 'the replacement path must delete the active checkpoint');
  assert.ok(reserveIndex >= 0, 'the recovery must reserve the new checkpoint');
  assert.ok(
    reserveIndex > teardownIndex,
    'the replaced active checkpoint must be torn down before the next one is reserved',
  );
});

test('REL-BGSTAB-012 keeps PTY ingest and model continuity through authority rollback', async () => {
  const signature = 'REL-BGSTAB-012 AC-7: rollback delivery fencing must preserve authoritative PTY ingest and model continuity';
  const harness = createHarness('1');
  await promoteHarnessToServer(harness);
  harness.holdMessageType('terminal-authority:rollback-start');
  const rollback = harness.controller.beginRollback(compatibilityRollbackRequest('3'));
  await new Promise<void>(resolve => setImmediate(resolve));
  const concurrentOutput = await harness.controller.captureHeadlessOutput({
    sourceSeq: '2',
    data: 'rel012-rollback-pty-tail',
  });

  assert.equal(harness.controller.getState().mode, 'rolling-back', signature);
  assert.equal(concurrentOutput.modelCommitted, true, signature);
  assert.equal(harness.controller.getState().ptyPaused, false, signature);
  harness.releaseHeldMessage(true);
  assert.deepEqual(await rollback, { ok: true }, signature);
  assert.equal(
    (concurrentOutput as unknown as { authorityContinuity?: unknown }).authorityContinuity,
    'pty-and-model-preserved',
    signature,
  );
});
