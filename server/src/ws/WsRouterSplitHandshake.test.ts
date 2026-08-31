import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WsRouter } from './WsRouter.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';

function createFakeWs(options: { bufferedAmount?: number } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const socketLike = {
    readyState: 1,
    bufferedAmount: options.bufferedAmount ?? 0,
    send(payload: string, callback?: (error?: Error) => void) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      callback?.();
    },
    ping() {},
    close() {
      socketLike.readyState = 3;
    },
    terminate() {
      socketLike.readyState = 3;
    },
    on(event: string, handler: (...args: any[]) => void) {
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
      return this;
    },
  };
  const ws = socketLike as unknown as import('ws').WebSocket;

  return {
    ws,
    sent,
    getReadyState() {
      return socketLike.readyState;
    },
    setBufferedAmount(value: number) {
      socketLike.bufferedAmount = value;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

function createRouter(options: {
  snapshot?: null | {
    seq: number;
    data: string;
    truncated?: boolean;
    health?: 'healthy' | 'degraded';
  };
  snapshotSeqRef?: { value: number };
  wsTransportMode?: 'split' | 'split-shadow';
  resourceLimits?: NonNullable<ConstructorParameters<typeof WsRouter>[2]>['resourceLimits'];
  recoveryRecords?: Array<Record<string, unknown>>;
} = {}): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'user-1', jti: 'token-1' } }),
  } as unknown as AuthService;
  const sessionManagerStub = {
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    getLastCwd: () => undefined,
    getScreenSnapshot: () => options.snapshot === null ? null : {
      seq: options.snapshotSeqRef?.value ?? options.snapshot?.seq ?? 1,
      cols: 80,
      rows: 24,
      data: options.snapshot?.data ?? 'snapshot-seed',
      truncated: options.snapshot?.truncated ?? false,
      generatedAt: Date.now(),
      health: options.snapshot?.health ?? 'healthy',
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
    },
    getScreenRepair: async (_sessionId: string, expected: { cols: number; rows: number; bufferType: 'normal' | 'alternate' }) => ({
      ok: true as const,
      payload: {
        seq: 2,
        cols: expected.cols,
        rows: expected.rows,
        bufferType: expected.bufferType,
        cursor: { x: 0, y: 0 },
        viewportRows: [{ y: 0, ansi: 'repair-row', text: 'repair-row', wrapped: false }],
        ansiPatch: '\x1b[1;1Hrepair-row',
      },
    }),
    isSessionReady: () => true,
    getReplayQueueLimit: () => 64,
    getScreenRepairQueuePolicy: () => ({
      maxBytes: 64,
      maxChunks: 8,
      source: 'compatibility-cap' as const,
    }),
    writeInput: () => true,
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '1' }),
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      clientId,
      viewGeneration,
      authorityEpoch: 'authority-1',
      leaseGeneration: '1',
    }),
    recordTerminalAuthorityServerRecoveryApplied: (_sessionId: string, input: Record<string, unknown>) => {
      options.recoveryRecords?.push(input);
      return { ok: true };
    },
  } as unknown as SessionManager;
  return new WsRouter(authServiceStub, sessionManagerStub, {
    realtime: {
      wsTransportMode: options.wsTransportMode ?? 'split',
    },
    resourceLimits: options.resourceLimits,
  });
}

test('WsRouter split control connection returns group metadata and pair token', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter();
  const control = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );

    assert.equal(control.sent[0].type, 'connected');
    assert.equal(control.sent[0].wsTransportMode, 'split');
    assert.equal(control.sent[0].channel, 'control');
    assert.equal(control.sent[0].clientId, control.sent[0].clientGroupId);
    assert.equal(typeof control.sent[0].connectionId, 'string');
    assert.equal(typeof control.sent[0].pairToken, 'string');
    assert.equal(typeof control.sent[0].pairTokenExpiresAt, 'number');
  } finally {
    router.destroy();
  }
});

test('WsRouter split output connection does not handle subscribe traffic', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter();
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    assert.equal(output.sent[0].type, 'connected');
    assert.equal(output.sent[0].channel, 'output');
    output.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    assert.equal(output.sent.length, 1);
    output.emit('message', JSON.stringify({ type: 'ping' }));
    assert.equal(output.sent[1].type, 'pong');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 AC-6 old output pair ACK rejection 계약 부재 때문에 실패', () => {
  const router = createRouter();
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);
    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    output.emit('message', JSON.stringify({
      type: 'terminal-delivery:ack',
      sessionId: 'session-1',
      connectionEpoch: 'obsolete-output-pair',
      deliverySeq: 1,
    }));

    assert.deepEqual(control.sent.at(-1), {
      type: 'terminal-delivery:ack-rejected',
      sessionId: 'session-1',
      connectionEpoch: 'obsolete-output-pair',
      deliverySeq: 1,
      reason: 'stale-output-pair',
    });
  } finally {
    router.destroy();
  }
});

test('WsRouter split duplicate output connection closes and removes the previous output socket', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter();
  const control = createFakeWs();
  const firstOutput = createFakeWs();
  const secondOutput = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      firstOutput.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    (router as any).wss.emit(
      'connection',
      secondOutput.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    assert.equal(firstOutput.getReadyState(), 3);
    assert.equal((router as any).clients.has(firstOutput.ws), false);
    assert.equal((router as any).clients.has(secondOutput.ws), true);
  } finally {
    router.destroy();
  }
});

