import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import { TERMINAL_CHECKPOINT_PROTOCOL_VERSION, type WsClientMeta } from '../types/ws-protocol.js';
import {
  WsRouter,
  type TerminalAuthorityFreshCheckpoint,
  type TerminalAuthorityViewReadyRegistration,
} from './WsRouter.js';

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly frames: Array<Record<string, unknown>> = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.frames.push(JSON.parse(payload) as Record<string, unknown>);
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function setup() {
  const router = new WsRouter({} as AuthService, {} as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'checkpoint-client',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  return { router, socket, meta, internals };
}

function send(
  internals: ReturnType<typeof setup>['internals'],
  socket: FakeWebSocket,
  frame: Record<string, unknown>,
): void {
  internals.handleMessage(socket as unknown as WebSocket, JSON.stringify(frame));
}

function installFreshCheckpointProvider(
  router: WsRouter,
  provider: () => TerminalAuthorityFreshCheckpoint | null,
): void {
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) } as never,
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    readFreshAuthoritativeCheckpoint: () => provider(),
  });
}

function validApplyAck(): Record<string, unknown> {
  return {
    type: 'terminal-checkpoint:apply-ack',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    sessionId: 'session-1',
    viewGeneration: 1,
    streamEpoch: '1',
    checkpointEpoch: '1',
    connectionId: 'checkpoint-connection-1',
    sourceSeq: '2',
    snapshotSeq: '2',
    oldestRetainedSeq: '0',
    retentionPolicyId: 'retained-scrollback:10000',
    appliedThroughSeq: '2',
  };
}

test('checkpoint negotiation is request-only and keeps legacy authority inactive', () => {
  const { router, socket, meta, internals } = setup();
  try {
    assert.equal(socket.frames.length, 0, 'legacy connections must not receive unsolicited capability frames');
    assert.equal(meta.terminalCheckpointProtocolVersion, undefined);

    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 2,
    });
    assert.equal(meta.terminalCheckpointProtocolVersion, undefined, 'invalid negotiation mutated client state');
    assert.equal(socket.frames.at(-1)?.type, 'terminal-checkpoint:rejected');

    send(internals, socket, {
      type: 'terminal-checkpoint:apply-ak',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    });
    assert.equal(meta.terminalCheckpointProtocolVersion, undefined, 'unknown checkpoint type mutated client state');
    assert.equal(socket.frames.at(-1)?.reason, 'invalid-message');

    send(internals, socket, validApplyAck());
    assert.equal(socket.frames.at(-1)?.reason, 'capability-not-negotiated');

    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    });
    assert.equal(meta.terminalCheckpointProtocolVersion, TERMINAL_CHECKPOINT_PROTOCOL_VERSION);
    assert.deepEqual(socket.frames.at(-1), {
      type: 'terminal-checkpoint:capability',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      accepted: true,
      authorityMode: 'legacy',
      checkpointDeliveryActive: false,
      ordinalEncoding: 'canonical-uint64-decimal',
      digestAlgorithms: ['sha256'],
    });

    send(internals, socket, { ...validApplyAck(), snapshotSeq: 2 });
    assert.equal(socket.frames.at(-1)?.reason, 'invalid-message');
    assert.equal(meta.terminalCheckpointProtocolVersion, TERMINAL_CHECKPOINT_PROTOCOL_VERSION);

    send(internals, socket, validApplyAck());
    assert.equal(socket.frames.at(-1)?.reason, 'checkpoint-not-active');

    send(internals, socket, {
      ...validApplyAck(),
      type: 'terminal-checkpoint:drain-ack',
      drainedThroughSeq: '3',
      appliedThroughSeq: undefined,
    });
    assert.equal(socket.frames.at(-1)?.reason, 'checkpoint-not-active',
      'a contiguous post-snapshot tail watermark must pass protocol parsing');
    send(internals, socket, {
      ...validApplyAck(),
      type: 'terminal-checkpoint:drain-ack',
      drainedThroughSeq: '1',
      appliedThroughSeq: undefined,
    });
    assert.equal(socket.frames.at(-1)?.reason, 'invalid-message',
      'a drain watermark before the checkpoint source identity must fail closed');
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 subscribe re-announces a previously negotiated view after it becomes an authority candidate', () => {
  const topology: Array<Record<string, unknown>> = [];
  const manager = {
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    getLastCwd: () => null,
    getScreenSnapshot: () => ({
      seq: 1,
      cols: 80,
      rows: 24,
      data: '',
      truncated: false,
      generatedAt: Date.now(),
      health: 'healthy' as const,
    }),
    isSessionReady: () => true,
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: () => ({ ok: false, reason: 'authority-admission-closed' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: input => topology.push(input),
    readViewAuthorityMode: () => 'checkpoint',
    readViewAuthorityStreamEpoch: () => '1',
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'reloaded-browser',
    connectionId: 'reloaded-control',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map(),
    terminalAuthorityViewRegistrations: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{
        sessionId: 'session-reload',
        viewGeneration: 2,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    });
    assert.deepEqual(topology.map(event => event.kind), ['new-view']);

    send(internals, socket, { type: 'subscribe', sessionIds: ['session-reload'] });
    assert.deepEqual(topology.map(event => event.kind), ['new-view', 'subscription-ready']);
    assert.deepEqual(topology.at(-1), {
      sessionId: 'session-reload',
      kind: 'subscription-ready',
      connectionId: 'reloaded-control',
      viewGeneration: 2,
    });
  } finally {
    router.destroy();
  }
});

