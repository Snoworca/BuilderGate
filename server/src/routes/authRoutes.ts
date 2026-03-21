/**
 * Authentication Routes
 * Phase 2: Authentication Core
 * Phase 3: Two-Factor Authentication
 *
 * Provides login, logout, and 2FA verification endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/AuthService.js';
import type { TwoFactorService } from '../services/TwoFactorService.js';
import type { LoginRequest, LoginResponse, LogoutResponse, VerifyRequest, VerifyResponse } from '../types/auth.types.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';
import { ErrorCode, createErrorResponse, ErrorStatusCodes } from '../utils/errors.js';

// ============================================================================
// Request Validation Schemas
// ============================================================================

const loginSchema = z.object({
  password: z.string().min(1, 'Password is required')
});

const verifySchema = z.object({
  tempToken: z.string().uuid('Invalid temporary token format'),
  otpCode: z.string().min(4, 'OTP code is required').max(8, 'OTP code too long')
});

// ============================================================================
// Route Factory
// ============================================================================

interface AuthRouteAccessors {
  getAuthService: () => AuthService;
  getTwoFactorService: () => TwoFactorService | undefined;
}

/**
 * Create authentication routes
 * @param accessors - Runtime service accessors
 * @returns Express router
 */
export function createAuthRoutes(accessors: AuthRouteAccessors): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(() => accessors.getAuthService());

  // ========================================================================
  // POST /api/auth/login
  // ========================================================================
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request body
      const parseResult = loginSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          { issues: parseResult.error.issues }
        ));
        return;
      }

      const { password } = parseResult.data;
      const authService = accessors.getAuthService();
      const twoFactorService = accessors.getTwoFactorService();

      // Validate password
      const isValid = authService.validatePassword(password);

      if (!isValid) {
        // Log failed attempt (without password)
        console.log(`[Auth] Login failed: invalid password from ${req.ip}`);
        res.status(401).json(createErrorResponse(ErrorCode.INVALID_PASSWORD));
        return;
      }

      // Check if 2FA is enabled (Phase 3)
      if (twoFactorService?.isEnabled()) {
        try {
          const email = twoFactorService.getEmail();
          if (!email) {
            console.error('[Auth] 2FA enabled but no email configured');
            res.status(500).json(createErrorResponse(ErrorCode.CONFIG_ERROR, '2FA email not configured'));
            return;
          }

          // Create pending auth and send OTP
          const pendingAuth = await twoFactorService.createPendingAuth(email);

          console.log(`[Auth] 2FA initiated for ${pendingAuth.maskedEmail} from ${req.ip}`);

          const response: LoginResponse = {
            success: true,
            requires2FA: true,
            tempToken: pendingAuth.tempToken,
            maskedEmail: pendingAuth.maskedEmail,
            message: `Verification code sent to ${pendingAuth.maskedEmail}`
          };
          res.status(202).json(response);
          return;
        } catch (error) {
          console.error('[Auth] Failed to initiate 2FA:', error);
          res.status(503).json(createErrorResponse(ErrorCode.SMTP_ERROR));
          return;
        }
      }

      // Issue token
      const { token, payload } = authService.issueToken();

      console.log(`[Auth] Login successful from ${req.ip}`);

      const response: LoginResponse = {
        success: true,
        token,
        expiresIn: authService.getSessionDuration()
      };

      res.json(response);
    } catch (error) {
      console.error('[Auth] Login error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // POST /api/auth/logout
  // ========================================================================
  router.post('/logout', authMiddleware, (req: Request, res: Response): void => {
    try {
      const authService = accessors.getAuthService();
      if (req.user) {
        // Revoke the token
        authService.revokeToken(req.user.jti, req.user.exp);
        console.log(`[Auth] Logout: jti=${req.user.jti}`);
      }

      const response: LogoutResponse = {
        success: true,
        message: 'Logged out successfully'
      };

      res.json(response);
    } catch (error) {
      console.error('[Auth] Logout error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // POST /api/auth/verify (Phase 3 - 2FA)
  // ========================================================================
  router.post('/verify', async (req: Request, res: Response): Promise<void> => {
    try {
      const authService = accessors.getAuthService();
      const twoFactorService = accessors.getTwoFactorService();

      // Check if 2FA service is available
      if (!twoFactorService?.isEnabled()) {
        res.status(400).json(createErrorResponse(
          ErrorCode.CONFIG_ERROR,
          'Two-factor authentication is not enabled'
        ));
        return;
      }

      // Validate request body
      const parseResult = verifySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          { issues: parseResult.error.issues }
        ));
        return;
      }

      const { tempToken, otpCode } = parseResult.data;

      // Verify OTP
      const verifyResult = twoFactorService.verifyOTP(tempToken, otpCode);

      if (!verifyResult.success) {
        const errorCode = verifyResult.errorCode as ErrorCode || ErrorCode.INVALID_OTP;
        const statusCode = ErrorStatusCodes[errorCode] || 401;

        res.status(statusCode).json(createErrorResponse(
          errorCode,
          undefined,
          verifyResult.attemptsRemaining !== undefined
            ? { attemptsRemaining: verifyResult.attemptsRemaining }
            : undefined
        ));
        return;
      }

      // OTP verified - issue JWT token
      const { token } = authService.issueToken();

      console.log(`[Auth] 2FA verification successful from ${req.ip}`);

      const response: VerifyResponse = {
        success: true,
        token,
        expiresIn: authService.getSessionDuration()
      };

      res.json(response);
    } catch (error) {
      console.error('[Auth] Verify error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // POST /api/auth/refresh (Phase 4 - Heartbeat)
  // ========================================================================
  router.post('/refresh', authMiddleware, (req: Request, res: Response): void => {
    try {
      const authService = accessors.getAuthService();
      // Extract current token
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json(createErrorResponse(ErrorCode.MISSING_TOKEN));
        return;
      }

      const currentToken = authHeader.slice(7);

      // Refresh token
      const result = authService.refreshToken(currentToken);

      if (!result) {
        res.status(401).json(createErrorResponse(ErrorCode.INVALID_TOKEN));
        return;
      }

      res.json({
        success: true,
        token: result.token,
        expiresIn: authService.getSessionDuration()
      });
    } catch (error) {
      console.error('[Auth] Refresh error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // GET /api/auth/status
  // ========================================================================
  router.get('/status', authMiddleware, (req: Request, res: Response): void => {
    res.json({
      authenticated: true,
      user: req.user?.sub,
      expiresAt: req.user?.exp ? new Date(req.user.exp * 1000).toISOString() : null
    });
  });

  return router;
}
