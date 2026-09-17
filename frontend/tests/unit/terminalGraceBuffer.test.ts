// @req REL-BGSTAB-009 AC-1 AC-2 AC-3 AC-5 AC-10
//
// The remount grace lane (`bufferGraceMessage` / `flushGraceBuffer`) was
// previously covered only by regex assertions over `WebSocketContext.tsx`
// source text. Those gates are satisfied by any rewrite that keeps the same
// tokens, so they stay green while the behaviour inverts: swapping the
// snapshot block and the held-tail loop — a direct AC-3 violation — leaves the
// whole source-text contract suite passing. These tests execute the extracted
// coordinator and assert observed call order and observed admission, so a wrong
// order or an off-by-one cap is red.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyGraceBufferedMessage,
  createGraceBufferedSessionState,
  flushGraceBufferedSession,
  type GraceBufferedSessionState,
  type TerminalGraceBufferFlushHandlers,
} from '../../src/utils/terminalGraceBuffer.ts';
import { getTerminalResourceLimits } from '../../src/utils/inputReliabilityMode.ts';
import { getOutputUtf8ByteLength } from '../../src/utils/terminalOutputHotPath.ts';
import type { TerminalOutputDelivery } from '../../src/utils/terminalOutputDelivery.ts';
import { recordTerminalDebugEvent } from '../../src/utils/terminalDebugCapture.ts';
import type {
  ScreenRepairReconnectRequiredMessage,
  ScreenRepairRestoreNeededMessage,
  ScreenSnapshotMessage,
  TerminalOutputMessage,
  TerminalSessionReadyMessage,
} from '../../src/types/ws-protocol.ts';

const SESSION_ID = 'grace-session';

// `hasValidAuthorityProof` is fail-closed: a synthetic restore-needed or
// snapshot without `authorityEpoch`/`authorityRevision`/`coversThroughSeq` is
// discarded as an invalid proof and the barrier never engages. Build fixtures
// from one helper so no case can silently lose the proof.
function restoreNeeded(
  overrides: Partial<ScreenRepairRestoreNeededMessage> = {},
): ScreenRepairRestoreNeededMessage {
  return {
    type: 'screen-repair:restore-needed',
    sessionId: SESSION_ID,
    repairToken: 'repair-1',
    state: 'stale',
    reason: 'chunk-cap-exceeded',
    outcome: 'fresh-snapshot-started',
    replayToken: 'replay-1',
    snapshotSeq: 7,
    authorityEpoch: 'epoch-1',
    authorityRevision: 3,
    coversThroughSeq: 7,
    ...overrides,
  };
}

function snapshotFor(
  restore: ScreenRepairRestoreNeededMessage,
  overrides: Partial<ScreenSnapshotMessage> = {},
): ScreenSnapshotMessage {
  return {
    type: 'screen-snapshot',
    sessionId: SESSION_ID,
    replayToken: restore.replayToken,
    seq: restore.snapshotSeq,
    cols: 80,
    rows: 24,
    mode: 'authoritative',
    data: 'SNAPSHOT',
    truncated: false,
    source: 'headless',
    authorityEpoch: restore.authorityEpoch,
    authorityRevision: restore.authorityRevision,
    coversThroughSeq: restore.coversThroughSeq,
    supersedesReplayToken: restore.supersedesReplayToken,
    ...overrides,
  };
}

function output(
  data: string,
  overrides: Partial<TerminalOutputMessage> = {},
): TerminalOutputMessage {
  return {
    type: 'output',
    sessionId: SESSION_ID,
    data,
    replayToken: 'replay-1',
    ...overrides,
  };
}

function ready(
  restore: ScreenRepairRestoreNeededMessage,
  overrides: Partial<TerminalSessionReadyMessage> = {},
): TerminalSessionReadyMessage {
  return {
    type: 'session:ready',
    sessionId: SESSION_ID,
    replayToken: restore.replayToken,
    snapshotSeq: restore.snapshotSeq,
    ...overrides,
  };
}

function reconnectRequired(): ScreenRepairReconnectRequiredMessage {
  return {
    type: 'screen-repair:reconnect-required',
    sessionId: SESSION_ID,
    repairToken: 'repair-1',
    reason: 'chunk-cap-exceeded',
    outcome: 'reconnect-required',
  };
}

