import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  markRetainedHeadlessSourceSequence,
  readHeadlessTerminalText,
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

// PERF-BGSTAB-018: the retained row metrics used to re-walk the WHOLE scrollback on every
// onScroll and on every output record (translateToString + byteLength per line). A full-screen
// redraw storm (Codex's TUI) therefore cost lines-written x scrollback and pinned the server at
// one core until it stopped answering (measured: /health timed out; 73% of CPU in
// captureRetainedPhysicalRows). Rows above the viewport are immutable, so only the viewport
// needs recomputing.

function referenceMetrics(state: ReturnType<typeof createHeadlessTerminalState>) {
  const buffer = state.terminal.buffer.normal;
  const rows: Array<{ wrapped: boolean; utf8Bytes: number }> = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    rows.push({ wrapped: line?.isWrapped ?? false, utf8Bytes: Buffer.byteLength(line?.translateToString(true) ?? '', 'utf8') });
  }
  let logical = rows.length === 0 ? 0 : 1;
  for (let i = 1; i < rows.length; i += 1) if (!rows[i]!.wrapped) logical += 1;
  return {
    currentPhysicalRows: rows.length,
    currentLogicalRows: logical,
    currentUtf8Bytes: rows.reduce((total, row) => total + row.utf8Bytes, 0),
  };
}

test('PERF-BGSTAB-018 AC-1: incremental retained metrics equal a full recount through writes, redraws, wraps, trims and resize', async () => {
  const state = createHeadlessTerminalState({ cols: 20, rows: 5, scrollbackLines: 30 });
  try {
    const steps = [
      'hello\r\nworld\r\n',
      'x'.repeat(55) + '\r\n',
      '\x1b[H\x1b[2J' + 'redraw-1\r\nline\r\n',
      Array.from({ length: 40 }, (_, i) => `row-${i}`).join('\r\n') + '\r\n',
      '\x1b[3;1H' + '가나다라마바사'.repeat(4),
      '\x1b[H\x1b[2J' + 'redraw-2 ' + 'y'.repeat(30) + '\r\n',
    ];
    for (const chunk of steps) {
      await writeHeadlessTerminal(state, chunk);
      const metrics = readRetainedHeadlessBufferMetrics(state);
      const expected = referenceMetrics(state);
      assert.equal(metrics.currentPhysicalRows, expected.currentPhysicalRows, `rows after ${JSON.stringify(chunk.slice(0, 12))}`);
      assert.equal(metrics.currentLogicalRows, expected.currentLogicalRows);
      assert.equal(metrics.currentUtf8Bytes, expected.currentUtf8Bytes);
    }
    resizeHeadlessTerminal(state, 11, 5);
    await writeHeadlessTerminal(state, 'after-resize '.repeat(3) + '\r\n');
    const metrics = readRetainedHeadlessBufferMetrics(state);
    const expected = referenceMetrics(state);
    assert.equal(metrics.currentPhysicalRows, expected.currentPhysicalRows);
    assert.equal(metrics.currentUtf8Bytes, expected.currentUtf8Bytes);
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('PERF-BGSTAB-018 AC-2: keeping metrics current costs the viewport, not the scrollback', async () => {
  const state = createHeadlessTerminalState({ cols: 40, rows: 10, scrollbackLines: 5000 });
  try {
    await writeHeadlessTerminal(state, Array.from({ length: 4000 }, (_, i) => `seed-${i}`).join('\r\n') + '\r\n');
    readRetainedHeadlessBufferMetrics(state);
    const buffer = state.terminal.buffer.normal;
    const proto = Object.getPrototypeOf(buffer) as { getLine: (y: number) => unknown };
    const original = proto.getLine;
    let calls = 0;
    proto.getLine = function (this: unknown, y: number) { calls += 1; return original.call(this, y); };
    try {
      for (let frame = 0; frame < 20; frame += 1) {
        await writeHeadlessTerminal(state, Array.from({ length: 10 }, (_, i) => `frame-${frame}-${i}`).join('\r\n') + '\r\n');
        readRetainedHeadlessBufferMetrics(state);
      }
    } finally {
      proto.getLine = original;
    }
    // 20 frames x 10 lines = 200 scrolls plus 20 reads. A full recount would be ~4000 lines each.
    assert.ok(calls < 20_000, `getLine was called ${calls} times; the scrollback is being re-walked`);
  } finally {
    disposeHeadlessTerminal(state);
  }
});

// PERF-BGSTAB-019: xterm defers each write to a timer tick, and on Windows a tick is ~15.6 ms, so
// the serialized headless queue capped a session near 64 chunks/s. Codex's ~54 chunks/s shimmer
// backlogged the queue until restore snapshots failed and the socket reconnect-looped.
test('PERF-BGSTAB-019 AC-1 a headless write is applied before writeHeadlessTerminal returns', () => {
  const state = createHeadlessTerminalState({ cols: 20, rows: 5, scrollbackLines: 100 });
  try {
    void writeHeadlessTerminal(state, 'Q');
    const line = state.terminal.buffer.active.getLine(0)?.translateToString(true);
    assert.equal(line, 'Q');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('PERF-BGSTAB-019 AC-2 consecutive writes keep their order', async () => {
  const state = createHeadlessTerminalState({ cols: 20, rows: 5, scrollbackLines: 100 });
  try {
    await Promise.all(['a', 'b', 'c'].map((ch) => writeHeadlessTerminal(state, ch)));
    assert.equal(state.terminal.buffer.active.getLine(0)?.translateToString(true), 'abc');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('FR-MCP-008 AC-4: readHeadlessTerminalText returns the last lines as plain text', async () => {
  const state = createHeadlessTerminalState({ cols: 10, rows: 4, scrollbackLines: 50 });
  try {
    await writeHeadlessTerminal(state, '\x1b[31mred\x1b[0m\r\none\r\ntwo\r\nabcdefghijKLM\r\n$ ');
    // Wrapped rows join into one logical line, colors are dropped, trailing blanks trimmed.
    assert.equal(readHeadlessTerminalText(state, 3), 'two\nabcdefghijKLM\n$');
    assert.equal(readHeadlessTerminalText(state, 100), 'red\none\ntwo\nabcdefghijKLM\n$');
    assert.equal(readHeadlessTerminalText(state, 0), '');
  } finally {
    disposeHeadlessTerminal(state);
  }
});
