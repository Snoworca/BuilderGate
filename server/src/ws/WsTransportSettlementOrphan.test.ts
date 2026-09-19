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

test('two tracked sends on the same socket both settle; neither is displaced', async () => {
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

  // Flipped from characterization to regression guard in the same commit as the fix. Before
  // the in-flight slot became a set this asserted the OPPOSITE -- that `first` never settled
  // -- and passed. If it starts failing, displacement has returned.
  assert.deepEqual(
    [...settled].sort(),
    ['first', 'second'],
    'a concurrently sent message did not settle; the in-flight tracking has reverted to '
    + 'one slot per socket and a displaced send has lost its only resolver',
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

/**
 * The two bugs the single slot causes beyond the orphan, both live today and both invisible
 * for the same reason: a displaced message quietly isn't there.
 *
 * These assert the CORRECT behaviour, so they are red until the slot becomes a set. They
 * each carry a control, because "the boundary is missing a message" is also satisfied by a
 * harness that never got two messages in flight at all.
 */

interface RouterInternals {
  transportPolicyGeneration: number;
  findSocketForCanaryTarget(target: unknown): unknown;
  hasPendingPolicyGeneration(target: unknown, generation: number): boolean;
  captureWsRollbackBoundary(target: unknown): Set<unknown>;
}

function internals(router: WsRouter, ws: WebSocket): RouterInternals {
  const raw = router as unknown as RouterInternals;
  raw.findSocketForCanaryTarget = () => ws;
  return raw;
}

test('the rollback boundary captures every in-flight message, not only the newest', () => {
  const router = createRouter();
  const socket = createDeferredSocket();
  const raw = internals(router, socket.ws);

  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'first' }, () => {});
  const afterFirst = raw.captureWsRollbackBoundary({});
  assert.equal(
    afterFirst.size,
    1,
    'control: with one send in flight the boundary must contain exactly it, or this test '
    + 'cannot tell a missing message from a boundary that never captures anything',
  );

  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'second' }, () => {});
  const afterSecond = raw.captureWsRollbackBoundary({});
  assert.equal(
    afterSecond.size,
    2,
    'the rollback boundary omitted a message that is still in flight; a displaced send is '
    + 'excluded from the boundary it belongs to',
  );
});

test('a displaced in-flight message is still found by its policy generation', () => {
  const router = createRouter();
  const socket = createDeferredSocket();
  const raw = internals(router, socket.ws);

  const firstGeneration = raw.transportPolicyGeneration;
  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'first' }, () => {});
  assert.equal(
    raw.hasPendingPolicyGeneration({}, firstGeneration),
    true,
    'control: the generation of the only in-flight message must be found, or this test '
    + 'cannot distinguish displacement from a lookup that never finds anything',
  );

  // A second send under a later generation takes the slot.
  raw.transportPolicyGeneration = firstGeneration + 1;
  router.sendTo(socket.ws, { type: 'output', sessionId: 's', data: 'second' }, () => {});

  assert.equal(
    raw.hasPendingPolicyGeneration({}, firstGeneration),
    true,
    'a message of this generation is still in flight but the lookup answered false; the '
    + 'displaced message is invisible to policy-generation checks',
  );
});
