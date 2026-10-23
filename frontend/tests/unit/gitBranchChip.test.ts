// FR-GIT-001, FR-GIT-002: the branch chip in MetadataRow, rendered under jsdom.
// Runs through test:unit:git-viewer (tsx + asset stubs) because the chip imports its stylesheet.
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
const { MetadataRow } = await import('../../src/components/MetadataBar/MetadataRow.tsx');
const { createGitSummaryStore } = await import('../../src/components/Git/gitSummaryStore.ts');

let width = 0;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).dataset.gitRow !== undefined ? width : 0; } });

const tab = {
  id: 'tab-1', sessionId: 's1', name: 'claude-api', colorIndex: 0, cwd: 'C:\\work\\repo', status: 'idle',
  createdAt: new Date().toISOString(), sortOrder: 0, workspaceId: 'w1', shellType: 'powershell',
} as never;

const repoSummary = {
  repo: true, root: 'C:/work/repo', subdir: '', branch: 'feat/git-graph', detached: false, head: 'a'.repeat(40),
  upstream: 'origin/feat/git-graph', ahead: 2, behind: 1, base: null, compare: { ref: 'origin/main' },
  operation: null, counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0, paths: 3 }, untrackedScan: 'normal', checkedAt: 1,
};

function storeAnswering(summary: unknown) {
  return createGitSummaryStore({ fetchSummary: async () => summary as never });
}

const mounted = new Set<() => Promise<void>>();
// A failed assertion skips a test's own cleanup; an unmounted row keeps its timers and the run never ends.
test.afterEach(async () => { for (const c of [...mounted]) await c(); });

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const cleanup = async () => {
    if (!mounted.delete(cleanup)) return;
    await act(async () => { root.unmount(); });
    container.remove();
  };
  mounted.add(cleanup);
  return { container, cleanup };
}

// @req FR-GIT-001
test('FR-GIT-001: outside a repository the bottom bar is exactly what it was', async () => {
  width = 700;
  const plain = await render(React.createElement(MetadataRow, { tab }));
  const before = plain.container.innerHTML.replace(/\d\d:\d\d/g, 'T');
  await plain.cleanup();
  const withGit = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering({ repo: false, checkedAt: 1 }) }));
  const after = withGit.container.innerHTML.replace(/\d\d:\d\d/g, 'T').replace(/ data-git-row=""/, '');
  await withGit.cleanup();
  assert.equal(after, before);
});

// @req FR-GIT-001, FR-GIT-002
test('FR-GIT-001/002: a repository session shows the chip; a wide bar keeps the path, a narrow one hides it', async () => {
  width = 760;
  const opened: string[] = [];
  const wide = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering(repoSummary), onOpenGitWindow: (id: string) => opened.push(id) }));
  const chip = wide.container.querySelector('[data-git-chip]') as HTMLButtonElement;
  assert.ok(chip, 'chip rendered');
  assert.equal(chip.tagName, 'BUTTON');
  assert.match(chip.textContent ?? '', /feat\/git-graph/);
  assert.match(chip.textContent ?? '', /●3/);
  assert.match(chip.textContent ?? '', /↑2↓1/);
  assert.match(chip.getAttribute('aria-label') ?? '', /feat\/git-graph/);
  assert.ok(wide.container.querySelector('.metadata-cwd-path'), 'path kept on a wide bar');
  await act(async () => { chip.click(); });
  assert.deepEqual(opened, ['s1']);
  await wide.cleanup();

  width = 300;
  const narrow = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering(repoSummary) }));
  assert.equal(narrow.container.querySelector('.metadata-cwd-path'), null, 'path hidden from stage 2');
  const narrowChip = narrow.container.querySelector('[data-git-chip]');
  assert.match(narrowChip?.getAttribute('aria-label') ?? '', /feat\/git-graph/, 'the full name stays in the label');
  await narrow.cleanup();
});

// @req FR-GIT-001
test('FR-GIT-001: detached HEAD and a failed check', async () => {
  width = 760;
  const detached = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering({ ...repoSummary, branch: null, detached: true, upstream: null, ahead: 0, behind: 0 }) }));
  const chip = detached.container.querySelector('[data-git-chip]');
  assert.match(chip?.textContent ?? '', /aaaaaaa/);
  assert.equal(chip?.getAttribute('data-tone'), 'warn');
  await detached.cleanup();

  const { GitApiError } = await import('../../src/components/Git/gitApi.ts');
  const failing = createGitSummaryStore({ fetchSummary: async () => { throw new GitApiError('GIT_UNSAFE_REPO', 409); } });
  const err = await render(React.createElement(MetadataRow, { tab, gitStore: failing }));
  const errChip = err.container.querySelector('[data-git-chip]');
  assert.equal(errChip?.getAttribute('data-state'), 'error');
  assert.match(errChip?.textContent ?? '', /\?/);
  await err.cleanup();
});

function key(target: Element, k: string, shiftKey = false) {
  target.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));
}
const menuItems = () => [...document.querySelectorAll('.context-menu-item')].map((e) => e.textContent ?? '');

