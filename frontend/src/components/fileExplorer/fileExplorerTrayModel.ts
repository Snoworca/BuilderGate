// The explorer window's minimize, 최대화, header tray row and revival, as pure
// decisions over the record the window hook keeps.
//
// The editor window already owns the hiding and placement rules. The explorer
// goes through those same functions instead of keeping a copy of its own, so
// the two kinds of window can never drift apart on what minimize or 최대화
// means. Only what is specific to the explorer -- one row per workspace window
// and the dialog id it raises -- is decided here.
// @req FR-FEX-004

import { MISSING_WORKSPACE_NAME } from '../editor/editorTrayModel.ts';
import {
  minimizeEditorWindow,
  restoreEditorWindow,
  type EditorWindowHidingState,
  type EditorWindowScreen,
} from '../editor/editorWindowVisibility.ts';
import { toggleMaximize, type EditorWindowPlacementState } from '../editor/editorWindowPlacement.ts';
import { fileExplorerDialogId } from './fileExplorerDialog.ts';

/** The hiding state an explorer record carries: the editor's, unchanged. */
export type FileExplorerWindowHiding = EditorWindowHidingState;

/**
 * Hides the window. Generic over the full record so the tabs, and the trees
 * that hold the expanded directories and selection, come back as the same
 * references rather than as a narrowed copy.
 * @req FR-FEX-004
 */
export function minimizeFileExplorerRecord<R extends EditorWindowHidingState>(record: R): R {
  // The editor function spreads its input, so every field of R survives; the
  // cast only restores the width its signature forgets.
  return minimizeEditorWindow(record) as R;
}

/**
 * Un-hides the window. The placement rides through, so a window minimized while
 * maximized comes back maximized.
 * @req FR-FEX-004
 */
export function restoreFileExplorerRecord<R extends EditorWindowHidingState>(record: R): R {
  return restoreEditorWindow(record) as R;
}

/**
 * 최대화, by the editor's placement transition.
 * @req FR-FEX-004
 */
export function toggleFileExplorerMaximize<R extends EditorWindowPlacementState>(record: R): R {
  return toggleMaximize(record) as R;
}

/** One tray row for an explorer window. */
export interface FileExplorerTrayEntry {
  workspaceId: string;
  label: string;
}

/**
 * One row per open explorer window, in input order. A window is per workspace,
 * so its tabs never add rows, and a minimized window is listed as well: the
 * tray is how a hidden window is reached again.
 * @req FR-FEX-004
 */
export function listFileExplorerTrayEntries<W extends { workspaceId: string }>(
  windows: readonly W[],
  workspaceNameOf: (workspaceId: string) => string | undefined,
): FileExplorerTrayEntry[] {
  return windows.map((explorerWindow) => ({
    workspaceId: explorerWindow.workspaceId,
    label: `파일 탐색기 — ${workspaceNameOf(explorerWindow.workspaceId) ?? MISSING_WORKSPACE_NAME}`,
  }));
}

/**
 * Whether the header tray icon is shown. Either kind of window is enough:
 * gating on editor windows alone would strand a minimized explorer.
 * @req FR-FEX-004
 */
export function hasHeaderTrayWindows(editorCount: number, explorerCount: number): boolean {
  return editorCount > 0 || explorerCount > 0;
}

export interface ReviveFileExplorerInput {
  workspaceId: string;
  activeWorkspaceId: string | null;
  screen: EditorWindowScreen;
}

export interface ReviveFileExplorerDecision {
  /** The workspace to switch to, or null when the window's is already active. */
  switchWorkspaceId: string | null;
  /** Whether the settings screen has to give way to the workspace screen. */
  showWorkspaceScreen: boolean;
  raiseDialogId: string;
}

/**
 * What choosing a tray row does around the window. The caller also clears the
 * hiding flag; this only names the moves that make the window visible and on
 * top once it is un-hidden.
 * @req FR-FEX-004
 */
export function decideReviveFileExplorer(input: ReviveFileExplorerInput): ReviveFileExplorerDecision {
  return {
    switchWorkspaceId: input.workspaceId === input.activeWorkspaceId ? null : input.workspaceId,
    showWorkspaceScreen: input.screen !== 'workspace',
    raiseDialogId: fileExplorerDialogId(input.workspaceId),
  };
}