interface RecordedFlush {
  readonly calls: string[];
  readonly handlers: TerminalGraceBufferFlushHandlers;
}

function recordingHandlers(): RecordedFlush {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      onScreenRepairRestoreNeeded: () => calls.push('restore-needed'),
      onScreenRepairReconnectRequired: () => calls.push('reconnect-required'),
      onGraceOutputOverflow: reason => calls.push(`overflow:${reason}`),
      onGraceAuthorityProofMismatch: () => calls.push('proof-mismatch'),
      onSubscribed: info => calls.push(`subscribed:ready=${info.ready}`),
      onScreenSnapshot: () => calls.push('snapshot'),
      onStatus: () => calls.push('status'),
      onCwd: () => calls.push('cwd'),
      onOutput: delivery => calls.push(`output:${String(delivery.whole.data)}`),
      onSessionReady: () => calls.push('ready'),
      onError: () => calls.push('error'),
    },
  };
}

function applyAll(
  messages: readonly Parameters<typeof applyGraceBufferedMessage>[2][],
  seed: GraceBufferedSessionState = createGraceBufferedSessionState(),
): GraceBufferedSessionState {
  let state = seed;
  for (const message of messages) {
    state = applyGraceBufferedMessage(state, SESSION_ID, message);
  }
  return state;
}

// AC-3. The whole point of the lane is the order, and an assertion on the final
// buffer contents passes under the wrong one.
test('grace flush applies the current server snapshot before the held tail and opens the input gate only after the tail drains', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    restore,
    output('tail-a'),
    snapshotFor(restore),
    { type: 'status', sessionId: SESSION_ID, status: 'running' },
    { type: 'cwd', sessionId: SESSION_ID, cwd: '/tmp' },
    output('tail-b'),
    output('tail-c'),
    ready(restore),
    { type: 'session:exited', sessionId: SESSION_ID, exitCode: 3 },
  ]);
  const recorded = recordingHandlers();

  flushGraceBufferedSession(state, recorded.handlers);

  // The non-barrier frames are pinned here too. Without them in the sequence,
  // `onStatus`/`onCwd`/`onError` could be reordered across the snapshot or the
  // gate and nothing would notice.
  assert.deepEqual(recorded.calls, [
    'restore-needed',
    'snapshot',
    'status',
    'cwd',
    'output:tail-a',
    'output:tail-b',
    'output:tail-c',
    'ready',
    'error',
  ]);

  // Stated as an invariant as well as a literal sequence, so a future frame
  // added to the middle cannot quietly move the snapshot or the gate.
  const snapshotAt = recorded.calls.indexOf('snapshot');
  const readyAt = recorded.calls.indexOf('ready');
  const tailIndexes = recorded.calls
    .map((call, index) => (call.startsWith('output:') ? index : -1))
    .filter(index => index >= 0);
  assert.ok(tailIndexes.length > 0);
  assert.ok(tailIndexes.every(index => index > snapshotAt), 'snapshot applies before every held chunk');
  assert.ok(tailIndexes.every(index => index < readyAt), 'the input gate opens only after the whole tail');
});

// AC-3 / AC-5. Ordering is not the whole dispatch contract. `screenSeq`,
// `chunkId` and `replayToken` are exactly what the downstream prune, dedupe and
// generation fence key on, so a flush that emits the right chunks in the right
// order but strips their identity is still broken — and invisible to an
// order-only assertion. This is also the producer-side gate for the hand-off
// described in the report: the field the downstream prune reads must survive.
test('the flush preserves chunk identity, not just chunk order', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    restore,
    snapshotFor(restore),
    output('tail', {
      screenSeq: 11,
      chunkId: 'chunk-11',
      authorityEpoch: restore.authorityEpoch,
      authorityRevision: restore.authorityRevision,
    }),
  ]);

  const seen: TerminalOutputDelivery[] = [];
  flushGraceBufferedSession(state, { onOutput: delivery => seen.push(delivery) });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.whole.screenSeq, 11);
  assert.equal(seen[0]?.whole.chunkId, 'chunk-11');
  assert.equal(seen[0]?.whole.authorityEpoch, restore.authorityEpoch);
  assert.equal(seen[0]?.whole.authorityRevision, restore.authorityRevision);
  assert.equal(seen[0]?.replayToken, restore.replayToken);
});

