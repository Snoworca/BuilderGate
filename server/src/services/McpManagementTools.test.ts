// FR-MCP-007, FR-MCP-008, SEC-MCP-004: MCP workspace and terminal management tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService, BUILDERGATE_MCP_TOOL_NAMES } from './McpToolService.js';
import { getDefaultMcpSessionScopes, getFixedMcpAccessKeyScopes } from './McpSecurityContract.js';
import type { McpTerminalView, McpWorkspaceControl, McpWorkspaceView } from './McpManagementTools.js';

type Rec = Record<string, unknown>;

const ALL_SCOPES = getFixedMcpAccessKeyScopes();

function createFakeControl() {
  const workspaces: McpWorkspaceView[] = [
    { id: 'ws-1', name: 'Main', sortOrder: 0, activeTabId: 'tab-1' },
    { id: 'ws-2', name: 'Docs', sortOrder: 1, activeTabId: null },
    { id: 'ws-3', name: 'Dup', sortOrder: 2, activeTabId: null },
    { id: 'ws-4', name: 'Dup', sortOrder: 3, activeTabId: null },
  ];
  const terminals: McpTerminalView[] = [
    { id: 'tab-1', workspaceId: 'ws-1', sessionId: 's-1', sessionKey: 'k-1', name: 'build', shellType: 'bash', lifecycleState: 'active', cwd: '/w' },
    { id: 'tab-2', workspaceId: 'ws-1', sessionId: 's-2', sessionKey: 'k-2', name: 'shell', shellType: 'bash', lifecycleState: 'active', cwd: '/w' },
    { id: 'tab-3', workspaceId: 'ws-1', sessionId: 's-3', sessionKey: 'k-3', name: 'shell', shellType: 'bash', lifecycleState: 'active', cwd: '/w' },
  ];
  const calls: Rec[] = [];
  const control: McpWorkspaceControl = {
    listWorkspaces: () => workspaces.map(w => ({ ...w })),
    listTerminals: () => terminals.map(t => ({ ...t })),
    createWorkspace: async (name) => {
      calls.push({ op: 'createWorkspace', name });
      const ws = { id: 'ws-new', name: name ?? 'Workspace-5', sortOrder: 4, activeTabId: null };
      workspaces.push(ws);
      return ws;
    },
    renameWorkspace: async (id, name) => {
      calls.push({ op: 'renameWorkspace', id, name });
      const ws = workspaces.find(w => w.id === id)!;
      ws.name = name;
      return { ...ws };
    },
    deleteWorkspace: async (id) => {
      calls.push({ op: 'deleteWorkspace', id });
    },
    createTerminal: async (workspaceId, options) => {
      calls.push({ op: 'createTerminal', workspaceId, ...options });
      return { id: 'tab-new', workspaceId, sessionId: 's-new', sessionKey: 'k-new', name: options.name ?? 'Terminal-4', shellType: options.shell ?? 'auto', lifecycleState: 'active', cwd: options.cwd ?? null };
    },
    deleteTerminal: async (workspaceId, terminalId) => {
      calls.push({ op: 'deleteTerminal', workspaceId, terminalId });
    },
    execTerminal: async (terminal, command) => {
      calls.push({ op: 'execTerminal', terminalId: terminal.id, command });
      return { ok: true, status: 'delivered' };
    },
    readTerminalText: (sessionId, maxLines) => {
      calls.push({ op: 'readTerminalText', sessionId, maxLines });
      return ['$ ls', 'a.txt', 'b.txt', '$'].slice(-maxLines).join('\n');
    },
  };
  return { control, calls };
}

function setup(scopes: string[] = ALL_SCOPES) {
  const fake = createFakeControl();
  const sleeps: number[] = [];
  const service = createMcpToolService({
    workspaceControl: fake.control,
    sleep: async (ms: number) => { sleeps.push(ms); },
  }) as { callTool: (request: unknown) => Promise<Rec>; listTools: () => Rec };
  const call = (name: string, args: Rec = {}) => service.callTool({
    name,
    arguments: args,
    actor: { type: 'mcp-fixed-access-key', scopes },
  });
  return { ...fake, service, call, sleeps };
}

