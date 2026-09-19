import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

/**
 * Issue #16 item 3/4: a terminal selection's identity keyed to raw
 * coordinates ("same epoch+geometry") does not survive a scrollback shift
 * with any meaning -- the row at index N before a trim/insert/delete is not
 * the row at index N after. xterm's own `registerMarker` DOES track a single
 * absolute buffer row through trim, insert, delete, and (measured directly
 * before this module was written) column-resize reflow.
 *
 * Marker liveness is necessary but not sufficient, though. Measured
 * separately: `term.clear()` and `ESC[2J`/`ESC[3J` correctly dispose a
 * marker pointing at erased content (they route through the same
 * onDelete/onTrim path normal edits use), but `term.reset()` (RIS) does not
 * -- the marker survives with `isDisposed: false` while its content silently
 * becomes empty. And `term.dispose()` does not dispose markers either: a
 * marker from a torn-down terminal will happily keep reporting a `.line`
 * that, if read against a DIFFERENT (newer) Terminal instance's buffer,
 * returns whatever unrelated content occupies that row index there -- with
 * no signal that anything is wrong.
 *
 * A THIRD gap, measured 2026-09-19 by the goldens lane
 * (terminalSelectionLifecycleCharacterization.test.ts) and confirmed here
 * directly against this module: a column resize that reflows repoints
 * xterm's OWN selection while leaving its coordinates untouched -- widening
 * a terminal can unwrap a line above the selection, shifting every row below
 * up by one, and `getSelectionPosition()` keeps reporting the SAME
 * start/end row even though a different logical line is now there. The
 * marker tracks the real content correctly (that survival is what makes the
 * bug easy to miss); the selection does not. So a content re-check at the
 * marker's own row alone cannot see this: it would find the anchored
 * content exactly where the marker says it is and report valid, while a
 * copy right now would read the SELECTION's stale coordinates and return
 * something else entirely. `verify()` therefore takes the CURRENT live
 * selection position as an input and checks it against the marker's
 * tracked position before trusting anything else.
 *
 * `verify()` checks four independent things, in order: the terminal
 * generation the anchor was captured against (catches instance replacement,
 * which marker state alone cannot), marker disposal (catches structural
 * removal), whether the live selection still points at the marker's tracked
 * row/col (catches reflow repointing, which marker state alone cannot), and
 * a content re-check at the marker's current line (catches the reset()-class
 * gap where bookkeeping does not notice but the content did change).
 *
 * This module deliberately does not call `term.getSelectionPosition()`
 * itself. That call needs a live `_selectionService`, which only exists
 * after `Terminal.open()` attaches to a real DOM element -- buffer and
 * marker mechanics do not. Taking `position` as a parameter keeps every
 * predicate here testable headless against a real `@xterm/xterm` Terminal,
 * and it is also the right split for the caller: `TerminalView.tsx` already
 * has to call `getSelectionPosition()` to build today's `rangeKey`, and it
 * is the one place that can be sure the position is genuinely current.
 *
 * Scope: this is same-session identity only. Markers are objects on one
 * live `Terminal` and do not survive a reload -- this does not touch issue
 * #16 item 7's cross-refresh half, which is separately gated on item 6 /
 * REL-BGSTAB-026.
 */

