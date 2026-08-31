import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

/**
 * The restore-authority retry budget has to outlast a headless write.
 *
 * An atomic restore snapshot is refused while a write is mid-apply, which is
 * correct: the buffer is ahead of its sequence there and a snapshot taken then
 * would over-claim its coverage. The refusal is momentary, so the caller
 * samples again — but it only sampled three times over 32ms, and a session
 * driven by a redrawing TUI is mid-apply often enough that all three can miss.
 * The client then receives `session:error`, which it cannot distinguish from a
 * shell that exited.
 *
 * The budget is what decides this, and 32ms is arbitrary: the write it waits on
 * is longer than that. Widening it keeps the fail-closed property — a session
 * that never settles still reports — while giving a busy one room to be caught
 * between writes.
 */

const SESSION_ID = 'session-busy';

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: Array<Record<string, unknown>> = [];
  send(payload: string | Uint8Array, callback?: (error?: Error) => void): void {
    if (typeof payload === 'string') {
      this.frames.push(JSON.parse(payload) as Record<string, unknown>);
    }
    callback?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

interface RouterInternals {
  clients: Map<WebSocket, WsClientMeta>;
  handleSubscribe: (ws: WebSocket, sessionIds: string[]) => void;
}

/** Refuses the first `failures` samples the way a mid-apply write does. */
function flakySessionManager(failures: number, counter: { samples: number }): SessionManager {
  return {
    getSession: (id: string) => (id === SESSION_ID ? { id, status: 'running' } : undefined),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
    getAtomicRestoreSnapshot: () => {
      counter.samples += 1;
      if (counter.samples <= failures) {
        return { ok: false as const, reason: 'generation-failed' as const };
      }
      return {
        ok: true as const,
        payload: {
          authorityEpoch: 'epoch-1',
          authorityRevision: 3,
          snapshotSeq: 12,
          parserComplete: true,
          pendingEscapeTailAnsi: '',
          serializedData: 'screen-contents',
          cols: 80,
          rows: 24,
          truncated: false,
          generatedAt: 0,
          health: 'healthy' as const,
          windowsPty: undefined,
        },
      };
    },
    getScreenSnapshot: () => null,
  } as unknown as SessionManager;
}

function setup(manager: SessionManager) {
  const router = new WsRouter({} as AuthService, manager, { realtime: { wsTransportMode: 'unified' } });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const internals = router as unknown as RouterInternals;
  assert.equal(typeof internals.handleSubscribe, 'function', 'WsRouter.handleSubscribe is gone');
  internals.clients.set(ws, {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta);
  return { router, socket, ws, internals };
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a snapshot that settles after a few hundred milliseconds still reaches the client', async () => {
  const counter = { samples: 0 };
  const { router, socket, ws, internals } = setup(flakySessionManager(6, counter));
  try {
    internals.handleSubscribe(ws, [SESSION_ID]);
    await settle(2_000);

    assert.ok(counter.samples > 6, `the budget stopped at ${counter.samples} samples`);
    assert.deepEqual(
      socket.frames.filter(frame => frame.type === 'session:error'),
      [],
      'a session that settled within the budget was reported as an error',
    );
    assert.ok(
      socket.frames.some(frame => frame.type === 'screen-snapshot'),
      'no snapshot reached the client',
    );
  } finally {
    router.destroy();
  }
});

test('a session that never settles still reports the failure', async () => {
  const counter = { samples: 0 };
  const { router, socket, ws, internals } = setup(flakySessionManager(Number.MAX_SAFE_INTEGER, counter));
  try {
    internals.handleSubscribe(ws, [SESSION_ID]);
    await settle(3_000);

    assert.deepEqual(
      socket.frames.filter(frame => frame.type === 'session:error').map(frame => frame.message),
      ['Authoritative terminal restore unavailable'],
      'the budget no longer terminates, so a broken session is never reported',
    );
  } finally {
    router.destroy();
  }
});
