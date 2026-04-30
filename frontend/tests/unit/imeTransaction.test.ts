import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ImeTransaction,
  type ImeTelemetryValue,
} from '../../src/utils/imeTransaction.ts';

interface ManualTimer {
  id: number;
  callback: () => void;
  cleared: boolean;
}

class ManualTimers {
  private nextId = 1;
  readonly timers: ManualTimer[] = [];

  setTimeout = (callback: () => void): ManualTimer => {
    const timer = {
      id: this.nextId,
      callback,
      cleared: false,
    };
    this.nextId += 1;
    this.timers.push(timer);
    return timer;
  };

  clearTimeout = (handle: unknown): void => {
    const timer = handle as ManualTimer;
    timer.cleared = true;
  };

  runAll(): void {
    for (;;) {
      const timer = this.timers.find((entry) => !entry.cleared);
      if (!timer) {
        return;
      }
      timer.cleared = true;
      timer.callback();
    }
  }
}

function createTransaction() {
  const timers = new ManualTimers();
  const events: Array<{ kind: string; details: Record<string, ImeTelemetryValue> }> = [];
  let sessionGeneration = 1;
  const transaction = new ImeTransaction({
    getSessionGeneration: () => sessionGeneration,
    onEvent: (kind, details) => {
      events.push({ kind, details });
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  return {
    transaction,
    timers,
    events,
    setSessionGeneration(next: number) {
      sessionGeneration = next;
    },
  };
}

test('ImeTransaction treats xterm data before compositionend as a native commit', () => {
  const { transaction, timers, events } = createTransaction();

  const compositionSeq = transaction.beginComposition();
  assert.equal(transaction.observeXtermData(), compositionSeq);
  transaction.endComposition(2);
  timers.runAll();

  assert.equal(transaction.getState(), 'idle');
  assert.equal(events.some((event) => event.kind === 'ime_commit_without_xterm_data'), false);
  assert.equal(events.some((event) => event.kind === 'ime_fallback_observed'), false);
  assert.equal(events.some((event) => event.kind === 'ime_settled'), true);
});

test('ImeTransaction records observe-only fallback evidence when no xterm data arrives', () => {
  const { transaction, timers, events } = createTransaction();

  const compositionSeq = transaction.beginComposition();
  transaction.observeBeforeInput('insertFromComposition', 3);
  transaction.endComposition(3);
  timers.runAll();

  assert.equal(transaction.getState(), 'idle');
  assert.deepEqual(
    events
      .filter((event) => event.kind === 'ime_commit_without_xterm_data' || event.kind === 'ime_fallback_observed')
      .map((event) => ({
        kind: event.kind,
        compositionSeq: event.details.compositionSeq,
        committedLength: event.details.committedLength,
        fallbackMode: event.details.fallbackMode ?? null,
      })),
    [
      {
        kind: 'ime_commit_without_xterm_data',
        compositionSeq,
        committedLength: 3,
        fallbackMode: null,
      },
      {
        kind: 'ime_fallback_observed',
        compositionSeq,
        committedLength: 3,
        fallbackMode: 'observe-only',
      },
    ],
  );
});

test('ImeTransaction accepts delayed xterm data after compositionend without fallback', () => {
  const { transaction, timers, events } = createTransaction();

  const compositionSeq = transaction.beginComposition();
  transaction.endComposition(2);
  assert.equal(transaction.getState(), 'committing');
  assert.equal(transaction.observeXtermData(), compositionSeq);
  timers.runAll();

  assert.equal(transaction.getState(), 'idle');
  assert.equal(events.some((event) => event.kind === 'ime_commit_without_xterm_data'), false);
  assert.equal(events.some((event) => event.kind === 'ime_fallback_observed'), false);
  assert.equal(events.some((event) => event.kind === 'ime_settled'), true);
});

test('ImeTransaction stale settle timers do not idle a newer composition', () => {
  const { transaction, timers } = createTransaction();

  transaction.beginComposition();
  transaction.observeXtermData();
  const nextCompositionSeq = transaction.beginComposition();
  timers.runAll();

  const snapshot = transaction.getSnapshot();
  assert.equal(snapshot.state, 'composing');
  assert.equal(snapshot.compositionSeq, nextCompositionSeq);
});

test('ImeTransaction keeps repair waits pending across a superseding composition', async () => {
  const { transaction, timers, events } = createTransaction();

  transaction.beginComposition();
  const wait = transaction.waitForIdle('repair', 'manual-repair');
  let resolved: Awaited<typeof wait> | null = null;
  wait.then((result) => {
    resolved = result;
  });

  const nextCompositionSeq = transaction.beginComposition();
  await Promise.resolve();

  assert.equal(resolved, null);
  assert.equal(events.some((event) =>
    event.kind === 'ime_deferred_action_retargeted'
    && event.details.deferredKind === 'repair'
    && event.details.nextCompositionSeq === nextCompositionSeq,
  ), true);

  transaction.endComposition(1);
  timers.runAll();
  await Promise.resolve();

  assert.deepEqual(resolved, { status: 'ready' });
});

test('ImeTransaction keeps snapshot waits pending across a superseding composition', async () => {
  const { transaction, timers, events } = createTransaction();

  transaction.beginComposition();
  const wait = transaction.waitForIdle('snapshot', 'replace-with-snapshot');
  let resolved: Awaited<typeof wait> | null = null;
  wait.then((result) => {
    resolved = result;
  });

  const nextCompositionSeq = transaction.beginComposition();
  await Promise.resolve();

  assert.equal(resolved, null);
  assert.equal(events.some((event) =>
    event.kind === 'ime_deferred_action_retargeted'
    && event.details.deferredKind === 'snapshot'
    && event.details.nextCompositionSeq === nextCompositionSeq,
  ), true);

  transaction.endComposition(1);
  timers.runAll();
  await Promise.resolve();

  assert.deepEqual(resolved, { status: 'ready' });
});

test('ImeTransaction defers repair until IME settles and cancels on generation change', async () => {
  const first = createTransaction();
  first.transaction.beginComposition();
  const wait = first.transaction.waitForIdle('repair', 'manual-repair');
  let resolved: Awaited<typeof wait> | null = null;
  wait.then((result) => {
    resolved = result;
  });

  assert.equal(first.events.some((event) => event.kind === 'ime_repair_deferred'), true);
  first.transaction.endComposition(1);
  first.timers.runAll();
  await Promise.resolve();

  assert.deepEqual(resolved, { status: 'ready' });

  const second = createTransaction();
  second.transaction.beginComposition();
  const cancelled = second.transaction.waitForIdle('repair', 'manual-repair');
  second.setSessionGeneration(2);
  second.transaction.dispose();

  await assert.doesNotReject(async () => {
    assert.deepEqual(await cancelled, { status: 'disposed' });
  });
});
