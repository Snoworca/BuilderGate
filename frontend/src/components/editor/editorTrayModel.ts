// The header tray: which windows it offers, whether it is offered at all, and
// what choosing one of its entries does to the app around the window.
//
// Everything here is a pure transition over values the caller already holds, so
// the two judgements that decide whether the tray works -- its scope and its
// revival -- are readable without a DOM. What is left for the browser is where
// the icon sits among its siblings and when the deferred `docked` measurement
// resolves.
// @req FR-MDE-008

import { getLastSegment } from '../../utils/pathUtils.ts';
import { windowDialogTitleText } from '../dialog/windowDialogModel.ts';
import type {
  EditorWindowScreen,
  EditorWindowViewMode,
} from './editorWindowVisibility.ts';

/**
 * What the tray reads of a window. The placement is absent on purpose: the tray
 * neither reads nor changes where a window sits, only whether it is hidden.
 * @req FR-MDE-008
 */
export interface EditorTrayWindow {
  /** The normalized absolute path, which is the window's identity. */
  filePath: string;
  tabId: string;
  workspaceId: string;
  minimized: boolean;
  dirty: boolean;
}

/** One row of the list. `label` already carries the dirty marker. */
export interface EditorTrayEntry {
  filePath: string;
  tabId: string;
  label: string;
}

export interface EditorTrayRevivalInput<TWindow extends EditorTrayWindow> {
  /** The window whose entry was chosen. Passed whole, so it cannot be missing. */
  target: TWindow;
  windows: readonly TWindow[];
  screen: EditorWindowScreen;
  /** The mode the workspace is rendered in, which the mobile layout overrides. */
  viewMode: EditorWindowViewMode;
  activeTabId: string | null;
}

/**
 * The app state after a revival. Every field the caller has to apply is here, so
 * a caller that resolves only some of them is a caller that dropped fields
 * rather than one that had nothing to apply.
 * @req FR-MDE-008
 */
export interface EditorTrayRevival<TWindow extends EditorTrayWindow> {
  screen: EditorWindowScreen;
  activeTabId: string | null;
  windows: TWindow[];
  /** The path of the window to bring to the front of the modeless stack. */
  raise: string;
}

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
      label: windowDialogTitleText(getLastSegment(editorWindow.filePath), editorWindow.dirty),
    }));
}

/**
 * Choosing an entry. Every visibility condition that can be resolved is
 * resolved, and then the window is raised.
 *
 * Clearing `minimized` alone is the failure this exists to prevent: with the
 * settings screen showing or the bound tab hidden, the window stays invisible
 * and the user cannot tell whether the click registered.
 *
 * The tab switch is skipped in grid mode because grid renders every tab at once,
 * so there is nothing to switch to and moving the active tab would only take the
 * user's place away from them.
 *
 * No other window is touched. The requirement's "선택하여 이것만 출력 가능합니다"
 * is a revival of the one that was chosen, not a hiding of the rest -- the
 * sentence after it says several editor windows may be up at once.
 *
 * @req FR-MDE-007
 * @req FR-MDE-008
 */
export function reviveEditorTrayWindow<TWindow extends EditorTrayWindow>(
  input: EditorTrayRevivalInput<TWindow>,
): EditorTrayRevival<TWindow> {
  return {
    screen: 'workspace',
    activeTabId: input.viewMode === 'tab' ? input.target.tabId : input.activeTabId,
    windows: input.windows.map(editorWindow => (
      editorWindow.filePath === input.target.filePath
        ? { ...editorWindow, minimized: false }
        : editorWindow
    )),
    raise: input.target.filePath,
  };
}
