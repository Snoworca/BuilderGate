import { useCallback } from 'react';
import { MosaicToolbar } from './MosaicToolbar';
import { EmptyCell } from './EmptyCell';
import { DisconnectedOverlay } from '../Workspace/DisconnectedOverlay';
import { MetadataRow } from '../MetadataBar/MetadataRow';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import type { LayoutMode } from '../../hooks/useMosaicLayout';

interface MosaicTileProps {
  tabId: string;
  tab: WorkspaceTabRuntime | undefined;
  layoutMode: LayoutMode;
  onContextMenu: (x: number, y: number, tabId: string) => void;
  onLayoutModeChange: (mode: LayoutMode) => void;
  onRestart: () => void;
  onAdd: () => void;
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
  children,
}: MosaicTileProps) {
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(e.clientX, e.clientY, tabId);
    },
    [tabId, onContextMenu],
  );

  if (!tab) {
    return <EmptyCell onAdd={onAdd} />;
  }

  const isDisconnected = tab.status === 'disconnected';

  return (
    <div
      onContextMenu={handleContextMenu}
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
      {/* Toolbar overlay */}
      <MosaicToolbar layoutMode={layoutMode} onLayoutModeChange={onLayoutModeChange} />

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
