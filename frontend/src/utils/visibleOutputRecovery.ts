export interface VisibleOutputRecoveryState {
  pending: boolean;
  retryCount: number;
  staleTerminal: boolean;
}

export type VisibleOutputRecoveryAttemptKind = 'fresh-snapshot' | 'reconnect';

/**
 * Once checkpoint authority owns the terminal mutation lane, a delayed legacy
 * snapshot may be acknowledged for transport cleanup but must not reset xterm.
 * The ordered compatibility rollback is the sole exception because its
 * authoritative snapshot is the recovery payload that returns ownership to
 * the browser.
 *
 * @req MIG-BGSTAB-002 AC-4 AC-5
 */
export function shouldSuppressLegacySnapshotDuringCheckpointAuthority(input: {
  checkpointAuthorityActive: boolean;
  compatibilityRecoveryPending: boolean;
  snapshotMode: 'authoritative' | 'fallback';
}): boolean {
  return input.checkpointAuthorityActive
    && !input.compatibilityRecoveryPending
    && input.snapshotMode === 'authoritative';
}

/**
 * A no-cache mount has no locally applied snapshot to compare. While the
 * server checkpoint owns the writer, its first authoritative snapshot is the
 * retained-state handoff rather than a delayed legacy mutation.
 *
 * @req MIG-BGSTAB-002 AC-4 AC-5
 */
export function shouldForceInitialCheckpointAuthorityRecoveryConvergence(input: {
  checkpointAuthorityActive: boolean;
  initialRestorePending: boolean;
  snapshotMode: 'authoritative' | 'fallback';
  hasLastAppliedSnapshot: boolean;
}): boolean {
  return input.checkpointAuthorityActive
    && input.initialRestorePending
    && input.snapshotMode === 'authoritative'
    && !input.hasLastAppliedSnapshot;
}

export interface VisibleOutputRecoveryConvergenceIdentity {
  connectionGeneration: number;
  replayToken: string;
  snapshotSeq: number;
}

/**
 * A replacement connection can legitimately receive the same terminal bytes
 * and sequence as the prior socket. Content deduplication must not suppress
 * that authoritative apply while a recovery barrier is still active.
 *
 * @req REL-BGSTAB-009
 */
export function shouldForceAuthoritativeRecoveryConvergence(input: {
  recoveryBlocking: boolean;
  snapshotMode: 'authoritative' | 'fallback';
  replayToken: string;
  currentConnectionGeneration: number;
  lastApplied: null | {
    replayToken: string;
    connectionGeneration: number;
  };
}): boolean {
  return Boolean(
    input.recoveryBlocking
    && input.snapshotMode === 'authoritative'
    && input.lastApplied
    && (
      input.lastApplied.connectionGeneration !== input.currentConnectionGeneration
      || input.lastApplied.replayToken !== input.replayToken
    )
  );
}

export interface VisibleOutputRecoveryAttemptBudget {
  consume: (kind: VisibleOutputRecoveryAttemptKind) => {
    allowed: boolean;
    attempt: number;
  };
  resetAfterConvergence: () => void;
  resetForNewScope: () => void;
  armReconnectConvergence: (identity: VisibleOutputRecoveryConvergenceIdentity) => void;
  resetAfterMatchingReconnectConvergence: (
    identity: VisibleOutputRecoveryConvergenceIdentity
  ) => boolean;
  clearPendingReconnectConvergence: () => void;
}

/**
 * Bounds authority recovery attempts across replacement transactions. A new
 * coordinator is created for every server snapshot generation, so retry state
 * owned by an individual coordinator would reset on every deterministic
 * apply/write failure and could loop forever.
 *
 * @req REL-BGSTAB-009
 */
export function createVisibleOutputRecoveryAttemptBudget(limits: {
  maxFreshSnapshotAttempts: number;
  maxReconnectAttempts: number;
}): VisibleOutputRecoveryAttemptBudget {
  const caps: Record<VisibleOutputRecoveryAttemptKind, number> = {
    'fresh-snapshot': Math.max(0, Math.floor(limits.maxFreshSnapshotAttempts)),
    reconnect: Math.max(0, Math.floor(limits.maxReconnectAttempts)),
  };
  const attempts: Record<VisibleOutputRecoveryAttemptKind, number> = {
    'fresh-snapshot': 0,
    reconnect: 0,
  };
  let pendingReconnectConvergence: VisibleOutputRecoveryConvergenceIdentity | null = null;
  const reset = (): void => {
    attempts['fresh-snapshot'] = 0;
    attempts.reconnect = 0;
    pendingReconnectConvergence = null;
  };

  return {
    consume(kind) {
      const attempt = attempts[kind];
      if (attempt >= caps[kind]) {
        return { allowed: false, attempt };
      }
      attempts[kind] = attempt + 1;
      return { allowed: true, attempt: attempts[kind] };
    },
    resetAfterConvergence: reset,
    resetForNewScope: reset,
    armReconnectConvergence(identity) {
      pendingReconnectConvergence = { ...identity };
    },
    resetAfterMatchingReconnectConvergence(identity) {
      const pending = pendingReconnectConvergence;
      if (
        !pending
        || pending.connectionGeneration !== identity.connectionGeneration
        || pending.replayToken !== identity.replayToken
        || pending.snapshotSeq !== identity.snapshotSeq
      ) {
        return false;
      }
      reset();
      return true;
    },
    clearPendingReconnectConvergence() {
      pendingReconnectConvergence = null;
    },
  };
}

export type VisibleOutputRecoveryFailureDecision =
  | { action: 'retry'; state: VisibleOutputRecoveryState }
  | { action: 'abandon'; state: VisibleOutputRecoveryState };

export function createVisibleOutputRecoveryState(): VisibleOutputRecoveryState {
  return {
    pending: false,
    retryCount: 0,
    staleTerminal: false,
  };
}

export function beginVisibleOutputRecovery(state: VisibleOutputRecoveryState): {
  state: VisibleOutputRecoveryState;
  shouldSend: boolean;
} {
  if (state.pending || state.staleTerminal) {
    return { state, shouldSend: false };
  }

  return {
    state: {
      pending: true,
      retryCount: 0,
      staleTerminal: false,
    },
    shouldSend: true,
  };
}

// @req REL-BGSTAB-012 AC-6 AC-7 AC-8 AC-9
export function beginBrowserViewOnlyDataGapRecovery(
  state: VisibleOutputRecoveryState,
): VisibleOutputRecoveryState {
  if (state.pending && state.staleTerminal) {
    return state;
  }
  return {
    pending: true,
    retryCount: 0,
    staleTerminal: true,
  };
}

export function recordVisibleOutputRecoverySendSuccess(state: VisibleOutputRecoveryState): VisibleOutputRecoveryState {
  if (!state.pending) {
    return state;
  }
  return {
    pending: true,
    retryCount: 0,
    staleTerminal: false,
  };
}

export function recordVisibleOutputRecoverySendFailure(
  state: VisibleOutputRecoveryState,
  maxRetries: number,
): VisibleOutputRecoveryFailureDecision {
  if (!state.pending) {
    return { action: 'abandon', state: createVisibleOutputRecoveryState() };
  }

  const retryCount = state.retryCount + 1;
  if (retryCount >= maxRetries) {
    return {
      action: 'abandon',
      state: {
        pending: false,
        retryCount: 0,
        staleTerminal: true,
      },
    };
  }

  return {
    action: 'retry',
    state: {
      pending: true,
      retryCount,
      staleTerminal: false,
    },
  };
}

export function finishVisibleOutputRecovery(
  state: VisibleOutputRecoveryState,
  options: { keepTerminalStale?: boolean } = {},
): VisibleOutputRecoveryState {
  if (!state.pending && !state.staleTerminal) {
    return state;
  }
  return {
    pending: false,
    retryCount: 0,
    staleTerminal: Boolean(options.keepTerminalStale),
  };
}

