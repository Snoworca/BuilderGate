/**
 * Constants for Claude Web Shell Server
 * Phase 1: Security Infrastructure
 */

// ============================================================================
// SSL/TLS Constants
// ============================================================================

export const SSL_DEFAULTS = {
  /** Certificate validity period in days */
  CERT_VALIDITY_DAYS: 365,
  /** Certificate expiry warning threshold in days */
  CERT_EXPIRY_WARNING_DAYS: 30,
  /** RSA key size */
  RSA_KEY_SIZE: 2048,
  /** Default certificate directory */
  CERT_DIRECTORY: 'certs',
  /** Default certificate filename */
  CERT_FILENAME: 'self-signed.crt',
  /** Default key filename */
  KEY_FILENAME: 'self-signed.key'
} as const;

export const TLS_CONFIG = {
  /** Minimum TLS version */
  MIN_VERSION: 'TLSv1.2' as const,
  /** Maximum TLS version */
  MAX_VERSION: 'TLSv1.3' as const
} as const;

/**
 * Secure cipher suites for TLS connections
 * Ordered by preference (strongest first)
 */
export const CIPHER_SUITES = [
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'DHE-RSA-AES256-GCM-SHA384',
  'DHE-RSA-AES128-GCM-SHA256'
] as const;

// ============================================================================
// Security Header Constants
// ============================================================================

export const SECURITY_HEADERS = {
  /** HSTS max-age in seconds (1 year) */
  HSTS_MAX_AGE: 31536000,
  /** Referrer policy */
  REFERRER_POLICY: 'strict-origin-when-cross-origin' as const
} as const;

// ============================================================================
// Rate Limiting Constants (Phase 5)
// ============================================================================

export const RATE_LIMIT_DEFAULTS = {
  /** Default rate limit window in ms (1 minute) */
  WINDOW_MS: 60000,
  /** Default max requests per window */
  MAX_REQUESTS: 100,
  /** Default lockout duration in ms (15 minutes) */
  LOCKOUT_DURATION_MS: 900000,
  /** Default max login attempts before lockout */
  MAX_ATTEMPTS: 5,
  /** Progressive delay base in ms */
  PROGRESSIVE_DELAY_BASE_MS: 200,
  /** Progressive delay max in ms */
  PROGRESSIVE_DELAY_MAX_MS: 10000,
  /** Auto-blacklist threshold */
  AUTO_BLACKLIST_THRESHOLD: 10
} as const;

// ============================================================================
// Authentication Constants (Phase 2)
// ============================================================================

export const AUTH_DEFAULTS = {
  /** Default session duration in ms (30 minutes) */
  SESSION_DURATION_MS: 1800000,
  /** Maximum session duration in ms (24 hours) */
  MAX_SESSION_DURATION_MS: 86400000,
  /** JWT algorithm */
  JWT_ALGORITHM: 'HS256' as const,
  /** Token type */
  TOKEN_TYPE: 'Bearer' as const
} as const;

// ============================================================================
// Two-Factor Authentication Constants (Phase 3)
// ============================================================================

export const TWO_FACTOR_DEFAULTS = {
  /** Default OTP length */
  OTP_LENGTH: 6,
  /** Default OTP expiry in ms (5 minutes) */
  OTP_EXPIRY_MS: 300000,
  /** Max OTP verification attempts */
  MAX_OTP_ATTEMPTS: 3,
  /** SMTP retry delays in ms */
  SMTP_RETRY_DELAYS: [1000, 2000, 4000] as const
} as const;

// ============================================================================
// Logging Constants (Phase 6)
// ============================================================================

export const LOGGING_DEFAULTS = {
  /** Default log level */
  LOG_LEVEL: 'info' as const,
  /** Default log directory */
  LOG_DIRECTORY: 'logs',
  /** Default max log file size */
  MAX_LOG_SIZE: '10m',
  /** Default max log files */
  MAX_LOG_FILES: 14
} as const;

// ============================================================================
// Input Validation Constants (Phase 6)
// ============================================================================

export const VALIDATION_LIMITS = {
  /** Maximum input length for commands */
  MAX_COMMAND_LENGTH: 65536,
  /** Maximum session name length */
  MAX_SESSION_NAME_LENGTH: 100,
  /** Minimum terminal columns */
  MIN_COLS: 20,
  /** Maximum terminal columns */
  MAX_COLS: 500,
  /** Minimum terminal rows */
  MIN_ROWS: 5,
  /** Maximum terminal rows */
  MAX_ROWS: 200
} as const;

// ============================================================================
// Environment Variable Filter Patterns (Phase 6)
// ============================================================================

export const ENV_FILTER_PATTERNS = [
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GOOGLE_/i,
  /_SECRET$/i,
  /_KEY$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
  /_CREDENTIAL/i,
  /^API_KEY$/i,
  /^AUTH_/i,
  /^DB_/i,
  /^DATABASE_/i,
  /^MYSQL_/i,
  /^POSTGRES_/i,
  /^REDIS_/i,
  /^MONGO/i,
  /^SSH_/i,
  /^GPG_/i,
  /^NPM_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^GITLAB_TOKEN$/i
] as const;
