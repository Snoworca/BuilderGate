// REL-BGSTAB-027 — the post-rollback compatibility writer must stay bounded.
//
// TDD RED, written before the fix. AC-1..AC-4 are expected to fail at the tree
// that introduced this file; AC-5 is a no-change clause and is not a runtime
// assertion. Each subject arm is paired with a control that must fire BY NAME,
// because "it stopped" and "it stopped for the right reason" are different
// claims — the live lane already stops, at the settlement ledger's entry cap,
// while holding four times the declared byte budget.
//
// The factory is reached through the terminalOutputScheduler re-export, which is
// how the coordinator's own primary suite reaches it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as terminalOutputSchedulerModule from '../../src/utils/terminalOutputScheduler.ts';

type WriteKind = 'live' | 'checkpoint' | 'repair' | 'parser-tail';

const BYTE_CAP = 1024 * 1024;
const CHUNK_CAP = 1024;
const WRITE_BYTES = 4096;
// 1 MiB / 4096 B. The control must reject on exactly the write after this many.
const WRITES_TO_BYTE_CAP = BYTE_CAP / WRITE_BYTES;
// Enough headroom that the loop bound is never what stops the subject.
const FLOOD = CHUNK_CAP * 20;

const LIMITS = {
  postCheckpointMaxBytes: BYTE_CAP,
  postCheckpointMaxChunks: CHUNK_CAP,
  checkpointMaxBytes: BYTE_CAP,
  checkpointMaxChunks: CHUNK_CAP,
  pendingInputMaxBytes: 1024 * 1024,
  pendingInputMaxCount: 1024,
  pendingInputTtlMs: 60_000,
  settlementLedgerMaxEntries: 1024,
  settlementLedgerTtlMs: 60_000,
} as const;

function recordingAdapter() {
  const events: WriteKind[] = [];
  const recoveries: string[] = [];
  // write() deliberately never calls onWritten: one write stays in flight, which
  // is the real xterm shape and the only state in which a queue can accumulate.
  const held: Array<() => void> = [];
  const adapter = {
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
    settleInput: () => {},
    requestFreshRecovery: (reason: string) => { recoveries.push(reason); },
    requestRuntimeRecreation: () => {},
    compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {},
    checkpointDrained: () => {},
    settle: () => {},
  };
  return { adapter, events, recoveries, held };
}

type Coordinator = {
  dispatch(command: Record<string, unknown>): { accepted: boolean; reason?: string };
  submitCompatibility(command: Record<string, unknown>): { accepted: boolean; reason?: string };
  getState(): { pendingCommands: number; writeInFlight: boolean; recoveryRequired: boolean };
};

function makeCoordinator(
  signature: string,
  overrides: Readonly<Record<string, number>> = {},
): { coordinator: Coordinator; recording: ReturnType<typeof recordingAdapter> } {
  const factory = (terminalOutputSchedulerModule as Record<string, unknown>)
    .createTerminalWriteCoordinator;
  assert.equal(typeof factory, 'function', signature);
  const recording = recordingAdapter();
  const coordinator = (factory as (options: Record<string, unknown>) => Coordinator)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: () => 'd'.repeat(16),
    ...LIMITS,
    ...overrides,
  });
  return { coordinator, recording };
}

function checkpointBegin(overrides: Record<string, unknown> = {}) {
  return {
    type: 'checkpoint-begin',
    streamEpoch: '1',
    checkpointEpoch: '1',
    sourceSeq: '10',
    snapshotSeq: '10',
    oldestRetainedSeq: '1',
    retentionPolicyId: 'p1',
    viewGeneration: 7,
    chunkCount: 1,
    encodedByteTotal: 8,
    digest: 'd'.repeat(16),
    cols: 80,
    rows: 24,
    modes: {},
    parserTail: new Uint8Array(0),
    ...overrides,
  };
}

function rollback(coordinator: Coordinator, signature: string): void {
  const result = coordinator.dispatch({
    type: 'rollback-to-compatibility',
    viewGeneration: 8,
    reason: 'capability-withdrawn',
  });
  assert.equal(result.accepted, true, `${signature}: rollback itself must be accepted`);
}

/** Submits until rejected. Returns how many were accepted and why it stopped. */
function floodCompatibility(coordinator: Coordinator, generation: number) {
  for (let index = 0; index < FLOOD; index += 1) {
    const result = coordinator.submitCompatibility({
      type: 'write',
      viewGeneration: generation,
      kind: 'live',
      data: new Uint8Array(WRITE_BYTES),
    });
    if (!result.accepted) return { accepted: index, reason: result.reason };
  }
  return { accepted: FLOOD, reason: undefined as string | undefined };
}

