// Where an editor window opens when nothing has been stored for it.
//
// A window used to open over the terminal it was launched from, sized to that
// terminal's own area. It holds documents opened from several terminals now, so
// there is no single terminal to size it against.
//
// Size and position come from two different boxes, and keeping them apart is
// the whole subject of this module. The ratio is taken against the viewport,
// because the window is no longer sized against any one terminal's area. The
// centring is done inside the box the window is confined to -- the stage, which
// excludes the sidebar, the header and the tab bar -- because a rect centred in
// the viewport and then confined to a smaller box is not centred any more: it is
// pushed against that box's near edge, which is what the confinement does to
// anything overhanging it.
//
// Nothing here reads the DOM. Both boxes are handed in, which is what lets the
// rule be decided without a browser and keeps each measurement with the caller
// that already knows what it is measuring.
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

/**
 * The box a window is confined to and centred in, in the shape
 * `getBoundingClientRect()` returns: viewport coordinates, `left`/`top` rather
 * than `x`/`y`.
 */
export interface EditorWindowBounds {
  left: number;
  top: number;
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
 * viewport in each axis, confined to `bounds`, centred in it, and never below
 * `minSize`.
 *
 * The floor wins over both the ratio and the confinement. On a box smaller than
 * the floor that leaves part of the window outside it, which is the side this
 * rule takes: a window shrunk under its own minimum cannot show its title bar,
 * and a window whose title bar is gone cannot be moved back.
 *
 * A measurement that is zero, negative or not a number is treated as no
 * measurement rather than propagated. Layout has not necessarily happened when
 * a window is created, and a rect carrying NaN never reaches the screen.
 *
 * @req FR-MDE-001
 */
export function computeInitialEditorWindowRect(
  viewport: EditorWindowViewport,
  bounds: EditorWindowBounds,
  minSize: EditorWindowMinSize,
): DialogRect {
  const viewportWidth = usableExtent(viewport.width);
  const viewportHeight = usableExtent(viewport.height);
  const boundsWidth = usableExtent(bounds.width);
  const boundsHeight = usableExtent(bounds.height);

  // Ratio first, then confinement, then the floor -- in that order, so the
  // floor is the one that survives all three.
  const width = Math.max(
    minSize.width,
    Math.min(boundsWidth, Math.round(viewportWidth * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO)),
  );
  const height = Math.max(
    minSize.height,
    Math.min(boundsHeight, Math.round(viewportHeight * INITIAL_EDITOR_WINDOW_VIEWPORT_RATIO)),
  );

  const left = usableOrigin(bounds.left);
  const top = usableOrigin(bounds.top);

  return {
    x: left + Math.max(0, Math.round((boundsWidth - width) / 2)),
    y: top + Math.max(0, Math.round((boundsHeight - height) / 2)),
    width,
    height,
  };
}

function usableExtent(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function usableOrigin(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
