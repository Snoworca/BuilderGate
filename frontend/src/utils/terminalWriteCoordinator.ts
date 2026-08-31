import { TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS } from './terminalReplayGuard.ts';
import { isTerminalCheckpointModes } from '../types/ws-protocol.ts';

export type TerminalWriteKind = 'live' | 'checkpoint' | 'repair' | 'parser-tail';
export type TerminalInputSettlementOutcome =
  | 'released'
  | 'rejected'
  | 'superseded'
  | 'disposed'
  | 'expired';

export interface TerminalCheckpointLifecycleMetadata {
  readonly viewGeneration: number;
  readonly streamEpoch: string;
  readonly checkpointEpoch: string;
  readonly sourceSeq: string;
  readonly snapshotSeq: string;
  readonly oldestRetainedSeq: string;
  readonly retentionPolicyId: string;
  readonly chunkCount: number;
  readonly encodedByteTotal: number;
  readonly digest: string;
}

export interface TerminalWriteCoordinatorAdapter {
  write: (
    command: Readonly<{ kind: TerminalWriteKind; data: string | Uint8Array }>,
    onWritten: () => void,
  ) => void;
  probeWritePipeline?: (onWritten: () => void) => void;
  resetParser: () => void;
  resize: (cols: number, rows: number) => void;
  applyModes: (modes: Readonly<Record<string, boolean>>) => void;
  clearScreen: () => void;
  fit: () => Readonly<{ cols: number; rows: number }>;
  setWindowsPty: (value: unknown) => void;
  markReady: (viewGeneration: number) => void;
  releaseInput: (data: string) => void;
  settleInput: (token: string, outcome: TerminalInputSettlementOutcome) => void;
  requestFreshRecovery: (reason: string) => void;
  requestRuntimeRecreation: (reason: string) => void;
  compatibilityRecoveryDrained: (viewGeneration: number) => void;
  checkpointApplied: (metadata: Readonly<TerminalCheckpointLifecycleMetadata>) => void;
  checkpointDrained: (metadata: Readonly<TerminalCheckpointLifecycleMetadata>) => void;
  settle: (
    token: string,
    outcome: 'written' | 'superseded' | 'disposed' | 'failed',
  ) => void;
}

export interface TerminalWriteCoordinatorOptions {
  viewGeneration: number;
  adapter: TerminalWriteCoordinatorAdapter;
  digestBytes: (bytes: Uint8Array) => string;
  timeoutMs?: number;
  writeStallCheckMs?: number;
  checkpointWriteSliceBytes?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  postCheckpointMaxBytes?: number;
  postCheckpointMaxChunks?: number;
  checkpointMaxBytes?: number;
  checkpointMaxChunks?: number;
  pendingInputMaxBytes?: number;
  pendingInputMaxCount?: number;
  pendingInputTtlMs?: number;
  settlementLedgerMaxEntries?: number;
  inputSettlementLedgerMaxEntries?: number;
  settlementLedgerTtlMs?: number;
  now?: () => number;
}

export type TerminalWriteCoordinatorCommand =
  | {
      type: 'live';
      streamEpoch: unknown;
      sourceSeq: unknown;
      viewGeneration: number;
      data: Uint8Array;
      settlementToken: string;
    }
  | {
      type: 'checkpoint-begin';
      streamEpoch: unknown;
      checkpointEpoch: unknown;
      sourceSeq: unknown;
      snapshotSeq: unknown;
      oldestRetainedSeq: unknown;
      retentionPolicyId: unknown;
      viewGeneration: number;
      chunkCount: number;
      encodedByteTotal: number;
      digest: string;
      cols: number;
      rows: number;
      modes: Readonly<Record<string, boolean>>;
      parserTail: Uint8Array;
    }
  | {
      type: 'checkpoint-chunk';
      streamEpoch: unknown;
      checkpointEpoch: unknown;
      sourceSeq: unknown;
      snapshotSeq: unknown;
      oldestRetainedSeq: unknown;
      retentionPolicyId: unknown;
      viewGeneration: number;
      chunkCount: number;
      encodedByteTotal: number;
      digest: string;
      index: number;
      count: number;
      data: Uint8Array;
    }
  | {
      type: 'checkpoint-commit';
      streamEpoch: unknown;
      checkpointEpoch: unknown;
      sourceSeq: unknown;
      snapshotSeq: unknown;
      oldestRetainedSeq: unknown;
      retentionPolicyId: unknown;
      viewGeneration: number;
      chunkCount: number;
      encodedByteTotal: number;
      digest: string;
    }
  | {
      type: 'repair';
      streamEpoch: unknown;
      sourceSeq: unknown;
      viewGeneration: number;
      data: Uint8Array;
      settlementToken: string;
    }
  | { type: 'queue-input'; viewGeneration: number; data: string; settlementToken: string }
  | {
      type: 'install-recovery-generation';
      viewGeneration: number;
      streamEpoch: unknown;
      checkpointEpoch: unknown;
    }
  | { type: 'recovery-failed'; viewGeneration: number; reason: string }
  | {
      type: 'install-rollback-checkpoint-boundary';
      viewGeneration: number;
      streamEpoch: unknown;
      checkpointEpoch: unknown;
      reason: string;
    }
  | { type: 'supersede'; viewGeneration: number }
  | { type: 'rollback-to-compatibility'; viewGeneration: number; reason: string }
  | { type: 'install-compatibility-recovery-generation'; viewGeneration: number; reason: string }
  | {
      type: 'complete-ordered-compatibility-recovery';
      viewGeneration: number;
      streamEpoch: unknown;
      checkpointEpoch: unknown;
    }
  | { type: 'complete-compatibility-recovery'; viewGeneration: number }
  | { type: 'dispose'; viewGeneration: number };

export type TerminalWriteCoordinatorCompatibilityCommand =
  | {
      type: 'write';
      viewGeneration: number;
      kind: TerminalWriteKind;
      data: string | Uint8Array;
      onWritten?: () => void;
      onRejected?: (reason: string) => void;
    }
  | {
      type: 'reset' | 'clear' | 'fit';
      viewGeneration: number;
      onApplied?: () => void;
      onRejected?: (reason: string) => void;
    }
  | {
      type: 'resize';
      viewGeneration: number;
      cols: number;
      rows: number;
      onApplied?: () => void;
      onRejected?: (reason: string) => void;
    }
  | {
      type: 'set-windows-pty';
      viewGeneration: number;
      value: unknown;
      onApplied?: () => void;
      onRejected?: (reason: string) => void;
    };

export interface TerminalWriteCoordinatorResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface TerminalWriteCoordinatorState {
  readonly viewGeneration: number;
  readonly ready: boolean;
  readonly disposed: boolean;
  readonly writeInFlight: boolean;
  readonly pendingCommands: number;
  readonly pendingInputs: number;
  readonly pendingInputBytes: number;
  readonly settlementLedgerEntries: number;
  readonly inputSettlementLedgerEntries: number;
  readonly recoveryRequired: boolean;
  readonly compatibilityRecoveryPending: boolean;
  readonly runtimeRecreationRequired: boolean;
}

export interface TerminalWriteCoordinator {
  dispatch: (command: TerminalWriteCoordinatorCommand) => TerminalWriteCoordinatorResult;
  submitCompatibility: (
    command: TerminalWriteCoordinatorCompatibilityCommand,
  ) => TerminalWriteCoordinatorResult;
  getState: () => Readonly<TerminalWriteCoordinatorState>;
}

interface ParsedOrdinal64 {
  readonly wire: string;
  readonly value: bigint;
}

interface PendingWrite {
  readonly type: 'write';
  readonly generation: number;
  readonly kind: 'live' | 'repair';
  readonly data: Uint8Array;
  readonly settlementToken: string;
  readonly sourceSeq: ParsedOrdinal64;
}

interface PendingCheckpoint {
  readonly type: 'checkpoint';
  readonly generation: number;
  readonly body: Uint8Array;
  readonly parserTail: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly modes: Readonly<Record<string, boolean>>;
  readonly metadata: Readonly<TerminalCheckpointLifecycleMetadata>;
  phase: 'body' | 'parser-tail';
  bodyPrepared: boolean;
  bodyOffset: number;
}

interface PendingCompatibilityWrite {
  readonly type: 'compatibility-write';
  readonly generation: number;
  readonly kind: TerminalWriteKind;
  readonly data: string | Uint8Array;
  readonly onWritten?: () => void;
  readonly onRejected?: (reason: string) => void;
}

interface PendingCompatibilitySync {
  readonly type: 'compatibility-reset' | 'compatibility-clear' | 'compatibility-resize' | 'compatibility-fit' | 'compatibility-set-windows-pty';
  readonly generation: number;
  readonly cols?: number;
  readonly rows?: number;
  readonly value?: unknown;
  readonly onApplied?: () => void;
  readonly onRejected?: (reason: string) => void;
}

type PendingCompatibilityMutation = PendingCompatibilityWrite | PendingCompatibilitySync;
type PendingMutation = PendingWrite | PendingCheckpoint | PendingCompatibilityMutation;