test('WsRouter split duplicate output connection reroutes queued output before replacement', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 65_536,
        serverBufferedHardLimitBytes: 262_144,
        perClientOutputQueueMaxBytes: 65_536,
        outputCoalesceWindowMs: 1000,
      },
    },
  });
  const control = createFakeWs();
  const firstOutput = createFakeWs();
  const secondOutput = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      firstOutput.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const snapshot = firstOutput.sent.find((message) => message.type === 'screen-snapshot');
    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: snapshot?.replayToken,
    }));
    firstOutput.setBufferedAmount(65_536);
    const controlSentCount = control.sent.length;
    const firstOutputSnapshotCount = firstOutput.sent.filter((message) => message.type === 'screen-snapshot').length;

    router.routeSessionOutput('session-1', 'queued-before-replace');
    assert.equal(firstOutput.sent.filter((message) => message.type === 'output').length, 0);

    (router as any).wss.emit(
      'connection',
      secondOutput.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    const rerouted = control.sent.slice(controlSentCount).filter((message) => message.type === 'output');
    assert.equal(rerouted.length, 1);
    assert.equal(rerouted[0].data, 'queued-before-replace');
    const recoverySnapshots = control.sent.slice(controlSentCount).filter((message) => message.type === 'screen-snapshot');
    assert.equal(recoverySnapshots.length, 1);
    assert.equal(firstOutput.sent.filter((message) => message.type === 'screen-snapshot').length, firstOutputSnapshotCount);
    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: recoverySnapshots[0].replayToken,
    }));
    router.routeSessionOutput('session-1', 'after-replace');
    const secondOutputMessages = secondOutput.sent.filter((message) => message.type === 'output');
    assert.equal(secondOutputMessages.length, 1);
    assert.equal(secondOutputMessages[0].data, 'after-replace');
    assert.equal(firstOutput.getReadyState(), 3);
    assert.equal((router as any).clients.has(firstOutput.ws), false);
    assert.equal((router as any).clients.has(secondOutput.ws), true);
  } finally {
    router.destroy();
  }
});

test('WsRouter split output pairing rejects wrong token, wrong identity, and expired pair token', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter();
  const control = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    assert.equal((router as any).isValidSplitOutputPair({
      ok: true,
      requestedMode: 'split',
      channelRole: 'output',
      clientGroupId,
      pairToken: 'wrong-token',
    }, { sub: 'user-1', jti: 'token-1' }), false);

    assert.equal((router as any).isValidSplitOutputPair({
      ok: true,
      requestedMode: 'split',
      channelRole: 'output',
      clientGroupId,
      pairToken,
    }, { sub: 'user-1', jti: 'different-token' }), false);

    const groups = (router as any).splitClientGroups as Map<string, { pairTokenExpiresAt: number }>;
    const group = groups.get(clientGroupId);
    assert.ok(group);
    group.pairTokenExpiresAt = Date.now() - 1;

    assert.equal((router as any).isValidSplitOutputPair({
      ok: true,
      requestedMode: 'split',
      channelRole: 'output',
      clientGroupId,
      pairToken,
    }, { sub: 'user-1', jti: 'token-1' }), false);
    assert.equal(groups.has(clientGroupId), false);
  } finally {
    router.destroy();
  }
});

test('WsRouter split routes terminal output through paired output socket', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({ snapshot: null });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1', 'session-2'] }));
    const controlSentCount = control.sent.length;
    const outputSentCount = output.sent.length;

    router.routeSessionOutput('session-1', 'hello');

    assert.equal(control.sent.length, controlSentCount);
    assert.equal(output.sent.length, outputSentCount + 1);
    assert.deepEqual(output.sent.at(-1), {
      type: 'output',
      sessionId: 'session-1',
      data: 'hello',
    });
  } finally {
    router.destroy();
  }
});

test('WsRouter split falls back to control socket when output socket is absent', () => {
  const router = createRouter({ snapshot: { seq: 11, data: 'history' } });
  const control = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );

    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const snapshot = control.sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(snapshot?.data, 'history');
    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: snapshot?.replayToken,
    }));
    const controlSentCount = control.sent.length;

    router.routeSessionOutput('session-1', 'fallback');

    assert.equal(control.sent.length, controlSentCount + 1);
    assert.deepEqual(control.sent.at(-1), {
      type: 'output',
      sessionId: 'session-1',
      data: 'fallback',
      chunkId: '1',
    });
  } finally {
    router.destroy();
  }
});

test('WsRouter split sends replay snapshot on output and accepts ACK on control', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({ snapshot: { seq: 11, data: 'history' } });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const snapshot = output.sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(snapshot?.type, 'screen-snapshot');
    assert.equal(snapshot?.data, 'history');
    assert.equal(control.sent.some((message) => message.type === 'screen-snapshot'), false);

    router.routeSessionOutput('session-1', 'queued-while-replay-pending');
    assert.equal(output.sent.filter((message) => message.type === 'output').length, 0);

    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: snapshot?.replayToken,
    }));

    const outputs = output.sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'queued-while-replay-pending');
    assert.equal(control.sent.at(-1)?.type, 'session:ready');
  } finally {
    router.destroy();
  }
});

test('WsRouter split recovers replay snapshot on control when output closes before ACK', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({ snapshot: { seq: 11, data: 'history' } });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );

    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    assert.equal(output.sent.some((message) => message.type === 'screen-snapshot'), true);
    assert.equal(control.sent.some((message) => message.type === 'screen-snapshot'), false);

    router.routeSessionOutput('session-1', 'pending-output-after-snapshot');
    output.emit('close');

    const recoveredSnapshots = control.sent.filter((message) => message.type === 'screen-snapshot');
    assert.equal(recoveredSnapshots.length, 1);
    assert.equal(recoveredSnapshots[0].data, 'history');
  } finally {
    router.destroy();
  }
});

test('WsRouter split-shadow output close does not force control replay recovery', () => {
  const router = createRouter({
    snapshot: { seq: 11, data: 'history' },
    wsTransportMode: 'split-shadow',
  });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split-shadow', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split-shadow', channelRole: 'output', clientGroupId, pairToken },
    );

    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const snapshotCountBeforeClose = control.sent.filter((message) => message.type === 'screen-snapshot').length;
    assert.equal(snapshotCountBeforeClose, 1);
    assert.equal(output.sent.some((message) => message.type === 'screen-snapshot'), false);

    output.emit('close');

    const snapshotCountAfterClose = control.sent.filter((message) => message.type === 'screen-snapshot').length;
    assert.equal(snapshotCountAfterClose, snapshotCountBeforeClose);
  } finally {
    router.destroy();
  }
});


