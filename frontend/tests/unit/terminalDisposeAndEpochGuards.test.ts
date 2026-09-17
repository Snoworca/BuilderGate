// Issue #10 AC-11 (dispose releases queue, timers and the in-flight write
// callback; a late callback is a no-op) and AC-6(i) (a live frame from an older
// stream epoch is discarded), against FR-BGSTAB-022 AC-4 and AC-6.
//
// PRODUCTION WAS ALREADY CORRECT FOR EVERY CLAUSE BELOW. These are guards, not
// bug fixes, and nothing here changed behaviour — do not read a later failure
// as a regression introduced alongside them. What was missing was coverage:
// all three committed `dispose` dispatch sites reach dispose with an empty
// queue and nothing in flight, so the release clauses were never exercised,
// and no test dispatched a live frame at a strictly lower stream epoch.
//
// Measured before these tests existed (2026-09-18): dispose with three queued
// mutations, one in flight and one live timer settles all three exactly once as
// `disposed`, clears the timer, and a callback arriving afterwards adds nothing.
//
// The factory is reached through the terminalOutputScheduler re-export, which is
// how the coordinator's own primary suite reaches it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as terminalOutputSchedulerModule from '../../src/utils/terminalOutputScheduler.ts';

type WriteKind = 'live' | 'checkpoint' | 'repair' | 'parser-tail';

const LIMITS = {
  postCheckpointMaxBytes: 1024 * 1024,
  postCheckpointMaxChunks: 1024,
  checkpointMaxBytes: 1024 * 1024,
  checkpointMaxChunks: 1024,
  pendingInputMaxBytes: 1024 * 1024,
  pendingInputMaxCount: 1024,
  pendingInputTtlMs: 60_000,
  settlementLedgerMaxEntries: 1024,
  settlementLedgerTtlMs: 60_000,
};

function harness() {
  const events: WriteKind[] = [];
  const recoveries: string[] = [];
  const settlements: Array<{ token: string; outcome: string }> = [];
  const held: Array<() => void> = [];
  let timersCreated = 0;
  let timersCleared = 0;
  const adapter = {
    // Never completes synchronously: one write stays in flight, which is the
    // only state in which dispose has an in-flight callback to release.
    write: (command: { kind: WriteKind }, onWritten: () => void) => {
      events.push(command.kind);
      held.push(onWritten);
    },
    resetParser: () => {},
    resize: () => {},
    applyModes: () => {},
    clearScreen: () => {},
    fit: () => ({ cols: 80, rows: 24 }),
    setWindowsPty: () => {},
    markReady: () => {},
    releaseInput: () => {},
    settleInput: (token: string, outcome: string) => { settlements.push({ token, outcome }); },
    requestFreshRecovery: (reason: string) => { recoveries.push(reason); },
    requestRuntimeRecreation: () => {},
    compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {},
    checkpointDrained: () => {},
    settle: (token: string, outcome: string) => { settlements.push({ token, outcome }); },
  };
  const factory = (terminalOutputSchedulerModule as Record<string, unknown>)
    .createTerminalWriteCoordinator as (options: Record<string, unknown>) => {
      dispatch(command: Record<string, unknown>): { accepted: boolean; reason?: string };
      getState(): { pendingCommands: number; disposed: boolean; writeInFlight: boolean };
    };
  const coordinator = factory({
    viewGeneration: 7,
    adapter,
    digestBytes: () => 'd'.repeat(16),
    setTimer: (callback: () => void) => { timersCreated += 1; return { callback }; },
    clearTimer: () => { timersCleared += 1; },
    ...LIMITS,
  });
  return {
    coordinator, events, recoveries, settlements, held,
    get timersCreated() { return timersCreated; },
    get timersCleared() { return timersCleared; },
  };
}

const live = (overrides: Record<string, unknown>) => ({
  type: 'live',
  streamEpoch: '1',
  viewGeneration: 7,
  data: new Uint8Array(8),
  ...overrides,
});

