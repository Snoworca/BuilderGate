import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { decodeAdmissionTranscript, evaluateAdmissionEvents } from './admission-event-validation.mjs';
const require = createRequire(import.meta.url), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const source = readFileSync(new URL('./fair-readmission-closure-v3.admission-gate.test.mjs', import.meta.url), 'utf8');
const ast = ts.createSourceFile('gate.mjs', source, ts.ScriptTarget.Latest, true);
const sds = readFileSync(new URL('../../docs/spec/steps/2026-09-09.admission-lifecycle-successor/design.md', import.meta.url), 'utf8');
const expectedFiles = sds.split(/\r?\n/).filter(line => /^tools\/wave3\/fair-readmission-closure-v3.*\.test\.mjs$/.test(line));
assert.equal(expectedFiles.length, 20);
const calls = [];
function visit(n) { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'test') calls.push(n); ts.forEachChild(n, visit); }
visit(ast);
const targets = calls.filter(n => n.arguments[0]?.text?.includes('runs the fixed nonrecursive closure gate'));
assert.equal(targets.length, 1);
const fixedDeclarations = ast.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .filter(declaration => declaration.name.getText(ast) === 'fixedClosureTests');
assert.equal(fixedDeclarations.length, 1);
assert.ok(ts.isArrayLiteralExpression(fixedDeclarations[0].initializer));
const actualFixedFiles = fixedDeclarations[0].initializer.elements.map(element => {
  assert.ok(ts.isStringLiteral(element), 'fixed argv entries must remain explicit literals');
  return element.text;
});
const root = path.resolve('C:/virtual-canonical');
const entries = expectedFiles.map(file => path.resolve(root, file));
const counts = n => ({ tests: n, suites: 0, passed: n, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: n });
const version = 'admission-events/v1';
function validRows() {
  const rows = entries.flatMap(file => [
    { schemaVersion: version, type: 'pass', file: '/helper-definition.mjs', name: 'leaf', nesting: 0, details: { type: 'test', failureType: null }, skip: { present: false, value: null }, todo: { present: false, value: null } },
    { schemaVersion: version, type: 'summary', file, success: true, counts: counts(1) },
  ]);
  rows.push({ schemaVersion: version, type: 'summary', file: null, success: true, counts: counts(20) });
  return [...rows, { schemaVersion: version, type: 'end', eventCount: rows.length }];
}
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const observed = extra => ({ code: 0, signal: null, elapsedMs: 117999, deadlineExceeded: false, stdout: encode(validRows()), stderr: '', spawnError: null, observationErrors: [], ...extra });
function harness({ result = observed(), deferred = false, discovered = expectedFiles, fixed = actualFixedFiles } = {}) {
  const invocations = [], diagnostics = [];
  const env = { NODE_TEST_CONTEXT: 'child', NODE_TEST_INTERNAL: 'remove', NODE_OPTIONS: '--require=/reviewed/guard.cjs', KEEP: 'value' };
  const originalEnv = { ...env };
  let resolve;
  const waiting = new Promise(yes => { resolve = yes; });
  const ports = { assert, path, process: { execPath: 'C:/fixed/node.exe', env }, workspaceRoot: root,
    testDirectory: path.join(root, 'tools/wave3'), self: 'fair-readmission-closure-v3.admission-gate.test.mjs',
    fixedClosureTests: fixed, requiredLexicalSuites: expectedFiles.filter(f=>/\.lexical(?:-race)?\.test/.test(f)), FIXED_GATE_LIMIT_MS: 118000,
    readdirSync: () => [...discovered.map(f=>path.basename(f)), 'fair-readmission-closure-v3.admission-gate.test.mjs'],
    spawnSync() { assert.fail('legacy spawnSync timeout path must not execute'); },
    observeProcessUntilClose(executable, args, options) { invocations.push({ executable, args, options }); return deferred ? waiting : Promise.resolve(result); },
    decodeAdmissionTranscript, evaluateAdmissionEvents,
  };
  const callback = new Function(...Object.keys(ports), `return (${targets[0].arguments.at(-1).getText(ast)});`)(...Object.values(ports));
  return { invocations, diagnostics, env, originalEnv, resolve, run: () => Promise.resolve().then(() => callback({ diagnostic: value => diagnostics.push(String(value)) })) };
}

test('AC3/6 actual gate delegates exact20 reporter argv env and complete transcript to existing APIs', async () => {
  assert.deepEqual(actualFixedFiles, expectedFiles, 'actual source list and order must match the independently read SDS');
  const h = harness(); await h.run();
  assert.equal(h.invocations.length, 1);
  const call = h.invocations[0];
  assert.equal(call.executable, 'C:/fixed/node.exe');
  assert.deepEqual(call.args, ['--test', '--test-reporter=./tools/wave3/admission-event-reporter.mjs', ...expectedFiles]);
  assert.equal(call.options.cwd, root); assert.equal(call.options.deadlineMs, 118000);
  assert.deepEqual(call.options.env, { NODE_OPTIONS: '--require=/reviewed/guard.cjs', KEEP: 'value' });
  assert.deepEqual(h.env, h.originalEnv);
  assert.equal('timeout' in call.options, false); assert.equal('signal' in call.options, false);
});

