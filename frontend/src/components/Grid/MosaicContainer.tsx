import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mosaic } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import { MosaicTile } from './MosaicTile';
import { ContextMenu } from '../ContextMenu';
import { ConfirmModal } from '../Modal';
import { useMosaicLayout } from '../../hooks/useMosaicLayout';
import { useLayoutMode } from '../../hooks/useLayoutMode';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useFocusHistory } from '../../hooks/useFocusHistory';
import {
  applyEqualMode,
  applyFocusMode,
  applyMultiFocusApprox,
  buildEqualMosaicTree,
  clampSplitPercentages,
  getMinPercentage,
  removeFromMosaicTree,
} from '../../utils/mosaic';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import type { MosaicNode } from '../../types/workspace';

interface MosaicContainerProps {
  tabs: WorkspaceTabRuntime[];
  workspaceId: string;
  onAddTab: (cwd?: string) => void;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tabId: string) => void;
  renderTerminal: (tab: WorkspaceTabRuntime) => React.ReactNode;
}

export function MosaicContainer({
  tabs,
  workspaceId,
  onAddTab,
  onCloseTab,
  onRestartTab,
  renderTerminal,
}: MosaicContainerProps) {
  const { mosaicTree, setMosaicTree, debouncedSave, layoutMode: persistedMode, focusTarget: persistedFocusTarget } =
    useMosaicLayout(workspaceId);

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

  // Auto mode: re-apply tree when tab statuses change
  const tabStatusKey = tabs.map(t => `${t.id}:${t.status}`).join(',');
  useEffect(() => {
    if (layoutMode !== 'auto') return;
    if (!mosaicTree) return;
    const idleIds = new Set(tabs.filter(t => t.status === 'idle').map(t => t.id));
    const minPct = getMinPercentage(tabs.length);
    setMosaicTree(applyMultiFocusApprox(mosaicTree, idleIds, minPct));
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
          newTree = target ? applyFocusMode(mosaicTree, target, minPct) : applyEqualMode(mosaicTree);
        } else {
          const idleIds = new Set(tabs.filter(t => t.status === 'idle').map(t => t.id));
          newTree = applyMultiFocusApprox(mosaicTree, idleIds, minPct);
        }
        setMosaicTree(newTree);
      }
      debouncedSave();
    },
    [setMode, mosaicTree, tabs, setMosaicTree, debouncedSave],
  );

  // Clipboard: copy selected text from terminal (reads from clipboard after xterm writes it)
  const handleCopy = useCallback(async () => {
    try {
      // xterm writes selected text to clipboard on Ctrl+C; here we read what's selected
      // via the Selection API from the active focused element or fallback to execCommand
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      if (text) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      console.warn('[MosaicContainer] Clipboard copy failed');
    }
  }, []);

  const handlePaste = useCallback(async (tabId: string) => {
    // Focus the tile's terminal element so the browser fires the paste event into xterm
    const tileEl = tileFocusRefs.current.get(tabId);
    if (tileEl) {
      // Find the xterm textarea (the element that receives keyboard input)
      const xtermInput = tileEl.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
      if (xtermInput) {
        xtermInput.focus();
      }
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      // Dispatch a paste event so xterm's internal handler picks it up
      const target = document.activeElement;
      if (target) {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', text);
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true }));
      }
    } catch {
      console.warn('[MosaicContainer] Clipboard paste failed');
    }
  }, []);

  // Build context menu items for the target tab
  const buildTerminalContextMenuItems = useCallback(
    (tabId: string) => {
      const tab = tabMap.get(tabId);
      return [
        {
          label: '새 세션',
          icon: '+',
          onClick: () => {
            onAddTab(tab?.cwd);
          },
        },
        {
          label: '세션 닫기',
          icon: '✕',
          destructive: true,
          onClick: () => {
            setPendingCloseTabId(tabId);
            contextMenu.close();
          },
        },
        { separator: true } as const,
        {
          label: '복사',
          icon: '⎘',
          onClick: () => {
            handleCopy();
          },
        },
        {
          label: '붙여넣기',
          icon: '⎗',
          onClick: () => {
            handlePaste(tabId);
          },
        },
      ];
    },
    [tabMap, contextMenu, onAddTab, handleCopy, handlePaste],
  );

  // Context menu items derived from current targetId
  const contextMenuItems = useMemo(() => {
    if (!contextMenu.targetId) return [];
    return buildTerminalContextMenuItems(contextMenu.targetId);
  }, [contextMenu.targetId, buildTerminalContextMenuItems]);

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
  const handleTileFocus = useCallback(
    (tabId: string) => {
      focusHistory.recordFocus(tabId);
    },
    [focusHistory],
  );

  // Register/unregister tile DOM elements for focus targeting
  const registerTileRef = useCallback((tabId: string, el: HTMLElement | null) => {
    if (el) {
      tileFocusRefs.current.set(tabId, el);
    } else {
      tileFocusRefs.current.delete(tabId);
    }
  }, []);

  // Render each tile
  const renderTile = useCallback(
    (tabId: string) => {
      const tab = tabMap.get(tabId);
      return (
        <MosaicTile
          tabId={tabId}
          tab={tab}
          layoutMode={layoutMode}
          onContextMenu={contextMenu.open}
          onLayoutModeChange={handleLayoutModeChange}
          onRestart={() => onRestartTab(tabId)}
          onAdd={() => onAddTab(tab?.cwd)}
          onFocus={() => handleTileFocus(tabId)}
          onRegisterRef={(el) => registerTileRef(tabId, el)}
        >
          {tab ? renderTerminal(tab) : null}
        </MosaicTile>
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
