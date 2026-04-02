import { useState, useCallback } from 'react';
import type { MosaicNode, WorkspaceTabRuntime } from '../types/workspace';
import {
  applyEqualMode,
  applyFocusMode,
  applyMultiFocusApprox,
  getMinPercentage,
} from '../utils/mosaic';

export type LayoutMode = 'equal' | 'focus' | 'auto';

export interface UseLayoutModeReturn {
  mode: LayoutMode;
  focusTarget: string | null;
  setMode: (mode: LayoutMode, focusTabId?: string) => void;
  applyToTree: (tree: MosaicNode<string>, tabs: WorkspaceTabRuntime[]) => MosaicNode<string>;
}

export function useLayoutMode(
  initialMode: LayoutMode = 'equal',
  initialFocusTarget: string | null = null,
): UseLayoutModeReturn {
  const [mode, setModeState] = useState<LayoutMode>(initialMode);
  const [focusTarget, setFocusTarget] = useState<string | null>(initialFocusTarget);

  const setMode = useCallback((nextMode: LayoutMode, focusTabId?: string) => {
    setModeState(nextMode);
    if (nextMode === 'focus') {
      setFocusTarget(focusTabId ?? null);
    } else {
      setFocusTarget(null);
    }
  }, []);

  const applyToTree = useCallback(
    (tree: MosaicNode<string>, tabs: WorkspaceTabRuntime[]): MosaicNode<string> => {
      const minPercent = getMinPercentage(tabs.length);

      if (mode === 'equal') {
        return applyEqualMode(tree);
      }

      if (mode === 'focus') {
        if (!focusTarget) return applyEqualMode(tree);
        return applyFocusMode(tree, focusTarget, minPercent);
      }

      // auto mode: expand non-idle sessions, shrink idle ones
      const idleIds = new Set(
        tabs.filter(t => t.status === 'idle').map(t => t.id),
      );
      return applyMultiFocusApprox(tree, idleIds, minPercent);
    },
    [mode, focusTarget],
  );

  return { mode, focusTarget, setMode, applyToTree };
}
