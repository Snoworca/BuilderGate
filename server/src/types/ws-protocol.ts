/**
 * WebSocket Message Protocol Types
 * Shared type definitions for client-server WS communication.
 * Frontend has a copy at frontend/src/types/ws-protocol.ts
 */

// ============================================================================
// Client → Server Messages
// ============================================================================

export type InputReliabilityMode = 'observe' | 'queue' | 'strict';

// terminal-checkpoint-contract:start
export const TERMINAL_CHECKPOINT_PROTOCOL_VERSION = 1 as const;
export type TerminalCheckpointProtocolVersion = typeof TERMINAL_CHECKPOINT_PROTOCOL_VERSION;
export type Ordinal64 = string;

export interface TerminalCheckpointWireIdentity {
  protocolVersion: TerminalCheckpointProtocolVersion;
  sessionId: string;
  viewGeneration: number;
  streamEpoch: Ordinal64;
  checkpointEpoch: Ordinal64;
  sourceSeq: Ordinal64;
  snapshotSeq: Ordinal64;
  oldestRetainedSeq: Ordinal64;
  retentionPolicyId: string;
  connectionId?: string;
  transitionEpoch?: Ordinal64;
  authorityEpoch?: string;
  responderLeaseId?: string;
  boundarySourceSeq?: Ordinal64;
}

export interface TerminalCheckpointDigest {
  algorithm: 'sha256';
  hex: string;
}

export const TERMINAL_CHECKPOINT_BOOLEAN_MODES = [
  'applicationCursorKeysMode',
  'applicationKeypadMode',
  'bracketedPasteMode',
  'insertMode',
  'originMode',
  'reverseWraparoundMode',
  'sendFocusMode',
  'wraparoundMode',
] as const;
export type TerminalCheckpointBooleanMode = typeof TERMINAL_CHECKPOINT_BOOLEAN_MODES[number];

export interface TerminalCheckpointViewRegistration {
  sessionId: string;
  viewGeneration: number;
  queryReplyCapability?: 'terminal.query-reply-input.v1';
  parserResponderCapability?: 'terminal.parser-responder-disable.v1';
}

export interface TerminalCheckpointRegisteredView extends TerminalCheckpointViewRegistration {
  authorityStreamEpoch?: Ordinal64;
  driverLeaseGeneration?: Ordinal64;
  acceptedViewAttributesGeneration?: Ordinal64;
  viewAttributesChallengeId?: string;
}

export interface RetainedTerminalMutationLease {
  sessionId: string;
  authorityEpoch: string;
  viewGeneration: number;
  leaseGeneration: string;
}

export type RetainedTerminalWireMutationIdentity = Omit<RetainedTerminalMutationLease, 'sessionId'>;

export interface TerminalCheckpointEncodedPayload {
  encoding: 'base64';
  data: string;
  encodedBytes: number;
}

export interface TerminalCheckpointStartMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:start';
  sourceGeometry: { cols: number; rows: number };
  chunkCount: number;
  encodedByteTotal: number;
  digest: TerminalCheckpointDigest;
  modes: Readonly<Partial<Record<TerminalCheckpointBooleanMode, boolean>>>;
  parserTail: TerminalCheckpointEncodedPayload;
  contentDigest?: string;
  retainedStateDigest?: string;
  retainedActiveBuffer?: 'normal' | 'alternate';
  retainedCursor?: { x: number; y: number };
  retainedSavedCursor?: { buffer: 'normal'; x: number; y: number } | null;
}

export interface TerminalCheckpointChunkMessage extends TerminalCheckpointWireIdentity,
  TerminalCheckpointEncodedPayload {
  type: 'terminal-checkpoint:chunk';
  chunkIndex: number;
  chunkCount: number;
}

export interface TerminalCheckpointCommitMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:commit';
  chunkCount: number;
  encodedByteTotal: number;
  digest: TerminalCheckpointDigest;
  retainedStateDigest?: string;
}

export interface TerminalCheckpointOutputMessage extends TerminalCheckpointWireIdentity,
  TerminalCheckpointEncodedPayload {
  type: 'terminal-checkpoint:output';
}

export type TerminalCheckpointFailureReason =
  | 'stale-generation'
  | 'stale-epoch'
  | 'missing-chunk'
  | 'duplicate-chunk'
  | 'out-of-order-chunk'
  | 'byte-total-mismatch'
  | 'digest-mismatch'
  | 'timeout'
  | 'apply-failed'
  | 'drain-failed'
  | 'hold-overflow';

export interface TerminalCheckpointNegotiateMessage {
  type: 'terminal-checkpoint:negotiate';
  protocolVersion: TerminalCheckpointProtocolVersion;
  views?: readonly TerminalCheckpointViewRegistration[];
}

export interface TerminalCheckpointApplyAckMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:apply-ack';
  appliedThroughSeq: Ordinal64;
}

export interface TerminalCheckpointDrainAckMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:drain-ack';
  drainedThroughSeq: Ordinal64;
}

export interface TerminalCheckpointFailureAckMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:failure-ack';
  reason: TerminalCheckpointFailureReason;
  lastAppliedSeq?: Ordinal64;
}

export interface TerminalCheckpointRecoveryRequestMessage {
  type: 'terminal-checkpoint:recovery-request';
  protocolVersion: TerminalCheckpointProtocolVersion;
  sessionId: string;
  failedViewGeneration: number;
  requestedViewGeneration: number;
  reason: TerminalCheckpointFailureReason;
  failedStreamEpoch?: Ordinal64;
  failedCheckpointEpoch?: Ordinal64;
}

