import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import { WsRouter } from './WsRouter.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';

/**
 * The `legacy-unnegotiated` audience is a FALLBACK: SessionManager routes a chunk through it
 * only after the authority path reported `legacy-delivered` for the same chunk
 * (SessionManager.ts:8287). Its filter must therefore exclude every view the authority path
 * actually delivered to, or the view is served the same bytes twice.
 *
 * Issue #110 narrowed that filter from "has a registration" to "is in checkpoint mode",
 * because a registered view in legacy mode was measurably receiving nothing. That
 * measurement was taken on 2026-09-19, while the in-flight transport slot was orphaning
 * settlements: the authority delivery chain stalled after its first displaced send, so
 * legacy views genuinely were not being delivered to. The narrowing was compensating for
 * that bug rather than for a structural gap.
 *
 * With the orphan fixed the compensation over-delivers. In legacy mode
 * `checkpointOutputAuthority` is false, so the server-mode block in `sendTerminalFrame` is
 * skipped and flow reaches `enqueueSettledViewFrame` -- a registered legacy view IS
 * delivered to by the authority path. Measured post-fix: a 700-line producer left the
 * browser holding ~1409 lines, roughly double, until a promotion replaced the buffer.
 *
 * The control below is the half that matters: a subscriber the authority path does NOT
 * address must still receive the fallback. Without it this fix would silently disable the
 * fallback altogether, which is the failure #110 was written to prevent.
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

const SESSION = 'session-fallback';

function attach(router: WsRouter, ws: WebSocket, options: { registered: boolean }): void {
  const raw = router as unknown as {
    sessionSubscribers: Map<string, Set<WebSocket>>;
    clients: Map<WebSocket, Record<string, unknown>>;
    terminalAuthorityViewModeReader?: () => string;
  };
  const subscribers = raw.sessionSubscribers.get(SESSION) ?? new Set<WebSocket>();
  subscribers.add(ws);
  raw.sessionSubscribers.set(SESSION, subscribers);
  raw.clients.set(ws, {
    clientId: options.registered ? 'client-registered' : 'client-plain',
    connectionId: options.registered ? 'conn-registered' : 'conn-plain',
    replayPendingSessions: new Map(),
    subscribedSessions: new Set([SESSION]),
    ...(options.registered
      ? { terminalAuthorityViewRegistrations: new Map([[SESSION, { viewGeneration: 1 }]]) }
      : {}),
  });
  // Legacy mode: the authority path has no active checkpoint for this view, which is the
  // state #110 measured and the state this session is in.
  raw.terminalAuthorityViewModeReader = () => 'legacy';
}

const PRODUCER_LINES = 40;

function producerLines(): string[] {
  return Array.from({ length: PRODUCER_LINES }, (_, index) => `PUMP-${index + 1}`);
}

/** Every payload this socket received, as the marker text carried in each chunk. */
function receivedMarkers(sent: readonly string[]): string[] {
  return sent.flatMap((payload) => {
    const match = /PUMP-\d+/u.exec(payload);
    return match ? [match[0]] : [];
  });
}

test('a registered legacy view is served none of what the authority path already delivered', () => {
  const router = createRouter();
  const socket = createSocket();
  attach(router, socket.ws, { registered: true });

  for (const line of producerLines()) {
    router.routeSessionOutput(SESSION, `${line}\r\n`, 1, {}, 'legacy-unnegotiated');
  }

  // Asserted on identity, not on a count: a fix that suppressed only some of the duplicates
  // would still reduce the total, and "fewer" is not "none".
  assert.deepEqual(
    receivedMarkers(socket.sent),
    [],
    'the fallback delivered lines the authority path had already delivered; the view receives '
    + 'those bytes twice',
  );
});

/**
 * The control, and it is load-bearing rather than belt-and-braces.
 *
 * Every assertion above is satisfied by a fix that removes the fallback outright, not just by
 * one that corrects its predicate. This sends the same numbered producer to a subscriber the
 * authority path does NOT address and requires every line back, in order and contiguous --
 * so it fails if the fallback is deleted, if it drops chunks, or if it reorders them.
 *
 * Contiguity matters for the same reason the harness lane added it to their criterion: a
 * partially-broken fix can land near the right total while silently losing a third of the
 * traffic, and a count cannot tell those apart.
 */
test('control: an unaddressed subscriber receives every fallback line, in order', () => {
  const router = createRouter();
  const socket = createSocket();
  attach(router, socket.ws, { registered: false });

  const expected = producerLines();
  for (const line of expected) {
    router.routeSessionOutput(SESSION, `${line}\r\n`, 1, {}, 'legacy-unnegotiated');
  }

  assert.deepEqual(
    receivedMarkers(socket.sent),
    expected,
    'control failed: the fallback did not deliver every line in order to a subscriber the '
    + 'authority path does not address. If this is empty the fallback has been disabled '
    + 'rather than narrowed -- exactly what #110 prevented; if it is short or reordered, the '
    + 'fallback is losing traffic',
  );
});