export function isVisibleOutputRecoveryBlocking(state: VisibleOutputRecoveryState): boolean {
  return state.pending || state.staleTerminal;
}

export function resolveVisibleOutputRecoveryBarrierReason(
  state: VisibleOutputRecoveryState,
): 'none' | 'visible-output-recovery' {
  return isVisibleOutputRecoveryBlocking(state) ? 'visible-output-recovery' : 'none';
}

export type VisibleOutputMutationResult<T> =
  | { accepted: true; value: T }
  | { accepted: false };

export interface VisibleOutputMutationFence {
  invalidateSpeculative: () => void;
  runSpeculative: <T>(operation: () => Promise<T>) => Promise<VisibleOutputMutationResult<T>>;
  runAuthoritative: <T>(operation: () => Promise<T>) => Promise<VisibleOutputMutationResult<T>>;
}

// @req REL-BGSTAB-008
export function createVisibleOutputMutationFence(): VisibleOutputMutationFence {
  let speculativeGeneration = 0;
  let authoritySequence = 0;
  let authorityPending = false;
  let mutationTail: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<VisibleOutputMutationResult<T>>): Promise<VisibleOutputMutationResult<T>> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    invalidateSpeculative(): void {
      speculativeGeneration += 1;
    },
    runSpeculative<T>(operation: () => Promise<T>): Promise<VisibleOutputMutationResult<T>> {
      if (authorityPending) {
        return Promise.resolve({ accepted: false });
      }
      const admittedGeneration = speculativeGeneration;
      return enqueue<T>(async (): Promise<VisibleOutputMutationResult<T>> => {
        if (authorityPending || admittedGeneration !== speculativeGeneration) {
          return { accepted: false };
        }
        return { accepted: true, value: await operation() };
      });
    },
    runAuthoritative<T>(operation: () => Promise<T>): Promise<VisibleOutputMutationResult<T>> {
      speculativeGeneration += 1;
      authorityPending = true;
      authoritySequence += 1;
      const currentAuthoritySequence = authoritySequence;
      return enqueue<T>(async (): Promise<VisibleOutputMutationResult<T>> => ({
        accepted: true,
        value: await operation(),
      }))
        .finally(() => {
          if (authoritySequence === currentAuthoritySequence) {
            authorityPending = false;
          }
        });
    },
  };
}

export interface VisibleOutputRecoveryScope {
  clientId: string;
  sessionId: string;
}

export interface RestoreNeededAuthorityProof {
  replayToken: string;
  snapshotSeq: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  coversThroughSeq?: number;
  supersedesReplayToken?: string;
}

export interface SnapshotAuthorityProof {
  replayToken: string;
  seq: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  coversThroughSeq?: number;
  supersedesReplayToken?: string;
}

function hasValidAuthorityProof(value: RestoreNeededAuthorityProof): boolean {
  return value.replayToken.length > 0
    && Number.isSafeInteger(value.snapshotSeq)
    && value.snapshotSeq >= 0
    && typeof value.authorityEpoch === 'string'
    && value.authorityEpoch.length > 0
    && Number.isSafeInteger(value.authorityRevision)
    && value.authorityRevision! >= 0
    && Number.isSafeInteger(value.coversThroughSeq)
    && value.coversThroughSeq === value.snapshotSeq
    && (
      value.supersedesReplayToken === undefined
      || value.supersedesReplayToken.length > 0
    );
}

// @req REL-BGSTAB-010
export function hasSameRestoreNeededAuthorityProof(
  left: RestoreNeededAuthorityProof,
  right: RestoreNeededAuthorityProof,
): boolean {
  return hasValidAuthorityProof(left)
    && hasValidAuthorityProof(right)
    && left.replayToken === right.replayToken
    && left.snapshotSeq === right.snapshotSeq
    && left.authorityEpoch === right.authorityEpoch
    && left.authorityRevision === right.authorityRevision
    && left.coversThroughSeq === right.coversThroughSeq
    && left.supersedesReplayToken === right.supersedesReplayToken;
}

// @req REL-BGSTAB-010
export function matchesRestoreNeededSnapshotAuthorityProof(
  restore: RestoreNeededAuthorityProof,
  snapshot: SnapshotAuthorityProof,
): boolean {
  return hasSameRestoreNeededAuthorityProof(restore, {
    replayToken: snapshot.replayToken,
    snapshotSeq: snapshot.seq,
    authorityEpoch: snapshot.authorityEpoch,
    authorityRevision: snapshot.authorityRevision,
    coversThroughSeq: snapshot.coversThroughSeq,
    supersedesReplayToken: snapshot.supersedesReplayToken,
  });
}

export interface VisibleOutputRecoveryChunk {
  chunkId: string;
  screenSeq?: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  data: string;
}

export interface VisibleOutputSourceSegment {
  byteStart: number;
  byteEnd: number;
  screenSeq?: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  chunkId: string;
}

/**
 * Segments must tile the payload exactly: start at 0, run forward without gap or
 * overlap, and end on the final byte. Split out so the binary output adapter can
 * apply the identical invariant — it receives segments already sliced by the
 * codec and would otherwise inherit only the decode half below, silently dropping
 * this check from the byte path.
 *
 * Contiguity is all this decides. A cut that lands mid-codepoint is contiguous and
 * is rejected downstream by the fatal decoder instead.
 */
// @req REL-BGSTAB-009
export function assertContiguousSegments(
  segments: readonly VisibleOutputSourceSegment[],
  totalBytes: number,
): boolean {
  if (segments.length === 0) {
    return false;
  }
  let expectedStart = 0;
  for (const segment of segments) {
    if (
      !Number.isInteger(segment.byteStart)
      || !Number.isInteger(segment.byteEnd)
      || segment.byteStart !== expectedStart
      || segment.byteEnd <= segment.byteStart
      || segment.byteEnd > totalBytes
      || segment.chunkId.length === 0
      || (segment.screenSeq !== undefined && !Number.isFinite(segment.screenSeq))
      || (segment.authorityEpoch !== undefined && segment.authorityEpoch.length === 0)
      || (
        segment.authorityRevision !== undefined
        && (!Number.isSafeInteger(segment.authorityRevision) || segment.authorityRevision < 0)
      )
    ) {
      return false;
    }
    expectedStart = segment.byteEnd;
  }
  return expectedStart === totalBytes;
}

// @req REL-BGSTAB-009
export function splitVisibleOutputSourceSegments(
  data: string,
  segments: VisibleOutputSourceSegment[],
): VisibleOutputRecoveryChunk[] | null {
  const encoded = new TextEncoder().encode(data);
  if (!assertContiguousSegments(segments, encoded.byteLength)) {
    return null;
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return segments.map(segment => ({
      data: decoder.decode(encoded.subarray(segment.byteStart, segment.byteEnd)),
      ...(segment.screenSeq !== undefined ? { screenSeq: segment.screenSeq } : {}),
      ...(segment.authorityEpoch !== undefined ? { authorityEpoch: segment.authorityEpoch } : {}),
      ...(segment.authorityRevision !== undefined ? { authorityRevision: segment.authorityRevision } : {}),
      chunkId: segment.chunkId,
    }));
  } catch {
    return null;
  }
}

export type VisibleResyncOutputAdmission = 'current-recovery' | 'current-live' | 'stale';

export interface VisibleResyncOutputAdmissionInput {
  activeReplayToken: string;
  outputReplayToken?: string;
  outputChunkId?: string;
  outputScreenSeq?: number;
  matchingServerReadyLatched: boolean;
}

export interface VisibleResyncOutputBatchInput {
  activeReplayToken: string;
  outputReplayToken?: string;
  matchingServerReadyLatched: boolean;
  chunks: ReadonlyArray<{
    chunkId?: string;
    screenSeq?: number;
  }>;
}

