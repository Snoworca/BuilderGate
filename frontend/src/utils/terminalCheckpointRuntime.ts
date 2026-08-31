import type {
  ClientWsMessage,
  RetainedTerminalMutationLease,
  TerminalCheckpointCapabilityMessage,
  TerminalCheckpointAckRejectionIdentity,
  TerminalCheckpointClientMessage,
  TerminalCheckpointCommitMessage,
  TerminalCheckpointFailureReason,
  TerminalCheckpointReadyMessage,
  TerminalCheckpointServerMessage,
  TerminalCheckpointStartMessage,
  TerminalCheckpointViewRegistration,
  TerminalCheckpointWireIdentity,
  TerminalCompatibilityDrainIdentity,
  TerminalLegacyResponderEnabledMessage,
  TerminalAuthorityRollbackStartMessage,
  TerminalLegacyResponderSelectionIdentity,
  TerminalResponderBoundaryIdentity,
} from '../types/ws-protocol.ts';
import {
  isCanonicalOrdinal64,
  isTerminalCheckpointModes,
  parseTerminalResponderHandoffServerMessage,
  TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
} from '../types/ws-protocol.ts';
import type {
  TerminalCheckpointLifecycleMetadata,
  TerminalWriteCoordinator,
  TerminalWriteCoordinatorResult,
} from './terminalWriteCoordinator.ts';
import { digestTerminalBytes } from './terminalWriteCoordinatorRuntime.ts';

export type TerminalCheckpointSendResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

export interface TerminalCheckpointRuntimeOptions {
  sessionId: string;
  initialViewGeneration: number;
  getCoordinator: () => TerminalWriteCoordinator | null;
  send: (message: TerminalCheckpointClientMessage) => TerminalCheckpointSendResult;
  getPreparedCheckpointReadyReceipt?: () => ImmediateTerminalControlSendResult;
  sendPreparedCheckpointReady?: (input: Readonly<{
    message: TerminalCheckpointReadyMessage;
    expectedControlSocketId: string;
    afterEnqueueOrdinal: number;
  }>) => ImmediateTerminalControlSendResult;
  onPreparedCheckpointReadySendBlocked?: (input: Readonly<{
    checkpointDeliveryId: string;
    reason: string;
    expectedControlSocketId?: string;
    actualControlSocketId?: string;
  }>) => void;
  onPreparedCheckpointReadyDeferred?: (input: Readonly<{
    checkpointDeliveryId: string;
    reason:
      | 'legacy-recovery-pending'
      | 'compatibility-snapshot-not-completed'
      | 'checkpoint-recovery-pending'
      | 'checkpoint-capability-inactive'
      | 'view-generation-mismatch';
  }>) => void;
  requestFreshRecovery: (reason: string) => void;
  advanceViewGeneration: (viewGeneration: number) => void;
  onAuthorityStateChange?: (
    state:
      | 'legacy'
      | 'legacy-recovery-pending'
      | 'checkpoint-pending'
      | 'checkpoint-drained'
      | 'recovery-required'
      | 'runtime-recreation-required',
  ) => void;
  onCapabilityRegistration?: (
    capability: TerminalCheckpointCapabilityMessage,
    registration: TerminalCheckpointViewRegistration & {
      driverLeaseGeneration?: string;
      acceptedViewAttributesGeneration?: string;
    },
  ) => void;
}

export interface TerminalCheckpointRuntimeState {
  readonly active: boolean;
  readonly ready: boolean;
  readonly readyBarrier?: 'matching-checkpoint-drain-ack';
  readonly disposed: boolean;
  readonly recoveryPending: boolean;
  readonly legacyRecoveryPending: boolean;
  readonly checkpointDeliveryPreparationPending: boolean;
  readonly orderedRollbackPending: boolean;
  readonly viewGeneration: number;
  readonly registrationViewGeneration: number;
}

export type TerminalLegacyRecoveryCompletion =
  | Readonly<{ source: 'compatibility-snapshot' }>
  | Readonly<{
      source: 'legacy-responder-enabled';
      viewGeneration: number;
      streamEpoch: string;
      checkpointEpoch: string;
    }>;

export type TerminalCheckpointInputRoute =
  | 'direct'
  | 'checkpoint-runtime'
  | 'pending-input-queue';

// @req MIG-BGSTAB-002 AC-4
export function resolveTerminalCheckpointInputRoute(
  state: Pick<
    TerminalCheckpointRuntimeState,
    'active' | 'recoveryPending' | 'legacyRecoveryPending'
  >,
): TerminalCheckpointInputRoute {
  if (state.recoveryPending || state.legacyRecoveryPending) {
    return 'pending-input-queue';
  }
  return state.active ? 'checkpoint-runtime' : 'direct';
}

export interface TerminalCheckpointFailureBoundary {
  readonly viewGeneration?: number;
  readonly streamEpoch?: string;
  readonly checkpointEpoch?: string;
}

export interface TerminalCheckpointRuntime {
  setCapability: (
    capability: TerminalCheckpointCapabilityMessage | null,
  ) => TerminalWriteCoordinatorResult;
  rollbackToLegacy: (
    reason: string,
    options?: Readonly<{ requestFreshRecovery?: boolean }>,
  ) => TerminalWriteCoordinatorResult;
  beginCompatibilityRollback: (
    message: TerminalAuthorityRollbackStartMessage,
  ) => TerminalWriteCoordinatorResult;
  beginLegacyRecovery: (reason: string) => TerminalWriteCoordinatorResult;
  completeLegacyRecovery: (
    completion: TerminalLegacyRecoveryCompletion,
  ) => TerminalWriteCoordinatorResult;
  handleMessage: (message: TerminalCheckpointServerMessage) => TerminalWriteCoordinatorResult;
  submitInput: (data: string) => TerminalWriteCoordinatorResult;
  checkpointApplied: (
    metadata: TerminalCheckpointLifecycleMetadata,
  ) => TerminalWriteCoordinatorResult;
  checkpointDrained: (
    metadata: TerminalCheckpointLifecycleMetadata,
  ) => TerminalWriteCoordinatorResult;
  coordinatorRecoveryFailed: (
    reason: string,
    boundary?: TerminalCheckpointFailureBoundary,
  ) => TerminalWriteCoordinatorResult;
  getState: () => Readonly<TerminalCheckpointRuntimeState>;
  dispose: () => void;
}

export interface TerminalCheckpointDispatcherRegistry {
  selectFreshCapability: (
    capability: TerminalCheckpointCapabilityMessage,
  ) => TerminalCheckpointCapabilityMessage | null;
  releaseCapability: (sessionId: string) => void;
  setCapability: (
    capability: TerminalCheckpointCapabilityMessage | null,
  ) => TerminalCheckpointCapabilityMessage | null;
  takeAppliedRegistrationCapability: (
    sessionId: string,
  ) => TerminalCheckpointCapabilityMessage | null;
  register: (sessionId: string, dispatcher: TerminalCheckpointRuntime) => () => boolean;
  route: (message: TerminalCheckpointServerMessage) => TerminalCheckpointRouteResult;
  failSession: (
    sessionId: string,
    reason: string,
    boundary?: TerminalCheckpointFailureBoundary,
  ) => TerminalCheckpointRouteResult;
  failActive: (reason: string, boundary?: TerminalCheckpointFailureBoundary) => number;
  listViews: () => readonly TerminalCheckpointViewRegistration[];
}

export type TerminalCheckpointRouteResult =
  | Readonly<{ delivered: true }>
  | Readonly<{ delivered: false; handled?: false; reason: string }>
  | Readonly<{ delivered: false; handled: true; reason: string }>;

export function mergeTerminalCheckpointMutationLeases(
  current: ReadonlyMap<string, RetainedTerminalMutationLease>,
  capability: TerminalCheckpointCapabilityMessage,
): Map<string, RetainedTerminalMutationLease> {
  const merged = new Map(current);
  for (const lease of capability.mutationLeases ?? []) {
    merged.set(lease.sessionId, lease);
  }
  return merged;
}

export function reconcileTerminalCheckpointMutationLeases(
  current: ReadonlyMap<string, RetainedTerminalMutationLease>,
  attemptedCapability: TerminalCheckpointCapabilityMessage,
  appliedCapability: TerminalCheckpointCapabilityMessage | null,
): Map<string, RetainedTerminalMutationLease> {
  const reconciled = new Map(current);
  const attemptedViews = attemptedCapability.registeredViews ?? [];
  if (attemptedViews.length === 0) {
    reconciled.clear();
  } else {
    const appliedSessionIds = new Set(
      (appliedCapability?.registeredViews ?? []).map(view => view.sessionId),
    );
    for (const view of attemptedViews) {
      if (!appliedSessionIds.has(view.sessionId)) reconciled.delete(view.sessionId);
    }
  }
  for (const lease of appliedCapability?.mutationLeases ?? []) {
    reconciled.set(lease.sessionId, lease);
  }
  return reconciled;
}

interface RuntimeIdentity extends TerminalCheckpointWireIdentity {
  readonly chunkCount: number;
  readonly encodedByteTotal: number;
  readonly digest: string;
  readonly retainedStateDigest?: string;
}

interface FailedBoundary {
  readonly streamEpoch: bigint;
  readonly checkpointEpoch: bigint;
}

const ORDINAL64_MAX = (1n << 64n) - 1n;
const ORDINAL64_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const retainedStateEncoder = new TextEncoder();
const RETAINED_STATE_MODE_NAMES = Object.freeze([
  'applicationCursorKeysMode',
  'applicationKeypadMode',
  'bracketedPasteMode',
  'insertMode',
  'originMode',
  'reverseWraparoundMode',
  'sendFocusMode',
  'wraparoundMode',
] as const);

export function attachRetainedMutationLease(
  message: ClientWsMessage,
  leases: ReadonlyMap<string, RetainedTerminalMutationLease>,
): ClientWsMessage {
  if (message.type !== 'input' && message.type !== 'resize') return message;
  const lease = leases.get(message.sessionId);
  if (!lease) return message;
  return {
    ...message,
    retainedIdentity: {
      authorityEpoch: lease.authorityEpoch,
      viewGeneration: lease.viewGeneration,
      leaseGeneration: lease.leaseGeneration,
    },
  };
}

export function isTerminalCheckpointMutationLeaseReady(
  capability: TerminalCheckpointCapabilityMessage,
  sessionId: string,
  viewGeneration: number,
): boolean {
  return capability.mutationLeases?.some(lease => (
    lease.sessionId === sessionId && lease.viewGeneration === viewGeneration
  )) === true;
}

// @req REL-BGSTAB-011
export function releaseTerminalCheckpointDispatcherRegistration(input: Readonly<{
  sessionId: string;
  leases: Map<string, RetainedTerminalMutationLease>;
  unregister: () => boolean;
  listViews: () => readonly TerminalCheckpointViewRegistration[];
}>): readonly TerminalCheckpointViewRegistration[] {
  if (input.unregister()) {
    input.leases.delete(input.sessionId);
  }
  return input.listViews();
}

// @req MIG-BGSTAB-002 AC-3 AC-4
// React may dispose and replace one session runtime in the same turn. Delay
// only the wire-level release so the replacement can cancel a transient empty
// negotiate, while a genuine final dispose still unregisters deterministically.
export function createTerminalCheckpointRegistrationReleaseScheduler(
  scheduleTurn: (callback: () => void) => void = callback => queueMicrotask(callback),
): Readonly<{
  schedule(sessionId: string, release: () => void): void;
  cancel(sessionId: string): void;
}> {
  const pending = new Map<string, object>();
  return Object.freeze({
    schedule(sessionId, release): void {
      const token = Object.freeze({});
      pending.set(sessionId, token);
      scheduleTurn(() => {
        if (pending.get(sessionId) !== token) return;
        pending.delete(sessionId);
        release();
      });
    },
    cancel(sessionId): void {
      pending.delete(sessionId);
    },
  });
}

