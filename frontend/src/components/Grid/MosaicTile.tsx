import { useCallback, useRef } from 'react';
import { MosaicToolbar } from './MosaicToolbar';
import { EmptyCell } from './EmptyCell';
import { DisconnectedOverlay } from '../Workspace/DisconnectedOverlay';
import { MetadataRow } from '../MetadataBar/MetadataRow';
import { useLongPress } from '../../hooks/useLongPress';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import type { LayoutMode } from '../../hooks/useMosaicLayout';

interface MosaicTileProps {
  tabId: string;
  tab: WorkspaceTabRuntime | undefined;
  layoutMode: LayoutMode;
  onContextMenu: (x: number, y: number, tabId: string) => void;
  onLayoutModeChange: (mode: LayoutMode, focusTabId?: string) => void;
  onRestart: () => void;
  onAdd: () => void;
  /** Called when the user presses down on this tile (focus tracking) */
  onFocus?: () => void;
  /** Receives the tile root DOM element for external focus management */
  onRegisterRef?: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}

export function MosaicTile({
  tabId,
  tab,
  layoutMode,
  onContextMenu,
  onLayoutModeChange,
  onRestart,
  onAdd,
  onFocus,
  onRegisterRef,
  children,
}: MosaicTileProps) {
  const tileRef = useRef<HTMLDivElement>(null);

  // Register DOM element with parent on first render
  const setTileRef = useCallback(
    (el: HTMLDivElement | null) => {
      (tileRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      onRegisterRef?.(el);
    },
    [onRegisterRef],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(e.clientX, e.clientY, tabId);
    },
    [tabId, onContextMenu],
  );

  // Long-press opens context menu on touch devices
  const longPress = useLongPress(
    useCallback(
      ({ clientX, clientY }) => {
        onContextMenu(clientX, clientY, tabId);
      },
      [tabId, onContextMenu],
    ),
    500,
  );

  const handlePointerDown = useCallback(() => {
    onFocus?.();
  }, [onFocus]);

  if (!tab) {
    return <EmptyCell onAdd={onAdd} />;
  }

  const isDisconnected = tab.status === 'disconnected';

  return (
    <div
      ref={setTileRef}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--terminal-bg, #1e1e1e)',
        overflow: 'hidden',
      }}
    >
      {/* Toolbar overlay — focus mode passes this tile's tabId */}
      <MosaicToolbar
        layoutMode={layoutMode}
        onLayoutModeChange={(mode) => {
          if (mode === 'focus') {
            onLayoutModeChange('focus', tabId);
          } else {
            onLayoutModeChange(mode);
          }
        }}
      />

      {/* Terminal content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* Metadata bar */}
      <MetadataRow tab={tab} isOdd={false} />

      {/* Disconnected overlay */}
      {isDisconnected && <DisconnectedOverlay onRestart={onRestart} />}
    </div>
  );
}
