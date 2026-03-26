/**
 * Heartbeat Hook
 * Phase 7: Frontend Security
 *
 * Periodic token refresh to maintain session
 */

import { useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface HeartbeatConfig {
  intervalMs: number;
  onSessionExpired?: () => void;
}

const DEFAULT_INTERVAL = 15 * 60 * 1000; // 15 minutes (sessionDuration / 2)
const MAX_RETRY_COUNT = 2;

export function useHeartbeat(config?: Partial<HeartbeatConfig>) {
  const { isAuthenticated, refreshToken, logout } = useAuth();
  const timerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);

  const intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL;

  const configRef = useRef(config);
  configRef.current = config;

  const sendHeartbeat = useCallback(async () => {
    const success = await refreshToken();

    if (success) {
      retryCountRef.current = 0;
      console.log('[Heartbeat] Token refreshed');
    } else {
      retryCountRef.current++;
      console.warn(`[Heartbeat] Failed (attempt ${retryCountRef.current})`);

      if (retryCountRef.current >= MAX_RETRY_COUNT) {
        console.error('[Heartbeat] Max retries reached, session expired');
        configRef.current?.onSessionExpired?.();
        logout();
      }
    }
  }, [refreshToken, logout]);

  const start = useCallback(() => {
    if (timerRef.current) return;
    console.log(`[Heartbeat] Starting (interval: ${intervalMs}ms)`);
    timerRef.current = window.setInterval(sendHeartbeat, intervalMs);
  }, [sendHeartbeat, intervalMs]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      console.log('[Heartbeat] Stopping');
      clearInterval(timerRef.current);
      timerRef.current = null;
      retryCountRef.current = 0;
    }
  }, []);

  // Auto start/stop based on auth state
  useEffect(() => {
    if (isAuthenticated) {
      start();
    } else {
      stop();
    }
    return () => stop();
  }, [isAuthenticated, start, stop]);

  return { start, stop };
}
