import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STREAM_EPOCH_BUMP_REASONS,
  createTerminalStreamEpochLedger,
} from './terminalStreamEpoch.js';
import type { StreamEpochBumpReason } from './terminalStreamEpoch.js';

/**
 * `streamEpoch` ownership (`01 §1.6`).
 *
 * The value belongs to the session, not to the channel: connection groups are
 * rebuilt on every reconnect, so a channel-owned epoch would reset to zero each
 * time and break the premise that raising it discards the old stream.
 *
 * Every one of the five listed events ends at `fresh-checkpoint-required` on the
 * client, so an accidental bump is not free and an omitted one is a silent
 * continuity claim over a stream that did not continue.
 */

// ---------------------------------------------------------------------------
// 1. Issue and lifetime.
// ---------------------------------------------------------------------------

test('a new session is issued its first epoch', () => {
  const ledger = createTerminalStreamEpochLedger();

  assert.equal(ledger.current('session-a'), '1');
});

test('reading twice does not advance the epoch', () => {
  const ledger = createTerminalStreamEpochLedger();

  // A channel opening reads the current value; `01:474` corrects the earlier
  // draft that treated channel creation as a bump.
  assert.equal(ledger.current('session-a'), ledger.current('session-a'));
});

test('each session is issued its own epoch, never a shared one', () => {
  const ledger = createTerminalStreamEpochLedger();

  // Issue is monotonic across sessions — `01:462` promotes the process-wide
  // counter rather than replacing it, so two live sessions never present the
  // same epoch and a stale value cannot be mistaken for a peer's current one.
  assert.equal(ledger.current('session-a'), '1');
  assert.equal(ledger.current('session-b'), '2');
  assert.equal(ledger.current('session-a'), '1');
});

test('a bump moves only the session it names', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.current('session-a');
  const beforeB = ledger.current('session-b');

  ledger.bump('session-a', 'authority-rollback');

  assert.equal(ledger.current('session-b'), beforeB);
});

test('an epoch survives a reconnect, having nothing to do with connections', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.bump('session-a', 'codec-switch');
  const afterBump = ledger.current('session-a');

  // Nothing connection-shaped exists in this API on purpose: there is no call
  // a reconnect could make that would reset the value.
  assert.equal(ledger.current('session-a'), afterBump);
});

// ---------------------------------------------------------------------------
// 2. The five bump reasons, and only those.
// ---------------------------------------------------------------------------

test('every documented reason advances the epoch', () => {
  for (const reason of STREAM_EPOCH_BUMP_REASONS) {
    const ledger = createTerminalStreamEpochLedger();
    const before = ledger.current('session-a');

    const after = ledger.bump('session-a', reason);

    assert.notEqual(after, before, `${reason} did not advance the epoch`);
  }
});

test('the reason list is exactly the five events 01 §1.6 enumerates', () => {
  assert.deepEqual([...STREAM_EPOCH_BUMP_REASONS].sort(), [
    'authority-rollback',
    'channel-space-exhausted',
    'codec-switch',
    'ordinal-rollover',
    'session-created',
  ]);
});

test('an unlisted reason is refused rather than silently accepted', () => {
  const ledger = createTerminalStreamEpochLedger();

  // An epoch bump forces a fresh checkpoint on every client of that session, so
  // it is not something a caller should be able to trigger by typo.
  assert.throws(
    () => ledger.bump('session-a', 'because-i-said-so' as StreamEpochBumpReason),
    /reason/i,
  );
});

// ---------------------------------------------------------------------------
// 3. Monotonicity.
// ---------------------------------------------------------------------------

test('epochs only ever increase', () => {
  const ledger = createTerminalStreamEpochLedger();
  let previous = BigInt(ledger.current('session-a'));

  for (const reason of STREAM_EPOCH_BUMP_REASONS) {
    const next = BigInt(ledger.bump('session-a', reason));
    assert.ok(next > previous, `${reason} did not increase the epoch`);
    previous = next;
  }
});

test('the epoch is a decimal Ordinal64 string, not a number', () => {
  const ledger = createTerminalStreamEpochLedger();

  // The wire field is a u64; a JS number would round past 2^53 and silently
  // claim continuity with a different stream.
  const epoch = ledger.current('session-a');
  assert.equal(typeof epoch, 'string');
  assert.match(epoch, /^[0-9]+$/);
});

