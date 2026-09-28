/**
 * Token Storage Service
 * Phase 7: Frontend Security
 *
 * Manages JWT token storage in localStorage
 */

import {
  evictTerminalSnapshotsForAuthTokenWithLimits,
  isQuotaExceededError,
} from '../utils/terminalSnapshot.ts';
import { getSnapshotResourceLimits } from '../utils/inputReliabilityMode.ts';

const TOKEN_KEY = 'cws_auth_token';
const EXPIRES_KEY = 'cws_auth_expires';
// REL-BGSTAB-037: the lifetime the server gave the token, so the refresh policy knows its age.
const DURATION_KEY = 'cws_auth_duration';

function writeTokenValues(token: string, expiresAt: number, durationMs: number): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRES_KEY, String(expiresAt));
  localStorage.setItem(DURATION_KEY, String(durationMs));
}

export const tokenStorage = {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken(token: string, expiresIn: number): void {
    const expiresAt = Date.now() + expiresIn;
    try {
      writeTokenValues(token, expiresAt, expiresIn);
    } catch (error) {
      this.clearToken();
      if (!isQuotaExceededError(error)) {
        throw error;
      }

      const snapshotLimits = getSnapshotResourceLimits();
      const eviction = evictTerminalSnapshotsForAuthTokenWithLimits({
        maxTotalChars: snapshotLimits.totalStorageBudgetChars,
        maxEntries: snapshotLimits.maxEntries,
      });
      console.warn('[tokenStorage] auth token storage quota reached; evicted terminal snapshot cache before retry', {
        removedCount: eviction.removedCount,
        beforeChars: eviction.beforeChars,
        afterChars: eviction.afterChars,
      });

      try {
        writeTokenValues(token, expiresAt, expiresIn);
      } catch (retryError) {
        this.clearToken();
        throw retryError;
      }
    }
  },

  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
    localStorage.removeItem(DURATION_KEY);
  },

  getDurationMs(): number | null {
    const duration = Number.parseInt(localStorage.getItem(DURATION_KEY) ?? '', 10);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  },

  isExpired(): boolean {
    const expires = localStorage.getItem(EXPIRES_KEY);
    if (!expires) return true;
    return Date.now() > parseInt(expires, 10);
  },

  getExpiresAt(): number | null {
    const expires = localStorage.getItem(EXPIRES_KEY);
    return expires ? parseInt(expires, 10) : null;
  },

  getTimeRemaining(): number {
    const expiresAt = this.getExpiresAt();
    if (!expiresAt) return 0;
    return Math.max(0, expiresAt - Date.now());
  }
};
