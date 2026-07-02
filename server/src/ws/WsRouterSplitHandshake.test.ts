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
  wsTransportMode?: 'split' | 'split-shadow';
  resourceLimits?: NonNullable<ConstructorParameters<typeof WsRouter>[2]>['resourceLimits'];
} = {}): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'user-1', jti: 'token-1' } }),
  } as unknown as AuthService;
  const sessionManagerStub = {
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    getLastCwd: () => undefined,
    getScreenSnapshot: () => options.snapshot === null ? null : {
      seq: options.snapshot?.seq ?? 1,
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
    writeInput: () => true,
  } as unknown as SessionManager;
  return new WsRouter(authServiceStub, sessionManagerStub, {
    realtime: {
      wsTransportMode: options.wsTransportMode ?? 'split',
    },
    resourceLimits: options.resourceLimits,
  });
}

test('WsRouter split control connection returns group metadata and pair token', () => {
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

test('WsRouter split output connection does not handle subscribe traffic', () => {
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

test('WsRouter split duplicate output connection closes and removes the previous output socket', () => {
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

test('WsRouter split duplicate output connection reroutes queued output before replacement', () => {
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

test('WsRouter split output pairing rejects wrong token, wrong identity, and expired pair token', () => {
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

test('WsRouter split routes terminal output through paired output socket', () => {
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
  const router = createRouter({ snapshot: null });
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
    const controlSentCount = control.sent.length;

    router.routeSessionOutput('session-1', 'fallback');

    assert.equal(control.sent.length, controlSentCount + 1);
    assert.deepEqual(control.sent.at(-1), {
      type: 'output',
      sessionId: 'session-1',
      data: 'fallback',
    });
  } finally {
    router.destroy();
  }
});

test('WsRouter split sends replay snapshot on output and accepts ACK on control', () => {
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

test('WsRouter split recovers replay snapshot on control when output closes before ACK', () => {
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


test('WsRouter split sends screen repair payload on output and accepts repair ACK on control', async () => {
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

test('WsRouter split preserves screen repair queued output behind fallback recovery snapshot', async () => {
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

test('WsRouter split reroutes queued output to control when output socket queue overflows', () => {
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

test('WsRouter split reroutes current output to control when output socket hits hard limit', () => {
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

test('WsRouter split reroutes queued output to control when output socket closes', () => {
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

test('WsRouter split preserves rerouted output behind fallback recovery snapshot', () => {
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