// @req FR-GIT-003
test('FR-GIT-003: right click and Shift+F10 open the chip menu; its items open the Git window', async () => {
  width = 760;
  const opened: string[] = [];
  const r = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering(repoSummary), onOpenGitWindow: (id: string, target?: string) => opened.push(`${id}:${target ?? 'auto'}`) }));
  const chip = r.container.querySelector('[data-git-chip]') as HTMLElement;
  await act(async () => { chip.dispatchEvent(new (document.defaultView as Window & typeof globalThis).MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  assert.ok(menuItems().some((l) => l.includes('Open Git window')), menuItems().join(' | '));
  const wt = [...document.querySelectorAll('.context-menu-item')].find((e) => (e.textContent ?? '').includes('Show uncommitted changes (3)')) as HTMLElement;
  await act(async () => { wt.click(); });
  assert.deepEqual(opened, ['s1:worktree']);
  assert.equal(document.querySelectorAll('.context-menu-item').length, 0, 'menu closed');
  await act(async () => { key(chip, 'F10', true); });
  assert.ok(menuItems().length > 0, 'Shift+F10 opens the menu');
  await act(async () => { key(document.body, 'Escape'); });
  await r.cleanup();
});

// @req FR-GIT-003
test('FR-GIT-003: the tooltip shows on hover and closes on Escape', async () => {
  width = 760;
  const r = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering(repoSummary), onOpenGitWindow: () => {} }));
  const chip = r.container.querySelector('[data-git-chip]') as HTMLElement;
  await act(async () => { chip.dispatchEvent(new (document.defaultView as Window & typeof globalThis).MouseEvent('mouseover', { bubbles: true })); });
  const tip = document.querySelector('[role="tooltip"]');
  assert.ok(tip, 'tooltip shown');
  assert.match(tip?.textContent ?? '', /origin\/feat\/git-graph/);
  assert.equal(chip.getAttribute('aria-describedby'), tip?.id);
  await act(async () => { key(document.body, 'Escape'); });
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  await r.cleanup();
});

// @req FR-GIT-003
test('FR-GIT-003: an error chip opens a dialog with the cause and the command for the session environment', async () => {
  width = 760;
  const { GitApiError } = await import('../../src/components/Git/gitApi.ts');
  const failing = createGitSummaryStore({ fetchSummary: async () => { throw new GitApiError('GIT_UNSAFE_REPO', 409); } });
  const r = await render(React.createElement(MetadataRow, { tab, gitStore: failing, onOpenGitWindow: () => {} }));
  const chip = r.container.querySelector('[data-git-chip]') as HTMLElement;
  assert.equal(chip.getAttribute('aria-haspopup'), 'dialog');
  await act(async () => { chip.click(); });
  const dialog = document.querySelector('[role="dialog"][data-git-error]');
  assert.ok(dialog);
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  assert.match(dialog?.textContent ?? '', /safe\.directory C:\/work\/repo/);
  await act(async () => { key(dialog as Element, 'Escape'); });
  assert.equal(document.querySelector('[role="dialog"][data-git-error]'), null);
  assert.equal(chip.getAttribute('aria-expanded'), 'false');
  await r.cleanup();
});

// @req FR-GIT-001
test('FR-GIT-001 AC-6: a slow first answer shows a checking chip, which goes away for a non-repository', async () => {
  width = 760;
  let answer: (v: unknown) => void = () => {};
  const pending = createGitSummaryStore({ fetchSummary: () => new Promise((res) => { answer = res as (v: unknown) => void; }) as never });
  const r = await render(React.createElement(MetadataRow, { tab, gitStore: pending, onOpenGitWindow: () => {} }));
  assert.equal(r.container.querySelector('[data-git-chip]'), null, 'nothing before the delay: a fast answer never flashes');
  await act(async () => { await new Promise((res) => setTimeout(res, 400)); });
  const checking = r.container.querySelector('[data-git-chip][data-state="checking"]');
  assert.ok(checking, 'checking chip after the delay');
  assert.match(checking?.getAttribute('aria-label') ?? '', /Checking Git/);
  await act(async () => { answer({ repo: false, checkedAt: 1 }); await new Promise((res) => setTimeout(res, 0)); });
  assert.equal(r.container.querySelector('[data-git-chip]'), null, 'gone once the folder is not a repository');
  await r.cleanup();
});

// @req FR-GIT-001
test('FR-GIT-001 AC-6: the checking chip turns into the branch chip when the answer is a repository', async () => {
  width = 760;
  let answer: (v: unknown) => void = () => {};
  const pending = createGitSummaryStore({ fetchSummary: () => new Promise((res) => { answer = res as (v: unknown) => void; }) as never });
  const r = await render(React.createElement(MetadataRow, { tab, gitStore: pending, onOpenGitWindow: () => {} }));
  await act(async () => { await new Promise((res) => setTimeout(res, 400)); });
  assert.ok(r.container.querySelector('[data-git-chip][data-state="checking"]'));
  await act(async () => { answer(repoSummary); await new Promise((res) => setTimeout(res, 0)); });
  const chip = r.container.querySelector('[data-git-chip]');
  assert.notEqual(chip?.getAttribute('data-state'), 'checking');
  assert.match(chip?.textContent ?? '', /feat\/git-graph/);
  await r.cleanup();
});

// @req REL-BGSTAB-052
test('REL-BGSTAB-052 AC-7: the elapsed-time ticker runs only while the time is shown', async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const live = new Set<unknown>();
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const id = realSetInterval(fn, ms, ...rest);
    if (ms === 1000) live.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClearInterval(id); }) as typeof clearInterval;
  try {
    width = 150;
    const narrow = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering(repoSummary), onOpenGitWindow: () => {} }));
    await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
    assert.equal(narrow.container.textContent?.match(/\d\d:\d\d/), null, 'the time is hidden at this width');
    assert.equal(live.size, 0, 'no 1 s ticker left running for a hidden time');
    await narrow.cleanup();
    width = 760;
    const wide = await render(React.createElement(MetadataRow, { tab, gitStore: storeAnswering(repoSummary), onOpenGitWindow: () => {} }));
    await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
    assert.equal(live.size, 1, 'a shown time ticks');
    await wide.cleanup();
    assert.equal(live.size, 0, 'unmount stops it');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
