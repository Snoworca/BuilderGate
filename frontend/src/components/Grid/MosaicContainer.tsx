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
import { useContextMenu } from '../../hooks/useContextMenu';
import { useFocusHistory } from '../../hooks/useFocusHistory';
import { buildTerminalContextMenuItems } from '../../utils/contextMenuBuilder';
import {
  applyFocusMode,
  applyMultiFocusApprox,
  AUTO_FOCUS_RATIO_KEY,
  AUTO_FOCUS_RATIO_DEFAULT,
  buildRecoveredEqualMosaicTree,
  FOCUS_RATIO_KEY,
  FOCUS_RATIO_DEFAULT,
  buildEqualMosaicTree,
  clampSplitPercentages,
  extractLeafIds,
  getMinPercentage,
  isFixedEqualMosaicTree,
  removeFromMosaicTree,
  restoreLayoutWithSessionRecovery,
  type EqualLayoutArrangement,
} from '../../utils/mosaic';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import type { MosaicNode } from '../../types/workspace';
import type { ShellInfo } from '../../types';

interface MosaicContainerProps {
  tabs: WorkspaceTabRuntime[];
  activeTabId: string | null;
  workspaceId: string;
  onAddTab: (cwd?: string, shell?: string) => void;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  renderTerminal: (
    tab: WorkspaceTabRuntime,
    surface?: {
      className?: string;
      style?: React.CSSProperties;
      onContextMenu?: (x: number, y: number) => void;
      onPointerDown?: () => void;
    },
  ) => React.ReactNode;
  availableShells?: ShellInfo[];
  getTerminalSelection?: (tabId: string) => string;
  hasTerminalSelection?: (tabId: string) => boolean;
  sendTerminalInput?: (tabId: string, data: string) => void;
  focusTerminal?: (tabId: string) => void;
  onLayoutChange?: () => void;
}

