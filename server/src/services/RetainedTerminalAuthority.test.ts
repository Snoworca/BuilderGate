import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { IPty } from 'node-pty';
import { SessionManager, type SessionFinalizedEvent } from './SessionManager.js';
import { LEGACY_TERMINAL_RESOURCE_POLICY_ID } from './TerminalResourcePolicy.js';
import {
  compareRetainedHeadlessCheckpointRoundTrip,
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from '../utils/headlessTerminal.js';
import * as checkpointProtocol from '../types/ws-protocol.js';
import { config } from '../utils/config.js';
import type { WsRouter } from '../ws/WsRouter.js';

type FactDisposition = 'committed' | 'duplicate' | 'rejected';

interface RetainedTerminalFact {
  kind: string;
  semanticKey: string;
  streamEpoch: string;
  sourceSeq: string;
  ordinal: number;
  disposition: FactDisposition;
}

interface RetainedTerminalAuthorityState {
  availability: 'available';
  mode: 'shadow' | 'disabled' | 'legacy-characterization';
  streamEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  oldestRetainedStreamEpoch: string;
  retentionPolicy: {
    effectiveRetainedScrollbackLines: number;
    retentionPolicyId: string;
    source: 'resourceLimits.terminal.scrollbackLines' | 'pty.scrollbackLines';
    sourceKind: string;
    conflictDetected: boolean;
  };
  checkpoint: {
    serializedData: string;
    rehydrateAnsi: string;
    normal: { logicalLines: readonly string[]; cellHash: string; attributeHash: string };
    alternate: { logicalLines: readonly string[]; cellHash: string; attributeHash: string };
    activeBuffer: 'normal' | 'alternate';
    cursor: { x: number; y: number };
    savedCursor: { x: number; y: number } | null;
    modes: Readonly<Record<string, boolean | number | string>>;
    cols: number;
    rows: number;
    pendingEscapeTailAnsi: string;
    truncated: boolean;
  };
  budgets: {
    retention: { key: 'retention'; unit: 'lines'; value: number; source: string; configured: boolean };
    aggregateModelMemory: { key: 'aggregate-model-memory'; unit: 'bytes'; value: number | null; source: string; configured: boolean };
    checkpointChunk: { key: 'checkpoint-chunk'; unit: 'bytes'; value: number | null; source: string; configured: boolean };
    perClientInflight: { key: 'per-client-inflight'; unit: 'bytes'; value: number | null; source: string; configured: boolean };
    socketGate: { key: 'socket-gate'; unit: 'bytes'; value: number | null; source: string; configured: boolean };
    browserWriteSlice: { key: 'browser-write-slice'; unit: 'bytes'; value: number | null; source: string; configured: boolean };
  };
  lastRecord: {
    streamEpoch: string;
    sourceSeq: string;
    kind: 'output' | 'resize';
    modelCommitted: boolean;
    deliveryCreatedAfterCommit: boolean;
    rejectionReason?: 'model-degraded' | 'queue-overflow' | 'commit-failed';
  } | null;
  records: ReadonlyArray<{
    streamEpoch: string;
    sourceSeq: string;
    kind: 'output' | 'resize';
    modelCommitted: boolean;
    deliveryCreatedAfterCommit: boolean;
    rejectionReason?: 'model-degraded' | 'queue-overflow' | 'commit-failed';
  }>;
  facts: readonly RetainedTerminalFact[];
  comparer: {
    result: 'match' | 'mismatch' | 'unavailable';
    deliveryAuthority: 'legacy';
    failureBehavior: 'block-session-canary-only';
    axes: {
      logicalLines: 'match' | 'mismatch' | 'unavailable';
      cells: 'match' | 'mismatch' | 'unavailable';
      unicodeWidth: 'match' | 'mismatch' | 'unavailable';
      cursor: 'match' | 'mismatch' | 'unavailable';
      modes: 'match' | 'mismatch' | 'unavailable';
      activeBuffer: 'match' | 'mismatch' | 'unavailable';
      parserTail: 'match' | 'mismatch' | 'unavailable';
      eviction: 'match' | 'mismatch' | 'unavailable';
    };
  };
  canary: { eligible: boolean; blockers: readonly string[] };
  eviction: {
    evictedRows: number;
    evictedBytes: number;
    reason: string | null;
    policyId: string;
    completeLogicalRowBoundary: boolean;
    dataGapRequired: boolean;
    restoreNeeded: boolean;
    staleViewReady: boolean;
  };
  driverLease: {
    ownerClientId: string | null;
    generation: string;
    state: 'unclaimed' | 'active' | 'revoked';
  };
  cleanup: {
    admissionOpen: boolean;
    settled: boolean;
    rejectedLateMessages: number;
    factLedgerSettlements: number;
    checkpointLedgerSettlements: number;
    timerSettlements: number;
  };
  shadowSettlement: {
    admissionOpen: boolean;
    settled: boolean;
    factLedgerSettlements: number;
    checkpointLedgerSettlements: number;
    timerSettlements: number;
  };
  clients: ReadonlyArray<{
    clientId: string;
    viewGeneration: number;
    slow: boolean;
    pendingBytes: number;
    blocksModel: boolean;
    dataGapRequired: boolean;
    restoreNeeded: boolean;
    ready: boolean;
  }>;
  recovery: { authority: 'server' | 'legacy-local'; provisionalCacheUsed: boolean };
  ledger: {
    recordLimit: number;
    factLimit: number;
    committedFactKeyCount: number;
    evictedRecords: number;
    evictedFacts: number;
    encodedBytes: number;
    byteLimit: number;
    semanticKeyMaxBytes: number;
  };
}

interface RetainedDriverLeaseResult {
  ok: boolean;
  ownerClientId: string | null;
  generation: string;
  reason?: string;
  shadowOnly: boolean;
}

interface RetainedTerminalAuthorityApi {
  getRetainedTerminalAuthorityState(sessionId: string): RetainedTerminalAuthorityState | undefined;
  getRetainedTerminalAuthorityAvailability(sessionId: string):
    | { availability: 'available' }
    | { availability: 'authority-unavailable'; reason: 'server-restart-or-session-missing' }
    | {
        availability: 'authority-degraded';
        reason: 'model-degradation';
        phase: 'create' | 'write' | 'resize';
        canaryBlockers: readonly string[];
      }
    | {
        availability: 'session-terminated';
        reason: string;
        exitCode: number | null;
        cleanup: {
          admissionOpen: false;
          settled: true;
          rejectedLateMessages: number;
          factLedgerSettlements: 1;
          checkpointLedgerSettlements: 1;
          timerSettlements: 1;
        };
        driverLease: { state: 'revoked'; ownerClientId: null };
      };
  getRetainedTerminalGenerationRejectionState(
    sessionId: string,
    authorityEpoch: string,
  ): {
    sessionId: string;
    authorityEpoch: string;
    streamEpoch: string;
    terminationReason: string;
    rejectedLateMessages: number;
    lastRejectionReason: 'late-pty-output' | 'late-pty-exit' | 'stale-mutation' | null;
  } | undefined;
  claimRetainedTerminalDriverLease(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ): RetainedDriverLeaseResult;
  handoffRetainedTerminalDriverLease(
    sessionId: string,
    currentClientId: string,
    currentViewGeneration: number,
    nextClientId: string,
    nextViewGeneration: number,
    leaseGeneration: string,
  ): RetainedDriverLeaseResult;
  releaseRetainedTerminalDriverLease(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
    leaseGeneration: string,
  ): RetainedDriverLeaseResult;
  observeRetainedTerminalDriverMutation(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
    leaseGeneration: string,
    kind: 'input' | 'resize' | 'query-reply',
  ): { accepted: boolean; reason: string; shadowOnly: true };
  registerRetainedTerminalClientView(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
    options?: { slow?: boolean },
  ): { ok: boolean; reason: string };
  unregisterRetainedTerminalClientView(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ): { ok: boolean; reason: string };
  establishRetainedTerminalMutationLease(
    sessionId: string,
    clientId: string,
    viewGeneration: number,
  ):
    | {
        ok: true;
        sessionId: string;
        authorityEpoch: string;
        clientId: string;
        viewGeneration: number;
        leaseGeneration: string;
      }
    | { ok: false; reason: string };
  setRetainedTerminalShadowEnabled(enabled: boolean): boolean;
}

interface OrdinalModule {
  advanceRetainedTerminalOrdinal(input: {
    streamEpoch: string;
    sourceSeq: string;
  }): { streamEpoch: string; sourceSeq: string; rolledOver: boolean };
}

class FakePty {
  readonly pid: number;
  readonly process = 'bash';
  readonly handleFlowControl = false;
  cols: number;
  rows: number;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  resizeObserver?: () => void;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(pid: number, cols: number, rows: number) {
    this.pid = pid;
    this.cols = cols;
    this.rows = rows;
  }

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
    this.resizeObserver?.();
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  pause(): void {}
  resume(): void {}
  clear(): void {}

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal: 0 });
  }
}

interface Delivery {
  sessionId: string;
  data: string;
  screenSeq?: number;
  stateAtDelivery?: RetainedTerminalAuthorityState;
}

interface Harness {
  manager: SessionManager;
  api: RetainedTerminalAuthorityApi;
  pty: FakePty;
  sessionId: string;
  deliveries: Delivery[];
  finalized: SessionFinalizedEvent[];
  titleEvents: string[];
  resizeStatesAtPty: RetainedTerminalAuthorityState[];
  headlessCreateCount(): number;
  readState(sessionId?: string): RetainedTerminalAuthorityState;
  createAdditionalSession(sessionId: string): FakePty;
  emitFor(sessionId: string, pty: FakePty, data: string): Promise<void>;
  emit(data: string): Promise<void>;
  close(): void;
}

let nextPid = 41_000;

function buildLegacyOnlyNegativeProjection(
  manager: SessionManager,
  sessionId: string,
  options: {
    retainedScrollbackLines: number;
    retentionSource: 'resourceLimits.terminal.scrollbackLines' | 'pty.scrollbackLines';
    resourceLimits: typeof config.resourceLimits;
    ptyConfig: typeof config.pty;
  },
): RetainedTerminalAuthorityState {
  const screen = manager.getScreenSnapshot(sessionId);
  const atomic = manager.getAtomicRestoreSnapshot(sessionId);
  assert.ok(screen, 'precondition: legacy public screen snapshot remains available');
  const serializedData = atomic.ok ? atomic.payload.serializedData : screen.data;
  return {
    availability: 'available',
    mode: 'legacy-characterization',
    streamEpoch: 'unavailable',
    sourceSeq: 'unavailable',
    snapshotSeq: 'unavailable',
    oldestRetainedSeq: 'unavailable',
    oldestRetainedStreamEpoch: 'unavailable',
    retentionPolicy: {
      effectiveRetainedScrollbackLines: options.ptyConfig.scrollbackLines,
      retentionPolicyId: 'legacy-viewport-only',
      source: 'pty.scrollbackLines',
      sourceKind: 'legacy-runtime-divergence',
      conflictDetected: options.retentionSource === 'resourceLimits.terminal.scrollbackLines'
        && options.retainedScrollbackLines !== options.ptyConfig.scrollbackLines,
    },
    checkpoint: {
      serializedData,
      rehydrateAnsi: serializedData,
      normal: { logicalLines: [serializedData], cellHash: '', attributeHash: '' },
      alternate: { logicalLines: [], cellHash: '', attributeHash: '' },
      activeBuffer: 'normal',
      cursor: { x: 0, y: 0 },
      savedCursor: null,
      modes: {},
      cols: screen.cols,
      rows: screen.rows,
      pendingEscapeTailAnsi: screen.pendingEscapeTailAnsi ?? '',
      truncated: screen.truncated,
    },
    budgets: {
      retention: {
        key: 'retention', unit: 'lines', value: options.retainedScrollbackLines,
        source: 'legacy-observation-unavailable', configured: false,
      },
      aggregateModelMemory: {
        key: 'aggregate-model-memory', unit: 'bytes', value: null,
        source: 'legacy-observation-unavailable', configured: false,
      },
      checkpointChunk: {
        key: 'checkpoint-chunk', unit: 'bytes', value: null,
        source: 'legacy-observation-unavailable', configured: false,
      },
      perClientInflight: {
        key: 'per-client-inflight', unit: 'bytes',
        value: null,
        source: 'legacy-observation-unavailable', configured: false,
      },
      socketGate: {
        key: 'socket-gate', unit: 'bytes',
        value: null,
        source: 'legacy-observation-unavailable', configured: false,
      },
      browserWriteSlice: {
        key: 'browser-write-slice', unit: 'bytes',
        value: null,
        source: 'legacy-observation-unavailable', configured: false,
      },
    },
    lastRecord: null,
    records: [],
    facts: [],
    comparer: {
      result: 'unavailable',
      deliveryAuthority: 'legacy',
      failureBehavior: 'block-session-canary-only',
      axes: {
        logicalLines: 'unavailable', cells: 'unavailable', unicodeWidth: 'unavailable',
        cursor: 'unavailable', modes: 'unavailable', activeBuffer: 'unavailable',
        parserTail: 'unavailable', eviction: 'unavailable',
      },
    },
    canary: { eligible: false, blockers: ['retained-authority-unavailable'] },
    eviction: {
      evictedRows: 0,
      evictedBytes: 0,
      reason: null,
      policyId: 'legacy-viewport-only',
      completeLogicalRowBoundary: false,
      dataGapRequired: false,
      restoreNeeded: false,
      staleViewReady: true,
    },
    driverLease: { ownerClientId: null, generation: '0', state: 'unclaimed' },
    cleanup: {
      admissionOpen: true,
      settled: false,
      rejectedLateMessages: 0,
      factLedgerSettlements: 0,
      checkpointLedgerSettlements: 0,
      timerSettlements: 0,
    },
    shadowSettlement: {
      admissionOpen: false,
      settled: false,
      factLedgerSettlements: 0,
      checkpointLedgerSettlements: 0,
      timerSettlements: 0,
    },
    clients: [],
    recovery: { authority: 'legacy-local', provisionalCacheUsed: true },
    ledger: {
      recordLimit: 0,
      factLimit: 0,
      committedFactKeyCount: 0,
      evictedRecords: 0,
      evictedFacts: 0,
      encodedBytes: 0,
      byteLimit: 0,
      semanticKeyMaxBytes: 0,
    },
  };
}

