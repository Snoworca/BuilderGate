import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as TrayModelModule from '../../src/components/fileExplorer/fileExplorerTrayModel.ts';
import { fileExplorerDialogId } from '../../src/components/fileExplorer/fileExplorerDialog.ts';
import type { FileExplorerTab, FileExplorerTabs } from '../../src/components/fileExplorer/fileExplorerTabsState.ts';
import { createInitialFileTreeState } from '../../src/components/fileExplorer/fileTreeState.ts';
import { minimizeEditorWindow, restoreEditorWindow } from '../../src/components/editor/editorWindowVisibility.ts';
import { toggleMaximize, type EditorWindowPlacementState } from '../../src/components/editor/editorWindowPlacement.ts';

// FR-FEX-004 AC-1~AC-6 -- the explorer window's minimize, header tray row and
// revival, as pure decisions over the record the window hook keeps.
//
// The editor window already owns these rules: hiding is a flag beside the
// placement (editorWindowVisibility.ts) and 최대화 is a placement transition
// (editorWindowPlacement.ts). The explorer must go through those same functions
// rather than grow a second copy that can drift, so each transition case checks
// the result against the editor function AND that the module's source calls it.
// The source is read with comments stripped so prose can neither trip nor
// satisfy a check, and it is read inside the case: a missing module fails the
// case instead of passing it.
//
// Where the icon sits in the header and that a hidden window stays mounted need
// a browser; the wiring guard (fileExplorerMinimizeWiring.test.ts) holds the
// React side by its source.
//
// The module is loaded inside each case: a static import of a missing module
// kills the runner before any case is named. The `import type` line is erased
// at runtime and lets tsc check every call against the real signatures.

type M = typeof TrayModelModule;
const MODEL_URL = new URL('../../src/components/fileExplorer/fileExplorerTrayModel.ts', import.meta.url);

async function load(): Promise<M> {
  return await import(MODEL_URL.href) as M;
}

