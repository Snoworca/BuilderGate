// FR-MCP-007 / FR-MCP-008: the WorkspaceService-backed control behind the MCP management tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceServiceMcpControl, type WorkspaceServiceMcpControlDeps } from './McpWorkspaceControl.js';
import type { McpTerminalView } from './McpManagementTools.js';

type Rec = Record<string, unknown>;

function setup() {
  const events: Array<[string, object]> = [];
  const deliveries: Rec[] = [];
  const writes: Array<[string, string]> = [];
  const workspace = { id: 'ws-1', name: 'Main', sortOrder: 0, activeTabId: null, viewMode: 'tab', colorCounter: 0, createdAt: '', updatedAt: '' };
  const tab = { id: 'tab-1', workspaceId: 'ws-1', sessionId: 's-1', sessionKey: 'k-1', name: 'build', sortOrder: 0, shellType: 'bash', lifecycleState: 'active' };
  const deps = {
    workspaceService: {
      getState: () => ({ workspaces: [workspace], tabs: [tab], gridLayouts: [] }),
      createWorkspace: async (name?: string) => ({ ...workspace, id: 'ws-2', name: name ?? 'W' }),
      updateWorkspace: async (_id: string, updates: { name?: string }) => ({ ...workspace, name: updates.name ?? workspace.name }),
      deleteWorkspace: async () => undefined,
      addTab: async (workspaceId: string, shell?: string, name?: string) => ({ ...tab, id: 'tab-2', workspaceId, shellType: shell, name: name ?? 'T' }),
      deleteTab: async () => undefined,
    },
    sessionManager: {
      getLastCwd: () => '/work',
      writeInput: (sessionId: string, data: string) => { writes.push([sessionId, data]); return true; },
      readTerminalText: () => 'text',
    },
    broadcast: (event: string, data: object) => { events.push([event, data]); },
    deliver: async (delivery: Rec) => { deliveries.push(delivery); return { ok: true, status: 'delivered' }; },
  } as unknown as WorkspaceServiceMcpControlDeps;
  return { control: createWorkspaceServiceMcpControl(deps), events, deliveries, writes };
}

const terminal = (sessionKey: string | null): McpTerminalView => ({
  id: 'tab-1', workspaceId: 'ws-1', sessionId: 's-1', sessionKey, name: 'build', shellType: 'bash', lifecycleState: 'active', cwd: null,
});

test('FR-MCP-008 AC-4: exec submits the command with Enter through the gateway', async () => {
  const { control, deliveries } = setup();
  const actor = { type: 'mcp-fixed-access-key', scopes: ['mcp:message.submit'] };
  await control.execTerminal(terminal('k-1'), 'echo hi', actor);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].prompt, 'echo hi\r', 'the gateway does not add the Enter itself');
  assert.equal(deliveries[0].deliveryMode, 'submit');
  assert.equal(deliveries[0].sessionKey, 'k-1');
  assert.deepEqual(deliveries[0].actor, actor);
});

test('FR-MCP-008 AC-4: a terminal without a session key is written directly, with Enter', async () => {
  const { control, deliveries, writes } = setup();
  await control.execTerminal(terminal(null), 'ls', {});
  assert.deepEqual(writes, [['s-1', 'ls\r']]);
  assert.equal(deliveries.length, 0);
});

test('FR-MCP-007 AC-2 / FR-MCP-008 AC-2,AC-3: changes broadcast the REST route events', async () => {
  const { control, events } = setup();
  await control.createWorkspace('Lab');
  await control.renameWorkspace('ws-1', 'Renamed');
  await control.deleteWorkspace('ws-1');
  await control.createTerminal('ws-1', { name: 'api', shell: 'bash' });
  await control.deleteTerminal('ws-1', 'tab-1');
  assert.deepEqual(events.map(([event]) => event), [
    'workspace:created', 'workspace:updated', 'workspace:deleting', 'workspace:deleted', 'tab:added', 'tab:removed',
  ]);
  assert.deepEqual(events[1][1], { id: 'ws-1', changes: { name: 'Renamed' } });
  assert.deepEqual(events[5][1], { id: 'tab-1', workspaceId: 'ws-1' });
});

test('FR-MCP-008 AC-1: terminals carry the live cwd', () => {
  const { control } = setup();
  assert.deepEqual(control.listTerminals()[0], {
    id: 'tab-1', workspaceId: 'ws-1', sessionId: 's-1', sessionKey: 'k-1', name: 'build', shellType: 'bash', lifecycleState: 'active', cwd: '/work',
  });
});
