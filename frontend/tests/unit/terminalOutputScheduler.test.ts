import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS,
  createTerminalOutputScheduler,
} from '../../src/utils/terminalOutputScheduler.ts';

test('terminal output scheduler writes queued output within the flush budget', async () => {
  const writes: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  scheduler.enqueue('abcdef');

  assert.deepEqual(writes, ['abcd', 'ef']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler does not split multibyte code points', async () => {
  const writes: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  scheduler.enqueue('한글');

  assert.deepEqual(writes, ['한', '글']);
});

test('terminal output scheduler preserves callback ordering after full chunk writes', async () => {
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 3,
    write: (_data, onWritten) => onWritten(),
    schedule: (drain) => drain(),
  });

  scheduler.enqueue('abcd', () => callbacks.push('first'));
  scheduler.enqueue('ef', () => callbacks.push('second'));

  assert.deepEqual(callbacks, ['first', 'second']);
});

test('terminal output scheduler reports overflow instead of accumulating unbounded output', async () => {
  const writes: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 5,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: () => {},
  });

  const decision = scheduler.enqueue('abcdef');

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'visible-output-overflow');
  assert.equal(decision.droppedBytes, 6);
  assert.deepEqual(writes, []);
  assert.equal(scheduler.isStale(), true);
});

test('terminal output scheduler overflow includes already queued bytes in dropped count', async () => {
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 8,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  assert.deepEqual(scheduler.enqueue('abcd'), { ok: true });
  const decision = scheduler.enqueue('efghi');

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'visible-output-overflow');
  assert.equal(decision.droppedBytes, 9);
  assert.equal(scheduler.pendingBytes(), 0);
  assert.equal(scheduler.isStale(), true);
});

test('terminal output scheduler reset cancels queued callbacks', async () => {
  let called = false;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  scheduler.enqueue('abc', () => { called = true; });
  scheduler.reset();
  scheduler.flush();

  assert.equal(called, false);
  assert.equal(scheduler.isIdle(), true);
  assert.equal(scheduler.isStale(), false);
});

test('terminal output scheduler can update queue limits without recreating the instance', async () => {
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 10,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  assert.deepEqual(scheduler.enqueue('abcd'), { ok: true });
  scheduler.configure({ visibleOutputQueueMaxBytes: 5 });
  const decision = scheduler.enqueue('ef');

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'visible-output-overflow');
  assert.equal(decision.droppedBytes, 6);
});

test('terminal output scheduler yields a flush turn while browser input is pending', async () => {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  let inputPending = true;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    shouldYield: () => inputPending,
  });

  scheduler.enqueue('abcd');
  scheduled.shift()?.();

  assert.deepEqual(writes, []);
  assert.equal(scheduler.isIdle(), false);

  inputPending = false;
  scheduled.shift()?.();

  assert.deepEqual(writes, ['abcd']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler still makes progress when browser input stays pending', async () => {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    shouldYield: () => true,
  });

  scheduler.enqueue('abcdefgh');
  scheduled.shift()?.();
  assert.deepEqual(writes, []);

  scheduled.shift()?.();
  assert.deepEqual(writes, ['abcd']);

  scheduled.shift()?.();
  assert.deepEqual(writes, ['abcd']);

  scheduled.shift()?.();
  assert.deepEqual(writes, ['abcd', 'efgh']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler drains multiple chunks in one frame until the frame time budget is reached', async () => {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  let now = 0;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    visibleFlushFrameBudgetMs: 7,
    write: (data, onWritten) => {
      writes.push(data);
      now += 3;
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    now: () => now,
  });

  scheduler.enqueue('abcd');
  scheduler.enqueue('efgh');
  scheduler.enqueue('ijkl');
  scheduler.enqueue('mnop');
  scheduled.shift()?.();

  assert.deepEqual(writes, ['abcd', 'efgh', 'ijkl']);
  assert.equal(scheduler.isIdle(), false);

  scheduled.shift()?.();

  assert.deepEqual(writes, ['abcd', 'efgh', 'ijkl', 'mnop']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler yields the current frame when input becomes pending during a multi-chunk drain', async () => {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  let inputPending = false;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    visibleFlushFrameBudgetMs: 7,
    write: (data, onWritten) => {
      writes.push(data);
      inputPending = true;
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    shouldYield: () => inputPending,
  });

  scheduler.enqueue('abcd');
  scheduler.enqueue('efgh');
  scheduled.shift()?.();

  assert.deepEqual(writes, ['abcd']);
  assert.equal(scheduler.isIdle(), false);

  inputPending = false;
  scheduled.shift()?.();

  assert.deepEqual(writes, ['abcd', 'efgh']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler exposes a default frame time budget in the 6-8ms range', () => {
  assert.equal(DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS >= 6, true);
  assert.equal(DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS <= 8, true);
});
