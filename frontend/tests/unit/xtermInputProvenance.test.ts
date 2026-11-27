// REL-BGSTAB-019: the provenance permits on their own, with fake microtasks and timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSITION_COMMIT_PROVENANCE_MS,
  createXtermInputProvenance,
} from '../../src/utils/xtermInputProvenance.ts';

function harness() {
  const microtasks: Array<() => void> = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let nextId = 1;
  const provenance = createXtermInputProvenance({
    queueMicrotask: (callback) => { microtasks.push(callback); },
    setTimeout: (callback, ms) => { const id = nextId++; timers.set(id, { at: now + ms, run: callback }); return id; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
  });
  return {
    provenance,
    drainMicrotasks: () => { for (const run of microtasks.splice(0)) run(); },
    advance: (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.run(); }
      }
    },
    openTimers: () => timers.size,
  };
}

test('REL-BGSTAB-019: a gesture permit covers data in the same task only', () => {
  const h = harness();
  h.provenance.markUserGesture();
  assert.equal(h.provenance.takeUserProvenance('a'), true);
  assert.equal(h.provenance.takeUserProvenance('b'), false, 'one permit per gesture');
  h.provenance.markUserGesture();
  h.drainMicrotasks();
  assert.equal(h.provenance.takeUserProvenance('c'), false, 'the permit ends at the next microtask');
});

test('REL-BGSTAB-019 AC-1: a composition permit outlives the microtask', () => {
  const h = harness();
  h.provenance.markDeferredInput();
  h.drainMicrotasks();
  h.advance(COMPOSITION_COMMIT_PROVENANCE_MS - 1);
  assert.equal(h.provenance.takeUserProvenance('한'), true);
  assert.equal(h.openTimers(), 0, 'using the permit clears its expiry timer');
});

test('REL-BGSTAB-019: a composition permit expires', () => {
  const h = harness();
  h.provenance.markDeferredInput();
  h.advance(COMPOSITION_COMMIT_PROVENANCE_MS);
  assert.equal(h.provenance.takeUserProvenance('한'), false);
});

test('REL-BGSTAB-019 AC-3: a reply with ESC never uses a composition permit', () => {
  const h = harness();
  h.provenance.markDeferredInput();
  assert.equal(h.provenance.takeUserProvenance('\x1b[?1;2c'), false);
  assert.equal(h.provenance.takeUserProvenance('가'), true, 'the permit is still there for the syllable');
});

test('REL-BGSTAB-019: dispose drops every permit and timer', () => {
  const h = harness();
  h.provenance.markUserGesture();
  h.provenance.markDeferredInput();
  h.provenance.dispose();
  assert.equal(h.openTimers(), 0);
  assert.equal(h.provenance.takeUserProvenance('가'), false);
  h.provenance.markDeferredInput();
  assert.equal(h.provenance.takeUserProvenance('가'), false, 'a disposed tracker grants nothing');
});

test('REL-BGSTAB-019: composed text uses the deferred permit, so the key that flushed it keeps its own', () => {
  // An arrow key ends a composition at once: xterm sends the syllable, then the arrow's ESC [ A,
  // both inside the arrow's keydown.
  const h = harness();
  h.provenance.markDeferredInput();
  h.provenance.markUserGesture();
  assert.equal(h.provenance.takeUserProvenance('한'), true);
  assert.equal(h.provenance.takeUserProvenance('\x1b[A'), true, 'the arrow key is typed input too');
});
