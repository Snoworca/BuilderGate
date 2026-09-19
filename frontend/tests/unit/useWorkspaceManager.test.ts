import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveActiveWorkspaceAfterRemoval } from '../../src/hooks/workspaceActiveSelection.ts';
import {
  applyMoveTabResultToTabs,
  applyTabReorderResultToTabs,
  mergeFetchedTabsIntoRuntime,
  shouldAdoptRemoteTabAsActive,
} from '../../src/hooks/workspaceTabState.ts';
import type { MoveTabResult, WorkspaceTabRuntime } from '../../src/types/workspace.ts';

const source = readFileSync(new URL('../../src/hooks/useWorkspaceManager.ts', import.meta.url), 'utf8');

test('resolveActiveWorkspaceAfterRemoval selects the first remaining workspace when active workspace is removed', () => {
  assert.equal(
    resolveActiveWorkspaceAfterRemoval('ws-1', 'ws-1', [{ id: 'ws-2' }, { id: 'ws-3' }]),
    'ws-2',
  );
});

test('resolveActiveWorkspaceAfterRemoval clears persisted active workspace when the last workspace is removed', () => {
  assert.equal(resolveActiveWorkspaceAfterRemoval('ws-1', 'ws-1', []), null);
});

test('resolveActiveWorkspaceAfterRemoval leaves active workspace unchanged when another workspace is removed', () => {
  assert.equal(resolveActiveWorkspaceAfterRemoval('ws-2', 'ws-1', [{ id: 'ws-2' }]), undefined);
});

test('useWorkspaceManager updates persisted active workspace from websocket and direct delete paths', () => {
  const wsDeletedIndex = source.indexOf("'workspace:deleted': (data) => {");
  assert.notEqual(wsDeletedIndex, -1);
  const wsDeletedChunk = source.slice(wsDeletedIndex, wsDeletedIndex + 700);
  assert.match(wsDeletedChunk, /resolveActiveWorkspaceAfterRemoval/);
  assert.match(wsDeletedChunk, /setActiveWorkspaceIdAndPersist\(nextActiveWorkspaceId\)/);

  const directDeletedIndex = source.indexOf('const deleteWorkspace = useCallback');
  assert.notEqual(directDeletedIndex, -1);
  const directDeletedChunk = source.slice(directDeletedIndex, directDeletedIndex + 900);
  assert.match(directDeletedChunk, /resolveActiveWorkspaceAfterRemoval/);
  assert.match(directDeletedChunk, /setActiveWorkspaceIdAndPersist\(nextActiveWorkspaceId\)/);
});

