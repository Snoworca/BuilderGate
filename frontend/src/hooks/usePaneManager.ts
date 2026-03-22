// ============================================================================
// BuilderGate Pane Split System - Core State Management Hook
// Manages pane layout, focus, zoom, split/close, swap, presets, prefix mode.
// ============================================================================

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type {
  PaneLayout,
  PaneNode,
  PaneLeaf,
  Direction,
  FocusDirection,
  PresetType,
} from '../types/pane.types';
import { PANE_CONSTANTS, BUILT_IN_PRESETS } from '../types/pane.types';
import {
  splitPane as treeSplit,
  closePane as treeClose,
  resizePane as treeResize,
  swapPanes as treeSwap,
  toggleDirection as treeToggle,
  flattenPaneTree,
  findPane,
  countPanes,
  getTreeDepth,
  equalizeRatios as treeEqualize,
  getAdjacentPane,
  buildPresetLayout,
} from '../utils/paneTree';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsePaneManagerOptions {
  activeSessionId: string | null;
  createSession: (
    name?: string,
    shell?: string,
    cwd?: string,
    visible?: boolean,
  ) => Promise<any>;
  deleteSession: (sessionId: string) => Promise<void>;
  getCwd: (sessionId: string) => string | undefined;
  paneDB: {
    saveLayout: (sessionId: string, layout: PaneLayout) => Promise<void>;
    loadLayout: (sessionId: string) => Promise<PaneLayout | null>;
    deleteLayout: (sessionId: string) => Promise<void>;
  };
}

interface UsePaneManagerReturn {
  layout: PaneLayout;
  prefixMode: boolean;
  swapSource: string | null;
  paneNumberOverlay: boolean;

  splitPane: (paneId: string, direction: Direction) => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  closeOtherPanes: (keepPaneId: string) => Promise<void>;

  setFocusedPane: (paneId: string) => void;
  moveFocus: (direction: FocusDirection) => void;
  cycleFocus: () => void;
  toggleZoom: (paneId?: string) => void;

  resizePane: (splitId: string, ratio: number) => void;
  equalizePanes: (splitId: string) => void;
  toggleDirection: (splitId: string) => void;

  startSwap: (paneId: string) => void;
  executeSwap: (targetPaneId: string) => void;
  cancelSwap: () => void;

  applyPreset: (preset: PresetType) => Promise<void>;

  enterPrefixMode: () => void;
  exitPrefixMode: () => void;
  handlePrefixKey: (
    key: string,
    ctrlKey: boolean,
    shiftKey: boolean,
  ) => void;

  showPaneNumbers: () => void;
  selectPaneByNumber: (num: number) => void;

