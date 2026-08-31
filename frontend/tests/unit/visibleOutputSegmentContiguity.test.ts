import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertContiguousSegments,
  splitVisibleOutputSourceSegments,
  type VisibleOutputSourceSegment,
} from '../../src/utils/visibleOutputRecovery.ts';

/**
 * S4-C4 — the segment contiguity invariant, extracted for sharing.
 *
 * `splitVisibleOutputSourceSegments` validates and decodes in one pass. The
 * binary adapter will not decode — the codec already sliced the body — so it
 * would inherit only the decode half and the contiguity invariant would quietly
 * disappear from the byte path. The check therefore becomes a shared pure
 * function that both adapters call.
 *
 * Every case below carries its own literal `valid` expectation. Both
 * implementations are compared against that literal rather than against each
 * other: two implementations checked against one another agree perfectly while
 * both are wrong.
 */

interface ContiguityCase {
  readonly name: string;
  readonly text: string;
  readonly segments: readonly VisibleOutputSourceSegment[];
  readonly valid: boolean;
}

const seg = (
  byteStart: number,
  byteEnd: number,
  chunkId: string,
  extra: Partial<VisibleOutputSourceSegment> = {},
): VisibleOutputSourceSegment => ({ byteStart, byteEnd, chunkId, ...extra });

const CASES: readonly ContiguityCase[] = [
  { name: 'single segment covering the whole payload', text: 'abcd', segments: [seg(0, 4, 'c1')], valid: true },
  { name: 'two adjacent segments', text: 'abcd', segments: [seg(0, 2, 'c1'), seg(2, 4, 'c2')], valid: true },
  {
    name: 'multi-byte payload split on a codepoint boundary',
    text: '한글',
    segments: [seg(0, 3, 'c1'), seg(3, 6, 'c2')],
    valid: true,
  },
  { name: 'empty segment list', text: 'abcd', segments: [], valid: false },
  { name: 'does not start at zero', text: 'abcd', segments: [seg(1, 4, 'c1')], valid: false },
  { name: 'gap between segments', text: 'abcd', segments: [seg(0, 1, 'c1'), seg(2, 4, 'c2')], valid: false },
  { name: 'overlapping segments', text: 'abcd', segments: [seg(0, 3, 'c1'), seg(2, 4, 'c2')], valid: false },
  { name: 'stops short of the payload end', text: 'abcd', segments: [seg(0, 3, 'c1')], valid: false },
  { name: 'runs past the payload end', text: 'abcd', segments: [seg(0, 5, 'c1')], valid: false },
  { name: 'zero-width segment', text: 'abcd', segments: [seg(0, 0, 'c1'), seg(0, 4, 'c2')], valid: false },
  { name: 'descending segment', text: 'abcd', segments: [seg(0, 4, 'c1'), seg(4, 2, 'c2')], valid: false },
  { name: 'non-integer boundary', text: 'abcd', segments: [seg(0, 2.5, 'c1'), seg(2.5, 4, 'c2')], valid: false },
  { name: 'empty chunkId', text: 'abcd', segments: [seg(0, 4, '')], valid: false },
  {
    name: 'empty authorityEpoch',
    text: 'abcd',
    segments: [seg(0, 4, 'c1', { authorityEpoch: '' })],
    valid: false,
  },
  {
    name: 'populated authorityEpoch is accepted',
    text: 'abcd',
    segments: [seg(0, 4, 'c1', { authorityEpoch: 'epoch-1' })],
    valid: true,
  },
  {
    name: 'negative authorityRevision',
    text: 'abcd',
    segments: [seg(0, 4, 'c1', { authorityRevision: -1 })],
    valid: false,
  },
  {
    name: 'non-integer authorityRevision',
    text: 'abcd',
    segments: [seg(0, 4, 'c1', { authorityRevision: 1.5 })],
    valid: false,
  },
  {
    name: 'non-finite screenSeq',
    text: 'abcd',
    segments: [seg(0, 4, 'c1', { screenSeq: Number.POSITIVE_INFINITY })],
    valid: false,
  },
];

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

test('assertContiguousSegments matches its literal expectation on every case', () => {
  for (const testCase of CASES) {
    assert.equal(
      assertContiguousSegments(testCase.segments, utf8Length(testCase.text)),
      testCase.valid,
      testCase.name,
    );
  }
});

test('splitVisibleOutputSourceSegments matches the same literal expectation', () => {
  for (const testCase of CASES) {
    assert.equal(
      splitVisibleOutputSourceSegments(testCase.text, [...testCase.segments]) !== null,
      testCase.valid,
      testCase.name,
    );
  }
});

test('the case table exercises both outcomes', () => {
  const accepted = CASES.filter(entry => entry.valid).length;
  const rejected = CASES.length - accepted;
  assert.ok(accepted >= 4, `only ${accepted} accepting cases — the check could reject everything and pass`);
  assert.ok(rejected >= 10, `only ${rejected} rejecting cases — the check could accept everything and pass`);
});

test('extraction preserves the decoded output of a valid split', () => {
  const chunks = splitVisibleOutputSourceSegments('한글', [seg(0, 3, 'c1'), seg(3, 6, 'c2')]);

  assert.notEqual(chunks, null);
  assert.deepEqual(
    chunks?.map(chunk => chunk.data),
    ['한', '글'],
    'the shared validator must not disturb the decode half',
  );
  assert.deepEqual(chunks?.map(chunk => chunk.chunkId), ['c1', 'c2']);
});

test('boundary control — an invalid UTF-8 split is still rejected by the decoder, not the validator', () => {
  // Both segments are contiguous and in range, so the contiguity check accepts;
  // only the fatal decoder rejects the mid-codepoint cut. This pins the division
  // of labour — if the split ever returns non-null here, the decode guard is gone.
  const midCodepoint = [seg(0, 1, 'c1'), seg(1, 3, 'c2')];

  assert.equal(
    assertContiguousSegments(midCodepoint, utf8Length('한')),
    true,
    'contiguity alone cannot see a mid-codepoint cut',
  );
  assert.equal(
    splitVisibleOutputSourceSegments('한', midCodepoint),
    null,
    'the fatal TextDecoder must still reject it',
  );
});
