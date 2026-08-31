import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginRecovery,
  createRecordingRecoveryAdapter,
  requireRecoveryCoordinatorFactory,
  type RecoveryScope,
} from '../helpers/visibleOutputRecoveryContract.ts';

const RED_SIGNATURES = {
  ac1: 'expected byte and chunk N-1/N/N+1 admission matrix to overflow once with zero held accounting',
  ac2: 'expected overflow to discard current generation and publish exactly one fresh recovery',
  ac3: 'expected matching authority ready to wait for ACK and all tail credits in snapshot-tail-ready-input order',
  ac4: 'expected restore snapshot writer to wait for the live scheduler idle fence',
  ac5: 'expected stale same-session view/xterm callbacks timers IME and ACK results to be ignored',
  ac6: 'expected dispose/remount to release bounded grace ownership without queue or timer theft',
  ac7: 'expected replay-generated xterm auto-reply and ACK failure to keep user input blocked or observably rejected',
  ac8: 'expected lost callback FIFO probe or wedged pipeline to remain stale with zero leaked timers/listeners',
  ac10: 'expected production pending escape tail to block ready until authoritative parser completion',
} as const;

const encoder = new TextEncoder();

test('Restore coordinator RED — byte/chunk N-1·N·N+1', () => {
  const signature = RED_SIGNATURES.ac1;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const fixtures = ['', 'A', '한', '😀'];
  const nonEmptyFixtures = fixtures.filter((fixture) => fixture.length > 0);
  const atNData = nonEmptyFixtures.join('');
  const byteLimit = encoder.encode(atNData).byteLength;
  const byteCases = [
    { boundary: 'N-1', data: nonEmptyFixtures.slice(1).join(''), expectedHeldBytes: byteLimit - 1 },
    { boundary: 'N', data: atNData, expectedHeldBytes: byteLimit },
    { boundary: 'N+1', data: `${atNData}A`, expectedHeldBytes: 0 },
  ] as const;
  const byteMatrix = byteCases.map((boundaryCase, caseIndex) => {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: byteLimit,
      maxHeldChunks: fixtures.length + 1,
      transportMode: 'unified',
      adapter,
    });
    const scope: RecoveryScope = {
      clientId: `byte-client-${caseIndex}`,
      sessionId: 'byte-session',
    };
    beginRecovery(coordinator, scope, { viewGeneration: 3, xtermGeneration: 5 });
    const emptyResult = coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      viewGeneration: 3,
      xtermGeneration: 5,
      chunk: { chunkId: `empty-${caseIndex}`, data: fixtures[0] },
    });
    const admission = coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      viewGeneration: 3,
      xtermGeneration: 5,
      chunk: { chunkId: `byte-${boundaryCase.boundary}`, data: boundaryCase.data },
    });
    const state = coordinator.getState(scope) as unknown as Record<string, unknown> | undefined;
    return {
      boundary: boundaryCase.boundary,
      observedBytes: encoder.encode(boundaryCase.data).byteLength,
      admissionIgnored: admission.ignored,
      emptyIgnored: emptyResult.ignored,
      recoveryCount: adapter.freshSnapshots.length,
      heldBytes: state?.heldOutputBytes,
      heldChunks: Array.isArray(state?.heldChunks) ? state.heldChunks.length : undefined,
      viewGeneration: state?.viewGeneration,
      xtermGeneration: state?.xtermGeneration,
    };
  });

  const chunkLimit = nonEmptyFixtures.length;
  const chunkCases = [
    { boundary: 'N-1', chunks: nonEmptyFixtures.slice(0, chunkLimit - 1), expectedHeldChunks: chunkLimit - 1 },
    { boundary: 'N', chunks: nonEmptyFixtures, expectedHeldChunks: chunkLimit },
    { boundary: 'N+1', chunks: [...nonEmptyFixtures, 'A'], expectedHeldChunks: 0 },
  ] as const;
  const chunkMatrix = chunkCases.map((boundaryCase, caseIndex) => {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: encoder.encode(boundaryCase.chunks.join('')).byteLength,
      maxHeldChunks: chunkLimit,
      transportMode: 'unified',
      adapter,
    });
    const scope: RecoveryScope = {
      clientId: `chunk-client-${caseIndex}`,
      sessionId: 'chunk-session',
    };
    beginRecovery(coordinator, scope, { viewGeneration: 13, xtermGeneration: 21 });
    let lastIgnored = true;
    for (const [index, data] of boundaryCase.chunks.entries()) {
      lastIgnored = coordinator.dispatch({
        type: 'output-arrived',
        ...scope,
        transactionId: 'tx-current',
        connectionGeneration: 7,
        sessionGeneration: 11,
        viewGeneration: 13,
        xtermGeneration: 21,
        chunk: { chunkId: `chunk-${caseIndex}-${index}`, data },
      }).ignored;
    }
    const state = coordinator.getState(scope) as unknown as Record<string, unknown>;
    return {
      boundary: boundaryCase.boundary,
      observedChunks: boundaryCase.chunks.length,
      admissionIgnored: lastIgnored,
      recoveryCount: adapter.freshSnapshots.length,
      heldBytes: state.heldOutputBytes,
      heldChunks: Array.isArray(state.heldChunks) ? state.heldChunks.length : undefined,
      viewGeneration: state.viewGeneration,
      xtermGeneration: state.xtermGeneration,
    };
  });

  const inputLimit = encoder.encode('A한😀').byteLength;
  const inputCases = [
    { boundary: 'N-1', data: '한😀', expectedCount: 1, expectedRejected: false },
    { boundary: 'N', data: 'A한😀', expectedCount: 1, expectedRejected: false },
    { boundary: 'N+1', data: 'A한😀A', expectedCount: 0, expectedRejected: true },
  ] as const;
  const inputMatrix = inputCases.map((boundaryCase, caseIndex) => {
    const adapter = createRecordingRecoveryAdapter();
    const coordinator = factory({
      maxHeldBytes: inputLimit,
      maxHeldChunks: 1,
      transportMode: 'unified',
      adapter,
    });
    const scope: RecoveryScope = {
      clientId: `input-client-${caseIndex}`,
      sessionId: 'input-session',
    };
    beginRecovery(coordinator, scope);
    const emptyAdmission = coordinator.dispatch({
      type: 'queued-user-input',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      data: '',
    });
    const admission = coordinator.dispatch({
      type: 'queued-user-input',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      data: boundaryCase.data,
    });
    return {
      boundary: boundaryCase.boundary,
      observedBytes: encoder.encode(boundaryCase.data).byteLength,
      admissionIgnored: admission.ignored,
      emptyIgnored: emptyAdmission.ignored,
      queuedInputCount: (coordinator.getState(scope) as unknown as Record<string, unknown>)
        .queuedInputCount,
      outcomes: adapter.outcomes.map(({ outcome, reason }) => ({ outcome, reason })),
    };
  });

  assert.deepEqual({
    byteMatrix,
    chunkMatrix,
    inputMatrix,
  }, {
    byteMatrix: byteCases.map((boundaryCase) => ({
      boundary: boundaryCase.boundary,
      observedBytes: encoder.encode(boundaryCase.data).byteLength,
      admissionIgnored: false,
      emptyIgnored: true,
      recoveryCount: boundaryCase.boundary === 'N+1' ? 1 : 0,
      heldBytes: boundaryCase.expectedHeldBytes,
      heldChunks: boundaryCase.boundary === 'N+1' ? 0 : 1,
      viewGeneration: 3,
      xtermGeneration: 5,
    })),
    chunkMatrix: chunkCases.map((boundaryCase) => ({
      boundary: boundaryCase.boundary,
      observedChunks: boundaryCase.chunks.length,
      admissionIgnored: false,
      recoveryCount: boundaryCase.boundary === 'N+1' ? 1 : 0,
      heldBytes: boundaryCase.boundary === 'N+1'
        ? 0
        : encoder.encode(boundaryCase.chunks.join('')).byteLength,
      heldChunks: boundaryCase.expectedHeldChunks,
      viewGeneration: 13,
      xtermGeneration: 21,
    })),
    inputMatrix: inputCases.map((boundaryCase) => ({
      boundary: boundaryCase.boundary,
      observedBytes: encoder.encode(boundaryCase.data).byteLength,
      admissionIgnored: false,
      emptyIgnored: true,
      queuedInputCount: boundaryCase.expectedCount,
      outcomes: boundaryCase.expectedRejected
        ? [{ outcome: 'input-rejected', reason: 'queued-input-cap-exceeded' }]
        : [],
    })),
  }, signature);
});

