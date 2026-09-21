import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';

/**
 * SDS-AC-7 / SDS-AC-10 / SDS-AC-11 (IR-BGSTAB-001 AC-4).
 *
 * Four triggers, one function. The value of a single rollback path is that the
 * MIG-BGSTAB-002 AC-5 order is written once; the risk is that a later trigger
 * quietly grows its own copy, which is what the caller contract and these
 * order assertions exist to stop.
 */

const SESSION_ID = 'session-a';
const OFFER = { type: 'terminal-binary:negotiate', supportedFrameVersions: [1], acceptedFlagMask: 0x0001 | 0x0008 } as const;

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  send(payload: string | Uint8Array, o?: unknown, c?: (e?: Error) => void): void {
    this.sent.push(payload);
    (typeof o === 'function' ? o as () => void : c)?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
  texts(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === 'string').map(s => JSON.parse(s));
  }
  binaryCount(): number { return this.sent.filter(s => typeof s !== 'string').length; }
}

function sessionManager(): SessionManager {
  return {
    getSession: (id: string) => (id === SESSION_ID ? { id, status: 'running' } : undefined),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
    getScreenSnapshot: () => undefined,
    getTerminalAuthorityState: (id: string) => ({ sessionId: id, streamEpoch: '4', authorityEpoch: 'a' }),
  } as unknown as SessionManager;
}

interface Internals {
  clients: Map<WebSocket, WsClientMeta>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  handleSubscribe: (ws: WebSocket, ids: string[]) => void;
  handleTerminalBinaryCapability: (ws: WebSocket, message: unknown) => void;
  handleTerminalBinaryDecodeFailure: (ws: WebSocket, message: unknown) => void;
  terminalBinaryGroups: Map<string, { codecEpoch: number; isNegotiated: boolean; lookupChannel: (id: string) => unknown }>;
  rollbackTerminalBinaryGroup: (key: string, trigger: string) => void;
  handleMessage: (ws: WebSocket, raw: string) => void;
}

function negotiatedRouter(format: TerminalWireFormat = 'binary-optin') {
  const router = new WsRouter({} as AuthService, sessionManager(), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat: format },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const meta = {
    clientId: 'c1', clientGroupId: 'group-1', wsTransportMode: 'unified', isAlive: true,
    subscribedSessions: new Set([SESSION_ID]), replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta;
  const internals = router as unknown as Internals;
  internals.clients.set(ws, meta);
  internals.sessionSubscribers.set(SESSION_ID, new Set([ws]));
  internals.handleTerminalBinaryCapability(ws, OFFER);
  internals.handleSubscribe(ws, [SESSION_ID]);
  socket.sent.length = 0;
  return { router, socket, ws, internals };
}

test('SDS-AC-7 a rollback bumps the codec epoch, retires the channels and returns the group to JSON', () => {
  const t = negotiatedRouter();
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  const before = group.codecEpoch;
  assert.notEqual(group.lookupChannel(SESSION_ID), undefined, 'precondition: a channel is open');

  t.internals.rollbackTerminalBinaryGroup('group-1', 'hot-reload');

  assert.ok(group.codecEpoch > before, 'the epoch must move so in-flight frames are refused');
  assert.equal(group.isNegotiated, false, 'the acceptance the client holds no longer describes the group');
  assert.equal(group.lookupChannel(SESSION_ID), undefined, 'channels are taken back');
  const retired = t.socket.texts().find(f => f.type === 'terminal-binary:channel-retired');
  assert.ok(retired, 'the client must be told which channels are gone');

  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_ID, 'after-rollback', 1);
  assert.equal(t.socket.binaryCount(), 0, 'after a rollback the group sends JSON');
  assert.ok(t.socket.texts().some(f => f.type === 'output' && f.data === 'after-rollback'));
});

test('SDS-AC-7 rolling back a group that never negotiated is a no-op, not a throw', () => {
  const router = new WsRouter({} as AuthService, sessionManager(), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'binary-optin' },
  });
  (router as unknown as Internals).rollbackTerminalBinaryGroup('nobody', 'server-restart');
});

test('SDS-AC-11 narrowing the wire format rolls every negotiated group back', () => {
  const t = negotiatedRouter();
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  const before = group.codecEpoch;

  t.router.applyTerminalWireFormat('json');

  assert.ok(group.codecEpoch > before, 'narrowing must roll back');
  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_ID, 'x', 1);
  assert.equal(t.socket.binaryCount(), 0);
});

test('SDS-AC-11 widening the wire format leaves a live group untouched', () => {
  // Control for the test above: rolling back on every change would pass it too,
  // and would tear down a stream whose client is reading it correctly.
  const t = negotiatedRouter();
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  const before = group.codecEpoch;

  t.router.applyTerminalWireFormat('binary');

  assert.equal(group.codecEpoch, before, 'widening must not disturb a live group');
  assert.equal(group.isNegotiated, true);
  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_ID, 'still-binary', 1);
  assert.equal(t.socket.binaryCount(), 1, 'the group keeps speaking binary');
});

test('SDS-AC-11 setting the same wire format changes nothing', () => {
  const t = negotiatedRouter();
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  const before = group.codecEpoch;
  t.router.applyTerminalWireFormat('binary-optin');
  assert.equal(group.codecEpoch, before);
});

test('SDS-AC-10 a client decode failure is routed to the one rollback function', () => {
  const t = negotiatedRouter();
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  const before = group.codecEpoch;

  t.internals.handleMessage(t.ws, JSON.stringify({
    type: 'terminal-binary:decode-failure',
    code: 'frame-header-truncated',
  }));

  assert.ok(group.codecEpoch > before, 'a client that cannot decode must be taken off binary');
  t.socket.sent.length = 0;
  t.router.routeSessionOutput(SESSION_ID, 'recovered', 1);
  assert.equal(t.socket.binaryCount(), 0);
  assert.ok(t.socket.texts().some(f => f.type === 'output' && f.data === 'recovered'));
});

test('SDS-AC-10 a malformed decode-failure report does not roll anything back', () => {
  // Control: a rollback anyone can trigger with a junk message is a denial of
  // service against the whole group.
  const t = negotiatedRouter();
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  const before = group.codecEpoch;
  t.internals.handleMessage(t.ws, JSON.stringify({ type: 'terminal-binary:decode-failure' }));
  assert.equal(group.codecEpoch, before, 'a report with no code is not a decode failure');
});