// AC-3. The held tail is forwarded whole and in arrival order. Dropping the
// chunks that merely *arrived* before the snapshot frame would lose output:
// during a restore the server replays the tail for the new generation, and
// those chunks straddle the snapshot frame. Coverage is proven by sequence, not
// by arrival, and that proof lives downstream in the recovery coordinator —
// `visibleOutputRecovery`'s `authoritative-snapshot-applied` / `output-arrived`
// path, covered by 'visible output recovery drops a snapshot-covered late chunk
// before cap accounting'. This lane must not pre-empt it.
test('the grace buffer holds the whole tail in arrival order and leaves snapshot-coverage pruning downstream', () => {
  const restore = restoreNeeded();
  const state = applyAll([restore, output('pre'), snapshotFor(restore), output('post')]);

  assert.deepEqual(state.output.map(entry => entry.data), ['pre', 'post']);
});

// AC-1 / AC-10: chunk cap N-1 / N / N+1 against the effective limit, not a
// literal copied into the test.
test('grace buffer admits the held tail up to the effective chunk cap and discards the generation at cap + 1', () => {
  const maxChunks = getTerminalResourceLimits().visibleOutputMaxChunks;
  const restore = restoreNeeded();

  let state = applyAll([restore, snapshotFor(restore)]);
  for (let index = 0; index < maxChunks - 1; index += 1) {
    state = applyGraceBufferedMessage(state, SESSION_ID, output('x'));
  }
  assert.equal(state.output.length, maxChunks - 1, 'cap - 1 is admitted');
  assert.equal(state.outputOverflowReason, undefined);

  state = applyGraceBufferedMessage(state, SESSION_ID, output('x'));
  assert.equal(state.output.length, maxChunks, 'exactly the cap is admitted');
  assert.equal(state.outputOverflowReason, undefined);

  state = applyGraceBufferedMessage(state, SESSION_ID, output('x'));
  assert.equal(state.outputOverflowReason, 'chunk-cap-exceeded');
  assert.equal(state.output.length, 0, 'the generation is discarded, not truncated');
  assert.equal(state.outputBytes, 0);
});

// AC-1 / AC-10: byte cap N-1 / N / N+1.
test('grace buffer admits the held tail up to the effective byte cap and discards the generation at cap + 1', () => {
  const maxBytes = getTerminalResourceLimits().visibleOutputQueueMaxBytes;
  const restore = restoreNeeded();

  let state = applyAll([restore, snapshotFor(restore), output('a'.repeat(maxBytes - 1))]);
  assert.equal(state.outputBytes, maxBytes - 1, 'cap - 1 bytes are admitted');
  assert.equal(state.outputOverflowReason, undefined);

  state = applyGraceBufferedMessage(state, SESSION_ID, output('a'));
  assert.equal(state.outputBytes, maxBytes, 'exactly the cap is admitted');
  assert.equal(state.outputOverflowReason, undefined);

  state = applyGraceBufferedMessage(state, SESSION_ID, output('a'));
  assert.equal(state.outputOverflowReason, 'byte-cap-exceeded');
  assert.equal(state.output.length, 0, 'the generation is discarded, not truncated');
  assert.equal(state.outputBytes, 0);
});

// AC-1. `.length` on a string is UTF-16 code units; the cap is bytes.
test('grace buffer accounts the held tail in UTF-8 bytes for CJK and emoji rather than UTF-16 code units', () => {
  const restore = restoreNeeded();
  const cjk = '한글터미널';
  const emoji = '🙂🙂';
  const state = applyAll([restore, snapshotFor(restore), output(cjk), output(emoji)]);

  assert.equal(state.outputBytes, getOutputUtf8ByteLength(cjk) + getOutputUtf8ByteLength(emoji));
  assert.notEqual(state.outputBytes, cjk.length + emoji.length);
});

