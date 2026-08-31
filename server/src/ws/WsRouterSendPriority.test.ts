import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WsRouter } from './WsRouter.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import {
  createTerminalResourcePolicyLeaseIssuer,
  type TerminalResourcePolicyLease,
  type TerminalResourcePolicyLeaseAuthority,
} from '../services/TerminalResourcePolicyCanary.js';
import {
  createWsTransportMessage,
  getTransportMessagesInPriorityOrder,
  type WsTransportMessage,
  type WsTransportQueueState,
} from './wsSendPolicy.js';
import { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { config } from '../utils/config.js';
import type { FairSchedulerRuntimePolicyProfile } from '../benchmarks/terminalFairnessCharacterization.js';
import { jsonWirePayloadText, type WirePayload } from './wirePayload.js';

const FAIR_ARTIFACT_WS_LIMITS = new RuntimeConfigStore(config).getEditableValues().resourceLimits.ws;

function createFakeWs(options: {
  bufferedAmount?: number;
  deferSendCallbacks?: boolean;
  onSend?: (message: Record<string, unknown>) => void;
} = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const successful: Array<Record<string, unknown>> = [];
  const pendingCallbacks: Array<() => void> = [];
  let nextCallbackError: Error | undefined;
  let persistentCallbackError: Error | undefined;
  let lastFlushedCallback: (() => void) | undefined;
  let bufferedAmount = options.bufferedAmount ?? 0;
  let closeCode: number | undefined;
  let closeReason: string | undefined;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    send(payload: string, callback?: (error?: Error) => void) {
      const message = JSON.parse(payload) as Record<string, unknown>;
      sent.push(message);
      options.onSend?.(message);
      if (options.deferSendCallbacks && callback) {
        pendingCallbacks.push(() => {
          const error = nextCallbackError ?? persistentCallbackError;
          nextCallbackError = undefined;
          if (!error) successful.push(message);
          callback(error);
        });
        return;
      }
      successful.push(message);
      callback?.();
    },
    ping() {},
    close(code?: number, reason?: string) {
      closeCode = code;
      closeReason = reason;
      (this as { readyState: number }).readyState = 3;
    },
    terminate() {
      (this as { readyState: number }).readyState = 3;
    },
    on() {
      return this;
    },
  } as unknown as import('ws').WebSocket;

  return {
    ws,
    sent,
    successful,
    setBufferedAmount(value: number) {
      bufferedAmount = value;
    },
    getCloseCode() {
      return closeCode;
    },
    getCloseReason() {
      return closeReason;
    },
    flushNextSendCallback() {
      lastFlushedCallback = pendingCallbacks.shift();
      lastFlushedCallback?.();
    },
    flushLastSendCallbackAgain() {
      lastFlushedCallback?.();
    },
    setNextCallbackError(error: Error) {
      nextCallbackError = error;
    },
    setPersistentCallbackError(error: Error | undefined) {
      persistentCallbackError = error;
    },
  };
}

function createRouter(terminalResourcePolicyAuthority?: {
  validate(value: unknown): boolean;
  getLeaseMetadata(value: unknown): Readonly<{ issuanceSequence: number; targetEpoch: number }> | undefined;
  revokeTarget(target: unknown): number;
}, wsSendMode: 'direct' | 'safe-send-observe' | 'safe-send-enforce' = 'safe-send-enforce', screenSnapshot: Record<string, unknown> | null = null, wsLimits = {
  serverBufferedHighWaterBytes: 1024,
  serverBufferedHardLimitBytes: 2048,
  perClientOutputQueueMaxBytes: 4096,
  perClientControlQueueMaxBytes: 1024,
  outputCoalesceWindowMs: 1,
}): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const sessionManagerStub = {
    getSession: (id: string) => ({ id, status: 'running' }),
    getLastCwd: () => undefined,
    isSessionReady: () => true,
    getScreenSnapshot: () => screenSnapshot,
    getReplayQueueLimit: () => 64,
    registerRetainedTerminalClientView: () => ({ ok: true }),
    establishRetainedTerminalMutationLease: (
      sessionId: string,
      clientId: string,
      viewGeneration: number,
    ) => ({
      ok: true,
      sessionId,
      clientId,
      viewGeneration,
      authorityEpoch: 'test-retained-authority-epoch',
      leaseGeneration: 'test-retained-mutation-lease',
    }),
    unregisterRetainedTerminalClientView: () => undefined,
    writeInput: () => true,
    resize: () => true,
  } as unknown as SessionManager;

  return new WsRouter(authServiceStub, sessionManagerStub, {
    inputReliabilityMode: 'queue',
    resourceLimits: {
      ws: wsLimits as never,
    },
    stabilityModes: {
      wsSendMode,
    },
    terminalResourcePolicyAuthority,
  } as ConstructorParameters<typeof WsRouter>[2] & {
    terminalResourcePolicyAuthority?: {
      validate(value: unknown): boolean;
      getLeaseMetadata(value: unknown): Readonly<{ issuanceSequence: number; targetEpoch: number }> | undefined;
      revokeTarget(target: unknown): number;
    };
  });
}

function createFairRouter(screenSnapshot: Record<string, unknown> | null = null): WsRouter {
  return createRouter(undefined, 'safe-send-enforce', screenSnapshot, FAIR_ARTIFACT_WS_LIMITS);
}

const CANARY_EVIDENCE = {
  requirementId: 'OBS-BGSTAB-005',
  status: 'implemented',
  manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
} as const;

function createWsCanaryAuthority(decision = 2048): TerminalResourcePolicyLeaseAuthority {
  return createTerminalResourcePolicyLeaseIssuer({
    trustedEvidence: CANARY_EVIDENCE,
    contracts: [{
      contractId: `TEST-ONLY-WAVE3-STABLE-CONTRACT:${decision}`,
      policyId: 'test-only-wave3-reviewed',
      profileVersion: '1.0.0',
      schemaVersion: 'terminal-resource-policy/v1',
      stability: 'stable',
      requiredCapabilities: { 'server.ws.router': 7 },
      resources: { 'resourceLimits.ws.perClientOutputQueueMaxBytes': decision },
    }],
  });
}

function issueWsCanaryLease(
  authority: TerminalResourcePolicyLeaseAuthority,
  target: Extract<TerminalResourcePolicyLease['target'], { kind: 'ws' }>,
  decision = 2048,
): TerminalResourcePolicyLease {
  const issued = authority.issue({
    contractId: `TEST-ONLY-WAVE3-STABLE-CONTRACT:${decision}`,
    target,
    selectedTarget: target,
    resource: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    consumer: 'server.ws.router',
    capability: { version: 7, compilerSchemaVersion: 'terminal-resource-policy/v1' },
  });
  assert.equal(issued.mode, 'candidate');
  assert.ok(issued.lease);
  return issued.lease;
}