test('RED reviewer — negotiated retained lease fences actual websocket input and resize mutations', () => {
  const mutationCalls: Array<Record<string, unknown>> = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      authorityEpoch: 'authority-epoch-1',
      viewGeneration,
      leaseGeneration: 'lease-1',
      clientId,
    }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered-driver-revoked' }),
    getSession: (sessionId: string) => ({ id: sessionId }),
    writeInput: (
      sessionId: string,
      data: string,
      _metadata: unknown,
      _sequence: unknown,
      identity: unknown,
    ) => {
      mutationCalls.push({ kind: 'input', sessionId, data, identity });
      return true;
    },
    resize: (sessionId: string, cols: number, rows: number, identity: unknown) => {
      mutationCalls.push({ kind: 'resize', sessionId, cols, rows, identity });
      return true;
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'checkpoint-client',
    isAlive: true,
    subscribedSessions: new Set(['session-lease']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{ sessionId: 'session-lease', viewGeneration: 7 }],
    });
    assert.deepEqual(socket.frames.at(-1), {
      type: 'terminal-checkpoint:capability',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      accepted: true,
      authorityMode: 'legacy',
      checkpointDeliveryActive: false,
      ordinalEncoding: 'canonical-uint64-decimal',
      digestAlgorithms: ['sha256'],
      registeredViews: [{ sessionId: 'session-lease', viewGeneration: 7 }],
      mutationLeases: [{
        sessionId: 'session-lease',
        authorityEpoch: 'authority-epoch-1',
        viewGeneration: 7,
        leaseGeneration: 'lease-1',
      }],
    });

    const retainedIdentity = {
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 7,
      leaseGeneration: 'lease-1',
    };
    send(internals, socket, {
      type: 'input', sessionId: 'session-lease', data: 'fenced-input', retainedIdentity,
    });
    send(internals, socket, {
      type: 'resize', sessionId: 'session-lease', cols: 81, rows: 25, retainedIdentity,
    });
    assert.deepEqual(mutationCalls, [
      {
        kind: 'input', sessionId: 'session-lease', data: 'fenced-input',
        identity: { ...retainedIdentity, clientId: 'checkpoint-client' },
      },
      {
        kind: 'resize', sessionId: 'session-lease', cols: 81, rows: 25,
        identity: { ...retainedIdentity, clientId: 'checkpoint-client' },
      },
    ]);

    mutationCalls.length = 0;
    send(internals, socket, {
      type: 'input', sessionId: 'session-lease', data: 'capability-delivery-race-input',
    });
    send(internals, socket, {
      type: 'resize', sessionId: 'session-lease', cols: 59, rows: 17,
    });
    assert.deepEqual(mutationCalls, [
      {
        kind: 'input', sessionId: 'session-lease', data: 'capability-delivery-race-input',
        identity: { ...retainedIdentity, clientId: 'checkpoint-client' },
      },
      {
        kind: 'resize', sessionId: 'session-lease', cols: 59, rows: 17,
        identity: { ...retainedIdentity, clientId: 'checkpoint-client' },
      },
    ], 'the server-issued driver lease must bridge capability delivery without weakening observer fencing');
  } finally {
    router.destroy();
  }
});

test('RED reviewer — view removal renegotiates release and resize lease rejection is observable', () => {
  const mutationCalls: Array<Record<string, unknown>> = [];
  const releaseCalls: Array<Record<string, unknown>> = [];
  let acceptResize = false;
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      authorityEpoch: 'authority-epoch-1',
      viewGeneration,
      leaseGeneration: 'lease-1',
      clientId,
    }),
    unregisterRetainedTerminalClientView: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => {
      releaseCalls.push({ sessionId, clientId, viewGeneration });
      return true;
    },
    resize: (sessionId: string, cols: number, rows: number, identity: unknown) => {
      mutationCalls.push({ sessionId, cols, rows, identity });
      return acceptResize;
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'checkpoint-client',
    isAlive: true,
    subscribedSessions: new Set(['session-lease']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{ sessionId: 'session-lease', viewGeneration: 7 }],
    });

    const framesBeforeLegacyResize = socket.frames.length;
    send(internals, socket, {
      type: 'resize',
      sessionId: 'legacy-session',
      cols: 80,
      rows: 24,
    });
    assert.equal(
      socket.frames.length,
      framesBeforeLegacyResize,
      'legacy resize rejection must not be mislabeled as a checkpoint lease rejection',
    );
    mutationCalls.length = 0;

    send(internals, socket, {
      type: 'resize',
      sessionId: 'session-lease',
      cols: 81,
      rows: 25,
      retainedIdentity: {
        authorityEpoch: '',
        viewGeneration: 7,
        leaseGeneration: 'lease-1',
      },
    });
    assert.equal(mutationCalls.length, 0, 'malformed identity reached resize');
    assert.deepEqual(socket.frames.at(-1), {
      type: 'terminal-checkpoint:rejected',
      supportedProtocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      phase: 'ack',
      reason: 'invalid-message',
      sessionId: 'session-lease',
      rejectedMessageType: 'resize',
    });

    send(internals, socket, {
      type: 'resize',
      sessionId: 'session-lease',
      cols: 82,
      rows: 26,
      retainedIdentity: {
        authorityEpoch: 'authority-epoch-1',
        viewGeneration: 7,
        leaseGeneration: 'stale-lease',
      },
    });
    assert.equal(mutationCalls.length, 1, 'stale identity must be checked by the authority');
    assert.equal(socket.frames.at(-1)?.type, 'terminal-checkpoint:rejected');
    assert.equal(socket.frames.at(-1)?.reason, 'invalid-message');
    assert.equal(socket.frames.at(-1)?.rejectedMessageType, 'resize');

    acceptResize = true;
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [],
    });
    assert.deepEqual(releaseCalls, [{
      sessionId: 'session-lease',
      clientId: 'checkpoint-client',
      viewGeneration: 7,
    }]);
    assert.deepEqual(socket.frames.at(-1), {
      type: 'terminal-checkpoint:capability',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      accepted: true,
      authorityMode: 'legacy',
      checkpointDeliveryActive: false,
      ordinalEncoding: 'canonical-uint64-decimal',
      digestAlgorithms: ['sha256'],
    });
    assert.equal(meta.retainedTerminalViews?.size, 0);
  } finally {
    router.destroy();
  }
});