function modelSource(): string {
  return readFileSync(MODEL_URL, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

// A named import from the given module, `.ts` suffix optional. Aliasing is not
// accepted on purpose: the point is that a reader grepping for the editor rule
// finds the explorer using it.
function importsFrom(source: string, symbol: string, moduleTail: string): boolean {
  const pattern = new RegExp(
    `import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${moduleTail}(?:\\.ts)?['"]`,
  );
  return pattern.test(source);
}

function calls(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol}\\s*\\(`).test(source);
}

type ExplorerRecord = FileExplorerTabs & EditorWindowPlacementState & { minimized: boolean };

function tabOf(id: string, root: string, overrides: Partial<FileExplorerTab> = {}): FileExplorerTab {
  return {
    id,
    originTabId: `term-${id}`,
    sessionId: `session-${id}`,
    tree: createInitialFileTreeState({ root }),
    sort: null,
    scrollAnchor: null,
    origin: 'opened',
    ...overrides,
  };
}

// An explorer window opens floating (it never opens into stage the way an
// editor window does), so the fixture starts there with a rect of its own.
function recordOf(overrides: Partial<ExplorerRecord> = {}): ExplorerRecord {
  const tabs = [tabOf('fx-1', 'C:\\Work\\proj')];
  return {
    tabs,
    activeTabId: 'fx-1',
    minimized: false,
    placement: 'floating',
    placementBeforeStage: null,
    floatingRect: { x: 120, y: 80, width: 640, height: 480 },
    ...overrides,
  };
}

test('minimizeFileExplorerRecord 는 minimized 만 세우고 tabs·activeTabId 는 같은 참조로 남긴다', async () => {
  const { minimizeFileExplorerRecord } = await load();
  const record = recordOf();

  const minimized = minimizeFileExplorerRecord(record);

  assert.equal(minimized.minimized, true);
  // Same references: a copied tab list would hand the window a new tree, and
  // the expanded directories and selection live in that tree (AC-1, AC-2).
  assert.equal(minimized.tabs, record.tabs);
  assert.equal(minimized.activeTabId, record.activeTabId);
  assert.equal(minimized.placement, record.placement);
  assert.equal(minimized.placementBeforeStage, record.placementBeforeStage);
  assert.equal(minimized.floatingRect, record.floatingRect);
  // A new record, the input untouched -- React sees the change only this way.
  assert.notEqual(minimized, record);
  assert.equal(record.minimized, false);
  // The editor's rule, not a look-alike.
  assert.deepEqual(minimized, minimizeEditorWindow(record));

  const source = modelSource();
  assert.ok(
    importsFrom(source, 'minimizeEditorWindow', 'editor/editorWindowVisibility'),
    'fileExplorerTrayModel.ts imports minimizeEditorWindow from editorWindowVisibility',
  );
  assert.ok(calls(source, 'minimizeEditorWindow'), 'minimizeFileExplorerRecord delegates to minimizeEditorWindow');
  assert.doesNotMatch(
    source,
    /\bminimized\s*:\s*(?:true|false)\b/,
    'the hiding flag is written by the editor functions, not by a literal here',
  );
});

test('최소화 후 되살린 레코드가 minimized 를 뺀 모든 필드(탭 뿌리·모드·정렬·앵커·활성 탭)에서 원래와 같다', async () => {
  const { minimizeFileExplorerRecord, restoreFileExplorerRecord } = await load();

  const listTree = createInitialFileTreeState({ root: 'D:\\data', mode: 'list' });
  listTree.expandedPaths.add('D:\\data\\logs');
  listTree.selectedPaths.add('D:\\data\\logs\\a.txt');
  listTree.anchorPath = 'D:\\data\\logs\\a.txt';
  const tabs = [
    tabOf('fx-1', 'C:\\Work\\proj'),
    tabOf('fx-2', 'D:\\data', {
      tree: listTree,
      sort: { key: 'name', dir: 'desc' },
      scrollAnchor: 'D:\\data\\logs',
    }),
  ];
  const record = recordOf({ tabs, activeTabId: 'fx-2' });

  const revived = restoreFileExplorerRecord(minimizeFileExplorerRecord(record));

  assert.equal(revived.minimized, false);
  for (const key of Object.keys(record) as (keyof ExplorerRecord)[]) {
    if (key === 'minimized') continue;
    assert.equal(revived[key], record[key], `${key} survives a minimize and revive by reference`);
  }
  assert.deepEqual(Object.keys(revived).sort(), Object.keys(record).sort(), 'no field is added or dropped');

  // Spelled out as well, so a reader sees what AC-2 promises the user.
  const tab = revived.tabs[1];
  assert.equal(tab.tree.root, 'D:\\data');
  assert.equal(tab.tree.mode, 'list');
  assert.deepEqual([...tab.tree.expandedPaths], ['D:\\data\\logs']);
  assert.deepEqual([...tab.tree.selectedPaths], ['D:\\data\\logs\\a.txt']);
  assert.equal(tab.tree.anchorPath, 'D:\\data\\logs\\a.txt');
  assert.deepEqual(tab.sort, { key: 'name', dir: 'desc' });
  assert.equal(tab.scrollAnchor, 'D:\\data\\logs');
  assert.equal(revived.activeTabId, 'fx-2');

  assert.deepEqual(revived, restoreEditorWindow(minimizeEditorWindow(record)));
  const source = modelSource();
  assert.ok(
    importsFrom(source, 'restoreEditorWindow', 'editor/editorWindowVisibility'),
    'fileExplorerTrayModel.ts imports restoreEditorWindow from editorWindowVisibility',
  );
  assert.ok(calls(source, 'restoreEditorWindow'), 'restoreFileExplorerRecord delegates to restoreEditorWindow');
});

test('listFileExplorerTrayEntries: 탭 3개인 창도 줄 1개, 워크스페이스 둘이면 줄 2개', async () => {
  const { listFileExplorerTrayEntries } = await load();
  const names: Record<string, string> = { 'ws-a': 'Alpha', 'ws-b': 'Beta' };
  const nameOf = (workspaceId: string): string | undefined => names[workspaceId];

  const threeTabs = {
    workspaceId: 'ws-a',
    ...recordOf({
      tabs: [tabOf('fx-1', 'C:\\a'), tabOf('fx-2', 'C:\\b'), tabOf('fx-3', 'C:\\c')],
    }),
  };
  const single = listFileExplorerTrayEntries([threeTabs], nameOf);
  assert.equal(single.length, 1, 'one row per window, never one per tab');
  assert.equal(single[0].workspaceId, 'ws-a');

  // A minimized window and a visible one both get a row: the tray lists open
  // windows, the same scope the editor rows use.
  const two = listFileExplorerTrayEntries(
    [threeTabs, { workspaceId: 'ws-b', ...recordOf({ minimized: true }) }],
    nameOf,
  );
  assert.deepEqual(two.map((entry) => entry.workspaceId), ['ws-a', 'ws-b'], 'input order, one row each');

  assert.deepEqual(listFileExplorerTrayEntries([], nameOf), []);
});

test('hasHeaderTrayWindows(editorCount, explorerCount): 어느 한쪽만 있어도 true, 둘 다 0 이면 false', async () => {
  const { hasHeaderTrayWindows } = await load();

  assert.equal(hasHeaderTrayWindows(0, 0), false);
  // Explorer windows alone must be enough: gating the icon on editor windows
  // would leave a minimized explorer with no way back.
  assert.equal(hasHeaderTrayWindows(0, 1), true);
  assert.equal(hasHeaderTrayWindows(1, 0), true);
  assert.equal(hasHeaderTrayWindows(2, 3), true);
});

test("줄 라벨이 '파일 탐색기 — {워크스페이스 이름}', 이름이 없으면 '(이름 없음)'", async () => {
  const { listFileExplorerTrayEntries } = await load();
  const nameOf = (workspaceId: string): string | undefined => (workspaceId === 'ws-a' ? 'Alpha' : undefined);

  const entries = listFileExplorerTrayEntries(
    [{ workspaceId: 'ws-a', ...recordOf() }, { workspaceId: 'ws-gone', ...recordOf() }],
    nameOf,
  );

  // U+2014 with a space on each side, exactly as AC-4 writes it.
  assert.equal(entries[0].label, '파일 탐색기 \u2014 Alpha');
  assert.equal(entries[1].label, '파일 탐색기 \u2014 (이름 없음)');

  // The placeholder is the editor tray's, shared rather than retyped, so the
  // two kinds of row can never disagree about how a missing name reads.
  const editorTray = await import('../../src/components/editor/editorTrayModel.ts') as Record<string, unknown>;
  assert.equal(editorTray.MISSING_WORKSPACE_NAME, '(이름 없음)', 'editorTrayModel.ts exports MISSING_WORKSPACE_NAME');
  const source = modelSource();
  assert.ok(
    importsFrom(source, 'MISSING_WORKSPACE_NAME', 'editor/editorTrayModel'),
    'fileExplorerTrayModel.ts imports MISSING_WORKSPACE_NAME from editorTrayModel',
  );
  assert.doesNotMatch(source, /\(이름 없음\)/, 'the placeholder text is not retyped here');
});

test('decideReviveFileExplorer: 다른 워크스페이스면 switchWorkspaceId, 설정 화면이면 showWorkspaceScreen, raiseDialogId 는 file-explorer:{id}', async () => {
  const { decideReviveFileExplorer } = await load();

  assert.deepEqual(
    decideReviveFileExplorer({ workspaceId: 'ws-a', activeWorkspaceId: 'ws-a', screen: 'workspace' }),
    { switchWorkspaceId: null, showWorkspaceScreen: false, raiseDialogId: 'file-explorer:ws-a' },
    'already in place: only the raise is left',
  );
  assert.deepEqual(
    decideReviveFileExplorer({ workspaceId: 'ws-b', activeWorkspaceId: 'ws-a', screen: 'workspace' }),
    { switchWorkspaceId: 'ws-b', showWorkspaceScreen: false, raiseDialogId: 'file-explorer:ws-b' },
  );
  assert.deepEqual(
    decideReviveFileExplorer({ workspaceId: 'ws-a', activeWorkspaceId: 'ws-a', screen: 'settings' }),
    { switchWorkspaceId: null, showWorkspaceScreen: true, raiseDialogId: 'file-explorer:ws-a' },
  );
  assert.deepEqual(
    decideReviveFileExplorer({ workspaceId: 'ws-b', activeWorkspaceId: 'ws-a', screen: 'settings' }),
    { switchWorkspaceId: 'ws-b', showWorkspaceScreen: true, raiseDialogId: 'file-explorer:ws-b' },
  );
  // No active workspace yet: the window's own workspace is the one to show.
  assert.deepEqual(
    decideReviveFileExplorer({ workspaceId: 'ws-b', activeWorkspaceId: null, screen: 'workspace' }),
    { switchWorkspaceId: 'ws-b', showWorkspaceScreen: false, raiseDialogId: 'file-explorer:ws-b' },
  );

  // The id comes from the one function the window registers under; a retyped
  // prefix would raise nothing the day that function changes.
  const decision = decideReviveFileExplorer({ workspaceId: 'ws-c', activeWorkspaceId: 'ws-c', screen: 'workspace' });
  assert.equal(decision.raiseDialogId, fileExplorerDialogId('ws-c'));
  const source = modelSource();
  assert.ok(
    importsFrom(source, 'fileExplorerDialogId', 'fileExplorerDialog'),
    'fileExplorerTrayModel.ts imports fileExplorerDialogId',
  );
  assert.doesNotMatch(source, /file-explorer:/, 'the dialog id prefix is not retyped here');
});

test('toggleMaximize 로 stage 가 된 레코드를 최소화했다 되살려도 placement 가 stage 다', async () => {
  const { toggleFileExplorerMaximize, minimizeFileExplorerRecord, restoreFileExplorerRecord } = await load();
  const record = recordOf();

  const maximized = toggleFileExplorerMaximize(record);
  assert.equal(maximized.placement, 'stage');
  assert.equal(maximized.placementBeforeStage, 'floating');
  assert.equal(maximized.tabs, record.tabs, 'maximizing does not touch the tabs');
  assert.deepEqual(maximized, toggleMaximize(record), 'the editor placement rule, not a look-alike');

  const revived = restoreFileExplorerRecord(minimizeFileExplorerRecord(maximized));
  assert.equal(revived.minimized, false);
  assert.equal(revived.placement, 'stage', 'a maximized window comes back maximized');
  assert.equal(revived.placementBeforeStage, 'floating');
  assert.equal(revived.floatingRect, record.floatingRect);

  // And 최대화 still has its way back to the rect the window floated at.
  const unmaximized = toggleFileExplorerMaximize(revived);
  assert.equal(unmaximized.placement, 'floating');
  assert.equal(unmaximized.placementBeforeStage, null);
  assert.deepEqual(unmaximized.floatingRect, { x: 120, y: 80, width: 640, height: 480 });

  const source = modelSource();
  assert.ok(
    importsFrom(source, 'toggleMaximize', 'editor/editorWindowPlacement'),
    'fileExplorerTrayModel.ts imports toggleMaximize from editorWindowPlacement',
  );
  assert.ok(calls(source, 'toggleMaximize'), 'toggleFileExplorerMaximize delegates to toggleMaximize');
  assert.doesNotMatch(
    source,
    /\bplacementBeforeStage\s*:/,
    'the placement record is written by the editor transition, not here',
  );
});

test('[FR-FEX-009 AC-2] decideReviveFileExplorerAction: 창 레코드가 없으면(닫힘·새로고침·편집기 창에서 시작한 작업) 그 워크스페이스의 활성 탭으로 창을 연다', async () => {
  const { decideReviveFileExplorerAction } = await load();
  // The 응답 대기 button is the only way to reach a question whose window is
  // gone; reviving nothing would leave the job waiting on the server forever.
  assert.deepEqual(
    decideReviveFileExplorerAction({ hasWindow: false, workspaceActiveTabId: 'tab-7' }),
    { kind: 'open', originTabId: 'tab-7' },
  );
  // No active tab is known: the open still goes ahead and the hook falls back to the workspace's session.
  assert.deepEqual(
    decideReviveFileExplorerAction({ hasWindow: false, workspaceActiveTabId: null }),
    { kind: 'open', originTabId: '' },
  );
  assert.deepEqual(
    decideReviveFileExplorerAction({ hasWindow: true, workspaceActiveTabId: 'tab-7' }),
    { kind: 'restore' },
    'an existing window is un-hidden and raised, not opened again',
  );
});
