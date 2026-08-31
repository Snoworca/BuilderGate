import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { IPty } from 'node-pty';
import type {
  TerminalAuthorityController,
  TerminalAuthorityState,
} from './TerminalAuthorityController.js';
import { SessionManager } from './SessionManager.js';
import {
  createHeadlessTerminalState,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from '../utils/headlessTerminal.js';
import { installTerminalQueryResponder } from '../utils/terminalQueryResponder.js';
import { config } from '../utils/config.js';

const SESSION_ID = 'terminal-authority-debug-isolation';
const CLEANUP_TOKEN = 'cleanup-token-1';
const ISOLATION_LEASE_ID = 'isolation-lease-1';

class DebugFakePty {
  readonly pid = 91_001;
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

interface AuthorityRecord {
  recordId: string;
  sourceSeq: string;
  data: string;
  ingestOwnerToken: 'server-headless';
}

interface DebugHarness {
  manager: SessionManager;
  pty: DebugFakePty;
  headlessWrites: string[];
  headlessScrollbackCreates: number[];
  enqueuedAuthorityRecords: AuthorityRecord[];
  appliedAuthorityRecordIds: string[];
  settledEffectKeys: string[];
  close(): void;
}

function payload(data: string, sha256 = createHash('sha256').update(data, 'utf8').digest('hex')) {
  return {
    encoding: 'base64',
    data: Buffer.from(data, 'utf8').toString('base64'),
    decodedBytes: Buffer.byteLength(data, 'utf8'),
    sha256,
  };
}

function createController(
  manager: SessionManager,
  authorityEpoch: string,
  enqueuedAuthorityRecords: AuthorityRecord[],
  appliedAuthorityRecordIds: string[],
  settledEffectKeys: string[],
  initialMode: 'legacy' | 'server' = 'server',
): TerminalAuthorityController {
  const records = new Map<string, AuthorityRecord>();
  const settledEffects = new Set<string>();
  const state: TerminalAuthorityState = {
    mode: initialMode,
    sessionId: SESSION_ID,
    authorityEpoch,
    streamEpoch: '1',
    transitionEpoch: initialMode === 'server' ? '1' : null,
    activeResponder: initialMode === 'server' ? 'server-headless' : 'legacy-browser',
    activeResponderLeaseId: initialMode === 'server'
      ? 'debug-server-responder-1'
      : 'debug-legacy-responder-1',
    activeDriverLeaseId: initialMode === 'server'
      ? 'debug-server-driver-1'
      : 'debug-legacy-driver-1',
    legacyResponderEnabled: initialMode === 'legacy',
    serverResponderEnabled: initialMode === 'server',
    admissionOpen: initialMode === 'server' ? 'server' : 'legacy',
    frozenRequiredResponderCount: 0,
    acceptedDisableAckCount: 0,
      heldPostBoundaryCount: 0,
      pendingDeliveryBytes: 0,
      pendingDeliveryChunks: 0,
    restartRequired: false,
    ptyPaused: false,
    hiddenDeliveryLossy: false,
    sessionStatus: 'idle',
  };

  const controller = {
    enqueueHeadlessOutput(input: { sourceSeq: string; data: string }) {
      const record: AuthorityRecord = {
        recordId: `debug-record-${input.sourceSeq}`,
        sourceSeq: input.sourceSeq,
        data: input.data,
        ingestOwnerToken: 'server-headless',
      };
      records.set(record.recordId, record);
      enqueuedAuthorityRecords.push(record);
      return {
        recordId: record.recordId,
        sourceSeq: record.sourceSeq,
        ingestOwnerToken: record.ingestOwnerToken,
        ownerSelectedAt: 'enqueue' as const,
      };
    },
    async applyEnqueuedHeadlessOutput(recordId: string) {
      const record = records.get(recordId);
      assert.ok(record, 'debug output must apply the exact enqueue-time authority record');
      appliedAuthorityRecordIds.push(recordId);
      return {
        recordId,
        sourceSeq: record.sourceSeq,
        responderLeaseId: state.activeResponderLeaseId!,
        ingestOwner: record.ingestOwnerToken,
        ingestOwnerToken: record.ingestOwnerToken,
        commitOwner: 'server-headless' as const,
        ownerSelectedAt: 'enqueue' as const,
        modelCommitted: true,
        factCommitted: true,
        deliveryDisposition: 'server-delivered' as const,
      };
    },
    settleQueryEffect(input: {
      recordId: string;
      replyOrdinal: number;
      reply: string;
      streamEpoch: string;
      responderLeaseId: string;
    }) {
      const effectKey = `${input.recordId}:${input.replyOrdinal}`;
      if (settledEffects.has(effectKey)) {
        return { disposition: 'duplicate' as const, owner: 'server-headless' as const, effectKey };
      }
      settledEffects.add(effectKey);
      settledEffectKeys.push(effectKey);
      assert.equal(
        manager.writeTerminalQueryReply(SESSION_ID, input.reply),
        true,
        'server-owned query effect must use the dedicated PTY reply sink',
      );
      return { disposition: 'applied' as const, owner: 'server-headless' as const, effectKey };
    },
    getState: () => ({ ...state }),
    setDebugAuthorityState: (patch: Partial<TerminalAuthorityState>) => {
      Object.assign(state, patch);
    },
    dispose: () => {},
  };
  return controller as unknown as TerminalAuthorityController;
}

function createHarness(controllerMode: 'legacy' | 'server' = 'server'): DebugHarness {
  const pty = new DebugFakePty();
  const headlessWrites: string[] = [];
  const headlessScrollbackCreates: number[] = [];
  const enqueuedAuthorityRecords: AuthorityRecord[] = [];
  const appliedAuthorityRecordIds: string[] = [];
  const settledEffectKeys: string[] = [];
  const resourceLimits = structuredClone(config.resourceLimits!);
  resourceLimits.terminal.scrollbackLines = 8;
  const manager = new SessionManager({
    pty: {
      ...structuredClone(config.pty),
      scrollbackLines: 4,
    },
    session: structuredClone(config.session),
    resourceLimits,
    stabilityModes: structuredClone(config.stabilityModes),
  }, {
    platform: 'linux',
    spawnPty: (() => pty as unknown as IPty) as NonNullable<
      ConstructorParameters<typeof SessionManager>[1]
    >['spawnPty'],
    readProcessStartIdentityFn: async () => null,
    retainedTerminalShadowEnabled: true,
    createHeadlessTerminalStateFn: options => {
      headlessScrollbackCreates.push(options.scrollbackLines);
      return createHeadlessTerminalState(options);
    },
    writeHeadlessTerminalFn: async (headlessState: HeadlessTerminalState, data: string) => {
      headlessWrites.push(data);
      await writeHeadlessTerminal(headlessState, data);
    },
  } as ConstructorParameters<typeof SessionManager>[1]);
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.setTerminalAuthorityRuntimeFactory(input => {
    const controller = createController(
      manager,
      input.authorityEpoch,
      enqueuedAuthorityRecords,
      appliedAuthorityRecordIds,
      settledEffectKeys,
      controllerMode,
    );
    const queryResponder = installTerminalQueryResponder({
      headlessState: input.headlessState,
      provider: {
        source: 'session-manager-spawn-record',
        backend: 'posix',
        spawnRecordId: `debug-spawn:${input.sessionId}`,
      },
      readDriverViewIdentity: () => null,
    });
    return {
      controller,
      queryResponder,
      dispose: () => {
        manager.detachTerminalAuthorityRuntime(input.sessionId, controller);
      },
    };
  });
  manager.createSession('MIG-BGSTAB-002 debug isolation', 'bash', process.cwd(), {
    sessionId: SESSION_ID,
  });
  pty.writes.length = 0;

  return {
    manager,
    pty,
    headlessWrites,
    headlessScrollbackCreates,
    enqueuedAuthorityRecords,
    appliedAuthorityRecordIds,
    settledEffectKeys,
    close() {
      manager.deleteSession(SESSION_ID);
    },
  };
}

function inventoryValues(manager: SessionManager): number[] {
  const { resourceInventory } = manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID);
  return Object.values(resourceInventory);
}

function readAuthorityFence(manager: SessionManager) {
  const state = manager.getTerminalAuthorityState(SESSION_ID);
  assert.ok(state);
  return {
    mode: state.mode,
    authorityEpoch: state.authorityEpoch,
    streamEpoch: state.streamEpoch,
    transitionEpoch: state.transitionEpoch,
  };
}

test('MIG-BGSTAB-002 cleanup rejects a stale authority identity fence without releasing isolation', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: { retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 } },
  });
  assert.equal(opened.accepted, true);

  const cleanup = await manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['all-open-isolation-resources'],
    authorityFence: {
      ...readAuthorityFence(manager),
      authorityEpoch: 'stale-authority-epoch',
    },
  } as never);

  assert.deepEqual(cleanup, {
    accepted: false,
    reason: 'debug-isolation-cleanup-authority-fence-mismatch',
  });
  assert.equal(
    manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID).resourceInventory.isolationLeases,
    1,
  );
});

