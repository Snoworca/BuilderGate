// PERF-BGSTAB-031: the retained-row metrics keep their values and stop costing O(scrollback).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  markRetainedHeadlessSourceSequence,
  readRetainedHeadlessBufferMetrics,
  resizeHeadlessTerminal,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from './headlessTerminal.js';

const GOLDEN = new URL('./headlessRetainedMetrics.golden.json', import.meta.url);

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

/** A full recount straight from the xterm buffer, independent of the tracker. */
function recount(state: HeadlessTerminalState): { physical: number; logical: number; bytes: number; leadingWrapped: boolean } {
  const buffer = state.terminal.buffer.normal;
  let logical = 0; let bytes = 0;
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (y === 0 || !line?.isWrapped) logical += 1;
    bytes += Buffer.byteLength(line?.translateToString(true) ?? '', 'utf8');
  }
  return { physical: buffer.length, logical: buffer.length === 0 ? 0 : logical, bytes, leadingWrapped: buffer.getLine(0)?.isWrapped ?? false };
}

async function scenario(seed: number, scrollbackLines: number, cols = 40, rows = 8): Promise<string[]> {
  const random = prng(seed);
  const state = createHeadlessTerminalState({ cols, rows, scrollbackLines });
  const out: string[] = [];
  const pieces = ['short', 'x'.repeat(95), '한글 wide 문자 ' + '가'.repeat(30), '', 'tab\there', '\x1b[31mred\x1b[0m'];
  try {
    for (let step = 0; step < 260; step += 1) {
      const r = random();
      let data = '';
      if (r < 0.03) data = '\x1b[3J';
      else if (r < 0.06) {
        // Read first: a resize counts the rows it trims as they are now, where the previous
        // implementation counted them as the last scroll or read left them. After a read the two agree.
        readRetainedHeadlessBufferMetrics(state);
        resizeHeadlessTerminal(state, 20 + Math.floor(random() * 60), 4 + Math.floor(random() * 10));
      }
      else if (r < 0.1) data = '\x1b[?1049h alt screen \r\n\x1b[?1049l';
      // Lines inserted and deleted inside the buffer move the source ranges below them.
      else if (r < 0.14) data = `\x1b[${1 + Math.floor(random() * 3)}A\x1b[${random() < 0.5 ? 'L' : 'M'}moved\r\n`;
      else if (r < 0.18) data = `\x1b[2;${4 + Math.floor(random() * 3)}r\x1b[2;1H${'region\r\n'.repeat(1 + Math.floor(random() * 8))}\x1b[r\x1b[99;1H`;
      else if (r < 0.2) data = `\x1b[${1 + Math.floor(random() * 4)}Aup`;
      // An erase drops the source ranges of the lines it resets, with no line event.
      else if (r < 0.25) data = `\x1b[${Math.floor(random() * 4)}A\x1b[${Math.floor(random() * 3)}J`;
      else if (r < 0.27) data = '\x1b[H\x1b[2J';
      else if (r < 0.3) data = `\x1b[${1 + Math.floor(random() * 3)}${random() < 0.5 ? 'S' : 'T'}`;
      else if (r < 0.32) data = '\x1b[H\x1bM\x1bM';
      else {
        const lines = 1 + Math.floor(random() * 6);
        for (let i = 0; i < lines; i += 1) data += pieces[Math.floor(random() * pieces.length)] + (random() < 0.85 ? '\r\n' : '');
      }
      if (data) await writeHeadlessTerminal(state, data);
      markRetainedHeadlessSourceSequence(state, step < 150 ? 'epoch' : 'later', String(step));
      if (random() < 0.2) markRetainedHeadlessSourceSequence(state, 'epoch', String(Math.floor(random() * step)));
      // Not every chunk is followed by a read; the rows must come out right either way.
      if (random() < 0.25) continue;
      const metrics = readRetainedHeadlessBufferMetrics(state);
      const truth = recount(state);
      assert.equal(metrics.currentPhysicalRows, truth.physical, `physical rows at step ${step}`);
      assert.equal(metrics.currentLogicalRows, truth.logical, `logical rows at step ${step}`);
      assert.equal(metrics.currentUtf8Bytes, truth.bytes, `bytes at step ${step}`);
      assert.equal(metrics.leadingRowWrapped, truth.leadingWrapped, `leading row at step ${step}`);
      out.push(JSON.stringify(metrics));
    }
  } finally {
    disposeHeadlessTerminal(state);
  }
  return out;
}