export interface TerminalCheckpointReadyMessage {
  type: 'terminal-checkpoint:ready';
  protocolVersion: TerminalCheckpointProtocolVersion;
  sessionId: string;
  viewGeneration: number;
  authorityEpoch: string;
  streamEpoch: Ordinal64;
  driverLeaseGeneration: Ordinal64;
  acceptedViewAttributesGeneration: Ordinal64;
  viewAttributesChallengeId: string;
  checkpointDeliveryId: string;
}

/**
 * Client continuity is only a claim. The server compares it with its issued
 * retained-state record before permitting a stream rebind.
 */
export interface TerminalCheckpointContinuityRecord {
  sessionId?: string;
  viewGeneration?: number;
  visibilityGeneration?: Ordinal64;
  lastDeliveredSeq?: Ordinal64;
  streamEpoch?: Ordinal64;
  checkpointEpoch?: Ordinal64;
  snapshotSeq?: Ordinal64;
  oldestRetainedSeq?: Ordinal64;
  retentionPolicyId: string;
  expiresAt: number;
}

export interface TerminalCheckpointContinuityRebindMessage {
  type: 'terminal-checkpoint:continuity-rebind';
  protocolVersion: TerminalCheckpointProtocolVersion;
  sessionId: string;
  viewGeneration: number;
  visibilityGeneration: Ordinal64;
  lastDeliveredSeq: Ordinal64;
  streamEpoch?: Ordinal64;
  checkpointEpoch?: Ordinal64;
  snapshotSeq?: Ordinal64;
  oldestRetainedSeq?: Ordinal64;
  retentionPolicyId?: string;
  continuityRecord: TerminalCheckpointContinuityRecord;
}

export interface TerminalCheckpointDeliveryPreparation {
  checkpointDeliveryId: string;
  authorityEpoch: string;
  streamEpoch: Ordinal64;
  viewGeneration: number;
  driverLeaseGeneration: Ordinal64;
  acceptedViewAttributesGeneration: Ordinal64;
  viewAttributesChallengeId: string;
}

export type TerminalCheckpointClientMessage =
  | TerminalCheckpointNegotiateMessage
  | TerminalCheckpointApplyAckMessage
  | TerminalCheckpointDrainAckMessage
  | TerminalCheckpointFailureAckMessage
  | TerminalCheckpointRecoveryRequestMessage
  | TerminalCheckpointReadyMessage
  | TerminalCheckpointContinuityRebindMessage;

export interface TerminalCheckpointCapabilityMessage {
  type: 'terminal-checkpoint:capability';
  protocolVersion: TerminalCheckpointProtocolVersion;
  accepted: true;
  authorityMode: 'legacy' | 'checkpoint';
  checkpointDeliveryActive: boolean;
  checkpointDeliveryPreparation?: TerminalCheckpointDeliveryPreparation;
  compatibilityRecoveryRole?: 'selected-responder' | 'passive-snapshot';
  ordinalEncoding: 'canonical-uint64-decimal';
  digestAlgorithms: readonly ['sha256'];
  registeredViews?: readonly TerminalCheckpointRegisteredView[];
  mutationLeases?: readonly RetainedTerminalMutationLease[];
}

export type TerminalCheckpointRejectedReason =
  | 'unsupported-version'
  | 'invalid-message'
  | 'capability-not-negotiated'
  | 'checkpoint-not-active';

export interface TerminalCheckpointAckRejectionIdentity {
  sessionId: string;
  connectionId?: string;
  viewGeneration: number;
  streamEpoch: Ordinal64;
  checkpointEpoch: Ordinal64;
}

export interface TerminalCheckpointRejectedMessage {
  type: 'terminal-checkpoint:rejected';
  supportedProtocolVersion: TerminalCheckpointProtocolVersion;
  phase: 'negotiate' | 'ack';
  reason: TerminalCheckpointRejectedReason;
  sessionId?: string;
  ackIdentity?: TerminalCheckpointAckRejectionIdentity;
  rejectedMessageType?: 'resize';
}

export type TerminalCheckpointServerMessage =
  | TerminalCheckpointCapabilityMessage
  | TerminalCheckpointRejectedMessage
  | TerminalCheckpointStartMessage
  | TerminalCheckpointChunkMessage
  | TerminalCheckpointCommitMessage
  | TerminalCheckpointOutputMessage
  | {
      type: 'terminal-checkpoint:continuity-rebound';
      sessionId: string;
      viewGeneration: number;
      visibilityGeneration: Ordinal64;
      streamEpoch: Ordinal64;
      checkpointEpoch: Ordinal64;
      lastDeliveredSeq: Ordinal64;
    }
  | {
      type: 'terminal-checkpoint:fresh-checkpoint-required';
      sessionId: string;
      reason: 'continuity-expired' | 'continuity-identity-mismatch' | 'authority-unavailable';
      checkpointAuthority?: 'server-full-retained-state';
      fullCheckpoint?: {
        streamEpoch: Ordinal64;
        checkpointEpoch: Ordinal64;
        snapshotSeq: Ordinal64;
        oldestRetainedSeq: Ordinal64;
        retentionPolicyId: string;
        geometry: { cols: number; rows: number };
        modes: Readonly<Partial<Record<TerminalCheckpointBooleanMode, boolean>>>;
        chunks: readonly (TerminalCheckpointEncodedPayload & {
          sequence: number;
          chunkIndex: number;
          chunkCount: number;
        })[];
        digest: TerminalCheckpointDigest;
        parserTail: TerminalCheckpointEncodedPayload;
        tailOnly: false;
      };
    };