test('MIG-BGSTAB-002 cleanup fence blocks promotion until asynchronous isolation restoration completes', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: { retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 } },
  });
  assert.equal(opened.accepted, true);

  const internals = manager as unknown as {
    recreateTerminalAuthorityDebugHeadless(...args: unknown[]): Promise<void>;
  };
  const originalRecreate = internals.recreateTerminalAuthorityDebugHeadless.bind(manager);
  let releaseRestore!: () => void;
  const restoreReleased = new Promise<void>(resolve => { releaseRestore = resolve; });
  let markRestoreStarted!: () => void;
  const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve; });
  internals.recreateTerminalAuthorityDebugHeadless = async (...args: unknown[]) => {
    markRestoreStarted();
    await restoreReleased;
    await originalRecreate(...args);
  };

  const cleanupPromise = manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['all-open-isolation-resources'],
    authorityFence: readAuthorityFence(manager),
  } as never);
  await restoreStarted;
  const promotionPromise = manager.beginTerminalAuthorityPromotion(SESSION_ID, {
    sessionId: SESSION_ID,
    authorityEpoch: 'debug-authority',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'legacy-responder',
    nextResponderLeaseId: 'server-responder',
    nextDriverLeaseId: 'server-driver',
  }).catch(error => ({ ok: false, reason: `threw:${String(error)}` }));
  releaseRestore();
  const [promotion, cleanup] = await Promise.all([promotionPromise, cleanupPromise]);

  assert.deepEqual(promotion, { ok: false, reason: 'debug-isolation-cleanup-active' });
  assert.equal(cleanup.accepted, true);
});