// AC-2. Overflow converges to stale + current server restore. It must not
// silently truncate, must not flush a giant batch, and must not open the gate.
test('grace flush withholds the snapshot, the tail and ready when the held tail overflowed, and reports the overflow', () => {
  const maxChunks = getTerminalResourceLimits().visibleOutputMaxChunks;
  const restore = restoreNeeded();

  let state = applyAll([restore, snapshotFor(restore)]);
  for (let index = 0; index <= maxChunks; index += 1) {
    state = applyGraceBufferedMessage(state, SESSION_ID, output('x'));
  }
  state = applyGraceBufferedMessage(state, SESSION_ID, ready(restore));

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);

  assert.deepEqual(recorded.calls, ['restore-needed', 'overflow:chunk-cap-exceeded']);
  assert.equal(recorded.calls.includes('ready'), false, 'the input gate stays shut');
  assert.equal(recorded.calls.some(call => call.startsWith('output:')), false);
});

// AC-3. Early `session:ready` latches; it does not release input before the
// current server snapshot has arrived.
test('grace flush withholds ready while a restore is outstanding and no current server snapshot arrived', () => {
  const restore = restoreNeeded();
  const state = applyAll([restore, output('tail'), ready(restore)]);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);

  assert.deepEqual(recorded.calls, ['restore-needed']);
});

// AC-5. A chunk belonging to a superseded replay generation cannot be applied
// to the current view.
test('grace buffer drops held output from a superseded replay generation', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    restore,
    snapshotFor(restore),
    output('current'),
    output('stale', { replayToken: 'replay-0' }),
  ]);

  assert.deepEqual(state.output.map(entry => entry.data), ['current']);
});

// AC-2 / AC-5. `reconnect-required` is terminal for the generation.
test('grace flush treats reconnect-required as terminal: no snapshot, tail or ready reaches the view', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    restore,
    snapshotFor(restore),
    output('tail'),
    reconnectRequired(),
    ready(restore),
    output('after'),
  ]);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);

  assert.deepEqual(recorded.calls, ['reconnect-required']);
});

function secondGeneration(
  overrides: Partial<ScreenRepairRestoreNeededMessage> = {},
): ScreenRepairRestoreNeededMessage {
  return restoreNeeded({
    repairToken: 'repair-2',
    replayToken: 'replay-2',
    snapshotSeq: 9,
    coversThroughSeq: 9,
    authorityRevision: 4,
    ...overrides,
  });
}

// AC-5. Production reuses the map entry for a session across grace intervals —
// `bufferGraceMessage` does `get(sessionId) ?? create`. So the purge that
// matters is the in-place one on the new-generation reset, and a test that
// builds a second state object proves nothing about it. This one holds a single
// state across both generations, exactly as the caller does.
test('a new restore generation purges the previous generation held tail from the same session state', () => {
  const firstRestore = restoreNeeded();
  let state = applyAll([firstRestore, snapshotFor(firstRestore), output('first-tail')]);
  assert.deepEqual(state.output.map(entry => entry.data), ['first-tail']);

  const secondRestore = secondGeneration();
  state = applyAll(
    [
      secondRestore,
      snapshotFor(secondRestore),
      output('second-tail', { replayToken: secondRestore.replayToken }),
      ready(secondRestore),
    ],
    state,
  );

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);

  assert.deepEqual(recorded.calls, ['restore-needed', 'snapshot', 'output:second-tail', 'ready']);
  assert.equal(recorded.calls.includes('output:first-tail'), false);
  assert.equal(state.outputBytes, getOutputUtf8ByteLength('second-tail'));
});

// AC-5. The duplicate-restore short circuit must key on all three of
// repairToken / replayToken / snapshotSeq. Keying on the token alone would
// swallow a re-issued restore for a NEW generation as a duplicate, and the
// previous generation's tail would survive into it.
test('a re-issued restore with the same repair token but a new replay generation is not treated as a duplicate', () => {
  const firstRestore = restoreNeeded();
  let state = applyAll([firstRestore, snapshotFor(firstRestore), output('first-tail')]);

  const reissued = secondGeneration({ repairToken: firstRestore.repairToken });
  state = applyGraceBufferedMessage(state, SESSION_ID, reissued);

  assert.equal(state.restoreNeeded?.replayToken, reissued.replayToken);
  assert.deepEqual(state.output, [], 'the superseded generation tail is purged');
  assert.equal(state.outputBytes, 0);
  assert.equal(state.snapshot, undefined);
});

