// Which documents a workspace had open between page loads, and the only thing
// that knows the key they are kept under.
//
// The split is the one `mosaicLayoutStorage` already uses: this module owns the
// key and the serialization, and `useWindowState` wraps it for React. A record
// names a tab, and a tab id means nothing in a workspace that does not hold it,
// so the store is scoped per workspace exactly as the mosaic layout is.
//
// Where the window sits is not here. That is one remembered placement for the
// whole app, so it lives under the global key `editorWindowGeometryCache` owns;
// a per-workspace copy would give one question two answers.
//
// What is written is `toEditorWindowRecord`'s projection and nothing else. That
// projection is what drops the unsaved body, the session id and the placement;
// naming it here rather than serializing the live document is what keeps them
// out of a value the user can read in their browser.
//
// @req FR-MDE-009

import {
  isEditorWindowRecord,
  restoreEditorWindowRecords,
  toEditorWindowRecord,
  type EditorWindowRecord,
} from '../components/editor/editorWindowRecord.ts';
import type { FileTreeMode } from '../components/fileExplorer/fileTreeState.ts';
import { LIST_COLUMNS, type ListSort } from '../components/fileExplorer/fileListView.ts';

const STORAGE_KEY_PREFIX = 'window_state_';
const SCHEMA_VERSION = 1;

/**
 * The shape of the stored value. The records sit under a named field rather
 * than at the top level so the version travels with them.
 * @req FR-MDE-009
 */
export interface PersistedWindowState {
  schemaVersion: typeof SCHEMA_VERSION;
  windows: EditorWindowRecord[];
  savedAt: string;
}

/**
 * @req FR-MDE-009
 */
export function getWindowStateStorageKey(workspaceId: string): string {
  return STORAGE_KEY_PREFIX + workspaceId;
}

/**
 * Writes the open documents of a workspace.
 *
 * Each one goes through `toEditorWindowRecord`, which projects field by field.
 * Spreading the live document instead would carry the body, the session id and
 * the window's placement into a store that is readable in the browser, and the
 * body in particular would turn every reload into a three-way question between
 * what is stored, what is on disk and what the user remembers.
 *
 * Answers whether the write happened, so a caller can tell a full quota from a
 * successful save. Returning nothing would make the two look alike.
 * @req FR-MDE-009
 */
export function saveWindowStateForWorkspace(
  workspaceId: string,
  windows: readonly EditorWindowRecord[],
  storage: Storage = localStorage,
): boolean {
  try {
    const data: PersistedWindowState = {
      schemaVersion: SCHEMA_VERSION,
      // Called with one argument on purpose: `map` also passes the index and
      // the array, and a projection that took a second parameter later would
      // silently start receiving them.
      windows: windows.map(editorWindow => toEditorWindowRecord(editorWindow)),
      savedAt: new Date().toISOString(),
    };
    storage.setItem(getWindowStateStorageKey(workspaceId), JSON.stringify(data));
    return true;
  } catch (error) {
    // A full quota is the common cause, but a browser with site data blocked
    // throws here too and would never succeed. The message states what happened
    // rather than why, so a diagnosis does not start from the wrong cause.
    console.warn('[useWindowState] window state was not written to localStorage:', error);
    return false;
  }
}

/**
 * Reads the stored records back, or null when there is nothing usable there.
 *
 * This key lives in browser storage, so its content is arbitrary text: another
 * version of the app, a hand edit, or a half-written value from a tab that was
 * closed mid-write. Every step below therefore answers null rather than
 * throwing, because the caller's only sensible response to any of them is the
 * same one -- restore no windows -- and a throw would surface a storage detail
 * as an error the user did nothing to cause.
 *
 * The records are validated individually as well as the wrapper, so the return
 * type is one a caller can use without checking it again.
 *
 * The whole stored value comes back rather than its records alone, so that this
 * and `restoreWindowStateForWorkspace` cannot be mistaken for one another. They
 * answer different questions -- what is stored, and what of it is restorable --
 * and returning the same array type from both would leave the wrong choice
 * compiling, with a window bound to a tab that no longer exists as the result.
 * @req FR-MDE-009
 */
