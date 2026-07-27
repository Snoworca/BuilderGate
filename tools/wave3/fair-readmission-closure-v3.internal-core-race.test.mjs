import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const analysisRoot = path.join(workspaceRoot, 'docs', 'analysis', 'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
const collectorUrl = new URL('./fair-readmission-closure-v3.mjs', import.meta.url).href;
const internalCoreUrl = new URL('./internal/fair-readmission-closure-v3-internal-core.mjs', import.meta.url).href;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

function assertOwnedLeaf(candidate, prefix) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = `${path.resolve(analysisRoot)}${path.sep}`;
  assert.equal(normalizedCandidate.startsWith(normalizedRoot), true, 'cleanup stays within the analysis directory');
  assert.equal(path.basename(normalizedCandidate).startsWith(prefix), true, 'cleanup targets only this test-owned nonce');
}

function removeOwnedLeaf(candidate, prefix) {
  assertOwnedLeaf(candidate, prefix);
  if (existsSync(candidate)) unlinkSync(candidate);
}

async function runNativeWorker() {
  const { controlBuffer, index, leaf } = workerData;
  const control = new Int32Array(controlBuffer);
  try {
    await Promise.all([import(collectorUrl), import(internalCoreUrl)]);
    parentPort.postMessage({ phase: 'ready', index });
    Atomics.wait(control, 0, 0);
    const { captureFrozenProvenance } = await import(collectorUrl);
    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath: leaf,
      phase: `internal-core-native-worker-${index}`,
    });
    parentPort.postMessage({ phase: 'captured', index, leaf, sha256: manifest.protectedInput.sha256 });
  } catch (error) {
    parentPort.postMessage({ phase: 'error', index, message: error?.stack ?? error?.message ?? String(error) });
    process.exitCode = 1;
  }
}

if (!isMainThread && workerData?.kind === 'fair-readmission-internal-core-race') {
  await runNativeWorker();
} else {
  test('SDS-AC-4 awaits two ready messages before native sibling capture release, surfaces errors, and cleans owned leaves', { timeout: 115_000 }, async () => {
    const prefix = `internal-core-race-${process.pid}-${randomBytes(6).toString('hex')}`;
    const leaves = [
      path.join(analysisRoot, `${prefix}-first.json`),
      path.join(analysisRoot, `${prefix}-second.json`),
    ];
    const messages = [];
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const workers = leaves.map((leaf, index) => new Worker(new URL(import.meta.url), {
      workerData: { kind: 'fair-readmission-internal-core-race', controlBuffer: control.buffer, index, leaf },
    }));
    const exits = workers.map(worker => new Promise(resolve => {
      worker.on('message', message => messages.push(message));
      worker.once('error', error => messages.push({ phase: 'worker-error', message: error?.stack ?? error?.message ?? String(error) }));
      worker.once('exit', code => resolve(code));
    }));

    try {
      await waitForReadyMessages(messages, workers.length);
      assert.deepEqual(messages.filter(message => message.phase === 'error' || message.phase === 'worker-error'), [], 'no worker error is hidden before release');
      assert.deepEqual(messages.filter(message => message.phase === 'ready').map(message => message.index).sort(), [0, 1], 'each worker must report readiness before either writes');
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, workers.length);

      assert.deepEqual(await Promise.all(exits), [0, 0], 'both native workers must exit successfully');
      assert.deepEqual(messages.filter(message => message.phase === 'error' || message.phase === 'worker-error'), [], 'all post-release worker errors are surfaced');
      assert.equal(messages.filter(message => message.phase === 'captured').length, workers.length, 'each worker must capture after the message barrier release');
      assert.equal(new Set(leaves.map(leaf => path.resolve(leaf))).size, workers.length, 'workers use distinct sibling leaves');
      for (const [index, leaf] of leaves.entries()) {
        assert.equal(JSON.parse(readFileSync(leaf, 'utf8')).phase, `internal-core-native-worker-${index}`);
      }
    } finally {
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, workers.length);
      await Promise.allSettled(exits);
      for (const leaf of leaves) removeOwnedLeaf(leaf, prefix);
      for (const leaf of leaves) assert.equal(existsSync(leaf), false, 'creator-owned cleanup removes every test leaf');
    }
  });
}
