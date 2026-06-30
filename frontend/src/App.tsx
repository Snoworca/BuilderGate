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
import { useTerminalRuntimeResidency } from './hooks/useTerminalRuntimeResidency';
import { commandPresetApi, sessionApi } from './services/api';
import { AuthGuard } from './components/Auth';
import { Header } from './components/Header';
import { TerminalHostSlot, TerminalRuntimeLayer, TerminalRuntimeProvider } from './components/Terminal';
import { useTerminalRuntimeContext } from './components/Terminal/TerminalRuntimeContext';
import type { TerminalHandle, TerminalPasteInputResult } from './components/Terminal/TerminalView';
import { ConfirmModal } from './components/Modal';
import { SettingsPage } from './components/Settings/SettingsPage';
import { WorkspaceSidebar, WorkspaceTabBar, MobileDrawer, EmptyState, DisconnectedOverlay } from './components/Workspace';
import { MosaicContainer } from './components/Grid';
import { MetadataRow } from './components/MetadataBar/MetadataRow';
import { ContextMenu } from './components/ContextMenu';
import { CommandPresetDialog } from './components/CommandPresetManager';
import { buildCommandPresetPasteInput } from './components/CommandPresetManager/commandPresetPaste';
import {
  TerminalShortcutDialog,
  TerminalShortcutProvider,
  useTerminalShortcutContext,
} from './components/TerminalShortcutManager';
import { buildTerminalContextMenuItems } from './utils/contextMenuBuilder';
import { TAB_COLORS } from './types/workspace';
import { resolveCwd } from './utils/shell';
import type { WorkspaceTabRuntime } from './types/workspace';
import type { CommandPreset, ShellInfo, TerminalShortcutState } from './types';
import { WebSocketProvider } from './contexts/WebSocketContext';
import './styles/globals.css';
import './components/Workspace/breathing.css';

function buildMissingTerminalPasteResult(): TerminalPasteInputResult {
  return {
    ok: false,
    reason: 'context-changed',
    source: 'command-preset-paste',
    captureState: 'closed',
    barrierReason: 'none',
    closedReason: 'terminal-disposed',
  };
}

function TerminalWorkspaceStage({
  children,
  tabs,
  terminalRefsMap,
  onStatusChange,
  onCwdChange,
  onAuthError,
  onFitAll,
  terminalShortcutState,
}: {
  children: (onLayoutChange: () => void) => React.ReactNode;
  tabs: WorkspaceTabRuntime[];
  terminalRefsMap: React.MutableRefObject<Map<string, { current: TerminalHandle | null }>>;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
  onFitAll: () => void;
  terminalShortcutState: TerminalShortcutState | null;
}) {
  const { invalidateHostLayouts } = useTerminalRuntimeContext();

  const handleLayoutChange = useCallback(() => {
    invalidateHostLayouts();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        onFitAll();
      });
    });
  }, [invalidateHostLayouts, onFitAll]);

  return (
    <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
      {children(handleLayoutChange as never)}
      <TerminalRuntimeLayer
        tabs={tabs}
        terminalRefsMap={terminalRefsMap}
        onStatusChange={onStatusChange}
        onCwdChange={onCwdChange}
        onAuthError={onAuthError}
        terminalShortcutState={terminalShortcutState}
      />
    </div>
  );
}

