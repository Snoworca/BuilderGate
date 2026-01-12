// Session Types (Step 1)
export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: Date;
  lastActiveAt: Date;
}

// Configuration Types (Phase 1)
export type {
  Config,
  ServerConfig,
  PTYConfig,
  SessionConfig,
  SSLConfig,
  SSLCredentials,
  CertExpiryInfo,
  SecurityConfig,
  CORSConfig,
  LoggingConfig,
  TwoFactorConfig,
  SMTPConfig,
  SMTPAuthConfig,
  SMTPTLSConfig,
  AuthConfig,
  BruteForceConfig,
  RateLimitConfig,
  LockoutConfig
} from './config.types.js';

// Authentication Types (Phase 2 & 3)
export type {
  JWTPayload,
  TokenBlacklistEntry,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  AuthenticatedRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  // Phase 3: Two-Factor Authentication
  OTPData,
  PendingAuth,
  VerifyRequest,
  VerifyResponse,
  OTPVerifyResult
} from './auth.types.js';

export type SessionStatus = 'running' | 'idle';

export interface SessionDTO {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export interface CreateSessionRequest {
  name?: string;
}

export interface InputRequest {
  data: string;
}

export interface ResizeRequest {
  cols: number;
  rows: number;
}

export interface OutputEvent {
  data: string;
}

export interface StatusEvent {
  status: SessionStatus;
}

export interface ErrorEvent {
  message: string;
}