export type TerminalCheckpointValidationResult<T> =
  | { ok: true; message: T }
  | { ok: false; reason: 'not-checkpoint-message' | 'unsupported-version' | 'invalid-message' };
// terminal-checkpoint-contract:end

export type TerminalViewRgb = readonly [number, number, number];

export interface TerminalViewAttributes {
  foreground: TerminalViewRgb;
  background: TerminalViewRgb;
  cursor: TerminalViewRgb;
  ansi: readonly TerminalViewRgb[];
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  colorSchemeMode: 'dark' | 'light';
}

export type SessionCleanupReason =
  | 'direct-session-delete'
  | 'tab-delete'
  | 'workspace-delete'
  | 'tab-restart'
  | 'process-exit'
  | 'shutdown';

export type SessionCleanupStatus =
  | 'observed'
  | 'completed'
  | 'degraded'
  | 'failed'
  | 'skipped-unverified'
  | 'not-started';

export type SessionProcessBackend = 'conpty' | 'winpty' | 'wsl' | 'unix' | 'unknown';

export interface SessionProcessMetadata {
  rootPid: number | null;
  shellCommand: string;
  shellArgs: string[];
  shellType: string;
  cwd: string;
  platform: NodeJS.Platform;
  backend: SessionProcessBackend;
  launchedAt: string;
  osStartIdentity: string | null;
}

export interface SessionCleanupTelemetryResult {
  sessionId: string;
  reason: SessionCleanupReason;
  rootPid: number | null;
  remainingDescendants: number;
  verifiedRemainingDescendants?: number;
  unverifiedRemainingDescendants?: number;
  cleanupStatus: SessionCleanupStatus;
  recordedAt: string;
}

export interface SessionCleanupTelemetry {
  mode: 'legacy' | 'observe' | 'enforce';
  attempted: number;
  completed: number;
  degraded: number;
  unverifiedSkipped: number;
  identityCaptureSucceeded: number;
  identityCaptureRetried: number;
  identityCaptureFailed: number;
  recentResults: SessionCleanupTelemetryResult[];
}

export type TerminalInputBarrierReason =
  | 'none'
  | 'checkpoint-pending'
  | 'restore-pending'
  | 'replay-pending'
  | 'initial-geometry-pending'
  | 'repair-server-not-ready'
  | 'ws-reconnecting-short'
  | 'client-backpressure'
  | 'visible-output-recovery';

export type TerminalInputClosedReason =
  | 'none'
  | 'terminal-hidden'
  | 'terminal-disposed'
  | 'session-exited'
  | 'session-missing'
  | 'server-error'
  | 'auth-expired'
  | 'workspace-or-session-changed'
  | 'ws-closed-without-reconnect';

export type ReconnectState = 'connected' | 'reconnecting' | 'disconnected';

export interface TerminalInputTransportState {
  serverReady: boolean;
  barrierReason: TerminalInputBarrierReason;
  closedReason: TerminalInputClosedReason;
  reconnectState?: ReconnectState;
  sessionGeneration: number;
}

export type TerminalInputTransportOverride = Partial<TerminalInputTransportState>;

export interface InputDebugMetadata {
  captureSeq?: number;
  compositionSeq?: number;
  clientObservedByteLength?: number;
  clientObservedCodePointCount?: number;
  clientObservedGraphemeCount?: number;
  clientObservedGraphemeApproximate?: boolean;
  clientObservedHasHangul?: boolean;
  clientObservedHasCjk?: boolean;
  clientObservedHasEnter?: boolean;
  clientObservedMetricsSkipped?: boolean;
}

export type InputRejectedReason =
  | 'timeout'
  | 'timeout-enter-safety'
  | 'queue-overflow'
  | 'context-changed'
  | 'session-missing'
  | 'session-closed'
  | 'server-error'
  | 'auth-expired'
  | 'transport-closed'
  | 'invalid-sequence'
  | 'invalid-payload'
  | 'mode-observe-only';

export interface TerminalDeliveryAckMessage {
  type: 'terminal-delivery:ack';
  sessionId: string;
  connectionEpoch: string;
  deliverySeq: number;
}

export interface TerminalDeliveryCapabilityMessage {
  type: 'terminal-delivery:capability';
  protocolVersion: 1;
  enabled?: boolean;
  supportsHiddenDataGapRecovery?: boolean;
}

export interface TerminalDeliveryVisibilityMessage {
  type: 'terminal-delivery:visibility';
  sessionId: string;
  visibilityGeneration: Ordinal64;
  isVisible: boolean;
  deliveryInterestRefCount?: number;
}

export interface TerminalDeliveryDataGapMessage {
  type: 'terminal-delivery:data-gap';
  sessionId: string;
  connectionId: string;
  viewGeneration: number;
  visibilityGeneration: Ordinal64;
  lastDeliveredSeq: Ordinal64;
  streamEpoch: Ordinal64;
  checkpointEpoch: Ordinal64;
  snapshotSeq: Ordinal64;
  oldestRetainedSeq: Ordinal64;
  retentionPolicyId: string;
  continuityAuthority: 'server-issued';
  deliveryInterestRefCount: number;
  authoritativeModelCommitted: true;
  terminalFactsCommitted: true;
}

