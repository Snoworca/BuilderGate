import { useMemo } from 'react';
import { TerminalContainer } from './TerminalContainer';
import type { TerminalHandle } from './TerminalView';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { useLongPress } from '../../hooks/useLongPress';

const PARKED_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: -100000,
  top: 0,
  width: 1,
  height: 1,
  overflow: 'hidden',
  pointerEvents: 'none',
  opacity: 0,
};

interface TerminalRuntimeLayerProps {
  tabs: WorkspaceTabRuntime[];
  terminalRefsMap: React.MutableRefObject<Map<string, { current: TerminalHandle | null }>>;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

interface TerminalRuntimeEntryProps {
  tab: WorkspaceTabRuntime;
  host?: ReturnType<typeof useTerminalRuntimeContext>['hosts'] extends Map<string, infer TValue> ? TValue : never;
  terminalRefsMap: React.MutableRefObject<Map<string, { current: TerminalHandle | null }>>;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function TerminalRuntimeEntry({
  tab,
  host,
  terminalRefsMap,
  onStatusChange,
  onCwdChange,
  onAuthError,
}: TerminalRuntimeEntryProps) {
  const { getHostInteractions } = useTerminalRuntimeContext();
  const isVisible = Boolean(host?.isVisible && host.rect.width > 0 && host.rect.height > 0);
  const isGridSurface = Boolean(host?.className?.includes('grid-cell'));
  const style: React.CSSProperties = isVisible && host
    ? {
        position: 'absolute',
        left: host.rect.left,
        top: host.rect.top,
        width: host.rect.width,
        height: host.rect.height,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        pointerEvents: 'auto',
        ...(host.style ?? {}),
      }
    : PARKED_STYLE;

  const longPress = useLongPress(
    ({ clientX, clientY }) => {
      getHostInteractions(tab.id)?.onContextMenu?.(clientX, clientY);
    },
    500,
  );

  const focusTerminal = (fallbackRoot?: EventTarget | null) => {
    const handle = terminalRefsMap.current.get(tab.id)?.current;
    if (handle) {
      handle.focus('runtime-layer');
      return;
    }

    const fallbackTextarea =
      fallbackRoot instanceof Element
        ? fallbackRoot.querySelector('textarea.xterm-helper-textarea')
        : null;
    if (fallbackTextarea instanceof HTMLTextAreaElement) {
      fallbackTextarea.focus();
    }
  };

  return (
    <div
      className={host?.className}
      data-terminal-runtime-entry="true"
      style={style}
      onPointerDownCapture={(event) => {
        getHostInteractions(tab.id)?.onPointerDown?.();
        focusTerminal(event.currentTarget);
      }}
      onClickCapture={(event) => {
        getHostInteractions(tab.id)?.onPointerDown?.();
        focusTerminal(event.currentTarget);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        getHostInteractions(tab.id)?.onContextMenu?.(event.clientX, event.clientY);
      }}
      onContextMenuCapture={(event) => {
        event.preventDefault();
        getHostInteractions(tab.id)?.onContextMenu?.(event.clientX, event.clientY);
      }}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
    >
      <TerminalContainer
        ref={terminalRefsMap.current.get(tab.id)!}
        sessionId={tab.sessionId}
        isVisible={isVisible}
        isGridSurface={isGridSurface}
        onStatusChange={onStatusChange}
        onCwdChange={onCwdChange}
        onAuthError={onAuthError}
      />
    </div>
  );
}

export function TerminalRuntimeLayer({
  tabs,
  terminalRefsMap,
  onStatusChange,
  onCwdChange,
  onAuthError,
}: TerminalRuntimeLayerProps) {
  const { rootRef, hosts } = useTerminalRuntimeContext();

  const activeRuntimes = useMemo(
    () => tabs.filter((tab) => tab.status !== 'disconnected'),
    [tabs],
  );

  return (
    <>
      <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      {activeRuntimes.map((tab) => {
        if (!terminalRefsMap.current.has(tab.id)) {
          terminalRefsMap.current.set(tab.id, { current: null });
        }

        return (
          <TerminalRuntimeEntry
            key={`runtime-${tab.id}-${tab.sessionId}`}
            tab={tab}
            host={hosts.get(tab.id)}
            terminalRefsMap={terminalRefsMap}
            onStatusChange={onStatusChange}
            onCwdChange={onCwdChange}
            onAuthError={onAuthError}
          />
        );
      })}
    </>
  );
}
