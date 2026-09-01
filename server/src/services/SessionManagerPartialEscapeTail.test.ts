import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '../types/index.js';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
} from '../utils/headlessTerminal.js';
import { advanceTerminalPartialEscapeTail } from '../utils/terminalPartialEscapeTail.js';
import { SessionManager } from './SessionManager.js';

const SIGNATURES = {
  race: 'expected mixed snapshot N and parser-tail N+1 authority sample to be rejected or retried',
  pendingWrite: 'expected unstable pending headless write snapshot to retry or report generation-failed',
  splitEscape: 'expected split CSI OSC DCS ST CAN SUB ingest to derive authoritative parser tail',
  tailAttachment: 'expected pending escape tail excluded from display bytes and attached to exact snapshot sequence',
  degradedPendingTail: 'expected degraded fallback authority to derive parser metadata from pending output before publishing the snapshot',
  stickyParserOverflow: 'expected parser-tail overflow to remain non-ready after later plain degraded output',
} as const;

interface RestoreAuthorityObservation {
  ok: boolean;
  reason?: string;
  authorityRevision?: number;
  snapshotSeq?: number;
  parserComplete?: boolean;
  pendingEscapeTailAnsi?: string;
  serializedData?: string;
}

function createHarness() {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 24,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 100,
      maxSnapshotBytes: 64 * 1024,
      shell: 'auto',
    },
    session: { idleDelayMs: 200 },
  }, {
    platform: 'linux',
    execFileSyncFn: (() => Buffer.from('')) as any,
  });
  const headless = createHeadlessTerminalState({
    cols: 24,
    rows: 4,
    scrollbackLines: 100,
  });
  const session: Session = {
    id: `restore-${Math.random().toString(36).slice(2)}`,
    name: 'Restore authority harness',
    status: 'idle',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
  };
  let closeResolve!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const sessionData = {
    session,
    pty: { resize() {}, kill() {}, write() {}, pid: 1 } as never,
    finalized: false,
    idleTimer: null,
    headless,
    headlessHealth: 'healthy',
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: { promise: closePromise, resolve: closeResolve },
    pendingHeadlessWrites: 0,
    headlessApplyInFlight: 0,
    nextTerminalAuthoritySourceSeq: 0n,
    cols: 24,
    rows: 4,
    screenSeq: 0,
    authorityRevision: 0,
    parserComplete: true,
    pendingEscapeTailAnsi: '',
    parserTailOverflow: false,
    snapshotCache: null,
    degradedReplayBuffer: '',
    degradedReplayTruncated: false,
    headlessDegradedPhase: null,
    headlessOutputQueue: (manager as any).createHeadlessOutputQueue(),
    headlessQueueMode: 'bounded',
    pendingHeadlessOutputs: new Map(),
    pendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputChunks: 0,
    nextHeadlessOutputId: 0,
    unsnapshottedOutput: '',
    unsnapshottedOutputTruncated: false,
    initialCwd: process.cwd(),
  };
  (manager as any).sessions.set(session.id, sessionData);
  return {
    manager,
    sessionId: session.id,
    sessionData,
    async ingest(data: string): Promise<void> {
      (manager as any).queueHeadlessOutput(session.id, sessionData, data);
      await sessionData.headlessWriteChain;
    },
    dispose() {
      (manager as any).sessions.delete(session.id);
      closeResolve();
      disposeHeadlessTerminal(headless);
    },
  };
}

function normalizeAuthority(raw: any): RestoreAuthorityObservation {
  if (!raw) return { ok: false, reason: 'missing' };
  if (raw.ok === false) return { ok: false, reason: raw.reason };
  const value = raw.ok === true ? raw.payload ?? raw.snapshot ?? raw : raw;
  return {
    ok: true,
    authorityRevision: value.authorityRevision,
    snapshotSeq: value.snapshotSeq ?? value.seq,
    parserComplete: value.parserComplete,
    pendingEscapeTailAnsi: value.pendingEscapeTailAnsi,
    serializedData: value.serializedData ?? value.data,
  };
}

async function readAuthority(
  manager: SessionManager,
  sessionId: string,
): Promise<RestoreAuthorityObservation> {
  const candidate = manager as any;
  const reader = candidate.getAtomicRestoreSnapshot
    ?? candidate.getRestoreSnapshotAuthority
    ?? candidate.getScreenSnapshot;
  return normalizeAuthority(await Promise.resolve(reader.call(manager, sessionId)));
}

