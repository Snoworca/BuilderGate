import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as visibleOutputRecoveryModule from '../../src/utils/visibleOutputRecovery.ts';
import {
  createRecordingRecoveryAdapter,
  requireRecoveryCoordinatorFactory,
  type RecoveryCoordinatorEvent,
  type RecoveryCoordinatorResult,
  type RecoveryScope,
  type VisibleOutputRecoveryCoordinator,
} from '../helpers/visibleOutputRecoveryContract.ts';

const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
const terminalContainerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
  'utf8',
);

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

function invokeTerminalViewRestoreAdapter(
  coordinator: VisibleOutputRecoveryCoordinator,
  scope: RecoveryScope,
  signature: string,
  identity: RestoreIdentity = CURRENT_IDENTITY,
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
      .createTerminalViewRestoreAdapter as ProductionRestoreAdapterFactory;
    const production = factory({ coordinator: coordinatorPort, scope, identity });
    assert.equal(typeof production.begin, 'function');
    assert.equal(typeof production.handle, 'function');
    assert.equal(typeof production.handleFrom, 'function');
    assert.equal(typeof production.remount, 'function');
    assert.equal(typeof production.getState, 'function');
    assert.equal(typeof production.getTransportStatus, 'function');
    return { production, commands };
  } catch (error) {
    assert.fail(`${signature}; production TerminalView adapter invocation failed: ${String(error)}`);
  }
}

test('TerminalView allows screen repair readiness while visible output recovery barrier is active', () => {
  const readinessIndex = source.indexOf('const getScreenRepairReadiness = useCallback');
  assert.notEqual(readinessIndex, -1);
  const readinessChunk = source.slice(readinessIndex, readinessIndex + 1300);

  assert.match(readinessChunk, /transportBarrierReasonRef\.current !== 'visible-output-recovery'/);
  assert.match(readinessChunk, /reason: 'input-active'/);
});

test('TerminalView uses runtime terminal limits for input queue budget and TTL', () => {
  assert.match(source, /getInputQueueLimits/);
  assert.doesNotMatch(source, /INPUT_QUEUE_BYTE_BUDGET/);
  assert.doesNotMatch(source, /INPUT_QUEUE_TTL_MS/);

  const expireIndex = source.indexOf('const expirePendingInputQueue = useCallback');
  assert.notEqual(expireIndex, -1);
  const expireChunk = source.slice(expireIndex, expireIndex + 850);
  assert.match(expireChunk, /inputQueueTtlMs/);
  assert.match(expireChunk, /now - entry\.queuedAt > inputQueueTtlMs/);

  const enqueueIndex = source.indexOf('const enqueuePendingInput = useCallback');
  assert.notEqual(enqueueIndex, -1);
  const enqueueChunk = source.slice(enqueueIndex, enqueueIndex + 2200);
  assert.match(enqueueChunk, /inputQueueMaxBytes/);
  assert.match(enqueueChunk, /queuedByteBudget: inputQueueMaxBytes/);
});

test('TerminalView uses runtime-configured input queue limits', () => {
  assert.doesNotMatch(source, /const INPUT_QUEUE_BYTE_BUDGET/);
  assert.doesNotMatch(source, /const INPUT_QUEUE_TTL_MS/);
  assert.match(source, /getInputQueueLimits/);
});

test('TerminalView visible output scheduler uses cached runtime output limits', () => {
  assert.match(source, /getCachedTerminalOutputResourceLimits/);

  const schedulerIndex = source.indexOf('const getOutputScheduler = useCallback');
  assert.notEqual(schedulerIndex, -1);
  const schedulerChunk = source.slice(schedulerIndex, schedulerIndex + 1400);
  assert.match(schedulerChunk, /getCachedTerminalOutputResourceLimits\(\)/);
  assert.doesNotMatch(schedulerChunk, /getTerminalResourceLimits\(\)/);
});

test('TerminalView plain Space and Backspace delegation does not rebuild input debug payload', () => {
  const delegationIndex = source.indexOf("recordTerminalDebugEvent(sessionId, 'key_delegated_to_xterm'");
  assert.notEqual(delegationIndex, -1);
  const delegationChunk = source.slice(Math.max(0, delegationIndex - 550), delegationIndex + 550);
  assert.match(delegationChunk, /delegatedToXterm: true/);
  assert.doesNotMatch(delegationChunk, /buildTerminalInputDebugPayload/);
});