test('PERF-BGSTAB-031 AC-1: metrics equal a full recount and the recorded values of the previous implementation', async () => {
  const digests: Record<string, string> = {};
  const cases = [[1, 0, 40, 8], [2, 5, 40, 8], [3, 30, 20, 5], [4, 200, 80, 24], [5, 1000, 40, 8], [6, 60, 33, 6], [7, 1, 12, 4], [8, 300, 40, 8]] as const;
  for (const [seed, scrollback, cols, rows] of cases) {
    const lines = await scenario(seed, scrollback, cols, rows);
    digests[`seed${seed}-scrollback${scrollback}-${cols}x${rows}`] = createHash('sha256').update(lines.join('\n')).digest('hex');
  }
  if (process.env.WRITE_RETAINED_METRICS_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(digests, null, 2)}\n`);
  assert.ok(existsSync(GOLDEN), 'the golden file recorded from the previous implementation is missing');
  assert.deepEqual(digests, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});

test('PERF-BGSTAB-031 AC-1: a scrollback clear inside a chunk reads the first viewport row as the last scroll left it', async () => {
  const state = createHeadlessTerminalState({ cols: 40, rows: 8, scrollbackLines: 200 });
  try {
    // Twelve lines, then the cursor goes back up: the rows under it exist and are not wrapped.
    await writeHeadlessTerminal(state, `${'a\r\n'.repeat(12)}\x1b[5A`);
    readRetainedHeadlessBufferMetrics(state);
    // One chunk: a line of ten rows turns those rows into continuations and scrolls four times,
    // then the scrollback is cleared. The first viewport row is one that the read above saw
    // as not wrapped; the last scroll saw it as a continuation, and that is what counts.
    await writeHeadlessTerminal(state, `${'x'.repeat(40 * 10)}\x1b[3J`);
    const metrics = readRetainedHeadlessBufferMetrics(state);
    assert.equal(metrics.leadingRowWrapped, true);
    assert.equal(metrics.completeLogicalRowBoundary, false, 'the clear cut a logical row in two');
    assert.equal(metrics.evictedLogicalRows, 7, 'the seven rows above the long line');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('PERF-BGSTAB-031 AC-1: erasing the screen drops the source ranges of the erased lines', async () => {
  const state = createHeadlessTerminalState({ cols: 40, rows: 8, scrollbackLines: 100 });
  try {
    await writeHeadlessTerminal(state, 'one\r\n');
    markRetainedHeadlessSourceSequence(state, 'e', '1');
    await writeHeadlessTerminal(state, 'two\r\n');
    markRetainedHeadlessSourceSequence(state, 'e', '2');
    await writeHeadlessTerminal(state, '\x1b[2J');
    markRetainedHeadlessSourceSequence(state, 'e', '3');
    const metrics = readRetainedHeadlessBufferMetrics(state);
    assert.equal(metrics.oldestRetainedSeq, '3');
    assert.equal(metrics.trackedSourceRanges, 1);
    assert.equal(metrics.sourceMarkerCoverage, 'partial', 'every earlier range was lost at once');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('PERF-BGSTAB-031 AC-4: after a terminal reset the rows and the source ranges are tracked on the new buffer', async () => {
  const state = createHeadlessTerminalState({ cols: 40, rows: 8, scrollbackLines: 20 });
  try {
    for (let i = 0; i < 40; i += 1) {
      await writeHeadlessTerminal(state, `before ${i}\r\n`);
      markRetainedHeadlessSourceSequence(state, 'e', `b${i}`);
    }
    const before = readRetainedHeadlessBufferMetrics(state);
    await writeHeadlessTerminal(state, '\x1bc');
    const reset = readRetainedHeadlessBufferMetrics(state);
    assert.equal(reset.trackedSourceRanges, 0, 'the reset removed the rows the ranges were on');
    assert.equal(reset.sourceMarkerCoverage, 'partial');
    assert.equal(reset.trimTracking, 'xterm-line-events');
    for (let i = 0; i < 150; i += 1) {
      await writeHeadlessTerminal(state, `line ${i}\r\n`);
      assert.equal(markRetainedHeadlessSourceSequence(state, 'e', String(i)), true);
    }
    const metrics = readRetainedHeadlessBufferMetrics(state);
    const truth = recount(state);
    assert.equal(metrics.currentPhysicalRows, truth.physical);
    assert.equal(metrics.currentUtf8Bytes, truth.bytes);
    assert.equal(metrics.currentLogicalRows, truth.logical);
    // 28 rows are held (20 of scrollback and the viewport); the last is the empty cursor row.
    assert.equal(metrics.oldestRetainedSeq, '122');
    assert.equal(metrics.trackedSourceRanges, 28);
    assert.equal(metrics.evictedPhysicalRows - before.evictedPhysicalRows, 123, 'trims on the new buffer are counted');
  } finally {
    disposeHeadlessTerminal(state);
  }
});

async function microsecondsPerLine(scrollbackLines: number): Promise<number> {
  const state = createHeadlessTerminalState({ cols: 120, rows: 30, scrollbackLines });
  const line = (i: number): string => `line ${i} ${'x'.repeat(90)}\r\n`;
  try {
    // Fill the scrollback one marked line at a time, so there is a source range for every row.
    for (let i = 0; i < scrollbackLines + 60; i += 1) {
      await writeHeadlessTerminal(state, line(i));
      markRetainedHeadlessSourceSequence(state, 'fill', String(i));
    }
    readRetainedHeadlessBufferMetrics(state);
    const started = performance.now();
    for (let chunk = 0; chunk < 1500; chunk += 1) {
      await writeHeadlessTerminal(state, line(chunk));
      markRetainedHeadlessSourceSequence(state, 'epoch', String(chunk));
      readRetainedHeadlessBufferMetrics(state);
    }
    return (performance.now() - started) * 1000 / 1500;
  } finally {
    disposeHeadlessTerminal(state);
  }
}

test('PERF-BGSTAB-031 AC-2: a line costs about the same at 10,000 scrollback rows as at 1,000', async () => {
  // Each round measures both sizes one after the other, and the best round counts: a slow
  // round is the machine, and it slows both sizes of that round together.
  let best = { ratio: Number.POSITIVE_INFINITY, small: 0, large: 0 };
  for (let round = 0; round < 4; round += 1) {
    const small = await microsecondsPerLine(1000);
    const large = await microsecondsPerLine(10_000);
    if (large / small < best.ratio) best = { ratio: large / small, small, large };
  }
  console.log(`[PERF-BGSTAB-031] ${best.small.toFixed(1)} us/line at 1,000 rows, ${best.large.toFixed(1)} us/line at 10,000 rows`);
  assert.ok(best.ratio <= 1.5, `${best.large.toFixed(1)} us/line at 10,000 rows vs ${best.small.toFixed(1)} at 1,000`);
});
