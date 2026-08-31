import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginVisibleOutputRecovery,
  advanceTerminalCompatibilityPostAckConvergence,
  classifyVisibleResyncOutputBatch,
  createTerminalCompatibilityPostAckConvergence,
  createTerminalCompatibilityProgressTimeout,
  createVisibleOutputMutationFence,
  createVisibleOutputRecoveryState,
  finishVisibleOutputRecovery,
  isVisibleOutputRecoveryBlocking,
  recordVisibleOutputRecoverySendFailure,
  recordVisibleOutputRecoverySendSuccess,
  resolveVisibleOutputRecoveryBarrierReason,
  shouldSuppressLegacySnapshotDuringCheckpointAuthority,
  splitVisibleOutputSourceSegments,
} from '../../src/utils/visibleOutputRecovery.ts';
import * as visibleOutputRecoveryModule from '../../src/utils/visibleOutputRecovery.ts';
import {
  beginRecovery,
  createRecordingRecoveryAdapter,
  requireRecoveryCoordinatorFactory,
  type RecoveryChunk,
  type RecoveryScope,
} from '../helpers/visibleOutputRecoveryContract.ts';

const RED_SIGNATURES = {
  ac2: 'Frontend stale/resync barrier RED 계약 RED AC-2: current-view ready/input release occurred before authoritative apply plus held-tail write drain, or tail order/chunk identity changed',
  ac5: 'Frontend stale/resync barrier RED 계약 RED AC-5: failed/timeout/reoverflow/parser-reset failure reported success, released input, or lacked reconnect-required/authority-unavailable',
  ac10: 'Frontend stale/resync barrier RED 계약 RED AC-10: recovery bypassed the bounded scheduler, used direct/giant write, activated split parity, or promoted retained history equivalence',
} as const;

const COMPATIBILITY_POST_ACK_IDENTITY = {
  sessionId: 'session-1',
  replayToken: 'replay-1',
  snapshotSeq: 40,
  connectionGeneration: 7,
  sessionGeneration: 9,
  viewGeneration: 11,
} as const;

test('MIG-BGSTAB-002 late legacy snapshots cannot overwrite active checkpoint authority', () => {
  assert.equal(shouldSuppressLegacySnapshotDuringCheckpointAuthority({
    checkpointAuthorityActive: true,
    compatibilityRecoveryPending: false,
    snapshotMode: 'authoritative',
  }), true);
  assert.equal(shouldSuppressLegacySnapshotDuringCheckpointAuthority({
    checkpointAuthorityActive: true,
    compatibilityRecoveryPending: true,
    snapshotMode: 'authoritative',
  }), false, 'ordered compatibility rollback still needs its authoritative recovery snapshot');
  assert.equal(shouldSuppressLegacySnapshotDuringCheckpointAuthority({
    checkpointAuthorityActive: true,
    compatibilityRecoveryPending: false,
    snapshotMode: 'fallback',
  }), false);
  assert.equal(shouldSuppressLegacySnapshotDuringCheckpointAuthority({
    checkpointAuthorityActive: false,
    compatibilityRecoveryPending: false,
    snapshotMode: 'authoritative',
  }), false);
});

test('compatibility post-ACK convergence waits for matching ready and physical tail drain in either order', () => {
  let readyFirst = createTerminalCompatibilityPostAckConvergence(
    COMPATIBILITY_POST_ACK_IDENTITY,
  );
  let result = advanceTerminalCompatibilityPostAckConvergence(readyFirst, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-1',
    screenSeq: 41,
    byteLength: 8,
  });
  assert.equal(result.accepted, true);
  readyFirst = result.state;
  result = advanceTerminalCompatibilityPostAckConvergence(readyFirst, {
    type: 'server-ready-latched',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
  });
  assert.equal(result.converged, false);
  readyFirst = result.state;
  result = advanceTerminalCompatibilityPostAckConvergence(readyFirst, {
    type: 'output-drained',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-1',
  });
  assert.equal(result.converged, true);
  assert.equal(result.state.heldOutputBytes, 0);
  assert.equal(result.state.pendingOutputIds.length, 0);

  let drainFirst = createTerminalCompatibilityPostAckConvergence(
    COMPATIBILITY_POST_ACK_IDENTITY,
  );
  drainFirst = advanceTerminalCompatibilityPostAckConvergence(drainFirst, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-2',
    screenSeq: 42,
    byteLength: 5,
  }).state;
  result = advanceTerminalCompatibilityPostAckConvergence(drainFirst, {
    type: 'output-drained',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-2',
  });
  assert.equal(result.converged, false);
  drainFirst = result.state;
  result = advanceTerminalCompatibilityPostAckConvergence(drainFirst, {
    type: 'server-ready-latched',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
  });
  assert.equal(result.converged, true);
});