interface CheckpointTransaction {
  readonly generation: number;
  readonly streamEpoch: ParsedOrdinal64;
  readonly checkpointEpoch: ParsedOrdinal64;
  readonly sourceSeq: ParsedOrdinal64;
  readonly snapshotSeq: ParsedOrdinal64;
  readonly oldestRetainedSeq: ParsedOrdinal64;
  readonly retentionPolicyId: string;
  readonly chunkCount: number;
  readonly encodedByteTotal: number;
  readonly digest: string;
  readonly cols: number;
  readonly rows: number;
  readonly modes: Readonly<Record<string, boolean>>;
  readonly parserTail: Uint8Array;
  readonly chunks: Uint8Array[];
  receivedByteTotal: number;
  commitReceived: boolean;
  validatedBody: Uint8Array | null;
  readonly postCheckpointMutations: Array<PendingWrite | PendingCompatibilityMutation>;
  postCheckpointBytes: number;
  latestPostCheckpointSeq: ParsedOrdinal64 | null;
  failed: boolean;
  failureReason: string | null;
  recoveryRequested: boolean;
}

interface PendingInput {
  readonly generation: number;
  readonly data: string;
  readonly settlementToken: string;
  readonly byteLength: number;
  readonly expiresAt: number;
}

interface SettlementLedgerEntry {
  readonly generation: number;
  readonly claimedAt: number;
  settledAt: number | null;
}

interface InputSettlementLedgerEntry {
  readonly generation: number;
  readonly claimedAt: number;
  settledAt: number | null;
}

interface RecoveryInstallation {
  readonly streamEpoch: ParsedOrdinal64;
  readonly checkpointEpoch: ParsedOrdinal64;
}

interface CheckpointLifecycle {
  readonly generation: number;
  readonly metadata: Readonly<TerminalCheckpointLifecycleMetadata>;
  readonly watermark: ParsedOrdinal64;
  applied: boolean;
  drained: boolean;
  lastDrainedSourceSeq: ParsedOrdinal64 | null;
}

const ORDINAL64_MAX = (1n << 64n) - 1n;
const ORDINAL64_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const ACCEPTED: TerminalWriteCoordinatorResult = Object.freeze({ accepted: true });

function rejected(reason: string): TerminalWriteCoordinatorResult {
  return Object.freeze({ accepted: false, reason });
}

