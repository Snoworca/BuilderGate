import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import { WsRouter } from './WsRouter.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';

/**
 * OPS-BGSTAB-014 — a capability handshake rejection must leave a findable record.
 *
 * The rejections themselves were already observable to the peer: both handshakes send a
 * typed message with a reason. What was missing is a record that outlives the connection,
 * and the two gaps that mattered were both on the ordinary path, not in a race.
 *
 * The controls carry this file. A test that only rejects a well-formed message passes
 * against the defect untouched, because the defect is precisely that the rejections
 * WITHOUT an identifier were the ones being dropped.
 */

function createRouter(): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const sessionManagerStub = { getSession: () => null } as unknown as SessionManager;
  return new WsRouter(authServiceStub, sessionManagerStub);
}

function createSocket() {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload: string, callback?: (error?: Error) => void) {
      sent.push(payload);
      callback?.(undefined);
    },
    ping() {}, close() {}, terminate() {},
    on() { return this; }, once() { return this; },
    off() { return this; }, removeListener() { return this; },
  };
  return { ws: ws as unknown as WebSocket, sent };
}

function attachClient(router: WsRouter, ws: WebSocket, clientId = 'client-1'): void {
  (router as unknown as { clients: Map<WebSocket, unknown> }).clients.set(ws, {
    clientId,
    connectionId: `connection-${clientId}`,
    reconnectGeneration: 1,
    outputChannel: true,
    isAlive: true,
    channelRole: 'control',
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
}

function deliver(router: WsRouter, ws: WebSocket, message: unknown): void {
  (router as unknown as { handleMessage(socket: WebSocket, raw: string): void })
    .handleMessage(ws, JSON.stringify(message));
}

function rejections(router: WsRouter) {
  return (router as unknown as {
    getHandshakeRejections(limit?: number): readonly {
      handshake: string;
      reason: string;
      sessionId: string | null;
      clientId: string | null;
      answered: boolean;
    }[];
  }).getHandshakeRejections();
}

function parsed(sent: readonly string[]) {
  return sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

test('AC-2: a checkpoint rejection that carries no sessionId is still recorded', () => {
  // THE defect. The client-side recording sat inside `if (checkpoint.sessionId)`, and a
  // payload malformed enough to lose its sessionId is exactly the rejection worth reading.
  const router = createRouter();
  const { ws, sent } = createSocket();
  attachClient(router, ws);

  deliver(router, ws, { type: 'terminal-checkpoint:negotiate', protocolVersion: 9999 });

  const recorded = rejections(router);
  assert.equal(recorded.length, 1, 'the rejection left no record');
  assert.equal(recorded[0]!.handshake, 'checkpoint');
  assert.equal(recorded[0]!.sessionId, null, 'absence must be explicit, not a placeholder');
  assert.equal(recorded[0]!.answered, true, 'the peer was told');
  // The wire contract is unchanged (AC-4).
  assert.equal(parsed(sent)[0]!.type, 'terminal-checkpoint:rejected');
});

test('AC-2 control: a rejection that DOES carry a sessionId records it', () => {
  // Without this, the assertion above is satisfied by a recorder that writes null always.
  const router = createRouter();
  const { ws } = createSocket();
  attachClient(router, ws);

  deliver(router, ws, {
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: 9999,
    sessionId: 'session-77',
  });

  assert.equal(rejections(router)[0]!.sessionId, 'session-77');
});

test('AC-2: a sessionless record is distinguishable from one that names a session', () => {
  const router = createRouter();
  const { ws } = createSocket();
  attachClient(router, ws);

  deliver(router, ws, { type: 'terminal-checkpoint:negotiate', protocolVersion: 9999 });
  deliver(router, ws, { type: 'terminal-checkpoint:negotiate', protocolVersion: 9999, sessionId: 's' });

  const [withoutSession, withSession] = rejections(router);
  assert.notEqual(withoutSession!.sessionId, withSession!.sessionId);
  assert.equal(typeof withSession!.sessionId, 'string');
  assert.equal(withoutSession!.sessionId, null);
});

test('AC-1: a binary rejection is recorded, not only written to a console', () => {
  const router = createRouter();
  const { ws, sent } = createSocket();
  attachClient(router, ws);

  deliver(router, ws, { type: 'terminal-binary:negotiate' });

  const recorded = rejections(router);
  assert.equal(recorded.length, 1, 'the binary rejection left no record');
  assert.equal(recorded[0]!.handshake, 'binary');
  assert.ok(recorded[0]!.reason.length > 0, 'the record carries no reason');
  assert.equal(recorded[0]!.sessionId, null, 'a binary rejection is group-scoped; it has no session');
  assert.equal(parsed(sent)[0]!.type, 'terminal-binary:rejected');
});

test('AC-1: recording does not depend on debug capture being enabled', () => {
  // No session has debug capture on in this router, and the record must exist anyway.
  const router = createRouter();
  const { ws } = createSocket();
  attachClient(router, ws);

  deliver(router, ws, { type: 'terminal-binary:negotiate' });

  assert.equal(rejections(router).length, 1);
});

test('AC-3: a binary offer from an unknown socket is answered, as the checkpoint one is', () => {
  // Same condition, same file, adjacent handlers: `clients.get(ws)` missing. The checkpoint
  // handler answered `invalid-message`; the binary handler returned silently.
  const router = createRouter();
  const binary = createSocket();
  const checkpoint = createSocket();
  // deliberately NOT attached

  deliver(router, binary.ws, { type: 'terminal-binary:negotiate' });
  deliver(router, checkpoint.ws, { type: 'terminal-checkpoint:negotiate', protocolVersion: 1 });

  assert.equal(binary.sent.length, 1, 'the binary handler returned without answering');
  assert.equal(parsed(binary.sent)[0]!.type, 'terminal-binary:rejected');
  assert.equal(checkpoint.sent.length, 1);
  assert.equal(parsed(checkpoint.sent)[0]!.type, 'terminal-checkpoint:rejected');

  const recorded = rejections(router);
  assert.equal(recorded.length, 2, 'an unanswerable offer left no record');
  assert.deepEqual(recorded.map((row) => row.answered), [true, true]);
});

test('AC-4: no new rejection reason is introduced', () => {
  const router = createRouter();
  const { ws } = createSocket();
  attachClient(router, ws);

  deliver(router, ws, { type: 'terminal-binary:negotiate' });
  deliver(router, ws, { type: 'terminal-checkpoint:negotiate', protocolVersion: 9999 });

  const known = new Set([
    'invalid-message', 'socket-not-binary-capable', 'group-not-eligible',
    'mandatory-flag-not-accepted', 'unsupported-version',
    'capability-not-negotiated', 'checkpoint-not-active',
  ]);
  for (const row of rejections(router)) {
    assert.ok(known.has(row.reason), `unknown rejection reason introduced: ${row.reason}`);
  }
});
