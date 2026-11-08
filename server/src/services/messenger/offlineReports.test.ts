// FR-MSG-012 AC-1: the storage PC keeps member reports of when it was unreachable as merged
// intervals, so repeated or overlapping reports do not pile up (live check 2026-11-08: 8 rows for
// two intervals).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addOfflineReport } from './offlineReports.js';

const H = 3_600_000;
const now = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('FR-MSG-012 AC-1: overlapping and repeated reports merge into one interval', () => {
  let reports = addOfflineReport([], { from: now - 2 * H, to: now - 1.5 * H }, now);
  reports = addOfflineReport(reports, { from: now - 2 * H, to: now - 1.5 * H }, now);
  reports = addOfflineReport(reports, { from: now - 1.8 * H, to: now - H }, now);
  assert.deepEqual(reports, [{ from: iso(now - 2 * H), to: iso(now - H) }]);
});

test('FR-MSG-012 AC-1: separate intervals stay separate and in order; reports older than 7 days are dropped', () => {
  let reports = addOfflineReport([], { from: now - 2 * H, to: now - 1.5 * H }, now);
  reports = addOfflineReport(reports, { from: now - 5 * H, to: now - 4 * H }, now);
  reports = addOfflineReport(reports, { from: now - 8 * 24 * H, to: now - 8 * 24 * H + H }, now);
  assert.deepEqual(reports, [
    { from: iso(now - 5 * H), to: iso(now - 4 * H) },
    { from: iso(now - 2 * H), to: iso(now - 1.5 * H) },
  ]);
});