test('Restore coordinator RED — overflow generation discard', () => {
  const signature = RED_SIGNATURES.ac2;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const byteLimit = encoder.encode('A').byteLength;
  const coordinator = factory({
    maxHeldBytes: byteLimit,
    maxHeldChunks: 2,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'overflow-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope, { viewGeneration: 1, xtermGeneration: 1 });
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    chunk: { chunkId: 'overflow-byte', data: 'AA' },
  });
  const late = coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    chunk: { chunkId: 'late-after-overflow', data: 'A' },
  });
  const state = coordinator.getState(scope) as unknown as Record<string, unknown>;

  assert.deepEqual({
    lateIgnored: late.ignored,
    heldBytes: state.heldOutputBytes,
    heldChunks: Array.isArray(state.heldChunks) ? state.heldChunks.length : undefined,
    restoreNeeded: state.restoreNeeded,
    discardedQueueGeneration: state.discardedQueueGeneration,
    recoveryCount: adapter.freshSnapshots.length,
    outcomes: adapter.outcomes.map(({ outcome, reason }) => ({ outcome, reason })),
  }, {
    lateIgnored: true,
    heldBytes: 0,
    heldChunks: 0,
    restoreNeeded: true,
    discardedQueueGeneration: 1,
    recoveryCount: 1,
    outcomes: [{ outcome: 'fresh-snapshot-started', reason: 'byte-cap-exceeded' }],
  }, signature);
});

