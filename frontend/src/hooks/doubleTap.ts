// Two touch taps in quick succession (FR-UIDS-013): the touch spelling of a right click
// wherever a long press opens a menu. A long press on Android summons the assistant, so the
// menu is also reachable this way.
// @req FR-UIDS-013

export const DOUBLE_TAP_WINDOW_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;

export interface TapPoint {
  x: number;
  y: number;
  at: number;
}

export interface DoubleTapDetector {
  /** A short tap ended here; true when it completes a double tap (the pair is then consumed). */
  tap: (point: TapPoint) => boolean;
  reset: () => void;
}

export function createDoubleTapDetector(windowMs = DOUBLE_TAP_WINDOW_MS, slopPx = DOUBLE_TAP_SLOP_PX): DoubleTapDetector {
  let last: TapPoint | null = null;
  return {
    tap(point) {
      const previous = last;
      if (previous !== null
        && point.at - previous.at <= windowMs
        && Math.hypot(point.x - previous.x, point.y - previous.y) <= slopPx) {
        last = null;
        return true;
      }
      last = point;
      return false;
    },
    reset() {
      last = null;
    },
  };
}

/** The fields a React or native touchend carries that the detector needs. */
export interface TouchEndLike {
  changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  timeStamp?: number;
}

export function tapPointOf(event: TouchEndLike | undefined, now: number): TapPoint | null {
  const touch = event?.changedTouches?.[0];
  if (touch === undefined) return null;
  return { x: touch.clientX, y: touch.clientY, at: now };
}

/**
 * FR-UIDS-013 AC-5: the first tap of a double tap on a terminal focuses it and so raises the
 * on-screen keyboard; the menu the second tap opens should not sit above a keyboard.
 */
export function dismissSoftKeyboard(doc: Document = document): void {
  const active = doc.activeElement;
  if (active instanceof HTMLElement && active !== doc.body) active.blur();
}
