// FR-GIT-005, FR-GIT-008: the commit list of the Git window, rendered under jsdom (test:unit:git-viewer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();
const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
const { installCatalog } = await import('../../src/i18n/i18n.ts');
installCatalog('en', en);
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { GitGraphList } = await import('../../src/components/Git/GitGraphList.tsx');

const mounted = new Set<() => Promise<void>>();
test.afterEach(async () => { for (const c of [...mounted]) await c(); });
async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const cleanup = async () => { if (!mounted.delete(cleanup)) return; await act(async () => { root.unmount(); }); container.remove(); };
  mounted.add(cleanup);
  return { container, root, cleanup };
}
const W = () => document.defaultView as Window & typeof globalThis;
const key = (el: Element, k: string) => el.dispatchEvent(new (W().KeyboardEvent)('keydown', { key: k, bubbles: true, cancelable: true }));

const commit = (sha: string, parents: string[], subject: string, refs: Array<{ kind: string; name: string }> = []) => ({ sha, parents, author: 'a', email: 'a@x', time: 1761200000, subject, refs });
const LOG = [
  commit('c3', ['c2'], 'third', [{ kind: 'head', name: 'main' }, { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1' }, { kind: 'local', name: 'x' }]),
  commit('c2', ['c1'], 'second'),
  commit('c1', [], 'first'),
];
function client(pages: Record<string, { commits: unknown[]; hasMore: boolean }> = {}) {
  const calls: Array<{ scope: string; after?: string }> = [];
  return {
    calls,
    log: async (_s: string, q: { scope: string; after?: string }) => {
      calls.push({ scope: q.scope, after: q.after });
      const page = pages[q.after ?? 'first'] ?? { commits: LOG, hasMore: false };
      return { ...page, shallow: false, noCommits: false, sessions: [] };
    },
    compare: async () => ({ base: { ref: 'origin/main', sha: 'c1' }, mergeBase: 'c1', commits: ['c3', 'c2'], files: [], add: 0, del: 0, fetchedAt: null, truncated: false }),
  };
}
const summary = (paths = 2, compare: unknown = { ref: 'origin/main' }) => ({
  repo: true, root: 'C:/r', subdir: '', branch: 'main', detached: false, head: 'c3', upstream: null, ahead: 0, behind: 0, base: null,
  compare, operation: null, counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0, paths }, untrackedScan: 'normal', checkedAt: 1,
});

// @req FR-GIT-005
test('FR-GIT-005: rows with the uncommitted row first, ref badges, keyboard selection', async () => {
  const c = client();
  const picked: string[] = [];
  const props = { sessionId: 's1', client: c as never, summary: summary() as never, scope: 'head' as const, onScope: () => {}, selected: 'WORKTREE', onSelect: (k: string) => picked.push(k), width: 600, reloadKey: 0, nameOf: (s: string) => s };
  const r = await render(React.createElement(GitGraphList, props));
  const list = r.container.querySelector('[role="listbox"]') as HTMLElement;
  const rows = [...list.querySelectorAll('[role="option"]')];
  assert.deepEqual(rows.map((e) => e.getAttribute('data-key')), ['WORKTREE', 'c3', 'c2', 'c1']);
  assert.match(rows[0].textContent ?? '', /Uncommitted changes \(2\)/);
  assert.equal(list.getAttribute('aria-activedescendant'), rows[0].id);
  assert.ok(rows[1].querySelector('.git-ref[data-kind="head"]'), 'HEAD badge');
  assert.ok(rows[1].querySelector('.git-ref[data-more]'), 'overflowing badges fold into +n');
  await act(async () => { key(list, 'ArrowDown'); });
  await act(async () => { key(list, 'End'); });
  assert.deepEqual(picked, ['c3', 'c1']);
});

// @req FR-GIT-005
test('FR-GIT-005: a selection is kept by sha when commits arrive on top; a vanished sha keeps a row', async () => {
  const c = client();
  const base = { sessionId: 's1', client: c as never, summary: summary(0) as never, scope: 'head' as const, onScope: () => {}, onSelect: () => {}, width: 600, nameOf: (s: string) => s };
  const r = await render(React.createElement(GitGraphList, { ...base, selected: 'c2', reloadKey: 0 }));
  const sel = () => r.container.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-key');
  assert.equal(sel(), 'c2');
  LOG.unshift(commit('c4', ['c3'], 'fourth'));
  await act(async () => { r.root.render(React.createElement(GitGraphList, { ...base, selected: 'c2', reloadKey: 1 })); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  assert.equal(sel(), 'c2');
  await act(async () => { r.root.render(React.createElement(GitGraphList, { ...base, selected: 'gone1', vanished: { sha: 'gone1', subject: 'amended away' }, reloadKey: 2 })); });
  const first = r.container.querySelector('[role="option"]');
  assert.equal(first?.getAttribute('data-key'), 'gone1');
  assert.match(first?.textContent ?? '', /Not on branch · amended away/);
  LOG.shift();
});

// @req FR-GIT-008
test('FR-GIT-008: scope buttons; compare says why it is off; rows outside the range are marked', async () => {
  const c = client();
  const scopes: string[] = [];
  const blocked = await render(React.createElement(GitGraphList, { sessionId: 's1', client: c as never, summary: summary(0, { blocked: 'sameAsBase' }) as never, scope: 'head' as const, onScope: (s: string) => scopes.push(s), selected: 'c3', onSelect: () => {}, width: 600, reloadKey: 0, nameOf: (s: string) => s }));
  const cmp = blocked.container.querySelector('[data-scope="cmp"]') as HTMLButtonElement;
  assert.equal(cmp.disabled, true);
  assert.equal(cmp.title, 'The current branch is the base');
  (blocked.container.querySelector('[data-scope="all"]') as HTMLButtonElement).click();
  assert.deepEqual(scopes, ['all']);
  await blocked.cleanup();
  const inCmp = await render(React.createElement(GitGraphList, { sessionId: 's1', client: c as never, summary: summary(0) as never, scope: 'cmp' as const, onScope: () => {}, selected: 'c3', onSelect: () => {}, width: 600, reloadKey: 0, nameOf: (s: string) => s }));
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  const marks = [...inCmp.container.querySelectorAll('[role="option"]')].map((e) => [e.getAttribute('data-key'), e.getAttribute('data-range')]);
  assert.deepEqual(marks, [['c3', 'in'], ['c2', 'in'], ['c1', 'out']]);
});

// @req FR-GIT-005
test('FR-GIT-005: more pages load after the last commit', async () => {
  const c = client({ first: { commits: LOG.slice(0, 2), hasMore: true }, c2: { commits: LOG.slice(2), hasMore: false } });
  const r = await render(React.createElement(GitGraphList, { sessionId: 's1', client: c as never, summary: summary(0) as never, scope: 'head' as const, onScope: () => {}, selected: 'c3', onSelect: () => {}, width: 600, reloadKey: 0, nameOf: (s: string) => s }));
  const more = r.container.querySelector('[data-load-more]') as HTMLButtonElement;
  assert.ok(more);
  await act(async () => { more.click(); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  assert.deepEqual(c.calls.map((x) => x.after), [undefined, 'c2']);
  assert.equal(r.container.querySelectorAll('[role="option"]').length, 3);
});
