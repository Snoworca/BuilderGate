// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  sortOrder: number;
}

export interface UpdateSessionRequest {
  name?: string;
  sortOrder?: number;
}

export type SessionStatus = 'running' | 'idle';

// Shell Types
export type ShellType = 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';

export interface ShellInfo {
  id: ShellType;
  label: string;
  icon: string;
}

// ============================================================================
// Auth Types (Phase 7)
// ============================================================================

export interface LoginResponse {
  success: boolean;
  token?: string;
  expiresIn?: number;
  requires2FA?: boolean;
  tempToken?: string;
  maskedEmail?: string;
  message?: string;
}

export interface VerifyRequest {
  tempToken: string;
  otpCode: string;
}

export interface VerifyResponse {
  success: boolean;
  token?: string;
  expiresIn?: number;
  message?: string;
}

export interface RefreshResponse {
  success: boolean;
  token: string;
  expiresIn: number;
}

// Note: Backend uses ErrorCode enum, but frontend uses string for flexibility
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
  };
}

// ============================================================================
// Tab & File Manager Types (Phase 4)
// ============================================================================

// ActiveTab removed — useTabManager manages dynamic tab IDs

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension?: string;
  modified: string;
}

export interface DirectoryListing {
  cwd: string;
  path: string;
  entries: DirectoryEntry[];
  totalEntries: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  encoding: string;
  extension: string;
  mimeType: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  requires2FA: boolean;
  tempToken: string | null;
  maskedEmail: string | null;
  expiresAt: number | null;
}

export type {
  EditableSettingsKey,
  FieldApplyScope,
  FieldCapability,
  EditableSettingsValues,
  SettingsSnapshot,
  SettingsPatchRequest,
  SettingsApplySummary,
  SettingsSaveResponse
} from './settings';