function createHarness(options: {
  sessionId?: string;
  retainedScrollbackLines?: number;
  legacyScrollbackLines?: number;
  maxSnapshotBytes?: number;
  omitResourceLimits?: boolean;
  shadowMismatchSessionId?: string;
  modelDegradationSessionId?: string;
  initialRetainedOrdinal?: { streamEpoch: string; sourceSeq: string };
  headlessWriteGate?: Promise<void>;
  retainedShadowEnabled?: boolean;
  retainedComparisonGate?: Promise<void>;
  onRetainedComparisonStarted?: () => void;
} = {}): Harness {
  const ptys: FakePty[] = [];
  const deliveries: Delivery[] = [];
  const finalized: SessionFinalizedEvent[] = [];
  const titleEvents: string[] = [];
  const resizeStatesAtPty: RetainedTerminalAuthorityState[] = [];
  let headlessCreateCount = 0;
  const resourceLimits = structuredClone(config.resourceLimits!);
  resourceLimits.terminal.scrollbackLines = options.retainedScrollbackLines ?? 8;
  const ptyConfig = {
    ...structuredClone(config.pty),
    scrollbackLines: options.legacyScrollbackLines ?? 3,
    maxSnapshotBytes: options.maxSnapshotBytes ?? config.pty.maxSnapshotBytes,
  };
  const spawnPty = ((_file: string, _args: readonly string[], spawnOptions: { cols?: number; rows?: number }) => {
    const fake = new FakePty(nextPid++, spawnOptions.cols ?? 80, spawnOptions.rows ?? 24);
    ptys.push(fake);
    return fake as unknown as IPty;
  }) as NonNullable<ConstructorParameters<typeof SessionManager>[1]>['spawnPty'];
  const manager = new SessionManager({
    pty: ptyConfig,
    session: structuredClone(config.session),
    resourceLimits: options.omitResourceLimits ? undefined : resourceLimits,
    stabilityModes: structuredClone(config.stabilityModes),
  }, {
    platform: 'linux',
    spawnPty,
    readProcessStartIdentityFn: async () => null,
    retainedTerminalShadowProjectionMutator: options.shadowMismatchSessionId === undefined
      ? undefined
      : {
          mutate(sessionId: string, projection: RetainedTerminalAuthorityState) {
            if (sessionId !== options.shadowMismatchSessionId) return projection;
            const mutated = structuredClone(projection);
            mutated.checkpoint.normal.cellHash = '0'.repeat(64);
            return mutated;
          },
        },
    retainedTerminalModelFaultInjector: options.modelDegradationSessionId === undefined
      ? undefined
      : {
          shouldDegrade(sessionId: string) {
            return sessionId === options.modelDegradationSessionId;
          },
        },
    retainedTerminalInitialOrdinal: options.initialRetainedOrdinal,
    retainedTerminalShadowEnabled: options.retainedShadowEnabled ?? true,
    compareRetainedHeadlessCheckpointRoundTripFn: options.retainedComparisonGate === undefined
      ? undefined
      : async (...args: Parameters<typeof compareRetainedHeadlessCheckpointRoundTrip>) => {
          options.onRetainedComparisonStarted?.();
          await options.retainedComparisonGate;
          return compareRetainedHeadlessCheckpointRoundTrip(...args);
        },
    writeHeadlessTerminalFn: options.headlessWriteGate === undefined
      ? undefined
      : async (state: Parameters<typeof writeHeadlessTerminal>[0], data: string) => {
          await options.headlessWriteGate;
          await writeHeadlessTerminal(state, data);
        },
    createHeadlessTerminalStateFn: (createOptions: Parameters<typeof createHeadlessTerminalState>[0]) => {
      headlessCreateCount += 1;
      return createHeadlessTerminalState(createOptions);
    },
  } as ConstructorParameters<typeof SessionManager>[1]);
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  const api = manager as unknown as RetainedTerminalAuthorityApi;
  const readState = (targetSessionId: string): RetainedTerminalAuthorityState => {
    const retained = api.getRetainedTerminalAuthorityState?.(targetSessionId);
    if (retained) return retained;
    return buildLegacyOnlyNegativeProjection(manager, targetSessionId, {
      retainedScrollbackLines: options.omitResourceLimits
        ? ptyConfig.scrollbackLines
        : resourceLimits.terminal.scrollbackLines,
      retentionSource: options.omitResourceLimits
        ? 'pty.scrollbackLines'
        : 'resourceLimits.terminal.scrollbackLines',
      resourceLimits,
      ptyConfig,
    });
  };
  const router = {
    routeSessionOutput(sessionId: string, data: string, screenSeq?: number) {
      deliveries.push({
        sessionId,
        data,
        screenSeq,
        stateAtDelivery: structuredClone(readState(sessionId)),
      });
    },
    recordReplayEvent() {},
    refreshReplaySnapshots() {},
    clearSessionState() {},
    disableDebugReplayCapture() {},
    clearReplayEvents() {},
    sendSessionEvent() {},
  } as unknown as WsRouter;
  manager.setWsRouter(router);
  manager.onSessionFinalized(event => finalized.push(event));
  manager.onTerminalTitleChange((_sessionId, title) => titleEvents.push(title));
  const sessionId = options.sessionId ?? `retained-authority-${nextPid}`;
  manager.createSession('retained authority contract', 'bash', process.cwd(), { sessionId });
  const pty = ptys[0]!;
  pty.writes.length = 0;
  pty.resizeObserver = () => resizeStatesAtPty.push(structuredClone(readState(sessionId)));

  return {
    manager,
    api,
    pty,
    sessionId,
    deliveries,
    finalized,
    titleEvents,
    resizeStatesAtPty,
    headlessCreateCount() {
      return headlessCreateCount;
    },
    readState(targetSessionId = sessionId) {
      return readState(targetSessionId);
    },
    createAdditionalSession(additionalSessionId: string) {
      manager.createSession('retained authority sibling', 'bash', process.cwd(), { sessionId: additionalSessionId });
      const additionalPty = ptys.at(-1)!;
      additionalPty.writes.length = 0;
      additionalPty.resizeObserver = () => resizeStatesAtPty.push(structuredClone(readState(additionalSessionId)));
      return additionalPty;
    },
    async emitFor(targetSessionId: string, targetPty: FakePty, data: string) {
      const deliveryStart = deliveries.length;
      targetPty.emitData(data);
      assert.equal(
        await manager.waitForTerminalResourcePolicyHeadlessDrain(targetSessionId),
        true,
        'precondition: sibling SessionManager headless write chain drains',
      );
      assert.ok(deliveries.slice(deliveryStart).some(entry => entry.sessionId === targetSessionId),
        'precondition: sibling legacy renderer delivery remains live');
    },
    async emit(data: string) {
      const deliveryStart = deliveries.length;
      pty.emitData(data);
      assert.equal(
        await manager.waitForTerminalResourcePolicyHeadlessDrain(sessionId),
        true,
        'precondition: actual SessionManager headless write chain drains',
      );
      assert.ok(
        deliveries.slice(deliveryStart).some(entry => entry.sessionId === sessionId),
        'precondition: legacy renderer delivery remains live in shadow RED',
      );
    },
    close() {
      manager.deleteSession(sessionId);
      manager.stopAllCwdWatching();
    },
  };
}

function requireRetainedState(harness: Harness, failureSignature: string): RetainedTerminalAuthorityState {
  const state = harness.readState();
  assert.equal(state.availability, 'available', failureSignature);
  return state;
}

function assertCanonicalOrdinal(value: unknown, failureSignature: string): asserts value is string {
  assert.equal(checkpointProtocol.isCanonicalOrdinal64(value), true, failureSignature);
}

async function waitForHeadlessDrainBounded(
  manager: SessionManager,
  sessionId: string,
  timeoutMs = 1_000,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    void manager.waitForTerminalResourcePolicyHeadlessDrain(sessionId).finally(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function readConsumerLogicalLines(
  state: HeadlessTerminalState,
  bufferType: 'normal' | 'alternate',
): string[] {
  const buffer = state.terminal.buffer[bufferType];
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

function hashConsumerBuffer(
  state: HeadlessTerminalState,
  bufferType: 'normal' | 'alternate',
  kind: 'cells' | 'attributes',
): string {
  const buffer = state.terminal.buffer[bufferType];
  const cell = buffer.getNullCell();
  const values: unknown[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    values.push({ y, wrapped: line?.isWrapped ?? false });
    if (!line) continue;
    for (let x = 0; x < line.length; x += 1) {
      const current = line.getCell(x, cell);
      if (!current) continue;
      values.push(kind === 'cells'
        ? [x, current.getChars(), current.getCode(), current.getWidth()]
        : [
            x,
            current.getFgColorMode(), current.getFgColor(), current.getBgColorMode(), current.getBgColor(),
            current.isBold(), current.isDim(), current.isItalic(), current.isUnderline(), current.isBlink(),
            current.isInverse(), current.isInvisible(), current.isStrikethrough(), current.isOverline(),
          ]);
    }
  }
  return createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex');
}

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-1', async () => {
  const signature = 'REL-BGSTAB-011 AC-1 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    await harness.emit('commit-before-delivery-1\r\n');
    await harness.emit('commit-before-delivery-2\r\n');
    await harness.emit('commit-before-delivery-3\r\n');
    const state = requireRetainedState(harness, signature);
    assertCanonicalOrdinal(state.streamEpoch, signature);
    assertCanonicalOrdinal(state.sourceSeq, signature);
    const deliveredStates = harness.deliveries.slice(-3).map(entry => entry.stateAtDelivery);
    assert.equal(deliveredStates.every(Boolean), true, signature);
    const deliveredOrdinals = deliveredStates.map(entry => BigInt(entry!.sourceSeq));
    assert.equal(new Set(deliveredStates.map(entry => entry!.streamEpoch)).size, 1, signature);
    for (const delivered of deliveredStates) assertCanonicalOrdinal(delivered!.streamEpoch, signature);
    assert.deepEqual(
      deliveredOrdinals,
      [deliveredOrdinals[0]!, deliveredOrdinals[0]! + 1n, deliveredOrdinals[0]! + 2n],
      signature,
    );
    for (const delivered of deliveredStates) {
      assert.equal(delivered!.lastRecord?.modelCommitted, true, signature);
      assert.equal(delivered!.lastRecord?.deliveryCreatedAfterCommit, true, signature);
      assert.equal(delivered!.lastRecord?.sourceSeq, delivered!.sourceSeq, signature);
    }
    const advance = (checkpointProtocol as unknown as Partial<OrdinalModule>).advanceRetainedTerminalOrdinal;
    assert.equal(typeof advance, 'function', signature);
    assert.deepEqual(
      advance!({ streamEpoch: '7', sourceSeq: '18446744073709551615' }),
      { streamEpoch: '8', sourceSeq: '0', rolledOver: true },
      signature,
    );
  } finally {
    harness.close();
  }

  const rollover = createHarness({
    sessionId: 'retained-ordinal-rollover',
    initialRetainedOrdinal: { streamEpoch: '7', sourceSeq: '18446744073709551615' },
  });
  try {
    await rollover.emit('first-record-after-rollover\r\n');
    const state = requireRetainedState(rollover, signature);
    assert.equal(state.streamEpoch, '8', signature);
    assert.equal(state.sourceSeq, '0', signature);
    assert.equal(state.snapshotSeq, '0', signature);
    assert.ok(state.checkpoint.normal.logicalLines.some(line => line.includes('first-record-after-rollover')), signature);
    assert.equal(state.records.every(record => record.streamEpoch === '8'), true, signature);
    assert.equal(state.records.at(-1)?.streamEpoch, '8', signature);
    assert.equal(state.records.at(-1)?.sourceSeq, '0', signature);
    const delivery = rollover.deliveries.at(-1)?.stateAtDelivery;
    assert.equal(delivery?.streamEpoch, '8', signature);
    assert.equal(delivery?.snapshotSeq, '0', signature);
  } finally {
    rollover.close();
  }

  let releaseWriteGate!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWriteGate = resolve; });
  const gated = createHarness({ sessionId: 'retained-headless-write-gate', headlessWriteGate: writeGate });
  try {
    const before = requireRetainedState(gated, signature);
    gated.pty.emitData('gated-same-headless-write-chain\r\n');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(gated.manager.resize(gated.sessionId, 33, 7), true, signature);
    const blocked = requireRetainedState(gated, signature);
    assert.equal(blocked.sourceSeq, before.sourceSeq, signature);
    assert.equal(blocked.records.length, before.records.length, signature);
    assert.equal(gated.deliveries.length, 0, signature);
    assert.equal(gated.pty.resizes.length, 0, signature);
    releaseWriteGate();
    assert.equal(await gated.manager.waitForTerminalResourcePolicyHeadlessDrain(gated.sessionId), true, signature);
    const committed = requireRetainedState(gated, signature);
    assert.equal(BigInt(committed.sourceSeq), BigInt(before.sourceSeq) + 1n, signature);
    assert.deepEqual(committed.records.slice(-2).map(record => record.kind), ['output', 'resize'], signature);
    assert.equal(committed.records.at(-2)?.deliveryCreatedAfterCommit, true, signature);
    assert.equal(committed.records.at(-1)?.modelCommitted, true, signature);
    assert.equal(gated.deliveries.length, 1, signature);
    assert.deepEqual(gated.pty.resizes, [{ cols: 33, rows: 7 }], signature);
    assert.equal(gated.resizeStatesAtPty.at(-1)?.lastRecord?.kind, 'resize', signature);
  } finally {
    releaseWriteGate();
    await waitForHeadlessDrainBounded(gated.manager, gated.sessionId);
    gated.close();
  }
});

