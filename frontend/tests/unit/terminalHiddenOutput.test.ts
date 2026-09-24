import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginHiddenOutputReplay,
  clearHiddenOutputState,
  createHiddenOutputReplayState,
  createHiddenOutputState,
  finishHiddenOutputReplay,
  resolveHiddenOutput,
  shouldClearHiddenOutputAfterSnapshotRecovery,
} from '../../src/utils/terminalHiddenOutput.ts';

test('visible terminal output is written without marking replay recovery', () => {
  const state = createHiddenOutputState();
  const decision = resolveHiddenOutput(state, { isVisible: true, byteLength: 12 });

  assert.equal(decision.action, 'write');
  assert.deepEqual(decision.nextState, { skipped: false, skippedBytes: 0, debugTail: '' });
});

test('hidden terminal output is skipped and counted instead of being buffered', () => {
  const first = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 7,
    hiddenOutputPolicy: 'snapshot-restore',
  });
  const second = resolveHiddenOutput(first.nextState, {
    isVisible: false,
    byteLength: 5,
    hiddenOutputPolicy: 'snapshot-restore',
  });

  assert.equal(first.action, 'skip');
  assert.equal(second.action, 'skip');
  assert.deepEqual(second.nextState, { skipped: true, skippedBytes: 12, debugTail: '' });
});

test('omitted hidden output policy uses snapshot restore skip by default', () => {
  const state = createHiddenOutputState();
  const decision = resolveHiddenOutput(state, {
    isVisible: false,
    byteLength: 7,
    data: 'hidden',
  });

  assert.equal(decision.action, 'skip');
  assert.deepEqual(decision.nextState, { skipped: true, skippedBytes: 7, debugTail: '' });
});

test('write-hidden policy keeps legacy hidden output writes enabled', () => {
  const state = createHiddenOutputState();
  const decision = resolveHiddenOutput(state, {
    isVisible: false,
    byteLength: 7,
    data: 'hidden',
    hiddenOutputPolicy: 'write-hidden',
    hiddenOutputTailBytes: 4,
  });

  assert.equal(decision.action, 'write');
  assert.equal(decision.nextState, state);
});

test('visible live output stays paused until hidden output recovery clears', () => {
  const hidden = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 7,
    hiddenOutputPolicy: 'snapshot-restore',
  });
  const visibleBeforeRecovery = resolveHiddenOutput(hidden.nextState, {
    isVisible: true,
    byteLength: 5,
    hiddenOutputPolicy: 'snapshot-restore',
  });

  assert.equal(visibleBeforeRecovery.action, 'skip');
  assert.deepEqual(visibleBeforeRecovery.nextState, { skipped: true, skippedBytes: 12, debugTail: '' });
});

test('hidden output recovery state clears only after snapshot recovery succeeds', () => {
  const skipped = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 9,
    hiddenOutputPolicy: 'snapshot-restore',
  });
  const cleared = clearHiddenOutputState(skipped.nextState);

  assert.deepEqual(cleared, { skipped: false, skippedBytes: 0, debugTail: '' });
});

test('debug-tail policy keeps only a bounded UTF-8 tail', () => {
  const first = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 5,
    data: 'abcde',
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 7,
  });
  const second = resolveHiddenOutput(first.nextState, {
    isVisible: false,
    byteLength: 6,
    data: '가나',
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 6,
  });

  assert.equal(second.nextState.debugTail, '가나');
  assert.equal(new TextEncoder().encode(second.nextState.debugTail).length <= 6, true);
});

test('hidden output replay owns and releases a newly created restore barrier', () => {
  const started = beginHiddenOutputReplay(createHiddenOutputReplayState(), false);
  assert.deepEqual(started.replayState, { pending: true, restoreBarrierOwned: true });
  assert.equal(started.initialRestorePending, true);

  const finished = finishHiddenOutputReplay(started.replayState, started.initialRestorePending);
  assert.deepEqual(finished.replayState, { pending: false, restoreBarrierOwned: false });
  assert.equal(finished.initialRestorePending, false);
});

