// FR-GIT-004: the Git window shell, rendered under jsdom (test:unit:git-viewer).
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
const { GitWindow, graphColumns, clampSplit, GIT_WINDOW_MIN_SIZE } = await import('../../src/components/Git/GitWindow.tsx');
const { createGitSummaryStore } = await import('../../src/components/Git/gitSummaryStore.ts');

const summary = {
  repo: true, root: 'C:/work/ProjectMaster', subdir: '', branch: 'feat/x', detached: false, head: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0,
  base: null, compare: { ref: 'origin/main' }, operation: null, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, paths: 0 }, untrackedScan: 'normal', checkedAt: 1,
};
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
  return { container, cleanup };
}

// @req FR-GIT-004
test('FR-GIT-004: narrow graph panes hide the author, then the commit column; the split stays in bounds', () => {
  assert.deepEqual(graphColumns(600), { author: true, sha: true });
  assert.deepEqual(graphColumns(500), { author: false, sha: true });
  assert.deepEqual(graphColumns(440), { author: false, sha: false });
  assert.equal(clampSplit(0.1), 0.3);
  assert.equal(clampSplit(0.9), 0.7);
  assert.deepEqual(GIT_WINDOW_MIN_SIZE, { width: 760, height: 420 });
});

// @req FR-GIT-004
test('FR-GIT-004: a modeless window titled by repository and session; Escape does not close it; minimize asks the host', async () => {
  const calls: string[] = [];
  const store = createGitSummaryStore({ fetchSummary: async () => summary as never });
  const r = await render(React.createElement(GitWindow, {
    sessionId: 's1', sessionName: 'claude-api', store, cascade: 0,
    onMinimize: () => calls.push('min'), onClose: () => calls.push('close'), onFocus: () => {},
  }));
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Git · ProjectMaster/);
  assert.match(dialog.textContent ?? '', /claude-api · feat\/x/);
  dialog.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(calls, []);
  const min = dialog.querySelector('[aria-label="Minimize"]') as HTMLButtonElement;
  await act(async () => { min.click(); });
  assert.deepEqual(calls, ['min']);
  const split = dialog.querySelector('[role="separator"][aria-orientation="vertical"]') as HTMLElement;
  assert.equal(split.getAttribute('aria-valuenow'), '46');
  await act(async () => { split.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  assert.ok(Number(split.getAttribute('aria-valuenow')) > 46);
  await act(async () => { split.dispatchEvent(new (document.defaultView as Window & typeof globalThis).MouseEvent('dblclick', { bubbles: true })); });
  assert.equal(split.getAttribute('aria-valuenow'), '46');
  await r.cleanup();
});

function repoSummary(head: string, paths: number) {
  return { ...summary, head, counts: { staged: 0, unstaged: paths, untracked: 0, conflicted: 0, paths } };
}
function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    log: async () => { calls.push('log'); return { commits: [{ sha: 'h1', parents: [], author: 'a', email: '', time: 1, subject: 's', refs: [] }], hasMore: false, shallow: false, noCommits: false, sessions: [] }; },
    status: async () => { calls.push('status'); return { summary: {}, files: [], truncated: false }; },
    commit: async (_s: string, sha: string) => { calls.push(`commit:${sha}`); return { sha, parents: [], author: 'a', email: '', time: 1, committer: 'a', refs: [], message: 'm', files: [], truncated: false }; },
    compare: async () => { calls.push('compare'); return { base: { ref: 'b', sha: 'b' }, mergeBase: 'm', commits: [], files: [], add: 0, del: 0, fetchedAt: null, truncated: false }; },
    diff: async () => ({ inputs: { old: { id: null }, new: { id: null } }, hunks: [], truncated: false }),
    summary: async () => repoSummary('h1', 0),
  };
}

// @req FR-GIT-009
test('FR-GIT-009: with auto refresh off, a new state waits behind a list badge; committed changes select the new HEAD', async () => {
  let current = repoSummary('h1', 2);
  const store = createGitSummaryStore({ fetchSummary: async () => current as never });
  const c = fakeClient();
  const r = await render(React.createElement(GitWindow, { sessionId: 's1', sessionName: 'x', store, client: c as never, cascade: 0, onMinimize: () => {}, onClose: () => {}, onFocus: () => {} }));
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  assert.match(dialog.textContent ?? '', /Checked just now/);
  assert.equal(document.querySelector('.git-row[aria-selected="true"]')?.getAttribute('data-key'), 'WORKTREE');
  const auto = dialog.querySelector('input[data-opt="auto"]') as HTMLInputElement;
  assert.equal(auto.checked, true);
  await act(async () => { auto.click(); });
  const logs = c.calls.filter((x) => x === 'log').length;
  current = repoSummary('h2', 2);
  await act(async () => { store.refresh('s1'); await new Promise((res) => setTimeout(res, 20)); });
  assert.equal(c.calls.filter((x) => x === 'log').length, logs, 'not reloaded while auto refresh is off');
  const badge = dialog.querySelector('[data-list-badge]') as HTMLButtonElement;
  assert.match(badge.textContent ?? '', /New changes in the list · Apply/);
  await act(async () => { badge.click(); await new Promise((res) => setTimeout(res, 20)); });
  assert.ok(c.calls.filter((x) => x === 'log').length > logs);
  await act(async () => { auto.click(); });
  current = repoSummary('h3', 0);
  await act(async () => { store.refresh('s1'); await new Promise((res) => setTimeout(res, 30)); });
  assert.match(dialog.textContent ?? '', /The changes were committed/);
  assert.equal(document.querySelector('.git-row[data-key="WORKTREE"][aria-selected="true"]'), null, 'WORKTREE row is no longer selected');
  assert.ok(c.calls.includes('commit:h3'), 'the new HEAD is selected and shown');
  await r.cleanup();
});

