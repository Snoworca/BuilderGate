// Where an editor window's placement is kept between page loads, and the only
// thing that knows the key it is kept under.
//
// The split is the one `mosaicLayoutStorage` already uses: this module owns the
// key and the serialization, and `useWindowState` wraps it for React. A window
// belongs to the workspace whose tabs it is docked to, so the store is scoped
// per workspace exactly as the mosaic layout is -- a global one would carry
// entries whose tab ids mean nothing in the workspace being restored.
//
// What is written is `toEditorWindowRecord`'s projection and nothing else. That
// projection is what drops the unsaved body, the session id and the cascade
// step; naming it here rather than serializing the live window is what keeps
// those three out of a value the user can read in their browser.
//
// @req FR-MDE-009

import {
  isEditorWindowRecord,
  restoreEditorWindowRecords,
  toEditorWindowRecord,
  type EditorWindowRecord,
} from '../components/editor/editorWindowRecord.ts';

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
 * Writes the placement of every window in a workspace.
 *
 * Each window goes through `toEditorWindowRecord`, which projects field by
 * field. Spreading the live window instead would carry the body, the session
 * id and the cascade step into a store that is readable in the browser, and
 * the body in particular would turn every reload into a three-way question
 * between what is stored, what is on disk and what the user remembers.
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
 * The windows to recreate for a workspace, in the order they are to be created.
 *
 * The order is the stored stack order rather than the order the records happen
 * to sit in, and it is load-bearing: a restored window is raised into the
 * modeless stack in the order it comes back, so creating
 * them in a different order hands the steps out differently and the restored
 * layout stops matching the saved one. The step itself is deliberately not
 * stored -- it is recomputed from this order, which is why there is no second
 * copy of it to disagree with the rule.
 *
 * A window whose tab is gone is not restored at all: it has no terminal to dock
 * to and no session to save through.
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
