/**
 * Configuration Validation Schemas using Zod
 * Phase 1: Security Infrastructure
 */

import { z } from 'zod';

// ============================================================================
// SSL Schema
// ============================================================================

export const sslSchema = z.object({
  certPath: z.string().default(''),
  keyPath: z.string().default(''),
  caPath: z.string().default('')
});

// ============================================================================
// Security Schema
// ============================================================================

export const corsSchema = z.object({
  allowedOrigins: z.array(z.string()).default([]),
  credentials: z.boolean().default(true),
  maxAge: z.number().min(0).max(86400).default(86400)
});

export const securitySchema = z.object({
  cors: corsSchema
});

// ============================================================================
// Logging Schema
// ============================================================================

export const loggingSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  audit: z.boolean().default(true),
  directory: z.string().default('logs'),
  maxSize: z.string().default('10m'),
  maxFiles: z.number().min(1).max(100).default(14)
});

// ============================================================================
// Server Schema
// ============================================================================

export const serverSchema = z.object({
  port: z.number().min(1).max(65535).default(4242)
});

// ============================================================================
// PTY Schema
// ============================================================================

export const ptySchema = z.object({
  termName: z.string().default('xterm-256color'),
  defaultCols: z.number().min(20).max(500).default(80),
  defaultRows: z.number().min(5).max(200).default(24),
  useConpty: z.boolean().default(false),
  maxBufferSize: z.number().min(1024).max(10485760).default(65536)
});

// ============================================================================
// Session Schema
// ============================================================================

export const sessionSchema = z.object({
  idleDelayMs: z.number().min(50).max(5000).default(200)
});

// ============================================================================
// Two-Factor Authentication Schema (Phase 3)
// ============================================================================

export const smtpTlsSchema = z.object({
  rejectUnauthorized: z.boolean().default(true),
  minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).default('TLSv1.2')
});

export const smtpAuthSchema = z.object({
  user: z.string(),
  password: z.string()
});

export const smtpSchema = z.object({
  host: z.string(),
  port: z.number().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  auth: smtpAuthSchema,
  tls: smtpTlsSchema.optional()
});

export const twoFactorSchema = z.object({
  enabled: z.boolean().default(false),
  email: z.string().email().optional(),
  otpLength: z.number().min(4).max(8).default(6),
  otpExpiryMs: z.number().min(60000).max(600000).default(300000),
  smtp: smtpSchema.optional()
}).refine(
  (data) => !data.enabled || (data.email && data.smtp),
  { message: '2FA enabled requires email and smtp configuration' }
);

// ============================================================================
// Authentication Schema (Phase 2)
// ============================================================================

export const authSchema = z.object({
  password: z.string().default(''),
  durationMs: z.number().min(60000).max(86400000).default(1800000),
  maxDurationMs: z.number().min(60000).max(86400000).default(86400000),
  jwtSecret: z.string().default('')
});

// ============================================================================
// Rate Limiting Schema (Phase 5)
// ============================================================================

export const rateLimitSchema = z.object({
  windowMs: z.number().min(1000).max(3600000).default(60000),
  maxRequests: z.number().min(1).max(1000).default(100)
});

export const lockoutSchema = z.object({
  maxAttempts: z.number().min(1).max(20).default(5),
  lockoutDurationMs: z.number().min(60000).max(86400000).default(900000),
  progressiveDelay: z.boolean().default(true)
});

export const bruteForceSchema = z.object({
  rateLimit: rateLimitSchema,
  lockout: lockoutSchema
});

// ============================================================================
// Full Configuration Schema
// ============================================================================

export const configSchema = z.object({
  server: serverSchema,
  pty: ptySchema,
  session: sessionSchema,
  ssl: sslSchema.optional(),
  security: securitySchema.optional(),
  logging: loggingSchema.optional(),
  twoFactor: twoFactorSchema.optional(),
  auth: authSchema.optional(),
  bruteForce: bruteForceSchema.optional()
});

export type ConfigSchema = z.infer<typeof configSchema>;