export function MosaicContainer({
  tabs,
  activeTabId,
  workspaceId,
  onAddTab,
  onCloseTab,
  onRestartTab,
  onSelectTab,
  onRenameTab,
  renderTerminal,
  availableShells,
  getTerminalSelection,
  hasTerminalSelection,
  sendTerminalInput,
  focusTerminal,
  onLayoutChange,
}: MosaicContainerProps) {
  const currentTabIds = tabs.map(t => t.id);
  const currentTabIdsKey = currentTabIds.join(',');
  const scheduleLayoutRefresh = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        onLayoutChange?.();
      });
    });
  }, [onLayoutChange]);
  const {
    mosaicTree,
    setMosaicTree,
    debouncedSave,
    layoutMode: persistedMode,
    focusTarget: persistedFocusTarget,
    setLayoutMode: persistLayoutMode,
    setFocusTarget: persistFocusTarget,
  } = useMosaicLayout(workspaceId, currentTabIds);

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

  const layoutMode = persistedMode;
  const focusTarget = persistedMode === 'focus' ? persistedFocusTarget : null;

  const contextMenu = useContextMenu();
  const focusHistory = useFocusHistory();
  const mosaicTreeRef = useRef(mosaicTree);
  mosaicTreeRef.current = mosaicTree;
  const lastMosaicChangeRef = useRef<MosaicNode<string> | null>(mosaicTree);
  const equalArrangementRef = useRef<EqualLayoutArrangement>('rows');

  // Pending close tab confirmation
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  // Focus refs per tile (DOM element) — used to programmatically focus a tile
  const tileFocusRefs = useRef<Map<string, HTMLElement>>(new Map());

  // User interaction detection
  const isSplitResizeInteractionRef = useRef(false);
  const isTileDragInteractionRef = useRef(false);
  const splitInteractionStartKeyRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const getEqualArrangementForButtonPress = useCallback((): EqualLayoutArrangement => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && rect.height > rect.width) {
      return 'cols';
    }
    return 'rows';
  }, []);

  const getCurrentEqualArrangement = useCallback((): EqualLayoutArrangement => {
    if (isFixedEqualMosaicTree(mosaicTreeRef.current, 'rows')) {
      return 'rows';
    }
    if (isFixedEqualMosaicTree(mosaicTreeRef.current, 'cols')) {
      return 'cols';
    }
    return equalArrangementRef.current;
  }, []);

  const getValidFocusTarget = useCallback(
    (candidate?: string | null, ids: string[] = currentTabIds): string | null => {
      return candidate && ids.includes(candidate) ? candidate : null;
    },
    [currentTabIds],
  );

  const buildTreeForMode = useCallback(
    (
      ids: string[],
      mode: typeof layoutMode,
      focusCandidate?: string | null,
      sourceTree: MosaicNode<string> | null = mosaicTreeRef.current,
    ): MosaicNode<string> => {
      const arrangement = getCurrentEqualArrangement();
      const recoveredTree = sourceTree
        ? restoreLayoutWithSessionRecovery(sourceTree, ids).tree
        : buildEqualMosaicTree(ids, arrangement);
      const equalTree = buildRecoveredEqualMosaicTree(recoveredTree, ids, arrangement);

      if (mode === 'none') {
        return recoveredTree;
      }

      if (mode === 'equal') {
        return equalTree;
      }

      const minPct = getMinPercentage(ids.length);
      if (mode === 'focus') {
        const validFocusTarget = getValidFocusTarget(focusCandidate, ids);
        return validFocusTarget
          ? applyFocusMode(recoveredTree, validFocusTarget, minPct, getFocusRatio())
          : equalTree;
      }

      const idleIds = new Set(
        tabs
          .filter(tab => ids.includes(tab.id) && tab.status === 'idle')
          .map(tab => tab.id),
      );
      return applyMultiFocusApprox(recoveredTree, idleIds, minPct, getAutoRatio());
    },
    [getAutoRatio, getCurrentEqualArrangement, getFocusRatio, getValidFocusTarget, tabs],
  );

  useEffect(() => {
    if (layoutMode !== 'equal' || !mosaicTree) {
      return;
    }

    if (isFixedEqualMosaicTree(mosaicTree, 'rows')) {
      equalArrangementRef.current = 'rows';
      return;
    }

    if (isFixedEqualMosaicTree(mosaicTree, 'cols')) {
      equalArrangementRef.current = 'cols';
    }
  }, [layoutMode, mosaicTree]);

  // tabMap for O(1) lookup
  const tabMap = useMemo(() => new Map(tabs.map(t => [t.id, t])), [tabs]);

  // 방어 레이어: mosaicTree leaf 중 tabMap에 없는 stale ID가 있으면 즉시 재빌드.
  // useMosaicLayout의 currentTabIds stale 클로저 버그가 edge case로 발동하더라도
  // 여기서 EmptyCell 범람(+ 버튼 화면)을 막는 이중 안전망.
  useEffect(() => {
    if (!mosaicTree || currentTabIds.length === 0) return;
    const leafIds = extractLeafIds(mosaicTree);
      const hasStale = leafIds.some(id => !tabMap.has(id));
      if (hasStale) {
        const validFocusTarget = getValidFocusTarget(focusTarget);
        if (layoutMode === 'focus' && !validFocusTarget) {
          persistLayoutMode('equal');
          persistFocusTarget(null);
        }
      setMosaicTree(buildTreeForMode(currentTabIds, layoutMode === 'focus' && !validFocusTarget ? 'equal' : layoutMode, validFocusTarget));
      scheduleLayoutRefresh();
    }
  }, [
    buildTreeForMode,
    currentTabIds,
    focusTarget,
    getValidFocusTarget,
    layoutMode,
    mosaicTree,
    persistFocusTarget,
    persistLayoutMode,
    scheduleLayoutRefresh,
    setMosaicTree,
    tabMap,
  ]);

  // Rebuild tree when tab list length changes
  // prevTabCountRef는 workspaceId 기준으로 초기화 — 워크스페이스 전환은 탭 수 변경으로 취급하지 않음
  const prevTabCountRef = useRef(tabs.length);
  const prevWorkspaceIdRef = useRef(workspaceId);
  useEffect(() => {
    const isWorkspaceSwitch = prevWorkspaceIdRef.current !== workspaceId;
    prevWorkspaceIdRef.current = workspaceId;

    const prevCount = prevTabCountRef.current;
    prevTabCountRef.current = tabs.length;

    // 워크스페이스 전환 시에는 useMosaicLayout이 트리 복원을 담당
    // tabs.length === 0 포함 모든 케이스를 skip — 전환 직후 탭 로딩 전 순간에
    // setMosaicTree(null)이 호출되어 흰 화면(EmptyCell)이 노출되는 버그 방지
    if (isWorkspaceSwitch) return;

    if (tabs.length === 0) {
      setMosaicTree(null);
      return;
    }

    if (mosaicTree === null) return;

    // 동일 워크스페이스 내 탭 추가/삭제 시에도 현재 mode 계약을 보존한다.
    if (prevCount !== tabs.length) {
      const ids = tabs.map(t => t.id);
      const validFocusTarget = getValidFocusTarget(focusTarget, ids);
      const nextMode = layoutMode === 'focus' && !validFocusTarget ? 'equal' : layoutMode;

      if (nextMode !== layoutMode) {
        persistLayoutMode('equal');
        persistFocusTarget(null);
      } else if (layoutMode !== 'focus') {
        persistFocusTarget(null);
      }

      setMosaicTree(buildTreeForMode(ids, nextMode, validFocusTarget));
      scheduleLayoutRefresh();
    }
  }, [
    buildTreeForMode,
    currentTabIds,
    focusTarget,
    getValidFocusTarget,
    layoutMode,
    mosaicTree,
    persistFocusTarget,
    persistLayoutMode,
    scheduleLayoutRefresh,
    setMosaicTree,
    tabs,
    tabs.length,
    workspaceId,
  ]);

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

  // Attach pointer listeners to mosaic-split elements for user drag detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.mosaic-split')) {
        isSplitResizeInteractionRef.current = true;
        splitInteractionStartKeyRef.current = mosaicTreeRef.current ? JSON.stringify(mosaicTreeRef.current) : 'null';
      }
    };

    container.addEventListener('pointerdown', handlePointerDown);
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  // Handle mosaic tree change (from user drag/resize)
  const handleMosaicChange = useCallback(
    (newTree: MosaicNode<string> | null) => {
      const minPct = getMinPercentage(tabs.length);
      const clamped = newTree ? clampSplitPercentages(newTree, minPct) : null;
      lastMosaicChangeRef.current = clamped;
      setMosaicTree(clamped);
      const deferSaveUntilDropCommit = isTileDragInteractionRef.current && layoutMode === 'equal';
      if (!deferSaveUntilDropCommit) {
        debouncedSave();
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onLayoutChange?.();
        });
      });
    },
    [layoutMode, tabs.length, setMosaicTree, debouncedSave, onLayoutChange],
  );

  const applyModeToTree = useCallback((
    mode: typeof layoutMode,
    tree: MosaicNode<string>,
    focusTabId?: string | null,
  ): MosaicNode<string> => {
    const minPct = getMinPercentage(tabs.length);
    if (mode === 'none') return tree;
    if (mode === 'equal') return buildEqualMosaicTree(extractLeafIds(tree), equalArrangementRef.current);
    if (mode === 'focus') {
      const target = focusTabId ?? null;
      return target ? applyFocusMode(tree, target, minPct, getFocusRatio()) : buildEqualMosaicTree(extractLeafIds(tree), equalArrangementRef.current);
    }
    const idleIds = new Set(tabs.filter(t => t.status === 'idle').map(t => t.id));
    return applyMultiFocusApprox(tree, idleIds, minPct, getAutoRatio());
  }, [tabs, getFocusRatio, getAutoRatio, layoutMode]);

  const handleLayoutModeChange = useCallback(
    (mode: typeof layoutMode, focusTabId?: string, source: 'toolbar' | 'focus-sync' = 'toolbar') => {
      const nextMode =
        source === 'toolbar' && mode === 'focus'
          ? (layoutMode === 'focus' && focusTarget === (focusTabId ?? null) ? 'none' : 'focus')
          : source === 'toolbar' && layoutMode === mode
          ? 'none'
          : mode;
      if (source === 'toolbar' && nextMode === 'equal') {
        equalArrangementRef.current = getEqualArrangementForButtonPress();
      }

      // useMosaicLayout의 state도 동기화하여 debouncedSave가 올바른 값 저장
      persistLayoutMode(nextMode);
      persistFocusTarget(nextMode === 'focus' ? (focusTabId ?? null) : null);

      // Apply immediately to tree
      if (mosaicTree) {
        const newTree = applyModeToTree(nextMode, mosaicTree, focusTabId ?? null);
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
    [layoutMode, focusTarget, persistLayoutMode, persistFocusTarget, mosaicTree, setMosaicTree, debouncedSave, onLayoutChange, applyModeToTree, getEqualArrangementForButtonPress],
  );

  // Focus mode: if focus target tab is closed or replaced, revert to equal mode
  useEffect(() => {
    if (layoutMode !== 'focus' || !focusTarget) return;
    const targetStillExists = currentTabIds.includes(focusTarget);
    if (!targetStillExists) {
      handleLayoutModeChange('equal', undefined, 'focus-sync');
    }
  }, [currentTabIdsKey, focusTarget, handleLayoutModeChange, layoutMode]);

  const handleMosaicRelease = useCallback((releasedTree: MosaicNode<string> | null) => {
    if (!isSplitResizeInteractionRef.current) {
      return;
    }

    if (!releasedTree) {
      isSplitResizeInteractionRef.current = false;
      splitInteractionStartKeyRef.current = null;
      return;
    }

    const minPct = getMinPercentage(tabs.length);
    const clamped = clampSplitPercentages(releasedTree, minPct);
    if (!clamped) {
      isSplitResizeInteractionRef.current = false;
      splitInteractionStartKeyRef.current = null;
      return;
    }

    const releasedKey = JSON.stringify(clamped);
    const hasRealResize = splitInteractionStartKeyRef.current !== null && splitInteractionStartKeyRef.current !== releasedKey;
    if (layoutMode === 'equal' && hasRealResize) {
      persistLayoutMode('none');
      persistFocusTarget(null);
    }
    setMosaicTree(clamped);
    debouncedSave();
    scheduleLayoutRefresh();

    isSplitResizeInteractionRef.current = false;
    splitInteractionStartKeyRef.current = null;
  }, [layoutMode, persistLayoutMode, persistFocusTarget, setMosaicTree, debouncedSave, scheduleLayoutRefresh, tabs.length]);

  const handleTileDragEnd = useCallback((type: 'drop' | 'reset') => {
    if (type === 'drop' && layoutMode === 'equal' && lastMosaicChangeRef.current) {
      const equalized = buildEqualMosaicTree(
        extractLeafIds(lastMosaicChangeRef.current),
        equalArrangementRef.current,
      );
      lastMosaicChangeRef.current = equalized;
      setMosaicTree(equalized);
      persistLayoutMode('equal');
      persistFocusTarget(null);
      debouncedSave();
      scheduleLayoutRefresh();
    }

    isTileDragInteractionRef.current = false;
  }, [layoutMode, setMosaicTree, persistLayoutMode, persistFocusTarget, debouncedSave, scheduleLayoutRefresh]);

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
    if (prevTabId && tabs.some((tab) => tab.id === prevTabId && tab.status !== 'disconnected')) {
      onSelectTab(prevTabId);
      focusTerminal?.(prevTabId);
    }
  }, [pendingCloseTabId, focusHistory, mosaicTree, setMosaicTree, onCloseTab, focusTerminal, onSelectTab, tabs]);

  // Handle tile focus (pointer down on any tile) — record in focus history
  // In focus mode: dynamically update focusTarget to the clicked tile
  const handleTileFocus = useCallback(
    (tabId: string) => {
      focusHistory.recordFocus(tabId);
      if (tabId !== activeTabId) {
        onSelectTab(tabId);
      }
      if (layoutMode === 'focus') {
        handleLayoutModeChange('focus', tabId, 'focus-sync');
      }
    },
    [focusHistory, activeTabId, onSelectTab, layoutMode, handleLayoutModeChange],
  );

  // Register/unregister tile DOM elements for focus targeting
  const registerTileRef = useCallback((tabId: string, el: HTMLElement | null) => {
    if (el) {
      tileFocusRefs.current.set(tabId, el);
    } else {
      tileFocusRefs.current.delete(tabId);
    }
  }, []);

  // Render each tile — the custom move handle remains the only drag source
  // so mode transitions do not depend on MosaicWindow's toolbar-wide wrapper.
  const renderTile = useCallback(
    (tabId: string, path: MosaicBranch[]) => {
      const tab = tabMap.get(tabId);
      return (
        <MosaicWindow<string>
          path={path}
          title={tabId}
          draggable={false}
          onDragStart={() => {
            isTileDragInteractionRef.current = true;
          }}
          onDragEnd={handleTileDragEnd}
          renderToolbar={() => (
            <div style={{ position: 'relative', width: '100%', height: 0, overflow: 'visible' }}>
              <MosaicToolbar
                layoutMode={layoutMode}
                onLayoutModeChange={(mode) => {
                  if (mode === 'focus') {
                    handleLayoutModeChange('focus', tabId, 'toolbar');
                  } else {
                    handleLayoutModeChange(mode, undefined, 'toolbar');
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
            onFocus={() => handleTileFocus(tabId)}
            onRegisterRef={(el) => registerTileRef(tabId, el)}
            onRenameTab={onRenameTab}
          >
            {tab ? renderTerminal(tab, {
              className: `grid-cell${tab.status === 'running' ? ' terminal-running' : ''}`,
              style: { '--tab-color': TAB_COLORS[tab.colorIndex] || TAB_COLORS[0] } as React.CSSProperties,
              onContextMenu: (x, y) => contextMenu.open(x, y, tabId),
              onPointerDown: () => {
                handleTileFocus(tabId);
                focusTerminal?.(tabId);
              },
            }) : null}
          </MosaicTile>
        </MosaicWindow>
      );
    },
    [
      tabMap,
      layoutMode,
      contextMenu.open,
      handleLayoutModeChange,
      handleTileDragEnd,
      onRestartTab,
      onAddTab,
      renderTerminal,
      handleTileFocus,
      registerTileRef,
      availableShells,
    ],
  );

  const minPaneSizePercentage = getMinPercentage(tabs.length);
  const effectiveTree = (() => {
    if (currentTabIds.length === 0) return null;
    if (!mosaicTree) return null;

    const leafIds = extractLeafIds(mosaicTree);
    const hasStaleLeaf = leafIds.some((id) => !tabMap.has(id));
    const hasMissingCurrentTab = currentTabIds.some((id) => !leafIds.includes(id));
    return hasStaleLeaf || hasMissingCurrentTab
      ? buildTreeForMode(currentTabIds, layoutMode, focusTarget)
      : mosaicTree;
  })();

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {effectiveTree === null ? (
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
          value={effectiveTree}
          onChange={handleMosaicChange}
          onRelease={handleMosaicRelease}
          renderTile={renderTile}
          className="mosaic-blueprint-theme"
          reorderEnabled={layoutMode === 'equal'}
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
