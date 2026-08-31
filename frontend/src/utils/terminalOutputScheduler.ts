export {
  createTerminalWriteCoordinator,
  parseCanonicalOrdinal64,
  type TerminalWriteCoordinator,
  type TerminalWriteCoordinatorAdapter,
  type TerminalWriteCoordinatorCommand,
  type TerminalWriteCoordinatorOptions,
  type TerminalWriteCoordinatorResult,
  type TerminalWriteCoordinatorState,
  type TerminalWriteKind,
} from './terminalWriteCoordinator.ts';

export type TerminalOutputSchedulerDecision =
  | { ok: true }
  | { ok: false; reason: 'visible-output-overflow'; droppedBytes: number }
  | { ok: false; reason: 'canary-admission-rejected'; rejectedBytes: number };

export type TerminalOutputWriteData = string | Uint8Array;

export interface TerminalOutputFifoProbeIdentity {
  readonly owner: object;
  readonly generation: number;
  readonly writeToken: number;
}

export type TerminalOutputFifoProbeSettlement = 'retired' | 'advanced' | 'stale';

export interface TerminalOutputPolicyLeaseTarget {
  readonly viewId: string;
  readonly connectionId: string;
  readonly reconnectGeneration: number;
}

export interface TerminalOutputPolicyLeaseDecision {
  readonly candidateQueueMaxBytes: number;
  readonly legacyQueueMaxBytes: number;
  readonly policyGeneration: number;
}

export interface TerminalOutputPolicyLease {
  readonly leaseId: string;
  readonly policyId: string;
  readonly profileVersion: string;
  readonly target: TerminalOutputPolicyLeaseTarget;
  readonly decision: TerminalOutputPolicyLeaseDecision;
}

export type TerminalOutputPolicyLeaseIssuance =
  | { mode: 'candidate'; reason: 'candidate-selected'; lease: TerminalOutputPolicyLease }
  | { mode: 'legacy'; reason: 'candidate-not-trusted' | 'candidate-decision-mismatch'; lease?: undefined };

export interface TerminalOutputPolicyLeaseIssuer {
  issue: (input: {
    target: TerminalOutputPolicyLeaseTarget;
    decision: TerminalOutputPolicyLeaseDecision;
  }) => TerminalOutputPolicyLeaseIssuance;
  validate: (value: unknown) => value is TerminalOutputPolicyLease;
}

export interface TerminalOutputPolicyLeaseIssuerOptions {
  trustedEvidence: {
    requirementId: string;
    status: string;
    manifestSha256: string;
  };
  profile: {
    policyId: string;
    profileVersion: string;
    schemaVersion: string;
    stability: 'draft' | 'evolving' | 'stable';
    requiredCapabilityVersion: number;
    selectionId: string;
    approvedResourceDecision: Readonly<{
      candidateQueueMaxBytes: number;
      legacyQueueMaxBytes: number;
    }>;
  };
  capability?: {
    consumer: 'frontend.output-scheduler';
    version: number;
    compilerSchemaVersion: string;
  };
}

export interface TerminalOutputCanaryTransitionSnapshot {
  readonly mode: 'candidate' | 'legacy';
  readonly reason: string;
  readonly policyGeneration: number;
}

export interface TerminalOutputCanaryLedgerEntry {
  readonly sequence: number;
  readonly event: 'candidate-selected' | 'transition-rejected' | 'admission-accepted' | 'admission-rejected'
    | 'rollback-requested' | 'rollback-draining' | 'rollback-closed' | 'transition-aborted';
  readonly policyId: string;
  readonly profileVersion: string;
  readonly target: TerminalOutputPolicyLeaseTarget;
  readonly previousEffectiveDecision: number;
  readonly nextEffectiveDecision: number;
  readonly policyGeneration: number;
  readonly accepted: boolean;
  readonly reason: string;
  readonly rollbackResult: null | 'requested' | 'draining' | 'closed' | 'aborted';
}

export interface TerminalOutputCanaryLedgerSnapshot {
  readonly capacity: number;
  readonly totalEvents: number;
  readonly droppedEntries: number;
  readonly entries: readonly TerminalOutputCanaryLedgerEntry[];
}

export interface TerminalOutputCanaryCleanupSnapshot {
  readonly targetHandles: number;
  readonly listeners: number;
  readonly timers: number;
  readonly retainedEntries: number;
}

export type TerminalOutputPolicyProfile = TerminalOutputPolicyLeaseIssuerOptions['profile'];

export interface TerminalOutputPolicySelection {
  readonly selectionId: string;
  readonly policyGeneration: number;
  readonly target: TerminalOutputPolicyLeaseTarget;
  readonly profiles: readonly TerminalOutputPolicyProfile[];
}

export interface TerminalOutputPolicySelectionCoordinator {
  select: (input: Readonly<{
    selectionId: string;
    policyGeneration: number;
    target: TerminalOutputPolicyLeaseTarget;
  }>) => TerminalOutputPolicySelection;
}

export type TerminalOutputIngressRetryAttempt = 'accepted' | 'retryable' | 'failed';

export interface TerminalOutputIngressRetryFallback {
  readonly reason: 'retry-cap-exceeded' | 'retry-barrier-rejected' | 'idle-retry-rejected' | 'retry-attempt-failed';
  readonly bytes: number;
  readonly chunks: number;
}

export interface TerminalOutputIngressRetryQueue {
  defer: (entry: Readonly<{
    data: TerminalOutputWriteData;
    onWritten: () => void;
    onRejected: () => void;
  }>) => boolean;
  reset: () => void;
  getSnapshot: () => Readonly<{
    queuedBytes: number;
    queuedChunks: number;
    barrierArmed: boolean;
  }>;
}

export interface TerminalOutputIngressRetryQueueOptions {
  maxBytes: number;
  maxChunks: number;
  maxSingleIngressBytes?: number;
  attempt: (data: TerminalOutputWriteData, onWritten: () => void) => TerminalOutputIngressRetryAttempt;
  attemptLegacy?: (data: TerminalOutputWriteData, onWritten: () => void) => TerminalOutputIngressRetryAttempt;
  isIdle: () => boolean;
  armBarrier: (onReady: () => void) => boolean;
  armLegacyBarrier?: (onReady: () => void) => boolean;
  onLegacyFallback?: (info: TerminalOutputIngressRetryFallback) => void;
  onIngressRejected?: (info: Readonly<{ reason: 'ingress-hard-bound'; bytes: number; chunks: number }>) => void;
  textEncoder?: Pick<TextEncoder, 'encode'>;
}

export interface TerminalRestoreBufferedOutputFlushOptions<Entry = string> {
  peek: () => Entry | undefined;
  getData?: (entry: Entry) => TerminalOutputWriteData;
  commit: (expected: Entry) => boolean;
  write: (data: TerminalOutputWriteData, onWritten: () => void, onRejected: () => void) => boolean;
  onWritten: () => void;
  onSettled: (success: boolean) => void;
  isCurrent?: () => boolean;
}

export interface TerminalRestoreReleaseSingleFlight {
  run: (
    attemptEpoch: number,
    start: (settle: (success: boolean) => void) => void,
  ) => Promise<boolean>;
  supersede: () => void;
  getActiveEpoch: () => number | null;
}

export interface TerminalRestoreHeldOutputEntry {
  readonly id: number;
  readonly data: TerminalOutputWriteData;
  readonly screenSeq?: number;
  readonly replayToken?: string;
  readonly authorityEpoch?: string;
  readonly authorityRevision?: number;
  readonly connectionGeneration?: number;
  readonly onWritten?: () => void;
  readonly attemptEpoch: number;
}

export interface TerminalRestoreHeldOutputCoverageTransaction {
  readonly covered: readonly TerminalRestoreHeldOutputEntry[];
  readonly remaining: readonly TerminalRestoreHeldOutputEntry[];
  readonly unproven: readonly TerminalRestoreHeldOutputEntry[];
  recordDrained: (entry: TerminalRestoreHeldOutputEntry) => void;
  rollback: (current: readonly TerminalRestoreHeldOutputEntry[]) => readonly TerminalRestoreHeldOutputEntry[];
  commit: () => void;
}

export interface TerminalRestoreAttemptFenceIdentity<Owner> {
  readonly attemptEpoch: number;
  readonly term: Owner;
}

// @req REL-BGSTAB-010
export function isTerminalRestoreAttemptCurrent<Owner>(
  attempt: TerminalRestoreAttemptFenceIdentity<Owner>,
  current: Readonly<{
    attemptEpoch: number;
    term: Owner | null;
    restorePending: boolean;
    disposed: boolean;
  }>,
): boolean {
  return current.attemptEpoch === attempt.attemptEpoch
    && current.term === attempt.term
    && current.restorePending
    && !current.disposed;
}

export interface TerminalOutputPolicyRuntime {
  readonly target: TerminalOutputPolicyLeaseTarget;
  readonly selection: TerminalOutputPolicySelection;
  validate: (value: unknown) => value is TerminalOutputPolicyLease;
  issue: () => TerminalOutputPolicyLeaseIssuance
    | { mode: 'legacy'; reason: 'candidate-unavailable' | 'candidate-ambiguous'; lease?: undefined };
  getSnapshot: () => Readonly<{
    stableProfileCount: number;
    selectedProfileCount: number;
    mode: 'candidate' | 'legacy';
    reason: 'candidate-available' | 'candidate-unavailable' | 'candidate-ambiguous';
  }>;
}

