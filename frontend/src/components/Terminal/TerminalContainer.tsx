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

// Custom memo: only re-render when sessionId or isVisible changes.
// Callback prop changes (from parent useCallback recreation) are ignored
// since we access them via refs inside useEffect.
function propsAreEqual(prev: Props, next: Props): boolean {
  return prev.sessionId === next.sessionId && prev.isVisible === next.isVisible;
}

export const TerminalContainer = memo(
  forwardRef<TerminalHandle, Props>(function TerminalContainer(
    { sessionId, isVisible, onStatusChange, onCwdChange },
    ref
  ) {
  const terminalRef = useRef<TerminalHandle>(null);

  useImperativeHandle(ref, () => ({
    write:          (data) => terminalRef.current?.write(data),
    clear:          ()     => terminalRef.current?.clear(),
    focus:          ()     => terminalRef.current?.focus(),
    hasSelection:   ()     => terminalRef.current?.hasSelection() ?? false,
    getSelection:   ()     => terminalRef.current?.getSelection() ?? '',
    clearSelection: ()     => terminalRef.current?.clearSelection(),
    fit:            ()     => terminalRef.current?.fit(),
    sendInput:      (data) => terminalRef.current?.sendInput(data),
  }), []);
  const { send, subscribeSession } = useWebSocketActions();

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

  // Subscribe to session via WebSocket — depends only on sessionId and ws
  useEffect(() => {
    const unsubscribe = subscribeSession(sessionId, {
      onOutput: (data) => {
        terminalRef.current?.write(data);
      },
      onStatus: handleStatus,
      onError: handleError,
      onCwd: handleCwd,
    });
    return unsubscribe;
  }, [sessionId, subscribeSession]);

  // isVisible이 false→true로 변경될 때 fit을 명시적으로 호출
  // (display:none → flex 전환 시 ResizeObserver가 0-size 가드로 스킵했으므로)
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
  })
, propsAreEqual);
