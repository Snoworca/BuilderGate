import { useRef, useCallback } from 'react';
import { useSession } from './hooks/useSession';
import { useSSE } from './hooks/useSSE';
import { sessionApi } from './services/api';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TerminalView } from './components/Terminal';
import type { TerminalHandle } from './components/Terminal';
import { StatusBar } from './components/StatusBar';
import './styles/globals.css';

function App() {
  const terminalRef = useRef<TerminalHandle>(null);
  const {
    sessions,
    activeSessionId,
    activeSession,
    setActiveSessionId,
    createSession,
    deleteSession,
    updateSessionStatus,
  } = useSession();

  // SSE connection for active session
  useSSE(activeSessionId, {
    onOutput: (data) => {
      terminalRef.current?.write(data);
    },
    onStatus: (status) => {
      if (activeSessionId) {
        updateSessionStatus(activeSessionId, status);
      }
    },
    onError: (message) => {
      console.error('Session error:', message);
    },
  });

  // Fire-and-forget input for low latency
  const handleInput = useCallback((data: string) => {
    if (activeSessionId) {
      sessionApi.sendInput(activeSessionId, data);
    }
  }, [activeSessionId]);

  const handleResize = useCallback(async (cols: number, rows: number) => {
    if (activeSessionId) {
      try {
        await sessionApi.resize(activeSessionId, cols, rows);
      } catch (e) {
        console.error('Failed to resize:', e);
      }
    }
  }, [activeSessionId]);

  const handleCreateSession = useCallback(async () => {
    await createSession();
  }, [createSession]);

  return (
    <div className="app">
      <Header />
      <div className="main">
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={setActiveSessionId}
          onCreate={handleCreateSession}
          onDelete={deleteSession}
        />
        <main className="content">
          {activeSessionId ? (
            <TerminalView
              ref={terminalRef}
              sessionId={activeSessionId}
              onInput={handleInput}
              onResize={handleResize}
            />
          ) : (
            <div className="no-session">
              <div className="no-session-icon">&#x1F4BB;</div>
              <p className="no-session-text">Select or create a session to start</p>
            </div>
          )}
        </main>
      </div>
      <StatusBar
        connected={!!activeSessionId}
        sessionName={activeSession?.name}
      />
    </div>
  );
}

export default App;
