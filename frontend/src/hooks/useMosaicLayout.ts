import { useState, useCallback, useEffect, useRef } from 'react';
import type { MosaicNode } from '../types/workspace';
import { buildEqualMosaicTree, isValidMosaicTree, restoreLayoutWithSessionRecovery } from '../utils/mosaic';

export type LayoutMode = 'equal' | 'focus' | 'auto';

interface PersistedMosaicLayout {
  schemaVersion: 1;
  tree: MosaicNode<string>;
  mode: LayoutMode;
  focusTarget: string | null;
  savedAt: string;
}

const STORAGE_KEY_PREFIX = 'mosaic_layout_';

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
  setMosaicTree: (tree: MosaicNode<string> | null) => void;
  debouncedSave: () => void;
  layoutMode: LayoutMode;
  setLayoutMode: (mode: LayoutMode) => void;
  focusTarget: string | null;
  setFocusTarget: (target: string | null) => void;
}

export function useMosaicLayout(workspaceId: string, currentTabIds?: string[]): UseMosaicLayoutReturn {
  const [mosaicTree, setMosaicTree] = useState<MosaicNode<string> | null>(() => {
    const persisted = loadLayout(workspaceId);
    if (!persisted?.tree) return null;
    if (currentTabIds && currentTabIds.length > 0) {
      const { tree } = restoreLayoutWithSessionRecovery(persisted.tree, currentTabIds);
      return tree;
    }
    return persisted.tree;
  });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    const persisted = loadLayout(workspaceId);
    return persisted?.mode ?? 'equal';
  });
  const [focusTarget, setFocusTarget] = useState<string | null>(() => {
    const persisted = loadLayout(workspaceId);
    return persisted?.focusTarget ?? null;
  });

  // Keep refs for debounce and beforeunload access
  const mosaicTreeRef = useRef(mosaicTree);
  const layoutModeRef = useRef(layoutMode);
  const focusTargetRef = useRef(focusTarget);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  mosaicTreeRef.current = mosaicTree;
  layoutModeRef.current = layoutMode;
  focusTargetRef.current = focusTarget;

  // Re-load when workspaceId changes
  useEffect(() => {
    const persisted = loadLayout(workspaceId);
    if (persisted?.tree) {
      if (currentTabIds && currentTabIds.length > 0) {
        const { tree } = restoreLayoutWithSessionRecovery(persisted.tree, currentTabIds);
        setMosaicTree(tree);
      } else {
        setMosaicTree(persisted.tree);
      }
      setLayoutMode(persisted.mode ?? 'equal');
      setFocusTarget(persisted.focusTarget ?? null);
    } else if (currentTabIds && currentTabIds.length > 0) {
      setMosaicTree(buildEqualMosaicTree(currentTabIds));
      setLayoutMode('equal');
      setFocusTarget(null);
    } else {
      setMosaicTree(null);
      setLayoutMode('equal');
      setFocusTarget(null);
    }
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

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
