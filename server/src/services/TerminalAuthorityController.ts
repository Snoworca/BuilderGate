import { isCanonicalOrdinal64 } from '../types/ws-protocol.js';

export type TerminalAuthorityMode = 'legacy' | 'promoting' | 'server' | 'rolling-back' | 'aborted';
export type TerminalAuthorityIngestOwner = 'legacy-browser' | 'server-headless-staged' | 'server-headless';

export interface TerminalAuthorityResponderViewIdentity {
  clientId?: string;
  connectionId: string;
  viewGeneration: number;
  responderLeaseId: string;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  driverLeaseGeneration: string;
  acceptedViewAttributesGeneration: string;
}

export interface TerminalAuthorityResponderIdentity extends TerminalAuthorityResponderViewIdentity {
  sessionId: string;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  boundarySourceSeq: string;
}

export interface TerminalLegacyResponderIdentity extends TerminalAuthorityResponderIdentity {
  driverLeaseId: string;
  checkpointEpoch: string;
  snapshotSeq: string;
  drainedThroughSourceSeq: string;
  checkpointApplied: true;
  postSnapshotTailDrained: true;
  affectedViewCount: number;
}

export interface TerminalAuthorityPromotionRequest {
  sessionId: string;
  authorityEpoch: string;
  previousStreamEpoch: string;
  nextStreamEpoch: string;
  transitionEpoch: string;
  oldResponderLeaseId: string;
  nextResponderLeaseId: string;
  nextDriverLeaseId: string;
}

export interface TerminalAuthorityPromotionResult {
  ok: boolean;
  reason?: string;
  transitionEpoch?: string;
  streamEpoch?: string;
  boundarySourceSeq?: string;
  requiredResponderCount?: number;
}

export interface TerminalAuthorityState {
  mode: TerminalAuthorityMode;
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
  peerDisconnectRecoveryAuthority?: 'retained-server-model';
  ptyPaused: boolean;
  hiddenDeliveryLossy: boolean;
  sessionStatus: 'idle' | 'running' | 'terminated';
}

export interface TerminalAuthorityEvent {
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
  owner?: TerminalAuthorityIngestOwner;
  recordId?: string;
  effectKey?: string;
  data?: string;
  outputDataSha256?: string;
  outputByteLength?: number;
}

export interface TerminalAuthorityControllerOptions {
  initial: {
    sessionId: string;
    authorityEpoch: string;
    streamEpoch: string;
    sessionGeneration: string;
    legacyResponderLeaseId: string;
    legacyDriverLeaseId: string;
    sessionStatus: 'idle';
  };
  readPromotionGates: () => {
    retainedStateParity: boolean;
    factParity: boolean;
    leaseParity: boolean;
    noLocalCacheParity: boolean;
    limitedSessionSelected: boolean;
    allRespondersCapable: boolean;
    replayRepairIdle: boolean;
    queryResponderCapability?: boolean;
  };
  listRequiredResponderViews: () => readonly TerminalAuthorityResponderViewIdentity[];
  readLastCommittedSourceSeq: () => string;
  readPromotionSafetyLimits: () => {
    ackDeadlineMs: number;
    maxHeldOutputBytes: number;
    maxHeldOutputChunks: number;
  };
  now: () => number;
  onOrderedCompatibilityRecoveryRequired: (reason: string) => void;
  enqueueTerminalMessage: (message: object) => boolean | Promise<boolean>;
  emit: (event: TerminalAuthorityEvent) => void;
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
  onLegacyDisableQuorumAccepted?: (input: {
    identity: TerminalAuthorityResponderIdentity;
    acknowledgedViewCount: number;
    requiredResponderViewCount: number;
  }) => boolean | Promise<boolean>;
  installServerAuthorityLeases?: (input: {
    responderLeaseId: string;
    driverLeaseId: string;
  }) => void;
  rotateServerAuthorityEpoch?: (input: {
    previousStreamEpoch: string;
    nextStreamEpoch: string;
    previousResponderLeaseId: string;
    previousDriverLeaseId: string;
  }) => {
    responderLeaseId: string;
    driverLeaseId: string;
  };
  stopNewAdmission: (input: { sessionId: string; transitionEpoch: string }) => void;
  setServerResponderEnabled: (input: { enabled: false; responderLeaseId: string }) => void;
  revokeServerResponderLease: (input: { responderLeaseId: string }) => void;
  revokeServerDriverLease: (input: { driverLeaseId: string }) => void;
  markAffectedViewStale: (
    view: Pick<TerminalAuthorityResponderViewIdentity, 'connectionId' | 'viewGeneration'>,
  ) => void;
  resetAffectedViewParser: (
    view: Pick<TerminalAuthorityResponderViewIdentity, 'connectionId' | 'viewGeneration'>,
  ) => void;
  purgeOldAckBacklog: (input: { sessionId: string; transitionEpoch: string }) => void;
  rebindCompatibilityDriverLease: (input: {
    driverLeaseId: string;
    clientId?: string;
    viewGeneration?: number;
    leaseGeneration?: string;
  }) => void;
  rebindCompatibilityResponderLease: (input: { responderLeaseId: string }) => void;
  commitLegacyResponderIdentity: (input: TerminalLegacyResponderIdentity) => void;
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
  writeLegacyBrowserQueryReply: (effect: {
    reply: string;
    identity: TerminalAuthorityResponderIdentity;
  }) => void;
}

export interface TerminalAuthorityController {
  enqueueHeadlessOutput(input: { streamEpoch?: string; sourceSeq: string; data: string; hidden?: boolean }): {
    recordId: string;
    sourceSeq: string;
    ingestOwnerToken: TerminalAuthorityIngestOwner;
    ownerSelectedAt: 'enqueue';
  };
  applyEnqueuedHeadlessOutput(recordId: string): Promise<AppliedHeadlessOutput>;
  beginPromotion(request: TerminalAuthorityPromotionRequest): Promise<TerminalAuthorityPromotionResult>;
  acknowledgeLegacyDisable(identity: TerminalAuthorityResponderIdentity): Promise<AckResult>;
  captureHeadlessOutput(input: { streamEpoch?: string; sourceSeq: string; data: string; hidden?: boolean }): Promise<AppliedHeadlessOutput>;
  settleQueryEffect(input: {
    recordId: string;
    replyOrdinal: number;
    reply: string;
    streamEpoch: string;
    responderLeaseId: string;
  }): QueryEffectResult;
  acceptLegacyBrowserQueryReply(
    input: TerminalAuthorityResponderIdentity & { replyOrdinal: number; reply: string },
  ): AckResult;
  rejectBrowserParserTail(input: {
    transitionEpoch: string;
    parserTail: string;
  }): Promise<{ accepted: false; reason: string }>;
  recoverView(input: {
    connectionId: string;
    viewGeneration: number;
    cacheState: 'absent' | 'poisoned';
  }): Promise<{
    ok: boolean;
    source: 'server-checkpoint';
    localCacheUsed: false;
    retainedStateHash: string;
    checkpointEpoch: string;
    snapshotSeq: string;
    postSnapshotOutput: readonly string[];
  }>;
  replaceServerAuthorityViews(
    views: readonly TerminalAuthorityResponderViewIdentity[],
  ): { ok: boolean; viewCount?: number; reason?: string };
  replaceLegacyCompatibilityResponderView(
    view: TerminalAuthorityResponderViewIdentity,
  ): { ok: boolean; reason?: string };
  beginRollback(input: RollbackRequest): Promise<{ ok: boolean; reason?: string }>;
  acknowledgeCompatibilityDrain(input: CompatibilityDrainIdentity): Promise<AckResult & { completed: boolean }>;
  notifyResponderTopologyChanged(input: {
    transitionEpoch: string;
    kind: 'new-view' | 'generation-changed' | 'disconnect' | 'unsubscribe';
    connectionId: string;
    viewGeneration: number;
  }): Promise<{ aborted: boolean; restartRequired: boolean; reason: string }>;
  resumeAbortedPromotionRecovery(reason: string): { ok: boolean; reason?: string };
  hasActiveCompatibilityRecoveryTransaction(): boolean;
  restartCompatibilityRecovery(reason: string): { ok: boolean; reason?: string };
  replaceCompatibilityRecoveryViews(
    views: readonly TerminalAuthorityResponderViewIdentity[],
  ): { ok: boolean; reason?: string; viewCount?: number };
  observeInteractiveInput(input: {
    kind: 'user-input' | 'local-echo' | 'prompt-redraw';
  }): Promise<{ sessionStatus: 'idle' | 'running' | 'terminated' }>;
  checkPromotionDeadline(): { abortRequired: boolean; reason?: string };
  readLastCommittedSourceSeq(): string;
  dispose(): void;
  getState(): TerminalAuthorityState;
}

interface AckResult {
  accepted: boolean;
  duplicate?: boolean;
  completed?: boolean;
  completionReceiptSent?: boolean;
  reason?: string;
}

interface AppliedHeadlessOutput {
  recordId: string;
  sourceSeq: string;
  responderLeaseId: string;
  ingestOwner: TerminalAuthorityIngestOwner;
  ingestOwnerToken: TerminalAuthorityIngestOwner;
  commitOwner: 'legacy-browser' | 'server-headless';
  ownerSelectedAt: 'enqueue';
  modelCommitted: boolean;
  factCommitted: boolean;
  authorityContinuity?: 'pty-and-model-preserved';
  deliveryDisposition: 'legacy-delivered' | 'held-post-boundary' | 'server-delivered' | 'compatibility-delivered';
}

interface QueryEffectResult {
  disposition: 'applied' | 'duplicate' | 'legacy-owned' | 'held-for-legacy' | 'rejected' | 'failed';
  owner: TerminalAuthorityIngestOwner;
  effectKey: string;
}

