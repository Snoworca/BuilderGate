// Dragging explorer entries onto a folder (FR-FEX-030): what travels, where it may land,
// and the job it becomes. The job is the one paste builds, so a drop and a paste of the
// same entries can never differ in what the server is asked to do.
// @req FR-FEX-030

import { buildPasteJobRequest, type PasteJobRequest } from './fileExplorerClipboard.ts';

/** The data type an explorer row drag carries; a drag from the OS carries 'Files' instead. */
export const INTERNAL_DRAG_TYPE = 'application/x-buildergate-entries';

export interface InternalDrag {
  sessionId: string;
  paths: readonly string[];
}

export interface DropDestination {
  sessionId: string;
  dir: string;
}

export type InternalDropDecision =
  | { allowed: true }
  | { allowed: false; reason: 'self' | 'inside' | 'same-folder' };

export function isInternalDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (types === null || types === undefined) return false;
  const list = Array.from(types);
  return list.includes(INTERNAL_DRAG_TYPE) && !list.includes('Files');
}

/** AC-1: a selected row carries the whole selection; any other row is selected alone first. */
export function decideDragSources(selected: ReadonlySet<string>, pressed: string): { paths: string[]; reselect: boolean } {
  if (selected.has(pressed)) return { paths: [...selected], reselect: false };
  return { paths: [pressed], reselect: true };
}

/** AC-2: the copy key is read at the drop; Option on macOS, Ctrl elsewhere. */
export function decideDragOperation(keys: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }, isMac: boolean): 'copy' | 'move' {
  return (isMac ? keys.altKey : keys.ctrlKey) ? 'copy' : 'move';
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

/** The folder holding `path`, without a trailing separator ('' for '/x', 'C:' for 'C:\\x'). */
function folderOf(path: string): string {
  const trimmed = trimSeparators(path);
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at < 0 ? trimmed : trimmed.slice(0, at);
}

/**
 * AC-3: a folder row is the target and empty space the shown folder. FR-FEX-033 AC-1: a file
 * row is the folder holding it -- the shown folder in the list, its parent in the tree -- so an
 * entry can be dropped where only files are left to release on.
 */
export function resolveInternalDropDir(input: { row: { path: string; isDir: boolean } | null; shownFolder: string }): string {
  if (input.row === null) return input.shownFolder;
  if (input.row.isDir) return input.row.path;
  const folder = folderOf(input.row.path);
  // The shown folder spells a root ('/', 'C:\\') the way the server listed it.
  return folder === trimSeparators(input.shownFolder) ? input.shownFolder : folder;
}

/** FR-FEX-033 AC-2, AC-3: a drop is pending while its request is out and while its job runs. */
export function isDropPending(pending: { jobId: string | null } | null, jobs: Readonly<Record<string, unknown>>): boolean {
  if (pending === null) return false;
  return pending.jobId === null || pending.jobId in jobs;
}


function isInside(dir: string, ancestor: string): boolean {
  const base = trimSeparators(ancestor);
  return dir.length > base.length && dir.startsWith(base) && (dir[base.length] === '/' || dir[base.length] === '\\');
}

/** AC-3: refuses the entries themselves, folders inside them, and the folder they are in. */
export function decideInternalDrop(drag: InternalDrag, dest: DropDestination): InternalDropDecision {
  if (drag.sessionId !== dest.sessionId) return { allowed: true };
  const dir = trimSeparators(dest.dir);
  for (const path of drag.paths) {
    if (trimSeparators(path) === dir) return { allowed: false, reason: 'self' };
    if (isInside(dir, path)) return { allowed: false, reason: 'inside' };
  }
  if (drag.paths.every((path) => trimSeparators(folderOf(path)) === dir)) return { allowed: false, reason: 'same-folder' };
  return { allowed: true };
}

/** AC-2: the paste request for the same entries, as a copy or a cut. */
export function buildDropJobRequest(drag: InternalDrag, dest: DropDestination, operation: 'copy' | 'move'): PasteJobRequest | null {
  if (!decideInternalDrop(drag, dest).allowed) return null;
  return buildPasteJobRequest(
    { mode: operation === 'copy' ? 'copy' : 'cut', entries: drag.paths.map((path) => ({ sessionId: drag.sessionId, path })) },
    { destSessionId: dest.sessionId, destPath: dest.dir },
  );
}

// The drag in flight, for dragover handlers: a page cannot read a drag's data until the drop.
let current: InternalDrag | null = null;

export function setCurrentInternalDrag(drag: InternalDrag | null): void {
  current = drag;
}

export function getCurrentInternalDrag(): InternalDrag | null {
  return current;
}
