import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { workspaceApi } from '../services/api';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { Workspace, WorkspaceTab, WorkspaceTabRuntime, GridLayout, WorkspaceState } from '../types/workspace';

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

  // Session status update (from per-session SSE)
  updateTabStatus: (sessionId: string, status: 'running' | 'idle') => void;
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

        // Convert tabs to runtime with default status
        const runtimeTabs: WorkspaceTabRuntime[] = state.tabs.map(t => ({
          ...t,
          status: 'idle' as const,
          cwd: '',
        }));
        setTabs(runtimeTabs);

        // Restore active workspace
        const savedId = loadActiveWorkspaceId();
        if (savedId && state.workspaces.some(w => w.id === savedId)) {
          setActiveWorkspaceIdState(savedId);
        } else if (state.workspaces.length > 0) {
          const firstId = state.workspaces[0].id;
          setActiveWorkspaceIdState(firstId);
          saveActiveWorkspaceId(firstId);
        }
      } catch (err: any) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // ============================================================================
  // WebSocket Event Handlers (Step 8: replaced useWorkspaceSSE)
  // ============================================================================

  const ws = useWebSocket();

  // Use WS clientId instead of SSE clientId
  useEffect(() => {
    if (ws.clientId) setClientId(ws.clientId);
  }, [ws.clientId]);

  // Register workspace event handlers via WS
  useEffect(() => {
    ws.setWorkspaceHandlers({
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
        setWorkspaces(prev => prev.filter(w => w.id !== id));
        setTabs(prev => prev.filter(t => t.workspaceId !== id));
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
        const { id, changes } = data as { id: string; changes: Partial<WorkspaceTab> };
        setTabs(prev => prev.map(t => t.id === id ? { ...t, ...changes } : t));
      },

      'tab:removed': (data) => {
        const { id } = data as { id: string };
        setTabs(prev => prev.filter(t => t.id !== id));
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
  }, [ws]);

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
    setActiveWorkspaceIdState(id);
    saveActiveWorkspaceId(id);
  }, []);

  const createWorkspace = useCallback(async (name?: string) => {
    try {
      await workspaceApi.create(name);
      // Don't add locally — SSE onWorkspaceCreated will handle it to avoid duplicates.
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const updateWorkspace = useCallback(async (id: string, updates: Partial<Workspace>) => {
    try {
      const ws = await workspaceApi.update(id, updates);
      setWorkspaces(prev => prev.map(w => w.id === id ? ws : w));
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const deleteWorkspace = useCallback(async (id: string) => {
    try {
      await workspaceApi.delete(id);
      setWorkspaces(prev => prev.filter(w => w.id !== id));
      setTabs(prev => prev.filter(t => t.workspaceId !== id));
      setGridLayouts(prev => prev.filter(g => g.workspaceId !== id));
      // Switch to first remaining workspace
      setWorkspaces(prev => {
        if (activeWorkspaceId === id && prev.length > 0) {
          const nextId = prev[0].id;
          setActiveWorkspaceIdState(nextId);
          saveActiveWorkspaceId(nextId);
        }
        return prev;
      });
    } catch (err: any) {
      setError(err.message);
    }
  }, [activeWorkspaceId]);

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
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  // ============================================================================
  // Tab Actions (FR-7205: close tab transition policy)
  // ============================================================================

  const addTab = useCallback(async (workspaceId: string, shell?: string, name?: string, cwd?: string) => {
    try {
      const tab = await workspaceApi.addTab(workspaceId, shell, name, cwd);
      // Don't add locally — SSE onTabAdded will handle it to avoid duplicates.
      // Only update activeTabId which SSE doesn't cover.
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, activeTabId: tab.id } : w
      ));
    } catch (err: any) {
      setError(err.message);
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

      await workspaceApi.deleteTab(workspaceId, tabId);
      setTabs(prev => prev.filter(t => t.id !== tabId));
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, activeTabId: nextActiveTabId } : w
      ));
    } catch (err: any) {
      setError(err.message);
    }
  }, [tabs, workspaces]);

  const updateTab = useCallback(async (workspaceId: string, tabId: string, updates: { name?: string }) => {
    try {
      const tab = await workspaceApi.updateTab(workspaceId, tabId, updates);
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...tab } : t));
    } catch (err: any) {
      setError(err.message);
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
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const restartTab = useCallback(async (workspaceId: string, tabId: string) => {
    try {
      const tab = await workspaceApi.restartTab(workspaceId, tabId);
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...tab, status: 'idle', cwd: '' } : t));
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const setActiveTab = useCallback(async (workspaceId: string, tabId: string | null) => {
    try {
      await workspaceApi.update(workspaceId, { activeTabId: tabId } as any);
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, activeTabId: tabId } : w
      ));
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const setViewMode = useCallback(async (workspaceId: string, mode: 'tab' | 'grid') => {
    try {
      await workspaceApi.update(workspaceId, { viewMode: mode } as any);
      setWorkspaces(prev => prev.map(w =>
        w.id === workspaceId ? { ...w, viewMode: mode } : w
      ));
    } catch (err: any) {
      setError(err.message);
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
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  // ============================================================================
  // Session Status (called from per-session SSE in TerminalContainer)
  // ============================================================================

  const updateTabStatus = useCallback((sessionId: string, status: 'running' | 'idle') => {
    setTabs(prev => {
      const tab = prev.find(t => t.sessionId === sessionId);
      if (!tab || tab.status === status) return prev; // no change → no rerender
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
