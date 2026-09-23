import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as PaneModelModule from '../../src/components/editor/editorFileTreePaneModel.ts';
import type * as WindowStateStorageModule from '../../src/hooks/windowStateStorage.ts';
import type * as ShortcutsModule from '../../src/components/fileExplorer/fileExplorerShortcuts.ts';

// FR-MDE-012 AC-2·AC-4·AC-5·AC-9~AC-13 / FR-FEX-005 AC-7 -- the pure decisions
// behind the editor window's left file-tree pane, and the store that keeps its
// width and collapsed state per workspace.
//
// Every module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named, so a red run would show one crash
// instead of which contracts are unmet. The `import type` lines are erased at
// runtime and let tsc check every call against the real signatures.
//
// Contract fixed here for editorFileTreePaneModel.ts:
//   PANE_DEFAULT_WIDTH = 212, PANE_MIN_WIDTH = 160, PANE_MAX_RATIO = 0.5
//   clampPaneDragWidth(width, windowWidth)          -> number
//   resetPaneWidth()                                -> number
//   renderPaneWidth(savedWidth, windowWidth)        -> number
//   applyPaneDrag(startWidth, delta, windowWidth)   -> number
//   resolvePaneRoot({ previous, sessionId, sessionCwd }) -> string
//       previous: { sessionId, root } | null -- what the pane showed last
//   isEditorWindowMenuTarget(target)                -> boolean
//   buildEditorWindowContextMenu({ paneOpen, onTogglePane }) -> ContextMenuItem[]
//       "checked" is `icon === '✓'`: ContextMenu renders `icon` and has no
//       checked field, so the mark travels through what the renderer already draws.
//   paneInitiallyCollapsed({ isMobile, savedCollapsed }) -> boolean
//   collapseAfterOpen(isMobile)                     -> boolean
//   decidePaneShortcutFocus({ pane, document, active }) -> boolean (focusedInSurface)
// and for windowStateStorage.ts:
//   getEditorTreePaneStorageKey(workspaceId)        -> 'editor_tree_pane_' + id
//   saveEditorTreePaneState(workspaceId, state, storage) -> boolean
//   readEditorTreePaneState(workspaceId, storage)   -> { width, collapsed }
const PANE_MODEL_PATH = '../../src/components/editor/editorFileTreePaneModel.ts';
const STORAGE_PATH = '../../src/hooks/windowStateStorage.ts';
const SHORTCUTS_PATH = '../../src/components/fileExplorer/fileExplorerShortcuts.ts';
type PaneModel = typeof PaneModelModule;
type WindowStateStorage = typeof WindowStateStorageModule;
type Shortcuts = typeof ShortcutsModule;

async function loadPaneModel(): Promise<PaneModel> {
  return await import(PANE_MODEL_PATH) as PaneModel;
}

async function loadStorage(): Promise<WindowStateStorage> {
  const m = await import(STORAGE_PATH) as WindowStateStorage;
  // The module already exists, so a missing export would surface as
  // "is not a function" deep inside an assertion; name it instead.
  for (const name of ['getEditorTreePaneStorageKey', 'saveEditorTreePaneState', 'readEditorTreePaneState']) {
    assert.equal(typeof (m as unknown as Record<string, unknown>)[name], 'function', `windowStateStorage exports ${name}`);
  }
  return m;
}

async function loadShortcuts(): Promise<Shortcuts> {
  return await import(SHORTCUTS_PATH) as Shortcuts;
}

// A Map-backed Storage, so the store is exercised without a browser.
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key) as string : null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  keys(): string[] { return [...this.map.keys()]; }
}

// ---------------------------------------------------------------------------
// Width (AC-10·AC-11)
// ---------------------------------------------------------------------------

// TC-REQ-FR-MDE-012-AC10-01
test('clampPaneDragWidth: 160 미만은 160, 창 폭 50% 초과는 50%; resetPaneWidth() = 212', async () => {
  const m = await loadPaneModel();
  assert.equal(m.PANE_DEFAULT_WIDTH, 212);
  assert.equal(m.PANE_MIN_WIDTH, 160);
  assert.equal(m.PANE_MAX_RATIO, 0.5);

  assert.equal(m.clampPaneDragWidth(100, 1000), 160, 'below the minimum');
  assert.equal(m.clampPaneDragWidth(160, 1000), 160, 'at the minimum');
  assert.equal(m.clampPaneDragWidth(300, 1000), 300, 'inside the range is kept as is');
  assert.equal(m.clampPaneDragWidth(500, 1000), 500, 'at half the window');
  assert.equal(m.clampPaneDragWidth(600, 1000), 500, 'above half the window');
  // The cap follows the window, not a constant.
  assert.equal(m.clampPaneDragWidth(600, 800), 400);

  assert.equal(m.resetPaneWidth(), 212);
});

