import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyActiveTabId,
  planTabClose,
  removeTabFromList,
  restoreTabToList,
  runTabClose,
  type TabClosePlan,
} from '../../src/hooks/workspaceTabClose.ts';
import type { Workspace, WorkspaceTabRuntime } from '../../src/types/workspace.ts';

const hookSource = readFileSync(new URL('../../src/hooks/useWorkspaceManager.ts', import.meta.url), 'utf8');

function tab(id: string, workspaceId: string, sortOrder: number): WorkspaceTabRuntime {
  return {
    id,
    workspaceId,
    sessionId: `session-${id}`,
    name: id,
    colorIndex: 0,
    sortOrder,
    shellType: 'auto',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    status: 'idle',
    cwd: '',
  } as WorkspaceTabRuntime;
}

function workspace(id: string, activeTabId: string | null): Workspace {
  return {
    id,
    name: id,
    sortOrder: 0,
    viewMode: 'tab',
    activeTabId,
    colorCounter: 0,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  };
}

function plan(overrides: Partial<TabClosePlan> = {}): TabClosePlan {
  return {
    workspaceId: 'ws-1',
    tabId: 'tab-2',
    tab: tab('tab-2', 'ws-1', 1),
    tabIndex: 1,
    nextActiveTabId: 'tab-3',
    previousActiveTabId: 'tab-2',
    ...overrides,
  };
}

// --- PERF-BGSTAB-012 AC-1 ------------------------------------------------

test('PERF-BGSTAB-012 AC-1 runTabClose removes the tab before the delete request settles', async () => {
  const calls: string[] = [];
  let releaseDelete: (() => void) | null = null;
  const deletePending = new Promise<void>(resolve => { releaseDelete = resolve; });

  const closing = runTabClose(plan(), {
    applyLocalClose: () => { calls.push('applyLocalClose'); },
    requestDelete: async () => { calls.push('requestDelete'); await deletePending; },
    revertLocalClose: () => { calls.push('revertLocalClose'); },
    reportError: () => { calls.push('reportError'); },
  });

  // Let the microtask queue drain; the delete is still outstanding.
  await Promise.resolve();
  await Promise.resolve();

  // The cheapest way to satisfy "removes the tab" would be to remove it after
  // the await, so prove the delete really has not settled yet.
  const pendingMarker = Symbol('pending');
  assert.equal(
    await Promise.race([closing.then(() => 'settled'), Promise.resolve(pendingMarker)]),
    pendingMarker,
    'close should still be waiting on the server when the tab is already gone',
  );
  assert.deepEqual(calls, ['applyLocalClose', 'requestDelete']);

  releaseDelete!();
  await closing;
  assert.deepEqual(calls, ['applyLocalClose', 'requestDelete']);
});

test('PERF-BGSTAB-012 AC-1 planTabClose activates the right adjacent tab, then the left one', () => {
  const tabs = [tab('tab-1', 'ws-1', 0), tab('tab-2', 'ws-1', 1), tab('tab-3', 'ws-1', 2)];
  assert.equal(planTabClose(tabs, [workspace('ws-1', 'tab-2')], 'ws-1', 'tab-2').nextActiveTabId, 'tab-3');
  assert.equal(planTabClose(tabs, [workspace('ws-1', 'tab-3')], 'ws-1', 'tab-3').nextActiveTabId, 'tab-2');
  assert.equal(
    planTabClose([tab('tab-1', 'ws-1', 0)], [workspace('ws-1', 'tab-1')], 'ws-1', 'tab-1').nextActiveTabId,
    null,
  );
});

test('PERF-BGSTAB-012 AC-1 planTabClose leaves the active tab alone when another tab closes', () => {
  const tabs = [tab('tab-1', 'ws-1', 0), tab('tab-2', 'ws-1', 1)];
  const result = planTabClose(tabs, [workspace('ws-1', 'tab-1')], 'ws-1', 'tab-2');
  assert.equal(result.nextActiveTabId, 'tab-1');
  assert.equal(result.previousActiveTabId, 'tab-1');
  assert.equal(result.tabIndex, 1);
  assert.equal(result.tab?.id, 'tab-2');
});

test('PERF-BGSTAB-012 AC-1 useWorkspaceManager.closeTab does not await the delete before removing the tab', () => {
  const start = hookSource.indexOf('const closeTab = useCallback');
  assert.notEqual(start, -1, 'closeTab must still exist in useWorkspaceManager');
  const end = hookSource.indexOf('const updateTab = useCallback', start);
  assert.notEqual(end, -1);
  const closeTabChunk = hookSource.slice(start, end);

  assert.match(closeTabChunk, /runTabClose\(/);
  assert.doesNotMatch(
    closeTabChunk,
    /await\s+workspaceApi\.deleteTab/,
    'awaiting deleteTab inline puts server process-tree termination latency on screen',
  );
});

// --- PERF-BGSTAB-012 AC-2 ------------------------------------------------

test('PERF-BGSTAB-012 AC-2 runTabClose restores the tab and reports when the delete is rejected', async () => {
  const calls: string[] = [];
  const failure = new Error('tab not found');
  let reported: unknown = null;

  await runTabClose(plan(), {
    applyLocalClose: () => { calls.push('applyLocalClose'); },
    requestDelete: async () => { throw failure; },
    revertLocalClose: () => { calls.push('revertLocalClose'); },
    reportError: (error) => { calls.push('reportError'); reported = error; },
  });

  assert.deepEqual(calls, ['applyLocalClose', 'revertLocalClose', 'reportError']);
  assert.equal(reported, failure);
});

test('PERF-BGSTAB-012 AC-2 runTabClose does not restore the tab when the delete succeeds', async () => {
  // Control for the test above: an unconditional revert would satisfy it too.
  const calls: string[] = [];
  await runTabClose(plan(), {
    applyLocalClose: () => { calls.push('applyLocalClose'); },
    requestDelete: async () => { calls.push('requestDelete'); },
    revertLocalClose: () => { calls.push('revertLocalClose'); },
    reportError: () => { calls.push('reportError'); },
  });
  assert.deepEqual(calls, ['applyLocalClose', 'requestDelete']);
});

test('PERF-BGSTAB-012 AC-2 restoreTabToList puts the tab back at its original index', () => {
  const tabs = [tab('tab-1', 'ws-1', 0), tab('tab-2', 'ws-1', 1), tab('tab-3', 'ws-2', 0)];
  const removed = removeTabFromList(tabs, 'tab-2');
  assert.deepEqual(removed.map(t => t.id), ['tab-1', 'tab-3']);

  const restored = restoreTabToList(removed, tabs[1], 1);
  assert.deepEqual(restored.map(t => t.id), ['tab-1', 'tab-2', 'tab-3']);
});

test('PERF-BGSTAB-012 AC-2 restoreTabToList is a no-op when the tab is already back', () => {
  const tabs = [tab('tab-1', 'ws-1', 0), tab('tab-2', 'ws-1', 1)];
  assert.deepEqual(restoreTabToList(tabs, tabs[1], 1).map(t => t.id), ['tab-1', 'tab-2']);
});

test('PERF-BGSTAB-012 AC-2 applyActiveTabId only touches the named workspace', () => {
  const workspaces = [workspace('ws-1', 'tab-2'), workspace('ws-2', 'tab-9')];
  const next = applyActiveTabId(workspaces, 'ws-1', 'tab-3');
  assert.equal(next[0].activeTabId, 'tab-3');
  assert.equal(next[1].activeTabId, 'tab-9');
});
