// Scroll position of an explorer tab comes back by anchor — the name of the top
// visible row — never by pixels (FR-FEX-003 AC-8). Pixel offsets depend on row
// height, font and window size, none of which survive a reload reliably.
//
// The rule every function here serves: a restore that could not find its anchor
// must not write its fallback back into storage. Doing so turns a late paint
// into permanent loss of the user's position (Orca STA-5949).
import type { DirectoryEntry } from '../../types/index.ts';
import { compareListRows, type ListSort } from './fileListView.ts';

export type ScrollRestoreDecision =
  | { kind: 'wait' }
  | { kind: 'scroll'; name: string | null; shouldPersist: boolean };

export type RestoreState = 'pending' | 'done' | 'failed';

// Where a row that is gone would have been. Only the name was saved, so this
// can place it only when the view is ordered by name; any other order falls back
// to the first row. The comparison is the list view's own, so the answer agrees
// with what is drawn. The probe is typed as a file because the missing row's
// type was not saved; in a directories-first order it lands among the files.
// @req FR-FEX-003
export function nearestName(rows: readonly DirectoryEntry[], missingName: string, sort: ListSort | null): string | null {
  if (rows.length === 0) return null;
  if (sort === null || sort.key !== 'name') return rows[0].name;
  const probe: DirectoryEntry = { name: missingName, type: 'file', size: 0, modified: '' };
  const after = rows.find((row) => compareListRows(row, probe, sort) > 0);
  // Past the last row the closest one is the last row, not the first.
  return (after ?? rows[rows.length - 1]).name;
}

// visibleRows is the whole listing in display order, not only the rows on screen:
// with a windowed list an anchor that is loaded but off screen must still count
// as found, or the restore would fall back and never reach it.
// rowCount is what is observed in the list, not what is in state: a listing can
// be loaded before anything is painted, and a scroll written then is clamped to
// 0 by the browser without an error.
// @req FR-FEX-003
export function decideScrollRestore(input: {
  rowCount: number;
  anchorName: string | null;
  visibleRows: readonly DirectoryEntry[];
  sort: ListSort | null;
}): ScrollRestoreDecision {
  if (input.rowCount === 0) return { kind: 'wait' };
  const { anchorName, visibleRows, sort } = input;
  if (anchorName !== null && visibleRows.some((row) => row.name === anchorName)) {
    return { kind: 'scroll', name: anchorName, shouldPersist: true };
  }
  const name = anchorName === null ? (visibleRows[0]?.name ?? null) : nearestName(visibleRows, anchorName, sort);
  return { kind: 'scroll', name, shouldPersist: false };
}

// Gate for every anchor write from a scroll event. Before the restore has run the
// top row is not the user's choice; a programmatic scroll (the restore's own
// fallback) fires scroll events too and must not save through that back door;
// and without rows there is no top row name to save.
// @req FR-FEX-003
export function decideAnchorPersist(input: {
  restoreState: RestoreState;
  userInitiated: boolean;
  rowCount: number;
}): 'save' | 'skip' {
  return input.restoreState !== 'pending' && input.userInitiated && input.rowCount > 0 ? 'save' : 'skip';
}
