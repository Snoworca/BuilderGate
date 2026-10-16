import { useEffect, useMemo, useRef } from 'react';
import { TerminalContainer } from './TerminalContainer';
import type { TerminalHandle } from './TerminalView';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { ensureTerminalRef, pruneTerminalRefsMap } from './terminalRuntimeRefs';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { useLongPress } from '../../hooks/useLongPress';
import type { TerminalShortcutState } from '../../types';
import { suppressTerminalSecondaryButtonEvent } from '../../utils/terminalPointerPolicy';
import { createTouchTapTracker, shouldFocusTerminalOnPointerDown } from '../../utils/terminalTouchTapPolicy';

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
  terminalShortcutState: TerminalShortcutState | null;
}

interface TerminalRuntimeEntryProps {
  tab: WorkspaceTabRuntime;
  host?: ReturnType<typeof useTerminalRuntimeContext>['hosts'] extends Map<string, infer TValue> ? TValue : never;
  terminalRefsMap: React.MutableRefObject<Map<string, { current: TerminalHandle | null }>>;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
  terminalShortcutState: TerminalShortcutState | null;
}

function TerminalRuntimeEntry({
  tab,
  host,
  terminalRefsMap,
  onStatusChange,
  onCwdChange,
  onAuthError,
  terminalShortcutState,
}: TerminalRuntimeEntryProps) {
  const { getHostInteractions, outputPolicySelectionCoordinator } = useTerminalRuntimeContext();
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

  // FR-ARCH-010: a touch focuses the terminal (and so opens the iOS keyboard)
  // only when it ends as a short tap, never when it begins.
  const touchTapRef = useRef(createTouchTapTracker());
  const lastPointerWasTouchRef = useRef(false);

  const longPress = useLongPress(
    ({ clientX, clientY }) => {
      touchTapRef.current.longPress();
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
      data-session-id={tab.sessionId}
      data-tab-id={tab.id}
      style={style}
      onPointerDownCapture={(event) => {
        if (suppressTerminalSecondaryButtonEvent(event)) {
          return;
        }

        if (event.button === 1 && isGridSurface) {
          event.preventDefault();
          event.stopPropagation();
          terminalRefsMap.current.get(tab.id)?.current?.requestGridRepair?.('manual');
          return;
        }

        lastPointerWasTouchRef.current = !shouldFocusTerminalOnPointerDown(event.pointerType);
        if (lastPointerWasTouchRef.current) {
          // Wait for the click: only a tap may focus.
          return;
        }

        if (isGridSurface) {
          for (const terminalRef of terminalRefsMap.current.values()) {
            terminalRef.current?.invalidateClipboardContext();
          }
        }

        getHostInteractions(tab.id)?.onPointerDown?.();
        focusTerminal(event.currentTarget);
      }}
      onMouseDownCapture={(event) => {
        if (suppressTerminalSecondaryButtonEvent(event)) {
          return;
        }
        // A compatibility mousedown after a touch that was not a tap must not
        // reach xterm, which focuses its input on mousedown.
        if (lastPointerWasTouchRef.current && !touchTapRef.current.isTap()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (lastPointerWasTouchRef.current) {
          if (!touchTapRef.current.consumeTap()) {
            event.stopPropagation();
            return;
          }
          if (isGridSurface) {
            for (const terminalRef of terminalRefsMap.current.values()) {
              terminalRef.current?.invalidateClipboardContext();
            }
          }
        }
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
      onTouchStart={(event) => {
        touchTapRef.current.touchStart(event.touches);
        longPress.onTouchStart(event);
      }}
      onTouchMove={(event) => {
        touchTapRef.current.touchMove(event.touches);
        longPress.onTouchMove(event);
      }}
      onTouchEnd={longPress.onTouchEnd}
    >
      <TerminalContainer
        ref={ensureTerminalRef(terminalRefsMap.current, tab.id)}
        sessionId={tab.sessionId}
        workspaceId={tab.workspaceId}
        terminalShortcutState={terminalShortcutState}
        isVisible={isVisible}
        isGridSurface={isGridSurface}
        clipboardContextKey={host?.clipboardContextKey}
        outputPolicySelectionCoordinator={outputPolicySelectionCoordinator}
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
  terminalShortcutState,
}: TerminalRuntimeLayerProps) {
  const { rootRef, hosts } = useTerminalRuntimeContext();

  const activeRuntimes = useMemo(
    () => tabs.filter((tab) => tab.status !== 'disconnected'),
    [tabs],
  );
  const activeRuntimeIds = useMemo(
    () => new Set(activeRuntimes.map((tab) => tab.id)),
    [activeRuntimes],
  );

  useEffect(() => {
    pruneTerminalRefsMap(terminalRefsMap.current, activeRuntimeIds);
  }, [activeRuntimeIds, terminalRefsMap]);

  return (
    <>
      <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      {activeRuntimes.map((tab) => {
        return (
          <TerminalRuntimeEntry
            key={`runtime-${tab.id}-${tab.sessionId}`}
            tab={tab}
            host={hosts.get(tab.id)}
            terminalRefsMap={terminalRefsMap}
            onStatusChange={onStatusChange}
            onCwdChange={onCwdChange}
            onAuthError={onAuthError}
            terminalShortcutState={terminalShortcutState}
          />
        );
      })}
    </>
  );
}