export function parseTerminalDeliveryCapabilityMessage(value: unknown):
  | { ok: true; message: TerminalDeliveryCapabilityMessage }
  | { ok: false; reason: string } {
  if (!isProtocolRecord(value)) return { ok: false, reason: 'invalid-message' };
  if (value.type !== 'terminal-delivery:capability' || value.protocolVersion !== 1) {
    return { ok: false, reason: 'invalid-capability' };
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return { ok: false, reason: 'invalid-capability' };
  }
  if (value.supportsHiddenDataGapRecovery !== undefined
    && typeof value.supportsHiddenDataGapRecovery !== 'boolean') {
    return { ok: false, reason: 'invalid-capability' };
  }
  return { ok: true, message: value as unknown as TerminalDeliveryCapabilityMessage };
}

export function parseTerminalDeliveryAckMessage(value: unknown):
  | { ok: true; message: TerminalDeliveryAckMessage }
  | { ok: false; reason: string } {
  if (!isProtocolRecord(value)) return { ok: false, reason: 'invalid-message' };
  if (value.type !== 'terminal-delivery:ack') return { ok: false, reason: 'invalid-message-type' };
  if (!isNonEmptyProtocolString(value.sessionId) || !isNonEmptyProtocolString(value.connectionEpoch)) {
    return { ok: false, reason: 'invalid-identity' };
  }
  if (typeof value.deliverySeq !== 'number' || !Number.isSafeInteger(value.deliverySeq) || value.deliverySeq < 1) {
    return { ok: false, reason: 'invalid-delivery-seq' };
  }
  return { ok: true, message: value as unknown as TerminalDeliveryAckMessage };
}

export function parseTerminalDeliveryVisibilityMessage(value: unknown):
  | { ok: true; message: TerminalDeliveryVisibilityMessage }
  | { ok: false; reason: string } {
  if (!isProtocolRecord(value) || value.type !== 'terminal-delivery:visibility') {
    return { ok: false, reason: 'invalid-message' };
  }
  if (!isNonEmptyProtocolString(value.sessionId)
    || !isCanonicalOrdinal64(value.visibilityGeneration)
    || typeof value.isVisible !== 'boolean'
    || (value.deliveryInterestRefCount !== undefined
      && (!isNonNegativeSafeInteger(value.deliveryInterestRefCount)
        || value.deliveryInterestRefCount < 1))) {
    return { ok: false, reason: 'invalid-visibility' };
  }
  return { ok: true, message: value as unknown as TerminalDeliveryVisibilityMessage };
}

export type ClientWsMessage =
  | { type: 'subscribe';   sessionIds: string[] }
  | { type: 'unsubscribe'; sessionIds: string[] }
  | { type: 'screen-snapshot:ready'; sessionId: string; replayToken: string; snapshotSeq?: number }
  | ScreenRepairRequestMessage
  | ScreenRepairReadyMessage
  | ScreenRepairFailedMessage
  | {
      type: 'input';
      sessionId: string;
      data: string;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      metadata?: InputDebugMetadata;
      retainedIdentity?: RetainedTerminalWireMutationIdentity;
    }
  | {
      type: 'repair-replay';
      sessionId: string;
      supersedeReplayToken?: string;
      repairToken?: string;
    }
  | {
      type: 'resize';
      sessionId: string;
      cols: number;
      rows: number;
      retainedIdentity?: RetainedTerminalWireMutationIdentity;
    }
  | TerminalCheckpointClientMessage
  | TerminalDeliveryAckMessage
  | TerminalDeliveryCapabilityMessage
  | TerminalDeliveryVisibilityMessage
  | { type: 'ping' };

// ============================================================================
// Server → Client Messages
// ============================================================================

export type ScreenSnapshotMode = 'authoritative' | 'fallback';
export type ScreenSnapshotSource = 'headless';
export type WindowsPtyBackend = 'conpty' | 'winpty';
export type ScreenRepairReason = 'manual' | 'workspace' | 'resize';
export type ScreenRepairBufferType = 'normal' | 'alternate';
export type ScreenRepairFailedReason =
  | 'not-ready'
  | 'ime-active'
  | 'input-active'
  | 'user-scrolled'
  | 'geometry-mismatch'
  | 'buffer-mismatch'
  | 'write-failed'
  | 'parse-failed';
export type ScreenRepairRejectedReason =
  | 'not-subscribed'
  | 'pending'
  | 'geometry-mismatch'
  | 'buffer-mismatch'
  | 'headless-degraded'
  | 'generation-failed'
  | 'apply-rejected';

export interface WindowsPtyInfo {
  backend: WindowsPtyBackend;
  buildNumber?: number;
}

export type FallbackDataState =
  | 'recoverable-buffer'
  | 'empty-no-recoverable-data'
  | 'withheld';

export interface ScreenSnapshotMessage {
  type: 'screen-snapshot';
  sessionId: string;
  replayToken: string;
  seq: number;
  cols: number;
  rows: number;
  mode: ScreenSnapshotMode;
  data: string;
  truncated: boolean;
  source: ScreenSnapshotSource;
  fallbackDataState?: FallbackDataState;
  fallbackDataBytes?: number;
  windowsPty?: WindowsPtyInfo;
  authorityEpoch?: string;
  authorityRevision?: number;
  coversThroughSeq?: number;
  supersedesReplayToken?: string;
  parserComplete?: boolean;
  pendingEscapeTailAnsi?: string;
}

export interface ScreenRepairRequestMessage {
  type: 'screen-repair';
  sessionId: string;
  cols: number;
  rows: number;
  reason: ScreenRepairReason;
  clientAtBottom: boolean;
  clientBufferType: ScreenRepairBufferType;
}

