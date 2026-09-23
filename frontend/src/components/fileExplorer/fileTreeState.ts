// Pure state behind the file explorer tree (useFileTree). Kept free of React and
// of fetching so that every rule below is testable without a DOM.
//
// Two rules shape the whole module:
// - '..' is window chrome, not a node (CON-FEX-001). It is stripped the moment a
//   listing enters the state and survives only as the `hasParent` flag, and the
//   up row is a path-less sentinel so nothing keyed on a path can ever reach it.
// - The client holds no copy of the boundary rule (SEC-FOP-001). Whether '↑' is
//   possible is read from the server's own listing (`rootHasParent`), never
//   decided by comparing paths.
import type { DirectoryEntry, DirectoryListing } from '../../types/index.ts';

export type FileTreeMode = 'tree' | 'list';

export type ChildState =
  | { status: 'loading' }
  | { status: 'loaded'; entries: DirectoryEntry[]; hasParent: boolean }
  | { status: 'error'; error: string };

export interface FileTreeState {
  root: string;
  mode: FileTreeMode;
  expandedPaths: Set<string>;
  childrenByPath: Map<string, ChildState>;
  selectedPaths: Set<string>;
  anchorPath: string | null;
  rootHasParent: boolean;
  pendingRoot: string | null;
  error: string | null;
}

export interface RowClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

export type FileTreeAction =
  | { type: 'SET_ROOT'; path: string }
  | { type: 'NAVIGATE_UP' }
  | { type: 'NAVIGATE_COMMITTED'; path: string }
  | { type: 'NAVIGATE_FAILED'; path: string; error: string }
  | { type: 'SET_MODE'; mode: FileTreeMode }
  | { type: 'TOGGLE_EXPAND'; path: string }
  | { type: 'CHILDREN_LOADING'; path: string }
  | { type: 'CHILDREN_LOADED'; path: string; listing: DirectoryListing }
  | { type: 'CHILDREN_FAILED'; path: string; error: string }
  | { type: 'INVALIDATE_DIRECTORIES'; affectedDirectories: string[] }
  | { type: 'CLICK_ROW'; path: string; mods: RowClickModifiers; orderedPaths: string[] }
  | { type: 'SELECT_ALL'; orderedPaths: string[] }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'DESELECT_PATHS'; paths: string[] };

export type VisibleRow =
  | { kind: 'up' }
  | { kind: 'node'; path: string; name: string; type: DirectoryEntry['type']; depth: number };

const PARENT_ENTRY_NAME = '..';

export function createInitialFileTreeState(init: { root: string; mode?: FileTreeMode }): FileTreeState {
  return {
    root: init.root,
    mode: init.mode ?? 'tree',
    expandedPaths: new Set(),
    childrenByPath: new Map(),
    selectedPaths: new Set(),
    anchorPath: null,
    rootHasParent: false,
    pendingRoot: null,
    error: null,
  };
}

// Only the exact name '..' is the parent marker; '..hidden' is an ordinary file.
export function normalizeDirectoryEntries(raw: readonly DirectoryEntry[]): { entries: DirectoryEntry[]; hasParent: boolean } {
  const entries = raw.filter((entry) => entry.name !== PARENT_ENTRY_NAME);
  return { entries, hasParent: entries.length !== raw.length };
}

export function canGoUp(state: FileTreeState): boolean {
  return state.rootHasParent;
}

export function shouldFetchChildren(
  childrenByPath: ReadonlyMap<string, ChildState>,
  path: string,
  options: { isRefresh: boolean },
): boolean {
  return options.isRefresh || !childrenByPath.has(path);
}

function isSeparator(ch: string | undefined): boolean {
  return ch === '\\' || ch === '/';
}

function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(path);
}

function stripTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && isSeparator(path[end - 1]) && !isDriveRoot(path.slice(0, end))) end -= 1;
  return path.slice(0, end);
}

// Syntax only: is this spelling anchored to a root rather than to some current
// directory? POSIX '/x' (but not '//x'), drive 'C:\x' / 'C:/x', and UNC with a
// server and a share name. Drive-relative 'C:foo' and root-relative '\foo' are
// not; device namespaces ('\\?\', '\\.\') are refused. Whether the path may be
// touched is still the server's call. Used by the file-job client, which must
// not send a relative path (the server resolves it against its own cwd).
// @req FR-FEX-005
export function isAbsolutePathSyntax(path: string): boolean {
  if (path.startsWith('/') && !isSeparator(path[1])) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(path);
  return unc !== null && unc[1] !== '?' && unc[1] !== '.';
}

