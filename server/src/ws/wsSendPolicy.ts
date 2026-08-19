import { FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR } from '../benchmarks/fairSchedulerAuthorityLocator.js';

export type WsTransportMessageKind = 'output' | 'terminal-bulk' | 'control' | 'terminal-control';

export interface WsOutputSourceSegment {
  byteStart: number;
  byteEnd: number;
  screenSeq?: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  chunkId: string;
}

export interface WsTransportMessage {
  kind: WsTransportMessageKind;
  payload: string;
  byteLength: number;
  queuedAt: number;
  type?: string;
  sessionId?: string;
  repairToken?: string;
  replayToken?: string;
  screenSeq?: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  chunkId?: string;
  // Fair delivery routing identity. Routing decisions must read these sidecar
  // fields instead of re-parsing `payload`.
  connectionEpoch?: string;
  deliverySeq?: number;
  deliveryKind?: string;
  outputData?: string;
  sourceSegments?: WsOutputSourceSegment[];
  policyGeneration?: number;
  expiresAt?: number;
  ready?: boolean;
  recoveryGeneration?: number;
  source?: string;
  exactlyOnceKey?: string;
  policyAdmissionMode?: 'candidate' | 'legacy';
  canarySendFailureCount?: number;
  terminalAuthorityTransportBinding?: {
    connectionId: string;
    lane: 'control' | 'terminal';
    bindingId: string;
  };
  onSettled?: (error?: Error) => void;
}

export interface WsTransportQueueState {
  controlItems: WsTransportMessage[];
  controlHead: number;
  terminalItems: WsTransportMessage[];
  terminalHead: number;
  outputBytes: number;
  controlBytes: number;
  sending: boolean;
  flushTimer: NodeJS.Timeout | null;
}

export function createWsTransportQueueState(): WsTransportQueueState {
  return {
    controlItems: [],
    controlHead: 0,
    terminalItems: [],
    terminalHead: 0,
    outputBytes: 0,
    controlBytes: 0,
    sending: false,
    flushTimer: null,
  };
}

export interface WsTransportMessageMetadata {
  policyGeneration?: number;
  expiresAt?: number;
  ready?: boolean;
  recoveryGeneration?: number;
  source?: string;
  exactlyOnceKey?: string;
  policyAdmissionMode?: 'candidate' | 'legacy';
}

// @req REL-BGSTAB-010
export function createWsTransportMessage(
  message: object,
  now = Date.now(),
  metadata: WsTransportMessageMetadata = {},
): WsTransportMessage {
  const record = message as Record<string, unknown>;
  const output = isOutputMessage(message) ? message : null;
  const sourceSegments = output ? readOutputSourceSegments(record.sourceSegments) : undefined;
  const kind = output ? 'output' : getControlMessageKind(message);
  const wireMessage = { ...record };
  delete wireMessage.policyGeneration;
  const payload = JSON.stringify(wireMessage);
  return {
    kind,
    payload,
    byteLength: Buffer.byteLength(payload, 'utf8'),
    queuedAt: now,
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.repairToken === 'string' ? { repairToken: record.repairToken } : {}),
    ...(typeof record.replayToken === 'string' ? { replayToken: record.replayToken } : {}),
    ...(typeof record.screenSeq === 'number' && Number.isFinite(record.screenSeq)
      ? { screenSeq: record.screenSeq }
      : {}),
    ...(typeof record.authorityEpoch === 'string' ? { authorityEpoch: record.authorityEpoch } : {}),
    ...(typeof record.authorityRevision === 'number'
      && Number.isSafeInteger(record.authorityRevision)
      && record.authorityRevision >= 0
      ? { authorityRevision: record.authorityRevision }
      : {}),
    ...(typeof record.chunkId === 'string' ? { chunkId: record.chunkId } : {}),
    ...(typeof record.connectionEpoch === 'string' ? { connectionEpoch: record.connectionEpoch } : {}),
    ...(typeof record.deliverySeq === 'number' && Number.isSafeInteger(record.deliverySeq)
      ? { deliverySeq: record.deliverySeq }
      : {}),
    ...(typeof record.deliveryKind === 'string' ? { deliveryKind: record.deliveryKind } : {}),
    ...(output ? { outputData: output.data } : {}),
    ...(sourceSegments && sourceSegments.length > 0 ? { sourceSegments } : {}),
    ...(metadata.policyGeneration !== undefined ? { policyGeneration: metadata.policyGeneration } : {}),
    ...(metadata.expiresAt !== undefined ? { expiresAt: metadata.expiresAt } : {}),
    ...(metadata.ready !== undefined ? { ready: metadata.ready } : {}),
    ...(metadata.recoveryGeneration !== undefined
      ? { recoveryGeneration: metadata.recoveryGeneration }
      : {}),
    ...(metadata.source !== undefined ? { source: metadata.source } : {}),
    ...(metadata.exactlyOnceKey !== undefined ? { exactlyOnceKey: metadata.exactlyOnceKey } : {}),
    ...(metadata.policyAdmissionMode !== undefined
      ? { policyAdmissionMode: metadata.policyAdmissionMode }
      : {}),
  };
}

