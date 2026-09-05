/**
 * WebSocket Message Protocol Types
 * Shared type definitions for client-server WS communication.
 * Server has a copy at server/src/types/ws-protocol.ts
 */

// ============================================================================
// Client → Server Messages
// ============================================================================

export type InputReliabilityMode = 'observe' | 'queue' | 'strict';
export type WsTransportMode = 'unified' | 'split-shadow' | 'split';
export type WsChannelRole = 'single' | 'control' | 'output';

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
  retainedStateDigestVersion?: number;
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
  retainedStateDigestVersion?: number;
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

// @req MIG-BGSTAB-002 AC-2 AC-5
export interface TerminalResponderBoundaryIdentity {
  sessionId: string;
  connectionId: string;
  viewGeneration: number;
  transitionEpoch: Ordinal64;
  authorityEpoch: string;
  streamEpoch: Ordinal64;
  responderLeaseId: string;
  boundarySourceSeq: Ordinal64;
}

export interface TerminalAuthorityResponderViewIdentity {
  connectionId: string;
  viewGeneration: number;
  responderLeaseId: string;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  driverLeaseGeneration: Ordinal64;
  acceptedViewAttributesGeneration: Ordinal64;
}

export interface TerminalResponderDisableBoundaryMessage {
  type: 'terminal-authority:responder-disable-boundary';
  sessionId: string;
  transitionEpoch: Ordinal64;
  authorityEpoch: string;
  streamEpoch: Ordinal64;
  boundarySourceSeq: Ordinal64;
  responderLeaseId: string;
  requiredResponderViews: readonly TerminalAuthorityResponderViewIdentity[];
}

export interface TerminalAuthorityRollbackStartMessage {
  type: 'terminal-authority:rollback-start';
  source: 'server-controller';
  sessionId: string;
  transitionEpoch: Ordinal64;
  authorityEpoch: string;
  streamEpoch: Ordinal64;
  responderLeaseId: string;
  driverLeaseId: string;
  boundarySourceSeq: Ordinal64;
  checkpointEpoch: Ordinal64;
  affectedViews: readonly TerminalAuthorityResponderViewIdentity[];
}

export interface TerminalCompatibilityDrainIdentity extends TerminalResponderBoundaryIdentity {
  checkpointEpoch: Ordinal64;
  drainedThroughSourceSeq: Ordinal64;
  checkpointApplied: true;
  postSnapshotTailDrained: true;
}

export interface TerminalLegacyResponderSelectionIdentity extends TerminalCompatibilityDrainIdentity {
  driverLeaseId: string;
  driverLeaseGeneration: Ordinal64;
  acceptedViewAttributesGeneration: Ordinal64;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  snapshotSeq: Ordinal64;
}

export interface TerminalLegacyResponderEnabledMessage extends TerminalLegacyResponderSelectionIdentity {
  type: 'terminal-authority:legacy-responder-enabled';
  affectedViewCount: number;
}

export type TerminalResponderHandoffServerMessage =
  | TerminalResponderDisableBoundaryMessage
  | TerminalAuthorityRollbackStartMessage
  | TerminalLegacyResponderEnabledMessage;

export interface TerminalAuthorityQueryReplyResponderIdentity extends TerminalResponderBoundaryIdentity {
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  driverLeaseGeneration: Ordinal64;
  acceptedViewAttributesGeneration: Ordinal64;
}

export interface TerminalAuthorityQueryReplyInputMessage {
  type: 'input';
  inputKind: 'query-reply';
  sessionId: string;
  data: string;
  replyOrdinal: number;
  responderIdentity: TerminalAuthorityQueryReplyResponderIdentity;
  inputSeqStart?: never;
  inputSeqEnd?: never;
  metadata?: never;
}

export interface TerminalResponderDisabledMessage extends TerminalResponderBoundaryIdentity {
  type: 'terminal-authority:responder-disabled';
}

export interface TerminalCompatibilityDrainedMessage extends TerminalCompatibilityDrainIdentity {
  type: 'terminal-authority:compatibility-drained';
}

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

