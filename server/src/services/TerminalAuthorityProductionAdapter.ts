import { createHash, randomUUID } from 'node:crypto';
import { SessionManager } from './SessionManager.js';
import {
  createTerminalAuthorityController,
  type TerminalAuthorityController,
  type TerminalAuthorityEvent,
  type TerminalLegacyResponderIdentity,
  type TerminalAuthorityPromotionResult,
  type TerminalAuthorityResponderIdentity,
  type TerminalAuthorityResponderViewIdentity,
  type TerminalAuthorityState,
} from './TerminalAuthorityController.js';
import {
  createTerminalQueryReplyIngress,
  WsRouter,
  type TerminalAuthorityFreshCheckpoint,
  type TerminalAuthorityResponderIdentity as WsResponderIdentity,
} from '../ws/WsRouter.js';
import {
  installTerminalQueryResponder,
  type DriverViewIdentity,
  type TerminalViewAttributes,
} from '../utils/terminalQueryResponder.js';
import {
  isCanonicalOrdinal64,
  TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
} from '../types/ws-protocol.js';

export const TERMINAL_AUTHORITY_DEFAULT_ACK_DEADLINE_MS = 2_500;

export function getTerminalAuthorityPromotionAckTimerDelayMs(
  configuredAckDeadlineMs?: number,
): number {
  return (configuredAckDeadlineMs ?? TERMINAL_AUTHORITY_DEFAULT_ACK_DEADLINE_MS) + 1;
}

interface ProductionAdapterOptions {
  authService: {
    verifyToken(token: string): {
      valid: true;
      payload: { sub: string; jti: string };
    };
  };
  transportMode: 'unified' | 'split';
  sessionManager: {
    platform: 'linux';
    spawnPty: NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'];
    readProcessStartIdentityFn: NonNullable<ConstructorParameters<typeof SessionManager>[1]>['readProcessStartIdentityFn'];
    retainedTerminalShadowEnabled: true;
    retainedTerminalInitialOrdinal?: { streamEpoch: string; sourceSeq: string };
    writeHeadlessTerminalFn?: NonNullable<ConstructorParameters<typeof SessionManager>[1]>['writeHeadlessTerminalFn'];
  };
  now?: () => number;
  promotionSafetyLimits?: {
    ackDeadlineMs: number;
    maxHeldOutputBytes: number;
    maxHeldOutputChunks: number;
  };
  checkpointReadyHandshakeTimeoutMs?: number;
  viewAttributesHandshakeTimeoutMs?: number;
}

export interface ProductionTerminalAuthorityWiringEvidence {
  source: 'production-default';
  sessionManagerBoundToRouter: true;
  controllerFactory: 'production-terminal-authority-controller';
  retainedCheckpointAdapter: 'session-manager-retained-terminal';
  checkpointDigestAdapter: 'sha256';
  controllerFactoryCallCount: number;
  retainedCheckpointAdapterCallCount: number;
  checkpointDigestAdapterCallCount: number;
  injectedControllerFactory: false;
  injectedCheckpointAssembler: false;
}

export function isCheckpointOutputAuthorityMode(mode: TerminalAuthorityState['mode']): boolean {
  return mode === 'promoting' || mode === 'server' || mode === 'rolling-back';
}

export function isServerOutputCoveredByPendingViewRecovery(input: Readonly<{
  messageType: unknown;
  authorityMode: TerminalAuthorityState['mode'];
  hasCheckpoint: boolean;
  pendingViewRecovery: boolean;
}>): boolean {
  return input.messageType === 'output'
    && input.authorityMode === 'server'
    && !input.hasCheckpoint
    && input.pendingViewRecovery;
}

export function isScheduledTerminalAuthorityRuntimeCurrent(
  scheduledRuntime: { disposed: boolean },
  currentRuntime: { disposed: boolean } | undefined,
): boolean {
  return !scheduledRuntime.disposed && currentRuntime === scheduledRuntime;
}

export function isValidCheckpointDrainWatermark(
  checkpointSourceSeq: string,
  reservedTailSourceSeq: string,
  drainedThroughSeq: string,
): boolean {
  const canonicalOrdinal = /^(?:0|[1-9][0-9]*)$/u;
  if (![checkpointSourceSeq, reservedTailSourceSeq, drainedThroughSeq]
    .every(value => canonicalOrdinal.test(value))) {
    return false;
  }
  const checkpoint = BigInt(checkpointSourceSeq);
  const reservedTail = BigInt(reservedTailSourceSeq);
  const drained = BigInt(drainedThroughSeq);
  return checkpoint <= drained && drained <= reservedTail;
}

export interface ProductionTerminalAuthorityIntegration {
  sessionManager: SessionManager;
  wsRouter: WsRouter;
  beginPromotion(sessionId: string): Promise<TerminalAuthorityPromotionResult>;
  beginRollback(sessionId: string, reason?: string): Promise<{ ok: boolean; reason?: string }>;
  beginRollback(input: {
    sessionId: string;
    selectedCompatibilityView: { connectionId: string; viewGeneration: number };
  }): Promise<{ ok: boolean; reason?: string }>;
  getState(sessionId: string): TerminalAuthorityState | undefined;
  getAuthorityState(sessionId: string): TerminalAuthorityState | undefined;
  getAudit(sessionId: string): readonly TerminalAuthorityEvent[];
  getAuthorityAuditTrail(sessionId: string, limit?: number): readonly TerminalAuthorityEvent[];
  getWiring(sessionId?: string): ProductionTerminalAuthorityWiringEvidence;
  getWiringEvidence(sessionId: string): ProductionTerminalAuthorityWiringEvidence;
  getAuthorityController(sessionId: string): TerminalAuthorityController | undefined;
  getSessionSnapshot(sessionId: string): {
    state: TerminalAuthorityState;
    audit: readonly TerminalAuthorityEvent[];
    wiring: ProductionTerminalAuthorityWiringEvidence;
  } | undefined;
  getQueryResponderCapabilityState(sessionId: string): {
    promotionEligible: boolean;
    blocker?: string;
    hasAcceptedViewAttributes: boolean;
  } | null;
  requestQueryResponderCapabilityRefresh(sessionId: string): Promise<boolean>;
  triggerTerminalAuthorityDebugFault(input: {
    sessionId: string;
    faultPoint: 'legacy-disable-ack-immediate-send-failed';
    expectedAction: 'server-abort-rollback-without-pausing-pty';
    triggerId: string;
  }): Promise<Record<string, unknown>>;
  destroy(): void;
}

export interface AttachProductionTerminalAuthorityOptions {
  sessionManager: SessionManager;
  wsRouter: WsRouter;
  transportMode: 'unified' | 'split';
  now?: () => number;
  promotionSafetyLimits?: {
    ackDeadlineMs: number;
    maxHeldOutputBytes: number;
    maxHeldOutputChunks: number;
  };
  checkpointReadyHandshakeTimeoutMs?: number;
  viewAttributesHandshakeTimeoutMs?: number;
}

interface PendingViewAttributesHandshake {
  runtimeToken: symbol;
  refreshEpoch: number;
  challengeId: string;
  connectionId: string | null;
  clientId: string | null;
  viewGeneration: number | null;
  streamEpoch: string | null;
  driverLeaseId: string | null;
  driverLeaseGeneration: string | null;
  viewAttributesGeneration: string | null;
  deadlineAt: number;
  deadlineTimer: NodeJS.Timeout;
  promise: Promise<boolean>;
  resolve(result: boolean): void;
  settled: boolean;
  capabilityInFlight: boolean;
  capabilityIssued: boolean;
  dirty: boolean;
  topologyReplacementIssued: boolean;
  replacementIdentityKeys: Set<string>;
  topologyRetargetPending: boolean;
  retargetAnchorConnectionId: string | null;
  retargetAnchorClientId: string | null;
}

type AcceptedViewAttributesHandshakeIdentity = Readonly<Pick<
  PendingViewAttributesHandshake,
  | 'runtimeToken'
  | 'challengeId'
  | 'connectionId'
  | 'clientId'
  | 'viewGeneration'
  | 'streamEpoch'
  | 'driverLeaseId'
  | 'driverLeaseGeneration'
  | 'viewAttributesGeneration'
>>;

interface RuntimeRecord {
  runtimeToken: symbol;
  controller: TerminalAuthorityController;
  disposed: boolean;
  audit: TerminalAuthorityEvent[];
  initialStreamEpoch: string;
  legacyResponderLeaseId: string;
  legacyDriverLeaseId: string;
  frozenViews: TerminalAuthorityResponderViewIdentity[];
  disabledViewKeys: Set<string>;
  expectedLegacyIdentity: TerminalLegacyResponderIdentity | null;
  precommitLegacyDriverIdentity: {
    connectionId: string;
    clientId: string | null;
    viewGeneration: number;
    driverLeaseId: string;
    driverLeaseGeneration: string;
    viewAttributesGeneration: string;
  } | null;
  legacyRebindInFlightKeys: Set<string>;
  legacyRefreshEpoch: number;
  pendingViewAttributesHandshake: PendingViewAttributesHandshake | null;
  pendingViewAttributesChallengeId: string;
  acceptedViewAttributesChallengeId: string | null;
  acceptedViewAttributesIdentity: AcceptedViewAttributesHandshakeIdentity | null;
  physicalDrains: Set<string>;
  applyAcks: Set<string>;
  drainAcks: Map<string, string>;
  limitedSessionSelected: boolean;
  activeCheckpoint: TerminalAuthorityCheckpointIdentity | null;
  activeCheckpointsByView: Map<string, TerminalAuthorityCheckpointIdentity>;
  reservedCheckpointsByView: Map<string, TerminalAuthorityCheckpointIdentity>;
  pendingViewRecoveryKeys: Set<string>;
  checkpointDeliveryReadyRetryAttempts: Map<string, number>;
  pendingCheckpointDeliveryPrepares: Map<string, {
    checkpointDeliveryId: string;
    connectionId: string;
    clientId: string;
    viewGeneration: number;
    authorityEpoch: string;
    streamEpoch: string;
    driverLeaseGeneration: string;
    acceptedViewAttributesGeneration: string;
    viewAttributesChallengeId: string;
    deadlineTimer: NodeJS.Timeout | null;
  }>;
  scheduledViewRecoveryKeys: Set<string>;
  checkpointTailSourceSeqByView: Map<string, string>;
  debugFaultTriggerId: string | null;
  promotionDeadlineTimer: NodeJS.Timeout | null;
  topologyRecoveryTimer: NodeJS.Timeout | null;
  compatibilityTopologyRecoveryInFlight: boolean;
  authorityRecoveryRetryAttempt: number;
  authorityRecoveryRetryTimer: NodeJS.Timeout | null;
  checkpointPumpsByView: Map<string, {
    frames: Array<{
      message: object;
      lane: 'control' | 'terminal';
      resolve: (accepted: boolean) => void;
      onSettled?: () => void;
    }>;
    inFlight?: {
      resolve: (accepted: boolean) => void;
    };
    sending: boolean;
    failed: boolean;
    transportBindingId?: string;
  }>;
  wiring: {
    controllerFactoryCallCount: number;
    retainedCheckpointAdapterCallCount: number;
    checkpointDigestAdapterCallCount: number;
  };
}

interface TerminalAuthorityCheckpointIdentity {
  protocolVersion: 1;
  sessionId: string;
  streamEpoch: string;
  checkpointEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  retentionPolicyId: string;
  authorityMode: 'server' | 'legacy';
  mode: 'authoritative' | 'compatibility';
  transitionEpoch: string;
  authorityEpoch: string;
  responderLeaseId?: string;
  boundarySourceSeq?: string;
  source: 'server-retained-authority';
  authoritativeModelInstanceId: string;
}

const TERMINAL_CHECKPOINT_CHUNK_BYTES = 64 * 1024;
const TERMINAL_AUTHORITY_AUDIT_MAX_ENTRIES = 2_048;

function appendTerminalAuthorityAudit(
  audit: TerminalAuthorityEvent[],
  event: TerminalAuthorityEvent,
): void {
  const { data: _sensitiveTerminalData, ...metadata } = event;
  audit.push(metadata);
  if (audit.length > TERMINAL_AUTHORITY_AUDIT_MAX_ENTRIES) {
    audit.splice(0, audit.length - TERMINAL_AUTHORITY_AUDIT_MAX_ENTRIES);
  }
}

function sourceSequenceRegressed(previous: unknown, next: unknown): boolean {
  return isCanonicalOrdinal64(previous)
    && isCanonicalOrdinal64(next)
    && BigInt(next) < BigInt(previous);
}

// @req MIG-BGSTAB-002 AC-4 AC-3
// Poisoned/no-cache recovery is promotable only after the AC-4 browser view
// proves an exact palette to the AC-3 single query responder authority.
function parseTerminalViewAttributes(value: unknown): TerminalViewAttributes | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parseRgb = (candidate: unknown): readonly [number, number, number] | null => {
    if (!Array.isArray(candidate) || candidate.length !== 3
      || candidate.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      return null;
    }
    return [Number(candidate[0]), Number(candidate[1]), Number(candidate[2])];
  };
  const foreground = parseRgb(record.foreground);
  const background = parseRgb(record.background);
  const cursor = parseRgb(record.cursor);
  const ansi = Array.isArray(record.ansi) ? record.ansi.map(parseRgb) : [];
  if (!foreground || !background || !cursor
    || ansi.length !== 256 || ansi.some(color => color === null)
    || !['block', 'underline', 'bar'].includes(String(record.cursorStyle))
    || typeof record.cursorBlink !== 'boolean'
    || !['dark', 'light'].includes(String(record.colorSchemeMode))) {
    return null;
  }
  return {
    foreground,
    background,
    cursor,
    ansi: ansi as readonly (readonly [number, number, number])[],
    cursorStyle: record.cursorStyle as TerminalViewAttributes['cursorStyle'],
    cursorBlink: record.cursorBlink,
    colorSchemeMode: record.colorSchemeMode as TerminalViewAttributes['colorSchemeMode'],
  };
}

type ProductionTerminalAuthorityRuntimeFactory = (input: {
  sessionId: string;
  authorityEpoch: string;
  sessionGeneration: string;
  initialStreamEpoch: string;
  runtimeInstanceGeneration: number;
  headlessState: Parameters<typeof installTerminalQueryResponder>[0]['headlessState'];
  processMetadata: {
    backend?: string;
    processInstanceId?: string;
    osStartIdentity?: string;
  };
  windowsPty?: { backend?: string };
}) => {
  controller: TerminalAuthorityController;
  queryResponder: ReturnType<typeof installTerminalQueryResponder>;
  dispose(): void;
};

interface SessionManagerAuthorityApi {
  addSessionFinalizedListener(listener: (event: { sessionId: string }) => void): () => void;
  setTerminalAuthorityRuntimeFactory(factory: ProductionTerminalAuthorityRuntimeFactory | null): void;
  clearTerminalAuthorityRuntimeFactory(factory: ProductionTerminalAuthorityRuntimeFactory): boolean;
  detachTerminalAuthorityRuntime(sessionId: string, controller: TerminalAuthorityController): boolean;
  beginTerminalAuthorityPromotion(
    sessionId: string,
    request: Parameters<TerminalAuthorityController['beginPromotion']>[0],
  ): Promise<TerminalAuthorityPromotionResult> | TerminalAuthorityPromotionResult;
  settleTerminalAuthorityPromotionEvidence(sessionId: string): Promise<void>;
  acknowledgeTerminalAuthorityLegacyDisable(
    sessionId: string,
    identity: TerminalAuthorityResponderIdentity,
  ): Promise<{
    accepted: boolean;
    duplicate?: boolean;
    completed?: boolean;
    completionReceiptSent?: boolean;
    reason?: string;
  }>;
  beginTerminalAuthorityRollback(
    sessionId: string,
    request: Parameters<TerminalAuthorityController['beginRollback']>[0],
  ): Promise<{ ok: boolean; reason?: string }>;
  registerRetainedTerminalClientView(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ): { ok: boolean; reason: string };
  acceptTerminalAuthorityLegacyBrowserQueryReply(
    sessionId: string,
    input: TerminalAuthorityResponderIdentity & { replyOrdinal: number; reply: string },
  ): { accepted: boolean; duplicate?: boolean; completed?: boolean; reason?: string };
  writeTerminalQueryReply(sessionId: string, data: string): boolean;
  stopTerminalAuthorityNewAdmission(
    sessionId: string,
    input: { transitionEpoch: string },
  ): { ok: boolean; reason?: string };
  bindTerminalAuthorityServerDriverLease(
    sessionId: string,
    input: { driverLeaseId: string },
  ): { ok: boolean; reason?: string };
  setTerminalAuthorityServerResponderEnabled(
    sessionId: string,
    input: { enabled: boolean; responderLeaseId: string },
  ): { ok: boolean; reason?: string };
  rotateTerminalAuthorityServerEpoch(
    sessionId: string,
    input: { streamEpoch: string; responderLeaseId: string; driverLeaseId: string },
  ): { ok: boolean; reason?: string };
  recordTerminalAuthorityServerCheckpointDelivery(
    sessionId: string,
    input: {
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
    },
  ): { ok: boolean; reason?: string };
  invalidateTerminalAuthorityServerCheckpointDelivery(
    sessionId: string,
    input: { clientId: string; viewGeneration: number },
  ): { ok: boolean; reason?: string };
  revokeTerminalAuthorityResponderLease(
    sessionId: string,
    input: { responderLeaseId: string },
  ): { ok: boolean; reason?: string };
  revokeTerminalAuthorityDriverLease(
    sessionId: string,
    input: { driverLeaseId: string },
  ): { ok: boolean; reason?: string };
  rebindTerminalAuthorityCompatibilityDriverLease(
    sessionId: string,
    input: { driverLeaseId: string; clientId?: string; viewGeneration?: number; leaseGeneration?: string },
  ): { ok: boolean; reason?: string };
  rebindTerminalAuthorityCompatibilityResponderLease(
    sessionId: string,
    input: { responderLeaseId: string },
  ): { ok: boolean; reason?: string };
  prepareTerminalAuthorityPromotionCandidate(
    sessionId: string,
    input: {
      transitionEpoch: string;
      limitedSessionSelected: boolean;
    },
  ): { ok: boolean; reason?: string };
  readTerminalAuthorityPromotionParitySnapshot(sessionId: string): {
    retainedStateParity: boolean;
    factParity: boolean;
    leaseParity: boolean;
    noLocalCacheParity: boolean;
    limitedSessionSelected: boolean;
    blockers: readonly string[];
    diagnosticBlockers: readonly string[];
  };
  cleanupTerminalAuthorityRuntimePorts(
    sessionId: string,
    input: { scope: 'rollback-complete' | 'reconnect' },
  ): { ok: boolean; reason?: string };
  getTerminalAuthoritySuspendedBrowserMutationLease(sessionId: string): {
    clientId: string;
    authorityEpoch: string;
    viewGeneration: number;
    leaseGeneration: string;
  } | null;
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
    | { ok: false; reason: string };
  rotateTerminalAuthoritySuspendedBrowserMutationLease(
    sessionId: string,
    input: { clientId: string; viewGeneration: number },
  ): {
    clientId: string;
    authorityEpoch: string;
    viewGeneration: number;
    leaseGeneration: string;
  } | null;
  pushTerminalAuthorityViewAttributes(
    sessionId: string,
    input: Parameters<ReturnType<typeof installTerminalQueryResponder>['pushViewAttributes']>[0],
  ): { accepted: boolean; reason?: string };
  getTerminalAuthorityQueryCapabilityState(sessionId: string): {
    promotionEligible: boolean;
    blocker?: string;
    hasAcceptedViewAttributes: boolean;
  } | null;
  hasTerminalAuthorityDebugIsolation(sessionId: string): boolean;
  writeTerminalAuthorityServerQueryReply(
    sessionId: string,
    input: { responderLeaseId: string; reply: string },
  ): boolean;
  writeTerminalAuthorityCompatibilityQueryReply(
    sessionId: string,
    input: { responderLeaseId: string; clientId: string; viewGeneration: number; reply: string },
  ): boolean;
  getRetainedTerminalAuthorityState(sessionId: string): {
    streamEpoch: string;
    sourceSeq: string;
    snapshotSeq: string;
    oldestRetainedSeq: string;
    oldestRetainedStreamEpoch: string;
    retentionPolicy: {
      retentionPolicyId: string;
      source: string;
      effectiveRetainedScrollbackLines: number;
    };
    checkpoint: {
      serializedData: string;
      pendingEscapeTailAnsi?: string;
      cols: number;
      rows: number;
      modes: Readonly<Record<string, boolean | number | string>>;
      activeBuffer: 'normal' | 'alternate';
      cursor: { x: number; y: number };
      savedCursor: { x: number; y: number } | null;
      normal: { logicalLines: readonly string[]; cellHash: string; attributeHash: string };
      alternate: { logicalLines: readonly string[]; cellHash: string; attributeHash: string };
    };
    canary?: { eligible: boolean; blockers: readonly string[] };
    driverLease?: { generation: string };
  } | undefined;
  getAllSessions(): Array<{ id: string }>;
  deleteSession(id: string): unknown;
  getTerminalAuthorityDebugModelInstanceId?(sessionId: string): string | null;
  takeTerminalAuthorityDebugRollbackPostBoundaryOutput?(sessionId: string): string | null;
  injectTerminalAuthorityDebugRollbackPostBoundaryOutput?(
    sessionId: string,
    output: string,
  ): Promise<boolean> | boolean;
}

