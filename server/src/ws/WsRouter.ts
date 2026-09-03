/**
 * WebSocket Router
 * Step 8: SSE+HTTP -> WebSocket single channel migration
 *
 * Manages WebSocket connections, JWT authentication on upgrade,
 * message routing, ping/pong heartbeat, and session subscriptions.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createHash } from 'node:crypto';
import type { AuthService } from '../services/AuthService.js';
import type {
  RetainedTerminalMutationIdentity,
  SessionManager,
} from '../services/SessionManager.js';
import type {
  RealtimeConfig,
  ResourceLimitsConfig,
  ServerWsResourceLimitsConfig,
  StabilityModesConfig,
} from '../types/config.types.js';
import {
  stabilityModesSchema,
  wsResourceLimitsSchema,
} from '../schemas/config.schema.js';
import type {
  ClientWsMessage,
  InputDebugMetadata,
  InputRejectedReason,
  InputReliabilityMode,
  QueuedReplayInput,
  RetainedTerminalWireMutationIdentity,
  ReplayPendingState,
  ReplayTelemetryEvent,
  ReplayTelemetryEventInput,
  ScreenRepairBufferType,
  ScreenRepairFailedReason,
  ScreenRepairPendingState,
  ScreenRepairQueuedOutput,
  ScreenRepairReason,
  ScreenRepairRecoveryReason,
  ScreenRepairRejectedReason,
  ScreenRepairRequestMessage,
  TerminalCheckpointContinuityRebindMessage,
  WsClientMeta,
  WsRouterObservabilitySnapshot,
} from '../types/ws-protocol.js';
import {
  TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
  parseTerminalDeliveryAckMessage,
  parseTerminalDeliveryCapabilityMessage,
  parseTerminalDeliveryVisibilityMessage,
  parseTerminalCheckpointClientMessage,
} from '../types/ws-protocol.js';
import { buildInputDebugDetails, sanitizeClientInputDebugMetadata } from '../utils/inputDebugMetadata.js';
import { inputReliabilityMode as configuredInputReliabilityMode } from '../utils/inputReliabilityMode.js';
import {
  clearTransportMessages,
  createWsTransportMessage,
  createWsTransportQueueState,
  dequeueNextTransportMessage,
  getLastTerminalTransportMessage,
  getTransportMessagesInPriorityOrder,
  hasTransportQueuedMessages,
  isSupersededRepairTransportMessage,
  isSupersededRecoveryTransportMessage,
  isOutputBudgetMessage,
  peekNextTransportMessage,
  prependTransportMessage,
  pushTransportMessage,
  removeTransportMessages,
  replaceLastTerminalTransportMessage,
  tryCoalesceOutputMessage,
  type FairTerminalDelivery,
  type WsTransportMessage,
  type WsTransportQueueState,
} from './wsSendPolicy.js';
import { createFairTerminalDeliveryScheduler } from './wsSendPolicy.js';
import { wirePayloadByteLength } from './wirePayload.js';
import {
  createTerminalBinaryGroupSession,
  type SubscribedChannelFields,
  type TerminalBinaryGroupSession,
} from './terminalBinaryGroupSession.js';
import type { TerminalBinaryCapabilityOffer } from './terminalBinaryNegotiation.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';
import { truncateTerminalPayloadTail } from '../utils/terminalPayload.js';
import {
  createSessionInputGateway,
  INPUT_REJECTED_REPLAY_PENDING,
} from '../services/SessionInputGateway.js';
import type {
  TerminalResourcePolicyCanaryTarget,
  TerminalResourcePolicyLease,
  TerminalResourcePolicyLeaseAuthority,
  TerminalResourcePolicyLeaseGrant,
} from '../services/TerminalResourcePolicyCanary.js';
import { validatePublishedFairDeliveryCandidateArtifact } from '../services/TerminalResourcePolicyCanary.js';
import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';

const HEARTBEAT_INTERVAL = 30_000;
const REPLAY_ACK_TIMEOUT_MS = 5_000;
/**
 * Sampling schedule for a restore snapshot that is momentarily unavailable.
 *
 * The refusal is momentary — a write is mid-apply — so the answer is to sample
 * again. The early steps stay short so a settled session is not delayed; the
 * tail has to outlast a headless write, which three samples over 32ms did not:
 * a session driven by a redrawing TUI could miss all three and be reported to
 * the client as an error it reads as an exited shell. The ramp is bounded, so a
 * session that never settles is still reported.
 */
const RESTORE_AUTHORITY_RETRY_BACKOFFS_MS = [16, 16, 32, 64, 128, 256, 512] as const;
const RESTORE_AUTHORITY_MAX_RETRIES = RESTORE_AUTHORITY_RETRY_BACKOFFS_MS.length;

function restoreAuthorityRetryDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt - 1, RESTORE_AUTHORITY_RETRY_BACKOFFS_MS.length - 1));
  return RESTORE_AUTHORITY_RETRY_BACKOFFS_MS[index]!;
}
const SCREEN_REPAIR_ACK_TIMEOUT_MS = 5_000;
const MAX_RECENT_REPLAY_EVENTS = 256;
const MAX_REPLAY_QUEUED_INPUT_BYTES = 64 * 1024;
const MAX_REPLAY_QUEUED_INPUT_AGE_MS = 3_000;
const MAX_INPUT_SEQUENCE_SPAN = 1024;
const TRANSPORT_FLUSH_RETRY_MS = 25;

type WebSocketInputGatewayResult = {
  accepted: true;
} | {
  accepted: false;
  reason: InputRejectedReason;
};

type PartialResourceLimits = {
  [K in keyof ResourceLimitsConfig]?: Partial<ResourceLimitsConfig[K]>;
};

interface WsRouterOptions {
  inputReliabilityMode?: InputReliabilityMode;
  realtime?: Partial<RealtimeConfig>;
  resourceLimits?: PartialResourceLimits;
  stabilityModes?: Partial<StabilityModesConfig>;
  terminalResourcePolicyAuthority?: TerminalResourcePolicyLeaseAuthority;
  /**
   * The transport mode the operator configured. It answers only AC-7's
   * question of whether binary negotiation may open, and deliberately does not
   * feed `wsTransportMode` below: REL-BGSTAB-006 AC-5 leaves split runtime
   * inactive, so routing stays unified whatever this says.
   */
  binaryNegotiationTransportMode?: 'unified' | 'split-shadow' | 'split';
}

interface RuntimeSendPolicyConfig {
  mode: StabilityModesConfig['wsSendMode'];
  limits: ServerWsResourceLimitsConfig;
}

type InputValidationResult =
  | {
      ok: true;
      sessionId: string;
      data: string;
      metadata?: InputDebugMetadata;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      retainedIdentity?: RetainedTerminalWireMutationIdentity;
      byteLength: number;
    }
  | {
      ok: false;
      reason: 'invalid-payload' | 'invalid-sequence';
      sessionId?: string;
      data?: string;
      inputSeqStart?: number;
      inputSeqEnd?: number;
    };

type ReplaySnapshotMode = 'authoritative' | 'fallback';
type SnapshotReplayOrigin = 'subscribe' | 'repair' | 'degraded';

interface ReplaySnapshotMetadata {
  snapshotSeq: number;
  snapshotMode: ReplaySnapshotMode;
  snapshotDataLength: number;
  snapshotTruncated: boolean;
  snapshotCols: number;
  snapshotRows: number;
}

interface RefreshReplaySnapshotsOptions {
  startWhenReady?: boolean;
  origin?: 'refresh' | 'degraded';
  reason?: string;
}

type WsCanaryTarget = Extract<TerminalResourcePolicyCanaryTarget, { kind: 'ws' }>;

export interface TerminalResourcePolicyCanaryLedgerEntry {
  sequence: number;
  event: string;
  resource: TerminalResourcePolicyLease['resource'];
  consumer: TerminalResourcePolicyLease['consumer'];
  target: TerminalResourcePolicyCanaryTarget;
  policyGeneration: number;
  policyId: string;
  profileVersion: string;
  previousEffectiveDecision: number;
  nextEffectiveDecision: number;
  accepted: boolean;
  reason: string;
  rollbackResult: string | null;
}

interface WsCanaryState {
  target: WsCanaryTarget;
  mode: 'candidate' | 'legacy';
  policyGeneration: number;
  effectiveDecision: number;
  legacyAdmissionCount: number;
  rollbackState: 'inactive' | 'draining' | 'closed';
  rollbackAwaitGeneration?: number;
  rollbackPreviousDecision?: number;
  rollbackLease?: TerminalResourcePolicyLease;
  rollbackPendingMessages?: Set<WsTransportMessage>;
  activeLease?: TerminalResourcePolicyLease;
  totalEvents: number;
  droppedEntries: number;
  entries: TerminalResourcePolicyCanaryLedgerEntry[];
}

const MAX_RETAINED_TERMINAL_RESOURCE_POLICY_CANARY_STATES = 64;

interface SnapshotReplayOptions {
  queuedOutputChunks?: readonly ScreenRepairQueuedOutput[];
  preserveOutputChunkIdentity?: boolean;
  recoveryRepairToken?: string;
  supersedesReplayToken?: string;
  beforeSnapshot?: (state: ReplayPendingState) => void;
}

interface OutputAuthorityMetadata {
  authorityEpoch?: string;
  authorityRevision?: number;
}

export interface TerminalAuthorityResponderIdentity {
  sessionId: string;
  connectionId: string;
  viewGeneration: number;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  boundarySourceSeq: string;
  responderLeaseId: string;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  driverLeaseGeneration: string;
  acceptedViewAttributesGeneration: string;
}

export interface TerminalAuthorityQueryReplyIngress {
  handle(
    socketMeta: { connectionId: string },
    message: unknown,
  ): {
    handled: boolean;
    accepted: boolean;
    reason?: string;
    ptyWriteAttempted?: boolean;
    ptyWriteCount?: number;
    effectCommitted?: boolean;
    duplicatePtyReplyCount?: number;
  };
}

export interface TerminalAuthorityViewRegistration {
  sessionId: string;
  clientId: string;
  connectionId: string;
  viewGeneration: number;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  authorityStreamEpoch: string;
  driverLeaseGeneration: string;
  acceptedViewAttributesGeneration: string;
}

export interface TerminalAuthorityViewReadyRegistration extends TerminalAuthorityViewRegistration {
  reason: 'new-view' | 'generation-changed' | 'authority-generation-changed' | 'recovery-acknowledged';
}

export interface TerminalAuthorityAttachedViewContext {
  connectionId: string;
  viewGeneration: number | null;
  capable: boolean;
}

export interface TerminalAuthorityCanarySessionContext {
  sessionId: string;
  attachedViews: readonly TerminalAuthorityAttachedViewContext[];
  capableViews: readonly TerminalAuthorityViewRegistration[];
  allAttachedViewsCapable: boolean;
  replayRepairIdle: boolean;
}

export interface TerminalAuthorityCanaryConnectionContext {
  connectionId: string;
  channelRole: 'control';
  subscribedSessions: readonly TerminalAuthorityCanarySessionContext[];
}

interface TerminalAuthorityConnectionContext {
  ok: true;
  requestedMode: 'unified' | 'split-shadow' | 'split';
  channelRole: 'control' | 'output';
  clientGroupId?: string;
  pairToken?: string;
}

interface SplitClientGroup {
  clientGroupId: string;
  connectionId: string;
  pairToken: string;
  pairTokenExpiresAt: number;
  mode: 'split-shadow' | 'split';
  control: WebSocket;
  output?: WebSocket;
}

function isCanonicalAuthorityOrdinal(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameTerminalAuthorityResponderIdentity(
  actual: Record<string, unknown>,
  expected: TerminalAuthorityResponderIdentity,
): boolean {
  return actual.sessionId === expected.sessionId
    && actual.connectionId === expected.connectionId
    && actual.viewGeneration === expected.viewGeneration
    && actual.transitionEpoch === expected.transitionEpoch
    && actual.authorityEpoch === expected.authorityEpoch
    && actual.streamEpoch === expected.streamEpoch
    && actual.boundarySourceSeq === expected.boundarySourceSeq
    && actual.responderLeaseId === expected.responderLeaseId
    && actual.queryReplyCapability === expected.queryReplyCapability
    && actual.parserResponderCapability === expected.parserResponderCapability
    && actual.driverLeaseGeneration === expected.driverLeaseGeneration
    && actual.acceptedViewAttributesGeneration === expected.acceptedViewAttributesGeneration;
}

// @req MIG-BGSTAB-002 AC-2
export function routeTerminalAuthorityFrame(input: {
  mode: 'unified' | 'split-shadow' | 'split';
  controlTransport: WsTransportQueueState;
  outputTransport: WsTransportQueueState;
  message: object;
}): { socketRole: 'unified' | 'output' } {
  const selected = input.mode === 'unified' ? input.controlTransport : input.outputTransport;
  pushTransportMessage(selected, createWsTransportMessage(input.message));
  return { socketRole: input.mode === 'unified' ? 'unified' : 'output' };
}

// @req MIG-BGSTAB-002 AC-3
export function createTerminalQueryReplyIngress(options: {
  readExpectedIdentity: (sessionId: string) => TerminalAuthorityResponderIdentity | null;
  writeTerminalQueryReply: (input: {
    data: string;
    identity: TerminalAuthorityResponderIdentity;
    replyOrdinal: number;
  }) => { accepted: boolean; duplicate?: boolean; reason?: string } | void;
  writeInput: (sessionId: string, data: string) => void;
  observeSemanticInput: (sessionId: string, data: string) => void;
  isTerminalQueryReply: (data: string, options: { provenance: 'parser-generated' }) => boolean;
}): TerminalAuthorityQueryReplyIngress {
  return {
    handle(socketMeta, message) {
      if (!isRecordValue(message) || message.type !== 'input' || message.inputKind !== 'query-reply') {
        return { handled: false, accepted: false };
      }
      const sessionId = message.sessionId;
      const data = message.data;
      const replyOrdinal = message.replyOrdinal;
      const identity = message.responderIdentity;
      if (
        typeof sessionId !== 'string'
        || sessionId.length === 0
        || typeof data !== 'string'
        || data.length === 0
        || Object.prototype.hasOwnProperty.call(message, 'connectionId')
        || !Number.isSafeInteger(replyOrdinal)
        || (replyOrdinal as number) < 0
        || !isRecordValue(identity)
        || typeof identity.connectionId !== 'string'
        || identity.connectionId.length === 0
        || !Number.isSafeInteger(identity.viewGeneration)
        || (identity.viewGeneration as number) < 0
        || !isCanonicalAuthorityOrdinal(identity.transitionEpoch)
        || !isCanonicalAuthorityOrdinal(identity.streamEpoch)
        || !isCanonicalAuthorityOrdinal(identity.boundarySourceSeq)
        || typeof identity.authorityEpoch !== 'string'
        || identity.authorityEpoch.length === 0
        || typeof identity.responderLeaseId !== 'string'
        || identity.responderLeaseId.length === 0
        || !isCanonicalAuthorityOrdinal(identity.driverLeaseGeneration)
        || !isCanonicalAuthorityOrdinal(identity.acceptedViewAttributesGeneration)
        || identity.queryReplyCapability !== 'terminal.query-reply-input.v1'
        || identity.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
        || !options.isTerminalQueryReply(data, { provenance: 'parser-generated' })
      ) {
        return { handled: true, accepted: false, reason: 'invalid-query-reply' };
      }
      const expected = options.readExpectedIdentity(sessionId);
      if (identity.connectionId !== socketMeta.connectionId
        || !expected
        || !sameTerminalAuthorityResponderIdentity(identity, expected)) {
        return { handled: true, accepted: false, reason: 'stale-responder-identity' };
      }
      const committed = options.writeTerminalQueryReply({
        data,
        identity: expected,
        replyOrdinal: replyOrdinal as number,
      });
      if (!isRecordValue(committed) || typeof committed.accepted !== 'boolean') {
        return { handled: true, accepted: true };
      }
      const actual = committed;
      const duplicate = actual.accepted && actual.duplicate === true;
      return {
        handled: true,
        accepted: actual.accepted,
        ...(actual.reason ? { reason: actual.reason } : {}),
        ptyWriteAttempted: actual.accepted && !duplicate,
        ptyWriteCount: actual.accepted && !duplicate ? 1 : 0,
        effectCommitted: actual.accepted,
        duplicatePtyReplyCount: duplicate ? 1 : 0,
      };
    },
  };
}

function utf8ByteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8');
}

/**
 * Narrow authority port for a continuity rebind. The record and checkpoint
 * are server material, never reconstructed from the browser's claim.
 */
export interface TerminalAuthorityContinuityRecord {
  sessionId: string;
  connectionId: string;
  viewGeneration: number;
  visibilityGeneration: string;
  lastDeliveredSeq: string;
  streamEpoch: string;
  checkpointEpoch: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  retentionPolicyId: string;
  expiresAt: number;
}

export interface TerminalAuthorityFullCheckpoint {
  streamEpoch: string;
  checkpointEpoch: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  retentionPolicyId: string;
  geometry: { cols: number; rows: number };
  modes: Readonly<Record<string, boolean>>;
  chunks: readonly {
    sequence: number;
    chunkIndex: number;
    chunkCount: number;
    encoding: 'base64';
    data: string;
    encodedBytes: number;
  }[];
  digest: { algorithm: 'sha256'; hex: string };
  parserTail: { encoding: 'base64'; data: string; encodedBytes: number };
  tailOnly: false;
}

export interface TerminalAuthorityFreshCheckpoint {
  continuity: TerminalAuthorityContinuityRecord;
  fullCheckpoint: TerminalAuthorityFullCheckpoint;
}

function isTerminalAuthorityContinuityRecord(
  value: unknown,
): value is TerminalAuthorityContinuityRecord {
  if (!isRecordValue(value)
    || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || typeof value.connectionId !== 'string' || value.connectionId.length === 0
    || typeof value.viewGeneration !== 'number'
    || !Number.isSafeInteger(value.viewGeneration) || value.viewGeneration < 0
    || !isCanonicalAuthorityOrdinal(value.visibilityGeneration)
    || !isCanonicalAuthorityOrdinal(value.lastDeliveredSeq)
    || !isCanonicalAuthorityOrdinal(value.streamEpoch)
    || !isCanonicalAuthorityOrdinal(value.checkpointEpoch)
    || !isCanonicalAuthorityOrdinal(value.snapshotSeq)
    || !isCanonicalAuthorityOrdinal(value.oldestRetainedSeq)
    || typeof value.retentionPolicyId !== 'string' || value.retentionPolicyId.length === 0
    || typeof value.expiresAt !== 'number'
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) {
    return false;
  }
  return true;
}

interface TerminalDeliveryVisibilityState {
  visibilityGeneration: bigint;
  visibilityGenerationWire: string;
  isVisible: boolean;
  deliveryInterestRefCount: number;
  dataGapLatched: boolean;
}

interface TerminalDeliveryCheckpointLedger {
  checkpointEpoch: string;
  settledThroughSeq: number;
  queued: number;
  inFlight: number;
  late: number;
  invalidated: number;
  active: boolean;
  settled: boolean;
}

export class WsRouter {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, WsClientMeta> = new Map();
  private readonly terminalAuthorityTransportBindings = new WeakMap<WebSocket, string>();
  private sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionManager: SessionManager;
  private authService: AuthService;
  private replayAckTimeoutCount = 0;
  private screenRepairAckTimeoutCount = 0;
  private replayRefreshCount = 0;
  private maxReplayQueueLengthObserved = 0;
  private replayEventCounter = 0;
  private sessionOutputChunkOrdinals = new Map<string, bigint>();
  private recentReplayEvents: ReplayTelemetryEvent[] = [];
  private debugReplayEventsBySession: Map<string, ReplayTelemetryEvent[]> = new Map();
  private debugReplayEnabledSessions: Set<string> = new Set();
  private readonly inputReliabilityMode: InputReliabilityMode;
  private readonly runtimeSendPolicyConfig: RuntimeSendPolicyConfig;
  private transportQueues: Map<WebSocket, WsTransportQueueState> = new Map();
  private maxTransportQueuedBytesObserved = 0;
  private maxServerBufferedAmountObserved = 0;
  private transportBackpressureObserveCount = 0;
  private transportSlowClientCloseCount = 0;
  private transportQueueOverflowCount = 0;
  private transportSendErrorCount = 0;
  /**
   * Frames the server could not decode (`06 §S3`). A warning alone is still a
   * silent drop as far as the system is concerned — nothing can gate on it —
   * and `05:176` makes reaching zero a condition for opening the shadow rung.
   */
  private undecodableFrameCount = 0;
  private transportOutputCoalesceCount = 0;
  private restoreAuthorityRetryKeys = new Set<string>();
  private readonly terminalResourcePolicyAuthority?: TerminalResourcePolicyLeaseAuthority;
  private readonly terminalResourcePolicyCanaryStates = new Map<string, WsCanaryState>();
  private readonly fairDeliverySchedulers = new Map<WebSocket, {
    connectionEpoch: string;
    scheduler: ReturnType<typeof createFairTerminalDeliveryScheduler>;
    maintenanceTimer: NodeJS.Timeout;
  }>();
  private readonly fairDeliveryEpochGenerations = new Map<WebSocket, number>();
  private readonly terminalResourcePolicyCanaryRegistries = {
    targetHandles: new Set<string>(),
    listeners: new Set<string>(),
    timers: new Set<string>(),
  };
  private terminalResourcePolicyPrunedLedgerCount = 0;
  private readonly inFlightTransportMessages = new Map<WebSocket, WsTransportMessage>();
  private readonly policyRollbackDrainSockets = new Set<WebSocket>();
  private readonly terminalResourcePolicyAdmissionDrainSockets = new Set<WebSocket>();
  private transportPolicyGeneration = 0;
  private readonly wsTransportMode: 'unified' | 'split-shadow' | 'split';
  private readonly binaryNegotiationTransportMode: 'unified' | 'split-shadow' | 'split';
  private readonly terminalWireFormat: TerminalWireFormat;
  /** One binary session per connection group (`01 §3.2` — the group agrees as a whole). */
  private readonly terminalBinaryGroups = new Map<string, TerminalBinaryGroupSession>();
  private readonly splitClientGroups = new Map<string, SplitClientGroup>();
  private readonly splitSocketGroups = new Map<WebSocket, SplitClientGroup>();
  private terminalAuthorityQueryReplyIngress: TerminalAuthorityQueryReplyIngress | null = null;
  private terminalAuthorityClientFrameHandler: ((input: {
    connectionId: string;
    clientId: string;
    channelRole: 'control' | 'output';
    message: Record<string, unknown>;
  }) => boolean) | null = null;
  private terminalAuthorityTopologyObserver: ((input: {
    sessionId: string;
    kind: 'new-view' | 'generation-changed' | 'subscription-ready' | 'disconnect' | 'unsubscribe'
      | 'output-paired' | 'output-unpaired' | 'output-replaced';
    connectionId: string;
    viewGeneration: number;
  }) => void) | null = null;
  private terminalAuthorityViewReadyObserver: ((
    input: TerminalAuthorityViewReadyRegistration,
  ) => void) | null = null;
  private terminalAuthorityViewModeReader: ((
    input: TerminalAuthorityViewRegistration,
  ) => 'legacy' | 'checkpoint') | null = null;
  private terminalAuthorityStreamEpochReader: ((sessionId: string) => string | null) | null = null;
  private terminalAuthorityViewAttributesChallengeReader: ((input: {
    sessionId: string;
    clientId: string;
    connectionId: string;
    viewGeneration: number;
  }) => string | null) | null = null;
  private terminalAuthorityFreshCheckpointReader: ((input: {
    sessionId: string;
    clientId: string;
    connectionId: string;
  }) => TerminalAuthorityFreshCheckpoint | null) | null = null;
  private readonly terminalDeliveryVisibilityBySocket = new Map<
    WebSocket,
    Map<string, TerminalDeliveryVisibilityState>
  >();
  private readonly terminalDeliveryCheckpointLedgers = new Map<
    WebSocket,
    Map<string, TerminalDeliveryCheckpointLedger>
  >();

  constructor(authService: AuthService, sessionManager: SessionManager, options: WsRouterOptions = {}) {
    this.authService = authService;
    this.sessionManager = sessionManager;
    this.inputReliabilityMode = options.inputReliabilityMode ?? configuredInputReliabilityMode;
    this.wsTransportMode = options.realtime?.wsTransportMode ?? 'unified';
    this.binaryNegotiationTransportMode = options.binaryNegotiationTransportMode ?? 'unified';
    this.terminalWireFormat = options.realtime?.terminalWireFormat ?? 'json';
    this.terminalResourcePolicyAuthority = options.terminalResourcePolicyAuthority;
    this.runtimeSendPolicyConfig = {
      mode: stabilityModesSchema.parse(options.stabilityModes).wsSendMode,
      limits: cloneServerWsResourceLimits(wsResourceLimitsSchema.parse(options.resourceLimits?.ws)),
    };
    this.wss = new WebSocketServer({ noServer: true });

    this.setupConnectionHandler();
    this.startHeartbeat();

    console.log('[WS] WebSocket router initialized');
  }

  // @req MIG-BGSTAB-002 AC-2 AC-3 AC-5
  public installTerminalAuthorityHooks(input: {
    queryReplyIngress: TerminalAuthorityQueryReplyIngress;
    onClientFrame: (input: {
      connectionId: string;
      clientId: string;
      channelRole: 'control' | 'output';
      message: Record<string, unknown>;
    }) => boolean;
    onTopologyChanged: (input: {
      sessionId: string;
      kind: 'new-view' | 'generation-changed' | 'subscription-ready' | 'disconnect' | 'unsubscribe'
        | 'output-paired' | 'output-unpaired' | 'output-replaced';
      connectionId: string;
      viewGeneration: number;
    }) => void;
    onViewAuthorityReady?: (input: TerminalAuthorityViewReadyRegistration) => void;
    readViewAuthorityMode?: (
      input: TerminalAuthorityViewRegistration,
    ) => 'legacy' | 'checkpoint';
    readViewAuthorityStreamEpoch?: (sessionId: string) => string | null;
    readViewAttributesChallengeId?: (input: {
      sessionId: string;
      clientId: string;
      connectionId: string;
      viewGeneration: number;
    }) => string | null;
    readFreshAuthoritativeCheckpoint?: (input: {
      sessionId: string;
      clientId: string;
      connectionId: string;
    }) => TerminalAuthorityFreshCheckpoint | null;
  }): () => void {
    this.terminalAuthorityQueryReplyIngress = input.queryReplyIngress;
    this.terminalAuthorityClientFrameHandler = input.onClientFrame;
    this.terminalAuthorityTopologyObserver = input.onTopologyChanged;
    this.terminalAuthorityViewReadyObserver = input.onViewAuthorityReady ?? null;
    this.terminalAuthorityViewModeReader = input.readViewAuthorityMode ?? null;
    this.terminalAuthorityStreamEpochReader = input.readViewAuthorityStreamEpoch ?? null;
    this.terminalAuthorityViewAttributesChallengeReader = input.readViewAttributesChallengeId ?? null;
    this.terminalAuthorityFreshCheckpointReader = input.readFreshAuthoritativeCheckpoint ?? null;
    return () => {
      if (this.terminalAuthorityQueryReplyIngress === input.queryReplyIngress) {
        this.terminalAuthorityQueryReplyIngress = null;
      }
      if (this.terminalAuthorityClientFrameHandler === input.onClientFrame) {
        this.terminalAuthorityClientFrameHandler = null;
      }
      if (this.terminalAuthorityTopologyObserver === input.onTopologyChanged) {
        this.terminalAuthorityTopologyObserver = null;
      }
      if (this.terminalAuthorityViewReadyObserver === input.onViewAuthorityReady) {
        this.terminalAuthorityViewReadyObserver = null;
      }
      if (this.terminalAuthorityViewModeReader === input.readViewAuthorityMode) {
        this.terminalAuthorityViewModeReader = null;
      }
      if (this.terminalAuthorityStreamEpochReader === input.readViewAuthorityStreamEpoch) {
        this.terminalAuthorityStreamEpochReader = null;
      }
      if (this.terminalAuthorityViewAttributesChallengeReader === input.readViewAttributesChallengeId) {
        this.terminalAuthorityViewAttributesChallengeReader = null;
      }
      if (this.terminalAuthorityFreshCheckpointReader === input.readFreshAuthoritativeCheckpoint) {
        this.terminalAuthorityFreshCheckpointReader = null;
      }
    };
  }

