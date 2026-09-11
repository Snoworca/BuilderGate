// Which of `Rnd`'s drag reports is a move the user made.
//
// `Rnd` reports a drag stop for a press on its handle even when nothing moved,
// and for the editor window that handle is the title bar -- so every press of
// 저장, 최대화 and 최소화 produces one. The report carries the rect the window
// already had.
//
// That matters because a host reads an arriving rect as "the user placed this
// window by hand", which is what turns the placement `floating`. A press of
// 최대화 therefore went to `stage` and came straight back, and the button
// appeared to do nothing from the second press onwards.
//
// @req FR-MDE-001

import type { DialogRect } from './types';

/**
 * Whether `next` differs from `previous` in any field.
 *
 * Compared field by field rather than by identity: `Rnd` hands back a fresh
 * object each time, so an identity check would call every report a move and
 * change nothing.
 *
 * A single pixel counts. A drag that moved the window by one pixel is still the
 * user placing it, and a threshold would be a number nobody chose.
 *
 * A null `previous` answers true: the window has been given nothing to compare
 * against, and swallowing the report would swallow the first placement it ever
 * receives.
 *
 * @req FR-MDE-001
 */
export function isDialogRectMoved(
  previous: DialogRect | null,
  next: DialogRect,
): boolean {
  if (previous === null) {
    return true;
  }

  return previous.x !== next.x
    || previous.y !== next.y
    || previous.width !== next.width
    || previous.height !== next.height;
}
