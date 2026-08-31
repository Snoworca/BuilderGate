import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as terminalOutputSchedulerModule from '../../src/utils/terminalOutputScheduler.ts';

type WriteKind = 'live' | 'checkpoint' | 'repair' | 'parser-tail';

type CoordinatorAdapter = {
  write(command: { kind: WriteKind; data: string | Uint8Array }, onWritten: () => void): void;
  probeWritePipeline?(onWritten: () => void): void;
  resetParser(): void;
  resize(cols: number, rows: number): void;
  applyModes(modes: Readonly<Record<string, boolean>>): void;
  clearScreen(): void;
  fit(): Readonly<{ cols: number; rows: number }>;
  setWindowsPty(value: unknown): void;
  markReady(viewGeneration: number): void;
  releaseInput(data: string): void;
  settleInput(token: string, outcome: 'released' | 'rejected' | 'superseded' | 'disposed' | 'expired'): void;
  requestFreshRecovery(reason: string): void;
  requestRuntimeRecreation(reason: string): void;
  compatibilityRecoveryDrained(viewGeneration: number): void;
  checkpointApplied(metadata: CheckpointLifecycleMetadata): void;
  checkpointDrained(metadata: CheckpointLifecycleMetadata): void;
  settle(token: string, outcome: 'written' | 'superseded' | 'disposed' | 'failed'): void;
};

type CheckpointLifecycleMetadata = {
  viewGeneration: number;
  streamEpoch: string;
  checkpointEpoch: string;
  sourceSeq: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  retentionPolicyId: string;
  chunkCount: number;
  encodedByteTotal: number;
  digest: string;
};

type CoordinatorOptions = {
  viewGeneration: number;
  adapter: CoordinatorAdapter;
  digestBytes(bytes: Uint8Array): string;
  timeoutMs?: number;
  writeStallCheckMs?: number;
  checkpointWriteSliceBytes?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  postCheckpointMaxBytes?: number;
  postCheckpointMaxChunks?: number;
  checkpointMaxBytes?: number;
  checkpointMaxChunks?: number;
  pendingInputMaxBytes?: number;
  pendingInputMaxCount?: number;
  pendingInputTtlMs?: number;
  settlementLedgerMaxEntries?: number;
  inputSettlementLedgerMaxEntries?: number;
  settlementLedgerTtlMs?: number;
  now?: () => number;
};

type CoordinatorCommand =
  | { type: 'live'; streamEpoch: unknown; sourceSeq: unknown; viewGeneration: number; data: Uint8Array; settlementToken: string }
  | { type: 'checkpoint-begin'; streamEpoch: unknown; checkpointEpoch: unknown; sourceSeq: unknown; snapshotSeq: unknown; oldestRetainedSeq: unknown; retentionPolicyId: unknown; viewGeneration: number; chunkCount: number; encodedByteTotal: number; digest: string; cols: number; rows: number; modes: Readonly<Record<string, boolean>>; parserTail: Uint8Array }
  | { type: 'checkpoint-chunk'; streamEpoch: unknown; checkpointEpoch: unknown; sourceSeq: unknown; snapshotSeq: unknown; oldestRetainedSeq: unknown; retentionPolicyId: unknown; viewGeneration: number; chunkCount: number; encodedByteTotal: number; digest: string; index: number; count: number; data: Uint8Array }
  | { type: 'checkpoint-commit'; streamEpoch: unknown; checkpointEpoch: unknown; sourceSeq: unknown; snapshotSeq: unknown; oldestRetainedSeq: unknown; retentionPolicyId: unknown; viewGeneration: number; chunkCount: number; encodedByteTotal: number; digest: string }
  | { type: 'repair'; streamEpoch: unknown; sourceSeq: unknown; viewGeneration: number; data: Uint8Array; settlementToken: string }
  | { type: 'queue-input'; viewGeneration: number; data: string; settlementToken: string }
  | { type: 'install-recovery-generation'; viewGeneration: number; streamEpoch: unknown; checkpointEpoch: unknown }
  | { type: 'recovery-failed'; viewGeneration: number; reason: string }
  | { type: 'install-rollback-checkpoint-boundary'; viewGeneration: number; streamEpoch: unknown; checkpointEpoch: unknown; reason: string }
  | { type: 'supersede'; viewGeneration: number }
  | { type: 'rollback-to-compatibility'; viewGeneration: number; reason: string }
  | { type: 'install-compatibility-recovery-generation'; viewGeneration: number; reason: string }
  | { type: 'complete-compatibility-recovery'; viewGeneration: number }
  | { type: 'dispose'; viewGeneration: number };

type CoordinatorResult = { accepted: boolean; reason?: string };
type CoordinatorState = {
  viewGeneration: number;
  ready: boolean;
  disposed: boolean;
  writeInFlight: boolean;
  pendingCommands: number;
  pendingInputs: number;
  pendingInputBytes: number;
  settlementLedgerEntries: number;
  inputSettlementLedgerEntries: number;
  recoveryRequired: boolean;
  compatibilityRecoveryPending: boolean;
  runtimeRecreationRequired: boolean;
};
type TerminalWriteCoordinator = {
  dispatch(command: CoordinatorCommand): CoordinatorResult;
  submitCompatibility(command: {
    type: 'write' | 'reset' | 'clear' | 'resize' | 'fit' | 'set-windows-pty';
    viewGeneration: number;
    kind?: WriteKind;
    data?: string | Uint8Array;
    cols?: number;
    rows?: number;
    value?: unknown;
    onWritten?: () => void;
    onApplied?: () => void;
    onRejected?: (reason: string) => void;
  }): CoordinatorResult;
  getState(): Readonly<CoordinatorState>;
};
type CoordinatorFactory = (options: CoordinatorOptions) => TerminalWriteCoordinator;

const encoder = new TextEncoder();
const BOUNDED_COORDINATOR_LIMITS = Object.freeze({
  postCheckpointMaxBytes: 1024 * 1024,
  postCheckpointMaxChunks: 1024,
  pendingInputMaxBytes: 1024 * 1024,
  pendingInputMaxCount: 1024,
  pendingInputTtlMs: 60_000,
  settlementLedgerMaxEntries: 1024,
  settlementLedgerTtlMs: 60_000,
});

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requireCoordinatorFactory(signature: string): CoordinatorFactory {
  const factory = (terminalOutputSchedulerModule as Record<string, unknown>)
    .createTerminalWriteCoordinator;
  assert.equal(typeof factory, 'function', signature);
  return factory as CoordinatorFactory;
}

function createRecordingAdapter() {
  const writes: Array<{ kind: WriteKind; data: string | Uint8Array; onWritten: () => void }> = [];
  const events: string[] = [];
  const ready: number[] = [];
  const releasedInput: string[] = [];
  const recoveries: string[] = [];
  const recreationRequests: string[] = [];
  const compatibilityDrains: number[] = [];
  const settlements: Array<{ token: string; outcome: string }> = [];
  const inputSettlements: Array<{ token: string; outcome: string }> = [];
  const checkpointApplied: CheckpointLifecycleMetadata[] = [];
  const checkpointDrained: CheckpointLifecycleMetadata[] = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const adapter: CoordinatorAdapter = {
    write: (command, onWritten) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      events.push(command.kind);
      writes.push({
        kind: command.kind,
        data: typeof command.data === 'string' ? command.data : command.data.slice(),
        onWritten: () => {
          activeWrites -= 1;
          onWritten();
        },
      });
    },
    resetParser: () => { events.push('reset'); },
    resize: (cols, rows) => { events.push(`resize:${cols}x${rows}`); },
    applyModes: () => { events.push('modes'); },
    clearScreen: () => { events.push('clear'); },
    fit: () => { events.push('fit'); return { cols: 120, rows: 40 }; },
    setWindowsPty: () => { events.push('windows-pty'); },
    markReady: generation => { ready.push(generation); },
    releaseInput: data => { releasedInput.push(data); },
    settleInput: (token, outcome) => { inputSettlements.push({ token, outcome }); },
    requestFreshRecovery: reason => { recoveries.push(reason); },
    requestRuntimeRecreation: reason => { recreationRequests.push(reason); },
    compatibilityRecoveryDrained: generation => { compatibilityDrains.push(generation); },
    checkpointApplied: metadata => { checkpointApplied.push(metadata); },
    checkpointDrained: metadata => { checkpointDrained.push(metadata); },
    settle: (token, outcome) => { settlements.push({ token, outcome }); },
  };
  return {
    adapter,
    writes,
    events,
    ready,
    releasedInput,
    recoveries,
    recreationRequests,
    compatibilityDrains,
    settlements,
    inputSettlements,
    checkpointApplied,
    checkpointDrained,
    get maximumActiveWrites() { return maximumActiveWrites; },
  };
}

function createCoordinator(signature: string) {
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  return { coordinator, recording };
}

function createManualTimer() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    setTimer(callback: () => void) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimer(handle: unknown) {
      if (typeof handle === 'number') callbacks.delete(handle);
    },
    fireNext() {
      const next = callbacks.entries().next().value as [number, () => void] | undefined;
      assert.ok(next, 'expected a pending coordinator timer');
      callbacks.delete(next[0]);
      next[1]();
    },
    get pendingCount() { return callbacks.size; },
  };
}

