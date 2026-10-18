// FR-MCP-012 AC-7: what a browser does with an `editor:open` broadcast. The MCP editor tools send
// it after the server has checked the file; a browser shows the workspace the terminal is in and
// opens the file there, the same way the session path menu does.

// FR-MCP-013 / FR-MDE-028 AC-1: an HTML file opens in the view the tool asked for.
export type EditorOpenKind = 'markdown' | 'code' | 'image' | 'html';

export interface EditorOpenRequest {
  workspaceId: string;
  terminalId: string;
  filePath: string;
  kind: EditorOpenKind;
  /** Only for html: rendered unless the tool asked for the source. */
  view?: 'rendered' | 'source';
}

export type EditorRemoteOpenStep =
  | { action: 'ignore' }
  | { action: 'switch'; workspaceId: string }
  | { action: 'open'; filePath: string; tabId: string; view?: 'rendered' | 'source' };

const KINDS: ReadonlySet<string> = new Set(['markdown', 'code', 'image', 'html']);

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
  if (kind === 'html') {
    return { workspaceId, terminalId, filePath, kind, view: record.view === 'source' ? 'source' : 'rendered' };
  }
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
  return { action: 'open', filePath: request.filePath, tabId: tab.id, ...(request.view === undefined ? {} : { view: request.view }) };
}
