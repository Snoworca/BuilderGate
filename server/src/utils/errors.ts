/**
 * Error Definitions and Utilities
 * Phase 2: Authentication Core
 */

// ============================================================================
// Error Codes
// ============================================================================

export enum ErrorCode {
  // Authentication Errors (4xx)
  MISSING_TOKEN = 'MISSING_TOKEN',
  INVALID_TOKEN = 'INVALID_TOKEN',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_REVOKED = 'TOKEN_REVOKED',
  INVALID_PASSWORD = 'INVALID_PASSWORD',

  // 2FA Errors (Phase 3)
  TWO_FA_REQUIRED = 'TWO_FA_REQUIRED',
  INVALID_TEMP_TOKEN = 'INVALID_TEMP_TOKEN',
  INVALID_OTP = 'INVALID_OTP',
  OTP_EXPIRED = 'OTP_EXPIRED',
  OTP_MAX_ATTEMPTS = 'OTP_MAX_ATTEMPTS',
  SMTP_ERROR = 'SMTP_ERROR',

  // Rate Limiting Errors (Phase 5)
  RATE_LIMITED = 'RATE_LIMITED',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  IP_BLACKLISTED = 'IP_BLACKLISTED',

  // Validation Errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  UNSUPPORTED_SETTING = 'UNSUPPORTED_SETTING',
  CURRENT_PASSWORD_REQUIRED = 'CURRENT_PASSWORD_REQUIRED',
  INVALID_CURRENT_PASSWORD = 'INVALID_CURRENT_PASSWORD',
  PASSWORD_CONFIRM_MISMATCH = 'PASSWORD_CONFIRM_MISMATCH',
  CURRENT_ORIGIN_BLOCKED = 'CURRENT_ORIGIN_BLOCKED',

  // Session Errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_UNAUTHORIZED = 'SESSION_UNAUTHORIZED',
  DUPLICATE_SESSION_NAME = 'DUPLICATE_SESSION_NAME',

  // File Manager Errors (Phase 4)
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
  PATH_NOT_FOUND = 'PATH_NOT_FOUND',
  PATH_BLOCKED = 'PATH_BLOCKED',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  BINARY_FILE = 'BINARY_FILE',
  DIRECTORY_TOO_LARGE = 'DIRECTORY_TOO_LARGE',
  FILE_OPERATION_FAILED = 'FILE_OPERATION_FAILED',
  FILE_ALREADY_EXISTS = 'FILE_ALREADY_EXISTS',
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  // Server Errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  ENCRYPTION_ERROR = 'ENCRYPTION_ERROR',
  DECRYPTION_ERROR = 'DECRYPTION_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  CONFIG_APPLY_FAILED = 'CONFIG_APPLY_FAILED',
  CONFIG_PERSIST_FAILED = 'CONFIG_PERSIST_FAILED'
}

// ============================================================================
// Error Messages
// ============================================================================

export const ErrorMessages: Record<ErrorCode, string> = {
  [ErrorCode.MISSING_TOKEN]: 'Authentication token is required',
  [ErrorCode.INVALID_TOKEN]: 'Invalid authentication token',
  [ErrorCode.INVALID_SIGNATURE]: 'Token signature is invalid',
  [ErrorCode.TOKEN_EXPIRED]: 'Authentication token has expired',
  [ErrorCode.TOKEN_REVOKED]: 'Authentication token has been revoked',
  [ErrorCode.INVALID_PASSWORD]: 'Invalid password',

  [ErrorCode.TWO_FA_REQUIRED]: 'Two-factor authentication is required',
  [ErrorCode.INVALID_TEMP_TOKEN]: 'Invalid or expired temporary token',
  [ErrorCode.INVALID_OTP]: 'Invalid verification code',
  [ErrorCode.OTP_EXPIRED]: 'Verification code has expired',
  [ErrorCode.OTP_MAX_ATTEMPTS]: 'Maximum verification attempts exceeded',
  [ErrorCode.SMTP_ERROR]: 'Failed to send verification email',

  [ErrorCode.RATE_LIMITED]: 'Too many requests, please try again later',
  [ErrorCode.ACCOUNT_LOCKED]: 'Account is temporarily locked',
  [ErrorCode.IP_BLACKLISTED]: 'Access denied',

  [ErrorCode.VALIDATION_ERROR]: 'Validation failed',
  [ErrorCode.INVALID_INPUT]: 'Invalid input provided',
  [ErrorCode.UNSUPPORTED_SETTING]: 'Unsupported setting',
  [ErrorCode.CURRENT_PASSWORD_REQUIRED]: 'Current password is required',
  [ErrorCode.INVALID_CURRENT_PASSWORD]: 'Current password is invalid',
  [ErrorCode.PASSWORD_CONFIRM_MISMATCH]: 'New password confirmation does not match',
  [ErrorCode.CURRENT_ORIGIN_BLOCKED]: 'Current origin would be blocked by this CORS change',

  [ErrorCode.SESSION_NOT_FOUND]: 'Session not found',
  [ErrorCode.SESSION_UNAUTHORIZED]: 'Not authorized to access this session',
  [ErrorCode.DUPLICATE_SESSION_NAME]: 'Session name already exists',

  [ErrorCode.PATH_TRAVERSAL]: 'Path traversal detected',
  [ErrorCode.PATH_NOT_FOUND]: 'Path not found',
  [ErrorCode.PATH_BLOCKED]: 'Access to this path is blocked',
  [ErrorCode.FILE_TOO_LARGE]: 'File is too large',
  [ErrorCode.BINARY_FILE]: 'Binary files are not supported',
  [ErrorCode.DIRECTORY_TOO_LARGE]: 'Directory has too many entries',
  [ErrorCode.FILE_OPERATION_FAILED]: 'File operation failed',
  [ErrorCode.FILE_ALREADY_EXISTS]: 'File already exists',
  [ErrorCode.PERMISSION_DENIED]: 'Permission denied',

  [ErrorCode.INTERNAL_ERROR]: 'Internal server error',
  [ErrorCode.ENCRYPTION_ERROR]: 'Encryption failed',
  [ErrorCode.DECRYPTION_ERROR]: 'Decryption failed',
  [ErrorCode.CONFIG_ERROR]: 'Configuration error',
  [ErrorCode.CONFIG_APPLY_FAILED]: 'Failed to apply runtime settings',
  [ErrorCode.CONFIG_PERSIST_FAILED]: 'Failed to persist configuration'
};

