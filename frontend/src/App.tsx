/**
 * Main Application
 * Phase 7: Frontend Security - Auth integration added
 * Phase 1-Step2: Mobile responsive - useResponsive integration
 * Phase 2: Session management - rename, reorder
 * Phase 4: Tab system + File Manager integration
 * Phase 5: ViewerPanel integration (Markdown + Code viewer)
 * Phase 6: Multi-tab Files, cross-tab copy/move, viewer filter
 * Phase 8: Multi-terminal tabs + Sidebar terminal badges
 * Step 6: tmux-style Pane Split System
 */

import { useState, useCallback, useMemo } from 'react';
import { useAuth } from './contexts/AuthContext';
import { useSession } from './hooks/useSession';
import { useHeartbeat } from './hooks/useHeartbeat';
import { useResponsive } from './hooks/useResponsive';
import { useTabManager } from './hooks/useTabManager';
import { useCwd } from './hooks/useCwd';
import { usePaneManager } from './hooks/usePaneManager';
import { usePaneDB } from './hooks/usePaneDB';
import { sessionApi } from './services/api';
import { AuthGuard } from './components/Auth';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalContainer } from './components/Terminal';
import { MdirPanel } from './components/FileManager';
import { ViewerPanel } from './components/Viewer';
import { PaneRenderer } from './components/PaneSystem/PaneRenderer';
import { flattenPaneTree } from './utils/paneTree';
import { ConfirmModal } from './components/Modal';
import { StatusBar } from './components/StatusBar';
import { SettingsPage } from './components/Settings/SettingsPage';
import type { SessionStatus, ShellInfo, ShellType } from './types';
import './styles/globals.css';
import { useEffect } from 'react';

