import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

/**
 * MIG-BGSTAB-004 AC-3/AC-4/AC-7/AC-8: what the default flip must not break.
 *
 * AC-4 is the one with an implementation gap. A global kill switch already
 * exists (`applyTerminalWireFormat('json')`), but "demote one session" did not,
 * and the difference matters: with 24 sessions on one socket, a single session
 * whose client cannot read its frames must not take the other 23 down with it.
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
  terminalBinaryGroups: Map<string, { codecEpoch: number; isNegotiated: boolean }>;
}

function twoSessionRouter() {
  const router = new WsRouter({} as AuthService, sessionManager(), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'binary-optin' },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const meta = {
    clientId: 'c1', clientGroupId: 'g1', wsTransportMode: 'unified', isAlive: true,
    subscribedSessions: new Set([SESSION_A, SESSION_B]),
    replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta;
  const internals = router as unknown as Internals;
  internals.clients.set(ws, meta);
  internals.sessionSubscribers.set(SESSION_A, new Set([ws]));
  internals.sessionSubscribers.set(SESSION_B, new Set([ws]));
  internals.handleTerminalBinaryCapability(ws, OFFER);
  internals.handleSubscribe(ws, [SESSION_A, SESSION_B]);
  socket.sent.length = 0;
  return { router, socket, ws, internals };
}

function codecOf(socket: FakeWebSocket): 'binary' | 'json' | 'none' {
  if (socket.binaryCount() > 0) return 'binary';
  return socket.texts().some(f => f.type === 'output') ? 'json' : 'none';
}

test('MIG-BGSTAB-004 AC-4 both sessions speak binary before any kill switch', () => {
  // Precondition, stated as a test: every assertion below is about a change
  // from this state, and without it they would also pass on a broken setup.
  const t = twoSessionRouter();
  t.router.routeSessionOutput(SESSION_A, 'a1', 1);
  assert.equal(codecOf(t.socket), 'binary');
  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_B, 'b1', 1);
  assert.equal(codecOf(t.socket), 'binary');
});

test('MIG-BGSTAB-004 AC-4 the session kill switch demotes one session and leaves the others binary', () => {
  const t = twoSessionRouter();

  t.router.demoteTerminalBinarySession(SESSION_A, 'operator-kill-switch');

  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_A, 'a2', 2);
  assert.equal(codecOf(t.socket), 'json', 'the demoted session must fall back');

  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_B, 'b2', 2);
  assert.equal(codecOf(t.socket), 'binary', 'the other session must keep its codec');
});

test('MIG-BGSTAB-004 AC-4 demoting a session does not renegotiate or bump the group codec epoch', () => {
  // Bumping the epoch is how a *group* rollback invalidates in-flight frames.
  // Doing it for one session would invalidate every other session's frames too,
  // which is exactly the blast radius AC-4 forbids.
  const t = twoSessionRouter();
  const group = t.internals.terminalBinaryGroups.get('g1')!;
  const before = group.codecEpoch;

  t.router.demoteTerminalBinarySession(SESSION_A, 'operator-kill-switch');

  assert.equal(group.codecEpoch, before);
  assert.equal(group.isNegotiated, true);
});

test('MIG-BGSTAB-004 AC-4 demoting an unknown session is a no-op, not a throw', () => {
  const t = twoSessionRouter();
  t.router.demoteTerminalBinarySession('nobody', 'operator-kill-switch');
  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_A, 'a3', 3);
  assert.equal(codecOf(t.socket), 'binary');
});

test('MIG-BGSTAB-004 AC-4 the global kill switch demotes every session at once', () => {
  const t = twoSessionRouter();

  t.router.applyTerminalWireFormat('json');

  for (const sessionId of [SESSION_A, SESSION_B]) {
    t.socket.sent.length = 0;
    t.router.routeSessionOutput(sessionId, 'x', 9);
    assert.equal(codecOf(t.socket), 'json', `${sessionId} must fall back`);
  }
});

test('MIG-BGSTAB-004 AC-7 the default flip does not change the transport mode default', () => {
  // The data-plane ladder is orthogonal to wsTransportMode; a binary default
  // must not drag split transport in behind it.
  const router = new WsRouter({} as AuthService, sessionManager(), {});
  const internals = router as unknown as { wsTransportMode: string };
  assert.equal(internals.wsTransportMode, 'unified');
});

test('MIG-BGSTAB-004 AC-8 the resolved default does not alter resource limit numbers', () => {
  const router = new WsRouter({} as AuthService, sessionManager(), {});
  const limits = (router as unknown as {
    runtimeSendPolicyConfig: { limits: Record<string, number> };
  }).runtimeSendPolicyConfig.limits;
  assert.equal(limits.serverBufferedHighWaterBytes, 8388608);
  assert.equal(limits.serverBufferedHardLimitBytes, 33554432);
  assert.equal(limits.perClientOutputQueueMaxBytes, 2097152);
  assert.equal(limits.perClientControlQueueMaxBytes, 262144);
  assert.equal(limits.outputCoalesceWindowMs, 16);
});
