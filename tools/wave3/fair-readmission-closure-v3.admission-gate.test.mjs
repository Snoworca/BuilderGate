import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import test from 'node:test';

const self = 'fair-readmission-closure-v3.admission-gate.test.mjs';
const fixedClosureTests = [
  'tools/wave3/fair-readmission-closure-v3.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.remediation.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.reparse.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.batch.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.hardening.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.strict.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.ingress.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.wave.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.boundary.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.admission.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs',
];
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, '..', '..');

test('SDS-AC-4 runs the fixed nonrecursive closure gate with boundary and admission suites under 120 seconds', t => {
  const discovered = readdirSync(testDirectory, { encoding: 'utf8' })
    .filter(name => /^fair-readmission-closure-v3(?:\.[a-z-]+)?\.test\.mjs$/.test(name))
    .filter(name => name !== self)
    .map(name => `tools/wave3/${name}`)
    .sort();

  assert.equal(new Set(fixedClosureTests).size, fixedClosureTests.length, 'the fixed gate must not duplicate a closure suite');
  assert.equal(fixedClosureTests.includes(`tools/wave3/${self}`), false, 'the gate must exclude only itself to prevent recursion');
  assert.equal(fixedClosureTests.includes('tools/wave3/fair-readmission-closure-v3.boundary.test.mjs'), true);
  assert.equal(fixedClosureTests.includes('tools/wave3/fair-readmission-closure-v3.admission.test.mjs'), true);
  assert.deepEqual([...fixedClosureTests].sort(), discovered, 'every closure suite other than this combined gate must be covered');

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--test', ...fixedClosureTests], {
    cwd: workspaceRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))),
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  const elapsedMs = Date.now() - startedAt;
  t.diagnostic(`SDS-AC-4 combined closure gate elapsed_ms=${elapsedMs}`);

  assert.equal(result.error, undefined, `combined closure gate failed to launch: ${result.error?.message ?? ''}`);
  assert.equal(result.signal, null, `combined closure gate timed out or was signaled: ${result.signal ?? ''}`);
  assert.equal(result.status, 0, `combined closure gate exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(elapsedMs < 120_000, `combined closure gate exceeded the 120-second contract: ${elapsedMs}ms`);
});
