import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ensureDebugCaptureSessionExists,
  requireLocalDebugCapture,
} from '../middleware/debugCaptureGuards.js';
import { SessionManager } from './SessionManager.js';
import {
  createHeadlessTerminalState,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from '../utils/headlessTerminal.js';
import {
  createWsTransportMessage,
  createWsTransportQueueState,
  getTransportMessagesInPriorityOrder,
  pushTransportMessage,
  type WsTransportQueueState,
} from '../ws/wsSendPolicy.js';
import { config } from '../utils/config.js';
import * as wsRouterModule from '../ws/WsRouter.js';
import { jsonWirePayloadText } from '../ws/wirePayload.js';

type AuthorityMode = 'legacy' | 'promoting' | 'server' | 'rolling-back' | 'aborted';
type IngestOwner = 'legacy-browser' | 'server-headless-staged' | 'server-headless';

interface ResponderViewIdentity {
  connectionId: string;
  viewGeneration: number;
  responderLeaseId: string;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  driverLeaseGeneration: string;
  acceptedViewAttributesGeneration: string;
}

interface ResponderIdentity extends ResponderViewIdentity {
  sessionId: string;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  boundarySourceSeq: string;
}

interface CompatibilityResponderSelectionIdentity extends ResponderViewIdentity {
  driverLeaseId: string;
}

interface PromotionGates {
  retainedStateParity: boolean;
  factParity: boolean;
  leaseParity: boolean;
  noLocalCacheParity: boolean;
  limitedSessionSelected: boolean;
  allRespondersCapable: boolean;
  replayRepairIdle: boolean;
}

interface PromotionRequest {
  sessionId: string;
  authorityEpoch: string;
  previousStreamEpoch: string;
  nextStreamEpoch: string;
  transitionEpoch: string;
  oldResponderLeaseId: string;
  nextResponderLeaseId: string;
  nextDriverLeaseId: string;
}

interface AuthorityEvent {
  type: string;
  kind?: string;
  lane?: string;
  sessionId?: string;
  sourceSeq?: string;
  streamEpoch?: string;
  transitionEpoch?: string;
  connectionId?: string;
  viewGeneration?: number;
  responderLeaseId?: string;
  driverLeaseId?: string;
  owner?: IngestOwner;
  recordId?: string;
  effectKey?: string;
  data?: string;
  outputDataSha256?: string;
  outputByteLength?: number;
}

type AuthorityEffect =
  | { type: 'new-admission-stopped'; sessionId: string; transitionEpoch: string }
  | { type: 'server-responder-enabled-set'; enabled: false; responderLeaseId: string }
  | { type: 'server-responder-lease-revoked'; responderLeaseId: string }
  | { type: 'server-driver-lease-revoked'; driverLeaseId: string }
  | { type: 'affected-view-stale'; connectionId: string; viewGeneration: number }
  | { type: 'browser-parser-reset'; connectionId: string; viewGeneration: number }
  | { type: 'old-ack-backlog-purged'; sessionId: string; transitionEpoch: string }
  | { type: 'compatibility-driver-lease-rebound'; driverLeaseId: string }
  | { type: 'compatibility-responder-lease-rebound'; responderLeaseId: string };

interface AuthorityState {
  mode: AuthorityMode;
  sessionId: string;
  authorityEpoch: string;
  streamEpoch: string;
  transitionEpoch: string | null;
  activeResponder: 'legacy-browser' | 'server-headless' | null;
  activeResponderLeaseId: string | null;
  activeDriverLeaseId: string | null;
  legacyResponderEnabled: boolean;
  serverResponderEnabled: boolean;
  admissionOpen: 'legacy' | 'server' | 'none';
  frozenRequiredResponderCount: number;
  acceptedDisableAckCount: number;
  heldPostBoundaryCount: number;
  pendingDeliveryBytes: number;
  pendingDeliveryChunks: number;
  restartRequired: boolean;
  ptyPaused: boolean;
  hiddenDeliveryLossy: boolean;
  sessionStatus: 'idle' | 'running' | 'terminated';
}

interface PromotionResult {
  ok: boolean;
  reason?: string;
  transitionEpoch?: string;
  streamEpoch?: string;
  boundarySourceSeq?: string;
  requiredResponderCount?: number;
}

interface AckResult {
  accepted: boolean;
  duplicate?: boolean;
  completed?: boolean;
  reason?: string;
}

interface CapturedOutput {
  recordId: string;
  sourceSeq: string;
  streamEpoch: string;
  responderLeaseId: string;
  ingestOwner: IngestOwner;
  modelCommitted: boolean;
  factCommitted: boolean;
  deliveryDisposition: 'legacy-delivered' | 'held-post-boundary' | 'server-delivered' | 'compatibility-delivered';
}

interface EnqueuedHeadlessOutput {
  recordId: string;
  sourceSeq: string;
  ingestOwnerToken: IngestOwner;
  ownerSelectedAt: 'enqueue';
}

interface AppliedHeadlessOutput extends CapturedOutput {
  ingestOwnerToken: IngestOwner;
  commitOwner: 'legacy-browser' | 'server-headless';
  ownerSelectedAt: 'enqueue';
}

interface QueryEffectResult {
  disposition: 'applied' | 'duplicate' | 'legacy-owned' | 'held-for-legacy' | 'rejected' | 'failed';
  owner: IngestOwner;
  effectKey: string;
}

interface TerminalAuthorityController {
  enqueueHeadlessOutput(input: { sourceSeq: string; data: string; hidden?: boolean }): EnqueuedHeadlessOutput;
  applyEnqueuedHeadlessOutput(recordId: string): Promise<AppliedHeadlessOutput> | AppliedHeadlessOutput;
  beginPromotion(request: PromotionRequest): Promise<PromotionResult> | PromotionResult;
  acknowledgeLegacyDisable(identity: ResponderIdentity): Promise<AckResult> | AckResult;
  captureHeadlessOutput(input: { sourceSeq: string; data: string; hidden?: boolean }): Promise<CapturedOutput> | CapturedOutput;
  settleQueryEffect(input: {
    recordId: string;
    replyOrdinal: number;
    reply: string;
    streamEpoch: string;
    responderLeaseId: string;
  }): Promise<QueryEffectResult> | QueryEffectResult;
  acceptLegacyBrowserQueryReply(input: ResponderIdentity & { replyOrdinal: number; reply: string }): Promise<AckResult> | AckResult;
  rejectBrowserParserTail(input: { transitionEpoch: string; parserTail: string }): Promise<{ accepted: false; reason: string }> | { accepted: false; reason: string };
  recoverView(input: { connectionId: string; viewGeneration: number; cacheState: 'absent' | 'poisoned' }): Promise<{
    ok: boolean;
    source: 'server-checkpoint';
    localCacheUsed: false;
    retainedStateHash: string;
    checkpointEpoch: string;
    snapshotSeq: string;
    postSnapshotOutput: readonly string[];
  }>;
  beginRollback(input: {
    transitionEpoch: string;
    nextStreamEpoch: string;
    compatibilityCheckpointEpoch: string;
    nextCompatibilityResponderLeaseId: string;
    nextCompatibilityDriverLeaseId: string;
    nextCompatibilityDriverLeaseGeneration: string;
    nextAcceptedViewAttributesGeneration: string;
    selectedCompatibilityResponder: CompatibilityResponderSelectionIdentity;
  }): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  acknowledgeCompatibilityDrain(input: {
    connectionId: string;
    viewGeneration: number;
    transitionEpoch: string;
    authorityEpoch: string;
    streamEpoch: string;
    responderLeaseId: string;
    boundarySourceSeq: string;
    checkpointEpoch: string;
    drainedThroughSourceSeq: string;
    checkpointApplied: boolean;
    postSnapshotTailDrained: boolean;
  }): Promise<{ accepted: boolean; duplicate?: boolean; completed: boolean; reason?: string }>;
  notifyResponderTopologyChanged(input: {
    transitionEpoch: string;
    kind: 'new-view' | 'generation-changed' | 'disconnect' | 'unsubscribe';
    connectionId: string;
    viewGeneration: number;
  }): Promise<{ aborted: boolean; restartRequired: boolean; reason: string }>;
  observeInteractiveInput(input: { kind: 'user-input' | 'local-echo' | 'prompt-redraw' }): Promise<{ sessionStatus: 'idle' | 'running' | 'terminated' }>;
  checkPromotionDeadline(): { abortRequired: boolean; reason?: string };
  getState(): AuthorityState;
}

interface ContractModule {
  createTerminalAuthorityController(options: {
    initial: {
      sessionId: string;
      authorityEpoch: string;
      streamEpoch: string;
      sessionGeneration: string;
      legacyResponderLeaseId: string;
      legacyDriverLeaseId: string;
      sessionStatus: 'idle';
    };
    readPromotionGates: () => PromotionGates;
    listRequiredResponderViews: () => readonly ResponderViewIdentity[];
    readLastCommittedSourceSeq: () => string;
    readPromotionSafetyLimits: () => {
      ackDeadlineMs: number;
      maxHeldOutputBytes: number;
      maxHeldOutputChunks: number;
    };
    now: () => number;
    onOrderedCompatibilityRecoveryRequired: (reason: string) => void;
    enqueueTerminalMessage: (message: object) => void;
    emit: (event: AuthorityEvent) => void;
    loadAuthoritativeRecovery: () => {
      retainedStateHash: string;
      checkpointEpoch: string;
      snapshotSeq: string;
      checkpointMessages: readonly object[];
      postSnapshotOutput: readonly string[];
    };
    loadCompatibilityRecovery: (input: {
      transitionEpoch: string;
      streamEpoch: string;
      checkpointEpoch: string;
    }) => {
      snapshotSeq: string;
      checkpointMessages: readonly object[];
    };
    onLegacyDisableQuorumAccepted?: () => boolean | Promise<boolean>;
    stopNewAdmission: (input: { sessionId: string; transitionEpoch: string }) => void;
    setServerResponderEnabled: (input: { enabled: false; responderLeaseId: string }) => void;
    revokeServerResponderLease: (input: { responderLeaseId: string }) => void;
    revokeServerDriverLease: (input: { driverLeaseId: string }) => void;
    markAffectedViewStale: (view: Pick<ResponderViewIdentity, 'connectionId' | 'viewGeneration'>) => void;
    resetAffectedViewParser: (view: Pick<ResponderViewIdentity, 'connectionId' | 'viewGeneration'>) => void;
    purgeOldAckBacklog: (input: { sessionId: string; transitionEpoch: string }) => void;
    rebindCompatibilityDriverLease: (input: { driverLeaseId: string }) => void;
    rebindCompatibilityResponderLease: (input: { responderLeaseId: string }) => void;
    commitLegacyResponderIdentity: (input: ResponderIdentity & { driverLeaseId: string }) => void;
    hasCompatibilityTailPhysicallyDrained: (input: {
      connectionId: string;
      viewGeneration: number;
      transitionEpoch: string;
      authorityEpoch: string;
      streamEpoch: string;
      responderLeaseId: string;
      boundarySourceSeq: string;
      checkpointEpoch: string;
      drainedThroughSourceSeq: string;
    }) => boolean;
    transferHeldQueryToLegacyResponder: (effect: {
      effectKey: string;
      sourceSeq: string;
      reply: string;
      responderLeaseId: string;
      clientId?: string;
      viewGeneration: number;
    }) => void;
    writeTerminalQueryReply: (effect: {
      effectKey: string;
      sourceSeq: string;
      reply: string;
      owner: 'server-headless';
    }) => void;
    writeLegacyBrowserQueryReply: (effect: { reply: string; identity: ResponderIdentity }) => void;
  }): TerminalAuthorityController;
}

interface ProductionTerminalAuthorityWiringEvidence {
  source: 'production-default';
  sessionManagerBoundToRouter: true;
  controllerFactory: 'production-terminal-authority-controller';
  retainedCheckpointAdapter: 'session-manager-retained-terminal';
  checkpointDigestAdapter: 'sha256';
  controllerFactoryCallCount: number;
  retainedCheckpointAdapterCallCount: number;
  checkpointDigestAdapterCallCount: number;
  injectedControllerFactory: false;
  injectedCheckpointAssembler: false;
}

interface ProductionTerminalAuthorityIntegration {
  sessionManager: SessionManager;
  wsRouter: wsRouterModule.WsRouter;
  beginPromotion(sessionId: string): Promise<PromotionResult> | PromotionResult;
  beginRollback(input: {
    sessionId: string;
    selectedCompatibilityView: {
      connectionId: string;
      viewGeneration: number;
    };
  }): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  beginRollback(sessionId: string): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  getAuthorityState(sessionId: string): AuthorityState | undefined;
  getAuthorityAuditTrail(sessionId: string): readonly AuthorityEvent[];
  getWiringEvidence(sessionId: string): ProductionTerminalAuthorityWiringEvidence;
  getQueryResponderCapabilityState(sessionId: string): {
    promotionEligible: boolean;
    blocker?: string;
    hasAcceptedViewAttributes: boolean;
  } | null;
  requestQueryResponderCapabilityRefresh(sessionId: string): Promise<boolean>;
  destroy(): void;
}

interface ProductionTerminalAuthorityIntegrationModule {
  TERMINAL_AUTHORITY_DEFAULT_ACK_DEADLINE_MS: number;
  getTerminalAuthorityPromotionAckTimerDelayMs(configuredAckDeadlineMs?: number): number;
  isScheduledTerminalAuthorityRuntimeCurrent(
    scheduledRuntime: { disposed: boolean },
    currentRuntime: { disposed: boolean } | undefined,
  ): boolean;
  createProductionTerminalAuthorityIntegration(options: {
    authService: {
      verifyToken(token: string): {
        valid: true;
        payload: { sub: string; jti: string };
      };
    };
    transportMode: 'unified' | 'split';
    sessionManager: {
      platform: 'linux';
      spawnPty: NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'];
      readProcessStartIdentityFn: NonNullable<ConstructorParameters<typeof SessionManager>[1]>['readProcessStartIdentityFn'];
      retainedTerminalShadowEnabled: true;
      retainedTerminalInitialOrdinal?: { streamEpoch: string; sourceSeq: string };
      writeHeadlessTerminalFn?: typeof writeHeadlessTerminal;
    };
    now?: () => number;
    promotionSafetyLimits?: { ackDeadlineMs: number; maxHeldOutputBytes: number; maxHeldOutputChunks: number };
    checkpointReadyHandshakeTimeoutMs?: number;
    viewAttributesHandshakeTimeoutMs?: number;
  }): ProductionTerminalAuthorityIntegration;
  attachProductionTerminalAuthority(options: {
    sessionManager: SessionManager;
    wsRouter: wsRouterModule.WsRouter;
    transportMode: 'unified' | 'split';
    promotionSafetyLimits?: { ackDeadlineMs: number; maxHeldOutputBytes: number; maxHeldOutputChunks: number };
    viewAttributesHandshakeTimeoutMs?: number;
  }): ProductionTerminalAuthorityIntegration;
}

interface TerminalQueryReplyIngress {
  handle(
    socketMeta: { connectionId: string },
    message: unknown,
  ): { handled: boolean; accepted: boolean; reason?: string };
}

interface WsRouterPromotionContract {
  routeTerminalAuthorityFrame(input: {
    mode: 'unified' | 'split';
    controlTransport: WsTransportQueueState;
    outputTransport: WsTransportQueueState;
    message: object;
  }): { socketRole: 'unified' | 'output' };
  createTerminalQueryReplyIngress(options: {
    readExpectedIdentity: (sessionId: string) => ResponderIdentity | null;
    writeTerminalQueryReply: (input: { data: string; identity: ResponderIdentity; replyOrdinal: number }) => void;
    writeInput: (sessionId: string, data: string) => void;
    observeSemanticInput: (sessionId: string, data: string) => void;
    isTerminalQueryReply: (
      data: string,
      options: { provenance: 'parser-generated' },
    ) => boolean;
  }): TerminalQueryReplyIngress;
}

type DebugRouteNext = () => void;
type DebugRouteMiddleware = (
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  next: DebugRouteNext,
) => void;

interface TerminalAuthorityDebugRouteRegistration {
  path: string;
  handlers: readonly DebugRouteMiddleware[];
}

interface TerminalAuthorityDebugRoutesModule {
  registerTerminalAuthorityDebugRoutes(options: {
    registrar: {
      post(path: string, ...handlers: DebugRouteMiddleware[]): void;
    };
    authMiddleware: DebugRouteMiddleware;
    requireLocalDebugCapture: DebugRouteMiddleware;
    requireExistingDebugSession: DebugRouteMiddleware;
    handleTestIsolation: DebugRouteMiddleware;
    handleRollback: DebugRouteMiddleware;
    handleFault: DebugRouteMiddleware;
  }): void;
}

class AuthorityIntegrationFakePty {
  readonly pid = 91_005;
  readonly process = 'bash';
  readonly handleFlowControl = false;
  cols = 80;
  rows = 24;
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(): void {}
  pause(): void {}
  resume(): void {}
  clear(): void {}

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

interface SessionManagerAuthorityIntegrationData {
  headless: HeadlessTerminalState;
  headlessWriteChain: Promise<void>;
  nextTerminalAuthoritySourceSeq: bigint;
  terminalQueryResponder?: {
    attachedHeadlessState: HeadlessTerminalState;
    detach(): void;
  };
  terminalAuthorityController?: TerminalAuthorityController;
}

test('MIG-BGSTAB-002 checkpoint identity follows the committed authority source across reserved ordinal gaps', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 authority ordinal gap', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(sessionData);
    sessionData.nextTerminalAuthoritySourceSeq += 1n;
    fakePty.emitData('committed-after-reserved-gap');
    await sessionData.headlessWriteChain;

    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    const boundary = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    const checkpoint = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-checkpoint:start' && frame.mode === 'authoritative'
    ));
    assert.ok(boundary);
    assert.ok(checkpoint);
    assert.equal(
      checkpoint.sourceSeq,
      boundary.boundarySourceSeq,
      'a checkpoint covering the committed model must use the controller authority ordinal, not a lagging ledger ordinal',
    );
  } finally {
    integration.destroy();
  }
});

interface SessionManagerAuthorityIntegrationApi {
  sessions: Map<string, SessionManagerAuthorityIntegrationData>;
  writeTerminalQueryReply(sessionId: string, data: string): boolean;
  updateCommandInputBuffer: (...args: unknown[]) => unknown;
  beginTerminalAuthorityPromotion(
    sessionId: string,
    request: PromotionRequest,
  ): Promise<PromotionResult> | PromotionResult;
  acknowledgeTerminalAuthorityLegacyDisable(
    sessionId: string,
    identity: ResponderIdentity,
  ): Promise<AckResult> | AckResult;
  beginTerminalAuthorityRollback(
    sessionId: string,
    request: ReturnType<typeof rollbackRequest>,
  ): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
}

interface ExecutableWsRouterApi {
  wss: {
    emit(event: 'connection', ...args: unknown[]): boolean;
  };
  getTerminalAuthorityResponderViews(sessionId: string): ReadonlyArray<{
    clientId: string;
    connectionId: string;
    viewGeneration: number;
  }>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ExecutableAuthoritySocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sentFrames: Array<Record<string, unknown>> = [];
  parserRepliesEnabled = false;
  queryReplyEmissionCount = 0;
  holdSendCallbacks = false;
  holdSendPredicate: ((frame: Record<string, unknown>) => boolean) | null = null;
  sendFailurePredicate: ((frame: Record<string, unknown>) => boolean) | null = null;
  private readonly heldSendCallbacks: Array<(error?: Error) => void> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(
    readonly connectionId: string,
    private readonly onParserReply?: (reply: string) => void,
    private readonly onSentFrame?: (frame: Record<string, unknown>) => void,
  ) {}

  send(payload: string | Buffer, callback?: (error?: Error) => void): void {
    const frame = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : payload) as Record<string, unknown>;
    this.sentFrames.push(frame);
    this.onSentFrame?.(frame);
    if (frame.type === 'terminal-authority:legacy-responder-enabled') {
      this.parserRepliesEnabled = true;
    }
    if (callback) {
      if (this.sendFailurePredicate?.(frame) === true) {
        callback(new Error('injected-persistent-send-failure'));
      }
      else if (this.holdSendCallbacks || this.holdSendPredicate?.(frame) === true) {
        this.heldSendCallbacks.push(callback);
      }
      else callback();
    }
  }

  releaseNextSend(error?: Error): void {
    this.heldSendCallbacks.shift()?.(error);
  }

  get heldSendCallbackCount(): number {
    return this.heldSendCallbacks.length;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  ping(): void {}

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
  }

  emitParserReply(reply: string): void {
    if (!this.parserRepliesEnabled) return;
    this.queryReplyEmissionCount += 1;
    this.onParserReply?.(reply);
  }
}

interface ProductionConnectedView {
  control: ExecutableAuthoritySocket;
  output: ExecutableAuthoritySocket;
  connectionId: string;
  clientGroupId: string;
  viewGeneration: number;
  negotiatedRegistration: Readonly<Record<string, unknown>>;
}

function emitClientFrame(socket: ExecutableAuthoritySocket, frame: object): void {
  socket.emit('message', JSON.stringify(frame));
}

function negotiateProductionView(
  control: ExecutableAuthoritySocket,
  viewGeneration: number,
): Readonly<Record<string, unknown>> {
  const declaration = Object.freeze({
    sessionId: SESSION_ID,
    viewGeneration,
    queryReplyCapability: 'terminal.query-reply-input.v1',
    parserResponderCapability: 'terminal.parser-responder-disable.v1',
  });
  emitClientFrame(control, {
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: 1,
    views: [declaration],
  });
  const capability = [...control.sentFrames].reverse().find(frame => (
    frame.type === 'terminal-checkpoint:capability'
  ));
  const registeredViews = Array.isArray(capability?.registeredViews)
    ? capability.registeredViews as ReadonlyArray<Record<string, unknown>>
    : [];
  const registration = registeredViews.find(view => (
    view.sessionId === SESSION_ID && view.viewGeneration === viewGeneration
  ));
  assert.ok(registration, 'server-derived responder authority grant must be present');
  return Object.freeze({ ...registration });
}

const PRODUCTION_ANSI_256 = (() => {
  const ansi: Array<readonly [number, number, number]> = [
    [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
    [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
    [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
    [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
  ];
  const cube = [0, 95, 135, 175, 215, 255];
  for (const red of cube) for (const green of cube) for (const blue of cube) {
    ansi.push([red, green, blue]);
  }
  for (let index = 0; index < 24; index += 1) {
    const level = 8 + index * 10;
    ansi.push([level, level, level]);
  }
  return Object.freeze(ansi);
})();

const PRODUCTION_VIEW_ATTRIBUTES = Object.freeze({
  foreground: [212, 212, 212],
  background: [30, 30, 30],
  cursor: [212, 212, 212],
  ansi: PRODUCTION_ANSI_256,
  cursorStyle: 'block',
  cursorBlink: true,
  colorSchemeMode: 'dark',
});

async function connectProductionView(
  router: ExecutableWsRouterApi,
  mode: 'unified' | 'split',
  viewGeneration: number,
  options: { autoAcknowledgeCheckpoint?: 'initial' | 'any' } = {},
): Promise<ProductionConnectedView> {
  const acknowledgedCheckpointDeliveries = new Set<string>();
  let control!: ExecutableAuthoritySocket;
  control = new ExecutableAuthoritySocket(`control-${viewGeneration}`, undefined, frame => {
    if (frame.type !== 'terminal-checkpoint:capability') return;
    if (!options.autoAcknowledgeCheckpoint) return;
    const preparation = frame.checkpointDeliveryPreparation as Record<string, unknown> | undefined;
    if (!preparation || typeof preparation.checkpointDeliveryId !== 'string') return;
    if (options.autoAcknowledgeCheckpoint === 'initial' && preparation.viewGeneration !== viewGeneration) return;
    if (acknowledgedCheckpointDeliveries.has(preparation.checkpointDeliveryId)) return;
    acknowledgedCheckpointDeliveries.add(preparation.checkpointDeliveryId);
    queueMicrotask(() => {
      if (control.readyState !== 1) return;
      emitClientFrame(control, {
        type: 'terminal-checkpoint:ready',
        protocolVersion: 1,
        sessionId: SESSION_ID,
        viewGeneration: preparation.viewGeneration,
        authorityEpoch: preparation.authorityEpoch,
        streamEpoch: preparation.streamEpoch,
        driverLeaseGeneration: preparation.driverLeaseGeneration,
        acceptedViewAttributesGeneration: preparation.acceptedViewAttributesGeneration,
        viewAttributesChallengeId: preparation.viewAttributesChallengeId,
        checkpointDeliveryId: preparation.checkpointDeliveryId,
      });
    });
  });
  router.wss.emit(
    'connection',
    control,
    {},
    { sub: 'authority-test-user', jti: 'authority-test-token' },
    { ok: true, requestedMode: mode, channelRole: 'control' },
  );
  const connected = control.sentFrames.find(frame => frame.type === 'connected');
  assert.ok(connected, 'the real WsRouter connection handler must emit control role metadata');
  assert.equal(connected.wsTransportMode, mode);
  const connectionId = String(connected.connectionId ?? '');
  const clientGroupId = String(connected.clientGroupId ?? connected.clientId ?? '');
  assert.notEqual(connectionId, '');
  assert.notEqual(clientGroupId, '');

  const output = mode === 'split'
    ? new ExecutableAuthoritySocket(`output-${viewGeneration}`)
    : control;
  if (mode === 'split') {
    const pairToken = String(connected.pairToken ?? '');
    assert.notEqual(pairToken, '', 'split control handshake must return a pair token');
    router.wss.emit(
      'connection',
      output,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId,
        pairToken,
      },
    );
    const outputConnected = output.sentFrames.find(frame => frame.type === 'connected');
    assert.equal(outputConnected?.channel, 'output');
    assert.equal(outputConnected?.clientGroupId, clientGroupId);
  }

  emitClientFrame(control, { type: 'subscribe', sessionIds: [SESSION_ID] });
  const negotiatedRegistration = negotiateProductionView(control, viewGeneration);
  await new Promise<void>(resolve => setImmediate(resolve));
  emitClientFrame(control, {
    type: 'terminal-authority:view-attributes',
    sessionId: SESSION_ID,
    viewGeneration,
    driverLeaseGeneration: negotiatedRegistration.driverLeaseGeneration,
    viewAttributesGeneration: negotiatedRegistration.acceptedViewAttributesGeneration,
    viewAttributesChallengeId: negotiatedRegistration.viewAttributesChallengeId,
    attributes: PRODUCTION_VIEW_ATTRIBUTES,
  });
  const snapshot = [...control.sentFrames, ...output.sentFrames].reverse().find(frame => (
    frame.type === 'screen-snapshot' && frame.sessionId === SESSION_ID
  ));
  assert.ok(
    snapshot,
    `subscribed responder must receive an authoritative recovery snapshot; frames=${JSON.stringify([
      ...control.sentFrames,
      ...output.sentFrames,
    ].map(frame => frame.type))}`,
  );
  assert.equal(snapshot.mode, 'authoritative');
  assert.equal(snapshot.truncated, false);
  emitClientFrame(control, {
    type: 'screen-snapshot:ready',
    sessionId: SESSION_ID,
    replayToken: snapshot.replayToken,
  });
  assert.equal(
    control.sentFrames.some(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.accepted === true
    )),
    true,
    'capabilities must enter the production registry only through real checkpoint negotiation',
  );
  return { control, output, connectionId, clientGroupId, viewGeneration, negotiatedRegistration };
}

async function acceptPendingProductionViewAttributes(
  control: ExecutableAuthoritySocket,
  frameStart: number,
  viewGeneration: number,
  refresh: Promise<boolean>,
): Promise<Readonly<Record<string, unknown>>> {
  let registration: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40 && !registration; attempt += 1) {
    registration = control.sentFrames.slice(frameStart).flatMap(frame => (
      frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
        ? frame.registeredViews as Array<Record<string, unknown>>
        : []
    )).find(candidate => (
      candidate.sessionId === SESSION_ID && candidate.viewGeneration === viewGeneration
    ));
    if (!registration) await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.ok(registration, 'pending refresh did not advertise its exact owner identity');
  emitClientFrame(control, {
    type: 'terminal-authority:view-attributes',
    sessionId: SESSION_ID,
    viewGeneration,
    driverLeaseGeneration: registration.driverLeaseGeneration,
    viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
    viewAttributesChallengeId: registration.viewAttributesChallengeId,
    attributes: PRODUCTION_VIEW_ATTRIBUTES,
  });
  assert.equal(await refresh, true, 'exact view attributes and ACK settlement must complete refresh');
  return registration;
}

async function promoteProductionViews(
  integration: ProductionTerminalAuthorityIntegration,
  views: readonly ProductionConnectedView[],
): Promise<void> {
  let parity = integration.sessionManager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
  for (let attempt = 0; attempt < 20 && !parity.retainedStateParity; attempt += 1) {
    await integration.sessionManager.settleTerminalAuthorityPromotionEvidence(SESSION_ID);
    parity = integration.sessionManager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
    if (parity.retainedStateParity || parity.blockers.includes('retained-state-parity-mismatch')) {
      break;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(parity.retainedStateParity, true, JSON.stringify(parity));
  let promotion = await integration.beginPromotion(SESSION_ID);
  for (let attempt = 0; attempt < 20
    && (promotion.reason === 'server-derived-canary-capability-gate-failed'
      || promotion.reason === 'server-derived-canary-replay-repair-gate-failed'); attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
    promotion = await integration.beginPromotion(SESSION_ID);
  }
  assert.equal(promotion.ok, true, JSON.stringify(promotion));
  for (const view of views) {
    const boundary = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    assert.ok(boundary);
    const frozen = (boundary.requiredResponderViews as Array<Record<string, unknown>>)
      .find(candidate => candidate.connectionId === view.connectionId);
    assert.ok(frozen);
    emitClientFrame(view.control, {
      type: 'terminal-authority:responder-disabled',
      ...frozen,
      sessionId: SESSION_ID,
      transitionEpoch: boundary.transitionEpoch,
      authorityEpoch: boundary.authorityEpoch,
      streamEpoch: boundary.streamEpoch,
      boundarySourceSeq: boundary.boundarySourceSeq,
      responderLeaseId: boundary.responderLeaseId,
    });
  }
  for (let attempt = 0; attempt < 20
    && integration.getAuthorityState(SESSION_ID)?.mode !== 'server'; attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
}

function assertProductionDefaultWiring(
  integration: ProductionTerminalAuthorityIntegration,
  minimumCheckpointCalls = 0,
): void {
  const evidence = integration.getWiringEvidence(SESSION_ID);
  assert.deepEqual({
    source: evidence.source,
    sessionManagerBoundToRouter: evidence.sessionManagerBoundToRouter,
    controllerFactory: evidence.controllerFactory,
    retainedCheckpointAdapter: evidence.retainedCheckpointAdapter,
    checkpointDigestAdapter: evidence.checkpointDigestAdapter,
    injectedControllerFactory: evidence.injectedControllerFactory,
    injectedCheckpointAssembler: evidence.injectedCheckpointAssembler,
  }, {
    source: 'production-default',
    sessionManagerBoundToRouter: true,
    controllerFactory: 'production-terminal-authority-controller',
    retainedCheckpointAdapter: 'session-manager-retained-terminal',
    checkpointDigestAdapter: 'sha256',
    injectedControllerFactory: false,
    injectedCheckpointAssembler: false,
  });
  assert.equal(evidence.controllerFactoryCallCount, 1);
  assert.equal(evidence.retainedCheckpointAdapterCallCount >= minimumCheckpointCalls, true);
  assert.equal(evidence.checkpointDigestAdapterCallCount >= minimumCheckpointCalls, true);
}

function assertFrozenNegotiatedIdentity(
  view: ProductionConnectedView,
  frozen: Record<string, unknown>,
): void {
  assert.equal(frozen.connectionId, view.connectionId);
  assert.equal(frozen.viewGeneration, view.viewGeneration);
  for (const field of [
    'queryReplyCapability',
    'parserResponderCapability',
    'driverLeaseGeneration',
    'acceptedViewAttributesGeneration',
  ] as const) {
    assert.equal(
      frozen[field],
      view.negotiatedRegistration[field],
      `${field} must come from the actual pre-promotion negotiation registry`,
    );
  }
}

function createProductionIntegrationFixture(
  module: ProductionTerminalAuthorityIntegrationModule,
  mode: 'unified' | 'split',
  fakePty: AuthorityIntegrationFakePty,
  options: {
    retainedTerminalInitialOrdinal?: { streamEpoch: string; sourceSeq: string };
    writeHeadlessTerminalFn?: typeof writeHeadlessTerminal;
    promotionSafetyLimits?: { ackDeadlineMs: number; maxHeldOutputBytes: number; maxHeldOutputChunks: number };
    checkpointReadyHandshakeTimeoutMs?: number;
    viewAttributesHandshakeTimeoutMs?: number;
  } = {},
): ProductionTerminalAuthorityIntegration {
  return module.createProductionTerminalAuthorityIntegration({
    authService: {
      verifyToken: () => ({
        valid: true,
        payload: { sub: 'authority-test-user', jti: 'authority-test-token' },
      }),
    },
    transportMode: mode,
    ...(options.promotionSafetyLimits ? { promotionSafetyLimits: options.promotionSafetyLimits } : {}),
    ...(options.checkpointReadyHandshakeTimeoutMs !== undefined
      ? { checkpointReadyHandshakeTimeoutMs: options.checkpointReadyHandshakeTimeoutMs }
      : {}),
    ...(options.viewAttributesHandshakeTimeoutMs !== undefined
      ? { viewAttributesHandshakeTimeoutMs: options.viewAttributesHandshakeTimeoutMs }
      : {}),
    sessionManager: {
      platform: 'linux',
      spawnPty: (() => fakePty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
      readProcessStartIdentityFn: async () => null,
      retainedTerminalShadowEnabled: true,
      ...(options.retainedTerminalInitialOrdinal
        ? { retainedTerminalInitialOrdinal: options.retainedTerminalInitialOrdinal }
        : {}),
      ...(options.writeHeadlessTerminalFn
        ? { writeHeadlessTerminalFn: options.writeHeadlessTerminalFn }
        : {}),
    },
  });
}

function createConfiguredProductionIntegrationFixture(
  module: ProductionTerminalAuthorityIntegrationModule,
  mode: 'unified' | 'split',
  fakePty: AuthorityIntegrationFakePty,
  options: {
    retainedScrollbackLines: number;
    legacyScrollbackLines?: number;
    retainedTerminalInitialOrdinal?: { streamEpoch: string; sourceSeq: string };
  },
): ProductionTerminalAuthorityIntegration {
  const resourceLimits = structuredClone(config.resourceLimits!);
  resourceLimits.terminal.scrollbackLines = options.retainedScrollbackLines;
  const manager = new SessionManager({
    pty: {
      ...structuredClone(config.pty),
      scrollbackLines: options.legacyScrollbackLines ?? 1,
    },
    session: structuredClone(config.session),
    resourceLimits,
    stabilityModes: structuredClone(config.stabilityModes),
  }, {
    platform: 'linux',
    spawnPty: (() => fakePty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
    retainedTerminalShadowEnabled: true,
    ...(options.retainedTerminalInitialOrdinal
      ? { retainedTerminalInitialOrdinal: options.retainedTerminalInitialOrdinal }
      : {}),
  });
  const router = new wsRouterModule.WsRouter(
    { verifyToken: () => ({ valid: true, payload: { sub: 'authority-test-user', jti: 'authority-test-token' } }) } as never,
    manager,
    { realtime: { wsTransportMode: mode } },
  );
  return module.attachProductionTerminalAuthority({
    sessionManager: manager,
    wsRouter: router,
    transportMode: mode,
  });
}

const CONTRACT_MODULE_PATH: string = './TerminalAuthorityController.js';
const PRODUCTION_INTEGRATION_MODULE_PATH: string = './TerminalAuthorityProductionAdapter.js';
const DEBUG_ROUTES_MODULE_PATH: string = '../routes/terminalAuthorityDebugRoutes.js';
const EXPECTED_FAILURES = {
  'MIG-AC-1': 'MIG-BGSTAB-002 AC-1 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  'MIG-AC-2': 'MIG-BGSTAB-002 AC-2 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  'MIG-AC-3': 'MIG-BGSTAB-002 AC-3 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  'MIG-AC-4': 'MIG-BGSTAB-002 AC-4 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  'MIG-AC-5': 'MIG-BGSTAB-002 AC-5 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  'MIG-AC-6': 'MIG-BGSTAB-002 AC-6 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  'REL-AC-12': 'REL-BGSTAB-007 AC-12 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
} as const;
type ContractKey = keyof typeof EXPECTED_FAILURES;

async function loadContract(key: ContractKey): Promise<ContractModule> {
  try {
    const module = await import(CONTRACT_MODULE_PATH) as Partial<ContractModule>;
    assert.equal(typeof module.createTerminalAuthorityController, 'function', EXPECTED_FAILURES[key]);
    return module as ContractModule;
  } catch (cause) {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
    const message = cause instanceof Error ? cause.message : String(cause);
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes('TerminalAuthorityController')) {
      throw new Error(EXPECTED_FAILURES[key], { cause });
    }
    throw cause;
  }
}

async function loadProductionIntegration(
  key: ContractKey,
): Promise<ProductionTerminalAuthorityIntegrationModule> {
  try {
    const module = await import(PRODUCTION_INTEGRATION_MODULE_PATH) as Partial<ProductionTerminalAuthorityIntegrationModule>;
    assert.equal(
      typeof module.createProductionTerminalAuthorityIntegration,
      'function',
      `${EXPECTED_FAILURES[key]}: production default authority adapter export missing`,
    );
    assert.equal(typeof module.attachProductionTerminalAuthority, 'function');
    return module as ProductionTerminalAuthorityIntegrationModule;
  } catch (cause) {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
    const message = cause instanceof Error ? cause.message : String(cause);
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes('TerminalAuthorityProductionAdapter')) {
      throw new Error(
        `${EXPECTED_FAILURES[key]}: production default SessionManager/WsRouter authority adapter missing`,
        { cause },
      );
    }
    throw cause;
  }
}

async function loadDebugRoutesContract(): Promise<TerminalAuthorityDebugRoutesModule> {
  try {
    const module = await import(DEBUG_ROUTES_MODULE_PATH) as Partial<TerminalAuthorityDebugRoutesModule>;
    assert.equal(
      typeof module.registerTerminalAuthorityDebugRoutes,
      'function',
      EXPECTED_FAILURES['MIG-AC-6'],
    );
    return module as TerminalAuthorityDebugRoutesModule;
  } catch (cause) {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause
      ? String(cause.code)
      : '';
    const message = cause instanceof Error ? cause.message : String(cause);
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes('terminalAuthorityDebugRoutes')) {
      throw new Error(EXPECTED_FAILURES['MIG-AC-6'], { cause });
    }
    throw cause;
  }
}

const SESSION_ID = 'session-ph005';
const AUTHORITY_EPOCH = 'authority-7';
const LEGACY_STREAM_EPOCH = '7';
const PROMOTED_STREAM_EPOCH = '8';
const TRANSITION_EPOCH = '8';
const OLD_RESPONDER_LEASE_ID = 'responder-browser-7';
const NEW_RESPONDER_LEASE_ID = 'responder-server-8';
const COMPATIBILITY_RESPONDER_LEASE_ID = 'responder-browser-9';
const COMPATIBILITY_DRIVER_LEASE_ID = 'driver-browser-9';
const BOUNDARY_SOURCE_SEQ = '41';
const AUTHORITATIVE_CHECKPOINT_MESSAGES = Object.freeze([
  Object.freeze({
    type: 'terminal-checkpoint:start',
    sessionId: SESSION_ID,
    checkpointEpoch: '8001',
    snapshotSeq: BOUNDARY_SOURCE_SEQ,
    mode: 'authoritative',
    authorityMode: 'server',
    source: 'server-authority-promotion',
    chunkCount: 1,
  }),
  Object.freeze({
    type: 'terminal-checkpoint:chunk',
    sessionId: SESSION_ID,
    authorityMode: 'server',
    checkpointEpoch: '8001',
    snapshotSeq: BOUNDARY_SOURCE_SEQ,
    chunkIndex: 0,
    chunkCount: 1,
    data: 'configured-retained-range',
  }),
  Object.freeze({
    type: 'terminal-checkpoint:commit',
    sessionId: SESSION_ID,
    authorityMode: 'server',
    checkpointEpoch: '8001',
    snapshotSeq: BOUNDARY_SOURCE_SEQ,
    chunkCount: 1,
    retainedStateHash: 'sha256:configured-retained-range',
  }),
]);
const COMPATIBILITY_SNAPSHOT_SEQ = '43';
const COMPATIBILITY_TAIL_SOURCE_SEQ = '44';
const COMPATIBILITY_CHECKPOINT_BODY = 'configured-compatibility-retained-range';
const COMPATIBILITY_CHECKPOINT_ENCODED_BYTES = Buffer.byteLength(
  COMPATIBILITY_CHECKPOINT_BODY,
  'utf8',
);
const COMPATIBILITY_CHECKPOINT_DIGEST = `sha256:${createHash('sha256')
  .update(COMPATIBILITY_CHECKPOINT_BODY, 'utf8')
  .digest('hex')}`;
const COMPATIBILITY_CHECKPOINT_MESSAGES = Object.freeze([
  Object.freeze({
    type: 'terminal-checkpoint:start',
    protocolVersion: 1,
    sessionId: SESSION_ID,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    checkpointEpoch: '9001',
    snapshotSeq: COMPATIBILITY_SNAPSHOT_SEQ,
    mode: 'compatibility',
    source: 'server-authority-rollback',
    authorityMode: 'legacy',
    chunkCount: 1,
    totalEncodedBytes: COMPATIBILITY_CHECKPOINT_ENCODED_BYTES,
    contentDigest: COMPATIBILITY_CHECKPOINT_DIGEST,
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: COMPATIBILITY_SNAPSHOT_SEQ,
  }),
  Object.freeze({
    type: 'terminal-checkpoint:chunk',
    protocolVersion: 1,
    sessionId: SESSION_ID,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    checkpointEpoch: '9001',
    snapshotSeq: COMPATIBILITY_SNAPSHOT_SEQ,
    mode: 'compatibility',
    source: 'server-authority-rollback',
    authorityMode: 'legacy',
    chunkIndex: 0,
    chunkCount: 1,
    totalEncodedBytes: COMPATIBILITY_CHECKPOINT_ENCODED_BYTES,
    contentDigest: COMPATIBILITY_CHECKPOINT_DIGEST,
    data: COMPATIBILITY_CHECKPOINT_BODY,
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: COMPATIBILITY_SNAPSHOT_SEQ,
  }),
  Object.freeze({
    type: 'terminal-checkpoint:commit',
    protocolVersion: 1,
    sessionId: SESSION_ID,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    checkpointEpoch: '9001',
    snapshotSeq: COMPATIBILITY_SNAPSHOT_SEQ,
    mode: 'compatibility',
    source: 'server-authority-rollback',
    authorityMode: 'legacy',
    chunkCount: 1,
    totalEncodedBytes: COMPATIBILITY_CHECKPOINT_ENCODED_BYTES,
    contentDigest: COMPATIBILITY_CHECKPOINT_DIGEST,
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: COMPATIBILITY_SNAPSHOT_SEQ,
  }),
]);
const VIEW_A: ResponderViewIdentity = Object.freeze({
  connectionId: 'connection-a',
  viewGeneration: 11,
  responderLeaseId: OLD_RESPONDER_LEASE_ID,
  queryReplyCapability: 'terminal.query-reply-input.v1',
  parserResponderCapability: 'terminal.parser-responder-disable.v1',
  driverLeaseGeneration: '7',
  acceptedViewAttributesGeneration: '7',
});
const VIEW_B: ResponderViewIdentity = Object.freeze({
  connectionId: 'connection-b',
  // View generations are client-local. Equal values across two connections
  // must remain two independent frozen quorum members.
  viewGeneration: 11,
  responderLeaseId: OLD_RESPONDER_LEASE_ID,
  queryReplyCapability: 'terminal.query-reply-input.v1',
  parserResponderCapability: 'terminal.parser-responder-disable.v1',
  driverLeaseGeneration: '7',
  acceptedViewAttributesGeneration: '7',
});
const PASSING_GATES: PromotionGates = Object.freeze({
  retainedStateParity: true,
  factParity: true,
  leaseParity: true,
  noLocalCacheParity: true,
  limitedSessionSelected: true,
  allRespondersCapable: true,
  replayRepairIdle: true,
});

interface Harness {
  controller: TerminalAuthorityController;
  events: AuthorityEvent[];
  transport: WsTransportQueueState;
  gates: PromotionGates;
  requiredViews: ResponderViewIdentity[];
  lastCommittedSourceSeq: string;
  queryEffects: Array<{ effectKey: string; sourceSeq: string; reply: string; owner: 'server-headless' }>;
  legacyQueryEffects: Array<{ reply: string; identity: ResponderIdentity }>;
  effectTimeline: string[];
  throwQueryWrite: boolean;
  throwLegacyQueryTransfer: boolean;
  nowMs: number;
  safetyLimits: { ackDeadlineMs: number; maxHeldOutputBytes: number; maxHeldOutputChunks: number };
  recoveryReasons: string[];
  authorityEffects: AuthorityEffect[];
  compatibilityPhysicalDrains: Set<string>;
  transferredLegacyQueries: Array<{
    effectKey: string;
    sourceSeq: string;
    reply: string;
    responderLeaseId: string;
  }>;
  committedLegacyIdentities: Array<Record<string, unknown>>;
  quorumReceiptPromise: Promise<boolean> | null;
}

function compatibilityDrainKey(input: {
  connectionId: string;
  viewGeneration: number;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  responderLeaseId: string;
  boundarySourceSeq: string;
  checkpointEpoch: string;
  drainedThroughSourceSeq: string;
}): string {
  return [
    input.connectionId,
    input.viewGeneration,
    input.transitionEpoch,
    input.authorityEpoch,
    input.streamEpoch,
    input.responderLeaseId,
    input.boundarySourceSeq,
    input.checkpointEpoch,
    input.drainedThroughSourceSeq,
  ].join('\u0000');
}

function createHarness(
  contract: ContractModule,
  options: Readonly<{ quorumReceiptPromise?: Promise<boolean> }> = {},
): Harness {
  const harness = {
    events: [] as AuthorityEvent[],
    transport: createWsTransportQueueState(),
    gates: { ...PASSING_GATES },
    requiredViews: [{ ...VIEW_A }, { ...VIEW_B }],
    lastCommittedSourceSeq: BOUNDARY_SOURCE_SEQ,
    queryEffects: [] as Harness['queryEffects'],
    legacyQueryEffects: [] as Harness['legacyQueryEffects'],
    effectTimeline: [] as string[],
    throwQueryWrite: false,
    throwLegacyQueryTransfer: false,
    nowMs: 1_000,
    safetyLimits: { ackDeadlineMs: 500, maxHeldOutputBytes: 1024, maxHeldOutputChunks: 8 },
    recoveryReasons: [] as string[],
    authorityEffects: [] as AuthorityEffect[],
    compatibilityPhysicalDrains: new Set<string>(),
    transferredLegacyQueries: [] as Harness['transferredLegacyQueries'],
    committedLegacyIdentities: [] as Harness['committedLegacyIdentities'],
    quorumReceiptPromise: options.quorumReceiptPromise ?? null,
  };
  const controller = contract.createTerminalAuthorityController({
    initial: {
      sessionId: SESSION_ID,
      authorityEpoch: AUTHORITY_EPOCH,
      streamEpoch: LEGACY_STREAM_EPOCH,
      sessionGeneration: 'session-generation-1',
      legacyResponderLeaseId: OLD_RESPONDER_LEASE_ID,
      legacyDriverLeaseId: 'driver-browser-7',
      sessionStatus: 'idle',
    },
    readPromotionGates: () => ({ ...harness.gates }),
    listRequiredResponderViews: () => harness.requiredViews.map(view => ({ ...view })),
    readLastCommittedSourceSeq: () => harness.lastCommittedSourceSeq,
    readPromotionSafetyLimits: () => ({ ...harness.safetyLimits }),
    now: () => harness.nowMs,
    onOrderedCompatibilityRecoveryRequired: reason => harness.recoveryReasons.push(reason),
    enqueueTerminalMessage: message => pushTransportMessage(
      harness.transport,
      createWsTransportMessage(message, 1),
    ),
    emit: event => {
      harness.events.push(event);
      if (event.type === 'headless-model-committed' || event.type === 'headless-fact-committed' || event.type === 'query-effect-cas-committed' || event.type === 'query-effect-failed') {
        harness.effectTimeline.push(event.type);
      }
    },
    loadAuthoritativeRecovery: () => ({
      retainedStateHash: 'sha256:configured-retained-range',
      checkpointEpoch: '8001',
      snapshotSeq: BOUNDARY_SOURCE_SEQ,
      checkpointMessages: AUTHORITATIVE_CHECKPOINT_MESSAGES,
      postSnapshotOutput: ['tail-42', 'tail-43'],
    }),
    loadCompatibilityRecovery: input => {
      assert.deepEqual(input, {
        transitionEpoch: '9',
        streamEpoch: '9',
        checkpointEpoch: '9001',
      });
      return {
        snapshotSeq: COMPATIBILITY_SNAPSHOT_SEQ,
        checkpointMessages: COMPATIBILITY_CHECKPOINT_MESSAGES,
      };
    },
    ...(harness.quorumReceiptPromise
      ? { onLegacyDisableQuorumAccepted: () => harness.quorumReceiptPromise! }
      : {}),
    stopNewAdmission: input => harness.authorityEffects.push({
      type: 'new-admission-stopped',
      ...input,
    }),
    setServerResponderEnabled: input => harness.authorityEffects.push({
      type: 'server-responder-enabled-set',
      ...input,
    }),
    revokeServerResponderLease: input => harness.authorityEffects.push({
      type: 'server-responder-lease-revoked',
      ...input,
    }),
    revokeServerDriverLease: input => harness.authorityEffects.push({
      type: 'server-driver-lease-revoked',
      ...input,
    }),
    markAffectedViewStale: view => harness.authorityEffects.push({
      type: 'affected-view-stale',
      ...view,
    }),
    resetAffectedViewParser: view => harness.authorityEffects.push({
      type: 'browser-parser-reset',
      ...view,
    }),
    purgeOldAckBacklog: input => harness.authorityEffects.push({
      type: 'old-ack-backlog-purged',
      ...input,
    }),
    rebindCompatibilityDriverLease: input => harness.authorityEffects.push({
      type: 'compatibility-driver-lease-rebound',
      ...input,
    }),
    rebindCompatibilityResponderLease: input => harness.authorityEffects.push({
      type: 'compatibility-responder-lease-rebound',
      ...input,
    }),
    commitLegacyResponderIdentity: identity => harness.committedLegacyIdentities.push({ ...identity }),
    hasCompatibilityTailPhysicallyDrained: input => (
      harness.compatibilityPhysicalDrains.has(compatibilityDrainKey(input))
    ),
    transferHeldQueryToLegacyResponder: effect => {
      if (harness.throwLegacyQueryTransfer) throw new Error('synthetic legacy query transfer failure');
      const { clientId: _clientId, viewGeneration: _viewGeneration, ...recordedEffect } = effect;
      harness.transferredLegacyQueries.push(recordedEffect);
    },
    writeTerminalQueryReply: effect => {
      harness.effectTimeline.push('pty-query-reply-written');
      harness.queryEffects.push(effect);
      if (harness.throwQueryWrite) throw new Error('synthetic PTY write failure');
    },
    writeLegacyBrowserQueryReply: effect => {
      harness.legacyQueryEffects.push(effect);
    },
  });
  return Object.assign(harness, { controller });
}

function promotionRequest(overrides: Partial<PromotionRequest> = {}): PromotionRequest {
  return {
    sessionId: SESSION_ID,
    authorityEpoch: AUTHORITY_EPOCH,
    previousStreamEpoch: LEGACY_STREAM_EPOCH,
    nextStreamEpoch: PROMOTED_STREAM_EPOCH,
    transitionEpoch: TRANSITION_EPOCH,
    oldResponderLeaseId: OLD_RESPONDER_LEASE_ID,
    nextResponderLeaseId: NEW_RESPONDER_LEASE_ID,
    nextDriverLeaseId: 'driver-server-8',
    ...overrides,
  };
}

function rollbackRequest() {
  return {
    transitionEpoch: '9',
    nextStreamEpoch: '9',
    compatibilityCheckpointEpoch: '9001',
    nextCompatibilityResponderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    nextCompatibilityDriverLeaseId: COMPATIBILITY_DRIVER_LEASE_ID,
    nextCompatibilityDriverLeaseGeneration: '9',
    nextAcceptedViewAttributesGeneration: '9',
    selectedCompatibilityResponder: {
      ...VIEW_A,
      responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
      driverLeaseId: COMPATIBILITY_DRIVER_LEASE_ID,
      driverLeaseGeneration: '9',
      acceptedViewAttributesGeneration: '9',
    },
  } as const;
}

function responderIdentity(view: ResponderViewIdentity, overrides: Partial<ResponderIdentity> = {}): ResponderIdentity {
  return {
    ...view,
    sessionId: SESSION_ID,
    transitionEpoch: TRANSITION_EPOCH,
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: PROMOTED_STREAM_EPOCH,
    boundarySourceSeq: BOUNDARY_SOURCE_SEQ,
    ...overrides,
  };
}

async function promoteAllViews(controller: TerminalAuthorityController): Promise<void> {
  assert.equal((await controller.beginPromotion(promotionRequest())).ok, true);
  assert.deepEqual(await controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A)), { accepted: true, completed: false });
  assert.deepEqual(await controller.acknowledgeLegacyDisable(responderIdentity(VIEW_B)), { accepted: true, completed: true });
}

test('Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-1', async () => {
  const contract = await loadContract('MIG-AC-1');
  for (const gateName of Object.keys(PASSING_GATES) as Array<keyof PromotionGates>) {
    const harness = createHarness(contract);
    harness.gates[gateName] = false;
    const rejected = await harness.controller.beginPromotion(promotionRequest());
    assert.equal(rejected.ok, false, `${gateName} must fail closed from the server-owned gate reader`);
    assert.match(rejected.reason ?? '', new RegExp(gateName, 'i'));
    assert.equal(harness.controller.getState().mode, 'legacy');
    assert.deepEqual(harness.events, []);
  }

  for (const mutate of [
    (views: ResponderViewIdentity[]) => { views.length = 0; },
    (views: ResponderViewIdentity[]) => { views.push({ ...views[0]! }); },
    (views: ResponderViewIdentity[]) => { (views[0] as { queryReplyCapability: string }).queryReplyCapability = ''; },
    (views: ResponderViewIdentity[]) => { (views[0] as { parserResponderCapability: string }).parserResponderCapability = ''; },
    (views: ResponderViewIdentity[]) => { views[0]!.driverLeaseGeneration = '6'; },
    (views: ResponderViewIdentity[]) => { views[0]!.acceptedViewAttributesGeneration = '6'; },
  ]) {
    const invalid = createHarness(contract);
    mutate(invalid.requiredViews);
    assert.equal((await invalid.controller.beginPromotion(promotionRequest())).ok, false, 'server registry capability/freeze validation must fail closed');
    assert.deepEqual(invalid.events, []);
  }

  for (const request of [
    promotionRequest({ transitionEpoch: '08' }),
    promotionRequest({ transitionEpoch: 8 as unknown as string }),
    promotionRequest({ nextStreamEpoch: '18446744073709551616' }),
    promotionRequest({ nextStreamEpoch: -1 as unknown as string }),
    promotionRequest({ previousStreamEpoch: '6' }),
    promotionRequest({ authorityEpoch: '' }),
    promotionRequest({ authorityEpoch: 'peer-authority' }),
    promotionRequest({ oldResponderLeaseId: 'peer-responder-lease' }),
  ]) {
    const invalid = createHarness(contract);
    assert.equal((await invalid.controller.beginPromotion(request)).ok, false);
    assert.deepEqual(invalid.events, []);
    assert.deepEqual(getTransportMessagesInPriorityOrder(invalid.transport), []);
  }

  const harness = createHarness(contract);
  const started = await harness.controller.beginPromotion(promotionRequest());
  assert.deepEqual(started, {
    ok: true,
    transitionEpoch: TRANSITION_EPOCH,
    streamEpoch: PROMOTED_STREAM_EPOCH,
    boundarySourceSeq: BOUNDARY_SOURCE_SEQ,
    requiredResponderCount: 2,
  });
  harness.gates.retainedStateParity = false;
  harness.requiredViews.length = 0;
  harness.lastCommittedSourceSeq = '999';
  assert.equal(harness.controller.getState().frozenRequiredResponderCount, 2, 'caller mutation cannot shrink the frozen server subscriber set');
  assert.equal(harness.events.find(event => event.type === 'headless-write-chain-fenced')?.sourceSeq, BOUNDARY_SOURCE_SEQ);
});

test('Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-2', async () => {
  const contract = await loadContract('MIG-AC-2');
  const ownershipHarness = createHarness(contract);
  ownershipHarness.lastCommittedSourceSeq = '39';
  const legacyQueued = ownershipHarness.controller.enqueueHeadlessOutput({
    sourceSeq: '40',
    data: 'queued-before-promotion',
  });
  assert.deepEqual(legacyQueued, {
    recordId: legacyQueued.recordId,
    sourceSeq: '40',
    ingestOwnerToken: 'legacy-browser',
    ownerSelectedAt: 'enqueue',
  });
  let promotionSettled = false;
  const pendingPromotion = Promise.resolve(
    ownershipHarness.controller.beginPromotion(promotionRequest()),
  ).then(result => {
    promotionSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(
    promotionSettled,
    false,
    'beginPromotion must wait for every prequeued legacy owner token to commit before fixing the boundary',
  );
  assert.deepEqual(
    getTransportMessagesInPriorityOrder(ownershipHarness.transport),
    [],
    'the disable boundary cannot enter the lane while a prequeued legacy write is unresolved',
  );
  const legacyAppliedBeforePromotion = await ownershipHarness.controller.applyEnqueuedHeadlessOutput(
    legacyQueued.recordId,
  );
  assert.deepEqual({
    ingestOwnerToken: legacyAppliedBeforePromotion.ingestOwnerToken,
    ingestOwner: legacyAppliedBeforePromotion.ingestOwner,
    commitOwner: legacyAppliedBeforePromotion.commitOwner,
    ownerSelectedAt: legacyAppliedBeforePromotion.ownerSelectedAt,
  }, {
    ingestOwnerToken: 'legacy-browser',
    ingestOwner: 'legacy-browser',
    commitOwner: 'legacy-browser',
    ownerSelectedAt: 'enqueue',
  });
  const ownershipPromotion = await pendingPromotion;
  assert.deepEqual(ownershipPromotion, {
    ok: true,
    transitionEpoch: TRANSITION_EPOCH,
    streamEpoch: PROMOTED_STREAM_EPOCH,
    boundarySourceSeq: '40',
    requiredResponderCount: 2,
  }, 'the positional boundary must be fixed after sourceSeq 40 physically commits');
  const stagedQueued = ownershipHarness.controller.enqueueHeadlessOutput({
    sourceSeq: '42',
    data: 'queued-after-promotion-start',
  });
  assert.deepEqual(stagedQueued, {
    recordId: stagedQueued.recordId,
    sourceSeq: '42',
    ingestOwnerToken: 'server-headless-staged',
    ownerSelectedAt: 'enqueue',
  });
  await ownershipHarness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A, {
    boundarySourceSeq: '40',
  }));
  await ownershipHarness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_B, {
    boundarySourceSeq: '40',
  }));
  const stagedAppliedAfterPromotion = await ownershipHarness.controller.applyEnqueuedHeadlessOutput(
    stagedQueued.recordId,
  );
  assert.deepEqual({
    ingestOwnerToken: stagedAppliedAfterPromotion.ingestOwnerToken,
    ingestOwner: stagedAppliedAfterPromotion.ingestOwner,
    commitOwner: stagedAppliedAfterPromotion.commitOwner,
    ownerSelectedAt: stagedAppliedAfterPromotion.ownerSelectedAt,
  }, {
    ingestOwnerToken: 'server-headless-staged',
    ingestOwner: 'server-headless-staged',
    commitOwner: 'server-headless',
    ownerSelectedAt: 'enqueue',
  }, 'a post-promotion enqueue must complete under its staged/server token after the ACK barrier');

  const harness = createHarness(contract);
  pushTransportMessage(harness.transport, createWsTransportMessage({ type: 'output', sessionId: SESSION_ID, data: 'prior-output', sourceSeq: '41' }, 0));
  await harness.controller.beginPromotion(promotionRequest());
  const held = await harness.controller.captureHeadlessOutput({ sourceSeq: '42', data: 'post-boundary' });
  assert.equal(held.deliveryDisposition, 'held-post-boundary');
  assert.equal(held.modelCommitted, true);
  assert.equal(held.factCommitted, true);

  const terminalQueue = getTransportMessagesInPriorityOrder(harness.transport);
  assert.equal(terminalQueue[0]?.kind, 'output');
  assert.equal(terminalQueue[1]?.kind, 'terminal-control');
  assert.equal(terminalQueue[1]?.type, 'terminal-authority:responder-disable-boundary');
  assert.equal(terminalQueue[1]?.sessionId, SESSION_ID);
  assert.deepEqual(JSON.parse(jsonWirePayloadText(terminalQueue[1]!.payload)), {
    type: 'terminal-authority:responder-disable-boundary',
    sessionId: SESSION_ID,
    transitionEpoch: TRANSITION_EPOCH,
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: PROMOTED_STREAM_EPOCH,
    boundarySourceSeq: BOUNDARY_SOURCE_SEQ,
    responderLeaseId: OLD_RESPONDER_LEASE_ID,
    requiredResponderViews: [VIEW_A, VIEW_B],
  });
  assert.equal(terminalQueue.length, 2, 'post-boundary output must remain outside the socket queue until all frozen ACKs arrive');

  for (const identity of [
    responderIdentity(VIEW_A, { transitionEpoch: '7' }),
    responderIdentity(VIEW_A, { authorityEpoch: 'peer-authority' }),
    responderIdentity(VIEW_A, { streamEpoch: '9' }),
    responderIdentity(VIEW_A, { responderLeaseId: 'wrong-responder' }),
    responderIdentity(VIEW_A, { boundarySourceSeq: '40' }),
    responderIdentity(VIEW_A, { viewGeneration: VIEW_A.viewGeneration + 1 }),
    responderIdentity(VIEW_A, {
      connectionId: VIEW_B.connectionId,
      viewGeneration: VIEW_B.viewGeneration + 1,
    }),
    responderIdentity(VIEW_A, { sessionId: 'peer-session' }),
  ]) {
    assert.equal((await harness.controller.acknowledgeLegacyDisable(identity)).accepted, false);
  }
  assert.deepEqual(await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A)), { accepted: true, completed: false });
  assert.equal(harness.controller.getState().acceptedDisableAckCount, 1, 'same viewGeneration on another connection must not collapse the composite quorum key');
  assert.deepEqual(await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A)), { accepted: true, duplicate: true, completed: false });
  assert.deepEqual(await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_B)), { accepted: true, completed: true });
  assert.equal(harness.controller.getState().acceptedDisableAckCount, 2, 'connectionId + viewGeneration must identify two independent ACK members');
  const releasedQueue = getTransportMessagesInPriorityOrder(harness.transport);
  assert.deepEqual(
    releasedQueue.map(message => [message.kind, message.type, message.outputData]),
    [
      ['output', 'output', 'prior-output'],
      ['terminal-control', 'terminal-authority:responder-disable-boundary', undefined],
      ['terminal-bulk', 'terminal-checkpoint:start', undefined],
      ['terminal-bulk', 'terminal-checkpoint:chunk', undefined],
      ['terminal-bulk', 'terminal-checkpoint:commit', undefined],
      ['output', 'output', 'post-boundary'],
    ],
    'all-view ACK must release held output exactly once after the positional boundary',
  );
  assert.deepEqual(
    releasedQueue.slice(2, 5).map(message => JSON.parse(jsonWirePayloadText(message.payload))),
    AUTHORITATIVE_CHECKPOINT_MESSAGES,
    'fresh authoritative checkpoint must fully commit on the real terminal lane before held output',
  );
  const routeTerminalAuthorityFrame = (
    wsRouterModule as unknown as Partial<WsRouterPromotionContract>
  ).routeTerminalAuthorityFrame;
  assert.equal(typeof routeTerminalAuthorityFrame, 'function', 'WsRouter authority output-lane adapter missing');
  assert.ok(routeTerminalAuthorityFrame);
  for (const mode of ['unified', 'split'] as const) {
    const controlTransport = createWsTransportQueueState();
    const outputTransport = createWsTransportQueueState();
    const socketRoles: Array<'unified' | 'output'> = releasedQueue.map(
      (message): 'unified' | 'output' => routeTerminalAuthorityFrame({
        mode,
        controlTransport,
        outputTransport,
        message: JSON.parse(jsonWirePayloadText(message.payload)) as object,
      }).socketRole,
    );
    const selectedTransport = mode === 'unified' ? controlTransport : outputTransport;
    const unusedTransport = mode === 'unified' ? outputTransport : controlTransport;
    assert.deepEqual(socketRoles, releasedQueue.map(() => mode === 'unified' ? 'unified' : 'output'));
    assert.deepEqual(
      getTransportMessagesInPriorityOrder(selectedTransport).map(message => message.type),
      ['output', 'terminal-authority:responder-disable-boundary', 'terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit', 'output'],
      `${mode} must keep prior output, boundary, complete checkpoint, and released tail on one physical terminal lane`,
    );
    assert.deepEqual(getTransportMessagesInPriorityOrder(unusedTransport), []);
  }
  assert.deepEqual(
    harness.events.filter(event => ['legacy-driver-lease-revoked', 'server-driver-lease-installed', 'server-responder-enabled', 'fresh-authoritative-checkpoint-enqueued', 'held-output-released'].includes(event.type)).map(event => event.type),
    ['fresh-authoritative-checkpoint-enqueued', 'held-output-released', 'legacy-driver-lease-revoked', 'server-driver-lease-installed', 'server-responder-enabled'],
  );

  const productionModule = await loadProductionIntegration('MIG-AC-2');
  for (const topologyChange of ['new-subscribe', 'generation-changed', 'unsubscribe', 'disconnect'] as const) {
    const topologyPty = new AuthorityIntegrationFakePty();
    const integration = createProductionIntegrationFixture(productionModule, 'split', topologyPty);
    const manager = integration.sessionManager;
    (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
    try {
      manager.createSession(`PH005 topology ${topologyChange}`, 'bash', undefined, { sessionId: SESSION_ID });
      const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
      const first = await connectProductionView(router, 'split', 11);
      const second = await connectProductionView(router, 'split', 11);
      const started = await integration.beginPromotion(SESSION_ID);
      assert.equal(started.ok, true);
      assert.equal(started.requiredResponderCount, 2, 'the production registry must freeze both negotiated composite views');

      if (topologyChange === 'new-subscribe') {
        await connectProductionView(router, 'split', 12);
      } else if (topologyChange === 'generation-changed') {
        negotiateProductionView(first.control, first.viewGeneration + 1);
      } else if (topologyChange === 'unsubscribe') {
        emitClientFrame(first.control, { type: 'unsubscribe', sessionIds: [SESSION_ID] });
      } else {
        first.control.emit('close');
      }
      await Promise.resolve();
      const recovering = integration.getAuthorityState(SESSION_ID);
      assert.equal(
        recovering?.mode,
        'rolling-back',
        `${topologyChange} must immediately leave the aborted state through ordered compatibility recovery`,
      );
      assert.equal(recovering?.restartRequired, true, `${topologyChange} must require a fresh topology freeze`);
      const expectedControllerKind = topologyChange === 'new-subscribe' ? 'new-view' : topologyChange;
      assert.equal(
        integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
          event.type === 'responder-topology-changed'
          && event.kind === expectedControllerKind
        )),
        true,
        `${topologyChange} must reach controller.notifyResponderTopologyChanged from the real router handler`,
      );
      assert.equal(
        [...first.control.sentFrames, ...first.output.sentFrames, ...second.control.sentFrames, ...second.output.sentFrames]
          .some(frame => frame.type === 'terminal-authority:promotion-aborted'),
        true,
        `${topologyChange} must be observable through the real WsRouter connection path`,
      );
      assertProductionDefaultWiring(integration);
    } finally {
      integration.destroy();
    }
  }
});

test('MIG-BGSTAB-002 promotion admission fence owns output queued while the legacy prefix is unresolved', async () => {
  const contract = await loadContract('MIG-AC-2');
  const harness = createHarness(contract);
  harness.lastCommittedSourceSeq = '39';
  const legacyPrefix = harness.controller.enqueueHeadlessOutput({
    sourceSeq: '40',
    data: 'legacy-prefix',
  });

  const promotion = harness.controller.beginPromotion(promotionRequest());
  await Promise.resolve();
  const racedOutput = harness.controller.enqueueHeadlessOutput({
    sourceSeq: '41',
    data: '\u001b[6npost-fence',
  });

  assert.equal(
    racedOutput.ingestOwnerToken,
    'server-headless-staged',
    'the synchronous promotion fence must prevent a later write-chain record from retaining legacy ownership',
  );
  assert.equal(
    (await harness.controller.applyEnqueuedHeadlessOutput(legacyPrefix.recordId)).deliveryDisposition,
    'legacy-delivered',
  );
  assert.deepEqual(await promotion, {
    ok: true,
    transitionEpoch: TRANSITION_EPOCH,
    streamEpoch: PROMOTED_STREAM_EPOCH,
    boundarySourceSeq: '40',
    requiredResponderCount: 2,
  });
  assert.equal(
    (await harness.controller.applyEnqueuedHeadlessOutput(racedOutput.recordId)).deliveryDisposition,
    'held-post-boundary',
  );
});

test('MIG-BGSTAB-002 promotion admission fence rejects a concurrent begin transaction', async () => {
  const contract = await loadContract('MIG-AC-2');
  const harness = createHarness(contract);
  const prefix = harness.controller.enqueueHeadlessOutput({ sourceSeq: '40', data: 'prefix' });
  const firstPromotion = harness.controller.beginPromotion(promotionRequest());
  await Promise.resolve();
  const concurrentPromotion = harness.controller.beginPromotion(promotionRequest({
    transitionEpoch: '9',
    nextStreamEpoch: '9',
  }));
  await harness.controller.applyEnqueuedHeadlessOutput(prefix.recordId);
  assert.deepEqual(
    await concurrentPromotion,
    { ok: false, reason: 'promotion-begin-in-flight' },
  );
  assert.equal((await firstPromotion).ok, true);
  assert.equal(harness.controller.getState().transitionEpoch, TRANSITION_EPOCH);
});

test('MIG-BGSTAB-002 promotion revalidates the frozen responder topology after its legacy prefix drains', async () => {
  const contract = await loadContract('MIG-AC-2');
  const harness = createHarness(contract);
  const prefix = harness.controller.enqueueHeadlessOutput({ sourceSeq: '40', data: 'prefix' });
  const promotion = harness.controller.beginPromotion(promotionRequest());
  await Promise.resolve();
  harness.requiredViews[0] = {
    ...harness.requiredViews[0]!,
    viewGeneration: harness.requiredViews[0]!.viewGeneration + 1,
  };

  await harness.controller.applyEnqueuedHeadlessOutput(prefix.recordId);
  assert.deepEqual(await promotion, {
    ok: false,
    reason: 'required-responder-topology-changed-before-boundary',
  });
  assert.equal(harness.controller.getState().mode, 'rolling-back');
  assert.equal(
    harness.recoveryReasons.includes('required-responder-topology-changed-before-boundary'),
    true,
  );
  assert.equal(
    getTransportMessagesInPriorityOrder(harness.transport)
      .some(message => message.type === 'terminal-authority:responder-disable-boundary'),
    false,
  );
});

test('Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-3', async () => {
  const contract = await loadContract('MIG-AC-3');
  const harness = createHarness(contract);
  const legacyOwned = await harness.controller.captureHeadlessOutput({ sourceSeq: '39', data: '\u001b[6n' });
  const splitStart = await harness.controller.captureHeadlessOutput({ sourceSeq: '40', data: '\u001b[?' });
  assert.equal(legacyOwned.modelCommitted, true, 'server headless parser must ingest live bytes before promotion');
  assert.equal(legacyOwned.factCommitted, true);
  await harness.controller.beginPromotion(promotionRequest());
  const staged = await harness.controller.captureHeadlessOutput({ sourceSeq: '42', data: '6n' });
  assert.equal(splitStart.ingestOwner, 'legacy-browser');
  assert.equal(staged.ingestOwner, 'server-headless-staged', 'the completion chunk, not parser-tail origin, owns the split query effect');
  await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A));

  const currentReply = responderIdentity(VIEW_B, { streamEpoch: LEGACY_STREAM_EPOCH, responderLeaseId: OLD_RESPONDER_LEASE_ID });
  assert.equal((await harness.controller.acceptLegacyBrowserQueryReply({ ...currentReply, replyOrdinal: 0, reply: '\u001b[1;1R' })).accepted, true);
  for (const stale of [
    responderIdentity(VIEW_B, { sessionId: 'peer-session' }),
    responderIdentity(VIEW_B, { connectionId: VIEW_A.connectionId }),
    responderIdentity(VIEW_B, { viewGeneration: VIEW_B.viewGeneration + 1 }),
    responderIdentity(VIEW_B, { transitionEpoch: '7' }),
    responderIdentity(VIEW_B, { authorityEpoch: 'peer-authority' }),
    responderIdentity(VIEW_B, { streamEpoch: '9' }),
    responderIdentity(VIEW_B, { boundarySourceSeq: '40' }),
    responderIdentity(VIEW_B, { responderLeaseId: 'peer-lease' }),
  ]) {
    assert.equal((await harness.controller.acceptLegacyBrowserQueryReply({ ...stale, replyOrdinal: 0, reply: '\u001b[1;1R' })).accepted, false);
  }
  assert.equal(harness.legacyQueryEffects.length, 1, 'server ingress must reject stale/peer replies before the dedicated PTY sink');

  const createIngress = (wsRouterModule as unknown as Partial<WsRouterPromotionContract>)
    .createTerminalQueryReplyIngress;
  assert.equal(typeof createIngress, 'function', 'WsRouter server-owned query-reply ingress contract missing');
  assert.ok(createIngress);
  const ingressWrites: string[] = [];
  const ingress = createIngress({
    readExpectedIdentity: sessionId => sessionId === SESSION_ID ? currentReply : null,
    writeTerminalQueryReply: ({ data }) => ingressWrites.push(data),
    writeInput: () => assert.fail('query-reply must never enter SessionManager.writeInput'),
    observeSemanticInput: () => assert.fail('query-reply must never enter AI semantic status'),
    isTerminalQueryReply: (data, options) => (
      options.provenance === 'parser-generated'
      && ['\u001b[1;1R', '\u001b[?1;1R', '\u001b[0n'].includes(data)
    ),
  });
  const wireReply = {
    type: 'input',
    inputKind: 'query-reply',
    sessionId: currentReply.sessionId,
    responderIdentity: currentReply,
    replyOrdinal: 0,
    data: '\u001b[1;1R',
  };
  assert.deepEqual(ingress.handle({ connectionId: VIEW_B.connectionId }, wireReply), { handled: true, accepted: true });
  for (const invalid of [
    { ...wireReply, sessionId: undefined },
    { ...wireReply, responderIdentity: undefined },
    { ...wireReply, replyOrdinal: undefined },
    { ...wireReply, sessionId: 'peer-session' },
    { ...wireReply, connectionId: currentReply.connectionId },
    { ...wireReply, responderIdentity: { ...currentReply, sessionId: 'peer-session' } },
    { ...wireReply, responderIdentity: { ...currentReply, connectionId: undefined } },
    { ...wireReply, responderIdentity: { ...currentReply, viewGeneration: undefined } },
    { ...wireReply, responderIdentity: { ...currentReply, transitionEpoch: 8 } },
    { ...wireReply, responderIdentity: { ...currentReply, transitionEpoch: '08' } },
    { ...wireReply, responderIdentity: { ...currentReply, streamEpoch: -1 } },
    { ...wireReply, responderIdentity: { ...currentReply, streamEpoch: '18446744073709551616' } },
    { ...wireReply, responderIdentity: { ...currentReply, boundarySourceSeq: 41 } },
    { ...wireReply, responderIdentity: { ...currentReply, boundarySourceSeq: '041' } },
    { ...wireReply, responderIdentity: { ...currentReply, authorityEpoch: '' } },
    { ...wireReply, responderIdentity: { ...currentReply, responderLeaseId: 'peer-lease' } },
    { ...wireReply, data: '' },
    { ...wireReply, data: 'ordinary-user-command' },
    { ...wireReply, data: '\u001b[1;1' },
    { ...wireReply, replyOrdinal: -1 },
    { ...wireReply, replyOrdinal: 1.5 },
    { ...wireReply, replyOrdinal: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(ingress.handle({ connectionId: VIEW_B.connectionId }, invalid).accepted, false);
  }
  assert.deepEqual(
    ingress.handle({ connectionId: VIEW_A.connectionId }, wireReply),
    { handled: true, accepted: false, reason: 'stale-responder-identity' },
    'a well-formed reply replayed on another live socket is stale identity, not a malformed query reply',
  );
  assert.deepEqual(ingress.handle({ connectionId: VIEW_B.connectionId }, { ...wireReply, inputKind: 'user' }), { handled: false, accepted: false });
  assert.deepEqual(ingressWrites, ['\u001b[1;1R']);

  await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_B));
  assert.equal((await harness.controller.settleQueryEffect({ recordId: legacyOwned.recordId, replyOrdinal: 0, reply: '\u001b[1;1R', streamEpoch: LEGACY_STREAM_EPOCH, responderLeaseId: OLD_RESPONDER_LEASE_ID })).disposition, 'legacy-owned');
  const applied = await harness.controller.settleQueryEffect({ recordId: staged.recordId, replyOrdinal: 0, reply: '\u001b[?1;1R', streamEpoch: PROMOTED_STREAM_EPOCH, responderLeaseId: NEW_RESPONDER_LEASE_ID });
  const duplicate = await harness.controller.settleQueryEffect({ recordId: staged.recordId, replyOrdinal: 0, reply: '\u001b[?1;1R', streamEpoch: PROMOTED_STREAM_EPOCH, responderLeaseId: NEW_RESPONDER_LEASE_ID });
  assert.equal(applied.disposition, 'applied');
  assert.equal(duplicate.disposition, 'duplicate');
  assert.equal(duplicate.effectKey, applied.effectKey);
  assert.equal((await harness.controller.settleQueryEffect({ recordId: staged.recordId, replyOrdinal: 0, reply: 'different-bytes', streamEpoch: PROMOTED_STREAM_EPOCH, responderLeaseId: NEW_RESPONDER_LEASE_ID })).disposition, 'rejected');
  assert.match(applied.effectKey, /session-generation-1.*8.*42.*responder-server-8.*0/);
  assert.deepEqual(harness.effectTimeline.slice(-4), ['headless-model-committed', 'headless-fact-committed', 'query-effect-cas-committed', 'pty-query-reply-written']);
  assert.equal(harness.queryEffects.length, 1);
  assert.equal((await harness.controller.settleQueryEffect({ recordId: staged.recordId, replyOrdinal: 1, reply: 'stale', streamEpoch: '9', responderLeaseId: NEW_RESPONDER_LEASE_ID })).disposition, 'rejected');

  const failing = createHarness(contract);
  await promoteAllViews(failing.controller);
  const output = await failing.controller.captureHeadlessOutput({ sourceSeq: '43', data: '\u001b[5n' });
  failing.throwQueryWrite = true;
  assert.equal((await failing.controller.settleQueryEffect({ recordId: output.recordId, replyOrdinal: 0, reply: '\u001b[0n', streamEpoch: PROMOTED_STREAM_EPOCH, responderLeaseId: NEW_RESPONDER_LEASE_ID })).disposition, 'failed');
  assert.equal((await failing.controller.settleQueryEffect({ recordId: output.recordId, replyOrdinal: 0, reply: '\u001b[0n', streamEpoch: PROMOTED_STREAM_EPOCH, responderLeaseId: NEW_RESPONDER_LEASE_ID })).disposition, 'failed');
  assert.equal(failing.queryEffects.length, 1, 'a failed effect is terminal and must not write PTY twice');
  assert.deepEqual(await harness.controller.rejectBrowserParserTail({ transitionEpoch: TRANSITION_EPOCH, parserTail: '\u001b[38;2;' }), { accepted: false, reason: 'browser-parser-tail-transfer-forbidden' });

  const sessionManagerSource = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf8');
  const pendingOutputStart = sessionManagerSource.indexOf('interface PendingHeadlessOutput');
  const sessionDataStart = sessionManagerSource.indexOf('interface SessionData', pendingOutputStart);
  const pendingOwnerTokenIndex = sessionManagerSource.indexOf('ingestOwnerToken', pendingOutputStart);
  assert.equal(
    pendingOutputStart >= 0
      && pendingOwnerTokenIndex > pendingOutputStart
      && pendingOwnerTokenIndex < sessionDataStart,
    true,
    `${EXPECTED_FAILURES['MIG-AC-3']}: PendingHeadlessOutput must persist the enqueue-time owner token`,
  );
  const queueStart = sessionManagerSource.indexOf('private queueAcceptedHeadlessOutput');
  const applyStart = sessionManagerSource.indexOf('private async applyHeadlessOutput', queueStart);
  const reserveOwnerIndex = sessionManagerSource.indexOf('.enqueueHeadlessOutput(', queueStart);
  const deferredWriteIndex = sessionManagerSource.indexOf('.then(async () =>', queueStart);
  const ownerTokenApplyIndex = sessionManagerSource.indexOf('pendingOutput.ingestOwnerToken', deferredWriteIndex);
  assert.equal(
    queueStart >= 0
      && reserveOwnerIndex > queueStart
      && reserveOwnerIndex < deferredWriteIndex
      && deferredWriteIndex < applyStart
      && ownerTokenApplyIndex > deferredWriteIndex
      && ownerTokenApplyIndex < applyStart,
    true,
    `${EXPECTED_FAILURES['MIG-AC-3']}: SessionManager must reserve ownership before its deferred write-chain callback and pass that exact token to apply`,
  );

  const wsRouterSource = readFileSync(new URL('../ws/WsRouter.ts', import.meta.url), 'utf8');
  const handleInputStart = wsRouterSource.indexOf('private handleInput(');
  const handleResizeStart = wsRouterSource.indexOf('private handleResize(', handleInputStart);
  const actualIngressHelperIndex = wsRouterSource.indexOf('this.handleTerminalQueryReplyInput(', handleInputStart);
  const replayLookupIndex = wsRouterSource.indexOf('replayPendingSessions.get(', handleInputStart);
  const genericIngressIndex = wsRouterSource.indexOf('this.submitWebSocketInputThroughGateway(', handleInputStart);
  assert.equal(
    handleInputStart >= 0
      && actualIngressHelperIndex > handleInputStart
      && actualIngressHelperIndex < replayLookupIndex
      && replayLookupIndex < genericIngressIndex
      && genericIngressIndex < handleResizeStart,
    true,
    `${EXPECTED_FAILURES['MIG-AC-3']}: WsRouter actual input path must invoke the query-reply helper before replay/outbox and generic input`,
  );

  const productionModule = await loadProductionIntegration('MIG-AC-3');
  const fakePty = new AuthorityIntegrationFakePty();
  const headlessWriteGates: Array<{
    data: string;
    state: HeadlessTerminalState;
    deferred: Deferred<void>;
  }> = [];
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty, {
    retainedTerminalInitialOrdinal: { streamEpoch: LEGACY_STREAM_EPOCH, sourceSeq: '39' },
    writeHeadlessTerminalFn: async (state, data) => {
      const deferred = createDeferred<void>();
      headlessWriteGates.push({ data, state, deferred });
      await deferred.promise;
      await writeHeadlessTerminal(state, data);
    },
  });
  const integrationManager = integration.sessionManager;
  (integrationManager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  const integrationApi = integrationManager as unknown as SessionManagerAuthorityIntegrationApi;
  let genericWriteInputCalls = 0;
  let semanticInputObserverCalls = 0;
  const originalWriteInput = integrationManager.writeInput.bind(integrationManager);
  integrationManager.writeInput = ((...args: Parameters<SessionManager['writeInput']>) => {
    genericWriteInputCalls += 1;
    return originalWriteInput(...args);
  }) as SessionManager['writeInput'];
  const originalSemanticObserver = integrationApi.updateCommandInputBuffer.bind(integrationManager);
  integrationApi.updateCommandInputBuffer = (...args: unknown[]) => {
    semanticInputObserverCalls += 1;
    return originalSemanticObserver(...args);
  };
  try {
    integrationManager.createSession('PH005 headless identity', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const integrationSession = integrationApi.sessions.get(SESSION_ID);
    assert.ok(integrationSession, `${EXPECTED_FAILURES['MIG-AC-3']}: SessionManager integration session is missing`);
    assert.ok(
      integrationSession.terminalQueryResponder,
      `${EXPECTED_FAILURES['MIG-AC-3']}: SessionManager did not install the per-session query responder`,
    );
    assert.equal(
      integrationSession.terminalQueryResponder.attachedHeadlessState,
      integrationSession.headless,
      'query responder installation must receive sessionData.headless by object identity',
    );
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const firstView = await connectProductionView(router, 'split', 11);
    const secondView = await connectProductionView(router, 'split', 11);
    assertProductionDefaultWiring(integration);

    fakePty.emitData('abc\u001b[?');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(headlessWriteGates.length, 1, 'the allowed write seam must observe the queued prefix');
    assert.equal(headlessWriteGates[0]?.state, integrationSession.headless);
    assert.equal(
      integrationSession.headless.terminal.buffer.active.cursorX,
      0,
      'PTY onData must not mutate the authoritative model before the deferred headless write commits',
    );
    let actualPromotionSettled = false;
    const pendingActualPromotion = Promise.resolve(integration.beginPromotion(SESSION_ID)).then(result => {
      actualPromotionSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      actualPromotionSettled,
      false,
      'SessionManager beginPromotion must fence the unresolved headless write-chain prefix',
    );
    headlessWriteGates[0]!.deferred.resolve(undefined);
    await integrationSession.headlessWriteChain;
    const actualPromotion = await pendingActualPromotion;
    assert.equal(actualPromotion.ok, true, 'production adapter must execute promotion through its default controller');
    assert.equal(actualPromotion.boundarySourceSeq, '40');
    assert.equal(actualPromotion.requiredResponderCount, 2);
    assert.equal(integrationSession.headless.terminal.buffer.active.cursorX, 3);
    const firstBoundary = firstView.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    const secondBoundary = secondView.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    assert.ok(firstBoundary);
    assert.ok(secondBoundary);
    assert.equal(firstBoundary.connectionId, firstView.connectionId);
    assert.equal(secondBoundary.connectionId, secondView.connectionId);
    assert.equal(firstBoundary.viewGeneration, firstView.viewGeneration);
    assert.equal(secondBoundary.viewGeneration, secondView.viewGeneration);
    assert.deepEqual(
      { ...secondBoundary, connectionId: undefined, viewGeneration: undefined },
      { ...firstBoundary, connectionId: undefined, viewGeneration: undefined },
      'each physical responder boundary carries its own connection/view envelope',
    );
    assert.equal(
      firstView.control.sentFrames.some(frame => frame.type === 'terminal-authority:responder-disable-boundary'),
      false,
      'split authority boundary must use the paired output socket',
    );
    const requiredViews = firstBoundary.requiredResponderViews as Array<Record<string, unknown>>;
    assert.equal(requiredViews.length, 2);
    const readFrozenIdentity = (view: ProductionConnectedView): Record<string, unknown> => {
      const frozen = requiredViews.find(candidate => candidate.connectionId === view.connectionId);
      assert.ok(frozen, 'both pre-negotiated production views must be members of the frozen quorum');
      assertFrozenNegotiatedIdentity(view, frozen);
      return {
        ...frozen,
        sessionId: firstBoundary.sessionId,
        transitionEpoch: firstBoundary.transitionEpoch,
        authorityEpoch: firstBoundary.authorityEpoch,
        streamEpoch: firstBoundary.streamEpoch,
        boundarySourceSeq: firstBoundary.boundarySourceSeq,
        responderLeaseId: firstBoundary.responderLeaseId,
      };
    };
    const firstIdentity = readFrozenIdentity(firstView);
    const secondIdentity = readFrozenIdentity(secondView);
    emitClientFrame(firstView.control, {
      type: 'terminal-authority:responder-disabled',
      ...firstIdentity,
    });
    for (let attempt = 0; attempt < 20 && !firstView.control.sentFrames.some(frame => (
      frame.type === 'terminal-authority:responder-disable-accepted'
    )); attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(
      firstView.control.sentFrames.some(frame => (
        frame.type === 'terminal-authority:responder-disable-accepted'
        && frame.accepted === true
        && frame.completed === false
      )),
      true,
      'the production ACK receipt type must not be overwritten by the client request spread',
    );

    const actualWireReply = {
      ...wireReply,
      sessionId: SESSION_ID,
      responderIdentity: {
        ...secondIdentity,
        streamEpoch: LEGACY_STREAM_EPOCH,
      },
    };
    emitClientFrame(secondView.control, actualWireReply);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      fakePty.writes.filter(write => write === '\u001b[1;1R').length,
      1,
      'the subscribed and negotiated actual WsRouter input path must reach the dedicated sink exactly once',
    );
    assert.equal(genericWriteInputCalls, 0, 'actual WsRouter query reply dispatch must bypass generic writeInput');
    assert.equal(semanticInputObserverCalls, 0, 'actual WsRouter query reply dispatch must bypass semantic observation');
    assert.equal(
      secondView.control.sentFrames.some(frame => (
        frame.type === 'terminal-authority:query-reply-accepted'
        && frame.accepted === true
        && frame.ptyWriteCount === 1
      )),
      true,
      'the real subscribed/negotiate fixture must receive one observable server acceptance receipt',
    );
    fakePty.writes.length = 0;

    fakePty.emitData('6n');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(headlessWriteGates.length, 2, 'the completion chunk must use the same deferred SessionManager seam');
    headlessWriteGates[1]!.deferred.resolve(undefined);
    await integrationSession.headlessWriteChain;
    assert.deepEqual(fakePty.writes, [], 'the staged query fact cannot write PTY before full responder ACK');
    emitClientFrame(secondView.control, {
      type: 'terminal-authority:responder-disabled',
      ...secondIdentity,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fakePty.writes.at(-1), '\u001b[?1;4R', 'private DECXCPR must preserve the CSI private marker');
    assert.equal(fakePty.writes.filter(write => write === '\u001b[?1;4R').length, 1);

    const actualAudit = integration.getAuthorityAuditTrail(SESSION_ID);
    const prefixEnqueue = actualAudit.find(event => (
      event.type === 'headless-output-enqueued'
      && event.sourceSeq === '40'
    ));
    const completionEnqueue = actualAudit.find(event => (
      event.type === 'headless-output-enqueued'
      && event.sourceSeq === '41'
    ));
    assert.equal(prefixEnqueue?.owner, 'legacy-browser');
    assert.equal(completionEnqueue?.owner, 'server-headless-staged');
    const modelCommitIndex = actualAudit.findIndex(event => (
      event.type === 'headless-model-committed' && event.sourceSeq === '41'
    ));
    const factCommitIndex = actualAudit.findIndex(event => (
      event.type === 'headless-fact-committed' && event.sourceSeq === '41'
    ));
    const effectCasIndex = actualAudit.findIndex(event => event.type === 'query-effect-cas-committed');
    const dedicatedPtyIndex = actualAudit.findIndex(event => event.type === 'pty-query-reply-written');
    assert.equal(
      modelCommitIndex >= 0
        && modelCommitIndex < factCommitIndex
        && factCommitIndex < effectCasIndex
        && effectCasIndex < dedicatedPtyIndex,
      true,
      'actual retained model/fact commit must precede effect CAS and the dedicated PTY write',
    );
    assert.equal(genericWriteInputCalls, 0, 'server query replies must not use SessionManager.writeInput');
    assert.equal(semanticInputObserverCalls, 0, 'server query replies must not enter user/AI semantic input observation');
    assertProductionDefaultWiring(integration, 1);

    emitClientFrame(secondView.control, {
      type: 'unsubscribe',
      sessionIds: [SESSION_ID],
    });
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'server',
      'the post-completion unsubscribe rejection fixture is separate from promotion-time topology abort',
    );
    emitClientFrame(secondView.control, actualWireReply);
    assert.equal(fakePty.writes.length, 1, 'the rejected duplicate frame cannot create a second PTY write');
    assert.equal(
      secondView.control.sentFrames.some(frame => (
        frame.type === 'terminal-authority:query-reply-rejected'
        && frame.accepted === false
        && frame.reason === 'not-subscribed'
      )),
      true,
      'the actual WsRouter must emit an observable rejection after unsubscribe',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 checkpoint pump waits for each physical send settlement before admitting the next chunk', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-3');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 checkpoint pump', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    const holdBoundary = (frame: Record<string, unknown>) => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    );
    view.output.holdSendPredicate = holdBoundary;
    const promotionPromise = integration.beginPromotion(SESSION_ID);
    for (let attempt = 0; attempt < 100 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    assert.equal((await promotionPromise).ok, true);

    const holdCheckpoint = (frame: Record<string, unknown>) => (
      frame.type === 'terminal-checkpoint:capability'
      || frame.type === 'terminal-checkpoint:start'
      || frame.type === 'terminal-checkpoint:chunk'
      || frame.type === 'terminal-checkpoint:commit'
    );
    view.output.holdSendPredicate = holdCheckpoint;

    const boundary = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    assert.ok(boundary);
    const frozen = (boundary.requiredResponderViews as Array<Record<string, unknown>>)
      .find(candidate => candidate.connectionId === view.connectionId);
    assert.ok(frozen);
    emitClientFrame(view.control, {
      type: 'terminal-authority:responder-disabled',
      ...frozen,
      sessionId: SESSION_ID,
      transitionEpoch: boundary.transitionEpoch,
      authorityEpoch: boundary.authorityEpoch,
      streamEpoch: boundary.streamEpoch,
      boundarySourceSeq: boundary.boundarySourceSeq,
      responderLeaseId: boundary.responderLeaseId,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'promoting');
    assert.equal(
      view.output.sentFrames.filter(frame => frame.type === 'terminal-checkpoint:capability'
        && frame.authorityMode === 'checkpoint').length,
      1,
    );
    assert.equal(
      view.output.sentFrames.some(frame => frame.type === 'terminal-checkpoint:start'),
      false,
      'a held capability callback must keep checkpoint start outside the WebSocket transport queue',
    );
    for (let attempt = 0; attempt < 12
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'server'; attempt += 1) {
      if (view.output.heldSendCallbackCount > 0) view.output.releaseNextSend();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
    const orderedTypes = view.output.sentFrames
      .map(frame => String(frame.type))
      .filter(type => type === 'terminal-checkpoint:capability'
        || type === 'terminal-checkpoint:start'
        || type === 'terminal-checkpoint:chunk'
        || type === 'terminal-checkpoint:commit');
    assert.deepEqual(orderedTypes.slice(-4), [
      'terminal-checkpoint:capability',
      'terminal-checkpoint:start',
      'terminal-checkpoint:chunk',
      'terminal-checkpoint:commit',
    ]);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 checkpoint pump cannot deliver queued stale frames to a successor socket with the same logical connection', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 stale checkpoint pump successor socket', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    const predecessorStreamEpoch = integration.getAuthorityState(SESSION_ID)?.streamEpoch;
    assert.ok(predecessorStreamEpoch);
    const predecessorFrameStart = view.output.sentFrames.length;

    (router as unknown as {
      updateRuntimeConfig(input: { stabilityModes: { wsSendMode: 'safe-send-enforce' } }): void;
    }).updateRuntimeConfig({ stabilityModes: { wsSendMode: 'safe-send-enforce' } });
    view.output.holdSendPredicate = frame => frame.type === 'terminal-authority:queue-blocker';
    (router as unknown as {
      sendTo(ws: ExecutableAuthoritySocket, message: object): boolean;
    }).sendTo(view.output, { type: 'terminal-authority:queue-blocker' });
    for (let attempt = 0; attempt < 30 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.output.heldSendCallbackCount, 1, 'the predecessor transport queue must be physically blocked');
    negotiateProductionView(view.control, 12);

    const successorOutput = new ExecutableAuthoritySocket('same-logical-successor-output');
    const controlConnected = view.control.sentFrames.find(frame => frame.type === 'connected');
    const pairToken = String(controlConnected?.pairToken ?? '');
    assert.notEqual(pairToken, '');
    router.wss.emit(
      'connection',
      successorOutput,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: view.clientGroupId,
        pairToken,
      },
    );
    assert.equal(
      successorOutput.sentFrames.some(frame => frame.type === 'terminal-checkpoint:start'),
      false,
      'the successor must not inherit any already-settled predecessor checkpoint frame',
    );

    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (successorOutput.sentFrames.some(frame => (
        frame.type === 'terminal-authority:rollback-start'
      ))) break;
    }

    assert.equal(
      successorOutput.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:start'
        && frame.streamEpoch === predecessorStreamEpoch
      )),
      false,
      'a successor must never receive the predecessor checkpoint transaction after its transport binding changes',
    );
    assert.equal(
      successorOutput.sentFrames.filter(frame => (
        frame.type === 'terminal-authority:rollback-start'
      )).length,
      1,
      'a binding replacement must start exactly one fresh fail-closed recovery instead of silently dropping the affected view',
    );
    assert.equal(
      view.output.sentFrames.slice(predecessorFrameStart).some(frame => (
        frame.type === 'terminal-checkpoint:start'
        && frame.streamEpoch === predecessorStreamEpoch
      )),
      false,
      'a queued predecessor checkpoint must be revalidated immediately before its physical WebSocket write',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 binding replacement recovers an active checkpoint live-output settlement failure', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 active checkpoint live output successor socket', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);

    view.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:output';
    fakePty.emitData('live-output-after-active-checkpoint');
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    await session.headlessWriteChain;
    for (let attempt = 0; attempt < 30 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.output.heldSendCallbackCount, 1, 'the active checkpoint live output must be physically held');

    const routerInternals = router as unknown as {
      clients: Map<ExecutableAuthoritySocket, Record<string, unknown>>;
      splitSocketGroups: Map<ExecutableAuthoritySocket, Record<string, unknown>>;
    };
    const controlMeta = routerInternals.clients.get(view.control);
    const outputMeta = routerInternals.clients.get(view.output);
    const group = routerInternals.splitSocketGroups.get(view.control);
    assert.ok(controlMeta);
    assert.ok(outputMeta);
    assert.ok(group);
    const successorControl = new ExecutableAuthoritySocket('active-checkpoint-successor-control');
    const successorOutput = new ExecutableAuthoritySocket('active-checkpoint-successor-output');
    const successorGroup = { ...group, control: successorControl, output: successorOutput };
    routerInternals.clients.set(successorControl, { ...controlMeta });
    routerInternals.clients.set(successorOutput, { ...outputMeta });
    routerInternals.splitSocketGroups.set(successorControl, successorGroup);
    routerInternals.splitSocketGroups.set(successorOutput, successorGroup);
    assert.equal(
      router.getTerminalAuthorityResponderViews(SESSION_ID).some(candidate => (
        candidate.connectionId === view.connectionId && candidate.viewGeneration === view.viewGeneration
      )),
      true,
      'the logical view must remain current through its replacement transport binding',
    );

    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'authority-send-recovery-scheduled'
          && event.kind === 'checkpoint-transport-binding-replaced'
      ))) break;
    }
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'authority-send-recovery-scheduled'
          && event.kind === 'checkpoint-transport-binding-replaced'
      )),
      true,
      'a failed live-output settlement must schedule authoritative recovery instead of being acknowledged as delivered',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 promotion begin accepts a boundary ACK that wins the send-callback race', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-3');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 boundary ACK wins send callback race', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    view.output.holdSendPredicate = frame => frame.type === 'terminal-authority:responder-disable-boundary';

    const promotionPromise = integration.beginPromotion(SESSION_ID);
    for (let attempt = 0; attempt < 100 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);
    const boundary = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    assert.ok(boundary);
    const frozen = (boundary.requiredResponderViews as Array<Record<string, unknown>>)[0];
    assert.ok(frozen);

    emitClientFrame(view.control, {
      type: 'terminal-authority:responder-disabled',
      ...frozen,
      sessionId: SESSION_ID,
      transitionEpoch: boundary.transitionEpoch,
      authorityEpoch: boundary.authorityEpoch,
      streamEpoch: boundary.streamEpoch,
      boundarySourceSeq: boundary.boundarySourceSeq,
      responderLeaseId: boundary.responderLeaseId,
    });
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();

    const promotion = await promotionPromise;
    assert.equal(promotion.ok, true, JSON.stringify(promotion));
    for (let attempt = 0; attempt < 20
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'server'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID)
        .some(event => event.type === 'server-responder-enabled'),
      true,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 checkpoint send callback failure revokes server authority and starts fresh rollback', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-3');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 checkpoint callback failure', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    view.output.holdSendPredicate = frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    );
    const promotionPromise = integration.beginPromotion(SESSION_ID);
    for (let attempt = 0; attempt < 100 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.output.heldSendCallbackCount > 0, true);
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    assert.equal((await promotionPromise).ok, true);
    const boundary = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    assert.ok(boundary);
    const frozen = (boundary.requiredResponderViews as Array<Record<string, unknown>>)[0];
    assert.ok(frozen);
    view.output.holdSendPredicate = frame => (
      frame.type === 'terminal-checkpoint:capability'
      || frame.type === 'terminal-checkpoint:start'
    );
    emitClientFrame(view.control, {
      type: 'terminal-authority:responder-disabled',
      ...frozen,
      sessionId: SESSION_ID,
      transitionEpoch: boundary.transitionEpoch,
      authorityEpoch: boundary.authorityEpoch,
      streamEpoch: boundary.streamEpoch,
      boundarySourceSeq: boundary.boundarySourceSeq,
      responderLeaseId: boundary.responderLeaseId,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'promoting');
    assert.equal(view.output.sentFrames.some(frame => frame.type === 'terminal-checkpoint:capability'), true);
    const failCompatibilityFrame = (frame: Record<string, unknown>) => (
      frame.type === 'terminal-authority:rollback-start'
      || (frame.type === 'terminal-checkpoint:capability' && frame.authorityMode === 'legacy')
      || (frame.type === 'terminal-checkpoint:start' && frame.mode === 'compatibility')
    );
    view.control.sendFailurePredicate = failCompatibilityFrame;
    view.output.sendFailurePredicate = failCompatibilityFrame;
    view.output.releaseNextSend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(view.output.sentFrames.some(frame => frame.type === 'terminal-checkpoint:start'), true);
    view.output.releaseNextSend(new Error('injected-checkpoint-send-failure'));
    for (let attempt = 0; attempt < 6
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'rolling-back'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');
    for (let attempt = 0; attempt < 20
      && manager.getTerminalAuthorityRuntimePortState(SESSION_ID)?.responder.serverEnabled === true; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const ports = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
    assert.equal(ports?.responder.serverEnabled, false);
    assert.notEqual(ports?.driver.active, 'server-headless');
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    const recoveryEpoch = integration.getAuthorityState(SESSION_ID)?.transitionEpoch;
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.transitionEpoch,
      recoveryEpoch,
      'a persistent compatibility transport failure must wait for topology recovery instead of restarting epochs forever',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 retries a single failed authority-send rollback without another callback', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 single failed authority-send rollback retry', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);

    const authorityManager = manager as unknown as SessionManagerAuthorityIntegrationApi;
    const originalBeginRollback = authorityManager.beginTerminalAuthorityRollback.bind(manager);
    let rollbackAttempts = 0;
    authorityManager.beginTerminalAuthorityRollback = async (...args) => {
      rollbackAttempts += 1;
      if (rollbackAttempts === 1) {
        return { ok: false, reason: 'injected-first-rollback-failure' };
      }
      return originalBeginRollback(...args);
    };
    view.output.sendFailurePredicate = frame => frame.type === 'terminal-checkpoint:output';
    fakePty.emitData('single transport settlement failure');
    const session = authorityManager.sessions.get(SESSION_ID);
    assert.ok(session);
    await session.headlessWriteChain;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (rollbackAttempts >= 2) break;
    }
    assert.equal(
      rollbackAttempts >= 2,
      true,
      'the first failed recovery rollback must schedule one bounded retry without a second transport callback',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 hard reload waits for exact control-lane readiness before its atomic checkpoint batch and PTY tail', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 hard reload atomic tail', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    const frameStart = view.output.sentFrames.length;
    const controlFrameStart = view.control.sentFrames.length;

    negotiateProductionView(view.control, 12);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (view.control.sentFrames.slice(controlFrameStart).some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      ))) break;
    }
    const preparationCapability = view.control.sentFrames.slice(controlFrameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.checkpointDeliveryPreparation !== undefined
    ));
    assert.ok(preparationCapability);
    const preparation = preparationCapability.checkpointDeliveryPreparation as Record<string, unknown>;
    assert.equal(
      view.output.sentFrames.slice(frameStart).some(frame => (
        frame.viewGeneration === 12
        && ['terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit']
          .includes(String(frame.type))
      )),
      false,
    );
    emitClientFrame(view.output, {
      type: 'terminal-checkpoint:ready',
      protocolVersion: 1,
      sessionId: SESSION_ID,
      viewGeneration: preparation.viewGeneration,
      authorityEpoch: preparation.authorityEpoch,
      streamEpoch: preparation.streamEpoch,
      driverLeaseGeneration: preparation.driverLeaseGeneration,
      acceptedViewAttributesGeneration: preparation.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: preparation.viewAttributesChallengeId,
      checkpointDeliveryId: preparation.checkpointDeliveryId,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      view.output.sentFrames.slice(frameStart).some(frame => (
        frame.viewGeneration === 12
        && ['terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit']
          .includes(String(frame.type))
      )),
      false,
      'an output-lane ready must not release a control-bound checkpoint delivery',
    );
    view.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:capability'
      && frame.checkpointDeliveryPreparation === undefined
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>)
        .some(candidate => candidate.viewGeneration === 12);
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:ready',
      protocolVersion: 1,
      sessionId: SESSION_ID,
      viewGeneration: preparation.viewGeneration,
      authorityEpoch: preparation.authorityEpoch,
      streamEpoch: preparation.streamEpoch,
      driverLeaseGeneration: preparation.driverLeaseGeneration,
      acceptedViewAttributesGeneration: preparation.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: preparation.viewAttributesChallengeId,
      checkpointDeliveryId: preparation.checkpointDeliveryId,
    });
    for (let attempt = 0; attempt < 20 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);
    fakePty.emitData('post-hard-reload-tail');
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    await session.headlessWriteChain;
    assert.equal(integration.getAuthorityState(SESSION_ID)?.ptyPaused, false);
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (view.output.sentFrames.slice(frameStart).some(frame => (
        frame.type === 'terminal-checkpoint:output' && frame.viewGeneration === 12
      ))) break;
    }
    const frames = view.output.sentFrames.slice(frameStart).filter(frame => (
      (frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>)
          .some(candidate => candidate.viewGeneration === 12))
      || (frame.viewGeneration === 12
        && (frame.type === 'terminal-checkpoint:start'
        || frame.type === 'terminal-checkpoint:chunk'
        || frame.type === 'terminal-checkpoint:commit'
        || frame.type === 'terminal-checkpoint:output'))
    ));
    assert.deepEqual(frames.map(frame => frame.type), [
      'terminal-checkpoint:capability',
      'terminal-checkpoint:start',
      'terminal-checkpoint:chunk',
      'terminal-checkpoint:commit',
      'terminal-checkpoint:output',
    ]);
    assert.equal(frames.at(-1)?.checkpointEpoch, frames.find(frame => frame.type === 'terminal-checkpoint:commit')?.checkpointEpoch);
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 unready checkpoint preparation expires without admitting an authoritative checkpoint', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    fakePty,
    { checkpointReadyHandshakeTimeoutMs: 25 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 unready checkpoint preparation', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    const outputFrameStart = view.output.sentFrames.length;
    negotiateProductionView(view.control, 12);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (view.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      ))) break;
    }
    assert.equal(
      view.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      )),
      true,
    );
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-timeout'
      )),
      true,
    );
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
    assert.equal(
      view.control.sentFrames.filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      )).length >= 2,
      true,
    );
    assert.equal(
      view.output.sentFrames.slice(outputFrameStart).some(frame => (
        frame.viewGeneration === 12
        && frame.authorityMode === 'server'
        && ['terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit']
          .includes(String(frame.type))
      )),
      false,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 exhausted checkpoint-ready retries roll back the unready server authority', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { checkpointReadyHandshakeTimeoutMs: 25 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 exhausted checkpoint-ready retries', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    const outputFrameStart = view.output.sentFrames.length;
    negotiateProductionView(view.control, 12);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const retryExhausted = integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-retry-exhausted'
      ));
      if (retryExhausted && integration.getAuthorityState(SESSION_ID)?.mode === 'rolling-back') break;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }

    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-retry-exhausted'
      )),
      true,
    );
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');
    assert.equal(
      view.output.sentFrames.slice(outputFrameStart).some(frame => (
        frame.viewGeneration === 12
        && frame.authorityMode === 'server'
        && ['terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit']
          .includes(String(frame.type))
      )),
      false,
      'an unready view must never admit an authoritative checkpoint before safe recovery',
    );
    const rollbackStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 12
    ));
    const checkpointStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === 12
    ));
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    const checkpointIdentity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 12,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: checkpointStart.oldestRetainedSeq,
      retentionPolicyId: checkpointStart.retentionPolicyId,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...checkpointIdentity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...checkpointIdentity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      ...checkpointIdentity,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    for (let attempt = 0; attempt < 40
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'legacy'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 rollback cancels a pending checkpoint-ready deadline before it can retry', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { checkpointReadyHandshakeTimeoutMs: 25 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 rollback cancels checkpoint-ready deadline', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    negotiateProductionView(view.control, 12);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (view.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      ))) break;
    }
    assert.equal(
      view.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      )),
      true,
    );
    const preparationCountBeforeRollback = view.control.sentFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.checkpointDeliveryPreparation !== undefined
    )).length;
    const timeoutAuditCountBeforeRollback = integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
      event.type === 'checkpoint-delivery-ready-timeout'
    )).length;

    assert.deepEqual(await integration.beginRollback(SESSION_ID), { ok: true });
    await new Promise<void>(resolve => setTimeout(resolve, 80));

    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
        event.type === 'checkpoint-delivery-ready-timeout'
      )).length,
      timeoutAuditCountBeforeRollback,
      'a rollback must cancel the obsolete server-authority ready timer',
    );
    assert.equal(
      view.control.sentFrames.filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      )).length,
      preparationCountBeforeRollback,
      'a stale server-authority deadline must not issue a retry after rollback',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 bounds checkpoint-ready retries for an unresponsive current view', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { checkpointReadyHandshakeTimeoutMs: 15 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 bounded checkpoint-ready retry', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    negotiateProductionView(view.control, 12);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-retry-exhausted'
      ))) break;
    }

    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-retry-exhausted'
      )),
      true,
      'an unresponsive current view must stop automatic checkpoint-ready retries',
    );
    assert.equal(
      view.control.sentFrames.filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      )).length,
      4,
      'the initial capability plus three bounded retries are the complete retry lineage',
    );
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'rolling-back',
      'retry exhaustion must fail closed into rollback instead of leaving unready server authority active',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 checkpoint-ready deadline begins only after the control preparation settles', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { checkpointReadyHandshakeTimeoutMs: 25 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 checkpoint ready deadline settlement', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    view.control.holdSendPredicate = frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.checkpointDeliveryPreparation !== undefined
    );
    negotiateProductionView(view.control, 12);
    for (let attempt = 0; attempt < 30 && view.control.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.control.heldSendCallbackCount, 1);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-timeout'
      )),
      false,
      'an unsent prepare cannot consume its client-ready deadline',
    );
    view.control.holdSendPredicate = null;
    view.control.releaseNextSend();
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'checkpoint-delivery-ready-timeout'
      )),
      true,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 same-generation hard reload replaces the live server-authority view', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 same-generation hard reload', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const staleView = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [staleView]);

    const replacement = await connectProductionView(router, 'split', 11, {
      autoAcknowledgeCheckpoint: 'initial',
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (replacement.output.sentFrames.some(frame => frame.type === 'terminal-checkpoint:commit')) break;
    }
    const replacementFrames = [
      ...replacement.control.sentFrames,
      ...replacement.output.sentFrames,
    ];
    const knownCheckpointTypes = new Set([
      'terminal-checkpoint:capability',
      'terminal-checkpoint:start',
      'terminal-checkpoint:chunk',
      'terminal-checkpoint:commit',
      'terminal-checkpoint:output',
      'terminal-checkpoint:rejected',
    ]);
    const unknownCheckpointFrames = replacementFrames.filter(frame => (
      String(frame.type).startsWith('terminal-checkpoint:')
      && !knownCheckpointTypes.has(String(frame.type))
    ));
    assert.deepEqual(
      unknownCheckpointFrames,
      [],
      `same-generation replacement emitted an unsupported checkpoint frame: ${JSON.stringify(unknownCheckpointFrames)}`,
    );
    assert.equal(
      replacement.output.sentFrames.some(frame => frame.type === 'terminal-checkpoint:commit'),
      true,
      'the replacement connection must receive one fresh authoritative checkpoint',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 authority-ready recovery retries after transient empty router projection', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 transient empty router projection', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11, {
      autoAcknowledgeCheckpoint: 'any',
    });
    await promoteProductionViews(integration, [view]);

    const originalReadViews = router.getTerminalAuthorityResponderViews.bind(router);
    let remainingProjectionMisses = Number.POSITIVE_INFINITY;
    router.getTerminalAuthorityResponderViews = sessionId => (
      remainingProjectionMisses-- > 0 ? [] : originalReadViews(sessionId)
    );
    const frameStart = view.output.sentFrames.length;
    negotiateProductionView(view.control, 12);
    remainingProjectionMisses = 10;

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      if (view.output.sentFrames.slice(frameStart).some(frame => (
        frame.type === 'terminal-checkpoint:commit' && frame.viewGeneration === 12
      ))) break;
    }
    assert.equal(
      view.output.sentFrames.slice(frameStart).some(frame => (
        frame.type === 'terminal-checkpoint:commit' && frame.viewGeneration === 12
      )),
      true,
      `transient empty projection stranded recovery: ${JSON.stringify([
        ...view.control.sentFrames.slice(frameStart),
        ...view.output.sentFrames.slice(frameStart),
      ].filter(frame => String(frame.type).includes('checkpoint')))}`,
    );
    assert.equal(
      remainingProjectionMisses < 0,
      true,
      'recovery must remain pending until a quiet router projection becomes visible',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 stale hard-reload checkpoint settlement cannot roll back a live replacement view', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 stale hard reload settlement', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const staleView = await connectProductionView(router, 'split', 11, {
      autoAcknowledgeCheckpoint: 'any',
    });
    await promoteProductionViews(integration, [staleView]);

    staleView.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:capability'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>)
        .some(candidate => candidate.viewGeneration === 12);
    negotiateProductionView(staleView.control, 12);
    for (let attempt = 0; attempt < 30 && staleView.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(staleView.output.heldSendCallbackCount, 1);

    const replacement = await connectProductionView(router, 'split', 21);
    assert.notEqual(replacement.connectionId, staleView.connectionId);
    staleView.output.close();
    staleView.output.emit('close');
    staleView.control.close();
    staleView.control.emit('close');
    staleView.output.holdSendPredicate = null;
    staleView.output.releaseNextSend(new Error('stale-hard-reload-socket-closed'));

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'server',
      `stale settlement audit=${JSON.stringify(integration.getAuthorityAuditTrail(SESSION_ID).slice(-12))}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 replacement view supersedes a stale checkpoint-ready preparation before stale disconnect', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { checkpointReadyHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 replacement supersedes stale checkpoint preparation', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const staleView = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [staleView]);

    negotiateProductionView(staleView.control, 12);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (staleView.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      ))) break;
    }
    assert.equal(
      staleView.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
      )),
      true,
      'the pre-reload control connection must be awaiting a client-ready acknowledgement',
    );

    const replacement = await connectProductionView(router, 'split', 21);
    const replacementPreparationCapability = replacement.control.sentFrames.find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.checkpointDeliveryPreparation !== undefined
    ));
    assert.ok(
      replacementPreparationCapability,
      'a newly negotiated replacement must receive its own checkpoint-ready preparation before the stale control closes',
    );
    const replacementPreparation = replacementPreparationCapability.checkpointDeliveryPreparation as Record<string, unknown>;
    emitClientFrame(replacement.control, {
      type: 'terminal-checkpoint:ready',
      protocolVersion: 1,
      sessionId: SESSION_ID,
      viewGeneration: replacementPreparation.viewGeneration,
      authorityEpoch: replacementPreparation.authorityEpoch,
      streamEpoch: replacementPreparation.streamEpoch,
      driverLeaseGeneration: replacementPreparation.driverLeaseGeneration,
      acceptedViewAttributesGeneration: replacementPreparation.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: replacementPreparation.viewAttributesChallengeId,
      checkpointDeliveryId: replacementPreparation.checkpointDeliveryId,
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (replacement.output.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:commit' && frame.viewGeneration === 21
      ))) break;
    }
    assert.equal(
      replacement.output.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:commit' && frame.viewGeneration === 21
      )),
      true,
      'the replacement ready acknowledgement must admit a checkpoint without waiting for the stale control timeout',
    );
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 send failure waits for same-turn hard-reload topology settlement', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 callback-before-close hard reload', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const staleView = await connectProductionView(router, 'split', 11, {
      autoAcknowledgeCheckpoint: 'any',
    });
    await promoteProductionViews(integration, [staleView]);

    staleView.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:capability'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>)
        .some(candidate => candidate.viewGeneration === 12);
    negotiateProductionView(staleView.control, 12);
    for (let attempt = 0; attempt < 30 && staleView.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(staleView.output.heldSendCallbackCount, 1);

    const replacement = await connectProductionView(router, 'split', 21);
    assert.notEqual(replacement.connectionId, staleView.connectionId);
    staleView.output.holdSendPredicate = null;
    staleView.output.releaseNextSend(new Error('callback-before-close'));
    staleView.output.close();
    staleView.output.emit('close');
    staleView.control.close();
    staleView.control.emit('close');

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'server',
      `same-turn settlement audit=${JSON.stringify(integration.getAuthorityAuditTrail(SESSION_ID).slice(-16))}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 zero-view hard reload retains PTY output for the replacement checkpoint', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 zero-view hard reload', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const staleView = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [staleView]);

    staleView.output.close();
    staleView.output.emit('close');
    staleView.control.close();
    staleView.control.emit('close');
    fakePty.emitData('zero-view-retained-tail');
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    await session.headlessWriteChain;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'server',
      `zero-view output audit=${JSON.stringify(integration.getAuthorityAuditTrail(SESSION_ID).slice(-16))}`,
    );
    const retainedAudit = integration.getAuthorityAuditTrail(SESSION_ID).find(event => (
      event.type === 'server-output-retained-without-attached-view'
    ));
    assert.deepEqual({
      outputDataSha256: retainedAudit?.outputDataSha256,
      outputByteLength: retainedAudit?.outputByteLength,
    }, {
      outputDataSha256: undefined,
      outputByteLength: undefined,
    });

    const debugIsolation = await manager.beginTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      desiredMode: 'server',
      cleanupToken: 'zero-view-debug-cleanup',
      isolationLeaseId: 'zero-view-debug-isolation',
      transitionPolicy: 'fresh-isolated-epoch',
    });
    assert.equal(debugIsolation.accepted, true, JSON.stringify(debugIsolation));
    fakePty.emitData('debug-zero-view-retained-tail');
    await session.headlessWriteChain;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const debugRetainedAudit = integration.getAuthorityAuditTrail(SESSION_ID)
      .slice()
      .reverse()
      .find(event => event.type === 'server-output-retained-without-attached-view');
    assert.deepEqual({
      outputDataSha256: debugRetainedAudit?.outputDataSha256,
      outputByteLength: debugRetainedAudit?.outputByteLength,
    }, {
      outputDataSha256: createHash('sha256')
        .update('debug-zero-view-retained-tail', 'utf8')
        .digest('hex'),
      outputByteLength: Buffer.byteLength('debug-zero-view-retained-tail', 'utf8'),
    });

    const replacement = await connectProductionView(router, 'split', 21, {
      autoAcknowledgeCheckpoint: 'initial',
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (replacement.output.sentFrames.some(frame => frame.type === 'terminal-checkpoint:commit')) break;
    }
    const recovered = replacement.output.sentFrames
      .filter(frame => frame.type === 'terminal-checkpoint:chunk')
      .map(frame => Buffer.from(String(frame.data ?? ''), 'base64').toString('utf8'))
      .join('');
    assert.match(recovered, /zero-view-retained-tail/u);
    assert.deepEqual(
      await integration.beginRollback(SESSION_ID),
      { ok: true },
      'the replacement authority-ready view must become the compatibility rollback candidate',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 explicit rollback refreshes the authority-ready view after a zero-view reconnect', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 explicit rollback view refresh', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const original = await connectProductionView(router, 'split', 31);
    await promoteProductionViews(integration, [original]);

    original.output.close();
    original.output.emit('close');
    original.control.close();
    original.control.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(router.getTerminalAuthorityResponderViews(SESSION_ID).length, 0);
    assert.deepEqual(await integration.beginRollback(SESSION_ID), {
      ok: false,
      reason: 'compatibility-view-unavailable',
    });
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');

    const routerInternals = router as unknown as {
      terminalAuthorityTopologyObserver: ((change: unknown) => void) | null;
      terminalAuthorityViewReadyObserver: ((registration: unknown) => void) | null;
    };
    const topologyObserver = routerInternals.terminalAuthorityTopologyObserver;
    const viewReadyObserver = routerInternals.terminalAuthorityViewReadyObserver;
    routerInternals.terminalAuthorityTopologyObserver = null;
    routerInternals.terminalAuthorityViewReadyObserver = null;
    const replacement = await connectProductionView(router, 'split', 32);
    routerInternals.terminalAuthorityTopologyObserver = topologyObserver;
    routerInternals.terminalAuthorityViewReadyObserver = viewReadyObserver;

    assert.equal(router.getTerminalAuthorityResponderViews(SESSION_ID).length, 1);
    assert.deepEqual(
      await integration.beginRollback(SESSION_ID),
      { ok: true },
      'explicit rollback must select the current router view rather than an empty stale cache',
    );
    assert.equal(
      [...replacement.control.sentFrames, ...replacement.output.sentFrames]
        .some(frame => frame.type === 'terminal-authority:rollback-start'),
      true,
      `rollback refresh frames=${JSON.stringify(replacement.output.sentFrames)} audit=${JSON.stringify(integration.getAuthorityAuditTrail(SESSION_ID).slice(-16))}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 rollback cannot interleave or reactivate an in-flight hard-reload checkpoint', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 hard reload rollback fence', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11, {
      autoAcknowledgeCheckpoint: 'any',
    });
    await promoteProductionViews(integration, [view]);
    const frameStart = view.output.sentFrames.length;
    view.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:capability'
      && frame.authorityMode === 'checkpoint'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>)
        .some(candidate => candidate.viewGeneration === 12);
    negotiateProductionView(view.control, 12);
    for (let attempt = 0; attempt < 20 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);

    const rollback = Promise.resolve(integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: 12,
      },
    }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      view.output.sentFrames.slice(frameStart).some(frame => frame.type === 'terminal-authority:rollback-start'),
      false,
    );
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    assert.equal((await rollback).ok, true);

    const frames = view.output.sentFrames.slice(frameStart).filter(frame => frame.viewGeneration === 12);
    const authoritativeTypes = frames.filter(frame => (
      frame.mode === 'authoritative'
      && (frame.type === 'terminal-checkpoint:start'
        || frame.type === 'terminal-checkpoint:chunk'
        || frame.type === 'terminal-checkpoint:commit')
    )).map(frame => frame.type);
    assert.deepEqual(authoritativeTypes, [
      'terminal-checkpoint:start',
      'terminal-checkpoint:chunk',
      'terminal-checkpoint:commit',
    ]);
    const authoritativeCommitIndex = frames.findIndex(frame => (
      frame.type === 'terminal-checkpoint:commit' && frame.mode === 'authoritative'
    ));
    const rollbackStartObserved = view.output.sentFrames.slice(frameStart)
      .some(frame => frame.type === 'terminal-authority:rollback-start');
    assert.equal(authoritativeCommitIndex >= 0 && rollbackStartObserved, true);
    assert.notEqual(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 production rollback overflow coalesces one fresh compatibility recovery', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty, {
    promotionSafetyLimits: {
      ackDeadlineMs: 1_000,
      maxHeldOutputBytes: 5,
      maxHeldOutputChunks: 1,
    },
  });
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 production rollback overflow', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);
    const rollbackFrameStart = view.output.sentFrames.length;
    view.output.holdSendPredicate = frame => frame.type === 'terminal-authority:rollback-start';
    const staleRollback = Promise.resolve(integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: 11,
      },
    }));
    for (let attempt = 0; attempt < 20 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);

    fakePty.emitData('tail');
    fakePty.emitData('more');
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    await session.headlessWriteChain;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'authority-send-recovery-scheduled'
          && event.kind === 'compatibility-output-hold-overflow'
      ))) break;
    }
    const overflowState = integration.getAuthorityState(SESSION_ID);
    assert.equal(overflowState?.ptyPaused, false);
    assert.equal((overflowState?.pendingDeliveryChunks ?? Number.POSITIVE_INFINITY) <= 1, true);
    assert.equal((overflowState?.pendingDeliveryBytes ?? Number.POSITIVE_INFINITY) <= 5, true);
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
        event.type === 'authority-send-recovery-scheduled'
          && event.kind === 'compatibility-output-hold-overflow'
      )).length,
      1,
      'concurrent overflow callbacks must coalesce to one production recovery scheduler turn',
    );

    view.output.holdSendPredicate = null;
    let injectedReplacementFailures = 0;
    view.output.sendFailurePredicate = frame => (
      frame.type === 'terminal-authority:rollback-start'
        && injectedReplacementFailures++ < 1
    );
    let timerTurnObserved = false;
    setTimeout(() => {
      timerTurnObserved = true;
    }, 0);
    view.output.releaseNextSend();
    assert.equal((await staleRollback).ok, false);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      const frames = view.output.sentFrames.slice(rollbackFrameStart);
      if (frames.filter(frame => frame.type === 'terminal-authority:rollback-start').length >= 3
        && frames.some(frame => frame.type === 'terminal-checkpoint:commit')) break;
    }
    const recoveryFrames = view.output.sentFrames.slice(rollbackFrameStart);
    assert.equal(timerTurnObserved, true,
      'replacement failure retry must yield to timers instead of recursively retrying in microtasks');
    assert.equal(
      recoveryFrames.filter(frame => frame.type === 'terminal-authority:rollback-start').length,
      3,
      'a failed first replacement must automatically schedule one more rollback transaction',
    );
    assert.equal(recoveryFrames.some(frame => frame.type === 'terminal-checkpoint:commit'), true);
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 topology replacement during rollback does not reset the fresh parser again', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 rollback topology replacement', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    await promoteProductionViews(integration, [view]);

    assert.equal((await integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: 11,
      },
    })).ok, true);
    assert.equal(
      view.output.sentFrames.some(frame => (
        frame.type === 'terminal-authority:parser-reset' && frame.viewGeneration === 11
      )),
      true,
      'the original promoted view must be reset before compatibility recovery',
    );

    const routerInternals = router as unknown as {
      clients: Map<string, { connectionId?: string; clientId: string }>;
      terminalAuthorityTopologyObserver: ((change: {
        sessionId: string;
        kind: 'new-view';
        connectionId: string;
        viewGeneration: number;
      }) => void) | null;
    };
    const controlMeta = [...routerInternals.clients.values()].find(meta => (
      meta.connectionId === view.connectionId
    ));
    assert.ok(controlMeta);
    const clientIdentityRecoveryStart = view.output.sentFrames.length;
    controlMeta.clientId = `${controlMeta.clientId}-rebound`;
    routerInternals.terminalAuthorityTopologyObserver?.({
      sessionId: SESSION_ID,
      kind: 'new-view',
      connectionId: view.connectionId,
      viewGeneration: 11,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (view.output.sentFrames.slice(clientIdentityRecoveryStart).some(frame => (
        frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 11
      ))) break;
    }
    assert.equal(view.output.sentFrames.slice(clientIdentityRecoveryStart).some(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 11
    )), true, 'same-key client identity replacement must invalidate the frozen responder topology');

    const replacementStart = view.output.sentFrames.length;
    negotiateProductionView(view.control, 12);
    await new Promise<void>(resolve => setTimeout(resolve, 15));
    negotiateProductionView(view.control, 13);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (view.output.sentFrames.slice(replacementStart).some(frame => (
        frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 13
      ))) break;
    }
    const replacementFrames = view.output.sentFrames.slice(replacementStart);
    assert.equal(
      replacementFrames.some(frame => (
        frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 13
      )),
      true,
      'the replacement view must receive one fresh compatibility checkpoint boundary',
    );
    assert.equal(
      replacementFrames.some(frame => (
        frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 12
      )),
      false,
      'a superseded intermediate topology must not start an overlapping rollback checkpoint',
    );
    assert.equal(
      replacementFrames.some(frame => (
        frame.type === 'terminal-authority:parser-reset'
          && (frame.viewGeneration === 12 || frame.viewGeneration === 13)
      )),
      false,
      'a fresh replacement parser must not be invalidated by the recovery it was created to acknowledge',
    );

    const rollbackStart = [...replacementFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 13
    ));
    const checkpointStart = [...replacementFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === 13
    ));
    const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID);
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    assert.ok(retained);
    view.control.holdSendPredicate = frame => frame.type === 'terminal-authority:legacy-responder-enabled';
    const checkpointIdentity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      viewGeneration: 13,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: retained.oldestRetainedSeq,
      retentionPolicyId: retained.retentionPolicy.retentionPolicyId,
      connectionId: view.connectionId,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...checkpointIdentity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...checkpointIdentity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 13,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    for (let attempt = 0; attempt < 20 && view.control.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.control.heldSendCallbackCount, 1, 'the old-generation final legacy enable must be physically pending');
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');

    const atomicReplacementStart = view.output.sentFrames.length;
    negotiateProductionView(view.control, 14);
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'rolling-back',
      'topology replacement must synchronously invalidate the old final commit',
    );
    view.control.holdSendPredicate = null;
    view.control.releaseNextSend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.notEqual(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'legacy',
      'settling the old-generation enable after replacement must not commit legacy authority',
    );
    assert.equal(integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
      event.type === 'legacy-responder-identity-committed'
    )), false, 'an invalidated legacy enable settlement must not mutate adapter responder identity');

    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (view.output.sentFrames.slice(atomicReplacementStart).some(frame => (
        frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 14
      ))) break;
    }
    const atomicReplacementFrames = view.output.sentFrames.slice(atomicReplacementStart);
    const replacementRollbackStart = [...atomicReplacementFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 14
    ));
    const replacementCheckpointStart = [...atomicReplacementFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === 14
    ));
    assert.ok(replacementRollbackStart, 'the new generation must receive a fresh rollback boundary');
    assert.ok(replacementCheckpointStart, 'the new generation must receive a fresh compatibility checkpoint');
    assert.equal(atomicReplacementFrames.some(frame => (
      frame.type === 'terminal-authority:parser-reset' && frame.viewGeneration === 14
    )), false, 'the new-generation parser must not be reset by its own fresh recovery');

    const replacementIdentity = {
      protocolVersion: replacementCheckpointStart.protocolVersion,
      sessionId: SESSION_ID,
      viewGeneration: 14,
      streamEpoch: replacementCheckpointStart.streamEpoch,
      checkpointEpoch: replacementCheckpointStart.checkpointEpoch,
      sourceSeq: replacementCheckpointStart.sourceSeq,
      snapshotSeq: replacementCheckpointStart.snapshotSeq,
      oldestRetainedSeq: replacementCheckpointStart.oldestRetainedSeq,
      retentionPolicyId: replacementCheckpointStart.retentionPolicyId,
      connectionId: view.connectionId,
      transitionEpoch: replacementRollbackStart.transitionEpoch,
      authorityEpoch: replacementRollbackStart.authorityEpoch,
      responderLeaseId: replacementRollbackStart.responderLeaseId,
      boundarySourceSeq: replacementRollbackStart.boundarySourceSeq,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...replacementIdentity,
      appliedThroughSeq: replacementCheckpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...replacementIdentity,
      drainedThroughSeq: replacementCheckpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 14,
      transitionEpoch: replacementRollbackStart.transitionEpoch,
      authorityEpoch: replacementRollbackStart.authorityEpoch,
      streamEpoch: replacementCheckpointStart.streamEpoch,
      responderLeaseId: replacementRollbackStart.responderLeaseId,
      boundarySourceSeq: replacementRollbackStart.boundarySourceSeq,
      checkpointEpoch: replacementCheckpointStart.checkpointEpoch,
      drainedThroughSourceSeq: replacementCheckpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'legacy',
      'the latest replacement view must be able to complete compatibility lease rebind',
    );
    assert.deepEqual(integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
      event.type === 'legacy-responder-identity-committed'
    )).map(event => [event.connectionId, event.viewGeneration]), [
      [view.connectionId, 14],
    ], 'only the current committed controller transaction may install adapter legacy identity');

    const legacyRebindStart = view.control.sentFrames.length;
    negotiateProductionView(view.control, 15);
    await new Promise<void>(resolve => setImmediate(resolve));
    const legacyRouterInternals = router as unknown as {
      terminalAuthorityTopologyObserver: ((change: {
        sessionId: string;
        kind: 'generation-changed';
        connectionId: string;
        viewGeneration: number;
      }) => void) | null;
    };
    legacyRouterInternals.terminalAuthorityTopologyObserver?.({
      sessionId: SESSION_ID,
      kind: 'generation-changed',
      connectionId: view.connectionId,
      viewGeneration: 15,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      view.control.sentFrames.slice(legacyRebindStart).filter(frame => (
        frame.type === 'terminal-authority:legacy-responder-enabled'
        && frame.viewGeneration === 15
      )).length,
      1,
      'a settled legacy topology rebind must commit the new identity and suppress duplicate re-enable feedback',
    );

    const concurrentLegacyRebindStart = view.control.sentFrames.length;
    view.control.holdSendPredicate = frame => frame.type === 'terminal-authority:legacy-responder-enabled';
    negotiateProductionView(view.control, 16);
    legacyRouterInternals.terminalAuthorityTopologyObserver?.({
      sessionId: SESSION_ID,
      kind: 'generation-changed',
      connectionId: view.connectionId,
      viewGeneration: 16,
    });
    legacyRouterInternals.terminalAuthorityTopologyObserver?.({
      sessionId: SESSION_ID,
      kind: 'generation-changed',
      connectionId: view.connectionId,
      viewGeneration: 16,
    });
    for (let attempt = 0; attempt < 20 && Number(view.control.heldSendCallbackCount) === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      view.control.heldSendCallbackCount,
      1,
      'an in-flight legacy topology rebind must coalesce duplicate topology notifications',
    );
    view.control.holdSendPredicate = null;
    view.control.releaseNextSend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      view.control.sentFrames.slice(concurrentLegacyRebindStart).filter(frame => (
        frame.type === 'terminal-authority:legacy-responder-enabled'
        && frame.viewGeneration === 16
      )).length,
      1,
      'one physical legacy enable must settle the coalesced topology identity',
    );

    const readyOnlyLegacyRebindStart = view.control.sentFrames.length;
    const readyOnlyRouterInternals = router as unknown as {
      terminalAuthorityTopologyObserver: typeof legacyRouterInternals.terminalAuthorityTopologyObserver;
      terminalAuthorityViewReadyObserver: ((registration: {
        sessionId: string;
        connectionId: string;
        viewGeneration: number;
        authorityStreamEpoch: string;
        driverLeaseGeneration: string;
        acceptedViewAttributesGeneration: string;
        queryReplyCapability: 'terminal.query-reply-input.v1';
        parserResponderCapability: 'terminal.parser-responder-disable.v1';
        reason: 'generation-changed';
      }) => void) | null;
    };
    const topologyObserver = readyOnlyRouterInternals.terminalAuthorityTopologyObserver;
    readyOnlyRouterInternals.terminalAuthorityTopologyObserver = null;
    const readyOnlyRegistration = negotiateProductionView(view.control, 17);
    readyOnlyRouterInternals.terminalAuthorityTopologyObserver = topologyObserver;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      view.control.sentFrames.slice(readyOnlyLegacyRebindStart).filter(frame => (
        frame.type === 'terminal-authority:legacy-responder-enabled'
        && frame.viewGeneration === 17
      )).length,
      1,
      'a view that becomes authority-ready after rollback must still rebind the legacy responder',
    );
    const readyOnlyNotification = {
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 17,
      authorityStreamEpoch: String(readyOnlyRegistration.authorityStreamEpoch),
      driverLeaseGeneration: String(readyOnlyRegistration.driverLeaseGeneration),
      acceptedViewAttributesGeneration: String(
        readyOnlyRegistration.acceptedViewAttributesGeneration,
      ),
      queryReplyCapability: 'terminal.query-reply-input.v1' as const,
      parserResponderCapability: 'terminal.parser-responder-disable.v1' as const,
      reason: 'generation-changed' as const,
    };
    const leaseGenerationBeforeDuplicateReady = manager
      .getTerminalAuthorityRuntimePortState(SESSION_ID)?.suspendedBrowserDriver?.leaseGeneration;
    readyOnlyRouterInternals.terminalAuthorityViewReadyObserver?.(readyOnlyNotification);
    readyOnlyRouterInternals.terminalAuthorityViewReadyObserver?.(readyOnlyNotification);
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      negotiateProductionView(view.control, 17);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      manager.getTerminalAuthorityRuntimePortState(SESSION_ID)
        ?.suspendedBrowserDriver?.leaseGeneration,
      leaseGenerationBeforeDuplicateReady,
      'duplicate topology/ready notifications must not mutate the current legacy mutation lease',
    );
    const readyOnlyLeaseGenerations = new Set(
      view.control.sentFrames
        .filter(frame => frame.type === 'terminal-checkpoint:capability')
        .flatMap(frame => Array.isArray(frame.mutationLeases)
          ? frame.mutationLeases as Array<Record<string, unknown>>
          : [])
        .filter(lease => lease.sessionId === SESSION_ID && lease.viewGeneration === 17)
        .map(lease => lease.leaseGeneration),
    );
    assert.equal(
      readyOnlyLeaseGenerations.size,
      1,
      'duplicate topology/ready notifications must not rotate the same legacy mutation lease',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 zero-view rollback recovery wakes when a replacement view becomes authority-ready', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 zero-view rollback recovery wake', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const original = await connectProductionView(router, 'split', 91);
    await promoteProductionViews(integration, [original]);

    original.output.holdSendPredicate = frame => frame.type === 'terminal-authority:rollback-start';
    const staleRollback = Promise.resolve(integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: original.connectionId,
        viewGeneration: original.viewGeneration,
      },
    }));
    for (let attempt = 0; attempt < 40 && original.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(original.output.heldSendCallbackCount, 1, 'rollback-start must be physically pending');
    assert.equal(
      original.output.sentFrames.filter(frame => frame.type === 'terminal-authority:parser-reset').length,
      1,
      'the promoted parser is reset exactly once before the first rollback transaction',
    );

    emitClientFrame(original.control, { type: 'unsubscribe', sessionIds: [SESSION_ID] });
    original.output.close();
    original.output.emit('close');
    original.control.close();
    original.control.emit('close');
    original.output.holdSendPredicate = null;
    original.output.releaseNextSend();
    assert.deepEqual(await staleRollback, {
      ok: false,
      reason: 'rollback-transaction-invalidated',
    });
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    assert.equal(router.getTerminalAuthorityResponderViews(SESSION_ID).length, 0);
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');

    const routerInternals = router as unknown as {
      terminalAuthorityTopologyObserver: ((change: {
        sessionId: string;
        kind: 'new-view';
        connectionId: string;
        viewGeneration: number;
      }) => void) | null;
    };
    const topologyObserver = routerInternals.terminalAuthorityTopologyObserver;
    assert.ok(topologyObserver);
    routerInternals.terminalAuthorityTopologyObserver = null;
    const replacement = await connectProductionView(router, 'split', 92);
    routerInternals.terminalAuthorityTopologyObserver = topologyObserver;
    let recoveryStartedWhileDuplicateWakeStreamActive = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      topologyObserver({
        sessionId: SESSION_ID,
        kind: 'new-view',
        connectionId: replacement.connectionId,
        viewGeneration: replacement.viewGeneration,
      });
      negotiateProductionView(replacement.control, replacement.viewGeneration);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (replacement.output.sentFrames.some(frame => (
        frame.type === 'terminal-authority:rollback-start'
          && frame.viewGeneration === replacement.viewGeneration
      ))) {
        recoveryStartedWhileDuplicateWakeStreamActive = true;
      }
    }
    assert.equal(
      recoveryStartedWhileDuplicateWakeStreamActive,
      true,
      'a bounded leading-edge recovery turn must run before a >50ms duplicate topology/ready wake stream ends',
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (replacement.output.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:commit'
          && frame.mode === 'compatibility'
          && frame.viewGeneration === replacement.viewGeneration
      ))) break;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    const replacementFrames = replacement.output.sentFrames;
    const rollbackStarts = replacementFrames.filter(frame => (
      frame.type === 'terminal-authority:rollback-start'
        && frame.viewGeneration === replacement.viewGeneration
    ));
    const checkpointStarts = replacementFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === replacement.viewGeneration
    ));
    const checkpointCommits = replacementFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:commit'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === replacement.viewGeneration
    ));
    assert.equal(rollbackStarts.length, 1, 'the replacement receives exactly one fresh rollback boundary');
    assert.equal(checkpointStarts.length, 1, 'the replacement receives exactly one fresh checkpoint start');
    assert.equal(checkpointCommits.length, 1, 'the replacement receives exactly one fresh checkpoint commit');
    assert.equal(
      replacementFrames.some(frame => frame.type === 'terminal-authority:parser-reset'),
      false,
      'the fresh replacement parser cannot be reset by its own recovery',
    );

    const rollbackStart = rollbackStarts[0];
    const checkpointStart = checkpointStarts[0];
    const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID);
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    assert.ok(retained);
    const checkpointIdentity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      connectionId: replacement.connectionId,
      viewGeneration: replacement.viewGeneration,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: retained.oldestRetainedSeq,
      retentionPolicyId: retained.retentionPolicy.retentionPolicyId,
    };
    emitClientFrame(replacement.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...checkpointIdentity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(replacement.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...checkpointIdentity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(replacement.control, {
      type: 'terminal-authority:compatibility-drained',
      ...checkpointIdentity,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    for (let attempt = 0; attempt < 20
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'legacy'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const finalState = integration.getAuthorityState(SESSION_ID);
    assert.equal(finalState?.mode, 'legacy');
    assert.equal(finalState?.ptyPaused, false);
    assert.equal(finalState?.sessionStatus, 'idle');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 rollback lease renewal on the same responder identity does not restart recovery', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    fakePty,
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 rollback lease renewal identity', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 79);
    const follower = await connectProductionView(router, 'split', 80);
    await promoteProductionViews(integration, [view, follower]);

    view.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:output';
    fakePty.emitData('pre-rollback-held-output');
    for (let attempt = 0; attempt < 40 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(
      view.output.heldSendCallbackCount,
      1,
      'the fixture must hold one earlier controller terminal delivery before rollback-start dequeue',
    );
    const frameStart = view.output.sentFrames.length;
    const followerFrameStart = follower.output.sentFrames.length;
    const rollback = integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
      },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const pendingRollbackState = integration.getAuthorityState(SESSION_ID);
    assert.equal(pendingRollbackState?.mode, 'rolling-back');
    const pendingRollbackEpoch = String(pendingRollbackState?.streamEpoch);

    const routerInternals = router as unknown as {
      clients: Map<unknown, {
        connectionId?: string;
        terminalAuthorityViewRegistrations?: Map<string, {
          authorityStreamEpoch: string;
          driverLeaseGeneration: string;
          acceptedViewAttributesGeneration: string;
        }>;
      }>;
      terminalAuthorityTopologyObserver: ((change: {
        sessionId: string;
        kind: 'generation-changed';
        connectionId: string;
        viewGeneration: number;
      }) => void) | null;
    };
    for (const currentView of [view, follower]) {
      const controlMeta = [...routerInternals.clients.values()].find(meta => (
        meta.connectionId === currentView.connectionId && meta.terminalAuthorityViewRegistrations
      ));
      const registration = controlMeta?.terminalAuthorityViewRegistrations?.get(SESSION_ID);
      assert.ok(registration);
      assert.notEqual(
        registration.driverLeaseGeneration,
        pendingRollbackEpoch,
        'the fixture must begin with the pre-rollback router lease generation',
      );
      registration.authorityStreamEpoch = pendingRollbackEpoch;
      registration.driverLeaseGeneration = pendingRollbackEpoch;
      registration.acceptedViewAttributesGeneration = pendingRollbackEpoch;
      routerInternals.terminalAuthorityTopologyObserver?.({
        sessionId: SESSION_ID,
        kind: 'generation-changed',
        connectionId: currentView.connectionId,
        viewGeneration: currentView.viewGeneration,
      });
    }
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    assert.equal(
      (await rollback).ok,
      true,
      'same-identity epoch projection before rollback-start dequeue cannot invalidate the transaction',
    );
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    const rollbackStarts = view.output.sentFrames.slice(frameStart).filter(frame => (
      frame.type === 'terminal-authority:rollback-start'
    ));
    assert.equal(
      rollbackStarts.length,
      1,
      'the rollback-issued lease generation must be projected before the same view renegotiates it',
    );
    const firstRollback = rollbackStarts[0];
    assert.ok(firstRollback);
    assert.equal(
      rollbackStarts[0]?.transitionEpoch,
      pendingRollbackEpoch,
      'same-identity lease renewal cannot rotate the compatibility recovery epoch',
    );
    const followerRollbackStarts = follower.output.sentFrames.slice(followerFrameStart).filter(frame => (
      frame.type === 'terminal-authority:rollback-start'
    ));
    assert.equal(followerRollbackStarts.length, 1);
    assert.equal(integration.getAuthorityState(SESSION_ID)?.frozenRequiredResponderCount, 2);

    const acknowledgeCompatibility = (currentView: ProductionConnectedView): void => {
      const rollbackStart = [...currentView.output.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-authority:rollback-start'
          && frame.transitionEpoch === pendingRollbackEpoch
      ));
      const checkpointStart = [...currentView.output.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-checkpoint:start'
          && frame.mode === 'compatibility'
          && frame.transitionEpoch === pendingRollbackEpoch
      ));
      assert.ok(rollbackStart);
      assert.ok(checkpointStart);
      const checkpointIdentity = {
        protocolVersion: checkpointStart.protocolVersion,
        sessionId: SESSION_ID,
        connectionId: currentView.connectionId,
        viewGeneration: currentView.viewGeneration,
        transitionEpoch: rollbackStart.transitionEpoch,
        authorityEpoch: rollbackStart.authorityEpoch,
        streamEpoch: checkpointStart.streamEpoch,
        checkpointEpoch: checkpointStart.checkpointEpoch,
        responderLeaseId: rollbackStart.responderLeaseId,
        boundarySourceSeq: rollbackStart.boundarySourceSeq,
        sourceSeq: checkpointStart.sourceSeq,
        snapshotSeq: checkpointStart.snapshotSeq,
        oldestRetainedSeq: checkpointStart.oldestRetainedSeq,
        retentionPolicyId: checkpointStart.retentionPolicyId,
      };
      emitClientFrame(currentView.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...checkpointIdentity,
        appliedThroughSeq: checkpointStart.snapshotSeq,
      });
      emitClientFrame(currentView.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...checkpointIdentity,
        drainedThroughSeq: checkpointStart.sourceSeq,
      });
      emitClientFrame(currentView.control, {
        type: 'terminal-authority:compatibility-drained',
        ...checkpointIdentity,
        drainedThroughSourceSeq: checkpointStart.sourceSeq,
        checkpointApplied: true,
        postSnapshotTailDrained: true,
      });
    };
    acknowledgeCompatibility(view);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'rolling-back',
      'one accepted drain cannot collapse the two-view compatibility quorum',
    );
    acknowledgeCompatibility(follower);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 rollback topology rejects a projected generation outside the active stream epoch', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 rollback wrong projected generation', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 81);
    await promoteProductionViews(integration, [view]);
    view.output.holdSendPredicate = frame => frame.type === 'terminal-checkpoint:output';
    fakePty.emitData('pre-rollback-wrong-generation');
    for (let attempt = 0; attempt < 40 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);

    const frameStart = view.output.sentFrames.length;
    const rollback = integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
      },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const activeEpoch = String(integration.getAuthorityState(SESSION_ID)?.streamEpoch);
    const wrongProjectedEpoch = (BigInt(activeEpoch) + 1n).toString();
    const routerInternals = router as unknown as {
      terminalAuthorityStreamEpochReader: ((sessionId: string) => string | null) | null;
      terminalAuthorityTopologyObserver: ((change: {
        sessionId: string;
        kind: 'generation-changed';
        connectionId: string;
        viewGeneration: number;
      }) => void) | null;
    };
    routerInternals.terminalAuthorityStreamEpochReader = () => wrongProjectedEpoch;
    routerInternals.terminalAuthorityTopologyObserver?.({
      sessionId: SESSION_ID,
      kind: 'generation-changed',
      connectionId: view.connectionId,
      viewGeneration: view.viewGeneration,
    });
    view.output.holdSendPredicate = null;
    view.output.releaseNextSend();
    assert.equal(
      (await rollback).ok,
      false,
      'a non-active projected generation must invalidate the pending rollback transaction',
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (view.output.sentFrames.slice(frameStart).some(frame => (
        frame.type === 'terminal-authority:rollback-start'
      ))) break;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    const recovery = view.output.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-authority:rollback-start'
    ));
    assert.ok(recovery);
    assert.notEqual(recovery.transitionEpoch, activeEpoch);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 legacy driver ownership transfers to the remaining capable view after disconnect', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'unified', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 legacy driver takeover', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const owner = await connectProductionView(router, 'unified', 31);
    const follower = await connectProductionView(router, 'unified', 32);
    const frameStart = follower.control.sentFrames.length;

    owner.control.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));

    const takeover = follower.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.authorityMode === 'legacy'
      && Array.isArray(frame.mutationLeases)
      && (frame.mutationLeases as Array<Record<string, unknown>>).some(lease => (
        lease.sessionId === SESSION_ID && lease.viewGeneration === 32
      ))
    ));
    assert.ok(takeover, 'the remaining legacy view never received the released browser driver lease');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 legacy capability refresh follows the suspended browser driver instead of view order', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'unified', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 legacy driver selection', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const first = await connectProductionView(router, 'unified', 31);
    const owner = await connectProductionView(router, 'unified', 32);
    const views = router.getTerminalAuthorityResponderViews(SESSION_ID);
    const firstRegistration = views.find(view => view.connectionId === first.connectionId);
    const ownerRegistration = views.find(view => view.connectionId === owner.connectionId);
    assert.ok(firstRegistration);
    assert.ok(ownerRegistration);

    manager.unregisterRetainedTerminalClientView(
      SESSION_ID,
      firstRegistration.clientId,
      firstRegistration.viewGeneration,
    );
    const claimed = manager.establishRetainedTerminalMutationLease(
      SESSION_ID,
      ownerRegistration.clientId,
      ownerRegistration.viewGeneration,
    );
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    assert.equal(
      manager.registerRetainedTerminalClientView(
        SESSION_ID,
        firstRegistration.clientId,
        firstRegistration.viewGeneration,
      ).ok,
      true,
    );

    const ownerFrameStart = owner.control.sentFrames.length;
    const routerInternals = router as unknown as {
      terminalAuthorityTopologyObserver: ((change: {
        sessionId: string;
        kind: 'generation-changed';
        connectionId: string;
        viewGeneration: number;
      }) => void) | null;
    };
    routerInternals.terminalAuthorityTopologyObserver?.({
      sessionId: SESSION_ID,
      kind: 'generation-changed',
      connectionId: owner.connectionId,
      viewGeneration: owner.viewGeneration,
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    const refreshedOwnerCapability = owner.control.sentFrames.slice(ownerFrameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.authorityMode === 'legacy'
      && Array.isArray(frame.mutationLeases)
      && (frame.mutationLeases as Array<Record<string, unknown>>).some(lease => (
        lease.sessionId === SESSION_ID && lease.viewGeneration === owner.viewGeneration
      ))
    ));
    assert.ok(
      refreshedOwnerCapability,
      'legacy capability refresh must target the suspended browser driver even when another view is listed first',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 explicit legacy capability refresh waits for a transient empty responder topology', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 explicit refresh rebind settlement', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 33);
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [],
    });
    assert.equal(router.getTerminalAuthorityResponderViews(SESSION_ID).length, 0);
    const frameStart = view.control.sentFrames.length;
    const replacementReady = new Promise<void>(resolve => {
      setImmediate(() => {
        negotiateProductionView(view.control, 34);
        resolve();
      });
    });
    const refreshResult = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await replacementReady;
    await acceptPendingProductionViewAttributes(view.control, frameStart, 34, refreshResult);
    const refreshedCapability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.authorityMode === 'legacy'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
        registration.sessionId === SESSION_ID && registration.viewGeneration === 34
      ))
    ));
    assert.ok(refreshedCapability, 'the settled refresh omitted its current legacy capability');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 pending view-attributes handshake stays pending without a reply then fails at its deadline', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 pending attributes deadline', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 71);
    let settled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      settled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'capability enqueue is not view-attributes acceptance');
    assert.equal(await refresh, false, 'a browser that never replies must fail at the handshake deadline');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 stale driver attributes rotate once and only the fresh exact identity settles true', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 stale exact identity', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 72);
    const frameStart = view.control.sentFrames.length;
    let refreshSettled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      refreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      refreshSettled,
      false,
      'the replacement capability must not reuse the same-view runtime old acceptance',
    );
    const firstCapability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(firstCapability);
    const firstRegistration = (firstCapability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(firstRegistration);
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 72,
      driverLeaseGeneration: 'stale-driver-generation',
      viewAttributesGeneration: firstRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: firstRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const staleReceipt = [...view.control.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(staleReceipt?.accepted, false);
    assert.equal(staleReceipt?.reason, 'view-attributes-driver-generation-mismatch');

    let freshRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !freshRegistration; attempt += 1) {
      const capabilities = view.control.sentFrames.slice(frameStart).filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
      ));
      const candidate = capabilities.length > 1
        ? (capabilities.at(-1)?.registeredViews as Array<Record<string, unknown>> | undefined)?.[0]
        : undefined;
      if (candidate?.viewAttributesChallengeId !== firstRegistration.viewAttributesChallengeId) {
        freshRegistration = candidate;
      }
      if (!freshRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(freshRegistration, 'stale exact identity must cause one fresh current-topology challenge');
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 72,
      driverLeaseGeneration: freshRegistration.driverLeaseGeneration,
      viewAttributesGeneration: freshRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: freshRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true);
    const emittedCapabilities = view.control.sentFrames.slice(frameStart).filter(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.equal(
      emittedCapabilities.length,
      2,
      `one stale response may produce one replacement challenge, not a retry queue: ${JSON.stringify(
        emittedCapabilities.map(frame => (frame.registeredViews as Array<Record<string, unknown>>)?.[0]),
      )}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 pending handshake does not amplify a capability into a blind retry queue', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 90 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 no blind capability queue', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 73);
    const frameStart = view.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setTimeout(resolve, 70));
    assert.equal(
      view.control.sentFrames.slice(frameStart).filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
      )).length,
      1,
      'time alone must not re-enqueue the same capability',
    );
    assert.equal(await refresh, false);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 follower response is reject-only and cannot rotate the owner handshake', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 follower challenge isolation', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const first = await connectProductionView(router, 'unified', 81);
    const second = await connectProductionView(router, 'unified', 82);
    const starts = new Map([
      [first, first.control.sentFrames.length],
      [second, second.control.sentFrames.length],
    ]);
    let settled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      settled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const owner = [first, second].find(candidate => candidate.control.sentFrames
      .slice(starts.get(candidate)!)
      .some(frame => frame.type === 'terminal-checkpoint:capability'));
    assert.ok(owner, 'one exact driver owner must receive the explicit capability');
    const follower = owner === first ? second : first;
    const ownerStart = starts.get(owner)!;
    const ownerCapability = owner.control.sentFrames.slice(ownerStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(ownerCapability);
    const ownerRegistration = (ownerCapability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(ownerRegistration);
    const followerRegistration = follower.negotiatedRegistration;
    const followerReceiptStart = follower.control.sentFrames.length;
    emitClientFrame(follower.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: follower.viewGeneration,
      driverLeaseGeneration: followerRegistration.driverLeaseGeneration,
      viewAttributesGeneration: followerRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: ownerRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const followerReceipt = follower.control.sentFrames.slice(followerReceiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(followerReceipt?.accepted, false);
    assert.equal(followerReceipt?.reason, 'view-attributes-pending-owner-mismatch');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'a follower cannot settle the owner handshake');
    assert.equal(
      owner.control.sentFrames.slice(ownerStart).filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
      )).length,
      1,
      'a follower response cannot rotate or amplify the owner challenge',
    );
    emitClientFrame(owner.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: owner.viewGeneration,
      driverLeaseGeneration: ownerRegistration.driverLeaseGeneration,
      viewAttributesGeneration: ownerRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: ownerRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 refresh resolves only after manager acceptance and accepted ACK settlement', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 ACK settlement gate', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 74);
    const attempt = async (settlementError?: Error): Promise<boolean> => {
      const frameStart = view.control.sentFrames.length;
      let settled = false;
      const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
        settled = true;
        return result;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      const capability = view.control.sentFrames.slice(frameStart).find(frame => (
        frame.type === 'terminal-checkpoint:capability'
      ));
      assert.ok(capability);
      const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
      assert.ok(registration);
      view.control.holdSendPredicate = frame => frame.type === 'terminal-authority:view-attributes-accepted';
      emitClientFrame(view.control, {
        type: 'terminal-authority:view-attributes',
        sessionId: SESSION_ID,
        viewGeneration: 74,
        driverLeaseGeneration: registration.driverLeaseGeneration,
        viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
        viewAttributesChallengeId: registration.viewAttributesChallengeId,
        attributes: PRODUCTION_VIEW_ATTRIBUTES,
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'manager acceptance alone cannot outrun the accepted ACK callback');
      assert.equal(view.control.heldSendCallbackCount, 1);
      view.control.holdSendPredicate = null;
      view.control.releaseNextSend(settlementError);
      return refresh;
    };

    assert.equal(await attempt(new Error('accepted-ack-send-failed')), false);
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'manager cache must not become readiness when the accepted ACK settlement fails',
    );
    assert.equal(await attempt(), true);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 accepted ACK retries one fresh owner when manager identity changes before settlement', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 ACK owner rotation fence', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const owner = await connectProductionView(router, 'unified', 84);
    const successor = await connectProductionView(router, 'unified', 85);
    const ownerView = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === owner.connectionId
    ));
    const successorView = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === successor.connectionId
    ));
    assert.ok(ownerView);
    assert.ok(successorView);

    const ownerFrameStart = owner.control.sentFrames.length;
    const successorFrameStart = successor.control.sentFrames.length;
    let refreshSettled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      refreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const ownerCapability = owner.control.sentFrames.slice(ownerFrameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(ownerCapability);
    const ownerRegistration = (ownerCapability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(ownerRegistration);

    owner.control.holdSendPredicate = frame => frame.type === 'terminal-authority:view-attributes-accepted';
    emitClientFrame(owner.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: owner.viewGeneration,
      driverLeaseGeneration: ownerRegistration.driverLeaseGeneration,
      viewAttributesGeneration: ownerRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: ownerRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(owner.control.heldSendCallbackCount, 1);

    manager.unregisterRetainedTerminalClientView(
      SESSION_ID,
      ownerView.clientId,
      ownerView.viewGeneration,
    );
    const successorLease = manager.establishRetainedTerminalMutationLease(
      SESSION_ID,
      successorView.clientId,
      successorView.viewGeneration,
    );
    assert.equal(successorLease.ok, true, JSON.stringify(successorLease));

    owner.control.holdSendPredicate = null;
    owner.control.releaseNextSend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      refreshSettled,
      false,
      'an ACK for the previous manager owner cannot settle the explicit refresh true',
    );
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'the previous owner cache cannot become current readiness after lease transfer',
    );

    let successorRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !successorRegistration; attempt += 1) {
      successorRegistration = successor.control.sentFrames.slice(successorFrameStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
      )).find(candidate => (
        candidate.sessionId === SESSION_ID
        && candidate.viewGeneration === successor.viewGeneration
        && candidate.viewAttributesChallengeId !== ownerRegistration.viewAttributesChallengeId
      ));
      if (!successorRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(successorRegistration, 'ACK settlement did not issue one fresh current-owner challenge');
    emitClientFrame(successor.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: successor.viewGeneration,
      driverLeaseGeneration: successorRegistration.driverLeaseGeneration,
      viewAttributesGeneration: successorRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: successorRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true);
    assert.deepEqual(integration.getQueryResponderCapabilityState(SESSION_ID), {
      promotionEligible: true,
      hasAcceptedViewAttributes: true,
    });
    const freshCapabilities = successor.control.sentFrames.slice(successorFrameStart).filter(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>).some(candidate => (
        candidate.sessionId === SESSION_ID && candidate.viewGeneration === successor.viewGeneration
      ))
    ));
    assert.equal(freshCapabilities.length, 1, 'identity churn may issue one event-driven retry only');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 generation retarget does not consume the later manager-identity recovery', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 500 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 combined view and manager identity churn', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const first = await connectProductionView(router, 'unified', 184);
    const second = await connectProductionView(router, 'unified', 185);
    const starts = new Map([
      [first, first.control.sentFrames.length],
      [second, second.control.sentFrames.length],
    ]);
    let refreshSettled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      refreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const owner = [first, second].find(candidate => candidate.control.sentFrames
      .slice(starts.get(candidate)!)
      .some(frame => frame.type === 'terminal-checkpoint:capability'));
    assert.ok(owner);
    const successor = owner === first ? second : first;
    const ownerStart = starts.get(owner)!;
    const successorStart = starts.get(successor)!;
    const initialCapability = owner.control.sentFrames.slice(ownerStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(initialCapability);
    const initialRegistration = (
      initialCapability.registeredViews as Array<Record<string, unknown>>
    )[0];
    assert.ok(initialRegistration);

    const retargetGeneration = 186;
    negotiateProductionView(owner.control, retargetGeneration);
    let retargetRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !retargetRegistration; attempt += 1) {
      retargetRegistration = owner.control.sentFrames.slice(ownerStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
      )).find(candidate => (
        candidate.sessionId === SESSION_ID
        && candidate.viewGeneration === retargetGeneration
        && candidate.viewAttributesChallengeId !== initialRegistration.viewAttributesChallengeId
      ));
      if (!retargetRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(retargetRegistration, 'same-owner generation retarget did not issue its bounded replacement');

    owner.control.holdSendPredicate = frame => frame.type === 'terminal-authority:view-attributes-accepted';
    emitClientFrame(owner.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: retargetGeneration,
      driverLeaseGeneration: retargetRegistration.driverLeaseGeneration,
      viewAttributesGeneration: retargetRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: retargetRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(owner.control.heldSendCallbackCount, 1);

    const currentOwnerView = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === owner.connectionId
      && candidate.viewGeneration === retargetGeneration
    ));
    const successorView = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === successor.connectionId
    ));
    assert.ok(currentOwnerView);
    assert.ok(successorView);
    manager.unregisterRetainedTerminalClientView(
      SESSION_ID,
      currentOwnerView.clientId,
      currentOwnerView.viewGeneration,
    );
    assert.equal(manager.establishRetainedTerminalMutationLease(
      SESSION_ID,
      successorView.clientId,
      successorView.viewGeneration,
    ).ok, true);

    owner.control.holdSendPredicate = null;
    owner.control.releaseNextSend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      refreshSettled,
      false,
      'one generation retarget must not consume the later event-driven manager-identity recovery',
    );

    let successorRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !successorRegistration; attempt += 1) {
      successorRegistration = successor.control.sentFrames.slice(successorStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
      )).find(candidate => (
        candidate.sessionId === SESSION_ID
        && candidate.viewGeneration === successor.viewGeneration
        && candidate.viewAttributesChallengeId !== retargetRegistration.viewAttributesChallengeId
      ));
      if (!successorRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(successorRegistration, `manager identity churn did not issue one fresh current-owner challenge: ${JSON.stringify({
      ownerFrames: owner.control.sentFrames.slice(ownerStart),
      successorFrames: successor.control.sentFrames.slice(successorStart),
      audit: integration.getAuthorityAuditTrail(SESSION_ID),
      capability: integration.getQueryResponderCapabilityState(SESSION_ID),
    })}`);
    emitClientFrame(successor.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: successor.viewGeneration,
      driverLeaseGeneration: successorRegistration.driverLeaseGeneration,
      viewAttributesGeneration: successorRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: successorRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 replacement challenge reply after the original deadline cannot revive readiness', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 150 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 replacement deadline fence', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const owner = await connectProductionView(router, 'unified', 86);
    const successor = await connectProductionView(router, 'unified', 87);
    const ownerView = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === owner.connectionId
    ));
    const successorView = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === successor.connectionId
    ));
    assert.ok(ownerView);
    assert.ok(successorView);

    const ownerFrameStart = owner.control.sentFrames.length;
    const successorFrameStart = successor.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const ownerCapability = owner.control.sentFrames.slice(ownerFrameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(ownerCapability);
    const ownerRegistration = (ownerCapability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(ownerRegistration);
    owner.control.holdSendPredicate = frame => frame.type === 'terminal-authority:view-attributes-accepted';
    emitClientFrame(owner.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: owner.viewGeneration,
      driverLeaseGeneration: ownerRegistration.driverLeaseGeneration,
      viewAttributesGeneration: ownerRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: ownerRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    manager.unregisterRetainedTerminalClientView(SESSION_ID, ownerView.clientId, ownerView.viewGeneration);
    assert.equal(
      manager.establishRetainedTerminalMutationLease(
        SESSION_ID,
        successorView.clientId,
        successorView.viewGeneration,
      ).ok,
      true,
    );
    owner.control.holdSendPredicate = null;
    owner.control.releaseNextSend();

    let replacement: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !replacement; attempt += 1) {
      replacement = successor.control.sentFrames.slice(successorFrameStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
      )).find(candidate => (
        candidate.sessionId === SESSION_ID
        && candidate.viewGeneration === successor.viewGeneration
        && candidate.viewAttributesChallengeId !== ownerRegistration.viewAttributesChallengeId
      ));
      if (!replacement) await new Promise<void>(resolve => setTimeout(resolve, 2));
    }
    assert.ok(replacement, 'current owner replacement challenge was not emitted before the deadline');
    assert.equal(await refresh, false);
    emitClientFrame(successor.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: successor.viewGeneration,
      driverLeaseGeneration: replacement.driverLeaseGeneration,
      viewAttributesGeneration: replacement.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: replacement.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'a replacement response after the fixed deadline revived accepted readiness',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 rejected ACK settlement invalidates its challenge before a late duplicate', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 rejected ACK challenge fence', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 88);
    const frameStart = view.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const capability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(registration);
    const response = {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: view.viewGeneration,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    } as const;
    view.control.holdSendPredicate = frame => frame.type === 'terminal-authority:view-attributes-accepted';
    emitClientFrame(view.control, response);
    view.control.holdSendPredicate = null;
    view.control.releaseNextSend(new Error('rejected-ack-settlement'));
    assert.equal(await refresh, false);
    emitClientFrame(view.control, response);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'a late duplicate revived readiness after the ACK settlement rejected the handshake',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 pending challenge rejects a same-view client identity replacement', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  let destroyed = false;
  try {
    manager.createSession('PH005 pending client identity fence', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 89);
    const frameStart = view.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const capability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(registration);

    const routerInternals = router as unknown as {
      clients: Map<ExecutableAuthoritySocket, { connectionId?: string; clientId: string }>;
    };
    const controlMeta = routerInternals.clients.get(view.control);
    assert.ok(controlMeta);
    const oldClientId = controlMeta.clientId;
    const newClientId = `${oldClientId}-replacement`;
    manager.unregisterRetainedTerminalClientView(SESSION_ID, oldClientId, view.viewGeneration);
    controlMeta.clientId = newClientId;
    const replacementLease = manager.establishRetainedTerminalMutationLease(
      SESSION_ID,
      newClientId,
      view.viewGeneration,
    );
    assert.equal(replacementLease.ok, true, JSON.stringify(replacementLease));

    const receiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: view.viewGeneration,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const receipt = view.control.sentFrames.slice(receiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(receipt?.accepted, false);
    assert.equal(receipt?.reason, 'view-attributes-pending-identity-mismatch');
    integration.destroy();
    destroyed = true;
    assert.equal(await refresh, false);
  } finally {
    if (!destroyed) integration.destroy();
  }
});

test('MIG-BGSTAB-002 pending challenge rejects a same-view driver lease identity replacement', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  let destroyed = false;
  try {
    manager.createSession('PH005 pending driver identity fence', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 90);
    const frameStart = view.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const capability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(registration);

    const controller = (integration as unknown as {
      getAuthorityController(sessionId: string): TerminalAuthorityController | undefined;
    }).getAuthorityController(SESSION_ID);
    assert.ok(controller);
    const originalGetState = controller.getState.bind(controller);
    const originalState = originalGetState();
    assert.ok(originalState.activeDriverLeaseId);
    const replacementDriverLeaseId = `${originalState.activeDriverLeaseId}-replacement`;
    (controller as unknown as { getState: typeof originalGetState }).getState = () => ({
      ...originalGetState(),
      activeDriverLeaseId: replacementDriverLeaseId,
    });

    const receiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: view.viewGeneration,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const receipt = view.control.sentFrames.slice(receiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(receipt?.accepted, false);
    assert.equal(receipt?.reason, 'view-attributes-pending-identity-mismatch');
    integration.destroy();
    destroyed = true;
    assert.equal(await refresh, false);
  } finally {
    if (!destroyed) integration.destroy();
  }
});

test('MIG-BGSTAB-002 ACK success released after deadline cannot revive accepted readiness', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 30 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 late ACK deadline fence', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 83);
    const frameStart = view.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const capability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(registration);
    view.control.holdSendPredicate = frame => frame.type === 'terminal-authority:view-attributes-accepted';
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 83,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, false);
    view.control.holdSendPredicate = null;
    view.control.releaseNextSend();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'a late ACK callback cannot publish accepted identity after timeout',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 split output close invalidates pending handshake and re-pair requires a fresh exact identity', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 split pending re-pair', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 75);
    const staleRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    view.output.close();
    view.output.emit('close');
    assert.equal(await staleRefresh, false, 'closing the paired output must invalidate its pending identity');

    const connected = view.control.sentFrames.find(frame => frame.type === 'connected');
    assert.ok(connected);
    const replacementOutput = new ExecutableAuthoritySocket('output-repaired-75');
    router.wss.emit(
      'connection',
      replacementOutput,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(connected.clientGroupId),
        pairToken: String(connected.pairToken),
      },
    );
    negotiateProductionView(view.control, 76);
    const frameStart = view.control.sentFrames.length;
    const freshRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const capability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(registration);
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 76,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await freshRefresh, true);

    const replacementFrameStart = view.control.sentFrames.length;
    let replacedRefreshSettled = false;
    const replacedRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      replacedRefreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const replacedCapability = view.control.sentFrames.slice(replacementFrameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(replacedCapability);
    const replacedChallenge = (
      replacedCapability.registeredViews as Array<Record<string, unknown>>
    )[0]?.viewAttributesChallengeId;
    const successorOutput = new ExecutableAuthoritySocket('output-successor-76');
    router.wss.emit(
      'connection',
      successorOutput,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(connected.clientGroupId),
        pairToken: String(connected.pairToken),
      },
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(replacedRefreshSettled, true, 'output replacement must immediately fence the old lane');
    assert.equal(await replacedRefresh, false, 'output replacement must invalidate its old lane identity');
    replacementOutput.emit('close');
    assert.equal(
      router.getTerminalAuthorityResponderViews(SESSION_ID).length,
      1,
      'the replaced output late close cannot unpair its successor',
    );
    const successorFrameStart = view.control.sentFrames.length;
    const successorRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    const successorRegistration = await acceptPendingProductionViewAttributes(
      view.control,
      successorFrameStart,
      76,
      successorRefresh,
    );
    assert.notEqual(
      successorRegistration.viewAttributesChallengeId,
      replacedChallenge,
      'the successor lane must use a fresh challenge',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 follower split lane replacement and unpair preserve the exact owner handshake', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 follower split lane isolation', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const owner = await connectProductionView(router, 'split', 77);
    const follower = await connectProductionView(router, 'split', 78);
    const frameStart = owner.control.sentFrames.length;
    let refreshSettled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      refreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const capability = owner.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>).find(candidate => (
      candidate.sessionId === SESSION_ID && candidate.viewGeneration === owner.viewGeneration
    ));
    assert.ok(registration, 'the pending capability must target the current owner');

    const followerConnected = follower.control.sentFrames.find(frame => frame.type === 'connected');
    assert.ok(followerConnected);
    const followerSuccessor = new ExecutableAuthoritySocket('output-follower-successor-78');
    router.wss.emit(
      'connection',
      followerSuccessor,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(followerConnected.clientGroupId),
        pairToken: String(followerConnected.pairToken),
      },
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(refreshSettled, false, 'follower output replacement cannot settle the owner handshake');

    followerSuccessor.close();
    followerSuccessor.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(refreshSettled, false, 'follower output unpair cannot settle the owner handshake');

    emitClientFrame(owner.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: owner.viewGeneration,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true, 'the unchanged owner exact identity must still complete the handshake');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 same-view runtime recreation rejects the old challenge before accepting the replacement', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 250 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 same-view challenge recreation', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 77);
    const oldChallenge = view.negotiatedRegistration.viewAttributesChallengeId;
    const cleanupToken = 'ph005-same-view-recreation-cleanup';
    const isolationLeaseId = 'ph005-same-view-recreation-lease';
    const opened = await manager.beginTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      desiredMode: 'server',
      cleanupToken,
      isolationLeaseId,
      transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
      testContract: {
        productionConfiguredRangeProbe: { configuredScrollbackLines: 4 },
      },
    });
    assert.equal(opened.accepted, true, JSON.stringify(opened));
    const applied = await manager.applyTerminalAuthorityDebugIsolationContract({
      sessionId: SESSION_ID,
      desiredMode: 'server',
      cleanupToken,
      isolationLeaseId,
      testContract: {
        productionConfiguredRangeProbe: { configuredScrollbackLines: 4, physicalLineCount: 6 },
      },
    });
    assert.equal(applied.accepted, true, JSON.stringify(applied));

    const frameStart = view.control.sentFrames.length;
    let replacementRefreshSettled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      replacementRefreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      replacementRefreshSettled,
      false,
      'the replacement runtime must await its own same-view challenge acceptance',
    );
    const capability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
    ));
    assert.ok(capability);
    const registration = (capability.registeredViews as Array<Record<string, unknown>>)[0];
    assert.ok(registration);
    assert.notEqual(registration.viewAttributesChallengeId, oldChallenge);
    const staleReceiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 77,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: oldChallenge,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const staleReceipt = view.control.sentFrames.slice(staleReceiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(staleReceipt?.accepted, false);
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 77,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 overlapping legacy capability refreshes do not piggyback an older challenge', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 overlapping explicit refresh challenges', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 35);
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [],
    });
    const frameStart = view.control.sentFrames.length;
    const olderRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    const newerRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    negotiateProductionView(view.control, 36);

    assert.equal(await olderRefresh, false, 'an older challenge cannot settle from a newer refresh');
    await acceptPendingProductionViewAttributes(view.control, frameStart, 36, newerRefresh);
    const registrations = view.control.sentFrames.slice(frameStart).flatMap(frame => (
      frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
        ? frame.registeredViews as Array<Record<string, unknown>>
        : []
    )).filter(registration => (
      registration.sessionId === SESSION_ID
        && registration.viewGeneration === 36
        && typeof registration.viewAttributesChallengeId === 'string'
    ));
    const challengeIds = new Set(registrations.map(registration => registration.viewAttributesChallengeId));
    assert.equal(
      challengeIds.size,
      1,
      `overlapping refreshes emitted more than the current challenge: ${JSON.stringify(registrations)}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 explicit refresh retargets one successor challenge across view-generation churn', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 500 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 explicit refresh generation churn', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 111);
    const frameStart = view.control.sentFrames.length;
    let refreshSettled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      refreshSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const initialCapability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID && registration.viewGeneration === 111
        ))
    ));
    assert.ok(initialCapability);
    const initialRegistration = (
      initialCapability.registeredViews as Array<Record<string, unknown>>
    ).find(registration => (
      registration.sessionId === SESSION_ID && registration.viewGeneration === 111
    ));
    assert.ok(initialRegistration);
    assert.equal(typeof initialRegistration.viewAttributesChallengeId, 'string');

    negotiateProductionView(view.control, 112);
    negotiateProductionView(view.control, 113);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      refreshSettled,
      false,
      'ordinary generation churn must not reject the exact refresh while a successor view is available',
    );

    const staleReceiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 111,
      driverLeaseGeneration: initialRegistration.driverLeaseGeneration,
      viewAttributesGeneration: initialRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: initialRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const staleReceipt = view.control.sentFrames.slice(staleReceiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(staleReceipt?.accepted, false, 'the superseded view challenge must remain reject-only');
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'a stale generation reply cannot publish readiness',
    );

    let successorRegistrations: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      successorRegistrations = view.control.sentFrames.slice(frameStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
      )).filter(registration => (
        registration.sessionId === SESSION_ID
          && (registration.viewGeneration === 112 || registration.viewGeneration === 113)
          && typeof registration.viewAttributesChallengeId === 'string'
          && registration.viewAttributesChallengeId !== initialRegistration.viewAttributesChallengeId
      ));
      if (successorRegistrations.some(registration => registration.viewGeneration === 113)) break;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    const replacementChallengeIds = new Set(
      successorRegistrations.map(registration => registration.viewAttributesChallengeId),
    );
    assert.equal(
      replacementChallengeIds.size,
      1,
      'bounded generation retargeting must reuse one replacement challenge instead of retrying blindly',
    );
    const currentRegistration = [...successorRegistrations].reverse().find(registration => (
      registration.viewGeneration === 113
    ));
    const intermediateRegistration = successorRegistrations.find(registration => (
      registration.viewGeneration === 112
    ));
    assert.ok(intermediateRegistration, 'the N+1 successor must expose the shared replacement challenge');
    assert.ok(currentRegistration, `the latest successor must receive the replacement challenge: ${JSON.stringify({
      frames: view.control.sentFrames.slice(frameStart).map(frame => ({
        type: frame.type,
        registeredViews: frame.registeredViews,
      })),
      audit: integration.getAuthorityAuditTrail(SESSION_ID),
    })}`);
    const intermediateReceiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 112,
      driverLeaseGeneration: intermediateRegistration.driverLeaseGeneration,
      viewAttributesGeneration: intermediateRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: intermediateRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const intermediateReceipt = view.control.sentFrames.slice(intermediateReceiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(
      intermediateReceipt?.accepted,
      false,
      'the N+1 identity must remain reject-only after the same challenge retargets to N+2',
    );
    assert.equal(refreshSettled, false, 'the N+1 late ACK cannot settle the N+2 refresh');
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      false,
      'the N+1 late ACK cannot publish readiness for the shared replacement challenge',
    );
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 113,
      driverLeaseGeneration: currentRegistration.driverLeaseGeneration,
      viewAttributesGeneration: currentRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: currentRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true, 'the original refresh promise must accept the exact latest successor ACK');
    assert.equal(
      integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
      true,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 generation retarget preserves the immutable driver client anchor', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 500 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 immutable refresh client anchor', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const follower = await connectProductionView(router, 'split', 201);
    const owner = await connectProductionView(router, 'split', 211);
    const initialViews = router.getTerminalAuthorityResponderViews(SESSION_ID);
    const followerRegistration = initialViews.find(view => view.connectionId === follower.connectionId);
    const ownerRegistration = initialViews.find(view => view.connectionId === owner.connectionId);
    assert.ok(followerRegistration);
    assert.ok(ownerRegistration);
    manager.unregisterRetainedTerminalClientView(
      SESSION_ID,
      followerRegistration.clientId,
      followerRegistration.viewGeneration,
    );
    assert.equal(manager.establishRetainedTerminalMutationLease(
      SESSION_ID,
      ownerRegistration.clientId,
      ownerRegistration.viewGeneration,
    ).ok, true);
    assert.equal(manager.registerRetainedTerminalClientView(
      SESSION_ID,
      followerRegistration.clientId,
      followerRegistration.viewGeneration,
    ).ok, true);

    const ownerFrameStart = owner.control.sentFrames.length;
    const followerFrameStart = follower.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const initialOwnerCapability = owner.control.sentFrames.slice(ownerFrameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID && registration.viewGeneration === 211
        ))
    ));
    assert.ok(initialOwnerCapability, 'the suspended driver must own the initial explicit challenge');
    const initialOwnerRegistration = (
      initialOwnerCapability.registeredViews as Array<Record<string, unknown>>
    ).find(registration => registration.sessionId === SESSION_ID && registration.viewGeneration === 211);
    assert.ok(initialOwnerRegistration);

    negotiateProductionView(owner.control, 212);
    let successorRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !successorRegistration; attempt += 1) {
      successorRegistration = owner.control.sentFrames.slice(ownerFrameStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
      )).find(registration => (
        registration.sessionId === SESSION_ID
          && registration.viewGeneration === 212
          && registration.viewAttributesChallengeId !== initialOwnerRegistration.viewAttributesChallengeId
      ));
      if (!successorRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    const followerReplacement = follower.control.sentFrames.slice(followerFrameStart).some(frame => (
      frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID
            && registration.viewGeneration === 201
            && registration.viewAttributesChallengeId !== initialOwnerRegistration.viewAttributesChallengeId
        ))
    ));
    assert.equal(followerReplacement, false, 'retargeting cannot fall through to currentViews[0]');
    assert.ok(successorRegistration, 'only the original driver client successor may receive the challenge');
    emitClientFrame(owner.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 212,
      driverLeaseGeneration: successorRegistration.driverLeaseGeneration,
      viewAttributesGeneration: successorRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: successorRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(await refresh, true);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 destructive split output change fences a generation-retargeted refresh', async () => {
  for (const destructiveKind of ['output-unpaired', 'output-replaced'] as const) {
    const productionModule = await loadProductionIntegration('MIG-AC-6');
    const integration = createProductionIntegrationFixture(
      productionModule,
      'split',
      new AuthorityIntegrationFakePty(),
      { viewAttributesHandshakeTimeoutMs: 500 },
    );
    const manager = integration.sessionManager;
    (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
    try {
      manager.createSession(`PH005 retarget ${destructiveKind}`, 'bash', undefined, {
        sessionId: SESSION_ID,
      });
      const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
      const viewGeneration = destructiveKind === 'output-unpaired' ? 301 : 311;
      const view = await connectProductionView(router, 'split', viewGeneration);
      view.control.holdSendPredicate = frame => (
        frame.type === 'terminal-checkpoint:capability'
          && Array.isArray(frame.registeredViews)
          && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
            registration.sessionId === SESSION_ID
              && registration.viewGeneration === viewGeneration
          ))
      );
      let refreshSettled = false;
      let refreshResult: boolean | undefined;
      const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
        refreshSettled = true;
        refreshResult = result;
        return result;
      });
      for (let attempt = 0; attempt < 20 && view.control.heldSendCallbackCount === 0; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal(view.control.heldSendCallbackCount, 1, 'the initial exact challenge must be in flight');
      const initialCapability = [...view.control.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-checkpoint:capability'
          && Array.isArray(frame.registeredViews)
          && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
            registration.sessionId === SESSION_ID
              && registration.viewGeneration === viewGeneration
          ))
      ));
      assert.ok(initialCapability);
      const initialRegistration = (
        initialCapability.registeredViews as Array<Record<string, unknown>>
      ).find(registration => (
        registration.sessionId === SESSION_ID && registration.viewGeneration === viewGeneration
      ));
      assert.ok(initialRegistration);

      negotiateProductionView(view.control, viewGeneration + 1);
      const routerInternals = router as unknown as {
        terminalAuthorityTopologyObserver: ((change: {
          sessionId: string;
          kind: 'output-unpaired' | 'output-replaced';
          connectionId: string;
          viewGeneration: number;
        }) => void) | null;
      };
      routerInternals.terminalAuthorityTopologyObserver?.({
        sessionId: SESSION_ID,
        kind: destructiveKind,
        connectionId: view.connectionId,
        viewGeneration: viewGeneration + 1,
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(
        refreshSettled,
        true,
        `${destructiveKind} must synchronously fence the immutable retarget owner`,
      );
      assert.equal(refreshResult, false);

      view.control.holdSendPredicate = null;
      view.control.releaseNextSend();
      emitClientFrame(view.control, {
        type: 'terminal-authority:view-attributes',
        sessionId: SESSION_ID,
        viewGeneration,
        driverLeaseGeneration: initialRegistration.driverLeaseGeneration,
        viewAttributesGeneration: initialRegistration.acceptedViewAttributesGeneration,
        viewAttributesChallengeId: initialRegistration.viewAttributesChallengeId,
        attributes: PRODUCTION_VIEW_ATTRIBUTES,
      });
      await refresh;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(
        integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
        false,
        'a late ACK from the destructively replaced output lane cannot revive readiness',
      );
    } finally {
      integration.destroy();
    }
  }
});

async function verifyHeldLegacyRebindOwnerFence(
  destructiveKind: 'output-unpaired' | 'output-replaced',
) {
    const productionModule = await loadProductionIntegration('MIG-AC-6');
    const integration = createProductionIntegrationFixture(
      productionModule,
      'split',
      new AuthorityIntegrationFakePty(),
      { viewAttributesHandshakeTimeoutMs: 500 },
    );
    const manager = integration.sessionManager;
    (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
    let owner: ProductionConnectedView | undefined;
    try {
      manager.createSession(`PH005 held initial owner ${destructiveKind}`, 'bash', undefined, {
        sessionId: SESSION_ID,
      });
      const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
      const ownerGeneration = destructiveKind === 'output-unpaired' ? 351 : 361;
      owner = await connectProductionView(router, 'split', ownerGeneration);
      await promoteProductionViews(integration, [owner]);
      assert.equal((await integration.beginRollback({
        sessionId: SESSION_ID,
        selectedCompatibilityView: {
          connectionId: owner.connectionId,
          viewGeneration: ownerGeneration,
        },
      })).ok, true);
      const rollbackStart = [...owner.output.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-authority:rollback-start'
          && frame.viewGeneration === ownerGeneration
      ));
      const checkpointStart = [...owner.output.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-checkpoint:start'
          && frame.mode === 'compatibility'
          && frame.viewGeneration === ownerGeneration
      ));
      assert.ok(rollbackStart);
      assert.ok(checkpointStart);
      const checkpointIdentity = {
        protocolVersion: checkpointStart.protocolVersion,
        sessionId: SESSION_ID,
        connectionId: owner.connectionId,
        viewGeneration: ownerGeneration,
        transitionEpoch: rollbackStart.transitionEpoch,
        authorityEpoch: rollbackStart.authorityEpoch,
        streamEpoch: checkpointStart.streamEpoch,
        checkpointEpoch: checkpointStart.checkpointEpoch,
        responderLeaseId: rollbackStart.responderLeaseId,
        boundarySourceSeq: rollbackStart.boundarySourceSeq,
        sourceSeq: checkpointStart.sourceSeq,
        snapshotSeq: checkpointStart.snapshotSeq,
        oldestRetainedSeq: checkpointStart.oldestRetainedSeq,
        retentionPolicyId: checkpointStart.retentionPolicyId,
      };
      emitClientFrame(owner.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...checkpointIdentity,
        appliedThroughSeq: checkpointStart.snapshotSeq,
      });
      emitClientFrame(owner.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...checkpointIdentity,
        drainedThroughSeq: checkpointStart.sourceSeq,
      });
      emitClientFrame(owner.control, {
        type: 'terminal-authority:compatibility-drained',
        ...checkpointIdentity,
        drainedThroughSourceSeq: checkpointStart.sourceSeq,
        checkpointApplied: true,
        postSnapshotTailDrained: true,
      });
      for (let attempt = 0; attempt < 20
        && integration.getAuthorityState(SESSION_ID)?.mode !== 'legacy'; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');

      const follower = await connectProductionView(router, 'split', ownerGeneration + 20);
      const followerFrameStart = follower.control.sentFrames.length;
      owner.control.holdSendPredicate = frame => (
        frame.type === 'terminal-authority:legacy-responder-enabled'
          && frame.viewGeneration === ownerGeneration + 1
      );
      negotiateProductionView(owner.control, ownerGeneration + 1);
      for (let attempt = 0; attempt < 20 && owner.control.heldSendCallbackCount === 0; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal(owner.control.heldSendCallbackCount, 1, 'the selected owner rebind must be held');
      const currentViews = router.getTerminalAuthorityResponderViews(SESSION_ID);
      const selectedOwner = currentViews.find(candidate => (
        candidate.connectionId === owner?.connectionId
          && candidate.viewGeneration === ownerGeneration + 1
      ));
      const followerView = currentViews.find(candidate => (
        candidate.connectionId === follower.connectionId
      ));
      assert.ok(selectedOwner);
      assert.ok(followerView);

      let refreshSettled = false;
      let refreshResult: boolean | undefined;
      const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
        refreshSettled = true;
        refreshResult = result;
        return result;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      manager.unregisterRetainedTerminalClientView(
        SESSION_ID,
        selectedOwner.clientId,
        selectedOwner.viewGeneration,
      );
      assert.equal(manager.establishRetainedTerminalMutationLease(
        SESSION_ID,
        followerView.clientId,
        followerView.viewGeneration,
      ).ok, true);
      const routerInternals = router as unknown as {
        terminalAuthorityTopologyObserver: ((change: {
          sessionId: string;
          kind: 'output-unpaired' | 'output-replaced';
          connectionId: string;
          viewGeneration: number;
        }) => void) | null;
      };
      routerInternals.terminalAuthorityTopologyObserver?.({
        sessionId: SESSION_ID,
        kind: destructiveKind,
        connectionId: owner.connectionId,
        viewGeneration: ownerGeneration + 1,
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      const destructivelySettled = refreshSettled;
      const destructiveResult = refreshResult;
      owner.control.holdSendPredicate = null;
      owner.control.releaseNextSend();

      let followerRegistration: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20 && !followerRegistration; attempt += 1) {
        followerRegistration = follower.control.sentFrames.slice(followerFrameStart).flatMap(frame => (
          frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
            ? frame.registeredViews as Array<Record<string, unknown>>
            : []
        )).find(registration => (
          registration.sessionId === SESSION_ID
            && registration.viewGeneration === followerView.viewGeneration
            && typeof registration.viewAttributesChallengeId === 'string'
        ));
        if (!followerRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      if (followerRegistration) {
        emitClientFrame(follower.control, {
          type: 'terminal-authority:view-attributes',
          sessionId: SESSION_ID,
          viewGeneration: followerView.viewGeneration,
          driverLeaseGeneration: followerRegistration.driverLeaseGeneration,
          viewAttributesGeneration: followerRegistration.acceptedViewAttributesGeneration,
          viewAttributesChallengeId: followerRegistration.viewAttributesChallengeId,
          attributes: PRODUCTION_VIEW_ATTRIBUTES,
        });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.deepEqual({
        destructivelySettled,
        destructiveResult,
        followerReceivedChallenge: followerRegistration !== undefined,
        refreshBecameTrue: refreshSettled && refreshResult === true,
      }, {
        destructivelySettled: true,
        destructiveResult: false,
        followerReceivedChallenge: false,
        refreshBecameTrue: false,
      });
      assert.equal(await refresh, false);
    } finally {
      if (owner) {
        owner.control.holdSendPredicate = null;
        while (owner.control.heldSendCallbackCount > 0) owner.control.releaseNextSend();
      }
      integration.destroy();
    }
}

test('MIG-BGSTAB-002 output-unpaired fences the initially selected owner during a held legacy rebind', async () => {
  await verifyHeldLegacyRebindOwnerFence('output-unpaired');
});

test('MIG-BGSTAB-002 output-replaced fences the initially selected owner during a held legacy rebind', async () => {
  await verifyHeldLegacyRebindOwnerFence('output-replaced');
});

test('MIG-BGSTAB-002 held successor rebind resumes the latest generation with one bounded wake', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 500 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 held successor rebind wake', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 401);
    await promoteProductionViews(integration, [view]);
    assert.equal((await integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: 401,
      },
    })).ok, true);
    const rollbackStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 401
    ));
    const checkpointStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === 401
    ));
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    const checkpointIdentity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 401,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: checkpointStart.oldestRetainedSeq,
      retentionPolicyId: checkpointStart.retentionPolicyId,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...checkpointIdentity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...checkpointIdentity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      ...checkpointIdentity,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    for (let attempt = 0; attempt < 20
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'legacy'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');

    const frameStart = view.control.sentFrames.length;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const initialCapability = view.control.sentFrames.slice(frameStart).find(frame => (
      frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID && registration.viewGeneration === 401
        ))
    ));
    assert.ok(initialCapability);
    const initialRegistration = (
      initialCapability.registeredViews as Array<Record<string, unknown>>
    ).find(registration => registration.sessionId === SESSION_ID && registration.viewGeneration === 401);
    assert.ok(initialRegistration);

    view.control.holdSendPredicate = frame => (
      frame.type === 'terminal-authority:legacy-responder-enabled'
        && frame.viewGeneration === 402
    );
    negotiateProductionView(view.control, 402);
    for (let attempt = 0; attempt < 20 && view.control.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.control.heldSendCallbackCount, 1, 'the N+1 legacy rebind must be physically held');
    negotiateProductionView(view.control, 403);
    view.control.holdSendPredicate = null;
    view.control.releaseNextSend();

    let currentRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !currentRegistration; attempt += 1) {
      const currentRebindCommitted = integration.getAuthorityAuditTrail(SESSION_ID).some(event => (
        event.type === 'terminal-authority-legacy-responder-view-rebound'
          && event.viewGeneration === 403
      ));
      currentRegistration = currentRebindCommitted
        ? view.control.sentFrames.slice(frameStart).flatMap(frame => (
          frame.type === 'terminal-checkpoint:capability'
            && Array.isArray(frame.registeredViews)
            && Array.isArray(frame.mutationLeases)
            && (frame.mutationLeases as Array<Record<string, unknown>>).some(lease => (
              lease.sessionId === SESSION_ID && lease.viewGeneration === 403
            ))
            ? frame.registeredViews as Array<Record<string, unknown>>
            : []
        )).find(registration => (
          registration.sessionId === SESSION_ID
            && registration.viewGeneration === 403
            && typeof registration.viewAttributesChallengeId === 'string'
            && registration.viewAttributesChallengeId
              !== initialRegistration.viewAttributesChallengeId
        ))
        : undefined;
      if (!currentRegistration) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(currentRegistration, 'the held N+1 callback must wake one exact N+2 capability');
    const receiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 403,
      driverLeaseGeneration: currentRegistration.driverLeaseGeneration,
      viewAttributesGeneration: currentRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: currentRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const receipt = view.control.sentFrames.slice(receiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(receipt?.accepted, true, `latest held-rebind successor ACK rejected: ${JSON.stringify({
      receipt,
      registration: currentRegistration,
      state: integration.getQueryResponderCapabilityState(SESSION_ID),
      audit: integration.getAuthorityAuditTrail(SESSION_ID),
    })}`);
    assert.equal(await refresh, true);
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 explicit refresh waits for a held identity-changed rebind before fresh capability enqueue', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'unified',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 500 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 held identity changed refresh', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 42);
    await promoteProductionViews(integration, [view]);
    assert.equal((await integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
      },
    })).ok, true);
    const rollbackStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 42
    ));
    const checkpointStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === 42
    ));
    const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID);
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    assert.ok(retained);
    const identity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      viewGeneration: 42,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: retained.oldestRetainedSeq,
      retentionPolicyId: retained.retentionPolicy.retentionPolicyId,
      connectionId: view.connectionId,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...identity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...identity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 42,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');

    view.control.holdSendPredicate = frame => frame.type === 'terminal-authority:legacy-responder-enabled';
    const oldRegistration = negotiateProductionView(view.control, 43);
    for (let attempt = 0; attempt < 20 && Number(view.control.heldSendCallbackCount) === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.control.heldSendCallbackCount, 1, 'identity-changed responder rebind was not held');
    const frameStart = view.control.sentFrames.length;
    let settled = false;
    const refresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      settled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'refresh settled before the responder-enabled send callback');

    view.control.releaseNextSend();
    let initialCapabilityCount = 0;
    let initialRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
      const capabilities = view.control.sentFrames.slice(frameStart).filter(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
      ));
      while (initialCapabilityCount < capabilities.length) {
        initialRegistration = (capabilities[initialCapabilityCount].registeredViews as Array<Record<string, unknown>>)
          .find(candidate => candidate.sessionId === SESSION_ID && candidate.viewGeneration === 43);
        initialCapabilityCount += 1;
        if (!initialRegistration) continue;
        emitClientFrame(view.control, {
          type: 'terminal-authority:view-attributes',
          sessionId: SESSION_ID,
          viewGeneration: 43,
          driverLeaseGeneration: initialRegistration.driverLeaseGeneration,
          viewAttributesGeneration: initialRegistration.acceptedViewAttributesGeneration,
          viewAttributesChallengeId: initialRegistration.viewAttributesChallengeId,
          attributes: PRODUCTION_VIEW_ATTRIBUTES,
        });
      }
      if (!settled) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(initialRegistration);
    assert.equal(await refresh, true);
    const registrations = view.control.sentFrames.slice(frameStart).flatMap(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
          ? frame.registeredViews as Array<Record<string, unknown>>
          : []
    )).filter(registration => (
      registration.sessionId === SESSION_ID && registration.viewGeneration === 43
    ));
    assert.equal(registrations.length > 0, true, 'fresh challenge capability was not enqueued');
    assert.equal(
      registrations.some(registration => (
        registration.viewAttributesChallengeId === oldRegistration.viewAttributesChallengeId
      )),
      false,
      'the held rebind emitted its stale challenge after explicit freshness rotation',
    );

    const successor = await connectProductionView(router, 'unified', 44);
    view.control.holdSendPredicate = frame => (
      frame.type === 'terminal-authority:legacy-responder-enabled'
      && frame.viewGeneration === 45
    );
    negotiateProductionView(view.control, 45);
    for (let attempt = 0; attempt < 20 && Number(view.control.heldSendCallbackCount) === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(view.control.heldSendCallbackCount, 1, 'stale automatic rebind was not held');
    const staleOwner = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === view.connectionId && candidate.viewGeneration === 45
    ));
    const currentOwner = router.getTerminalAuthorityResponderViews(SESSION_ID).find(candidate => (
      candidate.connectionId === successor.connectionId && candidate.viewGeneration === 44
    ));
    assert.ok(staleOwner);
    assert.ok(currentOwner);
    manager.unregisterRetainedTerminalClientView(
      SESSION_ID,
      staleOwner.clientId,
      staleOwner.viewGeneration,
    );
    assert.equal(
      manager.establishRetainedTerminalMutationLease(
        SESSION_ID,
        currentOwner.clientId,
        currentOwner.viewGeneration,
      ).ok,
      true,
    );

    const successorFrameStart = successor.control.sentFrames.length;
    let currentRefreshSettled = false;
    const currentRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID).then(result => {
      currentRefreshSettled = true;
      return result;
    });

    view.control.holdSendPredicate = null;
    view.control.releaseNextSend();
    let currentCapabilityCount = 0;
    let currentRegistration: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !currentRefreshSettled; attempt += 1) {
      const capabilities = successor.control.sentFrames.slice(successorFrameStart).filter(frame => (
        frame.type === 'terminal-checkpoint:capability' && Array.isArray(frame.registeredViews)
      ));
      while (currentCapabilityCount < capabilities.length) {
        currentRegistration = (capabilities[currentCapabilityCount].registeredViews as Array<Record<string, unknown>>)
          .find(candidate => candidate.sessionId === SESSION_ID && candidate.viewGeneration === 44);
        currentCapabilityCount += 1;
        if (!currentRegistration) continue;
        emitClientFrame(successor.control, {
          type: 'terminal-authority:view-attributes',
          sessionId: SESSION_ID,
          viewGeneration: 44,
          driverLeaseGeneration: currentRegistration.driverLeaseGeneration,
          viewAttributesGeneration: currentRegistration.acceptedViewAttributesGeneration,
          viewAttributesChallengeId: currentRegistration.viewAttributesChallengeId,
          attributes: PRODUCTION_VIEW_ATTRIBUTES,
        });
      }
      if (!currentRefreshSettled) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(currentRegistration);
    assert.equal(
      await currentRefresh,
      true,
      `current owner refresh failed after stale release: ${JSON.stringify({
        registration: currentRegistration,
        capability: integration.getQueryResponderCapabilityState(SESSION_ID),
        audit: integration.getAuthorityAuditTrail(SESSION_ID),
        frames: successor.control.sentFrames.slice(successorFrameStart),
        ports: manager.getTerminalAuthorityRuntimePortState(SESSION_ID),
      })}`,
    );
    assert.deepEqual(integration.getQueryResponderCapabilityState(SESSION_ID), {
      promotionEligible: true,
      hasAcceptedViewAttributes: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(
      integration.getQueryResponderCapabilityState(SESSION_ID),
      { promotionEligible: true, hasAcceptedViewAttributes: true },
      'late automatic completion changed the current expected driver or attribute cache',
    );

  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 explicit legacy capability refresh fails closed after a bounded permanent topology gap', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
    { viewAttributesHandshakeTimeoutMs: 30 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 permanent explicit refresh gap', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 37);
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [],
    });
    const frameStart = view.control.sentFrames.length;

    assert.equal(await integration.requestQueryResponderCapabilityRefresh(SESSION_ID), false);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(
      view.control.sentFrames.slice(frameStart).some(frame => frame.type === 'terminal-checkpoint:capability'),
      false,
      'a timed-out refresh emitted a later capability without a current view',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 runtime recreation invalidates an old pending refresh before a new runtime refresh succeeds', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 pending refresh runtime recreation', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 38);
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [],
    });
    const oldRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    const cleanupToken = 'ph005-pending-refresh-recreate-cleanup-token';
    const isolationLeaseId = 'ph005-pending-refresh-recreate-isolation-lease';
    const opened = await manager.beginTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      desiredMode: 'server',
      cleanupToken,
      isolationLeaseId,
      transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
      testContract: {
        retainedPolicyOverride: { effectiveRetainedScrollbackLines: 4 },
      },
    });
    assert.equal(opened.accepted, true, JSON.stringify(opened));
    assert.equal(await oldRefresh, false, 'the disposed runtime refresh crossed into its replacement');

    negotiateProductionView(view.control, 39);
    const frameStart = view.control.sentFrames.length;
    const replacementRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await acceptPendingProductionViewAttributes(view.control, frameStart, 39, replacementRefresh);
    assert.equal(
      view.control.sentFrames.slice(frameStart).some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID && registration.viewGeneration === 39
        ))
      )),
      true,
      'the replacement runtime omitted its current capability',
    );
    const cleaned = await manager.cleanupTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      cleanupToken,
      isolationLeaseId,
      restoreScopes: ['authority-runtime'],
      authorityFence: manager.getTerminalAuthorityState(SESSION_ID)!,
    });
    assert.equal(cleaned.accepted, true, JSON.stringify(cleaned));
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 split control advertises view attributes only after its output lane pairs', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 split view attributes', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const control = new ExecutableAuthoritySocket('control-unpaired-view-attributes');
    router.wss.emit(
      'connection',
      control,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      { ok: true, requestedMode: 'split', channelRole: 'control' },
    );
    const connected = control.sentFrames.find(frame => frame.type === 'connected');
    assert.ok(connected);
    emitClientFrame(control, { type: 'subscribe', sessionIds: [SESSION_ID] });
    const unpairedRegistration = negotiateProductionView(control, 40);
    assert.equal(
      unpairedRegistration.viewAttributesChallengeId,
      undefined,
      'an unpaired split control must not advertise an authority grant it cannot validate',
    );
    const output = new ExecutableAuthoritySocket('output-paired-view-attributes');
    router.wss.emit(
      'connection',
      output,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(connected.clientGroupId),
        pairToken: String(connected.pairToken),
      },
    );
    const registration = negotiateProductionView(control, 40);
    assert.equal(typeof registration.viewAttributesChallengeId, 'string');
    output.close();
    output.emit('close');
    assert.equal(
      router.getTerminalAuthorityResponderViews(SESSION_ID).length,
      0,
      'a closed split output lane must remain excluded from delivery and promotion topology',
    );
    const receiptStart = control.sentFrames.length;
    emitClientFrame(control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 40,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const receipt = control.sentFrames.slice(receiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(
      receipt?.accepted,
      true,
      `a capability advertised after split pairing must accept its exact attributes: ${JSON.stringify(receipt)}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 headless runtime recreation restores a fresh legacy browser mutation lease', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'unified', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 runtime recreation lease restore', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 41);
    assert.equal(
      view.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          typeof registration.acceptedViewAttributesGeneration === 'string'
          && typeof registration.viewAttributesChallengeId !== 'string'
        ))
      )),
      false,
      'every authority-grant capability must carry its current view-attributes challenge',
    );
    const initialCapability = view.control.sentFrames.find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && Array.isArray(frame.mutationLeases)
      && frame.mutationLeases.length > 0
    ));
    assert.ok(initialCapability, 'precondition: the original runtime must grant a browser mutation lease');
    const initialRegistration = (initialCapability.registeredViews as Array<Record<string, unknown>>)
      .find(registration => registration.sessionId === SESSION_ID);
    assert.equal(typeof initialRegistration?.viewAttributesChallengeId, 'string');

    const cleanupToken = 'ph005-runtime-recreate-cleanup-token';
    const isolationLeaseId = 'ph005-runtime-recreate-isolation-lease';
    const opened = await manager.beginTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      desiredMode: 'legacy',
      cleanupToken,
      isolationLeaseId,
      transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
      testContract: {
        retainedPolicyOverride: { effectiveRetainedScrollbackLines: 4 },
      },
    });
    assert.equal(opened.accepted, true, JSON.stringify(opened));
    const frameStart = view.control.sentFrames.length;
    const cleaned = await manager.cleanupTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      cleanupToken,
      isolationLeaseId,
      restoreScopes: ['authority-runtime'],
      authorityFence: manager.getTerminalAuthorityState(SESSION_ID)!,
    });
    assert.equal(cleaned.accepted, true, JSON.stringify(cleaned));

    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      router.getTerminalAuthorityResponderViews(SESSION_ID).length,
      1,
      'the current capable view registration must survive headless runtime recreation',
    );
    let restoredCapability: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !restoredCapability; attempt += 1) {
      restoredCapability = view.control.sentFrames.slice(frameStart).find(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.authorityMode === 'legacy'
        && Array.isArray(frame.mutationLeases)
        && (frame.mutationLeases as Array<Record<string, unknown>>).some(lease => (
          lease.sessionId === SESSION_ID && lease.viewGeneration === 41
        ))
      ));
      if (!restoredCapability) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(
      restoredCapability,
      `the recreated runtime never announced a fresh legacy mutation lease: ${JSON.stringify({
        audit: integration.getAuthorityAuditTrail(SESSION_ID),
        ports: manager.getTerminalAuthorityRuntimePortState(SESSION_ID),
        views: router.getTerminalAuthorityResponderViews(SESSION_ID),
      })}`,
    );
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    const restoredCapabilities = view.control.sentFrames.slice(frameStart).filter(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.authorityMode === 'legacy'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
        registration.sessionId === SESSION_ID && registration.viewGeneration === 41
      ))
    ));
    assert.equal(
      restoredCapabilities.length,
      1,
      'the recreated runtime must advertise one current capability without a blind retry queue',
    );
    const restoredRegistration = (restoredCapability.registeredViews as Array<Record<string, unknown>>)
      .find(registration => (
        registration.sessionId === SESSION_ID && registration.viewGeneration === 41
      ));
    assert.ok(restoredRegistration, 'the recreated runtime capability omitted the current legacy view');
    assert.equal(typeof restoredRegistration.viewAttributesChallengeId, 'string');
    assert.notEqual(
      restoredRegistration.viewAttributesChallengeId,
      initialRegistration?.viewAttributesChallengeId,
      'runtime recreation must invalidate the previous view-attributes challenge without rotating view/stream generations',
    );
    const missingAttributesPromotion = await integration.beginPromotion(SESSION_ID);
    assert.equal(
      missingAttributesPromotion.reason,
      'queryResponderCapability-view-attributes-challenge-unaccepted-gate-failed',
      'promotion must identify fresh view attributes as the missing pre-mutation query gate',
    );
    const ports = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
    assert.equal(ports?.admission.mode, 'legacy');
    assert.equal(ports?.recoveryRequiredReason, null);
    const explicitRefreshFrameStart = view.control.sentFrames.length;
    const explicitRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await new Promise<void>(resolve => setImmediate(resolve));
    const explicitRefreshCapability = view.control.sentFrames
      .slice(explicitRefreshFrameStart)
      .find(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.authorityMode === 'legacy'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID && registration.viewGeneration === 41
        ))
      ));
    assert.ok(
      explicitRefreshCapability,
      'explicit configured admission refresh did not advertise the current legacy capability',
    );
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    const explicitRefreshCapabilities = view.control.sentFrames
      .slice(explicitRefreshFrameStart)
      .filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && frame.authorityMode === 'legacy'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID && registration.viewGeneration === 41
        ))
      ));
    assert.equal(
      explicitRefreshCapabilities.length,
      1,
      'explicit refresh must keep one exact challenge in flight until the browser replies',
    );
    const explicitRefreshRegistration = (
      explicitRefreshCapability.registeredViews as Array<Record<string, unknown>>
    ).find(registration => (
      registration.sessionId === SESSION_ID && registration.viewGeneration === 41
    ));
    assert.ok(explicitRefreshRegistration);
    assert.equal(typeof explicitRefreshRegistration.viewAttributesChallengeId, 'string');
    assert.notEqual(
      explicitRefreshRegistration.viewAttributesChallengeId,
      restoredRegistration.viewAttributesChallengeId,
      'explicit admission refresh must issue a causally fresh challenge',
    );
    for (const generationField of [
      'viewGeneration',
      'authorityStreamEpoch',
      'driverLeaseGeneration',
      'acceptedViewAttributesGeneration',
    ] as const) {
      assert.equal(
        explicitRefreshRegistration[generationField],
        restoredRegistration[generationField],
        `${generationField} must not rotate merely to refresh view-attribute freshness`,
      );
    }

    for (const [label, attributes] of [
      ['ansi-15', { ...PRODUCTION_VIEW_ATTRIBUTES, ansi: PRODUCTION_ANSI_256.slice(0, 15) }],
      ['ansi-16', { ...PRODUCTION_VIEW_ATTRIBUTES, ansi: PRODUCTION_ANSI_256.slice(0, 16) }],
      ['ansi-255', { ...PRODUCTION_VIEW_ATTRIBUTES, ansi: PRODUCTION_ANSI_256.slice(0, 255) }],
      ['malformed-rgb', {
        ...PRODUCTION_VIEW_ATTRIBUTES,
        ansi: PRODUCTION_ANSI_256.map((rgb, index) => index === 196 ? [256, 0, 0] : rgb),
      }],
    ] as const) {
      const receiptStart = view.control.sentFrames.length;
      emitClientFrame(view.control, {
        type: 'terminal-authority:view-attributes',
        sessionId: SESSION_ID,
        viewGeneration: 41,
        driverLeaseGeneration: explicitRefreshRegistration.driverLeaseGeneration,
        viewAttributesGeneration: explicitRefreshRegistration.acceptedViewAttributesGeneration,
        viewAttributesChallengeId: explicitRefreshRegistration.viewAttributesChallengeId,
        attributes,
      });
      const receipt = view.control.sentFrames.slice(receiptStart).find(frame => (
        frame.type === 'terminal-authority:view-attributes-accepted'
      ));
      assert.equal(receipt?.accepted, false, `${label} palette must fail closed`);
      assert.equal(receipt?.reason, 'view-attributes-shape-invalid');
      assert.equal(
        integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
        false,
        `${label} palette cannot advance configured admission`,
      );
    }

    for (const [label, challenge] of [
      ['missing', undefined],
      ['old', restoredRegistration.viewAttributesChallengeId],
      ['wrong', 'challenge-from-another-runtime'],
    ] as const) {
      const receiptStart = view.control.sentFrames.length;
      emitClientFrame(view.control, {
        type: 'terminal-authority:view-attributes',
        sessionId: SESSION_ID,
        viewGeneration: 41,
        driverLeaseGeneration: explicitRefreshRegistration.driverLeaseGeneration,
        viewAttributesGeneration: explicitRefreshRegistration.acceptedViewAttributesGeneration,
        ...(challenge === undefined ? {} : { viewAttributesChallengeId: challenge }),
        attributes: PRODUCTION_VIEW_ATTRIBUTES,
      });
      const receipt = view.control.sentFrames.slice(receiptStart).find(frame => (
        frame.type === 'terminal-authority:view-attributes-accepted'
      ));
      assert.equal(receipt?.accepted, false, `${label} challenge must fail closed`);
      assert.equal(
        integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes,
        false,
        `${label} challenge cannot satisfy configured admission freshness`,
      );
    }

    const acceptedReceiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 41,
      driverLeaseGeneration: explicitRefreshRegistration.driverLeaseGeneration,
      viewAttributesGeneration: explicitRefreshRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: explicitRefreshRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const acceptedReceipt = view.control.sentFrames.slice(acceptedReceiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(acceptedReceipt?.accepted, true);
    assert.equal(await explicitRefresh, true, 'valid exact attributes and ACK settlement must complete refresh');
    assert.equal(
      acceptedReceipt?.viewAttributesChallengeId,
      explicitRefreshRegistration.viewAttributesChallengeId,
      'accepted ACK must echo the exact challenge that established freshness',
    );
    const orderedAttributesBytes = Buffer.from(JSON.stringify(PRODUCTION_VIEW_ATTRIBUTES), 'utf8');
    assert.equal(acceptedReceipt?.acceptedViewAttributesByteLength, orderedAttributesBytes.byteLength);
    assert.equal(
      acceptedReceipt?.acceptedViewAttributesSha256,
      createHash('sha256').update(orderedAttributesBytes).digest('hex'),
      'server acceptance must attest the browser palette in exact index order',
    );
    const capabilityCountAfterAcceptance = view.control.sentFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
        registration.sessionId === SESSION_ID
        && registration.viewGeneration === 41
        && registration.viewAttributesChallengeId
          === explicitRefreshRegistration.viewAttributesChallengeId
      ))
    )).length;
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    assert.equal(
      view.control.sentFrames.filter(frame => (
        frame.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.registeredViews)
        && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
          registration.sessionId === SESSION_ID
          && registration.viewGeneration === 41
          && registration.viewAttributesChallengeId
            === explicitRefreshRegistration.viewAttributesChallengeId
        ))
      )).length,
      capabilityCountAfterAcceptance,
      'fresh view-attributes acceptance must stop exact challenge retries',
    );
    const duplicateReceiptStart = view.control.sentFrames.length;
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 41,
      driverLeaseGeneration: explicitRefreshRegistration.driverLeaseGeneration,
      viewAttributesGeneration: explicitRefreshRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: explicitRefreshRegistration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    const duplicateReceipt = view.control.sentFrames.slice(duplicateReceiptStart).find(frame => (
      frame.type === 'terminal-authority:view-attributes-accepted'
    ));
    assert.equal(duplicateReceipt?.accepted, true, 'duplicate exact challenge must be idempotent');
    const secondPromotion = await integration.beginPromotion(SESSION_ID);
    assert.equal(
      secondPromotion.reason?.startsWith('queryResponderCapability-') ?? false,
      false,
      `the recreated query responder must accept fresh view attributes before the next promotion: ${JSON.stringify(secondPromotion)}`,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 configured corpus recreation refreshes the replacement runtime before promotion', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 configured corpus runtime refresh', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 44);
    const modelBefore = manager.getTerminalAuthorityDebugModelInstanceId(SESSION_ID);
    const cleanupToken = 'ph005-configured-corpus-refresh-cleanup-token';
    const isolationLeaseId = 'ph005-configured-corpus-refresh-isolation-lease';
    const opened = await manager.beginTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      desiredMode: 'server',
      cleanupToken,
      isolationLeaseId,
      transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
      testContract: {
        productionConfiguredRangeProbe: { configuredScrollbackLines: 4 },
      },
    });
    assert.equal(opened.accepted, true, JSON.stringify(opened));
    assert.equal(manager.getTerminalAuthorityDebugModelInstanceId(SESSION_ID), modelBefore);

    const applied = await manager.applyTerminalAuthorityDebugIsolationContract({
      sessionId: SESSION_ID,
      desiredMode: 'server',
      cleanupToken,
      isolationLeaseId,
      testContract: {
        productionConfiguredRangeProbe: {
          configuredScrollbackLines: 4,
          physicalLineCount: 6,
        },
      },
    });
    assert.equal(applied.accepted, true, JSON.stringify(applied));
    assert.notEqual(
      manager.getTerminalAuthorityDebugModelInstanceId(SESSION_ID),
      modelBefore,
      'configured corpus apply must recreate the mismatched runtime before capability refresh',
    );

    const frameStart = view.control.sentFrames.length;
    const configuredRefresh = integration.requestQueryResponderCapabilityRefresh(SESSION_ID);
    await acceptPendingProductionViewAttributes(view.control, frameStart, 44, configuredRefresh);
    const refreshedCapability = [...view.control.sentFrames.slice(frameStart)].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:capability'
      && frame.authorityMode === 'legacy'
      && Array.isArray(frame.registeredViews)
      && (frame.registeredViews as Array<Record<string, unknown>>).some(registration => (
        registration.sessionId === SESSION_ID && registration.viewGeneration === 44
      ))
    ));
    assert.ok(refreshedCapability);
    const registration = (refreshedCapability.registeredViews as Array<Record<string, unknown>>)
      .find(candidate => candidate.sessionId === SESSION_ID && candidate.viewGeneration === 44);
    assert.ok(registration);
    emitClientFrame(view.control, {
      type: 'terminal-authority:view-attributes',
      sessionId: SESSION_ID,
      viewGeneration: 44,
      driverLeaseGeneration: registration.driverLeaseGeneration,
      viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: registration.viewAttributesChallengeId,
      attributes: PRODUCTION_VIEW_ATTRIBUTES,
    });
    assert.equal(integration.getQueryResponderCapabilityState(SESSION_ID)?.hasAcceptedViewAttributes, true);
    const recoveryControlFrameStart = view.control.sentFrames.length;
    const recoveryOutputFrameStart = view.output.sentFrames.length;
    assert.deepEqual(await integration.beginPromotion(SESSION_ID), {
      ok: false,
      reason: 'server-recovery-ack-missing',
    });
    let recoverySnapshot: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !recoverySnapshot; attempt += 1) {
      recoverySnapshot = [
        ...view.control.sentFrames.slice(recoveryControlFrameStart),
        ...view.output.sentFrames.slice(recoveryOutputFrameStart),
      ].find(frame => frame.type === 'screen-snapshot' && frame.sessionId === SESSION_ID);
      if (!recoverySnapshot) await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(recoverySnapshot, `replacement runtime recovery snapshot was not delivered: ${JSON.stringify([
      ...view.control.sentFrames.slice(recoveryControlFrameStart),
      ...view.output.sentFrames.slice(recoveryOutputFrameStart),
    ].map(frame => frame.type))}`);
    emitClientFrame(view.control, {
      type: 'screen-snapshot:ready',
      sessionId: SESSION_ID,
      replayToken: recoverySnapshot.replayToken,
    });
    const promoted = await integration.beginPromotion(SESSION_ID);
    assert.equal(promoted.ok, true, JSON.stringify(promoted));
  } finally {
    integration.destroy();
  }
});

async function verifyRollbackReregistersRouterProvenCompatibilityView(): Promise<void> {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'unified', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 rollback retained client repair', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'unified', 51);
    await promoteProductionViews(integration, [view]);
    const routerView = router.getTerminalAuthorityResponderViews(SESSION_ID)
      .find(candidate => candidate.connectionId === view.connectionId);
    assert.ok(routerView);
    manager.unregisterRetainedTerminalClientView(
      SESSION_ID,
      routerView.clientId,
      routerView.viewGeneration,
    );

    assert.equal((await integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
      },
    })).ok, true);
    const rollbackStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-authority:rollback-start' && frame.viewGeneration === 51
    ));
    const checkpointStart = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.viewGeneration === 51
    ));
    const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID);
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    assert.ok(retained);
    const identity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      viewGeneration: 51,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: retained.oldestRetainedSeq,
      retentionPolicyId: retained.retentionPolicy.retentionPolicyId,
      connectionId: view.connectionId,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...identity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...identity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: 51,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'legacy',
      'the current router-proven view must be restored before compatibility lease rebind',
    );
  } finally {
    integration.destroy();
  }
}

test('MIG-BGSTAB-002 stale promotion deadline cannot roll back a replacement authority runtime', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  assert.equal(
    typeof productionModule.isScheduledTerminalAuthorityRuntimeCurrent,
    'function',
    'the production deadline callback needs an explicit runtime-generation fence',
  );
  const staleRuntime = { disposed: false };
  const replacementRuntime = { disposed: false };
  assert.equal(
    productionModule.isScheduledTerminalAuthorityRuntimeCurrent(staleRuntime, replacementRuntime),
    false,
    'a callback captured from an older runtime must not mutate the replacement runtime',
  );
  staleRuntime.disposed = true;
  assert.equal(
    productionModule.isScheduledTerminalAuthorityRuntimeCurrent(staleRuntime, staleRuntime),
    false,
    'a disposed runtime must remain fenced even if it is still temporarily addressable',
  );
  const currentRuntime = { disposed: false };
  assert.equal(
    productionModule.isScheduledTerminalAuthorityRuntimeCurrent(currentRuntime, currentRuntime),
    true,
    'the live scheduled runtime must still be allowed to enforce its own deadline',
  );
});

test('MIG-BGSTAB-002 explicit recovery resumes an existing rollback with the current compatibility view', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 explicit compatibility recovery resume', 'bash', undefined, {
      sessionId: SESSION_ID,
    });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 51);
    await promoteProductionViews(integration, [view]);
    const started = await integration.beginRollback(SESSION_ID);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');

    const replacementFrameStart = view.output.sentFrames.length;
    const auditStart = integration.getAuthorityAuditTrail(SESSION_ID).length;
    const resumed = await integration.beginRollback(SESSION_ID);
    assert.equal(
      resumed.ok,
      true,
      `stalled compatibility recovery must be resumable instead of returning ${resumed.reason}`,
    );
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    const replacementFrames = view.output.sentFrames.slice(replacementFrameStart);
    const replacementRollbackStarts = replacementFrames.filter(frame => (
      frame.type === 'terminal-authority:rollback-start'
    ));
    assert.equal(
      replacementRollbackStarts.length,
      1,
      'the explicit resume owns exactly one replacement rollback transaction',
    );
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).slice(auditStart).some(event => (
        event.type === 'authority-send-recovery-scheduled'
          && event.kind === 'explicit-compatibility-recovery-resume'
      )),
      false,
      'explicit resume must not also self-schedule the generic authority recovery loop',
    );

    const rollbackStart = replacementRollbackStarts[0];
    const checkpointStart = replacementFrames.find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'compatibility'
        && frame.transitionEpoch === rollbackStart?.transitionEpoch
    ));
    assert.ok(rollbackStart);
    assert.ok(checkpointStart);
    const checkpointIdentity = {
      protocolVersion: checkpointStart.protocolVersion,
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: view.viewGeneration,
      transitionEpoch: rollbackStart.transitionEpoch,
      authorityEpoch: rollbackStart.authorityEpoch,
      streamEpoch: checkpointStart.streamEpoch,
      checkpointEpoch: checkpointStart.checkpointEpoch,
      responderLeaseId: rollbackStart.responderLeaseId,
      boundarySourceSeq: rollbackStart.boundarySourceSeq,
      sourceSeq: checkpointStart.sourceSeq,
      snapshotSeq: checkpointStart.snapshotSeq,
      oldestRetainedSeq: checkpointStart.oldestRetainedSeq,
      retentionPolicyId: checkpointStart.retentionPolicyId,
    };
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...checkpointIdentity,
      appliedThroughSeq: checkpointStart.snapshotSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...checkpointIdentity,
      drainedThroughSeq: checkpointStart.sourceSeq,
    });
    emitClientFrame(view.control, {
      type: 'terminal-authority:compatibility-drained',
      ...checkpointIdentity,
      drainedThroughSourceSeq: checkpointStart.sourceSeq,
      checkpointApplied: true,
      postSnapshotTailDrained: true,
    });
    for (let attempt = 0; attempt < 20
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'legacy'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 session finalization disposes authority timer and settles queued delivery exactly once', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 authority lifecycle dispose', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    assert.equal((await integration.beginPromotion(SESSION_ID)).ok, true);
    const boundary = view.output.sentFrames.find(frame => (
      frame.type === 'terminal-authority:responder-disable-boundary'
    ));
    assert.ok(boundary);
    const frozen = (boundary.requiredResponderViews as Array<Record<string, unknown>>)[0];
    assert.ok(frozen);
    view.output.holdSendCallbacks = true;
    emitClientFrame(view.control, {
      type: 'terminal-authority:responder-disabled',
      ...frozen,
      sessionId: SESSION_ID,
      transitionEpoch: boundary.transitionEpoch,
      authorityEpoch: boundary.authorityEpoch,
      streamEpoch: boundary.streamEpoch,
      boundarySourceSeq: boundary.boundarySourceSeq,
      responderLeaseId: boundary.responderLeaseId,
    });
    for (let attempt = 0; attempt < 20 && view.output.heldSendCallbackCount === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(view.output.heldSendCallbackCount, 1);

    assert.equal(manager.deleteSession(SESSION_ID), true);
    assert.equal(integration.getAuthorityState(SESSION_ID), undefined);
    const frameCountAfterDispose = view.output.sentFrames.length;
    view.output.releaseNextSend();
    await new Promise<void>(resolve => setTimeout(resolve, 1_050));
    assert.equal(integration.getAuthorityState(SESSION_ID), undefined);
    assert.equal(
      view.output.sentFrames.slice(frameCountAfterDispose)
        .some(frame => frame.type === 'terminal-authority:rollback-start'),
      false,
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 production promotion deadline follows the configured browser ACK contract exactly once', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  assert.ok(
    productionModule.TERMINAL_AUTHORITY_DEFAULT_ACK_DEADLINE_MS > 2_000,
    'the server default must exceed the browser 2s FIFO probe upper bound',
  );
  assert.equal(
    productionModule.getTerminalAuthorityPromotionAckTimerDelayMs(200),
    201,
    'the timer must use the exact configured boundary plus the strict > fence',
  );
  assert.equal(
    productionModule.getTerminalAuthorityPromotionAckTimerDelayMs(),
    productionModule.TERMINAL_AUTHORITY_DEFAULT_ACK_DEADLINE_MS + 1,
  );
  const adapterSource = readFileSync(
    new URL('./TerminalAuthorityProductionAdapter.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    adapterSource,
    /if\s*\(\s*!result\.completed\s*&&\s*state\.mode\s*===\s*['"]rolling-back['"]\s*\)/u,
    'receipt rejection must still drive the production ordered rollback port',
  );
  const fakePty = new AuthorityIntegrationFakePty();
  const ackDeadlineMs = 200;
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty, {
    promotionSafetyLimits: {
      ackDeadlineMs,
      maxHeldOutputBytes: 1024 * 1024,
      maxHeldOutputChunks: 1024,
    },
  });
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 configured promotion deadline', 'bash', undefined, { sessionId: SESSION_ID });
    const controller = (manager as unknown as SessionManagerAuthorityIntegrationApi)
      .sessions.get(SESSION_ID)?.terminalAuthorityController;
    assert.ok(controller);
    const checkPromotionDeadline = controller.checkPromotionDeadline.bind(controller);
    let deadlineCheckCalls = 0;
    controller.checkPromotionDeadline = () => {
      deadlineCheckCalls += 1;
      return checkPromotionDeadline();
    };
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 11);
    assert.equal((await integration.beginPromotion(SESSION_ID)).ok, true);

    await new Promise<void>(resolve => setTimeout(resolve, 160));
    assert.equal(
      integration.getAuthorityState(SESSION_ID)?.mode,
      'promoting',
      'the adapter rolled back before the configured deadline',
    );

    for (let attempt = 0; attempt < 14
      && integration.getAuthorityState(SESSION_ID)?.mode === 'promoting'; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');
    const rollbackStarts = () => view.output.sentFrames.filter(frame => (
      frame.type === 'terminal-authority:rollback-start'
    )).length;
    assert.equal(rollbackStarts(), 1, 'the configured deadline must initiate one ordered rollback');
    const deadlineRecoveries = () => integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
      event.type === 'ordered-compatibility-recovery-required'
      && event.kind === 'disable-ack-deadline-exceeded'
    )).length;
    assert.equal(deadlineRecoveries(), 1);
    await new Promise<void>(resolve => setTimeout(resolve, ackDeadlineMs));
    assert.equal(deadlineRecoveries(), 1, 'the promotion deadline timer must not fire more than once');
    assert.equal(deadlineCheckCalls, 1, 'the adapter must invoke its deadline check exactly once');
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 recovery ACK miss preserves bootstrap replay until the refreshed model is acknowledged', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-4');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 recovery ACK refresh fence', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi & {
      supersedeTerminalAuthorityBootstrapReplay(sessionId: string): { ok: boolean; supersededViewCount: number };
      getTerminalAuthorityResponderViews(sessionId: string): Array<{
        clientId: string;
        viewGeneration: number;
      }>;
    };
    await connectProductionView(router, 'split', 11);
    const responder = router.getTerminalAuthorityResponderViews(SESSION_ID)[0];
    assert.ok(responder);
    assert.equal(
      manager.registerRetainedTerminalClientView(SESSION_ID, responder.clientId, 12).ok,
      true,
      'the test must invalidate the previously acknowledged view generation',
    );
    const originalSupersede = router.supersedeTerminalAuthorityBootstrapReplay.bind(router);
    let supersedeCalls = 0;
    router.supersedeTerminalAuthorityBootstrapReplay = (sessionId: string) => {
      supersedeCalls += 1;
      return originalSupersede(sessionId);
    };

    const promotion = await integration.beginPromotion(SESSION_ID);
    assert.deepEqual(promotion, { ok: false, reason: 'stale-view-generation' });
    assert.equal(
      supersedeCalls,
      0,
      'a recovery miss must leave the refreshed bootstrap replay pending for the browser ACK',
    );
  } finally {
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 attachment destroy detaches active authority runtime and clears its owned factory', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => fakePty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
    retainedTerminalShadowEnabled: true,
    retainedTerminalInitialOrdinal: { streamEpoch: '7', sourceSeq: '0' },
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  const router = new wsRouterModule.WsRouter(
    { verifyToken: () => ({ valid: true, payload: { sub: 'authority-test-user', jti: 'authority-test-token' } }) } as never,
    manager,
    { realtime: { wsTransportMode: 'split' } },
  );
  const attachment = productionModule.attachProductionTerminalAuthority({
    sessionManager: manager,
    wsRouter: router,
    transportMode: 'split',
  });
  const managerApi = manager as unknown as SessionManagerAuthorityIntegrationApi;
  try {
    manager.createSession('PH005 attached active runtime', 'bash', undefined, { sessionId: SESSION_ID });
    const active = managerApi.sessions.get(SESSION_ID);
    assert.ok(active?.terminalAuthorityController);
    assert.ok(active.terminalQueryResponder);
    const detachedController = active.terminalAuthorityController;
    const detachedQueryResponder = active.terminalQueryResponder;
    const view = await connectProductionView(router as unknown as ExecutableWsRouterApi, 'split', 11);
    await promoteProductionViews(attachment, [view]);
    const promotedPorts = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
    assert.equal(promotedPorts?.admission.mode, 'server');
    assert.equal(promotedPorts?.driver.active, 'server-headless');
    assert.equal(promotedPorts?.responder.active, 'server-headless');
    assert.equal(promotedPorts?.responder.serverEnabled, true);

    attachment.destroy();
    assert.equal(manager.getSession(SESSION_ID) !== undefined, true, 'caller-owned session must remain alive');
    assert.equal(active.terminalAuthorityController, undefined);
    assert.equal(active.terminalQueryResponder, undefined);
    const detachedPorts = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
    assert.equal(detachedPorts?.admission.mode, 'none');
    assert.equal(detachedPorts?.driver.active, null);
    assert.equal(detachedPorts?.responder.active, null);
    assert.equal(detachedPorts?.responder.legacyEnabled, false);
    assert.equal(detachedPorts?.responder.serverEnabled, false);
    assert.equal(
      detachedPorts?.recoveryRequiredReason,
      'authority-runtime-detached-before-ordered-compatibility-recovery',
      'sync destroy must expose fail-closed recovery instead of claiming an unacknowledged legacy handoff',
    );
    assert.equal(
      detachedPorts?.responder.revokedLeaseIds.includes(promotedPorts!.responder.activeLeaseId!),
      true,
      'destroy must revoke the exact active server responder lease',
    );
    assert.equal(
      detachedPorts?.driver.revokedLeaseIds.includes(promotedPorts!.driver.activeLeaseId!),
      true,
      'destroy must revoke the exact active server driver lease',
    );
    const writesBeforeDetachedQuery = fakePty.writes.length;
    fakePty.emitData('\u001b[5nlegacy-after-detach');
    await active.headlessWriteChain;
    assert.equal(
      fakePty.writes.length,
      writesBeforeDetachedQuery,
      'detached server query responder must have zero stale PTY side effects',
    );
    assert.equal(manager.attachTerminalAuthorityRuntime(SESSION_ID, {
      controller: detachedController as never,
      queryResponder: detachedQueryResponder as never,
      dispose: () => {},
    }), true, 'runtime object attachment alone is not wire recovery evidence');
    assert.equal(
      manager.getTerminalAuthorityRuntimePortState(SESSION_ID)?.recoveryRequiredReason,
      'authority-runtime-detached-before-ordered-compatibility-recovery',
      'attach alone must preserve the recovery-required fence',
    );
    const reattachedParity = manager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
    assert.equal(reattachedParity.leaseParity, false);
    assert.equal(
      reattachedParity.blockers.includes('authority-runtime-detached-before-ordered-compatibility-recovery'),
      true,
      'the detach recovery fence must be a principal promotion blocker, not diagnostics only',
    );
    assert.equal(
      reattachedParity.diagnosticBlockers
        .includes('authority-runtime-detached-before-ordered-compatibility-recovery'),
      true,
      'promotion evidence must retain the detach blocker until an ordered wire recovery proves completion',
    );

    const secondSessionId = `${SESSION_ID}-after-destroy`;
    manager.createSession('PH005 post destroy factory fence', 'bash', undefined, { sessionId: secondSessionId });
    const second = managerApi.sessions.get(secondSessionId);
    assert.ok(second);
    assert.equal(second.terminalAuthorityController, undefined);
    assert.equal(second.terminalQueryResponder, undefined);
    manager.deleteSession(secondSessionId);
  } finally {
    manager.deleteSession(SESSION_ID);
    router.destroy();
  }
});

test('MIG-BGSTAB-002 production destroy all-settles runtime map and factory ownership after responder detach failure', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-6');
  const fakePty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => fakePty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
    retainedTerminalShadowEnabled: true,
    retainedTerminalInitialOrdinal: { streamEpoch: '7', sourceSeq: '0' },
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  const router = new wsRouterModule.WsRouter(
    { verifyToken: () => ({ valid: true, payload: { sub: 'authority-test-user', jti: 'authority-test-token' } }) } as never,
    manager,
    { realtime: { wsTransportMode: 'split' } },
  );
  const attachment = productionModule.attachProductionTerminalAuthority({
    sessionManager: manager,
    wsRouter: router,
    transportMode: 'split',
  });
  const managerApi = manager as unknown as SessionManagerAuthorityIntegrationApi;
  const secondSessionId = `${SESSION_ID}-post-failed-destroy`;
  try {
    manager.createSession('PH005 failed production destroy cleanup', 'bash', undefined, { sessionId: SESSION_ID });
    const active = managerApi.sessions.get(SESSION_ID);
    assert.ok(active?.terminalAuthorityController);
    assert.ok(active.terminalQueryResponder);
    const originalDetach = active.terminalQueryResponder.detach.bind(active.terminalQueryResponder);
    active.terminalQueryResponder.detach = () => {
      originalDetach();
      throw new Error('injected-production-responder-detach-failure');
    };

    assert.throws(
      () => attachment.destroy(),
      /terminal-authority-production-integration-destroy-failed/,
    );
    assert.equal(attachment.getAuthorityState(SESSION_ID), undefined, 'disposed runtime map entry must not survive');
    assert.equal(active.terminalAuthorityController, undefined);
    assert.equal(active.terminalQueryResponder, undefined);

    manager.createSession('PH005 post failed destroy factory fence', 'bash', undefined, {
      sessionId: secondSessionId,
    });
    const second = managerApi.sessions.get(secondSessionId);
    assert.ok(second);
    assert.equal(second.terminalAuthorityController, undefined, 'owned factory must clear after all-settled destroy');
    assert.equal(second.terminalQueryResponder, undefined);
  } finally {
    manager.deleteSession(secondSessionId);
    manager.deleteSession(SESSION_ID);
    router.destroy();
  }
});

test('Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-4', async () => {
  const contract = await loadContract('MIG-AC-4');
  const harness = createHarness(contract);
  await promoteAllViews(harness.controller);
  const absent = await harness.controller.recoverView({ connectionId: 'reload-absent', viewGeneration: 1, cacheState: 'absent' });
  const poisoned = await harness.controller.recoverView({ connectionId: 'reload-poisoned', viewGeneration: 2, cacheState: 'poisoned' });
  for (const result of [absent, poisoned]) {
    assert.equal(result.source, 'server-checkpoint');
    assert.equal(result.localCacheUsed, false);
    assert.equal(result.retainedStateHash, 'sha256:configured-retained-range');
    assert.equal(result.checkpointEpoch, '8001');
    assert.equal(result.snapshotSeq, BOUNDARY_SOURCE_SEQ);
    assert.deepEqual(result.postSnapshotOutput, ['tail-42', 'tail-43']);
  }
  assert.deepEqual(absent, poisoned, 'cache state and browser identity cannot alter authoritative recovery bytes');
});

test('Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-5', async () => {
  const contract = await loadContract('MIG-AC-5');
  const harness = createHarness(contract);
  await promoteAllViews(harness.controller);
  harness.events.length = 0;
  const lateQuery = await harness.controller.captureHeadlessOutput({ sourceSeq: '43', data: '\u001b[5n' });
  harness.events.length = 0;
  harness.authorityEffects.length = 0;
  const rollbackTransportStart = getTransportMessagesInPriorityOrder(harness.transport).length;
  assert.equal((await harness.controller.beginRollback(rollbackRequest())).ok, true);
  assert.deepEqual(
    harness.events.map(event => event.type),
    [
      'new-admission-stopped',
      'server-responder-disabled',
      'server-responder-lease-revoked',
      'server-driver-lease-revoked',
      'affected-views-stale',
      'browser-parser-reset-required',
      'old-ack-backlog-purged',
      'fresh-compatibility-checkpoint-enqueued',
    ],
    'rollback must expose the exact reverse authority order before any tail or view drain is admitted',
  );
  assert.equal(harness.events[2]?.responderLeaseId, NEW_RESPONDER_LEASE_ID);
  assert.equal(harness.events[3]?.driverLeaseId, 'driver-server-8');
  assert.deepEqual(harness.authorityEffects, [
    {
      type: 'new-admission-stopped',
      sessionId: SESSION_ID,
      transitionEpoch: '9',
    },
    {
      type: 'server-responder-enabled-set',
      enabled: false,
      responderLeaseId: NEW_RESPONDER_LEASE_ID,
    },
    {
      type: 'server-responder-lease-revoked',
      responderLeaseId: NEW_RESPONDER_LEASE_ID,
    },
    {
      type: 'server-driver-lease-revoked',
      driverLeaseId: 'driver-server-8',
    },
    {
      type: 'affected-view-stale',
      connectionId: VIEW_A.connectionId,
      viewGeneration: VIEW_A.viewGeneration,
    },
    {
      type: 'affected-view-stale',
      connectionId: VIEW_B.connectionId,
      viewGeneration: VIEW_B.viewGeneration,
    },
    {
      type: 'browser-parser-reset',
      connectionId: VIEW_A.connectionId,
      viewGeneration: VIEW_A.viewGeneration,
    },
    {
      type: 'browser-parser-reset',
      connectionId: VIEW_B.connectionId,
      viewGeneration: VIEW_B.viewGeneration,
    },
    {
      type: 'old-ack-backlog-purged',
      sessionId: SESSION_ID,
      transitionEpoch: '9',
    },
  ], 'rollback effect ports must execute in phase order and keep equal-generation views composite-distinct');
  const rollbackCheckpointLane = getTransportMessagesInPriorityOrder(harness.transport)
    .slice(rollbackTransportStart);
  assert.deepEqual(
    rollbackCheckpointLane.map(message => message.type),
    [
      'terminal-authority:rollback-start',
      'terminal-checkpoint:start',
      'terminal-checkpoint:chunk',
      'terminal-checkpoint:commit',
    ],
    'rollback must place a fresh compatibility checkpoint on the terminal lane before held tail output',
  );
  assert.deepEqual(
    rollbackCheckpointLane.slice(1).map(message => JSON.parse(jsonWirePayloadText(message.payload))),
    COMPATIBILITY_CHECKPOINT_MESSAGES,
    'rollback checkpoint mode/source/authority/new stream/snapshot/chunks/digest metadata must be exact',
  );
  assert.deepEqual({
    mode: harness.controller.getState().mode,
    admissionOpen: harness.controller.getState().admissionOpen,
    activeResponder: harness.controller.getState().activeResponder,
    activeResponderLeaseId: harness.controller.getState().activeResponderLeaseId,
    activeDriverLeaseId: harness.controller.getState().activeDriverLeaseId,
    serverResponderEnabled: harness.controller.getState().serverResponderEnabled,
    legacyResponderEnabled: harness.controller.getState().legacyResponderEnabled,
  }, {
    mode: 'rolling-back',
    admissionOpen: 'none',
    activeResponder: null,
    activeResponderLeaseId: null,
    activeDriverLeaseId: null,
    serverResponderEnabled: false,
    legacyResponderEnabled: false,
  });
  assert.equal(harness.controller.getState().legacyResponderEnabled, false);
  const rollbackTail = await harness.controller.captureHeadlessOutput({ sourceSeq: '44', data: '\u001b[5ncompatibility-tail' });
  assert.equal(rollbackTail.deliveryDisposition, 'compatibility-delivered');
  assert.equal(harness.events.at(-1)?.type, 'compatibility-tail-enqueued');
  assert.deepEqual(
    getTransportMessagesInPriorityOrder(harness.transport)
      .slice(rollbackTransportStart)
      .map(message => [message.type, message.outputData]),
    [
      ['terminal-authority:rollback-start', undefined],
      ['terminal-checkpoint:start', undefined],
      ['terminal-checkpoint:chunk', undefined],
      ['terminal-checkpoint:commit', undefined],
      ['output', '\u001b[5ncompatibility-tail'],
    ],
    'compatibility tail must be enqueued immediately after its checkpoint on the same terminal lane before any drain ACK',
  );
  const routeTerminalAuthorityFrame = (
    wsRouterModule as unknown as Partial<WsRouterPromotionContract>
  ).routeTerminalAuthorityFrame;
  assert.equal(typeof routeTerminalAuthorityFrame, 'function', 'WsRouter compatibility lane adapter missing');
  assert.ok(routeTerminalAuthorityFrame);
  const rollbackOutputTransport = createWsTransportQueueState();
  const rollbackControlTransport = createWsTransportQueueState();
  for (const message of getTransportMessagesInPriorityOrder(harness.transport).slice(rollbackTransportStart)) {
    assert.equal(routeTerminalAuthorityFrame({
      mode: 'split',
      controlTransport: rollbackControlTransport,
      outputTransport: rollbackOutputTransport,
      message: JSON.parse(jsonWirePayloadText(message.payload)) as object,
    }).socketRole, 'output');
  }
  assert.deepEqual(
    getTransportMessagesInPriorityOrder(rollbackOutputTransport).map(message => message.type),
    ['terminal-authority:rollback-start', 'terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit', 'output'],
  );
  assert.deepEqual(getTransportMessagesInPriorityOrder(rollbackControlTransport), []);
  assert.equal((await harness.controller.settleQueryEffect({ recordId: lateQuery.recordId, replyOrdinal: 0, reply: '\u001b[0n', streamEpoch: PROMOTED_STREAM_EPOCH, responderLeaseId: NEW_RESPONDER_LEASE_ID })).disposition, 'rejected', 'late old-epoch settlement after rollback must be fenced');
  const queryWritesAtRollback = harness.queryEffects.length;
  const heldRollbackQuery = await harness.controller.settleQueryEffect({
    recordId: rollbackTail.recordId,
    replyOrdinal: 0,
    reply: '\u001b[0n',
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
  });
  assert.equal(
    heldRollbackQuery.disposition,
    'held-for-legacy',
    'a query completed in the rollback silent window must be retained for exactly-one settlement',
  );
  assert.equal(harness.queryEffects.length, queryWritesAtRollback);
  assert.deepEqual(harness.transferredLegacyQueries, []);

  const baseDrain = {
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: '43',
    checkpointEpoch: '9001',
    drainedThroughSourceSeq: '44',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  };
  for (const stale of [
    { ...baseDrain, connectionId: 'peer-connection', viewGeneration: VIEW_A.viewGeneration },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration + 1 },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, transitionEpoch: '8' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, authorityEpoch: 'peer-authority' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, streamEpoch: '10' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, responderLeaseId: 'peer-responder' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, boundarySourceSeq: '42' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, checkpointEpoch: '9002' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, checkpointEpoch: '09001' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, checkpointEpoch: 9001 as unknown as string },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, drainedThroughSourceSeq: '43' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, drainedThroughSourceSeq: '45' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, drainedThroughSourceSeq: '044' },
    { ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration, drainedThroughSourceSeq: '18446744073709551616' },
  ]) {
    assert.equal((await harness.controller.acknowledgeCompatibilityDrain(stale)).accepted, false);
  }
  assert.deepEqual(
    await harness.controller.acknowledgeCompatibilityDrain({
      ...baseDrain,
      connectionId: VIEW_A.connectionId,
      viewGeneration: VIEW_A.viewGeneration,
    }),
    { accepted: false, completed: false, reason: 'compatibility-tail-not-physically-drained' },
    'a syntactically valid ACK cannot claim a tail that the target view has not physically drained',
  );
  assert.deepEqual(
    await harness.controller.acknowledgeCompatibilityDrain({
      ...baseDrain,
      connectionId: VIEW_B.connectionId,
      viewGeneration: VIEW_B.viewGeneration,
    }),
    { accepted: false, completed: false, reason: 'compatibility-tail-not-physically-drained' },
    'equal viewGeneration on another connection must have an independent physical-drain proof',
  );
  harness.compatibilityPhysicalDrains.add(compatibilityDrainKey({
    ...baseDrain,
    connectionId: VIEW_A.connectionId,
    viewGeneration: VIEW_A.viewGeneration,
  }));
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain({ ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration }), { accepted: true, completed: false });
  assert.equal(harness.events.at(-1)?.type, 'compatibility-view-drained');
  assert.equal(harness.events.at(-1)?.connectionId, VIEW_A.connectionId);
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain({ ...baseDrain, connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration }), { accepted: true, duplicate: true, completed: false });
  assert.equal(harness.controller.getState().legacyResponderEnabled, false);
  assert.equal(getTransportMessagesInPriorityOrder(harness.transport).length, rollbackTransportStart + 5);
  assert.deepEqual(harness.transferredLegacyQueries, []);
  assert.equal(
    harness.authorityEffects.some(effect => effect.type.startsWith('compatibility-')),
    false,
    'one drained view cannot rebind either compatibility lease',
  );
  harness.compatibilityPhysicalDrains.add(compatibilityDrainKey({
    ...baseDrain,
    connectionId: VIEW_B.connectionId,
    viewGeneration: VIEW_B.viewGeneration,
  }));
  assert.deepEqual(await harness.controller.acknowledgeCompatibilityDrain({ ...baseDrain, connectionId: VIEW_B.connectionId, viewGeneration: VIEW_B.viewGeneration }), { accepted: true, completed: true });
  assert.deepEqual(
    harness.events.slice(-2).map(event => [event.type, event.connectionId ?? null]),
    [
      ['compatibility-view-drained', VIEW_B.connectionId],
      ['legacy-responder-enabled', null],
    ],
  );
  assert.equal(harness.events.at(-1)?.type, 'legacy-responder-enabled');
  assert.equal(harness.controller.getState().legacyResponderEnabled, true);
  assert.equal(harness.controller.getState().activeResponder, 'legacy-browser');
  assert.equal(harness.controller.getState().activeResponderLeaseId, COMPATIBILITY_RESPONDER_LEASE_ID);
  assert.equal(harness.controller.getState().activeDriverLeaseId, COMPATIBILITY_DRIVER_LEASE_ID);
  assert.deepEqual(harness.authorityEffects.slice(-2), [
    {
      type: 'compatibility-driver-lease-rebound',
      driverLeaseId: COMPATIBILITY_DRIVER_LEASE_ID,
      viewGeneration: VIEW_A.viewGeneration,
      leaseGeneration: '9',
    },
    {
      type: 'compatibility-responder-lease-rebound',
      responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    },
  ], 'legacy enable is preceded by explicit compatibility driver/reply lease rebinding');
  const expectedLegacyEnableFrames = [VIEW_A].map(view => ({
    type: 'terminal-authority:legacy-responder-enabled',
    source: 'server-controller',
    sessionId: SESSION_ID,
    connectionId: view.connectionId,
    viewGeneration: view.viewGeneration,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    driverLeaseId: COMPATIBILITY_DRIVER_LEASE_ID,
    queryReplyCapability: view.queryReplyCapability,
    parserResponderCapability: view.parserResponderCapability,
    driverLeaseGeneration: '9',
    acceptedViewAttributesGeneration: '9',
    boundarySourceSeq: COMPATIBILITY_SNAPSHOT_SEQ,
    checkpointEpoch: '9001',
    snapshotSeq: COMPATIBILITY_SNAPSHOT_SEQ,
    drainedThroughSourceSeq: COMPATIBILITY_TAIL_SOURCE_SEQ,
    checkpointApplied: true,
    postSnapshotTailDrained: true,
    affectedViewCount: 2,
  }));
  const { type: _type, source: _source, ...expectedCommittedLegacyIdentity } = expectedLegacyEnableFrames[0];
  assert.deepEqual(
    harness.committedLegacyIdentities.at(-1),
    expectedCommittedLegacyIdentity,
    'topology rebind state must retain the same full checkpoint and drain proof as the selected legacy frame',
  );
  const finalRollbackLane = getTransportMessagesInPriorityOrder(harness.transport)
    .slice(rollbackTransportStart);
  assert.deepEqual(
    finalRollbackLane.map(message => [message.type, message.outputData]),
    [
      ['terminal-authority:rollback-start', undefined],
      ['terminal-checkpoint:start', undefined],
      ['terminal-checkpoint:chunk', undefined],
      ['terminal-checkpoint:commit', undefined],
      ['output', '\u001b[5ncompatibility-tail'],
      ['terminal-authority:legacy-responder-enabled', undefined],
    ],
    'all-view drain enables only the selected legacy responder after checkpoint and tail physically drain',
  );
  assert.deepEqual(
    finalRollbackLane.slice(-1).map(message => JSON.parse(jsonWirePayloadText(message.payload))),
    expectedLegacyEnableFrames,
    'only the selected responder/driver view receives a full-identity legacy-responder-enabled frame',
  );
  assert.equal(
    finalRollbackLane.some(message => {
      if (message.type !== 'terminal-authority:legacy-responder-enabled') return false;
      const frame = JSON.parse(jsonWirePayloadText(message.payload)) as { connectionId?: string };
      return frame.connectionId === VIEW_B.connectionId;
    }),
    false,
    'the drained peer view remains parser-disabled and cannot become a second query authority',
  );
  assert.deepEqual(harness.transferredLegacyQueries, [{
    effectKey: heldRollbackQuery.effectKey,
    sourceSeq: COMPATIBILITY_TAIL_SOURCE_SEQ,
    reply: '\u001b[0n',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
  }], 'silent-window query transfers to the single rebound legacy responder exactly once after enable');
  assert.equal((await harness.controller.settleQueryEffect({
    recordId: rollbackTail.recordId,
    replyOrdinal: 0,
    reply: '\u001b[0n',
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
  })).disposition, 'duplicate');
  assert.equal(harness.transferredLegacyQueries.length, 1, 'duplicate settlement cannot duplicate the transferred reply');

  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const runProductionRollback = async (mode: 'unified' | 'split'): Promise<void> => {
    const rollbackPty = new AuthorityIntegrationFakePty();
    const integration = createProductionIntegrationFixture(productionModule, mode, rollbackPty, {
      retainedTerminalInitialOrdinal: { streamEpoch: PROMOTED_STREAM_EPOCH, sourceSeq: '42' },
    });
    const manager = integration.sessionManager;
    const managerApi = manager as unknown as SessionManagerAuthorityIntegrationApi;
    (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
    try {
      manager.createSession(`PH005 production rollback ${mode}`, 'bash', undefined, { sessionId: SESSION_ID });
      const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
      const selectedView = await connectProductionView(router, mode, 11);
      const peerView = await connectProductionView(router, mode, 11);
      const session = managerApi.sessions.get(SESSION_ID);
      assert.ok(session);
      rollbackPty.emitData('actual-retained-marker');
      await session.headlessWriteChain;

      const promotion = await integration.beginPromotion(SESSION_ID);
      assert.equal(promotion.ok, true);
      const promotionBoundary = selectedView.output.sentFrames.find(frame => (
        frame.type === 'terminal-authority:responder-disable-boundary'
      ));
      assert.ok(promotionBoundary);
      const frozenViews = promotionBoundary.requiredResponderViews as Array<Record<string, unknown>>;
      for (const view of [selectedView, peerView]) {
        const frozen = frozenViews.find(candidate => candidate.connectionId === view.connectionId);
        assert.ok(frozen);
        assertFrozenNegotiatedIdentity(view, frozen);
        emitClientFrame(view.control, {
          type: 'terminal-authority:responder-disabled',
          ...frozen,
          sessionId: promotionBoundary.sessionId,
          transitionEpoch: promotionBoundary.transitionEpoch,
          authorityEpoch: promotionBoundary.authorityEpoch,
          streamEpoch: promotionBoundary.streamEpoch,
          boundarySourceSeq: promotionBoundary.boundarySourceSeq,
          responderLeaseId: promotionBoundary.responderLeaseId,
        });
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');
      const controlRollbackFrameStart = new Map([
        [selectedView.connectionId, selectedView.control.sentFrames.length],
        [peerView.connectionId, peerView.control.sentFrames.length],
      ]);
      const outputRollbackFrameStart = new Map([
        [selectedView.connectionId, selectedView.output.sentFrames.length],
        [peerView.connectionId, peerView.output.sentFrames.length],
      ]);
      assert.equal((await integration.beginRollback({
        sessionId: SESSION_ID,
        selectedCompatibilityView: {
          connectionId: selectedView.connectionId,
          viewGeneration: selectedView.viewGeneration,
        },
      })).ok, true);
      rollbackPty.emitData('\u001b[5ncompatibility-tail');
      await session.headlessWriteChain;

      const terminalFramesFor = (view: ProductionConnectedView) => view.output.sentFrames;
      const checkpointPartsFor = (view: ProductionConnectedView) => terminalFramesFor(view).filter(frame => (
        String(frame.type).startsWith('terminal-checkpoint:')
        && frame.mode === 'compatibility'
      ));
      for (const view of [selectedView, peerView]) {
        const checkpointParts = checkpointPartsFor(view);
        const start = checkpointParts.find(frame => frame.type === 'terminal-checkpoint:start');
        const chunks = checkpointParts
          .filter(frame => frame.type === 'terminal-checkpoint:chunk')
          .sort((left, right) => Number(left.chunkIndex) - Number(right.chunkIndex));
        const commit = checkpointParts.find(frame => frame.type === 'terminal-checkpoint:commit');
        const checkpointBody = Buffer.concat(chunks.map(frame => (
          Buffer.from(String(frame.data ?? ''), 'base64')
        ))).toString('utf8');
        assert.ok(start);
        assert.ok(commit);
        assert.match(checkpointBody, /actual-retained-marker/u);
        const digestHex = createHash('sha256').update(checkpointBody, 'utf8').digest('hex');
        assert.deepEqual(start.digest, { algorithm: 'sha256', hex: digestHex });
        assert.deepEqual(commit.digest, { algorithm: 'sha256', hex: digestHex });
        assert.equal(commit.encodedByteTotal, Buffer.byteLength(checkpointBody, 'utf8'));
        if (mode === 'split') {
          assert.equal(view.control.sentFrames.some(frame => (
            String(frame.type).startsWith('terminal-checkpoint:')
            && frame.mode === 'compatibility'
          )), false, 'split checkpoint bytes must never enter the control socket');
          assert.equal(view.control.sentFrames.some(frame => (
            frame.type === 'terminal-checkpoint:output'
            && Buffer.from(String(frame.data), 'base64').toString('utf8').endsWith('compatibility-tail')
          )), false, 'split compatibility tail must never enter the control socket');
        } else {
          assert.equal(view.output, view.control, 'unified mode must use the same physical socket in both roles');
        }
      }

      const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID);
      assert.ok(retained);
      const rollbackStart = terminalFramesFor(selectedView)
        .slice(outputRollbackFrameStart.get(selectedView.connectionId))
        .find(frame => frame.type === 'terminal-authority:rollback-start');
      const checkpointStart = checkpointPartsFor(selectedView).find(frame => frame.type === 'terminal-checkpoint:start');
      const tail = terminalFramesFor(selectedView).find(frame => (
        frame.type === 'terminal-checkpoint:output'
        && Buffer.from(String(frame.data), 'base64').toString('utf8').endsWith('compatibility-tail')
      ));
      assert.ok(rollbackStart);
      assert.ok(checkpointStart);
      assert.ok(tail);
      for (const checkpointFrame of checkpointPartsFor(selectedView)) {
        assert.equal(
          checkpointFrame.responderLeaseId,
          rollbackStart.responderLeaseId,
          'compatibility checkpoint frames must retain the rollback responder lease identity',
        );
        assert.equal(
          checkpointFrame.boundarySourceSeq,
          rollbackStart.boundarySourceSeq,
          'compatibility checkpoint frames must retain the rollback source boundary identity',
        );
      }
      const checkpointAckIdentity = (view: ProductionConnectedView) => ({
        protocolVersion: checkpointStart.protocolVersion,
        sessionId: SESSION_ID,
        viewGeneration: view.viewGeneration,
        streamEpoch: checkpointStart.streamEpoch,
        checkpointEpoch: checkpointStart.checkpointEpoch,
        sourceSeq: checkpointStart.sourceSeq,
        snapshotSeq: checkpointStart.snapshotSeq,
        oldestRetainedSeq: retained.oldestRetainedSeq,
        retentionPolicyId: retained.retentionPolicy.retentionPolicyId,
        connectionId: view.connectionId,
        transitionEpoch: rollbackStart.transitionEpoch,
        authorityEpoch: rollbackStart.authorityEpoch,
        responderLeaseId: rollbackStart.responderLeaseId,
        boundarySourceSeq: rollbackStart.boundarySourceSeq,
      });
      const compatibilityDrain = (view: ProductionConnectedView) => ({
        type: 'terminal-authority:compatibility-drained',
        sessionId: SESSION_ID,
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
        transitionEpoch: rollbackStart.transitionEpoch,
        authorityEpoch: rollbackStart.authorityEpoch,
        streamEpoch: checkpointStart.streamEpoch,
        responderLeaseId: rollbackStart.responderLeaseId,
        boundarySourceSeq: rollbackStart.boundarySourceSeq,
        checkpointEpoch: checkpointStart.checkpointEpoch,
        drainedThroughSourceSeq: tail.sourceSeq,
        checkpointApplied: true,
        postSnapshotTailDrained: true,
      });
      emitClientFrame(selectedView.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...checkpointAckIdentity(selectedView),
        responderLeaseId: `${rollbackStart.responderLeaseId}-stale`,
        appliedThroughSeq: checkpointStart.snapshotSeq,
      });
      emitClientFrame(selectedView.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...checkpointAckIdentity(selectedView),
        drainedThroughSeq: tail.sourceSeq,
      });
      emitClientFrame(selectedView.control, compatibilityDrain(selectedView));
      await new Promise<void>(resolve => setImmediate(resolve));
      const staleApplyRejection = [...selectedView.control.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-checkpoint:rejected'
          && frame.phase === 'ack'
          && frame.reason === 'invalid-message'
          && frame.sessionId === SESSION_ID
      ));
      assert.ok(staleApplyRejection, 'a stale responder lease apply ACK must be rejected');
      assert.deepEqual(staleApplyRejection.ackIdentity, {
        sessionId: SESSION_ID,
        connectionId: selectedView.connectionId,
        viewGeneration: selectedView.viewGeneration,
        streamEpoch: checkpointStart.streamEpoch,
        checkpointEpoch: checkpointStart.checkpointEpoch,
      });
      assert.equal([...selectedView.control.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-authority:compatibility-drain-accepted'
          && frame.connectionId === selectedView.connectionId
      ))?.accepted, false, 'a rejected apply ACK must not latch physical drain evidence');

      emitClientFrame(selectedView.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...checkpointAckIdentity(selectedView),
        appliedThroughSeq: checkpointStart.snapshotSeq,
      });
      emitClientFrame(selectedView.control, compatibilityDrain(selectedView));
      assert.equal(terminalFramesFor(selectedView).some(frame => frame.type === 'terminal-authority:legacy-responder-enabled'), false);

      emitClientFrame(peerView.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...checkpointAckIdentity(peerView),
        appliedThroughSeq: checkpointStart.snapshotSeq,
      });
      emitClientFrame(peerView.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...checkpointAckIdentity(peerView),
        boundarySourceSeq: String(BigInt(String(rollbackStart.boundarySourceSeq)) + 1n),
        drainedThroughSeq: tail.sourceSeq,
      });
      emitClientFrame(peerView.control, compatibilityDrain(peerView));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(peerView.control.sentFrames.some(frame => (
        frame.type === 'terminal-checkpoint:rejected'
          && frame.phase === 'ack'
          && frame.reason === 'invalid-message'
          && frame.sessionId === SESSION_ID
      )), true, 'a stale boundary drain ACK must be rejected');
      assert.equal([...peerView.control.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-authority:compatibility-drain-accepted'
          && frame.connectionId === peerView.connectionId
      ))?.accepted, false, 'a rejected drain ACK must not latch physical drain evidence');

      emitClientFrame(peerView.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...checkpointAckIdentity(peerView),
        drainedThroughSeq: tail.sourceSeq,
      });
      emitClientFrame(peerView.control, compatibilityDrain(peerView));
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const view of [selectedView, peerView]) {
        const receipt = [...view.control.sentFrames].reverse().find(frame => (
          frame.type === 'terminal-authority:compatibility-drain-accepted'
          && frame.connectionId === view.connectionId
        ));
        assert.ok(receipt, 'compatibility drain ACK must return a typed acceptance receipt on control');
        assert.equal(receipt.accepted, true);
      }
      const selectedEnable = selectedView.control.sentFrames
        .slice(controlRollbackFrameStart.get(selectedView.connectionId))
        .find(frame => (
        frame.type === 'terminal-authority:legacy-responder-enabled'
      ));
      assert.ok(selectedEnable);
      assert.equal(peerView.control.sentFrames
        .slice(controlRollbackFrameStart.get(peerView.connectionId))
        .some(frame => frame.type === 'terminal-authority:legacy-responder-enabled'), false);
      await new Promise<void>(resolve => setImmediate(resolve));
      const assertControlRecoveryOrder = (
        view: ProductionConnectedView,
        expectedRole: 'selected-responder' | 'passive-snapshot',
      ): void => {
        const recoveryFrames = view.control.sentFrames.slice(controlRollbackFrameStart.get(view.connectionId));
        const legacyCapabilityIndex = recoveryFrames.findIndex(frame => (
          frame.type === 'terminal-checkpoint:capability'
            && frame.authorityMode === 'legacy'
            && frame.compatibilityRecoveryRole === expectedRole
        ));
        const enabledIndex = recoveryFrames.findIndex(frame => (
          frame.type === 'terminal-authority:legacy-responder-enabled'
        ));
        const snapshotIndex = recoveryFrames.findIndex((frame, index) => (
          index > legacyCapabilityIndex
            && frame.type === 'screen-snapshot'
            && frame.sessionId === SESSION_ID
        ));
        assert.ok(legacyCapabilityIndex >= 0, 'rollback must put legacy capability on the physical control socket');
        assert.ok(snapshotIndex > legacyCapabilityIndex, 'fresh recovery snapshot must follow legacy capability on the same control FIFO');
        if (expectedRole === 'selected-responder') {
          assert.ok(enabledIndex > legacyCapabilityIndex, 'selected responder enable must follow its legacy capability');
          assert.ok(snapshotIndex > enabledIndex, 'selected responder snapshot must follow physical enable settlement');
        } else {
          assert.equal(enabledIndex, -1, 'passive peer must never gain parser responder authority');
        }
      };
      assertControlRecoveryOrder(selectedView, 'selected-responder');
      assertControlRecoveryOrder(peerView, 'passive-snapshot');
      assert.equal(
        rollbackPty.writes.filter(write => write === '\u001b[0n').length,
        1,
        'the rollback-silent query must reach the exact rebound compatibility responder once',
      );
      assert.equal(
        integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
          event.type === 'held-query-transferred-to-legacy'
        )).length,
        1,
        'held query transfer must be committed exactly once',
      );
      assert.equal(
        integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
          event.type === 'compatibility-tail-physically-drained'
          && event.lane === (mode === 'split' ? 'output' : 'unified')
        )).length,
        2,
        'both composite views need physical terminal-lane drain proof before selected enable',
      );

      const selectionIdentity = {
        sessionId: selectedEnable.sessionId,
        connectionId: selectedEnable.connectionId,
        viewGeneration: selectedEnable.viewGeneration,
        transitionEpoch: selectedEnable.transitionEpoch,
        authorityEpoch: selectedEnable.authorityEpoch,
        streamEpoch: selectedEnable.streamEpoch,
        responderLeaseId: selectedEnable.responderLeaseId,
        boundarySourceSeq: selectedEnable.boundarySourceSeq,
        checkpointEpoch: selectedEnable.checkpointEpoch,
        drainedThroughSourceSeq: selectedEnable.drainedThroughSourceSeq,
        checkpointApplied: selectedEnable.checkpointApplied,
        postSnapshotTailDrained: selectedEnable.postSnapshotTailDrained,
        driverLeaseId: selectedEnable.driverLeaseId,
        driverLeaseGeneration: selectedEnable.driverLeaseGeneration,
        acceptedViewAttributesGeneration: selectedEnable.acceptedViewAttributesGeneration,
        queryReplyCapability: selectedEnable.queryReplyCapability,
        parserResponderCapability: selectedEnable.parserResponderCapability,
        snapshotSeq: selectedEnable.snapshotSeq,
      };
      emitClientFrame(selectedView.control, {
        type: 'input',
        inputKind: 'query-reply',
        sessionId: SESSION_ID,
        responderIdentity: { ...selectionIdentity, driverLeaseGeneration: '8' },
        replyOrdinal: 0,
        data: '\u001b[0n',
      });
      assert.equal(
        rollbackPty.writes.filter(write => write === '\u001b[0n').length,
        1,
        'stale driver lease cannot add a PTY effect after the held transfer',
      );

      rollbackPty.emitData('\u001b[5n');
      await new Promise<void>(resolve => setImmediate(resolve));
      await session.headlessWriteChain;
      for (const view of [selectedView, peerView]) {
        assert.equal(terminalFramesFor(view).some(frame => (
          (frame.type === 'terminal-checkpoint:output' || frame.type === 'output')
          && typeof frame.data === 'string'
          && (frame.type === 'terminal-checkpoint:output'
            ? Buffer.from(frame.data, 'base64').toString('utf8')
            : frame.data).includes('\u001b[5n')
        )), true, 'query bytes remain broadcast output even though reply authority is singular');
      }
      emitClientFrame(selectedView.control, {
        type: 'input',
        inputKind: 'query-reply',
        sessionId: SESSION_ID,
        responderIdentity: selectionIdentity,
        replyOrdinal: 0,
        data: '\u001b[0n',
      });
      assert.equal(rollbackPty.writes.filter(write => write === '\u001b[0n').length, 2);
      assert.equal(selectedView.control.sentFrames.filter(frame => frame.type === 'terminal-authority:query-reply-accepted').length, 1);
      assert.equal(peerView.control.sentFrames.filter(frame => frame.type === 'terminal-authority:query-reply-accepted').length, 0);
      if (mode === 'split') {
        assert.equal(selectedView.output.sentFrames.some(frame => frame.type === 'terminal-authority:query-reply-accepted'), false);
      }
      assertProductionDefaultWiring(integration, 2);
    } finally {
      integration.destroy();
    }
  };
  await runProductionRollback('split');
  await runProductionRollback('unified');
  await verifyRollbackReregistersRouterProvenCompatibilityView();
});

test('MIG-BGSTAB-002 rollback query hold ledger fails closed at the configured chunk bound', async () => {
  const contract = await loadContract('MIG-AC-5');
  const harness = createHarness(contract);
  harness.safetyLimits.maxHeldOutputChunks = 2;
  await promoteAllViews(harness.controller);
  assert.equal((await harness.controller.beginRollback(rollbackRequest())).ok, true);

  const dispositions: string[] = [];
  for (const [index, sourceSeq] of ['44', '45', '46'].entries()) {
    const output = await harness.controller.captureHeadlessOutput({
      sourceSeq,
      data: `\u001b[${index + 5}n`,
    });
    dispositions.push((await harness.controller.settleQueryEffect({
      recordId: output.recordId,
      replyOrdinal: 0,
      reply: `\u001b[${index}n`,
      streamEpoch: '9',
      responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    })).disposition);
  }

  assert.deepEqual(dispositions, ['held-for-legacy', 'held-for-legacy', 'rejected']);
  assert.equal(
    harness.recoveryReasons.includes('compatibility-query-hold-overflow'),
    true,
    'overflow must enter an explicit fresh compatibility recovery instead of growing an unbounded ledger',
  );
});

test('MIG-BGSTAB-002 failed compatibility query transfer keeps rollback retryable and uncommitted', async () => {
  const contract = await loadContract('MIG-AC-5');
  const harness = createHarness(contract);
  await promoteAllViews(harness.controller);
  assert.equal((await harness.controller.beginRollback(rollbackRequest())).ok, true);
  const output = await harness.controller.captureHeadlessOutput({
    sourceSeq: '44',
    data: '\u001b[5ncompatibility-tail',
  });
  assert.equal((await harness.controller.settleQueryEffect({
    recordId: output.recordId,
    replyOrdinal: 0,
    reply: '\u001b[0n',
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
  })).disposition, 'held-for-legacy');

  const drain = (view: ResponderViewIdentity) => ({
    connectionId: view.connectionId,
    viewGeneration: view.viewGeneration,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: BOUNDARY_SOURCE_SEQ,
    checkpointEpoch: '9001',
    drainedThroughSourceSeq: '44',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  });
  const firstDrain = drain(VIEW_A);
  const finalDrain = drain(VIEW_B);
  harness.compatibilityPhysicalDrains.add(compatibilityDrainKey(firstDrain));
  harness.compatibilityPhysicalDrains.add(compatibilityDrainKey(finalDrain));
  assert.deepEqual(
    await harness.controller.acknowledgeCompatibilityDrain(firstDrain),
    { accepted: true, completed: false },
  );

  harness.throwLegacyQueryTransfer = true;
  assert.deepEqual(
    await harness.controller.acknowledgeCompatibilityDrain(finalDrain),
    { accepted: false, completed: false, reason: 'compatibility-query-transfer-failed' },
  );
  assert.equal(harness.controller.getState().mode, 'rolling-back');
  assert.deepEqual(harness.transferredLegacyQueries, []);
  assert.deepEqual(harness.committedLegacyIdentities, []);

  assert.equal(
    harness.recoveryReasons.includes('compatibility-query-transfer-failed'),
    true,
    'the untransferred effect must move into a fresh ordered compatibility recovery',
  );
});

test('MIG-BGSTAB-002 AC-5 locks the first proven compatibility drain target while PTY output continues', async () => {
  const contract = await loadContract('MIG-AC-5');
  const harness = createHarness(contract);
  await promoteAllViews(harness.controller);
  assert.equal((await harness.controller.beginRollback(rollbackRequest())).ok, true);

  await harness.controller.captureHeadlessOutput({ sourceSeq: '44', data: 'compatibility-tail-44' });
  const drainAt = (view: ResponderViewIdentity, drainedThroughSourceSeq: string) => ({
    connectionId: view.connectionId,
    viewGeneration: view.viewGeneration,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: BOUNDARY_SOURCE_SEQ,
    checkpointEpoch: '9001',
    drainedThroughSourceSeq,
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  });
  const firstDrain = drainAt(VIEW_A, '44');
  harness.compatibilityPhysicalDrains.add(compatibilityDrainKey(firstDrain));
  assert.deepEqual(
    await harness.controller.acknowledgeCompatibilityDrain(firstDrain),
    { accepted: true, completed: false },
  );

  await harness.controller.captureHeadlessOutput({ sourceSeq: '45', data: 'compatibility-tail-45' });
  const secondDrain = drainAt(VIEW_B, '45');
  harness.compatibilityPhysicalDrains.add(compatibilityDrainKey(secondDrain));
  assert.deepEqual(
    await harness.controller.acknowledgeCompatibilityDrain(secondDrain),
    { accepted: true, completed: true },
    'a later cumulative drain must complete the frozen all-view quorum without erasing the first proof',
  );
  assert.equal(harness.controller.getState().mode, 'legacy');
});

test('MIG-BGSTAB-002 legacy compatibility responder identity rebinds to a replacement view', async () => {
  const contract = await loadContract('MIG-AC-5');
  const harness = createHarness(contract);
  await promoteAllViews(harness.controller);
  assert.equal((await harness.controller.beginRollback(rollbackRequest())).ok, true);
  await harness.controller.captureHeadlessOutput({ sourceSeq: '44', data: 'replacement-view-tail' });
  const drain = (view: ResponderViewIdentity) => ({
    connectionId: view.connectionId,
    viewGeneration: view.viewGeneration,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    boundarySourceSeq: BOUNDARY_SOURCE_SEQ,
    checkpointEpoch: '9001',
    drainedThroughSourceSeq: '44',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  });
  for (const view of [VIEW_A, VIEW_B]) {
    const evidence = drain(view);
    harness.compatibilityPhysicalDrains.add(compatibilityDrainKey(evidence));
    await harness.controller.acknowledgeCompatibilityDrain(evidence);
  }
  assert.equal(harness.controller.getState().mode, 'legacy');

  const replacementView = {
    ...VIEW_A,
    connectionId: 'connection-replacement',
    viewGeneration: VIEW_A.viewGeneration + 1,
    responderLeaseId: COMPATIBILITY_RESPONDER_LEASE_ID,
    driverLeaseGeneration: '10',
    acceptedViewAttributesGeneration: '10',
  };
  const controllerWithRebind = harness.controller as TerminalAuthorityController & {
    replaceLegacyCompatibilityResponderView?: (
      view: ResponderViewIdentity,
    ) => { ok: boolean; reason?: string };
  };
  assert.equal(
    typeof controllerWithRebind.replaceLegacyCompatibilityResponderView,
    'function',
    'legacy reconnect must expose a controller-owned responder identity rebind',
  );
  const rebound = controllerWithRebind.replaceLegacyCompatibilityResponderView!(replacementView);
  assert.deepEqual(rebound, { ok: true });

  const legacyIdentity = {
    ...replacementView,
    sessionId: SESSION_ID,
    transitionEpoch: '9',
    authorityEpoch: AUTHORITY_EPOCH,
    streamEpoch: '9',
    boundarySourceSeq: COMPATIBILITY_SNAPSHOT_SEQ,
  };
  assert.equal((await harness.controller.acceptLegacyBrowserQueryReply({
    ...legacyIdentity,
    replyOrdinal: 0,
    reply: '\u001b[0n',
  })).accepted, true);
  assert.equal((await harness.controller.acceptLegacyBrowserQueryReply({
    ...legacyIdentity,
    connectionId: VIEW_A.connectionId,
    viewGeneration: VIEW_A.viewGeneration,
    replyOrdinal: 1,
    reply: '\u001b[0n',
  })).accepted, false);
});

test('MIG-BGSTAB-002 legacy output with no authority-capable view does not enter an epochless rollback', async () => {
  const productionModule = await loadProductionIntegration('MIG-AC-5');
  const pty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'unified', pty);
  const manager = integration.sessionManager;
  const managerApi = manager as unknown as SessionManagerAuthorityIntegrationApi;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('PH005 no-view legacy output', 'bash', undefined, { sessionId: SESSION_ID });
    const session = managerApi.sessions.get(SESSION_ID);
    assert.ok(session);
    pty.emitData('no-view-bootstrap-output');
    await session.headlessWriteChain;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(
      {
        mode: integration.getAuthorityState(SESSION_ID)?.mode,
        transitionEpoch: integration.getAuthorityState(SESSION_ID)?.transitionEpoch,
        frozenRequiredResponderCount: integration.getAuthorityState(SESSION_ID)?.frozenRequiredResponderCount,
      },
      {
        mode: 'legacy',
        transitionEpoch: null,
        frozenRequiredResponderCount: 0,
      },
      'restored/background sessions must remain promotable while no browser authority view is attached',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('MIG-BGSTAB-002 delayed Ctrl+C clear-line › prompt repaint stays idle when foreground detection is stale', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 delayed prompt repaint', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('\x1b[2K\r› ');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed local AI-TUI-style prompt repaint after Ctrl+C must not be classified as heuristic non-AI output when foreground detection is stale',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed Ctrl+C semantic output remains running when foreground detection is stale', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 delayed semantic output', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('Running command');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a delayed semantic output after Ctrl+C must remain observable even when foreground detection is stale',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed local-input cursor visibility repaint stays idle when foreground detection is stale', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 delayed cursor visibility repaint', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'PH005-PTY-CONTINUES-LOCAL-DRAFT'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('\x1b[?25l');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed cursor-hide repaint after unsent local input must not be classified as heuristic non-AI output when foreground detection is stale',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed local-input semantic output remains running when foreground detection is stale', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 delayed local-input semantic output', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'PH005-PTY-CONTINUES-LOCAL-DRAFT'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('Running command');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a delayed semantic output after unsent local input must remain observable when foreground detection is stale',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed ANSI-colored local echo stays idle after the pending input buffer is cleared', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-LOCAL-DRAFT';
    manager.createSession('PH005 delayed ANSI local echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed ANSI-colored echo matching the last unsubmitted local draft must not be classified as heuristic non-AI output after a prompt redraw clears inputBuffer',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed ANSI-colored local echo stays idle after the debug correlation window expires', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-LOCAL-DRAFT';
    manager.createSession('PH005 delayed ANSI local echo beyond correlation window', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 510));

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a matching local echo must remain idle until its local draft is replaced, submitted, cancelled, or contradicted by semantic output',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 semantic output clears delayed local-echo correlation', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ idleDelayMs: 10 });

  try {
    const localDraft = 'PH005-PTY-CONTINUES-LOCAL-DRAFT';
    manager.createSession('PH005 semantic output clears delayed ANSI local echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('\x1b[93mRunning command\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a matching-looking output after semantic terminal activity must remain observable instead of reviving stale local-echo correlation',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 replacement local input invalidates the prior delayed local-echo correlation', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const staleDraft = 'PH005-PTY-CONTINUES-STALE-DRAFT';
    manager.createSession('PH005 replacement local input invalidates ANSI echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, staleDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    assert.equal(manager.writeInput(SESSION_ID, 'PH005-PTY-CONTINUES-REPLACEMENT-DRAFT'), true);
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`\x1b[93m${staleDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a delayed echo matching a superseded local draft must not suppress terminal activity after replacement input',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C settles one already-pending delayed local echo before later semantic output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const pendingDraft = 'PH005-PTY-CONTINUES-INTERRUPTED-DRAFT';
    manager.createSession('PH005 Ctrl+C settles one pending ANSI echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, pendingDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`\x1b[93m${pendingDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'Ctrl+C must retain exactly one already-pending local echo long enough to settle its delayed PTY repaint',
    );

    pty.emitData('terminal completed work');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'the one-shot interrupted-draft echo allowance must be consumed before later semantic terminal output',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Enter clears delayed local-echo correlation', () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 Enter invalidates ANSI echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'PH005-PTY-CONTINUES-SUBMITTED-DRAFT'), true);
    assert.equal(manager.writeInput(SESSION_ID, '\r'), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { echoTracker: { lastUnsubmittedPrintableInput?: unknown } }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(
      sessionData.echoTracker.lastUnsubmittedPrintableInput,
      undefined,
      'Enter must clear the delayed local-echo correlation before command output is classified',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed ANSI echo of a backspace-edited local draft stays idle after a prompt redraw', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const preEditDraft = 'PH005-PTY-CONTINUES-EDITED-DRAFTX';
    const editedDraft = preEditDraft.slice(0, -1);
    manager.createSession('PH005 backspace-edited ANSI echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, preEditDraft), true);
    assert.equal(manager.writeInput(SESSION_ID, '\x7f'), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.inputBuffer, editedDraft, 'backspace must edit the local draft before redraw');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 510));

    pty.emitData(`\x1b[93m${editedDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed echo of the backspace-edited local draft must remain idle after prompt redraw clears inputBuffer',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed ANSI echo of a superseded pre-edit draft remains running', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const preEditDraft = 'PH005-PTY-CONTINUES-EDITED-DRAFTX';
    manager.createSession('PH005 stale pre-edit ANSI echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, preEditDraft), true);
    assert.equal(manager.writeInput(SESSION_ID, '\x7f'), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 510));

    pty.emitData(`\x1b[93m${preEditDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a delayed echo of the superseded pre-edit draft must remain observable after the local edit',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 semantic output before a prompt-prefixed local draft remains running', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-LOCAL-DRAFT';
    manager.createSession('PH005 semantic line before local redraw', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`completed work\r\n› ${localDraft}`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a substantive preceding line must not be flattened into a prompt-prefixed local echo',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C prompt-return suppression is consumed before later semantic prompt output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 Ctrl+C prompt-return consumption', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('\x1b[2K\r› ');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('completed work\r\nuser@host:~$');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a later semantic output ending in a shell prompt must not reuse the consumed Ctrl+C repaint allowance',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed Ctrl+C clear-line and cursor repaint stays idle when foreground detection is stale', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 delayed Ctrl+C clear-line cursor repaint', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('\x1b[2K\r\x1b[?25h› ');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a clear-line/cursor/prompt control-only repaint after Ctrl+C must not be classified as semantic terminal output',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 PowerShell redraw retains the unsubmitted draft for later Codex detection', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    const localDraft = 'codex';
    manager.createSession('PH005 PowerShell redraw lifecycle', 'powershell', cwd, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`PS ${cwd}>${localDraft}`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        inputBuffer: string;
        lastSubmittedCommand?: string;
        pendingForegroundAppHint?: string;
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(
      sessionData.inputBuffer,
      localDraft,
      'a PowerShell redraw that includes the pending draft must not discard the user input buffer',
    );
    assert.equal(manager.writeInput(SESSION_ID, '\r'), true);
    assert.equal(sessionData.lastSubmittedCommand, localDraft);
    assert.equal(sessionData.pendingForegroundAppHint, 'codex');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 stale bare PowerShell prompt preserves an unsent draft through a split PSReadLine redraw', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    const localDraft = 'PH005-PTY-CONTINUES-PSREADLINE-DRAFT';
    manager.createSession('PH005 stale PowerShell prompt redraw', 'powershell', cwd, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`PS ${cwd}> `);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed bare PowerShell prompt must not discard an active unsubmitted draft as semantic output',
    );

    pty.emitData('\x1b[?25l');
    pty.emitData('\x1b[93m\bP\x1b[?25h');
    pty.emitData(`\x1b[m\x1b[93m\b${localDraft}`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'the split PSReadLine repaint must retain the draft correlation after its stale bare prompt',
    );

    pty.emitData('completed work');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'substantive output must consume the draft correlation after the redraw settles',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 bare PowerShell prompt without an active draft does not mask later substantive output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    manager.createSession('PH005 bare PowerShell prompt baseline', 'powershell', cwd, { sessionId: SESSION_ID });

    pty.emitData(`PS ${cwd}> `);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('completed work');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'the normal bare PowerShell prompt path must not suppress later substantive terminal output',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 CWD prompt refresh preserves an active unsubmitted draft until its delayed echo settles', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    const localDraft = 'PH005-PTY-CONTINUES-CWD-REFRESH-DRAFT';
    manager.createSession('PH005 CWD prompt refresh draft retention', 'powershell', cwd, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);

    (manager as unknown as {
      transitionToShellPrompt(id: string, reason: string): void;
    }).transitionToShellPrompt(SESSION_ID, 'cwd_prompt_refresh');

    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        inputBuffer: string;
        echoTracker: { lastUnsubmittedPrintableInput?: { value: string } };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.inputBuffer, localDraft);
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput?.value, localDraft);

    await new Promise<void>(resolve => setTimeout(resolve, 60));
    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('completed work');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'substantive output must clear the retained draft correlation after CWD prompt refresh',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 CWD prompt refresh without an active draft keeps normal prompt reset behavior', () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    manager.createSession('PH005 CWD prompt refresh baseline', 'powershell', cwd, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string; lastSubmittedCommand?: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.lastSubmittedCommand = 'previous command';

    (manager as unknown as {
      transitionToShellPrompt(id: string, reason: string): void;
    }).transitionToShellPrompt(SESSION_ID, 'cwd_prompt_refresh');

    assert.equal(sessionData.inputBuffer, '');
    assert.equal(sessionData.lastSubmittedCommand, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 PSReadLine rewrite replaces an earlier partial local-echo prefix with a longer current draft prefix', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-REWRITE-DRAFT';
    const firstRewrite = localDraft.slice(0, 22);
    const longerRewrite = localDraft.slice(0, -1);
    manager.createSession('PH005 PSReadLine partial rewrite', 'powershell', process.cwd(), { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[93m\bP\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData(`\x1b[m\x1b[93m\b${firstRewrite}`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a redraw beginning from the current draft must replace, not append to, the older partial echo prefix',
    );

    pty.emitData(`\x1b[?25l\x1b[m\x1b[93m\x1b[1;19H${longerRewrite}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 a PSReadLine partial echo prefix does not suppress nonmatching semantic output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-SEMANTIC-DRAFT';
    manager.createSession('PH005 PSReadLine semantic after prefix', 'powershell', process.cwd(), { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[93m\bP\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('completed work');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    const sessionData = (manager as unknown as {
      sessions: Map<string, { echoTracker: { lastUnsubmittedPrintableInput?: unknown } }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 ANSI-only PowerShell repaint does not demote an active Codex foreground session', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 ANSI-only Codex foreground repaint', 'powershell', process.cwd(), { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { pendingForegroundAppHint?: 'codex'; derivedState: { ownership: string; activity: string; foregroundAppId?: string } }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    assert.equal(manager.writeInput(SESSION_ID, 'a'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[?25l');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(sessionData.derivedState.ownership, 'foreground_app');
    assert.equal(sessionData.derivedState.activity, 'repaint_only');
    assert.equal(sessionData.derivedState.foregroundAppId, 'codex');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 PowerShell-shaped semantic output does not demote an active Codex foreground session', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    manager.createSession('PH005 PowerShell-shaped Codex semantic output', 'powershell', cwd, { sessionId: SESSION_ID });
    manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { pendingForegroundAppHint?: 'codex'; derivedState: { ownership: string; activity: string; foregroundAppId?: string } }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`PS ${cwd}>`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    assert.equal(sessionData.derivedState.ownership, 'foreground_app');
    assert.equal(sessionData.derivedState.activity, 'busy');
    assert.equal(sessionData.derivedState.foregroundAppId, 'codex');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed active-draft echo prefix survives an intervening control-only repaint', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'abcdef';
    manager.createSession('PH005 active echo control interleave', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string; echoTracker: { unsubmittedPrintableEchoPrefix?: string } }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[93m\babc');
    await new Promise<void>(resolve => setImmediate(resolve));
    pty.emitData('\x1b[?25l');
    await new Promise<void>(resolve => setImmediate(resolve));
    pty.emitData('def\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    assert.equal(sessionData.echoTracker.unsubmittedPrintableEchoPrefix, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 interrupted-draft echo prefix survives an intervening control-only repaint', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'abcdef';
    manager.createSession('PH005 interrupted echo control interleave', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        inputBuffer: string;
        echoTracker: {
          interruptedUnsubmittedPrintableInput?: unknown;
          interruptedUnsubmittedPrintableEchoPrefix?: string;
        };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('\x1b[93m\babc');
    await new Promise<void>(resolve => setImmediate(resolve));
    pty.emitData('\x1b[?25l');
    await new Promise<void>(resolve => setImmediate(resolve));
    pty.emitData('def\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    assert.equal(sessionData.echoTracker.interruptedUnsubmittedPrintableInput, undefined);
    assert.equal(sessionData.echoTracker.interruptedUnsubmittedPrintableEchoPrefix, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 unadorned substantive draft prefix remains observable as running output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 unadorned semantic prefix', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'deploy production'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('deploy');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    const sessionData = (manager as unknown as {
      sessions: Map<string, { echoTracker: { lastUnsubmittedPrintableInput?: unknown } }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 bare split local echo remains idle when its matching suffix arrives', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 bare split local echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('def');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 a replacement draft cancels a deferred bare echo candidate', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 replacement draft clears deferred echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    assert.equal(manager.writeInput(SESSION_ID, 'g'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        echoTracker: {
          lastUnsubmittedPrintableInput?: { value: string };
          deferredUnsubmittedPrintableEcho?: unknown;
        };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput?.value, 'abcdefg');
    assert.equal(sessionData.echoTracker.deferredUnsubmittedPrintableEcho, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C cancels a deferred bare echo candidate', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 Ctrl+C clears deferred echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        echoTracker: { deferredUnsubmittedPrintableEcho?: unknown };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.deferredUnsubmittedPrintableEcho, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 session teardown safely discards a deferred bare echo candidate', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 teardown clears deferred echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    manager.deleteSession(SESSION_ID);
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    assert.equal(manager.getSession(SESSION_ID), null);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 session teardown cancels the deferred bare echo timer', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  const originalClearTimeout = global.clearTimeout;
  const clearedTimers: unknown[] = [];
  global.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    clearedTimers.push(timer);
    return originalClearTimeout(timer);
  }) as typeof clearTimeout;

  try {
    manager.createSession('PH005 teardown cancels deferred echo timer', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        echoTracker: { deferredUnsubmittedPrintableEcho?: { timer?: unknown } };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    const deferredTimer = sessionData.echoTracker.deferredUnsubmittedPrintableEcho?.timer;
    assert.ok(deferredTimer, 'test setup requires a pending deferred echo timer');

    manager.deleteSession(SESSION_ID);
    assert.ok(clearedTimers.includes(deferredTimer));
  } finally {
    global.clearTimeout = originalClearTimeout;
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 a control-only repaint does not cancel the bounded bare echo deadline', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 repaint preserves bounded echo deadline', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    pty.emitData('\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    pty.emitData('def');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 a shell prompt redraw cancels an in-flight bare echo candidate', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    manager.createSession('PH005 prompt clears bare echo candidate', 'powershell', cwd, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    pty.emitData(`PS ${cwd}> `);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    pty.emitData('def');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C retains an already-observed bare echo prefix for its matching suffix', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 Ctrl+C retains bare echo prefix', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('def');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 repeated ambiguous bare chunks do not rearm the deferred echo deadline', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 bounded bare echo candidate', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abc'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('a');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('a');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 SGR-only split local echo remains idle when its matching suffix arrives', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 SGR split local echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[93mabc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('def\x1b[0m');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 a CSI-split SGR local echo remains idle across PTY chunks', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 CSI-split SGR local echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[3');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('2mabcdef\x1b[0m');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an active Codex CSI-split local echo stays idle across PTY chunks', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });

  try {
    manager.createSession('PH005 active Codex CSI-split local echo', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { pendingForegroundAppHint?: 'codex' }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[3');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('2mabcdef\x1b[0m');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an active Codex bare draft prefix times out to running without a suffix', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });

  try {
    manager.createSession('PH005 active Codex bounded bare prefix', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { pendingForegroundAppHint?: 'codex' }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an active Codex bare prefix with a nonmatching suffix runs immediately', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });

  try {
    manager.createSession('PH005 active Codex nonmatching bare suffix', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { pendingForegroundAppHint?: 'codex' }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    pty.emitData('completed work');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an OSC-133 active Codex delayed exact echo stays idle', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });

  try {
    manager.createSession('PH005 OSC-133 Codex delayed echo', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, { pendingForegroundAppHint?: 'codex'; detectionMode: 'osc133'; inputBuffer: string }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    sessionData.detectionMode = 'osc133';
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abcdef');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an OSC-133 active Codex bare prefix with a nonmatching suffix runs and clears its candidate', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });

  try {
    manager.createSession('PH005 OSC-133 Codex nonmatching delayed echo', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        pendingForegroundAppHint?: 'codex';
        detectionMode: 'osc133';
        inputBuffer: string;
        echoTracker: {
          deferredUnsubmittedPrintableEcho?: unknown;
          lastUnsubmittedPrintableInput?: unknown;
          unsubmittedPrintableEchoPrefix?: unknown;
        };
      }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    sessionData.detectionMode = 'osc133';
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    assert.notEqual(sessionData.echoTracker.deferredUnsubmittedPrintableEcho, undefined);

    pty.emitData('completed work');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    assert.equal(sessionData.echoTracker.deferredUnsubmittedPrintableEcho, undefined);
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);
    assert.equal(sessionData.echoTracker.unsubmittedPrintableEchoPrefix, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an OSC-133 active Codex bare prefix deadline runs and clears its candidate', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.updateRuntimeConfig({ runningDelayMs: 0, idleDelayMs: 1_000 });

  try {
    manager.createSession('PH005 OSC-133 Codex delayed echo deadline', 'bash', undefined, { sessionId: SESSION_ID });
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        pendingForegroundAppHint?: 'codex';
        detectionMode: 'osc133';
        inputBuffer: string;
        echoTracker: {
          deferredUnsubmittedPrintableEcho?: unknown;
          lastUnsubmittedPrintableInput?: unknown;
          unsubmittedPrintableEchoPrefix?: unknown;
        };
      }>;
      beginForegroundProcess(id: string, reason: string): void;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.pendingForegroundAppHint = 'codex';
    (manager as unknown as { beginForegroundProcess(id: string, reason: string): void })
      .beginForegroundProcess(SESSION_ID, 'test_setup');
    sessionData.detectionMode = 'osc133';
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    assert.notEqual(sessionData.echoTracker.deferredUnsubmittedPrintableEcho, undefined);

    await new Promise<void>(resolve => setTimeout(resolve, 120));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    assert.equal(sessionData.echoTracker.deferredUnsubmittedPrintableEcho, undefined);
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);
    assert.equal(sessionData.echoTracker.unsubmittedPrintableEchoPrefix, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 a bare draft prefix with a nonmatching suffix runs immediately', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 bare prefix nonmatching suffix', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'abcdef'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('abc');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('completed work');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 CRLF-terminated substantive draft prefix remains observable as running output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 CRLF semantic prefix', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'deploy production'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('deploy\r\n');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    const sessionData = (manager as unknown as {
      sessions: Map<string, { echoTracker: { lastUnsubmittedPrintableInput?: unknown } }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 ANSI-colored substantive draft prefix remains observable as running output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 ANSI semantic prefix', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'deploy production'), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('\x1b[32mdeploy\x1b[0m');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
    const sessionData = (manager as unknown as {
      sessions: Map<string, { echoTracker: { lastUnsubmittedPrintableInput?: unknown } }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 unadorned exact delayed draft echo remains idle', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'deploy production';
    manager.createSession('PH005 unadorned exact echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(localDraft);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 an observed exact local echo is not revived as an interrupted draft', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-OBSERVED-ECHO';
    manager.createSession('PH005 observed echo interrupt correlation', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        echoTracker: {
          lastUnsubmittedPrintableInput?: unknown;
          interruptedUnsubmittedPrintableInput?: unknown;
        };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    assert.equal(sessionData.echoTracker.lastUnsubmittedPrintableInput, undefined);

    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);
    assert.equal(sessionData.echoTracker.interruptedUnsubmittedPrintableInput, undefined);
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C prompt return expires an unmatched interrupted draft correlation', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-EXPIRED-INTERRUPT-DRAFT';
    manager.createSession('PH005 Ctrl+C prompt return expiry', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, {
        inputBuffer: string;
        echoTracker: { interruptedUnsubmittedPrintableInput?: unknown };
      }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('\x1b[2K\r› ');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    assert.equal(sessionData.echoTracker.interruptedUnsubmittedPrintableInput, undefined);

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 immediate semantic output after unsent printable input remains running', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 immediate printable semantic output', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'PH005-PTY-CONTINUES-LOCAL-DRAFT'), true);

    pty.emitData('Running command');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'semantic output must remain observable even when it races immediate unsent printable input',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 immediate semantic output after Ctrl+C remains running', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 immediate Ctrl+C semantic output', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('Running command');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'semantic output must remain observable even when it races immediate Ctrl+C input',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 immediate Ctrl+C SGR-reset and cursor-hide repaint stays idle', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 immediate Ctrl+C reset cursor repaint', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('\x1b[m\x1b[?25l');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a Ctrl+C SGR-reset/cursor-hide control-only repaint must not be classified as semantic terminal output',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C cursor-only repaint does not suppress later semantic shell output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 Ctrl+C cursor repaint semantic prompt', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('\x1b[m\x1b[?25l');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');

    pty.emitData('completed work\r\nuser@host:~$');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'running');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C cursor-positioned echo and PowerShell prompt redraw stays idle', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'win32',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const cwd = process.cwd();
    const localDraft = 'PH005-PTY-CONTINUES-CTRL-C-REDRAW';
    manager.createSession('PH005 Ctrl+C cursor-position redraw', 'powershell', cwd, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData(`\x1b[93m${localDraft}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData(`\x1b[93m\x1b[1;19H${localDraft}\x1b[91m^C\x1b[m\r\nPS ${cwd}> \x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 Ctrl+C prompt-only shell return remains idle', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 Ctrl+C prompt-only shell return', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('user@host:~$');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 immediate Ctrl+C prompt repaint consumes its allowance before later semantic prompt output', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 immediate Ctrl+C prompt consumption', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, '\x03'), true);

    pty.emitData('\x1b[2K\r› ');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getSession(SESSION_ID)?.status, 'idle');
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    pty.emitData('completed work\r\nuser@host:~$');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a later semantic prompt output must not reuse an immediate Ctrl+C repaint allowance',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed ANSI local echo split across PTY chunks stays idle until its matching suffix arrives', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    const localDraft = 'PH005-PTY-CONTINUES-SPLIT-DRAFT';
    const prefix = localDraft.slice(0, 18);
    const suffix = localDraft.slice(prefix.length);
    manager.createSession('PH005 split delayed ANSI local echo', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, localDraft), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 510));

    pty.emitData(`\x1b[93m\b${prefix}`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed local-echo prefix must not be classified as semantic output before the matching suffix arrives',
    );

    pty.emitData(`${suffix}\x1b[?25h`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'idle',
      'a delayed local echo split across PTY chunks must preserve idle after the matching suffix arrives',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('MIG-BGSTAB-002 delayed ANSI-colored nonmatching output remains running after the pending input buffer is cleared', async () => {
  const pty = new AuthorityIntegrationFakePty();
  const manager = new SessionManager(undefined, {
    platform: 'linux',
    spawnPty: (() => pty) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'],
    readProcessStartIdentityFn: async () => null,
  });
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;

  try {
    manager.createSession('PH005 delayed ANSI semantic output', 'bash', undefined, { sessionId: SESSION_ID });
    assert.equal(manager.writeInput(SESSION_ID, 'PH005-PTY-CONTINUES-LOCAL-DRAFT'), true);
    const sessionData = (manager as unknown as {
      sessions: Map<string, { inputBuffer: string }>;
    }).sessions.get(SESSION_ID);
    assert.ok(sessionData, 'test setup requires the created session data');
    sessionData.inputBuffer = '';
    await new Promise<void>(resolve => setTimeout(resolve, 410));

    pty.emitData('\x1b[93mRunning command\x1b[?25h');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(
      manager.getSession(SESSION_ID)?.status,
      'running',
      'a delayed ANSI-colored output that does not match the last unsubmitted local draft must remain observable when foreground detection is stale',
    );
  } finally {
    manager.deleteSession(SESSION_ID);
  }
});

test('Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-6', async () => {
  const contract = await loadContract('MIG-AC-6');
  const debugRoutesContract = await loadDebugRoutesContract();
  const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  assert.match(
    indexSource,
    /import\s*\{\s*registerTerminalAuthorityDebugRoutes\s*\}\s*from\s*['"]\.\/routes\/terminalAuthorityDebugRoutes\.js['"]/u,
    'server index must import the executable authority debug route registrar',
  );
  assert.match(
    indexSource,
    /registerTerminalAuthorityDebugRoutes\s*\(\s*\{/u,
    'server index must invoke the executable authority debug route registrar',
  );
  const createGuardResponse = () => {
    const capture: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
    const response = {
      status(code: number) {
        capture.statusCode = code;
        return response;
      },
      json(body: unknown) {
        capture.body = body;
        return response;
      },
    };
    return { capture, response };
  };
  const registrations: TerminalAuthorityDebugRouteRegistration[] = [];
  let guardEvents: string[] = [];
  let sessionLookupCalls = 0;
  const mutationHandlerCalls: string[] = [];
  const authGuard: DebugRouteMiddleware = (_request, _response, next) => {
    guardEvents.push('auth');
    next();
  };
  const localityGuard: DebugRouteMiddleware = (request, response, next) => {
    guardEvents.push('locality');
    requireLocalDebugCapture(request as never, response as never, next as never);
  };
  const sessionGuard = ensureDebugCaptureSessionExists({
    hasSession: () => {
      sessionLookupCalls += 1;
      return true;
    },
  }) as unknown as DebugRouteMiddleware;
  const testIsolationHandler: DebugRouteMiddleware = () => {
    mutationHandlerCalls.push('test-isolation');
  };
  const rollbackHandler: DebugRouteMiddleware = () => {
    mutationHandlerCalls.push('rollback');
  };
  const faultHandler: DebugRouteMiddleware = () => {
    mutationHandlerCalls.push('fault');
  };
  debugRoutesContract.registerTerminalAuthorityDebugRoutes({
    registrar: {
      post: (path, ...handlers) => registrations.push({ path, handlers }),
    },
    authMiddleware: authGuard,
    requireLocalDebugCapture: localityGuard,
    requireExistingDebugSession: sessionGuard,
    handleTestIsolation: testIsolationHandler,
    handleRollback: rollbackHandler,
    handleFault: faultHandler,
  });
  const expectedRegistrations = [
    {
      path: '/api/sessions/debug-capture/:id/terminal-authority-test-isolation',
      handler: testIsolationHandler,
    },
    {
      path: '/api/sessions/debug-capture/:id/terminal-authority-rollback',
      handler: rollbackHandler,
    },
    {
      path: '/api/sessions/debug-capture/:id/terminal-authority-fault',
      handler: faultHandler,
    },
  ] as const;
  assert.deepEqual(
    registrations.map(registration => registration.path),
    expectedRegistrations.map(({ path }) => path),
    'the registrar must expose exactly the three planned localhost-only mutation routes',
  );
  for (const [registrationIndex, registration] of registrations.entries()) {
    const expectedRegistration = expectedRegistrations[registrationIndex];
    assert.ok(expectedRegistration);
    assert.deepEqual(
      registration.handlers,
      [authGuard, localityGuard, sessionGuard, expectedRegistration.handler],
      `${registration.path} guard order must be auth → locality → session → mutation`,
    );
    guardEvents = [];
    sessionLookupCalls = 0;
    mutationHandlerCalls.length = 0;
    const remote = createGuardResponse();
    const request = {
      ip: '203.0.113.7',
      params: { id: SESSION_ID },
      auth: { authenticated: true, source: 'test-auth-guard' },
    } as Record<string, unknown>;
    let middlewareIndex = 0;
    const next = (): void => {
      const middleware = registration.handlers[middlewareIndex];
      middlewareIndex += 1;
      middleware?.(request, remote.response as unknown as Record<string, unknown>, next);
    };
    next();
    assert.deepEqual(guardEvents, ['auth', 'locality'], `${registration.path} remote request escaped locality guard`);
    assert.equal(sessionLookupCalls, 0, `${registration.path} performed a session lookup for a remote caller`);
    assert.deepEqual(mutationHandlerCalls, [], `${registration.path} executed a mutation for a remote caller`);
    assert.equal(remote.capture.statusCode, 403);
    assert.deepEqual(remote.capture.body, {
      error: {
        code: 'LOCALHOST_ONLY',
        message: 'Debug capture is only available from localhost.',
        timestamp: (remote.capture.body as { error: { timestamp: string } }).error.timestamp,
      },
    });
  }
  const harness = createHarness(contract);
  await harness.controller.beginPromotion(promotionRequest());
  const hidden = await harness.controller.captureHeadlessOutput({ sourceSeq: '42', data: 'hidden-output-still-committed', hidden: true });
  assert.equal(hidden.modelCommitted, true);
  assert.equal(hidden.deliveryDisposition, 'held-post-boundary');
  assert.equal(harness.controller.getState().ptyPaused, false);
  assert.equal(harness.controller.getState().hiddenDeliveryLossy, false);
  for (const kind of ['user-input', 'local-echo', 'prompt-redraw'] as const) {
    assert.equal((await harness.controller.observeInteractiveInput({ kind })).sessionStatus, 'idle');
  }
  assert.equal(harness.events.some(event => event.type === 'pty-paused' || event.type === 'hidden-output-dropped'), false);

  const deadline = createHarness(contract);
  await deadline.controller.beginPromotion(promotionRequest());
  deadline.nowMs += deadline.safetyLimits.ackDeadlineMs + 1;
  assert.deepEqual(deadline.controller.checkPromotionDeadline(), { abortRequired: true, reason: 'disable-ack-deadline-exceeded' });
  assert.deepEqual(deadline.recoveryReasons, ['disable-ack-deadline-exceeded']);
  assert.equal(deadline.controller.getState().mode, 'rolling-back');
  assert.equal(deadline.controller.getState().admissionOpen, 'none');
  assert.deepEqual(deadline.events.slice(-3).map(event => event.type), ['affected-views-stale', 'old-ack-backlog-purged', 'ordered-compatibility-recovery-started']);
  assert.equal((await deadline.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A))).accepted, false);
  assert.equal(deadline.controller.getState().ptyPaused, false);

  let releaseQuorumReceipt!: (accepted: boolean) => void;
  const quorumReceiptPromise = new Promise<boolean>(resolve => {
    releaseQuorumReceipt = resolve;
  });
  const acceptedQuorum = createHarness(contract, { quorumReceiptPromise });
  await acceptedQuorum.controller.beginPromotion(promotionRequest());
  assert.deepEqual(
    await acceptedQuorum.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A)),
    { accepted: true, completed: false },
  );
  const committingQuorum = acceptedQuorum.controller.acknowledgeLegacyDisable(
    responderIdentity(VIEW_B),
  );
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(acceptedQuorum.controller.getState().acceptedDisableAckCount, 2);
  assert.equal(acceptedQuorum.controller.getState().mode, 'promoting');
  acceptedQuorum.nowMs += acceptedQuorum.safetyLimits.ackDeadlineMs + 1;
  assert.deepEqual(
    acceptedQuorum.controller.checkPromotionDeadline(),
    { abortRequired: false },
    'an accepted disable quorum awaiting its completion receipt is not an ACK miss',
  );
  releaseQuorumReceipt(false);
  assert.deepEqual(await committingQuorum, {
    accepted: false,
    completed: false,
    reason: 'responder-disable-completion-receipt-failed',
  });
  assert.equal(acceptedQuorum.controller.getState().acceptedDisableAckCount, 0);
  assert.equal(acceptedQuorum.controller.getState().mode, 'rolling-back');
  assert.deepEqual(
    acceptedQuorum.recoveryReasons,
    ['responder-disable-completion-receipt-failed'],
    'a failed quorum receipt after the ACK timer expires must enter ordered recovery',
  );

  const overflow = createHarness(contract);
  overflow.safetyLimits.maxHeldOutputBytes = 4;
  overflow.safetyLimits.maxHeldOutputChunks = 1;
  await overflow.controller.beginPromotion(promotionRequest());
  await overflow.controller.captureHeadlessOutput({ sourceSeq: '42', data: '12345' });
  assert.deepEqual(overflow.recoveryReasons, ['post-boundary-hold-overflow']);
  assert.equal(overflow.controller.getState().mode, 'rolling-back');
  assert.equal(overflow.controller.getState().admissionOpen, 'none');
  assert.deepEqual(overflow.events.slice(-3).map(event => event.type), ['affected-views-stale', 'old-ack-backlog-purged', 'ordered-compatibility-recovery-started']);
  assert.equal((await overflow.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A))).accepted, false);
  assert.equal(overflow.controller.getState().ptyPaused, false);
  assert.equal(overflow.controller.getState().hiddenDeliveryLossy, false);
});

test('Single-authority promotion and rollback epoch RED contract — REL-BGSTAB-007 AC-12', async () => {
  const contract = await loadContract('REL-AC-12');
  for (const change of [
    { kind: 'new-view', connectionId: 'connection-new', viewGeneration: 1 },
    { kind: 'generation-changed', connectionId: VIEW_A.connectionId, viewGeneration: 12 },
    { kind: 'disconnect', connectionId: VIEW_A.connectionId, viewGeneration: VIEW_A.viewGeneration },
    { kind: 'unsubscribe', connectionId: VIEW_B.connectionId, viewGeneration: VIEW_B.viewGeneration },
  ] as const) {
    const harness = createHarness(contract);
    await harness.controller.beginPromotion(promotionRequest());
    assert.equal(harness.controller.getState().frozenRequiredResponderCount, 2);
    await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A));
    assert.equal(harness.controller.getState().acceptedDisableAckCount, 1);
    const result = await harness.controller.notifyResponderTopologyChanged({ transitionEpoch: TRANSITION_EPOCH, ...change });
    assert.deepEqual({ aborted: result.aborted, restartRequired: result.restartRequired }, { aborted: true, restartRequired: true });
    assert.equal(harness.controller.getState().mode, 'aborted');
    assert.equal((await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_B))).accepted, false);
    assert.equal(
      harness.events.some(event => event.connectionId === change.connectionId && event.viewGeneration === change.viewGeneration),
      true,
      'topology abort must preserve the composite connectionId + viewGeneration identity even when peer generations collide',
    );
    assert.deepEqual(
      harness.authorityEffects.filter(effect => effect.type === 'affected-view-stale'),
      [
        {
          type: 'affected-view-stale',
          connectionId: VIEW_A.connectionId,
          viewGeneration: VIEW_A.viewGeneration,
        },
        {
          type: 'affected-view-stale',
          connectionId: VIEW_B.connectionId,
          viewGeneration: VIEW_B.viewGeneration,
        },
      ],
      'an abort must stale both frozen composite views even when their viewGeneration numbers are equal',
    );
    assert.deepEqual(harness.events.slice(-4).map(event => event.type), ['promotion-aborted', 'affected-views-stale', 'old-ack-backlog-purged', 'compatibility-restart-required']);
  }
});

test('REL-BGSTAB-007 applies configured retained policy before delivery', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const configuredRetainedScrollbackLines = 4;
  for (const retainedOverflowLineCount of [
    configuredRetainedScrollbackLines - 1,
    configuredRetainedScrollbackLines,
    configuredRetainedScrollbackLines + 1,
  ]) {
    const fakePty = new AuthorityIntegrationFakePty();
    const integration = createConfiguredProductionIntegrationFixture(
      productionModule,
      'split',
      fakePty,
      { retainedScrollbackLines: configuredRetainedScrollbackLines, legacyScrollbackLines: 1 },
    );
    const manager = integration.sessionManager;
    (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
    try {
      manager.createSession(`REL-007 configured policy ${retainedOverflowLineCount}`, 'bash', undefined, {
        sessionId: SESSION_ID,
      });
      assert.equal(manager.resize(SESSION_ID, 24, 1), true);
      const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
      assert.ok(session);
      const physicalLineCount = retainedOverflowLineCount;
      for (let line = 0; line < physicalLineCount; line += 1) {
        fakePty.emitData(`P${String(line).padStart(6, '0')}\r\n`);
      }
      await session.headlessWriteChain;

      const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
        mode: 'shadow' | 'disabled';
        recovery: { authority: string; provisionalCacheUsed: boolean };
        comparer: { deliveryAuthority: string };
        sourceSeq: string;
        oldestRetainedSeq: string;
        retentionPolicy: {
          effectiveRetainedScrollbackLines: number;
          retentionPolicyId: string;
          source: string;
          sourceKind: string;
        };
        checkpoint: { rows: number; normal: { logicalLines: readonly string[] } };
        budgets: { retention: { configured: boolean; unit: string; value: number } };
      } | undefined;
      assert.ok(retained);
      assert.equal(retained.mode, 'shadow', 'server admission must not redefine the retained model mode');
      assert.equal(retained.retentionPolicy.effectiveRetainedScrollbackLines, configuredRetainedScrollbackLines);
      assert.equal(retained.budgets.retention.value, configuredRetainedScrollbackLines);
      assert.equal(retained.budgets.retention.configured, true);
      assert.equal(retained.budgets.retention.unit, 'lines');
      assert.equal(retained.retentionPolicy.source, 'resourceLimits.terminal.scrollbackLines');
      assert.equal(retained.retentionPolicy.sourceKind, 'canonical-explicit');
      assert.equal(
        retained.checkpoint.normal.logicalLines.length <= configuredRetainedScrollbackLines + retained.checkpoint.rows,
        true,
        'the configured retained range must cap physical rows without falling back to the legacy PTY range',
      );
      assert.equal(
        retained.checkpoint.normal.logicalLines.some(line => line.includes('P000000')),
        retainedOverflowLineCount <= configuredRetainedScrollbackLines,
        'N-1/N retain the first row, while N+1 evicts it at the configured physical-row boundary',
      );
      assert.equal(
        retained.checkpoint.normal.logicalLines.some(line => (
          line.includes(`P${String(physicalLineCount - 1).padStart(6, '0')}`)
        )),
        true,
        'the newest physical row must remain retained at every N-1/N/N+1 boundary',
      );
      assert.equal(retained.oldestRetainedSeq, '1', 'row eviction must not invent a different ledger source identity');
    } finally {
      manager.deleteSession(SESSION_ID);
      integration.destroy();
    }
  }

  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createConfiguredProductionIntegrationFixture(
    productionModule,
    'split',
    fakePty,
    { retainedScrollbackLines: configuredRetainedScrollbackLines, legacyScrollbackLines: 1 },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 configured delivery policy', 'bash', undefined, { sessionId: SESSION_ID });
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    fakePty.emitData('configured-policy-delivery-marker');
    await session.headlessWriteChain;
    const retainedBeforeDelivery = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
      sourceSeq: string;
      oldestRetainedSeq: string;
      retentionPolicy: { retentionPolicyId: string };
    } | undefined;
    assert.ok(retainedBeforeDelivery);
    assert.deepEqual(
      retainedBeforeDelivery.recovery,
      { authority: 'legacy-local', provisionalCacheUsed: true },
      'before checkpoint delivery starts, the retained model must remain explicitly local-cache provisional',
    );
    assert.equal(retainedBeforeDelivery.comparer.deliveryAuthority, 'legacy');
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 801);
    await promoteProductionViews(integration, [view]);
    const retainedAfterControllerCommit = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterControllerCommit);
    assert.deepEqual(
      retainedAfterControllerCommit.recovery,
      { authority: 'legacy-local', provisionalCacheUsed: true },
      'controller promotion alone cannot claim server-owned browser recovery before the view checkpoint delivery settles',
    );
    assert.equal(retainedAfterControllerCommit.comparer.deliveryAuthority, 'legacy');
    const checkpoint = await activateRealAdapterCheckpoint(view);
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'server');

    const audit = integration.getAuthorityAuditTrail(SESSION_ID);
    const modelCommitIndex = audit.findIndex(event => event.type === 'headless-model-committed');
    const checkpointEnqueueIndex = audit.findIndex(event => event.type === 'fresh-authoritative-checkpoint-enqueued');
    assert.equal(
      modelCommitIndex >= 0 && checkpointEnqueueIndex > modelCommitIndex,
      true,
      'the retained model must commit before the adapter admits its visible checkpoint delivery',
    );
    assert.equal(checkpoint.start.mode, 'authoritative');
    assert.equal(checkpoint.start.retentionPolicyId, retainedBeforeDelivery.retentionPolicy.retentionPolicyId);
    assert.equal(checkpoint.start.localCacheUsed, false);
    assert.equal(checkpoint.start.effectiveRetainedScrollbackLines, configuredRetainedScrollbackLines);
    assert.equal(checkpoint.start.oldestRetainedSeq, retainedBeforeDelivery.oldestRetainedSeq);
    assert.equal(checkpoint.start.sourceSeq, retainedBeforeDelivery.sourceSeq);
    const retainedAfterDelivery = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      mode: 'shadow' | 'disabled';
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterDelivery);
    assert.equal(retainedAfterDelivery.mode, 'shadow', 'server admission must not redefine the retained model mode');
    assert.deepEqual(
      retainedAfterDelivery.recovery,
      { authority: 'server', provisionalCacheUsed: false },
      'the actual server-admission state must project server-owned recovery only after checkpoint delivery is active',
    );
    assert.equal(retainedAfterDelivery.comparer.deliveryAuthority, 'server');
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('REL-BGSTAB-007 invalidates a settled delivery proof when split output re-pairs on the same view generation', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 split proof re-pair', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 811);
    await promoteProductionViews(integration, [view]);
    await activateRealAdapterCheckpoint(view);
    const retainedAfterFirstDelivery = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterFirstDelivery);
    assert.deepEqual(retainedAfterFirstDelivery.recovery, {
      authority: 'server',
      provisionalCacheUsed: false,
    });
    assert.equal(retainedAfterFirstDelivery.comparer.deliveryAuthority, 'server');

    view.output.close();
    view.output.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));
    const retainedAfterOutputUnpaired = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterOutputUnpaired);
    assert.deepEqual(
      retainedAfterOutputUnpaired.recovery,
      { authority: 'legacy-local', provisionalCacheUsed: true },
      'the proof from the detached output socket must not authorize recovery on a replacement transport',
    );
    assert.equal(retainedAfterOutputUnpaired.comparer.deliveryAuthority, 'legacy');

    const connected = view.control.sentFrames.find(frame => frame.type === 'connected');
    assert.ok(connected);
    const repairedOutput = new ExecutableAuthoritySocket('output-repaired-811');
    router.wss.emit(
      'connection',
      repairedOutput,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(connected.clientGroupId),
        pairToken: String(connected.pairToken),
      },
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    const retainedBeforeReplacementSettlement = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedBeforeReplacementSettlement);
    assert.deepEqual(retainedBeforeReplacementSettlement.recovery, {
      authority: 'legacy-local',
      provisionalCacheUsed: true,
    });
    assert.equal(retainedBeforeReplacementSettlement.comparer.deliveryAuthority, 'legacy');

    await activateRealAdapterCheckpoint({ ...view, output: repairedOutput });
    const retainedAfterReplacementSettlement = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterReplacementSettlement);
    assert.deepEqual(retainedAfterReplacementSettlement.recovery, {
      authority: 'server',
      provisionalCacheUsed: false,
    });
    assert.equal(retainedAfterReplacementSettlement.comparer.deliveryAuthority, 'server');
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('REL-BGSTAB-007 invalidates a settled delivery proof synchronously when split output is replaced', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 split proof replacement', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 821);
    await promoteProductionViews(integration, [view]);
    await activateRealAdapterCheckpoint(view);

    const connected = view.control.sentFrames.find(frame => frame.type === 'connected');
    assert.ok(connected);
    const replacementOutput = new ExecutableAuthoritySocket('output-replaced-821');
    router.wss.emit(
      'connection',
      replacementOutput,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(connected.clientGroupId),
        pairToken: String(connected.pairToken),
      },
    );

    const retainedInReplacementTurn = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedInReplacementTurn);
    assert.deepEqual(
      retainedInReplacementTurn.recovery,
      { authority: 'legacy-local', provisionalCacheUsed: true },
      'a replacement output transport invalidates the old physical delivery proof before deferred rollback work begins',
    );
    assert.equal(retainedInReplacementTurn.comparer.deliveryAuthority, 'legacy');
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('REL-BGSTAB-007 preserves unaffected settled view proof across another split output re-pair', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    new AuthorityIntegrationFakePty(),
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 split proof isolation', 'bash', undefined, { sessionId: SESSION_ID });
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const first = await connectProductionView(router, 'split', 831);
    const second = await connectProductionView(router, 'split', 841);
    await promoteProductionViews(integration, [first, second]);
    await activateRealAdapterCheckpoint(first);
    await activateRealAdapterCheckpoint(second);
    const retainedBeforeUnpair = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedBeforeUnpair);
    assert.deepEqual(retainedBeforeUnpair.recovery, { authority: 'server', provisionalCacheUsed: false });

    first.output.close();
    first.output.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));
    const retainedWithFirstDetached = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedWithFirstDetached);
    assert.deepEqual(retainedWithFirstDetached.recovery, {
      authority: 'legacy-local',
      provisionalCacheUsed: true,
    });
    assert.equal(retainedWithFirstDetached.comparer.deliveryAuthority, 'legacy');

    const connected = first.control.sentFrames.find(frame => frame.type === 'connected');
    assert.ok(connected);
    const repairedOutput = new ExecutableAuthoritySocket('output-repaired-831');
    router.wss.emit(
      'connection',
      repairedOutput,
      {},
      { sub: 'authority-test-user', jti: 'authority-test-token' },
      {
        ok: true,
        requestedMode: 'split',
        channelRole: 'output',
        clientGroupId: String(connected.clientGroupId),
        pairToken: String(connected.pairToken),
      },
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await activateRealAdapterCheckpoint({ ...first, output: repairedOutput });
    const retainedAfterFirstResettles = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterFirstResettles);
    assert.deepEqual(
      retainedAfterFirstResettles.recovery,
      { authority: 'server', provisionalCacheUsed: false },
      'the unaffected second view proof must survive; only the re-paired first view requires fresh settlement',
    );
    assert.equal(retainedAfterFirstResettles.comparer.deliveryAuthority, 'server');
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('REL-BGSTAB-007 fences active server recovery at an Ordinal64 retained-stream rollover until a fresh checkpoint settles', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    fakePty,
    { retainedTerminalInitialOrdinal: { streamEpoch: '9', sourceSeq: '18446744073709551614' } },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 active server rollover', 'bash', undefined, { sessionId: SESSION_ID });
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 851);
    await promoteProductionViews(integration, [view]);
    const initialCheckpoint = await activateRealAdapterCheckpoint(view);
    assert.deepEqual(
      {
        streamEpoch: initialCheckpoint.start.streamEpoch,
        sourceSeq: initialCheckpoint.start.sourceSeq,
      },
      { streamEpoch: '10', sourceSeq: '18446744073709551614' },
    );
    const retainedBeforeRollover = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedBeforeRollover);
    assert.deepEqual(retainedBeforeRollover.recovery, { authority: 'server', provisionalCacheUsed: false });

    const rolloverPreparationFrameStart = view.control.sentFrames.length;
    fakePty.emitData('ordinal64-active-n-boundary\r\n');
    await session.headlessWriteChain;
    fakePty.emitData('ordinal64-active-rollover-boundary\r\n');
    await session.headlessWriteChain;

    const retainedAfterRollover = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      streamEpoch: string;
      sourceSeq: string;
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedAfterRollover);
    assert.deepEqual(
      {
        streamEpoch: retainedAfterRollover.streamEpoch,
        sourceSeq: retainedAfterRollover.sourceSeq,
      },
      { streamEpoch: '10', sourceSeq: '0' },
    );
    assert.deepEqual(
      retainedAfterRollover.recovery,
      { authority: 'legacy-local', provisionalCacheUsed: true },
      'the old stream proof cannot authorize public server recovery after the retained model starts a new stream',
    );
    assert.equal(retainedAfterRollover.comparer.deliveryAuthority, 'legacy');

    const rolloverCheckpoint = await activateRealAdapterCheckpoint(view, {
      expectedSourceSeq: '0',
      preparationFrameStart: rolloverPreparationFrameStart,
    });
    assert.deepEqual(
      {
        streamEpoch: rolloverCheckpoint.start.streamEpoch,
        sourceSeq: rolloverCheckpoint.start.sourceSeq,
      },
      { streamEpoch: '10', sourceSeq: '0' },
      'the replacement physical checkpoint must own the rolled stream before server recovery can resume',
    );
    let retainedAfterRolloverCheckpoint = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    for (let attempt = 0; attempt < 40
      && retainedAfterRolloverCheckpoint?.recovery.authority !== 'server'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      retainedAfterRolloverCheckpoint = manager.getRetainedTerminalAuthorityState(SESSION_ID) as typeof retainedAfterRolloverCheckpoint;
    }
    assert.ok(retainedAfterRolloverCheckpoint);
    assert.deepEqual(retainedAfterRolloverCheckpoint.recovery, { authority: 'server', provisionalCacheUsed: false });
    assert.equal(retainedAfterRolloverCheckpoint.comparer.deliveryAuthority, 'server');
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('REL-BGSTAB-007 rekeys active server authority for every retained-stream rollover', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    fakePty,
    { retainedTerminalInitialOrdinal: { streamEpoch: '9', sourceSeq: '18446744073709551614' } },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 repeated active rollover', 'bash', undefined, { sessionId: SESSION_ID });
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID) as {
      headlessWriteChain: Promise<void>;
      nextTerminalAuthoritySourceSeq: bigint;
      retainedTerminal: { sourceSeq: string; snapshotSeq: string };
    } | undefined;
    assert.ok(session);
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 861);
    await promoteProductionViews(integration, [view]);
    await activateRealAdapterCheckpoint(view);

    const firstPreparationStart = view.control.sentFrames.length;
    fakePty.emitData('ordinal64-repeated-n-boundary\r\n');
    await session.headlessWriteChain;
    fakePty.emitData('ordinal64-repeated-first-rollover\r\n');
    await session.headlessWriteChain;
    const firstCheckpoint = await activateRealAdapterCheckpoint(view, {
      expectedSourceSeq: '0',
      preparationFrameStart: firstPreparationStart,
    });
    assert.equal(firstCheckpoint.start.streamEpoch, '10');
    assert.equal(integration.getAuthorityState(SESSION_ID)?.activeDriverLeaseId, 'driver-server-10');
    let retainedAfterFirstCheckpoint = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
    } | undefined;
    for (let attempt = 0; attempt < 40
      && retainedAfterFirstCheckpoint?.recovery.authority !== 'server'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
      retainedAfterFirstCheckpoint = manager.getRetainedTerminalAuthorityState(SESSION_ID) as typeof retainedAfterFirstCheckpoint;
    }
    assert.deepEqual(
      retainedAfterFirstCheckpoint?.recovery,
      { authority: 'server', provisionalCacheUsed: false },
      'the first rollover checkpoint must physically settle before the next rollover starts',
    );

    // Simulate the next Ordinal64 boundary without issuing 2^64-1 outputs.
    session.retainedTerminal.sourceSeq = '18446744073709551615';
    session.retainedTerminal.snapshotSeq = '18446744073709551615';
    session.nextTerminalAuthoritySourceSeq = 18446744073709551615n;
    const secondPreparationStart = view.control.sentFrames.length;
    fakePty.emitData('ordinal64-repeated-second-rollover\r\n');
    await session.headlessWriteChain;

    const retainedAfterSecondRollover = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      streamEpoch: string;
      sourceSeq: string;
      recovery: { authority: string; provisionalCacheUsed: boolean };
    } | undefined;
    assert.ok(retainedAfterSecondRollover);
    assert.deepEqual(
      {
        streamEpoch: retainedAfterSecondRollover.streamEpoch,
        sourceSeq: retainedAfterSecondRollover.sourceSeq,
      },
      { streamEpoch: '11', sourceSeq: '0' },
    );
    assert.deepEqual(retainedAfterSecondRollover.recovery, {
      authority: 'legacy-local',
      provisionalCacheUsed: true,
    });
    assert.deepEqual({
      streamEpoch: integration.getAuthorityState(SESSION_ID)?.streamEpoch,
      mode: integration.getAuthorityState(SESSION_ID)?.mode,
      transitionEpoch: manager.getTerminalAuthorityRuntimePortState(SESSION_ID)?.admission.transitionEpoch,
      admission: manager.getTerminalAuthorityRuntimePortState(SESSION_ID)?.admission.mode,
    }, {
      streamEpoch: '11',
      mode: 'server',
      transitionEpoch: '11',
      admission: 'server',
    });

    const secondCheckpoint = await activateRealAdapterCheckpoint(view, {
      expectedSourceSeq: '0',
      expectedStreamEpoch: '11',
      preparationFrameStart: secondPreparationStart,
    });
    assert.equal(secondCheckpoint.preparation.streamEpoch, '11');
    assert.equal(secondCheckpoint.start.streamEpoch, '11');
    for (let attempt = 0; attempt < 40
      && integration.getAuthorityState(SESSION_ID)?.activeDriverLeaseId !== 'driver-server-11'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const rekeyedAuthority = integration.getAuthorityState(SESSION_ID);
    assert.equal(rekeyedAuthority?.streamEpoch, '11');
    assert.equal(rekeyedAuthority?.activeDriverLeaseId, 'driver-server-11');
    assert.equal(rekeyedAuthority?.activeResponderLeaseId, 'responder-server-11');
    const retainedAfterSecondCheckpoint = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
    } | undefined;
    assert.ok(retainedAfterSecondCheckpoint);
    assert.deepEqual(retainedAfterSecondCheckpoint.recovery, { authority: 'server', provisionalCacheUsed: false });
  } finally {
    manager.deleteSession(SESSION_ID);
    integration.destroy();
  }
});

test('REL-BGSTAB-007 validates Ordinal64 checkpoint apply and drain', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const maximumOrdinal64 = '18446744073709551615';
  {
    const maximumPty = new AuthorityIntegrationFakePty();
    const maximumIntegration = createProductionIntegrationFixture(
      productionModule,
      'split',
      maximumPty,
      { retainedTerminalInitialOrdinal: { streamEpoch: '9', sourceSeq: '18446744073709551614' } },
    );
    const maximumManager = maximumIntegration.sessionManager;
    (maximumManager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
    try {
      maximumManager.createSession('REL-007 maximum Ordinal64 checkpoint ACK', 'bash', undefined, {
        sessionId: SESSION_ID,
      });
      const maximumSession = (maximumManager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
      assert.ok(maximumSession);
      maximumPty.emitData('ordinal64-maximum-boundary\r\n');
      await maximumSession.headlessWriteChain;
      const retainedAtMaximum = maximumManager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
        streamEpoch: string;
        sourceSeq: string;
      } | undefined;
      assert.ok(retainedAtMaximum);
      assert.deepEqual(
        { streamEpoch: retainedAtMaximum.streamEpoch, sourceSeq: retainedAtMaximum.sourceSeq },
        { streamEpoch: '9', sourceSeq: maximumOrdinal64 },
        'the maximum legal Ordinal64 must remain in its stream until the next record requires rollover',
      );

      const maximumRouter = maximumIntegration.wsRouter as unknown as ExecutableWsRouterApi;
      const maximumView = await connectProductionView(maximumRouter, 'split', 701);
      await promoteProductionViews(maximumIntegration, [maximumView]);
      const maximumCheckpoint = await activateRealAdapterCheckpoint(maximumView);
      assert.deepEqual(
        {
          sourceSeq: maximumCheckpoint.start.sourceSeq,
          snapshotSeq: maximumCheckpoint.start.snapshotSeq,
        },
        { sourceSeq: maximumOrdinal64, snapshotSeq: maximumOrdinal64 },
        'the transaction must carry the maximum legal Ordinal64 on its checkpoint wire identity',
      );
      assert.equal(
        maximumCheckpoint.start.streamEpoch,
        maximumIntegration.getAuthorityState(SESSION_ID)?.streamEpoch,
        'a promotion may advance the authority wire epoch, but the checkpoint identity must use that active epoch consistently',
      );
      const maximumStart = [...maximumView.output.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-checkpoint:start'
          && frame.mode === 'authoritative'
          && frame.viewGeneration === maximumCheckpoint.viewGeneration
          && frame.checkpointEpoch === maximumCheckpoint.start.checkpointEpoch
      ));
      assert.ok(maximumStart);
      const { type: _maximumStartType, ...maximumStartIdentity } = maximumStart;
      const maximumIdentity = {
        ...maximumStartIdentity,
        sessionId: SESSION_ID,
        connectionId: maximumView.connectionId,
        viewGeneration: maximumCheckpoint.viewGeneration,
      };
      const maximumInvalidAckCount = (): number => maximumView.control.sentFrames.filter(frame => (
        frame.type === 'terminal-checkpoint:rejected' && frame.reason === 'invalid-message'
      )).length;
      const maximumPhysicalDrainCount = (): number => maximumIntegration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
        event.type === 'compatibility-tail-physically-drained'
          && event.connectionId === maximumView.connectionId
      )).length;
      const maximumRejectionsBefore = maximumInvalidAckCount();
      const maximumDrainsBefore = maximumPhysicalDrainCount();
      emitClientFrame(maximumView.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...maximumIdentity,
        drainedThroughSeq: maximumOrdinal64,
      });
      emitClientFrame(maximumView.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...maximumIdentity,
        appliedThroughSeq: maximumOrdinal64,
      });
      assert.equal(
        maximumInvalidAckCount(),
        maximumRejectionsBefore,
        'canonical maximum Ordinal64 apply and drain acknowledgements must not be rejected',
      );
      assert.equal(
        maximumPhysicalDrainCount() > maximumDrainsBefore,
        true,
        'the transaction bound to the maximum legal Ordinal64 must settle after canonical apply and drain acknowledgements',
      );
    } finally {
      maximumIntegration.destroy();
    }
  }

  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(
    productionModule,
    'split',
    fakePty,
    { retainedTerminalInitialOrdinal: { streamEpoch: '9', sourceSeq: '18446744073709551614' } },
  );
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 Ordinal64 checkpoint ACK', 'bash', undefined, { sessionId: SESSION_ID });
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    fakePty.emitData('ordinal64-n-boundary\r\n');
    await session.headlessWriteChain;
    fakePty.emitData('ordinal64-rollover-boundary\r\n');
    await session.headlessWriteChain;
    const rolledOverRetained = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      streamEpoch: string;
      sourceSeq: string;
      snapshotSeq: string;
      oldestRetainedStreamEpoch: string;
      oldestRetainedSeq: string;
    } | undefined;
    assert.ok(rolledOverRetained);
    assert.deepEqual(
      {
        streamEpoch: rolledOverRetained.streamEpoch,
        sourceSeq: rolledOverRetained.sourceSeq,
        snapshotSeq: rolledOverRetained.snapshotSeq,
        oldestRetainedStreamEpoch: rolledOverRetained.oldestRetainedStreamEpoch,
        oldestRetainedSeq: rolledOverRetained.oldestRetainedSeq,
      },
      // Reading the marker without its epoch compares an epoch-scoped ordinal
      // out of scope. The ledger keeps pointing at the rows it still holds;
      // the wire frame below is where the fresh stream reports its own origin.
      {
        streamEpoch: '10',
        sourceSeq: '0',
        snapshotSeq: '0',
        oldestRetainedStreamEpoch: '9',
        oldestRetainedSeq: '18446744073709551615',
      },
      'the committed retained ledger must roll into a fresh canonical Ordinal64 stream while the retained marker stays epoch-qualified to the rows it still holds',
    );
    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const view = await connectProductionView(router, 'split', 702);
    await promoteProductionViews(integration, [view]);
    const checkpoint = await activateRealAdapterCheckpoint(view);
    assert.equal(typeof checkpoint.start.sourceSeq, 'string');
    assert.deepEqual(
      {
        streamEpoch: checkpoint.start.streamEpoch,
        sourceSeq: checkpoint.start.sourceSeq,
        snapshotSeq: checkpoint.start.snapshotSeq,
        oldestRetainedSeq: checkpoint.start.oldestRetainedSeq,
      },
      { streamEpoch: '10', sourceSeq: '0', snapshotSeq: '0', oldestRetainedSeq: '0' },
      'the real adapter must emit the fresh rollover stream checkpoint rather than reuse the exhausted identity',
    );
    assert.equal(integration.getAuthorityState(SESSION_ID)?.streamEpoch, checkpoint.start.streamEpoch);

    fakePty.emitData('ordinal64-held-tail');
    await session.headlessWriteChain;
    let tail: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !tail; attempt += 1) {
      tail = [...view.output.sentFrames].reverse().find(frame => (
        frame.type === 'terminal-checkpoint:output'
          && typeof frame.sourceSeq === 'string'
          && BigInt(frame.sourceSeq) > BigInt(String(checkpoint.start.sourceSeq))
      ));
      if (!tail) await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(tail, 'the active adapter transaction must hold a post-checkpoint output tail for drain settlement');
    assert.equal(
      tail.streamEpoch,
      checkpoint.start.streamEpoch,
      'the post-rollover tail must remain in the fresh checkpoint stream epoch',
    );
    assert.equal(
      tail.sourceSeq,
      '1',
      'the first post-rollover tail must use the fresh canonical Ordinal64 source sequence',
    );
    const activeCheckpoint = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'authoritative'
        && frame.viewGeneration === checkpoint.viewGeneration
        && frame.checkpointEpoch === tail.checkpointEpoch
    ));
    assert.ok(activeCheckpoint, 'the held tail must retain the exact active checkpoint epoch that owns its ACK ledger');
    const { type: _checkpointStartType, ...activeCheckpointIdentity } = activeCheckpoint;
    const identity = {
      ...activeCheckpointIdentity,
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: checkpoint.viewGeneration,
    };

    const physicalDrainCount = (): number => integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
      event.type === 'compatibility-tail-physically-drained'
        && event.connectionId === view.connectionId
    )).length;
    const drainCountBeforeAcks = physicalDrainCount();

    const invalidAckCount = (): number => view.control.sentFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:rejected' && frame.reason === 'invalid-message'
    )).length;
    for (const invalidAppliedThroughSeq of [
      Number(checkpoint.start.snapshotSeq),
      `0${String(checkpoint.start.snapshotSeq)}`,
      'not-an-ordinal',
      '18446744073709551616',
    ] as const) {
      const rejectionCount = invalidAckCount();
      emitClientFrame(view.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...identity,
        appliedThroughSeq: invalidAppliedThroughSeq,
      });
      for (let attempt = 0; attempt < 20 && invalidAckCount() === rejectionCount; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal(
        invalidAckCount(),
        rejectionCount + 1,
        `the active adapter must reject invalid appliedThroughSeq Ordinal64 payload ${String(invalidAppliedThroughSeq)}`,
      );
      assert.equal(
        physicalDrainCount(),
        drainCountBeforeAcks,
        'a rejected apply acknowledgement must not mutate or settle the active checkpoint ledger',
      );
    }
    for (const invalidDrainedThroughSeq of [
      Number(tail.sourceSeq),
      `0${String(tail.sourceSeq)}`,
      'not-an-ordinal',
      '18446744073709551616',
    ] as const) {
      const rejectionCount = invalidAckCount();
      emitClientFrame(view.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...identity,
        drainedThroughSeq: invalidDrainedThroughSeq,
      });
      for (let attempt = 0; attempt < 20 && invalidAckCount() === rejectionCount; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal(
        invalidAckCount(),
        rejectionCount + 1,
        `the active adapter must reject invalid drainedThroughSeq Ordinal64 payload ${String(invalidDrainedThroughSeq)}`,
      );
      assert.equal(
        physicalDrainCount(),
        drainCountBeforeAcks,
        'a rejected drain acknowledgement must not mutate or settle the active checkpoint ledger',
      );
    }
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:drain-ack',
      ...identity,
      drainedThroughSeq: tail.sourceSeq,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      physicalDrainCount(),
      drainCountBeforeAcks,
      'a drain acknowledgement alone must not settle the real held-tail ledger',
    );
    emitClientFrame(view.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...identity,
      appliedThroughSeq: activeCheckpoint.snapshotSeq,
    });
    const ackRejections = view.control.sentFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:rejected' && frame.reason === 'invalid-message'
    ));
    assert.equal(
      physicalDrainCount() > drainCountBeforeAcks,
      true,
      `the same active adapter ledger must settle only after canonical apply and drain acknowledgements; ${JSON.stringify(ackRejections.at(-1))}`,
    );

    const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retained);
    assert.deepEqual(retained.recovery, { authority: 'server', provisionalCacheUsed: false });
    assert.equal(retained.comparer.deliveryAuthority, 'server');
  } finally {
    integration.destroy();
  }
});

test('REL-BGSTAB-007 isolates driver lease ledger and rollback epoch', async () => {
  const productionModule = await loadProductionIntegration('REL-AC-12');
  const fakePty = new AuthorityIntegrationFakePty();
  const integration = createProductionIntegrationFixture(productionModule, 'split', fakePty);
  const manager = integration.sessionManager;
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  try {
    manager.createSession('REL-007 driver lease rollback', 'bash', undefined, { sessionId: SESSION_ID });
    const session = (manager as unknown as SessionManagerAuthorityIntegrationApi).sessions.get(SESSION_ID);
    assert.ok(session);
    fakePty.emitData('driver-lease-retained-marker');
    await session.headlessWriteChain;

    const router = integration.wsRouter as unknown as ExecutableWsRouterApi;
    const driver = await connectProductionView(router, 'split', 703);
    const observer = await connectProductionView(router, 'split', 703);
    await promoteProductionViews(integration, [driver, observer]);
    const [driverServerCheckpoint, observerServerCheckpoint] = await Promise.all([
      activateRealAdapterCheckpoint(driver),
      activateRealAdapterCheckpoint(observer),
    ]);
    const serverState = integration.getAuthorityState(SESSION_ID);
    assert.equal(serverState?.mode, 'server');
    const serverEpoch = serverState?.streamEpoch;
    assert.ok(serverEpoch);
    const retainedDuringServer = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      mode: 'shadow' | 'disabled';
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retainedDuringServer);
    assert.equal(
      retainedDuringServer.mode,
      'shadow',
      'server admission must not redefine the retained model mode',
    );

    assert.equal((await integration.beginRollback({
      sessionId: SESSION_ID,
      selectedCompatibilityView: {
        connectionId: driver.connectionId,
        viewGeneration: driverServerCheckpoint.viewGeneration,
      },
    })).ok, true);
    for (let attempt = 0; attempt < 40
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'rolling-back'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'rolling-back');

    const rollbackFramesFor = async (view: ProductionConnectedView): Promise<{
      rollback: Record<string, unknown>;
      checkpoint: Record<string, unknown>;
    }> => {
      let rollback: Record<string, unknown> | undefined;
      let checkpoint: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40 && (!rollback || !checkpoint); attempt += 1) {
        rollback = [...view.output.sentFrames].reverse().find(frame => (
          frame.type === 'terminal-authority:rollback-start'
        ));
        checkpoint = [...view.output.sentFrames].reverse().find(frame => (
          frame.type === 'terminal-checkpoint:start' && frame.mode === 'compatibility'
        ));
        if (!rollback || !checkpoint) await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(rollback);
      assert.ok(checkpoint);
      const frameTypes = view.output.sentFrames.map(frame => frame.type);
      assert.equal(
        frameTypes.indexOf('terminal-authority:rollback-start')
          < frameTypes.lastIndexOf('terminal-checkpoint:start')
          && frameTypes.lastIndexOf('terminal-checkpoint:start')
            < frameTypes.lastIndexOf('terminal-checkpoint:commit'),
        true,
        'rollback must fence the old authority epoch before its fresh compatibility checkpoint is delivered',
      );
      return { rollback, checkpoint };
    };
    const [driverRollbackFrames, observerRollbackFrames] = await Promise.all([
      rollbackFramesFor(driver),
      rollbackFramesFor(observer),
    ]);
    assert.notEqual(
      driverRollbackFrames.checkpoint.connectionId,
      observerRollbackFrames.checkpoint.connectionId,
      'each view must receive a separately keyed rollback checkpoint ledger',
    );

    const compatibilityIdentity = (
      view: ProductionConnectedView,
      frames: { rollback: Record<string, unknown>; checkpoint: Record<string, unknown> },
    ) => ({
      protocolVersion: frames.checkpoint.protocolVersion,
      sessionId: SESSION_ID,
      connectionId: view.connectionId,
      viewGeneration: Number(frames.checkpoint.viewGeneration),
      transitionEpoch: frames.rollback.transitionEpoch,
      authorityEpoch: frames.rollback.authorityEpoch,
      streamEpoch: frames.checkpoint.streamEpoch,
      checkpointEpoch: frames.checkpoint.checkpointEpoch,
      responderLeaseId: frames.rollback.responderLeaseId,
      boundarySourceSeq: frames.rollback.boundarySourceSeq,
      sourceSeq: frames.checkpoint.sourceSeq,
      snapshotSeq: frames.checkpoint.snapshotSeq,
      oldestRetainedSeq: frames.checkpoint.oldestRetainedSeq,
      retentionPolicyId: frames.checkpoint.retentionPolicyId,
    });
    const driverCompatibilityIdentity = compatibilityIdentity(driver, driverRollbackFrames);
    const observerCompatibilityIdentity = compatibilityIdentity(observer, observerRollbackFrames);
    const observerRejectionsBeforePeerAck = observer.control.sentFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:rejected' && frame.reason === 'invalid-message'
    )).length;
    emitClientFrame(observer.control, {
      type: 'terminal-checkpoint:apply-ack',
      ...driverCompatibilityIdentity,
      appliedThroughSeq: driverRollbackFrames.checkpoint.snapshotSeq,
    });
    for (let attempt = 0; attempt < 20 && observer.control.sentFrames.filter(frame => (
      frame.type === 'terminal-checkpoint:rejected' && frame.reason === 'invalid-message'
    )).length === observerRejectionsBeforePeerAck; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      observer.control.sentFrames.filter(frame => (
        frame.type === 'terminal-checkpoint:rejected' && frame.reason === 'invalid-message'
      )).length,
      observerRejectionsBeforePeerAck + 1,
      'a peer cannot settle another view\'s rollback checkpoint ledger',
    );

    const staleAckAuditCount = integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
      event.type === 'terminal-checkpoint-superseded-ack-ignored'
        && event.connectionId === driver.connectionId
    )).length;
    emitClientFrame(driver.control, {
      type: 'terminal-checkpoint:apply-ack',
      protocolVersion: driverServerCheckpoint.start.protocolVersion,
      sessionId: SESSION_ID,
      connectionId: driver.connectionId,
      viewGeneration: driverServerCheckpoint.viewGeneration,
      streamEpoch: driverServerCheckpoint.start.streamEpoch,
      checkpointEpoch: driverServerCheckpoint.start.checkpointEpoch,
      sourceSeq: driverServerCheckpoint.start.sourceSeq,
      snapshotSeq: driverServerCheckpoint.start.snapshotSeq,
      oldestRetainedSeq: driverServerCheckpoint.start.oldestRetainedSeq,
      retentionPolicyId: driverServerCheckpoint.start.retentionPolicyId,
      transitionEpoch: driverServerCheckpoint.start.transitionEpoch,
      authorityEpoch: driverServerCheckpoint.start.authorityEpoch,
      appliedThroughSeq: driverServerCheckpoint.start.snapshotSeq,
    });
    for (let attempt = 0; attempt < 20 && integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
      event.type === 'terminal-checkpoint-superseded-ack-ignored'
        && event.connectionId === driver.connectionId
    )).length === staleAckAuditCount; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(
      integration.getAuthorityAuditTrail(SESSION_ID).filter(event => (
        event.type === 'terminal-checkpoint-superseded-ack-ignored'
          && event.connectionId === driver.connectionId
    )).length,
      staleAckAuditCount + 1,
      'a stale old-epoch ACK must be fenced from the live rollback ledger',
    );

    const settleView = (
      view: ProductionConnectedView,
      frames: { rollback: Record<string, unknown>; checkpoint: Record<string, unknown> },
      checkpointIdentity: ReturnType<typeof compatibilityIdentity>,
    ): void => {
      const identity = {
        ...checkpointIdentity,
      };
      emitClientFrame(view.control, {
        type: 'terminal-checkpoint:apply-ack',
        ...identity,
        appliedThroughSeq: frames.checkpoint.snapshotSeq,
      });
      emitClientFrame(view.control, {
        type: 'terminal-checkpoint:drain-ack',
        ...identity,
        drainedThroughSeq: frames.checkpoint.sourceSeq,
      });
      emitClientFrame(view.control, {
        type: 'terminal-authority:compatibility-drained',
        ...identity,
        drainedThroughSourceSeq: frames.checkpoint.sourceSeq,
        checkpointApplied: true,
        postSnapshotTailDrained: true,
      });
    };
    settleView(driver, driverRollbackFrames, driverCompatibilityIdentity);
    settleView(observer, observerRollbackFrames, observerCompatibilityIdentity);
    for (let attempt = 0; attempt < 40
      && integration.getAuthorityState(SESSION_ID)?.mode !== 'legacy'; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(integration.getAuthorityState(SESSION_ID)?.mode, 'legacy');
    assert.notEqual(integration.getAuthorityState(SESSION_ID)?.streamEpoch, serverEpoch);
    assert.equal(
      driver.control.sentFrames.some(frame => frame.type === 'terminal-authority:legacy-responder-enabled'),
      true,
    );
    assert.equal(
      observer.control.sentFrames.some(frame => frame.type === 'terminal-authority:legacy-responder-enabled'),
      false,
      'the observer drain must not acquire the selected driver lease',
    );
    const retained = manager.getRetainedTerminalAuthorityState(SESSION_ID) as unknown as {
      mode: 'shadow' | 'disabled';
      recovery: { authority: string; provisionalCacheUsed: boolean };
      comparer: { deliveryAuthority: string };
    } | undefined;
    assert.ok(retained);
    assert.equal(retained.mode, 'shadow', 'legacy rollback must preserve the retained model mode');
    assert.deepEqual(retained.recovery, { authority: 'legacy-local', provisionalCacheUsed: true });
    assert.equal(retained.comparer.deliveryAuthority, 'legacy');
    assert.deepEqual(
      retainedDuringServer.recovery,
      { authority: 'server', provisionalCacheUsed: false },
      'only the actual server authority epoch may advertise server-owned recovery before rollback restores legacy ownership',
    );
    assert.equal(retainedDuringServer.comparer.deliveryAuthority, 'server');
  } finally {
    integration.destroy();
  }
});

async function activateRealAdapterCheckpoint(
  view: ProductionConnectedView,
  options: Readonly<{
    expectedSourceSeq?: string;
    expectedStreamEpoch?: string;
    preparationFrameStart?: number;
  }> = {},
): Promise<{
  preparation: Record<string, unknown>;
  start: Record<string, unknown>;
  chunk: Record<string, unknown>;
  commit: Record<string, unknown>;
  viewGeneration: number;
}> {
  const viewGeneration = view.viewGeneration + 1;
  const controlFrameStart = options.preparationFrameStart;
  const outputFrameStart = view.output.sentFrames.length;
  if (options.preparationFrameStart === undefined) {
    negotiateProductionView(view.control, viewGeneration);
  }
  let preparation: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40 && !preparation; attempt += 1) {
    const controlFrames = controlFrameStart === undefined
      ? view.control.sentFrames
      : view.control.sentFrames.slice(controlFrameStart);
    preparation = [...controlFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:capability'
        && frame.checkpointDeliveryPreparation !== undefined
        && frame.checkpointDeliveryPreparation !== null
        && (frame.checkpointDeliveryPreparation as Record<string, unknown>).viewGeneration === viewGeneration
        && (options.expectedStreamEpoch === undefined
          || (frame.checkpointDeliveryPreparation as Record<string, unknown>).streamEpoch === options.expectedStreamEpoch)
    ))?.checkpointDeliveryPreparation as Record<string, unknown> | undefined;
    if (!preparation) await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(preparation, 'the production adapter must first advertise a control-lane checkpoint-ready preparation');
  assert.equal(
    view.output.sentFrames.slice(outputFrameStart).some(frame => (
      frame.type === 'terminal-checkpoint:start' && frame.viewGeneration === viewGeneration
    )),
    false,
    'base WsRouter handling must not activate a checkpoint before the adapter receives checkpoint-ready',
  );
  emitClientFrame(view.control, {
    type: 'terminal-checkpoint:ready',
    protocolVersion: 1,
    sessionId: SESSION_ID,
    viewGeneration: preparation.viewGeneration,
    authorityEpoch: preparation.authorityEpoch,
    streamEpoch: preparation.streamEpoch,
    driverLeaseGeneration: preparation.driverLeaseGeneration,
    acceptedViewAttributesGeneration: preparation.acceptedViewAttributesGeneration,
    viewAttributesChallengeId: preparation.viewAttributesChallengeId,
    checkpointDeliveryId: preparation.checkpointDeliveryId,
  });
  let start: Record<string, unknown> | undefined;
  let chunk: Record<string, unknown> | undefined;
  let commit: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40 && (!start || !chunk || !commit); attempt += 1) {
    start = [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:start'
        && frame.mode === 'authoritative'
        && frame.viewGeneration === viewGeneration
        && (options.expectedSourceSeq === undefined || frame.sourceSeq === options.expectedSourceSeq)
        && (options.expectedStreamEpoch === undefined || frame.streamEpoch === options.expectedStreamEpoch)
    ));
    const checkpointEpoch = start?.checkpointEpoch;
    chunk = checkpointEpoch === undefined ? undefined : [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:chunk'
        && frame.mode === 'authoritative'
        && frame.viewGeneration === viewGeneration
        && frame.checkpointEpoch === checkpointEpoch
    ));
    commit = checkpointEpoch === undefined ? undefined : [...view.output.sentFrames].reverse().find(frame => (
      frame.type === 'terminal-checkpoint:commit'
        && frame.mode === 'authoritative'
        && frame.viewGeneration === viewGeneration
        && frame.checkpointEpoch === checkpointEpoch
    ));
    if (!start || !chunk || !commit) await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(start, 'the real checkpoint-ready handshake must activate start');
  assert.ok(chunk, 'the real checkpoint-ready handshake must activate chunk delivery');
  assert.ok(commit, 'the real checkpoint-ready handshake must activate commit delivery');
  return { preparation, start, chunk, commit, viewGeneration };
}

test('REL-BGSTAB-012 preserves retained authority across peer disconnect and recovery rollback', async () => {
  const signature = 'REL-BGSTAB-012 AC-7: a peer disconnect rollback must settle delivery interest without pausing retained authority or deleting committed state';
  const contract = await loadContract('REL-AC-12');
  const harness = createHarness(contract);
  await harness.controller.beginPromotion(promotionRequest());
  const hidden = await harness.controller.captureHeadlessOutput({
    sourceSeq: '42',
    data: 'rel012-hidden-output-before-peer-disconnect',
    hidden: true,
  });
  assert.equal(hidden.modelCommitted, true, signature);
  assert.equal(hidden.factCommitted, true, signature);
  assert.equal(harness.controller.getState().ptyPaused, false, signature);
  assert.deepEqual(
    await harness.controller.acknowledgeLegacyDisable(responderIdentity(VIEW_A)),
    { accepted: true, completed: false },
    signature,
  );

  const disconnect = await harness.controller.notifyResponderTopologyChanged({
    transitionEpoch: TRANSITION_EPOCH,
    kind: 'disconnect',
    connectionId: VIEW_A.connectionId,
    viewGeneration: VIEW_A.viewGeneration,
  });
  const recovered = await harness.controller.captureHeadlessOutput({
    sourceSeq: '43',
    data: 'rel012-output-through-rollback',
    hidden: true,
  });

  assert.deepEqual(
    { aborted: disconnect.aborted, restartRequired: disconnect.restartRequired },
    { aborted: true, restartRequired: true },
    signature,
  );
  assert.equal(recovered.modelCommitted, true, signature);
  assert.equal(recovered.factCommitted, true, signature);
  assert.equal(harness.controller.getState().ptyPaused, false, signature);
  assert.equal(
    (harness.controller.getState() as unknown as { peerDisconnectRecoveryAuthority?: unknown }).peerDisconnectRecoveryAuthority,
    'retained-server-model',
    signature,
  );
});
