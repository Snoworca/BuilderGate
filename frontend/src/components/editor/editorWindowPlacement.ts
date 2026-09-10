import type { DialogRect } from '../dialog/types';

/**
 * The placement axis of an editor window. `minimized` is deliberately absent:
 * hiding is a separate axis that leaves the placement untouched, so a window
 * that is un-hidden returns to whichever of these two it was in.
 *
 * A third member, `docked`, used to place the window over one terminal's area.
 * A window now holds documents opened from several terminals, so there is no
 * single terminal for it to cover, and the member is gone.
 *
 * @req FR-MDE-001
 */
export type EditorWindowPlacement = 'stage' | 'floating';

/**
 * `placementBeforeStage` is written only on entry into `stage`, which is what
 * gives 최대화 a defined destination from both states. `floatingRect` is the
 * only rect this module holds: `stage` is computed from measurements taken
 * elsewhere.
 *
 * @req FR-MDE-001
 */
export interface EditorWindowPlacementState {
  placement: EditorWindowPlacement;
  placementBeforeStage: EditorWindowPlacement | null;
  floatingRect: DialogRect | null;
}

/**
 * A window opens into `stage`, and that is the only state this factory can
 * build. `floating` is not offered here on purpose: a floating window is
 * nothing without the rect it floats at, and this factory has no rect to give
 * it. `enterFloating` is the entry point that takes one, so the rect-less
 * floating state cannot be built at all.
 * No transition in this module reads the DOM — every rect is handed in.
 *
 * @req FR-MDE-001
 */
export function createEditorWindowPlacementState(): EditorWindowPlacementState {
  return { placement: 'stage', placementBeforeStage: null, floatingRect: null };
}

/**
 * 최대화. Outside `stage` this records where the window came from and goes to
 * `stage`; inside it, it returns to what was recorded, or to `floating` when the
 * window opened straight into `stage` and there is nothing recorded.
 * `floatingRect` rides through the detour untouched, so a window maximized out
 * of `floating` finds its own rect again on the way back.
 *
 * @req FR-MDE-001
 */
export function toggleMaximize(
  state: EditorWindowPlacementState,
): EditorWindowPlacementState {
  if (state.placement !== 'stage') {
    return { ...state, placement: 'stage', placementBeforeStage: state.placement };
  }

  return {
    ...state,
    placement: state.placementBeforeStage ?? 'floating',
    placementBeforeStage: null,
  };
}

/**
 * A drag or a resize. `rect` is the rect the window occupies at the moment the
 * interaction starts — computed for `stage`, already stored for a window that is
 * being dragged again — and it becomes the floating rect unchanged, so the
 * window does not jump under the pointer. The record is cleared because it only
 * ever describes what `stage` was entered from.
 *
 * @req FR-MDE-001
 */
export function enterFloating(
  state: EditorWindowPlacementState,
  rect: DialogRect,
): EditorWindowPlacementState {
  return {
    ...state,
    placement: 'floating',
    placementBeforeStage: null,
    floatingRect: { ...rect },
  };
}
