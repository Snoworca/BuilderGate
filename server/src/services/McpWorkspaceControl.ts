// FR-MCP-007 / FR-MCP-008: backs the MCP management tools with WorkspaceService. Each change
// broadcasts the same WebSocket event the REST workspace routes send, so every open browser
// follows it; commands go through the MCP input gateway.
import type { SessionManager } from './SessionManager.js';
import type { WorkspaceService } from './WorkspaceService.js';
import type { McpTerminalView, McpWorkspaceControl, McpWorkspaceView } from './McpManagementTools.js';
import type { ShellType } from '../types/index.js';
import type { Workspace, WorkspaceTab } from '../types/workspace.types.js';

type Rec = Record<string, unknown>;

export interface WorkspaceServiceMcpControlDeps {
  workspaceService: Pick<WorkspaceService, 'getState' | 'createWorkspace' | 'updateWorkspace' | 'deleteWorkspace' | 'addTab' | 'deleteTab'>;
  sessionManager: Pick<SessionManager, 'getLastCwd' | 'writeInput' | 'readTerminalText'>;
  broadcast: (event: string, data: object) => void;
  /** The MCP gateway delivery (createMcpGatewayDelivery in index.ts). */
  deliver: (delivery: Rec) => Promise<Rec>;
}

export function createWorkspaceServiceMcpControl(deps: WorkspaceServiceMcpControlDeps): McpWorkspaceControl {
  const { workspaceService, sessionManager, broadcast } = deps;
  const toWorkspace = (ws: Workspace): McpWorkspaceView => ({
    id: ws.id,
    name: ws.name,
    sortOrder: ws.sortOrder,
    activeTabId: ws.activeTabId,
  });
  const toTerminal = (tab: WorkspaceTab): McpTerminalView => ({
    id: tab.id,
    workspaceId: tab.workspaceId,
    sessionId: tab.sessionId,
    sessionKey: tab.sessionKey ?? null,
    name: tab.name,
    shellType: tab.shellType ?? 'auto',
    lifecycleState: tab.lifecycleState ?? 'active',
    cwd: sessionManager.getLastCwd(tab.sessionId) ?? tab.lastCwd ?? null,
  });
  return {
    listWorkspaces: () => workspaceService.getState().workspaces.map(toWorkspace),
    listTerminals: () => [...workspaceService.getState().tabs]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toTerminal),
    createWorkspace: async (name) => {
      const workspace = await workspaceService.createWorkspace(name);
      broadcast('workspace:created', workspace);
      return toWorkspace(workspace);
    },
    renameWorkspace: async (id, name) => {
      const workspace = await workspaceService.updateWorkspace(id, { name });
      broadcast('workspace:updated', { id, changes: { name: workspace.name } });
      return toWorkspace(workspace);
    },
    deleteWorkspace: async (id) => {
      broadcast('workspace:deleting', { id });
      await workspaceService.deleteWorkspace(id);
      broadcast('workspace:deleted', { id });
    },
    createTerminal: async (workspaceId, options) => {
      const tab = await workspaceService.addTab(workspaceId, options.shell as ShellType | undefined, options.name, options.cwd);
      broadcast('tab:added', tab);
      return toTerminal(tab);
    },
    deleteTerminal: async (workspaceId, terminalId) => {
      await workspaceService.deleteTab(workspaceId, terminalId);
      broadcast('tab:removed', { id: terminalId, workspaceId });
    },
    execTerminal: async (terminal, command, actor) => {
      // The gateway's submit mode only permits an Enter in the data; it does not add one.
      const line = `${command}\r`;
      if (!terminal.sessionKey) {
        return sessionManager.writeInput(terminal.sessionId, line)
          ? { ok: true, status: 'delivered' }
          : { ok: false, code: 'TARGET_NOT_LIVE' };
      }
      return deps.deliver({
        sessionKey: terminal.sessionKey,
        prompt: line,
        deliveryMode: 'submit',
        actor,
        source: 'mcp-terminal-exec',
        context: {},
      });
    },
    readTerminalText: (sessionId, maxLines) => sessionManager.readTerminalText(sessionId, maxLines),
  };
}
