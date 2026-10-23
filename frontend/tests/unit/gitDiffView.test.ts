// FR-GIT-007: the diff view, rendered under jsdom (test:unit:git-viewer).
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
const { GitDiffView, diffRequestFor } = await import('../../src/components/Git/GitDiffView.tsx');
const { wordDiff } = await import('../../src/components/Git/gitDiffModel.ts');

const mounted = new Set<() => Promise<void>>();
test.afterEach(async () => { for (const c of [...mounted]) await c(); });
async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
  const cleanup = async () => { if (!mounted.delete(cleanup)) return; await act(async () => { root.unmount(); }); container.remove(); };
  mounted.add(cleanup);
  return { container, root, cleanup };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });
const L = (k: string, o: number | null, n: number | null, t: string) => ({ k, o, n, t });
const HUNKS = [
  { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, header: '@@ -1,2 +1,2 @@ first', lines: [L('-', 1, null, 'const rows = [];'), L('+', null, 1, 'const rows: Row[] = [];'), L(' ', 2, 2, 'x')] },
  { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, header: '@@ -20 +20 @@ second', lines: [L('-', 20, null, 'a'), L('+', null, 20, 'b')] },
];
function client(answer: (q: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  return { calls, diff: async (_s: string, q: Record<string, unknown>) => { calls.push(q); return answer(q); } };
}
const file = (over: Record<string, unknown> = {}) => ({ key: 'unstaged:src/a.ts', area: 'unstaged', kind: 'M', path: 'src/a.ts', add: 2, del: 2, binary: false, ...over });
const props = (c: unknown, f: unknown, over: Record<string, unknown> = {}) => ({
  sessionId: 's1', client: c as never, file: f as never, selected: 'WORKTREE', wt: false, reloadKey: 0, width: 900,
  position: { index: 0, total: 3 }, onMoveFile: () => {}, onOpenEditor: undefined, ...over,
});

// @req FR-GIT-007
test('FR-GIT-007: the request follows the selection and the file area', () => {
  assert.deepEqual(diffRequestFor('WORKTREE', false, file() as never), { src: 'unstaged', path: 'src/a.ts' });
  assert.deepEqual(diffRequestFor('WORKTREE', false, file({ area: 'staged', path: 'b.ts', origPath: 'a.ts', kind: 'R' }) as never), { src: 'staged', path: 'b.ts', origPath: 'a.ts' });
  assert.deepEqual(diffRequestFor('WORKTREE', false, file({ area: 'untracked', kind: '?' }) as never), { src: 'untracked', path: 'src/a.ts' });
  assert.deepEqual(diffRequestFor('abc1234', false, file({ area: null }) as never), { src: 'commit', sha: 'abc1234', path: 'src/a.ts' });
  assert.deepEqual(diffRequestFor('CMP', true, file({ area: null }) as never), { src: 'cmp', wt: true, path: 'src/a.ts' });
});

// @req FR-GIT-007
test('FR-GIT-007: unified lines with two line numbers, word marks, hunk headers and the position', async () => {
  const c = client(() => ({ inputs: { old: { id: 'a' }, new: { id: null } }, hunks: HUNKS, truncated: false, gapAfter: 0 }));
  const r = await render(React.createElement(GitDiffView, props(c, file())));
  const lines = [...r.container.querySelectorAll('.git-dl')];
  assert.equal(lines.length, 5);
  assert.deepEqual([...lines[0].querySelectorAll('.git-dl-no')].map((e) => e.textContent), ['1', '']);
  // The rendered marks are exactly the model's word ranges for this pair.
  const added = 'const rows: Row[] = [];';
  const expected = wordDiff('const rows = [];', added)!.new.map(([a, b]) => added.slice(a, b));
  assert.ok(expected.length > 0);
  assert.deepEqual([...lines[1].querySelectorAll('mark')].map((m) => m.textContent), expected);
  assert.equal(r.container.querySelectorAll('.git-hunk').length, 2);
  assert.match(r.container.querySelector('.git-diff-head')?.textContent ?? '', /File 1\/3 · hunk 1\/2/);
  assert.match(r.container.querySelector('.git-diff-head')?.textContent ?? '', /src\/a\.ts/);
});

// @req FR-GIT-007
test('FR-GIT-007: ignoring whitespace asks the server again; a whitespace-only change says so', async () => {
  const c = client((q) => (q.ignoreWs ? { inputs: { old: { id: 'a' }, new: { id: null } }, hunks: [], special: { kind: 'wsOnly' }, truncated: false } : { inputs: { old: { id: 'a' }, new: { id: null } }, hunks: HUNKS, truncated: false }));
  const r = await render(React.createElement(GitDiffView, props(c, file())));
  const ws = r.container.querySelector('input[data-opt="ws"]') as HTMLInputElement;
  await act(async () => { ws.click(); });
  await settle();
  assert.equal(c.calls.at(-1)?.ignoreWs, true);
  assert.match(r.container.querySelector('.git-notice')?.textContent ?? '', /Whitespace changes only/);
  assert.match(r.container.querySelector('.git-diff-head')?.textContent ?? '', /ignoring whitespace/);
});

// @req FR-GIT-007
test('FR-GIT-007: special files show a notice; a large diff expands on request', async () => {
  const specials: Array<[unknown, RegExp]> = [
    [{ kind: 'binary', from: 0, to: 188416 }, /Binary file · 0 B → 184 KB/],
    [{ kind: 'mode', from: '100644', to: '100755' }, /Permissions changed only · 100644 → 100755/],
    [{ kind: 'symlink', from: '../a', to: '../b' }, /Symbolic link/],
    [{ kind: 'lfs', from: 100, to: 200 }, /Git LFS file/],
    [{ kind: 'submodule', from: '3f2a1c0', to: '9e8d7b6' }, /Submodule pointer · 3f2a1c0 → 9e8d7b6/],
    [{ kind: 'encoding' }, /Not UTF-8/],
    [{ kind: 'emptyNew' }, /Empty file added/],
  ];
  for (const [special, text] of specials) {
    const r = await render(React.createElement(GitDiffView, props(client(() => ({ inputs: { old: { id: 'a' }, new: { id: 'b' } }, hunks: [], special, truncated: false })), file())));
    assert.match(r.container.querySelector('.git-notice')?.textContent ?? '', text);
    await r.cleanup();
  }
  const c = client((q) => (q.force ? { inputs: { old: { id: 'a' }, new: { id: null } }, hunks: HUNKS, truncated: false } : { inputs: { old: { id: 'a' }, new: { id: null } }, hunks: [], special: { kind: 'large', add: 1204, del: 388 }, truncated: true }));
  const r = await render(React.createElement(GitDiffView, props(c, file())));
  const expand = r.container.querySelector('[data-force]') as HTMLButtonElement;
  await act(async () => { expand.click(); });
  await settle();
  assert.equal(c.calls.at(-1)?.force, true);
  assert.equal(r.container.querySelectorAll('.git-dl').length, 5);
});

// @req FR-GIT-007
test('FR-GIT-007: n/p move between hunks; previous/next file buttons; narrow panes fold the options into a View menu', async () => {
  const c = client(() => ({ inputs: { old: { id: 'a' }, new: { id: null } }, hunks: HUNKS, truncated: false }));
  const moved: number[] = [];
  const r = await render(React.createElement(GitDiffView, props(c, file(), { onMoveFile: (d: number) => moved.push(d), width: 500 })));
  const body = r.container.querySelector('.git-diff-body') as HTMLElement;
  await act(async () => { body.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: 'n', bubbles: true })); });
  assert.match(r.container.querySelector('.git-diff-head')?.textContent ?? '', /hunk 2\/2/);
  (r.container.querySelector('[data-nav="next"]') as HTMLButtonElement).click();
  (r.container.querySelector('[data-nav="prev"]') as HTMLButtonElement).click();
  assert.deepEqual(moved, [1, -1]);
  assert.ok(r.container.querySelector('details.git-view-menu'), 'View menu when narrow');
});