test('REL-BGSTAB-027 control — with a checkpoint open the byte cap fires by name at the predicted write', () => {
  const signature = 'the hold byte cap did not fire where arithmetic says it must';
  const { coordinator, recording } = makeCoordinator(signature);
  coordinator.dispatch(checkpointBegin());

  let accepted = 0;
  let reason: string | undefined;
  for (let index = 0; index < FLOOD; index += 1) {
    const result = coordinator.dispatch({
      type: 'live',
      streamEpoch: '1',
      sourceSeq: String(11 + index),
      viewGeneration: 7,
      data: new Uint8Array(WRITE_BYTES),
      settlementToken: `control-${index}`,
    });
    if (!result.accepted) { reason = result.reason; break; }
    accepted += 1;
  }

  // Without this the subject arms below prove nothing: a probe whose control is
  // dead is indistinguishable from a subject that is correct.
  assert.equal(reason, 'post-checkpoint-hold-overflow', signature);
  assert.equal(accepted, WRITES_TO_BYTE_CAP, `${signature}: cap must fire at the arithmetic boundary`);
  assert.equal(recording.recoveries.at(-1), 'post-checkpoint-hold-overflow', signature);
});

test('REL-BGSTAB-027 AC-1 — after rollback the compatibility writer stops at the byte cap', () => {
  const signature = 'the post-rollback writer accepted writes past its declared byte cap';
  const { coordinator, recording } = makeCoordinator(signature);
  rollback(coordinator, signature);

  const { accepted, reason } = floodCompatibility(coordinator, 8);
  const retainedBytes = accepted * WRITE_BYTES;

  assert.notEqual(reason, undefined, `${signature}: admission never stopped at all`);
  assert.ok(
    retainedBytes <= BYTE_CAP,
    `${signature}: retained ${retainedBytes} bytes against a declared cap of ${BYTE_CAP}`,
  );
  assert.equal(coordinator.getState().pendingCommands <= CHUNK_CAP, true, signature);
  assert.ok(recording.recoveries.length > 0, `${signature}: overflow must request fresh recovery`);
});

test('REL-BGSTAB-027 AC-2 — after rollback the compatibility writer stops at the chunk cap', () => {
  const signature = 'the post-rollback writer accepted writes past its declared chunk cap';
  // One byte per write, so the byte cap cannot be what stops this arm: reaching
  // the chunk cap costs 1 KiB in total. The two caps must fire independently.
  const { coordinator } = makeCoordinator(signature);
  rollback(coordinator, signature);

  let accepted = 0;
  let reason: string | undefined;
  for (let index = 0; index < FLOOD; index += 1) {
    const result = coordinator.submitCompatibility({
      type: 'write', viewGeneration: 8, kind: 'live', data: new Uint8Array(1),
    });
    if (!result.accepted) { reason = result.reason; break; }
    accepted += 1;
  }

  assert.notEqual(reason, undefined, `${signature}: admission never stopped at all`);
  assert.ok(
    accepted <= CHUNK_CAP,
    `${signature}: retained ${accepted} chunks against a declared cap of ${CHUNK_CAP}`,
  );
});

test('REL-BGSTAB-027 AC-3 — neither cap may be substituted by the settlement ledger entry limit', () => {
  const signature = 'the writer was bounded by the settlement ledger rather than by a byte or chunk cap';
  // Design note, because two earlier drafts of this arm were wrong in opposite
  // directions. `claimSettlementToken` is reached only from the dispatch path,
  // so compatibility writes carry no settlement token and the ledger cannot
  // bound them. Raising the ledger therefore proves nothing (draft one, vacuous:
  // its only assertion with teeth duplicated AC-1). Routing the flood through
  // `dispatch` instead proves something about a different lane (draft two: the
  // live lane has no byte or chunk cap of its own today, so with the ledger
  // raised it never stops — pre-existing, and not this requirement's subject).
  //
  // The discriminating design is to squeeze the ledger to ONE entry and flood
  // the compatibility lane anyway. If that lane ever started consulting the
  // ledger, it would reject almost immediately with `settlement-ledger-overflow`;
  // because it does not, the rejection is a cap reason at the cap's boundary.
  const { coordinator } = makeCoordinator(signature, { settlementLedgerMaxEntries: 1 });
  rollback(coordinator, signature);

  const { accepted, reason } = floodCompatibility(coordinator, 8);

  assert.notEqual(reason, undefined, `${signature}: admission never stopped at all`);
  assert.notEqual(
    reason,
    'settlement-ledger-overflow',
    `${signature}: a gate closed for the wrong reason is not a closed gate`,
  );
  // With a one-entry ledger, a lane that consulted it would have stopped at
  // once. Stopping at the byte boundary instead is what makes this arm
  // discriminate rather than merely agree with AC-1.
  assert.ok(
    accepted > 1,
    `${signature}: stopped far too early — something other than the byte cap bound it`,
  );
  assert.ok(
    accepted * WRITE_BYTES <= BYTE_CAP,
    `${signature}: retained ${accepted * WRITE_BYTES} bytes against a declared cap of ${BYTE_CAP}`,
  );
});