export interface ScreenRepairReadyMessage {
  type: 'screen-repair:ready';
  sessionId: string;
  repairToken: string;
}

export interface ScreenRepairFailedMessage {
  type: 'screen-repair:failed';
  sessionId: string;
  repairToken: string;
  reason: ScreenRepairFailedReason;
}

export interface ScreenRepairRowPatch {
  y: number;
  ansi: string;
  text: string;
  wrapped: boolean;
}

export interface ScreenRepairMessage {
  type: 'screen-repair';
  sessionId: string;
  repairToken: string;
  seq: number;
  cols: number;
  rows: number;
  bufferType: ScreenRepairBufferType;
  cursor: { x: number; y: number; hidden?: boolean };
  viewportRows: ScreenRepairRowPatch[];
  ansiPatch: string;
  source: 'headless';
}

export interface ScreenRepairRejectedMessage {
  type: 'screen-repair:rejected';
  sessionId: string;
  repairToken?: string;
  reason: ScreenRepairRejectedReason;
  cols?: number;
  rows?: number;
}

export type ScreenRepairRecoveryReason =
  | ScreenRepairFailedReason
  | 'delivery-recovery'
  | 'byte-cap-exceeded'
  | 'chunk-cap-exceeded'
  | 'ack-timeout'
  | 'generation-failed'
  | 'headless-degraded'
  | 'authority-unavailable';

export interface ScreenRepairRestoreNeededMessage {
  type: 'screen-repair:restore-needed';
  sessionId: string;
  repairToken: string;
  state: 'stale';
  reason: ScreenRepairRecoveryReason;
  outcome: 'fresh-snapshot-started';
  replayToken: string;
  snapshotSeq: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  coversThroughSeq?: number;
  supersedesReplayToken?: string;
}

export interface ScreenRepairReconnectRequiredMessage {
  type: 'screen-repair:reconnect-required';
  sessionId: string;
  repairToken: string;
  reason: ScreenRepairRecoveryReason;
  outcome: 'authority-unavailable' | 'reconnect-required';
}

export type ServerWsMessage =
  // Session events
  | ScreenSnapshotMessage
  | ScreenRepairMessage
  | ScreenRepairRejectedMessage
  | ScreenRepairRestoreNeededMessage
  | ScreenRepairReconnectRequiredMessage
  | TerminalCheckpointServerMessage
  | {
      type: 'output';
      sessionId: string;
      data: string;
      replayToken?: string;
      repairToken?: string;
      screenSeq?: number;
      authorityEpoch?: string;
      authorityRevision?: number;
      chunkId?: string;
      sourceSegments?: Array<{
        byteStart: number;
        byteEnd: number;
        screenSeq?: number;
        authorityEpoch?: string;
        authorityRevision?: number;
        chunkId: string;
      }>;
      connectionEpoch?: string;
      deliverySeq?: number;
      deliveryKind?: 'output' | 'dataGap' | 'checkpoint' | 'readyBarrier' | 'control';
    }
  | { type: 'status';         sessionId: string; status: 'running' | 'idle' }
  | {
      type: 'session:ready';
      sessionId: string;
      replayToken?: string;
      repairToken?: string;
      snapshotSeq?: number;
    }
  | {
      type: 'terminal-delivery:capability';
      protocolVersion: 1;
      accepted: boolean;
      connectionEpoch: string;
      reason?: string;
    }
  | TerminalDeliveryDataGapMessage
  | {
      type: 'terminal-delivery:checkpoint-ledger-settled';
      sessionId: string;
      checkpointEpoch: Ordinal64;
      settledThroughSeq: number;
      queued: number;
      inFlight: number;
      late: number;
      invalidated: number;
    }
  | {
      type: 'terminal-delivery:ack-rejected';
      sessionId: string;
      connectionEpoch: string;
      deliverySeq: number;
      reason: string;
    }
  | {
      type: 'input:rejected';
      sessionId: string;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      reason: InputRejectedReason;
    }
  | { type: 'cwd';            sessionId: string; cwd: string }
  | { type: 'session:error';  sessionId: string; message: string }
  | { type: 'session:exited'; sessionId: string; exitCode: number }
  // Subscribe response
  | { type: 'subscribed';     sessions: SubscribedSessionInfo[] }
  // Workspace events
  | { type: 'workspace:created';   data: unknown }
  | { type: 'workspace:updated';   data: unknown }
  | { type: 'workspace:deleted';   data: unknown }
  | { type: 'workspace:deleting';  data: unknown }
  | { type: 'workspace:reordered'; data: unknown }
  // Tab events
  | { type: 'tab:added';        data: unknown }
  | { type: 'tab:updated';      data: unknown }
  | { type: 'tab:removed';      data: unknown }
  | { type: 'tab:moved';        data: unknown }
  | { type: 'tab:reordered';    data: unknown }
  | { type: 'tab:disconnected'; data: unknown }
  // Grid events
  | { type: 'grid:updated'; data: unknown }
  // Connection events
  | { type: 'connected'; clientId: string }
  | { type: 'pong' };