test('server RED — atomic authority revision race', async () => {
  const harness = createHarness();
  try {
    await harness.ingest('stable-display');
    harness.sessionData.snapshotCache = null;
    const serializeAddon = harness.sessionData.headless.serializeAddon;
    const originalSerialize = serializeAddon.serialize.bind(serializeAddon);
    let serializeCalls = 0;
    serializeAddon.serialize = ((options?: unknown) => {
      serializeCalls += 1;
      const serialized = originalSerialize(options as never);
      if (serializeCalls === 1) {
        harness.sessionData.screenSeq += 1;
        harness.sessionData.authorityRevision += 1;
        harness.sessionData.parserComplete = false;
        harness.sessionData.pendingEscapeTailAnsi = '\x1b[';
        harness.sessionData.snapshotCache = null;
      }
      return serialized;
    }) as typeof serializeAddon.serialize;

    const authority = await readAuthority(harness.manager, harness.sessionId);
    const rejectedOrRetried = (!authority.ok && authority.reason === 'generation-failed')
      || (
        serializeCalls >= 2
        && authority.authorityRevision === harness.sessionData.authorityRevision
        && authority.snapshotSeq === harness.sessionData.screenSeq
        && authority.parserComplete === false
        && authority.pendingEscapeTailAnsi === '\x1b['
      );

    assert.equal(rejectedOrRetried, true, SIGNATURES.race);
  } finally {
    harness.dispose();
  }
});

/**
 * The guard that rejects a mid-apply session sits before serialization, and an
 * identical condition sits in the post-serialize fence. Both answer
 * generation-failed, so a test that only reads the result cannot tell them
 * apart and keeps passing with the first one deleted.
 *
 * Counting serialize calls separates them, and clearing the counter from
 * inside the hook makes the difference reach the result: without the early
 * guard the fence sees a settled session and publishes the mid-apply screen as
 * authoritative.
 */
function hookSerializeClearingApplyInFlight(
  harness: ReturnType<typeof createHarness>,
  clearOnSerialize: boolean,
): { calls: number } {
  const serializeAddon = harness.sessionData.headless.serializeAddon;
  const originalSerialize = serializeAddon.serialize.bind(serializeAddon);
  const state = { calls: 0 };
  serializeAddon.serialize = ((options?: unknown) => {
    state.calls += 1;
    if (clearOnSerialize) {
      harness.sessionData.headlessApplyInFlight = 0;
    }
    return originalSerialize(options as never);
  }) as typeof serializeAddon.serialize;
  return state;
}

test('server RED — unstable pending-write authority', async () => {
  const harness = createHarness();
  try {
    await harness.ingest('stable-before-pending');
    harness.sessionData.snapshotCache = null;
    harness.sessionData.headlessApplyInFlight = 1;
    const serialize = hookSerializeClearingApplyInFlight(harness, true);

    const authority = await readAuthority(harness.manager, harness.sessionId);

    assert.deepEqual({
      ok: authority.ok,
      reason: authority.reason,
      serializedData: authority.serializedData,
      serializeCalls: serialize.calls,
    }, {
      ok: false,
      reason: 'generation-failed',
      serializedData: undefined,
      serializeCalls: 0,
    }, SIGNATURES.pendingWrite);
  } finally {
    harness.dispose();
  }
});

// Boundary control for the test above: the same hook and the same harness,
// differing only in that no write is mid-apply. It stays green with the early
// guard removed, so that test's red comes from the guard rather than from the
// hook or the cleared snapshot cache.
test('server — a settled session still serializes its authority', async () => {
  const harness = createHarness();
  try {
    await harness.ingest('stable-before-pending');
    harness.sessionData.snapshotCache = null;
    harness.sessionData.headlessApplyInFlight = 0;
    const serialize = hookSerializeClearingApplyInFlight(harness, true);

    const authority = await readAuthority(harness.manager, harness.sessionId);

    assert.deepEqual({
      ok: authority.ok,
      serializeCalls: serialize.calls,
      hasData: typeof authority.serializedData === 'string' && authority.serializedData.length > 0,
    }, {
      ok: true,
      serializeCalls: 1,
      hasData: true,
    }, SIGNATURES.pendingWrite);
  } finally {
    harness.dispose();
  }
});

test('server RED — split terminal escape ingest', async () => {
  const cases = [
    { name: 'CSI+ST-parameter', prefix: '\x1b[38;2;255', completion: ';0;0m', cancelled: false },
    { name: 'OSC+ST', prefix: '\x1b]0;split-title', completion: '\x1b\\', cancelled: false },
    { name: 'DCS+ST', prefix: '\x1bP1;2|payload', completion: '\x1b\\', cancelled: false },
    { name: 'CSI+CAN', prefix: '\x1b[31', completion: '\x18', cancelled: true },
    { name: 'OSC+SUB', prefix: '\x1b]0;cancelled', completion: '\x1a', cancelled: true },
  ] as const;
  const observed: Array<Record<string, unknown>> = [];

  for (const escapeCase of cases) {
    const harness = createHarness();
    try {
      await harness.ingest(escapeCase.prefix);
      const incomplete = await readAuthority(harness.manager, harness.sessionId);
      await harness.ingest(escapeCase.completion);
      const complete = await readAuthority(harness.manager, harness.sessionId);
      observed.push({
        name: escapeCase.name,
        incompleteParserComplete: incomplete.parserComplete,
        incompleteTail: incomplete.pendingEscapeTailAnsi,
        completeParserComplete: complete.parserComplete,
        completeTail: complete.pendingEscapeTailAnsi,
        seqAdvanced: complete.snapshotSeq === (incomplete.snapshotSeq ?? 0) + 1,
      });
    } finally {
      harness.dispose();
    }
  }

  assert.deepEqual(observed, cases.map(escapeCase => ({
    name: escapeCase.name,
    incompleteParserComplete: false,
    incompleteTail: escapeCase.prefix,
    completeParserComplete: true,
    completeTail: '',
    seqAdvanced: true,
  })), SIGNATURES.splitEscape);
});