export interface SupersededRecoveryTransportScope {
  sessionId: string;
  replayToken: string;
}

// @req REL-BGSTAB-008
export function isSupersededRecoveryTransportMessage(
  message: WsTransportMessage,
  scope: SupersededRecoveryTransportScope,
): boolean {
  if (
    message.sessionId !== scope.sessionId
    || message.replayToken !== scope.replayToken
  ) {
    return false;
  }
  return message.type === 'output'
    || message.type === 'screen-snapshot'
    || message.type === 'session:ready'
    || message.type === 'screen-repair:restore-needed';
}

export interface SupersededRepairTransportScope {
  sessionId: string;
  repairToken: string;
}

// @req REL-BGSTAB-008
export function isSupersededRepairTransportMessage(
  message: WsTransportMessage,
  scope: SupersededRepairTransportScope,
): boolean {
  if (
    message.sessionId !== scope.sessionId
    || message.repairToken !== scope.repairToken
  ) {
    return false;
  }
  return message.type === 'output'
    || message.type === 'screen-repair'
    || message.type === 'screen-repair:restore-needed'
    || message.type === 'session:ready';
}

export interface RemovedWsTransportMessages {
  removedCount: number;
  removedOutputBytes: number;
  removedControlBytes: number;
}

// @req REL-BGSTAB-008
export function removeTransportMessages(
  state: WsTransportQueueState,
  predicate: (message: WsTransportMessage) => boolean,
): RemovedWsTransportMessages {
  const removed: WsTransportMessage[] = [];
  const retain = (messages: WsTransportMessage[], head: number): WsTransportMessage[] => {
    const retained: WsTransportMessage[] = [];
    for (const message of messages.slice(head)) {
      if (predicate(message)) {
        removed.push(message);
      } else {
        retained.push(message);
      }
    }
    return retained;
  };

  state.controlItems = retain(state.controlItems, state.controlHead);
  state.controlHead = 0;
  state.terminalItems = retain(state.terminalItems, state.terminalHead);
  state.terminalHead = 0;

  const removedOutputBytes = removed
    .filter(isOutputBudgetMessage)
    .reduce((total, message) => total + message.byteLength, 0);
  const removedControlBytes = removed
    .filter(message => !isOutputBudgetMessage(message))
    .reduce((total, message) => total + message.byteLength, 0);
  state.outputBytes = Math.max(0, state.outputBytes - removedOutputBytes);
  state.controlBytes = Math.max(0, state.controlBytes - removedControlBytes);

  return {
    removedCount: removed.length,
    removedOutputBytes,
    removedControlBytes,
  };
}

export function tryCoalesceOutputMessage(
  existing: WsTransportMessage,
  incoming: WsTransportMessage,
  coalesceWindowMs: number,
): WsTransportMessage | null {
  if (
    existing.kind !== 'output'
    || incoming.kind !== 'output'
    || !existing.sessionId
    || existing.sessionId !== incoming.sessionId
    || existing.outputData === undefined
    || incoming.outputData === undefined
    || existing.policyGeneration !== incoming.policyGeneration
    || existing.expiresAt !== incoming.expiresAt
    || existing.ready !== incoming.ready
    || existing.recoveryGeneration !== incoming.recoveryGeneration
    || existing.source !== incoming.source
    || existing.exactlyOnceKey !== incoming.exactlyOnceKey
    || existing.policyAdmissionMode !== incoming.policyAdmissionMode
    || hasRecoveryIdentity(existing)
    || hasRecoveryIdentity(incoming)
    || hasFairDeliveryIdentity(existing)
    || hasFairDeliveryIdentity(incoming)
    || incoming.queuedAt - existing.queuedAt > coalesceWindowMs
  ) {
    return null;
  }

  const existingOutputBytes = Buffer.byteLength(existing.outputData, 'utf8');
  const incomingOutputBytes = Buffer.byteLength(incoming.outputData, 'utf8');
  const combinedOutputData = `${existing.outputData}${incoming.outputData}`;
  if (Buffer.byteLength(combinedOutputData, 'utf8') !== existingOutputBytes + incomingOutputBytes) {
    return null;
  }

  const existingSegments = materializeOutputSourceSegments(existing, 0);
  const incomingSegments = materializeOutputSourceSegments(
    incoming,
    existingOutputBytes,
  );
  if (existingSegments === null || incomingSegments === null) {
    return null;
  }
  if ((existingSegments.length === 0) !== (incomingSegments.length === 0)) {
    return null;
  }

  return createWsTransportMessage({
    type: 'output',
    sessionId: existing.sessionId,
    data: combinedOutputData,
    ...(existingSegments.length > 0
      ? { sourceSegments: [...existingSegments, ...incomingSegments] }
      : {}),
  }, existing.queuedAt, {
    policyGeneration: existing.policyGeneration,
    expiresAt: existing.expiresAt,
    ready: existing.ready,
    recoveryGeneration: existing.recoveryGeneration,
    source: existing.source,
    exactlyOnceKey: existing.exactlyOnceKey,
    policyAdmissionMode: existing.policyAdmissionMode,
  });
}

