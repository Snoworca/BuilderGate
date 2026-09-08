import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedAnalysisLeaf } from './admission-fixture-ownership.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function callerFilesystem(events) {
  return new Proxy({}, {
    get(_target, property) {
      events.push(String(property));
      throw new Error(`caller filesystem must not be observed: ${String(property)}`);
    },
  });
}

test('SDS-AC-1 keeps deterministic wave admission behind native capture rather than a caller-constructed snapshot', async () => {
  const collector = await loadCollector();
  const leaf = createOwnedAnalysisLeaf('wave-forged-wave');
  const { manifestPath } = leaf;
  const events = [];
  let priorFailure;
  try {
    assert.equal(Object.hasOwn(collector, 'createProtectedInputSnapshot'), false, 'callers cannot construct the wave snapshot');
    assert.throws(
      () => collector.captureFrozenProvenance({
        workspaceRoot,
        manifestPath,
        phase: 'wave-forged-snapshot',
        fs: callerFilesystem(events),
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
    );
    assert.deepEqual(events, [], 'a caller cannot read or reorder protected wave bytes');
    assert.equal(existsSync(manifestPath), false, 'a rejected caller wave cannot publish a manifest');
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }
});

test('SDS-AC-1 and SDS-AC-4 reject caller-selected frontier and reparse batching before native capture', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const leaf = createOwnedAnalysisLeaf('wave-forged-frontier');
  const { manifestPath } = leaf;
  const batches = [];
  let priorFailure;
  const reparseGuard = {
    assertSafeMany(paths) {
      batches.push(paths);
      throw new Error('caller reparse guard must not run');
    },
  };
  try {
    assert.throws(
      () => captureFrozenProvenance({
        workspaceRoot,
        manifestPath,
        phase: 'wave-forged-frontier',
        sourceRoots: Array.from({ length: 65 }, (_, index) => `server/src/generated/${index}.ts`),
        reparseGuard,
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
    );
    assert.deepEqual(batches, [], 'caller batching cannot bless a protected frontier');
    assert.equal(existsSync(manifestPath), false, 'a rejected frontier cannot publish rows');
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }
});

test('SDS-AC-2 rejects every caller-supplied failed-wave cache, digest, row, parser, or discovery state', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const leaf = createOwnedAnalysisLeaf('wave-forged-cache');
  const { manifestPath } = leaf;
  let priorFailure;
  const snapshot = {
    readWave() {
      throw new Error('caller snapshot must not run');
    },
  };
  try {
    assert.throws(
      () => captureFrozenProvenance({ workspaceRoot, manifestPath, phase: 'wave-forged-cache', snapshot }),
      /capture options|native|authority|unsupported|forbid|reject/i,
    );
    assert.equal(existsSync(manifestPath), false, 'a caller cache cannot publish an admitted digest or row');
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }
});

test('SDS-AC-3 publishes a deterministic deduplicated source closure only after native capture succeeds', async () => {
  const leaf = createOwnedAnalysisLeaf('wave-native-closure');
  const { manifestPath } = leaf;
  let priorFailure;
  try {
    const manifest = leaf.capture('wave-native-closure');
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'only the native closure may publish its manifest');
    const rows = manifest.protectedInput.value.sourceClosureRows;
    const paths = rows.map(row => row.path);
    assert.deepEqual(paths, [...paths].sort(), 'native source closure rows must have deterministic path order');
    assert.equal(new Set(paths).size, paths.length, 'native source closure rows must be deduplicated before publication');
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }
});

test('SDS-AC-4 publishes the deterministic focused regression command and 120-second evidence boundary without nested test-runner flakiness', t => {
  const focusedFiles = [
    'tools/wave3/fair-readmission-closure-v3.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.remediation.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.reparse.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.batch.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.hardening.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.strict.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.ingress.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.wave.test.mjs',
  ];
  const command = `${process.execPath} --test ${focusedFiles.join(' ')}`;

  assert.equal(focusedFiles.length, 9, 'the wave contract extends the existing focused eight-file closure regression');
  assert.equal(focusedFiles.every(file => file.startsWith('tools/wave3/fair-readmission-closure-v3')), true);
  t.diagnostic(`SDS-AC-4 evidence command (must finish <120s): ${command}`);
  t.diagnostic('This contract intentionally does not spawn the full suite from inside node:test; nesting would create duplicate concurrent runs and an unreliable time measurement. Record elapsed wall-clock evidence from the command above in GREEN verification.');
});