// @req REL-BGSTAB-007 AC-4
export function parseCanonicalOrdinal64(value: unknown): ParsedOrdinal64 | null {
  if (typeof value !== 'string' || !ORDINAL64_PATTERN.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed > ORDINAL64_MAX) {
    return null;
  }
  return Object.freeze({ wire: value, value: parsed });
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// @req FR-BGSTAB-022 AC-1 AC-2 AC-3 AC-4 AC-5 AC-6
// @req REL-BGSTAB-007 AC-4 AC-5 AC-8
export function createTerminalWriteCoordinator(
  options: TerminalWriteCoordinatorOptions,
): TerminalWriteCoordinator {
  if (!isNonNegativeSafeInteger(options.viewGeneration)) {
    throw new TypeError('viewGeneration must be a non-negative safe integer');
  }

  let viewGeneration = options.viewGeneration;
  let ready = false;
  let disposed = false;
  let writeInFlight = false;
  let activeMutation: PendingMutation | null = null;
  let activeMutationFenced = false;
  let checkpointTransaction: CheckpointTransaction | null = null;
  let recoveryRequired = false;
  let compatibilityRecoveryPending = false;
  let compatibilityRecoveryResetApplied = false;
  let compatibilityRecoveryCompletionInProgress = false;
  let runtimeRecreationRequired = false;
  let recoveryInstallation: RecoveryInstallation | null = null;
  let checkpointLifecycle: CheckpointLifecycle | null = null;
  let currentStreamEpoch: ParsedOrdinal64 | null = null;
  let latestSourceSeq: ParsedOrdinal64 | null = null;
  let latestCheckpointEpoch: ParsedOrdinal64 | null = null;
  const queue: PendingMutation[] = [];
  const pendingInputs: PendingInput[] = [];
  let pendingInputBytes = 0;
  const settlementLedger = new Map<string, SettlementLedgerEntry>();
  const inputSettlementLedger = new Map<string, InputSettlementLedgerEntry>();
  const timeoutMs = typeof options.timeoutMs === 'number'
    && Number.isFinite(options.timeoutMs)
    && options.timeoutMs > 0
    ? options.timeoutMs
    : TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS;
  const writeStallCheckMs = typeof options.writeStallCheckMs === 'number'
    && Number.isFinite(options.writeStallCheckMs)
    && options.writeStallCheckMs > 0
    ? options.writeStallCheckMs
    : 10_000;
  const checkpointWriteSliceBytes = isPositiveSafeInteger(
    options.checkpointWriteSliceBytes ?? 32 * 1024,
  ) ? (options.checkpointWriteSliceBytes ?? 32 * 1024) : 32 * 1024;
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => {
    const handle = setTimeout(callback, delayMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  const postCheckpointMaxBytes = isNonNegativeSafeInteger(options.postCheckpointMaxBytes ?? -1)
    ? options.postCheckpointMaxBytes!
    : 0;
  const postCheckpointMaxChunks = isNonNegativeSafeInteger(options.postCheckpointMaxChunks ?? -1)
    ? options.postCheckpointMaxChunks!
    : 0;
  const checkpointMaxBytes = isNonNegativeSafeInteger(
    options.checkpointMaxBytes ?? postCheckpointMaxBytes,
  ) ? (options.checkpointMaxBytes ?? postCheckpointMaxBytes) : 0;
  const checkpointMaxChunks = isNonNegativeSafeInteger(
    options.checkpointMaxChunks ?? postCheckpointMaxChunks,
  ) ? (options.checkpointMaxChunks ?? postCheckpointMaxChunks) : 0;
  const pendingInputMaxBytes = isNonNegativeSafeInteger(options.pendingInputMaxBytes ?? -1)
    ? options.pendingInputMaxBytes!
    : 0;
  const pendingInputMaxCount = isNonNegativeSafeInteger(options.pendingInputMaxCount ?? -1)
    ? options.pendingInputMaxCount!
    : 0;
  const pendingInputTtlMs = typeof options.pendingInputTtlMs === 'number'
    && Number.isFinite(options.pendingInputTtlMs)
    && options.pendingInputTtlMs > 0
    ? options.pendingInputTtlMs
    : 0;
  const settlementLedgerMaxEntries = isNonNegativeSafeInteger(options.settlementLedgerMaxEntries ?? -1)
    ? options.settlementLedgerMaxEntries!
    : 0;
  const settlementLedgerTtlMs = typeof options.settlementLedgerTtlMs === 'number'
    && Number.isFinite(options.settlementLedgerTtlMs)
    && options.settlementLedgerTtlMs > 0
    ? options.settlementLedgerTtlMs
    : 0;
  const inputSettlementLedgerMaxEntries = isNonNegativeSafeInteger(
    options.inputSettlementLedgerMaxEntries ?? settlementLedgerMaxEntries,
  ) ? (options.inputSettlementLedgerMaxEntries ?? settlementLedgerMaxEntries) : 0;
  const now = options.now ?? (() => Date.now());
  const inputEncoder = new TextEncoder();
  let checkpointTimeoutHandle: unknown | null = null;
  let writeTimeoutHandle: unknown | null = null;
  let inputExpiryTimeoutHandle: unknown | null = null;

  const clearCheckpointTimeout = (): void => {
    if (checkpointTimeoutHandle === null) return;
    const handle = checkpointTimeoutHandle;
    checkpointTimeoutHandle = null;
    try {
      clearTimer(handle);
    } catch {
      // A timer adapter is observational. The generation/recovery fence is authoritative.
    }
  };

  const clearWriteTimeout = (): void => {
    if (writeTimeoutHandle === null) return;
    const handle = writeTimeoutHandle;
    writeTimeoutHandle = null;
    try {
      clearTimer(handle);
    } catch {
      // A timer adapter is observational. The generation/recovery fence is authoritative.
    }
  };

  const clearInputExpiryTimeout = (): void => {
    if (inputExpiryTimeoutHandle === null) return;
    const handle = inputExpiryTimeoutHandle;
    inputExpiryTimeoutHandle = null;
    try {
      clearTimer(handle);
    } catch {
      // Queue ownership remains bounded by count/bytes even if timer cleanup fails.
    }
  };

  const pruneSettlementLedger = (): void => {
    if (settlementLedgerTtlMs <= 0) return;
    const cutoff = now() - settlementLedgerTtlMs;
    for (const [token, entry] of settlementLedger) {
      if (entry.settledAt !== null && entry.settledAt <= cutoff) {
        settlementLedger.delete(token);
      }
    }
    for (const [token, entry] of inputSettlementLedger) {
      if (entry.settledAt !== null && entry.settledAt <= cutoff) {
        inputSettlementLedger.delete(token);
      }
    }
  };

  const requestRecovery = (reason: string): void => {
    const shouldNotify = !recoveryRequired;
    recoveryRequired = true;
    compatibilityRecoveryPending = false;
    compatibilityRecoveryResetApplied = false;
    ready = false;
    if (!shouldNotify) return;
    try {
      options.adapter.requestFreshRecovery(reason);
    } catch {
      // Recovery remains latched even when its observer fails.
    }
  };

  const requestRecoveryForGeneration = (originGeneration: number, reason: string): void => {
    if (originGeneration === viewGeneration && !disposed) {
      requestRecovery(reason);
    }
  };

  const armInputExpiryTimeout = (): boolean => {
    clearInputExpiryTimeout();
    if (pendingInputs.length === 0) return true;
    const timerGeneration = viewGeneration;
    const delayMs = Math.max(0, pendingInputs[0]!.expiresAt - now());
    try {
      inputExpiryTimeoutHandle = setTimer(() => {
        inputExpiryTimeoutHandle = null;
        if (disposed || timerGeneration !== viewGeneration) return;
        const currentTime = now();
        let expired = false;
        while (pendingInputs.length > 0 && pendingInputs[0]!.expiresAt <= currentTime) {
          const input = pendingInputs.shift()!;
          pendingInputBytes -= input.byteLength;
          settleInputOnce(input.settlementToken, 'expired');
          expired = true;
        }
        if (expired) {
          clearPendingInputs('rejected');
          requestRecovery('pending-input-expired');
          return;
        }
        armInputExpiryTimeout();
      }, delayMs);
      return true;
    } catch {
      requestRecovery('pending-input-timeout-arm-failed');
      return false;
    }
  };

  const settleOnce = (
    token: string,
    outcome: 'written' | 'superseded' | 'disposed' | 'failed',
  ): void => {
    const entry = settlementLedger.get(token);
    if (!entry || entry.settledAt !== null) return;
    entry.settledAt = now();
    const ownerGeneration = entry.generation;
    try {
      options.adapter.settle(token, outcome);
    } catch {
      requestRecoveryForGeneration(ownerGeneration, 'adapter-settle-failed');
    }
  };

  const claimSettlementToken = (
    token: string,
    generation: number,
  ): 'accepted' | 'invalid' | 'duplicate' | 'overflow' => {
    if (token.trim().length === 0) return 'invalid';
    pruneSettlementLedger();
    if (settlementLedger.has(token)) return 'duplicate';
    if (settlementLedgerMaxEntries <= 0 || settlementLedgerTtlMs <= 0) return 'overflow';
    if (settlementLedger.size >= settlementLedgerMaxEntries) return 'overflow';
    settlementLedger.set(token, { generation, claimedAt: now(), settledAt: null });
    return 'accepted';
  };

  const settleInputOnce = (
    token: string,
    outcome: TerminalInputSettlementOutcome,
  ): void => {
    const entry = inputSettlementLedger.get(token);
    if (!entry || entry.settledAt !== null) return;
    entry.settledAt = now();
    const ownerGeneration = entry.generation;
    try {
      options.adapter.settleInput(token, outcome);
    } catch {
      requestRecoveryForGeneration(ownerGeneration, 'adapter-input-settlement-failed');
    }
  };

  const claimInputSettlementToken = (
    token: string,
    generation: number,
  ): 'accepted' | 'invalid' | 'duplicate' | 'overflow' => {
    if (token.trim().length === 0) return 'invalid';
    pruneSettlementLedger();
    if (inputSettlementLedger.has(token)) return 'duplicate';
    if (inputSettlementLedgerMaxEntries <= 0 || settlementLedgerTtlMs <= 0) return 'overflow';
    if (inputSettlementLedger.size >= inputSettlementLedgerMaxEntries) return 'overflow';
    inputSettlementLedger.set(token, { generation, claimedAt: now(), settledAt: null });
    return 'accepted';
  };

  const clearPendingInputs = (outcome: TerminalInputSettlementOutcome): void => {
    clearInputExpiryTimeout();
    const abandoned = pendingInputs.splice(0);
    pendingInputBytes = 0;
    for (const input of abandoned) {
      settleInputOnce(input.settlementToken, outcome);
    }
  };

  const checkpointMetadata = (
    transaction: CheckpointTransaction,
  ): Readonly<TerminalCheckpointLifecycleMetadata> => Object.freeze({
    viewGeneration: transaction.generation,
    streamEpoch: transaction.streamEpoch.wire,
    checkpointEpoch: transaction.checkpointEpoch.wire,
    sourceSeq: transaction.sourceSeq.wire,
    snapshotSeq: transaction.snapshotSeq.wire,
    oldestRetainedSeq: transaction.oldestRetainedSeq.wire,
    retentionPolicyId: transaction.retentionPolicyId,
    chunkCount: transaction.chunkCount,
    encodedByteTotal: transaction.encodedByteTotal,
    digest: transaction.digest,
  });

  const frameMatchesCheckpoint = (
    transaction: CheckpointTransaction,
    frame: Readonly<{
      streamEpoch: unknown;
      checkpointEpoch: unknown;
      sourceSeq: unknown;
      snapshotSeq: unknown;
      oldestRetainedSeq: unknown;
      retentionPolicyId: unknown;
      chunkCount: number;
      encodedByteTotal: number;
      digest: string;
    }>,
  ): boolean => {
    const streamEpoch = parseCanonicalOrdinal64(frame.streamEpoch);
    const checkpointEpoch = parseCanonicalOrdinal64(frame.checkpointEpoch);
    const sourceSeq = parseCanonicalOrdinal64(frame.sourceSeq);
    const snapshotSeq = parseCanonicalOrdinal64(frame.snapshotSeq);
    const oldestRetainedSeq = parseCanonicalOrdinal64(frame.oldestRetainedSeq);
    return streamEpoch?.wire === transaction.streamEpoch.wire
      && checkpointEpoch?.wire === transaction.checkpointEpoch.wire
      && sourceSeq?.wire === transaction.sourceSeq.wire
      && snapshotSeq?.wire === transaction.snapshotSeq.wire
      && oldestRetainedSeq?.wire === transaction.oldestRetainedSeq.wire
      && frame.retentionPolicyId === transaction.retentionPolicyId
      && frame.chunkCount === transaction.chunkCount
      && frame.encodedByteTotal === transaction.encodedByteTotal
      && frame.digest === transaction.digest;
  };

  const failCheckpoint = (transaction: CheckpointTransaction, reason: string): TerminalWriteCoordinatorResult => {
    transaction.failed = true;
    transaction.failureReason ??= reason;
    clearCheckpointTimeout();
    if (!transaction.recoveryRequested) {
      transaction.recoveryRequested = true;
      const originGeneration = transaction.generation;
      const shouldNotify = !recoveryRequired;
      const heldMutations = transaction.postCheckpointMutations.splice(0);
      if (checkpointTransaction === transaction) checkpointTransaction = null;
      recoveryInstallation = null;
      recoveryRequired = true;
      ready = false;
      clearPendingInputs('rejected');
      for (const pending of heldMutations) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'failed');
        else rejectCompatibility(pending, reason);
      }
      if (shouldNotify && originGeneration === viewGeneration && !disposed && recoveryRequired) {
        try {
          options.adapter.requestFreshRecovery(reason);
        } catch {
          // The failure latch remains authoritative when notification delivery fails.
        }
      }
    }
    if (checkpointTransaction === transaction) {
      checkpointTransaction = null;
    }
    return rejected(transaction.failureReason);
  };

  const notifyCheckpointApplied = (sourceSeq: ParsedOrdinal64): boolean => {
    const lifecycle = checkpointLifecycle;
    if (
      !lifecycle
      || lifecycle.applied
      || lifecycle.generation !== viewGeneration
      || sourceSeq.value !== lifecycle.watermark.value
    ) {
      return true;
    }
    lifecycle.applied = true;
    try {
      options.adapter.checkpointApplied(lifecycle.metadata);
    } catch {
      requestRecoveryForGeneration(lifecycle.generation, 'checkpoint-applied-callback-failed');
      return false;
    }
    if (lifecycle.generation !== viewGeneration || disposed || recoveryRequired) return false;
    maybeReleaseReady();
    return lifecycle.generation === viewGeneration && !disposed && !recoveryRequired;
  };

  const maybeReleaseReady = (): void => {
    const lifecycle = checkpointLifecycle;
    if (
      disposed
      || ready
      || !lifecycle
      || !lifecycle.applied
      || lifecycle.drained
      || lifecycle.generation !== viewGeneration
      || writeInFlight
      || activeMutation !== null
      || queue.length > 0
      || checkpointTransaction !== null
      || recoveryRequired
    ) {
      return;
    }
    lifecycle.drained = true;
    const drainedMetadata = latestSourceSeq?.wire === lifecycle.metadata.sourceSeq
      ? lifecycle.metadata
      : Object.freeze({
          ...lifecycle.metadata,
          sourceSeq: latestSourceSeq?.wire ?? lifecycle.metadata.sourceSeq,
        });
    try {
      options.adapter.checkpointDrained(drainedMetadata);
    } catch {
      requestRecoveryForGeneration(lifecycle.generation, 'checkpoint-drained-callback-failed');
      return;
    }
    lifecycle.lastDrainedSourceSeq = latestSourceSeq ?? lifecycle.watermark;
    if (lifecycle.generation !== viewGeneration || disposed || recoveryRequired) return;
    ready = true;
    const readyGeneration = viewGeneration;
    try {
      options.adapter.markReady(readyGeneration);
    } catch {
      requestRecoveryForGeneration(readyGeneration, 'adapter-mark-ready-failed');
      return;
    }
    while (
      pendingInputs.length > 0
      && viewGeneration === readyGeneration
      && ready
      && !disposed
      && !recoveryRequired
    ) {
      const input = pendingInputs.shift()!;
      pendingInputBytes -= input.byteLength;
      try {
        options.adapter.releaseInput(input.data);
      } catch {
        settleInputOnce(input.settlementToken, 'rejected');
        clearPendingInputs('rejected');
        requestRecoveryForGeneration(readyGeneration, 'adapter-release-input-failed');
        return;
      }
      settleInputOnce(input.settlementToken, 'released');
    }
    clearInputExpiryTimeout();
  };

  const notifyCumulativeCheckpointDrain = (sourceSeq: ParsedOrdinal64): boolean => {
    const lifecycle = checkpointLifecycle;
    if (!lifecycle?.drained || lifecycle.generation !== viewGeneration) return true;
    if (
      lifecycle.lastDrainedSourceSeq
      && sourceSeq.value <= lifecycle.lastDrainedSourceSeq.value
    ) {
      return true;
    }
    try {
      options.adapter.checkpointDrained(Object.freeze({
        ...lifecycle.metadata,
        sourceSeq: sourceSeq.wire,
      }));
    } catch {
      requestRecoveryForGeneration(lifecycle.generation, 'checkpoint-drained-callback-failed');
      return false;
    }
    lifecycle.lastDrainedSourceSeq = sourceSeq;
    return lifecycle.generation === viewGeneration && !disposed && !recoveryRequired;
  };

  const rejectCompatibility = (
    mutation: PendingMutation,
    reason: string,
  ): void => {
    if (mutation.type === 'write' || mutation.type === 'checkpoint') {
      return;
    }
    try {
      mutation.onRejected?.(reason);
    } catch {
      requestRecoveryForGeneration(mutation.generation, 'compatibility-rejection-callback-failed');
    }
  };

  const fencePhysicalOwnerForTransition = (): Readonly<{
    active: PendingMutation | null;
    newlyFenced: boolean;
  }> => {
    const active = activeMutation;
    if (!active) {
      clearWriteTimeout();
      writeInFlight = false;
      activeMutationFenced = false;
      return { active: null, newlyFenced: false };
    }
    const newlyFenced = !activeMutationFenced;
    activeMutationFenced = true;
    writeInFlight = true;
    return { active, newlyFenced };
  };

  const failMutationChain = (reason: string): void => {
    const active = activeMutation;
    const pending = queue.splice(0);
    const pendingWrites = pending.filter(
      (pending): pending is PendingWrite => pending.type === 'write',
    );
    activeMutation = null;
    activeMutationFenced = false;
    writeInFlight = false;
    clearWriteTimeout();
    checkpointLifecycle = null;
    requestRecovery(reason);
    if (active?.type === 'write') {
      settleOnce(active.settlementToken, 'failed');
    } else if (active) {
      rejectCompatibility(active, reason);
    }
    for (const pending of pendingWrites) {
      settleOnce(pending.settlementToken, 'failed');
    }
    for (const mutation of pending) {
      rejectCompatibility(mutation, reason);
    }
  };

  const requireRuntimeRecreation = (reason: string): void => {
    if (runtimeRecreationRequired) return;
    const active = activeMutation;
    const pending = queue.splice(0);
    const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
    runtimeRecreationRequired = true;
    recoveryRequired = true;
    compatibilityRecoveryPending = false;
    compatibilityRecoveryResetApplied = false;
    ready = false;
    activeMutation = null;
    activeMutationFenced = false;
    writeInFlight = false;
    checkpointTransaction = null;
    checkpointLifecycle = null;
    recoveryInstallation = null;
    clearCheckpointTimeout();
    clearWriteTimeout();
    clearPendingInputs('rejected');
    for (const mutation of [...pending, ...transactionMutations]) {
      if (mutation.type === 'write') settleOnce(mutation.settlementToken, 'failed');
      else rejectCompatibility(mutation, 'runtime-recreation-required');
    }
    if (active?.type === 'write') settleOnce(active.settlementToken, 'failed');
    else if (active) rejectCompatibility(active, 'runtime-recreation-required');
    try {
      options.adapter.requestRuntimeRecreation(reason);
    } catch {
      // The runtime recreation latch remains authoritative when notification fails.
    }
  };

  const pump = (): void => {
    if (disposed || writeInFlight || activeMutation !== null) return;
    const mutation = queue.shift();
    if (!mutation) {
      maybeReleaseReady();
      return;
    }
    if (mutation.generation !== viewGeneration) {
      if (mutation.type === 'write') {
        settleOnce(mutation.settlementToken, 'superseded');
      } else {
        rejectCompatibility(mutation, 'stale-view-generation');
      }
      pump();
      return;
    }

    activeMutation = mutation;
    activeMutationFenced = false;
    writeInFlight = true;
    let callbackSettled = false;
    let checkpointBodySliceEnd: number | null = null;
    try {
      writeTimeoutHandle = setTimer(() => {
        if (
          !callbackSettled
          && activeMutation === mutation
          && !disposed
        ) {
          if (!options.adapter.probeWritePipeline) {
            callbackSettled = true;
            requireRuntimeRecreation('terminal-write-timeout');
            return;
          }
          writeTimeoutHandle = null;
          try {
            writeTimeoutHandle = setTimer(() => {
              if (
                !callbackSettled
                && activeMutation === mutation
                && !disposed
              ) {
                callbackSettled = true;
                requireRuntimeRecreation('terminal-write-pipeline-stalled');
              }
            }, writeStallCheckMs);
            options.adapter.probeWritePipeline(() => {
              // xterm write callbacks are FIFO. A completed probe therefore
              // follows the original completion, which owns normal settlement.
            });
          } catch {
            callbackSettled = true;
            requireRuntimeRecreation('terminal-write-pipeline-probe-failed');
          }
        }
      }, options.adapter.probeWritePipeline ? writeStallCheckMs : timeoutMs);
    } catch {
      failMutationChain('terminal-write-timeout-arm-failed');
      return;
    }
    const onWritten = (): void => {
      if (callbackSettled) return;
      callbackSettled = true;
      if (activeMutation !== mutation) {
        return;
      }
      clearWriteTimeout();
      if (activeMutationFenced || disposed || mutation.generation !== viewGeneration) {
        activeMutation = null;
        activeMutationFenced = false;
        writeInFlight = false;
        if (!recoveryRequired && !runtimeRecreationRequired) pump();
        return;
      }
      activeMutation = null;
      activeMutationFenced = false;
      writeInFlight = false;
      let lifecycleCanContinue = true;
      if (mutation.type === 'write') {
        settleOnce(mutation.settlementToken, 'written');
        lifecycleCanContinue = notifyCheckpointApplied(mutation.sourceSeq);
        if (lifecycleCanContinue) {
          lifecycleCanContinue = notifyCumulativeCheckpointDrain(mutation.sourceSeq);
        }
      } else if (mutation.type === 'compatibility-write') {
        try {
          mutation.onWritten?.();
        } catch {
          requestRecoveryForGeneration(mutation.generation, 'compatibility-written-callback-failed');
        }
      } else if (mutation.type === 'checkpoint' && mutation.phase === 'body') {
        if (checkpointBodySliceEnd === null) {
          failMutationChain('checkpoint-write-slice-invalid');
          return;
        }
        mutation.bodyOffset = checkpointBodySliceEnd;
        if (mutation.bodyOffset >= mutation.body.byteLength) {
          mutation.phase = 'parser-tail';
        }
        queue.unshift(mutation);
      } else if (mutation.type === 'checkpoint') {
        lifecycleCanContinue = notifyCheckpointApplied({
          wire: mutation.metadata.snapshotSeq,
          value: BigInt(mutation.metadata.snapshotSeq),
        });
      }
      if (
        lifecycleCanContinue
        && mutation.generation === viewGeneration
        && !disposed
        && !recoveryRequired
      ) {
        pump();
      }
    };

    const completeSynchronousMutation = (syncMutation: PendingCompatibilitySync): void => {
      if (callbackSettled || activeMutation !== syncMutation) return;
      callbackSettled = true;
      clearWriteTimeout();
      activeMutation = null;
      const wasFenced = activeMutationFenced;
      activeMutationFenced = false;
      writeInFlight = false;
      if (wasFenced || disposed || syncMutation.generation !== viewGeneration) {
        if (!recoveryRequired && !runtimeRecreationRequired) pump();
        return;
      }
      if (
        syncMutation.type === 'compatibility-reset'
        && compatibilityRecoveryPending
        && syncMutation.generation === viewGeneration
      ) {
        compatibilityRecoveryResetApplied = true;
      }
      try {
        syncMutation.onApplied?.();
      } catch {
        requestRecoveryForGeneration(syncMutation.generation, 'compatibility-applied-callback-failed');
      }
      if (syncMutation.generation === viewGeneration && !disposed && !recoveryRequired) {
        pump();
      }
    };

    try {
      if (mutation.type === 'write') {
        options.adapter.write({ kind: mutation.kind, data: mutation.data }, onWritten);
        return;
      }
      if (mutation.type === 'compatibility-write') {
        options.adapter.write({ kind: mutation.kind, data: mutation.data }, onWritten);
        return;
      }
      if (mutation.type === 'compatibility-reset') {
        options.adapter.resetParser();
        completeSynchronousMutation(mutation);
        return;
      }
      if (mutation.type === 'compatibility-clear') {
        options.adapter.clearScreen();
        completeSynchronousMutation(mutation);
        return;
      }
      if (mutation.type === 'compatibility-resize') {
        options.adapter.resize(mutation.cols!, mutation.rows!);
        completeSynchronousMutation(mutation);
        return;
      }
      if (mutation.type === 'compatibility-fit') {
        options.adapter.fit();
        completeSynchronousMutation(mutation);
        return;
      }
      if (mutation.type === 'compatibility-set-windows-pty') {
        options.adapter.setWindowsPty(mutation.value);
        completeSynchronousMutation(mutation);
        return;
      }
      if (mutation.type !== 'checkpoint') {
        throw new Error('unsupported terminal mutation');
      }
      if (mutation.phase === 'body') {
        if (!mutation.bodyPrepared) {
          options.adapter.resetParser();
          if (activeMutation !== mutation || mutation.generation !== viewGeneration || disposed) return;
          options.adapter.resize(mutation.cols, mutation.rows);
          if (activeMutation !== mutation || mutation.generation !== viewGeneration || disposed) return;
          options.adapter.applyModes(mutation.modes);
          if (activeMutation !== mutation || mutation.generation !== viewGeneration || disposed) return;
          mutation.bodyPrepared = true;
        }
        checkpointBodySliceEnd = Math.min(
          mutation.bodyOffset + checkpointWriteSliceBytes,
          mutation.body.byteLength,
        );
        options.adapter.write({
          kind: 'checkpoint',
          data: mutation.body.subarray(mutation.bodyOffset, checkpointBodySliceEnd),
        }, onWritten);
        return;
      }
      options.adapter.write({ kind: 'parser-tail', data: mutation.parserTail }, onWritten);
    } catch {
      if (callbackSettled) return;
      callbackSettled = true;
      failMutationChain('terminal-mutation-apply-failed');
    }
  };

  const validateGeneration = (generation: number): TerminalWriteCoordinatorResult | null => {
    if (!isNonNegativeSafeInteger(generation) || generation !== viewGeneration || disposed) {
      return rejected(disposed ? 'disposed' : 'stale-view-generation');
    }
    return null;
  };

  const validateLiveOrder = (
    streamEpochValue: unknown,
    sourceSeqValue: unknown,
  ): { streamEpoch: ParsedOrdinal64; sourceSeq: ParsedOrdinal64 } | TerminalWriteCoordinatorResult => {
    const streamEpoch = parseCanonicalOrdinal64(streamEpochValue);
    const sourceSeq = parseCanonicalOrdinal64(sourceSeqValue);
    if (!streamEpoch || !sourceSeq) {
      requestRecovery('invalid-ordinal64');
      return rejected('invalid-ordinal64');
    }
    if (currentStreamEpoch) {
      if (streamEpoch.value < currentStreamEpoch.value) {
        requestRecovery('stale-stream-epoch');
        return rejected('stale-stream-epoch');
      }
      if (streamEpoch.value > currentStreamEpoch.value) {
        requestRecovery('fresh-checkpoint-required');
        return rejected('fresh-checkpoint-required');
      }
      if (streamEpoch.value === currentStreamEpoch.value && latestSourceSeq) {
        if (latestSourceSeq.value === ORDINAL64_MAX && sourceSeq.value === 0n) {
          requestRecovery('ordinal64-rollover');
          return rejected('ordinal64-rollover');
        }
        if (sourceSeq.value <= latestSourceSeq.value) {
          requestRecovery('non-monotonic-source-seq');
          return rejected('non-monotonic-source-seq');
        }
      }
    }
    if (!currentStreamEpoch) {
      currentStreamEpoch = streamEpoch;
      latestCheckpointEpoch = null;
    }
    latestSourceSeq = sourceSeq;
    return { streamEpoch, sourceSeq };
  };

  const finalizeCheckpointTransaction = (
    transaction: CheckpointTransaction,
  ): TerminalWriteCoordinatorResult => {
    if (
      checkpointTransaction !== transaction
      || transaction.failed
      || !transaction.commitReceived
      || transaction.validatedBody === null
    ) {
      return failCheckpoint(transaction, 'checkpoint-finalize-invalid');
    }
    const retainedThroughSeq = transaction.latestPostCheckpointSeq ?? transaction.snapshotSeq;
    if (retainedThroughSeq.value < transaction.sourceSeq.value) {
      return ACCEPTED;
    }

    clearCheckpointTimeout();
    checkpointTransaction = null;
    recoveryInstallation = null;
    currentStreamEpoch = transaction.streamEpoch;
    latestCheckpointEpoch = transaction.checkpointEpoch;
    latestSourceSeq = retainedThroughSeq;
    ready = false;
    const metadata = checkpointMetadata(transaction);
    checkpointLifecycle = {
      generation: viewGeneration,
      metadata,
      watermark: transaction.sourceSeq,
      applied: false,
      drained: false,
      lastDrainedSourceSeq: null,
    };
    queue.push({
      type: 'checkpoint',
      generation: viewGeneration,
      body: transaction.validatedBody,
      parserTail: transaction.parserTail,
      cols: transaction.cols,
      rows: transaction.rows,
      modes: transaction.modes,
      metadata,
      phase: 'body',
      bodyPrepared: false,
      bodyOffset: 0,
    });
    queue.push(...transaction.postCheckpointMutations);
    pump();
    return ACCEPTED;
  };

  const dispatch = (command: TerminalWriteCoordinatorCommand): TerminalWriteCoordinatorResult => {
    if (command.type === 'install-rollback-checkpoint-boundary') {
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      if (disposed) return rejected('disposed');
      if (command.viewGeneration !== viewGeneration) return rejected('stale-view-generation');
      if (typeof command.reason !== 'string' || command.reason.trim().length === 0) {
        return rejected('invalid-rollback-checkpoint-reason');
      }
      const streamEpoch = parseCanonicalOrdinal64(command.streamEpoch);
      const checkpointEpoch = parseCanonicalOrdinal64(command.checkpointEpoch);
      if (!streamEpoch || !checkpointEpoch) return rejected('invalid-ordinal64');
      const previousStreamEpoch = checkpointTransaction?.streamEpoch ?? currentStreamEpoch;
      const previousCheckpointEpoch = checkpointTransaction?.checkpointEpoch ?? latestCheckpointEpoch;
      if (
        previousStreamEpoch
        && (
          streamEpoch.value < previousStreamEpoch.value
          || (
            streamEpoch.value === previousStreamEpoch.value
            && previousCheckpointEpoch
            && checkpointEpoch.value <= previousCheckpointEpoch.value
          )
        )
      ) {
        return rejected('stale-rollback-checkpoint-boundary');
      }

      const pendingMutations = queue.splice(0);
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      clearCheckpointTimeout();
      const { active, newlyFenced } = fencePhysicalOwnerForTransition();
      checkpointTransaction = null;
      checkpointLifecycle = null;
      ready = false;
      recoveryRequired = false;
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      recoveryInstallation = { streamEpoch, checkpointEpoch };
      currentStreamEpoch = null;
      latestSourceSeq = null;
      latestCheckpointEpoch = null;
      clearPendingInputs('superseded');
      for (const pending of [...pendingMutations, ...transactionMutations]) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'superseded');
        else rejectCompatibility(pending, command.reason);
      }
      if (newlyFenced && active?.type === 'write') settleOnce(active.settlementToken, 'superseded');
      else if (newlyFenced && active) rejectCompatibility(active, command.reason);
      return ACCEPTED;
    }

    if (command.type === 'rollback-to-compatibility') {
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      if (
        disposed
        || !isNonNegativeSafeInteger(command.viewGeneration)
        || command.viewGeneration <= viewGeneration
      ) {
        return rejected(disposed ? 'disposed' : 'stale-view-generation');
      }
      if (typeof command.reason !== 'string' || command.reason.trim().length === 0) {
        return rejected('invalid-rollback-reason');
      }
      const pendingMutations = queue.splice(0);
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      clearCheckpointTimeout();
      const { active, newlyFenced } = fencePhysicalOwnerForTransition();
      checkpointTransaction = null;
      checkpointLifecycle = null;
      ready = false;
      disposed = false;
      recoveryRequired = false;
      compatibilityRecoveryPending = true;
      compatibilityRecoveryResetApplied = false;
      recoveryInstallation = null;
      currentStreamEpoch = null;
      latestSourceSeq = null;
      latestCheckpointEpoch = null;
      viewGeneration = command.viewGeneration;
      clearPendingInputs('superseded');
      for (const pending of [...pendingMutations, ...transactionMutations]) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'superseded');
        else rejectCompatibility(pending, command.reason);
      }
      if (newlyFenced && active?.type === 'write') settleOnce(active.settlementToken, 'superseded');
      else if (newlyFenced && active) rejectCompatibility(active, command.reason);
      return ACCEPTED;
    }

    if (command.type === 'install-compatibility-recovery-generation') {
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      if (disposed) return rejected('disposed');
      if (!recoveryRequired && !compatibilityRecoveryPending) {
        return rejected('compatibility-recovery-not-required');
      }
      if (
        !isNonNegativeSafeInteger(command.viewGeneration)
        || command.viewGeneration <= viewGeneration
      ) {
        return rejected('stale-view-generation');
      }
      if (typeof command.reason !== 'string' || command.reason.trim().length === 0) {
        return rejected('invalid-compatibility-recovery-reason');
      }
      const pendingMutations = queue.splice(0);
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      clearCheckpointTimeout();
      const { active, newlyFenced } = fencePhysicalOwnerForTransition();
      checkpointTransaction = null;
      checkpointLifecycle = null;
      ready = false;
      recoveryRequired = false;
      recoveryInstallation = null;
      compatibilityRecoveryPending = true;
      compatibilityRecoveryResetApplied = false;
      currentStreamEpoch = null;
      latestSourceSeq = null;
      latestCheckpointEpoch = null;
      viewGeneration = command.viewGeneration;
      clearPendingInputs('superseded');
      for (const pending of [...pendingMutations, ...transactionMutations]) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'superseded');
        else rejectCompatibility(pending, command.reason);
      }
      if (newlyFenced && active?.type === 'write') settleOnce(active.settlementToken, 'superseded');
      else if (newlyFenced && active) rejectCompatibility(active, command.reason);
      return ACCEPTED;
    }

    if (command.type === 'complete-ordered-compatibility-recovery') {
      const invalidGeneration = validateGeneration(command.viewGeneration);
      if (invalidGeneration) return invalidGeneration;
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      if (recoveryRequired) return rejected('recovery-required');
      const streamEpoch = parseCanonicalOrdinal64(command.streamEpoch);
      const checkpointEpoch = parseCanonicalOrdinal64(command.checkpointEpoch);
      if (!streamEpoch || !checkpointEpoch) return rejected('invalid-ordinal64');
      const lifecycle = checkpointLifecycle;
      if (!lifecycle) return rejected('ordered-checkpoint-lifecycle-unavailable');
      if (
        lifecycle.generation !== viewGeneration
        || lifecycle.metadata.streamEpoch !== streamEpoch.wire
        || lifecycle.metadata.checkpointEpoch !== checkpointEpoch.wire
      ) {
        return rejected('ordered-checkpoint-identity-mismatch');
      }
      if (!lifecycle.applied || !lifecycle.drained) {
        return rejected('ordered-checkpoint-drain-pending');
      }
      if (
        activeMutation !== null
        || writeInFlight
        || queue.length > 0
        || pendingInputs.length > 0
        || checkpointTransaction !== null
      ) {
        return rejected('ordered-checkpoint-drain-pending');
      }
      checkpointLifecycle = null;
      recoveryInstallation = null;
      currentStreamEpoch = null;
      latestSourceSeq = null;
      latestCheckpointEpoch = null;
      ready = false;
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      return ACCEPTED;
    }

    if (command.type === 'complete-compatibility-recovery') {
      const invalidGeneration = validateGeneration(command.viewGeneration);
      if (invalidGeneration) return invalidGeneration;
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      if (recoveryRequired) return rejected('recovery-required');
      if (!compatibilityRecoveryPending) return rejected('compatibility-recovery-not-pending');
      if (compatibilityRecoveryCompletionInProgress) {
        return rejected('compatibility-recovery-completion-in-progress');
      }
      if (!compatibilityRecoveryResetApplied) return rejected('compatibility-snapshot-required');
      if (
        activeMutation !== null
        || writeInFlight
        || queue.length > 0
        || checkpointTransaction !== null
      ) {
        return rejected('compatibility-recovery-drain-pending');
      }
      const completedGeneration = viewGeneration;
      compatibilityRecoveryCompletionInProgress = true;
      try {
        options.adapter.compatibilityRecoveryDrained(completedGeneration);
      } catch {
        requestRecovery('compatibility-recovery-drain-callback-failed');
        return rejected('compatibility-recovery-drain-callback-failed');
      } finally {
        compatibilityRecoveryCompletionInProgress = false;
      }
      if (viewGeneration !== completedGeneration || disposed || recoveryRequired) {
        return rejected('stale-view-generation');
      }
      if (
        activeMutation !== null
        || writeInFlight
        || queue.length > 0
        || checkpointTransaction !== null
      ) {
        return rejected('compatibility-recovery-drain-pending');
      }
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      return ACCEPTED;
    }

    if (command.type === 'install-recovery-generation') {
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      const streamEpoch = parseCanonicalOrdinal64(command.streamEpoch);
      const checkpointEpoch = parseCanonicalOrdinal64(command.checkpointEpoch);
      if (!streamEpoch || !checkpointEpoch) return rejected('invalid-ordinal64');
      if (!recoveryRequired) return rejected('recovery-not-required');
      if (
        !isNonNegativeSafeInteger(command.viewGeneration)
        || command.viewGeneration <= viewGeneration
      ) {
        return rejected('stale-view-generation');
      }
      const pendingMutations = queue.splice(0);
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      clearCheckpointTimeout();
      const { active, newlyFenced } = fencePhysicalOwnerForTransition();
      checkpointTransaction = null;
      checkpointLifecycle = null;
      ready = false;
      disposed = false;
      currentStreamEpoch = null;
      latestSourceSeq = null;
      latestCheckpointEpoch = null;
      viewGeneration = command.viewGeneration;
      recoveryRequired = false;
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      recoveryInstallation = { streamEpoch, checkpointEpoch };
      clearPendingInputs('superseded');
      for (const pending of [...pendingMutations, ...transactionMutations]) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'superseded');
        else rejectCompatibility(pending, 'superseded');
      }
      if (newlyFenced && active?.type === 'write') settleOnce(active.settlementToken, 'superseded');
      else if (newlyFenced && active) rejectCompatibility(active, 'superseded');
      return ACCEPTED;
    }

    if (command.type === 'recovery-failed') {
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      const invalidGeneration = validateGeneration(command.viewGeneration);
      if (invalidGeneration) return invalidGeneration;
      if (typeof command.reason !== 'string' || command.reason.trim().length === 0) {
        return rejected('invalid-recovery-failure-reason');
      }
      const originGeneration = viewGeneration;
      const shouldNotify = !recoveryRequired;
      const pendingMutations = queue.splice(0);
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      clearCheckpointTimeout();
      const { active, newlyFenced } = fencePhysicalOwnerForTransition();
      checkpointTransaction = null;
      checkpointLifecycle = null;
      recoveryInstallation = null;
      ready = false;
      recoveryRequired = true;
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      clearPendingInputs('rejected');
      for (const pending of [...pendingMutations, ...transactionMutations]) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'failed');
        else rejectCompatibility(pending, command.reason);
      }
      if (newlyFenced && active?.type === 'write') settleOnce(active.settlementToken, 'failed');
      else if (newlyFenced && active) rejectCompatibility(active, command.reason);
      if (shouldNotify && originGeneration === viewGeneration && recoveryRequired && !disposed) {
        try {
          options.adapter.requestFreshRecovery(command.reason);
        } catch {
          // The fail-closed latch does not depend on notification delivery.
        }
      }
      return rejected(command.reason);
    }

    if (command.type === 'supersede') {
      if (runtimeRecreationRequired) return rejected('runtime-recreation-required');
      if (recoveryRequired) return rejected('recovery-install-required');
      if (!isNonNegativeSafeInteger(command.viewGeneration) || command.viewGeneration <= viewGeneration) {
        return rejected('stale-view-generation');
      }
      const pendingMutations = queue.splice(0);
      const pendingWrites = pendingMutations.filter(
        (pending): pending is PendingWrite => pending.type === 'write',
      );
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      clearCheckpointTimeout();
      const { active, newlyFenced } = fencePhysicalOwnerForTransition();
      const activeWrite = active?.type === 'write' ? active : null;
      checkpointTransaction = null;
      checkpointLifecycle = null;
      ready = false;
      disposed = false;
      recoveryRequired = false;
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      recoveryInstallation = null;
      currentStreamEpoch = null;
      latestSourceSeq = null;
      latestCheckpointEpoch = null;
      viewGeneration = command.viewGeneration;
      clearPendingInputs('superseded');
      for (const pending of pendingWrites) {
        settleOnce(pending.settlementToken, 'superseded');
      }
      for (const pending of transactionMutations) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'superseded');
        else rejectCompatibility(pending, 'superseded');
      }
      for (const pending of pendingMutations) {
        rejectCompatibility(pending, 'superseded');
      }
      if (newlyFenced && activeWrite) {
        settleOnce(activeWrite.settlementToken, 'superseded');
      } else if (newlyFenced && active) {
        rejectCompatibility(active, 'superseded');
      }
      return ACCEPTED;
    }

    if (command.type === 'dispose') {
      const invalidGeneration = validateGeneration(command.viewGeneration);
      if (invalidGeneration) return invalidGeneration;
      const pendingMutations = queue.splice(0);
      const pendingWrites = pendingMutations.filter(
        (pending): pending is PendingWrite => pending.type === 'write',
      );
      const transactionMutations = checkpointTransaction?.postCheckpointMutations.splice(0) ?? [];
      const active = activeMutation;
      const activeWrite = active?.type === 'write' ? active : null;
      clearCheckpointTimeout();
      clearWriteTimeout();
      activeMutation = null;
      activeMutationFenced = false;
      writeInFlight = false;
      checkpointTransaction = null;
      checkpointLifecycle = null;
      ready = false;
      disposed = true;
      recoveryRequired = false;
      compatibilityRecoveryPending = false;
      compatibilityRecoveryResetApplied = false;
      recoveryInstallation = null;
      clearPendingInputs('disposed');
      for (const pending of pendingWrites) {
        settleOnce(pending.settlementToken, 'disposed');
      }
      for (const pending of transactionMutations) {
        if (pending.type === 'write') settleOnce(pending.settlementToken, 'disposed');
        else rejectCompatibility(pending, 'disposed');
      }
      for (const pending of pendingMutations) {
        rejectCompatibility(pending, 'disposed');
      }
      if (activeWrite) {
        settleOnce(activeWrite.settlementToken, 'disposed');
      } else if (active) {
        rejectCompatibility(active, 'disposed');
      }
      return ACCEPTED;
    }

    const invalidGeneration = validateGeneration(command.viewGeneration);
    if (invalidGeneration) {
      if (
        (command.type === 'live' || command.type === 'repair')
        && typeof command.settlementToken === 'string'
        && command.settlementToken.trim().length > 0
        && !settlementLedger.has(command.settlementToken)
      ) {
        const claim = claimSettlementToken(command.settlementToken, command.viewGeneration);
        if (claim === 'accepted') {
          settleOnce(command.settlementToken, command.viewGeneration < viewGeneration ? 'superseded' : 'failed');
        }
      }
      return invalidGeneration;
    }

    if (runtimeRecreationRequired) return rejected('runtime-recreation-required');

    if (recoveryRequired) {
      if (
        (command.type === 'live' || command.type === 'repair')
        && typeof command.settlementToken === 'string'
        && command.settlementToken.trim().length > 0
        && claimSettlementToken(command.settlementToken, viewGeneration) === 'accepted'
      ) {
        settleOnce(command.settlementToken, 'failed');
      }
      return rejected('recovery-required');
    }

    if (
      recoveryInstallation
      && command.type !== 'checkpoint-begin'
      && command.type !== 'checkpoint-chunk'
      && command.type !== 'checkpoint-commit'
      && command.type !== 'queue-input'
    ) {
      return rejected('fresh-checkpoint-required');
    }

    if (command.type === 'queue-input') {
      if (
        typeof command.data !== 'string'
        || typeof command.settlementToken !== 'string'
        || command.settlementToken.trim().length === 0
      ) {
        requestRecovery('invalid-pending-input');
        return rejected('invalid-pending-input');
      }
      const byteLength = inputEncoder.encode(command.data).byteLength;
      if (!ready && (
        pendingInputTtlMs <= 0
        || pendingInputMaxCount <= 0
        || pendingInputMaxBytes <= 0
        || pendingInputs.length + 1 > pendingInputMaxCount
        || pendingInputBytes + byteLength > pendingInputMaxBytes
      )) {
        requestRecovery('pending-input-overflow');
        return rejected('pending-input-overflow');
      }
      const settlementClaim = claimInputSettlementToken(command.settlementToken, viewGeneration);
      if (settlementClaim !== 'accepted') {
        const reason = settlementClaim === 'overflow'
          ? 'input-settlement-ledger-overflow'
          : 'duplicate-input-settlement-token';
        requestRecovery(reason);
        return rejected(reason);
      }
      if (ready) {
        const inputGeneration = viewGeneration;
        try {
          options.adapter.releaseInput(command.data);
        } catch {
          settleInputOnce(command.settlementToken, 'rejected');
          requestRecoveryForGeneration(inputGeneration, 'adapter-release-input-failed');
          return rejected('adapter-release-input-failed');
        }
        settleInputOnce(command.settlementToken, 'released');
        if (viewGeneration !== inputGeneration || disposed || recoveryRequired) {
          return rejected('stale-view-generation');
        }
      } else {
        pendingInputs.push({
          generation: viewGeneration,
          data: command.data,
          settlementToken: command.settlementToken,
          byteLength,
          expiresAt: now() + pendingInputTtlMs,
        });
        pendingInputBytes += byteLength;
        if (pendingInputs.length === 1 && !armInputExpiryTimeout()) {
          clearPendingInputs('rejected');
          return rejected('pending-input-timeout-arm-failed');
        }
      }
      return ACCEPTED;
    }

    if (command.type === 'live' || command.type === 'repair') {
      if (
        !(command.data instanceof Uint8Array)
        || typeof command.settlementToken !== 'string'
        || command.settlementToken.trim().length === 0
      ) {
        if (
          typeof command.settlementToken === 'string'
          && command.settlementToken.trim().length > 0
          && claimSettlementToken(command.settlementToken, viewGeneration) === 'accepted'
        ) {
          settleOnce(command.settlementToken, 'failed');
        }
        requestRecovery('invalid-terminal-write');
        return rejected('invalid-terminal-write');
      }
      const settlementClaim = claimSettlementToken(command.settlementToken, viewGeneration);
      if (settlementClaim !== 'accepted') {
        const reason = settlementClaim === 'overflow'
          ? 'settlement-ledger-overflow'
          : 'duplicate-settlement-token';
        requestRecovery(reason);
        return rejected(reason);
      }
      if (checkpointTransaction && !checkpointTransaction.failed) {
        const streamEpoch = parseCanonicalOrdinal64(command.streamEpoch);
        const sourceSeq = parseCanonicalOrdinal64(command.sourceSeq);
        const previousSeq = checkpointTransaction.latestPostCheckpointSeq
          ?? checkpointTransaction.snapshotSeq;
        if (!streamEpoch || !sourceSeq) {
          settleOnce(command.settlementToken, 'failed');
          return failCheckpoint(checkpointTransaction, 'invalid-ordinal64');
        }
        if (
          streamEpoch.value !== checkpointTransaction.streamEpoch.value
          || sourceSeq.value <= previousSeq.value
        ) {
          settleOnce(command.settlementToken, 'failed');
          return failCheckpoint(checkpointTransaction, 'invalid-post-checkpoint-order');
        }
        const nextHeldBytes = checkpointTransaction.postCheckpointBytes + command.data.byteLength;
        const nextHeldChunks = checkpointTransaction.postCheckpointMutations.length + 1;
        if (
          nextHeldBytes > postCheckpointMaxBytes
          || nextHeldChunks > postCheckpointMaxChunks
        ) {
          settleOnce(command.settlementToken, 'failed');
          return failCheckpoint(checkpointTransaction, 'post-checkpoint-hold-overflow');
        }
        checkpointTransaction.latestPostCheckpointSeq = sourceSeq;
        checkpointTransaction.postCheckpointBytes = nextHeldBytes;
        checkpointTransaction.postCheckpointMutations.push({
          type: 'write',
          generation: viewGeneration,
          kind: command.type,
          data: command.data.slice(),
          settlementToken: command.settlementToken,
          sourceSeq,
        });
        if (
          checkpointTransaction.commitReceived
          && sourceSeq.value >= checkpointTransaction.sourceSeq.value
        ) {
          return finalizeCheckpointTransaction(checkpointTransaction);
        }
        return ACCEPTED;
      }
      const order = validateLiveOrder(command.streamEpoch, command.sourceSeq);
      if ('accepted' in order) {
        settleOnce(command.settlementToken, 'failed');
        return order;
      }
      queue.push({
        type: 'write',
        generation: viewGeneration,
        kind: command.type,
        data: command.data.slice(),
        settlementToken: command.settlementToken,
        sourceSeq: order.sourceSeq,
      });
      pump();
      return ACCEPTED;
    }

    if (command.type === 'checkpoint-begin') {
      if (checkpointTransaction) {
        return failCheckpoint(checkpointTransaction, 'checkpoint-already-open');
      }
      const streamEpoch = parseCanonicalOrdinal64(command.streamEpoch);
      const checkpointEpoch = parseCanonicalOrdinal64(command.checkpointEpoch);
      const sourceSeq = parseCanonicalOrdinal64(command.sourceSeq);
      const snapshotSeq = parseCanonicalOrdinal64(command.snapshotSeq);
      const oldestRetainedSeq = parseCanonicalOrdinal64(command.oldestRetainedSeq);
      if (!streamEpoch || !checkpointEpoch || !sourceSeq || !snapshotSeq || !oldestRetainedSeq) {
        requestRecovery('invalid-ordinal64');
        return rejected('invalid-ordinal64');
      }
      if (
        !isPositiveSafeInteger(command.chunkCount)
        || !isNonNegativeSafeInteger(command.encodedByteTotal)
        || typeof command.digest !== 'string'
        || command.digest.length === 0
        || !isPositiveSafeInteger(command.cols)
        || !isPositiveSafeInteger(command.rows)
        || !isTerminalCheckpointModes(command.modes)
        || !(command.parserTail instanceof Uint8Array)
        || typeof command.retentionPolicyId !== 'string'
        || command.retentionPolicyId.trim().length === 0
        || command.chunkCount > checkpointMaxChunks
        || command.encodedByteTotal + command.parserTail.byteLength > checkpointMaxBytes
      ) {
        requestRecovery('invalid-checkpoint-metadata');
        return rejected('invalid-checkpoint-metadata');
      }
      if (
        oldestRetainedSeq.value > snapshotSeq.value
        || snapshotSeq.value > sourceSeq.value
      ) {
        requestRecovery('invalid-checkpoint-retained-range');
        return rejected('invalid-checkpoint-retained-range');
      }
      if (
        recoveryInstallation
        && (
          streamEpoch.wire !== recoveryInstallation.streamEpoch.wire
          || checkpointEpoch.wire !== recoveryInstallation.checkpointEpoch.wire
        )
      ) {
        recoveryInstallation = null;
        requestRecovery('recovery-install-identity-mismatch');
        return rejected('recovery-install-identity-mismatch');
      }
      if (currentStreamEpoch && streamEpoch.value < currentStreamEpoch.value) {
        requestRecovery('stale-stream-epoch');
        return rejected('stale-stream-epoch');
      }
      if (
        currentStreamEpoch
        && streamEpoch.value === currentStreamEpoch.value
        && latestCheckpointEpoch
        && checkpointEpoch.value <= latestCheckpointEpoch.value
      ) {
        requestRecovery('stale-checkpoint-epoch');
        return rejected('stale-checkpoint-epoch');
      }
      if (
        currentStreamEpoch
        && streamEpoch.value === currentStreamEpoch.value
        && latestSourceSeq
        && snapshotSeq.value < latestSourceSeq.value
      ) {
        requestRecovery('stale-snapshot-seq');
        return rejected('stale-snapshot-seq');
      }
      checkpointTransaction = {
        generation: viewGeneration,
        streamEpoch,
        checkpointEpoch,
        sourceSeq,
        snapshotSeq,
        oldestRetainedSeq,
        retentionPolicyId: command.retentionPolicyId,
        chunkCount: command.chunkCount,
        encodedByteTotal: command.encodedByteTotal,
        digest: command.digest,
        cols: command.cols,
        rows: command.rows,
        modes: Object.freeze({ ...command.modes }),
        parserTail: command.parserTail.slice(),
        chunks: [],
        receivedByteTotal: 0,
        commitReceived: false,
        validatedBody: null,
        postCheckpointMutations: [],
        postCheckpointBytes: 0,
        latestPostCheckpointSeq: null,
        failed: false,
        failureReason: null,
        recoveryRequested: false,
      };
      ready = false;
      const transaction = checkpointTransaction;
      try {
        checkpointTimeoutHandle = setTimer(() => {
          if (
            checkpointTransaction === transaction
            && transaction.generation === viewGeneration
            && !disposed
          ) {
            failCheckpoint(transaction, 'checkpoint-transaction-timeout');
          }
        }, timeoutMs);
      } catch {
        return failCheckpoint(transaction, 'checkpoint-timeout-arm-failed');
      }
      return ACCEPTED;
    }

    if (command.type === 'checkpoint-chunk') {
      const transaction = checkpointTransaction;
      if (!transaction) {
        requestRecovery('checkpoint-not-open');
        return rejected('checkpoint-not-open');
      }
      if (transaction.failed) return rejected(transaction.failureReason ?? 'checkpoint-failed');
      if (transaction.commitReceived) {
        return failCheckpoint(transaction, 'checkpoint-frame-after-commit');
      }
      if (!frameMatchesCheckpoint(transaction, command)) {
        return failCheckpoint(transaction, 'checkpoint-identity-mismatch');
      }
      if (
        !Number.isSafeInteger(command.index)
        || command.index !== transaction.chunks.length
        || command.index < 0
        || command.index >= transaction.chunkCount
        || command.count !== transaction.chunkCount
        || !(command.data instanceof Uint8Array)
        || transaction.receivedByteTotal + command.data.byteLength > transaction.encodedByteTotal
      ) {
        return failCheckpoint(transaction, 'checkpoint-chunk-order-invalid');
      }
      transaction.chunks.push(command.data.slice());
      transaction.receivedByteTotal += command.data.byteLength;
      return ACCEPTED;
    }

    const transaction = checkpointTransaction;
    if (!transaction) {
      requestRecovery('checkpoint-not-open');
      return rejected('checkpoint-not-open');
    }
    if (transaction.failed) {
      checkpointTransaction = null;
      return rejected(transaction.failureReason ?? 'checkpoint-failed');
    }
    if (transaction.commitReceived) {
      const result = failCheckpoint(transaction, 'checkpoint-commit-duplicate');
      checkpointTransaction = null;
      return result;
    }
    if (!frameMatchesCheckpoint(transaction, command)) {
      const result = failCheckpoint(transaction, 'checkpoint-identity-mismatch');
      checkpointTransaction = null;
      return result;
    }
    if (transaction.chunks.length !== transaction.chunkCount) {
      const result = failCheckpoint(transaction, 'checkpoint-chunk-missing');
      checkpointTransaction = null;
      return result;
    }
    const actualBytes = transaction.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (actualBytes !== transaction.encodedByteTotal) {
      const result = failCheckpoint(transaction, 'checkpoint-byte-total-mismatch');
      checkpointTransaction = null;
      return result;
    }
    const body = concatChunks(transaction.chunks, actualBytes);
    let digest: string;
    try {
      digest = options.digestBytes(body);
    } catch {
      const result = failCheckpoint(transaction, 'checkpoint-digest-failed');
      checkpointTransaction = null;
      return result;
    }
    if (digest !== transaction.digest) {
      const result = failCheckpoint(transaction, 'checkpoint-digest-mismatch');
      checkpointTransaction = null;
      return result;
    }
    transaction.commitReceived = true;
    transaction.validatedBody = body;
    return finalizeCheckpointTransaction(transaction);
  };

  // @req FR-BGSTAB-022
  const submitCompatibility = (
    command: TerminalWriteCoordinatorCompatibilityCommand,
  ): TerminalWriteCoordinatorResult => {
    const rejectCommand = (reason: string): TerminalWriteCoordinatorResult => {
      const originGeneration = command.viewGeneration;
      try {
        command.onRejected?.(reason);
      } catch {
        requestRecoveryForGeneration(originGeneration, 'compatibility-rejection-callback-failed');
      }
      return rejected(reason);
    };
    const invalidGeneration = validateGeneration(command.viewGeneration);
    if (invalidGeneration) return rejectCommand(invalidGeneration.reason ?? 'stale-view-generation');
    if (runtimeRecreationRequired) return rejectCommand('runtime-recreation-required');
    if (recoveryRequired) return rejectCommand('recovery-required');
    if (recoveryInstallation) return rejectCommand('fresh-checkpoint-required');

    let mutation: PendingCompatibilityMutation;
    if (command.type === 'write') {
      if (typeof command.data !== 'string' && !(command.data instanceof Uint8Array)) {
        return rejectCommand('invalid-compatibility-write');
      }
      mutation = {
        type: 'compatibility-write',
        generation: viewGeneration,
        kind: command.kind,
        data: typeof command.data === 'string' ? command.data : command.data.slice(),
        onWritten: command.onWritten,
        onRejected: command.onRejected,
      };
    } else if (command.type === 'resize') {
      if (!isPositiveSafeInteger(command.cols) || !isPositiveSafeInteger(command.rows)) {
        return rejectCommand('invalid-compatibility-resize');
      }
      mutation = {
        type: 'compatibility-resize',
        generation: viewGeneration,
        cols: command.cols,
        rows: command.rows,
        onApplied: command.onApplied,
        onRejected: command.onRejected,
      };
    } else if (command.type === 'set-windows-pty') {
      mutation = {
        type: 'compatibility-set-windows-pty',
        generation: viewGeneration,
        value: command.value,
        onApplied: command.onApplied,
        onRejected: command.onRejected,
      };
    } else {
      mutation = {
        type: `compatibility-${command.type}`,
        generation: viewGeneration,
        onApplied: command.onApplied,
        onRejected: command.onRejected,
      };
    }
    const compatibilityWriteBytes = mutation.type === 'compatibility-write'
      ? typeof mutation.data === 'string'
        ? inputEncoder.encode(mutation.data).byteLength
        : mutation.data.byteLength
      : 0;
    const conflictsWithCheckpointAuthority = (
      mutation.type === 'compatibility-reset'
      || mutation.type === 'compatibility-clear'
      || mutation.type === 'compatibility-set-windows-pty'
      || (mutation.type === 'compatibility-write' && compatibilityWriteBytes > 0)
    ) && (checkpointTransaction !== null || checkpointLifecycle !== null);
    if (conflictsWithCheckpointAuthority) {
      const reason = 'checkpoint-authority-conflict';
      // A stale compatibility mutation has not touched xterm yet. Rejecting it
      // is sufficient; invalidating the already accepted server checkpoint
      // would discard the newer authority because an older replay arrived late.
      return rejectCommand(reason);
    }
    if (checkpointTransaction) {
      const nextHeldBytes = checkpointTransaction.postCheckpointBytes + compatibilityWriteBytes;
      const nextHeldChunks = checkpointTransaction.postCheckpointMutations.length + 1;
      if (nextHeldBytes > postCheckpointMaxBytes || nextHeldChunks > postCheckpointMaxChunks) {
        const result = failCheckpoint(checkpointTransaction, 'post-checkpoint-hold-overflow');
        rejectCommand(result.reason ?? 'post-checkpoint-hold-overflow');
        return result;
      }
      checkpointTransaction.postCheckpointBytes = nextHeldBytes;
      checkpointTransaction.postCheckpointMutations.push(mutation);
      return ACCEPTED;
    }
    queue.push(mutation);
    pump();
    return ACCEPTED;
  };

  return Object.freeze({
    dispatch,
    submitCompatibility,
    getState(): Readonly<TerminalWriteCoordinatorState> {
      pruneSettlementLedger();
      return Object.freeze({
        viewGeneration,
        ready,
        disposed,
        writeInFlight,
        pendingCommands: queue.length + (activeMutation === null ? 0 : 1),
        pendingInputs: pendingInputs.length,
        pendingInputBytes,
        settlementLedgerEntries: settlementLedger.size,
        inputSettlementLedgerEntries: inputSettlementLedger.size,
        recoveryRequired,
        compatibilityRecoveryPending,
        runtimeRecreationRequired,
      });
    },
  });
}