function subscribeForTest(
  router: WsRouter,
  ws: import('ws').WebSocket,
  clientId = 'client-1',
  sessionIds: readonly string[] = ['session-1'],
): void {
  (router as unknown as { clients: Map<typeof ws, unknown> }).clients.set(ws, {
    clientId,
    connectionId: clientId === 'client-a' ? 'connection-a' : clientId === 'client-b' ? 'connection-b' : `connection-${clientId}`,
    reconnectGeneration: 1,
    outputChannel: true,
    isAlive: true,
    subscribedSessions: new Set(sessionIds),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
  const subscribers = (router as unknown as { sessionSubscribers: Map<string, Set<typeof ws>> })
    .sessionSubscribers;
  for (const sessionId of sessionIds) {
    subscribers.set(sessionId, new Set([ws]));
  }
}

test('PERF-BGSTAB-010 runtime candidate delivery uses a server ledger and control-only cumulative ACK', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      scheduler: {
        snapshot(): {
          lanes: Record<string, { creditBytes: number }>;
          policy: {
            strategy: { source: string };
            socketSoftGateBytes: { source: string };
            creditWindowBytes: { source: string };
          };
        };
      };
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair',
      connectionId: 'epoch-fair',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-1']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-1', new Set([ws]));

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: true,
      connectionEpoch: 'epoch-fair',
    }, 'PERF-BGSTAB-010 candidate capability must be admitted only with a server epoch');

    router.routeSessionOutput('session-1', 'fair-output');
    const output = sent.at(-1);
    assert.deepEqual({
      type: output?.type,
      sessionId: output?.sessionId,
      data: output?.data,
      connectionEpoch: output?.connectionEpoch,
      deliverySeq: output?.deliverySeq,
    }, {
      type: 'output',
      sessionId: 'session-1',
      data: 'fair-output',
      connectionEpoch: 'epoch-fair',
      deliverySeq: 1,
    }, 'PERF-BGSTAB-010 output must carry the server-owned delivery identity');

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:ack',
      sessionId: 'session-1',
      connectionEpoch: 'epoch-fair',
      deliverySeq: 1,
    }));
    const fairSnapshot = client.fairDeliverySchedulers.get(ws)?.scheduler.snapshot();
    assert.deepEqual({
      strategy: fairSnapshot?.policy.strategy.source,
      socketSoftGateBytes: fairSnapshot?.policy.socketSoftGateBytes.source,
      creditWindowBytes: fairSnapshot?.policy.creditWindowBytes.source,
    }, {
      strategy: 'fair-scheduler-decision.json#candidate',
      socketSoftGateBytes: 'resourceLimits.ws.serverBufferedHighWaterBytes',
      creditWindowBytes: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    }, 'PERF-BGSTAB-010 policy must be projected by TerminalResourcePolicy');
    const fairLane = fairSnapshot?.lanes['epoch-fair/session-1'];
    assert.equal((fairLane?.creditBytes ?? 0) > 0,
      true,
      'PERF-BGSTAB-010 only control ACK should return server-owned encoded-byte credit');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 AC-6 unknown-lane ACK keeps an active fair ledger credit unchanged', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      connectionEpoch: string;
      scheduler: { snapshot(): { lanes: Record<string, { creditBytes: number }> } };
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-ac6-active-ledger',
      connectionId: 'epoch-ac6-active-ledger',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-ac6-active-ledger']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-ac6-active-ledger', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-ac6-active-ledger', 'known-lane-output');
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:ack',
      sessionId: 'session-ac6-active-ledger',
      connectionEpoch: 'epoch-ac6-active-ledger',
      deliverySeq: 1,
    }));

    const active = client.fairDeliverySchedulers.get(ws);
    assert.ok(active);
    const creditBefore = active.scheduler.snapshot().lanes['epoch-ac6-active-ledger/session-ac6-active-ledger']?.creditBytes;
    assert.ok(creditBefore && creditBefore > 0, 'the valid ACK must establish non-zero credit before rejection');

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:ack',
      sessionId: 'session-ac6-browser-probe',
      connectionEpoch: active.connectionEpoch,
      deliverySeq: 1,
    }));

    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:ack-rejected',
      sessionId: 'session-ac6-browser-probe',
      connectionEpoch: active.connectionEpoch,
      deliverySeq: 1,
      reason: 'ACK_UNKNOWN_LANE',
    });
    assert.equal(
      active.scheduler.snapshot().lanes['epoch-ac6-active-ledger/session-ac6-active-ledger']?.creditBytes,
      creditBefore,
      'an unknown-lane ACK must not credit an active fair-delivery ledger',
    );
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 refuses fair delivery when the browser cannot recover hidden dropped output', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, unknown>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-hidden-fence',
      connectionId: 'epoch-hidden-fence',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      supportsHiddenDataGapRecovery: false,
    }));

    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: false,
      connectionEpoch: 'epoch-hidden-fence',
      reason: 'hidden-continuity-unsupported',
    });
    assert.equal(client.fairDeliverySchedulers.has(ws), false,
      'a hidden snapshot-restore browser must retain legacy reliable delivery until REL-BGSTAB-012 owns its dataGap recovery');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 candidate transport callback failure releases its failed delivery ledger', () => {
  const router = createFairRouter();
  const socket = createFakeWs({ deferSendCallbacks: true });
  const client = router as unknown as {
    clients: Map<typeof socket.ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof socket.ws>>;
    handleMessage(ws: typeof socket.ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof socket.ws, {
      scheduler: { snapshot(): { lanes: Record<string, { sentDeliverySeqs: number[] }> } };
    }>;
  };
  try {
    client.clients.set(socket.ws, {
      clientId: 'client-fair-send-error',
      connectionId: 'epoch-fair-send-error',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-send-error']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-send-error', new Set([socket.ws]));
    client.handleMessage(socket.ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    socket.flushNextSendCallback();

    router.routeSessionOutput('session-send-error', 'failed-browser-wire');
    socket.setNextCallbackError(new Error('browser wire rejected'));
    socket.flushNextSendCallback();

    assert.equal(client.fairDeliverySchedulers.has(socket.ws), false,
      'the callback error must release the failed delivery ledger before authoritative recovery');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 invalid or inactive delivery ACKs emit an observable protocol rejection', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    handleMessage(socket: typeof ws, raw: string): void;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-rejected-ack',
      connectionId: 'epoch-fair-rejected-ack',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-rejected-ack']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:ack',
      sessionId: 'session-rejected-ack',
      connectionEpoch: 'epoch-fair-rejected-ack',
      deliverySeq: 1,
    }));

    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:ack-rejected',
      sessionId: 'session-rejected-ack',
      connectionEpoch: 'epoch-fair-rejected-ack',
      deliverySeq: 1,
      reason: 'inactive-capability',
    });
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 runtime maintenance replaces an expired delivery with an authoritative screen-repair snapshot', () => {
  const router = createFairRouter({
    seq: 41,
    cols: 120,
    rows: 40,
    data: 'authoritative terminal state',
    truncated: false,
    generatedAt: 1,
    health: 'healthy',
    authorityEpoch: 'authority-41',
    authorityRevision: 41,
  });
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    runFairDeliveryMaintenance(control: typeof ws, now: number): void;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-timeout',
      connectionId: 'epoch-fair-timeout',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-timeout']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-timeout', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-timeout', 'unacknowledged-output');

    client.runFairDeliveryMaintenance(ws, Date.now() + 5_001);

    const recovery = sent.filter(message => message.sessionId === 'session-timeout');
    assert.deepEqual(recovery.map(message => message.type), [
      'output',
      'screen-repair:restore-needed',
      'screen-snapshot',
    ]);
    assert.equal(recovery.some(message => message.data === 'fair-delivery-gap'
      || message.data === 'fair-delivery-checkpoint'), false,
    'fallback must never render synthetic recovery markers as terminal output');
    assert.equal(recovery.at(-1)?.data, 'authoritative terminal state');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 capability withdrawal releases every fair ledger and its maintenance timer', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      scheduler: { snapshot(): { lanes: Record<string, unknown>; cleanup: { heldBytes: number } } };
      maintenanceTimer: NodeJS.Timeout;
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-withdraw',
      connectionId: 'epoch-fair-withdraw',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-withdraw']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-withdraw', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-withdraw', 'held-before-withdraw');

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      enabled: false,
    }));

    assert.equal(client.fairDeliverySchedulers.has(ws), false);
    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: false,
      connectionEpoch: 'epoch-fair-withdraw',
      reason: 'client-withdrew',
    });
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 hidden-continuity capability downgrade releases the active fair ledger', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      scheduler: { snapshot(): { lanes: Record<string, unknown>; cleanup: { heldBytes: number } } };
      maintenanceTimer: NodeJS.Timeout;
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-hidden-downgrade',
      connectionId: 'epoch-fair-hidden-downgrade',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-hidden-downgrade']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-hidden-downgrade', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-hidden-downgrade', 'queued-before-hidden-downgrade');
    const fairOutput = sent.find(message => message.data === 'queued-before-hidden-downgrade');
    assert.equal(client.fairDeliverySchedulers.has(ws), true);
    assert.equal(typeof fairOutput?.deliverySeq, 'number');

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: false,
    }));

    assert.equal(client.fairDeliverySchedulers.has(ws), false,
      'a rejected replacement capability must clear the active lane, ledger, and maintenance timer');
    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: false,
      connectionEpoch: 'epoch-fair-hidden-downgrade',
      reason: 'hidden-continuity-unsupported',
    });
    router.routeSessionOutput('session-fair-hidden-downgrade', 'legacy-after-hidden-downgrade');
    const legacyOutput = sent.at(-1);
    assert.equal(legacyOutput?.data, 'legacy-after-hidden-downgrade');
    assert.equal(legacyOutput?.deliverySeq, undefined,
      'late output after the downgrade must follow legacy delivery rather than the released fair epoch');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 artifact rejection on capability re-admission releases the active fair ledger', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      scheduler: { snapshot(): { lanes: Record<string, unknown>; cleanup: { heldBytes: number } } };
      maintenanceTimer: NodeJS.Timeout;
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-artifact-rejection',
      connectionId: 'epoch-fair-artifact-rejection',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-artifact-rejection']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-artifact-rejection', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-artifact-rejection', 'queued-before-artifact-rejection');
    assert.equal(client.fairDeliverySchedulers.has(ws), true);

    router.updateRuntimeConfig({ resourceLimits: { ws: { perClientOutputQueueMaxBytes: 8192 } } });
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));

    assert.equal(client.fairDeliverySchedulers.has(ws), false,
      'a rejected re-admission must clear the active lane, ledger, and maintenance timer');
    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: false,
      connectionEpoch: 'epoch-fair-artifact-rejection',
      reason: 'decision-artifact-runtime-policy-hash-mismatch',
    });
    router.routeSessionOutput('session-fair-artifact-rejection', 'legacy-after-artifact-rejection');
    assert.equal(sent.at(-1)?.deliverySeq, undefined,
      'late output after artifact rejection must follow legacy delivery rather than the released fair epoch');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 capability re-enable rotates the delivery epoch and rejects delayed old ACKs', () => {
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      connectionEpoch: string;
      scheduler: { snapshot(): { lanes: Record<string, { creditBytes: number }> } };
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-rotate',
      connectionId: 'epoch-fair-rotate',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-rotate']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-rotate', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-rotate', 'old-epoch-output');
    const oldOutput = sent.find(message => message.data === 'old-epoch-output');
    assert.equal(oldOutput?.connectionEpoch, 'epoch-fair-rotate');

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, enabled: false,
    }));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    const active = client.fairDeliverySchedulers.get(ws);
    assert.ok(active);
    assert.notEqual(active.connectionEpoch, oldOutput?.connectionEpoch);

    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:ack',
      sessionId: 'session-fair-rotate',
      connectionEpoch: oldOutput?.connectionEpoch,
      deliverySeq: oldOutput?.deliverySeq,
    }));
    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:ack-rejected',
      sessionId: 'session-fair-rotate',
      connectionEpoch: oldOutput?.connectionEpoch,
      deliverySeq: oldOutput?.deliverySeq,
      reason: 'stale-connection-epoch',
    });
    assert.equal(Object.values(active.scheduler.snapshot().lanes)
      .every(lane => lane.creditBytes === 0), true);
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 delayed old-epoch transport callback cannot settle a re-enabled scheduler', () => {
  const router = createFairRouter();
  const socket = createFakeWs({ deferSendCallbacks: true });
  const client = router as unknown as {
    clients: Map<typeof socket.ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof socket.ws>>;
    handleMessage(ws: typeof socket.ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof socket.ws, {
      connectionEpoch: string;
      scheduler: { snapshot(): { lanes: Record<string, unknown> } };
    }>;
  };
  try {
    client.clients.set(socket.ws, {
      clientId: 'client-fair-callback-rotate',
      connectionId: 'epoch-fair-callback-rotate',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-callback-rotate']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-callback-rotate', new Set([socket.ws]));
    client.handleMessage(socket.ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    socket.flushNextSendCallback();
    router.routeSessionOutput('session-fair-callback-rotate', 'old-callback-output');

    client.handleMessage(socket.ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, enabled: false,
    }));
    client.handleMessage(socket.ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-callback-rotate', 'new-epoch-output');
    const active = client.fairDeliverySchedulers.get(socket.ws);
    assert.ok(active);
    assert.notEqual(active.connectionEpoch, 'epoch-fair-callback-rotate');
    const lanesBeforeDelayedCallback = structuredClone(active.scheduler.snapshot().lanes);
    assert.equal(Object.keys(lanesBeforeDelayedCallback)
      .some(key => key.startsWith(`${active.connectionEpoch}/session-fair-callback-rotate`)), true);

    socket.setNextCallbackError(new Error('late old-epoch callback'));
    socket.flushNextSendCallback();

    assert.equal(client.fairDeliverySchedulers.get(socket.ws), active);
    assert.deepEqual(active.scheduler.snapshot().lanes, lanesBeforeDelayedCallback);
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 last terminated fair lane releases the maintenance timer without disturbing another session', () => {
  const router = createFairRouter();
  const { ws } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, unknown>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-last-lane',
      connectionId: 'epoch-fair-last-lane',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-last-lane']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-last-lane', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-last-lane', 'held-before-exit');

    router.sendSessionEvent('session-fair-last-lane', 'session:exited', { exitCode: 0 });

    assert.equal(client.fairDeliverySchedulers.has(ws), false);
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 session termination releases the fair delivery ledger exactly once', () => {
  const router = createFairRouter();
  const { ws } = createFakeWs();
  const client = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    fairDeliverySchedulers: Map<typeof ws, {
      scheduler: { snapshot(): { lanes: Record<string, unknown>; cleanup: { releases: Record<string, number> } } };
    }>;
  };
  try {
    client.clients.set(ws, {
      clientId: 'client-fair-exit',
      connectionId: 'epoch-fair-exit',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-exit']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-exit', new Set([ws]));
    client.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-exit', 'pending-before-exit');

    router.sendSessionEvent('session-fair-exit', 'session:exited', { exitCode: 0 });
    router.sendSessionEvent('session-fair-exit', 'session:exited', { exitCode: 0 });

    assert.equal(client.fairDeliverySchedulers.has(ws), false,
      'the final terminated lane must remove the scheduler and its maintenance timer exactly once');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 session termination removes queued fair delivery wire frames before transport drain', () => {
  const router = createFairRouter();
  const socket = createFakeWs({ bufferedAmount: FAIR_ARTIFACT_WS_LIMITS.serverBufferedHighWaterBytes });
  const client = router as unknown as {
    clients: Map<typeof socket.ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof socket.ws>>;
    handleMessage(target: typeof socket.ws, raw: string): void;
    flushTransportQueue(target: typeof socket.ws): void;
  };
  try {
    client.clients.set(socket.ws, {
      clientId: 'client-fair-queued-exit',
      connectionId: 'epoch-fair-queued-exit',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-queued-exit']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-queued-exit', new Set([socket.ws]));
    client.handleMessage(socket.ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-queued-exit', 'must-not-drain-after-exit');
    router.sendSessionEvent('session-fair-queued-exit', 'session:exited', { exitCode: 0 });

    socket.setBufferedAmount(0);
    client.flushTransportQueue(socket.ws);
    client.flushTransportQueue(socket.ws);
    client.flushTransportQueue(socket.ws);

    assert.equal(
      socket.sent.some(message => message.type === 'output' && message.data === 'must-not-drain-after-exit'),
      false,
    );
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 unsubscribe removes queued fair delivery and releases the final lane', () => {
  const router = createFairRouter();
  const socket = createFakeWs({ bufferedAmount: FAIR_ARTIFACT_WS_LIMITS.serverBufferedHighWaterBytes });
  const client = router as unknown as {
    clients: Map<typeof socket.ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof socket.ws>>;
    fairDeliverySchedulers: Map<typeof socket.ws, unknown>;
    transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
    handleMessage(target: typeof socket.ws, raw: string): void;
    flushTransportQueue(target: typeof socket.ws): void;
  };
  try {
    client.clients.set(socket.ws, {
      clientId: 'client-fair-queued-unsubscribe',
      connectionId: 'epoch-fair-queued-unsubscribe',
      channelRole: 'control',
      wsTransportMode: 'unified',
      isAlive: true,
      subscribedSessions: new Set(['session-fair-queued-unsubscribe']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    client.sessionSubscribers.set('session-fair-queued-unsubscribe', new Set([socket.ws]));
    client.handleMessage(socket.ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    router.routeSessionOutput('session-fair-queued-unsubscribe', 'must-not-drain-after-unsubscribe');
    assert.equal(socket.sent.some(message => (
      message.type === 'output' && message.data === 'must-not-drain-after-unsubscribe'
    )), false, 'precondition: the fair output must be queued behind backpressure');

    client.handleMessage(socket.ws, JSON.stringify({
      type: 'unsubscribe', sessionIds: ['session-fair-queued-unsubscribe'],
    }));
    const remainingQueuedPayloads = getTransportMessagesInPriorityOrder(
      client.transportQueues.get(socket.ws)!,
    ).map(message => jsonWirePayloadText(message.payload));
    assert.equal(
      remainingQueuedPayloads.some(payload => payload.includes('must-not-drain-after-unsubscribe')),
      false,
      `unsubscribe retained fair wire payload: ${JSON.stringify(remainingQueuedPayloads)}`,
    );

    socket.setBufferedAmount(0);
    client.flushTransportQueue(socket.ws);
    client.flushTransportQueue(socket.ws);
    client.flushTransportQueue(socket.ws);

    assert.equal(
      socket.sent.some(message => message.type === 'output' && message.data === 'must-not-drain-after-unsubscribe'),
      false,
    );
    assert.equal(client.fairDeliverySchedulers.has(socket.ws), false,
      'unsubscribe of the final fair lane must release the scheduler maintenance timer');
  } finally {
    router.destroy();
  }
});

test('safe-send drains independent control before queued output backlog', () => {
  const router = createRouter();
  const { ws, sent, setBufferedAmount } = createFakeWs({ bufferedAmount: 1500 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'queued-output');
    router.sendTo(ws, { type: 'pong' });
    assert.equal(sent.length, 0);

    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);

    assert.equal(sent[0].type, 'pong');
    assert.equal(sent[1].type, 'output');
    assert.equal(sent[1].data, 'queued-output');
  } finally {
    router.destroy();
  }
});

test('safe-send queues output when projected buffered amount crosses high-water', () => {
  const router = createRouter();
  const { ws, sent } = createFakeWs({ bufferedAmount: 900 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'x'.repeat(400));

    assert.equal(sent.length, 0);
    assert.equal(
      (router.getObservabilitySnapshot() as unknown as { transportQueuedClientCount: number })
        .transportQueuedClientCount,
      1,
    );
  } finally {
    router.destroy();
  }
});

test('safe-send closes when projected buffered amount crosses hard limit', () => {
  const router = createRouter();
  const { ws, sent, getCloseCode, getCloseReason } = createFakeWs({ bufferedAmount: 1900 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'x'.repeat(400));

    assert.equal(sent.length, 0);
    assert.equal(getCloseCode(), 1013);
    assert.match(getCloseReason() ?? '', /hard-limit/i);
  } finally {
    router.destroy();
  }
});

test('safe-send preserves output queued while a previous output send is in flight', () => {
  const router = createRouter();
  const { ws, sent, setBufferedAmount, flushNextSendCallback } = createFakeWs({
    bufferedAmount: 1500,
    deferSendCallbacks: true,
  });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'first-output');
    assert.equal(sent.length, 0);

    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].data, 'first-output');

    router.routeSessionOutput('session-1', 'second-output');
    assert.equal(sent.length, 1);

    flushNextSendCallback();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].data, 'second-output');
    assert.equal(
      (router.getObservabilitySnapshot() as unknown as { transportOutputQueuedBytes: number })
        .transportOutputQueuedBytes,
      0,
    );
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-010
test('REL-BGSTAB-010 AC-6 RED — policy rollback does not direct-flush queued output past an in-flight callback', () => {
  const signature = 'REL-BGSTAB-010 AC-6 deferred WS rollback drain 계약 부재 때문에 실패';
  const router = createFairRouter();
  const {
    ws, sent, setBufferedAmount, flushNextSendCallback, flushLastSendCallbackAgain, getCloseCode,
  } = createFakeWs({
    bufferedAmount: 1500,
    deferSendCallbacks: true,
  });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'first-before-rollback');
    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);
    assert.equal(sent.length, 1);

    router.routeSessionOutput('session-1', 'second-before-rollback');
    assert.equal(sent.length, 1);
    router.updateRuntimeConfig({ stabilityModes: { wsSendMode: 'direct' } });
    router.routeSessionOutput('session-1', 'third-after-rollback');

    assert.equal(sent.length, 1, signature);
    assert.equal(getCloseCode(), undefined, signature);
    flushNextSendCallback();
    assert.deepEqual(sent.map(message => message.data), [
      'first-before-rollback',
      'second-before-rollback',
    ], signature);
    const afterFirstCallback = sent.length;
    flushLastSendCallbackAgain();
    assert.equal(sent.length, afterFirstCallback, 'duplicate callback must not advance rollback drain');
    flushNextSendCallback();
    assert.deepEqual(sent.map(message => message.data), [
      'first-before-rollback',
      'second-before-rollback',
      'third-after-rollback',
    ], signature);
    assert.equal(getCloseCode(), undefined, signature);
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-010
test('REL-BGSTAB-010 AC-6 RED — target rollback isolates client B and drains client A callback-by-callback', async () => {
  const signature = 'REL-BGSTAB-010 AC-6 per-target WS rollback isolation 계약 부재 때문에 실패';
  let router: WsRouter | undefined;
  let readRollbackStateAtLegacySend: (() => 'inactive' | 'draining' | 'closed') | undefined;
  let rollbackStateAtLegacySend: 'inactive' | 'draining' | 'closed' | undefined;
  const a = createFakeWs({
    bufferedAmount: 1500,
    deferSendCallbacks: true,
    onSend(message) {
      if (message.data === 'third-a-after-rollback') {
        rollbackStateAtLegacySend = readRollbackStateAtLegacySend?.();
      }
    },
  });
  const b = createFakeWs({ bufferedAmount: 1500, deferSendCallbacks: true });
  const c = createFakeWs({ bufferedAmount: 1500, deferSendCallbacks: true });
  const targetA = {
    kind: 'ws' as const, connectionId: 'connection-a', clientId: 'client-a', channel: 'output' as const,
    reconnectGeneration: 1,
  };
  const targetB = {
    kind: 'ws' as const, connectionId: 'connection-b', clientId: 'client-b', channel: 'output' as const,
    reconnectGeneration: 1,
  };
  const targetC = {
    kind: 'ws' as const, connectionId: 'connection-client-c', clientId: 'client-c', channel: 'output' as const,
    reconnectGeneration: 1,
  };
  type CanaryRouter = {
    activateTerminalResourcePolicyLease(input: { lease: TestValidatedLease }): { mode: 'candidate' | 'legacy'; reason: string };
    rollbackTerminalResourcePolicyLease(input: { lease: TestValidatedLease }): { state: 'draining' | 'closed'; reason: string };
    admitTerminalResourcePolicyCanaryMessage(input: {
      lease: TestValidatedLease;
      incomingMessage: WsTransportMessage;
    }): {
      accepted: boolean;
      mode: 'candidate' | 'legacy';
      reason: string;
      enqueuedExactlyOnce: boolean;
    };
    getTerminalResourcePolicyCanaryState(target: typeof targetA): {
      mode: 'candidate' | 'legacy';
      policyGeneration: number;
      queuedBytes: number;
      ledgerHash: string;
      legacyAdmissionCount: number;
      rollbackState: 'inactive' | 'draining' | 'closed';
      cleanup: { targetHandles: number; listeners: number; timers: number };
    };
  };
  type TestValidatedLease = Readonly<{
    leaseId: string;
    policyId: string;
    target: typeof targetA;
  }>;
  type IssuerModule = {
    createTerminalResourcePolicyLeaseIssuer(options: {
      trustedEvidence: {
        requirementId: string;
        status: string;
        manifestSha256: string;
      };
      contracts: Array<{
          contractId: string;
          policyId: string;
          profileVersion: string;
          schemaVersion: string;
          stability: 'stable';
          requiredCapabilities: Record<string, number>;
          resources: Record<string, number>;
      }>;
    }): {
      issue(input: {
        contractId: string;
        target: typeof targetA;
        selectedTarget: typeof targetA;
        resource: string;
        consumer: string;
        capability: { version: number; compilerSchemaVersion: string };
      }): { mode: 'candidate' | 'legacy'; reason: string; lease?: TestValidatedLease };
      validate(value: unknown): value is TestValidatedLease;
      getLeaseMetadata(value: unknown): Readonly<{ issuanceSequence: number; targetEpoch: number }> | undefined;
      revokeTarget(target: typeof targetA): number;
    };
  };

  try {
    const canaryModulePath: string = '../services/TerminalResourcePolicyCanary.js';
    let module: Partial<IssuerModule>;
    try {
      module = await import(canaryModulePath) as Partial<IssuerModule>;
    } catch {
      assert.fail(`${signature}: runtime-unforgeable issuer module is absent`);
    }
    assert.equal(typeof module.createTerminalResourcePolicyLeaseIssuer, 'function', signature);
    const stableProfile = {
      contractId: 'TEST-ONLY-WAVE3-STABLE-CONTRACT',
      policyId: 'test-only-wave3-reviewed',
      profileVersion: '1.0.0',
      schemaVersion: 'terminal-resource-policy/v1',
      stability: 'stable' as const,
      requiredCapabilities: { 'server.ws.router': 7 },
      resources: { 'resourceLimits.ws.perClientOutputQueueMaxBytes': 2048 },
    };
    const issuer = module.createTerminalResourcePolicyLeaseIssuer!({
      trustedEvidence: {
        requirementId: 'OBS-BGSTAB-005',
        status: 'implemented',
        manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
      },
      contracts: [stableProfile],
    });
    const rogueIssuer = module.createTerminalResourcePolicyLeaseIssuer!({
      trustedEvidence: {
        requirementId: 'OBS-BGSTAB-005',
        status: 'implemented',
        manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
      },
      contracts: [stableProfile],
    });
    const issue = (
      authority: ReturnType<IssuerModule['createTerminalResourcePolicyLeaseIssuer']>,
      target: typeof targetA,
    ): TestValidatedLease => {
      const decision = authority.issue({
        contractId: stableProfile.contractId,
        target,
        selectedTarget: target,
        resource: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
        consumer: 'server.ws.router',
        capability: { version: 7, compilerSchemaVersion: 'terminal-resource-policy/v1' },
      });
      assert.equal(decision.mode, 'candidate');
      assert.ok(decision.lease);
      return decision.lease;
    };
    const leaseA = issue(issuer, targetA);
    const spareLeaseA = issue(issuer, targetA);
    const leaseB = issue(issuer, targetB);
    const leaseC = issue(issuer, targetC);
    const rogueLeaseA = issue(rogueIssuer, targetA);
    assert.equal(issuer.validate(leaseA), true);
    assert.equal(rogueIssuer.validate(rogueLeaseA), true);
    assert.equal(issuer.validate(rogueLeaseA), false,
      'identically configured issuers have disjoint runtime provenance');
    const spareMetadata = issuer.getLeaseMetadata(spareLeaseA);
    assert.ok(spareMetadata);
    assert.equal(spareMetadata.targetEpoch, 0);
    router = createRouter(issuer);
    const canaryRouter = router as unknown as Partial<CanaryRouter>;
    readRollbackStateAtLegacySend = () => canaryRouter
      .getTerminalResourcePolicyCanaryState!(targetA).rollbackState;
    subscribeForTest(router, a.ws, targetA.clientId, ['session-a1', 'session-a2']);
    subscribeForTest(router, b.ws, targetB.clientId, ['session-b1']);
    subscribeForTest(router, c.ws, targetC.clientId, ['session-c1']);
    assert.equal(typeof canaryRouter.activateTerminalResourcePolicyLease, 'function', signature);
    assert.equal(typeof canaryRouter.rollbackTerminalResourcePolicyLease, 'function', signature);
    assert.equal(typeof canaryRouter.getTerminalResourcePolicyCanaryState, 'function', signature);
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: leaseA }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: leaseB }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: leaseC }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    const beforeInvalidProvenance = {
      a: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState!(targetA)),
      b: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState!(targetB)),
    };
    for (const invalidLease of [{ ...leaseA } as TestValidatedLease, rogueLeaseA]) {
      assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: invalidLease }), {
        mode: 'legacy', reason: 'invalid-policy-lease',
      });
      assert.deepEqual({
        a: canaryRouter.getTerminalResourcePolicyCanaryState!(targetA),
        b: canaryRouter.getTerminalResourcePolicyCanaryState!(targetB),
      }, beforeInvalidProvenance, 'invalid provenance rejection must not mutate either target');
    }
    const candidateGeneration = canaryRouter.getTerminalResourcePolicyCanaryState!(targetA).policyGeneration;

    router.routeSessionOutput('session-a1', 'first-a');
    a.setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof a.ws) => void }).flushTransportQueue(a.ws);
    router.routeSessionOutput('session-a2', 'second-a');
    router.routeSessionOutput('session-b1', 'only-b');
    const bBefore = canaryRouter.getTerminalResourcePolicyCanaryState!(targetB);

    assert.deepEqual(canaryRouter.rollbackTerminalResourcePolicyLease!({ lease: leaseA }), {
      state: 'draining', reason: 'rollback-draining',
    });
    const aAfterRollback = canaryRouter.getTerminalResourcePolicyCanaryState!(targetA);
    assert.equal(aAfterRollback.mode, 'legacy');
    assert.equal(aAfterRollback.rollbackState, 'draining');
    assert.ok(aAfterRollback.policyGeneration > candidateGeneration);
    router.routeSessionOutput('session-a1', 'third-a-after-rollback');
    assert.equal(canaryRouter.getTerminalResourcePolicyCanaryState!(targetA).legacyAdmissionCount, 1);
    const queueState = (router as unknown as {
      transportQueues: Map<typeof a.ws, WsTransportQueueState>;
    }).transportQueues.get(a.ws);
    assert.ok(queueState);
    const pending = getTransportMessagesInPriorityOrder(queueState) as Array<{
      outputData?: string; policyGeneration?: number; payload: WirePayload;
    }>;
    const second = pending.find(message => message.outputData === 'second-a');
    const third = pending.find(message => message.outputData === 'third-a-after-rollback');
    assert.equal(second?.policyGeneration, candidateGeneration, 'old entry retains its candidate generation');
    assert.equal(third?.policyGeneration, aAfterRollback.policyGeneration, 'new admission uses the new legacy generation');
    assert.notEqual(third?.policyGeneration, second?.policyGeneration);
    assert.deepEqual(a.sent.map(message => message.data), ['first-a'], signature);
    assert.equal(a.getCloseCode(), undefined, signature);
    assert.deepEqual(canaryRouter.getTerminalResourcePolicyCanaryState!(targetB), bBefore, signature);

    a.flushNextSendCallback();
    assert.deepEqual(a.sent.map(message => message.data), ['first-a', 'second-a'], signature);
    assert.equal(canaryRouter.getTerminalResourcePolicyCanaryState!(targetA).rollbackState, 'draining');
    const sentAfterFirstCallback = a.sent.length;
    a.flushLastSendCallbackAgain();
    assert.equal(a.sent.length, sentAfterFirstCallback, 'duplicate callback must be rejected');
    a.flushNextSendCallback();
    assert.deepEqual(a.sent.map(message => message.data), ['first-a', 'second-a', 'third-a-after-rollback'], signature);
    assert.equal(rollbackStateAtLegacySend, 'closed',
      'rollback must already be closed at the later legacy frame send boundary');
    const closedAfterOldEntries = canaryRouter.getTerminalResourcePolicyCanaryState!(targetA);
    assert.equal(closedAfterOldEntries.rollbackState, 'closed',
      'rollback closes as soon as the last pre-rollback candidate entry drains, without waiting on later legacy output');
    assert.deepEqual(closedAfterOldEntries.cleanup, { targetHandles: 0, listeners: 0, timers: 0 });
    assert.equal(a.sent.every(message => !('policyGeneration' in message)), true, 'internal generation must never reach the wire');
    a.flushNextSendCallback();
    assert.deepEqual(canaryRouter.getTerminalResourcePolicyCanaryState!(targetB), bBefore, signature);
    const finalA = canaryRouter.getTerminalResourcePolicyCanaryState!(targetA);
    assert.equal(finalA.rollbackState, 'closed');
    assert.equal(finalA.policyGeneration, closedAfterOldEntries.policyGeneration,
      'the later legacy callback is stale to the already-closed rollback ledger');
    assert.deepEqual(finalA.cleanup, { targetHandles: 0, listeners: 0, timers: 0 });
    assert.equal(typeof canaryRouter.admitTerminalResourcePolicyCanaryMessage, 'function', signature);
    const queueBeforeRevokedReuse = (router as unknown as {
      transportQueues: Map<typeof a.ws, WsTransportQueueState>;
    }).transportQueues.get(a.ws);
    const revokedReuseBefore = {
      a: structuredClone(finalA),
      b: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState!(targetB)),
      queue: queueBeforeRevokedReuse
        ? structuredClone(getTransportMessagesInPriorityOrder(queueBeforeRevokedReuse))
        : [],
      sent: structuredClone(a.sent),
    };
    for (const [index, revokedLease] of [leaseA, spareLeaseA].entries()) {
      assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: revokedLease }), {
        mode: 'legacy', reason: 'lease-revoked',
      }, 'neither the used lease nor a pre-issued spare can reactivate the rolled-back target');
      assert.deepEqual(canaryRouter.admitTerminalResourcePolicyCanaryMessage!({
        lease: revokedLease,
        incomingMessage: createWsTransportMessage({
          type: 'output', sessionId: 'session-a1', data: `revoked-lease-output-${index}`,
        }, 500 + index),
      }), {
        accepted: false, mode: 'legacy', reason: 'lease-revoked', enqueuedExactlyOnce: false,
      }, 'neither the used lease nor a pre-issued spare can admit output after target rollback');
    }
    const queueAfterRevokedReuse = (router as unknown as {
      transportQueues: Map<typeof a.ws, WsTransportQueueState>;
    }).transportQueues.get(a.ws);
    assert.deepEqual({
      a: canaryRouter.getTerminalResourcePolicyCanaryState!(targetA),
      b: canaryRouter.getTerminalResourcePolicyCanaryState!(targetB),
      queue: queueAfterRevokedReuse
        ? getTransportMessagesInPriorityOrder(queueAfterRevokedReuse)
        : [],
      sent: a.sent,
    }, revokedReuseBefore, 'revoked lease rejection must be state-preserving');

    const freshLeaseA = issue(issuer, targetA);
    assert.notEqual(freshLeaseA.leaseId, leaseA.leaseId);
    const freshMetadata = issuer.getLeaseMetadata(freshLeaseA);
    assert.ok(freshMetadata);
    assert.ok(freshMetadata.targetEpoch > spareMetadata.targetEpoch,
      'rollback revokes the whole target epoch, including unused pre-issued leases');
    assert.ok(freshMetadata.issuanceSequence > spareMetadata.issuanceSequence,
      'the post-rollback lease has a fresh monotonic issuance sequence');
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: freshLeaseA }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    const reactivatedA = canaryRouter.getTerminalResourcePolicyCanaryState!(targetA);
    assert.ok(reactivatedA.policyGeneration > finalA.policyGeneration,
      're-activation requires a fresh lease and a fresh monotonic generation');
    assert.deepEqual(canaryRouter.rollbackTerminalResourcePolicyLease!({ lease: freshLeaseA }), {
      state: 'closed', reason: 'rollback-closed',
    });
    const throwingLeaseA = issue(issuer, targetA);
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: throwingLeaseA }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    const originalASend = a.ws.send.bind(a.ws);
    let throwCandidateAOnce = true;
    (a.ws as unknown as { send(payload: string, callback?: (error?: Error) => void): void }).send = (
      payload,
      callback,
    ) => {
      if (throwCandidateAOnce) {
        throwCandidateAOnce = false;
        throw new Error('synchronous candidate send failure');
      }
      originalASend(payload, callback);
    };
    a.setBufferedAmount(0);
    router.routeSessionOutput('session-a1', 'candidate-sync-throw');
    assert.equal(a.getCloseCode(), undefined,
      'candidate application failure settles only target A without closing the peer');
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: throwingLeaseA }), {
      mode: 'legacy', reason: 'lease-revoked',
    }, 'synchronous send failure must settle and revoke the target');
    await Promise.resolve();
    a.flushNextSendCallback();
    assert.equal(canaryRouter.getTerminalResourcePolicyCanaryState!(targetA).rollbackState, 'closed');

    router.routeSessionOutput('session-c1', 'candidate-c-in-flight');
    c.setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof c.ws) => void }).flushTransportQueue(c.ws);
    router.routeSessionOutput('session-c1', 'candidate-c-queued');
    c.setNextCallbackError(new Error('candidate callback failure'));
    c.flushNextSendCallback();
    await Promise.resolve();
    assert.equal(c.getCloseCode(), undefined,
      'candidate callback failure preserves target C transport while settling its policy');
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: leaseC }), {
      mode: 'legacy', reason: 'lease-revoked',
    }, 'callback error with queued candidate output must settle and revoke the target');
    assert.equal(canaryRouter.getTerminalResourcePolicyCanaryState!(targetC).rollbackState, 'draining');
    c.flushNextSendCallback();
    c.flushNextSendCallback();
    assert.equal(canaryRouter.getTerminalResourcePolicyCanaryState!(targetC).rollbackState, 'closed');

    const disconnectMetadata = issuer.getLeaseMetadata(leaseB);
    assert.ok(disconnectMetadata);
    (router as unknown as { handleDisconnect(socket: typeof b.ws): void }).handleDisconnect(b.ws);
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease!({ lease: leaseB }), {
      mode: 'legacy', reason: 'lease-revoked',
    }, 'transport disconnect revokes the active target epoch');
    const postDisconnectLease = issue(issuer, targetB);
    const postDisconnectMetadata = issuer.getLeaseMetadata(postDisconnectLease);
    assert.ok(postDisconnectMetadata);
    assert.ok(postDisconnectMetadata.targetEpoch > disconnectMetadata.targetEpoch);
    const disconnectedState = canaryRouter.getTerminalResourcePolicyCanaryState!(targetB);
    assert.equal(disconnectedState.rollbackState, 'closed');
    assert.deepEqual(disconnectedState.cleanup, { targetHandles: 0, listeners: 0, timers: 0 });
  } finally {
    router?.destroy();
  }
});