function hasRecoveryIdentity(message: WsTransportMessage): boolean {
  return message.repairToken !== undefined
    || message.replayToken !== undefined;
}

function hasFairDeliveryIdentity(message: WsTransportMessage): boolean {
  return message.connectionEpoch !== undefined
    || message.deliverySeq !== undefined
    || message.deliveryKind !== undefined;
}

function materializeOutputSourceSegments(
  message: WsTransportMessage,
  byteOffset: number,
): WsOutputSourceSegment[] | null {
  if (message.sourceSegments && message.sourceSegments.length > 0) {
    return message.sourceSegments.map(segment => ({
      ...segment,
      byteStart: segment.byteStart + byteOffset,
      byteEnd: segment.byteEnd + byteOffset,
    }));
  }
  if (message.chunkId !== undefined) {
    return [{
      byteStart: byteOffset,
      byteEnd: byteOffset + Buffer.byteLength(message.outputData ?? '', 'utf8'),
      ...(message.screenSeq !== undefined ? { screenSeq: message.screenSeq } : {}),
      ...(message.authorityEpoch !== undefined ? { authorityEpoch: message.authorityEpoch } : {}),
      ...(message.authorityRevision !== undefined ? { authorityRevision: message.authorityRevision } : {}),
      chunkId: message.chunkId,
    }];
  }
  return message.screenSeq === undefined ? [] : null;
}

// @req REL-BGSTAB-009
function readOutputSourceSegments(value: unknown): WsOutputSourceSegment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const segments: WsOutputSourceSegment[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      return undefined;
    }
    const segment = candidate as Record<string, unknown>;
    if (
      typeof segment.byteStart !== 'number'
      || typeof segment.byteEnd !== 'number'
      || (segment.screenSeq !== undefined && typeof segment.screenSeq !== 'number')
      || (segment.authorityEpoch !== undefined && typeof segment.authorityEpoch !== 'string')
      || (
        segment.authorityRevision !== undefined
        && (
          typeof segment.authorityRevision !== 'number'
          || !Number.isSafeInteger(segment.authorityRevision)
          || segment.authorityRevision < 0
        )
      )
      || typeof segment.chunkId !== 'string'
      || segment.byteStart < 0
      || segment.byteEnd < segment.byteStart
    ) {
      return undefined;
    }
    segments.push({
      byteStart: segment.byteStart,
      byteEnd: segment.byteEnd,
      ...(typeof segment.screenSeq === 'number' ? { screenSeq: segment.screenSeq } : {}),
      ...(typeof segment.authorityEpoch === 'string' ? { authorityEpoch: segment.authorityEpoch } : {}),
      ...(typeof segment.authorityRevision === 'number' ? { authorityRevision: segment.authorityRevision } : {}),
      chunkId: segment.chunkId,
    });
  }
  return segments;
}

export function getTransportQueuedMessageCount(state: WsTransportQueueState): number {
  return getQueuedCount(state.controlItems, state.controlHead)
    + getQueuedCount(state.terminalItems, state.terminalHead);
}

export function hasTransportQueuedMessages(state: WsTransportQueueState): boolean {
  return getTransportQueuedMessageCount(state) > 0;
}

export function getLastTerminalTransportMessage(state: WsTransportQueueState): WsTransportMessage | undefined {
  compactIfNeeded(state, 'terminal');
  if (state.terminalHead >= state.terminalItems.length) {
    return undefined;
  }
  return state.terminalItems[state.terminalItems.length - 1];
}

export function replaceLastTerminalTransportMessage(
  state: WsTransportQueueState,
  message: WsTransportMessage,
): void {
  compactIfNeeded(state, 'terminal');
  if (state.terminalHead >= state.terminalItems.length) {
    state.terminalItems.push(message);
    return;
  }
  state.terminalItems[state.terminalItems.length - 1] = message;
}

