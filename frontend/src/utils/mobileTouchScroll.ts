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
 * FR-ARCH-015: the speed a drag on this route moves at. The scrollback already follows the finger
 * line for line, so only a full-screen program's wheel input takes the browser's scroll speed.
 */
export function mobilePanSpeed(route: MobilePanRoute, speed: number): number {
  return route === 'wheel' ? speed : 1;
}

/**
 * FR-ARCH-015: one move of a drag, scaled by the scroll speed, added to what the drag has not yet
 * spent, and split into whole cell rows and the travel carried to the next move. At speed 1 this is
 * the arithmetic the drag always used. Without a measured cell height nothing moves yet.
 */
export function accumulatePanRows(
  residualPx: number,
  deltaPx: number,
  speed: number,
  cellHeight: number,
): { rows: number; residualPx: number } {
  const travel = residualPx + deltaPx * speed;
  if (cellHeight <= 0) return { rows: 0, residualPx: travel };
  const rows = Math.trunc(travel / cellHeight);
  return { rows, residualPx: travel - rows * cellHeight };
}

/**
 * Line-mode wheel deltaY values for `rowDelta` rows dragged: one step per row, and a finger moving
 * down (positive rows) reads earlier content, which is a wheel moving up.
 */
export function panWheelSteps(rowDelta: number): number[] {
  const count = Math.abs(Math.trunc(rowDelta));
  return Array.from({ length: count }, () => (rowDelta > 0 ? -1 : 1));
}
