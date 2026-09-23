// The asynchronous half of the file explorer tree (useFileTree): when a listing
// is requested, and which arriving answer is still allowed to change the state.
// Kept free of React so that out-of-order answers can be staged by hand in unit
// tests — that is where a controller that works in the happy path shows stale data.
//
// Two kinds of staleness are tracked separately because they fail differently:
// - per path: the newest request for a directory owns its cache slot, so an older
//   answer (success or failure) that arrives late is dropped;
// - per navigation: the newest root intent (setRoot or goUp) owns the root, so a
//   goUp overtaken by a later intent neither commits nor reports its failure.
//   Comparing pendingRoot is not enough: a later goUp can target the same path.
import type { DirectoryListing } from '../../types/index.ts';
import {
  canGoUp,
  parentPathOf,
  selectVisibleRows,
  shouldFetchChildren,
  type FileTreeAction,
  type FileTreeMode,
  type FileTreeState,
} from './fileTreeState.ts';

export interface FileTreeControllerDeps {
  sessionId: string;
  listDirectory: (sessionId: string, path?: string) => Promise<DirectoryListing>;
  getState: () => FileTreeState;
  dispatch: (action: FileTreeAction) => void;
}

export interface FileTreeController {
  setRoot(path: string): Promise<void>;
  goUp(): Promise<void>;
  expand(path: string): Promise<void>;
  collapse(path: string): void;
  refresh(path: string): Promise<void>;
  setMode(mode: FileTreeMode): void;
  applyJobDone(affectedDirectories: readonly string[]): Promise<void>;
}

type RequestOutcome =
  | { kind: 'loaded'; fresh: boolean }
  | { kind: 'failed'; fresh: boolean; message: string };

// Decided by the prefix only: '\\' is a legal character inside a POSIX name,
// so '/home/u/a\\b' must stay POSIX.
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('\\');
}

