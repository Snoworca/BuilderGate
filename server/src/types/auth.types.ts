/**
 * Authentication Types
 * Phase 2: Authentication Core
 * Phase 3: Two-Factor Authentication
 */

// ============================================================================
// JWT Types
// ============================================================================

export interface JWTPayload {
  /** Subject (user identifier) */
  sub: string;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** Expiration time (Unix timestamp) */
  exp: number;
  /** JWT ID (unique identifier for token) */
  jti: string;
}

export interface TokenBlacklistEntry {
  /** JWT ID */
  jti: string;
  /** Expiration timestamp for cleanup */
  expiresAt: number;
}

// ============================================================================
// Login Types
// ============================================================================

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  success: boolean;
  /** JWT token (only on success without 2FA) */
  token?: string;
  /** Token expiry in milliseconds */
  expiresIn?: number;
  /** Whether 2FA is required (Phase 3) */
  requires2FA?: boolean;
  /** Temporary token for 2FA flow (Phase 3) */
  tempToken?: string;
  /** Masked email for 2FA (Phase 3) */
  maskedEmail?: string;
  /** Error message */
  message?: string;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

// ============================================================================
// Auth Middleware Types
// ============================================================================

export interface AuthenticatedRequest {
  /** JWT payload attached by auth middleware */
  user?: JWTPayload;
}

// ============================================================================
// Heartbeat Types (Phase 4)
// ============================================================================

export interface HeartbeatRequest {
  /** Current token for refresh */
  token?: string;
}

export interface HeartbeatResponse {
  success: boolean;
  /** New token (if refreshed) */
  token?: string;
  expiresIn?: number;
}

// ============================================================================
// Two-Factor Authentication Types (Phase 3)
// ============================================================================

export interface OTPData {
  /** 6-digit OTP code */
  otp: string;
  /** Email address to receive OTP */
  email: string;
  /** Expiration timestamp (Unix ms) */
  expiresAt: number;
  /** Number of verification attempts */
  attempts: number;
}

export interface PendingAuth {
  /** Temporary token (UUID v4) */
  tempToken: string;
  /** Masked email for display (e.g., a***@example.com) */
  maskedEmail: string;
}

export interface VerifyRequest {
  /** Temporary token from login response */
  tempToken: string;
  /** OTP code from email */
  otpCode: string;
}

export interface VerifyResponse {
  success: boolean;
  /** JWT token (on success) */
  token?: string;
  /** Token expiry in milliseconds */
  expiresIn?: number;
  /** Error message */
  message?: string;
}

export interface OTPVerifyResult {
  success: boolean;
  /** Error code if failed */
  errorCode?: string;
  /** Remaining attempts (on failure) */
  attemptsRemaining?: number;
}