// TC-REQ-FR-MDE-012-AC11-01
test('renderPaneWidth(저장 400, 창 600)=300 이고 저장값은 400 그대로; 창 1000 이면 400 으로 돌아온다', async () => {
  const m = await loadPaneModel();
  const saved = 400;
  // Narrowing the window shrinks only what is drawn...
  assert.equal(m.renderPaneWidth(saved, 600), 300);
  assert.equal(saved, 400);
  // ...so widening it again brings the chosen width back, not the clipped one.
  assert.equal(m.renderPaneWidth(saved, 1000), 400);
  assert.equal(m.renderPaneWidth(saved, 2000), 400, 'a wider window does not stretch the pane past what was chosen');
});

// TC-REQ-FR-MDE-012-AC11-02
test('applyPaneDrag(시작폭, delta, 창폭) 이 상한에서 멈추고 그 값이 저장값이 된다', async () => {
  const m = await loadPaneModel();
  assert.equal(m.applyPaneDrag(212, 50, 800), 262, 'an ordinary drag moves by delta');
  assert.equal(m.applyPaneDrag(212, -200, 800), 160, 'dragging left stops at the minimum');

  // Dragging far past the cap stops there: the overshoot is not remembered.
  const saved = m.applyPaneDrag(212, 1000, 800);
  assert.equal(saved, 400);
  // Had the drag stored 1212, a later wide window would draw 1000 here.
  assert.equal(m.renderPaneWidth(saved, 2000), 400);
});

// ---------------------------------------------------------------------------
// Store (AC-12)
// ---------------------------------------------------------------------------

// TC-REQ-FR-MDE-012-AC12-01
test('saveEditorTreePaneState 가 워크스페이스별 키에 {width, collapsed} 만 쓴다 — expandedPaths 를 넘겨도 버린다; 깨진 JSON 은 기본값', async () => {
  const s = await loadStorage();
  const storage = new MemoryStorage();

  const key = s.getEditorTreePaneStorageKey('ws-a');
  assert.equal(key, 'editor_tree_pane_ws-a');
  // Its own key: a schema change here must not move the editor's or the explorer's records.
  assert.notEqual(key, s.getWindowStateStorageKey('ws-a'));
  assert.notEqual(key, s.getFileExplorerStateStorageKey('ws-a'));
  assert.notEqual(s.getEditorTreePaneStorageKey('ws-b'), key);

  // A live pane object carries more than the store may keep.
  const live = { width: 333, collapsed: true, expandedPaths: ['C:\\work\\src', 'C:\\work\\docs'] };
  const ok = s.saveEditorTreePaneState('ws-a', live as unknown as Parameters<WindowStateStorage['saveEditorTreePaneState']>[1], storage);
  assert.equal(ok, true);
  assert.deepEqual(storage.keys(), ['editor_tree_pane_ws-a'], 'one key, scoped to the workspace');

  const raw = storage.getItem('editor_tree_pane_ws-a') as string;
  assert.ok(!raw.includes('expandedPaths'), `expanded directories are not stored: ${raw}`);
  assert.ok(!raw.includes('C:\\\\work'), `no path is stored: ${raw}`);
  const stored = JSON.parse(raw) as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'savedAt', 'width', 'collapsed']);
  for (const field of Object.keys(stored)) {
    assert.ok(allowed.has(field), `unexpected stored field ${field}`);
  }
  assert.equal(stored.width, 333);
  assert.equal(stored.collapsed, true);

  assert.deepEqual(s.readEditorTreePaneState('ws-a', storage), { width: 333, collapsed: true });
  // Another workspace sees nothing of it.
  const missing = s.readEditorTreePaneState('ws-b', storage);
  assert.equal(missing.width, 212, 'nothing stored reads as the default width');
  // FR-MDE-012 does not say whether a never-used pane starts open, so only the
  // shape is pinned here; the broken-value cases below must equal this default.
  assert.equal(typeof missing.collapsed, 'boolean');
  assert.deepEqual(Object.keys(missing).sort(), ['collapsed', 'width']);

  // A hand-edited value cannot carry extra fields back in.
  storage.setItem('editor_tree_pane_ws-c', JSON.stringify({ ...stored, expandedPaths: ['C:\\x'] }));
  assert.deepEqual(s.readEditorTreePaneState('ws-c', storage), { width: 333, collapsed: true });

  // Broken text reads exactly like nothing stored -- no throw, the defaults.
  storage.setItem('editor_tree_pane_ws-d', '{not json');
  assert.deepEqual(s.readEditorTreePaneState('ws-d', storage), missing);
  storage.setItem('editor_tree_pane_ws-e', JSON.stringify(['width', 1]));
  assert.deepEqual(s.readEditorTreePaneState('ws-e', storage), missing);
});

