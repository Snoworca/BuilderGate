import { useState, useEffect, useCallback } from 'react';
import { sessionApi } from '../services/api';
import type { Session, SessionStatus, ShellType } from '../types';

export function useSession() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionIdRaw] = useState<string | null>(() => {
    return localStorage.getItem('active_session_id');
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdRaw(id);
    if (id) localStorage.setItem('active_session_id', id);
    else localStorage.removeItem('active_session_id');
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      const data = await sessionApi.getAll();
      setSessions(data);
      setError(null);
    } catch (e) {
      setError('Failed to fetch sessions');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const createSession = useCallback(async (name?: string, shell?: ShellType, cwd?: string, setActive: boolean = true) => {
    try {
      const session = await sessionApi.create(name, shell, cwd);
      setSessions(prev => [...prev, session]);
      if (setActive) {
        setActiveSessionId(session.id);
      }
      return session;
    } catch (e) {
      setError('Failed to create session');
      console.error(e);
      return null;
    }
  }, [setActiveSessionId]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await sessionApi.delete(id);
      setSessions(prev => prev.filter(s => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
      }
    } catch (e) {
      setError('Failed to delete session');
      console.error(e);
    }
  }, [activeSessionId, setActiveSessionId]);

  const updateSessionStatus = useCallback((id: string, status: SessionStatus) => {
    setSessions(prev => prev.map(s =>
      s.id === id ? { ...s, status } : s
    ));
  }, []);

  const renameSession = useCallback(async (id: string, newName: string) => {
    const updated = await sessionApi.patchSession(id, { name: newName });
    setSessions(prev => prev.map(s => s.id === id ? updated : s));
  }, []);

  const reorderSession = useCallback(async (id: string, direction: 'up' | 'down') => {
    await sessionApi.reorderSession(id, direction);
    await fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Validate restored activeSessionId exists in fetched sessions
  useEffect(() => {
    if (activeSessionId && !loading && sessions.length > 0 && !sessions.find(s => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  }, [sessions, activeSessionId, loading, setActiveSessionId]);

  const sortedSessions = [...sessions].sort((a, b) => a.sortOrder - b.sortOrder);
  const activeSession = sessions.find(s => s.id === activeSessionId);

  return {
    sessions: sortedSessions,
    activeSessionId,
    activeSession,
    loading,
    error,
    setActiveSessionId,
    createSession,
    deleteSession,
    updateSessionStatus,
    renameSession,
    reorderSession,
    refreshSessions: fetchSessions,
  };
}
