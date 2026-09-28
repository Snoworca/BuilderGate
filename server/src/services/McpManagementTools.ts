// FR-MCP-007, FR-MCP-008: MCP tools that list, create, rename and delete workspaces, and list,
// create and delete terminals (workspace tabs) and run commands in them. The tools talk to an
// injected McpWorkspaceControl; index.ts backs it with WorkspaceService, the MCP input gateway
// and the WebSocket broadcasts the REST routes already send. Scopes: SEC-MCP-004.

type Rec = Record<string, unknown>;

export interface McpWorkspaceView {
  id: string;
  name: string;
  sortOrder: number;
  activeTabId: string | null;
}

export interface McpTerminalView {
  id: string;
  workspaceId: string;
  sessionId: string;
  sessionKey: string | null;
  name: string;
  shellType: string;
  lifecycleState: string;
  cwd: string | null;
}

export interface McpWorkspaceControl {
  listWorkspaces(): McpWorkspaceView[];
  listTerminals(): McpTerminalView[];
  createWorkspace(name?: string): Promise<McpWorkspaceView>;
  renameWorkspace(id: string, name: string): Promise<McpWorkspaceView>;
  deleteWorkspace(id: string): Promise<void>;
  createTerminal(workspaceId: string, options: { name?: string; shell?: string; cwd?: string }): Promise<McpTerminalView>;
  deleteTerminal(workspaceId: string, terminalId: string): Promise<void>;
  /** Submits `command` (with Enter) through the MCP input gateway. */
  execTerminal(terminal: McpTerminalView, command: string, actor: Rec): Promise<Rec>;
  readTerminalText(sessionId: string, maxLines: number): string | null;
}

export interface McpManagementDeps {
  workspaceControl?: McpWorkspaceControl;
  sleep?: (ms: number) => Promise<void>;
}

export const MCP_MANAGEMENT_TOOL_NAMES = [
  'buildergate.workspace.list',
  'buildergate.workspace.create',
  'buildergate.workspace.rename',
  'buildergate.workspace.delete',
  'buildergate.terminal.list',
  'buildergate.terminal.create',
  'buildergate.terminal.delete',
  'buildergate.terminal.exec',
] as const;

export type McpManagementToolName = typeof MCP_MANAGEMENT_TOOL_NAMES[number];

const EXEC_MAX_WAIT_MS = 30_000;
const EXEC_DEFAULT_LINES = 40;
const EXEC_MAX_LINES = 200;

const workspaceRef = {
  workspaceId: { type: 'string', description: 'Workspace id. Use this or workspaceName.' },
  workspaceName: { type: 'string', description: 'Workspace name. Use this or workspaceId.' },
};
const terminalRef = {
  terminalId: { type: 'string', description: 'Terminal (tab) id. Use this, or terminalName with a workspace.' },
  terminalName: { type: 'string', description: 'Terminal name inside the given workspace.' },
};

