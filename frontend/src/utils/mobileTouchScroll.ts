// FR-ARCH-008: where a one-finger vertical drag on a mobile terminal goes.
//
// A desktop wheel moves the scrollback only when the screen has scrollback and the program does
// not track the mouse; otherwise xterm turns it into arrow keys (alternate screen) or a wheel
// report (mouse tracking). A pan that only moves the scrollback does nothing in a full-screen
// program, so it follows the same split and hands the rest to xterm as wheel events.

export type MobilePanRoute = 'scrollback' | 'wheel';

export function routeMobilePan(state: { bufferType: string; mouseTrackingMode: string }): MobilePanRoute {
  return state.bufferType === 'normal' && state.mouseTrackingMode === 'none' ? 'scrollback' : 'wheel';
}

/**
 * Line-mode wheel deltaY values for `rowDelta` rows dragged: one step per row, and a finger moving
 * down (positive rows) reads earlier content, which is a wheel moving up.
 */
export function panWheelSteps(rowDelta: number): number[] {
  const count = Math.abs(Math.trunc(rowDelta));
  return Array.from({ length: count }, () => (rowDelta > 0 ? -1 : 1));
}