// AC-3. A replacement snapshot invalidates the ready token latched for the
// generation it replaces. Without that, the input gate opens on a stale
// generation.
test('a replacement snapshot invalidates the ready token latched for the generation it replaces', () => {
  const restore = restoreNeeded();
  let state = applyAll([restore, snapshotFor(restore), ready(restore)]);
  assert.notEqual(state.ready, undefined, 'the ready token is latched first');

  // The same generation's snapshot re-sent (a repeat of the authoritative
  // frame) must not leave the earlier ready token standing.
  state = applyGraceBufferedMessage(state, SESSION_ID, snapshotFor(restore, { data: 'SNAPSHOT-2' }));
  assert.equal(state.ready, undefined);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.equal(recorded.calls.includes('ready'), false, 'the input gate stays shut on the stale token');
});

// AC-2. `hasValidAuthorityProof` is fail-closed, and this is the branch that
// enforces it: a restore-needed frame that carries no usable proof must not
// engage the barrier on an unproven authority.
test('a restore-needed frame with no authority proof is rejected rather than engaging the barrier', () => {
  // Seed an ADOPTED generation first. Starting from a fresh state would make
  // `restoreNeeded === undefined` true before production does anything, and the
  // assertion would hold even if the invalid-proof branch stopped clearing it.
  const adopted = restoreNeeded();
  const seeded = applyAll([adopted, snapshotFor(adopted)]);
  assert.notEqual(seeded.restoreNeeded, undefined, 'precondition: a generation is adopted');

  const unproven: ScreenRepairRestoreNeededMessage = {
    ...secondGeneration(),
    authorityEpoch: undefined,
    authorityRevision: undefined,
    coversThroughSeq: undefined,
  };
  const state = applyAll([unproven, output('tail'), ready(restoreNeeded())], seeded);

  assert.equal(state.restoreNeeded, undefined, 'the unproven frame discards the adopted generation');
  assert.equal(state.snapshot, undefined);
  assert.equal(state.authorityProofMismatch, true);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.deepEqual(recorded.calls, ['proof-mismatch']);
});

// AC-2. Discarding the generation is only half the contract: it has to STAY
// discarded. A chunk arriving after the overflow must not restart accounting.
test('held output arriving after an overflow does not re-accumulate into the discarded generation', () => {
  const maxChunks = getTerminalResourceLimits().visibleOutputMaxChunks;
  const restore = restoreNeeded();

  let state = applyAll([restore, snapshotFor(restore)]);
  for (let index = 0; index <= maxChunks; index += 1) {
    state = applyGraceBufferedMessage(state, SESSION_ID, output('x'));
  }
  assert.equal(state.outputOverflowReason, 'chunk-cap-exceeded');

  state = applyGraceBufferedMessage(state, SESSION_ID, output('late'));
  assert.deepEqual(state.output, []);
  assert.equal(state.outputBytes, 0);
  assert.equal(state.outputOverflowReason, 'chunk-cap-exceeded');
});

// AC-2. `reconnect-required` is terminal, so the buffer must stop admitting —
// otherwise it keeps growing on a generation that can never be delivered.
test('held output arriving after reconnect-required is not admitted', () => {
  const restore = restoreNeeded();
  const state = applyAll([restore, snapshotFor(restore), reconnectRequired(), output('after')]);

  assert.deepEqual(state.output, []);
  assert.equal(state.outputBytes, 0);
});

// AC-2. An authority proof mismatch discards the generation and asks for a
// reconnect rather than applying a snapshot from another authority.
test('grace flush reports an authority proof mismatch and withholds the snapshot and ready', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    restore,
    snapshotFor(restore, { authorityRevision: 99 }),
    ready(restore),
  ]);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);

  assert.deepEqual(recorded.calls, ['proof-mismatch']);
});

// AC-3 / AC-5. Every other test seeds a restore, so the guards that exist only
// on the plain-grace path (no restore outstanding) had no coverage at all.
// These two drive that path directly.

test('a plain grace snapshot with no outstanding restore prunes the held prefix it covers', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    output('pre', { replayToken: restore.replayToken }),
    snapshotFor(restore),
    output('post', { replayToken: restore.replayToken }),
    ready(restore),
  ]);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);

  // Contrast with the restore path, where the prefix is kept and pruning is
  // left downstream: with no restore outstanding the snapshot is the whole
  // current view, so anything held before it is already covered.
  assert.deepEqual(recorded.calls, ['snapshot', 'output:post', 'ready']);
  assert.equal(state.outputBytes, getOutputUtf8ByteLength('post'));
});

