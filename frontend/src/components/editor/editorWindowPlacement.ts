import type { DialogRect } from '../dialog/types';

/**
 * The placement axis of an editor window. `minimized` is deliberately absent:
 * hiding is a separate axis that leaves the placement untouched, so a window
 * that is un-hidden returns to whichever of these three it was in.
 *
 * @req FR-MDE-001
 */
export type EditorWindowPlacement = 'docked' | 'stage' | 'floating';

/**
 * `placementBeforeStage` is written only on entry into `stage`, which is what
 * gives 최대화 a defined destination from every one of the three states.
 * `floatingRect` is the only rect this module holds: `docked` and `stage` are
 * both computed from measurements taken elsewhere.
 *
 * @req FR-MDE-001
 */
export interface EditorWindowPlacementState {
  placement: EditorWindowPlacement;
  placementBeforeStage: EditorWindowPlacement | null;
  floatingRect: DialogRect | null;
}

/**
 * A window opens `docked`, so that is the default. `floating` is not offered
 * here on purpose: a floating window is nothing without the rect it floats at,
 * and this factory has no rect to give it. `enterFloating` is the entry point
 * that takes one, so the rect-less floating state cannot be built at all.
 * No transition in this module reads the DOM — every rect is handed in.
 *
 * @req FR-MDE-001
 */
export function createEditorWindowPlacementState(
  placement: Exclude<EditorWindowPlacement, 'floating'> = 'docked',
): EditorWindowPlacementState {
  return { placement, placementBeforeStage: null, floatingRect: null };
}

/**
 * 최대화. Outside `stage` this records where the window came from and goes to
 * `stage`; inside it, it returns to what was recorded, or to `docked` when the
 * window was restored straight into `stage` and there is nothing recorded.
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
    placement: state.placementBeforeStage ?? 'docked',
    placementBeforeStage: null,
  };
}

/**
 * 터미널 채움. The destination does not depend on where the window was, so this
 * changes the placement and clears the stage record and nothing else — the
 * floating rect is left alone because no criterion asks for it to be dropped.
 *
 * @req FR-MDE-001
 */
export function fillTerminal(
  state: EditorWindowPlacementState,
): EditorWindowPlacementState {
  return { ...state, placement: 'docked', placementBeforeStage: null };
}

/**
 * Whether 터미널 채움 renders disabled. A window already covering its terminal
 * has nowhere to go, and a control that does nothing should not look pressable.
 *
 * @req FR-MDE-001
 */
export function isTerminalFillDisabled(state: EditorWindowPlacementState): boolean {
  return state.placement === 'docked';
}

/**
 * A drag or a resize. `rect` is the rect the window occupies at the moment the
 * interaction starts — computed for `docked` and `stage`, already stored for a
 * window that is being dragged again — and it becomes the floating rect
 * unchanged, so the window does not jump under the pointer. The record is
 * cleared because it only ever describes what `stage` was entered from.
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
