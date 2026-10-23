// FR-GIT-009, FR-GIT-011: polling only while something visible needs a session's git summary,
// one request per session shared by every subscriber, faster while the session works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pollInterval } from '../../src/components/Git/gitPollPolicy.ts';
import { createGitSummaryStore } from '../../src/components/Git/gitSummaryStore.ts';
import { GitApiError } from '../../src/components/Git/gitApi.ts';

// @req FR-GIT-009
test('FR-GIT-009: interval by the fastest visible subscriber, with slow-repository and no-change backoff', () => {
  const chip = (running: boolean, visible = true) => ({ visible, running, mode: 'chip' as const });
  const fresh = { lastDurationMs: 100, sameCount: 0 };
  assert.equal(pollInterval([], fresh), null);
  assert.equal(pollInterval([chip(true, false)], fresh), null, 'hidden subscribers do not poll');
  assert.equal(pollInterval([chip(false)], fresh), 10_000);
  assert.equal(pollInterval([chip(true)], fresh), 3_000);
  assert.equal(pollInterval([chip(false), { visible: true, running: false, mode: 'window' }], fresh), 3_000);
  assert.equal(pollInterval([chip(true)], { lastDurationMs: 2_000, sameCount: 0 }), 10_000, 'x5 when a summary took over 1 s');
  assert.equal(pollInterval([chip(true)], { lastDurationMs: 9_000, sameCount: 0 }), 30_000, 'at most 30 s');
  assert.equal(pollInterval([chip(true)], { lastDurationMs: 100, sameCount: 10 }), 10_000, 'ten identical answers in a row');
  assert.equal(pollInterval([chip(false)], { lastDurationMs: 100, sameCount: 10 }), 10_000);
});

// @req PERF-GIT-001
test('PERF-GIT-001: a WSL session that is working polls every 5 s (one wsl.exe call costs over 250 ms)', () => {
  const fresh = { lastDurationMs: 100, sameCount: 0 };
  assert.equal(pollInterval([{ visible: true, running: true, mode: 'chip', wsl: true }], fresh), 5_000);
  assert.equal(pollInterval([{ visible: true, running: false, mode: 'window', wsl: true }], fresh), 5_000);
  assert.equal(pollInterval([{ visible: true, running: false, mode: 'chip', wsl: true }], fresh), 10_000);
  assert.equal(pollInterval([{ visible: true, running: true, mode: 'chip' }], fresh), 3_000, 'native sessions keep 3 s');
});

function harness(visibility?: { hidden: () => boolean; onChange: (fn: () => void) => void }) {
  let now = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  const calls: Array<{ sessionId: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal: AbortSignal }> = [];
  const store = createGitSummaryStore({
    fetchSummary: (sessionId, signal) => new Promise((resolve, reject) => { calls.push({ sessionId, resolve: resolve as (v: unknown) => void, reject, signal }); }),
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...(visibility ? { visibility } : {}),
  });
  const flush = () => new Promise((r) => setImmediate(r));
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
  };
  const answer = async (i: number, value: unknown, took = 50) => { now += took; calls[i].resolve(value); await flush(); };
  return { store, calls, timers, advance, answer, flush, nowRef: () => now };
}
const S = (paths: number) => ({ repo: true, branch: 'main', counts: { paths }, checkedAt: 1 });

// @req FR-GIT-011
test('FR-GIT-011: subscribers of one session share one request; hidden ones cause none', async () => {
  const h = harness();
  const a = h.store.subscribe('s1', { visible: true, running: false, mode: 'chip' }, () => {});
  const b = h.store.subscribe('s1', { visible: true, running: false, mode: 'menu' }, () => {});
  const hidden = h.store.subscribe('s2', { visible: false, running: true, mode: 'chip' }, () => {});
  await h.flush();
  assert.deepEqual(h.calls.map((c) => c.sessionId), ['s1']);
  await h.answer(0, S(1));
  assert.deepEqual(h.store.get('s1').summary, S(1));
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].at - h.nowRef(), 10_000);
  a.unsubscribe(); b.unsubscribe(); hidden.unsubscribe();
  assert.equal(h.timers.length, 0, 'no subscriber left: polling stops');
});

// @req FR-GIT-009
test('FR-GIT-009: running polls every 3 s, a status change or new cwd refreshes at once', async () => {
  const h = harness();
  const sub = h.store.subscribe('s1', { visible: true, running: true, mode: 'chip' }, () => {});
  await h.flush();
  await h.answer(0, S(1));
  assert.equal(h.timers[0].at - h.nowRef(), 3_000);
  await h.advance(3_000);
  assert.equal(h.calls.length, 2);
  await h.answer(1, S(2));
  sub.update({ visible: true, running: false, mode: 'chip' });
  h.store.notify('s1', { status: 'idle', cwd: 'C:\\r' });
  await h.flush();
  assert.equal(h.calls.length, 3, 'running -> idle refreshes at once');
  await h.answer(2, S(2));
  h.store.notify('s1', { status: 'idle', cwd: 'C:\\r' });
  await h.flush();
  assert.equal(h.calls.length, 3, 'nothing changed: no extra request');
  h.store.notify('s1', { status: 'idle', cwd: 'C:\\other' });
  await h.flush();
  assert.equal(h.calls.length, 4, 'a new cwd refreshes at once');
});

