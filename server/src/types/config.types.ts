/**
 * Configuration Types for BuilderGate Server
 * Phase 1: Security Infrastructure
 */

// ============================================================================
// SSL Configuration
// ============================================================================

export interface SSLConfig {
  /** Path to SSL certificate file (empty for auto-generation) */
  certPath: string;
  /** Path to SSL private key file (empty for auto-generation) */
  keyPath: string;
  /** Path to CA chain file (optional) */
  caPath: string;
}

export interface SSLCredentials {
  cert: string;
  key: string;
  ca?: string;
}

export interface CertExpiryInfo {
  expiresAt: Date;
  daysRemaining: number;
  isExpiringSoon: boolean;
}

// ============================================================================
// Security Configuration
// ============================================================================

export interface CORSConfig {
  /** Allowed origins (empty array = allow all in dev, block in prod) */
  allowedOrigins: string[];
  /** Allow credentials (cookies, authorization headers) */
  credentials: boolean;
  /** Preflight request cache duration in seconds */
  maxAge: number;
}

export interface SecurityConfig {
  cors: CORSConfig;
}

// ============================================================================
// Logging Configuration
// ============================================================================

export interface LoggingConfig {
  /** Log level: error, warn, info, debug */
  level: 'error' | 'warn' | 'info' | 'debug';
  /** Enable audit logging */
  audit: boolean;
  /** Log directory path */
  directory: string;
  /** Max log file size (e.g., "10m", "1g") */
  maxSize: string;
  /** Max number of log files to keep */
  maxFiles: number;
}

// ============================================================================
// Server Configuration
// ============================================================================

export interface ServerConfig {
  port: number;
}

// ============================================================================
// PTY Configuration
// ============================================================================

export interface PTYConfig {
  termName: string;
  defaultCols: number;
  defaultRows: number;
  useConpty: boolean;
  maxBufferSize: number;
  /** Shell type: 'auto' (OS default), 'powershell', 'wsl' (WSL bash), 'bash', 'zsh', 'sh', 'cmd' */
  shell: 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';
}

// ============================================================================
// Session Configuration
// ============================================================================

export interface SessionConfig {
  idleDelayMs: number;
}

// ============================================================================
// Two-Factor Authentication Configuration
// ============================================================================

export interface TOTPConfig {
  enabled: boolean;
  issuer?: string;
  accountName?: string;
}

export interface TwoFactorConfig {
  externalOnly: boolean;
  totp?: TOTPConfig;
}

// ============================================================================
// Authentication Configuration (Phase 2)
// ============================================================================

export interface AuthConfig {
  password: string;
  durationMs: number;
  maxDurationMs: number;
  jwtSecret: string;
  localhostPasswordOnly?: boolean;
}

// ============================================================================
// Rate Limiting Configuration (Phase 5)
// ============================================================================

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface LockoutConfig {
  maxAttempts: number;
  lockoutDurationMs: number;
  progressiveDelay: boolean;
}

export interface BruteForceConfig {
  rateLimit: RateLimitConfig;
  lockout: LockoutConfig;
}

// ============================================================================
// File Manager Configuration (Phase 4)
// ============================================================================

export interface FileManagerConfig {
  maxFileSize: number;
  maxCodeFileSize: number;
  maxDirectoryEntries: number;
  blockedExtensions: string[];
  blockedPaths: string[];
  cwdCacheTtlMs: number;
}

// ============================================================================
// Full Configuration Interface
// ============================================================================

export interface Config {
  server: ServerConfig;
  pty: PTYConfig;
  session: SessionConfig;
  ssl?: SSLConfig;
  security?: SecurityConfig;
  logging?: LoggingConfig;
  twoFactor?: TwoFactorConfig;
  auth?: AuthConfig;
  bruteForce?: BruteForceConfig;
  fileManager?: FileManagerConfig;
}
