import { createHash } from 'node:crypto';
import { resourceLimitsSchema } from '../../server/src/schemas/config.schema.js';
import type { Config } from '../../server/src/types/config.types.js';
import { RuntimeConfigStore } from '../../server/src/services/RuntimeConfigStore.js';
import { createHeadlessOutputQueue } from '../../server/src/utils/headlessOutputQueue.js';
import {
  createWsTransportMessage,
  createWsTransportQueueState,
  dequeueNextTransportMessage,
  getTransportMessagesInPriorityOrder,
  pushTransportMessage,
  tryCoalesceOutputMessage,
} from '../../server/src/ws/wsSendPolicy.js';
import { wirePayloadHex } from '../../server/src/ws/wirePayload.js';
import { evaluateBrowserInputBackpressure } from '../../frontend/src/utils/webSocketBackpressure.ts';
import { createTerminalOutputScheduler, type TerminalOutputWriteData } from '../../frontend/src/utils/terminalOutputScheduler.ts';
import {
  beginHiddenOutputReplay,
  createHiddenOutputReplayState,
  createHiddenOutputState,
  finishHiddenOutputReplay,
  resolveHiddenOutput,
} from '../../frontend/src/utils/terminalHiddenOutput.ts';
import { createVisibleOutputRecoveryCoordinator } from '../../frontend/src/utils/visibleOutputRecovery.ts';
import {
  cleanupExpiredTerminalSnapshotTombstones,
  getTerminalSnapshotRemovalKey,
  parseTerminalViewportSnapshot,
  setTerminalSnapshotWithQuotaRecovery,
} from '../../frontend/src/utils/terminalSnapshot.ts';
import {
  getNextTerminalRuntimeResidencyRefreshDelay,
  resolveTerminalRuntimeResidency,
  type TerminalRuntimeResidencyMetadata,
} from '../../frontend/src/hooks/useTerminalRuntimeResidency.ts';
import type { WorkspaceTabRuntime } from '../../frontend/src/types/workspace.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createFixture(): Config {
  return {
    server: { port: 4242 },
    pty: {
      termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: false,
      scrollbackLines: 2_345, maxSnapshotBytes: 65_536, shell: 'auto',
    },
    session: { idleDelayMs: 200 },
    resourceLimits: resourceLimitsSchema.parse({
      headless: { pendingOutputMaxBytes: 1_024, pendingOutputMaxChunks: 2 },
      clientWs: { inputBackpressureBytes: 1_024, hardReconnectBytes: 2_048 },
      terminal: {
        visibleOutputQueueMaxBytes: 1_024,
        visibleOutputMaxChunks: 2,
        visibleFlushBudgetBytes: 1_024,
        hiddenOutputPolicy: 'debug-tail',
        hiddenOutputTailBytes: 5,
        scrollbackLines: 12_345,
      },
      snapshots: {
        perSnapshotMaxChars: 1_024,
        totalStorageBudgetChars: 2_048,
        maxEntries: 1,
        tombstoneTtlMs: 1_000,
      },
      workspaceRuntime: { maxLiveWorkspaces: 1, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 1_000 },
    }),
    stabilityModes: { headlessQueueMode: 'observe', wsSendMode: 'direct', frontendRuntimeResidency: 'bounded' },
  };
}

function hex(data: TerminalOutputWriteData): string {
  return Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data).toString('hex');
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  entries(): Array<[string, string]> { return [...this.values.entries()].sort(([left], [right]) => left.localeCompare(right)); }
}

function makeTab(id: string, workspaceId: string): WorkspaceTabRuntime {
  return {
    id, workspaceId, sessionId: `session-${id}`, name: id, colorIndex: 0, sortOrder: 0,
    shellType: 'powershell', createdAt: '2026-07-16T00:00:00.000Z', status: 'idle', cwd: '',
  };
}

