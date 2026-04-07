import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { TerminalView } from './TerminalView';
import type { TerminalHandle } from './TerminalView';
import type { SessionStatus } from '../../types';

interface Props {
  sessionId: string;
  isVisible: boolean;
  onStatusChange: (sessionId: string, status: SessionStatus) => void;
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
    { sessionId, isVisible, onStatusChange, onCwdChange, onAuthError },
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
  }), []);
  const ws = useWebSocket();

  // Keep latest callbacks in refs to avoid useEffect re-subscription on callback change
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  // Subscribe to session via WebSocket — depends only on sessionId and ws
  useEffect(() => {
    const unsubscribe = ws.subscribeSession(sessionId, {
      onOutput: (data) => {
        terminalRef.current?.write(data);
      },
      onStatus: (status) => {
        onStatusChangeRef.current(sessionId, status as SessionStatus);
      },
      onError: (message) => {
        console.error('Session error:', message);
        onStatusChangeRef.current(sessionId, 'disconnected');
      },
      onCwd: (cwd) => {
        onCwdChangeRef.current?.(sessionId, cwd);
      },
    });
    return unsubscribe;
  }, [sessionId, ws]);

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
    ws.send({ type: 'input', sessionId, data });
  }, [sessionId, ws]);

  const handleResize = useCallback((cols: number, rows: number) => {
    ws.send({ type: 'resize', sessionId, cols, rows });
  }, [sessionId, ws]);

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
