import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mosaic, MosaicWindow } from 'react-mosaic-component';
import type { MosaicBranch } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import './MosaicOverrides.css';
import { MosaicTile } from './MosaicTile';
import { MosaicToolbar } from './MosaicToolbar';
import { ContextMenu } from '../ContextMenu';
import { ConfirmModal } from '../Modal';
import { useMosaicLayout } from '../../hooks/useMosaicLayout';
import { useLayoutMode } from '../../hooks/useLayoutMode';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useFocusHistory } from '../../hooks/useFocusHistory';
import { buildTerminalContextMenuItems } from '../../utils/contextMenuBuilder';
import {
  applyEqualMode,
  applyFocusMode,
  applyMultiFocusApprox,
  AUTO_FOCUS_RATIO_KEY,
  AUTO_FOCUS_RATIO_DEFAULT,
  FOCUS_RATIO_KEY,
  FOCUS_RATIO_DEFAULT,
  buildEqualMosaicTree,
  clampSplitPercentages,
  getMinPercentage,
  removeFromMosaicTree,
} from '../../utils/mosaic';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import type { MosaicNode } from '../../types/workspace';
import type { ShellInfo } from '../../types';

interface MosaicContainerProps {
  tabs: WorkspaceTabRuntime[];
  workspaceId: string;
  onAddTab: (cwd?: string, shell?: string) => void;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  renderTerminal: (tab: WorkspaceTabRuntime) => React.ReactNode;
  availableShells?: ShellInfo[];
  getTerminalSelection?: (tabId: string) => string;
  hasTerminalSelection?: (tabId: string) => boolean;
  sendTerminalInput?: (tabId: string, data: string) => void;
  onLayoutChange?: () => void;
}