test('FR-MCP-007/008: tools/list advertises the management tools with schemas', () => {
  const { service } = setup();
  const names = (service.listTools().tools as Rec[]).map(tool => tool.name);
  for (const name of [
    'buildergate.workspace.list', 'buildergate.workspace.create', 'buildergate.workspace.rename', 'buildergate.workspace.delete',
    'buildergate.terminal.list', 'buildergate.terminal.create', 'buildergate.terminal.delete', 'buildergate.terminal.exec',
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
    assert.ok((BUILDERGATE_MCP_TOOL_NAMES as readonly string[]).includes(name));
  }
  for (const tool of service.listTools().tools as Rec[]) {
    assert.equal((tool.inputSchema as Rec)?.type, 'object', `${String(tool.name)} has an input schema`);
  }
});

test('FR-MCP-007 AC-1: workspace.list returns every workspace in sort order with counts', async () => {
  const { call } = setup();
  const result = await call('buildergate.workspace.list');
  assert.equal(result.ok, true);
  const list = result.workspaces as Rec[];
  assert.deepEqual(list.map(w => w.workspaceId), ['ws-1', 'ws-2', 'ws-3', 'ws-4']);
  assert.deepEqual(list[0], { workspaceId: 'ws-1', name: 'Main', sortOrder: 0, terminalCount: 3, activeTerminalId: 'tab-1' });
});

test('FR-MCP-007 AC-2: workspace.create creates and returns the workspace', async () => {
  const { call, calls } = setup();
  const result = await call('buildergate.workspace.create', { name: 'Lab' });
  assert.equal(result.ok, true);
  assert.equal((result.workspace as Rec).workspaceId, 'ws-new');
  assert.equal((result.workspace as Rec).name, 'Lab');
  assert.deepEqual(calls, [{ op: 'createWorkspace', name: 'Lab' }]);
});

test('FR-MCP-007 AC-3: rename addresses a workspace by id or by name', async () => {
  const byId = setup();
  const r1 = await byId.call('buildergate.workspace.rename', { workspaceId: 'ws-2', name: 'Notes' });
  assert.equal(r1.ok, true);
  assert.deepEqual(byId.calls, [{ op: 'renameWorkspace', id: 'ws-2', name: 'Notes' }]);

  const byName = setup();
  const r2 = await byName.call('buildergate.workspace.rename', { workspaceName: 'Docs', name: 'Notes' });
  assert.equal(r2.ok, true);
  assert.deepEqual(byName.calls, [{ op: 'renameWorkspace', id: 'ws-2', name: 'Notes' }]);
});

test('FR-MCP-007 AC-3: unknown, ambiguous and contradictory workspace addresses are rejected', async () => {
  const { call, calls } = setup();
  assert.equal((await call('buildergate.workspace.rename', { workspaceName: 'Nope', name: 'X' })).code, 'TARGET_NOT_FOUND');
  const ambiguous = await call('buildergate.workspace.rename', { workspaceName: 'Dup', name: 'X' });
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert.deepEqual((ambiguous.candidates as Rec[]).map(c => c.workspaceId), ['ws-3', 'ws-4']);
  assert.equal((await call('buildergate.workspace.rename', { workspaceId: 'ws-1', workspaceName: 'Docs', name: 'X' })).code, 'VALIDATION_ERROR');
  assert.equal((await call('buildergate.workspace.rename', { name: 'X' })).code, 'VALIDATION_ERROR');
  assert.deepEqual(calls, []);
});

test('FR-MCP-007 AC-4: workspace.delete requires confirm', async () => {
  const { call, calls } = setup();
  assert.equal((await call('buildergate.workspace.delete', { workspaceId: 'ws-2' })).code, 'VALIDATION_ERROR');
  assert.deepEqual(calls, []);
  const result = await call('buildergate.workspace.delete', { workspaceName: 'Docs', confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ op: 'deleteWorkspace', id: 'ws-2' }]);
});