// @req REL-BGSTAB-008
export function classifyVisibleResyncOutput(
  input: VisibleResyncOutputAdmissionInput,
): VisibleResyncOutputAdmission {
  if (
    input.outputScreenSeq !== undefined
    && (!Number.isFinite(input.outputScreenSeq) || input.outputScreenSeq < 0)
  ) {
    return 'stale';
  }
  if (input.outputReplayToken !== undefined) {
    return input.outputReplayToken === input.activeReplayToken
      && typeof input.outputChunkId === 'string'
      && input.outputChunkId.length > 0
      ? 'current-recovery'
      : 'stale';
  }
  if (
    typeof input.outputChunkId === 'string'
    && input.outputChunkId.length > 0
    && input.outputScreenSeq !== undefined
  ) {
    return 'current-live';
  }
  return input.matchingServerReadyLatched ? 'current-live' : 'stale';
}

// @req REL-BGSTAB-009
export function classifyVisibleResyncOutputBatch(
  input: VisibleResyncOutputBatchInput,
): VisibleResyncOutputAdmission[] | null {
  const admissions = input.chunks.map(chunk => classifyVisibleResyncOutput({
    activeReplayToken: input.activeReplayToken,
    outputReplayToken: input.outputReplayToken,
    outputChunkId: chunk.chunkId,
    outputScreenSeq: chunk.screenSeq,
    matchingServerReadyLatched: input.matchingServerReadyLatched,
  }));
  return admissions.includes('stale') ? null : admissions;
}

export interface VisibleOutputRecoveryTransactionState {
  transactionId: string;
  repairToken: string;
  replayToken: string;
  connectionGeneration: number;
  sessionGeneration: number;
  viewGeneration: number;
  xtermGeneration: number;
  staleTerminal: boolean;
  terminalFailed: boolean;
  restoreNeeded: boolean;
  discardedQueueGeneration: number | null;
  currentViewTransactionReady: boolean;
  retainedHistoryEquivalent: boolean;
  provisionalLocalState: boolean;
  hiddenDirty: boolean;
  hiddenSkipped: boolean;
  heldOutputBytes: number;
  heldChunks: VisibleOutputRecoveryChunk[];
  queuedInputCount: number;
  activeTimerCount: number;
  activeListenerCount: number;
  parserComplete: boolean;
  pendingEscapeTailAnsi: string;
  disposed: boolean;
  recoveryScope?: 'browser-view-only';
}

export interface TerminalCompatibilityPostAckIdentity {
  readonly sessionId: string;
  readonly replayToken: string;
  readonly snapshotSeq: number;
  readonly connectionGeneration: number;
  readonly sessionGeneration: number;
  readonly viewGeneration: number;
}

export interface TerminalCompatibilityPostAckConvergenceState
  extends TerminalCompatibilityPostAckIdentity {
  readonly acknowledgementReceived: true;
  readonly serverReadyLatched: boolean;
  readonly currentViewTransactionReady: boolean;
  readonly heldOutputBytes: number;
  readonly pendingOutputIds: readonly string[];
  readonly pendingOutputs: readonly {
    readonly outputId: string;
    readonly byteLength: number;
  }[];
  readonly seenOutputIds: readonly string[];
  readonly maxHeldBytes: number;
  readonly maxHeldChunks: number;
  readonly lastAcceptedScreenSeq: number;
  readonly receivedOutputChunks: number;
  readonly receivedOutputBytes: number;
}

export interface TerminalCompatibilityPostAckConvergenceLimits {
  readonly maxHeldBytes: number;
  readonly maxHeldChunks: number;
}

export type TerminalCompatibilityPostAckConvergenceEvent =
  | (TerminalCompatibilityPostAckIdentity & {
      readonly type: 'output-arrived';
      readonly outputId: string;
      readonly screenSeq: number;
      readonly byteLength: number;
    })
  | (TerminalCompatibilityPostAckIdentity & {
      readonly type: 'output-drained';
      readonly outputId: string;
    })
  | (TerminalCompatibilityPostAckIdentity & {
      readonly type: 'server-ready-latched';
    });

export interface TerminalCompatibilityPostAckConvergenceResult {
  readonly accepted: boolean;
  readonly converged: boolean;
  readonly state: TerminalCompatibilityPostAckConvergenceState;
}

function hasSameTerminalCompatibilityPostAckIdentity(
  state: TerminalCompatibilityPostAckIdentity,
  candidate: TerminalCompatibilityPostAckIdentity,
): boolean {
  return state.sessionId === candidate.sessionId
    && state.replayToken === candidate.replayToken
    && state.snapshotSeq === candidate.snapshotSeq
    && state.connectionGeneration === candidate.connectionGeneration
    && state.sessionGeneration === candidate.sessionGeneration
    && state.viewGeneration === candidate.viewGeneration;
}

export function createTerminalCompatibilityPostAckConvergence(
  identity: TerminalCompatibilityPostAckIdentity,
  limits: TerminalCompatibilityPostAckConvergenceLimits = {
    maxHeldBytes: Number.MAX_SAFE_INTEGER,
    maxHeldChunks: Number.MAX_SAFE_INTEGER,
  },
): TerminalCompatibilityPostAckConvergenceState {
  const maxHeldBytes = Number.isSafeInteger(limits.maxHeldBytes) && limits.maxHeldBytes >= 0
    ? limits.maxHeldBytes
    : 0;
  const maxHeldChunks = Number.isSafeInteger(limits.maxHeldChunks) && limits.maxHeldChunks >= 0
    ? limits.maxHeldChunks
    : 0;
  return {
    ...identity,
    acknowledgementReceived: true,
    serverReadyLatched: false,
    currentViewTransactionReady: false,
    heldOutputBytes: 0,
    pendingOutputIds: [],
    pendingOutputs: [],
    seenOutputIds: [],
    maxHeldBytes,
    maxHeldChunks,
    lastAcceptedScreenSeq: identity.snapshotSeq,
    receivedOutputChunks: 0,
    receivedOutputBytes: 0,
  };
}

export function advanceTerminalCompatibilityPostAckConvergence(
  state: TerminalCompatibilityPostAckConvergenceState,
  event: TerminalCompatibilityPostAckConvergenceEvent,
): TerminalCompatibilityPostAckConvergenceResult {
  if (
    state.currentViewTransactionReady
    || !hasSameTerminalCompatibilityPostAckIdentity(state, event)
  ) {
    return { accepted: false, converged: false, state };
  }

  if (event.type === 'output-arrived') {
    const nextHeldOutputBytes = state.heldOutputBytes + event.byteLength;
    if (
      event.outputId.length === 0
      || !Number.isSafeInteger(event.screenSeq)
      || event.screenSeq <= state.lastAcceptedScreenSeq
      || !Number.isSafeInteger(event.byteLength)
      || event.byteLength < 0
      || !Number.isSafeInteger(nextHeldOutputBytes)
      || nextHeldOutputBytes > state.maxHeldBytes
      || state.pendingOutputs.length >= state.maxHeldChunks
      || state.seenOutputIds.length >= state.maxHeldChunks
      || state.seenOutputIds.includes(event.outputId)
    ) {
      return { accepted: false, converged: false, state };
    }
    const next = {
      ...state,
      heldOutputBytes: nextHeldOutputBytes,
      pendingOutputIds: [...state.pendingOutputIds, event.outputId],
      pendingOutputs: [
        ...state.pendingOutputs,
        { outputId: event.outputId, byteLength: event.byteLength },
      ],
      seenOutputIds: [...state.seenOutputIds, event.outputId],
      lastAcceptedScreenSeq: event.screenSeq,
      receivedOutputChunks: state.receivedOutputChunks + 1,
      receivedOutputBytes: state.receivedOutputBytes + event.byteLength,
    };
    return { accepted: true, converged: false, state: next };
  }

  if (event.type === 'output-drained') {
    const outputIndex = state.pendingOutputs.findIndex(
      pending => pending.outputId === event.outputId,
    );
    if (outputIndex < 0) {
      return { accepted: false, converged: false, state };
    }
    const drainedOutput = state.pendingOutputs[outputIndex];
    if (!drainedOutput) {
      return { accepted: false, converged: false, state };
    }
    const pendingOutputIds = state.pendingOutputIds.filter((_, index) => index !== outputIndex);
    const pendingOutputs = state.pendingOutputs.filter((_, index) => index !== outputIndex);
    const heldOutputBytes = Math.max(0, state.heldOutputBytes - drainedOutput.byteLength);
    const converged = state.serverReadyLatched && pendingOutputIds.length === 0;
    const next = {
      ...state,
      pendingOutputIds,
      pendingOutputs,
      heldOutputBytes,
      currentViewTransactionReady: converged,
    };
    return { accepted: true, converged, state: next };
  }

  const converged = state.pendingOutputIds.length === 0;
  const next = {
    ...state,
    serverReadyLatched: true,
    currentViewTransactionReady: converged,
  };
  return { accepted: true, converged, state: next };
}

