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

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a registered view whose lease was refused adopts it by writing instead of losing the write', () => {
  // Measured 2026-09-19 on https://localhost:2222: after the barrier fix the browser sent
  // (ws_input_sent 2, inputOperationId "e2:1-5" and "e2:6-6") and the server answered
  // input:rejected/invalid-payload for both, because meta.retainedTerminalViews had the session
  // while meta.retainedTerminalMutationLeases did not. Nothing was written and nothing surfaced.
  const writes: Array<{ sessionId: string; data: string; identity: unknown }> = [];
  const adoptCalls: Array<{ clientId: string; viewGeneration: number }> = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: () => ({ ok: false, reason: 'driver-owned-by-other-client' }),
    adoptRetainedTerminalMutationLease: (sessionId: string, clientId: string, viewGeneration: number) => {
      adoptCalls.push({ clientId, viewGeneration });
      return {
        ok: true,
        sessionId,
        clientId,
        authorityEpoch: 'authority-epoch-1',
        viewGeneration,
        leaseGeneration: 'adopted-1',
      };
    },
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    writeInput: (sessionId: string, data: string, _m: unknown, _s: unknown, identity: unknown) => {
      writes.push({ sessionId, data, identity });
      return true;
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'typing-client',
    isAlive: true,
    subscribedSessions: new Set(['session-adopt']),
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
      views: [{ sessionId: 'session-adopt', viewGeneration: 4 }],
    }));
    assert.deepEqual(socket.frames.at(-1)?.mutationLeaseRefusals, [{
      sessionId: 'session-adopt',
      viewGeneration: 4,
      reason: 'driver-owned-by-other-client',
    }]);

    internals.handleMessage(socket as unknown as WebSocket, JSON.stringify({
      type: 'input',
      sessionId: 'session-adopt',
      data: 'codex',
      inputSeqStart: 1,
      inputSeqEnd: 5,
    }));

    assert.deepEqual(adoptCalls, [{ clientId: 'typing-client', viewGeneration: 4 }]);
    assert.equal(writes.length, 1, 'the write must reach the PTY');
    assert.equal(writes[0]!.data, 'codex');
    assert.deepEqual(writes[0]!.identity, {
      clientId: 'typing-client',
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 4,
      leaseGeneration: 'adopted-1',
    });
    assert.equal(
      socket.frames.some(frame => frame.type === 'input:rejected'),
      false,
      'an adopted write must not be reported as rejected',
    );
    const capability = socket.frames.filter(frame => frame.type === 'terminal-checkpoint:capability').at(-1);
    assert.deepEqual(capability?.mutationLeases, [{
      sessionId: 'session-adopt',
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 4,
      leaseGeneration: 'adopted-1',
    }], 'the client must be told it now holds the lease');
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a write that cannot adopt the lease is refused with a reason that names the cause', () => {
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: () => ({ ok: false, reason: 'authority-admission-closed' }),
    adoptRetainedTerminalMutationLease: () => ({ ok: false, reason: 'authority-admission-closed' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    writeInput: () => true,
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'blocked-client',
    isAlive: true,
    subscribedSessions: new Set(['session-blocked']),
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
      views: [{ sessionId: 'session-blocked', viewGeneration: 2 }],
    }));
    internals.handleMessage(socket as unknown as WebSocket, JSON.stringify({
      type: 'input',
      sessionId: 'session-blocked',
      data: 'x',
      inputSeqStart: 1,
      inputSeqEnd: 1,
    }));
    const rejection = socket.frames.filter(frame => frame.type === 'input:rejected').at(-1);
    // 'invalid-payload' said the client sent something malformed. It had not: the payload was
    // fine and the server simply would not let it drive.
    assert.equal(rejection?.reason, 'driver-lease-unavailable');
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 a client whose cached lease was superseded re-adopts instead of sticking on server-error', () => {
  // The other half of "whoever types, drives". Once tab B adopts the lease, tab A still holds
  // the superseded identity in its connection meta, so tab A's next write carries a stale
  // leaseGeneration, writeInput refuses it, and the adoption branch does not fire because tab A
  // *has* an identity. Without this, the first tab to lose the lease can never get it back and
  // every keystroke in it is refused as 'server-error' -- the read-only window this whole fix
  // exists to prevent, just moved to the other tab.
  let currentGeneration = 'lease-stale';
  const writes: string[] = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (sessionId: string, clientId: string, viewGeneration: number) => ({
      ok: true, sessionId, clientId, authorityEpoch: 'epoch-1', viewGeneration, leaseGeneration: 'lease-stale',
    }),
    adoptRetainedTerminalMutationLease: (sessionId: string, clientId: string, viewGeneration: number) => {
      currentGeneration = 'lease-fresh';
      return { ok: true, sessionId, clientId, authorityEpoch: 'epoch-1', viewGeneration, leaseGeneration: 'lease-fresh' };
    },
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    writeInput: (_id: string, data: string, _m: unknown, _s: unknown, identity: unknown) => {
      // Mirrors acceptRetainedTerminalMutationIdentity: a superseded generation is refused.
      if ((identity as { leaseGeneration?: string } | undefined)?.leaseGeneration !== currentGeneration) return false;
      writes.push(data);
      return true;
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'demoted-client',
    isAlive: true,
    subscribedSessions: new Set(['session-demoted']),
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
      views: [{ sessionId: 'session-demoted', viewGeneration: 1 }],
    }));
    // Another view takes the lease; this connection's cached identity is now superseded.
    currentGeneration = 'lease-taken-by-someone-else';

    internals.handleMessage(socket as unknown as WebSocket, JSON.stringify({
      type: 'input', sessionId: 'session-demoted', data: 'hello', inputSeqStart: 1, inputSeqEnd: 5,
    }));

    assert.deepEqual(writes, ['hello'], 'the keystroke must land, not be lost to a stale lease');
    assert.equal(
      socket.frames.some(frame => frame.type === 'input:rejected'),
      false,
      'a re-adopted write must not be reported as rejected',
    );
  } finally {
    router.destroy();
  }
});
