import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileSearchController, type FileSearchApi, type FileSearchView } from '../../src/components/fileExplorer/fileSearchController.ts';

// FR-FEX-013 — the browser half: start, poll until done, show results as they arrive, cancel.

function fakeApi(pages: Array<{ results: string[]; done: boolean; outcome?: string }>) {
  const calls: string[] = [];
  let pageIndex = 0;
  const api: FileSearchApi = {
    start: async (_s, input) => { calls.push(`start:${input.path}:${input.query}:${input.includeIgnored}`); return { searchId: 'q1' }; },
    poll: async (_s, id, after) => {
      calls.push(`poll:${id}:${after}`);
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      const results = page.results.map((name) => ({ name, relativePath: name, path: `/r/${name}`, type: 'file' as const }));
      return { results, next: after + results.length, total: after + results.length, examined: 10 * pageIndex, currentPath: 'x', done: page.done, outcome: (page.outcome ?? (page.done ? 'completed' : 'running')) as never };
    },
    cancel: async (_s, id) => { calls.push(`cancel:${id}`); },
  };
  return { api, calls };
}

function run(api: FileSearchApi) {
  const views: FileSearchView[] = [];
  const timers: Array<() => void> = [];
  const controller = createFileSearchController({
    sessionId: 's',
    api,
    onChange: (view) => views.push(view),
    schedule: (fn) => { timers.push(fn); return timers.length; },
    unschedule: () => {},
  });
  const tick = async () => { const fn = timers.shift(); fn?.(); await new Promise((r) => setTimeout(r, 0)); };
  return { controller, views, tick, get last() { return views[views.length - 1]; } };
}

test('FR-FEX-013 AC-2/AC-3 results accumulate across polls with progress, until done', async () => {
  const { api, calls } = fakeApi([{ results: ['a'], done: false }, { results: ['b', 'c'], done: false }, { results: [], done: true }]);
  const h = run(api);
  await h.controller.start({ path: '/r', query: 'x', includeIgnored: false });
  assert.equal(h.last.running, true);
  await h.tick();
  await h.tick();
  assert.deepEqual(h.last.results.map((r) => r.name), ['a', 'b', 'c']);
  assert.equal(h.last.examined > 0, true);
  await h.tick();
  assert.equal(h.last.running, false);
  assert.equal(h.last.outcome, 'completed');
  assert.deepEqual(calls.filter((c) => c.startsWith('poll')), ['poll:q1:0', 'poll:q1:1', 'poll:q1:3']);
});

test('FR-FEX-013 AC-4 cancel tells the server and stops polling; later answers are ignored', async () => {
  const { api, calls } = fakeApi([{ results: ['a'], done: false }]);
  const h = run(api);
  await h.controller.start({ path: '/r', query: 'x', includeIgnored: false });
  await h.controller.cancel();
  assert.ok(calls.includes('cancel:q1'));
  assert.equal(h.last.running, false);
  assert.equal(h.last.outcome, 'cancelled');
  const before = calls.length;
  await h.tick();
  assert.equal(calls.filter((c) => c.startsWith('poll')).length, calls.slice(0, before).filter((c) => c.startsWith('poll')).length, 'no poll after cancel');
});

test('FR-FEX-013 AC-5 the include-ignored toggle is passed to the server', async () => {
  const { api, calls } = fakeApi([{ results: [], done: true }]);
  const h = run(api);
  await h.controller.start({ path: '/r', query: 'cfg', includeIgnored: true });
  assert.equal(calls[0], 'start:/r:cfg:true');
});

test('FR-FEX-013 a new search replaces the previous one and its late pages are dropped', async () => {
  const { api } = fakeApi([{ results: ['old'], done: false }]);
  const h = run(api);
  await h.controller.start({ path: '/r', query: 'one', includeIgnored: false });
  await h.controller.start({ path: '/r', query: 'two', includeIgnored: false });
  assert.equal(h.last.query, 'two');
  assert.deepEqual(h.last.results, []);
});
