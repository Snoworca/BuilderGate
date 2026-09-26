import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type * as TabCloseMenuModule from '../../src/utils/tabCloseMenu.ts';
import type * as EditorEditMenuModule from '../../src/components/editor/editorEditMenu.ts';
import { closeEditorTabs } from '../../src/components/editor/editorWindowTabs.ts';
import { closeTabs, type FileExplorerTabs } from '../../src/components/fileExplorer/fileExplorerTabsState.ts';

// FR-MDE-021 / FR-FEX-012 -- the tab context menus (이 탭 닫기 · 다른 탭 닫기 ·
// 모든 탭 닫기) of the editor window and the file explorer window.
// FR-MDE-022 -- the editor body's context menu (모두 선택 · 복사 · 잘라내기 · 붙여넣기).
//
// Contracts fixed here:
//   src/utils/tabCloseMenu.ts
//     buildTabCloseMenuItems({ tabCount, onCloseThis, onCloseOthers, onCloseAll }) -> ContextMenuItem[]
//     planBulkTabClose(tabs: {id, dirty}[], keepId: string | null) -> { targets, dirty, clean }
//   src/components/editor/editorWindowTabs.ts
//     closeEditorTabs(set, filePaths, keepActive?) -> set   (one pass; keepActive becomes active)
//   src/components/fileExplorer/fileExplorerTabsState.ts
//     closeTabs(state, tabIds, keepActiveId?) -> state
//   src/components/editor/editorEditMenu.ts
//     buildEditorEditMenuItems({ hasSelection, readOnly, onSelectAll, onCopy, onCut, onPaste })
//     runEditorEditCommand(view, command, clipboard) -> Promise<void>
//       view: { state: EditorState, dispatch(tr | spec), focus() }
//       clipboard: { readText(): Promise<string>, writeText(text): Promise<void> }
const testDir = dirname(fileURLToPath(import.meta.url));
const src = (path: string): string => readFileSync(resolve(testDir, '../../src', path), 'utf8');

async function menuModule(): Promise<typeof TabCloseMenuModule> {
  return await import('../../src/utils/tabCloseMenu.ts') as typeof TabCloseMenuModule;
}
async function editModule(): Promise<typeof EditorEditMenuModule> {
  return await import('../../src/components/editor/editorEditMenu.ts') as typeof EditorEditMenuModule;
}

type Item = { label?: string; disabled?: boolean; separator?: boolean; onClick?: () => void };

// TC-REQ-FR-MDE-021-AC1-01
test('TC-REQ-FR-MDE-021-AC1-01: the tab menu has 이 탭 닫기 · 다른 탭 닫기 · 모든 탭 닫기, each wired to its handler', async () => {
  const mod = await menuModule();
  const calls: string[] = [];
  const items = mod.buildTabCloseMenuItems({
    tabCount: 3,
    onCloseThis: () => calls.push('this'),
    onCloseOthers: () => calls.push('others'),
    onCloseAll: () => calls.push('all'),
  }) as Item[];
  const actions = items.filter(item => item.separator !== true);
  assert.deepEqual(actions.map(item => item.label), ['이 탭 닫기', '다른 탭 닫기', '모든 탭 닫기']);
  actions.forEach(item => item.onClick?.());
  assert.deepEqual(calls, ['this', 'others', 'all']);
  assert.ok(actions.every(item => item.disabled !== true));
});

// TC-REQ-FR-MDE-021-AC6-01
test('TC-REQ-FR-MDE-021-AC6-01: 다른 탭 닫기 is disabled when there is no other tab', async () => {
  const mod = await menuModule();
  const items = (mod.buildTabCloseMenuItems({ tabCount: 1, onCloseThis() {}, onCloseOthers() {}, onCloseAll() {} }) as Item[])
    .filter(item => item.separator !== true);
  assert.equal(items.find(item => item.label === '다른 탭 닫기')?.disabled, true);
  assert.notEqual(items.find(item => item.label === '이 탭 닫기')?.disabled, true);
  assert.notEqual(items.find(item => item.label === '모든 탭 닫기')?.disabled, true);
});

// TC-REQ-FR-MDE-021-AC4-01
test('TC-REQ-FR-MDE-021-AC4-01: planBulkTabClose splits the targets into dirty and clean, keeping the kept tab out', async () => {
  const mod = await menuModule();
  const tabs = [{ id: 'a', dirty: false }, { id: 'b', dirty: true }, { id: 'c', dirty: false }, { id: 'd', dirty: true }];
  const others = mod.planBulkTabClose(tabs, 'b');
  assert.deepEqual(others.targets, ['a', 'c', 'd']);
  assert.deepEqual(others.dirty, ['d']);
  assert.deepEqual(others.clean, ['a', 'c']);
  const all = mod.planBulkTabClose(tabs, null);
  assert.deepEqual(all.targets, ['a', 'b', 'c', 'd']);
  assert.deepEqual(all.dirty, ['b', 'd']);
});

