// PERF-BGSTAB-030: the foreground terminal writes arriving output at once, within a run allowance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FOREGROUND_RUN_BURST,
  FOREGROUND_RUN_REFILL_MS,
  createTerminalRenderThrottle,
} from '../../src/utils/terminalRenderThrottle.ts';
import { createTerminalOutputScheduler } from '../../src/utils/terminalOutputScheduler.ts';

function harness() {
  let now = 0;
  const frames: Array<() => void> = [];
  const microtasks: Array<() => void> = [];
  const throttle = createTerminalRenderThrottle({
    now: () => now,
    queueMicrotask: (run) => { microtasks.push(run); },
    requestFrame: (run) => { frames.push(run); },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return {
    throttle,
    advance: (ms: number) => { now += ms; },
    runMicrotasks: () => { while (microtasks.length) microtasks.shift()!(); },
    runFrames: () => { for (const run of frames.splice(0)) run(); },
    pendingFrames: () => frames.length,
    pendingMicrotasks: () => microtasks.length,
  };
}

function foreground(h: ReturnType<typeof harness>) {
  const lane = h.throttle.register('fg');
  lane.setVisible(true);
  h.throttle.noteFocus('fg');
  let runs = 0;
  return { lane, runs: () => runs, flush: () => lane.schedule(() => { runs += 1; }) };
}

test('PERF-BGSTAB-030 AC-1: a foreground flush runs in a microtask, before any frame', () => {
  const h = harness();
  const fg = foreground(h);
  fg.flush();
  assert.equal(fg.runs(), 0, 'not synchronously inside schedule()');
  assert.equal(h.pendingFrames(), 0, 'no animation frame is requested');
  h.runMicrotasks();
  assert.equal(fg.runs(), 1);
});

test('PERF-BGSTAB-030 AC-2: the two frames of a shell echo both run at once', () => {
  const h = harness();
  const fg = foreground(h);
  fg.flush(); h.runMicrotasks();
  h.advance(3);
  fg.flush(); h.runMicrotasks();
  assert.equal(fg.runs(), 2);
  assert.equal(h.pendingFrames(), 0);
});

test('PERF-BGSTAB-030 AC-3: past the burst allowance, flushes wait for the animation frame', () => {
  const h = harness();
  const fg = foreground(h);
  for (let i = 0; i < FOREGROUND_RUN_BURST + 2; i += 1) { fg.flush(); h.runMicrotasks(); }
  assert.equal(fg.runs(), FOREGROUND_RUN_BURST);
  assert.equal(h.pendingFrames(), 1, 'the rest is paced by animation frames');
  h.advance(FOREGROUND_RUN_REFILL_MS);
  h.runFrames();
  assert.equal(fg.runs(), FOREGROUND_RUN_BURST + 1);
});

test('PERF-BGSTAB-030 AC-4: the allowance refills one run per frame interval', () => {
  const h = harness();
  const fg = foreground(h);
  for (let i = 0; i < FOREGROUND_RUN_BURST; i += 1) { fg.flush(); h.runMicrotasks(); }
  h.advance(FOREGROUND_RUN_REFILL_MS);
  fg.flush(); h.runMicrotasks();
  assert.equal(fg.runs(), FOREGROUND_RUN_BURST + 1, 'one run came back');
  fg.flush(); h.runMicrotasks();
  assert.equal(fg.runs(), FOREGROUND_RUN_BURST + 1, 'only one');
  assert.equal(h.pendingFrames(), 1);
});

test('PERF-BGSTAB-030 AC-3: a frame that comes before a run is due waits for the next one', () => {
  const h = harness();
  const fg = foreground(h);
  for (let i = 0; i < FOREGROUND_RUN_BURST + 1; i += 1) { fg.flush(); h.runMicrotasks(); }
  h.advance(FOREGROUND_RUN_REFILL_MS / 2);
  h.runFrames();
  assert.equal(fg.runs(), FOREGROUND_RUN_BURST, 'a 120 Hz frame does not double the pace');
  assert.equal(h.pendingFrames(), 1);
  h.advance(FOREGROUND_RUN_REFILL_MS / 2);
  h.runFrames();
  assert.equal(fg.runs(), FOREGROUND_RUN_BURST + 1);
});

test('PERF-BGSTAB-030 AC-3: a flush asked for from inside a drain waits for the frame', () => {
  const h = harness();
  const lane = h.throttle.register('fg');
  lane.setVisible(true);
  let runs = 0;
  // The output scheduler does this when input is pending: it yields and asks for another flush.
  const drain = (): void => { runs += 1; if (runs === 1) lane.schedule(drain); };
  lane.schedule(drain);
  h.runMicrotasks();
  assert.equal(runs, 1, 'the yield is not undone by a microtask in the same task');
  assert.equal(h.pendingFrames(), 1);
  h.runFrames();
  assert.equal(runs, 2);
});

test('PERF-BGSTAB-030 AC-5: a background lane is not written at once', () => {
  const h = harness();
  foreground(h);
  const bg = h.throttle.register('bg');
  bg.setVisible(true);
  let bgRuns = 0;
  bg.schedule(() => { bgRuns += 1; });
  h.runMicrotasks();
  assert.equal(bgRuns, 0, 'it waits for a frame, as PERF-BGSTAB-027 says');
  h.runFrames();
  assert.equal(bgRuns, 1);
});

test('PERF-BGSTAB-030 AC-5: a lane that lost the foreground before its microtask ran is treated as background', () => {
  const h = harness();
  const fg = foreground(h);
  const other = h.throttle.register('other');
  other.setVisible(true);
  fg.flush(); h.runMicrotasks();
  h.advance(5);
  fg.flush();
  h.throttle.noteFocus('other');
  h.runMicrotasks();
  assert.equal(fg.runs(), 1, 'not written at once: it is a background lane now');
});

test('PERF-BGSTAB-030 AC-6: a flush scheduled while one waits replaces it and runs once', () => {
  const h = harness();
  const lane = h.throttle.register('fg');
  lane.setVisible(true);
  const ran: string[] = [];
  lane.schedule(() => ran.push('first'));
  lane.schedule(() => ran.push('second'));
  assert.equal(h.pendingMicrotasks(), 1);
  h.runMicrotasks();
  assert.deepEqual(ran, ['second']);
});

test('PERF-BGSTAB-030: a lane disposed before its microtask does not run', () => {
  const h = harness();
  const fg = foreground(h);
  fg.flush();
  fg.lane.dispose();
  h.runMicrotasks();
  assert.equal(fg.runs(), 0);
});

// The real output scheduler behind the throttle, with real timers: xterm's write callback is a
// 1 ms macrotask, an animation frame is 16 ms. A flood must stay paced by frames.
test('PERF-BGSTAB-030 AC-3: a flood on the foreground terminal starts about one flush chain per frame', async () => {
  const throttle = createTerminalRenderThrottle({ requestFrame: (run) => { setTimeout(run, 16); } });
  const lane = throttle.register('fg');
  lane.setVisible(true);
  let flushes = 0;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 4_194_304,
    visibleOutputMaxChunks: 512,
    visibleFlushBudgetBytes: 262_144,
    visibleFlushFrameBudgetMs: 7,
    write: (_chunk, onWritten) => { setTimeout(onWritten, 1); },
    schedule: (drain) => lane.schedule(() => { flushes += 1; drain(); }),
  });
  let sent = 0;
  let written = 0;
  const feed = setInterval(() => { for (let i = 0; i < 4; i += 1) { sent += 1; scheduler.enqueue('x'.repeat(400), () => { written += 1; }); } }, 2);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  clearInterval(feed);
  const flushesInOneSecond = flushes;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  lane.dispose();
  // 1000 ms / 16 ms is 62 frames; the burst allowance adds a few.
  assert.ok(flushesInOneSecond <= 62 + FOREGROUND_RUN_BURST + 6, `started ${flushesInOneSecond} flush chains in 1 s`);
  assert.ok(flushesInOneSecond >= 30, `started only ${flushesInOneSecond} flush chains in 1 s`);
  assert.ok(sent > 0 && written > 0);
});