test('WsRouter split sends screen repair payload on output and accepts repair ACK on control', { todo: 'Wave-1 production unified limitation characterization' }, async () => {
  const router = createRouter({ snapshot: null });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));

    await (router as any).handleScreenRepairRequest(control.ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    const repair = output.sent.find((message) => message.type === 'screen-repair');
    assert.equal(repair?.type, 'screen-repair');
    assert.equal(control.sent.some((message) => message.type === 'screen-repair'), false);

    router.routeSessionOutput('session-1', 'queued-during-repair');
    assert.equal(output.sent.filter((message) => message.type === 'output').length, 0);

    control.emit('message', JSON.stringify({
      type: 'screen-repair:ready',
      sessionId: 'session-1',
      repairToken: repair?.repairToken,
    }));

    const outputs = output.sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'queued-during-repair');
    assert.equal(control.sent.at(-1)?.type, 'session:ready');
  } finally {
    router.destroy();
  }
});

test('WsRouter split preserves screen repair queued output behind fallback recovery snapshot', { todo: 'Wave-1 production unified limitation characterization' }, async () => {
  const router = createRouter({
    snapshot: {
      seq: 11,
      data: '',
      truncated: false,
      health: 'degraded',
    },
  });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const initialSnapshot = output.sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(initialSnapshot?.mode, 'fallback');

    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: initialSnapshot?.replayToken,
    }));
    const controlSentCount = control.sent.length;

    await (router as any).handleScreenRepairRequest(control.ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = output.sent.find((message) => message.type === 'screen-repair');
    assert.equal(repair?.type, 'screen-repair');

    router.routeSessionOutput('session-1', 'queued-during-repair-before-close');
    assert.equal(control.sent.slice(controlSentCount).some((message) => message.type === 'output'), false);
    assert.equal(output.sent.filter((message) => message.type === 'output').length, 0);

    output.emit('close');

    const recoverySnapshot = control.sent
      .slice(controlSentCount)
      .find((message) => message.type === 'screen-snapshot');
    assert.equal(recoverySnapshot?.mode, 'fallback');

    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: recoverySnapshot?.replayToken,
    }));

    const outputsAfterRecovery = control.sent
      .slice(controlSentCount)
      .filter((message) => message.type === 'output');
    assert.equal(outputsAfterRecovery.length, 1);
    assert.equal(outputsAfterRecovery[0].data, 'queued-during-repair-before-close');
  } finally {
    router.destroy();
  }
});

test('WsRouter split reroutes queued output to control when output socket queue overflows', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({
    snapshot: null,
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 65_536,
        serverBufferedHardLimitBytes: 262_144,
        perClientOutputQueueMaxBytes: 65_536,
        outputCoalesceWindowMs: 1000,
      },
    },
  });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    output.setBufferedAmount(65_536);
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1', 'session-2'] }));
    const controlSentCount = control.sent.length;
    const firstPayload = 'a'.repeat(40_000);
    const secondPayload = 'b'.repeat(40_000);

    router.routeSessionOutput('session-1', firstPayload);
    assert.equal(output.sent.filter((message) => message.type === 'output').length, 0);

    router.routeSessionOutput('session-2', secondPayload);

    const rerouted = control.sent.slice(controlSentCount).filter((message) => message.type === 'output');
    assert.equal(rerouted.length, 2);
    assert.equal(rerouted[0].data, firstPayload);
    assert.equal(rerouted[1].sessionId, 'session-2');
    assert.equal(rerouted[1].data, secondPayload);
    assert.equal(output.getReadyState(), 3);
  } finally {
    router.destroy();
  }
});

test('WsRouter split reroutes current output to control when output socket hits hard limit', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({
    snapshot: null,
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 65_536,
        serverBufferedHardLimitBytes: 65_536,
        perClientOutputQueueMaxBytes: 65_536,
      },
    },
  });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    output.setBufferedAmount(65_536);
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const controlSentCount = control.sent.length;

    router.routeSessionOutput('session-1', 'hard-limit-current');

    const rerouted = control.sent.slice(controlSentCount).filter((message) => message.type === 'output');
    assert.equal(rerouted.length, 1);
    assert.equal(rerouted[0].data, 'hard-limit-current');
    assert.equal(output.getReadyState(), 3);
  } finally {
    router.destroy();
  }
});

test('WsRouter split reroutes queued output to control when output socket closes', {
  todo: 'Wave-3 split client-group routing; Wave 2 preserves the standalone split limitation (REL-BGSTAB-008 AC-10)',
}, () => {
  const router = createRouter({
    snapshot: null,
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 65_536,
        serverBufferedHardLimitBytes: 262_144,
        perClientOutputQueueMaxBytes: 65_536,
        outputCoalesceWindowMs: 1000,
      },
    },
  });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    output.setBufferedAmount(65_536);
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const controlSentCount = control.sent.length;

    router.routeSessionOutput('session-1', 'queued-before-close');
    assert.equal(output.sent.filter((message) => message.type === 'output').length, 0);

    output.emit('close');

    const rerouted = control.sent.slice(controlSentCount).filter((message) => message.type === 'output');
    assert.equal(rerouted.length, 1);
    assert.equal(rerouted[0].data, 'queued-before-close');
  } finally {
    router.destroy();
  }
});