test('server RED — split C1 CSI OSC and DCS stay incomplete until final ST CAN or SUB', async () => {
  const cases = [
    { name: 'C1-CSI-final', prefix: '\u009b31', completion: 'm', cancelled: false },
    { name: 'C1-OSC-ST', prefix: '\u009d0;c1-title', completion: '\u009c', cancelled: false },
    { name: 'C1-DCS-ST', prefix: '\u00901;2|payload', completion: '\u009c', cancelled: false },
    { name: 'C1-CSI-ST', prefix: '\u009b31', completion: '\u009c', cancelled: true },
    { name: 'ESC-intermediate-C1-ST', prefix: '\x1b(', completion: '\u009c', cancelled: true },
    { name: 'C1-CSI-CAN', prefix: '\u009b38;2;255', completion: '\x18', cancelled: true },
    { name: 'C1-OSC-SUB', prefix: '\u009d0;cancelled', completion: '\x1a', cancelled: true },
  ] as const;
  const observed: Array<Record<string, unknown>> = [];

  for (const escapeCase of cases) {
    const harness = createHarness();
    try {
      await harness.ingest(`A${escapeCase.prefix}`);
      const incomplete = await readAuthority(harness.manager, harness.sessionId);
      await harness.ingest(escapeCase.completion);
      const completedParser = await readAuthority(harness.manager, harness.sessionId);
      await harness.ingest('B');
      const completeDisplay = await readAuthority(harness.manager, harness.sessionId);
      observed.push({
        name: escapeCase.name,
        incompleteParserComplete: incomplete.parserComplete,
        incompleteTail: incomplete.pendingEscapeTailAnsi,
        incompleteDisplay: incomplete.serializedData,
        completeParserComplete: completedParser.parserComplete,
        completeTail: completedParser.pendingEscapeTailAnsi,
        completeDisplayEndsWithB: completeDisplay.serializedData?.endsWith('B'),
      });
    } finally {
      harness.dispose();
    }
  }

  assert.deepEqual(observed, cases.map(escapeCase => ({
    name: escapeCase.name,
    incompleteParserComplete: false,
    incompleteTail: escapeCase.prefix,
    incompleteDisplay: 'A',
    completeParserComplete: true,
    completeTail: '',
    completeDisplayEndsWithB: true,
  })));
});

test('server RED — pending tail sequence attachment', async () => {
  const harness = createHarness();
  try {
    await harness.ingest('VISIBLE-DISPLAY');
    await harness.ingest('\x1b]0;PRIVATE-PENDING-TITLE');
    const authority = await readAuthority(harness.manager, harness.sessionId);

    assert.deepEqual({
      snapshotSeq: authority.snapshotSeq,
      actualScreenSeq: harness.sessionData.screenSeq,
      parserComplete: authority.parserComplete,
      pendingEscapeTailAnsi: authority.pendingEscapeTailAnsi,
      displayContainsVisible: authority.serializedData?.includes('VISIBLE-DISPLAY'),
      displayContainsPendingTail: authority.serializedData?.includes('PRIVATE-PENDING-TITLE'),
    }, {
      snapshotSeq: harness.sessionData.screenSeq,
      actualScreenSeq: harness.sessionData.screenSeq,
      parserComplete: false,
      pendingEscapeTailAnsi: '\x1b]0;PRIVATE-PENDING-TITLE',
      displayContainsVisible: true,
      displayContainsPendingTail: false,
    }, SIGNATURES.tailAttachment);
  } finally {
    harness.dispose();
  }
});