export interface SubscribedSessionInfo {
  sessionId: string;
  status: string;
  cwd?: string;
  ready: boolean;
  // Binary data plane (`01:374-385`). Optional so a JSON-only group shares the
  // schema. Nothing populates them yet: emitting them needs the channel
  // allocator, which is the server encode surface (S4-a).
  /** uint32. Present only in a group that negotiated binary. */
  channelId?: number;
  /** The channel's current `streamEpoch`, as a reference rather than a snapshot. */
  streamEpoch?: string;
  /**
   * The session's `authorityEpoch` UUID.
   *
   * Added by revision R3 (`01:350`). The frame carries this only as a uint16
   * channel-local alias, and neither message `01` nominated for the mapping
   * actually carried the UUID — so a client following `01` literally could
   * never populate the channel table `08:192` requires, and every frame would
   * be refused as `unknown-channel`.
   */
  authorityEpoch?: string;
}

// ============================================================================
// Client metadata (server-side only)
// ============================================================================

export interface WsClientMeta {
  clientId: string;
  connectionId?: string;
  clientGroupId?: string;
  channelRole?: 'control' | 'output';
  wsTransportMode?: 'unified' | 'split-shadow' | 'split';
  isAlive: boolean;
  subscribedSessions: Set<string>;
  replayPendingSessions: Map<string, ReplayPendingState>;
  screenRepairPendingSessions: Map<string, ScreenRepairPendingState>;
  terminalCheckpointProtocolVersion?: TerminalCheckpointProtocolVersion;
  retainedTerminalViews?: Map<string, number>;
  retainedTerminalMutationLeases?: Map<string, RetainedTerminalWireMutationIdentity>;
  terminalAuthorityViewRegistrations?: Map<string, TerminalCheckpointRegisteredView>;
  terminalAuthorityRecoveryEvidence?: Map<string, TerminalAuthorityRecoveryEvidence>;
}

export interface TerminalAuthorityRecoveryEvidence {
  replayToken: string;
  snapshotSeq: number;
  snapshotMode: 'authoritative' | 'fallback';
  snapshotTruncated: boolean;
  queuedOutputBytes: number;
  queuedOutputTruncated: boolean;
}

export interface ReplayPendingState {
  /** Snapshot authority is still being acquired; no snapshot token was sent. */
  authorityPending?: boolean;
  supersedesReplayToken?: string;
  queuedOutput: string;
  coveredQueuedOutput: string;
  queuedOutputChunks: ScreenRepairQueuedOutput[];
  coveredQueuedOutputChunks: ScreenRepairQueuedOutput[];
  queuedOutputBytes: number;
  coveredQueuedOutputBytes: number;
  coveredQueuedOutputRetainedBytes: number;
  preserveOutputChunkIdentity: boolean;
  queuedOutputTruncated: boolean;
  queuedOutputMaxScreenSeq: number | null;
  coveredQueuedOutputMaxScreenSeq: number | null;
  queuedInputs: QueuedReplayInput[];
  queuedInputBytes: number;
  timer: NodeJS.Timeout;
  replayToken: string;
  snapshotSeq: number;
  snapshotMode: 'authoritative' | 'fallback';
  snapshotDataLength: number;
  snapshotTruncated: boolean;
  snapshotCols: number;
  snapshotRows: number;
  recoveryRepairToken?: string;
}

export interface QueuedReplayInput {
  data: string;
  metadata?: InputDebugMetadata;
  inputSeqStart?: number;
  inputSeqEnd?: number;
  retainedIdentity?: RetainedTerminalWireMutationIdentity;
  queuedAt: number;
  byteLength: number;
}

export interface ScreenRepairPendingState {
  queuedOutputBytes: number;
  queuedOutputChunks: ScreenRepairQueuedOutput[];
  timer?: NodeJS.Timeout;
  repairToken: string;
  screenSeq: number;
}

export interface ScreenRepairQueuedOutput {
  data: string;
  byteLength: number;
  screenSeq?: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  chunkId?: string;
}

export type ReplayTelemetryValue = string | number | boolean | null;

export type ReplayEventKind =
  | 'resize_requested'
  | 'resize_skipped'
  | 'snapshot_sent'
  | 'snapshot_refreshed'
  | 'snapshot_refresh_skipped'
  | 'ack_ok'
  | 'ack_stale'
  | 'input_blocked'
  | 'replay_input_would_queue'
  | 'replay_input_would_reject'
  | 'input_queued'
  | 'input_queue_overflow'
  | 'input_rejected'
  | 'input_flushed'
  | 'input_flushed_timeout'
  | 'output_queued'
  | 'output_covered_by_snapshot'
  | 'output_flushed'
  | 'ready_sent'
  | 'screen_repair_requested'
  | 'screen_repair_sent'
  | 'screen_repair_rejected'
  | 'screen_repair_ack_ok'
  | 'screen_repair_ack_stale'
  | 'screen_repair_failed'
  | 'screen_repair_ack_timeout'
  | 'screen_repair_output_queued'
  | 'screen_repair_output_flushed'
  | 'screen_repair_queue_overflow'
  | 'screen_repair_restore_needed'
  | 'screen_repair_reconnect_required';

export interface ReplayTelemetryEventInput {
  kind: ReplayEventKind;
  sessionId: string;
  replayToken?: string;
  repairToken?: string;
  snapshotSeq?: number;
  details?: Record<string, ReplayTelemetryValue>;
}

export interface ReplayTelemetryEvent extends ReplayTelemetryEventInput {
  eventId: number;
  recordedAt: string;
}