test('compatibility post-ACK convergence rejects stale identity and covered output without opening ready', () => {
  const state = createTerminalCompatibilityPostAckConvergence(
    COMPATIBILITY_POST_ACK_IDENTITY,
  );
  for (const event of [
    {
      type: 'server-ready-latched' as const,
      ...COMPATIBILITY_POST_ACK_IDENTITY,
      replayToken: 'stale-replay',
    },
    {
      type: 'server-ready-latched' as const,
      ...COMPATIBILITY_POST_ACK_IDENTITY,
      snapshotSeq: 39,
    },
    {
      type: 'server-ready-latched' as const,
      ...COMPATIBILITY_POST_ACK_IDENTITY,
      connectionGeneration: 6,
    },
    {
      type: 'server-ready-latched' as const,
      ...COMPATIBILITY_POST_ACK_IDENTITY,
      viewGeneration: 10,
    },
    {
      type: 'output-arrived' as const,
      ...COMPATIBILITY_POST_ACK_IDENTITY,
      outputId: 'covered-tail',
      screenSeq: 40,
      byteLength: 4,
    },
  ]) {
    const result = advanceTerminalCompatibilityPostAckConvergence(state, event);
    assert.equal(result.accepted, false);
    assert.equal(result.converged, false);
    assert.equal(result.state.currentViewTransactionReady, false);
  }
});

test('compatibility post-ACK convergence permanently rejects drained duplicate IDs and decrements bytes exactly', () => {
  let state = createTerminalCompatibilityPostAckConvergence(
    COMPATIBILITY_POST_ACK_IDENTITY,
    { maxHeldBytes: 32, maxHeldChunks: 2 },
  );
  state = advanceTerminalCompatibilityPostAckConvergence(state, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-a',
    screenSeq: 41,
    byteLength: 8,
  }).state;
  state = advanceTerminalCompatibilityPostAckConvergence(state, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-b',
    screenSeq: 42,
    byteLength: 5,
  }).state;
  assert.equal(state.heldOutputBytes, 13);
  const firstDrain = advanceTerminalCompatibilityPostAckConvergence(state, {
    type: 'output-drained',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-a',
  });
  assert.equal(firstDrain.accepted, true);
  assert.equal(firstDrain.state.heldOutputBytes, 5);
  assert.deepEqual(firstDrain.state.pendingOutputIds, ['tail-b']);

  const duplicate = advanceTerminalCompatibilityPostAckConvergence(firstDrain.state, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-a',
    screenSeq: 43,
    byteLength: 8,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.state.heldOutputBytes, 5);

  const overflow = advanceTerminalCompatibilityPostAckConvergence(firstDrain.state, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-c',
    screenSeq: 44,
    byteLength: 33,
  });
  assert.equal(overflow.accepted, false);
});

test('compatibility post-ACK convergence rejects duplicate and descending screen sequence before write admission', () => {
  let state = createTerminalCompatibilityPostAckConvergence(
    COMPATIBILITY_POST_ACK_IDENTITY,
    { maxHeldBytes: 32, maxHeldChunks: 4 },
  );
  const first = advanceTerminalCompatibilityPostAckConvergence(state, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-12',
    screenSeq: 42,
    byteLength: 4,
  });
  assert.equal(first.accepted, true);
  state = first.state;
  assert.equal(state.lastAcceptedScreenSeq, 42);

  for (const [outputId, screenSeq] of [
    ['tail-12-duplicate-seq', 42],
    ['tail-11-descending', 41],
  ] as const) {
    const rejected = advanceTerminalCompatibilityPostAckConvergence(state, {
      type: 'output-arrived',
      ...COMPATIBILITY_POST_ACK_IDENTITY,
      outputId,
      screenSeq,
      byteLength: 4,
    });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.state, state);
    assert.deepEqual(rejected.state.pendingOutputIds, ['tail-12']);
  }

  const laterGap = advanceTerminalCompatibilityPostAckConvergence(state, {
    type: 'output-arrived',
    ...COMPATIBILITY_POST_ACK_IDENTITY,
    outputId: 'tail-14-after-server-resize-revision',
    screenSeq: 44,
    byteLength: 4,
  });
  assert.equal(laterGap.accepted, true);
  assert.equal(laterGap.state.lastAcceptedScreenSeq, 44);
});

test('compatibility progress timeout permits long draining tails but fails bounded inactivity', () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const advance = (elapsedMs: number): void => {
    const target = now + elapsedMs;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
    }
    now = target;
  };
  let timeoutCount = 0;
  const timeout = createTerminalCompatibilityProgressTimeout({
    timeoutMs: 2_000,
    onTimeout: () => { timeoutCount += 1; },
    setTimer: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
  });

  timeout.progress();
  for (let chunk = 0; chunk < 512; chunk += 1) {
    advance(10);
    timeout.progress();
  }
  assert.equal(now, 5_120);
  assert.equal(timeoutCount, 0);
  advance(1_999);
  assert.equal(timeoutCount, 0);
  advance(1);
  assert.equal(timeoutCount, 1);
  timeout.clear();
  assert.equal(timers.size, 0);
});

