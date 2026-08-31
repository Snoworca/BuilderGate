import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { ScreenRepairPendingState, WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

/**
 * `06 §S4-0b` #9 — does the screen-repair ACK timeout path converge?
 *
 * The item is phrased around a future `0x03` prologue carrying a
 * `repairTokenIndex` the client cannot resolve: the client would apply the
 * frame but never send `screen-repair:ready`, so the server falls to its
 * timeout. That prologue does not exist yet (`prologueBytes` returns 0 for
 * `SCREEN_REPAIR`), but the timeout path it lands in does, and it is reachable
 * today by any client that simply does not answer.
 *
 * What has to hold is that the path *ends*: one timeout produces one recovery
 * attempt and leaves nothing armed. A path that re-armed would turn a single
 * unanswered repair into a loop that never stops.
 */

const SESSION_ID = 'session-a';

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
  handleScreenRepairAckTimeout: (
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    screenSeq: number,
  ) => void;
}

function setup() {
  const router = new WsRouter({} as AuthService, {
    // No snapshot: the recovery then takes its `authority-unavailable` exit,
    // which is the shortest terminating branch and the one under test here.
    getScreenSnapshot: () => undefined,
    getSession: (id: string) => (id === SESSION_ID ? { id, status: 'running' } : undefined),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
  } as unknown as SessionManager, { realtime: { wsTransportMode: 'unified' } });

  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const internals = router as unknown as RouterInternals;
  assert.ok(internals.clients instanceof Map, 'WsRouter.clients is no longer a Map');
  assert.equal(
    typeof internals.handleScreenRepairAckTimeout,
    'function',
    'WsRouter.handleScreenRepairAckTimeout is gone',
  );

  const pendingSessions = new Map<string, ScreenRepairPendingState>();
  const meta = {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set([SESSION_ID]),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: pendingSessions,
  } as unknown as WsClientMeta;
  internals.clients.set(ws, meta);

  return { router, socket, ws, internals, pendingSessions };
}

function arm(pendingSessions: Map<string, ScreenRepairPendingState>, repairToken: string): void {
  pendingSessions.set(SESSION_ID, {
    queuedOutputBytes: 0,
    queuedOutputChunks: [],
    repairToken,
    screenSeq: 7,
  });
}

function timeoutCount(router: WsRouter): number {
  return router.getObservabilitySnapshot().screenRepairAckTimeoutCount;
}

test('an unanswered repair is counted exactly once', () => {
  const { router, ws, internals, pendingSessions } = setup();
  arm(pendingSessions, 'token-1');

  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);

  assert.equal(timeoutCount(router), 1);
});

test('the timeout clears the pending entry, so it cannot fire again', () => {
  const { router, ws, internals, pendingSessions } = setup();
  arm(pendingSessions, 'token-1');

  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);
  // A late second firing is exactly what a re-arming path would produce.
  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);

  assert.equal(pendingSessions.size, 0);
  assert.equal(timeoutCount(router), 1, 'the path fired twice: it does not converge');
});

test('the timeout does not leave a repair armed for the next round', () => {
  const { ws, internals, pendingSessions } = setup();
  arm(pendingSessions, 'token-1');

  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);

  assert.equal(pendingSessions.get(SESSION_ID), undefined);
});

test('a timeout for a superseded token is ignored', () => {
  const { router, ws, internals, pendingSessions } = setup();
  arm(pendingSessions, 'token-2');

  // The first repair's timer can still fire after a second repair replaced it.
  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);

  assert.equal(timeoutCount(router), 0);
  assert.equal(pendingSessions.get(SESSION_ID)?.repairToken, 'token-2');
});

test('the client is told to reconnect when no authority snapshot exists', () => {
  const { socket, ws, internals, pendingSessions } = setup();
  arm(pendingSessions, 'token-1');

  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);

  // Terminating in a message the client can act on is what makes this a
  // convergent path rather than a silent dead end.
  const frame = socket.frames.at(-1);
  assert.ok(frame, 'the timeout produced no message at all');
  assert.equal(frame.sessionId, SESSION_ID);
});

test('BOUNDARY CONTROL — no timeout fires while nothing is pending', () => {
  const { router, ws, internals } = setup();

  internals.handleScreenRepairAckTimeout(ws, SESSION_ID, 'token-1', 7);

  assert.equal(timeoutCount(router), 0);
});
