import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import { TERMINAL_CHECKPOINT_PROTOCOL_VERSION, type WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

// REL-BGSTAB-011 AC-6: whoever types drives. Measured 2026-10-28 on https://localhost:2222: a
// phone typed into a session and took the lease; the desktop then sent its size and 234 mouse
// reports, and every one was refused (`invalid-message` for the resizes, `target-identity-stale`
// for the input) until a tab switch registered a new view. The browser attaches its lease to
// every input and resize itself, and the re-adoption that WsRouterMutationLeaseRefusal.test.ts
// covers only fired when the lease came from the connection cache.

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

const SESSION = 'session-handed-off';
const VIEW = 4;

function setup() {
  let currentGeneration = 'lease-1';
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  const adoptions: number[] = [];
  const acceptsIdentity = (identity: unknown) =>
    (identity as { leaseGeneration?: string } | undefined)?.leaseGeneration === currentGeneration;
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (sessionId: string, clientId: string, viewGeneration: number) => ({
      ok: true, sessionId, clientId, authorityEpoch: 'epoch-1', viewGeneration, leaseGeneration: 'lease-1',
    }),
    adoptRetainedTerminalMutationLease: (sessionId: string, clientId: string, viewGeneration: number) => {
      adoptions.push(viewGeneration);
      currentGeneration = 'lease-3';
      return { ok: true, sessionId, clientId, authorityEpoch: 'epoch-1', viewGeneration, leaseGeneration: 'lease-3' };
    },
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    writeInputDetailed: (_id: string, data: string, _m: unknown, _s: unknown, identity: unknown) => {
      if (!acceptsIdentity(identity)) return { ok: false, denialReason: 'mutation-identity-stale' as const };
      writes.push(data);
      return { ok: true };
    },
    resize: (_id: string, cols: number, rows: number, identity: unknown) => {
      if (!acceptsIdentity(identity)) return false;
      resizes.push([cols, rows]);
      return true;
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'desktop',
    isAlive: true,
    subscribedSessions: new Set([SESSION]),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  const send = (message: Record<string, unknown>) =>
    internals.handleMessage(socket as unknown as WebSocket, JSON.stringify(message));
  send({
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    views: [{ sessionId: SESSION, viewGeneration: VIEW }],
  });
  socket.frames.length = 0;
  // The phone typed: the lease moved on, and the desktop's lease-1 is superseded.
  currentGeneration = 'lease-2';
  return {
    router, socket, send, writes, resizes, adoptions,
    staleIdentity: (viewGeneration = VIEW) => ({ authorityEpoch: 'epoch-1', viewGeneration, leaseGeneration: 'lease-1' }),
  };
}

function grantedLeases(frames: Array<Record<string, unknown>>): unknown[] {
  return frames
    .filter(frame => frame.type === 'terminal-checkpoint:capability')
    .flatMap(frame => (frame.mutationLeases as unknown[] | undefined) ?? []);
}

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 AC-6: input carrying a superseded lease of the registered view takes the lease back and lands', () => {
  const { router, socket, send, writes, adoptions, staleIdentity } = setup();
  try {
    send({ type: 'input', sessionId: SESSION, data: 'ls', inputSeqStart: 1, inputSeqEnd: 2, retainedIdentity: staleIdentity() });
    assert.deepEqual(writes, ['ls'], 'the keystroke reaches the PTY');
    assert.deepEqual(adoptions, [VIEW]);
    assert.equal(socket.frames.some(frame => frame.type === 'input:rejected'), false);
    assert.deepEqual(grantedLeases(socket.frames), [
      { sessionId: SESSION, authorityEpoch: 'epoch-1', viewGeneration: VIEW, leaseGeneration: 'lease-3' },
    ], 'the browser is told its new lease, so the next keystroke carries it');
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 AC-6: a resize carrying a superseded lease of the registered view takes the lease back and applies', () => {
  const { router, socket, send, resizes, adoptions, staleIdentity } = setup();
  try {
    send({ type: 'resize', sessionId: SESSION, cols: 154, rows: 47, retainedIdentity: staleIdentity() });
    assert.deepEqual(resizes, [[154, 47]], 'the PTY takes this screen size');
    assert.deepEqual(adoptions, [VIEW]);
    assert.equal(socket.frames.some(frame => frame.type === 'terminal-checkpoint:rejected'), false);
    assert.equal(grantedLeases(socket.frames).length, 1);
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-011
test('REL-BGSTAB-011 AC-6: a lease of an older view is still refused, and takes nothing', () => {
  const { router, socket, send, writes, resizes, adoptions, staleIdentity } = setup();
  try {
    send({ type: 'input', sessionId: SESSION, data: 'x', inputSeqStart: 3, inputSeqEnd: 3, retainedIdentity: staleIdentity(VIEW - 1) });
    send({ type: 'resize', sessionId: SESSION, cols: 100, rows: 30, retainedIdentity: staleIdentity(VIEW - 1) });
    assert.deepEqual(writes, []);
    assert.deepEqual(resizes, []);
    assert.deepEqual(adoptions, [], 'an old view does not take the lease from the screen in use');
    assert.equal(socket.frames.filter(frame => frame.type === 'input:rejected').length, 1);
    assert.equal(socket.frames.filter(frame => frame.type === 'terminal-checkpoint:rejected').length, 1);
  } finally {
    router.destroy();
  }
});