test('WsRouter split preserves rerouted output behind fallback recovery snapshot', { todo: 'Wave-1 production unified limitation characterization' }, () => {
  const router = createRouter({
    snapshot: {
      seq: 11,
      data: '',
      truncated: false,
      health: 'degraded',
    },
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 65_536,
        serverBufferedHardLimitBytes: 262_144,
        perClientOutputQueueMaxBytes: 65_536,
        outputCoalesceWindowMs: 1000,
      },
    },
  });
  const control = createFakeWs();
  const output = createFakeWs();

  try {
    (router as any).wss.emit(
      'connection',
      control.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(control.sent[0].clientGroupId);
    const pairToken = String(control.sent[0].pairToken);

    (router as any).wss.emit(
      'connection',
      output.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    control.emit('message', JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    const initialSnapshot = output.sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(initialSnapshot?.mode, 'fallback');

    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: initialSnapshot?.replayToken,
    }));
    const controlSentCount = control.sent.length;

    output.setBufferedAmount(65_536);
    router.routeSessionOutput('session-1', 'queued-before-fallback-recovery');
    output.emit('close');

    const closeMessages = control.sent.slice(controlSentCount);
    const immediateOutputs = closeMessages.filter((message) => message.type === 'output');
    assert.equal(immediateOutputs.length, 1);
    assert.equal(immediateOutputs[0].data, 'queued-before-fallback-recovery');

    const recoverySnapshot = closeMessages.find((message) => message.type === 'screen-snapshot');
    assert.equal(recoverySnapshot?.mode, 'fallback');

    control.emit('message', JSON.stringify({
      type: 'screen-snapshot:ready',
      sessionId: 'session-1',
      replayToken: recoverySnapshot?.replayToken,
    }));

    const outputsAfterRecovery = control.sent
      .slice(controlSentCount)
      .filter((message) => message.type === 'output');
    assert.equal(outputsAfterRecovery.length, 2);
    assert.equal(outputsAfterRecovery[1].data, 'queued-before-fallback-recovery');
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 authority control reply selects the open socket when a stale duplicate connection remains', () => {
  const router = createRouter();
  const staleControl = createFakeWs();
  const openControl = createFakeWs();
  staleControl.ws.close();

  try {
    (router as any).clients.set(staleControl.ws, {
      channelRole: 'control',
      connectionId: 'reused-connection',
      clientId: 'stale-client',
      wsTransportMode: 'split',
    });
    (router as any).clients.set(openControl.ws, {
      channelRole: 'control',
      connectionId: 'reused-connection',
      clientId: 'current-client',
      wsTransportMode: 'split',
    });

    const result = router.sendTerminalAuthorityFrameToConnection('reused-connection', {
      type: 'terminal-authority:view-attributes-accepted',
      accepted: true,
    }, 'control');

    assert.equal(result.sent, true);
    assert.equal(staleControl.sent.length, 0);
    assert.equal(openControl.sent.at(-1)?.type, 'terminal-authority:view-attributes-accepted');
  } finally {
    (router as any).clients.delete(staleControl.ws);
    (router as any).clients.delete(openControl.ws);
    router.destroy();
  }
});