test('restore-needed and snapshot authority proof is exact and fail-closed', () => {
  const matches = visibleOutputRecoveryModule.matchesRestoreNeededSnapshotAuthorityProof;
  const sameRestore = visibleOutputRecoveryModule.hasSameRestoreNeededAuthorityProof;
  assert.equal(typeof matches, 'function');
  assert.equal(typeof sameRestore, 'function');
  const restore = {
    replayToken: 'R2',
    snapshotSeq: 11,
    authorityEpoch: 'authority-a',
    authorityRevision: 11,
    coversThroughSeq: 11,
    supersedesReplayToken: 'R1',
  };
  const snapshot = {
    replayToken: 'R2',
    seq: 11,
    authorityEpoch: 'authority-a',
    authorityRevision: 11,
    coversThroughSeq: 11,
    supersedesReplayToken: 'R1',
  };
  assert.equal(matches(restore, snapshot), true);
  assert.equal(matches(restore, { ...snapshot, authorityEpoch: 'authority-b' }), false);
  assert.equal(matches(restore, { ...snapshot, authorityRevision: 10 }), false);
  assert.equal(matches(restore, { ...snapshot, coversThroughSeq: 10 }), false);
  assert.equal(matches(restore, { ...snapshot, supersedesReplayToken: undefined }), false);
  assert.equal(matches({ ...restore, authorityEpoch: undefined }, snapshot), false);
  assert.equal(sameRestore(restore, { ...restore }), true);
  assert.equal(sameRestore(restore, { ...restore, authorityRevision: 12 }), false);
});

test('coalesced UTF-8 output expands to exact recovery chunks without losing identity', () => {
  assert.deepEqual(splitVisibleOutputSourceSegments('A한😀', [
    { byteStart: 0, byteEnd: 1, screenSeq: 10, authorityEpoch: 'authority-a', authorityRevision: 10, chunkId: 'chunk-a' },
    { byteStart: 1, byteEnd: 4, screenSeq: 11, chunkId: 'chunk-hangul' },
    { byteStart: 4, byteEnd: 8, screenSeq: 12, chunkId: 'chunk-emoji' },
  ]), [
    { data: 'A', screenSeq: 10, authorityEpoch: 'authority-a', authorityRevision: 10, chunkId: 'chunk-a' },
    { data: '한', screenSeq: 11, chunkId: 'chunk-hangul' },
    { data: '😀', screenSeq: 12, chunkId: 'chunk-emoji' },
  ]);
  assert.equal(splitVisibleOutputSourceSegments('A한', [
    { byteStart: 0, byteEnd: 2, screenSeq: 10, chunkId: 'invalid-boundary' },
  ]), null);
});

test('coalesced recovery output rejects the whole batch before a later stale segment can partially apply', () => {
  const common = {
    activeReplayToken: 'replay-current',
    outputReplayToken: undefined,
    matchingServerReadyLatched: false,
  };

  assert.equal(classifyVisibleResyncOutputBatch({
    ...common,
    chunks: [
      { data: 'first', chunkId: 'live-1', screenSeq: 12 },
      { data: 'stale', chunkId: 'missing-sequence' },
    ],
  }), null);
  assert.deepEqual(classifyVisibleResyncOutputBatch({
    ...common,
    chunks: [
      { data: 'first', chunkId: 'live-1', screenSeq: 12 },
      { data: 'second', chunkId: 'live-2', screenSeq: 13 },
    ],
  }), ['current-live', 'current-live']);
});

test('visible recovery retry budget is bounded across transactions and resets only after convergence', () => {
  const signature = 'REL-BGSTAB-009 RED: deterministic recovery failures can issue unbounded fresh snapshots or reconnects across transactions';
  const factory = (visibleOutputRecoveryModule as Record<string, unknown>)
    .createVisibleOutputRecoveryAttemptBudget;
  assert.equal(typeof factory, 'function', signature);

  const budget = (factory as (limits: {
    maxFreshSnapshotAttempts: number;
    maxReconnectAttempts: number;
  }) => {
    consume: (kind: 'fresh-snapshot' | 'reconnect') => { allowed: boolean; attempt: number };
    resetAfterConvergence: () => void;
    armReconnectConvergence: (identity: {
      connectionGeneration: number;
      replayToken: string;
      snapshotSeq: number;
    }) => void;
    resetAfterMatchingReconnectConvergence: (identity: {
      connectionGeneration: number;
      replayToken: string;
      snapshotSeq: number;
    }) => boolean;
  })({
    maxFreshSnapshotAttempts: 2,
    maxReconnectAttempts: 2,
  });

  assert.deepEqual(budget.consume('fresh-snapshot'), { allowed: true, attempt: 1 }, signature);
  assert.deepEqual(budget.consume('fresh-snapshot'), { allowed: true, attempt: 2 }, signature);
  assert.deepEqual(budget.consume('fresh-snapshot'), { allowed: false, attempt: 2 }, signature);
  assert.deepEqual(budget.consume('reconnect'), { allowed: true, attempt: 1 }, signature);
  assert.deepEqual(budget.consume('reconnect'), { allowed: true, attempt: 2 }, signature);
  assert.deepEqual(budget.consume('reconnect'), { allowed: false, attempt: 2 }, signature);

  budget.resetAfterConvergence();
  assert.deepEqual(budget.consume('fresh-snapshot'), { allowed: true, attempt: 1 }, signature);
  assert.deepEqual(budget.consume('reconnect'), { allowed: true, attempt: 1 }, signature);

  for (let generation = 1; generation <= 4; generation += 1) {
    const identity = {
      connectionGeneration: generation,
      replayToken: `replay-${generation}`,
      snapshotSeq: generation * 10,
    };
    budget.armReconnectConvergence(identity);
    assert.equal(budget.resetAfterMatchingReconnectConvergence({
      ...identity,
      snapshotSeq: identity.snapshotSeq - 1,
    }), false, signature);
    assert.equal(budget.resetAfterMatchingReconnectConvergence(identity), true, signature);
    assert.deepEqual(budget.consume('reconnect'), { allowed: true, attempt: 1 }, signature);
  }
});

