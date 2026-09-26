// Issue #10 AC-4: the frame CPU budget and the input yield must apply to the
// checkpoint write lane, not only to the live visible-output lane.
//
// Measured before this contract existed (2026-09-18): a 131072-byte body
// produced exactly 5 physical writes whether each write cost 0 ms or 1000 ms of
// simulated clock, while a control confirmed the two arms genuinely differed in
// elapsed time. The write count was a pure function of body size; no deadline
// and no yield reached the lane.
//
// The failure mode this change risks is a hung or torn terminal rather than a
// red test — a yield that schedules no resumption. THESE tests are the guard for
// it, because they are the only ones that enable pacing and therefore the only
// ones that enter `deferCheckpointFrame`: every arm asserts
// `pendingCommands === 0` after quiescence, including when the yield predicate
// or the scheduler throws. terminalSnapshotLiveHandoverIntegrity guards the
// UNPACED lane and cannot reach this branch — an earlier note here said it
// could, which was wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as terminalOutputSchedulerModule from '../../src/utils/terminalOutputScheduler.ts';

type WriteKind = 'live' | 'checkpoint' | 'repair' | 'parser-tail';

const SLICE = 32 * 1024;
const BODY = SLICE * 4;
const encoder = new TextEncoder();

function harness(options: Record<string, unknown>) {
  let clock = 0;
  let msPerWrite = 0;
  const kinds: WriteKind[] = [];
  const held: Array<() => void> = [];
  const deferred: Array<() => void> = [];
  const adapter = {
    write: (command: { kind: WriteKind }, onWritten: () => void) => {
      kinds.push(command.kind);
      clock += msPerWrite;
      held.push(onWritten);
    },
    resetParser: () => {}, resize: () => {}, applyModes: () => {}, clearScreen: () => {},
    fit: () => ({ cols: 80, rows: 24 }), setWindowsPty: () => {}, markReady: () => {},
    releaseInput: () => {}, settleInput: () => {}, requestFreshRecovery: () => {},
    requestRuntimeRecreation: () => {}, compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {}, checkpointDrained: () => {}, settle: () => {},
  };
  const factory = (terminalOutputSchedulerModule as Record<string, unknown>)
    .createTerminalWriteCoordinator as (o: Record<string, unknown>) => {
      dispatch(c: Record<string, unknown>): { accepted: boolean; reason?: string };
      getState(): { ready: boolean; pendingCommands: number };
    };
  const coordinator = factory({
    viewGeneration: 7, adapter, digestBytes: () => 'dig',
    now: () => clock,
    // A deferred continuation is a timer with delay 0. Capturing them separately
    // from the write callbacks is what lets a test tell "paced" from "stalled".
    setTimer: (callback: () => void, delayMs: number) => {
      if (delayMs === 0) { deferred.push(callback); return { deferred: true }; }
      return { deferred: false };
    },
    clearTimer: () => {},
    postCheckpointMaxBytes: 1 << 24, postCheckpointMaxChunks: 8192,
    checkpointMaxBytes: 1 << 24, checkpointMaxChunks: 8192,
    pendingInputMaxBytes: 1 << 20, pendingInputMaxCount: 1024, pendingInputTtlMs: 60_000,
    settlementLedgerMaxEntries: 8192, settlementLedgerTtlMs: 60_000,
    ...options,
  });
  return {
    coordinator, kinds, held, deferred,
    setCostPerWrite: (ms: number) => { msPerWrite = ms; },
    get clock() { return clock; },
  };
}

function submitCheckpoint(h: ReturnType<typeof harness>, body: Uint8Array): void {
  const base = {
    streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10', snapshotSeq: '10',
    oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
    chunkCount: 1, encodedByteTotal: body.byteLength, digest: 'dig',
    cols: 80, rows: 24, modes: {}, parserTail: new Uint8Array(0),
  };
  h.coordinator.dispatch({ ...base, type: 'checkpoint-begin' });
  h.coordinator.dispatch({ ...base, type: 'checkpoint-chunk', index: 0, count: 1, data: body });
  h.coordinator.dispatch({ ...base, type: 'checkpoint-commit' });
}

/** Runs write callbacks and deferred continuations until both are exhausted. */
function runToQuiescence(h: ReturnType<typeof harness>): void {
  let guard = 0;
  while ((h.held.length > 0 || h.deferred.length > 0) && guard < 10_000) {
    if (h.held.length > 0) h.held.shift()?.();
    else h.deferred.shift()?.();
    guard += 1;
  }
}

test('FR-BGSTAB-022 AC-2 — the checkpoint lane defers a slice once the frame budget is spent', () => {
  const signature = 'the checkpoint lane ignored the frame budget';
  const h = harness({ frameBudgetMs: 7 });
  h.setCostPerWrite(1000); // every write blows the 7 ms budget
  submitCheckpoint(h, encoder.encode('S'.repeat(BODY)));

  // Drain only the write callbacks, never the deferred continuations. If the
  // lane honours the budget it must stop and leave work parked in `deferred`.
  let guard = 0;
  while (h.held.length > 0 && guard < 10_000) { h.held.shift()?.(); guard += 1; }

  assert.ok(
    h.deferred.length > 0,
    `${signature}: nothing was deferred, so the budget was never consulted`,
  );
  assert.ok(
    h.kinds.length < 5,
    `${signature}: the whole body was written in one turn despite the budget`,
  );

  // And it must RESUME — a budget that pauses forever is the hang this change risks.
  runToQuiescence(h);
  assert.equal(h.kinds.filter(kind => kind === 'checkpoint').length, 4, signature);
  assert.equal(h.kinds.at(-1), 'parser-tail', `${signature}: the tail must land last`);
  assert.equal(h.coordinator.getState().pendingCommands, 0, `${signature}: it never resumed`);
});