export interface TerminalOutputSchedulerOptions {
  visibleOutputQueueMaxBytes: number;
  visibleOutputMaxChunks: number;
  visibleFlushBudgetBytes: number;
  visibleFlushFrameBudgetMs?: number;
  write: (data: TerminalOutputWriteData, onWritten: () => void, onRejected: () => void) => void;
  textEncoder?: Pick<TextEncoder, 'encode'>;
  schedule?: (drain: () => void) => void;
  shouldYield?: () => boolean;
  now?: () => number;
  canaryTarget?: TerminalOutputPolicyLeaseTarget;
  validateCanaryPolicyLease?: (value: unknown) => value is TerminalOutputPolicyLease;
  canaryLedgerCapacity?: number;
}

export type TerminalOutputSchedulerConfig = Pick<
  TerminalOutputSchedulerOptions,
  'visibleOutputQueueMaxBytes' | 'visibleOutputMaxChunks' | 'visibleFlushBudgetBytes' | 'visibleFlushFrameBudgetMs'
>;

export interface TerminalOutputScheduler {
  enqueue: (
    data: string,
    onWritten?: () => void,
    onRejected?: () => void,
  ) => TerminalOutputSchedulerDecision;
  /**
   * Byte ingress. Separate from `enqueue` rather than a widened parameter because
   * `TextEncoder.encode` accepts a `Uint8Array` and silently encodes its decimal
   * rendering — `[27,91,49]` becomes the text `27,91,49`. Distinct entry points
   * keep that coercion unreachable.
   */
  enqueueBytes: (
    bytes: Uint8Array,
    onWritten?: () => void,
    onRejected?: () => void,
  ) => TerminalOutputSchedulerDecision;
  enqueueLegacy: (
    data: string,
    onWritten?: () => void,
    onRejected?: () => void,
  ) => TerminalOutputSchedulerDecision;
  /**
   * Byte ingress for the legacy fallback. Without it the canary-rollback path
   * (`attemptLegacy`) could not carry bytes, so byte output would be dropped
   * exactly while the system is already degrading.
   */
  enqueueBytesLegacy: (
    bytes: Uint8Array,
    onWritten?: () => void,
    onRejected?: () => void,
  ) => TerminalOutputSchedulerDecision;
  enqueueBarrier: (onIdle: () => void) => TerminalOutputSchedulerDecision;
  enqueueReliableBarrier: (onIdle: () => void) => TerminalOutputSchedulerDecision;
  configure: (options: Partial<TerminalOutputSchedulerConfig>) => void;
  flush: () => void;
  reset: (reason?:
    | 'scheduler-reset'
    | 'terminal-clear'
    | 'visible-output-recovery'
    | 'policy-target-changed'
    | 'terminal-identity-changed'
    | 'terminal-disposed'
  ) => void;
  captureFifoProbeIdentity: () => TerminalOutputFifoProbeIdentity | null;
  settleFifoProbe: (identity: TerminalOutputFifoProbeIdentity) => TerminalOutputFifoProbeSettlement;
  configureCanaryTransition: (lease: TerminalOutputPolicyLease) => TerminalOutputCanaryTransitionSnapshot;
  rollbackCanaryTransition: (lease: TerminalOutputPolicyLease) => Readonly<{
    state: 'draining' | 'closed';
    reason: 'rollback-draining' | 'rollback-closed' | 'invalid-policy-lease' | 'stale-policy-generation';
  }>;
  getCanaryTransitionSnapshot: () => TerminalOutputCanaryTransitionSnapshot;
  getCanaryLedgerSnapshot: () => TerminalOutputCanaryLedgerSnapshot;
  getCanaryCleanupSnapshot: () => TerminalOutputCanaryCleanupSnapshot;
  isIdle: () => boolean;
  isStale: () => boolean;
  pendingBytes: () => number;
}

interface PendingOutputSegment {
  bytes: Uint8Array;
  headOffset: number;
  sequence: number;
  sequenceBoundaries: Array<{
    byteOffset: number;
    sequence: number;
  }>;
  callbacks: Array<{
    byteOffset: number;
    callback: () => void;
    onRejected?: () => void;
  }>;
}

const defaultTextEncoder = new TextEncoder();
export const DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS = 7;
const TERMINAL_OUTPUT_POLICY_MANIFEST_SHA256 = '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57';
const TERMINAL_OUTPUT_POLICY_SCHEMA_VERSION = 'terminal-resource-policy/v1';
const TERMINAL_OUTPUT_POLICY_CAPABILITY_VERSION = 7;
export const TERMINAL_OUTPUT_POLICY_SELECTION_ID = 'frontend-output-policy-reviewed';

// @req REL-BGSTAB-010
export function createTerminalOutputPolicyLeaseIssuer(
  options: TerminalOutputPolicyLeaseIssuerOptions,
): TerminalOutputPolicyLeaseIssuer {
  const issuedLeases = new WeakSet<object>();
  const trusted = isTrustedTerminalOutputPolicyIssuerOptions(options);
  const approvedResourceDecision = trusted
    ? Object.freeze({ ...options.profile.approvedResourceDecision })
    : null;
  const policyId = options.profile.policyId;
  const profileVersion = options.profile.profileVersion;
  let nextLeaseId = 0;

  return {
    // @req REL-BGSTAB-010
    issue(input) {
      if (!trusted || !isTerminalOutputPolicyLeaseInput(input)) {
        return { mode: 'legacy', reason: 'candidate-not-trusted' };
      }
      if (
        !approvedResourceDecision
        || input.decision.candidateQueueMaxBytes !== approvedResourceDecision.candidateQueueMaxBytes
        || input.decision.legacyQueueMaxBytes !== approvedResourceDecision.legacyQueueMaxBytes
      ) {
        return { mode: 'legacy', reason: 'candidate-decision-mismatch' };
      }

      const target = Object.freeze({ ...input.target });
      const decision = Object.freeze({ ...input.decision });
      const lease = Object.freeze({
        leaseId: `frontend-output-policy-lease:${++nextLeaseId}`,
        policyId,
        profileVersion,
        target,
        decision,
      });
      issuedLeases.add(lease);
      return { mode: 'candidate', reason: 'candidate-selected', lease };
    },
    // @req REL-BGSTAB-010
    validate(value): value is TerminalOutputPolicyLease {
      return typeof value === 'object' && value !== null && issuedLeases.has(value);
    },
  };
}

const EMPTY_TERMINAL_OUTPUT_POLICY_PROFILES: readonly TerminalOutputPolicyProfile[] = Object.freeze([]);

// @req REL-BGSTAB-010
export function createTerminalOutputPolicySelectionCoordinator(options: {
  profiles?: readonly TerminalOutputPolicyProfile[];
  selectTarget?: (target: TerminalOutputPolicyLeaseTarget) => boolean;
} = {}): TerminalOutputPolicySelectionCoordinator {
  const profiles = freezeTerminalOutputPolicyProfiles(
    options.profiles ?? EMPTY_TERMINAL_OUTPUT_POLICY_PROFILES,
  );
  const selectTarget = options.selectTarget ?? (() => false);
  return Object.freeze({
    select(input: {
      selectionId: string;
      policyGeneration: number;
      target: TerminalOutputPolicyLeaseTarget;
    }): TerminalOutputPolicySelection {
      const target = Object.freeze({ ...input.target });
      return Object.freeze({
        selectionId: input.selectionId,
        policyGeneration: input.policyGeneration,
        target,
        profiles: safelySelectTerminalOutputPolicyTarget(selectTarget, target)
          ? profiles
          : EMPTY_TERMINAL_OUTPUT_POLICY_PROFILES,
      });
    },
  });
}

// @req REL-BGSTAB-010
function isTerminalOutputWriteData(value: unknown): value is TerminalOutputWriteData {
  return typeof value === 'string' || value instanceof Uint8Array;
}

function safelySelectTerminalOutputPolicyTarget(
  selectTarget: (target: TerminalOutputPolicyLeaseTarget) => boolean,
  target: TerminalOutputPolicyLeaseTarget,
): boolean {
  try {
    return selectTarget(target) === true;
  } catch {
    return false;
  }
}

// @req REL-BGSTAB-010
// The component-owned restore buffer is committed only after the downstream
// scheduler confirms its write. Rejection is an explicit failed settlement;
// ownership remains with the component so a bounded recovery can retry it.
export function flushNextTerminalRestoreBufferedOutput<Entry = string>(
  options: TerminalRestoreBufferedOutputFlushOptions<Entry>,
): boolean {
  const pending = options.peek();
  if (pending === undefined) {
    options.onSettled(true);
    return true;
  }

  let settled = false;
  let settlement: boolean | null = null;
  const settle = (success: boolean): void => {
    if (settled) return;
    settled = true;
    settlement = success;
    options.onSettled(success);
  };
  const isCurrent = (): boolean => options.isCurrent?.() !== false;
  const onWritten = (): void => {
    if (settled || !isCurrent()) return;
    if (!options.commit(pending)) {
      settle(false);
      return;
    }
    options.onWritten();
    settle(true);
  };
  const onRejected = (): void => {
    if (!isCurrent()) return;
    settle(false);
  };

  if (!isCurrent()) {
    return false;
  }
  const data = options.getData
    ? options.getData(pending)
    : typeof pending === 'string'
      ? pending
      : '';
  // Widened to the two shapes `write` accepts, not removed. The second clause is
  // already unreachable in production (TerminalView always supplies getData) and
  // is left exactly as it was — callers without getData keep their contract.
  if (!isTerminalOutputWriteData(data) || (typeof pending !== 'string' && !options.getData)) {
    settle(false);
    return false;
  }

  let accepted = false;
  try {
    accepted = options.write(data, onWritten, onRejected);
  } catch {
    onRejected();
    return false;
  }
  if (!accepted && !settled) {
    onRejected();
  }
  return settlement ?? accepted;
}

