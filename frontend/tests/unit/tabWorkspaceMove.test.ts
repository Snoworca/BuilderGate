// FR-ARCH-019: tabs move between workspaces by drag, in any state, and into a new workspace.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  findWorkspaceDropId,
  isTabMovable,
  resolveTabBarDropPoint,
  resolveWorkspaceDropTarget,
} from '../../src/components/Workspace/workspaceMoveTargets.ts';
import { resolveDragRelease } from '../../src/hooks/useDragReorder.ts';
import { tabDragStore } from '../../src/components/Workspace/tabDragStore.ts';
import type { Workspace, WorkspaceTabRuntime } from '../../src/types/workspace.ts';
import { koCatalog } from './i18nTestSetup.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const enCatalog = JSON.parse(read('../../public/locales/messages.en.json')) as Record<string, string>;

const workspaces: Workspace[] = [workspace('ws-1', 0), workspace('ws-2', 1), workspace('ws-3', 2)];
const tabs: WorkspaceTabRuntime[] = [tab('tab-1', 'ws-1'), tab('tab-2', 'ws-2'), tab('tab-3', 'ws-2')];

test('FR-ARCH-019 AC-2: a tab is movable whatever its session state', () => {
  assert.equal(isTabMovable(tab('a', 'ws-1')), true);
  assert.equal(isTabMovable({ ...tab('b', 'ws-1'), lifecycleState: 'stopped', recoverable: false }), true);
  assert.equal(isTabMovable({ ...tab('c', 'ws-1'), status: 'disconnected' }), true);
  assert.equal(isTabMovable(undefined), false);
});