export interface TerminalCompatibilityProgressTimeout {
  readonly clear: () => void;
  readonly progress: () => void;
}

export interface TerminalCompatibilityProgressTimeoutOptions {
  readonly timeoutMs: number;
  readonly onTimeout: () => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

// @req FR-BGSTAB-022 AC-5
// This is an inactivity fence, not a total transaction deadline. A large but
// continuously draining compatibility tail may exceed one write timeout in
// total duration; only a transaction that makes no accepted progress for the
// bounded interval is failed.
export function createTerminalCompatibilityProgressTimeout(
  options: TerminalCompatibilityProgressTimeoutOptions,
): TerminalCompatibilityProgressTimeout {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => (
    setTimeout(callback, delayMs)
  ));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  let timerHandle: unknown | null = null;
  let progressGeneration = 0;

  const clear = (): void => {
    progressGeneration += 1;
    if (timerHandle === null) return;
    const handle = timerHandle;
    timerHandle = null;
    clearTimer(handle);
  };

  const progress = (): void => {
    clear();
    const expectedGeneration = progressGeneration;
    timerHandle = setTimer(() => {
      if (expectedGeneration !== progressGeneration) return;
      timerHandle = null;
      options.onTimeout();
    }, options.timeoutMs);
  };

  return Object.freeze({ clear, progress });
}

export type VisibleOutputRecoveryCoordinatorEvent = VisibleOutputRecoveryScope
  & Record<string, unknown>
  & { type: string };

export interface VisibleOutputRecoveryCoordinatorResult {
  ignored: boolean;
  state: VisibleOutputRecoveryTransactionState | undefined;
}

export interface VisibleOutputRecoveryScheduledWrite extends VisibleOutputRecoveryScope {
  chunk: VisibleOutputRecoveryChunk;
  onWritten: () => void;
}

export interface VisibleOutputRecoveryOutcome extends VisibleOutputRecoveryScope {
  outcome: string;
  reason: string;
}

export interface VisibleOutputRecoveryCoordinatorAdapter {
  enqueueScheduledOutput: (write: VisibleOutputRecoveryScheduledWrite) => void;
  setCurrentViewReady: (scope: VisibleOutputRecoveryScope & { ready: boolean }) => void;
  abortRepair: (scope: VisibleOutputRecoveryScope & { repairToken: string }) => void;
  requestFreshSnapshot: (
    scope: VisibleOutputRecoveryScope & { replayToken: string; reason: string }
  ) => void;
  publishOutcome: (outcome: VisibleOutputRecoveryOutcome) => void;
  acknowledgeRepairSuccess: (
    scope: VisibleOutputRecoveryScope & { repairToken: string }
  ) => void;
  directWrite: (scope: VisibleOutputRecoveryScope & { data: string }) => void;
  activateSplitOutput: (scope: VisibleOutputRecoveryScope) => void;
  enqueueAuthoritativeSnapshot?: (
    write: VisibleOutputRecoveryScope & { data: string; onWritten: () => void }
  ) => void;
  releaseQueuedInput?: (
    input: VisibleOutputRecoveryScope & { data: string }
  ) => void;
  scheduleRestoreTimer?: (
    timer: VisibleOutputRecoveryScope & { timerId: string }
  ) => void;
  cancelRestoreTimer?: (timerId: string) => void;
  enqueueCompletionProbe?: (
    probe: VisibleOutputRecoveryScope & {
      probeId: string;
      data: '';
      onWritten: () => void;
    }
  ) => void;
  sendInput?: (input: VisibleOutputRecoveryScope & { data: string }) => void;
}

export interface VisibleOutputRecoveryCoordinatorOptions {
  maxHeldBytes: number;
  maxHeldChunks: number;
  transportMode: 'unified' | 'split-shadow' | 'split';
  adapter: VisibleOutputRecoveryCoordinatorAdapter;
}

export interface VisibleOutputRecoveryCoordinator {
  dispatch: (
    event: VisibleOutputRecoveryCoordinatorEvent
  ) => VisibleOutputRecoveryCoordinatorResult;
  getState: (
    scope: VisibleOutputRecoveryScope
  ) => VisibleOutputRecoveryTransactionState | undefined;
  getTransportStatus: () => {
    requestedTransportMode: 'unified' | 'split-shadow' | 'split';
    effectiveTransportMode: 'unified';
    splitActivationEnabled: false;
    standaloneSplitParity: 'unresolved';
  };
}

export interface TerminalRestoreIdentity {
  transactionId: string;
  repairToken: string;
  replayToken: string;
  connectionGeneration: number;
  sessionGeneration: number;
  viewGeneration?: number;
  xtermGeneration?: number;
}

export interface BoundTerminalRestoreAdapter {
  begin: (overrides?: Record<string, unknown>) => VisibleOutputRecoveryCoordinatorResult;
  handle: (
    event: Record<string, unknown> & { type: string }
  ) => VisibleOutputRecoveryCoordinatorResult;
  handleFrom: (
    identity: TerminalRestoreIdentity,
    event: Record<string, unknown> & { type: string }
  ) => VisibleOutputRecoveryCoordinatorResult;
  remount: (
    identity: TerminalRestoreIdentity,
    overrides?: Record<string, unknown>
  ) => VisibleOutputRecoveryCoordinatorResult;
  getState: () => VisibleOutputRecoveryTransactionState | undefined;
  getTransportStatus: VisibleOutputRecoveryCoordinator['getTransportStatus'];
}

export interface TerminalRestoreAdapterOptions {
  coordinator: VisibleOutputRecoveryCoordinator;
  scope: VisibleOutputRecoveryScope;
  identity: TerminalRestoreIdentity;
}

// @req REL-BGSTAB-009
function createBoundTerminalRestoreAdapter(
  options: TerminalRestoreAdapterOptions,
): BoundTerminalRestoreAdapter {
  let currentIdentity = { ...options.identity };

  const dispatchFrom = (
    identity: TerminalRestoreIdentity,
    event: Record<string, unknown> & { type: string },
  ): VisibleOutputRecoveryCoordinatorResult => options.coordinator.dispatch({
    ...event,
    ...identity,
    ...options.scope,
  });

  const begin = (
    overrides: Record<string, unknown> = {},
  ): VisibleOutputRecoveryCoordinatorResult => dispatchFrom(currentIdentity, {
    type: 'begin-resync',
    ...overrides,
  });

  return {
    begin,
    handle: (event) => dispatchFrom(currentIdentity, event),
    handleFrom: (identity, event) => dispatchFrom(identity, event),
    remount: (identity, overrides = {}) => {
      currentIdentity = { ...identity };
      return begin(overrides);
    },
    getState: () => options.coordinator.getState(options.scope),
    getTransportStatus: options.coordinator.getTransportStatus,
  };
}

/** Binds TerminalView lifecycle events to the shared recovery authority. */
// @req REL-BGSTAB-009
export function createTerminalViewRestoreAdapter(
  options: TerminalRestoreAdapterOptions,
): BoundTerminalRestoreAdapter {
  return createBoundTerminalRestoreAdapter(options);
}

