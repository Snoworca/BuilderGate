import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStatusHysteresis, RUNNING_RELEASE_HOLD_MS } from '../../src/utils/statusHysteresis.ts';

// REL-BGSTAB-035 — the running badge does not flicker while an agent works in bursts.

function harness() {
  const applied: Array<[string, string]> = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const h = createStatusHysteresis(
    (id, status) => { applied.push([id, status]); },
    {
      setTimer: (fn) => { const t = next++; timers.set(t, fn); return t; },
      clearTimer: (t) => { timers.delete(t as number); },
    },
  );
  const fire = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); };
  return { h, applied, timers, fire };
}

test('REL-BGSTAB-035 AC-1 the hold is 3-4 seconds', () => {
  assert.ok(RUNNING_RELEASE_HOLD_MS >= 3000 && RUNNING_RELEASE_HOLD_MS <= 4000);
});

test('REL-BGSTAB-035 AC-2 running is shown at once; idle after running waits for the hold', () => {
  const { h, applied, timers, fire } = harness();
  h.update('s', 'running');
  assert.deepEqual(applied, [['s', 'running']]);
  h.update('s', 'idle');
  assert.deepEqual(applied, [['s', 'running']]);
  assert.equal(timers.size, 1);
  fire();
  assert.deepEqual(applied, [['s', 'running'], ['s', 'idle']]);
});

test('REL-BGSTAB-035 AC-3 running again inside the hold cancels the release, so nothing flickers', () => {
  const { h, applied, timers } = harness();
  h.update('s', 'running');
  h.update('s', 'idle');
  h.update('s', 'running');
  assert.equal(timers.size, 0);
  assert.deepEqual(applied, [['s', 'running']]);
});

test('REL-BGSTAB-035 AC-4 idle without a preceding running and disconnected are applied at once', () => {
  const { h, applied } = harness();
  h.update('a', 'idle');
  h.update('b', 'running');
  h.update('b', 'disconnected');
  assert.deepEqual(applied, [['a', 'idle'], ['b', 'running'], ['b', 'disconnected']]);
});