interface WsRouterAuthorityApi {
  installTerminalAuthorityHooks(input: {
    queryReplyIngress: ReturnType<typeof createTerminalQueryReplyIngress>;
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
    onViewAuthorityReady?: (input: {
      sessionId: string;
      connectionId: string;
      viewGeneration: number;
      authorityStreamEpoch: string;
      driverLeaseGeneration: string;
      acceptedViewAttributesGeneration: string;
      queryReplyCapability: 'terminal.query-reply-input.v1';
      parserResponderCapability: 'terminal.parser-responder-disable.v1';
      reason: 'new-view' | 'generation-changed' | 'authority-generation-changed';
    }) => void;
    readViewAuthorityMode?: (
      input: {
        sessionId: string;
        connectionId: string;
        viewGeneration: number;
        authorityStreamEpoch: string;
        driverLeaseGeneration: string;
        acceptedViewAttributesGeneration: string;
        queryReplyCapability: 'terminal.query-reply-input.v1';
        parserResponderCapability: 'terminal.parser-responder-disable.v1';
      },
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
  }): () => void;
  refreshReplaySnapshots(sessionId: string, options?: {
    startWhenReady?: boolean;
    origin?: 'refresh' | 'degraded';
  }): void;
  getTerminalAuthorityResponderViews(sessionId: string): ReadonlyArray<{
    sessionId: string;
    clientId: string;
    connectionId: string;
    viewGeneration: number;
    queryReplyCapability: 'terminal.query-reply-input.v1';
    parserResponderCapability: 'terminal.parser-responder-disable.v1';
    authorityStreamEpoch: string;
    driverLeaseGeneration: string;
    acceptedViewAttributesGeneration: string;
  }>;
  getTerminalAuthorityNegotiatedView?(
    sessionId: string,
    connectionId: string,
    viewGeneration: number,
  ): ReturnType<WsRouterAuthorityApi['getTerminalAuthorityResponderViews']>[number] | null;
  getTerminalAuthorityNegotiatedViews?(
    sessionId: string,
  ): ReturnType<WsRouterAuthorityApi['getTerminalAuthorityResponderViews']>;
  getTerminalAuthorityDeliveryVisibility?(
    sessionId: string,
    connectionId: string,
    viewGeneration: number,
  ): { visibilityGeneration: string } | null;
  getTerminalAuthorityCanaryContext(connectionId: string): {
    connectionId: string;
    channelRole: 'control';
    subscribedSessions: ReadonlyArray<{
      sessionId: string;
      attachedViews: ReadonlyArray<{
        connectionId: string;
        viewGeneration: number | null;
        capable: boolean;
      }>;
      capableViews: ReadonlyArray<{
        connectionId: string;
        viewGeneration: number;
      }>;
      allAttachedViewsCapable: boolean;
      replayRepairIdle: boolean;
    }>;
  } | null;
  supersedeTerminalAuthorityBootstrapReplay(sessionId: string): {
    ok: boolean;
    reason?: string;
    supersededViewCount: number;
  };
  refreshTerminalAuthorityServerRecovery(sessionId: string): {
    ok: boolean;
    reason?: string;
    refreshedViewCount: number;
  };
  sendTerminalAuthorityFrameToConnection(
    connectionId: string,
    message: object,
    lane?: 'control' | 'terminal',
    onSettled?: (error?: Error) => void,
    expectedTransportBindingId?: string,
  ): {
    sent: boolean;
    socketRole: 'unified' | 'control' | 'output';
    transportBindingId?: string;
  };
}

function viewKey(view: { connectionId: string; viewGeneration: number }): string {
  return `${view.connectionId}\u0000${view.viewGeneration}`;
}

export function terminalAuthorityFramePumpKey(
  view: { connectionId: string; viewGeneration: number },
  lane: 'control' | 'terminal',
): string {
  return `${viewKey(view)}\u0000${lane}`;
}

export function shouldDeferTerminalAuthorityFrameDrain(
  lanes: readonly ('control' | 'terminal')[],
  index: number,
): boolean {
  const lane = lanes[index];
  return lane !== undefined && lanes.slice(index + 1).includes(lane);
}

function responderTopologyMatches(
  left: TerminalAuthorityResponderViewIdentity[],
  right: TerminalAuthorityResponderViewIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByKey = new Map(right.map(view => [viewKey(view), view]));
  return left.every(view => {
    const candidate = rightByKey.get(viewKey(view));
    return candidate !== undefined
      && candidate.clientId === view.clientId
      && candidate.responderLeaseId === view.responderLeaseId
      && candidate.queryReplyCapability === view.queryReplyCapability
      && candidate.parserResponderCapability === view.parserResponderCapability
      && candidate.driverLeaseGeneration === view.driverLeaseGeneration
      && candidate.acceptedViewAttributesGeneration === view.acceptedViewAttributesGeneration;
  });
}

function responderViewMembershipMatches(
  left: TerminalAuthorityResponderViewIdentity[],
  right: TerminalAuthorityResponderViewIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByKey = new Map(right.map(view => [viewKey(view), view]));
  return left.every(view => rightByKey.get(viewKey(view))?.clientId === view.clientId);
}

function rollbackResponderTopologyMatches(
  frozen: TerminalAuthorityResponderViewIdentity[],
  current: TerminalAuthorityResponderViewIdentity[],
  activeStreamEpoch: string,
): boolean {
  if (!isCanonicalOrdinal64(activeStreamEpoch)) return false;
  return responderTopologyMatches(
    frozen.map(view => ({
      ...view,
      driverLeaseGeneration: activeStreamEpoch,
      acceptedViewAttributesGeneration: activeStreamEpoch,
    })),
    current,
  );
}

function checkpointAckKey(
  connectionId: string,
  message: Record<string, unknown>,
): string {
  return [
    connectionId,
    message.protocolVersion,
    message.sessionId,
    message.viewGeneration,
    message.streamEpoch,
    message.checkpointEpoch,
    message.sourceSeq,
    message.snapshotSeq,
    message.oldestRetainedSeq,
    message.retentionPolicyId,
    message.connectionId ?? connectionId,
    message.transitionEpoch,
    message.authorityEpoch,
    message.responderLeaseId,
    message.boundarySourceSeq,
  ].join('\u0000');
}

function checkpointWireIdentityMatches(
  checkpoint: TerminalAuthorityCheckpointIdentity | null,
  message: Record<string, unknown>,
  connectionId: string,
): boolean {
  return checkpoint !== null
    && message.protocolVersion === checkpoint.protocolVersion
    && message.sessionId === checkpoint.sessionId
    && message.streamEpoch === checkpoint.streamEpoch
    && message.checkpointEpoch === checkpoint.checkpointEpoch
    && message.sourceSeq === checkpoint.sourceSeq
    && message.snapshotSeq === checkpoint.snapshotSeq
    && message.oldestRetainedSeq === checkpoint.oldestRetainedSeq
    && message.retentionPolicyId === checkpoint.retentionPolicyId
    && message.connectionId === connectionId
    && message.transitionEpoch === checkpoint.transitionEpoch
    && message.authorityEpoch === checkpoint.authorityEpoch
    && message.responderLeaseId === checkpoint.responderLeaseId
    && message.boundarySourceSeq === checkpoint.boundarySourceSeq;
}

function checkpointOrdinal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= 0xffff_ffff_ffff_ffffn ? parsed : null;
  } catch {
    return null;
  }
}

// A checkpoint replacement can be installed while the browser's previous
// physical xterm callback is still crossing the control socket. That ACK is
// an expected superseded receipt, not evidence that the new transaction is
// corrupt. Only a strictly older epoch pair is classified this way; malformed
// current or future identities remain observable failures.
// @req MIG-BGSTAB-002 AC-5 AC-6
export function isSupersededTerminalCheckpointAck(
  expected: Readonly<Record<string, unknown>> | null,
  received: Readonly<Record<string, unknown>>,
): boolean {
  if (!expected) return false;
  const expectedStreamEpoch = checkpointOrdinal(expected.streamEpoch);
  const expectedCheckpointEpoch = checkpointOrdinal(expected.checkpointEpoch);
  const receivedStreamEpoch = checkpointOrdinal(received.streamEpoch);
  const receivedCheckpointEpoch = checkpointOrdinal(received.checkpointEpoch);
  if (
    expectedStreamEpoch === null
    || expectedCheckpointEpoch === null
    || receivedStreamEpoch === null
    || receivedCheckpointEpoch === null
  ) {
    return false;
  }
  return receivedStreamEpoch < expectedStreamEpoch
    || (
      receivedStreamEpoch === expectedStreamEpoch
      && receivedCheckpointEpoch < expectedCheckpointEpoch
    );
}

function compatibilityDrainKey(input: {
  connectionId: string;
  sessionId: string;
  viewGeneration: number;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  responderLeaseId: string;
  boundarySourceSeq: string;
  checkpointEpoch: string;
  drainedThroughSourceSeq: string;
}): string {
  return [
    input.connectionId,
    input.sessionId,
    input.viewGeneration,
    input.transitionEpoch,
    input.authorityEpoch,
    input.streamEpoch,
    input.responderLeaseId,
    input.boundarySourceSeq,
    input.checkpointEpoch,
    input.drainedThroughSourceSeq,
  ].join('\u0000');
}

function requireAuthorityPort(
  operation: string,
  result: { ok: boolean; reason?: string },
): void {
  if (!result.ok) {
    throw new Error(`${operation}:${result.reason ?? 'rejected'}`);
  }
}

// @req MIG-BGSTAB-002 AC-4 AC-5
function encodeCheckpointPayload(data: string): {
  encoding: 'base64';
  data: string;
  encodedBytes: number;
} {
  const bytes = Buffer.from(data, 'utf8');
  return {
    encoding: 'base64',
    data: bytes.toString('base64'),
    encodedBytes: bytes.byteLength,
  };
}

function encodeCheckpointChunks(data: string): ReadonlyArray<{
  encoding: 'base64';
  data: string;
  encodedBytes: number;
}> {
  const bytes = Buffer.from(data, 'utf8');
  if (bytes.byteLength === 0) {
    return [{ encoding: 'base64', data: '', encodedBytes: 0 }];
  }
  const chunks: Array<{ encoding: 'base64'; data: string; encodedBytes: number }> = [];
  for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_CHECKPOINT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + TERMINAL_CHECKPOINT_CHUNK_BYTES));
    chunks.push({
      encoding: 'base64',
      data: chunk.toString('base64'),
      encodedBytes: chunk.byteLength,
    });
  }
  return chunks;
}

