import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalInputLedger,
  type TerminalInputAdmission,
} from './terminalInputLedger.js';

/**
 * REL-BGSTAB-028 — server-side exactly-once ledger for terminal input.
 *
 * The shape follows the one dedup mechanism this codebase already has: the
 * query-reply path keys on replyOrdinal plus responder identity and reports a
 * duplicate rather than swallowing it. This generalises that to ordinary input
 * instead of inventing a second scheme.
 */

const CLIENT = 'logical-client-1';
const SESSION = 'session-a';

function admissions(ledger: ReturnType<typeof createTerminalInputLedger>, ids: (string | undefined)[]): TerminalInputAdmission[] {
  return ids.map((operationId) => ledger.admit({
    logicalClientId: CLIENT,
    sessionId: SESSION,
    ...(operationId === undefined ? {} : { operationId }),
  }));
}

test('REL-BGSTAB-028 AC-1 a retransmitted operation is admitted exactly once', () => {
  const signature = 'REL-BGSTAB-028 AC-1: the same input operation must reach the PTY exactly once';
  const ledger = createTerminalInputLedger();

  const [first, second, third] = admissions(ledger, ['op-1', 'op-1', 'op-1']);
  assert.equal(first.write, true, signature);
  assert.equal(first.outcome, 'admitted', signature);
  assert.equal(second.write, false, signature);
  assert.equal(second.outcome, 'duplicate', signature);
  assert.equal(third.write, false, signature);
  assert.equal(third.outcome, 'duplicate', signature);
});

test('REL-BGSTAB-028 AC-1 duplicates are observable, not silently dropped', () => {
  const signature = 'REL-BGSTAB-028 AC-1: a duplicate must be recorded, not silently ignored';
  const ledger = createTerminalInputLedger();
  admissions(ledger, ['op-1', 'op-1', 'op-2', 'op-1']);

  const stats = ledger.snapshot({ logicalClientId: CLIENT, sessionId: SESSION });
  assert.equal(stats.admitted, 2, signature);
  assert.equal(stats.duplicates, 2, signature);
});

test('REL-BGSTAB-028 AC-1 distinct operations are all admitted', () => {
  const signature = 'REL-BGSTAB-028 AC-1: distinct operations must not be confused for retries';
  const ledger = createTerminalInputLedger();
  const results = admissions(ledger, ['op-1', 'op-2', 'op-3']);
  assert.deepEqual(results.map(r => r.write), [true, true, true], signature);
});

test('REL-BGSTAB-028 AC-2 a replay after reconnect on the same epoch does not execute twice', () => {
  const signature = 'REL-BGSTAB-028 AC-2: an unacknowledged operation resent after reconnect must not run twice';
  const ledger = createTerminalInputLedger();

  // The client sends, the ACK is lost, the client reconnects on the same
  // connection epoch and resends the same operation.
  assert.equal(admissions(ledger, ['op-7'])[0].write, true, signature);
  assert.equal(admissions(ledger, ['op-7'])[0].write, false, signature);

  // A genuinely new operation after the reconnect still runs.
  assert.equal(admissions(ledger, ['op-8'])[0].write, true, signature);
});

test('REL-BGSTAB-028 AC-3 a different logical client does not inherit another one\'s ledger', () => {
  // #111: this used to read "a new connection epoch does not inherit", and that sentence
  // was the defect. Isolation between two DIFFERENT clients is right and is kept here;
  // isolation between two connections of the SAME client is what re-executed commands
  // across a reconnect, and that is now forbidden by the test below.
  const signature = 'REL-BGSTAB-028 AC-3: one logical client must not reuse another\'s backlog';
  const ledger = createTerminalInputLedger();
  ledger.admit({ logicalClientId: 'logical-client-1', sessionId: SESSION, operationId: 'op-1' });

  const fresh = ledger.admit({ logicalClientId: 'logical-client-2', sessionId: SESSION, operationId: 'op-1' });
  assert.equal(fresh.write, true, signature);
  assert.equal(fresh.outcome, 'admitted', signature);
});

test('REL-BGSTAB-028 AC-3 release frees the ledger exactly once', () => {
  const signature = 'REL-BGSTAB-028 AC-3: session end must release the ledger exactly once';
  const ledger = createTerminalInputLedger();
  admissions(ledger, ['op-1', 'op-2']);

  assert.equal(ledger.release({ logicalClientId: CLIENT, sessionId: SESSION }), true, signature);
  assert.equal(
    ledger.release({ logicalClientId: CLIENT, sessionId: SESSION }),
    false,
    'a second release must report that there was nothing left to free',
  );
  // After release the same operation id is a fresh operation, not a duplicate.
  assert.equal(admissions(ledger, ['op-1'])[0].write, true, signature);
});