test('FR-BGSTAB-022 AC-6 — dispose releases the queue, the timer and the in-flight write callback', () => {
  const signature = 'dispose left coordinator state held';
  const h = harness();

  // Three mutations: the first goes in flight, the other two queue behind it.
  h.coordinator.dispatch(live({ sourceSeq: '1', settlementToken: 'in-flight' }));
  h.coordinator.dispatch(live({ sourceSeq: '2', settlementToken: 'queued-1' }));
  h.coordinator.dispatch(live({ sourceSeq: '3', settlementToken: 'queued-2' }));

  // The precondition is the point of this test. If it ever stops holding, the
  // assertions below become vacuous rather than false, so assert it explicitly.
  const before = h.coordinator.getState();
  assert.equal(before.pendingCommands, 3, `${signature}: precondition — three retained`);
  assert.equal(before.writeInFlight, true, `${signature}: precondition — one in flight`);
  assert.ok(h.timersCreated > 0, `${signature}: precondition — a timer is outstanding`);
  assert.equal(h.timersCleared, 0, signature);

  assert.equal(h.coordinator.dispatch({ type: 'dispose', viewGeneration: 7 }).accepted, true, signature);

  const after = h.coordinator.getState();
  assert.equal(after.pendingCommands, 0, `${signature}: AC-11(i) queue not released`);
  assert.equal(after.disposed, true, signature);
  assert.ok(h.timersCleared > 0, `${signature}: AC-11(ii) timer not cleared`);

  // AC-11(i) and (iii): every retained token settles exactly once, as `disposed`.
  const byToken = new Map<string, string[]>();
  for (const entry of h.settlements) {
    byToken.set(entry.token, [...(byToken.get(entry.token) ?? []), entry.outcome]);
  }
  for (const token of ['in-flight', 'queued-1', 'queued-2']) {
    assert.deepEqual(
      byToken.get(token),
      ['disposed'],
      `${signature}: ${token} must settle exactly once as disposed`,
    );
  }
});

// CHARACTERIZATION, NOT A GUARD — this test cannot fail, and that is recorded
// deliberately rather than discovered later.
//
// The property is true: a callback arriving after dispose changes nothing
// observable. But mutation testing shows no defect this test can detect.
// Measured 2026-09-18 against `terminalWriteCoordinator.ts`:
//   - deleting the `disposed` term from the onWritten fence  -> still green
//   - weakening the `activeMutation !== mutation` early return -> still green
//   - deleting BOTH guards as a group                         -> still green
// The group deletion is the decisive one: it separates "a redundant sibling
// enforces this" from "nothing does", and it rules the first out. The cause is
// that dispose has already drained the queue, nulled `activeMutation` and
// settled every token, so by the time a late callback arrives there is nothing
// left for it to disturb — `settleOnce` is idempotent and `pump()` returns
// early on a disposed coordinator. AC-11(iv) is therefore not falsifiable
// through the public surface on the dispose path.
//
// It is kept because the measurement is worth having and deleting it would also
// delete the record that the question was asked. Do not count it as coverage,
// and do not treat a future green here as evidence the fence works.
test('FR-BGSTAB-022 AC-6 — characterization: a post-dispose write callback changes nothing observable (non-discriminating)', () => {
  const signature = 'a late callback mutated a disposed coordinator';
  const h = harness();
  h.coordinator.dispatch(live({ sourceSeq: '1', settlementToken: 'in-flight' }));
  h.coordinator.dispatch(live({ sourceSeq: '2', settlementToken: 'queued-1' }));
  h.coordinator.dispatch({ type: 'dispose', viewGeneration: 7 });

  const settlementsAtDispose = h.settlements.length;
  const eventsAtDispose = h.events.length;
  assert.ok(h.held.length > 0, `${signature}: precondition — a callback is outstanding`);

  // The adapter never invoked this; it is the late arrival dispose must absorb.
  h.held.shift()?.();

  assert.equal(h.settlements.length, settlementsAtDispose, `${signature}: it settled again`);
  assert.equal(h.events.length, eventsAtDispose, `${signature}: it reached xterm`);
  assert.equal(h.coordinator.getState().pendingCommands, 0, signature);
});

test('FR-BGSTAB-022 AC-4 — a live frame from an older stream epoch is discarded', () => {
  const signature = 'an older-epoch live frame was admitted';
  const h = harness();
  const begin = {
    type: 'checkpoint-begin',
    streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10', snapshotSeq: '10',
    oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
    chunkCount: 1, encodedByteTotal: 8, digest: 'd'.repeat(16),
    cols: 80, rows: 24, modes: {}, parserTail: new Uint8Array(0),
  };
  h.coordinator.dispatch(begin);
  h.coordinator.dispatch({
    ...begin, type: 'checkpoint-chunk', index: 0, count: 1, data: new Uint8Array(8),
  });
  h.coordinator.dispatch({ ...begin, type: 'checkpoint-commit' });

  // Control first. Without an arm that is ACCEPTED at the adopted epoch, a
  // rejection below could equally mean the checkpoint never committed — which
  // is exactly how the first draft of this probe gave a false reading, both
  // arms returning `recovery-required` and discriminating nothing.
  const control = h.coordinator.dispatch(live({ streamEpoch: '1', sourceSeq: '11', settlementToken: 'control' }));
  assert.equal(control.accepted, true, `${signature}: control — same epoch must be admitted`);

  const subject = h.coordinator.dispatch(live({ streamEpoch: '0', sourceSeq: '12', settlementToken: 'subject' }));
  assert.equal(subject.accepted, false, signature);
  assert.equal(subject.reason, 'stale-stream-epoch', `${signature}: rejected, but not for being stale`);
});