test('FR-ARCH-019 AC-2: both terminal menus enable the move item through isTabMovable', () => {
  for (const source of [read('../../src/App.tsx'), read('../../src/components/Grid/MosaicContainer.tsx')]) {
    assert.doesNotMatch(source, /function isWorkspaceMoveDisabled/u);
    assert.match(source, /disabled: [^,\n]*!isTabMovable\(/u);
  }
});

test('FR-ARCH-019 AC-2: the tab bar menu offers the move too, since a stopped tab shows no terminal menu', () => {
  const tabBar = read('../../src/components/Workspace/WorkspaceTabBar.tsx');
  assert.match(tabBar, /label: t\('contextMenu\.moveWorkspace'\)/u);
  assert.match(tabBar, /onRequestMoveTab\(ctx\.targetId\)/u);
  assert.match(read('../../src/App.tsx'), /onRequestMoveTab=\{handleRequestWorkspaceMove\}\n\s*onMoveTabToWorkspace=/u);
});

test('FR-ARCH-019 AC-1: the hovered workspace is a drop target unless it is the source, full or unknown', () => {
  const input = { workspaces, tabs, sourceWorkspaceId: 'ws-1', maxTabsPerWorkspace: 2 };
  assert.equal(resolveWorkspaceDropTarget({ ...input, hoveredWorkspaceId: 'ws-3' }), 'ws-3');
  assert.equal(resolveWorkspaceDropTarget({ ...input, hoveredWorkspaceId: 'ws-1' }), null);
  assert.equal(resolveWorkspaceDropTarget({ ...input, hoveredWorkspaceId: 'ws-2' }), null);
  assert.equal(resolveWorkspaceDropTarget({ ...input, hoveredWorkspaceId: 'ws-9' }), null);
  assert.equal(resolveWorkspaceDropTarget({ ...input, hoveredWorkspaceId: null }), null);
});

test('FR-ARCH-019 AC-1: the workspace under the pointer is read from data-workspace-drop-id', () => {
  const item = { dataset: { workspaceDropId: 'ws-3' } };
  const inside = { closest: (selector: string) => (selector === '[data-workspace-drop-id]' ? item : null) };
  assert.equal(findWorkspaceDropId(inside), 'ws-3');
  assert.equal(findWorkspaceDropId({ closest: () => null }), null);
  assert.equal(findWorkspaceDropId(null), null);
  const workspaceItem = read('../../src/components/Workspace/WorkspaceItem.tsx');
  assert.match(workspaceItem, /data-workspace-drop-id=\{workspace\.id\}/u);
  assert.match(workspaceItem, /tab-drop-target/u);
});

test('FR-ARCH-019 AC-1: releasing over a workspace moves, over the tab bar reorders, elsewhere nothing', () => {
  assert.deepEqual(resolveDragRelease({ fromIndex: 1, dropTargetIndex: 3, externalTargetId: 'ws-3' }), { kind: 'external', targetId: 'ws-3' });
  assert.deepEqual(resolveDragRelease({ fromIndex: 1, dropTargetIndex: 3, externalTargetId: null }), { kind: 'reorder', to: 2 });
  assert.deepEqual(resolveDragRelease({ fromIndex: 2, dropTargetIndex: 0, externalTargetId: null }), { kind: 'reorder', to: 0 });
  assert.deepEqual(resolveDragRelease({ fromIndex: 1, dropTargetIndex: 1, externalTargetId: null }), { kind: 'none' });
  assert.deepEqual(resolveDragRelease({ fromIndex: 1, dropTargetIndex: 2, externalTargetId: null }), { kind: 'none' });
  // Off the tab bar and off every workspace: nothing.
  assert.deepEqual(resolveDragRelease({ fromIndex: 1, dropTargetIndex: null, externalTargetId: null }), { kind: 'none' });
});

test('FR-ARCH-019 AC-1: the drag store tells the sidebar which workspace the tab would drop on', () => {
  const seen: Array<string | null> = [];
  const off = tabDragStore.subscribe(() => seen.push(tabDragStore.getState().hoverWorkspaceId));
  tabDragStore.begin({ tabId: 'tab-1', sourceWorkspaceId: 'ws-1' });
  tabDragStore.hover('ws-3');
  tabDragStore.hover('ws-3');
  tabDragStore.end();
  off();
  assert.deepEqual(seen, [null, 'ws-3', null]);
  assert.equal(tabDragStore.getState().tabId, null);
});

test('FR-ARCH-019 AC-1: the tab bar drag asks for external drops and the app moves the tab', () => {
  const tabBar = read('../../src/components/Workspace/WorkspaceTabBar.tsx');
  assert.match(tabBar, /onMoveTabToWorkspace\(/u);
  assert.match(tabBar, /useDragReorder\(\{[^}]*externalDrop,\n\s*\}\);/u);
  const app = read('../../src/App.tsx');
  assert.match(app, /onMoveTabToWorkspace=\{handleDropTabOnWorkspace\}/u);
});

test('FR-ARCH-019 AC-3: the move dialog offers moving into a new workspace', () => {
  const dialog = read('../../src/components/Workspace/WorkspaceMoveDialog.tsx');
  assert.match(dialog, /onClick=\{onMoveToNewWorkspace\}/u);
  assert.match(dialog, /t\('workspace\.move\.newWorkspace'\)/u);
  assert.ok(koCatalog['workspace.move.newWorkspace']);
  assert.ok(enCatalog['workspace.move.newWorkspace']);
  const app = read('../../src/App.tsx');
  assert.match(app, /onMoveToNewWorkspace=\{handleMoveTabToNewWorkspace\}/u);
  const manager = read('../../src/hooks/useWorkspaceManager.ts');
  assert.match(manager, /const moveTabToNewWorkspace = useCallback\(/u);
});

test('FR-ARCH-019 AC-1: only the tab bar strip reorders; a sidebar workspace never does, even one that refuses the tab', () => {
  const tabBarRect = { left: 220, right: 1900, top: 60, bottom: 96 };
  const base = { tabBarRect, slackPx: 40, canDrop: (id: string) => id === 'ws-3' };
  // Over the tab bar, or just below it.
  assert.deepEqual(resolveTabBarDropPoint({ ...base, hoveredWorkspaceId: null, x: 500, y: 80 }), { targetId: null, overList: true });
  assert.deepEqual(resolveTabBarDropPoint({ ...base, hoveredWorkspaceId: null, x: 500, y: 130 }), { targetId: null, overList: true });
  // A workspace that takes the tab.
  assert.deepEqual(resolveTabBarDropPoint({ ...base, hoveredWorkspaceId: 'ws-3', x: 100, y: 120 }), { targetId: 'ws-3', overList: false });
  // The first sidebar workspace sits level with the tab bar: refusing it is not a reorder.
  assert.deepEqual(resolveTabBarDropPoint({ ...base, hoveredWorkspaceId: 'ws-1', x: 100, y: 80 }), { targetId: null, overList: false });
  // Left of the tab bar at the same height, off every workspace.
  assert.deepEqual(resolveTabBarDropPoint({ ...base, hoveredWorkspaceId: null, x: 100, y: 80 }), { targetId: null, overList: false });
  assert.deepEqual(resolveTabBarDropPoint({ ...base, tabBarRect: undefined, hoveredWorkspaceId: null, x: 500, y: 80 }), { targetId: null, overList: false });
});

test('FR-ARCH-019 AC-1: the dropped tab is the one picked up, not whatever now sits at its index', () => {
  const tabBar = read('../../src/components/Workspace/WorkspaceTabBar.tsx');
  assert.match(tabBar, /resolveTabBarDropPoint\(\{/u);
  assert.match(tabBar, /const tabId = tabDragStore\.getState\(\)\.tabId;\n\s*if \(tabId !== null\) onMoveTabToWorkspace\(tabId, workspaceId\);/u);
});

test('FR-ARCH-019 AC-1: a failed drag move opens the move dialog with the error, like the dialog move', () => {
  const app = read('../../src/App.tsx');
  const handler = app.slice(app.indexOf('const handleDropTabOnWorkspace'), app.indexOf('const handleSelectTab'));
  assert.doesNotMatch(handler, /catch\(\(\) => undefined\)/u);
  assert.match(handler, /setPendingWorkspaceMove\(\{ sourceWorkspaceId: tab\.workspaceId, tabId \}\);/u);
  assert.match(handler, /setWorkspaceMoveError\(error instanceof Error \? error\.message : String\(error\)\);/u);
});

function workspace(id: string, sortOrder: number): Workspace {
  return { id, name: id, sortOrder, viewMode: 'tab', activeTabId: null, colorCounter: 0, createdAt: '', updatedAt: '' };
}

function tab(id: string, workspaceId: string): WorkspaceTabRuntime {
  return {
    id, workspaceId, sessionId: `s-${id}`, name: id, colorIndex: 0, sortOrder: 0, shellType: 'bash',
    createdAt: '', status: 'idle', cwd: '',
  } as WorkspaceTabRuntime;
}
