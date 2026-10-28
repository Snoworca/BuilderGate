// The server skips a resize to the size the PTY already has, so a program that
// drew itself for a different size is never told to draw again; a screen repair
// only resends what it drew. Shrinking the PTY by one row and putting it back
// gives it a real SIGWINCH at its real size (#145).
import type { GridRepairReason } from './TerminalView';

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

/** Time between the shrink and the restore, so the program sees two size changes. */
export const REDRAW_NUDGE_GAP_MS = 200;

// @req REL-BGSTAB-047
export function planRedrawNudge(reason: GridRepairReason, geometry: TerminalGeometry): TerminalGeometry[] {
  if (reason === 'resize') return [];
  if (geometry.rows <= 2) return [];
  return [
    { cols: geometry.cols, rows: geometry.rows - 1 },
    { cols: geometry.cols, rows: geometry.rows },
  ];
}

/** Where a visible terminal is shown; null while it is hidden. */
export type TerminalSurface = 'grid' | 'tab' | null;

// A terminal that comes back from behind another tab already has its size.
// Nudging it made the program redraw twice on every tab switch, which looked
// like the screen jumping up and down; it is nudged only when another screen or
// device resized the PTY while it was hidden, so the program may have drawn for
// another size.
// @req REL-BGSTAB-058
export function shouldRepairOnSurfaceChange(
  next: TerminalSurface,
  was: TerminalSurface,
  shownInTabBefore: boolean,
  resizedElsewhere: boolean,
): boolean {
  if (!next || next === was) return false;
  if (next === 'tab' && was === null && shownInTabBefore) return resizedElsewhere;
  return true;
}

// A terminal that stayed visible while another window resized the PTY never
// becomes visible again; going back to its window is its return.
// @req REL-BGSTAB-058
export function shouldRepairOnWindowReturn(
  terminalVisible: boolean,
  pageVisible: boolean,
  resizedElsewhere: boolean,
): boolean {
  return terminalVisible && pageVisible && resizedElsewhere;
}

/** Whether a redraw resizes the PTY always, or only after a resize elsewhere. */
export type RedrawNudgePolicy = 'always' | 'if-resized-elsewhere';

// @req REL-BGSTAB-058
export function shouldSendRedrawNudge(policy: RedrawNudgePolicy, resizedElsewhere: boolean): boolean {
  return policy === 'always' || resizedElsewhere;
}

/** How many of its own recent resizes a terminal remembers. */
export const SENT_SIZE_MEMORY = 4;

// The server reports every real PTY size change to every view of the session,
// this one included. A reported size this terminal did not send recently came
// from another screen or device.
// @req REL-BGSTAB-058
export function rememberSentSize(
  sent: readonly TerminalGeometry[],
  size: TerminalGeometry,
): TerminalGeometry[] {
  const others = sent.filter(entry => entry.cols !== size.cols || entry.rows !== size.rows);
  return [...others, { cols: size.cols, rows: size.rows }].slice(-SENT_SIZE_MEMORY);
}

// @req REL-BGSTAB-058
export function isResizeFromElsewhere(
  reported: TerminalGeometry,
  sent: readonly TerminalGeometry[],
): boolean {
  return !sent.some(entry => entry.cols === reported.cols && entry.rows === reported.rows);
}
