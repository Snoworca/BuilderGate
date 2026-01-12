/**
 * API Service
 * Phase 7: Frontend Security - Auth API added
 */

import { tokenStorage } from './tokenStorage';
import type {
  Session,
  LoginResponse,
  VerifyRequest,
  VerifyResponse,
  RefreshResponse,
  ErrorResponse
} from '../types';

const API_BASE = '/api';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse error response from API
 */
async function parseError(res: Response): Promise<Error> {
  try {
    const data: ErrorResponse = await res.json();
    return new Error(data.error?.message || 'Request failed');
  } catch {
    return new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
}

/**
 * Get authorization headers with token
 */
function getAuthHeaders(): HeadersInit {
  const token = tokenStorage.getToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ============================================================================
// Auth API
// ============================================================================

export const authApi = {
  async login(password: string): Promise<LoginResponse> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  async verify(tempToken: string, otpCode: string): Promise<VerifyResponse> {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, otpCode } as VerifyRequest)
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  async refresh(): Promise<RefreshResponse> {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      }
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  async logout(): Promise<void> {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
  },

  async getStatus(): Promise<{ authenticated: boolean }> {
    const res = await fetch(`${API_BASE}/auth/status`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) return { authenticated: false };
    return res.json();
  }
};

// ============================================================================
// Session API (with auth headers)
// ============================================================================

export const sessionApi = {
  getAll: async (): Promise<Session[]> => {
    const res = await fetch(`${API_BASE}/sessions`, {
      keepalive: true,
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to fetch sessions');
    return res.json();
  },

  create: async (name?: string): Promise<Session> => {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
  },

  get: async (id: string): Promise<Session> => {
    const res = await fetch(`${API_BASE}/sessions/${id}`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to get session');
    return res.json();
  },

  delete: async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to delete session');
  },

  // Fire-and-forget for low latency input
  sendInput: (id: string, data: string): void => {
    fetch(`${API_BASE}/sessions/${id}/input`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ data }),
    }).catch(err => console.error('Input error:', err));
  },

  resize: async (id: string, cols: number, rows: number): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${id}/resize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ cols, rows }),
    });
    if (!res.ok) throw new Error('Failed to resize terminal');
  },

  getStreamUrl: (id: string): string => {
    return `${API_BASE}/sessions/${id}/stream`;
  },
};
