import { memo, useRef, useCallback, useEffect } from 'react';
import { useSSE } from '../../hooks/useSSE';
import { TerminalView } from './TerminalView';
import type { TerminalHandle } from './TerminalView';
import { sessionApi, fileApi } from '../../services/api';
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

  useSSE(sessionId, {
    onOutput: (data) => {
      terminalRef.current?.write(data);
    },
    onStatus: (status) => {
      onStatusChange(sessionId, status);
    },
    onError: (message) => {
      console.error('Session error:', message);
    },
    onAuthError,
  });

  // Poll CWD every 3 seconds
  useEffect(() => {
    if (!onCwdChange) return;
    let mounted = true;
    const poll = async () => {
      try {
        const { cwd } = await fileApi.getCwd(sessionId);
        if (mounted && cwd) onCwdChange(sessionId, cwd);
      } catch { /* ignore */ }
    };
    poll(); // initial fetch
    const timer = setInterval(poll, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, [sessionId, onCwdChange]);

  const handleInput = useCallback((data: string) => {
    sessionApi.sendInput(sessionId, data);
  }, [sessionId]);

  const handleResize = useCallback(async (cols: number, rows: number) => {
    try {
      await sessionApi.resize(sessionId, cols, rows);
    } catch (e) {
      console.error('Failed to resize:', e);
    }
  }, [sessionId]);

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