test('FR-BGSTAB-022 AC-2 — the checkpoint lane yields while browser input is pending', () => {
  const signature = 'the checkpoint lane ignored pending input';
  let inputPending = true;
  const h = harness({ frameBudgetMs: 1_000_000, shouldYield: () => inputPending });
  h.setCostPerWrite(0); // the budget cannot be what stops this arm
  submitCheckpoint(h, encoder.encode('S'.repeat(BODY)));

  let guard = 0;
  while (h.held.length > 0 && guard < 10_000) { h.held.shift()?.(); guard += 1; }

  assert.ok(h.deferred.length > 0, `${signature}: no yield was taken`);
  assert.ok(h.kinds.length < 5, `${signature}: the body was written straight through`);

  inputPending = false;
  runToQuiescence(h);
  assert.equal(h.kinds.filter(kind => kind === 'checkpoint').length, 4, signature);
  assert.equal(h.coordinator.getState().pendingCommands, 0, `${signature}: it never resumed`);
});

test('FR-BGSTAB-022 AC-2 — a throwing shouldYield must not strand the lane', () => {
  // A dropped continuation is a hung terminal, not a red test. `shouldYield` is
  // caller-supplied and the production one reaches into
  // `navigator.scheduling.isInputPending`, a vendor surface already treated as
  // untrusted at its call site. If it throws out of the write callback the
  // enclosing catch cannot help — `callbackSettled` is already true — so the
  // lane would be left with work queued, nothing in flight and nothing scheduled.
  const signature = 'a throwing shouldYield stranded the checkpoint lane';
  const h = harness({ frameBudgetMs: 7, shouldYield: () => { throw new Error('vendor surface blew up'); } });
  h.setCostPerWrite(0);
  submitCheckpoint(h, encoder.encode('S'.repeat(BODY)));
  runToQuiescence(h);
  assert.equal(h.coordinator.getState().pendingCommands, 0, `${signature}: work left stranded`);
  assert.equal(h.kinds.filter(kind => kind === 'checkpoint').length, 4, signature);
  assert.equal(h.kinds.at(-1), 'parser-tail', signature);
});

test('FR-BGSTAB-022 AC-2 — a throwing setTimer must not strand the lane', () => {
  // The deadline is cleared before scheduling, so a throwing scheduler would
  // otherwise leave no timer AND no deadline: nothing resumes the lane.
  const signature = 'a throwing setTimer stranded the checkpoint lane';
  const h = harness({
    frameBudgetMs: 7,
    // Throw ONLY for the deferral (delay 0). The coordinator also arms write
    // timeouts through setTimer with a positive delay, and a fixture that throws
    // for those kills the checkpoint before any write — the first draft did that
    // and measured 0 writes instead of the stranding it claimed to test.
    setTimer: (_callback: () => void, delayMs: number) => {
      if (delayMs === 0) throw new Error('scheduler unavailable');
      return { armed: true };
    },
  });
  h.setCostPerWrite(1000); // guarantees the budget is spent and a defer is attempted
  submitCheckpoint(h, encoder.encode('S'.repeat(BODY)));
  runToQuiescence(h);
  assert.equal(h.coordinator.getState().pendingCommands, 0, `${signature}: work left stranded`);
  assert.equal(h.kinds.filter(kind => kind === 'checkpoint').length, 4, signature);
});

test('FR-BGSTAB-022 AC-2 — control: with no budget and no yield configured the lane is unchanged', () => {
  // The negative control. Without it, the two tests above would be satisfied by
  // an implementation that defers unconditionally, which would change the
  // behaviour of every caller that configures neither.
  const signature = 'an unconfigured coordinator changed its pacing';
  const h = harness({});
  h.setCostPerWrite(1000);
  submitCheckpoint(h, encoder.encode('S'.repeat(BODY)));

  let guard = 0;
  while (h.held.length > 0 && guard < 10_000) { h.held.shift()?.(); guard += 1; }

  assert.equal(h.deferred.length, 0, `${signature}: it deferred without being asked to`);
  assert.equal(h.kinds.filter(kind => kind === 'checkpoint').length, 4, signature);
  assert.equal(h.kinds.at(-1), 'parser-tail', signature);
  // The header above claims every arm in this file asserts convergence. It had
  // four of five when it was written — this arm drained only `held` and never
  // checked `pendingCommands`. Rather than narrow the sentence, make it true:
  // an unpaced lane must converge too, and nothing else asserted that here.
  runToQuiescence(h);
  assert.equal(
    h.coordinator.getState().pendingCommands, 0,
    `${signature}: the unpaced lane did not converge`,
  );
});
