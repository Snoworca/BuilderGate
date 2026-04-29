/**
 * Authentication Routes
 * Phase 2: Authentication Core
 * Phase 3: Two-Factor Authentication
 * Step 6: TOTP (4 COMBO flows)
 *
 * Provides login, logout, and 2FA verification endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/AuthService.js';
import type { TOTPService } from '../services/TOTPService.js';
import type {
  BootstrapPasswordResponse,
  BootstrapStatusResponse,
  LoginResponse,
  LogoutResponse,
  VerifyResponse,
} from '../types/auth.types.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';
import { AppError, ErrorCode, createErrorResponse } from '../utils/errors.js';

// ============================================================================
// Request Validation Schemas
// ============================================================================

const loginSchema = z.object({
  password: z.string().min(1, 'Password is required')
});

const verifySchema = z.object({
  tempToken: z.string().uuid('Invalid temporary token format'),
  otpCode: z.string().min(4, 'OTP code is required').max(8, 'OTP code too long'),
  stage: z.enum(['totp']).optional(),
});

const bootstrapPasswordSchema = z.object({
  password: z.string(),
  confirmPassword: z.string(),
});

// ============================================================================
// COMBO Login Helpers
// ============================================================================

function handleTOTPLogin(res: Response, _totpService: TOTPService, tempToken: string): void {
  console.log('[Auth] TOTP login initiated');
  const response: LoginResponse = {
    success: true,
    requires2FA: true,
    tempToken,
    nextStage: 'totp',
  };
  res.status(202).json(response);
}

// ============================================================================
// Route Factory
// ============================================================================

interface BootstrapSetupAccessor {
  getStatus: (requestIp: string) => BootstrapStatusResponse;
  bootstrapPassword: (requestIp: string, password: string, confirmPassword: string) => BootstrapPasswordResponse;
}

interface AuthRouteAccessors {
  getAuthService: () => AuthService;
  getTOTPService: () => TOTPService | undefined;
  getTwoFactorExternalOnly: () => boolean;
  getBootstrapSetupService: () => BootstrapSetupAccessor;
  getRequestIp: (req: Request) => string;
}

/**
 * Create authentication routes
 * @param accessors - Runtime service accessors
 * @returns Express router
 */
