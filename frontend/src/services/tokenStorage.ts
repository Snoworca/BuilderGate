/**
 * Token Storage Service
 * Phase 7: Frontend Security
 *
 * Manages JWT token storage in localStorage
 */

import {
  evictTerminalSnapshotsForAuthToken,
  isQuotaExceededError,
} from '../utils/terminalSnapshot';

const TOKEN_KEY = 'cws_auth_token';
const EXPIRES_KEY = 'cws_auth_expires';

function writeTokenValues(token: string, expiresAt: number): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRES_KEY, String(expiresAt));
}

export const tokenStorage = {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken(token: string, expiresIn: number): void {
    const expiresAt = Date.now() + expiresIn;
    try {
      writeTokenValues(token, expiresAt);
    } catch (error) {
      this.clearToken();
      if (!isQuotaExceededError(error)) {
        throw error;
      }

      const eviction = evictTerminalSnapshotsForAuthToken();
      console.warn('[tokenStorage] auth token storage quota reached; evicted terminal snapshot cache before retry', {
        removedCount: eviction.removedCount,
        beforeChars: eviction.beforeChars,
        afterChars: eviction.afterChars,
      });

      try {
        writeTokenValues(token, expiresAt);
      } catch (retryError) {
        this.clearToken();
        throw retryError;
      }
    }
  },

  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
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