// ---------------------------------------------------------------------------
// Root (AC-5)
// ---------------------------------------------------------------------------

// TC-REQ-FR-MDE-012-AC5-01
test('resolvePaneRoot: 같은 세션이면 사용자가 옮긴 뿌리 유지, 세션이 바뀌면 새 세션 cwd', async () => {
  const m = await loadPaneModel();
  // First showing: the active tab's session directory.
  assert.equal(m.resolvePaneRoot({ previous: null, sessionId: 's1', sessionCwd: 'C:\\work\\a' }), 'C:\\work\\a');
  // The user moved the root inside the tree; the same session keeps it even
  // though the session's cwd says otherwise.
  assert.equal(
    m.resolvePaneRoot({ previous: { sessionId: 's1', root: 'C:\\work' }, sessionId: 's1', sessionCwd: 'C:\\work\\a' }),
    'C:\\work',
  );
  // The active tab now belongs to another session: re-root there.
  assert.equal(
    m.resolvePaneRoot({ previous: { sessionId: 's1', root: 'C:\\work' }, sessionId: 's2', sessionCwd: '/home/u/b' }),
    '/home/u/b',
  );
});

// ---------------------------------------------------------------------------
// Window menu (AC-2·AC-4)
// ---------------------------------------------------------------------------

// TC-REQ-FR-MDE-012-AC2-01
test("isEditorWindowMenuTarget: 'tabbar-empty'·'titlebar-empty' 만 true, 'tab'·'document'·'titlebar-button' 은 false", async () => {
  const m = await loadPaneModel();
  type Target = Parameters<PaneModel['isEditorWindowMenuTarget']>[0];
  const expected: [Target, boolean][] = [
    ['tabbar-empty', true],
    ['titlebar-empty', true],
    ['tab', false],
    // The document keeps the browser's own copy/paste/spelling menu.
    ['document', false],
    ['titlebar-button', false],
  ];
  for (const [target, answer] of expected) {
    assert.equal(m.isEditorWindowMenuTarget(target), answer, String(target));
  }
});

interface MenuProbe {
  label?: unknown;
  icon?: unknown;
  onClick?: unknown;
  disabled?: unknown;
  separator?: unknown;
}

// TC-REQ-FR-MDE-012-AC4-01
test("buildEditorWindowContextMenu({paneOpen}) 는 두 상태 모두 '파일 트리' 항목을 내고 열려 있을 때만 checked", async () => {
  const m = await loadPaneModel();
  for (const paneOpen of [false, true]) {
    const toggles: string[] = [];
    const items = m.buildEditorWindowContextMenu({ paneOpen, onTogglePane: () => toggles.push('toggle') });
    for (const item of items as readonly unknown[]) {
      assert.equal(typeof item, 'object', 'every menu item is an object');
      assert.notEqual(item, null);
    }
    const matches = (items as readonly MenuProbe[]).filter(item => item.separator !== true && item.label === '파일 트리');
    assert.equal(matches.length, 1, `exactly one '파일 트리' item when paneOpen=${paneOpen}`);
    const item = matches[0];
    assert.notEqual(item.disabled, true, 'the item stays usable while the pane is open');
    if (paneOpen) {
      assert.equal(item.icon, '✓', 'checked while open');
    } else {
      assert.equal(item.icon, undefined, 'no check mark while closed');
    }
    assert.equal(typeof item.onClick, 'function');
    (item.onClick as () => void)();
    assert.deepEqual(toggles, ['toggle'], 'choosing it runs the toggle once');
  }
});

// ---------------------------------------------------------------------------
// Mobile (AC-13)
// ---------------------------------------------------------------------------

// TC-REQ-FR-MDE-012-AC13-01
test('paneInitiallyCollapsed(isMobile=true) 는 true, collapseAfterOpen(isMobile) 은 모바일에서만 true', async () => {
  const m = await loadPaneModel();
  // On a phone the pane starts folded even when the workspace remembered it open.
  assert.equal(m.paneInitiallyCollapsed({ isMobile: true, savedCollapsed: false }), true);
  assert.equal(m.paneInitiallyCollapsed({ isMobile: true, savedCollapsed: true }), true);
  // On a desktop the remembered state wins.
  assert.equal(m.paneInitiallyCollapsed({ isMobile: false, savedCollapsed: false }), false);
  assert.equal(m.paneInitiallyCollapsed({ isMobile: false, savedCollapsed: true }), true);

  assert.equal(m.collapseAfterOpen(true), true);
  assert.equal(m.collapseAfterOpen(false), false);
});

