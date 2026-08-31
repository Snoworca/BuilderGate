import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import { WsRouter } from './WsRouter.js';
import { binaryWirePayload, jsonWirePayload } from './wirePayload.js';
import type { WsTransportMessage } from './wsSendPolicy.js';

/**
 * The single send site (`01 §3.1`). Once `payload` is a union the call has to
 * name its branch, and the two branches reach `ws.send` with different
 * arguments — a string for JSON, a byte view plus `{ binary: true }` for a
 * frame. A JSON socket that received bytes would be undetectable on the wire,
 * so it is asserted here rather than left to the type checker alone.
 */

interface SentCall {
  readonly data: unknown;
  readonly options: unknown;
}

class RecordingWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: SentCall[] = [];

  send(data: unknown, options?: unknown, callback?: (error?: Error) => void): void {
    const cb = typeof options === 'function' ? options as (error?: Error) => void : callback;
    this.sent.push({ data, options: typeof options === 'function' ? undefined : options });
    cb?.();
  }

  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

interface RouterInternals {
  transportQueues: Map<WebSocket, unknown>;
  sendRawTransportMessage: (ws: WebSocket, message: WsTransportMessage) => void;
  terminalBinaryGroups: Map<string, { codecEpoch: number }>;
  clients: Map<WebSocket, unknown>;
  handleTerminalBinaryCapability: (ws: WebSocket, message: unknown) => void;
}

function setup() {
  const router = new WsRouter({} as AuthService, {} as SessionManager, {
    realtime: { wsTransportMode: 'unified' },
  });
  const socket = new RecordingWebSocket();
  const internals = router as unknown as RouterInternals;
  assert.ok(internals.transportQueues instanceof Map, 'WsRouter.transportQueues is no longer a Map');
  assert.equal(
    typeof internals.sendRawTransportMessage,
    'function',
    'WsRouter.sendRawTransportMessage is gone',
  );
  assert.ok(
    internals.terminalBinaryGroups instanceof Map,
    'WsRouter.terminalBinaryGroups is no longer a Map',
  );
  assert.ok(internals.clients instanceof Map, 'WsRouter.clients is no longer a Map');
  return { socket, ws: socket as unknown as WebSocket, internals };
}

function message(payload: WsTransportMessage['payload'], byteLength: number): WsTransportMessage {
  return { kind: 'control', payload, byteLength, queuedAt: 0 };
}

function negotiatedSetup() {
  const { socket, ws, internals } = setup();
  internals.clients.set(ws, {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
  internals.handleTerminalBinaryCapability(ws, {
    type: 'terminal-binary:capability',
    supportedFrameVersions: [1],
    acceptedFlagMask: 0x0001 | 0x0008,
  });
  const group = internals.terminalBinaryGroups.get('group-1');
  assert.ok(group, 'the group never negotiated');
  socket.sent.length = 0;
  return { socket, ws, internals, group };
}

test('a json payload reaches ws.send as text with no binary option', () => {
  const { socket, ws, internals } = setup();
  internals.sendRawTransportMessage(ws, message(jsonWirePayload('{"type":"subscribed"}'), 21));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0]!.data, '{"type":"subscribed"}');
  assert.equal(socket.sent[0]!.options, undefined);
});

test('a json payload settles once the socket reports the write', () => {
  const { ws, internals } = setup();
  const settled: Array<Error | undefined> = [];

  internals.sendRawTransportMessage(ws, {
    ...message(jsonWirePayload('{"type":"pong"}'), 15),
    onSettled: error => settled.push(error),
  });

  // Without the callback the queue never learns the write finished and the
  // socket stalls behind an in-flight message that already went out.
  assert.deepEqual(settled, [undefined]);
});

test('a binary payload settles once the socket reports the write', () => {
  const { ws, internals, group } = negotiatedSetup();
  const settled: Array<Error | undefined> = [];

  internals.sendRawTransportMessage(ws, {
    ...message(binaryWirePayload(Uint8Array.of(1), group.codecEpoch), 1),
    onSettled: error => settled.push(error),
  });

  assert.deepEqual(settled, [undefined]);
});

test('a binary payload reaches ws.send as bytes flagged binary', () => {
  const { socket, ws, internals, group } = negotiatedSetup();
  const bytes = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
  internals.sendRawTransportMessage(ws, message(binaryWirePayload(bytes, group.codecEpoch), 4));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0]!.data, bytes);
  assert.deepEqual(socket.sent[0]!.options, { binary: true });
});

test('a binary payload is not stringified on the way out', () => {
  const { socket, ws, internals, group } = negotiatedSetup();
  internals.sendRawTransportMessage(
    ws,
    message(binaryWirePayload(Uint8Array.of(1, 2), group.codecEpoch), 2),
  );
  assert.equal(typeof socket.sent[0]!.data, 'object');
});

// ---------------------------------------------------------------------------
// The codec epoch gate (`01:1193`).
// ---------------------------------------------------------------------------

test('a binary payload stamped with the live codec epoch is sent', () => {
  const { socket, ws, internals, group } = negotiatedSetup();

  internals.sendRawTransportMessage(
    ws,
    message(binaryWirePayload(Uint8Array.of(1), group.codecEpoch), 1),
  );

  assert.equal(socket.sent.length, 1);
});

test('a binary payload from a retired codec epoch is dropped, not re-encoded', () => {
  const { socket, ws, internals, group } = negotiatedSetup();
  const settled: Array<Error | undefined> = [];

  internals.sendRawTransportMessage(ws, {
    ...message(binaryWirePayload(Uint8Array.of(1), group.codecEpoch + 1), 1),
    onSettled: error => settled.push(error),
  });

  assert.equal(socket.sent.length, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.message, 'codec-epoch-retired');
});

test('a json payload is never subjected to the codec epoch gate', () => {
  const { socket, ws, internals } = negotiatedSetup();

  internals.sendRawTransportMessage(ws, message(jsonWirePayload('{"type":"pong"}'), 15));

  assert.equal(socket.sent.length, 1);
});

test('a binary payload on a socket with no group is dropped rather than sent blind', () => {
  const { socket, ws, internals } = setup();
  const settled: Array<Error | undefined> = [];

  internals.sendRawTransportMessage(ws, {
    ...message(binaryWirePayload(Uint8Array.of(1), 0), 1),
    onSettled: error => settled.push(error),
  });

  assert.equal(socket.sent.length, 0);
  assert.equal(settled[0]?.message, 'codec-epoch-retired');
});