test('RED reviewer — populated Ordinal64 rollover keeps oldest retained marker epoch-qualified', async () => {
  const signature = 'REL-BGSTAB-011 AC-1/AC-2 populated rollover mislabeled old-epoch retained markers';
  const harness = createHarness({
    sessionId: 'populated-retained-ordinal-rollover',
    initialRetainedOrdinal: { streamEpoch: '7', sourceSeq: '5' },
  });
  try {
    await harness.emit('old-epoch-retained-row\r\n');
    const internal = (
      harness.manager as unknown as {
        sessions: Map<string, {
          retainedTerminal: { sourceSeq: string; snapshotSeq: string };
        }>;
      }
    ).sessions.get(harness.sessionId)!;
    internal.retainedTerminal.sourceSeq = '18446744073709551615';
    internal.retainedTerminal.snapshotSeq = '18446744073709551615';
    await harness.emit('new-epoch-retained-row\r\n');
    const state = harness.readState();
    assert.deepEqual({
      streamEpoch: state.streamEpoch,
      sourceSeq: state.sourceSeq,
      oldestRetainedStreamEpoch: state.oldestRetainedStreamEpoch,
      oldestRetainedSeq: state.oldestRetainedSeq,
      crossEpochBlocked: state.canary.blockers.includes('cross-epoch-retention-unavailable'),
      eligible: state.canary.eligible,
      retainedRecords: state.records.map(record => [record.streamEpoch, record.sourceSeq]),
    }, {
      streamEpoch: '8',
      sourceSeq: '0',
      oldestRetainedStreamEpoch: '7',
      oldestRetainedSeq: '6',
      crossEpochBlocked: true,
      eligible: false,
      retainedRecords: [['8', '0']],
    }, signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-2', async () => {
  const signature = 'REL-BGSTAB-011 AC-2 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness({ retainedScrollbackLines: 6 });
  try {
    assert.equal(harness.headlessCreateCount(), 1, signature);
    await harness.emit(`normal-α ${'wide中🙂e\u0301 '.repeat(12)}\r\n\x1b[31mstyled-normal\x1b[0m`);
    const beforeReflow = requireRetainedState(harness, signature);
    assert.equal(harness.manager.resize(harness.sessionId, 12, 6), true, signature);
    assert.deepEqual(harness.pty.resizes.at(-1), { cols: 12, rows: 6 }, signature);
    assert.equal(harness.resizeStatesAtPty.at(-1)?.checkpoint.cols, 12, signature);
    assert.equal(harness.resizeStatesAtPty.at(-1)?.checkpoint.rows, 6, signature);
    assert.equal(harness.resizeStatesAtPty.at(-1)?.lastRecord?.kind, 'resize', signature);
    assert.equal(harness.resizeStatesAtPty.at(-1)?.lastRecord?.modelCommitted, true, signature);
    await harness.emit('\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b7\x1b[?1049h\x1b[32malt-screen 中🙂e\u0301\x1b[0m\x1b[4;7H\x1b[31');
    const state = requireRetainedState(harness, signature);
    assert.equal(state.checkpoint.activeBuffer, 'alternate', signature);
    assert.ok(state.checkpoint.normal.logicalLines.some(line => line.includes('normal-α')), signature);
    assert.ok(state.checkpoint.alternate.logicalLines.some(line => line.includes('alt-screen')), signature);
    assert.equal(state.checkpoint.cols, 12, signature);
    assert.equal(state.checkpoint.rows, 6, signature);
    assert.equal(state.checkpoint.cursor.x, 6, signature);
    assert.equal(state.checkpoint.cursor.y, 3, signature);
    assert.ok(state.checkpoint.savedCursor, signature);
    assert.match(state.checkpoint.normal.cellHash, /^[a-f0-9]{64}$/u, signature);
    assert.match(state.checkpoint.normal.attributeHash, /^[a-f0-9]{64}$/u, signature);
    assert.match(state.checkpoint.alternate.cellHash, /^[a-f0-9]{64}$/u, signature);
    assert.match(state.checkpoint.alternate.attributeHash, /^[a-f0-9]{64}$/u, signature);
    assert.notEqual(state.checkpoint.normal.cellHash, state.checkpoint.alternate.cellHash, signature);
    assert.notEqual(state.checkpoint.normal.attributeHash, state.checkpoint.alternate.attributeHash, signature);
    assert.notEqual(beforeReflow.checkpoint.normal.cellHash, state.checkpoint.normal.cellHash, signature);
    assert.notEqual(beforeReflow.checkpoint.normal.attributeHash, state.checkpoint.normal.attributeHash, signature);
    const repeated = requireRetainedState(harness, signature);
    assert.equal(repeated.checkpoint.normal.cellHash, state.checkpoint.normal.cellHash, signature);
    assert.equal(repeated.checkpoint.normal.attributeHash, state.checkpoint.normal.attributeHash, signature);
    assert.ok(Object.keys(state.checkpoint.modes).length > 0, signature);
    assert.equal(state.checkpoint.modes.applicationCursorKeysMode, true, signature);
    assert.equal(state.checkpoint.modes.bracketedPasteMode, true, signature);
    assert.equal(state.checkpoint.modes.mouseTrackingMode, 'vt200', signature);
    assert.equal(state.checkpoint.pendingEscapeTailAnsi, '\x1b[31', signature);
    assertCanonicalOrdinal(state.snapshotSeq, signature);
    assertCanonicalOrdinal(state.oldestRetainedSeq, signature);

    const consumer = createHeadlessTerminalState({ cols: 12, rows: 6, scrollbackLines: 6 });
    try {
      await writeHeadlessTerminal(consumer, state.checkpoint.rehydrateAnsi);
      assert.deepEqual(readConsumerLogicalLines(consumer, 'normal'), state.checkpoint.normal.logicalLines, signature);
      assert.deepEqual(readConsumerLogicalLines(consumer, 'alternate'), state.checkpoint.alternate.logicalLines, signature);
      assert.equal(hashConsumerBuffer(consumer, 'normal', 'cells'), state.checkpoint.normal.cellHash, signature);
      assert.equal(hashConsumerBuffer(consumer, 'normal', 'attributes'), state.checkpoint.normal.attributeHash, signature);
      assert.equal(hashConsumerBuffer(consumer, 'alternate', 'cells'), state.checkpoint.alternate.cellHash, signature);
      assert.equal(hashConsumerBuffer(consumer, 'alternate', 'attributes'), state.checkpoint.alternate.attributeHash, signature);
      assert.equal(consumer.terminal.buffer.active.type, state.checkpoint.activeBuffer, signature);
      assert.deepEqual(
        { x: consumer.terminal.buffer.active.cursorX, y: consumer.terminal.buffer.active.cursorY },
        state.checkpoint.cursor,
        signature,
      );
      assert.equal(harness.headlessCreateCount(), 1, signature);
      assert.deepEqual(consumer.terminal.modes, state.checkpoint.modes, signature);

      const completedTailAndRestore = 'mTAIL\x1b[0m\x1b[?1049l\x1b8RESTORED';
      await writeHeadlessTerminal(consumer, `${state.checkpoint.pendingEscapeTailAnsi}${completedTailAndRestore}`);
      await harness.emit(completedTailAndRestore);
      const completed = requireRetainedState(harness, signature);
      assert.equal(completed.checkpoint.pendingEscapeTailAnsi, '', signature);
      assert.equal(completed.checkpoint.activeBuffer, 'normal', signature);
      assert.deepEqual(readConsumerLogicalLines(consumer, 'normal'), completed.checkpoint.normal.logicalLines, signature);
      assert.equal(hashConsumerBuffer(consumer, 'normal', 'cells'), completed.checkpoint.normal.cellHash, signature);
      assert.equal(hashConsumerBuffer(consumer, 'normal', 'attributes'), completed.checkpoint.normal.attributeHash, signature);
      assert.deepEqual(
        { x: consumer.terminal.buffer.active.cursorX, y: consumer.terminal.buffer.active.cursorY },
        completed.checkpoint.cursor,
        signature,
      );
    } finally {
      disposeHeadlessTerminal(consumer);
    }
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-3', async () => {
  const signature = 'REL-BGSTAB-011 AC-3 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness({ maxSnapshotBytes: 16 });
  try {
    await harness.emit('retained-checkpoint-must-not-empty-when-legacy-cap-is-small\r\n');
    const state = requireRetainedState(harness, signature);
    assert.deepEqual(
      [state.budgets.retention.unit, state.budgets.aggregateModelMemory.unit,
        state.budgets.checkpointChunk.unit, state.budgets.perClientInflight.unit,
        state.budgets.socketGate.unit, state.budgets.browserWriteSlice.unit],
      ['lines', 'bytes', 'bytes', 'bytes', 'bytes', 'bytes'],
      signature,
    );
    assert.equal(new Set(Object.values(state.budgets).map(budget => budget.key)).size, 6, signature);
    assert.equal(state.budgets.aggregateModelMemory.configured, false, signature);
    assert.equal(state.budgets.aggregateModelMemory.source, 'unconfigured', signature);
    assert.equal(state.budgets.checkpointChunk.configured, false, signature);
    assert.equal(state.budgets.checkpointChunk.source, 'unconfigured', signature);
    assert.equal(state.budgets.aggregateModelMemory.value, null, signature);
    assert.equal(state.budgets.checkpointChunk.value, null, signature);
    assert.equal(
      state.budgets.perClientInflight.value,
      config.resourceLimits!.ws.perClientOutputQueueMaxBytes,
      signature,
    );
    assert.equal(
      state.budgets.socketGate.value,
      config.resourceLimits!.ws.serverBufferedHighWaterBytes,
      signature,
    );
    assert.equal(
      state.budgets.browserWriteSlice.value,
      config.resourceLimits!.terminal.visibleFlushBudgetBytes,
      signature,
    );
    assert.equal(state.checkpoint.truncated, false, signature);
    assert.ok(state.checkpoint.serializedData.length > 0, signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-4', async () => {
  const signature = 'REL-BGSTAB-011 AC-4 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    assert.equal(harness.manager.resize(harness.sessionId, 17, 5), true, signature);
    await harness.emit('wide=中 combining=e\u0301 emoji=👩‍💻\r\n');
    for (let attempt = 0; attempt < 100 && harness.readState().comparer.axes.logicalLines === 'unavailable'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const state = requireRetainedState(harness, signature);
    assert.equal(state.mode, 'shadow', signature);
    assert.equal(state.comparer.result, 'unavailable', signature);
    assert.equal(state.comparer.deliveryAuthority, 'legacy', signature);
    assert.deepEqual(state.comparer.axes, {
      logicalLines: 'match',
      cells: 'match',
      unicodeWidth: 'match',
      cursor: 'match',
      modes: 'match',
      activeBuffer: 'match',
      parserTail: 'unavailable',
      eviction: 'unavailable',
    }, signature);
    assert.ok(harness.deliveries.some(entry => entry.data.includes('wide=中')), signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-5', async () => {
  const signature = 'REL-BGSTAB-011 AC-5 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    await harness.emit(
      '\x1b]0;retained-title\x07'
      + '\x1b]0;retained-title\x07'
      + '\x1b]7;file://localhost/tmp/retained\x07'
      + '\x07\x1b]133;A\x07\x1b[6n',
    );
    const state = requireRetainedState(harness, signature);
    assert.deepEqual(
      state.facts.map(fact => [fact.kind, fact.semanticKey, fact.disposition]),
      [
        ['title', 'retained-title', 'committed'],
        ['title', 'retained-title', 'committed'],
        ['cwd', '/tmp/retained', 'committed'],
        ['bell', 'bell', 'committed'],
        ['status', 'prompt-start', 'committed'],
        ['query-request', 'DSR-6', 'rejected'],
      ],
      signature,
    );
    for (const fact of state.facts) {
      assertCanonicalOrdinal(fact.streamEpoch, signature);
      assertCanonicalOrdinal(fact.sourceSeq, signature);
      assert.ok(Number.isInteger(fact.ordinal) && fact.ordinal >= 0, signature);
      assert.ok(['committed', 'duplicate', 'rejected'].includes(fact.disposition), signature);
    }
    assert.equal(new Set(state.facts.map(fact => `${fact.streamEpoch}:${fact.sourceSeq}:${fact.ordinal}`)).size, state.facts.length, signature);
    const delivery = harness.deliveries.find(entry => entry.sessionId === harness.sessionId);
    assert.deepEqual(delivery?.stateAtDelivery?.facts, state.facts, signature);
    assert.equal(harness.titleEvents.filter(title => title === 'retained-title').length, 1, signature);
    assert.equal(harness.pty.writes.some(write => write.includes('\x1b[')), false, signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-6', async () => {
  const signature = 'REL-BGSTAB-011 AC-6 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    await harness.emit('driver-lease-precondition\r\n');
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'client-a', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'client-b', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    const first = harness.api.claimRetainedTerminalDriverLease?.(harness.sessionId, 'client-a', 1);
    assert.equal(first?.ok, true, signature);
    const stale = harness.api.observeRetainedTerminalDriverMutation?.(
      harness.sessionId, 'client-b', 1, first!.generation, 'resize',
    );
    assert.deepEqual(stale, { accepted: false, reason: 'stale-owner', shadowOnly: true }, signature);
    for (const kind of ['input', 'resize', 'query-reply'] as const) {
      assert.equal(
        harness.api.observeRetainedTerminalDriverMutation?.(
          harness.sessionId, 'client-b', 1, first!.generation, kind,
        ).accepted,
        false,
        signature,
      );
    }
    const handoff = harness.api.handoffRetainedTerminalDriverLease?.(
      harness.sessionId, 'client-a', 1, 'client-b', 1, first!.generation,
    );
    assert.equal(handoff?.ok, true, signature);
    assert.notEqual(handoff?.generation, first?.generation, signature);
    assert.equal(
      harness.api.observeRetainedTerminalDriverMutation?.(
        harness.sessionId, 'client-a', 1, first!.generation, 'input',
      ).accepted,
      false,
      signature,
    );
    assert.equal(
      harness.api.observeRetainedTerminalDriverMutation?.(
        harness.sessionId, 'client-b', 1, handoff!.generation, 'query-reply',
      ).accepted,
      true,
      signature,
    );
    assert.deepEqual(
      harness.api.unregisterRetainedTerminalClientView?.(harness.sessionId, 'client-b', 1),
      { ok: true, reason: 'unregistered-driver-revoked' },
      signature,
    );
    for (const kind of ['input', 'resize', 'query-reply'] as const) {
      assert.equal(harness.api.observeRetainedTerminalDriverMutation?.(
        harness.sessionId, 'client-b', 1, handoff!.generation, kind,
      ).accepted, false, signature);
    }
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'client-b', 2),
      { ok: true, reason: 'registered' },
      signature,
    );
    const rebound = harness.api.claimRetainedTerminalDriverLease?.(harness.sessionId, 'client-b', 2);
    assert.equal(rebound?.ok, true, signature);
    assert.ok(BigInt(rebound!.generation) > BigInt(handoff!.generation), signature);
    const released = harness.api.releaseRetainedTerminalDriverLease?.(
      harness.sessionId, 'client-b', 2, rebound!.generation,
    );
    assert.equal(released?.ok, true, signature);
    assert.equal(released?.ownerClientId, null, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — failed competing mutation lease rolls back only its newly registered view', () => {
  const signature = 'REL-BGSTAB-011 AC-6 failed competing lease leaked a client view or removed a pre-existing view';
  const harness = createHarness();
  try {
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView(harness.sessionId, 'owner', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    assert.equal(
      harness.api.claimRetainedTerminalDriverLease(harness.sessionId, 'owner', 1).ok,
      true,
      signature,
    );

    const freshContender = harness.api.establishRetainedTerminalMutationLease(
      harness.sessionId,
      'fresh-contender',
      1,
    );
    assert.deepEqual(
      freshContender,
      { ok: false, reason: 'driver-owned-by-other-client' },
      signature,
    );
    assert.deepEqual(
      harness.readState().clients.map(client => client.clientId),
      ['owner'],
      signature,
    );

    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView(
        harness.sessionId,
        'pre-registered-contender',
        2,
        { slow: true },
      ),
      { ok: true, reason: 'registered' },
      signature,
    );
    const existingContender = harness.api.establishRetainedTerminalMutationLease(
      harness.sessionId,
      'pre-registered-contender',
      2,
    );
    assert.deepEqual(
      existingContender,
      { ok: false, reason: 'driver-owned-by-other-client' },
      signature,
    );
    assert.deepEqual(
      harness.readState().clients.map(client => ({
        clientId: client.clientId,
        viewGeneration: client.viewGeneration,
        slow: client.slow,
      })),
      [
        { clientId: 'owner', viewGeneration: 1, slow: false },
        { clientId: 'pre-registered-contender', viewGeneration: 2, slow: true },
      ],
      signature,
    );
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-7', async () => {
  const signature = 'REL-BGSTAB-011 AC-7 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const sessionId = 'shadow-mismatch-session';
  const harness = createHarness({
    sessionId,
    shadowMismatchSessionId: sessionId,
    modelDegradationSessionId: sessionId,
  });
  const siblingId = 'shadow-healthy-sibling';
  const siblingPty = harness.createAdditionalSession(siblingId);
  try {
    await harness.emit('legacy-delivery-survives-shadow-failure-policy\r\n');
    await harness.emitFor(siblingId, siblingPty, 'sibling-delivery-survives\r\n');
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(sessionId, 'driver-a', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(sessionId, 'stale-driver', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    const lease = harness.api.claimRetainedTerminalDriverLease?.(sessionId, 'driver-a', 1);
    assert.equal(lease?.ok, true, signature);
    assert.equal(harness.api.observeRetainedTerminalDriverMutation?.(
      sessionId, 'stale-driver', 1, lease!.generation, 'input',
    ).accepted, false, signature);
    const state = requireRetainedState(harness, signature);
    const sibling = harness.readState(siblingId);
    assert.equal(state.comparer.result, 'mismatch', signature);
    assert.equal(state.comparer.axes.cells, 'mismatch', signature);
    assert.equal(state.comparer.axes.logicalLines, 'match', signature);
    assert.equal(state.comparer.axes.cursor, 'match', signature);
    assert.equal(state.canary.eligible, false, signature);
    assert.ok(state.canary.blockers.includes('shadow-comparer-mismatch'), signature);
    assert.ok(state.canary.blockers.includes('model-degradation'), signature);
    assert.ok(state.canary.blockers.includes('driver-lease-failure'), signature);
    assert.equal(state.comparer.failureBehavior, 'block-session-canary-only', signature);
    assert.equal(state.comparer.deliveryAuthority, 'legacy', signature);
    assert.equal(sibling.comparer.result, 'unavailable', signature);
    assert.equal(sibling.canary.blockers.includes('shadow-comparer-mismatch'), false, signature);
    assert.ok(harness.deliveries.some(entry => entry.sessionId === sessionId && entry.data.includes('legacy-delivery-survives')),
      signature);
    assert.ok(harness.deliveries.some(entry => entry.sessionId === siblingId && entry.data.includes('sibling-delivery')),
      signature);
    assert.equal(harness.pty.killCount, 0, signature);
    assert.equal(siblingPty.killCount, 0, signature);
  } finally {
    harness.manager.deleteSession(siblingId);
    harness.close();
  }

  const disabled = createHarness({
    sessionId: 'retained-shadow-disabled',
  });
  try {
    await disabled.emit('shadow-ledger-before-disable\r\n');
    assert.deepEqual(
      disabled.api.registerRetainedTerminalClientView?.(disabled.sessionId, 'disabled-client', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    assert.equal(
      disabled.api.claimRetainedTerminalDriverLease?.(disabled.sessionId, 'disabled-client', 1).ok,
      true,
      signature,
    );
    assert.equal(disabled.api.setRetainedTerminalShadowEnabled?.(false), true, signature);
    const state = requireRetainedState(disabled, signature);
    assert.equal(state.mode, 'disabled', signature);
    assert.deepEqual(state.records, [], signature);
    assert.deepEqual(state.facts, [], signature);
    assert.deepEqual(state.clients, [], signature);
    assert.deepEqual(state.driverLease, { ownerClientId: null, generation: state.driverLease.generation, state: 'revoked' }, signature);
    assert.deepEqual(state.shadowSettlement, {
      admissionOpen: false,
      settled: true,
      factLedgerSettlements: 1,
      checkpointLedgerSettlements: 1,
      timerSettlements: 1,
    }, signature);
    assert.ok(state.canary.blockers.includes('shadow-disabled'), signature);
    assert.deepEqual(
      disabled.api.registerRetainedTerminalClientView?.(disabled.sessionId, 'disabled-client', 1),
      { ok: false, reason: 'shadow-disabled' },
      signature,
    );
    await disabled.emit('legacy-delivery-when-shadow-disabled\r\n');
    const afterDisabledOutput = requireRetainedState(disabled, signature);
    assert.equal(afterDisabledOutput.mode, 'disabled', signature);
    assert.deepEqual(afterDisabledOutput.records, [], signature);
    assert.deepEqual(afterDisabledOutput.facts, [], signature);
    assert.deepEqual(afterDisabledOutput.clients, [], signature);
    assert.equal(afterDisabledOutput.driverLease.state, 'revoked', signature);
    assert.deepEqual(afterDisabledOutput.shadowSettlement, state.shadowSettlement, signature);
    assert.ok(disabled.deliveries.some(entry => entry.data.includes('legacy-delivery-when-shadow-disabled')), signature);
    assert.ok(disabled.manager.getScreenSnapshot(disabled.sessionId)?.data.length, signature);
  } finally {
    disabled.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-8', async () => {
  const signature = 'REL-BGSTAB-011 AC-8 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.sessionId, 'codex\r');
    for (const repaint of [
      'codex\r\n',
      '\x1b[2;4H\x1b[?25h',
      'tokens: 1,234 elapsed 00:01\r',
      '> waiting for input\x1b[?25h',
    ]) {
      await harness.emit(repaint);
      assert.equal(harness.manager.getSession(harness.sessionId)?.status, 'idle', signature);
    }
    const state = requireRetainedState(harness, signature);
    assert.equal(state.canary.blockers.includes('ai-tui-idle-invariant'), false, signature);
    assert.equal(
      state.facts.some(fact => ['local-echo', 'cursor-repaint', 'ticker', 'waiting-input-repaint'].includes(fact.kind)
        && fact.semanticKey === 'running'),
      false,
      signature,
    );
    await harness.emit('Executing semantic tool call: read repository\r\n');
    const runningBoundary = requireRetainedState(harness, signature);
    assert.equal(
      runningBoundary.facts.some(fact => fact.kind === 'substantive-agent-output'
        && fact.semanticKey === 'running' && fact.disposition === 'committed'),
      true,
      signature,
    );
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-9', async () => {
  const signature = 'REL-BGSTAB-011 AC-9 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness({ sessionId: 'cleanup-delete-session' });
  try {
    await harness.emit('cleanup-ledger\r\n');
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'client-cleanup', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    const lease = harness.api.claimRetainedTerminalDriverLease?.(harness.sessionId, 'client-cleanup', 1);
    assert.equal(lease?.ok, true, signature);
    assert.equal(harness.manager.deleteSession(harness.sessionId), true, signature);
    assert.equal(harness.manager.deleteSession(harness.sessionId), false, signature);
    harness.pty.emitData('late-output');
    assert.equal(harness.manager.writeInput(harness.sessionId, 'late-input'), false, signature);
    assert.equal(harness.manager.resize(harness.sessionId, 99, 33), false, signature);
    assert.equal(harness.api.observeRetainedTerminalDriverMutation?.(
      harness.sessionId, 'client-cleanup', 1, lease!.generation, 'query-reply',
    ).accepted, false, signature);
    const availability = harness.api.getRetainedTerminalAuthorityAvailability?.(harness.sessionId);
    assert.equal(availability?.availability, 'session-terminated', signature);
    if (availability?.availability === 'session-terminated') {
      assert.deepEqual(availability.cleanup, {
        admissionOpen: false,
        settled: true,
        rejectedLateMessages: 4,
        factLedgerSettlements: 1,
        checkpointLedgerSettlements: 1,
        timerSettlements: 1,
      }, signature);
      assert.deepEqual(availability.driverLease, { state: 'revoked', ownerClientId: null }, signature);
    }
    assert.equal(harness.finalized.length, 1, signature);
  } finally {
    harness.close();
  }

  const stopped = createHarness({ sessionId: 'cleanup-explicit-stop' });
  try {
    await stopped.emit('before-explicit-stop\r\n');
    assert.equal(await stopped.manager.terminateSession(stopped.sessionId, {
      reason: 'shutdown', mode: 'observe', killPty: true,
    }), true, signature);
    const availability = stopped.api.getRetainedTerminalAuthorityAvailability?.(stopped.sessionId);
    assert.equal(availability?.availability, 'session-terminated', signature);
    if (availability?.availability === 'session-terminated') {
      assert.equal(availability.cleanup.factLedgerSettlements, 1, signature);
      assert.equal(availability.cleanup.checkpointLedgerSettlements, 1, signature);
      assert.equal(availability.cleanup.timerSettlements, 1, signature);
    }
    assert.equal(stopped.finalized.length, 1, signature);
  } finally {
    stopped.close();
  }

  const replaced = createHarness({ sessionId: 'cleanup-generation-replace' });
  try {
    await replaced.emit('before-generation-replacement\r\n');
    assert.deepEqual(
      replaced.api.registerRetainedTerminalClientView?.(replaced.sessionId, 'old-driver', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    const oldLease = replaced.api.claimRetainedTerminalDriverLease?.(replaced.sessionId, 'old-driver', 1);
    assert.equal(oldLease?.ok, true, signature);
    const oldGenerationState = replaced.readState();
    const oldRestore = replaced.manager.getAtomicRestoreSnapshot(replaced.sessionId);
    assert.equal(oldRestore.ok, true, signature);
    const oldAuthorityEpoch = oldRestore.ok ? oldRestore.payload.authorityEpoch : '';
    const previousPty = replaced.pty;
    const nextPty = replaced.createAdditionalSession(replaced.sessionId);
    assert.equal(previousPty.killCount, 1, signature);
    assert.equal(replaced.finalized.filter(event => event.reason === 'tab-restart').length, 1, signature);
    await replaced.emitFor(replaced.sessionId, nextPty, 'new-generation-output\r\n');
    const newGenerationBeforeLateMessages = replaced.readState();
    assert.notEqual(newGenerationBeforeLateMessages.streamEpoch, oldGenerationState.streamEpoch, signature);
    assert.equal(newGenerationBeforeLateMessages.driverLease.ownerClientId, null, signature);
    assert.equal(newGenerationBeforeLateMessages.clients.length, 0, signature);
    assert.equal(
      newGenerationBeforeLateMessages.facts.some(fact => fact.streamEpoch === oldGenerationState.streamEpoch),
      false,
      signature,
    );
    assert.deepEqual(
      replaced.api.getRetainedTerminalAuthorityAvailability?.(replaced.sessionId),
      { availability: 'available' },
      signature,
    );
    previousPty.emitData('late-old-generation-callback');
    assert.equal(replaced.deliveries.some(entry => entry.data.includes('late-old-generation-callback')), false, signature);
    assert.deepEqual(
      replaced.api.getRetainedTerminalGenerationRejectionState(replaced.sessionId, oldAuthorityEpoch),
      {
        sessionId: replaced.sessionId,
        authorityEpoch: oldAuthorityEpoch,
        streamEpoch: oldGenerationState.streamEpoch,
        terminationReason: 'tab-restart',
        rejectedLateMessages: 1,
        lastRejectionReason: 'late-pty-output',
      },
      signature,
    );
    for (const kind of ['input', 'resize', 'query-reply'] as const) {
      assert.equal(replaced.api.observeRetainedTerminalDriverMutation?.(
        replaced.sessionId, 'old-driver', 1, oldLease!.generation, kind,
      ).accepted, false, signature);
    }
    const newGenerationAfterLateMessages = replaced.readState();
    assert.equal(newGenerationAfterLateMessages.streamEpoch, newGenerationBeforeLateMessages.streamEpoch, signature);
    assert.equal(newGenerationAfterLateMessages.sourceSeq, newGenerationBeforeLateMessages.sourceSeq, signature);
    assert.equal(
      newGenerationAfterLateMessages.checkpoint.serializedData,
      newGenerationBeforeLateMessages.checkpoint.serializedData,
      signature,
    );
    assert.equal(newGenerationAfterLateMessages.facts.length, newGenerationBeforeLateMessages.facts.length, signature);
  } finally {
    replaced.close();
  }

  const terminalClose = createHarness({ sessionId: 'cleanup-terminal-close' });
  try {
    assert.equal(terminalClose.manager.deleteSession(terminalClose.sessionId, 'tab-delete'), true, signature);
    assert.equal(terminalClose.finalized.at(-1)?.reason, 'tab-delete', signature);
  } finally {
    terminalClose.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-1', async () => {
  const signature = 'REL-BGSTAB-007 AC-1 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness({ retainedScrollbackLines: 13, legacyScrollbackLines: 2 });
  try {
    await harness.emit('policy-provenance\r\n');
    const state = requireRetainedState(harness, signature);
    assert.equal(state.retentionPolicy.effectiveRetainedScrollbackLines, 13, signature);
    assert.equal(state.retentionPolicy.source, 'resourceLimits.terminal.scrollbackLines', signature);
    assert.equal(state.retentionPolicy.conflictDetected, true, signature);
    assert.equal(state.retentionPolicy.sourceKind, 'canonical-explicit', signature);
    assert.equal(state.retentionPolicy.retentionPolicyId, LEGACY_TERMINAL_RESOURCE_POLICY_ID, signature);
  } finally {
    harness.close();
  }

  const fallback = createHarness({ omitResourceLimits: true, legacyScrollbackLines: 5 });
  try {
    await fallback.emit('legacy-fallback-policy\r\n');
    const state = requireRetainedState(fallback, signature);
    assert.equal(state.retentionPolicy.effectiveRetainedScrollbackLines, 5, signature);
    assert.equal(state.retentionPolicy.source, 'pty.scrollbackLines', signature);
    assert.equal(state.retentionPolicy.conflictDetected, false, signature);
    assert.equal(state.retentionPolicy.sourceKind, 'legacy-explicit', signature);
    assert.equal(state.retentionPolicy.retentionPolicyId, LEGACY_TERMINAL_RESOURCE_POLICY_ID, signature);
  } finally {
    fallback.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-2', async () => {
  const signature = 'REL-BGSTAB-007 AC-2 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness({ retainedScrollbackLines: 4 });
  try {
    await harness.emit('first-model-record\r\n');
    await harness.emit('second-model-record\r\n');
    await harness.emit('third-model-record\r\n');
    const state = requireRetainedState(harness, signature);
    assert.equal(state.lastRecord?.modelCommitted, true, signature);
    assert.equal(state.lastRecord?.sourceSeq, state.sourceSeq, signature);
    assert.ok(state.checkpoint.normal.logicalLines.some(line => line.includes('first-model-record')), signature);
    assert.ok(state.checkpoint.normal.logicalLines.some(line => line.includes('second-model-record')), signature);
    assert.ok(state.checkpoint.normal.logicalLines.some(line => line.includes('third-model-record')), signature);
    assert.ok(
      state.checkpoint.normal.logicalLines.length <= state.retentionPolicy.effectiveRetainedScrollbackLines
        + state.checkpoint.rows,
      signature,
    );
    const sessionDeliveries = harness.deliveries.filter(delivery => delivery.sessionId === harness.sessionId).slice(-3);
    assert.equal(sessionDeliveries.length, 3, signature);
    assert.ok(sessionDeliveries.every(delivery => delivery.stateAtDelivery?.lastRecord?.modelCommitted === true), signature);
    assert.equal(state.records.length, 3, signature);
    assert.ok(state.records.every(record => record.modelCommitted && record.deliveryCreatedAfterCommit), signature);
    assert.deepEqual(
      state.records.map(record => record.sourceSeq),
      sessionDeliveries.map(delivery => delivery.stateAtDelivery?.sourceSeq),
      signature,
    );
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-3', async () => {
  const signature = 'REL-BGSTAB-007 AC-3 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    await harness.emit('normal-before-alt\r\n\x1b[?1049hALT中🙂\x1b[2;5H\x1b[?25l\x1b[31');
    const before = requireRetainedState(harness, signature);
    assert.equal(before.checkpoint.activeBuffer, 'alternate', signature);
    assert.equal(before.checkpoint.pendingEscapeTailAnsi, '\x1b[31', signature);
    await harness.emit('mRED\x1b[0m\x1b[?1049l');
    const after = requireRetainedState(harness, signature);
    assert.equal(after.checkpoint.activeBuffer, 'normal', signature);
    assert.ok(after.checkpoint.normal.logicalLines.some(line => line.includes('normal-before-alt')), signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-6', async () => {
  const signature = 'REL-BGSTAB-007 AC-6 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    await harness.emit('typed-budget-boundaries\r\n');
    const state = requireRetainedState(harness, signature);
    assert.deepEqual(
      Object.values(state.budgets).map(budget => [budget.key, budget.unit, budget.source, budget.configured]),
      [
        ['retention', 'lines', 'resourceLimits.terminal.scrollbackLines', true],
        ['aggregate-model-memory', 'bytes', 'unconfigured', false],
        ['checkpoint-chunk', 'bytes', 'unconfigured', false],
        ['per-client-inflight', 'bytes', 'resourceLimits.ws.perClientOutputQueueMaxBytes', true],
        ['socket-gate', 'bytes', 'resourceLimits.ws.serverBufferedHighWaterBytes', true],
        ['browser-write-slice', 'bytes', 'resourceLimits.terminal.visibleFlushBudgetBytes', true],
      ],
      signature,
    );
    assert.equal(state.budgets.aggregateModelMemory.value, null, signature);
    assert.equal(state.budgets.checkpointChunk.value, null, signature);
    assert.equal(
      state.budgets.perClientInflight.value,
      config.resourceLimits!.ws.perClientOutputQueueMaxBytes,
      signature,
    );
    assert.equal(
      state.budgets.socketGate.value,
      config.resourceLimits!.ws.serverBufferedHighWaterBytes,
      signature,
    );
    assert.equal(
      state.budgets.browserWriteSlice.value,
      config.resourceLimits!.terminal.visibleFlushBudgetBytes,
      signature,
    );
    assert.notEqual(state.budgets.perClientInflight.value, state.budgets.socketGate.value, signature);
    assert.notEqual(state.budgets.socketGate.value, state.budgets.browserWriteSlice.value, signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-7', async () => {
  const signature = 'REL-BGSTAB-007 AC-7 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness({ retainedScrollbackLines: 2 });
  try {
    assert.equal(harness.manager.resize(harness.sessionId, 16, 2), true, signature);
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'fast-view', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'slow-view', 1, { slow: true }),
      { ok: true, reason: 'registered' },
      signature,
    );
    for (let index = 0; index < 8; index += 1) await harness.emit(`evict-row-${index}\r\n`);
    const state = requireRetainedState(harness, signature);
    assert.ok(state.eviction.evictedRows > 0, signature);
    assert.ok(state.eviction.evictedBytes > 0, signature);
    assert.equal(state.eviction.reason, 'retention-limit', signature);
    assert.equal(state.eviction.policyId, state.retentionPolicy.retentionPolicyId, signature);
    assert.equal(state.eviction.completeLogicalRowBoundary, true, signature);
    assert.equal(state.eviction.dataGapRequired, true, signature);
    assert.equal(state.eviction.restoreNeeded, true, signature);
    assert.equal(state.eviction.staleViewReady, false, signature);
    const fast = state.clients.find(client => client.clientId === 'fast-view');
    const slow = state.clients.find(client => client.clientId === 'slow-view');
    assert.deepEqual(
      { gap: fast?.dataGapRequired, restore: fast?.restoreNeeded, ready: fast?.ready },
      { gap: false, restore: false, ready: true },
      signature,
    );
    assert.deepEqual(
      { gap: slow?.dataGapRequired, restore: slow?.restoreNeeded, ready: slow?.ready },
      { gap: true, restore: true, ready: false },
      signature,
    );
    assertCanonicalOrdinal(state.oldestRetainedSeq, signature);
    assert.ok(BigInt(state.oldestRetainedSeq) > 0n, signature);
    assert.ok(BigInt(state.oldestRetainedSeq) <= BigInt(state.snapshotSeq), signature);
    await harness.emit('producer-continues-after-eviction\r\n');
    assert.ok(harness.deliveries.some(entry => entry.data.includes('producer-continues-after-eviction')), signature);
    assert.equal(harness.pty.killCount, 0, signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-9', async () => {
  const signature = 'REL-BGSTAB-007 AC-9 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    for (let index = 0; index < 8; index += 1) {
      const registered = harness.api.registerRetainedTerminalClientView?.(
        harness.sessionId,
        `client-${index}`,
        index + 1,
        { slow: index === 7 },
      );
      assert.deepEqual(registered, { ok: true, reason: 'registered' }, signature);
    }
    const first = harness.api.claimRetainedTerminalDriverLease?.(harness.sessionId, 'client-0', 1);
    assert.equal(first?.ok, true, signature);
    const second = harness.api.claimRetainedTerminalDriverLease?.(harness.sessionId, 'client-1', 2);
    assert.equal(second?.ok, false, signature);
    assert.equal(second?.reason, 'driver-owned-by-other-client', signature);
    const stale = harness.api.observeRetainedTerminalDriverMutation?.(
      harness.sessionId, 'client-1', 2, first!.generation, 'input',
    );
    assert.equal(stale?.accepted, false, signature);
    await harness.emit('multi-client-model\r\n');
    const state = requireRetainedState(harness, signature);
    assert.equal(state.clients.length, 8, signature);
    assert.equal(new Set(state.clients.map(client => client.clientId)).size, 8, signature);
    assert.deepEqual(state.clients.map(client => client.viewGeneration), [1, 2, 3, 4, 5, 6, 7, 8], signature);
    const slow = state.clients.find(client => client.clientId === 'client-7');
    assert.equal(slow?.slow, true, signature);
    assert.ok((slow?.pendingBytes ?? 0) > 0, signature);
    assert.equal(slow?.blocksModel, false, signature);
    assert.equal(state.lastRecord?.modelCommitted, true, signature);
    assert.equal(harness.deliveries.at(-1)?.data.includes('multi-client-model'), true, signature);
    const unregistered = harness.api.unregisterRetainedTerminalClientView?.(harness.sessionId, 'client-7', 8);
    assert.deepEqual(unregistered, { ok: true, reason: 'unregistered' }, signature);
    assert.equal(harness.readState().clients.some(client => client.clientId === 'client-7'), false, signature);
  } finally {
    harness.close();
  }
});

test('Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-10', async () => {
  const signature = 'REL-BGSTAB-007 AC-10 Retained server model shadow and driver lease 계약 부재 때문에 실패';
  const harness = createHarness();
  try {
    await harness.emit('server-authority-survives-client-remount\r\n');
    const before = requireRetainedState(harness, signature);
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'browser-a', 1),
      { ok: true, reason: 'registered' },
      signature,
    );
    const lease = harness.api.claimRetainedTerminalDriverLease?.(harness.sessionId, 'browser-a', 1);
    assert.equal(lease?.ok, true, signature);
    assert.equal(harness.api.releaseRetainedTerminalDriverLease?.(
      harness.sessionId, 'browser-a', 1, lease!.generation,
    ).ok, true, signature);
    assert.deepEqual(
      harness.api.unregisterRetainedTerminalClientView?.(harness.sessionId, 'browser-a', 1),
      { ok: true, reason: 'unregistered' },
      signature,
    );
    assert.deepEqual(
      harness.api.registerRetainedTerminalClientView?.(harness.sessionId, 'browser-a', 2),
      { ok: true, reason: 'registered' },
      signature,
    );
    const after = requireRetainedState(harness, signature);
    assert.equal(after.streamEpoch, before.streamEpoch, signature);
    assert.equal(after.sourceSeq, before.sourceSeq, signature);
    assert.equal(after.checkpoint.serializedData, before.checkpoint.serializedData, signature);
    assert.deepEqual(after.recovery, { authority: 'legacy-local', provisionalCacheUsed: true }, signature);
    assert.equal(after.canary.blockers.includes('retained-authority-delivery-inactive'), true, signature);
    assert.equal(after.clients.find(client => client.clientId === 'browser-a')?.viewGeneration, 2, signature);
  } finally {
    harness.close();
  }
});

test('REL_BGSTAB_007_AC10_server_restart_is_authority_unavailable', () => {
  const signature = 'server restart was not classified as authority-unavailable';
  const harness = createHarness({ sessionId: 'server-restart-missing-authority' });
  harness.close();
  const freshManager = new SessionManager();
  try {
    const availability = (freshManager as unknown as RetainedTerminalAuthorityApi)
      .getRetainedTerminalAuthorityAvailability?.(harness.sessionId);
    assert.deepEqual(availability, {
      availability: 'authority-unavailable',
      reason: 'server-restart-or-session-missing',
    }, signature);
  } finally {
    freshManager.stopAllCwdWatching();
  }
});

test('REL_BGSTAB_007_AC10_pty_exit_is_session_terminated', async () => {
  const signature = 'PTY natural exit was not classified as session-terminated';
  const harness = createHarness({ sessionId: 'natural-pty-exit-authority' });
  try {
    await harness.emit('before-natural-exit\r\n');
    harness.pty.emitExit(23);
    assert.equal(harness.manager.getSession(harness.sessionId), null, 'precondition: natural PTY exit finalizes the session');
    const availability = harness.api.getRetainedTerminalAuthorityAvailability?.(harness.sessionId);
    assert.equal(availability?.availability, 'session-terminated', signature);
    if (availability?.availability === 'session-terminated') {
      assert.equal(availability.reason, 'process-exit', signature);
      assert.equal(availability.exitCode, 23, signature);
      assert.deepEqual(availability.cleanup, {
        admissionOpen: false,
        settled: true,
        rejectedLateMessages: 0,
        factLedgerSettlements: 1,
        checkpointLedgerSettlements: 1,
        timerSettlements: 1,
      }, signature);
      assert.deepEqual(availability.driverLease, { state: 'revoked', ownerClientId: null }, signature);
    }
    assert.equal(harness.finalized.length, 1, signature);
  } finally {
    harness.manager.stopAllCwdWatching();
  }
});

test('RED reviewer — production comparer requires an independent roundtrip baseline before principal-axis match', async () => {
  const signature = 'REL-BGSTAB-011 AC-4 production comparer self-comparison was incorrectly canary-eligible';
  const harness = createHarness({ sessionId: 'independent-roundtrip-baseline' });
  try {
    const beforeEvidence = harness.readState();
    await harness.emit('independent baseline ASCII 中 e\u0301 🙂\r\n');
    for (let attempt = 0; attempt < 100 && harness.readState().comparer.axes.logicalLines === 'unavailable'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const afterRoundtrip = harness.readState();
    const independentConsumer = createHeadlessTerminalState({
      cols: afterRoundtrip.checkpoint.cols,
      rows: afterRoundtrip.checkpoint.rows,
      scrollbackLines: afterRoundtrip.retentionPolicy.effectiveRetainedScrollbackLines,
    });
    let independentBaselineMatches = false;
    try {
      await writeHeadlessTerminal(independentConsumer, afterRoundtrip.checkpoint.rehydrateAnsi);
      independentBaselineMatches = hashConsumerBuffer(independentConsumer, 'normal', 'cells')
          === afterRoundtrip.checkpoint.normal.cellHash
        && hashConsumerBuffer(independentConsumer, 'normal', 'attributes')
          === afterRoundtrip.checkpoint.normal.attributeHash;
    } finally {
      disposeHeadlessTerminal(independentConsumer);
    }
    assert.deepEqual({
      beforeResult: beforeEvidence.comparer.result,
      beforeEligible: beforeEvidence.canary.eligible,
      beforeBlocked: beforeEvidence.canary.blockers.includes('independent-baseline-unavailable'),
      afterResult: afterRoundtrip.comparer.result,
      afterBlocked: afterRoundtrip.canary.blockers.includes('independent-baseline-unavailable'),
      independentBaselineMatches,
    }, {
      beforeResult: 'unavailable',
      beforeEligible: false,
      beforeBlocked: true,
      afterResult: 'unavailable',
      afterBlocked: false,
      independentBaselineMatches: true,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — split semantic facts preserve record-local OSC BEL/ST, DSR, and repeated BEL occurrences', async () => {
  const signature = 'REL-BGSTAB-011 AC-5 split semantic parser or record-local fact identity is missing';
  const harness = createHarness({ sessionId: 'split-semantic-facts' });
  const factsByCompletion: Array<Array<[string, string, number, string]>> = [];
  const captureLatestRecordFacts = (): Array<[string, string, number, string]> => {
    const state = harness.readState();
    return state.facts
      .filter(fact => fact.streamEpoch === state.streamEpoch && fact.sourceSeq === state.sourceSeq)
      .map(fact => [fact.kind, fact.semanticKey, fact.ordinal, fact.disposition]);
  };
  try {
    for (const [prefix, completion] of [
      ['\x1b]0;split-bel-title', '\x07'],
      ['\x1b]2;split-st-title', '\x1b\\'],
      ['\x1b]7;file://localhost/tmp/split-bel-cwd', '\x07'],
      ['\x1b]7;file://localhost/tmp/split-st-cwd', '\x1b\\'],
      ['\x1b[6', 'n'],
    ] as const) {
      await harness.emit(prefix);
      assert.deepEqual(captureLatestRecordFacts(), [], 'partial semantic input must not commit a fact');
      await harness.emit(completion);
      factsByCompletion.push(captureLatestRecordFacts());
    }
    await harness.emit('\x07');
    const firstBellRecord = captureLatestRecordFacts();
    await harness.emit('\x07');
    const secondBellRecord = captureLatestRecordFacts();
    await harness.emit('\x07\x07');
    const sameRecordBells = captureLatestRecordFacts();

    assert.deepEqual({ factsByCompletion, firstBellRecord, secondBellRecord, sameRecordBells }, {
      factsByCompletion: [
        [['title', 'split-bel-title', 0, 'committed']],
        [['title', 'split-st-title', 0, 'committed']],
        [['cwd', '/tmp/split-bel-cwd', 0, 'committed']],
        [['cwd', '/tmp/split-st-cwd', 0, 'committed']],
        [['query-request', 'DSR-6', 0, 'rejected']],
      ],
      firstBellRecord: [['bell', 'bell', 0, 'committed']],
      secondBellRecord: [['bell', 'bell', 0, 'committed']],
      sameRecordBells: [
        ['bell', 'bell', 0, 'committed'],
        ['bell', 'bell', 1, 'committed'],
      ],
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — pure OSC 133 status is retained as a semantic-only source record', async () => {
  const signature = 'REL-BGSTAB-011 AC-1/AC-5 pure OSC 133 source record disappeared after legacy strip';
  const harness = createHarness({ sessionId: 'pure-osc133-retained-record' });
  try {
    const before = harness.readState();
    const deliveryCount = harness.deliveries.length;
    harness.pty.emitData('\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D\x07');
    assert.equal(
      await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId),
      true,
      signature,
    );
    const after = harness.readState();
    const recordFacts = after.facts.filter(fact => fact.sourceSeq === after.sourceSeq);
    assert.deepEqual({
      sourceAdvanced: BigInt(after.sourceSeq) > BigInt(before.sourceSeq),
      record: after.lastRecord,
      facts: recordFacts.map(fact => [fact.kind, fact.semanticKey, fact.ordinal, fact.disposition]),
      deliveryCount: harness.deliveries.length,
    }, {
      sourceAdvanced: true,
      record: {
        streamEpoch: after.streamEpoch,
        sourceSeq: after.sourceSeq,
        kind: 'output',
        modelCommitted: true,
        deliveryCreatedAfterCommit: false,
      },
      facts: [
        ['status', 'prompt-start', 0, 'committed'],
        ['status', 'prompt-end', 1, 'committed'],
        ['status', 'command-start', 2, 'committed'],
        ['status', 'command-end', 3, 'committed'],
      ],
      deliveryCount,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — sampled shadow comparer never blocks legacy delivery or mutates a replacement generation', async () => {
  const signature = 'REL-BGSTAB-011 AC-4/AC-7/AC-9 shadow comparison blocked delivery or crossed generation';
  let releaseComparison!: () => void;
  const comparisonGate = new Promise<void>(resolve => { releaseComparison = resolve; });
  let comparisonStarted = false;
  const harness = createHarness({
    sessionId: 'nonblocking-shadow-comparer',
    retainedComparisonGate: comparisonGate,
    onRetainedComparisonStarted: () => { comparisonStarted = true; },
  });
  try {
    harness.pty.emitData('delivery-must-not-await-shadow-comparison\r\n');
    assert.equal(
      await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId),
      true,
      signature,
    );
    for (let attempt = 0; attempt < 100 && !comparisonStarted; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(comparisonStarted, true, `${signature}: injected comparer was not scheduled`);
    assert.equal(
      harness.deliveries.some(entry => entry.data.includes('delivery-must-not-await-shadow-comparison')),
      true,
      `${signature}: legacy delivery waited for comparer`,
    );

    assert.equal(harness.manager.deleteSession(harness.sessionId), true, signature);
    const replacementPty = harness.createAdditionalSession(harness.sessionId);
    const replacementBefore = harness.readState();
    const replacementDeliveryCount = harness.deliveries.length;
    releaseComparison();
    await new Promise(resolve => setTimeout(resolve, 25));
    const replacementAfter = harness.readState();
    assert.deepEqual({
      streamEpochStable: replacementAfter.streamEpoch === replacementBefore.streamEpoch,
      sourceSeqStable: replacementAfter.sourceSeq === replacementBefore.sourceSeq,
      comparerStillUnavailable: replacementAfter.comparer.result === 'unavailable',
      oldDeliveryReachedReplacement: harness.deliveries.slice(replacementDeliveryCount)
        .some(entry => entry.data.includes('delivery-must-not-await-shadow-comparison')),
      replacementPtyWrites: replacementPty.writes.length,
    }, {
      streamEpochStable: true,
      sourceSeqStable: true,
      comparerStillUnavailable: true,
      oldDeliveryReachedReplacement: false,
      replacementPtyWrites: 0,
    }, signature);
  } finally {
    releaseComparison();
    harness.close();
  }
});

test('RED reviewer — shadow comparer samples only at global headless idle and enforces a low-duty interval', async () => {
  const signature = 'REL-BGSTAB-011 AC-4 comparer repeatedly consumed the event loop during multi-session output';
  let comparisonStarts = 0;
  const harness = createHarness({
    sessionId: 'idle-sampled-shadow-comparer',
    retainedComparisonGate: Promise.resolve(),
    onRetainedComparisonStarted: () => { comparisonStarts += 1; },
  });
  try {
    harness.createAdditionalSession('busy-comparer-sibling');
    const sessions = (harness.manager as unknown as {
      sessions: Map<string, { pendingHeadlessWrites: number; pendingHeadlessOutputs: Map<number, unknown> }>;
    }).sessions;
    const sibling = sessions.get('busy-comparer-sibling')!;
    sibling.pendingHeadlessWrites = 1;

    harness.pty.emitData('schedule one retained comparison\r\n');
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(comparisonStarts, 0, `${signature}: comparer ran while a sibling session was busy`);

    sibling.pendingHeadlessWrites = 0;
    for (let attempt = 0; attempt < 100 && comparisonStarts === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(comparisonStarts, 1, `${signature}: idle comparer sample never ran`);

    for (let index = 0; index < 8; index += 1) {
      harness.pty.emitData(`low-duty-${index}\r\n`);
    }
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(comparisonStarts, 1, `${signature}: comparer ignored its minimum sampling interval`);
  } finally {
    harness.manager.deleteSession('busy-comparer-sibling');
    harness.close();
  }
});

test('MIG-BGSTAB-002 promotion evidence comparison is not starved by an unrelated busy session', async () => {
  const signature = 'MIG-BGSTAB-002 promotion parity remained unavailable while an unrelated TUI emitted output';
  let comparisonStarts = 0;
  const harness = createHarness({
    sessionId: 'promotion-evidence-busy-sibling',
    retainedComparisonGate: Promise.resolve(),
    onRetainedComparisonStarted: () => { comparisonStarts += 1; },
  });
  try {
    harness.createAdditionalSession('promotion-evidence-unrelated-busy');
    const sessions = (harness.manager as unknown as {
      sessions: Map<string, { pendingHeadlessWrites: number }>;
    }).sessions;
    sessions.get('promotion-evidence-unrelated-busy')!.pendingHeadlessWrites = 1;

    harness.pty.emitData('promotion evidence must settle independently\r\n');
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true);
    await harness.manager.settleTerminalAuthorityPromotionEvidence(harness.sessionId);
    assert.equal(comparisonStarts, 1, signature);
  } finally {
    harness.manager.deleteSession('promotion-evidence-unrelated-busy');
    harness.close();
  }
});

test('RED reviewer — retained operation and fact evidence ledgers stay policy-bounded', async () => {
  const signature = 'REL-BGSTAB-011 AC-2/AC-3 retained evidence ledgers grew without a policy bound';
  const harness = createHarness({ sessionId: 'bounded-retained-ledgers', retainedScrollbackLines: 2 });
  try {
    for (let index = 0; index < 96; index += 1) harness.pty.emitData('\x07');
    const oversizedTitle = 'x'.repeat(64 * 1024);
    harness.pty.emitData(`\x1b]0;${oversizedTitle}\x07`);
    assert.equal(
      await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId),
      true,
      signature,
    );
    const state = harness.readState();
    const retainedRecordIds = new Set(state.records.map(record => `${record.streamEpoch}:${record.sourceSeq}`));
    const titleFact = state.facts.find(fact => fact.kind === 'title');
    const expectedLedgerEncodedBytes = Buffer.byteLength(JSON.stringify(state.records), 'utf8')
      + Buffer.byteLength(JSON.stringify(state.facts), 'utf8')
      + state.facts
        .filter(fact => fact.disposition === 'committed')
        .reduce(
          (total, fact) => total + Buffer.byteLength(`${fact.streamEpoch}:${fact.sourceSeq}:${fact.ordinal}`, 'utf8'),
          0,
        );
    assert.deepEqual({
      recordsBounded: state.records.length <= state.ledger.recordLimit,
      factsBounded: state.facts.length <= state.ledger.factLimit,
      keysBounded: state.ledger.committedFactKeyCount <= state.ledger.factLimit,
      factsBelongToRetainedRecords: state.facts.every(
        fact => retainedRecordIds.has(`${fact.streamEpoch}:${fact.sourceSeq}`),
      ),
      recordsEvicted: state.ledger.evictedRecords > 0,
      factsEvicted: state.ledger.evictedFacts > 0,
      aggregateConfigured: state.budgets.aggregateModelMemory.configured,
      checkpointChunkConfigured: state.budgets.checkpointChunk.configured,
      ledgerEncodedBytesBounded: state.ledger.encodedBytes <= state.ledger.byteLimit,
      ledgerEncodedBytesExact: state.ledger.encodedBytes === expectedLedgerEncodedBytes,
      oversizedSemanticKeyCanonicalized: /^sha256:[a-f0-9]{64}:bytes=65536$/u.test(titleFact?.semanticKey ?? ''),
      semanticKeyWithinByteLimit: Buffer.byteLength(titleFact?.semanticKey ?? '', 'utf8') <= state.ledger.semanticKeyMaxBytes,
    }, {
      recordsBounded: true,
      factsBounded: true,
      keysBounded: true,
      factsBelongToRetainedRecords: true,
      recordsEvicted: true,
      factsEvicted: true,
      aggregateConfigured: false,
      checkpointChunkConfigured: false,
      ledgerEncodedBytesBounded: true,
      ledgerEncodedBytesExact: true,
      oversizedSemanticKeyCanonicalized: true,
      semanticKeyWithinByteLimit: true,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — retained ledger byte accounting never rescans the full evidence arrays on commit', async () => {
  const signature = 'REL-BGSTAB-011 AC-2/AC-3 ledger byte accounting added O(retained ledger size) hot-path scans';
  const harness = createHarness({ sessionId: 'incremental-retained-ledger-accounting', retainedScrollbackLines: 64 });
  const originalStringify = JSON.stringify;
  let fullArrayStringifyCalls = 0;
  try {
    for (let index = 0; index < 80; index += 1) harness.pty.emitData('\x07');
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    const retained = (harness.manager as unknown as {
      sessions: Map<string, { retainedTerminal: { records: unknown[]; facts: unknown[] } }>;
    }).sessions.get(harness.sessionId)!.retainedTerminal;
    JSON.stringify = ((...args: unknown[]) => {
      if (args[0] === retained.records || args[0] === retained.facts) fullArrayStringifyCalls += 1;
      return (originalStringify as (...innerArgs: unknown[]) => string | undefined)(...args);
    }) as typeof JSON.stringify;
    harness.pty.emitData('\x07');
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    assert.equal(fullArrayStringifyCalls, 0, signature);
    const state = harness.readState();
    const expectedEncodedBytes = Buffer.byteLength(JSON.stringify(state.records), 'utf8')
      + Buffer.byteLength(JSON.stringify(state.facts), 'utf8')
      + state.facts
        .filter(fact => fact.disposition === 'committed')
        .reduce(
          (total, fact) => total + Buffer.byteLength(`${fact.streamEpoch}:${fact.sourceSeq}:${fact.ordinal}`, 'utf8'),
          0,
        );
    assert.equal(state.ledger.encodedBytes, expectedEncodedBytes, `${signature}: incremental byte count was not exact`);
  } finally {
    JSON.stringify = originalStringify;
    harness.close();
  }
});

test('RED reviewer — parser-tail and eviction comparer axes fail closed without an independent baseline', async () => {
  const signature = 'REL-BGSTAB-011 AC-4 parser-tail/eviction axes self-matched without independent evidence';
  const harness = createHarness({ sessionId: 'external-comparer-axes-fail-closed' });
  try {
    await harness.emit('independent principal axes\r\n');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (harness.readState().comparer.axes.logicalLines !== 'unavailable') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const state = harness.readState();
    assert.deepEqual({
      logicalLines: state.comparer.axes.logicalLines,
      cells: state.comparer.axes.cells,
      parserTail: state.comparer.axes.parserTail,
      eviction: state.comparer.axes.eviction,
      result: state.comparer.result,
      blocked: state.canary.blockers.includes('shadow-comparer-axis-unavailable'),
    }, {
      logicalLines: 'match',
      cells: 'match',
      parserTail: 'unavailable',
      eviction: 'unavailable',
      result: 'unavailable',
      blocked: true,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — newline-free soft-wrap and reflow eviction advance exact oldest retained source', async () => {
  const signature = 'REL-BGSTAB-007 AC-7 soft-wrap/reflow eviction is not attributed to the oldest retained source record';
  const harness = createHarness({ sessionId: 'soft-wrap-reflow-eviction', retainedScrollbackLines: 2 });
  try {
    assert.equal(harness.manager.resize(harness.sessionId, 4, 2), true, signature);
    // Four ASCII cells fill one physical row without relying on a Unicode-width
    // provider that is not yet shared by the server and browser runtimes.
    for (let index = 0; index < 6; index += 1) await harness.emit('abcd');
    const beforeReflow = harness.readState();
    const outputRecords = beforeReflow.records.filter(record => record.kind === 'output');
    const expectedOldestSourceSeq = outputRecords.at(-4)?.sourceSeq;
    assert.ok(expectedOldestSourceSeq, 'precondition: four retained rows have source identities');

    assert.equal(harness.manager.resize(harness.sessionId, 2, 2), true, signature);
    const afterReflow = harness.readState();
    assert.deepEqual({
      evictedRows: beforeReflow.eviction.evictedRows,
      oldestRetainedSeq: beforeReflow.oldestRetainedSeq,
      expectedOldestSourceSeq,
      completeLogicalRowBoundary: beforeReflow.eviction.completeLogicalRowBoundary,
      provenanceBlocked: beforeReflow.canary.blockers.includes('eviction-provenance-unavailable'),
      reflowAdvancedEviction: afterReflow.eviction.evictedRows > beforeReflow.eviction.evictedRows,
      reflowDidNotRegressOldest: BigInt(afterReflow.oldestRetainedSeq) >= BigInt(beforeReflow.oldestRetainedSeq),
      dataGapRequired: afterReflow.eviction.dataGapRequired,
    }, {
      evictedRows: 2,
      oldestRetainedSeq: expectedOldestSourceSeq,
      expectedOldestSourceSeq,
      completeLogicalRowBoundary: false,
      provenanceBlocked: true,
      reflowAdvancedEviction: true,
      reflowDidNotRegressOldest: true,
      dataGapRequired: true,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — actual input, resize, and query paths reject stale lease identity for two clients', async () => {
  const signature = 'REL-BGSTAB-011 AC-6 actual mutation path bypassed the registered view/driver lease';
  const harness = createHarness({ sessionId: 'actual-mutation-two-client' });
  type MutationIdentity = { authorityEpoch: string; clientId: string; viewGeneration: number; leaseGeneration: string };
  const actual = harness.manager as unknown as {
    writeInput(id: string, input: string, metadata: undefined, sequence: undefined, identity: MutationIdentity): boolean;
    resize(id: string, cols: number, rows: number, identity: MutationIdentity): boolean;
  };
  try {
    assert.deepEqual(harness.api.registerRetainedTerminalClientView(harness.sessionId, 'owner', 1), { ok: true, reason: 'registered' });
    assert.deepEqual(harness.api.registerRetainedTerminalClientView(harness.sessionId, 'stale', 1), { ok: true, reason: 'registered' });
    const lease = harness.api.claimRetainedTerminalDriverLease(harness.sessionId, 'owner', 1);
    assert.equal(lease.ok, true, 'precondition: owner lease is active');
    const authorityEpoch = (harness.manager as unknown as {
      sessions: Map<string, { authorityEpoch: string }>;
    }).sessions.get(harness.sessionId)!.authorityEpoch;
    const staleIdentities = [
      { authorityEpoch: `${authorityEpoch}-stale`, clientId: 'owner', viewGeneration: 1, leaseGeneration: lease.generation },
      { authorityEpoch, clientId: 'stale', viewGeneration: 1, leaseGeneration: lease.generation },
      { authorityEpoch, clientId: 'owner', viewGeneration: 2, leaseGeneration: lease.generation },
      { authorityEpoch, clientId: 'owner', viewGeneration: 1, leaseGeneration: `${lease.generation}-stale` },
    ];
    const writesBefore = harness.pty.writes.length;
    const resizesBefore = harness.pty.resizes.length;
    const staleInputResults = staleIdentities.map((identity, index) => actual.writeInput(
      harness.sessionId, `must-not-reach-pty-${index}`, undefined, undefined, identity,
    ));
    const staleResizeResults = staleIdentities.map((identity, index) => actual.resize(
      harness.sessionId, 41 + index, 9, identity,
    ));
    const staleQueryResults = staleIdentities.slice(1).map(identity => harness.api.observeRetainedTerminalDriverMutation(
      harness.sessionId, identity.clientId, identity.viewGeneration, identity.leaseGeneration, 'query-reply',
    ).accepted);
    const ownerInputAccepted = actual.writeInput(harness.sessionId, 'owner-input', undefined, undefined, {
      authorityEpoch, clientId: 'owner', viewGeneration: 1, leaseGeneration: lease.generation,
    });
    assert.deepEqual({
      staleInputResults,
      staleResizeResults,
      staleQueryResults,
      stalePtyWrites: harness.pty.writes.length - writesBefore - (ownerInputAccepted ? 1 : 0),
      stalePtyResizes: harness.pty.resizes.length - resizesBefore,
      ownerInputAccepted,
    }, {
      staleInputResults: Array(4).fill(false),
      staleResizeResults: Array(4).fill(false),
      staleQueryResults: Array(3).fill(false),
      stalePtyWrites: 0,
      stalePtyResizes: 0,
      ownerInputAccepted: true,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — actual input path rejects every stale lease identity with eight clients', () => {
  const signature = 'REL-BGSTAB-007 AC-9 eight-client actual mutation path did not isolate the sole driver';
  const harness = createHarness({ sessionId: 'actual-mutation-eight-client' });
  type MutationIdentity = { authorityEpoch: string; clientId: string; viewGeneration: number; leaseGeneration: string };
  const actual = harness.manager as unknown as {
    writeInput(id: string, input: string, metadata: undefined, sequence: undefined, identity: MutationIdentity): boolean;
  };
  try {
    for (let index = 0; index < 8; index += 1) {
      assert.equal(harness.api.registerRetainedTerminalClientView(harness.sessionId, `client-${index}`, index + 1).ok, true);
    }
    const lease = harness.api.claimRetainedTerminalDriverLease(harness.sessionId, 'client-0', 1);
    assert.equal(lease.ok, true, 'precondition: the sole eight-client driver is active');
    const authorityEpoch = (harness.manager as unknown as {
      sessions: Map<string, { authorityEpoch: string }>;
    }).sessions.get(harness.sessionId)!.authorityEpoch;
    const writesBefore = harness.pty.writes.length;
    const staleResults = Array.from({ length: 7 }, (_, offset) => {
      const index = offset + 1;
      return actual.writeInput(harness.sessionId, `stale-${index}`, undefined, undefined, {
        authorityEpoch,
        clientId: `client-${index}`,
        viewGeneration: index + 1,
        leaseGeneration: lease.generation,
      });
    });
    assert.deepEqual({ staleResults, ptyWrites: harness.pty.writes.length - writesBefore }, {
      staleResults: Array(7).fill(false),
      ptyWrites: 0,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — missing actual mutation identity stays legacy-compatible but blocks shadow canary', () => {
  const signature = 'REL-BGSTAB-011 AC-6 missing mutation identity was silent and left the shadow canary eligible';
  const harness = createHarness({ sessionId: 'actual-mutation-identity-missing' });
  try {
    const writesBefore = harness.pty.writes.length;
    const resizesBefore = harness.pty.resizes.length;
    assert.equal(harness.manager.writeInput(harness.sessionId, 'legacy-compatible-without-identity'), true, signature);
    assert.equal(harness.manager.resize(harness.sessionId, 39, 7), true, signature);
    const state = harness.readState();
    assert.deepEqual({
      ptyWrites: harness.pty.writes.length - writesBefore,
      ptyResizes: harness.pty.resizes.length - resizesBefore,
      blocked: state.canary.blockers.includes('mutation-identity-missing'),
      eligible: state.canary.eligible,
    }, {
      ptyWrites: 1,
      ptyResizes: 1,
      blocked: true,
      eligible: false,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — old authority identity cannot mutate replacement PTY through actual paths', () => {
  const signature = 'REL-BGSTAB-011 AC-9 old authorityEpoch identity mutated the replacement generation';
  type MutationIdentity = { authorityEpoch: string; clientId: string; viewGeneration: number; leaseGeneration: string };
  const harness = createHarness({ sessionId: 'actual-mutation-replacement-fence' });
  const actual = harness.manager as unknown as {
    writeInput(id: string, input: string, metadata: undefined, sequence: undefined, identity: MutationIdentity): boolean;
    resize(id: string, cols: number, rows: number, identity: MutationIdentity): boolean;
    sessions: Map<string, { authorityEpoch: string }>;
  };
  try {
    assert.equal(harness.api.registerRetainedTerminalClientView(harness.sessionId, 'old-owner', 1).ok, true);
    const oldLease = harness.api.claimRetainedTerminalDriverLease(harness.sessionId, 'old-owner', 1);
    assert.equal(oldLease.ok, true, 'precondition: old generation driver lease is active');
    const oldIdentity = {
      authorityEpoch: actual.sessions.get(harness.sessionId)!.authorityEpoch,
      clientId: 'old-owner',
      viewGeneration: 1,
      leaseGeneration: oldLease.generation,
    };
    const replacementPty = harness.createAdditionalSession(harness.sessionId);
    const writesBefore = replacementPty.writes.length;
    const resizesBefore = replacementPty.resizes.length;
    const inputAccepted = actual.writeInput(
      harness.sessionId, 'late-old-generation-input', undefined, undefined, oldIdentity,
    );
    const resizeAccepted = actual.resize(harness.sessionId, 55, 11, oldIdentity);
    assert.deepEqual({
      inputAccepted,
      resizeAccepted,
      replacementWrites: replacementPty.writes.length - writesBefore,
      replacementResizes: replacementPty.resizes.length - resizesBefore,
    }, {
      inputAccepted: false,
      resizeAccepted: false,
      replacementWrites: 0,
      replacementResizes: 0,
    }, signature);
  } finally {
    harness.close();
  }
});

test('lazy test-created SessionData keeps legacy resize compatibility without retained state', () => {
  const signature = 'legacy test-created SessionData resize compatibility regressed';
  const manager = new SessionManager({
    pty: structuredClone(config.pty),
    session: structuredClone(config.session),
    resourceLimits: structuredClone(config.resourceLimits),
    stabilityModes: structuredClone(config.stabilityModes),
  }, { platform: 'linux', readProcessStartIdentityFn: async () => null });
  const headless = createHeadlessTerminalState({ cols: 24, rows: 4, scrollbackLines: 8 });
  const ptyResizes: Array<{ cols: number; rows: number }> = [];
  const sessionId = 'lazy-test-created-resize';
  const sessionData = {
    pty: { resize: (cols: number, rows: number) => ptyResizes.push({ cols, rows }) },
    finalized: false,
    headless,
    headlessHealth: 'healthy',
    headlessWriteChain: Promise.resolve(),
    pendingHeadlessWrites: 0,
    cols: 24,
    rows: 4,
    screenSeq: 0,
    authorityRevision: 0,
    snapshotCache: null,
  };
  const internals = manager as unknown as {
    sessions: Map<string, typeof sessionData>;
    pendingResizeRefreshTimers: Map<string, NodeJS.Timeout>;
  };
  internals.sessions.set(sessionId, sessionData);
  try {
    assert.equal(manager.resize(sessionId, 31, 7), true, signature);
    assert.deepEqual(ptyResizes, [{ cols: 31, rows: 7 }], signature);
    assert.deepEqual({ cols: headless.terminal.cols, rows: headless.terminal.rows }, { cols: 31, rows: 7 }, signature);
  } finally {
    for (const timer of internals.pendingResizeRefreshTimers.values()) clearTimeout(timer);
    internals.pendingResizeRefreshTimers.clear();
    internals.sessions.delete(sessionId);
    disposeHeadlessTerminal(headless);
    manager.stopAllCwdWatching();
  }
});

test('RED reviewer — resize advances snapshot identity without consuming PTY source sequence', async () => {
  const signature = 'REL-BGSTAB-011 AC-1 resize reused one snapshot identity for different authoritative geometry';
  const harness = createHarness({ sessionId: 'resize-snapshot-identity' });
  try {
    const beforeOutput = harness.readState();
    await harness.emit('snapshot identity output');
    const afterOutput = harness.readState();
    assert.equal(harness.manager.resize(harness.sessionId, 37, 8), true, signature);
    const firstResize = harness.readState();
    assert.equal(harness.manager.resize(harness.sessionId, 38, 9), true, signature);
    const secondResize = harness.readState();
    const snapshotIdentities = [afterOutput, firstResize, secondResize].map(state => state.snapshotSeq);
    assert.deepEqual({
      outputSourceAdvanced: BigInt(afterOutput.sourceSeq) === BigInt(beforeOutput.sourceSeq) + 1n,
      resizeSourceSeqs: [firstResize.sourceSeq, secondResize.sourceSeq],
      expectedResizeSourceSeq: afterOutput.sourceSeq,
      snapshotIdentities,
      uniqueSnapshotIdentities: new Set(snapshotIdentities).size,
      snapshotsMonotonic: BigInt(afterOutput.snapshotSeq) < BigInt(firstResize.snapshotSeq)
        && BigInt(firstResize.snapshotSeq) < BigInt(secondResize.snapshotSeq),
      geometries: [
        [afterOutput.checkpoint.cols, afterOutput.checkpoint.rows],
        [firstResize.checkpoint.cols, firstResize.checkpoint.rows],
        [secondResize.checkpoint.cols, secondResize.checkpoint.rows],
      ],
    }, {
      outputSourceAdvanced: true,
      resizeSourceSeqs: [afterOutput.sourceSeq, afterOutput.sourceSeq],
      expectedResizeSourceSeq: afterOutput.sourceSeq,
      snapshotIdentities,
      uniqueSnapshotIdentities: 3,
      snapshotsMonotonic: true,
      geometries: [[80, 24], [37, 8], [38, 9]],
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — actual headless write degradation is typed and blocks authority canary', async () => {
  const signature = 'REL-BGSTAB-011 AC-7 real headless write failure remained availability=available without model-degradation blocker';
  let rejectWrite!: (error: Error) => void;
  const writeGate = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
  const harness = createHarness({ sessionId: 'actual-headless-write-degradation', headlessWriteGate: writeGate });
  try {
    harness.pty.emitData('headless-write-must-degrade');
    await new Promise<void>(resolve => setImmediate(resolve));
    rejectWrite(new Error('forced actual retained write degradation'));
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true);
    const availability = harness.api.getRetainedTerminalAuthorityAvailability(harness.sessionId);
    const degradedState = harness.api.getRetainedTerminalAuthorityState(harness.sessionId);
    assert.deepEqual({
      availability,
      stateAvailable: degradedState !== undefined,
      stateHasModelBlocker: degradedState?.canary.blockers.includes('model-degradation') ?? false,
      legacyDeliverySurvived: harness.deliveries.some(delivery => delivery.data.includes('headless-write-must-degrade')),
      producerKilled: harness.pty.killCount,
    }, {
      availability: {
        availability: 'authority-degraded',
        reason: 'model-degradation',
        phase: 'write',
        canaryBlockers: ['model-degradation'],
      },
      stateAvailable: true,
      stateHasModelBlocker: true,
      legacyDeliverySurvived: true,
      producerKilled: 0,
    }, signature);
  } finally {
    harness.close();
  }
});

test('RED reviewer — degraded, overflow, and commit-failure OSC status records reject facts without empty delivery', async () => {
  const signature = 'REL-BGSTAB-011 AC-5/AC-7 semantic-only fallback emitted an empty legacy delivery';
  type InternalSession = {
    headlessHealth: 'healthy' | 'degraded';
    headlessDegradedPhase: 'create' | 'write' | 'resize' | 'serialize' | 'queue-overflow' | null;
    headlessOutputQueue: { enqueue: (...args: unknown[]) => unknown };
  };
  const internalSession = (harness: Harness): InternalSession => (
    harness.manager as unknown as { sessions: Map<string, InternalSession> }
  ).sessions.get(harness.sessionId)!;
  const emitAndRead = async (harness: Harness): Promise<RetainedTerminalAuthorityState> => {
    harness.pty.emitData('\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D\x07');
    await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId);
    return harness.readState();
  };

  const degraded = createHarness({ sessionId: 'semantic-only-already-degraded' });
  try {
    const session = internalSession(degraded);
    session.headlessHealth = 'degraded';
    session.headlessDegradedPhase = 'write';
    const deliveriesBefore = degraded.deliveries.length;
    const state = await emitAndRead(degraded);
    assert.deepEqual({
      record: state.lastRecord,
      facts: state.facts.map(fact => [fact.semanticKey, fact.disposition]),
      emptyDeliveries: degraded.deliveries.slice(deliveriesBefore).filter(entry => entry.data === '').length,
    }, {
      record: {
        streamEpoch: state.streamEpoch,
        sourceSeq: state.sourceSeq,
        kind: 'output',
        modelCommitted: false,
        deliveryCreatedAfterCommit: false,
        rejectionReason: 'model-degraded',
      },
      facts: [
        ['prompt-start', 'rejected'],
        ['prompt-end', 'rejected'],
        ['command-start', 'rejected'],
        ['command-end', 'rejected'],
      ],
      emptyDeliveries: 0,
    }, signature);
  } finally {
    degraded.close();
  }

  const overflow = createHarness({ sessionId: 'semantic-only-queue-overflow' });
  try {
    const session = internalSession(overflow);
    const queue = session.headlessOutputQueue;
    const originalEnqueue = queue.enqueue;
    queue.enqueue = () => ({ ok: false, reason: 'chunk-limit', shouldDegradeHeadless: true });
    const deliveriesBefore = overflow.deliveries.length;
    const state = await emitAndRead(overflow);
    queue.enqueue = originalEnqueue;
    assert.deepEqual({
      rejectionReason: state.lastRecord?.rejectionReason,
      rejectedFacts: state.facts.filter(fact => fact.disposition === 'rejected').length,
      emptyDeliveries: overflow.deliveries.slice(deliveriesBefore).filter(entry => entry.data === '').length,
    }, {
      rejectionReason: 'queue-overflow',
      rejectedFacts: 4,
      emptyDeliveries: 0,
    }, signature);
  } finally {
    overflow.close();
  }

  const commitFailure = createHarness({ sessionId: 'semantic-only-commit-failure' });
  try {
    const manager = commitFailure.manager as unknown as {
      commitRetainedTerminalOutput: (...args: unknown[]) => void;
    };
    manager.commitRetainedTerminalOutput = () => { throw new Error('forced semantic-only commit failure'); };
    const deliveriesBefore = commitFailure.deliveries.length;
    const state = await emitAndRead(commitFailure);
    assert.deepEqual({
      rejectionReason: state.lastRecord?.rejectionReason,
      rejectedFacts: state.facts.filter(fact => fact.disposition === 'rejected').length,
      emptyDeliveries: commitFailure.deliveries.slice(deliveriesBefore).filter(entry => entry.data === '').length,
    }, {
      rejectionReason: 'commit-failed',
      rejectedFacts: 4,
      emptyDeliveries: 0,
    }, signature);
  } finally {
    commitFailure.close();
  }
});

test('RED reviewer — queue overflow settles every previously accepted semantic record in ingest order', async () => {
  const signature = 'REL-BGSTAB-011 AC-5/AC-7 queue degradation abandoned accepted semantic facts';
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const harness = createHarness({ sessionId: 'pending-semantic-overflow-settlement', headlessWriteGate: writeGate });
  type InternalSession = { headlessOutputQueue: { enqueue: (...args: unknown[]) => unknown } };
  try {
    const inputs = ['A', 'B', 'C'].map(code => `\x1b]133;${code}\x07visible-${code}\r\n`);
    for (const input of inputs) harness.pty.emitData(input);
    await new Promise<void>(resolve => setImmediate(resolve));
    const session = (harness.manager as unknown as { sessions: Map<string, InternalSession> })
      .sessions.get(harness.sessionId)!;
    const originalEnqueue = session.headlessOutputQueue.enqueue;
    session.headlessOutputQueue.enqueue = () => ({ ok: false, reason: 'chunk-limit', shouldDegradeHeadless: true });
    harness.pty.emitData('\x1b]133;D\x07visible-D\r\n');
    session.headlessOutputQueue.enqueue = originalEnqueue;
    releaseWrite();
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    const state = harness.readState();
    assert.deepEqual({
      rejectedRecords: state.records.map(record => [record.sourceSeq, record.modelCommitted, record.rejectionReason]),
      rejectedFacts: state.facts.map(fact => [fact.sourceSeq, fact.semanticKey, fact.disposition]),
    }, {
      rejectedRecords: [
        ['1', false, 'queue-overflow'],
        ['2', false, 'queue-overflow'],
        ['3', false, 'queue-overflow'],
        ['4', false, 'queue-overflow'],
      ],
      rejectedFacts: [
        ['1', 'prompt-start', 'rejected'],
        ['2', 'prompt-end', 'rejected'],
        ['3', 'command-start', 'rejected'],
        ['4', 'command-end', 'rejected'],
      ],
    }, signature);
  } finally {
    releaseWrite();
    harness.close();
  }
});

test('RED reviewer — throwing policy settler cannot abort degradation settlement or current legacy delivery', async () => {
  const signature = 'REL-BGSTAB-011 AC-7 policy callback exception escaped the degradation fail-safe path';
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const harness = createHarness({ sessionId: 'throwing-policy-settler-isolated', headlessWriteGate: writeGate });
  let decisionIndex = 0;
  let settlerAttempts = 0;
  let successfulSettlers = 0;
  const unbind = harness.manager.bindTerminalResourcePolicyHeadlessAdmissionPort({
    decide() {
      const index = decisionIndex++;
      return {
        mode: 'candidate' as const,
        reason: 'test',
        outputMaxBytes: 1024 * 1024,
        outputMaxChunks: 32,
        admissionMode: 'candidate' as const,
        policyGeneration: 1,
        exactlyOnceKey: `settler-${index}`,
        record() {},
        settleFailure() {
          settlerAttempts += 1;
          if (index === 0) throw new Error('forced first settler failure');
          successfulSettlers += 1;
        },
      };
    },
  });
  type InternalSession = { headlessOutputQueue: { enqueue: (...args: unknown[]) => unknown } };
  let originalEnqueue: ((...args: unknown[]) => unknown) | undefined;
  try {
    harness.pty.emitData('\x1b]133;A\x07pending-visible-A\r\n');
    harness.pty.emitData('\x1b]133;B\x07pending-visible-B\r\n');
    await new Promise<void>(resolve => setImmediate(resolve));
    const session = (harness.manager as unknown as { sessions: Map<string, InternalSession> })
      .sessions.get(harness.sessionId)!;
    originalEnqueue = session.headlessOutputQueue.enqueue;
    session.headlessOutputQueue.enqueue = () => ({ ok: false, reason: 'chunk-limit', shouldDegradeHeadless: true });
    assert.doesNotThrow(
      () => harness.pty.emitData('\x1b]133;C\x07current-visible-C\r\n'),
      signature,
    );
    session.headlessOutputQueue.enqueue = originalEnqueue;
    releaseWrite();
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    const state = harness.readState();
    assert.deepEqual({
      settlerAttempts,
      successfulSettlers,
      records: state.records.map(record => [record.sourceSeq, record.rejectionReason]),
      facts: state.facts.map(fact => [fact.sourceSeq, fact.semanticKey, fact.disposition]),
      currentLegacyDelivered: harness.deliveries.some(delivery => delivery.data.includes('current-visible-C')),
    }, {
      settlerAttempts: 2,
      successfulSettlers: 1,
      records: [['1', 'queue-overflow'], ['2', 'queue-overflow'], ['3', 'queue-overflow']],
      facts: [
        ['1', 'prompt-start', 'rejected'],
        ['2', 'prompt-end', 'rejected'],
        ['3', 'command-start', 'rejected'],
      ],
      currentLegacyDelivered: true,
    }, signature);
  } finally {
    const session = (harness.manager as unknown as { sessions: Map<string, InternalSession> })
      .sessions.get(harness.sessionId);
    if (session && originalEnqueue) session.headlessOutputQueue.enqueue = originalEnqueue;
    releaseWrite();
    unbind();
    harness.close();
  }
});

test('RED reviewer — headless write failure settles failed and later queued semantic records exactly once', async () => {
  const signature = 'REL-BGSTAB-011 AC-5/AC-7 write degradation abandoned queued semantic facts';
  let rejectWrite!: (error: Error) => void;
  const writeGate = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
  const harness = createHarness({ sessionId: 'pending-semantic-write-settlement', headlessWriteGate: writeGate });
  try {
    for (const code of ['A', 'B', 'C', 'D']) {
      harness.pty.emitData(`\x1b]133;${code}\x07visible-${code}\r\n`);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    rejectWrite(new Error('forced queued semantic settlement failure'));
    assert.equal(await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.sessionId), true, signature);
    const state = harness.readState();
    assert.deepEqual({
      rejectedRecords: state.records.map(record => [record.sourceSeq, record.modelCommitted, record.rejectionReason]),
      rejectedFacts: state.facts.map(fact => [fact.sourceSeq, fact.semanticKey, fact.disposition]),
    }, {
      rejectedRecords: [
        ['1', false, 'commit-failed'],
        ['2', false, 'commit-failed'],
        ['3', false, 'commit-failed'],
        ['4', false, 'commit-failed'],
      ],
      rejectedFacts: [
        ['1', 'prompt-start', 'rejected'],
        ['2', 'prompt-end', 'rejected'],
        ['3', 'command-start', 'rejected'],
        ['4', 'command-end', 'rejected'],
      ],
    }, signature);
  } finally {
    rejectWrite(new Error('cleanup'));
    harness.close();
  }
});
