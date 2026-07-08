import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveActiveWorkspaceAfterRemoval } from '../../src/hooks/workspaceActiveSelection.ts';
import {
  applyMoveTabResultToTabs,
  applyTabReorderResultToTabs,
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