test('server RED — degraded pending output preserves partial-escape authority', () => {
  const harness = createHarness();
  try {
    const pendingEscape = '\x1b]0;degraded-pending-title';
    const pendingOutput = {
      id: 1,
      data: pendingEscape,
      byteLength: Buffer.byteLength(pendingEscape, 'utf8'),
    };
    harness.sessionData.pendingHeadlessOutputs.set(pendingOutput.id, pendingOutput);
    harness.sessionData.pendingHeadlessOutputBytes = pendingOutput.byteLength;
    harness.sessionData.headlessOutputQueue.enqueue(pendingEscape);

    (harness.manager as any).markHeadlessDegraded(
      harness.sessionId,
      harness.sessionData,
      'write',
      new Error('forced pending-write degradation'),
    );
    const snapshot = (harness.manager as any).createDegradedSnapshot(harness.sessionData);

    assert.deepEqual({
      dataContainsPendingEscape: snapshot.data.includes('degraded-pending-title'),
      parserComplete: snapshot.parserComplete,
      pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi,
      pendingChunks: harness.sessionData.pendingHeadlessOutputs.size,
      pendingBytes: harness.sessionData.pendingHeadlessOutputBytes,
    }, {
      dataContainsPendingEscape: true,
      parserComplete: false,
      pendingEscapeTailAnsi: pendingEscape,
      pendingChunks: 0,
      pendingBytes: 0,
    }, SIGNATURES.degradedPendingTail);
  } finally {
    harness.dispose();
  }
});

test('server RED — parser-tail overflow remains sticky across degraded output', () => {
  const harness = createHarness();
  try {
    const maxSnapshotBytes = 64 * 1024;
    const overCapEscape = `\x1b]0;${'x'.repeat(maxSnapshotBytes)}`;
    const pendingOutput = {
      id: 1,
      data: overCapEscape,
      byteLength: Buffer.byteLength(overCapEscape, 'utf8'),
    };
    harness.sessionData.pendingHeadlessOutputs.set(pendingOutput.id, pendingOutput);
    harness.sessionData.pendingHeadlessOutputBytes = pendingOutput.byteLength;
    harness.sessionData.headlessOutputQueue.enqueue(overCapEscape);

    (harness.manager as any).markHeadlessDegraded(
      harness.sessionId,
      harness.sessionData,
      'queue-overflow',
      new Error('forced parser-tail overflow'),
    );
    (harness.manager as any).appendDegradedReplayOutput(harness.sessionData, 'X');
    const snapshot = (harness.manager as any).createDegradedSnapshot(harness.sessionData);

    assert.deepEqual({
      parserComplete: snapshot.parserComplete,
      pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi,
      parserTailOverflow: harness.sessionData.parserTailOverflow,
      endsWithCurrentOutput: snapshot.data.endsWith('X'),
    }, {
      parserComplete: false,
      pendingEscapeTailAnsi: '',
      parserTailOverflow: true,
      endsWithCurrentOutput: true,
    }, SIGNATURES.stickyParserOverflow);
  } finally {
    harness.dispose();
  }
});

test('server RED — incomplete OSC emoji cap uses UTF-8 code point bytes at N-1/N/N+1', () => {
  const incompleteOsc = '\x1b]0;😀';
  const actualUtf8Bytes = Buffer.byteLength(incompleteOsc, 'utf8');

  assert.equal(actualUtf8Bytes, 8);
  assert.deepEqual([
    advanceTerminalPartialEscapeTail('', incompleteOsc, actualUtf8Bytes - 1),
    advanceTerminalPartialEscapeTail('', incompleteOsc, actualUtf8Bytes),
    advanceTerminalPartialEscapeTail('', incompleteOsc, actualUtf8Bytes + 1),
  ], [
    { parserComplete: false, pendingEscapeTailAnsi: '', overflowed: true },
    { parserComplete: false, pendingEscapeTailAnsi: incompleteOsc, overflowed: false },
    { parserComplete: false, pendingEscapeTailAnsi: incompleteOsc, overflowed: false },
  ]);
});

test('server RED — split surrogate remains lossless and conservatively incomplete until OSC terminator', () => {
  const prefixAndHighSurrogate = '\x1b]0;\ud83d';
  const lowSurrogate = '\ude00';
  const cap = Buffer.byteLength('\x1b]0;😀', 'utf8');

  const afterHigh = advanceTerminalPartialEscapeTail('', prefixAndHighSurrogate, cap);
  const afterLow = advanceTerminalPartialEscapeTail(
    afterHigh.pendingEscapeTailAnsi,
    lowSurrogate,
    cap,
  );
  const afterTerminator = advanceTerminalPartialEscapeTail(
    afterLow.pendingEscapeTailAnsi,
    '\x07',
    cap,
  );

  assert.deepEqual({ afterHigh, afterLow, afterTerminator }, {
    afterHigh: {
      parserComplete: false,
      pendingEscapeTailAnsi: prefixAndHighSurrogate,
      overflowed: false,
    },
    afterLow: {
      parserComplete: false,
      pendingEscapeTailAnsi: '\x1b]0;😀',
      overflowed: false,
    },
    afterTerminator: {
      parserComplete: true,
      pendingEscapeTailAnsi: '',
      overflowed: false,
    },
  });
});
