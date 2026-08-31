import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';

/**
 * The router half of the binary data plane: `subscribed` gains the channel a
 * session was given, and only when the group actually speaks binary.
 *
 * The first test is the one that matters most — with the default configuration
 * the message must be indistinguishable from today's, because that is what
 * makes every other piece of this feature safe to have merged.
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

const SESSION_ID = 'session-a';

const authorityLookups: string[] = [];

function fakeSessionManager(options: { authority?: boolean } = {}): SessionManager {
  return {
    getSession: (id: string) => (id === SESSION_ID ? { id, status: 'running' } : undefined),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
    // No snapshot yet, so a fresh subscribe takes the restore-pending branch —
    // which still has to carry the channel fields.
    getScreenSnapshot: () => undefined,
    getTerminalAuthorityState: (id: string) => {
      authorityLookups.push(id);
      return id === SESSION_ID && options.authority !== false
        ? { sessionId: id, streamEpoch: '4', authorityEpoch: 'authority-uuid' }
        : undefined;
    },
  } as unknown as SessionManager;
}

interface RouterInternals {
  clients: Map<WebSocket, WsClientMeta>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  handleSubscribe: (ws: WebSocket, sessionIds: string[]) => void;
  handleTerminalBinaryCapability: (ws: WebSocket, message: unknown) => void;
  handleUnsubscribe: (ws: WebSocket, sessionIds: string[]) => void;
  handleTerminalBinaryUnknownChannel: (ws: WebSocket, message: unknown) => void;
  terminalBinaryGroups: Map<string, unknown>;
  splitClientGroups: Map<string, unknown>;
  forgetSplitClientGroup: (clientGroupId: string) => void;
}

const VALID_OFFER = {
  type: 'terminal-binary:capability',
  supportedFrameVersions: [1],
  // END_OF_BATCH | PROLOGUE_PRESENT — both are mandatory (`01 §2.2`).
  acceptedFlagMask: 0x0001 | 0x0008,
} as const;

function negotiationReply(socket: FakeWebSocket): Record<string, unknown> {
  const frame = socket.frames.find(
    f => f.type === 'terminal-binary:capability' || f.type === 'terminal-binary:rejected',
  );
  assert.ok(frame, 'the server never answered the offer');
  return frame;
}

function setup(terminalWireFormat: TerminalWireFormat, options: { authority?: boolean } = {}) {
  authorityLookups.length = 0;
  const router = new WsRouter({} as AuthService, fakeSessionManager(options), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const meta: WsClientMeta = {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta;

  const internals = router as unknown as RouterInternals;
  // Reading private state through a cast goes vacuous the moment the shape
  // changes, so the shape is asserted rather than assumed.
  assert.ok(internals.clients instanceof Map, 'WsRouter.clients is no longer a Map');
  assert.ok(internals.sessionSubscribers instanceof Map, 'WsRouter.sessionSubscribers is no longer a Map');
  assert.equal(typeof internals.handleSubscribe, 'function', 'WsRouter.handleSubscribe is gone');
  assert.equal(
    typeof internals.handleTerminalBinaryCapability,
    'function',
    'WsRouter.handleTerminalBinaryCapability is gone',
  );
  assert.equal(typeof internals.handleUnsubscribe, 'function', 'WsRouter.handleUnsubscribe is gone');
  assert.equal(
    typeof internals.handleTerminalBinaryUnknownChannel,
    'function',
    'WsRouter.handleTerminalBinaryUnknownChannel is gone',
  );
  assert.ok(
    internals.terminalBinaryGroups instanceof Map,
    'WsRouter.terminalBinaryGroups is no longer a Map',
  );
  assert.ok(
    internals.splitClientGroups instanceof Map,
    'WsRouter.splitClientGroups is no longer a Map',
  );
  assert.equal(
    typeof internals.forgetSplitClientGroup,
    'function',
    'WsRouter.forgetSplitClientGroup is gone',
  );

  internals.clients.set(ws, meta);
  // Pre-subscribing takes the `alreadySubscribed` branch, which is the shortest
  // path to a populated `subscribed` row.
  internals.sessionSubscribers.set(SESSION_ID, new Set([ws]));
  meta.subscribedSessions.add(SESSION_ID);

  return { router, socket, ws, internals };
}

function subscribedRow(socket: FakeWebSocket): Record<string, unknown> {
  const frame = socket.frames.find(f => f.type === 'subscribed');
  assert.ok(frame, 'no subscribed frame was sent');
  const sessions = frame.sessions as Record<string, unknown>[];
  assert.equal(sessions.length, 1);
  return sessions[0];
}

// ---------------------------------------------------------------------------
// 1. The default must be invisible.
// ---------------------------------------------------------------------------

test('the default configuration adds no field to a subscribed row', () => {
  const { socket, internals, ws } = setup('json');

  internals.handleSubscribe(ws, [SESSION_ID]);

  // Exactly today's shape. A new key here would reach every existing client.
  assert.deepEqual(
    Object.keys(subscribedRow(socket)).sort(),
    ['cwd', 'ready', 'sessionId', 'status'],
  );
});

test('shadow adds no field either', () => {
  const { socket, internals, ws } = setup('binary-shadow');

  internals.handleSubscribe(ws, [SESSION_ID]);

  assert.equal(subscribedRow(socket).channelId, undefined);
});

// ---------------------------------------------------------------------------
// 2. A negotiable group still stays quiet until the handshake completes.
// ---------------------------------------------------------------------------

test('a binary-configured group adds nothing before negotiation', () => {
  const { socket, internals, ws } = setup('binary');

  // Negotiation happens after `connected`, and a subscribe can arrive first.
  internals.handleSubscribe(ws, [SESSION_ID]);

  assert.equal(subscribedRow(socket).channelId, undefined);
});

// ---------------------------------------------------------------------------
// 3. The row is still well formed when the session is unknown.
// ---------------------------------------------------------------------------

test('an unknown session reports an error row with no channel', () => {
  const { socket, internals, ws } = setup('binary');

  internals.handleSubscribe(ws, ['no-such-session']);

  const row = subscribedRow(socket);
  assert.equal(row.status, 'error');
  assert.equal(row.channelId, undefined);
});

// ---------------------------------------------------------------------------
// 4. The negotiation handler.
// ---------------------------------------------------------------------------

test('the default configuration rejects an offer as group-not-eligible', () => {
  const { socket, internals, ws } = setup('json');

  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  const reply = negotiationReply(socket);
  assert.equal(reply.type, 'terminal-binary:rejected');
  assert.equal(reply.reason, 'group-not-eligible');
  assert.equal(reply.phase, 'offer');
  assert.deepEqual(reply.supportedFrameVersions, [1]);
});

test('shadow rejects an offer too, because that rung sends no frames', () => {
  const { socket, internals, ws } = setup('binary-shadow');

  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  assert.equal(negotiationReply(socket).reason, 'group-not-eligible');
});

test('a binary-configured group accepts a well formed offer', () => {
  const { socket, internals, ws } = setup('binary');

  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  const reply = negotiationReply(socket);
  assert.equal(reply.type, 'terminal-binary:capability');
  assert.equal(reply.accepted, true);
  assert.equal(reply.frameVersion, 1);
  assert.deepEqual(reply.channels, []);
});

test('an offer missing a mandatory flag is rejected by name', () => {
  const { socket, internals, ws } = setup('binary');

  internals.handleTerminalBinaryCapability(ws, { ...VALID_OFFER, acceptedFlagMask: 0x0001 });

  assert.equal(negotiationReply(socket).reason, 'mandatory-flag-not-accepted');
});

test('a malformed offer is rejected as invalid-message, not ignored', () => {
  const { socket, internals, ws } = setup('binary');

  internals.handleTerminalBinaryCapability(ws, { type: 'terminal-binary:capability' });

  assert.equal(negotiationReply(socket).reason, 'invalid-message');
});

test('an offer whose versions do not intersect is rejected as unsupported-version', () => {
  const { socket, internals, ws } = setup('binary');

  internals.handleTerminalBinaryCapability(ws, { ...VALID_OFFER, supportedFrameVersions: [99] });

  assert.equal(negotiationReply(socket).reason, 'unsupported-version');
});

test('a session subscribed after a successful handshake is given a channel', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  internals.handleSubscribe(ws, [SESSION_ID]);

  const row = subscribedRow(socket);
  assert.equal(typeof row.channelId, 'number');
  assert.notEqual(row.channelId, 0, 'channel 0 is permanently reserved (01 §1.5)');
});

test('a rejected handshake leaves subscribed rows unchanged', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, { ...VALID_OFFER, supportedFrameVersions: [99] });

  internals.handleSubscribe(ws, [SESSION_ID]);

  assert.equal(subscribedRow(socket).channelId, undefined);
});

test('the group keeps one session across offers, so a second offer sees the live table', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.handleSubscribe(ws, [SESSION_ID]);
  const opened = subscribedRow(socket).channelId;

  socket.frames.length = 0;
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  const reply = negotiationReply(socket);
  assert.equal(reply.accepted, true);
  assert.deepEqual(
    (reply.channels as Array<{ channelId: number }>).map(c => c.channelId),
    [opened],
  );
});

// ---------------------------------------------------------------------------
// 5. Retiring a channel.
// ---------------------------------------------------------------------------

function retiredNotice(socket: FakeWebSocket): Record<string, unknown> | undefined {
  return socket.frames.find(f => f.type === 'terminal-binary:channel-retired');
}

test('unsubscribing announces the channel that was retired', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.handleSubscribe(ws, [SESSION_ID]);
  const opened = subscribedRow(socket).channelId;
  socket.frames.length = 0;

  internals.handleUnsubscribe(ws, [SESSION_ID]);

  const notice = retiredNotice(socket);
  assert.ok(notice, 'no retirement notice was sent');
  assert.deepEqual(notice.channelIds, [opened]);
  assert.equal(notice.reason, 'unsubscribed');
});

test('unsubscribing a session that never had a channel announces nothing', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  socket.frames.length = 0;

  internals.handleUnsubscribe(ws, [SESSION_ID]);

  assert.equal(retiredNotice(socket), undefined);
});

test('a json group announces nothing on unsubscribe', () => {
  const { socket, internals, ws } = setup('json');
  internals.handleSubscribe(ws, [SESSION_ID]);
  socket.frames.length = 0;

  internals.handleUnsubscribe(ws, [SESSION_ID]);

  assert.equal(retiredNotice(socket), undefined);
});

test('a retired channel id is not handed out again', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.handleSubscribe(ws, [SESSION_ID]);
  const first = subscribedRow(socket).channelId;
  internals.handleUnsubscribe(ws, [SESSION_ID]);
  socket.frames.length = 0;

  internals.handleSubscribe(ws, [SESSION_ID]);

  // `01 §1.5` — ids are never reused within a codecEpoch, so a late frame for
  // the old channel cannot land on the new one.
  assert.notEqual(subscribedRow(socket).channelId, first);
});

test('a json group never queries authority state while subscribing', () => {
  const { internals, ws } = setup('json');

  internals.handleSubscribe(ws, [SESSION_ID]);

  // The default rung must add no work at all, not merely no fields.
  assert.deepEqual(authorityLookups, []);
});

test('a known session with no authority state gets no channel rather than a fabricated one', () => {
  const { socket, internals, ws } = setup('binary', { authority: false });
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  internals.handleSubscribe(ws, [SESSION_ID]);

  const row = subscribedRow(socket);
  assert.equal(row.channelId, undefined);
  assert.equal(row.streamEpoch, undefined);
  assert.equal(row.authorityEpoch, undefined);
});

test('a router configured with no wire format at all refuses to speak binary', () => {
  // The whole feature is gated on this default. Every other test names the rung
  // explicitly, so without this one the default is never exercised.
  const router = new WsRouter({} as AuthService, fakeSessionManager(), {
    realtime: { wsTransportMode: 'unified' },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const internals = router as unknown as RouterInternals;
  internals.clients.set(ws, {
    clientId: 'client-default',
    clientGroupId: 'group-default',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta);

  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  assert.equal(negotiationReply(socket).reason, 'group-not-eligible');
});

test('a client that never offers binary allocates no group state', () => {
  const { internals, ws } = setup('binary');

  internals.handleSubscribe(ws, [SESSION_ID]);
  internals.handleUnsubscribe(ws, [SESSION_ID]);

  // Even on the binary rung, the group is the client's to ask for.
  assert.equal(internals.terminalBinaryGroups.size, 0);
});

test('offering binary allocates exactly one group', () => {
  const { internals, ws } = setup('binary');

  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  assert.equal(internals.terminalBinaryGroups.size, 1);
});

test('a group whose handshake was rejected does no binary work while subscribing', () => {
  const { internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, { ...VALID_OFFER, supportedFrameVersions: [99] });
  authorityLookups.length = 0;

  internals.handleSubscribe(ws, [SESSION_ID]);

  // The group exists but is on JSON, so it must behave exactly like one that
  // never offered at all.
  assert.deepEqual(authorityLookups, []);
});

// ---------------------------------------------------------------------------
// 6. Repairing a client that reports an unknown channel.
// ---------------------------------------------------------------------------

test('an unknown-channel report is answered with the authoritative table', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.handleSubscribe(ws, [SESSION_ID]);
  const opened = subscribedRow(socket).channelId as number;
  socket.frames.length = 0;

  internals.handleTerminalBinaryUnknownChannel(ws, {
    type: 'terminal-binary:unknown-channel',
    channelIds: [opened],
  });

  // The acceptance is what the client applies as the table for this epoch, so
  // re-sending it repairs a missing row without renegotiating the codec.
  const reply = negotiationReply(socket);
  assert.equal(reply.type, 'terminal-binary:capability');
  assert.equal(reply.accepted, true);
  assert.deepEqual(
    (reply.channels as Array<{ channelId: number }>).map(row => row.channelId),
    [opened],
  );
});

test('an unknown-channel report never renegotiates the codec epoch', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  const before = (negotiationReply(socket).codecEpoch as number);
  socket.frames.length = 0;

  internals.handleTerminalBinaryUnknownChannel(ws, {
    type: 'terminal-binary:unknown-channel',
    channelIds: [1],
  });

  // A bump would invalidate every frame already in flight on this group.
  assert.equal(negotiationReply(socket).codecEpoch, before);
});

test('a group that never negotiated answers nothing rather than crashing', () => {
  const { socket, internals, ws } = setup('json');

  internals.handleTerminalBinaryUnknownChannel(ws, {
    type: 'terminal-binary:unknown-channel',
    channelIds: [1],
  });

  assert.equal(socket.frames.length, 0);
});

test('a malformed unknown-channel report is refused, not answered', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  socket.frames.length = 0;

  internals.handleTerminalBinaryUnknownChannel(ws, { type: 'terminal-binary:unknown-channel' });

  assert.equal(socket.frames.length, 0);
});

test('an unknown-channel report never establishes a handshake that was refused', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, { ...VALID_OFFER, supportedFrameVersions: [99] });
  socket.frames.length = 0;

  internals.handleTerminalBinaryUnknownChannel(ws, {
    type: 'terminal-binary:unknown-channel',
    channelIds: [1],
  });

  // Repair must never be a way in: a group the server refused stays on JSON.
  assert.equal(socket.frames.length, 0);
});

test('a repaired group keeps sending plain subscribed rows for unknown sessions', () => {
  const { socket, internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.handleTerminalBinaryUnknownChannel(ws, {
    type: 'terminal-binary:unknown-channel',
    channelIds: [1],
  });
  socket.frames.length = 0;

  internals.handleSubscribe(ws, ['no-such-session']);

  assert.equal(subscribedRow(socket).status, 'error');
  assert.equal(subscribedRow(socket).channelId, undefined);
});

// ---------------------------------------------------------------------------
// 7. Tearing a connection group down.
// ---------------------------------------------------------------------------

test('forgetting a group drops its binary session along with the split group', () => {
  const { internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);
  internals.splitClientGroups.set('group-1', { clientGroupId: 'group-1' });
  assert.equal(internals.terminalBinaryGroups.size, 1, 'the group never negotiated');

  internals.forgetSplitClientGroup('group-1');

  // Both stores are keyed by the same id. A surviving binary session would keep
  // handing out channel ids for a group that no longer exists.
  assert.equal(internals.terminalBinaryGroups.size, 0);
  assert.equal(internals.splitClientGroups.size, 0);
});

test('forgetting an unknown group is not an error and touches nothing', () => {
  const { internals, ws } = setup('binary');
  internals.handleTerminalBinaryCapability(ws, VALID_OFFER);

  internals.forgetSplitClientGroup('group-that-never-existed');

  assert.equal(internals.terminalBinaryGroups.size, 1);
});