export interface WsRouterObservabilitySnapshot {
  connectedClients: number;
  subscribedSessionCount: number;
  replayPendingCount: number;
  screenRepairPendingCount: number;
  replayAckTimeoutCount: number;
  screenRepairAckTimeoutCount: number;
  replayRefreshCount: number;
  maxReplayQueueLengthObserved: number;
  transportQueuedClientCount: number;
  transportOutputQueuedBytes: number;
  transportControlQueuedBytes: number;
  maxTransportQueuedBytesObserved: number;
  maxServerBufferedAmountObserved: number;
  transportBackpressureObserveCount: number;
  transportSlowClientCloseCount: number;
  transportQueueOverflowCount: number;
  transportSendErrorCount: number;
  /** Frames the server could not decode (`06 §S3`); must be 0 to open the shadow rung. */
  undecodableFrameCount: number;
  transportOutputCoalesceCount: number;
  recentReplayEvents: ReplayTelemetryEvent[];
}

const ORDINAL64_MAX = 18_446_744_073_709_551_615n;
const ORDINAL64_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// @req REL-BGSTAB-007 AC-4
export function isCanonicalOrdinal64(value: unknown): value is Ordinal64 {
  return typeof value === 'string'
    && value.length <= 20
    && ORDINAL64_PATTERN.test(value)
    && BigInt(value) <= ORDINAL64_MAX;
}

function ordinalValue(value: Ordinal64): bigint {
  return BigInt(value);
}

