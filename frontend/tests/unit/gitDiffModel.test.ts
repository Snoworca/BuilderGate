// FR-GIT-007: diff rows (hidden context, hunks, word marks), split pairing and the virtual window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffRows, pairSplitRows, virtualRange, wordDiff, WORD_DIFF_MAX } from '../../src/components/Git/gitDiffModel.ts';

const L = (k: ' ' | '+' | '-', o: number | null, n: number | null, t: string) => ({ k, o, n, t });

// @req FR-GIT-007
test('FR-GIT-007: word marks cover what changed between a removed and an added line', () => {
  assert.deepEqual(wordDiff('a b c', 'a x c'), { old: [[2, 3]], new: [[2, 3]] });
  assert.deepEqual(wordDiff('if (lane < 0) lane = lanes.length;', 'if (lane < 0) lane = firstFree(lanes);'), {
    // Token LCS keeps "lanes" and ";" in common; on the new side "firstFree(" and ")" are one mark
    // because the text between them has no whitespace.
    old: [[26, 33]], new: [[21, 37]],
  });
  assert.deepEqual(wordDiff('same', 'same'), { old: [], new: [] });
  assert.equal(wordDiff('x'.repeat(WORD_DIFF_MAX + 1), 'y'), null, 'long lines are not word-diffed');
});

// @req FR-GIT-007
test('FR-GIT-007: rows: a top gap with one action, gaps between hunks with three, a bottom gap; word marks on paired lines', () => {
  const hunks = [
    { oldStart: 12, oldLines: 3, newStart: 12, newLines: 3, header: '@@ -12,3 +12,3 @@', lines: [L(' ', 12, 12, 'a'), L('-', 13, null, 'b c'), L('+', null, 13, 'b x'), L(' ', 14, 14, 'd')] },
    { oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, header: '@@ -40 +40,2 @@', lines: [L(' ', 40, 40, 'e'), L('+', null, 41, 'f')] },
  ];
  const rows = buildDiffRows(hunks, { gapAfter: 9 });
  assert.deepEqual(rows.map((r) => r.type), ['gap', 'hunk', 'line', 'line', 'line', 'line', 'gap', 'hunk', 'line', 'line', 'gap']);
  assert.deepEqual(rows[0], { type: 'gap', at: 'top', count: 11, hunk: 0 });
  assert.deepEqual(rows[6], { type: 'gap', at: 'between', count: 25, hunk: 1 });
  assert.deepEqual(rows[10], { type: 'gap', at: 'bottom', count: 9, hunk: 2 });
  const del = rows[3] as { marks?: Array<[number, number]> };
  const add = rows[4] as { marks?: Array<[number, number]> };
  assert.deepEqual([del.marks, add.marks], [[[2, 3]], [[2, 3]]]);
  assert.deepEqual(buildDiffRows([{ ...hunks[0], oldStart: 1, newStart: 1 }], {}).map((r) => r.type)[0], 'hunk', 'no top gap at line 1');
});

// @req FR-GIT-007
test('FR-GIT-007: split view pairs removed with added lines and pads the shorter side', () => {
  const rows = buildDiffRows([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, header: '@@', lines: [L(' ', 1, 1, 'a'), L('-', 2, null, 'b'), L('-', 3, null, 'c'), L('+', null, 2, 'B')] }], {});
  const pairs = pairSplitRows(rows);
  const sides = pairs.filter((p) => p.type === 'pair').map((p) => [p.left?.t ?? null, p.right?.t ?? null]);
  assert.deepEqual(sides, [['a', 'a'], ['b', 'B'], ['c', null]]);
});

// @req FR-GIT-007
test('FR-GIT-007: the virtual window covers the viewport plus overscan', () => {
  assert.deepEqual(virtualRange({ scrollTop: 1000, viewport: 400, rowHeight: 20, total: 3000, overscan: 20 }), { start: 30, end: 90 });
  assert.deepEqual(virtualRange({ scrollTop: 0, viewport: 400, rowHeight: 20, total: 10, overscan: 20 }), { start: 0, end: 10 });
});

// @req FR-GIT-007
test('FR-GIT-007: revealing hidden context fills a gap from the new text, from either side', async () => {
  const { expandGaps } = await import('../../src/components/Git/gitDiffModel.ts');
  const hunks = [
    { oldStart: 6, oldLines: 1, newStart: 5, newLines: 1, header: '@@ -6 +5 @@', lines: [L('-', 6, null, 'x'), L('+', null, 5, 'X')] },
    { oldStart: 31, oldLines: 1, newStart: 30, newLines: 1, header: '@@ -31 +30 @@', lines: [L(' ', 31, 30, 'k')] },
  ];
  const text = Array.from({ length: 40 }, (_, i) => `n${i + 1}`);
  const rows = buildDiffRows(hunks, { gapAfter: 10 });
  const all = expandGaps(rows, hunks, { top: 'all' }, text);
  const top = all.slice(0, 4).map((r) => (r.type === 'line' ? [r.o, r.n, r.t] : r.type));
  assert.deepEqual(top, [[2, 1, 'n1'], [3, 2, 'n2'], [4, 3, 'n3'], [5, 4, 'n4']]);
  const partial = expandGaps(rows, hunks, { 'between:1': 'down20' }, text);
  const gapRows = partial.filter((r) => r.type === 'gap');
  const between = gapRows.find((r) => r.type === 'gap' && r.at === 'between');
  assert.equal(between && between.type === 'gap' ? between.count : -1, 4, '24 hidden, 20 shown under the first hunk');
  const bottom = expandGaps(rows, hunks, { bottom: 'all' }, text).slice(-10);
  assert.equal(bottom[0].type === 'line' ? bottom[0].n : -1, 31);
});