export function pushTransportMessage(state: WsTransportQueueState, message: WsTransportMessage): void {
  if (message.kind === 'control') {
    state.controlItems.push(message);
    return;
  }
  state.terminalItems.push(message);
}

export function prependTransportMessage(state: WsTransportQueueState, message: WsTransportMessage): void {
  if (message.kind === 'control') {
    if (state.controlHead > 0) {
      state.controlHead -= 1;
      state.controlItems[state.controlHead] = message;
    } else {
      state.controlItems.unshift(message);
    }
    return;
  }
  if (state.terminalHead > 0) {
    state.terminalHead -= 1;
    state.terminalItems[state.terminalHead] = message;
  } else {
    state.terminalItems.unshift(message);
  }
}

export function peekNextTransportMessage(state: WsTransportQueueState): WsTransportMessage | undefined {
  if (state.controlHead < state.controlItems.length) {
    return state.controlItems[state.controlHead];
  }
  return state.terminalItems[state.terminalHead];
}

export function dequeueNextTransportMessage(state: WsTransportQueueState): WsTransportMessage | undefined {
  if (state.controlHead < state.controlItems.length) {
    const next = state.controlItems[state.controlHead];
    state.controlHead += 1;
    compactIfNeeded(state, 'control');
    return next;
  }
  if (state.terminalHead < state.terminalItems.length) {
    const next = state.terminalItems[state.terminalHead];
    state.terminalHead += 1;
    compactIfNeeded(state, 'terminal');
    return next;
  }
  return undefined;
}

export function getTransportMessagesInPriorityOrder(state: WsTransportQueueState): WsTransportMessage[] {
  return [
    ...state.controlItems.slice(state.controlHead),
    ...state.terminalItems.slice(state.terminalHead),
  ];
}

export function clearTransportMessages(state: WsTransportQueueState): void {
  state.controlItems = [];
  state.controlHead = 0;
  state.terminalItems = [];
  state.terminalHead = 0;
}

function isOutputMessage(message: object): message is { type: 'output'; sessionId: string; data: string } {
  const record = message as Record<string, unknown>;
  return record.type === 'output'
    && typeof record.sessionId === 'string'
    && typeof record.data === 'string';
}

function getControlMessageKind(message: object): Exclude<WsTransportMessageKind, 'output'> {
  const record = message as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'terminal-checkpoint:start'
    || type === 'terminal-checkpoint:chunk'
    || type === 'terminal-checkpoint:commit'
    || type === 'terminal-checkpoint:output') {
    return 'terminal-bulk';
  }
  return isTerminalOrderedControlMessage(record, type) ? 'terminal-control' : 'control';
}

export function isOutputBudgetMessage(message: Pick<WsTransportMessage, 'kind'>): boolean {
  return message.kind === 'output' || message.kind === 'terminal-bulk';
}

function isTerminalOrderedControlMessage(record: Record<string, unknown>, type: string): boolean {
  if (type !== 'input:rejected' && typeof record.sessionId === 'string') {
    return true;
  }
  return type === 'screen-snapshot'
    || type === 'screen-repair'
    || type === 'session:ready'
    || type === 'subscribed';
}

function getQueuedCount(items: WsTransportMessage[], head: number): number {
  return Math.max(0, items.length - head);
}

// @req PERF-BGSTAB-010
export type FairTerminalDeliveryKind = 'output' | 'dataGap' | 'checkpoint' | 'readyBarrier' | 'control';

export interface FairTerminalDeliveryInput {
  connectionEpoch: string;
  sessionId: string;
  kind: FairTerminalDeliveryKind;
  payload: string;
  // Structured source of `payload` for control-shaped deliveries. Consumers that
  // need those fields back must read this sidecar instead of re-parsing `payload`.
  payloadFields?: Readonly<Record<string, unknown>>;
  screenSeq?: number;
  authorityEpoch?: string;
  authorityRevision?: number;
  chunkId?: string;
  serviceClass?: 'visible' | 'driver';
  capabilities?: { ackCredit: boolean; legacyFallback: boolean };
}

export interface FairTerminalDelivery extends FairTerminalDeliveryInput {
  deliverySeq: number;
  encodedBytes: number;
}

export interface FairTerminalDeliveryPolicyValue<T> {
  value: T;
  source: string;
}

export interface FairTerminalDeliveryPolicy {
  strategy: FairTerminalDeliveryPolicyValue<string>;
  socketSoftGateBytes: FairTerminalDeliveryPolicyValue<number>;
  bulkSliceBytes: FairTerminalDeliveryPolicyValue<number>;
  smallOutputBypassBytes: FairTerminalDeliveryPolicyValue<number>;
  visibilityWeight: FairTerminalDeliveryPolicyValue<number>;
  driverWeight: FairTerminalDeliveryPolicyValue<number>;
  creditWindowBytes: FairTerminalDeliveryPolicyValue<number>;
  ackTimeoutMs: FairTerminalDeliveryPolicyValue<number>;
  queueMaxBytes: FairTerminalDeliveryPolicyValue<number>;
}

