/**
 * Main Application — Step 7: CMUX-Style Workspace Pivot
 * Workspace-based multi-terminal management
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './contexts/AuthContext';
import { useHeartbeat } from './hooks/useHeartbeat';
import { useResponsive } from './hooks/useResponsive';
import { useWorkspaceManager } from './hooks/useWorkspaceManager';
import { sessionApi } from './services/api';
import { AuthGuard } from './components/Auth';
import { Header } from './components/Header';
import { TerminalContainer } from './components/Terminal';
import { ConfirmModal } from './components/Modal';
import { SettingsPage } from './components/Settings/SettingsPage';
import { WorkspaceSidebar, WorkspaceTabBar, MobileDrawer, EmptyState, DisconnectedOverlay } from './components/Workspace';
import { MosaicContainer } from './components/Grid';
import { MetadataRow } from './components/MetadataBar/MetadataRow';
import { TAB_COLORS } from './types/workspace';
import type { WorkspaceTabRuntime } from './types/workspace';
import type { SessionStatus } from './types';
import { WebSocketProvider } from './contexts/WebSocketContext';
import './styles/globals.css';
import './components/Workspace/breathing.css';

function AppContent() {
  const { logout } = useAuth();
  const [screen, setScreen] = useState<'workspace' | 'settings'>('workspace');
  const { isMobile, sidebarOpen, toggleSidebar, closeSidebar } = useResponsive();

  const wm = useWorkspaceManager();
  // Stable ref to avoid re-creating callbacks on every render
  const wmRef = useRef(wm);
  wmRef.current = wm;

  useHeartbeat({
    onSessionExpired: () => {
      alert('Session expired. Please login again.');
    }
  });

  // ============================================================================
  // Confirm modal state
  // ============================================================================
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<string | null>(null);

  // ============================================================================
  // Workspace actions
  // ============================================================================
  const handleSelectWorkspace = useCallback((id: string) => {
    wmRef.current.setActiveWorkspaceId(id);
    if (isMobile) closeSidebar();
  }, [isMobile, closeSidebar]);

  const handleDeleteWorkspace = useCallback((id: string) => {
    const tabs = wmRef.current.tabs.filter(t => t.workspaceId === id);
    if (tabs.length > 0) {
      setPendingDeleteWorkspace(id);
    } else {
      wmRef.current.deleteWorkspace(id);
    }
  }, []);

  const handleConfirmDeleteWorkspace = useCallback(async () => {
    if (pendingDeleteWorkspace) {
      await wmRef.current.deleteWorkspace(pendingDeleteWorkspace);
      setPendingDeleteWorkspace(null);
    }
  }, [pendingDeleteWorkspace]);

  const handleRenameWorkspace = useCallback((id: string, name: string) => {
    wmRef.current.updateWorkspace(id, { name } as any);
  }, []);

  // ============================================================================
  // Tab actions
  // ============================================================================
  const handleAddTab = useCallback((cwdOrEvent?: string | React.MouseEvent) => {
    const wsId = wmRef.current.activeWorkspaceId;
    // Guard: onClick passes a SyntheticEvent — ignore non-string arguments
    const cwd = typeof cwdOrEvent === 'string' ? cwdOrEvent : undefined;
    if (wsId) {
      wmRef.current.addTab(wsId, undefined, undefined, cwd);
    }
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.closeTab(wmRef.current.activeWorkspaceId, tabId);
    }
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.setActiveTab(wm.activeWorkspaceId, tabId);
    }
  }, []);

  const handleRenameTab = useCallback((tabId: string, name: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.updateTab(wm.activeWorkspaceId, tabId, { name });
    }
  }, []);

  const handleReorderTabs = useCallback((tabIds: string[]) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.reorderTabs(wm.activeWorkspaceId, tabIds);
    }
  }, []);

  const handleToggleViewMode = useCallback(() => {
    if (wmRef.current.activeWorkspace) {
      const next = wmRef.current.activeWorkspace.viewMode === 'tab' ? 'grid' : 'tab';
      wmRef.current.setViewMode(wm.activeWorkspaceId!, next);
    }
  }, []);

  const handleRestartTab = useCallback((tabId: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.restartTab(wm.activeWorkspaceId, tabId);
    }
  }, []);

  // ============================================================================
  // Terminal status/CWD updates (from per-session SSE)
  // ============================================================================
  const handleTerminalStatusChange = useCallback((sessionId: string, status: SessionStatus) => {
    wmRef.current.updateTabStatus(sessionId, status);
  }, []);

  const handleCwdChange = useCallback((sessionId: string, cwd: string) => {
    wmRef.current.updateTabCwd(sessionId, cwd);
  }, []);

  const handleAuthError = useCallback(() => {
    logout();
  }, [logout]);

  // ============================================================================
  // Render helpers
  // ============================================================================
  const activeTab = useMemo(
    () => wm.activeWorkspaceTabs.find(t => t.id === wm.activeWorkspace?.activeTabId),
    [wm.activeWorkspaceTabs, wm.activeWorkspace]
  );

  const renderTerminal = useCallback((tab: WorkspaceTabRuntime) => {
    if (tab.status === 'disconnected') {
      // GridCell already renders DisconnectedOverlay — return empty container
      return <div style={{ width: '100%', height: '100%' }} />;
    }
    return (
      <TerminalContainer
        key={`ws-${tab.id}-${tab.sessionId}`}
        sessionId={tab.sessionId}
        isVisible={true}
        onStatusChange={handleTerminalStatusChange}
        onCwdChange={handleCwdChange}
        onAuthError={handleAuthError}
      />
    );
  }, []);

  // ============================================================================
  // Pending delete info
  // ============================================================================
  const pendingDeleteTabCount = pendingDeleteWorkspace
    ? wm.tabs.filter(t => t.workspaceId === pendingDeleteWorkspace).length
    : 0;

  // ============================================================================
  // Render
  // ============================================================================
  const viewMode = wm.activeWorkspace?.viewMode || 'tab';

  const sidebarContent = (
    <WorkspaceSidebar
      workspaces={wm.workspaces}
      tabs={wm.tabs}
      activeWorkspaceId={wm.activeWorkspaceId}
      maxWorkspaces={10}
      onSelect={handleSelectWorkspace}
      onCreate={() => wm.createWorkspace()}
      onRename={handleRenameWorkspace}
      onDelete={handleDeleteWorkspace}
      onAddTab={(wsId) => wm.addTab(wsId)}
      onReorder={(ids) => wm.reorderWorkspaces(ids)}
    />
  );

  return (
    <div className="app">
      <Header
        onLogout={() => logout()}
        onOpenSettings={() => setScreen('settings')}
        isSettingsActive={screen === 'settings'}
        isMobile={isMobile}
        onMenuClick={toggleSidebar}
        activeCwd={activeTab?.cwd}
        viewMode={viewMode}
        onToggleViewMode={wm.activeWorkspace ? handleToggleViewMode : undefined}
      />
      <div className="main">
        {/* Desktop sidebar */}
        {!isMobile && (
          <aside className="sidebar" style={{ width: '220px', flexShrink: 0 }}>
            {sidebarContent}
          </aside>
        )}

        {/* Mobile drawer */}
        {isMobile && (
          <MobileDrawer isOpen={sidebarOpen} onClose={closeSidebar}>
            {sidebarContent}
          </MobileDrawer>
        )}

        <main className="content">
          <div className="workspace-screen" style={{ display: screen === 'workspace' ? 'flex' : 'none', flexDirection: 'column', flex: 1 }}>
            {wm.activeWorkspace && wm.activeWorkspaceTabs.length > 0 ? (
              <>
                {/* Tab Mode only — hide TabBar in Grid Mode */}
                {(viewMode === 'tab' || isMobile) && <WorkspaceTabBar
                  tabs={wm.activeWorkspaceTabs}
                  activeTabId={wm.activeWorkspace.activeTabId}
                  isMobile={isMobile}
                  totalSessionCount={wm.totalSessionCount}
                  maxTabs={8}
                  maxSessions={32}
                  onSelectTab={handleSelectTab}
                  onCloseTab={handleCloseTab}
                  onRenameTab={handleRenameTab}
                  onAddTab={handleAddTab}
                  onReorderTabs={handleReorderTabs}
                />}

                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                  {viewMode === 'grid' && !isMobile ? (
                    <MosaicContainer
                      tabs={wm.activeWorkspaceTabs}
                      workspaceId={wm.activeWorkspaceId!}
                      onAddTab={handleAddTab}
                      onCloseTab={handleCloseTab}
                      onRestartTab={handleRestartTab}
                      renderTerminal={renderTerminal}
                    />
                  ) : (
                    /* Tab Mode — show only active tab's terminal */
                    activeTab ? (
                      <div
                        className={activeTab.status === 'running' ? 'terminal-running' : ''}
                        style={{
                          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
                          '--tab-color': TAB_COLORS[activeTab.colorIndex] || TAB_COLORS[0],
                        } as React.CSSProperties}
                      >
                        {activeTab.status === 'disconnected' ? (
                          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                            <DisconnectedOverlay onRestart={() => handleRestartTab(activeTab.id)} />
                          </div>
                        ) : (
                          <TerminalContainer
                            key={`ws-${activeTab.id}-${activeTab.sessionId}`}
                            sessionId={activeTab.sessionId}
                            isVisible={true}
                            onStatusChange={handleTerminalStatusChange}
                            onCwdChange={handleCwdChange}
                            onAuthError={handleAuthError}
                          />
                        )}
                        <MetadataRow tab={activeTab} isOdd={false} />
                      </div>
                    ) : null
                  )}
                </div>
              </>
            ) : (
              <EmptyState onAddTab={handleAddTab} />
            )}
          </div>

          <SettingsPage
            visible={screen === 'settings'}
            onBack={() => setScreen('workspace')}
          />
        </main>
      </div>

      {/* Confirm delete workspace */}
      {pendingDeleteWorkspace && (
        <ConfirmModal
          title="Delete Workspace"
          message={`This workspace has ${pendingDeleteTabCount} terminal(s). All will be terminated. Continue?`}
          confirmLabel="Delete All"
          destructive
          onConfirm={handleConfirmDeleteWorkspace}
          onCancel={() => setPendingDeleteWorkspace(null)}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <AuthGuard>
      <WebSocketProvider>
        <AppContent />
      </WebSocketProvider>
    </AuthGuard>
  );
}

export default App;