test('REL-BGSTAB-028 AC-3 the ledger is bounded and evicts oldest first', () => {
  const signature = 'REL-BGSTAB-028 AC-3: the ledger must be bounded rather than growing without limit';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 3 });
  admissions(ledger, ['op-1', 'op-2', 'op-3', 'op-4']);

  const stats = ledger.snapshot({ logicalClientId: CLIENT, sessionId: SESSION });
  assert.equal(stats.tracked, 3, signature);
  // #18: this assertion used to read `write: true` -- "op-1 was evicted, so its retry is no
  // longer recognised as a duplicate". That pinned the defect as the contract. op-1 had
  // already been written to the PTY, so re-admitting its retry runs the command a second
  // time, which is the exact failure the ledger exists to prevent. Eviction may forget the
  // result; it must not forget that the operation happened.
  const evictedRetry = admissions(ledger, ['op-1'])[0];
  assert.equal(evictedRetry.write, false, signature);
  assert.equal(evictedRetry.outcome, 'expired', signature);
  // op-4 is still tracked, and a retry of it is a plain duplicate rather than an expiry.
  const trackedRetry = admissions(ledger, ['op-4'])[0];
  assert.equal(trackedRetry.write, false, signature);
  assert.equal(trackedRetry.outcome, 'duplicate', signature);
});

test('#18 an operation old enough to fall out of both sets is admitted again, and that bound is stated', () => {
  const signature = '#18: the tombstone set is bounded too; the window is a limit, not a secret';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });
  admissions(ledger, ['op-1', 'op-2']);
  // Two evictions push op-1 out of `operations` and then out of `expiredOperations`.
  admissions(ledger, ['op-3', 'op-4', 'op-5', 'op-6']);
  const stats = ledger.snapshot({ logicalClientId: CLIENT, sessionId: SESSION });
  assert.equal(stats.tracked, 2, signature);
  assert.equal(stats.expiredTracked, 2, signature);
  assert.equal(admissions(ledger, ['op-1'])[0].write, true, signature);
});

test('REL-BGSTAB-028 AC-4 input without an operation id is observably undeduplicated', () => {
  const signature = 'REL-BGSTAB-028 AC-4: legacy input must not be treated as if it carried an identifier';
  const ledger = createTerminalInputLedger();

  const first = admissions(ledger, [undefined])[0];
  const second = admissions(ledger, [undefined])[0];
  assert.equal(first.write, true, signature);
  assert.equal(first.outcome, 'unidentified', signature);
  assert.equal(second.write, true, 'legacy input must still reach the PTY', );
  assert.equal(second.outcome, 'unidentified', signature);

  const stats = ledger.snapshot({ logicalClientId: CLIENT, sessionId: SESSION });
  assert.equal(stats.unidentified, 2, signature);
  assert.equal(stats.tracked, 0, 'unidentified input must not occupy ledger capacity');
});

test('REL-BGSTAB-028 AC-1 sessions do not share an operation namespace', () => {
  const signature = 'REL-BGSTAB-028 AC-1: the same operation id in another session is a different operation';
  const ledger = createTerminalInputLedger();
  ledger.admit({ logicalClientId: CLIENT, sessionId: 'session-a', operationId: 'op-1' });
  const other = ledger.admit({ logicalClientId: CLIENT, sessionId: 'session-b', operationId: 'op-1' });
  assert.equal(other.write, true, signature);
});

test('#18 the same operation id with a different payload is refused as a mismatch, not silently swallowed', () => {
  const signature = '#18: a reused identifier carrying different bytes is a client bug, and a silent drop hides it';
  const ledger = createTerminalInputLedger();
  const first = ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1', payload: 'ls\r' });
  assert.equal(first.write, true, signature);
  assert.equal(first.outcome, 'admitted', signature);

  // The genuine retry -- same id, same bytes -- stays a plain duplicate.
  const retry = ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1', payload: 'ls\r' });
  assert.equal(retry.write, false, signature);
  assert.equal(retry.outcome, 'duplicate', signature);

  // Same id, different bytes. Treating this as a duplicate would drop a command the user
  // typed and report nothing; treating it as new would run the id twice.
  const mismatch = ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1', payload: 'rm -rf .\r' });
  assert.equal(mismatch.write, false, signature);
  assert.equal(mismatch.outcome, 'payload-mismatch', signature);
});

