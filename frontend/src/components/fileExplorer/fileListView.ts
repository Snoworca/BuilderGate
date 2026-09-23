// Pure view model behind the explorer's list mode. Kept free of React so the
// column set, the sort rule and the "no row cap" rule are testable without a DOM.
//
// The list shows every direct child of the root at once and leaves windowing to
// the renderer: the server already caps a listing (maxDirectoryEntries), so a
// second cap here would silently hide entries the user asked to see.
import type { DirectoryEntry } from '../../types/index.ts';
import type { FileTreeState } from './fileTreeState.ts';

// No type column: the extension is already part of the name.
export const LIST_COLUMNS = ['name', 'modified', 'size'] as const;

export type ListColumn = (typeof LIST_COLUMNS)[number];
export type ListSortDir = 'asc' | 'desc';
export interface ListSort {
  key: ListColumn;
  dir: ListSortDir;
}

export type ListRow = Pick<DirectoryEntry, ListColumn>;

// Built field by field so a new DirectoryEntry field never becomes a cell without
// a column to draw it in.
export function toListRow(entry: DirectoryEntry): ListRow {
  return { name: entry.name, modified: entry.modified, size: entry.size };
}

// 'ko' collation so Hangul names and case-mixed Latin names order the way a
// Korean user reads them, independent of the browser's default locale. One
// collator for the module: localeCompare with a locale argument builds one per
// comparison, which dominates sorting a large directory.
const NAME_COLLATOR = new Intl.Collator('ko');

function compareByKey(a: DirectoryEntry, b: DirectoryEntry, key: ListColumn): number {
  switch (key) {
    case 'name':
      return NAME_COLLATOR.compare(a.name, b.name);
    // ISO-8601 strings from the server compare chronologically as plain strings.
    case 'modified':
      return a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0;
    case 'size':
      return a.size - b.size;
  }
}

// Directories stay ahead of files in both directions; only the key comparison
// flips on 'desc'. Exported because scroll restore must agree with this order.
export function compareListRows(a: DirectoryEntry, b: DirectoryEntry, sort: ListSort): number {
  const aDir = a.type === 'directory';
  const bDir = b.type === 'directory';
  if (aDir !== bDir) return aDir ? -1 : 1;
  const byKey = compareByKey(a, b, sort.key);
  return sort.dir === 'desc' ? -byKey : byKey;
}

// Always returns a fresh array: the listing is shared state, and a null sort
// means "server order", not "re-sorted by name".
export function sortEntries(entries: readonly DirectoryEntry[], sort: ListSort | null): DirectoryEntry[] {
  const copy = entries.slice();
  if (sort === null) return copy;
  return copy.sort((a, b) => compareListRows(a, b, sort));
}

// Direct children of the root only, never descending into expanded folders. The
// '↑' row is drawn by the renderer outside this list, so it is not a row here.
export function selectListRows(state: FileTreeState, sort: ListSort | null): DirectoryEntry[] {
  const child = state.childrenByPath.get(state.root);
  if (child === undefined || child.status !== 'loaded') return [];
  return sortEntries(child.entries, sort);
}
