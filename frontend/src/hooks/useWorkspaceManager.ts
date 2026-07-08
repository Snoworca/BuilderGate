import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { workspaceApi } from '../services/api';
import { useWebSocketActions, useWebSocketState } from '../contexts/WebSocketContext';
import type { Workspace, WorkspaceTab, WorkspaceTabRuntime, GridLayout, WorkspaceState } from '../types/workspace';
import { markTerminalSnapshotForRemoval } from '../utils/terminalSnapshot';
import {
  clearMosaicLayoutForWorkspace,
  pruneMosaicLayoutForDeletedTab,
} from './mosaicLayoutStorage';
import { resolveActiveWorkspaceAfterRemoval } from './workspaceActiveSelection';

type WorkspaceTabChanges = Partial<Omit<
  WorkspaceTab,
  'terminalTitle' | 'recoveryOptionId' | 'recoveryCommand' | 'recoveryArguments' | 'recoveryIcon' | 'recoveryUpdatedAt'
>> & {
  terminalTitle?: string | null;
  recoveryOptionId?: string | null;
  recoveryCommand?: string | null;
  recoveryArguments?: string[] | null;
  recoveryIcon?: WorkspaceTab['recoveryIcon'] | null;
  recoveryUpdatedAt?: string | null;
};

// ============================================================================
// localStorage helpers
// ============================================================================

function loadActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem('active_workspace_id');
  } catch {
    return null;
  }
}

function saveActiveWorkspaceId(id: string | null): void {
  try {
    if (id) localStorage.setItem('active_workspace_id', id);
    else localStorage.removeItem('active_workspace_id');
  } catch { /* private browsing */ }
}

function clearTerminalSnapshot(sessionId?: string | null): void {
  markTerminalSnapshotForRemoval(sessionId);
}

function clearWorkspaceSnapshots(runtimeTabs: WorkspaceTabRuntime[], workspaceId: string): void {
  runtimeTabs
    .filter(tab => tab.workspaceId === workspaceId)
    .forEach(tab => clearTerminalSnapshot(tab.sessionId));
}

function applyWorkspaceTabChanges(tab: WorkspaceTabRuntime, changes: WorkspaceTabChanges): WorkspaceTabRuntime {
  const {
    terminalTitle,
    recoveryOptionId,
    recoveryCommand,
    recoveryArguments,
    recoveryIcon,
    recoveryUpdatedAt,
    ...rest
  } = changes;
  const next: WorkspaceTabRuntime = { ...tab, ...rest };
  if ('terminalTitle' in changes) {
    if (typeof terminalTitle === 'string') {
      next.terminalTitle = terminalTitle;
    } else {
      delete next.terminalTitle;
    }
  }
  if ('recoveryOptionId' in changes) {
    if (typeof recoveryOptionId === 'string') next.recoveryOptionId = recoveryOptionId;
    else delete next.recoveryOptionId;
  }
  if ('recoveryCommand' in changes) {
    if (typeof recoveryCommand === 'string') next.recoveryCommand = recoveryCommand;
    else delete next.recoveryCommand;
  }
  if ('recoveryArguments' in changes) {
    if (Array.isArray(recoveryArguments)) next.recoveryArguments = recoveryArguments;
    else delete next.recoveryArguments;
  }
  if ('recoveryIcon' in changes) {
    if (recoveryIcon) next.recoveryIcon = recoveryIcon;
    else delete next.recoveryIcon;
  }
  if ('recoveryUpdatedAt' in changes) {
    if (typeof recoveryUpdatedAt === 'string') next.recoveryUpdatedAt = recoveryUpdatedAt;
    else delete next.recoveryUpdatedAt;
  }
  return next;
}

