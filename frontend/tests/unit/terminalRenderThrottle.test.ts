// PERF-BGSTAB-027: a page-wide throttle for terminal output flushes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKGROUND_BURST_MS,
  BACKGROUND_RENDER_INTERVAL_MS,
  COMPOSITION_RENDER_HOLD_MAX_MS,
  createTerminalRenderThrottle,
} from '../../src/utils/terminalRenderThrottle.ts';

function harness() {
  let now = 0;
  const frames: Array<() => void> = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const throttle = createTerminalRenderThrottle({
    now: () => now,
    requestFrame: (run) => { frames.push(run); },
    setTimer: (run, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const runFrames = () => { for (const run of frames.splice(0)) run(); };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.run(); }
    }
    runFrames();
  };
  return { throttle, runFrames, advance, pendingFrames: () => frames.length };
}

function terminal(h: ReturnType<typeof harness>, id: string) {
  const runs: number[] = [];
  let count = 0;
  const lane = h.throttle.register(id);
  lane.setVisible(true);
  return { lane, runs, flush: () => lane.schedule(() => { count += 1; runs.push(count); }), count: () => count };
}

test('PERF-BGSTAB-027 AC-1, AC-4: the last focused terminal flushes on the next frame', () => {
  const h = harness();
  const a = terminal(h, 'a');
  const b = terminal(h, 'b');
  // Each lane has flushed once, so only the foreground rule can let the next flush through.
  a.flush(); b.flush(); h.runFrames();
  h.advance(60);
  h.throttle.noteFocus('a');
  a.flush(); b.flush(); h.runFrames();
  assert.equal(a.count(), 2, 'the focused terminal is not throttled');
  assert.equal(b.count(), 1, 'the other one waits');
  h.advance(60);
  h.throttle.noteFocus('b');
  b.flush(); h.runFrames();
  assert.equal(b.count(), 2, 'focus moved the foreground');
  a.flush(); h.runFrames();
  assert.equal(a.count(), 2, 'and the old foreground waits now');
});

test('PERF-BGSTAB-027 AC-2: a background terminal flushes at most once per interval', () => {
  const h = harness();
  const a = terminal(h, 'a');
  const b = terminal(h, 'b');
  h.throttle.noteFocus('a');
  b.flush();
  h.runFrames();
  assert.equal(b.count(), 1, 'the first flush is not delayed');
  b.flush();
  h.advance(0);
  assert.equal(b.count(), 2, 'a flush asked for inside the burst runs at once');
  h.advance(BACKGROUND_BURST_MS + 10);
  b.flush();
  h.runFrames();
  assert.equal(b.count(), 2, 'after the burst a flush waits for the interval');
  h.advance(BACKGROUND_RENDER_INTERVAL_MS - BACKGROUND_BURST_MS - 10 - 1);
  assert.equal(b.count(), 2);
  h.advance(1);
  assert.equal(b.count(), 3, 'it runs when the interval has passed');
  void a;
});

test('PERF-BGSTAB-027 AC-3: the only visible terminal is in the foreground without focus', () => {
  const h = harness();
  const a = terminal(h, 'a');
  a.flush(); h.runFrames();
  a.flush(); h.runFrames();
  assert.equal(a.count(), 2);
  const b = terminal(h, 'b');
  b.lane.setVisible(false);
  a.flush(); h.runFrames();
  assert.equal(a.count(), 3, 'a hidden terminal does not count');
});

test('PERF-BGSTAB-027 AC-5: background flushes wait for a composition, for 1 s at most', () => {
  const h = harness();
  const a = terminal(h, 'a');
  const b = terminal(h, 'b');
  const c = terminal(h, 'c');
  h.throttle.noteFocus('a');
  h.throttle.setComposing('a', true);
  b.flush();
  h.runFrames();
  assert.equal(b.count(), 0, 'held while composing');
  h.throttle.setComposing('a', false);
  h.runFrames();
  assert.equal(b.count(), 1, 'released when the composition ends');

  h.advance(BACKGROUND_RENDER_INTERVAL_MS);
  h.throttle.setComposing('a', true);
  c.flush();
  h.advance(COMPOSITION_RENDER_HOLD_MAX_MS - 1);
  assert.equal(c.count(), 0);
  h.advance(1);
  assert.equal(c.count(), 1, 'a long composition does not starve other terminals');
  a.flush(); h.runFrames();
  assert.equal(a.count(), 1, 'the foreground terminal is never held');
});

test('PERF-BGSTAB-027 AC-5: during a long composition a background terminal flushes once a second, not every frame', () => {
  const h = harness();
  terminal(h, 'a');
  const b = terminal(h, 'b');
  h.throttle.noteFocus('a');
  h.throttle.setComposing('a', true);
  // Request a flush every frame for three seconds.
  for (let t = 0; t < 3000; t += 16) { b.flush(); h.advance(16); }
  // Without the hold this would be about 187 flushes; each release lets one short burst through.
  assert.ok(b.count() <= 3 * Math.ceil(BACKGROUND_BURST_MS / 16 + 1), `flushed ${b.count()} times in 3 s of composing`);
  assert.ok(b.count() >= 2, `flushed ${b.count()} times; a long composition must not starve it`);
});

test('PERF-BGSTAB-027 AC-5: one terminal ending its composition does not end another one\'s', () => {
  const h = harness();
  terminal(h, 'a');
  const b = terminal(h, 'b');
  terminal(h, 'c');
  h.throttle.noteFocus('a');
  b.flush(); h.runFrames();
  h.throttle.setComposing('a', true);
  h.throttle.setComposing('c', false);
  h.advance(BACKGROUND_RENDER_INTERVAL_MS);
  b.flush(); h.runFrames();
  assert.equal(b.count(), 1, 'still held: a is composing');
});

test('PERF-BGSTAB-027: a disposed lane drops its pending flush', () => {
  const h = harness();
  terminal(h, 'a');
  const b = terminal(h, 'b');
  h.throttle.noteFocus('a');
  b.flush(); h.runFrames();
  b.flush();
  b.lane.dispose();
  h.advance(BACKGROUND_RENDER_INTERVAL_MS);
  assert.equal(b.count(), 1);
});
