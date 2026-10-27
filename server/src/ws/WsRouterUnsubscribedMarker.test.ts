import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

// REL-BGSTAB-055 AC-3: a browser that resubscribes one session on the open socket drops
// that session's frames until it knows the server has processed the unsubscribe. The
// server's new snapshot is sent before its `subscribed` reply, so `subscribed` cannot be
// that point; an `unsubscribed` reply sent at the end of the unsubscribe is.

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: Array<Record<string, unknown>> = [];
  send(payload: string, callback?: (error?: Error) => void): void {
    this.frames.push(JSON.parse(payload) as Record<string, unknown>);
    callback?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

interface RouterInternals {
  clients: Map<WebSocket, WsClientMeta>;
  handleMessage: (ws: WebSocket, raw: string) => void;
}

function setup() {
  const sessionManager = {
    getSession: (id: string) => ({ id, status: 'running' }),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
    getScreenSnapshot: () => undefined,
  } as unknown as SessionManager;
  const router = new WsRouter({} as AuthService, sessionManager, {
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'json' },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  (router as unknown as RouterInternals).clients.set(ws, {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta);
  const send = (message: unknown) => (router as unknown as RouterInternals).handleMessage(ws, JSON.stringify(message));
  return { socket, send };
}

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-3: an unsubscribe is answered with one unsubscribed reply per session', () => {
  const { socket, send } = setup();
  send({ type: 'subscribe', sessionIds: ['s1'] });
  socket.frames.length = 0;

  send({ type: 'unsubscribe', sessionIds: ['s1', 's2'] });

  // One reply per session, each carrying a top-level sessionId so it travels on that
  // session's ordered lane instead of overtaking its queued frames on the control lane.
  assert.deepEqual(socket.frames.filter(f => f.type === 'unsubscribed'), [
    { type: 'unsubscribed', sessionId: 's1' },
    { type: 'unsubscribed', sessionId: 's2' },
  ]);
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-3: on a resubscribe the unsubscribed reply comes before every frame of the new subscription', () => {
  const { socket, send } = setup();
  send({ type: 'subscribe', sessionIds: ['s1'] });
  socket.frames.length = 0;

  send({ type: 'unsubscribe', sessionIds: ['s1'] });
  send({ type: 'subscribe', sessionIds: ['s1'] });

  const types = socket.frames.map(f => f.type);
  const marker = types.indexOf('unsubscribed');
  assert.notEqual(marker, -1, `no unsubscribed reply in ${types.join(',')}`);
  assert.ok(marker < types.indexOf('subscribed'), types.join(','));
});

function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.filter(line => line.startsWith('[WS] Session resubscribe'));
}

// @req REL-BGSTAB-056
test('REL-BGSTAB-056 AC-1: a recovery unsubscribe logs its reason and attempt; a plain one logs nothing', () => {
  const { send } = setup();
  send({ type: 'subscribe', sessionIds: ['s1'] });

  const recovery = captureLog(() => send({
    type: 'unsubscribe',
    sessionIds: ['s1'],
    recovery: { reason: `screen-repair\n"x"${'y'.repeat(200)}`, attempt: 2 },
  }));
  assert.equal(recovery.length, 1, recovery.join('\n'));
  const match = /^\[WS\] Session resubscribe: client-1 session=s1 reason="(.*)" attempt=2$/.exec(recovery[0]);
  assert.ok(match, recovery[0]);
  assert.ok(match[1].startsWith('screen-repairx'), match[1]);
  assert.ok(Buffer.byteLength(match[1]) <= 123);

  send({ type: 'subscribe', sessionIds: ['s1'] });
  assert.deepEqual(captureLog(() => send({ type: 'unsubscribe', sessionIds: ['s1'] })), []);
});

// @req REL-BGSTAB-056
test('REL-BGSTAB-056 AC-1: only sessions this socket subscribed are logged, and the attempt must be a whole number', () => {
  const { send } = setup();
  send({ type: 'subscribe', sessionIds: ['s1'] });

  const lines = captureLog(() => send({
    type: 'unsubscribe',
    sessionIds: ['s1', 'x\n[WS] Client connected: forged', 'never-subscribed'],
    recovery: { reason: 'r', attempt: -1.5 },
  }));
  assert.deepEqual(lines, ['[WS] Session resubscribe: client-1 session=s1 reason="r" attempt=-']);
});