interface RollbackRequest {
  transitionEpoch: string;
  nextStreamEpoch: string;
  compatibilityCheckpointEpoch: string;
  nextCompatibilityResponderLeaseId: string;
  nextCompatibilityDriverLeaseId: string;
  nextCompatibilityDriverLeaseGeneration: string;
  nextAcceptedViewAttributesGeneration: string;
  selectedCompatibilityResponder: TerminalAuthorityResponderViewIdentity & {
    driverLeaseId: string;
  };
}

interface CompatibilityDrainIdentity {
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
}

interface PendingOutput {
  recordId: string;
  streamEpoch: string;
  sourceSeq: string;
  data: string;
  hidden: boolean;
  ingestOwnerToken: TerminalAuthorityIngestOwner;
  settled: Promise<void>;
  settle(): void;
  applying?: Promise<AppliedHeadlessOutput>;
}

interface HeldQueryEffect {
  effectKey: string;
  sourceSeq: string;
  reply: string;
  transferred: boolean;
}

interface RollbackContext {
  request: RollbackRequest;
  affectedViews: TerminalAuthorityResponderViewIdentity[];
  snapshotSeq: string;
  boundarySourceSeq: string;
  drainedThroughSourceSeq: string;
  drainTargetLocked: boolean;
  acceptedDrains: Map<string, string>;
  heldQueries: HeldQueryEffect[];
  checkpointDeliverySettled: boolean;
  pendingCompatibilityOutputs: Array<{ output: AppliedHeadlessOutput; data: string }>;
  pendingCompatibilityBytes: number;
}

const UINT64_MAX = 18_446_744_073_709_551_615n;
const TERMINAL_AUTHORITY_SETTLEMENT_LEDGER_MAX_ENTRIES = 2_048;