function AppContent() {
  const { logout } = useAuth();
  const [screen, setScreen] = useState<'workspace' | 'settings'>('workspace');
  const { isMobile, sidebarOpen, toggleSidebar, closeSidebar } = useResponsive();
  const {
    sessions,
    activeSessionId,
    activeSession,
    setActiveSessionId,
    createSession,
    deleteSession,
    updateSessionStatus,
    renameSession,
    reorderSession,
  } = useSession();
  const {
    tabs, reorderTabs,
    terminalTabs, filesTabs, activeTabId, viewerFile,
    pendingOp, setPendingOp,
    setActiveTerminal, setActiveTab, setActiveViewer,
    addTerminalTab, closeTerminalTab, getAllTerminalSessionIds,
    addFilesTab, closeFilesTab, renameTab,
    openViewer, closeViewer, removeTabState,
    closeOtherTabs, closeAllClosableTabs,
    syncMainTabTitle, getMainTabId,
  } = useTabManager(activeSessionId, activeSession?.name);

  // Sync session name → main tab title
  useEffect(() => {
    if (activeSession?.name) {
      syncMainTabTitle(activeSession.name);
    }
  }, [activeSession?.name, syncMainTabTitle]);

  // Available shells
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);

  useEffect(() => {
    sessionApi.getShells()
      .then(setAvailableShells)
      .catch((err) => console.error('Failed to fetch shells:', err));
  }, []);

  // CWD tracking for all sessions
  const { cwdMap, activeCwd } = useCwd(sessions, activeSessionId);

  // Heartbeat for token refresh
  useHeartbeat({
    onSessionExpired: () => {
      alert('Session expired. Please login again.');
    }
  });

  // Terminal statuses: { [parentSessionId]: { [childSessionId]: status } }
  const [terminalStatuses, setTerminalStatuses] = useState<Record<string, Record<string, SessionStatus>>>({});

  // Pane system (Step 6: tmux-style split)
  const paneDB = usePaneDB();
  const paneManager = usePaneManager({
    activeSessionId,
    createSession: async (name, shell, cwd, visible) => {
      const s = await createSession(name, shell as ShellType | undefined, cwd, visible);
      return s;
    },
    deleteSession: async (sid) => {
      await sessionApi.delete(sid).catch(console.error);
    },
    getCwd: (sid) => cwdMap[sid],
    paneDB,
  });

  // childSessionIds: computed from pane tree (replaces old localStorage-based Set)
  const childSessionIds = useMemo(
    () => new Set(paneManager.allSessionIds.filter(id => id !== activeSessionId)),
    [paneManager.allSessionIds, activeSessionId]
  );

  // Confirm modal state
  const [pendingCloseTab, setPendingCloseTab] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<string | null>(null);

  // Handle status change from TerminalContainer
  const handleTerminalStatusChange = useCallback((sessionId: string, status: SessionStatus) => {
    updateSessionStatus(sessionId, status);

    if (!activeSessionId) return;

    setTerminalStatuses(prev => {
      const parentMap = prev[activeSessionId] || {};
      if (parentMap[sessionId] === status) return prev;
      return {
        ...prev,
        [activeSessionId]: { ...parentMap, [sessionId]: status },
      };
    });
  }, [activeSessionId, updateSessionStatus]);

  const handleAuthError = useCallback(() => {
    logout();
  }, [logout]);

  // Add terminal tab handler — now uses paneManager.splitPane for pane splitting
  const handleAddTerminalTab = useCallback(async () => {
    if (!activeSessionId) return;
    // Use pane manager to split the focused pane (creates sub-session automatically)
    await paneManager.splitPane(paneManager.layout.focusedPaneId, 'vertical');
  }, [activeSessionId, paneManager]);

  // Close terminal tab with confirmation for running terminals
  const handleCloseTerminalTab = useCallback((tabId: string) => {
    if (!activeSessionId) return;
    const tab = terminalTabs.find(t => t.id === tabId);
    if (!tab || tab.isMain) return;

    const statuses = terminalStatuses[activeSessionId] || {};
    const tabStatus = statuses[tab.sessionId];

    if (tabStatus === 'running') {
      setPendingCloseTab(tabId);
    } else {
      sessionApi.delete(tab.sessionId).catch(console.error);
      setTerminalStatuses(prev => {
        const parentMap = { ...(prev[activeSessionId] || {}) };
        delete parentMap[tab.sessionId];
        return { ...prev, [activeSessionId]: parentMap };
      });
      closeTerminalTab(tabId);
    }
  }, [activeSessionId, terminalTabs, terminalStatuses, closeTerminalTab]);

  // Close other tabs (keep main + target tab)
  const handleCloseOtherTabs = useCallback((tabId: string) => {
    if (!activeSessionId) return;
    const tabsToClose = tabs.filter(t => {
      if (t.type === 'terminal' && (t as any).isMain) return false;
      return t.id !== tabId;
    });
    for (const t of tabsToClose) {
      if (t.type === 'terminal') {
        const termTab = t as any;
        sessionApi.delete(termTab.sessionId).catch(console.error);
        // childSessionIds is now computed from pane tree
        setTerminalStatuses(prev => {
          const parentMap = { ...(prev[activeSessionId] || {}) };
          delete parentMap[termTab.sessionId];
          return { ...prev, [activeSessionId]: parentMap };
        });
      }
    }
    closeOtherTabs(tabId);
  }, [activeSessionId, tabs, closeOtherTabs]);

  // Close all closable tabs (keep only main)
  const handleCloseAllTabs = useCallback(() => {
    if (!activeSessionId) return;
    const tabsToClose = tabs.filter(t => !(t.type === 'terminal' && (t as any).isMain));
    for (const t of tabsToClose) {
      if (t.type === 'terminal') {
        const termTab = t as any;
        sessionApi.delete(termTab.sessionId).catch(console.error);
        // childSessionIds is now computed from pane tree
        setTerminalStatuses(prev => {
          const parentMap = { ...(prev[activeSessionId] || {}) };
          delete parentMap[termTab.sessionId];
          return { ...prev, [activeSessionId]: parentMap };
        });
      }
    }
    closeAllClosableTabs();
  }, [activeSessionId, tabs, closeAllClosableTabs]);

  // Confirm close running terminal
  const handleConfirmCloseTab = useCallback(() => {
    if (!pendingCloseTab || !activeSessionId) return;
    const tab = terminalTabs.find(t => t.id === pendingCloseTab);
    if (tab) {
      sessionApi.delete(tab.sessionId).catch(console.error);
      // childSessionIds is now computed from pane tree
      setTerminalStatuses(prev => {
        const parentMap = { ...(prev[activeSessionId] || {}) };
        delete parentMap[tab.sessionId];
        return { ...prev, [activeSessionId]: parentMap };
      });
      closeTerminalTab(pendingCloseTab);
    }
    setPendingCloseTab(null);
  }, [pendingCloseTab, activeSessionId, terminalTabs, closeTerminalTab]);

  // Delete session with sub-terminal warning
  const handleDeleteSession = useCallback((id: string) => {
    const subTerminalIds = getAllTerminalSessionIds();
    if (id === activeSessionId && subTerminalIds.length > 0) {
      setPendingDeleteSession(id);
    } else {
      removeTabState(id);
      deleteSession(id);
    }
  }, [activeSessionId, getAllTerminalSessionIds, deleteSession, removeTabState]);

  // Confirm delete session with sub-terminals
  const handleConfirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) return;

    // Delete all sub-terminal sessions
    if (pendingDeleteSession === activeSessionId) {
      const subIds = getAllTerminalSessionIds();
      for (const subId of subIds) {
        try {
          await sessionApi.delete(subId);
        } catch (e) {
          console.error('Failed to delete sub-terminal:', e);
        }
      }
      // childSessionIds is now computed from pane tree
      setTerminalStatuses(prev => {
        const next = { ...prev };
        delete next[pendingDeleteSession];
        return next;
      });
    }

    removeTabState(pendingDeleteSession);
    deleteSession(pendingDeleteSession);
    setPendingDeleteSession(null);
  }, [pendingDeleteSession, activeSessionId, getAllTerminalSessionIds, deleteSession, removeTabState]);

  const handleCreateSession = useCallback(async (shell?: ShellType) => {
    await createSession(undefined, shell);
  }, [createSession]);

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    if (isMobile) {
      closeSidebar();
    }
  }, [setActiveSessionId, isMobile, closeSidebar]);

  const handleLogout = useCallback(async () => {
    await logout();
  }, [logout]);

  // Rename tab — if main tab, also rename session
  const handleRenameTab = useCallback((tabId: string, title: string) => {
    renameTab(tabId, title);
    const mainTabId = getMainTabId();
    if (tabId === mainTabId && activeSessionId) {
      renameSession(activeSessionId, title);
    }
  }, [renameTab, getMainTabId, activeSessionId, renameSession]);

  const handleEscToTerminal = useCallback(() => {
    setActiveTerminal();
  }, [setActiveTerminal]);

  // Filter out child sessions from sidebar
  const visibleSessions = useMemo(() =>
    sessions.filter(s => !childSessionIds.has(s.id)),
    [sessions, childSessionIds]
  );

  // Compute terminal counts for sidebar badges
  const terminalCountsMap = useMemo(() => {
    const map: Record<string, { running: number; idle: number }> = {};
    for (const session of visibleSessions) {
      const statuses = terminalStatuses[session.id] || {};
      let running = 0;
      let idle = 0;
      for (const st of Object.values(statuses)) {
        if (st === 'running') running++;
        else idle++;
      }
      if (running === 0 && idle === 0) {
        // Default: main terminal counted by session.status
        if (session.status === 'running') running = 1;
        else idle = 1;
      }
      map[session.id] = { running, idle };
    }
    return map;
  }, [visibleSessions, terminalStatuses]);

  // Pane info for StatusBar
  const paneInfo = useMemo(() => {
    if (paneManager.paneCount <= 1) return undefined;
    const leaves = flattenPaneTree(paneManager.layout.root);
    const idx = leaves.findIndex(l => l.id === paneManager.layout.focusedPaneId);
    return { current: idx + 1, total: leaves.length };
  }, [paneManager.layout, paneManager.paneCount]);

  // Count sub-terminals for delete confirmation message
  const pendingDeleteSubCount = pendingDeleteSession === activeSessionId
    ? getAllTerminalSessionIds().length
    : 0;

  return (
    <div className="app">
      <Header
        onLogout={handleLogout}
        onOpenSettings={() => setScreen('settings')}
        isSettingsActive={screen === 'settings'}
        isMobile={isMobile}
        onMenuClick={toggleSidebar}
        activeCwd={activeCwd}
      />
      <div className="main">
        <Sidebar
          sessions={visibleSessions}
          activeSessionId={activeSessionId}
          onSelect={handleSelectSession}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
          onRename={renameSession}
          onReorder={reorderSession}
          cwdMap={cwdMap}
          terminalCountsMap={terminalCountsMap}
          isMobile={isMobile}
          isOpen={sidebarOpen}
          onClose={closeSidebar}
          availableShells={availableShells}
        />
        <main className="content">
          <div className="workspace-screen" style={{ display: screen === 'workspace' ? 'flex' : 'none' }}>
            {activeSessionId ? (
              <>
                <TabBar
                  tabs={tabs}
                  activeTabId={activeTabId}
                  viewerFile={viewerFile}
                  isMobile={isMobile}
                  onSelectTab={setActiveTab}
                  onAddTerminalTab={handleAddTerminalTab}
                  onAddFilesTab={addFilesTab}
                  onCloseTerminalTab={handleCloseTerminalTab}
                  onCloseFilesTab={closeFilesTab}
                  onSelectViewer={setActiveViewer}
                  onReorderTabs={reorderTabs}
                  onRenameTab={handleRenameTab}
                  onCloseOtherTabs={handleCloseOtherTabs}
                  onCloseAllTabs={handleCloseAllTabs}
                />
                <div className="tab-content">
                  {/* Pane split terminal area (visible for active terminal tab) */}
                  {activeTabId && terminalTabs.some(t => t.id === activeTabId) && (
                    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                      <PaneRenderer
                        layout={paneManager.layout}
                        isMobile={isMobile}
                        swapSource={paneManager.swapSource}
                        paneNumberOverlay={paneManager.paneNumberOverlay}
                        onFocus={paneManager.setFocusedPane}
                        onContextMenu={(e, paneId) => {
                          e.preventDefault();
                          // Phase 3 will add context menu handling
                        }}
                        onResizerContextMenu={(e, splitId) => {
                          e.preventDefault();
                          // Phase 3 will add resizer context menu
                        }}
                        onResize={paneManager.resizePane}
                        onResizeEnd={() => {
                          // Immediate save on resize end
                          if (activeSessionId) {
                            paneDB.saveLayout(activeSessionId, paneManager.layout);
                          }
                        }}
                        renderTerminal={(sessionId, paneId) => (
                          <TerminalContainer
                            key={`pane-${paneId}-${sessionId}`}
                            sessionId={sessionId}
                            isVisible={true}
                            onStatusChange={handleTerminalStatusChange}
                            onAuthError={handleAuthError}
                          />
                        )}
                      />
                    </div>
                  )}

                  {/* Non-active terminal tabs hidden (Pane system handles active tab) */}

                  {filesTabs.map(tab => (
                    <div
                      key={`${activeSessionId}-${tab.id}`}
                      className="tab-content-panel"
                      style={{ display: activeTabId === tab.id ? 'flex' : 'none' }}
                    >
                      <MdirPanel
                        sessionId={activeSessionId}
                        onOpenViewer={(fp) => openViewer(fp, tab.id)}
                        onEscToTerminal={handleEscToTerminal}
                        onPathChange={(path) => {
                          const seg = path.split(/[/\\]/).filter(Boolean);
                          renameTab(tab.id, `/${seg[seg.length - 1] || ''}`);
                        }}
                        pendingOp={pendingOp}
                        setPendingOp={setPendingOp}
                      />
                    </div>
                  ))}

                  {activeTabId === 'viewer' && viewerFile && (
                    <ViewerPanel
                      sessionId={activeSessionId}
                      filePath={viewerFile}
                      onClose={closeViewer}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="no-session">
                <div className="no-session-icon">&#x1F4BB;</div>
                <p className="no-session-text">Select or create a session to start</p>
              </div>
            )}
          </div>

          <SettingsPage
            visible={screen === 'settings'}
            onBack={() => setScreen('workspace')}
          />
        </main>
        {isMobile && sidebarOpen && (
          <div
            className="sidebar-overlay"
            onClick={closeSidebar}
            aria-hidden="true"
          />
        )}
      </div>
      <StatusBar
        connected={!!activeSessionId}
        sessionName={activeSession?.name}
        prefixMode={paneManager.prefixMode}
        isZoomed={paneManager.isZoomed}
        paneInfo={paneInfo}
      />

      {/* Confirm close running terminal */}
      {pendingCloseTab && (
        <ConfirmModal
          title="Close Terminal"
          message="A process is still running in this terminal. Close it anyway?"
          confirmLabel="Close"
          destructive
          onConfirm={handleConfirmCloseTab}
          onCancel={() => setPendingCloseTab(null)}
        />
      )}

      {/* Confirm delete session with sub-terminals */}
      {pendingDeleteSession && (
        <ConfirmModal
          title="Delete Session"
          message={`This session has ${pendingDeleteSubCount} sub-terminal(s). All will be deleted. Continue?`}
          confirmLabel="Delete All"
          destructive
          onConfirm={handleConfirmDeleteSession}
          onCancel={() => setPendingDeleteSession(null)}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <AuthGuard>
      <AppContent />
    </AuthGuard>
  );
}

export default App;