function checkpointCommands(body: Uint8Array, overrides: Partial<Extract<CoordinatorCommand, { type: 'checkpoint-begin' }>> = {}) {
  const begin: Extract<CoordinatorCommand, { type: 'checkpoint-begin' }> = {
    type: 'checkpoint-begin',
    streamEpoch: '1',
    checkpointEpoch: '1',
    sourceSeq: overrides.sourceSeq ?? overrides.snapshotSeq ?? '10',
    snapshotSeq: overrides.snapshotSeq ?? '10',
    oldestRetainedSeq: '1',
    retentionPolicyId: 'retained-state-v1',
    viewGeneration: 7,
    chunkCount: 1,
    encodedByteTotal: body.byteLength,
    digest: fnv1a64(body),
    cols: 120,
    rows: 40,
    modes: { wraparoundMode: true },
    parserTail: encoder.encode('\x1b['),
    ...overrides,
  };
  return {
    begin,
    chunk: {
      type: 'checkpoint-chunk', streamEpoch: begin.streamEpoch,
      checkpointEpoch: begin.checkpointEpoch, sourceSeq: begin.sourceSeq,
      snapshotSeq: begin.snapshotSeq, oldestRetainedSeq: begin.oldestRetainedSeq,
      retentionPolicyId: begin.retentionPolicyId, viewGeneration: begin.viewGeneration,
      chunkCount: begin.chunkCount, encodedByteTotal: begin.encodedByteTotal, digest: begin.digest,
      index: 0, count: begin.chunkCount, data: body,
    } as const,
    commit: {
      type: 'checkpoint-commit', streamEpoch: begin.streamEpoch,
      checkpointEpoch: begin.checkpointEpoch, sourceSeq: begin.sourceSeq,
      snapshotSeq: begin.snapshotSeq, oldestRetainedSeq: begin.oldestRetainedSeq,
      retentionPolicyId: begin.retentionPolicyId, viewGeneration: begin.viewGeneration,
      chunkCount: begin.chunkCount, encodedByteTotal: begin.encodedByteTotal, digest: begin.digest,
    } as const,
  };
}

function assertFreshGenerationCheckpointAccepted(
  coordinator: TerminalWriteCoordinator,
  signature: string,
): void {
  const fresh = checkpointCommands(encoder.encode('fresh-generation'), {
    viewGeneration: 8,
    streamEpoch: '2',
    checkpointEpoch: '1',
    snapshotSeq: '1',
  });
  assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
  coordinator.dispatch({ type: 'dispose', viewGeneration: 8 });
}

function installRecoveryGeneration(
  coordinator: TerminalWriteCoordinator,
  viewGeneration = 8,
  streamEpoch = '2',
  checkpointEpoch = '1',
): void {
  assert.equal(coordinator.dispatch({
    type: 'install-recovery-generation',
    viewGeneration,
    streamEpoch,
    checkpointEpoch,
  }).accepted, true);
}

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-1', () => {
  const signature = 'FR-BGSTAB-022 AC-1 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('checkpoint'));
  coordinator.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: '9', viewGeneration: 7, data: encoder.encode('live-before'), settlementToken: 'live-9' });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  coordinator.dispatch({ type: 'repair', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7, data: encoder.encode('repair-after'), settlementToken: 'repair-11' });
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.events, ['live', 'reset', 'resize:120x40', 'modes', 'checkpoint', 'parser-tail', 'repair'], signature);
});

test('MIG-BGSTAB-002 large checkpoint body is parse-paced in bounded physical slices', () => {
  const signature = 'one retained-state write monopolized or falsely stalled the xterm parser';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    checkpointWriteSliceBytes: 4,
  });
  const checkpoint = checkpointCommands(encoder.encode('abcdefghij'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);

  const checkpointSlices: string[] = [];
  while (recording.writes.length > 0) {
    const write = recording.writes.shift()!;
    if (write.kind === 'checkpoint') {
      checkpointSlices.push(new TextDecoder().decode(write.data as Uint8Array));
    }
    write.onWritten();
  }

  assert.deepEqual(
    recording.events,
    ['reset', 'resize:120x40', 'modes', 'checkpoint', 'checkpoint', 'checkpoint', 'parser-tail'],
    signature,
  );
  assert.deepEqual(checkpointSlices, ['abcd', 'efgh', 'ij'], signature);
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.maximumActiveWrites, 1, signature);
});

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-2', () => {
  const signature = 'FR-BGSTAB-022 AC-2 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  for (let seq = 1; seq <= 3; seq += 1) {
    coordinator.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: String(seq), viewGeneration: 7, data: encoder.encode(String(seq)), settlementToken: `live-${seq}` });
  }
  assert.equal(recording.writes.length, 1, signature);
  recording.writes[0]?.onWritten();
  assert.equal(recording.writes.length, 2, signature);
  recording.writes[1]?.onWritten();
  recording.writes[2]?.onWritten();
  assert.equal(recording.maximumActiveWrites, 1, signature);
});

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-3', () => {
  const signature = 'FR-BGSTAB-022 AC-3 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  const body = concatBytes([encoder.encode('한글'), encoder.encode('😀')]);
  const checkpoint = checkpointCommands(body);
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.deepEqual(recording.events.slice(0, 4), ['reset', 'resize:120x40', 'modes', 'checkpoint'], signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(recording.events.at(-1), 'parser-tail', signature);
});

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-4', () => {
  const signature = 'FR-BGSTAB-022 AC-4 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const faults = [
    { label: 'duplicate', chunks: [0, 0] },
    { label: 'missing', chunks: [0] },
    { label: 'out-of-order', chunks: [1, 0] },
  ];
  for (const fault of faults) {
    const { coordinator, recording } = createCoordinator(signature);
    const body = encoder.encode('ab');
    const checkpoint = checkpointCommands(body, { chunkCount: 2 });
    coordinator.dispatch(checkpoint.begin);
    for (const index of fault.chunks) {
      coordinator.dispatch({ ...checkpoint.chunk, index, count: 2, data: encoder.encode(index === 0 ? 'a' : 'b') });
    }
    const result = coordinator.dispatch(checkpoint.commit);
    assert.equal(result.accepted, false, `${signature}: ${fault.label}`);
    assert.equal(recording.recoveries.length, 1, `${signature}: ${fault.label}`);
    assert.equal(coordinator.getState().ready, false, `${signature}: ${fault.label}`);
  }
});

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-5', () => {
  const signature = 'FR-BGSTAB-022 AC-5 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'blocked-input', settlementToken: 'input-blocked' });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  coordinator.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7, data: encoder.encode('tail'), settlementToken: 'tail-11' });
  assert.deepEqual({ ready: recording.ready, input: recording.releasedInput }, { ready: [], input: [] }, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.deepEqual({ ready: recording.ready, input: recording.releasedInput }, { ready: [7], input: ['blocked-input'] }, signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-blocked', outcome: 'released' },
  ], signature);
});

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-6', () => {
  const signature = 'FR-BGSTAB-022 AC-6 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  coordinator.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7, data: encoder.encode('in-flight'), settlementToken: 'in-flight' });
  coordinator.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: '2', viewGeneration: 7, data: encoder.encode('queued'), settlementToken: 'queued' });
  coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'queued-input', settlementToken: 'input-queued' });
  coordinator.dispatch({ type: 'supersede', viewGeneration: 8 });
  recording.writes[0]?.onWritten();
  coordinator.dispatch({ type: 'dispose', viewGeneration: 8 });
  assert.deepEqual(recording.settlements, [
    { token: 'queued', outcome: 'superseded' },
    { token: 'in-flight', outcome: 'superseded' },
  ], signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-queued', outcome: 'superseded' },
  ], signature);
  assert.equal(recording.releasedInput.length, 0, signature);
});

test('Browser TerminalWriteCoordinator sole writer RED contract — FR-BGSTAB-022 AC-7', () => {
  const signature = 'FR-BGSTAB-022 AC-7 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator } = createCoordinator(signature);
  const state = coordinator.getState() as Record<string, unknown>;
  for (const presentationKey of ['label', 'icon', 'layout', 'keyboardOwner', 'pasteOwner', 'terminalStatus']) {
    assert.equal(Object.hasOwn(state, presentationKey), false, signature);
  }
});

test('Browser TerminalWriteCoordinator sole writer RED contract — REL-BGSTAB-007 AC-4', () => {
  const signature = 'REL-BGSTAB-007 AC-4 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  for (const ordinal of ['0', '1', '18446744073709551615']) {
    const { coordinator } = createCoordinator(signature);
    const result = coordinator.dispatch({ type: 'live', streamEpoch: ordinal, sourceSeq: ordinal, viewGeneration: 7, data: encoder.encode('x'), settlementToken: ordinal });
    assert.equal(result.accepted, true, `${signature}: ${ordinal}`);
  }
});

test('Browser TerminalWriteCoordinator sole writer RED contract — REL-BGSTAB-007 AC-5', () => {
  const signature = 'REL-BGSTAB-007 AC-5 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  assert.equal(recording.ready.length, 0, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.ready, [7], signature);
});

test('Browser TerminalWriteCoordinator sole writer RED contract — REL-BGSTAB-007 AC-8', () => {
  const signature = 'REL-BGSTAB-007 AC-8 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  const { coordinator, recording } = createCoordinator(signature);
  const provisional = coordinator.dispatch({ type: 'repair', streamEpoch: '0', sourceSeq: '1', viewGeneration: 7, data: encoder.encode('provisional-cache'), settlementToken: 'provisional' });
  assert.equal(provisional.accepted, true, signature);
  recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.ready, [], 'provisional browser data cannot make the view authoritative-ready');
});

test('Browser TerminalWriteCoordinator sole writer RED contract — REL-BGSTAB-007 AC-11', () => {
  const signature = 'REL-BGSTAB-007 AC-11 Browser TerminalWriteCoordinator sole writer 계약 부재 때문에 실패';
  requireCoordinatorFactory(signature);
  const files = [
    'src/components/Terminal/TerminalView.tsx',
    'src/components/Terminal/TerminalContainer.tsx',
  ];
  const forbidden = /(?:(?:\bterm|xtermRef\.current)\??\.(?:write|reset|resize|clear)\s*\(|(?:fitAddon|fitAddonRef\.current)\??\.fit\s*\(|\bterm\.options\.windowsPty\s*=)/g;
  const findings = files.flatMap(file => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(forbidden)].map(match => `${file}:${match.index}:${match[0]}`);
  });
  assert.deepEqual(findings, [], `${signature}: production xterm mutation must be coordinator-owned`);
});

