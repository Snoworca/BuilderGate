import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import test from 'node:test';
import { observeProcessUntilClose } from './admission-process-observer.mjs';
import { decodeAdmissionTranscript, evaluateAdmissionEvents } from './admission-event-validation.mjs';

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

test('SDS-AC-3 runs the fixed nonrecursive closure gate with boundary and admission suites under 118 seconds', async t => {
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

  const result = await observeProcessUntilClose(process.execPath, ['--test', '--test-reporter=./tools/wave3/admission-event-reporter.mjs', ...fixedClosureTests], {
    cwd: workspaceRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))),
    deadlineMs: FIXED_GATE_LIMIT_MS,
    onDeadline: () => t.diagnostic('SDS-AC-3 exceeded 118 seconds; awaiting natural child and output close'),
  });
  t.diagnostic(`SDS-AC-3 combined closure gate elapsed_ms=${result.elapsedMs} code=${result.code} signal=${result.signal}`);

  const failures = [];
  if (result.spawnError !== null) failures.push(`launch failure: ${result.spawnError}`);
  for (const error of result.observationErrors) failures.push(`observation failure: ${error}`);
  if (result.signal !== null) failures.push(`child received signal: ${result.signal}`);
  if (result.code !== 0) failures.push(`child exited ${result.code}`);
  if (result.deadlineExceeded || !(result.elapsedMs < FIXED_GATE_LIMIT_MS)) {
    failures.push(`118-second contract exceeded: ${result.elapsedMs}ms`);
  }
  try {
    const records = decodeAdmissionTranscript(result.stdout);
    const verdict = evaluateAdmissionEvents(records, fixedClosureTests.map(file => path.resolve(workspaceRoot, file)));
    if (!verdict.accepted) failures.push(...verdict.reasons);
  } catch (error) {
    failures.push(`transcript decoding failed: ${error}`);
  }
  assert.equal(failures.length, 0, `combined closure gate failed:\n${failures.join('\n')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