test('a plain grace ready for a generation other than the buffered snapshot does not open the input gate', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    snapshotFor(restore),
    ready(restore, { replayToken: 'replay-other' }),
  ]);

  assert.equal(state.ready, undefined);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.deepEqual(recorded.calls, ['snapshot']);
});

// AC-2 / AC-7 bounded convergence. Resetting the generation has to clear the
// terminal flags too. If `outputOverflowReason` or `authorityProofMismatch`
// survives into the next generation, a fully converged generation never opens
// the gate — a permanent input block, not a bounded resync.

test('a new generation after an overflow converges and opens the input gate', () => {
  const maxChunks = getTerminalResourceLimits().visibleOutputMaxChunks;
  const first = restoreNeeded();
  let state = applyAll([first, snapshotFor(first)]);
  for (let index = 0; index <= maxChunks; index += 1) {
    state = applyGraceBufferedMessage(state, SESSION_ID, output('x'));
  }
  assert.equal(state.outputOverflowReason, 'chunk-cap-exceeded');

  const second = secondGeneration();
  state = applyAll(
    [second, snapshotFor(second), output('tail', { replayToken: second.replayToken }), ready(second)],
    state,
  );
  assert.equal(state.outputOverflowReason, undefined);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.deepEqual(recorded.calls, ['restore-needed', 'snapshot', 'output:tail', 'ready']);
});

test('a new generation after an authority proof mismatch converges and opens the input gate', () => {
  const first = restoreNeeded();
  let state = applyAll([first, snapshotFor(first, { authorityRevision: 99 })]);
  assert.equal(state.authorityProofMismatch, true);

  const second = secondGeneration();
  state = applyAll(
    [second, snapshotFor(second), output('tail', { replayToken: second.replayToken }), ready(second)],
    state,
  );
  assert.equal(state.authorityProofMismatch, false);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.deepEqual(recorded.calls, ['restore-needed', 'snapshot', 'output:tail', 'ready']);
});

// AC-2 / AC-5. Guards that survive deletion because no test drives the state
// they fence against.

test('a snapshot arriving after an authority proof mismatch is not adopted', () => {
  const restore = restoreNeeded();
  let state = applyAll([restore, snapshotFor(restore, { authorityRevision: 99 })]);
  assert.equal(state.authorityProofMismatch, true);

  // A well-formed snapshot for the latched generation must still be refused:
  // the mismatch is terminal until a new restore generation resets it.
  state = applyGraceBufferedMessage(state, SESSION_ID, snapshotFor(restore));
  assert.equal(state.snapshot, undefined);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.deepEqual(recorded.calls, ['proof-mismatch']);
});

test('a snapshot proof mismatch discards the held tail and its byte accounting', () => {
  const restore = restoreNeeded();
  let state = applyAll([restore, snapshotFor(restore), output('held')]);
  assert.equal(state.outputBytes, getOutputUtf8ByteLength('held'));

  state = applyGraceBufferedMessage(state, SESSION_ID, snapshotFor(restore, { authorityRevision: 99 }));

  // Stale byte accounting would inflate the next generation's cap usage and
  // trip an overflow that never happened.
  assert.deepEqual(state.output, []);
  assert.equal(state.outputBytes, 0);
});

test('a restore-needed arriving after reconnect-required is ignored', () => {
  const restore = restoreNeeded();
  const state = applyAll([reconnectRequired(), restore, output('after')]);

  assert.equal(state.restoreNeeded, undefined, 'reconnect-required is terminal for the generation');
  assert.notEqual(state.reconnectRequired, undefined);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.deepEqual(recorded.calls, ['reconnect-required']);
});

// AC-3. `subscribedInfo` carries the server's own ready flag. While recovery is
// blocked it must be forced false, or the view is told it is ready by a second
// route while the barrier holds the first.
test('subscribed ready is forced false while recovery is blocked and passes through once it is not', () => {
  const restore = restoreNeeded();
  const blocked = applyAll([restore]);
  blocked.subscribedInfo = { status: 'running', ready: true };
  const blockedRecorded = recordingHandlers();
  flushGraceBufferedSession(blocked, blockedRecorded.handlers);
  assert.deepEqual(blockedRecorded.calls, ['restore-needed', 'subscribed:ready=false']);

  const clear = createGraceBufferedSessionState();
  clear.subscribedInfo = { status: 'running', ready: true };
  const clearRecorded = recordingHandlers();
  flushGraceBufferedSession(clear, clearRecorded.handlers);
  assert.deepEqual(clearRecorded.calls, ['subscribed:ready=true']);
});