// @req REL-BGSTAB-010
export function createTerminalRestoreReleaseSingleFlight(): TerminalRestoreReleaseSingleFlight {
  let active: {
    epoch: number;
    promise: Promise<boolean>;
    settle: (success: boolean) => void;
  } | null = null;

  const settleActive = (expected: NonNullable<typeof active>, success: boolean): void => {
    if (active !== expected) return;
    active = null;
    expected.settle(success);
  };

  return Object.freeze({
    run(
      attemptEpoch: number,
      start: (settle: (success: boolean) => void) => void,
    ): Promise<boolean> {
      const existing = active;
      if (existing?.epoch === attemptEpoch) {
        return existing.promise;
      }
      if (active) {
        settleActive(active, false);
      }

      let resolvePromise!: (success: boolean) => void;
      const promise = new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
      });
      const current = {
        epoch: attemptEpoch,
        promise,
        settle: resolvePromise,
      };
      active = current;
      try {
        start((success: boolean) => settleActive(current, success));
      } catch {
        settleActive(current, false);
      }
      return promise;
    },
    supersede(): void {
      if (active) settleActive(active, false);
    },
    getActiveEpoch: () => active?.epoch ?? null,
  });
}

// @req REL-BGSTAB-010
export function createTerminalRestoreHeldOutputCoverageTransaction(input: Readonly<{
  entries: readonly TerminalRestoreHeldOutputEntry[];
  failedAttemptEpochs: readonly number[];
  snapshotSeq: number;
  coversThroughSeq: number;
  replayToken: string;
  supersedesReplayToken?: string;
  authorityEpoch?: string;
  authorityRevision?: number;
  connectionGeneration?: number;
  minimumSnapshotSeq?: number;
}>): TerminalRestoreHeldOutputCoverageTransaction {
  const original = [...input.entries];
  const failedAttemptEpochs = new Set(input.failedAttemptEpochs);
  const covered: TerminalRestoreHeldOutputEntry[] = [];
  const remaining: TerminalRestoreHeldOutputEntry[] = [];
  const unproven: TerminalRestoreHeldOutputEntry[] = [];
  const validSnapshotSeq = Number.isSafeInteger(input.snapshotSeq)
    && input.snapshotSeq >= 0
    && Number.isSafeInteger(input.coversThroughSeq)
    && input.coversThroughSeq >= 0
    && input.coversThroughSeq <= input.snapshotSeq
    && (
      input.minimumSnapshotSeq === undefined
      || (
        Number.isSafeInteger(input.minimumSnapshotSeq)
        && input.minimumSnapshotSeq >= 0
        && input.snapshotSeq >= input.minimumSnapshotSeq
      )
    );
  let postCheckpointStarted = false;
  for (const entry of original) {
    const validEntrySeq = Number.isSafeInteger(entry.screenSeq) && entry.screenSeq! >= 0;
    const exactConnection = Number.isSafeInteger(entry.connectionGeneration)
      && entry.connectionGeneration! >= 0
      && Number.isSafeInteger(input.connectionGeneration)
      && input.connectionGeneration === entry.connectionGeneration;
    const matchingReplay = exactConnection && entry.replayToken !== undefined && (
      entry.replayToken === input.replayToken
      || entry.replayToken === input.supersedesReplayToken
    );
    const authorityRevisionIsValid = Number.isSafeInteger(entry.authorityRevision)
      && entry.authorityRevision! >= 0
      && Number.isSafeInteger(input.authorityRevision)
      && input.authorityRevision! >= 0;
    const matchingAuthority = typeof entry.authorityEpoch === 'string'
      && entry.authorityEpoch.length > 0
      && entry.authorityEpoch === input.authorityEpoch
      && authorityRevisionIsValid
      && Number.isSafeInteger(entry.connectionGeneration)
      && entry.connectionGeneration! >= 0
      && Number.isSafeInteger(input.connectionGeneration)
      && input.connectionGeneration! >= entry.connectionGeneration!;
    const contradictoryAuthority = (
      entry.authorityEpoch !== undefined
      && input.authorityEpoch !== undefined
      && entry.authorityEpoch !== input.authorityEpoch
    ) || (
      authorityRevisionIsValid
      && entry.screenSeq! <= input.coversThroughSeq
      && entry.authorityRevision! > input.authorityRevision!
    );
    if (
      !validSnapshotSeq
      || !validEntrySeq
      || contradictoryAuthority
      || (!matchingReplay && !matchingAuthority)
    ) {
      unproven.push(entry);
      continue;
    }
    const coveredByCheckpoint = entry.screenSeq! <= input.coversThroughSeq
      && (
        !matchingAuthority
        || entry.authorityRevision! <= input.authorityRevision!
      );
    const afterCheckpoint = entry.screenSeq! > input.coversThroughSeq
      && (
        !matchingAuthority
        || entry.authorityRevision! > input.authorityRevision!
      );
    if (afterCheckpoint) {
      postCheckpointStarted = true;
      remaining.push(entry);
      continue;
    }
    if (
      coveredByCheckpoint
      && failedAttemptEpochs.has(entry.attemptEpoch)
      && !postCheckpointStarted
      && unproven.length === 0
    ) {
      covered.push(entry);
      continue;
    }
    unproven.push(entry);
  }
  const drained = [...covered];
  let closed = false;

  return Object.freeze({
    covered: Object.freeze(covered),
    remaining: Object.freeze(remaining),
    unproven: Object.freeze(unproven),
    recordDrained(entry: TerminalRestoreHeldOutputEntry): void {
      if (!closed) drained.push(entry);
    },
    rollback(current: readonly TerminalRestoreHeldOutputEntry[]) {
      if (closed) return Object.freeze([...current]);
      closed = true;
      const byId = new Map<number, TerminalRestoreHeldOutputEntry>();
      for (const entry of [...original, ...drained, ...current]) {
        byId.set(entry.id, entry);
      }
      return Object.freeze([...byId.values()].sort((left, right) => left.id - right.id));
    },
    commit(): void {
      closed = true;
    },
  });
}

interface PendingTerminalOutputIngressRetry {
  readonly data: TerminalOutputWriteData;
  readonly bytes: number;
  readonly onWritten: () => void;
  readonly onRejected: () => void;
  settled: boolean;
  rejected: boolean;
}

// @req REL-BGSTAB-010
export function createTerminalOutputIngressRetryQueue(
  options: TerminalOutputIngressRetryQueueOptions,
): TerminalOutputIngressRetryQueue {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));
  const maxChunks = Math.max(1, Math.floor(options.maxChunks));
  const maxSingleIngressBytes = Math.max(
    maxBytes,
    Math.floor(options.maxSingleIngressBytes ?? maxBytes),
  );
  const textEncoder = options.textEncoder ?? defaultTextEncoder;
  const queue: PendingTerminalOutputIngressRetry[] = [];
  let queuedBytes = 0;
  let active = false;
  let activeEntry: PendingTerminalOutputIngressRetry | null = null;
  let barrierArmed = false;
  let legacyFallback = false;
  let generation = 0;

  const settle = (entry: PendingTerminalOutputIngressRetry, outcome: 'written' | 'rejected'): void => {
    if (entry.settled) return;
    entry.settled = true;
    entry.rejected = outcome === 'rejected';
    if (outcome === 'written') entry.onWritten();
    else entry.onRejected();
  };

  const rejectAll = (
    reason: TerminalOutputIngressRetryFallback['reason'],
    incoming?: PendingTerminalOutputIngressRetry,
  ): false => {
    const rejected = incoming ? [...queue, incoming] : [...queue];
    generation += 1;
    queue.splice(0, queue.length);
    queuedBytes = 0;
    barrierArmed = false;
    rejected.forEach(entry => settle(entry, 'rejected'));
    void reason;
    return false;
  };

  const removeHead = (entry: PendingTerminalOutputIngressRetry): void => {
    if (queue[0] !== entry) {
      rejectAll('retry-attempt-failed');
      return;
    }
    queue.shift();
    queuedBytes = Math.max(0, queuedBytes - entry.bytes);
  };

  let drain = (): void => {};
  const enterLegacyFallback = (
    reason: TerminalOutputIngressRetryFallback['reason'],
    incoming?: PendingTerminalOutputIngressRetry,
  ): void => {
    if (legacyFallback) return;
    legacyFallback = true;
    generation += 1;
    barrierArmed = false;
    options.onLegacyFallback?.({
      reason,
      bytes: queuedBytes + (incoming?.bytes ?? 0),
      chunks: queue.length + (incoming ? 1 : 0),
    });
  };

  const armBarrier = (legacy: boolean): boolean => {
    if (active || barrierArmed || queue.length === 0) return true;
    if (!legacy && options.isIdle()) {
      enterLegacyFallback('idle-retry-rejected');
      drain();
      return true;
    }
    barrierArmed = true;
    const barrierGeneration = generation;
    const accepted = (legacy ? options.armLegacyBarrier ?? options.armBarrier : options.armBarrier)(() => {
      if (barrierGeneration !== generation) return;
      barrierArmed = false;
      drain();
    });
    if (!accepted) {
      barrierArmed = false;
      if (!legacy) {
        enterLegacyFallback('retry-barrier-rejected');
        drain();
        return true;
      }
      return false;
    }
    return true;
  };

  drain = (): void => {
    if (active || barrierArmed) return;
    const entry = queue[0];
    if (!entry) return;

    active = true;
    activeEntry = entry;
    let decisionKnown = false;
    let completedSynchronously = false;
    const complete = (): void => {
      if (!decisionKnown) {
        completedSynchronously = true;
        return;
      }
      if (!active || activeEntry !== entry) return;
      settle(entry, 'written');
      active = false;
      activeEntry = null;
      drain();
    };
    const attempt = legacyFallback ? options.attemptLegacy ?? options.attempt : options.attempt;
    const result = attempt(entry.data, complete);
    decisionKnown = true;
    if (result === 'accepted') {
      removeHead(entry);
      if (completedSynchronously) complete();
      return;
    }

    active = false;
    activeEntry = null;
    if (result === 'failed') {
      if (!legacyFallback) {
        enterLegacyFallback('retry-attempt-failed');
        drain();
      } else {
        rejectAll('retry-attempt-failed');
      }
      return;
    }
    if (!legacyFallback && options.isIdle()) {
      enterLegacyFallback('idle-retry-rejected');
      drain();
      return;
    }
    if (!armBarrier(legacyFallback) && legacyFallback) {
      rejectAll('retry-barrier-rejected');
    }
  };

  return Object.freeze({
    defer(entry: Readonly<{
      data: TerminalOutputWriteData;
      onWritten: () => void;
      onRejected: () => void;
    }>): boolean {
      const pending: PendingTerminalOutputIngressRetry = {
        ...entry,
        // A byte view is already measured. Encoding it would stringify it, so a
        // 2-byte view would be accounted as the 7 bytes of "200,201".
        bytes: typeof entry.data === 'string'
          ? textEncoder.encode(entry.data).byteLength
          : entry.data.byteLength,
        settled: false,
        rejected: false,
      };
      const exceedsNormalCap = pending.bytes > maxBytes
        || queue.length + 1 > maxChunks
        || queuedBytes + pending.bytes > maxBytes;
      const exceedsHardBound = pending.bytes > maxSingleIngressBytes
        || queue.length + 1 > maxChunks + 1
        || queuedBytes + pending.bytes > maxBytes + maxSingleIngressBytes;
      if (exceedsHardBound) {
        options.onIngressRejected?.({
          reason: 'ingress-hard-bound',
          bytes: pending.bytes,
          chunks: 1,
        });
        settle(pending, 'rejected');
        return false;
      }
      if (exceedsNormalCap) {
        enterLegacyFallback('retry-cap-exceeded', pending);
      }
      queue.push(pending);
      queuedBytes += pending.bytes;
      if (legacyFallback) {
        drain();
        return !pending.rejected;
      }
      return armBarrier(false);
    },
    reset(): void {
      if (queue.length > 0) rejectAll('retry-attempt-failed');
      if (activeEntry) {
        settle(activeEntry, 'rejected');
        activeEntry = null;
        active = false;
      }
      if (queue.length === 0) {
        generation += 1;
        barrierArmed = false;
      }
      legacyFallback = false;
    },
    getSnapshot() {
      return Object.freeze({
        queuedBytes,
        queuedChunks: queue.length,
        barrierArmed,
      });
    },
  });
}