test('REL_BGSTAB_007_AC4_rejects_json_number_noncanonical_and_out_of_range_ordinal64', () => {
  const signature = 'noncanonical JSON number or out-of-range Ordinal64 was accepted';
  const invalidOrdinals: unknown[] = [0, 1, -1, 1.5, '', '00', '+1', '-1', ' 1', '1 ', '01', '18446744073709551616'];
  for (const ordinal of invalidOrdinals) {
    const { coordinator, recording } = createCoordinator(signature);
    const result = coordinator.dispatch({ type: 'live', streamEpoch: '1', sourceSeq: ordinal, viewGeneration: 7, data: encoder.encode('x'), settlementToken: 'invalid' });
    assert.equal(result.accepted, false, `${signature}: ${JSON.stringify(ordinal)}`);
    assert.equal(recording.writes.length, 0, signature);
    assert.equal(recording.recoveries.length, 1, signature);
  }
});

test('REL_BGSTAB_007_AC4_rejects_epoch_rollover_at_2_pow_64', () => {
  const signature = 'epoch rollover at 2^64 did not fail closed and request fresh authority';
  const { coordinator, recording } = createCoordinator(signature);
  assert.equal(coordinator.dispatch({ type: 'live', streamEpoch: '9', sourceSeq: '18446744073709551615', viewGeneration: 7, data: encoder.encode('last'), settlementToken: 'last' }).accepted, true, signature);
  recording.writes.shift()?.onWritten();
  const rollover = coordinator.dispatch({ type: 'live', streamEpoch: '9', sourceSeq: '0', viewGeneration: 7, data: encoder.encode('wrapped'), settlementToken: 'wrapped' });
  assert.equal(rollover.accepted, false, signature);
  assert.equal(recording.recoveries.at(-1), 'ordinal64-rollover', signature);
});

test('static production inventory rejects every direct xterm mutation outside the sole writer', () => {
  const files = [
    'src/components/Terminal/TerminalView.tsx',
    'src/components/Terminal/TerminalContainer.tsx',
  ];
  const patterns = [
    /(?:\bterm|xtermRef\.current)\??\.(?:write|reset|resize|clear)\s*\(/g,
    /(?:fitAddon|fitAddonRef\.current)\??\.fit\s*\(/g,
    /\bterm\.options\.windowsPty\s*=/g,
  ];
  const findings = files.flatMap(file => {
    const source = readFileSync(file, 'utf8');
    return patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => ({ file, call: match[0] })));
  });
  assert.deepEqual(findings, [], 'production direct xterm writers remain outside TerminalWriteCoordinator');
  const adapterSource = readFileSync('src/utils/terminalRawMutationAdapter.ts', 'utf8');
  for (const rawOperation of ['terminal.write(', 'terminal.reset(', 'terminal.resize(', 'terminal.clear(', 'fitAddon.fit()', 'terminal.options.windowsPty =']) {
    assert.equal(adapterSource.includes(rawOperation), true, `raw mutation adapter is missing ${rawOperation}`);
  }
});

test('FR_BGSTAB_022_AC4_checkpoint_fault_latches_recovery_until_fresh_generation', () => {
  const signature = 'checkpoint fault did not latch generation-scoped recovery-required';
  const { coordinator, recording } = createCoordinator(signature);
  const bad = checkpointCommands(encoder.encode('bad'), { digest: 'wrong-digest' });
  coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'old-input', settlementToken: 'input-old' });
  assert.equal(coordinator.dispatch(bad.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(bad.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(bad.commit).accepted, false, signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-old', outcome: 'rejected' },
  ], signature);
  assert.equal(recording.recoveries.length, 1, signature);
  assert.equal(coordinator.getState().ready, false, signature);

  const blockedLive = coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('blocked'), settlementToken: 'blocked-live',
  });
  assert.deepEqual(blockedLive, { accepted: false, reason: 'recovery-required' }, signature);
  assert.deepEqual(recording.settlements.at(-1), { token: 'blocked-live', outcome: 'failed' }, signature);
  assert.equal(coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'blocked-input', settlementToken: 'input-blocked-after-fault' }).accepted, false, signature);
  assert.equal(coordinator.dispatch(bad.begin).reason, 'recovery-required', signature);

  installRecoveryGeneration(coordinator);
  const fresh = checkpointCommands(encoder.encode('fresh'), {
    viewGeneration: 8, streamEpoch: '2', sourceSeq: '1', snapshotSeq: '1', oldestRetainedSeq: '1',
  });
  assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(fresh.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(fresh.commit).accepted, true, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.ready, [8], signature);
  assert.deepEqual(recording.releasedInput, [], 'old-generation input escaped after supersede');
});

test('FR_BGSTAB_022_AC4_failed_open_checkpoint_does_not_deadlock_as_already_open', () => {
  const signature = 'failed checkpoint remained permanently open';
  const { coordinator } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('ab'), { chunkCount: 2 });
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch({ ...checkpoint.chunk, index: 1, count: 2 }).accepted, false, signature);
  const retry = coordinator.dispatch(checkpoint.begin);
  assert.deepEqual(retry, { accepted: false, reason: 'recovery-required' }, signature);
  installRecoveryGeneration(coordinator);
  const fresh = checkpointCommands(encoder.encode('fresh'), {
    viewGeneration: 8, streamEpoch: '2', sourceSeq: '1', snapshotSeq: '1', oldestRetainedSeq: '1',
  });
  assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
});

test('FR_BGSTAB_022_AC4_explicit_rollback_atomically_unlocks_legacy_snapshot_after_recovery', () => {
  const signature = 'recovery latch prevented atomic rollback to the legacy snapshot authority';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('checkpoint'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch({
    type: 'queue-input',
    viewGeneration: 7,
    data: 'must-not-escape',
    settlementToken: 'input-rollback',
  });
  coordinator.dispatch({
    type: 'recovery-failed',
    viewGeneration: 7,
    reason: 'checkpoint-wire-fault',
  });

  assert.equal(coordinator.getState().recoveryRequired, true, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'rollback-to-compatibility',
    viewGeneration: 8,
    reason: 'capability-withdrawn',
  }), { accepted: true }, signature);
  assert.deepEqual(coordinator.getState(), {
    viewGeneration: 8,
    ready: false,
    disposed: false,
    recoveryRequired: false,
    compatibilityRecoveryPending: true,
    runtimeRecreationRequired: false,
    writeInFlight: false,
    pendingCommands: 0,
    pendingInputs: 0,
    pendingInputBytes: 0,
    settlementLedgerEntries: 0,
    inputSettlementLedgerEntries: 1,
  }, signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-rollback', outcome: 'rejected' },
  ], 'recovery failure must settle the input before rollback without releasing its payload');
  assert.deepEqual(recording.releasedInput, [], signature);

  assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'repair', data: 'legacy-snapshot',
  }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'live', data: 'post-snapshot-output',
  }).accepted, true, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(coordinator.dispatch({
    type: 'complete-compatibility-recovery', viewGeneration: 8,
  }).accepted, true, signature);
  assert.deepEqual(recording.events, ['reset', 'repair', 'live'], signature);
});

test('FR_BGSTAB_022_AC5_dispose_observably_settles_accepted_input_without_release', () => {
  const signature = 'dispose silently deleted accepted checkpoint input';
  const { coordinator, recording } = createCoordinator(signature);
  assert.equal(coordinator.dispatch({
    type: 'queue-input', viewGeneration: 7, data: 'secret', settlementToken: 'input-dispose',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch({ type: 'dispose', viewGeneration: 7 }).accepted, true, signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-dispose', outcome: 'disposed' },
  ], signature);
  assert.deepEqual(recording.releasedInput, [], signature);
  assert.equal(JSON.stringify(recording.inputSettlements).includes('secret'), false, 'settlement exposed input payload');
});

test('FR_BGSTAB_022_AC5_downstream_input_rejection_is_settled_once_without_payload', () => {
  const signature = 'failed downstream input release was reported as released or silently lost';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: {
      ...recording.adapter,
      releaseInput: () => { throw new Error('downstream rejected'); },
    },
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  const checkpoint = checkpointCommands(encoder.encode('ready'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();

  assert.deepEqual(coordinator.dispatch({
    type: 'queue-input', viewGeneration: 7, data: 'private', settlementToken: 'input-rejected',
  }), { accepted: false, reason: 'adapter-release-input-failed' }, signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-rejected', outcome: 'rejected' },
  ], signature);
  assert.equal(JSON.stringify(recording.inputSettlements).includes('private'), false, signature);
  assert.equal(recording.recoveries.at(-1), 'adapter-release-input-failed', signature);
});

test('FR_BGSTAB_022_AC6_late_pre_rollback_write_callback_cannot_double_settle_or_mutate_legacy', () => {
  const signature = 'late checkpoint-era callback crossed the rollback generation fence';
  const { coordinator, recording } = createCoordinator(signature);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('old-live'), settlementToken: 'old-live',
  });
  coordinator.dispatch({
    type: 'queue-input', viewGeneration: 7, data: 'old-input', settlementToken: 'old-input',
  });
  const lateWritten = recording.writes[0]!.onWritten;

  assert.equal(coordinator.dispatch({
    type: 'rollback-to-compatibility', viewGeneration: 8, reason: 'operator-rollback',
  }).accepted, true, signature);
  assert.deepEqual(recording.settlements, [{ token: 'old-live', outcome: 'superseded' }], signature);
  assert.deepEqual(recording.inputSettlements, [{ token: 'old-input', outcome: 'superseded' }], signature);
  lateWritten();
  assert.deepEqual(recording.settlements, [{ token: 'old-live', outcome: 'superseded' }], signature);
  assert.deepEqual(recording.inputSettlements, [{ token: 'old-input', outcome: 'superseded' }], signature);
  assert.equal(coordinator.getState().viewGeneration, 8, signature);
  assert.equal(coordinator.getState().recoveryRequired, false, signature);
});