// The `input:rejected` case has no effect on buffered state — it exists purely
// to record that the server rejected input while the view was detached. An
// assertion on state cannot see it, so observe the debug event itself.
test('input:rejected is recorded while detached and does not mutate the buffered generation', () => {
  // The debug recorder stamps every event with `getInputReliabilityMode()`,
  // which reads `window.location.hostname` and then `localStorage`. Both are
  // shimmed here — minimally, and torn down at the end — because the recorder's
  // side effect is the only observable this case has.
  (globalThis as { window?: unknown }).window = { location: { hostname: 'localhost' } };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  // Force lazy store construction, then enable capture for this session only.
  recordTerminalDebugEvent(SESSION_ID, 'test_bootstrap');
  const store = (globalThis as unknown as {
    window: { __buildergateTerminalDebug: { enable(id: string): void; events: { kind: string }[] } };
  }).window.__buildergateTerminalDebug;
  store.enable(SESSION_ID);

  const restore = restoreNeeded();
  const before = applyAll([restore, snapshotFor(restore), output('tail')]);
  const snapshotOfState = JSON.stringify(before);

  const after = applyGraceBufferedMessage(before, SESSION_ID, {
    type: 'input:rejected',
    sessionId: SESSION_ID,
    reason: 'queue-overflow',
  });

  assert.equal(JSON.stringify(after), snapshotOfState, 'buffered generation is untouched');
  assert.equal(store.events.some(event => event.kind === 'server_input_rejected'), true);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

// AC-3 / AC-5. The restore-branch ready fence is a conjunction; only its
// `replayToken` half was gated. A ready carrying the right token but the wrong
// snapshot sequence is a different generation and must not latch.
test('a ready for the right replay token but the wrong snapshot sequence does not latch', () => {
  const restore = restoreNeeded();
  const state = applyAll([
    restore,
    snapshotFor(restore),
    ready(restore, { snapshotSeq: 999 }),
  ]);

  assert.equal(state.ready, undefined);

  const recorded = recordingHandlers();
  flushGraceBufferedSession(state, recorded.handlers);
  assert.equal(recorded.calls.includes('ready'), false, 'the input gate stays shut');
});

// The repair cases are pure debug side effects, exactly like `input:rejected`.
// The argument that justified observing that one through the debug store
// applies here too: a state assertion cannot see them.
test('screen-repair and screen-repair:rejected are recorded while detached and do not mutate the generation', () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: 'localhost' } };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  recordTerminalDebugEvent(SESSION_ID, 'test_bootstrap');
  const store = (globalThis as unknown as {
    window: { __buildergateTerminalDebug: { enable(id: string): void; events: { kind: string }[] } };
  }).window.__buildergateTerminalDebug;
  store.enable(SESSION_ID);

  const restore = restoreNeeded();
  const before = applyAll([restore, snapshotFor(restore), output('tail')]);
  const frozen = JSON.stringify(before);

  let after = applyGraceBufferedMessage(before, SESSION_ID, {
    type: 'screen-repair',
    sessionId: SESSION_ID,
    repairToken: restore.repairToken,
    seq: restore.snapshotSeq,
    cols: 80,
    rows: 24,
    bufferType: 'normal',
    cursor: { x: 0, y: 0 },
    viewportRows: [],
    ansiPatch: '',
    source: 'headless',
  });
  after = applyGraceBufferedMessage(after, SESSION_ID, {
    type: 'screen-repair:rejected',
    sessionId: SESSION_ID,
    repairToken: restore.repairToken,
    reason: 'apply-rejected',
  });

  assert.equal(JSON.stringify(after), frozen, 'buffered generation is untouched');
  assert.equal(
    store.events.filter(event => event.kind === 'screen_repair_grace_buffer_skipped').length,
    2,
    'both repair frames are recorded as skipped',
  );
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
