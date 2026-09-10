// Where an editor window opens when nothing has been stored for it.
//
// A window used to open over the terminal it was launched from, sized to that
// terminal's own area. It holds documents opened from several terminals now, so
// there is no single terminal to size it against and it opens against the
// viewport instead.
//
// Nothing here reads the DOM. The viewport is handed in, which is what lets the
// rule be decided without a browser and keeps the measurement in one place --
// the caller that already knows which window object it is measuring.
// @req FR-MDE-001

import type { DialogRect } from '../dialog/types';

/**
 * The share of the viewport a window opens at, in each axis. Stated once so the
 * rule and whatever quotes it cannot drift into two different sevenths.
 * @req FR-MDE-001
 */
export const INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO = 0.7;

/** A measured viewport, in the shape `window.innerWidth`/`innerHeight` give. */
export interface EditorWindowViewport {
  width: number;
  height: number;
}

/** The floor a window is not opened below, in the shape `Rnd` takes it. */
export interface EditorWindowMinSize {
  width: number;
  height: number;
}

/**
 * The rect a window opens at: `INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO` of the
 * viewport in each axis, centred, and never below `minSize`.
 *
 * The floor wins over the centring rather than the other way round. On a
 * viewport narrower than the floor that leaves part of the window off screen,
 * which is the side this rule takes: a window shrunk under its own minimum
 * cannot show its title bar, and a window whose title bar is gone cannot be
 * moved back.
 *
 * A viewport that is zero, negative or not a number is treated as no
 * measurement at all rather than propagated. Layout has not necessarily
 * happened when a window is created, and a rect carrying NaN never reaches the
 * screen.
 *
 * @req FR-MDE-001
 */
export function computeInitialEditorWindowRect(
  viewport: EditorWindowViewport,
  minSize: EditorWindowMinSize,
): DialogRect {
  const available = {
    width: usableExtent(viewport.width),
    height: usableExtent(viewport.height),
  };

  const width = Math.max(
    minSize.width,
    Math.round(available.width * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO),
  );
  const height = Math.max(
    minSize.height,
    Math.round(available.height * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO),
  );

  return {
    x: Math.max(0, Math.round((available.width - width) / 2)),
    y: Math.max(0, Math.round((available.height - height) / 2)),
    width,
    height,
  };
}

function usableExtent(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
