// Thin React binding for the file explorer tree. Every rule lives elsewhere:
// state transitions in fileTreeReducer, when to read and which answer counts in
// the controller. This hook only wires them to React and to the file API.
//
// The tree cache is keyed by path, not by session, so on a session change the
// cache and selection are dropped before the new session lists its root.
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createFileTreeController, normalizeTreePath, type FileTreeController } from '../components/fileExplorer/fileTreeController.ts';
import {
  createInitialFileTreeState,
  fileTreeReducer,
  type FileTreeAction,
  type FileTreeMode,
  type FileTreeState,
} from '../components/fileExplorer/fileTreeState.ts';
import { fileApi } from '../services/api.ts';

export interface UseFileTreeResult extends FileTreeController {
  state: FileTreeState;
  // For selection actions (CLICK_ROW, SELECT_ALL, CLEAR_SELECTION) raised by rows.
  dispatch: (action: FileTreeAction) => void;
}

export function useFileTree(sessionId: string, initialRoot: string, initialMode: FileTreeMode = 'tree'): UseFileTreeResult {
  const [state, reactDispatch] = useReducer(
    fileTreeReducer,
    { root: normalizeTreePath(initialRoot), mode: initialMode },
    createInitialFileTreeState,
  );

  // The controller reads state right after dispatching, before React re-renders,
  // so it gets a mirror advanced by the same pure reducer in the same order.
  const stateRef = useRef(state);
  const dispatch = useCallback((action: FileTreeAction) => {
    stateRef.current = fileTreeReducer(stateRef.current, action);
    reactDispatch(action);
  }, []);

  // Only the controller currently mounted may dispatch. Identity, not session
  // id: after A -> B -> A the first A controller would pass a session check and
  // bypass the new controller's request tokens. A guard rather than
  // dispose-on-cleanup, because StrictMode runs cleanup and re-runs the effect
  // on the same memoized controller.
  const activeControllerRef = useRef<FileTreeController | null>(null);
  const controller = useMemo(() => {
    const created: FileTreeController = createFileTreeController({
      sessionId,
      listDirectory: fileApi.listDirectory,
      getState: () => stateRef.current,
      dispatch: (action) => {
        if (activeControllerRef.current === created) dispatch(action);
      },
    });
    return created;
  }, [sessionId, dispatch]);

  const listedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    activeControllerRef.current = controller;
    if (listedSessionRef.current !== null && listedSessionRef.current !== sessionId) {
      // The previous session's listings (and any request it left 'loading')
      // must not show, or suppress reads, under the new session.
      dispatch({ type: 'INVALIDATE_DIRECTORIES', affectedDirectories: [...stateRef.current.childrenByPath.keys()] });
      dispatch({ type: 'CLEAR_SELECTION' });
    }
    listedSessionRef.current = sessionId;
    return () => {
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    };
  }, [controller, sessionId, dispatch]);

  useEffect(() => {
    void controller.setRoot(initialRoot);
  }, [controller, initialRoot]);

  return useMemo(() => ({
    state,
    dispatch,
    setRoot: controller.setRoot,
    goUp: controller.goUp,
    expand: controller.expand,
    collapse: controller.collapse,
    refresh: controller.refresh,
    setMode: controller.setMode,
    applyJobDone: controller.applyJobDone,
    deselect: controller.deselect,
  }), [state, dispatch, controller]);
}
