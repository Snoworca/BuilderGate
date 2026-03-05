/**
 * useCwd Hook
 * Manages CWD (Current Working Directory) state for all sessions.
 * - Fetches CWD once for newly appeared sessions
 * - Polls active session's CWD every 5 seconds
 * - Cleans up removed session entries
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fileApi } from '../services/api';
import type { Session } from '../types';

interface UseCwdResult {
  cwdMap: Record<string, string>;
  activeCwd: string | null;
}

export function useCwd(sessions: Session[], activeSessionId: string | null): UseCwdResult {
  const [cwdMap, setCwdMap] = useState<Record<string, string>>({});
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCwd = useCallback(async (sessionId: string) => {
    try {
      const { cwd } = await fileApi.getCwd(sessionId);
      setCwdMap(prev => {
        if (prev[sessionId] === cwd) return prev;
        return { ...prev, [sessionId]: cwd };
      });
    } catch {
      // Session may have been deleted or CWD unavailable — ignore
    }
  }, []);

  // Fetch CWD once for new sessions
  useEffect(() => {
    const sessionIds = new Set(sessions.map(s => s.id));

    // Fetch CWD for sessions not yet in the map
    for (const id of sessionIds) {
      if (!(id in cwdMap)) {
        fetchCwd(id);
      }
    }

    // Clean up removed sessions
    setCwdMap(prev => {
      const keys = Object.keys(prev);
      const toRemove = keys.filter(k => !sessionIds.has(k));
      if (toRemove.length === 0) return prev;
      const next = { ...prev };
      for (const k of toRemove) delete next[k];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, fetchCwd]);

  // Poll active session's CWD every 5 seconds
  useEffect(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    if (!activeSessionId) return;

    // Fetch immediately on active change
    fetchCwd(activeSessionId);

    pollingRef.current = setInterval(() => {
      fetchCwd(activeSessionId);
    }, 5000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [activeSessionId, fetchCwd]);

  const activeCwd = activeSessionId ? (cwdMap[activeSessionId] ?? null) : null;

  return { cwdMap, activeCwd };
}
