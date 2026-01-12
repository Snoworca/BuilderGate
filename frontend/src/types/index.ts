// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export type SessionStatus = 'running' | 'idle';

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

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  requires2FA: boolean;
  tempToken: string | null;
  maskedEmail: string | null;
  expiresAt: number | null;
}