test('AC3 actual gate rejects missing extra and duplicate discovery before child observation', async () => {
  for (const config of [{ discovered: expectedFiles.slice(1) }, { discovered: [...expectedFiles, 'tools/wave3/fair-readmission-closure-v3.unreviewed.test.mjs'] }, { fixed: [...expectedFiles, expectedFiles[0]] }]) {
    const h = harness(config); await assert.rejects(h.run(), assert.AssertionError);
    assert.equal(h.invocations.length, 0);
  }
});

test('AC4 actual gate waits for close after deadline notification and rejects late exit0', async () => {
  const h = harness({ deferred: true }); let finished = false;
  const done = h.run().finally(() => { finished = true; });
  const checked = assert.rejects(done);
  let priorFailure;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.invocations.length, 1); assert.equal(finished, false);
    h.invocations[0].options.onDeadline();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  } catch (error) { priorFailure = { error }; }
  finally {
    h.resolve(observed({ elapsedMs: 118001, deadlineExceeded: true }));
    try { await checked; }
    catch (error) {
      if (priorFailure && priorFailure.error !== error) throw new AggregateError([priorFailure.error, error], 'Deferred gate test failures');
      throw error;
    }
  }
  if (priorFailure) throw priorFailure.error;
});

test('AC4 actual gate rejects every process failure and strict boundary independently', async () => {
  for (const extra of [{ elapsedMs: 118000 }, { elapsedMs: 118001 }, { deadlineExceeded: true }, { code: 1 }, { signal: 'SIGTERM' }, { spawnError: Error('spawn-specific') }, { observationErrors: [Error('stream-specific')] }]) {
    const h = harness({ result: observed(extra) }); await assert.rejects(h.run()); assert.equal(h.invocations.length, 1);
  }
});

test('AC6 actual gate uses real decoder to reject incomplete or malformed stdout', async () => {
  for (const stdout of ['', '{}', '{broken\n', '\n', '\uFEFF{}\n']) {
    const h = harness({ result: observed({ stdout }) }); await assert.rejects(h.run()); assert.equal(h.invocations.length, 1);
  }
});

test('AC6 actual gate rejects semantic transcript failures even with exit0', async () => {
  const base = validRows();
  const variants = [base.slice(0,-1), [...base, { schemaVersion: version, type: 'output', stream: 'stdout', text: 'late' }],
    base.map(row => row.type === 'summary' && row.file === entries[0] ? { ...row, counts: counts(0) } : row),
    base.map(row => row.type === 'summary' && row.file === entries[0] ? { ...row, file: '/foreign.mjs' } : row),
    base.map(row => row.type === 'summary' ? { ...row, success: false } : row),
    base.filter(row => !(row.type === 'summary' && row.file === entries[0])),
    [...base.slice(0,-1), base.find(row => row.type === 'summary' && row.file === entries[0]), { schemaVersion: version, type: 'end', eventCount: base.length }],
    base.map(row => row.type === 'summary' && row.file === null ? { ...row, counts: counts(21) } : row),
    base.map(row => row.type === 'pass' ? { ...row, skip: { present: true, value: false } } : row),
    base.map(row => row.type === 'pass' ? { ...row, type: 'fail', details: { type: 'test', failureType: 'cancelledByParent' } } : row),
    base.map(row => row.type === 'pass' ? { ...row, todo: { present: true, value: 'not run' } } : row),
    [{ schemaVersion: version, type: 'output', stream: 'stdout', text: encode(base) }, { schemaVersion: version, type: 'end', eventCount: 1 }]];
  for (const rows of variants) { const h = harness({ result: observed({ stdout: encode(rows) }) }); await assert.rejects(h.run()); assert.equal(h.invocations.length, 1); }
});

test('AC4/6 actual gate preserves simultaneous process and transcript diagnostics', async () => {
  const h = harness({ result: observed({ code: 1, stderr: 'stderr-specific-marker', stdout: '{malformed-specific-marker\n', observationErrors: [Error('stream-specific-marker')] }) });
  let failure; try { await h.run(); } catch (error) { failure = error; }
  assert.equal(h.invocations.length, 1); assert.ok(failure);
  const output = String(failure) + h.diagnostics.join('\n');
  for (const marker of ['stderr-specific-marker', 'malformed-specific-marker', 'stream-specific-marker']) assert.ok(output.includes(marker), marker);
});