test('MIG-BGSTAB-002 cleanup serializes live PTY output after the restored headless checkpoint', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager, pty } = harness;
  const internals = manager as unknown as {
    writeHeadlessTerminalFn(state: HeadlessTerminalState, data: string): Promise<void>;
    sessions: Map<string, { headlessWriteChain: Promise<void> }>;
  };
  pty.emitData('ORIGINAL-BEFORE-DEBUG-CLEANUP');
  await internals.sessions.get(SESSION_ID)?.headlessWriteChain;
  const before = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(before);
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: { retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 } },
  });
  assert.equal(opened.accepted, true);
  assert.equal((await manager.applyTerminalAuthorityDebugIsolationContract({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    testContract: { retainedCorpusInjection: payload('debug-state-to-remove') },
  })).accepted, true);

  const originalWrite = internals.writeHeadlessTerminalFn.bind(manager);
  let releaseRestore!: () => void;
  const restoreReleased = new Promise<void>(resolve => { releaseRestore = resolve; });
  let markRestoreStarted!: () => void;
  const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve; });
  let delayed = false;
  const liveOutput = 'LIVE-DURING-DEBUG-CLEANUP';
  let liveWriteStarted = false;
  internals.writeHeadlessTerminalFn = async (state, data) => {
    if (data === liveOutput) liveWriteStarted = true;
    if (!delayed && data === before.checkpoint.serializedData) {
      delayed = true;
      markRestoreStarted();
      await restoreReleased;
    }
    await originalWrite(state, data);
  };

  const cleanupPromise = manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['retained-policy', 'authority-runtime'],
    authorityFence: readAuthorityFence(manager),
  });
  await restoreStarted;
  pty.emitData(liveOutput);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(
    liveWriteStarted,
    false,
    'live PTY writes must wait behind the in-progress headless checkpoint restoration',
  );
  releaseRestore();
  const cleanup = await cleanupPromise;
  assert.equal(cleanup.accepted, true, JSON.stringify(cleanup));
  await internals.sessions.get(SESSION_ID)?.headlessWriteChain;

  const after = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(after);
  assert.match(
    after.checkpoint.serializedData,
    new RegExp(liveOutput),
    'live output accepted during cleanup must be applied after the restored checkpoint, not overwritten by it',
  );
});