// @req REL-BGSTAB-007 AC-3
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function isParserGeneratedReply(data: string): boolean {
  return /^(?:\x1b\[(?:\?|>)?[0-9;]*[cnR]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1bP[^]*\x1b\\)$/u.test(data);
}

function nextOrdinal(value: string): string {
  return (BigInt(value) + 1n).toString();
}

function checkpointEpochFor(streamEpoch: string): string {
  return `${streamEpoch}001`;
}

/**
 * Executable production-default seam used by the limited-session promotion
 * pilot. It composes the real SessionManager and WsRouter; no simulator owns
 * terminal bytes or subscriber topology.
 *
 * @req MIG-BGSTAB-002 AC-1 AC-2 AC-3 AC-4 AC-5 AC-6
 */
export function createProductionTerminalAuthorityIntegration(
  options: ProductionAdapterOptions,
): ProductionTerminalAuthorityIntegration {
  const initialOrdinal = options.sessionManager.retainedTerminalInitialOrdinal
    ?? { streamEpoch: '7', sourceSeq: '0' };
  const sessionManager = new SessionManager(undefined, {
    ...options.sessionManager,
    retainedTerminalInitialOrdinal: initialOrdinal,
  });
  const wsRouter = new WsRouter(
    options.authService as never,
    sessionManager,
    { realtime: { wsTransportMode: options.transportMode } },
  );
  sessionManager.setWsRouter(wsRouter);
  return attachProductionTerminalAuthorityInternal({
    sessionManager,
    wsRouter,
    transportMode: options.transportMode,
    now: options.now,
    promotionSafetyLimits: options.promotionSafetyLimits,
  viewAttributesHandshakeTimeoutMs: options.viewAttributesHandshakeTimeoutMs,
    checkpointReadyHandshakeTimeoutMs: options.checkpointReadyHandshakeTimeoutMs,
  }, true);
}

/**
 * Attaches terminal-authority ownership to the already-running production
 * SessionManager/WsRouter pair. The returned destroy hook only removes this
 * attachment; it never destroys caller-owned sessions or sockets.
 *
 * @req MIG-BGSTAB-002 AC-3 AC-5 AC-6
 */
export function attachProductionTerminalAuthority(
  options: AttachProductionTerminalAuthorityOptions,
): ProductionTerminalAuthorityIntegration {
  return attachProductionTerminalAuthorityInternal(options, false);
}

function attachProductionTerminalAuthorityInternal(
  options: AttachProductionTerminalAuthorityOptions,
  ownsInstances: boolean,
): ProductionTerminalAuthorityIntegration {
  const { sessionManager, wsRouter } = options;
  // The production singleton is constructed before the authority adapter and
  // may already own restored sessions whose retained state was initialized as
  // disabled. Promotion remains limited-session/canary gated; this only turns
  // on shadow collection and registration for those existing sessions.
  sessionManager.setRetainedTerminalShadowEnabled(true);
  sessionManager.setWsRouter(wsRouter);
  const manager = sessionManager as unknown as SessionManagerAuthorityApi;
  const router = wsRouter as unknown as WsRouterAuthorityApi;
  const runtimes = new Map<string, RuntimeRecord>();
  const scheduledAuthorityRecoveries = new Map<string, {
    token: symbol;
    pendingReason: string | null;
  }>();
  let recoverAuthoritySendFailure = (sessionId: string, reason: string): void => {
    const runtime = runtimes.get(sessionId);
    if (runtime) appendTerminalAuthorityAudit(runtime.audit, {
      type: 'authority-send-recovery-not-ready',
      kind: reason,
      sessionId,
    });
  };
  const now = options.now ?? Date.now;
  const checkpointReadyHandshakeTimeoutMs = options.checkpointReadyHandshakeTimeoutMs ?? 5_000;
  const checkpointReadyHandshakeMaxRetries = 3;
  const viewAttributesHandshakeTimeoutMs = options.viewAttributesHandshakeTimeoutMs ?? 5_000;
  const maxViewAttributesIdentityReplacements = 8;
  const initialOrdinal = { streamEpoch: '7', sourceSeq: '0' } as const;

  const readQueryResponderCapabilityState = (sessionId: string): {
    promotionEligible: boolean;
    blocker?: string;
    hasAcceptedViewAttributes: boolean;
  } | null => {
    const capability = manager.getTerminalAuthorityQueryCapabilityState(sessionId);
    if (!capability) return null;
    const runtime = runtimes.get(sessionId);
    const accepted = runtime?.acceptedViewAttributesIdentity;
    const currentView = accepted
      ? router.getTerminalAuthorityResponderViews(sessionId).find(view => (
          view.connectionId === accepted.connectionId
          && view.clientId === accepted.clientId
          && view.viewGeneration === accepted.viewGeneration
        ))
      : undefined;
    const challengeAccepted = runtime !== undefined
      && accepted !== null
      && accepted !== undefined
      && accepted.runtimeToken === runtime.runtimeToken
      && accepted.challengeId === runtime.pendingViewAttributesChallengeId
      && accepted.challengeId === runtime.acceptedViewAttributesChallengeId
      && accepted.streamEpoch === runtime.controller.getState().streamEpoch
      && accepted.driverLeaseId === runtime.legacyDriverLeaseId
      && currentView?.driverLeaseGeneration === accepted.driverLeaseGeneration
      && currentView.acceptedViewAttributesGeneration === accepted.viewAttributesGeneration;
    if (capability.hasAcceptedViewAttributes && challengeAccepted) return capability;
    return {
      ...capability,
      promotionEligible: false,
      blocker: capability.blocker ?? 'view-attributes-challenge-unaccepted',
      hasAcceptedViewAttributes: false,
    };
  };

  const settlePendingViewAttributesHandshake = (
    runtime: RuntimeRecord,
    pending: PendingViewAttributesHandshake,
    result: boolean,
  ): void => {
    if (pending.settled || runtime.pendingViewAttributesHandshake !== pending) return;
    pending.settled = true;
    clearTimeout(pending.deadlineTimer);
    runtime.pendingViewAttributesHandshake = null;
    if (!result) {
      runtime.legacyRefreshEpoch += 1;
      runtime.pendingViewAttributesChallengeId = randomUUID();
      runtime.acceptedViewAttributesChallengeId = null;
      runtime.acceptedViewAttributesIdentity = null;
    }
    pending.resolve(result);
  };

  const viewAttributesHandshakeIdentityKey = (
    pending: PendingViewAttributesHandshake,
  ): string => JSON.stringify([
    pending.connectionId,
    pending.clientId,
    pending.viewGeneration,
    pending.streamEpoch,
    pending.driverLeaseId,
    pending.driverLeaseGeneration,
    pending.viewAttributesGeneration,
  ]);

  const cancelPendingCheckpointDeliveryPreparations = (runtime: RuntimeRecord): void => {
    for (const pending of runtime.pendingCheckpointDeliveryPrepares.values()) {
      if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    }
    runtime.pendingCheckpointDeliveryPrepares.clear();
    runtime.pendingViewRecoveryKeys.clear();
    runtime.checkpointDeliveryReadyRetryAttempts.clear();
  };

  const disposeRuntime = (sessionId: string): void => {
    const runtime = runtimes.get(sessionId);
    if (!runtime || runtime.disposed) return;
    runtime.disposed = true;
    const disposalErrors: unknown[] = [];
    scheduledAuthorityRecoveries.delete(sessionId);
    if (runtime.authorityRecoveryRetryTimer) {
      clearTimeout(runtime.authorityRecoveryRetryTimer);
      runtime.authorityRecoveryRetryTimer = null;
    }
    runtime.authorityRecoveryRetryAttempt = 0;
    if (runtime.promotionDeadlineTimer) {
      clearTimeout(runtime.promotionDeadlineTimer);
      runtime.promotionDeadlineTimer = null;
    }
    if (runtime.topologyRecoveryTimer) {
      clearTimeout(runtime.topologyRecoveryTimer);
      runtime.topologyRecoveryTimer = null;
    }
    const pendingHandshake = runtime.pendingViewAttributesHandshake;
    if (pendingHandshake) settlePendingViewAttributesHandshake(runtime, pendingHandshake, false);
    try {
      manager.detachTerminalAuthorityRuntime(sessionId, runtime.controller);
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      runtime.controller.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    for (const pump of runtime.checkpointPumpsByView.values()) {
      pump.failed = true;
      pump.sending = false;
      try {
        pump.inFlight?.resolve(false);
      } catch (error) {
        disposalErrors.push(error);
      }
      pump.inFlight = undefined;
      for (const queued of pump.frames.splice(0)) {
        try {
          queued.resolve(false);
        } catch (error) {
          disposalErrors.push(error);
        }
      }
    }
    runtime.checkpointPumpsByView.clear();
    runtime.activeCheckpointsByView.clear();
    runtime.reservedCheckpointsByView.clear();
    cancelPendingCheckpointDeliveryPreparations(runtime);
    runtime.scheduledViewRecoveryKeys.clear();
    runtime.checkpointTailSourceSeqByView.clear();
    runtime.legacyRebindInFlightKeys.clear();
    runtime.applyAcks.clear();
    runtime.drainAcks.clear();
    runtime.physicalDrains.clear();
    runtime.disabledViewKeys.clear();
    runtime.frozenViews.length = 0;
    runtimes.delete(sessionId);
    if (disposalErrors.length > 0) {
      throw new AggregateError(
        disposalErrors,
        `terminal-authority-production-runtime-disposal-failed:${sessionId}`,
      );
    }
  };
  const uninstallSessionFinalizedListener = manager.addSessionFinalizedListener(
    event => disposeRuntime(event.sessionId),
  );

  const readViews = (sessionId: string, responderLeaseId: string): TerminalAuthorityResponderViewIdentity[] => (
    router.getTerminalAuthorityResponderViews(sessionId).map(view => ({
      clientId: view.clientId,
      connectionId: view.connectionId,
      viewGeneration: view.viewGeneration,
      responderLeaseId,
      queryReplyCapability: view.queryReplyCapability,
      parserResponderCapability: view.parserResponderCapability,
      driverLeaseGeneration: view.driverLeaseGeneration,
      acceptedViewAttributesGeneration: view.acceptedViewAttributesGeneration,
    }))
  );

  const recoverCurrentViewTransportFailure = (
    sessionId: string,
    runtime: RuntimeRecord,
    view: Pick<TerminalAuthorityResponderViewIdentity, 'connectionId' | 'viewGeneration'>,
    reason: string,
  ): boolean => {
    const viewStillCurrent = runtimes.get(sessionId) === runtime
      && router.getTerminalAuthorityResponderViews(sessionId).some(candidate => (
      candidate.connectionId === view.connectionId
      && candidate.viewGeneration === view.viewGeneration
    ));
    if (viewStillCurrent) {
      recoverAuthoritySendFailure(sessionId, reason);
      return false;
    }
    appendTerminalAuthorityAudit(runtime.audit, {
      type: 'stale-view-transport-failure-ignored',
      kind: reason,
      sessionId,
      connectionId: view.connectionId,
      viewGeneration: view.viewGeneration,
    });
    return true;
  };

  const enqueueSettledViewFrame = (
    sessionId: string,
    runtime: RuntimeRecord,
    view: TerminalAuthorityResponderViewIdentity,
    message: object,
    lane: 'control' | 'terminal' = 'terminal',
    deferDrain = false,
    onSettled?: () => void,
  ): Promise<boolean> => {
    const key = terminalAuthorityFramePumpKey(view, lane);
    let pump = runtime.checkpointPumpsByView.get(key);
    if (!pump || pump.failed) {
      pump = {
        frames: [],
        sending: false,
        failed: false,
      };
      runtime.checkpointPumpsByView.set(key, pump);
    }

    const drain = (): void => {
      if (pump.failed || pump.sending) return;
      const next = pump.frames.shift();
      if (!next) {
        if (runtime.checkpointPumpsByView.get(key) === pump) {
          runtime.checkpointPumpsByView.delete(key);
        }
        return;
      }
      pump.sending = true;
      pump.inFlight = next;
      let settled = false;
      const settleTransportFailure = (reason: string): void => {
        queueMicrotask(() => {
          pump.sending = false;
          pump.inFlight = undefined;
          pump.failed = true;
          if (runtime.checkpointPumpsByView.get(key) === pump) {
            runtime.checkpointPumpsByView.delete(key);
          }
          if (reason === 'checkpoint-transport-binding-replaced') {
            appendTerminalAuthorityAudit(runtime.audit, {
              type: 'stale-view-checkpoint-pump-dropped',
              kind: reason,
              sessionId,
              connectionId: view.connectionId,
              viewGeneration: view.viewGeneration,
            });
            const staleViewFailure = recoverCurrentViewTransportFailure(
              sessionId,
              runtime,
              view,
              reason,
            );
            next.resolve(staleViewFailure);
            for (const queued of pump.frames.splice(0)) queued.resolve(staleViewFailure);
            return;
          }
          const staleViewFailure = recoverCurrentViewTransportFailure(
            sessionId,
            runtime,
            view,
            reason,
          );
          next.resolve(staleViewFailure);
          for (const queued of pump.frames.splice(0)) queued.resolve(staleViewFailure);
        });
      };
      const delivery = router.sendTerminalAuthorityFrameToConnection(
        view.connectionId,
        next.message,
        next.lane,
        error => {
          if (settled) return;
          settled = true;
          if (runtime.checkpointPumpsByView.get(key) !== pump || pump.failed) return;
          if (error) {
            settleTransportFailure(
              error.message === 'terminal-authority-transport-binding-replaced'
                ? 'checkpoint-transport-binding-replaced'
                : 'checkpoint-transport-settlement-failed',
            );
            return;
          }
          pump.sending = false;
          pump.inFlight = undefined;
          next.onSettled?.();
          next.resolve(true);
          queueMicrotask(drain);
        },
        pump.transportBindingId,
      );
      if (delivery.sent && !pump.transportBindingId && delivery.transportBindingId) {
        pump.transportBindingId = delivery.transportBindingId;
      }
      if (!delivery.sent && !settled) {
        settled = true;
        settleTransportFailure('checkpoint-transport-admission-failed');
      }
    };

    return new Promise<boolean>(resolve => {
      pump.frames.push({ message, lane, resolve, ...(onSettled ? { onSettled } : {}) });
      if (!deferDrain) drain();
    });
  };

  const enqueueSettledViewFrameBatch = (
    sessionId: string,
    runtime: RuntimeRecord,
    view: TerminalAuthorityResponderViewIdentity,
    frames: ReadonlyArray<{
      message: object;
      lane?: 'control' | 'terminal';
      onSettled?: () => void;
    }>,
  ): Promise<boolean> => {
    if (frames.length === 0) return Promise.resolve(true);
    const lanes = frames.map(frame => frame.lane ?? 'terminal');
    const settlements = frames.map((frame, index) => enqueueSettledViewFrame(
      sessionId,
      runtime,
      view,
      frame.message,
      lanes[index]!,
      shouldDeferTerminalAuthorityFrameDrain(lanes, index),
      frame.onSettled,
    ));
    return Promise.all(settlements).then(results => results.every(Boolean));
  };

  const buildCheckpointCapability = (
    sessionId: string,
    view: TerminalAuthorityResponderViewIdentity,
    authorityMode: 'checkpoint' | 'legacy',
    record: Record<string, unknown>,
    compatibilityRecoveryRole?: 'selected-responder' | 'passive-snapshot',
  ): object => {
    const mutationLease = manager.getTerminalAuthoritySuspendedBrowserMutationLease(sessionId);
    const passiveSnapshotPeer = compatibilityRecoveryRole === 'passive-snapshot';
    return {
      type: 'terminal-checkpoint:capability',
      protocolVersion: 1,
      accepted: true,
      authorityMode,
      checkpointDeliveryActive: authorityMode === 'checkpoint',
      ...(compatibilityRecoveryRole ? { compatibilityRecoveryRole } : {}),
      ordinalEncoding: 'canonical-uint64-decimal',
      digestAlgorithms: ['sha256'],
      registeredViews: [{
        sessionId,
        viewGeneration: view.viewGeneration,
        queryReplyCapability: view.queryReplyCapability,
        parserResponderCapability: view.parserResponderCapability,
        authorityStreamEpoch: record.streamEpoch,
        ...(passiveSnapshotPeer ? {} : {
          driverLeaseGeneration: authorityMode === 'checkpoint'
            ? record.streamEpoch
            : record.driverLeaseGeneration,
          acceptedViewAttributesGeneration: authorityMode === 'checkpoint'
            ? record.streamEpoch
            : record.acceptedViewAttributesGeneration,
          viewAttributesChallengeId: runtimes.get(sessionId)?.pendingViewAttributesChallengeId,
        }),
      }],
      ...(mutationLease
        && mutationLease.clientId === view.clientId
        && mutationLease.viewGeneration === view.viewGeneration
        ? {
            mutationLeases: [{
              sessionId,
              authorityEpoch: mutationLease.authorityEpoch,
              viewGeneration: mutationLease.viewGeneration,
              leaseGeneration: mutationLease.leaseGeneration,
            }],
          }
        : {}),
    };
  };

  const sendTerminalFrame = async (sessionId: string, message: object): Promise<boolean> => {
    const record = message as Record<string, unknown>;
    const runtime = runtimes.get(sessionId);
    if (!runtime) return false;
    if (record.type === 'terminal-authority:responder-disable-boundary') {
      const required = Array.isArray(record.requiredResponderViews)
        ? record.requiredResponderViews as TerminalAuthorityResponderViewIdentity[]
        : [];
      runtime.frozenViews = required.map(view => ({ ...view }));
      runtime.disabledViewKeys.clear();
      runtime.activeCheckpointsByView.clear();
      runtime.reservedCheckpointsByView.clear();
      runtime.pendingViewRecoveryKeys.clear();
      runtime.checkpointTailSourceSeqByView.clear();
      runtime.expectedLegacyIdentity = null;
      runtime.precommitLegacyDriverIdentity = null;
    }
    if (record.type === 'terminal-authority:rollback-start') {
      runtime.activeCheckpointsByView.clear();
      runtime.reservedCheckpointsByView.clear();
      cancelPendingCheckpointDeliveryPreparations(runtime);
      runtime.checkpointTailSourceSeqByView.clear();
      runtime.precommitLegacyDriverIdentity = null;
    }
    const authorityState = runtime.controller.getState();
    const selectedConnection = typeof record.connectionId === 'string'
      ? record.connectionId
      : null;
    const views = authorityState.mode === 'server'
      ? readViews(
          sessionId,
          authorityState.activeResponderLeaseId ?? runtime.legacyResponderLeaseId,
        )
      : runtime.frozenViews.length > 0
        ? runtime.frozenViews
        : readViews(sessionId, runtime.legacyResponderLeaseId);
    const selectedViews = selectedConnection
      ? views.filter(view => view.connectionId === selectedConnection)
      : views;
    if (selectedViews.length === 0) {
      // Legacy output still flows through SessionManager's unnegotiated
      // WsRouter path. A restored/background session can legitimately have no
      // authority-capable browser view. Server authority also remains complete
      // in the headless model across the zero-view interval; the next view
      // receives a fresh checkpoint from that model. Treating either absence
      // as a send failure would create a rollback that no view can acknowledge.
      if (record.type === 'output'
        && (authorityState.mode === 'legacy' || authorityState.mode === 'server')) {
        if (authorityState.mode === 'server') {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'server-output-retained-without-attached-view',
            sessionId,
            sourceSeq: typeof record.sourceSeq === 'string' ? record.sourceSeq : undefined,
            ...(manager.hasTerminalAuthorityDebugIsolation(sessionId)
              && typeof record.data === 'string' ? {
              outputDataSha256: createHash('sha256').update(record.data, 'utf8').digest('hex'),
              outputByteLength: Buffer.byteLength(record.data, 'utf8'),
            } : {}),
          });
        }
        return true;
      }
      return false;
    }
    if (record.type === 'terminal-authority:legacy-responder-enabled') {
      const selected = selectedViews[0];
      if (!selected
        || typeof record.driverLeaseId !== 'string'
        || typeof record.driverLeaseGeneration !== 'string'
        || typeof record.acceptedViewAttributesGeneration !== 'string') {
        return false;
      }
      runtime.precommitLegacyDriverIdentity = {
        connectionId: selected.connectionId,
        clientId: selected.clientId ?? null,
        viewGeneration: selected.viewGeneration,
        driverLeaseId: record.driverLeaseId,
        driverLeaseGeneration: record.driverLeaseGeneration,
        viewAttributesGeneration: record.acceptedViewAttributesGeneration,
      };
      // Snapshot replay is sent on the control socket. Keep the capability on
      // that same FIFO so a split output socket cannot make the snapshot race
      // ahead of the legacy authority handoff.
      const capabilitySettlements = await Promise.all(views.map(view => enqueueSettledViewFrame(
        sessionId,
        runtime,
        view,
        buildCheckpointCapability(
          sessionId,
          view,
          'legacy',
          record,
          view.connectionId === selectedConnection
            ? 'selected-responder'
            : 'passive-snapshot',
        ),
        'control',
      )));
      if (!capabilitySettlements.every(Boolean)) return false;
    }
    const deliveries = selectedViews.map(async view => {
      let outbound: object = {
        ...record,
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
      };
      if (record.type === 'terminal-authority:responder-disable-boundary') {
        outbound = {
          ...outbound,
          lane: 'terminal-output',
          requiredResponderViewCount: views.length,
        };
      }
      const activeCheckpoint = runtime.activeCheckpointsByView.get(viewKey(view))
        ?? runtime.reservedCheckpointsByView.get(viewKey(view));
      const checkpointOutputAuthority = isCheckpointOutputAuthorityMode(
        runtime.controller.getState().mode,
      );
      if (record.type === 'output'
        && !activeCheckpoint
        && checkpointOutputAuthority) {
        if (isServerOutputCoveredByPendingViewRecovery({
          messageType: record.type,
          authorityMode: runtime.controller.getState().mode,
          hasCheckpoint: false,
          pendingViewRecovery: runtime.pendingViewRecoveryKeys.has(viewKey(view)),
        })) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'server-output-covered-by-pending-view-recovery',
            sessionId,
            connectionId: view.connectionId,
            viewGeneration: view.viewGeneration,
            sourceSeq: typeof record.sourceSeq === 'string' ? record.sourceSeq : undefined,
          });
          return true;
        }
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'server-output-checkpoint-unavailable',
          sessionId,
          connectionId: view.connectionId,
          viewGeneration: view.viewGeneration,
          sourceSeq: typeof record.sourceSeq === 'string' ? record.sourceSeq : undefined,
          kind: [
            `active=${runtime.activeCheckpointsByView.size}`,
            `reserved=${runtime.reservedCheckpointsByView.size}`,
            `pending=${runtime.pendingViewRecoveryKeys.size}`,
            `frozen=${runtime.frozenViews.length}`,
          ].join(','),
        });
        return false;
      }
      if (record.type === 'output'
        && activeCheckpoint
        && typeof record.data === 'string'
        && typeof record.sourceSeq === 'string'
        && checkpointOutputAuthority) {
        const key = viewKey(view);
        const previousTailSourceSeq = runtime.checkpointTailSourceSeqByView.get(key)
          ?? activeCheckpoint.sourceSeq;
        const retainedAuthority = manager.getRetainedTerminalAuthorityState(sessionId);
        const retainedSourceSeq = retainedAuthority?.sourceSeq;
        const retainedStreamAdvanced = isCanonicalOrdinal64(activeCheckpoint.streamEpoch)
          && isCanonicalOrdinal64(retainedAuthority?.streamEpoch)
          && BigInt(retainedAuthority.streamEpoch) > BigInt(activeCheckpoint.streamEpoch);
        if (
          sourceSequenceRegressed(previousTailSourceSeq, record.sourceSeq)
          || sourceSequenceRegressed(activeCheckpoint.sourceSeq, retainedSourceSeq)
          || retainedStreamAdvanced
        ) {
          // A source reset is a retained-ledger stream rollover. Do not send
          // MAX -> 0 as ordinary output under the existing checkpoint; fence
          // its proof and rebuild the view from the committed server model.
          runtime.pendingViewRecoveryKeys.add(key);
          if (view.clientId) {
            manager.invalidateTerminalAuthorityServerCheckpointDelivery(sessionId, {
              clientId: view.clientId,
              viewGeneration: view.viewGeneration,
            });
          }
          await enqueueFreshAuthoritativeRecovery({
            sessionId,
            connectionId: view.connectionId,
            viewGeneration: view.viewGeneration,
            replaceActiveCheckpoint: true,
          });
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'server-output-retained-stream-rollover-fenced',
            sessionId,
            connectionId: view.connectionId,
            viewGeneration: view.viewGeneration,
            sourceSeq: record.sourceSeq,
          });
          return true;
        }
        outbound = {
          type: 'terminal-checkpoint:output',
          ...activeCheckpoint,
          connectionId: view.connectionId,
          viewGeneration: view.viewGeneration,
          sourceSeq: record.sourceSeq,
          ...encodeCheckpointPayload(record.data),
        };
        // Reserve the tail ordinal before awaiting the physical send callback.
        // A fast browser can receive the frame and return its cumulative drain
        // ACK before ws.send() invokes that callback.
        runtime.checkpointTailSourceSeqByView.set(viewKey(view), record.sourceSeq);
      }
      if (record.type === 'terminal-authority:rollback-start' && runtime.debugFaultTriggerId) {
        outbound = {
          ...outbound,
          triggerId: runtime.debugFaultTriggerId,
          requiredAction: 'fresh-compatibility-checkpoint',
          ptyPaused: false,
        };
      }
      if (record.type === 'terminal-checkpoint:start') {
        const capabilityAccepted = await enqueueSettledViewFrame(
          sessionId,
          runtime,
          view,
          buildCheckpointCapability(sessionId, view, 'checkpoint', record),
          'terminal',
        );
        if (!capabilityAccepted) return false;
      }
      const deliveryLane = record.type === 'terminal-authority:legacy-responder-enabled'
        ? 'control'
        : 'terminal';
      const sent = await enqueueSettledViewFrame(sessionId, runtime, view, outbound, deliveryLane);
      if (sent && record.type === 'terminal-checkpoint:start') {
        const {
          type: _checkpointType,
          connectionId: _checkpointConnectionId,
          viewGeneration: _checkpointViewGeneration,
          ...checkpointIdentity
        } = record;
        runtime.activeCheckpointsByView.set(
          viewKey(view),
          checkpointIdentity as unknown as TerminalAuthorityCheckpointIdentity,
        );
        runtime.reservedCheckpointsByView.delete(viewKey(view));
        runtime.pendingViewRecoveryKeys.delete(viewKey(view));
        runtime.checkpointTailSourceSeqByView.set(
          viewKey(view),
          String((checkpointIdentity as Record<string, unknown>).sourceSeq),
        );
      }
      return sent;
    });
    const settled = await Promise.all(deliveries);
    const allSent = settled.every(Boolean);
    if (allSent && record.type === 'terminal-checkpoint:start') {
      const {
        type: _checkpointType,
        connectionId: _checkpointConnectionId,
        viewGeneration: _checkpointViewGeneration,
        ...checkpointIdentity
      } = record;
      runtime.activeCheckpoint = checkpointIdentity as unknown as TerminalAuthorityCheckpointIdentity;
    }
    if (allSent && record.type === 'terminal-authority:legacy-responder-enabled') {
      // Send the next snapshot lineage after the legacy capability and
      // responder-enable frame have physically settled on the same socket.
      router.refreshReplaySnapshots(sessionId, {
        startWhenReady: true,
        origin: 'refresh',
      });
    }
    return allSent;
  };

  const createCheckpoint = (
    sessionId: string,
    input: {
      transitionEpoch: string;
      streamEpoch: string;
      checkpointEpoch: string;
      mode: 'authoritative' | 'compatibility';
      authorityMode: 'server' | 'legacy';
      source: 'server-authority-promotion' | 'server-authority-rollback';
    },
  ) => {
    const runtime = runtimes.get(sessionId)!;
    runtime.wiring.retainedCheckpointAdapterCallCount += 1;
    const retained = manager.getRetainedTerminalAuthorityState(sessionId);
    if (!retained) throw new Error('retained-terminal-authority-unavailable');
    const data = retained.checkpoint.serializedData;
    const encodedChunks = encodeCheckpointChunks(data);
    const parserTail = encodeCheckpointPayload(retained.checkpoint.pendingEscapeTailAnsi ?? '');
    runtime.wiring.checkpointDigestAdapterCallCount += 1;
    const digestHex = createHash('sha256').update(data, 'utf8').digest('hex');
    const contentDigest = `sha256:${digestHex}`;
    const totalEncodedBytes = encodedChunks.reduce((total, chunk) => total + chunk.encodedBytes, 0);
    // The controller ordinal is reserved before the headless commit. A failed
    // reservation can therefore leave a legitimate gap relative to the
    // retained operation ledger. Once applyEnqueuedHeadlessOutput resolves,
    // the serialized headless model covers the controller's committed
    // ordinal, so checkpoint identity must use that authority watermark.
    const snapshotSeq = runtime.controller.readLastCommittedSourceSeq();
    const authoritativeModelInstanceId = manager.getTerminalAuthorityDebugModelInstanceId?.(sessionId)
      ?? `headless:${sessionId}:${runtime.controller.getState().authorityEpoch}`;
    const identity: TerminalAuthorityCheckpointIdentity = {
      protocolVersion: 1,
      sessionId,
      transitionEpoch: input.transitionEpoch,
      authorityEpoch: runtime.controller.getState().authorityEpoch,
      streamEpoch: input.streamEpoch,
      checkpointEpoch: input.checkpointEpoch,
      sourceSeq: snapshotSeq,
      snapshotSeq,
      // An Ordinal64 is scoped to a streamEpoch. While retention still starts in
      // a previous epoch the ledger marker cannot be expressed here -- emitting
      // it would advertise a range beginning after it ends -- so the fresh stream
      // reports its own origin. cross-epoch-retention-unavailable keeps the view
      // fail-closed until that resolves.
      oldestRetainedSeq: retained.oldestRetainedStreamEpoch === retained.streamEpoch
        ? retained.oldestRetainedSeq
        : '0',
      retentionPolicyId: retained.retentionPolicy.retentionPolicyId,
      mode: input.mode,
      source: 'server-retained-authority',
      authorityMode: input.authorityMode,
      authoritativeModelInstanceId,
    };
    const activeProjection = retained.checkpoint[retained.checkpoint.activeBuffer];
    const activeStateDigest = fnv1a64(JSON.stringify({
      buffer: retained.checkpoint.activeBuffer,
      logicalLines: activeProjection.logicalLines,
      cellHash: activeProjection.cellHash,
      attributeHash: activeProjection.attributeHash,
      cursor: retained.checkpoint.cursor,
      modes: retained.checkpoint.modes,
    }));
    const modes = Object.fromEntries([
      'applicationCursorKeysMode',
      'applicationKeypadMode',
      'bracketedPasteMode',
      'insertMode',
      'originMode',
      'reverseWraparoundMode',
      'sendFocusMode',
      'wraparoundMode',
    ].flatMap(key => typeof retained.checkpoint.modes[key] === 'boolean'
      ? [[key, retained.checkpoint.modes[key]]]
      : []));
    const metadata = {
      ...identity,
      localCacheUsed: false,
      retentionPolicySource: retained.retentionPolicy.source,
      effectiveRetainedScrollbackLines: retained.retentionPolicy.effectiveRetainedScrollbackLines,
      retainedLineCount: activeProjection.logicalLines.length,
      retainedActiveBuffer: retained.checkpoint.activeBuffer,
      retainedCursor: retained.checkpoint.cursor,
      retainedActiveStateDigest: activeStateDigest,
      retainedSavedCursor: retained.checkpoint.savedCursor
        ? { buffer: 'normal', ...retained.checkpoint.savedCursor }
        : null,
      retainedBuffers: {
        normal: {
          logicalLinesHash: fnv1a64(JSON.stringify(retained.checkpoint.normal.logicalLines)),
          cellContentAttributeHash: fnv1a64(JSON.stringify([
            retained.checkpoint.normal.cellHash,
            retained.checkpoint.normal.attributeHash,
          ])),
          retainedLineCount: retained.checkpoint.normal.logicalLines.length,
        },
        alternate: {
          logicalLinesHash: fnv1a64(JSON.stringify(retained.checkpoint.alternate.logicalLines)),
          cellContentAttributeHash: fnv1a64(JSON.stringify([
            retained.checkpoint.alternate.cellHash,
            retained.checkpoint.alternate.attributeHash,
          ])),
          retainedLineCount: retained.checkpoint.alternate.logicalLines.length,
        },
      },
      chunkCount: encodedChunks.length,
      totalEncodedBytes,
      contentDigest,
      retainedStateDigest: `sha256:${createHash('sha256').update(JSON.stringify({
        version: 1,
        dataDigest: contentDigest,
        parserTail: parserTail.data,
        cols: retained.checkpoint.cols,
        rows: retained.checkpoint.rows,
        modes,
        activeBuffer: retained.checkpoint.activeBuffer,
        cursor: retained.checkpoint.cursor,
        savedCursor: retained.checkpoint.savedCursor,
      }), 'utf8').digest('hex')}`,
    };
    return {
      retainedStateHash: contentDigest,
      checkpointEpoch: input.checkpointEpoch,
      snapshotSeq,
      retainedStreamEpoch: retained.streamEpoch,
      retainedSourceSeq: retained.sourceSeq,
      checkpointMessages: [
        {
          type: 'terminal-checkpoint:start',
          ...metadata,
          sourceGeometry: { cols: retained.checkpoint.cols, rows: retained.checkpoint.rows },
          encodedByteTotal: totalEncodedBytes,
          digest: { algorithm: 'sha256', hex: digestHex },
          modes,
          parserTail,
        },
        ...encodedChunks.map((chunk, chunkIndex) => ({
          type: 'terminal-checkpoint:chunk',
          ...identity,
          chunkIndex,
          chunkCount: encodedChunks.length,
          ...chunk,
        })),
        {
          type: 'terminal-checkpoint:commit',
          ...identity,
          chunkCount: encodedChunks.length,
          encodedByteTotal: totalEncodedBytes,
          digest: { algorithm: 'sha256', hex: digestHex },
          totalEncodedBytes,
          contentDigest,
          retainedStateDigest: metadata.retainedStateDigest,
        },
      ],
      postSnapshotOutput: [] as string[],
    };
  };

  // @req MIG-BGSTAB-002 AC-2 AC-4
  const enqueueFreshAuthoritativeRecovery = async (input: {
    sessionId: string;
    connectionId: string;
    viewGeneration: number;
    checkpointDeliveryId?: string;
    replaceActiveCheckpoint?: boolean;
  }): Promise<void> => {
    const runtime = runtimes.get(input.sessionId);
    if (!runtime) return;
    const state = runtime.controller.getState();
    if (state.mode !== 'server') return;
    const key = viewKey(input);
    if (
      runtime.reservedCheckpointsByView.has(key)
      || (runtime.activeCheckpointsByView.has(key) && !input.replaceActiveCheckpoint)
    ) return;
    runtime.pendingViewRecoveryKeys.add(key);

    const selectedView = readViews(
      input.sessionId,
      state.activeResponderLeaseId ?? runtime.legacyResponderLeaseId,
    ).find(view => view.connectionId === input.connectionId
      && view.viewGeneration === input.viewGeneration);
    if (!selectedView) {
      runtime.pendingViewRecoveryKeys.delete(key);
      appendTerminalAuthorityAudit(runtime.audit, {
        type: 'stale-view-recovery-checkpoint-skipped',
        kind: 'view-recovery-checkpoint-view-replaced',
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        viewGeneration: input.viewGeneration,
      });
      return;
    }
    const prepared = runtime.pendingCheckpointDeliveryPrepares.get(key);
    if (!input.checkpointDeliveryId) {
      if (prepared) return;
      let preparation!: {
        checkpointDeliveryId: string;
        connectionId: string;
        clientId: string;
        viewGeneration: number;
        authorityEpoch: string;
        streamEpoch: string;
        driverLeaseGeneration: string;
        acceptedViewAttributesGeneration: string;
        viewAttributesChallengeId: string;
        deadlineTimer: NodeJS.Timeout | null;
      };
      preparation = {
        checkpointDeliveryId: randomUUID(),
        connectionId: input.connectionId,
        clientId: selectedView.clientId ?? '',
        viewGeneration: input.viewGeneration,
        authorityEpoch: state.authorityEpoch,
        streamEpoch: state.streamEpoch,
        driverLeaseGeneration: state.streamEpoch,
        acceptedViewAttributesGeneration: state.streamEpoch,
        viewAttributesChallengeId: runtime.pendingViewAttributesChallengeId,
        deadlineTimer: null,
      };
      runtime.pendingCheckpointDeliveryPrepares.set(key, preparation);
      const accepted = await enqueueSettledViewFrame(
        input.sessionId,
        runtime,
        selectedView,
        {
          ...buildCheckpointCapability(input.sessionId, selectedView, 'checkpoint', {
            streamEpoch: state.streamEpoch,
          }),
          checkpointDeliveryPreparation: {
            checkpointDeliveryId: preparation.checkpointDeliveryId,
            authorityEpoch: preparation.authorityEpoch,
            streamEpoch: preparation.streamEpoch,
            viewGeneration: preparation.viewGeneration,
            driverLeaseGeneration: preparation.driverLeaseGeneration,
            acceptedViewAttributesGeneration: preparation.acceptedViewAttributesGeneration,
            viewAttributesChallengeId: preparation.viewAttributesChallengeId,
          },
        },
        'control',
      );
      if (!accepted) {
        runtime.pendingCheckpointDeliveryPrepares.delete(key);
        runtime.pendingViewRecoveryKeys.delete(key);
        recoverAuthoritySendFailure(input.sessionId, 'checkpoint-delivery-prepare-failed');
        return;
      }
      if (runtime.pendingCheckpointDeliveryPrepares.get(key) !== preparation) return;
      preparation.deadlineTimer = setTimeout(() => {
        const currentRuntime = runtimes.get(input.sessionId);
        if (currentRuntime !== runtime
          || runtime.pendingCheckpointDeliveryPrepares.get(key) !== preparation) return;
        runtime.pendingCheckpointDeliveryPrepares.delete(key);
        runtime.pendingViewRecoveryKeys.add(key);
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'checkpoint-delivery-ready-timeout',
          sessionId: input.sessionId,
          connectionId: input.connectionId,
          viewGeneration: input.viewGeneration,
        });
        const retryAttempt = (runtime.checkpointDeliveryReadyRetryAttempts.get(key) ?? 0) + 1;
        if (retryAttempt > checkpointReadyHandshakeMaxRetries) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'checkpoint-delivery-ready-retry-exhausted',
            kind: `attempt=${retryAttempt}`,
            sessionId: input.sessionId,
            connectionId: input.connectionId,
            viewGeneration: input.viewGeneration,
          });
          recoverAuthoritySendFailure(input.sessionId, 'checkpoint-delivery-ready-retry-exhausted');
          return;
        }
        runtime.checkpointDeliveryReadyRetryAttempts.set(key, retryAttempt);
        scheduleFreshAuthoritativeViewRecovery({
          sessionId: input.sessionId,
          connectionId: input.connectionId,
          viewGeneration: input.viewGeneration,
        }, runtime, preparation.streamEpoch, retryAttempt);
      }, checkpointReadyHandshakeTimeoutMs);
      preparation.deadlineTimer.unref?.();
      return;
    }
    if (!prepared || prepared.checkpointDeliveryId !== input.checkpointDeliveryId) return;
    if (prepared.deadlineTimer) clearTimeout(prepared.deadlineTimer);
    runtime.pendingCheckpointDeliveryPrepares.delete(key);
    runtime.checkpointDeliveryReadyRetryAttempts.delete(key);

    let nextCheckpointEpoch = checkpointEpochFor(state.streamEpoch);
    for (const checkpoint of [
      runtime.activeCheckpoint,
      ...runtime.activeCheckpointsByView.values(),
      ...runtime.reservedCheckpointsByView.values(),
    ]) {
      if (checkpoint?.streamEpoch === state.streamEpoch
        && BigInt(checkpoint.checkpointEpoch) >= BigInt(nextCheckpointEpoch)) {
        nextCheckpointEpoch = nextOrdinal(checkpoint.checkpointEpoch);
      }
    }

    const recovery = createCheckpoint(input.sessionId, {
      transitionEpoch: state.transitionEpoch ?? state.streamEpoch,
      streamEpoch: state.streamEpoch,
      checkpointEpoch: nextCheckpointEpoch,
      mode: 'authoritative',
      authorityMode: 'server',
      source: 'server-authority-promotion',
    });
    const checkpointStart = recovery.checkpointMessages.find(
      message => (message as Record<string, unknown>).type === 'terminal-checkpoint:start',
    ) as Record<string, unknown> | undefined;
    if (!checkpointStart) {
      runtime.pendingViewRecoveryKeys.delete(key);
      recoverAuthoritySendFailure(input.sessionId, 'view-recovery-checkpoint-admission-failed');
      return;
    }
    const {
      type: _checkpointType,
      connectionId: _checkpointConnectionId,
      viewGeneration: _checkpointViewGeneration,
      ...checkpointIdentityRecord
    } = checkpointStart;
    const checkpointIdentity = checkpointIdentityRecord as unknown as TerminalAuthorityCheckpointIdentity;
    if (input.replaceActiveCheckpoint) {
      runtime.activeCheckpointsByView.delete(key);
      runtime.checkpointTailSourceSeqByView.delete(key);
    }
    runtime.reservedCheckpointsByView.set(key, checkpointIdentity);
    const expectedRuntime = runtime;
    const expectedStreamEpoch = state.streamEpoch;
    const isCurrent = (): boolean => runtimes.get(input.sessionId) === expectedRuntime
      && runtime.controller.getState().mode === 'server'
      && runtime.controller.getState().streamEpoch === expectedStreamEpoch
      && runtime.reservedCheckpointsByView.get(key) === checkpointIdentity
      && router.getTerminalAuthorityResponderViews(input.sessionId).some(view => (
        view.connectionId === input.connectionId
        && view.viewGeneration === input.viewGeneration
      ));
    const accepted = await enqueueSettledViewFrameBatch(
      input.sessionId,
      runtime,
      selectedView,
      [
        {
          message: buildCheckpointCapability(input.sessionId, selectedView, 'checkpoint', checkpointStart),
        },
        ...recovery.checkpointMessages.map(message => ({
          message: {
            ...message,
            connectionId: input.connectionId,
            viewGeneration: input.viewGeneration,
          },
          ...((message as Record<string, unknown>).type === 'terminal-checkpoint:commit'
            ? {
                onSettled: () => {
                  if (!isCurrent()) return;
                  if (!selectedView.clientId) {
                    runtime.reservedCheckpointsByView.delete(key);
                    recoverAuthoritySendFailure(input.sessionId, 'checkpoint-delivery-proof-client-missing');
                    return;
                  }
                  const authorityState = runtime.controller.getState();
                  const proof = manager.recordTerminalAuthorityServerCheckpointDelivery(
                    input.sessionId,
                    {
                      sessionId: input.sessionId,
                      clientId: selectedView.clientId,
                      connectionId: input.connectionId,
                      viewGeneration: input.viewGeneration,
                      protocolVersion: checkpointIdentity.protocolVersion,
                      transitionEpoch: checkpointIdentity.transitionEpoch,
                      authorityEpoch: checkpointIdentity.authorityEpoch,
                      streamEpoch: checkpointIdentity.streamEpoch,
                      checkpointEpoch: checkpointIdentity.checkpointEpoch,
                      sourceSeq: checkpointIdentity.sourceSeq,
                      snapshotSeq: checkpointIdentity.snapshotSeq,
                      oldestRetainedSeq: checkpointIdentity.oldestRetainedSeq,
                      retentionPolicyId: checkpointIdentity.retentionPolicyId,
                      responderLeaseId: authorityState.activeResponderLeaseId ?? '',
                      driverLeaseId: authorityState.activeDriverLeaseId ?? '',
                      retainedStreamEpoch: recovery.retainedStreamEpoch,
                      retainedSourceSeq: recovery.retainedSourceSeq,
                      ...(checkpointIdentity.boundarySourceSeq === undefined
                        ? {}
                        : { boundarySourceSeq: checkpointIdentity.boundarySourceSeq }),
                    },
                  );
                  if (!proof.ok) {
                    runtime.reservedCheckpointsByView.delete(key);
                    recoverAuthoritySendFailure(
                      input.sessionId,
                      `checkpoint-delivery-proof-${proof.reason ?? 'rejected'}`,
                    );
                    return;
                  }
                  runtime.activeCheckpointsByView.set(key, checkpointIdentity);
                  runtime.checkpointTailSourceSeqByView.set(key, checkpointIdentity.sourceSeq);
                  runtime.reservedCheckpointsByView.delete(key);
                },
              }
            : {}),
        })),
      ],
    );
    if (runtime.reservedCheckpointsByView.get(key) === checkpointIdentity) {
      runtime.reservedCheckpointsByView.delete(key);
    }
    runtime.pendingViewRecoveryKeys.delete(key);
    const transactionStillCurrent = runtimes.get(input.sessionId) === expectedRuntime
      && runtime.controller.getState().mode === 'server'
      && runtime.controller.getState().streamEpoch === expectedStreamEpoch;
    const viewStillCurrent = router.getTerminalAuthorityResponderViews(input.sessionId).some(view => (
      view.connectionId === input.connectionId
      && view.viewGeneration === input.viewGeneration
    ));
    if (transactionStillCurrent
      && viewStillCurrent
      && (!accepted || runtime.activeCheckpointsByView.get(key) !== checkpointIdentity)) {
      recoverAuthoritySendFailure(input.sessionId, 'view-recovery-checkpoint-admission-failed');
    }
  };

  const scheduleFreshAuthoritativeViewRecovery = (
    registration: {
      sessionId: string;
      connectionId: string;
      viewGeneration: number;
    },
    runtime: RuntimeRecord,
    expectedStreamEpoch: string,
    attempt = 0,
  ): void => {
      const key = viewKey(registration);
      if (runtime.scheduledViewRecoveryKeys.has(key)) return;
    runtime.scheduledViewRecoveryKeys.add(key);
    const expectedRuntimeToken = runtime.runtimeToken;
    const runRecovery = () => {
      runtime.scheduledViewRecoveryKeys.delete(key);
      const currentRuntime = runtimes.get(registration.sessionId);
      const state = currentRuntime?.controller.getState();
      const replaceActiveCheckpoint = currentRuntime?.pendingViewRecoveryKeys.has(key) === true
        && currentRuntime.activeCheckpointsByView.has(key);
      if (!currentRuntime
        || currentRuntime !== runtime
        || currentRuntime.disposed
        || currentRuntime.runtimeToken !== expectedRuntimeToken
        || state?.mode !== 'server'
        || state.streamEpoch !== expectedStreamEpoch
        || (currentRuntime.activeCheckpointsByView.has(key) && !replaceActiveCheckpoint)
        || currentRuntime.reservedCheckpointsByView.has(key)) {
        return;
      }
      const currentViews = readViews(
        registration.sessionId,
        state.activeResponderLeaseId ?? currentRuntime.legacyResponderLeaseId,
      );
      const selectedView = currentViews.find(view => (
        view.connectionId === registration.connectionId
        && view.viewGeneration === registration.viewGeneration
      ));
      if (!selectedView) {
        if (attempt === 7) {
          appendTerminalAuthorityAudit(currentRuntime.audit, {
            type: 'view-recovery-awaiting-topology',
            kind: 'server-authority-views-empty',
            sessionId: registration.sessionId,
            connectionId: registration.connectionId,
            viewGeneration: registration.viewGeneration,
          });
        }
        scheduleFreshAuthoritativeViewRecovery(
          registration,
          currentRuntime,
          expectedStreamEpoch,
          attempt + 1,
        );
        return;
      }
      const replaced = currentRuntime.controller.replaceServerAuthorityViews(currentViews);
      if (!replaced.ok) {
        appendTerminalAuthorityAudit(currentRuntime.audit, {
          type: 'view-recovery-view-rebind-rejected',
          kind: replaced.reason ?? 'server-authority-view-rebind-failed',
          sessionId: registration.sessionId,
          connectionId: registration.connectionId,
          viewGeneration: registration.viewGeneration,
        });
        recoverAuthoritySendFailure(
          registration.sessionId,
          replaced.reason ?? 'server-authority-view-rebind-failed',
        );
        return;
      }
      currentRuntime.frozenViews = currentViews.map(view => ({ ...view }));
      void enqueueFreshAuthoritativeRecovery({
        ...registration,
        ...(replaceActiveCheckpoint ? { replaceActiveCheckpoint: true } : {}),
      }).catch(error => {
        appendTerminalAuthorityAudit(currentRuntime.audit, {
          type: 'view-recovery-checkpoint-failed',
          kind: error instanceof Error ? error.message : 'unknown-error',
          sessionId: registration.sessionId,
        });
        recoverAuthoritySendFailure(registration.sessionId, 'view-recovery-checkpoint-failed');
      });
    };
    if (attempt === 0) {
      queueMicrotask(runRecovery);
      return;
    }
    const timer = setTimeout(runRecovery, Math.min(10 * (2 ** (attempt - 1)), 250));
    timer.unref?.();
  };

  let refreshLegacyResponderView: (sessionId: string) => void = () => {};

  const terminalAuthorityRuntimeFactory: ProductionTerminalAuthorityRuntimeFactory = input => {
    // The retained shadow may already have reserved the candidate epoch. The
    // browser responder remains on its negotiated legacy generation until the
    // controller's positional handoff commits that candidate epoch.
    const controllerInitialStreamEpoch = input.initialStreamEpoch;
    const runtimeIdentitySuffix = input.runtimeInstanceGeneration > 1
      ? `-runtime-${input.runtimeInstanceGeneration}`
      : '';
    const legacyResponderLeaseId = `responder-browser-${controllerInitialStreamEpoch}${runtimeIdentitySuffix}`;
    const legacyDriverLeaseId = `driver-browser-${controllerInitialStreamEpoch}${runtimeIdentitySuffix}`;
    const audit: TerminalAuthorityEvent[] = [];
    const physicalDrains = new Set<string>();
    const runtimePlaceholder: Partial<RuntimeRecord> = {
      runtimeToken: Symbol(`terminal-authority-runtime:${input.sessionId}`),
      disposed: false,
      audit,
      initialStreamEpoch: controllerInitialStreamEpoch,
      legacyResponderLeaseId,
      legacyDriverLeaseId,
      frozenViews: [],
      disabledViewKeys: new Set(),
      expectedLegacyIdentity: null,
      precommitLegacyDriverIdentity: null,
      legacyRebindInFlightKeys: new Set(),
      legacyRefreshEpoch: 0,
      pendingViewAttributesHandshake: null,
      pendingViewAttributesChallengeId: randomUUID(),
      acceptedViewAttributesChallengeId: null,
      acceptedViewAttributesIdentity: null,
      physicalDrains,
      applyAcks: new Set(),
      drainAcks: new Map(),
      limitedSessionSelected: false,
      activeCheckpoint: null,
      activeCheckpointsByView: new Map(),
      reservedCheckpointsByView: new Map(),
      pendingViewRecoveryKeys: new Set(),
      checkpointDeliveryReadyRetryAttempts: new Map(),
      pendingCheckpointDeliveryPrepares: new Map(),
      scheduledViewRecoveryKeys: new Set(),
      checkpointTailSourceSeqByView: new Map(),
      checkpointPumpsByView: new Map(),
      debugFaultTriggerId: null,
      promotionDeadlineTimer: null,
      topologyRecoveryTimer: null,
      compatibilityTopologyRecoveryInFlight: false,
      authorityRecoveryRetryAttempt: 0,
      authorityRecoveryRetryTimer: null,
      wiring: {
        controllerFactoryCallCount: 1,
        retainedCheckpointAdapterCallCount: 0,
        checkpointDigestAdapterCallCount: 0,
      },
    };
    const controller = createTerminalAuthorityController({
      initial: {
        sessionId: input.sessionId,
        authorityEpoch: input.authorityEpoch,
        streamEpoch: controllerInitialStreamEpoch,
        sessionGeneration: input.sessionGeneration,
        legacyResponderLeaseId,
        legacyDriverLeaseId,
        sessionStatus: 'idle',
      },
      readPromotionGates: () => {
        const runtime = runtimes.get(input.sessionId) ?? runtimePlaceholder as RuntimeRecord;
        const parity = manager.readTerminalAuthorityPromotionParitySnapshot(input.sessionId);
        const queryCapability = readQueryResponderCapabilityState(input.sessionId);
        const queryAttributesAccepted = queryCapability?.hasAcceptedViewAttributes === true;
        const firstCapableView = router.getTerminalAuthorityResponderViews(input.sessionId)[0];
        const sessionContext = firstCapableView
          ? router.getTerminalAuthorityCanaryContext(firstCapableView.connectionId)
            ?.subscribedSessions.find(candidate => candidate.sessionId === input.sessionId)
          : undefined;
        return {
          retainedStateParity: parity.retainedStateParity,
          factParity: parity.factParity,
          leaseParity: parity.leaseParity,
          noLocalCacheParity: parity.noLocalCacheParity,
          limitedSessionSelected: runtime.limitedSessionSelected
            && parity.limitedSessionSelected,
          allRespondersCapable: sessionContext?.allAttachedViewsCapable === true,
          replayRepairIdle: runtime.limitedSessionSelected
            && sessionContext?.replayRepairIdle === true,
          queryResponderCapability: queryCapability?.promotionEligible === true
            && queryAttributesAccepted,
        };
      },
      listRequiredResponderViews: () => {
        const runtime = runtimes.get(input.sessionId) ?? runtimePlaceholder as RuntimeRecord;
        return readViews(input.sessionId, runtime.legacyResponderLeaseId);
      },
      readLastCommittedSourceSeq: () => (
        manager.getRetainedTerminalAuthorityState(input.sessionId)?.sourceSeq
        ?? initialOrdinal.sourceSeq
      ),
      readPromotionSafetyLimits: () => ({
        ackDeadlineMs: options.promotionSafetyLimits?.ackDeadlineMs
          ?? TERMINAL_AUTHORITY_DEFAULT_ACK_DEADLINE_MS,
        maxHeldOutputBytes: options.promotionSafetyLimits?.maxHeldOutputBytes ?? 1024 * 1024,
        maxHeldOutputChunks: options.promotionSafetyLimits?.maxHeldOutputChunks ?? 1024,
      }),
      now,
      onOrderedCompatibilityRecoveryRequired: reason => {
        appendTerminalAuthorityAudit(audit, {
          type: 'ordered-compatibility-recovery-required',
          kind: reason,
        });
        if (reason === 'responder-topology-changed-during-recovery'
          || reason === 'explicit-compatibility-recovery-resume') return;
        recoverAuthoritySendFailure(input.sessionId, reason);
      },
      enqueueTerminalMessage: message => sendTerminalFrame(input.sessionId, message),
      emit: event => {
        appendTerminalAuthorityAudit(audit, event);
        if (event.type !== 'server-responder-enabled') return;
        const runtime = runtimes.get(input.sessionId);
        const state = runtime?.controller.getState();
        if (!runtime || state?.mode !== 'server') return;
        const currentViews = readViews(
          input.sessionId,
          state.activeResponderLeaseId ?? runtime.legacyResponderLeaseId,
        );
        for (const view of currentViews) {
          const key = viewKey(view);
          if (!runtime.pendingViewRecoveryKeys.has(key)) continue;
          scheduleFreshAuthoritativeViewRecovery({
            ...view,
            sessionId: input.sessionId,
          }, runtime, state.streamEpoch);
        }
      },
      loadAuthoritativeRecovery: () => {
        const state = controller.getState();
        return createCheckpoint(input.sessionId, {
          transitionEpoch: state.transitionEpoch!,
          streamEpoch: state.streamEpoch,
          checkpointEpoch: checkpointEpochFor(state.streamEpoch),
          mode: 'authoritative',
          authorityMode: 'server',
          source: 'server-authority-promotion',
        });
      },
      loadCompatibilityRecovery: recoveryInput => createCheckpoint(input.sessionId, {
        ...recoveryInput,
        mode: 'compatibility',
        authorityMode: 'legacy',
        source: 'server-authority-rollback',
      }),
      onLegacyDisableQuorumAccepted: async receipt => {
        const runtime = runtimes.get(input.sessionId) ?? runtimePlaceholder as RuntimeRecord;
        const view = runtime.frozenViews.find(candidate => (
          candidate.connectionId === receipt.identity.connectionId
          && candidate.viewGeneration === receipt.identity.viewGeneration
        ));
        if (!view) return false;
        return enqueueSettledViewFrame(
          input.sessionId,
          runtime,
          view,
          {
            ...receipt.identity,
            type: 'terminal-authority:responder-disable-accepted',
            connectionId: receipt.identity.connectionId,
            accepted: true,
            completed: true,
            duplicate: false,
            acknowledgedViewCount: receipt.acknowledgedViewCount,
            requiredResponderViewCount: receipt.requiredResponderViewCount,
          },
          'control',
        );
      },
      stopNewAdmission: portInput => requireAuthorityPort(
        'stop-new-admission',
        manager.stopTerminalAuthorityNewAdmission(input.sessionId, portInput),
      ),
      installServerAuthorityLeases: leases => {
        let driverBound = false;
        try {
          requireAuthorityPort(
            'bind-server-driver-lease',
            manager.bindTerminalAuthorityServerDriverLease(input.sessionId, {
              driverLeaseId: leases.driverLeaseId,
            }),
          );
          driverBound = true;
          requireAuthorityPort(
            'enable-server-responder',
            manager.setTerminalAuthorityServerResponderEnabled(input.sessionId, {
              enabled: true,
              responderLeaseId: leases.responderLeaseId,
            }),
          );
        } catch (error) {
          if (driverBound) {
            const compensation = manager.revokeTerminalAuthorityDriverLease(input.sessionId, {
              driverLeaseId: leases.driverLeaseId,
            });
            if (!compensation.ok) {
              throw new Error(
                `install-server-authority-compensation-failed:${compensation.reason ?? 'rejected'}`,
                { cause: error },
              );
            }
          }
          throw error;
        }
      },
      rotateServerAuthorityEpoch: rotation => {
        const responderLeaseId = `responder-server-${rotation.nextStreamEpoch}`;
        const driverLeaseId = `driver-server-${rotation.nextStreamEpoch}`;
        requireAuthorityPort(
          'rotate-server-authority-epoch',
          manager.rotateTerminalAuthorityServerEpoch(input.sessionId, {
            streamEpoch: rotation.nextStreamEpoch,
            responderLeaseId,
            driverLeaseId,
          }),
        );
        return { responderLeaseId, driverLeaseId };
      },
      setServerResponderEnabled: portInput => requireAuthorityPort(
        'set-server-responder-enabled',
        manager.setTerminalAuthorityServerResponderEnabled(input.sessionId, portInput),
      ),
      revokeServerResponderLease: portInput => requireAuthorityPort(
        'revoke-server-responder-lease',
        manager.revokeTerminalAuthorityResponderLease(input.sessionId, portInput),
      ),
      revokeServerDriverLease: portInput => requireAuthorityPort(
        'revoke-server-driver-lease',
        manager.revokeTerminalAuthorityDriverLease(input.sessionId, portInput),
      ),
      markAffectedViewStale: view => {
        router.sendTerminalAuthorityFrameToConnection(view.connectionId, {
          type: 'terminal-authority:view-stale',
          sessionId: input.sessionId,
          ...view,
        }, 'terminal');
      },
      resetAffectedViewParser: view => {
        router.sendTerminalAuthorityFrameToConnection(view.connectionId, {
          type: 'terminal-authority:parser-reset',
          sessionId: input.sessionId,
          ...view,
        }, 'terminal');
      },
      purgeOldAckBacklog: () => {
        runtimePlaceholder.applyAcks?.clear();
        runtimePlaceholder.drainAcks?.clear();
        physicalDrains.clear();
      },
      rebindCompatibilityDriverLease: portInput => requireAuthorityPort(
        'rebind-compatibility-driver-lease',
        manager.rebindTerminalAuthorityCompatibilityDriverLease(input.sessionId, portInput),
      ),
      rebindCompatibilityResponderLease: portInput => {
        requireAuthorityPort(
          'rebind-compatibility-responder-lease',
          manager.rebindTerminalAuthorityCompatibilityResponderLease(input.sessionId, portInput),
        );
        try {
          requireAuthorityPort(
            'cleanup-rollback-runtime-ports',
            manager.cleanupTerminalAuthorityRuntimePorts(input.sessionId, {
              scope: 'rollback-complete',
            }),
          );
        } catch (error) {
          const compensation = manager.revokeTerminalAuthorityResponderLease(
            input.sessionId,
            portInput,
          );
          if (!compensation.ok) {
            throw new Error(
              `compatibility-responder-compensation-failed:${compensation.reason ?? 'rejected'}`,
              { cause: error },
            );
          }
          throw error;
        }
      },
      commitLegacyResponderIdentity: identity => {
        const runtime = runtimes.get(input.sessionId) ?? runtimePlaceholder as RuntimeRecord;
        runtime.activeCheckpointsByView.clear();
        runtime.reservedCheckpointsByView.clear();
        runtime.pendingViewRecoveryKeys.clear();
        runtime.checkpointTailSourceSeqByView.clear();
        runtime.expectedLegacyIdentity = identity;
        runtime.initialStreamEpoch = identity.streamEpoch;
        runtime.legacyResponderLeaseId = identity.responderLeaseId;
        runtime.legacyDriverLeaseId = identity.driverLeaseId;
        appendTerminalAuthorityAudit(audit, {
          type: 'legacy-responder-identity-committed',
          sessionId: identity.sessionId,
          connectionId: identity.connectionId,
          viewGeneration: identity.viewGeneration,
          transitionEpoch: identity.transitionEpoch,
          streamEpoch: identity.streamEpoch,
          responderLeaseId: identity.responderLeaseId,
          driverLeaseId: identity.driverLeaseId,
        });
      },
      hasCompatibilityTailPhysicallyDrained: drain => physicalDrains.has(compatibilityDrainKey({
        ...drain,
        sessionId: input.sessionId,
      })),
      transferHeldQueryToLegacyResponder: effect => {
        if (!effect.clientId
          || !manager.writeTerminalAuthorityCompatibilityQueryReply(input.sessionId, {
            responderLeaseId: effect.responderLeaseId,
            clientId: effect.clientId,
            viewGeneration: effect.viewGeneration,
            reply: effect.reply,
          })) {
          throw new Error('held-compatibility-query-reply-write-failed');
        }
        appendTerminalAuthorityAudit(audit, {
          type: 'held-query-transferred-to-legacy',
          effectKey: effect.effectKey,
          sourceSeq: effect.sourceSeq,
          responderLeaseId: effect.responderLeaseId,
        });
      },
      writeTerminalQueryReply: effect => {
        const responderLeaseId = runtimes.get(input.sessionId)
          ?.controller.getState().activeResponderLeaseId;
        if (!responderLeaseId || !manager.writeTerminalAuthorityServerQueryReply(
          input.sessionId,
          { responderLeaseId, reply: effect.reply },
        )) {
          throw new Error('terminal-query-reply-write-failed');
        }
      },
      writeLegacyBrowserQueryReply: effect => {
        if (!manager.writeTerminalQueryReply(input.sessionId, effect.reply)) {
          throw new Error('legacy-terminal-query-reply-write-failed');
        }
      },
    });
    const queryResponder = installTerminalQueryResponder({
      headlessState: input.headlessState,
      provider: {
        source: 'session-manager-spawn-record',
        backend: input.windowsPty?.backend === 'conpty'
          ? 'conpty'
          : input.windowsPty?.backend === 'winpty'
            ? 'winpty'
            : 'posix',
        spawnRecordId: input.processMetadata.processInstanceId
          ?? input.processMetadata.osStartIdentity
          ?? input.sessionGeneration,
      },
      readDriverViewIdentity: (): DriverViewIdentity | null => {
        const runtime = runtimes.get(input.sessionId);
        const precommit = runtime?.precommitLegacyDriverIdentity;
        const pending = runtime?.pendingViewAttributesHandshake;
        const pendingConnectionId = pending?.connectionId ?? null;
        const pendingViewGeneration = pending?.viewGeneration ?? null;
        const suspended = manager.getTerminalAuthoritySuspendedBrowserMutationLease(input.sessionId);
        const views = router.getTerminalAuthorityNegotiatedViews?.(input.sessionId)
          ?? router.getTerminalAuthorityResponderViews(input.sessionId);
        const pendingView = pendingConnectionId !== null && pendingViewGeneration !== null
          ? views.find(candidate => candidate.connectionId === pendingConnectionId
            && candidate.viewGeneration === pendingViewGeneration
            && (suspended === null || (
              candidate.clientId === suspended.clientId
              && candidate.viewGeneration === suspended.viewGeneration
            )))
          : undefined;
        const precommitView = precommit ? views.find(candidate => (
          candidate.connectionId === precommit.connectionId
          && candidate.viewGeneration === precommit.viewGeneration
        )) : undefined;
        const matchingPrecommit = precommitView ? precommit : null;
        const view = pendingView
          ?? (precommitView
            ? precommitView
            : suspended
            ? views.find(candidate => candidate.clientId === suspended.clientId
              && candidate.viewGeneration === suspended.viewGeneration)
            : views[0]);
        if (!runtime || !view || !view.clientId) return null;
        return {
          sessionId: input.sessionId,
          clientId: view.clientId,
          connectionId: view.connectionId,
          viewGeneration: view.viewGeneration,
          driverLeaseId: (pendingView ? pending?.driverLeaseId : undefined)
            ?? matchingPrecommit?.driverLeaseId
            ?? runtime.controller.getState().activeDriverLeaseId
            ?? runtime.legacyDriverLeaseId,
          driverLeaseGeneration: (pendingView ? pending?.driverLeaseGeneration : undefined)
            ?? matchingPrecommit?.driverLeaseGeneration
            ?? view.driverLeaseGeneration,
          expectedViewAttributesGeneration: (pendingView ? pending?.viewAttributesGeneration : undefined)
            ?? matchingPrecommit?.viewAttributesGeneration
            ?? view.acceptedViewAttributesGeneration,
          serverAcceptedViewAttributesGeneration: (pendingView ? pending?.viewAttributesGeneration : undefined)
            ?? matchingPrecommit?.viewAttributesGeneration
            ?? view.acceptedViewAttributesGeneration,
        };
      },
    });
    const runtime = {
      ...runtimePlaceholder,
      controller,
    } as RuntimeRecord;
    runtimes.set(input.sessionId, runtime);
    const legacyRefreshTimer = setTimeout(() => {
      if (runtimes.get(input.sessionId) === runtime && !runtime.disposed) {
        refreshLegacyResponderView(input.sessionId);
      }
    }, 0);
    legacyRefreshTimer.unref?.();
    return {
      controller,
      queryResponder,
      dispose: () => {
        const disposalErrors: unknown[] = [];
        try {
          disposeRuntime(input.sessionId);
        } catch (error) {
          disposalErrors.push(error);
        }
        try {
          queryResponder.detach();
        } catch (error) {
          disposalErrors.push(error);
        }
        if (disposalErrors.length > 0) {
          throw new AggregateError(
            disposalErrors,
            `terminal-authority-production-session-runtime-disposal-failed:${input.sessionId}`,
          );
        }
      },
    };
  };
  manager.setTerminalAuthorityRuntimeFactory(terminalAuthorityRuntimeFactory);

  const readExpectedLegacyIdentity = (sessionId: string): WsResponderIdentity | null => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return null;
    if (runtime.expectedLegacyIdentity) return runtime.expectedLegacyIdentity;
    const state = runtime.controller.getState();
    if (state.mode !== 'promoting' || !state.transitionEpoch) return null;
    const candidate = runtime.frozenViews.find(view => !runtime.disabledViewKeys.has(viewKey(view)));
    if (!candidate) return null;
    return {
      ...candidate,
      sessionId,
      transitionEpoch: state.transitionEpoch,
      authorityEpoch: state.authorityEpoch,
      streamEpoch: runtime.initialStreamEpoch,
      boundarySourceSeq: runtime.controller.getState().streamEpoch === state.streamEpoch
        ? [...runtime.audit].reverse().find(
            (event: TerminalAuthorityEvent) => event.type === 'headless-write-chain-fenced',
          )?.sourceSeq ?? '0'
        : '0',
      responderLeaseId: runtime.legacyResponderLeaseId,
    };
  };

  const queryReplyIngress = createTerminalQueryReplyIngress({
    readExpectedIdentity: readExpectedLegacyIdentity,
    writeTerminalQueryReply: ({ data, identity, replyOrdinal }) => {
      return manager.acceptTerminalAuthorityLegacyBrowserQueryReply(identity.sessionId, {
        ...identity,
        replyOrdinal,
        reply: data,
      });
    },
    writeInput: () => undefined,
    observeSemanticInput: () => undefined,
    isTerminalQueryReply: data => isParserGeneratedReply(data),
  });

  const promoteSession = async (sessionId: string): Promise<TerminalAuthorityPromotionResult> => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return { ok: false, reason: 'authority-runtime-unavailable' };
    const state = runtime.controller.getState();
    const nextStreamEpoch = nextOrdinal(state.streamEpoch);
    const queryCapability = readQueryResponderCapabilityState(sessionId);
    if (!queryCapability?.promotionEligible) {
      return {
        ok: false,
        reason: `queryResponderCapability-${queryCapability?.blocker ?? 'unavailable'}-gate-failed`,
      };
    }
    if (!queryCapability.hasAcceptedViewAttributes) {
      return {
        ok: false,
        reason: 'queryResponderCapability-view-attributes-unavailable-gate-failed',
      };
    }
    await manager.settleTerminalAuthorityPromotionEvidence(sessionId);
    const retained = manager.getRetainedTerminalAuthorityState(sessionId);
    if (!retained?.checkpoint) {
      return { ok: false, reason: 'server-checkpoint-unavailable' };
    }
    const prepared = manager.prepareTerminalAuthorityPromotionCandidate(sessionId, {
      transitionEpoch: nextStreamEpoch,
      limitedSessionSelected: runtime.limitedSessionSelected,
    });
    if (!prepared.ok) {
      if (prepared.reason === 'server-recovery-ack-missing') {
        const refresh = router.refreshTerminalAuthorityServerRecovery(sessionId);
        if (!refresh.ok) {
          return { ok: false, reason: refresh.reason ?? prepared.reason };
        }
      }
      return { ok: false, reason: prepared.reason };
    }
    const replaySupersession = router.supersedeTerminalAuthorityBootstrapReplay(sessionId);
    if (!replaySupersession.ok) {
      return { ok: false, reason: replaySupersession.reason ?? 'replay-repair-not-idle' };
    }
    try {
      const result = await manager.beginTerminalAuthorityPromotion(sessionId, {
        sessionId,
        authorityEpoch: state.authorityEpoch,
        previousStreamEpoch: state.streamEpoch,
        nextStreamEpoch,
        transitionEpoch: nextStreamEpoch,
        oldResponderLeaseId: runtime.legacyResponderLeaseId,
        nextResponderLeaseId: `responder-server-${nextStreamEpoch}`,
        nextDriverLeaseId: `driver-server-${nextStreamEpoch}`,
      });
      if (!result.ok && runtime.controller.getState().mode === 'rolling-back') {
        const rollback = await rollbackSession(sessionId);
        if (!rollback.ok) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'promotion-failure-rollback-rejected',
            kind: rollback.reason,
            sessionId,
          });
        }
      }
      if (result.ok) {
        if (runtime.promotionDeadlineTimer) clearTimeout(runtime.promotionDeadlineTimer);
        runtime.promotionDeadlineTimer = setTimeout(() => {
          runtime.promotionDeadlineTimer = null;
          if (!isScheduledTerminalAuthorityRuntimeCurrent(runtime, runtimes.get(sessionId))) return;
          const deadline = runtime.controller.checkPromotionDeadline();
          if (!deadline.abortRequired
            || !isScheduledTerminalAuthorityRuntimeCurrent(runtime, runtimes.get(sessionId))) return;
          void rollbackSession(sessionId).then(rollback => {
            if (!rollback.ok) {
              appendTerminalAuthorityAudit(runtime.audit, {
                type: 'promotion-deadline-rollback-rejected',
                kind: rollback.reason,
                sessionId,
              });
            }
          }).catch(error => {
            appendTerminalAuthorityAudit(runtime.audit, {
              type: 'promotion-deadline-rollback-failed',
              kind: error instanceof Error ? error.message : 'unknown-error',
              sessionId,
            });
          });
        }, getTerminalAuthorityPromotionAckTimerDelayMs(
          options.promotionSafetyLimits?.ackDeadlineMs,
        ));
        runtime.promotionDeadlineTimer.unref?.();
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'promotion-port-failed',
      };
    }
  };

  // @req MIG-BGSTAB-002 AC-1 AC-2
  const handleCanaryRequest = async (
    connectionId: string,
    message: Record<string, unknown>,
  ): Promise<void> => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const context = router.getTerminalAuthorityCanaryContext(connectionId);
    if (!requestId || Object.prototype.hasOwnProperty.call(message, 'sessionId') || !context) {
      router.sendTerminalAuthorityFrameToConnection(connectionId, {
        type: 'terminal-authority:canary-decision',
        requestId,
        decisionSource: 'server-policy',
        selectedSessionId: null,
        decisions: [],
        accepted: false,
        reason: 'invalid-server-derived-canary-request',
      }, 'control');
      return;
    }

    for (const session of context.subscribedSessions) {
      const runtime = runtimes.get(session.sessionId);
      if (runtime) runtime.limitedSessionSelected = false;
    }
    const selectedContext = context.subscribedSessions.find(session => {
      const runtime = runtimes.get(session.sessionId);
      return runtime?.controller.getState().mode === 'legacy'
        && session.allAttachedViewsCapable
        && session.replayRepairIdle;
    });
    const selectedRuntime = selectedContext ? runtimes.get(selectedContext.sessionId) : undefined;
    if (selectedRuntime) selectedRuntime.limitedSessionSelected = true;
    const promotion = selectedContext
      ? await promoteSession(selectedContext.sessionId)
      : { ok: false, reason: 'no-eligible-limited-session' };
    if (!promotion.ok && selectedRuntime) selectedRuntime.limitedSessionSelected = false;
    const selectedState = selectedRuntime?.controller.getState();
    const decisions = context.subscribedSessions.map(session => {
      if (session.sessionId === selectedContext?.sessionId && promotion.ok) {
        return {
          sessionId: session.sessionId,
          authorityMode: 'server' as const,
          accepted: true,
        };
      }
      const reason = selectedContext
        ? 'limited-session-not-selected'
        : !session.allAttachedViewsCapable
            ? 'all-view-capability-gate-failed'
            : !session.replayRepairIdle
              ? 'replay-repair-not-idle'
              : promotion.reason ?? 'limited-session-not-selected';
      return {
        sessionId: session.sessionId,
        authorityMode: 'legacy' as const,
        accepted: false,
        failClosed: true,
        reason,
      };
    });
    router.sendTerminalAuthorityFrameToConnection(connectionId, {
      type: 'terminal-authority:canary-decision',
      requestId,
      decisionSource: 'server-policy',
      selectedSessionId: promotion.ok ? selectedContext?.sessionId ?? null : null,
      decisions,
      capabilityGateEvidence: context.subscribedSessions.map(session => ({
        sessionId: session.sessionId,
        attachedViewCount: session.attachedViews.length,
        capableViewCount: session.capableViews.length,
        attachedViews: session.attachedViews.map(view => ({
          viewGeneration: view.viewGeneration,
          capable: view.capable,
        })),
        replayRepairIdle: session.replayRepairIdle,
      })),
      ...(promotion.ok && selectedRuntime && selectedState
        ? {
            transitionEpoch: promotion.transitionEpoch,
            authorityEpoch: selectedState.authorityEpoch,
            streamEpoch: promotion.streamEpoch,
            boundarySourceSeq: promotion.boundarySourceSeq,
            responderLeaseId: selectedRuntime.legacyResponderLeaseId,
          }
        : { accepted: false, reason: promotion.reason }),
    }, 'control');
  };

  const tryLegacyResponderViewRefresh = async (
    sessionId: string,
    runtime: RuntimeRecord,
    challengeId: string,
    refreshEpoch: number,
  ): Promise<boolean> => {
    const refreshIsCurrent = (): boolean => (
      runtimes.get(sessionId) === runtime
      && !runtime.disposed
      && runtime.legacyRefreshEpoch === refreshEpoch
    );
    if (!refreshIsCurrent()) return false;
    const claimedPending = runtime.pendingViewAttributesHandshake;
    if (claimedPending?.challengeId === challengeId && claimedPending.refreshEpoch === refreshEpoch) {
      if (claimedPending.capabilityIssued) {
        claimedPending.dirty = true;
        return false;
      }
      if (claimedPending.capabilityInFlight) {
        claimedPending.dirty = true;
        return false;
      }
      claimedPending.capabilityInFlight = true;
      claimedPending.topologyRetargetPending = false;
    }
    try {
    const state = runtime.controller.getState();
    if (state.mode !== 'legacy') return false;
    const currentViews = readViews(sessionId, runtime.legacyResponderLeaseId);
    if (!refreshIsCurrent()) return false;
    runtime.frozenViews = currentViews.map(view => ({ ...view }));
    const suspended = manager.getTerminalAuthoritySuspendedBrowserMutationLease(sessionId);
    const selected = claimedPending?.retargetAnchorConnectionId
      && claimedPending.retargetAnchorClientId
      ? currentViews.find(view => (
          view.connectionId === claimedPending.retargetAnchorConnectionId
          && view.clientId === claimedPending.retargetAnchorClientId
        ))
      : suspended
        ? currentViews.find(view => view.clientId === suspended.clientId
          && view.viewGeneration === suspended.viewGeneration) ?? currentViews[0]
        : currentViews[0];
    if (!selected || selected.clientId === undefined) return false;
    if (!refreshIsCurrent()) return false;
    if (claimedPending
      && runtime.pendingViewAttributesHandshake === claimedPending
      && claimedPending.challengeId === challengeId) {
      claimedPending.retargetAnchorConnectionId ??= selected.connectionId;
      claimedPending.retargetAnchorClientId ??= selected.clientId;
    }
    const mutationLease = manager.establishRetainedTerminalMutationLease(
      sessionId,
      selected.clientId,
      selected.viewGeneration,
    );
    if (!mutationLease.ok) {
      appendTerminalAuthorityAudit(runtime.audit, {
        type: 'terminal-authority-legacy-mutation-lease-transfer-rejected',
        kind: mutationLease.reason,
        sessionId,
        connectionId: selected.connectionId,
        viewGeneration: selected.viewGeneration,
      });
      return false;
    }
    const expectedLegacyIdentity = runtime.expectedLegacyIdentity;
    const legacyResponderViewChanged = expectedLegacyIdentity !== null && (
      expectedLegacyIdentity.connectionId !== selected.connectionId
      || expectedLegacyIdentity.viewGeneration !== selected.viewGeneration
      || expectedLegacyIdentity.driverLeaseGeneration !== selected.driverLeaseGeneration
      || expectedLegacyIdentity.acceptedViewAttributesGeneration
        !== selected.acceptedViewAttributesGeneration
    );
    if (expectedLegacyIdentity && legacyResponderViewChanged) {
      const rebindKey = [
        selected.connectionId,
        selected.viewGeneration,
        selected.driverLeaseGeneration,
        selected.acceptedViewAttributesGeneration,
      ].join('\u0000');
      if (runtime.legacyRebindInFlightKeys.has(rebindKey)) {
        const pending = runtime.pendingViewAttributesHandshake;
        if (pending?.challengeId === challengeId) pending.dirty = true;
        return false;
      }
      runtime.legacyRebindInFlightKeys.add(rebindKey);
      try {
        if (!refreshIsCurrent()) return false;
        const rebound = runtime.controller.replaceLegacyCompatibilityResponderView(selected);
        if (!rebound.ok) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'terminal-authority-legacy-responder-view-rebind-rejected',
            kind: rebound.reason,
            sessionId,
            connectionId: selected.connectionId,
            viewGeneration: selected.viewGeneration,
          });
          return false;
        }
        const reboundIdentity = {
          ...expectedLegacyIdentity,
          ...selected,
          sessionId,
          transitionEpoch: state.transitionEpoch ?? expectedLegacyIdentity.transitionEpoch,
          authorityEpoch: state.authorityEpoch,
          streamEpoch: state.streamEpoch,
          responderLeaseId: runtime.legacyResponderLeaseId,
          driverLeaseId: runtime.legacyDriverLeaseId,
          connectionId: selected.connectionId,
          viewGeneration: selected.viewGeneration,
          driverLeaseGeneration: selected.driverLeaseGeneration,
          acceptedViewAttributesGeneration: selected.acceptedViewAttributesGeneration,
        } satisfies TerminalLegacyResponderIdentity;
        const sent = await sendTerminalFrame(sessionId, {
          type: 'terminal-authority:legacy-responder-enabled',
          source: 'server-controller-topology-rebind',
          ...reboundIdentity,
        });
        const currentSelected = readViews(sessionId, runtime.legacyResponderLeaseId).find(view => (
          view.connectionId === selected.connectionId
          && view.clientId === selected.clientId
          && view.viewGeneration === selected.viewGeneration
          && view.driverLeaseGeneration === selected.driverLeaseGeneration
          && view.acceptedViewAttributesGeneration === selected.acceptedViewAttributesGeneration
        ));
        const currentPending = runtime.pendingViewAttributesHandshake;
        const currentSuspended = manager.getTerminalAuthoritySuspendedBrowserMutationLease(sessionId);
        const exactSameIdentityAdoption = !refreshIsCurrent()
          && (currentPending === null || (
            currentPending.dirty
            && !currentPending.settled
            && !currentPending.capabilityIssued
            && currentPending.runtimeToken === runtime.runtimeToken
            && currentPending.refreshEpoch === runtime.legacyRefreshEpoch
            && currentPending.challengeId === runtime.pendingViewAttributesChallengeId
            && (currentPending.connectionId === null
              || (currentPending.connectionId === selected.connectionId
                && currentPending.clientId === selected.clientId
                && currentPending.viewGeneration === selected.viewGeneration
                && currentPending.driverLeaseGeneration === selected.driverLeaseGeneration
                && currentPending.viewAttributesGeneration === selected.acceptedViewAttributesGeneration))
          ))
          && currentSuspended?.clientId === selected.clientId
          && currentSuspended.viewGeneration === selected.viewGeneration
          && currentSelected !== undefined;
        if (!refreshIsCurrent() && !exactSameIdentityAdoption) return false;
        appendTerminalAuthorityAudit(runtime.audit, {
          type: sent
            ? 'terminal-authority-legacy-responder-view-rebound'
            : 'terminal-authority-legacy-responder-view-rebind-send-failed',
          sessionId,
          connectionId: selected.connectionId,
          viewGeneration: selected.viewGeneration,
        });
        if (!sent
          || runtimes.get(sessionId) !== runtime
          || runtime.disposed
          || (runtime.legacyRefreshEpoch !== refreshEpoch && !exactSameIdentityAdoption)
          || runtime.controller.getState().mode !== 'legacy'
          || runtime.expectedLegacyIdentity !== expectedLegacyIdentity
          || !currentSelected) {
          return false;
        }
        runtime.expectedLegacyIdentity = reboundIdentity;
      } catch (error) {
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'terminal-authority-legacy-responder-view-rebind-send-failed',
          kind: error instanceof Error ? error.message : 'unknown-error',
          sessionId,
          connectionId: selected.connectionId,
          viewGeneration: selected.viewGeneration,
        });
        return false;
      } finally {
        runtime.legacyRebindInFlightKeys.delete(rebindKey);
        const pending = runtime.pendingViewAttributesHandshake;
        if (pending?.dirty
          && !pending.capabilityIssued
          && !pending.settled
          && pending.refreshEpoch === runtime.legacyRefreshEpoch) {
          pending.dirty = false;
          void tryLegacyResponderViewRefresh(
            sessionId,
            runtime,
            pending.challengeId,
            pending.refreshEpoch,
          );
        }
      }
    }
    if (!refreshIsCurrent()
      || runtime.controller.getState().mode !== 'legacy'
      || runtime.pendingViewAttributesChallengeId !== challengeId) {
      return false;
    }
    if (claimedPending && (
      runtime.pendingViewAttributesHandshake !== claimedPending
      || claimedPending.settled
      || Date.now() >= claimedPending.deadlineAt
    )) {
      return false;
    }
    const currentPending = runtime.pendingViewAttributesHandshake;
    if (currentPending && currentPending.challengeId === challengeId) {
      currentPending.connectionId = selected.connectionId;
      currentPending.clientId = selected.clientId;
      currentPending.viewGeneration = selected.viewGeneration;
      currentPending.streamEpoch = state.streamEpoch;
      currentPending.driverLeaseId = runtime.legacyDriverLeaseId;
      currentPending.driverLeaseGeneration = selected.driverLeaseGeneration;
      currentPending.viewAttributesGeneration = selected.acceptedViewAttributesGeneration;
      currentPending.capabilityIssued = true;
    }
    const sent = await enqueueSettledViewFrame(sessionId, runtime, selected, {
      type: 'terminal-checkpoint:capability',
      protocolVersion: 1,
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
        authorityStreamEpoch: state.streamEpoch,
        driverLeaseGeneration: selected.driverLeaseGeneration,
        acceptedViewAttributesGeneration: selected.acceptedViewAttributesGeneration,
        viewAttributesChallengeId: challengeId,
      }],
      mutationLeases: [{
        sessionId,
        authorityEpoch: mutationLease.authorityEpoch,
        viewGeneration: mutationLease.viewGeneration,
        leaseGeneration: mutationLease.leaseGeneration,
      }],
    }, 'control');
    if (!refreshIsCurrent()) return false;
    if (currentPending && runtime.pendingViewAttributesHandshake === currentPending && !sent) {
      settlePendingViewAttributesHandshake(runtime, currentPending, false);
    }
    return sent;
    } finally {
      if (claimedPending && runtime.pendingViewAttributesHandshake === claimedPending) {
        claimedPending.capabilityInFlight = false;
        if (claimedPending.topologyRetargetPending
          && claimedPending.dirty
          && !claimedPending.capabilityIssued
          && !claimedPending.settled
          && claimedPending.refreshEpoch === runtime.legacyRefreshEpoch
          && Date.now() < claimedPending.deadlineAt) {
          claimedPending.topologyRetargetPending = false;
          claimedPending.dirty = false;
          queueMicrotask(() => {
            void tryLegacyResponderViewRefresh(
              sessionId,
              runtime,
              claimedPending.challengeId,
              claimedPending.refreshEpoch,
            );
          });
        }
      }
    }
  };

  refreshLegacyResponderView = (sessionId: string): void => {
    const runtime = runtimes.get(sessionId);
    if (!runtime || runtime.controller.getState().mode !== 'legacy') return;
    const challengeId = runtime.pendingViewAttributesChallengeId;
    const refreshEpoch = ++runtime.legacyRefreshEpoch;
    const pending = runtime.pendingViewAttributesHandshake;
    if (pending?.challengeId === challengeId) pending.refreshEpoch = refreshEpoch;
    void tryLegacyResponderViewRefresh(sessionId, runtime, challengeId, refreshEpoch);
  };

  const scheduleCompatibilityTopologyRecovery = (
    sessionId: string,
    runtime: RuntimeRecord,
  ): void => {
    if (runtime.topologyRecoveryTimer) {
      return;
    }
    runtime.topologyRecoveryTimer = setTimeout(() => {
      runtime.topologyRecoveryTimer = null;
      if (runtime.disposed || runtimes.get(sessionId) !== runtime) return;
      const latestState = runtime.controller.getState();
      if (latestState.mode !== 'rolling-back') return;
      const latestViews = readViews(sessionId, runtime.legacyResponderLeaseId);
      if (runtime.controller.hasActiveCompatibilityRecoveryTransaction()) {
        const restarted = runtime.controller.restartCompatibilityRecovery(
          'responder-topology-changed-during-recovery',
        );
        if (!restarted.ok) return;
      }
      const replaced = runtime.controller.replaceCompatibilityRecoveryViews(latestViews);
      if (!replaced.ok) return;
      runtime.frozenViews = latestViews.map(view => ({ ...view }));
      if (latestViews.length > 0) {
        runtime.compatibilityTopologyRecoveryInFlight = true;
        void rollbackSession(sessionId, true).catch(error => {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'topology-recovery-rollback-failed',
            kind: error instanceof Error ? error.message : 'unknown-error',
            sessionId,
          });
        });
      }
    }, 20);
    runtime.topologyRecoveryTimer.unref?.();
  };

  const wakeCompatibilityTopologyRecovery = (
    sessionId: string,
    runtime: RuntimeRecord,
  ): void => {
    const state = runtime.controller.getState();
    if (state.mode !== 'rolling-back') return;
    const currentViews = readViews(sessionId, runtime.legacyResponderLeaseId);
    if (runtime.compatibilityTopologyRecoveryInFlight) {
      if (responderViewMembershipMatches(runtime.frozenViews, currentViews)) {
        return;
      }
      runtime.compatibilityTopologyRecoveryInFlight = false;
    }
    const activeRecovery = runtime.controller.hasActiveCompatibilityRecoveryTransaction();
    if (activeRecovery
      && rollbackResponderTopologyMatches(runtime.frozenViews, currentViews, state.streamEpoch)) return;
    if (activeRecovery) {
      const restarted = runtime.controller.restartCompatibilityRecovery(
        'responder-topology-changed-during-recovery',
      );
      if (!restarted.ok) return;
    }
    // Control/output pair replacement can publish several intermediate
    // projections. Keep the latest view set and restart only after the
    // connection topology has been quiet for one debounce window.
    runtime.frozenViews = currentViews.map(view => ({ ...view }));
    scheduleCompatibilityTopologyRecovery(sessionId, runtime);
  };

  const readFreshAuthoritativeCheckpoint = (input: {
    sessionId: string;
    clientId: string;
    connectionId: string;
  }): TerminalAuthorityFreshCheckpoint | null => {
    const runtime = runtimes.get(input.sessionId);
    const state = runtime?.controller.getState();
    if (!runtime || !state || state.mode !== 'server') return null;
    const view = router.getTerminalAuthorityNegotiatedViews?.(input.sessionId).find(candidate => (
      candidate.clientId === input.clientId && candidate.connectionId === input.connectionId
    ));
    const visibility = view
      ? router.getTerminalAuthorityDeliveryVisibility?.(
          input.sessionId,
          input.connectionId,
          view.viewGeneration,
        )
      : null;
    if (!view || !visibility || !isCanonicalOrdinal64(visibility.visibilityGeneration)) return null;

    const recovery = createCheckpoint(input.sessionId, {
      transitionEpoch: state.transitionEpoch ?? state.streamEpoch,
      streamEpoch: state.streamEpoch,
      checkpointEpoch: checkpointEpochFor(state.streamEpoch),
      mode: 'authoritative',
      authorityMode: 'server',
      source: 'server-authority-promotion',
    });
    const asRecord = (value: unknown): Record<string, unknown> | null => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    );
    const isPositiveSafeInteger = (value: unknown): value is number => (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    );
    const isNonNegativeSafeInteger = (value: unknown): value is number => (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
    const start = recovery.checkpointMessages
      .map(asRecord)
      .find((message): message is Record<string, unknown> => message?.type === 'terminal-checkpoint:start');
    const streamEpoch = start?.streamEpoch;
    const checkpointEpoch = start?.checkpointEpoch;
    const snapshotSeq = start?.snapshotSeq;
    const oldestRetainedSeq = start?.oldestRetainedSeq;
    const retentionPolicyId = start?.retentionPolicyId;
    if (!start
      || !isCanonicalOrdinal64(streamEpoch)
      || !isCanonicalOrdinal64(checkpointEpoch)
      || !isCanonicalOrdinal64(snapshotSeq)
      || !isCanonicalOrdinal64(oldestRetainedSeq)
      || typeof retentionPolicyId !== 'string' || retentionPolicyId.length === 0
      || typeof start.sourceGeometry !== 'object'
      || start.sourceGeometry === null
      || typeof start.modes !== 'object'
      || start.modes === null
      || typeof start.digest !== 'object'
      || start.digest === null
      || typeof start.parserTail !== 'object'
      || start.parserTail === null) {
      return null;
    }
    const geometry = asRecord(start.sourceGeometry);
    const digest = asRecord(start.digest);
    const parserTail = asRecord(start.parserTail);
    const modes = asRecord(start.modes);
    const cols = geometry?.cols;
    const rows = geometry?.rows;
    const digestHex = digest?.hex;
    const parserTailData = parserTail?.data;
    const parserTailBytes = parserTail?.encodedBytes;
    if (!geometry || !digest || !parserTail || !modes
      || !isPositiveSafeInteger(cols) || !isPositiveSafeInteger(rows)
      || digest.algorithm !== 'sha256' || typeof digestHex !== 'string' || !/^[a-f0-9]{64}$/u.test(digestHex)
      || parserTail.encoding !== 'base64' || typeof parserTailData !== 'string'
      || !isNonNegativeSafeInteger(parserTailBytes)
      || Object.values(modes).some(value => typeof value !== 'boolean')) {
      return null;
    }
    const booleanModes: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(modes)) {
      if (typeof value !== 'boolean') return null;
      booleanModes[key] = value;
    }
    const chunks: TerminalAuthorityFreshCheckpoint['fullCheckpoint']['chunks'][number][] = [];
    for (const message of recovery.checkpointMessages) {
      const chunk = asRecord(message);
      if (!chunk || chunk.type !== 'terminal-checkpoint:chunk') continue;
      const chunkIndex = chunk.chunkIndex;
      const chunkCount = chunk.chunkCount;
      const chunkData = chunk.data;
      const encodedBytes = chunk.encodedBytes;
      if (!isNonNegativeSafeInteger(chunkIndex)
        || !isPositiveSafeInteger(chunkCount) || chunkIndex >= chunkCount
        || chunk.encoding !== 'base64' || typeof chunkData !== 'string'
        || !isNonNegativeSafeInteger(encodedBytes)) {
        return null;
      }
      chunks.push({
        sequence: chunks.length,
        chunkIndex,
        chunkCount,
        encoding: 'base64',
        data: chunkData,
        encodedBytes,
      });
    }
    if (chunks.length === 0 || chunks.some(chunk => chunk.chunkCount !== chunks.length
      || chunk.chunkIndex !== chunk.sequence)) {
      return null;
    }

    // This record is issued from the freshly serialized server model and is
    // bound to the negotiated browser view by the router before any dataGap
    // can enter the fair delivery ledger.
    return {
      continuity: {
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        viewGeneration: view.viewGeneration,
        visibilityGeneration: visibility.visibilityGeneration,
        lastDeliveredSeq: snapshotSeq,
        streamEpoch,
        checkpointEpoch,
        snapshotSeq,
        oldestRetainedSeq,
        retentionPolicyId,
        expiresAt: Date.now() + 60_000,
      },
      fullCheckpoint: {
        streamEpoch,
        checkpointEpoch,
        snapshotSeq,
        oldestRetainedSeq,
        retentionPolicyId,
        geometry: { cols, rows },
        modes: booleanModes,
        chunks,
        digest: { algorithm: 'sha256', hex: digestHex },
        parserTail: {
          encoding: 'base64',
          data: parserTailData,
          encodedBytes: parserTailBytes,
        },
        tailOnly: false,
      },
    };
  };

  const uninstallHooks = router.installTerminalAuthorityHooks({
    queryReplyIngress,
    readFreshAuthoritativeCheckpoint,
    readViewAuthorityMode: registration => {
      const state = runtimes.get(registration.sessionId)?.controller.getState();
      if (!state) return 'legacy';
      const promotionCheckpointCommitted = state.mode === 'promoting'
        && state.frozenRequiredResponderCount > 0
        && state.acceptedDisableAckCount === state.frozenRequiredResponderCount;
      return state.mode === 'server' || state.mode === 'rolling-back' || promotionCheckpointCommitted
        ? 'checkpoint'
        : 'legacy';
    },
    readViewAuthorityStreamEpoch: sessionId => (
      runtimes.get(sessionId)?.controller.getState().streamEpoch
      ?? manager.getRetainedTerminalAuthorityState(sessionId)?.streamEpoch
      ?? null
    ),
    readViewAttributesChallengeId: registration => {
      const runtime = runtimes.get(registration.sessionId);
      if (!runtime) return null;
      const pending = runtime.pendingViewAttributesHandshake;
      if (!pending) {
        const accepted = runtime.acceptedViewAttributesIdentity;
        return accepted
          && accepted.connectionId === registration.connectionId
          && accepted.clientId === registration.clientId
          && accepted.viewGeneration === registration.viewGeneration
          ? accepted.challengeId
          : runtime.pendingViewAttributesChallengeId;
      }
      return pending.connectionId === registration.connectionId
        && pending.clientId === registration.clientId
        && pending.viewGeneration === registration.viewGeneration
        ? pending.challengeId
        : null;
    },
    onViewAuthorityReady: registration => {
      const runtime = runtimes.get(registration.sessionId);
      if (!runtime) return;
      const state = runtime.controller.getState();
      if (state.mode === 'legacy') {
        const pending = runtime.pendingViewAttributesHandshake;
        if (pending
          && pending.connectionId === registration.connectionId
          && pending.viewGeneration === registration.viewGeneration) {
          pending.dirty = true;
          return;
        }
        if (readQueryResponderCapabilityState(registration.sessionId)?.hasAcceptedViewAttributes === true) {
          return;
        }
        refreshLegacyResponderView(registration.sessionId);
        return;
      }
      if (state.mode === 'promoting') {
        if (registration.authorityStreamEpoch === state.streamEpoch) {
          runtime.pendingViewRecoveryKeys.add(viewKey(registration));
        }
        return;
      }
      if (state.mode === 'rolling-back') {
        // Registration readiness may be re-advertised after a fresh snapshot
        // ACK without changing the physical responder view. Topology events
        // own rollback replacement; treating this capability refresh as a
        // topology change would repeatedly invalidate the active checkpoint.
        return;
      }
      if (state.mode !== 'server'
        || registration.authorityStreamEpoch !== state.streamEpoch) return;
      const registrationKey = viewKey(registration);
      if (!runtime.activeCheckpointsByView.has(registrationKey)
        && !runtime.reservedCheckpointsByView.has(registrationKey)) {
        runtime.pendingViewRecoveryKeys.add(registrationKey);
      }
      const currentViews = readViews(
        registration.sessionId,
        state.activeResponderLeaseId ?? runtime.legacyResponderLeaseId,
      );
      const replaced = runtime.controller.replaceServerAuthorityViews(currentViews);
      if (!replaced.ok) {
        if (replaced.reason === 'server-authority-views-empty') {
          scheduleFreshAuthoritativeViewRecovery(
            registration,
            runtime,
            state.streamEpoch,
          );
          return;
        }
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'view-recovery-view-rebind-rejected',
          kind: replaced.reason ?? 'server-authority-view-rebind-failed',
          sessionId: registration.sessionId,
          connectionId: registration.connectionId,
          viewGeneration: registration.viewGeneration,
        });
        recoverAuthoritySendFailure(
          registration.sessionId,
          replaced.reason ?? 'server-authority-view-rebind-failed',
        );
        return;
      }
      runtime.frozenViews = currentViews.map(view => ({ ...view }));
      void enqueueFreshAuthoritativeRecovery(registration).catch(error => {
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'view-recovery-checkpoint-failed',
          kind: error instanceof Error ? error.message : 'unknown-error',
          sessionId: registration.sessionId,
        });
        recoverAuthoritySendFailure(registration.sessionId, 'view-recovery-checkpoint-failed');
      });
    },
    onClientFrame: ({ connectionId, clientId, channelRole, message }) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const runtime = runtimes.get(sessionId);
      if (message.type === 'terminal-checkpoint:ready') {
        const viewGeneration = Number(message.viewGeneration);
        const key = viewKey({ connectionId, viewGeneration });
        const prepared = runtime?.pendingCheckpointDeliveryPrepares.get(key);
        const state = runtime?.controller.getState();
        const matches = prepared !== undefined
          && channelRole === 'control'
          && state?.mode === 'server'
          && state.authorityEpoch === prepared.authorityEpoch
          && state.streamEpoch === prepared.streamEpoch
          && prepared.connectionId === connectionId
          && prepared.clientId === clientId
          && prepared.viewGeneration === viewGeneration
          && prepared.checkpointDeliveryId === message.checkpointDeliveryId
          && prepared.authorityEpoch === message.authorityEpoch
          && prepared.streamEpoch === message.streamEpoch
          && prepared.driverLeaseGeneration === message.driverLeaseGeneration
          && prepared.acceptedViewAttributesGeneration === message.acceptedViewAttributesGeneration
          && prepared.viewAttributesChallengeId === message.viewAttributesChallengeId;
        if (!matches) {
          if (runtime) appendTerminalAuthorityAudit(runtime.audit, {
            type: 'checkpoint-delivery-ready-rejected',
            kind: 'identity-mismatch',
            sessionId,
            connectionId,
            viewGeneration,
          });
          return true;
        }
        const replaceActiveCheckpoint = runtime !== undefined
          && runtime.pendingViewRecoveryKeys.has(key)
          && runtime.activeCheckpointsByView.has(key);
        void enqueueFreshAuthoritativeRecovery({
          sessionId,
          connectionId,
          viewGeneration,
          checkpointDeliveryId: prepared.checkpointDeliveryId,
          ...(replaceActiveCheckpoint ? { replaceActiveCheckpoint: true } : {}),
        }).catch(error => {
          recoverAuthoritySendFailure(sessionId, error instanceof Error
            ? 'checkpoint-delivery-ready-recovery-failed'
            : 'checkpoint-delivery-ready-recovery-unknown');
        });
        return true;
      }
      if (message.type === 'terminal-authority:canary-request') {
        void handleCanaryRequest(connectionId, message);
        return true;
      }
      if (message.type === 'terminal-authority:view-attributes') {
        if (!runtime) {
          router.sendTerminalAuthorityFrameToConnection(connectionId, {
            type: 'terminal-authority:view-attributes-accepted',
            sessionId,
            viewGeneration: Number(message.viewGeneration),
            ...(typeof message.viewAttributesChallengeId === 'string'
              ? { viewAttributesChallengeId: message.viewAttributesChallengeId }
              : {}),
            accepted: false,
            reason: 'authority-runtime-unavailable',
          }, 'control');
          return true;
        }
        const viewGeneration = Number(message.viewGeneration);
        const view = router.getTerminalAuthorityNegotiatedView?.(
          sessionId,
          connectionId,
          viewGeneration,
        ) ?? router.getTerminalAuthorityResponderViews(sessionId).find(candidate => (
          candidate.connectionId === connectionId
          && candidate.viewGeneration === viewGeneration
        ));
        const attributes = parseTerminalViewAttributes(message.attributes);
        const precommit = runtime.precommitLegacyDriverIdentity;
        const matchingPrecommit = precommit !== null
          && precommit.connectionId === connectionId
          && precommit.viewGeneration === viewGeneration;
        const driverLeaseId = (matchingPrecommit ? precommit.driverLeaseId : undefined)
          ?? runtime.controller.getState().activeDriverLeaseId
          ?? runtime.legacyDriverLeaseId;
        const pendingAtIngress = runtime.pendingViewAttributesHandshake;
        const pendingRefreshEpochAtIngress = pendingAtIngress?.refreshEpoch ?? null;
        const pendingChallengeAtIngress = pendingAtIngress?.challengeId ?? null;
        const targetsPendingOwner = pendingAtIngress !== null
          && pendingAtIngress.connectionId === connectionId
          && pendingAtIngress.viewGeneration === viewGeneration;
        const exactPendingChallenge = targetsPendingOwner
          && message.viewAttributesChallengeId === pendingAtIngress.challengeId;
        const pendingIngressIdentityKey = pendingAtIngress
          ? viewAttributesHandshakeIdentityKey(pendingAtIngress)
          : null;
        const canIssueIdentityReplacement = pendingAtIngress !== null
          && pendingIngressIdentityKey !== null
          && !pendingAtIngress.replacementIdentityKeys.has(pendingIngressIdentityKey)
          && pendingAtIngress.replacementIdentityKeys.size < maxViewAttributesIdentityReplacements;
        const result = !view
          ? { accepted: false, reason: 'view-attributes-registration-unavailable' }
          : !attributes
            ? { accepted: false, reason: 'view-attributes-shape-invalid' }
            : typeof message.viewAttributesChallengeId !== 'string'
              || message.viewAttributesChallengeId.length === 0
              ? { accepted: false, reason: 'view-attributes-challenge-missing' }
              : pendingAtIngress && !targetsPendingOwner
                ? { accepted: false, reason: 'view-attributes-pending-owner-mismatch' }
                : message.viewAttributesChallengeId !== runtime.pendingViewAttributesChallengeId
                ? { accepted: false, reason: 'view-attributes-challenge-mismatch' }
                : pendingAtIngress && (!exactPendingChallenge
                  || pendingAtIngress.runtimeToken !== runtime.runtimeToken
                  || pendingAtIngress.streamEpoch !== runtime.controller.getState().streamEpoch
                  || pendingAtIngress.clientId !== (view.clientId ?? null)
                  || pendingAtIngress.driverLeaseId !== driverLeaseId)
                  ? { accepted: false, reason: 'view-attributes-pending-identity-mismatch' }
                : message.driverLeaseGeneration !== (pendingAtIngress?.driverLeaseGeneration
                  ?? (matchingPrecommit ? precommit.driverLeaseGeneration : undefined)
                  ?? view.driverLeaseGeneration)
                  ? { accepted: false, reason: 'view-attributes-driver-generation-mismatch' }
                  : message.viewAttributesGeneration !== (pendingAtIngress?.viewAttributesGeneration
                    ?? (matchingPrecommit ? precommit.viewAttributesGeneration : undefined)
                    ?? view.acceptedViewAttributesGeneration)
                    ? { accepted: false, reason: 'view-attributes-generation-mismatch' }
                    : !view.clientId
                      ? { accepted: false, reason: 'view-attributes-client-identity-unavailable' }
                      : manager.pushTerminalAuthorityViewAttributes(sessionId, {
                        identity: {
                          sessionId,
                          clientId: view.clientId,
                          connectionId: matchingPrecommit ? precommit.connectionId : connectionId,
                          viewGeneration: matchingPrecommit ? precommit.viewGeneration : view.viewGeneration,
                          driverLeaseId,
                          driverLeaseGeneration: (exactPendingChallenge
                            ? pendingAtIngress?.driverLeaseGeneration
                            : undefined)
                            ?? (matchingPrecommit ? precommit.driverLeaseGeneration : undefined)
                            ?? view.driverLeaseGeneration,
                          viewAttributesGeneration: (exactPendingChallenge
                            ? pendingAtIngress?.viewAttributesGeneration
                            : undefined)
                            ?? (matchingPrecommit ? precommit.viewAttributesGeneration : undefined)
                            ?? view.acceptedViewAttributesGeneration,
                        },
                        attributes,
                      });
        const acceptedAttributesBytes = attributes
          ? Buffer.from(JSON.stringify(attributes), 'utf8')
          : null;
        if (result.accepted && precommit !== null) {
          runtime.precommitLegacyDriverIdentity = null;
        }
        const shouldRotateTargetChallenge = pendingAtIngress !== null
          && targetsPendingOwner
          && exactPendingChallenge
          && (result.reason === 'view-attributes-driver-generation-mismatch'
            || result.reason === 'view-attributes-generation-mismatch')
          && canIssueIdentityReplacement;
        let ackCallbackSettled = false;
        const settleAcceptedAck = (error?: Error): void => {
          if (ackCallbackSettled) return;
          ackCallbackSettled = true;
          if (runtimes.get(sessionId) !== runtime || runtime.disposed) return;
          if (pendingAtIngress && (
            runtime.pendingViewAttributesHandshake !== pendingAtIngress
            || pendingAtIngress.settled
            || pendingAtIngress.refreshEpoch !== pendingRefreshEpochAtIngress
            || pendingAtIngress.challengeId !== pendingChallengeAtIngress
            || Date.now() >= pendingAtIngress.deadlineAt
          )) {
            return;
          }
          if (error) {
            if (pendingAtIngress && runtime.pendingViewAttributesHandshake === pendingAtIngress) {
              settlePendingViewAttributesHandshake(runtime, pendingAtIngress, false);
            }
            return;
          }
          if (result.accepted && view) {
            const acceptedIdentity: AcceptedViewAttributesHandshakeIdentity = {
              runtimeToken: runtime.runtimeToken,
              challengeId: String(message.viewAttributesChallengeId),
              connectionId,
              clientId: view.clientId ?? null,
              viewGeneration: view.viewGeneration,
              streamEpoch: runtime.controller.getState().streamEpoch,
              driverLeaseId,
              driverLeaseGeneration: view.driverLeaseGeneration,
              viewAttributesGeneration: view.acceptedViewAttributesGeneration,
            };
            runtime.acceptedViewAttributesChallengeId = acceptedIdentity.challengeId;
            runtime.acceptedViewAttributesIdentity = acceptedIdentity;
            if (pendingAtIngress && runtime.pendingViewAttributesHandshake === pendingAtIngress) {
              const capability = readQueryResponderCapabilityState(sessionId);
              if (capability?.promotionEligible === true
                && capability.hasAcceptedViewAttributes === true) {
                settlePendingViewAttributesHandshake(runtime, pendingAtIngress, true);
                return;
              }
              runtime.acceptedViewAttributesChallengeId = null;
              runtime.acceptedViewAttributesIdentity = null;
              if (canIssueIdentityReplacement && Date.now() < pendingAtIngress.deadlineAt) {
                pendingAtIngress.replacementIdentityKeys.add(pendingIngressIdentityKey);
                const replacementChallenge = randomUUID();
                pendingAtIngress.challengeId = replacementChallenge;
                pendingAtIngress.connectionId = null;
                pendingAtIngress.clientId = null;
                pendingAtIngress.viewGeneration = null;
                pendingAtIngress.streamEpoch = null;
                pendingAtIngress.driverLeaseId = null;
                pendingAtIngress.driverLeaseGeneration = null;
                pendingAtIngress.viewAttributesGeneration = null;
                pendingAtIngress.capabilityIssued = false;
                pendingAtIngress.dirty = false;
                pendingAtIngress.topologyRetargetPending = true;
                pendingAtIngress.retargetAnchorConnectionId = null;
                pendingAtIngress.retargetAnchorClientId = null;
                pendingAtIngress.refreshEpoch = ++runtime.legacyRefreshEpoch;
                runtime.pendingViewAttributesChallengeId = replacementChallenge;
                void tryLegacyResponderViewRefresh(
                  sessionId,
                  runtime,
                  replacementChallenge,
                  pendingAtIngress.refreshEpoch,
                );
                return;
              }
              settlePendingViewAttributesHandshake(runtime, pendingAtIngress, false);
            }
            return;
          }
          if (shouldRotateTargetChallenge
            && runtime.pendingViewAttributesHandshake === pendingAtIngress
            && Date.now() < pendingAtIngress.deadlineAt) {
            pendingAtIngress.replacementIdentityKeys.add(pendingIngressIdentityKey!);
            const replacementChallenge = randomUUID();
            pendingAtIngress.challengeId = replacementChallenge;
            pendingAtIngress.connectionId = null;
            pendingAtIngress.clientId = null;
            pendingAtIngress.viewGeneration = null;
            pendingAtIngress.streamEpoch = null;
            pendingAtIngress.driverLeaseId = null;
            pendingAtIngress.driverLeaseGeneration = null;
            pendingAtIngress.viewAttributesGeneration = null;
            pendingAtIngress.capabilityIssued = false;
            pendingAtIngress.dirty = false;
            pendingAtIngress.topologyRetargetPending = true;
            pendingAtIngress.refreshEpoch = ++runtime.legacyRefreshEpoch;
            runtime.pendingViewAttributesChallengeId = replacementChallenge;
            void tryLegacyResponderViewRefresh(
              sessionId,
              runtime,
              replacementChallenge,
              pendingAtIngress.refreshEpoch,
            );
          }
        };
        const ackDelivery = router.sendTerminalAuthorityFrameToConnection(connectionId, {
          type: 'terminal-authority:view-attributes-accepted',
          sessionId,
          viewGeneration: Number(message.viewGeneration),
          ...(typeof message.viewAttributesChallengeId === 'string'
            ? { viewAttributesChallengeId: message.viewAttributesChallengeId }
            : {}),
          accepted: result.accepted,
          ...(acceptedAttributesBytes
            ? {
                acceptedViewAttributesByteLength: acceptedAttributesBytes.byteLength,
                acceptedViewAttributesSha256: createHash('sha256')
                  .update(acceptedAttributesBytes)
                  .digest('hex'),
              }
            : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        }, 'control', settleAcceptedAck);
        if (!ackDelivery.sent) settleAcceptedAck(new Error('view-attributes-ack-admission-failed'));
        return true;
      }
      if (!runtime) return false;
      if (message.type === 'terminal-authority:responder-disabled') {
        const responderView = runtime.frozenViews.find(view => (
          view.connectionId === connectionId
          && view.viewGeneration === Number(message.viewGeneration)
        ));
        const responderIdentity = {
          ...message,
          ...(responderView ?? {}),
          sessionId,
          connectionId,
        } as unknown as TerminalAuthorityResponderIdentity;
        void manager.acknowledgeTerminalAuthorityLegacyDisable(
          sessionId,
          responderIdentity,
        ).then(result => {
          if (result.accepted) runtime.disabledViewKeys.add(viewKey(responderIdentity));
          if (result.completed && runtime.promotionDeadlineTimer) {
            clearTimeout(runtime.promotionDeadlineTimer);
            runtime.promotionDeadlineTimer = null;
          }
          const state = runtime.controller.getState();
          if (!result.completed && state.mode === 'rolling-back') {
            queueMicrotask(() => {
              void rollbackSession(sessionId).catch(error => {
                appendTerminalAuthorityAudit(runtime.audit, {
                  type: 'promotion-preflight-rollback-failed',
                  kind: error instanceof Error ? error.message : 'unknown-error',
                  sessionId,
                });
              });
            });
          }
          if (!result.completionReceiptSent) {
            router.sendTerminalAuthorityFrameToConnection(connectionId, {
              ...responderIdentity,
              type: 'terminal-authority:responder-disable-accepted',
              connectionId,
              accepted: result.accepted,
              completed: result.completed ?? false,
              duplicate: result.duplicate ?? false,
              acknowledgedViewCount: state.acceptedDisableAckCount,
              requiredResponderViewCount: state.frozenRequiredResponderCount,
              ...(result.reason ? { reason: result.reason } : {}),
            }, 'control');
          }
        }).catch(error => {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'responder-disable-ack-settlement-failed',
            kind: error instanceof Error ? error.message : 'unknown-error',
            sessionId,
          });
          recoverAuthoritySendFailure(sessionId, 'responder-disable-ack-settlement-failed');
        });
        return true;
      }
      if (message.type === 'terminal-checkpoint:apply-ack') {
        const expectedCheckpoint = runtime.activeCheckpointsByView.get(viewKey({
          connectionId,
          viewGeneration: Number(message.viewGeneration),
        })) ?? null;
        const currentView = router.getTerminalAuthorityResponderViews(sessionId).find(view => (
          view.connectionId === connectionId
          && view.viewGeneration === Number(message.viewGeneration)
        ));
        if (
          currentView
          && isSupersededTerminalCheckpointAck(
            expectedCheckpoint as unknown as Readonly<Record<string, unknown>> | null,
            message,
          )
        ) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'terminal-checkpoint-superseded-ack-ignored',
            kind: 'apply',
            sessionId,
            connectionId,
            viewGeneration: Number(message.viewGeneration),
            streamEpoch: String(message.streamEpoch),
          });
          return true;
        }
        if (!currentView
          || !expectedCheckpoint
          || !checkpointWireIdentityMatches(expectedCheckpoint, message, connectionId)
          || message.appliedThroughSeq !== expectedCheckpoint.snapshotSeq) {
          router.sendTerminalAuthorityFrameToConnection(connectionId, {
            type: 'terminal-checkpoint:rejected',
            supportedProtocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
            phase: 'ack',
            reason: 'invalid-message',
            sessionId,
            ackIdentity: {
              sessionId: message.sessionId,
              connectionId,
              viewGeneration: message.viewGeneration,
              streamEpoch: message.streamEpoch,
              checkpointEpoch: message.checkpointEpoch,
            },
          }, 'control');
          return true;
        }
        const key = checkpointAckKey(connectionId, message);
        runtime.applyAcks.add(key);
        const drainedThroughSourceSeq = runtime.drainAcks.get(key);
        if (drainedThroughSourceSeq) {
          runtime.physicalDrains.add(compatibilityDrainKey({
            connectionId,
            sessionId,
            viewGeneration: Number(message.viewGeneration),
            transitionEpoch: expectedCheckpoint.transitionEpoch,
            authorityEpoch: expectedCheckpoint.authorityEpoch,
            streamEpoch: String(message.streamEpoch),
            responderLeaseId: expectedCheckpoint.responderLeaseId ?? '',
            boundarySourceSeq: expectedCheckpoint.boundarySourceSeq ?? '',
            checkpointEpoch: String(message.checkpointEpoch),
            drainedThroughSourceSeq,
          }));
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'compatibility-tail-physically-drained',
            lane: options.transportMode === 'split' ? 'output' : 'unified',
            connectionId,
          });
        }
        return true;
      }
      if (message.type === 'terminal-checkpoint:drain-ack') {
        const expectedViewKey = viewKey({
          connectionId,
          viewGeneration: Number(message.viewGeneration),
        });
        const expectedCheckpoint = runtime.activeCheckpointsByView.get(expectedViewKey) ?? null;
        const expectedDrainedThroughSourceSeq = runtime.checkpointTailSourceSeqByView.get(expectedViewKey)
          ?? expectedCheckpoint?.sourceSeq;
        const currentView = router.getTerminalAuthorityResponderViews(sessionId).find(view => (
          view.connectionId === connectionId
          && view.viewGeneration === Number(message.viewGeneration)
        ));
        if (
          currentView
          && isSupersededTerminalCheckpointAck(
            expectedCheckpoint as unknown as Readonly<Record<string, unknown>> | null,
            message,
          )
        ) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'terminal-checkpoint-superseded-ack-ignored',
            kind: 'drain',
            sessionId,
            connectionId,
            viewGeneration: Number(message.viewGeneration),
            streamEpoch: String(message.streamEpoch),
          });
          return true;
        }
        if (!currentView
          || !checkpointWireIdentityMatches(expectedCheckpoint, message, connectionId)
          || !expectedCheckpoint
          || typeof message.drainedThroughSeq !== 'string'
          || !isValidCheckpointDrainWatermark(
            expectedCheckpoint.sourceSeq,
            expectedDrainedThroughSourceSeq ?? '',
            message.drainedThroughSeq,
          )) {
          router.sendTerminalAuthorityFrameToConnection(connectionId, {
            type: 'terminal-checkpoint:rejected',
            supportedProtocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
            phase: 'ack',
            reason: 'invalid-message',
            sessionId,
            ackIdentity: {
              sessionId: message.sessionId,
              connectionId,
              viewGeneration: message.viewGeneration,
              streamEpoch: message.streamEpoch,
              checkpointEpoch: message.checkpointEpoch,
            },
          }, 'control');
          return true;
        }
        const key = checkpointAckKey(connectionId, message);
        const drainedThroughSourceSeq = typeof message.drainedThroughSeq === 'string'
          ? message.drainedThroughSeq
          : '';
        if (drainedThroughSourceSeq) runtime.drainAcks.set(key, drainedThroughSourceSeq);
        if (runtime.applyAcks.has(key)) {
          runtime.physicalDrains.add(compatibilityDrainKey({
            connectionId,
            sessionId,
            viewGeneration: Number(message.viewGeneration),
            transitionEpoch: expectedCheckpoint.transitionEpoch,
            authorityEpoch: expectedCheckpoint.authorityEpoch,
            streamEpoch: String(message.streamEpoch),
            responderLeaseId: expectedCheckpoint.responderLeaseId ?? '',
            boundarySourceSeq: expectedCheckpoint.boundarySourceSeq ?? '',
            checkpointEpoch: String(message.checkpointEpoch),
            drainedThroughSourceSeq,
          }));
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'compatibility-tail-physically-drained',
            lane: options.transportMode === 'split' ? 'output' : 'unified',
            connectionId,
          });
        }
        return true;
      }
      if (message.type === 'terminal-checkpoint:failure-ack') {
        const expectedViewKey = viewKey({
          connectionId,
          viewGeneration: Number(message.viewGeneration),
        });
        const expectedCheckpoint = runtime.activeCheckpointsByView.get(expectedViewKey) ?? null;
        const currentView = router.getTerminalAuthorityResponderViews(sessionId).find(view => (
          view.connectionId === connectionId
          && view.viewGeneration === Number(message.viewGeneration)
        ));
        if (
          currentView
          && isSupersededTerminalCheckpointAck(
            expectedCheckpoint as unknown as Readonly<Record<string, unknown>> | null,
            message,
          )
        ) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'terminal-checkpoint-superseded-ack-ignored',
            kind: 'failure',
            sessionId,
            connectionId,
            viewGeneration: Number(message.viewGeneration),
            streamEpoch: String(message.streamEpoch),
          });
          return true;
        }
        if (!currentView || !checkpointWireIdentityMatches(expectedCheckpoint, message, connectionId)) {
          router.sendTerminalAuthorityFrameToConnection(connectionId, {
            type: 'terminal-checkpoint:rejected',
            supportedProtocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
            phase: 'ack',
            reason: 'invalid-message',
            sessionId,
            ackIdentity: {
              sessionId: message.sessionId,
              connectionId,
              viewGeneration: message.viewGeneration,
              streamEpoch: message.streamEpoch,
              checkpointEpoch: message.checkpointEpoch,
            },
          }, 'control');
          return true;
        }
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'terminal-checkpoint-failure-acknowledged',
          kind: typeof message.reason === 'string' ? message.reason : 'apply-failed',
          sessionId,
          connectionId,
          viewGeneration: currentView.viewGeneration,
        });
        queueMicrotask(() => {
          if (runtime.controller.getState().mode === 'rolling-back') {
            const restarted = runtime.controller.restartCompatibilityRecovery(
              `checkpoint-failure:${String(message.reason ?? 'apply-failed')}`,
            );
            if (!restarted.ok) {
              appendTerminalAuthorityAudit(runtime.audit, {
                type: 'terminal-checkpoint-failure-restart-rejected',
                kind: restarted.reason,
                sessionId,
              });
              return;
            }
          }
          void rollbackSession(sessionId).then(result => {
            if (!result.ok) {
              appendTerminalAuthorityAudit(runtime.audit, {
                type: 'terminal-checkpoint-failure-rollback-rejected',
                kind: result.reason,
                sessionId,
              });
            }
          }).catch(error => {
            appendTerminalAuthorityAudit(runtime.audit, {
              type: 'terminal-checkpoint-failure-rollback-failed',
              kind: error instanceof Error ? error.message : 'unknown-error',
              sessionId,
            });
          });
        });
        return true;
      }
      if (message.type === 'terminal-authority:compatibility-drained') {
        void runtime.controller.acknowledgeCompatibilityDrain(
          {
            ...message,
            connectionId,
          } as unknown as Parameters<TerminalAuthorityController['acknowledgeCompatibilityDrain']>[0],
        ).then(result => {
          router.sendTerminalAuthorityFrameToConnection(connectionId, {
            ...message,
            type: 'terminal-authority:compatibility-drain-accepted',
            connectionId,
            accepted: result.accepted,
            completed: result.completed,
            duplicate: result.duplicate ?? false,
            ...(result.reason ? { reason: result.reason } : {}),
          }, 'control');
        }).catch(error => {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'compatibility-drain-settlement-failed',
            kind: error instanceof Error ? error.message : 'unknown-error',
            sessionId,
          });
          recoverAuthoritySendFailure(sessionId, 'compatibility-drain-settlement-failed');
        });
        return true;
      }
      return false;
    },
    onTopologyChanged: change => {
      const runtime = runtimes.get(change.sessionId);
      if (!runtime) return;
      const state = runtime.controller.getState();
      if (state.mode === 'legacy') {
        const pending = runtime.pendingViewAttributesHandshake;
        const pendingAnchorConnectionId = pending?.retargetAnchorConnectionId
          ?? pending?.connectionId;
        const pendingAnchorClientId = pending?.retargetAnchorClientId ?? pending?.clientId;
        const pendingOwnerOutputChanged = pending
          && (change.kind === 'output-unpaired' || change.kind === 'output-replaced')
          && change.connectionId === pendingAnchorConnectionId;
        if (pendingOwnerOutputChanged) {
          settlePendingViewAttributesHandshake(runtime, pending, false);
          runtime.pendingViewAttributesChallengeId = randomUUID();
          runtime.acceptedViewAttributesChallengeId = null;
          runtime.acceptedViewAttributesIdentity = null;
          return;
        }
        if (pending) {
          const currentViews = readViews(change.sessionId, runtime.legacyResponderLeaseId);
          const currentOwner = pending.connectionId === null
            ? undefined
            : currentViews.find(view => (
                view.connectionId === pending.connectionId
                && view.clientId === pending.clientId
                && view.viewGeneration === pending.viewGeneration
                && view.driverLeaseGeneration === pending.driverLeaseGeneration
                && view.acceptedViewAttributesGeneration === pending.viewAttributesGeneration
              ));
          const generationSuccessor = change.kind === 'generation-changed'
            && pendingAnchorConnectionId
            && pendingAnchorClientId
            ? currentViews.find(view => (
                view.connectionId === pendingAnchorConnectionId
                && view.clientId === pendingAnchorClientId
                && view.viewGeneration === change.viewGeneration
              ))
            : undefined;
          if (generationSuccessor
            && !currentOwner
            && Date.now() < pending.deadlineAt) {
            if (!pending.topologyReplacementIssued) {
              pending.topologyReplacementIssued = true;
              pending.challengeId = randomUUID();
            }
            pending.connectionId = null;
            pending.clientId = null;
            pending.viewGeneration = null;
            pending.streamEpoch = null;
            pending.driverLeaseId = null;
            pending.driverLeaseGeneration = null;
            pending.viewAttributesGeneration = null;
            pending.capabilityIssued = false;
            pending.dirty = false;
            pending.topologyRetargetPending = true;
            pending.refreshEpoch = ++runtime.legacyRefreshEpoch;
            runtime.pendingViewAttributesChallengeId = pending.challengeId;
            runtime.acceptedViewAttributesChallengeId = null;
            runtime.acceptedViewAttributesIdentity = null;
            void tryLegacyResponderViewRefresh(
              change.sessionId,
              runtime,
              pending.challengeId,
              pending.refreshEpoch,
            );
            return;
          }
          if (pending.connectionId && !currentOwner) {
            settlePendingViewAttributesHandshake(runtime, pending, false);
            runtime.pendingViewAttributesChallengeId = randomUUID();
            runtime.acceptedViewAttributesChallengeId = null;
            runtime.acceptedViewAttributesIdentity = null;
            if (currentViews.length > 0) {
              refreshLegacyResponderView(change.sessionId);
            }
            return;
          }
          if (pending.connectionId) {
            if (pending.capabilityInFlight) pending.dirty = true;
            return;
          }
        }
        refreshLegacyResponderView(change.sessionId);
        return;
      }
      if (state.mode === 'server') {
        if (change.kind === 'output-unpaired' || change.kind === 'output-replaced') {
          const detachedFrozenView = runtime.frozenViews.find(view => (
            view.connectionId === change.connectionId
            && view.viewGeneration === change.viewGeneration
          ));
          if (detachedFrozenView?.clientId) {
            manager.invalidateTerminalAuthorityServerCheckpointDelivery(change.sessionId, {
              clientId: detachedFrozenView.clientId,
              viewGeneration: detachedFrozenView.viewGeneration,
            });
          }
        }
        if (change.kind === 'output-replaced') {
          recoverAuthoritySendFailure(change.sessionId, 'checkpoint-transport-binding-replaced');
          return;
        }
        const previousViewKeys = new Set(runtime.frozenViews.map(viewKey));
        const currentViews = readViews(
          change.sessionId,
          state.activeResponderLeaseId ?? runtime.legacyResponderLeaseId,
        );
        const currentViewKeys = new Set(currentViews.map(viewKey));
        const invalidatesPendingDelivery = change.kind === 'generation-changed'
          || change.kind === 'disconnect'
          || change.kind === 'unsubscribe'
          || change.kind === 'output-unpaired';
        for (const [key, pending] of runtime.pendingCheckpointDeliveryPrepares) {
          if (!currentViewKeys.has(key) || invalidatesPendingDelivery) {
            if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
            runtime.pendingCheckpointDeliveryPrepares.delete(key);
            runtime.checkpointDeliveryReadyRetryAttempts.delete(key);
            if (currentViewKeys.has(key)) runtime.pendingViewRecoveryKeys.add(key);
          }
        }
        for (const key of runtime.checkpointDeliveryReadyRetryAttempts.keys()) {
          if (!currentViewKeys.has(key) || invalidatesPendingDelivery) {
            runtime.checkpointDeliveryReadyRetryAttempts.delete(key);
          }
        }
        for (const key of runtime.pendingViewRecoveryKeys) {
          if (!currentViewKeys.has(key)) runtime.pendingViewRecoveryKeys.delete(key);
        }
        for (const view of currentViews) {
          const key = viewKey(view);
          if (!previousViewKeys.has(key)
            && !runtime.activeCheckpointsByView.has(key)
            && !runtime.reservedCheckpointsByView.has(key)) {
            runtime.pendingViewRecoveryKeys.add(key);
          }
        }
        runtime.frozenViews = currentViews.map(view => ({ ...view }));
        for (const key of runtime.activeCheckpointsByView.keys()) {
          if (!currentViewKeys.has(key)) runtime.activeCheckpointsByView.delete(key);
        }
        for (const key of runtime.reservedCheckpointsByView.keys()) {
          if (!currentViewKeys.has(key)) runtime.reservedCheckpointsByView.delete(key);
        }
        for (const key of runtime.checkpointTailSourceSeqByView.keys()) {
          if (!currentViewKeys.has(key)) runtime.checkpointTailSourceSeqByView.delete(key);
        }
        if (currentViews.length > 0) {
          const replaced = runtime.controller.replaceServerAuthorityViews(currentViews);
          if (!replaced.ok) {
            appendTerminalAuthorityAudit(runtime.audit, {
              type: 'view-recovery-view-rebind-rejected',
              kind: replaced.reason ?? 'server-authority-view-rebind-failed',
              sessionId: change.sessionId,
            });
            recoverAuthoritySendFailure(
              change.sessionId,
              replaced.reason ?? 'server-authority-view-rebind-failed',
            );
            return;
          }
          const selected = currentViews.find(view => (
            view.connectionId === change.connectionId
            && view.viewGeneration === change.viewGeneration
          )) ?? currentViews[0];
          const currentMutationLease = manager.getTerminalAuthoritySuspendedBrowserMutationLease(
            change.sessionId,
          );
          const clientId = selected.clientId;
          const hasLiveMutationOwner = currentMutationLease !== null
            && router.getTerminalAuthorityNegotiatedViews?.(change.sessionId).some(view => (
              view.clientId === currentMutationLease.clientId
              && view.viewGeneration === currentMutationLease.viewGeneration
            )) === true;
          const retainsCurrentMutationLease = currentMutationLease !== null
            && clientId !== undefined
            && currentMutationLease.clientId === clientId
            && currentMutationLease.viewGeneration === selected.viewGeneration;
          const mutationLease = retainsCurrentMutationLease
            ? currentMutationLease
            : clientId === undefined
              ? null
              : !hasLiveMutationOwner
                ? manager.rotateTerminalAuthoritySuspendedBrowserMutationLease(change.sessionId, {
                    clientId,
                    viewGeneration: selected.viewGeneration,
                  })
                : null;
          if (mutationLease) {
            router.sendTerminalAuthorityFrameToConnection(selected.connectionId, {
              type: 'terminal-checkpoint:capability',
              protocolVersion: 1,
              accepted: true,
              authorityMode: 'checkpoint',
              checkpointDeliveryActive: true,
              ordinalEncoding: 'canonical-uint64-decimal',
              digestAlgorithms: ['sha256'],
              registeredViews: [{
                sessionId: change.sessionId,
                viewGeneration: selected.viewGeneration,
                queryReplyCapability: selected.queryReplyCapability,
                parserResponderCapability: selected.parserResponderCapability,
                authorityStreamEpoch: state.streamEpoch,
                driverLeaseGeneration: selected.driverLeaseGeneration,
                acceptedViewAttributesGeneration: selected.acceptedViewAttributesGeneration,
                viewAttributesChallengeId: runtime.pendingViewAttributesChallengeId,
              }],
              mutationLeases: [{
                sessionId: change.sessionId,
                authorityEpoch: mutationLease.authorityEpoch,
                viewGeneration: mutationLease.viewGeneration,
                leaseGeneration: mutationLease.leaseGeneration,
              }],
            }, 'control');
          }
          for (const view of currentViews) {
            const key = viewKey(view);
            if (runtime.pendingViewRecoveryKeys.has(key)) {
              scheduleFreshAuthoritativeViewRecovery({
                ...view,
                sessionId: change.sessionId,
              }, runtime, state.streamEpoch);
            }
          }
        }
        return;
      }
      if (state.mode === 'rolling-back') {
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'compatibility-topology-wake',
          kind: change.kind,
          sessionId: change.sessionId,
          connectionId: change.connectionId,
          viewGeneration: change.viewGeneration,
        });
        wakeCompatibilityTopologyRecovery(change.sessionId, runtime);
        return;
      }
      if (state.mode === 'aborted') {
        const currentViews = readViews(change.sessionId, runtime.legacyResponderLeaseId);
        const replaced = runtime.controller.replaceCompatibilityRecoveryViews(currentViews);
        if (!replaced.ok) return;
        runtime.frozenViews = currentViews.map(view => ({ ...view }));
        const resumed = runtime.controller.resumeAbortedPromotionRecovery(
          'responder-topology-changed-during-recovery',
        );
        if (!resumed.ok) return;
        if (currentViews.length > 0) {
          void rollbackSession(change.sessionId, true).catch(error => {
            appendTerminalAuthorityAudit(runtime.audit, {
              type: 'topology-recovery-rollback-failed',
              kind: error instanceof Error ? error.message : 'unknown-error',
              sessionId: change.sessionId,
            });
          });
        }
        return;
      }
      const transitionEpoch = state.transitionEpoch;
      if (!transitionEpoch) return;
      const controllerTopologyKind = change.kind === 'output-paired'
        || change.kind === 'output-unpaired'
        || change.kind === 'output-replaced'
        || change.kind === 'subscription-ready'
        ? 'generation-changed'
        : change.kind;
      void runtime.controller.notifyResponderTopologyChanged({
        transitionEpoch,
        ...change,
        kind: controllerTopologyKind,
      }).then(result => {
        if (!result.aborted) return;
        if (runtime.promotionDeadlineTimer) {
          clearTimeout(runtime.promotionDeadlineTimer);
          runtime.promotionDeadlineTimer = null;
        }
        for (const view of runtime.frozenViews) {
          router.sendTerminalAuthorityFrameToConnection(view.connectionId, {
            type: 'terminal-authority:promotion-aborted',
            sessionId: change.sessionId,
            transitionEpoch,
            reason: result.reason,
          }, 'terminal');
        }
        const currentViews = readViews(change.sessionId, runtime.legacyResponderLeaseId);
        const replaced = runtime.controller.replaceCompatibilityRecoveryViews(currentViews);
        if (!replaced.ok) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'promotion-topology-view-replacement-rejected',
            kind: replaced.reason,
            sessionId: change.sessionId,
          });
          return;
        }
        runtime.frozenViews = currentViews.map(view => ({ ...view }));
        const recovery = runtime.controller.resumeAbortedPromotionRecovery(result.reason);
        if (!recovery.ok) {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'promotion-topology-recovery-rejected',
            kind: recovery.reason,
            sessionId: change.sessionId,
          });
          return;
        }
        if (currentViews.length === 0) return;
        void rollbackSession(change.sessionId, true).then(rollback => {
          if (!rollback.ok) {
            appendTerminalAuthorityAudit(runtime.audit, {
              type: 'promotion-topology-rollback-rejected',
              kind: rollback.reason,
              sessionId: change.sessionId,
            });
          }
        }).catch(error => {
          appendTerminalAuthorityAudit(runtime.audit, {
            type: 'promotion-topology-rollback-failed',
            kind: error instanceof Error ? error.message : 'unknown-error',
            sessionId: change.sessionId,
          });
        });
      });
    },
  });

  const readWiringEvidence = (
    sessionId?: string,
  ): ProductionTerminalAuthorityWiringEvidence => {
    const selected = sessionId ? runtimes.get(sessionId)?.wiring : undefined;
    const wiring = selected ?? (sessionId
      ? undefined
      : [...runtimes.values()].reduce((total, runtime) => ({
        controllerFactoryCallCount: total.controllerFactoryCallCount
          + runtime.wiring.controllerFactoryCallCount,
        retainedCheckpointAdapterCallCount: total.retainedCheckpointAdapterCallCount
          + runtime.wiring.retainedCheckpointAdapterCallCount,
        checkpointDigestAdapterCallCount: total.checkpointDigestAdapterCallCount
          + runtime.wiring.checkpointDigestAdapterCallCount,
      }), {
        controllerFactoryCallCount: 0,
        retainedCheckpointAdapterCallCount: 0,
        checkpointDigestAdapterCallCount: 0,
      })) ?? {
      controllerFactoryCallCount: 0,
      retainedCheckpointAdapterCallCount: 0,
      checkpointDigestAdapterCallCount: 0,
    };
    return {
      source: 'production-default',
      sessionManagerBoundToRouter: true,
      controllerFactory: 'production-terminal-authority-controller',
      retainedCheckpointAdapter: 'session-manager-retained-terminal',
      checkpointDigestAdapter: 'sha256',
      ...wiring,
      injectedControllerFactory: false,
      injectedCheckpointAssembler: false,
    };
  };

  // @req MIG-BGSTAB-002 AC-5 AC-6
  const rollbackSession = async (
    input: string | {
      sessionId: string;
      selectedCompatibilityView: { connectionId: string; viewGeneration: number };
    },
    compatibilityRecoveryPrepared = false,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const sessionId = typeof input === 'string' ? input : input.sessionId;
    const runtime = runtimes.get(sessionId);
    if (!runtime) return { ok: false, reason: 'authority-runtime-unavailable' };
    const state = runtime.controller.getState();
    if (state.mode === 'legacy') return { ok: true, reason: 'authority-already-legacy' };
    if (state.mode === 'rolling-back' && !compatibilityRecoveryPrepared) {
      const restarted = runtime.controller.restartCompatibilityRecovery(
        'explicit-compatibility-recovery-resume',
      );
      if (!restarted.ok && restarted.reason !== 'compatibility-recovery-not-active') {
        return restarted;
      }
      const currentViews = readViews(sessionId, runtime.legacyResponderLeaseId);
      const replaced = runtime.controller.replaceCompatibilityRecoveryViews(currentViews);
      if (!replaced.ok) return replaced;
      runtime.frozenViews = currentViews.map(view => ({ ...view }));
    }
    if (state.mode === 'server' && typeof input === 'string') {
      const currentViews = readViews(
        sessionId,
        state.activeResponderLeaseId ?? runtime.legacyResponderLeaseId,
      );
      runtime.frozenViews = currentViews.map(view => ({ ...view }));
      if (currentViews.length > 0) {
        const replaced = runtime.controller.replaceServerAuthorityViews(currentViews);
        if (!replaced.ok) return replaced;
      }
    }
    const suspended = manager.getTerminalAuthoritySuspendedBrowserMutationLease(sessionId);
    const selectedCompatibilityView = typeof input === 'string'
      ? (
        suspended
          ? runtime.frozenViews.find(candidate => (
            candidate.clientId === suspended.clientId
              && candidate.viewGeneration === suspended.viewGeneration
          )) ?? runtime.frozenViews[0]
          : runtime.frozenViews[0]
      )
      : input.selectedCompatibilityView;
    const view = selectedCompatibilityView
      ? runtime.frozenViews.find(candidate => (
        candidate.connectionId === selectedCompatibilityView.connectionId
        && candidate.viewGeneration === selectedCompatibilityView.viewGeneration
      ))
      : undefined;
    if (!view) return { ok: false, reason: 'compatibility-view-unavailable' };
    if (!view.clientId) return { ok: false, reason: 'compatibility-view-client-unavailable' };
    const registration = manager.registerRetainedTerminalClientView(
      sessionId,
      view.clientId,
      view.viewGeneration,
    );
    if (!registration.ok) {
      return {
        ok: false,
        reason: `compatibility-view-registration-${registration.reason}`,
      };
    }
    const nextStreamEpoch = nextOrdinal(state.streamEpoch);
    const responderLeaseId = `responder-browser-${nextStreamEpoch}`;
    const driverLeaseId = `driver-browser-${nextStreamEpoch}`;
    cancelPendingCheckpointDeliveryPreparations(runtime);
    const result = await manager.beginTerminalAuthorityRollback(sessionId, {
      transitionEpoch: nextStreamEpoch,
      nextStreamEpoch,
      compatibilityCheckpointEpoch: checkpointEpochFor(nextStreamEpoch),
      nextCompatibilityResponderLeaseId: responderLeaseId,
      nextCompatibilityDriverLeaseId: driverLeaseId,
      nextCompatibilityDriverLeaseGeneration: nextStreamEpoch,
      nextAcceptedViewAttributesGeneration: nextStreamEpoch,
      selectedCompatibilityResponder: {
        ...view,
        responderLeaseId,
        driverLeaseId,
        driverLeaseGeneration: nextStreamEpoch,
        acceptedViewAttributesGeneration: nextStreamEpoch,
      },
    });
    if (!result.ok) return result;
    if (runtime.promotionDeadlineTimer) {
      clearTimeout(runtime.promotionDeadlineTimer);
      runtime.promotionDeadlineTimer = null;
    }
    const preparedTail = manager.takeTerminalAuthorityDebugRollbackPostBoundaryOutput?.(sessionId);
    if (preparedTail) {
      const accepted = await manager.injectTerminalAuthorityDebugRollbackPostBoundaryOutput?.(
        sessionId,
        preparedTail,
      );
      if (accepted !== true) {
        return { ok: false, reason: 'debug-rollback-post-boundary-output-injection-failed' };
      }
    }
    return result;
  };

  recoverAuthoritySendFailure = (sessionId, reason) => {
    const runtime = runtimes.get(sessionId);
    if (!runtime || runtime.disposed) return;
    appendTerminalAuthorityAudit(runtime.audit, {
      type: 'authority-send-recovery-scheduled',
      kind: reason,
      sessionId,
    });
    const existingSchedule = scheduledAuthorityRecoveries.get(sessionId);
    if (existingSchedule) {
      existingSchedule.pendingReason = reason;
      return;
    }
    const scheduleToken = Symbol('authority-recovery');
    const schedule = {
      token: scheduleToken,
      pendingReason: reason as string | null,
      rollingBackDeferralComplete: false,
    };
    scheduledAuthorityRecoveries.set(sessionId, schedule);
    const scheduledRuntime = runtime;
    const runScheduledRecovery = () => {
      if (runtimes.get(sessionId) !== scheduledRuntime || scheduledRuntime.disposed) {
        if (scheduledAuthorityRecoveries.get(sessionId) === schedule) {
          scheduledAuthorityRecoveries.delete(sessionId);
        }
        return;
      }
      const current = scheduledRuntime.controller.getState();
      if (current.mode === 'rolling-back' && !schedule.rollingBackDeferralComplete) {
        appendTerminalAuthorityAudit(scheduledRuntime.audit, {
          type: 'authority-send-recovery-awaiting-topology',
          kind: reason,
          sessionId,
        });
        schedule.rollingBackDeferralComplete = true;
        const retryDelayMs = 10;
        scheduledRuntime.authorityRecoveryRetryTimer = setTimeout(() => {
          scheduledRuntime.authorityRecoveryRetryTimer = null;
          if (runtimes.get(sessionId) !== scheduledRuntime
            || scheduledRuntime.disposed
            || scheduledAuthorityRecoveries.get(sessionId) !== schedule) {
            return;
          }
          runScheduledRecovery();
        }, retryDelayMs);
        scheduledRuntime.authorityRecoveryRetryTimer.unref?.();
        return;
      }
      const recoveryReason = schedule.pendingReason ?? reason;
      schedule.pendingReason = null;
      let recoverySucceeded = false;
      void rollbackSession(sessionId).then(result => {
        recoverySucceeded = result.ok;
        if (!result.ok) appendTerminalAuthorityAudit(runtime.audit, {
          type: 'authority-send-recovery-rejected',
          kind: result.reason,
          sessionId,
        });
      }).catch(error => {
        appendTerminalAuthorityAudit(runtime.audit, {
          type: 'authority-send-recovery-failed',
          kind: error instanceof Error ? error.message : 'unknown-error',
          sessionId,
        });
      }).finally(() => {
        if (runtimes.get(sessionId) === scheduledRuntime
          && scheduledAuthorityRecoveries.get(sessionId) === schedule) {
          const pendingReason = schedule.pendingReason;
          if (scheduledRuntime.disposed) {
            scheduledAuthorityRecoveries.delete(sessionId);
            scheduledRuntime.authorityRecoveryRetryAttempt = 0;
            return;
          }

          if (recoverySucceeded && !pendingReason) {
            scheduledAuthorityRecoveries.delete(sessionId);
            scheduledRuntime.authorityRecoveryRetryAttempt = 0;
            return;
          }

          const retryReason = pendingReason ?? recoveryReason;
          if (!recoverySucceeded && scheduledRuntime.authorityRecoveryRetryAttempt >= 1) {
            appendTerminalAuthorityAudit(scheduledRuntime.audit, {
              type: 'authority-send-recovery-awaiting-topology',
              kind: retryReason,
              sessionId,
            });
            scheduledAuthorityRecoveries.delete(sessionId);
            scheduledRuntime.authorityRecoveryRetryAttempt = 0;
            return;
          }

          schedule.pendingReason = null;
          const retryAttempt = recoverySucceeded
            ? 0
            : Math.min(scheduledRuntime.authorityRecoveryRetryAttempt + 1, 8);
          scheduledRuntime.authorityRecoveryRetryAttempt = retryAttempt;
          const retryDelayMs = recoverySucceeded
            ? 0
            : Math.min(10 * (2 ** (retryAttempt - 1)), 1_000);
          scheduledRuntime.authorityRecoveryRetryTimer = setTimeout(() => {
            scheduledRuntime.authorityRecoveryRetryTimer = null;
            if (runtimes.get(sessionId) !== scheduledRuntime
              || scheduledRuntime.disposed
              || scheduledAuthorityRecoveries.get(sessionId) !== schedule) {
              return;
            }
            if (!schedule.pendingReason) schedule.pendingReason = retryReason;
            runScheduledRecovery();
          }, retryDelayMs);
          scheduledRuntime.authorityRecoveryRetryTimer.unref?.();
        }
      });
    };
    queueMicrotask(runScheduledRecovery);
  };

  return {
    sessionManager,
    wsRouter,
    async beginPromotion(sessionId) {
      const runtime = runtimes.get(sessionId);
      if (!runtime) return { ok: false, reason: 'authority-runtime-unavailable' };
      const firstView = router.getTerminalAuthorityResponderViews(sessionId)[0];
      const context = firstView
        ? router.getTerminalAuthorityCanaryContext(firstView.connectionId)
          ?.subscribedSessions.find(candidate => candidate.sessionId === sessionId)
        : undefined;
      if (runtime.controller.getState().mode !== 'legacy') {
        return { ok: false, reason: 'server-derived-canary-mode-gate-failed' };
      }
      if (context?.allAttachedViewsCapable !== true) {
        return { ok: false, reason: 'server-derived-canary-capability-gate-failed' };
      }
      if (context.replayRepairIdle !== true) {
        return { ok: false, reason: 'server-derived-canary-replay-repair-gate-failed' };
      }
      runtime.limitedSessionSelected = true;
      const result = await promoteSession(sessionId);
      if (!result.ok) runtime.limitedSessionSelected = false;
      return result;
    },
    async beginRollback(
      input: string | {
        sessionId: string;
        selectedCompatibilityView: { connectionId: string; viewGeneration: number };
      },
      _reason?: string,
    ) {
      return rollbackSession(input);
    },
    getState(sessionId) {
      return runtimes.get(sessionId)?.controller.getState();
    },
    getAuthorityState(sessionId) {
      return runtimes.get(sessionId)?.controller.getState();
    },
    getAudit(sessionId) {
      return runtimes.get(sessionId)?.audit.map(event => ({ ...event })) ?? [];
    },
    getAuthorityAuditTrail(sessionId, limit) {
      const audit = runtimes.get(sessionId)?.audit ?? [];
      const selected = limit === undefined
        ? audit
        : limit <= 0
          ? []
          : audit.slice(-limit);
      return selected.map(event => ({ ...event }));
    },
    getWiring(sessionId) {
      return readWiringEvidence(sessionId);
    },
    getWiringEvidence(sessionId) {
      return readWiringEvidence(sessionId);
    },
    getAuthorityController(sessionId) {
      return runtimes.get(sessionId)?.controller;
    },
    getSessionSnapshot(sessionId) {
      const runtime = runtimes.get(sessionId);
      if (!runtime) return undefined;
      return {
        state: runtime.controller.getState(),
        audit: runtime.audit.map(event => ({ ...event })),
        wiring: readWiringEvidence(sessionId),
      };
    },
    getQueryResponderCapabilityState(sessionId) {
      return readQueryResponderCapabilityState(sessionId);
    },
    async requestQueryResponderCapabilityRefresh(sessionId) {
      const runtime = runtimes.get(sessionId);
      if (!runtime || runtime.controller.getState().mode !== 'legacy') return false;
      const previous = runtime.pendingViewAttributesHandshake;
      if (previous) settlePendingViewAttributesHandshake(runtime, previous, false);
      const challengeId = randomUUID();
      runtime.pendingViewAttributesChallengeId = challengeId;
      runtime.acceptedViewAttributesChallengeId = null;
      runtime.acceptedViewAttributesIdentity = null;
      let resolveHandshake!: (result: boolean) => void;
      const promise = new Promise<boolean>(resolve => { resolveHandshake = resolve; });
      let pending!: PendingViewAttributesHandshake;
      const deadlineAt = Date.now() + viewAttributesHandshakeTimeoutMs;
      const deadlineTimer = setTimeout(() => {
        settlePendingViewAttributesHandshake(runtime, pending, false);
      }, viewAttributesHandshakeTimeoutMs);
      deadlineTimer.unref?.();
      pending = {
        runtimeToken: runtime.runtimeToken,
        refreshEpoch: ++runtime.legacyRefreshEpoch,
        challengeId,
        connectionId: null,
        clientId: null,
        viewGeneration: null,
        streamEpoch: null,
        driverLeaseId: null,
        driverLeaseGeneration: null,
        viewAttributesGeneration: null,
        deadlineAt,
        deadlineTimer,
        promise,
        resolve: resolveHandshake,
        settled: false,
        capabilityInFlight: false,
        capabilityIssued: false,
        dirty: false,
        topologyReplacementIssued: false,
        replacementIdentityKeys: new Set(),
        topologyRetargetPending: false,
        retargetAnchorConnectionId: null,
        retargetAnchorClientId: null,
      };
      runtime.pendingViewAttributesHandshake = pending;
      void tryLegacyResponderViewRefresh(
        sessionId,
        runtime,
        challengeId,
        pending.refreshEpoch,
      );
      return promise;
    },
    async triggerTerminalAuthorityDebugFault(input) {
      const runtime = runtimes.get(input.sessionId);
      if (!runtime || runtime.frozenViews.length === 0) {
        return { accepted: false, reason: 'terminal-authority-debug-runtime-unavailable' };
      }
      const state = runtime.controller.getState();
      if (state.mode === 'promoting') {
        return {
          accepted: false,
          reason: 'terminal-authority-debug-fault-awaiting-real-disable-acks',
        };
      }
      if (state.mode !== 'server') {
        return { accepted: false, reason: 'terminal-authority-debug-fault-requires-server-mode' };
      }
      for (const view of runtime.frozenViews) {
        router.sendTerminalAuthorityFrameToConnection(view.connectionId, {
          type: 'terminal-authority:promotion-aborted',
          sessionId: input.sessionId,
          triggerId: input.triggerId,
          reason: input.faultPoint,
          authorityEpoch: state.authorityEpoch,
          transitionEpoch: state.transitionEpoch ?? state.streamEpoch,
          streamEpoch: state.streamEpoch,
          ptyPaused: false,
          hiddenDeliveryLossy: false,
          sessionStatus: state.sessionStatus,
        }, 'terminal');
      }
      runtime.debugFaultTriggerId = input.triggerId;
      const rollback = await rollbackSession({
        sessionId: input.sessionId,
        selectedCompatibilityView: {
          connectionId: runtime.frozenViews[0]!.connectionId,
          viewGeneration: runtime.frozenViews[0]!.viewGeneration,
        },
      });
      runtime.debugFaultTriggerId = null;
      const current = runtime.controller.getState();
      return {
        accepted: rollback.ok,
        ...(rollback.reason ? { reason: rollback.reason } : {}),
        triggerId: input.triggerId,
        ptyPaused: current.ptyPaused,
        hiddenDeliveryLossy: current.hiddenDeliveryLossy,
        sessionStatus: current.sessionStatus,
        authorityEpoch: current.authorityEpoch,
        transitionEpoch: current.transitionEpoch,
        streamEpoch: current.streamEpoch,
      };
    },
    destroy() {
      const disposalErrors: unknown[] = [];
      try {
        uninstallHooks();
      } catch (error) {
        disposalErrors.push(error);
      }
      try {
        uninstallSessionFinalizedListener();
      } catch (error) {
        disposalErrors.push(error);
      }
      for (const sessionId of [...runtimes.keys()]) {
        try {
          disposeRuntime(sessionId);
        } catch (error) {
          disposalErrors.push(error);
        }
      }
      try {
        if (!manager.clearTerminalAuthorityRuntimeFactory(terminalAuthorityRuntimeFactory)) {
          disposalErrors.push(new Error('terminal-authority-production-runtime-factory-clear-failed'));
        }
      } catch (error) {
        disposalErrors.push(error);
      }
      if (ownsInstances) {
        for (const session of manager.getAllSessions()) {
          try {
            manager.deleteSession(session.id);
          } catch (error) {
            disposalErrors.push(error);
          }
        }
        try {
          wsRouter.destroy();
        } catch (error) {
          disposalErrors.push(error);
        }
      }
      if (disposalErrors.length > 0) {
        throw new AggregateError(
          disposalErrors,
          'terminal-authority-production-integration-destroy-failed',
        );
      }
    },
  };
}
