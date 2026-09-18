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

const EPOCH = 'epoch-1';
const SESSION = 'session-a';

function admissions(ledger: ReturnType<typeof createTerminalInputLedger>, ids: (string | undefined)[]): TerminalInputAdmission[] {
  return ids.map((operationId) => ledger.admit({
    connectionEpoch: EPOCH,
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

  const stats = ledger.snapshot({ connectionEpoch: EPOCH, sessionId: SESSION });
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

test('REL-BGSTAB-028 AC-3 a new connection epoch does not inherit the previous ledger', () => {
  const signature = 'REL-BGSTAB-028 AC-3: a new connectionEpoch must not reuse the previous epoch backlog';
  const ledger = createTerminalInputLedger();
  ledger.admit({ connectionEpoch: 'epoch-1', sessionId: SESSION, operationId: 'op-1' });

  const fresh = ledger.admit({ connectionEpoch: 'epoch-2', sessionId: SESSION, operationId: 'op-1' });
  assert.equal(fresh.write, true, signature);
  assert.equal(fresh.outcome, 'admitted', signature);
});

test('REL-BGSTAB-028 AC-3 release frees the ledger exactly once', () => {
  const signature = 'REL-BGSTAB-028 AC-3: session end must release the ledger exactly once';
  const ledger = createTerminalInputLedger();
  admissions(ledger, ['op-1', 'op-2']);

  assert.equal(ledger.release({ connectionEpoch: EPOCH, sessionId: SESSION }), true, signature);
  assert.equal(
    ledger.release({ connectionEpoch: EPOCH, sessionId: SESSION }),
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

  const stats = ledger.snapshot({ connectionEpoch: EPOCH, sessionId: SESSION });
  assert.equal(stats.tracked, 3, signature);
  // op-1 was evicted, so its retry is no longer recognised as a duplicate.
  assert.equal(admissions(ledger, ['op-1'])[0].write, true, signature);
  // op-4 is still tracked.
  assert.equal(admissions(ledger, ['op-4'])[0].write, false, signature);
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

  const stats = ledger.snapshot({ connectionEpoch: EPOCH, sessionId: SESSION });
  assert.equal(stats.unidentified, 2, signature);
  assert.equal(stats.tracked, 0, 'unidentified input must not occupy ledger capacity');
});

test('REL-BGSTAB-028 AC-1 sessions do not share an operation namespace', () => {
  const signature = 'REL-BGSTAB-028 AC-1: the same operation id in another session is a different operation';
  const ledger = createTerminalInputLedger();
  ledger.admit({ connectionEpoch: EPOCH, sessionId: 'session-a', operationId: 'op-1' });
  const other = ledger.admit({ connectionEpoch: EPOCH, sessionId: 'session-b', operationId: 'op-1' });
  assert.equal(other.write, true, signature);
});