test('FR_BGSTAB_022_AC6_rollback_keeps_physical_write_ownership_until_old_callback_drains', () => {
  const signature = 'rollback submitted a reset/snapshot while an old xterm write was physically in flight';
  const { coordinator, recording } = createCoordinator(signature);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('old-live'), settlementToken: 'old-physical',
  });
  const lateWritten = recording.writes[0]!.onWritten;
  assert.equal(coordinator.dispatch({
    type: 'rollback-to-compatibility', viewGeneration: 8, reason: 'capability-withdrawn',
  }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'repair', data: 'fresh-legacy-snapshot',
  }).accepted, true, signature);

  assert.deepEqual(recording.events, ['live'], signature);
  assert.equal(coordinator.getState().writeInFlight, true, signature);
  lateWritten();
  while (recording.writes.length > 1) recording.writes.splice(1, 1)[0]?.onWritten();
  assert.deepEqual(recording.events, ['live', 'reset', 'repair'], signature);
});

test('MIG-BGSTAB-002 repeated rollback boundary supersedes an open checkpoint in the same view generation', () => {
  const signature = 'a replacement rollback checkpoint was rejected behind the previous open transaction';
  const { coordinator, recording } = createCoordinator(signature);
  const first = checkpointCommands(encoder.encode('stale-checkpoint'), {
    streamEpoch: '3',
    checkpointEpoch: '4',
    sourceSeq: '12',
    snapshotSeq: '10',
  });
  assert.equal(coordinator.dispatch(first.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(first.chunk).accepted, true, signature);

  assert.deepEqual(coordinator.dispatch({
    type: 'install-rollback-checkpoint-boundary',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
    reason: 'responder-topology-changed-during-recovery',
  }), { accepted: true }, signature);

  const replacement = checkpointCommands(encoder.encode('fresh-compatibility'), {
    streamEpoch: '4',
    checkpointEpoch: '5',
    sourceSeq: '13',
    snapshotSeq: '13',
  });
  assert.equal(coordinator.dispatch(replacement.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(replacement.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(replacement.commit).accepted, true, signature);

  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(coordinator.getState().recoveryRequired, false, signature);
  assert.equal(recording.recoveries.includes('checkpoint-already-open'), false, signature);
  assert.equal(recording.events.includes('checkpoint'), true, signature);
});

test('FR_BGSTAB_022_AC4_rollback_write_timeout_requires_runtime_recreation_and_rejects_snapshot', () => {
  const signature = 'untrusted timed-out xterm was reused for a legacy snapshot';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('wedged'), settlementToken: 'wedged-write',
  });
  coordinator.dispatch({
    type: 'rollback-to-compatibility', viewGeneration: 8, reason: 'capability-withdrawn',
  });
  let resetRejected = '';
  coordinator.submitCompatibility({
    type: 'reset', viewGeneration: 8, onRejected: reason => { resetRejected = reason; },
  });
  timer.fireNext();

  assert.equal(coordinator.getState().runtimeRecreationRequired, true, signature);
  assert.equal(coordinator.getState().writeInFlight, false, signature);
  assert.deepEqual(recording.recreationRequests, ['terminal-write-timeout'], signature);
  assert.equal(resetRejected, 'runtime-recreation-required', signature);
  assert.deepEqual(recording.events, ['live'], signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'install-compatibility-recovery-generation', viewGeneration: 9, reason: 'repair',
  }), { accepted: false, reason: 'runtime-recreation-required' }, signature);
});

test('MIG-BGSTAB-002 slow xterm write is probe-certified before runtime recreation', () => {
  const signature = 'a slow but live xterm write was mistaken for a dead pipeline';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const probes: Array<() => void> = [];
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: {
      ...recording.adapter,
      probeWritePipeline: onWritten => { probes.push(onWritten); },
    },
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    writeStallCheckMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('slow-write'), settlementToken: 'slow-write',
  });

  timer.fireNext();
  assert.equal(probes.length, 1, signature);
  assert.equal(coordinator.getState().runtimeRecreationRequired, false, signature);
  recording.writes[0]!.onWritten();
  probes[0]!();

  assert.deepEqual(recording.recreationRequests, [], signature);
  assert.deepEqual(recording.settlements, [{ token: 'slow-write', outcome: 'written' }], signature);
  assert.equal(coordinator.getState().writeInFlight, false, signature);
});

test('MIG-BGSTAB-002 silent xterm write and silent FIFO probe certify runtime recreation', () => {
  const signature = 'a dead xterm pipeline escaped bounded FIFO probe certification';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const probes: Array<() => void> = [];
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: {
      ...recording.adapter,
      probeWritePipeline: onWritten => { probes.push(onWritten); },
    },
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    writeStallCheckMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('wedged-write'), settlementToken: 'wedged-write',
  });

  timer.fireNext();
  assert.equal(probes.length, 1, signature);
  assert.equal(coordinator.getState().runtimeRecreationRequired, false, signature);
  timer.fireNext();

  assert.deepEqual(recording.recreationRequests, ['terminal-write-pipeline-stalled'], signature);
  assert.equal(coordinator.getState().runtimeRecreationRequired, true, signature);
  assert.equal(coordinator.getState().writeInFlight, false, signature);
});

test('FR_BGSTAB_022_AC6_recovery_install_keeps_old_physical_write_until_callback', () => {
  const signature = 'fresh checkpoint write overlapped a pre-recovery physical xterm write';
  const { coordinator, recording } = createCoordinator(signature);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('old-live'), settlementToken: 'old-recovery-physical',
  });
  const oldWritten = recording.writes[0]!.onWritten;
  assert.deepEqual(coordinator.dispatch({
    type: 'recovery-failed', viewGeneration: 7, reason: 'protocol-fault',
  }), { accepted: false, reason: 'protocol-fault' }, signature);
  assert.equal(coordinator.getState().writeInFlight, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'install-recovery-generation',
    viewGeneration: 8,
    streamEpoch: '2',
    checkpointEpoch: '1',
  }).accepted, true, signature);
  const fresh = checkpointCommands(encoder.encode('fresh-after-recovery'), {
    viewGeneration: 8,
    streamEpoch: '2',
    checkpointEpoch: '1',
    sourceSeq: '1',
    snapshotSeq: '1',
  });
  assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(fresh.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(fresh.commit).accepted, true, signature);
  assert.equal(recording.writes.length, 1, signature);

  oldWritten();
  assert.equal(recording.writes.length, 2, signature);
  while (recording.writes.length > 1) recording.writes.splice(1, 1)[0]?.onWritten();
  assert.equal(recording.maximumActiveWrites, 1, signature);
  assert.equal(coordinator.getState().viewGeneration, 8, signature);
});

test('FR_BGSTAB_022_AC6_supersede_keeps_old_physical_write_until_callback', () => {
  const signature = 'supersede reset a reused xterm before the previous physical write drained';
  const { coordinator, recording } = createCoordinator(signature);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('old-live'), settlementToken: 'old-supersede-physical',
  });
  const oldWritten = recording.writes[0]!.onWritten;
  assert.equal(coordinator.dispatch({ type: 'supersede', viewGeneration: 8 }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'repair', data: 'fresh-after-supersede',
  }).accepted, true, signature);
  assert.deepEqual(recording.events, ['live'], signature);
  assert.equal(coordinator.getState().writeInFlight, true, signature);

  oldWritten();
  while (recording.writes.length > 1) recording.writes.splice(1, 1)[0]?.onWritten();
  assert.deepEqual(recording.events, ['live', 'reset', 'repair'], signature);
  assert.equal(recording.maximumActiveWrites, 1, signature);
});

test('FR_BGSTAB_022_AC4_transition_timeout_recreates_runtime_instead_of_reusing_xterm', () => {
  const cases = ['recovery-install', 'supersede'] as const;
  for (const transition of cases) {
    const signature = `${transition} timeout reused an xterm with unknown physical write ownership`;
    const recording = createRecordingAdapter();
    const timer = createManualTimer();
    const coordinator = requireCoordinatorFactory(signature)({
      viewGeneration: 7,
      adapter: recording.adapter,
      digestBytes: fnv1a64,
      ...BOUNDED_COORDINATOR_LIMITS,
      timeoutMs: 1,
      setTimer: callback => timer.setTimer(callback),
      clearTimer: handle => timer.clearTimer(handle),
    });
    coordinator.dispatch({
      type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
      data: encoder.encode('wedged'), settlementToken: `wedged-${transition}`,
    });
    if (transition === 'recovery-install') {
      coordinator.dispatch({ type: 'recovery-failed', viewGeneration: 7, reason: 'protocol-fault' });
      assert.equal(coordinator.dispatch({
        type: 'install-recovery-generation',
        viewGeneration: 8,
        streamEpoch: '2',
        checkpointEpoch: '1',
      }).accepted, true, signature);
      const fresh = checkpointCommands(encoder.encode('fresh-after-timeout'), {
        viewGeneration: 8,
        streamEpoch: '2',
        checkpointEpoch: '1',
        sourceSeq: '1',
        snapshotSeq: '1',
      });
      assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
      assert.equal(coordinator.dispatch(fresh.chunk).accepted, true, signature);
      assert.equal(coordinator.dispatch(fresh.commit).accepted, true, signature);
    } else {
      assert.equal(coordinator.dispatch({ type: 'supersede', viewGeneration: 8 }).accepted, true, signature);
      assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true, signature);
    }
    timer.fireNext();
    assert.equal(coordinator.getState().runtimeRecreationRequired, true, signature);
    assert.equal(coordinator.getState().writeInFlight, false, signature);
    assert.deepEqual(recording.recreationRequests, ['terminal-write-timeout'], signature);
    assert.deepEqual(recording.events, ['live'], signature);
  }
});