// Syntax only: this cuts the last segment off. Whether the result may be listed
// is the server's call, so no boundary is judged here.
export function parentPathOf(path: string): string {
  const trimmed = stripTrailingSeparators(path);
  let cut = trimmed.length - 1;
  while (cut >= 0 && !isSeparator(trimmed[cut])) cut -= 1;
  if (cut < 0) return trimmed;
  const head = trimmed.slice(0, cut);
  // 'C:\work' -> 'C:\' and '/home' -> '/': keep the separator that makes a root.
  if (head === '' || /^[A-Za-z]:$/.test(head)) return trimmed.slice(0, cut + 1);
  return head;
}

// Decided by the prefix only, as the tree controller decides it: a backslash is
// a legal character inside a POSIX name.
function isWindowsPathSyntax(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('\\');
}

// Windows paths compare with one separator and case-folded (NTFS is
// case-insensitive for the user); POSIX paths compare as spelled.
function comparablePath(path: string): { key: string; separator: string } {
  if (isWindowsPathSyntax(path)) {
    return { key: stripTrailingSeparators(path.replace(/\//g, '\\')).toLowerCase(), separator: '\\' };
  }
  return { key: stripTrailingSeparators(path), separator: '/' };
}

// Syntax only: is `candidate` the same entry as `ancestor` or somewhere under
// it? Separator-aware, so 'docs2' is not under 'docs'. Used to refuse moving a
// folder into itself before the request is sent; the server still judges
// whether either path may be touched.
// @req FR-FEX-005
export function isSameOrUnderPath(candidate: string, ancestor: string): boolean {
  const a = comparablePath(ancestor);
  const c = comparablePath(candidate);
  if (a.separator !== c.separator) return false;
  if (c.key === a.key) return true;
  const prefix = a.key.endsWith(a.separator) ? a.key : a.key + a.separator;
  return c.key.startsWith(prefix);
}

// Children join with the parent's own separator and never double it ('C:\' + 'work').
function joinChildPath(parent: string, name: string): string {
  if (isSeparator(parent[parent.length - 1])) return parent + name;
  const separator = parent.includes('\\') ? '\\' : '/';
  return parent + separator + name;
}

// Job reports may spell a directory with the other separator or a trailing one,
// so cache keys and reported paths are compared in one canonical spelling.
function canonicalDirectoryKey(path: string): string {
  return stripTrailingSeparators(path.replace(/\//g, '\\'));
}

function rootHasParentFrom(childrenByPath: ReadonlyMap<string, ChildState>, path: string): boolean {
  const child = childrenByPath.get(path);
  return child?.status === 'loaded' ? child.hasParent : false;
}

export function selectVisibleRows(state: FileTreeState): VisibleRow[] {
  const rows: VisibleRow[] = [];
  if (state.rootHasParent) rows.push({ kind: 'up' });

  const walk = (dirPath: string, depth: number): void => {
    const child = state.childrenByPath.get(dirPath);
    if (child?.status !== 'loaded') return;
    for (const entry of child.entries) {
      const path = joinChildPath(dirPath, entry.name);
      rows.push({ kind: 'node', path, name: entry.name, type: entry.type, depth });
      // Descend only through open, loaded directories — an expanded directory
      // under a collapsed ancestor stays expanded but is not drawn.
      if (state.mode === 'tree' && entry.type === 'directory' && state.expandedPaths.has(path)) {
        walk(path, depth + 1);
      }
    }
  };
  walk(state.root, 0);
  return rows;
}

// The action carries the display order (sorting and expansion are the renderer's),
// but it is not trusted on its own: only paths that are visible nodes right now
// count, which is what keeps the up sentinel and stale paths out of a selection.
function effectiveOrder(state: FileTreeState, orderedPaths: readonly string[]): string[] {
  const visible = new Set<string>();
  for (const row of selectVisibleRows(state)) {
    if (row.kind === 'node') visible.add(row.path);
  }
  return orderedPaths.filter((path) => visible.has(path));
}

function applyRowClick(
  state: FileTreeState,
  path: string,
  mods: RowClickModifiers,
  orderedPaths: readonly string[],
): FileTreeState {
  const order = effectiveOrder(state, orderedPaths);
  const targetIndex = order.indexOf(path);
  if (targetIndex < 0) return state;

  if (mods.shift) {
    const anchorIndex = state.anchorPath === null ? -1 : order.indexOf(state.anchorPath);
    const from = anchorIndex < 0 ? 0 : anchorIndex;
    const [lo, hi] = from <= targetIndex ? [from, targetIndex] : [targetIndex, from];
    return { ...state, selectedPaths: new Set(order.slice(lo, hi + 1)) };
  }
  if (mods.ctrl) {
    const selectedPaths = new Set(state.selectedPaths);
    if (selectedPaths.has(path)) selectedPaths.delete(path);
    else selectedPaths.add(path);
    return { ...state, selectedPaths, anchorPath: path };
  }
  return { ...state, selectedPaths: new Set([path]), anchorPath: path };
}

function withChild(state: FileTreeState, path: string, child: ChildState): Map<string, ChildState> {
  const childrenByPath = new Map(state.childrenByPath);
  childrenByPath.set(path, child);
  return childrenByPath;
}

export function fileTreeReducer(state: FileTreeState, action: FileTreeAction): FileTreeState {
  switch (action.type) {
    case 'SET_ROOT':
      // An explicit root is the newest intent, so a goUp still waiting on its
      // parent listing is abandoned rather than left looking in progress, and
      // its failure message no longer describes what is on screen.
      return { ...state, root: action.path, pendingRoot: null, error: null, rootHasParent: rootHasParentFrom(state.childrenByPath, action.path) };

    case 'NAVIGATE_UP':
      // The root moves only once the parent has actually been listed (NAVIGATE_COMMITTED).
      return { ...state, pendingRoot: parentPathOf(state.root) };

    case 'NAVIGATE_COMMITTED':
      return {
        ...state,
        root: action.path,
        pendingRoot: null,
        error: null,
        rootHasParent: rootHasParentFrom(state.childrenByPath, action.path),
      };

    case 'NAVIGATE_FAILED':
      return { ...state, pendingRoot: null, error: action.error };

    case 'SET_MODE':
      return { ...state, mode: action.mode };

    case 'TOGGLE_EXPAND': {
      const expandedPaths = new Set(state.expandedPaths);
      if (expandedPaths.has(action.path)) expandedPaths.delete(action.path);
      else expandedPaths.add(action.path);
      return { ...state, expandedPaths };
    }

    case 'CHILDREN_LOADING':
      return { ...state, childrenByPath: withChild(state, action.path, { status: 'loading' }) };

    case 'CHILDREN_LOADED': {
      const { entries, hasParent } = normalizeDirectoryEntries(action.listing.entries);
      const childrenByPath = withChild(state, action.path, { status: 'loaded', entries, hasParent });
      return action.path === state.root
        ? { ...state, childrenByPath, rootHasParent: hasParent }
        : { ...state, childrenByPath };
    }

    case 'CHILDREN_FAILED':
      return { ...state, childrenByPath: withChild(state, action.path, { status: 'error', error: action.error }) };

    case 'INVALIDATE_DIRECTORIES': {
      // Exact directories only: no prefix match ('src' must not take 'src2') and
      // no subtree sweep. Expansion is kept so the refetched view looks the same.
      const affected = new Set(action.affectedDirectories.map(canonicalDirectoryKey));
      const childrenByPath = new Map(state.childrenByPath);
      for (const key of state.childrenByPath.keys()) {
        if (affected.has(canonicalDirectoryKey(key))) childrenByPath.delete(key);
      }
      return { ...state, childrenByPath };
    }

    case 'CLICK_ROW':
      return applyRowClick(state, action.path, action.mods, action.orderedPaths);

    case 'SELECT_ALL':
      return { ...state, selectedPaths: new Set(effectiveOrder(state, action.orderedPaths)) };

    case 'CLEAR_SELECTION':
      return { ...state, selectedPaths: new Set(), anchorPath: null };

    case 'DESELECT_PATHS': {
      // Only the named paths leave; the rest of a multi-selection stays.
      const removed = new Set(action.paths);
      const anchorRemoved = state.anchorPath !== null && removed.has(state.anchorPath);
      if (!anchorRemoved && ![...state.selectedPaths].some((path) => removed.has(path))) return state;
      const selectedPaths = new Set([...state.selectedPaths].filter((path) => !removed.has(path)));
      return { ...state, selectedPaths, anchorPath: anchorRemoved ? null : state.anchorPath };
    }
  }
}
