/**
 * Main Application — Step 7: CMUX-Style Workspace Pivot
 * Workspace-based multi-terminal management
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAuth } from './contexts/AuthContext';
import { useHeartbeat } from './hooks/useHeartbeat';
import { useResponsive } from './hooks/useResponsive';
import { useWorkspaceManager } from './hooks/useWorkspaceManager';
import { useContextMenu } from './hooks/useContextMenu';
import { sessionApi } from './services/api';
import { AuthGuard } from './components/Auth';
import { Header } from './components/Header';
import { TerminalHostSlot, TerminalRuntimeLayer } from './components/Terminal';
import { ConfirmModal } from './components/Modal';
import { SettingsPage } from './components/Settings/SettingsPage';
import { WorkspaceSidebar, WorkspaceTabBar, MobileDrawer, EmptyState, DisconnectedOverlay } from './components/Workspace';
import { MosaicContainer } from './components/Grid';
import { MetadataRow, METADATA_ROW_HEIGHT_PX } from './components/MetadataBar/MetadataRow';
import { ContextMenu } from './components/ContextMenu';
import { buildTerminalContextMenuItems } from './utils/contextMenuBuilder';
import { isLikelyBlankTerminalText, isLikelyCorruptedIdleTerminalText } from './utils/terminalRecovery';
import { TAB_COLORS } from './types/workspace';
import { resolveCwd } from './utils/shell';
import type { WorkspaceTabRuntime } from './types/workspace';
import type { ShellInfo } from './types';
import { WebSocketProvider } from './contexts/WebSocketContext';
import {
  TerminalRuntimeRegistryProvider,
  useTerminalRuntimeRegistryActions,
} from './contexts/TerminalRuntimeRegistryContext';
import './styles/globals.css';
import './components/Workspace/breathing.css';

// LRU 설정: 0 = 제한없음 (기본값). TODO: Settings UI 연동 예정
const MAX_ALIVE_WORKSPACES = 0;
const TERMINAL_BLANK_RECOVERY_MIN_AGE_MS = 5 * 60 * 1000;

function AppContent() {
  const { logout } = useAuth();
  const [screen, setScreen] = useState<'workspace' | 'settings'>('workspace');
  const { isMobile, sidebarOpen, toggleSidebar, closeSidebar } = useResponsive();
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);

  const wm = useWorkspaceManager();
  // Stable ref to avoid re-creating callbacks on every render
  const wmRef = useRef(wm);
  wmRef.current = wm;
  const attemptedSessionRecoveryRef = useRef<Set<string>>(new Set());

  // ============================================================================
  // LRU: 워크스페이스 세션 유지 상한 (FR-005)
  // workspaceVisitOrder: 앞이 가장 오래된, 뒤가 가장 최근 방문
  // aliveWorkspaceIds: 현재 DOM에 유지 중인 워크스페이스 ID 집합
  // ============================================================================
  const [workspaceVisitOrder, setWorkspaceVisitOrder] = useState<string[]>([]);
  const [aliveWorkspaceIds, setAliveWorkspaceIds] = useState<Set<string>>(new Set());

  const tabContextMenu = useContextMenu();
  const { getHandleByTabId, syncTabBindings } = useTerminalRuntimeRegistryActions();

  useHeartbeat({
    onSessionExpired: () => {
      alert('Session expired. Please login again.');
    }
  });

  // Initialize LRU with current active workspace on mount
  useEffect(() => {
    if (wm.activeWorkspaceId) {
      setAliveWorkspaceIds(prev => {
        if (prev.has(wm.activeWorkspaceId!)) return prev;
        return new Set([...prev, wm.activeWorkspaceId!]);
      });
      setWorkspaceVisitOrder(prev =>
        prev.includes(wm.activeWorkspaceId!) ? prev : [...prev, wm.activeWorkspaceId!]
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load available shells once on mount (after auth is already verified by AuthGuard)
  useEffect(() => {
    sessionApi.getShells().then(setAvailableShells).catch(() => { /* ignore */ });
  }, []);

  const tabBindingsKey = useMemo(
    () => wm.tabs.map(tab => `${tab.id}:${tab.sessionId}`).join(','),
    [wm.tabs],
  );

  useEffect(() => {
    syncTabBindings(wm.tabs.map(tab => ({ tabId: tab.id, sessionId: tab.sessionId })));
  }, [syncTabBindings, tabBindingsKey, wm.tabs]);

  // ============================================================================
  // Confirm modal state
  // ============================================================================
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<string | null>(null);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  // ============================================================================
  // Workspace actions
  // ============================================================================
  const handleSelectWorkspace = useCallback((id: string) => {
    wmRef.current.setActiveWorkspaceId(id);
    if (isMobile) closeSidebar();

    // LRU 업데이트: 방문 순서 갱신 + alive set 추가
    setWorkspaceVisitOrder(prev => {
      const next = prev.filter(wid => wid !== id);
      next.push(id); // 가장 최근으로 이동
      return next;
    });
    setAliveWorkspaceIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
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
  const handleAddTab = useCallback((cwd?: string, shell?: string) => {
    const wsId = wmRef.current.activeWorkspaceId;
    if (wsId) {
      wmRef.current.addTab(wsId, shell, undefined, cwd);
    }
  }, []);

  const handleTabBarAddTab = useCallback((shell?: string) => {
    const wsId = wmRef.current.activeWorkspaceId;
    if (!wsId) return;
    const ws = wmRef.current.activeWorkspace;
    const activeTabObj = wmRef.current.activeWorkspaceTabs.find(
      t => t.id === ws?.activeTabId
    );
    const effectiveShell = shell ?? activeTabObj?.shellType;
    const cwd = shell
      ? resolveCwd(shell, activeTabObj?.shellType, activeTabObj?.cwd)
      : activeTabObj?.cwd;
    wmRef.current.addTab(wsId, effectiveShell, undefined, cwd);
  }, []);

  // 탭 모드: 확인 모달을 통해 닫기
  const handleCloseTab = useCallback((tabId: string) => {
    setPendingCloseTabId(tabId);
  }, []);

  const handleConfirmCloseTab = useCallback(() => {
    if (pendingCloseTabId && wmRef.current.activeWorkspaceId) {
      wmRef.current.closeTab(wmRef.current.activeWorkspaceId, pendingCloseTabId);
    }
    setPendingCloseTabId(null);
  }, [pendingCloseTabId]);

  const getTerminalSelection = useCallback((tabId: string): string => {
    return getHandleByTabId(tabId)?.getSelection() ?? '';
  }, [getHandleByTabId]);

  const hasTerminalSelection = useCallback((tabId: string): boolean => {
    return getHandleByTabId(tabId)?.hasSelection() ?? false;
  }, [getHandleByTabId]);

  const sendTerminalInput = useCallback((tabId: string, data: string): void => {
    getHandleByTabId(tabId)?.sendInput(data);
  }, [getHandleByTabId]);

  // 그리드 모드: MosaicContainer가 자체 확인 모달을 가지므로 직접 닫기
  const handleCloseTabDirect = useCallback((tabId: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.closeTab(wmRef.current.activeWorkspaceId, tabId);
    }
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.setActiveTab(wmRef.current.activeWorkspaceId, tabId);
    }
  }, []);

  const handleRenameTab = useCallback((tabId: string, name: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.updateTab(wmRef.current.activeWorkspaceId, tabId, { name });
    }
  }, []);

  const handleReorderTabs = useCallback((tabIds: string[]) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.reorderTabs(wmRef.current.activeWorkspaceId, tabIds);
    }
  }, []);

  const handleToggleViewMode = useCallback(() => {
    if (wmRef.current.activeWorkspace) {
      const next = wmRef.current.activeWorkspace.viewMode === 'tab' ? 'grid' : 'tab';
      wmRef.current.setViewMode(wmRef.current.activeWorkspaceId!, next);
    }
  }, []);

  // FR-2: 모바일에서 그리드 모드 자동 해제
  useEffect(() => {
    if (
      isMobile &&
      wm.activeWorkspace?.viewMode === 'grid' &&
      wm.activeWorkspaceId
    ) {
      wmRef.current.setViewMode(wm.activeWorkspaceId, 'tab');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, wm.activeWorkspace?.viewMode, wm.activeWorkspaceId]);

  // FR-005: LRU 초과 감지 — MAX_ALIVE_WORKSPACES > 0일 때 가장 오래된 워크스페이스 해제
  useEffect(() => {
    if (MAX_ALIVE_WORKSPACES <= 0) return; // 0 = 제한없음
    if (aliveWorkspaceIds.size <= MAX_ALIVE_WORKSPACES) return;

    // 현재 활성 워크스페이스를 제외한 가장 오래된 것 해제
    const evictCandidate = workspaceVisitOrder.find(
      wid => wid !== wm.activeWorkspaceId && aliveWorkspaceIds.has(wid)
    );
    if (!evictCandidate) return;

    setAliveWorkspaceIds(prev => {
      const next = new Set(prev);
      next.delete(evictCandidate);
      return next;
    });
  }, [workspaceVisitOrder, aliveWorkspaceIds, wm.activeWorkspaceId]);

  const handleRestartTab = useCallback((tabId: string) => {
    if (wmRef.current.activeWorkspaceId) {
      wmRef.current.restartTab(wmRef.current.activeWorkspaceId, tabId);
    }
  }, []);

  // 그리드 레이아웃 모드 변경 후 모든 터미널 fit 강제 실행
  // (React 상태 경로의 Mosaic CSS 갱신은 ResizeObserver가 신뢰성 있게 발동하지 않는 경우가 있음)
  const handleFitAllTerminals = useCallback(() => {
    wmRef.current.activeWorkspaceTabs?.forEach(tab => {
      if (tab.status === 'disconnected') return;
      getHandleByTabId(tab.id)?.fit();
    });
  }, [getHandleByTabId]);

  // ============================================================================
  // Terminal status/CWD updates
  // ============================================================================
  const handleTerminalStatusChange = useCallback((sessionId: string, status: WorkspaceTabRuntime['status']) => {
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
    () => wm.activeWorkspaceTabs.find(t => t.id === wm.activeWorkspace?.activeTabId) ?? null,
    [wm.activeWorkspaceTabs, wm.activeWorkspace]
  );

  useEffect(() => {
    const tab = activeTab;
    if (!tab) return;
    if (tab.status !== 'idle') return;
    if (attemptedSessionRecoveryRef.current.has(tab.sessionId)) return;

    const timer = window.setTimeout(() => {
      const renderedText = getHandleByTabId(tab.id)?.getRenderedText() ?? '';
      const sessionAgeMs = Math.max(0, Date.now() - new Date(tab.createdAt).getTime());
      const shouldRecoverCorruption = isLikelyCorruptedIdleTerminalText(renderedText);
      const shouldRecoverBlank =
        isLikelyBlankTerminalText(renderedText) &&
        sessionAgeMs >= TERMINAL_BLANK_RECOVERY_MIN_AGE_MS;

      if (!shouldRecoverCorruption && !shouldRecoverBlank) {
        return;
      }

      attemptedSessionRecoveryRef.current.add(tab.sessionId);
      console.warn('[TerminalRecovery] Restarting suspicious idle session', {
        tabId: tab.id,
        sessionId: tab.sessionId,
      });
      handleRestartTab(tab.id);
    }, 2500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeTab, getHandleByTabId, handleRestartTab]);

  const tabModeRuntimeItems = useMemo(() => (
    wm.tabs
      .filter((tab) => MAX_ALIVE_WORKSPACES <= 0 || aliveWorkspaceIds.has(tab.workspaceId))
      .map((tab) => {
        const ws = wm.workspaces.find((workspace) => workspace.id === tab.workspaceId);
        const isActiveWs = tab.workspaceId === wm.activeWorkspaceId;
        const isActiveTab = ws?.activeTabId === tab.id;
        return {
          tab,
          slotId: `tab-slot-${tab.id}`,
          isVisible: isActiveWs && isActiveTab,
        };
      })
  ), [wm.tabs, wm.workspaces, wm.activeWorkspaceId, aliveWorkspaceIds]);

  const gridModeRuntimeItems = useMemo(() => (
    wm.activeWorkspaceTabs.map((tab) => ({
      tab,
      slotId: `grid-slot-${tab.id}`,
      isVisible: true,
    }))
  ), [wm.activeWorkspaceTabs]);

  const runtimeLayerItems = useMemo(() => {
    if ((wm.activeWorkspace?.viewMode || 'tab') === 'grid' && !isMobile) {
      return gridModeRuntimeItems;
    }
    return tabModeRuntimeItems;
  }, [gridModeRuntimeItems, isMobile, tabModeRuntimeItems, wm.activeWorkspace?.viewMode]);

  const tabContextMenuItems = useMemo(() => {
    if (!tabContextMenu.targetId || !activeTab) return [];
    const tabHandle = getHandleByTabId(tabContextMenu.targetId);
    const hasSelection = tabHandle?.hasSelection() ?? false;
    return buildTerminalContextMenuItems({
      tab: activeTab,
      tabs: wm.activeWorkspaceTabs,
      maxTabs: 8,
      availableShells,
      onAddTab: handleAddTab,
      onCloseTab: () => {
        handleCloseTab(activeTab.id);
        tabContextMenu.close();
      },
      onCopy: async () => {
        const text = tabHandle?.getSelection() ?? '';
        if (text) await navigator.clipboard.writeText(text);
      },
      onPaste: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) tabHandle?.sendInput(text);
        } catch { /* ignore */ }
      },
      hasSelection,
    });
  }, [tabContextMenu.targetId, activeTab, wm.activeWorkspaceTabs, availableShells, handleAddTab, handleCloseTab, tabContextMenu, getHandleByTabId]);

  const renderTerminalHost = useCallback((tab: WorkspaceTabRuntime) => {
    if (tab.status === 'disconnected') {
      // GridCell already renders DisconnectedOverlay — return empty container
      return <div style={{ width: '100%', height: '100%' }} />;
    }
    return (
      <TerminalHostSlot
        slotId={`grid-slot-${tab.id}`}
        tabId={tab.id}
        sessionId={tab.sessionId}
        slotKind="grid-pane"
        visible={true}
        style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}
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
      availableShells={availableShells}
      onSelect={handleSelectWorkspace}
      onCreate={() => wm.createWorkspace()}
      onRename={handleRenameWorkspace}
      onDelete={handleDeleteWorkspace}
      onAddTab={(wsId, shell) => wm.addTab(wsId, shell)}
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
                  totalSessionCount={wm.totalSessionCount}
                  maxTabs={8}
                  maxSessions={32}
                  onSelectTab={handleSelectTab}
                  onCloseTab={handleCloseTab}
                  onRenameTab={handleRenameTab}
                  onAddTab={handleTabBarAddTab}
                  onReorderTabs={handleReorderTabs}
                  availableShells={availableShells}
                />}

                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                  {viewMode === 'grid' && !isMobile ? (
                    <MosaicContainer
                      tabs={wm.activeWorkspaceTabs}
                      activeTabId={wm.activeWorkspace.activeTabId}
                      workspaceId={wm.activeWorkspaceId!}
                      onAddTab={handleAddTab}
                      onCloseTab={handleCloseTabDirect}
                      onRestartTab={handleRestartTab}
                      onSelectTab={handleSelectTab}
                      onRenameTab={handleRenameTab}
                      renderTerminalHost={renderTerminalHost}
                      availableShells={availableShells}
                      getTerminalSelection={getTerminalSelection}
                      hasTerminalSelection={hasTerminalSelection}
                      sendTerminalInput={sendTerminalInput}
                      onLayoutChange={handleFitAllTerminals}
                    />
                  ) : null}

                  {/* Tab Mode: render ALL tabs across all workspaces as host slots, hide inactive */}
                  {(viewMode === 'tab' || isMobile) && tabModeRuntimeItems
                    .map(({ tab, isVisible }) => {
                      const isDisconnectedVisible = isVisible && tab.status === 'disconnected';

                      return (
                        <div
                          key={`ws-${tab.id}-${tab.sessionId}`}
                          className={isVisible && tab.status === 'running' ? 'terminal-running' : ''}
                          style={{
                            display: 'flex',
                            position: 'absolute',
                            inset: 0,
                            visibility: isVisible ? 'visible' : 'hidden',
                            pointerEvents: isVisible ? 'auto' : 'none',
                            zIndex: isVisible ? 1 : 0,
                            flexDirection: 'column',
                            width: '100%',
                            height: '100%',
                            '--tab-color': TAB_COLORS[tab.colorIndex] || TAB_COLORS[0],
                          } as React.CSSProperties}
                          onContextMenu={isVisible ? (e) => {
                            e.preventDefault();
                            tabContextMenu.open(e.clientX, e.clientY, tab.id);
                          } : undefined}
                        >
                          {tab.status === 'disconnected' ? (
                            isDisconnectedVisible ? (
                              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                                <DisconnectedOverlay onRestart={() => handleRestartTab(tab.id)} />
                              </div>
                            ) : null
                          ) : (
                            <TerminalHostSlot
                              slotId={`tab-slot-${tab.id}`}
                              tabId={tab.id}
                              sessionId={tab.sessionId}
                              slotKind={isVisible ? 'tab-active' : 'tab-hidden'}
                              visible={isVisible}
                              style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
                            />
                          )}
                          <div style={{ height: `${METADATA_ROW_HEIGHT_PX}px`, flexShrink: 0, minHeight: `${METADATA_ROW_HEIGHT_PX}px` }}>
                            {isVisible ? (
                              <MetadataRow
                                tab={tab}
                                onRename={(name) => handleRenameTab(tab.id, name)}
                              />
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  }

                  <TerminalRuntimeLayer
                    items={runtimeLayerItems}
                    onStatusChange={handleTerminalStatusChange}
                    onCwdChange={handleCwdChange}
                    onAuthError={handleAuthError}
                  />
                </div>
              </>
            ) : (
              <EmptyState onAddTab={(shell) => handleAddTab(undefined, shell)} availableShells={availableShells} />
            )}
          </div>

          <SettingsPage
            visible={screen === 'settings'}
            onBack={() => setScreen('workspace')}
          />
        </main>
      </div>

      {/* Tab mode context menu */}
      {tabContextMenu.isOpen && tabContextMenu.position && (
        <ContextMenu
          position={tabContextMenu.position}
          items={tabContextMenuItems}
          onClose={tabContextMenu.close}
        />
      )}

      {/* Confirm close tab */}
      {pendingCloseTabId && (
        <ConfirmModal
          title="세션 닫기"
          message="이 세션을 종료하시겠습니까?"
          confirmLabel="닫기"
          cancelLabel="취소"
          destructive
          onConfirm={handleConfirmCloseTab}
          onCancel={() => setPendingCloseTabId(null)}
        />
      )}

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
        <TerminalRuntimeRegistryProvider>
          <AppContent />
        </TerminalRuntimeRegistryProvider>
      </WebSocketProvider>
    </AuthGuard>
  );
}

export default App;
