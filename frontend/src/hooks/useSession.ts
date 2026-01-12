import { useState, useEffect, useCallback } from 'react';
import { sessionApi } from '../services/api';
import type { Session, SessionStatus } from '../types';

export function useSession() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const createSession = useCallback(async (name?: string) => {
    try {
      const session = await sessionApi.create(name);
      setSessions(prev => [...prev, session]);
      setActiveSessionId(session.id);
      return session;
    } catch (e) {
      setError('Failed to create session');
      console.error(e);
      return null;
    }
  }, []);

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
  }, [activeSessionId]);

  const updateSessionStatus = useCallback((id: string, status: SessionStatus) => {
    setSessions(prev => prev.map(s =>
      s.id === id ? { ...s, status } : s
    ));
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  return {
    sessions,
    activeSessionId,
    activeSession,
    loading,
    error,
    setActiveSessionId,
    createSession,
    deleteSession,
    updateSessionStatus,
    refreshSessions: fetchSessions,
  };
}
