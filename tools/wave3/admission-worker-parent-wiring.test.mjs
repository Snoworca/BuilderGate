import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import * as lifecycle from './admission-worker-lifecycle.mjs';
import { createSegmentReparseGuard as realCreateSegmentReparseGuard } from './fair-readmission-closure-v3.mjs';
import { loadFixtureHarness } from './internal/admission-fixture-test-harness.mjs';
const require = createRequire(import.meta.url), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const root = 'C:\\virtual-canonical', analysisRoot = path.win32.join(root, 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
async function checkpoint() { await new Promise(resolve => setImmediate(resolve)); }
function assertPermits(events, started, requireReads = false) {
  const expected = Array.from({ length: started }, (_, i) => 3 + i);
  const actual = [...new Set(events.filter(([kind, slot, value]) => kind === 'store' && slot >= 3 && value === 1).map(([, slot]) => slot))].sort();
  assert.deepEqual(actual, expected, 'exact per-started-Worker cleanup slots, never capture counter2');
  for (const slot of [1, ...expected]) {
    const stored = events.findIndex(([kind, index, value]) => kind === 'store' && index === slot && value === 1);
    const notified = events.findIndex(([kind, index]) => kind === 'notify' && index === slot);
    assert.ok(stored >= 0 && notified > stored, `slot${slot} stores its permit before notify`);
    if (requireReads && slot >= 3) {
      const reads = events.map((event, index) => ({ event, index })).filter(({ event }) => event[0] === 'read');
      assert.equal(reads.length, started); assert.ok(reads.every(({ index }) => index < stored), 'both manifest reads precede every cleanup permit');
    }
  }
}
// Teardown only: callers must snapshot all success/error-path observations first.
// Complete the finite old callback using inert state, never real process operations.
async function drainInertParent(h, result, isSettled) {
  for (const worker of h.workers) {
    worker.control[0] = h.workers.length;
    if (worker.control.length > 2) worker.control[2] = h.workers.length;
    if (!worker.captureReported) {
      worker.emit('message', { phase: 'captured', index: worker.index, manifestPath: worker.manifestPath, sha256: 'a'.repeat(64) });
    }
  }
  while (!isSettled()) {
    // Every newly entered sequential wait gets another clock advance, rather
    // than inheriting a one-off advance made before its deadline existed.
    h.advance(200000);
    for (const [id, timer] of [...h.timers]) { h.timers.delete(id); timer.fn(); }
    for (const worker of h.workers) worker.exit();
    await checkpoint();
  }
  await result;
}
function parentHarness(suite, { constructorFails = false, readFailure } = {}) {
  const sourceUrl = new URL(`./fair-readmission-closure-v3.${suite}-race.test.mjs`, import.meta.url);
  const ast = ts.createSourceFile(sourceUrl.pathname, readFileSync(sourceUrl, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = []; function visit(n) { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'test' && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.startsWith('SDS-AC-4')) calls.push(n); ts.forEachChild(n, visit); } visit(ast);
  assert.equal(calls.length, 1);
  // Keep definitions, but never execute the top-level Worker await branch.
  const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n)).map(n => n.getText(ast)).join('\n');
  const body = calls[0].arguments.at(-1).getText(ast).replaceAll('import.meta.url', `'file:///C:/virtual-canonical/tools/wave3/fair-readmission-closure-v3.${suite}-race.test.mjs'`);
  const fixture = loadFixtureHarness('trust'), helper = fixture.loadHelper();
  const workers = [], events = [], timers = new Map(); let timerId = 0, now = 0;
  const constructionError = Error('second Worker construction failed');
  class Worker extends EventEmitter {
    emit(event, ...args) {
      if (event === 'message' && args[0]?.phase === 'captured') this.captureReported = true;
      return super.emit(event, ...args);
    }
    constructor(_url, options) {
      super(); if (constructorFails && workers.length === 1) throw constructionError;
      this.index = workers.length; this.data = options.workerData; this.closed = false;
      this.control = new Int32Array(this.data.barrier ?? this.data.controlBuffer);
      this.manifestPath = this.data.manifestPath ?? this.data.leaf ?? path.win32.join(analysisRoot, `worker-${this.index}.json`);
      workers.push(this); events.push(['constructed', this.index]);
    }
    ready() { this.control[0]++; this.emit('message', { phase: 'ready', index: this.index, manifestPath: this.manifestPath }); }
    captured() { if (this.control.length > 2) this.control[2]++; this.emit('message', { phase: 'captured', index: this.index, manifestPath: this.manifestPath, sha256: 'a'.repeat(64) }); }
    exit(code = 0) { this.closed = true; events.push(['exit', this.index]); this.emit('exit', code); }
  }
  const atomics = {
    load: (array, slot) => array[slot],
    store: (array, slot, value) => { array[slot] = value; events.push(['store', slot, value]); return value; },
    notify: (_array, slot) => { events.push(['notify', slot]); return 1; },
  };
  const fs = {
    lstatSync(p) {
      const normalized = path.win32.normalize(p);
      const worker = workers.find(w => path.win32.normalize(w.manifestPath) === normalized);
      const isLeaf = Boolean(worker);
      const directory = !isLeaf || readFailure === 'role';
      events.push(['stat', normalized]);
      return { dev: 1, ino: isLeaf ? worker.index + 10 : 1, mode: directory ? 16877 : 33188, ctimeMs: 1, mtimeMs: 1, size: 100,
        isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, isReparsePoint: () => false };
    },
    existsSync: p => { const worker = workers.find(w => path.win32.normalize(w.manifestPath) === path.win32.normalize(p)); return worker ? !worker.closed : false; },
    readFileSync(p) {
      const worker = workers.find(w => path.win32.normalize(w.manifestPath) === path.win32.normalize(p)); assert.ok(worker);
      events.push(['read', worker.index]); assert.equal(worker.closed, false, 'parent must verify while capture owner remains alive');
      return JSON.stringify({ phase: `${suite}-native-worker-${worker.index}`, protectedInput: { sha256: 'a'.repeat(64), value: { sourceClosureRows: [{ path: 'server/src/services/TerminalResourcePolicyCanary.test.ts' }] } } });
    },
    unlinkSync: p => { events.push(['parent-delete', p]); assert.fail('parent never receives deletion authority'); },
  };
  const createSegmentReparseGuard = (...args) => {
    assert.equal(args.length, 0, 'parent must request its default native guard');
    const guard = realCreateSegmentReparseGuard({ fs, probeBatch(paths) {
      events.push(['native', ...paths]);
      if (readFailure === 'native') throw Error('controlled native read revalidation failure');
      return false;
    } });
    return {
      ...guard,
      assertSafeMany(paths, options) { assert.equal(options?.forceFresh, true); return guard.assertSafeMany(paths, options); },
      assertSafe(p, options) { assert.equal(options?.forceFresh, true); return guard.assertSafe(p, options); },
    };
  };
  const callback = new Function('assert', 'path', 'workspaceRoot', 'analysisRoot', 'process', 'randomBytes', 'Worker', 'Atomics', 'readFileSync', 'existsSync', 'unlinkSync', 'waitForWorkerCondition', 'registerWorker', 'releaseAndAwaitWorkers', 'recordWorkerPhase', 'createOwnedAnalysisLeaf', 'setTimeout', 'clearTimeout', 'Date', 'createSegmentReparseGuard', 'lstatSync', 'describeWorkerFailure',
    `${functions}; return (${body});`)(assert, path.win32, root, analysisRoot, { pid: 777 }, () => Buffer.alloc(8), Worker, atomics, fs.readFileSync, fs.existsSync, fs.unlinkSync, lifecycle.waitForWorkerCondition, lifecycle.registerWorker, lifecycle.releaseAndAwaitWorkers, lifecycle.recordWorkerPhase, helper.createOwnedAnalysisLeaf,
    (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, id => timers.delete(id), { now: () => now }, createSegmentReparseGuard, fs.lstatSync, lifecycle.describeWorkerFailure);
  return { callback, workers, events, constructionError, timers, advance(value) { now += value; },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    poll() { for (const [id, timer] of [...timers]) if (timer.ms <= 5) { timers.delete(id); timer.fn(); } },
  };
}

for (const suite of ['trust', 'seal', 'lexical']) {
  for (const readFailure of ['native', 'role']) test(`AC5 actual ${suite} parent ${readFailure} failure blocks reads but releases and awaits owners`, async t => {
    const h = parentHarness(suite, { readFailure });
    t.mock.method(globalThis, 'setTimeout', h.setTimeout); t.mock.method(globalThis, 'clearTimeout', h.clearTimeout);
    let settled = false, failure;
    const result = h.callback().then(() => { settled = true; }, error => { failure = error; settled = true; });
    try {
      for (const worker of h.workers) worker.ready();
      for (let i = 0; i < 8; i++) { h.poll(); await checkpoint(); }
      for (const worker of h.workers) worker.captured();
      for (let i = 0; i < 8; i++) { h.poll(); await checkpoint(); }
      const observed = [...h.events], wasPending = !settled;
      h.workers[0].exit(); await checkpoint(); const stillPending = !settled;
      h.workers[1].exit(); await drainInertParent(h, result, () => settled);
      assert.ok(observed.some(([kind]) => kind === (readFailure === 'native' ? 'native' : 'stat')), 'actual pre-read validation must execute');
      assert.equal(observed.some(([kind]) => kind === 'read'), false);
      assertPermits(observed, 2); assert.equal(wasPending, true); assert.equal(stillPending, true);
      assert.ok(failure); assert.equal(h.events.some(([kind]) => kind === 'parent-delete'), false);
    } finally { await drainInertParent(h, result, () => settled); t.mock.restoreAll(); }
  });
  test(`AC5 actual ${suite} parent registers first Worker before later construction failure and awaits its exit`, async () => {
    const h = parentHarness(suite, { constructorFails: true }); let settled = false, failure;
    const result = h.callback().then(() => { settled = true; }, error => { failure = error; settled = true; });
    await checkpoint(); assert.equal(h.workers.length, 1);
    const worker = h.workers[0];
    const registered = worker.listenerCount('exit') > 0 && worker.listenerCount('error') > 0;
    const pendingBeforeExit = !settled, beforeExitEvents = [...h.events];
    // Inert event is always released so the test itself cannot strand a resource.
    worker.exit(); await result;
    assert.equal(registered, true, 'first handle must be observed before second constructor can throw');
    assert.equal(pendingBeforeExit, true, 'parent cannot reject before first actual exit');
    assertPermits(beforeExitEvents, 1);
    assert.ok(failure === h.constructionError || failure instanceof AggregateError && failure.errors.includes(h.constructionError));
    assert.equal(settled, true); assert.equal(h.events.some(([kind]) => kind === 'parent-delete'), false);
  });
  test(`AC5 actual ${suite} parent source keeps verification before exit waits and has no parent leaf deletion`, () => {
    const url = new URL(`./fair-readmission-closure-v3.${suite}-race.test.mjs`, import.meta.url);
    const ast = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
    const parents = []; function visit(n) { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'test' && n.arguments[0]?.text?.startsWith('SDS-AC-4')) parents.push(n.arguments.at(-1)); ts.forEachChild(n, visit); } visit(ast);
    assert.equal(parents.length, 1); const body = parents[0].getText(ast);
    const firstRead = body.indexOf('readFileSync('); assert.ok(firstRead >= 0, 'preserve actual manifest verification');
    const exitsBeforeRead = body.slice(0, firstRead).match(/await\s+Promise\.all\(exits\)/);
    assert.equal(exitsBeforeRead, null, 'Worker must retain its capture capability until parent verification');
    assert.doesNotMatch(body, /removeOwnedLeaf\(|removeTestLeaf\(|unlinkSync\(|rmSync\(/, 'parent may release cleanup permission, never delete a Worker-owned leaf');
  });
  test(`AC5 actual ${suite} parent verifies both live Worker manifests before cleanup permission and waits for all exits`, async t => {
    const h = parentHarness(suite);
    t.mock.method(globalThis, 'setTimeout', h.setTimeout); t.mock.method(globalThis, 'clearTimeout', h.clearTimeout);
    let settled = false, failure;
    const result = h.callback().then(() => { settled = true; }, error => { settled = true; failure = error; });
    try {
      assert.equal(h.workers.length, 2);
      for (const worker of h.workers) worker.ready();
      for (let i = 0; i < 8; i++) { h.poll(); await checkpoint(); }
      assert.ok(h.events.some(([kind, slot, value]) => kind === 'store' && slot === 1 && value === 1), 'existing start barrier is released');
      for (const worker of h.workers) worker.captured();
      for (let i = 0; i < 8; i++) { h.poll(); await checkpoint(); }
      const readsBeforeExit = h.events.filter(([kind]) => kind === 'read').length;
      const beforeExitEvents = [...h.events];
      const pendingBeforeExit = !settled;
      h.workers[0].exit(); await checkpoint(); const pendingAfterFirstExit = !settled;
      h.workers[1].exit(); await drainInertParent(h, result, () => settled);
      assert.equal(readsBeforeExit, 2, 'actual parent must read both manifests before owners exit');
      assertPermits(beforeExitEvents, 2, true);
      assert.equal(pendingBeforeExit, true); assert.equal(pendingAfterFirstExit, true);
      assert.equal(h.events.some(([kind]) => kind === 'parent-delete'), false);
      assert.equal(failure, undefined);
    } finally {
      for (const worker of h.workers) if (!worker.closed) worker.exit();
      await drainInertParent(h, result, () => settled); t.mock.restoreAll();
    }
  });
  for (const mode of ['worker-error', 'timeout']) test(`AC5 actual ${suite} parent ${mode} releases cleanup state and awaits exits without deleting paths`, async t => {
    const h = parentHarness(suite);
    t.mock.method(globalThis, 'setTimeout', h.setTimeout); t.mock.method(globalThis, 'clearTimeout', h.clearTimeout);
    let settled = false, failure;
    const result = h.callback().then(() => { settled = true; }, error => { settled = true; failure = error; });
    try {
      for (const worker of h.workers) worker.ready();
      if (mode === 'worker-error') h.workers[0].emit('error', Error('early Worker capture failure'));
      else { for (let i = 0; i < 8; i++) { h.advance(200000); for (const [id, timer] of [...h.timers]) { h.timers.delete(id); timer.fn(); } await checkpoint(); } }
      for (let i = 0; i < 8; i++) { h.poll(); await checkpoint(); }
      const before = !settled;
      const beforeExitEvents = [...h.events], pendingTimers = h.timers.size;
      // No rescue before the error-only observation snapshot above.
      h.workers[0].exit(1); await checkpoint(); const afterFirst = !settled;
      h.workers[1].exit(); await drainInertParent(h, result, () => settled);
      assert.equal(before, true); assert.equal(afterFirst, true);
      assertPermits(beforeExitEvents, 2);
      assert.equal(pendingTimers, 0, 'error or timeout stops condition polling before exit settlement');
      assert.ok(failure); assert.equal(h.events.some(([kind]) => kind === 'parent-delete'), false);
    } finally { for (const worker of h.workers) if (!worker.closed) worker.exit(); await drainInertParent(h, result, () => settled); t.mock.restoreAll(); }
  });
}
