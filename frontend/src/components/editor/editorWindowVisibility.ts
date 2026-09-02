// Whether an editor window shows, and the hiding axis it shows against.
//
// Hiding is never an unmount: the ported editor reads `markdownSource` once when
// it mounts and is the document's source of truth from then on, so tearing the
// component down throws away whatever the user has typed. This module therefore
// answers with a boolean and offers nothing to destroy -- the caller turns a false
// into `display: none` on the window surface and leaves the tree alone.
// @req FR-MDE-002

import type { EditorWindowPlacement, EditorWindowPlacementState } from './editorWindowPlacement.ts';

/** The screens `AppContent` switches between. Windows live on the workspace one. */
export type EditorWindowScreen = 'workspace' | 'settings';

/**
 * A workspace shows one tab at a time, or all of them at once. Term 4 reads the
 * mode the workspace is **rendered** in, which is not always the one stored on it:
 * the mobile layout renders tab mode whatever the stored value says, and a
 * workspace saved as grid keeps that stored value until an async update lands. The
 * caller passes what it renders, so the window agrees with the tab wrapper beside
 * it instead of with a setting nothing on screen is obeying.
 */
export type EditorWindowViewMode = 'tab' | 'grid';

/**
 * The terminal area a tab's host slot registers with the runtime, in the shape
 * `upsertHost` stores it. Coordinates are relative to the stage root, not to the
 * viewport, so they go negative for a slot that is off screen.
 * @req FR-MDE-002
 */
export interface EditorWindowTerminalHost {
  isVisible: boolean;
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * Everything the five terms read. The window contributes its own workspace, tab
 * and placement; the rest is the state of the app around it.
 * @req FR-MDE-002
 */
export interface EditorWindowVisibilityInput {
  minimized: boolean;
  screen: EditorWindowScreen;
  activeWorkspaceId: string | null;
  windowWorkspaceId: string;
  viewMode: EditorWindowViewMode;
  activeTabId: string | null;
  windowTabId: string;
  placement: EditorWindowPlacement;
  host: EditorWindowTerminalHost | undefined;
  /**
   * The bound tab no longer exists.
   *
   * Term 4 scopes a window to its tab, and a window whose tab is gone is scoped
   * to no tab: there is no longer a tab it could be the active one. Left to
   * term 4, such a window disappears the moment the app moves the active tab
   * elsewhere -- which is exactly what closing a tab does -- taking a body
   * nobody has saved with it.
   *
   * Required rather than defaulted. A default would have to be `false`, which
   * is the answer that loses the window, and a caller that had not heard of
   * orphaned windows would get it silently. Asking makes that caller fail to
   * compile instead.
   * @req CON-MDE-002
   */
  tabClosed: boolean;
}

/**
 * The placement state widened by the hiding flag. `minimized` sits beside the
 * placement rather than inside it, which is what lets a window come back to the
 * state it was in instead of to a default.
 * @req FR-MDE-002
 */
export type EditorWindowHidingState = EditorWindowPlacementState & { minimized: boolean };

/**
 * Term 5's judgement, the same one `TerminalRuntimeEntry` already makes about the
 * terminal itself. `isVisible` is a field `upsertHost` registers as its own
 * argument, so it is read rather than inferred from the rect -- a hidden slot still
 * reports coordinates, and an unmounted one has been deleted from the registry
 * altogether, which is why the absent entry counts as unusable too.
 * @req FR-MDE-002
 */
export function hasUsableTerminalArea(host: EditorWindowTerminalHost | undefined): boolean {
  return Boolean(host?.isVisible && host.rect.width > 0 && host.rect.height > 0);
}

/**
 * The five-term conjunction. Only term 1 is the user's to set through a window
 * button; the other four are the system's, so clearing `minimized` on its own does
 * not promise the window appears.
 *
 * Terms 3 and 4 together are the judgement `AppContent` already makes for a tab
 * wrapper -- workspace and tab -- with term 4 widened by the grid-mode escape,
 * because grid puts every tab on screen at once, and by the orphan escape,
 * because a window whose tab is gone is scoped to no tab at all. Term 5 asks
 * only about a `docked` window, since `stage` and `floating` are placed against
 * the stage and never read the terminal rect.
 * @req FR-MDE-002
 * @req CON-MDE-002
 */
export function isEditorWindowVisible(input: EditorWindowVisibilityInput): boolean {
  return !input.minimized
    && input.screen === 'workspace'
    && input.windowWorkspaceId === input.activeWorkspaceId
    && (input.viewMode === 'grid'
      || input.tabClosed
      || input.windowTabId === input.activeTabId)
    && (input.placement !== 'docked' || hasUsableTerminalArea(input.host));
}

/**
 * Hides the window. The placement rides through untouched, so 최대화 and 터미널 채움
 * still have the same destination after a restore that they had before.
 * @req FR-MDE-002
 */
export function minimizeEditorWindow(state: EditorWindowHidingState): EditorWindowHidingState {
  return { ...state, minimized: true };
}

/**
 * Un-hides the window. This clears term 1 and nothing else -- the window reappears
 * only if the other four terms happen to hold.
 * @req FR-MDE-002
 */
export function restoreEditorWindow(state: EditorWindowHidingState): EditorWindowHidingState {
  return { ...state, minimized: false };
}
