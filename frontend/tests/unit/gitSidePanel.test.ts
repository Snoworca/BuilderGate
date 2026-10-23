// FR-GIT-006: commit detail and file list of the Git window, rendered under jsdom (test:unit:git-viewer).
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
const { GitSidePanel } = await import('../../src/components/Git/GitSidePanel.tsx');

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
const inputs = { old: { id: 'o' }, new: { id: 'n' } };
const STATUS = {
  summary: {}, truncated: false, files: [
    { path: 'src/a.ts', kind: 'M', area: 'staged', add: 4, del: 2, binary: false, inputs },
    { path: 'src/a.ts', kind: 'M', area: 'unstaged', add: 1, del: 0, binary: false, inputs },
    { path: 'lib/new.ts', origPath: 'lib/old.ts', similarity: 92, kind: 'R', area: 'staged', add: 2, del: 2, binary: false, inputs },
    { path: 'n.txt', kind: '?', area: 'untracked', add: 3, del: 0, binary: false, inputs },
  ],
};
const COMMIT = (sha: string, parents: string[]) => ({ sha, parents, author: 'Kim', email: 'k@x', time: 1761200000, committer: 'Kim', refs: [], message: `subject ${sha}\n\nbody line`, truncated: false,
  files: [{ path: 'img.png', kind: 'A', add: 0, del: 0, binary: true }, { path: 'x/y/z.ts', kind: 'D', add: 0, del: 9, binary: false }] });
function client() {
  const calls: string[] = [];
  return {
    calls,
    status: async () => { calls.push('status'); return STATUS; },
    commit: async (_s: string, sha: string) => { calls.push(`commit:${sha}`); return sha === 'root1' ? COMMIT(sha, []) : sha === 'merge1' ? COMMIT(sha, ['p1', 'p2']) : COMMIT(sha, ['p1']); },
    compare: async (_s: string, wt: boolean) => { calls.push(`compare:${wt}`); return { base: { ref: 'origin/main', sha: 'b' }, mergeBase: 'mb1234567', commits: ['c1', 'c2'], files: [{ path: 'f.ts', kind: 'A', add: 5, del: 0, binary: false }], add: 5, del: 0, fetchedAt: null, truncated: false }; },
  };
}
const summary = { repo: true, root: 'C:/r', subdir: '', branch: 'feat', detached: false, head: 'h', upstream: null, ahead: 0, behind: 0, base: null, compare: { ref: 'origin/main' }, operation: null, counts: { staged: 2, unstaged: 1, untracked: 1, conflicted: 0, paths: 4 }, untrackedScan: 'normal', checkedAt: 1 };
const base = (c: ReturnType<typeof client>, selected: string, extra: Record<string, unknown> = {}) => ({
  sessionId: 's1', client: c as never, summary: summary as never, selected, reloadKey: 0, onSelectCommit: () => {}, diff: () => null, ...extra,
});

// @req FR-GIT-006
test('FR-GIT-006: the uncommitted changes are grouped by area with each group\'s base; renames show both names', async () => {
  const c = client();
  const r = await render(React.createElement(GitSidePanel, base(c, 'WORKTREE')));
  const groups = [...r.container.querySelectorAll('.git-files-group')].map((e) => e.textContent);
  assert.deepEqual(groups, ['Staged 2HEAD ↔ index', 'Not staged 1index ↔ working tree', 'Untracked 1new files']);
  const rows = [...r.container.querySelectorAll('.git-file')];
  assert.equal(rows.length, 4);
  assert.match(rows[1].textContent ?? '', /old\.ts → new\.ts/);
  assert.match(rows[1].textContent ?? '', /R92%/);
  assert.equal(rows[0].getAttribute('aria-selected'), 'true', 'the first file is selected');
  assert.match(r.container.querySelector('.git-detail')?.textContent ?? '', /Uncommitted changes 4/);
});

// @req FR-GIT-006
test('FR-GIT-006: a commit shows its message, parents as links, and binary/deleted files', async () => {
  const c = client();
  const picked: string[] = [];
  const r = await render(React.createElement(GitSidePanel, base(c, 'abc1234', { onSelectCommit: (s: string) => picked.push(s) })));
  const detail = r.container.querySelector('.git-detail')?.textContent ?? '';
  assert.match(detail, /subject abc1234/);
  assert.match(detail, /body line/);
  (r.container.querySelector('[data-parent="p1"]') as HTMLButtonElement).click();
  assert.deepEqual(picked, ['p1']);
  assert.match(r.container.querySelector('.git-files')?.textContent ?? '', /binary/);
  await r.cleanup();
  const merge = await render(React.createElement(GitSidePanel, base(client(), 'merge1')));
  assert.match(merge.container.querySelector('.git-detail')?.textContent ?? '', /Merge commit · changes against first parent p1/);
  await merge.cleanup();
  const root = await render(React.createElement(GitSidePanel, base(client(), 'root1')));
  assert.match(root.container.querySelector('.git-detail')?.textContent ?? '', /first commit, compared with an empty tree/);
});

// @req FR-GIT-006, FR-GIT-008
test('FR-GIT-006/008: the comparison summary and its working-tree toggle', async () => {
  const c = client();
  const r = await render(React.createElement(GitSidePanel, base(c, 'CMP')));
  assert.match(r.container.querySelector('.git-detail')?.textContent ?? '', /feat — compare: origin\/main/);
  const toggle = r.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => { toggle.click(); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  assert.deepEqual(c.calls, ['compare:false', 'compare:true']);
});

// @req FR-GIT-006
test('FR-GIT-006: files are a listbox; arrows move the selection, which survives a reload', async () => {
  const c = client();
  const seen: string[] = [];
  const props = base(c, 'WORKTREE', { diff: (f: { key: string } | null) => { if (f) seen.push(f.key); return null; } });
  const r = await render(React.createElement(GitSidePanel, props));
  const list = r.container.querySelector('.git-files[role="listbox"]') as HTMLElement;
  await act(async () => { list.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  assert.equal(seen.at(-1), 'staged:lib/new.ts');
  await act(async () => { r.root.render(React.createElement(GitSidePanel, { ...props, reloadKey: 1 })); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  assert.equal(seen.at(-1), 'staged:lib/new.ts');
  assert.equal(list.getAttribute('aria-activedescendant'), r.container.querySelector('.git-file[aria-selected="true"]')?.id);
});
