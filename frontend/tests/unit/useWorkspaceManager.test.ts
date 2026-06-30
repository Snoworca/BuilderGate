import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveActiveWorkspaceAfterRemoval } from '../../src/hooks/workspaceActiveSelection.ts';

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