test('REL-BGSTAB-010 WS rollback blocks fresh activation until the old callback fence closes', () => {
  const authority = createWsCanaryAuthority();
  const target = {
    kind: 'ws' as const, connectionId: 'connection-client-fence', clientId: 'client-fence',
    channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs({ bufferedAmount: 1500, deferSendCallbacks: true });
  const router = createRouter(authority);
  try {
    subscribeForTest(router, socket.ws, target.clientId, ['session-fence']);
    const oldLease = issueWsCanaryLease(authority, target);
    assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease: oldLease }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    router.routeSessionOutput('session-fence', 'candidate-in-flight');
    socket.setBufferedAmount(0);
    (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
      .flushTransportQueue(socket.ws);
    router.routeSessionOutput('session-fence', 'candidate-queued');
    assert.deepEqual(router.rollbackTerminalResourcePolicyLease({ lease: oldLease }), {
      state: 'draining', reason: 'rollback-draining',
    });

    const freshLease = issueWsCanaryLease(authority, target);
    assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease: freshLease }), {
      mode: 'legacy', reason: 'rollback-draining',
    }, 'a new-epoch lease cannot overlap the old candidate callback fence');
    socket.flushNextSendCallback();
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
    socket.flushNextSendCallback();
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
    assert.deepEqual(socket.sent.map(message => message.data), [
      'candidate-in-flight', 'candidate-queued',
    ]);
    assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease: freshLease }), {
      mode: 'candidate', reason: 'candidate-selected',
    }, 'fresh activation becomes legal only after the old callback closes rollback');
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-010 WS rollback fences every pre-boundary generation before closing', () => {
  const authority = createWsCanaryAuthority();
  const target = {
    kind: 'ws' as const, connectionId: 'connection-client-all-generations', clientId: 'client-all-generations',
    channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs({ bufferedAmount: 1500, deferSendCallbacks: true });
  const router = createRouter(authority);
  try {
    subscribeForTest(router, socket.ws, target.clientId, ['session-all-generations']);
    const generationALease = issueWsCanaryLease(authority, target);
    router.activateTerminalResourcePolicyLease({ lease: generationALease });
    router.routeSessionOutput('session-all-generations', 'generation-a-first');
    router.routeSessionOutput('session-all-generations', 'generation-a-second');
    const generationBLease = issueWsCanaryLease(authority, target);
    router.activateTerminalResourcePolicyLease({ lease: generationBLease });
    assert.deepEqual(router.rollbackTerminalResourcePolicyLease({ lease: generationBLease }), {
      state: 'draining', reason: 'rollback-draining',
    }, 'older generation A entries are part of the rollback pre-boundary even when B has no output');
    const freshLease = issueWsCanaryLease(authority, target);
    assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease: freshLease }), {
      mode: 'legacy', reason: 'rollback-draining',
    });
    router.routeSessionOutput('session-all-generations', 'post-boundary-legacy');
    socket.setBufferedAmount(0);
    (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
      .flushTransportQueue(socket.ws);
    socket.flushNextSendCallback();
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
    socket.flushNextSendCallback();
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed',
      'rollback closes after every captured pre-boundary entry, without waiting for later legacy output');
    socket.flushNextSendCallback();
    assert.deepEqual(socket.sent.map(message => message.data), [
      'generation-a-first', 'generation-a-second', 'post-boundary-legacy',
    ]);
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-010 production route grandfathers preserved backlog above a smaller candidate cap', () => {
  const authority = createWsCanaryAuthority(128);
  const target = {
    kind: 'ws' as const, connectionId: 'connection-client-production-grandfather',
    clientId: 'client-production-grandfather', channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs({ bufferedAmount: 1500 });
  const router = createRouter(authority);
  try {
    subscribeForTest(router, socket.ws, target.clientId, ['session-production-grandfather']);
    router.routeSessionOutput('session-production-grandfather', 'legacy-a'.repeat(12));
    router.routeSessionOutput('session-production-grandfather', 'legacy-b'.repeat(12));
    const queue = (router as unknown as {
      transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
    }).transportQueues.get(socket.ws)!;
    const before = structuredClone(getTransportMessagesInPriorityOrder(queue));
    assert.ok(queue.outputBytes > 128);
    const lease = issueWsCanaryLease(authority, target, 128);
    router.activateTerminalResourcePolicyLease({ lease });
    router.routeSessionOutput('session-production-grandfather', 'n');
    assert.equal(socket.getCloseCode(), undefined,
      'candidate selection cannot turn a valid preserved backlog into a forced reconnect');
    const after = getTransportMessagesInPriorityOrder(queue);
    assert.deepEqual(after.slice(0, before.length), before,
      'existing queue bytes, order and identity remain unchanged');
    assert.equal(after.at(-1)?.outputData, 'n');
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).mode, 'candidate');
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-010 explicit admission flushes in direct and observe modes without a permanent queue', () => {
  for (const mode of ['direct', 'safe-send-observe'] as const) {
    const authority = createWsCanaryAuthority();
    const target = {
      kind: 'ws' as const, connectionId: `connection-client-${mode}`, clientId: `client-${mode}`,
      channel: 'output' as const, reconnectGeneration: 1,
    };
    const socket = createFakeWs({ bufferedAmount: 1500 });
    const router = createRouter(authority, mode);
    try {
      subscribeForTest(router, socket.ws, target.clientId, [`session-${mode}`]);
      const lease = issueWsCanaryLease(authority, target);
      router.activateTerminalResourcePolicyLease({ lease });
      const admitted = router.admitTerminalResourcePolicyCanaryMessage({
        lease,
        incomingMessage: createWsTransportMessage({
          type: 'output', sessionId: `session-${mode}`, data: `explicit-${mode}`,
        }, 100),
      });
      assert.equal(admitted.accepted, true);
      assert.equal(admitted.enqueuedExactlyOnce, true);
      assert.deepEqual(socket.sent.map(message => message.data), [`explicit-${mode}`],
        `${mode} explicit admission must reach the actual socket`);
      const queue = (router as unknown as {
        transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
      }).transportQueues.get(socket.ws);
      assert.equal(queue ? getTransportMessagesInPriorityOrder(queue).length : 0, 0,
        `${mode} explicit admission cannot remain permanently queued`);
    } finally {
      router.destroy();
    }
  }
});