function runConsumerCorpus(store: RuntimeConfigStore): Record<string, unknown> {
  const editable = store.getEditableValues();
  const runtime = store.getPublicRuntimeConfig('queue');

  let now = 1_000;
  const headless = createHeadlessOutputQueue({
    maxBytes: editable.resourceLimits.headless.pendingOutputMaxBytes,
    maxChunks: editable.resourceLimits.headless.pendingOutputMaxChunks,
    overflowPolicy: editable.resourceLimits.headless.overflowPolicy,
    now: () => now++,
  });
  const headlessEnqueue = ['A'.repeat(600), '한'.repeat(600), 'B', 'C'].map(data => headless.enqueue(data));
  const headlessBeforeDrain = headless.snapshot();
  const headlessDrain = headless.drain().map(entry => ({ dataSha256: sha256(entry.data), byteLength: entry.byteLength, queuedAt: entry.queuedAt }));

  const first = createWsTransportMessage({ type: 'output', sessionId: 's1', data: 'A한', screenSeq: 1, chunkId: 'c1' }, 1_000);
  const second = createWsTransportMessage({ type: 'output', sessionId: 's1', data: '🙂', screenSeq: 2, chunkId: 'c2' }, 1_001);
  const coalesced = tryCoalesceOutputMessage(first, second, editable.resourceLimits.ws.outputCoalesceWindowMs);
  if (!coalesced) throw new Error('expected deterministic WS coalescing');
  const control = createWsTransportMessage({ type: 'pong', value: 7 }, 1_002);
  const wsQueue = createWsTransportQueueState();
  pushTransportMessage(wsQueue, coalesced);
  pushTransportMessage(wsQueue, control);
  const wsPriority = getTransportMessagesInPriorityOrder(wsQueue).map(message => message.kind);
  const wsDrain = [dequeueNextTransportMessage(wsQueue), dequeueNextTransportMessage(wsQueue)]
    .filter((entry) => entry !== undefined)
    .map(message => ({ kind: message.kind, payloadHex: wirePayloadHex(message.payload), byteLength: message.byteLength, sourceSegments: message.sourceSegments ?? [] }));

  const backpressurePayload = JSON.stringify({ type: 'input', data: 'A한🙂' });
  const backpressure = [0, 1_024, 2_048].map(bufferedAmount => evaluateBrowserInputBackpressure({
    messageType: 'input', serializedPayload: backpressurePayload, bufferedAmount,
    limits: runtime.resourceLimits.clientWs,
  }));

  const scheduled: Array<() => void> = [];
  const pendingWrites: Array<() => void> = [];
  const schedulerWrites: string[] = [];
  const schedulerCallbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    ...runtime.resourceLimits.terminal,
    write(data, onWritten) { schedulerWrites.push(hex(data)); pendingWrites.push(onWritten); },
    schedule(drain) { scheduled.push(drain); },
    now: () => 0,
  });
  const schedulerAdmission = scheduler.enqueue('A한🙂Z', () => schedulerCallbacks.push('data'));
  const schedulerBarrier = scheduler.enqueueBarrier(() => schedulerCallbacks.push('barrier'));
  while (scheduled.length > 0) scheduled.shift()?.();
  const probe = scheduler.captureFifoProbeIdentity();
  while (pendingWrites.length > 0) {
    pendingWrites.shift()?.();
    while (scheduled.length > 0) scheduled.shift()?.();
  }
  const schedulerCap = createTerminalOutputScheduler({
    ...runtime.resourceLimits.terminal,
    write() {}, schedule() {}, now: () => 0,
  }).enqueue('X'.repeat(runtime.resourceLimits.terminal.visibleOutputQueueMaxBytes + 1));

  const hiddenVisible = resolveHiddenOutput(createHiddenOutputState(), { isVisible: true, byteLength: 1, data: 'A', hiddenOutputPolicy: 'debug-tail', hiddenOutputTailBytes: 5 });
  const hidden = resolveHiddenOutput(hiddenVisible.nextState, { isVisible: false, byteLength: 8, data: 'A한🙂Z', hiddenOutputPolicy: runtime.resourceLimits.terminal.hiddenOutputPolicy, hiddenOutputTailBytes: runtime.resourceLimits.terminal.hiddenOutputTailBytes });
  const replayBegin = beginHiddenOutputReplay(createHiddenOutputReplayState(), false);
  const replayFinish = finishHiddenOutputReplay(replayBegin.replayState, replayBegin.initialRestorePending);

  const recoveryTrace = {
    scheduled: [] as Array<{ chunkId: string; data: string }>,
    ready: [] as boolean[],
    outcomes: [] as Array<{ outcome: string; reason: string }>,
    fresh: [] as string[],
    directWrites: [] as string[],
  };
  const recovery = createVisibleOutputRecoveryCoordinator({
    maxHeldBytes: runtime.resourceLimits.terminal.visibleOutputQueueMaxBytes,
    maxHeldChunks: runtime.resourceLimits.terminal.visibleOutputMaxChunks,
    transportMode: 'unified',
    adapter: {
      enqueueScheduledOutput: write => recoveryTrace.scheduled.push({ chunkId: write.chunk.chunkId, data: write.chunk.data }),
      setCurrentViewReady: change => recoveryTrace.ready.push(change.ready),
      abortRepair() {},
      requestFreshSnapshot: request => recoveryTrace.fresh.push(request.reason),
      publishOutcome: outcome => recoveryTrace.outcomes.push({ outcome: outcome.outcome, reason: outcome.reason }),
      acknowledgeRepairSuccess() {},
      directWrite: write => recoveryTrace.directWrites.push(write.data),
      activateSplitOutput() {},
    },
  });
  const scope = { clientId: 'client-1', sessionId: 'session-1' };
  const identity = { transactionId: 'tx-1', repairToken: 'repair-1', replayToken: 'replay-1', connectionGeneration: 7, sessionGeneration: 11 };
  const recoveryBegin = recovery.dispatch({ type: 'begin-resync', ...scope, ...identity, hiddenDirty: true, hiddenSkipped: true });
  const recoveryAdmissions = [
    recovery.dispatch({ type: 'output-arrived', ...scope, ...identity, chunk: { chunkId: 'chunk-1', screenSeq: 41, data: 'A' } }),
    recovery.dispatch({ type: 'output-arrived', ...scope, ...identity, chunk: { chunkId: 'chunk-2', screenSeq: 42, data: '한' } }),
    recovery.dispatch({ type: 'output-arrived', ...scope, ...identity, chunk: { chunkId: 'chunk-3', screenSeq: 43, data: 'C' } }),
    recovery.dispatch({ type: 'output-arrived', ...scope, ...identity, connectionGeneration: 6, chunk: { chunkId: 'stale', screenSeq: 44, data: 'stale' } }),
  ].map(result => ({ ignored: result.ignored, heldBytes: result.state?.heldOutputBytes, heldIds: result.state?.heldChunks.map(chunk => chunk.chunkId) ?? [] }));

  const storage = new MemoryStorage();
  const snapshot = (sessionId: string, content: string, savedAt: string) => JSON.stringify({
    schemaVersion: 2, payloadKind: 'viewport-only', sessionId, content, cols: 80, rows: 24,
    bufferType: 'normal', savedAt,
  });
  const snapshotOne = snapshot('s1', 'first', '2026-07-16T00:00:00.000Z');
  const snapshotTwo = snapshot('s2', 'second', '2026-07-16T00:00:01.000Z');
  const saveOne = setTerminalSnapshotWithQuotaRecovery('s1', snapshotOne, { storage, maxTotalChars: runtime.resourceLimits.snapshots.totalStorageBudgetChars, maxEntries: runtime.resourceLimits.snapshots.maxEntries });
  const saveTwo = setTerminalSnapshotWithQuotaRecovery('s2', snapshotTwo, { storage, maxTotalChars: runtime.resourceLimits.snapshots.totalStorageBudgetChars, maxEntries: runtime.resourceLimits.snapshots.maxEntries });
  storage.setItem(getTerminalSnapshotRemovalKey('old'), JSON.stringify({ savedAt: '2026-07-16T00:00:00.000Z' }));
  const cleanup = cleanupExpiredTerminalSnapshotTombstones({ storage, tombstoneTtlMs: runtime.resourceLimits.snapshots.tombstoneTtlMs, nowMs: Date.parse('2026-07-16T00:00:02.000Z') });
  const parsedSnapshot = parseTerminalViewportSnapshot(snapshotTwo, 's2', { maxContentLength: runtime.resourceLimits.snapshots.perSnapshotMaxChars });

  const tabs = [makeTab('t1', 'w1'), makeTab('t2', 'w2')];
  const metadataByTabId: Record<string, TerminalRuntimeResidencyMetadata> = {
    t1: { tabId: 't1', workspaceId: 'w1', sessionId: 'session-t1', lastAccessedAt: 10_000, hiddenSince: null, workspaceLastAccessedAt: 10_000 },
    t2: { tabId: 't2', workspaceId: 'w2', sessionId: 'session-t2', lastAccessedAt: 1, hiddenSince: 1, workspaceLastAccessedAt: 1 },
  };
  const residency = resolveTerminalRuntimeResidency({ tabs, pinnedTabIds: new Set(['t1']), activeWorkspaceId: 'w1', now: 10_000, limits: runtime.resourceLimits.workspaceRuntime, frontendRuntimeResidencyMode: 'bounded', metadataByTabId });
  const residencyDelay = getNextTerminalRuntimeResidencyRefreshDelay({ tabs, pinnedTabIds: new Set(['t1']), now: 10_000, limits: runtime.resourceLimits.workspaceRuntime, metadataByTabId });

  return {
    'server.headless-output-queue': { admission: headlessEnqueue, beforeDrain: headlessBeforeDrain, drain: headlessDrain },
    'server.ws-send-policy': { coalesced: { payloadHex: wirePayloadHex(coalesced.payload), byteLength: coalesced.byteLength, sourceSegments: coalesced.sourceSegments }, priority: wsPriority, drain: wsDrain },
    'browser.websocket-backpressure': backpressure,
    'browser.output-scheduler': { admission: schedulerAdmission, barrier: schedulerBarrier, writes: schedulerWrites, callbacks: schedulerCallbacks, probe: probe ? { generation: probe.generation, writeToken: probe.writeToken } : null, cap: schedulerCap, idle: scheduler.isIdle(), stale: scheduler.isStale() },
    'browser.hidden-output': { visible: hiddenVisible, hidden, replayBegin, replayFinish },
    'browser.visible-output-recovery': { begin: { ignored: recoveryBegin.ignored, generation: recoveryBegin.state?.connectionGeneration, sessionGeneration: recoveryBegin.state?.sessionGeneration }, admissions: recoveryAdmissions, trace: recoveryTrace },
    'browser.snapshot-storage': { saveOne: { saved: saveOne.saved, removed: saveOne.eviction.removedKeys }, saveTwo: { saved: saveTwo.saved, removed: saveTwo.eviction.removedKeys }, cleanup, parsed: parsedSnapshot, storage: storage.entries() },
    'browser.runtime-residency': { resident: residency.residentTabs.map(tab => tab.id), evicted: residency.evictedTabIds, pinned: residency.pinnedTabIds, nextDelay: residencyDelay },
  };
}