// @req REL-BGSTAB-011 AC-1
// @req REL-BGSTAB-007 AC-4
export function advanceRetainedTerminalOrdinal(input: {
  streamEpoch: Ordinal64;
  sourceSeq: Ordinal64;
}): { streamEpoch: Ordinal64; sourceSeq: Ordinal64; rolledOver: boolean } {
  if (!isCanonicalOrdinal64(input?.streamEpoch) || !isCanonicalOrdinal64(input?.sourceSeq)) {
    throw new RangeError('Retained terminal ordinals must be canonical uint64 decimal strings');
  }

  const sourceSeq = ordinalValue(input.sourceSeq);
  if (sourceSeq < ORDINAL64_MAX) {
    return {
      streamEpoch: input.streamEpoch,
      sourceSeq: String(sourceSeq + 1n),
      rolledOver: false,
    };
  }

  const streamEpoch = ordinalValue(input.streamEpoch);
  if (streamEpoch === ORDINAL64_MAX) {
    throw new RangeError('Retained terminal ordinal space is exhausted');
  }

  return {
    streamEpoch: String(streamEpoch + 1n),
    sourceSeq: '0',
    rolledOver: true,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyProtocolString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCheckpointViewRegistrations(
  value: unknown,
): value is readonly TerminalCheckpointViewRegistration[] {
  if (!Array.isArray(value)) return false;
  const sessionIds = new Set<string>();
  return value.every((entry) => {
    if (
      !isProtocolRecord(entry)
      || !isNonEmptyProtocolString(entry.sessionId)
      || !isNonNegativeSafeInteger(entry.viewGeneration)
      || (entry.queryReplyCapability !== undefined
        && entry.queryReplyCapability !== 'terminal.query-reply-input.v1')
      || (entry.parserResponderCapability !== undefined
        && entry.parserResponderCapability !== 'terminal.parser-responder-disable.v1')
      || Object.prototype.hasOwnProperty.call(entry, 'authorityStreamEpoch')
      || Object.prototype.hasOwnProperty.call(entry, 'driverLeaseGeneration')
      || Object.prototype.hasOwnProperty.call(entry, 'acceptedViewAttributesGeneration')
      || Object.prototype.hasOwnProperty.call(entry, 'viewAttributesChallengeId')
      || sessionIds.has(entry.sessionId)
    ) {
      return false;
    }
    sessionIds.add(entry.sessionId);
    return true;
  });
}

function isTerminalCheckpointFailureReason(value: unknown): value is TerminalCheckpointFailureReason {
  const reasons: readonly TerminalCheckpointFailureReason[] = [
    'stale-generation', 'stale-epoch', 'missing-chunk', 'duplicate-chunk',
    'out-of-order-chunk', 'byte-total-mismatch', 'digest-mismatch', 'timeout',
    'apply-failed', 'drain-failed', 'hold-overflow',
  ];
  return reasons.includes(value as TerminalCheckpointFailureReason);
}

function isCheckpointIdentity(value: Record<string, unknown>): value is Record<string, unknown> & TerminalCheckpointWireIdentity {
  return value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
    && isNonEmptyProtocolString(value.sessionId)
    && isNonNegativeSafeInteger(value.viewGeneration)
    && isCanonicalOrdinal64(value.streamEpoch)
    && isCanonicalOrdinal64(value.checkpointEpoch)
    && isCanonicalOrdinal64(value.sourceSeq)
    && isCanonicalOrdinal64(value.snapshotSeq)
    && isCanonicalOrdinal64(value.oldestRetainedSeq)
    && ordinalValue(value.sourceSeq) >= ordinalValue(value.snapshotSeq)
    && ordinalValue(value.oldestRetainedSeq) <= ordinalValue(value.snapshotSeq)
    && isNonEmptyProtocolString(value.retentionPolicyId)
    && isNonEmptyProtocolString(value.connectionId)
    && (value.transitionEpoch === undefined || isCanonicalOrdinal64(value.transitionEpoch))
    && (value.authorityEpoch === undefined || isNonEmptyProtocolString(value.authorityEpoch))
    && (value.responderLeaseId === undefined || isNonEmptyProtocolString(value.responderLeaseId))
    && (value.boundarySourceSeq === undefined || isCanonicalOrdinal64(value.boundarySourceSeq));
}

function isOptionalCanonicalOrdinal64(value: unknown): boolean {
  return value === undefined || isCanonicalOrdinal64(value);
}

function isTerminalCheckpointContinuityRecord(value: unknown): boolean {
  if (!isProtocolRecord(value)
    || !isNonEmptyProtocolString(value.retentionPolicyId)
    || !isNonNegativeSafeInteger(value.expiresAt)) {
    return false;
  }
  return (value.sessionId === undefined || isNonEmptyProtocolString(value.sessionId))
    && (value.viewGeneration === undefined || isNonNegativeSafeInteger(value.viewGeneration))
    && isOptionalCanonicalOrdinal64(value.visibilityGeneration)
    && isOptionalCanonicalOrdinal64(value.lastDeliveredSeq)
    && isOptionalCanonicalOrdinal64(value.streamEpoch)
    && isOptionalCanonicalOrdinal64(value.checkpointEpoch)
    && isOptionalCanonicalOrdinal64(value.snapshotSeq)
    && isOptionalCanonicalOrdinal64(value.oldestRetainedSeq);
}

function validationFailure(value: Record<string, unknown>): TerminalCheckpointValidationResult<never> {
  return {
    ok: false,
    reason: value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      ? 'invalid-message'
      : 'unsupported-version',
  };
}

// @req FR-BGSTAB-022 AC-3 AC-4 AC-5
// @req REL-BGSTAB-007 AC-4 AC-5
export function parseTerminalCheckpointClientMessage(
  value: unknown,
): TerminalCheckpointValidationResult<TerminalCheckpointClientMessage> {
  if (!isProtocolRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('terminal-checkpoint:')) {
    return { ok: false, reason: 'not-checkpoint-message' };
  }
  if (value.type === 'terminal-checkpoint:negotiate') {
    return value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      && (value.views === undefined || isCheckpointViewRegistrations(value.views))
      ? { ok: true, message: value as unknown as TerminalCheckpointNegotiateMessage }
      : validationFailure(value);
  }
  if (value.type === 'terminal-checkpoint:continuity-rebind') {
    if (
      value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      && isNonEmptyProtocolString(value.sessionId)
      && isNonNegativeSafeInteger(value.viewGeneration)
      && isCanonicalOrdinal64(value.visibilityGeneration)
      && isCanonicalOrdinal64(value.lastDeliveredSeq)
      && isOptionalCanonicalOrdinal64(value.streamEpoch)
      && isOptionalCanonicalOrdinal64(value.checkpointEpoch)
      && isOptionalCanonicalOrdinal64(value.snapshotSeq)
      && isOptionalCanonicalOrdinal64(value.oldestRetainedSeq)
      && (value.retentionPolicyId === undefined || isNonEmptyProtocolString(value.retentionPolicyId))
      && isTerminalCheckpointContinuityRecord(value.continuityRecord)
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointContinuityRebindMessage };
    }
    return validationFailure(value);
  }
  if (value.type === 'terminal-checkpoint:recovery-request') {
    const hasFailedEpochs = value.failedStreamEpoch !== undefined
      || value.failedCheckpointEpoch !== undefined;
    if (
      value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      && isNonEmptyProtocolString(value.sessionId)
      && isNonNegativeSafeInteger(value.failedViewGeneration)
      && isNonNegativeSafeInteger(value.requestedViewGeneration)
      && value.requestedViewGeneration > value.failedViewGeneration
      && isTerminalCheckpointFailureReason(value.reason)
      && (
        !hasFailedEpochs
        || (
          isCanonicalOrdinal64(value.failedStreamEpoch)
          && isCanonicalOrdinal64(value.failedCheckpointEpoch)
        )
      )
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointRecoveryRequestMessage };
    }
    return validationFailure(value);
  }
  if (value.type === 'terminal-checkpoint:ready') {
    if (
      value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      && isNonEmptyProtocolString(value.sessionId)
      && isNonNegativeSafeInteger(value.viewGeneration)
      && isNonEmptyProtocolString(value.authorityEpoch)
      && isCanonicalOrdinal64(value.streamEpoch)
      && isCanonicalOrdinal64(value.driverLeaseGeneration)
      && isCanonicalOrdinal64(value.acceptedViewAttributesGeneration)
      && isNonEmptyProtocolString(value.viewAttributesChallengeId)
      && isNonEmptyProtocolString(value.checkpointDeliveryId)
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointReadyMessage };
    }
    return validationFailure(value);
  }
  if (!isCheckpointIdentity(value)) return validationFailure(value);
  if (value.type === 'terminal-checkpoint:apply-ack') {
    if (
      isCanonicalOrdinal64(value.appliedThroughSeq)
      && ordinalValue(value.appliedThroughSeq) === ordinalValue(value.snapshotSeq)
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointApplyAckMessage };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (value.type === 'terminal-checkpoint:drain-ack') {
    if (
      isCanonicalOrdinal64(value.drainedThroughSeq)
      && ordinalValue(value.drainedThroughSeq) >= ordinalValue(value.sourceSeq)
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointDrainAckMessage };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (value.type === 'terminal-checkpoint:failure-ack') {
    if (
      isTerminalCheckpointFailureReason(value.reason)
      && (value.lastAppliedSeq === undefined || isCanonicalOrdinal64(value.lastAppliedSeq))
      && (
        value.lastAppliedSeq === undefined
        || ordinalValue(value.lastAppliedSeq) <= ordinalValue(value.sourceSeq)
      )
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointFailureAckMessage };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  return { ok: false, reason: 'invalid-message' };
}
