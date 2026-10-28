import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import { WsRouter } from './WsRouter.js';

// REL-BGSTAB-054: the disconnect line says who closed the socket and why. Without it a
// production log shows reconnects but not which browser recovery path asked for them.

interface RouterInternals {
  handleSocketClose: (ws: WebSocket, code?: number, reason?: Buffer) => void;
  clients: Map<WebSocket, unknown>;
}

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send(): void {}
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

function closeAndCapture(code: number, reason: Buffer): string[] {
  const router = new WsRouter({} as AuthService, {} as SessionManager, {
    realtime: { wsTransportMode: 'unified' },
  });
  const ws = new FakeWebSocket() as unknown as WebSocket;
  const internals = router as unknown as RouterInternals;
  internals.clients.set(ws, {
    clientId: 'client-1',
    clientGroupId: 'group-1',
    wsTransportMode: 'unified',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    internals.handleSocketClose(ws, code, reason);
  } finally {
    console.log = original;
  }
  return lines.filter((line) => line.startsWith('[WS] Client disconnected'));
}

// @req REL-BGSTAB-054
test('REL-BGSTAB-054 AC-1: the disconnect line carries the close code and reason', () => {
  const lines = closeAndCapture(4001, Buffer.from('screen-repair-reconnect-required'));
  assert.deepEqual(lines, [
    '[WS] Client disconnected: client-1 code=4001 reason="screen-repair-reconnect-required"',
  ]);
});

// @req REL-BGSTAB-054
test('REL-BGSTAB-054 AC-1: an empty reason is shown as empty', () => {
  const lines = closeAndCapture(1006, Buffer.alloc(0));
  assert.deepEqual(lines, ['[WS] Client disconnected: client-1 code=1006 reason=""']);
});

// @req REL-BGSTAB-054
test('REL-BGSTAB-054 AC-2: control characters are removed and the reason is capped at 123 bytes', () => {
  const lines = closeAndCapture(4001, Buffer.from(`a\nb\r\u0000c${'x'.repeat(200)}`));
  assert.equal(lines.length, 1);
  const reason = /reason="(.*)"$/.exec(lines[0])?.[1] ?? '';
  assert.ok(reason.startsWith('abc'), reason);
  assert.ok(Buffer.byteLength(reason) <= 123, `${Buffer.byteLength(reason)} bytes`);
});