test('REL-BGSTAB-027 AC-5 — the compatibility guard must not charge the checkpoint body to the compatibility budget', () => {
  // Regression for a defect this lane INTRODUCED with the AC-1/AC-2 guard.
  // After `finalizeCheckpointTransaction` the queue legitimately holds the
  // checkpoint entry — bounded by `checkpointMaxBytes`, a SEPARATE budget per
  // REL-BGSTAB-007 AC-6 — plus the held post-checkpoint mutations bounded by
  // `postCheckpointMaxBytes`. Summing all of it against the post-checkpoint
  // budget alone fires on a state that is inside every declared budget, and it
  // does not merely reject: it latches `requestRecovery`, tearing down a healthy
  // view. Measured before the fix: a 40 KiB body plus 8x5 KiB of held output, at
  // caps of 64 KiB / 16 chunks, made a ZERO-BYTE resize return
  // `compatibility-queue-overflow` at only 9 of 16 chunks.
  const signature = 'a legal checkpoint plus legal held output tripped the compatibility guard';
  const { coordinator, recording } = makeCoordinator(signature);

  // 0.7 + 8*0.05 = 1.1 caps in total, while each part stays inside its OWN
  // budget. The first draft used 0.6 and landed 7 bytes under the sum, so the
  // arm passed without posing its question.
  const body = new Uint8Array(Math.floor(BYTE_CAP * 0.7));
  const base = {
    streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10', snapshotSeq: '10',
    oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
    chunkCount: 1, encodedByteTotal: body.byteLength, digest: 'd'.repeat(16),
    cols: 80, rows: 24, modes: {}, parserTail: new Uint8Array(0),
  };
  assert.equal(coordinator.dispatch({ ...base, type: 'checkpoint-begin' }).accepted, true, signature);
  assert.equal(
    coordinator.dispatch({ ...base, type: 'checkpoint-chunk', index: 0, count: 1, data: body }).accepted,
    true, signature,
  );
  // Held post-checkpoint output, comfortably inside its own byte and chunk caps.
  const heldWrites = 8;
  for (let index = 0; index < heldWrites; index += 1) {
    assert.equal(
      coordinator.dispatch({
        type: 'live', streamEpoch: '1', sourceSeq: String(11 + index), viewGeneration: 7,
        data: new Uint8Array(Math.floor(BYTE_CAP * 0.05)), settlementToken: `held-${index}`,
      }).accepted,
      true, `${signature}: precondition — held output must be inside its own budget`,
    );
  }
  assert.equal(coordinator.dispatch({ ...base, type: 'checkpoint-commit' }).accepted, true, signature);

  // Precondition: the queue is inside the chunk cap, so if this arm fails it is
  // the byte accounting and not an incidental chunk overflow.
  assert.ok(
    coordinator.getState().pendingCommands < CHUNK_CAP,
    `${signature}: precondition — the queue must be inside the chunk cap`,
  );

  // A zero-byte mutation cannot exceed any byte budget on its own.
  const resize = coordinator.submitCompatibility({
    type: 'resize', viewGeneration: 7, cols: 100, rows: 30,
  });
  assert.equal(resize.accepted, true, `${signature}: reason=${resize.reason}`);
  assert.deepEqual(
    recording.recoveries, [],
    `${signature}: a healthy view must not be torn down by the compatibility guard`,
  );
});

test('REL-BGSTAB-027 AC-4 — rollback stops new authoritative output until a fresh snapshot converges', () => {
  const signature = 'authoritative output was admitted after rollback before any fresh snapshot';
  const { coordinator, recording } = makeCoordinator(signature);
  rollback(coordinator, signature);

  const live = coordinator.dispatch({
    type: 'live',
    streamEpoch: '1',
    sourceSeq: '1',
    viewGeneration: 8,
    data: new Uint8Array(8),
    settlementToken: 'post-rollback-live',
  });

  assert.equal(live.accepted, false, signature);
  // A rejection is not enough: `recovery-required`, `fresh-checkpoint-required`,
  // `stale-view-generation`, `stale-stream-epoch` and `runtime-recreation-required`
  // would all satisfy `accepted === false` while the new fence was gone. Pin the
  // reason, and pin the precondition that makes this fence the one under test —
  // rollback clears `recoveryRequired`, so that cannot be what rejected it.
  assert.equal(
    coordinator.getState().recoveryRequired, false,
    `${signature}: precondition — a different fence would be doing the work`,
  );
  assert.equal(live.reason, 'compatibility-snapshot-required', `${signature}: wrong fence`);
  // REL-BGSTAB-007 AC-12's "new admission 중지" is an output claim too, so the
  // write must not reach the terminal either.
  assert.deepEqual(recording.events, [], `${signature}: the write reached xterm`);
});
