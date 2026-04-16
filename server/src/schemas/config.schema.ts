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
  port: z.number().min(1).max(65535).default(2002)
});

// ============================================================================
// PTY Schema
// ============================================================================

const ptySchemaInput = z.object({
  termName: z.string().default('xterm-256color'),
  defaultCols: z.number().min(20).max(500).default(80),
  defaultRows: z.number().min(5).max(200).default(24),
  useConpty: z.boolean().default(false),
  windowsPowerShellBackend: z.enum(['inherit', 'conpty', 'winpty']).default('inherit'),
  scrollbackLines: z.number().int().min(0).max(50000).default(1000),
  maxSnapshotBytes: z.number().int().min(1024).max(268435456).optional(),
  maxBufferSize: z.number().int().min(1024).max(268435456).optional(),
  shell: z.enum(['auto', 'powershell', 'wsl', 'bash', 'zsh', 'sh', 'cmd']).default('auto'),
});

export const ptySchema = ptySchemaInput.transform(({ maxBufferSize, maxSnapshotBytes, ...pty }) => ({
  ...pty,
  maxSnapshotBytes: maxSnapshotBytes ?? maxBufferSize ?? 2097152,
}));

// ============================================================================
// Session Schema
// ============================================================================

export const sessionSchema = z.object({
  idleDelayMs: z.number().min(50).max(5000).default(200)
});

// ============================================================================
// Two-Factor Authentication Schema (Phase 3)
// ============================================================================

export const twoFactorSchema = z.object({
  enabled: z.boolean().default(false),
  externalOnly: z.boolean().default(false),
  issuer: z.string().default('BuilderGate'),
  accountName: z.string().default('admin'),
});

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