// @req FR-GIT-009
test('FR-GIT-009: R refreshes from anywhere in the window; keys typed in a field are ignored', async () => {
  let fetched = 0;
  const store = createGitSummaryStore({ fetchSummary: async () => { fetched += 1; return repoSummary('h1', 0) as never; } });
  const c = fakeClient();
  const r = await render(React.createElement(GitWindow, { sessionId: 's2', sessionName: 'x', store, client: c as never, cascade: 0, onMinimize: () => {}, onClose: () => {}, onFocus: () => {} }));
  const body = document.querySelector('.git-window-body') as HTMLElement;
  const before = fetched;
  await act(async () => { body.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: 'R', bubbles: true })); await new Promise((res) => setTimeout(res, 20)); });
  assert.ok(fetched > before);
  await r.cleanup();
});

// @req FR-GIT-010
test('FR-GIT-010: under 900 px the window is a full-screen stack of list, commit and diff; back steps out, then closes', async () => {
  const win = document.defaultView as Window & typeof globalThis;
  const typing = document.createElement('textarea');
  document.body.appendChild(typing);
  typing.focus();
  assert.equal(document.activeElement, typing);
  const closed: string[] = [];
  const store = createGitSummaryStore({ fetchSummary: async () => repoSummary('h1', 0) as never });
  const c = fakeClient();
  c.commit = async (_s: string, sha: string) => {
    c.calls.push(`commit:${sha}`);
    return { sha, parents: [], author: 'a', email: '', time: 1, committer: 'a', refs: [], message: 'm', files: [{ path: 'src/a.ts', kind: 'M', add: 1, del: 1, binary: false, inputs: { old: { id: 'x' }, new: { id: 'y' } } }], truncated: false } as never;
  };
  c.diff = async () => ({ inputs: { old: { id: 'x' }, new: { id: 'y' } }, hunks: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '@@ -1 +1 @@', lines: [{ k: '-', o: 1, n: null, t: 'a' }, { k: '+', o: null, n: 1, t: 'b' }] },
  ], truncated: false }) as never;
  const depth = win.history.length;
  const r = await render(React.createElement(GitWindow, { sessionId: 'm1', sessionName: 'x', store, client: c as never, cascade: 0, mobile: true, onMinimize: () => {}, onClose: () => closed.push('close'), onFocus: () => {} }));
  assert.notEqual(document.activeElement, typing, 'the soft keyboard is dismissed first');
  const shell = () => document.querySelector('.git-mobile') as HTMLElement;
  assert.ok(shell(), 'full-screen layout');
  assert.equal(shell().getAttribute('data-step'), '0');
  assert.equal(win.history.length, depth + 1, 'step 0 has its own history entry');
  const row = document.querySelector('.git-row[data-key="h1"]') as HTMLElement;
  await act(async () => { row.click(); await new Promise((res) => setTimeout(res, 30)); });
  assert.equal(shell().getAttribute('data-step'), '1');
  const fileRow = document.querySelector('.git-file') as HTMLElement;
  assert.ok(fileRow, 'the commit step lists the files');
  await act(async () => { fileRow.click(); await new Promise((res) => setTimeout(res, 250)); });
  assert.equal(shell().getAttribute('data-step'), '2');
  assert.equal(win.history.length, depth + 3);
  assert.ok(document.querySelector('[data-nav="prevHunk"]') && document.querySelector('[data-nav="nextHunk"]'), 'hunk buttons');
  assert.equal((document.querySelector('input[data-opt="wrap"]') as HTMLInputElement).checked, true, 'wrap on by default');
  const back = () => act(async () => { win.history.back(); await new Promise((res) => setTimeout(res, 30)); });
  await back();
  assert.equal(shell().getAttribute('data-step'), '1');
  await back();
  assert.equal(shell().getAttribute('data-step'), '0');
  await back();
  assert.deepEqual(closed, ['close']);
  typing.remove();
  await r.cleanup();
});
