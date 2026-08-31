import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  markRetainedHeadlessSourceSequence,
  readRetainedHeadlessBufferMetrics,
  resizeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  writeHeadlessTerminal,
} from './headlessTerminal.js';

test('REL-BGSTAB-011 AC-2 same-line source identities use one bounded retained marker range', async () => {
  const state = createHeadlessTerminalState({ cols: 80, rows: 4, scrollbackLines: 8 });
  try {
    await writeHeadlessTerminal(state, 'prompt repaint');
    for (let sourceSeq = 1; sourceSeq <= 10_000; sourceSeq += 1) {
      assert.equal(markRetainedHeadlessSourceSequence(state, '1', String(sourceSeq)), true);
    }

    const metrics = readRetainedHeadlessBufferMetrics(state);
    assert.equal(metrics.trackedSourceRanges, 1);
    assert.ok(metrics.trackedSourceRanges <= metrics.currentPhysicalRows);
    assert.equal(metrics.oldestRetainedSeq, '1');
    assert.equal(metrics.oldestRetainedStreamEpoch, '1');
    assert.equal(metrics.sourceMarkerCoverage, 'complete');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('REL-BGSTAB-011 AC-2 source range eviction preserves the truthful oldest retained boundary', async () => {
  const state = createHeadlessTerminalState({ cols: 8, rows: 2, scrollbackLines: 1 });
  try {
    await writeHeadlessTerminal(state, 'first');
    assert.equal(markRetainedHeadlessSourceSequence(state, '1', '1'), true);
    assert.equal(markRetainedHeadlessSourceSequence(state, '1', '2'), true);

    await writeHeadlessTerminal(state, '\r\nsecond');
    assert.equal(markRetainedHeadlessSourceSequence(state, '1', '3'), true);
    await writeHeadlessTerminal(state, '\r\nthird');
    assert.equal(markRetainedHeadlessSourceSequence(state, '1', '4'), true);
    await writeHeadlessTerminal(state, '\r\nfourth');
    assert.equal(markRetainedHeadlessSourceSequence(state, '1', '5'), true);

    const metrics = readRetainedHeadlessBufferMetrics(state);
    assert.ok(metrics.trackedSourceRanges <= metrics.currentPhysicalRows);
    assert.equal(metrics.oldestRetainedSeq, '3');
    assert.equal(metrics.oldestRetainedStreamEpoch, '1');
    assert.equal(metrics.sourceMarkerCoverage, 'complete');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

// ---------------------------------------------------------------------------
// `06 §S4-0b` #4 — why the `0x04` prologue carries the cursor as uint32.
// ---------------------------------------------------------------------------

const UINT16_MAX = 65535;

test('the retained cursor can exceed uint16, so the wire field cannot shrink to one', async () => {
  // Nothing on the server bounds a resize: `WsRouter.handleResize` passes the
  // client's `cols`/`rows` straight to `SessionManager.resize`, and
  // `VALIDATION_LIMITS.MAX_COLS`/`MAX_ROWS` have no use sites at all. xterm does
  // not clamp either. Narrowing `retainedCursorX` to uint16 to save 8 bytes of
  // prologue would therefore truncate a reachable value — and a truncated
  // cursor does not surface as a wrong cursor, it surfaces as a digest
  // mismatch and a recovery loop.
  const state = createHeadlessTerminalState({ cols: 80, rows: 4, scrollbackLines: 8 });
  try {
    resizeHeadlessTerminal(state, 70_000, 4);
    await writeHeadlessTerminal(state, 'x'.repeat(69_999));

    const checkpoint = serializeRetainedHeadlessCheckpoint(state);

    assert.ok(
      checkpoint.cursor.x > UINT16_MAX,
      `cursor.x was ${checkpoint.cursor.x}; a bound now exists and this decision can be revisited`,
    );
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('BOUNDARY CONTROL — a terminal within uint16 keeps its cursor within uint16', async () => {
  // Without this the test above would also pass if `cursor.x` were some
  // unrelated always-large number.
  const state = createHeadlessTerminalState({ cols: 500, rows: 4, scrollbackLines: 8 });
  try {
    await writeHeadlessTerminal(state, 'x'.repeat(499));

    const checkpoint = serializeRetainedHeadlessCheckpoint(state);

    assert.ok(checkpoint.cursor.x <= UINT16_MAX);
    assert.equal(checkpoint.cursor.x, 499);
  } finally {
    disposeHeadlessTerminal(state);
  }
});
