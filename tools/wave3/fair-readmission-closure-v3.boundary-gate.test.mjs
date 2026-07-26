import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import test from 'node:test';

const focusedClosureTests = [
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
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('SDS-AC-4 runs exactly the fixed nonrecursive nine-file closure gate under a 120-second external timeout', t => {
  assert.equal(focusedClosureTests.length, 9);
  assert.equal(new Set(focusedClosureTests).size, 9);
  assert.equal(
    focusedClosureTests.includes('tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs'),
    false,
    'the gate must not recursively invoke itself',
  );
  assert.equal(
    focusedClosureTests.includes('tools/wave3/fair-readmission-closure-v3.boundary.test.mjs'),
    false,
    'the fixed prior gate intentionally excludes the current boundary RED suite',
  );

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--test', ...focusedClosureTests], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  const elapsedMs = Date.now() - startedAt;
  t.diagnostic(`SDS-AC-4 fixed nine-file gate elapsed_ms=${elapsedMs}`);

  assert.equal(result.error, undefined, `focused closure gate failed to launch: ${result.error?.message ?? ''}`);
  assert.equal(result.signal, null, `focused closure gate timed out or was signaled: ${result.signal ?? ''}`);
  assert.equal(result.status, 0, `focused closure gate exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(elapsedMs < 120_000, `focused closure gate exceeded the 120-second contract: ${elapsedMs}ms`);
});