test('MIG-BGSTAB-002 promotion claim blocks cleanup while controller promotion admission is asynchronous', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: { retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 } },
  });
  assert.equal(opened.accepted, true);

  const controller = manager.getTerminalAuthorityController(SESSION_ID) as unknown as {
    beginPromotion(request: unknown): Promise<{ ok: boolean; reason?: string }>;
  };
  let releasePromotion!: () => void;
  const promotionReleased = new Promise<void>(resolve => { releasePromotion = resolve; });
  let markPromotionStarted!: () => void;
  const promotionStarted = new Promise<void>(resolve => { markPromotionStarted = resolve; });
  controller.beginPromotion = async () => {
    markPromotionStarted();
    await promotionReleased;
    return { ok: false, reason: 'test-promotion-released' };
  };
  const promotionPromise = manager.beginTerminalAuthorityPromotion(SESSION_ID, {
    sessionId: SESSION_ID,
    authorityEpoch: 'debug-authority',
    previousStreamEpoch: '1',
    nextStreamEpoch: '2',
    transitionEpoch: '2',
    oldResponderLeaseId: 'legacy-responder',
    nextResponderLeaseId: 'server-responder',
    nextDriverLeaseId: 'server-driver',
  });
  await promotionStarted;
  const cleanup = await manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['all-open-isolation-resources'],
    authorityFence: readAuthorityFence(manager),
  });
  releasePromotion();
  await promotionPromise;

  assert.deepEqual(cleanup, { accepted: false, reason: 'debug-isolation-promotion-active' });
  assert.equal(
    manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID).resourceInventory.isolationLeases,
    1,
  );
});

test('MIG-BGSTAB-002 cleanup port rejects current non-legacy authority and missing fences', async t => {
  const harness = createHarness('server');
  t.after(() => harness.close());
  const { manager } = harness;
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: { retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 } },
  });
  assert.equal(opened.accepted, true);
  const base = {
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['all-open-isolation-resources'],
  };

  assert.deepEqual(
    await manager.cleanupTerminalAuthorityDebugIsolation({
      ...base,
      authorityFence: readAuthorityFence(manager),
    }),
    { accepted: false, reason: 'debug-isolation-cleanup-authority-fence-mismatch' },
  );
  assert.deepEqual(
    await manager.cleanupTerminalAuthorityDebugIsolation(base as never),
    { accepted: false, reason: 'debug-isolation-cleanup-authority-fence-mismatch' },
  );
});

test('MIG-BGSTAB-002 cleanup accepts an exact completed legacy transition identity', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: { retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 } },
  });
  assert.equal(opened.accepted, true);
  const controller = manager.getTerminalAuthorityController(SESSION_ID) as unknown as {
    setDebugAuthorityState(patch: Partial<TerminalAuthorityState>): void;
  };
  controller.setDebugAuthorityState({
    mode: 'legacy',
    streamEpoch: '2',
    transitionEpoch: 'completed-rollback-2',
  });

  const cleanup = await manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['all-open-isolation-resources'],
    authorityFence: readAuthorityFence(manager),
  });
  assert.equal(cleanup.accepted, true, JSON.stringify(cleanup));
});

