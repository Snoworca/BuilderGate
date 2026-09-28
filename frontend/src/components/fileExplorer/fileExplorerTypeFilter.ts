// FR-FEX-014: type-to-filter (Nautilus / Finder style). Filters only what is already on
// screen — the current directory in list mode, the expanded rows in tree mode — and never
// lists a directory to do it.
import type { VisibleRow } from './fileTreeState.ts';

export interface TypeFilterKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** The filter after a key, and whether the key was consumed (so it goes nowhere else). */
export function applyTypeFilterKey(text: string, event: TypeFilterKey): { text: string; handled: boolean } {
  if (event.ctrlKey || event.metaKey || event.altKey) return { text, handled: false };
  if (event.key === 'Escape') return text === '' ? { text, handled: false } : { text: '', handled: true };
  if (event.key === 'Backspace') return text === '' ? { text, handled: false } : { text: text.slice(0, -1), handled: true };
  // A single printable character. Named keys (Enter, F2, ArrowDown…) are longer than one.
  if ([...event.key].length !== 1) return { text, handled: false };
  if (event.key === ' ' && text === '') return { text, handled: false };
  return { text: text + event.key, handled: true };
}

/** [start, end) of the first case-insensitive occurrence of `text` in `name`, or null. */
export function matchRange(name: string, text: string): [number, number] | null {
  if (text === '') return null;
  const at = name.toLowerCase().indexOf(text.toLowerCase());
  return at < 0 ? null : [at, at + text.length];
}

/**
 * Tree rows that match, plus the visible ancestors that place them. The up row is dropped
 * while a filter is on (it is not a match and would read as one).
 */
export function filterTreeRows(rows: readonly VisibleRow[], text: string): VisibleRow[] {
  if (text === '') return [...rows];
  const keep = new Set<number>();
  // Indices of the rows enclosing the current one, by depth.
  const ancestors: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'node') return;
    ancestors.length = row.depth;
    if (matchRange(row.name, text) !== null) {
      keep.add(index);
      for (const ancestor of ancestors) if (ancestor !== undefined) keep.add(ancestor);
    }
    ancestors[row.depth] = index;
  });
  return rows.filter((_, index) => keep.has(index));
}
