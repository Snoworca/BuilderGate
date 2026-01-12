/**
 * Security Headers Middleware using Helmet
 * Phase 1: Security Infrastructure
 *
 * Implements HTTP security headers including HSTS, CSP, X-Frame-Options, etc.
 */

import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { SECURITY_HEADERS } from '../utils/constants.js';

export interface SecurityHeadersOptions {
  /** Enable HSTS (HTTP Strict Transport Security) */
  enableHSTS?: boolean;
  /** Custom CSP directives */
  cspDirectives?: Record<string, string[]>;
}

/**
 * Create security headers middleware with helmet
 *
 * Headers applied:
 * - Strict-Transport-Security: HTTPS enforcement
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY
 * - X-XSS-Protection: 0 (legacy, disabled as per modern recommendations)
 * - Content-Security-Policy: XSS prevention
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Permissions-Policy: feature restrictions
 */
export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions = {}
): RequestHandler {
  const { enableHSTS = true, cspDirectives } = options;

  // Default CSP directives for terminal application
  const defaultCspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],  // xterm.js requires inline styles
    connectSrc: ["'self'"],                    // SSE connections
    imgSrc: ["'self'", 'data:'],              // Allow data URIs for icons
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    mediaSrc: ["'none'"],
    frameSrc: ["'none'"],
    frameAncestors: ["'none'"],               // Clickjacking prevention
    formAction: ["'self'"],
    baseUri: ["'self'"],
    upgradeInsecureRequests: []               // Upgrade HTTP to HTTPS
  };

  // Merge custom directives
  const finalCspDirectives = cspDirectives
    ? { ...defaultCspDirectives, ...cspDirectives }
    : defaultCspDirectives;

  return helmet({
    // HSTS - force HTTPS connections
    hsts: enableHSTS
      ? {
          maxAge: SECURITY_HEADERS.HSTS_MAX_AGE,
          includeSubDomains: true,
          preload: false  // Don't preload for localhost/development
        }
      : false,

    // Content Security Policy
    contentSecurityPolicy: {
      directives: finalCspDirectives
    },

    // X-Frame-Options - prevent clickjacking
    frameguard: {
      action: 'deny'
    },

    // X-Content-Type-Options - prevent MIME sniffing
    noSniff: true,

    // X-XSS-Protection - disabled as per modern recommendations
    // Modern browsers should use CSP instead
    xssFilter: false,

    // Referrer-Policy - limit referrer information
    referrerPolicy: {
      policy: SECURITY_HEADERS.REFERRER_POLICY
    },

    // X-DNS-Prefetch-Control - control DNS prefetching
    dnsPrefetchControl: {
      allow: false
    },

    // X-Download-Options - prevent IE from executing downloads
    ieNoOpen: true,

    // X-Permitted-Cross-Domain-Policies - prevent Adobe cross-domain access
    permittedCrossDomainPolicies: {
      permittedPolicies: 'none'
    },

    // Hide X-Powered-By header
    hidePoweredBy: true,

    // Origin-Agent-Cluster - hint for process isolation
    originAgentCluster: true
  }) as RequestHandler;
}

/**
 * Create a middleware that adds Cache-Control headers for security
 * Prevents caching of sensitive responses
 */
export function createNoCacheMiddleware(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  };
}

/**
 * Create a middleware that adds Permissions-Policy header
 * Restricts browser features that the application can use
 */
export function createPermissionsPolicyMiddleware(): RequestHandler {
  const policy = [
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=()',
    'battery=()',
    'camera=()',
    'cross-origin-isolated=()',
    'display-capture=()',
    'document-domain=()',
    'encrypted-media=()',
    'execution-while-not-rendered=()',
    'execution-while-out-of-viewport=()',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'keyboard-map=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'navigation-override=()',
    'payment=()',
    'picture-in-picture=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'sync-xhr=()',
    'usb=()',
    'web-share=()',
    'xr-spatial-tracking=()'
  ].join(', ');

  return (_req, res, next) => {
    res.setHeader('Permissions-Policy', policy);
    next();
  };
}