test('replacement authoritative identity bypasses duplicate content optimization while recovery is blocking', () => {
  const signature = 'REL-BGSTAB-009 RED: identical replacement-socket authoritative snapshot is acknowledged without converging recovery';
  const classifier = (visibleOutputRecoveryModule as Record<string, unknown>)
    .shouldForceAuthoritativeRecoveryConvergence;
  assert.equal(typeof classifier, 'function', signature);
  const classify = classifier as (input: {
    recoveryBlocking: boolean;
    snapshotMode: 'authoritative' | 'fallback';
    replayToken: string;
    currentConnectionGeneration: number;
    lastApplied: null | { replayToken: string; connectionGeneration: number };
  }) => boolean;

  assert.equal(classify({
    recoveryBlocking: true,
    snapshotMode: 'authoritative',
    replayToken: 'replacement-replay',
    currentConnectionGeneration: 2,
    lastApplied: { replayToken: 'old-replay', connectionGeneration: 1 },
  }), true, signature);
  assert.equal(classify({
    recoveryBlocking: false,
    snapshotMode: 'authoritative',
    replayToken: 'replacement-replay',
    currentConnectionGeneration: 2,
    lastApplied: { replayToken: 'old-replay', connectionGeneration: 1 },
  }), false, signature);
  assert.equal(classify({
    recoveryBlocking: true,
    snapshotMode: 'fallback',
    replayToken: 'replacement-replay',
    currentConnectionGeneration: 2,
    lastApplied: { replayToken: 'old-replay', connectionGeneration: 1 },
  }), false, signature);
  assert.equal(classify({
    recoveryBlocking: true,
    snapshotMode: 'authoritative',
    replayToken: 'same-replay',
    currentConnectionGeneration: 2,
    lastApplied: { replayToken: 'same-replay', connectionGeneration: 2 },
  }), false, signature);
});

test('checkpoint authority converges an initial authoritative restore without a prior snapshot', () => {
  const signature = 'MIG-BGSTAB-002 RED: no-cache mount discards its initial authoritative snapshot behind checkpoint authority';
  const classifier = (visibleOutputRecoveryModule as Record<string, unknown>)
    .shouldForceInitialCheckpointAuthorityRecoveryConvergence;
  assert.equal(typeof classifier, 'function', signature);
  const classify = classifier as (input: {
    checkpointAuthorityActive: boolean;
    initialRestorePending: boolean;
    snapshotMode: 'authoritative' | 'fallback';
    hasLastAppliedSnapshot: boolean;
  }) => boolean;

  assert.equal(classify({
    checkpointAuthorityActive: true,
    initialRestorePending: true,
    snapshotMode: 'authoritative',
    hasLastAppliedSnapshot: false,
  }), true, signature);
  assert.equal(classify({
    checkpointAuthorityActive: false,
    initialRestorePending: true,
    snapshotMode: 'authoritative',
    hasLastAppliedSnapshot: false,
  }), false, signature);
  assert.equal(classify({
    checkpointAuthorityActive: true,
    initialRestorePending: false,
    snapshotMode: 'authoritative',
    hasLastAppliedSnapshot: false,
  }), false, signature);
  assert.equal(classify({
    checkpointAuthorityActive: true,
    initialRestorePending: true,
    snapshotMode: 'fallback',
    hasLastAppliedSnapshot: false,
  }), false, signature);
  assert.equal(classify({
    checkpointAuthorityActive: true,
    initialRestorePending: true,
    snapshotMode: 'authoritative',
    hasLastAppliedSnapshot: true,
  }), false, signature);
});

test('visible output recovery retries failed replay sends before abandoning', () => {
  let state = createVisibleOutputRecoveryState();
  const started = beginVisibleOutputRecovery(state);
  state = started.state;

  assert.equal(started.shouldSend, true);
  assert.equal(state.pending, true);

  const firstFailure = recordVisibleOutputRecoverySendFailure(state, 2);
  state = firstFailure.state;
  assert.equal(firstFailure.action, 'retry');
  assert.equal(state.pending, true);
  assert.equal(state.retryCount, 1);

  const secondFailure = recordVisibleOutputRecoverySendFailure(state, 2);
  state = secondFailure.state;
  assert.equal(secondFailure.action, 'abandon');
  assert.equal(state.pending, false);
  assert.equal(state.retryCount, 0);
  assert.equal(state.staleTerminal, true);
  assert.equal(isVisibleOutputRecoveryBlocking(state), true);
});

