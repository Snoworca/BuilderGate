/**
 * Token Storage Service
 * Phase 7: Frontend Security
 *
 * Manages JWT token storage in localStorage
 */

const TOKEN_KEY = 'cws_auth_token';
const EXPIRES_KEY = 'cws_auth_expires';

export const tokenStorage = {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken(token: string, expiresIn: number): void {
    const expiresAt = Date.now() + expiresIn;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EXPIRES_KEY, String(expiresAt));
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