export function createAuthRoutes(accessors: AuthRouteAccessors): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(() => accessors.getAuthService());

  router.get('/bootstrap-status', (req: Request, res: Response): void => {
    try {
      const bootstrapSetupService = accessors.getBootstrapSetupService();
      const requestIp = accessors.getRequestIp(req);
      const response: BootstrapStatusResponse = bootstrapSetupService.getStatus(requestIp);
      res.json(response);
    } catch (error) {
      console.error('[Auth] Bootstrap status error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  router.post('/bootstrap-password', (req: Request, res: Response): void => {
    try {
      const parseResult = bootstrapPasswordSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          { issues: parseResult.error.issues },
        ));
        return;
      }

      const bootstrapSetupService = accessors.getBootstrapSetupService();
      const requestIp = accessors.getRequestIp(req);
      const response: BootstrapPasswordResponse = bootstrapSetupService.bootstrapPassword(
        requestIp,
        parseResult.data.password,
        parseResult.data.confirmPassword,
      );
      res.status(201).json(response);
    } catch (error) {
      if (error instanceof AppError) {
        const appError = error;
        console.warn(`[Auth] Bootstrap password rejected from ${accessors.getRequestIp(req)}: ${appError.code}`);
        res.status(appError.statusCode).json(createErrorResponse(appError.code, appError.message, appError.details));
        return;
      }

      console.error('[Auth] Bootstrap password error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // POST /api/auth/login
  // ========================================================================
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
      const parseResult = loginSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(createErrorResponse(
          ErrorCode.VALIDATION_ERROR, 'Invalid request body',
          { issues: parseResult.error.issues }
        ));
        return;
      }

      const { password } = parseResult.data;
      const authService = accessors.getAuthService();
      const totpService = accessors.getTOTPService();

      // 1. Password validation
      const isValid = authService.validatePassword(password);
      if (!isValid) {
        console.log(`[Auth] Login failed: invalid password from ${req.ip}`);
        res.status(401).json(createErrorResponse(ErrorCode.INVALID_PASSWORD));
        return;
      }

      // 2. FR-602: localhostPasswordOnly bypass
      const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? '');
      if (authService.getLocalhostPasswordOnly() && isLocalhost) {
        const { token } = authService.issueToken();
        console.log(`[Auth] Login successful (localhostPasswordOnly) from ${req.ip}`);
        res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as LoginResponse);
        return;
      }

      // 2b. twoFactor.externalOnly bypass: localhost 접속 시 2FA 건너뜀
      if (accessors.getTwoFactorExternalOnly() && isLocalhost) {
        const { token } = authService.issueToken();
        console.log(`[Auth] Login successful (twoFactor.externalOnly) from ${req.ip}`);
        res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as LoginResponse);
        return;
      }

      // 3. TOTP disabled → direct login
      if (totpService == null) {
        const { token } = authService.issueToken();
        console.log(`[Auth] Login successful from ${req.ip}`);
        res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as LoginResponse);
        return;
      }

      // 4. FR-401: TOTP enabled but not registered → 503
      if (!totpService.isRegistered()) {
        console.warn('[TOTP] Login blocked: TOTP is enabled but secret is not registered.');
        res.status(503).json({
          success: false,
          message: 'TOTP is enabled but not configured. Delete data/totp.secret and restart to re-register.',
        });
        return;
      }

      // 5. TOTP login
      const { tempToken } = totpService.createPendingAuth();
      handleTOTPLogin(res, totpService, tempToken);
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
        authService.revokeToken(req.user.jti, req.user.exp);
        console.log(`[Auth] Logout: jti=${req.user.jti}`);
      }
      const response: LogoutResponse = { success: true, message: 'Logged out successfully' };
      res.json(response);
    } catch (error) {
      console.error('[Auth] Logout error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // POST /api/auth/verify (2FA + TOTP stage routing)
  // ========================================================================
  router.post('/verify', async (req: Request, res: Response): Promise<void> => {
    try {
      const authService = accessors.getAuthService();
      const totpService = accessors.getTOTPService();

      if (!totpService) {
        res.status(400).json(createErrorResponse(ErrorCode.CONFIG_ERROR, 'Two-factor authentication is not enabled'));
        return;
      }

      const parseResult = verifySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(createErrorResponse(
          ErrorCode.VALIDATION_ERROR, 'Invalid request body',
          { issues: parseResult.error.issues }
        ));
        return;
      }

      const { tempToken, otpCode } = parseResult.data;

      const otpData = totpService.getOTPData(tempToken);
      if (!otpData) {
        res.status(401).json(createErrorResponse(ErrorCode.INVALID_TEMP_TOKEN));
        return;
      }

      if (Date.now() > otpData.expiresAt) {
        totpService.invalidatePendingAuth(tempToken);
        res.status(401).json(createErrorResponse(ErrorCode.OTP_EXPIRED));
        return;
      }

      // TOTP verification
      const result = totpService.verifyTOTP(otpCode, otpData);
      if (!result.valid) {
        if (otpData.attempts >= 3) totpService.invalidatePendingAuth(tempToken);
        res.status(401).json({
          success: false,
          errorCode: ErrorCode.INVALID_OTP,
          attemptsRemaining: Math.max(0, 3 - otpData.attempts),
        });
        return;
      }

      // TOTP success — verifyTOTP already set totpLastUsedStep (NFR-105)
      totpService.invalidatePendingAuth(tempToken);
      const { token } = authService.issueToken();
      console.log(`[Auth] TOTP verification successful from ${req.ip}`);
      res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as VerifyResponse);
    } catch (error) {
      console.error('[Auth] Verify error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  // ========================================================================
  // POST /api/auth/refresh (Heartbeat)
  // ========================================================================
  router.post('/refresh', authMiddleware, (req: Request, res: Response): void => {
    try {
      const authService = accessors.getAuthService();
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json(createErrorResponse(ErrorCode.MISSING_TOKEN));
        return;
      }
      const currentToken = authHeader.slice(7);
      const result = authService.refreshToken(currentToken);
      if (!result) {
        res.status(401).json(createErrorResponse(ErrorCode.INVALID_TOKEN));
        return;
      }
      res.json({ success: true, token: result.token, expiresIn: authService.getSessionDuration() });
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
      expiresAt: req.user?.exp ? new Date(req.user.exp * 1000).toISOString() : null,
    });
  });

  // ========================================================================
  // GET /api/auth/totp-qr
  // Returns QR code data URL for TOTP setup in Google Authenticator.
  // Protected by authMiddleware.
  // ========================================================================
  router.get('/totp-qr', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
      const totpService = accessors.getTOTPService();
      if (!totpService) {
        res.status(404).json(createErrorResponse(ErrorCode.CONFIG_ERROR, 'TOTP is not enabled'));
        return;
      }
      const result = await totpService.generateQRDataUrl();
      res.json(result);
    } catch (error) {
      console.error('[Auth] totp-qr error:', error);
      res.status(500).json(createErrorResponse(ErrorCode.INTERNAL_ERROR));
    }
  });

  return router;
}
