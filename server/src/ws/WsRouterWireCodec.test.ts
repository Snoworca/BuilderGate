import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';
import { decodeWsMessage, createV1DecodeContext, DATA_PLANE_OPCODE } from './binaryFrameCodec.js';

/**
 * SDS 2026-09-21.binary-data-plane-optin — SDS-AC-1/2/3/4/5/12.
 *
 * Measured 2026-09-21: every one of WsRouter's four `createWsTransportMessage`
 * call sites omitted the codec argument, so `terminalWireFormat` changed only
 * what `/api/runtime-config` reported while the wire stayed JSON. These tests
 * drive real PTY output through `routeSessionOutput` and look at what reaches
 * the socket, which is the only place the ladder is observable.
 */

type Sent = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Uint8Array };

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Sent[] = [];
  send(payload: string | Uint8Array, optionsOrCb?: unknown, cb?: (error?: Error) => void): void {
    if (typeof payload === 'string') this.sent.push({ kind: 'text', text: payload });
    else this.sent.push({ kind: 'binary', bytes: payload });
    (typeof optionsOrCb === 'function' ? optionsOrCb as () => void : cb)?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
  texts(): Array<Record<string, unknown>> {
    return this.sent.filter(s => s.kind === 'text').map(s => JSON.parse((s as { text: string }).text));
  }
  binaries(): Uint8Array[] { return this.sent.filter(s => s.kind === 'binary').map(s => (s as { bytes: Uint8Array }).bytes); }
}

const SESSION_ID = 'session-a';
const VALID_OFFER = { type: 'terminal-binary:negotiate', supportedFrameVersions: [1], acceptedFlagMask: 0x0001 | 0x0008 } as const;

function fakeSessionManager(): SessionManager {
  return {
    getSession: (id: string) => (id === SESSION_ID ? { id, status: 'running' } : undefined),
    getLastCwd: () => 'C:/work',
    isSessionReady: () => true,
    getScreenSnapshot: () => undefined,
    getTerminalAuthorityState: (id: string) => (id === SESSION_ID
      ? { sessionId: id, streamEpoch: '4', authorityEpoch: 'authority-uuid' }
      : undefined),
  } as unknown as SessionManager;
}

interface Internals {
  clients: Map<WebSocket, WsClientMeta>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  handleSubscribe: (ws: WebSocket, sessionIds: string[]) => void;
  handleTerminalBinaryCapability: (ws: WebSocket, message: unknown) => void;
  terminalBinaryGroups: Map<string, { isNegotiated: boolean; codecEpoch: number; shadowMismatch: number; codecFallback: number }>;
}

function setup(terminalWireFormat: TerminalWireFormat) {
  const router = new WsRouter({} as AuthService, fakeSessionManager(), {
    realtime: { wsTransportMode: 'unified', terminalWireFormat },
  });
  const socket = new FakeWebSocket();
  const ws = socket as unknown as WebSocket;
  const meta = {
    clientId: 'client-1', clientGroupId: 'group-1', wsTransportMode: 'unified', isAlive: true,
    subscribedSessions: new Set(), replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  } as unknown as WsClientMeta;
  const internals = router as unknown as Internals;
  assert.ok(internals.clients instanceof Map);
  internals.clients.set(ws, meta);
  internals.sessionSubscribers.set(SESSION_ID, new Set([ws]));
  meta.subscribedSessions.add(SESSION_ID);
  return { router, socket, ws, internals };
}

function negotiate(t: ReturnType<typeof setup>) {
  t.internals.handleTerminalBinaryCapability(t.ws, VALID_OFFER);
  const reply = t.socket.texts().find(f => f.type === 'terminal-binary:capability' || f.type === 'terminal-binary:rejected');
  assert.equal(reply?.type, 'terminal-binary:capability', `negotiation failed: ${JSON.stringify(reply)}`);
  t.internals.handleSubscribe(t.ws, [SESSION_ID]); // opens the channel
  t.socket.sent.length = 0;
}

function outputTexts(socket: FakeWebSocket) { return socket.texts().filter(f => f.type === 'output'); }

// --- SDS-AC-1 ---------------------------------------------------------------

test('SDS-AC-1 on the json rung output is a JSON text frame and no binary frame is ever produced', () => {
  const t = setup('json');
  t.router.routeSessionOutput(SESSION_ID, 'hello', 1);
  assert.equal(t.socket.binaries().length, 0);
  assert.equal(outputTexts(t.socket).length, 1);
  assert.equal(outputTexts(t.socket)[0].data, 'hello');
});

