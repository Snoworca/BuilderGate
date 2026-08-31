import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import { WsRouter } from './WsRouter.js';

/**
 * `06 §S3` — an arriving frame the server cannot read must fail explicitly.
 *
 * A `console.warn` and a `return` is still a silent drop as far as the system is
 * concerned: nothing counts it, so nothing can gate on it. `05:176` requires the
 * count to reach zero before the shadow rung opens, which needs a count first.
 */

interface RouterInternals {
  handleMessage: (ws: WebSocket, raw: unknown) => void;
  clients: Map<WebSocket, unknown>;
}

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: unknown[] = [];
  send(payload: unknown): void { this.frames.push(payload); }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

function setup() {
  const router = new WsRouter({} as AuthService, {} as SessionManager, {
    realtime: { wsTransportMode: 'unified' },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const internals = router as unknown as RouterInternals;
  assert.equal(typeof internals.handleMessage, 'function', 'WsRouter.handleMessage is gone');
  assert.ok(internals.clients instanceof Map, 'WsRouter.clients is no longer a Map');
  internals.clients.set(ws, {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
  return { router, ws, internals };
}

function undecodableCount(router: WsRouter): number {
  const diagnostics = router.getObservabilitySnapshot() as unknown as Record<string, unknown>;
  assert.ok(
    'undecodableFrameCount' in diagnostics,
    'the observability snapshot no longer reports undecodable frames',
  );
  return diagnostics.undecodableFrameCount as number;
}

test('a readable frame does not touch the undecodable counter', () => {
  const { router, ws, internals } = setup();

  internals.handleMessage(ws, JSON.stringify({ type: 'ping' }));

  assert.equal(undecodableCount(router), 0);
});

test('an unparseable frame is counted rather than only warned about', () => {
  const { router, ws, internals } = setup();

  internals.handleMessage(ws, 'not json at all');

  assert.equal(undecodableCount(router), 1);
});

test('every unparseable frame is counted, not just the first', () => {
  const { router, ws, internals } = setup();

  internals.handleMessage(ws, '{');
  internals.handleMessage(ws, '}');
  internals.handleMessage(ws, 'nope');

  assert.equal(undecodableCount(router), 3);
});

test('a frame carrying valid JSON that is not a message is still readable', () => {
  const { router, ws, internals } = setup();

  // `[]` parses. Whether the router understands it is a different question from
  // whether it could decode it, and only the latter is what this counter means.
  internals.handleMessage(ws, '[]');

  assert.equal(undecodableCount(router), 0);
});