test('RED reviewer — router destroy unregisters retained views before terminating sockets', () => {
  const lifecycle: string[] = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      authorityEpoch: 'authority-epoch-1',
      viewGeneration,
      leaseGeneration: 'lease-1',
      clientId,
    }),
    unregisterRetainedTerminalClientView: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => {
      lifecycle.push(`unregister:${sessionId}:${clientId}:${viewGeneration}`);
      return { ok: true, reason: 'unregistered-driver-revoked' };
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const socket = new FakeWebSocket();
  socket.terminate = () => {
    lifecycle.push('terminate');
    socket.readyState = WebSocket.CLOSED;
  };
  const meta: WsClientMeta = {
    clientId: 'destroy-client',
    isAlive: true,
    subscribedSessions: new Set(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  let destroyed = false;
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{ sessionId: 'destroy-session', viewGeneration: 9 }],
    });
    assert.equal(meta.retainedTerminalViews?.get('destroy-session'), 9);

    router.destroy();
    destroyed = true;

    assert.deepEqual(lifecycle, [
      'unregister:destroy-session:destroy-client:9',
      'terminate',
    ], 'REL-BGSTAB-011 AC-6/AC-9 destroy skipped retained view/driver cleanup');
    assert.equal(internals.clients.size, 0);
    assert.equal(meta.retainedTerminalViews?.size, 0);
  } finally {
    if (!destroyed) router.destroy();
  }
});