test('FR-MCP-007 AC-4: a service error such as LAST_WORKSPACE surfaces as its code', async () => {
  const fake = createFakeControl();
  fake.control.deleteWorkspace = async () => {
    throw Object.assign(new Error('Cannot delete the last workspace'), { code: 'LAST_WORKSPACE' });
  };
  const service = createMcpToolService({ workspaceControl: fake.control }) as { callTool: (r: unknown) => Promise<Rec> };
  const result = await service.callTool({
    name: 'buildergate.workspace.delete',
    arguments: { workspaceId: 'ws-1', confirm: true },
    actor: { scopes: ALL_SCOPES },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAST_WORKSPACE');
});

test('FR-MCP-008 AC-1: terminal.list lists one workspace or all', async () => {
  const { call } = setup();
  const all = await call('buildergate.terminal.list');
  assert.equal((all.terminals as Rec[]).length, 3);
  const one = await call('buildergate.terminal.list', { workspaceName: 'Main' });
  assert.deepEqual((one.terminals as Rec[])[0], {
    terminalId: 'tab-1', sessionId: 's-1', sessionKey: 'k-1', name: 'build',
    workspaceId: 'ws-1', workspaceName: 'Main', shellType: 'bash', cwd: '/w', lifecycleState: 'active',
  });
  const empty = await call('buildergate.terminal.list', { workspaceId: 'ws-2' });
  assert.deepEqual(empty.terminals, []);
});

test('FR-MCP-008 AC-2: terminal.create adds a terminal to the named workspace', async () => {
  const { call, calls } = setup();
  assert.equal((await call('buildergate.terminal.create', { name: 'x' })).code, 'VALIDATION_ERROR');
  const result = await call('buildergate.terminal.create', { workspaceName: 'Docs', name: 'api', shell: 'bash', cwd: '/srv' });
  assert.equal(result.ok, true);
  assert.equal((result.terminal as Rec).terminalId, 'tab-new');
  assert.equal((result.terminal as Rec).workspaceName, 'Docs');
  assert.deepEqual(calls, [{ op: 'createTerminal', workspaceId: 'ws-2', name: 'api', shell: 'bash', cwd: '/srv' }]);
});

test('FR-MCP-008 AC-3: terminal addressed by id, or by name inside a workspace', async () => {
  const { call, calls } = setup();
  assert.equal((await call('buildergate.terminal.delete', { terminalId: 'tab-1' })).code, 'VALIDATION_ERROR', 'confirm required');
  assert.equal((await call('buildergate.terminal.delete', { terminalId: 'tab-1', confirm: true })).ok, true);
  assert.equal((await call('buildergate.terminal.delete', { workspaceName: 'Main', terminalName: 'build', confirm: true })).ok, true);
  assert.deepEqual(calls, [
    { op: 'deleteTerminal', workspaceId: 'ws-1', terminalId: 'tab-1' },
    { op: 'deleteTerminal', workspaceId: 'ws-1', terminalId: 'tab-1' },
  ]);
  const ambiguous = await call('buildergate.terminal.delete', { workspaceId: 'ws-1', terminalName: 'shell', confirm: true });
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert.deepEqual((ambiguous.candidates as Rec[]).map(c => c.terminalId), ['tab-2', 'tab-3']);
  assert.equal((await call('buildergate.terminal.delete', { terminalName: 'build', confirm: true })).code, 'VALIDATION_ERROR', 'a name needs a workspace');
  assert.equal((await call('buildergate.terminal.delete', { terminalId: 'nope', confirm: true })).code, 'TARGET_NOT_FOUND');
  assert.equal((await call('buildergate.terminal.delete', { workspaceId: 'ws-2', terminalId: 'tab-1', confirm: true })).code, 'TARGET_NOT_FOUND', 'id outside the given workspace');
});

test('FR-MCP-008 AC-4: terminal.exec submits the command and returns screen text after the wait', async () => {
  const { call, calls, sleeps } = setup();
  const result = await call('buildergate.terminal.exec', { workspaceName: 'Main', terminalName: 'build', command: 'ls', waitMs: 800, outputLines: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.terminalId, 'tab-1');
  assert.equal(result.output, 'a.txt\nb.txt\n$');
  assert.deepEqual(sleeps, [800]);
  assert.deepEqual(calls, [
    { op: 'execTerminal', terminalId: 'tab-1', command: 'ls' },
    { op: 'readTerminalText', sessionId: 's-1', maxLines: 3 },
  ]);
});

test('FR-MCP-008 AC-4: exec bounds, no-wait mode and empty command', async () => {
  const noWait = setup();
  const result = await noWait.call('buildergate.terminal.exec', { terminalId: 'tab-1', command: 'make' });
  assert.equal(result.ok, true);
  assert.equal(result.output, undefined, 'default waitMs 0 reads nothing');
  assert.deepEqual(noWait.sleeps, []);

  const bounded = setup();
  await bounded.call('buildergate.terminal.exec', { terminalId: 'tab-1', command: 'x', waitMs: 999_999, outputLines: 9_999 });
  assert.deepEqual(bounded.sleeps, [30_000]);
  assert.equal(bounded.calls.find(c => c.op === 'readTerminalText')?.maxLines, 200);

  const empty = setup();
  assert.equal((await empty.call('buildergate.terminal.exec', { terminalId: 'tab-1', command: '   ' })).code, 'VALIDATION_ERROR');
  assert.deepEqual(empty.calls, []);
});

test('FR-MCP-008 AC-4: a rejected delivery is returned without reading output', async () => {
  const fake = createFakeControl();
  fake.control.execTerminal = async () => ({ ok: false, code: 'INPUT_REJECTED_REPLAY_PENDING' });
  const service = createMcpToolService({ workspaceControl: fake.control, sleep: async () => undefined }) as { callTool: (r: unknown) => Promise<Rec> };
  const result = await service.callTool({
    name: 'buildergate.terminal.exec',
    arguments: { terminalId: 'tab-1', command: 'ls', waitMs: 100 },
    actor: { scopes: ALL_SCOPES },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INPUT_REJECTED_REPLAY_PENDING');
  assert.equal(fake.calls.some(c => c.op === 'readTerminalText'), false);
});

test('FR-MCP-007 AC-5 / FR-MCP-008 AC-5: each tool checks its own scope', async () => {
  const cases: Array<[string, Rec]> = [
    ['buildergate.workspace.list', {}],
    ['buildergate.workspace.create', {}],
    ['buildergate.workspace.rename', { workspaceId: 'ws-1', name: 'x' }],
    ['buildergate.workspace.delete', { workspaceId: 'ws-2', confirm: true }],
    ['buildergate.terminal.list', {}],
    ['buildergate.terminal.create', { workspaceId: 'ws-1' }],
    ['buildergate.terminal.delete', { terminalId: 'tab-1', confirm: true }],
    ['buildergate.terminal.exec', { terminalId: 'tab-1', command: 'ls' }],
  ];
  for (const [name, args] of cases) {
    const { call, calls } = setup(['mcp:sessions.list']);
    assert.equal((await call(name, args)).code, 'INVALID_SCOPE', name);
    assert.deepEqual(calls, [], `${name} had side effects`);
  }
  // Read scopes alone allow listing but not writing.
  const reader = setup(['mcp:workspaces.read', 'mcp:terminals.read']);
  assert.equal((await reader.call('buildergate.workspace.list')).ok, true);
  assert.equal((await reader.call('buildergate.terminal.list')).ok, true);
  assert.equal((await reader.call('buildergate.terminal.exec', { terminalId: 'tab-1', command: 'ls' })).code, 'INVALID_SCOPE');
});

test('FR-MCP-007/008: without a workspace control the tools report unavailable', async () => {
  const service = createMcpToolService({}) as { callTool: (r: unknown) => Promise<Rec> };
  const result = await service.callTool({ name: 'buildergate.workspace.list', arguments: {}, actor: { scopes: ALL_SCOPES } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_WORKSPACE_CONTROL_UNAVAILABLE');
});

test('SEC-MCP-004 AC-1: fixed access key carries the management scopes', () => {
  assert.deepEqual([...getFixedMcpAccessKeyScopes()].sort(), [
    'mcp:message.paste',
    'mcp:message.submit',
    'mcp:sessions.list',
    'mcp:sessions.search',
    'mcp:terminals.exec',
    'mcp:terminals.read',
    'mcp:terminals.write',
    'mcp:workspaces.read',
    'mcp:workspaces.write',
  ]);
});

test('SEC-MCP-004 AC-2: session actors get read-only management scopes', () => {
  const scopes = getDefaultMcpSessionScopes();
  assert.deepEqual([...scopes].sort(), [
    'mcp:message.paste',
    'mcp:self.read',
    'mcp:sessions.list',
    'mcp:sessions.search',
    'mcp:status.write',
    'mcp:terminals.read',
    'mcp:workspaces.read',
  ]);
  for (const forbidden of ['mcp:workspaces.write', 'mcp:terminals.write', 'mcp:terminals.exec', 'mcp:message.submit']) {
    assert.equal(scopes.includes(forbidden), false, forbidden);
  }
});
