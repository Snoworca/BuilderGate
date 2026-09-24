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
// Openable formats each get their own icon so they read at a glance; the rest
// are grouped by kind, and anything unknown is a plain page.
const FILE_ICON_BY_EXTENSION: Readonly<Record<string, string>> = (() => {
  const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['📝', ['md', 'markdown', 'mdx']],
    ['📃', ['txt']],
    ['🧾', ['json', 'json5']],
    ['🏷️', ['xml', 'html', 'htm', 'svg']],
    ['⚙️', ['yml', 'yaml', 'toml', 'ini']],
    ['🎨', ['css', 'scss']],
    ['💻', ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'hpp', 'go', 'rs', 'sql']],
    ['🐚', ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd']],
    ['🖼️', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']],
    ['📕', ['pdf']],
    ['📦', ['zip', 'tar', 'gz', 'tgz', '7z', 'rar']],
    ['🎵', ['mp3', 'wav', 'flac', 'ogg', 'm4a']],
    ['🎬', ['mp4', 'mov', 'avi', 'mkv', 'webm']],
    ['🔩', ['exe', 'dll', 'so', 'bin', 'msi']],
  ];
  const map: Record<string, string> = {};
  for (const [icon, extensions] of groups) for (const extension of extensions) map[extension] = icon;
  return map;
})();

const GENERIC_FILE_ICON = '📄';

/** The row's icon: a folder that shows whether it is open, or the file's kind. */
export function entryIcon(entry: { name: string; isDirectory: boolean; expanded: boolean }): string {
  if (entry.isDirectory) return entry.expanded ? '📂' : '📁';
  const dot = entry.name.lastIndexOf('.');
  // A leading dot is a hidden file's name ('.gitignore'), not an extension.
  if (dot <= 0) return GENERIC_FILE_ICON;
  return FILE_ICON_BY_EXTENSION[entry.name.slice(dot + 1).toLowerCase()] ?? GENERIC_FILE_ICON;
}

/** Size column text. A folder shows -- as Finder does: its size is not the entry's. */
export function formatEntrySize(entry: Pick<DirectoryEntry, 'type' | 'size'>): string {
  if (entry.type === 'directory') return '--';
  if (entry.size < 1024) return `${entry.size} B`;
  if (entry.size < 1024 * 1024) return `${(entry.size / 1024).toFixed(1)} KB`;
  return `${(entry.size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatEntryModified(modified: string): string {
  const date = new Date(modified);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

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