function canonicalOrdinal64(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length > 20
    || !ORDINAL64_PATTERN.test(value)
  ) {
    return undefined;
  }
  return BigInt(value) <= ORDINAL64_MAX ? value : undefined;
}

export function extractTerminalCheckpointFailureBoundary(
  value: Readonly<Record<string, unknown>>,
): Readonly<TerminalCheckpointFailureBoundary> | undefined {
  const viewGeneration = typeof value.viewGeneration === 'number'
    && Number.isSafeInteger(value.viewGeneration)
    && value.viewGeneration >= 0
    ? value.viewGeneration
    : undefined;
  const streamEpoch = canonicalOrdinal64(value.streamEpoch);
  const checkpointEpoch = canonicalOrdinal64(value.checkpointEpoch);
  if (viewGeneration === undefined && streamEpoch === undefined && checkpointEpoch === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(viewGeneration === undefined ? {} : { viewGeneration }),
    ...(streamEpoch === undefined ? {} : { streamEpoch }),
    ...(checkpointEpoch === undefined ? {} : { checkpointEpoch }),
  });
}

export function isGlobalTerminalCheckpointControlFailure(
  value: Readonly<{ type?: unknown; phase?: unknown }>,
): boolean {
  return value.type === 'terminal-checkpoint:capability'
    || (
      value.type === 'terminal-checkpoint:rejected'
      && value.phase !== 'ack'
    );
}

export function isTerminalCheckpointMutationRejection(
  value: Readonly<{ type?: unknown; rejectedMessageType?: unknown }>,
): boolean {
  return value.type === 'terminal-checkpoint:rejected'
    && value.rejectedMessageType === 'resize';
}

function laterBoundary(
  current: FailedBoundary | null,
  identity: Pick<TerminalCheckpointFailureBoundary, 'streamEpoch' | 'checkpointEpoch'> | null,
): FailedBoundary | null {
  const streamEpoch = canonicalOrdinal64(identity?.streamEpoch);
  const checkpointEpoch = canonicalOrdinal64(identity?.checkpointEpoch);
  if (!streamEpoch || !checkpointEpoch) return current;
  const candidate = {
    streamEpoch: BigInt(streamEpoch),
    checkpointEpoch: BigInt(checkpointEpoch),
  };
  if (
    current === null
    || candidate.streamEpoch > current.streamEpoch
    || (
      candidate.streamEpoch === current.streamEpoch
      && candidate.checkpointEpoch > current.checkpointEpoch
    )
  ) {
    return candidate;
  }
  return current;
}

const ACCEPTED: TerminalWriteCoordinatorResult = Object.freeze({ accepted: true });

function rejected(reason: string): TerminalWriteCoordinatorResult {
  return Object.freeze({ accepted: false, reason });
}

function isActiveCapability(capability: TerminalCheckpointCapabilityMessage | null): boolean {
  return capability?.authorityMode === 'checkpoint'
    && capability.checkpointDeliveryActive === true;
}

function capabilityIncludesView(
  capability: TerminalCheckpointCapabilityMessage | null,
  sessionId: string,
  viewGeneration: number,
): boolean {
  return isActiveCapability(capability)
    && capability?.registeredViews?.some(view => (
      view.sessionId === sessionId && view.viewGeneration === viewGeneration
    )) === true;
}

