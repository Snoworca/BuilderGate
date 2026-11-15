/**
 * FR-ARCH-010: on a touch screen the terminal input is focused only by a short
 * tap. iOS Safari opens the on-screen keyboard for any focus() made during a
 * touch, so focusing on pointerdown opened the keyboard at the start of every
 * scroll, pinch and long press.
 */

import { cellAtPoint } from './terminalPathDetection.ts';

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

/**
 * FR-ARCH-010 AC-8: how many rows above or below the cursor row a tap still lands on the
 * input line. Claude Code draws its prompt inside a box, so the border rows count too.
 */
export const INPUT_LINE_TAP_ROWS = 1;

export interface TerminalTapRows {
  /** The tapped row, counted from the top of the visible screen. */
  tapRow: number;
  /** The cursor row, counted the same way (it may fall outside the screen). */
  cursorRow: number;
}

/**
 * FR-ARCH-010 AC-8: whether a short tap opens the system keyboard. A program that tracks
 * the mouse (Claude Code in full-screen mode) takes taps as clicks, and xterm focuses its
 * input on the same mousedown, so every tap on a choice raised the keyboard. With the
 * keyboard down, only a tap on the input line (near the cursor) opens it; a tap elsewhere
 * is a click only. With the keyboard up nothing changes.
 */
export function shouldTapOpenKeyboard(input: {
  mouseTracking: boolean;
  keyboardUp: boolean;
  rows: TerminalTapRows | null;
}): boolean {
  if (!input.mouseTracking || input.keyboardUp || !input.rows) return true;
  return Math.abs(input.rows.tapRow - input.rows.cursorRow) <= INPUT_LINE_TAP_ROWS;
}

interface TapRowsTerminal {
  cols: number;
  rows: number;
  element?: { querySelector(selector: string): { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } | null } | null;
  buffer: { active: { baseY: number; viewportY: number; cursorY: number } };
}

/** FR-ARCH-010 AC-8: the tapped row and the cursor row on the visible screen, or null off the screen. */
export function readTerminalTapRows(term: TapRowsTerminal, clientX: number, clientY: number): TerminalTapRows | null {
  const rect = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!rect) return null;
  const cell = cellAtPoint(rect, term.cols, term.rows, clientX, clientY);
  if (!cell) return null;
  const buffer = term.buffer.active;
  return { tapRow: cell.row, cursorRow: buffer.baseY + buffer.cursorY - buffer.viewportY };
}
