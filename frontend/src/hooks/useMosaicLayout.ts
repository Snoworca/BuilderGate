import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { MosaicNode } from '../types/workspace';
import {
  buildEqualColumnsMosaicTree,
  buildRecoveredEqualMosaicTree,
  buildEqualMosaicTree,
  extractLeafIds,
  inferEqualLayoutArrangement,
  restoreLayoutWithSessionRecovery,
} from '../utils/mosaic';
import {
  readPersistedMosaicLayout,
  releaseMosaicLayoutSaveSuppression,
  saveMosaicLayoutForWorkspace,
  type AnyPersistedMosaicLayout,
  type EqualLayoutPreset,
} from './mosaicLayoutStorage';

export {
  clearMosaicLayoutForWorkspace,
  getMosaicLayoutStorageKey,
  isMosaicLayoutSaveSuppressed,
  pruneMosaicLayoutForMovedTab,
  releaseMosaicLayoutSaveSuppression,
  saveMosaicLayoutForWorkspace,
  suppressMosaicLayoutSaveForWorkspace,
} from './mosaicLayoutStorage';

export type LayoutMode = 'equal' | 'focus' | 'auto' | 'none';

interface ResolvedMosaicLayout {
  tree: MosaicNode<string> | null;
  mode: LayoutMode;
  focusTarget: string | null;
  equalPreset: EqualLayoutPreset;
}

function loadLayout(workspaceId: string): AnyPersistedMosaicLayout | null {
  return readPersistedMosaicLayout(workspaceId);
}

function sanitizeModeState(
  tree: MosaicNode<string> | null,
  mode: LayoutMode,
  focusTarget: string | null,
): Pick<ResolvedMosaicLayout, 'mode' | 'focusTarget'> {
  if (!tree) {
    return {
      mode: mode === 'focus' ? 'equal' : mode,
      focusTarget: null,
    };
  }

  if (mode !== 'focus') {
    return { mode, focusTarget: null };
  }

  const leafIds = new Set(extractLeafIds(tree));
  if (!focusTarget || !leafIds.has(focusTarget)) {
    return { mode: 'equal', focusTarget: null };
  }

  return { mode, focusTarget };
}

function resolveLayoutState(
  workspaceId: string,
  currentTabIds?: string[],
): ResolvedMosaicLayout {
  const persisted = loadLayout(workspaceId);
  if (!persisted?.tree) {
    if (currentTabIds && currentTabIds.length > 0) {
      return {
        tree: buildEqualMosaicTree(currentTabIds),
        mode: 'equal',
        focusTarget: null,
        equalPreset: 'smart',
      };
    }

    return {
      tree: null,
      mode: 'equal',
      focusTarget: null,
      equalPreset: 'smart',
    };
  }

  const restored =
    currentTabIds && currentTabIds.length > 0
      ? restoreLayoutWithSessionRecovery(persisted.tree, currentTabIds)
      : null;
  const tree = restored?.tree ?? null;
  const recoveredFocusTarget =
    persisted.focusTarget && restored?.replacements[persisted.focusTarget]
      ? restored.replacements[persisted.focusTarget]
      : persisted.focusTarget;
  const { mode, focusTarget } = sanitizeModeState(
    tree,
    persisted.mode ?? 'equal',
    recoveredFocusTarget ?? null,
  );
  const equalPreset = persisted.schemaVersion === 2 ? persisted.equalPreset : 'smart';
  const resolvedTree =
    tree && mode === 'equal'
      ? equalPreset === 'columns'
        ? buildEqualColumnsMosaicTree(extractLeafIds(tree))
        : buildRecoveredEqualMosaicTree(tree, extractLeafIds(tree), inferEqualLayoutArrangement(tree))
      : tree;

  return {
    tree: resolvedTree,
    mode,
    focusTarget,
    equalPreset,
  };
}

export interface UseMosaicLayoutReturn {
  mosaicTree: MosaicNode<string> | null;
  setMosaicTree: Dispatch<SetStateAction<MosaicNode<string> | null>>;
  debouncedSave: () => void;
  layoutMode: LayoutMode;
  setLayoutMode: (mode: LayoutMode) => void;
  focusTarget: string | null;
  setFocusTarget: (target: string | null) => void;
  equalPreset: EqualLayoutPreset;
  setEqualPreset: (preset: EqualLayoutPreset) => void;
}

