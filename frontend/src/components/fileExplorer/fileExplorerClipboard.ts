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
