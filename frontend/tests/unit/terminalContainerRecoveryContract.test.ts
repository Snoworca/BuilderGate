import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as visibleOutputRecoveryModule from '../../src/utils/visibleOutputRecovery.ts';
import {
  beginRecovery,
  createRecordingRecoveryAdapter,
  requireRecoveryCoordinatorFactory,
  type RecoveryCoordinatorEvent,
  type RecoveryCoordinatorResult,
  type RecoveryScope,
  type VisibleOutputRecoveryCoordinator,
} from '../helpers/visibleOutputRecoveryContract.ts';

const source = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');
const webSocketContextSource = readFileSync(
  new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
  'utf8',
);
const terminalViewSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
  'utf8',
);
const terminalCheckpointRuntimeSource = readFileSync(
  new URL('../../src/utils/terminalCheckpointRuntime.ts', import.meta.url),
  'utf8',
);
const visibleOutputRecoverySource = readFileSync(
  new URL('../../src/utils/visibleOutputRecovery.ts', import.meta.url),
  'utf8',
);

// `TerminalContainer.tsx` is CRLF, so an `'if (\n…'` literal needle matches at -1
// forever. Locate the guard EOL-agnostically; it resolves to exactly one site.
const CHECKPOINT_AUTHORITY_ACTIVE_GUARD =
  /if \(\r?\n\s*terminalRef\.current\?\.isCheckpointAuthorityActive\(\) === true/u;

function indexOfCheckpointAuthorityGuard(haystack: string, from = 0): number {
  const match = CHECKPOINT_AUTHORITY_ACTIVE_GUARD.exec(haystack.slice(from));
  return match === null ? -1 : from + match.index;
}

// The helper returns the FIRST match, so two guards of this shape would silently
// move every chunk boundary derived from it. Pin the count rather than assume it.
test('the checkpoint-authority guard anchor resolves to exactly one site', () => {
  const all = source.match(new RegExp(CHECKPOINT_AUTHORITY_ACTIVE_GUARD.source, 'gu'));
  assert.equal(
    all?.length,
    1,
    'a second `if (` guard on isCheckpointAuthorityActive() would make the anchor ambiguous',
  );
});

test('PERF-BGSTAB-010 browser ACK is emitted only after an accepted visible terminal write', () => {
  const signature = 'PERF-BGSTAB-010 accepted delivery ACK boundary 계약 부재 때문에 실패';
  assert.match(terminalViewSource, /readonly onWritten\?: \(\) => void;/, signature);
  assert.match(terminalViewSource, /writeOutput\(\s*term,\s*data,\s*metadata\?\.onWritten/u, signature);
  assert.match(source, /hiddenDecision\.action === 'skip'[\s\S]*?return;/, signature);
  assert.match(source, /type: 'terminal-delivery:ack'/, signature);
  assert.match(source, /remainingAcceptedChunks -= 1;[\s\S]*?remainingAcceptedChunks === 0/, signature);
  assert.match(
    webSocketContextSource,
    /type: 'terminal-delivery:capability',[\s\S]*?supportsHiddenDataGapRecovery: true/,
    signature,
  );
  assert.match(
    terminalViewSource,
    /if \(!coordinator\) \{\s*onRejected\?\.\(\);\s*return;\s*\}/u,
    signature,
  );
});

test('PERF-BGSTAB-010 AC-6 browser records ACK rejection without delivery or status mutation', () => {
  const signature = 'ACK rejection must remain observable without client-side delivery mutation';
  const sessionDispatchStart = webSocketContextSource.indexOf("if ('sessionId' in msg) {");
  const sessionDispatchEnd = webSocketContextSource.indexOf('// Workspace/tab/grid events');
  const sessionDispatch = webSocketContextSource.slice(sessionDispatchStart, sessionDispatchEnd);
  const handlerLookup = sessionDispatch.indexOf('const handlers = sessionHandlersRef.current.get(sessionId);');
  const ackRejection = sessionDispatch.indexOf("if (msg.type === 'terminal-delivery:ack-rejected') {");

  assert.ok(sessionDispatchStart >= 0 && sessionDispatchEnd > sessionDispatchStart, signature);
  assert.ok(ackRejection >= 0 && handlerLookup > ackRejection, signature);
  const ackRejectionBranch = sessionDispatch.slice(ackRejection, handlerLookup);
  assert.match(
    ackRejectionBranch,
    /const parsedAckRejection = parseTerminalDeliveryAckRejectedMessage\(rawMessage\);/u,
    signature,
  );
  assert.match(
    ackRejectionBranch,
    /if \(parsedAckRejection\.ok\) \{[\s\S]*?recordTerminalDebugEvent\(parsedAckRejection\.message\.sessionId, 'terminal_delivery_ack_rejected', \{\s*connectionEpoch: parsedAckRejection\.message\.connectionEpoch,\s*deliverySeq: parsedAckRejection\.message\.deliverySeq,\s*reason: parsedAckRejection\.message\.reason,\s*\}, undefined, \{ includeInputReliabilityMode: false \}\);[\s\S]*?\}/u,
    signature,
  );
  assert.match(ackRejectionBranch, /return;/u, signature);
  assert.doesNotMatch(
    ackRejectionBranch,
    /handlers\.|onOutput|onStatus|onSessionReady|setStatus\(|send\(|requestReconnect|bufferGraceMessage|writeOutput/u,
    signature,
  );

  const messageCast = 'const msg = rawMessage as ServerWsMessage;';
  const messageCastIndex = webSocketContextSource.indexOf(messageCast);
  assert.ok(messageCastIndex >= 0, signature);
  assert.match(
    webSocketContextSource.slice(Math.max(0, messageCastIndex - 180), messageCastIndex + messageCast.length),
    /if \(!isCheckpointProtocolRecord\(rawMessage\)\) \{\s*return;\s*\}\s*const msg = rawMessage as ServerWsMessage;/u,
    signature,
  );
});

test('MIG-BGSTAB-002 TerminalView queues checkpoint-authority input until its exact mutation lease arrives', () => {
  const signature = 'checkpoint authority without a current mutation lease must not emit bare input';
  assert.match(terminalViewSource, /isTerminalCheckpointMutationLeaseReady/, signature);
  assert.match(terminalViewSource, /checkpointMutationLeaseBarrierRef/, signature);
  assert.match(
    terminalViewSource,
    /checkpointMutationLeaseBarrierRef\.current = !isTerminalCheckpointMutationLeaseReady\(capability, sessionId, xtermGenerationRef\.current\)/,
    signature,
  );
  assert.match(
    terminalViewSource,
    /else if \(checkpointMutationLeaseBarrierRef\.current\) \{[\s\S]*?barrierReason = 'checkpoint-pending'/u,
    signature,
  );
  assert.match(
    terminalViewSource,
    /checkpointMutationLeaseBarrierRef\.current = true;\s*const unregisterCheckpointDispatcher = registerTerminalCheckpointDispatcher\(/u,
    signature,
  );
});

test('TerminalContainer bounds authority recovery retries and resets them only after matching ready plus ACK', () => {
  const signature = 'REL-BGSTAB-009 RED: TerminalContainer recovery retry budget is not wired across transactions';
  assert.match(source, /visibleOutputRecoveryAttemptBudgetRef/, signature);

  const freshStart = source.indexOf('requestFreshSnapshot(request)');
  const freshChunk = source.slice(freshStart, freshStart + 1400);
  assert.match(freshChunk, /consume\('fresh-snapshot'\)/, signature);
  assert.match(freshChunk, /visible_output_resync_retry_budget_exhausted/, signature);

  const reconnectStart = source.indexOf('const handleScreenRepairReconnectRequired');
  const reconnectChunk = source.slice(reconnectStart, reconnectStart + 2600);
  assert.match(reconnectChunk, /requestBoundedVisibleRecoveryReconnect\('screen-repair-reconnect-required'\)/, signature);

  const boundedReconnectStart = source.indexOf('const requestBoundedVisibleRecoveryReconnect');
  const boundedReconnectChunk = source.slice(boundedReconnectStart, boundedReconnectStart + 1200);
  assert.match(boundedReconnectChunk, /consume\('reconnect'\)/, signature);
  assert.match(boundedReconnectChunk, /visible_output_resync_retry_budget_exhausted/, signature);

  const readyStart = source.indexOf('setCurrentViewReady(change)');
  const readyChunk = source.slice(readyStart, readyStart + 1300);
  assert.match(readyChunk, /resetAfterConvergence\(\)/, signature);
  assert.match(readyChunk, /activeVisibleOutputResyncRef\.current = null/, signature);
  assert.ok(
    readyChunk.indexOf('resetAfterConvergence()') < readyChunk.indexOf('activeVisibleOutputResyncRef.current = null'),
    signature,
  );
});

test('WebSocket grace recovery state is discarded before a replacement socket resubscribes', () => {
  const signature = 'REL-BGSTAB-009 RED: old-socket grace recovery can leak into a replacement connection generation';
  const onOpenStart = webSocketContextSource.indexOf('ws.onopen = () => {');
  const onOpenChunk = webSocketContextSource.slice(onOpenStart, onOpenStart + 1600);
  assert.match(onOpenChunk, /graceBufferedSessionsRef\.current\.clear\(\)/, signature);
  assert.ok(
    onOpenChunk.indexOf('graceBufferedSessionsRef.current.clear()')
      < onOpenChunk.indexOf("ws.send(JSON.stringify({ type: 'subscribe', sessionIds }))"),
    signature,
  );
});

test('replacement-socket authoritative ACK plus matching ready resets the recovery budget', () => {
  const signature = 'REL-BGSTAB-009 RED: successful replacement-socket convergence leaves the recovery reconnect budget exhausted';
  const snapshotStart = source.indexOf('const ackResult = send({', source.indexOf("recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent'"));
  const snapshotChunk = source.slice(snapshotStart, snapshotStart + 1100);
  assert.match(snapshotChunk, /armReconnectConvergence\(/, signature);
  assert.match(snapshotChunk, /connectionGeneration: wsConnectionGenerationRef\.current/, signature);
  assert.match(snapshotChunk, /replayToken: nextSnapshot\.replayToken/, signature);
  assert.match(snapshotChunk, /snapshotSeq: nextSnapshot\.seq/, signature);

  const readyStart = source.indexOf('const handleSessionReady');
  const readyChunk = source.slice(readyStart, readyStart + 6200);
  assert.match(readyChunk, /resetAfterMatchingReconnectConvergence\(/, signature);
  assert.match(readyChunk, /connectionGeneration: wsConnectionGenerationRef\.current/, signature);
  assert.match(readyChunk, /replayToken: message\.replayToken/, signature);
  assert.match(readyChunk, /snapshotSeq: message\.snapshotSeq/, signature);
});

test('replacement authoritative convergence is staged before the snapshot ACK can synchronously return ready', () => {
  const signature = 'MIG-BGSTAB-002 RED: synchronous snapshot ready can strand a post-ACK convergence barrier';
  const convergenceStart = source.indexOf('let compatibilityPostAckState: TerminalCompatibilityPostAckConvergenceState | null = null;');
  const ackStart = source.indexOf('const ackResult = send({', convergenceStart);

  assert.ok(ackStart >= 0 && convergenceStart >= 0, signature);
  assert.ok(
    convergenceStart < ackStart,
    signature,
  );
});

test('replacement authoritative snapshots bypass checkpoint suppression for retained-state recovery', () => {
  const signature = 'MIG-BGSTAB-002 RED: a replacement authoritative snapshot was discarded behind checkpoint authority';
  const snapshotStart = source.indexOf('const lastApplied = lastAppliedSnapshotRef.current;');
  const forceStart = source.indexOf('const forceReplacementRecoveryConvergence =', snapshotStart);
  const suppressionStart = source.indexOf('if (shouldSuppressLegacySnapshotDuringCheckpointAuthority({', snapshotStart);

  assert.ok(snapshotStart >= 0 && forceStart > snapshotStart && suppressionStart > forceStart, signature);
  assert.match(
    source.slice(suppressionStart, suppressionStart + 700),
    /\}\) && !forceReplacementRecoveryConvergence/u,
    signature,
  );
});

test('MIG-BGSTAB-002 snapshot Windows PTY metadata applies only after snapshot authority succeeds', () => {
  const signature = 'a rejected or superseded snapshot must not mutate Windows PTY metadata';
  const snapshotStart = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  const snapshotEnd = source.indexOf('const handleCompatibilityAuthorityReady', snapshotStart);
  const activeResyncIndex = source.indexOf('const activeVisibleResyncApplied = applyActiveVisibleResyncSnapshot(nextSnapshot);', snapshotStart);
  const windowsPtyIndex = source.indexOf('terminalRef.current?.setWindowsPty(nextSnapshot.windowsPty);', snapshotStart);

  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, signature);
  assert.ok(activeResyncIndex > snapshotStart, signature);
  assert.ok(windowsPtyIndex > activeResyncIndex && windowsPtyIndex < snapshotEnd, signature);
});

test('session ready cannot open input until it matches the latest received snapshot lineage', () => {
  const signature = 'MIG-BGSTAB-002 RED: stale session ready opens input while the router still fences a newer replay';
  const readyStart = source.indexOf('const handleSessionReady');
  const readyChunk = source.slice(readyStart, readyStart + 7200);

  assert.match(readyChunk, /latestReceivedSnapshotReadyIdentityRef\.current/u, signature);
  assert.match(readyChunk, /terminal_session_ready_snapshot_identity_ignored/u, signature);
  assert.match(readyChunk, /message\.replayToken !== latestReceivedSnapshotReadyIdentity\.replayToken/u, signature);
  assert.match(readyChunk, /message\.snapshotSeq !== latestReceivedSnapshotReadyIdentity\.snapshotSeq/u, signature);

  const snapshotStart = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  const snapshotChunk = source.slice(snapshotStart, snapshotStart + 2000);
  assert.match(snapshotChunk, /latestReceivedSnapshotReadyIdentityRef\.current = \{/u, signature);
  assert.match(snapshotChunk, /replayToken: snapshot\.replayToken/u, signature);
  assert.match(snapshotChunk, /snapshotSeq: snapshot\.seq/u, signature);
});

test('replacement authoritative identity is reapplied even when seq and content are unchanged', () => {
  const signature = 'REL-BGSTAB-009 RED: duplicate snapshot optimization suppresses replacement-socket convergence';
  const snapshotLoopStart = source.indexOf('const lastApplied = lastAppliedSnapshotRef.current;');
  const snapshotLoopChunk = source.slice(
    snapshotLoopStart,
    source.indexOf('if (isStale) {', snapshotLoopStart),
  );
  assert.match(snapshotLoopChunk, /shouldForceAuthoritativeRecoveryConvergence\(/, signature);
  assert.match(snapshotLoopChunk, /terminalRef\.current\?\.isCompatibilityRecoveryPending\(\)/, signature);
  assert.match(
    snapshotLoopChunk,
    /const forceReplacementRecoveryConvergence = forceInitialCheckpointAuthorityRecoveryConvergence\s*\|\|\s*compatibilityRecoverySnapshot\s*\|\|/,
    signature,
  );
  assert.match(snapshotLoopChunk, /const forceReplacementRecoveryConvergence/, signature);
  assert.match(snapshotLoopChunk, /!forceReplacementRecoveryConvergence\s*&&\s*!!lastApplied\s*&&\s*nextSnapshot\.seq < lastApplied\.seq/, signature);
  assert.match(snapshotLoopChunk, /!forceReplacementRecoveryConvergence\s*&&\s*hasSameSnapshotContent/, signature);

  const lastAppliedStart = source.indexOf('lastAppliedSnapshotRef.current = {', snapshotLoopStart);
  const lastAppliedChunk = source.slice(lastAppliedStart, lastAppliedStart + 500);
  assert.match(lastAppliedChunk, /replayToken: nextSnapshot\.replayToken/, signature);
  assert.match(lastAppliedChunk, /connectionGeneration: wsConnectionGenerationRef\.current/, signature);
});

test('replacement authoritative convergence is serialized behind in-flight speculative writes', () => {
  const signature = 'REL-BGSTAB-009 RED: replacement authoritative snapshot bypasses the terminal mutation fence';
  const replacementStart = source.indexOf('const replacementConnectionGeneration');
  const replacementEnd = source.indexOf('if (!applied) {', replacementStart);
  const replacementChunk = source.slice(replacementStart, replacementEnd);
  assert.match(
    replacementChunk,
    /const requiresAuthoritativeMutationFence = forceCurrentActiveReplacement\s*\|\|\s*forceReplacementRecoveryConvergence/,
    signature,
  );
  assert.match(
    replacementChunk,
    /forceReplacementRecoveryConvergence[\s\S]*wsConnectionGenerationRef\.current === replacementConnectionGeneration[\s\S]*resolveVisibleOutputRecoveryBarrierReason/,
    signature,
  );
  assert.match(
    replacementChunk,
    /requiresAuthoritativeMutationFence \? shouldApplyAuthoritativeSnapshot : undefined/,
    signature,
  );
  assert.match(
    replacementChunk,
    /if \(requiresAuthoritativeMutationFence\)[\s\S]*runAuthoritative/,
    signature,
  );
});

test('no-active reconnect-required invalidates legacy speculative repair before installing its barrier', () => {
  const signature = 'REL-BGSTAB-009 RED: legacy speculative repair can clear the replacement reconnect recovery barrier';
  const reconnectStart = source.indexOf('const handleScreenRepairReconnectRequired');
  const reconnectChunk = source.slice(reconnectStart, reconnectStart + 2500);
  const noActiveStart = reconnectChunk.indexOf('const started = beginVisibleOutputRecovery');
  assert.notEqual(noActiveStart, -1, signature);
  const noActivePrefix = reconnectChunk.slice(Math.max(0, noActiveStart - 500), noActiveStart);
  assert.match(noActivePrefix, /visibleOutputResyncEpochRef\.current \+= 1/, signature);
  assert.match(noActivePrefix, /visibleOutputMutationFenceRef\.current\?\.invalidateSpeculative\(\)/, signature);

  const repairStart = source.indexOf('const handleScreenRepair = useEffectEvent');
  const repairChunk = source.slice(repairStart, repairStart + 5000);
  const epochFenceIndex = repairChunk.indexOf('visibleOutputResyncEpochRef.current !== resyncEpochBeforeApply');
  const finishIndex = repairChunk.indexOf("finishVisibleOutputRecoveryIfPending('screen-repair')");
  assert.ok(epochFenceIndex >= 0 && finishIndex >= 0 && epochFenceIndex < finishIndex, signature);
});

test('restore-needed and reconnect-required terminate the legacy repair in-flight suppression', () => {
  const signature = 'REL-BGSTAB-009 RED: terminal restore outcome leaves same-geometry screen repair permanently suppressed';
  const restoreStart = source.indexOf('const handleScreenRepairRestoreNeeded');
  const restoreChunk = source.slice(restoreStart, restoreStart + 3600);
  assert.match(
    restoreChunk,
    /clearScreenRepairInFlightForTerminalOutcome\('restore-needed'\)/,
    signature,
  );

  const reconnectStart = source.indexOf('const handleScreenRepairReconnectRequired');
  const reconnectChunk = source.slice(reconnectStart, reconnectStart + 2800);
  const clearMatches = reconnectChunk.match(
    /clearScreenRepairInFlightForTerminalOutcome\('reconnect-required'\)/g,
  ) ?? [];
  assert.equal(clearMatches.length, 2, signature);

  const helperStart = source.indexOf('const clearScreenRepairInFlightForTerminalOutcome');
  const helperChunk = source.slice(helperStart, helperStart + 900);
  assert.match(helperChunk, /inFlight\.sessionId !== sessionId/, signature);
  assert.match(helperChunk, /screenRepairInFlightRef\.current = null/, signature);
});

const RED_SIGNATURES = {
  ac3: 'Frontend stale/resync barrier RED 계약 RED AC-3: overflow did not abort the active token into affected-view restore-needed plus fresh server snapshot without pending-output flush',
  ac6: 'Frontend stale/resync barrier RED 계약 RED AC-6: stale token/generation/duplicate/late-dispose signal mutated the live transaction or released held output',
  ac11: 'Frontend stale/resync barrier RED 계약 RED AC-11: real UTF-8 byte/chunk boundary accounting, incomplete-parser non-ready, close/dispose, multi-client isolation, or unified/split limitation failed',
} as const;

interface RestoreIdentity {
  transactionId: string;
  repairToken: string;
  replayToken: string;
  connectionGeneration: number;
  sessionGeneration: number;
  viewGeneration?: number;
  xtermGeneration?: number;
}

interface BoundProductionRestoreAdapter {
  begin: (overrides?: Record<string, unknown>) => RecoveryCoordinatorResult;
  handle: (event: Record<string, unknown> & { type: string }) => RecoveryCoordinatorResult;
  handleFrom: (
    identity: RestoreIdentity,
    event: Record<string, unknown> & { type: string },
  ) => RecoveryCoordinatorResult;
  remount: (
    identity: RestoreIdentity,
    overrides?: Record<string, unknown>,
  ) => RecoveryCoordinatorResult;
  getState: () => Record<string, unknown> | undefined;
  getTransportStatus: () => Record<string, unknown>;
}

type ProductionRestoreAdapterFactory = (options: {
  coordinator: VisibleOutputRecoveryCoordinator;
  scope: RecoveryScope;
  identity: RestoreIdentity;
}) => BoundProductionRestoreAdapter;

const CURRENT_IDENTITY: RestoreIdentity = {
  transactionId: 'tx-current',
  repairToken: 'repair-current',
  replayToken: 'replay-current',
  connectionGeneration: 7,
  sessionGeneration: 11,
};

function invokeTerminalContainerRestoreAdapter(
  coordinator: VisibleOutputRecoveryCoordinator,
  scope: RecoveryScope,
  signature: string,
): { production: BoundProductionRestoreAdapter; commands: RecoveryCoordinatorEvent[] } {
  const commands: RecoveryCoordinatorEvent[] = [];
  const coordinatorPort: VisibleOutputRecoveryCoordinator = {
    dispatch: (event) => {
      commands.push(event);
      return coordinator.dispatch(event);
    },
    getState: coordinator.getState,
    getTransportStatus: coordinator.getTransportStatus,
  };
  try {
    const factory = (visibleOutputRecoveryModule as Record<string, unknown>)
      .createTerminalContainerRestoreAdapter as ProductionRestoreAdapterFactory;
    const production = factory({ coordinator: coordinatorPort, scope, identity: CURRENT_IDENTITY });
    assert.equal(typeof production.begin, 'function');
    assert.equal(typeof production.handle, 'function');
    assert.equal(typeof production.handleFrom, 'function');
    assert.equal(typeof production.remount, 'function');
    assert.equal(typeof production.getState, 'function');
    assert.equal(typeof production.getTransportStatus, 'function');
    return { production, commands };
  } catch (error) {
    assert.fail(`${signature}; production TerminalContainer adapter invocation failed: ${String(error)}`);
  }
}

test('REL-BGSTAB-007 keeps generic screen repair independent of checkpoint ACK evidence', () => {
  const signature = 'REL-BGSTAB-007 AC-8: a generic server snapshot repair must not wait for checkpoint apply/drain ACK evidence';
  const scope: RecoveryScope = { clientId: 'generic-screen-repair', sessionId: 'session-authority' };
  const adapter = createRecordingRecoveryAdapter();
  const snapshots: Array<{ onWritten: () => void }> = [];
  Object.assign(adapter, {
    enqueueAuthoritativeSnapshot: (write: { onWritten: () => void }) => snapshots.push(write),
  });
  const coordinator = requireRecoveryCoordinatorFactory(signature)({
    maxHeldBytes: 4096,
    maxHeldChunks: 16,
    transportMode: 'unified',
    adapter,
  });
  const { production, commands } = invokeTerminalContainerRestoreAdapter(coordinator, scope, signature);

  production.begin({
    liveSchedulerIdle: false,
    serverReadyLatched: false,
    acknowledgementRequired: true,
    hiddenDirty: true,
    hiddenSkipped: true,
  });
  production.handle({
    type: 'authoritative-snapshot-received',
    snapshotSeq: 51,
    parserBoundary: 'complete',
    parserComplete: true,
    data: 'generic-server-snapshot',
  });
  production.handle({ type: 'live-lane-idle' });
  assert.equal(snapshots.length, 1, signature);
  snapshots[0]?.onWritten();
  assert.deepEqual({
    ready: production.getState()?.currentViewTransactionReady,
    provisional: production.getState()?.provisionalLocalState,
    hiddenDirty: production.getState()?.hiddenDirty,
  }, {
    ready: false,
    provisional: true,
    hiddenDirty: true,
  }, `${signature}; physical write alone cannot release generic recovery`);
  assert.equal(
    commands.some(command => command.type.startsWith('terminal-checkpoint:')),
    false,
    `${signature}; generic repair must not dispatch checkpoint runtime control`,
  );
  assert.equal(
    commands.some(command => 'checkpointEpoch' in (command as unknown as Record<string, unknown>)),
    false,
    `${signature}; generic repair must not carry a checkpoint epoch control identity`,
  );
  production.handle({ type: 'repair-acknowledged' });
  assert.deepEqual({
    ready: production.getState()?.currentViewTransactionReady,
    provisional: production.getState()?.provisionalLocalState,
    hiddenDirty: production.getState()?.hiddenDirty,
  }, {
    ready: false,
    provisional: true,
    hiddenDirty: true,
  }, `${signature}; generic repair ACK still requires the server-ready latch`);
  production.handle({
    type: 'server-ready-latched',
    repairToken: CURRENT_IDENTITY.repairToken,
    replayToken: CURRENT_IDENTITY.replayToken,
  });
  assert.equal(
    commands.some(command => command.type.startsWith('terminal-checkpoint:')),
    false,
    `${signature}; generic repair remains independent of checkpoint runtime control after readiness latches`,
  );
  assert.equal(
    commands.some(command => 'checkpointEpoch' in (command as unknown as Record<string, unknown>)),
    false,
    `${signature}; generic repair remains free of checkpoint identity after readiness latches`,
  );

  assert.deepEqual({
    ready: production.getState()?.currentViewTransactionReady,
    equivalent: production.getState()?.retainedHistoryEquivalent,
    provisional: production.getState()?.provisionalLocalState,
    hiddenDirty: production.getState()?.hiddenDirty,
  }, {
    ready: true,
    equivalent: false,
    provisional: false,
    hiddenDirty: false,
  }, `${signature}; the ready transition must use no checkpoint runtime control`);
});

test('REL-BGSTAB-007 removes checkpoint lifecycle seams from generic screen repair', () => {
  const signature = 'REL-BGSTAB-007 AC-8: generic screen repair is ready after its authoritative snapshot, physical write, repair ACK, and server-ready latch, but remains non-equivalent without a checkpoint-to-recovery bridge';
  const genericRecoverySources = [
    ['TerminalContainer', source],
    ['TerminalView', terminalViewSource],
    ['visibleOutputRecovery', visibleOutputRecoverySource],
  ] as const;
  const forbiddenSeams = [
    'createTerminalContainerCheckpointRecoveryBridge',
    'getCheckpointRecoveryIdentity',
    'onCheckpointRecoveryEvidence',
    'checkpointEvidenceRequired',
    'checkpoint-recovery-evidence',
    'checkpoint-evidence-timeout',
  ] as const;

  for (const [moduleName, moduleSource] of genericRecoverySources) {
    for (const seam of forbiddenSeams) {
      assert.equal(
        moduleSource.includes(seam),
        false,
        `${signature}; ${moduleName} must not retain the ${seam} seam`,
      );
    }
  }
});

test('REL-BGSTAB-007 removes dead Container bridge APIs from the checkpoint runtime', () => {
  const signature = 'REL-BGSTAB-007 AC-8: checkpoint apply/drain protocol remains runtime-local and exposes no Container recovery bridge API';
  const forbiddenBridgeApis = [
    'TerminalCheckpointRecoveryEvidence',
    'onCheckpointRecoveryEvidence',
    'getActiveCheckpointIdentity',
  ] as const;

  for (const api of forbiddenBridgeApis) {
    assert.equal(
      terminalCheckpointRuntimeSource.includes(api),
      false,
      `${signature}; terminalCheckpointRuntime must not retain ${api}`,
    );
  }
});

test('TerminalContainer maps visible output recovery into the input transport barrier', () => {
  assert.match(source, /resolveVisibleOutputRecoveryBarrierReason/);
  assert.match(source, /visible-output-recovery/);
  assert.match(source, /syncInputTransportState\('visible-output-recovery/);
});

test('TerminalContainer routes compatibility authority recovery to a same-socket full snapshot before reconnect', () => {
  const signature = 'FR-BGSTAB-022: compatibility rollback must use authoritative retained replay without connection churn';
  const handlerStart = source.indexOf('const handleVisibleOutputOverflow = useCallback');
  assert.notEqual(handlerStart, -1, signature);
  const handlerChunk = source.slice(handlerStart, handlerStart + 3200);

  assert.match(handlerChunk, /info\.reason\.startsWith\('terminal-authority-recovery:'\)/, signature);
  assert.match(handlerChunk, /consume\('fresh-snapshot'\)/, signature);
  assert.match(
    handlerChunk,
    /send\(\{\s*type: 'repair-replay',\s*sessionId,?\s*\}\)/,
    signature,
  );
  assert.doesNotMatch(
    handlerChunk,
    /requestBoundedVisibleRecoveryReconnect\('terminal-authority-fresh-compatibility-snapshot'\)/,
    signature,
  );
  assert.match(
    handlerChunk,
    /if \(!snapshotRequest\.ok\)[\s\S]*requestBoundedVisibleRecoveryReconnect\('terminal-authority-fresh-snapshot-send-failed'\)/,
    'physical reconnect is allowed only after the same-socket request cannot be sent',
  );
  const authorityReasonIndex = handlerChunk.indexOf("info.reason.startsWith('terminal-authority-recovery:')");
  const snapshotRequestIndex = handlerChunk.indexOf("type: 'repair-replay'");
  const visibilityIndex = handlerChunk.indexOf('if (!isVisibleRef.current)');
  const viewportRepairIndex = handlerChunk.indexOf('requestScreenRepair');
  assert.ok(authorityReasonIndex >= 0 && snapshotRequestIndex > authorityReasonIndex, signature);
  assert.ok(visibilityIndex === -1 || snapshotRequestIndex < visibilityIndex, signature);
  assert.ok(viewportRepairIndex === -1 || snapshotRequestIndex < viewportRepairIndex, signature);
});

test('TerminalContainer keeps compatibility input fenced through matching post-ACK tail drain and ready', () => {
  const signature = 'FR-BGSTAB-022 AC-5: compatibility input opened before ACK tail physical drain plus matching session ready';
  assert.match(source, /compatibilityPostAckConvergenceRef/u, signature);
  assert.match(source, /createTerminalCompatibilityPostAckConvergence/u, signature);

  const snapshotAckStart = source.indexOf(
    "type: 'screen-snapshot:ready'",
    source.indexOf("recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent'"),
  );
  assert.notEqual(snapshotAckStart, -1, signature);
  const snapshotAckChunk = source.slice(snapshotAckStart, source.indexOf('} finally {', snapshotAckStart));
  const postAckIdentityStart = source.indexOf(
    'const viewGeneration = terminalRef.current?.getAuthorityViewGeneration() ?? null;',
    snapshotAckStart - 6000,
  );
  const postAckIdentityChunk = source.slice(postAckIdentityStart, snapshotAckStart);
  assert.match(snapshotAckChunk, /replayToken: nextSnapshot\.replayToken/u, signature);
  assert.match(snapshotAckChunk, /snapshotSeq: nextSnapshot\.seq/u, signature);
  assert.match(snapshotAckChunk, /connectionGeneration: wsConnectionGenerationRef\.current/u, signature);
  assert.match(postAckIdentityChunk, /const viewGeneration = terminalRef\.current\?\.getAuthorityViewGeneration\(\) \?\? null/u, signature);

  const outputStart = source.indexOf('const compatibilityPostAckConvergence = compatibilityPostAckConvergenceRef.current');
  assert.notEqual(outputStart, -1, signature);
  const outputChunk = source.slice(outputStart, outputStart + 6500);
  assert.match(outputChunk, /type: 'output-arrived'/u, signature);
  assert.match(outputChunk, /terminalRef\.current\?\.writeRecoveryTailAndWait/u, signature);
  assert.match(outputChunk, /type: 'output-drained'/u, signature);
  assert.match(
    outputChunk,
    /if \(!arrival\.accepted\) \{[\s\S]*failCompatibilityPostAckConvergence\('stale-or-covered-output'\);\s*return;[\s\S]*writeRecoveryTailAndWait/u,
    'FR-BGSTAB-022 AC-4/5: non-monotonic post-ACK output reached xterm instead of failing before write',
  );

  const readyStart = source.indexOf('const compatibilityPostAckRecovery = compatibilityPostAckConvergenceRef.current');
  assert.notEqual(readyStart, -1, signature);
  const readyChunk = source.slice(readyStart, readyStart + 2600);
  assert.match(readyChunk, /type: 'server-ready-latched'/u, signature);
  assert.match(readyChunk, /message\.replayToken/u, signature);
  assert.match(readyChunk, /message\.snapshotSeq/u, signature);

  assert.match(
    source,
    /recordCompatibilityPostAckState\(state, 'authoritative-snapshot-tail-drained'\)/u,
    signature,
  );
  assert.match(source, /currentViewTransactionReady: true/u, signature);
  assert.match(source, /heldOutputBytes: 0/u, signature);
  assert.match(source, /heldOutputChunks: 0/u, signature);
  assert.match(
    source,
    /if \(compatibilityPostAckConvergenceRef\.current !== null\) \{\s*serverReady = false;\s*barrierReason = 'replay-pending'/u,
    signature,
  );
  assert.match(
    source,
    /sessionReadyRef\.current[\s\S]*compatibilityPostAckConvergenceRef\.current === null[\s\S]*visibleRecoveryBarrier === 'none'/u,
    signature,
  );
});

test('TerminalContainer bounds and clears compatibility post-ACK convergence timeout', () => {
  const signature = 'FR-BGSTAB-022 AC-5: missing ready or xterm callback left compatibility recovery permanently blocked';
  assert.match(source, /compatibilityPostAckTimeoutRef/u, signature);
  assert.match(source, /armCompatibilityPostAckTimeout/u, signature);
  assert.match(source, /clearCompatibilityPostAckTimeout/u, signature);
  assert.match(
    source,
    /createTerminalCompatibilityProgressTimeout\(\{[\s\S]*timeoutMs: TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS[\s\S]*failCompatibilityPostAckConvergence\('convergence-timeout'\)/u,
    signature,
  );
  assert.match(source, /const recordCompatibilityPostAckProgress = useCallback/u, signature);
  assert.ok(
    source.match(/recordCompatibilityPostAckProgress\(\)/gu)?.length === 3,
    'FR-BGSTAB-022 AC-5: arrival, physical drain, and matching ready must each refresh inactivity timeout',
  );

  const finishStart = source.indexOf('const finishCompatibilityPostAckConvergence');
  assert.notEqual(finishStart, -1, signature);
  const finishChunk = source.slice(finishStart, finishStart + 2200);
  assert.match(finishChunk, /clearCompatibilityPostAckTimeout\(\)/u, signature);

  const disconnectStart = source.indexOf("recordCompatibilityPostAckState(compatibilityPostAckRecovery, 'connection-closed')");
  assert.notEqual(disconnectStart, -1, signature);
  assert.match(
    source.slice(disconnectStart, disconnectStart + 500),
    /clearCompatibilityPostAckTimeout\(\)/u,
    signature,
  );
});

test('TerminalContainer keeps queued input deferred while visible output recovery is blocking', () => {
  const readyForFlushIndex = source.indexOf('const readyForFlush = Boolean(');
  assert.notEqual(readyForFlushIndex, -1);
  const visibleBarrierIndex = source.lastIndexOf(
    'const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);',
    readyForFlushIndex,
  );
  assert.notEqual(visibleBarrierIndex, -1);
  const readyForFlushChunk = source.slice(visibleBarrierIndex, readyForFlushIndex + 350);

  assert.match(readyForFlushChunk, /resolveVisibleOutputRecoveryBarrierReason/);
  assert.match(readyForFlushChunk, /=== 'none'/);
});

test('TerminalContainer retries queued input after visible output recovery finishes', () => {
  const finishIndex = source.indexOf('const finishVisibleOutputRecoveryIfPending = useCallback');
  assert.notEqual(finishIndex, -1);
  const finishChunk = source.slice(finishIndex, finishIndex + 1000);

  assert.match(finishChunk, /const finishReason = `visible-output-recovery-finished-\$\{source\}`/);
  assert.match(finishChunk, /syncInputTransportState\(finishReason\)/);
  assert.match(finishChunk, /flushTransportOutbox\(finishReason\)/);
});

test('TerminalContainer does not finish visible recovery after fallback snapshot placeholder', () => {
  const finishIndex = source.indexOf("finishVisibleOutputRecoveryIfPending('screen-snapshot')");
  assert.notEqual(finishIndex, -1);
  const surroundingChunk = source.slice(Math.max(0, finishIndex - 250), finishIndex + 120);

  assert.match(
    surroundingChunk,
    /if \(\s*visibleOutputRecoverySnapshotSucceeded\s*&& compatibilityPostAckConvergenceRef\.current === null\s*\) \{\s*finishVisibleOutputRecoveryIfPending\('screen-snapshot'\)/,
  );
});

test('TerminalContainer does not suppress authoritative repair while visible recovery is pending', () => {
  const suppressIndex = source.indexOf('const shouldSuppressScreenRepairRequest = useCallback');
  assert.notEqual(suppressIndex, -1);
  const suppressChunk = source.slice(suppressIndex, suppressIndex + 1400);

  const inFlightIndex = suppressChunk.indexOf('const inFlight = screenRepairInFlightRef.current');
  const visibleRecoveryIndex = suppressChunk.indexOf('resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current)');
  const completedIndex = suppressChunk.indexOf('const completed = lastCompletedScreenRepairRef.current');
  assert.notEqual(inFlightIndex, -1);
  assert.notEqual(visibleRecoveryIndex, -1);
  assert.notEqual(completedIndex, -1);
  assert.ok(inFlightIndex < visibleRecoveryIndex);
  assert.ok(visibleRecoveryIndex < completedIndex);

  const visibleRecoveryChunk = suppressChunk.slice(visibleRecoveryIndex, completedIndex);
  assert.match(visibleRecoveryChunk, /visibleRecoveryBarrier !== 'none'/);
  assert.match(visibleRecoveryChunk, /return false/);
});

test('TerminalContainer uses runtime-configured transport outbox limits', () => {
  assert.doesNotMatch(source, /const TRANSPORT_INPUT_QUEUE_TTL_MS/);
  assert.doesNotMatch(source, /const TRANSPORT_INPUT_QUEUE_BYTE_BUDGET/);
  assert.match(source, /getTransportOutboxLimits/);
});

test('TerminalContainer does not clear hidden output recovery after fallback placeholder', () => {
  const placeholderIndex = source.indexOf('screen_snapshot_fallback_placeholder_applied');
  assert.notEqual(placeholderIndex, -1);
  const nextChunk = source.slice(placeholderIndex, placeholderIndex + 700);

  assert.doesNotMatch(nextChunk, /finishHiddenOutputRecovery/);
  assert.match(source, /shouldClearHiddenOutputAfterSnapshotRecovery/);
});

test('TerminalContainer only finishes visible recovery after authoritative snapshot or local restore success', () => {
  const snapshotIndex = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  assert.notEqual(snapshotIndex, -1);
  const snapshotChunk = source.slice(
    snapshotIndex,
    source.indexOf('const handleCompatibilityAuthorityReady', snapshotIndex),
  );

  assert.match(snapshotChunk, /let visibleOutputRecoverySnapshotSucceeded = false;/);

  const localRestoreIndex = snapshotChunk.indexOf('screen_snapshot_fallback_local_restore');
  assert.notEqual(localRestoreIndex, -1);
  const localRestoreChunk = snapshotChunk.slice(localRestoreIndex, localRestoreIndex + 700);
  assert.match(localRestoreChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const authoritativeIndex = snapshotChunk.indexOf('screen_snapshot_authoritative_applied');
  assert.notEqual(authoritativeIndex, -1);
  const authoritativeChunk = snapshotChunk.slice(authoritativeIndex, authoritativeIndex + 900);
  assert.match(authoritativeChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const fallbackIndex = snapshotChunk.indexOf('screen_snapshot_fallback_applied');
  assert.notEqual(fallbackIndex, -1);
  const fallbackChunk = snapshotChunk.slice(fallbackIndex, fallbackIndex + 650);
  assert.doesNotMatch(fallbackChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const placeholderIndex = snapshotChunk.indexOf('screen_snapshot_fallback_placeholder_applied');
  assert.notEqual(placeholderIndex, -1);
  const placeholderChunk = snapshotChunk.slice(placeholderIndex, placeholderIndex + 650);
  assert.doesNotMatch(placeholderChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const finishIndex = snapshotChunk.indexOf("finishVisibleOutputRecoveryIfPending('screen-snapshot')");
  assert.notEqual(finishIndex, -1);
  const finishGuardChunk = snapshotChunk.slice(Math.max(0, finishIndex - 180), finishIndex + 90);
  assert.match(
    finishGuardChunk,
    /if \(\s*visibleOutputRecoverySnapshotSucceeded\s*&& compatibilityPostAckConvergenceRef\.current === null/,
  );
});

test('TerminalContainer does not suppress recent repair while visible recovery is pending', () => {
  const repairIndex = source.indexOf('const requestScreenRepair = useCallback');
  assert.notEqual(repairIndex, -1);
  const repairChunk = source.slice(repairIndex, repairIndex + 2200);

  assert.match(repairChunk, /if \(shouldSuppressScreenRepairRequest\(reason, geometry\.cols, geometry\.rows\)\)/);
  assert.doesNotMatch(repairChunk, /!visibleOutputRecoveryStateRef\.current\.pending\s*&&\s*shouldSuppressScreenRepairRequest/);
});

test('TerminalContainer uses runtime terminal limits for transport outbox budget and TTL', () => {
  assert.match(source, /getTransportOutboxLimits/);
  assert.doesNotMatch(source, /TRANSPORT_INPUT_QUEUE_BYTE_BUDGET/);
  assert.doesNotMatch(source, /TRANSPORT_INPUT_QUEUE_TTL_MS/);

  const classifyIndex = source.indexOf('const classifyTransportQueueDecision = useCallback');
  assert.notEqual(classifyIndex, -1);
  const classifyChunk = source.slice(classifyIndex, classifyIndex + 1800);
  assert.match(classifyChunk, /transportOutboxTtlMs/);
  assert.match(classifyChunk, /ttlMs: transportOutboxTtlMs/);

  const enqueueIndex = source.indexOf('const enqueueTransportInput = useCallback');
  assert.notEqual(enqueueIndex, -1);
  const enqueueChunk = source.slice(enqueueIndex, enqueueIndex + 2600);
  assert.match(enqueueChunk, /transportOutboxMaxBytes/);
  assert.match(enqueueChunk, /queuedByteBudget: transportOutboxMaxBytes/);
});

test('TerminalContainer preserves absent normal-wire screen sequence as unknown', () => {
  const outputIndex = source.indexOf('onOutput: (delivery: TerminalOutputDelivery)');
  assert.notEqual(outputIndex, -1);
  // Widened from 2600 to span the whole handler. The sequence is now forwarded in
  // two places — the unsegmented fallback and the per-chunk loop — and a window
  // that reaches only the first would stop covering the path that carries most
  // deliveries.
  const outputChunk = source.slice(outputIndex, outputIndex + 9000);

  assert.match(outputChunk, /screenSeq: delivery\.whole\.screenSeq/);
  assert.match(outputChunk, /screenSeq: chunk\.screenSeq/);
  // Matches a default applied to any receiver, not just the one spelled above, so
  // renaming the source of the value cannot make this unfalsifiable.
  assert.doesNotMatch(outputChunk, /screenSeq:\s*[\w.]*screenSeq\s*\?\?/);
  assert.doesNotMatch(outputChunk, /screenSeq:\s*outputOrdinal/);
});

test('TerminalContainer applies visible resync output admission in the production handler', () => {
  const outputIndex = source.indexOf('onOutput: (delivery: TerminalOutputDelivery)');
  assert.notEqual(outputIndex, -1);
  const outputChunk = source.slice(outputIndex, outputIndex + 9000);

  assert.match(outputChunk, /classifyVisibleResyncOutputBatch\(\{/);
  assert.match(outputChunk, /activeReplayToken: activeResync\.replayToken/);
  assert.match(outputChunk, /matchingServerReadyLatched: activeResync\.matchingServerReadyLatched/);
  assert.match(outputChunk, /chunks: recoveryChunks/);
  assert.match(outputChunk, /if \(recoveryAdmissions === null\)/);
  assert.match(outputChunk, /for \(const chunk of recoveryChunks\)/);
  assert.doesNotMatch(outputChunk, /restoreAdapter\.handle[\s\S]*admission === 'stale'/);
});

test('TerminalContainer fences stale snapshot tokens before terminal replacement', () => {
  const fenceIndex = source.indexOf('const handleVisibleResyncSnapshotBeforeApply');
  assert.notEqual(fenceIndex, -1);
  const fenceChunk = source.slice(fenceIndex, fenceIndex + 2600);

  assert.match(fenceChunk, /matchesRestoreNeededSnapshotAuthorityProof\(activeVisibleResync, snapshot\)/);
  assert.match(fenceChunk, /snapshot-authority-proof-mismatch/);
  assert.match(fenceChunk, /visible_output_resync_snapshot_stale_ignored/);
  assert.match(fenceChunk, /return true;/);
  assert.match(fenceChunk, /snapshot\.mode === 'authoritative'/);
});

test('TerminalContainer keeps active resync isolated from late legacy repair callbacks', () => {
  const repairIndex = source.indexOf('const handleScreenRepair = useEffectEvent');
  const rejectedIndex = source.indexOf('const handleScreenRepairRejected = useEffectEvent');
  const reconnectIndex = source.indexOf('const handleScreenRepairReconnectRequired = useEffectEvent');
  assert.notEqual(repairIndex, -1);
  assert.notEqual(rejectedIndex, -1);
  assert.notEqual(reconnectIndex, -1);

  const repairChunk = source.slice(repairIndex, repairIndex + 1800);
  const rejectedChunk = source.slice(rejectedIndex, rejectedIndex + 1800);
  const reconnectChunk = source.slice(reconnectIndex, reconnectIndex + 1800);
  assert.match(repairChunk, /activeVisibleOutputResyncRef\.current/);
  assert.match(repairChunk, /visible_output_resync_legacy_repair_ignored/);
  assert.match(rejectedChunk, /rejected\.repairToken !== activeResync\.repairToken/);
  assert.match(rejectedChunk, /type: 'recovery-failed'/);
  assert.match(reconnectChunk, /message\.repairToken !== runtime\.repairToken/);
  assert.match(reconnectChunk, /return;/);
});

test('TerminalContainer production recovery requests a token-fenced fresh snapshot and real reconnect', () => {
  const freshIndex = source.indexOf('requestFreshSnapshot(request)');
  const reconnectIndex = source.indexOf('const handleScreenRepairReconnectRequired');
  assert.notEqual(freshIndex, -1);
  assert.notEqual(reconnectIndex, -1);

  const freshChunk = source.slice(freshIndex, freshIndex + 1200);
  const reconnectChunk = source.slice(reconnectIndex, reconnectIndex + 2600);
  assert.match(freshChunk, /type: 'repair-replay'/);
  assert.match(freshChunk, /supersedeReplayToken: request\.replayToken/);
  assert.match(freshChunk, /repairToken: runtime\.repairToken/);
  assert.match(freshChunk, /requestBoundedVisibleRecoveryReconnect\('fresh-snapshot-send-failed'\)/);
  assert.match(reconnectChunk, /requestBoundedVisibleRecoveryReconnect\('screen-repair-reconnect-required'\)/);

  assert.match(webSocketContextSource, /requestReconnect: \(reason: string\) => boolean/);
  assert.match(webSocketContextSource, /const requestReconnect = useCallback/);
  const requestReconnectIndex = source.indexOf('const requestBoundedVisibleRecoveryReconnect');
  const requestReconnectChunk = source.slice(requestReconnectIndex, requestReconnectIndex + 1200);
  assert.match(requestReconnectChunk, /recordTerminalDebugEvent\(sessionId, 'visible_output_resync_reconnect_requested'/);
  assert.ok(
    requestReconnectChunk.indexOf("'visible_output_resync_reconnect_requested'")
      < requestReconnectChunk.indexOf('requestReconnect(reason)'),
    'the terminal recovery reason must be recorded before requesting a control socket reconnect',
  );
  assert.match(webSocketContextSource, /socket\.close\(4001, reason\.slice\(0, 123\)\)/);
});

test('TerminalContainer makes duplicate restore-needed idempotent and fences snapshot sequence', () => {
  const restoreIndex = source.indexOf('const handleScreenRepairRestoreNeeded = useEffectEvent');
  const snapshotIndex = source.indexOf('const handleVisibleResyncSnapshotBeforeApply');
  assert.notEqual(restoreIndex, -1);
  assert.notEqual(snapshotIndex, -1);

  const restoreChunk = source.slice(restoreIndex, restoreIndex + 3200);
  const snapshotChunk = source.slice(snapshotIndex, snapshotIndex + 3000);
  assert.match(restoreChunk, /message\.repairToken === previous\.repairToken/);
  assert.match(restoreChunk, /message\.replayToken === previous\.replayToken/);
  assert.match(restoreChunk, /hasSameRestoreNeededAuthorityProof\(previous, message\)/);
  assert.match(restoreChunk, /restore-needed-authority-proof-mismatch/);
  assert.match(restoreChunk, /visible_output_resync_restore_duplicate_ignored/);
  assert.match(restoreChunk, /supersededVisibleOutputResyncKeysRef/);
  assert.match(snapshotChunk, /matchesRestoreNeededSnapshotAuthorityProof\(activeVisibleResync, snapshot\)/);
  assert.match(snapshotChunk, /visible_output_resync_snapshot_authority_proof_mismatch/);
});

test('TerminalContainer leaves provisional fallback unacked for bounded server reconnect', () => {
  const snapshotIndex = source.indexOf('const handleVisibleResyncSnapshotBeforeApply');
  assert.notEqual(snapshotIndex, -1);
  const snapshotChunk = source.slice(snapshotIndex, snapshotIndex + 3600);

  assert.match(snapshotChunk, /snapshot\.mode === 'authoritative'/);
  assert.match(snapshotChunk, /visible_output_resync_provisional_awaiting_reconnect/);
  const provisionalIndex = snapshotChunk.indexOf('visible_output_resync_provisional_awaiting_reconnect');
  const provisionalChunk = snapshotChunk.slice(Math.max(0, provisionalIndex - 500), provisionalIndex + 700);
  assert.doesNotMatch(provisionalChunk, /screen-snapshot:ready/);
});

test('WebSocket grace installs restore barrier before subscribed-ready and preserves duplicate chunks', () => {
  const flushIndex = webSocketContextSource.indexOf('const flushGraceBuffer = useCallback');
  const flushChunk = webSocketContextSource.slice(flushIndex, flushIndex + 1800);
  assert.notEqual(flushIndex, -1);
  assert.ok(
    flushChunk.indexOf('onScreenRepairRestoreNeeded') < flushChunk.indexOf('onSubscribed'),
  );

  const bufferIndex = webSocketContextSource.indexOf("case 'screen-repair:restore-needed':");
  const bufferChunk = webSocketContextSource.slice(bufferIndex, bufferIndex + 2200);
  assert.notEqual(bufferIndex, -1);
  assert.match(bufferChunk, /screen_repair_restore_grace_duplicate_ignored/);
  assert.match(bufferChunk, /hasSameRestoreNeededAuthorityProof\(current\.restoreNeeded, msg\)/);
  assert.match(bufferChunk, /screen_repair_restore_grace_proof_mismatch_ignored/);
  assert.match(bufferChunk, /current\.authorityProofMismatch = true/);
  assert.ok(bufferChunk.indexOf('break;') < bufferChunk.indexOf('current.output = [];'));
  assert.match(webSocketContextSource, /handlers\.onGraceAuthorityProofMismatch\?\.\(\)/);
  assert.match(source, /onGraceAuthorityProofMismatch:[\s\S]*requestBoundedVisibleRecoveryReconnect\('websocket-grace-authority-proof-mismatch'\)/u);
});

test('WebSocket grace fences replay generations and makes reconnect terminal', () => {
  const snapshotIndex = webSocketContextSource.indexOf("case 'screen-snapshot':");
  const restoreIndex = webSocketContextSource.indexOf("case 'screen-repair:restore-needed':");
  const reconnectIndex = webSocketContextSource.indexOf("case 'screen-repair:reconnect-required':");
  const readyIndex = webSocketContextSource.indexOf("case 'session:ready':");
  const flushIndex = webSocketContextSource.indexOf('const flushGraceBuffer = useCallback');
  assert.notEqual(snapshotIndex, -1);
  assert.notEqual(restoreIndex, -1);
  assert.notEqual(reconnectIndex, -1);
  assert.notEqual(readyIndex, -1);
  assert.notEqual(flushIndex, -1);

  const snapshotChunk = webSocketContextSource.slice(snapshotIndex, restoreIndex);
  const restoreChunk = webSocketContextSource.slice(restoreIndex, reconnectIndex);
  const reconnectChunk = webSocketContextSource.slice(reconnectIndex, reconnectIndex + 650);
  const readyChunk = webSocketContextSource.slice(readyIndex, readyIndex + 650);
  const flushChunk = webSocketContextSource.slice(flushIndex, flushIndex + 2200);

  assert.match(snapshotChunk, /current\.reconnectRequired/);
  assert.match(snapshotChunk, /matchesRestoreNeededSnapshotAuthorityProof\(current\.restoreNeeded, msg\)/);
  assert.match(snapshotChunk, /current\.ready = undefined/);
  assert.match(restoreChunk, /current\.snapshot = undefined/);
  assert.match(restoreChunk, /current\.ready = undefined/);
  assert.match(reconnectChunk, /current\.restoreNeeded = undefined/);
  assert.match(reconnectChunk, /current\.snapshot = undefined/);
  assert.match(reconnectChunk, /current\.ready = undefined/);
  assert.match(reconnectChunk, /current\.output = \[\]/);
  assert.match(readyChunk, /current\.restoreNeeded/);
  assert.match(readyChunk, /msg\.replayToken !== current\.restoreNeeded\.replayToken/);
  assert.match(readyChunk, /current\.snapshot/);
  assert.match(flushChunk, /const recoveryTerminal = Boolean\(buffered\.reconnectRequired\)/);
  assert.match(
    flushChunk,
    /const recoveryBlocked = recoveryTerminal \|\| Boolean\(buffered\.outputOverflowReason\) \|\| Boolean\(buffered\.restoreNeeded\)/,
  );
  assert.match(flushChunk, /if \(!recoveryTerminal && buffered\.restoreNeeded\)/);
  assert.match(flushChunk, /if \(!recoveryTerminal && !buffered\.outputOverflowReason && buffered\.snapshot\)/);
  assert.match(
    flushChunk,
    /if \(!recoveryTerminal && recoverySnapshotReady && !buffered\.outputOverflowReason && buffered\.ready\)/,
  );
  assert.match(flushChunk, /ready: recoveryBlocked \? false : buffered\.subscribedInfo\.ready/);
  assert.ok(
    flushChunk.indexOf('onScreenRepairReconnectRequired') < flushChunk.indexOf('onSubscribed'),
  );
  assert.ok(
    flushChunk.indexOf('onGraceOutputOverflow') < flushChunk.indexOf('onSubscribed'),
  );
});

test('TerminalContainer forces current replay snapshot past legacy content dedup', () => {
  const snapshotIndex = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  const snapshotChunk = source.slice(
    snapshotIndex,
    source.indexOf('const handleCompatibilityAuthorityReady', snapshotIndex),
  );
  assert.notEqual(snapshotIndex, -1);
  assert.match(snapshotChunk, /forceCurrentActiveReplacement/);
  assert.match(snapshotChunk, /!forceCurrentActiveReplacement\s*&&\s*!forceReplacementRecoveryConvergence\s*&&\s*!!lastApplied/);
  assert.match(snapshotChunk, /const isDuplicate = !forceCurrentActiveReplacement/);
});

test('TerminalContainer serializes legacy and hidden mutations before server authority', () => {
  const repairIndex = source.indexOf('const handleScreenRepair = useEffectEvent');
  const snapshotIndex = source.indexOf('replaceAuthoritativeSnapshot');
  const hiddenIndex = source.indexOf('const restoreMutation = visibleOutputMutationFenceRef');
  assert.notEqual(repairIndex, -1);
  assert.notEqual(snapshotIndex, -1);
  assert.notEqual(hiddenIndex, -1);

  assert.match(source.slice(repairIndex, repairIndex + 2200), /runSpeculative/);
  assert.match(source.slice(snapshotIndex - 500, snapshotIndex + 2200), /runAuthoritative/);
  const hiddenChunk = source.slice(hiddenIndex, hiddenIndex + 1000);
  assert.match(hiddenChunk, /runSpeculative/);
  assert.match(hiddenChunk, /!mutation\.accepted/);
});

test('TerminalContainer binds Container and TerminalView adapters to one recovery identity', () => {
  assert.match(source, /const restoreIdentity = \{/);
  assert.match(source, /createTerminalContainerRestoreAdapter\(\{[\s\S]*?identity: restoreIdentity/);
  assert.match(source, /const restoreTerminal = terminalRef\.current;[\s\S]*?restoreTerminal\?\.bindRestoreCoordinator\(\{[\s\S]*?identity: restoreIdentity/);
  assert.match(source, /const liveLaneIdlePromise = restoreTerminal\?\.awaitOutputIdle\(\)/);
  assert.match(source, /enqueueCompletionProbe\(probe\)/);
});

test('TerminalContainer settles the live-lane idle fence before resetting visible output', () => {
  const signature = 'REL-BGSTAB-009: restore reset must not cancel the in-flight live-lane idle barrier';
  const restoreStart = source.indexOf('const liveLaneIdlePromise = restoreTerminal?.awaitOutputIdle()');
  const idleThenIndex = source.indexOf('void liveLaneIdlePromise.then((idle) => {', restoreStart);
  const clearIndex = source.indexOf('restoreTerminal?.clearVisibleOutputRecovery()', restoreStart);
  const idleSignalIndex = source.indexOf("runtime.restoreAdapter.handle({ type: 'live-lane-idle' })", idleThenIndex);

  assert.notEqual(restoreStart, -1, signature);
  assert.notEqual(idleThenIndex, -1, signature);
  assert.notEqual(clearIndex, -1, signature);
  assert.notEqual(idleSignalIndex, -1, signature);
  assert.ok(clearIndex > idleThenIndex && clearIndex < idleSignalIndex, signature);
});

test('TerminalContainer keeps legacy repair recovery blocked when ready ACK send fails', () => {
  const signature = 'REL-BGSTAB-009: legacy repair ACK send failure must retain stale/input barriers and converge through bounded recovery';
  const repairStart = source.indexOf('const handleScreenRepair = useEffectEvent');
  const ackStart = source.indexOf("send({ type: 'screen-repair:ready'", repairStart);
  const ackFailureStart = source.indexOf('if (!ackResult.ok) {', ackStart);
  const successCompletionStart = source.indexOf('lastCompletedScreenRepairRef.current = {', ackFailureStart);
  const ackFailureChunk = source.slice(ackFailureStart, successCompletionStart);

  assert.notEqual(repairStart, -1, signature);
  assert.notEqual(ackStart, -1, signature);
  assert.notEqual(ackFailureStart, -1, signature);
  assert.notEqual(successCompletionStart, -1, signature);
  assert.match(ackFailureChunk, /requestBoundedVisibleRecoveryReconnect\('screen-repair-ack-send-failed'\)/, signature);
  assert.match(
    ackFailureChunk,
    /finishVisibleOutputRecoveryIfPending\('screen-repair-ack-send-failed',\s*\{\s*keepTerminalStale: true,?\s*\}\)/,
    signature,
  );
  assert.match(ackFailureChunk, /return;/, signature);
});

test('TerminalContainer keeps snapshot recovery blocked when ready ACK send fails', () => {
  const signature = 'REL-BGSTAB-009: snapshot ACK send failure must not finish recovery or release queued input';
  const snapshotStart = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  const ackStart = source.indexOf(
    'const ackResult = send({',
    source.indexOf("recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent'", snapshotStart),
  );
  const ackFailureStart = source.indexOf('if (!ackResult.ok) {', ackStart);
  const ackSuccessStart = source.indexOf("} else if (nextSnapshot.mode === 'authoritative')", ackFailureStart);
  const ackFailureChunk = source.slice(ackFailureStart, ackSuccessStart);
  const handlerStart = source.indexOf('const handleScreenSnapshotAckSendFailure = useCallback');
  const handlerEnd = source.indexOf('// @req REL-BGSTAB-008', handlerStart);
  const handlerChunk = source.slice(handlerStart, handlerEnd);

  assert.notEqual(snapshotStart, -1, signature);
  assert.notEqual(ackStart, -1, signature);
  assert.notEqual(ackFailureStart, -1, signature);
  assert.notEqual(ackSuccessStart, -1, signature);
  assert.match(ackFailureChunk, /handleScreenSnapshotAckSendFailure\(nextSnapshot, 'applied', ackResult\.reason\)/, signature);
  assert.match(ackFailureChunk, /continue;/, signature);
  assert.match(handlerChunk, /finishVisibleOutputRecoveryIfPending\('screen-snapshot-ack-send-failed',[\s\S]*keepTerminalStale: true/, signature);
  assert.match(handlerChunk, /requestBoundedVisibleRecoveryReconnect\('screen-snapshot-ack-send-failed'\)/, signature);
});

test('TerminalContainer keeps restore-buffer failure non-ACKable while acknowledging only a checkpoint takeover', () => {
  const signature = 'REL-BGSTAB-010: restore-buffer failure must remain stale, while an explicit checkpoint takeover may supersede a hard-refresh snapshot';
  const snapshotStart = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  const applyStart = source.indexOf('const replaceAuthoritativeSnapshot = () =>', snapshotStart);
  const rejectedStart = source.indexOf('if (!applied) {', applyStart);
  const appliedEventStart = source.indexOf("recordTerminalDebugEvent(sessionId, 'screen_snapshot_authoritative_applied'", rejectedStart);
  const ackStart = source.indexOf("recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent'", appliedEventStart);
  const rejectedChunk = source.slice(rejectedStart, appliedEventStart);
  const overflowStart = terminalViewSource.indexOf('const flushBufferedOutput = useCallback');
  const overflowEnd = terminalViewSource.indexOf('const releaseRestorePending = useCallback', overflowStart);
  const overflowChunk = terminalViewSource.slice(overflowStart, overflowEnd);
  const overflowHandlerStart = source.indexOf('const handleVisibleOutputOverflow = useCallback');
  const overflowHandlerEnd = source.indexOf('useEffect(() => {', overflowHandlerStart);
  const overflowHandlerChunk = source.slice(overflowHandlerStart, overflowHandlerEnd);

  assert.notEqual(snapshotStart, -1, signature);
  assert.notEqual(applyStart, -1, signature);
  assert.notEqual(rejectedStart, -1, signature);
  assert.notEqual(appliedEventStart, -1, signature);
  assert.notEqual(ackStart, -1, signature);
  assert.notEqual(overflowHandlerStart, -1, signature);
  assert.match(rejectedChunk, /replacementRejectionReason === 'checkpoint-authority-active'/u, signature);
  assert.match(rejectedChunk, /screen_snapshot_checkpoint_authority_superseded/u, signature);
  assert.match(rejectedChunk, /type: 'screen-snapshot:ready'/u, signature);
  const checkpointTakeoverStart = rejectedChunk.indexOf('if (checkpointAuthoritySuperseded)');
  const checkpointTakeoverEnd = indexOfCheckpointAuthorityGuard(
    rejectedChunk,
    checkpointTakeoverStart,
  );
  const checkpointTakeoverChunk = rejectedChunk.slice(
    checkpointTakeoverStart,
    checkpointTakeoverEnd,
  );
  assert.notEqual(checkpointTakeoverStart, -1, signature);
  assert.notEqual(checkpointTakeoverEnd, -1, signature);
  // `slice(start, -1)` yields a chunk 3x too long that still satisfies every
  // assertion below, so the -1 guard above is the only thing scoping them. Pin the
  // boundary itself: the takeover chunk must stop before the non-checkpoint branch.
  assert.doesNotMatch(checkpointTakeoverChunk, CHECKPOINT_AUTHORITY_ACTIVE_GUARD, signature);
  assert.match(checkpointTakeoverChunk, /initialRestorePendingRef\.current = false;/u, signature);
  assert.doesNotMatch(
    checkpointTakeoverChunk,
    /terminalRef\.current\?\.releasePending\(\);/u,
    'checkpoint takeover must not append the superseded restore buffer after checkpoint rehydration',
  );
  assert.match(
    checkpointTakeoverChunk,
    /terminalRef\.current\?\.completeCheckpointTakeover\(\);/u,
    'checkpoint takeover must release the prepared checkpoint delivery without releasing held output',
  );
  const nonCheckpointRejectedStart = indexOfCheckpointAuthorityGuard(rejectedChunk);
  assert.notEqual(nonCheckpointRejectedStart, -1, signature);
  const nonCheckpointRejectedChunk = rejectedChunk.slice(nonCheckpointRejectedStart);
  assert.match(nonCheckpointRejectedChunk, /continue;/u, signature);
  assert.doesNotMatch(rejectedChunk, /historySeenRef\.current = true/u, signature);
  assert.doesNotMatch(rejectedChunk, /lastAppliedSnapshotRef\.current =/u, signature);
  assert.doesNotMatch(nonCheckpointRejectedChunk, /screen-snapshot:ready/u, signature);
  assert.match(
    rejectedChunk,
    /requestBoundedVisibleRecoveryReconnect\('authoritative-snapshot-apply-rejected'\)/u,
    'unproven FAILED_HELD coverage must stay non-ACKable and continue bounded recovery',
  );
  assert.equal(rejectedStart < appliedEventStart && appliedEventStart < ackStart, true, signature);
  assert.match(
    source.slice(applyStart, rejectedStart),
    /requiresAuthoritativeMutationFence[\s\S]*failedHeldCoverage:[\s\S]*snapshotSeq: nextSnapshot\.seq[\s\S]*coversThroughSeq: nextSnapshot\.coversThroughSeq \?\? nextSnapshot\.seq[\s\S]*replayToken: nextSnapshot\.replayToken[\s\S]*supersedesReplayToken: nextSnapshot\.supersedesReplayToken[\s\S]*authorityEpoch: nextSnapshot\.authorityEpoch[\s\S]*authorityRevision: nextSnapshot\.authorityRevision/u,
    'the matching authoritative checkpoint must explicitly supersede FAILED_HELD buffer ownership',
  );
  assert.match(
    source,
    /for \(const chunk of liveChunks\)[\s\S]*terminalRef\.current\?\.submitOutput\(chunk\.data, \{[\s\S]*screenSeq: chunk\.screenSeq,[\s\S]*replayToken: delivery\.replayToken,[\s\S]*authorityEpoch: chunk\.authorityEpoch,[\s\S]*authorityRevision: chunk\.authorityRevision,[\s\S]*connectionGeneration: wsConnectionGenerationRef\.current/u,
    'live-output ownership must carry server sequence and authority lineage into the restore buffer',
  );
  assert.match(overflowChunk, /onVisibleOutputOverflow\?\.\(\{[\s\S]*reason: 'restore-pending-output-admission-rejected'/u, signature);
  assert.match(overflowHandlerChunk, /beginVisibleOutputRecovery\(visibleOutputRecoveryStateRef\.current\)/u, signature);
  assert.match(overflowHandlerChunk, /syncInputTransportState\('visible-output-recovery-started'\)/u, signature);
  assert.match(
    overflowHandlerChunk,
    /info\.reason === 'restore-pending-output-admission-rejected'[\s\S]*requestBoundedVisibleRecoveryReconnect\('restore-buffer-admission-rejected'\)/u,
    signature,
  );
});

test('TerminalContainer defers a rollback-era authoritative snapshot until legacy authority releases it', () => {
  const signature = 'MIG-BGSTAB-002: rollback-era authoritative snapshot must be applied before its ready ACK';
  const snapshotStart = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  const authoritativeApplyStart = source.indexOf('const replaceAuthoritativeSnapshot = () =>', snapshotStart);
  const rejectedStart = source.indexOf('if (!applied) {', authoritativeApplyStart);
  const rejectedEnd = source.indexOf("recordTerminalDebugEvent(sessionId, 'screen_snapshot_apply_skipped'", rejectedStart);
  const deferredStart = indexOfCheckpointAuthorityGuard(source, rejectedStart);
  const deferredEnd = source.indexOf('const failedRuntime = activeVisibleOutputResyncRef.current;', deferredStart);
  const deferredChunk = source.slice(deferredStart, deferredEnd);
  const terminalViewStart = source.indexOf('<TerminalView');
  const terminalViewChunk = source.slice(terminalViewStart, terminalViewStart + 1200);

  assert.notEqual(rejectedStart, -1, signature);
  assert.notEqual(rejectedEnd, -1, signature);
  assert.notEqual(deferredStart, -1, signature);
  assert.notEqual(deferredEnd, -1, signature);
  assert.match(source, /pendingCheckpointAuthoritySnapshotRef/, signature);
  assert.match(deferredChunk, /isCheckpointAuthorityActive\(\) === true[\s\S]*\|\|[\s\S]*isCompatibilityRecoveryPending\(\) === true/, signature);
  assert.match(deferredChunk, /pendingCheckpointAuthoritySnapshotRef\.current = nextSnapshot/, signature);
  assert.doesNotMatch(deferredChunk, /type: 'screen-snapshot:ready'/, signature);
  assert.match(terminalViewChunk, /onCompatibilityAuthorityReady=/, signature);
  assert.match(terminalViewSource, /onCompatibilityAuthorityReady\?\.\(\)/, signature);
});

test('TerminalContainer drains an authority-ready deferred snapshot after an in-flight apply settles', () => {
  const signature = 'MIG-BGSTAB-002: authority-ready during snapshot apply must not strand the deferred snapshot';
  const readyStart = source.indexOf('const handleCompatibilityAuthorityReady = useEffectEvent');
  const readyEnd = source.indexOf('const handleScreenRepair = useEffectEvent', readyStart);
  const readyChunk = source.slice(readyStart, readyEnd);
  const finallyStart = source.indexOf('} finally {', source.indexOf('const handleScreenSnapshot = useEffectEvent'));
  const finallyEnd = source.indexOf('const handleCompatibilityAuthorityReady = useEffectEvent', finallyStart);
  const finallyChunk = source.slice(finallyStart, finallyEnd);

  assert.notEqual(readyStart, -1, signature);
  assert.notEqual(finallyStart, -1, signature);
  assert.match(source, /compatibilityAuthorityReadyRef/, signature);
  assert.match(
    readyChunk,
    /if \(!deferredSnapshot\) \{[\s\S]*return;[\s\S]*compatibilityAuthorityReadyRef\.current = true;[\s\S]*if \(!terminalRef\.current\) \{[\s\S]*return;/,
    signature,
  );
  assert.match(finallyChunk, /compatibilityAuthorityReadyRef\.current[\s\S]*pendingCheckpointAuthoritySnapshotRef\.current/, signature);
  assert.match(finallyChunk, /void handleScreenSnapshot\(deferredSnapshot\)/, signature);
});

test('TerminalContainer retries an authority-ready deferred snapshot after its terminal ref reattaches', () => {
  const signature = 'MIG-BGSTAB-002: ref recreation must not strand an authority-ready deferred snapshot';
  const readyStart = source.indexOf('const handleCompatibilityAuthorityReady = useEffectEvent');
  const effectStart = source.indexOf('useEffect(() => {', readyStart);
  const effectEnd = source.indexOf('useEffect(() => {', effectStart + 1);
  const effectChunk = source.slice(effectStart, effectEnd);

  assert.notEqual(effectStart, -1, signature);
  assert.match(effectChunk, /compatibilityAuthorityReadyRef\.current[\s\S]*pendingCheckpointAuthoritySnapshotRef\.current/, signature);
  assert.match(effectChunk, /terminalRef\.current/, signature);
  assert.match(effectChunk, /void handleScreenSnapshot\(deferredSnapshot\)/, signature);
});

test('TerminalContainer completion probe writes an empty frame to the same xterm FIFO', () => {
  const signature = 'REL-BGSTAB-009: lost scheduler callbacks require a direct empty xterm FIFO probe, not another scheduler barrier';
  const probeStart = source.indexOf('enqueueCompletionProbe(probe)');
  const probeEnd = source.indexOf('// @req REL-BGSTAB-008', probeStart);
  const probeChunk = source.slice(probeStart, probeEnd);

  assert.notEqual(probeStart, -1, signature);
  assert.notEqual(probeEnd, -1, signature);
  assert.match(probeChunk, /terminalRef\.current\?\.probeOutputFifo\(\)/, signature);
  assert.doesNotMatch(probeChunk, /awaitOutputIdle\(\)/, signature);
  assert.match(terminalViewSource, /probeOutputFifo:\s*\(\)\s*=>\s*probeOutputFifo\(\)\.then/, signature);
  assert.match(
    probeChunk,
    /if \(!written\) \{[\s\S]*type: 'completion-probe-timeout'[\s\S]*probeId: probe\.probeId/,
    signature,
  );
});

test('TerminalContainer rejects late authoritative snapshots after the active recovery is terminally failed', () => {
  const beforeApplyIndex = source.indexOf('const handleVisibleResyncSnapshotBeforeApply');
  const currentIndex = source.indexOf('const isCurrentActiveVisibleResyncSnapshot');
  const snapshotIndex = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  assert.notEqual(beforeApplyIndex, -1);
  assert.notEqual(currentIndex, -1);
  assert.notEqual(snapshotIndex, -1);

  const beforeApplyChunk = source.slice(beforeApplyIndex, beforeApplyIndex + 3000);
  const currentChunk = source.slice(currentIndex, currentIndex + 1800);
  const snapshotChunk = source.slice(snapshotIndex, snapshotIndex + 16_000);
  assert.match(beforeApplyChunk, /terminalFailed/);
  assert.match(beforeApplyChunk, /visible_output_resync_failed_snapshot_ignored/);
  assert.match(currentChunk, /terminalFailed/);
  assert.match(snapshotChunk, /shouldApplyAuthoritativeSnapshot/);
  assert.match(snapshotChunk, /requiresAuthoritativeMutationFence \? shouldApplyAuthoritativeSnapshot : undefined/);
  assert.match(snapshotChunk, /visible_output_resync_failed_snapshot_ignored/);

  assert.match(terminalViewSource, /replaceWithSnapshot: \([\s\S]*data: string,[\s\S]*shouldApply\?: \(\) => boolean,[\s\S]*options\?: TerminalSnapshotReplacementOptions/);
  const replacementIndex = terminalViewSource.indexOf('const applySnapshotReplacement');
  assert.notEqual(replacementIndex, -1);
  assert.match(terminalViewSource.slice(replacementIndex, replacementIndex + 1800), /shouldApply\?\.\(\) === false/);
});

test('Remount adapter RED — live/restore non-overlap', () => {
  const signature = 'expected restore and live xterm writers never to overlap';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const coordinatorAdapter = createRecordingRecoveryAdapter();
  const snapshots: Array<{ onWritten: () => void }> = [];
  const chronology: string[] = [];
  let activeWrites = 1;
  let maximumActiveWrites = activeWrites;
  const originalScheduled = coordinatorAdapter.enqueueScheduledOutput;
  coordinatorAdapter.enqueueScheduledOutput = (write) => {
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    chronology.push(`tail:${write.chunk.chunkId}`);
    originalScheduled({
      ...write,
      onWritten: () => {
        activeWrites -= 1;
        write.onWritten();
      },
    });
  };
  Object.assign(coordinatorAdapter, {
    enqueueAuthoritativeSnapshot: (write: { onWritten: () => void }) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      chronology.push('snapshot');
      snapshots.push({
        onWritten: () => {
          activeWrites -= 1;
          write.onWritten();
        },
      });
    },
  });
  const coordinator = factory({ maxHeldBytes: 16, maxHeldChunks: 2, transportMode: 'unified', adapter: coordinatorAdapter });
  const scope: RecoveryScope = { clientId: 'container-lanes', sessionId: 'session-a' };
  const { production, commands } = invokeTerminalContainerRestoreAdapter(coordinator, scope, signature);
  production.begin({ liveSchedulerIdle: false });
  production.handle({
    type: 'output-arrived', chunk: { chunkId: 'tail', screenSeq: 2, data: 'tail' },
  });
  production.handle({
    type: 'authoritative-snapshot-received', snapshotSeq: 1,
    parserBoundary: 'complete', data: 'snapshot',
  });
  const beforeLiveIdle = { snapshots: snapshots.length, tails: coordinatorAdapter.scheduled.length };
  activeWrites -= 1;
  production.handle({ type: 'live-lane-idle' });
  const afterLiveIdle = { snapshots: snapshots.length, tails: coordinatorAdapter.scheduled.length };
  snapshots[0]?.onWritten();
  const afterSnapshot = { snapshots: snapshots.length, tails: coordinatorAdapter.scheduled.length };
  coordinatorAdapter.scheduled[0]?.onWritten();

  assert.deepEqual({
    beforeLiveIdle,
    afterLiveIdle,
    afterSnapshot,
    chronology,
    maximumActiveWrites,
    activeWrites,
    commandTypes: commands.map(command => command.type),
    commandsCarryBoundIdentity: commands.every(command => (
      command.clientId === scope.clientId
      && command.sessionId === scope.sessionId
      && command.connectionGeneration === 7
      && command.sessionGeneration === 11
    )),
  }, {
    beforeLiveIdle: { snapshots: 0, tails: 0 },
    afterLiveIdle: { snapshots: 1, tails: 0 },
    afterSnapshot: { snapshots: 1, tails: 1 },
    chronology: ['snapshot', 'tail:tail'],
    maximumActiveWrites: 1,
    activeWrites: 0,
    commandTypes: [
      'begin-resync',
      'output-arrived',
      'authoritative-snapshot-received',
      'live-lane-idle',
    ],
    commandsCarryBoundIdentity: true,
  }, signature);
});

test('Remount adapter RED — fault input barrier', () => {
  const signature = 'expected IME geometry buffer writer timeout and ACK faults to block input';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const faults = [
    { type: 'ime-cancelled', reason: 'ime-active' },
    { type: 'recovery-failed', reason: 'geometry-mismatch' },
    { type: 'recovery-failed', reason: 'buffer-mismatch' },
    { type: 'write-callback-timeout', reason: 'write-callback-timeout' },
    { type: 'repair-ack-failed', reason: 'server-ack-failed' },
  ] as const;
  const observed = faults.map((fault, index) => {
    const coordinatorAdapter = createRecordingRecoveryAdapter();
    const probes: Array<{ data: string }> = [];
    const releasedInput: string[] = [];
    Object.assign(coordinatorAdapter, {
      enqueueCompletionProbe: (probe: { data: string }) => probes.push(probe),
      releaseQueuedInput: (input: { data: string }) => releasedInput.push(input.data),
    });
    const coordinator = factory({ maxHeldBytes: 16, maxHeldChunks: 2, transportMode: 'unified', adapter: coordinatorAdapter });
    const scope: RecoveryScope = { clientId: `fault-${index}`, sessionId: 'session-a' };
    const { production, commands } = invokeTerminalContainerRestoreAdapter(coordinator, scope, signature);
    production.begin();
    production.handle({ type: 'queued-user-input', data: 'blocked-input' });
    if (fault.type === 'write-callback-timeout') {
      production.handle({
        type: 'output-arrived',
        chunk: { chunkId: 'pending-write', screenSeq: 2, data: 'pending' },
      });
      production.handle({
        type: 'authoritative-snapshot-applied', snapshotSeq: 1, parserBoundary: 'complete',
      });
    }
    const result = production.handle({
      type: fault.type, reason: fault.reason,
      pendingChunkId: fault.type === 'write-callback-timeout' ? 'pending-write' : undefined,
    });
    const state = production.getState() as Record<string, unknown>;
    return {
      type: fault.type,
      ignored: result.ignored,
      ready: state.currentViewTransactionReady,
      queuedInputCount: state.queuedInputCount,
      releasedInput,
      directWrites: coordinatorAdapter.directWrites.length,
      probePayloads: probes.map(probe => probe.data),
      lastCommandType: commands.at(-1)?.type,
    };
  });

  assert.deepEqual(observed,
    faults.map(fault => ({
      type: fault.type,
      ignored: false,
      ready: false,
      queuedInputCount: 1,
      releasedInput: [],
      directWrites: 0,
      probePayloads: fault.type === 'write-callback-timeout' ? [''] : [],
      lastCommandType: fault.type,
    })), signature);
});

test('Remount adapter RED — parser and Unicode corpus', () => {
  const signature = 'expected incomplete ANSI and ASCII CJK emoji corpus to remain non-ready or exact';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const coordinatorAdapter = createRecordingRecoveryAdapter();
  const outboundInput: string[] = [];
  Object.assign(coordinatorAdapter, { sendInput: (input: { data: string }) => outboundInput.push(input.data) });
  const corpus = ['ASCII', '한글', '😀'];
  const maxHeldBytes = new TextEncoder().encode(corpus.join('')).byteLength;
  const coordinator = factory({ maxHeldBytes, maxHeldChunks: corpus.length, transportMode: 'unified', adapter: coordinatorAdapter });
  const scope: RecoveryScope = { clientId: 'parser-unicode', sessionId: 'session-a' };
  const { production, commands } = invokeTerminalContainerRestoreAdapter(coordinator, scope, signature);
  production.begin();
  corpus.forEach((data, index) => production.handle({
    type: 'output-arrived', chunk: { chunkId: `unicode-${index}`, screenSeq: index + 2, data },
  }));
  const stateBeforeIncomplete = production.getState() as Record<string, unknown>;
  const heldBeforeIncomplete = {
    bytes: stateBeforeIncomplete.heldOutputBytes,
    data: (stateBeforeIncomplete.heldChunks as Array<{ data: string }>).map(chunk => chunk.data),
  };
  const autoReply = production.handle({ type: 'xterm-auto-reply', data: '\x1b[0n' });
  production.handle({
    type: 'authoritative-snapshot-applied', snapshotSeq: 4,
    parserBoundary: 'incomplete', parserComplete: false, pendingEscapeTailAnsi: '\x1b[',
  });
  const afterIncomplete = production.getState() as Record<string, unknown>;

  assert.deepEqual({
    heldBytes: heldBeforeIncomplete.bytes,
    heldData: heldBeforeIncomplete.data,
    autoReplyIgnored: autoReply.ignored,
    outboundInput,
    ready: afterIncomplete.currentViewTransactionReady,
    stale: afterIncomplete.staleTerminal,
    parserComplete: afterIncomplete.parserComplete,
    pendingEscapeTailAnsi: afterIncomplete.pendingEscapeTailAnsi,
    commandTypes: commands.map(command => command.type),
  }, {
    heldBytes: maxHeldBytes,
    heldData: corpus,
    autoReplyIgnored: false,
    outboundInput: [],
    ready: false,
    stale: true,
    parserComplete: false,
    pendingEscapeTailAnsi: '\x1b[',
    commandTypes: [
      'begin-resync',
      'output-arrived',
      'output-arrived',
      'output-arrived',
      'xterm-auto-reply',
      'authoritative-snapshot-applied',
    ],
  }, signature);
});

test('Frontend stale/resync barrier RED 계약 — AC-3', () => {
  const signature = RED_SIGNATURES.ac3;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: new TextEncoder().encode('한글').byteLength,
    maxHeldChunks: 2,
    transportMode: 'unified',
    adapter,
  });
  const affected: RecoveryScope = { clientId: 'client-a', sessionId: 'session-a' };
  beginRecovery(coordinator, affected);
  coordinator.dispatch({
    type: 'output-arrived',
    ...affected,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'at-byte-cap', screenSeq: 1, data: '한글' },
  });
  coordinator.dispatch({
    type: 'output-arrived',
    ...affected,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'overflow', screenSeq: 2, data: 'x' },
  });

  const state = coordinator.getState(affected);
  assert.equal(state?.staleTerminal, true, signature);
  assert.equal(state?.currentViewTransactionReady, false, signature);
  assert.equal(state?.heldChunks.length, 0, signature);
  assert.equal(adapter.aborted.length, 1, signature);
  assert.equal(adapter.aborted[0]?.repairToken, 'repair-current', signature);
  assert.deepEqual(adapter.freshSnapshots.map(({ reason }) => reason), ['byte-cap-exceeded'], signature);
  assert.equal(
    adapter.outcomes.some(({ outcome, reason }) => (
      outcome === 'fresh-snapshot-started' && reason === 'byte-cap-exceeded'
    )),
    true,
    signature,
  );
  assert.equal(adapter.scheduled.length, 0, signature);
  assert.equal(adapter.directWrites.length, 0, signature);
});

test('Frontend stale/resync barrier RED 계약 — AC-6', () => {
  const signature = RED_SIGNATURES.ac6;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 128,
    maxHeldChunks: 8,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'client-a', sessionId: 'session-a' };
  beginRecovery(coordinator, scope);
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'held-current', screenSeq: 9, data: 'held' },
  });
  const before = coordinator.getState(scope);

  const staleSignals = [
    {
      type: 'authoritative-snapshot-applied',
      transactionId: 'tx-old',
      repairToken: 'repair-current',
      replayToken: 'replay-current',
      snapshotSeq: 8,
      parserBoundary: 'complete',
      connectionGeneration: 7,
      sessionGeneration: 11,
    },
    {
      type: 'authoritative-snapshot-applied',
      transactionId: 'tx-current',
      repairToken: 'repair-current',
      replayToken: 'replay-current',
      snapshotSeq: 8,
      parserBoundary: 'complete',
      connectionGeneration: 6,
      sessionGeneration: 11,
    },
    {
      type: 'authoritative-snapshot-applied',
      transactionId: 'tx-current',
      repairToken: 'repair-stale',
      replayToken: 'replay-current',
      snapshotSeq: 8,
      parserBoundary: 'complete',
      connectionGeneration: 7,
      sessionGeneration: 11,
    },
    {
      type: 'authoritative-snapshot-applied',
      transactionId: 'tx-current',
      repairToken: 'repair-current',
      replayToken: 'replay-stale',
      snapshotSeq: 8,
      parserBoundary: 'complete',
      connectionGeneration: 7,
      sessionGeneration: 11,
    },
    {
      type: 'authoritative-snapshot-applied',
      transactionId: 'tx-current',
      repairToken: 'repair-current',
      replayToken: 'replay-current',
      snapshotSeq: 8,
      parserBoundary: 'complete',
      connectionGeneration: 7,
      sessionGeneration: 10,
    },
  ];

  for (const event of staleSignals) {
    const result = coordinator.dispatch({ ...event, ...scope });
    assert.equal(result.ignored, true, signature);
    assert.strictEqual(result.state, before, signature);
    assert.equal(adapter.scheduled.length, 0, signature);
    assert.equal(adapter.readyChanges.some(({ ready }) => ready), false, signature);
  }

  const acceptedEvent = {
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 8,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  };
  const accepted = coordinator.dispatch(acceptedEvent);
  assert.equal(accepted.ignored, false, signature);
  assert.equal(adapter.scheduled.length, 1, signature);
  const afterAccepted = coordinator.getState(scope);
  const duplicate = coordinator.dispatch(acceptedEvent);
  assert.equal(duplicate.ignored, true, signature);
  assert.strictEqual(duplicate.state, afterAccepted, signature);
  assert.equal(adapter.scheduled.length, 1, signature);
  assert.equal(adapter.readyChanges.some(({ ready }) => ready), false, signature);

  coordinator.dispatch({
    type: 'dispose',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const disposed = coordinator.getState(scope);
  const late = coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 8,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(late.ignored, true, signature);
  assert.strictEqual(late.state, disposed, signature);
  assert.equal(adapter.scheduled.length, 1, signature);
  assert.equal(adapter.readyChanges.some(({ ready }) => ready), false, signature);
});

test('Frontend stale/resync barrier RED 계약 — AC-11', () => {
  const signature = RED_SIGNATURES.ac11;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const byteCap = new TextEncoder().encode('한글').byteLength;
  const byteCases = [
    { label: 'N-1', data: 'a'.repeat(byteCap - 1), overflow: false },
    { label: 'N', data: '한글', overflow: false },
    { label: 'N+1', data: '한글x', overflow: true },
  ];

  for (const boundary of byteCases) {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: byteCap,
      maxHeldChunks: 8,
      transportMode: 'unified',
      adapter,
    });
    const scope: RecoveryScope = { clientId: `byte-${boundary.label}`, sessionId: 'session-byte' };
    beginRecovery(coordinator, scope);
    coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      chunk: { chunkId: `byte-${boundary.label}`, screenSeq: 1, data: boundary.data },
    });
    const state = coordinator.getState(scope);
    assert.equal(state?.staleTerminal, boundary.overflow, signature);
    assert.equal(state?.retainedHistoryEquivalent, false, signature);
    if (boundary.overflow) {
      assert.deepEqual(adapter.freshSnapshots.map(({ reason }) => reason), ['byte-cap-exceeded'], signature);
    } else {
      assert.equal(state?.heldOutputBytes, new TextEncoder().encode(boundary.data).byteLength, signature);
      assert.equal(adapter.freshSnapshots.length, 0, signature);
    }
  }

  for (const chunkCount of [1, 2, 3]) {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: 64,
      maxHeldChunks: 2,
      transportMode: 'unified',
      adapter,
    });
    const scope: RecoveryScope = { clientId: `chunks-${chunkCount}`, sessionId: 'session-chunks' };
    beginRecovery(coordinator, scope);
    for (let index = 0; index < chunkCount; index += 1) {
      coordinator.dispatch({
        type: 'output-arrived',
        ...scope,
        transactionId: 'tx-current',
        connectionGeneration: 7,
        sessionGeneration: 11,
        chunk: { chunkId: `chunk-${index}`, screenSeq: index + 1, data: 'x' },
      });
    }
    const state = coordinator.getState(scope);
    assert.equal(state?.staleTerminal, chunkCount === 3, signature);
    if (chunkCount === 3) {
      assert.deepEqual(adapter.freshSnapshots.map(({ reason }) => reason), ['chunk-cap-exceeded'], signature);
    } else {
      assert.equal(state?.heldChunks.length, chunkCount, signature);
    }
  }

  const faultAdapter = createRecordingRecoveryAdapter();
  const faultCoordinator = factory({
    maxHeldBytes: 8,
    maxHeldChunks: 4,
    transportMode: 'unified',
    adapter: faultAdapter,
  });
  const clientA: RecoveryScope = { clientId: 'client-a', sessionId: 'shared-session' };
  const clientB: RecoveryScope = { clientId: 'client-b', sessionId: 'shared-session' };
  beginRecovery(faultCoordinator, clientA);
  beginRecovery(faultCoordinator, clientB);
  faultCoordinator.dispatch({
    type: 'output-arrived',
    ...clientB,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'client-b-tail', screenSeq: 1, data: 'B' },
  });
  faultCoordinator.dispatch({
    type: 'output-arrived',
    ...clientA,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'client-a-overflow', screenSeq: 1, data: '123456789' },
  });
  faultCoordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...clientB,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 0,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(faultCoordinator.getState(clientA)?.staleTerminal, true, signature);
  assert.equal(faultCoordinator.getState(clientB)?.staleTerminal, false, signature);
  assert.deepEqual(
    faultAdapter.scheduled.map(({ clientId, chunk }) => [clientId, chunk.chunkId]),
    [['client-b', 'client-b-tail']],
    signature,
  );
  faultAdapter.scheduled[0]?.onWritten();
  assert.equal(faultCoordinator.getState(clientB)?.currentViewTransactionReady, true, signature);
  assert.equal(faultCoordinator.getState(clientA)?.currentViewTransactionReady, false, signature);

  const incompleteScope: RecoveryScope = { clientId: 'client-incomplete', sessionId: 'session-ansi' };
  beginRecovery(faultCoordinator, incompleteScope);
  faultCoordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...incompleteScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 4,
    parserBoundary: 'incomplete',
    parserTail: '\x1b[31',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(faultCoordinator.getState(incompleteScope)?.currentViewTransactionReady, false, signature);
  assert.equal(
    faultAdapter.outcomes.some(({ clientId, outcome }) => (
      clientId === 'client-incomplete' && outcome === 'reconnect-required'
    )),
    true,
    signature,
  );

  const closedScope: RecoveryScope = { clientId: 'client-closed', sessionId: 'session-close' };
  beginRecovery(faultCoordinator, closedScope);
  faultCoordinator.dispatch({
    type: 'connection-closed',
    ...closedScope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const closed = faultCoordinator.getState(closedScope);
  const late = faultCoordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...closedScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 1,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(late.ignored, true, signature);
  assert.strictEqual(late.state, closed, signature);
  assert.equal(faultAdapter.splitActivations.length, 0, signature);
  assert.equal(faultAdapter.directWrites.length, 0, signature);

  for (const transportMode of ['split-shadow', 'split'] as const) {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: 64,
      maxHeldChunks: 4,
      transportMode,
      adapter,
    });
    assert.deepEqual(coordinator.getTransportStatus(), {
      requestedTransportMode: transportMode,
      effectiveTransportMode: 'unified',
      splitActivationEnabled: false,
      standaloneSplitParity: 'unresolved',
    }, signature);
    const scope: RecoveryScope = {
      clientId: `limitation-${transportMode}`,
      sessionId: 'session-limitation',
    };
    const started = beginRecovery(coordinator, scope);
    const fault = coordinator.dispatch({
      type: 'recovery-failed',
      ...scope,
      transactionId: 'tx-current',
      repairToken: 'repair-current',
      replayToken: 'replay-current',
      reason: 'repair-reoverflow',
      connectionGeneration: 7,
      sessionGeneration: 11,
    });
    assert.equal(started.ignored, true, signature);
    assert.equal(fault.ignored, true, signature);
    assert.equal(coordinator.getState(scope), undefined, signature);
    assert.deepEqual(adapter.outcomes, [{
      ...scope,
      outcome: 'standalone-split-unavailable',
      reason: 'split-activation-disabled',
    }], signature);
    assert.equal(adapter.scheduled.length, 0, signature);
    assert.equal(adapter.readyChanges.length, 0, signature);
    assert.equal(adapter.splitActivations.length, 0, signature);
    assert.equal(adapter.directWrites.length, 0, signature);
  }
});

test('REL-BGSTAB-012 preserves client isolation AI idle and renderer residency', () => {
  const signature = 'REL-BGSTAB-012 AC-7/AC-8/AC-9: hidden dataGap must stale only the affected view without direct writes, split activation, or semantic session-status mutation';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 64,
    maxHeldChunks: 4,
    transportMode: 'unified',
    adapter,
  });
  const affected: RecoveryScope = { clientId: 'hidden-client-a', sessionId: 'shared-hidden-session' };
  const unaffected: RecoveryScope = { clientId: 'visible-client-b', sessionId: 'shared-hidden-session' };
  beginRecovery(coordinator, affected);
  beginRecovery(coordinator, unaffected);
  const unaffectedBefore = coordinator.getState(unaffected);

  const result = coordinator.dispatch({
    type: 'hidden-data-gap',
    ...affected,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    visibilityGeneration: '3',
    lastDeliveredSeq: '41',
  });

  assert.equal(result.ignored, false, signature);
  assert.equal(coordinator.getState(affected)?.staleTerminal, true, signature);
  assert.equal(coordinator.getState(affected)?.currentViewTransactionReady, false, signature);
  assert.strictEqual(coordinator.getState(unaffected), unaffectedBefore, signature);
  assert.equal(adapter.directWrites.length, 0, signature);
  assert.equal(adapter.splitActivations.length, 0, signature);
});

test('REL-BGSTAB-012 isolates affected hidden recovery to its browser view', () => {
  const signature = 'REL-BGSTAB-012 AC-7: a hidden recovery transaction must invalidate only its owning browser view';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 64,
    maxHeldChunks: 4,
    transportMode: 'unified',
    adapter,
  });
  const affected: RecoveryScope = { clientId: 'rel012-hidden-client-a', sessionId: 'rel012-shared-session' };
  const peer: RecoveryScope = { clientId: 'rel012-visible-client-b', sessionId: 'rel012-shared-session' };
  beginRecovery(coordinator, affected);
  beginRecovery(coordinator, peer);
  const peerBefore = coordinator.getState(peer);

  const result = coordinator.dispatch({
    type: 'hidden-data-gap',
    ...affected,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    visibilityGeneration: '3',
    lastDeliveredSeq: '41',
  });

  assert.equal(result.ignored, false, signature);
  assert.equal(coordinator.getState(affected)?.staleTerminal, true, signature);
  assert.strictEqual(coordinator.getState(peer), peerBefore, signature);
  assert.equal(adapter.directWrites.length, 0, signature);
  assert.equal(
    (coordinator.getState(affected) as unknown as { recoveryScope?: unknown } | undefined)?.recoveryScope,
    'browser-view-only',
    signature,
  );
});
