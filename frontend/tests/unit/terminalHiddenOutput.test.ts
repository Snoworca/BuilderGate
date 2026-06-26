import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginHiddenOutputReplay,
  clearHiddenOutputState,
  createHiddenOutputReplayState,
  createHiddenOutputState,
  finishHiddenOutputReplay,
  resolveHiddenOutput,
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

test('omitted hidden output policy keeps legacy hidden writes enabled', () => {
  const state = createHiddenOutputState();
  const decision = resolveHiddenOutput(state, {
    isVisible: false,
    byteLength: 7,
    data: 'hidden',
  });

  assert.equal(decision.action, 'write');
  assert.equal(decision.nextState, state);
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
