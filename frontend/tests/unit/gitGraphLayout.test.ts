// FR-GIT-005: commit graph lanes. Golden cases for the lane each commit takes and the edges drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, MAX_LANES } from '../../src/components/Git/gitGraphLayout.ts';

const C = (sha: string, ...parents: string[]) => ({ sha, parents });

// @req FR-GIT-005
test('FR-GIT-005: a straight line stays in lane 0 with one colour; only the first commit is a tip', () => {
  const { rows, laneCount } = layoutGraph([C('c', 'b'), C('b', 'a'), C('a')]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.isTip), [true, false, false]);
  assert.deepEqual(rows.map((r) => r.color), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.continuesDown), [true, true, false]);
  assert.equal(laneCount, 1);
});

// @req FR-GIT-005
test('FR-GIT-005: a merge opens a lane for its second parent, which joins back into the first', () => {
  const { rows } = layoutGraph([C('m', 'p1', 's1'), C('s1', 'b'), C('p1', 'b'), C('b')]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  assert.deepEqual(rows[0].mergeTo, [1]);
  assert.deepEqual(rows[3].joinFrom, [1]);
  assert.deepEqual(rows[2].passThrough, [1], 'the side lane passes the first parent');
  assert.notEqual(rows[1].color, rows[0].color, 'the side lane has its own colour');
});

// @req FR-GIT-005
test('FR-GIT-005: an octopus merge opens one lane per extra parent', () => {
  const { rows, laneCount } = layoutGraph([C('o', 'a', 'b', 'c'), C('a'), C('b'), C('c')]);
  assert.deepEqual(rows[0].mergeTo, [1, 2]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 1, 2]);
  assert.equal(laneCount, 3);
});

// @req FR-GIT-005
test('FR-GIT-005: two branch tips over one fork point join there', () => {
  const { rows } = layoutGraph([C('t1', 'x'), C('t2', 'x'), C('x')]);
  assert.deepEqual(rows.map((r) => [r.lane, r.isTip]), [[0, true], [1, true], [0, false]]);
  assert.deepEqual(rows[2].joinFrom, [1]);
});

// @req FR-GIT-005
test('FR-GIT-005: a page continues the lanes and colours of the page before', () => {
  const all = [C('m', 'p1', 's1'), C('s1', 'b'), C('p1', 'b'), C('b', 'a'), C('a')];
  const whole = layoutGraph(all);
  const first = layoutGraph(all.slice(0, 2));
  const second = layoutGraph(all.slice(2), first.state);
  const strip = (r: typeof whole.rows[number]) => [r.sha, r.lane, r.color, r.isTip, r.joinFrom, r.mergeTo, r.passThrough];
  assert.deepEqual([...first.rows, ...second.rows].map(strip), whole.rows.map(strip));
});

// @req FR-GIT-005
test('FR-GIT-005: more than 8 lanes draw 8 and report the rest', () => {
  const tips = Array.from({ length: 10 }, (_, i) => C(`t${i}`, 'root'));
  const { laneCount, overflow } = layoutGraph([...tips, C('root')]);
  assert.equal(MAX_LANES, 8);
  assert.equal(laneCount, 8);
  assert.equal(overflow, 2);
});

// @req FR-GIT-005
test('FR-GIT-005: a lane keeps the colour its tip got, through freed and reused lanes', () => {
  const { rows } = layoutGraph([C('t1', 'x'), C('t2', 'y'), C('x', 'r'), C('y', 'r'), C('r')]);
  const colourOf = (sha: string) => rows.find((r) => r.sha === sha)!.color;
  assert.equal(colourOf('x'), colourOf('t1'));
  assert.equal(colourOf('y'), colourOf('t2'));
  assert.notEqual(colourOf('t1'), colourOf('t2'));
});