// ---------------------------------------------------------------------------
// Shortcut focus (FR-FEX-005 AC-7 canonical, FR-MDE-012 AC-9)
// ---------------------------------------------------------------------------

// A fake node tree with nothing but contains(), like Node.contains: a node
// contains itself and everything below it.
interface FakeNode {
  name: string;
  children: FakeNode[];
  contains(node: unknown): boolean;
}

function node(name: string, children: FakeNode[] = []): FakeNode {
  const self: FakeNode = {
    name,
    children,
    contains(other: unknown): boolean {
      if (other === null || other === undefined) return false;
      if (other === self) return true;
      return self.children.some(child => child.contains(other));
    },
  };
  return self;
}

function editorWindowTree() {
  const treeRow = node('tree-row');
  const pane = node('pane', [treeRow]);
  const codeMirror = node('cm-content');
  const documentArea = node('document', [codeMirror]);
  const titlebar = node('titlebar');
  const windowRoot = node('window', [titlebar, pane, documentArea]);
  return { windowRoot, titlebar, pane, treeRow, documentArea, codeMirror };
}

type FocusInput = Parameters<PaneModel['decidePaneShortcutFocus']>[0];

function focusInput(pane: FakeNode | null, documentArea: FakeNode | null, active: FakeNode | null): FocusInput {
  return { pane, document: documentArea, active } as unknown as FocusInput;
}

// TC-REQ-FR-MDE-012-AC9-01
test('문서 영역에 포커스가 있을 때 Delete 는 decideFileExplorerShortcut 이 ignore 이고 createFileExplorerShortcutHandler 가 preventDefault 를 부르지 않는다', async () => {
  const m = await loadPaneModel();
  const shortcuts = await loadShortcuts();
  const t = editorWindowTree();

  function press(active: FakeNode) {
    const focusedInSurface = m.decidePaneShortcutFocus(focusInput(t.pane, t.documentArea, active));
    const event = { key: 'Delete', ctrlKey: false, metaKey: false };
    const decision = shortcuts.decideFileExplorerShortcut({ event, focusedInSurface, selectionCount: 1 });
    const ran: string[] = [];
    let prevented = 0;
    const handler = shortcuts.createFileExplorerShortcutHandler({
      getContext: () => ({ focusedInSurface, selectionCount: 1 }),
      run: d => { ran.push(d.kind); },
    });
    handler({ ...event, preventDefault: () => { prevented += 1; } });
    return { decision, ran, prevented };
  }

  // Delete typed in the document deletes a character, not the selected file.
  const inDocument = press(t.codeMirror);
  assert.deepEqual(inDocument.decision, { kind: 'ignore' });
  assert.equal(inDocument.prevented, 0, 'the key keeps its default in the document');
  assert.deepEqual(inDocument.ran, []);

  // The same press on the tree is a file operation -- so the pair above is not
  // passing merely because the handler ignores everything.
  const inTree = press(t.treeRow);
  assert.deepEqual(inTree.decision, { kind: 'confirm-delete' });
  assert.equal(inTree.prevented, 1);
  assert.deepEqual(inTree.ran, ['confirm-delete']);
});

// TC-REQ-FR-FEX-005-AC7-01
test('decidePaneShortcutFocus({pane, document, active}): active 가 트리 패널 안일 때만 focusedInSurface=true, 문서 영역·창 제목줄은 false', async () => {
  const m = await loadPaneModel();
  const t = editorWindowTree();
  const cases: [string, FakeNode | null, boolean][] = [
    ['a row in the tree', t.treeRow, true],
    ['the pane itself', t.pane, true],
    ['the document text', t.codeMirror, false],
    ['the document area', t.documentArea, false],
    // The window surface contains the titlebar; the pane does not. Scoping to
    // the window would answer true here.
    ['the window titlebar', t.titlebar, false],
    ['the window root', t.windowRoot, false],
    ['nothing focused', null, false],
  ];
  for (const [label, active, expected] of cases) {
    assert.equal(m.decidePaneShortcutFocus(focusInput(t.pane, t.documentArea, active)), expected, label);
  }
  // A pane that is not mounted takes no keys.
  assert.equal(m.decidePaneShortcutFocus(focusInput(null, t.documentArea, t.treeRow)), false, 'no pane');
});
