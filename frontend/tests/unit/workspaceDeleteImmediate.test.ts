import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  restoreRemovedGridLayouts,
  restoreRemovedTabs,
  restoreRemovedWorkspace,
  snapshotWorkspaceRemoval,
} from '../../src/hooks/workspaceRemoval.ts';
import type { GridLayout, Workspace, WorkspaceTabRuntime } from '../../src/types/workspace.ts';

// PERF-BGSTAB-015 AC-2/AC-3 — a confirmed workspace leaves the screen before the
// server has closed its terminals, and comes back if the server refuses.

function workspace(id: string, sortOrder: number): Workspace {
  return {
    id, name: id, sortOrder, viewMode: 'grid', activeTabId: null, colorCounter: 0,
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  };
}

function tab(id: string, workspaceId: string): WorkspaceTabRuntime {
  return { id, workspaceId, sessionId: `s-${id}`, name: id, sortOrder: 0, status: 'running', cwd: 'C:/w' } as WorkspaceTabRuntime;
}

const workspaces = [workspace('ws-1', 0), workspace('ws-2', 1), workspace('ws-3', 2)];
const tabs = [tab('t-1', 'ws-1'), tab('t-2', 'ws-2'), tab('t-3', 'ws-2'), tab('t-4', 'ws-3')];
const layouts: GridLayout[] = [
  { workspaceId: 'ws-2', mosaicTree: { direction: 'row', first: 't-2', second: 't-3' } as GridLayout['mosaicTree'] },
  { workspaceId: 'ws-3', mosaicTree: 't-4' },
];

test('PERF-BGSTAB-015 AC-3: the snapshot keeps what the removal takes off the screen', () => {
  const removal = snapshotWorkspaceRemoval(workspaces, tabs, layouts, 'ws-2', 'ws-2');
  assert.equal(removal.workspaceId, 'ws-2');
  assert.equal(removal.workspace?.id, 'ws-2');
  assert.deepEqual(removal.tabs.map(t => t.id), ['t-2', 't-3']);
  assert.deepEqual(removal.gridLayouts.map(g => g.workspaceId), ['ws-2']);
  assert.equal(removal.wasActive, true);
  assert.equal(snapshotWorkspaceRemoval(workspaces, tabs, layouts, 'ws-2', 'ws-1').wasActive, false);
});

test('PERF-BGSTAB-015 AC-3: a refused delete puts the workspace back in its place, with its tabs and layout', () => {
  const removal = snapshotWorkspaceRemoval(workspaces, tabs, layouts, 'ws-2', 'ws-2');
  const shownWorkspaces = workspaces.filter(w => w.id !== 'ws-2');
  const shownTabs = tabs.filter(t => t.workspaceId !== 'ws-2');
  const shownLayouts = layouts.filter(g => g.workspaceId !== 'ws-2');

  assert.deepEqual(restoreRemovedWorkspace(shownWorkspaces, removal).map(w => w.id), ['ws-1', 'ws-2', 'ws-3']);
  assert.deepEqual(restoreRemovedTabs(shownTabs, removal).map(t => t.id).sort(), ['t-1', 't-2', 't-3', 't-4']);
  const restoredTab = restoreRemovedTabs(shownTabs, removal).find(t => t.id === 't-2');
  assert.equal(restoredTab?.status, 'running', 'the runtime state of a restored tab is kept');
  assert.deepEqual(restoreRemovedGridLayouts(shownLayouts, removal).map(g => g.workspaceId).sort(), ['ws-2', 'ws-3']);
});

test('PERF-BGSTAB-015 AC-3: restoring twice does not duplicate anything', () => {
  const removal = snapshotWorkspaceRemoval(workspaces, tabs, layouts, 'ws-2', 'ws-2');
  assert.equal(restoreRemovedWorkspace(workspaces, removal).length, 3);
  assert.equal(restoreRemovedTabs(tabs, removal).length, 4);
  assert.equal(restoreRemovedGridLayouts(layouts, removal).length, 2);
});

test('PERF-BGSTAB-015 AC-2/AC-3: deleteWorkspace takes the workspace off the screen before it asks the server, and puts it back on failure', () => {
  const source = readFileSync(new URL('../../src/hooks/useWorkspaceManager.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const deleteWorkspace = useCallback');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('const reorderWorkspaces = useCallback', start));
  const apiAt = body.indexOf('await workspaceApi.delete(id)');
  assert.notEqual(apiAt, -1);
  for (const removal of ['setWorkspaces(', 'setTabs(', 'setGridLayouts(']) {
    const at = body.indexOf(removal);
    assert.ok(at !== -1 && at < apiAt, `${removal} runs before the server is asked`);
  }
  const catchBody = body.slice(body.indexOf('catch', apiAt));
  assert.match(catchBody, /restoreRemovedWorkspace\(/);
  assert.match(catchBody, /restoreRemovedTabs\(/);
  assert.match(catchBody, /restoreRemovedGridLayouts\(/);
  assert.match(catchBody, /wasActive[\s\S]*setActiveWorkspaceIdAndPersist\(id\)/);
  assert.match(catchBody, /setError\(/);
  // Local layout and snapshots are only thrown away once the server agreed.
  const okBody = body.slice(apiAt, body.indexOf('catch', apiAt));
  assert.match(okBody, /clearMosaicLayoutForWorkspace\(id\)/);
  assert.match(okBody, /clearWorkspaceSnapshots\(/);
});

test('PERF-BGSTAB-015 AC-2: confirming the delete closes the dialog without waiting for the server', () => {
  const source = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const handleConfirmDeleteWorkspace = useCallback');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('}, [pendingDeleteWorkspace]);', start));
  const closeAt = body.indexOf('setPendingDeleteWorkspace(null)');
  const deleteAt = body.indexOf('deleteWorkspace(');
  assert.ok(closeAt !== -1 && deleteAt !== -1 && closeAt < deleteAt, 'the dialog closes before the delete starts');
  assert.doesNotMatch(body, /await\s+wmRef\.current\.deleteWorkspace/, 'the dialog does not wait for the delete');
});