export function readPersistedWindowState(
  workspaceId: string,
  storage: Storage = localStorage,
): PersistedWindowState | null {
  try {
    const raw = storage.getItem(getWindowStateStorageKey(workspaceId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const { schemaVersion, windows, savedAt } = parsed as Partial<PersistedWindowState>;
    if (schemaVersion !== SCHEMA_VERSION || !Array.isArray(windows)) {
      return null;
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      // Shape is checked and then projected, so a hand-edited entry carrying a
      // body cannot hand that body back to the app through this door. The tab
      // filter is not applied here: this function answers what is stored, and
      // `restoreWindowStateForWorkspace` answers what of it is still restorable.
      windows: windows
        .filter(isEditorWindowRecord)
        .map(record => toEditorWindowRecord(record)),
      savedAt: typeof savedAt === 'string' ? savedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * The documents to reopen for a workspace, in the order they become tabs.
 *
 * The order is the stored one and it is load-bearing: it is the row the user
 * arranged, and a reopen that sorted the records would hand back a different
 * row from the one that was saved. The first of them becomes the active tab,
 * which is the same rule a hand-opened document follows.
 *
 * A record whose tab is gone is not reopened at all: it has no session to save
 * through.
 * @req FR-MDE-009
 */
export function restoreWindowStateForWorkspace(
  workspaceId: string,
  existingTabIds: Iterable<string>,
  storage: Storage = localStorage,
): EditorWindowRecord[] {
  const stored = readPersistedWindowState(workspaceId, storage);
  if (stored === null) {
    return [];
  }

  return restoreEditorWindowRecords(stored.windows, existingTabIds);
}

// ---------------------------------------------------------------------------
// File explorer tabs
//
// A second store under its own key, following the editor's conventions: an
// envelope that carries its version, an injectable storage, and null for
// anything unusable. It is a separate key rather than a field of the editor's
// value so neither schema can move the other -- a change to
// PersistedWindowState would silently drop every user's saved editor windows.
// ---------------------------------------------------------------------------

const FILE_EXPLORER_KEY_PREFIX = 'file_explorer_state_';
const FILE_EXPLORER_SCHEMA_VERSION = 1;

/**
 * Exactly what one explorer tab keeps between page loads. No expanded
 * directories (FR-FEX-003 AC-7), no pixel offset of any kind (AC-8): the scroll
 * position is the name of the top visible row. No session id either: it means
 * nothing after a reload, so the tab is re-bound through originTabId.
 * @req FR-FEX-003
 */
export interface FileExplorerTabRecord {
  id: string;
  originTabId: string;
  root: string;
  mode: FileTreeMode;
  sort: ListSort | null;
  scrollAnchor: string | null;
}

/**
 * @req FR-FEX-003
 */
export interface PersistedFileExplorerState {
  schemaVersion: typeof FILE_EXPLORER_SCHEMA_VERSION;
  tabs: FileExplorerTabRecord[];
  activeTabId: string | null;
  savedAt: string;
}

/**
 * @req FR-FEX-003
 */
export function getFileExplorerStateStorageKey(workspaceId: string): string {
  return FILE_EXPLORER_KEY_PREFIX + workspaceId;
}

function toListSort(value: unknown): ListSort | null {
  if (value === null || typeof value !== 'object') return null;
  const { key, dir } = value as Partial<ListSort>;
  if (!(LIST_COLUMNS as readonly unknown[]).includes(key)) return null;
  if (dir !== 'asc' && dir !== 'desc') return null;
  return { key: key as ListSort['key'], dir };
}

// Field-by-field projection, used on both write and read. Naming the six fields
// is what keeps a live tab's expanded paths, pixel offset and session id out of
// the stored value, and keeps a hand-edited value from carrying them back in.
// Returns null only when the record cannot name a tab at all; an unusable root
// or mode is repaired instead, so a tab the user arranged is not dropped.
function toFileExplorerTabRecord(value: unknown): FileExplorerTabRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, originTabId, root, mode, sort, scrollAnchor } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof originTabId !== 'string') return null;
  return {
    id,
    originTabId,
    // An empty root is left for the restore to point at the session's cwd.
    root: typeof root === 'string' ? root : '',
    mode: mode === 'list' ? 'list' : 'tree',
    sort: toListSort(sort),
    scrollAnchor: typeof scrollAnchor === 'string' ? scrollAnchor : null,
  };
}

/**
 * Writes a workspace's explorer tabs. Answers whether the write happened, for
 * the same reason `saveWindowStateForWorkspace` does.
 * @req FR-FEX-003
 */
export function saveFileExplorerStateForWorkspace(
  workspaceId: string,
  state: { tabs: readonly FileExplorerTabRecord[]; activeTabId: string | null },
  storage: Storage = localStorage,
): boolean {
  try {
    const data: PersistedFileExplorerState = {
      schemaVersion: FILE_EXPLORER_SCHEMA_VERSION,
      tabs: state.tabs
        .map(tab => toFileExplorerTabRecord(tab))
        .filter((record): record is FileExplorerTabRecord => record !== null),
      activeTabId: state.activeTabId,
      savedAt: new Date().toISOString(),
    };
    storage.setItem(getFileExplorerStateStorageKey(workspaceId), JSON.stringify(data));
    return true;
  } catch (error) {
    console.warn('[fileExplorer] explorer state was not written to localStorage:', error);
    return false;
  }
}

/**
 * Reads a workspace's explorer tabs back, or null when there is nothing usable.
 * Same stance as `readPersistedWindowState`: the value is arbitrary browser
 * text, and every way it can be wrong has the same answer -- restore no tabs --
 * so none of them throws.
 * @req FR-FEX-003
 */
export function readPersistedFileExplorerState(
  workspaceId: string,
  storage: Storage = localStorage,
): PersistedFileExplorerState | null {
  try {
    const raw = storage.getItem(getFileExplorerStateStorageKey(workspaceId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const { schemaVersion, tabs, activeTabId, savedAt } = parsed as Partial<PersistedFileExplorerState>;
    if (schemaVersion !== FILE_EXPLORER_SCHEMA_VERSION || !Array.isArray(tabs)) {
      return null;
    }

    return {
      schemaVersion: FILE_EXPLORER_SCHEMA_VERSION,
      tabs: tabs
        .map(tab => toFileExplorerTabRecord(tab))
        .filter((record): record is FileExplorerTabRecord => record !== null),
      activeTabId: typeof activeTabId === 'string' ? activeTabId : null,
      savedAt: typeof savedAt === 'string' ? savedAt : '',
    };
  } catch {
    return null;
  }
}
