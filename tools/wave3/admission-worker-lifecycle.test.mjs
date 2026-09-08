import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// PERF-BGSTAB-010 / AC2/5: inert Workers and timers; no native capture.
const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');
const load = () => import('./admission-worker-lifecycle.mjs');
async function pending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  return !settled;
}
class InertWorker extends EventEmitter {}

test('worker registration retains earlier ownership when a later construction throws', async () => {
  const { registerWorker, releaseAndAwaitWorkers } = await load();
  const owned = new Set(), worker = new InertWorker(), failure = Error('construction');
  let released = 0;
  const entry = registerWorker(owned, () => worker, () => { released++; });
  assert.equal(entry.worker, worker); assert.equal(owned.has(entry), true);
  assert.throws(() => registerWorker(owned, () => { throw failure; }, () => assert.fail()), error => error === failure);
  const result = releaseAndAwaitWorkers(owned, { error: failure });
  const checked = assert.rejects(result, error => error === failure);
  assert.equal(await pending(checked), true); assert.equal(released, 1);
  worker.emit('exit', 0); await checked;
});

test('release errors do not skip later releases or any Worker exit wait', async () => {
  const { registerWorker, releaseAndAwaitWorkers } = await load();
  const owned = new Set(), a = new InertWorker(), b = new InertWorker();
  const original = Error('body'), releaseError = Error('release'), workerError = Error('worker');
  const releases = [];
  registerWorker(owned, () => a, () => { releases.push('a'); throw releaseError; });
  registerWorker(owned, () => b, () => { releases.push('b'); });
  const result = releaseAndAwaitWorkers(owned, { error: original });
  const checked = assert.rejects(result, error => {
    assert.ok(error instanceof AggregateError);
    for (const expected of [original, releaseError, workerError]) assert.ok(error.errors.includes(expected));
    return true;
  });
  assert.deepEqual(releases, ['a', 'b']);
  a.emit('error', workerError); a.emit('exit', 1);
  assert.equal(await pending(checked), true);
  b.emit('exit', 0); await checked;
});

test('Worker nonzero exit is failure and tagged undefined is retained without parent deletion', async () => {
  const { registerWorker, releaseAndAwaitWorkers } = await load();
  const owned = new Set(), worker = new InertWorker();
  registerWorker(owned, () => worker, () => {});
  const result = releaseAndAwaitWorkers(owned, { error: undefined });
  const checked = assert.rejects(result, error => error instanceof AggregateError && error.errors.includes(undefined));
  worker.emit('exit', 1); await checked;
  assert.equal('terminate' in worker, false, 'inert API provides no termination or filesystem path authority');
});

test('phase records bind actual registered entries to distinct ready paths and matching captured paths', async () => {
  const { registerWorker, recordWorkerPhase } = await load();
  const owned = new Set(), seenPaths = new Set();
  const a = registerWorker(owned, () => new InertWorker(), () => {});
  const b = registerWorker(owned, () => new InertWorker(), () => {});
  const options = { index: 0, analysisRoot: 'C:/owned/docs/analysis', seenPaths };
  const ready = { phase: 'ready', index: 0, manifestPath: 'C:/owned/docs/analysis/a.json' };
  assert.doesNotThrow(() => recordWorkerPhase(a, ready, options));
  assert.throws(() => recordWorkerPhase(a, ready, options), /duplicate|ready|phase/i);
  assert.throws(() => recordWorkerPhase(b, { ...ready, index: 1 }, { ...options, index: 1 }), /duplicate|path|distinct/i);
  assert.throws(() => recordWorkerPhase(a, { phase: 'captured', index: 0, manifestPath: 'C:/owned/docs/analysis/other.json' }, options), /path|match/i);
  assert.doesNotThrow(() => recordWorkerPhase(a, { ...ready, phase: 'captured' }, options));
  assert.throws(() => recordWorkerPhase(a, { ...ready, phase: 'captured' }, options), /duplicate|phase|captured/i);
});

