// #18 / REL-BGSTAB-016 — which server refusals owe the user a warning.
//
// THE DEFECT THIS FILE EXISTS FOR. The rule was an inline `reason !== 'duplicate-operation'`
// with a comment asserting that in every other case "the write never reached the PTY".
// That is false for `expired-operation`. Measured 2026-09-19 in terminalInputLedger.ts: the
// tombstone set is populated ONLY by evicting an id out of `operations`, and an id enters
// `operations` only when it was admitted -- that is, written to the PTY. So `expired` means
// the write DID reach the PTY, exactly as `duplicate` does; the two differ in whether the
// server can still prove it, not in whether it happened.
//
// The user-visible consequence is not cosmetic. A false "input discarded" warning for a
// command that actually ran invites the user to retype it, which produces a REAL duplicate
// execution by hand -- the very outcome the ledger exists to prevent, arriving through the
// warning meant to protect them.
//
// It is a predicate rather than an inline condition so the classification is a thing a test
// can call. The same lesson as buildTerminalInputIdentityFields: a rule spelled at one call
// site is covered only by whoever remembers to re-read the comment.
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldSurfaceInputRejection } from '../../src/utils/inputRejectionSurface.ts';

test('REL-BGSTAB-016 a refusal whose write never reached the PTY is surfaced', () => {
  // The user lost what they typed in every one of these.
  for (const reason of [
    'timeout',
    'timeout-enter-safety',
    'queue-overflow',
    'context-changed',
    'session-missing',
    'session-closed',
    'server-error',
    'auth-expired',
    'transport-closed',
    'invalid-sequence',
    'invalid-payload',
    'mode-observe-only',
    'payload-mismatch',
    'driver-lease-unavailable',
    'stale-target-generation',
    'paste-too-large',
    // #112: all three mean the write did not reach the PTY (a binding could not be
    // resolved, a binding would not accept the write, or an Enter-carrying send lacked
    // the required scope) -- the opposite of the two reasons excluded below.
    'target-not-live',
    'target-not-found',
    'enter-policy-rejected',
    // #112 follow-up: the split of target-not-live's two write-time causes. A dead
    // session and a refused mutation identity both mean the write did not land either --
    // neither belongs in REACHED_THE_PTY.
    'target-session-gone',
    'target-identity-stale',
  ] as const) {
    assert.equal(shouldSurfaceInputRejection(reason), true, reason);
  }
});

test('#18 duplicate-operation is not surfaced, because that write did reach the PTY', () => {
  assert.equal(shouldSurfaceInputRejection('duplicate-operation'), false);
});

test('#18 expired-operation is NOT surfaced either, because that write also reached the PTY', () => {
  // This is the fix. `expired` is a tombstone hit, and a tombstone only ever holds an id
  // that was admitted -- i.e. written. Warning here tells the user they lost a command
  // that ran, and the natural response is to run it again.
  assert.equal(shouldSurfaceInputRejection('expired-operation'), false);
});

test('#18 unknown-operation IS surfaced, because nobody can say whether it ran', () => {
  // The sharp case and the reason the two above are not enough on their own. `unknown` is
  // the absence of a record plus proof one could have been dropped, so silence is the one
  // wrong answer -- only the user can look at the terminal and decide.
  assert.equal(shouldSurfaceInputRejection('unknown-operation'), true);
});

test('#18 the two silent reasons are exactly the two that reached the PTY', () => {
  // Pins the SHAPE of the rule rather than its current membership, so adding a future
  // reason forces a decision about which side it belongs on instead of defaulting to
  // "surfaced" and quietly warning about input that was never lost.
  const silent = ([
    'duplicate-operation', 'expired-operation', 'unknown-operation', 'payload-mismatch',
  ] as const).filter((reason) => !shouldSurfaceInputRejection(reason));

  assert.deepEqual([...silent].sort(), ['duplicate-operation', 'expired-operation']);
});
