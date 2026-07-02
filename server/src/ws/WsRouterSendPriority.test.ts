import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WsRouter } from './WsRouter.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';

function createFakeWs(options: { bufferedAmount?: number; deferSendCallbacks?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const pendingCallbacks: Array<() => void> = [];
  let bufferedAmount = options.bufferedAmount ?? 0;
  let closeCode: number | undefined;
  let closeReason: string | undefined;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    send(payload: string, callback?: (error?: Error) => void) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      if (options.deferSendCallbacks && callback) {
        pendingCallbacks.push(() => callback());
        return;
      }
      callback?.();
    },
    ping() {},
    close(code?: number, reason?: string) {
      closeCode = code;
      closeReason = reason;
      (this as { readyState: number }).readyState = 3;
    },
    terminate() {
      (this as { readyState: number }).readyState = 3;
    },
    on() {
      return this;
    },
  } as unknown as import('ws').WebSocket;

  return {
    ws,
    sent,
    setBufferedAmount(value: number) {
      bufferedAmount = value;
    },
    getCloseCode() {
      return closeCode;
    },
    getCloseReason() {
      return closeReason;
    },
    flushNextSendCallback() {
      pendingCallbacks.shift()?.();
    },
  };
}

function createRouter(): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const sessionManagerStub = {
    getSession: (id: string) => ({ id, status: 'running' }),
    getLastCwd: () => undefined,
    isSessionReady: () => true,
    getScreenSnapshot: () => null,
    getReplayQueueLimit: () => 64,
    writeInput: () => true,
    resize: () => true,
  } as unknown as SessionManager;

  return new WsRouter(authServiceStub, sessionManagerStub, {
    inputReliabilityMode: 'queue',
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 1024,
        serverBufferedHardLimitBytes: 2048,
        perClientOutputQueueMaxBytes: 4096,
        perClientControlQueueMaxBytes: 1024,
        outputCoalesceWindowMs: 1,
      } as never,
    },
    stabilityModes: {
      wsSendMode: 'safe-send-enforce',
    },
  });
}

function subscribeForTest(router: WsRouter, ws: import('ws').WebSocket): void {
  (router as unknown as { clients: Map<typeof ws, unknown> }).clients.set(ws, {
    clientId: 'client-1',
    isAlive: true,
    subscribedSessions: new Set(['session-1']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
  (router as unknown as { sessionSubscribers: Map<string, Set<typeof ws>> })
    .sessionSubscribers.set('session-1', new Set([ws]));
}

test('safe-send drains independent control before queued output backlog', () => {
  const router = createRouter();
  const { ws, sent, setBufferedAmount } = createFakeWs({ bufferedAmount: 1500 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'queued-output');
    router.sendTo(ws, { type: 'pong' });
    assert.equal(sent.length, 0);

    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);

    assert.equal(sent[0].type, 'pong');
    assert.equal(sent[1].type, 'output');
    assert.equal(sent[1].data, 'queued-output');
  } finally {
    router.destroy();
  }
});

test('safe-send queues output when projected buffered amount crosses high-water', () => {
  const router = createRouter();
  const { ws, sent } = createFakeWs({ bufferedAmount: 900 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'x'.repeat(400));

    assert.equal(sent.length, 0);
    assert.equal(
      (router.getObservabilitySnapshot() as unknown as { transportQueuedClientCount: number })
        .transportQueuedClientCount,
      1,
    );
  } finally {
    router.destroy();
  }
});

test('safe-send closes when projected buffered amount crosses hard limit', () => {
  const router = createRouter();
  const { ws, sent, getCloseCode, getCloseReason } = createFakeWs({ bufferedAmount: 1900 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'x'.repeat(400));

    assert.equal(sent.length, 0);
    assert.equal(getCloseCode(), 1013);
    assert.match(getCloseReason() ?? '', /hard-limit/i);
  } finally {
    router.destroy();
  }
});

test('safe-send preserves output queued while a previous output send is in flight', () => {
  const router = createRouter();
  const { ws, sent, setBufferedAmount, flushNextSendCallback } = createFakeWs({
    bufferedAmount: 1500,
    deferSendCallbacks: true,
  });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'first-output');
    assert.equal(sent.length, 0);

    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].data, 'first-output');

    router.routeSessionOutput('session-1', 'second-output');
    assert.equal(sent.length, 1);

    flushNextSendCallback();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].data, 'second-output');
    assert.equal(
      (router.getObservabilitySnapshot() as unknown as { transportOutputQueuedBytes: number })
        .transportOutputQueuedBytes,
      0,
    );
  } finally {
    router.destroy();
  }
});

test('safe-send preserves same-session lifecycle ordering behind queued output', () => {
  const router = createRouter();
  const { ws, sent, setBufferedAmount } = createFakeWs({ bufferedAmount: 1500 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'queued-output');
    router.sendSessionEvent('session-1', 'session:exited', { exitCode: 0 });
    assert.equal(sent.length, 0);

    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);

    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'queued-output');
    assert.equal(sent[1].type, 'session:exited');
  } finally {
    router.destroy();
  }
});