// TC-REQ-FR-MDE-021-AC4-02
test('TC-REQ-FR-MDE-021-AC4-02: closeEditorTabs closes several documents in one pass and keeps the kept tab active', () => {
  const set = { tabs: [{ filePath: '/a' }, { filePath: '/b' }, { filePath: '/c' }], activeFilePath: '/a' };
  const others = closeEditorTabs(set, ['/a', '/c'], '/b');
  assert.deepEqual(others.tabs.map(tab => tab.filePath), ['/b']);
  assert.equal(others.activeFilePath, '/b');
  const all = closeEditorTabs(set, ['/a', '/b', '/c']);
  assert.deepEqual(all.tabs, []);
  assert.equal(all.activeFilePath, null);
  // Closing the active one alone still hands activity to a neighbour.
  const one = closeEditorTabs(set, ['/a']);
  assert.equal(one.activeFilePath, '/b');
});

// TC-REQ-FR-FEX-012-AC2-01
test('TC-REQ-FR-FEX-012-AC2-01: closeTabs closes several explorer tabs in one pass; 다른 탭 닫기 leaves the kept tab active', () => {
  const tab = (id: string) => ({ id } as unknown as FileExplorerTabs['tabs'][number]);
  const state = { tabs: [tab('1'), tab('2'), tab('3')], activeTabId: '1' } as FileExplorerTabs;
  const others = closeTabs(state, ['1', '3'], '2');
  assert.deepEqual(others.tabs.map(item => item.id), ['2']);
  assert.equal(others.activeTabId, '2');
  const all = closeTabs(state, ['1', '2', '3']);
  assert.deepEqual(all.tabs, []);
  assert.equal(all.activeTabId, null);
});