export function useMosaicLayout(workspaceId: string, currentTabIds?: string[]): UseMosaicLayoutReturn {
  const initialLayoutRef = useRef<ResolvedMosaicLayout | null>(null);
  if (initialLayoutRef.current === null) {
    releaseMosaicLayoutSaveSuppression(workspaceId);
    initialLayoutRef.current = resolveLayoutState(workspaceId, currentTabIds);
  }
  const previousWorkspaceIdRef = useRef(workspaceId);
  if (previousWorkspaceIdRef.current !== workspaceId) {
    releaseMosaicLayoutSaveSuppression(workspaceId);
    previousWorkspaceIdRef.current = workspaceId;
  }

  const [mosaicTree, setMosaicTreeState] = useState<MosaicNode<string> | null>(initialLayoutRef.current.tree);
  const [layoutMode, setLayoutModeState] = useState<LayoutMode>(initialLayoutRef.current.mode);
  const [focusTarget, setFocusTargetState] = useState<string | null>(initialLayoutRef.current.focusTarget);
  const [equalPreset, setEqualPresetState] = useState<EqualLayoutPreset>(initialLayoutRef.current.equalPreset);

  // Keep refs for debounce and beforeunload access
  const mosaicTreeRef = useRef(mosaicTree);
  const layoutModeRef = useRef(layoutMode);
  const focusTargetRef = useRef(focusTarget);
  const equalPresetRef = useRef(equalPreset);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  mosaicTreeRef.current = mosaicTree;
  layoutModeRef.current = layoutMode;
  focusTargetRef.current = focusTarget;
  equalPresetRef.current = equalPreset;

  const setMosaicTree = useCallback((next: SetStateAction<MosaicNode<string> | null>) => {
    setMosaicTreeState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      mosaicTreeRef.current = value;
      return value;
    });
  }, []);

  const setLayoutMode = useCallback((mode: LayoutMode) => {
    layoutModeRef.current = mode;
    setLayoutModeState(mode);
  }, []);

  const setFocusTarget = useCallback((target: string | null) => {
    focusTargetRef.current = target;
    setFocusTargetState(target);
  }, []);

  const setEqualPreset = useCallback((preset: EqualLayoutPreset) => {
    equalPresetRef.current = preset;
    setEqualPresetState(preset);
  }, []);

  // Re-load when workspaceId changes OR when currentTabIds content changes.
  // currentTabIds는 매 렌더마다 새 배열 참조이므로 내용 기반 비교를 위해 join 직렬화 사용.
  // currentTabIds가 stale 클로저로 캡처되면 restoreLayoutWithSessionRecovery에 잘못된
  // tabId가 전달되어 mosaicTree leaf가 tabMap에 없는 tabId를 갖게 되고,
  // MosaicTile이 tab=undefined → EmptyCell(+ 버튼 범람)을 렌더하는 버그 방지.
  const currentTabIdsKey = currentTabIds?.join(',') ?? '';
  useEffect(() => {
    const persisted = loadLayout(workspaceId);
    const resolved = resolveLayoutState(workspaceId, currentTabIds);
    setMosaicTree(resolved.tree);
    setLayoutMode(resolved.mode);
    setFocusTarget(resolved.focusTarget);
    setEqualPreset(resolved.equalPreset);

    if (resolved.tree) {
      const treeChanged = persisted?.tree
        ? JSON.stringify(persisted.tree) !== JSON.stringify(resolved.tree)
        : true;
      const modeChanged = (persisted?.mode ?? null) !== resolved.mode;
      const focusChanged = (persisted?.focusTarget ?? null) !== resolved.focusTarget;
      const equalPresetChanged =
        (persisted?.schemaVersion === 2 ? persisted.equalPreset : 'smart') !== resolved.equalPreset;
      if (treeChanged || modeChanged || focusChanged || equalPresetChanged) {
        saveMosaicLayoutForWorkspace(
          workspaceId,
          resolved.tree,
          resolved.mode,
          resolved.focusTarget,
          localStorage,
          resolved.equalPreset,
        );
      }
    }
  }, [workspaceId, currentTabIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const debouncedSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      saveMosaicLayoutForWorkspace(
        workspaceId,
        mosaicTreeRef.current,
        layoutModeRef.current,
        focusTargetRef.current,
        localStorage,
        equalPresetRef.current,
      );
    }, 2000);
  }, [workspaceId]);

  // beforeunload: cancel debounce + save immediately
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      saveMosaicLayoutForWorkspace(
        workspaceId,
        mosaicTreeRef.current,
        layoutModeRef.current,
        focusTargetRef.current,
        localStorage,
        equalPresetRef.current,
      );
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [workspaceId]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      saveMosaicLayoutForWorkspace(
        workspaceId,
        mosaicTreeRef.current,
        layoutModeRef.current,
        focusTargetRef.current,
        localStorage,
        equalPresetRef.current,
      );
    };
  }, [workspaceId]);

  return {
    mosaicTree,
    setMosaicTree,
    debouncedSave,
    layoutMode,
    setLayoutMode,
    focusTarget,
    setFocusTarget,
    equalPreset,
    setEqualPreset,
  };
}