test('REL-BGSTAB-010 direct and observe candidate send failures settle to legacy without forced reconnect', async () => {
  for (const [mode, failureKind] of [
    ['direct', 'sync-throw'],
    ['safe-send-observe', 'callback-error'],
  ] as const) {
    const authority = createWsCanaryAuthority();
    const target = {
      kind: 'ws' as const, connectionId: `connection-client-error-${mode}`, clientId: `client-error-${mode}`,
      channel: 'output' as const, reconnectGeneration: 1,
    };
    const socket = createFakeWs({ bufferedAmount: 0, deferSendCallbacks: failureKind === 'callback-error' });
    const router = createRouter(authority, mode);
    try {
      subscribeForTest(router, socket.ws, target.clientId, [`session-error-${mode}`]);
      const lease = issueWsCanaryLease(authority, target);
      router.activateTerminalResourcePolicyLease({ lease });
      if (failureKind === 'sync-throw') {
        const originalSend = socket.ws.send.bind(socket.ws);
        let throwOnce = true;
        (socket.ws as unknown as { send(payload: string, callback?: (error?: Error) => void): void }).send = (
          payload,
          callback,
        ) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('candidate direct synchronous failure');
          }
          originalSend(payload, callback);
        };
      }
      const admitted = router.admitTerminalResourcePolicyCanaryMessage({
        lease,
        incomingMessage: createWsTransportMessage({
          type: 'output', sessionId: `session-error-${mode}`, data: `candidate-error-${mode}`,
        }, 200),
      });
      assert.equal(admitted.enqueuedExactlyOnce, true);
      if (failureKind === 'sync-throw') await Promise.resolve();
      if (failureKind === 'callback-error') {
        const queued = router.admitTerminalResourcePolicyCanaryMessage({
          lease,
          incomingMessage: createWsTransportMessage({
            type: 'output', sessionId: `session-error-${mode}`, data: `preserved-after-error-${mode}`,
          }, 201),
        });
        assert.equal(queued.enqueuedExactlyOnce, true);
      }
      if (failureKind === 'callback-error') {
        socket.setNextCallbackError(new Error('candidate observe callback failure'));
        socket.flushNextSendCallback();
        await Promise.resolve();
      }
      assert.equal(socket.getCloseCode(), undefined,
        `${mode} candidate failure must retain the original legacy no-close transport semantics`);
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).mode, 'legacy');
      if (failureKind === 'callback-error') {
        const queue = (router as unknown as {
          transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
        }).transportQueues.get(socket.ws);
        assert.equal(queue ? getTransportMessagesInPriorityOrder(queue).length : 0, 1,
          'the failed front entry retries in-flight before the preserved second entry');
        assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
        socket.flushNextSendCallback();
        socket.flushNextSendCallback();
      }
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
      assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease }), {
        mode: 'legacy', reason: 'lease-revoked',
      });
    } finally {
      router.destroy();
    }
  }
});

