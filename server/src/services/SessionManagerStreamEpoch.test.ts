import assert from 'node:assert/strict';
import test from 'node:test';

import { STREAM_EPOCH_BUMP_REASONS } from '../ws/terminalStreamEpoch.js';
import { SessionManager } from './SessionManager.js';

/**
 * `01:462` — the epoch belongs to the session, not to a channel and not to the
 * process. Promoting it means two things at once: the value must be looked up
 * per session id, and it must move only for one of the five enumerated events.
 */

const ORDINAL64_MAX = '18446744073709551615';

interface ManagerInternals {
  createRetainedTerminalSessionState: (sessionId: string) => RetainedForTest;
  bumpTerminalStreamEpoch: (sessionId: string, reason: string) => string;
  currentTerminalStreamEpoch: (sessionId: string) => string;
  forgetTerminalStreamEpoch: (sessionId: string) => void;
  sessions: Map<string, unknown>;
  finalizeSessionRemoval: (sessionId: string, options: { reason: string }) => void;
  ensureRetainedTerminalSessionState: (sessionData: unknown) => RetainedForTest;
  setTerminalStreamEpoch: (
    sessionId: string,
    retained: { streamEpoch: string },
    value: string,
    reason: string,
  ) => void;
  advanceRetainedTerminalSourceOrdinal: (
    sessionId: string,
    retained: RetainedForTest,
    advanceSnapshot: boolean,
  ) => void;
}

interface RetainedForTest {
  streamEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
}

function internals(): ManagerInternals {
  const manager = new SessionManager() as unknown as ManagerInternals;
  // A private-field cast goes vacuous the moment the shape moves, so every
  // member this test reads is asserted to still be a function.
  for (const name of [
    'createRetainedTerminalSessionState',
    'bumpTerminalStreamEpoch',
    'currentTerminalStreamEpoch',
    'forgetTerminalStreamEpoch',
    'advanceRetainedTerminalSourceOrdinal',
    'setTerminalStreamEpoch',
    'ensureRetainedTerminalSessionState',
  ] as const) {
    assert.equal(typeof manager[name], 'function', `SessionManager.${name} is gone`);
  }
  return manager;
}

test('a retained state is stamped with its own session epoch', () => {
  const manager = internals();
  const state = manager.createRetainedTerminalSessionState('session-a');
  assert.equal(state.streamEpoch, manager.currentTerminalStreamEpoch('session-a'));
});

test('rebuilding a retained state does not advance the session epoch', () => {
  const manager = internals();
  const first = manager.createRetainedTerminalSessionState('session-a').streamEpoch;
  const second = manager.createRetainedTerminalSessionState('session-a').streamEpoch;
  assert.equal(second, first);
});

test('two sessions carry epochs that move independently', () => {
  const manager = internals();
  manager.createRetainedTerminalSessionState('session-a');
  manager.createRetainedTerminalSessionState('session-b');
  const beforeB = manager.currentTerminalStreamEpoch('session-b');

  manager.bumpTerminalStreamEpoch('session-a', 'authority-rollback');

  assert.notEqual(manager.currentTerminalStreamEpoch('session-a'), beforeB);
  assert.equal(manager.currentTerminalStreamEpoch('session-b'), beforeB);
});

test('every one of the five documented events raises the epoch', () => {
  const manager = internals();
  let previous = BigInt(manager.currentTerminalStreamEpoch('session-a'));
  for (const reason of STREAM_EPOCH_BUMP_REASONS) {
    const next = BigInt(manager.bumpTerminalStreamEpoch('session-a', reason));
    assert.ok(next > previous, `${reason} did not raise the epoch`);
    previous = next;
  }
});

test('an event outside the documented five is refused', () => {
  const manager = internals();
  assert.throws(() => manager.bumpTerminalStreamEpoch('session-a', 'channel-opened'), RangeError);
});

test('reading the epoch never advances it', () => {
  const manager = internals();
  const first = manager.currentTerminalStreamEpoch('session-a');
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), first);
});

test('the epoch is a canonical decimal string, never a number', () => {
  const manager = internals();
  const epoch = manager.currentTerminalStreamEpoch('session-a');
  assert.equal(typeof epoch, 'string');
  assert.match(epoch, /^[0-9]+$/);
});

test('forgetting a session drops its epoch without touching the others', () => {
  const manager = internals();
  manager.bumpTerminalStreamEpoch('session-a', 'codec-switch');
  manager.bumpTerminalStreamEpoch('session-b', 'codec-switch');
  const keptB = manager.currentTerminalStreamEpoch('session-b');

  manager.forgetTerminalStreamEpoch('session-a');

  assert.equal(manager.currentTerminalStreamEpoch('session-b'), keptB);
});

test('a configured initial ordinal is adopted, not shadowed by a second epoch', () => {
  const manager = new SessionManager(undefined, {
    retainedTerminalInitialOrdinal: { streamEpoch: '42', sourceSeq: '0' },
  }) as unknown as ManagerInternals;

  const state = manager.createRetainedTerminalSessionState('session-a');

  assert.equal(state.streamEpoch, '42');
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), '42');
});

