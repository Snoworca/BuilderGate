// Whether an editor window shows, and the hiding axis it shows against.
//
// Hiding is never an unmount: the ported editor reads `markdownSource` once when
// it mounts and is the document's source of truth from then on, so tearing the
// component down throws away whatever the user has typed. This module therefore
// answers with a boolean and offers nothing to destroy -- the caller turns a false
// into `display: none` on the window surface and leaves the tree alone.
// @req FR-MDE-002

import type { EditorWindowPlacementState } from './editorWindowPlacement.ts';

/** The screens `AppContent` switches between. Windows live on the workspace one. */
export type EditorWindowScreen = 'workspace' | 'settings';

/**
 * A workspace shows one tab at a time, or all of them at once, as the workspace is
 * **rendered** rather than as it is stored: the mobile layout renders tab mode
 * whatever the stored value says, and a workspace saved as grid keeps that stored
 * value until an async update lands.
 *
 * The visibility predicate stopped reading this when the window stopped being
 * scoped to one terminal tab. The type stays here because the tray model and the
 * window hook both take it, and moving it is a rename across those callers rather
 * than part of this change.
 */
export type EditorWindowViewMode = 'tab' | 'grid';

/**
 * The terminal area a tab's host slot registers with the runtime, in the shape
 * `upsertHost` stores it. Coordinates are relative to the stage root, not to the
 * viewport, so they go negative for a slot that is off screen.
 *
 * Read by the window layer, which hands the entry to each window, rather than by
 * the predicate below: a window is no longer placed over a terminal.
 * @req FR-MDE-002
 */
export interface EditorWindowTerminalHost {
  isVisible: boolean;
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * Everything the three terms read. The window contributes its own workspace; the
 * rest is the state of the app around it.
 *
 * The terminal tab a window was opened from is deliberately not here, and neither
 * is the terminal area under it. A window holds documents opened from several
 * terminals, so no single tab could gate it, and it is never placed over a
 * terminal. Leaving the fields in as ignored inputs would let a caller believe it
 * had asked for something.
 * @req FR-MDE-002
 */
export interface EditorWindowVisibilityInput {
  minimized: boolean;
  screen: EditorWindowScreen;
  activeWorkspaceId: string | null;
  windowWorkspaceId: string;
}

/**
 * The placement state widened by the hiding flag. `minimized` sits beside the
 * placement rather than inside it, which is what lets a window come back to the
 * state it was in instead of to a default.
 * @req FR-MDE-002
 */
export type EditorWindowHidingState = EditorWindowPlacementState & { minimized: boolean };

/**
 * The three-term conjunction. Only term 1 is the user's to set through a window
 * button; the other two are the system's, so clearing `minimized` on its own does
 * not promise the window appears.
 *
 * The terminal tab a window was opened from is not a term. Documents opened from
 * several terminals share one window, so a rule that showed the window only while
 * its own tab was the active one could not hold for more than one of them at a
 * time. The workspace stays a term because it divides whole units of work, and a
 * document from another workspace following the user across was never asked for.
 * @req FR-MDE-002
 * @req CON-MDE-002
 */
export function isEditorWindowVisible(input: EditorWindowVisibilityInput): boolean {
  return !input.minimized
    && input.screen === 'workspace'
    && input.windowWorkspaceId === input.activeWorkspaceId;
}

/**
 * Hides the window. The placement rides through untouched, so 최대화 still has the
 * same destination after a restore that it had before.
 * @req FR-MDE-002
 */
export function minimizeEditorWindow(state: EditorWindowHidingState): EditorWindowHidingState {
  return { ...state, minimized: true };
}

/**
 * Un-hides the window. This clears term 1 and nothing else -- the window reappears
 * only if the other two terms happen to hold.
 * @req FR-MDE-002
 */
export function restoreEditorWindow(state: EditorWindowHidingState): EditorWindowHidingState {
  return { ...state, minimized: false };
}
