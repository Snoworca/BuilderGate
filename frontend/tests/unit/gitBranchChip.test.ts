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

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
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
