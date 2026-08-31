import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalOutputScheduler } from '../../src/utils/terminalOutputScheduler.ts';

/**
 * Arm C of the S4-C1 xterm interleaving characterization.
 *
 * `xtermDecoderInterleaving.test.ts` establishes that xterm reorders output when
 * a string write lands between two halves of a split multi-byte sequence. That
 * mechanism only bites if the live output path can emit a byte write that ends
 * mid-codepoint. This file asserts it cannot — driving the real scheduler rather
 * than its private slicing helper, so the claim is about the production path and
 * not about a function in isolation.
 *
 * The day these go red is the day the defect becomes reachable.
 */

const TEXT_ENCODER = new TextEncoder();

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

/** Cumulative start offset of each slice; a partition is aligned iff none lands on a continuation byte. */
function sliceStartOffsets(slices: readonly Uint8Array[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const slice of slices) {
    offsets.push(cursor);
    cursor += slice.byteLength;
  }
  return offsets;
}

function findMisalignedBoundary(bytes: Uint8Array, slices: readonly Uint8Array[]): number | null {
  for (const offset of sliceStartOffsets(slices)) {
    if (offset < bytes.byteLength && isContinuationByte(bytes[offset])) {
      return offset;
    }
  }
  return null;
}

function concatenate(slices: readonly Uint8Array[]): Uint8Array {
  const total = slices.reduce((sum, slice) => sum + slice.byteLength, 0);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const slice of slices) {
    merged.set(slice, cursor);
    cursor += slice.byteLength;
  }
  return merged;
}

/** Seeded xorshift32 — deterministic, no external dependency. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Well-formed UTF-8 only: a deliberate mix of 1/2/3/4-byte codepoints, no surrogates. */
function randomWellFormedText(random: () => number, codepointCount: number): string {
  let text = '';
  for (let index = 0; index < codepointCount; index += 1) {
    const width = 1 + Math.floor(random() * 4);
    if (width === 1) {
      text += String.fromCodePoint(0x20 + Math.floor(random() * 0x5f));
    } else if (width === 2) {
      text += String.fromCodePoint(0x80 + Math.floor(random() * (0x7ff - 0x80)));
    } else if (width === 3) {
      const candidate = 0x800 + Math.floor(random() * (0xffff - 0x800));
      text += String.fromCodePoint(candidate >= 0xd800 && candidate <= 0xdfff ? 0x4e00 : candidate);
    } else {
      text += String.fromCodePoint(0x10000 + Math.floor(random() * (0x10ffff - 0x10000)));
    }
  }
  return text;
}

function collectSchedulerWrites(text: string, flushBudgetBytes: number): Uint8Array[] {
  const writes: Uint8Array[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 8 * 1024 * 1024,
    visibleOutputMaxChunks: 4096,
    visibleFlushBudgetBytes: flushBudgetBytes,
    write: (data, onWritten) => {
      assert.ok(
        data instanceof Uint8Array,
        'the live path is expected to write bytes; a string write here would change what Arm A measures',
      );
      writes.push(data);
      onWritten();
    },
    schedule: drain => drain(),
  });
  scheduler.enqueue(text);
  scheduler.flush();
  return writes;
}

test('Arm C assertion 1 — every live-path write slice starts on a codepoint boundary', () => {
  const random = createRandom(20260819);
  const iterations = 200;
  let casesWhereNaiveSplitWouldMisalign = 0;
  let totalWrites = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const text = randomWellFormedText(random, 12 + Math.floor(random() * 40));
    const flushBudgetBytes = 1 + Math.floor(random() * 24);
    const expectedBytes = TEXT_ENCODER.encode(text);

    // Anti-vacuity: would a naive fixed-width split have landed mid-codepoint?
    for (let offset = flushBudgetBytes; offset < expectedBytes.byteLength; offset += flushBudgetBytes) {
      if (isContinuationByte(expectedBytes[offset])) {
        casesWhereNaiveSplitWouldMisalign += 1;
        break;
      }
    }

    const writes = collectSchedulerWrites(text, flushBudgetBytes);
    totalWrites += writes.length;
    const misaligned = findMisalignedBoundary(expectedBytes, writes);

    assert.equal(
      misaligned,
      null,
      `slice boundary landed mid-codepoint at byte ${misaligned} `
        + `(budget=${flushBudgetBytes}, bytes=${expectedBytes.byteLength})`,
    );
    assert.deepEqual(
      concatenate(writes),
      expectedBytes,
      'slicing must be lossless as well as aligned',
    );
  }

  assert.ok(
    casesWhereNaiveSplitWouldMisalign > 0,
    'no generated case would have misaligned under a naive split — assertion 1 proved nothing',
  );
  assert.ok(
    totalWrites > iterations * 2,
    `the scheduler emitted ${totalWrites} slices across ${iterations} cases; `
      + 'if it were not actually splitting, every partition would be trivially aligned',
  );
});

test('Arm C assertion 2 (boundary control) — the alignment check rejects a misaligned partition', () => {
  // '한' is ED 95 9C. Split after two bytes and the second slice starts on a
  // continuation byte. Built independently of the scheduler: if the checker
  // cannot catch a partition we deliberately broke, assertion 1 is vacuous.
  const bytes = TEXT_ENCODER.encode('한글');
  const misalignedPartition = [bytes.subarray(0, 2), bytes.subarray(2)];

  assert.equal(
    findMisalignedBoundary(bytes, misalignedPartition),
    2,
    'the checker must report the boundary that splits a codepoint',
  );
  assert.deepEqual(
    concatenate(misalignedPartition),
    bytes,
    'the control partition is lossless — it fails on alignment alone, not on content',
  );
});

test('Arm C assertion 3 (boundary control) — an aligned partition of the same bytes passes', () => {
  const bytes = TEXT_ENCODER.encode('한글');
  const alignedPartition = [bytes.subarray(0, 3), bytes.subarray(3)];

  assert.equal(
    findMisalignedBoundary(bytes, alignedPartition),
    null,
    'the checker must not reject a correctly aligned partition',
  );
});
