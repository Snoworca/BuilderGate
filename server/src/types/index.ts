// Shell Types
export type ShellType = 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';

export interface ShellInfo {
  id: ShellType;
  label: string;
  icon: string;
}

// Session Types (Step 1)
export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: Date;
  lastActiveAt: Date;
  sortOrder: number;
}

export interface UpdateSessionRequest {
  name?: string;
  sortOrder?: number;
}

// File Manager Types (Phase 4)
export type {
  FileManagerConfig as FileManagerConfigType,
  DirectoryEntry,
  DirectoryListing,
  FileContent,
  CopyRequest,
  MoveRequest,
  CwdResponse,
  MkdirRequest
} from './file.types.js';

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
  AuthConfig,
  BruteForceConfig,
  RateLimitConfig,
  LockoutConfig
} from './config.types.js';

export type {
  EditableSettingsKey,
  EditableSettingsSnapshot,
  EditableSettingsValues,
  FieldApplyScope,
  FieldCapability,
  AuthEditableSettings,
  PasswordChangeRequest,
  TwoFactorEditableSettings,
  SecurityEditableSettings,
  EditablePtySettings,
  EditableSessionSettings,
  EditableFileManagerSettings,
  SettingsPatchRequest,
  SecretFieldState,
  SettingsApplySummary,
  SettingsSaveResponse
} from './settings.types.js';

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
  sortOrder: number;
}

export interface CreateSessionRequest {
  name?: string;
  shell?: ShellType;
  cwd?: string;   // Sub-terminal: inherit parent CWD
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
