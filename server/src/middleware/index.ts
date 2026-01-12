/**
 * Middleware Exports
 * Phase 1: Security Infrastructure
 */

// Security Headers (Phase 1)
export {
  createSecurityHeadersMiddleware,
  createNoCacheMiddleware,
  createPermissionsPolicyMiddleware,
  type SecurityHeadersOptions
} from './securityHeaders.js';

// Authentication Middleware (Phase 2)
export {
  createAuthMiddleware,
  createOptionalAuthMiddleware
} from './authMiddleware.js';

// Future middleware exports will be added here:
// - rateLimiter (Phase 5)
// - corsMiddleware (Phase 6)
// - inputValidator (Phase 6)
