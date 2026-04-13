import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { TerminalView } from './TerminalView';
import type { TerminalHandle } from './TerminalView';
import type { WorkspaceTabRuntime } from '../../types/workspace';

interface Props {
  sessionId: string;
  isVisible: boolean;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange?: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function propsAreEqual(prev: Props, next: Props): boolean {
  return prev.sessionId === next.sessionId && prev.isVisible === next.isVisible;
}

export const TerminalContainer = memo(
  forwardRef<TerminalHandle, Props>(function TerminalContainer(
    { sessionId, isVisible, onStatusChange, onCwdChange },
    ref
  ) {
    const terminalRef = useRef<TerminalHandle>(null);
    const initialRestorePendingRef = useRef(true);
    const historySeenRef = useRef(false);

    useImperativeHandle(ref, () => ({
      write: (data) => terminalRef.current?.write(data),
      clear: () => terminalRef.current?.clear(),
      focus: () => terminalRef.current?.focus(),
      hasSelection: () => terminalRef.current?.hasSelection() ?? false,
      getSelection: () => terminalRef.current?.getSelection() ?? '',
      clearSelection: () => terminalRef.current?.clearSelection(),
      fit: () => terminalRef.current?.fit(),
      sendInput: (data) => terminalRef.current?.sendInput(data),
      restoreSnapshot: () => terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false),
      replaceWithHistory: (data) => terminalRef.current?.replaceWithHistory(data) ?? Promise.resolve(),
      releasePending: () => terminalRef.current?.releasePending(),
    }), []);

    const { send, subscribeSession } = useWebSocketActions();

    useEffect(() => {
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
    }, [sessionId]);

    const handleStatus = useEffectEvent((status: string) => {
      onStatusChange(sessionId, status as WorkspaceTabRuntime['status']);
    });

    const handleCwd = useEffectEvent((cwd: string) => {
      onCwdChange?.(sessionId, cwd);
    });

    const handleError = useEffectEvent((message: string) => {
      console.error('Session error:', message);
      onStatusChange(sessionId, 'disconnected');
    });

    const handleHistory = useEffectEvent(async (data: string) => {
      historySeenRef.current = true;
      await terminalRef.current?.replaceWithHistory(data);
      send({ type: 'history:ready', sessionId });
      initialRestorePendingRef.current = false;
    });

    const handleSubscribed = useEffectEvent(async () => {
      if (!initialRestorePendingRef.current) {
        return;
      }
      if (historySeenRef.current) {
        return;
      }

      const restored = await terminalRef.current?.restoreSnapshot();
      if (!restored) {
        terminalRef.current?.releasePending();
      }
      initialRestorePendingRef.current = false;
    });

    useEffect(() => {
      const unsubscribe = subscribeSession(sessionId, {
        onHistory: (data) => {
          void handleHistory(data);
        },
        onSubscribed: () => {
          void handleSubscribed();
        },
        onOutput: (data) => {
          terminalRef.current?.write(data);
        },
        onStatus: handleStatus,
        onError: handleError,
        onCwd: handleCwd,
      });
      return unsubscribe;
    }, [sessionId, subscribeSession]);

    const prevVisibleRef = useRef(isVisible);
    useEffect(() => {
      if (isVisible && !prevVisibleRef.current) {
        requestAnimationFrame(() => {
          terminalRef.current?.fit();
        });
      }
      prevVisibleRef.current = isVisible;
    }, [isVisible]);

    const handleInput = useCallback((data: string) => {
      send({ type: 'input', sessionId, data });
    }, [sessionId, send]);

    const handleResize = useCallback((cols: number, rows: number) => {
      send({ type: 'resize', sessionId, cols, rows });
    }, [sessionId, send]);

    return (
      <div style={{ display: isVisible ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0 }}>
        <TerminalView
          ref={terminalRef}
          sessionId={sessionId}
          onInput={handleInput}
          onResize={handleResize}
        />
      </div>
    );
  }),
  propsAreEqual,
);
