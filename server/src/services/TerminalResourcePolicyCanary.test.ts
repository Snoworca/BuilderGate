import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, unwatchFile, watchFile, writeFileSync,
} from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { resourceLimitsSchema } from '../schemas/config.schema.js';
import type { Config } from '../types/config.types.js';
import { WsRouter } from '../ws/WsRouter.js';
import {
  createWsTransportMessage,
  getTransportMessagesInPriorityOrder,
  tryCoalesceOutputMessage,
  type WsTransportMessage,
  type WsTransportMessageMetadata,
  type WsTransportQueueState,
} from '../ws/wsSendPolicy.js';
import type { AuthService } from './AuthService.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';
import { SessionManager } from './SessionManager.js';
import { getRegisteredTerminalResourcePolicyProfiles } from './TerminalResourcePolicy.js';
import { createHeadlessOutputQueue } from '../utils/headlessOutputQueue.js';
import { jsonWirePayloadText, wirePayloadByteLength } from '../ws/wirePayload.js';

// @req REL-BGSTAB-010
const CANARY_MODULE_PATH: string = './TerminalResourcePolicyCanary.js';
const MODULE_PRESENT = existsSync(new URL('./TerminalResourcePolicyCanary.ts', import.meta.url));
const OBS_MANIFEST_SHA256 = '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57';
const WS_RESOURCE = 'resourceLimits.ws.perClientOutputQueueMaxBytes' as const;
const HEADLESS_RESOURCE = 'resourceLimits.headless.pendingOutputMaxBytes' as const;
const WS_CONSUMER = 'server.ws.router' as const;
const HEADLESS_CONSUMER = 'server.pty.headless-model' as const;
const REQUIRED_CAPABILITY_VERSION = 7;
declare const POLICY_LEASE_BRAND: unique symbol;

interface WsTarget {
  kind: 'ws';
  connectionId: string;
  clientId: string;
  channel: 'output';
  reconnectGeneration: number;
}

interface HeadlessTarget {
  kind: 'headless';
  sessionId: string;
}

interface TrustedProfile {
  contractId: string;
  policyId: string;
  profileVersion: string;
  schemaVersion: string;
  stability: 'draft' | 'evolving' | 'stable';
  requiredCapabilities: Partial<Record<typeof WS_CONSUMER | typeof HEADLESS_CONSUMER, number>>;
  resources: Partial<Record<typeof WS_RESOURCE | typeof HEADLESS_RESOURCE, number>>;
}

interface PolicyLease {
  readonly [POLICY_LEASE_BRAND]: true;
  readonly leaseId: string;
  readonly policyId: string;
  readonly profileVersion: string;
  readonly schemaVersion: 'terminal-resource-policy/v1';
  readonly resource: typeof WS_RESOURCE | typeof HEADLESS_RESOURCE;
  readonly consumer: typeof WS_CONSUMER | typeof HEADLESS_CONSUMER;
  readonly target: WsTarget | HeadlessTarget;
}

interface LeaseDecision {
  mode: 'candidate' | 'legacy';
  reason: string;
  lease?: PolicyLease;
}

interface PolicyLeaseMetadata {
  readonly issuanceSequence: number;
  readonly targetEpoch: number;
}

interface PolicyLeaseAuthority {
  issue(input: {
    contractId: string;
    target: WsTarget | HeadlessTarget;
    selectedTarget: WsTarget | HeadlessTarget;
    resource: typeof WS_RESOURCE | typeof HEADLESS_RESOURCE;
    consumer: typeof WS_CONSUMER | typeof HEADLESS_CONSUMER;
    capability?: { version: number; compilerSchemaVersion: string };
  }): LeaseDecision;
  validate(value: unknown): value is PolicyLease;
  getLeaseMetadata(value: unknown): PolicyLeaseMetadata | undefined;
  revokeTarget(target: WsTarget | HeadlessTarget): number;
}

interface AdmissionPreview {
  accepted: boolean;
  mode: 'candidate' | 'legacy';
  reason: string;
  resource: typeof WS_RESOURCE;
  consumer: typeof WS_CONSUMER;
  target: WsTarget;
  queueOwner: 'ws-router';
  queuedSessionIds: string[];
  queuedBytes: number;
  computedIncomingBytes: number;
  projectedBytes: number;
  policyGeneration: number;
}

interface AdmissionResult extends AdmissionPreview {
  entryToken?: string;
  enqueuedExactlyOnce: boolean;
}

interface LedgerSnapshot {
  denied?: boolean;
  reason?: string;
  capacity: number;
  totalEvents: number;
  droppedEntries: number;
  entries: Array<{
    sequence: number;
    event: string;
    resource: typeof WS_RESOURCE | typeof HEADLESS_RESOURCE;
    consumer: typeof WS_CONSUMER | typeof HEADLESS_CONSUMER;
    target: WsTarget | HeadlessTarget;
    policyGeneration: number;
    policyId: string;
    profileVersion: string;
    previousEffectiveDecision: number;
    nextEffectiveDecision: number;
    accepted: boolean;
    reason: string;
    rollbackResult: string | null;
  }>;
}

interface RuntimeCanaryApi {
  issueTerminalResourcePolicyLease(input: {
    contractId: string;
    target: WsTarget | HeadlessTarget;
    resource: typeof WS_RESOURCE | typeof HEADLESS_RESOURCE;
    consumer: typeof WS_CONSUMER | typeof HEADLESS_CONSUMER;
    capability?: { version: number; compilerSchemaVersion: string };
    selectedTarget: WsTarget | HeadlessTarget;
  }): LeaseDecision;
  previewTerminalResourcePolicyCanaryAdmission(input: {
    wsRouter: WsRouter;
    lease: PolicyLease;
    incomingMessage: WsTransportMessage;
  }): AdmissionPreview;
  admitTerminalResourcePolicyCanaryMessage(input: {
    wsRouter: WsRouter;
    lease: PolicyLease;
    incomingMessage: WsTransportMessage;
  }): AdmissionResult;
  applyTerminalResourcePolicyLease(input: { wsRouter: WsRouter; sessionManager: SessionManager; lease: PolicyLease }): {
    mode: 'candidate' | 'legacy';
    reason: string;
    previousEffectiveDecision: number;
    nextEffectiveDecision: number;
  };
  rollbackTerminalResourcePolicyLease(input: { wsRouter: WsRouter; sessionManager: SessionManager; lease: PolicyLease }): {
    state: 'draining' | 'closed';
    reason: string;
  };
  applyTerminalResourcePolicyLeaseBatch(input: {
    wsRouter: WsRouter;
    sessionManager: SessionManager;
    leases: readonly PolicyLease[];
  }): {
    mode: 'candidate' | 'legacy';
    reason: string;
    appliedConsumers: string[];
    rolledBackConsumers: string[];
  };
  getTerminalResourcePolicyCanaryLedger(input: {
    wsRouter: WsRouter;
    lease: PolicyLease;
  }): LedgerSnapshot;
  applyTerminalResourcePolicyCanaryTarget(input: {
    wsRouter: WsRouter;
    sessionManager: SessionManager;
    lease: PolicyLease;
  }): {
    ws: { mode: 'candidate' | 'legacy'; reason: string; target: WsTarget; resource: typeof WS_RESOURCE; adapterCalls: number };
    headless: { mode: 'candidate' | 'legacy'; reason: string; target: HeadlessTarget; resource: typeof HEADLESS_RESOURCE; adapterCalls: number };
    producerMutationCount: number;
    authorityMutationCount: number;
  };
  previewHeadlessTerminalResourcePolicyAdmission(input: {
    sessionManager: SessionManager;
    lease: PolicyLease;
    rawData: string;
  }): {
    resource: typeof HEADLESS_RESOURCE;
    consumer: typeof HEADLESS_CONSUMER;
    target: HeadlessTarget;
    rawUtf8Bytes: number;
  };
  admitHeadlessTerminalResourcePolicyData(input: { sessionManager: SessionManager; lease: PolicyLease; rawData: string }): {
    accepted: boolean; mode: 'candidate' | 'legacy'; reason: string; enqueuedExactlyOnce: boolean; policyGeneration: number;
  };
}

interface CanaryModule {
  createTerminalResourcePolicyLeaseIssuer(options: {
    trustedEvidence?: { requirementId: string; status: string; manifestSha256: string };
    contracts?: readonly TrustedProfile[];
  }): PolicyLeaseAuthority;
}

const TARGET_A: WsTarget = {
  kind: 'ws', connectionId: 'connection-a', clientId: 'client-a', channel: 'output', reconnectGeneration: 1,
};
const TARGET_B: WsTarget = {
  kind: 'ws', connectionId: 'connection-b', clientId: 'client-b', channel: 'output', reconnectGeneration: 1,
};
const HEADLESS_A: HeadlessTarget = { kind: 'headless', sessionId: 'session-a1' };

function signature(ac: 1 | 2 | 3 | 4 | 5 | 6): string {
  return `REL-BGSTAB-010 AC-${ac} Non-loss policy canary infrastructure 계약 부재 때문에 실패`;
}

function profile(resources: TrustedProfile['resources'], suffix = ''): TrustedProfile {
  const resourceKey = Object.entries(resources)
    .map(([key, value]) => `${key}:${String(value)}`)
    .sort()
    .join('|');
  return {
    contractId: `TEST-ONLY-WAVE3-STABLE-CONTRACT:${resourceKey}${suffix}`,
    policyId: 'test-only-wave3-reviewed',
    profileVersion: '1.0.0',
    schemaVersion: 'terminal-resource-policy/v1',
    stability: 'stable',
    requiredCapabilities: {
      ...(WS_RESOURCE in resources ? { [WS_CONSUMER]: REQUIRED_CAPABILITY_VERSION } : {}),
      ...(HEADLESS_RESOURCE in resources ? { [HEADLESS_CONSUMER]: REQUIRED_CAPABILITY_VERSION } : {}),
    },
    resources,
  };
}

function configFixture(): Config {
  return {
    server: { port: 4242 },
    pty: {
      termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: false,
      scrollbackLines: 1_000, maxSnapshotBytes: 65_536, shell: 'auto',
    },
    session: { idleDelayMs: 200 },
    resourceLimits: resourceLimitsSchema.parse(undefined),
    stabilityModes: {
      headlessQueueMode: 'observe', wsSendMode: 'safe-send-enforce', frontendRuntimeResidency: 'bounded',
    },
  };
}

function createFakeWs(options: { bufferedAmount?: number; deferCallbacks?: boolean } = {}) {
  let bufferedAmount = options.bufferedAmount ?? 1_500;
  const sent: Array<Record<string, unknown>> = [];
  const callbacks: Array<() => void> = [];
  let closeCode: number | undefined;
  const ws = {
    readyState: 1,
    get bufferedAmount() { return bufferedAmount; },
    send(payload: string, callback?: () => void) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      if (options.deferCallbacks && callback) callbacks.push(callback);
      else callback?.();
    },
    ping() {},
    close(code?: number) { closeCode = code; (this as { readyState: number }).readyState = 3; },
    terminate() { (this as { readyState: number }).readyState = 3; },
    on() { return this; },
  } as unknown as import('ws').WebSocket;
  return {
    ws, sent,
    setBufferedAmount(value: number) { bufferedAmount = value; },
    flushNextCallback() { callbacks.shift()?.(); },
    getCloseCode() { return closeCode; },
  };
}

function createHarness(
  authority?: PolicyLeaseAuthority,
  overrides: {
    managerAuthority?: PolicyLeaseAuthority;
    routerAuthority?: PolicyLeaseAuthority;
    storeAuthority?: PolicyLeaseAuthority;
    headlessOutputMaxBytes?: number;
    spawnPty?: (...args: unknown[]) => unknown;
  } = {},
) {
  const config = configFixture();
  if (overrides.headlessOutputMaxBytes !== undefined) {
    config.resourceLimits!.headless.pendingOutputMaxBytes = overrides.headlessOutputMaxBytes;
  }
  const managerAuthority = 'managerAuthority' in overrides ? overrides.managerAuthority : authority;
  const routerAuthority = 'routerAuthority' in overrides ? overrides.routerAuthority : authority;
  const storeAuthority = 'storeAuthority' in overrides ? overrides.storeAuthority : authority;
  const manager = new SessionManager({
    pty: config.pty, session: config.session, resourceLimits: config.resourceLimits, stabilityModes: config.stabilityModes,
  }, {
    platform: 'linux',
    terminalResourcePolicyAuthority: managerAuthority,
    ...(overrides.spawnPty ? { spawnPty: overrides.spawnPty } : {}),
  } as ConstructorParameters<typeof SessionManager>[1] & {
    terminalResourcePolicyAuthority?: PolicyLeaseAuthority;
  });
  const auth = { verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }) } as unknown as AuthService;
  const router = new WsRouter(auth, manager, {
    resourceLimits: {
      ws: {
        ...config.resourceLimits!.ws,
        serverBufferedHighWaterBytes: 1024,
        serverBufferedHardLimitBytes: 2048,
        perClientOutputQueueMaxBytes: 4096,
        perClientControlQueueMaxBytes: 1024,
        outputCoalesceWindowMs: 1,
      },
    },
    stabilityModes: config.stabilityModes,
    terminalResourcePolicyAuthority: routerAuthority,
  } as ConstructorParameters<typeof WsRouter>[2] & {
    terminalResourcePolicyAuthority?: PolicyLeaseAuthority;
  });
  const store = new RuntimeConfigStore(config, 'linux', {
    terminalResourcePolicy: {
      observation: 'observe',
      authority: storeAuthority,
    },
  } as ConstructorParameters<typeof RuntimeConfigStore>[2] & {
    terminalResourcePolicy: {
      observation: 'observe';
      authority?: PolicyLeaseAuthority;
    };
  });
  return { config, manager, router, store };
}

function subscribe(
  router: WsRouter,
  ws: import('ws').WebSocket,
  clientId: string,
  sessionIds: readonly string[],
): void {
  (router as unknown as { clients: Map<typeof ws, unknown> }).clients.set(ws, {
    clientId,
    connectionId: clientId === TARGET_A.clientId ? TARGET_A.connectionId : TARGET_B.connectionId,
    reconnectGeneration: 1,
    outputChannel: true,
    isAlive: true, subscribedSessions: new Set(sessionIds), replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });
  const subscribers = (router as unknown as { sessionSubscribers: Map<string, Set<typeof ws>> }).sessionSubscribers;
  for (const sessionId of sessionIds) {
    const current = subscribers.get(sessionId) ?? new Set<typeof ws>();
    current.add(ws);
    subscribers.set(sessionId, current);
  }
}

function seedAc2Queues(
  router: WsRouter,
  a: ReturnType<typeof createFakeWs>,
  b: ReturnType<typeof createFakeWs>,
): void {
  subscribe(router, a.ws, TARGET_A.clientId, ['session-a1', 'session-a2']);
  subscribe(router, b.ws, TARGET_B.clientId, ['session-b1']);
  for (const [sessionId, data] of [
    ['session-a1', 'quote:" slash:\\ newline:\n'],
    ['session-a2', '한글'],
    ['session-a1', 'emoji:😀'],
  ] as const) router.routeSessionOutput(sessionId, data);
  router.routeSessionOutput('session-b1', 'isolated-client-b');
}

function queuedMessages(router: WsRouter, ws: import('ws').WebSocket): WsTransportMessage[] {
  const state = (router as unknown as { transportQueues: Map<typeof ws, WsTransportQueueState> }).transportQueues.get(ws);
  return state ? getTransportMessagesInPriorityOrder(state) : [];
}

type InternalTransportMessage = WsTransportMessage & {
  policyGeneration?: number;
  expiresAt?: number;
  ready?: boolean;
  recoveryGeneration?: number;
  source?: string;
  exactlyOnceKey?: string;
};

function createInternalMessage(
  message: object,
  now: number,
  metadata: {
    policyGeneration: number;
    expiresAt: number;
    ready: boolean;
    recoveryGeneration: number;
    source: string;
    exactlyOnceKey: string;
  },
): InternalTransportMessage {
  const factory = createWsTransportMessage as unknown as (
    body: object,
    queuedAt: number,
    options: typeof metadata,
  ) => InternalTransportMessage;
  return factory(message, now, metadata);
}

interface ActualHeadlessSeed {
  rawData: string;
  queuedAt: number;
  expiresAt: number;
  ready: boolean;
  recoveryGeneration: number;
  exactlyOnceKey: string;
  policyGeneration?: number;
}

interface ActualHeadlessPendingEntry extends ActualHeadlessSeed {
  id: number;
  data: string;
  byteLength: number;
  queued: true;
}

interface ActualHeadlessSessionState {
  session: { id: string; status: 'idle' };
  pty: { writes: number; pauses: number; kills: number; write(): void; pause(): void; kill(): void };
  headless: { terminal: unknown } | null;
  headlessHealth: 'healthy';
  headlessOutputQueue: ReturnType<typeof createHeadlessOutputQueue>;
  headlessOutputMaxBytes: number;
  headlessOutputMaxChunks: number;
  headlessQueueMode: 'observe';
  pendingHeadlessOutputs: Map<number, ActualHeadlessPendingEntry>;
  pendingHeadlessOutputBytes: number;
  pendingHeadlessOutputBytesByPolicyGeneration: Map<number, number>;
  pendingHeadlessOutputChunksByPolicyGeneration: Map<number, number>;
  pendingHeadlessLegacyOutputBytesByPolicyGeneration: Map<number, number>;
  pendingHeadlessLegacyOutputChunksByPolicyGeneration: Map<number, number>;
  pendingHeadlessWritesByPolicyGeneration: Map<number, number>;
  headlessPolicyWriteFailureSettlers: Map<number, (reason: 'headless-write-failed') => void>;
  maxPendingHeadlessOutputBytes: number;
  maxPendingHeadlessOutputChunks: number;
  nextHeadlessOutputId: number;
  pendingHeadlessWrites: number;
  headlessWriteChain: Promise<void>;
  screenSeq: number;
  authorityRevision: number;
  snapshotCache: null;
  unsnapshottedOutput: string;
  unsnapshottedOutputTruncated: false;
  finalized: boolean;
  idleTimer: null;
  identityCaptureTimer: null;
  startupReadyTimer: null;
  runningTimer: null;
  pendingRestoreInputs: unknown[];
  cleanupRecorded: boolean;
  processMetadata: { rootPid: null };
  oscDetector: { destroy(): void };
  terminalTitleDetector: { destroy(): void };
  terminalTitleSignalDetector: { destroy(): void };
  foregroundDetectorRegistry: { reset(): void };
  headlessCloseSignal: { promise: Promise<void>; resolve(): void };
  cwdFilePath: null;
  parserTailOverflow: boolean;
  parserComplete: boolean;
  pendingEscapeTailAnsi: string;
  degradedReplayBuffer: string;
  degradedReplayTruncated: boolean;
  headlessDegradedPhase?: string;
}

function observeActualHeadlessSessionCreation(manager: SessionManager) {
  const sessions = (manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
  }).sessions;
  const observedStates = new Map<string, ActualHeadlessSessionState | undefined>();
  const originalCreateSession = manager.createSession.bind(manager);
  (manager as unknown as {
    createSession: SessionManager['createSession'];
  }).createSession = (...args) => {
    const createdSession = originalCreateSession(...args);
    observedStates.set(createdSession.id, sessions.get(createdSession.id));
    return createdSession;
  };

  return {
    get createCount() { return observedStates.size; },
    assertFixtureState(sessionId: string, fixtureState: ActualHeadlessSessionState): void {
      assert.equal(observedStates.has(sessionId), true,
        `fixture ${sessionId} must be created through public manager.createSession`);
      assert.equal(observedStates.get(sessionId), fixtureState,
        `fixture ${sessionId} must be the exact SessionManager state observed after public creation`);
    },
  };
}

function createDeterministicHeadlessPtySpawner(firstPid = 501) {
  let nextPid = firstPid;
  let spawnCount = 0;
  let onDataRegistrationCount = 0;
  return {
    get spawnCount() { return spawnCount; },
    get onDataRegistrationCount() { return onDataRegistrationCount; },
    spawnPty: () => {
      spawnCount += 1;
      return {
        pid: nextPid++,
        cols: 80,
        rows: 24,
        process: 'bash',
        handleFlowControl: false,
        writes: 0,
        pauses: 0,
        kills: 0,
        onData() {
          onDataRegistrationCount += 1;
          return { dispose() {} };
        },
        onExit() { return { dispose() {} }; },
        write() { this.writes += 1; },
        pause() { this.pauses += 1; },
        resize() {},
        kill() { this.kills += 1; },
      };
    },
  };
}

function initializeActualHeadlessSession(
  manager: SessionManager,
  target: HeadlessTarget,
  entries: readonly ActualHeadlessSeed[],
): ActualHeadlessSessionState {
  (manager as unknown as { isCommandAvailable(command: string): boolean })
    .isCommandAvailable = () => true;
  manager.createSession(target.sessionId, 'bash', process.cwd(), { sessionId: target.sessionId });
  const state = (manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
  }).sessions.get(target.sessionId);
  assert.ok(state, 'real createSession fixture must create the requested session');
  assert.equal(state.pendingHeadlessOutputs.size, 0,
    'real createSession fixture must start with no pending headless output');
  assert.equal(state.headlessOutputQueue.snapshot().pendingChunks, 0,
    'real createSession fixture must start with an empty headless queue');

  for (const entry of entries) {
    const id = state.nextHeadlessOutputId;
    const byteLength = Buffer.byteLength(entry.rawData, 'utf8');
    assert.equal(state.headlessOutputQueue.enqueue(entry.rawData).ok, true,
      'fixture seed must fit the actual session queue limits');
    const policyGeneration = entry.policyGeneration ?? 0;
    state.pendingHeadlessOutputs.set(id, {
      ...entry,
      id,
      data: entry.rawData,
      byteLength,
      queued: true,
      policyGeneration,
    });
    state.nextHeadlessOutputId += 1;
    state.pendingHeadlessOutputBytes += byteLength;
    state.pendingHeadlessOutputBytesByPolicyGeneration.set(
      policyGeneration,
      (state.pendingHeadlessOutputBytesByPolicyGeneration.get(policyGeneration) ?? 0) + byteLength,
    );
    state.pendingHeadlessOutputChunksByPolicyGeneration.set(
      policyGeneration,
      (state.pendingHeadlessOutputChunksByPolicyGeneration.get(policyGeneration) ?? 0) + 1,
    );
  }
  state.maxPendingHeadlessOutputBytes = Math.max(
    state.maxPendingHeadlessOutputBytes,
    state.pendingHeadlessOutputBytes,
  );
  state.maxPendingHeadlessOutputChunks = Math.max(
    state.maxPendingHeadlessOutputChunks,
    state.pendingHeadlessOutputs.size,
  );
  return state;
}

function readActualHeadlessEntries(
  manager: SessionManager,
  target: HeadlessTarget,
): ActualHeadlessPendingEntry[] {
  const state = (manager as unknown as { sessions: Map<string, ActualHeadlessSessionState> })
    .sessions.get(target.sessionId);
  assert.ok(state, `actual SessionManager session ${target.sessionId} must exist`);
  return [...state.pendingHeadlessOutputs.values()].map(entry => structuredClone(entry));
}

test('PERF-BGSTAB-010 fixture contract — real SessionManager initialization retains authority and cleanup state', () => {
  const { manager, router } = createHarness(undefined, {
    spawnPty: () => ({
      pid: 121,
      cols: 80,
      rows: 24,
      process: 'bash',
      handleFlowControl: false,
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      resize() {},
      kill() {},
    }),
  });
  try {
    const state = initializeActualHeadlessSession(manager, HEADLESS_A, [{
      rawData: 'fixture-seed', queuedAt: 1, expiresAt: 10_000, ready: true,
      recoveryGeneration: 0, exactlyOnceKey: 'fixture-seed', policyGeneration: 0,
    }]);
    assert.equal(typeof (state as unknown as { nextTerminalAuthoritySourceSeq: unknown })
      .nextTerminalAuthoritySourceSeq, 'bigint');
    assert.equal((state as unknown as {
      retainedTerminal: { comparisonTimer: unknown };
    }).retainedTerminal.comparisonTimer, null);
    assert.equal(state.pendingHeadlessOutputs.size, 1);
    assert.equal(state.headlessOutputQueue.snapshot().pendingChunks, 1);
  } finally {
    manager.deleteSession(HEADLESS_A.sessionId);
    router.destroy();
  }
});

function assertCompleteHeadlessAuthorityFixture(
  state: ActualHeadlessSessionState,
  fixtureName: string,
): void {
  const sessionState = state as unknown as {
    headless?: { terminal?: unknown } | null;
    nextTerminalAuthoritySourceSeq?: unknown;
    retainedTerminal?: {
      streamEpoch?: unknown;
      sourceSeq?: unknown;
      snapshotSeq?: unknown;
      comparisonTimer?: unknown;
      clients?: unknown;
      authorityRuntime?: {
        serverRecoveryAcks?: unknown;
        responder?: { revokedLeaseIds?: unknown };
      };
    };
  };
  const retained = sessionState.retainedTerminal;
  const authorityOrdinal = sessionState.nextTerminalAuthoritySourceSeq;
  const retainedSourceSeq = retained?.sourceSeq;
  const authorityOrdinalMatchesSourceSeq = typeof authorityOrdinal === 'bigint'
    && typeof retainedSourceSeq === 'string'
    && /^\d+$/u.test(retainedSourceSeq)
    && authorityOrdinal === BigInt(retainedSourceSeq);

  assert.deepEqual({
    headlessModelInitialized: sessionState.headless !== null
      && typeof sessionState.headless?.terminal === 'object'
      && sessionState.headless.terminal !== null,
    authorityOrdinalType: typeof authorityOrdinal,
    authorityOrdinalMatchesSourceSeq,
    retainedTerminal: {
      streamEpochType: typeof retained?.streamEpoch,
      sourceSeqType: typeof retained?.sourceSeq,
      snapshotSeqType: typeof retained?.snapshotSeq,
      snapshotMatchesSourceSeq: typeof retained?.snapshotSeq === 'string'
        && retained.snapshotSeq === retainedSourceSeq,
      comparisonTimer: retained?.comparisonTimer,
      clientsInitialized: retained?.clients instanceof Map,
      recoveryAckLedgerInitialized: retained?.authorityRuntime?.serverRecoveryAcks instanceof Map,
      revokedLeaseSetInitialized: retained?.authorityRuntime?.responder?.revokedLeaseIds instanceof Set,
    },
  }, {
    headlessModelInitialized: true,
    authorityOrdinalType: 'bigint',
    authorityOrdinalMatchesSourceSeq: true,
    retainedTerminal: {
      streamEpochType: 'string',
      sourceSeqType: 'string',
      snapshotSeqType: 'string',
      snapshotMatchesSourceSeq: true,
      comparisonTimer: null,
      clientsInitialized: true,
      recoveryAckLedgerInitialized: true,
      revokedLeaseSetInitialized: true,
    },
  }, `${fixtureName} must retain the SessionManager authority ordinal and complete retained state`);
}

