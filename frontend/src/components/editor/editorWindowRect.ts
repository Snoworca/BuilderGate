import type { DialogRect } from '../dialog/types';

/**
 * A rect as the terminal host registry stores it: measured against the runtime
 * overlay that `TerminalRuntimeLayer` renders inside the stage, and carrying
 * `left`/`top` rather than `x`/`y`. `TerminalHostSlot` registers it through
 * `upsertHost`, subtracting the overlay origin as it measures.
 *
 * @req FR-MDE-001
 */
export interface OverlayRelativeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A rect in viewport coordinates, the shape `getBoundingClientRect()` returns.
 * Structurally identical to `OverlayRelativeRect`, and deliberately named apart
 * from it: what separates the two is which origin they are measured against,
 * and that is the whole subject of this module.
 *
 * @req FR-MDE-001
 */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The viewport origin of the runtime overlay, read from its own
 * `getBoundingClientRect()`. Passed in rather than derived from the stage,
 * because the registry's coordinates are relative to the overlay and only the
 * overlay can say where it is.
 *
 * @req FR-MDE-001
 */
export interface ViewportOrigin {
  left: number;
  top: number;
}

/**
 * The rect a `docked` window occupies: the terminal rect the registry holds for
 * that tab, carried into viewport coordinates.
 *
 * The translation is what a portal makes necessary. A window surface is
 * appended to `document.body`, so its absolute position resolves against the
 * viewport, while the registry hands out coordinates relative to the overlay.
 * Skipping the addition would offset every docked window by the stage's own
 * position, which on the desktop layout is the width of the sidebar.
 *
 * The size is carried across untouched. The registered rect is the terminal
 * area alone and already excludes the path bar below it, so a window that fits
 * that rect exactly leaves the bar reachable.
 *
 * @req FR-MDE-001
 */
export function toDockedRect(
  hostRect: OverlayRelativeRect,
  overlayOrigin: ViewportOrigin,
): DialogRect {
  return {
    x: hostRect.left + overlayOrigin.left,
    y: hostRect.top + overlayOrigin.top,
    width: hostRect.width,
    height: hostRect.height,
  };
}

/**
 * The rect a `stage` window occupies: the measured stage container, unchanged.
 *
 * The container already excludes the sidebar, the header and the tab bar, so
 * this restates none of those three widths. They live in three different files
 * with no shared variable, and a copy here would keep whichever value the
 * layout moved away from. Nothing is remembered between calls either — the
 * caller remeasures on resize and the new rect has to come straight back out.
 *
 * @req FR-MDE-001
 */
export function toStageRect(stageRect: ViewportRect): DialogRect {
  return {
    x: stageRect.left,
    y: stageRect.top,
    width: stageRect.width,
    height: stageRect.height,
  };
}

/**
 * Confines a requested rect to the stage. This is the boundary a `floating`
 * window is dragged and resized against, and it is the stage rather than the
 * viewport so a window cannot be pushed over the sidebar, the header or the
 * tab bar.
 *
 * The boundary is taken as a `DialogRect`, which is what `toStageRect` returns,
 * rather than as a measured `ViewportRect`. The two rect shapes here are
 * structurally identical and would be silently interchangeable; requiring the
 * converted form means handing a registry rect in as the boundary — clamping
 * the window against a box anchored at the viewport origin, which is the exact
 * failure this function exists to prevent — does not compile.
 *
 * A request that already fits comes back with its position untouched, so a
 * drag inside the stage moves the window by exactly the distance asked for.
 *
 * Size is clamped before position because containment cannot otherwise be
 * honoured: a window wider than the stage — which happens when the stage
 * shrinks under a window sized against a larger one — has no position at which
 * it fits, and moving it alone would leave it overhanging whatever sits beside
 * the stage.
 *
 * A stage measuring zero collapses the window to nothing rather than falling
 * back to a minimum size. That case belongs to the caller, which withholds
 * placement while the target has no area, and the minimum size itself belongs
 * to the cascade; taking it on here would split one rule across two modules.
 *
 * @req FR-MDE-001
 */
export function clampToStage(requested: DialogRect, stageBounds: DialogRect): DialogRect {
  const width = Math.min(requested.width, stageBounds.width);
  const height = Math.min(requested.height, stageBounds.height);

  return {
    x: clamp(requested.x, stageBounds.x, stageBounds.x + stageBounds.width - width),
    y: clamp(requested.y, stageBounds.y, stageBounds.y + stageBounds.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
