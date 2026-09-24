// Pure state behind the explorer's tabs. Kept free of React and of storage so
// the tab rules are testable without a DOM.
//
// Each tab owns its own FileTreeState: two tabs looking at two roots is the
// normal case (FR-FEX-003 AC-3), so nothing about a tree is shared between tabs.
// A tab is tied to a terminal session, but a session id means nothing after a
// reload; what survives is originTabId, and the session is re-resolved from it.
import {
  createInitialFileTreeState,
  fileTreeReducer,
  type FileTreeAction,
  type FileTreeMode,
  type FileTreeState,
  isSamePath,
} from './fileTreeState.ts';
import type { ListSort } from './fileListView.ts';
import type { PersistedFileExplorerState } from '../../hooks/windowStateStorage.ts';

export interface FileExplorerTab {
  // Stable across reloads: the stored record keeps it, so anything keyed on a
  // tab (the active tab, a saved anchor) still points at the same tab after one.
  id: string;
  originTabId: string;
  sessionId: string;
  tree: FileTreeState;
  sort: ListSort | null;
  scrollAnchor: string | null;
  /**
   * Where the tab came from. Only a restored root can have vanished while the
   * page was closed; a tab the user just opened failing its first listing is
   * the user's to see (SEC-FOP-001 AC-5). Not stored: it describes this load.
   */
  origin: 'restored' | 'opened';
}

export interface FileExplorerTabs {
  tabs: FileExplorerTab[];
  activeTabId: string | null;
}

export interface RestoreFileExplorerDeps {
  // Maps a stored originTabId to a live session. When the original terminal tab
  // is gone the caller answers with the workspace's active terminal instead, so
  // a restored tab is never left without a session.
  resolveSession: (originTabId: string) => string;
  sessionCwd: (sessionId: string) => string;
}

export type RestoredRootFailureAction = 'fallback-to-session-cwd' | 'keep-root-with-error';