// @req REL-BGSTAB-010
export function createTerminalOutputPolicyRuntime(options: {
  target: TerminalOutputPolicyLeaseTarget;
  selection?: TerminalOutputPolicySelection;
}): TerminalOutputPolicyRuntime {
  const target = Object.freeze({ ...options.target });
  const sourceSelection = options.selection ?? {
    selectionId: '',
    policyGeneration: 0,
    target,
    profiles: EMPTY_TERMINAL_OUTPUT_POLICY_PROFILES,
  };
  const selectionTarget = Object.freeze({ ...sourceSelection.target });
  const selection = Object.freeze({
    selectionId: sourceSelection.selectionId,
    policyGeneration: sourceSelection.policyGeneration,
    target: selectionTarget,
    profiles: sameTerminalOutputPolicyTarget(target, selectionTarget)
      ? freezeTerminalOutputPolicyProfiles(sourceSelection.profiles)
      : EMPTY_TERMINAL_OUTPUT_POLICY_PROFILES,
  });
  const profiles = selection.profiles;
  const stableProfiles = profiles.filter(profile => isTrustedTerminalOutputPolicyIssuerOptions({
    trustedEvidence: {
      requirementId: 'OBS-BGSTAB-005',
      status: 'implemented',
      manifestSha256: TERMINAL_OUTPUT_POLICY_MANIFEST_SHA256,
    },
    profile,
    capability: {
      consumer: 'frontend.output-scheduler',
      version: TERMINAL_OUTPUT_POLICY_CAPABILITY_VERSION,
      compilerSchemaVersion: TERMINAL_OUTPUT_POLICY_SCHEMA_VERSION,
    },
  }));
  const selectedProfiles = stableProfiles.filter(profile => profile.selectionId === selection.selectionId);
  const profile = selectedProfiles.length === 1 ? selectedProfiles[0] : null;
  const issuer = profile
    ? createTerminalOutputPolicyLeaseIssuer({
        trustedEvidence: {
          requirementId: 'OBS-BGSTAB-005',
          status: 'implemented',
          manifestSha256: TERMINAL_OUTPUT_POLICY_MANIFEST_SHA256,
        },
        profile,
        capability: {
          consumer: 'frontend.output-scheduler',
          version: TERMINAL_OUTPUT_POLICY_CAPABILITY_VERSION,
          compilerSchemaVersion: TERMINAL_OUTPUT_POLICY_SCHEMA_VERSION,
        },
      })
    : null;
  const unavailableReason = selectedProfiles.length > 1 ? 'candidate-ambiguous' as const : 'candidate-unavailable' as const;
  const snapshot = Object.freeze(profile
    ? {
        stableProfileCount: stableProfiles.length,
        selectedProfileCount: 1,
        mode: 'candidate' as const,
        reason: 'candidate-available' as const,
      }
    : {
        stableProfileCount: stableProfiles.length,
        selectedProfileCount: selectedProfiles.length,
        mode: 'legacy' as const,
        reason: unavailableReason,
      });

  const runtime: TerminalOutputPolicyRuntime = {
    target,
    selection,
    validate(value: unknown): value is TerminalOutputPolicyLease {
      return issuer?.validate(value) === true;
    },
    issue() {
      if (!issuer) {
        return { mode: 'legacy' as const, reason: unavailableReason };
      }
      return issuer.issue({
        target,
        decision: {
          ...profile!.approvedResourceDecision,
          policyGeneration: selection.policyGeneration,
        },
      });
    },
    getSnapshot() {
      return snapshot;
    },
  };
  return Object.freeze(runtime);
}

// @req REL-BGSTAB-010
export function bindTerminalOutputPolicyRuntime(
  runtime: TerminalOutputPolicyRuntime,
  scheduler: Pick<TerminalOutputScheduler, 'configureCanaryTransition'>,
): TerminalOutputCanaryTransitionSnapshot {
  const issuance = runtime.issue();
  if (issuance.mode !== 'candidate') {
    return Object.freeze({
      mode: 'legacy',
      reason: issuance.reason,
      policyGeneration: runtime.selection.policyGeneration,
    });
  }
  return scheduler.configureCanaryTransition(issuance.lease);
}

