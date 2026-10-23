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
