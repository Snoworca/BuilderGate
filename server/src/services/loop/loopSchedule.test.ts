import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRunAfter, type LoopSchedule } from './loopSchedule.js';

// FR-LOOP-002: times are the server's local time, so expectations are built with the local
// Date constructor too and the tests hold in any time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('FR-LOOP-002 AC-1: weekly runs on the chosen days at each chosen time', () => {
  // 2026-10-29 is a Thursday. Mon(1) and Thu(4), 08:30 and 18:00.
  const s: LoopSchedule = { kind: 'weekly', days: [1, 4], times: ['18:00', '08:30'] };
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 7, 0)), at(2026, 10, 29, 8, 30));
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 8, 30)), at(2026, 10, 29, 18, 0));
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 18, 0)), at(2026, 11, 2, 8, 30));
});

test('FR-LOOP-002 AC-2: monthly skips a date the month lacks and the last day is the month\'s own', () => {
  const s: LoopSchedule = { kind: 'monthly', dates: [30], lastDay: false, times: ['09:00'] };
  // February has no 30th: from 2027-01-30 10:00 the next is 2027-03-30.
  assert.deepEqual(nextRunAfter(s, at(2027, 1, 30, 10, 0)), at(2027, 3, 30, 9, 0));
  const last: LoopSchedule = { kind: 'monthly', dates: [], lastDay: true, times: ['21:00'] };
  assert.deepEqual(nextRunAfter(last, at(2027, 2, 1)), at(2027, 2, 28, 21, 0));
  assert.deepEqual(nextRunAfter(last, at(2028, 2, 1)), at(2028, 2, 29, 21, 0));
});

test('FR-LOOP-002 AC-2: the 31st and the last day falling on one moment run once', () => {
  const s: LoopSchedule = { kind: 'monthly', dates: [31], lastDay: true, times: ['21:00'] };
  const first = nextRunAfter(s, at(2026, 10, 30));
  assert.deepEqual(first, at(2026, 10, 31, 21, 0));
  assert.deepEqual(nextRunAfter(s, first!), at(2026, 11, 30, 21, 0));
});

test('FR-LOOP-002 AC-3: once runs on that date only, then there is no next run', () => {
  const s: LoopSchedule = { kind: 'once', date: '2026-11-03', times: ['10:00', '15:00'] };
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29)), at(2026, 11, 3, 10, 0));
  assert.deepEqual(nextRunAfter(s, at(2026, 11, 3, 10, 0)), at(2026, 11, 3, 15, 0));
  assert.equal(nextRunAfter(s, at(2026, 11, 3, 15, 0)), null);
});

test('FR-LOOP-002 AC-4: interval counts on from its start across midnight', () => {
  // Every 7 hours from 2026-10-29 09:00: 09:00, 16:00, 23:00, then 06:00 the next day.
  const s: LoopSchedule = { kind: 'interval', everyMinutes: 420, startsAt: '2026-10-29T09:00' };
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 8, 0)), at(2026, 10, 29, 9, 0));
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 9, 0)), at(2026, 10, 29, 16, 0));
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 23, 0)), at(2026, 10, 30, 6, 0));
});

test('FR-LOOP-002 AC-6: times passed while the server was off are not run — the next is after now', () => {
  // A 30-minute loop and a server that comes back at 12:10 after being off since 09:00.
  const s: LoopSchedule = { kind: 'interval', everyMinutes: 30, startsAt: '2026-10-29T09:00' };
  assert.deepEqual(nextRunAfter(s, at(2026, 10, 29, 12, 10)), at(2026, 10, 29, 12, 30));
});

test('FR-LOOP-002: a schedule with nothing chosen has no next run', () => {
  assert.equal(nextRunAfter({ kind: 'weekly', days: [], times: ['08:00'] }, at(2026, 10, 29)), null);
  assert.equal(nextRunAfter({ kind: 'monthly', dates: [1], lastDay: false, times: [] }, at(2026, 10, 29)), null);
});
