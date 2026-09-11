// The React face of the per-workspace document store.
//
// It holds no state of its own. The documents themselves live in
// `useEditorWindows`, and duplicating them here would give the app two lists
// that only ever disagree; what this hook adds is the workspace binding, so no
// caller has to carry the workspace id to every read and write.
//
// There is no debounce, unlike `useMosaicLayout`, because there is nothing to
// debounce: what is written changes when a document opens or closes, not while
// a window is being dragged -- the rect goes to the global geometry key and
// never reaches here. A timer would only delay that single write past the
// reload it exists to survive.
//
// @req FR-MDE-009

import { useCallback } from 'react';
import type { EditorWindowRecord } from '../components/editor/editorWindowRecord.ts';
import {
  restoreWindowStateForWorkspace,
  saveWindowStateForWorkspace,
} from './windowStateStorage.ts';

/**
 * The workspace whose windows are held, or null when there is none yet.
 *
 * Null is answered rather than refused, and it is the parameter type rather
 * than a caller's guard, because a hook cannot be called conditionally: a
 * caller with no workspace has to call this anyway, and a `string` parameter
 * would leave it spelling some placeholder that then becomes a storage key.
 * @req FR-MDE-009
 */
export interface UseWindowStateResult {
  /**
   * The windows stored for this workspace whose tab still exists, in the order
   * they are to be created. Empty when nothing is stored or the stored value
   * cannot be read.
   */
  restoreWindows: (existingTabIds: Iterable<string>) => EditorWindowRecord[];
  /**
   * Replaces what is stored for this workspace with the windows given, and
   * answers whether the write happened. The answer is carried through rather
   * than swallowed here: this hook is the only route to the store, so dropping
   * it would leave no caller able to tell a full quota from a saved layout.
   *
   * An empty list is a write, not a no-op -- closing the last window has to
   * clear the store, or a reload would bring it back. A caller must therefore
   * restore before it starts saving, or its first save erases what it was about
   * to restore.
   */
  saveWindows: (windows: readonly EditorWindowRecord[]) => boolean;
}

/**
 * @req FR-MDE-009
 */
export function useWindowState(workspaceId: string | null): UseWindowStateResult {
  const restoreWindows = useCallback(
    (existingTabIds: Iterable<string>) => (
      workspaceId === null ? [] : restoreWindowStateForWorkspace(workspaceId, existingTabIds)
    ),
    [workspaceId],
  );

  const saveWindows = useCallback(
    (windows: readonly EditorWindowRecord[]) => (
      workspaceId !== null && saveWindowStateForWorkspace(workspaceId, windows)
    ),
    [workspaceId],
  );

  return { restoreWindows, saveWindows };
}