test('visible output recovery ignores duplicate overflow while pending and clears on finish', () => {
  let state = createVisibleOutputRecoveryState();
  state = beginVisibleOutputRecovery(state).state;

  const duplicate = beginVisibleOutputRecovery(state);
  assert.equal(duplicate.shouldSend, false);
  assert.equal(duplicate.state.pending, true);

  state = recordVisibleOutputRecoverySendSuccess(duplicate.state);
  assert.equal(state.pending, true);

  state = finishVisibleOutputRecovery(state);
  assert.equal(state.pending, false);
  assert.equal(state.retryCount, 0);
  assert.equal(isVisibleOutputRecoveryBlocking(state), false);
});

test('visible output recovery keeps input blocked when abandoning a stale terminal view', () => {
  let state = beginVisibleOutputRecovery(createVisibleOutputRecoveryState()).state;

  state = finishVisibleOutputRecovery(state, { keepTerminalStale: true });

  assert.equal(state.pending, false);
  assert.equal(state.retryCount, 0);
  assert.equal(state.staleTerminal, true);
  assert.equal(isVisibleOutputRecoveryBlocking(state), true);
  assert.equal(beginVisibleOutputRecovery(state).shouldSend, false);

  state = finishVisibleOutputRecovery(state);
  assert.equal(state.staleTerminal, false);
  assert.equal(isVisibleOutputRecoveryBlocking(state), false);
});

test('visible output recovery exposes a transport barrier while pending or stale', () => {
  let state = createVisibleOutputRecoveryState();
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'none');

  state = beginVisibleOutputRecovery(state).state;
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'visible-output-recovery');

  state = finishVisibleOutputRecovery(state, { keepTerminalStale: true });
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'visible-output-recovery');

  state = finishVisibleOutputRecovery(state);
  assert.equal(resolveVisibleOutputRecoveryBarrierReason(state), 'none');
});

