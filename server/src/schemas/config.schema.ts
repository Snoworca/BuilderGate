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
  maxBufferSize: z.number().min(1024).max(10485760).default(65536),
  shell: z.enum(['auto', 'powershell', 'wsl', 'bash', 'zsh', 'sh', 'cmd']).default('auto'),
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

export const totpSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: z.string().default('BuilderGate'),
  accountName: z.string().default('admin'),
});

export const twoFactorSchema = z.object({
  enabled: z.boolean().default(false),
  email: z.string().email().optional(),
  otpLength: z.number().min(4).max(8).default(6),
  otpExpiryMs: z.number().min(60000).max(600000).default(300000),
  smtp: smtpSchema.optional(),
  totp: totpSchema.optional(),
}).refine(
  (data) => {
    if (!data.enabled) return true;
    const hasEmail = !!(data.email && data.smtp);
    const hasTotp = !!(data.totp?.enabled);
    return hasEmail || hasTotp;
  },
  { message: '2FA enabled requires either email+smtp or totp configuration' }
);

// ============================================================================
// Authentication Schema (Phase 2)
// ============================================================================

export const authSchema = z.object({
  password: z.string().default(''),
  durationMs: z.number().min(60000).max(86400000).default(1800000),
  maxDurationMs: z.number().min(60000).max(86400000).default(86400000),
  jwtSecret: z.string().default(''),
  localhostPasswordOnly: z.boolean().default(false),
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
// File Manager Schema (Phase 4)
// ============================================================================

export const fileManagerSchema = z.object({
  maxFileSize: z.number().min(1024).max(104857600).default(1048576),
  maxCodeFileSize: z.number().min(1024).max(10485760).default(524288),
  maxDirectoryEntries: z.number().min(100).max(100000).default(10000),
  blockedExtensions: z.array(z.string()).default(['.exe', '.dll', '.so', '.bin']),
  blockedPaths: z.array(z.string()).default(['.ssh', '.gnupg', '.aws']),
  cwdCacheTtlMs: z.number().min(100).max(60000).default(1000),
});

// ============================================================================
// Workspace Schema (Step 7)
// ============================================================================

export const workspaceSchema = z.object({
  dataPath: z.string().default('./data/workspaces.json'),
  maxWorkspaces: z.number().min(1).max(50).default(10),
  maxTabsPerWorkspace: z.number().min(1).max(16).default(8),
  maxTotalSessions: z.number().min(1).max(128).default(32),
  flushDebounceMs: z.number().min(1000).max(30000).default(5000),
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
  bruteForce: bruteForceSchema.optional(),
  fileManager: fileManagerSchema.optional(),
  workspace: workspaceSchema.optional()
});

export type ConfigSchema = z.infer<typeof configSchema>;
