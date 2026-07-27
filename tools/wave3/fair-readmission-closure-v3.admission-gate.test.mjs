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
  'tools/wave3/fair-readmission-closure-v3.trust.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.trust-race.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.seal.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.lexical.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs',
];
const requiredLexicalSuites = [
  'tools/wave3/fair-readmission-closure-v3.lexical.test.mjs',
  'tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs',
];
const FIXED_GATE_LIMIT_MS = 118_000;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, '..', '..');

test('SDS-AC-3 fixes the named admission gate limit below 118 seconds', () => {
  assert.equal(FIXED_GATE_LIMIT_MS, 118_000, 'the fixed admission gate limit must stay below 118 seconds');
});

test('SDS-AC-3 runs the fixed nonrecursive closure gate with boundary and admission suites under 118 seconds', t => {
  const discovered = readdirSync(testDirectory, { encoding: 'utf8' })
    .filter(name => /^fair-readmission-closure-v3(?:\.[a-z-]+)?\.test\.mjs$/.test(name))
    .filter(name => name !== self)
    .map(name => `tools/wave3/${name}`)
    .sort();

  assert.equal(new Set(fixedClosureTests).size, fixedClosureTests.length, 'the fixed gate must not duplicate a closure suite');
  assert.equal(fixedClosureTests.includes(`tools/wave3/${self}`), false, 'the gate must exclude only itself to prevent recursion');
  assert.equal(fixedClosureTests.includes('tools/wave3/fair-readmission-closure-v3.boundary.test.mjs'), true);
  assert.equal(fixedClosureTests.includes('tools/wave3/fair-readmission-closure-v3.admission.test.mjs'), true);
  for (const suite of requiredLexicalSuites) {
    assert.equal(fixedClosureTests.includes(suite), true, `the fixed combined gate must execute ${suite}`);
  }
  assert.deepEqual([...fixedClosureTests].sort(), discovered, 'every closure suite other than this combined gate must be covered');

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--test', ...fixedClosureTests], {
    cwd: workspaceRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))),
    encoding: 'utf8',
    shell: false,
    timeout: FIXED_GATE_LIMIT_MS,
    windowsHide: true,
  });
  const elapsedMs = Date.now() - startedAt;
  t.diagnostic(`SDS-AC-3 combined closure gate elapsed_ms=${elapsedMs}`);

  assert.equal(result.error, undefined, `combined closure gate failed to launch: ${result.error?.message ?? ''}`);
  assert.equal(result.signal, null, `combined closure gate timed out or was signaled: ${result.signal ?? ''}`);
  assert.equal(result.status, 0, `combined closure gate exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(elapsedMs < FIXED_GATE_LIMIT_MS, `combined closure gate exceeded the 118-second contract: ${elapsedMs}ms`);
});