function decodeBase64(data: string, encodedBytes: number): Uint8Array {
  const decoded = atob(data);
  if (decoded.length !== encodedBytes) {
    throw new TypeError('terminal checkpoint encoded byte length mismatch');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function digestWireValue(digest: Readonly<{ algorithm: 'sha256'; hex: string }>): string {
  return `${digest.algorithm}:${digest.hex}`;
}

/**
 * Rebuild the server's retained-state digest from protocol fields before any
 * terminal mutation. Older checkpoint senders that omit the additive digest
 * remain compatible; once present, every covered field is mandatory and must
 * match exactly.
 */
export function terminalCheckpointRetainedStateDigestMatches(
  message: TerminalCheckpointStartMessage,
): boolean {
  if (message.retainedStateDigest === undefined) return true;
  if (
    message.contentDigest === undefined
    || message.contentDigest !== digestWireValue(message.digest)
    || message.retainedActiveBuffer === undefined
    || message.retainedCursor === undefined
    || message.retainedSavedCursor === undefined
  ) {
    return false;
  }
  const modes = Object.fromEntries(RETAINED_STATE_MODE_NAMES.flatMap(name => (
    typeof message.modes[name] === 'boolean' ? [[name, message.modes[name]]] : []
  )));
  const savedCursor = message.retainedSavedCursor === null
    ? null
    : { x: message.retainedSavedCursor.x, y: message.retainedSavedCursor.y };
  const canonical = JSON.stringify({
    version: 1,
    dataDigest: message.contentDigest,
    parserTail: message.parserTail.data,
    cols: message.sourceGeometry.cols,
    rows: message.sourceGeometry.rows,
    modes,
    activeBuffer: message.retainedActiveBuffer,
    cursor: { x: message.retainedCursor.x, y: message.retainedCursor.y },
    savedCursor,
  });
  return digestTerminalBytes(retainedStateEncoder.encode(canonical)) === message.retainedStateDigest;
}

function identityFromStart(message: TerminalCheckpointStartMessage): RuntimeIdentity {
  return Object.freeze({
    protocolVersion: message.protocolVersion,
    sessionId: message.sessionId,
    viewGeneration: message.viewGeneration,
    streamEpoch: message.streamEpoch,
    checkpointEpoch: message.checkpointEpoch,
    sourceSeq: message.sourceSeq,
    snapshotSeq: message.snapshotSeq,
    oldestRetainedSeq: message.oldestRetainedSeq,
    retentionPolicyId: message.retentionPolicyId,
    ...(message.connectionId === undefined ? {} : { connectionId: message.connectionId }),
    ...(message.transitionEpoch === undefined ? {} : { transitionEpoch: message.transitionEpoch }),
    ...(message.authorityEpoch === undefined ? {} : { authorityEpoch: message.authorityEpoch }),
    ...(message.responderLeaseId === undefined ? {} : { responderLeaseId: message.responderLeaseId }),
    ...(message.boundarySourceSeq === undefined ? {} : { boundarySourceSeq: message.boundarySourceSeq }),
    chunkCount: message.chunkCount,
    encodedByteTotal: message.encodedByteTotal,
    digest: digestWireValue(message.digest),
    ...(message.retainedStateDigest === undefined
      ? {}
      : { retainedStateDigest: message.retainedStateDigest }),
  });
}

function wireIdentity(identity: RuntimeIdentity): TerminalCheckpointWireIdentity {
  return Object.freeze({
    protocolVersion: identity.protocolVersion,
    sessionId: identity.sessionId,
    viewGeneration: identity.viewGeneration,
    streamEpoch: identity.streamEpoch,
    checkpointEpoch: identity.checkpointEpoch,
    sourceSeq: identity.sourceSeq,
    snapshotSeq: identity.snapshotSeq,
    oldestRetainedSeq: identity.oldestRetainedSeq,
    retentionPolicyId: identity.retentionPolicyId,
    ...(identity.connectionId === undefined ? {} : { connectionId: identity.connectionId }),
    ...(identity.transitionEpoch === undefined ? {} : { transitionEpoch: identity.transitionEpoch }),
    ...(identity.authorityEpoch === undefined ? {} : { authorityEpoch: identity.authorityEpoch }),
    ...(identity.responderLeaseId === undefined ? {} : { responderLeaseId: identity.responderLeaseId }),
    ...(identity.boundarySourceSeq === undefined ? {} : { boundarySourceSeq: identity.boundarySourceSeq }),
  });
}

function matchesTransactionIdentity(
  identity: RuntimeIdentity,
  value: TerminalCheckpointWireIdentity,
): boolean {
  return identity.protocolVersion === value.protocolVersion
    && identity.sessionId === value.sessionId
    && identity.viewGeneration === value.viewGeneration
    && identity.streamEpoch === value.streamEpoch
    && identity.checkpointEpoch === value.checkpointEpoch
    && identity.snapshotSeq === value.snapshotSeq
    && identity.oldestRetainedSeq === value.oldestRetainedSeq
    && identity.retentionPolicyId === value.retentionPolicyId
    && identity.connectionId === value.connectionId
    && identity.transitionEpoch === value.transitionEpoch
    && identity.authorityEpoch === value.authorityEpoch
    && identity.responderLeaseId === value.responderLeaseId
    && identity.boundarySourceSeq === value.boundarySourceSeq;
}

function matchesAckRejectionIdentity(
  identity: RuntimeIdentity,
  rejection: TerminalCheckpointAckRejectionIdentity,
): boolean {
  return identity.sessionId === rejection.sessionId
    && identity.viewGeneration === rejection.viewGeneration
    && identity.streamEpoch === rejection.streamEpoch
    && identity.checkpointEpoch === rejection.checkpointEpoch
    && identity.connectionId === rejection.connectionId;
}

function matchesLifecycle(
  identity: RuntimeIdentity,
  metadata: TerminalCheckpointLifecycleMetadata,
): boolean {
  return identity.viewGeneration === metadata.viewGeneration
    && identity.streamEpoch === metadata.streamEpoch
    && identity.checkpointEpoch === metadata.checkpointEpoch
    && identity.sourceSeq === metadata.sourceSeq
    && identity.snapshotSeq === metadata.snapshotSeq
    && identity.oldestRetainedSeq === metadata.oldestRetainedSeq
    && identity.retentionPolicyId === metadata.retentionPolicyId
    && identity.chunkCount === metadata.chunkCount
    && identity.encodedByteTotal === metadata.encodedByteTotal
    && identity.digest === metadata.digest;
}

function matchesDrainedLifecycle(
  identity: RuntimeIdentity,
  metadata: TerminalCheckpointLifecycleMetadata,
): boolean {
  return isCanonicalOrdinal64(metadata.sourceSeq)
    && BigInt(metadata.sourceSeq) >= BigInt(identity.sourceSeq)
    && identity.viewGeneration === metadata.viewGeneration
    && identity.streamEpoch === metadata.streamEpoch
    && identity.checkpointEpoch === metadata.checkpointEpoch
    && identity.snapshotSeq === metadata.snapshotSeq
    && identity.oldestRetainedSeq === metadata.oldestRetainedSeq
    && identity.retentionPolicyId === metadata.retentionPolicyId
    && identity.chunkCount === metadata.chunkCount
    && identity.encodedByteTotal === metadata.encodedByteTotal
    && identity.digest === metadata.digest;
}

function failureReason(reason: string): TerminalCheckpointFailureReason {
  if (reason.includes('digest')) return 'digest-mismatch';
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('overflow')) return 'hold-overflow';
  if (reason.includes('drain')) return 'drain-failed';
  if (reason.includes('generation')) return 'stale-generation';
  if (reason.includes('epoch')) return 'stale-epoch';
  return 'apply-failed';
}

function dispatchUnknown(
  coordinator: TerminalWriteCoordinator,
  command: Readonly<Record<string, unknown>>,
): TerminalWriteCoordinatorResult {
  return (coordinator.dispatch as (
    value: Readonly<Record<string, unknown>>,
  ) => TerminalWriteCoordinatorResult)(command);
}

// @req FR-BGSTAB-022 AC-1 AC-3 AC-4 AC-5 AC-6
// @req REL-BGSTAB-007 AC-4 AC-5 AC-12
export function createTerminalCheckpointRuntime(
  options: TerminalCheckpointRuntimeOptions,
): TerminalCheckpointRuntime {
  let capability: TerminalCheckpointCapabilityMessage | null = null;
  let viewGeneration = options.initialViewGeneration;
  let activeIdentity: RuntimeIdentity | null = null;
  let failedBoundary: FailedBoundary | null = null;
  let failedViewGeneration: number | null = null;
  let requestedRecoveryGeneration: number | null = null;
  let dispatchingStartIdentity: RuntimeIdentity | null = null;
  let recoveryPending = false;
  let legacyRecoveryPending = false;
  let legacyRecoveryCompleted = false;
  let compatibilitySnapshotCompletedViewGeneration: number | null = null;
  let preparedCheckpointReadyReceipt: Readonly<{
    checkpointDeliveryId: string;
    controlSocketId: string;
    enqueueOrdinal: number;
  }> | null = null;
  let orderedRollbackPending = false;
  let orderedRollbackCapabilityCommitted = false;
  let orderedRollbackIdentity: Readonly<{
    viewGeneration: number;
    streamEpoch: string;
    checkpointEpoch: string;
  }> | null = null;
  let applyAcked = false;
  let drainAcked = false;
  let lastDrainAckedSourceSeq: bigint | null = null;
  const sentCheckpointDeliveryIds = new Set<string>();
  let disposed = false;
  let inputSettlementSequence = 0;

  const coordinator = (): TerminalWriteCoordinator | null => (
    disposed ? null : options.getCoordinator()
  );

  const runtimeCapabilityActive = (): boolean => (
    (!legacyRecoveryPending || orderedRollbackPending)
    && (
      capabilityIncludesView(capability, options.sessionId, viewGeneration)
      || (
        recoveryPending
        && requestedRecoveryGeneration !== null
        && capabilityIncludesView(capability, options.sessionId, requestedRecoveryGeneration)
      )
    )
  );

  const sendPreparedCheckpointReady = (): void => {
    const preparation = capability?.checkpointDeliveryPreparation;
    if (!preparation || sentCheckpointDeliveryIds.has(preparation.checkpointDeliveryId)) return;
    const deferredReason = legacyRecoveryPending
      ? 'legacy-recovery-pending'
      : !legacyRecoveryCompleted
        ? 'compatibility-snapshot-not-completed'
        : recoveryPending
          ? 'checkpoint-recovery-pending'
          : !runtimeCapabilityActive()
            ? 'checkpoint-capability-inactive'
            : preparation.viewGeneration !== viewGeneration
              ? 'view-generation-mismatch'
              : null;
    if (deferredReason) {
      options.onPreparedCheckpointReadyDeferred?.({
        checkpointDeliveryId: preparation.checkpointDeliveryId,
        reason: deferredReason,
      });
      return;
    }
    const message: TerminalCheckpointReadyMessage = {
      type: 'terminal-checkpoint:ready',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      viewGeneration,
      authorityEpoch: preparation.authorityEpoch,
      streamEpoch: preparation.streamEpoch,
      driverLeaseGeneration: preparation.driverLeaseGeneration,
      acceptedViewAttributesGeneration: preparation.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: preparation.viewAttributesChallengeId,
      checkpointDeliveryId: preparation.checkpointDeliveryId,
    };
    let receipt = preparedCheckpointReadyReceipt;
    if (
      !receipt
      || receipt.checkpointDeliveryId !== preparation.checkpointDeliveryId
    ) {
      const refreshedReceipt = options.getPreparedCheckpointReadyReceipt?.();
      receipt = refreshedReceipt?.ok
        ? {
            checkpointDeliveryId: preparation.checkpointDeliveryId,
            controlSocketId: refreshedReceipt.controlSocketId,
            enqueueOrdinal: refreshedReceipt.enqueueOrdinal,
          }
        : null;
      preparedCheckpointReadyReceipt = receipt;
      if (!receipt && refreshedReceipt && !refreshedReceipt.ok) {
        options.onPreparedCheckpointReadySendBlocked?.({
          checkpointDeliveryId: preparation.checkpointDeliveryId,
          reason: refreshedReceipt.reason,
          ...(refreshedReceipt.controlSocketId
            ? { actualControlSocketId: refreshedReceipt.controlSocketId }
            : {}),
        });
      }
    }
    if (
      options.sendPreparedCheckpointReady
      && receipt
      && receipt.checkpointDeliveryId === preparation.checkpointDeliveryId
    ) {
      const result = options.sendPreparedCheckpointReady({
        message,
        expectedControlSocketId: receipt.controlSocketId,
        afterEnqueueOrdinal: receipt.enqueueOrdinal,
      });
      if (
        result.ok
        && result.controlSocketId === receipt.controlSocketId
        && result.enqueueOrdinal > receipt.enqueueOrdinal
      ) {
        sentCheckpointDeliveryIds.add(preparation.checkpointDeliveryId);
      } else if (!result.ok) {
        options.onPreparedCheckpointReadySendBlocked?.({
          checkpointDeliveryId: preparation.checkpointDeliveryId,
          reason: result.reason,
          expectedControlSocketId: receipt.controlSocketId,
          ...(result.controlSocketId
            ? { actualControlSocketId: result.controlSocketId }
            : {}),
        });
      } else {
        options.onPreparedCheckpointReadySendBlocked?.({
          checkpointDeliveryId: preparation.checkpointDeliveryId,
          reason: 'control-socket-enqueue-order-regression',
          expectedControlSocketId: receipt.controlSocketId,
          actualControlSocketId: result.controlSocketId,
        });
      }
      return;
    }
    if (!options.sendPreparedCheckpointReady && options.send(message).ok) {
      sentCheckpointDeliveryIds.add(preparation.checkpointDeliveryId);
    }
  };

  const sendFailureAck = (reason: string, identity = activeIdentity): void => {
    if (!identity || !runtimeCapabilityActive()) return;
    options.send({
      type: 'terminal-checkpoint:failure-ack',
      ...wireIdentity(identity),
      reason: failureReason(reason),
    });
  };

  const sendRecoveryRequest = (reason: string): void => {
    if (requestedRecoveryGeneration === null || failedViewGeneration === null) return;
    options.send({
      type: 'terminal-checkpoint:recovery-request',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      failedViewGeneration,
      requestedViewGeneration: requestedRecoveryGeneration,
      reason: failureReason(reason),
      ...(failedBoundary
        ? {
            failedStreamEpoch: failedBoundary.streamEpoch.toString(),
            failedCheckpointEpoch: failedBoundary.checkpointEpoch.toString(),
          }
        : {}),
    });
  };

  const failClosed = (
    reason: string,
    sendAck = true,
    offendingIdentity: RuntimeIdentity | null = null,
    offendingBoundary?: TerminalCheckpointFailureBoundary,
  ): TerminalWriteCoordinatorResult => {
    const effectiveOffendingIdentity = offendingIdentity ?? dispatchingStartIdentity;
    const previousFailedViewGeneration = failedViewGeneration;
    const previousRequestedRecoveryGeneration = requestedRecoveryGeneration;
    const previousStreamEpoch = failedBoundary?.streamEpoch ?? null;
    const previousCheckpointEpoch = failedBoundary?.checkpointEpoch ?? null;
    failedBoundary = laterBoundary(failedBoundary, activeIdentity);
    failedBoundary = laterBoundary(failedBoundary, effectiveOffendingIdentity);
    failedBoundary = laterBoundary(failedBoundary, offendingBoundary ?? null);
    failedViewGeneration = Math.max(
      viewGeneration,
      failedViewGeneration ?? viewGeneration,
      activeIdentity?.viewGeneration ?? viewGeneration,
      effectiveOffendingIdentity?.viewGeneration ?? viewGeneration,
      offendingBoundary?.viewGeneration ?? viewGeneration,
    );
    requestedRecoveryGeneration = Number.isSafeInteger(failedViewGeneration + 1)
      ? failedViewGeneration + 1
      : null;
    if (recoveryPending) {
      const boundaryAdvanced = previousFailedViewGeneration !== failedViewGeneration
        || previousRequestedRecoveryGeneration !== requestedRecoveryGeneration
        || previousStreamEpoch !== (failedBoundary?.streamEpoch ?? null)
        || previousCheckpointEpoch !== (failedBoundary?.checkpointEpoch ?? null);
      if (boundaryAdvanced) sendRecoveryRequest(reason);
      return rejected(reason);
    }

    recoveryPending = true;
    orderedRollbackPending = false;
    orderedRollbackCapabilityCommitted = false;
    orderedRollbackIdentity = null;
    applyAcked = false;
    drainAcked = false;
    lastDrainAckedSourceSeq = null;
    const currentCoordinator = coordinator();
    if (currentCoordinator) {
      dispatchUnknown(currentCoordinator, {
        type: 'recovery-failed',
        viewGeneration,
        reason,
      });
    }
    if (sendAck) sendFailureAck(reason, effectiveOffendingIdentity ?? activeIdentity);
    sendRecoveryRequest(reason);
    options.onAuthorityStateChange?.('recovery-required');
    options.requestFreshRecovery(reason);
    return rejected(reason);
  };

  const installFreshGeneration = (
    message: TerminalCheckpointStartMessage,
  ): TerminalWriteCoordinatorResult => {
    if (!recoveryPending || requestedRecoveryGeneration === null) {
      return rejected('unexpected-view-generation');
    }
    const nextStreamEpoch = BigInt(message.streamEpoch);
    const nextCheckpointEpoch = BigInt(message.checkpointEpoch);
    const boundaryAdvanced = failedBoundary === null
      || nextStreamEpoch > failedBoundary.streamEpoch
      || (
        nextStreamEpoch === failedBoundary?.streamEpoch
        && nextCheckpointEpoch > failedBoundary.checkpointEpoch
      );
    if (
      message.viewGeneration !== requestedRecoveryGeneration
      || !capabilityIncludesView(capability, options.sessionId, message.viewGeneration)
      || !boundaryAdvanced
    ) {
      return rejected('fresh-recovery-generation-required');
    }
    const currentCoordinator = coordinator();
    if (!currentCoordinator) return rejected('checkpoint-coordinator-unavailable');
    const result = dispatchUnknown(currentCoordinator, {
      type: 'install-recovery-generation',
      viewGeneration: message.viewGeneration,
      streamEpoch: message.streamEpoch,
      checkpointEpoch: message.checkpointEpoch,
    });
    if (!result.accepted) return result;
    viewGeneration = message.viewGeneration;
    options.advanceViewGeneration(viewGeneration);
    recoveryPending = false;
    legacyRecoveryPending = false;
    legacyRecoveryCompleted = false;
    orderedRollbackPending = false;
    orderedRollbackCapabilityCommitted = false;
    orderedRollbackIdentity = null;
    requestedRecoveryGeneration = null;
    activeIdentity = null;
    failedBoundary = null;
    failedViewGeneration = null;
    applyAcked = false;
    drainAcked = false;
    lastDrainAckedSourceSeq = null;
    return ACCEPTED;
  };

  const rollbackToLegacy = (
    reason: string,
    nextCapability: TerminalCheckpointCapabilityMessage | null = null,
    rollbackOptions: Readonly<{ requestFreshRecovery?: boolean }> = {},
  ): TerminalWriteCoordinatorResult => {
    if (disposed) return rejected('disposed');
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return rejected('invalid-rollback-reason');
    }
    const currentCoordinator = coordinator();
    if (!currentCoordinator) return rejected('checkpoint-coordinator-unavailable');
    const nextViewGeneration = Math.max(
      viewGeneration + 1,
      (failedViewGeneration ?? viewGeneration) + 1,
      requestedRecoveryGeneration ?? viewGeneration + 1,
      (activeIdentity?.viewGeneration ?? viewGeneration) + 1,
    );
    if (!Number.isSafeInteger(nextViewGeneration)) {
      return rejected('view-generation-exhausted');
    }
    const result = dispatchUnknown(currentCoordinator, {
      type: 'rollback-to-compatibility',
      viewGeneration: nextViewGeneration,
      reason,
    });
    if (!result.accepted) return result;

    viewGeneration = nextViewGeneration;
    capability = nextCapability;
    activeIdentity = null;
    failedBoundary = null;
    failedViewGeneration = null;
    requestedRecoveryGeneration = null;
    dispatchingStartIdentity = null;
    recoveryPending = false;
    legacyRecoveryPending = true;
    legacyRecoveryCompleted = false;
    orderedRollbackPending = false;
    orderedRollbackCapabilityCommitted = false;
    orderedRollbackIdentity = null;
    applyAcked = false;
    drainAcked = false;
    lastDrainAckedSourceSeq = null;
    options.advanceViewGeneration(viewGeneration);
    options.onAuthorityStateChange?.('legacy-recovery-pending');
    if (rollbackOptions.requestFreshRecovery !== false) {
      options.requestFreshRecovery(reason);
    }
    return ACCEPTED;
  };

  const beginCompatibilityRollback = (
    message: TerminalAuthorityRollbackStartMessage,
  ): TerminalWriteCoordinatorResult => {
    if (disposed) return rejected('disposed');
    if (message.sessionId !== options.sessionId) {
      return rejected('checkpoint-session-mismatch');
    }
    const affectedView = message.affectedViews.find(view => view.viewGeneration === viewGeneration);
    if (!affectedView || !runtimeCapabilityActive()) {
      return rejected('checkpoint-delivery-inactive');
    }
    const currentCoordinator = coordinator();
    if (!currentCoordinator) return rejected('checkpoint-coordinator-unavailable');
    const result = dispatchUnknown(currentCoordinator, {
      type: 'install-rollback-checkpoint-boundary',
      viewGeneration,
      streamEpoch: message.streamEpoch,
      checkpointEpoch: message.checkpointEpoch,
      reason: 'terminal-authority-rollback-start',
    });
    if (!result.accepted) return result;

    activeIdentity = null;
    failedBoundary = null;
    failedViewGeneration = null;
    requestedRecoveryGeneration = null;
    dispatchingStartIdentity = null;
    recoveryPending = false;
    legacyRecoveryPending = true;
    legacyRecoveryCompleted = false;
    orderedRollbackPending = true;
    orderedRollbackCapabilityCommitted = false;
    orderedRollbackIdentity = Object.freeze({
      viewGeneration,
      streamEpoch: message.streamEpoch,
      checkpointEpoch: message.checkpointEpoch,
    });
    applyAcked = false;
    drainAcked = false;
    lastDrainAckedSourceSeq = null;
    options.onAuthorityStateChange?.('checkpoint-pending');
    return ACCEPTED;
  };

  const beginLegacyRecovery = (reason: string): TerminalWriteCoordinatorResult => {
    if (disposed) return rejected('disposed');
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return rejected('invalid-legacy-recovery-reason');
    }
    const currentCoordinator = coordinator();
    if (!currentCoordinator) return rejected('checkpoint-coordinator-unavailable');
    const coordinatorState = currentCoordinator.getState();
    if (coordinatorState.runtimeRecreationRequired) {
      options.onAuthorityStateChange?.('runtime-recreation-required');
      return rejected('runtime-recreation-required');
    }
    const nextViewGeneration = Math.max(viewGeneration, coordinatorState.viewGeneration) + 1;
    if (!Number.isSafeInteger(nextViewGeneration)) return rejected('view-generation-exhausted');
    const result = dispatchUnknown(currentCoordinator, {
      type: 'install-compatibility-recovery-generation',
      viewGeneration: nextViewGeneration,
      reason,
    });
    if (!result.accepted) return result;
    viewGeneration = nextViewGeneration;
    activeIdentity = null;
    recoveryPending = false;
    legacyRecoveryPending = true;
    legacyRecoveryCompleted = false;
    orderedRollbackPending = false;
    orderedRollbackCapabilityCommitted = false;
    orderedRollbackIdentity = null;
    requestedRecoveryGeneration = null;
    applyAcked = false;
    drainAcked = false;
    lastDrainAckedSourceSeq = null;
    options.advanceViewGeneration(viewGeneration);
    options.onAuthorityStateChange?.('legacy-recovery-pending');
    return ACCEPTED;
  };

  const completeLegacyRecovery = (
    completion: TerminalLegacyRecoveryCompletion,
  ): TerminalWriteCoordinatorResult => {
    if (disposed) return rejected('disposed');
    if (!legacyRecoveryPending) {
      if (completion.source === 'compatibility-snapshot') {
        compatibilitySnapshotCompletedViewGeneration = viewGeneration;
      }
      const preparation = capability?.checkpointDeliveryPreparation;
      if (
        legacyRecoveryCompleted
        || completion.source !== 'compatibility-snapshot'
        || !preparation
        || preparation.viewGeneration !== viewGeneration
        || !runtimeCapabilityActive()
      ) {
        return rejected('legacy-recovery-not-pending');
      }
      legacyRecoveryCompleted = true;
      sendPreparedCheckpointReady();
      return ACCEPTED;
    }
    if (orderedRollbackPending) {
      const passiveSnapshotCompletion = completion.source === 'compatibility-snapshot'
        && capability?.compatibilityRecoveryRole === 'passive-snapshot';
      if (completion.source !== 'legacy-responder-enabled' && !passiveSnapshotCompletion) {
        return rejected('ordered-rollback-enable-required');
      }
      if (!orderedRollbackIdentity) {
        return rejected('ordered-rollback-enable-identity-mismatch');
      }
      if (completion.source === 'legacy-responder-enabled' && (
        completion.viewGeneration !== orderedRollbackIdentity.viewGeneration
        || completion.streamEpoch !== orderedRollbackIdentity.streamEpoch
        || completion.checkpointEpoch !== orderedRollbackIdentity.checkpointEpoch
      )) {
        return rejected('ordered-rollback-enable-identity-mismatch');
      }
      if (!applyAcked || !drainAcked || !orderedRollbackCapabilityCommitted) {
        return rejected('ordered-rollback-not-committed');
      }
      const currentCoordinator = coordinator();
      if (!currentCoordinator) return rejected('checkpoint-coordinator-unavailable');
      const completionResult = dispatchUnknown(currentCoordinator, {
        type: 'complete-ordered-compatibility-recovery',
        viewGeneration,
        streamEpoch: orderedRollbackIdentity.streamEpoch,
        checkpointEpoch: orderedRollbackIdentity.checkpointEpoch,
      });
      if (!completionResult.accepted) return completionResult;
      orderedRollbackPending = false;
      orderedRollbackCapabilityCommitted = false;
      orderedRollbackIdentity = null;
      legacyRecoveryPending = false;
      legacyRecoveryCompleted = true;
      activeIdentity = null;
      applyAcked = false;
      drainAcked = false;
      lastDrainAckedSourceSeq = null;
      options.onAuthorityStateChange?.('legacy');
      return ACCEPTED;
    }
    const currentCoordinator = coordinator();
    if (!currentCoordinator) return rejected('checkpoint-coordinator-unavailable');
    const result = dispatchUnknown(currentCoordinator, {
      type: 'complete-compatibility-recovery',
      viewGeneration,
    });
    if (!result.accepted) return result;
    legacyRecoveryPending = false;
    legacyRecoveryCompleted = true;
    options.onAuthorityStateChange?.(runtimeCapabilityActive() ? 'checkpoint-pending' : 'legacy');
    sendPreparedCheckpointReady();
    return ACCEPTED;
  };

  const handleMessage = (
    message: TerminalCheckpointServerMessage,
  ): TerminalWriteCoordinatorResult => {
    if (!runtimeCapabilityActive()) return rejected('checkpoint-delivery-inactive');
    if (disposed) return rejected('disposed');
    if (message.type === 'terminal-checkpoint:capability') {
      capability = message;
      return ACCEPTED;
    }
    if (message.type === 'terminal-checkpoint:rejected') {
      const stalePreRollbackAck = message.phase === 'ack'
        && activeIdentity === null
        && orderedRollbackPending
        && orderedRollbackIdentity !== null
        && message.sessionId === options.sessionId
        && message.ackIdentity !== undefined
        && message.ackIdentity.viewGeneration === orderedRollbackIdentity.viewGeneration
        && (
          message.ackIdentity.streamEpoch !== orderedRollbackIdentity.streamEpoch
          || message.ackIdentity.checkpointEpoch !== orderedRollbackIdentity.checkpointEpoch
        );
      if (stalePreRollbackAck) return rejected('stale-rollback-server-rejection');
      if (message.phase === 'ack' && activeIdentity === null) {
        return rejected('uncorrelatable-server-rejection');
      }
      if (message.phase === 'ack' && activeIdentity !== null) {
        if (
          message.ackIdentity === undefined
          || message.ackIdentity.connectionId === undefined
          || activeIdentity.connectionId === undefined
        ) {
          return rejected('uncorrelatable-server-rejection');
        }
        if (!matchesAckRejectionIdentity(activeIdentity, message.ackIdentity)) {
          return rejected('stale-server-rejection');
        }
      }
      return failClosed(`checkpoint-server-rejected:${message.reason}`, false);
    }
    if (
      message.type === 'terminal-checkpoint:continuity-rebound'
      || message.type === 'terminal-checkpoint:fresh-checkpoint-required'
    ) {
      return rejected('checkpoint-control-frame');
    }
    if (message.sessionId !== options.sessionId) {
      return rejected('checkpoint-session-mismatch');
    }
    if (message.viewGeneration < viewGeneration) {
      return rejected('stale-view-generation');
    }
    if (message.viewGeneration !== viewGeneration) {
      if (
        message.type === 'terminal-checkpoint:start'
        && message.viewGeneration > viewGeneration
      ) {
        const candidateIdentity = identityFromStart(message);
        const installed = installFreshGeneration(message);
        if (!installed.accepted) {
          return failClosed(
            installed.reason ?? 'fresh-recovery-generation-required',
            true,
            candidateIdentity,
          );
        }
      } else {
        return failClosed('checkpoint-stale-generation');
      }
    } else if (recoveryPending) {
      return message.type === 'terminal-checkpoint:start'
        ? failClosed(
            'fresh-recovery-generation-required',
            true,
            identityFromStart(message),
          )
        : rejected('fresh-recovery-generation-required');
    }

    const currentCoordinator = coordinator();
    if (!currentCoordinator) return failClosed('checkpoint-coordinator-unavailable');

    try {
      if (message.type === 'terminal-checkpoint:start') {
        if (!isTerminalCheckpointModes(message.modes)) {
          return failClosed('checkpoint-unsupported-mode');
        }
        const candidateIdentity = identityFromStart(message);
        if (!terminalCheckpointRetainedStateDigestMatches(message)) {
          return failClosed(
            'checkpoint-retained-state-digest-mismatch',
            true,
            candidateIdentity,
          );
        }
        dispatchingStartIdentity = candidateIdentity;
        let result: TerminalWriteCoordinatorResult;
        try {
          result = dispatchUnknown(currentCoordinator, {
            type: 'checkpoint-begin',
            ...candidateIdentity,
            digest: candidateIdentity.digest,
            cols: message.sourceGeometry.cols,
            rows: message.sourceGeometry.rows,
            modes: message.modes,
            parserTail: decodeBase64(message.parserTail.data, message.parserTail.encodedBytes),
          });
        } catch {
          dispatchingStartIdentity = null;
          return failClosed('checkpoint-decode-or-dispatch-failed', true, candidateIdentity);
        }
        dispatchingStartIdentity = null;
        if (!result.accepted) {
          return failClosed(
            result.reason ?? 'checkpoint-begin-rejected',
            true,
            candidateIdentity,
          );
        }
        if (recoveryPending) {
          return rejected('recovery-required');
        }
        activeIdentity = candidateIdentity;
        applyAcked = false;
        drainAcked = false;
        lastDrainAckedSourceSeq = null;
        options.onAuthorityStateChange?.('checkpoint-pending');
        return result;
      }

      if (
        !activeIdentity
        || !matchesTransactionIdentity(activeIdentity, message)
        || (
          message.type !== 'terminal-checkpoint:output'
          && activeIdentity.sourceSeq !== message.sourceSeq
        )
      ) {
        return failClosed('checkpoint-identity-mismatch');
      }

      if (message.type === 'terminal-checkpoint:chunk') {
        const result = dispatchUnknown(currentCoordinator, {
          type: 'checkpoint-chunk',
          ...activeIdentity,
          index: message.chunkIndex,
          count: message.chunkCount,
          data: decodeBase64(message.data, message.encodedBytes),
        });
        if (!result.accepted) return failClosed(result.reason ?? 'checkpoint-chunk-rejected');
        return result;
      }

      if (message.type === 'terminal-checkpoint:commit') {
        const commit = message as TerminalCheckpointCommitMessage;
        if (
          commit.chunkCount !== activeIdentity.chunkCount
          || commit.encodedByteTotal !== activeIdentity.encodedByteTotal
          || digestWireValue(commit.digest) !== activeIdentity.digest
          || commit.retainedStateDigest !== activeIdentity.retainedStateDigest
        ) {
          return failClosed('checkpoint-commit-metadata-mismatch');
        }
        const result = dispatchUnknown(currentCoordinator, {
          type: 'checkpoint-commit',
          ...activeIdentity,
        });
        if (!result.accepted) return failClosed(result.reason ?? 'checkpoint-commit-rejected');
        return result;
      }

      const result = dispatchUnknown(currentCoordinator, {
        type: 'live',
        ...activeIdentity,
        sourceSeq: message.sourceSeq,
        data: decodeBase64(message.data, message.encodedBytes),
        settlementToken: [
          message.sessionId,
          message.viewGeneration,
          message.streamEpoch,
          message.sourceSeq,
        ].join(':'),
      });
      if (!result.accepted) return failClosed(result.reason ?? 'checkpoint-output-rejected');
      return result;
    } catch {
      return failClosed('checkpoint-decode-or-dispatch-failed');
    }
  };

  const sendLifecycleAck = (
    phase: 'apply' | 'drain',
    metadata: TerminalCheckpointLifecycleMetadata,
  ): TerminalWriteCoordinatorResult => {
    if (!runtimeCapabilityActive()) return rejected('checkpoint-delivery-inactive');
    if (metadata.viewGeneration < viewGeneration) return rejected('stale-view-generation');
    const lifecycleMatches = activeIdentity && (
      phase === 'apply'
        ? matchesLifecycle(activeIdentity, metadata)
        : matchesDrainedLifecycle(activeIdentity, metadata)
    );
    if (!activeIdentity || !lifecycleMatches) {
      return rejected('checkpoint-identity-mismatch');
    }
    if (phase === 'drain' && !applyAcked) {
      return failClosed('checkpoint-drain-before-apply');
    }
    const drainedThroughSourceSeq = phase === 'drain' ? BigInt(metadata.sourceSeq) : null;
    if (
      (phase === 'apply' && applyAcked)
      || (
        phase === 'drain'
        && drainAcked
        && lastDrainAckedSourceSeq !== null
        && drainedThroughSourceSeq !== null
        && drainedThroughSourceSeq <= lastDrainAckedSourceSeq
      )
    ) {
      return ACCEPTED;
    }
    const message = phase === 'apply'
      ? {
          type: 'terminal-checkpoint:apply-ack' as const,
          ...wireIdentity(activeIdentity),
          appliedThroughSeq: activeIdentity.snapshotSeq,
        }
      : {
          type: 'terminal-checkpoint:drain-ack' as const,
          ...wireIdentity(activeIdentity),
          drainedThroughSeq: metadata.sourceSeq,
        };
    const sent = options.send(message);
    if (!sent.ok) {
      return failClosed(`checkpoint-${phase}-ack-send-failed`, false);
    }
    if (phase === 'apply') {
      applyAcked = true;
    }
    else {
      drainAcked = true;
      lastDrainAckedSourceSeq = drainedThroughSourceSeq;
      options.onAuthorityStateChange?.('checkpoint-drained');
    }
    return ACCEPTED;
  };

  return Object.freeze({
    setCapability(
      nextCapability: TerminalCheckpointCapabilityMessage | null,
    ): TerminalWriteCoordinatorResult {
      const currentCapability = capability;
      const currentRecoveryRole = currentCapability?.compatibilityRecoveryRole;
      const preserveOrderedRollbackRole = orderedRollbackPending
        && currentCapability !== null
        && currentRecoveryRole !== undefined
        && nextCapability?.compatibilityRecoveryRole === undefined
        && currentCapability.authorityMode === 'legacy'
        && currentCapability.checkpointDeliveryActive === false
        && nextCapability?.authorityMode === 'legacy'
        && nextCapability.checkpointDeliveryActive === false
        && currentCapability.registeredViews?.some(view => (
          view.sessionId === options.sessionId && view.viewGeneration === viewGeneration
        )) === true
        && nextCapability.registeredViews?.some(view => (
          view.sessionId === options.sessionId && view.viewGeneration === viewGeneration
        )) === true;
      const effectiveCapability = preserveOrderedRollbackRole
        ? Object.freeze({
            ...nextCapability,
            compatibilityRecoveryRole: currentRecoveryRole,
          })
        : nextCapability;
      const wasActive = runtimeCapabilityActive();
      const nextActive = (!legacyRecoveryPending || orderedRollbackPending) && (
        capabilityIncludesView(effectiveCapability, options.sessionId, viewGeneration)
        || (
          recoveryPending
          && requestedRecoveryGeneration !== null
          && capabilityIncludesView(effectiveCapability, options.sessionId, requestedRecoveryGeneration)
        )
      );
      if (wasActive && !nextActive) {
        const orderedRollbackCommit = orderedRollbackPending
          && applyAcked
          && drainAcked
          && effectiveCapability?.authorityMode === 'legacy'
          && effectiveCapability.checkpointDeliveryActive === false
          && effectiveCapability.registeredViews?.some(view => (
            view.sessionId === options.sessionId
            && view.viewGeneration === viewGeneration
          ));
        if (orderedRollbackCommit) {
          capability = effectiveCapability;
          legacyRecoveryPending = true;
          legacyRecoveryCompleted = false;
          orderedRollbackCapabilityCommitted = true;
          options.onAuthorityStateChange?.('legacy-recovery-pending');
          return ACCEPTED;
        }
        return rollbackToLegacy('checkpoint-capability-deactivated', effectiveCapability);
      }
      capability = effectiveCapability;
      const preparation = effectiveCapability?.checkpointDeliveryPreparation;
      if (
        preparation
        && preparedCheckpointReadyReceipt?.checkpointDeliveryId !== preparation.checkpointDeliveryId
      ) {
        const receipt = options.getPreparedCheckpointReadyReceipt?.();
        preparedCheckpointReadyReceipt = receipt?.ok
          ? {
              checkpointDeliveryId: preparation.checkpointDeliveryId,
              controlSocketId: receipt.controlSocketId,
              enqueueOrdinal: receipt.enqueueOrdinal,
            }
          : null;
      }
      const registration = effectiveCapability?.registeredViews?.find(view => (
        view.sessionId === options.sessionId
        && (view.viewGeneration === viewGeneration
          || view.viewGeneration === requestedRecoveryGeneration)
      ));
      if (effectiveCapability && registration) {
        options.onCapabilityRegistration?.(effectiveCapability, registration);
      }
      const active = runtimeCapabilityActive();
      if (!wasActive && active) {
        options.onAuthorityStateChange?.('checkpoint-pending');
      }
      if (
        !legacyRecoveryPending
        && !legacyRecoveryCompleted
        && compatibilitySnapshotCompletedViewGeneration === viewGeneration
        && preparation?.viewGeneration === viewGeneration
        && runtimeCapabilityActive()
      ) {
        legacyRecoveryCompleted = true;
      }
      sendPreparedCheckpointReady();
      return ACCEPTED;
    },
    rollbackToLegacy: (
      reason: string,
      rollbackOptions?: Readonly<{ requestFreshRecovery?: boolean }>,
    ) => rollbackToLegacy(reason, null, rollbackOptions),
    beginCompatibilityRollback,
    beginLegacyRecovery,
    completeLegacyRecovery,
    handleMessage,
    submitInput(data: string): TerminalWriteCoordinatorResult {
      if (legacyRecoveryPending) return rejected('legacy-recovery-pending');
      if (recoveryPending) return rejected('checkpoint-recovery-pending');
      if (!runtimeCapabilityActive()) return rejected('checkpoint-delivery-inactive');
      const currentCoordinator = coordinator();
      if (!currentCoordinator) return failClosed('checkpoint-coordinator-unavailable');
      return dispatchUnknown(currentCoordinator, {
        type: 'queue-input',
        viewGeneration,
        data,
        settlementToken: [
          options.sessionId,
          viewGeneration,
          'input',
          ++inputSettlementSequence,
        ].join(':'),
      });
    },
    checkpointApplied: (metadata: TerminalCheckpointLifecycleMetadata) => sendLifecycleAck('apply', metadata),
    checkpointDrained: (metadata: TerminalCheckpointLifecycleMetadata) => sendLifecycleAck('drain', metadata),
    coordinatorRecoveryFailed: (
      reason: string,
      boundary?: TerminalCheckpointFailureBoundary,
    ) => {
      if (
        boundary?.viewGeneration !== undefined
        && boundary.viewGeneration < viewGeneration
      ) {
        return rejected('stale-view-generation');
      }
      if (!runtimeCapabilityActive() && !recoveryPending) {
        return rejected('checkpoint-delivery-inactive');
      }
      failClosed(reason, true, null, boundary);
      return ACCEPTED;
    },
    getState: () => {
      const active = runtimeCapabilityActive();
      const ready = active
        && activeIdentity !== null
        && applyAcked
        && drainAcked
        && !recoveryPending
        && !legacyRecoveryPending;
      return Object.freeze({
        active,
        ready,
        ...(
          active
          && activeIdentity !== null
          && !drainAcked
          && !recoveryPending
          && !legacyRecoveryPending
            ? { readyBarrier: 'matching-checkpoint-drain-ack' as const }
            : {}
        ),
      disposed,
      recoveryPending,
      legacyRecoveryPending,
      checkpointDeliveryPreparationPending: (
        capability?.checkpointDeliveryPreparation !== undefined
        && !legacyRecoveryCompleted
        && capability.checkpointDeliveryPreparation.viewGeneration === viewGeneration
        && runtimeCapabilityActive()
      ),
      orderedRollbackPending,
      viewGeneration,
      registrationViewGeneration: requestedRecoveryGeneration ?? viewGeneration,
      });
    },
    dispose(): void {
      const currentCoordinator = coordinator();
      currentCoordinator?.dispatch({ type: 'dispose', viewGeneration });
      disposed = true;
      capability = null;
      activeIdentity = null;
      applyAcked = false;
      drainAcked = false;
      lastDrainAckedSourceSeq = null;
      requestedRecoveryGeneration = null;
      recoveryPending = false;
      legacyRecoveryPending = false;
      legacyRecoveryCompleted = false;
      orderedRollbackPending = false;
      orderedRollbackCapabilityCommitted = false;
      orderedRollbackIdentity = null;
      dispatchingStartIdentity = null;
      failedViewGeneration = null;
    },
  });
}

