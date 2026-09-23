// The explorer's own clipboard: one module-scope value shared by every tab,
// every explorer window and the editor's side panel (design 6.1, 9.3). It is
// deliberately not the OS clipboard -- entries carry a session id, which only
// this application can resolve -- and deliberately not React state, so a copy
// in one window is visible to a paste in another without lifting state through
// the tree. Components read it through useSyncExternalStore with
// subscribeFileExplorerClipboard / getFileExplorerClipboard.
//
// No function here takes a tab, window or tree/list mode argument: the value is
// the same regardless of where it is read (FR-FEX-005 AC-1, FR-FEX-002 AC-6).
// @req FR-FEX-005
// @req CON-FEX-001

// The row renderer already owns this shape (it dims cut rows); sharing it keeps
// the two from drifting. Type-only, so no runtime edge back to the row module.
import type { ExplorerClipboard } from './fileRowInteraction.ts';
import { isSameOrUnderPath } from './fileTreeState.ts';

export type { ExplorerClipboard };

export type ExplorerClipboardEntry = ExplorerClipboard['entries'][number];

export interface ExplorerSelection {
  sessionId: string;
  paths: readonly string[];
}

export interface PasteTarget {
  destSessionId: string;
  destPath: string;
}

export interface PasteJobRequest {
  operation: 'copy' | 'move';
  sourceSessionId: string;
  sources: string[];
  destSessionId: string;
  destPath: string;
}

export interface DeleteJobRequest {
  operation: 'delete';
  sourceSessionId: string;
  sources: string[];
}

let current: ExplorerClipboard | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Returns the same reference until the value changes, which is what
 * useSyncExternalStore requires of a snapshot.
 * @req FR-FEX-005
 */
export function getFileExplorerClipboard(): ExplorerClipboard | null {
  return current;
}

/** @req FR-FEX-005 */
export function setFileExplorerClipboard(value: ExplorerClipboard | null): void {
  if (value === current) {
    return;
  }
  current = value;
  notify();
}

/** @req FR-FEX-005 */
export function clearFileExplorerClipboard(): void {
  setFileExplorerClipboard(null);
}

/** @req FR-FEX-005 */
export function subscribeFileExplorerClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Clipboard values being pasted right now. The clipboard is one value for the
// whole application, so the guard against sending it twice lives beside it:
// a per-panel flag let two panels submit the same cut before the first POST
// answered (the cut is consumed only once the server accepts). Keyed on the
// value, which is replaced rather than mutated, so a new copy is never blocked
// by the paste of an old one.
const pastesInFlight = new WeakSet<ExplorerClipboard>();

/**
 * Marks `value` as being pasted; false when a paste of it is already running.
 * @req FR-FEX-005
 */
export function beginClipboardPaste(value: ExplorerClipboard): boolean {
  if (pastesInFlight.has(value)) return false;
  pastesInFlight.add(value);
  return true;
}

/** @req FR-FEX-005 */
export function endClipboardPaste(value: ExplorerClipboard): void {
  pastesInFlight.delete(value);
}

// '..' is window chrome, never a target (CON-FEX-001). Checked here as well as
// in the tree state so the guarantee does not depend on every caller having
// gone through it. Only an exact '..' last segment counts, in either separator;
// '..hidden' is an ordinary name.
function isParentMarker(path: string): boolean {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] === '..';
}

function targetPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !isParentMarker(path));
}

// Replaces rather than merges: a second copy is a new clipboard, as in every
// file manager. A selection with nothing left after the '..' filter leaves the
// previous value alone, so an accidental press on the up row does not wipe it.
function store(mode: ExplorerClipboard['mode'], selection: ExplorerSelection): ExplorerClipboard | null {
  const paths = targetPaths(selection.paths);
  if (paths.length === 0) {
    return null;
  }
  const value: ExplorerClipboard = {
    mode,
    entries: paths.map((path) => ({ sessionId: selection.sessionId, path })),
  };
  setFileExplorerClipboard(value);
  return value;
}

/** @req FR-FEX-005 */
export function copySelection(selection: ExplorerSelection): ExplorerClipboard | null {
  return store('copy', selection);
}

/** @req FR-FEX-005 */
export function cutSelection(selection: ExplorerSelection): ExplorerClipboard | null {
  return store('cut', selection);
}

// Every drawn row asks whether it is cut, so the answer is one set lookup: the
// set is built once per clipboard value (the value is replaced, never mutated)
// and dropped with it.
const cutPathCache = new WeakMap<ExplorerClipboard, ReadonlySet<string>>();
const EMPTY_PATHS: ReadonlySet<string> = new Set();
let cutPathSetBuilds = 0;

/**
 * The paths a cut clipboard dims; empty for a copy.
 * @req FR-FEX-005
 */
export function cutPathsOf(clipboard: ExplorerClipboard): ReadonlySet<string> {
  if (clipboard.mode !== 'cut') return EMPTY_PATHS;
  const cached = cutPathCache.get(clipboard);
  if (cached !== undefined) return cached;
  cutPathSetBuilds += 1;
  const paths = new Set(clipboard.entries.map((entry) => entry.path));
  cutPathCache.set(clipboard, paths);
  return paths;
}

/** How many cut sets have been built; lets a test pin "once per value". */
export function cutPathSetBuildCount(): number {
  return cutPathSetBuilds;
}

/**
 * A move whose destination is one of its own sources, or under one, would ask
 * the server to put a folder inside itself. Only within one session: another
 * session's path names another place.
 * @req FR-FEX-005
 */
export function isMoveIntoOwnSource(clipboard: ExplorerClipboard, target: PasteTarget): boolean {
  if (clipboard.mode !== 'cut') return false;
  return clipboard.entries.some((entry) => entry.sessionId === target.destSessionId
    && !isParentMarker(entry.path)
    && isSameOrUnderPath(target.destPath, entry.path));
}

/**
 * Paste goes to the current tab's directory. The request carries one source
 * session, so a clipboard whose entries span sessions (only reachable through a
 * direct set) is refused rather than sent under the wrong session.
 * @req FR-FEX-005
 */
export function buildPasteJobRequest(clipboard: ExplorerClipboard, target: PasteTarget): PasteJobRequest | null {
  const entries = clipboard.entries.filter((entry) => !isParentMarker(entry.path));
  if (entries.length === 0) {
    return null;
  }
  const sourceSessionId = entries[0].sessionId;
  if (entries.some((entry) => entry.sessionId !== sourceSessionId)) {
    return null;
  }
  if (isMoveIntoOwnSource(clipboard, target)) {
    return null;
  }
  return {
    operation: clipboard.mode === 'cut' ? 'move' : 'copy',
    sourceSessionId,
    sources: entries.map((entry) => entry.path),
    destSessionId: target.destSessionId,
    destPath: target.destPath,
  };
}

/** @req FR-FEX-005 */
export function buildDeleteJobRequest(selection: ExplorerSelection): DeleteJobRequest | null {
  const sources = targetPaths(selection.paths);
  if (sources.length === 0) {
    return null;
  }
  return { operation: 'delete', sourceSessionId: selection.sessionId, sources };
}
