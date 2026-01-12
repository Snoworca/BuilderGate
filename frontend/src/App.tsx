/**
 * Main Application
 * Phase 7: Frontend Security - Auth integration added
 */

import { useRef, useCallback } from 'react';
import { useAuth } from './contexts/AuthContext';
import { useSession } from './hooks/useSession';
import { useSSE } from './hooks/useSSE';
import { useHeartbeat } from './hooks/useHeartbeat';
import { sessionApi } from './services/api';
import { AuthGuard } from './components/Auth';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TerminalView } from './components/Terminal';
import type { TerminalHandle } from './components/Terminal';
import { StatusBar } from './components/StatusBar';
import './styles/globals.css';

function AppContent() {
  const terminalRef = useRef<TerminalHandle>(null);
  const { logout } = useAuth();
  const {
    sessions,
    activeSessionId,
    activeSession,
    setActiveSessionId,
    createSession,
    deleteSession,
    updateSessionStatus,
  } = useSession();

  // Heartbeat for token refresh
  useHeartbeat({
    onSessionExpired: () => {
      alert('Session expired. Please login again.');
    }
  });

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
    onAuthError: () => {
      logout();
    }
  });

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

  const handleLogout = useCallback(async () => {
    await logout();
  }, [logout]);

  return (
    <div className="app">
      <Header onLogout={handleLogout} />
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

function App() {
  return (
    <AuthGuard>
      <AppContent />
    </AuthGuard>
  );
}

export default App;
