import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { probeWindowsReparsePoints } from './fair-readmission-closure-v3.mjs';

// PERF-BGSTAB-011: native program semantics only, outside the fixed closure gate.
const hash = text => createHash('sha256').update(text).digest('hex');
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const evidenceRoot = fs.mkdtempSync(path.join(tmpdir(), 'buildergate-native-program-evidence-'));
const observations = [];
function extract(paths) {
  let invocation;
  probeWindowsReparsePoints({ paths, spawnSync(executable, argv, options) {
    assert.equal(invocation, undefined);
    invocation = { executable, argv, options };
    const values = Object.values(options.env);
    assert.equal(values.length, 1);
    const json = Buffer.from(values[0], 'base64').toString('utf8');
    return { status: 0, signal: null, stdout: `FRRPB1:${JSON.parse(json).length}:${hash(json)}\n`, stderr: '' };
  } });
  assert.ok(invocation);
  assert.equal(path.win32.normalize(invocation.executable), path.win32.normalize(powershell));
  assert.equal(invocation.options.timeout, 10000);
  assert.equal(invocation.options.shell, false);
  return invocation;
}
function invoke(label, invocation, envOverride) {
  const options = envOverride === undefined ? invocation.options : { ...invocation.options, env: envOverride };
  const start = performance.now();
  const result = spawnSync(invocation.executable, invocation.argv, options);
  const encoded = invocation.argv[invocation.argv.indexOf('-EncodedCommand') + 1];
  observations.push({ label, durationMs: performance.now() - start, status: result.status, signal: result.signal,
    errorCode: result.error?.code ?? null, programSHA256: hash(Buffer.from(encoded, 'base64')),
    inputSHA256: hash(JSON.stringify(options.env)), stdout: result.stdout, stderr: result.stderr });
  fs.writeFileSync(path.join(evidenceRoot, 'observations.json'), JSON.stringify({ scope: 'Native semantic baseline; extraction callback is not admission evidence', nodeVersion: process.version, observations }, null, 2), 'utf8');
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return result;
}
function owned(run) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'buildergate-native-program-fixture-'));
  try { run(root); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('buildergate-native-program-fixture-'));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function successful(label, paths) {
  const invocation = extract(paths), result = invoke(label, invocation);
  const json = Buffer.from(Object.values(invocation.options.env)[0], 'base64').toString('utf8');
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout, `FRRPB1:${paths.length}:${hash(json)}\n`);
}
function rejected(label, invocation, env) {
  const result = invoke(label, invocation, env);
  assert.notEqual(result.status, 0); assert.ok(!String(result.stdout).includes('FRRPB1:'));
}

test('native reparse program accepts literal Unicode spaces quotes and special path characters', () => owned(root => {
  const paths = ["plain.txt", "한글 空白 'quote' [bracket] $dollar &amp ;semi.txt"].map(name => {
    const file = path.join(root, name); fs.writeFileSync(file, 'owned sentinel', 'utf8'); return file;
  });
  successful('plain', [paths[0]]); successful('unicode-special', [paths[1]]); successful('multiple', paths);
}));

test('native reparse program rejects missing paths and actual owned junctions', () => owned(root => {
  rejected('missing', extract([path.join(root, 'missing')]));
  const target = path.join(root, 'target'), junction = path.join(root, 'junction'); fs.mkdirSync(target);
  fs.symlinkSync(target, junction, 'junction');
  try { rejected('junction', extract([junction])); }
  finally { assert.equal(fs.lstatSync(junction).isSymbolicLink(), true); fs.unlinkSync(junction); }
}));

test('native reparse program rejects malformed Base64 JSON and nonarray or nonstring inputs', () => owned(root => {
  const file = path.join(root, 'plain'); fs.writeFileSync(file, 'sentinel', 'utf8');
  const invocation = extract([file]), key = Object.keys(invocation.options.env)[0];
  for (const [label, encoded] of [
    ['missing-input', ''], ['invalid-base64', '%%%'],
    ...['{', '{}', 'null', '123', '"string"', '[null]', '[1]', '[{}]', '[""]'].map(json => [`invalid-json-shape:${json}`, Buffer.from(json, 'utf8').toString('base64')]),
  ]) rejected(label, invocation, { [key]: encoded });
}));

test.after(() => { console.log(`native program evidence: ${evidenceRoot}`); });
