// Where the phone's fill-screen messenger window goes while the keyboard is up.
// @req FR-MSG-013

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisibleViewport {
  offsetTop: number;
  height: number;
  scale: number;
}

/** A zoom other than 1 means the user is pinch-zooming; the window stays as it is. */
const SCALE_EPSILON = 0.01;

/**
 * FR-MSG-013 AC-6: iOS keeps the layout as tall as the screen when the keyboard
 * opens and pans the visible part instead, so a window as tall as the screen runs
 * under the keyboard. With the keyboard up the window spans the visible part:
 * from its top (never above the window layer, which in the home-screen app starts
 * below the status bar) to the keyboard. Rects are relative to the window layer,
 * whose top is `layerTop` in layout-viewport pixels. Pure.
 */
export function keyboardViewportRect(
  screen: { width: number; height: number },
  visible: VisibleViewport | null,
  layerTop: number,
  keyboardUp: boolean,
): ViewportRect {
  const whole = { x: 0, y: 0, width: screen.width, height: screen.height };
  if (!keyboardUp || visible === null || Math.abs(visible.scale - 1) > SCALE_EPSILON) return whole;
  const top = Math.max(visible.offsetTop, layerTop);
  const bottom = Math.min(visible.offsetTop + visible.height, layerTop + screen.height);
  if (bottom <= top) return whole;
  return { x: 0, y: Math.round(top - layerTop), width: screen.width, height: Math.round(bottom - top) };
}
