import { useState, useCallback } from 'react';

export type PendingOp = { mode: 'copy' | 'move'; sourcePath: string; entryName: string } | null;

export interface FilesTabState {
  id: string;
  title: string;
}

export interface TerminalTabState {
  id: string;           // 'terminal-0', 'terminal-1', ...
  sessionId: string;    // Backend session UUID (independent PTY per terminal)
  title: string;        // 'Terminal', 'Terminal 2', ...
  isMain: boolean;      // true = cannot close
}

export type UnifiedTab =
  | (TerminalTabState & { type: 'terminal' })
  | (FilesTabState & { type: 'files' });

interface SessionTabData {
  tabs: UnifiedTab[];
  activeTabId: string;  // 'terminal-0' | 'terminal-1' | 'files-0' | 'viewer'
  viewerFile: string | null;
  viewerOriginTabId: string | null;
  nextId: number;
  nextTerminalId: number;
  pendingOp: PendingOp;
}

export interface UseTabManagerReturn {
  tabs: UnifiedTab[];
  terminalTabs: (TerminalTabState & { type: 'terminal' })[];
  filesTabs: (FilesTabState & { type: 'files' })[];
  activeTabId: string;
  viewerFile: string | null;
  pendingOp: PendingOp;
  setPendingOp: (op: PendingOp) => void;
  setActiveTerminal: () => void;
  setActiveTab: (tabId: string) => void;
  setActiveFilesTab: (tabId: string) => void;
  setActiveViewer: () => void;
  addTerminalTab: (newSessionId: string) => string;
  closeTerminalTab: (tabId: string) => void;
  getAllTerminalSessionIds: () => string[];
  addFilesTab: () => string;
  closeFilesTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  openViewer: (filePath: string, originTabId: string) => void;
  closeViewer: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  removeTabState: (sessionId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeAllClosableTabs: () => void;
  syncMainTabTitle: (title: string) => void;
  getMainTabId: () => string | undefined;
}

function createDefaultState(mainSessionId: string, mainTitle: string = 'Terminal'): SessionTabData {
  return {
    tabs: [
      { type: 'terminal', id: 'terminal-0', sessionId: mainSessionId, title: mainTitle, isMain: true },
    ],
    activeTabId: 'terminal-0',
    viewerFile: null,
    viewerOriginTabId: null,
    nextId: 1,
    nextTerminalId: 1,
    pendingOp: null,
  };
}

function loadState(sessionId: string): SessionTabData | null {
  try {
    const raw = localStorage.getItem(`tab_state_${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...parsed, viewerFile: null, viewerOriginTabId: null, pendingOp: null };
  } catch { return null; }
}

function saveState(sessionId: string, state: SessionTabData) {
  const { viewerFile, viewerOriginTabId, pendingOp, ...persistable } = state;
  localStorage.setItem(`tab_state_${sessionId}`, JSON.stringify(persistable));
}

export function useTabManager(activeSessionId: string | null, sessionName?: string): UseTabManagerReturn {
  const [allStates, setAllStates] = useState<Record<string, SessionTabData>>({});

  const defaultState: SessionTabData = activeSessionId
    ? createDefaultState(activeSessionId, sessionName)
    : createDefaultState('');

  // Current session's state (or default if none), with localStorage fallback
  const current = activeSessionId
    ? (allStates[activeSessionId] ?? loadState(activeSessionId) ?? defaultState)
    : defaultState;

  // Helper to update current session's state with localStorage persistence
  const update = useCallback((updater: (prev: SessionTabData) => SessionTabData) => {
    if (!activeSessionId) return;
    setAllStates(prev => {
      const currentState = prev[activeSessionId] ?? loadState(activeSessionId) ?? createDefaultState(activeSessionId, sessionName);
      const next = updater(currentState);
      saveState(activeSessionId, next);
      return { ...prev, [activeSessionId]: next };
    });
  }, [activeSessionId]);

  const setActiveTerminal = useCallback(() => {
    update(s => ({ ...s, activeTabId: 'terminal-0' }));
  }, [update]);

  const setActiveTab = useCallback((tabId: string) => {
    update(s => ({ ...s, activeTabId: tabId }));
  }, [update]);

  const setActiveFilesTab = useCallback((tabId: string) => {
    update(s => ({ ...s, activeTabId: tabId }));
  }, [update]);

  const setActiveViewer = useCallback(() => {
    update(s => ({ ...s, activeTabId: 'viewer' }));
  }, [update]);

  const addTerminalTab = useCallback((newSessionId: string) => {
    const id = `terminal-${current.nextTerminalId}`;
    update(s => {
      const newId = `terminal-${s.nextTerminalId}`;
      const tabNumber = s.nextTerminalId + 1; // 1-indexed for display
      const newTab: UnifiedTab = {
        type: 'terminal',
        id: newId,
        sessionId: newSessionId,
        title: `Terminal ${tabNumber}`,
        isMain: false,
      };
      return {
        ...s,
        tabs: [...s.tabs, newTab],
        activeTabId: newId,
        nextTerminalId: s.nextTerminalId + 1,
      };
    });
    return id;
  }, [update, current.nextTerminalId]);

  const closeTerminalTab = useCallback((tabId: string) => {
    update(s => {
      const tab = s.tabs.find(t => t.id === tabId);
      if (!tab || tab.type !== 'terminal' || tab.isMain) return s; // Cannot close main terminal

      const idx = s.tabs.findIndex(t => t.id === tabId);
      const newTabs = s.tabs.filter(t => t.id !== tabId);

      // If closing the active tab, switch to adjacent tab (any type)
      let newActiveTabId = s.activeTabId;
      if (s.activeTabId === tabId) {
        if (idx > 0) {
          newActiveTabId = newTabs[idx - 1].id;
        } else {
          newActiveTabId = newTabs[0].id;
        }
      }

      return {
        ...s,
        tabs: newTabs,
        activeTabId: newActiveTabId,
      };
    });
  }, [update]);

  const getAllTerminalSessionIds = useCallback(() => {
    return current.tabs
      .filter((t): t is TerminalTabState & { type: 'terminal' } => t.type === 'terminal' && !t.isMain)
      .map(t => t.sessionId);
  }, [current.tabs]);

  const addFilesTab = useCallback(() => {
    const id = `files-${current.nextId}`;
    update(s => {
      const newId = `files-${s.nextId}`;
      const newTab: UnifiedTab = { type: 'files', id: newId, title: 'Files' };
      return {
        ...s,
        tabs: [...s.tabs, newTab],
        activeTabId: newId,
        nextId: s.nextId + 1,
      };
    });
    return id;
  }, [update, current.nextId]);

  const closeFilesTab = useCallback((tabId: string) => {
    update(s => {
      const idx = s.tabs.findIndex(t => t.id === tabId);
      const newTabs = s.tabs.filter(t => t.id !== tabId);
      if (newTabs.length === 0) return s; // Prevent closing all tabs

      const newActiveTabId = s.activeTabId === tabId
        ? newTabs[Math.min(idx, newTabs.length - 1)].id
        : s.activeTabId;

      const newViewerOriginTabId = s.viewerOriginTabId === tabId
        ? newTabs[Math.min(idx, newTabs.length - 1)].id
        : s.viewerOriginTabId;

      return {
        ...s,
        tabs: newTabs,
        activeTabId: newActiveTabId,
        viewerOriginTabId: newViewerOriginTabId,
      };
    });
  }, [update]);

  const renameTab = useCallback((tabId: string, title: string) => {
    update(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, title } : t),
    }));
  }, [update]);

  const openViewer = useCallback((filePath: string, originTabId: string) => {
    update(s => ({
      ...s,
      viewerFile: filePath,
      viewerOriginTabId: originTabId,
      activeTabId: 'viewer',
    }));
  }, [update]);

  const closeViewer = useCallback(() => {
    update(s => ({
      ...s,
      viewerFile: null,
      activeTabId: s.viewerOriginTabId ?? s.activeTabId,
      viewerOriginTabId: null,
    }));
  }, [update]);

  const setPendingOp = useCallback((op: PendingOp) => {
    update(s => ({ ...s, pendingOp: op }));
  }, [update]);

  const closeOtherTabs = useCallback((tabId: string) => {
    update(s => {
      const newTabs = s.tabs.filter(t => {
        if (t.type === 'terminal' && t.isMain) return true;
        return t.id === tabId;
      });
      return { ...s, tabs: newTabs, activeTabId: tabId };
    });
  }, [update]);

  const syncMainTabTitle = useCallback((title: string) => {
    update(s => ({
      ...s,
      tabs: s.tabs.map(t =>
        t.type === 'terminal' && t.isMain ? { ...t, title } : t
      ),
    }));
  }, [update]);

  const getMainTabId = useCallback(() => {
    const mainTab = current.tabs.find(t => t.type === 'terminal' && (t as any).isMain);
    return mainTab?.id;
  }, [current.tabs]);

  const closeAllClosableTabs = useCallback(() => {
    update(s => {
      const newTabs = s.tabs.filter(t => t.type === 'terminal' && t.isMain);
      return { ...s, tabs: newTabs, activeTabId: newTabs[0]?.id ?? s.activeTabId };
    });
  }, [update]);

  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    update(s => {
      if (fromIndex === 0 || toIndex === 0) return s;
      if (fromIndex === toIndex) return s;
      const newTabs = [...s.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      return { ...s, tabs: newTabs };
    });
  }, [update]);

  const removeTabState = useCallback((sessionId: string) => {
    localStorage.removeItem(`tab_state_${sessionId}`);
    setAllStates(prev => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  return {
    tabs: current.tabs,
    reorderTabs,
    terminalTabs: current.tabs.filter((t): t is TerminalTabState & { type: 'terminal' } => t.type === 'terminal'),
    filesTabs: current.tabs.filter((t): t is FilesTabState & { type: 'files' } => t.type === 'files'),
    activeTabId: current.activeTabId,
    viewerFile: current.viewerFile,
    pendingOp: current.pendingOp,
    setPendingOp,
    setActiveTerminal,
    setActiveTab,
    setActiveFilesTab,
    setActiveViewer,
    addTerminalTab,
    closeTerminalTab,
    getAllTerminalSessionIds,
    addFilesTab,
    closeFilesTab,
    renameTab,
    openViewer,
    closeViewer,
    removeTabState,
    closeOtherTabs,
    closeAllClosableTabs,
    syncMainTabTitle,
    getMainTabId,
  };
}
