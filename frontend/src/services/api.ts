/**
 * API Service
 * Phase 7: Frontend Security - Auth API added
 */

import { tokenStorage } from './tokenStorage';
import type {
  Session,
  UpdateSessionRequest,
  LoginResponse,
  BootstrapPasswordResponse,
  BootstrapStatusResponse,
  VerifyRequest,
  VerifyResponse,
  RefreshResponse,
  TOTPQRInfo,
  ErrorResponse,
  DirectoryListing,
  FileContent,
  ShellInfo,
  ShellType,
  SettingsSnapshot,
  SettingsPatchRequest,
  SettingsSaveResponse,
  CommandPreset,
  CommandPresetListResponse,
  CreateCommandPresetRequest,
  UpdateCommandPresetRequest,
  CommandPresetKind
} from '../types';
import type {
  GridLayout,
  Workspace,
  WorkspaceState,
  WorkspaceTab,
} from '../types/workspace';

const API_BASE = '/api';

// WebSocket client ID for x-client-id header (set by WebSocketContext)
let _wsClientId: string | null = null;

export function setWsClientId(id: string | null): void {
  _wsClientId = id;
}

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
 * Get authorization headers with token (+ x-client-id for WS self-exclusion)
 */
function getAuthHeaders(): HeadersInit {
  const token = tokenStorage.getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (_wsClientId) headers['x-client-id'] = _wsClientId;
  return headers;
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
  async getBootstrapStatus(): Promise<BootstrapStatusResponse> {
    const res = await fetch(`${API_BASE}/auth/bootstrap-status`);
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  async bootstrapPassword(password: string, confirmPassword: string): Promise<BootstrapPasswordResponse> {
    const res = await fetch(`${API_BASE}/auth/bootstrap-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, confirmPassword }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  async login(password: string): Promise<LoginResponse> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  async verify(tempToken: string, otpCode: string, stage?: 'email' | 'totp'): Promise<VerifyResponse> {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, otpCode, ...(stage ? { stage } : {}) } as VerifyRequest)
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
  },

  async getTotpQr(): Promise<TOTPQRInfo | null> {
    const res = await authFetch(`${API_BASE}/auth/totp-qr`, {
      headers: getAuthHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await parseError(res);
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

  // NOTE: sendInput and resize removed — now handled via WebSocket (Step 8)

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

// ============================================================================
// Workspace API (Step 7)
// ============================================================================

export const workspaceApi = {
  getAll: async (): Promise<WorkspaceState> => {
    const res = await authFetch(`${API_BASE}/workspaces`, { headers: getAuthHeaders() });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  create: async (name?: string): Promise<Workspace> => {
    const res = await authFetch(`${API_BASE}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  update: async (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'viewMode' | 'activeTabId'>>,
  ): Promise<Workspace> => {
    const res = await authFetch(`${API_BASE}/workspaces/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  delete: async (id: string): Promise<void> => {
    const res = await authFetch(`${API_BASE}/workspaces/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
  },

  reorderWorkspaces: async (workspaceIds: string[]): Promise<void> => {
    const res = await authFetch(`${API_BASE}/workspaces/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ workspaceIds }),
    });
    if (!res.ok) throw await parseError(res);
  },

  addTab: async (workspaceId: string, shell?: string, name?: string, cwd?: string): Promise<WorkspaceTab> => {
    const res = await authFetch(`${API_BASE}/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ shell, name, cwd }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  updateTab: async (
    workspaceId: string,
    tabId: string,
    updates: Partial<Pick<WorkspaceTab, 'name'>>,
  ): Promise<WorkspaceTab> => {
    const res = await authFetch(`${API_BASE}/workspaces/${workspaceId}/tabs/${tabId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  deleteTab: async (workspaceId: string, tabId: string): Promise<void> => {
    const res = await authFetch(`${API_BASE}/workspaces/${workspaceId}/tabs/${tabId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
  },

  reorderTabs: async (workspaceId: string, tabIds: string[]): Promise<void> => {
    const res = await authFetch(`${API_BASE}/workspaces/${workspaceId}/tab-order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ tabIds }),
    });
    if (!res.ok) throw await parseError(res);
  },

  updateGrid: async (workspaceId: string, layout: Record<string, unknown>): Promise<GridLayout> => {
    const res = await authFetch(`${API_BASE}/workspaces/${workspaceId}/grid`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(layout),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  restartTab: async (workspaceId: string, tabId: string): Promise<WorkspaceTab> => {
    const res = await authFetch(`${API_BASE}/workspaces/${workspaceId}/tabs/${tabId}/restart`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

};

export const settingsApi = {
  getSettings: async (): Promise<SettingsSnapshot> => {
    const res = await authFetch(`${API_BASE}/settings`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  patchSettings: async (patch: SettingsPatchRequest): Promise<SettingsSaveResponse> => {
    const res = await authFetch(`${API_BASE}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },
};

export const commandPresetApi = {
  getAll: async (): Promise<CommandPreset[]> => {
    const res = await authFetch(`${API_BASE}/command-presets`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    const data = await res.json() as CommandPresetListResponse;
    return data.presets;
  },

  create: async (input: CreateCommandPresetRequest): Promise<CommandPreset> => {
    const res = await authFetch(`${API_BASE}/command-presets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  update: async (id: string, input: UpdateCommandPresetRequest): Promise<CommandPreset> => {
    const res = await authFetch(`${API_BASE}/command-presets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  },

  delete: async (id: string): Promise<void> => {
    const res = await authFetch(`${API_BASE}/command-presets/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw await parseError(res);
  },

  reorder: async (kind: CommandPresetKind, presetIds: string[]): Promise<void> => {
    const res = await authFetch(`${API_BASE}/command-presets/order`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ kind, presetIds }),
    });
    if (!res.ok) throw await parseError(res);
  },
};
