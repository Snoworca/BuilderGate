import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countMinimizedEditorTrayWindows,
  listEditorTrayEntries,
  type EditorTrayWindow,
} from '../../src/components/editor/editorTrayModel.ts';

// How the tray presents itself once several windows are open on files that are
// nearly all named CLAUDE.md: the badge that says how many are folded away, and
// the label that tells one CLAUDE.md from another.

const ACTIVE = 'ws-active';
const OTHER = 'ws-other';

function windowOf(overrides: Partial<EditorTrayWindow> = {}): EditorTrayWindow {
  return {
    filePath: 'C:\\Work\\proj\\CLAUDE.md',
    tabId: 'tab-1',
    workspaceId: ACTIVE,
    minimized: false,
    dirty: false,
    ...overrides,
  };
}

test('the badge counts the minimized windows of the current workspace only', () => {
  const windows = [
    windowOf({ filePath: 'C:\\a\\CLAUDE.md', minimized: true }),
    windowOf({ filePath: 'C:\\b\\CLAUDE.md', minimized: true }),
    windowOf({ filePath: 'C:\\c\\CLAUDE.md', minimized: false }),
    windowOf({ filePath: 'D:\\x\\CLAUDE.md', minimized: true, workspaceId: OTHER }),
  ];

  assert.equal(countMinimizedEditorTrayWindows(windows, ACTIVE), 2);
});

test('the badge is zero with nothing minimized and with no workspace at all', () => {
  assert.equal(countMinimizedEditorTrayWindows([windowOf()], ACTIVE), 0);
  assert.equal(countMinimizedEditorTrayWindows([windowOf({ minimized: true })], null), 0);
  assert.equal(countMinimizedEditorTrayWindows([], ACTIVE), 0);
});

test('two windows on files of the same name get labels that differ', () => {
  const a = windowOf({ filePath: 'C:\\Work\\alpha\\CLAUDE.md', tabId: 'tab-1' });
  const b = windowOf({ filePath: 'C:\\Work\\beta\\CLAUDE.md', tabId: 'tab-2' });

  const [first, second] = listEditorTrayEntries([a, b], ACTIVE);

  assert.notEqual(first.label, second.label);
  assert.match(first.label, /alpha/);
  assert.match(second.label, /beta/);
});

test('a path that fits is shown whole, from its root', () => {
  const entry = listEditorTrayEntries([windowOf({ filePath: 'C:\\w\\CLAUDE.md' })], ACTIVE)[0];

  assert.equal(entry.label, 'C:\\w\\CLAUDE.md');
});

test('a path too long to fit loses its head, never its file name', () => {
  const deep = 'C:\\Work\\git\\_Snoworca\\ProjectMaster\\packages\\frontend\\source\\CLAUDE.md';
  const entry = listEditorTrayEntries([windowOf({ filePath: deep })], ACTIVE)[0];

  assert.match(entry.label, /^\.\.\./, 'the head is not elided');
  assert.match(entry.label, /CLAUDE\.md$/, 'the file name did not survive');
  assert.ok(entry.label.length < deep.length, 'nothing was elided');
});

test('the dirty marker trails the label', () => {
  // Trailing rather than leading: the head of a long path is where the
  // elision happens, so a marker put there sits next to the `...` and reads
  // as part of it. The tail is the end the row is aligned on.
  const entry = listEditorTrayEntries([windowOf({ dirty: true })], ACTIVE)[0];

  assert.match(entry.label, /\*$/);
  assert.doesNotMatch(entry.label, /^\*/);
});