function setBoundedLedger<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  while (map.size > TERMINAL_AUTHORITY_SETTLEMENT_LEDGER_MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function addBoundedLedgerValue<T>(set: Set<T>, value: T): void {
  set.add(value);
  while (set.size > TERMINAL_AUTHORITY_SETTLEMENT_LEDGER_MAX_ENTRIES) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

function viewKey(view: Pick<TerminalAuthorityResponderViewIdentity, 'connectionId' | 'viewGeneration'>): string {
  return `${view.connectionId}\u0000${view.viewGeneration}`;
}

function ordinalGreaterThan(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function isSafeReplyOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cloneView(view: TerminalAuthorityResponderViewIdentity): TerminalAuthorityResponderViewIdentity {
  return { ...view };
}

function responderViewSetsMatch(
  expected: readonly TerminalAuthorityResponderViewIdentity[],
  actual: readonly TerminalAuthorityResponderViewIdentity[],
): boolean {
  if (expected.length !== actual.length) return false;
  const actualByKey = new Map(actual.map(view => [viewKey(view), view]));
  return expected.every(view => {
    const candidate = actualByKey.get(viewKey(view));
    return candidate !== undefined
      && candidate.clientId === view.clientId
      && candidate.responderLeaseId === view.responderLeaseId
      && candidate.queryReplyCapability === view.queryReplyCapability
      && candidate.parserResponderCapability === view.parserResponderCapability
      && candidate.driverLeaseGeneration === view.driverLeaseGeneration
      && candidate.acceptedViewAttributesGeneration === view.acceptedViewAttributesGeneration;
  });
}

/**
 * Session-scoped authority epoch state machine. All external mutations are
 * expressed as ports so SessionManager and WsRouter remain thin adapters.
 *
 * @req MIG-BGSTAB-002 AC-1 AC-2 AC-3 AC-4 AC-5 AC-6
 * @req REL-BGSTAB-007 AC-12
 */
export function createTerminalAuthorityController(
  options: TerminalAuthorityControllerOptions,
): TerminalAuthorityController {
  const state: TerminalAuthorityState = {
    mode: 'legacy',
    sessionId: options.initial.sessionId,
    authorityEpoch: options.initial.authorityEpoch,
    streamEpoch: options.initial.streamEpoch,
    transitionEpoch: null,
    activeResponder: 'legacy-browser',
    activeResponderLeaseId: options.initial.legacyResponderLeaseId,
    activeDriverLeaseId: options.initial.legacyDriverLeaseId,
    legacyResponderEnabled: true,
    serverResponderEnabled: false,
    admissionOpen: 'legacy',
    frozenRequiredResponderCount: 0,
    acceptedDisableAckCount: 0,
    heldPostBoundaryCount: 0,
    pendingDeliveryBytes: 0,
    pendingDeliveryChunks: 0,
    restartRequired: false,
    ptyPaused: false,
    hiddenDeliveryLossy: false,
    sessionStatus: options.initial.sessionStatus,
  };
  const pendingOutputs = new Map<string, PendingOutput>();
  const appliedOutputs = new Map<string, AppliedHeadlessOutput>();
  const heldPostBoundary: Array<{ output: AppliedHeadlessOutput; data: string }> = [];
  const acceptedDisableAcks = new Set<string>();
  const queryEffects = new Map<string, { reply: string; disposition: QueryEffectResult['disposition'] }>();
  const acceptedLegacyReplies = new Set<string>();
  let recordCounter = 0;
  let frozenViews: TerminalAuthorityResponderViewIdentity[] = [];
  let boundarySourceSeq = options.readLastCommittedSourceSeq();
  let lastCommittedSourceSeq: string | null = null;
  const lastCommittedSourceSeqByStream = new Map<string, string>();
  let previousStreamEpoch = options.initial.streamEpoch;
  let previousLegacyResponderLeaseId = options.initial.legacyResponderLeaseId;
  let previousLegacyDriverLeaseId = options.initial.legacyDriverLeaseId;
  let promotionStartedAt = 0;
  let nextServerResponderLeaseId: string | null = null;
  let nextServerDriverLeaseId: string | null = null;
  let rollback: RollbackContext | null = null;
  const restartedHeldQueries: HeldQueryEffect[] = [];
  let recoveryRequested = false;
  let serverAuthorityLeasesInstalled = false;
  let terminalDeliverySettlementChain: Promise<void> = Promise.resolve();
  let promotionCommitTransaction: Promise<AckResult> | null = null;
  let promotionCommitToken: symbol | null = null;
  let compatibilityCommitTransaction: Promise<AckResult & { completed: boolean }> | null = null;
  let compatibilityCommitToken: symbol | null = null;
  let compatibilityCommitRollback: RollbackContext | null = null;
  let promotionBeginToken: symbol | null = null;
  let rollbackBeginToken: symbol | null = null;
  let deliveryGeneration = 0;
  let disposed = false;
  let promotionAdmissionFenced = false;

  const enqueue = async (message: object): Promise<boolean> => (
    (await options.enqueueTerminalMessage(message)) !== false
  );
  const emit = (event: TerminalAuthorityEvent): void => options.emit(event);

  const emitOutput = (
    data: string,
    sourceSeq: string,
    streamEpoch: string,
    responderLeaseId: string,
  ): Promise<boolean> => enqueue({
    type: 'output',
    sessionId: state.sessionId,
    data,
    sourceSeq,
    streamEpoch,
    responderLeaseId,
  });

  const validateFrozenView = (
    identity: Pick<TerminalAuthorityResponderIdentity, 'connectionId' | 'viewGeneration'>,
  ): TerminalAuthorityResponderViewIdentity | undefined => frozenViews.find(
    view => view.connectionId === identity.connectionId
      && view.viewGeneration === identity.viewGeneration,
  );

  const fullPromotionIdentityMatches = (
    identity: TerminalAuthorityResponderIdentity,
    expectedStreamEpoch: string,
    expectedLeaseId: string,
  ): boolean => {
    const frozen = validateFrozenView(identity);
    return frozen !== undefined
      && identity.sessionId === state.sessionId
      && identity.transitionEpoch === state.transitionEpoch
      && identity.authorityEpoch === state.authorityEpoch
      && identity.streamEpoch === expectedStreamEpoch
      && identity.boundarySourceSeq === boundarySourceSeq
      && identity.responderLeaseId === expectedLeaseId
      && identity.queryReplyCapability === frozen.queryReplyCapability
      && identity.parserResponderCapability === frozen.parserResponderCapability
      && identity.driverLeaseGeneration === frozen.driverLeaseGeneration
      && identity.acceptedViewAttributesGeneration === frozen.acceptedViewAttributesGeneration;
  };

  const markAllFrozenViewsStale = (): void => {
    for (const view of frozenViews) {
      options.markAffectedViewStale({
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
      });
    }
  };

  const readCurrentCommittedSourceSeq = (): string => {
    const external = options.readLastCommittedSourceSeq();
    const committed = lastCommittedSourceSeqByStream.get(state.streamEpoch);
    if (!committed) {
      if (!lastCommittedSourceSeq) return external;
      if (!isCanonicalOrdinal64(external)) return lastCommittedSourceSeq;
      return ordinalGreaterThan(lastCommittedSourceSeq, external)
        ? lastCommittedSourceSeq
        : external;
    }
    if (!isCanonicalOrdinal64(external)) return committed;
    return ordinalGreaterThan(committed, external) ? committed : external;
  };

  const requestOrderedCompatibilityRecovery = (reason: string): void => {
    if (recoveryRequested) return;
    recoveryRequested = true;
    promotionBeginToken = null;
    state.mode = 'rolling-back';
    state.admissionOpen = 'none';
    acceptedDisableAcks.clear();
    state.acceptedDisableAckCount = 0;
    markAllFrozenViewsStale();
    options.purgeOldAckBacklog({
      sessionId: state.sessionId,
      transitionEpoch: state.transitionEpoch ?? state.streamEpoch,
    });
    emit({ type: 'affected-views-stale', sessionId: state.sessionId });
    emit({ type: 'old-ack-backlog-purged', sessionId: state.sessionId });
    emit({ type: 'ordered-compatibility-recovery-started', sessionId: state.sessionId });
    options.onOrderedCompatibilityRecoveryRequired(reason);
  };

  const rekeyActiveServerAuthorityEpoch = (
    nextStreamEpoch: string,
  ): { ok: boolean; reason?: string } => {
    if (state.mode !== 'server') return { ok: false, reason: 'authority-not-server' };
    if (!isCanonicalOrdinal64(nextStreamEpoch)
      || !ordinalGreaterThan(nextStreamEpoch, state.streamEpoch)) {
      return { ok: false, reason: 'server-epoch-rotation-invalid' };
    }
    const previousResponderLeaseId = state.activeResponderLeaseId;
    const previousDriverLeaseId = state.activeDriverLeaseId;
    if (!previousResponderLeaseId || !previousDriverLeaseId || !options.rotateServerAuthorityEpoch) {
      return { ok: false, reason: 'server-epoch-rotation-unavailable' };
    }
    let rotated: ReturnType<NonNullable<TerminalAuthorityControllerOptions['rotateServerAuthorityEpoch']>>;
    try {
      rotated = options.rotateServerAuthorityEpoch({
        previousStreamEpoch: state.streamEpoch,
        nextStreamEpoch,
        previousResponderLeaseId,
        previousDriverLeaseId,
      });
    } catch {
      return { ok: false, reason: 'server-epoch-rotation-rejected' };
    }
    if (!nonEmpty(rotated.responderLeaseId) || !nonEmpty(rotated.driverLeaseId)) {
      return { ok: false, reason: 'server-epoch-lease-missing' };
    }
    state.streamEpoch = nextStreamEpoch;
    state.transitionEpoch = nextStreamEpoch;
    state.activeResponderLeaseId = rotated.responderLeaseId;
    state.activeDriverLeaseId = rotated.driverLeaseId;
    nextServerResponderLeaseId = rotated.responderLeaseId;
    nextServerDriverLeaseId = rotated.driverLeaseId;
    serverAuthorityLeasesInstalled = true;
    emit({
      type: 'server-authority-epoch-rekeyed',
      sessionId: state.sessionId,
      streamEpoch: nextStreamEpoch,
      transitionEpoch: nextStreamEpoch,
      responderLeaseId: rotated.responderLeaseId,
      driverLeaseId: rotated.driverLeaseId,
    });
    return { ok: true };
  };

  const clearPendingCompatibilityOutputs = (context: RollbackContext): void => {
    state.pendingDeliveryBytes = Math.max(
      0,
      state.pendingDeliveryBytes - context.pendingCompatibilityBytes,
    );
    state.pendingDeliveryChunks = Math.max(
      0,
      state.pendingDeliveryChunks - context.pendingCompatibilityOutputs.length,
    );
    context.pendingCompatibilityBytes = 0;
    context.pendingCompatibilityOutputs.length = 0;
  };

  const invalidateActiveRollbackForFreshRecovery = (
    context: RollbackContext,
    reason: string,
  ): boolean => {
    if (rollback !== context) return false;
    const heldQueryLimit = Math.max(0, options.readPromotionSafetyLimits().maxHeldOutputChunks);
    const availableHeldQuerySlots = Math.max(0, heldQueryLimit - restartedHeldQueries.length);
    restartedHeldQueries.push(
      ...context.heldQueries.filter(effect => !effect.transferred).slice(0, availableHeldQuerySlots),
    );
    clearPendingCompatibilityOutputs(context);
    rollback = null;
    rollbackBeginToken = null;
    compatibilityCommitToken = null;
    compatibilityCommitRollback = null;
    recoveryRequested = true;
    state.mode = 'rolling-back';
    state.admissionOpen = 'none';
    markAllFrozenViewsStale();
    options.purgeOldAckBacklog({
      sessionId: state.sessionId,
      transitionEpoch: state.transitionEpoch ?? state.streamEpoch,
    });
    emit({ type: 'compatibility-recovery-restarted', kind: reason, sessionId: state.sessionId });
    options.onOrderedCompatibilityRecoveryRequired(reason);
    return true;
  };

  const queueTerminalDelivery = (
    deliver: () => Promise<boolean>,
    failureReason: string,
    onSettled?: () => void,
    isTransactionCurrent?: () => boolean,
  ): Promise<boolean> => {
    const generation = deliveryGeneration;
    const settle = async (): Promise<boolean> => {
      if (disposed || generation !== deliveryGeneration) return false;
      if (isTransactionCurrent && !isTransactionCurrent()) return false;
      try {
        const accepted = await deliver();
        if (disposed || generation !== deliveryGeneration) return false;
        if (isTransactionCurrent && !isTransactionCurrent()) return false;
        if (!accepted) {
          requestOrderedCompatibilityRecovery(failureReason);
          return false;
        }
        onSettled?.();
        return true;
      } catch {
        if (disposed || generation !== deliveryGeneration) return false;
        if (isTransactionCurrent && !isTransactionCurrent()) return false;
        requestOrderedCompatibilityRecovery(failureReason);
        return false;
      }
    };
    const result = terminalDeliverySettlementChain.then(settle, settle);
    terminalDeliverySettlementChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const queueOutputDelivery = (
    data: string,
    sourceSeq: string,
    streamEpoch: string,
    responderLeaseId: string,
    failureReason: string,
    onSettled?: () => void,
    isTransactionCurrent?: () => boolean,
  ): Promise<boolean> => {
    const bytes = Buffer.byteLength(data, 'utf8');
    const limits = options.readPromotionSafetyLimits();
    if (state.pendingDeliveryBytes + bytes > limits.maxHeldOutputBytes
      || state.pendingDeliveryChunks + 1 > limits.maxHeldOutputChunks) {
      requestOrderedCompatibilityRecovery('output-delivery-backlog-overflow');
      return Promise.resolve(false);
    }
    state.pendingDeliveryBytes += bytes;
    state.pendingDeliveryChunks += 1;
    return queueTerminalDelivery(
      () => emitOutput(data, sourceSeq, streamEpoch, responderLeaseId),
      failureReason,
      onSettled,
      isTransactionCurrent,
    ).finally(() => {
      state.pendingDeliveryBytes = Math.max(0, state.pendingDeliveryBytes - bytes);
      state.pendingDeliveryChunks = Math.max(0, state.pendingDeliveryChunks - 1);
    });
  };

  const releasePromotedAuthority = async (isTransactionCurrent: () => boolean): Promise<boolean> => {
    if (!nextServerResponderLeaseId || !nextServerDriverLeaseId) {
      throw new Error('server-authority-lease-missing');
    }
    let recovery: ReturnType<TerminalAuthorityControllerOptions['loadAuthoritativeRecovery']>;
    try {
      recovery = options.loadAuthoritativeRecovery();
    } catch {
      requestOrderedCompatibilityRecovery('authoritative-recovery-preflight-failed');
      return false;
    }
    try {
      options.installServerAuthorityLeases?.({
        responderLeaseId: nextServerResponderLeaseId,
        driverLeaseId: nextServerDriverLeaseId,
      });
      serverAuthorityLeasesInstalled = true;
    } catch {
      requestOrderedCompatibilityRecovery('server-authority-lease-install-failed');
      return false;
    }
    const discardInstalledServerAuthorityLeases = (): void => {
      if (!serverAuthorityLeasesInstalled) return;
      try {
        options.revokeServerResponderLease({ responderLeaseId: nextServerResponderLeaseId! });
      } catch { /* retain the externally selected fail-closed state */ }
      try {
        options.revokeServerDriverLease({ driverLeaseId: nextServerDriverLeaseId! });
      } catch { /* retain the externally selected fail-closed state */ }
      serverAuthorityLeasesInstalled = false;
    };
    if (!isTransactionCurrent()) {
      discardInstalledServerAuthorityLeases();
      return false;
    }
    for (const message of recovery.checkpointMessages) {
      if (!await queueTerminalDelivery(
        () => enqueue(message),
        'authoritative-checkpoint-enqueue-failed',
      )) {
        return false;
      }
      if (!isTransactionCurrent()) {
        discardInstalledServerAuthorityLeases();
        return false;
      }
    }
    emit({ type: 'fresh-authoritative-checkpoint-enqueued', sourceSeq: recovery.snapshotSeq });
    for (let heldIndex = 0; heldIndex < heldPostBoundary.length; heldIndex += 1) {
      const held = heldPostBoundary[heldIndex]!;
      if (!ordinalGreaterThan(held.output.sourceSeq, recovery.snapshotSeq)) {
        emit({
          type: 'held-output-covered-by-checkpoint',
          sessionId: state.sessionId,
          sourceSeq: held.output.sourceSeq,
        });
        continue;
      }
      if (!await queueOutputDelivery(
        held.data,
        held.output.sourceSeq,
        state.streamEpoch,
        nextServerResponderLeaseId!,
        'held-output-enqueue-failed',
      )) {
        return false;
      }
      if (!isTransactionCurrent()) {
        discardInstalledServerAuthorityLeases();
        return false;
      }
    }
    if (!isTransactionCurrent()) {
      discardInstalledServerAuthorityLeases();
      return false;
    }
    if (heldPostBoundary.length > 0) emit({ type: 'held-output-released', sessionId: state.sessionId });
    heldPostBoundary.length = 0;
    state.heldPostBoundaryCount = 0;
    state.mode = 'server';
    state.activeResponder = 'server-headless';
    state.activeResponderLeaseId = nextServerResponderLeaseId;
    state.activeDriverLeaseId = nextServerDriverLeaseId;
    state.legacyResponderEnabled = false;
    state.serverResponderEnabled = true;
    state.admissionOpen = 'server';
    emit({ type: 'legacy-driver-lease-revoked', driverLeaseId: previousLegacyDriverLeaseId });
    emit({ type: 'server-driver-lease-installed', driverLeaseId: nextServerDriverLeaseId ?? undefined });
    emit({ type: 'server-responder-enabled', responderLeaseId: nextServerResponderLeaseId ?? undefined });
    return true;
  };

  const validatePromotionRequest = (
    request: TerminalAuthorityPromotionRequest,
  ): { ok: true; views: TerminalAuthorityResponderViewIdentity[] } | { ok: false; reason: string } => {
    if (state.mode !== 'legacy') return { ok: false, reason: 'authority-not-legacy' };
    if (request.sessionId !== state.sessionId) return { ok: false, reason: 'sessionId-mismatch' };
    if (request.authorityEpoch !== state.authorityEpoch || !nonEmpty(request.authorityEpoch)) {
      return { ok: false, reason: 'authorityEpoch-mismatch' };
    }
    if (request.previousStreamEpoch !== state.streamEpoch) return { ok: false, reason: 'previousStreamEpoch-mismatch' };
    if (!isCanonicalOrdinal64(request.nextStreamEpoch)
      || !isCanonicalOrdinal64(request.transitionEpoch)
      || request.nextStreamEpoch !== request.transitionEpoch
      || !ordinalGreaterThan(request.nextStreamEpoch, request.previousStreamEpoch)
      || BigInt(request.nextStreamEpoch) > UINT64_MAX) {
      return { ok: false, reason: 'nextStreamEpoch-invalid' };
    }
    if (request.oldResponderLeaseId !== state.activeResponderLeaseId) {
      return { ok: false, reason: 'oldResponderLeaseId-mismatch' };
    }
    if (!nonEmpty(request.nextResponderLeaseId) || !nonEmpty(request.nextDriverLeaseId)) {
      return { ok: false, reason: 'next-lease-missing' };
    }
    const gates = options.readPromotionGates();
    for (const [name, passed] of Object.entries(gates)) {
      if (!passed) return { ok: false, reason: `${name}-gate-failed` };
    }
    const views = options.listRequiredResponderViews().map(cloneView);
    if (views.length === 0) return { ok: false, reason: 'required-responder-views-empty' };
    const keys = new Set<string>();
    for (const view of views) {
      const key = viewKey(view);
      if (keys.has(key)
        || view.responderLeaseId !== request.oldResponderLeaseId
        || view.queryReplyCapability !== 'terminal.query-reply-input.v1'
        || view.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
        || view.driverLeaseGeneration !== request.previousStreamEpoch
        || view.acceptedViewAttributesGeneration !== request.previousStreamEpoch) {
        return { ok: false, reason: 'required-responder-view-invalid' };
      }
      keys.add(key);
    }
    return { ok: true, views };
  };

  const controller: TerminalAuthorityController = {
    enqueueHeadlessOutput(input) {
      if (state.mode === 'server'
        && input.streamEpoch !== undefined
        && isCanonicalOrdinal64(input.streamEpoch)
        && ordinalGreaterThan(input.streamEpoch, state.streamEpoch)) {
        const rekeyed = rekeyActiveServerAuthorityEpoch(input.streamEpoch);
        if (!rekeyed.ok) {
          requestOrderedCompatibilityRecovery(rekeyed.reason ?? 'server-epoch-rotation-failed');
        }
      }
      const ingestOwnerToken: TerminalAuthorityIngestOwner = state.mode === 'server'
        ? 'server-headless'
        : state.mode === 'legacy' && !promotionAdmissionFenced
          ? 'legacy-browser'
          : 'server-headless-staged';
      const recordId = `${options.initial.sessionGeneration}:${++recordCounter}`;
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      pendingOutputs.set(recordId, {
        recordId,
        streamEpoch: input.streamEpoch ?? state.streamEpoch,
        sourceSeq: input.sourceSeq,
        data: input.data,
        hidden: input.hidden === true,
        ingestOwnerToken,
        settled,
        settle,
      });
      emit({
        type: 'headless-output-enqueued',
        sessionId: state.sessionId,
        sourceSeq: input.sourceSeq,
        owner: ingestOwnerToken,
        recordId,
      });
      return {
        recordId,
        sourceSeq: input.sourceSeq,
        ingestOwnerToken,
        ownerSelectedAt: 'enqueue',
      };
    },

    async applyEnqueuedHeadlessOutput(recordId) {
      const pending = pendingOutputs.get(recordId);
      if (!pending) {
        const applied = appliedOutputs.get(recordId);
        if (applied) return applied;
        throw new Error('unknown-headless-output-record');
      }
      if (pending.applying) return pending.applying;
      pending.applying = (async () => {
        const commitOwner = pending.ingestOwnerToken === 'legacy-browser'
          ? 'legacy-browser' as const
          : 'server-headless' as const;
        emit({
          type: 'headless-model-committed',
          sessionId: state.sessionId,
          sourceSeq: pending.sourceSeq,
          owner: pending.ingestOwnerToken,
          recordId,
          data: pending.data,
        });
        emit({
          type: 'headless-fact-committed',
          sessionId: state.sessionId,
          sourceSeq: pending.sourceSeq,
          owner: pending.ingestOwnerToken,
          recordId,
          data: pending.data,
        });
        if (isCanonicalOrdinal64(pending.sourceSeq)
          && (lastCommittedSourceSeq === null
            || ordinalGreaterThan(pending.sourceSeq, lastCommittedSourceSeq))) {
          lastCommittedSourceSeq = pending.sourceSeq;
        }
        const committedInStream = lastCommittedSourceSeqByStream.get(pending.streamEpoch);
        if (
          isCanonicalOrdinal64(pending.streamEpoch)
          && isCanonicalOrdinal64(pending.sourceSeq)
          && (committedInStream === undefined || ordinalGreaterThan(pending.sourceSeq, committedInStream))
        ) {
          lastCommittedSourceSeqByStream.set(pending.streamEpoch, pending.sourceSeq);
        }

        let deliveryDisposition: AppliedHeadlessOutput['deliveryDisposition'];
        const responderLeaseId = state.mode === 'rolling-back'
          ? rollback?.request.nextCompatibilityResponderLeaseId ?? state.activeResponderLeaseId ?? ''
          : nextServerResponderLeaseId ?? state.activeResponderLeaseId ?? '';
        const applied: AppliedHeadlessOutput = {
          recordId,
          sourceSeq: pending.sourceSeq,
          responderLeaseId,
          ingestOwner: pending.ingestOwnerToken,
          ingestOwnerToken: pending.ingestOwnerToken,
          commitOwner,
          ownerSelectedAt: 'enqueue',
          modelCommitted: true,
          factCommitted: true,
          ...(state.mode === 'rolling-back' && pending.ingestOwnerToken === 'server-headless-staged'
            ? { authorityContinuity: 'pty-and-model-preserved' as const }
            : {}),
          deliveryDisposition: 'legacy-delivered',
        };
        if (state.mode === 'promoting') {
          deliveryDisposition = 'held-post-boundary';
          heldPostBoundary.push({ output: applied, data: pending.data });
          state.heldPostBoundaryCount = heldPostBoundary.length;
          const limits = options.readPromotionSafetyLimits();
          const heldBytes = heldPostBoundary.reduce(
            (total, entry) => total + Buffer.byteLength(entry.data, 'utf8'),
            0,
          );
          if (heldBytes > limits.maxHeldOutputBytes
            || heldPostBoundary.length > limits.maxHeldOutputChunks) {
            requestOrderedCompatibilityRecovery('post-boundary-hold-overflow');
          }
        } else if (state.mode === 'server') {
          deliveryDisposition = 'server-delivered';
          void queueOutputDelivery(
            pending.data,
            pending.sourceSeq,
            state.streamEpoch,
            state.activeResponderLeaseId!,
            'server-output-settlement-failed',
          );
        } else if (state.mode === 'rolling-back' && rollback) {
          deliveryDisposition = 'compatibility-delivered';
          if (!rollback.drainTargetLocked && rollback.drainedThroughSourceSeq !== pending.sourceSeq) {
            rollback.drainedThroughSourceSeq = pending.sourceSeq;
            rollback.acceptedDrains.clear();
          }
          if (!rollback.checkpointDeliverySettled) {
            const bytes = Buffer.byteLength(pending.data, 'utf8');
            const limits = options.readPromotionSafetyLimits();
            if (state.pendingDeliveryBytes + bytes > limits.maxHeldOutputBytes
              || state.pendingDeliveryChunks + 1 > limits.maxHeldOutputChunks) {
              invalidateActiveRollbackForFreshRecovery(
                rollback,
                'compatibility-output-hold-overflow',
              );
            } else {
              rollback.pendingCompatibilityOutputs.push({ output: applied, data: pending.data });
              rollback.pendingCompatibilityBytes += bytes;
              state.pendingDeliveryBytes += bytes;
              state.pendingDeliveryChunks += 1;
            }
          } else {
            const deliveryRollback = rollback;
            void queueOutputDelivery(
              pending.data,
              pending.sourceSeq,
              state.streamEpoch,
              rollback.request.nextCompatibilityResponderLeaseId,
              'compatibility-output-settlement-failed',
              () => emit({
                type: 'compatibility-tail-enqueued',
                sessionId: state.sessionId,
                sourceSeq: pending.sourceSeq,
              }),
              () => rollback === deliveryRollback
                && state.mode === 'rolling-back'
                && state.streamEpoch === deliveryRollback.request.nextStreamEpoch,
            );
          }
        } else if (state.mode === 'rolling-back') {
          // A fresh compatibility checkpoint will be serialized from the
          // authoritative model. Do not retain or emit unfenced tail while the
          // replacement rollback context has not been established.
          deliveryDisposition = 'compatibility-delivered';
        } else {
          deliveryDisposition = 'legacy-delivered';
          void queueOutputDelivery(
            pending.data,
            pending.sourceSeq,
            state.streamEpoch,
            state.activeResponderLeaseId!,
            'legacy-output-settlement-failed',
          );
        }
        applied.deliveryDisposition = deliveryDisposition;
        setBoundedLedger(appliedOutputs, recordId, applied);
        pendingOutputs.delete(recordId);
        pending.settle();
        return applied;
      })();
      return pending.applying;
    },

    async beginPromotion(request) {
      if (state.mode === 'legacy' && promotionAdmissionFenced) {
        return { ok: false, reason: 'promotion-begin-in-flight' };
      }
      const validation = validatePromotionRequest(request);
      if (!validation.ok) return { ok: false, reason: validation.reason };
      options.stopNewAdmission({
        sessionId: state.sessionId,
        transitionEpoch: request.transitionEpoch,
      });
      promotionAdmissionFenced = true;
      frozenViews = validation.views;
      const prefix = [...pendingOutputs.values()]
        .filter(output => output.ingestOwnerToken === 'legacy-browser')
        .map(output => output.settled);
      await Promise.all(prefix);
      const currentViews = options.listRequiredResponderViews().map(cloneView);
      const responderTopologyChanged = !responderViewSetsMatch(frozenViews, currentViews);
      previousStreamEpoch = state.streamEpoch;
      previousLegacyResponderLeaseId = request.oldResponderLeaseId;
      previousLegacyDriverLeaseId = state.activeDriverLeaseId ?? previousLegacyDriverLeaseId;
      boundarySourceSeq = readCurrentCommittedSourceSeq();
      state.mode = 'promoting';
      delete state.peerDisconnectRecoveryAuthority;
      state.transitionEpoch = request.transitionEpoch;
      state.streamEpoch = request.nextStreamEpoch;
      state.admissionOpen = 'none';
      state.frozenRequiredResponderCount = frozenViews.length;
      state.acceptedDisableAckCount = 0;
      state.restartRequired = false;
      acceptedDisableAcks.clear();
      nextServerResponderLeaseId = request.nextResponderLeaseId;
      nextServerDriverLeaseId = request.nextDriverLeaseId;
      promotionStartedAt = options.now();
      recoveryRequested = false;
      const beginToken = Symbol('promotion-begin');
      promotionBeginToken = beginToken;
      const isPromotionBeginCurrent = (): boolean => promotionBeginToken === beginToken
        && state.mode === 'promoting'
        && state.transitionEpoch === request.transitionEpoch
        && state.streamEpoch === request.nextStreamEpoch
        && !recoveryRequested;
      if (responderTopologyChanged) {
        requestOrderedCompatibilityRecovery(
          'required-responder-topology-changed-before-boundary',
        );
        return {
          ok: false,
          reason: 'required-responder-topology-changed-before-boundary',
        };
      }
      emit({
        type: 'headless-write-chain-fenced',
        sessionId: state.sessionId,
        sourceSeq: boundarySourceSeq,
        streamEpoch: state.streamEpoch,
      });
      const boundaryAccepted = await queueTerminalDelivery(
        () => enqueue({
          type: 'terminal-authority:responder-disable-boundary',
          sessionId: state.sessionId,
          transitionEpoch: request.transitionEpoch,
          authorityEpoch: state.authorityEpoch,
          streamEpoch: request.nextStreamEpoch,
          boundarySourceSeq,
          responderLeaseId: request.oldResponderLeaseId,
          requiredResponderViews: frozenViews.map(cloneView),
        }),
        'responder-disable-boundary-enqueue-failed',
        undefined,
        isPromotionBeginCurrent,
      );
      if (!isPromotionBeginCurrent()) {
        return { ok: false, reason: 'promotion-boundary-invalidated' };
      }
      if (!boundaryAccepted) {
        return { ok: false, reason: 'responder-disable-boundary-enqueue-failed' };
      }
      promotionBeginToken = null;
      return {
        ok: true,
        transitionEpoch: request.transitionEpoch,
        streamEpoch: request.nextStreamEpoch,
        boundarySourceSeq,
        requiredResponderCount: frozenViews.length,
      };
    },

    async acknowledgeLegacyDisable(identity) {
      if (state.mode !== 'promoting'
        || !fullPromotionIdentityMatches(identity, state.streamEpoch, previousLegacyResponderLeaseId)) {
        return { accepted: false, reason: 'responder-disable-identity-mismatch' };
      }
      const key = viewKey(identity);
      if (acceptedDisableAcks.has(key)) {
        if (promotionCommitTransaction) {
          const result = await promotionCommitTransaction;
          return { ...result, duplicate: true };
        }
        return {
          accepted: true,
          duplicate: true,
          completed: acceptedDisableAcks.size === frozenViews.length,
        };
      }
      acceptedDisableAcks.add(key);
      state.acceptedDisableAckCount = acceptedDisableAcks.size;
      const completed = acceptedDisableAcks.size === frozenViews.length;
      if (!completed) return { accepted: true, completed: false };
      const token = Symbol('promotion-commit');
      const expectedTransitionEpoch = state.transitionEpoch;
      const expectedStreamEpoch = state.streamEpoch;
      const expectedResponderLeaseId = nextServerResponderLeaseId;
      const expectedDriverLeaseId = nextServerDriverLeaseId;
      promotionCommitToken = token;
      const isTransactionCurrent = (): boolean => promotionCommitToken === token
        && state.mode === 'promoting'
        && state.transitionEpoch === expectedTransitionEpoch
        && state.streamEpoch === expectedStreamEpoch
        && nextServerResponderLeaseId === expectedResponderLeaseId
        && nextServerDriverLeaseId === expectedDriverLeaseId
        && !recoveryRequested;
      const transaction = (async (): Promise<AckResult> => {
        let completionReceiptSent = false;
        if (options.onLegacyDisableQuorumAccepted) {
          const receiptAccepted = await options.onLegacyDisableQuorumAccepted({
            identity,
            acknowledgedViewCount: acceptedDisableAcks.size,
            requiredResponderViewCount: frozenViews.length,
          });
          if (!receiptAccepted) {
            acceptedDisableAcks.delete(key);
            state.acceptedDisableAckCount = acceptedDisableAcks.size;
            requestOrderedCompatibilityRecovery('responder-disable-completion-receipt-failed');
            return {
              accepted: false,
              completed: false,
              reason: 'responder-disable-completion-receipt-failed',
            };
          }
          completionReceiptSent = true;
        }
        if (!await releasePromotedAuthority(isTransactionCurrent)) {
          acceptedDisableAcks.delete(key);
          state.acceptedDisableAckCount = acceptedDisableAcks.size;
          return {
            accepted: true,
            completed: false,
            ...(completionReceiptSent ? { completionReceiptSent: true } : {}),
            reason: 'authoritative-recovery-preflight-failed',
          };
        }
        return {
          accepted: true,
          completed: true,
          ...(completionReceiptSent ? { completionReceiptSent: true } : {}),
        };
      })();
      promotionCommitTransaction = transaction;
      try {
        return await transaction;
      } finally {
        if (promotionCommitTransaction === transaction) {
          promotionCommitTransaction = null;
          promotionCommitToken = null;
        }
      }
    },

    async captureHeadlessOutput(input) {
      const reserved = controller.enqueueHeadlessOutput(input);
      return controller.applyEnqueuedHeadlessOutput(reserved.recordId);
    },

    settleQueryEffect(input) {
      const output = appliedOutputs.get(input.recordId);
      const owner = output?.ingestOwnerToken ?? 'server-headless-staged';
      const effectKey = [
        options.initial.sessionGeneration,
        input.streamEpoch,
        output?.sourceSeq ?? 'unknown',
        input.responderLeaseId,
        input.replyOrdinal,
      ].join(':');
      if (!output || !isSafeReplyOrdinal(input.replyOrdinal) || input.reply.length === 0) {
        return { disposition: 'rejected', owner, effectKey };
      }
      const prior = queryEffects.get(effectKey);
      if (prior) {
        if (prior.reply !== input.reply) return { disposition: 'rejected', owner, effectKey };
        return {
          disposition: prior.disposition === 'failed' ? 'failed' : 'duplicate',
          owner,
          effectKey,
        };
      }
      if (output.ingestOwnerToken === 'legacy-browser') {
        return { disposition: 'legacy-owned', owner, effectKey };
      }
      if (state.mode === 'rolling-back' && rollback
        && input.streamEpoch === state.streamEpoch
        && input.responderLeaseId === rollback.request.nextCompatibilityResponderLeaseId) {
        const heldQueryLimit = Math.max(0, options.readPromotionSafetyLimits().maxHeldOutputChunks);
        if (rollback.heldQueries.length >= heldQueryLimit) {
          setBoundedLedger(queryEffects, effectKey, { reply: input.reply, disposition: 'failed' });
          invalidateActiveRollbackForFreshRecovery(
            rollback,
            'compatibility-query-hold-overflow',
          );
          return { disposition: 'rejected', owner, effectKey };
        }
        const held: HeldQueryEffect = {
          effectKey,
          sourceSeq: output.sourceSeq,
          reply: input.reply,
          transferred: false,
        };
        rollback.heldQueries.push(held);
        setBoundedLedger(queryEffects, effectKey, { reply: input.reply, disposition: 'held-for-legacy' });
        return { disposition: 'held-for-legacy', owner, effectKey };
      }
      if (state.mode !== 'server'
        || input.streamEpoch !== state.streamEpoch
        || input.responderLeaseId !== state.activeResponderLeaseId) {
        return { disposition: 'rejected', owner, effectKey };
      }
      emit({
        type: 'query-effect-cas-committed',
        sessionId: state.sessionId,
        sourceSeq: output.sourceSeq,
        effectKey,
      });
      try {
        options.writeTerminalQueryReply({
          effectKey,
          sourceSeq: output.sourceSeq,
          reply: input.reply,
          owner: 'server-headless',
        });
        emit({
          type: 'pty-query-reply-written',
          sessionId: state.sessionId,
          sourceSeq: output.sourceSeq,
          effectKey,
        });
        setBoundedLedger(queryEffects, effectKey, { reply: input.reply, disposition: 'applied' });
        return { disposition: 'applied', owner, effectKey };
      } catch {
        emit({
          type: 'query-effect-failed',
          sessionId: state.sessionId,
          sourceSeq: output.sourceSeq,
          effectKey,
        });
        setBoundedLedger(queryEffects, effectKey, { reply: input.reply, disposition: 'failed' });
        return { disposition: 'failed', owner, effectKey };
      }
    },

    acceptLegacyBrowserQueryReply(input) {
      const selectedCompatibilityResponder = rollback?.request.selectedCompatibilityResponder;
      const compatibilityIdentityMatches = state.mode === 'legacy'
        && rollback !== null
        && selectedCompatibilityResponder !== undefined
        && input.sessionId === state.sessionId
        && input.connectionId === selectedCompatibilityResponder.connectionId
        && input.viewGeneration === selectedCompatibilityResponder.viewGeneration
        && input.transitionEpoch === state.transitionEpoch
        && input.authorityEpoch === state.authorityEpoch
        && input.streamEpoch === state.streamEpoch
        && input.responderLeaseId === rollback.request.nextCompatibilityResponderLeaseId
        && input.boundarySourceSeq === rollback.snapshotSeq
        && input.queryReplyCapability === selectedCompatibilityResponder.queryReplyCapability
        && input.parserResponderCapability === selectedCompatibilityResponder.parserResponderCapability
        && input.driverLeaseGeneration === rollback.request.nextCompatibilityDriverLeaseGeneration
        && input.acceptedViewAttributesGeneration === rollback.request.nextAcceptedViewAttributesGeneration;
      const promotionIdentityMatches = state.mode === 'promoting'
        && fullPromotionIdentityMatches(
          input,
          previousStreamEpoch,
          previousLegacyResponderLeaseId,
        );
      if ((!promotionIdentityMatches && !compatibilityIdentityMatches)
        || !isSafeReplyOrdinal(input.replyOrdinal)
        || input.reply.length === 0) {
        return { accepted: false, reason: 'legacy-query-reply-identity-mismatch' };
      }
      const effectKey = [
        viewKey(input),
        input.transitionEpoch,
        input.responderLeaseId,
        input.replyOrdinal,
      ].join('\u0000');
      if (acceptedLegacyReplies.has(effectKey)) {
        return { accepted: true, duplicate: true };
      }
      addBoundedLedgerValue(acceptedLegacyReplies, effectKey);
      options.writeLegacyBrowserQueryReply({ reply: input.reply, identity: input });
      return { accepted: true };
    },

    async rejectBrowserParserTail() {
      return { accepted: false, reason: 'browser-parser-tail-transfer-forbidden' };
    },

    async recoverView() {
      const recovery = options.loadAuthoritativeRecovery();
      return {
        ok: state.mode === 'server',
        source: 'server-checkpoint',
        localCacheUsed: false,
        retainedStateHash: recovery.retainedStateHash,
        checkpointEpoch: recovery.checkpointEpoch,
        snapshotSeq: recovery.snapshotSeq,
        postSnapshotOutput: recovery.postSnapshotOutput,
      };
    },

    replaceServerAuthorityViews(views) {
      if (state.mode !== 'server') {
        return { ok: false, reason: 'authority-not-server' };
      }
      if (views.length === 0) {
        return { ok: false, reason: 'server-authority-views-empty' };
      }
      const keys = new Set<string>();
      for (const view of views) {
        const key = viewKey(view);
        if (keys.has(key)
          || view.queryReplyCapability !== 'terminal.query-reply-input.v1'
          || view.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
          || view.driverLeaseGeneration !== state.streamEpoch
          || view.acceptedViewAttributesGeneration !== state.streamEpoch) {
          return { ok: false, reason: 'server-authority-view-invalid' };
        }
        keys.add(key);
      }
      frozenViews = views.map(cloneView);
      state.frozenRequiredResponderCount = frozenViews.length;
      state.acceptedDisableAckCount = 0;
      emit({
        type: 'server-authority-views-replaced',
        sessionId: state.sessionId,
      });
      return { ok: true, viewCount: frozenViews.length };
    },

    replaceLegacyCompatibilityResponderView(view) {
      const currentRollback = rollback;
      if (state.mode !== 'legacy'
        || !state.legacyResponderEnabled
        || state.activeResponder !== 'legacy-browser'
        || !currentRollback) {
        return { ok: false, reason: 'legacy-compatibility-responder-unavailable' };
      }
      if (!nonEmpty(view.connectionId)
        || !Number.isSafeInteger(view.viewGeneration)
        || view.viewGeneration < 0
        || view.responderLeaseId !== currentRollback.request.nextCompatibilityResponderLeaseId
        || view.queryReplyCapability !== 'terminal.query-reply-input.v1'
        || view.parserResponderCapability !== 'terminal.parser-responder-disable.v1'
        || !isCanonicalOrdinal64(view.driverLeaseGeneration)
        || !isCanonicalOrdinal64(view.acceptedViewAttributesGeneration)) {
        return { ok: false, reason: 'legacy-compatibility-responder-invalid' };
      }
      currentRollback.request = {
        ...currentRollback.request,
        nextCompatibilityDriverLeaseGeneration: view.driverLeaseGeneration,
        nextAcceptedViewAttributesGeneration: view.acceptedViewAttributesGeneration,
        selectedCompatibilityResponder: {
          ...cloneView(view),
          driverLeaseId: currentRollback.request.nextCompatibilityDriverLeaseId,
        },
      };
      frozenViews = [cloneView(view)];
      state.frozenRequiredResponderCount = 1;
      emit({
        type: 'legacy-compatibility-responder-view-replaced',
        sessionId: state.sessionId,
        connectionId: view.connectionId,
        viewGeneration: view.viewGeneration,
        responderLeaseId: view.responderLeaseId,
      });
      return { ok: true };
    },

    async beginRollback(request) {
      const promotionRecovery = state.mode === 'rolling-back' && recoveryRequested && rollback === null;
      const serverAuthorityWasInstalled = serverAuthorityLeasesInstalled;
      if (state.mode !== 'server' && !promotionRecovery) {
        return { ok: false, reason: 'authority-not-server' };
      }
      if (!isCanonicalOrdinal64(request.transitionEpoch)
        || !isCanonicalOrdinal64(request.nextStreamEpoch)
        || request.transitionEpoch !== request.nextStreamEpoch
        || !ordinalGreaterThan(request.nextStreamEpoch, state.streamEpoch)
        || !isCanonicalOrdinal64(request.compatibilityCheckpointEpoch)
        || !isCanonicalOrdinal64(request.nextCompatibilityDriverLeaseGeneration)
        || !isCanonicalOrdinal64(request.nextAcceptedViewAttributesGeneration)
        || !nonEmpty(request.nextCompatibilityResponderLeaseId)
        || !nonEmpty(request.nextCompatibilityDriverLeaseId)) {
        return { ok: false, reason: 'rollback-identity-invalid' };
      }
      const selected = validateFrozenView(request.selectedCompatibilityResponder);
      if (!selected
        || request.selectedCompatibilityResponder.responderLeaseId
          !== request.nextCompatibilityResponderLeaseId
        || request.selectedCompatibilityResponder.driverLeaseId
          !== request.nextCompatibilityDriverLeaseId
        || request.selectedCompatibilityResponder.driverLeaseGeneration
          !== request.nextCompatibilityDriverLeaseGeneration
        || request.selectedCompatibilityResponder.acceptedViewAttributesGeneration
          !== request.nextAcceptedViewAttributesGeneration
        || request.selectedCompatibilityResponder.queryReplyCapability
          !== selected.queryReplyCapability
        || request.selectedCompatibilityResponder.parserResponderCapability
          !== selected.parserResponderCapability) {
        return { ok: false, reason: 'compatibility-responder-selection-invalid' };
      }
      const previousServerResponderLease = serverAuthorityLeasesInstalled
        ? nextServerResponderLeaseId
        : state.activeResponderLeaseId;
      const previousServerDriverLease = serverAuthorityLeasesInstalled
        ? nextServerDriverLeaseId
        : state.activeDriverLeaseId;
      boundarySourceSeq = readCurrentCommittedSourceSeq();
      const recovery = options.loadCompatibilityRecovery({
        transitionEpoch: request.transitionEpoch,
        streamEpoch: request.nextStreamEpoch,
        checkpointEpoch: request.compatibilityCheckpointEpoch,
      });
      if (!isCanonicalOrdinal64(recovery.snapshotSeq)) {
        return { ok: false, reason: 'compatibility-snapshot-invalid' };
      }
      if (heldPostBoundary.some(held => ordinalGreaterThan(
        held.output.sourceSeq,
        recovery.snapshotSeq,
      ))) {
        return { ok: false, reason: 'compatibility-snapshot-does-not-cover-held-output' };
      }
      heldPostBoundary.length = 0;
      state.heldPostBoundaryCount = 0;
      const nextRollback: RollbackContext = {
        request,
        affectedViews: frozenViews.map(cloneView),
        snapshotSeq: recovery.snapshotSeq,
        boundarySourceSeq,
        drainedThroughSourceSeq: recovery.snapshotSeq,
        drainTargetLocked: false,
        acceptedDrains: new Map(),
        heldQueries: restartedHeldQueries.splice(0),
        checkpointDeliverySettled: false,
        pendingCompatibilityOutputs: [],
        pendingCompatibilityBytes: 0,
      };
      try {
        options.stopNewAdmission({ sessionId: state.sessionId, transitionEpoch: request.transitionEpoch });
        emit({ type: 'new-admission-stopped', sessionId: state.sessionId, transitionEpoch: request.transitionEpoch });
        if (serverAuthorityWasInstalled && previousServerResponderLease && previousServerDriverLease) {
          options.setServerResponderEnabled({ enabled: false, responderLeaseId: previousServerResponderLease });
          emit({ type: 'server-responder-disabled', responderLeaseId: previousServerResponderLease });
          options.revokeServerResponderLease({ responderLeaseId: previousServerResponderLease });
          emit({ type: 'server-responder-lease-revoked', responderLeaseId: previousServerResponderLease });
          options.revokeServerDriverLease({ driverLeaseId: previousServerDriverLease });
          emit({ type: 'server-driver-lease-revoked', driverLeaseId: previousServerDriverLease });
          serverAuthorityLeasesInstalled = false;
        } else {
          emit({ type: 'promotion-candidate-leases-discarded', sessionId: state.sessionId });
        }
      } catch {
        recoveryRequested = true;
        return { ok: false, reason: 'rollback-runtime-port-transition-failed' };
      }
      const currentRollback = nextRollback;
      const beginToken = Symbol('rollback-begin');
      rollbackBeginToken = beginToken;
      rollback = currentRollback;
      recoveryRequested = false;
      state.mode = 'rolling-back';
      state.transitionEpoch = request.transitionEpoch;
      state.streamEpoch = request.nextStreamEpoch;
      state.admissionOpen = 'none';
      state.activeResponder = null;
      state.activeResponderLeaseId = null;
      state.activeDriverLeaseId = null;
      state.serverResponderEnabled = false;
      state.legacyResponderEnabled = false;
      const isRollbackContextCurrent = (): boolean => rollback === currentRollback
        && state.mode === 'rolling-back'
        && state.transitionEpoch === request.transitionEpoch
        && state.streamEpoch === request.nextStreamEpoch;
      const isRollbackTransactionCurrent = (): boolean => rollbackBeginToken === beginToken
        && isRollbackContextCurrent();
      if (!promotionRecovery) {
        for (const view of currentRollback.affectedViews) {
          options.markAffectedViewStale({
            connectionId: view.connectionId,
            viewGeneration: view.viewGeneration,
          });
        }
        emit({ type: 'affected-views-stale', sessionId: state.sessionId });
        for (const view of currentRollback.affectedViews) {
          options.resetAffectedViewParser({
            connectionId: view.connectionId,
            viewGeneration: view.viewGeneration,
          });
        }
        emit({ type: 'browser-parser-reset-required', sessionId: state.sessionId });
      }
      options.purgeOldAckBacklog({ sessionId: state.sessionId, transitionEpoch: request.transitionEpoch });
      emit({ type: 'old-ack-backlog-purged', sessionId: state.sessionId });

      const rollbackStartAccepted = await queueTerminalDelivery(
        () => enqueue({
          type: 'terminal-authority:rollback-start',
          source: 'server-controller',
          sessionId: state.sessionId,
          transitionEpoch: request.transitionEpoch,
          authorityEpoch: state.authorityEpoch,
          streamEpoch: request.nextStreamEpoch,
          responderLeaseId: request.nextCompatibilityResponderLeaseId,
          driverLeaseId: request.nextCompatibilityDriverLeaseId,
          boundarySourceSeq,
          checkpointEpoch: request.compatibilityCheckpointEpoch,
          affectedViews: currentRollback.affectedViews.map(cloneView),
        }),
        'rollback-start-enqueue-failed',
        undefined,
        isRollbackTransactionCurrent,
      );
      if (!isRollbackTransactionCurrent()) {
        return { ok: false, reason: 'rollback-transaction-invalidated' };
      }
      if (!rollbackStartAccepted) {
        return { ok: false, reason: 'rollback-start-enqueue-failed' };
      }
      for (const message of recovery.checkpointMessages) {
        const checkpointAccepted = await queueTerminalDelivery(
          () => enqueue({
            ...message,
            responderLeaseId: request.nextCompatibilityResponderLeaseId,
            boundarySourceSeq,
          }),
          'compatibility-checkpoint-enqueue-failed',
          undefined,
          isRollbackTransactionCurrent,
        );
        if (!isRollbackTransactionCurrent()) {
          return { ok: false, reason: 'rollback-transaction-invalidated' };
        }
        if (!checkpointAccepted) {
          return { ok: false, reason: 'compatibility-checkpoint-enqueue-failed' };
        }
      }
      emit({ type: 'fresh-compatibility-checkpoint-enqueued', sourceSeq: recovery.snapshotSeq });
      const pendingCompatibilityOutputs = currentRollback.pendingCompatibilityOutputs.splice(0);
      state.pendingDeliveryBytes = Math.max(
        0,
        state.pendingDeliveryBytes - currentRollback.pendingCompatibilityBytes,
      );
      state.pendingDeliveryChunks = Math.max(
        0,
        state.pendingDeliveryChunks - pendingCompatibilityOutputs.length,
      );
      currentRollback.pendingCompatibilityBytes = 0;
      for (const held of pendingCompatibilityOutputs) {
        if (!ordinalGreaterThan(held.output.sourceSeq, recovery.snapshotSeq)) {
          continue;
        }
        void queueOutputDelivery(
          held.data,
          held.output.sourceSeq,
          state.streamEpoch,
          currentRollback.request.nextCompatibilityResponderLeaseId,
          'compatibility-output-settlement-failed',
          () => emit({
            type: 'compatibility-tail-enqueued',
            sessionId: state.sessionId,
            sourceSeq: held.output.sourceSeq,
          }),
          isRollbackContextCurrent,
        );
      }
      if (!isRollbackTransactionCurrent()) {
        return { ok: false, reason: 'rollback-transaction-invalidated' };
      }
      currentRollback.checkpointDeliverySettled = true;
      if (rollbackBeginToken === beginToken) rollbackBeginToken = null;
      return { ok: true };
    },

    async acknowledgeCompatibilityDrain(input) {
      const currentRollback = rollback;
      const affected = currentRollback?.affectedViews.find(
        view => view.connectionId === input.connectionId
          && view.viewGeneration === input.viewGeneration,
      );
      if (state.mode !== 'rolling-back'
        || !currentRollback
        || !affected
        || input.transitionEpoch !== state.transitionEpoch
        || input.authorityEpoch !== state.authorityEpoch
        || input.streamEpoch !== state.streamEpoch
        || input.responderLeaseId !== currentRollback.request.nextCompatibilityResponderLeaseId
        || input.boundarySourceSeq !== currentRollback.boundarySourceSeq
        || input.checkpointEpoch !== currentRollback.request.compatibilityCheckpointEpoch
        || !input.checkpointApplied
        || !input.postSnapshotTailDrained
        || !isCanonicalOrdinal64(input.checkpointEpoch)
        || !isCanonicalOrdinal64(input.drainedThroughSourceSeq)
        || (!currentRollback.drainTargetLocked
          && input.drainedThroughSourceSeq !== currentRollback.drainedThroughSourceSeq)
        || (currentRollback.drainTargetLocked
          && ordinalGreaterThan(
            currentRollback.drainedThroughSourceSeq,
            input.drainedThroughSourceSeq,
          ))) {
        return { accepted: false, completed: false, reason: 'compatibility-drain-identity-mismatch' };
      }
      if (!options.hasCompatibilityTailPhysicallyDrained({
        connectionId: input.connectionId,
        viewGeneration: input.viewGeneration,
        transitionEpoch: input.transitionEpoch,
        authorityEpoch: input.authorityEpoch,
        streamEpoch: input.streamEpoch,
        responderLeaseId: input.responderLeaseId,
        boundarySourceSeq: input.boundarySourceSeq,
        checkpointEpoch: input.checkpointEpoch,
        drainedThroughSourceSeq: input.drainedThroughSourceSeq,
      })) {
        return {
          accepted: false,
          completed: false,
          reason: 'compatibility-tail-not-physically-drained',
        };
      }
      currentRollback.drainTargetLocked = true;
      const key = viewKey(input);
      if (currentRollback.acceptedDrains.get(key) === input.drainedThroughSourceSeq) {
        if (compatibilityCommitTransaction && compatibilityCommitRollback === currentRollback) {
          const result = await compatibilityCommitTransaction;
          return { ...result, duplicate: true };
        }
        return {
          accepted: true,
          duplicate: true,
          completed: currentRollback.acceptedDrains.size === currentRollback.affectedViews.length,
        };
      }
      currentRollback.acceptedDrains.set(key, input.drainedThroughSourceSeq);
      emit({
        type: 'compatibility-view-drained',
        connectionId: input.connectionId,
        viewGeneration: input.viewGeneration,
      });
      const completed = currentRollback.acceptedDrains.size === currentRollback.affectedViews.length;
      if (!completed) return { accepted: true, completed: false };

      const token = Symbol('compatibility-commit');
      const committedDrainTarget = currentRollback.drainedThroughSourceSeq;
      compatibilityCommitToken = token;
      compatibilityCommitRollback = currentRollback;
      const isTransactionCurrent = (): boolean => compatibilityCommitToken === token
        && state.mode === 'rolling-back'
        && rollback === currentRollback
        && state.transitionEpoch === input.transitionEpoch
        && state.streamEpoch === input.streamEpoch
        && currentRollback.drainTargetLocked
        && currentRollback.drainedThroughSourceSeq === committedDrainTarget
        && currentRollback.acceptedDrains.size === currentRollback.affectedViews.length;
      const transaction = (async (): Promise<AckResult & { completed: boolean }> => {
        let driverRebound = false;
        let responderRebound = false;
        const revokeReboundCompatibilityLeases = (): void => {
          if (responderRebound) {
            try {
              options.revokeServerResponderLease({
                responderLeaseId: currentRollback.request.nextCompatibilityResponderLeaseId,
              });
            } catch { /* retain fail-closed rolling-back state */ }
            responderRebound = false;
          }
          if (driverRebound) {
            try {
              options.revokeServerDriverLease({
                driverLeaseId: currentRollback.request.nextCompatibilityDriverLeaseId,
              });
            } catch { /* retain fail-closed rolling-back state */ }
            driverRebound = false;
          }
        };
        try {
          options.rebindCompatibilityDriverLease({
            driverLeaseId: currentRollback.request.nextCompatibilityDriverLeaseId,
            ...(currentRollback.request.selectedCompatibilityResponder.clientId
              ? { clientId: currentRollback.request.selectedCompatibilityResponder.clientId }
              : {}),
            viewGeneration: currentRollback.request.selectedCompatibilityResponder.viewGeneration,
            leaseGeneration: currentRollback.request.nextCompatibilityDriverLeaseGeneration,
          });
          driverRebound = true;
          options.rebindCompatibilityResponderLease({
            responderLeaseId: currentRollback.request.nextCompatibilityResponderLeaseId,
          });
          responderRebound = true;
        } catch (error) {
          revokeReboundCompatibilityLeases();
          currentRollback.acceptedDrains.delete(key);
          emit({
            type: 'compatibility-lease-rebind-failed',
            kind: error instanceof Error ? error.message : 'unknown-error',
            sessionId: state.sessionId,
          });
          invalidateActiveRollbackForFreshRecovery(
            currentRollback,
            'compatibility-lease-rebind-failed',
          );
          return { accepted: false, completed: false, reason: 'compatibility-lease-rebind-failed' };
        }
        const selectedView = currentRollback.request.selectedCompatibilityResponder;
        try {
          for (const heldQuery of currentRollback.heldQueries) {
            if (heldQuery.transferred) continue;
            options.transferHeldQueryToLegacyResponder({
              effectKey: heldQuery.effectKey,
              sourceSeq: heldQuery.sourceSeq,
              reply: heldQuery.reply,
              responderLeaseId: currentRollback.request.nextCompatibilityResponderLeaseId,
              ...(selectedView.clientId ? { clientId: selectedView.clientId } : {}),
              viewGeneration: selectedView.viewGeneration,
            });
            heldQuery.transferred = true;
          }
        } catch (error) {
          revokeReboundCompatibilityLeases();
          currentRollback.acceptedDrains.delete(key);
          emit({
            type: 'compatibility-query-transfer-failed',
            kind: error instanceof Error ? error.message : 'unknown-error',
            sessionId: state.sessionId,
          });
          invalidateActiveRollbackForFreshRecovery(
            currentRollback,
            'compatibility-query-transfer-failed',
          );
          return { accepted: false, completed: false, reason: 'compatibility-query-transfer-failed' };
        }
        if (!await queueTerminalDelivery(
          () => enqueue({
            type: 'terminal-authority:legacy-responder-enabled',
            source: 'server-controller',
            sessionId: state.sessionId,
            connectionId: selectedView.connectionId,
            viewGeneration: selectedView.viewGeneration,
            transitionEpoch: state.transitionEpoch,
            authorityEpoch: state.authorityEpoch,
            streamEpoch: state.streamEpoch,
            responderLeaseId: currentRollback.request.nextCompatibilityResponderLeaseId,
            driverLeaseId: currentRollback.request.nextCompatibilityDriverLeaseId,
            queryReplyCapability: selectedView.queryReplyCapability,
            parserResponderCapability: selectedView.parserResponderCapability,
            driverLeaseGeneration: currentRollback.request.nextCompatibilityDriverLeaseGeneration,
            acceptedViewAttributesGeneration: currentRollback.request.nextAcceptedViewAttributesGeneration,
            boundarySourceSeq: currentRollback.snapshotSeq,
            checkpointEpoch: currentRollback.request.compatibilityCheckpointEpoch,
            snapshotSeq: currentRollback.snapshotSeq,
            drainedThroughSourceSeq: currentRollback.drainedThroughSourceSeq,
            checkpointApplied: true,
            postSnapshotTailDrained: true,
            affectedViewCount: currentRollback.affectedViews.length,
          }),
          'legacy-enable-enqueue-failed',
        )) {
          revokeReboundCompatibilityLeases();
          currentRollback.acceptedDrains.delete(key);
          return { accepted: false, completed: false, reason: 'legacy-enable-enqueue-failed' };
        }
        if (!isTransactionCurrent()) {
          revokeReboundCompatibilityLeases();
          currentRollback.acceptedDrains.delete(key);
          return { accepted: false, completed: false, reason: 'compatibility-commit-invalidated' };
        }
        state.mode = 'legacy';
        promotionAdmissionFenced = false;
        state.activeResponder = 'legacy-browser';
        state.activeResponderLeaseId = currentRollback.request.nextCompatibilityResponderLeaseId;
        state.activeDriverLeaseId = currentRollback.request.nextCompatibilityDriverLeaseId;
        state.legacyResponderEnabled = true;
        state.serverResponderEnabled = false;
        state.admissionOpen = 'legacy';
        options.commitLegacyResponderIdentity({
          ...selectedView,
          sessionId: state.sessionId,
          transitionEpoch: input.transitionEpoch,
          authorityEpoch: state.authorityEpoch,
          streamEpoch: state.streamEpoch,
          boundarySourceSeq: currentRollback.snapshotSeq,
          responderLeaseId: currentRollback.request.nextCompatibilityResponderLeaseId,
          driverLeaseId: currentRollback.request.nextCompatibilityDriverLeaseId,
          driverLeaseGeneration: currentRollback.request.nextCompatibilityDriverLeaseGeneration,
          acceptedViewAttributesGeneration:
            currentRollback.request.nextAcceptedViewAttributesGeneration,
          checkpointEpoch: currentRollback.request.compatibilityCheckpointEpoch,
          snapshotSeq: currentRollback.snapshotSeq,
          drainedThroughSourceSeq: currentRollback.drainedThroughSourceSeq,
          checkpointApplied: true,
          postSnapshotTailDrained: true,
          affectedViewCount: currentRollback.affectedViews.length,
        });
        emit({ type: 'legacy-responder-enabled', sessionId: state.sessionId });
        return { accepted: true, completed: true };
      })();
      compatibilityCommitTransaction = transaction;
      try {
        return await transaction;
      } finally {
        if (compatibilityCommitTransaction === transaction) {
          compatibilityCommitTransaction = null;
          compatibilityCommitToken = null;
          compatibilityCommitRollback = null;
        }
      }
    },

    async notifyResponderTopologyChanged(input) {
      if (state.mode !== 'promoting' || input.transitionEpoch !== state.transitionEpoch) {
        return { aborted: false, restartRequired: state.restartRequired, reason: 'promotion-not-active' };
      }
      emit({
        type: 'responder-topology-changed',
        kind: input.kind,
        connectionId: input.connectionId,
        viewGeneration: input.viewGeneration,
        transitionEpoch: input.transitionEpoch,
      });
      state.restartRequired = true;
      if (input.kind === 'disconnect') {
        state.peerDisconnectRecoveryAuthority = 'retained-server-model';
      }
      promotionBeginToken = null;
      state.mode = 'aborted';
      state.admissionOpen = 'none';
      emit({ type: 'promotion-aborted', kind: input.kind });
      markAllFrozenViewsStale();
      emit({ type: 'affected-views-stale', sessionId: state.sessionId });
      options.purgeOldAckBacklog({ sessionId: state.sessionId, transitionEpoch: input.transitionEpoch });
      emit({ type: 'old-ack-backlog-purged', sessionId: state.sessionId });
      emit({ type: 'compatibility-restart-required', sessionId: state.sessionId });
      return { aborted: true, restartRequired: true, reason: 'responder-topology-changed' };
    },

    resumeAbortedPromotionRecovery(reason) {
      if (state.mode !== 'aborted' || !state.restartRequired) {
        return { ok: false, reason: 'promotion-abort-recovery-not-required' };
      }
      recoveryRequested = true;
      state.mode = 'rolling-back';
      state.admissionOpen = 'none';
      emit({ type: 'ordered-compatibility-recovery-started', sessionId: state.sessionId });
      options.onOrderedCompatibilityRecoveryRequired(reason);
      return { ok: true };
    },

    hasActiveCompatibilityRecoveryTransaction() {
      return state.mode === 'rolling-back' && rollback !== null;
    },

    restartCompatibilityRecovery(reason) {
      if (state.mode !== 'rolling-back' || rollback === null) {
        return { ok: false, reason: 'compatibility-recovery-not-active' };
      }
      return invalidateActiveRollbackForFreshRecovery(rollback, reason)
        ? { ok: true }
        : { ok: false, reason: 'compatibility-recovery-invalidated' };
    },

    replaceCompatibilityRecoveryViews(views) {
      if (state.mode !== 'aborted' && state.mode !== 'rolling-back') {
        return { ok: false, reason: 'compatibility-recovery-not-active' };
      }
      const keys = new Set<string>();
      for (const view of views) {
        const key = viewKey(view);
        if (keys.has(key)
          || view.queryReplyCapability !== 'terminal.query-reply-input.v1'
          || view.parserResponderCapability !== 'terminal.parser-responder-disable.v1') {
          return { ok: false, reason: 'compatibility-recovery-view-invalid' };
        }
        keys.add(key);
      }
      frozenViews = views.map(cloneView);
      state.frozenRequiredResponderCount = frozenViews.length;
      state.acceptedDisableAckCount = 0;
      return { ok: true, viewCount: frozenViews.length };
    },

    async observeInteractiveInput() {
      return { sessionStatus: state.sessionStatus };
    },

    checkPromotionDeadline() {
      if (state.mode !== 'promoting') return { abortRequired: false };
      if (frozenViews.length > 0 && acceptedDisableAcks.size === frozenViews.length) {
        return { abortRequired: false };
      }
      const deadline = options.readPromotionSafetyLimits().ackDeadlineMs;
      if (options.now() - promotionStartedAt <= deadline) return { abortRequired: false };
      requestOrderedCompatibilityRecovery('disable-ack-deadline-exceeded');
      return { abortRequired: true, reason: 'disable-ack-deadline-exceeded' };
    },

    readLastCommittedSourceSeq() {
      return readCurrentCommittedSourceSeq();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      deliveryGeneration += 1;
      promotionBeginToken = null;
      rollbackBeginToken = null;
      promotionCommitToken = null;
      compatibilityCommitToken = null;
      if (rollback) clearPendingCompatibilityOutputs(rollback);
      compatibilityCommitRollback = null;
      for (const pending of pendingOutputs.values()) pending.settle();
      pendingOutputs.clear();
      heldPostBoundary.length = 0;
      rollback?.pendingCompatibilityOutputs.splice(0);
      state.heldPostBoundaryCount = 0;
      state.pendingDeliveryBytes = 0;
      state.pendingDeliveryChunks = 0;
      state.admissionOpen = 'none';
    },

    getState() {
      return { ...state };
    },
  };

  return controller;
}
