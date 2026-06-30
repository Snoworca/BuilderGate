import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginVisibleOutputRecovery,
  createVisibleOutputRecoveryState,
  finishVisibleOutputRecovery,
  isVisibleOutputRecoveryBlocking,
  recordVisibleOutputRecoverySendFailure,
  recordVisibleOutputRecoverySendSuccess,
  resolveVisibleOutputRecoveryBarrierReason,
} from '../../src/utils/visibleOutputRecovery.ts';

test('visible output recovery retries failed replay sends before abandoning', () => {
  let state = createVisibleOutputRecoveryState();
  const started = beginVisibleOutputRecovery(state);
  state = started.state;

  assert.equal(started.shouldSend, true);
  assert.equal(state.pending, true);

  const firstFailure = recordVisibleOutputRecoverySendFailure(state, 2);
  state = firstFailure.state;
  assert.equal(firstFailure.action, 'retry');
  assert.equal(state.pending, true);
  assert.equal(state.retryCount, 1);

  const secondFailure = recordVisibleOutputRecoverySendFailure(state, 2);
  state = secondFailure.state;
  assert.equal(secondFailure.action, 'abandon');
  assert.equal(state.pending, false);
  assert.equal(state.retryCount, 0);
  assert.equal(state.staleTerminal, true);
  assert.equal(isVisibleOutputRecoveryBlocking(state), true);
});

test('visible output recovery ignores duplicate overflow while pending and clears on finish', () => {
  let state = createVisibleOutputRecoveryState();
  state = beginVisibleOutputRecovery(state).state;

  const duplicate = beginVisibleOutputRecovery(state);
  assert.equal(duplicate.shouldSend, false);
  assert.equal(duplicate.state.pending, true);

  state = recordVisibleOutputRecoverySendSuccess(duplicate.state);
  assert.equal(state.pending, true);

  state = finishVisibleOutputRecovery(state);
  assert.equal(state.pending, false);
  assert.equal(state.retryCount, 0);
  assert.equal(isVisibleOutputRecoveryBlocking(state), false);
});

test('visible output recovery keeps input blocked when abandoning a stale terminal view', () => {
  let state = beginVisibleOutputRecovery(createVisibleOutputRecoveryState()).state;

  state = finishVisibleOutputRecovery(state, { keepTerminalStale: true });

  assert.equal(state.pending, false);
  assert.equal(state.retryCount, 0);
  assert.equal(state.staleTerminal, true);
  assert.equal(isVisibleOutputRecoveryBlocking(state), true);
  assert.equal(beginVisibleOutputRecovery(state).shouldSend, false);

  state = finishVisibleOutputRecovery(state);
  assert.equal(state.staleTerminal, false);
  assert.equal(isVisibleOutputRecoveryBlocking(state), false);
});

test('visible output recovery exposes a transport barrier while pending or stale', () => {
  let state = createVisibleOutputRecoveryState();
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'none');

  state = beginVisibleOutputRecovery(state).state;
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'visible-output-recovery');

  state = finishVisibleOutputRecovery(state, { keepTerminalStale: true });
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'visible-output-recovery');

  state = finishVisibleOutputRecovery(state);
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'none');
});
