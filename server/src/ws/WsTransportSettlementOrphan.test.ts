import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import { WsRouter } from './WsRouter.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';

/**
 * `WsRouter` tracks the in-flight transport message per SOCKET:
 *
 *     private readonly inFlightTransportMessages = new Map<WebSocket, WsTransportMessage>();
 *     …
 *     if (tracksSettlement) this.inFlightTransportMessages.set(ws, message);
 *     const onSent = (error?: Error) => {
 *       if (tracksSettlement && this.inFlightTransportMessages.get(ws) !== message) {
 *         return;                       // ← returns WITHOUT settling
 *       }
 *       …
 *       this.settleTransportMessage(message);
 *
 * One slot per socket. A second tracked message overwrites the first, so when the first
 * `ws.send` callback finally fires it finds a different message in the slot and returns
 * without settling. No error, no log, no retry: the message's `onSettled` simply never runs
 * and its promise loses its only resolver.
 *
 * WHY IT MATTERS UPSTREAM. Terminal authority deliveries settle on `Promise.all` over
 * per-view sends, each resolved from that callback. An orphaned send leaves the view's frame
 * promise unresolved, which leaves `sendTerminalFrame` unresolved, which leaves the
 * serialised terminal-delivery chain's head unresolved -- and every delivery queued behind
 * it strands. `beginPromotion` awaits that chain, so a promotion attempted afterwards never
 * returns, without promotion being the cause.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the hazard is REACHABLE: two tracked
 * sends on one socket are sufficient to orphan the first. It does NOT prove this occurred in
 * the 2026-09-20 harness runs, where a quiesced session showed a delivery chain stuck at
 * depth 246-366 with a pump reading `sending: true, hasInFlight: true, queuedFrames: 0`.
 * Every measurement taken is consistent with this mechanism; consistency is not
 * demonstration, and three earlier mechanisms in this investigation were consistent too,
 * right up to the instrument that refuted them.
 */

const SETTLE_PROBE_MS = 200;

function createDeferredSocket() {
  const pendingSendCallbacks: Array<() => void> = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(_payload: string, callback?: (error?: Error) => void) {
      if (callback) pendingSendCallbacks.push(() => callback(undefined));
    },
    ping() {},
    close() { (this as { readyState: number }).readyState = 3; },
    terminate() { (this as { readyState: number }).readyState = 3; },
    on() { return this; },
    once() { return this; },
    off() { return this; },
    removeListener() { return this; },
  };
  return {
    ws: ws as unknown as WebSocket,
    pendingCount: () => pendingSendCallbacks.length,
    flushNext: () => { pendingSendCallbacks.shift()?.(); },
  };
}

function createRouter(): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const sessionManagerStub = { getSession: () => null } as unknown as SessionManager;
  return new WsRouter(authServiceStub, sessionManagerStub);
}

test('a second tracked send on the same socket orphans the first message settlement', async () => {
  const router = createRouter();
  const socket = createDeferredSocket();

  const settled: string[] = [];
  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'first' }, () => {
    settled.push('first');
  });
  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'second' }, () => {
    settled.push('second');
  });

  assert.equal(socket.pendingCount(), 2, 'precondition: both sends were admitted to the socket');

  // Fire them in the order they were sent, as a socket would.
  socket.flushNext();
  socket.flushNext();
  await new Promise<void>(resolve => setTimeout(resolve, SETTLE_PROBE_MS));

  assert.equal(
    settled.includes('first'),
    false,
    `the first message settled after being displaced; if this now fails, the in-flight `
    + 'tracking is no longer one-slot-per-socket -- check that before deleting this test',
  );
  assert.equal(
    settled.includes('second'),
    true,
    'precondition: the surviving message must settle, or this test proves nothing about '
    + 'displacement specifically',
  );
});

/**
 * The control. "The first never settled" is satisfied by a genuine orphan AND by a harness
 * in which nothing settles at all -- which would make the assertion above worthless. Here
 * the identical two messages are sent SERIALISED, each callback fired before the next send,
 * so neither is ever displaced. Both must settle.
 */
test('control: serialised sends on the same socket both settle', async () => {
  const router = createRouter();
  const socket = createDeferredSocket();

  const settled: string[] = [];
  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'first' }, () => {
    settled.push('first');
  });
  socket.flushNext();
  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'second' }, () => {
    settled.push('second');
  });
  socket.flushNext();
  await new Promise<void>(resolve => setTimeout(resolve, SETTLE_PROBE_MS));

  assert.deepEqual(
    [...settled].sort(),
    ['first', 'second'],
    'control failed: serialised sends did not both settle, so the displacement test above '
    + 'is measuring something other than displacement',
  );
});
