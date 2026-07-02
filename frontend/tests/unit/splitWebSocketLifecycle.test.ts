import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveSplitOutputCloseAction,
  shouldFlushControlSubscriptions,
} from '../../src/utils/splitWebSocketLifecycle.ts';

test('split mode delays control subscribe until output is ready or fallback is active', () => {
  assert.equal(shouldFlushControlSubscriptions({
    transportMode: 'split',
    splitOutputReady: false,
    splitControlFallback: false,
  }), false);

  assert.equal(shouldFlushControlSubscriptions({
    transportMode: 'split',
    splitOutputReady: true,
    splitControlFallback: false,
  }), true);

  assert.equal(shouldFlushControlSubscriptions({
    transportMode: 'split',
    splitOutputReady: false,
    splitControlFallback: true,
  }), true);
});

test('ready output close enables control fallback for later subscriptions', () => {
  const closeAction = resolveSplitOutputCloseAction();
  assert.deepEqual(closeAction, {
    splitControlFallback: true,
    flushControlSubscriptions: true,
  });

  assert.equal(shouldFlushControlSubscriptions({
    transportMode: 'split',
    splitOutputReady: false,
    splitControlFallback: closeAction.splitControlFallback,
  }), true);
});

