// The header tray: which windows it offers, whether it is offered at all, and
// what choosing one of its entries does to the app around the window.
//
// Everything here is a pure transition over values the caller already holds, so
// the two judgements that decide whether the tray works -- its scope and its
// revival -- are readable without a DOM. What is left for the browser is where
// the icon sits among its siblings and when the deferred placement
// resolves.
// @req FR-MDE-008

import { truncatePathLeft } from '../../utils/pathUtils.ts';
import { windowDialogTitleText } from '../dialog/windowDialogModel.ts';

/**
 * What the tray reads of a window. The placement is absent on purpose: the tray
 * neither reads nor changes where a window sits, only whether it is hidden.
 * @req FR-MDE-008
 */
export interface EditorTrayWindow {
  /** The normalized absolute path, which is the document's identity. */
  filePath: string;
  tabId: string;
  workspaceId: string;
  dirty: boolean;
}

/** One row of the list. `label` already carries the dirty marker. */
export interface EditorTrayEntry {
  filePath: string;
  tabId: string;
  label: string;
}

const TRAY_LABEL_MAX_LENGTH = 56;

function isInWorkspace(
  editorWindow: EditorTrayWindow,
  activeWorkspaceId: string | null,
): boolean {
  return activeWorkspaceId !== null && editorWindow.workspaceId === activeWorkspaceId;
}

/**
 * Whether the tray icon is rendered. This is the icon's own condition, and it is
 * the same scope the list uses, so the icon can never stand above an empty list.
 *
 * `Header.tsx`'s existing outer condition is "at least one callback exists" and
 * `App.tsx` passes those callbacks unconditionally, so gating the icon on it
 * would leave the icon permanently visible.
 * @req FR-MDE-008
 */
export function hasEditorTrayWindows(
  windows: readonly EditorTrayWindow[],
  activeWorkspaceId: string | null,
): boolean {
  return windows.some(editorWindow => isInWorkspace(editorWindow, activeWorkspaceId));
}

/**
 * The list, in the order the windows are held. Minimized windows are listed --
 * the tray is how they are reached -- and windows of other workspaces are not,
 * because making one of those visible would move the user to a workspace they
 * did not ask for.
 *
 * The row shows the absolute path rather than the file name. Nearly every
 * window in this product is open on a file called CLAUDE.md, so a list of file
 * names is a list of identical rows and the only way to find the one wanted is
 * to open each in turn. The head is what gets elided when the path is too long,
 * which keeps the file name and its parent directories -- the part that
 * actually differs -- and matches how the header already draws the session cwd.
 *
 * The dirty marker comes from `windowDialogTitleText`, the same function the
 * window title bar draws through, so the two never disagree about it.
 * @req FR-MDE-008
 */
export function listEditorTrayEntries(
  windows: readonly EditorTrayWindow[],
  activeWorkspaceId: string | null,
): EditorTrayEntry[] {
  return windows
    .filter(editorWindow => isInWorkspace(editorWindow, activeWorkspaceId))
    .map(editorWindow => ({
      filePath: editorWindow.filePath,
      tabId: editorWindow.tabId,
      label: windowDialogTitleText(
        truncatePathLeft(editorWindow.filePath, TRAY_LABEL_MAX_LENGTH),
        editorWindow.dirty,
      ),
    }));
}

