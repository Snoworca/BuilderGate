import { useCallback, useRef } from 'react';
import { EmptyCell } from './EmptyCell';
import { DisconnectedOverlay } from '../Workspace/DisconnectedOverlay';
import { MetadataRow } from '../MetadataBar/MetadataRow';
import { useLongPress } from '../../hooks/useLongPress';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';

interface MosaicTileProps {
  tabId: string;
  tab: WorkspaceTabRuntime | undefined;
  onContextMenu: (x: number, y: number, tabId: string) => void;
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
  onContextMenu,
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
  const isRunning = tab.status === 'running';
  const tabColor = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];

  return (
    <div
      ref={setTileRef}
      className={`grid-cell${isRunning ? ' terminal-running' : ''}`}
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
        '--tab-color': tabColor,
      } as React.CSSProperties}
    >
      {/* Terminal content — toolbar is now rendered by MosaicWindow's renderToolbar */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {children}
      </div>

      {/* Metadata bar */}
      <MetadataRow tab={tab} isOdd={false} />

      {/* Disconnected overlay */}
      {isDisconnected && <DisconnectedOverlay onRestart={onRestart} />}
    </div>
  );
}
