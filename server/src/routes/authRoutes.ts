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
import type { TwoFactorService } from '../services/TwoFactorService.js';
import type { TOTPService } from '../services/TOTPService.js';
import type { LoginResponse, LogoutResponse, VerifyResponse } from '../types/auth.types.js';
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
  otpCode: z.string().min(4, 'OTP code is required').max(8, 'OTP code too long'),
  stage: z.enum(['email', 'totp']).optional(), // FR-802
});

// ============================================================================
// COMBO Login Helpers
// ============================================================================

async function handleCombo2Login(res: Response, twoFactorService: TwoFactorService): Promise<void> {
  const { tempToken, otp } = twoFactorService.createPendingAuth('email');
  await twoFactorService.sendOTP(otp);
  const email = twoFactorService.getEmail() ?? '';
  const maskedEmail = twoFactorService.maskEmail(email);
  console.log(`[Auth] COMBO-2: email OTP initiated for ${maskedEmail}`);
  const response: LoginResponse = {
    success: true,
    requires2FA: true,
    tempToken,
    maskedEmail,
    nextStage: 'email',
    message: `Verification code sent to ${maskedEmail}`,
  };
  res.status(202).json(response);
}

function handleCombo3Login(res: Response, twoFactorService: TwoFactorService): void {
  const { tempToken } = twoFactorService.createPendingAuth('totp');
  console.log('[Auth] COMBO-3: TOTP-only login initiated');
  const response: LoginResponse = {
    success: true,
    requires2FA: true,
    tempToken,
    nextStage: 'totp',
  };
  res.status(202).json(response);
}

async function handleCombo4Login(res: Response, twoFactorService: TwoFactorService): Promise<void> {
  const { tempToken, otp } = twoFactorService.createPendingAuth('email');
  try {
    await twoFactorService.sendOTP(otp);
    const email = twoFactorService.getEmail() ?? '';
    const maskedEmail = twoFactorService.maskEmail(email);
    console.log(`[Auth] COMBO-4: email OTP initiated for ${maskedEmail}`);
    const response: LoginResponse = {
      success: true,
      requires2FA: true,
      tempToken,
      maskedEmail,
      nextStage: 'email',
      message: `Verification code sent to ${maskedEmail}`,
    };
    res.status(202).json(response);
  } catch (emailErr) {
    // FR-501: email delivery failed → fall back to TOTP
    console.warn(`[Auth] COMBO-4: email OTP failed, falling back to TOTP (tempToken=${tempToken.substring(0, 8)}...)`);
    twoFactorService.updateStage(tempToken, 'totp');
    const response: LoginResponse = {
      success: true,
      requires2FA: true,
      tempToken,
      nextStage: 'totp',
      emailFallback: true,
    };
    res.status(202).json(response);
  }
}

// ============================================================================
// Route Factory
// ============================================================================

interface AuthRouteAccessors {
  getAuthService: () => AuthService;
  getTwoFactorService: () => TwoFactorService | undefined;
  getTOTPService: () => TOTPService | undefined;
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
      const twoFactorService = accessors.getTwoFactorService();
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

      // 3. COMBO-1: 2FA disabled
      if (!twoFactorService?.isEnabled()) {
        const { token } = authService.issueToken();
        console.log(`[Auth] Login successful from ${req.ip}`);
        res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as LoginResponse);
        return;
      }

      // 4. FR-401: TOTP enabled but not registered → 503
      if (totpService != null && !totpService.isRegistered()) {
        // AC-401: console.warn required
        console.warn('[TOTP] Login blocked: TOTP is enabled but secret is not registered.');
        // NFR-106: no internal details in response
        res.status(503).json({
          success: false,
          message: 'TOTP is enabled but not configured. Delete data/totp.secret and restart to re-register.',
        });
        return;
      }

      // 5. COMBO routing
      const totpEnabled = totpService != null && totpService.isRegistered();
      const emailEnabled = twoFactorService.hasEmailConfig();

      try {
        if (totpEnabled && emailEnabled) {
          await handleCombo4Login(res, twoFactorService);  // COMBO-4
        } else if (totpEnabled) {
          handleCombo3Login(res, twoFactorService);         // COMBO-3
        } else {
          await handleCombo2Login(res, twoFactorService);   // COMBO-2
        }
      } catch (error) {
        console.error('[Auth] Failed to initiate 2FA:', error);
        res.status(503).json(createErrorResponse(ErrorCode.SMTP_ERROR));
      }
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
      const twoFactorService = accessors.getTwoFactorService();
      const totpService = accessors.getTOTPService();

      if (!twoFactorService?.isEnabled()) {
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

      const { tempToken, otpCode, stage: requestedStage } = parseResult.data;

      // FR-802: stage validation
      const otpData = twoFactorService.getOTPData(tempToken);
      if (!otpData) {
        res.status(401).json(createErrorResponse(ErrorCode.INVALID_TEMP_TOKEN));
        return;
      }

      if (Date.now() > otpData.expiresAt) {
        twoFactorService.invalidatePendingAuth(tempToken);
        res.status(401).json(createErrorResponse(ErrorCode.OTP_EXPIRED));
        return;
      }

      const currentStage = otpData.stage ?? 'email';
      const targetStage = requestedStage ?? currentStage;
      if (targetStage !== currentStage) {
        res.status(400).json({ success: false, message: 'Unexpected verification stage' });
        return;
      }

      if (currentStage === 'email') {
        // Email OTP — verifyOTP handles attempts increment, expiry, and otpStore cleanup
        const result = twoFactorService.verifyOTP(tempToken, otpCode);
        if (!result.success) {
          const errorCode = result.errorCode as ErrorCode || ErrorCode.INVALID_OTP;
          const statusCode = ErrorStatusCodes[errorCode] || 401;
          res.status(statusCode).json(createErrorResponse(
            errorCode, undefined,
            result.attemptsRemaining !== undefined ? { attemptsRemaining: result.attemptsRemaining } : undefined
          ));
          return;
        }

        // FR-803: COMBO-4 intermediate — email verified, proceed to TOTP
        if (totpService?.isRegistered()) {
          const { tempToken: totpTempToken } = twoFactorService.createPendingAuth('totp');
          const response: VerifyResponse = {
            success: true,
            tempToken: totpTempToken,
            nextStage: 'totp',
          };
          res.status(202).json(response);
          return;
        }

        // COMBO-2: final JWT issue (FR-804)
        const { token } = authService.issueToken();
        console.log(`[Auth] COMBO-2 verification successful from ${req.ip}`);
        res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as VerifyResponse);

      } else {
        // TOTP verification (COMBO-3 or COMBO-4 step 2)
        if (!totpService) {
          res.status(400).json({ success: false, message: 'TOTP not configured' });
          return;
        }

        // verifyTOTP increments otpData.attempts on failure (Phase 2 implementation)
        const result = totpService.verifyTOTP(otpCode, otpData);
        if (!result.valid) {
          if (otpData.attempts >= 3) twoFactorService.invalidatePendingAuth(tempToken);
          res.status(401).json({
            success: false,
            errorCode: ErrorCode.INVALID_OTP,
            attemptsRemaining: Math.max(0, 3 - otpData.attempts),
          });
          return;
        }

        // TOTP success — verifyTOTP already set totpLastUsedStep (NFR-105)
        twoFactorService.invalidatePendingAuth(tempToken);
        const { token } = authService.issueToken();
        console.log(`[Auth] TOTP verification successful from ${req.ip}`);
        res.json({ success: true, token, expiresIn: authService.getSessionDuration() } as VerifyResponse);
      }
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

  return router;
}