test('Frontend stale/resync barrier RED 계약 — AC-2', () => {
  const signature = RED_SIGNATURES.ac2;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 4096,
    maxHeldChunks: 16,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'client-a', sessionId: 'session-a' };
  beginRecovery(coordinator, scope);

  const coveredChunk: RecoveryChunk = { chunkId: 'covered-40', screenSeq: 40, data: 'covered-prefix' };
  const firstTail: RecoveryChunk = {
    chunkId: 'tail-41',
    screenSeq: 41,
    data: 'ASCII-한글-😀',
  };
  const secondTail: RecoveryChunk = {
    chunkId: 'tail-42',
    screenSeq: 42,
    data: '\x1b[31mcomplete-ansi\x1b[0m',
  };

  for (const chunk of [coveredChunk, firstTail, secondTail]) {
    coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      chunk,
    });
  }
  const duplicateChunk = coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: firstTail,
  });
  assert.equal(duplicateChunk.ignored, true, signature);

  coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 40,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });

  let state = coordinator.getState(scope);
  assert.equal(state?.currentViewTransactionReady, false, signature);
  assert.equal(state?.retainedHistoryEquivalent, false, signature);
  assert.deepEqual(adapter.scheduled.map(({ chunk }) => chunk.chunkId), ['tail-41', 'tail-42'], signature);
  assert.strictEqual(adapter.scheduled[0]?.chunk, firstTail, signature);
  assert.strictEqual(adapter.scheduled[1]?.chunk, secondTail, signature);
  assert.equal(adapter.readyChanges.some(({ ready }) => ready), false, signature);

  adapter.scheduled[0]?.onWritten();
  state = coordinator.getState(scope);
  assert.equal(state?.currentViewTransactionReady, false, signature);
  assert.equal(adapter.readyChanges.some(({ ready }) => ready), false, signature);

  adapter.scheduled[1]?.onWritten();
  state = coordinator.getState(scope);
  assert.equal(state?.currentViewTransactionReady, true, signature);
  assert.equal(state?.retainedHistoryEquivalent, false, signature);
  assert.equal(adapter.readyChanges.filter(({ ready }) => ready).length, 1, signature);

  adapter.scheduled[1]?.onWritten();
  assert.equal(adapter.readyChanges.filter(({ ready }) => ready).length, 1, signature);
  assert.deepEqual(adapter.scheduled.map(({ chunk }) => chunk.chunkId), ['tail-41', 'tail-42'], signature);

  const gatedAdapter = createRecordingRecoveryAdapter();
  const gatedCoordinator = factory({
    maxHeldBytes: 4096,
    maxHeldChunks: 16,
    transportMode: 'unified',
    adapter: gatedAdapter,
  });
  const gatedScope: RecoveryScope = { clientId: 'client-ready-gate', sessionId: 'session-a' };
  beginRecovery(gatedCoordinator, gatedScope, { serverReadyLatched: false });
  const unknownSequenceTail: RecoveryChunk = {
    chunkId: 'unknown-sequence-tail',
    data: 'wire-output-without-sequence',
  };
  gatedCoordinator.dispatch({
    type: 'output-arrived',
    ...gatedScope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: unknownSequenceTail,
  });
  gatedCoordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...gatedScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 10_000,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.strictEqual(gatedAdapter.scheduled[0]?.chunk, unknownSequenceTail, signature);
  gatedAdapter.scheduled[0]?.onWritten();
  assert.equal(gatedCoordinator.getState(gatedScope)?.currentViewTransactionReady, false, signature);
  const postSnapshotTail: RecoveryChunk = {
    chunkId: 'post-snapshot-tail',
    screenSeq: 10_001,
    data: 'post-snapshot-wire-output',
  };
  gatedCoordinator.dispatch({
    type: 'output-arrived',
    ...gatedScope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: postSnapshotTail,
  });
  assert.strictEqual(gatedAdapter.scheduled[1]?.chunk, postSnapshotTail, signature);
  const staleReady = gatedCoordinator.dispatch({
    type: 'server-ready-latched',
    ...gatedScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-stale',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(staleReady.ignored, true, signature);
  assert.equal(gatedCoordinator.getState(gatedScope)?.currentViewTransactionReady, false, signature);
  const currentReady = gatedCoordinator.dispatch({
    type: 'server-ready-latched',
    ...gatedScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(currentReady.ignored, false, signature);
  assert.equal(gatedCoordinator.getState(gatedScope)?.currentViewTransactionReady, false, signature);
  gatedAdapter.scheduled[1]?.onWritten();
  assert.equal(gatedCoordinator.getState(gatedScope)?.currentViewTransactionReady, true, signature);
  assert.equal(gatedAdapter.readyChanges.filter(({ ready }) => ready).length, 1, signature);
});

test('Frontend stale/resync barrier RED 계약 — AC-5', () => {
  const signature = RED_SIGNATURES.ac5;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const faults = [
    { reason: 'repair-rejected', expectedOutcome: 'fresh-snapshot-started' },
    { reason: 'repair-failed', expectedOutcome: 'fresh-snapshot-started' },
    { reason: 'repair-ack-timeout', expectedOutcome: 'fresh-snapshot-started' },
    { reason: 'repair-reoverflow', expectedOutcome: 'fresh-snapshot-started' },
    { reason: 'parser-incomplete', expectedOutcome: 'reconnect-required' },
    { reason: 'parser-reset-failed', expectedOutcome: 'reconnect-required' },
    { reason: 'authority-unavailable', expectedOutcome: 'authority-unavailable' },
  ] as const;

  for (const fault of faults) {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: 4096,
      maxHeldChunks: 16,
      transportMode: 'unified',
      adapter,
    });
    const scope: RecoveryScope = { clientId: `client-${fault.reason}`, sessionId: 'session-a' };
    beginRecovery(coordinator, scope);
    coordinator.dispatch({
      type: 'recovery-failed',
      ...scope,
      transactionId: 'tx-current',
      repairToken: 'repair-current',
      replayToken: 'replay-current',
      reason: fault.reason,
      connectionGeneration: 7,
      sessionGeneration: 11,
    });

    const state = coordinator.getState(scope);
    assert.equal(state?.currentViewTransactionReady, false, signature);
    assert.equal(state?.staleTerminal, true, signature);
    assert.equal(state?.terminalFailed, true, signature);
    assert.equal(state?.retainedHistoryEquivalent, false, signature);
    assert.equal(adapter.readyChanges.some(({ ready }) => ready), false, signature);
    assert.equal(adapter.successAcks.length, 0, signature);
    assert.equal(
      adapter.outcomes.some(({ outcome, reason }) => (
        outcome === fault.expectedOutcome && reason === fault.reason
      )),
      true,
      signature,
    );
  }

  const silentAdapter = createRecordingRecoveryAdapter();
  const silentCoordinator = factory({
    maxHeldBytes: 4096,
    maxHeldChunks: 16,
    transportMode: 'unified',
    adapter: silentAdapter,
  });
  const silentScope: RecoveryScope = { clientId: 'client-silent', sessionId: 'session-a' };
  beginRecovery(silentCoordinator, silentScope);
  silentCoordinator.dispatch({
    type: 'recovery-failed',
    ...silentScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    reason: '',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const silentState = silentCoordinator.getState(silentScope);
  assert.equal(silentState?.currentViewTransactionReady, false, signature);
  assert.equal(silentState?.staleTerminal, true, signature);
  assert.equal(silentState?.retainedHistoryEquivalent, false, signature);
  assert.equal(silentAdapter.readyChanges.some(({ ready }) => ready), false, signature);
  assert.equal(silentAdapter.successAcks.length, 0, signature);
  assert.equal(
    silentAdapter.outcomes.some(({ outcome }) => (
      outcome === 'fresh-snapshot-started'
      || outcome === 'reconnect-required'
      || outcome === 'authority-unavailable'
    )),
    true,
    signature,
  );
});

test('Frontend stale/resync barrier RED 계약 — AC-10', () => {
  const signature = RED_SIGNATURES.ac10;
  const factory = requireRecoveryCoordinatorFactory(signature);
  for (const transportMode of ['unified', 'split-shadow', 'split'] as const) {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: 64,
      maxHeldChunks: 4,
      transportMode,
      adapter,
    });
    const scope: RecoveryScope = {
      clientId: `client-${transportMode}`,
      sessionId: 'session-a',
    };
    assert.deepEqual(coordinator.getTransportStatus(), {
      requestedTransportMode: transportMode,
      effectiveTransportMode: 'unified',
      splitActivationEnabled: false,
      standaloneSplitParity: 'unresolved',
    }, signature);
    if (transportMode !== 'unified') {
      const started = beginRecovery(coordinator, scope);
      const output = coordinator.dispatch({
        type: 'output-arrived',
        ...scope,
        transactionId: 'tx-current',
        connectionGeneration: 7,
        sessionGeneration: 11,
        chunk: { chunkId: `blocked-${transportMode}`, screenSeq: 1, data: 'blocked' },
      });
      const snapshot = coordinator.dispatch({
        type: 'authoritative-snapshot-applied',
        ...scope,
        transactionId: 'tx-current',
        repairToken: 'repair-current',
        replayToken: 'replay-current',
        snapshotSeq: 0,
        parserBoundary: 'complete',
        connectionGeneration: 7,
        sessionGeneration: 11,
      });
      assert.equal(started.ignored, true, signature);
      assert.equal(output.ignored, true, signature);
      assert.equal(snapshot.ignored, true, signature);
      assert.equal(coordinator.getState(scope), undefined, signature);
      assert.deepEqual(adapter.outcomes, [{
        ...scope,
        outcome: 'standalone-split-unavailable',
        reason: 'split-activation-disabled',
      }], signature);
      assert.equal(adapter.scheduled.length, 0, signature);
      assert.equal(adapter.readyChanges.length, 0, signature);
      assert.equal(adapter.directWrites.length, 0, signature);
      assert.equal(adapter.splitActivations.length, 0, signature);
      continue;
    }
    beginRecovery(coordinator, scope);
    const tail: RecoveryChunk = {
      chunkId: `tail-${transportMode}`,
      screenSeq: 2,
      data: 'bounded-tail',
    };
    coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      chunk: tail,
    });
    coordinator.dispatch({
      type: 'authoritative-snapshot-applied',
      ...scope,
      transactionId: 'tx-current',
      repairToken: 'repair-current',
      replayToken: 'replay-current',
      snapshotSeq: 1,
      parserBoundary: 'complete',
      connectionGeneration: 7,
      sessionGeneration: 11,
    });

    assert.equal(adapter.scheduled.length, 1, signature);
    assert.strictEqual(adapter.scheduled[0]?.chunk, tail, signature);
    assert.equal(adapter.directWrites.length, 0, signature);
    assert.equal(adapter.splitActivations.length, 0, signature);
    assert.equal(coordinator.getState(scope)?.retainedHistoryEquivalent, false, signature);

    adapter.scheduled[0]?.onWritten();
    assert.equal(coordinator.getState(scope)?.currentViewTransactionReady, true, signature);
    assert.equal(adapter.readyChanges.filter(({ ready }) => ready).length, 1, signature);
    assert.equal(adapter.directWrites.length, 0, signature);
    assert.equal(adapter.splitActivations.length, 0, signature);
  }
});

