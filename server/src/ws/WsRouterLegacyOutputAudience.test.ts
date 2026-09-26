import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { WsClientMeta } from '../types/ws-protocol.js';
import { WsRouter } from './WsRouter.js';

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

function harness(viewMode: 'legacy' | 'checkpoint') {
  const router = new WsRouter({} as AuthService, {
    getSession: (sessionId: string) => ({ id: sessionId }),
    isSessionReady: () => true,
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  } as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: () => undefined,
    readViewAuthorityMode: () => viewMode,
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'viewer',
    connectionId: 'viewer-control',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-out']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map([['session-out', 1]]),
    terminalAuthorityViewRegistrations: new Map([['session-out', {
      sessionId: 'session-out',
      viewGeneration: 1,
      queryReplyCapability: 'terminal.query-reply-input.v1' as const,
      parserResponderCapability: 'terminal.parser-responder-disable.v1' as const,
      authorityStreamEpoch: '3',
      driverLeaseGeneration: '3',
      acceptedViewAttributesGeneration: '3',
    }]]),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    sessionSubscribers: Map<string, Set<WebSocket>>;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  internals.sessionSubscribers.set('session-out', new Set([socket as unknown as WebSocket]));
  return { router, socket };
}

// @req REL-BGSTAB-011
test('#110 a negotiated view still in legacy authority mode receives legacy fallback output', () => {
  // Measured 2026-09-19 with a probe on both ends of the PTY: the shell echoed `codex`, codex
  // emitted its queries and a 928-byte paint, and the browser rendered none of it. Every chunk
  // was dropped at `audience === 'legacy-unnegotiated' && terminalAuthorityViewRegistrations.has(...)`
  // with authorityStreamEpoch "3" and no active checkpoint ledger. All five callers that pass this
  // audience are fallbacks -- one of them says so: "deliver this chunk so the user still sees it".
  // Having merely negotiated is not having been delivered to.
  const { router, socket } = harness('legacy');
  try {
    router.routeSessionOutput('session-out', 'codex-paint', 7, {}, 'legacy-unnegotiated');
    const output = socket.frames.filter(frame => frame.type === 'output');
    assert.equal(output.length, 1, 'the chunk must reach the only subscriber');
    assert.equal(output[0]!.data, 'codex-paint');
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-011
test('#110 a view actually on the checkpoint delivery path is still skipped, so nothing double-delivers', () => {
  const { router, socket } = harness('checkpoint');
  try {
    router.routeSessionOutput('session-out', 'already-delivered', 7, {}, 'legacy-unnegotiated');
    assert.equal(
      socket.frames.filter(frame => frame.type === 'output').length,
      0,
      'checkpoint delivery owns this chunk; the legacy copy would duplicate it',
    );
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-011
test("#110 audience 'all' reaches a negotiated view regardless of its authority mode", () => {
  for (const mode of ['legacy', 'checkpoint'] as const) {
    const { router, socket } = harness(mode);
    try {
      router.routeSessionOutput('session-out', 'ordinary', 7, {});
      assert.equal(
        socket.frames.filter(frame => frame.type === 'output').length,
        1,
        `audience 'all' must be unaffected (${mode})`,
      );
    } finally {
      router.destroy();
    }
  }
});