function enableGatedHeadlessWrites(state: ActualHeadlessSessionState) {
  const callbacks: Array<() => void> = [];
  let disposed = false;
  const headless = (state as unknown as {
    headless: {
      terminal: {
        write(data: string, callback: () => void): void;
      };
    };
  }).headless;
  const terminal = headless.terminal;
  const originalWrite = terminal.write;
  const writeOriginal = (data: string, callback: () => void): void => {
    originalWrite.call(terminal, data, callback);
  };
  const gatedWrite = (data: string, callback: () => void): void => {
    if (disposed) {
      writeOriginal(data, callback);
      return;
    }
    callbacks.push(() => { writeOriginal(data, callback); });
  };
  terminal.write = gatedWrite;

  const releaseNext = () => {
    const callback = callbacks.shift();
    if (!callback) return false;
    callback();
    return true;
  };

  return {
    get pendingCallbacks() { return callbacks.length; },
    get disposed() { return disposed; },
    releaseNext,
    dispose() {
      if (disposed) return;
      disposed = true;
      while (releaseNext()) {
        // Every queued write is forwarded exactly once before the original method is restored.
      }
      terminal.write = originalWrite;
    },
  };
}

type GatedHeadlessWrites = ReturnType<typeof enableGatedHeadlessWrites> & {
  dispose(): void;
};

interface FixtureResourceLedger {
  markEmergencyFallbackUsed(): void;
  assertReleased(): void;
}

interface FixtureCwdWatchProbe {
  readonly disposed: boolean;
  assertObserved(): Promise<void>;
  assertUnregistered(): Promise<void>;
  dispose(): void;
}

interface GatedRealSessionFixture {
  manager: SessionManager;
  router: WsRouter;
  state: ActualHeadlessSessionState;
  sessionId: string;
  cwdFilePath: string;
  originalHeadless: { terminal: { dispose(): void } };
  gatedWrites: GatedHeadlessWrites;
  ledger: FixtureResourceLedger;
  cwdWatchProbe: FixtureCwdWatchProbe;
  emitPtyData(data: string): void;
}

function createFixtureResourceLedger(input: {
  manager: SessionManager;
  sessionId: string;
  cwdFilePath: string;
  gatedWrites: GatedHeadlessWrites;
}): FixtureResourceLedger {
  let emergencyFallbackUsed = false;
  return {
    markEmergencyFallbackUsed() {
      emergencyFallbackUsed = true;
    },
    assertReleased() {
      const sessions = (input.manager as unknown as {
        sessions: Map<string, ActualHeadlessSessionState>;
      }).sessions;
      assert.equal(sessions.has(input.sessionId), false, 'fixture session must be removed');
      assert.equal(existsSync(input.cwdFilePath), false, 'fixture CWD file must be removed');
      assert.equal(input.gatedWrites.pendingCallbacks, 0, 'held headless writes must be released');
      assert.equal(emergencyFallbackUsed, false, 'normal cleanup must not use the emergency fallback');
    },
  };
}

async function waitForFixtureCondition(
  condition: () => boolean,
  failureMessage: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(condition(), failureMessage);
}

function createFixtureCwdWatchProbe(cwdFilePath: string): FixtureCwdWatchProbe {
  let calls = 0;
  let disposed = false;
  const witness = () => { calls += 1; };
  watchFile(cwdFilePath, { interval: 1000 }, witness);
  return {
    get disposed() {
      return disposed;
    },
    async assertObserved() {
      const baseline = calls;
      writeFileSync(cwdFilePath, 'PERF-BGSTAB-010 watcher probe before cleanup\n', 'utf8');
      await waitForFixtureCondition(
        () => calls > baseline,
        'same-path watcher probe must observe a fixture CWD file update before cleanup',
        1250,
      );
    },
    async assertUnregistered() {
      const baseline = calls;
      writeFileSync(cwdFilePath, 'PERF-BGSTAB-010 watcher probe after cleanup\n', 'utf8');
      await new Promise<void>((resolve) => setTimeout(resolve, 1250));
      assert.equal(calls, baseline,
        'public finalization must unregister every watcher for the fixture CWD path');
    },
    dispose() {
      if (disposed) return;
      unwatchFile(cwdFilePath, witness);
      disposed = true;
    },
  };
}

