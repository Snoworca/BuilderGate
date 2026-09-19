// Issue #109. The rule is small; what it must not do is the interesting part.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldExpirePendingInput } from '../../src/utils/pendingInputExpiry.ts';

const base = { queuedMs: 0, containsEnter: false, ttlMs: 1500, barrierActive: false };

test('#109 nothing inside the TTL expires, barrier or not', () => {
  for (const barrierActive of [true, false]) {
    assert.equal(shouldExpirePendingInput({ ...base, queuedMs: 0, barrierActive }), false);
    assert.equal(shouldExpirePendingInput({ ...base, queuedMs: 1500, barrierActive }), false,
      'the boundary itself is inside the window');
    assert.equal(shouldExpirePendingInput({ ...base, queuedMs: 1500, containsEnter: true, barrierActive }), false);
  }
});

test('#109 a stale Enter still expires while the barrier is active', () => {
  // The safety rule this TTL was written for: a submit queued against one screen must not run
  // against whatever is there when the barrier lifts.
  assert.equal(
    shouldExpirePendingInput({ ...base, queuedMs: 10_000, containsEnter: true, barrierActive: true }),
    true,
  );
});

test('#109 plain characters are held while the barrier is still what blocks them', () => {
  // The defect: a ten-second restore barrier outlives a 1.5s TTL, so every character typed
  // during the restore was dropped with no message.
  assert.equal(
    shouldExpirePendingInput({ ...base, queuedMs: 10_000, containsEnter: false, barrierActive: true }),
    false,
  );
});

test('#109 once the barrier is gone the TTL applies again', () => {
  // The control. Without it, "hold while blocked" would be indistinguishable from "never
  // expire", and a queue that never expires is a different defect.
  assert.equal(
    shouldExpirePendingInput({ ...base, queuedMs: 10_000, containsEnter: false, barrierActive: false }),
    true,
  );
});
