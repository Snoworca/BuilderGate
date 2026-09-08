import assert from 'node:assert/strict';
import test from 'node:test';

// PERF-BGSTAB-011: controlled runner promises, no physical fixture or process.
const load = () => import('./settled-subtest.mjs');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function observePending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  // Drain prior promise reactions through an event-loop checkpoint, not a timed race.
  await new Promise(resolve => setImmediate(resolve));
  return !settled;
}

test('pending observer distinguishes fulfilled rejected and genuinely deferred promises', async () => {
  assert.equal(await observePending(Promise.resolve('done')), false);
  assert.equal(await observePending(Promise.reject(Error('done'))), false);
  const pending = deferred();
  assert.equal(await observePending(pending.promise), true);
  pending.resolve();
  assert.equal(await observePending(pending.promise), false);
});

test('settled subtest preserves exact runner name options callback arguments and normal values', async () => {
  const { runSettledSubtest } = await load();
  const options = { timeout: 115000 }, args = [{ marker: 'child-context' }, { marker: 'argument-two' }];
  const bodyValue = { body: 'value' }, runnerValue = { runner: 'value' }; let calls = 0;
  const context = { async test(name, receivedOptions, callback) {
    calls++; assert.equal(name, 'original name'); assert.equal(receivedOptions, options);
    assert.equal(await callback(...args), bodyValue); return runnerValue;
  } };
  assert.equal(await runSettledSubtest(context, 'original name', options, (...actual) => {
    assert.equal(actual[0], args[0]); assert.equal(actual[1], args[1]); return bodyValue;
  }), runnerValue);
  assert.equal(calls, 1);
});

test('settled subtest blocks owner progression until an early-resolved runner body and finally finish', async () => {
  const { runSettledSubtest } = await load();
  const releaseBody = deferred(), enteredFinally = deferred(), releaseFinally = deferred();
  const events = []; let bodyPromise;
  const context = { test(_name, _options, callback) { bodyPromise = callback(); return Promise.resolve('runner-done'); } };
  const result = runSettledSubtest(context, 'early', {}, async () => {
    events.push('body');
    try { await releaseBody.promise; }
    finally { events.push('finally-start'); enteredFinally.resolve(); await releaseFinally.promise; events.push('finally-end'); }
  }).then(value => { events.push('owner'); return value; });
  assert.equal(await observePending(result), true); assert.deepEqual(events, ['body']);
  releaseBody.resolve(); await enteredFinally.promise;
  assert.equal(await observePending(result), true); assert.deepEqual(events, ['body', 'finally-start']);
  releaseFinally.resolve(); await bodyPromise;
  assert.equal(await result, 'runner-done'); assert.deepEqual(events, ['body', 'finally-start', 'finally-end', 'owner']);
});

test('settled subtest returns skipped runner result without inventing or waiting for an unstarted body', async () => {
  // Node skip/cancel-before-start never invokes this callback after runner settlement.
  // A synthetic runner that starts it arbitrarily later is outside this contract.
  const { runSettledSubtest } = await load(); let started = false;
  const value = { skipped: true };
  assert.equal(await runSettledSubtest({ test: async () => value }, 'skip', { skip: true }, () => { started = true; }), value);
  assert.equal(started, false);
});

test('settled subtest retains early runner rejection but awaits body completion first', async () => {
  const { runSettledSubtest } = await load(); const release = deferred(); const runnerError = Error('runner timed out');
  const events = []; let bodyPromise;
  const result = runSettledSubtest({ test(_n, _o, callback) { bodyPromise = callback(); return Promise.reject(runnerError); } }, 'timeout', {}, async () => {
    try { await release.promise; } finally { events.push('finally'); }
  });
  const checked = assert.rejects(result, error => { events.push('owner-rejected'); return error === runnerError; });
  assert.equal(await observePending(checked), true); assert.deepEqual(events, []);
  release.resolve(); await bodyPromise; await checked;
  assert.deepEqual(events, ['finally', 'owner-rejected']);
});

test('settled subtest surfaces a late body rejection after runner success', async () => {
  const { runSettledSubtest } = await load(); const release = deferred(), failure = Error('late body');
  const result = runSettledSubtest({ test(_n, _o, callback) { callback().catch(() => undefined); return Promise.resolve(); } }, 'late', {}, async () => { await release.promise; throw failure; });
  const checked = assert.rejects(result, error => error === failure);
  assert.equal(await observePending(checked), true); release.resolve(); await checked;
});

test('settled subtest aggregates distinct runner and body failures without dropping either', async () => {
  const { runSettledSubtest } = await load(); const release = deferred(), runnerError = Error('runner'), bodyError = Error('body');
  const result = runSettledSubtest({ test(_n, _o, callback) { callback().catch(() => undefined); return Promise.reject(runnerError); } }, 'dual', {}, async () => { await release.promise; throw bodyError; });
  const checked = assert.rejects(result, error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.ok(error.errors.includes(runnerError)); assert.ok(error.errors.includes(bodyError)); return true;
  });
  assert.equal(await observePending(checked), true); release.resolve(); await checked;
});

test('settled subtest preserves synchronous body throw and does not duplicate the same runner error', async () => {
  const { runSettledSubtest } = await load(); const failure = Error('synchronous body');
  await assert.rejects(runSettledSubtest({ test: async (_n, _o, callback) => callback() }, 'sync', {}, () => { throw failure; }), error => error === failure);
});

test('settled subtest preserves a runner failure before callback start without waiting for a nonexistent body', async () => {
  const { runSettledSubtest } = await load(); const failure = Error('cancelled before start'); let started = false;
  await assert.rejects(runSettledSubtest({ test: () => { throw failure; } }, 'cancel', {}, () => { started = true; }), error => error === failure);
  assert.equal(started, false);
});

test('settled subtest awaits an already-started body when the runner throws synchronously', async () => {
  const { runSettledSubtest } = await load(); const release = deferred(), failure = Error('sync runner');
  let finished = false;
  const result = runSettledSubtest({ test(_n, _o, callback) { callback(); throw failure; } }, 'sync-runner', {}, async () => {
    try { await release.promise; } finally { finished = true; }
  });
  const checked = assert.rejects(result, error => { assert.equal(finished, true); return error === failure; });
  assert.equal(await observePending(checked), true); release.resolve(); await checked;
});
