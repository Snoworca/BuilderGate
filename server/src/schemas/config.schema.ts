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
// Server Schema
// ============================================================================

export const serverSchema = z.object({
  port: z.number().min(1).max(65535).default(2002)
});

const defaultObject = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value === undefined ? {} : value, schema);

export const realtimeSchema = defaultObject(z.object({
  wsTransportMode: z.enum(['unified', 'split-shadow', 'split']).default('unified'),
  // The binary data-plane rollout ladder (05 §8.2), orthogonal to the transport
  // mode above. `json` keeps the wire exactly as it is today, so a deployment
  // that never sets this behaves as it always has.
  terminalWireFormat: z.enum(['json', 'binary-shadow', 'binary-optin', 'binary']).default('json'),
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
  identityProbeTimeoutMs: z.number().int().min(100).max(60000).default(10000),
}).strict());

export const sessionSchema = z.object({
  idleDelayMs: z.number().min(50).max(5000).default(200),
  runningDelayMs: z.number().min(0).max(2000).default(250),
  processCleanup: sessionProcessCleanupSchema,
  // FR-BGSTAB-020: Codex 감지 세션에 tui 억제 -c 설정 주입 여부 (기본 off — 감지 오탐 위험 완화).
  codexTuiSuppression: z.boolean().default(false),
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
  // #101: the frame deadline the visible flush loop enforces. Its byte sibling above was
  // operator-tunable and this was not, so the 7ms default could not be moved at all.
  visibleFlushFrameBudgetMs: durationLimit(1, 100, 7),
  checkpointMaxBytes: bytesLimit(1024, 268435456, 4194304),
  // #70: the chunk half of the checkpoint budget. It used to resolve to the post-checkpoint
  // hold cap because the only production caller passed just that one, which is the same shape
  // REL-BGSTAB-023 fixed on the byte axis. The default is what it used to inherit.
  checkpointMaxChunks: countLimit(1, 65536, 512),
  // #78: the size of one checkpoint chunk. It was the hardcoded constant
  // TERMINAL_CHECKPOINT_CHUNK_BYTES, and #26 measured checkpoints crossing the browser's
  // acceptance limit on wide terminals with no way to adjust it. The default is that constant.
  checkpointChunkBytes: bytesLimit(1024, 16777216, 65536),
  hiddenOutputPolicy: z.enum(['write-hidden', 'snapshot-restore', 'debug-tail']).default('snapshot-restore'),
  hiddenOutputTailBytes: bytesLimit(0, 16777216, 262144),
  inputQueueMaxBytes: bytesLimit(1024, 16777216, 65536),
  // #72: input scope had bytes and a TTL but no COUNT, so the pending-input cap and the
  // settlement ledger cap borrowed the OUTPUT chunk cap -- an operator tuning output chunking
  // downward silently lowered how many inputs may be pending. The default is what they used
  // to inherit.
  inputQueueMaxCount: countLimit(1, 65536, 512),
  inputQueueTtlMs: durationLimit(1, 60000, 1500),
  transportOutboxMaxBytes: bytesLimit(1024, 16777216, 65536),
  transportOutboxTtlMs: durationLimit(1, 60000, 1500),
  scrollbackLines: countLimit(0, 50000, 10000),
  // SEC-BGSTAB-001: OSC52 clipboard 정책. 스위치는 쓰기 하나뿐이고 읽기 스위치는
  // 의도적으로 없다. 읽기 응답은 PTY 의 input 채널로 주입되므로 사용자가 마지막으로
  // 복사한 것 -- 이 사용자 집단에서는 대개 키나 토큰 -- 에 대한 직접적인 유출
  // 원시수단이고, 설정으로 두면 에이전트가 켜도록 설득당할 수 있다. 아래 .strict()
  // 덕분에 allowRead 같은 키는 조용히 무시되는 것이 아니라 거부된다 -- 즉 '읽기를
  // 켜는 설정' 은 어떤 stability 에서도 구조적으로 만들어질 수 없다.
  osc52: defaultObject(z.object({
    allowWrite: z.boolean().default(true),
  }).strict()),
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
  maxLiveWorkspaces: countLimit(1, 10, 10),
  maxLiveTerminals: countLimit(1, 128, 32),
  hiddenRuntimeTtlMs: durationLimit(1000, 3600000, 600000),
}).strict());

export const telemetryResourceLimitsSchema = defaultObject(z.preprocess((value) => {
  // FR-BGSTAB-025: retire only this known legacy key; keep all other strict validation.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'sampleIntervalMs')) {
    const { sampleIntervalMs: _retired, ...active } = value as Record<string, unknown>;
    return active;
  }
  return value;
}, z.object({
  recentEventLimit: countLimit(1, 10000, 256),
}).strict()));

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
  frontendRuntimeResidency: z.enum(['legacy', 'bounded', 'off']).default('bounded'),
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
  jwtSecret: z.string().default(''),
  localhostPasswordOnly: z.boolean().default(false),
});

// ============================================================================
// File Manager Schema (Phase 4)
// ============================================================================

export const fileManagerSchema = z.object({
  maxFileSize: z.number().min(1024).max(104857600).default(1048576),
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
  terminalTitleDebounceMs: z.number().int().min(0).max(5000).default(250),
  restoreInputDelayMs: z.number().int().min(0).max(10000).default(600),
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
  twoFactor: twoFactorSchema.optional(),
  bootstrap: bootstrapSchema.optional(),
  auth: authSchema.optional(),
  fileManager: fileManagerSchema.optional(),
  workspace: workspaceSchema.optional()
});

export type ConfigSchema = z.infer<typeof configSchema>;