async function assertHeadlessWriteChainSettles(
  input: {
    state: ActualHeadlessSessionState;
    gatedWrites: GatedHeadlessWrites;
    phase: string;
  },
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      input.state.headlessWriteChain,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `${input.phase} timed out: pendingCallbacks=${input.gatedWrites.pendingCallbacks}, `
            + `pendingHeadlessWrites=${input.state.pendingHeadlessWrites}, `
            + `pendingHeadlessOutputs=${input.state.pendingHeadlessOutputs.size}`,
          ));
        }, 1500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drainGatedHeadlessWrites(
  input: {
    state: ActualHeadlessSessionState;
    gatedWrites: GatedHeadlessWrites;
    phase: string;
  },
): Promise<void> {
  const deadline = Date.now() + 1500;
  while (true) {
    const pendingCallbacks = input.gatedWrites.pendingCallbacks;
    const pendingHeadlessWrites = input.state.pendingHeadlessWrites;
    const pendingHeadlessOutputs = input.state.pendingHeadlessOutputs.size;
    if (pendingCallbacks === 0 && pendingHeadlessWrites === 0 && pendingHeadlessOutputs === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${input.phase} timed out: pendingCallbacks=${pendingCallbacks}, `
        + `pendingHeadlessWrites=${pendingHeadlessWrites}, `
        + `pendingHeadlessOutputs=${pendingHeadlessOutputs}`,
      );
    }
    input.gatedWrites.releaseNext();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function prepareFixtureCwdFile(state: ActualHeadlessSessionState): string {
  const cwdFilePath = (state as unknown as { cwdFilePath: string | null }).cwdFilePath;
  if (typeof cwdFilePath !== 'string') {
    assert.fail('real createSession fixture must provide a CWD file path');
  }
  writeFileSync(cwdFilePath, 'PERF-BGSTAB-010 fixture-owned CWD state\n', 'utf8');
  assert.equal(existsSync(cwdFilePath), true, 'fixture-owned CWD file must exist before cleanup');
  return cwdFilePath;
}

function createGatedRealSessionFixture(
  sessionId: string,
  pid: number,
  headlessOutputMaxBytes?: number,
): GatedRealSessionFixture {
  const handlers: Array<(data: string) => void> = [];
  const { manager, router } = createHarness(undefined, {
    ...(headlessOutputMaxBytes === undefined ? {} : { headlessOutputMaxBytes }),
    spawnPty: () => ({
      pid,
      cols: 80,
      rows: 24,
      process: 'bash',
      handleFlowControl: false,
      onData(callback: (data: string) => void) {
        handlers.push(callback);
        return { dispose() {} };
      },
      onExit() { return { dispose() {} }; },
      write() {},
      resize() {},
      kill() {},
    }),
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean })
    .isCommandAvailable = () => true;
  manager.createSession(sessionId, 'bash', process.cwd(), { sessionId });
  assert.equal(handlers.length, 1, 'real createSession must register the fixture PTY data handler');
  const state = (manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
  }).sessions.get(sessionId);
  assert.ok(state, 'real createSession fixture must create the requested session');
  const originalHeadless = (state as unknown as {
    headless: { terminal: { dispose(): void } };
  }).headless;
  assert.ok(originalHeadless, 'real createSession fixture must retain a full headless terminal state');
  const cwdFilePath = prepareFixtureCwdFile(state);
  const gatedWrites = enableGatedHeadlessWrites(state) as GatedHeadlessWrites;
  const ledger = createFixtureResourceLedger({ manager, sessionId, cwdFilePath, gatedWrites });
  const cwdWatchProbe = createFixtureCwdWatchProbe(cwdFilePath);
  return {
    manager,
    router,
    state,
    sessionId,
    cwdFilePath,
    originalHeadless,
    gatedWrites,
    ledger,
    cwdWatchProbe,
    emitPtyData(data: string) {
      handlers[0]!(data);
    },
  };
}

async function disposeFixture(fixture: GatedRealSessionFixture): Promise<void> {
  fixture.gatedWrites.dispose();
  await assertHeadlessWriteChainSettles({
    state: fixture.state,
    gatedWrites: fixture.gatedWrites,
    phase: 'fixture public cleanup write chain',
  });
  assert.equal(fixture.state.pendingHeadlessWrites, 0,
    'all real PTY headless writes must settle before public finalization');
  assert.equal(fixture.state.pendingHeadlessOutputs.size, 0,
    'all real PTY pending headless outputs must settle before public finalization');
  fixture.manager.deleteSession(fixture.sessionId);
  fixture.ledger.assertReleased();
  await fixture.cwdWatchProbe.assertUnregistered();
}

async function emergencyDisposeFixture(fixture: GatedRealSessionFixture): Promise<void> {
  fixture.ledger.markEmergencyFallbackUsed();
  const sessions = (fixture.manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
  }).sessions;
  fixture.gatedWrites.dispose();
  await assertHeadlessWriteChainSettles({
    state: fixture.state,
    gatedWrites: fixture.gatedWrites,
    phase: 'fixture emergency cleanup write chain',
  });
  fixture.manager.stopAllCwdWatching();
  if (existsSync(fixture.cwdFilePath)) unlinkSync(fixture.cwdFilePath);
  fixture.originalHeadless.terminal.dispose();
  sessions.delete(fixture.sessionId);
}

async function runFixtureCleanupFailClosed(
  fixture: GatedRealSessionFixture,
  normalCleanup: () => Promise<void> | void,
): Promise<void> {
  try {
    await normalCleanup();
  } catch (primaryError) {
    try {
      await emergencyDisposeFixture(fixture);
    } catch (emergencyError) {
      throw new AggregateError(
        [primaryError, emergencyError],
        'fixture cleanup and emergency cleanup both failed',
      );
    }
    throw primaryError;
  }
}

function toFixtureCleanupError(errors: readonly unknown[], message: string): unknown | undefined {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message);
}

function throwFixtureBodyAndCleanupErrors(
  bodyFailed: boolean,
  bodyError: unknown,
  cleanupErrors: readonly unknown[],
  message: string,
): void {
  const cleanupError = toFixtureCleanupError(cleanupErrors, `${message} cleanup failed`);
  if (bodyFailed && cleanupError !== undefined) {
    throw new AggregateError([bodyError, cleanupError], `${message} body and cleanup both failed`);
  }
  if (bodyFailed) throw bodyError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function cleanupGatedRealSessionFixtureForTest(
  fixture: GatedRealSessionFixture,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const collect = async (cleanup: () => Promise<void> | void): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };

  await collect(() => runFixtureCleanupFailClosed(fixture, () => disposeFixture(fixture)));
  await collect(() => fixture.cwdWatchProbe.dispose());
  await collect(() => {
    if (existsSync(fixture.cwdFilePath)) unlinkSync(fixture.cwdFilePath);
  });
  await collect(() => fixture.router.destroy());

  const cleanupError = toFixtureCleanupError(cleanupErrors, 'fixture test cleanup failed');
  if (cleanupError !== undefined) throw cleanupError;
}

async function runGatedRealSessionFixtureTest(
  fixture: GatedRealSessionFixture,
  body: () => Promise<void>,
): Promise<void> {
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await cleanupGatedRealSessionFixtureForTest(fixture);
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwFixtureBodyAndCleanupErrors(
    bodyFailed,
    bodyError,
    cleanupErrors,
    'gated real-session fixture test',
  );
}

interface ProductionPtyEmergencyFixture {
  sessionId: string;
  state: ActualHeadlessSessionState | undefined;
  originalHeadless: { terminal: { dispose(): void } } | undefined;
  gatedWrites: GatedHeadlessWrites | undefined;
}

function emergencyDisposeProductionPtyFixtures(
  manager: SessionManager,
  fixtures: readonly ProductionPtyEmergencyFixture[],
): void {
  const errors: unknown[] = [];
  const attempt = (cleanup: () => void): void => {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  };
  const sessions = (manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
  }).sessions;

  for (const fixture of fixtures) attempt(() => fixture.gatedWrites?.dispose());
  attempt(() => manager.stopAllCwdWatching());
  for (const fixture of fixtures) {
    const currentHeadless = fixture.state as unknown as {
      headless?: { terminal?: { dispose(): void } };
      cwdFilePath?: string | null;
    } | undefined;
    const currentTerminal = currentHeadless?.headless?.terminal;
    attempt(() => currentTerminal?.dispose());
    if (fixture.originalHeadless?.terminal !== currentTerminal) {
      attempt(() => fixture.originalHeadless?.terminal.dispose());
    }
    if (typeof currentHeadless?.cwdFilePath === 'string' && existsSync(currentHeadless.cwdFilePath)) {
      attempt(() => unlinkSync(currentHeadless.cwdFilePath!));
    }
    attempt(() => { sessions.delete(fixture.sessionId); });
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'production PTY fixture emergency cleanup failed');
  }
}

async function writeHeldFixtureHeadlessOutput(fixture: GatedRealSessionFixture): Promise<void> {
  const chainBefore = fixture.state.headlessWriteChain;
  fixture.emitPtyData('held');
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.notEqual(fixture.state.headlessWriteChain, chainBefore,
    'actual fake-PTY data must schedule a new headless write chain');
  assert.equal(fixture.state.pendingHeadlessWrites, 1,
    'actual fake-PTY data must create one pending headless write');
  assert.equal(fixture.state.pendingHeadlessOutputs.size, 1,
    'actual fake-PTY data must remain in the pending headless output ledger');
  assert.equal(fixture.gatedWrites.pendingCallbacks, 1,
    'fixture must hold the actual PTY-driven headless write callback');
}

test('PERF-BGSTAB-010 gated headless fixture preserves full state while disposal releases held write callbacks', () => {
  let originalTerminalWrites = 0;
  let callbackCalls = 0;
  const originalHeadless = {
    terminal: {
      write(_data: string, callback: () => void) {
        originalTerminalWrites += 1;
        callback();
      },
      dispose() {},
    },
    serializeAddon: {},
    cursorHidden: false,
    cursorVisibilityTail: '',
    savedCursorControlTail: '',
    savedCursorObserved: false,
    retainedMetricsTracker: { sourceMarkers: [], disposables: [] },
  };
  const originalWrite = originalHeadless.terminal.write;
  const state = { headless: originalHeadless } as unknown as ActualHeadlessSessionState;
  const gatedWrites = enableGatedHeadlessWrites(state) as GatedHeadlessWrites;

  (state as unknown as {
    headless: { terminal: { write(data: string, callback: () => void): void } };
  }).headless.terminal.write('held', () => { callbackCalls += 1; });
  assert.equal(gatedWrites.pendingCallbacks, 1);
  gatedWrites.dispose();
  assert.equal(gatedWrites.pendingCallbacks, 0);
  assert.equal(originalTerminalWrites, 1);
  assert.equal(callbackCalls, 1);
  assert.equal((state as unknown as { headless: unknown }).headless, originalHeadless);
  assert.equal((state as unknown as {
    headless: { terminal: { write: unknown } };
  }).headless.terminal.write, originalWrite,
  'disposing the gate must restore the original terminal write method');
  (state as unknown as {
    headless: { terminal: { write(data: string, callback: () => void): void } };
  }).headless.terminal.write('after-dispose', () => { callbackCalls += 1; });
  assert.equal(gatedWrites.pendingCallbacks, 0,
    'writes after gate disposal must not create a new held callback');
  assert.equal(originalTerminalWrites, 2);
  assert.equal(callbackCalls, 2);
});

test('PERF-BGSTAB-010 gated real-session fixture drains a held write before public cleanup', async () => {
  const fixture = createGatedRealSessionFixture('gated-headless-held-write-red', 102);
  await runGatedRealSessionFixtureTest(fixture, async () => {
    await writeHeldFixtureHeadlessOutput(fixture);
    await fixture.cwdWatchProbe.assertObserved();
  });
});

test('PERF-BGSTAB-010 gated real-session fixture releases resources after an assertion failure', async () => {
  const fixture = createGatedRealSessionFixture('gated-headless-assertion-cleanup-red', 103);
  let normalCleanupFinished = false;
  let caught: unknown;

  try {
    await runGatedRealSessionFixtureTest(fixture, async () => {
      await writeHeldFixtureHeadlessOutput(fixture);
      await fixture.cwdWatchProbe.assertObserved();
      assert.fail('intentional fixture assertion failure');
      normalCleanupFinished = true;
    });
  } catch (error) {
    if (!(error instanceof assert.AssertionError)
      || error.message !== 'intentional fixture assertion failure') {
      throw error;
    }
    caught = error;
  }

  assert.equal(normalCleanupFinished, false,
    'the intentional assertion must remain the body failure while fail-closed cleanup still runs');
  assert.ok(caught instanceof assert.AssertionError);
  assert.equal(caught.message, 'intentional fixture assertion failure');
});

test('PERF-BGSTAB-010 emergency cleanup preserves a public finalizer error while releasing held callbacks', async () => {
  const fixture = createGatedRealSessionFixture('gated-headless-finalizer-error-red', 105);
  const sessions = (fixture.manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
  }).sessions;
  const headless = fixture.state.headless as unknown as {
    retainedMetricsTracker: unknown;
  };
  const originalRetainedMetricsTracker = headless.retainedMetricsTracker;
  let trackerRemoved = false;
  let cleanupAttempted = false;
  let rawPublicFinalizerError: unknown;
  let publicFinalizerError: unknown;
  let bodyFailed = false;
  let bodyError: unknown;

  try {
    await writeHeldFixtureHeadlessOutput(fixture);
    await fixture.cwdWatchProbe.assertObserved();

    headless.retainedMetricsTracker = undefined;
    trackerRemoved = true;
    cleanupAttempted = true;
    await assert.rejects(
      async () => runFixtureCleanupFailClosed(fixture, () => {
        try {
          fixture.manager.deleteSession(fixture.sessionId);
        } catch (error) {
          rawPublicFinalizerError = error;
          throw error;
        }
      }),
      (error: unknown) => {
        publicFinalizerError = error;
        return error instanceof TypeError && /sourceMarkers/.test(error.message);
      },
      'fixture cleanup must rethrow the exact public finalizer sourceMarkers error',
    );
    headless.retainedMetricsTracker = originalRetainedMetricsTracker;
    trackerRemoved = false;

    assert.ok(publicFinalizerError instanceof TypeError,
      'fail-closed fixture cleanup must preserve the public finalizer TypeError');
    assert.match(publicFinalizerError.message, /sourceMarkers/,
      'fail-closed fixture cleanup must rethrow the missing retained source markers error');
    assert.strictEqual(publicFinalizerError, rawPublicFinalizerError,
      'fail-closed fixture cleanup must rethrow the exact public finalizer error instance');
    assert.equal(fixture.gatedWrites.pendingCallbacks, 0,
      'fail-closed fixture cleanup must release the held callback after public finalization fails');
    assert.equal(sessions.has(fixture.sessionId), false,
      'fail-closed fixture cleanup must remove the failed fixture session');
    assert.equal(existsSync(fixture.cwdFilePath), false,
      'fail-closed fixture cleanup must remove the failed fixture CWD file');
    assert.equal(fixture.cwdWatchProbe.disposed, false,
      'fail-closed cleanup must leave the probe available to verify watcher unregistration');
    await fixture.cwdWatchProbe.assertUnregistered();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  } finally {
    if (trackerRemoved) headless.retainedMetricsTracker = originalRetainedMetricsTracker;
    const cleanupErrors: unknown[] = [];
    const collect = async (cleanup: () => Promise<void> | void): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (!cleanupAttempted) {
      await collect(() => runFixtureCleanupFailClosed(fixture, () => disposeFixture(fixture)));
    }
    await collect(() => fixture.cwdWatchProbe.dispose());
    await collect(() => {
      if (existsSync(fixture.cwdFilePath)) unlinkSync(fixture.cwdFilePath);
    });
    await collect(() => fixture.router.destroy());
    throwFixtureBodyAndCleanupErrors(
      bodyFailed,
      bodyError,
      cleanupErrors,
      'fail-closed fixture finalizer-error test',
    );
  }
});

test('PERF-BGSTAB-010 gated real-session PTY chain settles within the fixture bound after overflow cleanup', async () => {
  const fixture = createGatedRealSessionFixture('gated-headless-overflow-cleanup-red', 104, 1024);
  await runGatedRealSessionFixtureTest(fixture, async () => {
    await writeHeldFixtureHeadlessOutput(fixture);
    fixture.emitPtyData('x'.repeat(1025));
    await Promise.resolve();
    assert.equal(fixture.state.headlessHealth, 'degraded',
      'the focused real PTY diagnostic must enter the overflow cleanup branch');
    await fixture.cwdWatchProbe.assertObserved();
  });
});

function protectedRuntimeState(
  router: WsRouter,
  manager: SessionManager,
  sockets: readonly import('ws').WebSocket[],
  options: { includeCanaryTargets?: boolean } = {},
): string {
  const routerState = router as unknown as {
    transportQueues: Map<import('ws').WebSocket, WsTransportQueueState>;
    restoreAuthorityRetryKeys: Set<string>;
    sessionSubscribers: Map<string, Set<import('ws').WebSocket>>;
    clients: Map<import('ws').WebSocket, {
      clientId: string;
      connectionId: string;
      reconnectGeneration: number;
      subscribedSessions: Set<string>;
    }>;
    runtimeSendPolicyConfig: unknown;
    getTerminalResourcePolicyCanaryState?: (target: WsTarget) => unknown;
  };
  const managerState = manager as unknown as {
    sessions: Map<string, ActualHeadlessSessionState>;
    runtimeHeadlessQueueConfig: unknown;
  };
  const serializable = {
    effectiveConfigs: {
      ws: routerState.runtimeSendPolicyConfig,
      headless: managerState.runtimeHeadlessQueueConfig,
    },
    canaryTargets: options.includeCanaryTargets !== false
      && typeof routerState.getTerminalResourcePolicyCanaryState === 'function'
      ? [TARGET_A, TARGET_B].map(target => ({
        target,
        state: routerState.getTerminalResourcePolicyCanaryState!(target),
      }))
      : [],
    queues: sockets.map(socket => {
      const queue = routerState.transportQueues.get(socket);
      return queue ? getTransportMessagesInPriorityOrder(queue) : [];
    }),
    retryKeys: [...routerState.restoreAuthorityRetryKeys].sort(),
    clients: sockets.map(socket => {
      const client = routerState.clients.get(socket);
      return client ? {
        clientId: client.clientId,
        connectionId: client.connectionId,
        reconnectGeneration: client.reconnectGeneration,
        subscribedSessions: [...client.subscribedSessions].sort(),
      } : null;
    }),
    subscriberSizes: [...routerState.sessionSubscribers.entries()]
      .map(([sessionId, subscribers]) => [sessionId, subscribers.size] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    sessions: [...managerState.sessions.entries()].map(([sessionId, state]) => {
      const { oldestPendingAgeMs: _volatileAge, ...queue } = state.headlessOutputQueue.snapshot();
      return {
        sessionId,
        pending: [...state.pendingHeadlessOutputs.values()],
        queue,
        pendingBytes: state.pendingHeadlessOutputBytes,
        pendingWrites: state.pendingHeadlessWrites,
        screenSeq: state.screenSeq,
        authorityRevision: state.authorityRevision,
        snapshotCache: state.snapshotCache,
        unsnapshottedOutput: state.unsnapshottedOutput,
        producer: { writes: state.pty.writes, pauses: state.pty.pauses },
      };
    }).sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  };
  return createHash('sha256').update(JSON.stringify(serializable)).digest('hex');
}

function currentWsConsumerLimit(router: WsRouter): number {
  return (router as unknown as {
    runtimeSendPolicyConfig: { limits: { perClientOutputQueueMaxBytes: number } };
  }).runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes;
}

function currentHeadlessConsumerLimit(manager: SessionManager): number {
  return (manager as unknown as {
    runtimeHeadlessQueueConfig: { limits: { pendingOutputMaxBytes: number } };
  }).runtimeHeadlessQueueConfig.limits.pendingOutputMaxBytes;
}

function runtimeCanaryRegistrySizes(store: RuntimeConfigStore): {
  targetHandles: number;
  listeners: number;
  timers: number;
  retainedEntries: number;
} {
  const registries = (store as unknown as {
    terminalResourcePolicyCanaryRegistries?: {
      targetHandles: Map<string, unknown>;
      listeners: Set<unknown>;
      timers: Set<unknown>;
      retainedEntries: Map<string, unknown>;
    };
  }).terminalResourcePolicyCanaryRegistries;
  assert.ok(registries, 'actual RuntimeConfigStore canary registries must be auditable');
  return {
    targetHandles: registries.targetHandles.size,
    listeners: registries.listeners.size,
    timers: registries.timers.size,
    retainedEntries: registries.retainedEntries.size,
  };
}

function runtimeApi(store: RuntimeConfigStore): Partial<RuntimeCanaryApi> {
  return store as unknown as Partial<RuntimeCanaryApi>;
}

const TRUSTED_EVIDENCE = {
  requirementId: 'OBS-BGSTAB-005', status: 'implemented', manifestSha256: OBS_MANIFEST_SHA256,
} as const;

function createTrustedAuthority(
  module: Partial<CanaryModule>,
  contracts: readonly TrustedProfile[],
): PolicyLeaseAuthority {
  assert.equal(typeof module.createTerminalResourcePolicyLeaseIssuer, 'function');
  return module.createTerminalResourcePolicyLeaseIssuer!({
    trustedEvidence: TRUSTED_EVIDENCE,
    contracts,
  });
}

function issueWsLease(
  api: Partial<RuntimeCanaryApi>,
  candidate: TrustedProfile,
  target = TARGET_A,
): PolicyLease {
  assert.equal(typeof api.issueTerminalResourcePolicyLease, 'function');
  const decision = api.issueTerminalResourcePolicyLease!({
    contractId: candidate.contractId,
    target,
    selectedTarget: target,
    resource: WS_RESOURCE,
    consumer: WS_CONSUMER,
    capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
  });
  assert.equal(decision.mode, 'candidate');
  assert.ok(decision.lease);
  return decision.lease;
}

function issueHeadlessLease(api: Partial<RuntimeCanaryApi>, candidate: TrustedProfile): PolicyLease {
  assert.equal(typeof api.issueTerminalResourcePolicyLease, 'function');
  const decision = api.issueTerminalResourcePolicyLease!({
    contractId: candidate.contractId,
    target: HEADLESS_A,
    selectedTarget: HEADLESS_A,
    resource: HEADLESS_RESOURCE,
    consumer: HEADLESS_CONSUMER,
    capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
  });
  assert.equal(decision.mode, 'candidate');
  assert.ok(decision.lease);
  return decision.lease;
}

test('Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-1', async () => {
  assert.equal(MODULE_PRESENT, true, signature(1));
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  assert.equal(typeof module.createTerminalResourcePolicyLeaseIssuer, 'function', signature(1));
  assert.deepEqual(getRegisteredTerminalResourcePolicyProfiles(), [],
    'the production registry has no stable enforcement profile yet');
  const candidate = profile({ [WS_RESOURCE]: 32 });
  const issueInput = {
    contractId: candidate.contractId,
    target: TARGET_A,
    selectedTarget: TARGET_A,
    resource: WS_RESOURCE,
    consumer: WS_CONSUMER,
    capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
  } as const;
  const defaultHarness = createHarness();
  try {
    const defaultApi = runtimeApi(defaultHarness.store);
    assert.equal(typeof defaultApi.issueTerminalResourcePolicyLease, 'function', signature(1));
    assert.deepEqual(defaultApi.issueTerminalResourcePolicyLease!(issueInput), {
      mode: 'legacy', reason: 'candidate-unavailable',
    }, 'default RuntimeConfigStore must stay unavailable while the real stable-profile registry is empty');
  } finally {
    defaultHarness.router.destroy();
  }
  const unavailable = module.createTerminalResourcePolicyLeaseIssuer!({
    trustedEvidence: TRUSTED_EVIDENCE,
    contracts: [],
  });
  assert.deepEqual(unavailable.issue(issueInput), {
    mode: 'legacy', reason: 'candidate-unavailable',
  });
  for (const evidence of [
    { requirementId: 'OBS-BGSTAB-005', status: 'implemented', manifestSha256: '0'.repeat(64) },
    { requirementId: 'OBS-BGSTAB-005', status: 'planned', manifestSha256: OBS_MANIFEST_SHA256 },
  ]) {
    const rejected = module.createTerminalResourcePolicyLeaseIssuer!({ trustedEvidence: evidence, contracts: [candidate] });
    assert.deepEqual(rejected.issue(issueInput), {
      mode: 'legacy', reason: 'candidate-not-trusted',
    });
  }
  for (const invalidContract of [
    { ...candidate, stability: 'draft' as const },
    { ...candidate, stability: 'evolving' as const },
    { ...candidate, policyId: 'unsupported' },
    { ...candidate, profileVersion: '2.0.0' },
    { ...candidate, schemaVersion: 'terminal-resource-policy/stale' },
    { ...candidate, requiredCapabilities: { [WS_CONSUMER]: REQUIRED_CAPABILITY_VERSION - 1 } },
    profile({ [WS_RESOURCE]: Number.NaN }, ':invalid-nan'),
    profile({ [WS_RESOURCE]: Number.POSITIVE_INFINITY }, ':invalid-infinity'),
    profile({ [WS_RESOURCE]: -1 }, ':invalid-negative'),
    profile({ [WS_RESOURCE]: 1.5 }, ':invalid-fractional'),
  ]) {
    const rejected = module.createTerminalResourcePolicyLeaseIssuer!({
      trustedEvidence: TRUSTED_EVIDENCE,
      contracts: [invalidContract],
    });
    assert.deepEqual(rejected.issue({ ...issueInput, contractId: invalidContract.contractId }), {
      mode: 'legacy', reason: 'candidate-not-trusted',
    }, 'invalid boot-wired contracts cannot become an issuance source');
  }
  const issuer = createTrustedAuthority(module, [candidate]);
  assert.deepEqual(issuer.issue({
    ...issueInput,
    target: HEADLESS_A,
    selectedTarget: HEADLESS_A,
  }), {
    mode: 'legacy', reason: 'resource-target-mismatch',
  }, 'a WS resource lease cannot target a headless session');
  const cases: Array<{ input: Parameters<typeof issuer.issue>[0]; reason: string }> = [
    { input: { ...issueInput, capability: undefined }, reason: 'capability-missing' },
    { input: { ...issueInput, capability: { ...issueInput.capability, version: REQUIRED_CAPABILITY_VERSION - 1 } }, reason: 'capability-version-mismatch' },
    { input: { ...issueInput, capability: { ...issueInput.capability, version: REQUIRED_CAPABILITY_VERSION + 1 } }, reason: 'capability-version-mismatch' },
    { input: { ...issueInput, capability: { ...issueInput.capability, compilerSchemaVersion: 'terminal-resource-policy/stale' } }, reason: 'compiler-schema-mismatch' },
    { input: { ...issueInput, contractId: 'caller-injected-profile' }, reason: 'candidate-unavailable' },
    { input: { ...issueInput, target: { ...TARGET_A, connectionId: 'stale-connection' } }, reason: 'target-not-selected' },
    { input: { ...issueInput, target: { ...TARGET_A, reconnectGeneration: 2 } }, reason: 'target-not-selected' },
  ];
  for (const fixture of cases) {
    const result = issuer.issue(fixture.input);
    assert.equal(result.mode, 'legacy');
    assert.equal(result.reason, fixture.reason);
    assert.equal(result.lease, undefined);
  }
  const exact = issuer.issue(issueInput);
  assert.equal(exact.mode, 'candidate');
  assert.ok(exact.lease);
  assert.equal(issuer.validate(exact.lease), true);
  const expectedLeasePayloadKeys = [
    'consumer', 'leaseId', 'policyId', 'profileVersion', 'resource', 'schemaVersion', 'target',
  ];
  assert.deepEqual(Object.keys(exact.lease).sort(), expectedLeasePayloadKeys,
    'lease payload has an exact allowlist and carries no authority-only issuance metadata');
  const serializedLease = JSON.parse(JSON.stringify(exact.lease)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(serializedLease).sort(), expectedLeasePayloadKeys);
  assert.equal('issuanceSequence' in exact.lease, false);
  assert.equal('targetEpoch' in exact.lease, false);
  const exactMetadata = issuer.getLeaseMetadata(exact.lease);
  assert.ok(exactMetadata);
  assert.equal(Object.isFrozen(exactMetadata), true, 'authority-owned lease metadata is immutable');
  assert.equal(Number.isSafeInteger(exactMetadata.issuanceSequence), true);
  assert.ok(exactMetadata.issuanceSequence > 0);
  assert.equal(exactMetadata.targetEpoch, 0, 'the first target epoch starts at zero');

  const rogueIssuer = createTrustedAuthority(module, [candidate]);
  const rogue = rogueIssuer.issue(issueInput);
  assert.equal(rogue.mode, 'candidate');
  assert.ok(rogue.lease);
  assert.equal(rogueIssuer.validate(rogue.lease), true);
  assert.equal(issuer.validate(rogue.lease), false,
    'an identically configured issuer is not the boot-wired authority');
  assert.equal(issuer.getLeaseMetadata(rogue.lease), undefined,
    'opaque issuance metadata is visible only to the authority that issued the lease');

  const trustedHarness = createHarness(issuer);
  const ws = createFakeWs();
  try {
    subscribe(trustedHarness.router, ws.ws, TARGET_A.clientId, ['session-a1']);
    const canaryRouter = trustedHarness.router as unknown as {
      activateTerminalResourcePolicyLease(input: { lease: PolicyLease }): { mode: 'candidate' | 'legacy'; reason: string };
      getTerminalResourcePolicyCanaryState(target: WsTarget): unknown;
    };
    assert.equal(typeof canaryRouter.activateTerminalResourcePolicyLease, 'function', signature(1));
    assert.equal(typeof canaryRouter.getTerminalResourcePolicyCanaryState, 'function', signature(1));
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease({ lease: exact.lease }), {
      mode: 'candidate', reason: 'candidate-selected',
    });
    const beforeRogue = {
      protected: protectedRuntimeState(trustedHarness.router, trustedHarness.manager, [ws.ws]),
      canary: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A)),
    };
    assert.deepEqual(canaryRouter.activateTerminalResourcePolicyLease({ lease: rogue.lease }), {
      mode: 'legacy', reason: 'invalid-policy-lease',
    });
    assert.deepEqual({
      protected: protectedRuntimeState(trustedHarness.router, trustedHarness.manager, [ws.ws]),
      canary: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A)),
    }, beforeRogue, 'rogue issuer rejection must be state-preserving');
  } finally {
    trustedHarness.router.destroy();
  }
});

test('REL-BGSTAB-010 production assembly shares one registry-derived lease authority', async () => {
  const runtime = await import('./TerminalResourcePolicyRuntime.js') as unknown as {
    terminalResourcePolicyRuntimeAuthority: PolicyLeaseAuthority;
    createTerminalResourcePolicyRuntimeAuthority(options?: { contracts?: readonly TrustedProfile[] }): PolicyLeaseAuthority;
    getTerminalResourcePolicyRuntimeAssemblySnapshot(): {
      stableProfileCount: number;
      registryHash: string;
    };
  };
  const snapshot = runtime.getTerminalResourcePolicyRuntimeAssemblySnapshot();
  assert.equal(snapshot.stableProfileCount, 0,
    'production registry remains fail-closed until a reviewed stable contract is registered');
  assert.match(snapshot.registryHash, /^[a-f0-9]{64}$/);
  const unavailable = runtime.terminalResourcePolicyRuntimeAuthority.issue({
    contractId: 'not-registered', target: TARGET_A, selectedTarget: TARGET_A,
    resource: WS_RESOURCE, consumer: WS_CONSUMER,
    capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
  });
  assert.deepEqual(unavailable, { mode: 'legacy', reason: 'candidate-unavailable' });
  const source = await import('node:fs/promises').then(fs => fs.readFile(
    new URL('../index.ts', import.meta.url), 'utf8',
  ));
  assert.equal((source.match(/terminalResourcePolicyRuntimeAuthority/g) ?? []).length >= 3, true,
    'production index passes the same authority to RuntimeConfigStore and WsRouter');
  const singletonAuthority = (await import('./SessionManager.js') as unknown as {
    sessionManager: { terminalResourcePolicyAuthority?: PolicyLeaseAuthority };
  }).sessionManager.terminalResourcePolicyAuthority;
  assert.equal(singletonAuthority, runtime.terminalResourcePolicyRuntimeAuthority,
    'the production SessionManager singleton uses the same issuer provenance');

  const futureProfile = profile({ [WS_RESOURCE]: 8192 }, ':production-future-stable');
  const futureAuthority = runtime.createTerminalResourcePolicyRuntimeAuthority({ contracts: [futureProfile] });
  const { router, manager, store } = createHarness(futureAuthority);
  const socket = createFakeWs();
  try {
    subscribe(router, socket.ws, TARGET_A.clientId, ['session-a1']);
    const futureApi = runtimeApi(store);
    const futureLease = issueWsLease(futureApi, futureProfile);
    assert.equal(futureApi.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: futureLease,
    }).mode, 'candidate', 'an explicitly injected future stable contract reaches the real adapter');
  } finally {
    router.destroy();
  }
});

test('Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-2', async () => {
  assert.equal(MODULE_PRESENT, true, signature(2));
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const probe = createHarness();
  const probeA = createFakeWs();
  const probeB = createFakeWs();
  let projectedFixture: number;
  try {
    seedAc2Queues(probe.router, probeA, probeB);
    const probeIncoming = createInternalMessage(
      { type: 'output', sessionId: 'session-a2', data: 'incoming-한😀\\"\n' },
      200,
      {
        policyGeneration: 0, expiresAt: 60_000, ready: true, recoveryGeneration: 4,
        source: 'pty-output', exactlyOnceKey: 'incoming-exactly-once',
      },
    );
    projectedFixture = queuedMessages(probe.router, probeA.ws)
      .reduce((sum, entry) => sum + entry.byteLength, 0) + probeIncoming.byteLength;
  } finally {
    probe.router.destroy();
  }
  const contracts = [
    profile({ [WS_RESOURCE]: 8192 }),
    profile({ [WS_RESOURCE]: 2048 }),
    profile({ [WS_RESOURCE]: projectedFixture - 1 }),
    profile({ [WS_RESOURCE]: projectedFixture }),
    profile({ [WS_RESOURCE]: projectedFixture + 1 }),
  ];
  const authority = createTrustedAuthority(module, contracts);
  const { router, manager, store } = createHarness(authority);
  const a = createFakeWs();
  const b = createFakeWs();
  try {
    seedAc2Queues(router, a, b);
    const oldEntries = queuedMessages(router, a.ws);
    assert.equal(oldEntries.length, 3);
    const api = runtimeApi(store);
    assert.equal(typeof api.issueTerminalResourcePolicyLease, 'function', signature(2));
    assert.equal(typeof api.applyTerminalResourcePolicyLease, 'function', signature(2));
    assert.equal(typeof api.previewTerminalResourcePolicyCanaryAdmission, 'function', signature(2));
    assert.equal(typeof api.admitTerminalResourcePolicyCanaryMessage, 'function', signature(2));
    assert.equal(typeof api.getTerminalResourcePolicyCanaryLedger, 'function', signature(2));
    const canaryRouter = router as unknown as {
      getTerminalResourcePolicyCanaryState(target: WsTarget): unknown;
    };
    assert.equal(typeof canaryRouter.getTerminalResourcePolicyCanaryState, 'function', signature(2));
    for (const entry of oldEntries as InternalTransportMessage[]) {
      assert.equal(typeof entry.byteLength, 'number');
      assert.equal(typeof entry.queuedAt, 'number');
      assert.equal(typeof entry.expiresAt, 'number');
      assert.equal(typeof entry.policyGeneration, 'number');
      assert.equal(typeof entry.ready, 'boolean');
      assert.equal(typeof entry.recoveryGeneration, 'number');
      assert.equal(typeof entry.source, 'string');
      assert.equal(typeof entry.exactlyOnceKey, 'string');
    }
    const oldClone = structuredClone(oldEntries);
    const oldHash = createHash('sha256').update(JSON.stringify(oldClone)).digest('hex');
    const queuedBytes = oldEntries.reduce((sum, entry) => sum + entry.byteLength, 0);
    const legacyWsConsumerLimit = currentWsConsumerLimit(router);
    assert.equal(legacyWsConsumerLimit, 4096, 'WsRouter is the authoritative WS consumer limit, not RuntimeConfigStore defaults');
    const incoming = createInternalMessage(
      { type: 'output', sessionId: 'session-a2', data: 'incoming-한😀\\"\n' },
      200,
      {
        policyGeneration: 0, expiresAt: 60_000, ready: true, recoveryGeneration: 4,
        source: 'pty-output', exactlyOnceKey: 'incoming-exactly-once',
      },
    );
    const projected = queuedBytes + incoming.byteLength;
    assert.equal(projected, projectedFixture, 'trusted boot contract fixture must match the actual queue bytes');
    const increasedWsLimit = legacyWsConsumerLimit * 2;
    const decreasedWsLimit = Math.floor(legacyWsConsumerLimit / 2);
    const increaseLease = issueWsLease(api, profile({ [WS_RESOURCE]: increasedWsLimit }));
    assert.equal(Object.isFrozen(increaseLease), true, 'issuer leases must be immutable');
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: increaseLease }), {
      mode: 'candidate', reason: 'candidate-selected', previousEffectiveDecision: legacyWsConsumerLimit, nextEffectiveDecision: increasedWsLimit,
    });
    const decreaseLease = issueWsLease(api, profile({ [WS_RESOURCE]: decreasedWsLimit }));
    const forgedLease = { ...decreaseLease } as PolicyLease;
    assert.notEqual(forgedLease, decreaseLease);
    const beforeForged = {
      protected: protectedRuntimeState(router, manager, [a.ws, b.ws]),
      target: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A)),
      ledger: api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: increaseLease }),
      registries: runtimeCanaryRegistrySizes(store),
    };
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: forgedLease,
    }), {
      mode: 'legacy', reason: 'invalid-policy-lease',
      previousEffectiveDecision: increasedWsLimit,
      nextEffectiveDecision: increasedWsLimit,
    }, 'a structurally identical caller-forged lease must be rejected');
    assert.deepEqual({
      protected: protectedRuntimeState(router, manager, [a.ws, b.ws]),
      target: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A)),
      ledger: api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: increaseLease }),
      registries: runtimeCanaryRegistrySizes(store),
    }, beforeForged, 'forged apply must preserve effective config, generation, ledger, registries, queues and other targets');
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: decreaseLease }), {
      mode: 'candidate', reason: 'candidate-selected', previousEffectiveDecision: increasedWsLimit, nextEffectiveDecision: decreasedWsLimit,
    });
    const clientMetadata = (router as unknown as {
      clients: Map<typeof a.ws, { connectionId: string; reconnectGeneration: number }>;
    }).clients.get(a.ws)!;
    const stableConnectionMetadata = {
      connectionId: clientMetadata.connectionId,
      reconnectGeneration: clientMetadata.reconnectGeneration,
    };
    const validLedgerBeforeStale = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: decreaseLease,
    });
    const targetStateBeforeStale = structuredClone(
      canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A),
    );
    for (const staleMetadata of [
      { ...stableConnectionMetadata, connectionId: 'replacement-connection-a' },
      { ...stableConnectionMetadata, reconnectGeneration: TARGET_A.reconnectGeneration + 1 },
    ]) {
      Object.assign(clientMetadata, staleMetadata);
      const beforeStaleAttempt = {
        protected: protectedRuntimeState(router, manager, [a.ws, b.ws]),
        target: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A)),
        registries: runtimeCanaryRegistrySizes(store),
      };
      const stalePreview = api.previewTerminalResourcePolicyCanaryAdmission!({
        wsRouter: router, lease: decreaseLease, incomingMessage: incoming,
      });
      assert.deepEqual({ accepted: stalePreview.accepted, mode: stalePreview.mode, reason: stalePreview.reason }, {
        accepted: false, mode: 'legacy', reason: 'stale-target-lease',
      });
      const staleLedger = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: decreaseLease });
      assert.deepEqual({
        denied: staleLedger.denied,
        reason: staleLedger.reason,
        entries: staleLedger.entries,
      }, {
        denied: true,
        reason: 'stale-target-lease',
        entries: [],
      });
      assert.deepEqual({
        protected: protectedRuntimeState(router, manager, [a.ws, b.ws]),
        target: structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A)),
        registries: runtimeCanaryRegistrySizes(store),
      }, beforeStaleAttempt,
      'stale rejection must preserve effective config, generation, cleanup registries, queues and other target state');
      Object.assign(clientMetadata, stableConnectionMetadata);
      assert.deepEqual(canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A), targetStateBeforeStale);
      assert.deepEqual(api.getTerminalResourcePolicyCanaryLedger!({
        wsRouter: router, lease: decreaseLease,
      }), validLedgerBeforeStale, 'denied stale projection cannot mutate the underlying valid-lease ledger');
    }
    for (const cap of [projected - 1, projected, projected + 1]) {
      const lease = issueWsLease(api, profile({ [WS_RESOURCE]: cap }));
      api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease });
      const preview = api.previewTerminalResourcePolicyCanaryAdmission!({
        wsRouter: router, lease, incomingMessage: incoming,
      });
      assert.deepEqual({
        resource: preview.resource,
        consumer: preview.consumer,
        target: preview.target,
        owner: preview.queueOwner,
        sessions: preview.queuedSessionIds,
        queuedBytes: preview.queuedBytes,
        incomingBytes: preview.computedIncomingBytes,
        projectedBytes: preview.projectedBytes,
        mode: preview.mode,
      }, {
        resource: WS_RESOURCE,
        consumer: WS_CONSUMER,
        target: TARGET_A,
        owner: 'ws-router',
        sessions: ['session-a1', 'session-a2'],
        queuedBytes,
        incomingBytes: wirePayloadByteLength(incoming.payload),
        projectedBytes: projected,
        mode: cap < projected ? 'legacy' : 'candidate',
      });
    }
    const beforeCommitCount = queuedMessages(router, a.ws).length;
    const exactLease = issueWsLease(api, profile({ [WS_RESOURCE]: projected }));
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: exactLease });
    const committed = api.admitTerminalResourcePolicyCanaryMessage!({
      wsRouter: router, lease: exactLease, incomingMessage: incoming,
    });
    assert.equal(committed.enqueuedExactlyOnce, true);
    assert.ok(committed.entryToken);
    assert.equal(queuedMessages(router, a.ws).length, beforeCommitCount + 1);
    assert.equal(queuedMessages(router, b.ws).length, 1, 'different client aggregate must not change');

    const overflowLease = issueWsLease(api, profile({ [WS_RESOURCE]: projected - 1 }));
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: overflowLease });
    const overflow = api.admitTerminalResourcePolicyCanaryMessage!({
      wsRouter: router, lease: overflowLease,
      incomingMessage: createInternalMessage(
        { type: 'output', sessionId: 'session-a1', data: 'legacy-fallback-once' }, 201,
        {
          policyGeneration: 0, expiresAt: 60_001, ready: true, recoveryGeneration: 4,
          source: 'pty-output', exactlyOnceKey: 'fallback-exactly-once',
        },
      ),
    });
    assert.deepEqual({ accepted: overflow.accepted, mode: overflow.mode, reason: overflow.reason, once: overflow.enqueuedExactlyOnce }, {
      accepted: true, mode: 'legacy', reason: 'candidate-cap-exceeded-fallback', once: true,
    });
    const fallbackTail = queuedMessages(router, a.ws).at(-1) as InternalTransportMessage;
    assert.equal(fallbackTail.policyGeneration, overflow.policyGeneration);
    assert.equal(fallbackTail.exactlyOnceKey, 'fallback-exactly-once');

    const queuedTampered = queuedMessages(router, a.ws)[0];
    const originalQueuedByteLength = queuedTampered.byteLength;
    queuedTampered.byteLength = 1;
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: exactLease });
    const queuedRejected = api.previewTerminalResourcePolicyCanaryAdmission!({
      wsRouter: router, lease: exactLease, incomingMessage: incoming,
    });
    assert.deepEqual({ accepted: queuedRejected.accepted, reason: queuedRejected.reason }, {
      accepted: false, reason: 'tampered-queued-message-byte-length',
    });
    queuedTampered.byteLength = originalQueuedByteLength;

    const tampered = { ...incoming, byteLength: 1 };
    const beforeTamperCount = queuedMessages(router, a.ws).length;
    const rejected = api.admitTerminalResourcePolicyCanaryMessage!({
      wsRouter: router, lease: exactLease, incomingMessage: tampered,
    });
    assert.deepEqual({ accepted: rejected.accepted, reason: rejected.reason }, {
      accepted: false, reason: 'tampered-message-byte-length',
    });
    assert.equal(queuedMessages(router, a.ws).length, beforeTamperCount);
    const rereadOld = queuedMessages(router, a.ws).slice(0, 3);
    assert.deepEqual(rereadOld, oldClone);
    assert.equal(createHash('sha256').update(JSON.stringify(rereadOld)).digest('hex'), oldHash);

    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: overflowLease });
    const legacyOverflow = api.admitTerminalResourcePolicyCanaryMessage!({
      wsRouter: router,
      lease: overflowLease,
      incomingMessage: createInternalMessage(
        { type: 'output', sessionId: 'session-a1', data: 'x'.repeat(5_000) }, 202,
        {
          policyGeneration: 0, expiresAt: 60_002, ready: true, recoveryGeneration: 4,
          source: 'pty-output', exactlyOnceKey: 'legacy-overflow-exactly-once',
        },
      ),
    });
    assert.deepEqual({
      accepted: legacyOverflow.accepted,
      mode: legacyOverflow.mode,
      reason: legacyOverflow.reason,
      enqueuedExactlyOnce: legacyOverflow.enqueuedExactlyOnce,
    }, {
      accepted: false,
      mode: 'legacy',
      reason: 'legacy-output-queue-overflow',
      enqueuedExactlyOnce: false,
    }, 'explicit admission must pass through the legacy queue cap and close policy');
    assert.equal(a.getCloseCode(), 1013);
  } finally {
    router.destroy();
    void manager;
  }
});

test('Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-3', async () => {
  assert.equal(MODULE_PRESENT, true, signature(3));
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const candidate = profile({ [WS_RESOURCE]: 8192 });
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(createTrustedAuthority(module, [candidate]), {
    spawnPty: pty.spawnPty,
  });
  const fixtureObserver = observeActualHeadlessSessionCreation(manager);
  const a = createFakeWs();
  const b = createFakeWs();
  try {
    subscribe(router, a.ws, TARGET_A.clientId, ['session-a1']);
    subscribe(router, b.ws, TARGET_B.clientId, ['session-b1']);
    router.routeSessionOutput('session-a1', 'protected-a-output');
    router.routeSessionOutput('session-b1', 'protected-b-output');
    const headlessA = initializeActualHeadlessSession(manager, HEADLESS_A, [{
      rawData: 'protected-headless-A', queuedAt: 10, expiresAt: 20_000, ready: true,
      recoveryGeneration: 2, exactlyOnceKey: 'protected-a', policyGeneration: 3,
    }]);
    const headlessB = initializeActualHeadlessSession(manager, { kind: 'headless', sessionId: 'session-b1' }, [{
      rawData: 'protected-headless-B', queuedAt: 11, expiresAt: 20_001, ready: false,
      recoveryGeneration: 4, exactlyOnceKey: 'protected-b', policyGeneration: 5,
    }]);
    assert.deepEqual({
      creates: fixtureObserver.createCount,
      spawns: pty.spawnCount,
      onDataRegistrations: pty.onDataRegistrationCount,
    }, {
      creates: 2,
      spawns: 2,
      onDataRegistrations: 2,
    }, 'AC-3 headless fixtures must use two public SessionManager creations with deterministic PTY registration');
    fixtureObserver.assertFixtureState(HEADLESS_A.sessionId, headlessA);
    assertCompleteHeadlessAuthorityFixture(headlessA, 'selected headless canary fixture');
    fixtureObserver.assertFixtureState('session-b1', headlessB);
    assertCompleteHeadlessAuthorityFixture(headlessB, 'nonselected headless canary fixture');
    (router as unknown as { restoreAuthorityRetryKeys: Set<string> })
      .restoreAuthorityRetryKeys.add('session-a1:authority-probe');
    const protectedBefore = protectedRuntimeState(
      router, manager, [a.ws, b.ws], { includeCanaryTargets: false },
    );
    const sentBefore = [structuredClone(a.sent), structuredClone(b.sent)];
    const api = runtimeApi(store);
    assert.equal(typeof api.issueTerminalResourcePolicyLease, 'function', signature(3));
    const lease = issueWsLease(api, candidate);
    assert.equal(typeof api.applyTerminalResourcePolicyLease, 'function', signature(3));
    assert.equal(typeof api.rollbackTerminalResourcePolicyLease, 'function', signature(3));
    assert.equal(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease,
    }).mode, 'candidate');
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease,
    }), { state: 'draining', reason: 'rollback-draining' });
    assert.equal(protectedRuntimeState(
      router, manager, [a.ws, b.ws], { includeCanaryTargets: false },
    ), protectedBefore,
    'actual apply/rollback must not mutate queues, connection identity, recovery, or PTY producer state');
    assert.deepEqual([a.sent, b.sent], sentBefore, 'lifecycle ports must not direct-write recovery or output frames');
    assert.equal(a.getCloseCode(), undefined);
    assert.equal(b.getCloseCode(), undefined);
    assert.deepEqual({ writes: headlessA.pty.writes, pauses: headlessA.pty.pauses }, { writes: 0, pauses: 0 });
    const registries = (store as unknown as {
      terminalResourcePolicyCanaryRegistries?: {
        targetHandles: Map<string, unknown>;
        listeners: Set<unknown>;
        timers: Set<unknown>;
        retainedEntries: Map<string, unknown>;
      };
    }).terminalResourcePolicyCanaryRegistries;
    assert.ok(registries, 'cleanup must expose actual RuntimeConfigStore registry objects for audit');
    assert.equal(registries.targetHandles instanceof Map, true);
    assert.equal(registries.listeners instanceof Set, true);
    assert.equal(registries.timers instanceof Set, true);
    assert.equal(registries.retainedEntries instanceof Map, true);
    assert.deepEqual({
      targetHandles: registries.targetHandles.size,
      listeners: registries.listeners.size,
      timers: registries.timers.size,
      retainedEntries: registries.retainedEntries.size,
    }, { targetHandles: 0, listeners: 0, timers: 0, retainedEntries: 0 });
  } finally {
    manager.deleteSession(HEADLESS_A.sessionId);
    manager.deleteSession('session-b1');
    router.destroy();
  }
});

test('Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-4', async () => {
  assert.equal(MODULE_PRESENT, true, signature(4));
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const initialProfile = profile({ [WS_RESOURCE]: 1_000_000 });
  const transitionProfile = profile({ [WS_RESOURCE]: 900_000 });
  const { router, manager, store } = createHarness(createTrustedAuthority(module, [
    initialProfile,
    transitionProfile,
  ]));
  const a = createFakeWs();
  const b = createFakeWs();
  try {
    subscribe(router, a.ws, TARGET_A.clientId, ['session-a1', 'session-a2']);
    subscribe(router, b.ws, TARGET_B.clientId, ['session-b1']);
    const api = runtimeApi(store);
    assert.equal(typeof api.issueTerminalResourcePolicyLease, 'function', signature(4));
    assert.equal(typeof api.applyTerminalResourcePolicyLease, 'function', signature(4));
    assert.equal(typeof api.admitTerminalResourcePolicyCanaryMessage, 'function', signature(4));
    assert.equal(typeof api.rollbackTerminalResourcePolicyLease, 'function', signature(4));
    assert.equal(typeof api.getTerminalResourcePolicyCanaryLedger, 'function', signature(4));
    const leaseA = issueWsLease(api, initialProfile, TARGET_A);
    const leaseB = issueWsLease(api, initialProfile, TARGET_B);
    const beforeSelection = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: leaseA });
    const beforeSelectionLastSequence = beforeSelection.entries.at(-1)?.sequence ?? 0;
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: leaseA });
    const afterSelection = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: leaseA });
    assert.equal(afterSelection.totalEvents, beforeSelection.totalEvents + 1,
      'candidate selection contributes exactly one ledger event');
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: leaseB });
    const bBefore = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: leaseB });
    const initial = afterSelection;
    const initialSelection = initial.entries.at(-1);
    assert.ok(initialSelection);
    assert.equal(initialSelection.event, 'candidate-selected');
    assert.equal(initialSelection.policyId, 'test-only-wave3-reviewed');
    assert.equal(initialSelection.profileVersion, '1.0.0');
    const initialCandidateGeneration = initialSelection.policyGeneration;
    for (let index = 0; index < initial.capacity + 3; index += 1) {
      api.admitTerminalResourcePolicyCanaryMessage!({
        wsRouter: router,
        lease: leaseA,
        incomingMessage: createInternalMessage(
          { type: 'output', sessionId: index % 2 === 0 ? 'session-a1' : 'session-a2', data: `ledger-${index}` },
          1_000 + index,
          {
            policyGeneration: 0, expiresAt: 90_000 + index, ready: true, recoveryGeneration: 3,
            source: 'pty-output', exactlyOnceKey: `ledger-once-${index}`,
          },
        ),
      });
    }
    const afterAdmissions = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: leaseA });
    assert.equal(afterAdmissions.totalEvents, initial.totalEvents + initial.capacity + 3,
      'capacity + K admissions contribute exactly capacity + K events');
    const rejectedMessage = createInternalMessage(
      { type: 'output', sessionId: 'session-a1', data: 'tampered-ledger' }, 2_000,
      {
        policyGeneration: 0, expiresAt: 99_000, ready: true, recoveryGeneration: 3,
        source: 'pty-output', exactlyOnceKey: 'ledger-rejected',
      },
    );
    rejectedMessage.byteLength = 1;
    api.admitTerminalResourcePolicyCanaryMessage!({ wsRouter: router, lease: leaseA, incomingMessage: rejectedMessage });
    const afterRejection = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: leaseA });
    assert.equal(afterRejection.totalEvents, afterAdmissions.totalEvents + 1,
      'the rejected admission contributes exactly one event');
    const transitionLeaseA = issueWsLease(api, transitionProfile, TARGET_A);
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: transitionLeaseA,
    }), {
      mode: 'candidate', reason: 'candidate-selected',
      previousEffectiveDecision: 1_000_000, nextEffectiveDecision: 900_000,
    });
    const canaryRouter = router as unknown as {
      getTerminalResourcePolicyCanaryState(target: WsTarget): { policyGeneration: number; mode: 'candidate' | 'legacy' };
    };
    assert.equal(typeof canaryRouter.getTerminalResourcePolicyCanaryState, 'function', signature(4));
    const transitionGeneration = canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A).policyGeneration;
    assert.ok(transitionGeneration > initialCandidateGeneration);
    const afterTransition = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: transitionLeaseA });
    assert.equal(afterTransition.totalEvents, afterRejection.totalEvents + 1,
      'the effective-decision transition contributes exactly one event');
    a.setBufferedAmount(0);
    (router as unknown as { flushTransportQueue(ws: typeof a.ws): void }).flushTransportQueue(a.ws);
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: transitionLeaseA }), {
      state: 'closed', reason: 'rollback-closed',
    });
    const rollbackGeneration = canaryRouter.getTerminalResourcePolicyCanaryState(TARGET_A).policyGeneration;
    assert.ok(rollbackGeneration > transitionGeneration);
    const ledger = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: transitionLeaseA });
    const exactGeneratedEvents = 1 + initial.capacity + 3 + 1 + 1 + 3;
    const expectedTotalEvents = beforeSelection.totalEvents + exactGeneratedEvents;
    const expectedLastSequence = beforeSelectionLastSequence + exactGeneratedEvents;
    assert.equal(ledger.totalEvents, expectedTotalEvents,
      'selection, capacity+K admissions, rejection, transition and rollback emit an exact event count');
    assert.equal(ledger.totalEvents, afterTransition.totalEvents + 3,
      'rollback contributes exactly requested, draining and closed events');
    assert.equal(ledger.entries.length, ledger.capacity);
    assert.equal(ledger.droppedEntries, Math.max(0, expectedTotalEvents - ledger.capacity));
    assert.equal(ledger.entries.at(-1)!.sequence, expectedLastSequence);
    assert.deepEqual(
      ledger.entries.map(entry => entry.sequence),
      Array.from({ length: ledger.capacity }, (_, index) => expectedLastSequence - ledger.capacity + 1 + index),
      'the retained ledger is the exact bounded suffix of generated target-A events',
    );
    assert.ok(ledger.entries.some(entry => entry.accepted));
    assert.ok(ledger.entries.some(entry => !entry.accepted));
    const events = new Set(ledger.entries.map(entry => entry.event));
    for (const requiredEvent of [
      'candidate-selected', 'admission-accepted', 'admission-rejected',
      'rollback-requested', 'rollback-draining', 'rollback-closed',
    ]) assert.equal(events.has(requiredEvent), true, `ledger must retain ${requiredEvent}`);
    const transitionEntry = ledger.entries.find(entry => entry.event === 'candidate-selected' && entry.nextEffectiveDecision === 900_000);
    assert.ok(transitionEntry);
    assert.equal(transitionEntry.previousEffectiveDecision, 1_000_000);
    assert.equal(transitionEntry.policyGeneration, transitionGeneration);
    assert.equal(transitionEntry.policyId, 'test-only-wave3-reviewed');
    assert.equal(transitionEntry.profileVersion, '1.0.0');
    assert.equal(transitionEntry.accepted, true);
    assert.equal(transitionEntry.reason, 'candidate-selected');
    assert.equal(transitionEntry.rollbackResult, null);
    const closedEntry = ledger.entries.find(entry => entry.event === 'rollback-closed');
    assert.ok(closedEntry);
    assert.equal(closedEntry.previousEffectiveDecision, 900_000);
    assert.equal(closedEntry.nextEffectiveDecision, currentWsConsumerLimit(router));
    assert.equal(closedEntry.policyGeneration, rollbackGeneration);
    assert.equal(closedEntry.rollbackResult, 'closed');
    assert.equal(closedEntry.accepted, true);
    assert.equal(Object.isFrozen(ledger), true, 'ledger snapshot must be read-only');
    assert.equal(Object.isFrozen(ledger.entries), true, 'ledger must be read-only');
    assert.equal(ledger.entries.every(entry => Object.isFrozen(entry)), true, 'ledger entries must be read-only');
    const allowedLedgerKeys = [
      'accepted', 'consumer', 'event', 'nextEffectiveDecision', 'policyGeneration', 'policyId',
      'previousEffectiveDecision', 'profileVersion', 'reason', 'resource', 'rollbackResult', 'sequence', 'target',
    ].sort();
    for (const entry of ledger.entries) {
      assert.deepEqual(Object.keys(entry).sort(), allowedLedgerKeys, 'ledger uses a payload-free exact allowlist');
      assert.equal(entry.resource, WS_RESOURCE);
      assert.equal(entry.consumer, WS_CONSUMER);
      assert.deepEqual(entry.target, TARGET_A);
      assert.equal(Object.isFrozen(entry.target), true, 'nested target identity must be immutable');
      assert.equal(typeof entry.policyGeneration, 'number');
      assert.equal(entry.policyId, 'test-only-wave3-reviewed');
      assert.equal(entry.profileVersion, '1.0.0');
      assert.equal(typeof entry.previousEffectiveDecision, 'number');
      assert.equal(typeof entry.nextEffectiveDecision, 'number');
      assert.equal(typeof entry.accepted, 'boolean');
      assert.equal(typeof entry.reason, 'string');
      assert.equal(entry.rollbackResult === null || typeof entry.rollbackResult === 'string', true);
      if (entry.event === 'admission-accepted') {
        assert.equal(entry.policyGeneration, initialCandidateGeneration);
        assert.equal(entry.previousEffectiveDecision, 1_000_000);
        assert.equal(entry.nextEffectiveDecision, 1_000_000);
        assert.equal(entry.accepted, true);
        assert.equal(entry.reason, 'candidate-admission-accepted');
        assert.equal(entry.rollbackResult, null);
      } else if (entry.event === 'admission-rejected') {
        assert.equal(entry.policyGeneration, initialCandidateGeneration);
        assert.equal(entry.previousEffectiveDecision, 1_000_000);
        assert.equal(entry.nextEffectiveDecision, 1_000_000);
        assert.equal(entry.accepted, false);
        assert.equal(entry.reason, 'tampered-message-byte-length');
        assert.equal(entry.rollbackResult, null);
      } else if (entry.event === 'candidate-selected') {
        assert.equal(entry.policyGeneration, transitionGeneration);
        assert.equal(entry.previousEffectiveDecision, 1_000_000);
        assert.equal(entry.nextEffectiveDecision, 900_000);
        assert.equal(entry.accepted, true);
        assert.equal(entry.reason, 'candidate-selected');
        assert.equal(entry.rollbackResult, null);
      } else if (entry.event === 'rollback-requested') {
        assert.equal(entry.policyGeneration, rollbackGeneration);
        assert.equal(entry.previousEffectiveDecision, 900_000);
        assert.equal(entry.nextEffectiveDecision, currentWsConsumerLimit(router));
        assert.equal(entry.accepted, true);
        assert.equal(entry.reason, 'rollback-requested');
        assert.equal(entry.rollbackResult, 'requested');
      } else if (entry.event === 'rollback-draining') {
        assert.equal(entry.policyGeneration, rollbackGeneration);
        assert.equal(entry.previousEffectiveDecision, 900_000);
        assert.equal(entry.nextEffectiveDecision, currentWsConsumerLimit(router));
        assert.equal(entry.accepted, true);
        assert.equal(entry.reason, 'rollback-draining');
        assert.equal(entry.rollbackResult, 'draining');
      } else if (entry.event === 'rollback-closed') {
        assert.equal(entry.policyGeneration, rollbackGeneration);
        assert.equal(entry.previousEffectiveDecision, 900_000);
        assert.equal(entry.nextEffectiveDecision, currentWsConsumerLimit(router));
        assert.equal(entry.accepted, true);
        assert.equal(entry.reason, 'rollback-closed');
        assert.equal(entry.rollbackResult, 'closed');
      } else {
        assert.fail(`unexpected ledger event ${entry.event}`);
      }
    }
    const immutableReason = ledger.entries[0].reason;
    assert.throws(() => { (ledger.entries[0] as { reason: string }).reason = 'mutated'; }, TypeError);
    assert.equal(ledger.entries[0].reason, immutableReason);
    assert.deepEqual(api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: leaseB }), bBefore);
  } finally {
    router.destroy();
  }
});

test('Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-5', async () => {
  assert.equal(MODULE_PRESENT, true, signature(5));
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const headlessIncreaseProfile = profile({ [HEADLESS_RESOURCE]: 8_389_632 });
  const headlessDecreaseProfile = profile({ [HEADLESS_RESOURCE]: 8 });
  const wsAProfile = profile({ [WS_RESOURCE]: 8192 });
  const wsBProfile = profile({ [WS_RESOURCE]: 12_288 });
  const authority = createTrustedAuthority(module, [
    headlessIncreaseProfile,
    headlessDecreaseProfile,
    wsAProfile,
    wsBProfile,
  ]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(authority, { spawnPty: pty.spawnPty });
  const a = createFakeWs();
  const b = createFakeWs();
  const otherTarget: HeadlessTarget = { kind: 'headless', sessionId: 'session-other' };
  try {
    subscribe(router, a.ws, TARGET_A.clientId, ['session-a1', 'session-a2']);
    subscribe(router, b.ws, TARGET_B.clientId, ['session-b1']);
    router.routeSessionOutput('session-a1', 'queued-before-batch-a');
    router.routeSessionOutput('session-b1', 'queued-before-batch-b');
    const oldHeadless: ActualHeadlessSeed[] = [
      { rawData: 'old-headless-A', queuedAt: 10, expiresAt: 10_000, ready: false, recoveryGeneration: 1, exactlyOnceKey: 'h-a', policyGeneration: 1 },
      { rawData: 'old-headless-한', queuedAt: 11, expiresAt: 10_001, ready: true, recoveryGeneration: 1, exactlyOnceKey: 'h-b', policyGeneration: 1 },
      { rawData: 'old-headless-😀', queuedAt: 12, expiresAt: 10_002, ready: true, recoveryGeneration: 2, exactlyOnceKey: 'h-c', policyGeneration: 2 },
    ];
    const actualHeadlessState = initializeActualHeadlessSession(manager, HEADLESS_A, oldHeadless);
    initializeActualHeadlessSession(manager, otherTarget, [{
      rawData: 'other', queuedAt: 1, expiresAt: 20_000, ready: true,
      recoveryGeneration: 1, exactlyOnceKey: 'other', policyGeneration: 1,
    }]);
    (router as unknown as { restoreAuthorityRetryKeys: Set<string> })
      .restoreAuthorityRetryKeys.add('session-a1:batch-authority-probe');
    const api = runtimeApi(store);
    assert.equal(typeof api.issueTerminalResourcePolicyLease, 'function', signature(5));
    assert.equal(typeof api.applyTerminalResourcePolicyLease, 'function', signature(5));
    assert.equal(typeof api.rollbackTerminalResourcePolicyLease, 'function', signature(5));
    assert.equal(typeof api.applyTerminalResourcePolicyLeaseBatch, 'function', signature(5));
    assert.equal(typeof api.getTerminalResourcePolicyCanaryLedger, 'function', signature(5));
    assert.equal(typeof api.previewHeadlessTerminalResourcePolicyAdmission, 'function', signature(5));
    assert.equal(typeof api.admitHeadlessTerminalResourcePolicyData, 'function', signature(5));
    for (const fixture of [
      {
        contractId: headlessIncreaseProfile.contractId,
        resource: HEADLESS_RESOURCE, consumer: WS_CONSUMER,
        capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
        reason: 'resource-consumer-mismatch',
      },
      {
        contractId: 'unsupported-profile',
        resource: HEADLESS_RESOURCE, consumer: HEADLESS_CONSUMER,
        capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
        reason: 'candidate-unavailable',
      },
      {
        contractId: headlessIncreaseProfile.contractId,
        resource: HEADLESS_RESOURCE, consumer: HEADLESS_CONSUMER,
        capability: undefined, reason: 'capability-missing',
      },
      {
        contractId: headlessIncreaseProfile.contractId,
        resource: HEADLESS_RESOURCE, consumer: HEADLESS_CONSUMER,
        capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/stale' },
        reason: 'compiler-schema-mismatch',
      },
    ] as const) {
      const failed = api.issueTerminalResourcePolicyLease!({
        contractId: fixture.contractId,
        target: HEADLESS_A, selectedTarget: HEADLESS_A,
        resource: fixture.resource, consumer: fixture.consumer,
        capability: fixture.capability,
      });
      assert.equal(failed.mode, 'legacy');
      assert.equal(failed.reason, fixture.reason);
      assert.equal(failed.lease, undefined);
    }
    const oldEntries = readActualHeadlessEntries(manager, HEADLESS_A);
    const oldHash = createHash('sha256').update(JSON.stringify(oldEntries)).digest('hex');
    const oldQueueIdentity = actualHeadlessState.headlessOutputQueue;
    const oldQueueTelemetry = oldQueueIdentity.snapshot();
    const otherBefore = readActualHeadlessEntries(manager, otherTarget);
    const legacyHeadlessLimit = currentHeadlessConsumerLimit(manager);
    assert.equal(legacyHeadlessLimit, 8_388_608, 'SessionManager is the authoritative headless consumer limit');
    const increasedHeadlessLimit = legacyHeadlessLimit + 1024;
    assert.equal(increasedHeadlessLimit, headlessIncreaseProfile.resources[HEADLESS_RESOURCE]);
    const headlessIncrease = issueHeadlessLease(api, headlessIncreaseProfile);
    const headlessDecrease = issueHeadlessLease(api, headlessDecreaseProfile);
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: headlessIncrease }), {
      mode: 'candidate', reason: 'candidate-selected', previousEffectiveDecision: legacyHeadlessLimit, nextEffectiveDecision: increasedHeadlessLimit,
    });
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: headlessDecrease }), {
      mode: 'candidate', reason: 'candidate-selected', previousEffectiveDecision: increasedHeadlessLimit, nextEffectiveDecision: 8,
    });
    assert.equal(currentHeadlessConsumerLimit(manager), legacyHeadlessLimit,
      'a target-scoped headless canary must not mutate the global runtime queue policy');
    assert.equal(createHash('sha256').update(JSON.stringify(readActualHeadlessEntries(manager, HEADLESS_A))).digest('hex'), oldHash);
    const raw = 'raw-PTY-한😀';
    const headlessWriteChainBefore = actualHeadlessState.headlessWriteChain;
    const forgedHeadlessLease = { ...headlessDecrease } as PolicyLease;
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: forgedHeadlessLease, rawData: raw,
    }), {
      accepted: false, mode: 'legacy', reason: 'invalid-policy-lease',
    }, 'headless preview must reject a structurally forged lease');
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: headlessDecrease, rawData: raw,
    }), {
      resource: HEADLESS_RESOURCE,
      consumer: HEADLESS_CONSUMER,
      target: HEADLESS_A,
      rawUtf8Bytes: Buffer.byteLength(raw, 'utf8'),
    });
    const admittedHeadless = api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease: headlessDecrease, rawData: raw,
    });
    assert.deepEqual({
      accepted: admittedHeadless.accepted,
      mode: admittedHeadless.mode,
      reason: admittedHeadless.reason,
      enqueuedExactlyOnce: admittedHeadless.enqueuedExactlyOnce,
    }, {
      accepted: true, mode: 'legacy', reason: 'candidate-cap-exceeded-fallback', enqueuedExactlyOnce: true,
    });
    const actualAfterAdmission = readActualHeadlessEntries(manager, HEADLESS_A);
    assert.equal(actualAfterAdmission.length, oldEntries.length + 1);
    assert.equal(actualAfterAdmission.at(-1)?.data, raw);
    assert.equal(actualAfterAdmission.at(-1)?.byteLength, Buffer.byteLength(raw, 'utf8'));
    assert.equal(actualAfterAdmission.at(-1)?.policyGeneration, admittedHeadless.policyGeneration);
    assert.equal(
      createHash('sha256').update(JSON.stringify(actualAfterAdmission.slice(0, oldEntries.length))).digest('hex'),
      oldHash,
      'old actual SessionManager entries retain bytes/lifetime/order/recovery metadata',
    );
    assert.notEqual(actualHeadlessState.headlessWriteChain, headlessWriteChainBefore,
      'headless canary admission must reserve the actual parser/write chain');
    const actualQueueSnapshot = actualHeadlessState.headlessOutputQueue.snapshot();
    assert.equal(actualHeadlessState.headlessOutputQueue, oldQueueIdentity,
      'candidate admission preserves the live queue object and its existing entry lifetimes');
    assert.equal(actualQueueSnapshot.overflowCount, oldQueueTelemetry.overflowCount);
    assert.equal(actualQueueSnapshot.degradedCount, oldQueueTelemetry.degradedCount);
    const expectedPendingBytes = actualAfterAdmission.reduce((sum, entry) => sum + entry.byteLength, 0);
    assert.equal(actualQueueSnapshot.pendingChunks, actualAfterAdmission.length,
      'admission must append to the actual SessionManager headlessOutputQueue exactly once');
    assert.equal(actualQueueSnapshot.pendingBytes, expectedPendingBytes);
    assert.equal(actualHeadlessState.pendingHeadlessOutputBytes, expectedPendingBytes);
    assert.deepEqual(readActualHeadlessEntries(manager, otherTarget), otherBefore);
    await actualHeadlessState.headlessWriteChain;
    assert.equal(actualHeadlessState.pendingHeadlessWrites, 0,
      'the admitted write-chain settles before the independent batch atomicity baseline');

    assert.equal(wsAProfile.resources[WS_RESOURCE], currentWsConsumerLimit(router) * 2);
    const wsLease = issueWsLease(api, wsAProfile);
    const headlessLedgerBeforeWsApply = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: headlessDecrease,
    });
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: wsLease });
    assert.deepEqual(
      api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease: headlessDecrease }),
      headlessLedgerBeforeWsApply,
      'WS-only lease must call the headless adapter zero times',
    );
    a.setBufferedAmount(0);
    (router as unknown as { flushTransportQueue(ws: typeof a.ws): void }).flushTransportQueue(a.ws);
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: wsLease,
    }), { state: 'closed', reason: 'rollback-closed' });
    type CanaryRouterState = {
      getTerminalResourcePolicyCanaryState(target: WsTarget): {
        mode: 'candidate' | 'legacy';
        policyGeneration: number;
        effectiveDecision: number;
        queuedBytes: number;
        legacyAdmissionCount: number;
        rollbackState: 'inactive' | 'draining' | 'closed';
        ledgerHash: string;
        cleanup: { targetHandles: number; listeners: number; timers: number };
      };
    };
    const canaryRouter = router as unknown as Partial<CanaryRouterState>;
    assert.equal(typeof canaryRouter.getTerminalResourcePolicyCanaryState, 'function', signature(5));
    const leaseB = issueWsLease(api, wsBProfile, TARGET_B);
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: leaseB });
    const bPolicyBefore = canaryRouter.getTerminalResourcePolicyCanaryState!(TARGET_B);
    const missingTarget: HeadlessTarget = { kind: 'headless', sessionId: 'missing-session' };
    const missingDecision = api.issueTerminalResourcePolicyLease!({
      contractId: headlessIncreaseProfile.contractId,
      target: missingTarget,
      selectedTarget: missingTarget,
      resource: HEADLESS_RESOURCE,
      consumer: HEADLESS_CONSUMER,
      capability: { version: REQUIRED_CAPABILITY_VERSION, compilerSchemaVersion: 'terminal-resource-policy/v1' },
    });
    assert.equal(missingDecision.mode, 'candidate');
    assert.ok(missingDecision.lease);
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: missingDecision.lease, rawData: 'missing',
    }), {
      accepted: false, mode: 'legacy', reason: 'headless-target-missing',
    });
    const missingLedgerBefore = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: missingDecision.lease,
    });
    const batchWsLease = issueWsLease(api, wsAProfile);
    const batchProtectedBefore = protectedRuntimeState(
      router, manager, [a.ws, b.ws], { includeCanaryTargets: false },
    );
    const batchTargetABefore = structuredClone(canaryRouter.getTerminalResourcePolicyCanaryState!(TARGET_A));
    const batchLedgerBefore = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: batchWsLease,
    });
    const batchEffectiveBefore = {
      ws: structuredClone((router as unknown as { runtimeSendPolicyConfig: unknown }).runtimeSendPolicyConfig),
      headless: structuredClone((manager as unknown as { runtimeHeadlessQueueConfig: unknown }).runtimeHeadlessQueueConfig),
      registries: runtimeCanaryRegistrySizes(store),
    };
    assert.deepEqual(api.applyTerminalResourcePolicyLeaseBatch!({
      wsRouter: router, sessionManager: manager, leases: [batchWsLease, missingDecision.lease],
    }), {
      mode: 'legacy', reason: 'adapter-transition-failed',
      appliedConsumers: [WS_CONSUMER],
      rolledBackConsumers: [WS_CONSUMER],
    });
    assert.equal(protectedRuntimeState(
      router, manager, [a.ws, b.ws], { includeCanaryTargets: false },
    ), batchProtectedBefore,
    'actual effective configs, queues, PTY producer, connections and authority are atomic across adapter failure');
    const batchTargetAAfter = canaryRouter.getTerminalResourcePolicyCanaryState!(TARGET_A);
    assert.deepEqual({
      mode: batchTargetAAfter.mode,
      effectiveDecision: batchTargetAAfter.effectiveDecision,
      queuedBytes: batchTargetAAfter.queuedBytes,
      legacyAdmissionCount: batchTargetAAfter.legacyAdmissionCount,
      rollbackState: batchTargetAAfter.rollbackState,
      cleanup: batchTargetAAfter.cleanup,
    }, {
      mode: batchTargetABefore.mode,
      effectiveDecision: batchTargetABefore.effectiveDecision,
      queuedBytes: batchTargetABefore.queuedBytes,
      legacyAdmissionCount: batchTargetABefore.legacyAdmissionCount,
      rollbackState: 'closed',
      cleanup: batchTargetABefore.cleanup,
    }, 'the failed batch restores target-A effective decision, admission state and cleanup without rewinding history');
    assert.ok(batchTargetAAfter.policyGeneration > batchTargetABefore.policyGeneration,
      'applied then rolled-back transitions keep policy generation monotonic');
    assert.notEqual(batchTargetAAfter.ledgerHash, batchTargetABefore.ledgerHash,
      'the bounded ledger retains the auditable failed-batch transition');
    const batchLedgerAfter = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: batchWsLease,
    });
    assert.equal(batchLedgerAfter.totalEvents, batchLedgerBefore.totalEvents + 4,
      'applied first adapter plus requested/draining/closed rollback emit exactly four events');
    assert.deepEqual(batchLedgerAfter.entries.slice(-4).map(entry => entry.event), [
      'candidate-selected', 'rollback-requested', 'rollback-draining', 'rollback-closed',
    ]);
    const batchSelectionGeneration = batchLedgerAfter.entries.at(-4)!.policyGeneration;
    assert.ok(batchSelectionGeneration > batchTargetABefore.policyGeneration);
    assert.ok(batchTargetAAfter.policyGeneration > batchSelectionGeneration);
    assert.deepEqual(batchLedgerAfter.entries.slice(-4).map(entry => entry.policyGeneration), [
      batchSelectionGeneration,
      batchTargetAAfter.policyGeneration,
      batchTargetAAfter.policyGeneration,
      batchTargetAAfter.policyGeneration,
    ]);
    const missingLedgerAfter = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: missingDecision.lease,
    });
    assert.equal(Object.isFrozen(missingLedgerAfter), true);
    assert.equal(Object.isFrozen(missingLedgerAfter.entries), true);
    assert.equal(missingLedgerAfter.totalEvents, missingLedgerBefore.totalEvents + 1,
      'the failing headless adapter emits exactly one auditable rejection event');
    const missingEntry = missingLedgerAfter.entries.at(-1)!;
    assert.equal(Object.isFrozen(missingEntry), true);
    assert.equal(Object.isFrozen(missingEntry.target), true);
    assert.deepEqual(Object.keys(missingEntry).sort(), [
      'accepted', 'consumer', 'event', 'nextEffectiveDecision', 'policyGeneration', 'policyId',
      'previousEffectiveDecision', 'profileVersion', 'reason', 'resource', 'rollbackResult', 'sequence', 'target',
    ]);
    assert.deepEqual({
      event: missingEntry.event,
      resource: missingEntry.resource,
      consumer: missingEntry.consumer,
      target: missingEntry.target,
      sequence: missingEntry.sequence,
      policyGeneration: missingEntry.policyGeneration,
      policyId: missingEntry.policyId,
      profileVersion: missingEntry.profileVersion,
      previousEffectiveDecision: missingEntry.previousEffectiveDecision,
      nextEffectiveDecision: missingEntry.nextEffectiveDecision,
      accepted: missingEntry.accepted,
      reason: missingEntry.reason,
      rollbackResult: missingEntry.rollbackResult,
    }, {
      event: 'adapter-transition-rejected',
      resource: HEADLESS_RESOURCE,
      consumer: HEADLESS_CONSUMER,
      target: missingTarget,
      sequence: missingLedgerBefore.totalEvents + 1,
      policyGeneration: 0,
      policyId: headlessIncreaseProfile.policyId,
      profileVersion: headlessIncreaseProfile.profileVersion,
      previousEffectiveDecision: legacyHeadlessLimit,
      nextEffectiveDecision: increasedHeadlessLimit,
      accepted: false,
      reason: 'headless-target-missing',
      rollbackResult: 'not-applied',
    }, 'missing headless target rejection is payload-free and identifies the exact adapter decision');
    assert.deepEqual({
      ws: (router as unknown as { runtimeSendPolicyConfig: unknown }).runtimeSendPolicyConfig,
      headless: (manager as unknown as { runtimeHeadlessQueueConfig: unknown }).runtimeHeadlessQueueConfig,
      registries: runtimeCanaryRegistrySizes(store),
    }, batchEffectiveBefore, 'batch rollback restores the actual authoritative consumer configurations exactly');
    assert.deepEqual(canaryRouter.getTerminalResourcePolicyCanaryState!(TARGET_B), bPolicyBefore,
      'a failing target cannot change another target policy generation/ledger');
    assert.equal(
      (manager as unknown as { sessions: Map<string, unknown> }).sessions.has(missingTarget.sessionId),
      false,
      'failed headless adapter cannot synthesize a missing session',
    );
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: headlessDecrease,
    }), { state: 'closed', reason: 'rollback-closed' });
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: headlessDecrease, rawData: 'revoked',
    }), {
      accepted: false, mode: 'legacy', reason: 'lease-revoked',
    });
    assert.deepEqual(readActualHeadlessEntries(manager, otherTarget), otherBefore);
  } finally {
    manager.deleteSession(HEADLESS_A.sessionId);
    manager.deleteSession(otherTarget.sessionId);
    router.destroy();
  }
});

test('REL-BGSTAB-010 headless finalizer revokes the old epoch and isolates same-ID recreation', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const headlessProfile = profile({ [HEADLESS_RESOURCE]: 1_048_576 }, ':finalize-recreate');
  const storeAuthority = createTrustedAuthority(module, [headlessProfile]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(undefined, {
    storeAuthority,
    spawnPty: pty.spawnPty,
  });
  const api = runtimeApi(store as RuntimeConfigStore);
  try {
    // The store owns the lease authority while SessionManager intentionally has no matching authority.
    manager.updateRuntimeConfig({ processCleanup: { mode: 'legacy' } });
    const oldState = initializeActualHeadlessSession(manager, HEADLESS_A, []);
    const oldLease = issueHeadlessLease(api, headlessProfile);
    const spareOldLease = issueHeadlessLease(api, headlessProfile);
    const oldMetadata = storeAuthority.getLeaseMetadata(spareOldLease);
    assert.ok(oldMetadata);
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: oldLease,
    }), {
      mode: 'candidate', reason: 'candidate-selected',
      previousEffectiveDecision: currentHeadlessConsumerLimit(manager),
      nextEffectiveDecision: 1_048_576,
    });
    assert.deepEqual(runtimeCanaryRegistrySizes(store), {
      targetHandles: 1, listeners: 2, timers: 0, retainedEntries: 1,
    }, 'headless canary audit registries are connected to the live target and lifecycle listener');

    assert.equal(manager.deleteSession(HEADLESS_A.sessionId), true,
      'the public delete path must invoke the real SessionManager finalizer');
    assert.equal(oldState.finalized, true);
    assert.equal(oldState.pty.kills, 1);
    assert.equal(manager.hasTerminalResourcePolicyHeadlessTarget(HEADLESS_A.sessionId), false);
    assert.deepEqual(runtimeCanaryRegistrySizes(store), {
      targetHandles: 0, listeners: 2, timers: 0, retainedEntries: 0,
    }, 'the real finalizer cleans target and retained-state handles while keeping the manager listener');
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: oldLease, rawData: 'stale-after-delete',
    }), { accepted: false, mode: 'legacy', reason: 'lease-revoked' });
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: spareOldLease, rawData: 'stale-spare-after-delete',
    }), { accepted: false, mode: 'legacy', reason: 'lease-revoked' });
    assert.equal(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: oldLease,
    }).totalEvents, 0, 'finalization removes the old target-scoped canary state and ledger');

    initializeActualHeadlessSession(manager, HEADLESS_A, []);
    const freshLease = issueHeadlessLease(api, headlessProfile);
    const freshMetadata = storeAuthority.getLeaseMetadata(freshLease);
    assert.ok(freshMetadata);
    assert.ok(freshMetadata.targetEpoch > oldMetadata.targetEpoch,
      'same-ID recreation starts in a new issuer epoch');
    assert.deepEqual(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: freshLease,
    }), {
      mode: 'candidate', reason: 'candidate-selected',
      previousEffectiveDecision: currentHeadlessConsumerLimit(manager),
      nextEffectiveDecision: 1_048_576,
    });
    const freshLedger = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: freshLease,
    });
    assert.deepEqual(freshLedger.entries.map(entry => entry.event), ['candidate-selected']);
    assert.deepEqual(api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease: oldLease, rawData: 'old-epoch-cannot-cross-recreation',
    }), {
      accepted: false, mode: 'legacy', reason: 'lease-revoked',
      enqueuedExactlyOnce: false, policyGeneration: 0,
    });
  } finally {
    manager.deleteSession(HEADLESS_A.sessionId);
    router.destroy();
  }
});

test('REL-BGSTAB-010 headless maxChunks admits exact N and rejects N+1 without bypass', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const headlessProfile = profile({ [HEADLESS_RESOURCE]: 1_048_576 }, ':chunk-boundary');
  const authority = createTrustedAuthority(module, [headlessProfile]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(authority, { spawnPty: pty.spawnPty });
  const api = runtimeApi(store);
  let state: ActualHeadlessSessionState | undefined;
  let gatedWrites: GatedHeadlessWrites | undefined;
  try {
    const limits = (manager as unknown as {
      runtimeHeadlessQueueConfig: { limits: { pendingOutputMaxChunks: number } };
    }).runtimeHeadlessQueueConfig.limits;
    limits.pendingOutputMaxChunks = 2;
    state = initializeActualHeadlessSession(manager, HEADLESS_A, []);
    gatedWrites = enableGatedHeadlessWrites(state) as GatedHeadlessWrites;
    const lease = issueHeadlessLease(api, headlessProfile);
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease });

    const atOne = api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease, rawData: 'chunk-1',
    });
    assert.equal(atOne.accepted, true, 'the first chunk is admitted through the actual session path');
    const atN = api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease, rawData: 'chunk-2',
    });
    assert.equal(atN.accepted, true, 'the exact Nth chunk is admitted');
    await waitForFixtureCondition(
      () => gatedWrites!.pendingCallbacks === 1,
      'the actual first headless write must be held before capacity is asserted',
      1_250,
    );
    assert.equal(state.pendingHeadlessOutputs.size, 2);
    assert.equal(state.headlessOutputQueue.snapshot().pendingChunks, 2);
    const entriesAtN = readActualHeadlessEntries(manager, HEADLESS_A);

    const overN = api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease, rawData: 'chunk-3-must-not-bypass',
    });
    assert.deepEqual(overN, {
      accepted: false,
      mode: 'legacy',
      reason: 'legacy-headless-chunk-limit',
      enqueuedExactlyOnce: false,
      policyGeneration: atN.policyGeneration,
    });
    assert.deepEqual(readActualHeadlessEntries(manager, HEADLESS_A), entriesAtN,
      'N+1 rejection cannot mutate or bypass the actual pending-output map');
    assert.equal(state.headlessOutputQueue.snapshot().pendingChunks, 2);
    const ledger = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease });
    const rejection = [...ledger.entries].reverse().find(entry => entry.event === 'admission-rejected')!;
    assert.deepEqual({
      event: rejection.event, accepted: rejection.accepted, reason: rejection.reason,
    }, {
      event: 'admission-rejected', accepted: false, reason: 'legacy-headless-chunk-limit',
    }, 'the payload-free ledger records the truthful chunk-limit reason');
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease, rawData: 'after-policy-failure',
    }), { accepted: false, mode: 'legacy', reason: 'lease-revoked' },
    'an active candidate admission failure immediately fences and revokes the failed target');
    assert.deepEqual(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.slice(-3).map(entry => entry.event), [
      'admission-rejected', 'rollback-requested', 'rollback-draining',
    ]);
    gatedWrites.dispose();
    await state.headlessWriteChain;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.slice(-4).map(entry => entry.event), [
      'admission-rejected', 'rollback-requested', 'rollback-draining', 'rollback-closed',
    ]);
  } finally {
    gatedWrites?.dispose();
    if (state) await state.headlessWriteChain;
    manager.deleteSession(HEADLESS_A.sessionId);
    router.destroy();
  }
});

test('REL-BGSTAB-010 headless write failure settles the candidate to target-scoped legacy recovery', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const headlessProfile = profile({ [HEADLESS_RESOURCE]: 2048 }, ':write-failure-settlement');
  const authority = createTrustedAuthority(module, [headlessProfile]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(authority, {
    headlessOutputMaxBytes: 1024,
    spawnPty: pty.spawnPty,
  });
  const api = runtimeApi(store);
  const otherTarget: HeadlessTarget = { kind: 'headless', sessionId: 'session-write-failure-other' };
  let restoreHeadlessWrite: (() => void) | undefined;
  try {
    const state = initializeActualHeadlessSession(manager, HEADLESS_A, []);
    const otherState = initializeActualHeadlessSession(manager, otherTarget, []);
    const terminal = (state as unknown as {
      headless: {
        terminal: { write(data: string, callback: () => void): void; dispose(): void };
      };
    }).headless.terminal;
    const originalWrite = terminal.write;
    terminal.write = () => { throw new Error('simulated headless write failure'); };
    restoreHeadlessWrite = () => { terminal.write = originalWrite; };
    const lease = issueHeadlessLease(api, headlessProfile);
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease });
    const globalLimitBefore = currentHeadlessConsumerLimit(manager);
    const otherBefore = {
      entries: readActualHeadlessEntries(manager, otherTarget),
      health: otherState.headlessHealth,
      pendingBytes: otherState.pendingHeadlessOutputBytes,
    };
    const admitted = api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease, rawData: 'accepted-before-write-failure',
    });
    assert.equal(admitted.accepted, true);
    await state.headlessWriteChain;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state.headlessHealth, 'degraded',
      'write failure follows the existing reliable degraded-recovery path');
    assert.ok(state.degradedReplayBuffer.includes('accepted-before-write-failure'));
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease, rawData: 'must-be-fenced',
    }), { accepted: false, mode: 'legacy', reason: 'lease-revoked' });
    assert.equal(currentHeadlessConsumerLimit(manager), globalLimitBefore);
    assert.deepEqual({
      entries: readActualHeadlessEntries(manager, otherTarget),
      health: otherState.headlessHealth,
      pendingBytes: otherState.pendingHeadlessOutputBytes,
    }, otherBefore, 'failure settlement is target-scoped');
    const ledger = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease });
    assert.deepEqual(ledger.entries.slice(-3).map(entry => entry.event), [
      'rollback-requested', 'rollback-draining', 'rollback-closed',
    ]);
    assert.equal(ledger.entries.at(-3)?.reason, 'headless-write-failed');
  } finally {
    restoreHeadlessWrite?.();
    manager.deleteSession(HEADLESS_A.sessionId);
    manager.deleteSession(otherTarget.sessionId);
    router.destroy();
  }
});

test('REL-BGSTAB-010 valid but inactive leases cannot preview admit or rollback active WS and headless targets', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const wsProfile = profile({ [WS_RESOURCE]: 8192 }, ':active-provenance-ws');
  const headlessProfile = profile({ [HEADLESS_RESOURCE]: 2048 }, ':active-provenance-headless');
  const authority = createTrustedAuthority(module, [wsProfile, headlessProfile]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(authority, {
    headlessOutputMaxBytes: 1024,
    spawnPty: pty.spawnPty,
  });
  const fixtureObserver = observeActualHeadlessSessionCreation(manager);
  const api = runtimeApi(store);
  const socket = createFakeWs();
  try {
    subscribe(router, socket.ws, TARGET_A.clientId, ['session-a1']);
    const headlessState = initializeActualHeadlessSession(manager, HEADLESS_A, []);
    assert.deepEqual({
      creates: fixtureObserver.createCount,
      spawns: pty.spawnCount,
      onDataRegistrations: pty.onDataRegistrationCount,
    }, {
      creates: 1,
      spawns: 1,
      onDataRegistrations: 1,
    }, 'inactive-lease headless fixture must use one public SessionManager creation with deterministic PTY registration');
    fixtureObserver.assertFixtureState(HEADLESS_A.sessionId, headlessState);
    assertCompleteHeadlessAuthorityFixture(headlessState, 'inactive-lease headless fixture');
    const neverActiveWs = issueWsLease(api, wsProfile);
    const neverActiveHeadless = issueHeadlessLease(api, headlessProfile);
    const wsMessage = createWsTransportMessage({
      type: 'output', sessionId: 'session-a1', data: 'never-active',
    }, 100);
    const wsBefore = structuredClone((router as unknown as {
      getTerminalResourcePolicyCanaryState(target: WsTarget): unknown;
    }).getTerminalResourcePolicyCanaryState(TARGET_A));
    const headlessBefore = readActualHeadlessEntries(manager, HEADLESS_A);

    assert.equal(api.previewTerminalResourcePolicyCanaryAdmission!({
      wsRouter: router, lease: neverActiveWs, incomingMessage: wsMessage,
    }).reason, 'lease-not-active');
    assert.deepEqual(api.admitTerminalResourcePolicyCanaryMessage!({
      wsRouter: router, lease: neverActiveWs, incomingMessage: wsMessage,
    }), {
      ...api.previewTerminalResourcePolicyCanaryAdmission!({
        wsRouter: router, lease: neverActiveWs, incomingMessage: wsMessage,
      }),
      enqueuedExactlyOnce: false,
    });
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: neverActiveWs,
    }), { state: 'closed', reason: 'lease-not-active' });
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: neverActiveHeadless, rawData: 'never-active',
    }), { accepted: false, mode: 'legacy', reason: 'lease-not-active' });
    assert.deepEqual(api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease: neverActiveHeadless, rawData: 'never-active',
    }), {
      accepted: false, mode: 'legacy', reason: 'lease-not-active',
      enqueuedExactlyOnce: false, policyGeneration: 0,
    });
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: neverActiveHeadless,
    }), { state: 'closed', reason: 'lease-not-active' });
    assert.deepEqual((router as unknown as {
      getTerminalResourcePolicyCanaryState(target: WsTarget): unknown;
    }).getTerminalResourcePolicyCanaryState(TARGET_A), wsBefore);
    assert.deepEqual(readActualHeadlessEntries(manager, HEADLESS_A), headlessBefore);

    const activeWs = issueWsLease(api, wsProfile);
    const spareWs = issueWsLease(api, wsProfile);
    const activeHeadless = issueHeadlessLease(api, headlessProfile);
    const spareHeadless = issueHeadlessLease(api, headlessProfile);
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: activeWs });
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease: activeHeadless });
    const activeWsBefore = structuredClone((router as unknown as {
      getTerminalResourcePolicyCanaryState(target: WsTarget): unknown;
    }).getTerminalResourcePolicyCanaryState(TARGET_A));
    const activeHeadlessLedgerBefore = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: activeHeadless,
    });
    const queueBefore = queuedMessages(router, socket.ws);
    assert.equal(api.previewTerminalResourcePolicyCanaryAdmission!({
      wsRouter: router, lease: spareWs, incomingMessage: wsMessage,
    }).reason, 'lease-not-active');
    assert.equal(api.admitTerminalResourcePolicyCanaryMessage!({
      wsRouter: router, lease: spareWs, incomingMessage: wsMessage,
    }).reason, 'lease-not-active');
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: spareWs,
    }), { state: 'closed', reason: 'lease-not-active' });
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease: spareHeadless, rawData: 'spare',
    }), { accepted: false, mode: 'legacy', reason: 'lease-not-active' });
    assert.equal(api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease: spareHeadless, rawData: 'spare',
    }).reason, 'lease-not-active');
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: spareHeadless,
    }), { state: 'closed', reason: 'lease-not-active' });
    assert.deepEqual((router as unknown as {
      getTerminalResourcePolicyCanaryState(target: WsTarget): unknown;
    }).getTerminalResourcePolicyCanaryState(TARGET_A), activeWsBefore,
    'spare WS lease operations are state-preserving');
    assert.deepEqual(queuedMessages(router, socket.ws), queueBefore);
    assert.deepEqual(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: activeHeadless,
    }), activeHeadlessLedgerBefore, 'spare headless lease operations do not alter the active ledger');
    assert.equal(headlessState.headlessHealth, 'healthy');
  } finally {
    manager.deleteSession(HEADLESS_A.sessionId);
    router.destroy();
  }
});

test('REL-BGSTAB-010 production PTY path uses target-scoped non-destructive headless policy and restores legacy limit', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const legacyLimit = 1024;
  const candidateLimit = 2048;
  const headlessProfile = profile({ [HEADLESS_RESOURCE]: candidateLimit }, ':production-port');
  const authority = createTrustedAuthority(module, [headlessProfile]);
  const ptyDataHandlers: Array<(data: string) => void> = [];
  const spawnPty = (...args: unknown[]) => {
    const options = args[2] as { cols?: number; rows?: number };
    return {
      pid: 100 + ptyDataHandlers.length,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      process: 'bash',
      handleFlowControl: false,
      onData(callback: (data: string) => void) {
        ptyDataHandlers.push(callback);
        return { dispose() {} };
      },
      onExit() { return { dispose() {} }; },
      write() {},
      resize() {},
      kill() {},
    };
  };
  const { router, manager, store } = createHarness(authority, {
    headlessOutputMaxBytes: legacyLimit,
    spawnPty,
  });
  const api = runtimeApi(store);
  const otherTarget: HeadlessTarget = { kind: 'headless', sessionId: 'session-nonselected' };
  const emitPtyData = (index: number, data: string) => ptyDataHandlers[index]!(data);
  let selected: ActualHeadlessSessionState | undefined;
  let nonselected: ActualHeadlessSessionState | undefined;
  let selectedOriginalHeadless: { terminal: { dispose(): void } } | undefined;
  let nonselectedOriginalHeadless: { terminal: { dispose(): void } } | undefined;
  let selectedWrites: GatedHeadlessWrites | undefined;
  let nonselectedWrites: GatedHeadlessWrites | undefined;
  let bodyError: unknown;
  try {
    (manager as unknown as { isCommandAvailable(command: string): boolean })
      .isCommandAvailable = () => true;
    manager.createSession('selected-policy-session', 'bash', process.cwd(), {
      sessionId: HEADLESS_A.sessionId,
    });
    manager.createSession('nonselected-policy-session', 'bash', process.cwd(), {
      sessionId: otherTarget.sessionId,
    });
    assert.equal(ptyDataHandlers.length, 2,
      'real createSession must register one PTY onData handler per session');
    const sessions = (manager as unknown as { sessions: Map<string, ActualHeadlessSessionState> }).sessions;
    selected = sessions.get(HEADLESS_A.sessionId)!;
    nonselected = sessions.get(otherTarget.sessionId)!;
    selectedOriginalHeadless = (selected as unknown as {
      headless: { terminal: { dispose(): void } };
    }).headless;
    nonselectedOriginalHeadless = (nonselected as unknown as {
      headless: { terminal: { dispose(): void } };
    }).headless;
    selectedWrites = enableGatedHeadlessWrites(selected);
    nonselectedWrites = enableGatedHeadlessWrites(nonselected);
    const queueIdentity = selected.headlessOutputQueue;
    assert.equal(selected.headlessOutputQueue.enqueue('t'.repeat(legacyLimit + 1)).ok, false);
    selected.headlessOutputQueue.recordDegraded();
    const telemetryBefore = selected.headlessOutputQueue.snapshot();
    const lease = issueHeadlessLease(api, headlessProfile);
    assert.equal(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease,
    }).mode, 'candidate');

    emitPtyData(0, 'c'.repeat(700));
    await Promise.resolve();
    emitPtyData(0, 'd'.repeat(500));
    assert.equal(selected.headlessOutputQueue, queueIdentity,
      'candidate application cannot replace or reconstruct the live queue object');
    assert.equal(selected.pendingHeadlessOutputs.size, 2,
      'selected production PTY aggregate above legacy L is admitted by the candidate port');
    const candidateEntry = readActualHeadlessEntries(manager, HEADLESS_A)[0]!;
    assert.ok((candidateEntry.policyGeneration ?? 0) > 0,
      'actual PTY pending entry carries the selected policy generation');
    assert.equal(typeof candidateEntry.exactlyOnceKey, 'string');
    const telemetryAfterCandidate = selected.headlessOutputQueue.snapshot();
    assert.equal(telemetryAfterCandidate.overflowCount, telemetryBefore.overflowCount);
    assert.equal(telemetryAfterCandidate.degradedCount, telemetryBefore.degradedCount);
    assert.ok(telemetryAfterCandidate.maxPendingBytes >= 1200,
      'candidate override updates high-water telemetry without resetting prior counters');
    const candidateLedger = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease });
    assert.equal(candidateLedger.entries.at(-1)?.event, 'admission-accepted');
    assert.equal(candidateLedger.entries.at(-1)?.reason, 'candidate-admission-accepted');

    emitPtyData(0, 'f'.repeat(900));
    assert.equal(selected.pendingHeadlessOutputBytes, 2100,
      'active candidate overflow uses a separate legacy L budget while grandfathering candidate bytes');
    assert.equal(selected.headlessHealth, 'healthy');
    assert.equal(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.at(-1)?.reason, 'candidate-cap-exceeded-fallback');
    await drainGatedHeadlessWrites({
      state: selected,
      gatedWrites: selectedWrites,
      phase: 'production PTY candidate admission drain',
    });
    await assertHeadlessWriteChainSettles({
      state: selected,
      gatedWrites: selectedWrites,
      phase: 'production PTY candidate admission write chain',
    });
    assert.equal(selected.pendingHeadlessOutputBytes, 0);

    emitPtyData(0, 'c'.repeat(700));
    await Promise.resolve();
    emitPtyData(0, 'd'.repeat(500));
    assert.equal(selected.pendingHeadlessOutputBytes, 1200,
      'the exact rollback regression starts with a fresh 1200-byte candidate backlog');

    emitPtyData(1, 'n'.repeat(legacyLimit + 4));
    assert.equal(nonselected.pendingHeadlessOutputs.size, 0,
      'a nonselected session remains on the legacy L policy');
    assert.equal(nonselected.headlessHealth, 'degraded',
      'nonselected production PTY N+1 follows the existing legacy overflow path');

    assert.equal(selected.pendingHeadlessOutputBytes, 1200);
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease,
    }), { state: 'draining', reason: 'rollback-draining' });
    const rollbackGeneration = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.at(-1)!.policyGeneration;
    const entriesBeforeLegacyDuringDrain = readActualHeadlessEntries(manager, HEADLESS_A);
    emitPtyData(0, 'r');
    assert.equal(selected.pendingHeadlessOutputBytes, 1201,
      'rollback grandfathers the 1200-byte candidate backlog and admits new legacy data against its own L budget');
    assert.equal(selected.headlessHealth, 'healthy',
      'a valid legacy admission during rollback cannot degrade or clear the candidate backlog');
    assert.equal(selected.headlessOutputQueue, queueIdentity);
    const entriesDuringDrain = readActualHeadlessEntries(manager, HEADLESS_A);
    assert.deepEqual(entriesDuringDrain.slice(0, 2), entriesBeforeLegacyDuringDrain,
      'rollback admission preserves old queue identity, order, bytes and lifetime metadata');
    assert.equal(entriesDuringDrain.at(-1)?.data, 'r');
    assert.equal(entriesDuringDrain.at(-1)?.policyGeneration, rollbackGeneration,
      'the held legacy entry uses the post-rollback generation');
    const drainingAdmission = api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.at(-1)!;
    assert.deepEqual({
      event: drainingAdmission.event,
      reason: drainingAdmission.reason,
      policyGeneration: drainingAdmission.policyGeneration,
    }, {
      event: 'admission-accepted',
      reason: 'candidate-cap-exceeded-fallback',
      policyGeneration: rollbackGeneration,
    }, 'actual PTY legacy admission during drain is generation-stamped and audited');
    const selectedForStagedRelease = selected;
    const selectedWritesForStagedRelease = selectedWrites;
    if (!selectedForStagedRelease || !selectedWritesForStagedRelease) {
      throw new Error('selected rollback fixture must initialize session state and gated writes');
    }
    await waitForFixtureCondition(
      () => selectedWritesForStagedRelease.pendingCallbacks === 1
        && selectedForStagedRelease.pendingHeadlessOutputBytes === 1201,
      'candidate/rollback staged gate must hold one callback and 1201 bytes before the first release',
      1500,
    );
    selectedWrites.releaseNext();
    await waitForFixtureCondition(
      () => selectedForStagedRelease.pendingHeadlessOutputBytes === 501,
      'first staged rollback release must settle to the remaining 501 candidate bytes',
      1500,
    );
    assert.equal(selected.pendingHeadlessOutputBytes, 501);
    selectedWrites.releaseNext();
    await waitForFixtureCondition(
      () => selectedForStagedRelease.pendingHeadlessOutputBytes === 1,
      'second staged rollback release must settle to the remaining legacy byte',
      1500,
    );
    assert.equal(selected.pendingHeadlessOutputBytes, 1);
    assert.equal(selectedWrites.pendingCallbacks, 1,
      'the new legacy write stays FIFO behind both grandfathered candidate writes');
    selectedWrites.releaseNext();
    if (
      selectedWrites.pendingCallbacks > 0
      || selected.pendingHeadlessWrites > 0
      || selected.pendingHeadlessOutputs.size > 0
    ) {
      await drainGatedHeadlessWrites({
        state: selected,
        gatedWrites: selectedWrites,
        phase: 'production PTY rollback residual drain',
      });
    }
    await assertHeadlessWriteChainSettles({
      state: selected,
      gatedWrites: selectedWrites,
      phase: 'production PTY rollback drain write chain',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.at(-1)?.event, 'rollback-closed');
    assert.equal(selected.headlessOutputQueue, queueIdentity);

    emitPtyData(0, 'l'.repeat(legacyLimit));
    await Promise.resolve();
    assert.equal(selected.pendingHeadlessOutputs.size, 1,
      'after rollback, the normal PTY path accepts exactly legacy L bytes');
    assert.equal(selectedWrites.pendingCallbacks, 1);
    emitPtyData(0, '+');
    assert.equal(selected.headlessHealth, 'degraded',
      'after rollback, normal PTY L+1 is rejected by the restored legacy policy');
    const telemetryAfterLegacyOverflow = selected.headlessOutputQueue.snapshot();
    assert.equal(telemetryAfterLegacyOverflow.overflowCount, telemetryBefore.overflowCount + 1);
    assert.equal(telemetryAfterLegacyOverflow.degradedCount, telemetryBefore.degradedCount + 1);
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      selectedWrites?.dispose();
      nonselectedWrites?.dispose();
      if (selected && selectedWrites) {
        await assertHeadlessWriteChainSettles({
          state: selected,
          gatedWrites: selectedWrites,
          phase: 'selected production PTY cleanup write chain',
        });
      }
      if (nonselected && nonselectedWrites) {
        await assertHeadlessWriteChainSettles({
          state: nonselected,
          gatedWrites: nonselectedWrites,
          phase: 'nonselected production PTY cleanup write chain',
        });
      }
      manager.deleteSession(HEADLESS_A.sessionId);
      manager.deleteSession(otherTarget.sessionId);
    } catch (normalCleanupError) {
      try {
        emergencyDisposeProductionPtyFixtures(manager, [
          {
            sessionId: HEADLESS_A.sessionId,
            state: selected,
            originalHeadless: selectedOriginalHeadless,
            gatedWrites: selectedWrites,
          },
          {
            sessionId: otherTarget.sessionId,
            state: nonselected,
            originalHeadless: nonselectedOriginalHeadless,
            gatedWrites: nonselectedWrites,
          },
        ]);
        cleanupError = normalCleanupError;
      } catch (emergencyCleanupError) {
        cleanupError = new AggregateError(
          [normalCleanupError, emergencyCleanupError],
          'production PTY cleanup and emergency cleanup both failed',
        );
      }
    }
    try {
      router.destroy();
    } catch (routerDestroyError) {
      cleanupError = cleanupError === undefined
        ? routerDestroyError
        : new AggregateError(
          [cleanupError, routerDestroyError],
          'production PTY cleanup and router destruction both failed',
        );
    }
    if (cleanupError !== undefined) {
      if (bodyError !== undefined) {
        throw new AggregateError(
          [bodyError, cleanupError],
          'production PTY body and cleanup both failed',
        );
      }
      throw cleanupError;
    }
  }
});

test('REL-BGSTAB-010 headless rollback closes only after the actual write chain drains', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const headlessProfile = profile({ [HEADLESS_RESOURCE]: 1_048_576 }, ':drain-fence');
  const authority = createTrustedAuthority(module, [headlessProfile]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(authority, { spawnPty: pty.spawnPty });
  const api = runtimeApi(store);
  let releaseWrite: (() => void) | undefined;
  let state: ActualHeadlessSessionState | undefined;
  let restoreHeadlessWrite: (() => void) | undefined;
  try {
    state = initializeActualHeadlessSession(manager, HEADLESS_A, []);
    const terminal = (state as unknown as {
      headless: {
        terminal: { write(data: string, callback: () => void): void };
      };
    }).headless.terminal;
    const originalWrite = terminal.write;
    terminal.write = (_data, callback) => { releaseWrite = callback; };
    restoreHeadlessWrite = () => { terminal.write = originalWrite; };
    const lease = issueHeadlessLease(api, headlessProfile);
    api.applyTerminalResourcePolicyLease!({ wsRouter: router, sessionManager: manager, lease });
    const admitted = api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease, rawData: 'actual-admitted-write',
    });
    assert.equal(admitted.accepted, true);
    await Promise.resolve();
    assert.equal(typeof releaseWrite, 'function',
      'actual canary admission must be waiting in HeadlessTerminal.write');
    assert.equal(state.pendingHeadlessWrites, 1);
    (state as unknown as { headlessHealth: 'healthy' | 'degraded' }).headlessHealth = 'degraded';

    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease,
    }), { state: 'draining', reason: 'rollback-draining' });
    assert.deepEqual(runtimeCanaryRegistrySizes(store), {
      targetHandles: 1, listeners: 2, timers: 1, retainedEntries: 1,
    }, 'pending rollback exposes the actual target, drain continuation and retained ledger handles');
    assert.deepEqual(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.slice(-2).map(entry => entry.event), [
      'rollback-requested', 'rollback-draining',
    ]);
    assert.equal(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease,
    }).entries.some(entry => entry.event === 'rollback-closed'), false);

    releaseWrite!();
    await state.headlessWriteChain;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const drainedLedger = api.getTerminalResourcePolicyCanaryLedger!({ wsRouter: router, lease });
    assert.equal(drainedLedger.entries.at(-1)?.event, 'rollback-closed');
    assert.equal(drainedLedger.entries.at(-1)?.rollbackResult, 'closed');
    assert.deepEqual(runtimeCanaryRegistrySizes(store), {
      targetHandles: 0, listeners: 2, timers: 0, retainedEntries: 1,
    }, 'drain completion removes active target and continuation handles while retaining bounded audit state');
    assert.deepEqual(api.previewHeadlessTerminalResourcePolicyAdmission!({
      sessionManager: manager, lease, rawData: 'after-drain',
    }), { accepted: false, mode: 'legacy', reason: 'lease-revoked' });
  } finally {
    releaseWrite?.();
    if (state) await state.headlessWriteChain;
    restoreHeadlessWrite?.();
    manager.deleteSession(HEADLESS_A.sessionId);
    router.destroy();
  }
});

test('REL-BGSTAB-010 headless rollback fences every pre-boundary policy generation', async () => {
  const module = await import(CANARY_MODULE_PATH) as Partial<CanaryModule>;
  const profileA = profile({ [HEADLESS_RESOURCE]: 1_048_576 }, ':multi-generation-a');
  const profileB = profile({ [HEADLESS_RESOURCE]: 1_048_576 }, ':multi-generation-b');
  const authority = createTrustedAuthority(module, [profileA, profileB]);
  const pty = createDeterministicHeadlessPtySpawner();
  const { router, manager, store } = createHarness(authority, { spawnPty: pty.spawnPty });
  const api = runtimeApi(store);
  let releaseWrite: (() => void) | undefined;
  let state: ActualHeadlessSessionState | undefined;
  let restoreHeadlessWrite: (() => void) | undefined;
  try {
    state = initializeActualHeadlessSession(manager, HEADLESS_A, []);
    const terminal = (state as unknown as {
      headless: {
        terminal: { write(data: string, callback: () => void): void };
      };
    }).headless.terminal;
    const originalWrite = terminal.write;
    terminal.write = (_data, callback) => { releaseWrite = callback; };
    restoreHeadlessWrite = () => { terminal.write = originalWrite; };

    const leaseA = issueHeadlessLease(api, profileA);
    assert.equal(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: leaseA,
    }).mode, 'candidate');
    assert.equal(api.admitHeadlessTerminalResourcePolicyData!({
      sessionManager: manager, lease: leaseA, rawData: 'generation-a-pending',
    }).accepted, true);
    await Promise.resolve();
    assert.equal(typeof releaseWrite, 'function');
    assert.equal(readActualHeadlessEntries(manager, HEADLESS_A).at(0)?.policyGeneration, 1);

    const leaseB = issueHeadlessLease(api, profileB);
    assert.equal(api.applyTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: leaseB,
    }).mode, 'candidate');
    assert.equal(readActualHeadlessEntries(manager, HEADLESS_A).length, 1,
      'generation B activates without producing any B output');
    assert.deepEqual(api.rollbackTerminalResourcePolicyLease!({
      wsRouter: router, sessionManager: manager, lease: leaseB,
    }), { state: 'draining', reason: 'rollback-draining' },
    'rollback B must capture the actual generation-A entry already before its boundary');
    assert.equal(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: leaseB,
    }).entries.some(entry => entry.event === 'rollback-closed'), false);

    releaseWrite!();
    await state.headlessWriteChain;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(api.getTerminalResourcePolicyCanaryLedger!({
      wsRouter: router, lease: leaseB,
    }).entries.at(-1)?.event, 'rollback-closed');
  } finally {
    releaseWrite?.();
    if (state) await state.headlessWriteChain;
    restoreHeadlessWrite?.();
    manager.deleteSession(HEADLESS_A.sessionId);
    router.destroy();
  }
});

test('Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-6', () => {
  type InternalGenerationFactory = (
    message: object,
    now?: number,
    options?: { policyGeneration: number },
  ) => WsTransportMessage & { policyGeneration?: number };
  const createWithGeneration = createWsTransportMessage as unknown as InternalGenerationFactory;
  const make = (data: string, generation?: number, bodyGeneration?: number) => createWithGeneration({
    type: 'output', sessionId: 'session-a1', data,
    ...(bodyGeneration === undefined ? {} : { policyGeneration: bodyGeneration }),
  }, 100, ...(generation === undefined ? [] : [{ policyGeneration: generation }]));
  const old = make('old', 40, 999);
  const same = make('same', 40);
  const different = make('different', 41);
  const undefinedGeneration = make('undefined');
  assert.equal(old.policyGeneration, 40, signature(6));
  assert.equal('policyGeneration' in (JSON.parse(jsonWirePayloadText(old.payload)) as Record<string, unknown>), false);
  assert.equal(tryCoalesceOutputMessage(old, different, 10), null);
  assert.equal(tryCoalesceOutputMessage(old, undefinedGeneration, 10), null);
  const coalesced = tryCoalesceOutputMessage(old, same, 10) as typeof old | null;
  assert.ok(coalesced);
  assert.equal(coalesced.policyGeneration, 40);
  assert.equal('policyGeneration' in (JSON.parse(jsonWirePayloadText(coalesced.payload)) as Record<string, unknown>), false);
});

test('REL-BGSTAB-010 coalescing preserves every admission identity and lifetime fence', () => {
  const metadata: WsTransportMessageMetadata = {
    policyGeneration: 42,
    expiresAt: 10_000,
    ready: true,
    recoveryGeneration: 7,
    source: 'candidate-admission',
    exactlyOnceKey: 'entry-a',
  };
  const make = (data: string, overrides: Partial<typeof metadata> = {}) => createWsTransportMessage({
    type: 'output', sessionId: 'session-a1', data,
  }, data === 'a' ? 100 : 101, { ...metadata, ...overrides });
  const existing = make('a');
  const identical = make('b');
  assert.ok(tryCoalesceOutputMessage(existing, identical, 10),
    'fully identical internal provenance may coalesce');
  for (const [field, incoming] of [
    ['policyGeneration', make('b', { policyGeneration: 41 })],
    ['expiresAt', make('b', { expiresAt: 9_999 })],
    ['ready', make('b', { ready: false })],
    ['recoveryGeneration', make('b', { recoveryGeneration: 8 })],
    ['source', make('b', { source: 'legacy-fallback' })],
    ['exactlyOnceKey', make('b', { exactlyOnceKey: 'entry-b' })],
  ] as const) {
    assert.equal(tryCoalesceOutputMessage(existing, incoming, 10), null,
      `${field} mismatch must not erase per-admission provenance`);
  }
});

test('PERF-BGSTAB-010 AC-3/AC-4 fair artifact admission 계약 부재 때문에 실패', async () => {
  type FairDeliveryArtifactValidator = (input: {
    policyHash: string;
    workloadSchemaHash: string;
    artifact: {
      state: 'missing' | 'incomplete' | 'complete';
      policyHash?: string;
      workloadSchemaHash?: string;
      validatorVerdict?: 'accept' | 'reject';
    };
  }) => { accepted: boolean; reason: string };
  const module = await import(CANARY_MODULE_PATH) as {
    validateFairDeliveryCandidateArtifact?: FairDeliveryArtifactValidator;
  };
  const validate = module.validateFairDeliveryCandidateArtifact;
  const failure = 'PERF-BGSTAB-010 AC-3/AC-4 fair artifact admission 계약 부재 때문에 실패';
  assert.equal(typeof validate, 'function', failure);

  const context = { policyHash: 'policy-sha', workloadSchemaHash: 'workload-sha' };
  assert.deepEqual(validate!({ ...context, artifact: { state: 'missing' } }), {
    accepted: false,
    reason: 'decision-artifact-missing',
  }, failure);
  assert.deepEqual(validate!({ ...context, artifact: {
    state: 'complete', policyHash: 'tampered-policy-sha', workloadSchemaHash: 'workload-sha', validatorVerdict: 'accept',
  } }), {
    accepted: false,
    reason: 'decision-artifact-policy-hash-mismatch',
  }, failure);
  assert.deepEqual(validate!({ ...context, artifact: {
    state: 'complete', policyHash: 'policy-sha', workloadSchemaHash: 'workload-sha', validatorVerdict: 'accept',
  } }), {
    accepted: true,
    reason: 'decision-artifact-verified',
  }, failure);
});

test('PERF-BGSTAB-010 published fair artifact admission validates the benchmark policy contract', () => {
  const source = readFileSync(new URL('./TerminalResourcePolicyCanary.ts', import.meta.url), 'utf8');
  assert.match(source, /validateFairSchedulerDecisionArtifact/u);
  assert.match(source, /getFairSchedulerBenchmarkContract/u);
});

test('PERF-BGSTAB-010 source default Canary admission fails closed', async () => {
  type CandidateArtifactAdmission = {
    accepted: boolean;
    reason: string;
  };
  const module = await import(CANARY_MODULE_PATH) as {
    createPublishedFairDeliveryCandidateArtifactValidator?: (resolver?: AuthorityResolver) => () => CandidateArtifactAdmission;
  };
  type AuthorityLocator = {
    locatorPath: string;
    logicalLocator: string;
  };
  type AuthorityResolver = {
    getLocator(): AuthorityLocator;
    validate(input: { expectedPolicyDigest: string }): CandidateArtifactAdmission;
  };
  type AuthorityModule = {
    createFairSchedulerEvidenceAuthorityResolver?: (input?: { repositoryRoot?: string }) => AuthorityResolver;
  };
  const createValidator = module.createPublishedFairDeliveryCandidateArtifactValidator;
  const authorityModule = await import('../benchmarks/terminalFairnessCharacterization.js') as AuthorityModule;
  const createResolver = authorityModule.createFairSchedulerEvidenceAuthorityResolver;
  const source = readFileSync(new URL('./TerminalResourcePolicyCanary.ts', import.meta.url), 'utf8');
  const failure = 'PERF-BGSTAB-010 live Canary admission must resolve only the default canonical pointer';
  assert.equal(typeof createResolver, 'function',
    `${failure}: canonical-locator resolver factory must be exported for the default source runtime`);
  assert.equal(typeof createValidator, 'function',
    `${failure}: a resolver-injectable zero-argument validator factory must be exported`);
  const validatorFactoryInput = source.match(
    /export function createPublishedFairDeliveryCandidateArtifactValidator\(\s*([^)]*)\)\s*:/u,
  )?.[1];
  assert.notEqual(validatorFactoryInput, undefined,
    `${failure}: the validator factory must declare its authority-resolver input`);
  assert.match(validatorFactoryInput!, /^\s*resolver\s*\?:\s*[A-Za-z_$][\w$]*(?:\s*<[^{}(),]+>)?\s*,?\s*$/u,
    `${failure}: the validator factory must accept exactly one optional named authority resolver, not a root or options object`);
  const validatorFactoryStart = source.indexOf('export function createPublishedFairDeliveryCandidateArtifactValidator');
  assert.notEqual(validatorFactoryStart, -1,
    `${failure}: the validator factory source must remain present`);
  const validatorFactoryEnd = source.indexOf('\nexport ', validatorFactoryStart + 1);
  const validatorFactorySource = source.slice(
    validatorFactoryStart,
    validatorFactoryEnd === -1 ? source.length : validatorFactoryEnd,
  );
  assert.match(validatorFactorySource, /\bcreateFairSchedulerEvidenceAuthorityResolver\(\s*\)/u,
    `${failure}: the default validator factory must compose the canonical resolver with no root override`);
  assert.doesNotMatch(validatorFactorySource, /\bresolveFairSchedulerEvidenceRoot\b/u,
    `${failure}: the default validator factory must not compose the legacy evidence-root resolver`);
  const defaultAdmissionDeclaration = source.match(
    /export function validatePublishedFairDeliveryCandidateArtifact\(\s*([\s\S]*?)\)\s*:/u,
  )?.[1];
  assert.notEqual(defaultAdmissionDeclaration, undefined,
    `${failure}: default admission must retain an explicit public declaration`);
  assert.match(defaultAdmissionDeclaration!, /^\s*[A-Za-z_$][\w$]*\s*:\s*\{\s*runtimePolicy\s*\?\s*:\s*unknown\s*;?\s*\}\s*=\s*\{\s*\}\s*$/u,
    `${failure}: runtime admission must accept only its documented runtimePolicy object`);
  assert.doesNotMatch(defaultAdmissionDeclaration!, /\b(?:authorityRoot|artifactRoot|evidenceRoot|resolver)\b/u,
    `${failure}: public runtime admission must not expose a root or resolver injection parameter`);
  const publicAdmissionStart = source.indexOf('export function validatePublishedFairDeliveryCandidateArtifact');
  assert.notEqual(publicAdmissionStart, -1,
    `${failure}: public default admission source must remain present`);
  const publicAdmissionSource = source.slice(publicAdmissionStart, publicAdmissionStart + 2_000);
  const defaultFactoryBinding = source.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*createPublishedFairDeliveryCandidateArtifactValidator\(\s*\)\s*;/u,
  );
  const callsBoundDefaultValidator = defaultFactoryBinding !== null
    && new RegExp(`\\b${defaultFactoryBinding[1]}\\(\\s*\\)`, 'u').test(publicAdmissionSource);
  const createsAndCallsDefaultValidator = /createPublishedFairDeliveryCandidateArtifactValidator\(\s*\)\s*\(\s*\)/u
    .test(publicAdmissionSource);
  assert.equal(callsBoundDefaultValidator || createsAndCallsDefaultValidator, true,
    `${failure}: public default admission must call the no-argument canonical factory result`);
  assert.doesNotMatch(publicAdmissionSource,
    /\bcreatePublishedFairDeliveryCandidateArtifactValidator\(\s*(?!\))/u,
    `${failure}: public default admission must not call the validator factory with a root or resolver`);
  assert.doesNotMatch(publicAdmissionSource, /\b(?:authorityRoot|artifactRoot|evidenceRoot|resolver)\b/u,
    `${failure}: public default admission must not forward a root or resolver to the factory`);
  const locator = createResolver!().getLocator();
  assert.equal(locator.logicalLocator, 'docs/analysis/terminal-fairness-authority/current.json',
    `${failure}: default source runtime must use only the canonical logical locator`);
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'buildergate-canary-authority-'));
  try {
    const historicalDecoyRoot = join(
      repositoryRoot,
      'docs',
      'analysis',
      'kiwi-coder-2026-07-28.pm.wave3-current-authority',
      'fair-scheduler-evidence',
    );
    mkdirSync(historicalDecoyRoot, { recursive: true });
    writeFileSync(join(historicalDecoyRoot, 'current.json'), '{"decoy":"historical"}', 'utf8');
    const missingCanonicalResolver: AuthorityResolver = createResolver!({ repositoryRoot });
    assert.deepEqual(createValidator!(missingCanonicalResolver)(), {
      accepted: false,
      reason: 'authority-pointer-missing',
    }, `${failure}: an injected resolver with only a historical decoy must fail closed at the canonical pointer`);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 source canonical resolver rejects noncanonical authority', async () => {
  type AuthorityResolution =
    | {
      accepted: true;
      evidenceRoot: string;
      generationId: string;
      locatorPath: string;
      logicalLocator: string;
      publicationGeneration: string;
      reason: 'authority-locator-verified';
    }
    | { accepted: false; reason: string };
  type AuthorityLocator = {
    authorityRoot: string;
    locatorPath: string;
    logicalLocator: string;
  };
  type AuthorityResolver = {
    getLocator(): AuthorityLocator;
    validate(input: {
      expectedPolicyDigest: string;
    }): AuthorityResolution;
  };
  type AuthorityResolverFactory = (input?: {
    repositoryRoot?: string;
  }) => AuthorityResolver;
  type AuthorityModule = {
    createFairSchedulerEvidenceAuthorityResolver?: AuthorityResolverFactory;
    resolveFairSchedulerEvidenceRoot?: () => string;
  };
  const sourceModule = await import('../benchmarks/terminalFairnessCharacterization.js') as AuthorityModule;
  const failure = 'PERF-BGSTAB-010 source authority resolver contract must fail closed';
  const createResolver = sourceModule.createFairSchedulerEvidenceAuthorityResolver;
  const resolveLegacyEvidenceRoot = sourceModule.resolveFairSchedulerEvidenceRoot;
  const resolverSource = readFileSync(new URL('../benchmarks/terminalFairnessCharacterization.ts', import.meta.url), 'utf8');
  const resolverFactoryInput = resolverSource.match(
    /export function createFairSchedulerEvidenceAuthorityResolver\(\s*([^)]*)\)\s*:/u,
  )?.[1];
  assert.equal(typeof createResolver, 'function',
    `${failure}: repository-root-injected public resolver factory must be exported`);
  assert.notEqual(resolverFactoryInput, undefined,
    `${failure}: the resolver factory must expose a reviewable public declaration`);
  assert.match(resolverFactoryInput!, /^\s*[A-Za-z_$][\w$]*\s*:\s*\{\s*repositoryRoot\s*\?:\s*string\s*;?\s*\}\s*=\s*\{\s*\}\s*,?\s*$/u,
    `${failure}: the resolver factory must accept only an optional repositoryRoot in its options object`);
  assert.equal(typeof resolveLegacyEvidenceRoot, 'function',
    `${failure}: the exported legacy evidence-root resolver must remain directly testable`);
  const legacyResolverSource = resolveLegacyEvidenceRoot!.toString();
  assert.doesNotMatch(legacyResolverSource, /kiwi-(?:planner|coder)-/u,
    `${failure}: legacy resolver source must not refer to a planner or kiwi-coder analysis root`);
  const normalizedLegacyEvidenceRoot = resolveLegacyEvidenceRoot!().replace(/\\/gu, '/');
  assert.match(normalizedLegacyEvidenceRoot, /\/docs\/analysis\/terminal-fairness-authority$/u,
    `${failure}: legacy resolver must derive only the canonical authority root`);
  assert.doesNotMatch(normalizedLegacyEvidenceRoot, /\/docs\/analysis\/kiwi-(?:planner|coder)-/u,
    `${failure}: legacy resolver must not return a planner or kiwi-coder analysis root`);

  const canonicalLocator = 'docs/analysis/terminal-fairness-authority/current.json';
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'buildergate-fair-repository-'));
  const authorityRoot = join(repositoryRoot, 'docs', 'analysis', 'terminal-fairness-authority');
  const publicationGeneration = 'test-publication';
  const expectedPolicyDigest = 'b'.repeat(64);
  const decision = '{"evidence":"structural"}';
  const rawSample = '{"sample":1}';
  const additionalRawSample = '{"sample":2}';
  const decisionSha256 = 'fdbdbb0941bcef78a5ce99fa5da01b230e5ceb0d2fd31b2c4af0e8cb2f587f4e';
  const rawSampleSha256 = '820a466daef9ca8e876a17e665f95e9ae4e6b407f8a01d51ad2d6bbc6e642b7b';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const additionalRawSampleSha256 = hash(additionalRawSample);
  type RawManifestEntry = {
    path: string;
    sha256: string;
  };
  const rawManifestEntries: readonly RawManifestEntry[] = [{
    path: 'raw/sample.json',
    sha256: rawSampleSha256,
  }];
  const canonicalizeRawManifestEntries = (entries: readonly RawManifestEntry[]) => JSON.stringify(entries.map(entry => ({
    path: entry.path,
    sha256: entry.sha256,
  })));
  const deriveGenerationInput = (input: {
    policyDigest?: string;
    rawManifestEntries: readonly RawManifestEntry[];
    trialInventory?: readonly RawManifestEntry[];
  }) => JSON.stringify({
    decision_sha256: decisionSha256,
    policy_digest: input.policyDigest ?? expectedPolicyDigest,
    raw_entries_digest: hash(canonicalizeRawManifestEntries(input.rawManifestEntries)),
    schema_version: 'fair-scheduler-current-authority/v1',
    trial_inventory: input.trialInventory ?? input.rawManifestEntries,
  });
  const rawEntriesCanonical = canonicalizeRawManifestEntries(rawManifestEntries);
  const literalJcsRawEntries = '[{"path":"raw/sample.json","sha256":"820a466daef9ca8e876a17e665f95e9ae4e6b407f8a01d51ad2d6bbc6e642b7b"}]';
  const expectedRawEntriesDigest = '083173df251671d3627e2b9defe91f721a6a4ae91f70b8c018b8633560e70064';
  const literalJcsGenerationInput = '{"decision_sha256":"fdbdbb0941bcef78a5ce99fa5da01b230e5ceb0d2fd31b2c4af0e8cb2f587f4e","policy_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","raw_entries_digest":"083173df251671d3627e2b9defe91f721a6a4ae91f70b8c018b8633560e70064","schema_version":"fair-scheduler-current-authority/v1","trial_inventory":[{"path":"raw/sample.json","sha256":"820a466daef9ca8e876a17e665f95e9ae4e6b407f8a01d51ad2d6bbc6e642b7b"}]}';
  const expectedGenerationId = '94f050d02e6eac485b37a5bf72b2262cf4a48ef819437c206e3447d10d7b6eb4';
  const rawEntriesDigest = hash(rawEntriesCanonical);
  const generationId = expectedGenerationId;
  assert.equal(hash(decision), decisionSha256,
    `${failure}: the independent decision SHA-256 golden value must remain stable`);
  assert.equal(hash(rawSample), rawSampleSha256,
    `${failure}: the independent raw sample SHA-256 golden value must remain stable`);
  assert.equal(rawEntriesDigest, expectedRawEntriesDigest,
    `${failure}: raw manifest entries must use the exact RFC8785/JCS UTF-8 golden payload`);
  assert.equal(rawEntriesCanonical, literalJcsRawEntries,
    `${failure}: the fixture's path-to-sha256 entries must match the independently literal JCS input`);
  assert.equal(hash(literalJcsGenerationInput), expectedGenerationId,
    `${failure}: generation id must use the exact RFC8785/JCS five-field UTF-8 golden payload`);
  const generationRoot = join(authorityRoot, 'generations', generationId);
  const generationsRoot = join(authorityRoot, 'generations');
  const locatorPath = join(authorityRoot, 'current.json');
  const decisionPath = join(generationRoot, 'fair-scheduler-decision.json');
  const provenancePath = join(generationRoot, 'provenance.json');
  const rawManifestPath = join(generationRoot, 'raw', 'manifest.json');
  const rawSamplePath = join(generationRoot, 'raw', 'sample.json');
  const historicalDecoyRoot = join(
    repositoryRoot,
    'docs',
    'analysis',
    'kiwi-coder-2026-07-28.pm.wave3-current-authority',
    'fair-scheduler-evidence',
  );
  const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const writeJson = (path: string, value: Record<string, unknown>) => writeFileSync(path, JSON.stringify(value), 'utf8');
  const withoutField = (value: Record<string, unknown>, field: string) => {
    const copy = { ...value };
    delete copy[field];
    return copy;
  };
  const assertOwnedTemporaryPath = (candidatePath: string, ownerPath: string, description: string) => {
    const absoluteCandidatePath = resolve(candidatePath);
    const absoluteOwnerPath = resolve(ownerPath);
    assert.equal(
      absoluteCandidatePath.startsWith(`${absoluteOwnerPath}${sep}`),
      true,
      `${failure}: ${description} must remain inside its owned temporary fixture directory`,
    );
  };
  const createOutsideAuthorityLink = (
    linkPath: string,
    targetPath: string,
    kind: 'file' | 'directory',
    description: string,
  ) => {
    const removeFixtureLink = (fixtureLinkPath: string, fixtureKind: 'file' | 'directory') => {
      rmSync(fixtureLinkPath, { recursive: fixtureKind === 'directory', force: true });
    };
    const assertOwnedAuthorityPath = (candidatePath: string, candidateDescription: string) => {
      const absoluteCandidatePath = resolve(candidatePath);
      const absoluteAuthorityRoot = resolve(authorityRoot);
      assert.equal(
        absoluteCandidatePath === absoluteAuthorityRoot
          || absoluteCandidatePath.startsWith(`${absoluteAuthorityRoot}${sep}`),
        true,
        `${failure}: ${candidateDescription} must remain inside or equal the owned canonical authority root`,
      );
    };
    assertOwnedTemporaryPath(linkPath, authorityRoot, `${description} link path`);
    assertOwnedTemporaryPath(targetPath, repositoryRoot, `${description} target path`);
    assert.equal(resolve(targetPath).startsWith(`${resolve(authorityRoot)}${sep}`), false,
      `${failure}: ${description} target must be outside the canonical authority root`);
    removeFixtureLink(linkPath, kind);
    try {
      symlinkSync(
        targetPath,
        linkPath,
        process.platform === 'win32'
          ? (kind === 'directory' ? 'junction' : 'file')
          : (kind === 'directory' ? 'dir' : 'file'),
      );
    } catch (error) {
      const errorCode = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (process.platform === 'win32' && kind === 'file' && errorCode === 'EPERM') {
        const linkAncestorPath = dirname(linkPath);
        const targetAncestorPath = dirname(targetPath);
        assertOwnedAuthorityPath(linkAncestorPath, `${description} fallback ancestor link path`);
        assertOwnedTemporaryPath(targetAncestorPath, repositoryRoot,
          `${description} fallback ancestor target path`);
        assert.equal(resolve(targetAncestorPath).startsWith(`${resolve(authorityRoot)}${sep}`), false,
          `${failure}: ${description} fallback ancestor target must be outside the canonical authority root`);
        rmSync(linkAncestorPath, { recursive: true, force: true });
        symlinkSync(targetAncestorPath, linkAncestorPath, 'junction');
        assert.equal(lstatSync(linkAncestorPath).isSymbolicLink(), true,
          `${failure}: ${description} fallback must exercise an owned junction/reparse ancestor`);
        assert.equal(existsSync(linkPath), true,
          `${failure}: ${description} fallback ancestor link must expose the linked file`);
        return () => {
          rmSync(linkAncestorPath, { recursive: true, force: true });
          mkdirSync(linkAncestorPath, { recursive: true });
        };
      }
      assert.fail(
        `${failure}: ${description} fixture must create a temporary ${kind} link; `
        + `link creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true,
      `${failure}: ${description} direct fixture must remain observable as a link or reparse point`);
    return () => removeFixtureLink(linkPath, kind);
  };
  const writeStructuralAuthorityBundle = (
    targetAuthorityRoot: string,
    assertRawFixtureReset = false,
    reverseRawEntryKeyOrder = false,
  ) => {
    const targetGenerationsRoot = join(targetAuthorityRoot, 'generations');
    const targetGenerationRoot = join(targetGenerationsRoot, generationId);
    const targetLocatorPath = join(targetAuthorityRoot, 'current.json');
    const targetDecisionPath = join(targetGenerationRoot, 'fair-scheduler-decision.json');
    const targetProvenancePath = join(targetGenerationRoot, 'provenance.json');
    const targetRawManifestPath = join(targetGenerationRoot, 'raw', 'manifest.json');
    const targetRawSamplePath = join(targetGenerationRoot, 'raw', 'sample.json');
    rmSync(targetGenerationsRoot, { recursive: true, force: true });
    mkdirSync(join(targetGenerationRoot, 'raw'), { recursive: true });
    if (assertRawFixtureReset) {
      assert.equal(existsSync(targetRawSamplePath), false,
        `${failure}: fixture reset must remove raw files from an earlier mutation case`);
    }
    const serializedRawManifestEntries = reverseRawEntryKeyOrder
      ? rawManifestEntries.map(entry => ({ sha256: entry.sha256, path: entry.path }))
      : rawManifestEntries;
    const rawManifest = JSON.stringify({
      schema_version: 'fair-scheduler-raw-manifest/v1',
      generation_id: generationId,
      entries: serializedRawManifestEntries,
    });
    const provenance = JSON.stringify({
      schema_version: 'fair-scheduler-source-provenance/v1',
      generation_id: generationId,
      canonical_locator: canonicalLocator,
      publication_generation: publicationGeneration,
      decision_path: 'fair-scheduler-decision.json',
      decision_sha256: decisionSha256,
      provenance_path: 'provenance.json',
      raw_root: 'raw/',
      raw_manifest_path: 'raw/manifest.json',
      raw_manifest_sha256: hash(rawManifest),
      policy_digest: expectedPolicyDigest,
      trial_inventory: serializedRawManifestEntries,
    });
    const locator = JSON.stringify({
      schema_version: 'fair-scheduler-current-authority/v1',
      generation_id: generationId,
      publication_generation: publicationGeneration,
      decision_artifact: 'fair-scheduler-decision.json',
      decision_sha256: decisionSha256,
      provenance_artifact: 'provenance.json',
      provenance_sha256: hash(provenance),
      raw_root: 'raw/',
      raw_manifest_sha256: hash(rawManifest),
    });
    writeFileSync(targetDecisionPath, decision, 'utf8');
    writeFileSync(targetProvenancePath, provenance, 'utf8');
    writeFileSync(targetRawManifestPath, rawManifest, 'utf8');
    writeFileSync(targetRawSamplePath, rawSample, 'utf8');
    writeFileSync(targetLocatorPath, locator, 'utf8');
  };
  const writeStructuralAuthority = (reverseRawEntryKeyOrder = false) => {
    assertOwnedTemporaryPath(authorityRoot, repositoryRoot, 'authority root');
    assertOwnedTemporaryPath(generationsRoot, authorityRoot, 'generations root');
    assertOwnedTemporaryPath(generationRoot, authorityRoot, 'generation root');
    writeStructuralAuthorityBundle(authorityRoot, true, reverseRawEntryKeyOrder);
  };
  const rewriteProvenance = (mutate: (value: Record<string, unknown>) => Record<string, unknown>) => {
    const provenance = mutate(readJson(provenancePath));
    writeJson(provenancePath, provenance);
    writeJson(locatorPath, { ...readJson(locatorPath), provenance_sha256: hash(JSON.stringify(provenance)) });
  };
  const rewriteRawManifest = (mutate: (value: Record<string, unknown>) => Record<string, unknown>) => {
    const rawManifest = mutate(readJson(rawManifestPath));
    const rawManifestText = JSON.stringify(rawManifest);
    writeFileSync(rawManifestPath, rawManifestText, 'utf8');
    rewriteProvenance(value => ({ ...value, raw_manifest_sha256: hash(rawManifestText) }));
    writeJson(locatorPath, { ...readJson(locatorPath), raw_manifest_sha256: hash(rawManifestText) });
  };
  const assertIsolatedAuthorityReferenceEscape = (
    scenario: 'authority-root' | 'generations-ancestor',
  ) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), `buildergate-fair-${scenario}-link-`));
    const fixtureRepositoryRoot = join(fixtureRoot, 'repository');
    const fixtureAuthorityRoot = join(
      fixtureRepositoryRoot,
      'docs',
      'analysis',
      'terminal-fairness-authority',
    );
    const fixtureLocatorPath = join(fixtureAuthorityRoot, 'current.json');
    const fixtureGenerationsRoot = join(fixtureAuthorityRoot, 'generations');
    const outsideAuthorityRoot = join(fixtureRoot, 'outside-authority');
    const outsideGenerationsRoot = join(outsideAuthorityRoot, 'generations');
    const assertFixturePath = (candidatePath: string, description: string) => {
      const absoluteCandidatePath = resolve(candidatePath);
      const absoluteFixtureRoot = resolve(fixtureRoot);
      assert.equal(
        absoluteCandidatePath === absoluteFixtureRoot
          || absoluteCandidatePath.startsWith(`${absoluteFixtureRoot}${sep}`),
        true,
        `${failure}: ${description} must remain inside the isolated temporary fixture`,
      );
    };
    const createFixtureLink = (linkPath: string, targetPath: string, description: string) => {
      assertFixturePath(linkPath, `${description} link path`);
      assertFixturePath(targetPath, `${description} target path`);
      assert.equal(resolve(targetPath).startsWith(`${resolve(fixtureAuthorityRoot)}${sep}`), false,
        `${failure}: ${description} target must resolve outside the owned canonical authority root`);
      try {
        symlinkSync(
          targetPath,
          linkPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        assert.fail(
          `${failure}: ${description} fixture must create an isolated temporary directory link; `
          + `link creation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      assert.equal(lstatSync(linkPath).isSymbolicLink(), true,
        `${failure}: ${description} fixture must remain observable as a link or reparse point`);
    };

    try {
      assertFixturePath(fixtureRepositoryRoot, 'isolated repository root');
      assertFixturePath(fixtureAuthorityRoot, 'isolated canonical authority root');
      assertFixturePath(outsideAuthorityRoot, 'isolated external authority root');
      writeStructuralAuthorityBundle(outsideAuthorityRoot);

      if (scenario === 'authority-root') {
        mkdirSync(join(fixtureRepositoryRoot, 'docs', 'analysis'), { recursive: true });
        createFixtureLink(fixtureAuthorityRoot, outsideAuthorityRoot,
          'canonical authority root');
        assert.equal(readJson(fixtureLocatorPath).generation_id, generationId,
          `${failure}: linked canonical authority root must otherwise expose a valid pointer`);
        assert.equal(existsSync(join(fixtureAuthorityRoot, 'generations', generationId, 'fair-scheduler-decision.json')), true,
          `${failure}: linked canonical authority root must otherwise expose its selected generation`);
      } else {
        writeStructuralAuthorityBundle(fixtureAuthorityRoot);
        assert.equal(readJson(fixtureLocatorPath).generation_id, generationId,
          `${failure}: canonical pointer must select the external generations fixture generation`);
        assert.equal(existsSync(join(outsideGenerationsRoot, generationId, 'fair-scheduler-decision.json')), true,
          `${failure}: external generations fixture must contain the selected immutable generation before link setup`);
        rmSync(fixtureGenerationsRoot, { recursive: true, force: true });
        createFixtureLink(fixtureGenerationsRoot, outsideGenerationsRoot,
          'canonical generations ancestor');
        assert.equal(existsSync(join(fixtureGenerationsRoot, generationId, 'fair-scheduler-decision.json')), true,
          `${failure}: linked generations ancestor must otherwise expose the selected immutable generation`);
      }

      const isolatedResolver = createResolver!({ repositoryRoot: fixtureRepositoryRoot });
      assert.equal(isolatedResolver.getLocator().authorityRoot, fixtureAuthorityRoot,
        `${failure}: ${scenario} fixture must retain the canonical logical authority path`);
      assert.deepEqual(isolatedResolver.validate({ expectedPolicyDigest }), {
        accepted: false,
        reason: 'authority-reference-link-or-reparse-point-detected',
      }, `${failure}: ${scenario} link must fail closed before accepting an otherwise valid external authority`);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };

  try {
    assertOwnedTemporaryPath(historicalDecoyRoot, repositoryRoot, 'historical decoy authority root');
    writeStructuralAuthorityBundle(historicalDecoyRoot);
    rmSync(locatorPath, { force: true });
    const historicalDecoyGenerationRoot = join(historicalDecoyRoot, 'generations', generationId);
    const historicalDecoyLocatorPath = join(historicalDecoyRoot, 'current.json');
    const historicalDecoyDecisionPath = join(historicalDecoyGenerationRoot, 'fair-scheduler-decision.json');
    const historicalDecoyProvenancePath = join(historicalDecoyGenerationRoot, 'provenance.json');
    const historicalDecoyRawManifestPath = join(historicalDecoyGenerationRoot, 'raw', 'manifest.json');
    const historicalDecoyPointer = readJson(historicalDecoyLocatorPath);
    const historicalDecoyProvenance = readJson(historicalDecoyProvenancePath);
    const historicalDecoyRawManifest = readJson(historicalDecoyRawManifestPath);
    assert.equal(existsSync(locatorPath), false,
      `${failure}: the canonical pointer must be absent while the noncanonical decoy is structurally valid`);
    assert.equal(historicalDecoyPointer.generation_id, generationId,
      `${failure}: the historical decoy pointer must bind its immutable generation directory`);
    assert.equal(historicalDecoyProvenance.generation_id, generationId,
      `${failure}: the historical decoy provenance must bind its immutable generation directory`);
    assert.equal(historicalDecoyRawManifest.generation_id, generationId,
      `${failure}: the historical decoy raw manifest must bind its immutable generation directory`);
    assert.equal(historicalDecoyPointer.decision_sha256, hash(readFileSync(historicalDecoyDecisionPath, 'utf8')),
      `${failure}: the historical decoy pointer must retain its decision hash binding`);
    assert.equal(historicalDecoyPointer.provenance_sha256, hash(readFileSync(historicalDecoyProvenancePath, 'utf8')),
      `${failure}: the historical decoy pointer must retain its provenance hash binding`);
    assert.equal(historicalDecoyPointer.raw_manifest_sha256, hash(readFileSync(historicalDecoyRawManifestPath, 'utf8')),
      `${failure}: the historical decoy pointer must retain its raw-manifest hash binding`);
    assert.equal(historicalDecoyProvenance.decision_sha256, historicalDecoyPointer.decision_sha256,
      `${failure}: the historical decoy provenance must retain its decision hash binding`);
    assert.equal(historicalDecoyProvenance.raw_manifest_sha256, historicalDecoyPointer.raw_manifest_sha256,
      `${failure}: the historical decoy provenance must retain its raw-manifest hash binding`);
    const resolver = createResolver!({ repositoryRoot });
    const locator = resolver.getLocator();
    assert.equal(locator.logicalLocator, canonicalLocator,
      `${failure}: only the dedicated canonical logical locator is authoritative`);
    assert.equal(locator.authorityRoot, authorityRoot,
      `${failure}: injected repository root must derive the dedicated authority root`);
    assert.equal(locator.locatorPath, locatorPath,
      `${failure}: pointer must remain current.json under the canonical authority root`);
    assert.equal(locator.authorityRoot.includes('kiwi-coder-'), false,
      `${failure}: planner-run directories are never authority roots`);
    assert.deepEqual(resolver.validate({ expectedPolicyDigest }), {
      accepted: false,
      reason: 'authority-pointer-missing',
    }, `${failure}: an available historical decoy must not become a fallback`);
    for (const rootField of ['authorityRoot', 'artifactRoot', 'evidenceRoot'] as const) {
      const rootInjectedResolver = createResolver!({
        repositoryRoot,
        [rootField]: historicalDecoyRoot,
      } as unknown as { repositoryRoot?: string });
      assert.equal(rootInjectedResolver.getLocator().authorityRoot, authorityRoot,
        `${failure}: resolver factory must not honor a caller-selected ${rootField}`);
      assert.deepEqual(rootInjectedResolver.validate({ expectedPolicyDigest }), {
        accepted: false,
        reason: 'authority-pointer-missing',
      }, `${failure}: ${rootField} must not redirect the resolver to a historical decoy`);
    }

    const assertRejected = (scenario: string, reason: string) => {
      assert.deepEqual(resolver.validate({ expectedPolicyDigest }), { accepted: false, reason },
        `${failure}: ${scenario}`);
    };
    const assertStructuralAuthority = () => {
      const resolved = resolver.validate({ expectedPolicyDigest });
      assert.equal(resolved.accepted, true,
        `${failure}: this verifies only locator structure and integrity, not fair-delivery candidacy`);
      if (resolved.accepted) {
        assert.equal(resolved.reason, 'authority-locator-verified', failure);
        assert.equal(resolved.generationId, generationId, failure);
        assert.equal(resolved.publicationGeneration, publicationGeneration, failure);
        assert.equal(resolved.evidenceRoot, generationRoot, failure);
        assert.equal(resolved.locatorPath, locatorPath, failure);
        assert.equal(resolved.logicalLocator, canonicalLocator, failure);
      }
    };

    writeStructuralAuthority();
    assertStructuralAuthority();

    assertIsolatedAuthorityReferenceEscape('authority-root');
    assertIsolatedAuthorityReferenceEscape('generations-ancestor');

    writeStructuralAuthority();
    const malformedPointer = '{"pointer":';
    writeFileSync(locatorPath, malformedPointer, 'utf8');
    assertRejected('malformed canonical pointer JSON', 'authority-pointer-invalid-json');

    const outsideAuthorityRoot = join(repositoryRoot, 'outside-canonical-authority-target');
    assertOwnedTemporaryPath(outsideAuthorityRoot, repositoryRoot, 'outside canonical authority target root');
    assert.equal(resolve(outsideAuthorityRoot).startsWith(`${resolve(authorityRoot)}${sep}`), false,
      `${failure}: outside canonical authority target root must not be nested under the canonical authority root`);
    mkdirSync(outsideAuthorityRoot, { recursive: true });

    writeStructuralAuthority();
    const outsidePointerPath = join(outsideAuthorityRoot, 'current.json');
    writeFileSync(outsidePointerPath, malformedPointer, 'utf8');
    const removePointerLink = createOutsideAuthorityLink(locatorPath, outsidePointerPath, 'file', 'canonical pointer');
    assertRejected('canonical pointer link escaping the canonical authority root',
      'authority-reference-link-or-reparse-point-detected');
    removePointerLink();

    writeStructuralAuthority();
    const outsideRawSamplePath = join(outsideAuthorityRoot, 'sample.json');
    writeFileSync(outsideRawSamplePath, '{"sample":"outside-link"}', 'utf8');
    const removeRawArtifactLink = createOutsideAuthorityLink(
      rawSamplePath,
      outsideRawSamplePath,
      'file',
      'canonical generation raw artifact',
    );
    assertRejected('canonical generation raw artifact link escaping the canonical authority root',
      'authority-reference-link-or-reparse-point-detected');
    removeRawArtifactLink();

    const outsideGenerationAuthorityRoot = join(repositoryRoot, 'outside-canonical-generation-target');
    const outsideGenerationRoot = join(outsideGenerationAuthorityRoot, 'generations', generationId);
    assertOwnedTemporaryPath(outsideGenerationAuthorityRoot, repositoryRoot,
      'outside canonical generation authority root');
    assert.equal(resolve(outsideGenerationAuthorityRoot).startsWith(`${resolve(authorityRoot)}${sep}`), false,
      `${failure}: outside canonical generation authority root must not be nested under the canonical authority root`);
    writeStructuralAuthorityBundle(outsideGenerationAuthorityRoot);
    assert.equal(readJson(join(outsideGenerationAuthorityRoot, 'current.json')).generation_id, generationId,
      `${failure}: the external fixture must publish the same valid generation selected by the canonical pointer`);
    assert.equal(existsSync(join(outsideGenerationRoot, 'fair-scheduler-decision.json')), true,
      `${failure}: the external fixture must contain a valid generation decision artifact before link setup`);
    writeStructuralAuthority();
    assert.equal(readJson(locatorPath).generation_id, generationId,
      `${failure}: the canonical pointer must select the linked generation id`);
    createOutsideAuthorityLink(generationRoot, outsideGenerationRoot, 'directory',
      'canonical immutable generation directory');
    assertRejected('canonical immutable generation directory link escaping the canonical authority root',
      'authority-reference-link-or-reparse-point-detected');

    writeStructuralAuthority(true);
    const reversedRawManifestEntry = (readJson(rawManifestPath).entries as Record<string, unknown>[])[0] ?? {};
    const reversedTrialInventoryEntry = (readJson(provenancePath).trial_inventory as Record<string, unknown>[])[0] ?? {};
    assert.deepEqual(Object.keys(reversedRawManifestEntry), ['sha256', 'path'],
      `${failure}: the valid raw-manifest fixture must retain reversed entry insertion order`);
    assert.deepEqual(Object.keys(reversedTrialInventoryEntry), ['sha256', 'path'],
      `${failure}: the valid provenance fixture must retain reversed trial-inventory entry insertion order`);
    assertStructuralAuthority();

    writeStructuralAuthority();
    rmSync(decisionPath, { force: true });
    assertRejected('missing canonical decision artifact', 'authority-decision-missing');

    writeStructuralAuthority();
    rmSync(provenancePath, { force: true });
    assertRejected('missing canonical provenance artifact', 'authority-provenance-missing');

    writeStructuralAuthority();
    rmSync(rawManifestPath, { force: true });
    assertRejected('missing canonical raw manifest artifact', 'authority-raw-manifest-missing');

    writeStructuralAuthority();
    const malformedDecision = '{"evidence":';
    const malformedDecisionSha256 = hash(malformedDecision);
    writeFileSync(decisionPath, malformedDecision, 'utf8');
    rewriteProvenance(value => ({ ...value, decision_sha256: malformedDecisionSha256 }));
    writeJson(locatorPath, { ...readJson(locatorPath), decision_sha256: malformedDecisionSha256 });
    assertRejected('malformed canonical decision JSON', 'authority-decision-invalid-json');

    writeStructuralAuthority();
    const malformedProvenance = '{"provenance":';
    writeFileSync(provenancePath, malformedProvenance, 'utf8');
    writeJson(locatorPath, { ...readJson(locatorPath), provenance_sha256: hash(malformedProvenance) });
    assertRejected('malformed canonical provenance JSON', 'authority-provenance-invalid-json');

    writeStructuralAuthority();
    const malformedRawManifest = '{"entries":';
    const malformedRawManifestSha256 = hash(malformedRawManifest);
    writeFileSync(rawManifestPath, malformedRawManifest, 'utf8');
    rewriteProvenance(value => ({ ...value, raw_manifest_sha256: malformedRawManifestSha256 }));
    writeJson(locatorPath, { ...readJson(locatorPath), raw_manifest_sha256: malformedRawManifestSha256 });
    assertRejected('malformed canonical raw manifest JSON', 'authority-raw-manifest-invalid-json');

    for (const field of [
      'schema_version',
      'generation_id',
      'publication_generation',
      'decision_artifact',
      'decision_sha256',
      'provenance_artifact',
      'provenance_sha256',
      'raw_root',
      'raw_manifest_sha256',
    ] as const) {
      writeStructuralAuthority();
      writeJson(locatorPath, withoutField(readJson(locatorPath), field));
      assertRejected(`pointer missing required ${field}`, 'authority-pointer-required-field-missing');
    }

    for (const field of [
      'schema_version',
      'generation_id',
      'canonical_locator',
      'publication_generation',
      'decision_path',
      'decision_sha256',
      'provenance_path',
      'raw_root',
      'raw_manifest_path',
      'raw_manifest_sha256',
      'policy_digest',
      'trial_inventory',
    ] as const) {
      writeStructuralAuthority();
      rewriteProvenance(value => withoutField(value, field));
      assertRejected(`provenance missing required ${field}`, 'authority-provenance-required-field-missing');
    }

    for (const field of ['schema_version', 'generation_id', 'entries'] as const) {
      writeStructuralAuthority();
      rewriteRawManifest(value => withoutField(value, field));
      assertRejected(`raw manifest missing required ${field}`, 'authority-raw-manifest-required-field-missing');
    }

    for (const field of ['path', 'sha256'] as const) {
      writeStructuralAuthority();
      rewriteRawManifest(value => ({
        ...value,
        entries: [withoutField({ path: 'raw/sample.json', sha256: rawSampleSha256 }, field)],
      }));
      assertRejected(`raw manifest entry missing required ${field}`, 'authority-raw-entry-required-field-missing');
    }

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), schema_version: 'fair-scheduler-current-authority/v2' });
    assertRejected('invalid canonical pointer schema', 'authority-pointer-schema-invalid');

    writeStructuralAuthority();
    rewriteProvenance(value => ({
      ...value,
      schema_version: 'fair-scheduler-source-provenance/v2',
    }));
    assertRejected('invalid canonical provenance schema', 'authority-provenance-schema-invalid');

    writeStructuralAuthority();
    rewriteRawManifest(value => ({
      ...value,
      schema_version: 'fair-scheduler-raw-manifest/v2',
    }));
    assertRejected('invalid canonical raw manifest schema', 'authority-raw-manifest-schema-invalid');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), decision_sha256: 'not-a-sha256' });
    assertRejected('malformed pointer decision SHA-256', 'authority-decision-sha256-format-invalid');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), provenance_sha256: 'not-a-sha256' });
    assertRejected('malformed pointer provenance SHA-256', 'authority-provenance-sha256-format-invalid');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), raw_manifest_sha256: 'not-a-sha256' });
    assertRejected('malformed pointer raw manifest SHA-256', 'authority-raw-manifest-sha256-format-invalid');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, decision_sha256: 'not-a-sha256' }));
    assertRejected('malformed provenance decision SHA-256', 'authority-provenance-sha256-format-invalid');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, raw_manifest_sha256: 'not-a-sha256' }));
    assertRejected('malformed provenance raw manifest SHA-256', 'authority-raw-manifest-sha256-format-invalid');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, policy_digest: 'not-a-sha256' }));
    assertRejected('malformed provenance policy SHA-256', 'authority-policy-digest-format-invalid');

    writeStructuralAuthority();
    rewriteRawManifest(value => ({
      ...value,
      entries: [{ path: 'raw/sample.json', sha256: 'not-a-sha256' }],
    }));
    assertRejected('malformed raw manifest entry SHA-256', 'authority-raw-entry-sha256-format-invalid');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), generation_id: generationId.toUpperCase() });
    assertRejected('uppercase generation id', 'authority-generation-id-invalid');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), generation_id: 'not-a-sha256-generation-id' });
    assertRejected('malformed generation id', 'authority-generation-id-invalid');

    writeStructuralAuthority();
    renameSync(generationRoot, join(authorityRoot, 'generations', 'a'.repeat(64)));
    assertRejected('generation directory basename mismatch', 'authority-generation-directory-mismatch');

    writeStructuralAuthority();
    const alternateDecisionPath = join(generationRoot, 'alternate-decision.json');
    writeFileSync(alternateDecisionPath, decision, 'utf8');
    writeJson(locatorPath, { ...readJson(locatorPath), decision_artifact: 'alternate-decision.json' });
    assertRejected('safe noncanonical pointer decision artifact', 'authority-pointer-canonical-path-mismatch');

    writeStructuralAuthority();
    const alternateProvenancePath = join(generationRoot, 'alternate-provenance.json');
    const alternateProvenance = readFileSync(provenancePath, 'utf8');
    writeFileSync(alternateProvenancePath, alternateProvenance, 'utf8');
    writeJson(locatorPath, {
      ...readJson(locatorPath),
      provenance_artifact: 'alternate-provenance.json',
      provenance_sha256: hash(alternateProvenance),
    });
    assertRejected('safe noncanonical pointer provenance artifact', 'authority-pointer-canonical-path-mismatch');

    writeStructuralAuthority();
    writeFileSync(alternateDecisionPath, decision, 'utf8');
    rewriteProvenance(value => ({ ...value, decision_path: 'alternate-decision.json' }));
    assertRejected('safe noncanonical provenance decision path', 'authority-provenance-canonical-path-mismatch');

    writeStructuralAuthority();
    const alternateRawManifestPath = join(generationRoot, 'raw', 'alternate-manifest.json');
    writeFileSync(alternateRawManifestPath, readFileSync(rawManifestPath, 'utf8'), 'utf8');
    rewriteProvenance(value => ({ ...value, raw_manifest_path: 'raw/alternate-manifest.json' }));
    assertRejected('safe noncanonical provenance raw manifest path', 'authority-provenance-canonical-path-mismatch');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, provenance_path: 'alternate-provenance.json' }));
    assertRejected('safe noncanonical provenance self path', 'authority-provenance-canonical-path-mismatch');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, raw_root: 'alternate-raw/' }));
    writeJson(locatorPath, { ...readJson(locatorPath), raw_root: 'alternate-raw/' });
    assertRejected('safe noncanonical canonical raw root', 'authority-pointer-canonical-path-mismatch');

    for (const [scenario, field, reference] of [
      ['escaped POSIX pointer decision artifact', 'decision_artifact', '../historical/fair-scheduler-decision.json'],
      ['escaped Windows pointer decision artifact', 'decision_artifact', '..\\historical\\fair-scheduler-decision.json'],
      ['escaped POSIX pointer provenance artifact', 'provenance_artifact', '../historical/provenance.json'],
      ['escaped Windows pointer provenance artifact', 'provenance_artifact', '..\\historical\\provenance.json'],
      ['escaped POSIX pointer raw root', 'raw_root', '../historical/raw/'],
      ['escaped Windows pointer raw root', 'raw_root', '..\\historical\\raw\\'],
    ] as const) {
      writeStructuralAuthority();
      writeJson(locatorPath, { ...readJson(locatorPath), [field]: reference });
      assertRejected(scenario, 'authority-pointer-reference-invalid');
    }

    for (const [scenario, field, reference] of [
      ['escaped POSIX provenance decision path', 'decision_path', '../historical/fair-scheduler-decision.json'],
      ['escaped Windows provenance decision path', 'decision_path', '..\\historical\\fair-scheduler-decision.json'],
      ['escaped POSIX provenance self path', 'provenance_path', '../historical/provenance.json'],
      ['escaped Windows provenance self path', 'provenance_path', '..\\historical\\provenance.json'],
      ['escaped POSIX provenance raw root', 'raw_root', '../historical/raw/'],
      ['escaped Windows provenance raw root', 'raw_root', '..\\historical\\raw\\'],
      ['escaped POSIX provenance raw manifest path', 'raw_manifest_path', '../historical/manifest.json'],
      ['escaped Windows provenance raw manifest path', 'raw_manifest_path', '..\\historical\\manifest.json'],
    ] as const) {
      writeStructuralAuthority();
      rewriteProvenance(value => ({ ...value, [field]: reference }));
      assertRejected(scenario, 'authority-provenance-reference-invalid');
    }

    for (const [scenario, path] of [
      ['escaped POSIX raw entry', 'raw/../escaped.json'],
      ['escaped Windows raw entry', 'raw\\..\\escaped.json'],
      ['absolute POSIX raw entry', '/raw/absolute.json'],
      ['absolute Windows raw entry', 'C:\\raw\\absolute.json'],
    ] as const) {
      writeStructuralAuthority();
      rewriteRawManifest(value => ({
        ...value,
        entries: [{ path, sha256: 'd'.repeat(64) }],
      }));
      assertRejected(scenario, 'authority-raw-entry-reference-invalid');
    }

    writeStructuralAuthority();
    const outsideRawSample = '{"sample":"outside-raw"}';
    const outsideRawSampleSha256 = hash(outsideRawSample);
    const outsideRawManifestEntries: readonly RawManifestEntry[] = [{
      path: 'outside-raw.json',
      sha256: outsideRawSampleSha256,
    }];
    const outsideRawGenerationId = hash(deriveGenerationInput({
      rawManifestEntries: outsideRawManifestEntries,
      trialInventory: outsideRawManifestEntries,
    }));
    writeFileSync(join(generationRoot, 'outside-raw.json'), outsideRawSample, 'utf8');
    rewriteRawManifest(value => ({
      ...value,
      generation_id: outsideRawGenerationId,
      entries: outsideRawManifestEntries,
    }));
    rewriteProvenance(value => ({
      ...value,
      generation_id: outsideRawGenerationId,
      trial_inventory: outsideRawManifestEntries,
    }));
    writeJson(locatorPath, { ...readJson(locatorPath), generation_id: outsideRawGenerationId });
    renameSync(generationRoot, join(generationsRoot, outsideRawGenerationId));
    assertRejected('safe generation-contained raw entry outside raw root', 'authority-raw-entry-reference-invalid');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, generation_id: 'c'.repeat(64) }));
    assertRejected('provenance generation binding mismatch', 'authority-provenance-generation-mismatch');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, publication_generation: 'other-publication' }));
    assertRejected('provenance publication binding mismatch', 'authority-provenance-publication-generation-mismatch');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, canonical_locator: 'docs/analysis/historical/current.json' }));
    assertRejected('provenance canonical locator binding mismatch', 'authority-provenance-canonical-locator-mismatch');

    writeStructuralAuthority();
    rewriteRawManifest(value => ({ ...value, generation_id: 'c'.repeat(64) }));
    assertRejected('raw manifest generation binding mismatch', 'authority-raw-manifest-generation-mismatch');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, decision_sha256: '0'.repeat(64) }));
    assertRejected('provenance decision hash mismatch', 'authority-decision-sha256-mismatch');

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, raw_manifest_sha256: '0'.repeat(64) }));
    assertRejected('provenance raw manifest hash mismatch', 'authority-raw-manifest-sha256-mismatch');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), raw_manifest_sha256: '0'.repeat(64) });
    assertRejected('pointer raw manifest hash mismatch', 'authority-raw-manifest-sha256-mismatch');

    writeStructuralAuthority();
    writeJson(locatorPath, { ...readJson(locatorPath), decision_sha256: '0'.repeat(64) });
    assertRejected('tampered decision hash', 'authority-decision-sha256-mismatch');

    writeStructuralAuthority();
    writeFileSync(provenancePath, `${readFileSync(provenancePath, 'utf8')} `, 'utf8');
    assertRejected('tampered provenance hash', 'authority-provenance-sha256-mismatch');

    writeStructuralAuthority();
    writeFileSync(rawManifestPath, `${readFileSync(rawManifestPath, 'utf8')} `, 'utf8');
    assertRejected('tampered raw manifest hash', 'authority-raw-manifest-sha256-mismatch');

    writeStructuralAuthority();
    writeFileSync(rawSamplePath, '{"sample":"tampered"}', 'utf8');
    assertRejected('tampered raw manifest entry hash', 'authority-raw-entry-sha256-mismatch');

    writeStructuralAuthority();
    const rederivedRawSample = '{"sample":"rederived"}';
    const rederivedRawSampleSha256 = hash(rederivedRawSample);
    const rederivedRawManifestEntries: readonly RawManifestEntry[] = [{
      path: 'raw/sample.json',
      sha256: rederivedRawSampleSha256,
    }];
    const originalTrialInventory = readJson(provenancePath).trial_inventory;
    writeFileSync(rawSamplePath, rederivedRawSample, 'utf8');
    rewriteRawManifest(value => ({
      ...value,
      entries: rederivedRawManifestEntries,
    }));
    assert.deepEqual(readJson(provenancePath).trial_inventory, originalTrialInventory,
      `${failure}: raw-entry rederivation must leave the stale trial inventory unchanged`);
    assert.notEqual(
      hash(deriveGenerationInput({
        rawManifestEntries: rederivedRawManifestEntries,
        trialInventory: originalTrialInventory as RawManifestEntry[],
      })),
      generationId,
      `${failure}: actual raw-manifest entries must derive a distinct generation id when their content changes`,
    );
    assert.deepEqual(resolver.validate({ expectedPolicyDigest }), {
      accepted: false,
      reason: 'authority-generation-id-mismatch',
    }, `${failure}: a raw-manifest mutation must fail when its derived generation id is stale`);

    writeStructuralAuthority();
    rewriteProvenance(value => ({ ...value, policy_digest: 'c'.repeat(64) }));
    assertRejected('policy digest mismatch', 'authority-policy-digest-mismatch');

    writeStructuralAuthority();
    const staleGenerationPolicyDigest = 'c'.repeat(64);
    rewriteProvenance(value => ({ ...value, policy_digest: staleGenerationPolicyDigest }));
    assert.deepEqual(resolver.validate({ expectedPolicyDigest: staleGenerationPolicyDigest }), {
      accepted: false,
      reason: 'authority-generation-id-mismatch',
    }, `${failure}: a consistently bound stale generation id must fail after RFC8785/JCS rederivation`);

    writeStructuralAuthority();
    const staleTrialInventory = [
      { sha256: rawSampleSha256, path: 'raw/sample.json' },
      { sha256: additionalRawSampleSha256, path: 'raw/additional-sample.json' },
    ];
    const rawManifestBeforeTrialMutation = readFileSync(rawManifestPath, 'utf8');
    rewriteProvenance(value => ({ ...value, trial_inventory: staleTrialInventory }));
    assert.equal(readFileSync(rawManifestPath, 'utf8'), rawManifestBeforeTrialMutation,
      `${failure}: a trial-inventory mutation must not alter raw manifest entries or their digest input`);
    assert.deepEqual(resolver.validate({ expectedPolicyDigest }), {
      accepted: false,
      reason: 'authority-generation-id-mismatch',
    }, `${failure}: a fully bound stale trial inventory must fail after RFC8785/JCS rederivation`);

    writeStructuralAuthority();
    const metadataRepositoryRoot = mkdtempSync(join(tmpdir(), 'buildergate-fair-jcs-metadata-'));
    const metadataAuthorityRoot = join(
      metadataRepositoryRoot,
      'docs',
      'analysis',
      'terminal-fairness-authority',
    );
    const metadataCanonicalizeJcs = (value: unknown): string => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) {
        return `[${value.map(metadataCanonicalizeJcs).join(',')}]`;
      }
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map(key => `${JSON.stringify(key)}:${metadataCanonicalizeJcs(record[key])}`)
          .join(',')}}`;
      }
      return assert.fail(`${failure}: independent JCS fixture values must be JSON values`);
    };
    type MetadataManifestEntry = {
      metadata: string;
      path: string;
      sha256: string;
    };
    const metadataEntryV1: MetadataManifestEntry = {
      metadata: 'fixture-metadata-v1',
      path: 'raw/sample.json',
      sha256: rawSampleSha256,
    };
    const metadataTrialInventoryV1: readonly MetadataManifestEntry[] = [{ ...metadataEntryV1 }];
    const metadataRawManifestEntriesV1: readonly MetadataManifestEntry[] = [{ ...metadataEntryV1 }];
    const deriveMetadataGenerationId = (input: {
      rawManifestEntries: readonly MetadataManifestEntry[];
      trialInventory: readonly MetadataManifestEntry[];
    }) => {
      const rawEntriesCanonical = metadataCanonicalizeJcs(input.rawManifestEntries);
      const generationInput = metadataCanonicalizeJcs({
        decision_sha256: decisionSha256,
        policy_digest: expectedPolicyDigest,
        raw_entries_digest: hash(rawEntriesCanonical),
        schema_version: 'fair-scheduler-current-authority/v1',
        trial_inventory: input.trialInventory,
      });
      return {
        generationId: hash(generationInput),
        generationInput,
        rawEntriesCanonical,
      };
    };
    const metadataGeneration = deriveMetadataGenerationId({
      rawManifestEntries: metadataRawManifestEntriesV1,
      trialInventory: metadataTrialInventoryV1,
    });
    assert.equal(
      metadataGeneration.rawEntriesCanonical,
      `[{"metadata":"fixture-metadata-v1","path":"raw/sample.json","sha256":"${rawSampleSha256}"}]`,
      `${failure}: independent JCS raw-entry input must include every benign entry member`,
    );
    assert.equal(
      metadataGeneration.generationInput,
      `{"decision_sha256":"${decisionSha256}","policy_digest":"${expectedPolicyDigest}","raw_entries_digest":"${hash(metadataGeneration.rawEntriesCanonical)}","schema_version":"fair-scheduler-current-authority/v1","trial_inventory":${metadataGeneration.rawEntriesCanonical}}`,
      `${failure}: independent JCS trial inventory must include every benign entry member`,
    );
    const metadataGenerationRoot = join(
      metadataAuthorityRoot,
      'generations',
      metadataGeneration.generationId,
    );
    const metadataLocatorPath = join(metadataAuthorityRoot, 'current.json');
    const metadataDecisionPath = join(metadataGenerationRoot, 'fair-scheduler-decision.json');
    const metadataProvenancePath = join(metadataGenerationRoot, 'provenance.json');
    const metadataRawManifestPath = join(metadataGenerationRoot, 'raw', 'manifest.json');
    const metadataRawSamplePath = join(metadataGenerationRoot, 'raw', 'sample.json');
    try {
      mkdirSync(join(metadataGenerationRoot, 'raw'), { recursive: true });
      const metadataRawManifest = JSON.stringify({
        schema_version: 'fair-scheduler-raw-manifest/v1',
        generation_id: metadataGeneration.generationId,
        entries: metadataRawManifestEntriesV1,
      });
      const metadataProvenance = JSON.stringify({
        schema_version: 'fair-scheduler-source-provenance/v1',
        generation_id: metadataGeneration.generationId,
        canonical_locator: canonicalLocator,
        publication_generation: publicationGeneration,
        decision_path: 'fair-scheduler-decision.json',
        decision_sha256: decisionSha256,
        provenance_path: 'provenance.json',
        raw_root: 'raw/',
        raw_manifest_path: 'raw/manifest.json',
        raw_manifest_sha256: hash(metadataRawManifest),
        policy_digest: expectedPolicyDigest,
        trial_inventory: metadataTrialInventoryV1,
      });
      const metadataLocator = JSON.stringify({
        schema_version: 'fair-scheduler-current-authority/v1',
        generation_id: metadataGeneration.generationId,
        publication_generation: publicationGeneration,
        decision_artifact: 'fair-scheduler-decision.json',
        decision_sha256: decisionSha256,
        provenance_artifact: 'provenance.json',
        provenance_sha256: hash(metadataProvenance),
        raw_root: 'raw/',
        raw_manifest_sha256: hash(metadataRawManifest),
      });
      writeFileSync(metadataDecisionPath, decision, 'utf8');
      writeFileSync(metadataProvenancePath, metadataProvenance, 'utf8');
      writeFileSync(metadataRawManifestPath, metadataRawManifest, 'utf8');
      writeFileSync(metadataRawSamplePath, rawSample, 'utf8');
      writeFileSync(metadataLocatorPath, metadataLocator, 'utf8');

      const metadataResolver = createResolver!({ repositoryRoot: metadataRepositoryRoot });
      assert.deepEqual(metadataResolver.validate({ expectedPolicyDigest }), {
        accepted: true,
        evidenceRoot: metadataGenerationRoot,
        generationId: metadataGeneration.generationId,
        locatorPath: metadataLocatorPath,
        logicalLocator: canonicalLocator,
        publicationGeneration,
        reason: 'authority-locator-verified',
      }, `${failure}: a full-object JCS generation id must accept its valid canonical authority`);

      const metadataEntryV2: MetadataManifestEntry = {
        ...metadataEntryV1,
        metadata: 'fixture-metadata-v2',
      };
      const metadataRawManifestEntriesV2: readonly MetadataManifestEntry[] = [{ ...metadataEntryV2 }];
      const metadataTrialInventoryV2: readonly MetadataManifestEntry[] = [{ ...metadataEntryV2 }];
      const staleMetadataGeneration = deriveMetadataGenerationId({
        rawManifestEntries: metadataRawManifestEntriesV2,
        trialInventory: metadataTrialInventoryV2,
      });
      assert.notEqual(staleMetadataGeneration.generationId, metadataGeneration.generationId,
        `${failure}: independent JCS generation input must bind the benign metadata member`);
      const staleMetadataRawManifest = JSON.stringify({
        ...readJson(metadataRawManifestPath),
        entries: metadataRawManifestEntriesV2,
      });
      const staleMetadataProvenance = JSON.stringify({
        ...readJson(metadataProvenancePath),
        raw_manifest_sha256: hash(staleMetadataRawManifest),
        trial_inventory: metadataTrialInventoryV2,
      });
      const staleMetadataLocator = JSON.stringify({
        ...readJson(metadataLocatorPath),
        provenance_sha256: hash(staleMetadataProvenance),
        raw_manifest_sha256: hash(staleMetadataRawManifest),
      });
      writeFileSync(metadataRawManifestPath, staleMetadataRawManifest, 'utf8');
      writeFileSync(metadataProvenancePath, staleMetadataProvenance, 'utf8');
      writeFileSync(metadataLocatorPath, staleMetadataLocator, 'utf8');
      assert.equal(readJson(metadataRawManifestPath).generation_id, metadataGeneration.generationId,
        `${failure}: the extra-member mutation must preserve the stale raw-manifest generation binding`);
      assert.equal(readJson(metadataProvenancePath).generation_id, metadataGeneration.generationId,
        `${failure}: the extra-member mutation must preserve the stale provenance generation binding`);
      assert.equal(readJson(metadataLocatorPath).generation_id, metadataGeneration.generationId,
        `${failure}: the extra-member mutation must preserve the stale pointer generation binding`);
      const staleMetadataRawEntry = ((readJson(metadataRawManifestPath).entries as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
      assert.equal(staleMetadataRawEntry.path, metadataEntryV1.path,
        `${failure}: the extra-member mutation must preserve the raw entry path`);
      assert.equal(staleMetadataRawEntry.sha256, metadataEntryV1.sha256,
        `${failure}: the extra-member mutation must preserve the raw entry SHA-256`);
      assert.equal(hash(readFileSync(metadataRawSamplePath, 'utf8')), rawSampleSha256,
        `${failure}: the extra-member mutation must preserve the raw artifact SHA-256`);
      assert.equal(readJson(metadataProvenancePath).decision_path, 'fair-scheduler-decision.json',
        `${failure}: the extra-member mutation must preserve the canonical decision path`);
      assert.equal(readJson(metadataProvenancePath).decision_sha256, decisionSha256,
        `${failure}: the extra-member mutation must preserve the decision SHA-256`);
      assert.equal(hash(readFileSync(metadataDecisionPath, 'utf8')), decisionSha256,
        `${failure}: the extra-member mutation must preserve the decision artifact SHA-256`);
      assert.equal(readJson(metadataProvenancePath).raw_manifest_sha256, hash(staleMetadataRawManifest),
        `${failure}: the extra-member mutation must retain the bound raw-manifest SHA-256`);
      assert.equal(readJson(metadataLocatorPath).provenance_sha256, hash(staleMetadataProvenance),
        `${failure}: the extra-member mutation must retain the bound provenance SHA-256`);
      assert.equal(readJson(metadataLocatorPath).raw_manifest_sha256, hash(staleMetadataRawManifest),
        `${failure}: the extra-member mutation must retain the pointer raw-manifest SHA-256`);
      assert.deepEqual(metadataResolver.validate({ expectedPolicyDigest }), {
        accepted: false,
        reason: 'authority-generation-id-mismatch',
      }, `${failure}: an extra-member mutation with all pointer and provenance hashes rebound must fail stale generation-id validation`);
    } finally {
      rmSync(metadataRepositoryRoot, { recursive: true, force: true });
      writeStructuralAuthority();
    }

    writeStructuralAuthority();
    unlinkSync(rawSamplePath);
    assertRejected('incomplete raw entry', 'authority-raw-entry-missing');

    writeStructuralAuthority();
    writeFileSync(join(generationRoot, 'raw', 'unmanifested.json'), '{"sample":"unmanifested"}', 'utf8');
    assertRejected('unmanifested raw entry', 'authority-raw-entry-unmanifested');

    writeStructuralAuthority();
    const nestedUnmanifestedRawPath = join(generationRoot, 'raw', 'nested', 'unmanifested.json');
    mkdirSync(join(generationRoot, 'raw', 'nested'), { recursive: true });
    writeFileSync(nestedUnmanifestedRawPath, '{"sample":"nested-unmanifested"}', 'utf8');
    assertRejected('nested unmanifested raw entry', 'authority-raw-entry-unmanifested');
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 fresh default Canary accepts canonical authority', async () => {
  type AuthorityLocator = {
    locatorPath: string;
    logicalLocator: string;
  };
  type AuthorityResolver = {
    getLocator(): AuthorityLocator;
  };
  type AuthorityModule = {
    createFairSchedulerEvidenceAuthorityResolver?: (input?: { repositoryRoot?: string }) => AuthorityResolver;
  };
  const module = await import(CANARY_MODULE_PATH) as {
    validatePublishedFairDeliveryCandidateArtifact?: (input?: { runtimePolicy?: unknown }) => {
      accepted: boolean;
      reason: string;
    };
  };
  const authorityModule = await import('../benchmarks/terminalFairnessCharacterization.js') as AuthorityModule;
  const failure = 'PERF-BGSTAB-010 default Canary must accept a freshly published canonical authority';
  const createResolver = authorityModule.createFairSchedulerEvidenceAuthorityResolver;
  const validate = module.validatePublishedFairDeliveryCandidateArtifact;
  const source = readFileSync(new URL('./TerminalResourcePolicyCanary.ts', import.meta.url), 'utf8');
  const defaultFactoryBinding = source.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*createPublishedFairDeliveryCandidateArtifactValidator\(\s*\)\s*;/u,
  );
  const publicAdmissionStart = source.indexOf('export function validatePublishedFairDeliveryCandidateArtifact');
  assert.match(source, /createFairSchedulerEvidenceAuthorityResolver/u,
    `${failure}: the source factory must resolve the canonical authority without a legacy evidence root`);
  assert.notEqual(publicAdmissionStart, -1,
    `${failure}: the public default Canary admission must remain present`);
  const publicAdmissionSource = source.slice(publicAdmissionStart, publicAdmissionStart + 2_000);
  const callsBoundDefaultValidator = defaultFactoryBinding !== null
    && new RegExp(`\\b${defaultFactoryBinding[1]}\\(\\s*\\)`, 'u').test(publicAdmissionSource);
  const createsAndCallsDefaultValidator = /createPublishedFairDeliveryCandidateArtifactValidator\(\s*\)\s*\(\s*\)/u
    .test(publicAdmissionSource);
  assert.equal(callsBoundDefaultValidator || createsAndCallsDefaultValidator, true,
    `${failure}: the public default Canary call must reach the canonical validator factory result`);
  assert.equal(typeof createResolver, 'function',
    `${failure}: canonical-locator resolver factory must be available to the default source runtime`);
  assert.equal(typeof validate, 'function', failure);
  const locator = createResolver!().getLocator();
  assert.equal(locator.logicalLocator, 'docs/analysis/terminal-fairness-authority/current.json',
    `${failure}: the accepted authority must be published at the canonical logical locator`);
  assert.equal(existsSync(locator.locatorPath), true,
    `${failure}: PH001-05 must publish current canonical authority before default Canary admission`);
  assert.deepEqual(validate!(), {
    accepted: true,
    reason: 'decision-artifact-verified',
  }, `${failure}: default Canary must use its canonical locator without a caller root override`);
});
