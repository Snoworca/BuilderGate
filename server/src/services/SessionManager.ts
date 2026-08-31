import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, watchFile, unwatchFile, readFileSync, existsSync, statSync } from 'fs';
import { execFile, execFileSync, execSync } from 'child_process';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Session, SessionDTO, SessionStatus, UpdateSessionRequest, ShellType, ShellInfo } from '../types/index.js';
import type {
  HeadlessResourceLimitsConfig,
  PTYConfig,
  ResourceLimitsConfig,
  SessionConfig,
  SessionProcessCleanupConfig,
  StabilityModesConfig,
  WindowsPowerShellBackend as PowerShellBackendPolicy,
} from '../types/config.types.js';
import {
  headlessResourceLimitsSchema,
  stabilityModesSchema,
} from '../schemas/config.schema.js';
import { config } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import {
  createHeadlessTerminalState,
  compareRetainedHeadlessCheckpointRoundTrip,
  disposeHeadlessTerminal,
  markRetainedHeadlessSourceSequence,
  readRetainedHeadlessBufferMetrics,
  serializeHeadlessScreenRepair,
  resizeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  serializeHeadlessTerminal,
  type HeadlessScreenRepairResult,
  type HeadlessTerminalState,
  type RetainedHeadlessCheckpoint,
  type RetainedHeadlessComparisonAxes,
  writeHeadlessTerminal,
} from '../utils/headlessTerminal.js';
import {
  createHeadlessOutputQueue,
  type HeadlessOutputQueue,
  type HeadlessOutputQueueSnapshot,
} from '../utils/headlessOutputQueue.js';
import { truncateTerminalPayloadTail } from '../utils/terminalPayload.js';
import { advanceTerminalPartialEscapeTail } from '../utils/terminalPartialEscapeTail.js';
import { TerminalTitleDetector } from '../utils/terminalTitle.js';
import { getRecoveryExecutableToken, normalizeRecoveryExecutable, type RecoveryRestoreShell } from '../utils/recoveryCommand.js';
import type { WsRouter } from '../ws/WsRouter.js';
import type { TerminalResourcePolicyLeaseAuthority } from './TerminalResourcePolicyCanary.js';
import { terminalResourcePolicyRuntimeAuthority } from './TerminalResourcePolicyRuntime.js';
import {
  compileTerminalResourcePolicy,
  LEGACY_TERMINAL_RESOURCE_POLICY_ID,
  TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
  TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
  type CompiledTerminalResourcePolicy,
} from './TerminalResourcePolicy.js';
import { OscDetector } from './OscDetector.js';
import {
  advanceRetainedTerminalOrdinal,
  isCanonicalOrdinal64,
  type Ordinal64,
  type WindowsPtyInfo,
} from '../types/ws-protocol.js';
import type {
  FallbackDataState,
  InputDebugMetadata,
  ScreenRepairBufferType,
  SessionCleanupReason,
  SessionCleanupStatus,
  SessionCleanupTelemetry,
  SessionCleanupTelemetryResult,
  SessionProcessBackend,
  SessionProcessMetadata,
  WindowsPtyBackend,
} from '../types/ws-protocol.js';
import {
  normalizePtyConfigForPlatform,
  normalizeShellForPlatform,
} from '../utils/ptyPlatformPolicy.js';
import {
  DefaultProcessTreeTerminator,
  readProcessStartIdentity,
  type ProcessTreeTerminationResult,
  type ProcessTreeTerminator,
} from '../utils/processTreeTerminator.js';
import {
  buildInputDebugDetails,
  formatSafeInputPreview,
  type InputDebugValue,
} from '../utils/inputDebugMetadata.js';
import { createSessionInputGateway } from './SessionInputGateway.js';
import type {
  TerminalAuthorityController,
  TerminalAuthorityIngestOwner,
  TerminalAuthorityPromotionRequest,
  TerminalAuthorityPromotionResult,
  TerminalAuthorityResponderIdentity,
  TerminalAuthorityState,
} from './TerminalAuthorityController.js';
import type {
  DriverViewAttributesPushIdentity,
  TerminalQueryResponder,
  TerminalViewAttributes,
} from '../utils/terminalQueryResponder.js';
import {
  ForegroundAppDetectorRegistry,
  createInitialDerivedState,
  deriveDisplayStatus,
  type DetectionMode,
  type ForegroundAppObservation,
  type SessionDerivedState,
  type SessionShellType,
} from './ForegroundAppDetector.js';
import {
  createTerminalStreamEpochLedger,
  type StreamEpochBumpReason,
} from '../ws/terminalStreamEpoch.js';
import { HermesForegroundDetector } from './HermesForegroundDetector.js';

interface EchoTracker {
  /** writeInput이 호출된 시각 (ms, Date.now) */
  lastInputAt: number;
  /** 최근 제출되지 않은 printable draft. prompt redraw 뒤의 지연 echo 상관관계에만 사용한다. */
  lastUnsubmittedPrintableInput?: {
    value: string;
  };
  /** 현재 PTY chunk 앞에서 확인된 미완성 local-echo prefix. */
  unsubmittedPrintableEchoPrefix?: string;
  /** 제어 시퀀스 없이 split된 draft prefix를 suffix까지 짧게 보류하는 one-shot correlation. */
  deferredUnsubmittedPrintableEcho?: {
    token: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  /** Ctrl+C로 visible input이 취소된 뒤에도 한 번만 정산할 수 있는 이미-pending local draft. */
  interruptedUnsubmittedPrintableInput?: {
    value: string;
  };
  /** Ctrl+C 뒤 one-shot local-echo의 현재 PTY chunk 앞 prefix. */
  interruptedUnsubmittedPrintableEchoPrefix?: string;
  /** 상태 분류 전에 다음 PTY chunk와 결합해야 하는 incomplete ANSI tail. */
  statusEscapeTailAnsi?: string;
  /** 마지막 입력 데이터의 바이트 길이 */
  recentInputs: Array<{
    at: number;
    hasEnter: boolean;
    inputClass: string;
  }>;
  /** 마지막 입력에 Enter(\r 또는 \n) 포함 여부 */
  lastInputHasEnter: boolean;
  /** 마지막 입력이 명령 제출 없이 Ctrl+C interrupt였는지 */
  lastInputWasControlInterrupt: boolean;
}

type HeadlessHealth = 'healthy' | 'degraded';
type HeadlessDegradedPhase = 'create' | 'write' | 'resize' | 'serialize' | 'queue-overflow';
type SnapshotPayloadScope = 'viewport-only';

const SNAPSHOT_PAYLOAD_SCOPE: SnapshotPayloadScope = 'viewport-only';

interface SessionSnapshotCache {
  seq: number;
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
  generatedAt: number;
  dirty: boolean;
  scope: SnapshotPayloadScope;
}

interface SessionScreenSnapshot {
  seq: number;
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
  generatedAt: number;
  health: HeadlessHealth;
  fallbackDataState?: FallbackDataState;
  fallbackDataBytes?: number;
  windowsPty?: WindowsPtyInfo;
  authorityEpoch: string;
  authorityRevision?: number;
  parserComplete?: boolean;
  pendingEscapeTailAnsi?: string;
}

export type AtomicRestoreSnapshotResult =
  | { ok: false; reason: 'headless-degraded' | 'generation-failed' }
  | {
      ok: true;
      payload: {
        authorityEpoch: string;
        authorityRevision: number;
        snapshotSeq: number;
        parserComplete: boolean;
        pendingEscapeTailAnsi: string;
        serializedData: string;
        cols: number;
        rows: number;
        truncated: boolean;
        generatedAt: number;
        health: 'healthy';
        windowsPty?: WindowsPtyInfo;
      };
    };

interface DeferredSignal<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface EventLoopDelayObservability {
  mean: number;
  p99: number;
}

interface SessionManagerObservability {
  totalSessions: number;
  healthySessions: number;
  degradedSessions: number;
  headlessOutput: HeadlessOutputObservability;
  cleanup: SessionCleanupTelemetry;
  snapshotRequests: number;
  snapshotCacheHits: number;
  snapshotSerializeFailures: number;
  snapshotFallbacks: number;
  oversizedSnapshots: number;
  totalSnapshotBytes: number;
  maxSnapshotBytesObserved: number;
  totalSnapshotSerializeMs: number;
  maxSnapshotSerializeMs: number;
  headlessWriteCumulativeMs: number;
  eventLoopDelay: EventLoopDelayObservability;
  processCpuPercentOfOneCore: number;
}

type SessionDebugCaptureValue = string | number | boolean | null;

interface SessionDebugCaptureEvent {
  eventId: number;
  recordedAt: string;
  sessionId: string;
  source: 'pty' | 'snapshot' | 'headless' | 'detector';
  kind: string;
  details?: Record<string, SessionDebugCaptureValue>;
  preview?: string;
}

const LEGACY_TRUNCATED_REPLAY_PLACEHOLDER = '\r\n[BuilderGate] Screen snapshot exceeded maxSnapshotBytes. Waiting for new output...\r\n';
const LEGACY_DEGRADED_REPLAY_PLACEHOLDER = '\r\n[BuilderGate] Server snapshot is unavailable for this session. Using fallback recovery when possible...\r\n';
const MAX_DEBUG_CAPTURE_EVENTS = 400;
const DEBUG_CAPTURE_PREVIEW_CHARS = 320;
const DEBUG_INPUT_CORRELATION_WINDOW_MS = 500;
const DEBUG_INPUT_SAMPLE_LIMIT = 8;
const MAX_RESIZE_REPLAY_DELAY_MS = 400;
const RESIZE_REPLAY_QUIET_WINDOW_MS = 120;
const SCREEN_REPAIR_HEADLESS_DRAIN_TIMEOUT_MS = 250;
const SCREEN_REPAIR_HEADLESS_QUIET_WINDOW_MS = 50;
const SCREEN_REPAIR_HEADLESS_POLL_INTERVAL_MS = 10;
const DEFAULT_RUNNING_DELAY_MS = 250;
const CLEANUP_RECENT_RESULTS_LIMIT = 64;
const CLEANUP_DEDUP_SESSION_LIMIT = 4096;
const RETAINED_SHADOW_COMPARISON_DEBOUNCE_MS = 16;
const RETAINED_SHADOW_COMPARISON_BUSY_RETRY_MS = 50;
const RETAINED_SHADOW_COMPARISON_MIN_INTERVAL_MS = 5_000;
const RETAINED_LEDGER_MIN_RECORDS = 64;
const RETAINED_LEDGER_MAX_RECORDS = 4_096;
const RETAINED_FACTS_PER_RECORD = 8;
const RETAINED_FACT_SEMANTIC_KEY_MAX_BYTES = 1_024;
const RETAINED_LEDGER_RECORD_MAX_ENCODED_BYTES = 512;
const RETAINED_LEDGER_FACT_MAX_ENCODED_BYTES = 2_048;
const RETAINED_LEDGER_FACT_KEY_MAX_ENCODED_BYTES = 96;
const RETAINED_OSC133_STATUS_FACTS: Readonly<Record<string, string>> = Object.freeze({
  '133;A': 'prompt-start',
  '133;B': 'prompt-end',
  '133;C': 'command-start',
  '133;D': 'command-end',
});
const DEFAULT_SESSION_PROCESS_CLEANUP: SessionProcessCleanupConfig = {
  mode: 'observe',
  gracefulWaitMs: 750,
  forceWaitMs: 1500,
  descendantSampleLimit: 64,
  identityProbeTimeoutMs: 3000,
};

// OBS-BGSTAB-003: a single shared event-loop delay histogram, created and enabled
// once at module load, so telemetry snapshots can sample mean/p99 cheaply without
// paying per-instance monitoring overhead (see risk R-03). mean/p99 are cumulative
// since boot; windowed reset is out of scope here (deferred with the saturation
// threshold open question OQ-02).
const eventLoopDelayHistogram: IntervalHistogram = monitorEventLoopDelay();
eventLoopDelayHistogram.enable();

// OBS-BGSTAB-003: minimum real-time window between process CPU% re-samplings. The
// telemetry endpoint and the periodic observability logger both read the snapshot,
// so throttling the baseline advance keeps every reader on one meaningful window
// instead of shrinking each other's delta window down to noise.
const CPU_SAMPLE_MIN_INTERVAL_MS = 250;
const IDENTITY_CAPTURE_RETRY_BACKOFFS_MS = [200, 400, 800, 1_600, 3_200, 6_400] as const;
/** Interval once the ramp above is spent. Retries continue while the session lives. */
const IDENTITY_CAPTURE_RETRY_INTERVAL_MS = 30_000;
const INPUT_ECHO_TIME_THRESHOLD_MS = 50;
const BARE_ECHO_CONFIRMATION_DELAY_MS = 80;
const AI_TUI_SUBMITTED_ECHO_THRESHOLD_MS = 1000;
const AI_TUI_DECORATIVE_FRAME_RE = /^[\s─╰╯│┃┆┄┈┊·•]+$/;
const AI_TUI_CURSOR_MOTION_RE = /\x1b\[[0-9;?]*[ABCDHJKfhlmnpsu]/;
const SHELL_INTEGRATION_ROOT_ENV_KEY = 'BUILDERGATE_SHELL_INTEGRATION_ROOT';

type ForegroundAppId = 'hermes' | 'codex' | 'claude';

interface AiTuiLaunchAttempt {
  appId: ForegroundAppId;
  command: string;
  executable: string;
  startedAt: number;
}

interface DerivedStateSyncOptions {
  preservePendingRunningTransition?: boolean;
}

interface HeadlessOutputObservability {
  pendingBytes: number;
  pendingChunks: number;
  maxPendingBytes: number;
  maxPendingChunks: number;
  oldestPendingAgeMs: number;
  overflowCount: number;
  degradedCount: number;
  degradedReplayBufferBytes: number;
  degradedReplayTruncatedSessions: number;
  recoverableFallbackSessions: number;
  emptyFallbackSessions: number;
  queueOverflowDegradedCount: number;
  lastDegradedPhase: HeadlessDegradedPhase | null;
}

interface SessionProcessInspection {
  status: SessionCleanupStatus;
  remainingDescendants?: number;
  verifiedRemainingDescendants?: number;
  unverifiedRemainingDescendants?: number;
}

type SessionProcessInspector = (
  metadata: SessionProcessMetadata,
  descendantSampleLimit: number,
) => SessionProcessInspection;

type ReadProcessStartIdentity = typeof readProcessStartIdentity;

interface SessionManagerDeps {
  execFileFn?: typeof execFile;
  execFileSyncFn?: typeof execFileSync;
  platform?: NodeJS.Platform;
  spawnPty?: typeof pty.spawn;
  processInspector?: SessionProcessInspector;
  processTreeTerminator?: ProcessTreeTerminator;
  readProcessStartIdentityFn?: ReadProcessStartIdentity;
  terminalResourcePolicyAuthority?: TerminalResourcePolicyLeaseAuthority;
  retainedTerminalShadowEnabled?: boolean;
  retainedTerminalInitialOrdinal?: { streamEpoch: string; sourceSeq: string };
  createHeadlessTerminalStateFn?: typeof createHeadlessTerminalState;
  writeHeadlessTerminalFn?: typeof writeHeadlessTerminal;
  compareRetainedHeadlessCheckpointRoundTripFn?: typeof compareRetainedHeadlessCheckpointRoundTrip;
  retainedTerminalShadowProjectionMutator?: {
    mutate(sessionId: string, projection: RetainedTerminalAuthorityState): RetainedTerminalAuthorityState;
  };
  retainedTerminalModelFaultInjector?: { shouldDegrade(sessionId: string): boolean };
}

interface SessionManagerInitialConfig {
  pty: PTYConfig;
  session: SessionConfig;
  resourceLimits?: ResourceLimitsConfig;
  stabilityModes?: StabilityModesConfig;
}

interface RuntimeHeadlessQueueConfig {
  mode: StabilityModesConfig['headlessQueueMode'];
  limits: HeadlessResourceLimitsConfig;
}

interface PendingHeadlessOutput {
  id: number;
  data: string;
  byteLength: number;
  queuedAt: number;
  queued: boolean;
  policyGeneration?: number;
  exactlyOnceKey?: string;
  expiresAt?: number;
  ready?: boolean;
  recoveryGeneration?: number;
  policyAdmissionMode?: 'candidate' | 'legacy';
  retainedSemanticData?: string;
  terminalAuthorityRecordId?: string;
  ingestOwnerToken?: TerminalAuthorityIngestOwner;
}

interface PendingTerminalAuthorityQueryEffect {
  recordId: string;
  replyOrdinal: number;
  reply: string;
  streamEpoch: string;
  responderLeaseId: string;
}

interface TerminalAuthorityDebugIsolationState {
  cleanupToken: string;
  isolationLeaseId: string;
  desiredMode: 'legacy' | 'server';
  transitionPolicy: string;
  retainedScrollbackOverride: number | null;
  originalRetainedScrollbackLines: number;
  retainedCorpusFixture: boolean;
  alternateBufferFixture: boolean;
  queryPtyReplyCount: number;
  lastQueryReply: string | null;
  rollbackPostBoundaryOutput: string | null;
  originalAuthorityMode: TerminalAuthorityState['mode'];
  originalAuthorityStreamEpoch: string;
  originalCheckpoint: RetainedHeadlessCheckpoint & { pendingEscapeTailAnsi: string };
  originalParserComplete: boolean;
  cleanupInProgress: boolean;
  promotionInProgress: boolean;
  originalRetainedLedger: {
    streamEpoch: string;
    sourceSeq: string;
    snapshotSeq: string;
    oldestRetainedSeq: string;
    oldestRetainedStreamEpoch: string;
    records: RetainedTerminalOperationRecord[];
    facts: RetainedTerminalFact[];
    committedFactKeys: Set<string>;
    factOrdinal: number;
    factScannerTail: string;
    evictedRecords: number;
    evictedFacts: number;
    ledgerEncodedBytes: number;
    ledgerRecordEncodedBytes: number;
    ledgerFactEncodedBytes: number;
    ledgerFactKeyEncodedBytes: number;
    blockers: Set<string>;
    comparer: RetainedTerminalSessionState['comparer'];
    lastCheckpoint: RetainedTerminalSessionState['lastCheckpoint'];
    totalLogicalRowsObserved: number;
    eviction: RetainedTerminalSessionState['eviction'];
  };
}

type TerminalAuthorityDebugResourceInventory = {
  retainedPolicyOverrides: number;
  cleanupTokens: number;
  isolationLeases: number;
  retainedCorpusFixtures: number;
  alternateBufferFixtures: number;
  responderOverrides: number;
  listeners: number;
  driverLeases: number;
  responderLeases: number;
  timers: number;
  faultStates: number;
  queryEffectLedgers: number;
  heldOutputQueues: number;
};

function createTerminalAuthorityDebugRestoredEvidence(): Record<string, true> {
  return {
    sessionLocalRetainedPolicy: true,
    retainedCorpus: true,
    alternateBufferFixture: true,
    responderMode: true,
    listeners: true,
    driverAndResponderLeases: true,
    timers: true,
    faultState: true,
  };
}

export interface TerminalAuthoritySessionRuntime {
  controller: TerminalAuthorityController;
  queryResponder: TerminalQueryResponder;
  dispose(): void;
}

export interface TerminalAuthorityRuntimeFactoryInput {
  sessionId: string;
  authorityEpoch: string;
  sessionGeneration: string;
  initialStreamEpoch: string;
  runtimeInstanceGeneration: number;
  headlessState: HeadlessTerminalState;
  processMetadata: SessionProcessMetadata;
  windowsPty?: WindowsPtyInfo;
}

export type TerminalAuthorityRuntimeFactory = (
  input: TerminalAuthorityRuntimeFactoryInput,
) => TerminalAuthoritySessionRuntime;

export interface TerminalResourcePolicyHeadlessAdmissionDecision {
  mode: 'candidate' | 'legacy';
  reason: string;
  outputMaxBytes: number;
  outputMaxChunks: number;
  admissionMode: 'candidate' | 'legacy';
  policyGeneration: number;
  exactlyOnceKey: string;
  record(result: { ok: boolean; reason?: 'byte-limit' | 'chunk-limit' }): void;
  settleFailure(reason: 'headless-write-failed'): void;
}

export interface TerminalResourcePolicyHeadlessAdmissionPort {
  decide(input: {
    sessionId: string;
    rawData: string;
    pendingBytes: number;
    pendingChunks: number;
    pendingBytesByPolicyGeneration: ReadonlyMap<number, number>;
    pendingChunksByPolicyGeneration: ReadonlyMap<number, number>;
    pendingLegacyBytesByPolicyGeneration: ReadonlyMap<number, number>;
    pendingLegacyChunksByPolicyGeneration: ReadonlyMap<number, number>;
  }): TerminalResourcePolicyHeadlessAdmissionDecision | undefined;
}

export interface TerminalResourcePolicyHeadlessDrainBoundary {
  readonly sessionId: string;
  readonly outputIds: readonly number[];
}

interface PendingRestoreInput {
  input: string;
  guard?: () => boolean;
  queuedAt: number;
}

type RetainedProjectionAxis = 'match' | 'mismatch' | 'unavailable';

interface RetainedTerminalOperationRecord {
  streamEpoch: string;
  sourceSeq: string;
  kind: 'output' | 'resize';
  modelCommitted: boolean;
  deliveryCreatedAfterCommit: boolean;
  rejectionReason?: 'model-degraded' | 'queue-overflow' | 'commit-failed';
}

interface RetainedTerminalFact {
  kind: string;
  semanticKey: string;
  streamEpoch: string;
  sourceSeq: string;
  ordinal: number;
  disposition: 'committed' | 'duplicate' | 'rejected';
}

interface RetainedTerminalClientView {
  clientId: string;
  viewGeneration: number;
  slow: boolean;
  pendingBytes: number;
  blocksModel: false;
  dataGapRequired: boolean;
  restoreNeeded: boolean;
  ready: boolean;
}

interface RetainedTerminalSettlement {
  admissionOpen: boolean;
  settled: boolean;
  factLedgerSettlements: number;
  checkpointLedgerSettlements: number;
  timerSettlements: number;
}

interface RetainedTerminalSessionState {
  mode: 'shadow' | 'disabled';
  streamEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  oldestRetainedStreamEpoch: string;
  records: RetainedTerminalOperationRecord[];
  facts: RetainedTerminalFact[];
  committedFactKeys: Set<string>;
  factOrdinal: number;
  factScannerTail: string;
  evictedRecords: number;
  evictedFacts: number;
  ledgerEncodedBytes: number;
  ledgerRecordEncodedBytes: number;
  ledgerFactEncodedBytes: number;
  ledgerFactKeyEncodedBytes: number;
  blockers: Set<string>;
  comparer: {
    result: RetainedProjectionAxis;
    axes: RetainedHeadlessComparisonAxes;
  };
  comparisonTimer: NodeJS.Timeout | null;
  comparisonInFlight: boolean;
  comparisonPendingSourceSeq: string | null;
  lastComparisonStartedAtMs: number;
  lastCheckpoint: (RetainedHeadlessCheckpoint & { pendingEscapeTailAnsi: string }) | null;
  clients: Map<string, RetainedTerminalClientView>;
  driverLease: { ownerClientId: string | null; generation: string; state: 'unclaimed' | 'active' | 'revoked' };
  driverViewGeneration: number | null;
  nextLeaseGeneration: bigint;
  totalLogicalRowsObserved: number;
  eviction: {
    evictedRows: number;
    evictedBytes: number;
    reason: string | null;
    policyId: string;
    completeLogicalRowBoundary: boolean;
    dataGapRequired: boolean;
    restoreNeeded: boolean;
    staleViewReady: boolean;
  };
  cleanup: RetainedTerminalSettlement & { rejectedLateMessages: number };
  shadowSettlement: RetainedTerminalSettlement;
  authorityRuntime: TerminalAuthorityRuntimePortStateInternal;
}

interface TerminalAuthorityBrowserDriverBinding {
  clientId: string;
  viewGeneration: number;
  leaseGeneration: string;
}

interface TerminalAuthorityNoLocalCacheEvidence {
  transitionEpoch: string;
  cacheState: 'server-replay-ack';
  source: 'server-replay-ready-ack-zero-tail';
  localCacheUsed: false;
  serverCheckpointApplied: true;
  postSnapshotTailDrained: true;
  tailBytesAtAck: 0;
  acknowledgedViewCount: number;
}

interface TerminalAuthorityServerRecoveryAck {
  authorityEpoch: string;
  viewGeneration: number;
  replayToken: string;
  snapshotSeq: number;
  postSnapshotTailDrained: true;
}

interface TerminalAuthorityServerCheckpointDeliveryProof {
  sessionId: string;
  clientId: string;
  connectionId: string;
  viewGeneration: number;
  protocolVersion: 1;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  checkpointEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  retentionPolicyId: string;
  responderLeaseId: string;
  driverLeaseId: string;
  retainedStreamEpoch: string;
  retainedSourceSeq: string;
  boundarySourceSeq?: string;
}

interface TerminalAuthorityRuntimePortStateInternal {
  admission: {
    mode: 'legacy' | 'server' | 'none';
    transitionEpoch: string | null;
  };
  responder: {
    active: 'legacy-browser' | 'server-headless' | null;
    activeLeaseId: string | null;
    legacyEnabled: boolean;
    serverEnabled: boolean;
    revokedLeaseIds: Set<string>;
  };
  driver: {
    active: 'legacy-browser' | 'server-headless' | null;
    activeLeaseId: string | null;
    revokedLeaseIds: Set<string>;
  };
  suspendedBrowserDriver: TerminalAuthorityBrowserDriverBinding | null;
  serverRecoveryAcks: Map<string, TerminalAuthorityServerRecoveryAck>;
  serverCheckpointDeliveries: Map<string, TerminalAuthorityServerCheckpointDeliveryProof>;
  noLocalCacheEvidence: TerminalAuthorityNoLocalCacheEvidence | null;
  limitedSessionSelected: boolean;
  reconnectGeneration: number;
  recoveryRequiredReason: string | null;
}

export interface TerminalAuthorityRuntimePortState {
  admission: TerminalAuthorityRuntimePortStateInternal['admission'];
  responder: Omit<TerminalAuthorityRuntimePortStateInternal['responder'], 'revokedLeaseIds'> & {
    revokedLeaseIds: readonly string[];
  };
  driver: Omit<TerminalAuthorityRuntimePortStateInternal['driver'], 'revokedLeaseIds'> & {
    revokedLeaseIds: readonly string[];
  };
  suspendedBrowserDriver: TerminalAuthorityBrowserDriverBinding | null;
  limitedSessionSelected: boolean;
  noLocalCacheParityPrepared: boolean;
  reconnectGeneration: number;
  recoveryRequiredReason: string | null;
}

export interface TerminalAuthorityPromotionParitySnapshot {
  retainedStateParity: boolean;
  factParity: boolean;
  leaseParity: boolean;
  noLocalCacheParity: boolean;
  limitedSessionSelected: boolean;
  blockers: readonly string[];
  diagnosticBlockers: readonly string[];
}

export interface RetainedTerminalMutationIdentity {
  authorityEpoch: string;
  clientId: string;
  viewGeneration: number;
  leaseGeneration: string;
}

interface RetainedTerminalAuthorityState {
  availability: 'available';
  mode: 'shadow' | 'disabled';
  streamEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  oldestRetainedStreamEpoch: string;
  retentionPolicy: {
    effectiveRetainedScrollbackLines: number;
    retentionPolicyId: string;
    source: string;
    sourceKind: string;
    conflictDetected: boolean;
  };
  checkpoint: ReturnType<typeof serializeRetainedHeadlessCheckpoint> & { pendingEscapeTailAnsi: string };
  budgets: Record<string, { key: string; unit: 'lines' | 'bytes'; value: number | null; source: string; configured: boolean }>;
  lastRecord: (RetainedTerminalOperationRecord & { kind: 'output' | 'resize' }) | null;
  records: readonly RetainedTerminalOperationRecord[];
  facts: readonly RetainedTerminalFact[];
  comparer: {
    result: 'match' | 'mismatch' | 'unavailable';
    deliveryAuthority: 'legacy' | 'server';
    failureBehavior: 'block-session-canary-only';
    axes: Record<'logicalLines' | 'cells' | 'unicodeWidth' | 'cursor' | 'modes' | 'activeBuffer' | 'parserTail' | 'eviction', RetainedProjectionAxis>;
  };
  canary: { eligible: boolean; blockers: readonly string[] };
  eviction: RetainedTerminalSessionState['eviction'];
  driverLease: RetainedTerminalSessionState['driverLease'];
  cleanup: RetainedTerminalSessionState['cleanup'];
  shadowSettlement: RetainedTerminalSettlement;
  clients: readonly RetainedTerminalClientView[];
  recovery: { authority: 'server' | 'legacy-local'; provisionalCacheUsed: boolean };
  ledger: {
    recordLimit: number;
    factLimit: number;
    committedFactKeyCount: number;
    evictedRecords: number;
    evictedFacts: number;
    encodedBytes: number;
    byteLimit: number;
    semanticKeyMaxBytes: number;
  };
}

interface RetainedTerminalTerminationTombstone {
  availability: 'session-terminated';
  reason: string;
  exitCode: number | null;
  cleanup: RetainedTerminalSessionState['cleanup'];
  driverLease: { state: 'revoked'; ownerClientId: null };
}

interface RetainedTerminalGenerationRejectionState {
  sessionId: string;
  authorityEpoch: string;
  streamEpoch: string;
  terminationReason: string;
  rejectedLateMessages: number;
  lastRejectionReason: 'late-pty-output' | 'late-pty-exit' | 'stale-mutation' | null;
}

interface SessionData {
  session: Session;
  pty: pty.IPty;
  processMetadata: SessionProcessMetadata;
  cleanupRecorded: boolean;
  finalized: boolean;
  pendingTermination: PendingSessionTermination | null;
  idleTimer: NodeJS.Timeout | null;
  runningTimer: NodeJS.Timeout | null;
  identityCaptureTimer: NodeJS.Timeout | null;
  shellType?: SessionShellType;
  headless: HeadlessTerminalState | null;
  headlessInstanceGeneration: number;
  headlessHealth: HeadlessHealth;
  headlessWriteChain: Promise<void>;
  headlessCloseSignal: DeferredSignal<void>;
  pendingHeadlessWrites: number;
  /**
   * Writes that have begun mutating the headless buffer but have not yet
   * raised `screenSeq`. Only this window makes the buffer and its sequence
   * disagree; a write still queued behind the chain does not.
   */
  headlessApplyInFlight: number;
  cols: number;
  rows: number;
  screenSeq: number;
  authorityEpoch: string;
  authorityRevision: number;
  parserComplete: boolean;
  pendingEscapeTailAnsi: string;
  parserTailOverflow: boolean;
  snapshotCache: SessionSnapshotCache | null;
  windowsPty?: WindowsPtyInfo;
  degradedReplayBuffer: string;
  degradedReplayTruncated: boolean;
  headlessDegradedPhase: HeadlessDegradedPhase | null;
  headlessOutputQueue: HeadlessOutputQueue;
  headlessOutputMaxBytes: number;
  headlessOutputMaxChunks: number;
  headlessQueueMode: StabilityModesConfig['headlessQueueMode'];
  pendingHeadlessOutputs: Map<number, PendingHeadlessOutput>;
  pendingHeadlessOutputBytes: number;
  pendingHeadlessOutputBytesByPolicyGeneration: Map<number, number>;
  pendingHeadlessOutputChunksByPolicyGeneration: Map<number, number>;
  pendingHeadlessLegacyOutputBytesByPolicyGeneration: Map<number, number>;
  pendingHeadlessLegacyOutputChunksByPolicyGeneration: Map<number, number>;
  pendingHeadlessWritesByPolicyGeneration: Map<number, number>;
  headlessPolicyWriteFailureSettlers: Map<number, (reason: 'headless-write-failed') => void>;
  maxPendingHeadlessOutputBytes: number;
  maxPendingHeadlessOutputChunks: number;
  nextHeadlessOutputId: number;
  nextTerminalAuthoritySourceSeq: bigint;
  terminalAuthorityRuntime?: TerminalAuthoritySessionRuntime;
  terminalAuthorityController?: TerminalAuthorityController;
  terminalQueryResponder?: TerminalQueryResponder;
  pendingTerminalAuthorityQueryEffects: PendingTerminalAuthorityQueryEffect[];
  unsnapshottedOutput: string;
  unsnapshottedOutputTruncated: boolean;
  initialCwd: string;   // CWD at session creation
  cwdFilePath?: string;  // Windows CWD tracking temp file path
  lastCwd?: string;      // Last known CWD for change detection
  recoveryForegroundCommand?: string;
  startupReady: boolean;
  startupReadyTimer: NodeJS.Timeout | null;
  pendingRestoreInputs: PendingRestoreInput[];

  // === Step 9: Idle Detection ===
  echoTracker: EchoTracker;
  detectionMode: DetectionMode;
  oscDetector: OscDetector;
  terminalTitleDetector: TerminalTitleDetector;
  terminalTitleSignalDetector: TerminalTitleDetector;
  derivedState?: SessionDerivedState;
  foregroundDetectorRegistry?: ForegroundAppDetectorRegistry;
  inputBuffer: string;
  pendingForegroundAppHint?: ForegroundAppId;
  aiTuiLaunchAttempt?: AiTuiLaunchAttempt;
  expectShellPromptAfterAiTuiFailure?: boolean;
  lastSubmittedCommand?: string;
  foregroundStartedAt?: number;
  lastReportedTerminalTitle?: string;
  retainedTerminal: RetainedTerminalSessionState;
}

interface PendingSessionTermination {
  reason: SessionCleanupReason;
  exitCode: number | null;
  exitObserved: boolean;
}

export interface SessionFinalizedEvent {
  sessionId: string;
  reason: SessionCleanupReason;
  exitCode: number | null;
  cleanupStatus: SessionCleanupStatus;
  recordedAt: string;
}

export interface SessionCommandSubmittedEvent {
  sessionId: string;
  command: string;
  executable: string | null;
}

export interface CreateSessionOptions {
  sessionId?: string;
  envPatch?: Record<string, string | undefined | null>;
}

interface SessionBatchTerminationResult {
  attempted: number;
  terminated: number;
  missing: string[];
  remainingVerifiedDescendants: number;
  remainingUnverifiedDescendants: number;
}

interface SessionFinalizerOptions {
  reason: SessionCleanupReason;
  exitCode?: number | null;
  killPty: boolean;
  emitExited: boolean;
  cleanupMode?: SessionProcessCleanupConfig['mode'];
  cleanupOverride?: {
    status: SessionCleanupStatus;
    remainingDescendants: number;
    verifiedRemainingDescendants?: number;
    unverifiedRemainingDescendants?: number;
  };
}

/**
 * Sanitize a CWD value read from the tracking temp file.
 * Rejects control characters, null bytes, excessive length; strips BOM.
 */
function sanitizeCwd(raw: string): string | null {
  if (!raw) return null;
  // Strip PowerShell UTF-8 BOM
  let cleaned = raw.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  // Reject if > 4096 chars
  if (cleaned.length > 4096) return null;
  // Reject control characters (\x00-\x1f) except nothing — all are rejected
  if (/[\x00-\x1f]/.test(cleaned)) return null;
  return cleaned;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeSessionProcessCleanupConfig(
  next?: Partial<SessionProcessCleanupConfig>,
): SessionProcessCleanupConfig {
  return {
    mode: next?.mode ?? DEFAULT_SESSION_PROCESS_CLEANUP.mode,
    gracefulWaitMs: next?.gracefulWaitMs ?? DEFAULT_SESSION_PROCESS_CLEANUP.gracefulWaitMs,
    forceWaitMs: next?.forceWaitMs ?? DEFAULT_SESSION_PROCESS_CLEANUP.forceWaitMs,
    descendantSampleLimit: next?.descendantSampleLimit ?? DEFAULT_SESSION_PROCESS_CLEANUP.descendantSampleLimit,
    identityProbeTimeoutMs: next?.identityProbeTimeoutMs ?? DEFAULT_SESSION_PROCESS_CLEANUP.identityProbeTimeoutMs,
  };
}

function createInitialCleanupTelemetry(mode: SessionProcessCleanupConfig['mode']): SessionCleanupTelemetry {
  return {
    mode,
    attempted: 0,
    completed: 0,
    degraded: 0,
    unverifiedSkipped: 0,
    identityCaptureSucceeded: 0,
    identityCaptureRetried: 0,
    identityCaptureFailed: 0,
    recentResults: [],
  };
}

function normalizeRootPid(pid: unknown): number | null {
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : null;
}

function inspectSessionProcessBestEffort(metadata: SessionProcessMetadata): SessionProcessInspection {
  void metadata;
  return { status: 'skipped-unverified', remainingDescendants: 0 };
}

function normalizeCleanupStatus(status: SessionCleanupStatus | undefined): SessionCleanupStatus {
  switch (status) {
    case 'observed':
    case 'completed':
    case 'degraded':
    case 'failed':
    case 'skipped-unverified':
    case 'not-started':
      return status;
    default:
      return 'degraded';
  }
}

function normalizeRemainingDescendants(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function resolveRemainingDescendantBreakdown(
  status: SessionCleanupStatus,
  inspection: {
    remainingDescendants?: number;
    verifiedRemainingDescendants?: number;
    unverifiedRemainingDescendants?: number;
  },
): {
  remainingDescendants: number;
  verifiedRemainingDescendants: number;
  unverifiedRemainingDescendants: number;
} {
  const remainingDescendants = normalizeRemainingDescendants(inspection.remainingDescendants);
  if (
    Number.isFinite(inspection.verifiedRemainingDescendants)
    || Number.isFinite(inspection.unverifiedRemainingDescendants)
  ) {
    const verifiedRemainingDescendants = normalizeRemainingDescendants(inspection.verifiedRemainingDescendants);
    const unverifiedRemainingDescendants = normalizeRemainingDescendants(inspection.unverifiedRemainingDescendants);
    return {
      remainingDescendants: Math.max(remainingDescendants, verifiedRemainingDescendants + unverifiedRemainingDescendants),
      verifiedRemainingDescendants,
      unverifiedRemainingDescendants,
    };
  }

  if (status === 'skipped-unverified') {
    return {
      remainingDescendants,
      verifiedRemainingDescendants: 0,
      unverifiedRemainingDescendants: remainingDescendants,
    };
  }

  if (status === 'observed' || status === 'completed') {
    return {
      remainingDescendants,
      verifiedRemainingDescendants: 0,
      unverifiedRemainingDescendants: 0,
    };
  }

  return {
    remainingDescendants,
    verifiedRemainingDescendants: 0,
    unverifiedRemainingDescendants: remainingDescendants,
  };
}

export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private sessionCounter: number = 0;
  private debugCaptureCounter = 0;
  private debugCaptureBySession: Map<string, SessionDebugCaptureEvent[]> = new Map();
  private debugCaptureEnabledSessions: Set<string> = new Set();
  private pendingResizeRefreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingResizeReplaySessions: Set<string> = new Set();
  private pendingResizeReplayStartedAt: Map<string, number> = new Map();
  private pendingResizeReplayLastOutputAt: Map<string, number> = new Map();
  private deferredEchoTokenCounter = 0;
  private runtimePtyConfig: PTYConfig;
  private runtimeSessionConfig: {
    idleDelayMs: number;
    runningDelayMs: number;
    processCleanup: SessionProcessCleanupConfig;
    codexTuiSuppression: boolean;
  };
  private runtimeHeadlessQueueConfig: RuntimeHeadlessQueueConfig;
  private readonly execFileFn: typeof execFile;
  private readonly execFileSyncFn: typeof execFileSync;
  private readonly platform: NodeJS.Platform;
  private readonly spawnPty: typeof pty.spawn;
  private readonly processInspector: SessionProcessInspector;
  private readonly processTreeTerminator: ProcessTreeTerminator;
  private readonly readProcessStartIdentityFn: ReadProcessStartIdentity;
  private readonly terminalResourcePolicyAuthority?: TerminalResourcePolicyLeaseAuthority;
  private readonly createHeadlessTerminalStateFn: typeof createHeadlessTerminalState;
  private readonly writeHeadlessTerminalFn: typeof writeHeadlessTerminal;
  private readonly compareRetainedHeadlessCheckpointRoundTripFn: typeof compareRetainedHeadlessCheckpointRoundTrip;
  private readonly retainedTerminalShadowProjectionMutator?: SessionManagerDeps['retainedTerminalShadowProjectionMutator'];
  private readonly retainedTerminalModelFaultInjector?: SessionManagerDeps['retainedTerminalModelFaultInjector'];
  private readonly retainedTerminalInitialOrdinal?: SessionManagerDeps['retainedTerminalInitialOrdinal'];
  private readonly compiledTerminalResourcePolicy: CompiledTerminalResourcePolicy;
  private readonly effectiveResourceLimits: ResourceLimitsConfig;
  private retainedTerminalShadowEnabled: boolean;
  /**
   * `01:462` — the epoch belongs to the session. The process-wide counter this
   * replaced could only ever issue a first value; it had nowhere to record the
   * four later events that raise one.
   */
  private readonly terminalStreamEpochLedger = createTerminalStreamEpochLedger();
  private readonly retainedTerminalTerminationTombstones = new Map<string, RetainedTerminalTerminationTombstone>();
  private readonly retainedTerminalGenerationRejections = new Map<string, RetainedTerminalGenerationRejectionState>();
  private readonly terminalResourcePolicyHeadlessFinalizedListeners = new Set<(sessionId: string) => void>();
  private terminalResourcePolicyHeadlessAdmissionPort?: TerminalResourcePolicyHeadlessAdmissionPort;
  private readonly terminalResourcePolicyHeadlessDrainBoundaries = new WeakMap<
    TerminalResourcePolicyHeadlessDrainBoundary,
    { sessionData: SessionData; fence: Promise<void>; settled: boolean }
  >();
  private cleanupTelemetry: SessionCleanupTelemetry = createInitialCleanupTelemetry(DEFAULT_SESSION_PROCESS_CLEANUP.mode);
  private cleanupRecordedSessionIds: Set<string> = new Set();
  private powerShellWinptyProbe: { checked: boolean; available: boolean; reason?: string } = {
    checked: false,
    available: false,
  };
  private wsRouter: WsRouter | null = null;
  private terminalAuthorityRuntimeFactory: TerminalAuthorityRuntimeFactory | null = null;
  private readonly terminalAuthorityDebugIsolations = new Map<string, TerminalAuthorityDebugIsolationState>();
  private cachedAvailableShells: ShellInfo[] | null = null;
  private cwdChangeCallback: ((sessionId: string, cwd: string) => void) | null = null;
  private terminalTitleChangeCallback: ((sessionId: string, title: string) => void) | null = null;
  private sessionFinalizedCallback: ((event: SessionFinalizedEvent) => void) | null = null;
  private readonly sessionFinalizedListeners = new Set<(event: SessionFinalizedEvent) => void>();
  private commandSubmittedCallback: ((event: SessionCommandSubmittedEvent) => void | Promise<void>) | null = null;
  private observability: Omit<SessionManagerObservability, 'totalSessions' | 'healthySessions' | 'degradedSessions' | 'headlessOutput' | 'cleanup' | 'eventLoopDelay' | 'processCpuPercentOfOneCore'> = {
    snapshotRequests: 0,
    snapshotCacheHits: 0,
    snapshotSerializeFailures: 0,
    snapshotFallbacks: 0,
    oversizedSnapshots: 0,
    totalSnapshotBytes: 0,
    maxSnapshotBytesObserved: 0,
    totalSnapshotSerializeMs: 0,
    maxSnapshotSerializeMs: 0,
    headlessWriteCumulativeMs: 0,
  };
  private lastCpuUsageSample: NodeJS.CpuUsage = process.cpuUsage();
  private lastCpuSampleAt: bigint = process.hrtime.bigint();
  private lastCpuPercentOfOneCore = 0;

  constructor(
    initialConfig: SessionManagerInitialConfig = {
      pty: config.pty,
      session: config.session,
      resourceLimits: config.resourceLimits,
      stabilityModes: config.stabilityModes,
    },
    deps: SessionManagerDeps = {},
  ) {
    this.platform = deps.platform ?? process.platform;
    this.effectiveResourceLimits = structuredClone(initialConfig.resourceLimits ?? config.resourceLimits!);
    this.compiledTerminalResourcePolicy = compileTerminalResourcePolicy({
      rawConfig: {
        ...(initialConfig.resourceLimits ? { resourceLimits: initialConfig.resourceLimits } : {}),
        pty: initialConfig.pty,
      },
      effectiveResourceLimits: this.effectiveResourceLimits,
      schemaVersion: TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
      profileVersion: TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
    });
    const initialHeadlessLimits = headlessResourceLimitsSchema.parse(initialConfig.resourceLimits?.headless);
    const initialStabilityModes = stabilityModesSchema.parse(initialConfig.stabilityModes);
    this.runtimePtyConfig = {
      ...clonePtyConfig(initialConfig.pty),
      ...normalizePtyConfigForPlatform(initialConfig.pty, this.platform),
    };
    this.runtimeSessionConfig = {
      idleDelayMs: initialConfig.session.idleDelayMs,
      runningDelayMs: initialConfig.session.runningDelayMs ?? DEFAULT_RUNNING_DELAY_MS,
      processCleanup: normalizeSessionProcessCleanupConfig(initialConfig.session.processCleanup),
      codexTuiSuppression: (initialConfig.session as { codexTuiSuppression?: boolean }).codexTuiSuppression ?? false,
    };
    this.runtimeHeadlessQueueConfig = {
      mode: initialStabilityModes.headlessQueueMode,
      limits: cloneHeadlessResourceLimits(initialHeadlessLimits),
    };
    this.cleanupTelemetry = createInitialCleanupTelemetry(this.runtimeSessionConfig.processCleanup.mode);
    this.execFileFn = deps.execFileFn ?? execFile;
    this.execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
    this.spawnPty = deps.spawnPty ?? pty.spawn;
    this.processInspector = deps.processInspector ?? inspectSessionProcessBestEffort;
    this.processTreeTerminator = deps.processTreeTerminator ?? new DefaultProcessTreeTerminator({ platform: this.platform });
    this.readProcessStartIdentityFn = deps.readProcessStartIdentityFn ?? readProcessStartIdentity;
    this.terminalResourcePolicyAuthority = deps.terminalResourcePolicyAuthority;
    this.createHeadlessTerminalStateFn = deps.createHeadlessTerminalStateFn ?? createHeadlessTerminalState;
    this.writeHeadlessTerminalFn = deps.writeHeadlessTerminalFn ?? writeHeadlessTerminal;
    this.compareRetainedHeadlessCheckpointRoundTripFn = deps.compareRetainedHeadlessCheckpointRoundTripFn
      ?? compareRetainedHeadlessCheckpointRoundTrip;
    this.retainedTerminalShadowProjectionMutator = deps.retainedTerminalShadowProjectionMutator;
    this.retainedTerminalModelFaultInjector = deps.retainedTerminalModelFaultInjector;
    this.retainedTerminalInitialOrdinal = deps.retainedTerminalInitialOrdinal;
    this.retainedTerminalShadowEnabled = deps.retainedTerminalShadowEnabled ?? false;
    // 서버 시작 시 한 번만 셸 감지 후 캐싱
    this.cachedAvailableShells = this.detectAvailableShells();
  }

  createSession(name?: string, shell?: ShellType, cwd?: string, options: CreateSessionOptions = {}): SessionDTO {
    const id = options.sessionId || uuidv4();
    const replacedSession = this.sessions.get(id);
    if (replacedSession) {
      this.finalizeSession(id, replacedSession, {
        reason: 'tab-restart',
        exitCode: null,
        killPty: true,
        emitExited: false,
      });
    }
    this.retainedTerminalTerminationTombstones.delete(id);
    this.sessionCounter++;
    const sessionName = name || `Session-${this.sessionCounter}`;

    const cwdFilePath = this.getCwdTrackingFilePath(id);
    const { shell: shellCmd, args: shellArgs, shellType } = this.resolveShell(shell, cwdFilePath);
    const backendResolution = this.resolveWindowsPtyBackend(shellType);
    const initialCwd = this.resolveSpawnCwd(cwd, shellType);

    // Step 9: OSC 133 셸 통합 환경변수 구성
    const env = {
      ...this.buildShellEnv(shellType),
      ...this.normalizeEnvPatch(options.envPatch),
    };
    const cols = this.runtimePtyConfig.defaultCols;
    const rows = this.runtimePtyConfig.defaultRows;

    const ptyProcess = this.spawnPty(shellCmd, shellArgs, {
      name: this.runtimePtyConfig.termName,
      cols,
      rows,
      cwd: initialCwd,
      env,  // Step 9: 확장된 env (OSC 133 주입 포함)
      // Windows PTY backend (ConPTY vs winpty)
      useConpty: backendResolution.useConpty,
    });
    const processMetadata = this.createSessionProcessMetadata(
      ptyProcess,
      shellCmd,
      shellArgs,
      shellType,
      initialCwd,
      backendResolution.backend,
    );

    const session: Session = {
      id,
      name: sessionName,
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      sortOrder: this.sessions.size,
    };

    // Step 9: OscDetector 생성
    const oscDetector = new OscDetector();
    const terminalTitleDetector = new TerminalTitleDetector();
    const terminalTitleSignalDetector = new TerminalTitleDetector();

    const sessionData: SessionData = {
      session,
      pty: ptyProcess,
      processMetadata,
      cleanupRecorded: false,
      finalized: false,
      pendingTermination: null,
      idleTimer: null,
      runningTimer: null,
      identityCaptureTimer: null,
      shellType,
      headless: null,
      headlessInstanceGeneration: 0,
      headlessHealth: 'healthy',
      headlessWriteChain: Promise.resolve(),
      headlessCloseSignal: createDeferredSignal<void>(),
      pendingHeadlessWrites: 0,
      headlessApplyInFlight: 0,
      cols,
      rows,
      screenSeq: 0,
      authorityEpoch: uuidv4(),
      authorityRevision: 0,
      parserComplete: true,
      pendingEscapeTailAnsi: '',
      parserTailOverflow: false,
      snapshotCache: null,
      windowsPty: this.getWindowsPtyInfo(backendResolution.backend),
      degradedReplayBuffer: '',
      degradedReplayTruncated: false,
      headlessDegradedPhase: null,
      headlessOutputQueue: this.createHeadlessOutputQueue(),
      headlessOutputMaxBytes: this.runtimeHeadlessQueueConfig.limits.pendingOutputMaxBytes,
      headlessOutputMaxChunks: this.runtimeHeadlessQueueConfig.limits.pendingOutputMaxChunks,
      headlessQueueMode: this.runtimeHeadlessQueueConfig.mode,
      pendingHeadlessOutputs: new Map(),
      pendingHeadlessOutputBytes: 0,
      pendingHeadlessOutputBytesByPolicyGeneration: new Map(),
      pendingHeadlessOutputChunksByPolicyGeneration: new Map(),
      pendingHeadlessLegacyOutputBytesByPolicyGeneration: new Map(),
      pendingHeadlessLegacyOutputChunksByPolicyGeneration: new Map(),
      pendingHeadlessWritesByPolicyGeneration: new Map(),
      headlessPolicyWriteFailureSettlers: new Map(),
      maxPendingHeadlessOutputBytes: 0,
      maxPendingHeadlessOutputChunks: 0,
      nextHeadlessOutputId: 0,
      nextTerminalAuthoritySourceSeq: BigInt(
        this.retainedTerminalInitialOrdinal?.sourceSeq ?? '0',
      ),
      pendingTerminalAuthorityQueryEffects: [],
      unsnapshottedOutput: '',
      unsnapshottedOutputTruncated: false,
      initialCwd,
      cwdFilePath,
      startupReady: false,
      startupReadyTimer: null,
      pendingRestoreInputs: [],
      // Step 9: Idle Detection
      echoTracker: {
        lastInputAt: 0,
        lastInputHasEnter: false,
        lastInputWasControlInterrupt: false,
        recentInputs: [],
      },
      detectionMode: 'heuristic',
      oscDetector,
      terminalTitleDetector,
      terminalTitleSignalDetector,
      derivedState: createInitialDerivedState(),
      foregroundDetectorRegistry: this.createForegroundDetectorRegistry(),
      inputBuffer: '',
      foregroundStartedAt: undefined,
      retainedTerminal: this.createRetainedTerminalSessionState(id),
    };

    this.sessions.set(id, sessionData);
    this.scheduleProcessStartIdentityCapture(id, sessionData);
    this.initializeHeadlessState(id, sessionData);
    this.captureDebugEvent(id, 'pty', 'backend_resolved', {
      shellType,
      requestedPowerShellBackend: backendResolution.requestedPowerShellBackend,
      effectiveBackend: backendResolution.backend,
      useConpty: backendResolution.useConpty,
    });

    // Step 9: OSC 133 콜백 등록
    oscDetector.setCallback((_status, event) => {
      const sd = this.sessions.get(id);
      if (!sd || sd.detectionMode !== 'osc133') return;

      switch (event.type) {
        case 'prompt-start':  // A 마커
        case 'command-end':   // D 마커
          this.transitionToShellPrompt(id, event.type);
          break;
        case 'command-start': // C 마커
          if (sd.echoTracker.lastInputWasControlInterrupt) {
            this.transitionToShellPrompt(id, 'osc133_control_interrupt_prompt');
          } else if (isInteractiveAiAppId(sd.pendingForegroundAppHint) || isInteractiveAiAppId(this.ensureDerivedState(sd).foregroundAppId)) {
            this.beginForegroundProcess(id, 'osc133_command_start');
          } else {
            this.updateStatus(id, 'running', 'osc133_command_start');
          }
          break;
        case 'prompt-end':    // B 마커
          // 정보용, 상태 변경 없음 (이미 idle)
          break;
      }
    });

    terminalTitleDetector.setCallback((event) => {
      const current = this.sessions.get(id);
      if (current !== sessionData || sessionData.lastReportedTerminalTitle === event.title) return;
      sessionData.lastReportedTerminalTitle = event.title;
      this.terminalTitleChangeCallback?.(id, event.title);
    });

    // Inject CWD tracking hook based on shell type
    this.injectCwdHook(id, sessionData, ptyProcess, shellType);
    this.scheduleStartupReadyFallback(id, shellType);

    // Handle PTY output (Step 9: Phase 3 통합 최종 버전)
    ptyProcess.onData((rawData: string) => {
      const current = this.sessions.get(id);
      if (current !== sessionData) {
        this.recordRetainedTerminalLateMessage(id, sessionData.authorityEpoch, 'late-pty-output');
        return;
      }
      const sData = sessionData;

      // ========================================
      // Step 9: OSC 133 마커 처리 (항상 수행)
      // ========================================
      const { stripped, foundMarker } = sData.oscDetector.process(rawData);

      // 자동 모드 승격: 첫 OSC 133 마커 감지 시 heuristic → osc133
      if (foundMarker && sData.detectionMode === 'heuristic') {
        sData.detectionMode = 'osc133';
        console.log(`[Session ${id}] Idle detection upgraded to osc133 mode`);
        // idle 타이머 해제 (osc133 모드에서는 불필요)
        if (sData.idleTimer) {
          clearTimeout(sData.idleTimer);
          sData.idleTimer = null;
        }
        this.cancelPendingRunningTransition(sData);
      }

      sData.terminalTitleDetector.process(rawData);
      const outputData = sData.detectionMode === 'osc133' ? stripped : rawData;
      sData.terminalTitleSignalDetector.process(outputData);
      const statusData = sData.terminalTitleSignalDetector.getSignalData();

      if (statusData.length > 0) {
        // PERF-BGSTAB-007: compute the strip -> \r\n?->\n normalization at most once per chunk and
        // share it with the classification helpers below, instead of each helper re-stripping
        // statusData. Computed lazily so chunks that never reach a classifier (e.g. the observation
        // path) keep their original zero-strip cost.
        let sharedNormalizedStatusData: string | undefined;
        const getNormalizedStatusData = (): string =>
          (sharedNormalizedStatusData ??= this.normalizeTerminalStatusDataForClassification(sData, statusData));
        const observation = this.inspectForegroundAppOutput(id, sData, statusData);
        if (observation) {
          this.applyForegroundObservation(id, observation);
        }

        if (!observation && sData.detectionMode === 'osc133') {
          const derivedState = this.ensureDerivedState(sData);
          const isAiForeground = this.isInteractiveForeground(sData, derivedState);
          if (isAiForeground || isInteractiveAiAppId(sData.pendingForegroundAppHint)) {
            const normalizedAiTuiOutput = getNormalizedStatusData();
            const hasPendingAiTuiLocalEchoCandidate = normalizedAiTuiOutput.trim().length > 0
              || sData.echoTracker.statusEscapeTailAnsi !== undefined;
            if (hasPendingAiTuiLocalEchoCandidate && this.isPendingAiTuiLocalEcho(
              id,
              sData,
              statusData,
              normalizedAiTuiOutput,
            )) {
              this.beginForegroundActivity(id, 'waiting_input', 'osc133_ai_tui_pending_local_echo');
            } else if (isLikelyAiTuiLaunchFailureOutput(sData, statusData, normalizedAiTuiOutput)) {
              this.markAiTuiLaunchFailure(id, 'osc133_ai_tui_launch_failure');
            } else {
              const isLaunchEcho = this.isEchoOutput(sData, statusData)
                || isLikelyCommandEchoOutput(statusData, sData.lastSubmittedCommand, getNormalizedStatusData());
              const signal = this.classifyAiTuiOutputSignal(sData, statusData, getNormalizedStatusData());
              if (signal === 'waiting_input' || signal === 'repaint_only') {
                this.beginForegroundActivity(id, signal, `osc133_ai_tui_${signal}`);
              } else {
                this.scheduleRunningTransition(id, 'osc133_ai_tui_unclassified_output');
              }
              if (!isLaunchEcho) {
                this.markAiTuiLaunchSucceeded(sData);
              }
            }
          }
        }

        // ========================================
        // Step 9: 모드별 상태 전환
        // ========================================
        if (sData.detectionMode === 'heuristic') {
          const normalizedStatusData = getNormalizedStatusData();
          const hasSubstantivePendingInputOutput = countNonEmptyLines(normalizedStatusData) > 1
            || normalizedStatusData.trim().length > 128;
          const derivedState = this.ensureDerivedState(sData);
          const isAiForeground = this.isInteractiveForeground(sData, derivedState);
          const isAiForegroundHinted = isInteractiveAiAppId(sData.pendingForegroundAppHint);
          const isEcho = this.isEchoOutput(sData, statusData) && !hasSubstantivePendingInputOutput;
          if (!isEcho || (!isAiForeground && !isAiForegroundHinted)) {
            const isAiShellPromptReturn = (isAiForeground || sData.expectShellPromptAfterAiTuiFailure === true)
              && this.isShellPromptReturnOutput(sData, statusData, getNormalizedStatusData());
            const isPowerShellPromptRedraw = !isAiForeground
              && !isAiForegroundHinted
              && this.isPowerShellPromptRedrawOutput(
                sData,
                statusData,
                getNormalizedStatusData(),
              );
            if (isPowerShellPromptRedraw || isAiShellPromptReturn) {
              this.transitionToShellPrompt(
                id,
                isAiShellPromptReturn ? 'heuristic_ai_tui_shell_prompt_return' : 'heuristic_powershell_prompt_redraw',
                isPowerShellPromptRedraw && sData.inputBuffer.length > 0,
              );
            } else {
              if (isAiForeground || isAiForegroundHinted) {
                if (!observation) {
                  const normalizedAiTuiOutput = getNormalizedStatusData();
                  const hasPendingAiTuiLocalEchoCandidate = normalizedAiTuiOutput.trim().length > 0
                    || sData.echoTracker.statusEscapeTailAnsi !== undefined;
                  if (hasPendingAiTuiLocalEchoCandidate && this.isPendingAiTuiLocalEcho(
                    id,
                    sData,
                    statusData,
                    normalizedAiTuiOutput,
                  )) {
                    this.beginForegroundActivity(id, 'waiting_input', 'heuristic_ai_tui_pending_local_echo');
                  } else if (isLikelyAiTuiLaunchFailureOutput(sData, statusData, normalizedAiTuiOutput)) {
                    this.markAiTuiLaunchFailure(id, 'heuristic_ai_tui_launch_failure');
                  } else {
                    const isLaunchEcho = this.isEchoOutput(sData, statusData)
                      || isLikelyCommandEchoOutput(statusData, sData.lastSubmittedCommand, getNormalizedStatusData());
                    const signal = this.classifyAiTuiOutputSignal(sData, statusData, getNormalizedStatusData());
                    if (signal === 'waiting_input' || signal === 'repaint_only') {
                      this.beginForegroundActivity(id, signal, `heuristic_ai_tui_${signal}`);
                    } else {
                      this.scheduleRunningTransition(id, 'heuristic_ai_tui_unclassified_output');
                    }
                    if (!isLaunchEcho) {
                      this.markAiTuiLaunchSucceeded(sData);
                    }
                  }
                }
              } else {
                // Preserve local echo and prompt-redraw suppression while a draft is
                // pending, but surface substantive terminal output as running.
                const isPendingInputEcho = matchesPendingTerminalDraftEcho(
                  normalizedStatusData,
                  sData.inputBuffer,
                );
                const allowsPartialPrintableEchoPrefix = hasTerminalRepaintControl(statusData);
                const unsubmittedPrintableEchoMatch = matchUnsubmittedPrintableEcho(
                  normalizedStatusData,
                  sData.echoTracker,
                  allowsPartialPrintableEchoPrefix,
                );
                const hadDeferredBareUnsubmittedPrintableEcho = sData.echoTracker.deferredUnsubmittedPrintableEcho !== undefined;
                const isDeferredBareUnsubmittedPrintableEcho = !hadDeferredBareUnsubmittedPrintableEcho
                  && unsubmittedPrintableEchoMatch === 'none'
                  && !allowsPartialPrintableEchoPrefix
                  && this.deferBareUnsubmittedPrintableEcho(id, sData, statusData, normalizedStatusData);
                const preservesDeferredBareUnsubmittedPrintableEcho = hadDeferredBareUnsubmittedPrintableEcho
                  && unsubmittedPrintableEchoMatch === 'empty';
                if (!preservesDeferredBareUnsubmittedPrintableEcho
                  && (unsubmittedPrintableEchoMatch !== 'none' || !isDeferredBareUnsubmittedPrintableEcho)) {
                  this.clearDeferredBareUnsubmittedPrintableEcho(sData);
                }
                const interruptedUnsubmittedPrintableEchoMatch = matchInterruptedUnsubmittedPrintableEcho(
                  normalizedStatusData,
                  sData.echoTracker,
                  allowsPartialPrintableEchoPrefix,
                );
                const isControlInterruptPromptReturn = sData.echoTracker.lastInputWasControlInterrupt
                  && this.isControlInterruptPromptReturnOutput(sData, statusData, normalizedStatusData);
                const isCursorVisibilityRepaint = isTerminalCursorVisibilityRepaint(statusData);
                if (!sData.echoTracker.lastInputHasEnter
                  && (isPendingInputEcho
                    || unsubmittedPrintableEchoMatch !== 'none'
                    || isDeferredBareUnsubmittedPrintableEcho
                    || interruptedUnsubmittedPrintableEchoMatch !== 'none'
                    || isControlInterruptPromptReturn
                    || isCursorVisibilityRepaint)) {
                  if (isPendingInputEcho) {
                    delete sData.echoTracker.lastUnsubmittedPrintableInput;
                    delete sData.echoTracker.unsubmittedPrintableEchoPrefix;
                    this.clearDeferredBareUnsubmittedPrintableEcho(sData);
                  }
                  if (isControlInterruptPromptReturn) {
                    sData.echoTracker.lastInputWasControlInterrupt = false;
                    if (interruptedUnsubmittedPrintableEchoMatch !== 'full') {
                      delete sData.echoTracker.interruptedUnsubmittedPrintableInput;
                      delete sData.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
                    }
                  }
                  this.cancelPendingRunningTransition(sData);
                } else {
                  sData.echoTracker.lastInputWasControlInterrupt = false;
                  delete sData.echoTracker.lastUnsubmittedPrintableInput;
                  delete sData.echoTracker.unsubmittedPrintableEchoPrefix;
                  this.clearDeferredBareUnsubmittedPrintableEcho(sData);
                  delete sData.echoTracker.interruptedUnsubmittedPrintableInput;
                  delete sData.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
                  this.updateStatus(id, 'running', 'heuristic_non_ai_output');
                  this.scheduleIdleTransition(id);
                }
              }
            }
          }
        }
      }

      const hasRetainedSemanticOnlyRecord = outputData.length === 0
        && foundMarker
        && sData.retainedTerminal.mode === 'shadow';
      if (outputData.length > 0 || hasRetainedSemanticOnlyRecord) {
        const outputDebugDetails = this.isDebugCaptureEnabled(id)
          ? buildRawOutputDebugDetails(sData, rawData, outputData, foundMarker)
          : undefined;
        if (outputData.length > 0 && this.pendingResizeReplaySessions.has(id)) {
          this.pendingResizeReplayLastOutputAt.set(id, Date.now());
          this.scheduleResizeReplayRefresh(id, RESIZE_REPLAY_QUIET_WINDOW_MS);
        }
        this.captureDebugEvent(
          id,
          'pty',
          hasRetainedSemanticOnlyRecord ? 'retained_semantic_output' : 'raw_output',
          outputDebugDetails,
          rawData,
        );
        this.queueHeadlessOutput(id, sData, outputData, rawData);
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== sessionData) {
        this.recordRetainedTerminalLateMessage(id, sessionData.authorityEpoch, 'late-pty-exit');
        return;
      }
      if (sessionData.pendingTermination) {
        sessionData.pendingTermination.exitCode = exitCode;
        sessionData.pendingTermination.exitObserved = true;
        return;
      }
      this.finalizeSession(id, sessionData, {
        reason: 'process-exit',
        exitCode,
        killPty: false,
        emitExited: true,
      });
    });

    return this.toDTO(session);
  }

  private scheduleIdleTransition(id: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    if (data.idleTimer) {
      clearTimeout(data.idleTimer);
    }
    this.cancelPendingRunningTransition(data);

    data.idleTimer = setTimeout(() => {
      this.updateStatus(id, 'idle', 'idle_delay_elapsed');
    }, this.runtimeSessionConfig.idleDelayMs);
  }

  private cancelPendingRunningTransition(data: SessionData): void {
    if (data.runningTimer) {
      clearTimeout(data.runningTimer);
      data.runningTimer = null;
    }
  }

  private deferBareUnsubmittedPrintableEcho(
    id: string,
    data: SessionData,
    rawOutput: string,
    normalizedOutput: string,
  ): boolean {
    if (rawOutput.includes('\r') || rawOutput.includes('\n')) {
      return false;
    }

    const prefix = getPendingTerminalDraftPrefix(
      normalizedOutput,
      data.echoTracker.lastUnsubmittedPrintableInput?.value,
    );
    if (!prefix) {
      return false;
    }

    if (data.echoTracker.deferredUnsubmittedPrintableEcho) {
      return false;
    }

    const token = ++this.deferredEchoTokenCounter;
    data.echoTracker.unsubmittedPrintableEchoPrefix = prefix;
    const deferred: NonNullable<EchoTracker['deferredUnsubmittedPrintableEcho']> = { token };
    data.echoTracker.deferredUnsubmittedPrintableEcho = deferred;
    const timer = setTimeout(() => {
      const current = this.sessions.get(id);
      if (current !== data || current.echoTracker.deferredUnsubmittedPrintableEcho?.token !== token) {
        return;
      }

      delete current.echoTracker.deferredUnsubmittedPrintableEcho;
      delete current.echoTracker.unsubmittedPrintableEchoPrefix;
      delete current.echoTracker.lastUnsubmittedPrintableInput;
      this.updateStatus(id, 'running', 'heuristic_deferred_bare_echo_prefix');
      this.scheduleIdleTransition(id);
    }, BARE_ECHO_CONFIRMATION_DELAY_MS);
    deferred.timer = timer;
    timer.unref();
    return true;
  }

  private clearDeferredBareUnsubmittedPrintableEcho(data: SessionData): void {
    const timer = data.echoTracker.deferredUnsubmittedPrintableEcho?.timer;
    if (timer) {
      clearTimeout(timer);
    }
    delete data.echoTracker.deferredUnsubmittedPrintableEcho;
  }

  private isPendingAiTuiLocalEcho(
    id: string,
    data: SessionData,
    rawOutput: string,
    normalizedOutput: string,
  ): boolean {
    const allowsPartialPrintableEchoPrefix = hasTerminalRepaintControl(rawOutput);
    const unsubmittedPrintableEchoMatch = matchUnsubmittedPrintableEcho(
      normalizedOutput,
      data.echoTracker,
      allowsPartialPrintableEchoPrefix,
    );
    const hadDeferredBareUnsubmittedPrintableEcho = data.echoTracker.deferredUnsubmittedPrintableEcho !== undefined;
    const isDeferredBareUnsubmittedPrintableEcho = !hadDeferredBareUnsubmittedPrintableEcho
      && unsubmittedPrintableEchoMatch === 'none'
      && !allowsPartialPrintableEchoPrefix
      && this.deferBareUnsubmittedPrintableEcho(id, data, rawOutput, normalizedOutput);
    const preservesDeferredBareUnsubmittedPrintableEcho = hadDeferredBareUnsubmittedPrintableEcho
      && unsubmittedPrintableEchoMatch === 'empty';
    if (!preservesDeferredBareUnsubmittedPrintableEcho
      && (unsubmittedPrintableEchoMatch !== 'none' || !isDeferredBareUnsubmittedPrintableEcho)) {
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
    }

    if (unsubmittedPrintableEchoMatch === 'full') {
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
    } else if (unsubmittedPrintableEchoMatch === 'none'
      && !isDeferredBareUnsubmittedPrintableEcho
      && !preservesDeferredBareUnsubmittedPrintableEcho) {
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
    }

    return unsubmittedPrintableEchoMatch !== 'none' || isDeferredBareUnsubmittedPrintableEcho;
  }

  private normalizeTerminalStatusDataForClassification(data: SessionData, statusData: string): string {
    const combinedStatusData = `${data.echoTracker.statusEscapeTailAnsi ?? ''}${statusData}`;
    const parserState = advanceTerminalPartialEscapeTail(
      '',
      combinedStatusData,
      this.runtimePtyConfig.maxSnapshotBytes,
    );
    if (parserState.overflowed) {
      delete data.echoTracker.statusEscapeTailAnsi;
      return stripAndNormalizeTerminalOutput(combinedStatusData);
    }

    if (parserState.pendingEscapeTailAnsi) {
      data.echoTracker.statusEscapeTailAnsi = parserState.pendingEscapeTailAnsi;
      return stripAndNormalizeTerminalOutput(
        combinedStatusData.slice(0, -parserState.pendingEscapeTailAnsi.length),
      );
    }

    delete data.echoTracker.statusEscapeTailAnsi;
    return stripAndNormalizeTerminalOutput(combinedStatusData);
  }

  private scheduleRunningTransition(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    if (data.session.status === 'running') {
      this.scheduleIdleTransition(id);
      return;
    }

    if (data.runningTimer) {
      return;
    }

    const appHint = data.pendingForegroundAppHint ?? data.aiTuiLaunchAttempt?.appId;
    data.runningTimer = setTimeout(() => {
      const current = this.sessions.get(id);
      if (!current) return;

      current.runningTimer = null;
      this.captureDebugEvent(id, 'detector', 'running_delay_elapsed', {
        reason,
        runningDelayMs: this.runtimeSessionConfig.runningDelayMs,
      });
      this.updateDerivedState(id, reason, (state) => {
        state.ownership = 'foreground_app';
        state.activity = 'busy';
        if (!isInteractiveAiAppId(state.foregroundAppId) && isInteractiveAiAppId(appHint)) {
          state.foregroundAppId = appHint;
        }
        delete state.detectorId;
      });
      this.scheduleIdleTransition(id);
    }, this.runtimeSessionConfig.runningDelayMs);
    data.runningTimer.unref();

    this.captureDebugEvent(id, 'detector', 'running_delay_scheduled', {
      reason,
      runningDelayMs: this.runtimeSessionConfig.runningDelayMs,
    });
  }

  private updateStatus(id: string, status: SessionStatus, source = 'unspecified'): void {
    const data = this.sessions.get(id);
    if (!data || data.session.status === status) return;
    data.session.status = status;
    data.session.lastActiveAt = new Date();
    this.captureDebugEvent(id, 'detector', 'status_transition', {
      nextStatus: status,
      source,
      inputBufferLength: data.inputBuffer?.length ?? 0,
      lastInputHasEnter: data.echoTracker?.lastInputHasEnter ?? false,
      msSinceLastInput: !data.echoTracker || data.echoTracker.lastInputAt === 0
        ? null
        : Date.now() - data.echoTracker.lastInputAt,
      authorityMode: data.terminalAuthorityController?.getState().mode ?? null,
    });
    this.broadcastWs(id, 'status', { status });
  }

  private createForegroundDetectorRegistry(): ForegroundAppDetectorRegistry {
    return new ForegroundAppDetectorRegistry([
      new HermesForegroundDetector(),
    ]);
  }

  private ensureDerivedState(data: SessionData): SessionDerivedState {
    if (!data.derivedState) {
      data.derivedState = createInitialDerivedState();
    }
    return data.derivedState;
  }

  private ensureForegroundDetectorRegistry(data: SessionData): ForegroundAppDetectorRegistry {
    if (!data.foregroundDetectorRegistry) {
      data.foregroundDetectorRegistry = this.createForegroundDetectorRegistry();
    }
    return data.foregroundDetectorRegistry;
  }

  private beginForegroundProcess(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    const hintedAppId = data.pendingForegroundAppHint;
    delete data.pendingForegroundAppHint;
    this.ensureForegroundDetectorRegistry(data).reset();
    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'foreground_app';
      state.activity = isInteractiveAiAppId(hintedAppId) ? 'waiting_input' : 'unknown';
      if (hintedAppId) {
        state.foregroundAppId = hintedAppId;
      } else {
        delete state.foregroundAppId;
      }
      delete state.detectorId;
    });
    data.foregroundStartedAt = Date.now();
  }

  private beginForegroundActivity(
    id: string,
    activity: 'busy' | 'unknown' | 'waiting_input' | 'repaint_only',
    reason: string,
  ): void {
    const data = this.sessions.get(id);
    if (!data) return;

    const current = this.ensureDerivedState(data);
    if (current.ownership !== 'foreground_app') {
      this.ensureForegroundDetectorRegistry(data).reset();
    }
    if (activity === 'waiting_input' || activity === 'repaint_only') {
      this.cancelPendingRunningTransition(data);
    }

    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'foreground_app';
      state.activity = activity;
      if (data.pendingForegroundAppHint) {
        state.foregroundAppId = data.pendingForegroundAppHint;
      }
    });
    data.foregroundStartedAt = Date.now();
  }

  private markAiTuiLaunchFailure(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    this.cancelPendingRunningTransition(data);
    delete data.pendingForegroundAppHint;
    delete data.aiTuiLaunchAttempt;
    delete data.lastSubmittedCommand;
    data.foregroundStartedAt = undefined;
    data.expectShellPromptAfterAiTuiFailure = true;
    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'shell_prompt';
      state.activity = 'waiting_input';
      delete state.foregroundAppId;
      delete state.detectorId;
    });
    this.scheduleIdleTransition(id);
  }

  private markAiTuiLaunchSucceeded(data: SessionData): void {
    delete data.aiTuiLaunchAttempt;
    delete data.pendingForegroundAppHint;
  }

  private transitionToShellPrompt(id: string, reason: string, preserveInputBuffer = false): void {
    const data = this.sessions.get(id);
    if (!data) return;

    this.markSessionStartupReady(id, data, reason);
    const preserveActiveCwdRefreshDraft = reason === 'cwd_prompt_refresh'
      && data.echoTracker.lastUnsubmittedPrintableInput !== undefined;
    if (data.echoTracker.deferredUnsubmittedPrintableEcho) {
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
    }
    if (!preserveInputBuffer && !preserveActiveCwdRefreshDraft) {
      data.inputBuffer = '';
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
      if (!data.echoTracker.lastInputWasControlInterrupt) {
        delete data.echoTracker.interruptedUnsubmittedPrintableInput;
        delete data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
      }
    }
    delete data.pendingForegroundAppHint;
    delete data.aiTuiLaunchAttempt;
    delete data.expectShellPromptAfterAiTuiFailure;
    delete data.lastSubmittedCommand;
    delete data.recoveryForegroundCommand;
    data.foregroundStartedAt = undefined;
    this.cancelPendingRunningTransition(data);
    this.ensureForegroundDetectorRegistry(data).reset();
    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'shell_prompt';
      state.activity = 'waiting_input';
      delete state.foregroundAppId;
      delete state.detectorId;
    });
  }

  private inspectForegroundAppOutput(
    id: string,
    data: SessionData,
    chunk: string,
  ): ForegroundAppObservation | null {
    const derivedState = this.ensureDerivedState(data);
    const msSinceLastInput = data.echoTracker.lastInputAt > 0
      ? Date.now() - data.echoTracker.lastInputAt
      : null;
    return this.ensureForegroundDetectorRegistry(data).inspect({
      chunk,
      now: Date.now(),
      sessionId: id,
      shellType: data.shellType,
      detectionMode: data.detectionMode,
      appHint: data.pendingForegroundAppHint ?? derivedState.foregroundAppId,
      lastSubmittedCommand: data.lastSubmittedCommand,
      lastInputHasEnter: data.echoTracker.lastInputHasEnter,
      msSinceLastInput,
    });
  }

  private applyForegroundObservation(id: string, observation: ForegroundAppObservation): void {
    const now = Date.now();
    const data = this.sessions.get(id);
    this.captureDebugEvent(id, 'detector', 'detector_observation', {
      appId: observation.appId,
      detectorId: observation.detectorId,
      activity: observation.activity,
      reason: observation.reason,
      confidence: observation.confidence,
      ...sanitizeDebugValues(observation.details),
    });

    if (data && isInteractiveAiAppId(observation.appId) && observation.activity === 'busy') {
      const currentState = this.ensureDerivedState(data);
      const alreadyRunning = data.session.status === 'running' || currentState.activity === 'busy';
      this.updateDerivedState(id, alreadyRunning ? `detector_${observation.reason}` : `detector_${observation.reason}_pending_running`, (state) => {
        state.ownership = 'foreground_app';
        state.activity = alreadyRunning ? 'busy' : 'waiting_input';
        state.foregroundAppId = observation.appId;
        state.detectorId = observation.detectorId;
        state.lastObservationAt = now;
        state.lastSemanticOutputAt = now;
      }, {
        preservePendingRunningTransition: !alreadyRunning,
      });
      this.markAiTuiLaunchSucceeded(data);
      if (alreadyRunning) {
        this.scheduleIdleTransition(id);
      } else {
        this.scheduleRunningTransition(id, `detector_${observation.reason}`);
      }
      return;
    }

    this.updateDerivedState(id, `detector_${observation.reason}`, (state) => {
      state.ownership = 'foreground_app';
      state.activity = observation.activity;
      state.foregroundAppId = observation.appId;
      state.detectorId = observation.detectorId;
      state.lastObservationAt = now;
      if (observation.activity === 'busy') {
        state.lastSemanticOutputAt = now;
      }
      if (observation.activity === 'repaint_only') {
        state.lastRepaintOnlyAt = now;
      }
    });

    if (data && isInteractiveAiAppId(observation.appId)) {
      this.markAiTuiLaunchSucceeded(data);
    }
  }

  private updateDerivedState(
    id: string,
    reason: string,
    mutate: (state: SessionDerivedState) => void,
    options: DerivedStateSyncOptions = {},
  ): void {
    const data = this.sessions.get(id);
    if (!data) return;

    const state = this.ensureDerivedState(data);
    const previous = { ...state };
    mutate(state);

    this.syncStatusFromDerivedState(id, options);
  }

  private syncStatusFromDerivedState(id: string, options: DerivedStateSyncOptions = {}): void {
    const data = this.sessions.get(id);
    if (!data) return;

    if (data.idleTimer) {
      clearTimeout(data.idleTimer);
      data.idleTimer = null;
    }

    const derivedStatus = deriveDisplayStatus(this.ensureDerivedState(data));
    if (derivedStatus === 'idle' && !options.preservePendingRunningTransition) {
      this.cancelPendingRunningTransition(data);
    }
    this.updateStatus(id, derivedStatus, 'derived_state');
  }

  getSession(id: string): SessionDTO | null {
    const data = this.sessions.get(id);
    return data ? this.toDTO(data.session) : null;
  }

  getAllSessions(): SessionDTO[] {
    return Array.from(this.sessions.values()).map(data => this.toDTO(data.session));
  }

  // @req REL-BGSTAB-011, REL-BGSTAB-007
  getRetainedTerminalAuthorityState(sessionId: string): RetainedTerminalAuthorityState | undefined {
    const data = this.sessions.get(sessionId);
    if (!data) return undefined;
    const retained = this.ensureRetainedTerminalSessionState(data);
    if (!data.headless && !retained.lastCheckpoint) return undefined;
    return this.buildRetainedTerminalAuthorityState(sessionId, data);
  }

  // @req REL-BGSTAB-011 AC-9, REL-BGSTAB-007 AC-10
  getRetainedTerminalAuthorityAvailability(sessionId: string):
    | { availability: 'available' }
    | {
        availability: 'authority-degraded';
        reason: 'model-degradation';
        phase: HeadlessDegradedPhase;
        canaryBlockers: readonly string[];
      }
    | { availability: 'authority-unavailable'; reason: 'server-restart-or-session-missing' }
    | RetainedTerminalTerminationTombstone {
    const data = this.sessions.get(sessionId);
    if (data?.headlessHealth === 'degraded') {
      return {
        availability: 'authority-degraded',
        reason: 'model-degradation',
        phase: data.headlessDegradedPhase ?? 'write',
        canaryBlockers: ['model-degradation'],
      };
    }
    if (data) return { availability: 'available' };
    return this.retainedTerminalTerminationTombstones.get(sessionId)
      ?? { availability: 'authority-unavailable', reason: 'server-restart-or-session-missing' };
  }

  getRetainedTerminalGenerationRejectionState(
    sessionId: string,
    authorityEpoch: string,
  ): RetainedTerminalGenerationRejectionState | undefined {
    const state = this.retainedTerminalGenerationRejections.get(
      this.getRetainedTerminalGenerationRejectionKey(sessionId, authorityEpoch),
    );
    return state ? { ...state } : undefined;
  }

  registerRetainedTerminalClientView(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
    options: { slow?: boolean } = {},
  ): { ok: boolean; reason: string } {
    const data = this.sessions.get(sessionId);
    if (!data) return { ok: false, reason: 'authority-unavailable' };
    const retained = data.retainedTerminal;
    if (retained.mode !== 'shadow' || !retained.shadowSettlement.admissionOpen) {
      return { ok: false, reason: 'shadow-disabled' };
    }
    const previous = retained.clients.get(clientId);
    if (previous && viewGeneration < previous.viewGeneration) {
      return { ok: false, reason: 'stale-view-generation' };
    }
    retained.clients.set(clientId, {
      clientId,
      viewGeneration,
      slow: options.slow ?? previous?.slow ?? false,
      pendingBytes: previous?.pendingBytes ?? 0,
      blocksModel: false,
      dataGapRequired: previous?.dataGapRequired ?? false,
      restoreNeeded: previous?.restoreNeeded ?? false,
      ready: previous?.ready ?? true,
    });
    if (previous?.viewGeneration !== viewGeneration) {
      const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
      runtime.serverRecoveryAcks.delete(clientId);
      runtime.serverCheckpointDeliveries.delete(clientId);
    }
    return { ok: true, reason: 'registered' };
  }

  unregisterRetainedTerminalClientView(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ): { ok: boolean; reason: string } {
    const data = this.sessions.get(sessionId);
    const retained = data?.retainedTerminal;
    const client = retained?.clients.get(clientId);
    if (!retained || !client) return { ok: false, reason: 'client-view-missing' };
    if (client.viewGeneration !== viewGeneration) return { ok: false, reason: 'stale-view-generation' };
    retained.clients.delete(clientId);
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    runtime.serverRecoveryAcks.delete(clientId);
    runtime.serverCheckpointDeliveries.delete(clientId);
    if (runtime.suspendedBrowserDriver?.clientId === clientId
      && runtime.suspendedBrowserDriver.viewGeneration === viewGeneration) {
      runtime.suspendedBrowserDriver = null;
    }
    if (retained.driverLease.ownerClientId === clientId && retained.driverViewGeneration === viewGeneration) {
      retained.driverLease = { ownerClientId: null, generation: retained.driverLease.generation, state: 'revoked' };
      retained.driverViewGeneration = null;
      if (runtime.driver.active === 'legacy-browser') {
        if (runtime.driver.activeLeaseId) runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
        runtime.driver.active = null;
        runtime.driver.activeLeaseId = null;
      }
      runtime.admission.mode = 'none';
      runtime.suspendedBrowserDriver = null;
      runtime.noLocalCacheEvidence = null;
      return { ok: true, reason: 'unregistered-driver-revoked' };
    }
    return { ok: true, reason: 'unregistered' };
  }

  claimRetainedTerminalDriverLease(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ): { ok: boolean; ownerClientId: string | null; generation: string; reason?: string; shadowOnly: boolean } {
    const data = this.sessions.get(sessionId);
    const retained = data?.retainedTerminal;
    if (!retained || retained.mode !== 'shadow') {
      return { ok: false, ownerClientId: null, generation: '0', reason: 'authority-unavailable', shadowOnly: true };
    }
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const replacingLegacyDriver = runtime.admission.mode === 'none'
      && runtime.driver.active === null
      && runtime.driver.activeLeaseId === null
      && runtime.responder.active === 'legacy-browser'
      && runtime.responder.legacyEnabled;
    if (runtime.admission.mode !== 'legacy' && !replacingLegacyDriver) {
      return {
        ok: false,
        ownerClientId: retained.driverLease.ownerClientId,
        generation: retained.driverLease.generation,
        reason: 'authority-admission-closed',
        shadowOnly: true,
      };
    }
    const client = retained.clients.get(clientId);
    if (!client || client.viewGeneration !== viewGeneration) {
      retained.blockers.add('driver-lease-failure');
      return { ok: false, ownerClientId: retained.driverLease.ownerClientId, generation: retained.driverLease.generation, reason: 'client-view-missing', shadowOnly: true };
    }
    if (retained.driverLease.ownerClientId && retained.driverLease.ownerClientId !== clientId) {
      retained.blockers.add('driver-lease-failure');
      return { ok: false, ownerClientId: retained.driverLease.ownerClientId, generation: retained.driverLease.generation, reason: 'driver-owned-by-other-client', shadowOnly: true };
    }
    if (retained.driverLease.state === 'active'
      && retained.driverLease.ownerClientId === clientId
      && retained.driverViewGeneration === viewGeneration) {
      return {
        ok: true,
        ownerClientId: clientId,
        generation: retained.driverLease.generation,
        shadowOnly: true,
      };
    }
    const generation = String(++retained.nextLeaseGeneration);
    retained.driverLease = { ownerClientId: clientId, generation, state: 'active' };
    retained.driverViewGeneration = viewGeneration;
    runtime.driver.active = 'legacy-browser';
    runtime.driver.activeLeaseId = `retained-browser:${clientId}:${viewGeneration}:${generation}`;
    runtime.suspendedBrowserDriver = { clientId, viewGeneration, leaseGeneration: generation };
    this.maybeOpenTerminalAuthorityCompatibilityAdmission(runtime);
    return { ok: true, ownerClientId: clientId, generation, shadowOnly: true };
  }

  establishRetainedTerminalMutationLease(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ):
    | {
        ok: true;
        sessionId: string;
        authorityEpoch: string;
        clientId: string;
        viewGeneration: number;
        leaseGeneration: string;
      }
    | { ok: false; reason: string } {
    const data = this.sessions.get(sessionId);
    if (!data) return { ok: false, reason: 'authority-unavailable' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(data.retainedTerminal);
    const replacingLegacyDriver = runtime.admission.mode === 'none'
      && runtime.driver.active === null
      && runtime.driver.activeLeaseId === null
      && runtime.responder.active === 'legacy-browser'
      && runtime.responder.legacyEnabled;
    if (runtime.admission.mode !== 'legacy' && !replacingLegacyDriver) {
      return { ok: false, reason: 'authority-admission-closed' };
    }
    const previousClientView = data.retainedTerminal.clients.get(clientId);
    const registration = this.registerRetainedTerminalClientView(sessionId, clientId, viewGeneration);
    if (!registration.ok) return { ok: false, reason: registration.reason };
    const lease = this.claimRetainedTerminalDriverLease(sessionId, clientId, viewGeneration);
    if (!lease.ok) {
      if (previousClientView) {
        data.retainedTerminal.clients.set(clientId, previousClientView);
      } else {
        this.unregisterRetainedTerminalClientView(sessionId, clientId, viewGeneration);
      }
      return { ok: false, reason: lease.reason ?? 'driver-lease-failure' };
    }
    return {
      ok: true,
      sessionId,
      authorityEpoch: data.authorityEpoch,
      clientId,
      viewGeneration,
      leaseGeneration: lease.generation,
    };
  }

  handoffRetainedTerminalDriverLease(
    sessionId: string,
    currentClientId: string,
    currentViewGeneration: number,
    nextClientId: string,
    nextViewGeneration: number,
    leaseGeneration: string,
  ): { ok: boolean; ownerClientId: string | null; generation: string; reason?: string; shadowOnly: boolean } {
    const data = this.sessions.get(sessionId);
    const retained = data?.retainedTerminal;
    const nextClient = retained?.clients.get(nextClientId);
    if (!retained || retained.driverLease.ownerClientId !== currentClientId
      || retained.driverViewGeneration !== currentViewGeneration
      || retained.driverLease.generation !== leaseGeneration
      || !nextClient || nextClient.viewGeneration !== nextViewGeneration) {
      retained?.blockers.add('driver-lease-failure');
      return { ok: false, ownerClientId: retained?.driverLease.ownerClientId ?? null, generation: retained?.driverLease.generation ?? '0', reason: 'stale-owner', shadowOnly: true };
    }
    const generation = String(++retained.nextLeaseGeneration);
    retained.driverLease = { ownerClientId: nextClientId, generation, state: 'active' };
    retained.driverViewGeneration = nextViewGeneration;
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    runtime.driver.active = 'legacy-browser';
    runtime.driver.activeLeaseId = `retained-browser:${nextClientId}:${nextViewGeneration}:${generation}`;
    runtime.suspendedBrowserDriver = {
      clientId: nextClientId,
      viewGeneration: nextViewGeneration,
      leaseGeneration: generation,
    };
    runtime.noLocalCacheEvidence = null;
    return { ok: true, ownerClientId: nextClientId, generation, shadowOnly: true };
  }

  releaseRetainedTerminalDriverLease(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
    leaseGeneration: string,
  ): { ok: boolean; ownerClientId: string | null; generation: string; reason?: string; shadowOnly: boolean } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained || retained.driverLease.ownerClientId !== clientId
      || retained.driverViewGeneration !== viewGeneration
      || retained.driverLease.generation !== leaseGeneration) {
      retained?.blockers.add('driver-lease-failure');
      return { ok: false, ownerClientId: retained?.driverLease.ownerClientId ?? null, generation: retained?.driverLease.generation ?? '0', reason: 'stale-owner', shadowOnly: true };
    }
    retained.driverLease = { ownerClientId: null, generation: retained.driverLease.generation, state: 'unclaimed' };
    retained.driverViewGeneration = null;
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.driver.activeLeaseId) runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
    runtime.driver.active = null;
    runtime.driver.activeLeaseId = null;
    runtime.suspendedBrowserDriver = null;
    runtime.noLocalCacheEvidence = null;
    return { ok: true, ownerClientId: null, generation: retained.driverLease.generation, shadowOnly: true };
  }

  observeRetainedTerminalDriverMutation(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
    leaseGeneration: string,
    _kind: 'input' | 'resize' | 'query-reply',
  ): { accepted: boolean; reason: string; shadowOnly: true } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) {
      this.recordRetainedTerminalLateMessage(sessionId);
      return { accepted: false, reason: 'authority-unavailable', shadowOnly: true };
    }
    if (retained.driverLease.ownerClientId !== clientId
      || retained.driverViewGeneration !== viewGeneration
      || retained.driverLease.generation !== leaseGeneration
      || retained.driverLease.state !== 'active') {
      retained.blockers.add('driver-lease-failure');
      return { accepted: false, reason: 'stale-owner', shadowOnly: true };
    }
    return { accepted: true, reason: 'accepted', shadowOnly: true };
  }

  // @req MIG-BGSTAB-002 AC-2 AC-5
  stopTerminalAuthorityNewAdmission(
    sessionId: string,
    input: { transitionEpoch: string },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (!isCanonicalOrdinal64(input.transitionEpoch)) {
      return { ok: false, reason: 'transition-epoch-invalid' };
    }
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const priorEpoch = runtime.admission.transitionEpoch;
    if (priorEpoch && isCanonicalOrdinal64(priorEpoch)
      && BigInt(input.transitionEpoch) < BigInt(priorEpoch)) {
      return { ok: false, reason: 'stale-transition-epoch' };
    }
    if (retained.driverLease.state === 'active'
      && retained.driverLease.ownerClientId
      && retained.driverViewGeneration !== null) {
      runtime.suspendedBrowserDriver = {
        clientId: retained.driverLease.ownerClientId,
        viewGeneration: retained.driverViewGeneration,
        leaseGeneration: retained.driverLease.generation,
      };
    }
    if (runtime.noLocalCacheEvidence?.transitionEpoch !== input.transitionEpoch) {
      runtime.noLocalCacheEvidence = null;
      runtime.limitedSessionSelected = false;
    }
    runtime.admission = { mode: 'none', transitionEpoch: input.transitionEpoch };
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-2 AC-3
  bindTerminalAuthorityServerDriverLease(
    sessionId: string,
    input: { driverLeaseId: string },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (input.driverLeaseId.length === 0) return { ok: false, reason: 'driver-lease-id-invalid' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.admission.mode === 'legacy') {
      return { ok: false, reason: 'new-admission-not-stopped' };
    }
    if (runtime.driver.revokedLeaseIds.has(input.driverLeaseId)) {
      return { ok: false, reason: 'driver-lease-revoked' };
    }
    if (retained.driverLease.state === 'active'
      && retained.driverLease.ownerClientId
      && retained.driverViewGeneration !== null) {
      runtime.suspendedBrowserDriver = {
        clientId: retained.driverLease.ownerClientId,
        viewGeneration: retained.driverViewGeneration,
        leaseGeneration: retained.driverLease.generation,
      };
    }
    if (runtime.driver.activeLeaseId && runtime.driver.activeLeaseId !== input.driverLeaseId) {
      runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
    }
    runtime.serverCheckpointDeliveries.clear();
    retained.driverLease = {
      ownerClientId: null,
      generation: retained.driverLease.generation,
      state: 'revoked',
    };
    retained.driverViewGeneration = null;
    runtime.driver.active = 'server-headless';
    runtime.driver.activeLeaseId = input.driverLeaseId;
    this.maybeOpenTerminalAuthorityServerAdmission(runtime);
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-2 AC-3 AC-5
  setTerminalAuthorityServerResponderEnabled(
    sessionId: string,
    input: { enabled: boolean; responderLeaseId: string },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (input.responderLeaseId.length === 0) return { ok: false, reason: 'responder-lease-id-invalid' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (input.enabled) {
      if (runtime.admission.mode === 'legacy') {
        return { ok: false, reason: 'new-admission-not-stopped' };
      }
      if (runtime.responder.revokedLeaseIds.has(input.responderLeaseId)) {
        return { ok: false, reason: 'responder-lease-revoked' };
      }
      if (runtime.responder.activeLeaseId
        && runtime.responder.activeLeaseId !== input.responderLeaseId) {
        runtime.responder.revokedLeaseIds.add(runtime.responder.activeLeaseId);
      }
      runtime.serverCheckpointDeliveries.clear();
      runtime.responder.active = 'server-headless';
      runtime.responder.activeLeaseId = input.responderLeaseId;
      runtime.responder.legacyEnabled = false;
      runtime.responder.serverEnabled = true;
      this.maybeOpenTerminalAuthorityServerAdmission(runtime);
      return { ok: true };
    }
    if (runtime.responder.activeLeaseId !== input.responderLeaseId
      || runtime.responder.active !== 'server-headless') {
      if (!runtime.responder.serverEnabled && runtime.responder.activeLeaseId === null) {
        return { ok: true };
      }
      return runtime.responder.revokedLeaseIds.has(input.responderLeaseId)
        ? { ok: true }
        : { ok: false, reason: 'responder-lease-not-active' };
    }
    runtime.responder.active = null;
    runtime.responder.activeLeaseId = null;
    runtime.responder.serverEnabled = false;
    runtime.serverCheckpointDeliveries.clear();
    runtime.admission.mode = 'none';
    return { ok: true };
  }

  // @req REL-BGSTAB-007 AC-4 AC-5
  rotateTerminalAuthorityServerEpoch(
    sessionId: string,
    input: {
      streamEpoch: string;
      responderLeaseId: string;
      driverLeaseId: string;
    },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (!isCanonicalOrdinal64(input.streamEpoch)
      || input.responderLeaseId.length === 0
      || input.driverLeaseId.length === 0) {
      return { ok: false, reason: 'server-epoch-identity-invalid' };
    }
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.admission.mode !== 'server'
      || !runtime.admission.transitionEpoch
      || !isCanonicalOrdinal64(runtime.admission.transitionEpoch)
      || BigInt(input.streamEpoch) <= BigInt(runtime.admission.transitionEpoch)
      || runtime.driver.active !== 'server-headless'
      || runtime.responder.active !== 'server-headless'
      || !runtime.responder.serverEnabled) {
      return { ok: false, reason: 'server-epoch-rotation-stale' };
    }
    if (runtime.driver.revokedLeaseIds.has(input.driverLeaseId)
      || runtime.responder.revokedLeaseIds.has(input.responderLeaseId)) {
      return { ok: false, reason: 'server-epoch-lease-revoked' };
    }
    if (runtime.driver.activeLeaseId && runtime.driver.activeLeaseId !== input.driverLeaseId) {
      runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
    }
    if (runtime.responder.activeLeaseId && runtime.responder.activeLeaseId !== input.responderLeaseId) {
      runtime.responder.revokedLeaseIds.add(runtime.responder.activeLeaseId);
    }
    runtime.serverCheckpointDeliveries.clear();
    runtime.serverRecoveryAcks.clear();
    runtime.noLocalCacheEvidence = null;
    runtime.limitedSessionSelected = false;
    retained.driverLease = {
      ownerClientId: null,
      generation: retained.driverLease.generation,
      state: 'revoked',
    };
    retained.driverViewGeneration = null;
    runtime.admission = { mode: 'none', transitionEpoch: input.streamEpoch };
    runtime.driver.active = 'server-headless';
    runtime.driver.activeLeaseId = input.driverLeaseId;
    runtime.responder.active = 'server-headless';
    runtime.responder.activeLeaseId = input.responderLeaseId;
    runtime.responder.legacyEnabled = false;
    runtime.responder.serverEnabled = true;
    this.maybeOpenTerminalAuthorityServerAdmission(runtime);
    return { ok: true };
  }

  // @req REL-BGSTAB-007 AC-4 AC-5
  recordTerminalAuthorityServerCheckpointDelivery(
    sessionId: string,
    input: TerminalAuthorityServerCheckpointDeliveryProof,
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained || input.sessionId !== sessionId) {
      return { ok: false, reason: 'authority-unavailable' };
    }
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const client = retained.clients.get(input.clientId);
    if (!client || client.viewGeneration !== input.viewGeneration) {
      return { ok: false, reason: 'checkpoint-delivery-view-stale' };
    }
    if (
      input.protocolVersion !== 1
      || !isCanonicalOrdinal64(input.transitionEpoch)
      || !isCanonicalOrdinal64(input.streamEpoch)
      || !isCanonicalOrdinal64(input.checkpointEpoch)
      || !isCanonicalOrdinal64(input.sourceSeq)
      || !isCanonicalOrdinal64(input.snapshotSeq)
      || !isCanonicalOrdinal64(input.oldestRetainedSeq)
      || !isCanonicalOrdinal64(input.retainedStreamEpoch)
      || !isCanonicalOrdinal64(input.retainedSourceSeq)
      || (input.boundarySourceSeq !== undefined && !isCanonicalOrdinal64(input.boundarySourceSeq))
      || input.connectionId.length === 0
      || input.authorityEpoch.length === 0
      || input.retentionPolicyId.length === 0
    ) {
      return { ok: false, reason: 'checkpoint-delivery-identity-invalid' };
    }
    if (runtime.admission.mode !== 'server') {
      return { ok: false, reason: 'checkpoint-delivery-admission-stale' };
    }
    if (runtime.admission.transitionEpoch !== input.transitionEpoch) {
      return { ok: false, reason: 'checkpoint-delivery-transition-stale' };
    }
    if (runtime.driver.active !== 'server-headless' || runtime.driver.activeLeaseId !== input.driverLeaseId) {
      return { ok: false, reason: 'checkpoint-delivery-driver-stale' };
    }
    if (
      runtime.responder.active !== 'server-headless'
      || runtime.responder.activeLeaseId !== input.responderLeaseId
      || !runtime.responder.serverEnabled
    ) {
      return { ok: false, reason: 'checkpoint-delivery-responder-stale' };
    }
    runtime.serverCheckpointDeliveries.set(input.clientId, { ...input });
    return { ok: true };
  }

  // @req REL-BGSTAB-007 AC-4 AC-5
  invalidateTerminalAuthorityServerCheckpointDelivery(
    sessionId: string,
    input: { clientId: string; viewGeneration: number },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const delivery = runtime.serverCheckpointDeliveries.get(input.clientId);
    if (delivery?.viewGeneration === input.viewGeneration) {
      runtime.serverCheckpointDeliveries.delete(input.clientId);
    }
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-5
  revokeTerminalAuthorityResponderLease(
    sessionId: string,
    input: { responderLeaseId: string },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (input.responderLeaseId.length === 0) return { ok: false, reason: 'responder-lease-id-invalid' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    runtime.responder.revokedLeaseIds.add(input.responderLeaseId);
    if (runtime.responder.activeLeaseId === input.responderLeaseId) {
      const active = runtime.responder.active;
      runtime.responder.active = null;
      runtime.responder.activeLeaseId = null;
      if (active === 'server-headless') runtime.responder.serverEnabled = false;
      if (active === 'legacy-browser') runtime.responder.legacyEnabled = false;
    }
    runtime.serverCheckpointDeliveries.clear();
    runtime.admission.mode = 'none';
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-2 AC-5
  revokeTerminalAuthorityDriverLease(
    sessionId: string,
    input: { driverLeaseId: string },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (input.driverLeaseId.length === 0) return { ok: false, reason: 'driver-lease-id-invalid' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.driver.activeLeaseId !== input.driverLeaseId) {
      return runtime.driver.revokedLeaseIds.has(input.driverLeaseId)
        ? { ok: true }
        : { ok: false, reason: 'driver-lease-not-active' };
    }
    runtime.driver.revokedLeaseIds.add(input.driverLeaseId);
    if (runtime.driver.active === 'legacy-browser') {
      retained.driverLease = {
        ownerClientId: null,
        generation: retained.driverLease.generation,
        state: 'revoked',
      };
      retained.driverViewGeneration = null;
    }
    runtime.driver.active = null;
    runtime.driver.activeLeaseId = null;
    runtime.serverCheckpointDeliveries.clear();
    runtime.admission.mode = 'none';
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-5
  rebindTerminalAuthorityCompatibilityDriverLease(
    sessionId: string,
    input: {
      driverLeaseId: string;
      clientId?: string;
      viewGeneration?: number;
      leaseGeneration?: string;
    },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.admission.mode !== 'none') return { ok: false, reason: 'rollback-admission-not-closed' };
    if (input.driverLeaseId.length === 0 || runtime.driver.revokedLeaseIds.has(input.driverLeaseId)) {
      return { ok: false, reason: 'driver-lease-id-invalid' };
    }
    const suspended = runtime.suspendedBrowserDriver;
    const clientId = input.clientId ?? suspended?.clientId;
    const viewGeneration = input.viewGeneration ?? suspended?.viewGeneration;
    const leaseGeneration = input.leaseGeneration ?? suspended?.leaseGeneration;
    if (!clientId || viewGeneration === undefined || !Number.isSafeInteger(viewGeneration)
      || viewGeneration < 0 || !isCanonicalOrdinal64(leaseGeneration)) {
      return { ok: false, reason: 'compatibility-driver-identity-invalid' };
    }
    const client = retained.clients.get(clientId);
    if (!client || client.viewGeneration !== viewGeneration) {
      return { ok: false, reason: 'compatibility-driver-view-missing' };
    }
    retained.nextLeaseGeneration = BigInt(leaseGeneration) > retained.nextLeaseGeneration
      ? BigInt(leaseGeneration)
      : retained.nextLeaseGeneration;
    retained.driverLease = { ownerClientId: clientId, generation: leaseGeneration, state: 'active' };
    retained.driverViewGeneration = viewGeneration;
    runtime.driver.active = 'legacy-browser';
    runtime.driver.activeLeaseId = input.driverLeaseId;
    runtime.suspendedBrowserDriver = { clientId, viewGeneration, leaseGeneration };
    this.maybeOpenTerminalAuthorityCompatibilityAdmission(runtime);
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-5
  rebindTerminalAuthorityCompatibilityResponderLease(
    sessionId: string,
    input: { responderLeaseId: string },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const replacingLegacyResponder = runtime.admission.mode === 'legacy'
      && runtime.driver.active === 'legacy-browser'
      && runtime.driver.activeLeaseId !== null
      && runtime.responder.active === 'legacy-browser'
      && runtime.responder.legacyEnabled;
    if (runtime.admission.mode !== 'none' && !replacingLegacyResponder) {
      return { ok: false, reason: 'rollback-admission-not-closed' };
    }
    if (input.responderLeaseId.length === 0
      || runtime.responder.revokedLeaseIds.has(input.responderLeaseId)) {
      return { ok: false, reason: 'responder-lease-id-invalid' };
    }
    runtime.responder.active = 'legacy-browser';
    runtime.responder.activeLeaseId = input.responderLeaseId;
    runtime.responder.legacyEnabled = true;
    runtime.responder.serverEnabled = false;
    this.maybeOpenTerminalAuthorityCompatibilityAdmission(runtime);
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-1 AC-4
  recordTerminalAuthorityServerRecoveryApplied(
    sessionId: string,
    input: {
      clientId: string;
      viewGeneration: number;
      replayToken: string;
      snapshotSeq: number;
      snapshotMode: 'authoritative' | 'fallback';
      snapshotTruncated: boolean;
      queuedOutputBytes: number;
      queuedOutputTruncated: boolean;
    },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    const registered = retained.clients.get(input.clientId);
    if (!registered || registered.viewGeneration !== input.viewGeneration) {
      return { ok: false, reason: 'server-recovery-view-stale' };
    }
    if (input.replayToken.length === 0
      || !Number.isSafeInteger(input.snapshotSeq)
      || input.snapshotSeq < 0) {
      return { ok: false, reason: 'server-recovery-ack-invalid' };
    }
    if (input.snapshotMode !== 'authoritative' || input.snapshotTruncated) {
      return { ok: false, reason: 'server-recovery-not-authoritative' };
    }
    if (input.queuedOutputTruncated || input.queuedOutputBytes !== 0) {
      return { ok: false, reason: 'server-recovery-tail-not-drained' };
    }
    this.ensureTerminalAuthorityRuntimePortState(retained).serverRecoveryAcks.set(input.clientId, {
      authorityEpoch: retained.streamEpoch,
      viewGeneration: input.viewGeneration,
      replayToken: input.replayToken,
      snapshotSeq: input.snapshotSeq,
      postSnapshotTailDrained: true,
    });
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-1 AC-4
  prepareTerminalAuthorityPromotionCandidate(
    sessionId: string,
    input: {
      transitionEpoch: string;
      limitedSessionSelected: boolean;
    },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    if (!isCanonicalOrdinal64(input.transitionEpoch)
      || input.limitedSessionSelected !== true) {
      return { ok: false, reason: 'promotion-candidate-evidence-invalid' };
    }
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.admission.mode !== 'legacy') {
      return { ok: false, reason: 'promotion-candidate-admission-not-legacy' };
    }
    if (retained.clients.size === 0
      || [...retained.clients.values()].some(view => {
        const recoveryAck = runtime.serverRecoveryAcks.get(view.clientId);
        return recoveryAck?.authorityEpoch !== retained.streamEpoch
          || recoveryAck.viewGeneration !== view.viewGeneration
          || recoveryAck.postSnapshotTailDrained !== true;
      })) {
      return { ok: false, reason: 'server-recovery-ack-missing' };
    }
    runtime.admission.transitionEpoch = input.transitionEpoch;
    runtime.noLocalCacheEvidence = {
      transitionEpoch: input.transitionEpoch,
      cacheState: 'server-replay-ack',
      source: 'server-replay-ready-ack-zero-tail',
      localCacheUsed: false,
      serverCheckpointApplied: true,
      postSnapshotTailDrained: true,
      tailBytesAtAck: 0,
      acknowledgedViewCount: retained.clients.size,
    };
    runtime.limitedSessionSelected = true;
    return { ok: true };
  }

  // @req MIG-BGSTAB-002 AC-1 AC-3 AC-4
  readTerminalAuthorityPromotionParitySnapshot(
    sessionId: string,
  ): TerminalAuthorityPromotionParitySnapshot {
    const data = this.sessions.get(sessionId);
    if (!data) {
      return {
        retainedStateParity: false,
        factParity: false,
        leaseParity: false,
        noLocalCacheParity: false,
        limitedSessionSelected: false,
        blockers: ['authority-unavailable'],
        diagnosticBlockers: [],
      };
    }
    const retained = this.ensureRetainedTerminalSessionState(data);
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const principalAxes = [
      retained.comparer.axes.logicalLines,
      retained.comparer.axes.cells,
      retained.comparer.axes.unicodeWidth,
      retained.comparer.axes.cursor,
      retained.comparer.axes.modes,
      retained.comparer.axes.activeBuffer,
    ];
    const comparerMismatch = principalAxes.some(axis => axis === 'mismatch');
    const comparerReady = principalAxes.every(axis => axis === 'match');
    const parserEquivalent = retained.comparer.axes.parserTail === 'match'
      || retained.lastCheckpoint?.pendingEscapeTailAnsi === data.pendingEscapeTailAnsi;
    const evictionEquivalent = retained.comparer.axes.eviction === 'match'
      || (retained.eviction.completeLogicalRowBoundary && !retained.eviction.restoreNeeded);
    const retainedStateParity = data.headlessHealth === 'healthy'
      && data.headless !== null
      && retained.mode === 'shadow'
      && comparerReady
      && !comparerMismatch
      && parserEquivalent
      && evictionEquivalent
      && !retained.blockers.has('model-degradation');
    const factParity = retained.records.every(record => record.modelCommitted && !record.rejectionReason)
      && retained.facts.every(fact => fact.kind === 'query-request' || fact.disposition !== 'rejected');
    const browserDriver = runtime.suspendedBrowserDriver;
    const registeredDriver = browserDriver
      ? retained.clients.get(browserDriver.clientId)
      : undefined;
    const leaseParity = runtime.admission.mode === 'legacy'
      && runtime.recoveryRequiredReason === null
      && runtime.driver.active === 'legacy-browser'
      && runtime.driver.activeLeaseId !== null
      && retained.driverLease.state === 'active'
      && retained.driverLease.ownerClientId === browserDriver?.clientId
      && retained.driverViewGeneration === browserDriver?.viewGeneration
      && retained.driverLease.generation === browserDriver?.leaseGeneration
      && registeredDriver?.viewGeneration === browserDriver?.viewGeneration;
    const noLocalCacheParity = runtime.noLocalCacheEvidence !== null
      && runtime.noLocalCacheEvidence.transitionEpoch === runtime.admission.transitionEpoch
      && runtime.noLocalCacheEvidence.localCacheUsed === false
      && runtime.noLocalCacheEvidence.serverCheckpointApplied === true
      && runtime.noLocalCacheEvidence.postSnapshotTailDrained === true
      && runtime.noLocalCacheEvidence.tailBytesAtAck === 0;
    const blockers: string[] = [];
    if (!retainedStateParity) {
      blockers.push(comparerMismatch
        ? 'retained-state-parity-mismatch'
        : 'retained-state-parity-unavailable');
    }
    if (!factParity) blockers.push('fact-parity-unavailable');
    if (!leaseParity) blockers.push('driver-lease-missing');
    if (!noLocalCacheParity) blockers.push('no-local-cache-parity-missing');
    if (!runtime.limitedSessionSelected) blockers.push('limited-session-not-selected');
    if (runtime.recoveryRequiredReason) blockers.push(runtime.recoveryRequiredReason);
    return {
      retainedStateParity,
      factParity,
      leaseParity,
      noLocalCacheParity,
      limitedSessionSelected: runtime.limitedSessionSelected,
      blockers,
      diagnosticBlockers: [...retained.blockers].sort(),
    };
  }

  // @req MIG-BGSTAB-002 AC-5
  cleanupTerminalAuthorityRuntimePorts(
    sessionId: string,
    input: { scope: 'rollback-complete' | 'reconnect' },
  ): { ok: boolean; reason?: string } {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return { ok: false, reason: 'authority-unavailable' };
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (input.scope === 'rollback-complete') {
      if (runtime.driver.active !== 'legacy-browser'
        || runtime.responder.active !== 'legacy-browser'
        || retained.driverLease.state !== 'active') {
        return { ok: false, reason: 'compatibility-bindings-incomplete' };
      }
      runtime.admission.mode = 'legacy';
      runtime.noLocalCacheEvidence = null;
      runtime.limitedSessionSelected = false;
      return { ok: true };
    }
    if (runtime.driver.activeLeaseId) runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
    if (runtime.responder.activeLeaseId) runtime.responder.revokedLeaseIds.add(runtime.responder.activeLeaseId);
    retained.driverLease = {
      ownerClientId: null,
      generation: retained.driverLease.generation,
      state: 'revoked',
    };
    retained.driverViewGeneration = null;
    retained.clients.clear();
    runtime.driver.active = null;
    runtime.driver.activeLeaseId = null;
    runtime.responder.active = null;
    runtime.responder.activeLeaseId = null;
    runtime.responder.legacyEnabled = false;
    runtime.responder.serverEnabled = false;
    runtime.suspendedBrowserDriver = null;
    runtime.serverRecoveryAcks.clear();
    runtime.serverCheckpointDeliveries.clear();
    runtime.noLocalCacheEvidence = null;
    runtime.limitedSessionSelected = false;
    runtime.admission.mode = 'none';
    runtime.reconnectGeneration += 1;
    return { ok: true };
  }

  getTerminalAuthorityRuntimePortState(
    sessionId: string,
  ): TerminalAuthorityRuntimePortState | undefined {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained) return undefined;
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    return {
      admission: { ...runtime.admission },
      responder: {
        active: runtime.responder.active,
        activeLeaseId: runtime.responder.activeLeaseId,
        legacyEnabled: runtime.responder.legacyEnabled,
        serverEnabled: runtime.responder.serverEnabled,
        revokedLeaseIds: [...runtime.responder.revokedLeaseIds],
      },
      driver: {
        active: runtime.driver.active,
        activeLeaseId: runtime.driver.activeLeaseId,
        revokedLeaseIds: [...runtime.driver.revokedLeaseIds],
      },
      suspendedBrowserDriver: runtime.suspendedBrowserDriver
        ? { ...runtime.suspendedBrowserDriver }
        : null,
      limitedSessionSelected: runtime.limitedSessionSelected,
      noLocalCacheParityPrepared: runtime.noLocalCacheEvidence !== null,
      reconnectGeneration: runtime.reconnectGeneration,
      recoveryRequiredReason: runtime.recoveryRequiredReason,
    };
  }

  getTerminalAuthoritySuspendedBrowserMutationLease(
    sessionId: string,
  ): RetainedTerminalMutationIdentity | null {
    const data = this.sessions.get(sessionId);
    if (!data) return null;
    const retained = this.ensureRetainedTerminalSessionState(data);
    const suspended = this.ensureTerminalAuthorityRuntimePortState(retained).suspendedBrowserDriver;
    if (!suspended
      || retained.clients.get(suspended.clientId)?.viewGeneration !== suspended.viewGeneration) {
      return null;
    }
    return {
      clientId: suspended.clientId,
      authorityEpoch: data.authorityEpoch,
      viewGeneration: suspended.viewGeneration,
      leaseGeneration: suspended.leaseGeneration,
    };
  }

  rotateTerminalAuthoritySuspendedBrowserMutationLease(
    sessionId: string,
    input: { clientId: string; viewGeneration: number },
  ): RetainedTerminalMutationIdentity | null {
    const data = this.sessions.get(sessionId);
    if (!data) return null;
    const retained = this.ensureRetainedTerminalSessionState(data);
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const registered = retained.clients.get(input.clientId);
    if (runtime.admission.mode !== 'server'
      || runtime.driver.active !== 'server-headless'
      || registered?.viewGeneration !== input.viewGeneration) {
      return null;
    }
    const leaseGeneration = String(++retained.nextLeaseGeneration);
    runtime.suspendedBrowserDriver = {
      clientId: input.clientId,
      viewGeneration: input.viewGeneration,
      leaseGeneration,
    };
    return {
      clientId: input.clientId,
      authorityEpoch: data.authorityEpoch,
      viewGeneration: input.viewGeneration,
      leaseGeneration,
    };
  }

  private acceptRetainedTerminalMutationIdentity(
    data: SessionData,
    identity: RetainedTerminalMutationIdentity | undefined,
  ): boolean {
    const retained = this.ensureRetainedTerminalSessionState(data);
    if (retained.mode !== 'shadow') return true;
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (!identity) {
      // Compatibility is intentionally retained during shadow rollout, but the
      // session may not be promoted while any real mutation bypasses fencing.
      // Once server authority is active, every browser-originated user
      // mutation must still prove the exact browser binding that was suspended
      // at the positional handoff.
      retained.blockers.add('mutation-identity-missing');
      return runtime.admission.mode !== 'server';
    }
    if (identity.authorityEpoch !== data.authorityEpoch) {
      this.recordRetainedTerminalLateMessage(data.session.id, identity.authorityEpoch, 'stale-mutation');
    }
    const client = retained.clients.get(identity.clientId);
    const exactRegisteredView = identity.authorityEpoch === data.authorityEpoch
      && client?.viewGeneration === identity.viewGeneration
      && client.clientId === identity.clientId;
    const suspended = runtime.suspendedBrowserDriver;
    const serverAuthorityUserMutation = runtime.admission.mode === 'server'
      && runtime.driver.active === 'server-headless'
      && runtime.responder.active === 'server-headless'
      && runtime.responder.serverEnabled
      && suspended?.clientId === identity.clientId
      && suspended.viewGeneration === identity.viewGeneration
      && suspended.leaseGeneration === identity.leaseGeneration;
    const legacyDriverMutation = runtime.admission.mode !== 'server'
      && retained.driverLease.state === 'active'
      && retained.driverLease.ownerClientId === identity.clientId
      && retained.driverViewGeneration === identity.viewGeneration
      && retained.driverLease.generation === identity.leaseGeneration;
    const accepted = exactRegisteredView && (serverAuthorityUserMutation || legacyDriverMutation);
    if (!accepted) retained.blockers.add('driver-lease-failure');
    return accepted;
  }

  setRetainedTerminalShadowEnabled(enabled: boolean): boolean {
    this.retainedTerminalShadowEnabled = enabled;
    if (enabled) {
      for (const data of this.sessions.values()) {
        const retained = data.retainedTerminal;
        if (retained.mode === 'shadow') continue;
        retained.mode = 'shadow';
        retained.blockers.delete('shadow-disabled');
        retained.blockers.add('independent-baseline-unavailable');
        retained.blockers.add('retained-authority-delivery-inactive');
        retained.blockers.add('aggregate-model-memory-budget-unavailable');
        retained.blockers.add('checkpoint-chunk-budget-unavailable');
        retained.shadowSettlement = {
          admissionOpen: true,
          settled: false,
          factLedgerSettlements: 0,
          checkpointLedgerSettlements: 0,
          timerSettlements: 0,
        };
        retained.cleanup.admissionOpen = true;
        retained.cleanup.settled = false;
        const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
        runtime.admission = { mode: 'legacy', transitionEpoch: null };
        runtime.responder.active = 'legacy-browser';
        runtime.responder.activeLeaseId = null;
        runtime.responder.legacyEnabled = true;
        runtime.responder.serverEnabled = false;
        runtime.driver.active = null;
        runtime.driver.activeLeaseId = null;
        runtime.suspendedBrowserDriver = null;
        runtime.serverRecoveryAcks.clear();
        runtime.noLocalCacheEvidence = null;
        runtime.limitedSessionSelected = false;
        runtime.recoveryRequiredReason = null;
      }
      return true;
    }
    for (const data of this.sessions.values()) {
      const retained = data.retainedTerminal;
      if (retained.mode === 'disabled') continue;
      retained.mode = 'disabled';
      retained.records = [];
      retained.facts = [];
      retained.committedFactKeys.clear();
      retained.ledgerEncodedBytes = 4;
      retained.ledgerRecordEncodedBytes = 0;
      retained.ledgerFactEncodedBytes = 0;
      retained.ledgerFactKeyEncodedBytes = 0;
      if (retained.comparisonTimer) clearTimeout(retained.comparisonTimer);
      retained.comparisonTimer = null;
      retained.comparisonPendingSourceSeq = null;
      retained.clients.clear();
      retained.driverLease = { ownerClientId: null, generation: retained.driverLease.generation, state: 'revoked' };
      retained.driverViewGeneration = null;
      const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
      if (runtime.driver.activeLeaseId) runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
      runtime.driver.active = null;
      runtime.driver.activeLeaseId = null;
      runtime.suspendedBrowserDriver = null;
      runtime.admission = { mode: 'none', transitionEpoch: runtime.admission.transitionEpoch };
      runtime.responder.active = null;
      runtime.responder.activeLeaseId = null;
      runtime.responder.legacyEnabled = false;
      runtime.responder.serverEnabled = false;
      runtime.noLocalCacheEvidence = null;
      runtime.limitedSessionSelected = false;
      retained.blockers.add('shadow-disabled');
      retained.shadowSettlement = {
        admissionOpen: false,
        settled: true,
        factLedgerSettlements: 1,
        checkpointLedgerSettlements: 1,
        timerSettlements: 1,
      };
    }
    return true;
  }

  deleteSession(id: string, reason: SessionCleanupReason = 'direct-session-delete'): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    return this.finalizeSession(id, data, {
      reason,
      exitCode: null,
      killPty: true,
      emitExited: false,
    });
  }

  async terminateSession(
    id: string,
    options: {
      reason: SessionCleanupReason;
      mode?: SessionProcessCleanupConfig['mode'];
      waitMs?: number;
      killPty?: boolean;
      emitExited?: boolean;
    },
  ): Promise<boolean> {
    const data = this.sessions.get(id);
    if (!data) return false;

    const cleanupConfig = this.runtimeSessionConfig.processCleanup;
    const mode = options.mode ?? cleanupConfig.mode;
    let cleanupOverride: SessionFinalizerOptions['cleanupOverride'];

    if (mode === 'enforce') {
      data.pendingTermination = {
        reason: options.reason,
        exitCode: null,
        exitObserved: false,
      };
      try {
        const result = await this.processTreeTerminator.terminate(data.processMetadata, {
          gracefulWaitMs: options.waitMs ?? cleanupConfig.gracefulWaitMs,
          forceWaitMs: cleanupConfig.forceWaitMs,
          descendantSampleLimit: cleanupConfig.descendantSampleLimit,
        });
        cleanupOverride = this.toCleanupOverride(result);
      } catch (error) {
        console.warn('[SessionManager] Process-tree termination failed:', error);
        cleanupOverride = {
          status: 'failed',
          remainingDescendants: data.processMetadata.rootPid === null ? 0 : 1,
          verifiedRemainingDescendants: data.processMetadata.rootPid === null ? 0 : 1,
          unverifiedRemainingDescendants: 0,
        };
      }
    }

    const pendingTermination = data.pendingTermination;
    try {
      return this.finalizeSession(id, data, {
        reason: options.reason,
        exitCode: pendingTermination?.exitCode ?? null,
        killPty: options.killPty ?? !pendingTermination?.exitObserved,
        emitExited: options.emitExited ?? false,
        cleanupMode: mode,
        cleanupOverride,
      });
    } finally {
      data.pendingTermination = null;
    }
  }

  getDebugCapture(sessionId: string, limit = 200): SessionDebugCaptureEvent[] {
    const events = this.debugCaptureBySession.get(sessionId) ?? [];
    return events.slice(-Math.max(1, limit));
  }

  enableDebugCapture(sessionId: string): void {
    this.clearDebugCapture(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.echoTracker.recentInputs = [];
    }
    this.debugCaptureEnabledSessions.add(sessionId);
  }

  disableDebugCapture(sessionId: string): void {
    this.debugCaptureEnabledSessions.delete(sessionId);
  }

  isDebugCaptureEnabled(sessionId: string): boolean {
    return this.debugCaptureEnabledSessions.has(sessionId);
  }

  clearDebugCapture(sessionId: string): void {
    this.debugCaptureBySession.delete(sessionId);
  }

  writeInput(
    id: string,
    input: string,
    clientMetadata?: InputDebugMetadata,
    inputSequence?: { inputSeqStart?: number; inputSeqEnd?: number },
    retainedIdentity?: RetainedTerminalMutationIdentity,
  ): boolean {
    const data = this.sessions.get(id);
    if (!data) {
      this.recordRetainedTerminalLateMessage(id);
      return false;
    }
    if (!this.acceptRetainedTerminalMutationIdentity(data, retainedIdentity)) return false;
    const inputDebugDetails: Record<string, InputDebugValue> = {
      ...buildInputDebugDetails(input, clientMetadata),
      ...(typeof inputSequence?.inputSeqStart === 'number' ? { inputSeqStart: inputSequence.inputSeqStart } : {}),
      ...(typeof inputSequence?.inputSeqEnd === 'number' ? { inputSeqEnd: inputSequence.inputSeqEnd } : {}),
    };
    const shouldCaptureInputDebug = this.isDebugCaptureEnabled(id);
    if (shouldCaptureInputDebug) {
      this.captureDebugEvent(id, 'pty', 'input', inputDebugDetails, formatSafeInputPreview(input) ?? undefined);
    }

    // Step 9: 에코 추적 정보 기록 (pty.write 전에 기록)
    const hasEnter = input.includes('\r') || input.includes('\n');
    const isControlInterrupt = !hasEnter
      && stripInputTrackingControlSequences(input).includes('\x03');
    const interruptedPrintableDraft = isControlInterrupt
      ? data.echoTracker.lastUnsubmittedPrintableInput
      : undefined;
    const interruptedPrintablePrefix = isControlInterrupt
      ? data.echoTracker.unsubmittedPrintableEchoPrefix
      : undefined;
    const submittedCommand = this.updateCommandInputBuffer(data, input);
    const derivedState = this.ensureDerivedState(data);
    const isAiForeground = this.isInteractiveForeground(data, derivedState);
    const hintedAppId = submittedCommand && !isAiForeground ? detectForegroundAppHint(submittedCommand) : null;
    if (submittedCommand) {
      data.lastSubmittedCommand = submittedCommand;
      if (!isAiForeground) {
        if (hintedAppId) {
          data.pendingForegroundAppHint = hintedAppId;
          data.aiTuiLaunchAttempt = {
            appId: hintedAppId,
            command: submittedCommand,
            executable: getCommandExecutableToken(submittedCommand) ?? hintedAppId,
            startedAt: Date.now(),
          };
        } else {
          delete data.pendingForegroundAppHint;
          delete data.aiTuiLaunchAttempt;
        }
      }
    }
    const inputAt = Date.now();
    data.echoTracker.lastInputAt = inputAt;
    data.echoTracker.lastInputHasEnter = hasEnter;
    data.echoTracker.lastInputWasControlInterrupt = isControlInterrupt;
    if (hasEnter) {
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
      delete data.echoTracker.interruptedUnsubmittedPrintableInput;
      delete data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
    } else if (isControlInterrupt) {
      if (interruptedPrintableDraft) {
        data.echoTracker.interruptedUnsubmittedPrintableInput = interruptedPrintableDraft;
        if (interruptedPrintablePrefix) {
          data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix = interruptedPrintablePrefix;
        } else {
          delete data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
        }
      } else {
        delete data.echoTracker.interruptedUnsubmittedPrintableInput;
        delete data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
      }
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
    } else if (!data.inputBuffer) {
      delete data.echoTracker.lastUnsubmittedPrintableInput;
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
      delete data.echoTracker.interruptedUnsubmittedPrintableInput;
      delete data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
    } else if (data.echoTracker.lastUnsubmittedPrintableInput?.value !== data.inputBuffer) {
      data.echoTracker.lastUnsubmittedPrintableInput = {
        value: data.inputBuffer,
      };
      delete data.echoTracker.unsubmittedPrintableEchoPrefix;
      this.clearDeferredBareUnsubmittedPrintableEcho(data);
      delete data.echoTracker.interruptedUnsubmittedPrintableInput;
      delete data.echoTracker.interruptedUnsubmittedPrintableEchoPrefix;
    }
    if (shouldCaptureInputDebug) {
      data.echoTracker.recentInputs.push({
        at: data.echoTracker.lastInputAt,
        hasEnter,
        inputClass: String(inputDebugDetails.inputClass ?? 'safe-control'),
      });
      if (data.echoTracker.recentInputs.length > DEBUG_INPUT_SAMPLE_LIMIT) {
        data.echoTracker.recentInputs.splice(0, data.echoTracker.recentInputs.length - DEBUG_INPUT_SAMPLE_LIMIT);
      }
    }

    if (isAiForeground) {
      this.beginForegroundActivity(id, 'waiting_input', 'ai_tui_user_input');
    }

    // Enter 입력 시 heuristic 모드에서 즉시 running 전환.
    // AI TUI는 실행 명령과 내부 사용자 입력 모두 idle 상태로 유지한다.
    if (hasEnter && data.detectionMode === 'heuristic') {
      if (isInteractiveAiAppId(hintedAppId)) {
        this.beginForegroundActivity(id, 'waiting_input', `heuristic_${hintedAppId}_submit`);
      } else if (isAiForeground) {
        this.beginForegroundActivity(id, 'waiting_input', 'heuristic_ai_tui_submit');
      } else {
        this.updateStatus(id, 'running', 'heuristic_non_ai_submit');
      }
    }

    // FR-BGSTAB-020: Codex 감지 명령에 한해 tui 억제 -c 설정을 주입한다 (감지/추적은 원본 명령 기준 유지).
    const inputToWrite = this.maybeInjectCodexTuiSuppression(input, submittedCommand, hintedAppId, hasEnter);
    try {
      data.pty.write(inputToWrite);
      if (submittedCommand && !isAiForeground) {
        this.notifyCommandSubmitted({
          sessionId: id,
          command: submittedCommand,
          executable: getRecoveryExecutableToken(submittedCommand),
        });
      }
    } catch (error) {
      this.captureDebugEvent(id, 'pty', 'input_write_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[PTY] Failed to write input to session ${id}:`, error);
      return false;
    }
    data.session.lastActiveAt = new Date();
    return true;
  }

  /**
   * @req FR-BGSTAB-020
   * Codex 로 감지된 명령이 이번 write 로 원자적으로 제출된 경우에만 tui 억제 -c 플래그를
   * 삽입해 PTY 로 보낼 문자열을 재작성한다. config off / 비-codex / 부분 키스트로크는 원본을 그대로 반환한다.
   */
  private maybeInjectCodexTuiSuppression(
    input: string,
    submittedCommand: string | null,
    hintedAppId: ForegroundAppId | null,
    hasEnter: boolean,
  ): string {
    if (
      !this.runtimeSessionConfig.codexTuiSuppression ||
      !hasEnter ||
      hintedAppId !== 'codex' ||
      !submittedCommand
    ) {
      return input;
    }
    // 명령 전체가 이번 write 로 원자적으로 도착했는지 확인 (부분 버퍼 누적 시 재작성하지 않는다).
    const cleaned = stripInputTrackingControlSequences(input);
    const withoutTerminator = cleaned.replace(/(\r\n|\r|\n)+$/, '');
    if (withoutTerminator.trim() !== submittedCommand) {
      return input;
    }
    const terminatorMatch = input.match(/(\r\n|\r|\n)+$/);
    const terminator = terminatorMatch ? terminatorMatch[0] : '\r';
    return `${injectCodexTuiSuppressionFlags(submittedCommand)}${terminator}`;
  }

  private updateCommandInputBuffer(data: SessionData, input: string): string | null {
    if (typeof data.inputBuffer !== 'string') {
      data.inputBuffer = '';
    }

    let submittedCommand: string | null = null;

    if (containsHistoryRecallControlSequence(input)) {
      data.inputBuffer = '';
    }

    const cleanedInput = stripInputTrackingControlSequences(input);

    for (const char of cleanedInput) {
      if (char === '\r' || char === '\n') {
        submittedCommand = data.inputBuffer.trim();
        data.inputBuffer = '';
        continue;
      }

      if (char === '\x7f' || char === '\b') {
        data.inputBuffer = data.inputBuffer.slice(0, -1);
        continue;
      }

      if (char === '\u0015') {
        data.inputBuffer = '';
        continue;
      }

      if (char === '\x03') {
        data.inputBuffer = '';
        continue;
      }

      if (char >= ' ' && char !== '\x7f') {
        data.inputBuffer = `${data.inputBuffer}${char}`.slice(-512);
      }
    }

    return submittedCommand;
  }

  resize(
    id: string,
    cols: number,
    rows: number,
    retainedIdentity?: RetainedTerminalMutationIdentity,
  ): boolean {
    const data = this.sessions.get(id);
    if (!data) {
      this.recordRetainedTerminalLateMessage(id);
      return false;
    }
    if (!this.acceptRetainedTerminalMutationIdentity(data, retainedIdentity)) return false;

    this.wsRouter?.recordReplayEvent({
      kind: 'resize_requested',
      sessionId: id,
      snapshotSeq: data.screenSeq,
      details: {
        currentCols: data.cols,
        currentRows: data.rows,
        requestedCols: cols,
        requestedRows: rows,
      },
    });

    if (data.cols === cols && data.rows === rows) {
      this.wsRouter?.recordReplayEvent({
        kind: 'resize_skipped',
        sessionId: id,
        snapshotSeq: data.screenSeq,
        details: {
          currentCols: data.cols,
          currentRows: data.rows,
          requestedCols: cols,
          requestedRows: rows,
        },
      });
      return true;
    }

    if (this.ensureRetainedTerminalSessionState(data).mode === 'shadow' && data.headlessHealth === 'healthy' && data.headless) {
      this.queueRetainedTerminalResize(id, data, cols, rows);
    } else {
      this.applyLegacyTerminalResize(id, data, cols, rows);
    }
    return true;
  }

  private queueRetainedTerminalResize(id: string, data: SessionData, cols: number, rows: number): void {
    if (data.pendingHeadlessWrites === 0) {
      this.applyRetainedTerminalResize(id, data, cols, rows);
      return;
    }
    data.pendingHeadlessWrites += 1;
    data.headlessWriteChain = data.headlessWriteChain
      .then(() => {
        if (this.isActiveSession(id, data)) this.applyRetainedTerminalResize(id, data, cols, rows);
      })
      .catch(error => {
        if (!this.isActiveSession(id, data)) return;
        this.markHeadlessDegraded(id, data, 'resize', error);
        this.applyLegacyTerminalResize(id, data, cols, rows);
      })
      .finally(() => {
        data.pendingHeadlessWrites = Math.max(0, data.pendingHeadlessWrites - 1);
      });
  }

  private applyRetainedTerminalResize(id: string, data: SessionData, cols: number, rows: number): void {
    if (!data.headless) return;
    resizeHeadlessTerminal(data.headless, cols, rows);
    data.cols = cols;
    data.rows = rows;
    data.screenSeq += 1;
    data.authorityRevision += 1;
    const retained = this.ensureRetainedTerminalSessionState(data);
    this.advanceRetainedTerminalSnapshotOrdinal(id, retained);
    this.updateRetainedTerminalEvictionFromModel(retained, data.headless);
    retained.lastCheckpoint = {
      ...serializeRetainedHeadlessCheckpoint(data.headless),
      pendingEscapeTailAnsi: data.pendingEscapeTailAnsi,
    };
    retained.blockers.add('independent-baseline-unavailable');
    retained.blockers.add('shadow-comparer-axis-unavailable');
    retained.comparer.result = 'unavailable';
    this.appendRetainedTerminalRecord(retained, {
      streamEpoch: retained.streamEpoch,
      sourceSeq: retained.sourceSeq,
      kind: 'resize',
      modelCommitted: true,
      deliveryCreatedAfterCommit: false,
    });
    this.boundRetainedTerminalLedgers(data);
    this.scheduleRetainedTerminalComparison(id, data);
    this.markSnapshotDirty(data);
    data.pty.resize(cols, rows);
    this.scheduleRetainedResizeReplay(id);
  }

  private applyLegacyTerminalResize(id: string, data: SessionData, cols: number, rows: number): void {
    data.pty.resize(cols, rows);
    data.cols = cols;
    data.rows = rows;
    data.screenSeq += 1;
    data.authorityRevision += 1;
    this.markSnapshotDirty(data);
    if (data.headlessHealth === 'healthy' && data.headless) {
      try {
        resizeHeadlessTerminal(data.headless, cols, rows);
      } catch (error) {
        this.markHeadlessDegraded(id, data, 'resize', error);
        this.startDegradedReplayRecovery(id, data, 'resize');
      }
    }
    this.scheduleRetainedResizeReplay(id);
  }

  private scheduleRetainedResizeReplay(id: string): void {
    this.pendingResizeReplaySessions.add(id);
    this.pendingResizeReplayStartedAt.set(id, Date.now());
    this.pendingResizeReplayLastOutputAt.delete(id);
    this.scheduleResizeReplayRefresh(id, 150);
  }

  updateSession(id: string, updates: UpdateSessionRequest): SessionDTO | null {
    const data = this.sessions.get(id);
    if (!data) return null;

    if (updates.name !== undefined) {
      const duplicate = Array.from(this.sessions.values()).find(
        d => d.session.id !== id && d.session.name === updates.name
      );
      if (duplicate) {
        throw new AppError(ErrorCode.DUPLICATE_SESSION_NAME);
      }
      data.session.name = updates.name;
    }

    if (updates.sortOrder !== undefined) {
      data.session.sortOrder = updates.sortOrder;
    }

    return this.toDTO(data.session);
  }

  reorderSessions(sessionId: string, direction: 'up' | 'down'): boolean {
    const sorted = Array.from(this.sessions.values())
      .sort((a, b) => a.session.sortOrder - b.session.sortOrder);

    const index = sorted.findIndex(d => d.session.id === sessionId);
    if (index === -1) return false;

    if (direction === 'up' && index > 0) {
      const temp = sorted[index].session.sortOrder;
      sorted[index].session.sortOrder = sorted[index - 1].session.sortOrder;
      sorted[index - 1].session.sortOrder = temp;
    } else if (direction === 'down' && index < sorted.length - 1) {
      const temp = sorted[index].session.sortOrder;
      sorted[index].session.sortOrder = sorted[index + 1].session.sortOrder;
      sorted[index + 1].session.sortOrder = temp;
    }

    return true;
  }


  getPtyPid(sessionId: string): number | null {
    const data = this.sessions.get(sessionId);
    return data ? data.pty.pid : null;
  }

  getInitialCwd(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data ? data.initialCwd : null;
  }

  getLastCwd(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data?.lastCwd ?? data?.initialCwd ?? null;
  }

  getCwdFilePath(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data?.cwdFilePath ?? null;
  }

  getResolvedShellType(sessionId: string): RecoveryRestoreShell | null {
    const data = this.sessions.get(sessionId);
    if (!data) {
      return null;
    }
    const shellType = data.shellType ?? data.processMetadata.shellType;
    switch (shellType) {
      case 'powershell':
      case 'bash':
      case 'zsh':
      case 'sh':
      case 'cmd':
      case 'wsl':
        return shellType;
      default:
        return null;
    }
  }

  /** Register a callback to be invoked when any session's CWD changes. */
  onCwdChange(cb: (sessionId: string, cwd: string) => void): void {
    this.cwdChangeCallback = cb;
  }

  /** Register a callback to be invoked when a terminal title changes. */
  onTerminalTitleChange(cb: (sessionId: string, title: string) => void): void {
    this.terminalTitleChangeCallback = cb;
  }

  /** Register a callback to be invoked after any session finalizer completes. */
  onSessionFinalized(cb: (event: SessionFinalizedEvent) => void): void {
    this.sessionFinalizedCallback = cb;
  }

  addSessionFinalizedListener(cb: (event: SessionFinalizedEvent) => void): () => void {
    this.sessionFinalizedListeners.add(cb);
    return () => this.sessionFinalizedListeners.delete(cb);
  }

  /** Register a callback to be invoked when a shell-level command is submitted. */
  onCommandSubmitted(cb: (event: SessionCommandSubmittedEvent) => void | Promise<void>): void {
    this.commandSubmittedCallback = cb;
  }

  markRecoveryCommandForeground(sessionId: string, command: string): void {
    const data = this.sessions.get(sessionId);
    if (!data) {
      return;
    }
    const executable = getRecoveryExecutableToken(command) ?? normalizeRecoveryExecutable(command);
    if (!executable) {
      return;
    }
    data.recoveryForegroundCommand = executable;
    delete data.pendingForegroundAppHint;
    delete data.aiTuiLaunchAttempt;
    this.cancelPendingRunningTransition(data);
    this.updateDerivedState(sessionId, 'recovery_command_foreground', (state) => {
      state.ownership = 'foreground_app';
      state.activity = 'waiting_input';
      const builtInHint = detectForegroundAppHint(executable);
      if (builtInHint) {
        state.foregroundAppId = builtInHint;
      } else {
        delete state.foregroundAppId;
      }
      delete state.detectorId;
    });
    data.foregroundStartedAt = Date.now();
    this.captureDebugEvent(sessionId, 'pty', 'recovery_foreground_marked', {
      command: executable,
    });
  }

  scheduleRestoreInput(
    sessionId: string,
    input: string,
    options: {
      delayMs?: number;
      guard?: () => boolean;
    } = {},
  ): void {
    const delayMs = Math.max(0, options.delayMs ?? 600);
    const timer = setTimeout(() => {
      this.enqueueOrWriteRestoreInput(sessionId, {
        input,
        guard: options.guard,
        queuedAt: Date.now(),
      });
    }, delayMs);
    timer.unref?.();
  }

  private enqueueOrWriteRestoreInput(sessionId: string, pending: PendingRestoreInput): void {
    const data = this.sessions.get(sessionId);
    if (!data) {
      this.recordRestoreInputFailure(sessionId, 'session_missing_before_restore');
      return;
    }
    if (!this.isRestoreGuardAllowed(sessionId, data, pending.guard)) {
      this.recordRestoreInputFailure(sessionId, 'restore_guard_cancelled', data);
      return;
    }
    if (!data.startupReady) {
      data.pendingRestoreInputs.push(pending);
      this.captureDebugEvent(sessionId, 'pty', 'restore_input_queued', {
        pendingCount: data.pendingRestoreInputs.length,
      });
      return;
    }
    this.writeRestoreInput(sessionId, data, pending);
  }

  private writeRestoreInput(sessionId: string, data: SessionData, pending: PendingRestoreInput): void {
    if (this.sessions.get(sessionId) !== data) {
      this.recordRestoreInputFailure(sessionId, 'session_replaced_before_restore');
      return;
    }
    if (!this.isRestoreGuardAllowed(sessionId, data, pending.guard)) {
      this.recordRestoreInputFailure(sessionId, 'restore_guard_cancelled', data);
      return;
    }
    const written = this.submitRestoreInputThroughGateway(sessionId, pending.input);
    if (!written) {
      this.recordRestoreInputFailure(sessionId, 'restore_write_failed', data);
      return;
    }
    this.captureDebugEvent(sessionId, 'pty', 'restore_input_written', {
      queuedMs: Date.now() - pending.queuedAt,
    });
  }

  // @req FR-MCP-002
  // @req IR-MCP-004
  private submitRestoreInputThroughGateway(sessionId: string, input: string): boolean {
    const gateway = createSessionInputGateway({
      writeInput: (write) => this.writeInput(
        String(write.sessionId ?? ''),
        String(write.data ?? ''),
      ),
      resolveTarget: () => this.hasSession(sessionId)
        ? {
            ok: true,
            binding: {
              sessionKey: sessionId,
              currentSessionId: sessionId,
              generation: 1,
              lifecycle: 'live',
            },
          }
        : { ok: false, code: 'TARGET_NOT_LIVE' },
      readReplayState: () => ({
        replayPending: false,
        screenRepairPending: false,
      }),
      evaluateInputPolicy: () => ({ ok: true }),
    });
    const result = gateway.submitInput({
      source: 'restore',
      target: { sessionId },
      data: input,
      delivery: { mode: 'paste', submit: input.includes('\r') || input.includes('\n') },
      replayPolicy: 'allow',
    });
    return result.accepted === true;
  }

  private markSessionStartupReady(sessionId: string, data: SessionData, reason: string): void {
    if (data.startupReady || this.sessions.get(sessionId) !== data) {
      return;
    }
    data.startupReady = true;
    if (data.startupReadyTimer) {
      clearTimeout(data.startupReadyTimer);
      data.startupReadyTimer = null;
    }
    this.captureDebugEvent(sessionId, 'pty', 'startup_ready', {
      reason,
      pendingRestoreInputs: data.pendingRestoreInputs.length,
    });
    const pendingInputs = data.pendingRestoreInputs.splice(0);
    for (const pending of pendingInputs) {
      this.writeRestoreInput(sessionId, data, pending);
    }
  }

  private scheduleStartupReadyFallback(
    sessionId: string,
    shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd',
  ): void {
    const data = this.sessions.get(sessionId);
    if (!data) {
      return;
    }
    const delayMs = shellType === 'powershell' ? 1500 : 2500;
    data.startupReadyTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current) {
        return;
      }
      console.warn(`[SessionManager] Shell startup readiness fallback used for session ${sessionId}`);
      this.markSessionStartupReady(sessionId, current, 'startup_ready_fallback');
    }, delayMs);
    data.startupReadyTimer.unref?.();
  }

  private recordRestoreInputFailure(sessionId: string, reason: string, data?: SessionData): void {
    console.warn(`[SessionManager] Recovery restore input skipped for session ${sessionId}: ${reason}`);
    if (data) {
      this.captureDebugEvent(sessionId, 'pty', 'restore_input_failed', { reason });
    }
  }

  private isInteractiveForeground(data: SessionData, derivedState: SessionDerivedState): boolean {
    return derivedState.ownership === 'foreground_app'
      && (
        isInteractiveAiAppId(derivedState.foregroundAppId)
        || Boolean(data.recoveryForegroundCommand)
      );
  }

  private isRestoreGuardAllowed(
    sessionId: string,
    data: SessionData,
    guard: (() => boolean) | undefined,
  ): boolean {
    if (!guard) {
      return true;
    }
    try {
      return guard();
    } catch (error) {
      console.warn(`[SessionManager] Recovery restore guard failed for session ${sessionId}:`, error);
      this.captureDebugEvent(sessionId, 'pty', 'restore_guard_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Stop all CWD file watchers. Called during graceful shutdown. */
  stopAllCwdWatching(): void {
    for (const [id, data] of this.sessions) {
      if (data.cwdFilePath) {
        try {
          unwatchFile(data.cwdFilePath);
        } catch { /* already unwatched — ignore */ }
      }
    }
    console.log('[SessionManager] All CWD watchers stopped');
  }

  getAvailableShells(): ShellInfo[] {
    return this.cachedAvailableShells ?? [];
  }

  private detectAvailableShells(): ShellInfo[] {
    const shells: ShellInfo[] = [];
    if (this.platform === 'win32') {
      // PowerShell: 항상 추가
      shells.push({ id: 'powershell', label: 'PowerShell', icon: '💙' });
      // cmd: 항상 추가
      shells.push({ id: 'cmd', label: 'Command Prompt', icon: '⬛' });
      // WSL: wsl.exe 존재 시에만 추가
      if (this.isCommandAvailable('wsl.exe')) {
        shells.push({ id: 'wsl', label: 'WSL (Bash)', icon: '🐧' });
        shells.push({ id: 'bash', label: 'Bash (WSL)', icon: '🐚' });
        shells.push({ id: 'sh', label: 'Shell (WSL sh)', icon: '⚡' });
        // WSL 내부 zsh 확인
        if (this.isWslShellAvailable('zsh')) {
          shells.push({ id: 'zsh', label: 'WSL (Zsh)', icon: '🔮' });
        }
      }
    } else {
      // bash: 존재 시에만 추가
      if (this.isCommandAvailable('bash')) {
        shells.push({ id: 'bash', label: 'Bash', icon: '🐚' });
      }
      // zsh: 존재 시에만 추가
      if (this.isCommandAvailable('zsh')) {
        shells.push({ id: 'zsh', label: 'Zsh', icon: '🔮' });
      }
      // sh: 항상 추가
      shells.push({ id: 'sh', label: 'Shell (sh)', icon: '⚡' });
    }
    return shells;
  }

  private isCommandAvailable(cmd: string): boolean {
    try {
      if (this.platform === 'win32') {
        execSync(`where ${cmd}`, { stdio: 'ignore', windowsHide: true });
      } else {
        execSync(`which ${cmd}`, { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false;
    }
  }

  private isWslShellAvailable(shell: string): boolean {
    try {
      execSync(`wsl.exe which ${shell}`, { stdio: 'ignore', timeout: 3000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 셸 타입에 따라 OSC 133 주입을 위한 환경변수를 구성한다.
   *
   * - bash: BASH_ENV 환경변수로 스크립트 자동 로드
   * - zsh: ZDOTDIR 교체로 커스텀 .zshrc 로드 (Phase 2에서는 미지원)
   * - powershell: OSC 133 미지원, 기본 env 반환
   */
  private buildShellEnv(shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd'): Record<string, string> {
    const baseEnv = { ...process.env } as Record<string, string>;

    if (shellType === 'bash') {
      // bash: BASH_ENV로 스크립트 자동 로드
      const scriptPath = this.getShellIntegrationPath('bash-osc133.sh');
      if (scriptPath) {
        // WSL인 경우 Windows 경로를 WSL 경로로 변환
        if (this.platform === 'win32') {
          const wslPath = this.toWslPath(scriptPath);
          baseEnv['BASH_ENV'] = wslPath;
        } else {
          baseEnv['BASH_ENV'] = scriptPath;
        }
      }
    }
    // zsh: ZDOTDIR 교체 방식은 미구현, baseEnv만 반환
    // sh: 기본 env만 반환
    // cmd: 기본 env만 반환
    // powershell: OSC 133 미지원, 기본 env 반환

    return baseEnv;
  }

  private normalizeEnvPatch(envPatch: Record<string, string | undefined | null> | undefined): Record<string, string> {
    if (!envPatch) {
      return {};
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(envPatch)) {
      if (!key || value === undefined || value === null) {
        continue;
      }
      normalized[key] = String(value);
    }
    return normalized;
  }

  private getWindowsPtyInfo(backendOverride?: WindowsPtyBackend): WindowsPtyInfo | undefined {
    if (this.platform !== 'win32') {
      return undefined;
    }

    const backend: WindowsPtyBackend = backendOverride ?? (this.runtimePtyConfig.useConpty ? 'conpty' : 'winpty');
    const buildNumber = parseInt(os.release().split('.').pop() ?? '', 10);
    return {
      backend,
      buildNumber: Number.isFinite(buildNumber) ? buildNumber : undefined,
    };
  }

  private resolveWindowsPtyBackend(shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd'): {
    backend: WindowsPtyBackend;
    useConpty: boolean;
    requestedPowerShellBackend: PowerShellBackendPolicy;
  } {
    const normalized = normalizePtyConfigForPlatform({
      useConpty: this.runtimePtyConfig.useConpty,
      windowsPowerShellBackend: this.runtimePtyConfig.windowsPowerShellBackend,
      shell: this.runtimePtyConfig.shell,
    }, this.platform);
    const inheritedBackend: WindowsPtyBackend = normalized.useConpty ? 'conpty' : 'winpty';
    const requestedPowerShellBackend = normalized.windowsPowerShellBackend;

    if (this.platform !== 'win32') {
      return {
        backend: inheritedBackend,
        useConpty: false,
        requestedPowerShellBackend,
      };
    }

    if (shellType !== 'powershell') {
      if (inheritedBackend === 'winpty') {
        this.assertPowerShellWinptyAvailable();
      }
      return {
        backend: inheritedBackend,
        useConpty: inheritedBackend === 'conpty',
        requestedPowerShellBackend,
      };
    }

    const effectiveBackend: WindowsPtyBackend = requestedPowerShellBackend === 'inherit'
      ? inheritedBackend
      : requestedPowerShellBackend;

    if (effectiveBackend === 'winpty') {
      this.assertPowerShellWinptyAvailable();
      return {
        backend: 'winpty',
        useConpty: false,
        requestedPowerShellBackend,
      };
    }

    return {
      backend: effectiveBackend,
      useConpty: effectiveBackend === 'conpty',
      requestedPowerShellBackend,
    };
  }

  /**
   * shell-integration 스크립트의 절대 경로를 반환한다.
   *
   * dev 환경(tsx): src/shell-integration/ 기준
   * 빌드 환경: dist/shell-integration/ 기준
   */
  private getShellIntegrationPath(filename: string): string | null {
    try {
      const configuredRoot = process.env[SHELL_INTEGRATION_ROOT_ENV_KEY]?.trim();
      if (configuredRoot) {
        return path.resolve(configuredRoot, filename);
      }

      const currentDir = typeof __dirname === 'string'
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.resolve(currentDir, '..', 'shell-integration', filename);
      return scriptPath;
    } catch {
      return null;
    }
  }

  /**
   * Windows 절대 경로를 WSL 경로로 변환.
   * C:\Users\foo\bar → /mnt/c/Users/foo/bar
   * /C:/Users/foo/bar → /mnt/c/Users/foo/bar
   */
  private toWslPath(windowsPath: string): string {
    // URL.pathname 형태 (/C:/Users/...) 처리: 앞의 / 제거
    const cleaned = windowsPath.replace(/^\//, '');
    // 드라이브 문자 추출 (C: 또는 C/)
    const drive = cleaned[0].toLowerCase();
    const rest = cleaned.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }

  /**
   * Resolve CWD for pty.spawn.
   * On Windows, pty.spawn requires a Windows path. If the cwd is a WSL/Linux path
   * (starts with /), convert /mnt/X/... to X:\... or fall back to the default.
   */
  private resolveSpawnCwd(cwd: string | undefined, shellType: string): string {
    const fallback = process.env.HOME || process.env.USERPROFILE || '/';
    if (!cwd) return fallback;

    const isWindows = this.platform === 'win32';

    let resolved = cwd;
    if (isWindows && cwd.startsWith('/')) {
      // Linux path on Windows — try /mnt/X/... → X:\...
      const mntMatch = cwd.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
      if (mntMatch) {
        const drive = mntMatch[1].toUpperCase();
        const rest = (mntMatch[2] || '').replace(/\//g, '\\');
        resolved = `${drive}:${rest || '\\'}`;
      } else {
        // Other Linux paths (e.g. /home/...) can't be mapped — use fallback
        return fallback;
      }
    }

    // Verify directory exists; fall back to home if not
    if (!existsSync(resolved)) {
      console.warn(`[SessionManager] CWD does not exist: ${resolved}, falling back to ${fallback}`);
      return fallback;
    }

    return resolved;
  }

  /**
   * Resolve shell command and arguments based on config and platform.
   */
  private resolveShell(
    shellOverride?: ShellType,
    cwdFilePath?: string,
  ): { shell: string; args: string[]; shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd' } {
    const shellConfig = normalizeShellForPlatform(shellOverride || this.runtimePtyConfig.shell || 'auto', this.platform);

    if (shellConfig === 'powershell') {
      return { shell: 'powershell.exe', args: this.buildPowerShellArgs(cwdFilePath), shellType: 'powershell' };
    }
    if (shellConfig === 'wsl') {
      return this.isCommandAvailable('wsl.exe')
        ? { shell: 'wsl.exe', args: [], shellType: 'bash' }
        : this.resolveAutoShell(cwdFilePath);
    }
    if (shellConfig === 'bash') {
      if (this.platform === 'win32') {
        return this.isCommandAvailable('wsl.exe')
          ? { shell: 'wsl.exe', args: [], shellType: 'bash' }
          : this.resolveAutoShell(cwdFilePath);
      }
      if (this.isCommandAvailable('bash')) {
        return { shell: 'bash', args: [], shellType: 'bash' };
      }
      return { shell: 'sh', args: [], shellType: 'sh' };
    }
    if (shellConfig === 'zsh') {
      if (this.platform === 'win32') {
        return this.isCommandAvailable('wsl.exe') && this.isWslShellAvailable('zsh')
          ? { shell: 'wsl.exe', args: ['-e', 'zsh'], shellType: 'zsh' }
          : this.resolveAutoShell(cwdFilePath);
      }
      if (this.isCommandAvailable('zsh')) {
        return { shell: 'zsh', args: [], shellType: 'zsh' };
      }
      return this.resolveAutoShell(cwdFilePath);
    }
    if (shellConfig === 'sh') {
      if (this.platform === 'win32') {
        return this.isCommandAvailable('wsl.exe')
          ? { shell: 'wsl.exe', args: ['-e', 'sh'], shellType: 'sh' }
          : this.resolveAutoShell(cwdFilePath);
      }
      return { shell: 'sh', args: [], shellType: 'sh' };
    }
    if (shellConfig === 'cmd') {
      return { shell: 'cmd.exe', args: [], shellType: 'cmd' };
    }

    return this.resolveAutoShell(cwdFilePath);
  }

  private resolveAutoShell(
    cwdFilePath?: string,
  ): { shell: string; args: string[]; shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd' } {
    if (this.platform === 'win32') {
      return { shell: 'powershell.exe', args: this.buildPowerShellArgs(cwdFilePath), shellType: 'powershell' };
    }
    if (this.platform === 'darwin' && this.isCommandAvailable('zsh')) {
      return { shell: 'zsh', args: [], shellType: 'zsh' };
    }
    if (this.isCommandAvailable('bash')) {
      return { shell: 'bash', args: [], shellType: 'bash' };
    }
    return { shell: 'sh', args: [], shellType: 'sh' };
  }

  // Step 7: Workspace support
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  deleteMultipleSessions(ids: string[], reason: SessionCleanupReason = 'direct-session-delete'): void {
    for (const id of ids) {
      this.deleteSession(id, reason);
    }
  }

  async terminateMultipleSessions(
    ids: string[],
    options: {
      reason: SessionCleanupReason;
      mode?: SessionProcessCleanupConfig['mode'];
      waitMs?: number;
    },
  ): Promise<SessionBatchTerminationResult> {
    let terminated = 0;
    let remainingVerifiedDescendants = 0;
    let remainingUnverifiedDescendants = 0;
    const missing: string[] = [];
    for (const id of ids) {
      const ok = await this.terminateSession(id, options);
      if (ok) {
        terminated += 1;
        for (let index = this.cleanupTelemetry.recentResults.length - 1; index >= 0; index -= 1) {
          const result = this.cleanupTelemetry.recentResults[index];
          if (result.sessionId === id) {
            remainingVerifiedDescendants += normalizeRemainingDescendants(result.verifiedRemainingDescendants);
            remainingUnverifiedDescendants += normalizeRemainingDescendants(result.unverifiedRemainingDescendants);
            break;
          }
        }
      } else {
        missing.push(id);
      }
    }
    return {
      attempted: ids.length,
      terminated,
      missing,
      remainingVerifiedDescendants,
      remainingUnverifiedDescendants,
    };
  }

  async terminateAllSessions(
    options: {
      reason: SessionCleanupReason;
      mode?: SessionProcessCleanupConfig['mode'];
      waitMs?: number;
    },
  ): Promise<SessionBatchTerminationResult> {
    return this.terminateMultipleSessions(Array.from(this.sessions.keys()), options);
  }

  // @req REL-BGSTAB-010
  hasTerminalResourcePolicyHeadlessTarget(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyHeadlessLegacyLimit(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.headlessOutputMaxBytes;
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyHeadlessLegacyChunkLimit(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.headlessOutputMaxChunks;
  }

  // @req REL-BGSTAB-010
  onTerminalResourcePolicyHeadlessTargetFinalized(listener: (sessionId: string) => void): () => void {
    this.terminalResourcePolicyHeadlessFinalizedListeners.add(listener);
    return () => this.terminalResourcePolicyHeadlessFinalizedListeners.delete(listener);
  }

  // @req REL-BGSTAB-010
  bindTerminalResourcePolicyHeadlessAdmissionPort(
    port: TerminalResourcePolicyHeadlessAdmissionPort,
  ): () => void {
    if (this.terminalResourcePolicyHeadlessAdmissionPort) {
      throw new Error('Terminal resource policy headless admission port is already bound');
    }
    this.terminalResourcePolicyHeadlessAdmissionPort = port;
    return () => {
      if (this.terminalResourcePolicyHeadlessAdmissionPort === port) {
        this.terminalResourcePolicyHeadlessAdmissionPort = undefined;
      }
    };
  }

  // @req REL-BGSTAB-010
  hasPendingTerminalResourcePolicyHeadlessWrites(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.pendingHeadlessWrites ?? 0) > 0;
  }

  // @req REL-BGSTAB-010
  hasPendingTerminalResourcePolicyHeadlessGeneration(sessionId: string, policyGeneration: number): boolean {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    this.ensureHeadlessPolicyTracking(sessionData);
    return (sessionData.pendingHeadlessWritesByPolicyGeneration.get(policyGeneration) ?? 0) > 0;
  }

  // @req REL-BGSTAB-010
  captureTerminalResourcePolicyHeadlessDrainBoundary(
    sessionId: string,
  ): TerminalResourcePolicyHeadlessDrainBoundary | undefined {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || sessionData.pendingHeadlessWrites === 0) return undefined;
    const boundary = Object.freeze({
      sessionId,
      outputIds: Object.freeze([...sessionData.pendingHeadlessOutputs.keys()]),
    });
    const record = {
      sessionData,
      fence: sessionData.headlessWriteChain,
      settled: false,
    };
    this.terminalResourcePolicyHeadlessDrainBoundaries.set(boundary, record);
    void record.fence.then(
      () => { record.settled = true; },
      () => { record.settled = true; },
    );
    return boundary;
  }

  // @req REL-BGSTAB-010
  hasPendingTerminalResourcePolicyHeadlessDrainBoundary(
    boundary: TerminalResourcePolicyHeadlessDrainBoundary,
  ): boolean {
    const record = this.terminalResourcePolicyHeadlessDrainBoundaries.get(boundary);
    return Boolean(
      record
      && this.sessions.get(boundary.sessionId) === record.sessionData
      && !record.settled,
    );
  }

  // @req REL-BGSTAB-010
  async waitForTerminalResourcePolicyHeadlessDrainBoundary(
    boundary: TerminalResourcePolicyHeadlessDrainBoundary,
  ): Promise<boolean> {
    const record = this.terminalResourcePolicyHeadlessDrainBoundaries.get(boundary);
    if (!record) return false;
    await record.fence.catch(() => undefined);
    return this.sessions.get(boundary.sessionId) === record.sessionData;
  }

  // @req REL-BGSTAB-010
  async waitForTerminalResourcePolicyHeadlessGenerationDrain(
    sessionId: string,
    policyGeneration: number,
  ): Promise<boolean> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    if (!this.hasPendingTerminalResourcePolicyHeadlessGeneration(sessionId, policyGeneration)) {
      return true;
    }
    const preBoundaryFence = sessionData.headlessWriteChain;
    await preBoundaryFence.catch(() => undefined);
    return this.sessions.get(sessionId) === sessionData;
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyHeadlessPendingUsage(sessionId: string, policyGeneration: number) {
    const sessionData = this.sessions.get(sessionId);
    if (sessionData) this.ensureHeadlessPolicyTracking(sessionData);
    return {
      totalBytes: sessionData?.pendingHeadlessOutputBytes ?? 0,
      totalChunks: sessionData?.pendingHeadlessOutputs.size ?? 0,
      generationBytes: sessionData?.pendingHeadlessOutputBytesByPolicyGeneration.get(policyGeneration) ?? 0,
      generationChunks: sessionData?.pendingHeadlessOutputChunksByPolicyGeneration.get(policyGeneration) ?? 0,
      generationLegacyBytes: sessionData?.pendingHeadlessLegacyOutputBytesByPolicyGeneration.get(policyGeneration) ?? 0,
      generationLegacyChunks: sessionData?.pendingHeadlessLegacyOutputChunksByPolicyGeneration.get(policyGeneration) ?? 0,
    };
  }

  // @req REL-BGSTAB-010
  async waitForTerminalResourcePolicyHeadlessDrain(sessionId: string): Promise<boolean> {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return false;
    while (this.sessions.get(sessionId) === sessionData) {
      const observedChain = sessionData.headlessWriteChain;
      await observedChain.catch(() => undefined);
      if (
        this.sessions.get(sessionId) === sessionData
        && sessionData.headlessWriteChain === observedChain
        && sessionData.pendingHeadlessWrites === 0
      ) {
        return true;
      }
    }
    return false;
  }

  // @req REL-BGSTAB-010
  appendTerminalResourcePolicyHeadlessData(
    sessionId: string,
    data: string,
    metadata: {
      policyGeneration: number;
      exactlyOnceKey: string;
      outputMaxBytes: number;
      outputMaxChunks: number;
      admissionMode: 'candidate' | 'legacy';
      settleFailure?: (reason: 'headless-write-failed') => void;
    },
  ): { ok: true } | { ok: false; reason: 'target-missing' | 'byte-limit' | 'chunk-limit' } {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return { ok: false, reason: 'target-missing' };
    this.ensureHeadlessPolicyTracking(sessionData);
    const enqueueResult = sessionData.headlessOutputQueue.enqueue(
      data,
      metadata.outputMaxBytes,
      metadata.outputMaxChunks,
    );
    if (!enqueueResult.ok) {
      return { ok: false, reason: enqueueResult.reason === 'chunk-limit' ? 'chunk-limit' : 'byte-limit' };
    }
    this.queueAcceptedHeadlessOutput(sessionId, sessionData, data, metadata);
    return { ok: true };
  }

  private queueAcceptedHeadlessOutput(
    sessionId: string,
    sessionData: SessionData,
    data: string,
    metadata?: {
      policyGeneration: number;
      exactlyOnceKey: string;
      admissionMode: 'candidate' | 'legacy';
      settleFailure?: (reason: 'headless-write-failed') => void;
    },
    retainedSemanticData = data,
  ): void {
    this.ensureHeadlessPolicyTracking(sessionData);
    const byteLength = Buffer.byteLength(data, 'utf8');
    const id = sessionData.nextHeadlessOutputId;
    const reservedAuthorityOrdinal = advanceRetainedTerminalOrdinal({
      streamEpoch: this.ensureRetainedTerminalSessionState(sessionData).streamEpoch as Ordinal64,
      sourceSeq: sessionData.nextTerminalAuthoritySourceSeq.toString() as Ordinal64,
    });
    sessionData.nextTerminalAuthoritySourceSeq = BigInt(reservedAuthorityOrdinal.sourceSeq);
    let terminalAuthorityReservation: ReturnType<TerminalAuthorityController['enqueueHeadlessOutput']> | undefined;
    if (sessionData.terminalAuthorityController) {
      terminalAuthorityReservation = sessionData.terminalAuthorityController.enqueueHeadlessOutput({
        streamEpoch: reservedAuthorityOrdinal.streamEpoch,
        sourceSeq: sessionData.nextTerminalAuthoritySourceSeq.toString(),
        data: retainedSemanticData,
      });
    }
    const pendingOutput: PendingHeadlessOutput = {
      id,
      data,
      byteLength,
      queuedAt: Date.now(),
      queued: true,
      retainedSemanticData,
      ...(terminalAuthorityReservation
        ? {
            terminalAuthorityRecordId: terminalAuthorityReservation.recordId,
            ingestOwnerToken: terminalAuthorityReservation.ingestOwnerToken,
          }
        : {}),
      ...(metadata ? {
        exactlyOnceKey: metadata.exactlyOnceKey,
        policyGeneration: metadata.policyGeneration,
        expiresAt: Number.MAX_SAFE_INTEGER,
        ready: true,
        recoveryGeneration: 0,
        policyAdmissionMode: metadata.admissionMode,
      } : {}),
    };
    sessionData.nextHeadlessOutputId += 1;
    sessionData.pendingHeadlessOutputs.set(id, pendingOutput);
    if (metadata?.settleFailure) {
      sessionData.headlessPolicyWriteFailureSettlers.set(id, metadata.settleFailure);
    }
    sessionData.pendingHeadlessOutputBytes += byteLength;
    if (metadata) {
      this.incrementHeadlessPolicyUsage(
        sessionData,
        metadata.policyGeneration,
        byteLength,
        metadata.admissionMode,
      );
    }
    sessionData.pendingHeadlessWrites += 1;
    if (metadata) {
      sessionData.pendingHeadlessWritesByPolicyGeneration.set(
        metadata.policyGeneration,
        (sessionData.pendingHeadlessWritesByPolicyGeneration.get(metadata.policyGeneration) ?? 0) + 1,
      );
    }
    sessionData.maxPendingHeadlessOutputBytes = Math.max(
      sessionData.maxPendingHeadlessOutputBytes,
      sessionData.pendingHeadlessOutputBytes,
    );
    sessionData.maxPendingHeadlessOutputChunks = Math.max(
      sessionData.maxPendingHeadlessOutputChunks,
      sessionData.pendingHeadlessOutputs.size,
    );
    sessionData.headlessWriteChain = sessionData.headlessWriteChain
      .then(async () => {
        await this.applyHeadlessOutput(
          sessionId,
          sessionData,
          pendingOutput,
          pendingOutput.ingestOwnerToken,
        );
      })
      .catch((error) => {
        if (!this.isActiveSession(sessionId, sessionData)) return;
        this.markHeadlessDegraded(sessionId, sessionData, 'write', error);
        if (data.length > 0) {
          this.wsRouter?.routeSessionOutput(sessionId, data, sessionData.screenSeq, {
            authorityEpoch: sessionData.authorityEpoch,
            authorityRevision: sessionData.authorityRevision,
          }, 'legacy-unnegotiated');
        }
        this.startDegradedReplayRecovery(sessionId, sessionData, 'write');
      })
      .finally(() => {
        if (!this.isActiveSession(sessionId, sessionData)) return;
        sessionData.pendingHeadlessWrites = Math.max(0, sessionData.pendingHeadlessWrites - 1);
        if (metadata) {
          const next = Math.max(
            0,
            (sessionData.pendingHeadlessWritesByPolicyGeneration.get(metadata.policyGeneration) ?? 0) - 1,
          );
          if (next === 0) sessionData.pendingHeadlessWritesByPolicyGeneration.delete(metadata.policyGeneration);
          else sessionData.pendingHeadlessWritesByPolicyGeneration.set(metadata.policyGeneration, next);
        }
      });
  }

  private incrementHeadlessPolicyUsage(
    sessionData: SessionData,
    policyGeneration: number,
    byteLength: number,
    admissionMode: 'candidate' | 'legacy',
  ): void {
    this.ensureHeadlessPolicyTracking(sessionData);
    sessionData.pendingHeadlessOutputBytesByPolicyGeneration.set(
      policyGeneration,
      (sessionData.pendingHeadlessOutputBytesByPolicyGeneration.get(policyGeneration) ?? 0) + byteLength,
    );
    sessionData.pendingHeadlessOutputChunksByPolicyGeneration.set(
      policyGeneration,
      (sessionData.pendingHeadlessOutputChunksByPolicyGeneration.get(policyGeneration) ?? 0) + 1,
    );
    if (admissionMode === 'legacy') {
      sessionData.pendingHeadlessLegacyOutputBytesByPolicyGeneration.set(
        policyGeneration,
        (sessionData.pendingHeadlessLegacyOutputBytesByPolicyGeneration.get(policyGeneration) ?? 0) + byteLength,
      );
      sessionData.pendingHeadlessLegacyOutputChunksByPolicyGeneration.set(
        policyGeneration,
        (sessionData.pendingHeadlessLegacyOutputChunksByPolicyGeneration.get(policyGeneration) ?? 0) + 1,
      );
    }
  }

  /**
   * Older persisted/test-created session records predate the policy-generation
   * accounting maps. Keep the runtime migration lazy so adopting the shared
   * authority never turns an otherwise recoverable headless failure into a
   * secondary TypeError while the session is being drained.
   */
  private ensureHeadlessPolicyTracking(sessionData: SessionData): void {
    sessionData.pendingHeadlessOutputBytesByPolicyGeneration ??= new Map();
    sessionData.pendingHeadlessOutputChunksByPolicyGeneration ??= new Map();
    sessionData.pendingHeadlessLegacyOutputBytesByPolicyGeneration ??= new Map();
    sessionData.pendingHeadlessLegacyOutputChunksByPolicyGeneration ??= new Map();
    sessionData.pendingHeadlessWritesByPolicyGeneration ??= new Map();
    sessionData.headlessPolicyWriteFailureSettlers ??= new Map();
  }

  updateRuntimeConfig(next: {
    idleDelayMs?: number;
    runningDelayMs?: number;
    processCleanup?: Partial<SessionProcessCleanupConfig>;
    pty?: Partial<PTYConfig>;
    resourceLimits?: Partial<ResourceLimitsConfig>;
    stabilityModes?: Partial<StabilityModesConfig>;
  }): void {
    const nextPowerShellBackendRaw = next.pty?.windowsPowerShellBackend ?? this.runtimePtyConfig.windowsPowerShellBackend ?? 'inherit';
    const nextUseConptyRaw = next.pty?.useConpty ?? this.runtimePtyConfig.useConpty;
    const nextNormalized = normalizePtyConfigForPlatform({
      useConpty: nextUseConptyRaw,
      windowsPowerShellBackend: nextPowerShellBackendRaw,
      shell: next.pty?.shell ?? this.runtimePtyConfig.shell,
    }, this.platform);
    const nextPowerShellBackend = nextNormalized.windowsPowerShellBackend;
    const nextUseConpty = nextNormalized.useConpty;
    const effectivePowerShellBackend = nextPowerShellBackend === 'inherit'
      ? (nextUseConpty ? 'conpty' : 'winpty')
      : nextPowerShellBackend;
    if (this.platform !== 'win32' && nextUseConptyRaw) {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'ConPTY is only available on Windows');
    }
    if (this.platform !== 'win32' && nextPowerShellBackendRaw !== 'inherit') {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'PowerShell backend override is only available on Windows');
    }

    if (this.platform === 'win32' && (nextUseConpty === false || effectivePowerShellBackend === 'winpty')) {
      this.assertPowerShellWinptyAvailable();
    }

    if (next.idleDelayMs !== undefined) {
      this.runtimeSessionConfig.idleDelayMs = next.idleDelayMs;
    }
    if (next.runningDelayMs !== undefined) {
      this.runtimeSessionConfig.runningDelayMs = next.runningDelayMs;
    }
    if (next.processCleanup) {
      this.runtimeSessionConfig.processCleanup = normalizeSessionProcessCleanupConfig({
        ...this.runtimeSessionConfig.processCleanup,
        ...next.processCleanup,
      });
      this.cleanupTelemetry.mode = this.runtimeSessionConfig.processCleanup.mode;
    }
    if (next.resourceLimits?.headless) {
      this.runtimeHeadlessQueueConfig.limits = cloneHeadlessResourceLimits(headlessResourceLimitsSchema.parse({
        ...this.runtimeHeadlessQueueConfig.limits,
        ...next.resourceLimits.headless,
      }));
    }
    if (next.stabilityModes?.headlessQueueMode) {
      this.runtimeHeadlessQueueConfig.mode = stabilityModesSchema.parse({
        headlessQueueMode: next.stabilityModes.headlessQueueMode,
      }).headlessQueueMode;
    }

    if (next.pty) {
      this.runtimePtyConfig = {
        ...this.runtimePtyConfig,
        ...next.pty,
        ...nextNormalized,
      };
    }

    if (!next.pty) {
      return;
    }

    for (const data of this.sessions.values()) {
      data.snapshotCache = null;
      if (data.degradedReplayBuffer.length > 0) {
        const degraded = truncateTerminalPayloadTail(data.degradedReplayBuffer, this.runtimePtyConfig.maxSnapshotBytes);
        data.degradedReplayBuffer = degraded.content;
        data.degradedReplayTruncated = data.degradedReplayTruncated || degraded.truncated;
      }
      if (data.unsnapshottedOutput.length > 0) {
        const pending = truncateTerminalPayloadTail(data.unsnapshottedOutput, this.runtimePtyConfig.maxSnapshotBytes);
        data.unsnapshottedOutput = pending.content;
        data.unsnapshottedOutputTruncated = data.unsnapshottedOutputTruncated || pending.truncated;
      }
    }
  }

  assertRuntimePtyCapabilities(): void {
    const normalized = normalizePtyConfigForPlatform({
      useConpty: this.runtimePtyConfig.useConpty,
      windowsPowerShellBackend: this.runtimePtyConfig.windowsPowerShellBackend,
      shell: this.runtimePtyConfig.shell,
    }, this.platform);
    const configuredPowerShellBackend = normalized.windowsPowerShellBackend;
    if (this.platform !== 'win32' && normalized.useConpty) {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'ConPTY is only available on Windows');
    }
    const effectivePowerShellBackend = configuredPowerShellBackend === 'inherit'
      ? (normalized.useConpty ? 'conpty' : 'winpty')
      : configuredPowerShellBackend;
    if (this.platform !== 'win32' && configuredPowerShellBackend !== 'inherit') {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'PowerShell backend override is only available on Windows');
    }
    if (this.platform === 'win32' && (this.runtimePtyConfig.useConpty === false || effectivePowerShellBackend === 'winpty')) {
      this.assertPowerShellWinptyAvailable();
    }
  }

  primePowerShellWinptyCapability(): void {
    if (this.platform !== 'win32' || this.powerShellWinptyProbe.checked) {
      return;
    }

    try {
      this.assertPowerShellWinptyAvailable();
    } catch {
      // The cached failure state is used by SettingsService to truthfully limit options.
    }
  }

  warmPowerShellWinptyCapability(): Promise<void> {
    if (this.platform !== 'win32' || this.powerShellWinptyProbe.checked) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.execFileFn(process.execPath, ['-e', this.buildWinptyProbeScript()], {
        timeout: 3000,
        windowsHide: true,
      }, (error, _stdout, stderr) => {
        if (!error) {
          this.powerShellWinptyProbe = { checked: true, available: true };
          resolve();
          return;
        }

        const reason = stderr?.trim() || formatWinptyProbeFailure(error);
        this.powerShellWinptyProbe = { checked: true, available: false, reason };
        resolve();
      });
    });
  }

  getPowerShellWinptyCapability(): { checked: boolean; available: boolean; reason?: string } {
    if (this.platform !== 'win32') {
      return {
        checked: true,
        available: false,
        reason: 'PowerShell backend override is only available on Windows',
      };
    }

    return { ...this.powerShellWinptyProbe };
  }

  private assertPowerShellWinptyAvailable(): void {
    if (this.platform !== 'win32') {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'PowerShell winpty backend is only available on Windows');
    }

    if (this.powerShellWinptyProbe.checked && this.powerShellWinptyProbe.available) {
      return;
    }

    try {
      this.execFileSyncFn(process.execPath, ['-e', this.buildWinptyProbeScript()], {
        stdio: 'pipe',
        timeout: 3000,
        windowsHide: true,
      });
      this.powerShellWinptyProbe = { checked: true, available: true };
    } catch (error) {
      const reason = formatWinptyProbeFailure(error);
      this.powerShellWinptyProbe = { checked: true, available: false, reason };
      throw new AppError(
        ErrorCode.CONFIG_ERROR,
        `PowerShell winpty backend is unavailable: ${reason}`,
        { requestedBackend: 'winpty', reason },
      );
    }
  }

  private buildWinptyProbeScript(): string {
    return [
      "const pty = require('node-pty');",
      'let exited = false;',
      `const child = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit'], { name: ${JSON.stringify(this.runtimePtyConfig.termName)}, cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: false });`,
      'child.onData(() => {});',
      'child.onExit(() => { exited = true; process.exit(0); });',
      "setTimeout(() => { if (!exited) { process.exit(124); } }, 1500);",
    ].join('');
  }

  /**
   * Inject CWD tracking hook into the shell session.
   * - PowerShell / cmd: override prompt function to write $PWD to temp file
   * - Bash / zsh / sh / WSL: use PROMPT_COMMAND to write $PWD to temp file
   */
  private injectCwdHook(
    id: string,
    sessionData: SessionData,
    ptyProcess: pty.IPty,
    shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd'
  ): void {
    const cwdFile = sessionData.cwdFilePath ?? this.getCwdTrackingFilePath(id);
    sessionData.cwdFilePath = cwdFile;

    if (shellType === 'powershell') {
      // PowerShell prompt hook is installed at startup args to avoid racing user input.
    } else if (shellType === 'cmd') {
      const escapedPath = cwdFile.replace(/\\/g, '\\\\');
      const hookScript = `$Global:__OrigPrompt = $function:prompt; function Global:prompt { $pwd.Path | Out-File -FilePath '${escapedPath}' -Encoding utf8 -NoNewline; if ($Global:__OrigPrompt) { & $Global:__OrigPrompt } else { "PS $($pwd.Path)> " } }\r`;
      setTimeout(() => {
        ptyProcess.write(hookScript);
      }, 500);
    } else {
      // Bash / zsh / sh / WSL: CWD tracking hook
      // Convert Windows temp path to WSL path if needed
      const wslPath = this.platform === 'win32'
        ? '/mnt/' + cwdFile[0].toLowerCase() + cwdFile.slice(2).replace(/\\/g, '/')
        : cwdFile;

      let hookScript: string;
      if (shellType === 'zsh') {
        // zsh uses precmd hook (PROMPT_COMMAND is bash-only)
        hookScript = ` precmd() { printf "%s" "$PWD" > "${wslPath}"; }\r`;
      } else if (shellType === 'sh') {
        // POSIX sh: embed in PS1 (no PROMPT_COMMAND or precmd)
        hookScript = ` PS1='$(printf "%s" "$PWD" > "${wslPath}")$ '\r`;
      } else {
        // bash / wsl (bash): use PROMPT_COMMAND
        hookScript = ` PROMPT_COMMAND='printf "%s" "$PWD" > "${wslPath}"'\r`;
      }
      setTimeout(() => {
        ptyProcess.write(hookScript);
      }, 500);
    }

    // Watch CWD file for changes and push via WS
    // Note: lstat symlink check omitted — localhost-only tool, LOW risk per security analysis.
    // The shell hook writes to cwdFile as the same OS user, so symlink attacks require
    // same-user access to the temp directory which already grants full filesystem access.
    watchFile(cwdFile, { interval: 1000 }, () => {
      try {
        const raw = readFileSync(cwdFile, 'utf8');
        const cwd = sanitizeCwd(raw);
        const currentData = this.sessions.get(id);
        const derivedState = currentData ? this.ensureDerivedState(currentData) : null;
        const fileMtime = statSync(cwdFile).mtimeMs;
        const ignoreStaleForegroundPrompt = Boolean(
          currentData &&
          derivedState?.ownership === 'foreground_app' &&
          currentData.foregroundStartedAt !== undefined &&
          fileMtime <= (currentData.foregroundStartedAt + 5),
        );
        if (!ignoreStaleForegroundPrompt) {
          this.transitionToShellPrompt(id, 'cwd_prompt_refresh');
        }
        if (cwd && currentData) {
          this.markSessionStartupReady(id, currentData, 'cwd_file_ready');
        }
        if (cwd && cwd !== sessionData.lastCwd) {
          sessionData.lastCwd = cwd;
          sessionData.processMetadata.cwd = cwd;
          this.broadcastWs(id, 'cwd', { cwd });
          this.cwdChangeCallback?.(id, cwd);
        }
      } catch { /* file may not exist yet — ignore */ }
    });
  }

  private buildPowerShellArgs(cwdFilePath?: string): string[] {
    if (!cwdFilePath) {
      return [];
    }

    const escapedPath = cwdFilePath.replace(/'/g, "''");
    const hookScript = [
      "$Global:__BuilderGateUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      "$Global:__BuilderGateWritePwd = { param([string]$PathValue) try { [System.IO.File]::WriteAllText('" + escapedPath + "', $PathValue, $Global:__BuilderGateUtf8NoBom) } catch {} }",
      '$Global:__BuilderGateOrigPrompt = $function:prompt',
      '& $Global:__BuilderGateWritePwd $pwd.Path',
      "function Global:prompt { & $Global:__BuilderGateWritePwd $pwd.Path; if ($Global:__BuilderGateOrigPrompt) { & $Global:__BuilderGateOrigPrompt } else { \"PS $($pwd.Path)> \" } }",
    ].join('; ');
    const encodedScript = Buffer.from(hookScript, 'utf16le').toString('base64');

    return ['-NoLogo', '-NoExit', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript];
  }

  private getCwdTrackingFilePath(sessionId: string): string {
    return path.join(os.tmpdir(), `buildergate-cwd-${sessionId}.txt`);
  }

  // ==========================================================================
  // WebSocket Integration (Step 8)
  // ==========================================================================

  setWsRouter(router: WsRouter): void {
    this.wsRouter = router;
  }

  // @req MIG-BGSTAB-002 AC-2 AC-3
  setTerminalAuthorityRuntimeFactory(factory: TerminalAuthorityRuntimeFactory | null): void {
    if (!factory) {
      if ([...this.sessions.values()].some(data => data.terminalAuthorityRuntime)) {
        throw new Error('terminal-authority-runtime-factory-clear-requires-owner-disposal');
      }
      this.terminalAuthorityRuntimeFactory = null;
      return;
    }
    if (this.terminalAuthorityRuntimeFactory
      && this.terminalAuthorityRuntimeFactory !== factory) {
      throw new Error('terminal-authority-runtime-factory-already-registered');
    }

    const staged: Array<{
      sessionId: string;
      data: SessionData;
      runtime: TerminalAuthoritySessionRuntime;
    }> = [];
    try {
      for (const [sessionId, data] of this.sessions) {
        if (!data.headless) continue;
        if (data.terminalAuthorityRuntime
          && data.terminalAuthorityController === data.terminalAuthorityRuntime.controller
          && data.terminalQueryResponder === data.terminalAuthorityRuntime.queryResponder
          && data.terminalQueryResponder.attachedHeadlessState === data.headless) {
          continue;
        }
        if (data.terminalAuthorityRuntime
          || data.terminalAuthorityController
          || data.terminalQueryResponder) {
          throw new Error('terminal-authority-runtime-partial-attachment');
        }
        this.synchronizeTerminalAuthoritySourceOrdinal(data);
        staged.push({
          sessionId,
          data,
          runtime: this.createTerminalAuthorityRuntime(factory, sessionId, data),
        });
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const candidate of staged.reverse()) {
        cleanupErrors.push(...this.disposeStagedTerminalAuthorityRuntime(candidate.runtime));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `terminal-authority-runtime-factory-staging-failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    const attached: typeof staged = [];
    try {
      for (const candidate of staged) {
        if (!this.attachTerminalAuthorityRuntime(candidate.sessionId, candidate.runtime)) {
          throw new Error('terminal-authority-runtime-attachment-failed');
        }
        attached.push(candidate);
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const candidate of attached.reverse()) {
        cleanupErrors.push(...this.disposeTerminalAuthorityRuntimeForSession(candidate.sessionId, candidate.data));
      }
      for (const candidate of staged) {
        if (!attached.includes(candidate)) {
          cleanupErrors.push(...this.disposeStagedTerminalAuthorityRuntime(candidate.runtime));
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `terminal-authority-runtime-attachment-failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
    this.terminalAuthorityRuntimeFactory = factory;
  }

  clearTerminalAuthorityRuntimeFactory(factory: TerminalAuthorityRuntimeFactory): boolean {
    if (this.terminalAuthorityRuntimeFactory !== factory) return false;
    if ([...this.sessions.values()].some(data => data.terminalAuthorityRuntime)) return false;
    this.terminalAuthorityRuntimeFactory = null;
    return true;
  }

  attachTerminalAuthorityRuntime(
    sessionId: string,
    runtime: TerminalAuthoritySessionRuntime,
  ): boolean {
    const data = this.sessions.get(sessionId);
    if (!data
      || !data.headless
      || data.terminalAuthorityRuntime
      || data.terminalAuthorityController
      || data.terminalQueryResponder
      || runtime.queryResponder.attachedHeadlessState !== data.headless) {
      return false;
    }
    data.terminalAuthorityRuntime = runtime;
    data.terminalAuthorityController = runtime.controller;
    data.terminalQueryResponder = runtime.queryResponder;
    return true;
  }

  private synchronizeTerminalAuthoritySourceOrdinal(data: SessionData): void {
    const retainedSourceSeq = BigInt(this.ensureRetainedTerminalSessionState(data).sourceSeq);
    if (data.nextTerminalAuthoritySourceSeq < retainedSourceSeq) {
      data.nextTerminalAuthoritySourceSeq = retainedSourceSeq;
    }
  }

  private createTerminalAuthorityRuntime(
    factory: TerminalAuthorityRuntimeFactory,
    sessionId: string,
    data: SessionData,
  ): TerminalAuthoritySessionRuntime {
    if (!data.headless) throw new Error('terminal-authority-headless-unavailable');
    return factory({
      sessionId,
      authorityEpoch: data.authorityEpoch,
      sessionGeneration: data.authorityEpoch,
      initialStreamEpoch: this.ensureRetainedTerminalSessionState(data).streamEpoch,
      runtimeInstanceGeneration: data.headlessInstanceGeneration,
      headlessState: data.headless,
      processMetadata: data.processMetadata,
      windowsPty: data.windowsPty,
    });
  }

  private disposeStagedTerminalAuthorityRuntime(runtime: TerminalAuthoritySessionRuntime): unknown[] {
    const disposalErrors: unknown[] = [];
    try {
      runtime.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      runtime.queryResponder.detach();
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      runtime.controller.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    return disposalErrors;
  }

  private attachTerminalAuthorityRuntimeForSession(
    sessionId: string,
    data: SessionData,
  ): void {
    if (!this.terminalAuthorityRuntimeFactory || !data.headless) return;
    if (data.terminalAuthorityRuntime
      && data.terminalAuthorityController === data.terminalAuthorityRuntime.controller
      && data.terminalQueryResponder === data.terminalAuthorityRuntime.queryResponder
      && data.terminalQueryResponder.attachedHeadlessState === data.headless) {
      return;
    }
    if (data.terminalAuthorityRuntime
      || data.terminalAuthorityController
      || data.terminalQueryResponder) {
      throw new Error('terminal-authority-runtime-partial-attachment');
    }
    this.synchronizeTerminalAuthoritySourceOrdinal(data);
    const runtime = this.createTerminalAuthorityRuntime(
      this.terminalAuthorityRuntimeFactory,
      sessionId,
      data,
    );
    if (this.attachTerminalAuthorityRuntime(sessionId, runtime)) return;
    const cleanupErrors = this.disposeStagedTerminalAuthorityRuntime(runtime);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [new Error('terminal-authority-runtime-attachment-failed'), ...cleanupErrors],
        'terminal-authority-runtime-attachment-failed-with-cleanup-errors',
      );
    }
    throw new Error('terminal-authority-runtime-attachment-failed');
  }

  private disposeTerminalAuthorityRuntimeForSession(sessionId: string, data: SessionData): unknown[] {
    const disposalErrors: unknown[] = [];
    const runtime = data.terminalAuthorityRuntime;
    if (!runtime) {
      if (data.terminalAuthorityController || data.terminalQueryResponder) {
        disposalErrors.push(new Error('terminal-authority-runtime-partial-attachment'));
      }
      return disposalErrors;
    }
    try {
      runtime.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    if (data.terminalAuthorityController === runtime.controller) {
      try {
        this.detachTerminalAuthorityRuntime(sessionId, runtime.controller);
      } catch (error) {
        disposalErrors.push(error);
      }
    }
    try {
      runtime.queryResponder.detach();
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      runtime.controller.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    if (data.terminalAuthorityRuntime === runtime) {
      data.terminalAuthorityRuntime = undefined;
    }
    if (data.terminalAuthorityController === runtime.controller) {
      data.terminalAuthorityController = undefined;
    }
    if (data.terminalQueryResponder === runtime.queryResponder) {
      data.terminalQueryResponder = undefined;
    }
    if (data.terminalAuthorityRuntime
      || data.terminalAuthorityController
      || data.terminalQueryResponder) {
      disposalErrors.push(new Error('terminal-authority-runtime-disposal-incomplete'));
    }
    data.pendingTerminalAuthorityQueryEffects = [];
    return disposalErrors;
  }

  detachTerminalAuthorityRuntime(
    sessionId: string,
    controller: TerminalAuthorityController,
  ): boolean {
    const data = this.sessions.get(sessionId);
    if (!data || data.terminalAuthorityController !== controller) return false;
    const retained = this.ensureRetainedTerminalSessionState(data);
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);

    // The controller identity above is the ownership fence for this detach.
    // Revoke every concrete server lease before removing the responder/controller
    // references so a caller-owned live session cannot be left with an orphaned
    // server-headless authority. This synchronous lifecycle API cannot complete
    // the wire checkpoint/drain/enable handshake required for compatibility, so
    // it must remain fail-closed instead of claiming a legacy handoff that the
    // browser has never acknowledged.
    if (runtime.driver.activeLeaseId) {
      runtime.driver.revokedLeaseIds.add(runtime.driver.activeLeaseId);
    }
    if (runtime.responder.activeLeaseId) {
      runtime.responder.revokedLeaseIds.add(runtime.responder.activeLeaseId);
    }
    runtime.driver.active = null;
    runtime.driver.activeLeaseId = null;
    runtime.responder.active = null;
    runtime.responder.activeLeaseId = null;
    runtime.responder.legacyEnabled = false;
    runtime.responder.serverEnabled = false;
    runtime.admission = { mode: 'none', transitionEpoch: null };
    retained.driverLease = {
      ownerClientId: null,
      generation: retained.driverLease.generation,
      state: 'revoked',
    };
    retained.driverViewGeneration = null;
    runtime.suspendedBrowserDriver = null;
    runtime.serverRecoveryAcks.clear();
    runtime.noLocalCacheEvidence = null;
    runtime.limitedSessionSelected = false;
    runtime.recoveryRequiredReason = 'authority-runtime-detached-before-ordered-compatibility-recovery';
    retained.blockers.add(runtime.recoveryRequiredReason);
    let responderDetachError: unknown;
    try {
      data.terminalQueryResponder?.detach();
    } catch (error) {
      responderDetachError = error;
    } finally {
      data.terminalQueryResponder = undefined;
      data.terminalAuthorityController = undefined;
      data.terminalAuthorityRuntime = undefined;
      data.pendingTerminalAuthorityQueryEffects = [];
    }
    if (responderDetachError) throw responderDetachError;
    return true;
  }

  async beginTerminalAuthorityPromotion(
    sessionId: string,
    request: TerminalAuthorityPromotionRequest,
  ): Promise<TerminalAuthorityPromotionResult> {
    const data = this.sessions.get(sessionId);
    if (!data?.terminalAuthorityController) return { ok: false, reason: 'authority-runtime-unavailable' };
    const isolation = this.terminalAuthorityDebugIsolations.get(sessionId);
    if (isolation?.cleanupInProgress) {
      return { ok: false, reason: 'debug-isolation-cleanup-active' };
    }
    if (!isolation) return data.terminalAuthorityController.beginPromotion(request);
    if (isolation.promotionInProgress) {
      return { ok: false, reason: 'debug-isolation-promotion-active' };
    }
    isolation.promotionInProgress = true;
    try {
      return await data.terminalAuthorityController.beginPromotion(request);
    } finally {
      if (this.terminalAuthorityDebugIsolations.get(sessionId) === isolation) {
        isolation.promotionInProgress = false;
      }
    }
  }

  // Promotion is rare and must not sample a debounced/stale comparer result.
  // Flush the current session's retained checkpoint comparison after its
  // ordered headless write chain has settled; concurrent busy sessions remain
  // a fail-closed blocker in runRetainedTerminalComparison.
  async settleTerminalAuthorityPromotionEvidence(sessionId: string): Promise<void> {
    const data = this.sessions.get(sessionId);
    if (!data?.headless) return;
    await data.headlessWriteChain;
    const retained = this.ensureRetainedTerminalSessionState(data);
    if (retained.comparisonTimer) {
      clearTimeout(retained.comparisonTimer);
      retained.comparisonTimer = null;
    }
    if (retained.comparisonInFlight) return;
    retained.comparisonPendingSourceSeq = retained.sourceSeq;
    await this.runRetainedTerminalComparison(sessionId, data, { allowBusySiblings: true });
  }

  async acknowledgeTerminalAuthorityLegacyDisable(
    sessionId: string,
    identity: TerminalAuthorityResponderIdentity,
  ): Promise<{ accepted: boolean; duplicate?: boolean; completed?: boolean; reason?: string }> {
    const data = this.sessions.get(sessionId);
    if (!data?.terminalAuthorityController) return { accepted: false, reason: 'authority-runtime-unavailable' };
    const result = await data.terminalAuthorityController.acknowledgeLegacyDisable(identity);
    if (result.accepted && result.completed) {
      this.flushPendingTerminalAuthorityQueryEffects(data);
    }
    return result;
  }

  async beginTerminalAuthorityRollback(
    sessionId: string,
    request: Parameters<TerminalAuthorityController['beginRollback']>[0],
  ): Promise<{ ok: boolean; reason?: string }> {
    const controller = this.sessions.get(sessionId)?.terminalAuthorityController;
    return controller
      ? controller.beginRollback(request)
      : { ok: false, reason: 'authority-runtime-unavailable' };
  }

  writeTerminalQueryReply(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || data.length === 0) return false;
    session.pty.write(data);
    const debugIsolation = this.terminalAuthorityDebugIsolations.get(sessionId);
    if (debugIsolation) {
      debugIsolation.queryPtyReplyCount += 1;
      debugIsolation.lastQueryReply = data;
    }
    return true;
  }

  // @req MIG-BGSTAB-002 AC-3 AC-5
  writeTerminalAuthorityServerQueryReply(
    sessionId: string,
    input: { responderLeaseId: string; reply: string },
  ): boolean {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained || input.reply.length === 0) return false;
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.admission.mode !== 'server'
      || runtime.responder.active !== 'server-headless'
      || runtime.responder.activeLeaseId !== input.responderLeaseId
      || !runtime.responder.serverEnabled
      || runtime.responder.revokedLeaseIds.has(input.responderLeaseId)) {
      return false;
    }
    return this.writeTerminalQueryReply(sessionId, input.reply);
  }

  // @req MIG-BGSTAB-002 AC-3 AC-5
  writeTerminalAuthorityCompatibilityQueryReply(
    sessionId: string,
    input: {
      responderLeaseId: string;
      clientId: string;
      viewGeneration: number;
      reply: string;
    },
  ): boolean {
    const retained = this.sessions.get(sessionId)?.retainedTerminal;
    if (!retained || input.reply.length === 0) return false;
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const browserDriver = runtime.suspendedBrowserDriver;
    if (runtime.admission.mode !== 'legacy'
      || runtime.responder.active !== 'legacy-browser'
      || runtime.responder.activeLeaseId !== input.responderLeaseId
      || !runtime.responder.legacyEnabled
      || runtime.responder.revokedLeaseIds.has(input.responderLeaseId)
      || runtime.driver.active !== 'legacy-browser'
      || retained.driverLease.state !== 'active'
      || browserDriver?.clientId !== input.clientId
      || browserDriver.viewGeneration !== input.viewGeneration) {
      return false;
    }
    return this.writeTerminalQueryReply(sessionId, input.reply);
  }

  pushTerminalAuthorityViewAttributes(
    sessionId: string,
    input: {
      identity: DriverViewAttributesPushIdentity;
      attributes: TerminalViewAttributes;
    },
  ): { accepted: boolean; reason?: string } {
    const responder = this.sessions.get(sessionId)?.terminalQueryResponder;
    if (!responder) return { accepted: false, reason: 'query-responder-unavailable' };
    return responder.pushViewAttributes(input);
  }

  getTerminalAuthorityQueryCapabilityState(sessionId: string): {
    promotionEligible: boolean;
    blocker?: string;
    hasAcceptedViewAttributes: boolean;
  } | null {
    const responder = this.sessions.get(sessionId)?.terminalQueryResponder;
    if (!responder) return null;
    const capability = responder.getCapabilityState();
    return {
      promotionEligible: capability.promotionEligible,
      ...(capability.blocker ? { blocker: capability.blocker } : {}),
      hasAcceptedViewAttributes: responder.hasAcceptedViewAttributes(),
    };
  }

  getTerminalAuthorityController(sessionId: string): TerminalAuthorityController | undefined {
    return this.sessions.get(sessionId)?.terminalAuthorityController;
  }

  getTerminalAuthorityState(sessionId: string): TerminalAuthorityState | undefined {
    return this.sessions.get(sessionId)?.terminalAuthorityController?.getState();
  }

  hasTerminalAuthorityDebugIsolation(sessionId: string): boolean {
    return this.terminalAuthorityDebugIsolations.has(sessionId);
  }

  acceptTerminalAuthorityLegacyBrowserQueryReply(
    sessionId: string,
    input: TerminalAuthorityResponderIdentity & { replyOrdinal: number; reply: string },
  ): { accepted: boolean; duplicate?: boolean; completed?: boolean; reason?: string } {
    const controller = this.sessions.get(sessionId)?.terminalAuthorityController;
    return controller?.acceptLegacyBrowserQueryReply(input)
      ?? { accepted: false, reason: 'authority-runtime-unavailable' };
  }

  // @req MIG-BGSTAB-002 AC-4 AC-6
  async beginTerminalAuthorityDebugIsolation(input: {
    sessionId: string;
    desiredMode: 'legacy' | 'server';
    cleanupToken: string;
    isolationLeaseId: string;
    transitionPolicy: string;
    testContract?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const data = this.sessions.get(input.sessionId);
    if (!data?.headless || this.terminalAuthorityDebugIsolations.has(input.sessionId)) {
      return { accepted: false, reason: data ? 'debug-isolation-already-active' : 'session-unavailable' };
    }
    const configuredPolicy = this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines;
    const retainedOverride = this.readTerminalAuthorityDebugRetainedOverride(input.testContract);
    const retained = this.ensureRetainedTerminalSessionState(data);
    const originalCheckpoint = {
      ...serializeRetainedHeadlessCheckpoint(data.headless),
      pendingEscapeTailAnsi: data.pendingEscapeTailAnsi,
    };
    const isolation: TerminalAuthorityDebugIsolationState = {
      cleanupToken: input.cleanupToken,
      isolationLeaseId: input.isolationLeaseId,
      desiredMode: input.desiredMode,
      transitionPolicy: input.transitionPolicy,
      retainedScrollbackOverride: retainedOverride,
      originalRetainedScrollbackLines: configuredPolicy.value,
      retainedCorpusFixture: false,
      alternateBufferFixture: false,
      queryPtyReplyCount: 0,
      lastQueryReply: null,
      rollbackPostBoundaryOutput: null,
      originalAuthorityMode: data.terminalAuthorityController?.getState().mode ?? 'legacy',
      originalAuthorityStreamEpoch: data.terminalAuthorityController?.getState().streamEpoch
        ?? retained.streamEpoch,
      originalCheckpoint,
      originalParserComplete: data.parserComplete,
      cleanupInProgress: false,
      promotionInProgress: false,
      originalRetainedLedger: {
        streamEpoch: retained.streamEpoch,
        sourceSeq: retained.sourceSeq,
        snapshotSeq: retained.snapshotSeq,
        oldestRetainedSeq: retained.oldestRetainedSeq,
        oldestRetainedStreamEpoch: retained.oldestRetainedStreamEpoch,
        records: structuredClone(retained.records),
        facts: structuredClone(retained.facts),
        committedFactKeys: new Set(retained.committedFactKeys),
        factOrdinal: retained.factOrdinal,
        factScannerTail: retained.factScannerTail,
        evictedRecords: retained.evictedRecords,
        evictedFacts: retained.evictedFacts,
        ledgerEncodedBytes: retained.ledgerEncodedBytes,
        ledgerRecordEncodedBytes: retained.ledgerRecordEncodedBytes,
        ledgerFactEncodedBytes: retained.ledgerFactEncodedBytes,
        ledgerFactKeyEncodedBytes: retained.ledgerFactKeyEncodedBytes,
        blockers: new Set(retained.blockers),
        comparer: structuredClone(retained.comparer),
        lastCheckpoint: retained.lastCheckpoint ? structuredClone(retained.lastCheckpoint) : null,
        totalLogicalRowsObserved: retained.totalLogicalRowsObserved,
        eviction: structuredClone(retained.eviction),
      },
    };
    this.terminalAuthorityDebugIsolations.set(input.sessionId, isolation);
    try {
      if (retainedOverride !== null) {
        await this.recreateTerminalAuthorityDebugHeadless(input.sessionId, data, retainedOverride);
      }
      return {
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
        ...this.buildTerminalAuthorityDebugPolicyEvidence(input.sessionId, isolation),
      };
    } catch (error) {
      this.terminalAuthorityDebugIsolations.delete(input.sessionId);
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : 'debug-isolation-open-failed',
      };
    }
  }

  // @req MIG-BGSTAB-002 AC-3 AC-4
  async applyTerminalAuthorityDebugIsolationContract(input: {
    sessionId: string;
    desiredMode: 'legacy' | 'server';
    cleanupToken: string;
    isolationLeaseId: string;
    testContract: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const isolation = this.terminalAuthorityDebugIsolations.get(input.sessionId);
    const data = this.sessions.get(input.sessionId);
    if (!isolation || !data?.headless
      || isolation.cleanupToken !== input.cleanupToken
      || isolation.isolationLeaseId !== input.isolationLeaseId) {
      return { accepted: false, reason: 'debug-isolation-identity-mismatch' };
    }
    const responseContract: Record<string, unknown> = { contractVersion: 1 };
    const retainedCorpus = this.asTerminalAuthorityDebugRecord(input.testContract.retainedCorpusInjection);
    if (retainedCorpus) {
      const decoded = this.decodeTerminalAuthorityDebugPayload(retainedCorpus);
      if (!decoded.ok) return { accepted: false, reason: decoded.reason };
      const injected = await this.injectTerminalAuthorityDebugOutput(input.sessionId, decoded.data);
      if (!injected) return { accepted: false, reason: 'debug-retained-corpus-injection-failed' };
      isolation.retainedCorpusFixture = true;
      const checkpoint = serializeRetainedHeadlessCheckpoint(data.headless);
      isolation.alternateBufferFixture = checkpoint.activeBuffer === 'alternate';
      responseContract.retainedCorpusInjection = {
        ...retainedCorpus,
        accepted: true,
        activeBuffer: checkpoint.activeBuffer,
        savedCursor: checkpoint.savedCursor ? 'present-normal-buffer' : 'absent',
      };
      const retainedPolicyOverride = this.asTerminalAuthorityDebugRecord(
        input.testContract.retainedPolicyOverride,
      );
      if (retainedPolicyOverride) {
        responseContract.retainedPolicyOverride = { ...retainedPolicyOverride, accepted: true };
      }
    }

    const configuredProbe = this.asTerminalAuthorityDebugRecord(
      input.testContract.productionConfiguredRangeProbe,
    );
    if (configuredProbe) {
      const generated = await this.injectTerminalAuthorityDebugConfiguredCorpus(
        input.sessionId,
        configuredProbe,
      );
      if (!generated.ok) return { accepted: false, reason: generated.reason };
      isolation.retainedCorpusFixture = true;
      responseContract.productionConfiguredRangeProbe = {
        ...configuredProbe,
        accepted: true,
        peakMaterializedPhysicalLines: generated.windowLines,
        generatorWindowPhysicalLines: generated.windowLines,
        fullCellMaterializationCount: 0,
      };
    }

    const queryProbe = this.asTerminalAuthorityDebugRecord(input.testContract.queryResponderProbe);
    if (queryProbe) {
      const decoded = this.decodeTerminalAuthorityDebugPayload(queryProbe);
      if (!decoded.ok) return { accepted: false, reason: decoded.reason };
      const authoritativeModelInstanceId = this.getTerminalAuthorityDebugModelInstanceId(input.sessionId);
      if (queryProbe.authoritativeModelInstanceId !== authoritativeModelInstanceId) {
        return { accepted: false, reason: 'debug-query-model-identity-mismatch' };
      }
      let inputCopies = 0;
      const beforeSeedReplies = isolation.queryPtyReplyCount;
      await data.terminalQueryResponder?.captureCommittedWrite(
        decoded.data,
        { source: 'seed' },
        async () => {
          await this.writeHeadlessTerminalFn(data.headless!, decoded.data);
          inputCopies += 1;
        },
      );
      const seedPtyReplyCount = isolation.queryPtyReplyCount - beforeSeedReplies;
      const beforeReplayReplies = isolation.queryPtyReplyCount;
      await data.terminalQueryResponder?.captureCommittedWrite(
        decoded.data,
        { source: 'replay' },
        async () => {
          await this.writeHeadlessTerminalFn(data.headless!, decoded.data);
          inputCopies += 1;
        },
      );
      const replayPtyReplyCount = isolation.queryPtyReplyCount - beforeReplayReplies;
      const beforeLiveReplies = isolation.queryPtyReplyCount;
      const injected = await this.injectTerminalAuthorityDebugOutput(input.sessionId, decoded.data);
      if (!injected) return { accepted: false, reason: 'debug-query-injection-failed' };
      inputCopies += 1;
      const livePtyReplyCount = isolation.queryPtyReplyCount - beforeLiveReplies;
      const replyCount = seedPtyReplyCount + replayPtyReplyCount + livePtyReplyCount;
      const reply = isolation.lastQueryReply ?? '';
      responseContract.queryResponderProbe = {
        ...queryProbe,
        accepted: true,
        authoritativeModelInstanceId,
        inputCopies,
        browserReplyCount: 0,
        seedBrowserReplyCount: 0,
        seedPtyReplyCount,
        replayBrowserReplyCount: 0,
        replayPtyReplyCount,
        liveBrowserReplyCount: 0,
        livePtyReplyCount,
        serverPtyReplyCount: replyCount,
        duplicatePtyReplyCount: Math.max(0, livePtyReplyCount - 1),
        replyOrdinal: 0,
        replyEncoding: 'base64',
        replyData: Buffer.from(reply, 'utf8').toString('base64'),
        effectDisposition: seedPtyReplyCount === 0
          && replayPtyReplyCount === 0
          && livePtyReplyCount === 1
          ? 'committed-once'
          : 'not-committed-once',
      };
    }

    const deterministicTail = this.asTerminalAuthorityDebugRecord(
      input.testContract.deterministicPostSnapshotTail,
    );
    if (deterministicTail) {
      const decoded = this.decodeTerminalAuthorityDebugPayload(deterministicTail);
      if (!decoded.ok) return { accepted: false, reason: decoded.reason };
      const injected = await this.injectTerminalAuthorityDebugOutput(input.sessionId, decoded.data);
      if (!injected) return { accepted: false, reason: 'debug-post-snapshot-tail-injection-failed' };
      responseContract.deterministicPostSnapshotTail = { ...deterministicTail, accepted: true };
    }

    if (Object.keys(responseContract).length === 1) {
      return { accepted: false, reason: 'debug-isolation-contract-action-unsupported' };
    }
    return {
      accepted: true,
      cleanupToken: isolation.cleanupToken,
      isolationLeaseId: isolation.isolationLeaseId,
      allAffectedViewsDrained: true,
      ...this.buildTerminalAuthorityDebugPolicyEvidence(input.sessionId, isolation),
      ...responseContract,
      testContract: responseContract,
    };
  }

  // @req MIG-BGSTAB-002 AC-4 AC-6
  async cleanupTerminalAuthorityDebugIsolation(input: {
    sessionId: string;
    cleanupToken: string | null;
    isolationLeaseId: string | null;
    restoreScopes: readonly string[];
    authorityFence: Readonly<Pick<
      TerminalAuthorityState,
      'mode' | 'authorityEpoch' | 'streamEpoch' | 'transitionEpoch'
    >>;
  }): Promise<Record<string, unknown>> {
    const isolation = this.terminalAuthorityDebugIsolations.get(input.sessionId);
    const data = this.sessions.get(input.sessionId);
    if (!isolation || !data
      || isolation.cleanupToken !== input.cleanupToken
      || isolation.isolationLeaseId !== input.isolationLeaseId) {
      if (!isolation && data) return {
        accepted: true,
        restoredScopes: [...input.restoreScopes],
        restored: createTerminalAuthorityDebugRestoredEvidence(),
      };
      return { accepted: false, reason: 'debug-isolation-cleanup-identity-mismatch' };
    }
    if (isolation.cleanupInProgress) {
      return { accepted: false, reason: 'debug-isolation-cleanup-active' };
    }
    if (isolation.promotionInProgress) {
      return { accepted: false, reason: 'debug-isolation-promotion-active' };
    }
    const authorityState = data.terminalAuthorityController?.getState();
    const authorityFence = input.authorityFence;
    if (!authorityState || !authorityFence
      || authorityFence.mode !== 'legacy'
      || authorityState.mode !== authorityFence.mode
      || authorityState.authorityEpoch !== authorityFence.authorityEpoch
      || authorityState.streamEpoch !== authorityFence.streamEpoch
      || authorityState.transitionEpoch !== authorityFence.transitionEpoch) {
      return { accepted: false, reason: 'debug-isolation-cleanup-authority-fence-mismatch' };
    }
    isolation.cleanupInProgress = true;
    try {
      const modelUntouched = isolation.retainedScrollbackOverride === null
        && !isolation.retainedCorpusFixture
        && !isolation.alternateBufferFixture
        && isolation.queryPtyReplyCount === 0
        && isolation.lastQueryReply === null
        && isolation.rollbackPostBoundaryOutput === null;
      const authorityUntouched = authorityState?.mode === isolation.originalAuthorityMode
        && authorityState.streamEpoch === isolation.originalAuthorityStreamEpoch;
      if (modelUntouched && authorityUntouched) {
        this.terminalAuthorityDebugIsolations.delete(input.sessionId);
        return {
          accepted: true,
          restoredScopes: [...input.restoreScopes],
          restored: createTerminalAuthorityDebugRestoredEvidence(),
        };
      }
      this.restoreTerminalAuthorityDebugRetainedLedger(data, isolation);
      data.cols = isolation.originalCheckpoint.cols;
      data.rows = isolation.originalCheckpoint.rows;
      await this.recreateTerminalAuthorityDebugHeadless(
        input.sessionId,
        data,
        isolation.originalRetainedScrollbackLines,
        isolation.originalCheckpoint,
        isolation.originalParserComplete,
        true,
      );
      this.restoreTerminalAuthorityDebugRetainedLedger(data, isolation);
      this.terminalAuthorityDebugIsolations.delete(input.sessionId);
      return {
        accepted: true,
        restoredScopes: [...input.restoreScopes],
        restored: createTerminalAuthorityDebugRestoredEvidence(),
      };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : 'debug-isolation-cleanup-failed',
      };
    } finally {
      if (this.terminalAuthorityDebugIsolations.get(input.sessionId) === isolation) {
        isolation.cleanupInProgress = false;
      }
    }
  }

  // @req MIG-BGSTAB-002 AC-6
  getTerminalAuthorityDebugResourceInventory(sessionId: string): {
    resourceInventory: TerminalAuthorityDebugResourceInventory;
    details: Record<string, unknown>;
  } {
    const isolation = this.terminalAuthorityDebugIsolations.get(sessionId);
    const resourceInventory: TerminalAuthorityDebugResourceInventory = {
      retainedPolicyOverrides: isolation?.retainedScrollbackOverride !== null && isolation ? 1 : 0,
      cleanupTokens: isolation ? 1 : 0,
      isolationLeases: isolation ? 1 : 0,
      retainedCorpusFixtures: isolation?.retainedCorpusFixture ? 1 : 0,
      alternateBufferFixtures: isolation?.alternateBufferFixture ? 1 : 0,
      responderOverrides: isolation ? 1 : 0,
      listeners: 0,
      driverLeases: isolation ? 1 : 0,
      responderLeases: isolation ? 1 : 0,
      timers: 0,
      faultStates: 0,
      queryEffectLedgers: isolation?.queryPtyReplyCount ? 1 : 0,
      heldOutputQueues: isolation?.rollbackPostBoundaryOutput ? 1 : 0,
    };
    return {
      resourceInventory,
      details: {
        authoritativeModelInstanceId: this.getTerminalAuthorityDebugModelInstanceId(sessionId),
        authoritativeSourceSeq: this.sessions.get(sessionId)?.retainedTerminal?.sourceSeq ?? null,
      },
    };
  }

  // @req MIG-BGSTAB-002 AC-5
  prepareTerminalAuthorityDebugRollbackContract(input: {
    sessionId: string;
    reason: string;
    testContract?: Record<string, unknown>;
  }): Record<string, unknown> {
    const isolation = this.terminalAuthorityDebugIsolations.get(input.sessionId);
    if (!isolation) return { accepted: false, reason: 'debug-isolation-unavailable' };
    const response: Record<string, unknown> = { contractVersion: 1 };
    const injection = this.asTerminalAuthorityDebugRecord(input.testContract?.postBoundaryOutputInjection);
    if (injection) {
      const decoded = this.decodeTerminalAuthorityDebugPayload(injection);
      if (!decoded.ok) return { accepted: false, reason: decoded.reason };
      isolation.rollbackPostBoundaryOutput = decoded.data;
      response.postBoundaryOutputInjection = { ...injection, accepted: true };
    }
    return {
      accepted: true,
      reason: input.reason,
      ...(input.testContract ? { testContract: response } : {}),
    };
  }

  getTerminalAuthorityDebugModelInstanceId(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data?.headless
      ? `headless:${sessionId}:${data.authorityEpoch}:${data.headlessInstanceGeneration}`
      : null;
  }

  takeTerminalAuthorityDebugRollbackPostBoundaryOutput(sessionId: string): string | null {
    const isolation = this.terminalAuthorityDebugIsolations.get(sessionId);
    if (!isolation) return null;
    const output = isolation.rollbackPostBoundaryOutput;
    isolation.rollbackPostBoundaryOutput = null;
    return output;
  }

  async injectTerminalAuthorityDebugRollbackPostBoundaryOutput(
    sessionId: string,
    output: string,
  ): Promise<boolean> {
    return this.injectTerminalAuthorityDebugOutput(sessionId, output);
  }

  private asTerminalAuthorityDebugRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private readTerminalAuthorityDebugRetainedOverride(
    testContract: Record<string, unknown> | undefined,
  ): number | null {
    const override = this.asTerminalAuthorityDebugRecord(testContract?.retainedPolicyOverride);
    const value = override?.effectiveRetainedScrollbackLines;
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 50_000
      ? Number(value)
      : null;
  }

  private decodeTerminalAuthorityDebugPayload(value: Record<string, unknown>):
    | { ok: true; data: string }
    | { ok: false; reason: string } {
    if (value.encoding !== 'base64' || typeof value.data !== 'string') {
      return { ok: false, reason: 'debug-payload-encoding-invalid' };
    }
    const payload = Buffer.from(value.data, 'base64');
    if (value.decodedBytes !== payload.byteLength
      || value.sha256 !== createHash('sha256').update(payload).digest('hex')) {
      return { ok: false, reason: 'debug-payload-integrity-invalid' };
    }
    return { ok: true, data: payload.toString('utf8') };
  }

  private buildTerminalAuthorityDebugPolicyEvidence(
    sessionId: string,
    isolation: TerminalAuthorityDebugIsolationState,
  ): Record<string, unknown> {
    const configured = this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines;
    const effective = isolation.retainedScrollbackOverride ?? configured.value;
    const retentionPolicyId = this.getTerminalAuthorityDebugRetentionPolicyId(isolation);
    return {
      productionConfiguredRetainedScrollbackLines: configured.value,
      productionConfiguredRetainedScrollbackSource: configured.source,
      productionConfiguredRetentionPolicyId: this.compiledTerminalResourcePolicy.legacyPolicy.policyId,
      effectiveHeadlessRetainedScrollbackLines: effective,
      authoritativeModelInstanceId: this.getTerminalAuthorityDebugModelInstanceId(sessionId),
      retentionPolicy: {
        effectiveRetainedScrollbackLines: effective,
        retentionPolicyId,
        source: configured.source,
      },
    };
  }

  private getTerminalAuthorityDebugRetentionPolicyId(
    isolation: TerminalAuthorityDebugIsolationState | undefined,
  ): string {
    const configured = this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value;
    const override = isolation?.retainedScrollbackOverride;
    if (!isolation || override === null || override === configured) {
      return this.compiledTerminalResourcePolicy.legacyPolicy.policyId;
    }
    return `${this.compiledTerminalResourcePolicy.legacyPolicy.policyId}:debug:${isolation.isolationLeaseId}`;
  }

  private restoreTerminalAuthorityDebugRetainedLedger(
    data: SessionData,
    isolation: TerminalAuthorityDebugIsolationState,
  ): void {
    const retained = this.ensureRetainedTerminalSessionState(data);
    const original = isolation.originalRetainedLedger;
    const liveAuthorityStreamEpoch = data.terminalAuthorityController?.getState().streamEpoch
      ?? retained.streamEpoch;
    const restoredStreamEpoch = BigInt(liveAuthorityStreamEpoch) > BigInt(original.streamEpoch)
      ? liveAuthorityStreamEpoch
      : original.streamEpoch;
    const liveSourceSeq = data.nextTerminalAuthoritySourceSeq > BigInt(retained.sourceSeq)
      ? data.nextTerminalAuthoritySourceSeq
      : BigInt(retained.sourceSeq);
    const restoredSourceSeq = liveSourceSeq > BigInt(original.sourceSeq)
      ? liveSourceSeq.toString()
      : original.sourceSeq;
    const restoredSnapshotSeq = BigInt(retained.snapshotSeq) > BigInt(original.snapshotSeq)
      ? retained.snapshotSeq
      : original.snapshotSeq;
    this.setTerminalStreamEpoch(data.session.id, retained, restoredStreamEpoch, 'authority-rollback');
    retained.sourceSeq = restoredSourceSeq;
    retained.snapshotSeq = restoredSnapshotSeq;
    retained.oldestRetainedSeq = original.oldestRetainedSeq;
    retained.oldestRetainedStreamEpoch = original.oldestRetainedStreamEpoch;
    retained.records = structuredClone(original.records);
    retained.facts = structuredClone(original.facts);
    retained.committedFactKeys = new Set(original.committedFactKeys);
    retained.factOrdinal = original.factOrdinal;
    retained.factScannerTail = original.factScannerTail;
    retained.evictedRecords = original.evictedRecords;
    retained.evictedFacts = original.evictedFacts;
    retained.ledgerEncodedBytes = original.ledgerEncodedBytes;
    retained.ledgerRecordEncodedBytes = original.ledgerRecordEncodedBytes;
    retained.ledgerFactEncodedBytes = original.ledgerFactEncodedBytes;
    retained.ledgerFactKeyEncodedBytes = original.ledgerFactKeyEncodedBytes;
    retained.blockers = new Set(original.blockers);
    retained.comparer = structuredClone(original.comparer);
    retained.lastCheckpoint = original.lastCheckpoint
      ? structuredClone(original.lastCheckpoint)
      : null;
    retained.totalLogicalRowsObserved = original.totalLogicalRowsObserved;
    retained.eviction = structuredClone(original.eviction);
    data.nextTerminalAuthoritySourceSeq = BigInt(restoredSourceSeq);
  }

  private async recreateTerminalAuthorityDebugHeadless(
    sessionId: string,
    data: SessionData,
    scrollbackLines: number,
    restoreCheckpoint?: RetainedHeadlessCheckpoint & { pendingEscapeTailAnsi: string },
    restoreParserComplete = true,
    resetRuntimeLeaseTombstones = false,
  ): Promise<void> {
    const previousHeadlessWriteChain = data.headlessWriteChain;
    const recreation = previousHeadlessWriteChain.then(async () => {
    const retainedBeforeRecreation = this.ensureRetainedTerminalSessionState(data);
    const runtimeBeforeRecreation = this.ensureTerminalAuthorityRuntimePortState(
      retainedBeforeRecreation,
    );
    const preferredBrowserDriver = runtimeBeforeRecreation.suspendedBrowserDriver
      ? { ...runtimeBeforeRecreation.suspendedBrowserDriver }
      : retainedBeforeRecreation.driverLease.ownerClientId
        && retainedBeforeRecreation.driverViewGeneration !== null
        ? {
            clientId: retainedBeforeRecreation.driverLease.ownerClientId,
            viewGeneration: retainedBeforeRecreation.driverViewGeneration,
            leaseGeneration: retainedBeforeRecreation.driverLease.generation,
          }
        : null;
    const runtimeDisposalErrors = this.disposeTerminalAuthorityRuntimeForSession(sessionId, data);
    if (runtimeDisposalErrors.length > 0) {
      throw new AggregateError(
        runtimeDisposalErrors,
        'terminal-authority-runtime-headless-recreation-cleanup-failed',
      );
    }
    if (resetRuntimeLeaseTombstones) {
      const authorityRuntime = this.ensureTerminalAuthorityRuntimePortState(
        this.ensureRetainedTerminalSessionState(data),
      );
      authorityRuntime.driver.revokedLeaseIds.clear();
      authorityRuntime.responder.revokedLeaseIds.clear();
    }
    if (data.headless) disposeHeadlessTerminal(data.headless);
    data.headless = this.createHeadlessTerminalStateFn({
      cols: data.cols,
      rows: data.rows,
      scrollbackLines,
      windowsPty: data.windowsPty,
    });
    data.headlessInstanceGeneration += 1;
    data.headlessHealth = 'healthy';
    data.headlessDegradedPhase = null;
    if (restoreCheckpoint && restoreCheckpoint.serializedData.length > 0) {
      await this.writeHeadlessTerminalFn(data.headless, restoreCheckpoint.serializedData);
    }
    data.pendingEscapeTailAnsi = '';
    data.parserComplete = true;
    data.parserTailOverflow = false;
    const restoredParserTail = restoreCheckpoint?.pendingEscapeTailAnsi ?? '';
    if (restoredParserTail.length > 0) {
      this.advanceSessionTerminalParserState(data, restoredParserTail);
    }
    if (data.pendingEscapeTailAnsi !== restoredParserTail
      || data.parserComplete !== (restoreCheckpoint ? restoreParserComplete : true)) {
      throw new Error('terminal-authority-debug-parser-state-restore-mismatch');
    }
    data.unsnapshottedOutput = '';
    data.unsnapshottedOutputTruncated = false;
    data.snapshotCache = null;
    const retained = this.ensureRetainedTerminalSessionState(data);
    retained.lastCheckpoint = {
      ...serializeRetainedHeadlessCheckpoint(data.headless),
      pendingEscapeTailAnsi: data.pendingEscapeTailAnsi,
    };
    this.attachTerminalAuthorityRuntimeForSession(sessionId, data);
    this.restoreTerminalAuthorityLegacyAdmissionAfterHeadlessRecreation(sessionId, data);
    if (data.terminalAuthorityController?.getState().mode === 'legacy') {
      const selectedClient = preferredBrowserDriver
        && retained.clients.get(preferredBrowserDriver.clientId)?.viewGeneration
          === preferredBrowserDriver.viewGeneration
        ? preferredBrowserDriver
        : [...retained.clients.entries()].map(([clientId, registration]) => ({
            clientId,
            viewGeneration: registration.viewGeneration,
          }))[0];
      if (selectedClient) {
        const lease = this.establishRetainedTerminalMutationLease(
          sessionId,
          selectedClient.clientId,
          selectedClient.viewGeneration,
        );
        if (!lease.ok) {
          throw new Error(`terminal-authority-debug-legacy-driver-lease-restore-failed:${lease.reason}`);
        }
      }
    }
    });
    data.headlessWriteChain = recreation;
    await recreation;
  }

  private restoreTerminalAuthorityLegacyAdmissionAfterHeadlessRecreation(
    sessionId: string,
    data: SessionData,
  ): void {
    const controllerState = data.terminalAuthorityController?.getState();
    if (!controllerState || controllerState.mode !== 'legacy') return;
    const retained = this.ensureRetainedTerminalSessionState(data);
    const runtime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (runtime.recoveryRequiredReason
      !== 'authority-runtime-detached-before-ordered-compatibility-recovery') {
      return;
    }
    if (runtime.admission.mode !== 'none'
      || runtime.driver.active !== null
      || runtime.responder.active !== null
      || !controllerState.activeResponderLeaseId
      || !controllerState.activeDriverLeaseId) {
      throw new Error('terminal-authority-debug-legacy-runtime-restore-precondition-failed');
    }
    if (runtime.responder.revokedLeaseIds.has(controllerState.activeResponderLeaseId)
      || runtime.driver.revokedLeaseIds.has(controllerState.activeDriverLeaseId)) {
      throw new Error('terminal-authority-debug-legacy-runtime-identity-reused');
    }
    runtime.admission = { mode: 'legacy', transitionEpoch: null };
    runtime.responder.active = 'legacy-browser';
    runtime.responder.activeLeaseId = controllerState.activeResponderLeaseId;
    runtime.responder.legacyEnabled = true;
    runtime.responder.serverEnabled = false;
    runtime.driver.active = null;
    runtime.driver.activeLeaseId = null;
    runtime.suspendedBrowserDriver = null;
    runtime.recoveryRequiredReason = null;
    retained.blockers.delete('authority-runtime-detached-before-ordered-compatibility-recovery');
  }

  private async injectTerminalAuthorityDebugOutput(sessionId: string, output: string): Promise<boolean> {
    const data = this.sessions.get(sessionId);
    if (!data?.headless) return false;
    const enqueued = data.headlessOutputQueue.enqueue(output);
    if (!enqueued.ok) return false;
    this.queueAcceptedHeadlessOutput(sessionId, data, output);
    return this.waitForTerminalResourcePolicyHeadlessDrain(sessionId);
  }

  private async injectTerminalAuthorityDebugConfiguredCorpus(
    sessionId: string,
    probe: Record<string, unknown>,
  ): Promise<{ ok: true; windowLines: number } | { ok: false; reason: string }> {
    const physicalLineCount = Number(probe.physicalLineCount);
    const configuredScrollbackLines = Number(probe.configuredScrollbackLines);
    if (!Number.isSafeInteger(physicalLineCount) || physicalLineCount <= 0
      || !Number.isSafeInteger(configuredScrollbackLines) || configuredScrollbackLines < 0) {
      return { ok: false, reason: 'debug-configured-corpus-shape-invalid' };
    }
    const isolation = this.terminalAuthorityDebugIsolations.get(sessionId);
    const data = this.sessions.get(sessionId);
    if (!isolation || !data) return { ok: false, reason: 'debug-isolation-unavailable' };
    if (isolation.retainedScrollbackOverride !== configuredScrollbackLines) {
      isolation.retainedScrollbackOverride = configuredScrollbackLines;
      await this.recreateTerminalAuthorityDebugHeadless(sessionId, data, configuredScrollbackLines);
    }
    // Keep the generator bounded while avoiding a full retained checkpoint
    // drain every 256 rows. At the production 10k range, 4,096 compact rows
    // remain only tens of KiB yet reduce cumulative serialization from forty
    // passes to three.
    const windowLines = 4_096;
    if (!await this.injectTerminalAuthorityDebugOutput(sessionId, '\u001bc\u001b[?7h\u001b[?2004h')) {
      return { ok: false, reason: 'debug-configured-corpus-reset-failed' };
    }
    for (let start = 0; start < physicalLineCount; start += windowLines) {
      const end = Math.min(physicalLineCount, start + windowLines);
      let chunk = '';
      for (let index = start; index < end; index += 1) {
        chunk += `P${String(index).padStart(6, '0')}`;
        if (index + 1 < physicalLineCount) chunk += '\r\n';
      }
      if (!await this.injectTerminalAuthorityDebugOutput(sessionId, chunk)) {
        return { ok: false, reason: 'debug-configured-corpus-injection-failed' };
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!await this.injectTerminalAuthorityDebugOutput(sessionId, '\u001b7')) {
      return { ok: false, reason: 'debug-configured-corpus-save-cursor-failed' };
    }
    return { ok: true, windowLines };
  }

  getReplaySnapshot(sessionId: string): { data: string; truncated: boolean } | null {
    const snapshot = this.getScreenSnapshot(sessionId);
    if (!snapshot) return null;
    if (snapshot.health === 'degraded') {
      if (snapshot.data.length > 0) {
        return {
          data: snapshot.data,
          truncated: snapshot.truncated,
        };
      }
      return {
        data: LEGACY_DEGRADED_REPLAY_PLACEHOLDER,
        truncated: snapshot.truncated,
      };
    }
    if (snapshot.truncated && snapshot.data.length === 0) {
      return {
        data: LEGACY_TRUNCATED_REPLAY_PLACEHOLDER,
        truncated: true,
      };
    }
    return {
      data: snapshot.data,
      truncated: snapshot.truncated,
    };
  }

  isSessionReady(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Produces one restore authority sample. The pre/post fence prevents a
   * serialized screen from being paired with parser metadata from a different
   * output generation.
   *
   * @req REL-BGSTAB-009
   */
  getAtomicRestoreSnapshot(sessionId: string): AtomicRestoreSnapshotResult {
    const data = this.sessions.get(sessionId);
    if (!data || data.headlessHealth !== 'healthy' || !data.headless) {
      return { ok: false, reason: 'headless-degraded' };
    }
    if (data.headlessApplyInFlight > 0) {
      return { ok: false, reason: 'generation-failed' };
    }
    if (data.parserTailOverflow) {
      return { ok: false, reason: 'generation-failed' };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headless: HeadlessTerminalState = data.headless;
      const authorityRevision = data.authorityRevision;
      const snapshotSeq = data.screenSeq;
      const parserComplete = data.parserComplete;
      const pendingEscapeTailAnsi = data.pendingEscapeTailAnsi;
      try {
        const serialized = serializeHeadlessTerminal(headless, this.runtimePtyConfig.maxSnapshotBytes);
        if (
          this.sessions.get(sessionId) !== data
          || data.headless !== headless
          || data.headlessHealth !== 'healthy'
          || data.headlessApplyInFlight > 0
          || data.parserTailOverflow
          || data.authorityRevision !== authorityRevision
          || data.screenSeq !== snapshotSeq
          || data.parserComplete !== parserComplete
          || data.pendingEscapeTailAnsi !== pendingEscapeTailAnsi
        ) {
          continue;
        }
        return {
          ok: true,
          payload: {
            authorityEpoch: data.authorityEpoch,
            authorityRevision,
            snapshotSeq,
            parserComplete,
            pendingEscapeTailAnsi,
            serializedData: serialized.data,
            cols: data.cols,
            rows: data.rows,
            truncated: serialized.truncated,
            generatedAt: Date.now(),
            health: 'healthy',
            windowsPty: data.windowsPty,
          },
        };
      } catch {
        return { ok: false, reason: 'generation-failed' };
      }
    }
    return { ok: false, reason: 'generation-failed' };
  }

  getScreenSnapshot(sessionId: string): SessionScreenSnapshot | null {
    const data = this.sessions.get(sessionId);
    if (!data) return null;
    this.observability.snapshotRequests += 1;
    this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_requested', {
      screenSeq: data.screenSeq,
      cacheDirty: data.snapshotCache?.dirty ?? null,
      headlessHealth: data.headlessHealth,
      pendingHeadlessWrites: data.pendingHeadlessWrites,
    });

    if (data.headlessHealth !== 'healthy' || !data.headless) {
      this.observability.snapshotFallbacks += 1;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_fallback_degraded', {
        screenSeq: data.screenSeq,
        degradedReplayBufferBytes: Buffer.byteLength(data.degradedReplayBuffer, 'utf8'),
        degradedReplayTruncated: data.degradedReplayTruncated,
        fallbackDataState: this.getFallbackDataState(data),
      });
      return this.createDegradedSnapshot(data);
    }

    const cached = data.snapshotCache;
    if (
      cached
      && cached.scope === SNAPSHOT_PAYLOAD_SCOPE
      && !cached.dirty
      && cached.seq === data.screenSeq
      && cached.cols === data.cols
      && cached.rows === data.rows
    ) {
      this.observability.snapshotCacheHits += 1;
      const cachedByteLength = Buffer.byteLength(cached.data, 'utf8');
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_cache_hit', {
        seq: cached.seq,
        cols: cached.cols,
        rows: cached.rows,
        truncated: cached.truncated,
        byteLength: cachedByteLength,
        snapshotScope: cached.scope,
      }, cached.data);
      return {
        ...cached,
        health: 'healthy',
        windowsPty: data.windowsPty,
        authorityEpoch: data.authorityEpoch,
        authorityRevision: data.authorityRevision,
        parserComplete: data.parserComplete,
        pendingEscapeTailAnsi: data.pendingEscapeTailAnsi,
      };
    }

    try {
      const startedAt = Date.now();
      const snapshot = serializeHeadlessTerminal(data.headless, this.runtimePtyConfig.maxSnapshotBytes);
      const durationMs = Date.now() - startedAt;
      const generatedAt = Date.now();
      data.snapshotCache = {
        seq: data.screenSeq,
        cols: data.cols,
        rows: data.rows,
        data: snapshot.data,
        truncated: snapshot.truncated,
        generatedAt,
        dirty: false,
        scope: SNAPSHOT_PAYLOAD_SCOPE,
      };
      const snapshotByteLength = Buffer.byteLength(snapshot.data, 'utf8');
      this.observability.totalSnapshotSerializeMs += durationMs;
      this.observability.maxSnapshotSerializeMs = Math.max(this.observability.maxSnapshotSerializeMs, durationMs);
      this.observability.totalSnapshotBytes += snapshotByteLength;
      this.observability.maxSnapshotBytesObserved = Math.max(this.observability.maxSnapshotBytesObserved, snapshotByteLength);
      if (snapshot.truncated) {
        this.observability.oversizedSnapshots += 1;
      }
      data.unsnapshottedOutput = '';
      data.unsnapshottedOutputTruncated = false;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_serialized', {
        seq: data.snapshotCache.seq,
        cols: data.snapshotCache.cols,
        rows: data.snapshotCache.rows,
        truncated: data.snapshotCache.truncated,
        byteLength: snapshotByteLength,
        snapshotScope: data.snapshotCache.scope,
        durationMs,
      }, data.snapshotCache.data);
      return {
        ...data.snapshotCache,
        health: 'healthy',
        windowsPty: data.windowsPty,
        authorityEpoch: data.authorityEpoch,
        authorityRevision: data.authorityRevision,
        parserComplete: data.parserComplete,
        pendingEscapeTailAnsi: data.pendingEscapeTailAnsi,
      };
    } catch (error) {
      this.observability.snapshotSerializeFailures += 1;
      this.markHeadlessDegraded(sessionId, data, 'serialize', error);
      this.observability.snapshotFallbacks += 1;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_serialize_failed', {
        screenSeq: data.screenSeq,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.createDegradedSnapshot(data);
    }
  }

  async getScreenRepair(
    sessionId: string,
    expected: { cols: number; rows: number; bufferType: ScreenRepairBufferType },
  ): Promise<HeadlessScreenRepairResult> {
    const data = this.sessions.get(sessionId);
    if (!data) return { ok: false, reason: 'headless-degraded' };

    this.captureDebugEvent(sessionId, 'headless', 'screen_repair_requested', {
      screenSeq: data.screenSeq,
      cols: expected.cols,
      rows: expected.rows,
      bufferType: expected.bufferType,
      headlessHealth: data.headlessHealth,
      pendingHeadlessWrites: data.pendingHeadlessWrites,
    });

    if (data.headlessHealth !== 'healthy' || !data.headless) {
      this.captureDebugEvent(sessionId, 'headless', 'screen_repair_rejected', {
        reason: 'headless-degraded',
        screenSeq: data.screenSeq,
      });
      return { ok: false, reason: 'headless-degraded' };
    }

    const headlessQuiescent = await this.waitForHeadlessWriteQuiescence(
      sessionId,
      data,
      SCREEN_REPAIR_HEADLESS_DRAIN_TIMEOUT_MS,
    );

    if (!this.isActiveSession(sessionId, data) || data.headlessHealth !== 'healthy' || !data.headless) {
      return { ok: false, reason: 'headless-degraded' };
    }
    // Waiting for the chain to drain is best effort: a session that keeps
    // producing output never drains, and refusing it here forces the browser
    // into the reconnect loop this path was built to avoid. Only a write that
    // is mid-apply can make the buffer disagree with `screenSeq`.
    if (data.headlessApplyInFlight > 0) {
      this.captureDebugEvent(sessionId, 'headless', 'screen_repair_rejected', {
        reason: 'headless-busy',
        headlessQuiescent,
        pendingHeadlessWrites: data.pendingHeadlessWrites,
      });
      return { ok: false, reason: 'headless-busy' };
    }

    // A retained resize is serialized behind the current headless write tail.
    // Compare geometry only after that tail settles, otherwise a normal
    // restore-time fit can be mistaken for a terminal repair failure and force
    // the browser into a reconnect loop.
    if (data.cols !== expected.cols || data.rows !== expected.rows) {
      this.captureDebugEvent(sessionId, 'headless', 'screen_repair_rejected', {
        reason: 'geometry-mismatch',
        currentCols: data.cols,
        currentRows: data.rows,
        expectedCols: expected.cols,
        expectedRows: expected.rows,
      });
      return { ok: false, reason: 'geometry-mismatch' };
    }

    const result = serializeHeadlessScreenRepair(data.headless, {
      ...expected,
      seq: data.screenSeq,
    }, this.runtimePtyConfig.maxSnapshotBytes);
    if (!result.ok) {
      this.captureDebugEvent(sessionId, 'headless', 'screen_repair_rejected', {
        reason: result.reason,
        screenSeq: data.screenSeq,
      });
      return result;
    }

    this.captureDebugEvent(sessionId, 'headless', 'screen_repair_serialized', {
      screenSeq: data.screenSeq,
      cols: result.payload.cols,
      rows: result.payload.rows,
      bufferType: result.payload.bufferType,
      rowCount: result.payload.viewportRows.length,
      byteLength: Buffer.byteLength(result.payload.ansiPatch, 'utf8'),
    }, result.payload.ansiPatch);
    return result;
  }

  /**
   * Follows the moving tail of the per-session headless write chain. A single
   * captured promise is insufficient because PTY chunks can append a new tail
   * while a repair request is waiting for the previously observed tail.
   *
   * @req REL-BGSTAB-009
   */
  private async waitForHeadlessWriteQuiescence(
    sessionId: string,
    data: SessionData,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let quietTail: Promise<void> | null = null;
    let quietAuthorityRevision = -1;
    let quietStartedAt = 0;

    while (this.isActiveSession(sessionId, data) && data.headlessHealth === 'healthy' && data.headless) {
      const now = Date.now();
      const remainingMs = deadline - now;
      if (remainingMs <= 0) {
        return false;
      }

      let nextPollMs = SCREEN_REPAIR_HEADLESS_POLL_INTERVAL_MS;
      if (data.pendingHeadlessWrites === 0) {
        const currentTail = data.headlessWriteChain;
        const currentAuthorityRevision = data.authorityRevision;
        if (quietTail !== currentTail || quietAuthorityRevision !== currentAuthorityRevision) {
          quietTail = currentTail;
          quietAuthorityRevision = currentAuthorityRevision;
          quietStartedAt = now;
        }
        const quietElapsedMs = now - quietStartedAt;
        if (quietElapsedMs >= SCREEN_REPAIR_HEADLESS_QUIET_WINDOW_MS) {
          return true;
        }
        nextPollMs = Math.min(
          nextPollMs,
          SCREEN_REPAIR_HEADLESS_QUIET_WINDOW_MS - quietElapsedMs,
        );
      } else {
        quietTail = null;
        quietAuthorityRevision = -1;
        quietStartedAt = 0;
      }

      await delayMs(Math.max(1, Math.min(nextPollMs, remainingMs)));
    }

    return false;
  }

  private createSessionProcessMetadata(
    ptyProcess: pty.IPty,
    shellCommand: string,
    shellArgs: string[],
    shellType: string,
    cwd: string,
    windowsBackend: WindowsPtyBackend,
  ): SessionProcessMetadata {
    const rootPid = normalizeRootPid(ptyProcess.pid);
    const launchedAt = new Date().toISOString();
    return {
      rootPid,
      shellCommand,
      shellArgs: [...shellArgs],
      shellType,
      cwd,
      platform: this.platform,
      backend: this.resolveSessionProcessBackend(shellCommand, shellType, windowsBackend),
      launchedAt,
      osStartIdentity: null,
    };
  }

  private scheduleProcessStartIdentityCapture(sessionId: string, data: SessionData): void {
    this.attemptProcessStartIdentityCapture(sessionId, data, 0);
  }

  private attemptProcessStartIdentityCapture(sessionId: string, data: SessionData, attemptIndex: number): void {
    // Stop before probing once the session has been deleted or finalized (immediate-delete race).
    const current = this.sessions.get(sessionId);
    if (current !== data || current.finalized) {
      return;
    }
    const rootPid = data.processMetadata.rootPid;
    const timeoutMs = this.runtimeSessionConfig.processCleanup.identityProbeTimeoutMs;
    void this.readProcessStartIdentityFn(rootPid, this.platform, this.execFileFn, timeoutMs)
      .then((identity) => {
        this.handleProcessStartIdentityResult(sessionId, data, attemptIndex, identity);
      })
      .catch(() => {
        this.handleProcessStartIdentityResult(sessionId, data, attemptIndex, null);
      });
  }

  private handleProcessStartIdentityResult(
    sessionId: string,
    data: SessionData,
    attemptIndex: number,
    identity: string | null,
  ): void {
    const current = this.sessions.get(sessionId);
    if (current !== data || current.finalized) {
      return;
    }
    if (identity) {
      current.processMetadata.osStartIdentity = identity;
      this.cleanupTelemetry.identityCaptureSucceeded += 1;
      return;
    }
    // A failed probe says nothing about the process. On Windows it spawns
    // PowerShell for a CIM query, which a loaded machine pushes past its timeout;
    // the identity it would have read is a fixed fact that outlives every probe.
    // So a failure is a reason to try again rather than to stop: an unidentified
    // root makes the terminator refuse to kill the tree, and the session record
    // then disappears while its processes keep running.
    this.cleanupTelemetry.identityCaptureFailed += 1;
    this.cleanupTelemetry.identityCaptureRetried += 1;
    const backoffMs = IDENTITY_CAPTURE_RETRY_BACKOFFS_MS[attemptIndex]
      ?? IDENTITY_CAPTURE_RETRY_INTERVAL_MS;
    const timer = setTimeout(() => {
      const retryTarget = this.sessions.get(sessionId);
      if (retryTarget === data && !retryTarget.finalized) {
        retryTarget.identityCaptureTimer = null;
      }
      this.attemptProcessStartIdentityCapture(sessionId, data, attemptIndex + 1);
    }, backoffMs);
    timer.unref?.();
    current.identityCaptureTimer = timer;
  }

  private resolveSessionProcessBackend(
    shellCommand: string,
    shellType: string,
    windowsBackend: WindowsPtyBackend,
  ): SessionProcessBackend {
    const normalizedShellCommand = shellCommand.toLowerCase().replace(/\\/g, '/');
    if (
      shellType === 'wsl'
      || normalizedShellCommand === 'wsl'
      || normalizedShellCommand === 'wsl.exe'
      || normalizedShellCommand.endsWith('/wsl')
      || normalizedShellCommand.endsWith('/wsl.exe')
    ) {
      return 'wsl';
    }
    if (this.platform === 'win32') {
      return windowsBackend;
    }
    return 'unix';
  }

  private settleRetainedTerminalTermination(
    sessionId: string,
    data: SessionData,
    reason: SessionCleanupReason,
    exitCode: number | null,
  ): void {
    const retained = data.retainedTerminal;
    if (retained.comparisonTimer) clearTimeout(retained.comparisonTimer);
    retained.comparisonTimer = null;
    retained.comparisonPendingSourceSeq = null;
    if (!retained.cleanup.settled) {
      retained.cleanup = {
        admissionOpen: false,
        settled: true,
        rejectedLateMessages: retained.cleanup.rejectedLateMessages,
        factLedgerSettlements: 1,
        checkpointLedgerSettlements: 1,
        timerSettlements: 1,
      };
    }
    retained.clients.clear();
    retained.driverLease = { ownerClientId: null, generation: retained.driverLease.generation, state: 'revoked' };
    retained.driverViewGeneration = null;
    const authorityRuntime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (authorityRuntime.driver.activeLeaseId) {
      authorityRuntime.driver.revokedLeaseIds.add(authorityRuntime.driver.activeLeaseId);
    }
    if (authorityRuntime.responder.activeLeaseId) {
      authorityRuntime.responder.revokedLeaseIds.add(authorityRuntime.responder.activeLeaseId);
    }
    authorityRuntime.admission.mode = 'none';
    authorityRuntime.driver.active = null;
    authorityRuntime.driver.activeLeaseId = null;
    authorityRuntime.responder.active = null;
    authorityRuntime.responder.activeLeaseId = null;
    authorityRuntime.responder.legacyEnabled = false;
    authorityRuntime.responder.serverEnabled = false;
    authorityRuntime.suspendedBrowserDriver = null;
    authorityRuntime.noLocalCacheEvidence = null;
    authorityRuntime.limitedSessionSelected = false;
    this.retainedTerminalTerminationTombstones.set(sessionId, {
      availability: 'session-terminated',
      reason,
      exitCode,
      cleanup: retained.cleanup,
      driverLease: { state: 'revoked', ownerClientId: null },
    });
    this.retainedTerminalGenerationRejections.set(
      this.getRetainedTerminalGenerationRejectionKey(sessionId, data.authorityEpoch),
      {
        sessionId,
        authorityEpoch: data.authorityEpoch,
        streamEpoch: retained.streamEpoch,
        terminationReason: reason,
        rejectedLateMessages: retained.cleanup.rejectedLateMessages,
        lastRejectionReason: null,
      },
    );
    while (this.retainedTerminalTerminationTombstones.size > 4_096) {
      const oldest = this.retainedTerminalTerminationTombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      this.retainedTerminalTerminationTombstones.delete(oldest);
    }
    while (this.retainedTerminalGenerationRejections.size > 4_096) {
      const oldest = this.retainedTerminalGenerationRejections.keys().next().value as string | undefined;
      if (!oldest) break;
      this.retainedTerminalGenerationRejections.delete(oldest);
    }
  }

  private getRetainedTerminalGenerationRejectionKey(sessionId: string, authorityEpoch: string): string {
    return `${sessionId}\0${authorityEpoch}`;
  }

  private recordRetainedTerminalLateMessage(
    sessionId: string,
    authorityEpoch?: string,
    reason: RetainedTerminalGenerationRejectionState['lastRejectionReason'] = null,
  ): void {
    const tombstone = this.retainedTerminalTerminationTombstones.get(sessionId);
    if (tombstone) tombstone.cleanup.rejectedLateMessages += 1;
    if (!authorityEpoch) return;
    const generation = this.retainedTerminalGenerationRejections.get(
      this.getRetainedTerminalGenerationRejectionKey(sessionId, authorityEpoch),
    );
    if (!generation) return;
    generation.rejectedLateMessages += 1;
    generation.lastRejectionReason = reason;
  }

  private finalizeSession(sessionId: string, data: SessionData, options: SessionFinalizerOptions): boolean {
    if (data.finalized || this.sessions.get(sessionId) !== data) {
      return false;
    }
    data.finalized = true;
    this.settleRetainedTerminalTermination(sessionId, data, options.reason, options.exitCode ?? null);

    if (data.idleTimer) {
      clearTimeout(data.idleTimer);
      data.idleTimer = null;
    }
    if (data.identityCaptureTimer) {
      clearTimeout(data.identityCaptureTimer);
      data.identityCaptureTimer = null;
    }
    if (data.startupReadyTimer) {
      clearTimeout(data.startupReadyTimer);
      data.startupReadyTimer = null;
    }
    data.pendingRestoreInputs = [];
    this.cancelPendingRunningTransition(data);
    this.clearDeferredBareUnsubmittedPrintableEcho(data);

    const cleanupResult = this.recordCleanupObservation(
      sessionId,
      data,
      options.reason,
      options.cleanupMode,
      options.cleanupOverride,
    );

    if (options.emitExited) {
      this.broadcastWs(sessionId, 'session:exited', { exitCode: options.exitCode ?? null });
    }

    if (options.killPty) {
      data.pty.kill();
    }

    data.oscDetector.destroy();
    data.terminalTitleDetector.destroy();
    data.terminalTitleSignalDetector.destroy();
    data.foregroundDetectorRegistry?.reset();

    const runtimeDisposalErrors = this.disposeTerminalAuthorityRuntimeForSession(sessionId, data);
    if (runtimeDisposalErrors.length > 0) {
      console.warn(
        '[SessionManager] Terminal authority runtime finalization failed:',
        new AggregateError(runtimeDisposalErrors, 'terminal-authority-runtime-finalization-cleanup-failed'),
      );
    }
    data.pendingTerminalAuthorityQueryEffects = [];
    if (data.headless) {
      disposeHeadlessTerminal(data.headless);
      data.headless = null;
    }
    data.headlessCloseSignal.resolve();
    data.snapshotCache = null;
    this.ensureHeadlessPolicyTracking(data);
    data.headlessOutputQueue.clear();
    data.pendingHeadlessOutputs.clear();
    data.pendingHeadlessOutputBytes = 0;
    data.pendingHeadlessOutputBytesByPolicyGeneration.clear();
    data.pendingHeadlessOutputChunksByPolicyGeneration.clear();
    data.pendingHeadlessLegacyOutputBytesByPolicyGeneration.clear();
    data.pendingHeadlessLegacyOutputChunksByPolicyGeneration.clear();
    data.pendingHeadlessWritesByPolicyGeneration.clear();
    data.headlessPolicyWriteFailureSettlers.clear();
    data.unsnapshottedOutput = '';
    data.unsnapshottedOutputTruncated = false;

    if (data.cwdFilePath) {
      unwatchFile(data.cwdFilePath);
      try { unlinkSync(data.cwdFilePath); } catch { /* ignore */ }
    }

    this.wsRouter?.clearSessionState(sessionId);
    this.wsRouter?.disableDebugReplayCapture(sessionId);
    this.wsRouter?.clearReplayEvents(sessionId);
    this.disableDebugCapture(sessionId);
    this.clearDebugCapture(sessionId);
    this.pendingResizeReplaySessions.delete(sessionId);
    this.pendingResizeReplayStartedAt.delete(sessionId);
    this.pendingResizeReplayLastOutputAt.delete(sessionId);
    const pendingResizeRefresh = this.pendingResizeRefreshTimers.get(sessionId);
    if (pendingResizeRefresh) {
      clearTimeout(pendingResizeRefresh);
      this.pendingResizeRefreshTimers.delete(sessionId);
    }

    this.terminalResourcePolicyAuthority?.revokeTarget({ kind: 'headless', sessionId });
    for (const listener of this.terminalResourcePolicyHeadlessFinalizedListeners) {
      try {
        listener(sessionId);
      } catch (error) {
        console.warn('[SessionManager] Headless policy target cleanup listener failed:', error);
      }
    }
    this.sessions.delete(sessionId);
    // The session is gone, so its epoch is too. Ids are uuidv4 and never
    // reused, so nothing can inherit the entry — it would only accumulate.
    this.forgetTerminalStreamEpoch(sessionId);

    const finalizedAt = cleanupResult?.recordedAt ?? new Date().toISOString();
    this.notifySessionFinalized({
      sessionId,
      reason: options.reason,
      exitCode: options.exitCode ?? null,
      cleanupStatus: cleanupResult?.cleanupStatus ?? 'not-started',
      recordedAt: finalizedAt,
    });
    return true;
  }

  private notifySessionFinalized(event: SessionFinalizedEvent): void {
    if (this.sessionFinalizedCallback) {
      try {
        this.sessionFinalizedCallback(event);
      } catch (error) {
        console.warn('[SessionManager] session finalized callback failed:', error);
      }
    }
    for (const listener of this.sessionFinalizedListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[SessionManager] session finalized listener failed:', error);
      }
    }
  }

  private notifyCommandSubmitted(event: SessionCommandSubmittedEvent): void {
    if (!this.commandSubmittedCallback) {
      return;
    }
    try {
      Promise.resolve(this.commandSubmittedCallback(event)).catch((error) => {
        console.warn('[SessionManager] command submitted callback failed:', error);
      });
    } catch (error) {
      console.warn('[SessionManager] command submitted callback failed:', error);
    }
  }

  private recordCleanupObservation(
    sessionId: string,
    data: SessionData,
    reason: SessionCleanupReason,
    cleanupMode?: SessionProcessCleanupConfig['mode'],
    override?: {
      status: SessionCleanupStatus;
      remainingDescendants: number;
      verifiedRemainingDescendants?: number;
      unverifiedRemainingDescendants?: number;
    },
  ): SessionCleanupTelemetryResult | null {
    if (data.cleanupRecorded || this.cleanupRecordedSessionIds.has(sessionId)) {
      return null;
    }
    data.cleanupRecorded = true;
    this.rememberCleanupRecordedSession(sessionId);

    const cleanupConfig = this.runtimeSessionConfig.processCleanup;
    const effectiveMode = cleanupMode ?? cleanupConfig.mode;
    this.cleanupTelemetry.mode = effectiveMode;

    if (effectiveMode === 'legacy') {
      const result: SessionCleanupTelemetryResult = {
        sessionId,
        reason,
        rootPid: data.processMetadata.rootPid,
        remainingDescendants: 0,
        verifiedRemainingDescendants: 0,
        unverifiedRemainingDescendants: 0,
        cleanupStatus: 'not-started',
        recordedAt: new Date().toISOString(),
      };
      this.pushCleanupResult(result);
      return result;
    }

    this.cleanupTelemetry.attempted += 1;

    let status: SessionCleanupStatus = 'degraded';
    let remainingDescendants = 0;
    let verifiedRemainingDescendants = 0;
    let unverifiedRemainingDescendants = 0;
    try {
      const inspection = override ?? this.processInspector(data.processMetadata, cleanupConfig.descendantSampleLimit);
      status = normalizeCleanupStatus(inspection.status);
      const breakdown = resolveRemainingDescendantBreakdown(status, inspection);
      remainingDescendants = breakdown.remainingDescendants;
      verifiedRemainingDescendants = breakdown.verifiedRemainingDescendants;
      unverifiedRemainingDescendants = breakdown.unverifiedRemainingDescendants;
    } catch {
      status = 'degraded';
      remainingDescendants = 0;
      verifiedRemainingDescendants = 0;
      unverifiedRemainingDescendants = 0;
    }

    if (status === 'observed' || status === 'completed') {
      this.cleanupTelemetry.completed += 1;
    } else if (status === 'skipped-unverified') {
      this.cleanupTelemetry.unverifiedSkipped += 1;
    } else {
      this.cleanupTelemetry.degraded += 1;
    }

    const result: SessionCleanupTelemetryResult = {
      sessionId,
      reason,
      rootPid: data.processMetadata.rootPid,
      remainingDescendants,
      verifiedRemainingDescendants,
      unverifiedRemainingDescendants,
      cleanupStatus: status,
      recordedAt: new Date().toISOString(),
    };
    this.pushCleanupResult(result);
    return result;
  }

  private toCleanupOverride(result: ProcessTreeTerminationResult): {
    status: SessionCleanupStatus;
    remainingDescendants: number;
    verifiedRemainingDescendants: number;
    unverifiedRemainingDescendants: number;
  } {
    return {
      status: result.status,
      remainingDescendants: result.remainingPids.length + result.unverifiedPids.length,
      verifiedRemainingDescendants: result.remainingPids.length,
      unverifiedRemainingDescendants: result.unverifiedPids.length,
    };
  }

  private rememberCleanupRecordedSession(sessionId: string): void {
    this.cleanupRecordedSessionIds.add(sessionId);
    while (this.cleanupRecordedSessionIds.size > CLEANUP_DEDUP_SESSION_LIMIT) {
      const oldestSessionId = this.cleanupRecordedSessionIds.values().next().value;
      if (typeof oldestSessionId !== 'string') {
        return;
      }
      this.cleanupRecordedSessionIds.delete(oldestSessionId);
    }
  }

  private pushCleanupResult(result: SessionCleanupTelemetryResult): void {
    this.cleanupTelemetry.recentResults.push(result);
    while (this.cleanupTelemetry.recentResults.length > CLEANUP_RECENT_RESULTS_LIMIT) {
      this.cleanupTelemetry.recentResults.shift();
    }
  }

  private getCleanupTelemetrySnapshot(): SessionCleanupTelemetry {
    return {
      ...this.cleanupTelemetry,
      recentResults: this.cleanupTelemetry.recentResults.map(result => ({ ...result })),
    };
  }

  getReplayQueueLimit(): number {
    return Math.min(this.runtimePtyConfig.maxSnapshotBytes, 262_144);
  }

  // @req REL-BGSTAB-008
  getScreenRepairQueuePolicy(): {
    maxBytes: number;
    maxChunks: number;
    source: 'compatibility-cap';
  } {
    return {
      maxBytes: this.getReplayQueueLimit(),
      maxChunks: this.runtimeHeadlessQueueConfig.limits.pendingOutputMaxChunks,
      source: 'compatibility-cap',
    };
  }

  getObservabilitySnapshot(): SessionManagerObservability {
    let healthySessions = 0;
    let degradedSessions = 0;

    for (const data of this.sessions.values()) {
      if (data.headlessHealth === 'healthy') {
        healthySessions += 1;
      } else {
        degradedSessions += 1;
      }
    }

    return {
      totalSessions: this.sessions.size,
      healthySessions,
      degradedSessions,
      headlessOutput: this.getHeadlessOutputObservability(),
      eventLoopDelay: this.sampleEventLoopDelay(),
      processCpuPercentOfOneCore: this.sampleProcessCpuPercentOfOneCore(),
      ...this.observability,
      cleanup: this.getCleanupTelemetrySnapshot(),
    };
  }

  /** @req OBS-BGSTAB-003 */
  private sampleEventLoopDelay(): EventLoopDelayObservability {
    // monitorEventLoopDelay reports nanoseconds; convert to ms. On an empty
    // histogram `mean` is NaN (coerced to 0 here) and `percentile(99)` floors to a
    // small non-zero resolution artifact, so both stay finite and >= 0.
    const meanNs = eventLoopDelayHistogram.mean;
    const p99Ns = eventLoopDelayHistogram.percentile(99);
    return {
      mean: Number.isFinite(meanNs) ? meanNs / 1e6 : 0,
      p99: Number.isFinite(p99Ns) ? p99Ns / 1e6 : 0,
    };
  }

  /** @req OBS-BGSTAB-003 */
  private sampleProcessCpuPercentOfOneCore(): number {
    const now = process.hrtime.bigint();
    const elapsedMicros = Number(now - this.lastCpuSampleAt) / 1000;
    // Only advance the CPU baseline once per CPU_SAMPLE_MIN_INTERVAL_MS so that
    // multiple readers of the same snapshot (telemetry endpoint + periodic logger)
    // observe one stable windowed value rather than corrupting each other's delta.
    if (elapsedMicros < CPU_SAMPLE_MIN_INTERVAL_MS * 1000) {
      return this.lastCpuPercentOfOneCore;
    }
    const currentCpu = process.cpuUsage();
    const cpuMicros = (currentCpu.user - this.lastCpuUsageSample.user)
      + (currentCpu.system - this.lastCpuUsageSample.system);
    this.lastCpuUsageSample = currentCpu;
    this.lastCpuSampleAt = now;
    this.lastCpuPercentOfOneCore = (cpuMicros / elapsedMicros) * 100;
    return this.lastCpuPercentOfOneCore;
  }

  /** Broadcast to all WS subscribers of a session */
  broadcastWs(sessionId: string, event: string, payload: object): void {
    this.wsRouter?.sendSessionEvent(sessionId, event, payload);
  }

  private toDTO(session: Session): SessionDTO {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      sortOrder: session.sortOrder,
    };
  }

  /**
   * PTY 출력이 사용자 입력의 에코인지 판정.
   *
   * 에코 조건 (모두 충족 시):
   * 1. 마지막 입력으로부터 50ms 이내
   * 2. 출력 길이가 입력 길이의 2배 이하 (ANSI 색상 코드 여유)
   * 3. 마지막 입력에 Enter가 없었음
   *
   * Enter 입력 후의 출력은 명령 실행 결과이므로 에코가 아님.
   */
  private isEchoOutput(sData: SessionData, output: string): boolean {
    const tracker = sData.echoTracker;
    if (tracker.lastInputAt === 0) return false; // 아직 입력 없음

    const elapsed = Date.now() - tracker.lastInputAt;
    // PowerShell(PSReadLine)은 키 입력 1글자마다 전체 라인을 ANSI 시퀀스로
    // 재렌더링하므로 출력 길이가 입력 길이의 수십 배에 달한다.
    // 따라서 길이 비교는 제거하고 타이밍 + Enter 여부만으로 판정한다.
    return (
      elapsed < INPUT_ECHO_TIME_THRESHOLD_MS &&
      !tracker.lastInputHasEnter
    );
  }

  private isPowerShellPromptRedrawOutput(sData: SessionData, output: string, precomputedNormalized?: string): boolean {
    if (sData.shellType !== 'powershell') {
      return false;
    }

    const cwd = sData.lastCwd ?? sData.initialCwd;
    if (!cwd) {
      return false;
    }

    const prompt = `PS ${cwd}>`;
    const printableLines = (precomputedNormalized ?? stripAndNormalizeTerminalOutput(output))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const pendingInput = sData.inputBuffer;
    const expectedPromptLine = pendingInput.length > 0
      ? `${prompt}${pendingInput}`
      : prompt;
    const isBarePromptDuringPendingInput = printableLines.length > 0
      && pendingInput.length > 0
      && printableLines.every((line) => line === prompt);

    return isBarePromptDuringPendingInput || (
      printableLines.length > 0 && printableLines.every((line) => (
        line === expectedPromptLine
        || (
          pendingInput.length > 0
          && line.startsWith('PS ')
          && line.endsWith(`>${pendingInput}`)
        )
      ))
    );
  }

  private isShellPromptReturnOutput(sData: SessionData, output: string, precomputedNormalized?: string): boolean {
    const printableLines = (precomputedNormalized ?? stripAndNormalizeTerminalOutput(output))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const prompt = printableLines.at(-1);
    if (!prompt || prompt.length > 160 || this.isAiTuiPromptLikeShellOutput(prompt)) {
      return false;
    }

    if (sData.shellType === 'cmd') {
      return /^[A-Za-z]:[\\/][^<>|]*>$/.test(prompt);
    }

    if (sData.shellType === 'bash' || sData.shellType === 'zsh' || sData.shellType === 'sh') {
      if (/^[#$%]$/.test(prompt)) {
        return true;
      }

      if (/^[A-Za-z0-9_.-]+-\d+(?:\.\d+)*[$#%]$/.test(prompt)) {
        return true;
      }

      return /^[^\s].*[$#%]$/.test(prompt)
        && (prompt.includes('@') || prompt.includes(':') || prompt.includes('/') || prompt.includes('~'));
    }

    return false;
  }

  private isAiTuiPromptLikeShellOutput(prompt: string): boolean {
    const compact = prompt.replace(/\s+/g, ' ').trim();
    return compact === '>'
      || compact === '›'
      || compact.startsWith('>_')
      || compact.startsWith('│ >_')
      || compact.startsWith('╭')
      || compact.startsWith('╰')
      || compact.toLowerCase().includes('openai codex')
      || compact.toLowerCase().includes('claude code');
  }

  private classifyAiTuiOutputSignal(
    sData: SessionData,
    output: string,
    precomputedNormalized?: string,
  ): 'waiting_input' | 'repaint_only' | 'busy' {
    const normalized = precomputedNormalized ?? stripAndNormalizeTerminalOutput(output);
    const trimmed = normalized.trim();

    if (this.isEchoOutput(sData, output) || isLikelyCommandEchoOutput(output, sData.lastSubmittedCommand, normalized)) {
      return 'waiting_input';
    }

    if (this.isLikelyAiTuiTypingFeedback(sData, output, normalized, trimmed)) {
      return 'waiting_input';
    }

    if (this.isLikelyAiTuiSubmittedEcho(sData, trimmed)) {
      return 'waiting_input';
    }

    if (this.isAiTuiRepaintOnlyOutput(output, normalized, trimmed)) {
      return 'repaint_only';
    }

    return 'busy';
  }

  private isLikelyAiTuiTypingFeedback(
    sData: SessionData,
    raw: string,
    normalized: string,
    trimmed: string,
  ): boolean {
    if (sData.echoTracker.lastInputHasEnter || sData.echoTracker.lastInputAt === 0) {
      return false;
    }

    if (matchesPendingTerminalDraftEcho(trimmed, sData.inputBuffer)) {
      return true;
    }

    const elapsed = Date.now() - sData.echoTracker.lastInputAt;
    if (elapsed >= INPUT_ECHO_TIME_THRESHOLD_MS) {
      return false;
    }

    return countNonEmptyLines(normalized) <= 1 && trimmed.length <= 128;
  }

  private isLikelyAiTuiSubmittedEcho(sData: SessionData, trimmed: string): boolean {
    if (!sData.echoTracker.lastInputHasEnter || sData.echoTracker.lastInputAt === 0 || !sData.lastSubmittedCommand) {
      return false;
    }

    const elapsed = Date.now() - sData.echoTracker.lastInputAt;
    if (elapsed >= AI_TUI_SUBMITTED_ECHO_THRESHOLD_MS) {
      return false;
    }

    const normalizedChunk = trimmed.replace(/\s+/g, ' ').trim();
    const normalizedCommand = sData.lastSubmittedCommand.replace(/\s+/g, ' ').trim();
    return normalizedChunk === normalizedCommand || normalizedChunk.endsWith(normalizedCommand);
  }

  private isAiTuiRepaintOnlyOutput(raw: string, normalized: string, trimmed: string): boolean {
    const compact = trimmed.replace(/\s+/g, ' ').toLowerCase();

    if (!trimmed) {
      return containsAiTuiTerminalMotion(raw);
    }

    if (AI_TUI_DECORATIVE_FRAME_RE.test(trimmed)) {
      return true;
    }

    if (this.isAiTuiPromptChromeOutput(normalized, trimmed)) {
      return true;
    }

    if (this.isAiTuiStatusTelemetryOutput(raw, normalized, compact)) {
      return true;
    }

    if (!containsAiTuiTerminalMotion(raw)) {
      return false;
    }

    return (
      /^\d+$/.test(trimmed) ||
      /^\d+[smhd]$/i.test(trimmed) ||
      /^\d{1,2}:\d{2}$/.test(trimmed) ||
      (trimmed.length <= 8 && /^[0-9:]+$/.test(trimmed))
    );
  }

  private isAiTuiPromptChromeOutput(normalized: string, trimmed: string): boolean {
    const compact = trimmed.replace(/\s+/g, ' ').toLowerCase();
    const nonEmptyLines = countNonEmptyLines(normalized);
    if (nonEmptyLines === 0 || nonEmptyLines > 4 || compact.length > 320) {
      return false;
    }

    return compact === '›'
      || compact === '>'
      || compact === '>_'
      || compact === '│ >'
      || compact === '│ >_'
      || compact.startsWith('tip:')
      || compact.includes('openai codex')
      || compact.includes('claude code')
      || compact.includes('write tests for @filename');
  }

  private isAiTuiStatusTelemetryOutput(raw: string, normalized: string, compact: string): boolean {
    const nonEmptyLines = countNonEmptyLines(normalized);
    if (nonEmptyLines === 0 || nonEmptyLines > 4 || compact.length === 0 || compact.length > 640) {
      return false;
    }

    if (!hasAiTuiRepaintHint(raw)) {
      return false;
    }

    const hasModelHint = [
      'codex',
      'claude',
      'gpt-',
      'sonnet',
      'opus',
      'haiku',
      'model:',
    ].some((fragment) => compact.includes(fragment));

    const hasTelemetryHint = [
      'context [',
      'window',
      ' used',
      'weekly ',
      'daily ',
      'monthly ',
      'remaining',
      'fast off',
      'fast on',
      'esc to interrupt',
      ' token',
      ' tokens',
      ' in ',
      ' out ',
    ].some((fragment) => compact.includes(fragment));

    return hasModelHint && hasTelemetryHint;
  }

  private isControlInterruptPromptReturnOutput(
    sData: SessionData,
    output: string,
    precomputedNormalized?: string,
  ): boolean {
    if (isControlInterruptTuiPromptRepaint(output)) {
      return true;
    }

    const printableLines = (precomputedNormalized ?? stripAndNormalizeTerminalOutput(output))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (printableLines.length === 2
      && printableLines[0].endsWith('^C')
      && /\x1b\[[0-9;]*[Hf]/u.test(output)) {
      const prompt = printableLines[1];
      return this.isShellPromptReturnOutput(sData, prompt, prompt)
        || /^PS [^>\r\n]+>$/.test(prompt);
    }
    if (printableLines.length !== 1) {
      return false;
    }

    if (this.isShellPromptReturnOutput(sData, output, precomputedNormalized)) {
      return true;
    }

    const prompt = printableLines[0];
    return prompt !== undefined && /^PS [^>\r\n]+>$/.test(prompt);
  }

  /** The session's current epoch, issuing one if this is the first look. */
  private currentTerminalStreamEpoch(sessionId: string): string {
    return this.terminalStreamEpochLedger.current(sessionId);
  }

  /**
   * The single place `streamEpoch` is written. Routing every write through the
   * ledger is what keeps the two from drifting: a direct assignment to
   * `retained.streamEpoch` would leave the ledger claiming the old stream.
   */
  private setTerminalStreamEpoch(
    sessionId: string,
    retained: { streamEpoch: string },
    value: string,
    reason: StreamEpochBumpReason,
  ): void {
    retained.streamEpoch = this.terminalStreamEpochLedger.adopt(sessionId, value, reason);
  }

  /** Raises the session's epoch. Only the five events of `01:476-480` may. */
  private bumpTerminalStreamEpoch(sessionId: string, reason: StreamEpochBumpReason): string {
    return this.terminalStreamEpochLedger.bump(sessionId, reason);
  }

  private forgetTerminalStreamEpoch(sessionId: string): void {
    this.terminalStreamEpochLedger.forget(sessionId);
  }

  private createRetainedTerminalSessionState(sessionId: string): RetainedTerminalSessionState {
    const configuredOrdinal = this.retainedTerminalInitialOrdinal;
    const streamEpoch = configuredOrdinal?.streamEpoch === undefined
      ? this.currentTerminalStreamEpoch(sessionId)
      : this.terminalStreamEpochLedger.adopt(
          sessionId,
          configuredOrdinal.streamEpoch,
          'session-created',
        );
    const sourceSeq = configuredOrdinal?.sourceSeq ?? '0';
    return {
      mode: this.retainedTerminalShadowEnabled ? 'shadow' : 'disabled',
      streamEpoch,
      sourceSeq,
      snapshotSeq: sourceSeq,
      oldestRetainedSeq: '0',
      oldestRetainedStreamEpoch: streamEpoch,
      records: [],
      facts: [],
      committedFactKeys: new Set(),
      factOrdinal: 0,
      factScannerTail: '',
      evictedRecords: 0,
      evictedFacts: 0,
      ledgerEncodedBytes: 4,
      ledgerRecordEncodedBytes: 0,
      ledgerFactEncodedBytes: 0,
      ledgerFactKeyEncodedBytes: 0,
      blockers: new Set(this.retainedTerminalShadowEnabled
        ? [
            'independent-baseline-unavailable',
            'retained-authority-delivery-inactive',
            'aggregate-model-memory-budget-unavailable',
            'checkpoint-chunk-budget-unavailable',
          ]
        : ['shadow-disabled']),
      comparer: {
        result: 'unavailable',
        axes: {
          logicalLines: 'unavailable',
          cells: 'unavailable',
          unicodeWidth: 'unavailable',
          cursor: 'unavailable',
          modes: 'unavailable',
          activeBuffer: 'unavailable',
          parserTail: 'unavailable',
          eviction: 'unavailable',
        },
      },
      comparisonTimer: null,
      comparisonInFlight: false,
      comparisonPendingSourceSeq: null,
      lastComparisonStartedAtMs: 0,
      lastCheckpoint: null,
      clients: new Map(),
      driverLease: { ownerClientId: null, generation: '0', state: 'unclaimed' },
      driverViewGeneration: null,
      nextLeaseGeneration: 0n,
      totalLogicalRowsObserved: 0,
      eviction: {
        evictedRows: 0,
        evictedBytes: 0,
        reason: null,
        policyId: LEGACY_TERMINAL_RESOURCE_POLICY_ID,
        completeLogicalRowBoundary: true,
        dataGapRequired: false,
        restoreNeeded: false,
        staleViewReady: true,
      },
      cleanup: {
        admissionOpen: true,
        settled: false,
        rejectedLateMessages: 0,
        factLedgerSettlements: 0,
        checkpointLedgerSettlements: 0,
        timerSettlements: 0,
      },
      shadowSettlement: {
        admissionOpen: this.retainedTerminalShadowEnabled,
        settled: false,
        factLedgerSettlements: 0,
        checkpointLedgerSettlements: 0,
        timerSettlements: 0,
      },
      authorityRuntime: {
        admission: {
          mode: this.retainedTerminalShadowEnabled ? 'legacy' : 'none',
          transitionEpoch: null,
        },
        responder: {
          active: 'legacy-browser',
          activeLeaseId: null,
          legacyEnabled: true,
          serverEnabled: false,
          revokedLeaseIds: new Set(),
        },
        driver: {
          active: null,
          activeLeaseId: null,
          revokedLeaseIds: new Set(),
        },
        suspendedBrowserDriver: null,
        serverRecoveryAcks: new Map(),
        serverCheckpointDeliveries: new Map(),
        noLocalCacheEvidence: null,
        limitedSessionSelected: false,
        reconnectGeneration: 0,
        recoveryRequiredReason: null,
      },
    };
  }

  private ensureRetainedTerminalSessionState(sessionData: SessionData): RetainedTerminalSessionState {
    const compatible = sessionData as SessionData & { retainedTerminal?: RetainedTerminalSessionState };
    // Legacy compatibility objects reach here with no `session` at all; they are
    // never on the wire, so an anonymous epoch key is enough for them.
    compatible.retainedTerminal ??= this.createRetainedTerminalSessionState(
      (sessionData as Partial<SessionData>).session?.id ?? '',
    );
    this.ensureTerminalAuthorityRuntimePortState(compatible.retainedTerminal);
    return compatible.retainedTerminal;
  }

  private ensureTerminalAuthorityRuntimePortState(
    retained: RetainedTerminalSessionState,
  ): TerminalAuthorityRuntimePortStateInternal {
    const compatible = retained as RetainedTerminalSessionState & {
      authorityRuntime?: TerminalAuthorityRuntimePortStateInternal;
    };
    compatible.authorityRuntime ??= {
      admission: { mode: retained.mode === 'shadow' ? 'legacy' : 'none', transitionEpoch: null },
      responder: {
        active: 'legacy-browser',
        activeLeaseId: null,
        legacyEnabled: true,
        serverEnabled: false,
        revokedLeaseIds: new Set(),
      },
      driver: {
        active: retained.driverLease.state === 'active' ? 'legacy-browser' : null,
        activeLeaseId: retained.driverLease.state === 'active'
          ? `retained-browser:${retained.driverLease.ownerClientId ?? 'unknown'}:${retained.driverViewGeneration ?? 0}:${retained.driverLease.generation}`
          : null,
        revokedLeaseIds: new Set(),
      },
      suspendedBrowserDriver: retained.driverLease.state === 'active'
        && retained.driverLease.ownerClientId
        && retained.driverViewGeneration !== null
        ? {
            clientId: retained.driverLease.ownerClientId,
            viewGeneration: retained.driverViewGeneration,
            leaseGeneration: retained.driverLease.generation,
          }
        : null,
      serverRecoveryAcks: new Map(),
      serverCheckpointDeliveries: new Map(),
      noLocalCacheEvidence: null,
      limitedSessionSelected: false,
      reconnectGeneration: 0,
      recoveryRequiredReason: null,
    };
    return compatible.authorityRuntime;
  }

  private maybeOpenTerminalAuthorityServerAdmission(
    runtime: TerminalAuthorityRuntimePortStateInternal,
  ): void {
    if (runtime.driver.active === 'server-headless'
      && runtime.driver.activeLeaseId
      && runtime.responder.active === 'server-headless'
      && runtime.responder.activeLeaseId
      && runtime.responder.serverEnabled) {
      runtime.admission.mode = 'server';
    }
  }

  private maybeOpenTerminalAuthorityCompatibilityAdmission(
    runtime: TerminalAuthorityRuntimePortStateInternal,
  ): void {
    if (runtime.driver.active === 'legacy-browser'
      && runtime.driver.activeLeaseId
      && runtime.responder.active === 'legacy-browser'
      && runtime.responder.legacyEnabled) {
      runtime.admission.mode = 'legacy';
    }
  }

  private buildRetainedTerminalAuthorityState(
    sessionId: string,
    data: SessionData,
  ): RetainedTerminalAuthorityState {
    const retained = this.ensureRetainedTerminalSessionState(data);
    const authorityRuntime = this.ensureTerminalAuthorityRuntimePortState(retained);
    const serverRuntimeActive = authorityRuntime.admission.mode === 'server'
      && authorityRuntime.driver.active === 'server-headless'
      && authorityRuntime.driver.activeLeaseId !== null
      && authorityRuntime.responder.active === 'server-headless'
      && authorityRuntime.responder.activeLeaseId !== null
      && authorityRuntime.responder.serverEnabled;
    const serverRecoveryActive = serverRuntimeActive
      && [...retained.clients.values()].every(client => {
        const delivery = authorityRuntime.serverCheckpointDeliveries.get(client.clientId);
        return delivery !== undefined
          && delivery.viewGeneration === client.viewGeneration
          // The authority wire epoch can advance at promotion before the
          // retained ledger does. A settled checkpoint therefore records the
          // retained tuple it covered and cannot cross into a new stream.
          && delivery.retainedStreamEpoch === retained.streamEpoch
          && BigInt(delivery.retainedSourceSeq) <= BigInt(retained.sourceSeq)
          && delivery.transitionEpoch === authorityRuntime.admission.transitionEpoch
          && delivery.driverLeaseId === authorityRuntime.driver.activeLeaseId
          && delivery.responderLeaseId === authorityRuntime.responder.activeLeaseId;
      });
    const configuredScrollback = this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines;
    const debugIsolation = this.terminalAuthorityDebugIsolations.get(sessionId);
    const scrollback = debugIsolation?.retainedScrollbackOverride === null
      || debugIsolation?.retainedScrollbackOverride === undefined
      ? configuredScrollback
      : {
          ...configuredScrollback,
          value: debugIsolation.retainedScrollbackOverride,
        };
    const ledgerPolicy = this.resolveRetainedTerminalLedgerPolicy(data);
    const checkpoint = data.headless
      ? {
          ...serializeRetainedHeadlessCheckpoint(data.headless),
          pendingEscapeTailAnsi: data.pendingEscapeTailAnsi,
        }
      : retained.lastCheckpoint!;
    if (data.headless) retained.lastCheckpoint = checkpoint;
    const axes: RetainedTerminalAuthorityState['comparer']['axes'] = { ...retained.comparer.axes };
    const state: RetainedTerminalAuthorityState = {
      availability: 'available',
      mode: retained.mode,
      streamEpoch: retained.streamEpoch,
      sourceSeq: retained.sourceSeq,
      snapshotSeq: retained.snapshotSeq,
      oldestRetainedSeq: retained.oldestRetainedSeq,
      oldestRetainedStreamEpoch: retained.oldestRetainedStreamEpoch,
      retentionPolicy: {
        effectiveRetainedScrollbackLines: scrollback.value,
        retentionPolicyId: this.getTerminalAuthorityDebugRetentionPolicyId(debugIsolation),
        source: scrollback.source,
        sourceKind: scrollback.sourceKind,
        conflictDetected: this.compiledTerminalResourcePolicy.diagnostics.some(diagnostic => diagnostic.code === 'source-conflict'),
      },
      checkpoint,
      budgets: {
        retention: { key: 'retention', unit: 'lines', value: scrollback.value, source: scrollback.source, configured: true },
        aggregateModelMemory: {
          key: 'aggregate-model-memory', unit: 'bytes', value: null,
          source: 'unconfigured', configured: false,
        },
        checkpointChunk: {
          key: 'checkpoint-chunk', unit: 'bytes', value: null,
          source: 'unconfigured', configured: false,
        },
        perClientInflight: {
          key: 'per-client-inflight', unit: 'bytes',
          value: this.effectiveResourceLimits.ws.perClientOutputQueueMaxBytes,
          source: 'resourceLimits.ws.perClientOutputQueueMaxBytes', configured: true,
        },
        socketGate: {
          key: 'socket-gate', unit: 'bytes', value: this.effectiveResourceLimits.ws.serverBufferedHighWaterBytes,
          source: 'resourceLimits.ws.serverBufferedHighWaterBytes', configured: true,
        },
        browserWriteSlice: {
          key: 'browser-write-slice', unit: 'bytes', value: this.effectiveResourceLimits.terminal.visibleFlushBudgetBytes,
          source: 'resourceLimits.terminal.visibleFlushBudgetBytes', configured: true,
        },
      },
      lastRecord: retained.records.at(-1) ?? null,
      records: retained.records.map(record => ({ ...record })),
      facts: retained.facts.map(fact => ({ ...fact })),
      comparer: {
        result: retained.mode === 'shadow' ? retained.comparer.result : 'unavailable',
        deliveryAuthority: serverRecoveryActive ? 'server' : 'legacy',
        failureBehavior: 'block-session-canary-only',
        axes: retained.mode === 'shadow' ? { ...axes } : Object.fromEntries(
          Object.keys(axes).map(key => [key, 'unavailable']),
        ) as RetainedTerminalAuthorityState['comparer']['axes'],
      },
      canary: { eligible: false, blockers: [] },
      eviction: { ...retained.eviction },
      driverLease: { ...retained.driverLease },
      cleanup: { ...retained.cleanup },
      shadowSettlement: { ...retained.shadowSettlement },
      clients: [...retained.clients.values()].map(client => ({ ...client })),
      recovery: serverRecoveryActive
        ? { authority: 'server', provisionalCacheUsed: false }
        : { authority: 'legacy-local', provisionalCacheUsed: true },
      ledger: {
        recordLimit: ledgerPolicy.recordLimit,
        factLimit: ledgerPolicy.factLimit,
        committedFactKeyCount: retained.committedFactKeys.size,
        evictedRecords: retained.evictedRecords,
        evictedFacts: retained.evictedFacts,
        encodedBytes: retained.ledgerEncodedBytes,
        byteLimit: ledgerPolicy.ledgerByteLimit,
        semanticKeyMaxBytes: RETAINED_FACT_SEMANTIC_KEY_MAX_BYTES,
      },
    };
    if (retained.mode === 'shadow' && this.retainedTerminalShadowProjectionMutator) {
      const candidate = this.retainedTerminalShadowProjectionMutator.mutate(sessionId, structuredClone(state));
      axes.logicalLines = this.retainedProjectionEqual(
        [state.checkpoint.normal.logicalLines, state.checkpoint.alternate.logicalLines],
        [candidate.checkpoint.normal.logicalLines, candidate.checkpoint.alternate.logicalLines],
      );
      axes.cells = this.retainedProjectionEqual(
        [state.checkpoint.normal.cellHash, state.checkpoint.normal.attributeHash, state.checkpoint.alternate.cellHash, state.checkpoint.alternate.attributeHash],
        [candidate.checkpoint.normal.cellHash, candidate.checkpoint.normal.attributeHash, candidate.checkpoint.alternate.cellHash, candidate.checkpoint.alternate.attributeHash],
      );
      axes.unicodeWidth = this.retainedProjectionEqual(
        [state.checkpoint.normal.logicalLines, state.checkpoint.alternate.logicalLines],
        [candidate.checkpoint.normal.logicalLines, candidate.checkpoint.alternate.logicalLines],
      );
      axes.cursor = this.retainedProjectionEqual(
        [state.checkpoint.cursor, state.checkpoint.savedCursor],
        [candidate.checkpoint.cursor, candidate.checkpoint.savedCursor],
      );
      axes.modes = this.retainedProjectionEqual(state.checkpoint.modes, candidate.checkpoint.modes);
      axes.activeBuffer = this.retainedProjectionEqual(state.checkpoint.activeBuffer, candidate.checkpoint.activeBuffer);
      // Parser-tail and eviction provenance do not have an independent retained
      // baseline yet. A fault-injection projection must not turn those external
      // axes into a synthetic self-match.
      state.comparer.axes = { ...axes };
      state.comparer.result = Object.values(axes).some(axis => axis === 'mismatch')
        ? 'mismatch'
        : Object.values(axes).some(axis => axis === 'unavailable')
          ? 'unavailable'
          : 'match';
      if (state.comparer.result === 'mismatch') retained.blockers.add('shadow-comparer-mismatch');
    }
    if (this.retainedTerminalModelFaultInjector?.shouldDegrade(sessionId)) {
      retained.blockers.add('model-degradation');
    }
    const blockers = [...retained.blockers];
    state.canary = { eligible: retained.mode === 'shadow' && blockers.length === 0, blockers };
    return state;
  }

  private retainedProjectionEqual(left: unknown, right: unknown): RetainedProjectionAxis {
    return JSON.stringify(left) === JSON.stringify(right) ? 'match' : 'mismatch';
  }

  private initializeHeadlessState(sessionId: string, sessionData: SessionData): void {
    try {
      sessionData.headless = this.createHeadlessTerminalStateFn({
        cols: sessionData.cols,
        rows: sessionData.rows,
        scrollbackLines: this.ensureRetainedTerminalSessionState(sessionData).mode === 'shadow'
          ? this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value
          : this.runtimePtyConfig.scrollbackLines,
        windowsPty: sessionData.windowsPty,
      });
      sessionData.headlessInstanceGeneration += 1;
      sessionData.headlessHealth = 'healthy';
      const retained = this.ensureRetainedTerminalSessionState(sessionData);
      sessionData.nextTerminalAuthoritySourceSeq = BigInt(retained.sourceSeq);
      retained.lastCheckpoint = {
        ...serializeRetainedHeadlessCheckpoint(sessionData.headless),
        pendingEscapeTailAnsi: sessionData.pendingEscapeTailAnsi,
      };
      this.attachTerminalAuthorityRuntimeForSession(sessionId, sessionData);
    } catch (error) {
      this.markHeadlessDegraded(sessionId, sessionData, 'create', error);
      this.startDegradedReplayRecovery(sessionId, sessionData, 'create');
    }
  }

  private createHeadlessOutputQueue(): HeadlessOutputQueue {
    const limits = this.runtimeHeadlessQueueConfig.limits;
    return createHeadlessOutputQueue({
      maxBytes: limits.pendingOutputMaxBytes,
      maxChunks: limits.pendingOutputMaxChunks,
      overflowPolicy: limits.overflowPolicy,
    });
  }

  private getHeadlessOutputObservability(): HeadlessOutputObservability {
    const total: HeadlessOutputObservability = {
      pendingBytes: 0,
      pendingChunks: 0,
      maxPendingBytes: 0,
      maxPendingChunks: 0,
      oldestPendingAgeMs: 0,
      overflowCount: 0,
      degradedCount: 0,
      degradedReplayBufferBytes: 0,
      degradedReplayTruncatedSessions: 0,
      recoverableFallbackSessions: 0,
      emptyFallbackSessions: 0,
      queueOverflowDegradedCount: 0,
      lastDegradedPhase: null,
    };

    for (const sessionData of this.sessions.values()) {
      const snapshot: HeadlessOutputQueueSnapshot = sessionData.headlessOutputQueue.snapshot();
      const oldestPendingOutput = sessionData.pendingHeadlessOutputs.values().next().value as PendingHeadlessOutput | undefined;
      const oldestPendingAgeMs = oldestPendingOutput ? Math.max(0, Date.now() - oldestPendingOutput.queuedAt) : 0;
      total.pendingBytes += sessionData.pendingHeadlessOutputBytes;
      total.pendingChunks += sessionData.pendingHeadlessOutputs.size;
      total.maxPendingBytes = Math.max(
        total.maxPendingBytes,
        snapshot.maxPendingBytes,
        sessionData.maxPendingHeadlessOutputBytes,
      );
      total.maxPendingChunks = Math.max(
        total.maxPendingChunks,
        snapshot.maxPendingChunks,
        sessionData.maxPendingHeadlessOutputChunks,
      );
      total.oldestPendingAgeMs = Math.max(total.oldestPendingAgeMs, snapshot.oldestPendingAgeMs, oldestPendingAgeMs);
      total.overflowCount += snapshot.overflowCount;
      total.degradedCount += snapshot.degradedCount;
      if (sessionData.headlessHealth === 'degraded') {
        const degradedReplayBufferBytes = Buffer.byteLength(sessionData.degradedReplayBuffer, 'utf8');
        total.degradedReplayBufferBytes += degradedReplayBufferBytes;
        if (sessionData.degradedReplayTruncated) {
          total.degradedReplayTruncatedSessions += 1;
        }
        if (degradedReplayBufferBytes > 0) {
          total.recoverableFallbackSessions += 1;
        } else {
          total.emptyFallbackSessions += 1;
        }
        if (sessionData.headlessDegradedPhase === 'queue-overflow') {
          total.queueOverflowDegradedCount += 1;
        }
        total.lastDegradedPhase = sessionData.headlessDegradedPhase ?? total.lastDegradedPhase;
      }
    }

    return total;
  }

  private queueHeadlessOutput(sessionId: string, sessionData: SessionData, data: string, retainedSemanticData = data): void {
    this.ensureHeadlessPolicyTracking(sessionData);
    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    if (sessionData.headlessHealth !== 'healthy' || !sessionData.headless) {
      if (retained.mode === 'shadow') {
        this.rejectRetainedTerminalSemanticRecord(sessionData, retainedSemanticData, 'model-degraded');
      }
      this.appendDegradedReplayOutput(sessionData, data);
      if (data.length > 0) {
        this.wsRouter?.routeSessionOutput(sessionId, data, sessionData.screenSeq, {
          authorityEpoch: sessionData.authorityEpoch,
          authorityRevision: sessionData.authorityRevision,
        }, 'legacy-unnegotiated');
      }
      if (this.pendingResizeReplaySessions.has(sessionId)) {
        this.scheduleResizeReplayRefresh(sessionId, 120);
      }
      return;
    }

    let policyDecision: TerminalResourcePolicyHeadlessAdmissionDecision | undefined;
    try {
      policyDecision = this.terminalResourcePolicyHeadlessAdmissionPort?.decide({
        sessionId,
        rawData: data,
        pendingBytes: sessionData.pendingHeadlessOutputBytes,
        pendingChunks: sessionData.pendingHeadlessOutputs.size,
        pendingBytesByPolicyGeneration: sessionData.pendingHeadlessOutputBytesByPolicyGeneration,
        pendingChunksByPolicyGeneration: sessionData.pendingHeadlessOutputChunksByPolicyGeneration,
        pendingLegacyBytesByPolicyGeneration: sessionData.pendingHeadlessLegacyOutputBytesByPolicyGeneration,
        pendingLegacyChunksByPolicyGeneration: sessionData.pendingHeadlessLegacyOutputChunksByPolicyGeneration,
      });
    } catch (error) {
      console.warn('[SessionManager] Headless policy admission decision failed; using legacy queue policy:', error);
    }
    const enqueueResult = policyDecision
      ? sessionData.headlessOutputQueue.enqueue(
        data,
        policyDecision.outputMaxBytes,
        policyDecision.outputMaxChunks,
      )
      : sessionData.headlessOutputQueue.enqueue(data);
    if (policyDecision) {
      try {
        policyDecision.record({
          ok: enqueueResult.ok,
          ...(enqueueResult.reason ? { reason: enqueueResult.reason } : {}),
        });
      } catch (error) {
        console.warn('[SessionManager] Headless policy admission ledger callback failed:', error);
      }
    }
    if (!enqueueResult.ok && enqueueResult.shouldDegradeHeadless) {
      const overflowReason = enqueueResult.reason ?? 'unknown';
      this.markHeadlessDegraded(
        sessionId,
        sessionData,
        'queue-overflow',
        new Error(`Headless output queue overflow (${sessionData.headlessQueueMode}): ${overflowReason}`),
      );
      if (retained.mode === 'shadow') {
        this.rejectRetainedTerminalSemanticRecord(sessionData, retainedSemanticData, 'queue-overflow');
      }
      this.appendDegradedReplayOutput(sessionData, data);
      if (data.length > 0) {
        this.wsRouter?.routeSessionOutput(sessionId, data, sessionData.screenSeq, {
          authorityEpoch: sessionData.authorityEpoch,
          authorityRevision: sessionData.authorityRevision,
        }, 'legacy-unnegotiated');
      }
      this.startDegradedReplayRecovery(sessionId, sessionData, 'queue-overflow');
      if (this.pendingResizeReplaySessions.has(sessionId)) {
        this.scheduleResizeReplayRefresh(sessionId, 120);
      }
      return;
    }

    this.queueAcceptedHeadlessOutput(
      sessionId,
      sessionData,
      data,
      policyDecision ? {
        policyGeneration: policyDecision.policyGeneration,
        exactlyOnceKey: policyDecision.exactlyOnceKey,
        admissionMode: policyDecision.admissionMode,
        settleFailure: policyDecision.settleFailure,
      } : undefined,
      retainedSemanticData,
    );
  }

  private async applyHeadlessOutput(
    sessionId: string,
    sessionData: SessionData,
    pendingOutput: PendingHeadlessOutput | string,
    ingestOwnerToken?: TerminalAuthorityIngestOwner,
  ): Promise<void> {
    const output: PendingHeadlessOutput = typeof pendingOutput === 'string'
      ? { id: -1, data: pendingOutput, byteLength: Buffer.byteLength(pendingOutput, 'utf8'), queuedAt: Date.now(), queued: false }
      : pendingOutput;
    if (!sessionData.headless) {
      return;
    }

    // OBS-BGSTAB-003: accumulate time spent in the writeHeadlessTerminal span so the
    // telemetry snapshot can expose headless write cost as a saturation-cause axis.
    // The timer is attached to the write itself (via finally) so it measures only the
    // write duration — not any extra wait when the close signal wins the race — and
    // still records the elapsed time when the write rejects.
    let queryReplies: readonly string[] = [];
    // The buffer and `screenSeq` disagree from here until the bump below, and
    // an atomic snapshot taken in between would over-claim its coverage.
    let flushedOutput: string;
    sessionData.headlessApplyInFlight += 1;
    try {
      if (output.data.length > 0) {
        const headlessWriteStartedAt = performance.now();
        const commitHeadlessWrite = async (): Promise<void> => {
          const trackedHeadlessWrite = this.writeHeadlessTerminalFn(sessionData.headless!, output.data).finally(() => {
            this.observability.headlessWriteCumulativeMs += performance.now() - headlessWriteStartedAt;
          });
          await Promise.race([
            trackedHeadlessWrite,
            sessionData.headlessCloseSignal.promise,
          ]);
        };
        if (sessionData.terminalQueryResponder) {
          const queryResult = await sessionData.terminalQueryResponder.captureCommittedWrite(
            output.data,
            { source: 'live' },
            commitHeadlessWrite,
          );
          queryReplies = queryResult.replies;
        } else {
          await commitHeadlessWrite();
        }
      }
      if (!this.isActiveSession(sessionId, sessionData) || sessionData.headlessHealth !== 'healthy' || !sessionData.headless) {
        return;
      }

      flushedOutput = output.queued
        ? sessionData.headlessOutputQueue.dequeue()?.data ?? output.data
        : output.data;
      if (output.id >= 0) {
        this.deletePendingHeadlessOutput(sessionData, output.id);
      }
      if (flushedOutput.length > 0) {
        this.advanceSessionTerminalParserState(sessionData, flushedOutput);
        sessionData.screenSeq += 1;
        sessionData.authorityRevision += 1;
      }
    } finally {
      sessionData.headlessApplyInFlight = Math.max(0, sessionData.headlessApplyInFlight - 1);
    }
    if (this.ensureRetainedTerminalSessionState(sessionData).mode === 'shadow') {
      const retained = this.ensureRetainedTerminalSessionState(sessionData);
      const sourceSeqBeforeCommit = retained.sourceSeq;
      try {
        this.commitRetainedTerminalOutput(
          sessionId,
          sessionData,
          output.retainedSemanticData ?? flushedOutput,
          flushedOutput,
        );
      } catch (error) {
        if (retained.sourceSeq === sourceSeqBeforeCommit) {
          this.rejectRetainedTerminalSemanticRecord(
            sessionData,
            output.retainedSemanticData ?? flushedOutput,
            'commit-failed',
          );
        }
        throw error;
      }
    }
    let terminalAuthorityDeliveryDisposition:
      | 'held-post-boundary'
      | 'server-delivered'
      | 'compatibility-delivered'
      | 'legacy-delivered'
      | undefined;
    if (output.terminalAuthorityRecordId && sessionData.terminalAuthorityController) {
      const applied = await sessionData.terminalAuthorityController.applyEnqueuedHeadlessOutput(
        output.terminalAuthorityRecordId,
      );
      terminalAuthorityDeliveryDisposition = applied.deliveryDisposition;
      for (const [replyOrdinal, reply] of queryReplies.entries()) {
        const effect: PendingTerminalAuthorityQueryEffect = {
          recordId: applied.recordId,
          replyOrdinal,
          reply,
          streamEpoch: sessionData.terminalAuthorityController.getState().streamEpoch,
          responderLeaseId: applied.responderLeaseId,
        };
        if (ingestOwnerToken === 'server-headless') {
          await this.settleTerminalAuthorityQueryEffect(sessionData, effect);
        } else if (ingestOwnerToken === 'server-headless-staged') {
          if (sessionData.terminalAuthorityController.getState().mode === 'rolling-back') {
            await this.settleTerminalAuthorityQueryEffect(sessionData, effect);
          } else {
            sessionData.pendingTerminalAuthorityQueryEffects.push(effect);
          }
        }
      }
    }
    if (flushedOutput.length === 0) return;
    this.appendUnsnapshottedOutput(sessionData, flushedOutput);
    this.markSnapshotDirty(sessionData);
    if (terminalAuthorityDeliveryDisposition === undefined) {
      this.wsRouter?.routeSessionOutput(sessionId, flushedOutput, sessionData.screenSeq, {
        authorityEpoch: sessionData.authorityEpoch,
        authorityRevision: sessionData.authorityRevision,
      });
    } else if (terminalAuthorityDeliveryDisposition === 'legacy-delivered') {
      this.wsRouter?.routeSessionOutput(sessionId, flushedOutput, sessionData.screenSeq, {
        authorityEpoch: sessionData.authorityEpoch,
        authorityRevision: sessionData.authorityRevision,
      }, 'legacy-unnegotiated');
    }
    if (this.pendingResizeReplaySessions.has(sessionId)) {
      this.scheduleResizeReplayRefresh(sessionId, 120);
    }
  }

  private settleTerminalAuthorityQueryEffect(
    sessionData: SessionData,
    effect: PendingTerminalAuthorityQueryEffect,
  ): void {
    const controller = sessionData.terminalAuthorityController;
    if (!controller) return;
    controller.settleQueryEffect(effect);
  }

  private flushPendingTerminalAuthorityQueryEffects(sessionData: SessionData): void {
    const pending = sessionData.pendingTerminalAuthorityQueryEffects.splice(0);
    for (const effect of pending) {
      const state = sessionData.terminalAuthorityController?.getState();
      this.settleTerminalAuthorityQueryEffect(sessionData, {
        ...effect,
        streamEpoch: state?.streamEpoch ?? effect.streamEpoch,
        responderLeaseId: state?.activeResponderLeaseId ?? effect.responderLeaseId,
      });
    }
  }

  private markSnapshotDirty(sessionData: SessionData): void {
    if (sessionData.snapshotCache) {
      sessionData.snapshotCache.dirty = true;
    }
  }

  private deletePendingHeadlessOutput(sessionData: SessionData, outputId: number): void {
    this.ensureHeadlessPolicyTracking(sessionData);
    const pendingOutput = sessionData.pendingHeadlessOutputs.get(outputId);
    if (!pendingOutput) {
      return;
    }
    sessionData.pendingHeadlessOutputs.delete(outputId);
    sessionData.headlessPolicyWriteFailureSettlers.delete(outputId);
    sessionData.pendingHeadlessOutputBytes = Math.max(
      0,
      sessionData.pendingHeadlessOutputBytes - pendingOutput.byteLength,
    );
    if (pendingOutput.policyGeneration !== undefined) {
      this.decrementHeadlessPolicyUsage(
        sessionData,
        pendingOutput.policyGeneration,
        pendingOutput.byteLength,
        pendingOutput.policyAdmissionMode ?? 'candidate',
      );
    }
  }

  private commitRetainedTerminalOutput(
    sessionId: string,
    sessionData: SessionData,
    semanticData: string,
    deliveredData: string,
  ): void {
    const retained = sessionData.retainedTerminal;
    this.advanceRetainedTerminalSourceOrdinal(sessionId, retained, true);
    const record: RetainedTerminalOperationRecord = {
      streamEpoch: retained.streamEpoch,
      sourceSeq: retained.sourceSeq,
      kind: 'output',
      modelCommitted: true,
      deliveryCreatedAfterCommit: true,
    };
    record.deliveryCreatedAfterCommit = deliveredData.length > 0;
    this.appendRetainedTerminalRecord(retained, record);
    this.commitRetainedTerminalFacts(retained, semanticData);
    if (sessionData.headless && deliveredData.length > 0) {
      markRetainedHeadlessSourceSequence(
        sessionData.headless,
        retained.streamEpoch,
        retained.sourceSeq,
      );
      this.updateRetainedTerminalEvictionFromModel(retained, sessionData.headless);
    }
    for (const client of retained.clients.values()) {
      if (client.slow) client.pendingBytes += Buffer.byteLength(deliveredData, 'utf8');
    }
    this.boundRetainedTerminalLedgers(sessionData);
    if (sessionData.headless) this.scheduleRetainedTerminalComparison(sessionId, sessionData);
    if (this.retainedTerminalModelFaultInjector?.shouldDegrade(sessionId)) {
      retained.blockers.add('model-degradation');
    }
  }

  private rejectRetainedTerminalSemanticRecord(
    sessionData: SessionData,
    semanticData: string,
    reason: 'model-degraded' | 'queue-overflow' | 'commit-failed',
  ): void {
    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    if (retained.mode !== 'shadow' || !retained.shadowSettlement.admissionOpen) return;
    this.advanceRetainedTerminalSourceOrdinal(sessionData.session.id, retained, false);
    this.appendRetainedTerminalRecord(retained, {
      streamEpoch: retained.streamEpoch,
      sourceSeq: retained.sourceSeq,
      kind: 'output',
      modelCommitted: false,
      deliveryCreatedAfterCommit: false,
      rejectionReason: reason,
    });
    this.commitRetainedTerminalFacts(retained, semanticData, { forceRejected: true });
    this.boundRetainedTerminalLedgers(sessionData);
  }

  private advanceRetainedTerminalSourceOrdinal(
    sessionId: string,
    retained: RetainedTerminalSessionState,
    advanceSnapshot: boolean,
  ): void {
    const next = advanceRetainedTerminalOrdinal({
      streamEpoch: retained.streamEpoch as Ordinal64,
      sourceSeq: retained.sourceSeq as Ordinal64,
    });
    retained.sourceSeq = next.sourceSeq;
    if (next.rolledOver) {
      // `01:478` — a rollover is one of the five events that raise the epoch,
      // so it is recorded in the ledger rather than written here directly.
      retained.streamEpoch = this.bumpTerminalStreamEpoch(sessionId, 'ordinal-rollover');
      retained.records = [];
      retained.facts = [];
      retained.committedFactKeys.clear();
      retained.ledgerEncodedBytes = 4;
      retained.ledgerRecordEncodedBytes = 0;
      retained.ledgerFactEncodedBytes = 0;
      retained.ledgerFactKeyEncodedBytes = 0;
      retained.factOrdinal = 0;
      retained.factScannerTail = '';
      retained.evictedRecords = 0;
      retained.evictedFacts = 0;
      retained.oldestRetainedSeq = '0';
      retained.oldestRetainedStreamEpoch = retained.streamEpoch;
      retained.snapshotSeq = '0';
      return;
    }
    if (advanceSnapshot) this.advanceRetainedTerminalSnapshotOrdinal(sessionId, retained);
  }

  private resolveRetainedTerminalLedgerPolicy(sessionData: SessionData): {
    recordLimit: number;
    factLimit: number;
    ledgerByteLimit: number;
  } {
    const retainedLines = this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value;
    const recordLimit = Math.max(
      RETAINED_LEDGER_MIN_RECORDS,
      Math.min(RETAINED_LEDGER_MAX_RECORDS, retainedLines + sessionData.rows),
    );
    const factLimit = recordLimit * RETAINED_FACTS_PER_RECORD;
    const ledgerByteLimit = recordLimit * RETAINED_LEDGER_RECORD_MAX_ENCODED_BYTES
      + factLimit * (
        RETAINED_LEDGER_FACT_MAX_ENCODED_BYTES
        + RETAINED_LEDGER_FACT_KEY_MAX_ENCODED_BYTES
      );
    return { recordLimit, factLimit, ledgerByteLimit };
  }

  private measureRetainedTerminalLedgerEntry(value: RetainedTerminalOperationRecord | RetainedTerminalFact): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }

  private appendRetainedTerminalRecord(
    retained: RetainedTerminalSessionState,
    record: RetainedTerminalOperationRecord,
  ): void {
    retained.records.push(record);
    retained.ledgerRecordEncodedBytes += this.measureRetainedTerminalLedgerEntry(record);
    this.refreshRetainedTerminalLedgerEncodedBytes(retained);
  }

  private appendRetainedTerminalFact(
    retained: RetainedTerminalSessionState,
    fact: RetainedTerminalFact,
  ): void {
    retained.facts.push(fact);
    retained.ledgerFactEncodedBytes += this.measureRetainedTerminalLedgerEntry(fact);
    this.refreshRetainedTerminalLedgerEncodedBytes(retained);
  }

  private removeRetainedTerminalFacts(
    retained: RetainedTerminalSessionState,
    removeCount: number,
  ): void {
    if (removeCount <= 0) return;
    const removedFacts = retained.facts.splice(0, removeCount);
    for (const fact of removedFacts) {
      retained.ledgerFactEncodedBytes = Math.max(
        0,
        retained.ledgerFactEncodedBytes - this.measureRetainedTerminalLedgerEntry(fact),
      );
      if (fact.disposition !== 'committed') continue;
      const key = `${fact.streamEpoch}:${fact.sourceSeq}:${fact.ordinal}`;
      if (retained.committedFactKeys.delete(key)) {
        retained.ledgerFactKeyEncodedBytes = Math.max(
          0,
          retained.ledgerFactKeyEncodedBytes - Buffer.byteLength(key, 'utf8'),
        );
      }
    }
    retained.evictedFacts += removedFacts.length;
  }

  private refreshRetainedTerminalLedgerEncodedBytes(retained: RetainedTerminalSessionState): void {
    const recordArrayStructureBytes = 2 + Math.max(0, retained.records.length - 1);
    const factArrayStructureBytes = 2 + Math.max(0, retained.facts.length - 1);
    retained.ledgerEncodedBytes = retained.ledgerRecordEncodedBytes
      + retained.ledgerFactEncodedBytes
      + retained.ledgerFactKeyEncodedBytes
      + recordArrayStructureBytes
      + factArrayStructureBytes;
  }

  private boundRetainedTerminalLedgers(sessionData: SessionData): void {
    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    const { recordLimit, factLimit, ledgerByteLimit } = this.resolveRetainedTerminalLedgerPolicy(sessionData);
    if (retained.records.length > recordLimit) {
      const removeCount = retained.records.length - recordLimit;
      const removedRecords = retained.records.splice(0, removeCount);
      const removedRecordIds = new Set<string>();
      for (const record of removedRecords) {
        retained.ledgerRecordEncodedBytes = Math.max(
          0,
          retained.ledgerRecordEncodedBytes - this.measureRetainedTerminalLedgerEntry(record),
        );
        removedRecordIds.add(`${record.streamEpoch}:${record.sourceSeq}`);
      }
      retained.evictedRecords += removedRecords.length;
      let removedFactPrefix = 0;
      while (removedFactPrefix < retained.facts.length) {
        const fact = retained.facts[removedFactPrefix]!;
        if (!removedRecordIds.has(`${fact.streamEpoch}:${fact.sourceSeq}`)) break;
        removedFactPrefix += 1;
      }
      this.removeRetainedTerminalFacts(retained, removedFactPrefix);
    }
    if (retained.facts.length > factLimit) {
      this.removeRetainedTerminalFacts(retained, retained.facts.length - factLimit);
    }
    this.refreshRetainedTerminalLedgerEncodedBytes(retained);
    if (retained.ledgerEncodedBytes > ledgerByteLimit) {
      retained.blockers.add('retained-ledger-byte-budget-exceeded');
    }
  }

  private scheduleRetainedTerminalComparison(
    sessionId: string,
    sessionData: SessionData,
    minimumDelayMs = RETAINED_SHADOW_COMPARISON_DEBOUNCE_MS,
  ): void {
    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    if (retained.mode !== 'shadow' || !retained.shadowSettlement.admissionOpen) return;
    retained.comparisonPendingSourceSeq = retained.sourceSeq;
    if (retained.comparisonTimer || retained.comparisonInFlight) return;
    const intervalRemainingMs = retained.lastComparisonStartedAtMs === 0
      ? 0
      : Math.max(
          0,
          retained.lastComparisonStartedAtMs + RETAINED_SHADOW_COMPARISON_MIN_INTERVAL_MS - Date.now(),
        );
    retained.comparisonTimer = setTimeout(() => {
      retained.comparisonTimer = null;
      void this.runRetainedTerminalComparison(sessionId, sessionData);
    }, Math.max(minimumDelayMs, intervalRemainingMs));
    retained.comparisonTimer.unref();
  }

  private async runRetainedTerminalComparison(
    sessionId: string,
    sessionData: SessionData,
    options: { allowBusySiblings?: boolean } = {},
  ): Promise<void> {
    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    if (!this.isActiveSession(sessionId, sessionData)
      || retained.mode !== 'shadow'
      || !retained.shadowSettlement.admissionOpen
      || !sessionData.headless) {
      retained.comparisonPendingSourceSeq = null;
      return;
    }
    const comparedSessions = options.allowBusySiblings ? [sessionData] : [...this.sessions.values()];
    const anyHeadlessSessionBusy = comparedSessions.some(
      candidate => candidate.pendingHeadlessWrites > 0 || candidate.pendingHeadlessOutputs.size > 0,
    );
    if (anyHeadlessSessionBusy) {
      this.scheduleRetainedTerminalComparison(
        sessionId,
        sessionData,
        RETAINED_SHADOW_COMPARISON_BUSY_RETRY_MS,
      );
      return;
    }
    const comparedSourceSeq = retained.comparisonPendingSourceSeq;
    retained.comparisonPendingSourceSeq = null;
    retained.comparisonInFlight = true;
    retained.lastComparisonStartedAtMs = Date.now();
    try {
      const checkpoint = {
        ...serializeRetainedHeadlessCheckpoint(sessionData.headless),
        pendingEscapeTailAnsi: sessionData.pendingEscapeTailAnsi,
      };
      const comparison = await this.compareRetainedHeadlessCheckpointRoundTripFn(checkpoint, {
        scrollbackLines: this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value,
        windowsPty: sessionData.windowsPty,
        // Parser-tail and eviction provenance have no independent rehydrated
        // baseline in PH004. Omission intentionally makes those axes unavailable.
      });
      if (!this.isActiveSession(sessionId, sessionData)
        || retained.mode !== 'shadow'
        || !retained.shadowSettlement.admissionOpen
        || retained.comparisonPendingSourceSeq !== null
        || retained.sourceSeq !== comparedSourceSeq) {
        return;
      }
      retained.lastCheckpoint = checkpoint;
      retained.comparer = comparison;
      const principalAxes = [
        comparison.axes.logicalLines,
        comparison.axes.cells,
        comparison.axes.unicodeWidth,
        comparison.axes.cursor,
        comparison.axes.modes,
        comparison.axes.activeBuffer,
      ];
      if (principalAxes.some(axis => axis === 'mismatch')) {
        retained.blockers.add('shadow-comparer-mismatch');
      } else if (principalAxes.every(axis => axis === 'match')) {
        retained.blockers.delete('independent-baseline-unavailable');
        retained.blockers.delete('shadow-comparer-mismatch');
      } else {
        retained.blockers.add('independent-baseline-unavailable');
      }
      if (comparison.axes.parserTail === 'unavailable' || comparison.axes.eviction === 'unavailable') {
        retained.blockers.add('shadow-comparer-axis-unavailable');
      }
    } catch {
      if (this.isActiveSession(sessionId, sessionData)) {
        retained.blockers.add('independent-baseline-unavailable');
        retained.comparer.result = 'unavailable';
      }
    } finally {
      retained.comparisonInFlight = false;
      if (this.isActiveSession(sessionId, sessionData) && retained.comparisonPendingSourceSeq !== null) {
        this.scheduleRetainedTerminalComparison(sessionId, sessionData);
      }
    }
  }

  private advanceRetainedTerminalSnapshotOrdinal(
    sessionId: string,
    retained: RetainedTerminalSessionState,
  ): void {
    const next = advanceRetainedTerminalOrdinal({
      streamEpoch: retained.streamEpoch as Ordinal64,
      sourceSeq: retained.snapshotSeq as Ordinal64,
    });
    retained.snapshotSeq = next.sourceSeq;
    if (!next.rolledOver) return;
    retained.streamEpoch = this.bumpTerminalStreamEpoch(sessionId, 'ordinal-rollover');
    retained.sourceSeq = '0';
    retained.records = [];
    retained.facts = [];
    retained.committedFactKeys.clear();
    retained.ledgerEncodedBytes = 4;
    retained.ledgerRecordEncodedBytes = 0;
    retained.ledgerFactEncodedBytes = 0;
    retained.ledgerFactKeyEncodedBytes = 0;
    retained.factOrdinal = 0;
    retained.factScannerTail = '';
    retained.oldestRetainedSeq = '0';
    retained.oldestRetainedStreamEpoch = retained.streamEpoch;
  }

  private updateRetainedTerminalEvictionFromModel(
    retained: RetainedTerminalSessionState,
    headless: HeadlessTerminalState,
  ): void {
    const metrics = readRetainedHeadlessBufferMetrics(headless);
    const evictionAdvanced = metrics.evictedPhysicalRows > retained.eviction.evictedRows;
    retained.eviction.evictedRows = metrics.evictedPhysicalRows;
    retained.eviction.evictedBytes = metrics.evictedUtf8Bytes;
    retained.eviction.completeLogicalRowBoundary = metrics.completeLogicalRowBoundary;
    if (metrics.trimTracking === 'unavailable'
      || !metrics.completeLogicalRowBoundary
      || metrics.sourceMarkerCoverage !== 'complete') {
      retained.blockers.add('eviction-provenance-unavailable');
    }
    if (
      metrics.oldestRetainedSeq !== null
      && metrics.oldestRetainedStreamEpoch === retained.streamEpoch
    ) {
      retained.oldestRetainedSeq = metrics.oldestRetainedSeq;
      retained.oldestRetainedStreamEpoch = metrics.oldestRetainedStreamEpoch;
    } else if (
      metrics.oldestRetainedSeq !== null
      && metrics.oldestRetainedStreamEpoch !== null
      && metrics.oldestRetainedStreamEpoch !== retained.streamEpoch
    ) {
      retained.blockers.add('cross-epoch-retention-unavailable');
    }
    if (!evictionAdvanced) return;
    retained.eviction.reason = 'retention-limit';
    retained.eviction.dataGapRequired = true;
    retained.eviction.restoreNeeded = true;
    retained.eviction.staleViewReady = false;
    for (const client of retained.clients.values()) {
      if (!client.slow) continue;
      client.dataGapRequired = true;
      client.restoreNeeded = true;
      client.ready = false;
    }
  }

  private commitRetainedTerminalFacts(
    retained: RetainedTerminalSessionState,
    data: string,
    options: { forceRejected?: boolean } = {},
  ): void {
    const detected: Array<{ kind: string; semanticKey: string; rejected?: boolean }> = [];
    const combined = `${retained.factScannerTail}${data}`;
    retained.factScannerTail = '';
    let index = 0;
    while (index < combined.length) {
      if (combined.startsWith('\x1b]', index)) {
        const belEnd = combined.indexOf('\x07', index + 2);
        const stEnd = combined.indexOf('\x1b\\', index + 2);
        const c1StEnd = combined.indexOf('\x9c', index + 2);
        const candidates = [belEnd, stEnd, c1StEnd].filter(value => value >= 0);
        if (candidates.length === 0) {
          retained.factScannerTail = combined.slice(index);
          break;
        }
        const end = Math.min(...candidates);
        const terminatorWidth = end === stEnd ? 2 : 1;
        const body = combined.slice(index + 2, end);
        if (body.startsWith('0;') || body.startsWith('2;')) {
          detected.push({ kind: 'title', semanticKey: body.slice(2) });
        } else if (body.startsWith('7;file://')) {
          try {
            detected.push({ kind: 'cwd', semanticKey: decodeURIComponent(new URL(body.slice(2)).pathname) });
          } catch {
            detected.push({ kind: 'cwd', semanticKey: body.slice(2) });
          }
        } else {
          const osc133Status = RETAINED_OSC133_STATUS_FACTS[body];
          if (osc133Status) detected.push({ kind: 'status', semanticKey: osc133Status });
        }
        index = end + terminatorWidth;
        continue;
      }
      if (combined.startsWith('\x1b[', index)) {
        let end = index + 2;
        while (end < combined.length) {
          const code = combined.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        if (end >= combined.length) {
          retained.factScannerTail = combined.slice(index);
          break;
        }
        const sequence = combined.slice(index, end + 1);
        if (sequence === '\x1b[6n') {
          detected.push({ kind: 'query-request', semanticKey: 'DSR-6', rejected: true });
        }
        index = end + 1;
        continue;
      }
      if (combined[index] === '\x1b' && index === combined.length - 1) {
        retained.factScannerTail = combined.slice(index);
        break;
      }
      if (combined[index] === '\x07') detected.push({ kind: 'bell', semanticKey: 'bell' });
      index += 1;
    }
    if (retained.factScannerTail.length > 8_192) {
      retained.factScannerTail = retained.factScannerTail.slice(-8_192);
      retained.blockers.add('semantic-fact-tail-overflow');
    }
    if (/Executing semantic tool call:/u.test(combined)) {
      detected.push({ kind: 'substantive-agent-output', semanticKey: 'running' });
    }
    retained.factOrdinal = 0;
    for (const fact of detected) {
      const ordinal = retained.factOrdinal++;
      const semanticKey = this.canonicalizeRetainedTerminalFactSemanticKey(fact.semanticKey);
      const key = `${retained.streamEpoch}:${retained.sourceSeq}:${ordinal}`;
      const duplicate = retained.committedFactKeys.has(key);
      const rejected = fact.rejected || options.forceRejected === true;
      const disposition = rejected ? 'rejected' : duplicate ? 'duplicate' : 'committed';
      if (!rejected) {
        retained.committedFactKeys.add(key);
        if (!duplicate) {
          retained.ledgerFactKeyEncodedBytes += Buffer.byteLength(key, 'utf8');
        }
      }
      this.appendRetainedTerminalFact(retained, {
        kind: fact.kind,
        semanticKey,
        streamEpoch: retained.streamEpoch,
        sourceSeq: retained.sourceSeq,
        ordinal,
        disposition,
      });
    }
  }

  private canonicalizeRetainedTerminalFactSemanticKey(value: string): string {
    const encodedBytes = Buffer.byteLength(value, 'utf8');
    if (encodedBytes <= RETAINED_FACT_SEMANTIC_KEY_MAX_BYTES) return value;
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}:bytes=${encodedBytes}`;
  }

  private decrementHeadlessPolicyUsage(
    sessionData: SessionData,
    policyGeneration: number,
    byteLength: number,
    admissionMode: 'candidate' | 'legacy',
  ): void {
    this.ensureHeadlessPolicyTracking(sessionData);
    const decrement = (map: Map<number, number>, amount: number) => {
      const next = Math.max(0, (map.get(policyGeneration) ?? 0) - amount);
      if (next === 0) map.delete(policyGeneration);
      else map.set(policyGeneration, next);
    };
    decrement(sessionData.pendingHeadlessOutputBytesByPolicyGeneration, byteLength);
    decrement(sessionData.pendingHeadlessOutputChunksByPolicyGeneration, 1);
    if (admissionMode === 'legacy') {
      decrement(sessionData.pendingHeadlessLegacyOutputBytesByPolicyGeneration, byteLength);
      decrement(sessionData.pendingHeadlessLegacyOutputChunksByPolicyGeneration, 1);
    }
  }

  private markHeadlessDegraded(
    sessionId: string,
    sessionData: SessionData,
    phase: HeadlessDegradedPhase,
    error: unknown,
  ): void {
    if (!this.isActiveSession(sessionId, sessionData)) {
      return;
    }

    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    const authorityRuntime = this.ensureTerminalAuthorityRuntimePortState(retained);
    if (authorityRuntime.driver.activeLeaseId) {
      authorityRuntime.driver.revokedLeaseIds.add(authorityRuntime.driver.activeLeaseId);
    }
    if (authorityRuntime.responder.activeLeaseId) {
      authorityRuntime.responder.revokedLeaseIds.add(authorityRuntime.responder.activeLeaseId);
    }
    authorityRuntime.admission.mode = 'none';
    authorityRuntime.driver.active = null;
    authorityRuntime.driver.activeLeaseId = null;
    authorityRuntime.responder.active = null;
    authorityRuntime.responder.activeLeaseId = null;
    authorityRuntime.responder.legacyEnabled = false;
    authorityRuntime.responder.serverEnabled = false;
    authorityRuntime.noLocalCacheEvidence = null;
    authorityRuntime.limitedSessionSelected = false;
    const runtimeDisposalErrors = this.disposeTerminalAuthorityRuntimeForSession(sessionId, sessionData);
    if (runtimeDisposalErrors.length > 0) {
      console.warn(
        '[SessionManager] Terminal authority runtime degradation cleanup failed:',
        new AggregateError(runtimeDisposalErrors, 'terminal-authority-runtime-degradation-cleanup-failed'),
      );
    }
    sessionData.pendingTerminalAuthorityQueryEffects = [];
    if (sessionData.headless) {
      try {
        retained.lastCheckpoint = {
          ...serializeRetainedHeadlessCheckpoint(sessionData.headless),
          pendingEscapeTailAnsi: sessionData.pendingEscapeTailAnsi,
        };
      } catch {
        // Preserve the last known-good checkpoint when serialization is part of the failure.
      }
    }
    retained.blockers.add('model-degradation');
    retained.comparer.result = 'unavailable';
    retained.comparer.axes = {
      logicalLines: 'unavailable',
      cells: 'unavailable',
      unicodeWidth: 'unavailable',
      cursor: 'unavailable',
      modes: 'unavailable',
      activeBuffer: 'unavailable',
      parserTail: 'unavailable',
      eviction: 'unavailable',
    };

    if (sessionData.headless) {
      disposeHeadlessTerminal(sessionData.headless);
      sessionData.headless = null;
    }
    sessionData.headlessCloseSignal.resolve();
    sessionData.headlessOutputQueue.recordDegraded();
    this.settleRetainedTerminalPendingOutputsBeforeDegrade(sessionData, phase);
    const pendingOutput = this.drainHeadlessPendingOutput(sessionData);
    if (pendingOutput.length > 0) {
      this.advanceSessionTerminalParserState(sessionData, pendingOutput);
    }
    const seed = `${sessionData.snapshotCache?.data ?? ''}${sessionData.unsnapshottedOutput}${pendingOutput}`;
    if (seed.length > 0) {
      const degraded = truncateTerminalPayloadTail(seed, this.runtimePtyConfig.maxSnapshotBytes);
      sessionData.degradedReplayBuffer = degraded.content;
      sessionData.degradedReplayTruncated =
        degraded.truncated ||
        Boolean(sessionData.snapshotCache?.truncated) ||
        sessionData.unsnapshottedOutputTruncated;
      sessionData.screenSeq += 1;
      sessionData.authorityRevision += 1;
    }
    sessionData.unsnapshottedOutput = '';
    sessionData.unsnapshottedOutputTruncated = false;
    sessionData.headlessHealth = 'degraded';
    sessionData.headlessDegradedPhase = phase;
    sessionData.snapshotCache = null;

    const message = error instanceof Error ? error.message : String(error);
    this.captureDebugEvent(sessionId, 'headless', 'headless_degraded', {
      phase,
      message,
      screenSeq: sessionData.screenSeq,
      degradedReplayBufferBytes: Buffer.byteLength(sessionData.degradedReplayBuffer, 'utf8'),
      degradedReplayTruncated: sessionData.degradedReplayTruncated,
      fallbackDataState: this.getFallbackDataState(sessionData),
    });
    console.warn(`[SessionManager] Headless terminal degraded (${phase}) for session ${sessionId}: ${message}`);
  }

  private settleRetainedTerminalPendingOutputsBeforeDegrade(
    sessionData: SessionData,
    phase: HeadlessDegradedPhase,
  ): void {
    this.ensureHeadlessPolicyTracking(sessionData);
    const retained = this.ensureRetainedTerminalSessionState(sessionData);
    const rejectionReason = phase === 'queue-overflow'
      ? 'queue-overflow'
      : phase === 'write'
        ? 'commit-failed'
        : 'model-degraded';
    for (const output of sessionData.pendingHeadlessOutputs.values()) {
      try {
        sessionData.headlessPolicyWriteFailureSettlers.get(output.id)?.('headless-write-failed');
      } catch (error) {
        console.warn(
          `[SessionManager] Headless policy failure settler threw for session ${sessionData.session.id}, output ${output.id}:`,
          error,
        );
      }
      if (retained.mode === 'shadow' && retained.shadowSettlement.admissionOpen) {
        this.rejectRetainedTerminalSemanticRecord(
          sessionData,
          output.retainedSemanticData ?? output.data,
          rejectionReason,
        );
      }
    }
  }

  private drainHeadlessPendingOutput(sessionData: SessionData): string {
    this.ensureHeadlessPolicyTracking(sessionData);
    let pendingOutput = '';
    for (const output of sessionData.pendingHeadlessOutputs.values()) {
      pendingOutput += output.data;
    }
    sessionData.pendingHeadlessOutputs.clear();
    sessionData.pendingHeadlessOutputBytes = 0;
    sessionData.pendingHeadlessOutputBytesByPolicyGeneration.clear();
    sessionData.pendingHeadlessOutputChunksByPolicyGeneration.clear();
    sessionData.pendingHeadlessLegacyOutputBytesByPolicyGeneration.clear();
    sessionData.pendingHeadlessLegacyOutputChunksByPolicyGeneration.clear();
    sessionData.pendingHeadlessWritesByPolicyGeneration.clear();
    sessionData.headlessPolicyWriteFailureSettlers.clear();
    sessionData.headlessOutputQueue.drain();
    return pendingOutput;
  }

  private createDegradedSnapshot(sessionData: SessionData): SessionScreenSnapshot {
    const fallbackDataBytes = Buffer.byteLength(sessionData.degradedReplayBuffer, 'utf8');
    return {
      seq: sessionData.screenSeq,
      cols: sessionData.cols,
      rows: sessionData.rows,
      data: sessionData.degradedReplayBuffer,
      truncated: sessionData.degradedReplayTruncated,
      generatedAt: Date.now(),
      health: 'degraded',
      fallbackDataState: this.getFallbackDataState(sessionData),
      fallbackDataBytes,
      windowsPty: sessionData.windowsPty,
      authorityEpoch: sessionData.authorityEpoch,
      authorityRevision: sessionData.authorityRevision,
      parserComplete: sessionData.parserComplete,
      pendingEscapeTailAnsi: sessionData.pendingEscapeTailAnsi,
    };
  }

  private getFallbackDataState(sessionData: SessionData): FallbackDataState {
    return sessionData.degradedReplayBuffer.length > 0
      ? 'recoverable-buffer'
      : 'empty-no-recoverable-data';
  }

  private startDegradedReplayRecovery(
    sessionId: string,
    sessionData: SessionData,
    reason: HeadlessDegradedPhase,
  ): void {
    if (sessionData.degradedReplayBuffer.length === 0) {
      return;
    }
    if (typeof this.wsRouter?.refreshReplaySnapshots !== 'function') {
      return;
    }
    this.wsRouter.refreshReplaySnapshots(sessionId, {
      startWhenReady: true,
      origin: 'degraded',
      reason,
    });
  }

  private isActiveSession(sessionId: string, sessionData: SessionData): boolean {
    return this.sessions.get(sessionId) === sessionData;
  }

  private advanceSessionTerminalParserState(sessionData: SessionData, data: string): void {
    if (sessionData.parserTailOverflow) {
      sessionData.parserComplete = false;
      sessionData.pendingEscapeTailAnsi = '';
      return;
    }
    const parserState = advanceTerminalPartialEscapeTail(
      sessionData.pendingEscapeTailAnsi,
      data,
      this.runtimePtyConfig.maxSnapshotBytes,
    );
    sessionData.parserComplete = parserState.parserComplete;
    sessionData.pendingEscapeTailAnsi = parserState.pendingEscapeTailAnsi;
    sessionData.parserTailOverflow = parserState.overflowed;
  }

  private appendDegradedReplayOutput(sessionData: SessionData, data: string): void {
    this.advanceSessionTerminalParserState(sessionData, data);
    sessionData.screenSeq += 1;
    sessionData.authorityRevision += 1;
    const nextContent = `${sessionData.degradedReplayBuffer}${data}`;
    const truncated = truncateTerminalPayloadTail(nextContent, this.runtimePtyConfig.maxSnapshotBytes);
    sessionData.degradedReplayBuffer = truncated.content;
    sessionData.degradedReplayTruncated = sessionData.degradedReplayTruncated || truncated.truncated;
  }

  private appendUnsnapshottedOutput(sessionData: SessionData, data: string): void {
    const nextContent = `${sessionData.unsnapshottedOutput}${data}`;
    const truncated = truncateTerminalPayloadTail(nextContent, this.runtimePtyConfig.maxSnapshotBytes);
    sessionData.unsnapshottedOutput = truncated.content;
    sessionData.unsnapshottedOutputTruncated = sessionData.unsnapshottedOutputTruncated || truncated.truncated;
  }

  private scheduleResizeReplayRefresh(sessionId: string, delayMs = 75): void {
    const existing = this.pendingResizeRefreshTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }

    if (!this.pendingResizeReplayStartedAt.has(sessionId)) {
      this.pendingResizeReplayStartedAt.set(sessionId, Date.now());
    }

    const startedAt = this.pendingResizeReplayStartedAt.get(sessionId) ?? Date.now();
    const elapsedMs = Date.now() - startedAt;
    const remainingDeadlineMs = MAX_RESIZE_REPLAY_DELAY_MS - elapsedMs;
    const effectiveDelayMs =
      remainingDeadlineMs <= 0
        ? Math.min(delayMs, 30)
        : remainingDeadlineMs > 0
        ? Math.min(delayMs, Math.max(1, remainingDeadlineMs))
        : delayMs;

    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.pendingResizeReplaySessions.delete(sessionId);
        this.pendingResizeReplayStartedAt.delete(sessionId);
        this.pendingResizeReplayLastOutputAt.delete(sessionId);
        this.pendingResizeRefreshTimers.delete(sessionId);
        return;
      }

      const startedAt = this.pendingResizeReplayStartedAt.get(sessionId) ?? Date.now();
      const elapsedMs = Date.now() - startedAt;
      const afterDeadline = elapsedMs >= MAX_RESIZE_REPLAY_DELAY_MS;
      const lastOutputAt = this.pendingResizeReplayLastOutputAt.get(sessionId);
      const clearResizeReplayState = (): void => {
        this.pendingResizeRefreshTimers.delete(sessionId);
        this.pendingResizeReplaySessions.delete(sessionId);
        this.pendingResizeReplayStartedAt.delete(sessionId);
        this.pendingResizeReplayLastOutputAt.delete(sessionId);
      };

      if (lastOutputAt !== undefined) {
        const quietForMs = Date.now() - lastOutputAt;
        if (!afterDeadline && quietForMs < RESIZE_REPLAY_QUIET_WINDOW_MS) {

          this.scheduleResizeReplayRefresh(
            sessionId,
            Math.max(10, RESIZE_REPLAY_QUIET_WINDOW_MS - quietForMs),
          );
          return;
        }

        if (session.pendingHeadlessWrites > 0) {
          this.scheduleResizeReplayRefresh(sessionId, 30);
          return;
        }
      } else if (session.pendingHeadlessWrites > 0) {
        this.scheduleResizeReplayRefresh(sessionId, 30);
        return;
      }

      if (session.pendingHeadlessWrites > 0) {
        this.scheduleResizeReplayRefresh(sessionId, 30);
        return;
      }

      clearResizeReplayState();
      this.wsRouter?.refreshReplaySnapshots(sessionId);
    }, effectiveDelayMs);
    timer.unref();
    this.pendingResizeRefreshTimers.set(sessionId, timer);
  }

  private captureDebugEvent(
    sessionId: string,
    source: SessionDebugCaptureEvent['source'],
    kind: string,
    details?: Record<string, SessionDebugCaptureValue>,
    rawPreview?: string,
  ): void {
    if (!this.isDebugCaptureEnabled(sessionId)) {
      return;
    }

    const event: SessionDebugCaptureEvent = {
      eventId: ++this.debugCaptureCounter,
      recordedAt: new Date().toISOString(),
      sessionId,
      source,
      kind,
      details,
      preview: rawPreview ? formatDebugPreview(rawPreview) : undefined,
    };

    const events = this.debugCaptureBySession.get(sessionId) ?? [];
    events.push(event);
    if (events.length > MAX_DEBUG_CAPTURE_EVENTS) {
      events.splice(0, events.length - MAX_DEBUG_CAPTURE_EVENTS);
    }
    this.debugCaptureBySession.set(sessionId, events);
  }
}

export const sessionManager = new SessionManager(undefined, {
  terminalResourcePolicyAuthority: terminalResourcePolicyRuntimeAuthority,
});

function clonePtyConfig(source: PTYConfig): PTYConfig {
  return {
    termName: source.termName,
    defaultCols: source.defaultCols,
    defaultRows: source.defaultRows,
    useConpty: source.useConpty,
    windowsPowerShellBackend: source.windowsPowerShellBackend ?? 'inherit',
    scrollbackLines: source.scrollbackLines,
    maxSnapshotBytes: source.maxSnapshotBytes,
    shell: source.shell,
  };
}

function cloneHeadlessResourceLimits(source: HeadlessResourceLimitsConfig): HeadlessResourceLimitsConfig {
  return {
    pendingOutputMaxBytes: source.pendingOutputMaxBytes,
    pendingOutputMaxChunks: source.pendingOutputMaxChunks,
    writeLagWarnMs: source.writeLagWarnMs,
    writeBatchMaxBytes: source.writeBatchMaxBytes,
    overflowPolicy: source.overflowPolicy,
  };
}

function createDeferredSignal<T>(): DeferredSignal<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function formatDebugPreview(raw: string): string {
  return raw
    .slice(0, DEBUG_CAPTURE_PREVIEW_CHARS)
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function formatWinptyProbeFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const childProcessError = error as {
      message?: string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: string | null;
      code?: string;
    };
    const stderr = childProcessError.stderr ? String(childProcessError.stderr).trim() : '';
    if (stderr) {
      return stderr;
    }
    if (childProcessError.status === 124 || childProcessError.signal === 'SIGTERM') {
      return 'winpty probe timed out while starting PowerShell';
    }
    if (childProcessError.code) {
      return `${childProcessError.code}${childProcessError.message ? `: ${childProcessError.message}` : ''}`;
    }
    if (childProcessError.message) {
      return childProcessError.message;
    }
  }
  return String(error);
}

function buildRawOutputDebugDetails(
  sessionData: SessionData,
  rawData: string,
  outputData: string,
  foundMarker: boolean,
): Record<string, SessionDebugCaptureValue> {
  const now = Date.now();
  const recentInputs = sessionData.echoTracker.recentInputs.filter((entry) => (now - entry.at) <= DEBUG_INPUT_CORRELATION_WINDOW_MS);
  sessionData.echoTracker.recentInputs = recentInputs;
  const newestInput = recentInputs.at(-1);
  const oldestInput = recentInputs[0];
  const derivedState = sessionData.derivedState ?? createInitialDerivedState();

  return {
    byteLength: Buffer.byteLength(rawData, 'utf8'),
    strippedByteLength: Buffer.byteLength(outputData, 'utf8'),
    detectionMode: sessionData.detectionMode,
    derivedOwnership: derivedState.ownership,
    derivedActivity: derivedState.activity,
    foregroundAppId: derivedState.foregroundAppId ?? null,
    detectorId: derivedState.detectorId ?? null,
    foundOsc133Marker: foundMarker,
    msSinceNewestInputSample: newestInput
      ? now - newestInput.at
      : null,
    msSinceOldestInputSample: oldestInput
      ? now - oldestInput.at
      : null,
    recentInputSampleCount: recentInputs.length,
    recentEnterSampleCount: recentInputs.filter((entry) => entry.hasEnter).length,
    recentInputSampleClasses: recentInputs.length > 0
      ? recentInputs.slice(-3).map((entry) => entry.inputClass).join(',')
      : null,
  };
}

function sanitizeDebugValues(
  details?: Record<string, string | number | boolean | null>,
): Record<string, SessionDebugCaptureValue> {
  return details ? { ...details } : {};
}

function isInteractiveAiAppId(value: string | undefined | null): value is ForegroundAppId {
  return value === 'hermes' || value === 'codex' || value === 'claude';
}

// FR-BGSTAB-020: Codex TUI 의 초당 다수 repaint(스피너/텍스트 반짝임) 발생원을 줄이기 위한
// tui 억제 설정. -c 플래그 최소개입 방식으로 codex 실행 명령에 주입한다.
const CODEX_TUI_SUPPRESSION_FLAGS = '-c tui.animations=false -c tui.alternate_screen="never" -c tui.show_tooltips=false';

/**
 * @req FR-BGSTAB-020
 * codex 실행 명령의 실행 토큰 직후에 tui 억제 -c 플래그를 삽입한다. 전역 옵션을 서브커맨드/인자
 * 앞에 두어 codex CLI 인자 파싱 순서를 보존한다.
 */
function injectCodexTuiSuppressionFlags(command: string): string {
  const trimmed = command.trimEnd();
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return `${trimmed} ${CODEX_TUI_SUPPRESSION_FLAGS}`;
  }
  const executable = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1);
  return `${executable} ${CODEX_TUI_SUPPRESSION_FLAGS} ${rest}`;
}

function detectForegroundAppHint(command: string): ForegroundAppId | null {
  const executable = getCommandExecutableToken(command);
  if (executable === 'hermes') {
    return 'hermes';
  }
  if (executable === 'codex') {
    return 'codex';
  }
  if (executable === 'claude' || executable === 'claude-code') {
    return 'claude';
  }

  return null;
}

function getCommandExecutableToken(command: string): string | null {
  return getRecoveryExecutableToken(command);
}

function stripInputTrackingControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function containsHistoryRecallControlSequence(raw: string): boolean {
  return /\x1b\[(?:A|B)/.test(raw);
}

function isLikelyCommandEchoOutput(raw: string, lastSubmittedCommand?: string, precomputedNormalized?: string): boolean {
  const normalizedLines = (precomputedNormalized ?? stripAndNormalizeTerminalOutput(raw))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalizedLines.length === 0) {
    return false;
  }

  for (const line of normalizedLines) {
    const directHint = detectForegroundAppHint(line);
    if (directHint) {
      return true;
    }

    const promptSplit = line.split(/[>$#]\s+/);
    const promptCandidate = promptSplit.length > 1 ? promptSplit.at(-1)?.trim() : null;
    if (promptCandidate && detectForegroundAppHint(promptCandidate)) {
      return true;
    }

    if (lastSubmittedCommand) {
      const normalizedCommand = lastSubmittedCommand.replace(/\s+/g, ' ').trim();
      if (line === normalizedCommand || line.endsWith(normalizedCommand)) {
        return true;
      }
    }
  }

  return false;
}

function isLikelyAiTuiLaunchFailureOutput(sessionData: SessionData, raw: string, precomputedNormalized?: string): boolean {
  const attempt = sessionData.aiTuiLaunchAttempt;
  if (!attempt) {
    return false;
  }

  if (Date.now() - attempt.startedAt > 2000) {
    return false;
  }

  const cleanedLines = (precomputedNormalized ?? stripAndNormalizeTerminalOutput(raw))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (cleanedLines.length === 0) {
    return false;
  }

  const candidates = getLaunchFailureExecutableCandidates(attempt);
  return cleanedLines.some((line) => candidates.some((candidate) => isAnchoredLaunchFailureLine(line, candidate)));
}

function getLaunchFailureExecutableCandidates(attempt: AiTuiLaunchAttempt): string[] {
  const candidates = new Set([attempt.executable, attempt.appId]);
  if (attempt.appId === 'claude') {
    candidates.add('claude-code');
  }
  return Array.from(candidates).filter(Boolean);
}

function isAnchoredLaunchFailureLine(line: string, executable: string): boolean {
  const escapedExecutable = escapeRegExp(executable);
  const executableWithPath = `(?:[^\\s:'"]*[\\\\/])?${escapedExecutable}(?:\\.(?:exe|cmd|bat|ps1))?`;
  const quotedExecutable = `['"\`]?${executableWithPath}['"\`]?`;

  const patterns = [
    new RegExp(`^(?:[^:]+:\\s*)?(?:line\\s+\\d+:\\s*)?${quotedExecutable}\\s*:\\s*command not found$`, 'i'),
    new RegExp(`^(?:[^:]+:\\s*)?(?:\\d+:\\s*)?${quotedExecutable}\\s*:\\s*not found$`, 'i'),
    new RegExp(`^(?:[^:]+:\\s*)?command not found:\\s*${quotedExecutable}$`, 'i'),
    new RegExp(`^${quotedExecutable}\\s*:\\s*no such file or directory$`, 'i'),
    new RegExp(`^${quotedExecutable}\\s*:\\s*the term\\s+['"\`]?${escapedExecutable}['"\`]?\\s+is not recognized`, 'i'),
    new RegExp(`^the term\\s+['"\`]?${escapedExecutable}['"\`]?\\s+is not recognized`, 'i'),
    new RegExp(`^${quotedExecutable}\\s+is not recognized as`, 'i'),
    new RegExp(`^cannot find\\s+${quotedExecutable}`, 'i'),
  ];

  return patterns.some((pattern) => pattern.test(line));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// PERF-BGSTAB-007: single shared strip -> \r\n?->\n normalization for the onData classification
// hot path. onData computes this once per output chunk and passes the result to the classification
// helpers so the multi-pass control-sequence strip runs once instead of once per helper.
function stripAndNormalizeTerminalOutput(raw: string): string {
  return stripTerminalControlSequences(raw).replace(/\r\n?/g, '\n');
}

function countNonEmptyLines(value: string): number {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

function matchesPendingTerminalDraftEcho(output: string, pendingInput: string): boolean {
  const normalizedPendingInput = pendingInput.replace(/\s+/g, ' ').trim();
  if (!normalizedPendingInput) return false;

  const nonEmptyOutputLines = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (nonEmptyOutputLines.length !== 1) return false;

  const outputLine = nonEmptyOutputLines[0];
  if (outputLine === normalizedPendingInput) return true;

  if (!outputLine.endsWith(normalizedPendingInput)) return false;

  const promptPrefix = outputLine.slice(0, -normalizedPendingInput.length);
  return /[>$#›]\s*$/u.test(promptPrefix);
}

function getPendingTerminalDraftPrefix(output: string, pendingInput: string | undefined): string | null {
  if (!pendingInput) return null;

  const outputLine = normalizeSingleTerminalOutputLine(output);
  const normalizedPendingInput = pendingInput.replace(/\s+/g, ' ').trim();
  if (!outputLine || !normalizedPendingInput || outputLine.length >= normalizedPendingInput.length) {
    return null;
  }

  return normalizedPendingInput.startsWith(outputLine) ? outputLine : null;
}

// @req MIG-BGSTAB-002
function matchUnsubmittedPrintableEcho(
  output: string,
  tracker: EchoTracker,
  allowsPartialPrefix: boolean,
): 'full' | 'prefix' | 'empty' | 'none' {
  const match = matchTrackedPrintableEcho(
    output,
    tracker.lastUnsubmittedPrintableInput,
    tracker.unsubmittedPrintableEchoPrefix,
    allowsPartialPrefix,
  );
  if (match.prefix) {
    tracker.unsubmittedPrintableEchoPrefix = match.prefix;
  } else if (match.result !== 'empty') {
    delete tracker.unsubmittedPrintableEchoPrefix;
  }
  return match.result;
}

// @req MIG-BGSTAB-002
function matchInterruptedUnsubmittedPrintableEcho(
  output: string,
  tracker: EchoTracker,
  allowsPartialPrefix: boolean,
): 'full' | 'prefix' | 'empty' | 'none' {
  const match = matchTrackedPrintableEcho(
    output,
    tracker.interruptedUnsubmittedPrintableInput,
    tracker.interruptedUnsubmittedPrintableEchoPrefix,
    allowsPartialPrefix,
  );
  if (match.result === 'full') {
    delete tracker.interruptedUnsubmittedPrintableInput;
    delete tracker.interruptedUnsubmittedPrintableEchoPrefix;
  } else if (match.prefix) {
    tracker.interruptedUnsubmittedPrintableEchoPrefix = match.prefix;
  } else if (match.result !== 'empty') {
    delete tracker.interruptedUnsubmittedPrintableEchoPrefix;
  }
  return match.result;
}

function matchTrackedPrintableEcho(
  output: string,
  pendingInput: EchoTracker['lastUnsubmittedPrintableInput'],
  prefix: string | undefined,
  allowsPartialPrefix: boolean,
): { result: 'full' | 'prefix' | 'empty' | 'none'; prefix?: string } {
  if (!pendingInput) return { result: 'none' };

  const outputLine = normalizeSingleTerminalOutputLine(output);
  if (!outputLine) return output.trim().length === 0
    ? { result: 'empty' }
    : { result: 'none' };

  if (matchesPendingTerminalDraftEcho(outputLine, pendingInput.value)) {
    return { result: 'full' };
  }

  const normalizedPendingInput = pendingInput.value.replace(/\s+/g, ' ').trim();
  if (allowsPartialPrefix && normalizedPendingInput.startsWith(outputLine)) {
    return { result: 'prefix', prefix: outputLine };
  }

  const candidate = `${prefix ?? ''}${outputLine}`;
  if (matchesPendingTerminalDraftEcho(candidate, pendingInput.value)) {
    return { result: 'full' };
  }

  if (allowsPartialPrefix && normalizedPendingInput.startsWith(candidate)) {
    return { result: 'prefix', prefix: candidate };
  }

  return { result: 'none' };
}

function normalizeSingleTerminalOutputLine(output: string): string | null {
  const nonEmptyOutputLines = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return nonEmptyOutputLines.length === 1 ? nonEmptyOutputLines[0] : null;
}

function hasTerminalRepaintControl(output: string): boolean {
  return output.includes('\x08')
    || /\x1b\[[0-?]*[ -/]*[ABCDEFGHJKdf]/u.test(output);
}

// @req MIG-BGSTAB-002
function isControlInterruptTuiPromptRepaint(output: string): boolean {
  return /^\x1b\[[0-9;]*K\r(?:\x1b\[\?25[hl])*›\s*$/u.test(output);
}

// @req MIG-BGSTAB-002
function isTerminalCursorVisibilityRepaint(output: string): boolean {
  return /^(?:\x1b\[(?:0)?m)*\x1b\[\?25[hl]$/u.test(output);
}

function containsAiTuiTerminalMotion(raw: string): boolean {
  return AI_TUI_CURSOR_MOTION_RE.test(raw) || /\x1b\[[0-9;]*m/.test(raw);
}

function hasAiTuiRepaintHint(raw: string): boolean {
  return raw.includes('\r')
    || raw.includes('\x1b[K')
    || raw.includes('\x1b[J')
    || containsAiTuiTerminalMotion(raw);
}
