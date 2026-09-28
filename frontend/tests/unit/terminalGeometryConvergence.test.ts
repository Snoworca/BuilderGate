import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGeometryConvergenceLoop,
  decideGeometryConvergence,
} from '../../src/utils/terminalGeometryConvergence.ts';

// REL-BGSTAB-038 — a visible terminal's cols/rows converge to what its container holds.

const base = { visible: true, width: 1600, height: 900, current: { cols: 52, rows: 52 } };

test('AC-1: a visible terminal narrower than its container needs a fit', () => {
  assert.equal(decideGeometryConvergence({ ...base, proposed: { cols: 168, rows: 50 } }), 'fit');
});

test('AC-3: a terminal that already matches its container needs nothing', () => {
  assert.equal(decideGeometryConvergence({ ...base, current: { cols: 168, rows: 50 }, proposed: { cols: 168, rows: 50 } }), 'in-sync');
});

test('AC-4: a hidden or zero-size terminal is not measured', () => {
  assert.equal(decideGeometryConvergence({ ...base, visible: false, proposed: { cols: 168, rows: 50 } }), 'not-renderable');
  assert.equal(decideGeometryConvergence({ ...base, width: 0, proposed: { cols: 168, rows: 50 } }), 'not-renderable');
  assert.equal(decideGeometryConvergence({ ...base, height: 0, proposed: { cols: 168, rows: 50 } }), 'not-renderable');
});

test('a container the renderer cannot measure yet is left alone', () => {
  assert.equal(decideGeometryConvergence({ ...base, proposed: undefined }), 'unmeasurable');
  assert.equal(decideGeometryConvergence({ ...base, proposed: { cols: Number.NaN, rows: 50 } }), 'unmeasurable');
  assert.equal(decideGeometryConvergence({ ...base, proposed: { cols: 0, rows: 50 } }), 'unmeasurable');
});

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  return {
    timers,
    setTimeout: (run: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, every: null, run }); return id; },
    setInterval: (run: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, every: ms, run }); return id; },
    clear: (id: number) => { timers.delete(id); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.run();
      }
      now = end;
    },
  };
}

test('AC-1/AC-2: the loop checks again on its own, so a dropped fit is retried without a new resize event', () => {
  const clock = fakeTimers();
  let checks = 0;
  const loop = createGeometryConvergenceLoop({
    intervalMs: 700,
    kickDelaysMs: [60, 250],
    check: () => { checks += 1; },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimer: clock.clear,
  });
  loop.start();
  clock.advance(1000);
  assert.equal(checks, 1, 'one periodic check within a second');
  loop.kick();
  clock.advance(300);
  assert.equal(checks, 3, 'a kick checks soon after a layout change');
  clock.advance(700);
  assert.ok(checks >= 4);
});

test('AC-4: stopping clears every timer, and starting twice does not stack loops', () => {
  const clock = fakeTimers();
  let checks = 0;
  const loop = createGeometryConvergenceLoop({
    intervalMs: 700,
    kickDelaysMs: [60, 250],
    check: () => { checks += 1; },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimer: clock.clear,
  });
  loop.start();
  loop.start();
  loop.kick();
  loop.stop();
  assert.equal(clock.timers.size, 0);
  clock.advance(5000);
  assert.equal(checks, 0);
  loop.kick();
  assert.equal(clock.timers.size, 0, 'a kick while stopped does nothing');
});
