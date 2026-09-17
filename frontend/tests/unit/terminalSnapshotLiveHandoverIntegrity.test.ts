// Issue #10 AC-9(ii) / REL-BGSTAB-007 AC-3: across a snapshot-to-live handover,
// loss, duplication and reordering must all be zero.
//
// PRODUCTION IS ALREADY CORRECT. This is a guard, not a bug fix. What was
// missing is that the three properties were only ever asserted in separate
// lanes — ordering in terminalWriteInterleaving, duplication in the
// compatibility post-ACK path — and never jointly across the handover the AC
// actually names. An ordering assertion does not cover duplication and a
// duplication assertion does not cover loss; this file asserts all three of the
// same byte stream at once.
//
// Measured 2026-09-18 before this file existed: loss IS caught today, but only
// incidentally, by tests named for other properties.
//   - dropping post-checkpoint held output   -> caught by 4 tests, all named for
//                                               watermark/drain semantics
//   - truncating each snapshot body slice    -> caught by exactly 1 test, named
//                                               "large checkpoint body is
//                                               parse-paced in bounded physical
//                                               slices" — a pacing test
// So the property had no named owner, and rewriting that pacing test would have
// silently unguarded snapshot-body loss. This file gives it one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as terminalOutputSchedulerModule from '../../src/utils/terminalOutputScheduler.ts';

type WriteKind = 'live' | 'checkpoint' | 'repair' | 'parser-tail';

const encoder = new TextEncoder();

function buildHandover() {
  const writes: Array<{ kind: WriteKind; data: Uint8Array }> = [];
  const held: Array<() => void> = [];
  const adapter = {
    write: (command: { kind: WriteKind; data: string | Uint8Array }, onWritten: () => void) => {
      writes.push({
        kind: command.kind,
        data: typeof command.data === 'string' ? encoder.encode(command.data) : command.data.slice(),
      });
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
      dispatch(command: Record<string, unknown>): { accepted: boolean; reason?: string };
    };
  const coordinator = factory({
    viewGeneration: 7, adapter, digestBytes: () => 'stable-digest',
    postCheckpointMaxBytes: 8 * 1024 * 1024, postCheckpointMaxChunks: 4096,
    checkpointMaxBytes: 8 * 1024 * 1024, checkpointMaxChunks: 4096,
    pendingInputMaxBytes: 1 << 20, pendingInputMaxCount: 1024, pendingInputTtlMs: 60_000,
    settlementLedgerMaxEntries: 4096, settlementLedgerTtlMs: 60_000,
  });
  return { coordinator, writes, held };
}

function drain(held: Array<() => void>): void {
  let guard = 0;
  while (held.length > 0 && guard < 10_000) { held.shift()?.(); guard += 1; }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

test('REL-BGSTAB-007 AC-3 — a snapshot-to-live handover loses, duplicates and reorders nothing', () => {
  const signature = 'the snapshot-to-live handover did not reproduce its input exactly';
  const { coordinator, writes, held } = buildHandover();

  // A body long enough to cross the 32 KiB physical slice boundary several
  // times, so slice-edge loss is reachable rather than theoretical.
  const body = encoder.encode('S'.repeat(80 * 1024));
  const parserTail = encoder.encode('\x1b[');
  const base = {
    streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10', snapshotSeq: '10',
    oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
    chunkCount: 1, encodedByteTotal: body.byteLength, digest: 'stable-digest',
    cols: 80, rows: 24, modes: {}, parserTail,
  };

  assert.equal(coordinator.dispatch({ ...base, type: 'checkpoint-begin' }).accepted, true, signature);
  assert.equal(
    coordinator.dispatch({ ...base, type: 'checkpoint-chunk', index: 0, count: 1, data: body }).accepted,
    true, signature,
  );
  // Live output arriving WHILE the checkpoint is still assembling, past the
  // snapshot watermark, in sequence order. The ordering here is load-bearing:
  // dispatched after `checkpoint-commit` these would go straight to the normal
  // queue and never enter the post-checkpoint hold at all — measured, and it is
  // how the first draft of this test passed while exercising the wrong path.
  const liveParts = ['alpha', 'bravo', 'charlie'].map(text => encoder.encode(text));
  liveParts.forEach((data, index) => {
    assert.equal(
      coordinator.dispatch({
        type: 'live', streamEpoch: '1', sourceSeq: String(11 + index),
        viewGeneration: 7, data, settlementToken: `live-${index}`,
      }).accepted,
      true,
      `${signature}: live frame ${index} was refused`,
    );
  });

  assert.equal(coordinator.dispatch({ ...base, type: 'checkpoint-commit' }).accepted, true, signature);

  drain(held);

  // The precondition, asserted so that a future change which stops producing
  // writes makes this test false rather than vacuously true.
  assert.ok(writes.length > 1, `${signature}: precondition — the body must be sliced`);

  // LOSS and DUPLICATION: every byte exactly once. REORDER: in this exact order.
  // One equality over the whole stream covers all three, which is what the AC
  // claims and what testing them in separate lanes never did.
  const expected = concat([body, parserTail, ...liveParts]);
  const actual = concat(writes.map(entry => entry.data));
  assert.equal(actual.byteLength, expected.byteLength, `${signature}: byte count differs — loss or duplication`);
  assert.deepEqual(actual, expected, signature);

  // The post-snapshot live output must not be interleaved into the body.
  const firstLiveIndex = writes.findIndex(entry => entry.kind === 'live');
  assert.ok(firstLiveIndex > 0, `${signature}: no live write was observed`);
  assert.ok(
    writes.slice(0, firstLiveIndex).every(entry => entry.kind !== 'live'),
    `${signature}: live output was interleaved into the snapshot body`,
  );
});