test('REL-BGSTAB-010 enforce candidate synchronous failure settles only the canary target', async () => {
  const authority = createWsCanaryAuthority();
  const clientId = 'client-error-safe-send-enforce';
  const target = {
    kind: 'ws' as const, connectionId: `connection-${clientId}`, clientId,
    channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs();
  const router = createRouter(authority, 'safe-send-enforce');
  try {
    subscribeForTest(router, socket.ws, clientId, ['session-error-safe-send-enforce']);
    const lease = issueWsCanaryLease(authority, target);
    router.activateTerminalResourcePolicyLease({ lease });
    assert.equal(router.admitTerminalResourcePolicyCanaryMessage({
      lease,
      incomingMessage: createWsTransportMessage({
        type: 'output', sessionId: 'session-error-safe-send-enforce', data: 'candidate-error-enforce',
      }, 250),
    }).accepted, true);
    const originalSend = socket.ws.send.bind(socket.ws);
    let throwOnce = true;
    (socket.ws as unknown as { send(payload: string, callback?: (error?: Error) => void): void }).send = (
      payload,
      callback,
    ) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('candidate enforce synchronous failure');
      }
      originalSend(payload, callback);
    };
    (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
      .flushTransportQueue(socket.ws);
    await Promise.resolve();

    assert.equal(socket.getCloseCode(), undefined,
      'an application-level candidate failure must not inherit legacy enforce reconnect semantics');
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).mode, 'legacy');
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
    assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease }), {
      mode: 'legacy', reason: 'lease-revoked',
    });
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-010 candidate callback failure automatically resumes the preserved queue in every mode', async () => {
  for (const mode of ['direct', 'safe-send-observe', 'safe-send-enforce'] as const) {
    const authority = createWsCanaryAuthority();
    const clientId = `client-auto-resume-${mode}`;
    const target = {
      kind: 'ws' as const, connectionId: `connection-${clientId}`, clientId,
      channel: 'output' as const, reconnectGeneration: 1,
    };
    const socket = createFakeWs({ deferSendCallbacks: true });
    const router = createRouter(authority, mode);
    try {
      subscribeForTest(router, socket.ws, clientId, [`session-auto-resume-${mode}`]);
      const lease = issueWsCanaryLease(authority, target);
      router.activateTerminalResourcePolicyLease({ lease });
      for (const [index, data] of ['candidate-first', 'candidate-second'].entries()) {
        assert.equal(router.admitTerminalResourcePolicyCanaryMessage({
          lease,
          incomingMessage: createWsTransportMessage({
            type: 'output', sessionId: `session-auto-resume-${mode}`, data,
          }, 300 + index),
        }).accepted, true);
      }
      if (mode === 'safe-send-enforce') {
        (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
          .flushTransportQueue(socket.ws);
      }
      socket.setNextCallbackError(new Error(`candidate callback failure ${mode}`));
      socket.flushNextSendCallback();
      await Promise.resolve();

      const queue = (router as unknown as {
        transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
      }).transportQueues.get(socket.ws);
      assert.equal(queue ? getTransportMessagesInPriorityOrder(queue).length : 0, 1,
        `${mode} retries the failed front entry before the preserved second entry`);
      assert.equal(socket.getCloseCode(), undefined);
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
      socket.flushNextSendCallback();
      socket.flushNextSendCallback();
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
    } finally {
      router.destroy();
    }
  }
});