  public getTerminalAuthorityResponderViews(sessionId: string): readonly TerminalAuthorityViewRegistration[] {
    const views: TerminalAuthorityViewRegistration[] = [];
    const newestOpenControls = new Map<string, WebSocket>();
    for (const [ws, meta] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && meta.channelRole !== 'output') {
        newestOpenControls.set(meta.connectionId ?? meta.clientId, ws);
      }
    }
    for (const [ws, meta] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN || meta.channelRole === 'output') continue;
      const connectionId = meta.connectionId ?? meta.clientId;
      if (newestOpenControls.get(connectionId) !== ws) continue;
      const terminalLaneReady = meta.wsTransportMode !== 'split'
        || this.splitSocketGroups.get(ws)?.output?.readyState === WebSocket.OPEN;
      if (!terminalLaneReady) continue;
      if (!meta.subscribedSessions.has(sessionId)) continue;
      const registration = meta.terminalAuthorityViewRegistrations?.get(sessionId);
      if (
        !registration
        || registration.queryReplyCapability !== 'terminal.query-reply-input.v1'
        || registration.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
        || !registration.authorityStreamEpoch
        || !registration.driverLeaseGeneration
        || !registration.acceptedViewAttributesGeneration
        || registration.driverLeaseGeneration !== registration.authorityStreamEpoch
        || registration.acceptedViewAttributesGeneration !== registration.authorityStreamEpoch
      ) {
        continue;
      }
      const projectedAuthorityStreamEpoch = this.terminalAuthorityStreamEpochReader?.(sessionId);
      const authorityStreamEpoch = isCanonicalAuthorityOrdinal(projectedAuthorityStreamEpoch)
        ? projectedAuthorityStreamEpoch
        : registration.authorityStreamEpoch;
      views.push({
        sessionId,
        clientId: meta.clientId,
        connectionId,
        viewGeneration: registration.viewGeneration,
        queryReplyCapability: registration.queryReplyCapability,
        parserResponderCapability: registration.parserResponderCapability,
        authorityStreamEpoch,
        driverLeaseGeneration: authorityStreamEpoch,
        acceptedViewAttributesGeneration: authorityStreamEpoch,
      });
    }
    return views;
  }

  // @req MIG-BGSTAB-002 AC-3
  // Attribute freshness belongs to the authenticated control registration.
  // Delivery/promotion still uses getTerminalAuthorityResponderViews, whose
  // split-output readiness gate deliberately remains stricter.
  public getTerminalAuthorityNegotiatedView(
    sessionId: string,
    connectionId: string,
    viewGeneration: number,
  ): TerminalAuthorityViewRegistration | null {
    return this.getTerminalAuthorityNegotiatedViews(sessionId).find(view => (
      view.connectionId === connectionId && view.viewGeneration === viewGeneration
    )) ?? null;
  }

  public getTerminalAuthorityDeliveryVisibility(
    sessionId: string,
    connectionId: string,
    viewGeneration: number,
  ): { visibilityGeneration: string } | null {
    if (!this.getTerminalAuthorityNegotiatedView(sessionId, connectionId, viewGeneration)) return null;
    for (const [ws, meta] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN
        || meta.channelRole === 'output'
        || (meta.connectionId ?? meta.clientId) !== connectionId
        || meta.terminalAuthorityViewRegistrations?.get(sessionId)?.viewGeneration !== viewGeneration) {
        continue;
      }
      const visibility = this.terminalDeliveryVisibilityBySocket.get(ws)?.get(sessionId);
      if (!visibility || !isCanonicalAuthorityOrdinal(visibility.visibilityGenerationWire)) return null;
      return { visibilityGeneration: visibility.visibilityGenerationWire };
    }
    return null;
  }

  public getTerminalAuthorityNegotiatedViews(
    sessionId: string,
  ): readonly TerminalAuthorityViewRegistration[] {
    const views: TerminalAuthorityViewRegistration[] = [];
    const newestOpenControls = new Map<string, WebSocket>();
    for (const [ws, meta] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && meta.channelRole !== 'output') {
        newestOpenControls.set(meta.connectionId ?? meta.clientId, ws);
      }
    }
    for (const [ws, meta] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN || meta.channelRole === 'output') continue;
      const connectionId = meta.connectionId ?? meta.clientId;
      if (newestOpenControls.get(connectionId) !== ws || !meta.subscribedSessions.has(sessionId)) continue;
      const registration = meta.terminalAuthorityViewRegistrations?.get(sessionId);
      if (
        !registration
        || registration.queryReplyCapability !== 'terminal.query-reply-input.v1'
        || registration.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
        || !registration.authorityStreamEpoch
        || !registration.driverLeaseGeneration
        || !registration.acceptedViewAttributesGeneration
        || registration.driverLeaseGeneration !== registration.authorityStreamEpoch
        || registration.acceptedViewAttributesGeneration !== registration.authorityStreamEpoch
      ) continue;
      const projected = this.terminalAuthorityStreamEpochReader?.(sessionId);
      const authorityStreamEpoch = isCanonicalAuthorityOrdinal(projected)
        ? projected
        : registration.authorityStreamEpoch;
      views.push({
        sessionId,
        clientId: meta.clientId,
        connectionId,
        viewGeneration: registration.viewGeneration,
        queryReplyCapability: registration.queryReplyCapability,
        parserResponderCapability: registration.parserResponderCapability,
        authorityStreamEpoch,
        driverLeaseGeneration: authorityStreamEpoch,
        acceptedViewAttributesGeneration: authorityStreamEpoch,
      });
    }
    return views;
  }

  public listTerminalAuthorityResponderViews(sessionId: string): readonly TerminalAuthorityViewRegistration[] {
    return this.getTerminalAuthorityResponderViews(sessionId);
  }

  /**
   * Derives the limited-promotion candidate set from the authenticated control
   * connection. A client-supplied session id is deliberately not accepted by
   * this API: subscription and negotiated view state remain server authority.
   *
   * @req MIG-BGSTAB-002 AC-1 AC-2
   */
  public getTerminalAuthorityCanaryContext(
    connectionId: string,
  ): TerminalAuthorityCanaryConnectionContext | null {
    const newestOpenControls = new Map<string, WebSocket>();
    for (const [ws, meta] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && meta.channelRole !== 'output') {
        newestOpenControls.set(meta.connectionId ?? meta.clientId, ws);
      }
    }
    const attachedControlEntries = [...this.clients.entries()].filter(([ws, meta]) => (
      meta.channelRole !== 'output'
      && newestOpenControls.get(meta.connectionId ?? meta.clientId) === ws
    ));
    const requester = attachedControlEntries.find(([, meta]) => (
      (meta.connectionId ?? meta.clientId) === connectionId
    ))?.[1];
    if (!requester) return null;

    const subscribedSessions = [...requester.subscribedSessions].map(sessionId => {
      const attachedViews: TerminalAuthorityAttachedViewContext[] = [];
      for (const [controlSocket, meta] of attachedControlEntries) {
        if (!meta.subscribedSessions.has(sessionId)) continue;
        const registration = meta.terminalAuthorityViewRegistrations?.get(sessionId);
        const terminalLaneReady = meta.wsTransportMode === 'unified'
          || this.splitSocketGroups.get(controlSocket)?.output?.readyState === WebSocket.OPEN;
        attachedViews.push({
          connectionId: meta.connectionId ?? meta.clientId,
          viewGeneration: registration?.viewGeneration ?? null,
            capable: terminalLaneReady
            && registration?.queryReplyCapability === 'terminal.query-reply-input.v1'
            && registration.parserResponderCapability === 'terminal.parser-responder-disable.v1'
            && typeof registration.authorityStreamEpoch === 'string'
            && typeof registration.driverLeaseGeneration === 'string'
            && typeof registration.acceptedViewAttributesGeneration === 'string'
            && registration.driverLeaseGeneration === registration.authorityStreamEpoch
            && registration.acceptedViewAttributesGeneration === registration.authorityStreamEpoch,
        });
      }
      const capableViews = this.getTerminalAuthorityResponderViews(sessionId);
      const replayRepairIdle = attachedControlEntries.every(([, meta]) => (
        !meta.subscribedSessions.has(sessionId)
        || (!meta.replayPendingSessions.has(sessionId)
          && !meta.screenRepairPendingSessions.has(sessionId))
      ));
      return {
        sessionId,
        attachedViews,
        capableViews,
        allAttachedViewsCapable: attachedViews.length > 0
          && attachedViews.every(view => view.capable)
          && capableViews.length === attachedViews.length,
        replayRepairIdle,
      };
    });
    return { connectionId, channelRole: 'control', subscribedSessions };
  }

  /**
   * Replaces an unacknowledged legacy bootstrap replay with the fresh server
   * checkpoint used by authority promotion. This is allowed only when no
   * queued input, truncation, or screen-repair transaction would be lost.
   * The retained headless write chain is settled by the caller first, so any
   * queued output is already covered by the authoritative checkpoint.
   *
   * @req MIG-BGSTAB-002 AC-1 AC-2 AC-4
   */
  public supersedeTerminalAuthorityBootstrapReplay(sessionId: string): {
    ok: boolean;
    reason?: string;
    supersededViewCount: number;
  } {
    const attached = [...this.clients.entries()].filter(([, meta]) => (
      meta.channelRole !== 'output' && meta.subscribedSessions.has(sessionId)
    ));
    for (const [, meta] of attached) {
      if (meta.screenRepairPendingSessions.has(sessionId)) {
        return { ok: false, reason: 'screen-repair-active', supersededViewCount: 0 };
      }
      const pending = meta.replayPendingSessions.get(sessionId);
      if (!pending) continue;
      if (pending.queuedInputs.length > 0
        || pending.queuedInputBytes > 0
        || pending.queuedOutputTruncated) {
        return { ok: false, reason: 'replay-has-uncovered-work', supersededViewCount: 0 };
      }
    }
    let supersededViewCount = 0;
    for (const [, meta] of attached) {
      const pending = meta.replayPendingSessions.get(sessionId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      meta.replayPendingSessions.delete(sessionId);
      supersededViewCount += 1;
      this.recordReplayEvent({
        kind: 'snapshot_refresh_skipped',
        sessionId,
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
        details: { reason: 'server-authority-checkpoint-superseded-bootstrap-replay' },
      });
    }
    return { ok: true, supersededViewCount };
  }

  /**
   * Reissues the current authoritative legacy snapshot after the retained
   * headless model was deliberately replaced (for example by a bounded
   * no-cache parity fixture). Promotion must wait for the browser to ACK this
   * exact model; preserving an ACK for the superseded model would be unsafe.
   *
   * The caller settles the retained write chain first. Consequently queued
   * output already covered by this snapshot may be replaced, while queued
   * input, truncation, and active repair remain fail-closed.
   *
   * @req MIG-BGSTAB-002 AC-1 AC-4
   */
  public refreshTerminalAuthorityServerRecovery(sessionId: string): {
    ok: boolean;
    reason?: string;
    refreshedViewCount: number;
  } {
    const attached = [...this.clients.entries()].filter(([, meta]) => (
      meta.channelRole !== 'output' && meta.subscribedSessions.has(sessionId)
    ));
    if (attached.length === 0) {
      return { ok: false, reason: 'server-recovery-view-unavailable', refreshedViewCount: 0 };
    }
    const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
    if (!snapshot || snapshot.health !== 'healthy' || snapshot.truncated) {
      return { ok: false, reason: 'server-recovery-snapshot-unavailable', refreshedViewCount: 0 };
    }
    // Recovery evidence belongs to the exact authoritative headless model
    // that produced its replay token. A configured retained-range fixture can
    // replace that model while the browser keeps the same logical view. Drop
    // the per-connection evidence before reissuing the snapshot so a later
    // checkpoint negotiation cannot backfill the superseded model's ACK into
    // the new SessionManager runtime.
    for (const [, meta] of attached) {
      meta.terminalAuthorityRecoveryEvidence?.delete(sessionId);
    }
    const toRefresh: Array<[WebSocket, WsClientMeta]> = [];
    for (const entry of attached) {
      const [, meta] = entry;
      if (meta.screenRepairPendingSessions.has(sessionId)) {
        return { ok: false, reason: 'screen-repair-active', refreshedViewCount: 0 };
      }
      const pending = meta.replayPendingSessions.get(sessionId);
      if (pending && (
        pending.queuedInputs.length > 0
        || pending.queuedInputBytes > 0
        || pending.queuedOutputTruncated
      )) {
        return { ok: false, reason: 'replay-has-uncovered-work', refreshedViewCount: 0 };
      }
      if (pending?.snapshotSeq !== snapshot.seq) {
        toRefresh.push(entry);
      }
    }
    if (toRefresh.length > 0) {
      const selectedEntry = attached.map(([, meta]) => ({
        meta,
        registration: meta.terminalAuthorityViewRegistrations?.get(sessionId),
      })).find(entry => (
        entry.registration?.queryReplyCapability === 'terminal.query-reply-input.v1'
        && entry.registration.parserResponderCapability === 'terminal.parser-responder-disable.v1'
      ));
      const selectedRegistration = selectedEntry?.registration;
      const projectedAuthorityStreamEpoch = this.terminalAuthorityStreamEpochReader?.(sessionId);
      const authorityStreamEpoch = isCanonicalAuthorityOrdinal(projectedAuthorityStreamEpoch)
        ? projectedAuthorityStreamEpoch
        : selectedRegistration?.authorityStreamEpoch;
      const viewAttributesChallengeId = this.terminalAuthorityViewAttributesChallengeReader?.({
        sessionId,
        clientId: selectedEntry?.meta.clientId ?? '',
        connectionId: selectedEntry?.meta.connectionId ?? selectedEntry?.meta.clientId ?? '',
        viewGeneration: selectedRegistration?.viewGeneration ?? -1,
      });
      if (!selectedEntry
        || !selectedRegistration
        || !isCanonicalAuthorityOrdinal(authorityStreamEpoch)
        || typeof viewAttributesChallengeId !== 'string'
        || viewAttributesChallengeId.length === 0) {
        return { ok: false, reason: 'server-recovery-capable-view-unavailable', refreshedViewCount: 0 };
      }
      const selected = {
        clientId: selectedEntry.meta.clientId,
        connectionId: selectedEntry.meta.connectionId ?? selectedEntry.meta.clientId,
        viewGeneration: selectedRegistration.viewGeneration,
        queryReplyCapability: selectedRegistration.queryReplyCapability,
        parserResponderCapability: selectedRegistration.parserResponderCapability,
        authorityStreamEpoch,
        driverLeaseGeneration: authorityStreamEpoch,
        acceptedViewAttributesGeneration: authorityStreamEpoch,
        viewAttributesChallengeId,
      };
      const mutationLease = this.sessionManager.establishRetainedTerminalMutationLease(
        sessionId,
        selected.clientId,
        selected.viewGeneration,
      );
      if (!mutationLease.ok) {
        return {
          ok: false,
          reason: mutationLease.reason ?? 'server-recovery-mutation-lease-unavailable',
          refreshedViewCount: 0,
        };
      }
      this.sendTerminalAuthorityFrameToConnection(selected.connectionId, {
        type: 'terminal-checkpoint:capability',
        protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
        accepted: true,
        authorityMode: 'legacy',
        checkpointDeliveryActive: false,
        ordinalEncoding: 'canonical-uint64-decimal',
        digestAlgorithms: ['sha256'],
        registeredViews: [{
          sessionId,
          viewGeneration: selected.viewGeneration,
          queryReplyCapability: selected.queryReplyCapability,
          parserResponderCapability: selected.parserResponderCapability,
          authorityStreamEpoch: selected.authorityStreamEpoch,
          driverLeaseGeneration: selected.driverLeaseGeneration,
          acceptedViewAttributesGeneration: selected.acceptedViewAttributesGeneration,
          viewAttributesChallengeId: selected.viewAttributesChallengeId,
        }],
        mutationLeases: [{
          sessionId,
          authorityEpoch: mutationLease.authorityEpoch,
          viewGeneration: mutationLease.viewGeneration,
          leaseGeneration: mutationLease.leaseGeneration,
        }],
      }, 'control');
    }
    for (const [ws] of toRefresh) {
      this.sendSnapshotReplay(ws, sessionId, snapshot, 'repair');
    }
    return { ok: true, refreshedViewCount: toRefresh.length };
  }

  public enqueueTerminalAuthorityMessage(
    sessionId: string,
    message: object,
    lane: 'control' | 'terminal' = 'terminal',
  ): number {
    let sent = 0;
    for (const view of this.getTerminalAuthorityResponderViews(sessionId)) {
      if (this.sendTerminalAuthorityFrameToConnection(view.connectionId, message, lane).sent) {
        sent += 1;
      }
    }
    return sent;
  }

  public sendTerminalAuthorityFrameToConnection(
    connectionId: string,
    message: object,
    lane: 'control' | 'terminal' = 'terminal',
    onSettled?: (error?: Error) => void,
    expectedTransportBindingId?: string,
  ): {
    sent: boolean;
    socketRole: 'unified' | 'control' | 'output';
    transportBindingId?: string;
  } {
    // A hard reload can leave the closing control socket in the registry for
    // one event-loop turn while the replacement has already registered with
    // the same logical connection id. Prefer the newest OPEN socket so an ACK
    // is never written to the stale predecessor.
    const controlEntry = [...this.clients.entries()].reverse().find(([ws, meta]) => (
      ws.readyState === WebSocket.OPEN
      && meta.channelRole !== 'output'
      && (meta.connectionId ?? meta.clientId) === connectionId
    ));
    if (!controlEntry) {
      onSettled?.(new Error('terminal-authority-control-connection-missing'));
      return { sent: false, socketRole: 'control' };
    }
    const [control, meta] = controlEntry;
    const group = this.splitSocketGroups.get(control);
    if (lane === 'terminal'
      && meta.wsTransportMode !== 'unified'
      && group?.output?.readyState !== WebSocket.OPEN) {
      onSettled?.(new Error('terminal-authority-output-lane-unavailable'));
      return { sent: false, socketRole: 'control' };
    }
    const target = lane === 'terminal' && group?.output?.readyState === WebSocket.OPEN
      ? group.output
      : control;
    const transportBindingId = this.getTerminalAuthorityTransportBindingId(target);
    if (expectedTransportBindingId && expectedTransportBindingId !== transportBindingId) {
      onSettled?.(new Error('terminal-authority-transport-binding-replaced'));
      return {
        sent: false,
        socketRole: target === control
          ? (meta.wsTransportMode === 'unified' ? 'unified' : 'control')
          : 'output',
        transportBindingId,
      };
    }
    const sent = this.sendTo(target, message, onSettled, {
      connectionId,
      lane,
      bindingId: transportBindingId,
    });
    return {
      sent,
      socketRole: target === control
        ? (meta.wsTransportMode === 'unified' ? 'unified' : 'control')
        : 'output',
      transportBindingId,
    };
  }

  private getTerminalAuthorityTransportBindingId(ws: WebSocket): string {
    const existing = this.terminalAuthorityTransportBindings.get(ws);
    if (existing) return existing;
    const bindingId = uuidv4();
    this.terminalAuthorityTransportBindings.set(ws, bindingId);
    return bindingId;
  }

  private notifyTerminalAuthorityTransportBindingReplaced(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    if (!meta) return;
    const group = this.splitSocketGroups.get(ws);
    const control = meta.channelRole === 'output' ? group?.control : ws;
    const controlMeta = control ? this.clients.get(control) : undefined;
    if (!controlMeta) return;
    const connectionId = controlMeta.connectionId ?? controlMeta.clientId;
    for (const [sessionId, viewGeneration] of controlMeta.retainedTerminalViews ?? []) {
      this.terminalAuthorityTopologyObserver?.({
        sessionId,
        kind: 'output-replaced',
        connectionId,
        viewGeneration,
      });
    }
  }

  updateRuntimeConfig(next: {
    resourceLimits?: PartialResourceLimits;
    stabilityModes?: Partial<StabilityModesConfig>;
  }): void {
    const previousMode = this.runtimeSendPolicyConfig.mode;
    if (next.resourceLimits?.ws) {
      this.runtimeSendPolicyConfig.limits = cloneServerWsResourceLimits(wsResourceLimitsSchema.parse({
        ...this.runtimeSendPolicyConfig.limits,
        ...next.resourceLimits.ws,
      }));
    }
    if (next.stabilityModes?.wsSendMode) {
      if (next.stabilityModes.wsSendMode !== this.runtimeSendPolicyConfig.mode) {
        this.transportPolicyGeneration += 1;
      }
      this.runtimeSendPolicyConfig.mode = stabilityModesSchema.parse({
        wsSendMode: next.stabilityModes.wsSendMode,
      }).wsSendMode;
    }
    if (previousMode === 'safe-send-enforce' && this.runtimeSendPolicyConfig.mode !== 'safe-send-enforce') {
      for (const [ws, state] of this.transportQueues) {
        this.policyRollbackDrainSockets.add(ws);
        if (!state.sending) this.drainTransportQueueForPolicyRollback(ws);
      }
    }
  }

  // @req REL-BGSTAB-010
  activateTerminalResourcePolicyLease(input: {
    lease: TerminalResourcePolicyLease;
  }): { mode: 'candidate' | 'legacy'; reason: string } {
    const resolved = this.resolveCurrentWsLease(input.lease);
    if (!resolved.ok) return { mode: 'legacy', reason: resolved.reason };
    if (!this.findSocketForCanaryTarget(resolved.grant.lease.target as WsCanaryTarget)) {
      return { mode: 'legacy', reason: 'stale-target-lease' };
    }
    const target = resolved.grant.lease.target as WsCanaryTarget;
    const state = this.getOrCreateWsCanaryState(target);
    if (state.rollbackState === 'draining') {
      return { mode: 'legacy', reason: 'rollback-draining' };
    }
    const previousDecision = state.effectiveDecision;
    state.mode = 'candidate';
    state.policyGeneration += 1;
    state.effectiveDecision = resolved.grant.decision;
    state.rollbackState = 'inactive';
    state.rollbackAwaitGeneration = undefined;
    state.rollbackPreviousDecision = undefined;
    state.rollbackLease = undefined;
    state.activeLease = resolved.grant.lease;
    this.terminalResourcePolicyCanaryRegistries.targetHandles.add(this.canaryTargetKey(target));
    this.appendWsCanaryLedger(state, resolved.grant.lease, {
      event: 'candidate-selected',
      previousEffectiveDecision: previousDecision,
      nextEffectiveDecision: resolved.grant.decision,
      accepted: true,
      reason: 'candidate-selected',
      rollbackResult: null,
    });
    return { mode: 'candidate', reason: 'candidate-selected' };
  }

  // @req REL-BGSTAB-010
  rollbackTerminalResourcePolicyLease(input: {
    lease: TerminalResourcePolicyLease;
  }): { state: 'draining' | 'closed'; reason: string } {
    const resolved = this.resolveCurrentWsLease(input.lease);
    if (!resolved.ok) {
      return { state: 'closed', reason: resolved.reason };
    }
    const target = resolved.grant.lease.target as WsCanaryTarget;
    const state = this.terminalResourcePolicyCanaryStates.get(this.canaryTargetKey(target));
    if (
      !state
      || state.mode !== 'candidate'
      || state.rollbackState !== 'inactive'
      || state.activeLease !== resolved.grant.lease
    ) {
      return { state: 'closed', reason: 'lease-not-active' };
    }
    const previousDecision = state.effectiveDecision;
    const candidateGeneration = state.policyGeneration;
    state.rollbackPendingMessages = this.captureWsRollbackBoundary(target);
    state.mode = 'legacy';
    state.policyGeneration += 1;
    state.effectiveDecision = this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes;
    state.rollbackState = 'draining';
    state.rollbackAwaitGeneration = candidateGeneration;
    state.rollbackPreviousDecision = previousDecision;
    state.rollbackLease = resolved.grant.lease;
    state.activeLease = undefined;
    this.terminalResourcePolicyAuthority?.revokeTarget(target);
    for (const [event, reason, rollbackResult] of [
      ['rollback-requested', 'rollback-requested', 'requested'],
      ['rollback-draining', 'rollback-draining', 'draining'],
    ] as const) {
      this.appendWsCanaryLedger(state, resolved.grant.lease, {
        event,
        previousEffectiveDecision: previousDecision,
        nextEffectiveDecision: state.effectiveDecision,
        accepted: true,
        reason,
        rollbackResult,
      });
    }
    if (!this.hasPendingWsRollbackBoundary(target, state)) {
      this.closeWsCanaryRollback(state);
      return { state: 'closed', reason: 'rollback-closed' };
    }
    return { state: 'draining', reason: 'rollback-draining' };
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyCanaryState(target: WsCanaryTarget): {
    mode: 'candidate' | 'legacy';
    policyGeneration: number;
    effectiveDecision: number;
    queuedBytes: number;
    ledgerHash: string;
    legacyAdmissionCount: number;
    rollbackState: 'inactive' | 'draining' | 'closed';
    cleanup: { targetHandles: number; listeners: number; timers: number };
  } {
    const state = this.getOrCreateWsCanaryState(target);
    const targetKey = this.canaryTargetKey(target);
    const ws = this.findSocketForCanaryTarget(target);
    const queue = ws ? this.transportQueues.get(ws) : undefined;
    const entries = state.entries.map(entry => ({ ...entry, target: { ...entry.target } }));
    return {
      mode: state.mode,
      policyGeneration: state.policyGeneration,
      effectiveDecision: state.effectiveDecision,
      queuedBytes: queue?.outputBytes ?? 0,
      ledgerHash: createHash('sha256').update(JSON.stringify({
        totalEvents: state.totalEvents,
        droppedEntries: state.droppedEntries,
        entries,
      })).digest('hex'),
      legacyAdmissionCount: state.legacyAdmissionCount,
      rollbackState: state.rollbackState,
      cleanup: {
        targetHandles: this.terminalResourcePolicyCanaryRegistries.targetHandles.has(targetKey) ? 1 : 0,
        listeners: this.terminalResourcePolicyCanaryRegistries.listeners.has(targetKey) ? 1 : 0,
        timers: this.terminalResourcePolicyCanaryRegistries.timers.has(targetKey) ? 1 : 0,
      },
    };
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyCanaryCleanupTelemetry(): {
    activeTargetHandles: number;
    retainedLedgerCount: number;
    retainedLedgerCapacity: number;
    prunedLedgerCount: number;
  } {
    return Object.freeze({
      activeTargetHandles: this.terminalResourcePolicyCanaryRegistries.targetHandles.size,
      retainedLedgerCount: this.terminalResourcePolicyCanaryStates.size,
      retainedLedgerCapacity: MAX_RETAINED_TERMINAL_RESOURCE_POLICY_CANARY_STATES,
      prunedLedgerCount: this.terminalResourcePolicyPrunedLedgerCount,
    });
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyCanaryLedger(input: { lease: TerminalResourcePolicyLease }): {
    denied?: boolean;
    reason?: string;
    capacity: number;
    totalEvents: number;
    droppedEntries: number;
    entries: readonly Readonly<TerminalResourcePolicyCanaryLedgerEntry>[];
  } {
    const resolved = this.resolveCurrentWsLease(input.lease, false);
    if (!resolved.ok) return this.freezeDeniedCanaryLedger(resolved.reason);
    const target = resolved.grant.lease.target as WsCanaryTarget;
    if (!this.findSocketForCanaryTarget(target)) {
      return this.freezeDeniedCanaryLedger('stale-target-lease');
    }
    const state = this.getOrCreateWsCanaryState(target);
    const entries = state.entries.map(entry => Object.freeze({
      ...entry,
      target: Object.freeze(structuredClone(entry.target)),
    }));
    return Object.freeze({
      capacity: 8,
      totalEvents: state.totalEvents,
      droppedEntries: state.droppedEntries,
      entries: Object.freeze(entries),
    });
  }

  // @req REL-BGSTAB-010
  previewTerminalResourcePolicyCanaryAdmission(input: {
    lease: TerminalResourcePolicyLease;
    incomingMessage: WsTransportMessage;
  }): {
    accepted: boolean;
    mode: 'candidate' | 'legacy';
    reason: string;
    resource: 'resourceLimits.ws.perClientOutputQueueMaxBytes';
    consumer: 'server.ws.router';
    target: WsCanaryTarget;
    queueOwner: 'ws-router';
    queuedSessionIds: string[];
    queuedBytes: number;
    computedIncomingBytes: number;
    projectedBytes: number;
    policyGeneration: number;
  } {
    const target = input.lease.target as WsCanaryTarget;
    const existingState = this.terminalResourcePolicyCanaryStates.get(this.canaryTargetKey(target));
    const base = {
      resource: 'resourceLimits.ws.perClientOutputQueueMaxBytes' as const,
      consumer: 'server.ws.router' as const,
      target,
      queueOwner: 'ws-router' as const,
      queuedSessionIds: [] as string[],
      queuedBytes: 0,
      computedIncomingBytes: wirePayloadByteLength(input.incomingMessage.payload),
      projectedBytes: 0,
      policyGeneration: existingState?.policyGeneration ?? 0,
    };
    const resolved = this.resolveCurrentWsLease(input.lease);
    if (!resolved.ok) return { ...base, accepted: false, mode: 'legacy', reason: resolved.reason };
    const ws = this.findSocketForCanaryTarget(target);
    if (!ws) return { ...base, accepted: false, mode: 'legacy', reason: 'stale-target-lease' };
    if (
      !existingState
      || existingState.mode !== 'candidate'
      || existingState.rollbackState !== 'inactive'
      || existingState.activeLease !== resolved.grant.lease
    ) {
      return { ...base, accepted: false, mode: 'legacy', reason: 'lease-not-active' };
    }
    const queued = this.transportQueues.get(ws);
    const messages = queued ? getTransportMessagesInPriorityOrder(queued) : [];
    const sessions = [...new Set(messages.flatMap(message => (
      message.kind === 'output' && message.sessionId ? [message.sessionId] : []
    )))];
    for (const message of messages) {
      if (wirePayloadByteLength(message.payload) !== message.byteLength) {
        return {
          ...base, queuedSessionIds: sessions,
          queuedBytes: messages.reduce((sum, entry) => sum + entry.byteLength, 0),
          accepted: false, mode: 'legacy', reason: 'tampered-queued-message-byte-length',
        };
      }
    }
    const incomingBytes = wirePayloadByteLength(input.incomingMessage.payload);
    const queuedBytes = messages.reduce((sum, message) => sum + message.byteLength, 0);
    const projectedBytes = queuedBytes + incomingBytes;
    const state = existingState;
    const exactBase = {
      ...base,
      queuedSessionIds: sessions,
      queuedBytes,
      computedIncomingBytes: incomingBytes,
      projectedBytes,
      policyGeneration: state.policyGeneration,
    };
    if (incomingBytes !== input.incomingMessage.byteLength) {
      return { ...exactBase, accepted: false, mode: 'legacy', reason: 'tampered-message-byte-length' };
    }
    if (projectedBytes > resolved.grant.decision) {
      return {
        ...exactBase, accepted: true, mode: 'legacy', reason: 'candidate-cap-exceeded-fallback',
      };
    }
    return { ...exactBase, accepted: true, mode: 'candidate', reason: 'candidate-admission-accepted' };
  }

  // @req REL-BGSTAB-010
  admitTerminalResourcePolicyCanaryMessage(input: {
    lease: TerminalResourcePolicyLease;
    incomingMessage: WsTransportMessage;
  }) {
    const preview = this.previewTerminalResourcePolicyCanaryAdmission(input);
    const resolved = this.resolveCurrentWsLease(input.lease);
    if (!resolved.ok) {
      return {
        accepted: false,
        mode: 'legacy' as const,
        reason: resolved.reason,
        enqueuedExactlyOnce: false,
      };
    }
    if (!preview.accepted) {
      if (preview.reason === 'lease-not-active') {
        return { ...preview, enqueuedExactlyOnce: false };
      }
      if (resolved.ok) {
        const state = this.getOrCreateWsCanaryState(resolved.grant.lease.target as WsCanaryTarget);
        this.appendWsCanaryLedger(state, resolved.grant.lease, {
          event: 'admission-rejected',
          previousEffectiveDecision: state.effectiveDecision,
          nextEffectiveDecision: state.effectiveDecision,
          accepted: false,
          reason: preview.reason,
          rollbackResult: null,
        });
      }
      return { ...preview, enqueuedExactlyOnce: false };
    }
    const ws = this.findSocketForCanaryTarget(resolved.grant.lease.target as WsCanaryTarget);
    if (!ws) return { ...preview, accepted: false, enqueuedExactlyOnce: false };
    const state = this.getOrCreateWsCanaryState(resolved.grant.lease.target as WsCanaryTarget);
    const queue = this.getTransportQueueState(ws);
    const entryToken = `trp-entry-${resolved.grant.metadata.issuanceSequence}-${state.totalEvents + 1}`;
    const admitted = {
      ...input.incomingMessage,
      policyGeneration: state.policyGeneration,
      policyAdmissionMode: preview.mode,
      exactlyOnceKey: input.incomingMessage.exactlyOnceKey ?? entryToken,
    };
    const enqueued = this.enqueueTransportMessage(
      ws,
      queue,
      admitted,
      preview.mode === 'candidate'
        ? resolved.grant.decision
        : this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes,
      false,
    );
    if (!enqueued) {
      this.appendWsCanaryLedger(state, resolved.grant.lease, {
        event: 'admission-rejected',
        previousEffectiveDecision: state.effectiveDecision,
        nextEffectiveDecision: state.effectiveDecision,
        accepted: false,
        reason: 'legacy-output-queue-overflow',
        rollbackResult: null,
      });
      this.settleTerminalResourcePolicyTargetOnSendFailure(ws, 'legacy-output-queue-overflow');
      if (this.runtimeSendPolicyConfig.mode === 'safe-send-enforce') {
        this.closeBackpressuredClient(ws, 'output-queue-overflow');
      }
      return {
        ...preview,
        accepted: false,
        mode: 'legacy' as const,
        reason: 'legacy-output-queue-overflow',
        enqueuedExactlyOnce: false,
      };
    }
    if (preview.mode === 'legacy') state.legacyAdmissionCount += 1;
    this.appendWsCanaryLedger(state, resolved.grant.lease, {
      event: 'admission-accepted',
      previousEffectiveDecision: state.effectiveDecision,
      nextEffectiveDecision: state.effectiveDecision,
      accepted: true,
      reason: preview.reason,
      rollbackResult: null,
    });
    if (this.runtimeSendPolicyConfig.mode !== 'safe-send-enforce') {
      this.terminalResourcePolicyAdmissionDrainSockets.add(ws);
      if (!queue.sending) this.drainTerminalResourcePolicyAdmissionQueue(ws);
    }
    return { ...preview, entryToken, enqueuedExactlyOnce: true };
  }

  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const result = this.authService.verifyToken(token);
    if (!result.valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const requested = url.searchParams.get('wsTransportMode');
      const requestedMode = requested === 'split' || requested === 'split-shadow' || requested === 'unified'
        ? requested
        : this.wsTransportMode;
      const channel = url.searchParams.get('channel');
      const channelRole = channel === 'output' ? 'output' : 'control';
      const connectionContext: TerminalAuthorityConnectionContext = {
        ok: true,
        requestedMode,
        channelRole,
        ...(url.searchParams.get('clientGroupId')
          ? { clientGroupId: url.searchParams.get('clientGroupId') ?? undefined }
          : {}),
        ...(url.searchParams.get('pairToken')
          ? { pairToken: url.searchParams.get('pairToken') ?? undefined }
          : {}),
      };
      this.wss.emit('connection', ws, req, result.payload, connectionContext);
    });
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', ((
      ws: WebSocket,
      _req: IncomingMessage,
      _authPayload?: unknown,
      requestedContext?: TerminalAuthorityConnectionContext,
    ) => {
      const context: TerminalAuthorityConnectionContext = requestedContext?.ok === true
        ? requestedContext
        : {
            ok: true,
            requestedMode: this.wsTransportMode,
            channelRole: 'control',
          };
      const requestedMode = context.requestedMode;
      if (context.channelRole === 'output') {
        const group = context.clientGroupId ? this.splitClientGroups.get(context.clientGroupId) : undefined;
        if (
          !group
          || requestedMode === 'unified'
          || context.pairToken !== group.pairToken
          || group.pairTokenExpiresAt < Date.now()
        ) {
          ws.close(1008, 'invalid-output-pair');
          if (group && group.pairTokenExpiresAt < Date.now()) {
            this.forgetSplitClientGroup(group.clientGroupId);
          }
          return;
        }
        if (group.output && group.output !== ws && group.output.readyState === WebSocket.OPEN) {
          const controlMeta = this.clients.get(group.control);
          for (const [sessionId, viewGeneration] of controlMeta?.retainedTerminalViews ?? []) {
            this.terminalAuthorityTopologyObserver?.({
              sessionId,
              kind: 'output-replaced',
              connectionId: group.connectionId,
              viewGeneration,
            });
          }
          group.output.close(1012, 'output-replaced');
        }
        group.output = ws;
        this.splitSocketGroups.set(ws, group);
        const outputMeta: WsClientMeta = {
          clientId: group.clientGroupId,
          connectionId: group.connectionId,
          clientGroupId: group.clientGroupId,
          channelRole: 'output',
          wsTransportMode: group.mode,
          isAlive: true,
          subscribedSessions: new Set(),
          replayPendingSessions: new Map(),
          screenRepairPendingSessions: new Map(),
          retainedTerminalViews: new Map(),
          terminalAuthorityViewRegistrations: new Map(),
        };
        this.clients.set(ws, outputMeta);
        this.sendTo(ws, {
          type: 'connected',
          clientId: group.clientGroupId,
          connectionId: group.connectionId,
          clientGroupId: group.clientGroupId,
          wsTransportMode: group.mode,
          channel: 'output',
        });
        const pairedControlMeta = this.clients.get(group.control);
        for (const [sessionId, viewGeneration] of pairedControlMeta?.retainedTerminalViews ?? []) {
          this.terminalAuthorityTopologyObserver?.({
            sessionId,
            kind: 'output-paired',
            connectionId: group.connectionId,
            viewGeneration,
          });
        }
        ws.on('pong', () => { outputMeta.isAlive = true; });
        ws.on('message', (raw: Buffer | string) => {
          try {
            this.handleMessage(ws, raw);
          } catch (error) {
            this.handleMessageError(ws, raw, error);
          }
        });
        ws.on('close', () => {
          if (group.output === ws) {
            group.output = undefined;
            const controlMeta = this.clients.get(group.control);
            for (const [sessionId, viewGeneration] of controlMeta?.retainedTerminalViews ?? []) {
              this.terminalAuthorityTopologyObserver?.({
                sessionId,
                kind: 'output-unpaired',
                connectionId: group.connectionId,
                viewGeneration,
              });
            }
          }
          this.splitSocketGroups.delete(ws);
          this.clients.delete(ws);
          this.clearTransportQueueState(ws);
        });
        ws.on('error', (err) => console.error(`[WS] Output client error (${group.clientGroupId}):`, err.message));
        return;
      }

      const connectionId = uuidv4();
      const clientGroupId = requestedMode === 'unified' ? connectionId : uuidv4();
      const clientId = clientGroupId;
      const meta: WsClientMeta = {
        clientId,
        connectionId,
        clientGroupId,
        channelRole: 'control',
        wsTransportMode: requestedMode,
        isAlive: true,
        subscribedSessions: new Set(),
        replayPendingSessions: new Map(),
        screenRepairPendingSessions: new Map(),
        retainedTerminalViews: new Map(),
        terminalAuthorityViewRegistrations: new Map(),
      };
      this.clients.set(ws, meta);

      let splitGroup: SplitClientGroup | undefined;
      if (requestedMode !== 'unified') {
        splitGroup = {
          clientGroupId,
          connectionId,
          pairToken: uuidv4(),
          pairTokenExpiresAt: Date.now() + 30_000,
          mode: requestedMode,
          control: ws,
        };
        this.splitClientGroups.set(clientGroupId, splitGroup);
        this.splitSocketGroups.set(ws, splitGroup);
      }
      this.sendTo(ws, {
        type: 'connected',
        clientId,
        connectionId,
        clientGroupId,
        wsTransportMode: requestedMode,
        channel: 'control',
        ...(splitGroup
          ? {
              pairToken: splitGroup.pairToken,
              pairTokenExpiresAt: splitGroup.pairTokenExpiresAt,
            }
          : {}),
      });
      console.log(`[WS] Client connected: ${clientId}`);

      ws.on('pong', () => {
        const current = this.clients.get(ws);
        if (current) current.isAlive = true;
      });

      ws.on('message', (raw: Buffer | string) => {
        try {
          this.handleMessage(ws, raw);
        } catch (error) {
          this.handleMessageError(ws, raw, error);
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
        const group = this.splitSocketGroups.get(ws);
        if (group?.control === ws) {
          group.output?.close(1001, 'control-closed');
          this.forgetSplitClientGroup(group.clientGroupId);
        }
        this.splitSocketGroups.delete(ws);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Client error (${clientId}):`, err.message);
      });
    }) as never);
  }

  private handleMessage(ws: WebSocket, raw: Buffer | string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      this.undecodableFrameCount += 1;
      console.warn('[WS] Invalid JSON received');
      return;
    }

    if (!isRecord(msg) || typeof msg.type !== 'string') {
      console.warn('[WS] Invalid message shape received');
      return;
    }

    if (msg.type.startsWith('terminal-authority:')) {
      const meta = this.clients.get(ws);
      if (
        meta
        && meta.channelRole !== 'output'
        && this.terminalAuthorityClientFrameHandler?.({
          connectionId: meta.connectionId ?? meta.clientId,
          clientId: meta.clientId,
          channelRole: meta.channelRole ?? 'control',
          message: msg,
        })
      ) {
        return;
      }
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(ws, (msg as Extract<ClientWsMessage, { type: 'subscribe' }>).sessionIds);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(ws, (msg as Extract<ClientWsMessage, { type: 'unsubscribe' }>).sessionIds);
        break;
      case 'screen-snapshot:ready':
        this.handleScreenSnapshotReady(
          ws,
          (msg as Extract<ClientWsMessage, { type: 'screen-snapshot:ready' }>).sessionId,
          (msg as Extract<ClientWsMessage, { type: 'screen-snapshot:ready' }>).replayToken,
        );
        break;
      case 'screen-repair':
        void this.handleScreenRepairRequest(ws, msg).catch((error) => {
          console.error('[WS] Screen repair request failed:', error);
        });
        break;
      case 'screen-repair:ready':
        {
          const repairReady = msg as unknown as Extract<ClientWsMessage, { type: 'screen-repair:ready' }>;
        this.handleScreenRepairReady(
          ws,
          repairReady.sessionId,
          repairReady.repairToken,
        );
        }
        break;
      case 'screen-repair:failed':
        {
          const repairFailed = msg as unknown as Extract<ClientWsMessage, { type: 'screen-repair:failed' }>;
        this.handleScreenRepairFailed(
          ws,
          repairFailed.sessionId,
          repairFailed.repairToken,
          repairFailed.reason,
        );
        }
        break;
      case 'input':
        this.handleInput(ws, msg);
        break;
      case 'repair-replay':
        {
          const repairReplay = msg as Extract<ClientWsMessage, { type: 'repair-replay' }>;
          this.handleRepairReplay(
            ws,
            repairReplay.sessionId,
            repairReplay.supersedeReplayToken,
            repairReplay.repairToken,
          );
        }
        break;
      case 'resize':
        this.handleResize(ws, msg as Extract<ClientWsMessage, { type: 'resize' }>);
        break;
      case 'terminal-checkpoint:negotiate':
      case 'terminal-checkpoint:apply-ack':
      case 'terminal-checkpoint:drain-ack':
      case 'terminal-checkpoint:failure-ack':
        this.handleTerminalCheckpointClientMessage(ws, msg);
        break;
      case 'terminal-binary:capability':
        this.handleTerminalBinaryCapability(ws, msg);
        break;
      case 'terminal-binary:unknown-channel':
        this.handleTerminalBinaryUnknownChannel(ws, msg);
        break;
      case 'terminal-delivery:ack':
        this.handleTerminalDeliveryAck(ws, msg);
        break;
      case 'terminal-delivery:capability':
        this.handleTerminalDeliveryCapability(ws, msg);
        break;
      case 'terminal-delivery:visibility':
        this.handleTerminalDeliveryVisibility(ws, msg);
        break;
      case 'terminal-delivery:checkpoint-start':
        this.handleTerminalDeliveryCheckpointStart(ws, msg);
        break;
      case 'terminal-delivery:checkpoint-invalidate':
        this.handleTerminalDeliveryCheckpointInvalidate(ws, msg);
        break;
      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        break;
      default:
        if (msg.type.startsWith('terminal-checkpoint:')) {
          this.handleTerminalCheckpointClientMessage(ws, msg);
        } else {
          console.warn(`[WS] Unknown message type: ${(msg as { type: string }).type}`);
        }
    }
  }

  /**
   * The group's binary session, created on first use. Keyed by group rather
   * than by socket because terminal payload can fall back from the output
   * socket to the control socket (`FR-BGSTAB-007` AC-3/AC-4), and a per-socket
   * codec would make that fallback undecodable.
   */
  /**
   * Drops everything keyed by a connection group when that group is torn down.
   * The two stores are removed together on purpose: a surviving binary session
   * would keep handing out channel ids for a group that no longer exists.
   */
  private forgetSplitClientGroup(clientGroupId: string): void {
    this.splitClientGroups.delete(clientGroupId);
    this.terminalBinaryGroups.delete(clientGroupId);
  }

  private terminalBinaryGroupKey(ws: WebSocket): string | undefined {
    const meta = this.clients.get(ws);
    return meta ? meta.clientGroupId ?? meta.clientId : undefined;
  }

  /** The group's session if one exists. Never creates: see `ensureTerminalBinaryGroup`. */
  private terminalBinaryGroupFor(ws: WebSocket): TerminalBinaryGroupSession | undefined {
    const key = this.terminalBinaryGroupKey(ws);
    return key === undefined ? undefined : this.terminalBinaryGroups.get(key);
  }

  /**
   * Creates the group's session. Only the offer handler calls this, so a client
   * that never speaks binary never allocates one — which is every client on the
   * default rung.
   */
  private ensureTerminalBinaryGroup(ws: WebSocket): TerminalBinaryGroupSession | undefined {
    const meta = this.clients.get(ws);
    if (!meta) return undefined;
    const key = meta.clientGroupId ?? meta.clientId;
    const existing = this.terminalBinaryGroups.get(key);
    if (existing) return existing;
    // AC-7 allows binary only on `unified` and calls the setting a kill switch.
    // The query parameter is the client speaking, so a client that omits it must
    // not reach a wider eligibility than the operator configured; both the
    // configured mode and the connection's own have to be unified.
    const configured = this.binaryNegotiationTransportMode;
    const created = createTerminalBinaryGroupSession({
      now: () => Date.now(),
      wireFormat: this.terminalWireFormat,
      transportMode: configured === 'unified' ? (meta.wsTransportMode ?? this.wsTransportMode) : configured,
    });
    this.terminalBinaryGroups.set(key, created);
    return created;
  }

  /** The channel fields a `subscribed` row carries once the group speaks binary. */
  private terminalBinaryChannelFor(ws: WebSocket, sessionId: string): SubscribedChannelFields {
    const group = this.terminalBinaryGroupFor(ws);
    if (!group?.isNegotiated) return {};
    // Both epochs come from the same authority state so the row cannot pair a
    // stream with an authority that never carried it.
    const authority = this.sessionManager.getTerminalAuthorityState?.(sessionId);
    if (!authority) return {};
    return group.openChannel({
      sessionId,
      streamEpoch: authority.streamEpoch,
      authorityEpoch: authority.authorityEpoch,
    });
  }

  /**
   * Tells the client a channel is gone (`01 §1.5`). Sent before the id can be
   * reissued so a late frame is refused rather than delivered to whoever holds
   * the number next.
   */
  private retireTerminalBinaryChannels(
    ws: WebSocket,
    sessionId: string,
    reason: 'unsubscribed' | 'session-exited' | 'session-deleted',
  ): void {
    const group = this.terminalBinaryGroupFor(ws);
    if (!group) return;
    const channelIds = group.closeSession(sessionId);
    if (channelIds.length === 0) return;
    this.sendTo(ws, { type: 'terminal-binary:channel-retired', channelIds, reason });
  }

  /**
   * A client reporting a channel it cannot route (`01:433`). Answered with the
   * authoritative table rather than a renegotiation: the client applies an
   * acceptance as the table for its epoch, so re-sending one fills the missing
   * row, and the codec epoch is deliberately unchanged so frames already in
   * flight stay deliverable.
   */
  private handleTerminalBinaryUnknownChannel(ws: WebSocket, rawMessage: unknown): void {
    const record = rawMessage as { channelIds?: unknown };
    if (!Array.isArray(record?.channelIds)) {
      console.warn('[WS] terminal-binary unknown-channel report rejected: no channel list');
      return;
    }
    const table = this.terminalBinaryGroupFor(ws)?.reannounce();
    if (!table) return;
    this.sendTo(ws, table);
  }

  // `01 §2.2`
  private handleTerminalBinaryCapability(ws: WebSocket, rawMessage: unknown): void {
    const group = this.ensureTerminalBinaryGroup(ws);
    if (!group) return;
    this.sendTo(ws, group.negotiate(rawMessage as TerminalBinaryCapabilityOffer));
  }

  // @req PERF-BGSTAB-010 AC-5 AC-6
  private handleTerminalDeliveryAck(ws: WebSocket, rawMessage: unknown): void {
    const parsed = parseTerminalDeliveryAckMessage(rawMessage);
    if (!parsed.ok) {
      console.warn(`[WS] terminal delivery ACK rejected: ${parsed.reason}`);
      return;
    }

    const meta = this.clients.get(ws);
    if (!meta) {
      console.warn('[WS] terminal delivery ACK rejected: unknown-connection');
      return;
    }
    const group = this.splitSocketGroups.get(ws);
    if (meta.channelRole === 'output' && group?.control) {
      this.sendTo(group.control, {
        type: 'terminal-delivery:ack-rejected',
        sessionId: parsed.message.sessionId,
        connectionEpoch: parsed.message.connectionEpoch,
        deliverySeq: parsed.message.deliverySeq,
        reason: 'stale-output-pair',
      });
      return;
    }
    const control = meta.channelRole === 'output' ? group?.control : ws;
    const active = control ? this.fairDeliverySchedulers.get(control) : undefined;
    if (!active) {
      this.sendTo(control ?? ws, {
        type: 'terminal-delivery:ack-rejected',
        sessionId: parsed.message.sessionId,
        connectionEpoch: parsed.message.connectionEpoch,
        deliverySeq: parsed.message.deliverySeq,
        reason: 'inactive-capability',
      });
      return;
    }
    if (parsed.message.connectionEpoch !== active.connectionEpoch) {
      this.sendTo(control!, {
        type: 'terminal-delivery:ack-rejected',
        sessionId: parsed.message.sessionId,
        connectionEpoch: parsed.message.connectionEpoch,
        deliverySeq: parsed.message.deliverySeq,
        reason: 'stale-connection-epoch',
      });
      return;
    }
    const acknowledged = active.scheduler.acknowledge(parsed.message);
    if (!acknowledged.accepted) {
      this.sendTo(control!, {
        type: 'terminal-delivery:ack-rejected',
        sessionId: parsed.message.sessionId,
        connectionEpoch: parsed.message.connectionEpoch,
        deliverySeq: parsed.message.deliverySeq,
        reason: ('errorCode' in acknowledged && typeof acknowledged.errorCode === 'string')
          ? acknowledged.errorCode
          : 'invalid-ack',
      });
      return;
    }
    active.scheduler.drain();
  }

  // @req PERF-BGSTAB-010 AC-3 AC-5 AC-6
  private handleTerminalDeliveryCapability(ws: WebSocket, rawMessage: unknown): void {
    const parsed = parseTerminalDeliveryCapabilityMessage(rawMessage);
    const meta = this.clients.get(ws);
    if (!meta || meta.channelRole === 'output' || !parsed.ok) return;
    const baseConnectionEpoch = meta.connectionId ?? meta.clientId;
    const active = this.fairDeliverySchedulers.get(ws);
    if (parsed.message.enabled === false) {
      const connectionEpoch = active?.connectionEpoch ?? baseConnectionEpoch;
      this.releaseFairDeliveryConnection(ws, connectionEpoch);
      this.sendTo(ws, {
        type: 'terminal-delivery:capability',
        protocolVersion: 1,
        accepted: false,
        connectionEpoch,
        reason: 'client-withdrew',
      });
      return;
    }
    if (parsed.message.supportsHiddenDataGapRecovery !== true) {
      const connectionEpoch = active?.connectionEpoch ?? baseConnectionEpoch;
      this.releaseFairDeliveryConnection(ws, connectionEpoch);
      this.sendTo(ws, {
        type: 'terminal-delivery:capability',
        protocolVersion: 1,
        accepted: false,
        connectionEpoch,
        reason: 'hidden-continuity-unsupported',
      });
      return;
    }
    const policy = resolveFairTerminalDeliveryPolicy(this.runtimeSendPolicyConfig.limits);
    const artifact = validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy: policy });
    if (!artifact.accepted) {
      const connectionEpoch = active?.connectionEpoch ?? baseConnectionEpoch;
      this.releaseFairDeliveryConnection(ws, connectionEpoch);
      this.sendTo(ws, {
        type: 'terminal-delivery:capability',
        protocolVersion: 1,
        accepted: false,
        connectionEpoch,
        reason: artifact.reason,
      });
      return;
    }
    const connectionEpoch = active?.connectionEpoch
      ?? this.nextFairDeliveryConnectionEpoch(ws, baseConnectionEpoch);
    if (!active) {
      const scheduler = this.createFairDeliveryScheduler(ws, connectionEpoch, policy);
      const ackTimeoutMs = scheduler.snapshot().policy.ackTimeoutMs.value;
      const maintenanceTimer = setInterval(
        () => this.runFairDeliveryMaintenance(ws),
        Math.max(1, Math.min(ackTimeoutMs, 1_000)),
      );
      maintenanceTimer.unref();
      this.fairDeliverySchedulers.set(ws, {
        connectionEpoch,
        scheduler,
        maintenanceTimer,
      });
    }
    this.sendTo(ws, {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: true,
      connectionEpoch,
    });
  }

  private handleTerminalDeliveryVisibility(ws: WebSocket, rawMessage: unknown): void {
    const parsed = parseTerminalDeliveryVisibilityMessage(rawMessage);
    const meta = this.clients.get(ws);
    if (!parsed.ok || !meta || meta.channelRole === 'output') return;
    const connectionId = meta.connectionId ?? meta.clientId;
    const fairDelivery = this.fairDeliverySchedulers.get(ws);
    if (!fairDelivery || !meta.subscribedSessions.has(parsed.message.sessionId)) return;
    const currentView = this.getTerminalAuthorityNegotiatedView(
      parsed.message.sessionId,
      connectionId,
      meta.terminalAuthorityViewRegistrations?.get(parsed.message.sessionId)?.viewGeneration ?? -1,
    );
    const currentStreamEpoch = this.terminalAuthorityStreamEpochReader?.(parsed.message.sessionId);
    if (!currentView
      || !currentStreamEpoch
      || currentView.authorityStreamEpoch !== currentStreamEpoch) {
      return;
    }
    const nextGeneration = BigInt(parsed.message.visibilityGeneration);
    const visibilityBySession = this.terminalDeliveryVisibilityBySocket.get(ws) ?? new Map();
    const existing = visibilityBySession.get(parsed.message.sessionId);
    if (existing && nextGeneration <= existing.visibilityGeneration) return;
    visibilityBySession.set(parsed.message.sessionId, {
      visibilityGeneration: nextGeneration,
      visibilityGenerationWire: parsed.message.visibilityGeneration,
      isVisible: parsed.message.isVisible,
      deliveryInterestRefCount: parsed.message.deliveryInterestRefCount ?? 1,
      dataGapLatched: false,
    });
    this.terminalDeliveryVisibilityBySocket.set(ws, visibilityBySession);
  }

  private handleTerminalDeliveryCheckpointStart(ws: WebSocket, rawMessage: unknown): void {
    if (!isRecord(rawMessage)
      || rawMessage.type !== 'terminal-delivery:checkpoint-start'
      || typeof rawMessage.sessionId !== 'string'
      || typeof rawMessage.connectionEpoch !== 'string'
      || typeof rawMessage.snapshotSeq !== 'number'
      || !Number.isSafeInteger(rawMessage.snapshotSeq)
      || rawMessage.snapshotSeq < 0
      || typeof rawMessage.checkpointEpoch !== 'string') {
      return;
    }
    const meta = this.clients.get(ws);
    if (!meta || (meta.connectionId ?? meta.clientId) !== rawMessage.connectionEpoch) return;
    const fairDelivery = this.fairDeliverySchedulers.get(ws);
    const lane = fairDelivery?.scheduler.snapshot().lanes[
      `${fairDelivery.connectionEpoch}/${rawMessage.sessionId}`
    ] as {
      queuedBytes: number;
      sentDeliverySeqs: number[];
    } | undefined;
    const transportQueued = fairDelivery && lane
      ? this.discardCheckpointQueuedFairDeliveryTransport(
          ws,
          fairDelivery.connectionEpoch,
          rawMessage.sessionId,
          new Set(lane.sentDeliverySeqs),
        )
      : 0;
    const ledger: TerminalDeliveryCheckpointLedger = {
      checkpointEpoch: rawMessage.checkpointEpoch,
      settledThroughSeq: rawMessage.snapshotSeq,
      queued: (lane && lane.queuedBytes > 0 ? 1 : 0) + transportQueued,
      inFlight: Math.max(0, (lane?.sentDeliverySeqs.length ?? 0) - transportQueued),
      late: 0,
      invalidated: 0,
      active: true,
      settled: false,
    };
    const ledgers = this.terminalDeliveryCheckpointLedgers.get(ws) ?? new Map();
    ledgers.set(rawMessage.sessionId, ledger);
    this.terminalDeliveryCheckpointLedgers.set(ws, ledgers);
    if (fairDelivery) {
      fairDelivery.scheduler.terminateSession({
        connectionEpoch: fairDelivery.connectionEpoch,
        sessionId: rawMessage.sessionId,
      });
    }
  }

  private handleTerminalDeliveryCheckpointInvalidate(ws: WebSocket, rawMessage: unknown): void {
    if (!isRecord(rawMessage)
      || rawMessage.type !== 'terminal-delivery:checkpoint-invalidate'
      || typeof rawMessage.sessionId !== 'string'
      || typeof rawMessage.connectionEpoch !== 'string'
      || typeof rawMessage.snapshotSeq !== 'number'
      || !Number.isSafeInteger(rawMessage.snapshotSeq)
      || rawMessage.snapshotSeq < 0
      || typeof rawMessage.checkpointEpoch !== 'string') {
      return;
    }
    const meta = this.clients.get(ws);
    if (!meta || (meta.connectionId ?? meta.clientId) !== rawMessage.connectionEpoch) return;
    const ledger = this.terminalDeliveryCheckpointLedgers.get(ws)?.get(rawMessage.sessionId);
    if (!ledger || ledger.settled
      || ledger.checkpointEpoch !== rawMessage.checkpointEpoch
      || ledger.settledThroughSeq !== rawMessage.snapshotSeq) {
      return;
    }
    ledger.invalidated += 1;
    ledger.active = false;
    ledger.settled = true;
    this.sendTo(ws, {
      type: 'terminal-delivery:checkpoint-ledger-settled',
      sessionId: rawMessage.sessionId,
      checkpointEpoch: ledger.checkpointEpoch,
      settledThroughSeq: ledger.settledThroughSeq,
      queued: ledger.queued,
      inFlight: ledger.inFlight,
      late: ledger.late,
      invalidated: ledger.invalidated,
    });
  }

  // @req FR-BGSTAB-022 AC-3 AC-4 AC-5
  // @req REL-BGSTAB-007 AC-4 AC-5 AC-12
  private handleTerminalCheckpointClientMessage(ws: WebSocket, rawMessage: unknown): void {
    const rawType = isRecord(rawMessage) && typeof rawMessage.type === 'string'
      ? rawMessage.type
      : '';
    const phase = rawType === 'terminal-checkpoint:negotiate' ? 'negotiate' : 'ack';
    const parsed = parseTerminalCheckpointClientMessage(rawMessage);
    if (!parsed.ok) {
      this.sendTerminalCheckpointRejection(ws, rawMessage, phase, parsed.reason === 'unsupported-version'
        ? 'unsupported-version'
        : 'invalid-message');
      return;
    }

    const meta = this.clients.get(ws);
    if (!meta) {
      this.sendTerminalCheckpointRejection(ws, rawMessage, phase, 'invalid-message');
      return;
    }
    if (parsed.message.type === 'terminal-checkpoint:ready' && meta.channelRole !== 'control') {
      this.sendTerminalCheckpointRejection(ws, rawMessage, phase, 'invalid-message');
      return;
    }

    if (parsed.message.type === 'terminal-checkpoint:continuity-rebind') {
      this.handleTerminalCheckpointContinuityRebind(ws, meta, parsed.message);
      return;
    }

    if (
      parsed.message.type !== 'terminal-checkpoint:negotiate'
      && this.terminalAuthorityClientFrameHandler?.({
        connectionId: meta.connectionId ?? meta.clientId,
        clientId: meta.clientId,
        channelRole: meta.channelRole ?? 'control',
        message: parsed.message as unknown as Record<string, unknown>,
      })
    ) {
      return;
    }

    if (parsed.message.type === 'terminal-checkpoint:negotiate') {
      meta.terminalCheckpointProtocolVersion = TERMINAL_CHECKPOINT_PROTOCOL_VERSION;
      const requestedViews = new Map(
        (parsed.message.views ?? []).map(view => [view.sessionId, view.viewGeneration]),
      );
      const previousViewGenerations = new Map(meta.retainedTerminalViews ?? []);
      const previousAuthorityRegistrations = new Map(meta.terminalAuthorityViewRegistrations ?? []);
      for (const [sessionId, viewGeneration] of meta.retainedTerminalViews ?? []) {
        if (requestedViews.get(sessionId) === viewGeneration) continue;
        this.sessionManager.unregisterRetainedTerminalClientView(
          sessionId,
          meta.clientId,
          viewGeneration,
        );
        meta.retainedTerminalViews?.delete(sessionId);
        meta.retainedTerminalMutationLeases?.delete(sessionId);
        meta.terminalAuthorityViewRegistrations?.delete(sessionId);
        if (!requestedViews.has(sessionId)) {
          meta.terminalAuthorityRecoveryEvidence?.delete(sessionId);
          this.terminalAuthorityTopologyObserver?.({
            sessionId,
            kind: 'unsubscribe',
            connectionId: meta.connectionId ?? meta.clientId,
            viewGeneration,
          });
        }
      }
      const registeredViews: Array<{
        sessionId: string;
        viewGeneration: number;
        queryReplyCapability?: 'terminal.query-reply-input.v1';
        parserResponderCapability?: 'terminal.parser-responder-disable.v1';
        authorityStreamEpoch?: string;
        driverLeaseGeneration?: string;
        acceptedViewAttributesGeneration?: string;
        viewAttributesChallengeId?: string;
      }> = [];
      const authorityRegisteredViews: TerminalAuthorityViewRegistration[] = [];
      const authorityReadyViews: TerminalAuthorityViewReadyRegistration[] = [];
      const mutationLeases: Array<{
        sessionId: string;
        authorityEpoch: string;
        viewGeneration: number;
        leaseGeneration: string;
      }> = [];
      for (const view of parsed.message.views ?? []) {
        meta.retainedTerminalMutationLeases?.delete(view.sessionId);
        const previousViewGeneration = previousViewGenerations.get(view.sessionId);
        const registration = this.sessionManager.registerRetainedTerminalClientView(
          view.sessionId,
          meta.clientId,
          view.viewGeneration,
        );
        if (!registration.ok) continue;
        meta.retainedTerminalViews ??= new Map();
        meta.retainedTerminalViews.set(view.sessionId, view.viewGeneration);
        const recoveryEvidence = meta.terminalAuthorityRecoveryEvidence?.get(view.sessionId);
        if (recoveryEvidence) {
          this.sessionManager.recordTerminalAuthorityServerRecoveryApplied(view.sessionId, {
            clientId: meta.clientId,
            viewGeneration: view.viewGeneration,
            ...recoveryEvidence,
          });
        }
        meta.terminalAuthorityViewRegistrations ??= new Map();
        const retainedStateReader = this.sessionManager as unknown as {
          getRetainedTerminalAuthorityState?: (sessionId: string) => { streamEpoch?: unknown } | undefined;
        };
        const terminalLaneReady = meta.wsTransportMode !== 'split'
          || this.splitSocketGroups.get(ws)?.output?.readyState === WebSocket.OPEN;
        const authorityStreamEpoch = terminalLaneReady
          && view.queryReplyCapability === 'terminal.query-reply-input.v1'
          && view.parserResponderCapability === 'terminal.parser-responder-disable.v1'
          ? this.terminalAuthorityStreamEpochReader?.(view.sessionId)
            ?? retainedStateReader.getRetainedTerminalAuthorityState?.(view.sessionId)?.streamEpoch
          : undefined;
        const viewAttributesChallengeId = this.terminalAuthorityViewAttributesChallengeReader?.({
          sessionId: view.sessionId,
          clientId: meta.clientId,
          connectionId: meta.connectionId ?? meta.clientId,
          viewGeneration: view.viewGeneration,
        });
        const authorityRegistration = isCanonicalAuthorityOrdinal(authorityStreamEpoch)
          ? {
              ...view,
              authorityStreamEpoch,
              driverLeaseGeneration: authorityStreamEpoch,
              acceptedViewAttributesGeneration: authorityStreamEpoch,
              ...(typeof viewAttributesChallengeId === 'string' && viewAttributesChallengeId.length > 0
                ? { viewAttributesChallengeId }
                : {}),
            }
          : { ...view };
        const authorityMode = isCanonicalAuthorityOrdinal(authorityStreamEpoch)
          ? this.terminalAuthorityViewModeReader?.({
              sessionId: view.sessionId,
              clientId: meta.clientId,
              connectionId: meta.connectionId ?? meta.clientId,
              viewGeneration: view.viewGeneration,
              queryReplyCapability: 'terminal.query-reply-input.v1',
              parserResponderCapability: 'terminal.parser-responder-disable.v1',
              authorityStreamEpoch,
              driverLeaseGeneration: authorityStreamEpoch,
              acceptedViewAttributesGeneration: authorityStreamEpoch,
            }) ?? 'legacy'
          : 'legacy';
        meta.terminalAuthorityViewRegistrations.set(view.sessionId, authorityRegistration);
        if (previousViewGeneration === undefined || previousViewGeneration !== view.viewGeneration) {
          this.terminalAuthorityTopologyObserver?.({
            sessionId: view.sessionId,
            kind: previousViewGeneration === undefined ? 'new-view' : 'generation-changed',
            connectionId: meta.connectionId ?? meta.clientId,
            viewGeneration: view.viewGeneration,
          });
        }
        registeredViews.push(authorityRegistration);
        if (isCanonicalAuthorityOrdinal(authorityStreamEpoch)) {
          authorityRegisteredViews.push({
            sessionId: view.sessionId,
            clientId: meta.clientId,
            connectionId: meta.connectionId ?? meta.clientId,
            viewGeneration: view.viewGeneration,
            queryReplyCapability: 'terminal.query-reply-input.v1',
            parserResponderCapability: 'terminal.parser-responder-disable.v1',
            authorityStreamEpoch,
            driverLeaseGeneration: authorityStreamEpoch,
            acceptedViewAttributesGeneration: authorityStreamEpoch,
          });
          const previousAuthorityRegistration = previousAuthorityRegistrations.get(view.sessionId);
          const topologyReason = previousViewGeneration === undefined
            ? 'new-view' as const
            : previousViewGeneration !== view.viewGeneration
              ? 'generation-changed' as const
              : previousAuthorityRegistration?.authorityStreamEpoch !== authorityStreamEpoch
                ? 'authority-generation-changed' as const
                : null;
          const recoveryAcknowledged = recoveryEvidence !== undefined
            && previousViewGeneration === view.viewGeneration
            && authorityMode === 'checkpoint';
          const reason = recoveryAcknowledged ? 'recovery-acknowledged' as const : topologyReason;
          if (reason) {
            authorityReadyViews.push({
              sessionId: view.sessionId,
              clientId: meta.clientId,
              connectionId: meta.connectionId ?? meta.clientId,
              viewGeneration: view.viewGeneration,
              queryReplyCapability: 'terminal.query-reply-input.v1',
              parserResponderCapability: 'terminal.parser-responder-disable.v1',
              authorityStreamEpoch,
              driverLeaseGeneration: authorityStreamEpoch,
              acceptedViewAttributesGeneration: authorityStreamEpoch,
              reason,
            });
          }
        }
        if (authorityMode === 'checkpoint') {
          const leaseReader = this.sessionManager as unknown as {
            getTerminalAuthoritySuspendedBrowserMutationLease?: (sessionId: string) => {
              clientId: string;
              authorityEpoch: string;
              viewGeneration: number;
              leaseGeneration: string;
            } | null;
          };
          const lease = leaseReader.getTerminalAuthoritySuspendedBrowserMutationLease?.(view.sessionId) ?? null;
          if (lease?.clientId === meta.clientId && lease.viewGeneration === view.viewGeneration) {
            meta.retainedTerminalMutationLeases ??= new Map();
            meta.retainedTerminalMutationLeases.set(view.sessionId, {
              authorityEpoch: lease.authorityEpoch,
              viewGeneration: lease.viewGeneration,
              leaseGeneration: lease.leaseGeneration,
            });
            mutationLeases.push({
              sessionId: view.sessionId,
              authorityEpoch: lease.authorityEpoch,
              viewGeneration: lease.viewGeneration,
              leaseGeneration: lease.leaseGeneration,
            });
            continue;
          }
        }
        const lease = this.sessionManager.establishRetainedTerminalMutationLease(
          view.sessionId,
          meta.clientId,
          view.viewGeneration,
        );
        if (!lease.ok) continue;
        meta.retainedTerminalMutationLeases ??= new Map();
        meta.retainedTerminalMutationLeases.set(view.sessionId, {
          authorityEpoch: lease.authorityEpoch,
          viewGeneration: lease.viewGeneration,
          leaseGeneration: lease.leaseGeneration,
        });
        mutationLeases.push({
          sessionId: lease.sessionId,
          authorityEpoch: lease.authorityEpoch,
          viewGeneration: lease.viewGeneration,
          leaseGeneration: lease.leaseGeneration,
        });
      }
      if (registeredViews.length === 0) {
        this.sendTo(ws, {
          type: 'terminal-checkpoint:capability',
          protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
          accepted: true,
          authorityMode: 'legacy',
          checkpointDeliveryActive: false,
          ordinalEncoding: 'canonical-uint64-decimal',
          digestAlgorithms: ['sha256'],
        });
      } else {
        for (const registeredView of registeredViews) {
          const authorityView = authorityRegisteredViews.find(view => (
            view.sessionId === registeredView.sessionId
            && view.viewGeneration === registeredView.viewGeneration
          ));
          const authorityMode = authorityView
            ? this.terminalAuthorityViewModeReader?.(authorityView) ?? 'legacy'
            : 'legacy';
          this.sendTo(ws, {
            type: 'terminal-checkpoint:capability',
            protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
            accepted: true,
            authorityMode,
            checkpointDeliveryActive: authorityMode === 'checkpoint',
            ordinalEncoding: 'canonical-uint64-decimal',
            digestAlgorithms: ['sha256'],
            registeredViews: [registeredView],
            mutationLeases: mutationLeases.filter(lease => (
              lease.sessionId === registeredView.sessionId
              && lease.viewGeneration === registeredView.viewGeneration
            )),
          });
        }
      }
      for (const view of authorityReadyViews) {
        this.terminalAuthorityViewReadyObserver?.(view);
      }
      return;
    }

    if (meta.terminalCheckpointProtocolVersion !== TERMINAL_CHECKPOINT_PROTOCOL_VERSION) {
      this.sendTerminalCheckpointRejection(ws, parsed.message, 'ack', 'capability-not-negotiated');
      return;
    }

    // Only the additive contract is enabled here. A later authority phase must
    // register an active transaction before an ACK can mutate readiness,
    // held output, input release, replay state, or byte credit.
    this.sendTerminalCheckpointRejection(ws, parsed.message, 'ack', 'checkpoint-not-active');
  }

  private handleTerminalCheckpointContinuityRebind(
    ws: WebSocket,
    meta: WsClientMeta,
    message: TerminalCheckpointContinuityRebindMessage,
  ): void {
    if (meta.terminalCheckpointProtocolVersion !== TERMINAL_CHECKPOINT_PROTOCOL_VERSION) {
      this.sendTerminalCheckpointRejection(ws, message, 'ack', 'capability-not-negotiated');
      return;
    }

    const claim = message.continuityRecord;
    if (claim.viewGeneration === undefined) {
      this.sendTo(ws, {
        type: 'terminal-checkpoint:fresh-checkpoint-required',
        sessionId: message.sessionId,
        reason: 'continuity-identity-mismatch',
      });
      return;
    }
    const hasCompleteClaim = isCanonicalAuthorityOrdinal(message.streamEpoch)
      && isCanonicalAuthorityOrdinal(message.checkpointEpoch)
      && isCanonicalAuthorityOrdinal(message.snapshotSeq)
      && isCanonicalAuthorityOrdinal(message.oldestRetainedSeq)
      && typeof message.retentionPolicyId === 'string' && message.retentionPolicyId.length > 0
      && typeof claim.sessionId === 'string'
      && Number.isSafeInteger(claim.viewGeneration) && claim.viewGeneration >= 0
      && isCanonicalAuthorityOrdinal(claim.visibilityGeneration)
      && isCanonicalAuthorityOrdinal(claim.lastDeliveredSeq)
      && isCanonicalAuthorityOrdinal(claim.streamEpoch)
      && isCanonicalAuthorityOrdinal(claim.checkpointEpoch)
      && isCanonicalAuthorityOrdinal(claim.snapshotSeq)
      && isCanonicalAuthorityOrdinal(claim.oldestRetainedSeq);
    if (!hasCompleteClaim) {
      this.sendTo(ws, {
        type: 'terminal-checkpoint:fresh-checkpoint-required',
        sessionId: message.sessionId,
        reason: 'continuity-identity-mismatch',
      });
      return;
    }

    const connectionId = meta.connectionId ?? meta.clientId;
    const fresh = this.terminalAuthorityFreshCheckpointReader?.({
      sessionId: message.sessionId,
      clientId: meta.clientId,
      connectionId,
    });
    if (!fresh) {
      this.sendTo(ws, {
        type: 'terminal-checkpoint:fresh-checkpoint-required',
        sessionId: message.sessionId,
        reason: 'authority-unavailable',
      });
      return;
    }

    if (!isTerminalAuthorityContinuityRecord(fresh.continuity)) {
      this.sendTo(ws, {
        type: 'terminal-checkpoint:fresh-checkpoint-required',
        sessionId: message.sessionId,
        reason: 'continuity-identity-mismatch',
      });
      return;
    }

    const issued = fresh.continuity;
    const matchesIssued = issued.sessionId === message.sessionId
      && issued.connectionId === connectionId
      && issued.viewGeneration === message.viewGeneration
      && issued.visibilityGeneration === message.visibilityGeneration
      && issued.lastDeliveredSeq === message.lastDeliveredSeq
      && issued.streamEpoch === message.streamEpoch
      && issued.checkpointEpoch === message.checkpointEpoch
      && issued.snapshotSeq === message.snapshotSeq
      && issued.oldestRetainedSeq === message.oldestRetainedSeq
      && issued.retentionPolicyId === message.retentionPolicyId
      && issued.sessionId === claim.sessionId
      && issued.viewGeneration === claim.viewGeneration
      && issued.visibilityGeneration === claim.visibilityGeneration
      && issued.lastDeliveredSeq === claim.lastDeliveredSeq
      && issued.streamEpoch === claim.streamEpoch
      && issued.checkpointEpoch === claim.checkpointEpoch
      && issued.snapshotSeq === claim.snapshotSeq
      && issued.oldestRetainedSeq === claim.oldestRetainedSeq
      && issued.retentionPolicyId === claim.retentionPolicyId
      && issued.expiresAt === claim.expiresAt;

    if (!matchesIssued || issued.expiresAt <= Date.now()) {
      this.sendTo(ws, {
        type: 'terminal-checkpoint:fresh-checkpoint-required',
        sessionId: message.sessionId,
        reason: matchesIssued ? 'continuity-expired' : 'continuity-identity-mismatch',
        checkpointAuthority: 'server-full-retained-state',
        fullCheckpoint: fresh.fullCheckpoint,
      });
      return;
    }

    this.sendTo(ws, {
      type: 'terminal-checkpoint:continuity-rebound',
      sessionId: issued.sessionId,
      viewGeneration: issued.viewGeneration,
      visibilityGeneration: issued.visibilityGeneration,
      streamEpoch: issued.streamEpoch,
      checkpointEpoch: issued.checkpointEpoch,
      lastDeliveredSeq: issued.lastDeliveredSeq,
    });
  }

  private sendTerminalCheckpointRejection(
    ws: WebSocket,
    rawMessage: unknown,
    phase: 'negotiate' | 'ack',
    reason: 'unsupported-version' | 'invalid-message' | 'capability-not-negotiated' | 'checkpoint-not-active',
  ): void {
    const sessionId = isRecord(rawMessage) && typeof rawMessage.sessionId === 'string'
      && rawMessage.sessionId.length > 0
      ? rawMessage.sessionId
      : undefined;
    const rejectedMessageType = isRecord(rawMessage) && rawMessage.type === 'resize'
      ? 'resize' as const
      : undefined;
    this.sendTo(ws, {
      type: 'terminal-checkpoint:rejected',
      supportedProtocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      phase,
      reason,
      ...(sessionId ? { sessionId } : {}),
      ...(rejectedMessageType ? { rejectedMessageType } : {}),
    });
  }

  private handleMessageError(ws: WebSocket, raw: Buffer | string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[WS] Message handler failed:', message);

    const parsed = this.tryParseRawMessage(raw);
    const sessionId = isRecord(parsed) && typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? parsed.sessionId
      : null;
    if (sessionId) {
      this.sendTo(ws, {
        type: 'session:error',
        sessionId,
        message: 'WebSocket message handling failed',
      });
    }
  }

  private tryParseRawMessage(raw: Buffer | string): unknown {
    try {
      return JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return null;
    }
  }

  private handleSubscribe(ws: WebSocket, sessionIds: string[]): void {
    const results: Array<
      { sessionId: string; status: string; cwd?: string; ready: boolean } & SubscribedChannelFields
    > = [];
    const meta = this.clients.get(ws);
    if (!meta) return;

    for (const sessionId of sessionIds) {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        results.push({ sessionId, status: 'error', ready: false });
        continue;
      }

      if (!this.sessionSubscribers.has(sessionId)) {
        this.sessionSubscribers.set(sessionId, new Set());
      }

      const subscribers = this.sessionSubscribers.get(sessionId)!;
      const alreadySubscribed = subscribers.has(ws);
      subscribers.add(ws);
      meta.subscribedSessions.add(sessionId);
      const viewGeneration = meta.retainedTerminalViews?.get(sessionId);
      if (!alreadySubscribed && viewGeneration !== undefined) {
        this.terminalAuthorityTopologyObserver?.({
          sessionId,
          kind: 'subscription-ready',
          connectionId: meta.connectionId ?? meta.clientId,
          viewGeneration,
        });
      }

      const cwd = this.sessionManager.getLastCwd(sessionId) ?? undefined;
      this.recordReplayEvent({
        kind: 'snapshot_sent',
        sessionId,
        details: {
          phase: 'subscribe-begin',
          clientId: meta.clientId,
          alreadySubscribed,
        },
      });

      if (alreadySubscribed) {
        results.push({
          sessionId,
          status: session.status,
          cwd,
          ready: !meta.replayPendingSessions.has(sessionId) && this.sessionManager.isSessionReady(sessionId),
          ...this.terminalBinaryChannelFor(ws, sessionId),
        });
        continue;
      }

      const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
      if (!snapshot) {
        this.markRestoreAuthorityPending(ws, sessionId);
        results.push({
          sessionId,
          status: session.status,
          cwd,
          ready: false,
          ...this.terminalBinaryChannelFor(ws, sessionId),
        });
        this.scheduleRestoreAuthorityRetry(ws, sessionId, 'subscribe');
        continue;
      }

      const replayState = this.sendSnapshotReplay(ws, sessionId, snapshot, 'subscribe');
      results.push({
        sessionId,
        status: session.status,
        cwd,
        ready: false,
        ...this.terminalBinaryChannelFor(ws, sessionId),
      });
      void replayState;
    }

    this.sendTo(ws, { type: 'subscribed', sessions: results });
  }

  private handleUnsubscribe(ws: WebSocket, sessionIds: string[]): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    for (const sessionId of sessionIds) {
      const viewGeneration = meta.retainedTerminalViews?.get(sessionId);
      this.clearReplayPendingForPair(ws, sessionId, 'context-changed');
      this.clearScreenRepairPendingForPair(ws, sessionId, 'context-changed');
      const control = meta.channelRole === 'output'
        ? this.splitSocketGroups.get(ws)?.control
        : ws;
      if (control) this.terminateFairDeliverySession(control, sessionId);

      const subscribers = this.sessionSubscribers.get(sessionId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          this.sessionSubscribers.delete(sessionId);
        }
      }

      meta.subscribedSessions.delete(sessionId);
      this.retireTerminalBinaryChannels(ws, sessionId, 'unsubscribed');
      meta.terminalAuthorityRecoveryEvidence?.delete(sessionId);
      if (viewGeneration !== undefined) {
        this.sessionManager.unregisterRetainedTerminalClientView(
          sessionId,
          meta.clientId,
          viewGeneration,
        );
        meta.retainedTerminalViews?.delete(sessionId);
        meta.retainedTerminalMutationLeases?.delete(sessionId);
        meta.terminalAuthorityViewRegistrations?.delete(sessionId);
        this.terminalAuthorityTopologyObserver?.({
          sessionId,
          kind: 'unsubscribe',
          connectionId: meta.connectionId ?? meta.clientId,
          viewGeneration,
        });
      }
    }
  }

  private handleScreenSnapshotReady(ws: WebSocket, sessionId: string, replayToken: string): void {
    const replayResult = this.consumeReplayPendingForPair(ws, sessionId, replayToken);
    if (replayResult.status !== 'ok') {
      this.recordReplayEvent({
        kind: 'ack_stale',
        sessionId,
        replayToken,
        snapshotSeq: replayResult.snapshotSeq,
        details: {
          reason: replayResult.reason,
          activeReplayToken: replayResult.activeReplayToken ?? null,
        },
      });
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const queuedOutputBytes = replayResult.preserveOutputChunkIdentity
      ? replayResult.queuedOutputBytes
      : utf8ByteLength(replayResult.queuedOutput);
    const coveredQueuedOutputBytes = replayResult.preserveOutputChunkIdentity
      ? replayResult.coveredQueuedOutputBytes
      : utf8ByteLength(replayResult.coveredQueuedOutput);
    const replayMeta = this.clients.get(ws);
    const recoveryViewGeneration = replayMeta?.retainedTerminalViews?.get(sessionId);
    const recoveryEvidence = {
      replayToken,
      snapshotSeq: replayResult.snapshotSeq,
      snapshotMode: replayResult.snapshotMode,
      snapshotTruncated: replayResult.snapshotTruncated,
      queuedOutputBytes,
      queuedOutputTruncated: replayResult.queuedOutputTruncated,
    } as const;
    const recoveryEvidenceEligible = recoveryEvidence.snapshotMode === 'authoritative'
      && !recoveryEvidence.snapshotTruncated
      && !recoveryEvidence.queuedOutputTruncated
      && recoveryEvidence.queuedOutputBytes === 0;
    if (replayMeta && recoveryEvidenceEligible) {
      replayMeta.terminalAuthorityRecoveryEvidence ??= new Map();
      replayMeta.terminalAuthorityRecoveryEvidence.set(sessionId, recoveryEvidence);
    } else {
      replayMeta?.terminalAuthorityRecoveryEvidence?.delete(sessionId);
    }
    if (replayMeta && recoveryViewGeneration !== undefined && recoveryEvidenceEligible) {
      this.sessionManager.recordTerminalAuthorityServerRecoveryApplied(sessionId, {
        clientId: replayMeta.clientId,
        viewGeneration: recoveryViewGeneration,
        ...recoveryEvidence,
      });
    }
    const recoveryConnectionId = replayMeta?.connectionId ?? replayMeta?.clientId;
    const recoveryRegistration = recoveryViewGeneration !== undefined && recoveryConnectionId
      ? this.getTerminalAuthorityNegotiatedView(
          sessionId,
          recoveryConnectionId,
          recoveryViewGeneration,
        )
      : null;
    const recoveryRegistrationEligible = recoveryEvidenceEligible
      && replayMeta?.channelRole !== 'output'
      && replayMeta?.subscribedSessions.has(sessionId) === true
      && recoveryViewGeneration !== undefined
      && recoveryRegistration !== null
      && recoveryRegistration.clientId === replayMeta.clientId
      && recoveryRegistration.connectionId === recoveryConnectionId
      && recoveryRegistration.viewGeneration === recoveryViewGeneration
      && isCanonicalAuthorityOrdinal(recoveryRegistration.authorityStreamEpoch)
      && isCanonicalAuthorityOrdinal(recoveryRegistration.driverLeaseGeneration)
      && isCanonicalAuthorityOrdinal(recoveryRegistration.acceptedViewAttributesGeneration)
      && this.terminalAuthorityViewModeReader?.(recoveryRegistration) === 'checkpoint';
    if (recoveryRegistrationEligible && recoveryRegistration) {
      this.terminalAuthorityViewReadyObserver?.({
        ...recoveryRegistration,
        reason: 'recovery-acknowledged',
      });
    }

    this.recordReplayEvent({
      kind: 'ack_ok',
      sessionId,
      replayToken,
      snapshotSeq: replayResult.snapshotSeq,
      details: {
        queuedBytes: queuedOutputBytes,
        coveredQueuedBytes: coveredQueuedOutputBytes,
        queuedOutputTruncated: replayResult.queuedOutputTruncated,
        queuedInputBytes: replayResult.queuedInputBytes,
        queuedInputCount: replayResult.queuedInputs.length,
      },
    });

    if (
      replayResult.coveredQueuedOutput.length > 0
      || replayResult.coveredQueuedOutputBytes > 0
    ) {
      this.recordReplayEvent({
        kind: 'output_covered_by_snapshot',
        sessionId,
        replayToken,
        snapshotSeq: replayResult.snapshotSeq,
        details: {
          coveredQueuedBytes: coveredQueuedOutputBytes,
          queuedOutputTruncated: replayResult.queuedOutputTruncated,
        },
      });
    }

    if (replayResult.preserveOutputChunkIdentity) {
      for (const chunk of replayResult.queuedOutputChunks) {
        this.sendNonCoalescingOutputChunk(ws, sessionId, chunk.data, {
          replayToken,
          repairToken: replayResult.recoveryRepairToken,
          screenSeq: chunk.screenSeq,
          authorityEpoch: chunk.authorityEpoch,
          authorityRevision: chunk.authorityRevision,
          chunkId: chunk.chunkId,
        });
        this.recordReplayEvent({
          kind: 'output_flushed',
          sessionId,
          replayToken,
          snapshotSeq: replayResult.snapshotSeq,
          details: {
            outputBytes: chunk.byteLength,
            outputScreenSeq: chunk.screenSeq ?? null,
            phase: 'ack-chunk',
          },
        });
      }
    } else if (replayResult.queuedOutput.length > 0) {
      this.sendTo(ws, { type: 'output', sessionId, data: replayResult.queuedOutput });
      this.recordReplayEvent({
        kind: 'output_flushed',
        sessionId,
        replayToken,
        snapshotSeq: replayResult.snapshotSeq,
        details: {
          outputBytes: queuedOutputBytes,
        },
      });
    }

    this.flushQueuedReplayInputs(ws, sessionId, replayToken, replayResult.snapshotSeq, replayResult.queuedInputs);

    const reacquireRecoveryEvidence = replayResult.recoveryRepairToken === undefined
      && !recoveryEvidenceEligible
      && recoveryEvidence.snapshotMode === 'authoritative'
      && !recoveryEvidence.snapshotTruncated
      && (recoveryEvidence.queuedOutputBytes > 0 || recoveryEvidence.queuedOutputTruncated);
    this.sendTo(ws, {
      type: 'session:ready',
      sessionId,
      replayToken,
      repairToken: replayResult.recoveryRepairToken,
      snapshotSeq: replayResult.snapshotSeq,
    }, error => {
      if (error || !reacquireRecoveryEvidence || ws.readyState !== WebSocket.OPEN) return;
      const refreshedSnapshot = this.getRestoreAuthoritySnapshot(sessionId);
      if (!refreshedSnapshot) {
        this.scheduleRefreshRestoreAuthorityRetry(sessionId, {
          startWhenReady: true,
          origin: 'refresh',
          reason: 'post-snapshot-tail-recovery-evidence',
        });
        return;
      }
      this.sendSnapshotReplay(ws, sessionId, refreshedSnapshot, 'repair', {
        supersedesReplayToken: replayToken,
      });
    });
    this.recordReplayEvent({
      kind: 'ready_sent',
      sessionId,
      replayToken,
      snapshotSeq: replayResult.snapshotSeq,
      details: {
        reason: 'ack',
      },
    });
  }

  private handleInput(ws: WebSocket, rawMessage: unknown): void {
    if (this.handleTerminalQueryReplyInput(ws, rawMessage)) {
      return;
    }
    const input = this.validateInputMessage(rawMessage);
    if (!input.ok) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: input.reason,
      });
      return;
    }

    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(input.sessionId);
    if (!this.sessionManager.getSession(input.sessionId)) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'session-missing',
      });
      return;
    }

    const retainedIdentity = input.retainedIdentity
      ?? meta?.retainedTerminalMutationLeases?.get(input.sessionId);
    if (meta?.retainedTerminalViews?.has(input.sessionId) && !retainedIdentity) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'invalid-payload',
      });
      return;
    }

    if (pending) {
      const queuedInput: QueuedReplayInput = {
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        retainedIdentity,
        queuedAt: Date.now(),
        byteLength: input.byteLength,
      };

      if (!this.appendQueuedInput(ws, input.sessionId, pending, queuedInput)) {
        return;
      }
      this.recordReplayEvent({
        kind: 'input_queued',
        sessionId: input.sessionId,
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
        details: {
          mode: this.inputReliabilityMode,
          queuedInputBytes: pending.queuedInputBytes,
          queuedInputCount: pending.queuedInputs.length,
          ...this.buildQueuedInputReplayDetails(queuedInput),
        },
      });
      return;
    }

    let gatewayResult: WebSocketInputGatewayResult = { accepted: false, reason: 'server-error' };
    try {
      gatewayResult = this.submitWebSocketInputThroughGateway({
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        retainedIdentity,
      }, meta);
    } catch (error) {
      console.error('[WS] PTY input write failed:', error);
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'server-error',
      });
      return;
    }

    if (!gatewayResult.accepted) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: gatewayResult.reason,
      });
    }
  }

  private handleTerminalQueryReplyInput(ws: WebSocket, rawMessage: unknown): boolean {
    if (!isRecordValue(rawMessage) || rawMessage.type !== 'input' || rawMessage.inputKind !== 'query-reply') {
      return false;
    }
    const meta = this.clients.get(ws);
    const sessionId = typeof rawMessage.sessionId === 'string' ? rawMessage.sessionId : '';
    const rawResponderIdentity = isRecordValue(rawMessage.responderIdentity)
      ? { ...rawMessage.responderIdentity }
      : undefined;
    const sendReceipt = (
      accepted: boolean,
      reason?: string,
      evidence: {
        ptyWriteAttempted?: boolean;
        ptyWriteCount?: number;
        effectCommitted?: boolean;
        duplicatePtyReplyCount?: number;
      } = {},
    ): void => {
      const currentRegistration = meta?.terminalAuthorityViewRegistrations?.get(sessionId);
      this.sendPriorityControl(ws, {
        type: accepted
          ? 'terminal-authority:query-reply-accepted'
          : 'terminal-authority:query-reply-rejected',
        sessionId,
        accepted,
        ...(accepted && rawResponderIdentity
          ? { responderIdentity: rawResponderIdentity }
          : {}),
        ...(!accepted && rawResponderIdentity
          ? { rejectedResponderIdentity: rawResponderIdentity }
          : {}),
        currentConnectionId: meta?.connectionId ?? meta?.clientId ?? null,
        currentViewGeneration: currentRegistration?.viewGeneration ?? null,
        ptyWriteAttempted: evidence.ptyWriteAttempted ?? false,
        ptyWriteCount: evidence.ptyWriteCount ?? 0,
        effectCommitted: evidence.effectCommitted ?? false,
        duplicatePtyReplyCount: evidence.duplicatePtyReplyCount ?? 0,
        ...(reason ? { reason } : {}),
      });
    };
    if (!meta || meta.channelRole === 'output') {
      sendReceipt(false, 'invalid-control-socket');
      return true;
    }
    const logicalConnectionId = meta.connectionId ?? meta.clientId;
    const newestOpenControl = [...this.clients.entries()].reverse().find(([candidate, candidateMeta]) => (
      candidate.readyState === WebSocket.OPEN
      && candidateMeta.channelRole !== 'output'
      && (candidateMeta.connectionId ?? candidateMeta.clientId) === logicalConnectionId
    ))?.[0];
    if (newestOpenControl !== ws) {
      sendReceipt(false, 'stale-control-socket');
      return true;
    }
    if (!meta.subscribedSessions.has(sessionId)) {
      sendReceipt(false, 'not-subscribed');
      return true;
    }
    const currentRegistration = meta.terminalAuthorityViewRegistrations?.get(sessionId);
    if (!currentRegistration) {
      sendReceipt(false, 'capability-not-negotiated');
      return true;
    }
    if (rawResponderIdentity?.viewGeneration !== currentRegistration.viewGeneration) {
      sendReceipt(false, 'stale-responder-identity');
      return true;
    }
    const result = this.terminalAuthorityQueryReplyIngress?.handle(
      { connectionId: meta.connectionId ?? meta.clientId },
      rawMessage,
    ) ?? { handled: true, accepted: false, reason: 'server-responder-unavailable' };
    sendReceipt(result.accepted, result.reason, result);
    return true;
  }

  private handleResize(ws: WebSocket, message: Extract<ClientWsMessage, { type: 'resize' }>): void {
    const meta = this.clients.get(ws);
    const parsedWireIdentity = this.parseRetainedTerminalWireMutationIdentity(message.retainedIdentity);
    if (Object.prototype.hasOwnProperty.call(message, 'retainedIdentity') && !parsedWireIdentity) {
      this.sendTerminalCheckpointRejection(ws, message, 'ack', 'invalid-message');
      return;
    }
    const wireIdentity = parsedWireIdentity
      ?? meta?.retainedTerminalMutationLeases?.get(message.sessionId);
    if (meta?.retainedTerminalViews?.has(message.sessionId) && !wireIdentity) {
      this.sendTerminalCheckpointRejection(ws, message, 'ack', 'invalid-message');
      return;
    }
    const identity = this.toRetainedTerminalMutationIdentity(meta, wireIdentity);
    if (!this.sessionManager.resize(message.sessionId, message.cols, message.rows, identity) && wireIdentity) {
      this.sendTerminalCheckpointRejection(ws, message, 'ack', 'invalid-message');
    }
  }

  private handleRepairReplay(
    ws: WebSocket,
    sessionId: string,
    supersedeReplayToken?: string,
    repairToken?: string,
  ): void {
    const meta = this.clients.get(ws);
    if (!meta || !meta.subscribedSessions.has(sessionId)) {
      return;
    }

    const pending = meta.replayPendingSessions.get(sessionId);
    let acceptedSupersedesReplayToken: string | undefined;
    if (pending) {
      if (
        !supersedeReplayToken
        || pending.replayToken !== supersedeReplayToken
        || (pending.recoveryRepairToken !== undefined && pending.recoveryRepairToken !== repairToken)
      ) {
        this.recordReplayEvent({
          kind: 'snapshot_refresh_skipped',
          sessionId,
          replayToken: pending.replayToken,
          snapshotSeq: pending.snapshotSeq,
          details: {
            reason: 'client-fresh-snapshot-token-mismatch',
            requestedReplayToken: supersedeReplayToken ?? null,
            requestedRepairToken: repairToken ?? null,
          },
        });
        return;
      }

      const queuedOutputChunks = [
        ...pending.coveredQueuedOutputChunks,
        ...pending.queuedOutputChunks,
      ];
      const recoveryRepairToken = pending.recoveryRepairToken;
      acceptedSupersedesReplayToken = pending.replayToken;
      this.clearReplayPendingForPair(ws, sessionId, 'context-changed');
      if (recoveryRepairToken) {
        this.startScreenRepairSnapshotRecovery(
          ws,
          sessionId,
          recoveryRepairToken,
          'generation-failed',
          queuedOutputChunks,
          acceptedSupersedesReplayToken,
        );
        return;
      }
    } else if (supersedeReplayToken) {
      this.recordReplayEvent({
        kind: 'snapshot_refresh_skipped',
        sessionId,
        replayToken: supersedeReplayToken,
        details: {
          reason: 'client-fresh-snapshot-without-pending-replay',
        },
      });
      return;
    }

    const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
    if (!snapshot) {
      this.markRestoreAuthorityPending(ws, sessionId, acceptedSupersedesReplayToken);
      this.scheduleRestoreAuthorityRetry(ws, sessionId, 'repair');
      return;
    }

    this.sendSnapshotReplay(ws, sessionId, snapshot, 'repair', {
      supersedesReplayToken: acceptedSupersedesReplayToken,
    });
  }

  private async handleScreenRepairRequest(ws: WebSocket, message: unknown): Promise<void> {
    const request = this.validateScreenRepairRequest(message);
    if (!request.ok) {
      if (request.sessionId) {
        this.sendScreenRepairRejected(ws, request.sessionId, request.reason);
      }
      return;
    }

    const { sessionId, cols, rows, reason, clientBufferType } = request.message;
    const meta = this.clients.get(ws);
    this.recordReplayEvent({
      kind: 'screen_repair_requested',
      sessionId,
      details: {
        reason,
        cols,
        rows,
        clientAtBottom: request.message.clientAtBottom,
        clientBufferType,
      },
    });

    if (!meta || !meta.subscribedSessions.has(sessionId)) {
      this.sendScreenRepairRejected(ws, sessionId, 'not-subscribed', undefined, cols, rows);
      return;
    }
    if (!request.message.clientAtBottom) {
      this.sendScreenRepairRejected(ws, sessionId, 'apply-rejected', undefined, cols, rows);
      return;
    }
    if (meta.replayPendingSessions.has(sessionId) || this.getScreenRepairPendingSessions(meta).has(sessionId)) {
      this.sendScreenRepairRejected(ws, sessionId, 'pending', undefined, cols, rows);
      return;
    }

    const pending = this.markScreenRepairPending(ws, sessionId, 0);
    const repair = await this.sessionManager.getScreenRepair(sessionId, {
      cols,
      rows,
      bufferType: clientBufferType,
    });
    const activePending = this.getScreenRepairPendingSessions(meta).get(sessionId);
    if (
      ws.readyState !== WebSocket.OPEN
      || !meta.subscribedSessions.has(sessionId)
      || meta.replayPendingSessions.has(sessionId)
      || activePending !== pending
    ) {
      if (activePending === pending) {
        this.clearScreenRepairPendingForPair(ws, sessionId, 'context-changed');
      }
      return;
    }
    if (!repair.ok) {
      this.clearScreenRepairPendingForPair(ws, sessionId, repair.reason);
      const rejectedReason = this.mapScreenRepairRejectReason(repair.reason);
      this.sendScreenRepairRejected(ws, sessionId, rejectedReason, pending.repairToken, cols, rows);
      if (repair.reason === 'headless-busy') {
        // A large retained write can keep xterm/headless synchronously busy
        // beyond the bounded repair drain window. This is transient authority
        // contention, not proof that the model is corrupt. Fence subsequent
        // output/input and let the existing bounded atomic-restore retry issue
        // a fresh snapshot once the write tail becomes quiescent. Forcing a
        // reconnect here creates an endless workspace repair/reload loop while
        // the same configured-range write is still in progress.
        this.markRestoreAuthorityPending(ws, sessionId);
        this.scheduleRestoreAuthorityRetry(ws, sessionId, 'repair');
        return;
      }
      this.sendScreenRepairReconnectRequired(
        ws,
        sessionId,
        pending.repairToken,
        repair.reason,
        repair.reason === 'headless-degraded' || repair.reason === 'generation-failed'
          ? 'authority-unavailable'
          : 'reconnect-required',
      );
      return;
    }

    this.armScreenRepairAckTimeout(ws, sessionId, pending, repair.payload.seq);
    this.sendTo(ws, {
      type: 'screen-repair',
      sessionId,
      repairToken: pending.repairToken,
      seq: repair.payload.seq,
      cols: repair.payload.cols,
      rows: repair.payload.rows,
      bufferType: repair.payload.bufferType,
      cursor: repair.payload.cursor,
      viewportRows: repair.payload.viewportRows,
      ansiPatch: repair.payload.ansiPatch,
      source: 'headless',
    });
    this.recordReplayEvent({
      kind: 'screen_repair_sent',
      sessionId,
      repairToken: pending.repairToken,
      snapshotSeq: repair.payload.seq,
      details: {
        reason,
        cols: repair.payload.cols,
        rows: repair.payload.rows,
        bufferType: repair.payload.bufferType,
        rowCount: repair.payload.viewportRows.length,
        byteLength: Buffer.byteLength(repair.payload.ansiPatch, 'utf8'),
      },
    });
  }

  private handleScreenRepairReady(ws: WebSocket, sessionId: string, repairToken: string): void {
    const result = this.consumeScreenRepairPendingForPair(ws, sessionId, repairToken);
    if (result.status !== 'ok') {
      this.recordReplayEvent({
        kind: 'screen_repair_ack_stale',
        sessionId,
        repairToken,
        snapshotSeq: result.screenSeq,
        details: {
          reason: result.reason,
          activeRepairToken: result.activeRepairToken ?? null,
        },
      });
      return;
    }

    this.recordReplayEvent({
      kind: 'screen_repair_ack_ok',
      sessionId,
      repairToken,
      snapshotSeq: result.screenSeq,
      details: {
        queuedBytes: result.ackQueuedOutputBytes,
        totalQueuedBytes: result.queuedOutputBytes,
      },
    });
    this.flushScreenRepairQueuedOutputChunks(
      ws,
      sessionId,
      repairToken,
      result.screenSeq,
      result.ackQueuedOutputChunks,
      'ack',
    );
    if (ws.readyState === WebSocket.OPEN) {
      this.sendTo(ws, {
        type: 'session:ready',
        sessionId,
        repairToken,
        snapshotSeq: result.screenSeq,
      });
    }
  }

  private handleScreenRepairFailed(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    reason: ScreenRepairFailedReason,
  ): void {
    const result = this.consumeScreenRepairPendingForPair(ws, sessionId, repairToken);
    if (result.status !== 'ok') {
      this.recordReplayEvent({
        kind: 'screen_repair_ack_stale',
        sessionId,
        repairToken,
        snapshotSeq: result.screenSeq,
        details: {
          reason: result.reason,
          clientFailureReason: reason,
          activeRepairToken: result.activeRepairToken ?? null,
        },
      });
      return;
    }

    this.recordReplayEvent({
      kind: 'screen_repair_failed',
      sessionId,
      repairToken,
      snapshotSeq: result.screenSeq,
      details: {
        reason,
        queuedBytes: result.queuedOutputBytes,
      },
    });
    if (reason === 'parse-failed') {
      this.sendScreenRepairReconnectRequired(ws, sessionId, repairToken, 'parse-failed', 'reconnect-required');
      return;
    }
    this.startScreenRepairSnapshotRecovery(
      ws,
      sessionId,
      repairToken,
      reason,
      result.queuedOutputChunks,
    );
  }

  private handleDisconnect(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    const control = meta?.channelRole === 'output' ? this.splitSocketGroups.get(ws)?.control : ws;
    const fairDelivery = control ? this.fairDeliverySchedulers.get(control) : undefined;
    if (fairDelivery) {
      clearInterval(fairDelivery.maintenanceTimer);
      fairDelivery.scheduler.closeConnection(fairDelivery.connectionEpoch);
      this.fairDeliverySchedulers.delete(control!);
    }
    if (control) {
      this.fairDeliveryEpochGenerations.delete(control);
    }
    if (meta) {
      console.log(`[WS] Client disconnected: ${meta.clientId}`);
      for (const [sessionId, viewGeneration] of [...(meta.retainedTerminalViews ?? [])]) {
        this.sessionManager.unregisterRetainedTerminalClientView(
          sessionId,
          meta.clientId,
          viewGeneration,
        );
        meta.retainedTerminalViews?.delete(sessionId);
        meta.retainedTerminalMutationLeases?.delete(sessionId);
        meta.terminalAuthorityViewRegistrations?.delete(sessionId);
        meta.terminalAuthorityRecoveryEvidence?.delete(sessionId);
        this.terminalAuthorityTopologyObserver?.({
          sessionId,
          kind: 'disconnect',
          connectionId: meta.connectionId ?? meta.clientId,
          viewGeneration,
        });
      }
      meta.retainedTerminalViews?.clear();
      meta.retainedTerminalMutationLeases?.clear();
      meta.terminalAuthorityViewRegistrations?.clear();
      meta.terminalAuthorityRecoveryEvidence?.clear();
      for (const sessionId of meta.subscribedSessions) {
        this.clearReplayPendingForPair(ws, sessionId, 'transport-closed');
        this.clearScreenRepairPendingForPair(ws, sessionId, 'transport-closed');
        const subscribers = this.sessionSubscribers.get(sessionId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            this.sessionSubscribers.delete(sessionId);
          }
        }
      }
    }

    this.clearTransportQueueState(ws);
    this.terminalDeliveryVisibilityBySocket.delete(ws);
    this.terminalDeliveryCheckpointLedgers.delete(ws);
    this.settleTerminalResourcePolicyTargetOnTransportClose(ws);
    this.clients.delete(ws);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, meta] of this.clients) {
        if (!meta.isAlive) {
          console.log(`[WS] Client ${meta.clientId} failed heartbeat, terminating`);
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);

    this.heartbeatTimer.unref();
  }

  private markReplayPending(
    ws: WebSocket,
    sessionId: string,
    snapshotMetadata: ReplaySnapshotMetadata,
  ): ReplayPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }

    this.clearReplayPendingForPair(ws, sessionId, 'context-changed');

    const state: ReplayPendingState = {
      queuedOutput: '',
      coveredQueuedOutput: '',
      queuedOutputChunks: [],
      coveredQueuedOutputChunks: [],
      queuedOutputBytes: 0,
      coveredQueuedOutputBytes: 0,
      coveredQueuedOutputRetainedBytes: 0,
      preserveOutputChunkIdentity: true,
      queuedOutputTruncated: false,
      queuedOutputMaxScreenSeq: null,
      coveredQueuedOutputMaxScreenSeq: null,
      queuedInputs: [],
      queuedInputBytes: 0,
      replayToken: uuidv4(),
      snapshotSeq: snapshotMetadata.snapshotSeq,
      snapshotMode: snapshotMetadata.snapshotMode,
      snapshotDataLength: snapshotMetadata.snapshotDataLength,
      snapshotTruncated: snapshotMetadata.snapshotTruncated,
      snapshotCols: snapshotMetadata.snapshotCols,
      snapshotRows: snapshotMetadata.snapshotRows,
      timer: setTimeout(() => {
        this.handleReplayAckTimeout(ws, sessionId, state.replayToken, snapshotMetadata.snapshotSeq, 'timeout');
      }, REPLAY_ACK_TIMEOUT_MS),
    };
    state.timer.unref();
    meta.replayPendingSessions.set(sessionId, state);
    return state;
  }

  // Install the server-side fence before an atomic restore snapshot exists.
  // This closes the small pending-headless-write window in which the client is
  // subscribed but has not received a replay token yet. Output and input use
  // the same bounded ReplayPendingState queues and are promoted into the real
  // snapshot transaction when authority becomes stable.
  // @req REL-BGSTAB-009
  private markRestoreAuthorityPending(
    ws: WebSocket,
    sessionId: string,
    supersedesReplayToken?: string,
  ): ReplayPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }
    const existing = meta.replayPendingSessions.get(sessionId);
    if (existing) {
      if (supersedesReplayToken !== undefined) {
        existing.supersedesReplayToken = supersedesReplayToken;
      }
      return existing;
    }
    const state = this.markReplayPending(ws, sessionId, {
      snapshotSeq: -1,
      snapshotMode: 'fallback',
      snapshotDataLength: 0,
      snapshotTruncated: false,
      snapshotCols: 0,
      snapshotRows: 0,
    });
    state.authorityPending = true;
    state.supersedesReplayToken = supersedesReplayToken;
    this.recordReplayEvent({
      kind: 'snapshot_refresh_skipped',
      sessionId,
      replayToken: state.replayToken,
      snapshotSeq: state.snapshotSeq,
      details: {
        reason: 'authority-pending-fence-installed',
      },
    });
    return state;
  }

  private takeRestoreAuthorityPendingSeed(
    ws: WebSocket,
    sessionId: string,
  ): {
    queuedOutputChunks: ScreenRepairQueuedOutput[];
    queuedInputs: QueuedReplayInput[];
    queuedInputBytes: number;
    queuedOutputTruncated: boolean;
    supersedesReplayToken?: string;
  } | null {
    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(sessionId);
    if (!meta || !pending?.authorityPending) {
      return null;
    }
    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    return {
      queuedOutputChunks: [
        ...pending.coveredQueuedOutputChunks,
        ...pending.queuedOutputChunks,
      ],
      queuedInputs: pending.queuedInputs,
      queuedInputBytes: pending.queuedInputBytes,
      queuedOutputTruncated: pending.queuedOutputTruncated,
      supersedesReplayToken: pending.supersedesReplayToken,
    };
  }

  private failRestoreAuthorityPending(
    ws: WebSocket,
    sessionId: string,
    outcome: 'authority-unavailable' | 'reconnect-required' = 'authority-unavailable',
  ): void {
    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(sessionId);
    if (!meta || !pending?.authorityPending) {
      return;
    }
    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    this.rejectQueuedReplayInputs(ws, sessionId, pending, 'timeout');
    this.sendScreenRepairReconnectRequired(
      ws,
      sessionId,
      pending.replayToken,
      'authority-unavailable',
      outcome,
      pending.replayToken,
    );
  }

  private consumeReplayPendingForPair(
    ws: WebSocket,
    sessionId: string,
    replayToken: string,
  ):
    | {
        status: 'ok';
        queuedOutput: string;
        coveredQueuedOutput: string;
        queuedOutputChunks: ScreenRepairQueuedOutput[];
        queuedOutputBytes: number;
        coveredQueuedOutputBytes: number;
        preserveOutputChunkIdentity: boolean;
        queuedOutputTruncated: boolean;
        queuedInputs: QueuedReplayInput[];
        queuedInputBytes: number;
        snapshotSeq: number;
        snapshotMode: ReplaySnapshotMode;
        snapshotTruncated: boolean;
        recoveryRepairToken?: string;
      }
    | { status: 'stale'; reason: 'missing' | 'token-mismatch'; snapshotSeq?: number; activeReplayToken?: string } {
    const meta = this.clients.get(ws);
    if (!meta) {
      return { status: 'stale', reason: 'missing' };
    }

    const pending = meta.replayPendingSessions.get(sessionId);
    if (!pending) {
      return { status: 'stale', reason: 'missing' };
    }
    if (pending.replayToken !== replayToken) {
      return {
        status: 'stale',
        reason: 'token-mismatch',
        snapshotSeq: pending.snapshotSeq,
        activeReplayToken: pending.replayToken,
      };
    }

    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    return {
      status: 'ok',
      queuedOutput: pending.queuedOutput,
      coveredQueuedOutput: pending.coveredQueuedOutput,
      queuedOutputChunks: pending.queuedOutputChunks,
      queuedOutputBytes: pending.queuedOutputBytes,
      coveredQueuedOutputBytes: pending.coveredQueuedOutputBytes,
      preserveOutputChunkIdentity: pending.preserveOutputChunkIdentity,
      queuedOutputTruncated: pending.queuedOutputTruncated,
      queuedInputs: pending.queuedInputs,
      queuedInputBytes: pending.queuedInputBytes,
      snapshotSeq: pending.snapshotSeq,
      snapshotMode: pending.snapshotMode,
      snapshotTruncated: pending.snapshotTruncated,
      recoveryRepairToken: pending.recoveryRepairToken,
    };
  }

  private clearReplayPendingForPair(
    ws: WebSocket,
    sessionId: string,
    reason: InputRejectedReason = 'context-changed',
  ): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const pending = meta.replayPendingSessions.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    this.rejectQueuedReplayInputs(ws, sessionId, pending, reason);
  }

  private trimReplayOutputTail(data: string): { content: string; truncated: boolean } {
    return truncateTerminalPayloadTail(data, this.sessionManager.getReplayQueueLimit());
  }

  private mergeScreenSeq(
    current: number | null,
    next: number | undefined | null,
  ): number | null {
    if (typeof next !== 'number' || !Number.isFinite(next)) {
      return current;
    }
    return current === null ? next : Math.max(current, next);
  }

  // @req REL-BGSTAB-008
  private nextSessionOutputChunkId(sessionId: string): string {
    const nextOrdinal = (this.sessionOutputChunkOrdinals.get(sessionId) ?? 0n) + 1n;
    this.sessionOutputChunkOrdinals.set(sessionId, nextOrdinal);
    return nextOrdinal.toString(10);
  }

  private appendQueuedOutput(
    sessionId: string,
    state: ReplayPendingState,
    data: string,
    outputScreenSeq?: number,
    chunkId?: string,
    authority?: OutputAuthorityMetadata,
  ): boolean {
    if (state.preserveOutputChunkIdentity) {
      return this.appendPreservedReplayOutput(sessionId, state, {
        data,
        byteLength: utf8ByteLength(data),
        screenSeq: outputScreenSeq,
        authorityEpoch: authority?.authorityEpoch,
        authorityRevision: authority?.authorityRevision,
        chunkId,
      });
    }

    const next = `${state.queuedOutput}${data}`;
    const trimmed = this.trimReplayOutputTail(next);
    state.queuedOutput = trimmed.content;
    state.queuedOutputTruncated = state.queuedOutputTruncated || trimmed.truncated;
    state.queuedOutputMaxScreenSeq = this.mergeScreenSeq(state.queuedOutputMaxScreenSeq, outputScreenSeq);
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, utf8ByteLength(state.queuedOutput));
    return true;
  }

  // @req REL-BGSTAB-008
  private appendPreservedReplayOutput(
    sessionId: string,
    state: ReplayPendingState,
    chunk: ScreenRepairQueuedOutput,
  ): boolean {
    const identifiedChunk = chunk.chunkId
      ? chunk
      : { ...chunk, chunkId: this.nextSessionOutputChunkId(sessionId) };
    if (typeof identifiedChunk.screenSeq === 'number' && identifiedChunk.screenSeq <= state.snapshotSeq) {
      // The current authoritative snapshot already covers this chunk. Keep
      // redacted accounting only: retaining another payload copy would consume
      // the bounded post-snapshot tail budget and can cause a false reoverflow
      // before ACK. Failed recovery still converges through a fresh authority
      // transaction or explicit reconnect, never by replaying this prefix.
      state.coveredQueuedOutputBytes += identifiedChunk.byteLength;
      state.coveredQueuedOutputMaxScreenSeq = this.mergeScreenSeq(
        state.coveredQueuedOutputMaxScreenSeq,
        identifiedChunk.screenSeq,
      );
      return true;
    }
    const policy = this.getScreenRepairQueuePolicy();
    if (
      state.queuedOutputBytes + state.coveredQueuedOutputRetainedBytes + identifiedChunk.byteLength > policy.maxBytes
      || state.queuedOutputChunks.length + state.coveredQueuedOutputChunks.length + 1 > policy.maxChunks
    ) {
      return false;
    }
    state.queuedOutputChunks.push(identifiedChunk);
    state.queuedOutputBytes += identifiedChunk.byteLength;
    state.queuedOutputMaxScreenSeq = this.mergeScreenSeq(
      state.queuedOutputMaxScreenSeq,
      identifiedChunk.screenSeq,
    );
    this.maxReplayQueueLengthObserved = Math.max(
      this.maxReplayQueueLengthObserved,
      state.queuedOutputBytes + state.coveredQueuedOutputBytes,
    );
    return true;
  }

  // @req REL-BGSTAB-008
  private handlePreservedReplayQueueOverflow(
    ws: WebSocket,
    sessionId: string,
    state: ReplayPendingState,
    data: string,
    outputScreenSeq?: number,
  ): void {
    const meta = this.clients.get(ws);
    if (!meta || meta.replayPendingSessions.get(sessionId) !== state) {
      return;
    }
    clearTimeout(state.timer);
    meta.replayPendingSessions.delete(sessionId);
    this.rejectQueuedReplayInputs(ws, sessionId, state, 'queue-overflow');

    const policy = this.getScreenRepairQueuePolicy();
    const outputBytes = utf8ByteLength(data);
    const byteCapExceeded = state.queuedOutputBytes + state.coveredQueuedOutputRetainedBytes + outputBytes > policy.maxBytes;
    this.recordReplayEvent({
      kind: 'screen_repair_queue_overflow',
      sessionId,
      replayToken: state.replayToken,
      repairToken: state.recoveryRepairToken,
      snapshotSeq: state.snapshotSeq,
      details: {
        queuedBytes: state.queuedOutputBytes + state.coveredQueuedOutputBytes,
        queuedChunks: state.queuedOutputChunks.length + state.coveredQueuedOutputChunks.length,
        outputBytes,
        sourceSequence: outputScreenSeq ?? null,
        maxQueuedBytes: policy.maxBytes,
        maxQueuedChunks: policy.maxChunks,
        reason: byteCapExceeded ? 'byte-cap-exceeded' : 'chunk-cap-exceeded',
        outcome: 'reconnect-required',
        source: policy.source,
        phase: 'fresh-snapshot-barrier',
      },
    });

    this.sendScreenRepairReconnectRequired(
      ws,
      sessionId,
      state.recoveryRepairToken ?? state.replayToken,
      byteCapExceeded ? 'byte-cap-exceeded' : 'chunk-cap-exceeded',
      'reconnect-required',
      state.replayToken,
    );
  }

  private markQueuedOutputCoveredBySnapshot(state: ReplayPendingState): void {
    if (state.preserveOutputChunkIdentity) {
      if (state.queuedOutputChunks.length === 0) {
        return;
      }
      state.coveredQueuedOutputBytes += state.queuedOutputBytes;
      state.coveredQueuedOutputRetainedBytes += state.queuedOutputBytes;
      state.coveredQueuedOutputChunks.push(...state.queuedOutputChunks);
      state.queuedOutputChunks = [];
      state.queuedOutputBytes = 0;
      state.coveredQueuedOutputMaxScreenSeq = this.mergeScreenSeq(
        state.coveredQueuedOutputMaxScreenSeq,
        state.queuedOutputMaxScreenSeq,
      );
      state.queuedOutputMaxScreenSeq = null;
      return;
    }

    if (state.queuedOutput.length === 0) {
      return;
    }

    const trimmed = this.trimReplayOutputTail(`${state.coveredQueuedOutput}${state.queuedOutput}`);
    state.coveredQueuedOutput = trimmed.content;
    state.queuedOutput = '';
    state.queuedOutputTruncated = state.queuedOutputTruncated || trimmed.truncated;
    state.coveredQueuedOutputMaxScreenSeq = this.mergeScreenSeq(
      state.coveredQueuedOutputMaxScreenSeq,
      state.queuedOutputMaxScreenSeq,
    );
    state.queuedOutputMaxScreenSeq = null;
    this.maxReplayQueueLengthObserved = Math.max(
      this.maxReplayQueueLengthObserved,
      utf8ByteLength(state.coveredQueuedOutput),
    );
  }

  private uncoverQueuedOutput(state: ReplayPendingState): void {
    if (state.preserveOutputChunkIdentity) {
      if (state.coveredQueuedOutputChunks.length === 0) {
        return;
      }
      state.queuedOutputChunks = [
        ...state.coveredQueuedOutputChunks,
        ...state.queuedOutputChunks,
      ];
      state.queuedOutputBytes += state.coveredQueuedOutputRetainedBytes;
      state.coveredQueuedOutputChunks = [];
      state.coveredQueuedOutputBytes = 0;
      state.coveredQueuedOutputRetainedBytes = 0;
      state.queuedOutputMaxScreenSeq = this.mergeScreenSeq(
        state.queuedOutputMaxScreenSeq,
        state.coveredQueuedOutputMaxScreenSeq,
      );
      state.coveredQueuedOutputMaxScreenSeq = null;
      return;
    }

    if (state.coveredQueuedOutput.length === 0) {
      return;
    }

    const trimmed = this.trimReplayOutputTail(`${state.coveredQueuedOutput}${state.queuedOutput}`);
    state.queuedOutput = trimmed.content;
    state.coveredQueuedOutput = '';
    state.queuedOutputTruncated = state.queuedOutputTruncated || trimmed.truncated;
    state.queuedOutputMaxScreenSeq = this.mergeScreenSeq(
      state.queuedOutputMaxScreenSeq,
      state.coveredQueuedOutputMaxScreenSeq,
    );
    state.coveredQueuedOutputMaxScreenSeq = null;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, utf8ByteLength(state.queuedOutput));
  }

  private getReplayQueuedByteMetrics(state: ReplayPendingState): {
    queuedBytes: number;
    coveredQueuedBytes: number;
  } {
    return state.preserveOutputChunkIdentity
      ? {
          queuedBytes: state.queuedOutputBytes,
          coveredQueuedBytes: state.coveredQueuedOutputBytes,
        }
      : {
          queuedBytes: utf8ByteLength(state.queuedOutput),
          coveredQueuedBytes: utf8ByteLength(state.coveredQueuedOutput),
        };
  }

  private getScreenRepairPendingSessions(meta: WsClientMeta): Map<string, ScreenRepairPendingState> {
    if (!meta.screenRepairPendingSessions) {
      meta.screenRepairPendingSessions = new Map();
    }
    return meta.screenRepairPendingSessions;
  }

  private markScreenRepairPending(ws: WebSocket, sessionId: string, screenSeq: number): ScreenRepairPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }

    const repairToken = uuidv4();
    const state: ScreenRepairPendingState = {
      queuedOutputBytes: 0,
      queuedOutputChunks: [],
      repairToken,
      screenSeq,
    };
    this.getScreenRepairPendingSessions(meta).set(sessionId, state);
    return state;
  }

  private armScreenRepairAckTimeout(
    ws: WebSocket,
    sessionId: string,
    state: ScreenRepairPendingState,
    screenSeq: number,
  ): void {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.screenSeq = screenSeq;
    state.timer = setTimeout(() => {
      this.handleScreenRepairAckTimeout(ws, sessionId, state.repairToken, screenSeq);
    }, SCREEN_REPAIR_ACK_TIMEOUT_MS);
    state.timer.unref();
  }

  private consumeScreenRepairPendingForPair(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
  ):
    | {
        status: 'ok';
        queuedOutputChunks: ScreenRepairQueuedOutput[];
        queuedOutputBytes: number;
        ackQueuedOutputChunks: ScreenRepairQueuedOutput[];
        ackQueuedOutputBytes: number;
        screenSeq: number;
      }
    | { status: 'stale'; reason: 'missing' | 'token-mismatch'; screenSeq?: number; activeRepairToken?: string } {
    const meta = this.clients.get(ws);
    if (!meta) {
      return { status: 'stale', reason: 'missing' };
    }

    const pendingSessions = this.getScreenRepairPendingSessions(meta);
    const pending = pendingSessions.get(sessionId);
    if (!pending) {
      return { status: 'stale', reason: 'missing' };
    }
    if (pending.repairToken !== repairToken) {
      return {
        status: 'stale',
        reason: 'token-mismatch',
        screenSeq: pending.screenSeq,
        activeRepairToken: pending.repairToken,
      };
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pendingSessions.delete(sessionId);
    const ackQueued = this.getScreenRepairAckQueuedOutput(pending);
    return {
      status: 'ok',
      queuedOutputChunks: pending.queuedOutputChunks,
      queuedOutputBytes: pending.queuedOutputBytes,
      ackQueuedOutputChunks: ackQueued.chunks,
      ackQueuedOutputBytes: ackQueued.byteLength,
      screenSeq: pending.screenSeq,
    };
  }

  private getScreenRepairAckQueuedOutput(
    state: ScreenRepairPendingState,
  ): { chunks: ScreenRepairQueuedOutput[]; byteLength: number } {
    const chunks = state.queuedOutputChunks.filter((chunk) => (
      typeof chunk.screenSeq !== 'number' || chunk.screenSeq > state.screenSeq
    ));
    return {
      chunks,
      byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    };
  }

  private clearScreenRepairPendingForPair(ws: WebSocket, sessionId: string, _reason: string): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const pendingSessions = this.getScreenRepairPendingSessions(meta);
    const pending = pendingSessions.get(sessionId);
    if (!pending) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pendingSessions.delete(sessionId);
  }

  private appendScreenRepairQueuedOutput(
    ws: WebSocket,
    sessionId: string,
    state: ScreenRepairPendingState,
    data: string,
    outputScreenSeq?: number,
    chunkId?: string,
    authority?: OutputAuthorityMetadata,
  ): boolean {
    const policy = this.getScreenRepairQueuePolicy();
    const outputByteLength = Buffer.byteLength(data, 'utf8');
    const nextByteLength = state.queuedOutputBytes + outputByteLength;
    const nextChunkCount = state.queuedOutputChunks.length + 1;
    const byteCapExceeded = nextByteLength > policy.maxBytes;
    const chunkCapExceeded = nextChunkCount > policy.maxChunks;
    if (byteCapExceeded || chunkCapExceeded) {
      const recoveryChunks = [
        ...state.queuedOutputChunks,
        {
          data,
          byteLength: outputByteLength,
          screenSeq: outputScreenSeq,
          authorityEpoch: authority?.authorityEpoch,
          authorityRevision: authority?.authorityRevision,
          chunkId,
        },
      ];
      const meta = this.clients.get(ws);
      if (meta) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        this.getScreenRepairPendingSessions(meta).delete(sessionId);
      }

      const recoveryStarted = this.startScreenRepairSnapshotRecovery(
        ws,
        sessionId,
        state.repairToken,
        byteCapExceeded ? 'byte-cap-exceeded' : 'chunk-cap-exceeded',
        recoveryChunks,
      );
      this.recordReplayEvent({
        kind: 'screen_repair_queue_overflow',
        sessionId,
        repairToken: state.repairToken,
        snapshotSeq: state.screenSeq,
        details: {
          queuedBytes: state.queuedOutputBytes,
          queuedChunks: state.queuedOutputChunks.length,
          outputBytes: outputByteLength,
          sourceSequence: outputScreenSeq ?? null,
          maxQueuedBytes: policy.maxBytes,
          maxQueuedChunks: policy.maxChunks,
          reason: byteCapExceeded ? 'byte-cap-exceeded' : 'chunk-cap-exceeded',
          outcome: recoveryStarted ? 'restore-needed' : 'reconnect-required',
          source: policy.source,
        },
      });
      return false;
    }

    state.queuedOutputChunks.push({
      data,
      byteLength: outputByteLength,
      screenSeq: outputScreenSeq,
      authorityEpoch: authority?.authorityEpoch,
      authorityRevision: authority?.authorityRevision,
      chunkId,
    });
    state.queuedOutputBytes = nextByteLength;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, state.queuedOutputBytes);
    return true;
  }

  private handleScreenRepairAckTimeout(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    screenSeq: number,
  ): void {
    const meta = this.clients.get(ws);
    const pending = meta ? this.getScreenRepairPendingSessions(meta).get(sessionId) : undefined;
    if (!meta || !pending || pending.repairToken !== repairToken) {
      return;
    }

    this.screenRepairAckTimeoutCount += 1;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.getScreenRepairPendingSessions(meta).delete(sessionId);
    this.recordReplayEvent({
      kind: 'screen_repair_ack_timeout',
      sessionId,
      repairToken,
      snapshotSeq: screenSeq,
      details: {
        queuedBytes: pending.queuedOutputBytes,
        queuedChunks: pending.queuedOutputChunks.length,
      },
    });
    this.startScreenRepairSnapshotRecovery(
      ws,
      sessionId,
      repairToken,
      'ack-timeout',
      pending.queuedOutputChunks,
    );
  }

  // @req REL-BGSTAB-008
  private flushScreenRepairQueuedOutputChunks(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    screenSeq: number,
    queuedOutputChunks: readonly ScreenRepairQueuedOutput[],
    phase: 'ack',
  ): void {
    if (queuedOutputChunks.length === 0 || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const chunk of queuedOutputChunks) {
      this.sendNonCoalescingOutputChunk(ws, sessionId, chunk.data, {
        repairToken,
        screenSeq: chunk.screenSeq,
        authorityEpoch: chunk.authorityEpoch,
        authorityRevision: chunk.authorityRevision,
        chunkId: chunk.chunkId,
      });
      this.recordReplayEvent({
        kind: 'screen_repair_output_flushed',
        sessionId,
        repairToken,
        snapshotSeq: screenSeq,
        details: {
          phase,
          outputBytes: chunk.byteLength,
          outputScreenSeq: chunk.screenSeq ?? null,
        },
      });
    }
  }

  // @req REL-BGSTAB-008
  private getScreenRepairQueuePolicy(): {
    maxBytes: number;
    maxChunks: number;
    source: 'compatibility-cap';
  } {
    const policyGetter = (
      this.sessionManager as unknown as {
        getScreenRepairQueuePolicy?: SessionManager['getScreenRepairQueuePolicy'];
      }
    ).getScreenRepairQueuePolicy;
    if (typeof policyGetter === 'function') {
      return policyGetter.call(this.sessionManager);
    }
    const legacyReplayLimitGetter = (
      this.sessionManager as unknown as {
        getReplayQueueLimit?: SessionManager['getReplayQueueLimit'];
      }
    ).getReplayQueueLimit;
    return {
      maxBytes: Math.min(
        typeof legacyReplayLimitGetter === 'function'
          ? legacyReplayLimitGetter.call(this.sessionManager)
          : this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes,
        262_144,
      ),
      maxChunks: 512,
      source: 'compatibility-cap',
    };
  }

  // @req REL-BGSTAB-008
  private startScreenRepairSnapshotRecovery(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    reason: ScreenRepairRecoveryReason,
    queuedOutputChunks: readonly ScreenRepairQueuedOutput[],
    supersedesReplayToken?: string,
  ): boolean {
    const meta = this.clients.get(ws);
    if (
      ws.readyState !== WebSocket.OPEN
      || !meta
      || !meta.subscribedSessions.has(sessionId)
    ) {
      return false;
    }

    this.discardQueuedRecoveryFrames(ws, sessionId, repairToken);

    const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
    if (
      !snapshot
      || snapshot.health !== 'healthy'
      || (snapshot.truncated && snapshot.data.length === 0)
    ) {
      this.sendScreenRepairReconnectRequired(
        ws,
        sessionId,
        repairToken,
        'authority-unavailable',
        'authority-unavailable',
      );
      return false;
    }

    const uncoveredChunks = queuedOutputChunks.filter(chunk => (
      typeof chunk.screenSeq !== 'number' || chunk.screenSeq > snapshot.seq
    ));
    const uncoveredBytes = uncoveredChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const policy = this.getScreenRepairQueuePolicy();
    if (uncoveredBytes > policy.maxBytes || uncoveredChunks.length > policy.maxChunks) {
      this.sendScreenRepairReconnectRequired(
        ws,
        sessionId,
        repairToken,
        reason,
        'reconnect-required',
      );
      return false;
    }

    this.sendSnapshotReplay(ws, sessionId, snapshot, 'repair', {
      queuedOutputChunks,
      preserveOutputChunkIdentity: true,
      recoveryRepairToken: repairToken,
      supersedesReplayToken,
      beforeSnapshot: (replayState) => {
        this.sendPriorityControl(ws, {
          type: 'screen-repair:restore-needed',
          sessionId,
          repairToken,
          state: 'stale',
          reason,
          outcome: 'fresh-snapshot-started',
          replayToken: replayState.replayToken,
          snapshotSeq: replayState.snapshotSeq,
          authorityEpoch: snapshot.authorityEpoch,
          authorityRevision: snapshot.authorityRevision,
          coversThroughSeq: snapshot.seq,
          supersedesReplayToken,
        });
        this.recordReplayEvent({
          kind: 'screen_repair_restore_needed',
          sessionId,
          repairToken,
          replayToken: replayState.replayToken,
          snapshotSeq: replayState.snapshotSeq,
          details: {
            reason,
            outcome: 'fresh-snapshot-started',
            queuedBytes: queuedOutputChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
            queuedChunks: queuedOutputChunks.length,
          },
        });
      },
    });
    return true;
  }

  // @req REL-BGSTAB-008
  private sendScreenRepairReconnectRequired(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    reason: ScreenRepairRecoveryReason,
    outcome: 'authority-unavailable' | 'reconnect-required',
    supersededReplayToken?: string,
  ): void {
    if (ws.readyState !== WebSocket.OPEN || !this.clients.has(ws)) {
      return;
    }
    this.discardQueuedRecoveryFrames(ws, sessionId, repairToken, supersededReplayToken);
    this.sendPriorityControl(ws, {
      type: 'screen-repair:reconnect-required',
      sessionId,
      repairToken,
      reason,
      outcome,
    });
    this.recordReplayEvent({
      kind: 'screen_repair_reconnect_required',
      sessionId,
      repairToken,
      details: {
        reason,
        outcome,
      },
    });
  }

  private sendScreenRepairRejected(
    ws: WebSocket,
    sessionId: string,
    reason: ScreenRepairRejectedReason,
    repairToken?: string,
    cols?: number,
    rows?: number,
  ): void {
    this.sendTo(ws, {
      type: 'screen-repair:rejected',
      sessionId,
      repairToken,
      reason,
      cols,
      rows,
    });
    this.recordReplayEvent({
      kind: 'screen_repair_rejected',
      sessionId,
      repairToken,
      details: {
        reason,
        cols: cols ?? null,
        rows: rows ?? null,
      },
    });
  }

  private mapScreenRepairRejectReason(
    reason: 'geometry-mismatch' | 'buffer-mismatch' | 'headless-degraded' | 'headless-busy' | 'generation-failed',
  ): ScreenRepairRejectedReason {
    return reason === 'headless-busy' ? 'pending' : reason;
  }

  private validateScreenRepairRequest(message: unknown):
    | { ok: true; message: ScreenRepairRequestMessage }
    | { ok: false; sessionId?: string; reason: ScreenRepairRejectedReason } {
    if (!isRecord(message)) {
      return { ok: false, reason: 'generation-failed' };
    }

    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const cols = message.cols;
    const rows = message.rows;
    const reason = message.reason;
    const clientAtBottom = message.clientAtBottom;
    const clientBufferType = message.clientBufferType;

    if (
      !sessionId
      || typeof cols !== 'number'
      || typeof rows !== 'number'
      || !Number.isSafeInteger(cols)
      || !Number.isSafeInteger(rows)
      || cols <= 0
      || rows <= 0
    ) {
      return { ok: false, sessionId, reason: 'geometry-mismatch' };
    }
    if (!isScreenRepairReason(reason)) {
      return { ok: false, sessionId, reason: 'generation-failed' };
    }
    if (typeof clientAtBottom !== 'boolean') {
      return { ok: false, sessionId, reason: 'apply-rejected' };
    }
    if (!isScreenRepairBufferType(clientBufferType)) {
      return { ok: false, sessionId, reason: 'buffer-mismatch' };
    }

    return {
      ok: true,
      message: {
        type: 'screen-repair',
        sessionId,
        cols,
        rows,
        reason,
        clientAtBottom,
        clientBufferType,
      },
    };
  }

  private appendQueuedInput(
    ws: WebSocket,
    sessionId: string,
    state: ReplayPendingState,
    input: QueuedReplayInput,
  ): boolean {
    if (state.queuedInputBytes + input.byteLength > MAX_REPLAY_QUEUED_INPUT_BYTES) {
      this.recordReplayEvent({
        kind: this.inputReliabilityMode === 'observe' ? 'replay_input_would_reject' : 'input_queue_overflow',
        sessionId,
        replayToken: state.replayToken,
        snapshotSeq: state.snapshotSeq,
        details: {
          mode: this.inputReliabilityMode,
          reason: 'queue-overflow',
          queuedInputBytes: state.queuedInputBytes,
          queuedInputCount: state.queuedInputs.length,
          maxQueuedInputBytes: MAX_REPLAY_QUEUED_INPUT_BYTES,
          ...this.buildQueuedInputReplayDetails(input),
        },
      });
      this.rejectInput(ws, {
        sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'queue-overflow',
        replayToken: state.replayToken,
        snapshotSeq: state.snapshotSeq,
      });
      return false;
    }

    state.queuedInputs.push(input);
    state.queuedInputBytes += input.byteLength;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, state.queuedInputBytes);
    return true;
  }

  private handleReplayAckTimeout(
    ws: WebSocket,
    sessionId: string,
    replayToken: string,
    snapshotSeq: number,
    readyReason: 'timeout' | 'refresh-timeout',
  ): void {
    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(sessionId);
    if (!meta || !pending || pending.replayToken !== replayToken) {
      return;
    }

    this.replayAckTimeoutCount += 1;
    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);

    this.rejectQueuedReplayInputsOnTimeout(ws, sessionId, pending);
    this.recordReplayEvent({
      kind: 'screen_repair_restore_needed',
      sessionId,
      replayToken,
      snapshotSeq,
      details: {
        reason: 'ack-timeout',
        outcome: 'reconnect-required',
        phase: readyReason,
        queuedBytes: this.getReplayQueuedByteMetrics(pending).queuedBytes,
        coveredQueuedBytes: this.getReplayQueuedByteMetrics(pending).coveredQueuedBytes,
        queuedInputCount: pending.queuedInputs.length,
      },
    });
    this.sendScreenRepairReconnectRequired(
      ws,
      sessionId,
      pending.recoveryRepairToken ?? replayToken,
      'ack-timeout',
      'reconnect-required',
      replayToken,
    );
  }

  private flushQueuedReplayInputs(
    ws: WebSocket,
    sessionId: string,
    replayToken: string,
    snapshotSeq: number,
    inputs: QueuedReplayInput[],
  ): void {
    for (const input of inputs) {
      const ageMs = Date.now() - input.queuedAt;

      if (ageMs > MAX_REPLAY_QUEUED_INPUT_AGE_MS) {
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: 'timeout',
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      let gatewayResult: WebSocketInputGatewayResult = { accepted: false, reason: 'server-error' };
      try {
        gatewayResult = this.submitWebSocketInputThroughGateway({
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          retainedIdentity: input.retainedIdentity,
        }, this.clients.get(ws));
      } catch (error) {
        console.error('[WS] Queued PTY input write failed:', error);
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: 'server-error',
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      if (!gatewayResult.accepted) {
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: gatewayResult.reason,
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      this.recordReplayEvent({
        kind: 'input_flushed',
        sessionId,
        replayToken,
        snapshotSeq,
        details: {
          phase: 'ack',
          ageMs,
          ...this.buildQueuedInputReplayDetails(input),
        },
      });
    }
  }

  // @req FR-MCP-002
  // @req IR-MCP-004
  private submitWebSocketInputThroughGateway(input: {
    sessionId: string;
    data: string;
    metadata?: InputDebugMetadata;
    inputSeqStart?: number;
    inputSeqEnd?: number;
    retainedIdentity?: RetainedTerminalWireMutationIdentity;
  }, meta?: WsClientMeta): WebSocketInputGatewayResult {
    const gateway = createSessionInputGateway({
      writeInput: (write) => this.sessionManager.writeInput(
        String(write.sessionId ?? ''),
        String(write.data ?? ''),
        write.metadata as InputDebugMetadata | undefined,
        {
          inputSeqStart: typeof write.inputSeqStart === 'number' ? write.inputSeqStart : undefined,
          inputSeqEnd: typeof write.inputSeqEnd === 'number' ? write.inputSeqEnd : undefined,
        },
        this.toRetainedTerminalMutationIdentity(meta, input.retainedIdentity),
      ),
      resolveTarget: () => this.resolveWebSocketGatewayTarget(input.sessionId),
      readReplayState: () => ({
        replayPending: meta?.replayPendingSessions.has(input.sessionId) === true,
        screenRepairPending: meta ? this.getScreenRepairPendingSessions(meta).has(input.sessionId) : false,
      }),
      evaluateInputPolicy: () => ({ ok: true }),
    });
    const hasReplayBarrier = meta?.replayPendingSessions.has(input.sessionId) === true
      || (meta ? this.getScreenRepairPendingSessions(meta).has(input.sessionId) : false);
    const result = gateway.submitInput({
      source: 'websocket',
      target: { sessionId: input.sessionId },
      data: input.data,
      metadata: input.metadata,
      inputSeqStart: input.inputSeqStart,
      inputSeqEnd: input.inputSeqEnd,
      delivery: { mode: 'paste', submit: input.data.includes('\r') || input.data.includes('\n') },
      replayPolicy: hasReplayBarrier ? 'reject' : 'allow',
    });
    if (result.accepted === true) {
      return { accepted: true };
    }
    return {
      accepted: false,
      reason: result.code === INPUT_REJECTED_REPLAY_PENDING ? 'context-changed' : 'server-error',
    };
  }

  // @req FR-MCP-002
  // @req IR-MCP-004
  private resolveWebSocketGatewayTarget(sessionId: string): Record<string, unknown> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return { ok: false, code: 'TARGET_NOT_LIVE' };
    }
    return {
      ok: true,
      binding: {
        sessionKey: session.id,
        currentSessionId: session.id,
        generation: 1,
        lifecycle: 'live',
      },
    };
  }

  private rejectQueuedReplayInputs(
    ws: WebSocket,
    sessionId: string,
    pending: ReplayPendingState,
    reason: InputRejectedReason,
  ): void {
    for (const input of pending.queuedInputs) {
      this.rejectInput(ws, {
        sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason,
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
      });
    }
  }

  private rejectInput(
    ws: WebSocket,
    input: {
      sessionId?: string;
      data?: string;
      metadata?: InputDebugMetadata;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      reason: InputRejectedReason;
      replayToken?: string;
      snapshotSeq?: number;
    },
  ): void {
    const sessionId = input.sessionId;
    const canRouteReject = typeof sessionId === 'string' && sessionId.length > 0;
    const rejectSent = canRouteReject && ws.readyState === WebSocket.OPEN;
    if (rejectSent) {
      this.sendTo(ws, {
        type: 'input:rejected',
        sessionId,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: input.reason,
      });
    }

    this.recordReplayEvent({
      kind: 'input_rejected',
      sessionId: canRouteReject ? sessionId : 'unknown',
      replayToken: input.replayToken,
      snapshotSeq: input.snapshotSeq,
      details: {
        reason: input.reason,
        rejectSent,
        ...(typeof input.inputSeqStart === 'number' ? { inputSeqStart: input.inputSeqStart } : {}),
        ...(typeof input.inputSeqEnd === 'number' ? { inputSeqEnd: input.inputSeqEnd } : {}),
        ...(typeof input.data === 'string' ? buildInputDebugDetails(input.data, input.metadata) : {}),
      },
    });
  }

  private buildQueuedInputReplayDetails(input: QueuedReplayInput): Record<string, string | number | boolean | null> {
    return {
      ...buildInputDebugDetails(input.data, input.metadata),
      inputSeqStart: input.inputSeqStart ?? null,
      inputSeqEnd: input.inputSeqEnd ?? null,
      queuedAt: input.queuedAt,
      byteLength: input.byteLength,
    };
  }

  private validateInputMessage(message: unknown): InputValidationResult {
    if (!isRecord(message)) {
      return { ok: false, reason: 'invalid-payload' };
    }

    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const data = typeof message.data === 'string' ? message.data : undefined;
    const inputSeqStart = typeof message.inputSeqStart === 'number' && Number.isSafeInteger(message.inputSeqStart)
      ? message.inputSeqStart
      : undefined;
    const inputSeqEnd = typeof message.inputSeqEnd === 'number' && Number.isSafeInteger(message.inputSeqEnd)
      ? message.inputSeqEnd
      : undefined;
    const retainedIdentity = this.parseRetainedTerminalWireMutationIdentity(message.retainedIdentity);

    if (Object.prototype.hasOwnProperty.call(message, 'retainedIdentity') && !retainedIdentity) {
      return {
        ok: false,
        reason: 'invalid-payload',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof data !== 'string') {
      return {
        ok: false,
        reason: 'invalid-payload',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    const byteLength = Buffer.byteLength(data, 'utf8');
    if (byteLength > MAX_REPLAY_QUEUED_INPUT_BYTES) {
      return {
        ok: false,
        reason: 'invalid-payload',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    const hasSeqStart = Object.prototype.hasOwnProperty.call(message, 'inputSeqStart');
    const hasSeqEnd = Object.prototype.hasOwnProperty.call(message, 'inputSeqEnd');
    if (Object.prototype.hasOwnProperty.call(message, 'inputSeq')) {
      return {
        ok: false,
        reason: 'invalid-sequence',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    if (hasSeqStart !== hasSeqEnd) {
      return {
        ok: false,
        reason: 'invalid-sequence',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    if (hasSeqStart && hasSeqEnd) {
      if (
        typeof message.inputSeqStart !== 'number'
        || typeof message.inputSeqEnd !== 'number'
        || !Number.isSafeInteger(message.inputSeqStart)
        || !Number.isSafeInteger(message.inputSeqEnd)
        || message.inputSeqStart < 1
        || message.inputSeqEnd < message.inputSeqStart
        || message.inputSeqEnd - message.inputSeqStart + 1 > MAX_INPUT_SEQUENCE_SPAN
      ) {
        return {
          ok: false,
          reason: 'invalid-sequence',
          sessionId,
          data,
          inputSeqStart,
          inputSeqEnd,
        };
      }
    }

    const metadataRecord = sanitizeClientInputDebugMetadata(
      isRecord(message.metadata) ? message.metadata as InputDebugMetadata : undefined,
    );
    const metadata = Object.keys(metadataRecord).length > 0
      ? metadataRecord as InputDebugMetadata
      : undefined;

    return {
      ok: true,
      sessionId,
      data,
      metadata,
      inputSeqStart,
      inputSeqEnd,
      retainedIdentity,
      byteLength,
    };
  }

  private parseRetainedTerminalWireMutationIdentity(
    value: unknown,
  ): RetainedTerminalWireMutationIdentity | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.authorityEpoch !== 'string' || value.authorityEpoch.length === 0) return undefined;
    if (typeof value.leaseGeneration !== 'string' || value.leaseGeneration.length === 0) return undefined;
    if (typeof value.viewGeneration !== 'number'
      || !Number.isSafeInteger(value.viewGeneration)
      || value.viewGeneration < 0) return undefined;
    return {
      authorityEpoch: value.authorityEpoch,
      viewGeneration: value.viewGeneration,
      leaseGeneration: value.leaseGeneration,
    };
  }

  private toRetainedTerminalMutationIdentity(
    meta: WsClientMeta | undefined,
    value: RetainedTerminalWireMutationIdentity | undefined,
  ): RetainedTerminalMutationIdentity | undefined {
    if (!meta || !value) return undefined;
    return { ...value, clientId: meta.clientId };
  }

  private buildReplaySnapshotMetadata(
    snapshot: ReturnType<SessionManager['getScreenSnapshot']> extends infer T ? NonNullable<T> : never,
    mode: ReplaySnapshotMode,
  ): ReplaySnapshotMetadata {
    return {
      snapshotSeq: snapshot.seq,
      snapshotMode: mode,
      snapshotDataLength: snapshot.data.length,
      snapshotTruncated: snapshot.truncated,
      snapshotCols: snapshot.cols,
      snapshotRows: snapshot.rows,
    };
  }

  private applyReplaySnapshotMetadata(state: ReplayPendingState, metadata: ReplaySnapshotMetadata): void {
    state.snapshotSeq = metadata.snapshotSeq;
    state.snapshotMode = metadata.snapshotMode;
    state.snapshotDataLength = metadata.snapshotDataLength;
    state.snapshotTruncated = metadata.snapshotTruncated;
    state.snapshotCols = metadata.snapshotCols;
    state.snapshotRows = metadata.snapshotRows;
  }

  private snapshotCoversQueuedOutput(
    snapshot: ReturnType<SessionManager['getScreenSnapshot']> extends infer T ? NonNullable<T> : never,
    mode: ReplaySnapshotMode,
    state: ReplayPendingState,
  ): boolean {
    if (snapshot.data.length === 0) {
      return false;
    }

    const hasQueuedOutput = state.preserveOutputChunkIdentity
      ? state.queuedOutputChunks.length > 0
      : state.queuedOutput.length > 0;
    if (mode === 'authoritative') {
      return hasQueuedOutput;
    }

    return (
      hasQueuedOutput
      && state.queuedOutputMaxScreenSeq !== null
      && snapshot.seq >= state.queuedOutputMaxScreenSeq
    );
  }

  private snapshotStillCoversCoveredOutput(
    snapshot: ReturnType<SessionManager['getScreenSnapshot']> extends infer T ? NonNullable<T> : never,
    mode: ReplaySnapshotMode,
    state: ReplayPendingState,
  ): boolean {
    const hasCoveredOutput = state.preserveOutputChunkIdentity
      ? state.coveredQueuedOutputBytes > 0
      : state.coveredQueuedOutput.length > 0;
    if (!hasCoveredOutput) {
      return false;
    }

    if (mode === 'authoritative') {
      return snapshot.data.length > 0;
    }

    return (
      snapshot.data.length > 0
      && state.coveredQueuedOutputMaxScreenSeq !== null
      && snapshot.seq >= state.coveredQueuedOutputMaxScreenSeq
    );
  }

  private isUnchangedEmptyFallbackReplaySnapshot(
    state: ReplayPendingState,
    metadata: ReplaySnapshotMetadata,
  ): boolean {
    return (
      state.snapshotMode === 'fallback'
      && state.snapshotDataLength === 0
      && metadata.snapshotMode === 'fallback'
      && metadata.snapshotDataLength === 0
      && state.snapshotSeq === metadata.snapshotSeq
      && state.snapshotTruncated === metadata.snapshotTruncated
      && state.snapshotCols === metadata.snapshotCols
      && state.snapshotRows === metadata.snapshotRows
    );
  }

  private sendSnapshotReplay(
    ws: WebSocket,
    sessionId: string,
    snapshot: ReturnType<SessionManager['getScreenSnapshot']> extends infer T ? NonNullable<T> : never,
    origin: SnapshotReplayOrigin,
    options: SnapshotReplayOptions = {},
  ): ReplayPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }

    const authorityPendingSeed = this.takeRestoreAuthorityPendingSeed(ws, sessionId);
    const supersedesReplayToken = options.supersedesReplayToken
      ?? authorityPendingSeed?.supersedesReplayToken;
    const mode = snapshot.health === 'healthy' && !(snapshot.truncated && snapshot.data.length === 0)
      ? 'authoritative'
      : 'fallback';
    const replayState = this.markReplayPending(ws, sessionId, this.buildReplaySnapshotMetadata(snapshot, mode));
    replayState.preserveOutputChunkIdentity = true;
    replayState.recoveryRepairToken = options.recoveryRepairToken;
    replayState.queuedInputs = authorityPendingSeed?.queuedInputs ?? [];
    replayState.queuedInputBytes = authorityPendingSeed?.queuedInputBytes ?? 0;
    replayState.queuedOutputTruncated = authorityPendingSeed?.queuedOutputTruncated ?? false;
    const seedChunks = [
      ...(authorityPendingSeed?.queuedOutputChunks ?? []),
      ...(options.queuedOutputChunks ?? []),
    ];
    for (const chunk of seedChunks) {
      if (
        options.recoveryRepairToken
        && typeof chunk.screenSeq === 'number'
        && chunk.screenSeq <= snapshot.seq
      ) {
        // The repair queue was bounded before this authoritative snapshot was
        // generated. Snapshot-covered seed chunks need accounting for ACK
        // telemetry, but not a second retained copy: repair ACK timeout takes
        // the explicit reconnect-required path instead of replaying them.
        replayState.coveredQueuedOutputBytes += chunk.byteLength;
        replayState.coveredQueuedOutputMaxScreenSeq = this.mergeScreenSeq(
          replayState.coveredQueuedOutputMaxScreenSeq,
          chunk.screenSeq,
        );
        continue;
      }
      if (!this.appendPreservedReplayOutput(sessionId, replayState, chunk)) {
        throw new Error('Screen repair recovery seed exceeded the prevalidated replay policy');
      }
    }
    options.beforeSnapshot?.(replayState);

    this.sendTo(ws, {
      type: 'screen-snapshot',
      sessionId,
      replayToken: replayState.replayToken,
      seq: snapshot.seq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      mode,
      data: snapshot.data,
      truncated: snapshot.truncated,
      source: 'headless',
      fallbackDataState: snapshot.fallbackDataState,
      fallbackDataBytes: snapshot.fallbackDataBytes,
      windowsPty: snapshot.windowsPty,
      authorityEpoch: snapshot.authorityEpoch,
      authorityRevision: snapshot.authorityRevision,
      coversThroughSeq: snapshot.seq,
      supersedesReplayToken,
      parserComplete: snapshot.parserComplete,
      pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi,
    });
    this.recordReplayEvent({
      kind: 'snapshot_sent',
      sessionId,
      replayToken: replayState.replayToken,
      snapshotSeq: snapshot.seq,
      details: {
        origin,
        clientId: meta.clientId,
        cols: snapshot.cols,
        rows: snapshot.rows,
        truncated: snapshot.truncated,
        mode,
        fallbackDataState: snapshot.fallbackDataState ?? null,
        fallbackDataBytes: snapshot.fallbackDataBytes ?? null,
      },
    });

    return replayState;
  }

  routeSessionOutput(
    sessionId: string,
    data: string,
    outputScreenSeq?: number,
    authority: OutputAuthorityMetadata = {},
    audience: 'all' | 'legacy-unnegotiated' = 'all',
  ): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || data.length === 0) {
      return;
    }
    const outputChunkId = this.nextSessionOutputChunkId(sessionId);

    for (const ws of subscribers) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      const meta = this.clients.get(ws);
      if (audience === 'legacy-unnegotiated'
        && meta?.terminalAuthorityViewRegistrations?.has(sessionId)) {
        continue;
      }
      const pending = meta?.replayPendingSessions.get(sessionId);
      if (pending) {
        const queued = this.appendQueuedOutput(
          sessionId,
          pending,
          data,
          outputScreenSeq,
          outputChunkId,
          authority,
        );
        if (!queued && pending.preserveOutputChunkIdentity) {
          this.handlePreservedReplayQueueOverflow(ws, sessionId, pending, data, outputScreenSeq);
          continue;
        }
        const outputBytes = utf8ByteLength(data);
        const queuedBytes = this.getReplayQueuedByteMetrics(pending).queuedBytes;
        this.recordReplayEvent({
          kind: 'output_queued',
          sessionId,
          replayToken: pending.replayToken,
          snapshotSeq: pending.snapshotSeq,
          details: {
            outputBytes,
            queuedBytes,
            outputScreenSeq: outputScreenSeq ?? null,
            queuedOutputMaxScreenSeq: pending.queuedOutputMaxScreenSeq,
          },
        });
        continue;
      }

      const repairPending = meta ? this.getScreenRepairPendingSessions(meta).get(sessionId) : undefined;
      if (repairPending) {
        const queued = this.appendScreenRepairQueuedOutput(
          ws,
          sessionId,
          repairPending,
          data,
          outputScreenSeq,
          outputChunkId,
          authority,
        );
        if (queued) {
          this.recordReplayEvent({
            kind: 'screen_repair_output_queued',
            sessionId,
            repairToken: repairPending.repairToken,
            snapshotSeq: repairPending.screenSeq,
            details: {
              outputBytes: Buffer.byteLength(data, 'utf8'),
              outputScreenSeq: outputScreenSeq ?? null,
              queuedBytes: repairPending.queuedOutputBytes,
            },
          });
        }
        continue;
      }

      const checkpointLedger = this.terminalDeliveryCheckpointLedgers.get(ws)?.get(sessionId);
      if (checkpointLedger?.active) {
        checkpointLedger.late += 1;
        continue;
      }

      const visibility = this.terminalDeliveryVisibilityBySocket.get(ws)?.get(sessionId);
      const fairScheduler = this.fairDeliverySchedulers.get(ws);
      if (visibility && !visibility.isVisible && fairScheduler) {
        const connectionId = meta?.connectionId ?? meta?.clientId;
        const registration = connectionId && meta
          ? this.getTerminalAuthorityNegotiatedView(
              sessionId,
              connectionId,
              meta.terminalAuthorityViewRegistrations?.get(sessionId)?.viewGeneration ?? -1,
            )
          : null;
        const fresh = registration && connectionId && meta
          ? this.terminalAuthorityFreshCheckpointReader?.({
              sessionId,
              clientId: meta.clientId,
              connectionId,
            }) ?? null
          : null;
        const continuity = fresh?.continuity;
        const hasIssuedContinuity = isTerminalAuthorityContinuityRecord(continuity);
        const continuityMatchesCurrentView = Boolean(
          registration
          && connectionId
          && hasIssuedContinuity
          && continuity.sessionId === sessionId
          && continuity.connectionId === connectionId
          && continuity.viewGeneration === registration.viewGeneration
          && continuity.visibilityGeneration === visibility.visibilityGenerationWire
          && continuity.expiresAt > Date.now(),
        );
        if (!continuityMatchesCurrentView) {
          visibility.dataGapLatched = true;
          this.sendTo(ws, {
            type: 'terminal-checkpoint:fresh-checkpoint-required',
            sessionId,
            reason: continuity && continuity.expiresAt <= Date.now()
              ? 'continuity-expired'
              : registration
                ? 'continuity-identity-mismatch'
                : 'authority-unavailable',
            ...(fresh
              ? {
                  checkpointAuthority: 'server-full-retained-state' as const,
                  fullCheckpoint: fresh.fullCheckpoint,
                }
              : {}),
          });
          continue;
        }
        if (!hasIssuedContinuity) continue;
        if (!visibility.dataGapLatched) {
          const gapFields = {
            sessionId,
            connectionId: continuity.connectionId,
            viewGeneration: continuity.viewGeneration,
            visibilityGeneration: continuity.visibilityGeneration,
            lastDeliveredSeq: continuity.lastDeliveredSeq,
            streamEpoch: continuity.streamEpoch,
            checkpointEpoch: continuity.checkpointEpoch,
            snapshotSeq: continuity.snapshotSeq,
            oldestRetainedSeq: continuity.oldestRetainedSeq,
            retentionPolicyId: continuity.retentionPolicyId,
            continuityAuthority: 'server-issued',
            deliveryInterestRefCount: visibility.deliveryInterestRefCount,
            authoritativeModelCommitted: true,
            terminalFactsCommitted: true,
          };
          const enqueued = fairScheduler.scheduler.enqueue({
            connectionEpoch: fairScheduler.connectionEpoch,
            sessionId,
            kind: 'dataGap',
            payload: JSON.stringify(gapFields),
            payloadFields: gapFields,
            capabilities: { ackCredit: true, legacyFallback: false },
          });
          if (enqueued.accepted) {
            visibility.dataGapLatched = true;
            fairScheduler.scheduler.drain();
          }
        }
        continue;
      }

      if (checkpointLedger?.settled) {
        this.sendTo(ws, {
          type: 'output',
          sessionId,
          data,
          screenSeq: outputScreenSeq,
          authorityEpoch: authority.authorityEpoch,
          authorityRevision: authority.authorityRevision,
          chunkId: outputChunkId,
        });
        continue;
      }

      if (fairScheduler) {
        fairScheduler.scheduler.enqueue({
          connectionEpoch: fairScheduler.connectionEpoch,
          sessionId,
          kind: 'output',
          payload: data,
          screenSeq: outputScreenSeq,
          authorityEpoch: authority.authorityEpoch,
          authorityRevision: authority.authorityRevision,
          chunkId: outputChunkId,
          capabilities: { ackCredit: true, legacyFallback: false },
        });
        fairScheduler.scheduler.drain();
        continue;
      }

      this.sendTo(ws, {
        type: 'output',
        sessionId,
        data,
        screenSeq: outputScreenSeq,
        authorityEpoch: authority.authorityEpoch,
        authorityRevision: authority.authorityRevision,
        chunkId: outputChunkId,
      });
    }
  }

  refreshReplaySnapshots(sessionId: string, options: RefreshReplaySnapshotsOptions = {}): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
    if (!snapshot) {
      this.scheduleRefreshRestoreAuthorityRetry(sessionId, options);
      return;
    }

    const mode = snapshot.health === 'healthy' && !(snapshot.truncated && snapshot.data.length === 0)
      ? 'authoritative'
      : 'fallback';
    const snapshotMetadata = this.buildReplaySnapshotMetadata(snapshot, mode);

    for (const ws of subscribers) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      const meta = this.clients.get(ws);
      const pending = meta?.replayPendingSessions.get(sessionId);
      if (!pending) {
        if (!options.startWhenReady || !meta?.subscribedSessions.has(sessionId)) {
          continue;
        }
        const repairPending = this.getScreenRepairPendingSessions(meta).get(sessionId);
        if (repairPending) {
          this.recordReplayEvent({
            kind: 'snapshot_refresh_skipped',
            sessionId,
            repairToken: repairPending.repairToken,
            snapshotSeq: repairPending.screenSeq,
            details: {
              reason: 'screen-repair-pending',
              clientId: meta.clientId,
              origin: options.origin ?? 'refresh',
            },
          });
          continue;
        }

        this.replayRefreshCount += 1;
        this.sendSnapshotReplay(ws, sessionId, snapshot, options.origin === 'degraded' ? 'degraded' : 'repair');
        continue;
      }

      if (this.isUnchangedEmptyFallbackReplaySnapshot(pending, snapshotMetadata)) {
        const queuedMetrics = this.getReplayQueuedByteMetrics(pending);
        this.recordReplayEvent({
          kind: 'snapshot_refresh_skipped',
          sessionId,
          replayToken: pending.replayToken,
          snapshotSeq: pending.snapshotSeq,
          details: {
            reason: 'unchanged-empty-fallback',
            clientId: meta?.clientId ?? null,
            queuedBytes: queuedMetrics.queuedBytes,
            coveredQueuedBytes: queuedMetrics.coveredQueuedBytes,
          },
        });
        continue;
      }

      this.replayRefreshCount += 1;

      const refreshedSnapshotCoversQueuedOutput = this.snapshotCoversQueuedOutput(snapshot, mode, pending);
      const refreshedSnapshotStillCoversCoveredOutput = this.snapshotStillCoversCoveredOutput(snapshot, mode, pending);
      if (
        pending.preserveOutputChunkIdentity
        && pending.coveredQueuedOutputBytes > 0
        && !refreshedSnapshotStillCoversCoveredOutput
      ) {
        clearTimeout(pending.timer);
        meta?.replayPendingSessions.delete(sessionId);
        this.rejectQueuedReplayInputs(ws, sessionId, pending, 'context-changed');
        if (pending.recoveryRepairToken) {
          this.sendScreenRepairReconnectRequired(
            ws,
            sessionId,
            pending.recoveryRepairToken,
            'authority-unavailable',
            'authority-unavailable',
            pending.replayToken,
          );
        }
        continue;
      }
      if (refreshedSnapshotCoversQueuedOutput) {
        this.markQueuedOutputCoveredBySnapshot(pending);
      } else if (!refreshedSnapshotStillCoversCoveredOutput) {
        this.uncoverQueuedOutput(pending);
      }

      const supersedesReplayToken = pending.replayToken;
      clearTimeout(pending.timer);
      pending.replayToken = uuidv4();
      this.applyReplaySnapshotMetadata(pending, snapshotMetadata);
      const refreshReplayToken = pending.replayToken;
      pending.timer = setTimeout(() => {
        this.handleReplayAckTimeout(ws, sessionId, refreshReplayToken, snapshot.seq, 'refresh-timeout');
      }, REPLAY_ACK_TIMEOUT_MS);
      pending.timer.unref();

      this.sendTo(ws, {
        type: 'screen-snapshot',
        sessionId,
        replayToken: pending.replayToken,
        seq: snapshot.seq,
        cols: snapshot.cols,
        rows: snapshot.rows,
        mode,
        data: snapshot.data,
        truncated: snapshot.truncated,
        source: 'headless',
        fallbackDataState: snapshot.fallbackDataState,
        fallbackDataBytes: snapshot.fallbackDataBytes,
        windowsPty: snapshot.windowsPty,
        authorityEpoch: snapshot.authorityEpoch,
        authorityRevision: snapshot.authorityRevision,
        coversThroughSeq: snapshot.seq,
        supersedesReplayToken,
        parserComplete: snapshot.parserComplete,
        pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi,
      });
      const queuedMetrics = this.getReplayQueuedByteMetrics(pending);
      this.recordReplayEvent({
        kind: 'snapshot_refreshed',
        sessionId,
        replayToken: pending.replayToken,
        snapshotSeq: snapshot.seq,
        details: {
          origin: 'refresh',
          clientId: meta?.clientId ?? null,
          cols: snapshot.cols,
          rows: snapshot.rows,
          truncated: snapshot.truncated,
          mode,
          refreshOrigin: options.origin ?? 'refresh',
          refreshReason: options.reason ?? null,
          fallbackDataState: snapshot.fallbackDataState ?? null,
          fallbackDataBytes: snapshot.fallbackDataBytes ?? null,
          coversQueuedOutput: refreshedSnapshotCoversQueuedOutput,
          coversPreviouslyCoveredOutput: refreshedSnapshotStillCoversCoveredOutput,
          queuedBytes: queuedMetrics.queuedBytes,
          coveredQueuedBytes: queuedMetrics.coveredQueuedBytes,
        },
      });
    }
  }

  clearSessionState(sessionId: string): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers) {
      this.sessionOutputChunkOrdinals.delete(sessionId);
      return;
    }

    for (const ws of subscribers) {
      this.clearReplayPendingForPair(ws, sessionId, 'session-missing');
      this.clearScreenRepairPendingForPair(ws, sessionId, 'session-missing');
      const meta = this.clients.get(ws);
      meta?.subscribedSessions.delete(sessionId);
    }

    this.sessionSubscribers.delete(sessionId);
    this.sessionOutputChunkOrdinals.delete(sessionId);
  }

  // @req REL-BGSTAB-009
  private getRestoreAuthoritySnapshot(
    sessionId: string,
  ): ReturnType<SessionManager['getScreenSnapshot']> {
    const atomicGetter = (
      this.sessionManager as SessionManager & {
        getAtomicRestoreSnapshot?: SessionManager['getAtomicRestoreSnapshot'];
      }
    ).getAtomicRestoreSnapshot;
    if (typeof atomicGetter !== 'function') {
      return this.sessionManager.getScreenSnapshot(sessionId);
    }
    const result = atomicGetter.call(this.sessionManager, sessionId);
    if (!result.ok) {
      this.recordReplayEvent({
        kind: 'snapshot_refresh_skipped',
        sessionId,
        details: {
          reason: result.reason,
          authority: 'atomic-restore',
        },
      });
      if (result.reason === 'headless-degraded') {
        return this.sessionManager.getScreenSnapshot(sessionId);
      }
      return null;
    }
    return {
      seq: result.payload.snapshotSeq,
      cols: result.payload.cols,
      rows: result.payload.rows,
      data: result.payload.serializedData,
      truncated: result.payload.truncated,
      generatedAt: result.payload.generatedAt,
      health: result.payload.health,
      windowsPty: result.payload.windowsPty,
      authorityEpoch: result.payload.authorityEpoch,
      authorityRevision: result.payload.authorityRevision,
      parserComplete: result.payload.parserComplete,
      pendingEscapeTailAnsi: result.payload.pendingEscapeTailAnsi,
    };
  }

  // @req REL-BGSTAB-009
  private scheduleRestoreAuthorityRetry(
    ws: WebSocket,
    sessionId: string,
    origin: 'subscribe' | 'repair',
    attempt = 1,
  ): void {
    const meta = this.clients.get(ws);
    if (!meta) return;
    const retryKey = `${meta.clientId}:${sessionId}:${origin}`;
    if (this.restoreAuthorityRetryKeys.has(retryKey)) return;
    this.restoreAuthorityRetryKeys.add(retryKey);
    const timer = setTimeout(() => {
      this.restoreAuthorityRetryKeys.delete(retryKey);
      const currentMeta = this.clients.get(ws);
      const currentReplay = currentMeta?.replayPendingSessions.get(sessionId);
      if (
        ws.readyState !== WebSocket.OPEN
        || !currentMeta?.subscribedSessions.has(sessionId)
        || currentReplay?.authorityPending !== true
      ) {
        return;
      }
      const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
      if (snapshot) {
        this.sendSnapshotReplay(ws, sessionId, snapshot, origin);
        return;
      }
      if (attempt < RESTORE_AUTHORITY_MAX_RETRIES) {
        this.scheduleRestoreAuthorityRetry(ws, sessionId, origin, attempt + 1);
        return;
      }
      this.recordReplayEvent({
        kind: 'snapshot_refresh_skipped',
        sessionId,
        details: {
          reason: 'authority-unavailable-after-retry',
          origin,
          attempt,
          clientId: currentMeta.clientId,
        },
      });
      this.sendTo(ws, {
        type: 'session:error',
        sessionId,
        message: 'Authoritative terminal restore unavailable',
      });
      this.failRestoreAuthorityPending(ws, sessionId);
    }, restoreAuthorityRetryDelayMs(attempt));
    timer.unref();
  }

  // @req REL-BGSTAB-009
  private scheduleRefreshRestoreAuthorityRetry(
    sessionId: string,
    options: RefreshReplaySnapshotsOptions,
    attempt = 1,
  ): void {
    const retryKey = `refresh:${sessionId}`;
    if (this.restoreAuthorityRetryKeys.has(retryKey)) return;
    this.restoreAuthorityRetryKeys.add(retryKey);
    const timer = setTimeout(() => {
      this.restoreAuthorityRetryKeys.delete(retryKey);
      if (!this.sessionSubscribers.has(sessionId)) return;
      const snapshot = this.getRestoreAuthoritySnapshot(sessionId);
      if (snapshot) {
        this.refreshReplaySnapshots(sessionId, options);
        return;
      }
      if (attempt < RESTORE_AUTHORITY_MAX_RETRIES) {
        this.scheduleRefreshRestoreAuthorityRetry(sessionId, options, attempt + 1);
        return;
      }
      this.recordReplayEvent({
        kind: 'snapshot_refresh_skipped',
        sessionId,
        details: {
          reason: 'authority-unavailable-after-retry',
          origin: options.origin ?? 'refresh',
          attempt,
        },
      });
    }, restoreAuthorityRetryDelayMs(attempt));
    timer.unref();
  }

  clearReplayEvents(sessionId?: string): void {
    if (!sessionId) {
      this.recentReplayEvents = [];
      this.debugReplayEventsBySession.clear();
      return;
    }
    this.recentReplayEvents = this.recentReplayEvents.filter((event) => event.sessionId !== sessionId);
    this.debugReplayEventsBySession.delete(sessionId);
  }

  enableDebugReplayCapture(sessionId: string): void {
    this.debugReplayEnabledSessions.add(sessionId);
    this.debugReplayEventsBySession.delete(sessionId);
  }

  disableDebugReplayCapture(sessionId: string): void {
    this.debugReplayEnabledSessions.delete(sessionId);
    this.debugReplayEventsBySession.delete(sessionId);
  }

  getDebugReplayEvents(sessionId: string, limit = 200): ReplayTelemetryEvent[] {
    const events = this.debugReplayEventsBySession.get(sessionId) ?? [];
    return events.slice(-Math.max(1, limit));
  }

  getSubscribers(sessionId: string): Set<WebSocket> | undefined {
    return this.sessionSubscribers.get(sessionId);
  }

  sendSessionEvent(sessionId: string, event: string, payload: object): void {
    const subscribers = this.getSubscribers(sessionId);
    if (!subscribers) {
      return;
    }
    for (const ws of subscribers) {
      if (event === 'session:exited') {
        const control = this.clients.get(ws)?.channelRole === 'output'
          ? this.splitSocketGroups.get(ws)?.control
          : ws;
        if (control) this.terminateFairDeliverySession(control, sessionId);
      }
      this.sendTo(ws, { type: event, sessionId, ...payload });
    }
  }

  // @req REL-BGSTAB-012 AC-5 AC-7
  private discardCheckpointQueuedFairDeliveryTransport(
    control: WebSocket,
    connectionEpoch: string,
    sessionId: string,
    sentDeliverySeqs: ReadonlySet<number>,
  ): number {
    if (sentDeliverySeqs.size === 0) return 0;
    const targets = [control, this.splitSocketGroups.get(control)?.output]
      .filter((target): target is WebSocket => target !== undefined);
    let removedCount = 0;
    for (const target of targets) {
      const state = this.transportQueues.get(target);
      if (!state) continue;
      const removed = removeTransportMessages(state, message => {
        if (message.sessionId !== sessionId || !this.isFairTerminalDeliveryTransportMessage(message)) {
          return false;
        }
        return message.connectionEpoch === connectionEpoch
          && message.deliveryKind === 'output'
          && message.deliverySeq !== undefined
          && sentDeliverySeqs.has(message.deliverySeq);
      });
      removedCount += removed.removedCount;
    }
    return removedCount;
  }

  // @req PERF-BGSTAB-010 AC-8
  private discardQueuedFairDeliveryTransport(
    control: WebSocket,
    connectionEpoch: string,
    sessionId?: string,
  ): void {
    const targets = [control, this.splitSocketGroups.get(control)?.output]
      .filter((target): target is WebSocket => target !== undefined);
    for (const target of targets) {
      const state = this.transportQueues.get(target);
      if (!state) continue;
      removeTransportMessages(state, message => {
        if (sessionId !== undefined && message.sessionId !== sessionId) return false;
        return message.connectionEpoch === connectionEpoch
          && message.deliverySeq !== undefined
          && message.deliveryKind !== undefined;
      });
    }
  }

  // @req PERF-BGSTAB-010 AC-8
  private terminateFairDeliverySession(control: WebSocket, sessionId: string): void {
    const fairDelivery = this.fairDeliverySchedulers.get(control);
    if (!fairDelivery) return;
    this.discardQueuedFairDeliveryTransport(control, fairDelivery.connectionEpoch, sessionId);
    fairDelivery.scheduler.terminateSession({
      connectionEpoch: fairDelivery.connectionEpoch,
      sessionId,
    });
    this.releaseFairDeliveryIfIdle(control);
  }

  hasSubscribers(sessionId: string): boolean {
    const subscribers = this.sessionSubscribers.get(sessionId);
    return subscribers !== undefined && subscribers.size > 0;
  }

  readInputReplayState(sessionId: string): { replayPending: boolean; screenRepairPending: boolean } {
    let replayPending = false;
    let screenRepairPending = false;
    for (const meta of this.clients.values()) {
      replayPending = replayPending || meta.replayPendingSessions.has(sessionId);
      screenRepairPending = screenRepairPending || this.getScreenRepairPendingSessions(meta).has(sessionId);
      if (replayPending && screenRepairPending) {
        break;
      }
    }
    return { replayPending, screenRepairPending };
  }

  getObservabilitySnapshot(): WsRouterObservabilitySnapshot {
    let replayPendingCount = 0;
    let screenRepairPendingCount = 0;
    let transportQueuedClientCount = 0;
    let transportOutputQueuedBytes = 0;
    let transportControlQueuedBytes = 0;
    for (const meta of this.clients.values()) {
      replayPendingCount += meta.replayPendingSessions.size;
      screenRepairPendingCount += this.getScreenRepairPendingSessions(meta).size;
    }
    for (const ws of this.clients.keys()) {
      const transport = this.transportQueues.get(ws);
      if (!transport) {
        continue;
      }
      if (hasTransportQueuedMessages(transport)) {
        transportQueuedClientCount += 1;
      }
      transportOutputQueuedBytes += transport.outputBytes;
      transportControlQueuedBytes += transport.controlBytes;
    }

    return {
      connectedClients: this.clients.size,
      subscribedSessionCount: this.sessionSubscribers.size,
      replayPendingCount,
      screenRepairPendingCount,
      replayAckTimeoutCount: this.replayAckTimeoutCount,
      screenRepairAckTimeoutCount: this.screenRepairAckTimeoutCount,
      replayRefreshCount: this.replayRefreshCount,
      maxReplayQueueLengthObserved: this.maxReplayQueueLengthObserved,
      transportQueuedClientCount,
      transportOutputQueuedBytes,
      transportControlQueuedBytes,
      maxTransportQueuedBytesObserved: this.maxTransportQueuedBytesObserved,
      maxServerBufferedAmountObserved: this.maxServerBufferedAmountObserved,
      transportBackpressureObserveCount: this.transportBackpressureObserveCount,
      transportSlowClientCloseCount: this.transportSlowClientCloseCount,
      transportQueueOverflowCount: this.transportQueueOverflowCount,
      transportSendErrorCount: this.transportSendErrorCount,
      undecodableFrameCount: this.undecodableFrameCount,
      transportOutputCoalesceCount: this.transportOutputCoalesceCount,
      recentReplayEvents: [...this.recentReplayEvents],
    };
  }

  recordReplayEvent(event: ReplayTelemetryEventInput): void {
    const nextEvent: ReplayTelemetryEvent = {
      eventId: ++this.replayEventCounter,
      recordedAt: new Date().toISOString(),
      ...event,
    };

    this.recentReplayEvents.push(nextEvent);
    if (this.recentReplayEvents.length > MAX_RECENT_REPLAY_EVENTS) {
      this.recentReplayEvents.splice(0, this.recentReplayEvents.length - MAX_RECENT_REPLAY_EVENTS);
    }

    if (!this.debugReplayEnabledSessions.has(event.sessionId)) {
      return;
    }

    const sessionEvents = this.debugReplayEventsBySession.get(event.sessionId) ?? [];
    sessionEvents.push(nextEvent);
    if (sessionEvents.length > MAX_RECENT_REPLAY_EVENTS) {
      sessionEvents.splice(0, sessionEvents.length - MAX_RECENT_REPLAY_EVENTS);
    }
    this.debugReplayEventsBySession.set(event.sessionId, sessionEvents);
  }

  private getTransportQueueState(ws: WebSocket): WsTransportQueueState {
    const existing = this.transportQueues.get(ws);
    if (existing) {
      return existing;
    }
    const next = createWsTransportQueueState();
    this.transportQueues.set(ws, next);
    return next;
  }

  private resolveCurrentWsLease(
    lease: TerminalResourcePolicyLease,
    rejectRevoked = true,
  ): { ok: true; grant: TerminalResourcePolicyLeaseGrant } | { ok: false; reason: string } {
    const grant = this.terminalResourcePolicyAuthority?.resolve(lease);
    if (!grant || grant.lease.resource !== 'resourceLimits.ws.perClientOutputQueueMaxBytes'
      || grant.lease.consumer !== 'server.ws.router' || grant.lease.target.kind !== 'ws') {
      return { ok: false, reason: 'invalid-policy-lease' };
    }
    if (rejectRevoked && grant.metadata.targetEpoch !== grant.currentTargetEpoch) {
      return { ok: false, reason: 'lease-revoked' };
    }
    return { ok: true, grant };
  }

  private getOrCreateWsCanaryState(target: WsCanaryTarget): WsCanaryState {
    const key = this.canaryTargetKey(target);
    const existing = this.terminalResourcePolicyCanaryStates.get(key);
    if (existing) return existing;
    const state: WsCanaryState = {
      target: Object.freeze(structuredClone(target)),
      mode: 'legacy',
      policyGeneration: 0,
      effectiveDecision: this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes,
      legacyAdmissionCount: 0,
      rollbackState: 'inactive',
      totalEvents: 0,
      droppedEntries: 0,
      entries: [],
    };
    this.terminalResourcePolicyCanaryStates.set(key, state);
    return state;
  }

  private canaryTargetKey(target: WsCanaryTarget): string {
    return JSON.stringify([
      target.connectionId,
      target.clientId,
      target.channel,
      target.reconnectGeneration,
    ]);
  }

  private findSocketForCanaryTarget(target: WsCanaryTarget): WebSocket | undefined {
    for (const [ws, rawMeta] of this.clients) {
      const meta = rawMeta as WsClientMeta & {
        connectionId?: string;
        reconnectGeneration?: number;
        outputChannel?: boolean;
      };
      if (
        meta.clientId === target.clientId
        && meta.connectionId === target.connectionId
        && meta.reconnectGeneration === target.reconnectGeneration
        && meta.outputChannel !== false
      ) {
        return ws;
      }
    }
    return undefined;
  }

  private getWsCanaryStateForSocket(ws: WebSocket): WsCanaryState | undefined {
    const meta = this.clients.get(ws) as (WsClientMeta & {
      connectionId?: string;
      reconnectGeneration?: number;
    }) | undefined;
    if (!meta?.connectionId || meta.reconnectGeneration === undefined) return undefined;
    return this.terminalResourcePolicyCanaryStates.get(this.canaryTargetKey({
      kind: 'ws',
      connectionId: meta.connectionId,
      clientId: meta.clientId,
      channel: 'output',
      reconnectGeneration: meta.reconnectGeneration,
    }));
  }

  private getEffectiveOutputQueueLimit(ws: WebSocket, incoming?: WsTransportMessage): number {
    const state = this.getWsCanaryStateForSocket(ws);
    const legacyLimit = this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes;
    if (!state || !incoming || incoming.kind !== 'output') {
      return state?.mode === 'candidate' ? state.effectiveDecision : legacyLimit;
    }
    const queue = this.transportQueues.get(ws);
    const queued = queue ? getTransportMessagesInPriorityOrder(queue) : [];
    const queuedBytes = queue?.outputBytes ?? 0;
    if (state.mode === 'candidate' && queuedBytes + incoming.byteLength <= state.effectiveDecision) {
      incoming.policyAdmissionMode = 'candidate';
      return state.effectiveDecision;
    }
    const grandfatheredBytes = state.rollbackState === 'draining' && state.rollbackPendingMessages
      ? queued.reduce((sum, message) => (
        message.kind === 'output' && state.rollbackPendingMessages!.has(message)
          ? sum + message.byteLength
          : sum
      ), 0)
      : queued.reduce((sum, message) => (
        message.kind === 'output'
          && !(message.policyGeneration === state.policyGeneration && message.policyAdmissionMode === 'legacy')
          ? sum + message.byteLength
          : sum
      ), 0);
    incoming.policyAdmissionMode = 'legacy';
    state.legacyAdmissionCount += 1;
    return grandfatheredBytes + legacyLimit;
  }

  private appendWsCanaryLedger(
    state: WsCanaryState,
    lease: TerminalResourcePolicyLease,
    input: Omit<TerminalResourcePolicyCanaryLedgerEntry,
      'sequence' | 'resource' | 'consumer' | 'target' | 'policyGeneration' | 'policyId' | 'profileVersion'>,
  ): void {
    const entry: TerminalResourcePolicyCanaryLedgerEntry = {
      sequence: ++state.totalEvents,
      event: input.event,
      resource: lease.resource,
      consumer: lease.consumer,
      target: Object.freeze(structuredClone(lease.target)),
      policyGeneration: state.policyGeneration,
      policyId: lease.policyId,
      profileVersion: lease.profileVersion,
      previousEffectiveDecision: input.previousEffectiveDecision,
      nextEffectiveDecision: input.nextEffectiveDecision,
      accepted: input.accepted,
      reason: input.reason,
      rollbackResult: input.rollbackResult,
    };
    state.entries.push(entry);
    if (state.entries.length > 8) {
      const dropped = state.entries.length - 8;
      state.entries.splice(0, dropped);
      state.droppedEntries += dropped;
    }
  }

  // @req PERF-BGSTAB-010 AC-7
  private runFairDeliveryMaintenance(control: WebSocket, now = Date.now()): void {
    const active = this.fairDeliverySchedulers.get(control);
    if (!active) return;
    active.scheduler.advanceTo(now);
    active.scheduler.drain();
  }

  // @req PERF-BGSTAB-010 AC-5
  private createFairDeliveryWireMessage(
    delivery: FairTerminalDelivery,
    connectionEpoch: string,
  ): Record<string, unknown> {
    if (delivery.kind === 'dataGap') {
      return {
        ...delivery.payloadFields,
        type: 'terminal-delivery:data-gap',
        connectionEpoch,
        deliverySeq: delivery.deliverySeq,
        deliveryKind: delivery.kind,
      };
    }
    return {
      type: 'output',
      sessionId: delivery.sessionId,
      data: delivery.payload,
      connectionEpoch,
      deliverySeq: delivery.deliverySeq,
      deliveryKind: delivery.kind,
      screenSeq: delivery.screenSeq,
      authorityEpoch: delivery.authorityEpoch,
      authorityRevision: delivery.authorityRevision,
      chunkId: delivery.chunkId,
    };
  }

  // @req PERF-BGSTAB-010 AC-1 AC-2 AC-4 AC-5 AC-9
  private createFairDeliveryScheduler(
    control: WebSocket,
    connectionEpoch: string,
    policy = resolveFairTerminalDeliveryPolicy(this.runtimeSendPolicyConfig.limits),
  ) {
    return createFairTerminalDeliveryScheduler({
      now: () => Date.now(),
      policy,
      decisionArtifact: {
        state: 'complete',
        allRegisteredThresholdsPassed: true,
        hasUnboundedEligibleLaneStarvation: false,
      },
      send: delivery => {
        const output = this.splitSocketGroups.get(control)?.output ?? control;
        const message = this.createFairDeliveryWireMessage(delivery, connectionEpoch);
        this.sendTo(output, message, error => {
          if (!error) return;
          const active = this.fairDeliverySchedulers.get(control);
          active?.scheduler.settleTransport({
            connectionEpoch: delivery.connectionEpoch,
            sessionId: delivery.sessionId,
            deliverySeq: delivery.deliverySeq,
            error: error.message,
          });
          active?.scheduler.drain();
        });
      },
      onSemanticStatusChange: () => {
        // Delivery is presentation-only; it must never infer session semantics.
      },
      onFallback: fallback => {
        this.discardQueuedFairDeliveryTransport(
          control,
          fallback.connectionEpoch,
          fallback.sessionId,
        );
        this.releaseFairDeliveryIfIdle(control);
        this.startScreenRepairSnapshotRecovery(
          control,
          fallback.sessionId,
          uuidv4(),
          'delivery-recovery',
          [],
        );
      },
    });
  }

  // @req PERF-BGSTAB-010 AC-8
  private releaseFairDeliveryIfIdle(control: WebSocket): void {
    const active = this.fairDeliverySchedulers.get(control);
    if (!active || Object.keys(active.scheduler.snapshot().lanes).length > 0) return;
    clearInterval(active.maintenanceTimer);
    this.fairDeliverySchedulers.delete(control);
  }

  // @req PERF-BGSTAB-010 AC-8
  private releaseFairDeliveryConnection(control: WebSocket, connectionEpoch: string): void {
    const active = this.fairDeliverySchedulers.get(control);
    if (!active) return;
    clearInterval(active.maintenanceTimer);
    active.scheduler.rollbackConnection(connectionEpoch);
    this.discardQueuedFairDeliveryTransport(control, connectionEpoch);
    this.fairDeliverySchedulers.delete(control);
  }

  // @req PERF-BGSTAB-010 AC-5 AC-8
  private nextFairDeliveryConnectionEpoch(control: WebSocket, baseConnectionEpoch: string): string {
    const generation = (this.fairDeliveryEpochGenerations.get(control) ?? 0) + 1;
    this.fairDeliveryEpochGenerations.set(control, generation);
    return generation === 1 ? baseConnectionEpoch : `${baseConnectionEpoch}:delivery-${generation}`;
  }

  private freezeDeniedCanaryLedger(reason: string) {
    return Object.freeze({
      denied: true,
      reason,
      capacity: 8,
      totalEvents: 0,
      droppedEntries: 0,
      entries: Object.freeze([]),
    });
  }

  private hasPendingPolicyGeneration(target: WsCanaryTarget, generation: number): boolean {
    const ws = this.findSocketForCanaryTarget(target);
    if (!ws) return false;
    if (this.inFlightTransportMessages.get(ws)?.policyGeneration === generation) return true;
    const queue = this.transportQueues.get(ws);
    return queue ? getTransportMessagesInPriorityOrder(queue)
      .some(message => message.policyGeneration === generation) : false;
  }

  private captureWsRollbackBoundary(target: WsCanaryTarget): Set<WsTransportMessage> {
    const boundary = new Set<WsTransportMessage>();
    const ws = this.findSocketForCanaryTarget(target);
    if (!ws) return boundary;
    const inFlight = this.inFlightTransportMessages.get(ws);
    if (inFlight) boundary.add(inFlight);
    const queue = this.transportQueues.get(ws);
    if (queue) {
      for (const message of getTransportMessagesInPriorityOrder(queue)) boundary.add(message);
    }
    return boundary;
  }

  private hasPendingWsRollbackBoundary(target: WsCanaryTarget, state: WsCanaryState): boolean {
    const boundary = state.rollbackPendingMessages;
    if (!boundary || boundary.size === 0) return false;
    const ws = this.findSocketForCanaryTarget(target);
    if (!ws) return false;
    const inFlight = this.inFlightTransportMessages.get(ws);
    if (inFlight && boundary.has(inFlight)) return true;
    const queue = this.transportQueues.get(ws);
    return queue ? getTransportMessagesInPriorityOrder(queue).some(message => boundary.has(message)) : false;
  }

  private isWsRollbackBoundaryMessage(ws: WebSocket, message: WsTransportMessage): boolean {
    const state = this.getWsCanaryStateForSocket(ws);
    return state?.rollbackState === 'draining'
      && Boolean(state.rollbackPendingMessages?.has(message));
  }

  private closeWsCanaryRollback(state: WsCanaryState): void {
    if (state.rollbackState !== 'draining' || !state.rollbackLease) return;
    state.rollbackState = 'closed';
    this.terminalResourcePolicyCanaryRegistries.targetHandles.delete(
      this.canaryTargetKey(state.target),
    );
    this.appendWsCanaryLedger(state, state.rollbackLease, {
      event: 'rollback-closed',
      previousEffectiveDecision: state.rollbackPreviousDecision ?? state.effectiveDecision,
      nextEffectiveDecision: state.effectiveDecision,
      accepted: true,
      reason: 'rollback-closed',
      rollbackResult: 'closed',
    });
    state.rollbackAwaitGeneration = undefined;
    state.rollbackPendingMessages = undefined;
    state.rollbackPreviousDecision = undefined;
    state.rollbackLease = undefined;
    this.pruneClosedTerminalResourcePolicyCanaryStates();
  }

  private pruneClosedTerminalResourcePolicyCanaryStates(): void {
    let excess = this.terminalResourcePolicyCanaryStates.size
      - MAX_RETAINED_TERMINAL_RESOURCE_POLICY_CANARY_STATES;
    if (excess <= 0) return;
    for (const [key, state] of this.terminalResourcePolicyCanaryStates) {
      if (excess <= 0) break;
      if (state.rollbackState !== 'closed'
        || this.terminalResourcePolicyCanaryRegistries.targetHandles.has(key)) {
        continue;
      }
      this.terminalResourcePolicyCanaryStates.delete(key);
      this.terminalResourcePolicyPrunedLedgerCount += 1;
      excess -= 1;
    }
  }

  private closeCompletedTerminalResourcePolicyRollbacks(ws: WebSocket): void {
    const rawMeta = this.clients.get(ws) as (WsClientMeta & {
      connectionId?: string;
      reconnectGeneration?: number;
    }) | undefined;
    if (!rawMeta?.connectionId || rawMeta.reconnectGeneration === undefined) return;
    const target: WsCanaryTarget = {
      kind: 'ws',
      connectionId: rawMeta.connectionId,
      clientId: rawMeta.clientId,
      channel: 'output',
      reconnectGeneration: rawMeta.reconnectGeneration,
    };
    const state = this.terminalResourcePolicyCanaryStates.get(this.canaryTargetKey(target));
    if (
      state?.rollbackState === 'draining'
      && !this.hasPendingWsRollbackBoundary(target, state)
    ) {
      this.closeWsCanaryRollback(state);
    }
  }

  private settleTerminalResourcePolicyTargetOnTransportClose(ws: WebSocket): void {
    const meta = this.clients.get(ws) as (WsClientMeta & {
      connectionId?: string;
      reconnectGeneration?: number;
    }) | undefined;
    if (!meta?.connectionId || meta.reconnectGeneration === undefined) return;
    const target: WsCanaryTarget = {
      kind: 'ws',
      connectionId: meta.connectionId,
      clientId: meta.clientId,
      channel: 'output',
      reconnectGeneration: meta.reconnectGeneration,
    };
    const state = this.terminalResourcePolicyCanaryStates.get(this.canaryTargetKey(target));
    if (!state) return;
    if (state.rollbackState === 'draining') {
      this.closeWsCanaryRollback(state);
      return;
    }
    if (state.mode !== 'candidate' || !state.activeLease) return;
    const lease = state.activeLease;
    const previousDecision = state.effectiveDecision;
    state.mode = 'legacy';
    state.policyGeneration += 1;
    state.effectiveDecision = this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes;
    state.rollbackState = 'draining';
    state.rollbackPreviousDecision = previousDecision;
    state.rollbackLease = lease;
    state.activeLease = undefined;
    this.terminalResourcePolicyAuthority?.revokeTarget(target);
    for (const [event, rollbackResult] of [
      ['rollback-requested', 'requested'],
      ['rollback-draining', 'draining'],
    ] as const) {
      this.appendWsCanaryLedger(state, lease, {
        event,
        previousEffectiveDecision: previousDecision,
        nextEffectiveDecision: state.effectiveDecision,
        accepted: true,
        reason: 'target-disconnected',
        rollbackResult,
      });
    }
    this.closeWsCanaryRollback(state);
  }

  private sendTransportMessage(ws: WebSocket, message: WsTransportMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const mode = this.runtimeSendPolicyConfig.mode;
    const bufferedAmount = this.getServerBufferedAmount(ws);
    this.maxServerBufferedAmountObserved = Math.max(this.maxServerBufferedAmountObserved, bufferedAmount);

    if (mode === 'direct') {
      const directState = this.transportQueues.get(ws);
      if (directState && (directState.sending || hasTransportQueuedMessages(directState))) {
        const enqueued = this.enqueueTransportMessage(ws, directState, message);
        if (!directState.sending) this.flushTransportQueue(ws);
        return enqueued;
      }
      this.sendRawTransportMessage(ws, message, directState);
      return true;
    }

    const limits = this.runtimeSendPolicyConfig.limits;
    const projectedBufferedAmount = bufferedAmount + message.byteLength;
    if (projectedBufferedAmount >= limits.serverBufferedHardLimitBytes) {
      if (mode === 'safe-send-observe') {
        this.transportBackpressureObserveCount += 1;
        this.sendRawTransportMessage(ws, message);
        return true;
      }
      this.closeBackpressuredClient(ws, 'server-buffered-hard-limit');
      return false;
    }

    const state = this.getTransportQueueState(ws);
    if (mode === 'safe-send-observe') {
      if (hasTransportQueuedMessages(state)) {
        this.transportBackpressureObserveCount += 1;
        const enqueued = this.enqueueTransportMessage(
          ws,
          state,
          message,
          this.getEffectiveOutputQueueLimit(ws, message),
          false,
        );
        if (enqueued && !state.sending) {
          this.terminalResourcePolicyAdmissionDrainSockets.add(ws);
          this.drainTerminalResourcePolicyAdmissionQueue(ws);
        }
        return enqueued;
      }
      if (projectedBufferedAmount >= limits.serverBufferedHighWaterBytes || hasTransportQueuedMessages(state)) {
        this.transportBackpressureObserveCount += 1;
      }
      this.sendRawTransportMessage(ws, message);
      return true;
    }

    if (
      projectedBufferedAmount >= limits.serverBufferedHighWaterBytes
      || state.sending
      || hasTransportQueuedMessages(state)
    ) {
      const recoveringHeldCanary = (peekNextTransportMessage(state)?.canarySendFailureCount ?? 0) > 1;
      const enqueued = this.enqueueTransportMessage(ws, state, message);
      if (enqueued && recoveringHeldCanary && !state.sending) {
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        this.flushTransportQueue(ws);
      }
      return enqueued;
    }

    this.sendRawTransportMessage(ws, message, state);
    return true;
  }

  private enqueueTransportMessage(
    ws: WebSocket,
    state: WsTransportQueueState,
    message: WsTransportMessage,
    outputQueueMaxBytes = this.getEffectiveOutputQueueLimit(ws, message),
    closeOnOverflow = true,
  ): boolean {
    const limits = this.runtimeSendPolicyConfig.limits;
    if (isOutputBudgetMessage(message)) {
      const last = getLastTerminalTransportMessage(state);
      const coalesced = last
        ? tryCoalesceOutputMessage(last, message, limits.outputCoalesceWindowMs)
        : null;
      if (last && coalesced) {
        const nextOutputBytes = state.outputBytes - last.byteLength + coalesced.byteLength;
        if (nextOutputBytes > outputQueueMaxBytes) {
          this.transportQueueOverflowCount += 1;
          if (closeOnOverflow) this.closeBackpressuredClient(ws, 'output-queue-overflow');
          return false;
        }
        replaceLastTerminalTransportMessage(state, coalesced);
        state.outputBytes = nextOutputBytes;
        this.transportOutputCoalesceCount += 1;
        this.updateTransportQueueHighWater(state);
        this.scheduleTransportFlush(ws, state);
        return true;
      }

      if (state.outputBytes + message.byteLength > outputQueueMaxBytes) {
        this.transportQueueOverflowCount += 1;
        if (closeOnOverflow) this.closeBackpressuredClient(ws, 'output-queue-overflow');
        return false;
      }
      state.outputBytes += message.byteLength;
      pushTransportMessage(state, message);
      this.updateTransportQueueHighWater(state);
      this.scheduleTransportFlush(ws, state);
      return true;
    }

    if (state.controlBytes + message.byteLength > limits.perClientControlQueueMaxBytes) {
      this.transportQueueOverflowCount += 1;
      this.closeBackpressuredClient(ws, 'control-queue-overflow');
      return false;
    }
    state.controlBytes += message.byteLength;
    pushTransportMessage(state, message);
    this.updateTransportQueueHighWater(state);
    this.scheduleTransportFlush(ws, state);
    return true;
  }

  private flushTransportQueue(ws: WebSocket): void {
    const state = this.transportQueues.get(ws);
    if (!state || state.sending || !hasTransportQueuedMessages(state) || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const limits = this.runtimeSendPolicyConfig.limits;
    const bufferedAmount = this.getServerBufferedAmount(ws);
    this.maxServerBufferedAmountObserved = Math.max(this.maxServerBufferedAmountObserved, bufferedAmount);
    const peeked = peekNextTransportMessage(state);
    if (!peeked) {
      return;
    }
    if (bufferedAmount + peeked.byteLength >= limits.serverBufferedHardLimitBytes) {
      this.closeBackpressuredClient(ws, 'server-buffered-hard-limit');
      return;
    }
    if (bufferedAmount >= limits.serverBufferedHighWaterBytes) {
      this.scheduleTransportFlush(ws, state);
      return;
    }

    const next = dequeueNextTransportMessage(state);
    if (!next) {
      return;
    }
    if (isOutputBudgetMessage(next)) {
      state.outputBytes = Math.max(0, state.outputBytes - next.byteLength);
    } else {
      state.controlBytes = Math.max(0, state.controlBytes - next.byteLength);
    }
    this.sendRawTransportMessage(ws, next, state);
  }

  private sendRawTransportMessage(
    ws: WebSocket,
    message: WsTransportMessage,
    state = this.transportQueues.get(ws),
  ): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // `01:1193` — a frame built under a codec the group has left is dropped and
    // accounted for, never re-encoded: re-encoding would renumber a channel the
    // client still holds under the old table.
    if (message.payload.codec === 'binary'
      && message.payload.codecEpoch !== this.terminalBinaryGroupFor(ws)?.codecEpoch) {
      this.settleTransportMessage(message, new Error('codec-epoch-retired'));
      if (state) this.flushTransportQueue(ws);
      return;
    }

    if (message.terminalAuthorityTransportBinding
      && !this.isCurrentTerminalAuthorityTransportBinding(ws, message.terminalAuthorityTransportBinding)) {
      this.notifyTerminalAuthorityTransportBindingReplaced(ws);
      this.settleTransportMessage(
        message,
        new Error('terminal-authority-transport-binding-replaced'),
      );
      if (state) this.flushTransportQueue(ws);
      return;
    }

    if (state) {
      state.sending = true;
    }

    const tracksSettlement = state !== undefined || message.onSettled !== undefined;
    if (tracksSettlement) this.inFlightTransportMessages.set(ws, message);

    try {
      const onSent = (error?: Error) => {
        if (tracksSettlement && this.inFlightTransportMessages.get(ws) !== message) {
          return;
        }
        if (tracksSettlement) this.inFlightTransportMessages.delete(ws);
        if (state) {
          state.sending = false;
        }
        const settlementError = !error
          && message.terminalAuthorityTransportBinding
          && !this.isCurrentTerminalAuthorityTransportBinding(
            ws,
            message.terminalAuthorityTransportBinding,
          )
          ? new Error('terminal-authority-transport-binding-replaced')
          : error;
        const bindingReplaced = settlementError?.message === 'terminal-authority-transport-binding-replaced';
        const canaryFailure = !bindingReplaced && (
          this.isCurrentCandidateTransportMessage(ws, message)
          || this.isWsRollbackBoundaryMessage(ws, message)
        );
        const fairDeliveryFailure = this.isFairTerminalDeliveryTransportMessage(message);
        if (settlementError) {
          if (bindingReplaced) this.notifyTerminalAuthorityTransportBindingReplaced(ws);
          this.settleTransportMessage(message, settlementError);
          this.transportSendErrorCount += 1;
          const failureCount = canaryFailure
            ? this.retainFailedTerminalResourcePolicyMessage(ws, message, state)
            : 0;
          if (canaryFailure) {
            this.settleTerminalResourcePolicyTargetOnSendFailure(ws, 'send-callback-error');
          }
          if (this.runtimeSendPolicyConfig.mode === 'safe-send-enforce'
            && !canaryFailure
            && !bindingReplaced
            && !fairDeliveryFailure) {
            this.closeBackpressuredClient(ws, 'send-callback-error');
          } else {
            console.warn('[WS] WebSocket send callback failed:', settlementError);
          }
          if (canaryFailure) {
            this.resumeTerminalResourcePolicyQueueAfterSendFailure(
              ws,
              message,
              failureCount,
              'send-callback-error',
            );
          }
          return;
        }
        this.settleTransportMessage(message);
        this.closeCompletedTerminalResourcePolicyRollbacks(ws);
        if (this.policyRollbackDrainSockets.has(ws)) {
          this.drainTransportQueueForPolicyRollback(ws);
          return;
        }
        if (this.terminalResourcePolicyAdmissionDrainSockets.has(ws)) {
          this.drainTerminalResourcePolicyAdmissionQueue(ws);
          return;
        }
        this.flushTransportQueue(ws);
      };
      // `01 §3.1` — the union forces this site to name its branch, which is
      // what makes "binary frame on a JSON-only socket" unrepresentable.
      if (message.payload.codec === 'binary') {
        ws.send(message.payload.bytes, { binary: true }, onSent);
      } else {
        ws.send(message.payload.text, onSent);
      }
    } catch (error) {
      this.settleTransportMessage(
        message,
        error instanceof Error ? error : new Error(String(error)),
      );
      const canaryFailure = this.isCurrentCandidateTransportMessage(ws, message)
        || this.isWsRollbackBoundaryMessage(ws, message);
      const fairDeliveryFailure = this.isFairTerminalDeliveryTransportMessage(message);
      if (this.inFlightTransportMessages.get(ws) === message) {
        this.inFlightTransportMessages.delete(ws);
      }
      if (state) {
        state.sending = false;
      }
      this.transportSendErrorCount += 1;
      console.warn('[WS] WebSocket send failed:', error);
      const failureCount = canaryFailure
        ? this.retainFailedTerminalResourcePolicyMessage(ws, message, state)
        : 0;
      if (canaryFailure) {
        this.settleTerminalResourcePolicyTargetOnSendFailure(ws, 'send-failed');
      }
      if (this.runtimeSendPolicyConfig.mode === 'safe-send-enforce'
        && !canaryFailure
        && !fairDeliveryFailure) {
        this.closeBackpressuredClient(ws, 'send-failed');
      }
      if (canaryFailure) {
        this.resumeTerminalResourcePolicyQueueAfterSendFailure(
          ws,
          message,
          failureCount,
          'send-failed',
        );
      }
    }
  }

  private isCurrentTerminalAuthorityTransportBinding(
    ws: WebSocket,
    expected: NonNullable<WsTransportMessage['terminalAuthorityTransportBinding']>,
  ): boolean {
    const controlEntry = [...this.clients.entries()].reverse().find(([candidate, meta]) => (
      candidate.readyState === WebSocket.OPEN
      && meta.channelRole !== 'output'
      && (meta.connectionId ?? meta.clientId) === expected.connectionId
    ));
    if (!controlEntry) return false;
    const [control] = controlEntry;
    const group = this.splitSocketGroups.get(control);
    const target = expected.lane === 'terminal' && group?.output?.readyState === WebSocket.OPEN
      ? group.output
      : control;
    return target === ws
      && this.getTerminalAuthorityTransportBindingId(target) === expected.bindingId;
  }

  private settleTransportMessage(message: WsTransportMessage, error?: Error): void {
    const onSettled = message.onSettled;
    message.onSettled = undefined;
    onSettled?.(error);
  }

  // @req PERF-BGSTAB-010 AC-5 AC-8
  private isFairTerminalDeliveryTransportMessage(message: WsTransportMessage): boolean {
    return message.type === 'output'
      && message.connectionEpoch !== undefined
      && message.sessionId !== undefined
      && message.deliverySeq !== undefined
      && message.deliveryKind !== undefined;
  }

  private retainFailedTerminalResourcePolicyMessage(
    ws: WebSocket,
    message: WsTransportMessage,
    existingState?: WsTransportQueueState,
  ): number {
    const state = existingState ?? this.getTransportQueueState(ws);
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    message.canarySendFailureCount = (message.canarySendFailureCount ?? 0) + 1;
    prependTransportMessage(state, message);
    if (isOutputBudgetMessage(message)) state.outputBytes += message.byteLength;
    else state.controlBytes += message.byteLength;
    this.updateTransportQueueHighWater(state);
    return message.canarySendFailureCount;
  }

  private resumeTerminalResourcePolicyQueueAfterSendFailure(
    ws: WebSocket,
    message: WsTransportMessage,
    failureCount: number,
    reason: string,
  ): void {
    if (failureCount > 1) {
      this.recordTerminalResourcePolicyRetryHeld(ws, message, reason);
      return;
    }
    queueMicrotask(() => {
      const state = this.transportQueues.get(ws);
      if (
        !state
        || state.sending
        || ws.readyState !== WebSocket.OPEN
        || !hasTransportQueuedMessages(state)
      ) return;
      if (this.runtimeSendPolicyConfig.mode === 'safe-send-enforce') {
        this.flushTransportQueue(ws);
        return;
      }
      this.terminalResourcePolicyAdmissionDrainSockets.add(ws);
      this.drainTerminalResourcePolicyAdmissionQueue(ws);
    });
  }

  private recordTerminalResourcePolicyRetryHeld(
    ws: WebSocket,
    message: WsTransportMessage,
    reason: string,
  ): void {
    const state = this.getWsCanaryStateForSocket(ws);
    if (state?.rollbackState !== 'draining' || !state.rollbackLease) return;
    this.appendWsCanaryLedger(state, state.rollbackLease, {
      event: 'transport-retry-held',
      previousEffectiveDecision: state.rollbackPreviousDecision ?? state.effectiveDecision,
      nextEffectiveDecision: state.effectiveDecision,
      accepted: false,
      reason: `${reason}-retry-held-${message.canarySendFailureCount ?? 0}`,
      rollbackResult: 'draining',
    });
  }

  private settleTerminalResourcePolicyTargetOnSendFailure(ws: WebSocket, reason: string): void {
    const state = this.getWsCanaryStateForSocket(ws);
    if (!state) return;
    if (state.rollbackState === 'draining') {
      this.closeCompletedTerminalResourcePolicyRollbacks(ws);
      return;
    }
    if (state.mode !== 'candidate' || !state.activeLease) return;
    const lease = state.activeLease;
    const previousDecision = state.effectiveDecision;
    state.rollbackPendingMessages = this.captureWsRollbackBoundary(state.target);
    state.mode = 'legacy';
    state.policyGeneration += 1;
    state.effectiveDecision = this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes;
    state.rollbackState = 'draining';
    state.rollbackPreviousDecision = previousDecision;
    state.rollbackLease = lease;
    state.activeLease = undefined;
    this.terminalResourcePolicyAuthority?.revokeTarget(state.target);
    for (const [event, rollbackResult] of [
      ['rollback-requested', 'requested'],
      ['rollback-draining', 'draining'],
    ] as const) {
      this.appendWsCanaryLedger(state, lease, {
        event,
        previousEffectiveDecision: previousDecision,
        nextEffectiveDecision: state.effectiveDecision,
        accepted: false,
        reason,
        rollbackResult,
      });
    }
    if (!this.hasPendingWsRollbackBoundary(state.target, state)) {
      this.closeWsCanaryRollback(state);
    }
  }

  private isCurrentCandidateTransportMessage(ws: WebSocket, message: WsTransportMessage): boolean {
    const state = this.getWsCanaryStateForSocket(ws);
    return state?.mode === 'candidate'
      && message.policyGeneration !== undefined
      && message.policyGeneration === state.policyGeneration;
  }

  private closeBackpressuredClient(ws: WebSocket, reason: string): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.transportSlowClientCloseCount += 1;
    this.clearTransportQueueState(ws);
    this.settleTerminalResourcePolicyTargetOnTransportClose(ws);
    try {
      ws.close(1013, `WebSocket backpressure: ${reason}`);
    } catch {
      ws.terminate();
    }
  }

  private clearTransportQueueState(ws: WebSocket): void {
    this.policyRollbackDrainSockets.delete(ws);
    this.terminalResourcePolicyAdmissionDrainSockets.delete(ws);
    const state = this.transportQueues.get(ws);
    const inFlight = this.inFlightTransportMessages.get(ws);
    if (inFlight) {
      this.settleTransportMessage(inFlight, new Error('terminal-authority-transport-closed'));
      this.inFlightTransportMessages.delete(ws);
    }
    if (!state) {
      return;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
    }
    for (const message of getTransportMessagesInPriorityOrder(state)) {
      this.settleTransportMessage(message, new Error('terminal-authority-transport-queue-cleared'));
    }
    clearTransportMessages(state);
    state.outputBytes = 0;
    state.controlBytes = 0;
    state.sending = false;
    state.flushTimer = null;
    this.transportQueues.delete(ws);
    this.inFlightTransportMessages.delete(ws);
  }

  private flushAndClearTransportQueuesForPolicyRollback(): void {
    for (const [ws, state] of this.transportQueues) {
      const queued = getTransportMessagesInPriorityOrder(state);
      this.clearTransportQueueState(ws);
      for (const message of queued) {
        this.sendRawTransportMessage(ws, message, undefined);
      }
    }
  }

  private updateTransportQueueHighWater(state: WsTransportQueueState): void {
    this.maxTransportQueuedBytesObserved = Math.max(
      this.maxTransportQueuedBytesObserved,
      state.outputBytes + state.controlBytes,
    );
  }

  private getServerBufferedAmount(ws: WebSocket): number {
    return typeof ws.bufferedAmount === 'number' && Number.isFinite(ws.bufferedAmount)
      ? Math.max(0, ws.bufferedAmount)
      : 0;
  }

  private scheduleTransportFlush(ws: WebSocket, state = this.transportQueues.get(ws)): void {
    if (
      !state
      || state.flushTimer
      || !hasTransportQueuedMessages(state)
      || this.runtimeSendPolicyConfig.mode !== 'safe-send-enforce'
    ) {
      return;
    }

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flushTransportQueue(ws);
      const next = this.transportQueues.get(ws);
      if (next && hasTransportQueuedMessages(next) && !next.sending) {
        this.scheduleTransportFlush(ws, next);
      }
    }, TRANSPORT_FLUSH_RETRY_MS);
    state.flushTimer.unref();
  }

  broadcastAll(event: string, data: object, excludeClientId?: string): void {
    for (const [ws, meta] of this.clients) {
      if (meta.clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        this.sendTo(ws, { type: event, data });
      }
    }
  }

  private drainTransportQueueForPolicyRollback(ws: WebSocket): void {
    const state = this.transportQueues.get(ws);
    if (!state || state.sending || ws.readyState !== WebSocket.OPEN) return;
    const next = dequeueNextTransportMessage(state);
    if (!next) {
      this.policyRollbackDrainSockets.delete(ws);
      this.clearTransportQueueState(ws);
      return;
    }
    if (isOutputBudgetMessage(next)) {
      state.outputBytes = Math.max(0, state.outputBytes - next.byteLength);
    } else {
      state.controlBytes = Math.max(0, state.controlBytes - next.byteLength);
    }
    this.sendRawTransportMessage(ws, next, state);
  }

  private drainTerminalResourcePolicyAdmissionQueue(ws: WebSocket): void {
    const state = this.transportQueues.get(ws);
    if (!state || state.sending || ws.readyState !== WebSocket.OPEN) return;
    const next = dequeueNextTransportMessage(state);
    if (!next) {
      this.terminalResourcePolicyAdmissionDrainSockets.delete(ws);
      this.clearTransportQueueState(ws);
      return;
    }
    if (isOutputBudgetMessage(next)) {
      state.outputBytes = Math.max(0, state.outputBytes - next.byteLength);
    } else {
      state.controlBytes = Math.max(0, state.controlBytes - next.byteLength);
    }
    this.sendRawTransportMessage(ws, next, state);
  }

  // A replay timeout is a failed authority transaction. No queued input may
  // cross that failed fence, including input that would otherwise be safe to
  // retry. Enter keeps its more specific reason so operators can distinguish
  // command-execution risk from a general stale replay timeout.
  // @req REL-BGSTAB-009
  private rejectQueuedReplayInputsOnTimeout(
    ws: WebSocket,
    sessionId: string,
    pending: ReplayPendingState,
  ): void {
    for (const input of pending.queuedInputs) {
      this.rejectInput(ws, {
        sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: input.data.includes('\r') || input.data.includes('\n')
          ? 'timeout-enter-safety'
          : 'timeout',
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
      });
    }
  }

  // @req REL-BGSTAB-008
  private discardQueuedRecoveryFrames(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    replayToken?: string,
  ): void {
    const state = this.transportQueues.get(ws);
    if (!state) {
      return;
    }
    const supersededReplayTokens = new Set<string>();
    const supersededRepairTokens = new Set<string>([repairToken]);
    if (typeof replayToken === 'string') {
      supersededReplayTokens.add(replayToken);
    } else {
      for (const message of getTransportMessagesInPriorityOrder(state)) {
        if (
          message.sessionId === sessionId
          && typeof message.repairToken === 'string'
          && (
            message.type === 'output'
            || message.type === 'screen-repair'
            || message.type === 'screen-repair:restore-needed'
            || message.type === 'session:ready'
          )
        ) {
          supersededRepairTokens.add(message.repairToken);
        }
        if (
          message.sessionId === sessionId
          && typeof message.replayToken === 'string'
          && (
            message.type === 'output'
            || message.type === 'screen-snapshot'
            || message.type === 'session:ready'
            || message.type === 'screen-repair:restore-needed'
          )
        ) {
          supersededReplayTokens.add(message.replayToken);
        }
      }
    }
    removeTransportMessages(state, message => (
      message.sessionId === sessionId
      && (
        [...supersededRepairTokens].some(supersededToken => (
          isSupersededRepairTransportMessage(message, {
            sessionId,
            repairToken: supersededToken,
          })
        ))
        || [...supersededReplayTokens].some(supersededToken => (
          isSupersededRecoveryTransportMessage(message, {
            sessionId,
            replayToken: supersededToken,
          })
        ))
      )
    ));
  }

  // @req REL-BGSTAB-008
  private sendPriorityControl(ws: WebSocket, msg: object): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const transportMessage = createWsTransportMessage(msg);
    transportMessage.kind = 'control';
    this.sendTransportMessage(ws, transportMessage);
  }

  // @req REL-BGSTAB-008
  private sendNonCoalescingOutputChunk(
    ws: WebSocket,
    sessionId: string,
    data: string,
    metadata: {
      repairToken?: string;
      replayToken?: string;
      screenSeq?: number;
      authorityEpoch?: string;
      authorityRevision?: number;
      chunkId?: string;
    } = {},
  ): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const transportMessage = createWsTransportMessage({
      type: 'output',
      sessionId,
      data,
      repairToken: metadata.repairToken,
      replayToken: metadata.replayToken,
      screenSeq: metadata.screenSeq,
      authorityEpoch: metadata.authorityEpoch,
      authorityRevision: metadata.authorityRevision,
      chunkId: metadata.chunkId,
    });
    transportMessage.outputData = undefined;
    this.sendTransportMessage(ws, transportMessage);
  }

  sendTo(
    ws: WebSocket,
    msg: object,
    onSettled?: (error?: Error) => void,
    terminalAuthorityTransportBinding?: WsTransportMessage['terminalAuthorityTransportBinding'],
  ): boolean {
    if (ws.readyState === WebSocket.OPEN) {
      const now = Date.now();
      const record = msg as Record<string, unknown>;
      const canaryState = this.getWsCanaryStateForSocket(ws);
      const transportMessage = createWsTransportMessage(msg, now, {
        policyGeneration: canaryState?.policyGeneration ?? this.transportPolicyGeneration,
        expiresAt: Number.MAX_SAFE_INTEGER,
        ready: true,
        recoveryGeneration: 0,
        source: 'ws-router',
        exactlyOnceKey: typeof record.chunkId === 'string'
          ? record.chunkId
          : record.type === 'output'
            ? undefined
            : `ws-${now}-${this.replayEventCounter}`,
      });
      const authorityFrame = typeof record.type === 'string' && (
        record.type.startsWith('terminal-authority:')
        || record.type.startsWith('terminal-checkpoint:')
      );
      const meta = this.clients.get(ws);
      const implicitTransportBinding = authorityFrame && meta
        ? {
            connectionId: meta.connectionId ?? meta.clientId,
            lane: meta.channelRole === 'output' ? 'terminal' as const : 'control' as const,
            bindingId: this.getTerminalAuthorityTransportBindingId(ws),
          }
        : undefined;
      if (terminalAuthorityTransportBinding ?? implicitTransportBinding) {
        transportMessage.terminalAuthorityTransportBinding = terminalAuthorityTransportBinding
          ?? implicitTransportBinding;
      }
      transportMessage.onSettled = onSettled;
      const sent = this.sendTransportMessage(ws, transportMessage);
      if (!sent) this.settleTransportMessage(
        transportMessage,
        new Error('terminal-authority-transport-admission-rejected'),
      );
      return sent;
    }
    onSettled?.(new Error('terminal-authority-socket-not-open'));
    return false;
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [, meta] of this.clients) {
      for (const pending of meta.replayPendingSessions.values()) {
        clearTimeout(pending.timer);
      }
      for (const pending of this.getScreenRepairPendingSessions(meta).values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
      }
    }

    for (const [ws] of Array.from(this.clients)) {
      this.handleDisconnect(ws);
      ws.terminate();
    }
    this.clients.clear();
    this.transportQueues.clear();
    this.inFlightTransportMessages.clear();
    this.policyRollbackDrainSockets.clear();
    this.terminalResourcePolicyAdmissionDrainSockets.clear();
    this.terminalResourcePolicyCanaryRegistries.targetHandles.clear();
    this.terminalResourcePolicyCanaryRegistries.listeners.clear();
    this.terminalResourcePolicyCanaryRegistries.timers.clear();
    this.terminalResourcePolicyCanaryStates.clear();
    for (const fairDelivery of this.fairDeliverySchedulers.values()) {
      clearInterval(fairDelivery.maintenanceTimer);
    }
    this.fairDeliverySchedulers.clear();
    this.fairDeliveryEpochGenerations.clear();
    this.sessionSubscribers.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScreenRepairReason(value: unknown): value is ScreenRepairReason {
  return value === 'manual' || value === 'workspace' || value === 'resize';
}

function cloneServerWsResourceLimits(source: ServerWsResourceLimitsConfig): ServerWsResourceLimitsConfig {
  return {
    serverBufferedHighWaterBytes: source.serverBufferedHighWaterBytes,
    serverBufferedHardLimitBytes: source.serverBufferedHardLimitBytes,
    perClientOutputQueueMaxBytes: source.perClientOutputQueueMaxBytes,
    perClientControlQueueMaxBytes: source.perClientControlQueueMaxBytes,
    outputCoalesceWindowMs: source.outputCoalesceWindowMs,
  };
}

function isScreenRepairBufferType(value: unknown): value is ScreenRepairBufferType {
  return value === 'normal' || value === 'alternate';
}
