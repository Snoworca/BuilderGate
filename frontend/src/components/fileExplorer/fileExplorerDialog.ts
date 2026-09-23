// The open-or-raise decision shared by every entry point to the file explorer
// (session-path menu, terminal menu, header button). Kept pure and stateless so
// a repeated request can never flip into a close: the hook that owns the window
// turns 'raise' into raiseDialogById(id, 'modeless') and 'create' into a new
// modeless window.

export type OpenFileExplorerAction = 'raise' | 'create';

export interface OpenFileExplorerDecision {
  action: OpenFileExplorerAction;
  dialogId: string;
}

export interface OpenFileExplorerInput {
  registeredDialogIds: readonly string[];
  workspaceId: string;
}

const DIALOG_ID_PREFIX = 'file-explorer:';

// @req FR-FEX-003
export function fileExplorerDialogId(workspaceId: string): string {
  return `${DIALOG_ID_PREFIX}${workspaceId}`;
}

// A single parameter on purpose: an entry-point kind has no say in the outcome,
// and the property list is read explicitly so extra fields on the input are
// ignored rather than forwarded.
// @req FR-FEX-003
// @req FR-FEX-010
export function decideOpenFileExplorer(input: OpenFileExplorerInput): OpenFileExplorerDecision {
  const dialogId = fileExplorerDialogId(input.workspaceId);
  // Exact membership only: prefix or substring matching would let ws-1 raise
  // ws-10's window or another dialog that merely mentions the workspace.
  const action: OpenFileExplorerAction = input.registeredDialogIds.includes(dialogId)
    ? 'raise'
    : 'create';
  return { action, dialogId };
}
