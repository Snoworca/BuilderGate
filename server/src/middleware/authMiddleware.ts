/**
 * Authentication Middleware
 * Phase 2: Authentication Core
 *
 * Validates JWT tokens and attaches user payload to requests
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthService } from '../services/AuthService.js';
import type { JWTPayload } from '../types/auth.types.js';
import { AppError, ErrorCode, createErrorResponse } from '../utils/errors.js';

// ============================================================================
// Extend Express Request
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

// ============================================================================
// Auth Middleware Factory
// ============================================================================

/**
 * Create authentication middleware
 * @param authService - AuthService instance for token verification
 * @returns Express middleware function
 *
 * Supports two token sources:
 * 1. Authorization header: "Bearer <token>" (standard)
 * 2. Query parameter: ?token=<token> (for SSE - EventSource doesn't support headers)
 */
export function createAuthMiddleware(authService: AuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract token from Authorization header first
    let token: string | undefined;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7); // Remove 'Bearer ' prefix
    }

    // Fallback to query param (for SSE - EventSource doesn't support custom headers)
    if (!token && typeof req.query.token === 'string') {
      token = req.query.token;
    }

    if (!token) {
      res.status(401).json(createErrorResponse(ErrorCode.MISSING_TOKEN));
      return;
    }

    // Verify token
    const result = authService.verifyToken(token);

    if (!result.valid) {
      res.status(401).json(createErrorResponse(result.error));
      return;
    }

    // Attach user payload to request
    req.user = result.payload;

    next();
  };
}

// ============================================================================
// Optional Auth Middleware
// ============================================================================

/**
 * Create optional authentication middleware
 * Attaches user if token is valid, but doesn't block if missing
 * @param authService - AuthService instance for token verification
 * @returns Express middleware function
 */
export function createOptionalAuthMiddleware(authService: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = authService.verifyToken(token);

      if (result.valid) {
        req.user = result.payload;
      }
    }

    next();
  };
}
