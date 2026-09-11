import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addEditorTab,
  closeEditorTab,
  selectEditorTab,
  type EditorTabSet,
} from '../../src/components/editor/editorWindowTabs.ts';

// FR-MDE-007 · FR-MDE-010 — the tab set of the one editor window, as a pure
// function of the set and the path being acted on.
//
// A tab's identity is its normalized absolute path, the same value that used to
// identify a whole window. Opening a path that is already open therefore selects
// the tab that holds it rather than adding a second one.

interface Tab {
  filePath: string;
  tabId: string;
}

function tabs(...paths: string[]): Tab[] {
  return paths.map((filePath, index) => ({ filePath, tabId: `term-${index}` }));
}

function set(activeFilePath: string | null, ...paths: string[]): EditorTabSet<Tab> {
  return { tabs: tabs(...paths), activeFilePath };
}

const A = 'C:/work/a.md';
const B = 'C:/work/b.md';
const C = 'C:/work/c.md';

test('FR-MDE-007 the tab rules run with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined');

  const start = set(null);
  const opened = addEditorTab(start, { filePath: A, tabId: 'term-0' });
  selectEditorTab(opened, A);
  closeEditorTab(opened, A);
});

test('FR-MDE-007 opening a path adds a tab and makes it active', () => {
  const empty = set(null);
  const first = addEditorTab(empty, { filePath: A, tabId: 'term-0' });

  assert.deepEqual(first.tabs.map(tab => tab.filePath), [A]);
  assert.equal(first.activeFilePath, A);

  // The input is left alone, so a caller holding the previous set still sees it.
  assert.deepEqual(empty.tabs, []);
  assert.equal(empty.activeFilePath, null);

  // A second path is appended rather than inserted, which is what makes the
  // order the order they were opened in.
  const second = addEditorTab(first, { filePath: B, tabId: 'term-1' });
  assert.deepEqual(second.tabs.map(tab => tab.filePath), [A, B]);
  assert.equal(second.activeFilePath, B);
});

test('FR-MDE-007 opening a path that is already open selects it instead of duplicating', () => {
  const two = set(B, A, B);
  const again = addEditorTab(two, { filePath: A, tabId: 'term-9' });

  assert.deepEqual(again.tabs.map(tab => tab.filePath), [A, B]);
  assert.equal(again.activeFilePath, A);

  // The tab that was already there keeps its own binding. Re-opening a document
  // from a different terminal does not move where it saves to -- the tab that
  // holds it was bound when it was opened, and its unsaved body belongs to that
  // binding.
  assert.equal(again.tabs[0].tabId, 'term-0');

  // The order is untouched too, so selecting a tab does not shuffle the row
  // under the user's pointer.
  assert.deepEqual(again.tabs.map(tab => tab.tabId), ['term-0', 'term-1']);
});

test('FR-MDE-007 selecting a tab changes only which one is active', () => {
  const three = set(C, A, B, C);
  const selected = selectEditorTab(three, A);

  assert.equal(selected.activeFilePath, A);
  assert.deepEqual(selected.tabs, three.tabs);

  // Selecting a path no tab holds leaves the set alone rather than clearing the
  // active tab. A caller that asks for a document that is not open has asked
  // for nothing, and answering with "no active tab" would blank the window.
  const missing = selectEditorTab(three, 'C:/work/absent.md');
  assert.equal(missing.activeFilePath, C);
  assert.deepEqual(missing.tabs, three.tabs);
  assert.equal(missing, three);
});

test('FR-MDE-010 closing the active tab activates the one to its right', () => {
  const three = set(B, A, B, C);
  const closed = closeEditorTab(three, B);

  assert.deepEqual(closed.tabs.map(tab => tab.filePath), [A, C]);
  assert.equal(closed.activeFilePath, C);

  // The rightmost tab has nothing to its right, so it falls back to the left.
  // Without this case an implementation that always took the next index would
  // leave the active path naming a tab that is gone.
  const last = closeEditorTab(set(C, A, B, C), C);
  assert.deepEqual(last.tabs.map(tab => tab.filePath), [A, B]);
  assert.equal(last.activeFilePath, B);
});

test('FR-MDE-010 closing an inactive tab leaves the active one alone', () => {
  const three = set(B, A, B, C);
  const closed = closeEditorTab(three, C);

  assert.deepEqual(closed.tabs.map(tab => tab.filePath), [A, B]);
  assert.equal(closed.activeFilePath, B);

  // Including when the closed tab sat to the left of the active one, where an
  // implementation carrying an index rather than a path would slip by one.
  const left = closeEditorTab(three, A);
  assert.deepEqual(left.tabs.map(tab => tab.filePath), [B, C]);
  assert.equal(left.activeFilePath, B);
});

test('FR-MDE-010 closing the last tab empties the set, which is what closes the window', () => {
  const only = set(A, A);
  const closed = closeEditorTab(only, A);

  assert.deepEqual(closed.tabs, []);
  assert.equal(closed.activeFilePath, null);

  // An empty set is the signal, not a separate flag. A flag would let the two
  // answers disagree -- a window still open with no tabs in it has nothing to
  // show and no title to carry.
});

test('FR-MDE-010 closing a path no tab holds changes nothing', () => {
  const two = set(A, A, B);
  const closed = closeEditorTab(two, 'C:/work/absent.md');

  assert.equal(closed, two);
});