// @req FR-GIT-007
test('FR-GIT-007: more than 2,000 rows draw only a window of them', async () => {
  const many = Array.from({ length: 3000 }, (_, i) => L('+', null, i + 1, `line ${i}`));
  const c = client(() => ({ inputs: { old: { id: null }, new: { id: null } }, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3000, header: '@@ -0,0 +1,3000 @@', lines: many }], truncated: false }));
  const r = await render(React.createElement(GitDiffView, props(c, file({ area: 'untracked', kind: '?' }))));
  const drawn = r.container.querySelectorAll('.git-dl').length;
  assert.ok(drawn > 0 && drawn < 200, `drawn ${drawn}`);
});

// @req FR-GIT-007
test('FR-GIT-007: split view pairs the sides; it is off for one-sided files and narrow panes, with the reason', async () => {
  const c = client(() => ({ inputs: { old: { id: 'a' }, new: { id: null } }, hunks: HUNKS, truncated: false }));
  const r = await render(React.createElement(GitDiffView, props(c, file())));
  await act(async () => { (r.container.querySelector('[data-view="split"]') as HTMLButtonElement).click(); });
  const panes = r.container.querySelectorAll('.git-split-pane');
  assert.equal(panes.length, 2);
  assert.equal(panes[0].querySelectorAll('.git-dl').length, panes[1].querySelectorAll('.git-dl').length);
  await r.cleanup();
  const added = await render(React.createElement(GitDiffView, props(c, file({ kind: 'A', area: 'untracked' }))));
  const split = added.container.querySelector('[data-view="split"]') as HTMLButtonElement;
  assert.equal(split.disabled, true);
  assert.equal(split.title, 'One side is empty');
  await added.cleanup();
  const narrow = await render(React.createElement(GitDiffView, props(c, file(), { width: 540 })));
  const narrowSplit = narrow.container.querySelector('[data-view="split"]') as HTMLButtonElement;
  assert.equal(narrowSplit.disabled, true);
  assert.equal(narrowSplit.title, 'Too narrow for the split view');
});

