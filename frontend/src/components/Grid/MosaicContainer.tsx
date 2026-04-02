import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mosaic } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import { MosaicTile } from './MosaicTile';
import { ContextMenu } from '../ContextMenu';
import { ConfirmModal } from '../Modal';
import { useMosaicLayout } from '../../hooks/useMosaicLayout';
import { useContextMenu } from '../../hooks/useContextMenu';
import { buildEqualMosaicTree, clampSplitPercentages, getMinPercentage } from '../../utils/mosaic';
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
  const { mosaicTree, setMosaicTree, debouncedSave, layoutMode, setLayoutMode, focusTarget, setFocusTarget } =
    useMosaicLayout(workspaceId);

  const contextMenu = useContextMenu();

  // Pending close tab confirmation
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

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
    (mode: typeof layoutMode) => {
      setLayoutMode(mode);
      debouncedSave();
    },
    [setLayoutMode, debouncedSave],
  );

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
          onAdd={() => onAddTab()}
        >
          {tab ? renderTerminal(tab) : null}
        </MosaicTile>
      );
    },
    [tabMap, layoutMode, contextMenu.open, handleLayoutModeChange, onRestartTab, onAddTab, renderTerminal],
  );

  const minPaneSizePercentage = getMinPercentage(tabs.length);

  // Context menu items (Phase 3 will fill these in)
  const contextMenuItems = useMemo(() => {
    if (!contextMenu.targetId) return [];
    return [
      {
        label: '탭 닫기',
        icon: '✕',
        destructive: true,
        onClick: () => {
          setPendingCloseTabId(contextMenu.targetId);
          contextMenu.close();
        },
      },
    ];
  }, [contextMenu.targetId, contextMenu.close]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Mosaic<string>
        value={mosaicTree}
        onChange={handleMosaicChange}
        renderTile={renderTile}
        className="mosaic-blueprint-theme"
        resize={{ minimumPaneSizePercentage: minPaneSizePercentage }}
      />

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
          title="탭 닫기"
          message="이 세션을 종료하시겠습니까?"
          confirmLabel="닫기"
          destructive
          onConfirm={() => {
            onCloseTab(pendingCloseTabId);
            setPendingCloseTabId(null);
          }}
          onCancel={() => setPendingCloseTabId(null)}
        />
      )}
    </div>
  );
}