test('REL-BGSTAB-010 persistent candidate callback failure holds the complete boundary without a retry loop', async () => {
  for (const mode of ['direct', 'safe-send-observe', 'safe-send-enforce'] as const) {
    const authority = createWsCanaryAuthority();
    const clientId = `client-persistent-${mode}`;
    const sessionId = `session-persistent-${mode}`;
    const target = {
      kind: 'ws' as const, connectionId: `connection-${clientId}`, clientId,
      channel: 'output' as const, reconnectGeneration: 1,
    };
    const socket = createFakeWs({ deferSendCallbacks: true });
    const router = createRouter(authority, mode);
    try {
      subscribeForTest(router, socket.ws, clientId, [sessionId]);
      const lease = issueWsCanaryLease(authority, target);
      router.activateTerminalResourcePolicyLease({ lease });
      for (const [index, data] of ['persistent-first', 'persistent-second', 'persistent-third'].entries()) {
        assert.equal(router.admitTerminalResourcePolicyCanaryMessage({
          lease,
          incomingMessage: createWsTransportMessage({ type: 'output', sessionId, data }, 350 + index),
        }).accepted, true);
      }
      if (mode === 'safe-send-enforce') {
        (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
          .flushTransportQueue(socket.ws);
      }
      socket.setPersistentCallbackError(new Error(`persistent callback failure ${mode}`));
      socket.flushNextSendCallback();
      await Promise.resolve();
      socket.flushNextSendCallback();
      await Promise.resolve();

      const queueState = (router as unknown as {
        transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
      }).transportQueues.get(socket.ws);
      const held = queueState ? getTransportMessagesInPriorityOrder(queueState) : [];
      assert.deepEqual(held.map(message => message.outputData), [
        'persistent-first', 'persistent-second', 'persistent-third',
      ], `${mode} retains the failed front entry and every later boundary entry in original order`);
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
      assert.equal(socket.getCloseCode(), undefined);
      assert.ok(router.getTerminalResourcePolicyCanaryLedger({ lease }).entries
        .some(entry => entry.reason.includes('send-callback-error')),
      `${mode} exposes the persistent transport failure in the target ledger`);
      const heldAttemptCount = socket.sent.length;
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(socket.sent.length, heldAttemptCount,
        `${mode} does not create a busy microtask retry loop after the bounded retry is held`);

      socket.setPersistentCallbackError(undefined);
      router.routeSessionOutput(sessionId, 'recovery-trigger');
      for (let index = 0; index < 4; index += 1) {
        socket.flushNextSendCallback();
        await Promise.resolve();
      }
      assert.deepEqual(socket.successful.map(message => message.data), [
        'persistent-first', 'persistent-second', 'persistent-third', 'recovery-trigger',
      ], `${mode} recovery drains retained output exactly once in original order`);
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
    } finally {
      router.destroy();
    }
  }
});

test('REL-BGSTAB-010 persistent candidate synchronous failure holds the complete boundary without a retry loop', async () => {
  const authority = createWsCanaryAuthority();
  const clientId = 'client-persistent-sync-enforce';
  const sessionId = 'session-persistent-sync-enforce';
  const target = {
    kind: 'ws' as const, connectionId: `connection-${clientId}`, clientId,
    channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs({ deferSendCallbacks: true });
  const router = createRouter(authority, 'safe-send-enforce');
  const originalSend = socket.ws.send.bind(socket.ws);
  let failing = true;
  try {
    subscribeForTest(router, socket.ws, clientId, [sessionId]);
    const lease = issueWsCanaryLease(authority, target);
    router.activateTerminalResourcePolicyLease({ lease });
    for (const [index, data] of ['sync-first', 'sync-second', 'sync-third'].entries()) {
      assert.equal(router.admitTerminalResourcePolicyCanaryMessage({
        lease,
        incomingMessage: createWsTransportMessage({ type: 'output', sessionId, data }, 380 + index),
      }).accepted, true);
    }
    (socket.ws as unknown as { send(payload: string, callback?: (error?: Error) => void): void }).send = (
      payload,
      callback,
    ) => {
      if (failing) throw new Error('persistent synchronous enforce failure');
      originalSend(payload, callback);
    };
    (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
      .flushTransportQueue(socket.ws);
    await Promise.resolve();
    await Promise.resolve();

    const queueState = (router as unknown as {
      transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
    }).transportQueues.get(socket.ws);
    assert.deepEqual(
      queueState ? getTransportMessagesInPriorityOrder(queueState).map(message => message.outputData) : [],
      ['sync-first', 'sync-second', 'sync-third'],
    );
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
    assert.equal(socket.getCloseCode(), undefined);
    const heldAttemptCount = socket.sent.length;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(socket.sent.length, heldAttemptCount,
      'persistent synchronous failure has no busy microtask retry loop after hold');

    failing = false;
    router.routeSessionOutput(sessionId, 'sync-recovery-trigger');
    for (let index = 0; index < 4; index += 1) {
      socket.flushNextSendCallback();
      await Promise.resolve();
    }
    assert.deepEqual(socket.successful.map(message => message.data), [
      'sync-first', 'sync-second', 'sync-third', 'sync-recovery-trigger',
    ]);
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
  } finally {
    failing = false;
    router.destroy();
  }
});

test('REL-BGSTAB-010 rollback-boundary send failures preserve queued transport in direct and observe modes', async () => {
  for (const [mode, failureKind] of [
    ['direct', 'in-flight-callback'],
    ['safe-send-observe', 'queued-sync-throw'],
  ] as const) {
    const authority = createWsCanaryAuthority();
    const clientId = `client-rollback-error-${mode}`;
    const target = {
      kind: 'ws' as const, connectionId: `connection-${clientId}`,
      clientId, channel: 'output' as const, reconnectGeneration: 1,
    };
    const socket = createFakeWs({ deferSendCallbacks: true });
    const router = createRouter(authority, mode);
    try {
      subscribeForTest(router, socket.ws, target.clientId, [`session-rollback-error-${mode}`]);
      const lease = issueWsCanaryLease(authority, target);
      router.activateTerminalResourcePolicyLease({ lease });
      for (const [index, data] of ['pre-boundary-first', 'pre-boundary-second'].entries()) {
        assert.equal(router.admitTerminalResourcePolicyCanaryMessage({
          lease,
          incomingMessage: createWsTransportMessage({
            type: 'output', sessionId: `session-rollback-error-${mode}`, data,
          }, 500 + index),
        }).accepted, true);
      }
      assert.deepEqual(router.rollbackTerminalResourcePolicyLease({ lease }), {
        state: 'draining', reason: 'rollback-draining',
      });
      if (failureKind === 'in-flight-callback') {
        socket.setNextCallbackError(new Error('rollback boundary callback failure'));
        socket.flushNextSendCallback();
        await Promise.resolve();
        const queue = (router as unknown as {
          transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
        }).transportQueues.get(socket.ws);
        assert.equal(queue ? getTransportMessagesInPriorityOrder(queue).length : 0, 1);
        assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
        socket.flushNextSendCallback();
        socket.flushNextSendCallback();
      } else {
        const originalSend = socket.ws.send.bind(socket.ws);
        let throwOnce = true;
        (socket.ws as unknown as { send(payload: string, callback?: (error?: Error) => void): void }).send = (
          payload,
          callback,
        ) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('rollback queued synchronous failure');
          }
          originalSend(payload, callback);
        };
        socket.flushNextSendCallback();
        await Promise.resolve();
        socket.flushNextSendCallback();
      }
      assert.equal(socket.getCloseCode(), undefined,
        `${mode} rollback error retains the baseline no-close transport contract`);
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
      assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease }), {
        mode: 'legacy', reason: 'lease-revoked',
      });
    } finally {
      router.destroy();
    }
  }
});

test('REL-BGSTAB-010 enforce rollback callback failure preserves the remaining pre-boundary queue', async () => {
  const authority = createWsCanaryAuthority();
  const clientId = 'client-rollback-error-safe-send-enforce';
  const target = {
    kind: 'ws' as const, connectionId: `connection-${clientId}`, clientId,
    channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs({ deferSendCallbacks: true });
  const router = createRouter(authority, 'safe-send-enforce');
  try {
    subscribeForTest(router, socket.ws, clientId, ['session-rollback-error-safe-send-enforce']);
    const lease = issueWsCanaryLease(authority, target);
    router.activateTerminalResourcePolicyLease({ lease });
    for (const [index, data] of ['pre-boundary-first', 'pre-boundary-second'].entries()) {
      assert.equal(router.admitTerminalResourcePolicyCanaryMessage({
        lease,
        incomingMessage: createWsTransportMessage({
          type: 'output', sessionId: 'session-rollback-error-safe-send-enforce', data,
        }, 550 + index),
      }).accepted, true);
    }
    (router as unknown as { flushTransportQueue(ws: typeof socket.ws): void })
      .flushTransportQueue(socket.ws);
    assert.deepEqual(router.rollbackTerminalResourcePolicyLease({ lease }), {
      state: 'draining', reason: 'rollback-draining',
    });
    socket.setNextCallbackError(new Error('rollback boundary enforce callback failure'));
    socket.flushNextSendCallback();
    await Promise.resolve();

    assert.equal(socket.getCloseCode(), undefined,
      'a rollback-boundary application failure must not close the peer in enforce mode');
    const queue = (router as unknown as {
      transportQueues: Map<typeof socket.ws, WsTransportQueueState>;
    }).transportQueues.get(socket.ws);
    assert.equal(queue ? getTransportMessagesInPriorityOrder(queue).length : 0, 1,
      'the failed front entry retries before the remaining exact pre-boundary entry');
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'draining');
    socket.flushNextSendCallback();
    socket.flushNextSendCallback();
    assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-010 legacy overflow records rejection before bounded target close cleanup', () => {
  const authority = createWsCanaryAuthority(8);
  const target = {
    kind: 'ws' as const, connectionId: 'connection-client-overflow', clientId: 'client-overflow',
    channel: 'output' as const, reconnectGeneration: 1,
  };
  const socket = createFakeWs();
  const router = createRouter(authority);
  try {
    subscribeForTest(router, socket.ws, target.clientId, ['session-overflow']);
    const lease = issueWsCanaryLease(authority, target, 8);
    router.activateTerminalResourcePolicyLease({ lease });
    const result = router.admitTerminalResourcePolicyCanaryMessage({
      lease,
      incomingMessage: createWsTransportMessage({
        type: 'output', sessionId: 'session-overflow', data: 'x'.repeat(8_192),
      }, 300),
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'legacy-output-queue-overflow');
    assert.equal(socket.getCloseCode(), 1013);
    const ledger = router.getTerminalResourcePolicyCanaryLedger({ lease });
    const tail = ledger.entries.slice(-4).map(entry => entry.event);
    assert.deepEqual(tail, [
      'admission-rejected', 'rollback-requested', 'rollback-draining', 'rollback-closed',
    ], 'overflow rejection is recorded before the target enters terminal closed state');
    assert.ok(ledger.entries.length <= ledger.capacity);
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-010 direct and observe admission overflow fences only the target without reconnect', () => {
  for (const mode of ['direct', 'safe-send-observe'] as const) {
    const authority = createWsCanaryAuthority(8);
    const clientId = `client-overflow-${mode}`;
    const target = {
      kind: 'ws' as const, connectionId: `connection-${clientId}`,
      clientId, channel: 'output' as const, reconnectGeneration: 1,
    };
    const socket = createFakeWs();
    const router = createRouter(authority, mode);
    try {
      subscribeForTest(router, socket.ws, target.clientId, [`session-overflow-${mode}`]);
      const lease = issueWsCanaryLease(authority, target, 8);
      router.activateTerminalResourcePolicyLease({ lease });
      const result = router.admitTerminalResourcePolicyCanaryMessage({
        lease,
        incomingMessage: createWsTransportMessage({
          type: 'output', sessionId: `session-overflow-${mode}`, data: 'x'.repeat(8_192),
        }, 400),
      });
      assert.equal(result.accepted, false);
      assert.equal(socket.getCloseCode(), undefined,
        `${mode} keeps its legacy no-close overflow semantics`);
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).mode, 'legacy');
      assert.equal(router.getTerminalResourcePolicyCanaryState(target).rollbackState, 'closed');
      assert.deepEqual(router.activateTerminalResourcePolicyLease({ lease }), {
        mode: 'legacy', reason: 'lease-revoked',
      });
    } finally {
      router.destroy();
    }
  }
});

test('REL-BGSTAB-010 disconnect cleanup uses measured registries and bounds retained ledgers', () => {
  const authority = createWsCanaryAuthority();
  const router = createRouter(authority);
  try {
    for (let index = 0; index < 70; index += 1) {
      const clientId = `cleanup-${index}`;
      const target = {
        kind: 'ws' as const, connectionId: `connection-${clientId}`, clientId,
        channel: 'output' as const, reconnectGeneration: 1,
      };
      const socket = createFakeWs();
      subscribeForTest(router, socket.ws, clientId, [`session-${clientId}`]);
      const lease = issueWsCanaryLease(authority, target);
      router.activateTerminalResourcePolicyLease({ lease });
      (router as unknown as { handleDisconnect(ws: typeof socket.ws): void }).handleDisconnect(socket.ws);
    }
    const cleanup = (router as unknown as {
      getTerminalResourcePolicyCanaryCleanupTelemetry(): {
        activeTargetHandles: number;
        retainedLedgerCount: number;
        retainedLedgerCapacity: number;
        prunedLedgerCount: number;
      };
    }).getTerminalResourcePolicyCanaryCleanupTelemetry();
    assert.deepEqual({
      activeTargetHandles: cleanup.activeTargetHandles,
      retainedLedgerCapacity: cleanup.retainedLedgerCapacity,
    }, { activeTargetHandles: 0, retainedLedgerCapacity: 64 });
    assert.ok(cleanup.retainedLedgerCount <= cleanup.retainedLedgerCapacity);
    assert.ok(cleanup.prunedLedgerCount >= 6,
      'disconnect cleanup prunes old closed target ledgers beyond the measured bound');
  } finally {
    router.destroy();
  }
});

test('safe-send preserves same-session lifecycle ordering behind queued output', () => {
  const router = createRouter();
  const { ws, sent, setBufferedAmount } = createFakeWs({ bufferedAmount: 1500 });

  try {
    subscribeForTest(router, ws);
    router.routeSessionOutput('session-1', 'queued-output');
    router.sendSessionEvent('session-1', 'session:exited', { exitCode: 0 });
    assert.equal(sent.length, 0);

    setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);
    (router as unknown as { flushTransportQueue: (socket: typeof ws) => void })
      .flushTransportQueue(ws);

    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'queued-output');
    assert.equal(sent[1].type, 'session:exited');
  } finally {
    router.destroy();
  }
});