test('MIG-BGSTAB-002 rejects client-authored responder generations and grants both browser views from server stream state', () => {
  const topology: Array<Record<string, unknown>> = [];
  const readyViews: TerminalAuthorityViewReadyRegistration[] = [];
  let activeAuthorityStreamEpoch = '7';
  let mutationOwner: string | null = null;
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => {
      if (mutationOwner !== null && mutationOwner !== clientId) {
        return { ok: false, reason: 'driver-owned-by-other-client' };
      }
      mutationOwner = clientId;
      return {
        ok: true,
        sessionId,
        authorityEpoch: 'authority-epoch-1',
        clientId,
        viewGeneration,
        leaseGeneration: '1',
      };
    },
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '7' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: input => topology.push(input),
    onViewAuthorityReady: input => readyViews.push(input),
    readViewAuthorityStreamEpoch: () => activeAuthorityStreamEpoch,
    readViewAttributesChallengeId: () => 'view-attributes-challenge-7',
  });
  const sockets = [new FakeWebSocket(), new FakeWebSocket()];
  const metas = sockets.map((_, index): WsClientMeta => ({
    clientId: `browser-${index + 1}`,
    connectionId: `connection-${index + 1}`,
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-multi-browser']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map(),
    terminalAuthorityViewRegistrations: new Map(),
  }));
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  sockets.forEach((socket, index) => {
    internals.clients.set(socket as unknown as WebSocket, metas[index]!);
  });
  try {
    send(internals, sockets[0]!, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{
        sessionId: 'session-multi-browser',
        viewGeneration: 1,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
        driverLeaseGeneration: '999',
        acceptedViewAttributesGeneration: '999',
      }],
    });
    assert.equal(sockets[0]!.frames.at(-1)?.type, 'terminal-checkpoint:rejected');
    assert.equal(sockets[0]!.frames.at(-1)?.reason, 'invalid-message');

    sockets.forEach((socket) => send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{
        sessionId: 'session-multi-browser',
        viewGeneration: 1,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));

    for (const socket of sockets) {
      const capability = socket.frames.at(-1);
      assert.equal(capability?.type, 'terminal-checkpoint:capability');
      assert.deepEqual(capability?.registeredViews, [{
        sessionId: 'session-multi-browser',
        viewGeneration: 1,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
        authorityStreamEpoch: '7',
        driverLeaseGeneration: '7',
        acceptedViewAttributesGeneration: '7',
        viewAttributesChallengeId: 'view-attributes-challenge-7',
      }]);
    }
    assert.equal(
      (sockets[1]!.frames.at(-1)?.mutationLeases as unknown[] | undefined)?.length ?? 0,
      0,
      'observer browser must not receive the active mutation driver lease',
    );
    assert.deepEqual(
      router.getTerminalAuthorityResponderViews('session-multi-browser').map(view => ({
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
        driverLeaseGeneration: view.driverLeaseGeneration,
        acceptedViewAttributesGeneration: view.acceptedViewAttributesGeneration,
      })),
      [
        {
          connectionId: 'connection-1', viewGeneration: 1,
          driverLeaseGeneration: '7', acceptedViewAttributesGeneration: '7',
        },
        {
          connectionId: 'connection-2', viewGeneration: 1,
          driverLeaseGeneration: '7', acceptedViewAttributesGeneration: '7',
        },
      ],
    );
    assert.equal(readyViews.length, 2, 'each authenticated browser view must reach the authority adapter');
    assert.deepEqual(readyViews.map(view => view.connectionId), ['connection-1', 'connection-2']);
    activeAuthorityStreamEpoch = '8';
    assert.deepEqual(
      router.getTerminalAuthorityResponderViews('session-multi-browser')
        .map(view => view.authorityStreamEpoch),
      ['8', '8'],
      'an existing peer and a replacement view must be projected onto the current server authority epoch',
    );
    assert.equal(topology.length, 2);
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 reconnect generation emits one fresh authority-ready hook for the replacement view', () => {
  const readyViews: TerminalAuthorityViewReadyRegistration[] = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      authorityEpoch: 'authority-epoch-1',
      clientId,
      viewGeneration,
      leaseGeneration: String(viewGeneration),
    }),
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '7' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: input => readyViews.push(input),
    readViewAuthorityMode: input => {
      assert.equal(input.authorityStreamEpoch, '8');
      return 'checkpoint';
    },
    readViewAuthorityStreamEpoch: () => '8',
    readViewAttributesChallengeId: () => 'view-attributes-challenge-8',
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'browser-reconnected',
    connectionId: 'connection-new',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-reconnect']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map(),
    terminalAuthorityViewRegistrations: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  const negotiation = {
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    views: [{
      sessionId: 'session-reconnect',
      viewGeneration: 2,
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
    }],
  };
  try {
    send(internals, socket, negotiation);
    send(internals, socket, negotiation);
    const capabilities = socket.frames.filter(frame => frame.type === 'terminal-checkpoint:capability');
    assert.equal(capabilities.length, 2);
    assert.equal(capabilities.every(frame => (
      frame.authorityMode === 'checkpoint' && frame.checkpointDeliveryActive === true
    )), true, 'active authority must not downgrade during same-view renegotiation');
    assert.equal(readyViews.length, 1, 'same connection/view/epoch renegotiation must not duplicate checkpoints');
    assert.deepEqual(readyViews[0], {
      sessionId: 'session-reconnect',
      clientId: 'browser-reconnected',
      connectionId: 'connection-new',
      viewGeneration: 2,
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '8',
      acceptedViewAttributesGeneration: '8',
      authorityStreamEpoch: '8',
      reason: 'new-view',
    });
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 authoritative snapshot acknowledgement re-arms its exact checkpoint responder view', () => {
  const readyViews: TerminalAuthorityViewReadyRegistration[] = [];
  const manager = {
    recordTerminalAuthorityServerRecoveryApplied: () => ({ ok: true }),
    unregisterRetainedTerminalClientView: () => ({ ok: true }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: input => readyViews.push(input),
    readViewAuthorityMode: () => 'checkpoint',
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'browser-recovery',
    connectionId: 'connection-recovery',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-recovery']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map([['session-recovery', 4]]),
    terminalAuthorityViewRegistrations: new Map([['session-recovery', {
      sessionId: 'session-recovery',
      clientId: 'browser-recovery',
      connectionId: 'connection-recovery',
      viewGeneration: 4,
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      authorityStreamEpoch: '12',
      driverLeaseGeneration: '12',
      acceptedViewAttributesGeneration: '12',
    }]]),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
    markReplayPending: (
      ws: WebSocket,
      sessionId: string,
      snapshot: {
        snapshotSeq: number;
        snapshotMode: 'authoritative' | 'fallback';
        snapshotDataLength: number;
        snapshotTruncated: boolean;
        snapshotCols: number;
        snapshotRows: number;
      },
    ) => { replayToken: string };
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    const replay = internals.markReplayPending(socket as unknown as WebSocket, 'session-recovery', {
      snapshotSeq: 9,
      snapshotMode: 'authoritative',
      snapshotDataLength: 128,
      snapshotTruncated: false,
      snapshotCols: 80,
      snapshotRows: 24,
    });

    send(internals, socket, {
      type: 'screen-snapshot:ready',
      sessionId: 'session-recovery',
      replayToken: replay.replayToken,
    });

    assert.deepEqual(readyViews, [{
      sessionId: 'session-recovery',
      clientId: 'browser-recovery',
      connectionId: 'connection-recovery',
      viewGeneration: 4,
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      authorityStreamEpoch: '12',
      driverLeaseGeneration: '12',
      acceptedViewAttributesGeneration: '12',
      reason: 'recovery-acknowledged',
    }]);
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 acknowledged authoritative recovery re-arms after checkpoint mode becomes available', () => {
  const readyViews: TerminalAuthorityViewReadyRegistration[] = [];
  let authorityMode: 'legacy' | 'checkpoint' = 'legacy';
  const manager = {
    recordTerminalAuthorityServerRecoveryApplied: () => ({ ok: true }),
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      clientId,
      authorityEpoch: 'authority-recovery',
      viewGeneration,
      leaseGeneration: '12',
    }),
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '12' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: input => readyViews.push(input),
    readViewAuthorityMode: () => authorityMode,
    readViewAuthorityStreamEpoch: () => '12',
  });
  const socket = new FakeWebSocket();
  const registration = {
    sessionId: 'session-recovery-race',
    viewGeneration: 4,
    queryReplyCapability: 'terminal.query-reply-input.v1' as const,
    parserResponderCapability: 'terminal.parser-responder-disable.v1' as const,
    authorityStreamEpoch: '12',
    driverLeaseGeneration: '12',
    acceptedViewAttributesGeneration: '12',
  };
  const meta: WsClientMeta = {
    clientId: 'browser-recovery-race',
    connectionId: 'connection-recovery-race',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-recovery-race']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map([['session-recovery-race', 4]]),
    terminalAuthorityViewRegistrations: new Map([['session-recovery-race', registration]]),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
    markReplayPending: (
      ws: WebSocket,
      sessionId: string,
      snapshot: {
        snapshotSeq: number;
        snapshotMode: 'authoritative' | 'fallback';
        snapshotDataLength: number;
        snapshotTruncated: boolean;
        snapshotCols: number;
        snapshotRows: number;
      },
    ) => { replayToken: string };
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    const replay = internals.markReplayPending(socket as unknown as WebSocket, 'session-recovery-race', {
      snapshotSeq: 9,
      snapshotMode: 'authoritative',
      snapshotDataLength: 128,
      snapshotTruncated: false,
      snapshotCols: 80,
      snapshotRows: 24,
    });
    send(internals, socket, {
      type: 'screen-snapshot:ready',
      sessionId: 'session-recovery-race',
      replayToken: replay.replayToken,
    });
    assert.deepEqual(readyViews, [], 'legacy mode must not admit a checkpoint before it exists');
    assert.equal(
      meta.terminalAuthorityRecoveryEvidence?.has('session-recovery-race'),
      true,
      'the accepted authoritative snapshot must remain available to the subsequent checkpoint negotiation',
    );

    authorityMode = 'checkpoint';
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{
        sessionId: registration.sessionId,
        viewGeneration: registration.viewGeneration,
        queryReplyCapability: registration.queryReplyCapability,
        parserResponderCapability: registration.parserResponderCapability,
      }],
    });

    assert.deepEqual(readyViews, [{
      ...registration,
      clientId: 'browser-recovery-race',
      connectionId: 'connection-recovery-race',
      reason: 'recovery-acknowledged',
    }]);
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 same-view checkpoint renegotiation projects its existing server-authority lease', () => {
  const readyViews: TerminalAuthorityViewReadyRegistration[] = [];
  const inputCalls: Array<Record<string, unknown>> = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: () => ({
      ok: false,
      reason: 'authority-admission-closed',
    }),
    getTerminalAuthoritySuspendedBrowserMutationLease: () => ({
      sessionId: 'session-reconnect',
      authorityEpoch: 'authority-epoch-1',
      clientId: 'browser-reconnected',
      viewGeneration: 2,
      leaseGeneration: '12',
    }),
    getSession: (sessionId: string) => ({ id: sessionId }),
    writeInput: (
      sessionId: string,
      data: string,
      _metadata: unknown,
      _sequence: unknown,
      identity: unknown,
    ) => {
      inputCalls.push({ sessionId, data, identity });
      return true;
    },
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '8' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: input => readyViews.push(input),
    readViewAuthorityMode: () => 'checkpoint',
    readViewAuthorityStreamEpoch: () => '8',
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'browser-reconnected',
    connectionId: 'connection-new',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-reconnect']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map(),
    terminalAuthorityViewRegistrations: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  const negotiation = {
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    views: [{
      sessionId: 'session-reconnect',
      viewGeneration: 2,
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
    }],
  };
  try {
    send(internals, socket, negotiation);
    send(internals, socket, negotiation);
    const capabilities = socket.frames.filter(frame => frame.type === 'terminal-checkpoint:capability');
    assert.equal(capabilities.length, 2);
    assert.deepEqual(capabilities.map(frame => frame.mutationLeases), [[{
      sessionId: 'session-reconnect',
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 2,
      leaseGeneration: '12',
    }], [{
      sessionId: 'session-reconnect',
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 2,
      leaseGeneration: '12',
    }]]);
    assert.deepEqual(meta.retainedTerminalMutationLeases?.get('session-reconnect'), {
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 2,
      leaseGeneration: '12',
    }, 'the server must retain its projected checkpoint lease for subsequent user input admission');
    send(internals, socket, {
      type: 'input', sessionId: 'session-reconnect', data: 'input-before-capability-client-apply',
    });
    assert.deepEqual(inputCalls, [{
      sessionId: 'session-reconnect',
      data: 'input-before-capability-client-apply',
      identity: {
        authorityEpoch: 'authority-epoch-1',
        clientId: 'browser-reconnected',
        viewGeneration: 2,
        leaseGeneration: '12',
      },
    }], 'the server-issued same-view lease must fence input before the browser applies capability');
    assert.equal(readyViews.length, 1, 'same view must not replay the authority-ready lifecycle');
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 checkpoint recovery readiness does not depend on a legacy attributes challenge', () => {
  const readyViews: TerminalAuthorityViewReadyRegistration[] = [];
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      authorityEpoch: 'authority-epoch-1',
      clientId,
      viewGeneration,
      leaseGeneration: '12',
    }),
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '12' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: input => readyViews.push(input),
    readViewAuthorityMode: () => 'checkpoint',
    readViewAuthorityStreamEpoch: () => '12',
    readViewAttributesChallengeId: () => null,
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'browser-recovery-without-challenge',
    connectionId: 'connection-recovery-without-challenge',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-recovery-without-challenge']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map(),
    terminalAuthorityViewRegistrations: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{
        sessionId: 'session-recovery-without-challenge',
        viewGeneration: 6,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    });
    assert.equal(socket.frames.at(-1)?.authorityMode, 'checkpoint');
    assert.equal(
      (socket.frames.at(-1)?.registeredViews as Array<Record<string, unknown>>)[0]
        ?.viewAttributesChallengeId,
      undefined,
    );
    assert.equal(
      readyViews.length,
      1,
      'server-authority checkpoint recovery must still start after its capability frame',
    );
    assert.equal(readyViews[0]?.reason, 'new-view');
  } finally {
    router.destroy();
  }
});

