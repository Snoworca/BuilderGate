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