test('PERF-BGSTAB-010 atomic authority promotion preserves current identity', async () => {
  const signature = 'PERF-BGSTAB-010 default authority publication must preserve current identity and bind RuntimeConfigStore';
  const fairness = await import('../benchmarks/terminalFairnessCharacterization.js') as {
    createFairSchedulerRuntimePolicyProfile(runtimeConfig: RuntimeConfigStore): FairSchedulerRuntimePolicyProfile;
    publishFairSchedulerAuthorityGeneration(input: {
      authorityRoot: string;
      clients: readonly number[];
      wanLatencyMs: number;
      wanJitterMs: number;
      wanLossPercent: number;
      seed: number;
      repeats: number;
      samples: number;
      beforeCurrentPointerPromotion?: () => Promise<void>;
    }): Promise<{ generationId: string; generationRoot: string }>;
  };
  const authorityRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-atomic-authority-'));
  const currentPointerPath = join(authorityRoot, 'current.json');
  const priorPointerBytes = '{"generation_id":"prior"}\n';
  const runtimePolicyProfile = fairness.createFairSchedulerRuntimePolicyProfile(new RuntimeConfigStore(config));
  const benchmark = {
    authorityRoot,
    clients: [1, 2, 8],
    wanLatencyMs: 150,
    wanJitterMs: 20,
    wanLossPercent: 0,
    seed: 20260723,
    repeats: 5,
    samples: 30,
  } as const;
  try {
    await writeFile(currentPointerPath, priorPointerBytes, 'utf8');
    await assert.rejects(
      fairness.publishFairSchedulerAuthorityGeneration({
        ...benchmark,
        beforeCurrentPointerPromotion: async () => {
          throw new Error('interrupt atomic current promotion');
        },
      }),
      /interrupt atomic current promotion/u,
      signature,
    );
    assert.equal(await readFile(currentPointerPath, 'utf8'), priorPointerBytes, signature);

    const published = await fairness.publishFairSchedulerAuthorityGeneration(benchmark);
    const pointer = JSON.parse(await readFile(currentPointerPath, 'utf8')) as {
      generation_id: string;
      publication_generation: string;
      decision_artifact: string;
    };
    const decision = JSON.parse(await readFile(
      join(published.generationRoot, pointer.decision_artifact),
      'utf8',
    )) as { runtimePolicyProfile: unknown };
    assert.equal(pointer.generation_id, published.generationId, signature);
    assert.equal(pointer.publication_generation, published.generationId, signature);
    assert.deepEqual(decision.runtimePolicyProfile, runtimePolicyProfile, signature);
  } finally {
    await rm(authorityRoot, { recursive: true, force: true });
  }
});

test('REL-BGSTAB-012 rejects stale visibility and latches ordered dataGap', () => {
  const signature = 'REL-BGSTAB-012 AC-1/AC-2: stale visibility must not reopen hidden delivery before its ordered dataGap is latched';
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const internals = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
  };
  const sessionId = 'hidden-visibility-session';
  const issued = {
    sessionId,
    connectionId: 'hidden-visibility-connection',
    viewGeneration: 5,
    visibilityGeneration: '5',
    lastDeliveredSeq: '40',
    streamEpoch: '11',
    checkpointEpoch: '9',
    snapshotSeq: '39',
    oldestRetainedSeq: '12',
    retentionPolicyId: 'retained-scrollback:10000',
    expiresAt: Date.now() + 60_000,
  };
  try {
    router.installTerminalAuthorityHooks({
      queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) } as never,
      onClientFrame: () => false,
      onTopologyChanged: () => undefined,
      readViewAuthorityStreamEpoch: () => issued.streamEpoch,
      readFreshAuthoritativeCheckpoint: () => ({
        continuity: issued,
        fullCheckpoint: {
          streamEpoch: issued.streamEpoch,
          checkpointEpoch: issued.checkpointEpoch,
          snapshotSeq: issued.snapshotSeq,
          oldestRetainedSeq: issued.oldestRetainedSeq,
          retentionPolicyId: issued.retentionPolicyId,
          geometry: { cols: 80, rows: 24 },
          modes: { bracketedPasteMode: true },
          chunks: [{
            sequence: 0,
            chunkIndex: 0,
            chunkCount: 1,
            encoding: 'base64',
            data: 'YQ==',
            encodedBytes: 1,
          }],
          digest: {
            algorithm: 'sha256',
            hex: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
          },
          parserTail: { encoding: 'base64', data: '', encodedBytes: 0 },
          tailOnly: false,
        },
      }),
    });
    internals.clients.set(ws, {
      clientId: 'hidden-visibility-client',
      connectionId: issued.connectionId,
      reconnectGeneration: 5,
      outputChannel: true,
      isAlive: true,
      subscribedSessions: new Set([sessionId]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    internals.sessionSubscribers.set(sessionId, new Set([ws]));

    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '5',
      isVisible: false,
    }));
    router.routeSessionOutput(sessionId, 'unadmitted-visibility-must-not-drop-output');
    assert.equal(
      sent.some(message => (
        message.type === 'terminal-delivery:data-gap' && message.sessionId === sessionId
      )),
      false,
      signature,
    );
    assert.equal(
      sent.some(message => (
        message.type === 'output'
        && message.sessionId === sessionId
        && message.data === 'unadmitted-visibility-must-not-drop-output'
      )),
      true,
      signature,
    );
    sent.length = 0;
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      supportsHiddenDataGapRecovery: true,
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId,
        viewGeneration: issued.viewGeneration,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: issued.visibilityGeneration,
      isVisible: false,
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '4',
      isVisible: true,
    }));
    router.routeSessionOutput(sessionId, 'must-not-bypass-hidden-gap');

    const dataGap = sent.find(message => message.type === 'terminal-delivery:data-gap');
    assert.ok(dataGap, signature);
    assert.equal(dataGap.sessionId, sessionId, signature);
    assert.equal(dataGap.visibilityGeneration, '5', signature);
    assert.equal(
      sent.some(message => (
        message.type === 'output'
        && message.sessionId === 'hidden-visibility-session'
      )),
      false,
      signature,
    );
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-012 latches one ordered dataGap after authoritative hidden delivery', () => {
  const signature = 'REL-BGSTAB-012 AC-1/AC-2: two client interests must retain their own visibility generations, commit model and facts before one ordered dataGap, and reject stale reopening';
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const { ws: peerWs, sent: peerSent } = createFakeWs();
  const internals = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
  };
  const sessionId = 'rel012-authoritative-hidden-session';
  const issued = {
    sessionId,
    connectionId: 'rel012-authoritative-hidden-connection',
    viewGeneration: 5,
    visibilityGeneration: '5',
    lastDeliveredSeq: '40',
    streamEpoch: '11',
    checkpointEpoch: '9',
    snapshotSeq: '39',
    oldestRetainedSeq: '12',
    retentionPolicyId: 'retained-scrollback:10000',
    expiresAt: Date.now() + 60_000,
  };
  try {
    router.installTerminalAuthorityHooks({
      queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) } as never,
      onClientFrame: () => false,
      onTopologyChanged: () => undefined,
      readViewAuthorityStreamEpoch: () => issued.streamEpoch,
      readFreshAuthoritativeCheckpoint: () => ({
        continuity: issued,
        fullCheckpoint: {
          streamEpoch: issued.streamEpoch,
          checkpointEpoch: issued.checkpointEpoch,
          snapshotSeq: issued.snapshotSeq,
          oldestRetainedSeq: issued.oldestRetainedSeq,
          retentionPolicyId: issued.retentionPolicyId,
          geometry: { cols: 80, rows: 24 },
          modes: { bracketedPasteMode: true },
          chunks: [{
            sequence: 0,
            chunkIndex: 0,
            chunkCount: 1,
            encoding: 'base64',
            data: 'YQ==',
            encodedBytes: 1,
          }],
          digest: {
            algorithm: 'sha256',
            hex: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
          },
          parserTail: { encoding: 'base64', data: '', encodedBytes: 0 },
          tailOnly: false,
        },
      }),
    });
    internals.clients.set(ws, {
      clientId: 'rel012-authoritative-hidden-client',
      connectionId: issued.connectionId,
      reconnectGeneration: 5,
      outputChannel: true,
      isAlive: true,
      subscribedSessions: new Set([sessionId]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    internals.clients.set(peerWs, {
      clientId: 'rel012-peer-interest-client',
      connectionId: 'rel012-peer-interest-connection',
      reconnectGeneration: 9,
      outputChannel: true,
      isAlive: true,
      subscribedSessions: new Set([sessionId]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    internals.sessionSubscribers.set(sessionId, new Set([ws, peerWs]));

    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '5',
      isVisible: false,
      deliveryInterestRefCount: 2,
    }));
    router.routeSessionOutput(sessionId, 'unadmitted-visibility-must-not-drop-output');
    assert.equal(
      sent.some(message => (
        message.type === 'terminal-delivery:data-gap' && message.sessionId === sessionId
      )),
      false,
      signature,
    );
    assert.equal(
      sent.some(message => (
        message.type === 'output'
        && message.sessionId === sessionId
        && message.data === 'unadmitted-visibility-must-not-drop-output'
      )),
      true,
      signature,
    );
    sent.length = 0;
    peerSent.length = 0;
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      supportsHiddenDataGapRecovery: true,
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId,
        viewGeneration: issued.viewGeneration,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: issued.visibilityGeneration,
      isVisible: false,
      deliveryInterestRefCount: 2,
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '4',
      isVisible: true,
      deliveryInterestRefCount: 2,
    }));
    router.routeSessionOutput(sessionId, 'authoritative-hidden-tail');

    const dataGaps = sent.filter(message => message.type === 'terminal-delivery:data-gap');
    assert.equal(dataGaps.length, 1, signature);
    const dataGap = dataGaps[0];
    assert.equal(dataGap?.sessionId, sessionId, signature);
    assert.deepEqual({
      visibilityGeneration: dataGap?.visibilityGeneration,
      deliveryInterestRefCount: dataGap?.deliveryInterestRefCount,
      authoritativeModelCommitted: dataGap?.authoritativeModelCommitted,
      terminalFactsCommitted: dataGap?.terminalFactsCommitted,
    }, {
      visibilityGeneration: '5',
      deliveryInterestRefCount: 2,
      authoritativeModelCommitted: true,
      terminalFactsCommitted: true,
    }, signature);
    assert.equal(
      sent.some(message => (
        message.type === 'output'
        && message.sessionId === sessionId
      )),
      false,
      signature,
    );
    assert.equal(
      (dataGap as Record<string, unknown> | undefined)?.authoritativeModelCommitted,
      true,
      signature,
    );
    assert.equal(
      peerSent.some(message => (
        message.type === 'output'
        && message.sessionId === 'rel012-authoritative-hidden-session'
        && message.data === 'authoritative-hidden-tail'
      )),
      true,
      signature,
    );

    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '6',
      isVisible: true,
      deliveryInterestRefCount: 1,
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '5',
      isVisible: false,
      deliveryInterestRefCount: 1,
    }));
    router.routeSessionOutput(sessionId, 'post-committed-gap-output');
    const resumedOutputIndex = sent.findIndex(message => (
      message.type === 'output'
      && message.sessionId === sessionId
      && message.data === 'post-committed-gap-output'
    ));
    assert.ok(resumedOutputIndex > sent.indexOf(dataGap!), signature);
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-012 settles revoked delivery interest exactly once without pausing producer', () => {
  const signature = 'REL-BGSTAB-012 AC-5/AC-7: checkpoint start must settle queued, in-flight, late, and invalidated ledger frames exactly once while releasing only matching post-snapshot output';
  const router = createFairRouter();
  const { ws, sent, flushNextSendCallback } = createFakeWs({ deferSendCallbacks: true });
  const internals = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
    handleDisconnect(socket: typeof ws): void;
  };
  try {
    internals.clients.set(ws, {
      clientId: 'rel012-revoked-interest-client',
      connectionId: 'rel012-revoked-interest-connection',
      reconnectGeneration: 5,
      outputChannel: true,
      isAlive: true,
      subscribedSessions: new Set(['rel012-revoked-interest-session']),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    internals.sessionSubscribers.set('rel012-revoked-interest-session', new Set([ws]));

    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability', protocolVersion: 1, supportsHiddenDataGapRecovery: true,
    }));
    flushNextSendCallback();
    router.routeSessionOutput('rel012-revoked-interest-session', 'queued-before-checkpoint');
    router.routeSessionOutput('rel012-revoked-interest-session', 'inflight-before-checkpoint');
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:checkpoint-start',
      sessionId: 'rel012-revoked-interest-session',
      connectionEpoch: 'rel012-revoked-interest-connection',
      snapshotSeq: 2,
      checkpointEpoch: '1',
    }));
    router.routeSessionOutput('rel012-revoked-interest-session', 'late-before-invalidation');
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:checkpoint-invalidate',
      sessionId: 'rel012-revoked-interest-session',
      connectionEpoch: 'rel012-revoked-interest-connection',
      snapshotSeq: 2,
      checkpointEpoch: '1',
    }));
    flushNextSendCallback();
    flushNextSendCallback();
    router.routeSessionOutput('rel012-revoked-interest-session', 'post-snapshot-matching-output');

    const settlements = sent.filter(message => message.type === 'terminal-delivery:checkpoint-ledger-settled');
    assert.deepEqual(settlements.map(message => ({
      sessionId: message.sessionId,
      checkpointEpoch: message.checkpointEpoch,
      settledThroughSeq: message.settledThroughSeq,
      queued: message.queued,
      inFlight: message.inFlight,
      late: message.late,
      invalidated: message.invalidated,
    })), [{
      sessionId: 'rel012-revoked-interest-session',
      checkpointEpoch: '1',
      settledThroughSeq: 2,
      queued: 1,
      inFlight: 1,
      late: 1,
      invalidated: 1,
    }], signature);
    assert.deepEqual(
      sent.filter(message => message.type === 'output').map(message => message.data),
      ['queued-before-checkpoint', 'post-snapshot-matching-output'],
      signature,
    );
    assert.equal(internals.sessionSubscribers.get('rel012-revoked-interest-session')?.has(ws) ?? false, true, signature);
  } finally {
    router.destroy();
  }
});

