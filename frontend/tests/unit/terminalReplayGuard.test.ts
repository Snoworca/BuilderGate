import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalReplayInputGuard,
  writeTerminalReplayWithFifoProbe,
} from '../../src/utils/terminalReplayGuard.ts';

test('replay-generated xterm data is suppressed only while a replay write is active', () => {
  const guard = createTerminalReplayInputGuard();
  assert.equal(guard.shouldSuppressXtermData(), false);

  const first = guard.beginReplayWrite();
  const second = guard.beginReplayWrite();
  assert.equal(guard.shouldSuppressXtermData(), true);
  assert.equal(
    guard.shouldSuppressXtermData('user-input'),
    false,
    'physical user input must keep flowing to the normal bounded input barrier',
  );

  first.release();
  assert.equal(guard.shouldSuppressXtermData(), true);
  first.release();
  assert.equal(guard.shouldSuppressXtermData(), true);

  second.release();
  assert.equal(guard.shouldSuppressXtermData(), false);
});

test('dispose/reset invalidates late replay callbacks without suppressing ordinary input', () => {
  const guard = createTerminalReplayInputGuard();
  const stale = guard.beginReplayWrite();
  guard.reset();
  assert.equal(guard.shouldSuppressXtermData(), false);

  const current = guard.beginReplayWrite();
  stale.release();
  assert.equal(guard.shouldSuppressXtermData(), true);

  current.release();
  assert.equal(guard.shouldSuppressXtermData(), false);
});

test('a timed-out replay write can release only its own generation-safe lease', () => {
  const guard = createTerminalReplayInputGuard();
  const timedOut = guard.beginReplayWrite();
  const nested = guard.beginReplayWrite();

  timedOut.release();
  assert.equal(guard.shouldSuppressXtermData(), true);

  guard.reset();
  nested.release();
  assert.equal(guard.shouldSuppressXtermData(), false);
});

test('lost replay callback settles only after an empty same-FIFO probe callback', async () => {
  const guard = createTerminalReplayInputGuard();
  const writes: Array<{ data: string; onWritten: () => void }> = [];
  const result = writeTerminalReplayWithFifoProbe({
    data: 'snapshot',
    guard,
    write: (data, onWritten) => writes.push({ data, onWritten }),
    isCurrent: () => true,
    timeoutMs: 5,
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(writes.map(write => write.data), ['snapshot', '']);
  assert.equal(guard.shouldSuppressXtermData(), true);
  writes[1].onWritten();
  assert.equal(await result, true);
  assert.equal(guard.shouldSuppressXtermData(), false);
});

test('lost replay callback and lost FIFO probe converge false without a leaked lease', async () => {
  const guard = createTerminalReplayInputGuard();
  const writes: string[] = [];
  const result = await writeTerminalReplayWithFifoProbe({
    data: 'snapshot',
    guard,
    write: (data) => writes.push(data),
    isCurrent: () => true,
    timeoutMs: 5,
  });

  assert.deepEqual(writes, ['snapshot', '']);
  assert.equal(result, false);
  assert.equal(guard.shouldSuppressXtermData(), false);
});

test('synchronous primary and FIFO-probe callbacks settle without stale timers or leases', async () => {
  const primaryGuard = createTerminalReplayInputGuard();
  const primaryWrites: string[] = [];
  const primary = await writeTerminalReplayWithFifoProbe({
    data: 'snapshot',
    guard: primaryGuard,
    write: (data, onWritten) => {
      primaryWrites.push(data);
      onWritten();
    },
    isCurrent: () => true,
    timeoutMs: 5,
  });
  assert.equal(primary, true);
  assert.deepEqual(primaryWrites, ['snapshot']);
  assert.equal(primaryGuard.shouldSuppressXtermData(), false);

  const probeGuard = createTerminalReplayInputGuard();
  const probeWrites: string[] = [];
  const probe = await writeTerminalReplayWithFifoProbe({
    data: 'snapshot',
    guard: probeGuard,
    write: (data, onWritten) => {
      probeWrites.push(data);
      if (data === '') onWritten();
    },
    isCurrent: () => true,
    timeoutMs: 5,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(probe, true);
  assert.deepEqual(probeWrites, ['snapshot', '']);
  assert.equal(probeGuard.shouldSuppressXtermData(), false);
});
