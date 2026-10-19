/**
 * FR-ARCH-010: on a touch screen the terminal input is focused only by a short
 * tap. iOS Safari opens the on-screen keyboard for any focus() made during a
 * touch, so focusing on pointerdown opened the keyboard at the start of every
 * scroll, pinch and long press.
 */

/** A contact that moves farther than this is a pan, not a tap. */
export const TOUCH_TAP_MOVE_TOLERANCE_PX = 10;

export interface TouchPointLike {
  clientX: number;
  clientY: number;
}

export interface TouchTapTracker {
  touchStart(touches: ArrayLike<TouchPointLike>): void;
  touchMove(touches: ArrayLike<TouchPointLike>): void;
  /** The long-press menu fired for the current contact. */
  longPress(): void;
  /** Whether the current contact is still a tap, without consuming it. */
  isTap(): boolean;
  /** Whether the last contact was a tap. A tap is reported once. */
  consumeTap(): boolean;
}

export function shouldFocusTerminalOnPointerDown(pointerType: string | undefined): boolean {
  return pointerType !== 'touch';
}

export function createTouchTapTracker(tolerancePx: number = TOUCH_TAP_MOVE_TOLERANCE_PX): TouchTapTracker {
  let start: TouchPointLike | null = null;
  let disqualified = false;

  return {
    touchStart(touches) {
      if (touches.length === 1) {
        start = { clientX: touches[0].clientX, clientY: touches[0].clientY };
        disqualified = false;
        return;
      }
      disqualified = true;
    },
    touchMove(touches) {
      if (!start || disqualified) return;
      if (touches.length !== 1) {
        disqualified = true;
        return;
      }
      const dx = touches[0].clientX - start.clientX;
      const dy = touches[0].clientY - start.clientY;
      if (Math.hypot(dx, dy) > tolerancePx) {
        disqualified = true;
      }
    },
    longPress() {
      disqualified = true;
    },
    isTap() {
      return start !== null && !disqualified;
    },
    consumeTap() {
      const tap = start !== null && !disqualified;
      start = null;
      disqualified = false;
      return tap;
    },
  };
}