export function createTerminalOutputScheduler(options: TerminalOutputSchedulerOptions): TerminalOutputScheduler {
  let config: TerminalOutputSchedulerConfig = {
    visibleOutputQueueMaxBytes: options.visibleOutputQueueMaxBytes,
    visibleOutputMaxChunks: options.visibleOutputMaxChunks,
    visibleFlushBudgetBytes: options.visibleFlushBudgetBytes,
    visibleFlushFrameBudgetMs: normalizeFrameBudgetMs(options.visibleFlushFrameBudgetMs),
  };
  let queue: PendingOutputSegment[] = [];
  let queueHead = 0;
  let queuedBytes = 0;
  let inFlight = false;
  let scheduled = false;
  let stale = false;
  let generation = 0;
  let consecutiveInputYields = 0;
  let scheduleToken = 0;
  let activeWriteToken = 0;
  let nextWriteToken = 0;
  let activeEntry: PendingOutputSegment | null = null;
  let pendingBarrierCount = 0;
  let reliableBarrierPending = false;
  let activeCanaryDecision: TerminalOutputPolicyLeaseDecision | null = null;
  let activeCanaryLease: TerminalOutputPolicyLease | null = null;
  let latestCanaryPolicyGeneration = 0;
  let rollbackBoundarySequence: number | null = null;
  let rollbackLegacyQueueMaxBytes: number | null = null;
  let rollbackPreviousEffectiveDecision: number | null = null;
  let fallbackGrandfatheredPendingBytes: number | null = null;
  let nextOutputSequence = 0;
  let completedOutputSequence = 0;
  const canaryLedgerCapacity = normalizeCanaryLedgerCapacity(options.canaryLedgerCapacity);
  const canaryLedgerEntries: TerminalOutputCanaryLedgerEntry[] = [];
  let canaryLedgerTotalEvents = 0;
  let canaryTransitionSnapshot: TerminalOutputCanaryTransitionSnapshot = Object.freeze({
    mode: 'legacy',
    reason: 'legacy-default',
    policyGeneration: 0,
  });
  const fifoProbeOwner = {};
  const canaryTarget = options.canaryTarget
    ? Object.freeze({ ...options.canaryTarget })
    : null;

  const textEncoder = options.textEncoder ?? defaultTextEncoder;
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? defaultNow;

  const appendCanaryLedger = (input: Omit<TerminalOutputCanaryLedgerEntry, 'sequence' | 'target'> & {
    target?: TerminalOutputPolicyLeaseTarget;
  }): void => {
    if (!canaryTarget && !input.target) {
      return;
    }
    const entry = Object.freeze({
      ...input,
      sequence: ++canaryLedgerTotalEvents,
      target: Object.freeze({ ...(input.target ?? canaryTarget!) }),
    });
    canaryLedgerEntries.push(entry);
    if (canaryLedgerEntries.length > canaryLedgerCapacity) {
      canaryLedgerEntries.splice(0, canaryLedgerEntries.length - canaryLedgerCapacity);
    }
  };

  const currentCanaryEffectiveDecision = (): number => {
    if (activeCanaryDecision && canaryTransitionSnapshot.mode === 'candidate') {
      return activeCanaryDecision.candidateQueueMaxBytes;
    }
    return rollbackLegacyQueueMaxBytes
      ?? activeCanaryDecision?.legacyQueueMaxBytes
      ?? config.visibleOutputQueueMaxBytes;
  };

  const closeCanaryRollbackIfBoundaryDrained = (): void => {
    if (rollbackBoundarySequence === null || completedOutputSequence < rollbackBoundarySequence) {
      return;
    }
    rollbackBoundarySequence = null;
    const lease = activeCanaryLease;
    canaryTransitionSnapshot = Object.freeze({
      mode: 'legacy',
      reason: 'rollback-closed',
      policyGeneration: latestCanaryPolicyGeneration,
    });
    if (lease) {
      appendCanaryLedger({
        event: 'rollback-closed',
        policyId: lease.policyId,
        profileVersion: lease.profileVersion,
        previousEffectiveDecision: rollbackPreviousEffectiveDecision ?? lease.decision.legacyQueueMaxBytes,
        nextEffectiveDecision: lease.decision.legacyQueueMaxBytes,
        policyGeneration: lease.decision.policyGeneration,
        accepted: true,
        reason: 'rollback-closed',
        rollbackResult: 'closed',
      });
    }
    activeCanaryDecision = null;
    activeCanaryLease = null;
    rollbackPreviousEffectiveDecision = null;
  };

  const settleSequenceBoundaries = (entry: PendingOutputSegment): void => {
    const settled = entry.sequenceBoundaries.filter(boundary => boundary.byteOffset <= entry.headOffset);
    if (settled.length === 0) {
      return;
    }
    entry.sequenceBoundaries = entry.sequenceBoundaries.filter(boundary => boundary.byteOffset > entry.headOffset);
    for (const boundary of settled) {
      completedOutputSequence = Math.max(completedOutputSequence, boundary.sequence);
    }
    closeCanaryRollbackIfBoundaryDrained();
  };

  // @req REL-BGSTAB-010
  const resolveAdmission = (incomingBytes: number): Readonly<{
    canary: boolean;
    accepted: boolean;
    queueMaxBytes: number;
    effectiveDecision: number;
    reason: string;
  }> => {
    if (!activeCanaryDecision && rollbackLegacyQueueMaxBytes === null) {
      return {
        canary: false,
        accepted: true,
        queueMaxBytes: config.visibleOutputQueueMaxBytes,
        effectiveDecision: config.visibleOutputQueueMaxBytes,
        reason: 'legacy-default',
      };
    }

    const candidateDecision = activeCanaryDecision;
    if (
      candidateDecision
      && canaryTransitionSnapshot.mode === 'candidate'
      && queuedBytes + incomingBytes <= candidateDecision.candidateQueueMaxBytes
    ) {
      return {
        canary: true,
        accepted: true,
        queueMaxBytes: candidateDecision.candidateQueueMaxBytes,
        effectiveDecision: candidateDecision.candidateQueueMaxBytes,
        reason: 'candidate-admission-accepted',
      };
    }

    const legacyQueueMaxBytes = rollbackLegacyQueueMaxBytes
      ?? candidateDecision?.legacyQueueMaxBytes
      ?? config.visibleOutputQueueMaxBytes;
    const policyGeneration = candidateDecision?.policyGeneration ?? latestCanaryPolicyGeneration;
    if (candidateDecision && canaryTransitionSnapshot.reason !== 'rollback-draining') {
      canaryTransitionSnapshot = Object.freeze({
        mode: 'legacy',
        reason: 'candidate-cap-exceeded-fallback',
        policyGeneration,
      });
    }
    if (fallbackGrandfatheredPendingBytes === null) {
      fallbackGrandfatheredPendingBytes = queuedBytes;
    }
    const postFallbackPendingBytes = Math.max(0, queuedBytes - fallbackGrandfatheredPendingBytes);
    const accepted = postFallbackPendingBytes + incomingBytes <= legacyQueueMaxBytes;
    return {
      canary: true,
      accepted,
      queueMaxBytes: fallbackGrandfatheredPendingBytes + legacyQueueMaxBytes,
      effectiveDecision: legacyQueueMaxBytes,
      reason: accepted ? 'legacy-admission-accepted' : 'legacy-admission-fenced',
    };
  };

  const activeChunkCount = (): number => queue.length - queueHead;

  const compactConsumedHead = (): void => {
    if (queueHead === 0) {
      return;
    }
    queue.splice(0, queueHead);
    queueHead = 0;
  };

  const compactToChunkLimit = (): boolean => {
    compactConsumedHead();
    const maxChunks = normalizeChunkLimit(config.visibleOutputMaxChunks);
    const allocationLimit = normalizeFlushBudgetBytes(config.visibleFlushBudgetBytes);

    while (queue.length > maxChunks) {
      let mergeIndex = -1;
      for (let index = 0; index + 1 < queue.length; index += 1) {
        // The active segment is referenced by the in-flight callback and may
        // not be replaced underneath that callback. Queued callback offsets,
        // however, remain exact when two inactive segments are compacted.
        if (inFlight && queue[index] === activeEntry) {
          continue;
        }
        const leftBytes = queue[index].bytes.byteLength - queue[index].headOffset;
        const rightBytes = queue[index + 1].bytes.byteLength - queue[index + 1].headOffset;
        if (leftBytes + rightBytes <= allocationLimit) {
          mergeIndex = index;
          break;
        }
      }
      if (mergeIndex < 0) {
        return false;
      }

      queue.splice(
        mergeIndex,
        2,
        mergeOutputSegments(queue[mergeIndex], queue[mergeIndex + 1], rollbackBoundarySequence),
      );
    }
    return true;
  };

  const enterOverflow = (droppedBytes: number): TerminalOutputSchedulerDecision => {
    queue = [];
    queueHead = 0;
    queuedBytes = 0;
    stale = true;
    scheduleToken += 1;
    scheduled = false;
    pendingBarrierCount = 0;
    return {
      ok: false,
      reason: 'visible-output-overflow',
      droppedBytes,
    };
  };

  const requestFlush = (): void => {
    if (stale || inFlight || scheduled || activeChunkCount() === 0) {
      return;
    }
    scheduled = true;
    const currentGeneration = generation;
    const currentScheduleToken = ++scheduleToken;
    schedule(() => {
      if (currentGeneration !== generation || currentScheduleToken !== scheduleToken) {
        return;
      }
      scheduled = false;
      flush();
    });
  };

  const flush = (): void => {
    if (stale || inFlight || activeChunkCount() === 0) {
      return;
    }

    const frameDeadline = now() + normalizeFrameBudgetMs(config.visibleFlushFrameBudgetMs);
    drainFrame(frameDeadline);
  };

  const drainFrame = (frameDeadline: number): void => {
    while (!stale && !inFlight && activeChunkCount() > 0) {
      if (consecutiveInputYields === 0 && options.shouldYield?.()) {
        consecutiveInputYields += 1;
        requestFlush();
        return;
      }
      consecutiveInputYields = 0;

      const currentGeneration = generation;
      const entry = queue[queueHead];
      let sliceEnd = findUtf8SliceEnd(
        entry.bytes,
        entry.headOffset,
        config.visibleFlushBudgetBytes,
      );
      const nextCallbackOffset = entry.callbacks.reduce(
        (nearest, pending) => (
          pending.byteOffset > entry.headOffset && pending.byteOffset < nearest
            ? pending.byteOffset
            : nearest
        ),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(nextCallbackOffset)) {
        sliceEnd = Math.min(sliceEnd, nextCallbackOffset);
      }
      const nextSequenceBoundaryOffset = entry.sequenceBoundaries.reduce(
        (nearest, boundary) => (
          boundary.byteOffset > entry.headOffset && boundary.byteOffset < nearest
            ? boundary.byteOffset
            : nearest
        ),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(nextSequenceBoundaryOffset)) {
        sliceEnd = Math.min(sliceEnd, nextSequenceBoundaryOffset);
      }
      if (sliceEnd <= entry.headOffset) {
        return;
      }

      const slice = entry.bytes.subarray(entry.headOffset, sliceEnd);
      const completedSegment = sliceEnd === entry.bytes.byteLength;
      entry.headOffset = sliceEnd;
      queuedBytes -= slice.byteLength;
      if (fallbackGrandfatheredPendingBytes !== null) {
        fallbackGrandfatheredPendingBytes = Math.max(
          0,
          fallbackGrandfatheredPendingBytes - slice.byteLength,
        );
      }
      if (completedSegment) {
        queueHead += 1;
      }

      inFlight = true;
      activeEntry = entry;
      const writeToken = ++nextWriteToken;
      activeWriteToken = writeToken;
      let continuedInCallback = false;
      const rejectActiveWrite = (): void => {
        if (writeToken !== activeWriteToken) {
          return;
        }
        activeWriteToken = 0;
        inFlight = false;
        activeEntry = null;
        stale = true;
        scheduleToken += 1;
        scheduled = false;
        const rejectedCallbacks = queue.flatMap(segment => segment.callbacks);
        queue = [];
        queueHead = 0;
        queuedBytes = 0;
        pendingBarrierCount = 0;
        reliableBarrierPending = false;
        for (const pending of rejectedCallbacks) {
          pending.onRejected?.();
        }
      };
      options.write(slice, () => {
        if (writeToken !== activeWriteToken) {
          return;
        }
        activeWriteToken = 0;
        inFlight = false;
        activeEntry = null;
        settleSequenceBoundaries(entry);

        if (currentGeneration !== generation) {
          requestFlush();
          return;
        }
        const completedCallbacks = entry.callbacks.filter(
          pending => pending.byteOffset <= entry.headOffset,
        );
        if (completedCallbacks.length > 0) {
          entry.callbacks = entry.callbacks.filter(
            pending => pending.byteOffset > entry.headOffset,
          );
          for (const pending of completedCallbacks) {
            pending.callback();
          }
        }
        if (activeChunkCount() === 0) {
          compactConsumedHead();
          return;
        }
        continuedInCallback = true;
        if (now() >= frameDeadline) {
          requestFlush();
          return;
        }
        if (consecutiveInputYields === 0 && options.shouldYield?.()) {
          requestFlush();
          return;
        }
        drainFrame(frameDeadline);
      }, rejectActiveWrite);

      if (continuedInCallback) {
        return;
      }
      if (inFlight) {
        return;
      }
      if (now() >= frameDeadline) {
        requestFlush();
        return;
      }
    }
  };

  return {
    enqueue(data, onWritten, onRejected) {
      assertTextIngress(data, 'enqueue');
      if (data.length === 0) {
        return onWritten ? this.enqueueBarrier(onWritten) : { ok: true };
      }

      return this.enqueueBytes(textEncoder.encode(data), onWritten, onRejected);
    },
    enqueueBytes(bytes, onWritten, onRejected) {
      if (bytes.byteLength === 0) {
        return onWritten ? this.enqueueBarrier(onWritten) : { ok: true };
      }

      if (stale) {
        return {
          ok: false,
          reason: 'visible-output-overflow',
          droppedBytes: bytes.byteLength,
        };
      }

      const previousEffectiveDecision = currentCanaryEffectiveDecision();
      const admission = resolveAdmission(bytes.byteLength);

      if (
        !admission.accepted
        || bytes.byteLength > admission.queueMaxBytes
        || queuedBytes + bytes.byteLength > admission.queueMaxBytes
      ) {
        if (admission.canary) {
          const lease = activeCanaryLease;
          if (lease) {
            appendCanaryLedger({
              event: 'admission-rejected',
              policyId: lease.policyId,
              profileVersion: lease.profileVersion,
              previousEffectiveDecision,
              nextEffectiveDecision: admission.effectiveDecision,
              policyGeneration: latestCanaryPolicyGeneration,
              accepted: false,
              reason: admission.reason,
              rollbackResult: canaryTransitionSnapshot.reason === 'rollback-draining' ? 'draining' : null,
            });
          }
          return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: bytes.byteLength };
        }
        return enterOverflow(queuedBytes + bytes.byteLength);
      }

      const queueBeforeAdmission = admission.canary ? [...queue] : null;
      const queueHeadBeforeAdmission = queueHead;
      const outputSequence = nextOutputSequence + 1;
      queue.push({
        bytes,
        headOffset: 0,
        sequence: outputSequence,
        sequenceBoundaries: [{ byteOffset: bytes.byteLength, sequence: outputSequence }],
        callbacks: onWritten || onRejected
          ? [{ byteOffset: bytes.byteLength, callback: onWritten ?? (() => {}), onRejected }]
          : [],
      });
      queuedBytes += bytes.byteLength;
      if (!compactToChunkLimit()) {
        if (admission.canary && queueBeforeAdmission) {
          queue = queueBeforeAdmission;
          queueHead = queueHeadBeforeAdmission;
          queuedBytes -= bytes.byteLength;
          if (activeCanaryLease) {
            appendCanaryLedger({
              event: 'admission-rejected',
              policyId: activeCanaryLease.policyId,
              profileVersion: activeCanaryLease.profileVersion,
              previousEffectiveDecision,
              nextEffectiveDecision: admission.effectiveDecision,
              policyGeneration: latestCanaryPolicyGeneration,
              accepted: false,
              reason: 'candidate-chunk-limit-fenced',
              rollbackResult: canaryTransitionSnapshot.reason === 'rollback-draining' ? 'draining' : null,
            });
          }
          return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: bytes.byteLength };
        }
        return enterOverflow(queuedBytes);
      }
      nextOutputSequence = outputSequence;
      if (admission.canary && activeCanaryLease) {
        appendCanaryLedger({
          event: 'admission-accepted',
          policyId: activeCanaryLease.policyId,
          profileVersion: activeCanaryLease.profileVersion,
          previousEffectiveDecision,
          nextEffectiveDecision: admission.effectiveDecision,
          policyGeneration: latestCanaryPolicyGeneration,
          accepted: true,
          reason: admission.reason,
          rollbackResult: canaryTransitionSnapshot.reason === 'rollback-draining' ? 'draining' : null,
        });
      }
      requestFlush();
      return { ok: true };
    },
    enqueueLegacy(data, onWritten, onRejected) {
      assertTextIngress(data, 'enqueueLegacy');
      if (data.length === 0) {
        return onWritten ? this.enqueueReliableBarrier(onWritten) : { ok: true };
      }
      return this.enqueueBytesLegacy(textEncoder.encode(data), onWritten, onRejected);
    },
    enqueueBytesLegacy(bytes, onWritten, onRejected) {
      if (bytes.byteLength === 0) {
        return onWritten ? this.enqueueReliableBarrier(onWritten) : { ok: true };
      }
      if (stale) {
        return { ok: false, reason: 'visible-output-overflow', droppedBytes: bytes.byteLength };
      }

      const preserveRollbackBoundary = rollbackBoundarySequence !== null
        && canaryTransitionSnapshot.reason === 'rollback-draining';
      if (!preserveRollbackBoundary) {
        if (activeCanaryLease) {
          appendCanaryLedger({
            event: 'transition-aborted',
            policyId: activeCanaryLease.policyId,
            profileVersion: activeCanaryLease.profileVersion,
            previousEffectiveDecision: currentCanaryEffectiveDecision(),
            nextEffectiveDecision: activeCanaryLease.decision.legacyQueueMaxBytes,
            policyGeneration: latestCanaryPolicyGeneration,
            accepted: true,
            reason: 'target-local-legacy-fallback',
            rollbackResult: 'aborted',
          });
        }
        activeCanaryDecision = null;
        activeCanaryLease = null;
        rollbackBoundarySequence = null;
        rollbackLegacyQueueMaxBytes = null;
        rollbackPreviousEffectiveDecision = null;
        fallbackGrandfatheredPendingBytes = null;
        canaryTransitionSnapshot = Object.freeze({
          mode: 'legacy',
          reason: 'target-local-legacy-fallback',
          policyGeneration: latestCanaryPolicyGeneration,
        });
      }

      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;
      if (!allowSingleOversizedIdle && queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes) {
        return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: bytes.byteLength };
      }
      const queueBeforeAdmission = [...queue];
      const queueHeadBeforeAdmission = queueHead;
      const queuedBytesBeforeAdmission = queuedBytes;
      const outputSequence = nextOutputSequence + 1;
      queue.push({
        bytes,
        headOffset: 0,
        sequence: outputSequence,
        sequenceBoundaries: [{ byteOffset: bytes.byteLength, sequence: outputSequence }],
        callbacks: onWritten || onRejected
          ? [{ byteOffset: bytes.byteLength, callback: onWritten ?? (() => {}), onRejected }]
          : [],
      });
      queuedBytes += bytes.byteLength;
      if (!compactToChunkLimit()) {
        queue = queueBeforeAdmission;
        queueHead = queueHeadBeforeAdmission;
        queuedBytes = queuedBytesBeforeAdmission;
        return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: bytes.byteLength };
      }
      nextOutputSequence = outputSequence;
      requestFlush();
      return { ok: true };
    },
    enqueueBarrier(onIdle) {
      if (stale) {
        return {
          ok: false,
          reason: 'visible-output-overflow',
          droppedBytes: 0,
        };
      }
      if (!inFlight && activeChunkCount() === 0) {
        onIdle();
        return { ok: true };
      }
      if (pendingBarrierCount >= normalizeChunkLimit(config.visibleOutputMaxChunks)) {
        if (activeCanaryLease || rollbackLegacyQueueMaxBytes !== null) {
          return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: 0 };
        }
        return enterOverflow(queuedBytes);
      }
      const boundary = activeChunkCount() > 0
        ? queue[queue.length - 1]
        : activeEntry;
      if (!boundary) {
        if (activeCanaryLease || rollbackLegacyQueueMaxBytes !== null) {
          return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: 0 };
        }
        return enterOverflow(queuedBytes);
      }
      pendingBarrierCount += 1;
      boundary.callbacks.push({
        byteOffset: boundary.bytes.byteLength,
        callback: () => {
          pendingBarrierCount = Math.max(0, pendingBarrierCount - 1);
          onIdle();
        },
      });
      return { ok: true };
    },
    enqueueReliableBarrier(onIdle) {
      if (stale) {
        return { ok: false, reason: 'visible-output-overflow', droppedBytes: 0 };
      }
      if (!inFlight && activeChunkCount() === 0) {
        onIdle();
        return { ok: true };
      }
      if (reliableBarrierPending) {
        return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: 0 };
      }
      const boundary = activeChunkCount() > 0 ? queue[queue.length - 1] : activeEntry;
      if (!boundary) {
        return { ok: false, reason: 'canary-admission-rejected', rejectedBytes: 0 };
      }
      reliableBarrierPending = true;
      boundary.callbacks.push({
        byteOffset: boundary.bytes.byteLength,
        callback: () => {
          reliableBarrierPending = false;
          onIdle();
        },
      });
      return { ok: true };
    },
    configure(nextOptions) {
      config = {
        ...config,
        ...nextOptions,
      };
      config.visibleFlushFrameBudgetMs = normalizeFrameBudgetMs(config.visibleFlushFrameBudgetMs);
      const canaryOwnsRetainedQueue = activeCanaryLease !== null || rollbackLegacyQueueMaxBytes !== null;
      if (!canaryOwnsRetainedQueue && (
        queuedBytes > config.visibleOutputQueueMaxBytes
        || !compactToChunkLimit()
      )) {
        enterOverflow(queuedBytes);
      }
    },
    flush,
    reset(reason = 'scheduler-reset') {
      const cleanupLease = activeCanaryLease;
      const cleanupPreviousEffectiveDecision = currentCanaryEffectiveDecision();
      if (cleanupLease) {
        appendCanaryLedger({
          event: 'transition-aborted',
          policyId: cleanupLease.policyId,
          profileVersion: cleanupLease.profileVersion,
          previousEffectiveDecision: cleanupPreviousEffectiveDecision,
          nextEffectiveDecision: cleanupLease.decision.legacyQueueMaxBytes,
          policyGeneration: cleanupLease.decision.policyGeneration,
          accepted: true,
          reason,
          rollbackResult: 'aborted',
        });
      }
      generation += 1;
      queue = [];
      queueHead = 0;
      queuedBytes = 0;
      scheduleToken += 1;
      scheduled = false;
      stale = false;
      consecutiveInputYields = 0;
      pendingBarrierCount = 0;
      reliableBarrierPending = false;
      completedOutputSequence = nextOutputSequence;
      activeCanaryDecision = null;
      activeCanaryLease = null;
      rollbackBoundarySequence = null;
      rollbackLegacyQueueMaxBytes = null;
      rollbackPreviousEffectiveDecision = null;
      fallbackGrandfatheredPendingBytes = null;
      canaryTransitionSnapshot = Object.freeze({
        mode: 'legacy',
        reason: cleanupLease ? 'recovery-aborted' : 'legacy-default',
        policyGeneration: latestCanaryPolicyGeneration,
      });
      if (!inFlight) {
        activeWriteToken = 0;
      }
    },
    captureFifoProbeIdentity() {
      if (!inFlight || activeWriteToken === 0 || !activeEntry) {
        return null;
      }
      return {
        owner: fifoProbeOwner,
        generation,
        writeToken: activeWriteToken,
      };
    },
    settleFifoProbe(identity) {
      if (identity.owner !== fifoProbeOwner || identity.generation !== generation) {
        return 'stale';
      }
      if (!inFlight || identity.writeToken !== activeWriteToken || !activeEntry) {
        return 'advanced';
      }
      const provenEntry = activeEntry;
      const completedCallbacks = provenEntry
        ? provenEntry.callbacks.filter(pending => pending.byteOffset <= provenEntry.headOffset)
        : [];
      if (provenEntry && completedCallbacks.length > 0) {
        provenEntry.callbacks = provenEntry.callbacks.filter(
          pending => pending.byteOffset > provenEntry.headOffset,
        );
      }
      generation += 1;
      scheduleToken += 1;
      scheduled = false;
      consecutiveInputYields = 0;
      activeWriteToken = 0;
      inFlight = false;
      activeEntry = null;
      settleSequenceBoundaries(provenEntry);
      compactConsumedHead();
      for (const pending of completedCallbacks) {
        pending.callback();
      }
      if (activeChunkCount() > 0) {
        requestFlush();
      }
      return 'retired';
    },
    // @req REL-BGSTAB-010
    configureCanaryTransition(lease) {
      let isValidLease = false;
      try {
        isValidLease = options.validateCanaryPolicyLease?.(lease) === true;
      } catch {
        isValidLease = false;
      }
      if (!isValidLease || !isTerminalOutputPolicyLease(lease)) {
        return Object.freeze({
          mode: 'legacy',
          reason: 'invalid-policy-lease',
          policyGeneration: 0,
        });
      }
      if (!canaryTarget || !sameTerminalOutputPolicyTarget(canaryTarget, lease.target)) {
        appendCanaryLedger({
          event: 'transition-rejected',
          policyId: lease.policyId,
          profileVersion: lease.profileVersion,
          target: lease.target,
          previousEffectiveDecision: currentCanaryEffectiveDecision(),
          nextEffectiveDecision: lease.decision.candidateQueueMaxBytes,
          policyGeneration: lease.decision.policyGeneration,
          accepted: false,
          reason: 'stale-target-lease',
          rollbackResult: null,
        });
        return Object.freeze({
          mode: 'legacy',
          reason: 'stale-target-lease',
          policyGeneration: lease.decision.policyGeneration,
        });
      }

      if (lease.decision.policyGeneration <= latestCanaryPolicyGeneration) {
        appendCanaryLedger({
          event: 'transition-rejected',
          policyId: lease.policyId,
          profileVersion: lease.profileVersion,
          previousEffectiveDecision: currentCanaryEffectiveDecision(),
          nextEffectiveDecision: lease.decision.candidateQueueMaxBytes,
          policyGeneration: lease.decision.policyGeneration,
          accepted: false,
          reason: 'stale-policy-generation',
          rollbackResult: rollbackBoundarySequence === null ? null : 'draining',
        });
        return Object.freeze({
          mode: 'legacy',
          reason: 'stale-policy-generation',
          policyGeneration: lease.decision.policyGeneration,
        });
      }
      if (rollbackBoundarySequence !== null) {
        appendCanaryLedger({
          event: 'transition-rejected',
          policyId: lease.policyId,
          profileVersion: lease.profileVersion,
          previousEffectiveDecision: currentCanaryEffectiveDecision(),
          nextEffectiveDecision: lease.decision.candidateQueueMaxBytes,
          policyGeneration: lease.decision.policyGeneration,
          accepted: false,
          reason: 'rollback-draining',
          rollbackResult: 'draining',
        });
        return Object.freeze({
          mode: 'legacy',
          reason: 'rollback-draining',
          policyGeneration: lease.decision.policyGeneration,
        });
      }

      const previousEffectiveDecision = currentCanaryEffectiveDecision();
      activeCanaryDecision = Object.freeze({ ...lease.decision });
      activeCanaryLease = lease;
      latestCanaryPolicyGeneration = lease.decision.policyGeneration;
      rollbackLegacyQueueMaxBytes = null;
      rollbackPreviousEffectiveDecision = null;
      fallbackGrandfatheredPendingBytes = null;
      canaryTransitionSnapshot = Object.freeze(queuedBytes <= activeCanaryDecision.candidateQueueMaxBytes
        ? {
            mode: 'candidate' as const,
            reason: 'candidate-selected',
            policyGeneration: activeCanaryDecision.policyGeneration,
          }
        : {
            mode: 'legacy' as const,
            reason: 'retained-entry-exceeds-candidate',
            policyGeneration: activeCanaryDecision.policyGeneration,
          });
      appendCanaryLedger({
        event: 'candidate-selected',
        policyId: lease.policyId,
        profileVersion: lease.profileVersion,
        previousEffectiveDecision,
        nextEffectiveDecision: canaryTransitionSnapshot.mode === 'candidate'
          ? lease.decision.candidateQueueMaxBytes
          : lease.decision.legacyQueueMaxBytes,
        policyGeneration: lease.decision.policyGeneration,
        accepted: true,
        reason: canaryTransitionSnapshot.reason,
        rollbackResult: null,
      });
      return canaryTransitionSnapshot;
    },
    // @req REL-BGSTAB-010
    rollbackCanaryTransition(lease) {
      let isValidLease = false;
      try {
        isValidLease = options.validateCanaryPolicyLease?.(lease) === true;
      } catch {
        isValidLease = false;
      }
      const currentState = rollbackBoundarySequence === null ? 'closed' : 'draining';
      if (!isValidLease || !isTerminalOutputPolicyLease(lease)) {
        return Object.freeze({ state: currentState, reason: 'invalid-policy-lease' });
      }
      if (
        !canaryTarget
        || !sameTerminalOutputPolicyTarget(canaryTarget, lease.target)
        || activeCanaryLease !== lease
        || lease.decision.policyGeneration !== latestCanaryPolicyGeneration
      ) {
        return Object.freeze({ state: currentState, reason: 'stale-policy-generation' });
      }
      if (rollbackBoundarySequence !== null) {
        return Object.freeze({ state: 'draining' as const, reason: 'rollback-draining' as const });
      }

      const previousEffectiveDecision = currentCanaryEffectiveDecision();
      rollbackLegacyQueueMaxBytes = lease.decision.legacyQueueMaxBytes;
      rollbackPreviousEffectiveDecision = previousEffectiveDecision;
      if (fallbackGrandfatheredPendingBytes === null) {
        fallbackGrandfatheredPendingBytes = queuedBytes;
      }
      rollbackBoundarySequence = nextOutputSequence;
      canaryTransitionSnapshot = Object.freeze({
        mode: 'legacy',
        reason: 'rollback-draining',
        policyGeneration: lease.decision.policyGeneration,
      });
      appendCanaryLedger({
        event: 'rollback-requested',
        policyId: lease.policyId,
        profileVersion: lease.profileVersion,
        previousEffectiveDecision,
        nextEffectiveDecision: lease.decision.legacyQueueMaxBytes,
        policyGeneration: lease.decision.policyGeneration,
        accepted: true,
        reason: 'rollback-requested',
        rollbackResult: 'requested',
      });
      appendCanaryLedger({
        event: 'rollback-draining',
        policyId: lease.policyId,
        profileVersion: lease.profileVersion,
        previousEffectiveDecision,
        nextEffectiveDecision: lease.decision.legacyQueueMaxBytes,
        policyGeneration: lease.decision.policyGeneration,
        accepted: true,
        reason: 'rollback-draining',
        rollbackResult: 'draining',
      });
      closeCanaryRollbackIfBoundaryDrained();
      return Object.freeze(rollbackBoundarySequence === null
        ? { state: 'closed' as const, reason: 'rollback-closed' as const }
        : { state: 'draining' as const, reason: 'rollback-draining' as const });
    },
    // @req REL-BGSTAB-010
    getCanaryTransitionSnapshot() {
      return canaryTransitionSnapshot;
    },
    // @req REL-BGSTAB-010
    getCanaryLedgerSnapshot() {
      const entries = Object.freeze([...canaryLedgerEntries]);
      return Object.freeze({
        capacity: canaryLedgerCapacity,
        totalEvents: canaryLedgerTotalEvents,
        droppedEntries: Math.max(0, canaryLedgerTotalEvents - entries.length),
        entries,
      });
    },
    // @req REL-BGSTAB-010
    getCanaryCleanupSnapshot() {
      return Object.freeze({
        targetHandles: activeCanaryLease ? 1 : 0,
        listeners: rollbackBoundarySequence === null ? 0 : 1,
        timers: 0,
        retainedEntries: canaryLedgerTotalEvents > 0 ? 1 : 0,
      });
    },
    isIdle() {
      return !stale && !inFlight && !scheduled && activeChunkCount() === 0;
    },
    isStale() {
      return stale;
    },
    pendingBytes() {
      return queuedBytes;
    },
  };
}