test('phase validation rejects index spoofing escape unknown phase and capture before ready', async () => {
  const { registerWorker, recordWorkerPhase } = await load();
  for (const message of [
    { phase: 'ready', index: 9, manifestPath: 'C:/owned/docs/analysis/a.json' },
    { phase: 'ready', index: 0, manifestPath: 'C:/foreign/a.json' },
    { phase: 'ready', index: 0, manifestPath: 'C:/owned/docs/analysis/../a.json' },
    { phase: 'ready', index: 0, manifestPath: 'C:/owned/docs/analysis/sub/a.json' },
    { phase: 'invented', index: 0, manifestPath: 'C:/owned/docs/analysis/a.json' },
    { phase: 'captured', index: 0, manifestPath: 'C:/owned/docs/analysis/a.json' },
  ]) {
    const entry = registerWorker(new Set(), () => new InertWorker(), () => {});
    assert.throws(() => recordWorkerPhase(entry, message, { index: 0, analysisRoot: 'C:/owned/docs/analysis', seenPaths: new Set() }));
  }
});

function controlledTimers(run) {
  const timers = new Map(); let next = 0;
  return run({ timers, setTimeout: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id), fire(ms) { for (const [id, item] of [...timers]) if (item.ms === ms) { timers.delete(id); item.callback(); } } });
}

test('actual old polling helper stops scheduling after timeout rejection', async t => {
  const { waitForWorkerCondition } = await load();
  const file = new URL('./fair-readmission-closure-v3.seal-race.test.mjs', import.meta.url);
  const source = ts.createSourceFile('seal.mjs', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const helper = source.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'waitForMessages');
  assert.equal(helper.length, 1);
  await controlledTimers(async clock => {
    t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
    t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
    const wait = new Function('setTimeout', 'clearTimeout', 'waitForWorkerCondition', `${helper[0].getText(source)}; return waitForMessages;`)(clock.setTimeout, clock.clearTimeout, waitForWorkerCondition);
    const checked = assert.rejects(wait([], () => false, 'never-ready', 30), /timed out/i);
    clock.fire(30); await checked;
    assert.equal(clock.timers.size, 0, 'timeout must dispose polling too; a rejected wait cannot continue forever');

    const labelled = assert.rejects(wait([], () => false, 'both native Worker capture outcomes', 30),
      error => /both native Worker capture outcomes/.test(String(error)));
    clock.fire(30); await labelled;
    assert.equal(clock.timers.size, 0);
  });
});

test('common waiter timeout preserves an optional scenario label', async t => {
  const { waitForWorkerCondition } = await load();
  await controlledTimers(async clock => {
    t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
    t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
    const checked = assert.rejects(waitForWorkerCondition(() => false,
      { timeoutMs: 30, pollMs: 5, label: 'worker ready barrier' }),
    error => /worker ready barrier/.test(String(error)));
    clock.fire(30); await checked;
    assert.equal(clock.timers.size, 0);
  });
});

test('common waiter disposes timers on predicate error and on timeout', async t => {
  const { waitForWorkerCondition } = await load();
  for (const throws of [false, true]) {
    await controlledTimers(async clock => {
      t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
      t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
      const failure = Error('predicate');
      const checked = assert.rejects(waitForWorkerCondition(() => { if (throws) throw failure; return false; }, { timeoutMs: 30, pollMs: 5 }), error => throws ? error === failure : /timeout|timed out/i.test(String(error)));
      if (!throws) clock.fire(30);
      await checked; assert.equal(clock.timers.size, 0);
      t.mock.restoreAll();
    });
  }
});

for (const immediate of [true, false]) {
  test(`common waiter disposes all timers after ${immediate ? 'immediate' : 'polled'} success`, async t => {
    const { waitForWorkerCondition } = await load();
    await controlledTimers(async clock => {
      t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
      t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
      let ready = immediate, observations = 0;
      const result = waitForWorkerCondition(() => { observations++; return ready; }, { timeoutMs: 30, pollMs: 5 });
      if (!immediate) {
        assert.equal(await pending(result), true);
        assert.equal(observations, 1);
        assert.ok([...clock.timers.values()].some(timer => timer.ms === 5), 'a real poll must be scheduled while false');
        ready = true;
        clock.fire(5);
      }
      await result;
      assert.equal(observations, immediate ? 1 : 2);
      assert.equal(clock.timers.size, 0, 'success clears deadline and poll');
      const settledObservations = observations;
      clock.fire(5); clock.fire(30);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(observations, settledObservations, 'settled waits perform no later predicate evaluation');
      t.mock.restoreAll();
    });
  });
}
