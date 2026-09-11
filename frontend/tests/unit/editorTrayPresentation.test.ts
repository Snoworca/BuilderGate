import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  listEditorTrayEntries,
  type EditorTrayWindow,
} from '../../src/components/editor/editorTrayModel.ts';

// How the tray presents itself once documents are open across several
// workspaces on files that are nearly all named CLAUDE.md.
//
// The row is `workspace / tab | path`. The workspace comes first because two
// workspaces can hold tabs of the same name -- a row built from the tab alone
// would be the same row twice, and the list exists to tell them apart.

const ACTIVE = 'ws-active';
const OTHER = 'ws-other';

function windowOf(overrides: Partial<EditorTrayWindow> = {}): EditorTrayWindow {
  return {
    filePath: 'C:\\Work\\proj\\CLAUDE.md',
    tabId: 'tab-1',
    tabName: 'Terminal-1',
    workspaceId: ACTIVE,
    workspaceName: 'Workspace-1',
    dirty: false,
    ...overrides,
  };
}

test('the list holds documents of every workspace, not only the active one', () => {
  // The filter that stood here kept the list to the active workspace, so that
  // choosing a row could not move the user somewhere they had not asked to go.
  // Choosing a row is now how they ask, so the filter is gone.
  const here = windowOf({ filePath: 'C:\\Work\\a\\CLAUDE.md', workspaceId: ACTIVE });
  const there = windowOf({
    filePath: 'C:\\Work\\b\\CLAUDE.md',
    workspaceId: OTHER,
    workspaceName: 'Workspace-2',
  });

  const entries = listEditorTrayEntries([here, there]);
  assert.deepEqual(entries.map(entry => entry.filePath), [
    'C:\\Work\\a\\CLAUDE.md',
    'C:\\Work\\b\\CLAUDE.md',
  ]);

  // Each row carries the workspace it belongs to, which is what the caller
  // needs to switch to it.
  assert.deepEqual(entries.map(entry => entry.workspaceId), [ACTIVE, OTHER]);
});

test('a row reads workspace / tab | path', () => {
  const entry = listEditorTrayEntries([windowOf({
    workspaceName: 'Workspace-1',
    tabName: 'Terminal-2',
    filePath: 'C:\\w\\CLAUDE.md',
  })])[0];

  assert.equal(entry.label, 'Workspace-1 / Terminal-2 | C:\\w\\CLAUDE.md');
});

test('tabs of the same name in two workspaces read as different rows', () => {
  // This is why the workspace is in the row at all. Tab names are chosen per
  // workspace and repeat freely, so a row built from the tab alone would give
  // the user two identical lines and no way to tell which is which.
  const a = windowOf({
    workspaceId: ACTIVE,
    workspaceName: 'Workspace-1',
    tabName: 'Terminal-1',
    filePath: 'C:\\Work\\a\\CLAUDE.md',
  });
  const b = windowOf({
    workspaceId: OTHER,
    workspaceName: 'Workspace-2',
    tabName: 'Terminal-1',
    filePath: 'C:\\Work\\b\\CLAUDE.md',
  });

  const [first, second] = listEditorTrayEntries([a, b]);
  assert.notEqual(first.label, second.label);
  assert.match(first.label, /^Workspace-1 \/ Terminal-1 \|/);
  assert.match(second.label, /^Workspace-2 \/ Terminal-1 \|/);
});

test('two documents of the same name in one workspace still differ', () => {
  const a = windowOf({ filePath: 'C:\\Work\\alpha\\CLAUDE.md', tabId: 'tab-1' });
  const b = windowOf({ filePath: 'C:\\Work\\beta\\CLAUDE.md', tabId: 'tab-2' });

  const [first, second] = listEditorTrayEntries([a, b]);

  assert.notEqual(first.label, second.label);
  assert.match(first.label, /alpha/);
  assert.match(second.label, /beta/);
});

test('a path too long to fit loses its head, never its file name', () => {
  const deep = 'C:\\Work\\git\\_Snoworca\\ProjectMaster\\packages\\frontend\\source\\CLAUDE.md';
  const entry = listEditorTrayEntries([windowOf({ filePath: deep })])[0];

  // The path half is what is elided. The prefix is short and fixed, and losing
  // it would take with it the only thing that separates two workspaces.
  const path = entry.label.split(' | ')[1];
  assert.match(path, /^\.\.\./, 'the head is not elided');
  assert.match(path, /CLAUDE\.md$/, 'the file name did not survive');
  assert.ok(path.length < deep.length, 'nothing was elided');
  assert.match(entry.label, /^Workspace-1 \/ Terminal-1 \| /, 'the prefix was elided too');
});

test('the dirty marker trails the whole row', () => {
  // Trailing rather than leading: the head of a long path is where the elision
  // happens, so a marker put there sits next to the `...` and reads as part of
  // it. The tail is the end the row is aligned on.
  const entry = listEditorTrayEntries([windowOf({ dirty: true })])[0];

  assert.ok(entry.label.endsWith('*'), `expected a trailing marker, got ${entry.label}`);
  assert.equal(listEditorTrayEntries([windowOf()])[0].label.includes('*'), false);
});

test('a workspace or tab whose name is gone still reads as a row', () => {
  // A document outlives the tab it was opened from, and can outlive its
  // workspace's name in the list the caller happens to hold. The row has to
  // stay usable: it is how the document is reached, and a blank segment would
  // read as a row for nothing.
  const entry = listEditorTrayEntries([windowOf({
    workspaceName: undefined,
    tabName: undefined,
    filePath: 'C:\\w\\CLAUDE.md',
  })])[0];

  assert.equal(entry.label, '(이름 없음) / (닫힌 탭) | C:\\w\\CLAUDE.md');
});
