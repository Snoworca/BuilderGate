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

type ViewKind = 'delivered' | 'registered-but-not-delivered' | 'unregistered';

/**
 * `delivered` builds a registration that satisfies every condition
 * `getTerminalAuthorityResponderViews` imposes -- capabilities, and the three generations
 * agreeing -- so the authority path addresses this view.
 *
 * `registered-but-not-delivered` has a registration whose `driverLeaseGeneration` disagrees
 * with its `authorityStreamEpoch`. It is excluded from the responder set, so the authority
 * path does NOT address it, and the fallback is the only path that can reach it.
 */
function attach(router: WsRouter, ws: WebSocket, kind: ViewKind): void {
  const raw = router as unknown as {
    sessionSubscribers: Map<string, Set<WebSocket>>;
    clients: Map<WebSocket, Record<string, unknown>>;
    terminalAuthorityViewModeReader?: () => string;
  };
  const subscribers = raw.sessionSubscribers.get(SESSION) ?? new Set<WebSocket>();
  subscribers.add(ws);
  raw.sessionSubscribers.set(SESSION, subscribers);

  const registration = kind === 'unregistered' ? undefined : {
    sessionId: SESSION,
    viewGeneration: 1,
    queryReplyCapability: 'terminal.query-reply-input.v1',
    parserResponderCapability: 'terminal.parser-responder-disable.v1',
    authorityStreamEpoch: '1',
    // The one field that decides membership of the responder set.
    driverLeaseGeneration: kind === 'delivered' ? '1' : '2',
    acceptedViewAttributesGeneration: '1',
  };

  raw.clients.set(ws, {
    clientId: `client-${kind}`,
    connectionId: `conn-${kind}`,
    channelRole: 'control',
    replayPendingSessions: new Map(),
    subscribedSessions: new Set([SESSION]),
    ...(registration ? { terminalAuthorityViewRegistrations: new Map([[SESSION, registration]]) } : {}),
  });
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
  attach(router, socket.ws, 'delivered');

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
  attach(router, socket.ws, 'unregistered');

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

/**
 * The subset edge. `terminalAuthorityDeliveryDisposition` is SESSION-level; the skip
 * predicate is per-connection. `legacy-delivered` means the authority path delivered to the
 * views in `getTerminalAuthorityResponderViews`, which requires a registration AND matching
 * capabilities AND three agreeing generations AND being the newest open control socket.
 *
 * A connection holding a registration that fails any of those is NOT delivered to. Skipping
 * it on the strength of the registration alone converts duplicate delivery into MISSING
 * delivery for that connection -- strictly worse than the doubling, and the failure #110
 * existed to prevent, reintroduced through a different predicate.
 */
test('a registered view the authority path does not address still receives the fallback', () => {
  const router = createRouter();
  const socket = createSocket();
  attach(router, socket.ws, 'registered-but-not-delivered');

  const expected = producerLines();
  for (const line of expected) {
    router.routeSessionOutput(SESSION, `${line}\r\n`, 1, {}, 'legacy-unnegotiated');
  }

  assert.deepEqual(
    receivedMarkers(socket.sent),
    expected,
    'a connection with a registration outside the responder set received nothing: the skip '
    + 'predicate is wider than the set the authority path actually delivers to, so this '
    + 'connection is served by neither path',
  );
});
