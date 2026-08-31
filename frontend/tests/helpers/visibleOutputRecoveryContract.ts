import assert from 'node:assert/strict';
import * as visibleOutputRecoveryModule from '../../src/utils/visibleOutputRecovery.ts';

export interface RecoveryScope {
  clientId: string;
  sessionId: string;
}

export interface RecoveryChunk {
  chunkId: string;
  screenSeq?: number;
  data: string;
}

export interface RecoveryTransactionState {
  transactionId: string;
  repairToken: string;
  replayToken: string;
  connectionGeneration: number;
  sessionGeneration: number;
  staleTerminal: boolean;
  currentViewTransactionReady: boolean;
  retainedHistoryEquivalent: boolean;
  provisionalLocalState: boolean;
  hiddenDirty: boolean;
  hiddenSkipped: boolean;
  heldOutputBytes: number;
  heldChunks: RecoveryChunk[];
  disposed: boolean;
}

export type RecoveryCoordinatorEvent = RecoveryScope & Record<string, unknown> & {
  type: string;
};

export interface RecoveryCoordinatorResult {
  ignored: boolean;
  state: RecoveryTransactionState | undefined;
}

export interface ScheduledRecoveryWrite extends RecoveryScope {
  chunk: RecoveryChunk;
  onWritten: () => void;
}

export interface RecoveryOutcome extends RecoveryScope {
  outcome: string;
  reason: string;
}

export interface RecoveryCoordinatorAdapter {
  enqueueScheduledOutput: (write: ScheduledRecoveryWrite) => void;
  setCurrentViewReady: (scope: RecoveryScope & { ready: boolean }) => void;
  abortRepair: (scope: RecoveryScope & { repairToken: string }) => void;
  requestFreshSnapshot: (scope: RecoveryScope & { replayToken: string; reason: string }) => void;
  publishOutcome: (outcome: RecoveryOutcome) => void;
  acknowledgeRepairSuccess: (scope: RecoveryScope & { repairToken: string }) => void;
  directWrite: (scope: RecoveryScope & { data: string }) => void;
  activateSplitOutput: (scope: RecoveryScope) => void;
}

export interface VisibleOutputRecoveryCoordinator {
  dispatch: (event: RecoveryCoordinatorEvent) => RecoveryCoordinatorResult;
  getState: (scope: RecoveryScope) => RecoveryTransactionState | undefined;
  getTransportStatus: () => {
    requestedTransportMode: 'unified' | 'split-shadow' | 'split';
    effectiveTransportMode: 'unified';
    splitActivationEnabled: false;
    standaloneSplitParity: 'unresolved';
  };
}

export interface VisibleOutputRecoveryCoordinatorOptions {
  maxHeldBytes: number;
  maxHeldChunks: number;
  transportMode: 'unified' | 'split-shadow' | 'split';
  adapter: RecoveryCoordinatorAdapter;
}

type CoordinatorFactory = (
  options: VisibleOutputRecoveryCoordinatorOptions,
) => VisibleOutputRecoveryCoordinator;

export interface RecordingRecoveryAdapter extends RecoveryCoordinatorAdapter {
  scheduled: ScheduledRecoveryWrite[];
  readyChanges: Array<RecoveryScope & { ready: boolean }>;
  aborted: Array<RecoveryScope & { repairToken: string }>;
  freshSnapshots: Array<RecoveryScope & { replayToken: string; reason: string }>;
  outcomes: RecoveryOutcome[];
  successAcks: Array<RecoveryScope & { repairToken: string }>;
  directWrites: Array<RecoveryScope & { data: string }>;
  splitActivations: RecoveryScope[];
}

export function requireRecoveryCoordinatorFactory(signature: string): CoordinatorFactory {
  const candidate = (visibleOutputRecoveryModule as Record<string, unknown>)
    .createVisibleOutputRecoveryCoordinator;
  assert.equal(typeof candidate, 'function', signature);
  return candidate as CoordinatorFactory;
}

export function createRecordingRecoveryAdapter(): RecordingRecoveryAdapter {
  const scheduled: ScheduledRecoveryWrite[] = [];
  const readyChanges: Array<RecoveryScope & { ready: boolean }> = [];
  const aborted: Array<RecoveryScope & { repairToken: string }> = [];
  const freshSnapshots: Array<RecoveryScope & { replayToken: string; reason: string }> = [];
  const outcomes: RecoveryOutcome[] = [];
  const successAcks: Array<RecoveryScope & { repairToken: string }> = [];
  const directWrites: Array<RecoveryScope & { data: string }> = [];
  const splitActivations: RecoveryScope[] = [];

  return {
    scheduled,
    readyChanges,
    aborted,
    freshSnapshots,
    outcomes,
    successAcks,
    directWrites,
    splitActivations,
    enqueueScheduledOutput: (write) => scheduled.push(write),
    setCurrentViewReady: (change) => readyChanges.push(change),
    abortRepair: (scope) => aborted.push(scope),
    requestFreshSnapshot: (request) => freshSnapshots.push(request),
    publishOutcome: (outcome) => outcomes.push(outcome),
    acknowledgeRepairSuccess: (ack) => successAcks.push(ack),
    directWrite: (write) => directWrites.push(write),
    activateSplitOutput: (scope) => splitActivations.push(scope),
  };
}

export function beginRecovery(
  coordinator: VisibleOutputRecoveryCoordinator,
  scope: RecoveryScope,
  overrides: Record<string, unknown> = {},
): RecoveryCoordinatorResult {
  return coordinator.dispatch({
    type: 'begin-resync',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    hiddenDirty: true,
    hiddenSkipped: true,
    ...overrides,
  });
}