/** Binds TerminalContainer transport events to the shared recovery authority. */
// @req REL-BGSTAB-009
export function createTerminalContainerRestoreAdapter(
  options: TerminalRestoreAdapterOptions,
): BoundTerminalRestoreAdapter {
  return createBoundTerminalRestoreAdapter(options);
}

interface RecoveryTransactionRecord {
  state: VisibleOutputRecoveryTransactionState;
  sealed: boolean;
  acceptedSnapshot: boolean;
  snapshotWritePending: boolean;
  pendingSnapshot: PendingAuthoritativeSnapshot | null;
  admittedChunkIds: Set<string>;
  writtenChunkIds: Set<string>;
  expectedDrainChunkIds: Set<string>;
  serverReadyLatched: boolean;
  tailDrained: boolean;
  appliedSnapshotSeq: number | null;
  liveSchedulerIdle: boolean;
  acknowledgementRequired: boolean;
  acknowledgementRequested: boolean;
  acknowledgementReceived: boolean;
  queuedInputs: string[];
  queuedInputBytes: number;
  activeWriteTimers: Map<string, string>;
  activeProbeIds: Set<string>;
  nextProbeOrdinal: number;
}

interface PendingAuthoritativeSnapshot {
  transactionId: string;
  repairToken: string;
  replayToken: string;
  connectionGeneration: number;
  sessionGeneration: number;
  viewGeneration: number;
  xtermGeneration: number;
  snapshotSeq: number;
  parserBoundary: string;
  parserComplete: boolean;
  pendingEscapeTailAnsi: string;
  data: string;
}

const recoveryTextEncoder = new TextEncoder();

// @req REL-BGSTAB-008
function getRecoveryScopeKey(scope: VisibleOutputRecoveryScope): string {
  return `${scope.clientId}\u0000${scope.sessionId}`;
}

// @req REL-BGSTAB-008
function readString(event: VisibleOutputRecoveryCoordinatorEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' ? value : undefined;
}