test('MIG-BGSTAB-002 debug isolation uses the production headless queue and restores its retained override', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  const before = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(before);
  assert.match(
    String(manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID).details.authoritativeSourceSeq),
    /^(0|[1-9]\d*)$/u,
    'debug inventory must expose the exact authoritative source sequence used by zero-view baselines',
  );
  assert.deepEqual(inventoryValues(manager), Array(13).fill(0));

  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: {
      retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 },
    },
  });
  assert.equal(opened.accepted, true, JSON.stringify(opened));
  assert.equal(opened.effectiveHeadlessRetainedScrollbackLines, 3);
  assert.deepEqual(
    harness.headlessScrollbackCreates,
    [8, 3],
    'debug override must recreate the actual session headless model at the requested retained range',
  );
  assert.deepEqual(inventoryValues(manager), [1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0]);

  const corpus = 'authority-debug-line-1\r\nauthority-debug-line-2';
  const writesBefore = harness.headlessWrites.length;
  const recordsBefore = harness.enqueuedAuthorityRecords.length;
  const retainedBeforeApply = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(retainedBeforeApply);
  const applied = await manager.applyTerminalAuthorityDebugIsolationContract({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    testContract: { retainedCorpusInjection: payload(corpus) },
  });
  assert.equal(applied.accepted, true);
  assert.deepEqual(
    harness.headlessWrites.slice(writesBefore),
    [corpus],
    'debug corpus must pass through the same single headless write seam exactly once',
  );
  assert.equal(harness.enqueuedAuthorityRecords.length, recordsBefore + 1);
  assert.equal(harness.enqueuedAuthorityRecords.at(-1)?.data, corpus);
  assert.equal(harness.appliedAuthorityRecordIds.at(-1), harness.enqueuedAuthorityRecords.at(-1)?.recordId);
  const retainedAfterApply = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(retainedAfterApply);
  assert.equal(BigInt(retainedAfterApply.sourceSeq), BigInt(retainedBeforeApply.sourceSeq) + 1n);
  assert.match(retainedAfterApply.checkpoint.serializedData, /authority-debug-line-1/);

  const inventoryDuring = manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID);
  assert.equal(inventoryDuring.resourceInventory.retainedCorpusFixtures, 1);
  assert.equal(inventoryDuring.resourceInventory.retainedPolicyOverrides, 1);
  const cleanupAuthorityFloor = readAuthorityFence(manager);

  const cleanup = await manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['retained-policy', 'authority-runtime'],
    authorityFence: readAuthorityFence(manager),
  });
  assert.deepEqual(cleanup, {
    accepted: true,
    restoredScopes: ['retained-policy', 'authority-runtime'],
    restored: {
      sessionLocalRetainedPolicy: true,
      retainedCorpus: true,
      alternateBufferFixture: true,
      responderMode: true,
      listeners: true,
      driverAndResponderLeases: true,
      timers: true,
      faultState: true,
    },
  });
  const idempotentCleanup = await manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['retained-policy', 'authority-runtime'],
    authorityFence: readAuthorityFence(manager),
  });
  assert.deepEqual(idempotentCleanup, cleanup,
    'idempotent cleanup must preserve the original scope-by-scope restoration evidence');
  assert.deepEqual(
    harness.headlessScrollbackCreates,
    [8, 3, 8],
    'cleanup must recreate the production headless model with its configured retained range',
  );
  assert.deepEqual(inventoryValues(manager), Array(13).fill(0));
  const afterCleanup = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(afterCleanup);
  assert.equal(afterCleanup.checkpoint.serializedData, before.checkpoint.serializedData);
  assert.equal(afterCleanup.checkpoint.pendingEscapeTailAnsi, before.checkpoint.pendingEscapeTailAnsi);
  assert.ok(
    BigInt(afterCleanup.streamEpoch) >= BigInt(cleanupAuthorityFloor.streamEpoch),
    'debug cleanup must restore retained content without rewinding the live authority stream epoch',
  );
  assert.ok(
    BigInt(afterCleanup.sourceSeq) >= BigInt(retainedAfterApply.sourceSeq),
    'debug cleanup must restore retained content without reusing a live source ordinal',
  );
  const runtimeAfterCleanup = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.deepEqual(runtimeAfterCleanup?.driver.revokedLeaseIds, [],
    'debug cleanup must reset driver lease tombstones before restoring a reusable epoch');
  assert.deepEqual(runtimeAfterCleanup?.responder.revokedLeaseIds, [],
    'debug cleanup must reset responder lease tombstones before restoring a reusable epoch');
  assert.equal(
    (await manager.cleanupTerminalAuthorityDebugIsolation({
      sessionId: SESSION_ID,
      cleanupToken: CLEANUP_TOKEN,
      isolationLeaseId: ISOLATION_LEASE_ID,
      restoreScopes: [],
      authorityFence: readAuthorityFence(manager),
    })).accepted,
    true,
    'cleanup must be idempotent once the isolation resources are gone',
  );
});