test('Restore coordinator RED — authority barrier order', () => {
  const signature = RED_SIGNATURES.ac3;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const chronology: string[] = [];
  const queuedInputReleases: string[] = [];
  const originalEnqueue = adapter.enqueueScheduledOutput;
  const originalReady = adapter.setCurrentViewReady;
  const originalAck = adapter.acknowledgeRepairSuccess;
  adapter.enqueueScheduledOutput = (write) => {
    chronology.push(`tail-enqueued:${write.chunk.chunkId}`);
    originalEnqueue(write);
  };
  adapter.setCurrentViewReady = (change) => {
    chronology.push(`ready:${String(change.ready)}`);
    originalReady(change);
  };
  adapter.acknowledgeRepairSuccess = (ack) => {
    chronology.push(`ack-requested:${ack.repairToken}`);
    originalAck(ack);
  };
  Object.assign(adapter, {
    releaseQueuedInput: (input: { data: string }) => {
      chronology.push(`input-released:${input.data}`);
      queuedInputReleases.push(input.data);
    },
  });
  const coordinator = factory({
    maxHeldBytes: encoder.encode('queued-command').byteLength,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'barrier-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope, { serverReadyLatched: false });
  const queuedInput = coordinator.dispatch({
    type: 'queued-user-input',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    data: 'queued-command',
  });
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'held-tail', screenSeq: 42, data: 'tail' },
  });
  const mismatchedReady = coordinator.dispatch({
    type: 'server-ready-latched',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-stale',
    replayToken: 'replay-stale',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const matchingReady = coordinator.dispatch({
    type: 'server-ready-latched',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const scheduledBeforeSnapshot = adapter.scheduled.length;
  chronology.push('snapshot-applied');
  const snapshotApplied = coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 41,
    parserBoundary: 'complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const beforeTail = coordinator.getState(scope)?.currentViewTransactionReady;
  chronology.push('tail-credit:held-tail');
  adapter.scheduled[0]?.onWritten();
  const afterTailBeforeAck = coordinator.getState(scope)?.currentViewTransactionReady;
  const ackResult = coordinator.dispatch({
    type: 'repair-acknowledged',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });

  assert.deepEqual({
    scheduled: adapter.scheduled.map(({ chunk }) => chunk.chunkId),
    scheduledBeforeSnapshot,
    snapshotAppliedIgnored: snapshotApplied.ignored,
    queuedInputIgnored: queuedInput.ignored,
    mismatchedReadyIgnored: mismatchedReady.ignored,
    matchingReadyIgnored: matchingReady.ignored,
    beforeTail,
    afterTailBeforeAck,
    ackIgnored: ackResult.ignored,
    afterAck: coordinator.getState(scope)?.currentViewTransactionReady,
    successAcks: adapter.successAcks.length,
    readyTransitions: adapter.readyChanges.map(({ ready }) => ready),
    queuedInputReleases,
    chronology,
  }, {
    scheduled: ['held-tail'],
    scheduledBeforeSnapshot: 0,
    snapshotAppliedIgnored: false,
    queuedInputIgnored: false,
    mismatchedReadyIgnored: true,
    matchingReadyIgnored: false,
    beforeTail: false,
    afterTailBeforeAck: false,
    ackIgnored: false,
    afterAck: true,
    successAcks: 1,
    readyTransitions: [false, true],
    queuedInputReleases: ['queued-command'],
    chronology: [
      'ready:false',
      'snapshot-applied',
      'tail-enqueued:held-tail',
      'tail-credit:held-tail',
      'ack-requested:repair-current',
      'ready:true',
      'input-released:queued-command',
    ],
  }, signature);
});

test('Restore coordinator RED — live idle fence', () => {
  const signature = RED_SIGNATURES.ac4;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const authoritativeSnapshots: Array<{
    data: string;
    onWritten: () => void;
  }> = [];
  const chronology: string[] = [];
  const originalEnqueue = adapter.enqueueScheduledOutput;
  adapter.enqueueScheduledOutput = (write) => {
    chronology.push(`tail-enqueued:${write.chunk.chunkId}`);
    originalEnqueue(write);
  };
  Object.assign(adapter, {
    enqueueAuthoritativeSnapshot: (write: { data: string; onWritten: () => void }) => {
      chronology.push('snapshot-enqueued');
      authoritativeSnapshots.push(write);
    },
  });
  const coordinator = factory({
    maxHeldBytes: encoder.encode('tail').byteLength,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'idle-fence-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope, { liveSchedulerIdle: false });
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    chunk: { chunkId: 'tail-after-live', screenSeq: 2, data: 'tail' },
  });
  const snapshotReceived = coordinator.dispatch({
    type: 'authoritative-snapshot-received',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 1,
    parserBoundary: 'complete',
    data: 'authoritative-snapshot',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const writesBeforeIdle = {
    snapshots: authoritativeSnapshots.length,
    tails: adapter.scheduled.length,
  };
  const idleResult = coordinator.dispatch({
    type: 'live-lane-idle',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const writesAfterIdle = {
    snapshots: authoritativeSnapshots.length,
    tails: adapter.scheduled.length,
  };
  chronology.push('snapshot-credit');
  authoritativeSnapshots[0]?.onWritten();
  const writesAfterSnapshot = {
    snapshots: authoritativeSnapshots.length,
    tails: adapter.scheduled.length,
  };

  assert.deepEqual({
    snapshotReceivedIgnored: snapshotReceived.ignored,
    writesBeforeIdle,
    idleIgnored: idleResult.ignored,
    writesAfterIdle,
    writesAfterSnapshot,
    chronology,
  }, {
    snapshotReceivedIgnored: false,
    writesBeforeIdle: { snapshots: 0, tails: 0 },
    idleIgnored: false,
    writesAfterIdle: { snapshots: 1, tails: 0 },
    writesAfterSnapshot: { snapshots: 1, tails: 1 },
    chronology: [
      'snapshot-enqueued',
      'snapshot-credit',
      'tail-enqueued:tail-after-live',
    ],
  }, signature);
});

test('Restore coordinator RED — same-session generation fence', () => {
  const signature = RED_SIGNATURES.ac5;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: encoder.encode('stale').byteLength,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'generation-client', sessionId: 'same-session' };
  beginRecovery(coordinator, scope, { viewGeneration: 9, xtermGeneration: 14 });
  const shared = {
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 8,
    xtermGeneration: 13,
  };
  const staleOutput = coordinator.dispatch({
    type: 'output-arrived',
    ...shared,
    chunk: { chunkId: 'stale-view-output', data: 'stale' },
  });
  const staleTimer = coordinator.dispatch({ type: 'write-callback-timeout', ...shared });
  const staleIme = coordinator.dispatch({ type: 'ime-cancelled', ...shared });
  const staleAck = coordinator.dispatch({ type: 'repair-acknowledged', ...shared });
  const state = coordinator.getState(scope) as unknown as Record<string, unknown>;

  assert.deepEqual({
    ignored: [staleOutput.ignored, staleTimer.ignored, staleIme.ignored, staleAck.ignored],
    heldBytes: state.heldOutputBytes,
    viewGeneration: state.viewGeneration,
    xtermGeneration: state.xtermGeneration,
  }, {
    ignored: [true, true, true, true],
    heldBytes: 0,
    viewGeneration: 9,
    xtermGeneration: 14,
  }, signature);
});

test('Restore coordinator RED — dispose/remount ownership', () => {
  const signature = RED_SIGNATURES.ac6;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const scheduledTimers: Array<{ timerId: string }> = [];
  const cancelledTimers: string[] = [];
  Object.assign(adapter, {
    scheduleRestoreTimer: (timer: { timerId: string }) => scheduledTimers.push(timer),
    cancelRestoreTimer: (timerId: string) => cancelledTimers.push(timerId),
  });
  const coordinator = factory({
    maxHeldBytes: encoder.encode('dispose-queued-input').byteLength,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'remount-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope, {
    viewGeneration: 1,
    xtermGeneration: 1,
    serverReadyLatched: false,
  });
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    chunk: { chunkId: 'old-held-output', screenSeq: 2, data: 'old' },
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
    viewGeneration: 1,
    xtermGeneration: 1,
  });
  const oldWriteCallback = adapter.scheduled[0]?.onWritten;
  const queuedBeforeDispose = coordinator.dispatch({
    type: 'queued-user-input',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    data: 'dispose-queued-input',
  });
  const timerArm = coordinator.dispatch({
    type: 'arm-write-timeout',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    timerId: 'old-write-timer',
  });
  const duplicateTimerArm = coordinator.dispatch({
    type: 'arm-write-timeout',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    timerId: 'duplicate-write-timer',
    pendingChunkId: 'old-held-output',
  });
  const wrongTimerTimeout = coordinator.dispatch({
    type: 'write-callback-timeout',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    timerId: 'wrong-write-timer',
    pendingChunkId: 'old-held-output',
  });
  const primedHeldBytes = coordinator.getState(scope)?.heldOutputBytes;
  const primedScheduledWrites = adapter.scheduled.length;
  coordinator.dispatch({
    type: 'dispose',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
  });
  const disposedState = coordinator.getState(scope);
  beginRecovery(coordinator, scope, { viewGeneration: 2, xtermGeneration: 2 });
  oldWriteCallback?.();
  const oldHandler = coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    viewGeneration: 1,
    xtermGeneration: 1,
    chunk: { chunkId: 'old-handler-output', data: 'old' },
  });
  const remounted = coordinator.getState(scope) as unknown as Record<string, unknown>;

  assert.deepEqual({
    primedHeldBytes,
    primedScheduledWrites,
    queuedBeforeDisposeIgnored: queuedBeforeDispose.ignored,
    timerArmIgnored: timerArm.ignored,
    duplicateTimerArmIgnored: duplicateTimerArm.ignored,
    wrongTimerTimeoutIgnored: wrongTimerTimeout.ignored,
    scheduledTimers: scheduledTimers.map(({ timerId }) => timerId),
    disposed: disposedState?.disposed,
    disposedHeldBytes: disposedState?.heldOutputBytes,
    cancelledTimers,
    oldHandlerIgnored: oldHandler.ignored,
    remountReady: remounted.currentViewTransactionReady,
    remountHeldBytes: remounted.heldOutputBytes,
    remountViewGeneration: remounted.viewGeneration,
    remountXtermGeneration: remounted.xtermGeneration,
    activeTimerCount: remounted.activeTimerCount,
    activeListenerCount: remounted.activeListenerCount,
    inputDisposition: adapter.outcomes.map(({ outcome, reason }) => ({ outcome, reason })),
  }, {
    primedHeldBytes: encoder.encode('old').byteLength,
    primedScheduledWrites: 1,
    queuedBeforeDisposeIgnored: false,
    timerArmIgnored: false,
    duplicateTimerArmIgnored: true,
    wrongTimerTimeoutIgnored: true,
    scheduledTimers: ['old-write-timer'],
    disposed: true,
    disposedHeldBytes: 0,
    cancelledTimers: ['old-write-timer'],
    oldHandlerIgnored: true,
    remountReady: false,
    remountHeldBytes: 0,
    remountViewGeneration: 2,
    remountXtermGeneration: 2,
    activeTimerCount: 0,
    activeListenerCount: 1,
    inputDisposition: [{ outcome: 'input-rejected', reason: 'recovery-disposed' }],
  }, signature);
});

test('Restore coordinator RED — replay auto-reply and ACK fault', () => {
  const signature = RED_SIGNATURES.ac7;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const outboundInputs: string[] = [];
  Object.assign(adapter, {
    sendInput: (input: { data: string }) => outboundInputs.push(input.data),
  });
  const coordinator = factory({
    maxHeldBytes: encoder.encode('must-remain-blocked').byteLength,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'replay-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope, { serverReadyLatched: false });
  const autoReply = coordinator.dispatch({
    type: 'xterm-auto-reply',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    data: '\x1b[0n',
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
  coordinator.dispatch({
    type: 'server-ready-latched',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const beforeAckFailure = coordinator.getState(scope)?.currentViewTransactionReady;
  const ackFailure = coordinator.dispatch({
    type: 'repair-ack-failed',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    reason: 'server-ack-failed',
  });
  const queuedInput = coordinator.dispatch({
    type: 'queued-user-input',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    data: 'must-remain-blocked',
  });
  const state = coordinator.getState(scope) as unknown as Record<string, unknown>;
  const retainedQueuedInputCount = state.queuedInputCount;
  beginRecovery(coordinator, scope, {
    transactionId: 'tx-next',
    repairToken: 'repair-next',
    replayToken: 'replay-next',
  });
  const supersededState = coordinator.getState(scope) as unknown as Record<string, unknown>;

  assert.deepEqual({
    autoReplyIgnored: autoReply.ignored,
    beforeAckFailure,
    ackFailureIgnored: ackFailure.ignored,
    afterAckFailure: coordinator.getState(scope)?.currentViewTransactionReady,
    queuedInputIgnored: queuedInput.ignored,
    queuedInputCount: retainedQueuedInputCount,
    supersededQueuedInputCount: supersededState.queuedInputCount,
    directWrites: adapter.directWrites.length,
    outboundInputs,
    observableOutcomes: adapter.outcomes.map(({ outcome, reason }) => ({ outcome, reason })),
  }, {
    autoReplyIgnored: false,
    beforeAckFailure: false,
    ackFailureIgnored: false,
    afterAckFailure: false,
    queuedInputIgnored: false,
    queuedInputCount: 1,
    supersededQueuedInputCount: 0,
    directWrites: 0,
    outboundInputs: [],
    observableOutcomes: [
      { outcome: 'replay-auto-reply-suppressed', reason: 'restore-replay-guard' },
      { outcome: 'fresh-snapshot-started', reason: 'server-ack-failed' },
      { outcome: 'input-rejected', reason: 'recovery-superseded' },
    ],
  }, signature);
});

test('Restore coordinator RED — FIFO probe and leak fence', () => {
  const signature = RED_SIGNATURES.ac8;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const chronology: string[] = [];
  const completionProbes: Array<{
    probeId: string;
    data: string;
    onWritten: () => void;
  }> = [];
  const originalEnqueue = adapter.enqueueScheduledOutput;
  adapter.enqueueScheduledOutput = (write) => {
    chronology.push(`tail:${write.chunk.chunkId}`);
    originalEnqueue(write);
  };
  Object.assign(adapter, {
    enqueueCompletionProbe: (probe: { probeId: string; data: string; onWritten: () => void }) => {
      chronology.push(`probe:${probe.probeId}:${probe.data.length}`);
      completionProbes.push(probe);
    },
  });
  const coordinator = factory({
    maxHeldBytes: encoder.encode('ab').byteLength,
    maxHeldChunks: 2,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'fifo-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope);
  for (const [index, data] of ['a', 'b'].entries()) {
    coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      chunk: { chunkId: `fifo-${index + 1}`, screenSeq: index + 2, data },
    });
  }
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
  adapter.scheduled[1]?.onWritten();
  const probeRequest = coordinator.dispatch({
    type: 'write-callback-timeout',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    pendingChunkId: 'fifo-1',
  });
  const probeTimeout = coordinator.dispatch({
    type: 'completion-probe-timeout',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    probeId: 'fifo-probe-1',
  });
  const state = coordinator.getState(scope) as unknown as Record<string, unknown>;

  assert.deepEqual({
    scheduledOrder: adapter.scheduled.map(({ chunk }) => chunk.chunkId),
    probeRequestIgnored: probeRequest.ignored,
    probes: completionProbes.map(({ probeId, data }) => ({ probeId, data })),
    chronology,
    probeTimeoutIgnored: probeTimeout.ignored,
    staleTerminal: state.staleTerminal,
    currentViewTransactionReady: state.currentViewTransactionReady,
    heldBytes: state.heldOutputBytes,
    heldChunks: Array.isArray(state.heldChunks) ? state.heldChunks.length : undefined,
    activeTimerCount: state.activeTimerCount,
    activeListenerCount: state.activeListenerCount,
    outcomes: adapter.outcomes.map(({ outcome, reason }) => ({ outcome, reason })),
  }, {
    scheduledOrder: ['fifo-1', 'fifo-2'],
    probeRequestIgnored: false,
    probes: [{ probeId: 'fifo-probe-1', data: '' }],
    chronology: ['tail:fifo-1', 'tail:fifo-2', 'probe:fifo-probe-1:0'],
    probeTimeoutIgnored: false,
    staleTerminal: true,
    currentViewTransactionReady: false,
    heldBytes: 0,
    heldChunks: 0,
    activeTimerCount: 0,
    activeListenerCount: 0,
    outcomes: [{ outcome: 'fresh-snapshot-started', reason: 'write-callback-timeout' }],
  }, signature);
});

test('Restore coordinator FIFO proof settles only the submitted pending chunk', () => {
  const signature = 'REL-BGSTAB-009: FIFO proof for chunk A must not claim queued suffix B was submitted or written';
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const completionProbes: Array<{ probeId: string; onWritten: () => void }> = [];
  Object.assign(adapter, {
    enqueueCompletionProbe: (probe: { probeId: string; onWritten: () => void }) => {
      completionProbes.push(probe);
    },
  });
  const coordinator = factory({
    maxHeldBytes: encoder.encode('ab').byteLength,
    maxHeldChunks: 2,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'fifo-suffix-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope);
  for (const [index, data] of ['a', 'b'].entries()) {
    coordinator.dispatch({
      type: 'output-arrived',
      ...scope,
      transactionId: 'tx-current',
      connectionGeneration: 7,
      sessionGeneration: 11,
      chunk: { chunkId: `suffix-${index + 1}`, screenSeq: index + 2, data },
    });
  }
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
  coordinator.dispatch({
    type: 'write-callback-timeout',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    connectionGeneration: 7,
    sessionGeneration: 11,
    pendingChunkId: 'suffix-1',
  });
  adapter.scheduled[0]?.onWritten();
  completionProbes[0]?.onWritten();
  const afterProbe = coordinator.getState(scope) as unknown as Record<string, unknown>;
  const afterProbeObservation = {
    heldBytes: afterProbe.heldOutputBytes,
    heldChunks: Array.isArray(afterProbe.heldChunks) ? afterProbe.heldChunks.length : undefined,
    currentViewTransactionReady: afterProbe.currentViewTransactionReady,
  };
  adapter.scheduled[1]?.onWritten();
  const afterSuffix = coordinator.getState(scope) as unknown as Record<string, unknown>;

  assert.deepEqual({
    scheduledOrder: adapter.scheduled.map(({ chunk }) => chunk.chunkId),
    afterProbe: afterProbeObservation,
    afterSuffix: {
      heldBytes: afterSuffix.heldOutputBytes,
      heldChunks: Array.isArray(afterSuffix.heldChunks) ? afterSuffix.heldChunks.length : undefined,
    },
  }, {
    scheduledOrder: ['suffix-1', 'suffix-2'],
    afterProbe: {
      heldBytes: encoder.encode('b').byteLength,
      heldChunks: 1,
      currentViewTransactionReady: false,
    },
    afterSuffix: {
      heldBytes: 0,
      heldChunks: 0,
    },
  }, signature);
});

test('Restore coordinator RED — authoritative partial escape tail', () => {
  const signature = RED_SIGNATURES.ac10;
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: encoder.encode('\x1b[').byteLength,
    maxHeldChunks: 1,
    transportMode: 'unified',
    adapter,
  });
  const scope: RecoveryScope = { clientId: 'escape-tail-client', sessionId: 'session-a' };
  beginRecovery(coordinator, scope);
  const incompleteSnapshot = coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 9,
    parserBoundary: 'incomplete',
    parserComplete: false,
    pendingEscapeTailAnsi: '\x1b[',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const incompleteState = coordinator.getState(scope) as unknown as Record<string, unknown>;
  const incompleteObserved = {
    snapshotIgnored: incompleteSnapshot.ignored,
    currentViewTransactionReady: incompleteState.currentViewTransactionReady,
    staleTerminal: incompleteState.staleTerminal,
    parserComplete: incompleteState.parserComplete,
    pendingEscapeTailAnsi: incompleteState.pendingEscapeTailAnsi,
  };
  beginRecovery(coordinator, scope, {
    transactionId: 'tx-parser-complete',
    repairToken: 'repair-parser-complete',
    replayToken: 'replay-parser-complete',
    serverReadyLatched: false,
  });
  const completeSnapshot = coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-parser-complete',
    repairToken: 'repair-parser-complete',
    replayToken: 'replay-parser-complete',
    snapshotSeq: 10,
    parserBoundary: 'complete',
    parserComplete: true,
    pendingEscapeTailAnsi: '',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const completeState = coordinator.getState(scope) as unknown as Record<string, unknown>;
  const completeReadyBeforeServer = completeState.currentViewTransactionReady;
  const matchingReady = coordinator.dispatch({
    type: 'server-ready-latched',
    ...scope,
    transactionId: 'tx-parser-complete',
    repairToken: 'repair-parser-complete',
    replayToken: 'replay-parser-complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });
  const completeReadyBeforeAck = coordinator.getState(scope)?.currentViewTransactionReady;
  const completeAck = coordinator.dispatch({
    type: 'repair-acknowledged',
    ...scope,
    transactionId: 'tx-parser-complete',
    repairToken: 'repair-parser-complete',
    replayToken: 'replay-parser-complete',
    connectionGeneration: 7,
    sessionGeneration: 11,
  });

  assert.deepEqual({
    incomplete: incompleteObserved,
    complete: {
      snapshotIgnored: completeSnapshot.ignored,
      readyBeforeServer: completeReadyBeforeServer,
      matchingReadyIgnored: matchingReady.ignored,
      readyBeforeAck: completeReadyBeforeAck,
      ackIgnored: completeAck.ignored,
      currentViewTransactionReady: coordinator.getState(scope)?.currentViewTransactionReady,
      staleTerminal: completeState.staleTerminal,
      parserComplete: completeState.parserComplete,
      pendingEscapeTailAnsi: completeState.pendingEscapeTailAnsi,
    },
    outcomes: adapter.outcomes.map(({ outcome, reason }) => ({ outcome, reason })),
  }, {
    incomplete: {
      snapshotIgnored: false,
      currentViewTransactionReady: false,
      staleTerminal: true,
      parserComplete: false,
      pendingEscapeTailAnsi: '\x1b[',
    },
    complete: {
      snapshotIgnored: false,
      readyBeforeServer: false,
      matchingReadyIgnored: false,
      readyBeforeAck: false,
      ackIgnored: false,
      currentViewTransactionReady: true,
      staleTerminal: false,
      parserComplete: true,
      pendingEscapeTailAnsi: '',
    },
    outcomes: [{ outcome: 'reconnect-required', reason: 'parser-incomplete' }],
  }, signature);
});