function AppContent() {
  const { logout } = useAuth();
  const terminalShortcuts = useTerminalShortcutContext();
  const [screen, setScreen] = useState<'workspace' | 'settings'>('workspace');
  const { isMobile, sidebarOpen, toggleSidebar, closeSidebar } = useResponsive();
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);
  const [showCommandPresetDialog, setShowCommandPresetDialog] = useState(false);
  const [showTerminalShortcutDialog, setShowTerminalShortcutDialog] = useState(false);

  const wm = useWorkspaceManager();
  // Stable ref to avoid re-creating callbacks on every render
  const wmRef = useRef(wm);
  wmRef.current = wm;

  const tabContextMenu = useContextMenu();
  const terminalRefsMap = useRef<Map<string, { current: TerminalHandle | null }>>(new Map());
  const [registeredPresetSnapshot, setRegisteredPresetSnapshot] = useState<CommandPreset[]>([]);
  const tabContextMenuOpenGuardRef = useRef<{ tabId: string; x: number; y: number; at: number } | null>(null);
  const tabContextMenuOpenSeqRef = useRef(0);
  const tabContextMenuRestoreFocusElementRef = useRef<Element | null>(null);

  useHeartbeat({
    onSessionExpired: () => {
      alert('Session expired. Please login again.');
    }
  });

  // Load available shells once on mount (after auth is already verified by AuthGuard)
  useEffect(() => {
    sessionApi.getShells().then(setAvailableShells).catch(() => { /* ignore */ });
  }, []);

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
    wmRef.current.updateWorkspace(id, { name });
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
    return terminalRefsMap.current.get(tabId)?.current?.getSelection() ?? '';
  }, []);

  const hasTerminalSelection = useCallback((tabId: string): boolean => {
    return terminalRefsMap.current.get(tabId)?.current?.hasSelection() ?? false;
  }, []);

  const sendTerminalInput = useCallback((tabId: string, data: string): void => {
    terminalRefsMap.current.get(tabId)?.current?.sendInput(data);
  }, []);

  const pasteTerminalInput = useCallback((tabId: string, data: string): TerminalPasteInputResult => {
    return terminalRefsMap.current.get(tabId)?.current?.pasteInput(data) ?? buildMissingTerminalPasteResult();
  }, []);

  const focusTerminal = useCallback((tabId: string): void => {
    terminalRefsMap.current.get(tabId)?.current?.focus();
  }, []);

  const handleRegisteredPresetPaste = useCallback((tabId: string, preset: CommandPreset) => {
    const validation = buildCommandPresetPasteInput(preset);
    if (!validation.ok) {
      console.warn('[CommandPresetContextMenu] Refused command preset paste', {
        presetId: preset.id,
        kind: preset.kind,
        reason: validation.reason,
      });
      requestAnimationFrame(() => focusTerminal(tabId));
      return;
    }

    const result = pasteTerminalInput(tabId, validation.data);
    if (!result.ok) {
      console.warn('[CommandPresetContextMenu] Failed to paste command preset', {
        presetId: preset.id,
        kind: preset.kind,
        result,
      });
    }
    requestAnimationFrame(() => focusTerminal(tabId));
  }, [focusTerminal, pasteTerminalInput]);

  const openTabContextMenu = useCallback((x: number, y: number, tabId: string) => {
    const now = performance.now();
    const previous = tabContextMenuOpenGuardRef.current;
    if (
      previous
      && previous.tabId === tabId
      && previous.x === x
      && previous.y === y
      && now - previous.at < 50
    ) {
      return;
    }

    tabContextMenuOpenGuardRef.current = { tabId, x, y, at: now };
    tabContextMenuRestoreFocusElementRef.current = document.activeElement instanceof Element
      ? document.activeElement
      : null;
    const seq = tabContextMenuOpenSeqRef.current + 1;
    tabContextMenuOpenSeqRef.current = seq;

    void (async () => {
      let presets: CommandPreset[] = [];
      try {
        presets = await commandPresetApi.getAll();
      } catch (error) {
        console.warn('[CommandPresetContextMenu] Failed to load command presets', error);
      }

      if (tabContextMenuOpenSeqRef.current !== seq) {
        return;
      }
      setRegisteredPresetSnapshot(presets);
      requestAnimationFrame(() => {
        if (tabContextMenuOpenSeqRef.current === seq) {
          tabContextMenu.open(x, y, tabId);
        }
      });
    })();
  }, [tabContextMenu]);

  const closeTabContextMenu = useCallback(() => {
    tabContextMenuOpenSeqRef.current += 1;
    tabContextMenu.close();
    tabContextMenuRestoreFocusElementRef.current = null;
    setRegisteredPresetSnapshot([]);
  }, [tabContextMenu]);

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
      terminalRefsMap.current.get(tab.id)?.current?.fit();
    });
  }, []);

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
  const runtimeResidency = useTerminalRuntimeResidency({
    tabs: wm.tabs,
    workspaces: wm.workspaces,
    gridLayouts: wm.gridLayouts,
    activeWorkspaceId: wm.activeWorkspaceId,
    isMobile,
  });
  const residentTabIds = useMemo(
    () => new Set(runtimeResidency.residentTabs.map(tab => tab.id)),
    [runtimeResidency.residentTabs],
  );
  const tabModeHostTabs = useMemo(
    () => wm.tabs.filter(tab => residentTabIds.has(tab.id) || tab.status === 'disconnected'),
    [residentTabIds, wm.tabs],
  );

  const tabContextMenuItems = useMemo(() => {
    if (!tabContextMenu.targetId || !activeTab) return [];
    const tabRef = terminalRefsMap.current.get(tabContextMenu.targetId);
    const hasSelection = tabRef?.current?.hasSelection() ?? false;
    return buildTerminalContextMenuItems({
      tab: activeTab,
      tabs: wm.activeWorkspaceTabs,
      maxTabs: 8,
      availableShells,
      onAddTab: handleAddTab,
      onCloseTab: () => {
        handleCloseTab(activeTab.id);
        closeTabContextMenu();
      },
      onCopy: async () => {
        const text = tabRef?.current?.getSelection() ?? '';
        if (text) await navigator.clipboard.writeText(text);
      },
      onPaste: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) tabRef?.current?.sendInput(text);
        } catch { /* ignore */ }
      },
      hasSelection,
      registeredPresetMenu: {
        presets: registeredPresetSnapshot,
        onSelectPreset: (preset) => handleRegisteredPresetPaste(tabContextMenu.targetId!, preset),
      },
    });
  }, [
    tabContextMenu.targetId,
    activeTab,
    wm.activeWorkspaceTabs,
    availableShells,
    handleAddTab,
    handleCloseTab,
    closeTabContextMenu,
    registeredPresetSnapshot,
    handleRegisteredPresetPaste,
  ]);

  const renderTerminal = useCallback((
    tab: WorkspaceTabRuntime,
    surface?: {
      className?: string;
      style?: React.CSSProperties;
      onContextMenu?: (x: number, y: number) => void;
      onPointerDown?: () => void;
    },
  ) => {
    if (tab.status === 'disconnected') {
      // GridCell already renders DisconnectedOverlay — return empty container
      return <div style={{ width: '100%', height: '100%' }} />;
    }
    return (
      <TerminalHostSlot
        tabId={tab.id}
        isVisible={true}
        className={surface?.className}
        style={surface?.style}
        onContextMenu={surface?.onContextMenu}
        onPointerDown={surface?.onPointerDown}
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
        activeWorkspaceName={wm.activeWorkspace?.name}
        activeCwd={activeTab?.cwd}
        viewMode={viewMode}
        onToggleViewMode={wm.activeWorkspace ? handleToggleViewMode : undefined}
        onOpenCommandPresetManager={() => setShowCommandPresetDialog(true)}
        onOpenTerminalShortcutManager={() => setShowTerminalShortcutDialog(true)}
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
            {wm.activeWorkspace ? (
              <>
                {/* Tab Mode only — hide TabBar in Grid Mode */}
                {wm.activeWorkspaceTabs.length > 0 && (viewMode === 'tab' || isMobile) && <WorkspaceTabBar
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

                <TerminalRuntimeProvider>
                  <TerminalWorkspaceStage
                    tabs={runtimeResidency.residentTabs}
                    terminalRefsMap={terminalRefsMap}
                    onStatusChange={handleTerminalStatusChange}
                    onCwdChange={handleCwdChange}
                    onAuthError={handleAuthError}
                    onFitAll={handleFitAllTerminals}
                    terminalShortcutState={terminalShortcuts.state}
                  >
                    {(handleLayoutChange: () => void) => wm.activeWorkspaceTabs.length > 0 ? (
                      <>
                  {viewMode === 'grid' && !isMobile ? (
                    <MosaicContainer
                      tabs={wm.activeWorkspaceTabs}
                      activeTabId={wm.activeWorkspace?.activeTabId ?? null}
                      workspaceId={wm.activeWorkspaceId!}
                      onAddTab={handleAddTab}
                      onCloseTab={handleCloseTabDirect}
                      onRestartTab={handleRestartTab}
                      onSelectTab={handleSelectTab}
                      onRenameTab={handleRenameTab}
                      renderTerminal={renderTerminal}
                      availableShells={availableShells}
                      getTerminalSelection={getTerminalSelection}
                      hasTerminalSelection={hasTerminalSelection}
                      sendTerminalInput={sendTerminalInput}
                      pasteTerminalInput={pasteTerminalInput}
                      focusTerminal={focusTerminal}
                      onLayoutChange={handleLayoutChange}
                    />
                  ) : null}

                  {/* Tab Mode: render ALL tabs across all workspaces, hide inactive */}
                  {/* This keeps xterm instances alive across workspace switches (FR-004) */}
                  {(viewMode === 'tab' || isMobile) && tabModeHostTabs
                    .map(tab => {
                      const ws = wm.workspaces.find(w => w.id === tab.workspaceId);
                      const isActiveWs = tab.workspaceId === wm.activeWorkspaceId;
                      const isActiveTab = ws?.activeTabId === tab.id;
                      const isVisible = isActiveWs && isActiveTab;

                      return (
                        <div
                          key={`ws-${tab.id}-${tab.sessionId}`}
                          className={isVisible && tab.status === 'running' ? 'terminal-running' : ''}
                          style={{
                            display: isVisible ? 'flex' : 'none',
                            flexDirection: 'column',
                            width: '100%',
                            height: '100%',
                            '--tab-color': TAB_COLORS[tab.colorIndex] || TAB_COLORS[0],
                          } as React.CSSProperties}
                          onContextMenu={isVisible ? (e) => {
                            e.preventDefault();
                            openTabContextMenu(e.clientX, e.clientY, tab.id);
                          } : undefined}
                        >
                          {tab.status === 'disconnected' ? (
                            isVisible ? (
                              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                                <DisconnectedOverlay onRestart={() => handleRestartTab(tab.id)} />
                              </div>
                            ) : null
                          ) : (
                            <TerminalHostSlot
                              tabId={tab.id}
                              isVisible={isVisible}
                              className={isVisible && tab.status === 'running' ? 'terminal-running' : ''}
                              style={{ '--tab-color': TAB_COLORS[tab.colorIndex] || TAB_COLORS[0] } as React.CSSProperties}
                              onContextMenu={(x, y) => openTabContextMenu(x, y, tab.id)}
                              onPointerDown={() => focusTerminal(tab.id)}
                            />
                          )}
                          {isVisible && (
                            <MetadataRow
                              tab={tab}
                              onRename={(name) => handleRenameTab(tab.id, name)}
                            />
                          )}
                        </div>
                      );
                    })
                  }

                      </>
                    ) : (
                      <EmptyState onAddTab={(shell) => handleAddTab(undefined, shell)} availableShells={availableShells} />
                    )}
                  </TerminalWorkspaceStage>
                </TerminalRuntimeProvider>
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
          onClose={closeTabContextMenu}
          restoreFocusElement={tabContextMenuRestoreFocusElementRef.current}
        />
      )}

      {showCommandPresetDialog && (
        <CommandPresetDialog
          open={showCommandPresetDialog}
          activeTabId={activeTab?.id ?? null}
          activeShellType={activeTab?.shellType ?? null}
          onClose={() => setShowCommandPresetDialog(false)}
          onSendTerminalInput={sendTerminalInput}
        />
      )}

      {showTerminalShortcutDialog && (
        <TerminalShortcutDialog
          open={showTerminalShortcutDialog}
          activeTabId={activeTab?.id ?? null}
          activeWorkspaceId={wm.activeWorkspaceId}
          activeSessionId={activeTab?.sessionId ?? null}
          onClose={() => setShowTerminalShortcutDialog(false)}
          onSendTerminalInput={sendTerminalInput}
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
        <TerminalShortcutProvider>
          <AppContent />
        </TerminalShortcutProvider>
      </WebSocketProvider>
    </AuthGuard>
  );
}

export default App;