// @req REL-BGSTAB-010
function isTrustedTerminalOutputPolicyIssuerOptions(
  options: TerminalOutputPolicyLeaseIssuerOptions,
): boolean {
  return options.trustedEvidence.requirementId === 'OBS-BGSTAB-005'
    && options.trustedEvidence.status === 'implemented'
    && options.trustedEvidence.manifestSha256 === TERMINAL_OUTPUT_POLICY_MANIFEST_SHA256
    && options.profile.policyId === 'test-only-wave3-reviewed'
    && options.profile.profileVersion === '1.0.0'
    && options.profile.schemaVersion === TERMINAL_OUTPUT_POLICY_SCHEMA_VERSION
    && options.profile.stability === 'stable'
    && options.profile.requiredCapabilityVersion === TERMINAL_OUTPUT_POLICY_CAPABILITY_VERSION
    && options.profile.selectionId === TERMINAL_OUTPUT_POLICY_SELECTION_ID
    && typeof options.profile.approvedResourceDecision === 'object'
    && options.profile.approvedResourceDecision !== null
    && isNonNegativeSafeInteger(options.profile.approvedResourceDecision.candidateQueueMaxBytes)
    && isNonNegativeSafeInteger(options.profile.approvedResourceDecision.legacyQueueMaxBytes)
    && options.capability?.consumer === 'frontend.output-scheduler'
    && options.capability.version === TERMINAL_OUTPUT_POLICY_CAPABILITY_VERSION
    && options.capability.compilerSchemaVersion === TERMINAL_OUTPUT_POLICY_SCHEMA_VERSION;
}

