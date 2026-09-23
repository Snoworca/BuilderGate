import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as ClipboardModule from '../../src/components/fileExplorer/fileExplorerClipboard.ts';
import type * as ShortcutsModule from '../../src/components/fileExplorer/fileExplorerShortcuts.ts';
import type * as FileTreeStateModule from '../../src/components/fileExplorer/fileTreeState.ts';
import type { DirectoryEntry, DirectoryListing } from '../../src/types/index.ts';

// FR-FEX-005 AC-1·AC-3·AC-4·AC-5·AC-6 / CON-FEX-001 AC-5 / FR-FEX-002 AC-6 —
// the explorer's own clipboard and the decision behind its keyboard shortcuts.
//
// The clipboard is one module-scope value for the whole application: every tab,
// every explorer window and the editor's side panel read and write the same one
// (design 6.1, 9.3). The shortcut decision follows editorWindowSaveShortcut.ts:
// a pure decide(...) over {event, focus} and a handler that calls
// preventDefault only when the decision is not 'ignore'. A press that lands
// outside the surface -- above all Ctrl+C in a terminal, which must reach the
// shell as an interrupt -- is left entirely alone (design 6.2).
//
// Both modules are loaded inside each test: a static import of a missing module
// kills the runner before any test is named, so a red run would show one crash
// instead of which contracts are unmet. The `import type` lines are erased at
// runtime and exist so tsc checks every call against the real signatures once
// the modules land.
const CLIPBOARD_PATH = '../../src/components/fileExplorer/fileExplorerClipboard.ts';
const SHORTCUTS_PATH = '../../src/components/fileExplorer/fileExplorerShortcuts.ts';
const TREE_STATE_PATH = '../../src/components/fileExplorer/fileTreeState.ts';
type C = typeof ClipboardModule;
type S = typeof ShortcutsModule;
type T = typeof FileTreeStateModule;
type Clipboard = NonNullable<ReturnType<C['getFileExplorerClipboard']>>;
type ShortcutInput = Parameters<S['decideFileExplorerShortcut']>[0];
type ShortcutEvent = ShortcutInput['event'];

// The clipboard is module-scope, so every test starts from an empty one; a
// value left by an earlier test would otherwise pass or fail a later one.
async function loadClipboard(): Promise<C> {
  const m = await import(CLIPBOARD_PATH) as C;
  m.clearFileExplorerClipboard();
  return m;
}

async function loadShortcuts(): Promise<S> {
  return await import(SHORTCUTS_PATH) as S;
}

