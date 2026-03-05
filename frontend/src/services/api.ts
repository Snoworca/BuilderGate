/**
 * API Service
 * Phase 7: Frontend Security - Auth API added
 */

import { tokenStorage } from './tokenStorage';
import type {
  Session,
  UpdateSessionRequest,
  LoginResponse,
  VerifyRequest,
  VerifyResponse,
  RefreshResponse,
  ErrorResponse,
  DirectoryListing,
  FileContent,
  ShellInfo,
  ShellType
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

/**
 * Fetch wrapper that detects 401 responses and triggers re-authentication.
 * When the server rejects a token (e.g. after restart with new JWT secret),
 * this clears the stale token and notifies AuthContext via a custom event.
 */
async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    tokenStorage.clearToken();
    window.dispatchEvent(new Event('auth-expired'));
  }
  return res;
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
    const res = await authFetch(`${API_BASE}/sessions`, {
      keepalive: true,
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to fetch sessions');
    return res.json();
  },

  create: async (name?: string, shell?: ShellType, cwd?: string): Promise<Session> => {
    const res = await authFetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ name, shell, cwd }),
    });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
  },

  getShells: async (): Promise<ShellInfo[]> => {
    const res = await authFetch(`${API_BASE}/sessions/shells`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to fetch shells');
    return res.json();
  },

  get: async (id: string): Promise<Session> => {
    const res = await authFetch(`${API_BASE}/sessions/${id}`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to get session');
    return res.json();
  },

  delete: async (id: string): Promise<void> => {
    const res = await authFetch(`${API_BASE}/sessions/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to delete session');
  },

  // Fire-and-forget for low latency input
  sendInput: (id: string, data: string): void => {
    authFetch(`${API_BASE}/sessions/${id}/input`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ data }),
    }).catch(err => console.error('Input error:', err));
  },

  resize: async (id: string, cols: number, rows: number): Promise<void> => {
    const res = await authFetch(`${API_BASE}/sessions/${id}/resize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ cols, rows }),
    });
    if (!res.ok) throw new Error('Failed to resize terminal');
  },

  patchSession: async (id: string, updates: UpdateSessionRequest): Promise<Session> => {
    const res = await authFetch(`${API_BASE}/sessions/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  reorderSession: async (id: string, direction: 'up' | 'down'): Promise<void> => {
    const res = await authFetch(`${API_BASE}/sessions/${id}/reorder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ direction }),
    });
    if (!res.ok) throw await parseError(res);
  },

  getStreamUrl: (id: string): string => {
    return `${API_BASE}/sessions/${id}/stream`;
  },
};

// ============================================================================
// File API (Phase 4)
// ============================================================================

export const fileApi = {
  getCwd: async (sessionId: string): Promise<{ cwd: string }> => {
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/cwd`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  listDirectory: async (sessionId: string, path?: string): Promise<DirectoryListing> => {
    const params = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/files${params}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  readFile: async (sessionId: string, path: string): Promise<FileContent> => {
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/files/read?path=${encodeURIComponent(path)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  copyFile: async (sessionId: string, source: string, destination: string): Promise<{ success: boolean }> => {
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ source, destination }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  moveFile: async (sessionId: string, source: string, destination: string): Promise<{ success: boolean }> => {
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ source, destination }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  deleteFile: async (sessionId: string, path: string): Promise<{ success: boolean }> => {
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  createDirectory: async (sessionId: string, dirPath: string, name: string): Promise<{ success: boolean }> => {
    const res = await authFetch(`${API_BASE}/sessions/${sessionId}/files/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ path: dirPath, name }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },
};