test('MIG-BGSTAB-002 responder topology requires an open paired output lane only in split mode', () => {
  const router = createRouter();
  const splitControl = createFakeWs();
  const splitOutput = createFakeWs();
  const unifiedControl = createFakeWs();
  const registration = {
    sessionId: 'session-1',
    viewGeneration: 7,
    queryReplyCapability: 'terminal.query-reply-input.v1' as const,
    parserResponderCapability: 'terminal.parser-responder-disable.v1' as const,
    authorityStreamEpoch: '1',
    driverLeaseGeneration: '1',
    acceptedViewAttributesGeneration: '1',
  };

  try {
    (router as any).wss.emit(
      'connection',
      splitControl.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const clientGroupId = String(splitControl.sent[0].clientGroupId);
    const pairToken = String(splitControl.sent[0].pairToken);
    (router as any).wss.emit(
      'connection',
      splitOutput.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'output', clientGroupId, pairToken },
    );
    const splitMeta = (router as any).clients.get(splitControl.ws);
    splitMeta.subscribedSessions = new Set(['session-1']);
    splitMeta.terminalAuthorityViewRegistrations = new Map([['session-1', registration]]);

    (router as any).clients.set(unifiedControl.ws, {
      channelRole: 'unified',
      connectionId: 'unified-connection',
      clientId: 'unified-client',
      wsTransportMode: 'unified',
      subscribedSessions: new Set(['session-1']),
      terminalAuthorityViewRegistrations: new Map([['session-1', { ...registration, viewGeneration: 8 }]]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Set(),
    });

    assert.equal(router.getTerminalAuthorityResponderViews('session-1').length, 2);
    splitOutput.emit('close');
    assert.deepEqual(
      router.getTerminalAuthorityResponderViews('session-1').map(view => view.connectionId),
      ['unified-connection'],
    );
  } finally {
    (router as any).clients.delete(unifiedControl.ws);
    router.destroy();
  }
});

test('MIG-BGSTAB-002 responder topology selects only the newest open hard-reload control socket', () => {
  const router = createRouter();
  const predecessor = createFakeWs();
  const replacement = createFakeWs();
  const registration = (viewGeneration: number) => ({
    sessionId: 'session-1',
    viewGeneration,
    queryReplyCapability: 'terminal.query-reply-input.v1' as const,
    parserResponderCapability: 'terminal.parser-responder-disable.v1' as const,
    authorityStreamEpoch: '1',
    driverLeaseGeneration: '1',
    acceptedViewAttributesGeneration: '1',
  });

  try {
    (router as any).clients.set(predecessor.ws, {
      channelRole: 'control',
      connectionId: 'hard-reload-connection',
      clientId: 'predecessor-client',
      wsTransportMode: 'unified',
      subscribedSessions: new Set(['session-1']),
      terminalAuthorityViewRegistrations: new Map([['session-1', registration(7)]]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Set(),
    });
    (router as any).clients.set(replacement.ws, {
      channelRole: 'control',
      connectionId: 'hard-reload-connection',
      clientId: 'replacement-client',
      wsTransportMode: 'unified',
      subscribedSessions: new Set(['session-1']),
      terminalAuthorityViewRegistrations: new Map([['session-1', registration(8)]]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Set(),
    });

    assert.deepEqual(router.getTerminalAuthorityResponderViews('session-1'), [{
      sessionId: 'session-1',
      clientId: 'replacement-client',
      connectionId: 'hard-reload-connection',
      viewGeneration: 8,
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      authorityStreamEpoch: '1',
      driverLeaseGeneration: '1',
      acceptedViewAttributesGeneration: '1',
    }]);
    const context = router.getTerminalAuthorityCanaryContext('hard-reload-connection');
    assert.ok(context);
    assert.deepEqual(context.subscribedSessions, [{
      sessionId: 'session-1',
      attachedViews: [{
        connectionId: 'hard-reload-connection',
        viewGeneration: 8,
        capable: true,
      }],
      capableViews: router.getTerminalAuthorityResponderViews('session-1'),
      allAttachedViewsCapable: true,
      replayRepairIdle: true,
    }]);
    let ingressCallCount = 0;
    (router as any).terminalAuthorityQueryReplyIngress = {
      handle: () => {
        ingressCallCount += 1;
        return { handled: true, accepted: true };
      },
    };
    assert.equal((router as any).handleTerminalQueryReplyInput(predecessor.ws, {
      type: 'input',
      inputKind: 'query-reply',
      sessionId: 'session-1',
      responderIdentity: {
        connectionId: 'hard-reload-connection',
        viewGeneration: 8,
      },
      replyOrdinal: 0,
      data: '\u001b[0n',
    }), true);
    assert.equal(ingressCallCount, 0, 'the superseded OPEN socket cannot reach query ingress');
    assert.equal(predecessor.sent.at(-1)?.type, 'terminal-authority:query-reply-rejected');
    assert.equal(predecessor.sent.at(-1)?.reason, 'stale-control-socket');
  } finally {
    (router as any).clients.delete(predecessor.ws);
    (router as any).clients.delete(replacement.ws);
    router.destroy();
  }
});

function repairQueueProtocolSplitRedSignature(ac: '2' | '4' | '6' | '9' | '11'): string {
  return (`Repair queue·protocol RED 계약 RED AC-${ac}: 기존 full-flush 기대를 overflow/timeout/failure stale-resync RED로 전환한다. Byte cap은 \`Math.min(runtimePtyConfig.maxSnapshotBytes, 262_144)\`와 \`source=compatibility-cap\`, chunk cap은 \`resourceLimits.headless.pendingOutputMaxChunks\`를 정확히 사용한다. Byte/chunk N-1·N·N+1, snapshot coverage prefix 제거`).slice(0, 320);
}

test('MIG-BGSTAB-002 authoritative replay ACK is backfilled when checkpoint negotiation follows replay', () => {
  const recoveryRecords: Array<Record<string, unknown>> = [];
  const router = createRouter({ recoveryRecords });
  const client = connectRequestedSplitClient(router);
  try {
    assert.equal(recoveryRecords.length, 0, 'pre-negotiation replay ACK must wait for a concrete view generation');
    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId: 'session-1',
        viewGeneration: 7,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    assert.equal(recoveryRecords.length, 1);
    assert.equal(recoveryRecords[0]?.viewGeneration, 7);
    assert.equal(typeof recoveryRecords[0]?.replayToken, 'string');
    assert.equal(recoveryRecords[0]?.snapshotMode, 'authoritative');
    assert.equal(recoveryRecords[0]?.postSnapshotTailDrained, undefined);
    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId: 'session-1',
        viewGeneration: 8,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    assert.equal(recoveryRecords.length, 2,
      'same-connection view replacement must retain the applied replay evidence');
    assert.equal(recoveryRecords[1]?.viewGeneration, 8);
    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [],
    }));
    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId: 'session-1',
        viewGeneration: 9,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    assert.equal(recoveryRecords.length, 2,
      'a removed view must reacquire replay evidence before a later re-registration');
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 queued replay tail requires a fresh zero-tail authoritative ACK', () => {
  const recoveryRecords: Array<Record<string, unknown>> = [];
  const router = createRouter({ recoveryRecords });
  const client = createFakeWs();
  try {
    (router as any).wss.emit(
      'connection',
      client.ws,
      {},
      { sub: 'user-1', jti: 'token-1' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    (router as any).handleSubscribe(client.ws, ['session-1']);
    const initialSnapshot = client.sent.find(message => message.type === 'screen-snapshot');
    assert.equal(initialSnapshot?.mode, 'authoritative');

    router.routeSessionOutput('session-1', 'post-snapshot-tail');
    (router as any).handleScreenSnapshotReady(
      client.ws,
      'session-1',
      String(initialSnapshot?.replayToken),
    );

    const snapshots = client.sent.filter(message => message.type === 'screen-snapshot');
    assert.equal(snapshots.length, 2,
      'ordered tail settlement must reacquire an authoritative browser ACK');
    assert.equal(recoveryRecords.length, 0,
      'an ACK preceding queued tail application cannot prove recovery');

    const refreshedSnapshot = snapshots[1];
    (router as any).handleScreenSnapshotReady(
      client.ws,
      'session-1',
      String(refreshedSnapshot?.replayToken),
    );
    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId: 'session-1',
        viewGeneration: 9,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    assert.equal(recoveryRecords.length, 1);
    assert.equal(recoveryRecords[0]?.queuedOutputBytes, 0);
    assert.equal(recoveryRecords[0]?.queuedOutputTruncated, false);
    assert.equal(recoveryRecords[0]?.viewGeneration, 9);
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 replaced retained model reacquires server recovery ACK before promotion', () => {
  const recoveryRecords: Array<Record<string, unknown>> = [];
  const snapshotSeqRef = { value: 1 };
  const router = createRouter({ recoveryRecords, snapshotSeqRef });
  (router as unknown as {
    terminalAuthorityViewAttributesChallengeReader: () => string;
  }).terminalAuthorityViewAttributesChallengeReader = () => 'view-attributes-challenge-1';
  const client = connectRequestedSplitClient(router);
  pairRequestedSplitClientOutput(router, client);
  try {
    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId: 'session-1',
        viewGeneration: 7,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    assert.equal(recoveryRecords.length, 1);
    snapshotSeqRef.value = 9;

    const refresh = router.refreshTerminalAuthorityServerRecovery('session-1');
    assert.deepEqual(refresh, { ok: true, refreshedViewCount: 1 });
    const refreshedCapability = client.sent
      .slice()
      .reverse()
      .find(message => message.type === 'terminal-checkpoint:capability');
    assert.equal(
      (refreshedCapability?.mutationLeases as Array<Record<string, unknown>> | undefined)?.[0]
        ?.leaseGeneration,
      '1',
    );
    const snapshots = client.sent.filter(message => message.type === 'screen-snapshot');
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1]?.seq, 9);

    client.emit('message', JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId: 'session-1',
        viewGeneration: 8,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    assert.equal(
      recoveryRecords.length,
      1,
      'a replaced model must not backfill the previous model recovery ACK during renegotiation',
    );

    (router as any).handleScreenSnapshotReady(
      client.ws,
      'session-1',
      String(snapshots[1]?.replayToken),
    );
    assert.equal(recoveryRecords.length, 2);
    assert.equal(recoveryRecords[1]?.viewGeneration, 8);
    assert.equal(recoveryRecords[1]?.snapshotSeq, 9);
    assert.equal(recoveryRecords[1]?.queuedOutputBytes, 0);
  } finally {
    router.destroy();
  }
});

function hasSplitRestoreNeeded(messages: Array<Record<string, unknown>>): boolean {
  return messages.some(message => (
    message.type === 'screen-repair:restore-needed'
    || message.type === 'restore-needed'
    || message.state === 'stale'
    || message.outcome === 'restore-needed'
  ));
}

function connectRequestedSplitClient(router: WsRouter) {
  const client = createFakeWs();
  (router as any).wss.emit(
    'connection',
    client.ws,
    {},
    { sub: 'user-1', jti: 'token-1' },
    { ok: true, requestedMode: 'split', channelRole: 'control' },
  );
  (router as any).handleSubscribe(client.ws, ['session-1']);
  const snapshot = client.sent.find(message => message.type === 'screen-snapshot');
  assert.equal(snapshot?.type, 'screen-snapshot');
  (router as any).handleScreenSnapshotReady(client.ws, 'session-1', String(snapshot?.replayToken));
  return client;
}

function pairRequestedSplitClientOutput(
  router: WsRouter,
  control: ReturnType<typeof createFakeWs>,
): ReturnType<typeof createFakeWs> {
  const connected = control.sent.find(message => message.type === 'connected');
  assert.equal(typeof connected?.clientGroupId, 'string');
  assert.equal(typeof connected?.pairToken, 'string');
  const output = createFakeWs();
  (router as any).wss.emit(
    'connection',
    output.ws,
    {},
    { sub: 'user-1', jti: 'token-1' },
    {
      ok: true,
      requestedMode: 'split',
      channelRole: 'output',
      clientGroupId: String(connected?.clientGroupId),
      pairToken: String(connected?.pairToken),
    },
  );
  assert.equal(output.sent[0]?.channel, 'output');
  return output;
}

async function beginSplitScreenRepair(
  router: WsRouter,
  client: ReturnType<typeof createFakeWs>,
): Promise<Record<string, unknown>> {
  const before = client.sent.length;
  await (router as any).handleScreenRepairRequest(client.ws, {
    type: 'screen-repair',
    sessionId: 'session-1',
    cols: 80,
    rows: 24,
    reason: 'manual',
    clientAtBottom: true,
    clientBufferType: 'normal',
  });
  const repair = client.sent.slice(before).find(message => message.type === 'screen-repair');
  assert.equal(repair?.type, 'screen-repair');
  return repair;
}

test('Repair queue·protocol RED 계약 — AC-2', async () => {
  const router = createRouter();
  const client = connectRequestedSplitClient(router);
  try {
    const repair = await beginSplitScreenRepair(router, client);
    const beforeDrain = client.sent.length;
    router.routeSessionOutput('session-1', 'snapshot-covered', 2);
    router.routeSessionOutput('session-1', 'tail-a', 3);
    router.routeSessionOutput('session-1', 'tail-b', 4);
    assert.equal(client.sent.length, beforeDrain);

    (router as any).handleScreenRepairReady(client.ws, 'session-1', String(repair.repairToken));
    const drained = client.sent.slice(beforeDrain);
    const outputChunks = drained.filter(message => message.type === 'output').map(message => message.data);
    const readyIndex = drained.findIndex(message => message.type === 'session:ready');
    const lastOutputIndex = drained.map(message => message.type).lastIndexOf('output');

    assert.deepEqual({
      outputChunks,
      readyAfterDrain: readyIndex > lastOutputIndex && lastOutputIndex >= 0,
      exactlyOnce: outputChunks.length === new Set(outputChunks).size,
    }, {
      outputChunks: ['tail-a', 'tail-b'],
      readyAfterDrain: true,
      exactlyOnce: true,
    }, repairQueueProtocolSplitRedSignature('2'));
  } finally {
    router.destroy();
  }
});

test('Repair queue·protocol RED 계약 — AC-4', async () => {
  const snapshotSeqRef = { value: 1 };
  const router = createRouter({ snapshotSeqRef });
  const client = connectRequestedSplitClient(router);
  try {
    await beginSplitScreenRepair(router, client);
    snapshotSeqRef.value = 4;
    const overflowBefore = client.sent.length;
    router.routeSessionOutput('session-1', 'a'.repeat(60), 3);
    router.routeSessionOutput('session-1', 'b'.repeat(10), 5);
    const overflowMessages = client.sent.slice(overflowBefore);
    const freshSnapshot = overflowMessages.find(message => message.type === 'screen-snapshot');
    let freshBarrierObserved = false;
    let freshTail: unknown[] = [];
    let freshReadyAfterTail = false;
    let freshExactlyOnce = false;
    if (freshSnapshot) {
      const freshBefore = client.sent.length;
      router.routeSessionOutput('session-1', 'c'.repeat(60), 4);
      router.routeSessionOutput('session-1', 'post-snapshot-tail-a', 5);
      router.routeSessionOutput('session-1', 'post-snapshot-tail-b', 6);
      const freshBeforeAck = client.sent.slice(freshBefore);
      const freshOutputHeldBeforeAck = freshBeforeAck.every(message => message.type !== 'output');
      const freshReadyHeldBeforeAck = freshBeforeAck.every(message => message.type !== 'session:ready');
      (router as any).handleScreenSnapshotReady(
        client.ws,
        'session-1',
        String(freshSnapshot.replayToken),
      );
      const freshMessages = client.sent.slice(freshBefore);
      freshTail = freshMessages.filter(message => message.type === 'output').map(message => message.data);
      const readyIndex = freshMessages.findIndex(message => message.type === 'session:ready');
      const lastOutputIndex = freshMessages.map(message => message.type).lastIndexOf('output');
      freshReadyAfterTail = readyIndex > lastOutputIndex && lastOutputIndex >= 0;
      freshExactlyOnce = freshTail.length === new Set(freshTail).size;
      freshBarrierObserved = freshOutputHeldBeforeAck && freshReadyHeldBeforeAck;
    }

    const incompleteRepair = await beginSplitScreenRepair(router, client).catch(() => null);
    const incompleteBefore = client.sent.length;
    if (incompleteRepair) {
      router.routeSessionOutput('session-1', '\x1b[38;2;255', 7);
      (router as any).handleScreenRepairFailed(
        client.ws,
        'session-1',
        String(incompleteRepair.repairToken),
        'parse-failed',
      );
    }
    const incompleteMessages = client.sent.slice(incompleteBefore);

    assert.deepEqual({
      overflowOutputCount: overflowMessages.filter(message => message.type === 'output').length,
      overflowRestoreNeeded: hasSplitRestoreNeeded(overflowMessages),
      freshTransactionStarted: freshSnapshot?.type === 'screen-snapshot',
      freshBarrierObserved,
      freshTail,
      freshReadyAfterTail,
      freshExactlyOnce,
      incompleteOutputCount: incompleteMessages.filter(message => message.type === 'output').length,
      incompleteReadyCount: incompleteMessages.filter(message => message.type === 'session:ready').length,
      incompleteNonReadyRecovery: hasSplitRestoreNeeded(incompleteMessages)
        || incompleteMessages.some(message => (
          message.type === 'screen-repair:reconnect-required'
          || message.outcome === 'authority-unavailable'
        )),
    }, {
      overflowOutputCount: 0,
      overflowRestoreNeeded: true,
      freshTransactionStarted: true,
      freshBarrierObserved: true,
      freshTail: ['b'.repeat(10), 'post-snapshot-tail-a', 'post-snapshot-tail-b'],
      freshReadyAfterTail: true,
      freshExactlyOnce: true,
      incompleteOutputCount: 0,
      incompleteReadyCount: 0,
      incompleteNonReadyRecovery: true,
    }, repairQueueProtocolSplitRedSignature('4'));
  } finally {
    router.destroy();
  }
});

test('Repair queue·protocol RED 계약 — AC-6', async () => {
  const router = createRouter();
  const oldClient = connectRequestedSplitClient(router);
  try {
    const oldReplayToken = String(oldClient.sent.find(message => message.type === 'screen-snapshot')?.replayToken);
    const oldRepair = await beginSplitScreenRepair(router, oldClient);
    router.routeSessionOutput('session-1', 'held-for-old-connection', 3);
    const oldSentBeforeClose = oldClient.sent.length;
    const oldAckOkBefore = router.getObservabilitySnapshot().recentReplayEvents.filter(event => (
      event.kind === 'screen_repair_ack_ok' && event.repairToken === oldRepair.repairToken
    )).length;

    oldClient.ws.close();
    oldClient.emit('close');
    const newClient = connectRequestedSplitClient(router);
    const newRepair = await beginSplitScreenRepair(router, newClient);
    router.routeSessionOutput('session-1', 'held-for-new-connection', 4);
    const newMeta = (router as any).clients.get(newClient.ws);
    const newPendingBefore = newMeta?.screenRepairPendingSessions?.get('session-1');
    const newChunksRef = newPendingBefore?.queuedOutputChunks;
    const newChunksBefore = newChunksRef?.map((chunk: { data?: string; screenSeq?: number }) => ({
      data: chunk.data,
      screenSeq: chunk.screenSeq,
    }));
    const newBytesBefore = newPendingBefore?.queuedOutputBytes;
    const newSentBeforeCallbacks = newClient.sent.length;

    (router as any).handleScreenSnapshotReady(oldClient.ws, 'session-1', oldReplayToken);
    (router as any).handleScreenSnapshotReady(oldClient.ws, 'session-1', oldReplayToken);
    (router as any).handleScreenRepairReady(oldClient.ws, 'session-1', String(oldRepair.repairToken));
    (router as any).handleScreenRepairReady(oldClient.ws, 'session-1', String(oldRepair.repairToken));
    (router as any).handleScreenRepairFailed(oldClient.ws, 'session-1', String(oldRepair.repairToken), 'write-failed');
    (router as any).handleScreenRepairAckTimeout(
      oldClient.ws,
      'session-1',
      String(oldRepair.repairToken),
      Number(oldRepair.seq),
    );

    const newPendingAfter = (router as any).clients
      .get(newClient.ws)
      ?.screenRepairPendingSessions
      ?.get('session-1');
    const oldAckOkAfter = router.getObservabilitySnapshot().recentReplayEvents.filter(event => (
      event.kind === 'screen_repair_ack_ok' && event.repairToken === oldRepair.repairToken
    )).length;
    assert.deepEqual({
      oldClientDisposed: !(router as any).clients.has(oldClient.ws),
      oldOutputReleasedAfterClose: oldClient.sent.slice(oldSentBeforeClose).some(message => message.type === 'output'),
      oldAckOkCount: oldAckOkAfter - oldAckOkBefore,
      currentTransactionReferencePreserved: newPendingAfter === newPendingBefore,
      currentHeldChunksReferencePreserved: newPendingAfter?.queuedOutputChunks === newChunksRef,
      currentHeldChunksPreserved: newPendingAfter?.queuedOutputChunks?.map(
        (chunk: { data?: string; screenSeq?: number }) => ({ data: chunk.data, screenSeq: chunk.screenSeq }),
      ),
      currentBytesPreserved: newPendingAfter?.queuedOutputBytes === newBytesBefore,
      currentMessagesUnchanged: newClient.sent.length === newSentBeforeCallbacks,
      currentReadyUnchanged: newClient.sent.slice(newSentBeforeCallbacks).some(message => message.type === 'session:ready'),
      currentStaleUnchanged: hasSplitRestoreNeeded(newClient.sent.slice(newSentBeforeCallbacks)),
      currentRepairTokenPreserved: newPendingAfter?.repairToken === newRepair.repairToken,
    }, {
      oldClientDisposed: true,
      oldOutputReleasedAfterClose: false,
      oldAckOkCount: 0,
      currentTransactionReferencePreserved: true,
      currentHeldChunksReferencePreserved: true,
      currentHeldChunksPreserved: newChunksBefore,
      currentBytesPreserved: true,
      currentMessagesUnchanged: true,
      currentReadyUnchanged: false,
      currentStaleUnchanged: false,
      currentRepairTokenPreserved: true,
    }, repairQueueProtocolSplitRedSignature('6'));
  } finally {
    router.destroy();
  }
});

test('Repair queue·protocol RED 계약 — AC-9', async () => {
  const router = createRouter({ snapshotSeqRef: { value: 77 } });
  const client = connectRequestedSplitClient(router);
  try {
    const repair = await beginSplitScreenRepair(router, client);
    const rawSecret = '\x1b[31mRAW_SECRET_PAYLOAD\x1b[0m';
    router.routeSessionOutput('session-1', rawSecret.repeat(4), 77);
    const event = [...router.getObservabilitySnapshot().recentReplayEvents]
      .reverse()
      .find(item => item.kind === 'screen_repair_queue_overflow');
    const serializedTelemetry = JSON.stringify(router.getObservabilitySnapshot());

    assert.equal(serializedTelemetry.includes('RAW_SECRET_PAYLOAD'), false);
    assert.equal(serializedTelemetry.includes('\x1b[31m'), false);
    assert.deepEqual({
      repairToken: event?.repairToken,
      sourceSequence: event?.details?.sourceSequence,
      screenSequence: event?.snapshotSeq,
      queuedBytes: event?.details?.queuedBytes,
      queuedChunks: event?.details?.queuedChunks,
      reason: event?.details?.reason,
      outcome: event?.details?.outcome,
      source: event?.details?.source,
    }, {
      repairToken: repair.repairToken,
      sourceSequence: 77,
      screenSequence: 2,
      queuedBytes: 0,
      queuedChunks: 0,
      reason: 'byte-cap-exceeded',
      outcome: 'restore-needed',
      source: 'compatibility-cap',
    }, repairQueueProtocolSplitRedSignature('9'));
  } finally {
    router.destroy();
  }
});

async function observeSplitFaultMatrixCase(
  fault: 'timeout' | 'failure' | 'reoverflow' | 'closed' | 'incomplete-parser',
): Promise<{
  outputCount: number;
  readyCount: number;
  restoreNeeded: boolean;
  reconnectRequired: boolean;
  overflowCount: number;
  clientDisposed: boolean;
}> {
  const router = createRouter({
    snapshotSeqRef: { value: fault === 'reoverflow' ? 6 : 1 },
  });
  const client = connectRequestedSplitClient(router);
  try {
    const overflowEventsBefore = router.getObservabilitySnapshot().recentReplayEvents
      .filter(event => event.kind === 'screen_repair_queue_overflow').length;
    const repair = await beginSplitScreenRepair(router, client);
    const before = client.sent.length;
    if (fault === 'reoverflow') {
      router.routeSessionOutput('session-1', 'a'.repeat(60), 3);
      router.routeSessionOutput('session-1', 'b'.repeat(10), 4);
      const firstFreshSnapshot = client.sent.slice(before).find(message => message.type === 'screen-snapshot');
      if (firstFreshSnapshot) {
        (router as any).handleScreenSnapshotReady(
          client.ws,
          'session-1',
          String(firstFreshSnapshot.replayToken),
        );
      }
      const secondRepair = await beginSplitScreenRepair(router, client).catch(() => null);
      if (secondRepair) {
        router.routeSessionOutput('session-1', 'c'.repeat(60), 5);
        router.routeSessionOutput('session-1', 'd'.repeat(10), 6);
      }
    } else {
      router.routeSessionOutput('session-1', fault === 'incomplete-parser' ? '\x1b[31' : 'held-output', 3);
      if (fault === 'timeout') {
        (router as any).handleScreenRepairAckTimeout(client.ws, 'session-1', String(repair.repairToken), Number(repair.seq));
      } else if (fault === 'failure' || fault === 'incomplete-parser') {
        (router as any).handleScreenRepairFailed(
          client.ws,
          'session-1',
          String(repair.repairToken),
          fault === 'failure' ? 'write-failed' : 'parse-failed',
        );
      } else if (fault === 'closed') {
        client.ws.close();
        client.emit('close');
        (router as any).handleScreenRepairReady(client.ws, 'session-1', String(repair.repairToken));
      }
    }
    const messages = client.sent.slice(before);
    const overflowCount = router.getObservabilitySnapshot().recentReplayEvents
      .filter(event => event.kind === 'screen_repair_queue_overflow').length - overflowEventsBefore;
    return {
      outputCount: messages.filter(message => message.type === 'output').length,
      readyCount: messages.filter(message => message.type === 'session:ready').length,
      restoreNeeded: hasSplitRestoreNeeded(messages),
      reconnectRequired: messages.some(message => (
        message.type === 'screen-repair:reconnect-required'
        || message.outcome === 'authority-unavailable'
      )),
      overflowCount,
      clientDisposed: !(router as any).clients.has(client.ws),
    };
  } finally {
    router.destroy();
  }
}

test('Repair queue·protocol RED 계약 — AC-11', async () => {
  const faults = ['timeout', 'failure', 'reoverflow', 'closed', 'incomplete-parser'] as const;
  const observed = Object.fromEntries(await Promise.all(
    faults.map(async fault => [fault, await observeSplitFaultMatrixCase(fault)]),
  ));
  const expected = Object.fromEntries(faults.map(fault => [fault, {
    outputCount: 0,
    readyCount: fault === 'reoverflow' ? 1 : 0,
    restoreNeeded: fault !== 'closed' && fault !== 'incomplete-parser',
    reconnectRequired: fault === 'incomplete-parser',
    overflowCount: fault === 'reoverflow' ? 2 : 0,
    clientDisposed: fault === 'closed',
  }]));

  assert.deepEqual(observed, expected, repairQueueProtocolSplitRedSignature('11'));
});