// One canonical spelling per directory, so that 'C:/work/repo/' and
// 'C:\work\repo' share a cache slot and a request token. POSIX paths keep '/':
// a backslash is a legal character in a POSIX file name.
export function normalizeTreePath(path: string): string {
  if (isWindowsPath(path)) {
    let p = path.replace(/\//g, '\\');
    if (/^[A-Za-z]:$/.test(p)) return `${p}\\`;
    // 'C:\' keeps its separator: without it the path means "current dir on C:".
    while (p.length > 1 && p.endsWith('\\') && !/^[A-Za-z]:\\$/.test(p)) p = p.slice(0, -1);
    return p;
  }
  let p = path;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  return typeof reason === 'string' && reason ? reason : 'Failed to list directory';
}

export function createFileTreeController(deps: FileTreeControllerDeps): FileTreeController {
  const { sessionId, listDirectory, getState, dispatch } = deps;
  let tokenSeq = 0;
  // Only paths with a request in flight have an entry; it is removed when the
  // newest request settles, so the map does not grow with every directory seen.
  const latestTokenByPath = new Map<string, number>();
  let navToken = 0;
  let pendingGoUp: { token: number; target: string } | null = null;

  // Selection and anchor only make sense for rows on screen; after the root
  // moves they may point at paths the user can no longer see or act on knowingly.
  const pruneInvisibleSelection = (): void => {
    const state = getState();
    if (state.selectedPaths.size === 0 && state.anchorPath === null) return;
    const visible = new Set<string>();
    for (const row of selectVisibleRows(state)) if (row.kind === 'node') visible.add(row.path);
    const stale = [...state.selectedPaths].some((p) => !visible.has(p))
      || (state.anchorPath !== null && !visible.has(state.anchorPath));
    if (stale) dispatch({ type: 'CLEAR_SELECTION' });
  };

  // `cache` false is for the goUp probe: the parent is not a node in the current
  // tree, so its failure is reported as a navigation error rather than cached.
  const request = async (key: string, cache: boolean): Promise<RequestOutcome> => {
    const token = ++tokenSeq;
    latestTokenByPath.set(key, token);
    if (cache && !getState().childrenByPath.has(key)) dispatch({ type: 'CHILDREN_LOADING', path: key });

    const settle = (): boolean => {
      const fresh = latestTokenByPath.get(key) === token;
      if (fresh) latestTokenByPath.delete(key);
      return fresh;
    };

    let listing: DirectoryListing;
    try {
      listing = await listDirectory(sessionId, key);
    } catch (reason) {
      const fresh = settle();
      // Without cache the probe still took over the slot's token, so a 'loading'
      // entry it superseded would otherwise never settle.
      if (fresh && (cache || getState().childrenByPath.get(key)?.status === 'loading')) {
        dispatch({ type: 'CHILDREN_FAILED', path: key, error: errorMessage(reason) });
      }
      return { kind: 'failed', fresh, message: errorMessage(reason) };
    }
    const fresh = settle();
    if (fresh) dispatch({ type: 'CHILDREN_LOADED', path: key, listing });
    return { kind: 'loaded', fresh };
  };

  // A 'loading' entry no request of this controller owns is an orphan (its
  // request belonged to a discarded controller); reading it again is the only
  // way it ever leaves the spinner.
  const isOrphanLoading = (key: string): boolean =>
    getState().childrenByPath.get(key)?.status === 'loading' && !latestTokenByPath.has(key);

  const load = async (key: string, isRefresh: boolean): Promise<void> => {
    if (!shouldFetchChildren(getState().childrenByPath, key, { isRefresh }) && !isOrphanLoading(key)) return;
    await request(key, true);
  };

  return {
    async setRoot(path) {
      const key = normalizeTreePath(path);
      // A new root is the newest intent: any goUp still out is abandoned.
      navToken += 1;
      pendingGoUp = null;
      dispatch({ type: 'SET_ROOT', path: key });
      pruneInvisibleSelection();
      await load(key, false);
    },

    async goUp() {
      const state = getState();
      if (!canGoUp(state)) return;
      const target = normalizeTreePath(parentPathOf(state.root));
      // A second press while the same parent is being listed adds nothing.
      if (pendingGoUp !== null && pendingGoUp.token === navToken && pendingGoUp.target === target) return;
      const token = ++navToken;
      pendingGoUp = { token, target };
      dispatch({ type: 'NAVIGATE_UP' });

      const outcome = await request(target, false);
      if (token !== navToken) return;
      pendingGoUp = null;
      if (outcome.kind === 'failed') {
        // The server's message is the only boundary explanation the client has (SEC-FOP-001).
        dispatch({ type: 'NAVIGATE_FAILED', path: target, error: outcome.message });
        return;
      }
      dispatch({ type: 'NAVIGATE_COMMITTED', path: target });
      pruneInvisibleSelection();
    },

    async expand(path) {
      const key = normalizeTreePath(path);
      // Idempotent on purpose: a double-click or a repeated keyboard command must not close the node.
      if (!getState().expandedPaths.has(key)) dispatch({ type: 'TOGGLE_EXPAND', path: key });
      await load(key, false);
    },

    collapse(path) {
      const key = normalizeTreePath(path);
      if (getState().expandedPaths.has(key)) dispatch({ type: 'TOGGLE_EXPAND', path: key });
    },

    async refresh(path) {
      await load(normalizeTreePath(path), true);
    },

    setMode(mode) {
      dispatch({ type: 'SET_MODE', mode });
    },

    async applyJobDone(affectedDirectories) {
      const keys = new Set(affectedDirectories.map(normalizeTreePath));
      const cached = getState().childrenByPath;
      // A directory never listed has nothing on screen to go stale; one with a
      // read in flight is re-read anyway, because that read may predate the job.
      const reads = [...keys].filter((key) => cached.has(key)).map((key) => load(key, true));
      await Promise.all(reads);
    },
  };
}