function captureRuntime(store: RuntimeConfigStore) {
  const policy = store.getTerminalResourcePolicyObservation();
  return {
    snapshot: JSON.stringify(store.getSnapshot()), editable: JSON.stringify(store.getEditableValues()),
    public: JSON.stringify(store.getPublicRuntimeConfig('strict')), storage: JSON.stringify({ values: store.getSnapshot().values }),
    defaults: JSON.stringify(resourceLimitsSchema.parse(undefined)), decisionStack: JSON.stringify(policy.decisionStack),
  };
}

const fixture = createFixture();
const disabled = new RuntimeConfigStore(structuredClone(fixture), 'linux', { terminalResourcePolicy: { observation: 'disabled' } });
const observed = new RuntimeConfigStore(structuredClone(fixture), 'linux', { terminalResourcePolicy: { observation: 'observe', candidateSelection: { policyId: 'unregistered-evidence-candidate', profileVersion: '1.0.0' } } });
const disabledRuntime = captureRuntime(disabled);
const observedRuntime = captureRuntime(observed);
const disabledConsumers = runConsumerCorpus(disabled);
const observedConsumers = runConsumerCorpus(observed);
const harnessIds = Object.keys(disabledConsumers);
const consumerDimensions = Object.fromEntries(harnessIds.map(id => [id, JSON.stringify(disabledConsumers[id]) === JSON.stringify(observedConsumers[id])]));
const beforeRead = observed.getTerminalResourcePolicyObservation();
const afterRead = observed.getTerminalResourcePolicyObservation();
const disabledSerialized = JSON.stringify(disabledRuntime);
const observedSerialized = JSON.stringify(observedRuntime);
const disabledConsumerSerialized = JSON.stringify(disabledConsumers);
const observedConsumerSerialized = JSON.stringify(observedConsumers);
const backpressureTrace = disabledConsumers['browser.websocket-backpressure'] as Array<{ action: string }>;
const schedulerTrace = disabledConsumers['browser.output-scheduler'] as { cap: { ok: boolean }; writes: string[]; probe: { generation: number } | null };
const headlessTrace = disabledConsumers['server.headless-output-queue'] as { admission: Array<{ ok: boolean }> };
const hiddenTrace = disabledConsumers['browser.hidden-output'] as { hidden: { action: string } };
const recoveryTrace = disabledConsumers['browser.visible-output-recovery'] as { begin: { generation?: number }; admissions: Array<{ ignored: boolean }> };