// TC-REQ-FR-FEX-012-AC3-01
test('TC-REQ-FR-FEX-012-AC3-01: the explorer hook closes many tabs in one update and writes the emptied list when none remain', () => {
  const hook = src('hooks/useFileExplorerWindows.ts');
  const start = hook.indexOf('const closeTabs = useCallback(');
  assert.ok(start >= 0, 'useFileExplorerWindows needs closeTabs');
  const body = hook.slice(start, hook.indexOf('}, [', start));
  assert.match(body, /closeExplorerTabs\(/);
  assert.match(body, /saveFileExplorerStateForWorkspace\(workspaceId, \{ tabs: \[\], activeTabId: null \}\)/);
  assert.equal((body.match(/setWindows\(/g) ?? []).length, 1, 'one state update for the whole batch');
});

// TC-REQ-FR-FEX-012-AC1-01
test('TC-REQ-FR-FEX-012-AC1-01: the explorer tab strip opens the tab menu on right click and long press', () => {
  const bar = src('components/fileExplorer/FileExplorerTabBar.tsx');
  assert.match(bar, /onContextMenu=/);
  assert.match(bar, /useLongPress\(/);
  const win = src('components/fileExplorer/FileExplorerWindow.tsx');
  assert.match(win, /buildTabCloseMenuItems\(/);
  assert.match(win, /actions\.closeTabs\(/);
});

// TC-REQ-FR-MDE-021-AC2-01
test('TC-REQ-FR-MDE-021-AC2-01: the editor tab bar opens the tab menu on right click and long press, and closes in batches', () => {
  const bar = src('components/editor/EditorTabBar.tsx');
  assert.match(bar, /onContextMenu=/);
  assert.match(bar, /useLongPress\(/);
  const win = src('components/editor/EditorWindow.tsx');
  assert.match(win, /buildTabCloseMenuItems\(/);
  assert.match(win, /planBulkTabClose\(/);
  assert.match(win, /onCloseTabs\(/);
  const hook = src('hooks/useEditorWindows.ts');
  assert.match(hook, /const closeDocuments = useCallback\(/);
  assert.match(hook, /closeEditorTabs\(/);
});

// TC-REQ-FR-MDE-021-AC5-01
test('TC-REQ-FR-MDE-021-AC5-01: dirty targets raise one prompt with save-all, discard and cancel; save-all closes only what saved', () => {
  const win = src('components/editor/EditorWindow.tsx');
  assert.match(win, /bulkClosePrompt/);
  assert.match(win, /모두 저장/);
  assert.match(win, /저장 안 함/);
  assert.match(win, /saveForClose\(\)/);
  const panel = src('components/editor/EditorDocumentPanel.tsx');
  assert.match(panel, /saveForClose:/);
});

// TC-REQ-FR-MDE-022-AC3-01
test('TC-REQ-FR-MDE-022-AC3-01: the edit menu disables copy/cut without a selection and cut/paste on a read-only document', async () => {
  const mod = await editModule();
  const noop = () => {};
  const labels = (items: Item[]) => items.filter(item => item.separator !== true);
  const find = (items: Item[], label: string) => labels(items).find(item => item.label === label)!;
  const base = { onSelectAll: noop, onCopy: noop, onCut: noop, onPaste: noop };
  const full = mod.buildEditorEditMenuItems({ ...base, hasSelection: true, readOnly: false }) as Item[];
  assert.deepEqual(labels(full).map(item => item.label), ['모두 선택', '복사', '잘라내기', '붙여넣기']);
  assert.ok(labels(full).every(item => item.disabled !== true));
  const empty = mod.buildEditorEditMenuItems({ ...base, hasSelection: false, readOnly: false }) as Item[];
  assert.equal(find(empty, '복사').disabled, true);
  assert.equal(find(empty, '잘라내기').disabled, true);
  assert.notEqual(find(empty, '붙여넣기').disabled, true);
  const readOnly = mod.buildEditorEditMenuItems({ ...base, hasSelection: true, readOnly: true }) as Item[];
  assert.equal(find(readOnly, '잘라내기').disabled, true);
  assert.equal(find(readOnly, '붙여넣기').disabled, true);
  assert.notEqual(find(readOnly, '복사').disabled, true);
  assert.notEqual(find(readOnly, '모두 선택').disabled, true);
});

async function fakeView(doc: string, anchor: number, head: number, readOnly = false) {
  const { EditorState, EditorSelection } = await import('@codemirror/state');
  const view = {
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: readOnly ? [EditorState.readOnly.of(true)] : [],
    }),
    dispatch(spec: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      view.state = view.state.update(spec as any).state;
    },
    focus() {},
  };
  return view;
}

function fakeClipboard(initial = '') {
  const clip = {
    text: initial,
    async readText() { return clip.text; },
    async writeText(text: string) { clip.text = text; },
  };
  return clip;
}

// TC-REQ-FR-MDE-022-AC2-01
test('TC-REQ-FR-MDE-022-AC2-01: select all, copy, cut and paste act on the editor state and the clipboard', async () => {
  const mod = await editModule();
  const view = await fakeView('hello world', 0, 5);
  const clip = fakeClipboard();
  await mod.runEditorEditCommand(view, 'copy', clip);
  assert.equal(clip.text, 'hello');
  assert.equal(view.state.doc.toString(), 'hello world');

  await mod.runEditorEditCommand(view, 'cut', clip);
  assert.equal(clip.text, 'hello');
  assert.equal(view.state.doc.toString(), ' world');

  clip.text = 'hi';
  await mod.runEditorEditCommand(view, 'paste', clip);
  assert.equal(view.state.doc.toString(), 'hi world');

  await mod.runEditorEditCommand(view, 'selectAll', clip);
  assert.equal(view.state.selection.main.from, 0);
  assert.equal(view.state.selection.main.to, view.state.doc.length);
});

// TC-REQ-FR-MDE-022-AC3-02
test('TC-REQ-FR-MDE-022-AC3-02: cut and paste leave a read-only document alone', async () => {
  const mod = await editModule();
  const view = await fakeView('locked', 0, 3, true);
  const clip = fakeClipboard('x');
  await mod.runEditorEditCommand(view, 'cut', clip);
  await mod.runEditorEditCommand(view, 'paste', clip);
  assert.equal(view.state.doc.toString(), 'locked');
});

// TC-REQ-FR-MDE-022-AC4-01
test('TC-REQ-FR-MDE-022-AC4-01: a clipboard failure changes nothing and does not throw', async () => {
  const mod = await editModule();
  const view = await fakeView('keep me', 0, 4);
  const broken = {
    readText: async () => { throw new Error('denied'); },
    writeText: async () => { throw new Error('denied'); },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await mod.runEditorEditCommand(view, 'cut', broken);
    await mod.runEditorEditCommand(view, 'paste', broken);
  } finally {
    console.warn = warn;
  }
  assert.equal(view.state.doc.toString(), 'keep me', 'a cut whose copy failed must not delete');
});

// TC-REQ-FR-MDE-022-AC1-01
test('TC-REQ-FR-MDE-022-AC1-01: the document body opens the edit menu on right click and long press', () => {
  const panel = src('components/editor/EditorDocumentPanel.tsx');
  assert.match(panel, /onContextMenu=\{openEditMenu\}/);
  assert.match(panel, /useLongPress\(/);
  assert.match(panel, /buildEditorEditMenuItems\(/);
  assert.match(panel, /runEditorEditCommand\(/);
  // The view is found from the editor's content DOM; the vendor files stay untouched.
  const menu = src('components/editor/editorEditMenu.ts');
  assert.match(menu, /EditorView\.findFromDOM\(/);
});