async function loadTreeState(): Promise<T> {
  return await import(TREE_STATE_PATH) as T;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const ROOT = 'C:\\work\\repo';
const DOCS = 'C:\\work\\repo\\docs';
const A_TXT = 'C:\\work\\repo\\a.txt';
const HIDDEN = 'C:\\work\\repo\\..hidden';
const DEST = 'C:\\work\\other';

const MODIFIED = '2026-09-01T00:00:00.000Z';

function entry(name: string, type: DirectoryEntry['type']): DirectoryEntry {
  return { name, type, size: 0, modified: MODIFIED };
}

// '..' first, exactly as FileService sends it for a non-root directory. '..hidden'
// is an ordinary name and must survive every '..' filter.
const ROOT_LISTING: DirectoryListing = {
  cwd: ROOT,
  path: ROOT,
  entries: [entry('..', 'directory'), entry('docs', 'directory'), entry('..hidden', 'file'), entry('a.txt', 'file')],
  totalEntries: 4,
};

function key(overrides: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return { ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...overrides } as ShortcutEvent;
}

const CTRL_C = key({ key: 'c', ctrlKey: true });
const CTRL_X = key({ key: 'x', ctrlKey: true });
const CTRL_V = key({ key: 'v', ctrlKey: true });
const DELETE = key({ key: 'Delete' });
const F2 = key({ key: 'F2' });

function isParentPath(path: string): boolean {
  const last = path.split(/[\\/]/).pop();
  return last === '..' || path === '..';
}

// ---------------------------------------------------------------------------
// FR-FEX-005 AC-1 — one value across tabs and windows
// ---------------------------------------------------------------------------

test('setFileExplorerClipboard 를 한 호출자가 쓰고 무관한 호출자가 같은 값을 읽는다 — API 에 탭/창 인자 없음', async () => {
  const writer = await loadClipboard();
  // A second import stands in for a different tab or window: same module, same value.
  const reader = await import(CLIPBOARD_PATH) as C;

  // No tab, window or workspace parameter anywhere on the store's surface.
  assert.equal(writer.getFileExplorerClipboard.length, 0, 'get takes no scope argument');
  assert.equal(writer.setFileExplorerClipboard.length, 1, 'set takes only the value');
  assert.equal(reader.getFileExplorerClipboard(), null, 'cleared clipboard reads null');

  const notified: number[] = [];
  const unsubscribe = reader.subscribeFileExplorerClipboard(() => { notified.push(1); });

  const value: Clipboard = { mode: 'copy', entries: [{ sessionId: SESSION_A, path: A_TXT }] };
  writer.setFileExplorerClipboard(value);

  assert.deepEqual(reader.getFileExplorerClipboard(), value);
  // useSyncExternalStore needs a stable snapshot between changes.
  assert.equal(reader.getFileExplorerClipboard(), reader.getFileExplorerClipboard());
  assert.equal(notified.length, 1, 'a subscriber is told once per change');

  unsubscribe();
  writer.clearFileExplorerClipboard();
  assert.equal(reader.getFileExplorerClipboard(), null);
  assert.equal(notified.length, 1, 'an unsubscribed listener is not called');
});

// ---------------------------------------------------------------------------
// FR-FEX-005 AC-3 — copy and cut put the selection in the clipboard
// ---------------------------------------------------------------------------

test('copySelection/cutSelection 이 {mode, entries:[{sessionId,path}]} 를 만든다', async () => {
  const m = await loadClipboard();

  const copied = m.copySelection({ sessionId: SESSION_A, paths: [DOCS, A_TXT] });
  const expectedCopy: Clipboard = {
    mode: 'copy',
    entries: [{ sessionId: SESSION_A, path: DOCS }, { sessionId: SESSION_A, path: A_TXT }],
  };
  assert.deepEqual(copied, expectedCopy);
  assert.deepEqual(m.getFileExplorerClipboard(), expectedCopy, 'copy stores what it returns');

  // Cut replaces the previous value; it does not merge with it.
  const cut = m.cutSelection({ sessionId: SESSION_B, paths: [A_TXT] });
  const expectedCut: Clipboard = { mode: 'cut', entries: [{ sessionId: SESSION_B, path: A_TXT }] };
  assert.deepEqual(cut, expectedCut);
  assert.deepEqual(m.getFileExplorerClipboard(), expectedCut);
});

// ---------------------------------------------------------------------------
// FR-FEX-005 AC-4 — paste goes to the current tab's directory (IR-FOP-001 AC-1·AC-2)
// ---------------------------------------------------------------------------

test("buildPasteJobRequest: copy→operation 'copy', cut→'move', destSessionId/destPath 는 현재 탭 뿌리, sourceSessionId 는 항목의 세션", async () => {
  const m = await loadClipboard();
  // Source and destination sessions differ, so a request that copies one into
  // the other field cannot pass.
  const target = { destSessionId: SESSION_B, destPath: DEST };

  const copy: Clipboard = { mode: 'copy', entries: [{ sessionId: SESSION_A, path: DOCS }, { sessionId: SESSION_A, path: A_TXT }] };
  assert.deepEqual(m.buildPasteJobRequest(copy, target), {
    operation: 'copy',
    sourceSessionId: SESSION_A,
    sources: [DOCS, A_TXT],
    destSessionId: SESSION_B,
    destPath: DEST,
  });

  const cut: Clipboard = { mode: 'cut', entries: [{ sessionId: SESSION_A, path: A_TXT }] };
  assert.deepEqual(m.buildPasteJobRequest(cut, target), {
    operation: 'move',
    sourceSessionId: SESSION_A,
    sources: [A_TXT],
    destSessionId: SESSION_B,
    destPath: DEST,
  });
});

// ---------------------------------------------------------------------------
// FR-FEX-005 AC-5 — Delete confirms over the whole selection, F2 renames one
// ---------------------------------------------------------------------------

test('decideFileExplorerShortcut: Delete→confirm-delete(선택 전체), F2→rename(선택 1개일 때만)', async () => {
  const { decideFileExplorerShortcut } = await loadShortcuts();
  const decide = (event: ShortcutEvent, selectionCount: number) =>
    decideFileExplorerShortcut({ event, focusedInSurface: true, selectionCount }).kind;

  assert.equal(decide(DELETE, 1), 'confirm-delete');
  assert.equal(decide(DELETE, 3), 'confirm-delete');
  assert.equal(decide(DELETE, 0), 'ignore', 'nothing selected: Delete is not taken');

  assert.equal(decide(F2, 1), 'rename');
  assert.equal(decide(F2, 2), 'ignore', 'rename is for exactly one item');
  assert.equal(decide(F2, 0), 'ignore');

  // The three clipboard keys, so the outcome set is pinned and not only Delete/F2.
  assert.equal(decide(CTRL_C, 2), 'copy');
  assert.equal(decide(CTRL_X, 2), 'cut');
  assert.equal(decide(CTRL_V, 0), 'paste');
  assert.equal(decide(key({ key: 'c', metaKey: true }), 1), 'copy', 'Cmd+C on macOS');
  // AltGr arrives as ctrl+alt and types a character; it is not a shortcut.
  assert.equal(decide(key({ key: 'c', ctrlKey: true, altKey: true }), 1), 'ignore');
  assert.equal(decide(key({ key: 'c' }), 1), 'ignore', 'a bare letter is typing');
});

// ---------------------------------------------------------------------------
// FR-FEX-005 AC-6 — focus outside the surface is never taken (DR-16)
// ---------------------------------------------------------------------------

test('포커스가 창 표면 밖(터미널)이면 Ctrl+C/X/V/Delete/F2 모두 ignore 이고 preventDefault 없음 (DR-16)', async () => {
  const { decideFileExplorerShortcut, createFileExplorerShortcutHandler } = await loadShortcuts();
  const presses: Array<[string, ShortcutEvent]> = [
    ['Ctrl+C', CTRL_C], ['Ctrl+X', CTRL_X], ['Ctrl+V', CTRL_V], ['Delete', DELETE], ['F2', F2],
  ];

  let focusedInSurface = false;
  const ran: string[] = [];
  const handler = createFileExplorerShortcutHandler({
    getContext: () => ({ focusedInSurface, selectionCount: 1 }),
    run: (decision) => { ran.push(decision.kind); },
  });

  for (const [label, event] of presses) {
    assert.equal(
      decideFileExplorerShortcut({ event, focusedInSurface: false, selectionCount: 1 }).kind,
      'ignore',
      `${label} outside the surface`,
    );

    let prevented = 0;
    handler({ ...event, preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 0, `${label} outside the surface must reach the terminal untouched`);
  }
  assert.deepEqual(ran, [], 'nothing runs for a press outside the surface');

  // Control: the same presses inside the surface are taken, so the zeros above
  // are not a handler that never prevents anything.
  focusedInSurface = true;
  for (const [label, event] of presses) {
    let prevented = 0;
    handler({ ...event, preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1, `${label} inside the surface is taken exactly once`);
  }
  assert.deepEqual(ran, ['copy', 'cut', 'paste', 'confirm-delete', 'rename']);
});

// ---------------------------------------------------------------------------
// CON-FEX-001 AC-5 — '..' is never a clipboard or Delete target
// ---------------------------------------------------------------------------

test("selectAll 결과로 만든 클립보드 항목과 delete 요청에 '..' 경로가 없다", async () => {
  const tree = await loadTreeState();
  const m = await loadClipboard();

  let state = tree.createInitialFileTreeState({ root: ROOT });
  state = tree.fileTreeReducer(state, { type: 'CHILDREN_LOADED', path: ROOT, listing: ROOT_LISTING });
  // A careless renderer maps the up row to a '..' string; it must not survive.
  const rendered = tree.selectVisibleRows(state).map((row) => (row.kind === 'node' ? row.path : '..'));
  state = tree.fileTreeReducer(state, { type: 'SELECT_ALL', orderedPaths: rendered });
  const selected = [...state.selectedPaths];

  const copied = m.copySelection({ sessionId: SESSION_A, paths: selected });
  assert.ok(copied !== null);
  assert.deepEqual(copied.entries.map((e) => e.path).sort(), [A_TXT, DOCS, HIDDEN].sort());

  const deleteRequest = m.buildDeleteJobRequest({ sessionId: SESSION_A, paths: selected });
  assert.ok(deleteRequest !== null);
  assert.deepEqual(deleteRequest, { operation: 'delete', sourceSessionId: SESSION_A, sources: selected });

  // The store itself refuses a '..' path handed to it directly, in either
  // separator, while keeping '..hidden' -- so the guarantee does not rest on
  // every caller having gone through the tree state first.
  const smuggled = [A_TXT, `${ROOT}\\..`, '/home/me/repo/..', HIDDEN];
  const copiedDirect = m.copySelection({ sessionId: SESSION_A, paths: smuggled });
  assert.ok(copiedDirect !== null);
  assert.deepEqual(copiedDirect.entries.map((e) => e.path), [A_TXT, HIDDEN]);
  assert.ok(!copiedDirect.entries.some((e) => isParentPath(e.path)));

  const cutDirect = m.cutSelection({ sessionId: SESSION_A, paths: smuggled });
  assert.ok(cutDirect !== null);
  assert.deepEqual(cutDirect.entries.map((e) => e.path), [A_TXT, HIDDEN]);

  const deleteDirect = m.buildDeleteJobRequest({ sessionId: SESSION_A, paths: smuggled });
  assert.ok(deleteDirect !== null);
  assert.deepEqual(deleteDirect.sources, [A_TXT, HIDDEN]);
});

// ---------------------------------------------------------------------------
// FR-FEX-002 AC-6 — one clipboard regardless of tree/list mode
// ---------------------------------------------------------------------------

test('클립보드 API 가 mode 인자를 받지 않는다 — 모드 무관 하나의 값', async () => {
  const tree = await loadTreeState();
  const m = await loadClipboard();

  // Copy in tree mode, read after switching to list mode: the same value.
  let state = tree.createInitialFileTreeState({ root: ROOT, mode: 'tree' });
  state = tree.fileTreeReducer(state, { type: 'CHILDREN_LOADED', path: ROOT, listing: ROOT_LISTING });
  state = tree.fileTreeReducer(state, { type: 'SELECT_ALL', orderedPaths: [DOCS, A_TXT] });
  const inTree = m.copySelection({ sessionId: SESSION_A, paths: [...state.selectedPaths] });

  state = tree.fileTreeReducer(state, { type: 'SET_MODE', mode: 'list' });
  assert.equal(state.mode, 'list');
  assert.deepEqual([...state.selectedPaths].sort(), [A_TXT, DOCS].sort(), 'selection survives the mode switch');
  assert.equal(m.getFileExplorerClipboard(), inTree, 'the clipboard is the same value after the switch');

  // No tree/list parameter on any clipboard function: reads take nothing, and
  // copy/cut take one selection object with no mode field.
  assert.equal(m.getFileExplorerClipboard.length, 0);
  assert.equal(m.copySelection.length, 1);
  assert.equal(m.cutSelection.length, 1);
  assert.ok(!('clipboard' in state), 'the tree state does not carry a clipboard');
});
