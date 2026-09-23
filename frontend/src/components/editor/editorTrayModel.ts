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
  /** The terminal tab's display name, or undefined once that tab is gone. */
  tabName?: string;
  workspaceId: string;
  /** The workspace's display name, or undefined when it is no longer listed. */
  workspaceName?: string;
  dirty: boolean;
}

/**
 * One row of the list. `label` already carries the dirty marker.
 *
 * `workspaceId` rides along because choosing a row is what moves the user to
 * that workspace, and the caller cannot work it out from the path -- two
 * workspaces can hold documents at the same path only by holding the same file,
 * and even then the row names one of them.
 */
export interface EditorTrayEntry {
  filePath: string;
  tabId: string;
  workspaceId: string;
  label: string;
}

/**
 * How much of the path half a row may carry.
 *
 * The prefix is not counted against it. The prefix is short, bounded by the
 * names the user gave, and it is the only thing separating a document in one
 * workspace from a document of the same name in another -- eliding it would
 * take away what the row is for.
 */
const TRAY_PATH_MAX_LENGTH = 56;

/** What a row shows where a name is gone. Filled in rather than left blank: a
 * row with an empty segment reads as a row for nothing, and the row is still
 * how the document is reached. */
export const MISSING_WORKSPACE_NAME = '(이름 없음)';
const MISSING_TAB_NAME = '(닫힌 탭)';

/**
 * Whether the tray icon is rendered. This is the icon's own condition, and it is
 * the same scope the list uses, so the icon can never stand above an empty list.
 *
 * `Header.tsx`'s existing outer condition is "at least one callback exists" and
 * `App.tsx` passes those callbacks unconditionally, so gating the icon on it
 * would leave the icon permanently visible.
 * @req FR-MDE-008
 */
export function hasEditorTrayWindows(windows: readonly EditorTrayWindow[]): boolean {
  return windows.length > 0;
}

/**
 * What the badge carries: how many documents are open, across every workspace.
 *
 * It counted minimized windows before. One window per workspace made that 0 or
 * 1, which said nothing the icon did not already say by being there.
 * @req FR-MDE-008
 */
export function countEditorTrayWindows(windows: readonly EditorTrayWindow[]): number {
  return windows.length;
}

/**
 * The list, in the order the documents were opened, across every workspace.
 *
 * Not scoped to the active workspace. It was, so that choosing a row could not
 * move the user somewhere they had not asked to go; choosing a row is now how
 * they ask, and the scope follows.
 *
 * A row reads `workspace / tab | path`.
 *
 * The path is there because nearly every document in this product is a file
 * called CLAUDE.md, so a list of file names is a list of identical rows. The
 * workspace is there because tab names are chosen per workspace and repeat
 * freely -- two workspaces each with a `Terminal-1` would otherwise give the
 * same row twice. The tab is there because one workspace holds several, and the
 * path alone does not say which terminal a document saves to.
 *
 * The head of the path is what gets elided, which keeps the file name and its
 * parent directories -- the part that actually differs -- and matches how the
 * header already draws the session cwd.
 *
 * The dirty marker comes from `windowDialogTitleText`, the same function the
 * window title bar and the document tabs draw through, so none of them disagree
 * about where the marker goes.
 * @req FR-MDE-008
 */
export function listEditorTrayEntries(
  windows: readonly EditorTrayWindow[],
): EditorTrayEntry[] {
  return windows.map(editorWindow => ({
    filePath: editorWindow.filePath,
    tabId: editorWindow.tabId,
    workspaceId: editorWindow.workspaceId,
    label: windowDialogTitleText(
      [
        editorWindow.workspaceName ?? MISSING_WORKSPACE_NAME,
        ' / ',
        editorWindow.tabName ?? MISSING_TAB_NAME,
        ' | ',
        truncatePathLeft(editorWindow.filePath, TRAY_PATH_MAX_LENGTH),
      ].join(''),
      editorWindow.dirty,
    ),
  }));
}