test('visible output recovery seals terminal faults and releases held payloads', () => {
  const factory = requireRecoveryCoordinatorFactory('terminal fault sealing contract');
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 4,
    maxHeldChunks: 2,
    transportMode: 'unified',
    adapter,
  });
  const overflowScope: RecoveryScope = { clientId: 'sealed-overflow', sessionId: 'session-a' };
  beginRecovery(coordinator, overflowScope);
  const firstOutput = {
    type: 'output-arrived',
    ...overflowScope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'first', data: '1234' },
  };
  coordinator.dispatch(firstOutput);
  coordinator.dispatch({
    ...firstOutput,
    chunk: { chunkId: 'overflow', data: 'x' },
  });
  const outcomeCount = adapter.outcomes.length;
  const abortedCount = adapter.aborted.length;
  const postOverflow = coordinator.dispatch({
    ...firstOutput,
    chunk: { chunkId: 'late-after-overflow', data: 'z' },
  });
  assert.equal(postOverflow.ignored, true);
  assert.equal(coordinator.getState(overflowScope)?.terminalFailed, true);
  assert.equal(coordinator.getState(overflowScope)?.heldChunks.length, 0);
  assert.equal(coordinator.getState(overflowScope)?.heldOutputBytes, 0);
  assert.equal(adapter.outcomes.length, outcomeCount);
  assert.equal(adapter.aborted.length, abortedCount);

  const failureScope: RecoveryScope = { clientId: 'sealed-failure', sessionId: 'session-a' };
  beginRecovery(coordinator, failureScope);
  coordinator.dispatch({ ...firstOutput, ...failureScope, chunk: { chunkId: 'held-failure', data: 'raw' } });
  coordinator.dispatch({
    type: 'recovery-failed',
    ...failureScope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    reason: 'parser-reset-failed',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const lateFailureOutput = coordinator.dispatch({
    ...firstOutput,
    ...failureScope,
    chunk: { chunkId: 'late-after-failure', data: 'late' },
  });
  assert.equal(lateFailureOutput.ignored, true);
  assert.equal(coordinator.getState(failureScope)?.terminalFailed, true);
  assert.equal(coordinator.getState(failureScope)?.heldChunks.length, 0);
  assert.equal(coordinator.getState(failureScope)?.heldOutputBytes, 0);

  const closeScope: RecoveryScope = { clientId: 'sealed-close', sessionId: 'session-a' };
  beginRecovery(coordinator, closeScope);
  coordinator.dispatch({ ...firstOutput, ...closeScope, chunk: { chunkId: 'held-close', data: 'raw' } });
  coordinator.dispatch({
    type: 'connection-closed',
    ...closeScope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  assert.equal(coordinator.getState(closeScope)?.terminalFailed, true);
  assert.equal(coordinator.getState(closeScope)?.heldChunks.length, 0);
  assert.equal(coordinator.getState(closeScope)?.heldOutputBytes, 0);
});

test('visible output recovery drops a snapshot-covered late chunk before cap accounting', () => {
  const factory = requireRecoveryCoordinatorFactory('covered late chunk must not cause false overflow');
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 1,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'covered-cap-client', sessionId: 'covered-cap-session' };
  beginRecovery(coordinator, scope, { serverReadyLatched: false });

  coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 10,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'uncovered-at-cap', screenSeq: 11, data: 'x' },
  });
  const coveredLate = coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'covered-late-n-plus-one', screenSeq: 10, data: 'y' },
  });
  const duplicateCoveredLate = coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'covered-late-n-plus-one', screenSeq: 10, data: 'y' },
  });

  assert.equal(coveredLate.ignored, true);
  assert.equal(duplicateCoveredLate.ignored, true);
  assert.equal(coordinator.getState(scope)?.terminalFailed, false);
  assert.equal(coordinator.getState(scope)?.heldOutputBytes, 1);
  assert.deepEqual(coordinator.getState(scope)?.heldChunks.map(chunk => chunk.chunkId), ['uncovered-at-cap']);
  assert.equal(adapter.outcomes.length, 0);
  assert.deepEqual(adapter.scheduled.map(({ chunk }) => chunk.chunkId), ['uncovered-at-cap']);
});

