import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { MosaicNode } from '../types/workspace';
import {
  buildRecoveredEqualMosaicTree,
  buildEqualMosaicTree,
  extractLeafIds,
  inferEqualLayoutArrangement,
  isValidMosaicTree,
  restoreLayoutWithSessionRecovery,
} from '../utils/mosaic';

export type LayoutMode = 'equal' | 'focus' | 'auto' | 'none';

interface PersistedMosaicLayout {
  schemaVersion: 1;
  tree: MosaicNode<string>;
  mode: LayoutMode;
  focusTarget: string | null;
  savedAt: string;
}

const STORAGE_KEY_PREFIX = 'mosaic_layout_';

interface ResolvedMosaicLayout {
  tree: MosaicNode<string> | null;
  mode: LayoutMode;
  focusTarget: string | null;
}

function loadLayout(workspaceId: string): PersistedMosaicLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + workspaceId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedMosaicLayout;
    if (parsed.schemaVersion !== 1) return null;
    if (!isValidMosaicTree(parsed.tree)) return null;
    return parsed;
  } catch {
    return null;
  }
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
      };
    }

    return {
      tree: null,
      mode: 'equal',
      focusTarget: null,
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
  const resolvedTree =
    tree && mode === 'equal'
      ? buildRecoveredEqualMosaicTree(tree, extractLeafIds(tree), inferEqualLayoutArrangement(tree))
      : tree;

  return { tree: resolvedTree, mode, focusTarget };
}

function saveLayout(
  workspaceId: string,
  tree: MosaicNode<string> | null,
  mode: LayoutMode,
  focusTarget: string | null,
): void {
  if (!tree) return;
  try {
    const data: PersistedMosaicLayout = {
      schemaVersion: 1,
      tree,
      mode,
      focusTarget,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY_PREFIX + workspaceId, JSON.stringify(data));
  } catch (e) {
    console.warn('[useMosaicLayout] localStorage quota exceeded, skipping save:', e);
  }
}

export interface UseMosaicLayoutReturn {
  mosaicTree: MosaicNode<string> | null;
  setMosaicTree: Dispatch<SetStateAction<MosaicNode<string> | null>>;
  debouncedSave: () => void;
  layoutMode: LayoutMode;
  setLayoutMode: (mode: LayoutMode) => void;
  focusTarget: string | null;
  setFocusTarget: (target: string | null) => void;
}

export function useMosaicLayout(workspaceId: string, currentTabIds?: string[]): UseMosaicLayoutReturn {
  const initialLayoutRef = useRef<ResolvedMosaicLayout | null>(null);
  if (initialLayoutRef.current === null) {
    initialLayoutRef.current = resolveLayoutState(workspaceId, currentTabIds);
  }

  const [mosaicTree, setMosaicTreeState] = useState<MosaicNode<string> | null>(initialLayoutRef.current.tree);
  const [layoutMode, setLayoutModeState] = useState<LayoutMode>(initialLayoutRef.current.mode);
  const [focusTarget, setFocusTargetState] = useState<string | null>(initialLayoutRef.current.focusTarget);

  // Keep refs for debounce and beforeunload access
  const mosaicTreeRef = useRef(mosaicTree);
  const layoutModeRef = useRef(layoutMode);
  const focusTargetRef = useRef(focusTarget);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  mosaicTreeRef.current = mosaicTree;
  layoutModeRef.current = layoutMode;
  focusTargetRef.current = focusTarget;

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

    if (resolved.tree) {
      const treeChanged = persisted?.tree
        ? JSON.stringify(persisted.tree) !== JSON.stringify(resolved.tree)
        : true;
      const modeChanged = (persisted?.mode ?? null) !== resolved.mode;
      const focusChanged = (persisted?.focusTarget ?? null) !== resolved.focusTarget;
      if (treeChanged || modeChanged || focusChanged) {
        saveLayout(workspaceId, resolved.tree, resolved.mode, resolved.focusTarget);
      }
    }
  }, [workspaceId, currentTabIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const debouncedSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      saveLayout(workspaceId, mosaicTreeRef.current, layoutModeRef.current, focusTargetRef.current);
    }, 2000);
  }, [workspaceId]);

  // beforeunload: cancel debounce + save immediately
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      saveLayout(workspaceId, mosaicTreeRef.current, layoutModeRef.current, focusTargetRef.current);
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
      saveLayout(workspaceId, mosaicTreeRef.current, layoutModeRef.current, focusTargetRef.current);
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
  };
}