// @req FR-BGSTAB-022 AC-1 AC-4 AC-7
export function createTerminalCheckpointDispatcherRegistry(): TerminalCheckpointDispatcherRegistry {
  let defaultCapability: TerminalCheckpointCapabilityMessage | null = null;
  const capabilitiesBySession = new Map<string, TerminalCheckpointCapabilityMessage>();
  const deferredCapabilitiesBySession = new Map<string, TerminalCheckpointCapabilityMessage>();
  const appliedRegistrationCapabilitiesBySession = new Map<string, TerminalCheckpointCapabilityMessage>();
  const dispatchers = new Map<string, TerminalCheckpointRuntime>();
  const capabilityFor = (sessionId: string): TerminalCheckpointCapabilityMessage | null => (
    capabilitiesBySession.get(sessionId) ?? defaultCapability
  );
  const scopeCapabilityToSessions = (
    capability: TerminalCheckpointCapabilityMessage,
    sessionIds: ReadonlySet<string>,
  ): TerminalCheckpointCapabilityMessage | null => {
    const views = (capability.registeredViews ?? []).filter(view => sessionIds.has(view.sessionId));
    if (views.length === 0) return null;
    return Object.freeze({
      ...capability,
      registeredViews: Object.freeze(views),
      ...(capability.mutationLeases
        ? {
            mutationLeases: Object.freeze(capability.mutationLeases.filter(
              lease => sessionIds.has(lease.sessionId),
            )),
          }
        : {}),
    });
  };
  const selectFreshCapability = (
    nextCapability: TerminalCheckpointCapabilityMessage,
  ): TerminalCheckpointCapabilityMessage | null => {
    const incomingViews = nextCapability.registeredViews ?? [];
    if (incomingViews.length === 0) {
      return nextCapability;
    }
    const freshViews = incomingViews.filter(view => {
      const dispatcher = dispatchers.get(view.sessionId);
      const currentGeneration = dispatcher?.getState().registrationViewGeneration;
      if (currentGeneration === view.viewGeneration) return true;
      if (currentGeneration === undefined || view.viewGeneration > currentGeneration) {
        const currentDeferred = deferredCapabilitiesBySession.get(view.sessionId);
        const currentDeferredGeneration = currentDeferred?.registeredViews?.find(
          candidate => candidate.sessionId === view.sessionId,
        )?.viewGeneration ?? -1;
        if (view.viewGeneration >= currentDeferredGeneration) {
          const scoped = scopeCapabilityToSessions(nextCapability, new Set([view.sessionId]));
          if (scoped) deferredCapabilitiesBySession.set(view.sessionId, scoped);
        }
      }
      return false;
    });
    if (freshViews.length === 0) return null;
    const freshViewKeys = new Set(
      freshViews.map(view => `${view.sessionId}\u0000${view.viewGeneration}`),
    );
    return Object.freeze({
      ...nextCapability,
      registeredViews: Object.freeze(freshViews),
      ...(nextCapability.mutationLeases
        ? {
            mutationLeases: Object.freeze(nextCapability.mutationLeases.filter(lease => (
              freshViewKeys.has(`${lease.sessionId}\u0000${lease.viewGeneration}`)
            ))),
          }
        : {}),
    });
  };
  return Object.freeze({
    selectFreshCapability,
    releaseCapability(sessionId: string): void {
      capabilitiesBySession.delete(sessionId);
      deferredCapabilitiesBySession.delete(sessionId);
      appliedRegistrationCapabilitiesBySession.delete(sessionId);
    },
    takeAppliedRegistrationCapability(sessionId: string): TerminalCheckpointCapabilityMessage | null {
      const applied = appliedRegistrationCapabilitiesBySession.get(sessionId) ?? null;
      appliedRegistrationCapabilitiesBySession.delete(sessionId);
      return applied;
    },
    setCapability(
      nextCapability: TerminalCheckpointCapabilityMessage | null,
    ): TerminalCheckpointCapabilityMessage | null {
      if (!nextCapability) {
        defaultCapability = null;
        capabilitiesBySession.clear();
        deferredCapabilitiesBySession.clear();
        appliedRegistrationCapabilitiesBySession.clear();
        for (const dispatcher of dispatchers.values()) dispatcher.setCapability(null);
        return null;
      }
      const scopedSessionIds = new Set(
        (nextCapability.registeredViews ?? []).map(view => view.sessionId),
      );
      if (scopedSessionIds.size === 0) {
        defaultCapability = nextCapability;
        capabilitiesBySession.clear();
        deferredCapabilitiesBySession.clear();
        appliedRegistrationCapabilitiesBySession.clear();
        let accepted = true;
        for (const dispatcher of dispatchers.values()) {
          if (!dispatcher.setCapability(nextCapability).accepted) accepted = false;
        }
        if (!accepted) defaultCapability = null;
        return accepted ? nextCapability : null;
      }
      const appliedSessionIds = new Set<string>();
      for (const sessionId of scopedSessionIds) {
        const sessionCapability = scopeCapabilityToSessions(
          nextCapability,
          new Set([sessionId]),
        );
        if (!sessionCapability) continue;
        const incomingViewGeneration = nextCapability.registeredViews?.find(
          view => view.sessionId === sessionId,
        )?.viewGeneration;
        const dispatcher = dispatchers.get(sessionId);
        const currentRegistrationViewGeneration = dispatcher?.getState().registrationViewGeneration ?? -1;
        if (incomingViewGeneration !== undefined
          && incomingViewGeneration < currentRegistrationViewGeneration) {
          continue;
        }
        if (!dispatcher) {
          capabilitiesBySession.set(sessionId, sessionCapability);
          continue;
        }
        const application = dispatcher?.setCapability(sessionCapability);
        const appliedViewGeneration = dispatcher?.getState().registrationViewGeneration;
        if (application?.accepted === true
          && incomingViewGeneration === appliedViewGeneration) {
          capabilitiesBySession.set(sessionId, sessionCapability);
          const deferredGeneration = deferredCapabilitiesBySession.get(sessionId)
            ?.registeredViews?.find(view => view.sessionId === sessionId)?.viewGeneration ?? -1;
          if (deferredGeneration <= appliedViewGeneration) {
            deferredCapabilitiesBySession.delete(sessionId);
          }
          appliedRegistrationCapabilitiesBySession.delete(sessionId);
          appliedSessionIds.add(sessionId);
        } else {
          capabilitiesBySession.delete(sessionId);
        }
      }
      return scopeCapabilityToSessions(nextCapability, appliedSessionIds);
    },
    register(sessionId: string, dispatcher: TerminalCheckpointRuntime): () => boolean {
      const previous = dispatchers.get(sessionId);
      if (previous && previous !== dispatcher) {
        previous.setCapability(null);
      }
      dispatchers.set(sessionId, dispatcher);
      const cachedCapability = capabilityFor(sessionId);
      const cachedApplication = dispatcher.setCapability(cachedCapability);
      const currentGeneration = dispatcher.getState().registrationViewGeneration;
      const cachedGeneration = cachedCapability?.registeredViews?.find(
        view => view.sessionId === sessionId,
      )?.viewGeneration;
      if (cachedApplication.accepted && cachedGeneration === currentGeneration) {
        appliedRegistrationCapabilitiesBySession.set(sessionId, cachedCapability!);
      } else {
        appliedRegistrationCapabilitiesBySession.delete(sessionId);
      }
      const deferred = deferredCapabilitiesBySession.get(sessionId);
      const deferredGeneration = deferred?.registeredViews?.find(
        view => view.sessionId === sessionId,
      )?.viewGeneration;
      if (deferredGeneration !== undefined && deferredGeneration <= currentGeneration) {
        deferredCapabilitiesBySession.delete(sessionId);
        if (deferredGeneration === currentGeneration) {
          const application = dispatcher.setCapability(deferred!);
          if (
            application.accepted
            && dispatcher.getState().registrationViewGeneration === deferredGeneration
          ) {
            capabilitiesBySession.set(sessionId, deferred!);
            appliedRegistrationCapabilitiesBySession.set(sessionId, deferred!);
          } else {
            capabilitiesBySession.delete(sessionId);
          }
        }
      }
      return () => {
        if (dispatchers.get(sessionId) === dispatcher) {
          dispatchers.delete(sessionId);
          return true;
        }
        return false;
      };
    },
    route(message: TerminalCheckpointServerMessage): TerminalCheckpointRouteResult {
      if (message.type === 'terminal-checkpoint:capability') {
        return Object.freeze({ delivered: false, reason: 'checkpoint-not-session-frame' });
      }
      const sessionId = message.sessionId;
      if (!sessionId) {
        return Object.freeze({ delivered: false, reason: 'checkpoint-session-unavailable' });
      }
      if (!isActiveCapability(capabilityFor(sessionId))) {
        return Object.freeze({
          delivered: false,
          reason: 'checkpoint-delivery-inactive',
        });
      }
      const dispatcher = dispatchers.get(sessionId);
      if (!dispatcher) {
        return Object.freeze({ delivered: false, reason: 'checkpoint-dispatcher-unavailable' });
      }
      const decision = dispatcher.handleMessage(message);
      return decision.accepted
        ? Object.freeze({ delivered: true })
        : Object.freeze({
            delivered: false,
            handled: true,
            reason: decision.reason ?? 'checkpoint-dispatch-rejected',
          });
    },
    failSession(
      sessionId: string,
      reason: string,
      boundary?: TerminalCheckpointFailureBoundary,
    ): TerminalCheckpointRouteResult {
      if (!isActiveCapability(capabilityFor(sessionId))) {
        return Object.freeze({ delivered: false, reason: 'checkpoint-delivery-inactive' });
      }
      const dispatcher = dispatchers.get(sessionId);
      if (!dispatcher) {
        return Object.freeze({ delivered: false, reason: 'checkpoint-dispatcher-unavailable' });
      }
      const state = dispatcher.getState();
      if (!state.active && !state.recoveryPending) {
        return Object.freeze({ delivered: false, reason: 'checkpoint-delivery-inactive' });
      }
      const decision = dispatcher.coordinatorRecoveryFailed(reason, boundary);
      return Object.freeze({
        delivered: false,
        handled: true,
        reason: decision.reason ?? reason,
      });
    },
    failActive(reason: string, boundary?: TerminalCheckpointFailureBoundary): number {
      let failedSessions = 0;
      for (const [sessionId, dispatcher] of dispatchers) {
        if (!isActiveCapability(capabilityFor(sessionId))) continue;
        const state = dispatcher.getState();
        if (!state.active && !state.recoveryPending) continue;
        dispatcher.coordinatorRecoveryFailed(reason, boundary);
        failedSessions += 1;
      }
      return failedSessions;
    },
    listViews: () => Object.freeze(Array.from(dispatchers.entries(), ([sessionId, dispatcher]) => (
      Object.freeze({
        sessionId,
        viewGeneration: dispatcher.getState().registrationViewGeneration,
      })
    ))),
  });
}