// @req FR-GIT-011
test('FR-GIT-011: becoming visible fetches; hiding stops the timer and aborts the request in flight', async () => {
  const h = harness();
  const sub = h.store.subscribe('s1', { visible: false, running: false, mode: 'chip' }, () => {});
  await h.flush();
  assert.equal(h.calls.length, 0);
  sub.update({ visible: true, running: false, mode: 'chip' });
  await h.flush();
  assert.equal(h.calls.length, 1);
  sub.update({ visible: false, running: false, mode: 'chip' });
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.timers.length, 0);
});

// @req FR-GIT-009
test('FR-GIT-009: an error after an answer keeps the data and marks it stale; listeners hear every change', async () => {
  const h = harness();
  let heard = 0;
  h.store.subscribe('s1', { visible: true, running: true, mode: 'chip' }, () => { heard += 1; });
  await h.flush();
  await h.answer(0, S(3));
  await h.advance(3_000);
  h.calls[1].reject(new GitApiError('GIT_TIMEOUT', 504));
  await h.flush();
  const v = h.store.get('s1');
  assert.deepEqual([v.summary, v.stale, v.error], [S(3), true, 'GIT_TIMEOUT']);
  assert.ok(heard >= 2);
});

// @req REL-BGSTAB-052
test('REL-BGSTAB-052 AC-4: a hidden document stops polling and aborts; becoming visible asks once at once', async () => {
  let hidden = false;
  let changed: () => void = () => {};
  const h = harness({ hidden: () => hidden, onChange: (fn) => { changed = fn; } });
  h.store.subscribe('s1', { visible: true, running: true, mode: 'chip' }, () => {});
  await h.flush();
  await h.answer(0, S(1));
  assert.equal(h.timers.length, 1);
  await h.advance(3_000);
  assert.equal(h.calls.length, 2, 'polling while visible');
  hidden = true; changed();
  assert.equal(h.calls[1].signal.aborted, true, 'the request in flight is aborted');
  assert.equal(h.timers.length, 0, 'no timer while hidden');
  await h.advance(60_000);
  assert.equal(h.calls.length, 2, 'no request while hidden');
  hidden = false; changed();
  await h.flush();
  assert.equal(h.calls.length, 3, 'one request when visible again');
});

// @req REL-BGSTAB-052
test('REL-BGSTAB-052 AC-5: an unchanged answer keeps the same object and tells nobody; a change does', async () => {
  const h = harness();
  let heard = 0;
  h.store.subscribe('s1', { visible: true, running: true, mode: 'chip' }, () => { heard += 1; });
  await h.flush();
  await h.answer(0, { ...S(1), checkedAt: 1 });
  const first = h.store.get('s1').summary;
  const heardAfterFirst = heard;
  await h.advance(3_000);
  await h.answer(1, { ...S(1), checkedAt: 2 });
  assert.equal(h.store.get('s1').summary, first, 'the same object when only checkedAt moved');
  assert.equal(heard, heardAfterFirst, 'no loading or result notification for an unchanged poll');
  assert.equal(h.store.get('s1').checkedAt, h.nowRef(), 'the check time still moves');
  await h.advance(3_000);
  await h.answer(2, S(2));
  assert.notEqual(h.store.get('s1').summary, first);
  assert.ok(heard > heardAfterFirst);
});

// @req REL-BGSTAB-052
test('REL-BGSTAB-052 AC-5: a failed poll keeps the last check time', async () => {
  const h = harness();
  h.store.subscribe('s1', { visible: true, running: true, mode: 'chip' }, () => {});
  await h.flush();
  await h.answer(0, S(1));
  const checked = h.store.get('s1').checkedAt;
  assert.equal(typeof checked, 'number');
  await h.advance(3_000);
  h.calls[1].reject(new GitApiError('GIT_TIMEOUT', 504));
  await h.flush();
  assert.equal(h.store.get('s1').error, 'GIT_TIMEOUT');
  assert.equal(h.store.get('s1').checkedAt, checked, 'the last successful check, not none');
});

// @req REL-BGSTAB-052
test('REL-BGSTAB-052 AC-4: coming back to the tab spreads the refreshes of many sessions', async () => {
  let hidden = false;
  let changed: () => void = () => {};
  const h = harness({ hidden: () => hidden, onChange: (fn) => { changed = fn; } });
  for (const id of ['s1', 's2', 's3', 's4']) h.store.subscribe(id, { visible: true, running: false, mode: 'chip' }, () => {});
  await h.flush();
  for (let i = 0; i < 4; i += 1) await h.answer(i, S(i));
  hidden = true; changed();
  hidden = false; changed();
  await h.flush();
  assert.equal(h.calls.length, 5, 'one session asks at once');
  await h.advance(1_000);
  assert.equal(h.calls.length, 8, 'the others follow within a second');
});