test('FR_BGSTAB_022_AC4_legacy_error_installs_higher_ordered_compatibility_recovery', () => {
  const signature = 'legacy mutation failure could not admit a higher-generation repair snapshot';
  const recording = createRecordingAdapter();
  let failFirstWrite = true;
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: {
      ...recording.adapter,
      write: (command, callback) => {
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error('synchronous write rejection');
        }
        recording.adapter.write(command, callback);
      },
    },
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 7, kind: 'live', data: 'fault',
  }).accepted, true, signature);
  assert.equal(coordinator.getState().recoveryRequired, true, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'install-compatibility-recovery-generation', viewGeneration: 7, reason: 'legacy-write-failed',
  }), { accepted: false, reason: 'stale-view-generation' }, signature);
  assert.equal(coordinator.dispatch({
    type: 'install-compatibility-recovery-generation', viewGeneration: 8, reason: 'legacy-write-failed',
  }).accepted, true, signature);
  assert.equal(coordinator.getState().recoveryRequired, false, signature);
  assert.equal(coordinator.getState().compatibilityRecoveryPending, true, signature);
  assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'repair', data: 'fresh-snapshot',
  }).accepted, true, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(coordinator.dispatch({
    type: 'complete-compatibility-recovery', viewGeneration: 8,
  }).accepted, true, signature);
  assert.equal(coordinator.getState().compatibilityRecoveryPending, false, signature);
  assert.deepEqual(recording.compatibilityDrains, [8], signature);
});

test('FR_BGSTAB_022_AC6_compatibility_completion_reentrancy_cannot_open_input_over_a_new_write', () => {
  const signature = 'compatibility drain observer queued a physical write while recovery was declared complete';
  const recording = createRecordingAdapter();
  const coordinatorRef: { current: TerminalWriteCoordinator | null } = { current: null };
  let injectReentrantWrite = true;
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: {
      ...recording.adapter,
      compatibilityRecoveryDrained: (generation) => {
        recording.adapter.compatibilityRecoveryDrained(generation);
        if (!injectReentrantWrite) return;
        injectReentrantWrite = false;
        coordinatorRef.current!.submitCompatibility({
          type: 'write',
          viewGeneration: generation,
          kind: 'live',
          data: 'reentrant-after-drain-observer',
        });
      },
    },
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  coordinatorRef.current = coordinator;
  assert.equal(coordinator.dispatch({
    type: 'rollback-to-compatibility', viewGeneration: 8, reason: 'capability-withdrawn',
  }).accepted, true, signature);
  assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true, signature);

  assert.deepEqual(coordinator.dispatch({
    type: 'complete-compatibility-recovery', viewGeneration: 8,
  }), {
    accepted: false,
    reason: 'compatibility-recovery-drain-pending',
  }, signature);
  assert.equal(coordinator.getState().compatibilityRecoveryPending, true, signature);
  assert.equal(coordinator.getState().writeInFlight, true, signature);

  recording.writes.at(-1)?.onWritten();
  assert.equal(coordinator.dispatch({
    type: 'complete-compatibility-recovery', viewGeneration: 8,
  }).accepted, true, signature);
  assert.equal(coordinator.getState().compatibilityRecoveryPending, false, signature);
});

test('FR_BGSTAB_022_AC4_missing_write_callback_requires_runtime_recreation', () => {
  const signature = 'lost xterm callback allowed the same parser runtime to be reused';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('lost'), settlementToken: 'lost-write',
  });
  timer.fireNext();
  assert.deepEqual(recording.settlements, [{ token: 'lost-write', outcome: 'failed' }], signature);
  assert.deepEqual(recording.recreationRequests, ['terminal-write-timeout'], signature);
  assert.equal(coordinator.getState().runtimeRecreationRequired, true, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'install-recovery-generation', viewGeneration: 8, streamEpoch: '2', checkpointEpoch: '1',
  }), { accepted: false, reason: 'runtime-recreation-required' }, signature);
});

test('FR_BGSTAB_022_AC4_checkpoint_write_timeout_requires_runtime_recreation', () => {
  const signature = 'checkpoint physical write timeout reused a parser with unknown ownership';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  const checkpoint = checkpointCommands(encoder.encode('checkpoint-timeout'));
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.equal(recording.writes.length, 1, signature);

  timer.fireNext();
  assert.deepEqual(recording.recreationRequests, ['terminal-write-timeout'], signature);
  assert.equal(coordinator.getState().runtimeRecreationRequired, true, signature);
  assert.equal(coordinator.getState().writeInFlight, false, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'install-recovery-generation', viewGeneration: 8, streamEpoch: '2', checkpointEpoch: '1',
  }), { accepted: false, reason: 'runtime-recreation-required' }, signature);
});

test('FR_BGSTAB_022_AC4_checkpoint_assembly_timeout_fails_closed_without_open_tx_deadlock', () => {
  const signature = 'checkpoint assembly timeout did not fail closed';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  timer.fireNext();
  assert.equal(recording.recoveries.at(-1), 'checkpoint-transaction-timeout', signature);
  assert.deepEqual(coordinator.dispatch(checkpoint.begin), { accepted: false, reason: 'recovery-required' }, signature);
  installRecoveryGeneration(coordinator);
  const fresh = checkpointCommands(encoder.encode('fresh'), {
    viewGeneration: 8, streamEpoch: '2', sourceSeq: '1', snapshotSeq: '1', oldestRetainedSeq: '1',
  });
  assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
});

test('FR_BGSTAB_022_AC5_checkpoint_begin_revokes_ready_and_holds_input_while_assembling', () => {
  const signature = 'checkpoint assembly left ready/input barrier open';
  const { coordinator, recording } = createCoordinator(signature);
  const first = checkpointCommands(encoder.encode('first'));
  coordinator.dispatch(first.begin);
  coordinator.dispatch(first.chunk);
  coordinator.dispatch(first.commit);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(coordinator.getState().ready, true, signature);

  const second = checkpointCommands(encoder.encode('second'), {
    checkpointEpoch: '2', snapshotSeq: '11',
  });
  assert.equal(coordinator.dispatch(second.begin).accepted, true, signature);
  assert.equal(coordinator.getState().ready, false, signature);
  assert.equal(coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'held', settlementToken: 'input-held' }).accepted, true, signature);
  assert.deepEqual(recording.releasedInput, [], signature);
});

test('FR_BGSTAB_022_AC6_adapter_reentrancy_cannot_release_old_generation_inputs', () => {
  const signature = 'adapter reentrancy released an old-generation input';
  const writes: Array<() => void> = [];
  const released: string[] = [];
  const coordinatorRef: { current: TerminalWriteCoordinator | null } = { current: null };
  const adapter: CoordinatorAdapter = {
    write: (_command, onWritten) => { writes.push(onWritten); },
    resetParser: () => {},
    resize: () => {},
    applyModes: () => {},
    clearScreen: () => {},
    fit: () => ({ cols: 120, rows: 40 }),
    setWindowsPty: () => {},
    markReady: () => {
      coordinatorRef.current!.dispatch({ type: 'supersede', viewGeneration: 8 });
    },
    releaseInput: data => { released.push(data); },
    settleInput: () => {},
    requestFreshRecovery: () => {},
    requestRuntimeRecreation: () => {},
    compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {},
    checkpointDrained: () => {},
    settle: () => { throw new Error('observer failure must not wedge the deque'); },
  };
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  coordinatorRef.current = coordinator;
  coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'old-input', settlementToken: 'input-old-reentrant' });
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  writes.shift()?.();
  writes.shift()?.();
  assert.deepEqual(released, [], signature);
  assert.equal(coordinator.getState().viewGeneration, 8, signature);
});

test('REL_BGSTAB_007_AC4_higher_stream_epoch_requires_fresh_checkpoint', () => {
  const signature = 'higher stream epoch live output bypassed a fresh checkpoint';
  const { coordinator, recording } = createCoordinator(signature);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('epoch-1'), settlementToken: 'epoch-1',
  });
  recording.writes.shift()?.onWritten();
  const result = coordinator.dispatch({
    type: 'live', streamEpoch: '2', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('epoch-2'), settlementToken: 'epoch-2',
  });
  assert.deepEqual(result, { accepted: false, reason: 'fresh-checkpoint-required' }, signature);
  assert.deepEqual(recording.settlements.at(-1), { token: 'epoch-2', outcome: 'failed' }, signature);
});

test('FR_BGSTAB_022_AC6_rejects_duplicate_or_empty_settlement_credit', () => {
  const signature = 'duplicate settlement credit was not rejected';
  const { coordinator, recording } = createCoordinator(signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '1', viewGeneration: 7,
    data: encoder.encode('one'), settlementToken: 'credit-1',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '2', viewGeneration: 7,
    data: encoder.encode('two'), settlementToken: 'credit-1',
  }).accepted, false, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '3', viewGeneration: 7,
    data: encoder.encode('three'), settlementToken: '',
  }).accepted, false, signature);
  recording.writes.shift()?.onWritten();
  assert.equal(recording.settlements.filter(entry => entry.token === 'credit-1').length, 1, signature);
});

test('FR_BGSTAB_022_AC4_bounds_post_checkpoint_hold_with_injected_limits', () => {
  const signature = 'post-checkpoint hold exceeded its injected byte/chunk limits';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    pendingInputMaxBytes: BOUNDED_COORDINATOR_LIMITS.pendingInputMaxBytes,
    pendingInputMaxCount: BOUNDED_COORDINATOR_LIMITS.pendingInputMaxCount,
    pendingInputTtlMs: BOUNDED_COORDINATOR_LIMITS.pendingInputTtlMs,
    settlementLedgerMaxEntries: BOUNDED_COORDINATOR_LIMITS.settlementLedgerMaxEntries,
    settlementLedgerTtlMs: BOUNDED_COORDINATOR_LIMITS.settlementLedgerTtlMs,
    postCheckpointMaxBytes: 1,
    postCheckpointMaxChunks: 1,
    checkpointMaxBytes: BOUNDED_COORDINATOR_LIMITS.postCheckpointMaxBytes,
    checkpointMaxChunks: BOUNDED_COORDINATOR_LIMITS.postCheckpointMaxChunks,
  });
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  coordinator.dispatch(checkpoint.begin);
  const overflow = coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('too-large'), settlementToken: 'held-overflow',
  });
  assert.deepEqual(overflow, { accepted: false, reason: 'post-checkpoint-hold-overflow' }, signature);
  assert.equal(recording.recoveries.at(-1), 'post-checkpoint-hold-overflow', signature);
  assert.deepEqual(recording.settlements.at(-1), { token: 'held-overflow', outcome: 'failed' }, signature);
});