// ============================================================================
// HTTP Status Codes
// ============================================================================

export const ErrorStatusCodes: Record<ErrorCode, number> = {
  [ErrorCode.MISSING_TOKEN]: 401,
  [ErrorCode.INVALID_TOKEN]: 401,
  [ErrorCode.INVALID_SIGNATURE]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.TOKEN_REVOKED]: 401,
  [ErrorCode.INVALID_PASSWORD]: 401,

  [ErrorCode.TWO_FA_REQUIRED]: 202,
  [ErrorCode.INVALID_TEMP_TOKEN]: 401,
  [ErrorCode.INVALID_OTP]: 401,
  [ErrorCode.OTP_EXPIRED]: 401,
  [ErrorCode.OTP_MAX_ATTEMPTS]: 429,
  [ErrorCode.SMTP_ERROR]: 503,

  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.ACCOUNT_LOCKED]: 423,
  [ErrorCode.IP_BLACKLISTED]: 403,

  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.UNSUPPORTED_SETTING]: 400,
  [ErrorCode.CURRENT_PASSWORD_REQUIRED]: 400,
  [ErrorCode.INVALID_CURRENT_PASSWORD]: 400,
  [ErrorCode.PASSWORD_CONFIRM_MISMATCH]: 400,
  [ErrorCode.CURRENT_ORIGIN_BLOCKED]: 409,

  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.SESSION_UNAUTHORIZED]: 403,
  [ErrorCode.DUPLICATE_SESSION_NAME]: 409,

  [ErrorCode.PATH_TRAVERSAL]: 403,
  [ErrorCode.PATH_NOT_FOUND]: 404,
  [ErrorCode.PATH_BLOCKED]: 403,
  [ErrorCode.FILE_TOO_LARGE]: 413,
  [ErrorCode.BINARY_FILE]: 415,
  [ErrorCode.DIRECTORY_TOO_LARGE]: 413,
  [ErrorCode.FILE_OPERATION_FAILED]: 500,
  [ErrorCode.FILE_ALREADY_EXISTS]: 409,
  [ErrorCode.PERMISSION_DENIED]: 403,

  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.ENCRYPTION_ERROR]: 500,
  [ErrorCode.DECRYPTION_ERROR]: 500,
  [ErrorCode.CONFIG_ERROR]: 500,
  [ErrorCode.CONFIG_APPLY_FAILED]: 422,
  [ErrorCode.CONFIG_PERSIST_FAILED]: 500
};

// ============================================================================
// AppError Class
// ============================================================================

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>
  ) {
    super(message || ErrorMessages[code]);
    this.code = code;
    this.statusCode = ErrorStatusCodes[code];
    this.details = details;
    this.timestamp = new Date().toISOString();

    // Ensure proper prototype chain
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
        timestamp: this.timestamp
      }
    };
  }
}

// ============================================================================
// Error Response Helper
// ============================================================================

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
  };
}

export function createErrorResponse(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>
): ErrorResponse {
  return {
    error: {
      code,
      message: message || ErrorMessages[code],
      ...(details && { details }),
      timestamp: new Date().toISOString()
    }
  };
}
