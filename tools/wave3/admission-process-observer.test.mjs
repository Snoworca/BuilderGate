import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

// PERF-BGSTAB-010 / SDS-AC-4. Native mock seams only; no child process is launched.
const N = 118000;
let imports = 0;
async function pending(promise) {
  let done = false; promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); return !done;
}
async function harness(t, run, spawnFailure, spawnElapsed = 0) {
  const { observeProcessUntilClose } = await import(`./admission-process-observer.mjs?probe=${++imports}`);
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => assert.fail('observer must never signal its child');
  const calls = [], timers = new Map(); let now = 1000, nextTimer = 1;
  t.mock.method(childProcess, 'spawn', function (...args) {
    calls.push({ args, now }); now += spawnElapsed; if (spawnFailure) throw spawnFailure; return child;
  });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  syncBuiltinESMExports();
  try {
    await run({ observeProcessUntilClose, child, calls, timers,
      at: elapsed => { now = 1000 + elapsed; },
      fire: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
      close: (code = 0, signal = null) => { child.stdout.end(); child.stderr.end(); child.emit('close', code, signal); },
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}
const options = (onDeadline = () => undefined) => ({ cwd: 'C:/owned/fixture', env: { UNIT_ONLY: 'true' }, deadlineMs: N, onDeadline });

for (const elapsed of [N - 1, N, N + 1]) {
  test(`AC4 natural close at ${elapsed} uses strict elapsed boundary even before timer delivery`, async t => harness(t, async h => {
    let notices = 0;
    const args = ['--test', 'owned.mjs'], opts = options(() => { notices++; });
    const result = h.observeProcessUntilClose('node.exe', args, opts);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].now, 1000);
    assert.equal(h.calls[0].args[0], 'node.exe'); assert.equal(h.calls[0].args[1], args);
    const spawnOptions = h.calls[0].args[2];
    assert.equal(spawnOptions.cwd, opts.cwd); assert.equal(spawnOptions.env, opts.env);
    for (const forbidden of ['timeout', 'signal', 'killSignal']) assert.equal(Object.hasOwn(spawnOptions, forbidden), false);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, N, 'no synchronous spawn time: schedule the exact remaining budget');
    h.at(elapsed); h.close(); const observed = await result;
    assert.equal(observed.elapsedMs, elapsed); assert.equal(observed.deadlineExceeded, elapsed >= N);
    assert.equal(observed.code, 0); assert.equal(observed.signal, null);
    assert.equal(notices, elapsed >= N ? 1 : 0, 'late close must notify exactly once even before timer delivery');
    assert.equal(h.timers.size, 0, 'natural close must remove the deadline timer');
  }));
}

test('AC4 deadline notification cannot settle a pending child and late exit0 cannot erase failure', async t => harness(t, async h => {
  let notices = 0; const result = h.observeProcessUntilClose('node.exe', [], options(() => { notices++; }));
  h.at(N); h.fire(); assert.equal(notices, 1); assert.equal(await pending(result), true);
  h.child.emit('exit', 0, null); assert.equal(await pending(result), true);
  h.at(N + 10); h.close(); const observed = await result;
  assert.equal(observed.deadlineExceeded, true); assert.equal(observed.code, 0);
}));

test('AC4 exit does not finish observation before late split UTF8 output and close', async t => harness(t, async h => {
  const result = h.observeProcessUntilClose('node.exe', [], options()); const bytes = Buffer.from('한🙂', 'utf8');
  h.child.stdout.write(bytes.subarray(0, 2)); h.child.emit('exit', 0, null);
  assert.equal(await pending(result), true);
  h.child.stdout.write(bytes.subarray(2)); h.child.stderr.write(Buffer.from('late stderr'));
  h.at(20); h.close(); const observed = await result;
  assert.equal(observed.stdout, '한🙂'); assert.equal(observed.stderr, 'late stderr'); assert.equal(observed.elapsedMs, 20);
}));

test('AC4 callback stream and child errors remain observable while awaiting natural close', async t => harness(t, async h => {
  const callbackError = Error('deadline callback'), streamError = Error('stream'), childError = Error('child');
  const result = h.observeProcessUntilClose('node.exe', [], options(() => { throw callbackError; }));
  h.at(N); h.fire(); h.child.stdout.emit('error', streamError); h.child.emit('error', childError);
  assert.equal(await pending(result), true); h.at(N + 1); h.close(1);
  const observed = await result;
  assert.equal(observed.deadlineExceeded, true); assert.equal(observed.spawnError, childError);
  assert.ok(observed.observationErrors.includes(callbackError)); assert.ok(observed.observationErrors.includes(streamError));
}));

test('AC4 synchronous spawn throw reports exact failure without inventing a child to await', async t => {
  const failure = Error('spawn sync');
  await harness(t, async h => {
    const observed = await h.observeProcessUntilClose('node.exe', [], options());
    assert.equal(observed.spawnError, failure); assert.equal(observed.code, null); assert.equal(observed.signal, null);
    assert.equal(observed.stdout, ''); assert.equal(observed.stderr, ''); assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0, 'synchronous spawn failure leaves no deadline timer');
  }, failure);
});

test('AC4 abnormal natural signal is recorded without any signal being sent by observer', async t => harness(t, async h => {
  const result = h.observeProcessUntilClose('node.exe', [], options());
  h.at(4); h.close(null, 'SIGTERM'); const observed = await result;
  assert.equal(observed.code, null); assert.equal(observed.signal, 'SIGTERM'); assert.equal(observed.deadlineExceeded, false);
}));

test('AC4 early timer delivery cannot declare a deadline before monotonic N', async t => harness(t, async h => {
  let notices = 0;
  const result = h.observeProcessUntilClose('node.exe', [], options(() => { notices++; }));
  h.at(N - 1); h.fire();
  assert.equal(notices, 0); assert.equal(await pending(result), true);
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 1);
  h.at(N); h.fire(); assert.equal(notices, 1); assert.equal(await pending(result), true);
  h.close(); const observed = await result;
  assert.equal(observed.deadlineExceeded, true); assert.equal(observed.elapsedMs, N);
  assert.equal(notices, 1); assert.equal(h.timers.size, 0);
}));

test('AC4 synchronous spawn time consumes the initial monotonic deadline budget', async t => harness(t, async h => {
  const result = h.observeProcessUntilClose('node.exe', [], options());
  assert.equal(h.calls[0].now, 1000);
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, N - 7);
  h.at(N - 1); h.close(); const observed = await result;
  assert.equal(observed.elapsedMs, N - 1); assert.equal(observed.deadlineExceeded, false);
  assert.equal(h.timers.size, 0);
}, undefined, 7));