export function MosaicContainer({
  tabs,
  workspaceId,
  onAddTab,
  onCloseTab,
  onRestartTab,
  onRenameTab,
  renderTerminal,
  availableShells,
  getTerminalSelection,
  hasTerminalSelection,
  sendTerminalInput,
  onLayoutChange,
}: MosaicContainerProps) {
  const currentTabIds = tabs.map(t => t.id);
  const { mosaicTree, setMosaicTree, debouncedSave, layoutMode: persistedMode, focusTarget: persistedFocusTarget } =
    useMosaicLayout(workspaceId, currentTabIds);

  // localStorage에서 auto 모드 가중치 비율 읽기
  const getAutoRatio = useCallback(() => {
    try {
      const v = localStorage.getItem(AUTO_FOCUS_RATIO_KEY);
      if (v) { const n = parseFloat(v); if (n >= 1 && n <= 3) return n; }
    } catch { /* ignore */ }
    return AUTO_FOCUS_RATIO_DEFAULT;
  }, []);

  // localStorage에서 focus 모드 비율 읽기
  const getFocusRatio = useCallback(() => {
    try {
      const v = localStorage.getItem(FOCUS_RATIO_KEY);
      if (v) { const n = parseFloat(v); if (n > 0 && n < 1) return n; }
    } catch { /* ignore */ }
    return FOCUS_RATIO_DEFAULT;
  }, []);

  const { mode: layoutMode, focusTarget, setMode } = useLayoutMode(
    persistedMode,
    persistedFocusTarget,
  );

  const contextMenu = useContextMenu();
  const focusHistory = useFocusHistory();

  // Pending close tab confirmation
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  // Focus refs per tile (DOM element) — used to programmatically focus a tile
  const tileFocusRefs = useRef<Map<string, HTMLElement>>(new Map());

  // User drag detection via pointerdown/pointerup on .mosaic-split
  const isUserDragRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // tabMap for O(1) lookup
  const tabMap = useMemo(() => new Map(tabs.map(t => [t.id, t])), [tabs]);

  // Rebuild tree when tab list length changes
  const prevTabCountRef = useRef(tabs.length);
  useEffect(() => {
    const prevCount = prevTabCountRef.current;
    prevTabCountRef.current = tabs.length;

    if (tabs.length === 0) {
      setMosaicTree(null);
      return;
    }

    // If count changed, rebuild equal tree with current tab ids
    if (prevCount !== tabs.length) {
      const ids = tabs.map(t => t.id);
      setMosaicTree(buildEqualMosaicTree(ids));
    }
  }, [tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto mode: re-apply tree when tab statuses change (3s delay)
  const tabStatusKey = tabs.map(t => `${t.id}:${t.status}`).join(',');
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  useEffect(() => {
    if (layoutMode !== 'auto') return;
    if (!mosaicTree) return;
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = setTimeout(() => {
      const idleIds = new Set(tabs.filter(t => t.status === 'idle').map(t => t.id));
      const minPct = getMinPercentage(tabs.length);
      setMosaicTree(prev => prev ? applyMultiFocusApprox(prev, idleIds, minPct, getAutoRatio()) : prev);
      autoTimerRef.current = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onLayoutChangeRef.current?.();
        });
      });
    }, 1500);
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, [tabStatusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus mode: if focus target tab is closed, revert to equal mode
  useEffect(() => {
    if (layoutMode !== 'focus' || !focusTarget) return;
    const targetStillExists = tabs.some(t => t.id === focusTarget);
    if (!targetStillExists) {
      handleLayoutModeChange('equal');
    }
  }, [tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach pointer listeners to mosaic-split elements for user drag detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.mosaic-split')) {
        isUserDragRef.current = true;
      }
    };

    const handlePointerUp = () => {
      isUserDragRef.current = false;
    };

    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointerup', handlePointerUp);
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  // Handle mosaic tree change (from user drag/resize)
  const handleMosaicChange = useCallback(
    (newTree: MosaicNode<string> | null) => {
      const minPct = getMinPercentage(tabs.length);
      const clamped = newTree ? clampSplitPercentages(newTree, minPct) : null;
      setMosaicTree(clamped);
      debouncedSave();
    },
    [tabs.length, setMosaicTree, debouncedSave],
  );

  const handleLayoutModeChange = useCallback(
    (mode: typeof layoutMode, focusTabId?: string) => {
      setMode(mode, focusTabId);
      // Apply immediately to tree
      if (mosaicTree) {
        const minPct = getMinPercentage(tabs.length);
        let newTree: MosaicNode<string>;
        if (mode === 'equal') {
          newTree = applyEqualMode(mosaicTree);
        } else if (mode === 'focus') {
          const target = focusTabId ?? null;
          newTree = target ? applyFocusMode(mosaicTree, target, minPct, getFocusRatio()) : applyEqualMode(mosaicTree);
        } else {
          const idleIds = new Set(tabs.filter(t => t.status === 'idle').map(t => t.id));
          newTree = applyMultiFocusApprox(mosaicTree, idleIds, minPct, getAutoRatio());
        }
        setMosaicTree(newTree);
      }
      debouncedSave();
      // React 렌더링 후 DOM 레이아웃이 완전히 적용된 뒤 터미널 fit 강제 실행.
      // 드래그와 달리 모드 변경은 React 상태 갱신 경로를 거치므로
      // ResizeObserver가 신뢰성 있게 발동하지 않는 경우가 있음.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onLayoutChange?.();
        });
      });
    },
    [setMode, mosaicTree, tabs, setMosaicTree, debouncedSave, onLayoutChange],
  );

  // Clipboard: copy selected text from terminal (reads from clipboard after xterm writes it)
  const handleCopy = useCallback(async (tabId: string) => {
    try {
      const text = getTerminalSelection ? getTerminalSelection(tabId) : '';
      if (text) await navigator.clipboard.writeText(text);
    } catch {
      console.warn('[MosaicContainer] Clipboard copy failed');
    }
  }, [getTerminalSelection]);

  const handlePaste = useCallback(async (tabId: string) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendTerminalInput?.(tabId, text);
    } catch {
      console.warn('[MosaicContainer] Clipboard paste failed');
    }
  }, [sendTerminalInput]);

  // Build context menu items for the target tab
  const buildMenuItems = useCallback(
    (tabId: string) => {
      const tab = tabMap.get(tabId);
      const hasSelection = hasTerminalSelection ? hasTerminalSelection(tabId) : false;
      return buildTerminalContextMenuItems({
        tab,
        tabs,
        maxTabs: 8,
        availableShells,
        onAddTab,
        onCloseTab: () => {
          setPendingCloseTabId(tabId);
          contextMenu.close();
        },
        onCopy: () => handleCopy(tabId),
        onPaste: () => handlePaste(tabId),
        hasSelection,
      });
    },
    [tabMap, tabs, availableShells, onAddTab, contextMenu, handleCopy, handlePaste, hasTerminalSelection],
  );

  // Context menu items derived from current targetId
  const contextMenuItems = useMemo(() => {
    if (!contextMenu.targetId) return [];
    return buildMenuItems(contextMenu.targetId);
  }, [contextMenu.targetId, buildMenuItems]);

  // Close tab: remove from mosaic tree and shift focus to previous tab
  const handleConfirmClose = useCallback(() => {
    if (!pendingCloseTabId) return;
    const prevTabId = focusHistory.getPrevious(pendingCloseTabId);
    const newTree = removeFromMosaicTree(mosaicTree, pendingCloseTabId);
    setMosaicTree(newTree);
    onCloseTab(pendingCloseTabId);
    setPendingCloseTabId(null);
    // Focus the previous tab's xterm textarea if available
    if (prevTabId) {
      const tileEl = tileFocusRefs.current.get(prevTabId);
      if (tileEl) {
        const xtermInput = tileEl.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
        xtermInput?.focus();
      }
    }
  }, [pendingCloseTabId, focusHistory, mosaicTree, setMosaicTree, onCloseTab]);

  // Handle tile focus (pointer down on any tile) — record in focus history
  // In focus mode: dynamically update focusTarget to the clicked tile
  const handleTileFocus = useCallback(
    (tabId: string) => {
      focusHistory.recordFocus(tabId);
      if (layoutMode === 'focus') {
        handleLayoutModeChange('focus', tabId);
      }
    },
    [focusHistory, layoutMode, handleLayoutModeChange],
  );

  // Register/unregister tile DOM elements for focus targeting
  const registerTileRef = useCallback((tabId: string, el: HTMLElement | null) => {
    if (el) {
      tileFocusRefs.current.set(tabId, el);
    } else {
      tileFocusRefs.current.delete(tabId);
    }
  }, []);

  // Render each tile — wrapped in MosaicWindow for DnD support (FR-1.1)
  const renderTile = useCallback(
    (tabId: string, path: MosaicBranch[]) => {
      const tab = tabMap.get(tabId);
      return (
        <MosaicWindow<string>
          path={path}
          title={tabId}
          renderToolbar={() => (
            <div style={{ position: 'relative', width: '100%', height: 0 }}>
              <MosaicToolbar
                layoutMode={layoutMode}
                onLayoutModeChange={(mode) => {
                  if (mode === 'focus') {
                    handleLayoutModeChange('focus', tabId);
                  } else {
                    handleLayoutModeChange(mode);
                  }
                }}
              />
            </div>
          )}
        >
          <MosaicTile
            tabId={tabId}
            tab={tab}
            onContextMenu={contextMenu.open}
            onRestart={() => onRestartTab(tabId)}
            onAdd={(shell?: string) => onAddTab(tab?.cwd, shell)}
            onFocus={() => handleTileFocus(tabId)}
            onRegisterRef={(el) => registerTileRef(tabId, el)}
            onRenameTab={onRenameTab}
            availableShells={availableShells}
          >
            {tab ? renderTerminal(tab) : null}
          </MosaicTile>
        </MosaicWindow>
      );
    },
    [
      tabMap,
      layoutMode,
      contextMenu.open,
      handleLayoutModeChange,
      onRestartTab,
      onAddTab,
      renderTerminal,
      handleTileFocus,
      registerTileRef,
      availableShells,
    ],
  );

  const minPaneSizePercentage = getMinPercentage(tabs.length);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {mosaicTree === null ? (
        // Empty state — no sessions
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted, #666)',
            fontSize: '14px',
          }}
        >
          세션이 없습니다. 새 세션을 시작하세요.
        </div>
      ) : (
        <Mosaic<string>
          value={mosaicTree}
          onChange={handleMosaicChange}
          renderTile={renderTile}
          className="mosaic-blueprint-theme"
          resize={{ minimumPaneSizePercentage: minPaneSizePercentage }}
        />
      )}

      {/* Context menu */}
      {contextMenu.isOpen && contextMenu.position && (
        <ContextMenu
          position={contextMenu.position}
          items={contextMenuItems}
          onClose={contextMenu.close}
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
          onConfirm={handleConfirmClose}
          onCancel={() => setPendingCloseTabId(null)}
        />
      )}
    </div>
  );
}
