// PERF-BGSTAB-028: one armed timer per idle period, however many writes touch it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createTrailingTimer } from '../../src/utils/trailingTimer.ts';

function harness(delayMs: number) {
  let now = 0;
  let armed = 0;
  let idle = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  const timer = createTrailingTimer({
    delayMs,
    onIdle: () => { idle += 1; },
    now: () => now,
    setTimer: (run, ms) => { armed += 1; const id = nextId++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = end;
  };
  return { timer, advance, armed: () => armed, idle: () => idle, open: () => timers.size };
}

test('PERF-BGSTAB-028 AC-1: many touches arm one timer and the idle action runs once, after the last touch', () => {
  const h = harness(2000);
  // The last touch is followed by one 30 ms step, so the action is due 1970 ms later.
  for (let i = 0; i < 50; i += 1) { h.timer.touch(); h.advance(30); }
  assert.equal(h.idle(), 0);
  h.advance(1969);
  assert.equal(h.idle(), 0, 'not before the delay after the last touch');
  h.advance(1);
  assert.equal(h.idle(), 1);
  assert.ok(h.armed() <= 3, `armed ${h.armed()} timers for 50 touches`);
});

test('PERF-BGSTAB-028 AC-2: a touch after the idle action arms a new timer', () => {
  const h = harness(100);
  h.timer.touch();
  h.advance(100);
  assert.equal(h.idle(), 1);
  h.timer.touch();
  h.advance(100);
  assert.equal(h.idle(), 2);
});

test('PERF-BGSTAB-028 AC-3: cancel stops the pending idle action', () => {
  const h = harness(100);
  h.timer.touch();
  h.timer.cancel();
  h.advance(500);
  assert.equal(h.idle(), 0);
  assert.equal(h.open(), 0);
});

test('PERF-BGSTAB-028 AC-4: the terminal idle actions use the trailing timer', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const write = source.slice(source.indexOf('const writeOutputDirect = useCallback(('));
  const body = write.slice(0, write.indexOf('const getOutputScheduler = useCallback('));
  assert.ok(!/clearTimeout\(|setTimeout\(/.test(body), 'writeOutputDirect neither clears nor arms a timer itself');
  const save = source.slice(source.indexOf('const scheduleSnapshotSave = useCallback('));
  const saveBody = save.slice(0, save.indexOf('}, ['));
  assert.ok(!/clearTimeout\(|setTimeout\(/.test(saveBody) && /snapshotIdleTimer\.touch\(\)/.test(saveBody), 'the idle snapshot save touches the trailing timer');
  assert.ok(/createTrailingTimer\(/.test(source));
});
