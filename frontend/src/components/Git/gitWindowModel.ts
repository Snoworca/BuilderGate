/**
 * Which Git windows are open. One window per session; opening it again brings it
 * forward (restoring it from the tray). A workspace keeps at most four open: the
 * fifth minimizes the least recently used one rather than closing it. Windows on the
 * same repository cascade by 24 px. Geometry is kept per repository root.
 *
 * @req FR-GIT-004
 */

export type GitOpenTarget = 'auto' | 'worktree' | 'compare';

export interface GitWindowRecord {
  sessionId: string;
  workspaceId: string;
  repoRoot: string | null;
  minimized: boolean;
  lastUsed: number;
  /** Position in the cascade among windows on the same repository. */
  cascade: number;
  /** The last "open" request; the window applies it when the nonce changes. */
  request: { target: GitOpenTarget; nonce: number };
}

export interface GitWindowsState { windows: GitWindowRecord[]; nonce: number }

export const MAX_OPEN_PER_WORKSPACE = 4;
export const CASCADE_PX = 24;

export function emptyGitWindows(): GitWindowsState {
  return { windows: [], nonce: 0 };
}

export interface OpenGitWindowInput { sessionId: string; workspaceId: string; repoRoot: string | null; target: GitOpenTarget; now: number }

export function openGitWindow(state: GitWindowsState, input: OpenGitWindowInput): {
  state: GitWindowsState;
  effect: 'opened' | 'focused' | 'restored';
  /** A window minimized to make room, if any. */
  minimized: string | null;
} {
  const nonce = state.nonce + 1;
  const request = { target: input.target, nonce };
  const existing = state.windows.find((w) => w.sessionId === input.sessionId);
  let windows: GitWindowRecord[];
  let effect: 'opened' | 'focused' | 'restored';
  if (existing) {
    effect = existing.minimized ? 'restored' : 'focused';
    windows = state.windows.map((w) => (w === existing ? { ...w, minimized: false, lastUsed: input.now, request, repoRoot: input.repoRoot ?? w.repoRoot } : w));
  } else {
    effect = 'opened';
    const cascade = state.windows.filter((w) => w.repoRoot !== null && w.repoRoot === input.repoRoot).length;
    windows = [...state.windows, { sessionId: input.sessionId, workspaceId: input.workspaceId, repoRoot: input.repoRoot, minimized: false, lastUsed: input.now, cascade, request }];
  }
  let minimized: string | null = null;
  const open = windows.filter((w) => w.workspaceId === input.workspaceId && !w.minimized);
  if (open.length > MAX_OPEN_PER_WORKSPACE) {
    const lru = open.filter((w) => w.sessionId !== input.sessionId).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    minimized = lru.sessionId;
    windows = windows.map((w) => (w === lru ? { ...w, minimized: true } : w));
  }
  return { state: { windows, nonce }, effect, minimized };
}

export function minimizeGitWindow(state: GitWindowsState, sessionId: string): GitWindowsState {
  return { ...state, windows: state.windows.map((w) => (w.sessionId === sessionId ? { ...w, minimized: true } : w)) };
}

export function focusGitWindow(state: GitWindowsState, sessionId: string, now: number): GitWindowsState {
  return { ...state, windows: state.windows.map((w) => (w.sessionId === sessionId ? { ...w, lastUsed: now } : w)) };
}

export function closeGitWindow(state: GitWindowsState, sessionId: string): GitWindowsState {
  return { ...state, windows: state.windows.filter((w) => w.sessionId !== sessionId) };
}

interface SavedWindow { sessionId: string; workspaceId: string; repoRoot: string | null; minimized: boolean; cascade: number }

export const GIT_WINDOWS_KEY = 'bg.git.open.v1';

export function serializeGitWindows(state: GitWindowsState): string {
  const saved: SavedWindow[] = state.windows.map(({ sessionId, workspaceId, repoRoot, minimized, cascade }) => ({ sessionId, workspaceId, repoRoot, minimized, cascade }));
  return JSON.stringify(saved);
}

/** Windows saved before a reload, minus those whose session has ended. */
export function restoreGitWindows(saved: string | null, liveSessions: ReadonlySet<string>, now: number): GitWindowsState {
  let list: unknown;
  try { list = JSON.parse(saved ?? '[]'); } catch { return emptyGitWindows(); }
  if (!Array.isArray(list)) return emptyGitWindows();
  const windows = list
    .filter((w): w is SavedWindow => typeof w === 'object' && w !== null && typeof (w as SavedWindow).sessionId === 'string' && typeof (w as SavedWindow).workspaceId === 'string')
    .filter((w) => liveSessions.has(w.sessionId))
    .map((w, i) => ({ sessionId: w.sessionId, workspaceId: w.workspaceId, repoRoot: w.repoRoot ?? null, minimized: !!w.minimized, cascade: Number(w.cascade) || 0, lastUsed: now + i, request: { target: 'auto' as const, nonce: 0 } }));
  return { windows, nonce: 0 };
}

export interface GitGeometry { rect: { x: number; y: number; width: number; height: number }; split: number; filesHeight: number }
interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

const geometryKey = (root: string) => `bg.git.window.v1:${root}`;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

export function readGitGeometry(storage: KeyValueStorage, root: string): GitGeometry | null {
  try {
    const g = JSON.parse(storage.getItem(geometryKey(root)) ?? 'null') as GitGeometry | null;
    if (!g || !g.rect || ![g.rect.x, g.rect.y, g.rect.width, g.rect.height, g.split, g.filesHeight].every(isNum)) return null;
    return { rect: { x: g.rect.x, y: g.rect.y, width: g.rect.width, height: g.rect.height }, split: g.split, filesHeight: g.filesHeight };
  } catch {
    return null;
  }
}

export function writeGitGeometry(storage: KeyValueStorage, root: string, g: GitGeometry): void {
  try { storage.setItem(geometryKey(root), JSON.stringify(g)); } catch { /* storage full or blocked: geometry is a convenience */ }
}
