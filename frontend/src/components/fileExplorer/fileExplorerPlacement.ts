// How the explorer window is laid out on screen (FR-FEX-028).
//
// On a phone there is no room to float a window beside the terminal, so it
// fills the stage like the editor does (resolveEditorWindowPlacementMode). The
// stored placement is left alone: a window maximized or floated on a desktop
// comes back that way when the layout is a desktop one again. The answers
// travel together because they are one decision -- a window that fills the
// stage cannot be dragged, and one that cannot be dragged writes no geometry.
// @req FR-FEX-028

import type { EditorWindowPlacement } from '../editor/editorWindowPlacement.ts';

export interface FileExplorerWindowLayoutInput {
  /** The mobile layout is being rendered, as `useResponsive` reports it. */
  isMobile: boolean;
  /** The placement the window record holds. */
  placement: EditorWindowPlacement;
}

export interface FileExplorerWindowLayout {
  /** The window takes the stage's rect. */
  fillsStage: boolean;
  /** The window can be moved and resized by hand (and so persists geometry). */
  movable: boolean;
  /** The title bar shows the 최대화 toggle; on a phone it would do nothing. */
  showMaximizeToggle: boolean;
}

export function resolveFileExplorerWindowLayout(input: FileExplorerWindowLayoutInput): FileExplorerWindowLayout {
  const fillsStage = input.isMobile || input.placement === 'stage';
  return { fillsStage, movable: !fillsStage, showMaximizeToggle: !input.isMobile };
}