test('MIG-BGSTAB-002 no-op failed-open isolation cleanup preserves recovery ACK and headless identity', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  assert.equal(manager.registerRetainedTerminalClientView(SESSION_ID, 'client-no-op', 7).ok, true);
  assert.equal(manager.recordTerminalAuthorityServerRecoveryApplied(SESSION_ID, {
    clientId: 'client-no-op',
    viewGeneration: 7,
    replayToken: 'replay-no-op',
    snapshotSeq: 1,
    snapshotMode: 'authoritative',
    snapshotTruncated: false,
    queuedOutputBytes: 0,
    queuedOutputTruncated: false,
  }).ok, true);
  const createsBefore = [...harness.headlessScrollbackCreates];

  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
  });
  assert.equal(opened.accepted, true);
  assert.equal((await manager.cleanupTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    restoreScopes: ['retained-policy', 'authority-runtime'],
    authorityFence: readAuthorityFence(manager),
  })).accepted, true);

  assert.deepEqual(harness.headlessScrollbackCreates, createsBefore,
    'an isolation that changed no model state must not recreate the authoritative headless runtime');
  assert.deepEqual(manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '2',
    limitedSessionSelected: true,
  }), { ok: true });
});

test('MIG-BGSTAB-002 configured corpus windows yield to control-plane tasks', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
  });
  assert.equal(opened.accepted, true);

  let controlTaskObserved = false;
  setImmediate(() => { controlTaskObserved = true; });
  const writesBefore = harness.headlessWrites.length;
  const applied = await manager.applyTerminalAuthorityDebugIsolationContract({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    testContract: {
      productionConfiguredRangeProbe: {
        physicalLineCount: 600,
        configuredScrollbackLines: 8,
      },
    },
  });
  assert.equal(applied.accepted, true, JSON.stringify(applied));
  assert.equal(
    harness.headlessWrites.length - writesBefore <= 3,
    true,
    'a 600-line configured corpus must use one bounded data window instead of per-256-line drains',
  );
  assert.equal(
    controlTaskObserved,
    true,
    'configured corpus generation must not starve WebSocket control frames until the full corpus completes',
  );
  assert.equal(
    manager.getRetainedTerminalAuthorityState(SESSION_ID)?.retentionPolicy.retentionPolicyId,
    opened.productionConfiguredRetentionPolicyId,
    'an isolation using the exact production retained range must preserve the production policy identity',
  );
});

test('MIG-BGSTAB-002 headless recreation restores the registered legacy driver lease', async t => {
  const harness = createHarness('legacy');
  t.after(() => harness.close());
  const { manager } = harness;
  assert.equal(manager.registerRetainedTerminalClientView(SESSION_ID, 'client-driver', 11).ok, true);
  assert.equal(manager.establishRetainedTerminalMutationLease(SESSION_ID, 'client-driver', 11).ok, true);

  const opened = await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
    testContract: {
      retainedPolicyOverride: { effectiveRetainedScrollbackLines: 3 },
    },
  });
  assert.equal(opened.accepted, true, JSON.stringify(opened));
  const parity = manager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
  assert.equal(parity.leaseParity, true, JSON.stringify(parity));
  const runtime = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(runtime?.suspendedBrowserDriver?.clientId, 'client-driver');
  assert.equal(runtime?.suspendedBrowserDriver?.viewGeneration, 11);
  assert.equal(manager.recordTerminalAuthorityServerRecoveryApplied(SESSION_ID, {
    clientId: 'client-driver',
    viewGeneration: 11,
    replayToken: 'replay-recreated-model',
    snapshotSeq: 1,
    snapshotMode: 'authoritative',
    snapshotTruncated: false,
    queuedOutputBytes: 0,
    queuedOutputTruncated: false,
  }).ok, true);
  assert.deepEqual(manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '2',
    limitedSessionSelected: true,
  }), { ok: true }, 'a recreated legacy runtime must reopen promotion admission before the first attempt');
});

