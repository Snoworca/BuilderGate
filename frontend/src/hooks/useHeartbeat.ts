/**
 * Heartbeat Hook
 *
 * REL-BGSTAB-037: keeps the login alive. Instead of one fixed 15-minute timer (which a sleeping
 * laptop or a frozen tab simply missed, logging the user out), it checks every minute and
 * whenever the page comes back, and renews the token once it is old enough
 * (authRefreshPolicy). Every tab shares the token in localStorage, so a tab whose neighbour
 * already renewed it sees a fresh token and does nothing.
 */

import { useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { tokenStorage } from '../services/tokenStorage.ts';
import { AUTH_REFRESH_CHECK_INTERVAL_MS, shouldRefreshAuthToken } from '../utils/authRefreshPolicy.ts';

interface HeartbeatConfig {
  intervalMs: number;
  onSessionExpired?: () => void;
}

const MAX_RETRY_COUNT = 2;

export function useHeartbeat(config?: Partial<HeartbeatConfig>) {
  const { isAuthenticated, refreshToken, logout } = useAuth();
  const timerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const inFlightRef = useRef(false);

  const intervalMs = config?.intervalMs ?? AUTH_REFRESH_CHECK_INTERVAL_MS;

  const configRef = useRef(config);
  configRef.current = config;

  const check = useCallback(async () => {
    if (inFlightRef.current) return;
    const now = Date.now();
    const expiresAt = tokenStorage.getExpiresAt();
    if (expiresAt !== null && expiresAt <= now) {
      // Expired while asleep: the server will not renew it.
      configRef.current?.onSessionExpired?.();
      void logout();
      return;
    }
    if (!shouldRefreshAuthToken({ now, expiresAt, durationMs: tokenStorage.getDurationMs() })) return;
    inFlightRef.current = true;
    try {
      const success = await refreshToken();
      if (success) {
        retryCountRef.current = 0;
        return;
      }
      retryCountRef.current++;
      console.warn(`[Heartbeat] Refresh failed (attempt ${retryCountRef.current})`);
      // A failed renewal is only fatal when the token is actually gone; a network blip while the
      // token is still valid is retried on the next check.
      const remaining = tokenStorage.getTimeRemaining();
      if (retryCountRef.current >= MAX_RETRY_COUNT && remaining <= 0) {
        configRef.current?.onSessionExpired?.();
        void logout();
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [refreshToken, logout]);

  const start = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = window.setInterval(() => void check(), intervalMs);
    void check();
  }, [check, intervalMs]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      retryCountRef.current = 0;
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      stop();
      return undefined;
    }
    start();
    const onResume = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('online', onResume);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('online', onResume);
    };
  }, [isAuthenticated, start, stop, check]);

  return { start, stop };
}