// A random id rather than a counter: restored tabs keep their stored ids, and a
// counter restarted at page load could hand out one of them again.
// randomUUID exists only in secure contexts; getRandomValues does not have that
// limit, so a page served over plain http can still open tabs.
function newTabId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return `fx-${cryptoApi.randomUUID()}`;
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `fx-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function isTreeMode(value: unknown): value is FileTreeMode {
  return value === 'tree' || value === 'list';
}

// @req FR-FEX-003
export function openInNewTab(
  state: FileExplorerTabs,
  target: { sessionId: string; path: string; originTabId?: string },
): FileExplorerTabs {
  const tab: FileExplorerTab = {
    id: newTabId(),
    // The terminal tab id is not derivable from a session id (a workspace tab
    // outlives the sessions it has held), so without one the origin is left
    // empty and a reload re-binds the tab through resolveSession's fallback.
    originTabId: target.originTabId ?? '',
    sessionId: target.sessionId,
    tree: createInitialFileTreeState({ root: target.path, mode: 'tree' }),
    sort: null,
    scrollAnchor: null,
    origin: 'opened',
  };
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

// An entry point names a terminal, and the explorer shows that terminal's
// current directory: its existing tab for the same session and root is brought
// forward, and otherwise that directory opens in a new tab. The window is one
// per workspace, so without this a second terminal's request only raised the
// window on whatever the first terminal had opened.
export function focusOrOpenSessionTab(
  state: FileExplorerTabs,
  target: { sessionId: string; path: string; originTabId?: string },
): FileExplorerTabs {
  const existing = state.tabs.find((tab) => tab.sessionId === target.sessionId && isSamePath(tab.tree.root, target.path));
  if (existing !== undefined) return setActiveTab(state, existing.id);
  return openInNewTab(state, target);
}

// Closing the active tab activates its right neighbour, or the left one when it
// was last, the same way a browser tab strip behaves.
// @req FR-FEX-003
export function closeTab(state: FileExplorerTabs, tabId: string): FileExplorerTabs {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeTabId: next === null ? null : next.id };
}

// @req FR-FEX-003
export function setActiveTab(state: FileExplorerTabs, tabId: string): FileExplorerTabs {
  if (state.activeTabId === tabId || !state.tabs.some((tab) => tab.id === tabId)) return state;
  return { tabs: state.tabs, activeTabId: tabId };
}

// Only the named tab's tree goes through the reducer; every other tab object is
// handed back as it was, so a render keyed on tab identity skips them.
// @req FR-FEX-003
export function updateTabTree(state: FileExplorerTabs, tabId: string, action: FileTreeAction): FileExplorerTabs {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    const tree = fileTreeReducer(tab.tree, action);
    if (tree === tab.tree) return tab;
    changed = true;
    return { ...tab, tree };
  });
  return changed ? { tabs, activeTabId: state.activeTabId } : state;
}

// Rebuilds the tab list from what was stored. No distinct tab is dropped: a record
// with an unusable root is pointed at its session's cwd, and one with an unknown
// mode becomes a tree, because losing a tab the user arranged is worse than
// showing it somewhere sensible.
// @req FR-FEX-003
export function restoreFileExplorerTabs(
  stored: PersistedFileExplorerState | null,
  deps: RestoreFileExplorerDeps,
): FileExplorerTabs {
  if (stored === null) return { tabs: [], activeTabId: null };

  // Ids key every tab operation, so a stored value holding one id twice (a hand
  // edit, a half-written value) would make closing one tab close both. The
  // first record for an id wins; later copies are the only records dropped.
  const seen = new Set<string>();
  const records = stored.tabs.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });

  const tabs = records.map((record): FileExplorerTab => {
    const sessionId = deps.resolveSession(record.originTabId);
    const root = record.root.trim() === '' ? deps.sessionCwd(sessionId) : record.root;
    return {
      id: record.id,
      originTabId: record.originTabId,
      sessionId,
      // A fresh tree: expanded directories are deliberately not restored (AC-7).
      tree: createInitialFileTreeState({ root, mode: isTreeMode(record.mode) ? record.mode : 'tree' }),
      sort: record.sort,
      scrollAnchor: record.scrollAnchor,
      origin: 'restored',
    };
  });

  // An active id that names no restored tab would leave nothing selected while
  // tabs exist; the first tab is the least surprising stand-in.
  const activeTabId = tabs.some((tab) => tab.id === stored.activeTabId)
    ? stored.activeTabId
    : (tabs[0]?.id ?? null);
  return { tabs, activeTabId };
}

// A stored root that no longer lists (deleted while the page was closed) is not
// the user's doing, so the tab falls back to its session's cwd without an error.
// A root the user just navigated to is: it stays, with the error shown
// (SEC-FOP-001 AC-5).
// @req FR-FEX-003
export function resolveRestoredRootFailure(input: { origin: 'restore' | 'navigate' }): RestoredRootFailureAction {
  return input.origin === 'restore' ? 'fallback-to-session-cwd' : 'keep-root-with-error';
}

// What a tab does when its very first listing fails, by where it came from.
// @req FR-FEX-003
export function firstListingFailureAction(tab: Pick<FileExplorerTab, 'origin'>): RestoredRootFailureAction {
  return resolveRestoredRootFailure({ origin: tab.origin === 'restored' ? 'restore' : 'navigate' });
}

// A workspace that is gone takes its explorer window along. An empty list is
// read as "not loaded yet" rather than "all deleted", so a slow first fetch
// cannot wipe every window. The same object comes back when nothing is
// removed, so a caller keyed on identity does not re-render.
// @req FR-FEX-003
export function dropWindowsOfRemovedWorkspaces<R>(
  windows: Record<string, R>,
  liveWorkspaceIds: readonly string[],
): { windows: Record<string, R>; removed: string[] } {
  if (liveWorkspaceIds.length === 0) return { windows, removed: [] };
  const live = new Set(liveWorkspaceIds);
  const removed = Object.keys(windows).filter((id) => !live.has(id));
  if (removed.length === 0) return { windows, removed };
  const next = { ...windows };
  for (const id of removed) delete next[id];
  return { windows: next, removed };
}

/**
 * The workspace ids that were in `previous` and are gone from `current`. An
 * empty `current` means the list has not loaded -- the server never deletes the
 * last workspace -- so it removes nothing. Unlike dropWindowsOfRemovedWorkspaces
 * this does not depend on a window record existing, so a workspace whose
 * explorer was closed still has its stored tabs cleared.
 * @req FR-FEX-003
 */
export function removedWorkspaceIds(previous: readonly string[], current: readonly string[]): string[] {
  if (current.length === 0) return [];
  const live = new Set(current);
  return previous.filter((id) => !live.has(id));
}