test('FR_BGSTAB_022_AC1_compatibility_mutations_share_the_canonical_physical_deque', () => {
  const signature = 'compatibility mutation bypassed the canonical sole-writer deque';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
  });
  coordinator.submitCompatibility({ type: 'write', viewGeneration: 7, kind: 'live', data: 'one' });
  coordinator.submitCompatibility({ type: 'reset', viewGeneration: 7 });
  coordinator.submitCompatibility({ type: 'clear', viewGeneration: 7 });
  coordinator.submitCompatibility({ type: 'fit', viewGeneration: 7 });
  coordinator.submitCompatibility({ type: 'set-windows-pty', viewGeneration: 7, value: { backend: 'conpty' } });
  coordinator.submitCompatibility({ type: 'write', viewGeneration: 7, kind: 'repair', data: 'two' });
  assert.deepEqual(recording.events, ['live'], signature);
  recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.events, ['live', 'reset', 'clear', 'fit', 'windows-pty', 'repair'], signature);
  recording.writes.shift()?.onWritten();
  assert.equal(coordinator.getState().pendingCommands, 0, signature);
});

test('FR_BGSTAB_022_AC3_legacy_compatibility_write_cannot_follow_or_overwrite_checkpoint_authority', () => {
  const signature = 'legacy compatibility output was retained to overwrite its assembling checkpoint';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
  });
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.deepEqual(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 7, kind: 'live', data: 'after-checkpoint',
  }), { accepted: false, reason: 'checkpoint-authority-conflict' }, signature);
  assert.deepEqual(recording.events, [], signature);
  assert.deepEqual(recording.recoveries, [], 'a rejected stale compatibility write invalidated server authority');
  assert.equal(coordinator.getState().pendingCommands, 0, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointDrained.length, 1, signature);
  assert.deepEqual(recording.ready, [7], signature);
});

test('FR_BGSTAB_022_AC3_legacy_snapshot_reset_cannot_queue_behind_committed_checkpoint', () => {
  const signature = 'legacy snapshot reset was queued behind a committed authoritative checkpoint';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  assert.equal(recording.writes[0]?.kind, 'checkpoint', signature);

  assert.deepEqual(
    coordinator.submitCompatibility({ type: 'reset', viewGeneration: 7 }),
    { accepted: false, reason: 'checkpoint-authority-conflict' },
    signature,
  );
  assert.equal(recording.events.includes('reset'), true, 'only the authoritative checkpoint reset may have run');
  assert.equal(recording.events.filter(event => event === 'reset').length, 1, signature);
  assert.deepEqual(recording.recoveries, [], 'a delayed legacy reset invalidated the committed checkpoint');
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointDrained.length, 1, signature);
  assert.deepEqual(recording.ready, [7], signature);
});

test('FR_BGSTAB_022_AC3_legacy_repair_replay_cannot_queue_behind_committed_checkpoint', () => {
  const signature = 'legacy repair replay was queued behind a committed authoritative checkpoint';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'));
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);

  assert.deepEqual(coordinator.submitCompatibility({
    type: 'write',
    viewGeneration: 7,
    kind: 'repair',
    data: 'legacy-snapshot',
  }), { accepted: false, reason: 'checkpoint-authority-conflict' }, signature);
  assert.equal(recording.events.includes('repair'), false, signature);
  assert.deepEqual(recording.recoveries, [], 'a delayed legacy repair invalidated the committed checkpoint');
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointDrained.length, 1, signature);
  assert.deepEqual(recording.ready, [7], signature);
});

test('MIG-BGSTAB-002 checkpoint rejects stale snapshot Windows PTY metadata', () => {
  const signature = 'a stale snapshot Windows PTY option must not apply after checkpoint authority begins';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('authoritative-checkpoint'));

  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.deepEqual(coordinator.submitCompatibility({
    type: 'set-windows-pty',
    viewGeneration: 7,
    value: { backend: 'conpty', source: 'stale-snapshot' },
  }), { accepted: false, reason: 'checkpoint-authority-conflict' }, signature);
  assert.equal(recording.events.includes('windows-pty'), false, signature);
});

test('MIG-BGSTAB-002 snapshot reset body and a later checkpoint share one physical order', () => {
  const signature = 'a checkpoint that starts after legacy reset must still become the final terminal authority';
  const { coordinator, recording } = createCoordinator(signature);
  let replayDecision: CoordinatorResult | null = null;

  assert.equal(coordinator.submitCompatibility({
    type: 'reset',
    viewGeneration: 7,
    onApplied: () => {
      replayDecision = coordinator.submitCompatibility({
        type: 'write',
        viewGeneration: 7,
        kind: 'repair',
        data: 'legacy-snapshot-body',
      });
    },
  }).accepted, true, signature);
  assert.deepEqual(replayDecision, { accepted: true }, signature);
  assert.deepEqual(recording.events, ['reset', 'repair'], signature);

  const checkpoint = checkpointCommands(encoder.encode('authoritative-checkpoint'));
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.deepEqual(
    recording.events,
    ['reset', 'repair'],
    'the checkpoint waits behind the already-started legacy body in the same deque',
  );

  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.deepEqual(
    recording.events,
    ['reset', 'repair', 'reset', 'resize:120x40', 'modes', 'checkpoint', 'parser-tail'],
    'the authoritative checkpoint must be the final mutation sequence after the legacy snapshot body',
  );
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointDrained.length, 1, signature);
  assert.deepEqual(recording.ready, [7], signature);
});

test('FR_BGSTAB_022_AC4_reentrant_recovery_preserves_fresh_checkpoint_timer', () => {
  const signature = 'old checkpoint failure cleared a reentrant fresh checkpoint timer';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const coordinatorRef: { current: TerminalWriteCoordinator | null } = { current: null };
  let reentered = false;
  const adapter: CoordinatorAdapter = {
    ...recording.adapter,
    requestFreshRecovery: () => {
      if (reentered) return;
      reentered = true;
      installRecoveryGeneration(coordinatorRef.current!);
      const fresh = checkpointCommands(encoder.encode('fresh'), {
        viewGeneration: 8,
        streamEpoch: '2',
        checkpointEpoch: '1',
        sourceSeq: '1',
        snapshotSeq: '1',
        oldestRetainedSeq: '1',
      });
      assert.equal(coordinatorRef.current!.dispatch(fresh.begin).accepted, true, signature);
    },
  };
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    timeoutMs: 1,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  coordinatorRef.current = coordinator;
  const old = checkpointCommands(encoder.encode('old'), { chunkCount: 2 });
  coordinator.dispatch(old.begin);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('held-old'), settlementToken: 'held-old',
  });
  assert.equal(coordinator.dispatch({ ...old.chunk, index: 1, count: 2 }).accepted, false, signature);
  assert.equal(coordinator.getState().viewGeneration, 8, signature);
  assert.deepEqual(recording.settlements, [{ token: 'held-old', outcome: 'failed' }], signature);
  assert.equal(timer.pendingCount, 1, signature);
});

test('FR_BGSTAB_022_AC6_old_generation_callback_throw_cannot_poison_fresh_generation', () => {
  const paths = [
    'markReady',
    'releaseInput',
    'compatibility-onRejected',
    'compatibility-onWritten',
    'compatibility-onApplied',
    'settle',
  ] as const;

  for (const path of paths) {
    const signature = `old ${path} callback exception poisoned fresh generation 8`;
    const recording = createRecordingAdapter();
    const coordinatorRef: { current: TerminalWriteCoordinator | null } = { current: null };
    const supersedeThenThrow = (): never => {
      assert.equal(coordinatorRef.current!.dispatch({ type: 'supersede', viewGeneration: 8 }).accepted, true, signature);
      throw new Error(signature);
    };
    const adapter: CoordinatorAdapter = {
      ...recording.adapter,
      markReady: path === 'markReady' ? supersedeThenThrow : recording.adapter.markReady,
      releaseInput: path === 'releaseInput' ? supersedeThenThrow : recording.adapter.releaseInput,
      settle: path === 'settle' ? supersedeThenThrow : recording.adapter.settle,
    };
    const coordinator = requireCoordinatorFactory(signature)({
      viewGeneration: 7,
      adapter,
      digestBytes: fnv1a64,
      ...BOUNDED_COORDINATOR_LIMITS,
    });
    coordinatorRef.current = coordinator;

    if (path === 'markReady' || path === 'releaseInput') {
      if (path === 'releaseInput') {
        coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'old-input', settlementToken: `input-old-${path}` });
      }
      const checkpoint = checkpointCommands(encoder.encode(path));
      coordinator.dispatch(checkpoint.begin);
      coordinator.dispatch(checkpoint.chunk);
      coordinator.dispatch(checkpoint.commit);
      recording.writes.shift()?.onWritten();
      recording.writes.shift()?.onWritten();
    } else if (path === 'compatibility-onRejected') {
      coordinator.submitCompatibility({
        type: 'resize',
        viewGeneration: 7,
        cols: 0,
        rows: 0,
        onRejected: supersedeThenThrow,
      });
    } else if (path === 'compatibility-onWritten') {
      coordinator.submitCompatibility({
        type: 'write',
        viewGeneration: 7,
        kind: 'live',
        data: 'old-write',
        onWritten: supersedeThenThrow,
      });
      recording.writes.shift()?.onWritten();
    } else if (path === 'compatibility-onApplied') {
      coordinator.submitCompatibility({
        type: 'reset',
        viewGeneration: 7,
        onApplied: supersedeThenThrow,
      });
    } else {
      coordinator.dispatch({
        type: 'live',
        streamEpoch: '1',
        sourceSeq: '1',
        viewGeneration: 7,
        data: encoder.encode('settle'),
        settlementToken: 'settle-old-generation',
      });
      recording.writes.shift()?.onWritten();
    }

    assert.equal(coordinator.getState().viewGeneration, 8, signature);
    assertFreshGenerationCheckpointAccepted(coordinator, signature);
  }
});