test('visible resync output admission separates tagged recovery from normal live output', () => {
  const signature = 'active resync output must require exact tagged recovery identity and preserve normal live output';
  const classifier = (visibleOutputRecoveryModule as Record<string, unknown>)
    .classifyVisibleResyncOutput;
  assert.equal(typeof classifier, 'function', signature);
  const classify = classifier as (input: {
    activeReplayToken: string;
    outputReplayToken?: string;
    outputChunkId?: string;
    outputScreenSeq?: number;
    matchingServerReadyLatched: boolean;
  }) => string;

  assert.deepEqual([
    classify({
      activeReplayToken: 'replay-current',
      outputReplayToken: 'replay-current',
      outputChunkId: 'recovery-1',
      outputScreenSeq: 11,
      matchingServerReadyLatched: false,
    }),
    classify({
      activeReplayToken: 'replay-current',
      outputReplayToken: 'replay-current',
      outputScreenSeq: 11,
      matchingServerReadyLatched: false,
    }),
    classify({
      activeReplayToken: 'replay-current',
      outputReplayToken: 'replay-old',
      outputChunkId: 'old-1',
      outputScreenSeq: 10,
      matchingServerReadyLatched: false,
    }),
    classify({
      activeReplayToken: 'replay-current',
      outputChunkId: 'live-1',
      outputScreenSeq: 12,
      matchingServerReadyLatched: false,
    }),
    classify({
      activeReplayToken: 'replay-current',
      outputChunkId: 'degraded-before-ready',
      matchingServerReadyLatched: false,
    }),
    classify({
      activeReplayToken: 'replay-current',
      outputChunkId: 'degraded-after-ready',
      matchingServerReadyLatched: true,
    }),
    classify({
      activeReplayToken: 'replay-current',
      matchingServerReadyLatched: false,
    }),
    classify({
      activeReplayToken: 'replay-current',
      matchingServerReadyLatched: true,
    }),
  ], [
    'current-recovery',
    'stale',
    'stale',
    'current-live',
    'stale',
    'current-live',
    'stale',
    'current-live',
  ], signature);
});

test('visible output mutation fence keeps authoritative replacement last', async () => {
  const fence = createVisibleOutputMutationFence();
  const order: string[] = [];
  let releaseLegacy!: () => void;
  const legacyGate = new Promise<void>((resolve) => {
    releaseLegacy = resolve;
  });
  let legacyStarted = false;
  const legacy = fence.runSpeculative(async () => {
    legacyStarted = true;
    await legacyGate;
    order.push('legacy');
    return 'legacy';
  });
  await Promise.resolve();
  assert.equal(legacyStarted, true);

  const authoritative = fence.runAuthoritative(async () => {
    order.push('authoritative');
    return 'authoritative';
  });
  const lateLocal = fence.runSpeculative(async () => {
    order.push('late-local');
    return 'late-local';
  });
  releaseLegacy();

  assert.deepEqual(await legacy, { accepted: true, value: 'legacy' });
  assert.deepEqual(await authoritative, { accepted: true, value: 'authoritative' });
  assert.deepEqual(await lateLocal, { accepted: false });
  assert.deepEqual(order, ['legacy', 'authoritative']);

  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const blocker = fence.runSpeculative(async () => {
    await blockerGate;
    return 'blocker';
  });
  await Promise.resolve();
  const cancelled = fence.runSpeculative(async () => 'must-not-run');
  fence.invalidateSpeculative();
  releaseBlocker();
  assert.deepEqual(await blocker, { accepted: true, value: 'blocker' });
  assert.deepEqual(await cancelled, { accepted: false });
});