test('#18 an operation admitted without a payload still deduplicates, because the digest is optional', () => {
  const signature = '#18: the digest tightens the check where a payload is given; it must not weaken it where none is';
  const ledger = createTerminalInputLedger();
  assert.equal(ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1' }).outcome, 'admitted', signature);
  assert.equal(ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1' }).outcome, 'duplicate', signature);
  // A later send that does carry a payload cannot be compared against nothing, so it is a
  // duplicate rather than a fabricated mismatch.
  assert.equal(
    ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1', payload: 'x' }).outcome,
    'duplicate',
    signature,
  );
});

// --- #18 criterion 6/7: `unknown` is not a synonym for `expired` -------------------
//
// `expired` means "I hold a tombstone: this operation happened and I evicted its result."
// `unknown` means "this operation predates everything I still remember, so I cannot say
// whether it happened." Before this, the second case was SILENTLY RE-ADMITTED -- the
// ledger's own AC-5 evidence called that window "the honest limit of this design", and
// criterion 6 forbids exactly it: an uncertain retry must not silently re-execute.
//
// Ordering is what separates the two from a brand-new operation, and the sequencer already
// has it. The operation id is left opaque to the ledger; the ordinal arrives as its own
// field instead, which is also what criterion 2 asks for.

function admitSequenced(
  ledger: ReturnType<typeof createTerminalInputLedger>,
  operationId: string,
  sequencerEpoch: number,
  start: number,
): TerminalInputAdmission {
  return ledger.admit({
    logicalClientId: CLIENT,
    sessionId: SESSION,
    operationId,
    sequence: { epoch: sequencerEpoch, start },
  });
}

test('#18 a retry older than everything remembered is refused as unknown, not re-executed', () => {
  const signature = '#18 criterion 6: an uncertain retry must not silently re-execute';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });

  admitSequenced(ledger, 'e1:1-1', 1, 1);
  admitSequenced(ledger, 'e1:2-2', 1, 2);
  // Four more push e1:1-1 out of `operations` and then out of the tombstone set.
  for (const n of [3, 4, 5, 6]) admitSequenced(ledger, `e1:${n}-${n}`, 1, n);

  const retry = admitSequenced(ledger, 'e1:1-1', 1, 1);

  assert.equal(retry.write, false, signature);
  assert.equal(retry.outcome, 'unknown', signature);
});

test('#18 unknown is distinct from expired, which still means a tombstone hit', () => {
  const signature = '#18 criterion 7: the two refusals are different facts and must not be merged';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });

  admitSequenced(ledger, 'e1:1-1', 1, 1);
  admitSequenced(ledger, 'e1:2-2', 1, 2);
  // One more eviction: e1:1-1 is now a tombstone, not yet forgotten.
  admitSequenced(ledger, 'e1:3-3', 1, 3);

  const tombstoned = admitSequenced(ledger, 'e1:1-1', 1, 1);

  assert.equal(tombstoned.outcome, 'expired', signature);
  assert.equal(tombstoned.write, false, signature);
});

test('#18 forgetting old operations does not refuse genuinely new ones', () => {
  const signature = '#18: the watermark must not swallow new input -- that would break the terminal';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });

  for (const n of [1, 2, 3, 4, 5, 6]) admitSequenced(ledger, `e1:${n}-${n}`, 1, n);
  // The sequencer is monotonic within an epoch, so a new operation is always above
  // anything forgotten.
  const fresh = admitSequenced(ledger, 'e1:7-7', 1, 7);

  assert.equal(fresh.write, true, signature);
  assert.equal(fresh.outcome, 'admitted', signature);
});

test('#18 a new sequencer epoch restarts at 1 without being mistaken for a forgotten operation', () => {
  const signature = '#18: the watermark is per sequencer epoch, because reset(1) restarts numbering';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });

  for (const n of [1, 2, 3, 4, 5, 6]) admitSequenced(ledger, `e1:${n}-${n}`, 1, n);
  // A session re-attach bumps the sequencer epoch and restarts the count at 1. Without
  // per-epoch watermarks this first keystroke after a re-attach would be refused.
  const reattached = admitSequenced(ledger, 'e2:1-1', 2, 1);

  assert.equal(reattached.write, true, signature);
  assert.equal(reattached.outcome, 'admitted', signature);
});

test('#18 without ordering information the legacy re-admission behaviour is unchanged', () => {
  const signature = '#18: a client that cannot order its operations gets the old behaviour, visibly';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });

  admissions(ledger, ['op-1', 'op-2', 'op-3', 'op-4', 'op-5', 'op-6']);
  // Boundary: no `sequence`, so the ledger cannot prove the retry is old. It is admitted,
  // exactly as before this change, rather than being refused on a guess.
  const retry = admissions(ledger, ['op-1'])[0];

  assert.equal(retry.write, true, signature);
  assert.equal(retry.outcome, 'admitted', signature);
});

