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

const defaultObject = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value === undefined ? {} : value, schema);

export const realtimeSchema = defaultObject(z.object({
  wsTransportMode: z.enum(['unified', 'split-shadow', 'split']).default('unified'),
}).strict());

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

export const sessionProcessCleanupSchema = defaultObject(z.object({
  mode: z.enum(['legacy', 'observe', 'enforce']).default('observe'),
  gracefulWaitMs: z.number().int().min(0).max(60000).default(750),
  forceWaitMs: z.number().int().min(0).max(60000).default(1500),
  descendantSampleLimit: z.number().int().min(1).max(4096).default(64),
}).strict());

export const sessionSchema = z.object({
  idleDelayMs: z.number().min(50).max(5000).default(200),
  runningDelayMs: z.number().min(0).max(2000).default(250),
  processCleanup: sessionProcessCleanupSchema,
});

// ============================================================================
// Runtime Resource Limit Schemas
// ============================================================================

const bytesLimit = (min: number, max: number, defaultValue: number) =>
  z.number().int().min(min).max(max).default(defaultValue);

const countLimit = (min: number, max: number, defaultValue: number) =>
  z.number().int().min(min).max(max).default(defaultValue);

const durationLimit = (min: number, max: number, defaultValue: number) =>
  z.number().int().min(min).max(max).default(defaultValue);

export const headlessResourceLimitsSchema = defaultObject(z.object({
  pendingOutputMaxBytes: bytesLimit(1024, 268435456, 8388608),
  pendingOutputMaxChunks: countLimit(1, 65536, 1024),
  writeLagWarnMs: durationLimit(1, 60000, 500),
  writeBatchMaxBytes: bytesLimit(1024, 1048576, 65536),
  overflowPolicy: z.literal('degrade-headless').default('degrade-headless'),
}).strict());

export const wsResourceLimitsSchema = defaultObject(z.object({
  serverBufferedHighWaterBytes: bytesLimit(1024, 268435456, 8388608),
  serverBufferedHardLimitBytes: bytesLimit(1024, 536870912, 33554432),
  perClientOutputQueueMaxBytes: bytesLimit(1024, 268435456, 2097152),
  perClientControlQueueMaxBytes: bytesLimit(1024, 16777216, 262144),
  outputCoalesceWindowMs: durationLimit(1, 1000, 16),
}).strict()).superRefine((value, ctx) => {
  if (value.serverBufferedHardLimitBytes <= value.serverBufferedHighWaterBytes) {
    ctx.addIssue({
      code: 'custom',
      path: ['serverBufferedHardLimitBytes'],
      message: 'serverBufferedHardLimitBytes must be greater than serverBufferedHighWaterBytes',
    });
  }
});

export const clientWsResourceLimitsSchema = defaultObject(z.object({
  inputBackpressureBytes: bytesLimit(1024, 268435456, 1048576),
  hardReconnectBytes: bytesLimit(1024, 536870912, 4194304),
}).strict()).superRefine((value, ctx) => {
  if (value.hardReconnectBytes <= value.inputBackpressureBytes) {
    ctx.addIssue({
      code: 'custom',
      path: ['hardReconnectBytes'],
      message: 'hardReconnectBytes must be greater than inputBackpressureBytes',
    });
  }
});

export const terminalResourceLimitsSchema = defaultObject(z.object({
  visibleOutputQueueMaxBytes: bytesLimit(1024, 268435456, 4194304),
  visibleOutputMaxChunks: countLimit(1, 65536, 512),
  visibleFlushBudgetBytes: bytesLimit(1024, 16777216, 262144),
  hiddenOutputPolicy: z.enum(['write-hidden', 'snapshot-restore', 'debug-tail']).default('write-hidden'),
  hiddenOutputTailBytes: bytesLimit(0, 16777216, 262144),
  inputQueueMaxBytes: bytesLimit(1024, 16777216, 65536),
  inputQueueTtlMs: durationLimit(1, 60000, 1500),
  transportOutboxMaxBytes: bytesLimit(1024, 16777216, 65536),
  transportOutboxTtlMs: durationLimit(1, 60000, 1500),
  scrollbackLines: countLimit(0, 50000, 10000),
}).strict());

export const snapshotResourceLimitsSchema = defaultObject(z.object({
  perSnapshotMaxChars: countLimit(1024, 50000000, 2000000),
  totalStorageBudgetChars: countLimit(1024, 200000000, 3000000),
  maxEntries: countLimit(1, 1024, 16),
  tombstoneTtlMs: durationLimit(1000, 604800000, 86400000),
}).strict()).superRefine((value, ctx) => {
  if (value.totalStorageBudgetChars < value.perSnapshotMaxChars) {
    ctx.addIssue({
      code: 'custom',
      path: ['totalStorageBudgetChars'],
      message: 'totalStorageBudgetChars must be greater than or equal to perSnapshotMaxChars',
    });
  }
});

export const workspaceRuntimeResourceLimitsSchema = defaultObject(z.object({
  maxLiveWorkspaces: countLimit(1, 10, 3),
  maxLiveTerminals: countLimit(1, 128, 12),
  hiddenRuntimeTtlMs: durationLimit(1000, 3600000, 60000),
}).strict());

export const telemetryResourceLimitsSchema = defaultObject(z.object({
  sampleIntervalMs: durationLimit(1000, 3600000, 60000),
  recentEventLimit: countLimit(1, 10000, 256),
}).strict());

export const resourceLimitsSchema = defaultObject(z.object({
  headless: headlessResourceLimitsSchema,
  ws: wsResourceLimitsSchema,
  clientWs: clientWsResourceLimitsSchema,
  terminal: terminalResourceLimitsSchema,
  snapshots: snapshotResourceLimitsSchema,
  workspaceRuntime: workspaceRuntimeResourceLimitsSchema,
  telemetry: telemetryResourceLimitsSchema,
}).strict());

export const stabilityModesSchema = defaultObject(z.object({
  headlessQueueMode: z.enum(['observe', 'bounded']).default('observe'),
  wsSendMode: z.enum(['direct', 'safe-send-observe', 'safe-send-enforce']).default('direct'),
  frontendRuntimeResidency: z.enum(['legacy', 'bounded', 'off']).default('legacy'),
}).strict());

// ============================================================================
// Two-Factor Authentication Schema (Phase 3)
// ============================================================================

export const twoFactorSchema = z.object({
  enabled: z.boolean().default(false),
  externalOnly: z.boolean().default(false),
  issuer: z.string().default('BuilderGate'),
  accountName: z.string().default('admin'),
});

export const bootstrapSchema = z.object({
  allowedIps: z.array(z.string()).default([]),
});

// ============================================================================
// Authentication Schema (Phase 2)
// ============================================================================

export const authSchema = z.object({
  password: z.preprocess((value) => {
    if (value == null) {
      return '';
    }
    return value;
  }, z.string()).default(''),
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
  realtime: realtimeSchema,
  resourceLimits: resourceLimitsSchema,
  stabilityModes: stabilityModesSchema,
  ssl: sslSchema.optional(),
  security: securitySchema.optional(),
  logging: loggingSchema.optional(),
  twoFactor: twoFactorSchema.optional(),
  bootstrap: bootstrapSchema.optional(),
  auth: authSchema.optional(),
  bruteForce: bruteForceSchema.optional(),
  fileManager: fileManagerSchema.optional(),
  workspace: workspaceSchema.optional()
});

export type ConfigSchema = z.infer<typeof configSchema>;
