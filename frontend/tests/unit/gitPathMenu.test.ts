// FR-GIT-003: the path menu (FR-MDE-007) leads with "Open Git window" in a repository, and only there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installCatalog } from '../../src/i18n/i18n.ts';
import { buildEditorFileMenuItems } from '../../src/utils/editorFileMenu.ts';

installCatalog('en', JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')));
const label = (i: unknown) => ((i as { separator?: boolean }).separator ? '---' : (i as { label: string }).label);
const base = { cwd: 'C:\\work\\repo', tabId: 't1', openWindows: [], onSelect: () => {}, onOpenFileExplorer: () => {} };

// @req FR-GIT-003
test('FR-GIT-003: a repository path menu starts with "Open Git window"; the rest keeps its order', () => {
  const plain = buildEditorFileMenuItems(base).map(label);
  const opened: string[] = [];
  const withGit = buildEditorFileMenuItems({ ...base, onOpenGitWindow: (tabId: string) => opened.push(tabId) });
  assert.deepEqual(withGit.map(label), ['Open Git window', ...plain]);
  (withGit[0] as { onClick: () => void }).onClick();
  assert.deepEqual(opened, ['t1']);
});

// @req FR-GIT-003
test('FR-GIT-003: outside a repository the path menu is unchanged', () => {
  assert.deepEqual(buildEditorFileMenuItems({ ...base, onOpenGitWindow: undefined }).map(label), buildEditorFileMenuItems(base).map(label));
});