export type ImmediateTerminalControlSendResult = Readonly<{
  ok: true;
  controlSocketId: string;
  enqueueOrdinal: number;
}> | Readonly<{
  ok: false;
  reason: string;
  queued?: boolean;
  controlSocketId: string;
}>;

export interface TerminalResponderHandoffResult {
  accepted: boolean;
  reason?: string;
  promotionAbortRequired?: boolean;
  compatibilityDrainIdentity?: TerminalCompatibilityDrainIdentity;
}

export interface TerminalResponderHandoffRuntimeState {
  legacyParserRepliesEnabled: boolean;
  promotionAbortRequired: boolean;
  compatibilityDrainCompleted: boolean;
}

export interface TerminalResponderHandoffRuntimeOptions {
  identity: TerminalResponderBoundaryIdentity;
  lifecycleGeneration: number;
  legacyParserRepliesInitiallyEnabled: boolean;
  awaitOutputIdleWithFifoProbe: (
    identity: TerminalResponderBoundaryIdentity,
  ) => Promise<boolean>;
  awaitCompatibilityDrain: (
    identity: TerminalCompatibilityDrainIdentity,
  ) => Promise<boolean>;
  flushPendingQueryRepliesImmediately: (
    identity: TerminalResponderBoundaryIdentity,
  ) => Promise<ImmediateTerminalControlSendResult> | ImmediateTerminalControlSendResult;
  setLegacyParserRepliesEnabled: (enabled: boolean) => void;
  sendResponderControl: (input: {
    message: Readonly<Record<string, unknown>>;
    expectedControlSocketId: string;
    afterEnqueueOrdinal: number;
  }) => ImmediateTerminalControlSendResult;
  onPromotionAbortRequired: (reason: string) => void;
  onRecoveryRestartRequired?: (reason: 'runtime-replaced') => void;
  resolveLegacyParserQueryReplies?: (data: string) => readonly string[];
  forwardUserInput: (input: {
    data: string;
    kind: 'key' | 'paste' | 'ime' | 'mouse';
  }) => void;
}

