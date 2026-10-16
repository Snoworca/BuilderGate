// FR-MCP-012 AC-7: what a browser does with an `editor:open` broadcast. The MCP editor tools send
// it after the server has checked the file; a browser shows the workspace the terminal is in and
// opens the file there, the same way the session path menu does.

export type EditorOpenKind = 'markdown' | 'code' | 'image';

export interface EditorOpenRequest {
  workspaceId: string;
  terminalId: string;
  filePath: string;
  kind: EditorOpenKind;
}

export type EditorRemoteOpenStep =
  | { action: 'ignore' }
  | { action: 'switch'; workspaceId: string }
  | { action: 'open'; filePath: string; tabId: string };

const KINDS: ReadonlySet<string> = new Set(['markdown', 'code', 'image']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The broadcast payload, or null when it is not one. */
export function parseEditorOpenRequest(data: unknown): EditorOpenRequest | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const workspaceId = text(record.workspaceId);
  const terminalId = text(record.terminalId);
  const filePath = text(record.filePath);
  const kind = text(record.kind);
  if (!workspaceId || !terminalId || !filePath || !kind || !KINDS.has(kind)) return null;
  return { workspaceId, terminalId, filePath, kind: kind as EditorOpenKind };
}

/**
 * A request for a terminal this browser does not know, or one that moved to another workspace,
 * is ignored. A request for another workspace first switches to it; the open happens once that
 * workspace is active, because a document belongs to the workspace it is opened in.
 */
export function planEditorRemoteOpen(
  request: EditorOpenRequest,
  state: { activeWorkspaceId: string | null; tabs: readonly { id: string; workspaceId: string }[] },
): EditorRemoteOpenStep {
  const tab = state.tabs.find(candidate => candidate.id === request.terminalId);
  if (tab === undefined || tab.workspaceId !== request.workspaceId) return { action: 'ignore' };
  if (state.activeWorkspaceId !== request.workspaceId) return { action: 'switch', workspaceId: request.workspaceId };
  return { action: 'open', filePath: request.filePath, tabId: tab.id };
}
