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
const dynamicImportSources = [
  'server/src/ws/FairTerminalDeliveryScheduler.test.ts',
  'server/src/ws/WsRouterSendPriority.test.ts',
  'server/src/services/TerminalResourcePolicyCanary.test.ts',
];
const dynamicImportTargets = [
  'server/src/ws/wsSendPolicy.ts',
  'server/src/services/TerminalResourcePolicyCanary.ts',
];

function assertOwnedLeaf(candidate, prefix) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = `${path.resolve(analysisRoot)}${path.sep}`;
  assert.equal(resolvedCandidate.startsWith(resolvedRoot), true, 'cleanup must stay within the test-owned analysis directory');
  assert.equal(path.basename(resolvedCandidate).startsWith(`${prefix}-`), true, 'cleanup must target only this native-worker test nonce');
}

function removeOwnedLeaf(candidate, prefix) {
  assertOwnedLeaf(candidate, prefix);
  if (existsSync(candidate)) unlinkSync(candidate);
}

function waitForMessages(messages, predicate, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    const poll = () => {
      if (predicate()) {
        clearTimeout(deadline);
        resolve();
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function assertDynamicClosureRows(manifest) {
  const sourcePaths = new Set(manifest.protectedInput.value.sourceClosureRows.map(row => row.path));
  for (const sourcePath of [...dynamicImportSources, ...dynamicImportTargets]) {
    assert.equal(
      sourcePaths.has(sourcePath),
      true,
      `default frozen capture must retain ${sourcePath} while resolving the sixteen proved runtime import(identifier) occurrences`,
    );
  }
}

async function runNativeLexicalWorker() {
  const { index, manifestPath, barrier, collectorUrl } = workerData;
  const control = new Int32Array(barrier);
  try {
    const { captureFrozenProvenance } = await import(collectorUrl);
    Atomics.add(control, 0, 1);
    parentPort.postMessage({ phase: 'ready', index });
    Atomics.wait(control, 1, 0);

    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath,
      phase: `lexical-native-worker-${index}`,
    });
    assertDynamicClosureRows(manifest);
    parentPort.postMessage({
      phase: 'captured',
      index,
      manifestPath,
      sha256: manifest.protectedInput.sha256,
    });
  } catch (error) {
    parentPort.postMessage({
      phase: 'error',
      index,
      message: error?.stack ?? error?.message ?? String(error),
    });
    process.exitCode = 1;
  }
}

if (!isMainThread && workerData?.kind === 'fair-readmission-lexical-race') {
  await runNativeLexicalWorker();
} else {
  test('SDS-AC-4 observes a native Worker barrier and default frozen closure for all sixteen proved dynamic imports', { timeout: 115_000 }, async () => {
    const prefix = `lexical-native-race-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const leaves = [
      path.join(analysisRoot, `${prefix}-one.json`),
      path.join(analysisRoot, `${prefix}-two.json`),
    ];
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const control = new Int32Array(barrier);
    const messages = [];
    const workers = leaves.map((manifestPath, index) => new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'fair-readmission-lexical-race',
        index,
        manifestPath,
        barrier,
        collectorUrl: new URL('./fair-readmission-closure-v3.mjs', import.meta.url).href,
      },
    }));
    const exits = workers.map(worker => new Promise(resolve => {
      worker.on('message', message => messages.push(message));
      worker.once('error', error => messages.push({ phase: 'worker-error', message: error?.stack ?? error?.message ?? String(error) }));
      worker.once('exit', code => resolve(code));
    }));

    try {
      await waitForMessages(messages, () => messages.filter(message => message.phase === 'ready').length === workers.length, 'both native Worker ready acknowledgements');
      assert.equal(Atomics.load(control, 0), workers.length, 'each worker must reach the shared release barrier before either default capture begins');
      assert.deepEqual(messages.filter(message => message.phase === 'captured'), [], 'neither default capture may run before the creator releases the barrier');

      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1, workers.length);
      await waitForMessages(
        messages,
        () => messages.filter(message => message.phase === 'captured').length === workers.length
          || messages.some(message => message.phase === 'error' || message.phase === 'worker-error'),
        'both native Worker default-capture acknowledgements or a surfaced worker failure',
        100_000,
      );

      assert.deepEqual(messages.filter(message => message.phase === 'error'), [], 'the native lexical worker protocol must not hide capture errors');
      assert.deepEqual(messages.filter(message => message.phase === 'worker-error'), [], 'the native lexical worker protocol must surface no worker runtime errors');
      const exitCodes = await Promise.all(exits);
      assert.deepEqual(exitCodes, [0, 0], 'both native Worker default captures must exit cleanly');
      assert.equal(new Set(leaves.map(candidate => path.resolve(candidate))).size, leaves.length, 'each worker must own a distinct manifest leaf');
      for (const [index, leaf] of leaves.entries()) {
        assert.equal(existsSync(leaf), true, `worker ${index} must create its distinct owned leaf`);
        assert.equal(JSON.parse(readFileSync(leaf, 'utf8')).phase, `lexical-native-worker-${index}`, `worker ${index} must retain its own capture phase`);
      }
    } finally {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1, workers.length);
      await Promise.allSettled(exits);
      for (const leaf of leaves) removeOwnedLeaf(leaf, prefix);
      for (const leaf of leaves) assert.equal(existsSync(leaf), false, 'the creator must clean every leaf it owns');
    }
  });
}