// --- SDS-AC-2 / SDS-AC-3 (shadow) ------------------------------------------

test('SDS-AC-2 binary-shadow keeps the wire on JSON while the group records a clean comparison', () => {
  const t = setup('binary-shadow');
  t.router.routeSessionOutput(SESSION_ID, 'hello \x1b[31mred\x1b[0m', 1);
  assert.equal(t.socket.binaries().length, 0, 'shadow must not put binary on the wire');
  assert.equal(outputTexts(t.socket).length, 1);
  const group = t.internals.terminalBinaryGroups.get('group-1');
  assert.ok(group, 'shadow must allocate the group so the comparison has somewhere to be recorded');
  assert.equal(group.shadowMismatch, 0);
});

test('SDS-AC-3 a shadow mismatch is counted once and halts shadow for that group only', () => {
  const t = setup('binary-shadow');
  // A lone surrogate survives JSON.stringify but UTF-8 encodes to U+FFFD, so the
  // decoded body cannot equal `data`. Real bug class, no fault injection needed.
  t.router.routeSessionOutput(SESSION_ID, 'a\uD800b', 1);
  const group = t.internals.terminalBinaryGroups.get('group-1')!;
  assert.equal(group.shadowMismatch, 1);
  t.router.routeSessionOutput(SESSION_ID, 'a\uD800b', 2);
  assert.equal(group.shadowMismatch, 1, 'after a halt the group must stop comparing');
  assert.equal(t.socket.binaries().length, 0);
  assert.equal(outputTexts(t.socket).length, 2, 'the JSON wire is unaffected');

  const other = setup('binary-shadow');
  other.router.routeSessionOutput(SESSION_ID, 'clean', 1);
  assert.equal(other.internals.terminalBinaryGroups.get('group-1')!.shadowMismatch, 0, 'another router/group is unaffected');
});

// --- SDS-AC-4 / SDS-AC-5 (optin) -------------------------------------------

test('SDS-AC-4 binary-optin sends negotiated output as a binary frame and control as text', () => {
  const t = setup('binary-optin');
  negotiate(t);
  t.router.routeSessionOutput(SESSION_ID, 'hello', 7);
  t.router.sendTo(t.ws, { type: 'pong' });

  const frames = t.socket.binaries();
  assert.equal(frames.length, 1, `expected one binary frame, got ${JSON.stringify(t.socket.sent.map(s => s.kind))}`);
  assert.equal(outputTexts(t.socket).length, 0, 'output must not also go out as JSON');
  assert.ok(t.socket.texts().some(f => f.type === 'pong'), 'control stays JSON');

  const decoded = decodeWsMessage(frames[0], createV1DecodeContext({
    maxBodyBytes: 1 << 20,
    channelState: () => ({ state: 'open' } as never),
  }));
  assert.equal(decoded.fatal, undefined, JSON.stringify(decoded));
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].opcode, DATA_PLANE_OPCODE.OUTPUT);
  // OUTPUT prologue is 24 bytes; the body follows it (no segments here).
  assert.equal(new TextDecoder().decode(decoded.frames[0].payload.subarray(24)), 'hello');
});

test('SDS-AC-5 a negotiated group falls back to JSON for a session with no channel and counts it', () => {
  const t = setup('binary-optin');
  negotiate(t);
  // A second session the group never opened a channel for.
  t.internals.sessionSubscribers.set('session-b', new Set([t.ws]));
  (t.internals.clients.get(t.ws)!.subscribedSessions as Set<string>).add('session-b');
  t.router.routeSessionOutput('session-b', 'orphan', 1);
  assert.equal(t.socket.binaries().length, 0);
  assert.equal(outputTexts(t.socket).length, 1);
  assert.equal(t.internals.terminalBinaryGroups.get('group-1')!.codecFallback, 1);
});

// --- SDS-AC-12 ---------------------------------------------------------------

test('SDS-AC-12 byteLength is the wire size of whichever codec was used while the body is codec-independent', () => {
  const json = setup('json'); json.router.routeSessionOutput(SESSION_ID, 'hello', 1);
  const bin = setup('binary-optin'); negotiate(bin); bin.router.routeSessionOutput(SESSION_ID, 'hello', 1);
  const jsonWire = Buffer.byteLength((json.socket.sent[0] as { text: string }).text, 'utf8');
  const binWire = bin.socket.binaries()[0].byteLength;
  assert.notEqual(jsonWire, binWire, 'the two codecs have different wire sizes');
  assert.ok(binWire > Buffer.byteLength('hello', 'utf8'), 'frame = header + prologue + body');
});