test('FR_BGSTAB_022_AC4_checkpoint_frames_cross_validate_complete_authority_identity', () => {
  const fields = [
    ['streamEpoch', '2'],
    ['checkpointEpoch', '2'],
    ['sourceSeq', '11'],
    ['snapshotSeq', '9'],
    ['oldestRetainedSeq', '2'],
    ['retentionPolicyId', 'other-policy'],
    ['chunkCount', 2],
    ['encodedByteTotal', 99],
    ['digest', 'other-digest'],
  ] as const;
  for (const frameType of ['chunk', 'commit'] as const) {
    for (const [field, value] of fields) {
      const signature = `${frameType} ${field} mismatch escaped complete checkpoint identity validation`;
      const { coordinator, recording } = createCoordinator(signature);
      const checkpoint = checkpointCommands(encoder.encode('identity'));
      assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
      const frame = { ...checkpoint[frameType], [field]: value } as CoordinatorCommand;
      assert.equal(coordinator.dispatch(frame).accepted, false, signature);
      assert.equal(recording.recoveries.at(-1), 'checkpoint-identity-mismatch', signature);
      assert.equal(recording.writes.length, 0, signature);
    }
  }
});

test('FR_BGSTAB_022_AC4_checkpoint_chunk_cannot_exceed_declared_or_injected_byte_budget', () => {
  const signature = 'checkpoint chunk allocation exceeded its declared bounded transaction budget';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('a'));
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.deepEqual(
    coordinator.dispatch({ ...checkpoint.chunk, data: encoder.encode('oversized') }),
    { accepted: false, reason: 'checkpoint-chunk-order-invalid' },
    signature,
  );
  assert.equal(recording.writes.length, 0, signature);
  assert.equal(recording.recoveries.at(-1), 'checkpoint-chunk-order-invalid', signature);
});

test('FR_BGSTAB_022_AC3_checkpoint_applied_waits_for_contiguous_source_watermark_then_drains_before_ready', () => {
  const signature = 'checkpoint lifecycle ACK opened before its contiguous source watermark was physically written';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'), { sourceSeq: '12' });
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('tail-11'), settlementToken: 'tail-11',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '12', viewGeneration: 7,
    data: encoder.encode('tail-12'), settlementToken: 'tail-12',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '13', viewGeneration: 7,
    data: encoder.encode('after-watermark'), settlementToken: 'tail-13',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.deepEqual(recording.checkpointApplied, [], signature);
  assert.deepEqual(recording.checkpointDrained, [], signature);
  recording.writes.shift()?.onWritten();
  recording.writes.shift()?.onWritten();
  recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.checkpointApplied, [], 'sourceSeq=11 incorrectly satisfied sourceSeq=12 watermark');
  assert.deepEqual(recording.ready, [], signature);
  recording.writes.shift()?.onWritten();
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointApplied[0]?.sourceSeq, '12', signature);
  assert.equal(recording.checkpointDrained.length, 0, 'post-watermark output was not physically drained');
  assert.deepEqual(recording.ready, [], signature);
  assert.equal(recording.writes.length, 1, 'post-watermark output was not allowed to remain independently in flight');
  assert.equal(recording.settlements.some(entry => entry.token === 'tail-13'), false, signature);
  recording.writes.shift()?.onWritten();
  assert.equal(recording.checkpointDrained.length, 1, signature);
  assert.equal(recording.checkpointDrained[0]?.sourceSeq, '13', signature);
  assert.deepEqual(recording.ready, [7], signature);
  assert.equal(recording.settlements.some(entry => entry.token === 'tail-13'), true, signature);
});

test('FR_BGSTAB_022_AC3_checkpoint_commit_waits_for_post_commit_contiguous_source_watermark', () => {
  const signature = 'checkpoint commit did not remain pending until post-commit output reached its sourceSeq watermark';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'), { sourceSeq: '12' });
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'queue-input', viewGeneration: 7, data: 'held-input', settlementToken: 'input-held-watermark',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.equal(recording.writes.length, 0, 'checkpoint mutated the terminal before its declared watermark arrived');
  assert.deepEqual(recording.checkpointApplied, [], signature);
  assert.deepEqual(recording.checkpointDrained, [], signature);
  assert.deepEqual(recording.releasedInput, [], signature);

  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('tail-11'), settlementToken: 'tail-11',
  }).accepted, true, signature);
  assert.equal(recording.writes.length, 0, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '12', viewGeneration: 7,
    data: encoder.encode('tail-12'), settlementToken: 'tail-12',
  }).accepted, true, signature);
  assert.equal(recording.writes[0]?.kind, 'checkpoint', signature);

  recording.writes.shift()?.onWritten();
  recording.writes.shift()?.onWritten();
  recording.writes.shift()?.onWritten();
  assert.deepEqual(recording.checkpointApplied, [], 'checkpoint applied before sourceSeq=12 was physically written');
  assert.deepEqual(recording.releasedInput, [], signature);
  recording.writes.shift()?.onWritten();

  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointApplied[0]?.snapshotSeq, '10', signature);
  assert.equal(recording.checkpointDrained.length, 1, signature);
  assert.equal(recording.checkpointDrained[0]?.sourceSeq, '12', signature);
  assert.deepEqual(recording.releasedInput, ['held-input'], signature);
});

test('FR_BGSTAB_022_AC4_post_commit_watermark_allows_monotonic_reserved_sequence_gaps', () => {
  const signature = 'a legitimate reserved source sequence gap invalidated checkpoint recovery';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'), { sourceSeq: '12' });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '12', viewGeneration: 7,
    data: encoder.encode('gap'), settlementToken: 'gap-tail',
  }), { accepted: true }, signature);
  assert.deepEqual(recording.recoveries, [], signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(recording.checkpointApplied.length, 1, signature);
  assert.equal(recording.checkpointDrained[0]?.sourceSeq, '12', signature);
  assert.deepEqual(recording.ready, [7], signature);
});

test('FR_BGSTAB_022_AC4_duplicate_commit_while_waiting_for_watermark_fails_closed', () => {
  const signature = 'duplicate commit restarted a checkpoint pending its source watermark';
  const { coordinator, recording } = createCoordinator(signature);
  const checkpoint = checkpointCommands(encoder.encode('snapshot'), { sourceSeq: '11' });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.deepEqual(
    coordinator.dispatch(checkpoint.commit),
    { accepted: false, reason: 'checkpoint-commit-duplicate' },
    signature,
  );
  assert.equal(recording.recoveries.at(-1), 'checkpoint-commit-duplicate', signature);
  assert.equal(recording.writes.length, 0, signature);
});

test('FR_BGSTAB_022_AC4_post_commit_watermark_wait_keeps_the_transaction_timeout', () => {
  const signature = 'checkpoint waiting for a post-commit source watermark lost its bounded timeout';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  const checkpoint = checkpointCommands(encoder.encode('snapshot'), { sourceSeq: '11' });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  assert.equal(timer.pendingCount, 1, signature);
  timer.fireNext();
  assert.equal(recording.recoveries.at(-1), 'checkpoint-transaction-timeout', signature);
  assert.equal(recording.writes.length, 0, signature);
});

test('FR_BGSTAB_022_AC4_recovery_latch_requires_explicit_fresh_generation_epoch_install', () => {
  const signature = 'a failed generation reopened without explicit recovery authority installation';
  const { coordinator } = createCoordinator(signature);
  const bad = checkpointCommands(encoder.encode('bad'), { digest: 'bad-digest' });
  coordinator.dispatch(bad.begin);
  coordinator.dispatch(bad.chunk);
  assert.equal(coordinator.dispatch(bad.commit).accepted, false, signature);
  assert.deepEqual(
    coordinator.dispatch({ type: 'supersede', viewGeneration: 8 }),
    { accepted: false, reason: 'recovery-install-required' },
    signature,
  );
  assert.equal(coordinator.dispatch({
    type: 'install-recovery-generation', viewGeneration: 8,
    streamEpoch: '2', checkpointEpoch: '3',
  }).accepted, true, signature);
  const fresh = checkpointCommands(encoder.encode('fresh'), {
    viewGeneration: 8, streamEpoch: '2', checkpointEpoch: '3',
    sourceSeq: '1', snapshotSeq: '1', oldestRetainedSeq: '1',
  });
  assert.equal(coordinator.dispatch(fresh.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(fresh.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(fresh.commit).accepted, true, signature);
});

test('FR_BGSTAB_022_AC5_pending_input_and_settlement_ledger_are_bounded_by_injected_limits', () => {
  const signature = 'coordinator ownership queues exceeded their injected count/byte limits';
  const recording = createRecordingAdapter();
  let now = 1_000;
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 8,
    pendingInputMaxBytes: 2,
    pendingInputMaxCount: 1,
    pendingInputTtlMs: 100,
    settlementLedgerMaxEntries: 1,
    settlementLedgerTtlMs: 100,
    now: () => now,
  });
  assert.equal(coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'a', settlementToken: 'input-a' }).accepted, true, signature);
  assert.deepEqual(coordinator.getState(), {
    viewGeneration: 7, ready: false, disposed: false, writeInFlight: false,
    pendingCommands: 0, pendingInputs: 1, pendingInputBytes: 1, settlementLedgerEntries: 0,
    inputSettlementLedgerEntries: 1, recoveryRequired: false,
    compatibilityRecoveryPending: false, runtimeRecreationRequired: false,
  }, signature);
  assert.deepEqual(
    coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'b', settlementToken: 'input-b' }),
    { accepted: false, reason: 'pending-input-overflow' },
    signature,
  );
  assert.equal(coordinator.dispatch({
    type: 'install-recovery-generation', viewGeneration: 8,
    streamEpoch: '2', checkpointEpoch: '1',
  }).accepted, true, signature);
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '2', sourceSeq: '1', viewGeneration: 8,
    data: encoder.encode('one'), settlementToken: 'credit-1',
  }).accepted, false, 'live must remain blocked until installed checkpoint');
  const checkpoint = checkpointCommands(encoder.encode('fresh'), {
    viewGeneration: 8, streamEpoch: '2', checkpointEpoch: '1',
    sourceSeq: '1', snapshotSeq: '1', oldestRetainedSeq: '1',
  });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(coordinator.dispatch({
    type: 'live', streamEpoch: '2', sourceSeq: '2', viewGeneration: 8,
    data: encoder.encode('one'), settlementToken: 'credit-1',
  }).accepted, true, signature);
  recording.writes.shift()?.onWritten();
  assert.equal(coordinator.getState().settlementLedgerEntries, 1, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'live', streamEpoch: '2', sourceSeq: '3', viewGeneration: 8,
    data: encoder.encode('two'), settlementToken: 'credit-2',
  }), { accepted: false, reason: 'settlement-ledger-overflow' }, signature);
  now += 101;
  assert.equal(coordinator.getState().settlementLedgerEntries, 0, 'settled credit TTL did not prune the bounded ledger');
});