test('REL-BGSTAB-012 binds dataGap to issued continuity and current hidden view', () => {
  const signature = 'REL-BGSTAB-012 AC-3: an ordered hidden dataGap is bound to the negotiated current browser view and server-issued continuity, while an identity mismatch emits no marker and requires authoritative recovery';
  const router = createFairRouter();
  const { ws, sent } = createFakeWs();
  const internals = router as unknown as {
    clients: Map<typeof ws, Record<string, unknown>>;
    sessionSubscribers: Map<string, Set<typeof ws>>;
    handleMessage(socket: typeof ws, raw: string): void;
  };
  const sessionId = 'rel012-issued-continuity-session';
  const issued = {
    sessionId,
    connectionId: 'rel012-issued-continuity-connection',
    viewGeneration: 7,
    visibilityGeneration: '5',
    lastDeliveredSeq: '41',
    streamEpoch: '11',
    checkpointEpoch: '9',
    snapshotSeq: '40',
    oldestRetainedSeq: '12',
    retentionPolicyId: 'retained-scrollback:10000',
    expiresAt: Date.now() + 60_000,
  };
  try {
    router.installTerminalAuthorityHooks({
      queryReplyIngress: { handle: () => ({ handled: false, accepted: false }) } as never,
      onClientFrame: () => false,
      onTopologyChanged: () => undefined,
      readViewAuthorityStreamEpoch: () => issued.streamEpoch,
      readFreshAuthoritativeCheckpoint: () => ({
        continuity: issued,
        fullCheckpoint: {
          streamEpoch: issued.streamEpoch,
          checkpointEpoch: issued.checkpointEpoch,
          snapshotSeq: issued.snapshotSeq,
          oldestRetainedSeq: issued.oldestRetainedSeq,
          retentionPolicyId: issued.retentionPolicyId,
          geometry: { cols: 80, rows: 24 },
          modes: { bracketedPasteMode: true },
          chunks: [{
            sequence: 0,
            chunkIndex: 0,
            chunkCount: 1,
            encoding: 'base64',
            data: 'YQ==',
            encodedBytes: 1,
          }],
          digest: {
            algorithm: 'sha256',
            hex: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
          },
          parserTail: { encoding: 'base64', data: '', encodedBytes: 0 },
          tailOnly: false,
        },
      }),
    });
    internals.clients.set(ws, {
      clientId: 'rel012-issued-continuity-client',
      connectionId: issued.connectionId,
      reconnectGeneration: 5,
      outputChannel: true,
      isAlive: true,
      subscribedSessions: new Set([sessionId]),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });
    internals.sessionSubscribers.set(sessionId, new Set([ws]));

    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      supportsHiddenDataGapRecovery: true,
    }));
    assert.deepEqual(sent.at(-1), {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: true,
      connectionEpoch: issued.connectionId,
    }, signature);
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId,
        viewGeneration: issued.viewGeneration,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    const registeredCurrentView = (
      internals.clients.get(ws)?.terminalAuthorityViewRegistrations as Map<string, Record<string, unknown>> | undefined
    )?.get(sessionId);
    assert.deepEqual({
      viewGeneration: registeredCurrentView?.viewGeneration,
      authorityStreamEpoch: registeredCurrentView?.authorityStreamEpoch,
    }, {
      viewGeneration: issued.viewGeneration,
      authorityStreamEpoch: issued.streamEpoch,
    }, signature);
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: issued.visibilityGeneration,
      isVisible: false,
      deliveryInterestRefCount: 1,
    }));
    router.routeSessionOutput(sessionId, 'hidden-output-with-issued-continuity');

    const dataGap = sent.find(message => message.type === 'terminal-delivery:data-gap');
    assert.deepEqual({
      sessionId: dataGap?.sessionId,
      connectionId: dataGap?.connectionId,
      viewGeneration: dataGap?.viewGeneration,
      visibilityGeneration: dataGap?.visibilityGeneration,
      lastDeliveredSeq: dataGap?.lastDeliveredSeq,
      streamEpoch: dataGap?.streamEpoch,
      checkpointEpoch: dataGap?.checkpointEpoch,
      snapshotSeq: dataGap?.snapshotSeq,
      oldestRetainedSeq: dataGap?.oldestRetainedSeq,
      retentionPolicyId: dataGap?.retentionPolicyId,
      continuityAuthority: dataGap?.continuityAuthority,
    }, {
      sessionId,
      connectionId: issued.connectionId,
      viewGeneration: issued.viewGeneration,
      visibilityGeneration: issued.visibilityGeneration,
      lastDeliveredSeq: issued.lastDeliveredSeq,
      streamEpoch: issued.streamEpoch,
      checkpointEpoch: issued.checkpointEpoch,
      snapshotSeq: issued.snapshotSeq,
      oldestRetainedSeq: issued.oldestRetainedSeq,
      retentionPolicyId: issued.retentionPolicyId,
      continuityAuthority: 'server-issued',
    }, signature);

    issued.visibilityGeneration = '6';
    issued.lastDeliveredSeq = '';
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: issued.visibilityGeneration,
      isVisible: false,
      deliveryInterestRefCount: 1,
    }));
    router.routeSessionOutput(sessionId, 'hidden-output-without-server-last-delivered-seq');
    assert.equal(
      sent.filter(message => message.type === 'terminal-delivery:data-gap').length,
      1,
      signature,
    );
    const missingServerSequenceRecovery = sent.at(-1);
    assert.deepEqual({
      type: missingServerSequenceRecovery?.type,
      sessionId: missingServerSequenceRecovery?.sessionId,
      reason: missingServerSequenceRecovery?.reason,
    }, {
      type: 'terminal-checkpoint:fresh-checkpoint-required',
      sessionId,
      reason: 'continuity-identity-mismatch',
    }, signature);

    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [{
        sessionId,
        viewGeneration: issued.viewGeneration + 1,
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
      }],
    }));
    internals.handleMessage(ws, JSON.stringify({
      type: 'terminal-delivery:visibility',
      sessionId,
      visibilityGeneration: '7',
      isVisible: false,
      deliveryInterestRefCount: 1,
    }));
    router.routeSessionOutput(sessionId, 'hidden-output-with-stale-issued-continuity');
    assert.equal(
      sent.filter(message => message.type === 'terminal-delivery:data-gap').length,
      1,
      signature,
    );
    const mismatchRecovery = sent.at(-1);
    assert.deepEqual({
      type: mismatchRecovery?.type,
      sessionId: mismatchRecovery?.sessionId,
      reason: mismatchRecovery?.reason,
      checkpointAuthority: mismatchRecovery?.checkpointAuthority,
      fullCheckpointRetentionPolicyId: (
        mismatchRecovery?.fullCheckpoint as Record<string, unknown> | undefined
      )?.retentionPolicyId,
    }, {
      type: 'terminal-checkpoint:fresh-checkpoint-required',
      sessionId,
      reason: 'continuity-identity-mismatch',
      checkpointAuthority: 'server-full-retained-state',
      fullCheckpointRetentionPolicyId: issued.retentionPolicyId,
    }, signature);
  } finally {
    router.destroy();
  }
});
