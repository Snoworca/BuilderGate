/**
 * Authentication Service
 * Phase 2: Authentication Core
 *
 * Handles password validation, JWT token management, and token blacklisting
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type { AuthConfig } from '../types/config.types.js';
import type { JWTPayload, TokenBlacklistEntry } from '../types/auth.types.js';
import { CryptoService } from './CryptoService.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { AUTH_DEFAULTS } from '../utils/constants.js';

// ============================================================================
// Constants
// ============================================================================

const BLACKLIST_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class AuthService {
  private jwtSecret: string;
  private tokenBlacklist: Map<string, number> = new Map();
  private config: AuthConfig;
  private cryptoService: CryptoService;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private decryptedPassword: string | null = null;

  constructor(config: AuthConfig, cryptoService: CryptoService) {
    this.config = config;
    this.cryptoService = cryptoService;

    // Initialize JWT secret
    this.jwtSecret = this.initializeJwtSecret();

    // Decrypt and cache password for validation
    this.initializePassword();

    // Start blacklist cleanup
    this.startBlacklistCleanup();

    console.log('[Auth] AuthService initialized');
  }

  /**
   * Initialize JWT secret from config or generate new one
   */
  private initializeJwtSecret(): string {
    if (this.config.jwtSecret) {
      // Decrypt if encrypted
      if (this.cryptoService.isEncrypted(this.config.jwtSecret)) {
        return this.cryptoService.decrypt(this.config.jwtSecret);
      }
      return this.config.jwtSecret;
    }

    // Generate new secret
    const secret = this.cryptoService.generateSecureRandomString(32);
    console.log('[Auth] Generated new JWT secret');
    return secret;
  }

  /**
   * Initialize password from config
   */
  private initializePassword(): void {
    if (!this.config.password) {
      console.warn('[Auth] No password configured - authentication will fail');
      return;
    }

    // Decrypt if encrypted
    if (this.cryptoService.isEncrypted(this.config.password)) {
      this.decryptedPassword = this.cryptoService.decrypt(this.config.password);
    } else {
      this.decryptedPassword = this.config.password;
    }
  }

  /**
   * Validate a password against the configured password
   * @param input - Password to validate
   * @returns True if password matches
   */
  validatePassword(input: string): boolean {
    if (!this.decryptedPassword) {
      console.error('[Auth] No password configured');
      return false;
    }

    // Use timing-safe comparison
    const isValid = this.cryptoService.timingSafeEqual(input, this.decryptedPassword);

    return isValid;
  }

  /**
   * Issue a new JWT token
   * @returns JWT token string and payload
   */
  issueToken(): { token: string; payload: JWTPayload } {
    const now = Math.floor(Date.now() / 1000);
    const durationMs = this.config.durationMs || AUTH_DEFAULTS.SESSION_DURATION_MS;
    const durationSec = Math.floor(durationMs / 1000);

    const payload: JWTPayload = {
      sub: 'admin',
      iat: now,
      exp: now + durationSec,
      jti: uuidv4()
    };

    const token = jwt.sign(payload, this.jwtSecret, {
      algorithm: AUTH_DEFAULTS.JWT_ALGORITHM as jwt.Algorithm
    });

    console.log(`[Auth] Token issued: jti=${payload.jti}`);

    return { token, payload };
  }

  /**
   * Verify a JWT token
   * @param token - JWT token string
   * @returns JWT payload if valid, null otherwise
   */
  verifyToken(token: string): { valid: true; payload: JWTPayload } | { valid: false; error: ErrorCode } {
    try {
      // Verify and decode token
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: [AUTH_DEFAULTS.JWT_ALGORITHM as jwt.Algorithm]
      }) as JWTPayload;

      // Check if token is revoked
      if (this.isTokenRevoked(payload.jti)) {
        return { valid: false, error: ErrorCode.TOKEN_REVOKED };
      }

      return { valid: true, payload };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { valid: false, error: ErrorCode.TOKEN_EXPIRED };
      }
      if (error instanceof jwt.JsonWebTokenError) {
        if (error.message.includes('signature')) {
          return { valid: false, error: ErrorCode.INVALID_SIGNATURE };
        }
        return { valid: false, error: ErrorCode.INVALID_TOKEN };
      }
      return { valid: false, error: ErrorCode.INVALID_TOKEN };
    }
  }

  /**
   * Refresh a token (issue new token, revoke old one)
   * @param oldToken - Current valid token
   * @returns New token and payload
   */
  refreshToken(oldToken: string): { token: string; payload: JWTPayload } | null {
    const result = this.verifyToken(oldToken);
    if (!result.valid) {
      return null;
    }

    // Revoke old token
    this.revokeToken(result.payload.jti);

    // Issue new token
    return this.issueToken();
  }

  /**
   * Revoke a token by adding its jti to the blacklist
   * @param jti - JWT ID to revoke
   * @param expiresAt - Optional expiration timestamp (defaults to token's exp)
   */
  revokeToken(jti: string, expiresAt?: number): void {
    const expiry = expiresAt || (Math.floor(Date.now() / 1000) + 86400); // Default 24h
    this.tokenBlacklist.set(jti, expiry);
    console.log(`[Auth] Token revoked: jti=${jti}`);
  }

  /**
   * Check if a token is revoked
   * @param jti - JWT ID to check
   * @returns True if token is revoked
   */
  isTokenRevoked(jti: string): boolean {
    return this.tokenBlacklist.has(jti);
  }

  /**
   * Start periodic blacklist cleanup
   */
  private startBlacklistCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupBlacklist();
    }, BLACKLIST_CLEANUP_INTERVAL);

    // Don't keep the process alive just for cleanup
    this.cleanupInterval.unref();
  }

  /**
   * Clean up expired entries from the blacklist
   */
  private cleanupBlacklist(): void {
    const now = Math.floor(Date.now() / 1000);
    let cleaned = 0;

    for (const [jti, expiresAt] of this.tokenBlacklist.entries()) {
      if (expiresAt < now) {
        this.tokenBlacklist.delete(jti);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Auth] Cleaned ${cleaned} expired blacklist entries`);
    }
  }

  /**
   * Get session duration from config
   * @returns Duration in milliseconds
   */
  getSessionDuration(): number {
    return this.config.durationMs || AUTH_DEFAULTS.SESSION_DURATION_MS;
  }

  /**
   * Check if 2FA is enabled
   * This is a placeholder for Phase 3
   */
  is2FAEnabled(): boolean {
    // Will be implemented in Phase 3
    return false;
  }

  /**
   * Get the encrypted JWT secret for storage
   * @returns Encrypted JWT secret
   */
  getEncryptedJwtSecret(): string {
    return this.cryptoService.encrypt(this.jwtSecret);
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Clear sensitive data
    this.decryptedPassword = null;
  }
}
