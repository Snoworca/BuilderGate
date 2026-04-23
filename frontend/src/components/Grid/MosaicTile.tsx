import { useCallback, useRef } from 'react';
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
  /** Called when the user presses down on this tile (focus tracking) */
  onFocus?: () => void;
  /** Receives the tile root DOM element for external focus management */
  onRegisterRef?: (el: HTMLElement | null) => void;
  onRenameTab?: (tabId: string, name: string) => void;
  children: React.ReactNode;
}

export function MosaicTile({
  tabId,
  tab,
  onContextMenu,
  onRestart,
  onFocus,
  onRegisterRef,
  onRenameTab,
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
    // mosaicTree의 leaf ID가 tabMap에 아직 없는 과도기 상태.
    // EmptyCell(onAdd 호출)을 렌더하면 클릭 시 원치 않는 새 탭이 실제로 생성되므로
    // 클릭 불가능한 중립 placeholder를 렌더한다.
    // useMosaicLayout 혹은 MosaicContainer의 stale tabId 방어 useEffect가
    // 다음 틱에 mosaicTree를 올바르게 재빌드한다.
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--terminal-bg, #1e1e1e)',
          boxSizing: 'border-box',
        }}
      />
    );
  }

  const isDisconnected = tab.status === 'disconnected';
  const isRunning = tab.status === 'running';
  const tabColor = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];

  return (
    <div
      ref={setTileRef}
      data-grid-tab-id={tabId}
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
      <MetadataRow
        tab={tab}
        onRename={onRenameTab ? (name) => onRenameTab(tabId, name) : undefined}
      />

      {/* Disconnected overlay */}
      {isDisconnected && <DisconnectedOverlay onRestart={onRestart} />}
    </div>
  );
}