const output = {
  schemaVersion: 'terminal-resource-policy-differential/v2',
  requirementId: 'OBS-BGSTAB-005',
  fixtureId: 'observer-disabled-vs-observe-actual-consumer-corpus',
  runtimeProjection: {
    disabledSha256: sha256(disabledSerialized), observedSha256: sha256(observedSerialized),
    byteForByteEqual: disabledSerialized === observedSerialized,
  },
  actualConsumers: {
    disabledSha256: sha256(disabledConsumerSerialized), observedSha256: sha256(observedConsumerSerialized),
    byteForByteEqual: disabledConsumerSerialized === observedConsumerSerialized,
    dimensions: consumerDimensions,
    harnessIds,
    coverage: {
      admission: headlessTrace.admission.some(result => result.ok),
      cap: schedulerTrace.cap.ok === false,
      drop: headlessTrace.admission.some(result => !result.ok) && hiddenTrace.hidden.action === 'skip',
      reconnect: backpressureTrace.some(result => result.action === 'hard-reconnect'),
      recovery: recoveryTrace.admissions.some(result => !result.ignored),
      bytes: schedulerTrace.writes.length > 0,
      order: (disabledConsumers['server.ws-send-policy'] as { priority: string[] }).priority.length > 1,
      generation: recoveryTrace.begin.generation === 7 && schedulerTrace.probe?.generation !== undefined,
    },
  },
  candidate: { selected: true, status: beforeRead.candidate.status, reason: beforeRead.candidate.reason, appliedPolicyId: beforeRead.appliedPolicyId, legacyPolicyId: beforeRead.legacyPolicy.policyId },
  evidenceOwnership: beforeRead.decisionEvidence,
  telemetry: {
    getterReadOnly: JSON.stringify(beforeRead.recentObservations) === JSON.stringify(afterRead.recentObservations),
    disabledCount: disabled.getTerminalResourcePolicyObservation().recentObservations.length,
    observedCount: beforeRead.recentObservations.length,
    payloadFree: !/password|secret|token|rawTerminalPayload/i.test(JSON.stringify(beforeRead.recentObservations)),
  },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
