import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import { TERMINAL_CHECKPOINT_PROTOCOL_VERSION, type WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: Array<Record<string, unknown>> = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.frames.push(JSON.parse(payload) as Record<string, unknown>);
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function negotiateWithRefusedLease(refusalReason: string): Record<string, unknown> | undefined {
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: () => ({ ok: false, reason: refusalReason }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'refused-client',
    isAlive: true,
    subscribedSessions: new Set(['session-refused']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    internals.handleMessage(socket as unknown as WebSocket, JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{ sessionId: 'session-refused', viewGeneration: 3 }],
    }));
    return socket.frames.at(-1);
  } finally {
    router.destroy();
  }
}

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a refused mutation lease is reported on the capability instead of being dropped', () => {
  // Measured 2026-09-19: the router did `if (!lease.ok) continue;` and still sent a
  // capability that registered the view with an empty mutationLeases array. The browser
  // could not tell "no lease, and here is why" from "still negotiating", so it held every
  // keystroke for the whole session.
  const capability = negotiateWithRefusedLease('driver-owned-by-other-client');
  assert.equal(capability?.type, 'terminal-checkpoint:capability');
  assert.deepEqual(capability?.registeredViews, [{ sessionId: 'session-refused', viewGeneration: 3 }]);
  assert.deepEqual(capability?.mutationLeases, []);
  assert.deepEqual(capability?.mutationLeaseRefusals, [{
    sessionId: 'session-refused',
    viewGeneration: 3,
    reason: 'driver-owned-by-other-client',
  }]);
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a closed authority admission is named on the wire too', () => {
  const capability = negotiateWithRefusedLease('authority-admission-closed');
  assert.deepEqual(capability?.mutationLeaseRefusals, [{
    sessionId: 'session-refused',
    viewGeneration: 3,
    reason: 'authority-admission-closed',
  }]);
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a granted lease carries no refusal', () => {
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      clientId,
      authorityEpoch: 'authority-epoch-1',
      viewGeneration,
      leaseGeneration: 'lease-1',
    }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'granted-client',
    isAlive: true,
    subscribedSessions: new Set(['session-granted']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    internals.handleMessage(socket as unknown as WebSocket, JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{ sessionId: 'session-granted', viewGeneration: 1 }],
    }));
    const capability = socket.frames.at(-1);
    assert.equal((capability?.mutationLeases as unknown[]).length, 1);
    assert.equal(capability?.mutationLeaseRefusals, undefined);
  } finally {
    router.destroy();
  }
});
