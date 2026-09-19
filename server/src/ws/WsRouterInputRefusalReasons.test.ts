import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';
import { createTerminalInputLedger } from './terminalInputLedger.js';

/**
 * #18 criterion 7 — the refusals a client receives have to be different facts.
 *
 * Measured 2026-09-19 before this file existed: the router's mapping from a ledger
 * outcome to an `input:rejected` reason had NO router-level test at all. The ledger's
 * own unit tests cover the outcomes and the wire union declares the reasons, but
 * nothing executed the translation between them, which is where criterion 7 actually
 * lives -- a state the server distinguishes internally and then flattens on the wire is
 * not distinguished as far as the client is concerned.
 *
 * Two flattenings are pinned here:
 *   - an operation the ledger cannot account for was admitted and RE-EXECUTED;
 *   - a stale target generation was reported as `driver-lease-unavailable`, although
 *     SessionManager had already computed `stale-view-generation` and thrown it away.
 */

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

const SESSION = 'session-input';

interface Harness {
  socket: FakeWebSocket;
  meta: WsClientMeta;
  send: (message: Record<string, unknown>) => void;
  rejections: () => Array<Record<string, unknown>>;
  lastRejection: () => Record<string, unknown> | undefined;
  destroy: () => void;
}

function createHarness(
  managerOverrides: Record<string, unknown> = {},
  ledgerBound?: number,
): Harness {
  const writes: string[] = [];
  const manager = {
    getSession: (sessionId: string) => ({ id: sessionId }),
    writeInput: (_sessionId: string, data: string) => { writes.push(data); return true; },
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    ...managerOverrides,
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'input-client',
    isAlive: true,
    subscribedSessions: new Set([SESSION]),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
    inputLedger: ReturnType<typeof createTerminalInputLedger>;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  if (ledgerBound !== undefined) {
    // The production bound is 512 remembered + 512 tombstoned, so reaching `unknown`
    // through the real ledger takes over 1000 messages. Driving that here made this file
    // starve the timing-sensitive sibling suites when node runs them in one process --
    // measured: WsRouterCheckpointProtocol went 15/15 alone and 5/15 co-run. The BOUND
    // itself is already pinned in terminalInputLedger.test.ts; what this file tests is the
    // router's mapping from outcome to wire reason, which a small bound exercises identically.
    internals.inputLedger = createTerminalInputLedger({ maxOperationsPerSession: ledgerBound });
  }

  return {
    socket,
    meta,
    send: (message) => internals.handleMessage(
      socket as unknown as WebSocket,
      JSON.stringify(message),
    ),
    rejections: () => socket.frames.filter((frame) => frame.type === 'input:rejected'),
    lastRejection: () => socket.frames.filter((frame) => frame.type === 'input:rejected').at(-1),
    destroy: () => router.destroy(),
  };
}

function inputMessage(seq: number, data = 'x'): Record<string, unknown> {
  return {
    type: 'input',
    sessionId: SESSION,
    data,
    inputOperationId: `e1:${seq}-${seq}`,
    inputSequencerEpoch: 1,
    inputSeqStart: seq,
    inputSeqEnd: seq,
  };
}

test('#18 criterion 6 a retry the ledger cannot account for is refused as unknown-operation', () => {
  const harness = createHarness({}, 2);
  try {
    // Six operations against a bound of 2 push operation 1 out of the live set and then
    // out of the tombstone set, which is the state `unknown` describes.
    for (let seq = 1; seq <= 6; seq += 1) harness.send(inputMessage(seq));
    const before = harness.rejections().length;

    harness.send(inputMessage(1));

    const rejection = harness.lastRejection();
    assert.equal(harness.rejections().length, before + 1, 'the retry must be refused, not written');
    assert.equal(rejection?.reason, 'unknown-operation');
  } finally {
    harness.destroy();
  }
});

test('#18 criterion 7 unknown-operation is not reported as expired-operation', () => {
  const harness = createHarness({}, 2);
  try {
    for (let seq = 1; seq <= 3; seq += 1) harness.send(inputMessage(seq));
    // Operation 1 is now a tombstone (evicted from the live set, not yet forgotten),
    // which is a POSITIVE fact -- it happened. That is a different sentence from
    // "I cannot account for this", and the client can act on each differently.
    harness.send(inputMessage(1));

    assert.equal(harness.lastRejection()?.reason, 'expired-operation');
  } finally {
    harness.destroy();
  }
});

test('#18 criterion 7 a stale target generation is reported as such, not as an unavailable lease', () => {
  // SessionManager already computes `stale-view-generation`; the router discarded the
  // reason and returned null, so the client was told the lease was unavailable -- which
  // invites a retry that cannot succeed, instead of telling it to resync its view.
  const harness = createHarness({
    adoptRetainedTerminalMutationLease: () => ({ ok: false, reason: 'stale-view-generation' }),
  });
  try {
    // A registered view holding no lease is what sends handleInput down the adoption path.
    harness.meta.retainedTerminalViews = new Map([[SESSION, 3]]);

    harness.send(inputMessage(1));

    assert.equal(harness.lastRejection()?.reason, 'stale-target-generation');
  } finally {
    harness.destroy();
  }
});

test('#18 criterion 7 an adoption failure that is not staleness still reports the lease reason', () => {
  // Boundary: the new reason must not swallow the old one. `driver-owned-by-other-client`
  // is a different situation -- the view is current, someone else holds the lease -- and
  // reporting it as staleness would send the client to resync a view that is already right.
  const harness = createHarness({
    adoptRetainedTerminalMutationLease: () => ({ ok: false, reason: 'driver-owned-by-other-client' }),
  });
  try {
    harness.meta.retainedTerminalViews = new Map([[SESSION, 3]]);

    harness.send(inputMessage(1));

    assert.equal(harness.lastRejection()?.reason, 'driver-lease-unavailable');
  } finally {
    harness.destroy();
  }
});

// --- #111 / #18 criterion 11: dedup must survive a reconnect ---------------------
//
// The ledger itself was never the problem -- it deduplicates whatever key it is given.
// The defect was the ROUTER's choice of key: `meta.connectionId`, a fresh uuid per socket,
// released on disconnect. So this case cannot be written at the ledger level at all; it
// only appears where the key is chosen, which is why it went unwritten for so long.

interface ReconnectHarness {
  connect: (logicalClientId: string) => { socket: FakeWebSocket; meta: WsClientMeta };
  disconnect: (socket: FakeWebSocket) => void;
  send: (socket: FakeWebSocket, message: Record<string, unknown>) => void;
  lastRejection: (socket: FakeWebSocket) => Record<string, unknown> | undefined;
  destroy: () => void;
}

function createReconnectHarness(): ReconnectHarness {
  const manager = {
    getSession: (sessionId: string) => ({ id: sessionId }),
    writeInput: () => true,
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
    handleDisconnect: (ws: WebSocket) => void;
  };
  let connectionOrdinal = 0;

  return {
    connect: (logicalClientId) => {
      connectionOrdinal += 1;
      const socket = new FakeWebSocket();
      const meta = {
        clientId: `client-${connectionOrdinal}`,
        // A real reconnect gets a brand-new connectionId. That is the whole point.
        connectionId: `connection-${connectionOrdinal}`,
        logicalClientId,
        isAlive: true,
        subscribedSessions: new Set([SESSION]),
        replayPendingSessions: new Map(),
        screenRepairPendingSessions: new Map(),
      } as unknown as WsClientMeta;
      internals.clients.set(socket as unknown as WebSocket, meta);
      return { socket, meta };
    },
    disconnect: (socket) => internals.handleDisconnect(socket as unknown as WebSocket),
    send: (socket, message) => internals.handleMessage(
      socket as unknown as WebSocket,
      JSON.stringify(message),
    ),
    lastRejection: (socket) => socket.frames
      .filter((frame) => frame.type === 'input:rejected').at(-1),
    destroy: () => router.destroy(),
  };
}

test('#111 AC-2 an operation resent on a NEW connection is not written to the PTY twice', () => {
  const harness = createReconnectHarness();
  try {
    const first = harness.connect('tab-1');
    harness.send(first.socket, inputMessage(1));

    // The socket drops and the client reconnects. Connection-owned state settles here;
    // the dedup record must not.
    harness.disconnect(first.socket);
    const second = harness.connect('tab-1');
    harness.send(second.socket, inputMessage(1));

    assert.equal(
      harness.lastRejection(second.socket)?.reason,
      'duplicate-operation',
      'a resend after reconnect must be refused, not written a second time',
    );
  } finally {
    harness.destroy();
  }
});

test('#111 AC-2 a genuinely new operation after a reconnect still reaches the PTY', () => {
  const harness = createReconnectHarness();
  try {
    const first = harness.connect('tab-1');
    harness.send(first.socket, inputMessage(1));
    harness.disconnect(first.socket);

    const second = harness.connect('tab-1');
    harness.send(second.socket, inputMessage(2));

    // Preserving the record must not freeze the terminal: only the RESENT operation is
    // refused, and everything typed afterwards still runs.
    assert.equal(harness.lastRejection(second.socket), undefined);
  } finally {
    harness.destroy();
  }
});

test('#111 criterion 11 two different logical clients keep separate ledgers', () => {
  const harness = createReconnectHarness();
  try {
    const tabOne = harness.connect('tab-1');
    harness.send(tabOne.socket, inputMessage(1));

    // Boundary: preserving across reconnect must not start sharing across tabs. Two tabs
    // legitimately issue the same sequence numbers and neither may suppress the other.
    const tabTwo = harness.connect('tab-2');
    harness.send(tabTwo.socket, inputMessage(1));

    assert.equal(harness.lastRejection(tabTwo.socket), undefined);
  } finally {
    harness.destroy();
  }
});
