// The one position and size every editor window opens at.
//
// Global rather than per workspace: what was asked for is a single cached
// placement, and a key named after a workspace cannot be that. Every
// workspace's window opens at the same rect, and dragging any of them moves
// where they all open next time.
//
// Separate from the dialog geometry store, whose read path finishes with
// `clampDialogRect` -- the function that lowers the minimum-size floor to the
// viewport when the viewport is the smaller of the two. Reading through it
// would hand back a window too small to show its own title bar, and a window
// whose title bar is gone cannot be dragged or resized back. That function is
// left alone because six other dialogs depend on it; this cache clamps its own
// way instead.
//
// Nothing here reads the DOM. The viewport and the store are handed in, so the
// rules are decidable without a browser.
// @req FR-MDE-009

import type { DialogRect } from '../dialog/types';

/**
 * The single key the cache lives under.
 *
 * Prefixed like the dialog store's own keys so the two read as siblings, and
 * named for the editor window rather than for a dialog id, because the id now
 * varies by workspace while this value does not.
 * @req FR-MDE-009
 */
export const EDITOR_WINDOW_GEOMETRY_KEY = 'buildergate.editor-window.geometry';

/** A measured viewport, in the shape `window.innerWidth`/`innerHeight` give. */
export interface EditorWindowViewportSize {
  width: number;
  height: number;
}

/** The floor a window is not restored below. */
export interface EditorWindowFloor {
  width: number;
  height: number;
}

/**
 * The cached rect, confined to `viewport` and never below `minSize`, or null
 * when nothing usable is stored.
 *
 * Null rather than a default, so the caller can tell "never placed" from
 * "placed here" and compute an opening placement for the first case. A default
 * returned from here would make those two indistinguishable.
 *
 * Malformed values read as null rather than throwing. The store is readable and
 * writable by the user, holds values written by older builds, and can be caught
 * half-written; none of that should stop a window from opening.
 * @req FR-MDE-009
 */
export function readEditorWindowGeometry(
  viewport: EditorWindowViewportSize,
  minSize: EditorWindowFloor,
  storage: Storage,
): DialogRect | null {
  const stored = parseRect(readRaw(storage));
  if (stored === null) {
    return null;
  }

  // Size first, then position. A window wider than the viewport has no position
  // at which it fits, so moving it alone would leave it overhanging.
  const width = Math.max(minSize.width, Math.min(stored.width, usable(viewport.width)));
  const height = Math.max(minSize.height, Math.min(stored.height, usable(viewport.height)));

  return {
    x: confine(stored.x, width, usable(viewport.width)),
    y: confine(stored.y, height, usable(viewport.height)),
    width,
    height,
  };
}

/**
 * Records where the window is now. Called when a drag or a resize settles,
 * which is what makes the cache follow what the user arranged rather than every
 * frame of the arranging.
 *
 * A store that refuses the write is survived: the window keeps the rect it has,
 * and the next one opens at its computed placement.
 * @req FR-MDE-009
 */
export function writeEditorWindowGeometry(rect: DialogRect, storage: Storage): void {
  try {
    storage.setItem(EDITOR_WINDOW_GEOMETRY_KEY, JSON.stringify({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }));
  } catch {
    // Private browsing refuses writes. Nothing here is worth failing an edit
    // over.
  }
}

function readRaw(storage: Storage): string | null {
  try {
    return storage.getItem(EDITOR_WINDOW_GEOMETRY_KEY);
  } catch {
    return null;
  }
}

function parseRect(raw: string | null): DialogRect | null {
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (!isFiniteNumber(candidate.x)
    || !isFiniteNumber(candidate.y)
    || !isFiniteNumber(candidate.width)
    || !isFiniteNumber(candidate.height)) {
    return null;
  }

  return {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function usable(extent: number): number {
  return Number.isFinite(extent) && extent > 0 ? extent : 0;
}

/**
 * Puts `start` inside `[0, extent - size]`, or at 0 when the window is wider
 * than the box it is being put in. The overhang is deliberate: the floor above
 * has already decided the size, and pushing the origin negative to hide the
 * overhang would take the title bar off the screen with it.
 */
function confine(start: number, size: number, extent: number): number {
  return Math.max(0, Math.min(start, extent - size));
}
