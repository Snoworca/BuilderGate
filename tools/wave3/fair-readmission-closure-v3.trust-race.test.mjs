import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { createOwnedAnalysisLeaf } from './admission-fixture-ownership.mjs';
import { createSegmentReparseGuard } from './fair-readmission-closure-v3.mjs';
import { waitForWorkerCondition, registerWorker, releaseAndAwaitWorkers, recordWorkerPhase, describeWorkerFailure } from './admission-worker-lifecycle.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const analysisRoot = path.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);

function waitForMessages(messages, predicate, label, timeoutMs = 30_000) {
  return waitForWorkerCondition(predicate, { timeoutMs, pollMs: 5, label });
}

async function runWorkerRace() {
  const { index, barrier, collectorUrl } = workerData;
  const control = new Int32Array(barrier);
  let leaf, priorFailure;
  try {
    try {
      await import(collectorUrl);
      leaf = createOwnedAnalysisLeaf(`trust-native-worker-${index}`);
      Atomics.add(control, 0, 1);
      parentPort.postMessage({ phase: 'ready', index, manifestPath: leaf.manifestPath });
      Atomics.wait(control, 1, 0);

      const manifest = leaf.capture(`trust-native-worker-${index}`);
      Atomics.add(control, 2, 1);
      parentPort.postMessage({ phase: 'captured', index, manifestPath: leaf.manifestPath, sha256: manifest.protectedInput.sha256 });
    } catch (error) {
      priorFailure = { error };
      // A capture failure must wake the parent before waiting for cleanup permission.
      if (leaf) parentPort.postMessage({ phase: 'error', index, message: describeWorkerFailure(error) });
    } finally {
      if (leaf) {
        while (Atomics.load(control, 3 + index) === 0) Atomics.wait(control, 3 + index, 0);
        leaf.cleanup(priorFailure);
      } else if (priorFailure) throw priorFailure.error;
    }
  } catch (error) {
    parentPort.postMessage({ phase: 'error', index, message: describeWorkerFailure(error) });
    process.exitCode = 1;
  }
}

if (!isMainThread && workerData?.kind === 'fair-readmission-trust-race') {
  await runWorkerRace();
} else {
  test('SDS-AC-4 releases two real Workers through shared barriers to native distinct manifest leaves and cleans both leaves', { timeout: 115_000 }, async () => {
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5);
    const control = new Int32Array(barrier);
    const owners = new Set(), seenPaths = new Set(), messages = [];
    let priorFailure;
    try {
      for (let index = 0; index < 2; index++) {
        const entry = registerWorker(owners, () => new Worker(new URL(import.meta.url), {
          workerData: { kind: 'fair-readmission-trust-race', index, barrier,
            collectorUrl: new URL('./fair-readmission-closure-v3.mjs', import.meta.url).href },
        }), () => {
          const failures = [];
          // Even a failed store/notify must not skip another owned permit.
          for (const slot of [1, 3 + index]) {
            try { Atomics.store(control, slot, 1); } catch (error) { failures.push(error); }
            try { Atomics.notify(control, slot, 2); } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, 'Worker permit release failed');
        });
        entry.worker.on('message', message => {
          if (message?.phase === 'error') {
            entry.errors.push(new Error(message.message));
            messages.push(message);
            return;
          }
          try {
            recordWorkerPhase(entry, message, { index, analysisRoot, seenPaths });
            messages.push(message);
          } catch (error) { entry.errors.push(error); }
        });
      }
      const healthy = predicate => () => {
        const failures = [...owners].flatMap(entry => entry.errors);
        if (failures.length) throw new AggregateError(failures, 'Worker failed before verification');
        assert.equal([...owners].some(entry => entry.exitCode !== undefined), false, 'Worker must retain its manifest until parent verification');
        return predicate();
      };
      await waitForMessages(messages, healthy(() => [...owners].every(entry => entry.ready)), 'both native Worker ready acknowledgements', 20_000);
      assert.equal(Atomics.load(control, 0), owners.size, 'each worker must reach the shared start barrier before capture');
      assert.deepEqual(messages.filter(message => message.phase === 'captured'), [], 'neither capture may run before the parent releases the barrier');
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1, owners.size);
      await waitForMessages(messages, healthy(() => [...owners].every(entry => entry.captured)), 'both native Worker capture acknowledgements', 100_000);
      assert.equal(Atomics.load(control, 2), owners.size, 'both workers must complete capture after the shared start barrier');
      assert.deepEqual(messages.filter(message => message.phase === 'error'), [], 'the Worker protocol must not hide capture errors');
      assert.equal(messages.filter(message => message.phase === 'captured').length, 2, 'both real Workers must report capture');
      assert.equal(seenPaths.size, 2, 'each worker must own a distinct manifest leaf');
      const guard = createSegmentReparseGuard();
      for (const [index, entry] of [...owners].entries()) {
        const leaf = entry.captured.manifestPath;
        guard.assertSafeMany([workspaceRoot, path.join(workspaceRoot, 'docs'), path.join(workspaceRoot, 'docs', 'analysis'), analysisRoot, leaf], { forceFresh: true });
        const stat = lstatSync(leaf);
        assert.equal(stat.isFile() && !stat.isSymbolicLink() && !stat.isReparsePoint?.(), true, 'Worker manifest must remain a regular leaf');
        assert.equal(existsSync(leaf), true, `worker ${index} must create its distinct native leaf`);
        const manifest = JSON.parse(readFileSync(leaf, 'utf8'));
        assert.equal(manifest.phase, `trust-native-worker-${index}`, `worker ${index} must preserve its native capture phase`);
        assert.match(entry.captured.sha256, /^[a-f0-9]{64}$/);
        assert.equal(manifest.protectedInput.sha256, entry.captured.sha256, 'captured message must identify the retained manifest');
      }
    } catch (error) {
      priorFailure = { error };
    } finally {
      await releaseAndAwaitWorkers(owners, priorFailure);
    }
    assert.deepEqual([...owners].map(entry => entry.exitCode), [0, 0], 'both Workers must exit cleanly after verification and owner cleanup');
    for (const entry of owners) assert.equal(existsSync(entry.ready.manifestPath), false, 'each Worker must clean its own manifest before exit');
  });
}