export interface TerminalAuthorityViewAttributesMessage {
  type: 'terminal-authority:view-attributes';
  sessionId: string;
  viewGeneration: number;
  driverLeaseGeneration: Ordinal64;
  viewAttributesGeneration: Ordinal64;
  viewAttributesChallengeId: string;
  attributes: TerminalViewAttributes;
}

export type TerminalResponderHandoffClientMessage =
  | TerminalAuthorityQueryReplyInputMessage
  | TerminalResponderDisabledMessage
  | TerminalCompatibilityDrainedMessage
  | TerminalAuthorityViewAttributesMessage;

export type TerminalResponderHandoffValidationResult =
  | Readonly<{ ok: true; message: TerminalResponderHandoffServerMessage }>
  | Readonly<{ ok: false; reason: 'not-responder-handoff-message' | 'invalid-message' }>;

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

export interface TerminalDeliveryAckRejectedMessage {
  type: 'terminal-delivery:ack-rejected';
  sessionId: string;
  connectionEpoch: string;
  deliverySeq: number;
  reason: string;
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

export function parseTerminalDeliveryAckRejectedMessage(value: unknown):
  | { ok: true; message: TerminalDeliveryAckRejectedMessage }
  | { ok: false; reason: string } {
  if (!isProtocolRecord(value)) return { ok: false, reason: 'invalid-message' };
  if (value.type !== 'terminal-delivery:ack-rejected') return { ok: false, reason: 'invalid-message-type' };
  if (!isNonEmptyProtocolString(value.sessionId) || !isNonEmptyProtocolString(value.connectionEpoch)) {
    return { ok: false, reason: 'invalid-identity' };
  }
  if (typeof value.deliverySeq !== 'number' || !Number.isSafeInteger(value.deliverySeq) || value.deliverySeq < 1) {
    return { ok: false, reason: 'invalid-delivery-seq' };
  }
  if (!isNonEmptyProtocolString(value.reason)) return { ok: false, reason: 'invalid-reason' };
  return { ok: true, message: value as unknown as TerminalDeliveryAckRejectedMessage };
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
  | TerminalResponderHandoffClientMessage
  | TerminalCheckpointClientMessage
  | TerminalDeliveryAckMessage
  | TerminalDeliveryCapabilityMessage
  | TerminalDeliveryVisibilityMessage
  // In-band binary negotiation, client half (`01 §2.2`, `01:761`).
  | {
      type: 'terminal-binary:capability';
      supportedFrameVersions: readonly number[];
      acceptedFlagMask: number;
    }
  | { type: 'terminal-binary:unknown-channel'; channelIds: readonly number[] }
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

export interface TerminalOutputMessage {
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

export interface TerminalSessionReadyMessage {
  type: 'session:ready';
  sessionId: string;
  replayToken?: string;
  repairToken?: string;
  snapshotSeq?: number;
}

export type ServerWsMessage =
  // Session events
  | ScreenSnapshotMessage
  | ScreenRepairMessage
  | ScreenRepairRejectedMessage
  | ScreenRepairRestoreNeededMessage
  | ScreenRepairReconnectRequiredMessage
  | TerminalOutputMessage
  | TerminalCheckpointServerMessage
  | TerminalResponderHandoffServerMessage
  | { type: 'status';         sessionId: string; status: 'running' | 'idle' }
  | TerminalSessionReadyMessage
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
  | TerminalDeliveryAckRejectedMessage
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
  | {
      type: 'connected';
      clientId: string;
      connectionId?: string;
      clientGroupId?: string;
      wsTransportMode?: WsTransportMode;
      channel?: WsChannelRole;
    }
  | { type: 'pong' };

export interface SubscribedSessionInfo {
  sessionId: string;
  status: string;
  cwd?: string;
  ready: boolean;
  // Binary data plane (`01:374-385`). Optional so a JSON-only group shares the
  // schema, and absent until the server gains its encode surface. They arrive
  // as one group: a channel is never known without its identity (`08:171`).
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
   * never populate the channel table `08:192` requires.
   */
  authorityEpoch?: string;
}

export type ReplayTelemetryValue = string | number | boolean | null;

export type ReplayEventKind =
  | 'resize_requested'
  | 'resize_skipped'
  | 'snapshot_sent'
  | 'snapshot_refreshed'
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
  | 'screen_repair_queue_overflow';

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
  recentReplayEvents: ReplayTelemetryEvent[];
}

const ORDINAL64_MAX = 18_446_744_073_709_551_615n;
const ORDINAL64_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonEmptyProtocolString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
    && isNonEmptyProtocolString(value.retentionPolicyId);
}

function isCheckpointAckRejectionIdentity(
  value: unknown,
): value is TerminalCheckpointAckRejectionIdentity {
  return isProtocolRecord(value)
    && isNonEmptyProtocolString(value.sessionId)
    && isNonNegativeSafeInteger(value.viewGeneration)
    && isCanonicalOrdinal64(value.streamEpoch)
    && isCanonicalOrdinal64(value.checkpointEpoch)
    && (value.connectionId === undefined || isNonEmptyProtocolString(value.connectionId));
}

function isDigest(value: unknown): value is TerminalCheckpointDigest {
  return isProtocolRecord(value)
    && value.algorithm === 'sha256'
    && typeof value.hex === 'string'
    && SHA256_HEX_PATTERN.test(value.hex);
}

function isSha256WireDigest(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('sha256:')
    && SHA256_HEX_PATTERN.test(value.slice('sha256:'.length));
}

function decodedBase64ByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isEncodedPayload(value: unknown): value is TerminalCheckpointEncodedPayload {
  return isProtocolRecord(value)
    && value.encoding === 'base64'
    && typeof value.data === 'string'
    && BASE64_PATTERN.test(value.data)
    && isNonNegativeSafeInteger(value.encodedBytes)
    && decodedBase64ByteLength(value.data) === value.encodedBytes;
}

const TERMINAL_CHECKPOINT_BOOLEAN_MODE_SET = new Set<string>(TERMINAL_CHECKPOINT_BOOLEAN_MODES);

export function isTerminalCheckpointModes(
  value: unknown,
): value is Readonly<Partial<Record<TerminalCheckpointBooleanMode, boolean>>> {
  return isProtocolRecord(value)
    && Object.entries(value).every(([key, entry]) => (
      TERMINAL_CHECKPOINT_BOOLEAN_MODE_SET.has(key) && typeof entry === 'boolean'
    ));
}

function isCheckpointRegisteredViews(
  value: unknown,
): value is readonly TerminalCheckpointRegisteredView[] {
  if (!Array.isArray(value)) return false;
  const sessionIds = new Set<string>();
  return value.every((entry) => {
    const hasAuthorityGrant = isProtocolRecord(entry) && (
      Object.prototype.hasOwnProperty.call(entry, 'authorityStreamEpoch')
      || Object.prototype.hasOwnProperty.call(entry, 'driverLeaseGeneration')
      || Object.prototype.hasOwnProperty.call(entry, 'acceptedViewAttributesGeneration')
      || Object.prototype.hasOwnProperty.call(entry, 'viewAttributesChallengeId')
    );
    if (
      !isProtocolRecord(entry)
      || !isNonEmptyProtocolString(entry.sessionId)
      || !isNonNegativeSafeInteger(entry.viewGeneration)
      || (entry.queryReplyCapability !== undefined
        && entry.queryReplyCapability !== 'terminal.query-reply-input.v1')
      || (entry.parserResponderCapability !== undefined
        && entry.parserResponderCapability !== 'terminal.parser-responder-disable.v1')
      || (hasAuthorityGrant && (
        entry.queryReplyCapability !== 'terminal.query-reply-input.v1'
        || entry.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
        || !isCanonicalOrdinal64(entry.authorityStreamEpoch)
        || !isCanonicalOrdinal64(entry.driverLeaseGeneration)
        || !isCanonicalOrdinal64(entry.acceptedViewAttributesGeneration)
        || !isNonEmptyProtocolString(entry.viewAttributesChallengeId)
        || entry.driverLeaseGeneration !== entry.authorityStreamEpoch
        || entry.acceptedViewAttributesGeneration !== entry.authorityStreamEpoch
      ))
      || sessionIds.has(entry.sessionId)
    ) {
      return false;
    }
    sessionIds.add(entry.sessionId);
    return true;
  });
}

function isRetainedTerminalMutationLeases(
  value: unknown,
): value is readonly RetainedTerminalMutationLease[] {
  return Array.isArray(value) && value.every((entry) => (
    isProtocolRecord(entry)
    && isNonEmptyProtocolString(entry.sessionId)
    && isNonEmptyProtocolString(entry.authorityEpoch)
    && isNonNegativeSafeInteger(entry.viewGeneration)
    && isNonEmptyProtocolString(entry.leaseGeneration)
  ));
}

function isCheckpointDeliveryPreparation(
  value: unknown,
  registeredViews: unknown,
): value is TerminalCheckpointDeliveryPreparation {
  if (
    !isProtocolRecord(value)
    || !isNonEmptyProtocolString(value.checkpointDeliveryId)
    || !isNonEmptyProtocolString(value.authorityEpoch)
    || !isCanonicalOrdinal64(value.streamEpoch)
    || !isNonNegativeSafeInteger(value.viewGeneration)
    || !isCanonicalOrdinal64(value.driverLeaseGeneration)
    || !isCanonicalOrdinal64(value.acceptedViewAttributesGeneration)
    || !isNonEmptyProtocolString(value.viewAttributesChallengeId)
    || !Array.isArray(registeredViews)
  ) {
    return false;
  }
  return registeredViews.some((registeredView) => (
    isProtocolRecord(registeredView)
    && registeredView.viewGeneration === value.viewGeneration
    && registeredView.authorityStreamEpoch === value.streamEpoch
    && registeredView.driverLeaseGeneration === value.driverLeaseGeneration
    && registeredView.acceptedViewAttributesGeneration === value.acceptedViewAttributesGeneration
    && registeredView.viewAttributesChallengeId === value.viewAttributesChallengeId
  ));
}

function validationFailure(value: Record<string, unknown>): TerminalCheckpointValidationResult<never> {
  return {
    ok: false,
    reason: value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      ? 'invalid-message'
      : 'unsupported-version',
  };
}

// @req FR-BGSTAB-022 AC-3 AC-4
// @req REL-BGSTAB-007 AC-4 AC-5
export function parseTerminalCheckpointServerMessage(
  value: unknown,
): TerminalCheckpointValidationResult<TerminalCheckpointServerMessage> {
  if (!isProtocolRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('terminal-checkpoint:')) {
    return { ok: false, reason: 'not-checkpoint-message' };
  }
  if (value.type === 'terminal-checkpoint:capability') {
    if (
      value.protocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      && value.accepted === true
      && (
        (value.authorityMode === 'legacy' && value.checkpointDeliveryActive === false)
        || (value.authorityMode === 'checkpoint' && value.checkpointDeliveryActive === true)
      )
      && value.ordinalEncoding === 'canonical-uint64-decimal'
      && Array.isArray(value.digestAlgorithms)
      && value.digestAlgorithms.length === 1
      && value.digestAlgorithms[0] === 'sha256'
      && (
        value.registeredViews === undefined
        || isCheckpointRegisteredViews(value.registeredViews)
      )
      && (
        value.mutationLeases === undefined
        || isRetainedTerminalMutationLeases(value.mutationLeases)
      )
      && (
        value.checkpointDeliveryPreparation === undefined
        || (
          value.authorityMode === 'checkpoint'
          && value.checkpointDeliveryActive === true
          && isCheckpointDeliveryPreparation(
            value.checkpointDeliveryPreparation,
            value.registeredViews,
          )
        )
      )
      && (
        value.checkpointDeliveryActive === false
        || Array.isArray(value.registeredViews)
      )
      && (
        value.compatibilityRecoveryRole === undefined
        || (
          value.authorityMode === 'legacy'
          && value.checkpointDeliveryActive === false
          && (value.compatibilityRecoveryRole === 'selected-responder'
            || value.compatibilityRecoveryRole === 'passive-snapshot')
        )
      )
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointCapabilityMessage };
    }
    return validationFailure(value);
  }
  if (value.type === 'terminal-checkpoint:rejected') {
    const reasons: readonly TerminalCheckpointRejectedReason[] = [
      'unsupported-version', 'invalid-message', 'capability-not-negotiated', 'checkpoint-not-active',
    ];
    if (
      value.supportedProtocolVersion === TERMINAL_CHECKPOINT_PROTOCOL_VERSION
      && (value.phase === 'negotiate' || value.phase === 'ack')
      && reasons.includes(value.reason as TerminalCheckpointRejectedReason)
      && (value.sessionId === undefined || isNonEmptyProtocolString(value.sessionId))
      && (value.ackIdentity === undefined || isCheckpointAckRejectionIdentity(value.ackIdentity))
      && (value.rejectedMessageType === undefined || value.rejectedMessageType === 'resize')
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointRejectedMessage };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (!isCheckpointIdentity(value)) return validationFailure(value);
  if (value.type === 'terminal-checkpoint:start') {
    if (
      isProtocolRecord(value.sourceGeometry)
      && isPositiveSafeInteger(value.sourceGeometry.cols)
      && isPositiveSafeInteger(value.sourceGeometry.rows)
      && isPositiveSafeInteger(value.chunkCount)
      && isNonNegativeSafeInteger(value.encodedByteTotal)
      && isDigest(value.digest)
      && isTerminalCheckpointModes(value.modes)
      && isEncodedPayload(value.parserTail)
      && (value.retainedStateDigest === undefined || (
        isSha256WireDigest(value.retainedStateDigest)
        && isSha256WireDigest(value.contentDigest)
        && (value.retainedActiveBuffer === 'normal' || value.retainedActiveBuffer === 'alternate')
        && isProtocolRecord(value.retainedCursor)
        && isNonNegativeSafeInteger(value.retainedCursor.x)
        && isNonNegativeSafeInteger(value.retainedCursor.y)
        && (value.retainedSavedCursor === null || (
          isProtocolRecord(value.retainedSavedCursor)
          && value.retainedSavedCursor.buffer === 'normal'
          && isNonNegativeSafeInteger(value.retainedSavedCursor.x)
          && isNonNegativeSafeInteger(value.retainedSavedCursor.y)
        ))
      ))
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointStartMessage };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (value.type === 'terminal-checkpoint:chunk') {
    if (
      isNonNegativeSafeInteger(value.chunkIndex)
      && isPositiveSafeInteger(value.chunkCount)
      && value.chunkIndex < value.chunkCount
      && value.encoding === 'base64'
      && typeof value.data === 'string'
      && BASE64_PATTERN.test(value.data)
      && isNonNegativeSafeInteger(value.encodedBytes)
      && decodedBase64ByteLength(value.data) === value.encodedBytes
    ) {
      return { ok: true, message: value as unknown as TerminalCheckpointChunkMessage };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (
    value.type === 'terminal-checkpoint:commit'
    && isPositiveSafeInteger(value.chunkCount)
    && isNonNegativeSafeInteger(value.encodedByteTotal)
    && isDigest(value.digest)
    && (value.retainedStateDigest === undefined || isSha256WireDigest(value.retainedStateDigest))
  ) {
    return { ok: true, message: value as unknown as TerminalCheckpointCommitMessage };
  }
  if (value.type === 'terminal-checkpoint:output' && isEncodedPayload(value)) {
    return { ok: true, message: value as unknown as TerminalCheckpointOutputMessage };
  }
  return { ok: false, reason: 'invalid-message' };
}

function isTerminalResponderBoundaryIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TerminalResponderBoundaryIdentity {
  return isNonEmptyProtocolString(value.sessionId)
    && isNonEmptyProtocolString(value.connectionId)
    && isNonNegativeSafeInteger(value.viewGeneration)
    && isCanonicalOrdinal64(value.transitionEpoch)
    && isNonEmptyProtocolString(value.authorityEpoch)
    && isCanonicalOrdinal64(value.streamEpoch)
    && isNonEmptyProtocolString(value.responderLeaseId)
    && isCanonicalOrdinal64(value.boundarySourceSeq);
}

function isTerminalAuthorityResponderViewIdentity(
  value: unknown,
): value is TerminalAuthorityResponderViewIdentity {
  return isProtocolRecord(value)
    && isNonEmptyProtocolString(value.connectionId)
    && isNonNegativeSafeInteger(value.viewGeneration)
    && isNonEmptyProtocolString(value.responderLeaseId)
    && value.queryReplyCapability === 'terminal.query-reply-input.v1'
    && value.parserResponderCapability === 'terminal.parser-responder-disable.v1'
    && isCanonicalOrdinal64(value.driverLeaseGeneration)
    && isCanonicalOrdinal64(value.acceptedViewAttributesGeneration);
}

function isTerminalAuthorityResponderViewList(
  value: unknown,
): value is readonly TerminalAuthorityResponderViewIdentity[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const keys = new Set<string>();
  return value.every((entry) => {
    if (!isTerminalAuthorityResponderViewIdentity(entry)) return false;
    const key = `${entry.connectionId}\u0000${entry.viewGeneration}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function isTerminalCompatibilityDrainIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TerminalCompatibilityDrainIdentity {
  return isTerminalResponderBoundaryIdentity(value)
    && isCanonicalOrdinal64(value.checkpointEpoch)
    && isCanonicalOrdinal64(value.drainedThroughSourceSeq)
    && value.checkpointApplied === true
    && value.postSnapshotTailDrained === true;
}

function isTerminalLegacyResponderSelectionIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TerminalLegacyResponderSelectionIdentity {
  return isTerminalCompatibilityDrainIdentity(value)
    && isNonEmptyProtocolString(value.driverLeaseId)
    && isCanonicalOrdinal64(value.driverLeaseGeneration)
    && isCanonicalOrdinal64(value.acceptedViewAttributesGeneration)
    && value.queryReplyCapability === 'terminal.query-reply-input.v1'
    && value.parserResponderCapability === 'terminal.parser-responder-disable.v1'
    && isCanonicalOrdinal64(value.snapshotSeq);
}

// @req MIG-BGSTAB-002 AC-5
export function parseTerminalResponderHandoffServerMessage(
  value: unknown,
): TerminalResponderHandoffValidationResult {
  if (!isProtocolRecord(value) || typeof value.type !== 'string') {
    return { ok: false, reason: 'not-responder-handoff-message' };
  }
  if (value.type === 'terminal-authority:responder-disable-boundary') {
    if (
      isNonEmptyProtocolString(value.sessionId)
      && isCanonicalOrdinal64(value.transitionEpoch)
      && isNonEmptyProtocolString(value.authorityEpoch)
      && isCanonicalOrdinal64(value.streamEpoch)
      && isCanonicalOrdinal64(value.boundarySourceSeq)
      && isNonEmptyProtocolString(value.responderLeaseId)
      && isTerminalAuthorityResponderViewList(value.requiredResponderViews)
    ) {
      return {
        ok: true,
        message: value as unknown as TerminalResponderDisableBoundaryMessage,
      };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (value.type === 'terminal-authority:rollback-start') {
    if (
      value.source === 'server-controller'
      && isNonEmptyProtocolString(value.sessionId)
      && isCanonicalOrdinal64(value.transitionEpoch)
      && isNonEmptyProtocolString(value.authorityEpoch)
      && isCanonicalOrdinal64(value.streamEpoch)
      && isNonEmptyProtocolString(value.responderLeaseId)
      && isNonEmptyProtocolString(value.driverLeaseId)
      && isCanonicalOrdinal64(value.boundarySourceSeq)
      && isCanonicalOrdinal64(value.checkpointEpoch)
      && isTerminalAuthorityResponderViewList(value.affectedViews)
    ) {
      return {
        ok: true,
        message: value as unknown as TerminalAuthorityRollbackStartMessage,
      };
    }
    return { ok: false, reason: 'invalid-message' };
  }
  if (value.type !== 'terminal-authority:legacy-responder-enabled') {
    return { ok: false, reason: 'not-responder-handoff-message' };
  }
  if (
    !isTerminalLegacyResponderSelectionIdentity(value)
    || !isPositiveSafeInteger(value.affectedViewCount)
  ) {
    return { ok: false, reason: 'invalid-message' };
  }
  return {
    ok: true,
    message: value as unknown as TerminalLegacyResponderEnabledMessage,
  };
}