export interface FairTerminalDecisionArtifactInput {
  state: 'missing' | 'incomplete' | 'complete';
  allRegisteredThresholdsPassed: boolean;
  hasUnboundedEligibleLaneStarvation: boolean;
}

export interface FairTerminalDeliverySchedulerOptions {
  now: () => number;
  policy: FairTerminalDeliveryPolicy;
  decisionArtifact: FairTerminalDecisionArtifactInput;
  send: (delivery: FairTerminalDelivery) => void;
  onSemanticStatusChange: (change: {
    connectionEpoch: string;
    sessionId: string;
    status: 'idle' | 'running';
  }) => void;
  onFallback?: (fallback: {
    connectionEpoch: string;
    sessionId: string;
    reason: string;
  }) => void;
}

interface FairTerminalLane {
  key: string;
  connectionEpoch: string;
  sessionId: string;
  nextDeliverySeq: number;
  lastSentSeq: number;
  lastAcknowledgedSeq: number;
  queue: Array<FairTerminalDelivery & { queuedAt: number }>;
  sent: Array<FairTerminalDelivery & { queuedAt: number }>;
  queuedBytes: number;
  socketQueuedBytes: number;
  creditBytes: number;
  deficitBytes: number;
  firstServiceLatencies: number[];
  completeLatencies: number[];
  lastServiceAt?: number;
  maximumNoServiceIntervalMs: number;
  peakApplicationQueuedBytes: number;
  peakSocketQueuedBytes: number;
  fallback?: { reason: string; producerBlocked: boolean; checkpointCount: number; closed: boolean };
  fallbackScheduled: boolean;
  released: boolean;
  releaseCount: number;
}