// @req FR-GIT-007
test('FR-GIT-007: a hidden-context gap expands from the full text', async () => {
  const hunks = [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, header: '@@ -5 +5 @@', lines: [L('-', 5, null, 'e'), L('+', null, 5, 'E')] }];
  const c = client((q) => (q.full
    ? { inputs: { old: { id: 'a' }, new: { id: null } }, hunks, truncated: false, gapAfter: 0, full: { old: 'a\nb\nc\nd\ne\n', new: 'a\nb\nc\nd\nE\n' } }
    : { inputs: { old: { id: 'a' }, new: { id: null } }, hunks, truncated: false, gapAfter: 0 }));
  const r = await render(React.createElement(GitDiffView, props(c, file())));
  const expand = r.container.querySelector('[data-gap="top"] button') as HTMLButtonElement;
  assert.equal(r.container.querySelectorAll('[data-gap="top"] button').length, 1, 'the top gap has one action');
  await act(async () => { expand.click(); });
  await settle();
  assert.equal(c.calls.at(-1)?.full, true);
  assert.equal(r.container.querySelector('[data-gap="top"]'), null);
  assert.deepEqual([...r.container.querySelectorAll('.git-dl')].slice(0, 4).map((e) => e.querySelector('.git-dl-text')?.textContent), ['a', 'b', 'c', 'd']);
});

// @req FR-GIT-007
test('FR-GIT-007: open in editor for working-tree text files, with the repository root in the tab path style', async () => {
  const opened: string[] = [];
  const c = client(() => ({ inputs: { old: { id: 'a' }, new: { id: null } }, hunks: HUNKS, truncated: false }));
  const r = await render(React.createElement(GitDiffView, props(c, file(), { root: 'C:/work/repo', onOpenEditor: (p: string) => opened.push(p) })));
  await act(async () => { (r.container.querySelector('[data-open-editor]') as HTMLButtonElement).click(); });
  assert.deepEqual(opened, ['C:\\work\\repo\\src\\a.ts']);
  await r.cleanup();
  const wsl = await render(React.createElement(GitDiffView, props(c, file(), { root: '/home/beom/web', onOpenEditor: (p: string) => opened.push(p) })));
  await act(async () => { (wsl.container.querySelector('[data-open-editor]') as HTMLButtonElement).click(); });
  assert.equal(opened.at(-1), '/home/beom/web/src/a.ts');
  await wsl.cleanup();
  const del = await render(React.createElement(GitDiffView, props(c, file({ kind: 'D' }), { root: 'C:/r', onOpenEditor: () => {} })));
  assert.equal((del.container.querySelector('[data-open-editor]') as HTMLButtonElement).disabled, true);
  await del.cleanup();
  const commit = await render(React.createElement(GitDiffView, props(c, file({ area: null }), { selected: 'abc1234', root: 'C:/r', onOpenEditor: () => {} })));
  assert.equal(commit.container.querySelector('[data-open-editor]'), null, 'only for the working tree');
});
