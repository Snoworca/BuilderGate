import { memo, useRef, useCallback, useEffect } from 'react';
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

export const TerminalContainer = memo(function TerminalContainer({ sessionId, isVisible, onStatusChange, onCwdChange, onAuthError }: Props) {
  const terminalRef = useRef<TerminalHandle>(null);
  const ws = useWebSocket();

  // Subscribe to session via WebSocket
  useEffect(() => {
    const unsubscribe = ws.subscribeSession(sessionId, {
      onOutput: (data) => {
        terminalRef.current?.write(data);
      },
      onStatus: (status) => {
        onStatusChange(sessionId, status as SessionStatus);
      },
      onError: (message) => {
        console.error('Session error:', message);
        onStatusChange(sessionId, 'disconnected');
      },
      onCwd: (cwd) => {
        onCwdChange?.(sessionId, cwd);
      },
    });
    return unsubscribe;
  }, [sessionId, ws, onStatusChange, onCwdChange]);

  const handleInput = useCallback((data: string) => {
    ws.send({ type: 'input', sessionId, data });
  }, [sessionId, ws]);

  const handleResize = useCallback((cols: number, rows: number) => {
    ws.send({ type: 'resize', sessionId, cols, rows });
  }, [sessionId, ws]);

  return (
    <div style={{ display: isVisible ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
      <TerminalView
        ref={terminalRef}
        sessionId={sessionId}
        onInput={handleInput}
        onResize={handleResize}
      />
    </div>
  );
});