function fairLaneKey(connectionEpoch: string, sessionId: string): string {
  return `${connectionEpoch}/${sessionId}`;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function percentileMatrix(values: readonly number[]): { p50: number; p95: number; p99: number; max: number } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

function fairDeliveryBytes(input: FairTerminalDeliveryInput, deliverySeq: number): number {
  return createWsTransportMessage({
    type: 'output',
    sessionId: input.sessionId,
    data: input.payload,
    connectionEpoch: input.connectionEpoch,
    deliverySeq,
    deliveryKind: input.kind,
    screenSeq: input.screenSeq,
    authorityEpoch: input.authorityEpoch,
    authorityRevision: input.authorityRevision,
    chunkId: input.chunkId,
  }).byteLength;
}

function decisionState(input: FairTerminalDecisionArtifactInput): {
  accepted: boolean;
  reason: string;
} {
  if (input.state === 'missing') return { accepted: false, reason: 'decision-artifact-missing' };
  if (input.state === 'incomplete') return { accepted: false, reason: 'decision-artifact-incomplete' };
  if (!input.allRegisteredThresholdsPassed) return { accepted: false, reason: 'decision-threshold-failed' };
  if (input.hasUnboundedEligibleLaneStarvation) return { accepted: false, reason: 'eligible-lane-starvation' };
  return { accepted: true, reason: 'decision-artifact-accepted' };
}

// The scheduler is deliberately policy-fed: it has no transport or IPC constants of its own.
export function createFairTerminalDeliveryScheduler(options: FairTerminalDeliverySchedulerOptions) {
  const lanes = new Map<string, FairTerminalLane>();
  const laneOrder: string[] = [];
  const retiredEpochs = new Set<string>();
  const protocolErrors: Array<{ code: string; connectionEpoch: string; sessionId: string; deliverySeq: number }> = [];
  const releases: Record<string, number> = {};
  let roundRobinCursor = 0;
  let controlLatencies: number[] = [];
  let totalSentBytes = 0;
  const startedAt = options.now();

  const getLane = (connectionEpoch: string, sessionId: string): FairTerminalLane => {
    const key = fairLaneKey(connectionEpoch, sessionId);
    const existing = lanes.get(key);
    if (existing) return existing;
    const lane: FairTerminalLane = {
      key,
      connectionEpoch,
      sessionId,
      nextDeliverySeq: 1,
      lastSentSeq: 0,
      lastAcknowledgedSeq: 0,
      queue: [],
      sent: [],
      queuedBytes: 0,
      socketQueuedBytes: 0,
      creditBytes: 0,
      deficitBytes: 0,
      firstServiceLatencies: [],
      completeLatencies: [],
      maximumNoServiceIntervalMs: 0,
      peakApplicationQueuedBytes: 0,
      peakSocketQueuedBytes: 0,
      fallbackScheduled: false,
      released: false,
      releaseCount: 0,
    };
    lanes.set(key, lane);
    laneOrder.push(key);
    return lane;
  };

  const recordError = (code: string, connectionEpoch: string, sessionId: string, deliverySeq: number) => {
    protocolErrors.push({ code, connectionEpoch, sessionId, deliverySeq });
    return { accepted: false, creditedBytes: 0, errorCode: code };
  };

  const scheduleFallback = (lane: FairTerminalLane, reason: string) => {
    if (lane.released || lane.fallbackScheduled || lane.fallback) return;
    lane.fallbackScheduled = false;
    lane.fallback = { reason, producerBlocked: false, checkpointCount: 0, closed: false };
    lane.fallback.checkpointCount = 1;
    releaseLane(lane);
    options.onFallback?.({
      connectionEpoch: lane.connectionEpoch,
      sessionId: lane.sessionId,
      reason,
    });
  };

  const releaseLane = (lane: FairTerminalLane, retireConnection = false) => {
    if (lane.released) return;
    lane.released = true;
    lane.queue = [];
    lane.sent = [];
    lane.queuedBytes = 0;
    lane.socketQueuedBytes = 0;
    lane.creditBytes = 0;
    lane.fallbackScheduled = false;
    lane.releaseCount += 1;
    releases[lane.key] = lane.releaseCount;
    if (retireConnection) retiredEpochs.add(lane.connectionEpoch);
  };

  const eligible = (lane: FairTerminalLane, delivery: FairTerminalDelivery): boolean => {
    if (delivery.kind !== 'output') return true;
    if (lane.socketQueuedBytes + delivery.encodedBytes > options.policy.creditWindowBytes.value) return false;
    return lane.socketQueuedBytes < options.policy.socketSoftGateBytes.value
      || delivery.encodedBytes <= options.policy.smallOutputBypassBytes.value;
  };

  const deficitQuantum = (delivery: FairTerminalDelivery): number => (
    options.policy.bulkSliceBytes.value * (
      delivery.serviceClass === 'visible'
        ? options.policy.visibilityWeight.value
        : options.policy.driverWeight.value
    )
  );

  const canSpendDeficit = (lane: FairTerminalLane, delivery: FairTerminalDelivery): boolean => (
    delivery.kind !== 'output'
    || delivery.encodedBytes <= options.policy.smallOutputBypassBytes.value
    || lane.deficitBytes >= delivery.encodedBytes
  );

  const sendOne = (lane: FairTerminalLane): boolean => {
    const delivery = lane.queue[0];
    if (!delivery || !eligible(lane, delivery)) return false;
    lane.queue.shift();
    lane.queuedBytes = Math.max(0, lane.queuedBytes - delivery.encodedBytes);
    lane.lastSentSeq = delivery.deliverySeq;
    lane.sent.push(delivery);
    lane.socketQueuedBytes += delivery.encodedBytes;
    lane.peakSocketQueuedBytes = Math.max(lane.peakSocketQueuedBytes, lane.socketQueuedBytes);
    const now = options.now();
    const latency = Math.max(0, now - delivery.queuedAt);
    if (lane.firstServiceLatencies.length === 0) lane.firstServiceLatencies.push(latency);
    lane.completeLatencies.push(latency);
    if (delivery.kind === 'control') controlLatencies.push(latency);
    if (lane.lastServiceAt !== undefined) {
      lane.maximumNoServiceIntervalMs = Math.max(lane.maximumNoServiceIntervalMs, now - lane.lastServiceAt);
    }
    lane.lastServiceAt = now;
    if (delivery.kind === 'output' && delivery.encodedBytes > options.policy.smallOutputBypassBytes.value) {
      lane.deficitBytes = Math.max(0, lane.deficitBytes - delivery.encodedBytes);
    }
    totalSentBytes += delivery.encodedBytes;
    options.send(delivery);
    if (delivery.kind === 'output' && delivery.capabilities?.ackCredit === false) {
      scheduleFallback(lane, 'legacy-client');
    }
    return true;
  };

  return {
    enqueue(input: FairTerminalDeliveryInput): { accepted: boolean; deliverySeq?: number; reason?: string } {
      if (retiredEpochs.has(input.connectionEpoch)) {
        return { accepted: false, reason: 'connection-epoch-retired' };
      }
      const lane = getLane(input.connectionEpoch, input.sessionId);
      if (lane.released) return { accepted: false, reason: 'lane-released' };
      const deliverySeq = lane.nextDeliverySeq;
      const encodedBytes = fairDeliveryBytes(input, deliverySeq);
      if (lane.queuedBytes + encodedBytes > options.policy.queueMaxBytes.value) {
        scheduleFallback(lane, 'queue-overflow');
        return { accepted: false, reason: 'queue-overflow' };
      }
      const delivery = {
        ...input,
        deliverySeq: lane.nextDeliverySeq++,
        encodedBytes,
        queuedAt: options.now(),
      };
      lane.queue.push(delivery);
      lane.queuedBytes += encodedBytes;
      lane.peakApplicationQueuedBytes = Math.max(lane.peakApplicationQueuedBytes, lane.queuedBytes);
      return { accepted: true, deliverySeq: delivery.deliverySeq };
    },

    drain(input: { maxDeliveries?: number } = {}): void {
      const limit = input.maxDeliveries ?? Number.MAX_SAFE_INTEGER;
      let sentCount = 0;
      while (sentCount < limit) {
        let selected: FairTerminalLane | undefined;
        let waitingForDeficit = false;
        for (let offset = 0; offset < laneOrder.length; offset += 1) {
          const index = (roundRobinCursor + offset) % laneOrder.length;
          const candidate = lanes.get(laneOrder[index]);
          if (candidate && !candidate.released && candidate.queue[0]?.kind === 'control'
            && eligible(candidate, candidate.queue[0])) {
            selected = candidate;
            roundRobinCursor = (index + 1) % Math.max(1, laneOrder.length);
            break;
          }
        }
        if (selected && sendOne(selected)) {
          sentCount += 1;
          continue;
        }
        for (let offset = 0; offset < laneOrder.length; offset += 1) {
          const index = (roundRobinCursor + offset) % laneOrder.length;
          const candidate = lanes.get(laneOrder[index]);
          const delivery = candidate?.queue[0];
          if (!candidate || candidate.released || !delivery || !eligible(candidate, delivery)) continue;
          if (delivery.kind === 'output') {
            candidate.deficitBytes += deficitQuantum(delivery);
            if (!canSpendDeficit(candidate, delivery)) {
              waitingForDeficit = true;
              continue;
            }
          }
          if (candidate) {
            selected = candidate;
            roundRobinCursor = (index + 1) % Math.max(1, laneOrder.length);
            break;
          }
        }
        if (!selected) {
          if (waitingForDeficit) continue;
          break;
        }
        if (!sendOne(selected)) break;
        sentCount += 1;
      }
    },

    advanceTo(now: number): void {
      for (const lane of lanes.values()) {
        if (!lane.released && lane.sent.some(delivery => delivery.kind === 'output')
          && now - (lane.lastServiceAt ?? now) >= options.policy.ackTimeoutMs.value) {
          scheduleFallback(lane, lane.fallback?.reason ?? 'ack-timeout');
        }
      }
    },

    acknowledge(input: { connectionEpoch: string; sessionId: string; deliverySeq: number; clientBytes?: number }) {
      const lane = lanes.get(fairLaneKey(input.connectionEpoch, input.sessionId));
      if (!lane) {
        return recordError(retiredEpochs.has(input.connectionEpoch) ? 'ACK_STALE_EPOCH' : 'ACK_UNKNOWN_LANE', input.connectionEpoch, input.sessionId, input.deliverySeq);
      }
      if (lane.released) return recordError('ACK_STALE_EPOCH', input.connectionEpoch, input.sessionId, input.deliverySeq);
      if (input.deliverySeq <= lane.lastAcknowledgedSeq) return recordError('ACK_DUPLICATE', input.connectionEpoch, input.sessionId, input.deliverySeq);
      if (input.deliverySeq > lane.nextDeliverySeq - 1) return recordError('ACK_OVER_ACK', input.connectionEpoch, input.sessionId, input.deliverySeq);
      if (input.deliverySeq > lane.lastSentSeq) return recordError('ACK_OUT_OF_ORDER', input.connectionEpoch, input.sessionId, input.deliverySeq);
      const acknowledged = lane.sent.filter(delivery => delivery.deliverySeq > lane.lastAcknowledgedSeq && delivery.deliverySeq <= input.deliverySeq);
      const creditedBytes = acknowledged.reduce((total, delivery) => total + delivery.encodedBytes, 0);
      lane.lastAcknowledgedSeq = input.deliverySeq;
      lane.sent = lane.sent.filter(delivery => delivery.deliverySeq > input.deliverySeq);
      lane.creditBytes += creditedBytes;
      lane.socketQueuedBytes = Math.max(0, lane.socketQueuedBytes - creditedBytes);
      return { accepted: true, creditedBytes };
    },

    settleTransport(input: {
      connectionEpoch: string;
      sessionId: string;
      deliverySeq: number;
      error?: string;
    }): void {
      if (!input.error) return;
      const lane = lanes.get(fairLaneKey(input.connectionEpoch, input.sessionId));
      if (!lane || lane.released) return;
      const index = lane.sent.findIndex(delivery => delivery.deliverySeq === input.deliverySeq);
      if (index < 0) return;
      const [failed] = lane.sent.splice(index, 1);
      lane.socketQueuedBytes = Math.max(0, lane.socketQueuedBytes - failed.encodedBytes);
      scheduleFallback(lane, 'transport-send-failed');
    },

    downgrade(input: { connectionEpoch: string; sessionId: string; reason: string }): void {
      const lane = lanes.get(fairLaneKey(input.connectionEpoch, input.sessionId));
      if (lane) releaseLane(lane);
    },

    closeConnection(connectionEpoch: string): void {
      for (const lane of lanes.values()) if (lane.connectionEpoch === connectionEpoch) releaseLane(lane, true);
    },

    terminateSession(input: { connectionEpoch: string; sessionId: string }): void {
      const lane = lanes.get(fairLaneKey(input.connectionEpoch, input.sessionId));
      if (lane) releaseLane(lane);
    },

    rollbackConnection(connectionEpoch: string): void {
      for (const lane of lanes.values()) if (lane.connectionEpoch === connectionEpoch) releaseLane(lane);
    },

    snapshot() {
      const activeLanes = [...lanes.values()].filter(lane => !lane.released);
      const laneSnapshots = Object.fromEntries(activeLanes.map(lane => [lane.key, {
        queuedBytes: lane.queuedBytes,
        socketQueuedBytes: lane.socketQueuedBytes,
        creditBytes: lane.creditBytes,
        sentDeliverySeqs: lane.sent.map(delivery => delivery.deliverySeq),
      }]));
      const metricLanes = Object.fromEntries(activeLanes.map(lane => [lane.key, {
        enqueueToFirstServiceMs: percentileMatrix(lane.firstServiceLatencies),
        enqueueToCompleteMs: percentileMatrix(lane.completeLatencies),
        maxNoServiceIntervalMs: lane.maximumNoServiceIntervalMs,
        peakApplicationQueuedBytes: lane.peakApplicationQueuedBytes,
        peakSocketQueuedBytes: lane.peakSocketQueuedBytes,
      }]));
      const fallback = Object.fromEntries([...lanes.values()]
        .filter(lane => lane.fallback)
        .map(lane => [lane.key, lane.fallback]));
      return {
        lanes: laneSnapshots,
        metrics: {
          lanes: metricLanes,
          controlLatency: percentileMatrix(controlLatencies),
          aggregateThroughputBytesPerSecond: totalSentBytes * 1000 / Math.max(1, options.now() - startedAt),
        },
        policy: options.policy,
        protocolErrors: [...protocolErrors],
        semanticStatusMutationCount: 0,
        fallback,
        cleanup: {
          timers: activeLanes.filter(lane => lane.sent.length > 0).length,
          heldBytes: activeLanes.reduce((total, lane) => total + lane.queuedBytes + lane.socketQueuedBytes, 0),
          ledgers: activeLanes.filter(lane => lane.sent.length > 0).length,
          queues: activeLanes.filter(lane => lane.queue.length > 0).length,
          releases: { ...releases },
        },
      };
    },

    decision() {
      const state = decisionState(options.decisionArtifact);
      return {
        artifactPath: FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR,
        artifactSchemaVersion: 'fair-scheduler-decision/v1',
        artifactState: options.decisionArtifact.state,
        workloadSchemaHash: 'policy-derived-workload',
        configHash: 'policy-derived-config',
        baseline: 'fifo',
        candidate: options.policy.strategy.value,
        sampleCount: 1,
        rawEvidencePaths: ['pending-measured-artifact'],
        thresholds: { eligibleLaneService: { exact: options.policy.ackTimeoutMs.value, tolerance: 0, source: options.policy.ackTimeoutMs.source } },
        accepted: state.accepted,
        promotionAllowed: state.accepted,
        allRegisteredThresholdsPassed: options.decisionArtifact.allRegisteredThresholdsPassed,
        hasUnboundedEligibleLaneStarvation: options.decisionArtifact.hasUnboundedEligibleLaneStarvation,
        benchmarkContractSource: options.policy.strategy.source,
        reason: state.reason,
      };
    },
  };
}

function compactIfNeeded(state: WsTransportQueueState, lane: 'control' | 'terminal'): void {
  if (lane === 'control') {
    if (state.controlHead > 32 && state.controlHead * 2 >= state.controlItems.length) {
      state.controlItems = state.controlItems.slice(state.controlHead);
      state.controlHead = 0;
    }
    return;
  }

  if (state.terminalHead > 32 && state.terminalHead * 2 >= state.terminalItems.length) {
    state.terminalItems = state.terminalItems.slice(state.terminalHead);
    state.terminalHead = 0;
  }
}
