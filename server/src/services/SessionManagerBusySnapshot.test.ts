import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeadlessTerminalState } from '../utils/headlessTerminal.js';
import { SessionManager } from './SessionManager.js';

/**
 * An atomic restore snapshot must be refusable only while the headless buffer
 * and `screenSeq` can disagree.
 *
 * They can disagree in exactly one window: `applyHeadlessOutput` writes into
 * the buffer and only afterwards raises `screenSeq`. Between those two the
 * buffer is ahead of its sequence, and a snapshot taken there would claim to
 * cover output it does not contain.
 *
 * Merely *queued* writes are not that window. Each PTY chunk raises
 * `pendingHeadlessWrites` on arrival and lowers it in a `.finally()` on the
 * write chain, so a session producing continuous output holds the counter above
 * zero almost always while the buffer sits consistent between chain links.
 * Refusing on the counter therefore refuses busy sessions permanently rather
 * than briefly — and the caller above reads that refusal as the session being
 * unrestorable.
 */

interface SessionDataForTest {
  pendingHeadlessWrites: number;
  headlessApplyInFlight: number;
  headlessHealth: string;
  headless: unknown;
  parserTailOverflow: boolean;
}

interface ManagerInternals {
  sessions: Map<string, SessionDataForTest>;
  getAtomicRestoreSnapshot: (sessionId: string) => { ok: boolean; reason?: string };
}

const SESSION_ID = 'busy-session';

/**
 * A session whose headless model is healthy and quiescent. The fields the
 * snapshot reads are asserted to exist with the expected runtime shape, so a
 * rename cannot leave this test passing against nothing.
 */
function managerWithSession(overrides: Partial<SessionDataForTest>): ManagerInternals {
  const manager = new SessionManager() as unknown as ManagerInternals;
  assert.ok(manager.sessions instanceof Map, 'SessionManager.sessions is no longer a Map');
  assert.equal(
    typeof manager.getAtomicRestoreSnapshot,
    'function',
    'SessionManager.getAtomicRestoreSnapshot is gone',
  );

  const data = {
    pendingHeadlessWrites: 0,
    headlessApplyInFlight: 0,
    headlessHealth: 'healthy',
    parserTailOverflow: false,
    headless: makeHeadlessStub(),
    authorityRevision: 1,
    screenSeq: 1,
    parserComplete: true,
    pendingEscapeTailAnsi: '',
    authorityEpoch: 'epoch-1',
    cols: 80,
    rows: 24,
    windowsPty: undefined,
    ...overrides,
  } as unknown as SessionDataForTest;
  manager.sessions.set(SESSION_ID, data);

  const stored = manager.sessions.get(SESSION_ID)!;
  assert.equal(typeof stored.pendingHeadlessWrites, 'number', 'pendingHeadlessWrites is not a number');
  assert.equal(
    typeof stored.headlessApplyInFlight,
    'number',
    'headlessApplyInFlight is not a number — the queued/applying distinction is gone',
  );
  return manager;
}

/** A real state: a stub would fail serialization and be indistinguishable
 * from the refusal these tests are trying to tell apart. */
function makeHeadlessStub(): unknown {
  return createHeadlessTerminalState({ cols: 24, rows: 4, scrollbackLines: 100 });
}

test('a write in flight refuses the snapshot', () => {
  const manager = managerWithSession({ headlessApplyInFlight: 1, pendingHeadlessWrites: 1 });
  const result = manager.getAtomicRestoreSnapshot(SESSION_ID);
  assert.equal(result.ok, false, 'a half-applied write produced a snapshot');
  assert.equal(result.reason, 'generation-failed');
});

test('queued writes alone do not refuse the snapshot', () => {
  const manager = managerWithSession({ headlessApplyInFlight: 0, pendingHeadlessWrites: 7 });
  const result = manager.getAtomicRestoreSnapshot(SESSION_ID);
  assert.notEqual(
    result.reason,
    'generation-failed',
    'a busy session was refused for writes that had not started applying',
  );
});

test('a parser tail overflow still refuses the snapshot', () => {
  const manager = managerWithSession({ parserTailOverflow: true });
  const result = manager.getAtomicRestoreSnapshot(SESSION_ID);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generation-failed');
});

test('a degraded headless model still refuses the snapshot', () => {
  const manager = managerWithSession({ headlessHealth: 'degraded' });
  const result = manager.getAtomicRestoreSnapshot(SESSION_ID);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'headless-degraded');
});