test('useWorkspaceManager exposes moveTab and handles tab:moved websocket payloads', () => {
  assert.match(source, /moveTab:\s*\(sourceWorkspaceId:\s*string,\s*tabId:\s*string,\s*targetWorkspaceId:\s*string\)\s*=>\s*Promise<void>/);
  assert.match(source, /'tab:moved':\s*\(data\)\s*=>\s*\{/);
  assert.match(source, /workspaceApi\.moveTab\(sourceWorkspaceId,\s*tabId,\s*targetWorkspaceId\)/);
  assert.match(source, /setActiveWorkspaceIdAndPersist\(targetWorkspaceId\)/);
  assert.match(source, /pruneMosaicLayoutForMovedTab\(sourceWorkspaceId,\s*tabId\)/);
});

test('workspace tab state applies valid move payloads and preserves runtime fields', () => {
  const tabs = [
    tab('tab-1', 'ws-1', 0, 'running', 'C:/a'),
    tab('tab-2', 'ws-1', 1, 'idle', 'C:/b'),
    tab('tab-3', 'ws-2', 0, 'idle', 'C:/c'),
  ];
  const result: MoveTabResult = {
    tab: { ...tabs[0], workspaceId: 'ws-2', sortOrder: 1 },
    sourceWorkspaceId: 'ws-1',
    targetWorkspaceId: 'ws-2',
    sourceActiveTabId: 'tab-2',
    targetActiveTabId: 'tab-1',
    sourceTabIds: ['tab-2'],
    targetTabIds: ['tab-3', 'tab-1'],
  };

  const next = applyMoveTabResultToTabs(tabs, result);

  assert.deepEqual(
    next
      .filter(item => item.workspaceId === 'ws-2')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(item => `${item.id}:${item.status}:${item.cwd}`),
    ['tab-3:idle:C:/c', 'tab-1:running:C:/a'],
  );
});

test('workspace tab state ignores stale or duplicate move and reorder payloads', () => {
  const tabs = [
    tab('tab-1', 'ws-1', 0),
    tab('tab-2', 'ws-1', 1),
    tab('tab-3', 'ws-2', 0),
  ];
  const staleMove: MoveTabResult = {
    tab: { ...tabs[0], workspaceId: 'ws-2', sortOrder: 1 },
    sourceWorkspaceId: 'ws-1',
    targetWorkspaceId: 'ws-2',
    sourceActiveTabId: 'tab-2',
    targetActiveTabId: 'tab-1',
    sourceTabIds: ['tab-2'],
    targetTabIds: ['tab-1'],
  };

  assert.equal(applyMoveTabResultToTabs(tabs, staleMove), tabs);
  assert.equal(applyTabReorderResultToTabs(tabs, 'ws-1', ['tab-1']), tabs);
  assert.equal(applyTabReorderResultToTabs(tabs, 'ws-1', ['tab-2', 'tab-2']), tabs);
});

test('workspace tab state ignores move payloads with invalid active tab ids', () => {
  const tabs = [
    tab('tab-1', 'ws-1', 0),
    tab('tab-2', 'ws-1', 1),
    tab('tab-3', 'ws-2', 0),
  ];
  const baseMove: MoveTabResult = {
    tab: { ...tabs[0], workspaceId: 'ws-2', sortOrder: 1 },
    sourceWorkspaceId: 'ws-1',
    targetWorkspaceId: 'ws-2',
    sourceActiveTabId: 'tab-2',
    targetActiveTabId: 'tab-1',
    sourceTabIds: ['tab-2'],
    targetTabIds: ['tab-3', 'tab-1'],
  };

  assert.equal(
    applyMoveTabResultToTabs(tabs, { ...baseMove, sourceActiveTabId: 'tab-3' }),
    tabs,
  );
  assert.equal(
    applyMoveTabResultToTabs(tabs, { ...baseMove, targetActiveTabId: 'tab-2' }),
    tabs,
  );
});

function tab(
  id: string,
  workspaceId: string,
  sortOrder: number,
  status: WorkspaceTabRuntime['status'] = 'idle',
  cwd = '',
): WorkspaceTabRuntime {
  return {
    id,
    workspaceId,
    sessionId: `session-${id}`,
    name: id,
    colorIndex: 0,
    sortOrder,
    shellType: 'bash',
    createdAt: '2026-07-08T00:00:00.000Z',
    status,
    cwd,
  };
}

// Issue #108: a tab created out of band -- by another client, by the API, by an agent -- arrives
// over `tab:added`. The local creation path sets the workspace's activeTabId; this one did not,
// so the tab appeared in the tab bar while the workspace had nothing active and no terminal was
// mounted for it. Measured: twelve seconds with every `.terminal-view` at 0x0, a tab button
// drawn and a live session behind it. Selecting the tab mounted it on the next sample.
test('#108 a remote tab is adopted as active only when the workspace has nothing active to lose', () => {
  // Nothing active: adopt.
  assert.equal(shouldAdoptRemoteTabAsActive({ activeTabId: null }, [{ id: 't1' }]), true);
  assert.equal(shouldAdoptRemoteTabAsActive({}, [{ id: 't1' }]), true);

  // An active tab that no longer exists is not something to lose either.
  assert.equal(shouldAdoptRemoteTabAsActive({ activeTabId: 'gone' }, [{ id: 't1' }]), true);

  // The control, and the reason adoption is narrow: taking over while the user is working in
  // another tab of that workspace would be worse than the defect.
  assert.equal(shouldAdoptRemoteTabAsActive({ activeTabId: 't1' }, [{ id: 't1' }, { id: 't2' }]), false);

  // No workspace, no decision.
  assert.equal(shouldAdoptRemoteTabAsActive(undefined, [{ id: 't1' }]), false);
});

test('#108 the tab:added handler adopts through that helper rather than deciding inline', () => {
  const handlerIndex = source.indexOf("'tab:added': (data) => {");
  assert.notEqual(handlerIndex, -1);
  const handler = source.slice(handlerIndex, handlerIndex + 900);
  assert.match(handler, /shouldAdoptRemoteTabAsActive/u);
  assert.match(handler, /activeTabId: tab\.id/u);
  // The filter matters: the decision is about the tabs of the workspace that gained one, not
  // about every tab the client knows.
  assert.match(handler, /candidate\.workspaceId === tab\.workspaceId/u);
});

test('#108 a resync keeps runtime fields for tabs that survive and takes membership from the server', () => {
  const fetched = [
    { id: 't1', lastCwd: '/persisted' },
    { id: 't3', lastCwd: '/new' },
  ];
  const current = [
    { id: 't1', status: 'running' as const, cwd: '/live' },
    { id: 't2', status: 'idle' as const, cwd: '/gone' },
  ];

  const merged = mergeFetchedTabsIntoRuntime(fetched, current);

  assert.deepEqual(merged.map(tab => tab.id), ['t1', 't3'], 'membership comes from the server');
  // The live cwd outlives the reconnect. Replacing it with the persisted one would blank a
  // running terminal's header on every reconnect.
  assert.equal(merged[0].cwd, '/live');
  assert.equal(merged[0].status, 'running');
  // A tab the client has never seen starts idle and falls back to the persisted cwd.
  assert.equal(merged[1].cwd, '/new');
  assert.equal(merged[1].status, 'idle');
});

test('#108 the hook refetches on every transition into connected, including the first', () => {
  const index = source.indexOf("if (wsStatus !== 'connected') return;");
  assert.notEqual(index, -1, 'the resync on connect is gone');
  const chunk = source.slice(index, index + 700);
  assert.match(chunk, /workspaceApi\.getAll\(\)/u);
  assert.match(chunk, /mergeFetchedTabsIntoRuntime/u);
  // The first connect must NOT be skipped. The dangerous window is exactly there: the initial
  // load and the socket open are concurrent, so anything created in between is published to a
  // socket that is not listening yet. A guard that skipped the first connect would leave open
  // the very window the measurement fell into.
  assert.doesNotMatch(chunk, /hasConnected|firstConnect|skipFirst/u);
});
