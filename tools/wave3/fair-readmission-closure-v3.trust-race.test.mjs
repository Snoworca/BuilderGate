import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
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

async function waitForCounter(view, index, expected, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(view, index) < expected) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

async function waitForReadyMessages(messages, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errors = messages.filter(message => message.phase === 'error' || message.phase === 'worker-error');
    if (errors.length > 0) throw new Error(`worker failed before barrier release: ${errors.map(message => message.message).join('\n')}`);
    if (messages.filter(message => message.phase === 'ready').length === expected) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for every ready message');
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
    const { captureFrozenProvenance } = await import(collectorUrl);
    Atomics.add(control, 0, 1);
    parentPort.postMessage({ phase: 'ready', index });
    Atomics.wait(control, 1, 0);

    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath: leaf,
      phase: `trust-native-worker-${index}`,
    });
    Atomics.add(control, 2, 1);
    parentPort.postMessage({ phase: 'captured', index, leaf, sha256: manifest.protectedInput.sha256 });
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
  test('SDS-AC-4 releases two real Workers through shared barriers to native distinct manifest leaves and cleans both leaves', { timeout: 115_000 }, async () => {
    const prefix = `trust-race-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const leaves = [
      path.join(analysisRoot, `${prefix}-first.json`),
      path.join(analysisRoot, `${prefix}-second.json`),
    ];
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
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
      await waitForReadyMessages(messages, workers.length);
      assert.equal(messages.filter(message => message.phase === 'ready').length, 2, 'both real Workers must report ready before either can write');
      assert.deepEqual(messages.filter(message => message.phase === 'error' || message.phase === 'worker-error'), [], 'neither worker may fail before barrier release');
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1, workers.length);

      await waitForCounter(control, 2, workers.length, 'both workers to complete native capture', 100_000);
      const outcomes = await Promise.all(exits);

      assert.deepEqual(messages.filter(message => message.phase === 'error'), [], 'neither worker may fail under concurrent sibling directory churn');
      assert.deepEqual(messages.filter(message => message.phase === 'worker-error'), [], 'neither worker may terminate with an unreported runtime error');
      assert.deepEqual(outcomes.map(({ code }) => code), [0, 0], 'both workers must exit cleanly after their distinct leaves are admitted');
      assert.equal(messages.filter(message => message.phase === 'captured').length, 2, 'each worker must complete native capture after the shared barrier releases');
      assert.equal(new Set(leaves.map(leaf => path.resolve(leaf))).size, 2, 'the two workers must never contend for the same leaf');
      for (const [index, leaf] of leaves.entries()) {
        assert.equal(existsSync(leaf), true, `worker ${index} must create its distinct native leaf`);
        assert.equal(JSON.parse(readFileSync(leaf, 'utf8')).phase, `trust-native-worker-${index}`, `worker ${index} must preserve its own native manifest phase`);
      }
    } finally {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1, workers.length);
      await Promise.allSettled(exits);
      for (const leaf of leaves) removeTestLeaf(leaf, prefix);
      for (const leaf of leaves) assert.equal(existsSync(leaf), false, 'all test-owned concurrent leaves must be cleaned up');
    }
  });
}