// @req REL-BGSTAB-008
function readNumber(event: VisibleOutputRecoveryCoordinatorEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// @req REL-BGSTAB-009
function matchesOptionalGeneration(eventValue: number | undefined, currentValue: number): boolean {
  return eventValue === undefined ? currentValue === 0 : eventValue === currentValue;
}

// @req REL-BGSTAB-008
// @req REL-BGSTAB-009
function matchesCurrentTransaction(
  record: RecoveryTransactionRecord,
  event: VisibleOutputRecoveryCoordinatorEvent,
  options: {
    allowSealed?: boolean;
    requireRepairToken?: boolean;
    requireReplayToken?: boolean;
  } = {},
): boolean {
  const { state } = record;
  if (
    (!options.allowSealed && record.sealed)
    || state.disposed
    || readString(event, 'transactionId') !== state.transactionId
    || readNumber(event, 'connectionGeneration') !== state.connectionGeneration
    || readNumber(event, 'sessionGeneration') !== state.sessionGeneration
    || !matchesOptionalGeneration(readNumber(event, 'viewGeneration'), state.viewGeneration)
    || !matchesOptionalGeneration(readNumber(event, 'xtermGeneration'), state.xtermGeneration)
  ) {
    return false;
  }
  if (options.requireRepairToken && readString(event, 'repairToken') !== state.repairToken) {
    return false;
  }
  if (options.requireReplayToken && readString(event, 'replayToken') !== state.replayToken) {
    return false;
  }
  return true;
}

// @req REL-BGSTAB-008
function resolveRecoveryFailureOutcome(reason: string, requestedOutcome?: string): string {
  if (
    requestedOutcome === 'fresh-snapshot-started'
    || requestedOutcome === 'reconnect-required'
    || requestedOutcome === 'authority-unavailable'
  ) {
    return requestedOutcome;
  }
  if (reason === 'authority-unavailable') {
    return 'authority-unavailable';
  }
  if (reason === 'parser-incomplete' || reason === 'parser-reset-failed') {
    return 'reconnect-required';
  }
  return 'fresh-snapshot-started';
}

// @req REL-BGSTAB-008
// @req REL-BGSTAB-009
export function createVisibleOutputRecoveryCoordinator(
  options: VisibleOutputRecoveryCoordinatorOptions,
): VisibleOutputRecoveryCoordinator {
  const transactions = new Map<string, RecoveryTransactionRecord>();
  const reportedSplitLimitations = new Set<string>();
  const maxHeldBytes = Math.max(0, Math.floor(options.maxHeldBytes));
  const maxHeldChunks = Math.max(0, Math.floor(options.maxHeldChunks));

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const getState = (
    scope: VisibleOutputRecoveryScope,
  ): VisibleOutputRecoveryTransactionState | undefined => (
    transactions.get(getRecoveryScopeKey(scope))?.state
  );

  // @req REL-BGSTAB-008
  const ignored = (
    scope: VisibleOutputRecoveryScope,
  ): VisibleOutputRecoveryCoordinatorResult => ({
    ignored: true,
    state: getState(scope),
  });

  // @req REL-BGSTAB-009
  const syncActivityCounts = (record: RecoveryTransactionRecord): void => {
    record.state.activeTimerCount = record.activeWriteTimers.size + record.activeProbeIds.size;
    record.state.queuedInputCount = record.queuedInputs.length;
  };

  // @req REL-BGSTAB-009
  const clearHeldOutput = (record: RecoveryTransactionRecord): void => {
    record.state.heldOutputBytes = 0;
    record.state.heldChunks = [];
    record.acceptedSnapshot = false;
    record.snapshotWritePending = false;
    record.pendingSnapshot = null;
    record.appliedSnapshotSeq = null;
    record.admittedChunkIds.clear();
    record.writtenChunkIds.clear();
    record.expectedDrainChunkIds.clear();
    record.tailDrained = false;
  };

  // @req REL-BGSTAB-009
  const cancelTransactionResources = (record: RecoveryTransactionRecord): void => {
    for (const timerId of record.activeWriteTimers.keys()) {
      options.adapter.cancelRestoreTimer?.(timerId);
    }
    record.activeWriteTimers.clear();
    record.activeProbeIds.clear();
    record.state.activeListenerCount = 0;
    syncActivityCounts(record);
  };

  // @req REL-BGSTAB-009
  const clearQueuedInputs = (record: RecoveryTransactionRecord): void => {
    record.queuedInputs = [];
    record.queuedInputBytes = 0;
    syncActivityCounts(record);
  };

  // @req REL-BGSTAB-008
  const publishSplitLimitation = (scope: VisibleOutputRecoveryScope): void => {
    const key = getRecoveryScopeKey(scope);
    if (reportedSplitLimitations.has(key)) {
      return;
    }
    reportedSplitLimitations.add(key);
    options.adapter.publishOutcome({
      ...scope,
      outcome: 'standalone-split-unavailable',
      reason: 'split-activation-disabled',
    });
  };

  // @req REL-BGSTAB-009
  const rejectQueuedInputs = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    reason: 'recovery-superseded' | 'recovery-disposed' | 'connection-closed',
  ): void => {
    if (record.queuedInputs.length === 0) {
      return;
    }
    clearQueuedInputs(record);
    options.adapter.publishOutcome({ ...scope, outcome: 'input-rejected', reason });
  };

  // @req REL-BGSTAB-009
  const retireSupersededRecord = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
  ): void => {
    record.sealed = true;
    record.state.disposed = true;
    record.state.currentViewTransactionReady = false;
    clearHeldOutput(record);
    rejectQueuedInputs(scope, record, 'recovery-superseded');
    cancelTransactionResources(record);
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const begin = (
    scope: VisibleOutputRecoveryScope,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    const transactionId = readString(event, 'transactionId');
    const repairToken = readString(event, 'repairToken');
    const replayToken = readString(event, 'replayToken');
    const connectionGeneration = readNumber(event, 'connectionGeneration');
    const sessionGeneration = readNumber(event, 'sessionGeneration');
    const viewGeneration = readNumber(event, 'viewGeneration') ?? 0;
    const xtermGeneration = readNumber(event, 'xtermGeneration') ?? 0;
    if (
      !transactionId
      || !repairToken
      || !replayToken
      || connectionGeneration === undefined
      || sessionGeneration === undefined
      || viewGeneration < 0
      || xtermGeneration < 0
    ) {
      return ignored(scope);
    }

    const key = getRecoveryScopeKey(scope);
    const superseded = transactions.get(key);
    if (superseded) {
      retireSupersededRecord(scope, superseded);
    }
    const state: VisibleOutputRecoveryTransactionState = {
      transactionId,
      repairToken,
      replayToken,
      connectionGeneration,
      sessionGeneration,
      viewGeneration,
      xtermGeneration,
      staleTerminal: false,
      terminalFailed: false,
      restoreNeeded: false,
      discardedQueueGeneration: null,
      currentViewTransactionReady: false,
      retainedHistoryEquivalent: false,
      provisionalLocalState: true,
      hiddenDirty: event.hiddenDirty === true,
      hiddenSkipped: event.hiddenSkipped === true,
      heldOutputBytes: 0,
      heldChunks: [],
      queuedInputCount: 0,
      activeTimerCount: 0,
      activeListenerCount: 1,
      parserComplete: false,
      pendingEscapeTailAnsi: '',
      disposed: false,
    };
    const record: RecoveryTransactionRecord = {
      state,
      sealed: false,
      acceptedSnapshot: false,
      snapshotWritePending: false,
      pendingSnapshot: null,
      admittedChunkIds: new Set(),
      writtenChunkIds: new Set(),
      expectedDrainChunkIds: new Set(),
      serverReadyLatched: event.serverReadyLatched !== false,
      tailDrained: false,
      appliedSnapshotSeq: null,
      liveSchedulerIdle: event.liveSchedulerIdle !== false,
      acknowledgementRequired: event.acknowledgementRequired === true,
      acknowledgementRequested: false,
      acknowledgementReceived: false,
      queuedInputs: [],
      queuedInputBytes: 0,
      activeWriteTimers: new Map(),
      activeProbeIds: new Set(),
      nextProbeOrdinal: 0,
    };
    transactions.set(key, record);
    options.adapter.setCurrentViewReady({ ...scope, ready: false });
    return { ignored: false, state };
  };

  // @req REL-BGSTAB-009
  const sealFailure = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    reason: string,
    outcome: string,
    requestFreshSnapshot: boolean,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (record.sealed) {
      return ignored(scope);
    }
    record.sealed = true;
    record.state.staleTerminal = true;
    record.state.terminalFailed = true;
    record.state.restoreNeeded = true;
    record.state.discardedQueueGeneration = record.state.viewGeneration;
    record.state.currentViewTransactionReady = false;
    record.state.retainedHistoryEquivalent = false;
    clearHeldOutput(record);
    cancelTransactionResources(record);
    if (requestFreshSnapshot) {
      options.adapter.requestFreshSnapshot({
        ...scope,
        replayToken: record.state.replayToken,
        reason,
      });
    }
    options.adapter.publishOutcome({ ...scope, outcome, reason });
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const overflow = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    reason: 'byte-cap-exceeded' | 'chunk-cap-exceeded',
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (record.sealed) {
      return ignored(scope);
    }
    options.adapter.abortRepair({ ...scope, repairToken: record.state.repairToken });
    return sealFailure(scope, record, reason, 'fresh-snapshot-started', true);
  };

  // @req REL-BGSTAB-009
  const releaseQueuedInputs = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
  ): void => {
    const inputs = record.queuedInputs;
    clearQueuedInputs(record);
    for (const data of inputs) {
      options.adapter.releaseQueuedInput?.({ ...scope, data });
    }
  };

  // @req REL-BGSTAB-009
  const finishCurrentView = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
  ): void => {
    record.state.currentViewTransactionReady = true;
    record.state.staleTerminal = false;
    record.state.terminalFailed = false;
    record.state.restoreNeeded = false;
    record.state.provisionalLocalState = false;
    record.state.hiddenDirty = false;
    record.state.hiddenSkipped = false;
    record.state.retainedHistoryEquivalent = false;
    record.sealed = true;
    clearHeldOutput(record);
    record.tailDrained = true;
    cancelTransactionResources(record);
    options.adapter.setCurrentViewReady({ ...scope, ready: true });
    releaseQueuedInputs(scope, record);
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const advanceReadyBarrier = (
    scope: VisibleOutputRecoveryScope,
    key: string,
    record: RecoveryTransactionRecord,
  ): void => {
    if (
      transactions.get(key) !== record
      || record.sealed
      || record.state.disposed
      || record.state.currentViewTransactionReady
      || !record.acceptedSnapshot
      || record.snapshotWritePending
      || record.writtenChunkIds.size < record.expectedDrainChunkIds.size
      || record.activeProbeIds.size > 0
    ) {
      return;
    }
    record.tailDrained = true;
    if (!record.state.parserComplete || record.state.pendingEscapeTailAnsi.length > 0) {
      return;
    }
    if (!record.acknowledgementRequested) {
      record.acknowledgementRequested = true;
      options.adapter.acknowledgeRepairSuccess({
        ...scope,
        repairToken: record.state.repairToken,
      });
    }
    if (record.acknowledgementRequired && !record.acknowledgementReceived) {
      return;
    }
    if (!record.serverReadyLatched) {
      return;
    }
    finishCurrentView(scope, record);
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const scheduleHeldChunk = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    chunk: VisibleOutputRecoveryChunk,
  ): void => {
    const key = getRecoveryScopeKey(scope);
    record.expectedDrainChunkIds.add(chunk.chunkId);
    record.tailDrained = false;
    // @req REL-BGSTAB-008
    // @req REL-BGSTAB-009
    const onWritten = (): void => {
      if (
        transactions.get(key) !== record
        || record.sealed
        || record.state.disposed
        || record.writtenChunkIds.has(chunk.chunkId)
      ) {
        return;
      }
      record.writtenChunkIds.add(chunk.chunkId);
      const heldIndex = record.state.heldChunks.findIndex(
        (heldChunk) => heldChunk.chunkId === chunk.chunkId,
      );
      if (heldIndex >= 0) {
        const [writtenChunk] = record.state.heldChunks.splice(heldIndex, 1);
        if (writtenChunk) {
          record.state.heldOutputBytes = Math.max(
            0,
            record.state.heldOutputBytes - recoveryTextEncoder.encode(writtenChunk.data).byteLength,
          );
        }
      }
      for (const [timerId, pendingChunkId] of record.activeWriteTimers) {
        if (pendingChunkId !== chunk.chunkId) {
          continue;
        }
        record.activeWriteTimers.delete(timerId);
        options.adapter.cancelRestoreTimer?.(timerId);
      }
      syncActivityCounts(record);
      advanceReadyBarrier(scope, key, record);
    };
    options.adapter.enqueueScheduledOutput({ ...scope, chunk, onWritten });
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const acceptOutput = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event)) {
      return ignored(scope);
    }
    const chunk = event.chunk as VisibleOutputRecoveryChunk | undefined;
    if (
      !chunk
      || typeof chunk.chunkId !== 'string'
      || chunk.chunkId.length === 0
      || (
        chunk.screenSeq !== undefined
        && (typeof chunk.screenSeq !== 'number' || !Number.isFinite(chunk.screenSeq))
      )
      || typeof chunk.data !== 'string'
      || chunk.data.length === 0
    ) {
      return ignored(scope);
    }
    if (record.admittedChunkIds.has(chunk.chunkId)) {
      return ignored(scope);
    }
    record.admittedChunkIds.add(chunk.chunkId);
    if (
      record.acceptedSnapshot
      && chunk.screenSeq !== undefined
      && record.appliedSnapshotSeq !== null
      && chunk.screenSeq <= record.appliedSnapshotSeq
    ) {
      return { ignored: true, state: record.state };
    }
    const chunkBytes = recoveryTextEncoder.encode(chunk.data).byteLength;
    if (record.state.heldOutputBytes + chunkBytes > maxHeldBytes) {
      return overflow(scope, record, 'byte-cap-exceeded');
    }
    if (record.state.heldChunks.length + 1 > maxHeldChunks) {
      return overflow(scope, record, 'chunk-cap-exceeded');
    }
    record.state.heldChunks.push(chunk);
    record.state.heldOutputBytes += chunkBytes;
    if (record.acceptedSnapshot && !record.snapshotWritePending) {
      scheduleHeldChunk(scope, record, chunk);
    }
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const acceptSnapshot = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (
      record.acceptedSnapshot
      || record.pendingSnapshot !== null
      || record.snapshotWritePending
      || !matchesCurrentTransaction(record, event, {
        requireRepairToken: true,
        requireReplayToken: true,
      })
    ) {
      return ignored(scope);
    }
    const parserBoundary = readString(event, 'parserBoundary');
    const pendingEscapeTailAnsi = readString(event, 'pendingEscapeTailAnsi') ?? '';
    const hasExplicitParserState = typeof event.parserComplete === 'boolean'
      || event.pendingEscapeTailAnsi !== undefined;
    const parserComplete = event.parserComplete === undefined
      ? parserBoundary === 'complete'
      : event.parserComplete === true;
    record.state.parserComplete = parserComplete;
    record.state.pendingEscapeTailAnsi = pendingEscapeTailAnsi;
    if (hasExplicitParserState) {
      record.acknowledgementRequired = true;
    }
    if (parserBoundary !== 'complete' || !parserComplete || pendingEscapeTailAnsi.length > 0) {
      return sealFailure(scope, record, 'parser-incomplete', 'reconnect-required', false);
    }
    const snapshotSeq = readNumber(event, 'snapshotSeq');
    if (snapshotSeq === undefined) {
      return ignored(scope);
    }
    record.acceptedSnapshot = true;
    record.snapshotWritePending = false;
    record.pendingSnapshot = null;
    record.appliedSnapshotSeq = snapshotSeq;
    const tail = record.state.heldChunks.filter((chunk) => (
      chunk.screenSeq === undefined || chunk.screenSeq > snapshotSeq
    ));
    record.state.heldChunks = tail;
    record.state.heldOutputBytes = tail.reduce(
      (total, chunk) => total + recoveryTextEncoder.encode(chunk.data).byteLength,
      0,
    );
    record.writtenChunkIds.clear();
    record.expectedDrainChunkIds.clear();
    record.tailDrained = tail.length === 0;
    const key = getRecoveryScopeKey(scope);
    if (tail.length === 0) {
      advanceReadyBarrier(scope, key, record);
      return { ignored: false, state: record.state };
    }

    for (const chunk of tail) {
      scheduleHeldChunk(scope, record, chunk);
    }
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const schedulePendingSnapshot = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
  ): void => {
    const snapshot = record.pendingSnapshot;
    if (
      !snapshot
      || !record.liveSchedulerIdle
      || record.snapshotWritePending
      || record.acceptedSnapshot
      || record.sealed
    ) {
      return;
    }
    if (!options.adapter.enqueueAuthoritativeSnapshot) {
      sealFailure(scope, record, 'authority-unavailable', 'authority-unavailable', false);
      return;
    }
    record.snapshotWritePending = true;
    const key = getRecoveryScopeKey(scope);
    // @req REL-BGSTAB-009
    const onWritten = (): void => {
      if (
        transactions.get(key) !== record
        || record.sealed
        || record.state.disposed
        || record.pendingSnapshot !== snapshot
        || !record.snapshotWritePending
      ) {
        return;
      }
      record.snapshotWritePending = false;
      record.pendingSnapshot = null;
      acceptSnapshot(scope, record, {
        type: 'authoritative-snapshot-applied',
        ...scope,
        ...snapshot,
      });
    };
    options.adapter.enqueueAuthoritativeSnapshot({ ...scope, data: snapshot.data, onWritten });
  };

  // @req REL-BGSTAB-009
  const receiveSnapshot = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (
      record.acceptedSnapshot
      || record.pendingSnapshot
      || !matchesCurrentTransaction(record, event, {
        requireRepairToken: true,
        requireReplayToken: true,
      })
    ) {
      return ignored(scope);
    }
    const snapshotSeq = readNumber(event, 'snapshotSeq');
    const parserBoundary = readString(event, 'parserBoundary');
    const data = readString(event, 'data');
    if (snapshotSeq === undefined || parserBoundary === undefined || data === undefined) {
      return ignored(scope);
    }
    record.acknowledgementRequired = true;
    record.pendingSnapshot = {
      transactionId: record.state.transactionId,
      repairToken: record.state.repairToken,
      replayToken: record.state.replayToken,
      connectionGeneration: record.state.connectionGeneration,
      sessionGeneration: record.state.sessionGeneration,
      viewGeneration: record.state.viewGeneration,
      xtermGeneration: record.state.xtermGeneration,
      snapshotSeq,
      parserBoundary,
      parserComplete: event.parserComplete === undefined
        ? parserBoundary === 'complete'
        : event.parserComplete === true,
      pendingEscapeTailAnsi: readString(event, 'pendingEscapeTailAnsi') ?? '',
      data,
    };
    schedulePendingSnapshot(scope, record);
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const markLiveLaneIdle = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event) || record.liveSchedulerIdle) {
      return ignored(scope);
    }
    record.liveSchedulerIdle = true;
    schedulePendingSnapshot(scope, record);
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const failRecovery = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, {
      requireRepairToken: true,
      requireReplayToken: true,
    })) {
      return ignored(scope);
    }
    const reason = readString(event, 'reason') || 'unspecified-recovery-failure';
    const outcome = resolveRecoveryFailureOutcome(reason, readString(event, 'outcome'));
    return sealFailure(scope, record, reason, outcome, outcome === 'fresh-snapshot-started');
  };

  // @req REL-BGSTAB-012 AC-7 AC-8 AC-9
  const acceptHiddenDataGap = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, {
      requireRepairToken: true,
      requireReplayToken: true,
    })) {
      return ignored(scope);
    }
    record.state.staleTerminal = true;
    record.state.currentViewTransactionReady = false;
    record.state.retainedHistoryEquivalent = false;
    record.state.recoveryScope = 'browser-view-only';
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const acceptQueuedInput = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, { allowSealed: true })) {
      return ignored(scope);
    }
    if (record.state.currentViewTransactionReady) {
      return ignored(scope);
    }
    const data = readString(event, 'data');
    if (data === undefined || data.length === 0) {
      return ignored(scope);
    }
    const dataBytes = recoveryTextEncoder.encode(data).byteLength;
    if (
      record.queuedInputs.length + 1 > maxHeldChunks
      || record.queuedInputBytes + dataBytes > maxHeldBytes
    ) {
      options.adapter.publishOutcome({
        ...scope,
        outcome: 'input-rejected',
        reason: 'queued-input-cap-exceeded',
      });
      return { ignored: false, state: record.state };
    }
    record.acknowledgementRequired = true;
    record.queuedInputs.push(data);
    record.queuedInputBytes += dataBytes;
    syncActivityCounts(record);
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const suppressReplayAutoReply = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event)) {
      return ignored(scope);
    }
    record.acknowledgementRequired = true;
    options.adapter.publishOutcome({
      ...scope,
      outcome: 'replay-auto-reply-suppressed',
      reason: 'restore-replay-guard',
    });
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const armWriteTimeout = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event)) {
      return ignored(scope);
    }
    const timerId = readString(event, 'timerId');
    const requestedChunkId = readString(event, 'pendingChunkId');
    const outstandingChunkIds = [...record.expectedDrainChunkIds].filter(
      (chunkId) => !record.writtenChunkIds.has(chunkId),
    );
    const pendingChunkId = requestedChunkId
      ?? (outstandingChunkIds.length === 1 ? outstandingChunkIds[0] : undefined);
    if (
      !timerId
      || !pendingChunkId
      || !record.expectedDrainChunkIds.has(pendingChunkId)
      || record.writtenChunkIds.has(pendingChunkId)
      || record.activeWriteTimers.has(timerId)
      || [...record.activeWriteTimers.values()].includes(pendingChunkId)
      || record.activeWriteTimers.size >= maxHeldChunks
    ) {
      return ignored(scope);
    }
    record.activeWriteTimers.set(timerId, pendingChunkId);
    syncActivityCounts(record);
    options.adapter.scheduleRestoreTimer?.({ ...scope, timerId });
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const requestCompletionProbe = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, {
      requireRepairToken: true,
      requireReplayToken: true,
    })) {
      return ignored(scope);
    }
    const pendingChunkId = readString(event, 'pendingChunkId');
    if (
      !pendingChunkId
      || !record.expectedDrainChunkIds.has(pendingChunkId)
      || record.writtenChunkIds.has(pendingChunkId)
      || record.activeProbeIds.size > 0
    ) {
      return ignored(scope);
    }
    const requestedTimerId = readString(event, 'timerId');
    const matchingTimerIds = [...record.activeWriteTimers]
      .filter(([, chunkId]) => chunkId === pendingChunkId)
      .map(([timerId]) => timerId);
    if (
      (requestedTimerId && record.activeWriteTimers.get(requestedTimerId) !== pendingChunkId)
      || (!requestedTimerId && matchingTimerIds.length > 1)
    ) {
      return ignored(scope);
    }
    const settledTimerId = requestedTimerId ?? matchingTimerIds[0];
    if (settledTimerId) {
      record.activeWriteTimers.delete(settledTimerId);
      options.adapter.cancelRestoreTimer?.(settledTimerId);
    }
    record.nextProbeOrdinal += 1;
    const probeId = `fifo-probe-${record.nextProbeOrdinal}`;
    record.activeProbeIds.add(probeId);
    syncActivityCounts(record);
    if (!options.adapter.enqueueCompletionProbe) {
      record.activeProbeIds.delete(probeId);
      syncActivityCounts(record);
      return sealFailure(scope, record, 'write-callback-timeout', 'fresh-snapshot-started', true);
    }
    const key = getRecoveryScopeKey(scope);
    // @req REL-BGSTAB-009
    const onWritten = (): void => {
      if (
        transactions.get(key) !== record
        || record.sealed
        || record.state.disposed
        || !record.activeProbeIds.delete(probeId)
      ) {
        return;
      }
      syncActivityCounts(record);
      advanceReadyBarrier(scope, key, record);
    };
    options.adapter.enqueueCompletionProbe({ ...scope, probeId, data: '', onWritten });
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const timeoutCompletionProbe = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, {
      requireRepairToken: true,
      requireReplayToken: true,
    })) {
      return ignored(scope);
    }
    const probeId = readString(event, 'probeId');
    if (!probeId || !record.activeProbeIds.delete(probeId)) {
      return ignored(scope);
    }
    syncActivityCounts(record);
    return sealFailure(scope, record, 'write-callback-timeout', 'fresh-snapshot-started', true);
  };

  // @req REL-BGSTAB-009
  const acknowledgeRepair = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (
      !matchesCurrentTransaction(record, event, {
        requireRepairToken: true,
        requireReplayToken: true,
      })
      || !record.acknowledgementRequested
      || record.acknowledgementReceived
    ) {
      return ignored(scope);
    }
    record.acknowledgementReceived = true;
    advanceReadyBarrier(scope, getRecoveryScopeKey(scope), record);
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-009
  const failRepairAcknowledgement = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, {
      requireRepairToken: true,
      requireReplayToken: true,
    })) {
      return ignored(scope);
    }
    const reason = readString(event, 'reason') || 'repair-ack-failed';
    return sealFailure(scope, record, reason, 'fresh-snapshot-started', true);
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const closeRecovery = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event, { allowSealed: true })) {
      return ignored(scope);
    }
    record.sealed = true;
    record.state.disposed = true;
    record.state.staleTerminal = true;
    record.state.terminalFailed = true;
    record.state.restoreNeeded = true;
    record.state.discardedQueueGeneration = record.state.viewGeneration;
    record.state.currentViewTransactionReady = false;
    record.state.retainedHistoryEquivalent = false;
    clearHeldOutput(record);
    rejectQueuedInputs(
      scope,
      record,
      event.type === 'connection-closed' ? 'connection-closed' : 'recovery-disposed',
    );
    cancelTransactionResources(record);
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const latchServerReady = (
    scope: VisibleOutputRecoveryScope,
    record: RecoveryTransactionRecord,
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    if (!matchesCurrentTransaction(record, event)) {
      return ignored(scope);
    }
    const repairToken = readString(event, 'repairToken');
    const replayToken = readString(event, 'replayToken');
    if (
      (repairToken !== undefined && repairToken !== record.state.repairToken)
      || (replayToken !== undefined && replayToken !== record.state.replayToken)
      || (repairToken === undefined && replayToken === undefined)
      || record.serverReadyLatched
    ) {
      return ignored(scope);
    }
    record.serverReadyLatched = true;
    advanceReadyBarrier(scope, getRecoveryScopeKey(scope), record);
    return { ignored: false, state: record.state };
  };

  // @req REL-BGSTAB-008
  // @req REL-BGSTAB-009
  const dispatch = (
    event: VisibleOutputRecoveryCoordinatorEvent,
  ): VisibleOutputRecoveryCoordinatorResult => {
    const scope = { clientId: event.clientId, sessionId: event.sessionId };
    if (options.transportMode !== 'unified') {
      publishSplitLimitation(scope);
      return ignored(scope);
    }
    if (event.type === 'begin-resync') {
      return begin(scope, event);
    }
    const record = transactions.get(getRecoveryScopeKey(scope));
    if (!record) {
      return ignored(scope);
    }
    switch (event.type) {
      case 'output-arrived':
        return acceptOutput(scope, record, event);
      case 'authoritative-snapshot-applied':
        return acceptSnapshot(scope, record, event);
      case 'authoritative-snapshot-received':
        return receiveSnapshot(scope, record, event);
      case 'live-lane-idle':
        return markLiveLaneIdle(scope, record, event);
      case 'queued-user-input':
        return acceptQueuedInput(scope, record, event);
      case 'xterm-auto-reply':
        return suppressReplayAutoReply(scope, record, event);
      case 'arm-write-timeout':
        return armWriteTimeout(scope, record, event);
      case 'write-callback-timeout':
        return requestCompletionProbe(scope, record, event);
      case 'completion-probe-timeout':
        return timeoutCompletionProbe(scope, record, event);
      case 'repair-acknowledged':
        return acknowledgeRepair(scope, record, event);
      case 'repair-ack-failed':
        return failRepairAcknowledgement(scope, record, event);
      case 'ime-cancelled':
        if (!matchesCurrentTransaction(record, event)) {
          return ignored(scope);
        }
        return sealFailure(scope, record, 'ime-cancelled', 'fresh-snapshot-started', true);
      case 'recovery-failed':
        return failRecovery(scope, record, event);
      case 'hidden-data-gap':
        return acceptHiddenDataGap(scope, record, event);
      case 'server-ready-latched':
        return latchServerReady(scope, record, event);
      case 'dispose':
      case 'connection-closed':
        return closeRecovery(scope, record, event);
      default:
        return ignored(scope);
    }
  };

  return {
    dispatch,
    getState,
    getTransportStatus: () => ({
      requestedTransportMode: options.transportMode,
      effectiveTransportMode: 'unified',
      splitActivationEnabled: false,
      standaloneSplitParity: 'unresolved',
    }),
  };
}