// @req REL-BGSTAB-010
function isTerminalOutputPolicyLeaseInput(input: unknown): input is {
  target: TerminalOutputPolicyLeaseTarget;
  decision: TerminalOutputPolicyLeaseDecision;
} {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const candidate = input as {
    target?: Partial<TerminalOutputPolicyLeaseTarget> | null;
    decision?: Partial<TerminalOutputPolicyLeaseDecision> | null;
  };
  return typeof candidate.target === 'object'
    && candidate.target !== null
    && typeof candidate.decision === 'object'
    && candidate.decision !== null
    && typeof candidate.target.viewId === 'string'
    && candidate.target.viewId.length > 0
    && typeof candidate.target.connectionId === 'string'
    && candidate.target.connectionId.length > 0
    && isNonNegativeSafeInteger(candidate.target.reconnectGeneration as number)
    && isNonNegativeSafeInteger(candidate.decision.candidateQueueMaxBytes as number)
    && isNonNegativeSafeInteger(candidate.decision.legacyQueueMaxBytes as number)
    && isNonNegativeSafeInteger(candidate.decision.policyGeneration as number);
}

// @req REL-BGSTAB-010
function isTerminalOutputPolicyLease(value: unknown): value is TerminalOutputPolicyLease {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<TerminalOutputPolicyLease>;
  return typeof candidate.leaseId === 'string'
    && isTerminalOutputPolicyLeaseInput({
      target: candidate.target,
      decision: candidate.decision,
    });
}