test('an epoch beyond the safe integer range stays exact', () => {
  const ledger = createTerminalStreamEpochLedger({ initial: '9007199254740993' });

  assert.equal(ledger.current('session-a'), '9007199254740993');
  assert.equal(ledger.bump('session-a', 'codec-switch'), '9007199254740994');
});

test('a raised epoch never collides with another session current one', () => {
  const ledger = createTerminalStreamEpochLedger();
  const a = ledger.current('session-a');
  const b = ledger.current('session-b');

  const raised = ledger.bump('session-a', 'codec-switch');

  assert.notEqual(raised, a);
  assert.notEqual(raised, b);
});

// ---------------------------------------------------------------------------
// 3.5 Adopting an epoch supplied from outside.
// ---------------------------------------------------------------------------

test('an adopted epoch becomes the session current value', () => {
  const ledger = createTerminalStreamEpochLedger();

  // A configured initial ordinal is the session's real epoch; if the ledger
  // kept its own the two would drift and the wire would carry whichever the
  // last writer happened to be.
  assert.equal(ledger.adopt('session-a', '42', 'session-created'), '42');
  assert.equal(ledger.current('session-a'), '42');
});

test('an adopted epoch continues to bump from the adopted value', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.adopt('session-a', '42', 'session-created');

  assert.equal(ledger.bump('session-a', 'ordinal-rollover'), '43');
});

test('adopting replaces an epoch the ledger had already issued', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.bump('session-a', 'codec-switch');

  assert.equal(ledger.adopt('session-a', '9', 'authority-rollback'), '9');
  assert.equal(ledger.lastReason('session-a'), 'authority-rollback');
});

test('adopting a value that is not a canonical decimal is refused', () => {
  const ledger = createTerminalStreamEpochLedger();

  assert.throws(() => ledger.adopt('session-a', '', 'session-created'), RangeError);
  assert.throws(() => ledger.adopt('session-a', '-1', 'session-created'), RangeError);
  assert.throws(() => ledger.adopt('session-a', '1.5', 'session-created'), RangeError);
  assert.throws(() => ledger.adopt('session-a', '0x10', 'session-created'), RangeError);
});

test('adopting under an unlisted reason is refused', () => {
  const ledger = createTerminalStreamEpochLedger();

  assert.throws(
    () => ledger.adopt('session-a', '5', 'channel-opened' as never),
    RangeError,
  );
});

test('an adopted epoch past the safe integer range stays exact', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.adopt('session-a', '9007199254740993', 'session-created');

  assert.equal(ledger.bump('session-a', 'codec-switch'), '9007199254740994');
});

// ---------------------------------------------------------------------------
// 4. Forgetting a session.
// ---------------------------------------------------------------------------

test('a forgotten session is issued a fresh epoch, never a recycled one', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.bump('session-a', 'authority-rollback');
  const beforeForget = BigInt(ledger.current('session-a'));
  ledger.forget('session-a');

  // Ids are not reused by the session manager, so this is only ever reached
  // after the session itself is gone. Re-issuing an epoch that a live client
  // might still hold would let a dead stream pass as continuous.
  assert.ok(BigInt(ledger.current('session-a')) > beforeForget);
});

test('forgetting one session leaves the others alone', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.bump('session-a', 'codec-switch');
  const keptB = ledger.bump('session-b', 'codec-switch');

  ledger.forget('session-a');

  assert.equal(ledger.current('session-b'), keptB);
});

test('forgetting an unknown session is not an error', () => {
  const ledger = createTerminalStreamEpochLedger();

  assert.doesNotThrow(() => ledger.forget('never-existed'));
});

// ---------------------------------------------------------------------------
// 5. Observability — a bump is never free, so it is never anonymous.
// ---------------------------------------------------------------------------

test('the ledger reports what caused the current epoch', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.bump('session-a', 'ordinal-rollover');

  assert.equal(ledger.lastReason('session-a'), 'ordinal-rollover');
});

test('an untouched session reports its issue as the cause', () => {
  const ledger = createTerminalStreamEpochLedger();
  ledger.current('session-a');

  assert.equal(ledger.lastReason('session-a'), 'session-created');
});

test('a session that was never seen has no cause', () => {
  const ledger = createTerminalStreamEpochLedger();

  assert.equal(ledger.lastReason('session-a'), undefined);
});