  paneCount: number;
  treeDepth: number;
  canSplit: boolean;
  allSessionIds: string[];
  isZoomed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDefaultLayout(sessionId: string): PaneLayout {
  const leaf: PaneLeaf = {
    type: 'terminal',
    id: crypto.randomUUID(),
    sessionId,
  };
  return {
    root: leaf,
    focusedPaneId: leaf.id,
    zoomedPaneId: null,
  };
}

const DEBOUNCE_MS = 300;
const PREFIX_TIMEOUT_MS = 1500;
const PANE_NUMBER_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePaneManager(options: UsePaneManagerOptions): UsePaneManagerReturn {
  const {
    activeSessionId,
    createSession,
    deleteSession,
    getCwd,
    paneDB,
  } = options;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const [layout, setLayout] = useState<PaneLayout>(() => {
    if (activeSessionId) {
      return createDefaultLayout(activeSessionId);
    }
    // No session yet — create a placeholder that will be replaced on init
    return createDefaultLayout('');
  });

  const [prefixMode, setPrefixMode] = useState(false);
  const [swapSource, setSwapSource] = useState<string | null>(null);
  const [paneNumberOverlay, setPaneNumberOverlay] = useState(false);

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paneNumberTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSessionIdRef = useRef<string | null>(activeSessionId);
  const layoutRef = useRef<PaneLayout>(layout);

  // Keep layoutRef in sync
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // -------------------------------------------------------------------------
  // Debounced save
  // -------------------------------------------------------------------------

  const debouncedSave = useCallback(
    (newLayout: PaneLayout) => {
      if (!activeSessionId) return;

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        paneDB.saveLayout(activeSessionId, newLayout).catch((err) => {
          console.warn('usePaneManager: debounced save failed', err);
        });
      }, DEBOUNCE_MS);
    },
    [activeSessionId, paneDB],
  );

  const saveNow = useCallback(
    (layoutToSave?: PaneLayout) => {
      if (!activeSessionId) return;

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      const target = layoutToSave ?? layoutRef.current;
      paneDB.saveLayout(activeSessionId, target).catch((err) => {
        console.warn('usePaneManager: immediate save failed', err);
      });
    },
    [activeSessionId, paneDB],
  );

  // -------------------------------------------------------------------------
  // Helper: update layout + trigger debounced save
  // -------------------------------------------------------------------------

  const updateLayout = useCallback(
    (updater: (prev: PaneLayout) => PaneLayout) => {
      setLayout((prev) => {
        const next = updater(prev);
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // -------------------------------------------------------------------------
  // Initialization: load layout from IndexedDB on mount / session change
  // -------------------------------------------------------------------------

  useEffect(() => {
    const prevSessionId = currentSessionIdRef.current;
    currentSessionIdRef.current = activeSessionId;

    // Save the previous session's layout immediately before switching
    if (prevSessionId && prevSessionId !== activeSessionId) {
      paneDB.saveLayout(prevSessionId, layoutRef.current).catch((err) => {
        console.warn('usePaneManager: save on session switch failed', err);
      });
    }

    if (!activeSessionId) return;

    let cancelled = false;

    (async () => {
      try {
        const saved = await paneDB.loadLayout(activeSessionId);
        if (cancelled) return;

        if (saved) {
          // Validate that the saved layout references valid structure
          setLayout(saved);
        } else {
          const defaultLayout = createDefaultLayout(activeSessionId);
          setLayout(defaultLayout);
        }
      } catch (err) {
        console.warn('usePaneManager: loadLayout failed, using default', err);
        if (!cancelled) {
          setLayout(createDefaultLayout(activeSessionId));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // -------------------------------------------------------------------------
  // visibilitychange: save immediately when tab goes hidden
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveNow();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [saveNow]);

  // Cleanup save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // splitPane
  // -------------------------------------------------------------------------

  const splitPaneFn = useCallback(
    async (paneId: string, direction: Direction) => {
      const currentLayout = layoutRef.current;
      const pc = countPanes(currentLayout.root);
      const depth = getTreeDepth(currentLayout.root);

      if (pc >= PANE_CONSTANTS.MAX_PANES) {
        console.warn(`usePaneManager: cannot split — max panes (${PANE_CONSTANTS.MAX_PANES}) reached`);
        return;
      }

      if (depth >= PANE_CONSTANTS.MAX_DEPTH) {
        console.warn(`usePaneManager: cannot split — max depth (${PANE_CONSTANTS.MAX_DEPTH}) reached`);
        return;
      }

      // Find the pane to get its session's CWD
      const targetPane = findPane(currentLayout.root, paneId);
      if (!targetPane) {
        console.warn(`usePaneManager: splitPane — pane "${paneId}" not found`);
        return;
      }

      const parentCwd = getCwd(targetPane.sessionId);

      // Create a new session — wait for API success before updating tree
      let newSession: any;
      try {
        newSession = await createSession('Sub-Terminal', undefined, parentCwd, false);
      } catch (err) {
        console.error('usePaneManager: splitPane — createSession failed', err);
        return;
      }

      if (!newSession || !newSession.id) {
        console.error('usePaneManager: splitPane — createSession returned no session');
        return;
      }

      // Success — update the tree
      updateLayout((prev) => {
        const newRoot = treeSplit(prev.root, paneId, direction, newSession.id);
        // Find the new leaf to set focus
        const leaves = flattenPaneTree(newRoot);
        const newLeaf = leaves.find((l) => l.sessionId === newSession.id);
        return {
          ...prev,
          root: newRoot,
          focusedPaneId: newLeaf ? newLeaf.id : prev.focusedPaneId,
          zoomedPaneId: null, // exit zoom on split
        };
      });
    },
    [createSession, getCwd, updateLayout],
  );

  // -------------------------------------------------------------------------
  // closePane
  // -------------------------------------------------------------------------

  const closePaneFn = useCallback(
    async (paneId: string) => {
      const currentLayout = layoutRef.current;
      const targetPane = findPane(currentLayout.root, paneId);

      if (!targetPane) {
        console.warn(`usePaneManager: closePane — pane "${paneId}" not found`);
        return;
      }

      // Delete the session from the server
      try {
        await deleteSession(targetPane.sessionId);
      } catch (err) {
        console.error('usePaneManager: closePane — deleteSession failed', err);
        // Continue closing the pane in the UI even if server delete fails
      }

      updateLayout((prev) => {
        const newRoot = treeClose(prev.root, paneId);

        // If root becomes null, this was the last pane — shouldn't happen in
        // normal flow, but handle gracefully
        if (newRoot === null) {
          // Return a "dead" layout — the parent component should handle this
          const emptyLeaf: PaneLeaf = {
            type: 'terminal',
            id: crypto.randomUUID(),
            sessionId: '',
          };
          return {
            root: emptyLeaf,
            focusedPaneId: emptyLeaf.id,
            zoomedPaneId: null,
          };
        }

        // Determine new focus: try adjacent pane, otherwise first leaf
        let newFocusId = prev.focusedPaneId;
        if (prev.focusedPaneId === paneId) {
          const adjacent =
            getAdjacentPane(prev.root, paneId, 'right') ??
            getAdjacentPane(prev.root, paneId, 'left') ??
            getAdjacentPane(prev.root, paneId, 'down') ??
            getAdjacentPane(prev.root, paneId, 'up');

          if (adjacent) {
            newFocusId = adjacent.id;
          } else {
            const leaves = flattenPaneTree(newRoot);
            newFocusId = leaves.length > 0 ? leaves[0].id : '';
          }
        }

        // Clear zoom if zoomed pane was closed
        const newZoomed =
          prev.zoomedPaneId === paneId ? null : prev.zoomedPaneId;

        return {
          root: newRoot,
          focusedPaneId: newFocusId,
          zoomedPaneId: newZoomed,
        };
      });
    },
    [deleteSession, updateLayout],
  );

  // -------------------------------------------------------------------------
  // closeOtherPanes
  // -------------------------------------------------------------------------

  const closeOtherPanes = useCallback(
    async (keepPaneId: string) => {
      const currentLayout = layoutRef.current;
      const keepPane = findPane(currentLayout.root, keepPaneId);

      if (!keepPane) {
        console.warn(`usePaneManager: closeOtherPanes — pane "${keepPaneId}" not found`);
        return;
      }

      const allLeaves = flattenPaneTree(currentLayout.root);
      const toDelete = allLeaves.filter((l) => l.id !== keepPaneId);

      // Delete sessions one by one, continue on failure
      for (const leaf of toDelete) {
        try {
          await deleteSession(leaf.sessionId);
        } catch (err) {
          console.warn(
            `usePaneManager: closeOtherPanes — failed to delete session "${leaf.sessionId}"`,
            err,
          );
        }
      }

      // Build new single-pane layout
      updateLayout(() => {
        const newLeaf: PaneLeaf = {
          type: 'terminal',
          id: keepPane.id,
          sessionId: keepPane.sessionId,
        };
        return {
          root: newLeaf,
          focusedPaneId: keepPane.id,
          zoomedPaneId: null,
        };
      });
    },
    [deleteSession, updateLayout],
  );

  // -------------------------------------------------------------------------
  // Focus management
  // -------------------------------------------------------------------------

  const setFocusedPane = useCallback(
    (paneId: string) => {
      updateLayout((prev) => {
        if (prev.focusedPaneId === paneId) return prev;
        return { ...prev, focusedPaneId: paneId };
      });
    },
    [updateLayout],
  );

  const moveFocus = useCallback(
    (direction: FocusDirection) => {
      setLayout((prev) => {
        const adjacent = getAdjacentPane(prev.root, prev.focusedPaneId, direction);
        if (!adjacent) return prev;

        const next = { ...prev, focusedPaneId: adjacent.id };
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const cycleFocus = useCallback(() => {
    setLayout((prev) => {
      const leaves = flattenPaneTree(prev.root);
      if (leaves.length <= 1) return prev;

      const currentIndex = leaves.findIndex((l) => l.id === prev.focusedPaneId);
      const nextIndex = (currentIndex + 1) % leaves.length;

      const next = { ...prev, focusedPaneId: leaves[nextIndex].id };
      debouncedSave(next);
      return next;
    });
  }, [debouncedSave]);

  // -------------------------------------------------------------------------
  // Zoom
  // -------------------------------------------------------------------------

  const toggleZoom = useCallback(
    (paneId?: string) => {
      updateLayout((prev) => {
        const target = paneId ?? prev.focusedPaneId;

        if (prev.zoomedPaneId === target) {
          // Un-zoom
          return { ...prev, zoomedPaneId: null };
        }

        // Zoom into the target pane
        return {
          ...prev,
          zoomedPaneId: target,
          focusedPaneId: target,
        };
      });
    },
    [updateLayout],
  );

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  const resizePaneFn = useCallback(
    (splitId: string, ratio: number) => {
      setLayout((prev) => ({
        ...prev,
        root: treeResize(prev.root, splitId, ratio),
      }));
      // No debounce here — caller (drag handler) will call saveNow on mouseup
    },
    [],
  );

  const equalizePanes = useCallback(
    (splitId: string) => {
      updateLayout((prev) => ({
        ...prev,
        root: treeEqualize(prev.root, splitId),
      }));
    },
    [updateLayout],
  );

  const toggleDirectionFn = useCallback(
    (splitId: string) => {
      updateLayout((prev) => ({
        ...prev,
        root: treeToggle(prev.root, splitId),
      }));
    },
    [updateLayout],
  );

  // -------------------------------------------------------------------------
  // Swap
  // -------------------------------------------------------------------------

  const startSwap = useCallback((paneId: string) => {
    setSwapSource(paneId);
  }, []);

  const executeSwap = useCallback(
    (targetPaneId: string) => {
      if (!swapSource) return;
      if (swapSource === targetPaneId) {
        setSwapSource(null);
        return;
      }

      updateLayout((prev) => ({
        ...prev,
        root: treeSwap(prev.root, swapSource, targetPaneId),
      }));

      setSwapSource(null);
    },
    [swapSource, updateLayout],
  );

  const cancelSwap = useCallback(() => {
    setSwapSource(null);
  }, []);

  // -------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------

  const applyPreset = useCallback(
    async (preset: PresetType) => {
      const currentLayout = layoutRef.current;
      const existingLeaves = flattenPaneTree(currentLayout.root);

      // Determine how many panes the preset needs
      const presetMeta = BUILT_IN_PRESETS.find((p) => p.type === preset);
      const neededCount = presetMeta ? presetMeta.paneCount : 1;

      // Delete all existing sessions
      for (const leaf of existingLeaves) {
        if (leaf.sessionId) {
          try {
            await deleteSession(leaf.sessionId);
          } catch (err) {
            console.warn(
              `usePaneManager: applyPreset — failed to delete session "${leaf.sessionId}"`,
              err,
            );
          }
        }
      }

      // Create N new sessions
      const newSessionIds: string[] = [];
      for (let i = 0; i < neededCount; i++) {
        try {
          const session = await createSession(
            i === 0 ? 'Terminal' : `Sub-Terminal ${i}`,
            undefined,
            undefined,
            false,
          );
          if (session?.id) {
            newSessionIds.push(session.id);
          }
        } catch (err) {
          console.error(`usePaneManager: applyPreset — failed to create session ${i + 1}`, err);
        }
      }

      // If we didn't get enough sessions, pad with whatever we have
      if (newSessionIds.length === 0) {
        console.error('usePaneManager: applyPreset — no sessions created');
        return;
      }

      // If fewer sessions than needed, duplicate the last one to fill
      while (newSessionIds.length < neededCount) {
        newSessionIds.push(newSessionIds[newSessionIds.length - 1]);
      }

      // Build the preset layout
      const newLayout = buildPresetLayout(preset, newSessionIds);

      setLayout(newLayout);
      debouncedSave(newLayout);
    },
    [createSession, deleteSession, debouncedSave],
  );

  // -------------------------------------------------------------------------
  // Prefix mode (tmux-like key prefix, stubs for Phase 5 keybinding)
  // -------------------------------------------------------------------------

  const exitPrefixMode = useCallback(() => {
    setPrefixMode(false);
    if (prefixTimerRef.current) {
      clearTimeout(prefixTimerRef.current);
      prefixTimerRef.current = null;
    }
  }, []);

  const enterPrefixMode = useCallback(() => {
    setPrefixMode(true);

    // Auto-exit after timeout
    if (prefixTimerRef.current) {
      clearTimeout(prefixTimerRef.current);
    }
    prefixTimerRef.current = setTimeout(() => {
      prefixTimerRef.current = null;
      setPrefixMode(false);
    }, PREFIX_TIMEOUT_MS);
  }, []);

  const handlePrefixKey = useCallback(
    (key: string, ctrlKey: boolean, shiftKey: boolean) => {
      if (!prefixMode) return;

      const currentLayout = layoutRef.current;
      const focusedId = currentLayout.focusedPaneId;

      switch (key) {
        // Split horizontal
        case '-':
          splitPaneFn(focusedId, 'horizontal');
          break;

        // Split vertical
        case '|':
        case '\\':
          splitPaneFn(focusedId, 'vertical');
          break;

        // Close pane
        case 'x':
          closePaneFn(focusedId);
          break;

        // Focus movement
        case 'ArrowUp':
        case 'k':
          moveFocus('up');
          break;
        case 'ArrowDown':
        case 'j':
          moveFocus('down');
          break;
        case 'ArrowLeft':
        case 'h':
          moveFocus('left');
          break;
        case 'ArrowRight':
        case 'l':
          moveFocus('right');
          break;

        // Cycle focus
        case 'o':
          cycleFocus();
          break;

        // Zoom toggle
        case 'z':
          toggleZoom();
          break;

        // Swap mode
        case 's':
          startSwap(focusedId);
          break;

        // Pane numbers
        case 'q':
          showPaneNumbersFn();
          break;

        default:
          // Number keys 1-9 for pane selection
          if (/^[1-9]$/.test(key)) {
            selectPaneByNumberFn(parseInt(key, 10));
          }
          break;
      }

      exitPrefixMode();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefixMode, exitPrefixMode],
  );

  // Cleanup prefix timer on unmount
  useEffect(() => {
    return () => {
      if (prefixTimerRef.current) {
        clearTimeout(prefixTimerRef.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Pane number overlay
  // -------------------------------------------------------------------------

  const showPaneNumbersFn = useCallback(() => {
    setPaneNumberOverlay(true);

    if (paneNumberTimerRef.current) {
      clearTimeout(paneNumberTimerRef.current);
    }
    paneNumberTimerRef.current = setTimeout(() => {
      paneNumberTimerRef.current = null;
      setPaneNumberOverlay(false);
    }, PANE_NUMBER_TIMEOUT_MS);
  }, []);

  const selectPaneByNumberFn = useCallback(
    (num: number) => {
      const leaves = flattenPaneTree(layoutRef.current.root);
      const index = num - 1; // 1-based to 0-based

      if (index >= 0 && index < leaves.length) {
        setFocusedPane(leaves[index].id);
      }

      // Hide overlay
      setPaneNumberOverlay(false);
      if (paneNumberTimerRef.current) {
        clearTimeout(paneNumberTimerRef.current);
        paneNumberTimerRef.current = null;
      }
    },
    [setFocusedPane],
  );

  // Cleanup pane number timer on unmount
  useEffect(() => {
    return () => {
      if (paneNumberTimerRef.current) {
        clearTimeout(paneNumberTimerRef.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Computed values
  // -------------------------------------------------------------------------

  const paneCount = useMemo(() => countPanes(layout.root), [layout]);
  const treeDepth = useMemo(() => getTreeDepth(layout.root), [layout]);
  const canSplit =
    paneCount < PANE_CONSTANTS.MAX_PANES && treeDepth < PANE_CONSTANTS.MAX_DEPTH;
  const allSessionIds = useMemo(
    () => flattenPaneTree(layout.root).map((l) => l.sessionId),
    [layout],
  );
  const isZoomed = layout.zoomedPaneId !== null;

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    layout,
    prefixMode,
    swapSource,
    paneNumberOverlay,

    splitPane: splitPaneFn,
    closePane: closePaneFn,
    closeOtherPanes,

    setFocusedPane,
    moveFocus,
    cycleFocus,
    toggleZoom,

    resizePane: resizePaneFn,
    equalizePanes,
    toggleDirection: toggleDirectionFn,

    startSwap,
    executeSwap,
    cancelSwap,

    applyPreset,

    enterPrefixMode,
    exitPrefixMode,
    handlePrefixKey,

    showPaneNumbers: showPaneNumbersFn,
    selectPaneByNumber: selectPaneByNumberFn,

    paneCount,
    treeDepth,
    canSplit,
    allSessionIds,
    isZoomed,
  };
}