test('hidden output replay does not release a restore barrier owned by another replay', () => {
  const started = beginHiddenOutputReplay(createHiddenOutputReplayState(), true);
  assert.deepEqual(started.replayState, { pending: true, restoreBarrierOwned: false });
  assert.equal(started.initialRestorePending, true);

  const finished = finishHiddenOutputReplay(started.replayState, started.initialRestorePending);
  assert.deepEqual(finished.replayState, { pending: false, restoreBarrierOwned: false });
  assert.equal(finished.initialRestorePending, true);
});

test('hidden output snapshot recovery clear criteria rejects fallback placeholders', () => {
  assert.equal(shouldClearHiddenOutputAfterSnapshotRecovery({
    snapshotMode: 'fallback',
    fallbackDataLength: 0,
    localRestoreSucceeded: false,
  }), false);
  assert.equal(shouldClearHiddenOutputAfterSnapshotRecovery({
    snapshotMode: 'fallback',
    fallbackDataLength: 0,
    localRestoreSucceeded: true,
  }), true);
  assert.equal(shouldClearHiddenOutputAfterSnapshotRecovery({
    snapshotMode: 'fallback',
    fallbackDataLength: 10,
    localRestoreSucceeded: false,
  }), true);
  assert.equal(shouldClearHiddenOutputAfterSnapshotRecovery({
    snapshotMode: 'authoritative',
    fallbackDataLength: 0,
    localRestoreSucceeded: false,
  }), true);
});

/**
 * This test's first assertion used to read `nextState.dataGapPending`, a field
 * that has never existed in src/utils/terminalHiddenOutput.ts — not at the
 * commit that introduced the test (c25d761) and not since. It was red from the
 * day it landed and asserted a client-side ledger that the design does not put
 * here.
 *
 * REL-BGSTAB-012 AC-2 puts the ordered dataGap latch on the SERVER, and that is
 * where it is implemented (`visibility.dataGapLatched` in
 * server/src/ws/WsRouter.ts, emitting `kind: 'dataGap'`) and where it is
 * covered: 'REL-BGSTAB-012 rejects stale visibility and latches ordered
 * dataGap' in server/src/ws/WsRouterSendPriority.test.ts.
 *
 * The second assertion was wrong the same way, and had never run because the
 * first one threw first. It required finishHiddenOutputReplay to refuse to
 * release the restore barrier before the drain ACK, but this function is a
 * state transition and the drain-ACK ordering is enforced by its callers in
 * TerminalContainer.tsx — 'compatibility-post-ack-tail' only fires after
 * authoritative-snapshot-tail-drained, and the local-snapshot path returns
 * early while an authoritative resync is active. AC-6's real contract is
 * covered by 'REL-BGSTAB-012 blocks ready and input until matching checkpoint
 * drain ACK' in tests/unit/terminalCheckpointRuntime.test.ts.
 *
 * So this test now asserts what this module does own: the client-side skip
 * latch, and which replay owns the restore barrier.
 */
test('REL-BGSTAB-012 latches the hidden skip and holds stale view through drain', () => {
  const signature = 'REL-BGSTAB-012 AC-2/AC-6: the first hidden skip must latch, and the restore barrier cannot clear before checkpoint drain acknowledgement';
  const hidden = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 9,
    data: 'hidden-gap',
    hiddenOutputPolicy: 'snapshot-restore',
  });

  assert.equal(hidden.action, 'skip', signature);
  assert.equal(hidden.nextState.skipped, true, signature);
  assert.equal(hidden.nextState.skippedBytes, 9, signature);

  // Barrier ownership. A replay that raised the restore barrier owns it and
  // releases it on finish; a replay that found the barrier already up leaves it
  // to whoever raised it.
  const raisedHere = beginHiddenOutputReplay(createHiddenOutputReplayState(), false);
  assert.equal(raisedHere.replayState.restoreBarrierOwned, true, signature);
  assert.equal(raisedHere.initialRestorePending, true, signature);
  assert.equal(
    finishHiddenOutputReplay(raisedHere.replayState, raisedHere.initialRestorePending)
      .initialRestorePending,
    false,
    signature,
  );

  const raisedElsewhere = beginHiddenOutputReplay(createHiddenOutputReplayState(), true);
  assert.equal(raisedElsewhere.replayState.restoreBarrierOwned, false, signature);
  assert.equal(
    finishHiddenOutputReplay(raisedElsewhere.replayState, raisedElsewhere.initialRestorePending)
      .initialRestorePending,
    true,
    signature,
  );
});