// @req REL-BGSTAB-010
function sameTerminalOutputPolicyTarget(
  left: TerminalOutputPolicyLeaseTarget,
  right: TerminalOutputPolicyLeaseTarget,
): boolean {
  return left.viewId === right.viewId
    && left.connectionId === right.connectionId
    && left.reconnectGeneration === right.reconnectGeneration;
}

// @req REL-BGSTAB-010
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// @req PERF-BGSTAB-009
function mergeOutputSegments(
  left: PendingOutputSegment,
  right: PendingOutputSegment,
  rollbackBoundarySequence: number | null,
): PendingOutputSegment {
  const leftBytes = left.bytes.subarray(left.headOffset);
  const rightBytes = right.bytes.subarray(right.headOffset);
  const bytes = new Uint8Array(leftBytes.byteLength + rightBytes.byteLength);
  bytes.set(leftBytes, 0);
  bytes.set(rightBytes, leftBytes.byteLength);
  const sequenceBoundaries = [
    ...left.sequenceBoundaries
      .filter(boundary => boundary.byteOffset > left.headOffset)
      .map(boundary => ({
        ...boundary,
        byteOffset: boundary.byteOffset - left.headOffset,
      })),
    ...right.sequenceBoundaries
      .filter(boundary => boundary.byteOffset > right.headOffset)
      .map(boundary => ({
        ...boundary,
        byteOffset: leftBytes.byteLength + boundary.byteOffset - right.headOffset,
      })),
  ];
  const finalBoundary = sequenceBoundaries.at(-1);
  const retainedSequenceBoundaries = sequenceBoundaries.filter(boundary => (
    boundary === finalBoundary
    || (rollbackBoundarySequence !== null && boundary.sequence === rollbackBoundarySequence)
  ));
  return {
    bytes,
    headOffset: 0,
    sequence: Math.max(left.sequence, right.sequence),
    sequenceBoundaries: retainedSequenceBoundaries,
    callbacks: [
      ...left.callbacks
        .filter(pending => pending.byteOffset > left.headOffset)
        .map(pending => ({
          ...pending,
          byteOffset: pending.byteOffset - left.headOffset,
        })),
      ...right.callbacks
        .filter(pending => pending.byteOffset > right.headOffset)
        .map(pending => ({
          ...pending,
          byteOffset: leftBytes.byteLength + pending.byteOffset - right.headOffset,
        })),
    ],
  };
}

// @req PERF-BGSTAB-009
function findUtf8SliceEnd(bytes: Uint8Array, start: number, maxBytes: number): number {
  if (start >= bytes.byteLength) {
    return start;
  }

  const target = Math.min(
    start + normalizeFlushBudgetBytes(maxBytes),
    bytes.byteLength,
  );
  if (target === bytes.byteLength || !isUtf8ContinuationByte(bytes[target])) {
    return target;
  }

  let boundary = target;
  let backtracked = 0;
  while (
    boundary > start
    && backtracked < 3
    && isUtf8ContinuationByte(bytes[boundary])
  ) {
    boundary -= 1;
    backtracked += 1;
  }
  if (boundary > start) {
    return boundary;
  }

  return Math.min(
    start + getUtf8SequenceWidth(bytes[start]),
    bytes.byteLength,
  );
}

/**
 * The parameter is `unknown` on purpose. Typing it `string` would make the
 * `instanceof` a compile error and typing it `string | Uint8Array` would let the
 * check narrow away statically — either way the guard would stop running for the
 * callers it exists to catch, which are the ones that reached here through `any`.
 */
// @req PERF-BGSTAB-009
function assertTextIngress(data: unknown, entryPoint: string): void {
  if (data instanceof Uint8Array) {
    throw new TypeError(
      `terminal output scheduler: ${entryPoint} accepts text; use enqueueBytes for byte input`,
    );
  }
}

// @req PERF-BGSTAB-009
function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

// @req PERF-BGSTAB-009
function getUtf8SequenceWidth(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1;
  if ((leadByte & 0xe0) === 0xc0) return 2;
  if ((leadByte & 0xf0) === 0xe0) return 3;
  if ((leadByte & 0xf8) === 0xf0) return 4;
  return 1;
}

// @req PERF-BGSTAB-009
function normalizeFlushBudgetBytes(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 1;
}

// @req PERF-BGSTAB-009
function normalizeChunkLimit(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeCanaryLedgerCapacity(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 64;
}

function freezeTerminalOutputPolicyProfiles(
  profiles: readonly TerminalOutputPolicyProfile[],
): readonly TerminalOutputPolicyProfile[] {
  return Object.freeze(profiles.map(profile => Object.freeze({
    ...profile,
    approvedResourceDecision: Object.freeze({ ...profile.approvedResourceDecision }),
  })));
}

function defaultSchedule(drain: () => void): void {
  requestAnimationFrame(drain);
}

function defaultNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function normalizeFrameBudgetMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS;
}