test('TerminalView compatibility recovery delegates to the full recovery owner without manual repair', () => {
  const signature = 'FR-BGSTAB-022: compatibility rollback must not race a viewport-only manual repair';
  const recoveryStart = source.indexOf('const requestCheckpointRecovery = (reason: string): void => {');
  assert.notEqual(recoveryStart, -1, signature);
  const recoveryChunk = source.slice(recoveryStart, recoveryStart + 750);

  assert.match(recoveryChunk, /onVisibleOutputOverflow\?\.\(\{/, signature);
  assert.match(recoveryChunk, /reason: `terminal-authority-recovery:\$\{reason\}`/, signature);
  assert.doesNotMatch(recoveryChunk, /onManualRepair/, signature);
});

test('TerminalView runtime recreation also requests bounded fresh snapshot recovery', () => {
  const signature = 'FR-BGSTAB-022: timed-out xterm remounted without requesting authoritative recovery';
  const callbackStart = source.indexOf('requestRuntimeRecreation: (reason) => {');
  assert.notEqual(callbackStart, -1, signature);
  const callbackChunk = source.slice(callbackStart, callbackStart + 650);
  const deferIndex = callbackChunk.indexOf('runtimeRecreationRecoveryReasonRef.current = {');
  const remountIndex = callbackChunk.indexOf('setTerminalRuntimeRevision');

  assert.ok(deferIndex >= 0 && remountIndex > deferIndex, signature);
  assert.match(callbackChunk, /sessionId,/u, signature);
  assert.match(callbackChunk, /reason,/u, signature);
  assert.match(callbackChunk, /recoveryRequested: false/u, signature);
  assert.doesNotMatch(callbackChunk, /requestCheckpointRecovery\(reason\)/, signature);
  assert.match(callbackChunk, /syncInputReadiness\('terminal-runtime-recreation-required'\)/, signature);

  const registrationStart = source.indexOf('const unregisterCheckpointDispatcher = registerTerminalCheckpointDispatcher');
  assert.notEqual(registrationStart, -1, signature);
  const registrationChunk = source.slice(registrationStart, registrationStart + 1500);
  assert.match(registrationChunk, /runtimeRecreationRecoveryReasonRef\.current/, signature);
  assert.match(registrationChunk, /checkpointRuntime\.rollbackToLegacy\(/, signature);
  assert.match(registrationChunk, /pendingRuntimeRecreationRecovery/, signature);
  const rollbackIndex = registrationChunk.indexOf('checkpointRuntime.rollbackToLegacy(');
  const rollbackReasonIndex = registrationChunk.indexOf(
    'pendingRuntimeRecreationRecovery.reason',
    rollbackIndex,
  );
  assert.ok(
    registrationChunk.indexOf('registerTerminalCheckpointDispatcher')
      < rollbackIndex
      && rollbackReasonIndex > rollbackIndex,
    signature,
  );
});

test('TerminalView hands legacy recovery across bounded reconnect runtime replacement', () => {
  const signature = 'FR-BGSTAB-022: bounded reconnect runtime replacement lost compatibility recovery authority';
  assert.match(source, /runtimeRecreationRecoveryReasonRef = useRef<\{/u, signature);
  assert.match(source, /sessionId: string/u, signature);
  assert.match(source, /recoveryRequested: boolean/u, signature);

  const registrationStart = source.indexOf('const pendingRuntimeRecreationRecovery');
  assert.notEqual(registrationStart, -1, signature);
  const registrationChunk = source.slice(registrationStart, registrationStart + 1800);
  assert.match(registrationChunk, /\.sessionId === sessionId/u, signature);
  assert.match(registrationChunk, /requestFreshRecovery: !.*recoveryRequested/u, signature);

  const disposalStart = source.indexOf(
    "terminalRestoreAdapterRef.current?.handle({ type: 'dispose' })",
    registrationStart,
  );
  const cleanupStart = source.indexOf(
    'if (checkpointRuntime.getState().legacyRecoveryPending)',
    disposalStart,
  );
  assert.notEqual(cleanupStart, -1, signature);
  const cleanupChunk = source.slice(cleanupStart, cleanupStart + 1300);
  assert.match(cleanupChunk, /checkpointRuntime\.getState\(\)\.legacyRecoveryPending/u, signature);
  assert.match(cleanupChunk, /recoveryRequested: true/u, signature);
  assert.ok(
    cleanupChunk.indexOf('legacyRecoveryPending')
      < cleanupChunk.indexOf('checkpointRuntime.dispose()'),
    signature,
  );
});

test('TerminalView emits legacy authority readiness once after compatibility recovery fully converges', () => {
  const signature = 'FR-BGSTAB-022: compatibility recovery must not reopen input through an implicit transport timer';
  assert.match(source, /legacyAuthorityReadySyncPendingRef/u, signature);

  const syncStart = source.indexOf('const syncInputReadiness = useCallback');
  assert.notEqual(syncStart, -1, signature);
  const syncChunk = source.slice(syncStart, syncStart + 4200);
  assert.match(syncChunk, /legacyAuthorityReadySyncPendingRef\.current/u, signature);
  assert.match(syncChunk, /gate\.transportReady/u, signature);
  assert.match(syncChunk, /!restorePendingRef\.current/u, signature);
  assert.match(syncChunk, /'terminal-authority-legacy'/u, signature);
  assert.match(syncChunk, /legacyAuthorityReadySyncPendingRef\.current = false/u, signature);

  const authorityStart = source.indexOf('onAuthorityStateChange: (state) => {');
  assert.notEqual(authorityStart, -1, signature);
  const authorityChunk = source.slice(authorityStart, authorityStart + 900);
  assert.match(authorityChunk, /state === 'legacy'/u, signature);
  assert.match(authorityChunk, /legacyAuthorityReadySyncPendingRef\.current = true/u, signature);
  assert.match(
    authorityChunk,
    /'terminal-authority-legacy-convergence-pending'/u,
    signature,
  );
});

test('TerminalView compatibility tail write reports coordinator rejection as physical failure', () => {
  const signature = 'FR-BGSTAB-022 AC-5: coordinator rejection was reported as a physical xterm drain';
  assert.match(source, /writeRecoveryTailAndWait/u, signature);
  const writeStart = source.indexOf('const writeRecoveryTailAndWait = useCallback');
  assert.notEqual(writeStart, -1, signature);
  const writeChunk = source.slice(writeStart, writeStart + 2200);
  assert.match(writeChunk, /awaitOutputIdleWithFifoProbe/u, signature);
  assert.match(writeChunk, /coordinator\.submitCompatibility\(\{/u, signature);
  assert.match(writeChunk, /kind: 'repair'/u, signature);
  assert.match(writeChunk, /onWritten: \(\) => settle\(true\)/u, signature);
  assert.match(writeChunk, /onRejected: \(\) => settle\(false\)/u, signature);
  assert.doesNotMatch(writeChunk, /writeOutput\(/u, signature);

  const containerOutputStart = source.indexOf('writeRecoveryTailAndWait');
  assert.notEqual(containerOutputStart, -1, signature);
});

test('TerminalView bounds restore-pending output and drains segmented chunks without join', () => {
  const bufferIndex = source.indexOf('const bufferOutputWhileRestorePending = useCallback');
  const bufferChunk = source.slice(bufferIndex, bufferIndex + 2200);
  const flushIndex = source.indexOf('const flushBufferedOutput = useCallback');
  const flushChunk = source.slice(flushIndex, flushIndex + 2400);

  assert.notEqual(bufferIndex, -1);
  assert.match(bufferChunk, /visibleOutputQueueMaxBytes/);
  assert.match(bufferChunk, /visibleOutputMaxChunks/);
  assert.match(bufferChunk, /bufferedOutputBytesRef\.current/);
  assert.match(bufferChunk, /onWritten: metadata\?\.onWritten/);
  assert.match(bufferChunk, /onVisibleOutputOverflow\?\./);
  assert.doesNotMatch(flushChunk, /\.join\(/);
  assert.match(flushChunk, /const pending = bufferedOutputRef\.current\[0\]/);
  assert.match(flushChunk, /bufferedOutputRef\.current\.shift\(\)/);
  assert.match(flushChunk, /flushNextTerminalRestoreBufferedOutput\(\{/);
  assert.match(flushChunk, /write: \(data, onWritten, onRejected\) => writeOutput\(/);
  assert.match(flushChunk, /pending\.onWritten\?\.\(\)/);
});

test('TerminalView propagates restore-buffer failure as FAILED_HELD without allowing live-output overtake', () => {
  const signature = 'REL-BGSTAB-010: failed restore-buffer admission must be an explicit non-ACKable restore result';
  const flushIndex = source.indexOf('const flushBufferedOutput = useCallback');
  const releaseIndex = source.indexOf('const releaseRestorePending = useCallback', flushIndex);
  const applyIndex = source.indexOf('const applySnapshotReplacement = useCallback', releaseIndex);
  const replaceIndex = source.indexOf('const replaceWithSnapshot = useCallback', applyIndex);
  const flushChunk = source.slice(flushIndex, releaseIndex);
  const releaseChunk = source.slice(releaseIndex, applyIndex);
  const applyChunk = source.slice(applyIndex, replaceIndex);

  assert.notEqual(flushIndex, -1, signature);
  assert.notEqual(releaseIndex, -1, signature);
  assert.notEqual(applyIndex, -1, signature);
  assert.match(flushChunk, /flushNextTerminalRestoreBufferedOutput\(\{/u, signature);
  assert.match(flushChunk, /onSettled\?\.\(false\)/u, signature);
  assert.match(flushChunk, /onVisibleOutputOverflow\?\.\(\{/u, signature);
  assert.doesNotMatch(flushChunk, /clearBufferedOutput\(/u, signature);
  assert.match(releaseChunk, /restoreReleaseSingleFlightRef\.current\.run\(attempt\.attemptEpoch/u, signature);
  const overflowFailFast = releaseChunk.indexOf('if (bufferedOutputOverflowedRef.current)');
  const singleFlightStart = releaseChunk.indexOf('restoreReleaseSingleFlightRef.current.run');
  assert.ok(overflowFailFast >= 0 && singleFlightStart > overflowFailFast,
    'manual FAILED_HELD release must fail before starting or mutating a release flight');
  assert.match(
    releaseChunk,
    /FAILED_HELD[\s\S]*syncInputReadiness\('restore-output-admission-rejected'\)[\s\S]*settleRelease\(false\)/u,
    signature,
  );
  const failedBranchStart = releaseChunk.indexOf('if (');
  const failedBranchEnd = releaseChunk.indexOf('restorePendingRef.current = false', failedBranchStart);
  assert.notEqual(failedBranchStart, -1, signature);
  assert.notEqual(failedBranchEnd, -1, signature);
  assert.doesNotMatch(
    releaseChunk.slice(failedBranchStart, failedBranchEnd),
    /restorePendingRef\.current = false/u,
    signature,
  );
  assert.match(releaseChunk, /settleRelease\(true\)/u, signature);
  assert.match(applyChunk, /return releaseRestorePending\(attempt\)/u, signature);
  assert.match(
    applyChunk,
    /if \(!released\) return rejectSnapshotReplacement\('replay-write-or-restore-attempt-rejected'/u,
    signature,
  );
  assert.match(
    applyChunk,
    /if \(!released\) return rejectSnapshotReplacement\([\s\S]*lastSnapshotRef\.current = data/u,
    signature,
  );
  assert.doesNotMatch(applyChunk, /releaseRestorePending\([^)]*\)\.then\(\(\) => true\)/u, signature);
  assert.match(
    applyChunk,
    /const failedHeld = bufferedOutputOverflowedRef\.current \|\| activeCoverage !== null[\s\S]*failedHeld && !options\?\.failedHeldCoverage[\s\S]*restore_failed_held_requires_authoritative_coverage[\s\S]*return Promise\.resolve\(false\)/u,
    'FAILED_HELD cannot be retried by an unproven fallback or local snapshot',
  );
  assert.match(
    applyChunk,
    /const written = await new Promise<boolean>\(\(resolveReplay\) => \{[\s\S]*coordinator\.submitCompatibility\(\{[\s\S]*type: 'write',[\s\S]*kind: 'repair',[\s\S]*onWritten: \(\) => settleReplay\(true\),[\s\S]*onRejected: \(\) => settleReplay\(false\),[\s\S]*if \(!written \|\| !isCurrentRestoreAttempt\(attempt\)\)[\s\S]*replay-write-or-restore-attempt-rejected[\s\S]*if \(shouldApply\?\.\(\) === false\)[\s\S]*if \(!stageFailedHeldCoverage\(attempt, coverageProvenance, options\.failedHeldCoverage\)\)[\s\S]*return false[\s\S]*releaseRestorePending\(attempt\)/u,
    'FAILED_HELD ownership may change only after the sole-writer callback and current-attempt validation succeed',
  );
  assert.doesNotMatch(applyChunk, /clearBufferedOutput\(\)/u,
    'authoritative retry must use transactional coverage instead of pre-replay destructive clearing');

  const writeStart = source.indexOf(
    'submitOutput: (data: TerminalOutputWriteData, metadata?: TerminalOutputWriteMetadata) => {',
  );
  // Without this the stale-anchor case slices from -1, matches against '', and
  // reports a confusing empty-actual failure instead of naming the real cause.
  assert.notEqual(writeStart, -1, `${signature} (submitOutput anchor is stale)`);
  const writeEnd = source.indexOf('writeAndWait:', writeStart);
  const writeChunk = source.slice(writeStart, writeEnd);
  assert.match(writeChunk, /if \(!term \|\| restorePendingRef\.current\) \{[\s\S]*bufferOutputWhileRestorePending\(data, metadata\)[\s\S]*return;/u, signature);
  assert.match(flushChunk, /restoreAttemptEpochRef\.current === attemptEpoch/u, signature);
  assert.match(flushChunk, /bufferedOutputRef\.current\[0\] === expected/u, signature);
});

test('TerminalView refuses FAILED_HELD convergence when coverage identity is unproven', () => {
  const signature = 'REL-BGSTAB-010: tokenless live seq covered by snapshot data must not be replayed or ACKed';
  const stageIndex = source.indexOf('const stageFailedHeldCoverage = useCallback');
  const releaseIndex = source.indexOf('const releaseRestorePending = useCallback', stageIndex);
  const stageChunk = source.slice(stageIndex, releaseIndex);
  const unprovenIndex = stageChunk.indexOf('transaction.unproven.length > 0');
  const mutationIndex = stageChunk.indexOf('restoreCoverageTransactionRef.current =');

  assert.ok(unprovenIndex >= 0 && mutationIndex > unprovenIndex, signature);
  assert.match(stageChunk, /coversThroughSeq: coverage\.coversThroughSeq/u, signature);
  assert.match(stageChunk, /supersedesReplayToken: coverage\.supersedesReplayToken/u, signature);
  assert.match(stageChunk, /authorityEpoch: coverage\.authorityEpoch/u, signature);
  assert.match(stageChunk, /authorityRevision: coverage\.authorityRevision/u, signature);
  assert.match(stageChunk, /restore_failed_held_coverage_unproven/u, signature);
  assert.match(stageChunk.slice(unprovenIndex, mutationIndex), /return false/u, signature);
  assert.doesNotMatch(stageChunk.slice(0, mutationIndex), /bufferedOutputOverflowedRef\.current = false/u, signature);
});

test('TerminalView leaves FAILED_HELD ownership untouched on reset throw or sole-writer rejection', () => {
  const signature = 'REL-BGSTAB-010: authoritative coverage is transactional after replay proof';
  const applyIndex = source.indexOf('const applySnapshotReplacement = useCallback');
  const replaceIndex = source.indexOf('const replaceWithSnapshot = useCallback', applyIndex);
  const applyChunk = source.slice(applyIndex, replaceIndex);
  const resetIndex = applyChunk.indexOf("type: 'reset'");
  const replayIndex = applyChunk.indexOf('const written = await new Promise<boolean>');
  const resetAppliedIndex = applyChunk.indexOf('onApplied: () => {', resetIndex);
  const continueAfterResetIndex = applyChunk.indexOf('continueAfterReset().then(resolve', resetAppliedIndex);
  const writtenGuardIndex = applyChunk.indexOf('if (!written || !isCurrentRestoreAttempt(attempt)');
  const stageIndex = applyChunk.indexOf('stageFailedHeldCoverage(attempt, coverageProvenance, options.failedHeldCoverage)', writtenGuardIndex);

  assert.ok(replayIndex >= 0 && resetIndex > replayIndex, signature);
  assert.ok(resetAppliedIndex > resetIndex && continueAfterResetIndex > resetAppliedIndex,
    'replay continuation must start only after the queued reset completion callback');
  assert.ok(writtenGuardIndex > replayIndex && stageIndex > writtenGuardIndex, signature);
  assert.doesNotMatch(applyChunk.slice(0, stageIndex), /clearBufferedOutput\(\)/u, signature);
  assert.match(
    applyChunk.slice(replayIndex, stageIndex),
    /onRejected: \(\) => settleReplay\(false\)[\s\S]*if \(!written[\s\S]*return rejectSnapshotReplacement\('replay-write-or-restore-attempt-rejected'/u,
    'sole-writer rejection must return false before any ownership coverage mutation');
});

test('MIG-BGSTAB-002 authoritative snapshot replacement reports the exact rejected fence', () => {
  const signature = 'poisoned reload diagnostics must distinguish authority, identity, and writer rejection';
  const applyIndex = source.indexOf('const applySnapshotReplacement = useCallback');
  const replaceIndex = source.indexOf('const replaceWithSnapshot = useCallback', applyIndex);
  const replaceEnd = source.indexOf('const getScreenRepairReadiness = useCallback', replaceIndex);
  const applyChunk = source.slice(applyIndex, replaceIndex);
  const replaceChunk = source.slice(replaceIndex, replaceEnd);

  assert.match(applyChunk, /snapshot_replacement_rejected/u, signature);
  assert.match(applyChunk, /terminal-unavailable/u, signature);
  assert.match(applyChunk, /authority-fence-rejected/u, signature);
  assert.match(applyChunk, /checkpoint-authority-active/u, signature);
  assert.match(applyChunk, /write-coordinator-unavailable/u, signature);
  assert.match(applyChunk, /replay-write-or-restore-attempt-rejected/u, signature);
  assert.match(replaceChunk, /snapshot_replacement_rejected/u, signature);
  assert.match(replaceChunk, /ime-idle-wait-rejected/u, signature);
  assert.match(replaceChunk, /authority-fence-rejected-before-replacement/u, signature);
});

test('MIG-BGSTAB-002 reports an in-flight checkpoint takeover without treating every replacement rejection as ready', () => {
  const signature = 'a hard-refresh server snapshot must acknowledge only the checkpoint takeover that superseded its visual mutation';
  const optionsIndex = source.indexOf('export interface TerminalSnapshotReplacementOptions');
  const applyIndex = source.indexOf('const applySnapshotReplacement = useCallback');
  const replaceIndex = source.indexOf('const replaceWithSnapshot = useCallback', applyIndex);
  const optionsChunk = source.slice(optionsIndex, applyIndex);
  const applyChunk = source.slice(applyIndex, replaceIndex);
  const containerSnapshotIndex = terminalContainerSource.indexOf('const replaceAuthoritativeSnapshot = () =>');
  const containerSnapshotChunk = terminalContainerSource.slice(containerSnapshotIndex, containerSnapshotIndex + 2600);

  assert.notEqual(optionsIndex, -1, signature);
  assert.notEqual(applyIndex, -1, signature);
  assert.notEqual(containerSnapshotIndex, -1, signature);
  assert.match(optionsChunk, /onRejected\?: \(reason: string\) => void/u, signature);
  assert.match(applyChunk, /options\?\.onRejected\?\.\(reason\)/u, signature);
  assert.match(containerSnapshotChunk, /onRejected: \(reason\) => \{\s*replacementRejectionReason = reason;/u, signature);
  assert.match(terminalContainerSource, /replacementRejectionReason === 'checkpoint-authority-active'/u, signature);
  assert.match(terminalContainerSource, /screen_snapshot_checkpoint_authority_superseded/u, signature);
  assert.match(
    terminalContainerSource,
    /checkpoint-authority-superseded-in-flight'[\s\S]*?else \{\s*initialRestorePendingRef\.current = false;/u,
    signature,
  );
  assert.doesNotMatch(
    containerSnapshotChunk,
    /checkpoint-authority-superseded-in-flight'[\s\S]*?terminalRef\.current\?\.releasePending\(\);/u,
    'checkpoint takeover must discard the superseded restore buffer at checkpoint drain, not flush it after the checkpoint',
  );
  assert.match(
    terminalContainerSource,
    /checkpoint-authority-superseded-in-flight'[\s\S]*?terminalRef\.current\?\.completeCheckpointTakeover\(\);/u,
    'checkpoint takeover must still send its prepared checkpoint-ready control without flushing held output',
  );
  assert.match(source, /completeCheckpointTakeover: \(\) => \{/u, signature);
  const takeoverStart = source.indexOf('completeCheckpointTakeover: () => {');
  const takeoverEnd = source.indexOf('setInputTransportState:', takeoverStart);
  const takeoverChunk = source.slice(takeoverStart, takeoverEnd);
  assert.match(takeoverChunk, /checkpointRuntime\.completeLegacyRecovery\(\{[\s\S]*source: 'compatibility-snapshot'/u, signature);
  assert.doesNotMatch(takeoverChunk, /flushBufferedOutput\(/u, signature);
  assert.doesNotMatch(takeoverChunk, /restorePendingRef\.current = false/u, signature);
  assert.match(
    source,
    /onPreparedCheckpointReadySendBlocked: failure => \{[\s\S]*?terminal_checkpoint_ready_send_blocked/u,
    'a checkpoint-ready control gate must leave a bounded client diagnostic instead of failing silently',
  );
  assert.match(
    source,
    /onPreparedCheckpointReadyDeferred: deferral => \{[\s\S]*?terminal_checkpoint_ready_deferred/u,
    'an unproven checkpoint-ready preparation must expose its deferred guard',
  );
});

test('TerminalView restore replay is fenced by exact attempt epoch and xterm identity', () => {
  const signature = 'REL-BGSTAB-010: a delayed restore A callback must never release or drain restore B';
  const beginIndex = source.indexOf('const beginRestoreAttempt = useCallback');
  const storedIndex = source.indexOf('const restoreStoredSnapshot = useCallback', beginIndex);
  const applyIndex = source.indexOf('const applySnapshotReplacement = useCallback', storedIndex);
  const replaceIndex = source.indexOf('const replaceWithSnapshot = useCallback', applyIndex);
  const beginChunk = source.slice(beginIndex, storedIndex);
  const storedChunk = source.slice(storedIndex, applyIndex);
  const applyChunk = source.slice(applyIndex, replaceIndex);

  assert.match(beginChunk, /attemptEpoch: restoreAttemptEpochRef\.current[\s\S]*term/u, signature);
  assert.match(beginChunk, /isCurrentRestoreAttempt/u, signature);
  assert.match(storedChunk, /restoreStoredSnapshot = useCallback\(\([\s\S]*term: Terminal,[\s\S]*attempt: TerminalRestoreAttemptIdentity,[\s\S]*\): Promise<boolean>/u, signature);
  assert.match(storedChunk, /if \(!written \|\| !isCurrentRestoreAttempt\(attempt\)\)/u, signature);
  assert.match(storedChunk, /releaseRestorePending\(attempt\)/u, signature);
  assert.match(applyChunk, /const attempt = beginRestoreAttempt\(term/u, signature);
  assert.match(applyChunk, /!isCurrentRestoreAttempt\(attempt\)/u, signature);
  assert.match(applyChunk, /releaseRestorePending\(attempt\)/u, signature);
});

test('TerminalView resets scheduler and ingress retry ownership on terminal identity change and cleanup', () => {
  const signature = 'REL-BGSTAB-010: stale frame/retry callbacks must not cross xterm remount ownership';
  const schedulerIndex = source.indexOf('const getOutputScheduler = useCallback');
  const writeIndex = source.indexOf('const writeOutput = useCallback', schedulerIndex);
  const schedulerChunk = source.slice(schedulerIndex, writeIndex);
  const cleanupIndex = source.indexOf('const disposeTerminalRuntime = () => {', source.indexOf('const resizeObserver = new ResizeObserver'));
  const cleanupEnd = source.indexOf('term.dispose();', cleanupIndex);
  const cleanupChunk = source.slice(cleanupIndex, cleanupEnd);

  assert.match(schedulerChunk, /const terminalIdentityChanged = outputSchedulerTermRef\.current !== term/u, signature);
  assert.match(schedulerChunk, /outputSchedulerRef\.current\?\.reset\('terminal-identity-changed'\)/u, signature);
  assert.match(cleanupChunk, /outputIngressRetryQueueRef\.current\?\.reset\(\)[\s\S]*outputIngressRetryQueueRef\.current = null/u, signature);
  assert.match(cleanupChunk, /outputSchedulerRef\.current\?\.reset\('terminal-disposed'\)[\s\S]*outputSchedulerRef\.current = null[\s\S]*outputSchedulerTermRef\.current = null/u, signature);
});

test('MIG-BGSTAB-002 snapshot replacement body shares the checkpoint sole-writer deque', () => {
  const signature = 'legacy snapshot body must not bypass the checkpoint sole-writer deque';
  const applyIndex = source.indexOf('const applySnapshotReplacement = useCallback');
  const replaceIndex = source.indexOf('const replaceWithSnapshot = useCallback', applyIndex);
  const applyChunk = source.slice(applyIndex, replaceIndex);

  assert.notEqual(applyIndex, -1, signature);
  assert.match(
    applyChunk,
    /coordinator\.submitCompatibility\(\{[\s\S]*type: 'write',[\s\S]*kind: 'repair',[\s\S]*data,[\s\S]*onWritten/u,
    signature,
  );
  assert.doesNotMatch(
    applyChunk,
    /writeReplayDataWithProbe\(term, data, replayLease\)/u,
    'a direct replay may start after checkpoint authority and overwrite its retained alternate buffer',
  );
});

test('TerminalView non-authoritative replay writes use a bounded same-xterm FIFO probe before releasing the lease', () => {
  assert.match(source, /writeTerminalReplayWithFifoProbe\(\{/);
  assert.match(source, /write: \(payload, onWritten\) => \{[\s\S]*submitCompatibility\(\{[\s\S]*type: 'write'[\s\S]*data: payload,[\s\S]*onWritten/u);
  assert.match(source, /timeoutMs: TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS/);
  assert.match(source, /writeReplayDataWithProbe\(term, snapshot\.content\)/);
  assert.match(source, /writeReplayDataWithProbe\(term, repair\.ansiPatch\)/);
});

test('TerminalView live output idle uses a bounded FIFO fallback and retires the proven scheduler write', () => {
  const signature = 'REL-BGSTAB-009: live-lane idle must not wait forever on a lost scheduler callback';
  const probeStart = source.indexOf('const probeOutputFifo = useCallback');
  const idleStart = source.indexOf('const awaitOutputIdleWithFifoProbe = useCallback');
  const handleStart = source.indexOf('probeOutputFifo: () => probeOutputFifo()');
  const probeChunk = source.slice(probeStart, idleStart);
  const idleChunk = source.slice(idleStart, handleStart);

  assert.notEqual(probeStart, -1, signature);
  assert.notEqual(idleStart, -1, signature);
  assert.notEqual(handleStart, -1, signature);
  assert.match(probeChunk, /submitCompatibility\(\{[\s\S]*type: 'write'[\s\S]*data: ''/u, signature);
  assert.match(probeChunk, /const probeIdentity = scheduler\.captureFifoProbeIdentity\(\)/, signature);
  assert.match(probeChunk, /scheduler\.settleFifoProbe\(probeIdentity\)/, signature);
  assert.match(idleChunk, /setTimeout\([\s\S]*TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS/, signature);
  assert.match(idleChunk, /probeOutputFifo\(\)/, signature);
  assert.match(idleChunk, /const waitForIdleBarrier = \(\): void => \{/, signature);
  assert.match(idleChunk, /if \(scheduler\.isIdle\(\)\) \{[\s\S]*settle\(true\)/, signature);
  assert.match(idleChunk, /waitForIdleBarrier\(\);/, signature);
  assert.match(idleChunk, /probeResult === 'failed' \|\| probeResult === 'stale'/, signature);
});

test('TerminalView suppresses parser replies during replay without silently dropping user onData', () => {
  assert.match(source, /const markUserXtermDataProvenance/);
  assert.match(source, /const consumeUserXtermDataProvenance/);
  assert.match(source, /programmaticPaste !== null[\s\S]*?consumeUserXtermDataProvenance\(\)/);
  assert.match(source, /hasUserInputProvenance \? 'user-input' : 'parser-generated'/);
  assert.match(source, /const result = submitCapturedInput\(data, debugInput, source\)/);
});

test('Remount adapter RED — grace authority barrier', () => {
  const signature = 'expected grace snapshot-tail-ready-input order and matching token propagation';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const coordinatorAdapter = createRecordingRecoveryAdapter();
  const chronology: string[] = [];
  const snapshots: Array<{ onWritten: () => void }> = [];
  const releasedInput: string[] = [];
  const originalScheduled = coordinatorAdapter.enqueueScheduledOutput;
  const originalReady = coordinatorAdapter.setCurrentViewReady;
  coordinatorAdapter.enqueueScheduledOutput = (write) => {
    chronology.push(`tail:${write.chunk.chunkId}`);
    originalScheduled(write);
  };
  coordinatorAdapter.setCurrentViewReady = (change) => {
    chronology.push(`ready:${change.ready}`);
    originalReady(change);
  };
  Object.assign(coordinatorAdapter, {
    enqueueAuthoritativeSnapshot: (write: { onWritten: () => void }) => {
      chronology.push('snapshot');
      snapshots.push(write);
    },
    releaseQueuedInput: (input: { data: string }) => {
      chronology.push(`input:${input.data}`);
      releasedInput.push(input.data);
    },
  });
  const tailBytes = new TextEncoder().encode('tail').byteLength;
  const inputBytes = new TextEncoder().encode('queued-input').byteLength;
  const coordinator = factory({
    maxHeldBytes: Math.max(tailBytes, inputBytes),
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter: coordinatorAdapter,
  });
  const scope: RecoveryScope = { clientId: 'view-grace', sessionId: 'session-a' };
  const { production, commands } = invokeTerminalViewRestoreAdapter(coordinator, scope, signature);
  production.begin({ liveSchedulerIdle: false });
  const queuedInputResult = production.handle({ type: 'queued-user-input', data: 'queued-input' });
  const queuedInputAdmitted = !queuedInputResult.ignored
    && production.getState()?.queuedInputCount === 1;
  production.handle({
    type: 'output-arrived',
    chunk: { chunkId: 'tail-1', screenSeq: 42, data: 'tail' },
  });
  production.handle({ type: 'server-ready-latched' });
  production.handle({
    type: 'authoritative-snapshot-received', snapshotSeq: 41,
    parserBoundary: 'complete', data: 'snapshot',
  });
  const readyBeforeIdle = production.getState()?.currentViewTransactionReady;
  production.handle({ type: 'live-lane-idle' });
  snapshots[0]?.onWritten();
  coordinatorAdapter.scheduled[0]?.onWritten();
  const readyBeforeAck = production.getState()?.currentViewTransactionReady;
  production.handle({ type: 'repair-acknowledged' });

  assert.deepEqual({
    queuedInputAdmitted,
    readyBeforeIdle,
    readyBeforeAck,
    readyAfterAck: production.getState()?.currentViewTransactionReady,
    releasedInput,
    chronology,
    commandTypes: commands.map(command => command.type),
    commandsCarryBoundIdentity: commands.every(command => (
      command.clientId === scope.clientId
      && command.sessionId === scope.sessionId
      && command.connectionGeneration === 7
      && command.sessionGeneration === 11
    )),
  }, {
    queuedInputAdmitted: true,
    readyBeforeIdle: false,
    readyBeforeAck: false,
    readyAfterAck: true,
    releasedInput: ['queued-input'],
    chronology: ['ready:false', 'snapshot', 'tail:tail-1', 'ready:true', 'input:queued-input'],
    commandTypes: [
      'begin-resync',
      'queued-user-input',
      'output-arrived',
      'server-ready-latched',
      'authoritative-snapshot-received',
      'live-lane-idle',
      'repair-acknowledged',
    ],
    commandsCarryBoundIdentity: true,
  }, signature);
});

test('Remount adapter RED — null-ref dispose ownership', () => {
  const signature = 'expected null-ref dispose and repeated remount to clear all bounded ownership';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const coordinatorAdapter = createRecordingRecoveryAdapter();
  const coordinator = factory({ maxHeldBytes: 16, maxHeldChunks: 2, transportMode: 'unified', adapter: coordinatorAdapter });
  const scope: RecoveryScope = { clientId: 'view-remount', sessionId: 'same-session' };
  const generationOne = { ...CURRENT_IDENTITY, viewGeneration: 1, xtermGeneration: 1 };
  const { production, commands } = invokeTerminalViewRestoreAdapter(
    coordinator, scope, signature, generationOne,
  );
  production.begin();
  production.handle({
    type: 'output-arrived',
    chunk: { chunkId: 'old', screenSeq: 2, data: 'old' },
  });
  production.handle({
    type: 'authoritative-snapshot-applied', snapshotSeq: 1, parserBoundary: 'complete',
  });
  const oldWrite = coordinatorAdapter.scheduled[0]?.onWritten;
  production.handle({ type: 'dispose' });
  const generationTwo = { ...CURRENT_IDENTITY, viewGeneration: 2, xtermGeneration: 2 };
  production.remount(generationTwo);
  oldWrite?.();
  const late = production.handleFrom(generationOne, {
    type: 'output-arrived',
    chunk: { chunkId: 'late-old', screenSeq: 3, data: 'stale' },
  });
  const state = production.getState() as Record<string, unknown>;
  const lateCommand = commands.at(-1);

  assert.deepEqual({
    lateIgnored: late.ignored,
    lateCommandViewGeneration: lateCommand?.viewGeneration,
    lateCommandXtermGeneration: lateCommand?.xtermGeneration,
    viewGeneration: state.viewGeneration,
    xtermGeneration: state.xtermGeneration,
    heldOutputBytes: state.heldOutputBytes,
    activeTimerCount: state.activeTimerCount,
    currentViewTransactionReady: state.currentViewTransactionReady,
  }, {
    lateIgnored: true,
    lateCommandViewGeneration: 1,
    lateCommandXtermGeneration: 1,
    viewGeneration: 2,
    xtermGeneration: 2,
    heldOutputBytes: 0,
    activeTimerCount: 0,
    currentViewTransactionReady: false,
  }, signature);
});

test('Remount adapter RED — normal path compatibility', () => {
  const signature = 'expected hidden snapshot tombstone unified split and normal path behavior to remain unchanged';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const observations = (['unified', 'split-shadow', 'split'] as const).map((transportMode) => {
    const coordinatorAdapter = createRecordingRecoveryAdapter();
    const coordinator = factory({ maxHeldBytes: 16, maxHeldChunks: 2, transportMode, adapter: coordinatorAdapter });
    const scope: RecoveryScope = { clientId: `normal-${transportMode}`, sessionId: 'session-normal' };
    const { production, commands } = invokeTerminalViewRestoreAdapter(coordinator, scope, signature);
    production.begin({ hiddenDirty: true, hiddenSkipped: true });
    const state = production.getState();
    return {
      requestedTransportMode: production.getTransportStatus().requestedTransportMode,
      effectiveTransportMode: production.getTransportStatus().effectiveTransportMode,
      standaloneSplitParity: production.getTransportStatus().standaloneSplitParity,
      hiddenDirty: state?.hiddenDirty,
      hiddenSkipped: state?.hiddenSkipped,
      currentViewTransactionReady: state?.currentViewTransactionReady,
      retainedHistoryEquivalent: state?.retainedHistoryEquivalent,
      directWrites: coordinatorAdapter.directWrites.length,
      firstCommand: commands[0]?.type,
    };
  });

  assert.deepEqual(observations,
    (['unified', 'split-shadow', 'split'] as const).map(requestedTransportMode => ({
      requestedTransportMode,
      effectiveTransportMode: 'unified',
      standaloneSplitParity: 'unresolved',
      hiddenDirty: requestedTransportMode === 'unified' ? true : undefined,
      hiddenSkipped: requestedTransportMode === 'unified' ? true : undefined,
      currentViewTransactionReady: requestedTransportMode === 'unified' ? false : undefined,
      retainedHistoryEquivalent: requestedTransportMode === 'unified' ? false : undefined,
      directWrites: 0,
      firstCommand: 'begin-resync',
    })), signature);
});