export interface SelectionAnchorPosition {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface SelectionAnchor {
  /** The view/terminal generation this anchor was captured against. */
  viewGeneration: number;
  startMarker: IMarker;
  endMarker: IMarker;
  startCol: number;
  endCol: number;
  /** Content at the start boundary, from startCol to end of that row, at capture time. */
  originStartText: string;
  /** Content at the end boundary, from 0 to endCol on that row, at capture time. */
  originEndText: string;
}

export type SelectionAnchorStaleReason =
  | 'generation-mismatch'
  | 'markers-disposed'
  | 'no-live-selection'
  | 'selection-repositioned'
  | 'content-mismatch';

export type SelectionAnchorVerdict =
  | { valid: true }
  | { valid: false; reason: SelectionAnchorStaleReason };

type MarkerCapableTerminal = Pick<Terminal, 'registerMarker'> & { buffer: { active: IBuffer } };
type BufferCapableTerminal = { buffer: { active: IBuffer } };

function readBoundaryText(buffer: IBuffer, row: number, fromCol: number, toCol?: number): string {
  const line = buffer.getLine(row);
  if (!line) {
    return '';
  }
  return line.translateToString(false, fromCol, toCol);
}

/**
 * Registers marker(s) for a captured selection position and snapshots the
 * boundary content. Returns null if xterm refused to register a marker
 * (e.g. the alt buffer was active when this was called against an
 * already-active-alt-buffer -- registerMarker still returns a real marker
 * in that case per measurement, so this is a defensive fallback rather than
 * an observed failure mode).
 */
export function captureSelectionAnchor(
  term: MarkerCapableTerminal,
  viewGeneration: number,
  position: SelectionAnchorPosition,
): SelectionAnchor | null {
  const active = term.buffer.active;
  const absoluteCursorRow = active.baseY + active.cursorY;

  const startMarker = term.registerMarker(position.start.y - absoluteCursorRow);
  if (!startMarker) {
    return null;
  }

  const sameRow = position.start.y === position.end.y;
  const endMarker = sameRow ? startMarker : term.registerMarker(position.end.y - absoluteCursorRow);
  if (!endMarker) {
    if (!startMarker.isDisposed) {
      startMarker.dispose();
    }
    return null;
  }

  const originStartText = sameRow
    ? readBoundaryText(active, position.start.y, position.start.x, position.end.x)
    : readBoundaryText(active, position.start.y, position.start.x);
  const originEndText = sameRow
    ? originStartText
    : readBoundaryText(active, position.end.y, 0, position.end.x);

  return {
    viewGeneration,
    startMarker,
    endMarker,
    startCol: position.start.x,
    endCol: position.end.x,
    originStartText,
    originEndText,
  };
}

export function verifySelectionAnchor(
  anchor: SelectionAnchor,
  term: BufferCapableTerminal,
  currentViewGeneration: number,
  currentSelectionPosition: SelectionAnchorPosition | null | undefined,
): SelectionAnchorVerdict {
  // Checked first and independently of marker state: a marker survives its
  // owning terminal's dispose() untouched (measured), so marker-only checks
  // cannot detect that the terminal itself was replaced.
  if (anchor.viewGeneration !== currentViewGeneration) {
    return { valid: false, reason: 'generation-mismatch' };
  }

  if (anchor.startMarker.isDisposed || anchor.endMarker.isDisposed) {
    return { valid: false, reason: 'markers-disposed' };
  }

  if (!currentSelectionPosition) {
    return { valid: false, reason: 'no-live-selection' };
  }

  // THE REFLOW CHECK. A copy reads the SELECTION, not the marker, so an
  // anchor that only vouches for its own bookkeeping is not enough -- it has
  // to confirm the selection has not quietly drifted off the row/col the
  // marker says the anchored content actually lives at now.
  if (
    currentSelectionPosition.start.y !== anchor.startMarker.line
    || currentSelectionPosition.end.y !== anchor.endMarker.line
    || currentSelectionPosition.start.x !== anchor.startCol
    || currentSelectionPosition.end.x !== anchor.endCol
  ) {
    return { valid: false, reason: 'selection-repositioned' };
  }

  const active = term.buffer.active;
  const sameRow = anchor.startMarker.line === anchor.endMarker.line;
  const currentStartText = sameRow
    ? readBoundaryText(active, anchor.startMarker.line, anchor.startCol, anchor.endCol)
    : readBoundaryText(active, anchor.startMarker.line, anchor.startCol);
  const currentEndText = sameRow
    ? currentStartText
    : readBoundaryText(active, anchor.endMarker.line, 0, anchor.endCol);

  if (currentStartText !== anchor.originStartText || currentEndText !== anchor.originEndText) {
    return { valid: false, reason: 'content-mismatch' };
  }

  return { valid: true };
}

export function disposeSelectionAnchor(anchor: SelectionAnchor | null | undefined): void {
  if (!anchor) {
    return;
  }
  if (!anchor.startMarker.isDisposed) {
    anchor.startMarker.dispose();
  }
  if (anchor.endMarker !== anchor.startMarker && !anchor.endMarker.isDisposed) {
    anchor.endMarker.dispose();
  }
}