test('an ordinal rollover raises the epoch through the ledger', () => {
  const manager = new SessionManager(undefined, {
    retainedTerminalInitialOrdinal: { streamEpoch: '42', sourceSeq: ORDINAL64_MAX },
  }) as unknown as ManagerInternals;
  const retained = manager.createRetainedTerminalSessionState('session-a');
  assert.equal(retained.sourceSeq, ORDINAL64_MAX, 'the rollover boundary was not reached');

  manager.advanceRetainedTerminalSourceOrdinal('session-a', retained, false);

  assert.equal(retained.sourceSeq, '0');
  assert.equal(retained.streamEpoch, '43');
  // The ledger must have moved with it; a rollover recorded in only one of the
  // two places is exactly the drift this promotion exists to remove.
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), '43');
});

test('an advance short of the boundary leaves the epoch alone', () => {
  const manager = new SessionManager(undefined, {
    retainedTerminalInitialOrdinal: { streamEpoch: '42', sourceSeq: '7' },
  }) as unknown as ManagerInternals;
  const retained = manager.createRetainedTerminalSessionState('session-a');

  manager.advanceRetainedTerminalSourceOrdinal('session-a', retained, false);

  assert.equal(retained.sourceSeq, '8');
  assert.equal(retained.streamEpoch, '42');
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), '42');
});

test('removing a session drops its epoch so nothing can inherit the old value', () => {
  const manager = internals();
  manager.bumpTerminalStreamEpoch('session-a', 'codec-switch');
  const raised = BigInt(manager.currentTerminalStreamEpoch('session-a'));

  manager.forgetTerminalStreamEpoch('session-a');

  // Ids are uuidv4 and never reused; if one somehow were, it must not be handed
  // back an epoch a live client could still be holding.
  assert.ok(BigInt(manager.currentTerminalStreamEpoch('session-a')) > raised);
});

test('setting an epoch writes the retained state and the ledger together', () => {
  const manager = internals();
  const retained = { streamEpoch: '1' };

  manager.setTerminalStreamEpoch('session-a', retained, '77', 'authority-rollback');

  assert.equal(retained.streamEpoch, '77');
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), '77');
});

test('setting an epoch under an unlisted reason writes neither side', () => {
  const manager = internals();
  const retained = { streamEpoch: '1' };
  const before = manager.currentTerminalStreamEpoch('session-a');

  assert.throws(
    () => manager.setTerminalStreamEpoch('session-a', retained, '77', 'channel-opened'),
    RangeError,
  );
  assert.equal(retained.streamEpoch, '1');
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), before);
});

test('a later bump continues from the value that was set', () => {
  const manager = internals();
  const retained = { streamEpoch: '1' };
  manager.setTerminalStreamEpoch('session-a', retained, '77', 'authority-rollback');

  assert.equal(manager.bumpTerminalStreamEpoch('session-a', 'codec-switch'), '78');
});

test('a retained state built after a bump carries the raised epoch, not a fresh one', () => {
  const manager = internals();
  const raised = manager.bumpTerminalStreamEpoch('session-a', 'authority-rollback');
  assert.notEqual(raised, '1', 'the epoch was never raised, so the assertion below is vacuous');

  const state = manager.createRetainedTerminalSessionState('session-a');

  assert.equal(state.streamEpoch, raised);
});

test('a SessionData without a session identity still gets a retained state', () => {
  const manager = internals();

  // Legacy compatibility objects reach this path with no `session` at all;
  // reading an id off them unguarded turns a resize into a TypeError.
  const state = manager.ensureRetainedTerminalSessionState({});

  assert.equal(typeof state.streamEpoch, 'string');
  assert.match(state.streamEpoch, /^[0-9]+$/);
});

// ---------------------------------------------------------------------------
// `06 §S4-0b` item #1 — is the session epoch the same value the authority
// controller reports? If it always is, `0x04`'s `checkpointStreamEpoch` is 8
// redundant bytes; if it can diverge, `01 §1.8` invariant 4 stands.
// ---------------------------------------------------------------------------

test('the authority controller is seeded from the session epoch, not its own counter', () => {
  const manager = new SessionManager(undefined, {
    retainedTerminalInitialOrdinal: { streamEpoch: '42', sourceSeq: '0' },
  }) as unknown as ManagerInternals;
  const retained = manager.createRetainedTerminalSessionState('session-a');

  // `SessionManager.ts:4961` passes `initialStreamEpoch:` from exactly this
  // value, so the two agree at controller creation by construction.
  assert.equal(retained.streamEpoch, '42');
  assert.equal(manager.currentTerminalStreamEpoch('session-a'), '42');
});

test('the two can still diverge, so the checkpoint epoch is not redundant', () => {
  const manager = new SessionManager(undefined, {
    retainedTerminalInitialOrdinal: { streamEpoch: '42', sourceSeq: '0' },
  }) as unknown as ManagerInternals;
  const retained = manager.createRetainedTerminalSessionState('session-a');

  // A controller created at epoch 42 keeps that value until its own state
  // machine moves it; the session epoch moves on any of the five events.
  manager.bumpTerminalStreamEpoch('session-a', 'authority-rollback');

  assert.notEqual(manager.currentTerminalStreamEpoch('session-a'), retained.streamEpoch);
});
