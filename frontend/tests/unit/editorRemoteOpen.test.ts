// FR-MCP-012 AC-7: the browser side of the MCP editor tools.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEditorOpenRequest, planEditorRemoteOpen } from '../../src/components/editor/editorRemoteOpen.ts';

const tabs = [
  { id: 'tab-1', workspaceId: 'ws-1' },
  { id: 'tab-2', workspaceId: 'ws-2' },
];
const request = { workspaceId: 'ws-2', terminalId: 'tab-2', filePath: 'C:\\w\\a.md', kind: 'markdown' as const };

test('FR-MCP-012 AC-7: the payload is parsed and anything else is refused', () => {
  assert.deepEqual(parseEditorOpenRequest({ ...request, extra: 1 }), request);
  for (const bad of [null, 'x', {}, { ...request, kind: 'binary' }, { ...request, filePath: '' }, { ...request, terminalId: 3 }]) {
    assert.equal(parseEditorOpenRequest(bad), null, JSON.stringify(bad));
  }
});

test('FR-MCP-012 AC-7: the active workspace opens the file in the given terminal', () => {
  assert.deepEqual(planEditorRemoteOpen(request, { activeWorkspaceId: 'ws-2', tabs }), { action: 'open', filePath: 'C:\\w\\a.md', tabId: 'tab-2' });
});

test('FR-MCP-012 AC-7: another workspace is switched to first', () => {
  assert.deepEqual(planEditorRemoteOpen(request, { activeWorkspaceId: 'ws-1', tabs }), { action: 'switch', workspaceId: 'ws-2' });
  assert.deepEqual(planEditorRemoteOpen(request, { activeWorkspaceId: null, tabs }), { action: 'switch', workspaceId: 'ws-2' });
});

test('FR-MCP-012 AC-7: an unknown terminal or one in another workspace is ignored', () => {
  assert.deepEqual(planEditorRemoteOpen({ ...request, terminalId: 'tab-9' }, { activeWorkspaceId: 'ws-2', tabs }), { action: 'ignore' });
  assert.deepEqual(planEditorRemoteOpen({ ...request, workspaceId: 'ws-1' }, { activeWorkspaceId: 'ws-1', tabs }), { action: 'ignore' });
});