export interface TerminalResponderHandoffRuntime {
  readonly lifecycleGeneration: number;
  disableLegacyParserRepliesAtBoundary(
    identity: TerminalResponderBoundaryIdentity,
  ): Promise<TerminalResponderHandoffResult>;
  restoreLegacyParserRepliesAfterCompatibilityDrain(
    identity: TerminalCompatibilityDrainIdentity,
  ): Promise<TerminalResponderHandoffResult>;
  applyLegacyResponderEnabled(
    identity: TerminalLegacyResponderSelectionIdentity,
  ): TerminalResponderHandoffResult;
  handleLegacyParserQueryBroadcast(input: {
    sessionId: string;
    driverLeaseId: string;
    driverLeaseGeneration: string;
    data: string;
  }): Readonly<{
    identity: TerminalLegacyResponderSelectionIdentity | null;
    replies: readonly string[];
  }>;
  dispose(reason: 'runtime-replaced'): void;
  submitUserInput(input: {
    data: string;
    kind: 'key' | 'paste' | 'ime' | 'mouse';
  }): TerminalResponderHandoffResult;
  getState(): Readonly<TerminalResponderHandoffRuntimeState>;
}

interface RegisteredTerminalResponderView {
  identity: TerminalCompatibilityDrainIdentity;
  runtime: TerminalResponderHandoffRuntime;
}