test('MIG-BGSTAB-002 released ready inputs do not exhaust the output settlement ledger cap', () => {
  const signature = 'rapid released input exhausted an unrelated output settlement ledger cap';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 8,
    pendingInputMaxBytes: 64,
    pendingInputMaxCount: 8,
    pendingInputTtlMs: 1_500,
    settlementLedgerMaxEntries: 2,
    inputSettlementLedgerMaxEntries: 3,
    settlementLedgerTtlMs: 1_500,
    now: () => 1_000,
  });
  const checkpoint = checkpointCommands(encoder.encode('ready'));
  assert.equal(coordinator.dispatch(checkpoint.begin).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.chunk).accepted, true, signature);
  assert.equal(coordinator.dispatch(checkpoint.commit).accepted, true, signature);
  while (recording.writes.length > 0) recording.writes.shift()?.onWritten();
  assert.equal(coordinator.getState().ready, true, signature);

  for (let index = 1; index <= 3; index += 1) {
    assert.deepEqual(coordinator.dispatch({
      type: 'queue-input',
      viewGeneration: 7,
      data: 'x',
      settlementToken: `rapid-input-${index}`,
    }), { accepted: true }, signature);
  }
  assert.equal(coordinator.getState().recoveryRequired, false, signature);
  assert.equal(recording.releasedInput.length, 3, signature);
  assert.deepEqual(coordinator.dispatch({
    type: 'queue-input',
    viewGeneration: 7,
    data: 'x',
    settlementToken: 'rapid-input-4',
  }), { accepted: false, reason: 'input-settlement-ledger-overflow' }, signature);
  assert.equal(coordinator.getState().recoveryRequired, true, signature);
});

test('FR_BGSTAB_022_AC5_pending_input_ttl_expires_fail_closed_and_releases_ownership', () => {
  const signature = 'expired pre-ready input remained silently owned by the coordinator';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  let now = 1_000;
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    pendingInputTtlMs: 100,
    now: () => now,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  assert.equal(coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'held', settlementToken: 'input-expiring' }).accepted, true, signature);
  now += 101;
  timer.fireNext();
  assert.equal(recording.recoveries.at(-1), 'pending-input-expired', signature);
  assert.deepEqual(recording.inputSettlements, [
    { token: 'input-expiring', outcome: 'expired' },
  ], signature);
  assert.equal(coordinator.getState().pendingInputs, 0, signature);
  assert.equal(coordinator.getState().pendingInputBytes, 0, signature);
  assert.equal(coordinator.getState().ready, false, signature);
});

test('FR_BGSTAB_022_AC5_expiry_notifier_throw_settles_every_accepted_input', () => {
  const signature = 'recovery notifier throw left nonexpired accepted input without settlement';
  const recording = createRecordingAdapter();
  const timer = createManualTimer();
  let now = 1_000;
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: {
      ...recording.adapter,
      requestFreshRecovery: () => { throw new Error('observer unavailable'); },
    },
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
    pendingInputTtlMs: 100,
    now: () => now,
    setTimer: callback => timer.setTimer(callback),
    clearTimer: handle => timer.clearTimer(handle),
  });
  assert.equal(coordinator.dispatch({
    type: 'queue-input', viewGeneration: 7, data: 'first-secret', settlementToken: 'expiry-first',
  }).accepted, true, signature);
  now += 50;
  assert.equal(coordinator.dispatch({
    type: 'queue-input', viewGeneration: 7, data: 'second-secret', settlementToken: 'expiry-second',
  }).accepted, true, signature);
  now += 51;
  timer.fireNext();

  assert.deepEqual(recording.inputSettlements, [
    { token: 'expiry-first', outcome: 'expired' },
    { token: 'expiry-second', outcome: 'rejected' },
  ], signature);
  assert.equal(coordinator.getState().pendingInputs, 0, signature);
  assert.equal(coordinator.getState().pendingInputBytes, 0, signature);
  assert.equal(JSON.stringify(recording.inputSettlements).includes('secret'), false, signature);
});

test('FR_BGSTAB_022_AC5_missing_queue_limit_injection_fails_closed', () => {
  const signature = 'missing coordinator queue limit injection silently enabled unbounded ownership';
  const recording = createRecordingAdapter();
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter: recording.adapter,
    digestBytes: fnv1a64,
  });
  assert.deepEqual(
    coordinator.dispatch({ type: 'queue-input', viewGeneration: 7, data: 'x', settlementToken: 'input-unbounded' }),
    { accepted: false, reason: 'pending-input-overflow' },
    signature,
  );
  assert.equal(recording.recoveries.at(-1), 'pending-input-overflow', signature);
});

test('FR_BGSTAB_022_AC4_recovery_failed_atomically_cancels_checkpoint_and_preserves_reentrant_install', () => {
  const signature = 'external recovery failure callback destroyed its reentrant fresh authority install';
  const recording = createRecordingAdapter();
  const coordinatorRef: { current: TerminalWriteCoordinator | null } = { current: null };
  const adapter: CoordinatorAdapter = {
    ...recording.adapter,
    requestFreshRecovery: () => {
      installRecoveryGeneration(coordinatorRef.current!);
      const fresh = checkpointCommands(encoder.encode('fresh'), {
        viewGeneration: 8, streamEpoch: '2', checkpointEpoch: '1',
        sourceSeq: '1', snapshotSeq: '1', oldestRetainedSeq: '1',
      });
      assert.equal(coordinatorRef.current!.dispatch(fresh.begin).accepted, true, signature);
    },
  };
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  coordinatorRef.current = coordinator;
  const old = checkpointCommands(encoder.encode('old'), { sourceSeq: '11' });
  coordinator.dispatch(old.begin);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('held'), settlementToken: 'held-old',
  });
  assert.deepEqual(coordinator.dispatch({
    type: 'recovery-failed', viewGeneration: 7, reason: 'wire-checkpoint-invalid',
  }), { accepted: false, reason: 'wire-checkpoint-invalid' }, signature);
  assert.deepEqual(recording.settlements, [{ token: 'held-old', outcome: 'failed' }], signature);
  assert.equal(coordinator.getState().viewGeneration, 8, signature);
  assert.equal(coordinator.getState().ready, false, signature);
});

test('FR_BGSTAB_022_AC4_checkpoint_applied_callback_failure_stops_tail_drain', () => {
  const signature = 'failed checkpoint apply ACK allowed later terminal output to drain';
  const recording = createRecordingAdapter();
  const adapter: CoordinatorAdapter = {
    ...recording.adapter,
    checkpointApplied: () => { throw new Error('ACK transport failed'); },
  };
  const coordinator = requireCoordinatorFactory(signature)({
    viewGeneration: 7,
    adapter,
    digestBytes: fnv1a64,
    ...BOUNDED_COORDINATOR_LIMITS,
  });
  const checkpoint = checkpointCommands(encoder.encode('snapshot'), { sourceSeq: '11' });
  coordinator.dispatch(checkpoint.begin);
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '11', viewGeneration: 7,
    data: encoder.encode('watermark'), settlementToken: 'watermark',
  });
  coordinator.dispatch({
    type: 'live', streamEpoch: '1', sourceSeq: '12', viewGeneration: 7,
    data: encoder.encode('must-not-drain'), settlementToken: 'after-watermark',
  });
  coordinator.dispatch(checkpoint.chunk);
  coordinator.dispatch(checkpoint.commit);
  recording.writes.shift()?.onWritten();
  recording.writes.shift()?.onWritten();
  recording.writes.shift()?.onWritten();
  assert.equal(recording.recoveries.at(-1), 'checkpoint-applied-callback-failed', signature);
  assert.equal(recording.writes.length, 0, signature);
  assert.equal(coordinator.getState().pendingCommands, 1, signature);
});

test('FR_BGSTAB_022_AC3_unsupported_mode_preflight_has_zero_terminal_mutations', () => {
  const signature = 'unsupported checkpoint mode must fail before reset, resize, mode apply, or write';
  const { coordinator, recording } = createCoordinator(signature);
  const body = encoder.encode('body');
  const { begin } = checkpointCommands(body, {
    modes: { unsupportedMode: true },
  });

  const result = coordinator.dispatch(begin);
  assert.equal(result.accepted, false, signature);
  assert.deepEqual(recording.events, [], signature);
  assert.equal(recording.writes.length, 0, signature);
  assert.deepEqual(recording.recoveries, ['invalid-checkpoint-metadata'], signature);
});