test('MIG-BGSTAB-002 debug payload integrity fails closed before queue/model mutation', async t => {
  const harness = createHarness();
  t.after(() => harness.close());
  const { manager } = harness;
  assert.equal((await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
  })).accepted, true);

  const writesBefore = harness.headlessWrites.length;
  const recordsBefore = harness.enqueuedAuthorityRecords.length;
  const sourceSeqBefore = manager.getRetainedTerminalAuthorityState(SESSION_ID)?.sourceSeq;
  const rejected = await manager.applyTerminalAuthorityDebugIsolationContract({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    testContract: {
      retainedCorpusInjection: payload('must-not-reach-the-model', '0'.repeat(64)),
    },
  });
  assert.deepEqual(rejected, { accepted: false, reason: 'debug-payload-integrity-invalid' });
  assert.equal(harness.headlessWrites.length, writesBefore);
  assert.equal(harness.enqueuedAuthorityRecords.length, recordsBefore);
  assert.equal(manager.getRetainedTerminalAuthorityState(SESSION_ID)?.sourceSeq, sourceSeqBefore);
  assert.equal(manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID)
    .resourceInventory.retainedCorpusFixtures, 0);
});

test('MIG-BGSTAB-002 query probe seeds through the counted model path and commits one live PTY reply', async t => {
  const harness = createHarness();
  t.after(() => harness.close());
  const { manager } = harness;
  assert.equal((await manager.beginTerminalAuthorityDebugIsolation({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    transitionPolicy: 'fresh-isolated-epoch',
  })).accepted, true);
  const modelInstanceId = manager.getTerminalAuthorityDebugModelInstanceId(SESSION_ID);
  assert.ok(modelInstanceId);

  const query = '\x1b[6n';
  const writesBefore = harness.headlessWrites.length;
  const result = await manager.applyTerminalAuthorityDebugIsolationContract({
    sessionId: SESSION_ID,
    desiredMode: 'server',
    cleanupToken: CLEANUP_TOKEN,
    isolationLeaseId: ISOLATION_LEASE_ID,
    testContract: {
      queryResponderProbe: {
        ...payload(query),
        authoritativeModelInstanceId: modelInstanceId,
      },
    },
  });
  assert.equal(result.accepted, true);
  const queryEvidence = (result.testContract as Record<string, Record<string, unknown>>)
    .queryResponderProbe;
  assert.equal(queryEvidence.inputCopies, 3);
  assert.equal(queryEvidence.browserReplyCount, 0);
  assert.equal(queryEvidence.seedBrowserReplyCount, 0);
  assert.equal(queryEvidence.seedPtyReplyCount, 0);
  assert.equal(queryEvidence.replayBrowserReplyCount, 0);
  assert.equal(queryEvidence.replayPtyReplyCount, 0);
  assert.equal(queryEvidence.liveBrowserReplyCount, 0);
  assert.equal(queryEvidence.livePtyReplyCount, 1);
  assert.equal(queryEvidence.serverPtyReplyCount, 1);
  assert.equal(queryEvidence.duplicatePtyReplyCount, 0);
  assert.equal(queryEvidence.effectDisposition, 'committed-once');
  assert.deepEqual(
    harness.headlessWrites.slice(writesBefore),
    [query, query, query],
    'seed, replay, and live copies must all pass the counted production model-write seam',
  );
  assert.equal(harness.settledEffectKeys.length, 1);
  assert.equal(harness.pty.writes.length, 1);
  assert.equal(
    Buffer.from(String(queryEvidence.replyData), 'base64').toString('utf8'),
    harness.pty.writes[0],
  );
  assert.match(harness.pty.writes[0]!, /^\x1b\[\?*[0-9]+;[0-9]+R$/u);
  assert.equal(manager.getTerminalAuthorityDebugResourceInventory(SESSION_ID)
    .resourceInventory.queryEffectLedgers, 1);
});
