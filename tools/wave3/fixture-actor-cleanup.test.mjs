import assert from 'node:assert/strict';
import test from 'node:test';

// PERF-BGSTAB-011: inert actors and callbacks; no process or filesystem deletion.
const load = () => import('./fixture-actor-cleanup.mjs');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function pending(promise) { let settled = false; promise.then(() => { settled = true; }, () => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); return !settled; }
const closed = () => ({ code: 0, signal: null });
function actor() { const wait = deferred(); const value = { released: false, exitState: undefined, exited: wait.promise }; return { value, finish() { value.exitState = closed(); wait.resolve(value.exitState); }, reject: wait.reject }; }
async function failureOf(promise) { try { await promise; } catch (error) { return { error }; } assert.fail('expected rejection'); }
const failures = error => error instanceof AggregateError ? error.errors : [error];

test('actor cleanup pending observer distinguishes settled and pending promises', async () => {
  assert.equal(await pending(Promise.resolve()), false); assert.equal(await pending(Promise.reject(Error('done'))), false);
  const wait = deferred(); assert.equal(await pending(wait.promise), true); wait.resolve(); assert.equal(await pending(wait.promise), false);
});

test('actor cleanup releases later actor after first release throws and awaits both actual exits', async () => {
  const { settleActorCleanup } = await load(); const a = actor(), b = actor(), error = Error('release a'), calls = [];
  const result = settleActorCleanup([{ actor: a.value, releaseByte: 11 }, { actor: b.value, releaseByte: 22 }], (value, byte) => {
    calls.push([value, byte]); if (value === a.value) throw error; value.released = true;
  });
  const failed = failureOf(result);
  assert.equal(await pending(failed), true); assert.deepEqual(calls, [[a.value, 11], [b.value, 22]]);
  a.finish(); assert.equal(await pending(failed), true); b.finish(); assert.equal((await failed).error, error);
});

test('actor cleanup deduplicates actor identity and never invents release for absent released exited or ungated actors', async () => {
  const { settleActorCleanup } = await load(); const gated = actor(), ungated = actor(), released = actor(), exited = actor();
  released.value.released = true; exited.finish(); const calls = [];
  const result = settleActorCleanup([
    { actor: undefined }, { actor: gated.value, releaseByte: 0 }, { actor: gated.value, releaseByte: 0 },
    { actor: released.value, releaseByte: 1 }, { actor: exited.value, releaseByte: 2 }, { actor: ungated.value },
  ], (value, byte) => { calls.push([value, byte]); value.released = true; });
  assert.equal(await pending(result), true); assert.deepEqual(calls, [[gated.value, 0]]);
  gated.finish(); released.finish(); assert.equal(await pending(result), true); ungated.finish(); await result;
});

test('actor cleanup preserves body release and exit failures while missing termination remains explicit', async () => {
  const { settleActorCleanup } = await load(); const a = actor(), body = Error('body'), release = Error('release'), exit = Error('exit');
  const result = failureOf(settleActorCleanup([{ actor: a.value, releaseByte: 1 }], () => { throw release; }, { error: body }));
  assert.equal(await pending(result), true); a.reject(exit);
  const reasons = failures((await result).error);
  for (const error of [body, release, exit]) assert.ok(reasons.includes(error));
  assert.ok(reasons.some(error => /exit|termination|unconfirmed/i.test(String(error)) && error !== exit));
});

test('actor cleanup retains throw undefined and deduplicates identical failure values', async () => {
  const { settleActorCleanup } = await load(); const a = actor(); a.finish();
  assert.equal((await failureOf(settleActorCleanup([{ actor: a.value }], () => undefined, { error: undefined }))).error, undefined);
  const b = actor(), same = Error('same');
  const result = failureOf(settleActorCleanup([{ actor: b.value, releaseByte: 1 }], () => { throw same; }, { error: same }));
  b.finish(); assert.equal((await result).error, same);
});

for (const state of [undefined, {}, { code: null, signal: null }, { code: 0 }, { signal: null }]) {
  test(`actor parent cleanup refuses malformed exitState ${JSON.stringify(state)} and retains named paths`, async () => {
    const { cleanupExitedActors } = await load(); const paths = ['owned-fixture-root', 'owned-harness-root']; let calls = 0;
    const prior = Error('original body');
    const failure = await failureOf(cleanupExitedActors([{ exitState: state, exited: Promise.resolve(closed()) }], paths, () => { calls++; }, { error: prior }));
    assert.equal(calls, 0); const reasons = failures(failure.error); assert.ok(reasons.includes(prior));
    const text = reasons.map(String).join('\n'); for (const path of paths) assert.ok(text.includes(path));
  });
}

test('actor parent cleanup executes once only with actual confirmed exits and preserves cleanup and prior failures', async () => {
  const { cleanupExitedActors } = await load(); const a = { exitState: closed() }, prior = Error('body'), cleanup = Error('cleanup'); let calls = 0;
  const failure = await failureOf(cleanupExitedActors([undefined, a, a], ['owned-root'], () => { calls++; throw cleanup; }, { error: prior }));
  assert.equal(calls, 1); assert.deepEqual(new Set(failures(failure.error)), new Set([prior, cleanup]));
  let successful = 0; await cleanupExitedActors([a], ['owned-root'], () => { successful++; }); assert.equal(successful, 1);
  assert.equal((await failureOf(cleanupExitedActors([a], [], () => { throw undefined; }))).error, undefined);
});

test('actor parent cleanup never deletes while an exit is still pending even when release was sent', async () => {
  const { cleanupExitedActors } = await load(); const a = actor(); a.value.released = true; let calls = 0;
  await failureOf(cleanupExitedActors([a.value], ['owned-root'], () => { calls++; }));
  assert.equal(calls, 0); a.finish();
  await cleanupExitedActors([a.value], ['owned-root'], () => { calls++; }); assert.equal(calls, 1);
});