test('#18 unknown refusals are counted separately in the snapshot', () => {
  const signature = '#18 criterion 7: the state has to be traceable, not just returned once';
  const ledger = createTerminalInputLedger({ maxOperationsPerSession: 2 });

  for (const n of [1, 2, 3, 4, 5, 6]) admitSequenced(ledger, `e1:${n}-${n}`, 1, n);
  admitSequenced(ledger, 'e1:1-1', 1, 1);

  const stats = ledger.snapshot({ logicalClientId: CLIENT, sessionId: SESSION });
  assert.equal(stats.unknown, 1, signature);
  assert.equal(stats.expired, 0, signature);
});

// --- #111 / #18 criterion 11: the dedup record outlives the socket ----------------
//
// THE DEFECT THIS CLOSES. The ledger was keyed by `meta.connectionId`, a fresh uuid per
// socket, and the disconnect handler called releaseEpoch on it. A real reconnect therefore
// met an EMPTY ledger and a resent operation was admitted and written to the PTY a second
// time -- the exact duplicate-execution symptom #18 opens with.
//
// It was invisible because the test covering AC-2 was titled "a replay after reconnect ON
// THE SAME EPOCH" and its own comment said the client "reconnects on the same connection
// epoch". Deduplicating twice within one epoch is AC-1's property, not AC-2's, so the case
// passed while the contract it named went untested.
//
// AC-3 said "a new connection epoch must not reuse the previous epoch's ledger", which is
// the defect written down as a requirement. Isolation belongs between logical CLIENTS, not
// between connections of one client.

test('#111 AC-2 a resend after the connection changes is still deduplicated', () => {
  const signature = '#111: the dedup record must survive a reconnect, or AC-2 is untestable';
  const ledger = createTerminalInputLedger();

  // Send, lose the ACK, reconnect (new socket, new connectionId), resend. The logical
  // client is the same tab throughout, and that is what the ledger is keyed by.
  assert.equal(ledger.admit({
    logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1',
  }).write, true, signature);

  const afterReconnect = ledger.admit({
    logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1',
  });

  assert.equal(afterReconnect.write, false, signature);
  assert.equal(afterReconnect.outcome, 'duplicate', signature);
});

test('#111 AC-2 a genuinely new operation after a reconnect still runs', () => {
  const signature = '#111: preserving the record must not freeze the terminal after reconnect';
  const ledger = createTerminalInputLedger();
  ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1' });

  const fresh = ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-2' });

  assert.equal(fresh.write, true, signature);
  assert.equal(fresh.outcome, 'admitted', signature);
});

test('#111 criterion 11 the record is released by its own TTL, not by socket loss', () => {
  const signature = '#111: a preserved record needs a bound of its own or it never expires';
  let now = 1_000;
  const ledger = createTerminalInputLedger({ ttlMs: 500, now: () => now });
  ledger.admit({ logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1' });

  // Inside the TTL the retry is still recognised.
  now = 1_400;
  assert.equal(ledger.admit({
    logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1',
  }).outcome, 'duplicate', signature);

  // Past it the record is gone. Without ordering the ledger cannot prove the operation is
  // old, so it is admitted -- the same honest fallback as the unsequenced path.
  now = 2_500;
  assert.equal(ledger.admit({
    logicalClientId: CLIENT, sessionId: SESSION, operationId: 'op-1',
  }).write, true, signature);
});

test('#111 criterion 11 an expired record with ordering is refused as unknown, not re-run', () => {
  const signature = '#111: TTL expiry must not become a second silent-re-execute path';
  let now = 1_000;
  const ledger = createTerminalInputLedger({ ttlMs: 500, now: () => now });
  ledger.admit({
    logicalClientId: CLIENT, sessionId: SESSION, operationId: 'e1:1-1',
    sequence: { epoch: 1, start: 1 },
  });

  now = 2_500;
  const afterTtl = ledger.admit({
    logicalClientId: CLIENT, sessionId: SESSION, operationId: 'e1:1-1',
    sequence: { epoch: 1, start: 1 },
  });

  // The TTL is a bound on memory, not a licence to re-run a command whose fate is unknown.
  assert.equal(afterTtl.write, false, signature);
  assert.equal(afterTtl.outcome, 'unknown', signature);
});

test('#111 criterion 11 releasing the logical client frees every session it held', () => {
  const signature = '#111: retirement and session close are the other two release points';
  const ledger = createTerminalInputLedger();
  ledger.admit({ logicalClientId: CLIENT, sessionId: 'session-a', operationId: 'op-1' });
  ledger.admit({ logicalClientId: CLIENT, sessionId: 'session-b', operationId: 'op-1' });

  assert.equal(ledger.releaseLogicalClient(CLIENT), 2, signature);
  assert.equal(ledger.releaseLogicalClient(CLIENT), 0, 'a second release frees nothing');
  assert.equal(ledger.admit({
    logicalClientId: CLIENT, sessionId: 'session-a', operationId: 'op-1',
  }).write, true, signature);
});