export interface TerminalResponderEnableRouteResult extends TerminalResponderHandoffResult {
  completedViewQuorum: boolean;
  matchedViewCount: number;
}

export interface TerminalResponderHandoffDispatcher {
  register(
    identity: TerminalCompatibilityDrainIdentity,
    runtime: TerminalResponderHandoffRuntime,
  ): () => void;
  route(message: TerminalLegacyResponderEnabledMessage): TerminalResponderEnableRouteResult;
  broadcastLegacyParserQuery(input: {
    query: Readonly<{
      sessionId: string;
      driverLeaseId: string;
      driverLeaseGeneration: string;
      data: string;
    }>;
    acceptReply: (reply: Readonly<{
      identity: TerminalLegacyResponderSelectionIdentity;
      data: string;
      replyOrdinal: number;
    }>) => Readonly<{ accepted: boolean; ptyEffectApplied: boolean }>;
  }): Readonly<{
    deliveries: readonly Readonly<{
      connectionId: string;
      viewGeneration: number;
      replyCount: number;
    }>[];
    replyCount: number;
    serverAcceptedReplyCount: number;
    ptyEffectCount: number;
  }>;
}

function handoffAccepted(): TerminalResponderHandoffResult {
  return Object.freeze({ accepted: true });
}

function handoffRejected(
  reason: string,
  promotionAbortRequired = false,
): TerminalResponderHandoffResult {
  return Object.freeze({
    accepted: false,
    reason,
    ...(promotionAbortRequired ? { promotionAbortRequired: true } : {}),
  });
}

function isNonEmptyHandoffString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeHandoffInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidResponderBoundaryIdentity(
  value: unknown,
): value is TerminalResponderBoundaryIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Partial<TerminalResponderBoundaryIdentity>;
  return isNonEmptyHandoffString(identity.sessionId)
    && isNonEmptyHandoffString(identity.connectionId)
    && isNonNegativeHandoffInteger(identity.viewGeneration)
    && isCanonicalOrdinal64(identity.transitionEpoch)
    && isNonEmptyHandoffString(identity.authorityEpoch)
    && isCanonicalOrdinal64(identity.streamEpoch)
    && isNonEmptyHandoffString(identity.responderLeaseId)
    && isCanonicalOrdinal64(identity.boundarySourceSeq);
}

function isValidCompatibilityDrainIdentity(
  value: unknown,
): value is TerminalCompatibilityDrainIdentity {
  if (!isValidResponderBoundaryIdentity(value)) return false;
  const identity = value as Partial<TerminalCompatibilityDrainIdentity>;
  return isCanonicalOrdinal64(identity.checkpointEpoch)
    && isCanonicalOrdinal64(identity.drainedThroughSourceSeq)
    && identity.checkpointApplied === true
    && identity.postSnapshotTailDrained === true;
}

function isValidLegacyResponderSelectionIdentity(
  value: unknown,
): value is TerminalLegacyResponderSelectionIdentity {
  if (!isValidCompatibilityDrainIdentity(value)) return false;
  const identity = value as Partial<TerminalLegacyResponderSelectionIdentity>;
  return isNonEmptyHandoffString(identity.driverLeaseId)
    && isCanonicalOrdinal64(identity.driverLeaseGeneration)
    && isCanonicalOrdinal64(identity.acceptedViewAttributesGeneration)
    && identity.queryReplyCapability === 'terminal.query-reply-input.v1'
    && identity.parserResponderCapability === 'terminal.parser-responder-disable.v1'
    && isCanonicalOrdinal64(identity.snapshotSeq);
}

function responderBoundaryIdentitiesEqual(
  left: TerminalResponderBoundaryIdentity,
  right: TerminalResponderBoundaryIdentity,
): boolean {
  return left.sessionId === right.sessionId
    && left.connectionId === right.connectionId
    && left.viewGeneration === right.viewGeneration
    && left.transitionEpoch === right.transitionEpoch
    && left.authorityEpoch === right.authorityEpoch
    && left.streamEpoch === right.streamEpoch
    && left.responderLeaseId === right.responderLeaseId
    && left.boundarySourceSeq === right.boundarySourceSeq;
}

function compatibilityDrainIdentitiesEqual(
  left: TerminalCompatibilityDrainIdentity,
  right: TerminalCompatibilityDrainIdentity,
): boolean {
  return responderBoundaryIdentitiesEqual(left, right)
    && left.checkpointEpoch === right.checkpointEpoch
    && left.drainedThroughSourceSeq === right.drainedThroughSourceSeq
    && left.checkpointApplied === right.checkpointApplied
    && left.postSnapshotTailDrained === right.postSnapshotTailDrained;
}

function compatibilityDrainBoundariesEqual(
  left: TerminalCompatibilityDrainIdentity,
  right: TerminalCompatibilityDrainIdentity,
): boolean {
  return responderBoundaryIdentitiesEqual(left, right)
    && left.checkpointEpoch === right.checkpointEpoch
    && left.checkpointApplied === right.checkpointApplied
    && left.postSnapshotTailDrained === right.postSnapshotTailDrained;
}

function legacyResponderSelectionIdentitiesEqual(
  left: TerminalLegacyResponderSelectionIdentity,
  right: TerminalLegacyResponderSelectionIdentity,
): boolean {
  return compatibilityDrainIdentitiesEqual(left, right)
    && left.driverLeaseId === right.driverLeaseId
    && left.driverLeaseGeneration === right.driverLeaseGeneration
    && left.acceptedViewAttributesGeneration === right.acceptedViewAttributesGeneration
    && left.queryReplyCapability === right.queryReplyCapability
    && left.parserResponderCapability === right.parserResponderCapability
    && left.snapshotSeq === right.snapshotSeq;
}

function isValidControlReceiptOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// @req MIG-BGSTAB-002 AC-2 AC-3 AC-5 AC-6
export function createTerminalResponderHandoffRuntime(
  options: TerminalResponderHandoffRuntimeOptions,
): TerminalResponderHandoffRuntime {
  let disposed = false;
  let recoveryRestartNotified = false;
  let legacyParserRepliesEnabled = options.legacyParserRepliesInitiallyEnabled;
  let promotionAbortRequired = false;
  let compatibilityDrainCompleted = false;
  let compatibilityIdentity: TerminalCompatibilityDrainIdentity | null = null;
  let compatibilityDrainInFlight: {
    identity: TerminalCompatibilityDrainIdentity;
    promise: Promise<TerminalResponderHandoffResult>;
  } | null = null;
  let selectedIdentity: TerminalLegacyResponderSelectionIdentity | null = null;

  const disposedResult = () => handoffRejected('runtime-disposed');
  const abortPromotion = (reason: string): TerminalResponderHandoffResult => {
    if (!promotionAbortRequired) {
      promotionAbortRequired = true;
      options.onPromotionAbortRequired(reason);
    }
    return handoffRejected(reason, true);
  };

  const validateFlushReceipt = (
    receipt: ImmediateTerminalControlSendResult,
  ): TerminalResponderHandoffResult | null => {
    if (!receipt.ok) return abortPromotion(receipt.reason);
    if (!isValidControlReceiptOrdinal(receipt.enqueueOrdinal)) {
      return abortPromotion('query-reply-flush-invalid-enqueue-ordinal');
    }
    if (!isNonEmptyHandoffString(receipt.controlSocketId)) {
      return abortPromotion('query-reply-flush-control-socket-unavailable');
    }
    return null;
  };

  const sendOrderedControl = (
    message: Readonly<Record<string, unknown>>,
    flushReceipt: Extract<ImmediateTerminalControlSendResult, { ok: true }>,
  ): TerminalResponderHandoffResult => {
    const sent = options.sendResponderControl({
      message,
      expectedControlSocketId: flushReceipt.controlSocketId,
      afterEnqueueOrdinal: flushReceipt.enqueueOrdinal,
    });
    if (!sent.ok) return abortPromotion(sent.reason);
    if (sent.controlSocketId !== flushReceipt.controlSocketId) {
      return abortPromotion('responder-control-socket-mismatch');
    }
    if (!isValidControlReceiptOrdinal(sent.enqueueOrdinal)) {
      return abortPromotion('responder-control-invalid-enqueue-ordinal');
    }
    if (sent.enqueueOrdinal <= flushReceipt.enqueueOrdinal) {
      return abortPromotion('responder-control-enqueue-order-regression');
    }
    return handoffAccepted();
  };

  return Object.freeze({
    lifecycleGeneration: options.lifecycleGeneration,
    async disableLegacyParserRepliesAtBoundary(
      identity: TerminalResponderBoundaryIdentity,
    ): Promise<TerminalResponderHandoffResult> {
      if (disposed) return disposedResult();
      if (
        !isValidResponderBoundaryIdentity(identity)
        || !isValidResponderBoundaryIdentity(options.identity)
        || !responderBoundaryIdentitiesEqual(options.identity, identity)
      ) {
        return handoffRejected('responder-boundary-identity-mismatch');
      }

      let drained: boolean;
      try {
        drained = await options.awaitOutputIdleWithFifoProbe(identity);
      } catch {
        if (disposed) return disposedResult();
        return abortPromotion('output-drain-failed');
      }
      if (disposed) return disposedResult();
      if (!drained) return abortPromotion('output-drain-failed');

      let flushReceipt: ImmediateTerminalControlSendResult;
      try {
        flushReceipt = await options.flushPendingQueryRepliesImmediately(identity);
      } catch {
        if (disposed) return disposedResult();
        return abortPromotion('query-reply-flush-failed');
      }
      if (disposed) return disposedResult();
      const flushFailure = validateFlushReceipt(flushReceipt);
      if (flushFailure) return flushFailure;
      if (!flushReceipt.ok) return abortPromotion(flushReceipt.reason);

      if (legacyParserRepliesEnabled) {
        options.setLegacyParserRepliesEnabled(false);
        legacyParserRepliesEnabled = false;
      }
      return sendOrderedControl({
        type: 'terminal-authority:responder-disabled',
        ...identity,
      }, flushReceipt);
    },
    restoreLegacyParserRepliesAfterCompatibilityDrain(
      identity: TerminalCompatibilityDrainIdentity,
    ): Promise<TerminalResponderHandoffResult> {
      if (disposed) return Promise.resolve(disposedResult());
      if (
        !isValidCompatibilityDrainIdentity(identity)
        || !responderBoundaryIdentitiesEqual(options.identity, identity)
      ) {
        return Promise.resolve(handoffRejected('compatibility-drain-identity-mismatch'));
      }
      if (compatibilityDrainCompleted) {
        return Promise.resolve(
          compatibilityIdentity && compatibilityDrainIdentitiesEqual(compatibilityIdentity, identity)
            ? Object.freeze({
                accepted: true,
                compatibilityDrainIdentity: compatibilityIdentity,
              })
            : handoffRejected('compatibility-drain-already-completed'),
        );
      }
      const active = compatibilityDrainInFlight;
      if (active) {
        if (!compatibilityDrainBoundariesEqual(active.identity, identity)) {
          return Promise.resolve(handoffRejected('compatibility-drain-identity-mismatch'));
        }
        if (BigInt(identity.drainedThroughSourceSeq) > BigInt(active.identity.drainedThroughSourceSeq)) {
          active.identity = Object.freeze({ ...identity });
        }
        return active.promise;
      }
      const operation = {
        identity: Object.freeze({ ...identity }),
        promise: Promise.resolve(handoffRejected('compatibility-drain-not-started')),
      };
      operation.promise = (async (): Promise<TerminalResponderHandoffResult> => {
        let drained: boolean;
        try {
          drained = await options.awaitCompatibilityDrain(operation.identity);
        } catch {
          if (disposed) return disposedResult();
          return handoffRejected('compatibility-drain-failed');
        }
        if (disposed) return disposedResult();
        if (!drained) return handoffRejected('compatibility-drain-failed');

        const settledIdentity = operation.identity;
        let flushReceipt: ImmediateTerminalControlSendResult;
        try {
          flushReceipt = await options.flushPendingQueryRepliesImmediately(settledIdentity);
        } catch {
          if (disposed) return disposedResult();
          return abortPromotion('query-reply-flush-failed');
        }
        if (disposed) return disposedResult();
        const flushFailure = validateFlushReceipt(flushReceipt);
        if (flushFailure) return flushFailure;
        if (!flushReceipt.ok) return abortPromotion(flushReceipt.reason);

        const sent = sendOrderedControl({
          type: 'terminal-authority:compatibility-drained',
          ...settledIdentity,
        }, flushReceipt);
        if (!sent.accepted) return sent;
        compatibilityIdentity = Object.freeze({ ...settledIdentity });
        compatibilityDrainCompleted = true;
        return Object.freeze({
          accepted: true,
          compatibilityDrainIdentity: compatibilityIdentity,
        });
      })().finally(() => {
        if (compatibilityDrainInFlight === operation) compatibilityDrainInFlight = null;
      });
      compatibilityDrainInFlight = operation;
      return operation.promise;
    },
    applyLegacyResponderEnabled(
      identity: TerminalLegacyResponderSelectionIdentity,
    ): TerminalResponderHandoffResult {
      if (disposed) return disposedResult();
      if (
        !compatibilityDrainCompleted
        || !compatibilityIdentity
        || !isValidLegacyResponderSelectionIdentity(identity)
        || !compatibilityDrainIdentitiesEqual(compatibilityIdentity, identity)
      ) {
        return handoffRejected('legacy-responder-enable-identity-mismatch');
      }
      selectedIdentity = Object.freeze({ ...identity });
      if (!legacyParserRepliesEnabled) {
        options.setLegacyParserRepliesEnabled(true);
        legacyParserRepliesEnabled = true;
      }
      return handoffAccepted();
    },
    handleLegacyParserQueryBroadcast(input: {
      sessionId: string;
      driverLeaseId: string;
      driverLeaseGeneration: string;
      data: string;
    }) {
      if (
        disposed
        || !legacyParserRepliesEnabled
        || !selectedIdentity
        || input.sessionId !== selectedIdentity.sessionId
        || input.driverLeaseId !== selectedIdentity.driverLeaseId
        || input.driverLeaseGeneration !== selectedIdentity.driverLeaseGeneration
      ) {
        return Object.freeze({ identity: selectedIdentity, replies: Object.freeze([]) });
      }
      return Object.freeze({
        identity: selectedIdentity,
        replies: Object.freeze([
          ...(options.resolveLegacyParserQueryReplies?.(input.data) ?? []),
        ]),
      });
    },
    dispose(reason: 'runtime-replaced'): void {
      if (disposed) return;
      disposed = true;
      compatibilityDrainCompleted = false;
      compatibilityIdentity = null;
      selectedIdentity = null;
      if (!recoveryRestartNotified) {
        recoveryRestartNotified = true;
        options.onRecoveryRestartRequired?.(reason);
      }
    },
    submitUserInput(input: {
      data: string;
      kind: 'key' | 'paste' | 'ime' | 'mouse';
    }): TerminalResponderHandoffResult {
      if (disposed) return disposedResult();
      options.forwardUserInput(input);
      return handoffAccepted();
    },
    getState: () => Object.freeze({
      legacyParserRepliesEnabled,
      promotionAbortRequired,
      compatibilityDrainCompleted,
    }),
  });
}

function responderViewKey(identity: TerminalResponderBoundaryIdentity): string {
  return `${identity.sessionId}\u0000${identity.connectionId}\u0000${identity.viewGeneration}`;
}

// @req MIG-BGSTAB-002 AC-3 AC-5
export function createTerminalResponderHandoffDispatcher(options: {
  readSelectedLegacyResponderIdentity: () => TerminalLegacyResponderSelectionIdentity | null;
}): TerminalResponderHandoffDispatcher {
  const views = new Map<string, RegisteredTerminalResponderView>();
  return Object.freeze({
    register(
      identity: TerminalCompatibilityDrainIdentity,
      runtime: TerminalResponderHandoffRuntime,
    ): () => void {
      const key = responderViewKey(identity);
      views.set(key, { identity: Object.freeze({ ...identity }), runtime });
      return () => {
        if (views.get(key)?.runtime === runtime) views.delete(key);
      };
    },
    route(message: TerminalLegacyResponderEnabledMessage): TerminalResponderEnableRouteResult {
      const parsed = parseTerminalResponderHandoffServerMessage(message);
      if (!parsed.ok) {
        return Object.freeze({
          accepted: false,
          reason: parsed.reason,
          completedViewQuorum: false,
          matchedViewCount: 0,
        });
      }
      const selected = options.readSelectedLegacyResponderIdentity();
      const sessionViews = [...views.values()].filter(
        entry => entry.identity.sessionId === message.sessionId,
      );
      if (
        !selected
        || !isValidLegacyResponderSelectionIdentity(selected)
        || !legacyResponderSelectionIdentitiesEqual(selected, message)
        // The server emits this frame only after its global all-view drain
        // quorum. A browser dispatcher owns only the views in this renderer,
        // so the global count may be larger but must never be smaller than the
        // locally registered quorum.
        || message.affectedViewCount < sessionViews.length
      ) {
        return Object.freeze({
          accepted: false,
          reason: 'legacy-responder-selection-mismatch',
          completedViewQuorum: false,
          matchedViewCount: 0,
        });
      }
      const drainedCount = sessionViews.filter(
        entry => entry.runtime.getState().compatibilityDrainCompleted,
      ).length;
      if (drainedCount < sessionViews.length) {
        return Object.freeze({
          accepted: false,
          reason: drainedCount === 0
            ? 'compatibility-drain-pending'
            : 'compatibility-view-quorum-pending',
          completedViewQuorum: false,
          matchedViewCount: 0,
        });
      }
      const selectedView = sessionViews.find(entry => (
        entry.identity.connectionId === selected.connectionId
        && entry.identity.viewGeneration === selected.viewGeneration
        && compatibilityDrainIdentitiesEqual(entry.identity, selected)
      ));
      if (!selectedView) {
        return Object.freeze({
          accepted: false,
          reason: 'legacy-responder-view-unavailable',
          completedViewQuorum: true,
          matchedViewCount: 0,
        });
      }
      const applied = selectedView.runtime.applyLegacyResponderEnabled(selected);
      return Object.freeze({
        ...applied,
        completedViewQuorum: true,
        matchedViewCount: applied.accepted ? 1 : 0,
      });
    },
    broadcastLegacyParserQuery(input: {
      query: Readonly<{
        sessionId: string;
        driverLeaseId: string;
        driverLeaseGeneration: string;
        data: string;
      }>;
      acceptReply: (reply: Readonly<{
        identity: TerminalLegacyResponderSelectionIdentity;
        data: string;
        replyOrdinal: number;
      }>) => Readonly<{ accepted: boolean; ptyEffectApplied: boolean }>;
    }) {
      const sessionViews = [...views.values()].filter(
        entry => entry.identity.sessionId === input.query.sessionId,
      );
      let replyCount = 0;
      let serverAcceptedReplyCount = 0;
      let ptyEffectCount = 0;
      const deliveries = sessionViews.map((entry) => {
        const delivery = entry.runtime.handleLegacyParserQueryBroadcast(input.query);
        let viewReplyCount = 0;
        if (delivery.identity) {
          delivery.replies.forEach((data, replyOrdinal) => {
            replyCount += 1;
            viewReplyCount += 1;
            const acceptance = input.acceptReply({
              identity: delivery.identity as TerminalLegacyResponderSelectionIdentity,
              data,
              replyOrdinal,
            });
            if (acceptance.accepted) serverAcceptedReplyCount += 1;
            if (acceptance.ptyEffectApplied) ptyEffectCount += 1;
          });
        }
        return Object.freeze({
          connectionId: entry.identity.connectionId,
          viewGeneration: entry.identity.viewGeneration,
          replyCount: viewReplyCount,
        });
      });
      return Object.freeze({
        deliveries: Object.freeze(deliveries),
        replyCount,
        serverAcceptedReplyCount,
        ptyEffectCount,
      });
    },
  });
}