export const MCP_MANAGEMENT_TOOL_SCHEMAS: Record<McpManagementToolName, Rec> = {
  'buildergate.workspace.list': { type: 'object', properties: {}, additionalProperties: false },
  'buildergate.workspace.create': {
    type: 'object',
    properties: { name: { type: 'string', description: 'Workspace name (1-32 characters). Optional.' } },
    additionalProperties: false,
  },
  'buildergate.workspace.rename': {
    type: 'object',
    properties: { ...workspaceRef, name: { type: 'string', description: 'New name (1-32 characters).' } },
    required: ['name'],
    additionalProperties: false,
  },
  'buildergate.workspace.delete': {
    type: 'object',
    properties: { ...workspaceRef, confirm: { type: 'boolean', description: 'Must be true. Deleting closes every terminal in the workspace.' } },
    required: ['confirm'],
    additionalProperties: false,
  },
  'buildergate.terminal.list': {
    type: 'object',
    properties: { ...workspaceRef },
    additionalProperties: false,
  },
  'buildergate.terminal.create': {
    type: 'object',
    properties: {
      ...workspaceRef,
      name: { type: 'string', description: 'Terminal name. Optional.' },
      shell: { type: 'string', enum: ['auto', 'powershell', 'wsl', 'bash', 'zsh', 'sh', 'cmd'] },
      cwd: { type: 'string', description: 'Starting directory. Optional.' },
    },
    additionalProperties: false,
  },
  'buildergate.terminal.delete': {
    type: 'object',
    properties: { ...workspaceRef, ...terminalRef, confirm: { type: 'boolean', description: 'Must be true.' } },
    required: ['confirm'],
    additionalProperties: false,
  },
  'buildergate.terminal.exec': {
    type: 'object',
    properties: {
      ...workspaceRef,
      ...terminalRef,
      command: { type: 'string', description: 'Command line to type and submit with Enter.' },
      waitMs: { type: 'integer', minimum: 0, maximum: EXEC_MAX_WAIT_MS, description: 'Wait this long, then return the screen text. 0 (default) returns at once without output.' },
      outputLines: { type: 'integer', minimum: 1, maximum: EXEC_MAX_LINES, description: `Screen lines to return after the wait (default ${EXEC_DEFAULT_LINES}).` },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

export const MCP_MANAGEMENT_TOOL_DESCRIPTIONS: Record<McpManagementToolName, string> = {
  'buildergate.workspace.list': 'List BuilderGate workspaces with their terminal counts.',
  'buildergate.workspace.create': 'Create a workspace.',
  'buildergate.workspace.rename': 'Rename a workspace given by workspaceId or workspaceName.',
  'buildergate.workspace.delete': 'Delete a workspace and close its terminals. Requires confirm: true.',
  'buildergate.terminal.list': 'List terminal sessions, optionally only those of one workspace (workspaceId or workspaceName).',
  'buildergate.terminal.create': 'Open a terminal session in a workspace given by workspaceId or workspaceName.',
  'buildergate.terminal.delete': 'Close a terminal given by terminalId, or by terminalName within a workspace. Requires confirm: true.',
  'buildergate.terminal.exec': 'Run a command in a terminal and optionally return its screen text after waitMs.',
};

const REQUIRED_SCOPE: Record<McpManagementToolName, string> = {
  'buildergate.workspace.list': 'mcp:workspaces.read',
  'buildergate.workspace.create': 'mcp:workspaces.write',
  'buildergate.workspace.rename': 'mcp:workspaces.write',
  'buildergate.workspace.delete': 'mcp:workspaces.write',
  'buildergate.terminal.list': 'mcp:terminals.read',
  'buildergate.terminal.create': 'mcp:terminals.write',
  'buildergate.terminal.delete': 'mcp:terminals.write',
  'buildergate.terminal.exec': 'mcp:terminals.exec',
};

export function isMcpManagementTool(name: string): name is McpManagementToolName {
  return (MCP_MANAGEMENT_TOOL_NAMES as readonly string[]).includes(name);
}

export async function callMcpManagementTool(
  deps: McpManagementDeps,
  name: McpManagementToolName,
  actor: Rec,
  args: Rec,
): Promise<Rec> {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  if (!scopes.includes(REQUIRED_SCOPE[name])) return { ok: false, code: 'INVALID_SCOPE' };
  const control = deps.workspaceControl;
  if (!control) return { ok: false, code: 'MCP_WORKSPACE_CONTROL_UNAVAILABLE' };
  try {
    return await dispatch(deps, control, name, actor, args);
  } catch (error) {
    return mapServiceError(error);
  }
}

async function dispatch(
  deps: McpManagementDeps,
  control: McpWorkspaceControl,
  name: McpManagementToolName,
  actor: Rec,
  args: Rec,
): Promise<Rec> {
  const workspaces = [...control.listWorkspaces()].sort((a, b) => a.sortOrder - b.sortOrder);
  const terminals = control.listTerminals();
  switch (name) {
    case 'buildergate.workspace.list':
      return { ok: true, workspaces: workspaces.map(ws => workspaceView(ws, terminals)) };
    case 'buildergate.workspace.create': {
      const created = await control.createWorkspace(optionalString(args.name));
      return { ok: true, workspace: workspaceView(created, []) };
    }
    case 'buildergate.workspace.rename': {
      const newName = optionalString(args.name);
      if (!newName) return validation({ name: 'required' });
      const target = resolveWorkspace(workspaces, args, terminals);
      if (!target.ok) return target.error;
      const renamed = await control.renameWorkspace(target.workspace.id, newName);
      return { ok: true, workspace: workspaceView(renamed, terminals) };
    }
    case 'buildergate.workspace.delete': {
      const target = resolveWorkspace(workspaces, args, terminals);
      if (!target.ok) return target.error;
      if (args.confirm !== true) return validation({ confirm: 'must be true' });
      await control.deleteWorkspace(target.workspace.id);
      return { ok: true, deleted: { workspaceId: target.workspace.id, name: target.workspace.name } };
    }
    case 'buildergate.terminal.list': {
      if (!hasWorkspaceRef(args)) {
        return { ok: true, terminals: terminals.map(t => terminalView(t, workspaces)) };
      }
      const target = resolveWorkspace(workspaces, args, terminals);
      if (!target.ok) return target.error;
      return {
        ok: true,
        terminals: terminals.filter(t => t.workspaceId === target.workspace.id).map(t => terminalView(t, workspaces)),
      };
    }
    case 'buildergate.terminal.create': {
      if (!hasWorkspaceRef(args)) return validation({ workspaceId: 'workspaceId or workspaceName is required' });
      const target = resolveWorkspace(workspaces, args, terminals);
      if (!target.ok) return target.error;
      const created = await control.createTerminal(target.workspace.id, {
        ...(optionalString(args.name) ? { name: optionalString(args.name) } : {}),
        ...(optionalString(args.shell) ? { shell: optionalString(args.shell) } : {}),
        ...(optionalString(args.cwd) ? { cwd: optionalString(args.cwd) } : {}),
      });
      return { ok: true, terminal: terminalView(created, workspaces) };
    }
    case 'buildergate.terminal.delete': {
      const target = resolveTerminal(workspaces, terminals, args);
      if (!target.ok) return target.error;
      if (args.confirm !== true) return validation({ confirm: 'must be true' });
      await control.deleteTerminal(target.terminal.workspaceId, target.terminal.id);
      return { ok: true, deleted: terminalView(target.terminal, workspaces) };
    }
    case 'buildergate.terminal.exec': {
      const command = typeof args.command === 'string' ? args.command.replace(/[\r\n]+$/u, '') : '';
      if (command.trim() === '') return validation({ command: 'required' });
      const target = resolveTerminal(workspaces, terminals, args);
      if (!target.ok) return target.error;
      const delivery = await control.execTerminal(target.terminal, command, actor);
      if (delivery.ok === false || delivery.accepted === false) {
        return { ...delivery, ok: false, code: typeof delivery.code === 'string' ? delivery.code : 'DELIVERY_FAILED' };
      }
      const result: Rec = { ok: true, terminalId: target.terminal.id, sessionId: target.terminal.sessionId, status: delivery.status ?? 'delivered' };
      const waitMs = clampInt(args.waitMs, 0, EXEC_MAX_WAIT_MS, 0);
      if (waitMs > 0) {
        await (deps.sleep ?? defaultSleep)(waitMs);
        const lines = clampInt(args.outputLines, 1, EXEC_MAX_LINES, EXEC_DEFAULT_LINES);
        result.output = control.readTerminalText(target.terminal.sessionId, lines) ?? '';
      }
      return result;
    }
  }
}

type WorkspaceResolution = { ok: true; workspace: McpWorkspaceView } | { ok: false; error: Rec };

function hasWorkspaceRef(args: Rec): boolean {
  return Boolean(optionalString(args.workspaceId) || optionalString(args.workspaceName));
}

function resolveWorkspace(workspaces: McpWorkspaceView[], args: Rec, terminals: McpTerminalView[]): WorkspaceResolution {
  const id = optionalString(args.workspaceId);
  const name = optionalString(args.workspaceName);
  if (!id && !name) return { ok: false, error: validation({ workspaceId: 'workspaceId or workspaceName is required' }) };
  if (id) {
    const byId = workspaces.find(ws => ws.id === id);
    if (!byId) return { ok: false, error: notFound('workspaceId', id) };
    if (name && byId.name !== name) {
      return { ok: false, error: validation({ workspaceName: `does not match workspace ${id}` }) };
    }
    return { ok: true, workspace: byId };
  }
  const exact = workspaces.filter(ws => ws.name === name);
  const matches = exact.length > 0 ? exact : workspaces.filter(ws => ws.name.toLowerCase() === name!.toLowerCase());
  if (matches.length === 0) return { ok: false, error: notFound('workspaceName', name!) };
  if (matches.length > 1) {
    return { ok: false, error: { ok: false, code: 'AMBIGUOUS_TARGET', candidates: matches.map(ws => workspaceView(ws, terminals)) } };
  }
  return { ok: true, workspace: matches[0] };
}

type TerminalResolution = { ok: true; terminal: McpTerminalView } | { ok: false; error: Rec };

function resolveTerminal(workspaces: McpWorkspaceView[], terminals: McpTerminalView[], args: Rec): TerminalResolution {
  const terminalId = optionalString(args.terminalId);
  const terminalName = optionalString(args.terminalName);
  let scope: McpWorkspaceView | null = null;
  if (hasWorkspaceRef(args)) {
    const target = resolveWorkspace(workspaces, args, terminals);
    if (!target.ok) return target;
    scope = target.workspace;
  }
  const pool = scope ? terminals.filter(t => t.workspaceId === scope!.id) : terminals;
  if (terminalId) {
    const byId = pool.find(t => t.id === terminalId);
    if (!byId) return { ok: false, error: notFound('terminalId', terminalId) };
    if (terminalName && byId.name !== terminalName) {
      return { ok: false, error: validation({ terminalName: `does not match terminal ${terminalId}` }) };
    }
    return { ok: true, terminal: byId };
  }
  if (!terminalName) return { ok: false, error: validation({ terminalId: 'terminalId or terminalName is required' }) };
  if (!scope) return { ok: false, error: validation({ workspaceId: 'terminalName needs workspaceId or workspaceName' }) };
  const matches = pool.filter(t => t.name === terminalName);
  if (matches.length === 0) return { ok: false, error: notFound('terminalName', terminalName) };
  if (matches.length > 1) {
    return { ok: false, error: { ok: false, code: 'AMBIGUOUS_TARGET', candidates: matches.map(t => terminalView(t, workspaces)) } };
  }
  return { ok: true, terminal: matches[0] };
}

function workspaceView(ws: McpWorkspaceView, terminals: McpTerminalView[]): Rec {
  return {
    workspaceId: ws.id,
    name: ws.name,
    sortOrder: ws.sortOrder,
    terminalCount: terminals.filter(t => t.workspaceId === ws.id).length,
    activeTerminalId: ws.activeTabId,
  };
}

function terminalView(t: McpTerminalView, workspaces: McpWorkspaceView[]): Rec {
  return {
    terminalId: t.id,
    sessionId: t.sessionId,
    sessionKey: t.sessionKey,
    name: t.name,
    workspaceId: t.workspaceId,
    workspaceName: workspaces.find(ws => ws.id === t.workspaceId)?.name ?? null,
    shellType: t.shellType,
    cwd: t.cwd,
    lifecycleState: t.lifecycleState,
  };
}

function mapServiceError(error: unknown): Rec {
  const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'WORKSPACE_NOT_FOUND':
    case 'TAB_NOT_FOUND':
    case 'SESSION_NOT_FOUND':
      return { ok: false, code: 'TARGET_NOT_FOUND', message };
    case 'INVALID_NAME':
      return { ok: false, code: 'VALIDATION_ERROR', message, fieldErrors: { name: 'must be 1-32 characters' } };
    case '':
      return { ok: false, code: 'MCP_CONTROL_ERROR', message };
    default:
      return { ok: false, code, message };
  }
}

function validation(fieldErrors: Rec): Rec {
  return { ok: false, code: 'VALIDATION_ERROR', fieldErrors };
}

function notFound(field: string, value: string): Rec {
  return { ok: false, code: 'TARGET_NOT_FOUND', fieldErrors: { [field]: `not found: ${value}` } };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
