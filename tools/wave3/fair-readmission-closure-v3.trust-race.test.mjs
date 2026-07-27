import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const analysisRoot = path.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForCounter(view, index, expected, label) {
  const deadline = Date.now() + 20_000;
  while (Atomics.load(view, index) < expected) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

function assertTestOwnedLeaf(candidate, prefix) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = `${path.resolve(analysisRoot)}${path.sep}`;
  assert.equal(normalizedCandidate.startsWith(normalizedRoot), true, 'cleanup may target only this test-owned analysis leaf');
  assert.equal(path.basename(normalizedCandidate).startsWith(prefix), true, 'cleanup may target only this test nonce');
}

function removeTestLeaf(candidate, prefix) {
  assertTestOwnedLeaf(candidate, prefix);
  if (existsSync(candidate)) unlinkSync(candidate);
}

async function runWorkerRace() {
  const { index, leaf, controlBuffer, collectorUrl } = workerData;
  const control = new Int32Array(controlBuffer);
  try {
    const { writeCapturedManifest } = await import(collectorUrl);
    Atomics.add(control, 0, 1);
    parentPort.postMessage({ phase: 'ready', index });
    Atomics.wait(control, 1, 0);

    const fs = {
      mkdirSync: nodeFs.mkdirSync,
      writeFileSync(candidate, text, options) {
        assert.equal(options?.flag, 'wx', 'the concurrent manifest leaf must use exclusive create');
        Atomics.add(control, 2, 1);
        parentPort.postMessage({ phase: 'write-barrier', index, candidate });
        Atomics.wait(control, 3, 0);
        return nodeFs.writeFileSync(candidate, text, options);
      },
    };
    const manifest = {
      schemaVersion: 'trust-race-test',
      worker: index,
      protectedInput: { sha256: String(index).repeat(64) },
    };
    const reparseGuard = {
      assertSafeMany() {},
    };
    writeCapturedManifest({ workspaceRoot, manifestPath: leaf, manifest, fs, reparseGuard });
    parentPort.postMessage({ phase: 'done', index, leaf });
  } catch (error) {
    parentPort.postMessage({
      phase: 'error',
      index,
      message: error?.stack ?? error?.message ?? String(error),
    });
    process.exitCode = 1;
  }
}

if (!isMainThread && workerData?.kind === 'fair-readmission-trust-race') {
  await runWorkerRace();
} else {
  test('SDS-AC-4 releases two real Workers through shared barriers to wx distinct manifest leaves and cleans both leaves', { timeout: 30_000 }, async () => {
    const prefix = `trust-race-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const leaves = [
      path.join(analysisRoot, `${prefix}-first.json`),
      path.join(analysisRoot, `${prefix}-second.json`),
    ];
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4));
    const messages = [];
    const workers = leaves.map((leaf, index) => new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'fair-readmission-trust-race',
        index,
        leaf,
        controlBuffer: control.buffer,
        collectorUrl: new URL('./fair-readmission-closure-v3.mjs', import.meta.url).href,
      },
    }));
    const exits = workers.map(worker => new Promise(resolve => {
      worker.on('message', message => messages.push(message));
      worker.once('error', error => messages.push({ phase: 'worker-error', message: error?.stack ?? error?.message ?? String(error) }));
      worker.once('exit', code => resolve({ code }));
    }));

    try {
      await waitForCounter(control, 0, workers.length, 'both workers to reach the shared start barrier');
      assert.equal(messages.filter(message => message.phase === 'ready').length, 2, 'both real Workers must report ready before either can write');
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1, workers.length);

      await waitForCounter(control, 2, workers.length, 'both workers to reach the shared wx boundary');
      assert.equal(messages.filter(message => message.phase === 'write-barrier').length, 2, 'both distinct leaves must reach the exclusive-create boundary before release');
      Atomics.store(control, 3, 1);
      Atomics.notify(control, 3, workers.length);
      const outcomes = await Promise.all(exits);

      assert.deepEqual(messages.filter(message => message.phase === 'error'), [], 'neither worker may fail under concurrent sibling directory churn');
      assert.deepEqual(messages.filter(message => message.phase === 'worker-error'), [], 'neither worker may terminate with an unreported runtime error');
      assert.deepEqual(outcomes.map(({ code }) => code), [0, 0], 'both workers must exit cleanly after their distinct leaves are admitted');
      assert.equal(messages.filter(message => message.phase === 'done').length, 2, 'each worker must create its own leaf after the shared barrier releases');
      assert.equal(new Set(leaves.map(leaf => path.resolve(leaf))).size, 2, 'the two workers must never contend for the same leaf');
      for (const [index, leaf] of leaves.entries()) {
        assert.equal(existsSync(leaf), true, `worker ${index} must create its distinct wx leaf`);
        assert.equal(JSON.parse(readFileSync(leaf, 'utf8')).worker, index, `worker ${index} must preserve its own manifest payload`);
      }
    } finally {
      Atomics.store(control, 1, 1);
      Atomics.store(control, 3, 1);
      Atomics.notify(control, 1, workers.length);
      Atomics.notify(control, 3, workers.length);
      await Promise.allSettled(exits);
      for (const leaf of leaves) removeTestLeaf(leaf, prefix);
      for (const leaf of leaves) assert.equal(existsSync(leaf), false, 'all test-owned concurrent leaves must be cleaned up');
    }
  });
}
