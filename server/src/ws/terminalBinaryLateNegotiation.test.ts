import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

/**
 * Subscribing before negotiating must not strand a session on JSON.
 *
 * Measured against a running server on 2026-09-22, one session each:
 *
 *   negotiate then subscribe -> 1 binary frame, 0 json outputs
 *   subscribe then negotiate -> 0 binary frames, 2 json outputs
 *
 * `openChannel` refuses before the handshake, correctly — there is no agreement
 * yet that the client can read a frame. What was missing is the other half: at
 * the moment the handshake succeeds, the sessions already subscribed never got
 * a channel, and nothing ever went back for them. They stayed on JSON for the
 * life of the connection while `/api/runtime-config` reported `binary`, which is
 * the worst shape a fallback can take — correct behaviour, invisible cost.
 *
 * The browser hits this ordering on every reconnect and restore, so in practice
 * it was the common path rather than the edge case.
 */

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const OFFER = {
  type: 'terminal-binary:negotiate',
  supportedFrameVersions: [1],
  acceptedFlagMask: 0x0001 | 0x0008,
} as const;

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  send(payload: string | Uint8Array, o?: unknown, c?: (e?: Error) => void): void {
    this.sent.push(payload);
    (typeof o === 'function' ? (o as () => void) : c)?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
  texts(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map(s => JSON.parse(s) as Record<string, unknown>);
  }
  binaryCount(): number { return this.sent.filter(s => typeof s !== 'string').length; }
}

function sessionManager(): SessionManager {
  return {
    getSession: (id: string) => ({ id, status: 'running' }),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
    getScreenSnapshot: () => undefined,
    getTerminalAuthorityState: (id: string) => ({
      sessionId: id, streamEpoch: '4', authorityEpoch: 'a',
    }),
  } as unknown as SessionManager;
}

interface Internals {
  clients: Map<WebSocket, WsClientMeta>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  handleSubscribe: (ws: WebSocket, ids: string[]) => void;
  handleTerminalBinaryCapability: (ws: WebSocket, message: unknown) => void;
}

function router(sessionIds: readonly string[]) {
  const instance = new WsRouter({} as AuthService, sessionManager(), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'binary-optin' },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const meta = {
    clientId: 'c1', clientGroupId: 'g1', wsTransportMode: 'unified', isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta;
  const internals = instance as unknown as Internals;
  internals.clients.set(ws, meta);
  for (const id of sessionIds) internals.sessionSubscribers.set(id, new Set([ws]));
  return { instance, socket, ws, internals };
}

function codecFor(socket: FakeWebSocket): 'binary' | 'json' | 'none' {
  if (socket.binaryCount() > 0) return 'binary';
  return socket.texts().some(f => f.type === 'output') ? 'json' : 'none';
}

test('negotiating after subscribing still puts the already-subscribed session on binary', () => {
  const t = router([SESSION_A]);

  t.internals.handleSubscribe(t.ws, [SESSION_A]);
  t.internals.handleTerminalBinaryCapability(t.ws, OFFER);
  t.socket.sent.length = 0;

  t.instance.routeSessionOutput(SESSION_A, 'late', 1);
  assert.equal(codecFor(t.socket), 'binary');
});

test('negotiating before subscribing still works (control)', () => {
  // The order that already worked. Without it, a fix that broke the normal
  // path while repairing the late one would look like a success.
  const t = router([SESSION_A]);

  t.internals.handleTerminalBinaryCapability(t.ws, OFFER);
  t.internals.handleSubscribe(t.ws, [SESSION_A]);
  t.socket.sent.length = 0;

  t.instance.routeSessionOutput(SESSION_A, 'early', 1);
  assert.equal(codecFor(t.socket), 'binary');
});

test('every session subscribed before the handshake is adopted, not just the first', () => {
  const t = router([SESSION_A, SESSION_B]);

  t.internals.handleSubscribe(t.ws, [SESSION_A, SESSION_B]);
  t.internals.handleTerminalBinaryCapability(t.ws, OFFER);

  for (const sessionId of [SESSION_A, SESSION_B]) {
    t.socket.sent.length = 0;
    t.instance.routeSessionOutput(sessionId, 'x', 1);
    assert.equal(codecFor(t.socket), 'binary', `${sessionId} stayed on JSON`);
  }
});

test('adoption announces the channels so the client can route the frames', () => {
  // A frame addressed to a channel the client never heard about is reported as
  // unroutable and dropped, so adopting silently would trade a JSON fallback
  // for lost output — strictly worse.
  const t = router([SESSION_A]);

  t.internals.handleSubscribe(t.ws, [SESSION_A]);
  t.internals.handleTerminalBinaryCapability(t.ws, OFFER);

  const capability = t.socket.texts().find(f => f.type === 'terminal-binary:capability');
  assert.ok(capability, 'the acceptance must still be sent');
  const channels = capability.channels as Array<{ sessionId?: string }> | undefined;
  assert.ok(
    channels?.some(channel => channel.sessionId === SESSION_A),
    `the acceptance must carry the adopted channel: ${JSON.stringify(capability)}`,
  );
});

test('a group that cannot negotiate adopts nothing', () => {
  // Control: adoption must be gated on the handshake succeeding, not on the
  // handler having run.
  const instance = new WsRouter({} as AuthService, sessionManager(), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'json' },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const internals = instance as unknown as Internals;
  internals.clients.set(ws, {
    clientId: 'c1', clientGroupId: 'g1', wsTransportMode: 'unified', isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta);
  internals.sessionSubscribers.set(SESSION_A, new Set([ws]));

  internals.handleSubscribe(ws, [SESSION_A]);
  internals.handleTerminalBinaryCapability(ws, OFFER);
  socket.sent.length = 0;

  instance.routeSessionOutput(SESSION_A, 'x', 1);
  assert.equal(codecFor(socket), 'json');
});
