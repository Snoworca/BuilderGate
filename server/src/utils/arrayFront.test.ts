// PERF-BGSTAB-032: front removal that does not copy the rest of a large list.
import assert from 'node:assert/strict';
import test from 'node:test';
import { takeFromFront } from './arrayFront.js';

test('PERF-BGSTAB-032 AC-2: takes the same entries, in the same order, as splice(0, n)', () => {
  for (const [length, count] of [[0, 0], [0, 3], [5, 0], [5, 1], [5, 5], [5, 9], [40, 17], [10_000, 1], [10_000, 2_500], [10_000, 10_000]] as const) {
    const expected = Array.from({ length }, (_, i) => i);
    const actual = [...expected];
    const expectedTaken = expected.splice(0, count);
    assert.deepEqual(takeFromFront(actual, count), expectedTaken, `taken, ${length}/${count}`);
    assert.deepEqual(actual, expected, `left, ${length}/${count}`);
  }
  const untouched = [1, 2, 3];
  assert.deepEqual(takeFromFront(untouched, -1), []);
  assert.deepEqual(untouched, [1, 2, 3]);
});

test('PERF-BGSTAB-032 AC-2: one entry off the front of 10,000 costs under 2 microseconds', () => {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round += 1) {
    const list = Array.from({ length: 10_000 }, (_, i) => ({ i }));
    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1) {
      takeFromFront(list, 1);
      list.push({ i });
    }
    best = Math.min(best, (performance.now() - started) * 1000 / 20_000);
  }
  console.log(`[PERF-BGSTAB-032] ${best.toFixed(3)} us per entry taken from the front of 10,000`);
  assert.ok(best < 2, `${best.toFixed(3)} us per entry`);
});
