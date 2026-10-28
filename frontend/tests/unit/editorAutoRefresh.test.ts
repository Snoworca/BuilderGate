// FR-MDE-030: the editor window follows its file on disk. The decisions are pure; the watcher
// is driven here with a hand-run clock and a stand-in stat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_REFRESH_KEY,
  compareFileStamp,
  createAutoRefreshStore,
  createEditorFileWatcher,
  decideExternalAction,
  nextPollDelay,
  type FileStamp,
  type StatResult,
} from '../../src/components/editor/editorAutoRefresh.ts';

const A: FileStamp = { modified: '2026-10-28T01:00:00.000Z', size: 10 };
const B: FileStamp = { modified: '2026-10-28T01:00:05.000Z', size: 12 };

// @req FR-MDE-030
test('FR-MDE-030 AC-2/AC-5: a stamp is compared by time and size; a missing file is deleted', () => {
  assert.equal(compareFileStamp(null, A), 'baseline');
  assert.equal(compareFileStamp(A, { ...A }), 'same');
  assert.equal(compareFileStamp(A, B), 'changed');
  assert.equal(compareFileStamp(A, { ...A, size: 11 }), 'changed', 'same time, other size');
  assert.equal(compareFileStamp(A, 'missing'), 'deleted');
  assert.equal(compareFileStamp(null, 'missing'), 'deleted');
  assert.equal(compareFileStamp('missing', 'missing'), 'same', 'asked once, not every poll');
  assert.equal(compareFileStamp('missing', A), 'changed', 'it came back');
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3~AC-6: clean tabs follow the file, tabs with unsaved edits ask', () => {
  assert.equal(decideExternalAction({ change: 'changed', dirty: false }), 'reload');
  assert.equal(decideExternalAction({ change: 'changed', dirty: true }), 'ask-reload');
  assert.equal(decideExternalAction({ change: 'deleted', dirty: false }), 'close');
  assert.equal(decideExternalAction({ change: 'deleted', dirty: true }), 'ask-deleted');
  assert.equal(decideExternalAction({ change: 'same', dirty: true }), 'none');
  assert.equal(decideExternalAction({ change: 'baseline', dirty: false }), 'none');
});

// @req FR-MDE-030
test('FR-MDE-030 AC-2: every 2 s, longer after a slow answer, at most 30 s', () => {
  assert.equal(nextPollDelay(50), 2000);
  assert.equal(nextPollDelay(1000), 5000);
  assert.equal(nextPollDelay(20000), 30000);
});

// @req FR-MDE-030
test('FR-MDE-030 AC-1: on by default, kept in this browser, heard by every window', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  const store = createAutoRefreshStore(() => storage);
  assert.equal(store.get(), true);
  let heard = 0;
  store.subscribe(() => { heard += 1; });
  store.set(false);
  assert.equal(store.get(), false);
  assert.equal(data.get(AUTO_REFRESH_KEY), '0');
  assert.equal(heard, 1);
  assert.equal(createAutoRefreshStore(() => storage).get(), false, 'read back');
});