function replaceWorkspaceTab(tab: WorkspaceTabRuntime, replacement: WorkspaceTab): WorkspaceTabRuntime {
  return {
    ...replacement,
    status: tab.status,
    cwd: tab.cwd,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Hook Return Type
// ============================================================================

export interface UseWorkspaceManagerReturn {
  // State
  workspaces: Workspace[];
  tabs: WorkspaceTabRuntime[];
  gridLayouts: GridLayout[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | null;
  activeWorkspaceTabs: WorkspaceTabRuntime[];
  totalSessionCount: number;
  loading: boolean;
  error: string | null;
  clientId: string | null;

  // Workspace CRUD
  setActiveWorkspaceId: (id: string) => void;
  createWorkspace: (name?: string) => Promise<void>;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  reorderWorkspaces: (workspaceIds: string[]) => Promise<void>;

  // Tab CRUD
  addTab: (workspaceId: string, shell?: string, name?: string, cwd?: string) => Promise<void>;
  updateTab: (workspaceId: string, tabId: string, updates: { name?: string }) => Promise<void>;
  closeTab: (workspaceId: string, tabId: string) => Promise<void>;
  reorderTabs: (workspaceId: string, tabIds: string[]) => Promise<void>;
  restartTab: (workspaceId: string, tabId: string) => Promise<void>;
  setActiveTab: (workspaceId: string, tabId: string | null) => Promise<void>;
  setViewMode: (workspaceId: string, mode: 'tab' | 'grid') => Promise<void>;

  // Grid
  updateGrid: (workspaceId: string, layout: Omit<GridLayout, 'workspaceId'>) => Promise<void>;

  // Session status update
  updateTabStatus: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  updateTabCwd: (sessionId: string, cwd: string) => void;
}

// ============================================================================
// Main Hook
// ============================================================================

export function useWorkspaceManager(): UseWorkspaceManagerReturn {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tabs, setTabs] = useState<WorkspaceTabRuntime[]>([]);
  const [gridLayouts, setGridLayouts] = useState<GridLayout[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(loadActiveWorkspaceId());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);

  const setActiveWorkspaceIdAndPersist = useCallback((id: string | null) => {
    activeWorkspaceIdRef.current = id;
    setActiveWorkspaceIdState(id);
    saveActiveWorkspaceId(id);
  }, []);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  // ============================================================================
  // Initial Load
  // ============================================================================

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const state: WorkspaceState = await workspaceApi.getAll();
        if (!mounted) return;

        setWorkspaces(state.workspaces);
        setGridLayouts(state.gridLayouts);

        // Convert tabs to runtime with default status, restoring last CWD if available
        const runtimeTabs: WorkspaceTabRuntime[] = state.tabs.map(t => ({
          ...t,
          status: 'idle' as const,
          cwd: t.lastCwd || '',
        }));
        setTabs(runtimeTabs);

        // Restore active workspace
        const savedId = loadActiveWorkspaceId();
        if (savedId && state.workspaces.some(w => w.id === savedId)) {
          setActiveWorkspaceIdAndPersist(savedId);
        } else if (state.workspaces.length > 0) {
          const firstId = state.workspaces[0].id;
          setActiveWorkspaceIdAndPersist(firstId);
        } else {
          setActiveWorkspaceIdAndPersist(null);
        }
      } catch (err: unknown) {
        if (mounted) setError(getErrorMessage(err));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [setActiveWorkspaceIdAndPersist]);

  // ============================================================================
  // WebSocket Event Handlers
  // ============================================================================

  const { clientId: wsClientId } = useWebSocketState();
  const { setWorkspaceHandlers } = useWebSocketActions();

  // Use WS clientId
  useEffect(() => {
    setClientId(wsClientId);
  }, [wsClientId]);

  // Register workspace event handlers via WS
  useEffect(() => {
    setWorkspaceHandlers({
      'workspace:created': (data) => {
        const wsData = data as Workspace;
        setWorkspaces(prev => {
          if (prev.some(w => w.id === wsData.id)) return prev;
          return [...prev, wsData];
        });
      },

      'workspace:updated': (data) => {
        const { id, changes } = data as { id: string; changes: Partial<Workspace> };
        setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, ...changes } : w));
      },

      'workspace:deleted': (data) => {
        const { id } = data as { id: string };
        clearMosaicLayoutForWorkspace(id);
        setWorkspaces(prev => {
          const next = prev.filter(w => w.id !== id);
          const nextActiveWorkspaceId = resolveActiveWorkspaceAfterRemoval(
            activeWorkspaceIdRef.current,
            id,
            next,
          );
          if (nextActiveWorkspaceId !== undefined) {
            setActiveWorkspaceIdAndPersist(nextActiveWorkspaceId);
          }
          return next;
        });
        setTabs(prev => {
          clearWorkspaceSnapshots(prev, id);
          return prev.filter(t => t.workspaceId !== id);
        });
        setGridLayouts(prev => prev.filter(g => g.workspaceId !== id));
      },

      'workspace:reordered': (data) => {
        const { workspaceIds } = data as { workspaceIds: string[] };
        setWorkspaces(prev => {
          const map = new Map(prev.map(w => [w.id, w]));
          return workspaceIds.map((id, i) => {
            const wsItem = map.get(id);
            return wsItem ? { ...wsItem, sortOrder: i } : wsItem!;
          }).filter(Boolean);
        });
      },

      'tab:added': (data) => {
        const tab = data as WorkspaceTab;
        const runtime: WorkspaceTabRuntime = { ...tab, status: 'idle', cwd: '' };
        setTabs(prev => {
          if (prev.some(t => t.id === tab.id)) return prev;
          return [...prev, runtime];
        });
      },

      'tab:updated': (data) => {
        const { id, changes } = data as { id: string; changes: WorkspaceTabChanges };
        setTabs(prev => {
          const current = prev.find(t => t.id === id);
          if (current?.sessionId && changes.sessionId && current.sessionId !== changes.sessionId) {
            clearTerminalSnapshot(current.sessionId);
          }
          return prev.map(t => t.id === id ? applyWorkspaceTabChanges(t, changes) : t);
        });
      },

      'tab:removed': (data) => {
        const { id } = data as { id: string };
        setTabs(prev => {
          const removed = prev.find(t => t.id === id);
          clearTerminalSnapshot(removed?.sessionId);
          if (removed) {
            pruneMosaicLayoutForDeletedTab(removed.workspaceId, id);
          }
          return prev.filter(t => t.id !== id);
        });
      },

      'tab:reordered': (data) => {
        const { workspaceId, tabIds } = data as { workspaceId: string; tabIds: string[] };
        setTabs(prev => prev.map(t => {
          if (t.workspaceId !== workspaceId) return t;
          const idx = tabIds.indexOf(t.id);
          return idx >= 0 ? { ...t, sortOrder: idx } : t;
        }));
      },

      'tab:disconnected': (data) => {
        const { id } = data as { id: string };
        setTabs(prev => prev.map(t => t.id === id ? { ...t, status: 'disconnected' } : t));
      },

      'grid:updated': (data) => {
        const layout = data as GridLayout;
        setGridLayouts(prev => {
          const idx = prev.findIndex(g => g.workspaceId === layout.workspaceId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = layout;
            return next;
          }
          return [...prev, layout];
        });
      },
    });
  }, [setActiveWorkspaceIdAndPersist, setWorkspaceHandlers]);

  // ============================================================================
  // Derived State
  // ============================================================================

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId]
  );

  const activeWorkspaceTabs = useMemo(
    () => tabs
      .filter(t => t.workspaceId === activeWorkspaceId)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    [tabs, activeWorkspaceId]
  );

  const totalSessionCount = useMemo(() => tabs.length, [tabs]);

  // ============================================================================
  // Workspace Actions
  // ============================================================================

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveWorkspaceIdAndPersist(id);
  }, [setActiveWorkspaceIdAndPersist]);

  const createWorkspace = useCallback(async (name?: string) => {
    try {
      const ws = await workspaceApi.create(name);
      // Add locally — WS workspace:created is excluded for the originating client (x-client-id).
      setWorkspaces(prev => prev.some(w => w.id === ws.id) ? prev : [...prev, ws]);
      setActiveWorkspaceIdAndPersist(ws.id);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, [setActiveWorkspaceIdAndPersist]);

  const updateWorkspace = useCallback(async (id: string, updates: Partial<Workspace>) => {
    try {
      const ws = await workspaceApi.update(id, updates);
      setWorkspaces(prev => prev.map(w => w.id === id ? ws : w));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  const deleteWorkspace = useCallback(async (id: string) => {
    try {
      const removedTabs = tabs.filter(t => t.workspaceId === id);
      await workspaceApi.delete(id);
      clearMosaicLayoutForWorkspace(id);
      setWorkspaces(prev => {
        const next = prev.filter(w => w.id !== id);
        const nextActiveWorkspaceId = resolveActiveWorkspaceAfterRemoval(
          activeWorkspaceIdRef.current,
          id,
          next,
        );
        if (nextActiveWorkspaceId !== undefined) {
          setActiveWorkspaceIdAndPersist(nextActiveWorkspaceId);
        }
        return next;
      });
      setTabs(prev => prev.filter(t => t.workspaceId !== id));
      setGridLayouts(prev => prev.filter(g => g.workspaceId !== id));
      clearWorkspaceSnapshots(removedTabs, id);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, [setActiveWorkspaceIdAndPersist, tabs]);

  const reorderWorkspaces = useCallback(async (workspaceIds: string[]) => {
    try {
      await workspaceApi.reorderWorkspaces(workspaceIds);
      setWorkspaces(prev => {
        const map = new Map(prev.map(w => [w.id, w]));
        return workspaceIds.map((id, i) => {
          const ws = map.get(id);
          return ws ? { ...ws, sortOrder: i } : ws!;
        }).filter(Boolean);
      });
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  // ============================================================================
  // Tab Actions (FR-7205: close tab transition policy)
  // ============================================================================

  const addTab = useCallback(async (workspaceId: string, shell?: string, name?: string, cwd?: string) => {
    try {
      const tab = await workspaceApi.addTab(workspaceId, shell, name, cwd);
      // Add tab locally — WS tab:added is excluded for the originating client (x-client-id).
      const runtime: WorkspaceTabRuntime = { ...tab, status: 'idle', cwd: '' };
      setTabs(prev => prev.some(t => t.id === tab.id) ? prev : [...prev, runtime]);
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, activeTabId: tab.id } : w
      ));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  const closeTab = useCallback(async (workspaceId: string, tabId: string) => {
    try {
      // Calculate next active tab BEFORE deletion (FR-7205)
      const wsTabs = tabs
        .filter(t => t.workspaceId === workspaceId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const ws = workspaces.find(w => w.id === workspaceId);
      let nextActiveTabId: string | null = null;

      if (ws?.activeTabId === tabId) {
        const currentIndex = wsTabs.findIndex(t => t.id === tabId);
        if (currentIndex >= 0) {
          // Right adjacent first, then left
          const rightTab = wsTabs[currentIndex + 1];
          const leftTab = wsTabs[currentIndex - 1];
          nextActiveTabId = rightTab?.id ?? leftTab?.id ?? null;
        }
      } else {
        nextActiveTabId = ws?.activeTabId ?? null;
      }
      const tabToClose = tabs.find(t => t.id === tabId);

      await workspaceApi.deleteTab(workspaceId, tabId);
      setTabs(prev => prev.filter(t => t.id !== tabId));
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, activeTabId: nextActiveTabId } : w
      ));
      pruneMosaicLayoutForDeletedTab(workspaceId, tabId);
      clearTerminalSnapshot(tabToClose?.sessionId);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, [tabs, workspaces]);

  const updateTab = useCallback(async (workspaceId: string, tabId: string, updates: { name?: string }) => {
    try {
      const tab = await workspaceApi.updateTab(workspaceId, tabId, updates);
      setTabs(prev => prev.map(t => t.id === tabId ? replaceWorkspaceTab(t, tab) : t));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  const reorderTabs = useCallback(async (workspaceId: string, tabIds: string[]) => {
    try {
      await workspaceApi.reorderTabs(workspaceId, tabIds);
      setTabs(prev => prev.map(t => {
        if (t.workspaceId !== workspaceId) return t;
        const idx = tabIds.indexOf(t.id);
        return idx >= 0 ? { ...t, sortOrder: idx } : t;
      }));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  const restartTab = useCallback(async (workspaceId: string, tabId: string) => {
    try {
      const oldTab = tabs.find(t => t.id === tabId);
      const tab = await workspaceApi.restartTab(workspaceId, tabId);
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...tab, status: 'idle', cwd: tab.lastCwd || '' } : t));
      if (oldTab?.sessionId && oldTab.sessionId !== tab.sessionId) {
        clearTerminalSnapshot(oldTab.sessionId);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, [tabs]);

  const setActiveTab = useCallback(async (workspaceId: string, tabId: string | null) => {
    try {
      await workspaceApi.update(workspaceId, { activeTabId: tabId });
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, activeTabId: tabId } : w
      ));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  const setViewMode = useCallback(async (workspaceId: string, mode: 'tab' | 'grid') => {
    try {
      await workspaceApi.update(workspaceId, { viewMode: mode });
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, viewMode: mode } : w
      ));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  // ============================================================================
  // Grid
  // ============================================================================

  const updateGrid = useCallback(async (workspaceId: string, layout: Omit<GridLayout, 'workspaceId'>) => {
    try {
      const result = await workspaceApi.updateGrid(workspaceId, layout);
      setGridLayouts(prev => {
        const idx = prev.findIndex(g => g.workspaceId === workspaceId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = result;
          return next;
        }
        return [...prev, result];
      });
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  }, []);

  // ============================================================================
  // Session Status
  // ============================================================================

  const updateTabStatus = useCallback((sessionId: string, status: WorkspaceTabRuntime['status']) => {
    setTabs(prev => {
      const tab = prev.find(t => t.sessionId === sessionId);
      if (!tab || tab.status === status) return prev;
      return prev.map(t => t.sessionId === sessionId ? { ...t, status } : t);
    });
  }, []);

  const updateTabCwd = useCallback((sessionId: string, cwd: string) => {
    setTabs(prev => {
      const tab = prev.find(t => t.sessionId === sessionId);
      if (!tab || tab.cwd === cwd) return prev; // no change → no rerender
      return prev.map(t => t.sessionId === sessionId ? { ...t, cwd } : t);
    });
  }, []);

  return {
    workspaces,
    tabs,
    gridLayouts,
    activeWorkspaceId,
    activeWorkspace,
    activeWorkspaceTabs,
    totalSessionCount,
    loading,
    error,
    clientId,

    setActiveWorkspaceId,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    reorderWorkspaces,

    addTab,
    updateTab,
    closeTab,
    reorderTabs,
    restartTab,
    setActiveTab,
    setViewMode,

    updateGrid,
    updateTabStatus,
    updateTabCwd,
  };
}
