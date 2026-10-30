import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloseSignal } from './closeSignal.js';

// REL-BGSTAB-061 (#208): racing every headless write against one long-lived close promise left a
// reaction on that promise per write until the session closed; the heap grew without bound.

test('REL-BGSTAB-061 AC-1: a settled race leaves nothing waiting on the signal', async () => {
  const signal = createCloseSignal();
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(await signal.race(Promise.resolve(i)), i);
  }
  assert.equal(signal.pendingWaits(), 0);
});

test('REL-BGSTAB-061 AC-1: a race that rejects also lets go of its wait', async () => {
  const signal = createCloseSignal();
  await assert.rejects(signal.race(Promise.reject(new Error('write failed'))), /write failed/);
  assert.equal(signal.pendingWaits(), 0);
});

test('REL-BGSTAB-061 AC-2: closing releases a race whose work never settles', async () => {
  const signal = createCloseSignal();
  const stuck = signal.race(new Promise<number>(() => {}));
  assert.equal(signal.pendingWaits(), 1);
  signal.close();
  assert.equal(await stuck, undefined);
  assert.equal(signal.pendingWaits(), 0);
  assert.equal(signal.isClosed(), true);
});

test('REL-BGSTAB-061 AC-3: a race started after close resolves at once', async () => {
  const signal = createCloseSignal();
  signal.close();
  assert.equal(await signal.race(new Promise<number>(() => {})), undefined);
  assert.equal(signal.pendingWaits(), 0);
  signal.close(); // closing twice is harmless
});
