// Whether the editor window is placed by the user or by the layout.
//
// On a mobile layout it fills the stage and stays there: there is no room to
// float a window in, and nothing to float it beside. It also leaves the cached
// position untouched, in both directions. The cache is one value shared by
// every window, so a full-screen rect written from a phone would be inherited
// by the next window opened on a desktop -- the user would come back to a
// window filling their screen with no memory of having put it there.
//
// The three answers travel together rather than being worked out separately at
// each call site. They are one decision: a window that fills the screen cannot
// be dragged, and a window that cannot be dragged produces no rect to cache.
// Split across three call sites they could disagree, and the disagreement --
// a draggable full-screen window writing rects into the shared cache -- is
// exactly the failure this exists to prevent.
// @req FR-MDE-001
// @req FR-MDE-009

import type { EditorWindowPlacement } from './editorWindowPlacement.ts';

/** What the layout answer depends on. */
export interface EditorWindowPlacementModeInput {
  /** The mobile layout is being rendered, as `useResponsive` reports it. */
  isMobile: boolean;
}

export interface EditorWindowPlacementMode {
  /** Where a newly opened window goes. */
  placement: EditorWindowPlacement;
  /** Whether the shared position cache is read on open and written on drag. */
  usesGeometryCache: boolean;
  /** Whether the window can be moved and resized by hand. */
  draggable: boolean;
}

/**
 * @req FR-MDE-001
 * @req FR-MDE-009
 */
export function resolveEditorWindowPlacementMode(
  input: EditorWindowPlacementModeInput,
): EditorWindowPlacementMode {
  if (input.isMobile) {
    return { placement: 'stage', usesGeometryCache: false, draggable: false };
  }

  return { placement: 'floating', usesGeometryCache: true, draggable: true };
}