test('RED reviewer — negotiated observer stays registered, cannot mutate, and rebinds after driver disconnect', () => {
  const signature = 'REL-BGSTAB-011 AC-6/AC-7 real WS negotiation bypassed exclusive driver fencing';
  const views = new Map<string, number>();
  let ownerClientId: string | null = null;
  let leaseGeneration = 0;
  const mutations: Array<{ kind: 'input' | 'resize'; clientId: string | null }> = [];
  const manager = {
    registerRetainedTerminalClientView: (_sessionId: string, clientId: string, viewGeneration: number) => {
      views.set(clientId, viewGeneration);
      return { ok: true, reason: 'registered' };
    },
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => {
      if (views.get(clientId) !== viewGeneration || (ownerClientId && ownerClientId !== clientId)) {
        return { ok: false as const, reason: 'driver-owned-by-other-client' };
      }
      ownerClientId = clientId;
      leaseGeneration += 1;
      return {
        ok: true as const,
        sessionId,
        authorityEpoch: 'authority-epoch-1',
        viewGeneration,
        leaseGeneration: String(leaseGeneration),
        clientId,
      };
    },
    unregisterRetainedTerminalClientView: (_sessionId: string, clientId: string, viewGeneration: number) => {
      if (views.get(clientId) !== viewGeneration) return { ok: false, reason: 'stale-view-generation' };
      views.delete(clientId);
      if (ownerClientId === clientId) ownerClientId = null;
      return { ok: true, reason: 'unregistered' };
    },
    getSession: (sessionId: string) => ({ id: sessionId }),
    writeInput: (
      _sessionId: string,
      _data: string,
      _metadata: unknown,
      _sequence: unknown,
      identity: { clientId?: string } | undefined,
    ) => {
      mutations.push({ kind: 'input', clientId: identity?.clientId ?? null });
      return true;
    },
    resize: (
      _sessionId: string,
      _cols: number,
      _rows: number,
      identity: { clientId?: string } | undefined,
    ) => {
      mutations.push({ kind: 'resize', clientId: identity?.clientId ?? null });
      return true;
    },
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  const driverSocket = new FakeWebSocket();
  const observerSocket = new FakeWebSocket();
  const driverMeta: WsClientMeta = {
    clientId: 'driver-client', isAlive: true, subscribedSessions: new Set(['shared-session']),
    replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  };
  const observerMeta: WsClientMeta = {
    clientId: 'observer-client', isAlive: true, subscribedSessions: new Set(['shared-session']),
    replayPendingSessions: new Map(), screenRepairPendingSessions: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
    handleDisconnect: (ws: WebSocket) => void;
  };
  internals.clients.set(driverSocket as unknown as WebSocket, driverMeta);
  internals.clients.set(observerSocket as unknown as WebSocket, observerMeta);
  try {
    const negotiate = { type: 'terminal-checkpoint:negotiate', protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [{ sessionId: 'shared-session', viewGeneration: 1 }] };
    send(internals, driverSocket, negotiate);
    send(internals, observerSocket, negotiate);
    const observerCapability = observerSocket.frames.at(-1)!;
    assert.deepEqual(observerCapability.registeredViews, [{ sessionId: 'shared-session', viewGeneration: 1 }], signature);
    assert.deepEqual(observerCapability.mutationLeases, [], signature);
    assert.equal(views.get('observer-client'), 1, signature);
    assert.equal(ownerClientId, 'driver-client', signature);

    send(internals, observerSocket, { type: 'input', sessionId: 'shared-session', data: 'must-not-write' });
    send(internals, observerSocket, { type: 'resize', sessionId: 'shared-session', cols: 90, rows: 30 });
    assert.deepEqual(mutations, [], `${signature}: observer mutated without a lease identity`);
    assert.equal(observerSocket.frames.at(-1)?.type, 'terminal-checkpoint:rejected', signature);

    internals.handleDisconnect(driverSocket as unknown as WebSocket);
    send(internals, observerSocket, negotiate);
    const reboundCapability = observerSocket.frames.at(-1)!;
    const reboundLease = (reboundCapability.mutationLeases as Array<Record<string, unknown>>)[0]!;
    assert.equal(ownerClientId, 'observer-client', signature);
    assert.equal(reboundLease.leaseGeneration, '2', signature);

    const retainedIdentity = {
      authorityEpoch: reboundLease.authorityEpoch,
      viewGeneration: reboundLease.viewGeneration,
      leaseGeneration: reboundLease.leaseGeneration,
    };
    send(internals, observerSocket, {
      type: 'input', sessionId: 'shared-session', data: 'accepted-after-rebind', retainedIdentity,
    });
    send(internals, observerSocket, {
      type: 'resize', sessionId: 'shared-session', cols: 91, rows: 31, retainedIdentity,
    });
    assert.deepEqual(mutations, [
      { kind: 'input', clientId: 'observer-client' },
      { kind: 'resize', clientId: 'observer-client' },
    ], signature);
  } finally {
    router.destroy();
  }
});

test('MIG-BGSTAB-002 negotiation scopes mixed authority modes per session', () => {
  const manager = {
    registerRetainedTerminalClientView: () => ({ ok: true, reason: 'registered' }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      authorityEpoch: `authority-${sessionId}`,
      clientId,
      viewGeneration,
      leaseGeneration: '1',
    }),
    getRetainedTerminalAuthorityState: () => ({ streamEpoch: '8' }),
    unregisterRetainedTerminalClientView: () => ({ ok: true, reason: 'unregistered' }),
  };
  const router = new WsRouter({} as AuthService, manager as unknown as SessionManager);
  router.installTerminalAuthorityHooks({
    queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) },
    onClientFrame: () => false,
    onTopologyChanged: () => undefined,
    onViewAuthorityReady: () => undefined,
    readViewAuthorityMode: view => view.sessionId === 'session-checkpoint' ? 'checkpoint' : 'legacy',
    readViewAuthorityStreamEpoch: () => '8',
    readViewAttributesChallengeId: () => 'view-attributes-challenge-8',
  });
  const socket = new FakeWebSocket();
  const meta: WsClientMeta = {
    clientId: 'mixed-session-browser',
    connectionId: 'mixed-session-connection',
    channelRole: 'control',
    isAlive: true,
    subscribedSessions: new Set(['session-checkpoint', 'session-legacy']),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
    retainedTerminalViews: new Map(),
    terminalAuthorityViewRegistrations: new Map(),
  };
  const internals = router as unknown as {
    clients: Map<WebSocket, WsClientMeta>;
    handleMessage: (ws: WebSocket, raw: Buffer | string) => void;
  };
  internals.clients.set(socket as unknown as WebSocket, meta);
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views: [
        {
          sessionId: 'session-checkpoint',
          viewGeneration: 3,
          queryReplyCapability: 'terminal.query-reply-input.v1',
          parserResponderCapability: 'terminal.parser-responder-disable.v1',
        },
        {
          sessionId: 'session-legacy',
          viewGeneration: 4,
          queryReplyCapability: 'terminal.query-reply-input.v1',
          parserResponderCapability: 'terminal.parser-responder-disable.v1',
        },
      ],
    });
    const capabilities = socket.frames.filter(frame => frame.type === 'terminal-checkpoint:capability');
    assert.equal(capabilities.length, 2);
    assert.deepEqual(capabilities.map(frame => ({
      authorityMode: frame.authorityMode,
      checkpointDeliveryActive: frame.checkpointDeliveryActive,
      sessions: (frame.registeredViews as Array<{ sessionId: string }>).map(view => view.sessionId),
      leaseSessions: (frame.mutationLeases as Array<{ sessionId: string }>).map(lease => lease.sessionId),
    })), [
      {
        authorityMode: 'checkpoint',
        checkpointDeliveryActive: true,
        sessions: ['session-checkpoint'],
        leaseSessions: ['session-checkpoint'],
      },
      {
        authorityMode: 'legacy',
        checkpointDeliveryActive: false,
        sessions: ['session-legacy'],
        leaseSessions: ['session-legacy'],
      },
    ]);
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-012 rebinds bounded continuity or requires fresh checkpoint', () => {
  const signature = 'REL-BGSTAB-012 AC-3/AC-4: an unbound continuity identity must require a fresh authoritative checkpoint rather than silently accepting tail output';
  const { router, socket, internals } = setup();
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    });
    send(internals, socket, {
      type: 'terminal-checkpoint:continuity-rebind',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      sessionId: 'continuity-session',
      viewGeneration: 7,
      visibilityGeneration: '3',
      lastDeliveredSeq: '41',
      continuityRecord: {
        retentionPolicyId: 'retained-scrollback:10000',
        expiresAt: 1,
      },
    });

    const response = socket.frames.at(-1);
    assert.equal(response?.type, 'terminal-checkpoint:fresh-checkpoint-required', signature);
    assert.equal(response?.sessionId, 'continuity-session', signature);
    assert.equal(response?.reason, 'continuity-identity-mismatch', signature);
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-012 rebinds bounded continuity or requires an authoritative fresh checkpoint', () => {
  const signature = 'REL-BGSTAB-012 AC-3/AC-4: a bounded matching identity rebinds, while expiry or identity mismatch rejects tail-only recovery and requires every server retained-state checkpoint field';
  const { router, socket, internals } = setup();
  try {
    send(internals, socket, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    });
    const validIdentity = {
      sessionId: 'rel012-continuity-session',
      viewGeneration: 7,
      visibilityGeneration: '3',
      lastDeliveredSeq: '41',
      streamEpoch: '11',
      checkpointEpoch: '9',
      snapshotSeq: '40',
      oldestRetainedSeq: '12',
      retentionPolicyId: 'retained-scrollback:10000',
    };
    let issuedExpiresAt = Date.now() + 60_000;
    installFreshCheckpointProvider(router, () => ({
      continuity: {
        ...validIdentity,
        connectionId: 'checkpoint-client',
        expiresAt: issuedExpiresAt,
      },
      fullCheckpoint: {
        streamEpoch: '11',
        checkpointEpoch: '9',
        snapshotSeq: '40',
        oldestRetainedSeq: '12',
        retentionPolicyId: 'retained-scrollback:10000',
        geometry: { cols: 80, rows: 24 },
        modes: { bracketedPasteMode: true },
        chunks: [
          {
            sequence: 0,
            chunkIndex: 0,
            chunkCount: 2,
            encoding: 'base64',
            data: 'YQ==',
            encodedBytes: 1,
          },
          {
            sequence: 1,
            chunkIndex: 1,
            chunkCount: 2,
            encoding: 'base64',
            data: 'YmM=',
            encodedBytes: 2,
          },
        ],
        digest: {
          algorithm: 'sha256',
          hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        },
        parserTail: { encoding: 'base64', data: '', encodedBytes: 0 },
        tailOnly: false,
      },
    }));
    send(internals, socket, {
      type: 'terminal-checkpoint:continuity-rebind',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      ...validIdentity,
      continuityRecord: {
        ...validIdentity,
        expiresAt: issuedExpiresAt,
      },
    });
    const rebound = socket.frames.at(-1);
    assert.deepEqual({
      type: rebound?.type,
      sessionId: rebound?.sessionId,
      viewGeneration: rebound?.viewGeneration,
      visibilityGeneration: rebound?.visibilityGeneration,
      streamEpoch: rebound?.streamEpoch,
      checkpointEpoch: rebound?.checkpointEpoch,
      lastDeliveredSeq: rebound?.lastDeliveredSeq,
    }, {
      type: 'terminal-checkpoint:continuity-rebound',
      sessionId: validIdentity.sessionId,
      viewGeneration: validIdentity.viewGeneration,
      visibilityGeneration: validIdentity.visibilityGeneration,
      streamEpoch: validIdentity.streamEpoch,
      checkpointEpoch: validIdentity.checkpointEpoch,
      lastDeliveredSeq: validIdentity.lastDeliveredSeq,
    }, signature);

    const reboundCountBeforeForgedClaims = socket.frames.filter(frame => (
      frame.type === 'terminal-checkpoint:continuity-rebound'
    )).length;
    send(internals, socket, {
      type: 'terminal-checkpoint:continuity-rebind',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      ...validIdentity,
      lastDeliveredSeq: '42',
      continuityRecord: {
        ...validIdentity,
        lastDeliveredSeq: '42',
        expiresAt: issuedExpiresAt,
      },
    });
    const forgedLastDeliveredSeq = socket.frames.at(-1);
    assert.deepEqual({
      type: forgedLastDeliveredSeq?.type,
      reason: forgedLastDeliveredSeq?.reason,
    }, {
      type: 'terminal-checkpoint:fresh-checkpoint-required',
      reason: 'continuity-identity-mismatch',
    }, signature);
    assert.equal(
      socket.frames.filter(frame => frame.type === 'terminal-checkpoint:continuity-rebound').length,
      reboundCountBeforeForgedClaims,
      signature,
    );

    send(internals, socket, {
      type: 'terminal-checkpoint:continuity-rebind',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      ...validIdentity,
      viewGeneration: 8,
      continuityRecord: {
        ...validIdentity,
        viewGeneration: 8,
        expiresAt: issuedExpiresAt,
      },
    });
    const forgedView = socket.frames.at(-1);
    assert.deepEqual({
      type: forgedView?.type,
      reason: forgedView?.reason,
    }, {
      type: 'terminal-checkpoint:fresh-checkpoint-required',
      reason: 'continuity-identity-mismatch',
    }, signature);
    assert.equal(
      socket.frames.filter(frame => frame.type === 'terminal-checkpoint:continuity-rebound').length,
      reboundCountBeforeForgedClaims,
      signature,
    );

    issuedExpiresAt = 1;
    send(internals, socket, {
      type: 'terminal-checkpoint:continuity-rebind',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      ...validIdentity,
      continuityRecord: {
        ...validIdentity,
        expiresAt: issuedExpiresAt,
      },
    });

    const response = socket.frames.at(-1);
    assert.equal(response?.type, 'terminal-checkpoint:fresh-checkpoint-required', signature);
    assert.equal(response?.sessionId, validIdentity.sessionId, signature);
    assert.equal(response?.reason, 'continuity-expired', signature);
    const freshCheckpoint = response?.fullCheckpoint as Record<string, unknown> | undefined;
    assert.equal(response?.checkpointAuthority, 'server-full-retained-state', signature);
    for (const field of [
      'streamEpoch',
      'checkpointEpoch',
      'snapshotSeq',
      'oldestRetainedSeq',
      'retentionPolicyId',
    ]) {
      assert.equal(typeof freshCheckpoint?.[field], 'string', `${signature}: missing ${field}`);
    }
    for (const field of ['geometry', 'modes', 'digest', 'parserTail']) {
      assert.equal(typeof freshCheckpoint?.[field], 'object', `${signature}: missing ${field}`);
    }
    const chunks = freshCheckpoint?.chunks as Array<Record<string, unknown>> | undefined;
    assert.deepEqual(chunks?.map(chunk => ({
      sequence: chunk.sequence,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      encoding: chunk.encoding,
      data: chunk.data,
      encodedBytes: chunk.encodedBytes,
    })), [
      {
        sequence: 0,
        chunkIndex: 0,
        chunkCount: 2,
        encoding: 'base64',
        data: 'YQ==',
        encodedBytes: 1,
      },
      {
        sequence: 1,
        chunkIndex: 1,
        chunkCount: 2,
        encoding: 'base64',
        data: 'YmM=',
        encodedBytes: 2,
      },
    ], `${signature}: chunks must retain the indexed authoritative byte order`);
    const orderedChunkText = Buffer.concat((chunks ?? []).map(chunk => (
      Buffer.from(String(chunk.data ?? ''), 'base64')
    ))).toString('utf8');
    assert.equal(orderedChunkText, 'abc', `${signature}: checkpoint content must not be a tail-only substitute`);
    assert.deepEqual(freshCheckpoint?.digest, {
      algorithm: 'sha256',
      hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    }, `${signature}: digest identity must accompany the exact ordered chunks`);
    assert.equal(
      createHash('sha256').update(orderedChunkText, 'utf8').digest('hex'),
      (freshCheckpoint?.digest as Record<string, unknown> | undefined)?.hex,
      `${signature}: digest must correspond to the ordered checkpoint chunk content`,
    );
    assert.equal(freshCheckpoint?.tailOnly, false, signature);

    send(internals, socket, {
      type: 'terminal-checkpoint:continuity-rebind',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      ...validIdentity,
      viewGeneration: 8,
      continuityRecord: {
        ...validIdentity,
        expiresAt: issuedExpiresAt,
      },
    });
    const mismatch = socket.frames.at(-1);
    assert.deepEqual({
      type: mismatch?.type,
      reason: mismatch?.reason,
      tailOutput: mismatch?.tailOutput,
      hasFullCheckpoint: typeof mismatch?.fullCheckpoint === 'object' && mismatch.fullCheckpoint !== null,
    }, {
      type: 'terminal-checkpoint:fresh-checkpoint-required',
      reason: 'continuity-identity-mismatch',
      tailOutput: undefined,
      hasFullCheckpoint: true,
    }, signature);
  } finally {
    router.destroy();
  }
});