function harness(answers: StatResult[]) {
  const timers: { fn: () => void; ms: number }[] = [];
  const actions: string[] = [];
  const stats: string[] = [];
  let dirty = false;
  const watcher = createEditorFileWatcher({
    stat: async (sessionId, path) => {
      stats.push(`${sessionId}:${path}`);
      const next = answers.shift();
      if (next === undefined) throw new Error('no more answers');
      return next;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    now: () => 0,
    onAction: (action, filePath) => actions.push(`${action}:${filePath}`),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async () => {
    const timer = timers.shift();
    assert.ok(timer, 'a poll is scheduled');
    timer.fn();
    await flush();
  };
  return { watcher, actions, stats, timers, tick, flush, setDirty: (d: boolean) => { dirty = d; }, isDirty: () => dirty };
}

// @req FR-MDE-030
test('FR-MDE-030 AC-2/AC-3: the first answer is the baseline; a later change reloads a clean tab', async () => {
  const h = harness([A, A, B]);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  assert.deepEqual(h.actions, []);
  assert.equal(h.timers[0]?.ms, 2000);
  await h.tick();
  assert.deepEqual(h.actions, []);
  await h.tick();
  assert.deepEqual(h.actions, ['reload:/w/a.md']);
  h.watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-4/AC-6: unsaved edits ask once per change, and a deletion asks once', async () => {
  const h = harness([A, B, B, 'missing', 'missing', 'missing']);
  h.setDirty(true);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  await h.tick();
  await h.tick();
  await h.tick();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.actions, ['ask-reload:/w/a.md', 'ask-deleted:/w/a.md']);
  h.watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-5: a clean deleted file closes once it is still gone a moment later, and the watch stops', async () => {
  const h = harness([A, 'missing', 'missing']);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  await h.tick();
  assert.deepEqual(h.actions, [], 'one missing answer is not yet a deletion');
  assert.ok(h.timers[0].ms < 2000, 'it is checked again soon');
  await h.tick();
  assert.deepEqual(h.actions, ['close:/w/a.md']);
  assert.equal(h.timers.length, 0, 'nothing more is asked about a closed tab');
});

// @req FR-MDE-030
test('FR-MDE-030 AC-2: an own save is not a change -- polls wait for it, then its stamp is the baseline', async () => {
  const h = harness([A, B]);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  let finishWrite: () => void = () => {};
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  h.watcher.noteSave('/w/a.md', 's', write);
  await h.tick();
  assert.equal(h.stats.length, 1, 'no poll while the write is out');
  finishWrite();
  await h.flush();
  await h.flush();
  assert.equal(h.stats.length, 2, 'the saved file is stat-ed once');
  assert.deepEqual(h.actions, [], 'and taken as the new baseline');
  h.watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-1/AC-2: watching nothing (off, hidden, no tab) asks nothing; a failed stat just waits', async () => {
  const h = harness([]);
  h.watcher.watch(null);
  await h.flush();
  assert.equal(h.stats.length, 0);
  assert.equal(h.timers.length, 0);
  const g = harness([]);
  g.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: g.isDirty });
  await g.flush();
  assert.equal(g.timers.length, 1, 'an error waits for the next poll');
  assert.deepEqual(g.actions, []);
  g.watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3/AC-5: a file missing for a moment (write a temp file, then rename) is a change, not a deletion', async () => {
  const h = harness([A, 'missing', B]);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.actions, ['reload:/w/a.md']);
  h.watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-2: an answer sent before a save that finished meanwhile is dropped, not taken as a change', async () => {
  let release: (v: StatResult) => void = () => {};
  const answers: (StatResult | Promise<StatResult>)[] = [A, new Promise<StatResult>((r) => { release = r; }), B];
  const actions: string[] = [];
  const timers: (() => void)[] = [];
  const watcher = createEditorFileWatcher({
    stat: async () => answers.shift() as StatResult,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    now: () => 0,
    onAction: (a, p) => actions.push(`${a}:${p}`),
  });
  const flush = () => new Promise((r) => setImmediate(r));
  watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: () => false });
  await flush();
  timers.shift()!(); // the poll whose answer is held back
  await flush();
  watcher.noteSave('/w/a.md', 's', Promise.resolve()); // saves, stat-ed as B
  await flush();
  await flush();
  release(A); // the old answer arrives after the save settled
  await flush();
  assert.deepEqual(actions, [], 'the stale answer is not a change');
  watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-2: a failed save keeps the old baseline, so an outside change made meanwhile is still seen', async () => {
  const h = harness([A, B]);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  h.watcher.noteSave('/w/a.md', 's', Promise.reject(new Error('disk full')));
  await h.flush();
  await h.flush();
  assert.equal(h.stats.length, 1, 'a failed write is not stat-ed as the baseline');
  await h.tick();
  assert.deepEqual(h.actions, ['reload:/w/a.md']);
  h.watcher.stop();
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3: a reload that failed is tried again on the next check', async () => {
  const h = harness([A, B, B]);
  h.watcher.watch({ filePath: '/w/a.md', sessionId: 's', isDirty: h.isDirty });
  await h.flush();
  await h.tick();
  assert.deepEqual(h.actions, ['reload:/w/a.md']);
  h.watcher.retry('/w/a.md');
  await h.tick();
  assert.deepEqual(h.actions, ['reload:/w/a.md', 'reload:/w/a.md']);
  h.watcher.stop();
});
