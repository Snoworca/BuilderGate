import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as actorCleanup from './fixture-actor-cleanup.mjs';
const require = createRequire(import.meta.url), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const root = 'C:\\virtual-seed', parent = path.win32.join(root, 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceUrl = new URL('./fair-readmission-closure-v3.internal-core-race.test.mjs', import.meta.url);
function harness() {
  const text = readFileSync(sourceUrl, 'utf8'), ast = ts.createSourceFile(sourceUrl.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['assertFixtureRelativePath', 'readCurrentProtectedFixtureSource', 'addProtectedFixtureSeedRow', 'captureProtectedFixtureSeed', 'protectedCaptureManifestInputs', 'isLinkOrReparsePoint', 'assertOwnedLeaf', 'removeOwnedLeaf'];
  const nodes = names.map(name => { const matches = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name.text === name); assert.equal(matches.length, 1, name); return matches[0].getText(ast); });
  const files = new Map(), rows = new Map(); let serial = 0n, captureCount = 0, lastManifest;
  const state = { failure: null, uncertain: false, conflict: false, drift: false, replacement: false, cleanupError: null };
  const key = p => path.win32.normalize(p), mutations = [];
  const put = (p, bytes, role = 'file') => { files.set(key(p), { bytes: Buffer.from(bytes), role, dev: 1n, ino: ++serial, birthtimeNs: serial + 100n }); };
  for (const p of ['C:\\', root, path.win32.join(root, 'docs'), path.win32.join(root, 'docs/analysis'), parent]) put(p, '', 'directory');
  for (const [kind, relative] of [['source', 'server/source.ts'], ['fixture', 'docs/fixture.json'], ['config_lock', 'server/config.json5'], ['collector', 'tools/wave3/fair-readmission-closure-v3.mjs'], ['support', 'tools/support.mjs']]) { const bytes = Buffer.from(kind + '-sentinel'); put(path.win32.join(root, relative), bytes); rows.set(kind, { kind, path: relative, sha256: hash(bytes) }); }
  const fs = {
    existsSync: p => files.has(key(p)),
    lstatSync(p) { const r = files.get(key(p)); if (!r) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { ...r, isFile: () => r.role === 'file', isDirectory: () => r.role === 'directory', isSymbolicLink: () => false, isReparsePoint: () => false }; },
    readFileSync(p) {
      const r = files.get(key(p)); if (!r) throw Error('unexpected virtual read');
      if (state.replacement && lastManifest && key(p) !== key(lastManifest)) { const old = files.get(key(lastManifest)); put(lastManifest, old.bytes); state.replacement = false; }
      return state.drift && key(p).endsWith('source.ts') ? Buffer.from('drift') : Buffer.from(r.bytes);
    },
    mkdirSync(p) { mutations.push(['mkdir', key(p)]); put(p, '', 'directory'); },
    unlinkSync(p) { mutations.push(['unlink', key(p)]); if (state.cleanupError) throw state.cleanupError; files.delete(key(p)); },
    rmdirSync() { assert.fail('seed capture never deletes its parent'); },
  };
  const collector = {
    createSegmentReparseGuard() { return { assertSafeMany(_paths, options) { assert.equal(options.forceFresh, true); } }; },
    captureFrozenProvenance(options) {
      captureCount++; lastManifest = options.manifestPath; assert.equal(path.win32.resolve(options.workspaceRoot), root); assert.equal(options.phase, 'minimal-native-fixture-protected-input-seed');
      if (state.uncertain || !state.failure) put(lastManifest, '{}');
      if (state.failure) throw state.failure;
      return { protectedInput: { value: { sourceClosureRows: [rows.get('source')], fixtureRows: [rows.get('fixture')], configLockRows: [rows.get('config_lock'), ...(state.conflict ? [{ ...rows.get('source'), sha256: 'f'.repeat(64) }] : [])], collector: rows.get('collector') } } };
    },
  };
  const helperUrl = new URL('./admission-fixture-ownership.mjs', import.meta.url);
  const helperText = readFileSync(helperUrl, 'utf8').replaceAll('import.meta.url', "'file:///C:/virtual-seed/tools/wave3/admission-fixture-ownership.mjs'");
  const helperCode = ts.transpileModule(helperText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', helperCode)(id => {
    if (id === 'node:fs') return fs; if (id === 'node:path') return path.win32; if (id === 'node:url') return { fileURLToPath };
    if (id === 'node:crypto') return { randomUUID: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}` };
    if (id === './fair-readmission-closure-v3.mjs') return collector; if (id === './fixture-actor-cleanup.mjs') return actorCleanup; throw Error('unreviewed helper import ' + id);
  }, module, module.exports);
  // Only named seed functions are executed; dynamic collector import is an inert port.
  const selected = nodes.join('\n').replace('await import(collectorUrl)', 'await loadCollector()');
  const api = new Function('assert', 'path', 'workspaceRoot', 'analysisRoot', 'process', 'randomBytes', 'lstatSync', 'readFileSync', 'existsSync', 'unlinkSync', 'sha256Bytes', 'FIXTURE_SUPPORT_INPUTS', 'loadCollector', 'createOwnedAnalysisLeaf',
    `let protectedFixtureSeedPromise; ${selected}; return {captureProtectedFixtureSeed,protectedCaptureManifestInputs};`)(assert, path.win32, root, parent, { pid: 123 }, () => Buffer.alloc(6), fs.lstatSync, fs.readFileSync, fs.existsSync, fs.unlinkSync, hash, ['tools/support.mjs'], async () => collector, module.exports.createOwnedAnalysisLeaf);
  return { api, state, files, rows, mutations, get captureCount() { return captureCount; }, get lastManifest() { return lastManifest; } };
}
test('AC5 actual seed preserves sorted frozen three-kind collector and support bytes and shares cached promise', async () => {
  const h = harness(), a = h.api.protectedCaptureManifestInputs(), b = h.api.protectedCaptureManifestInputs(); assert.equal(a, b);
  const seed = await a; assert.equal(h.captureCount, 1); assert.ok(Object.isFrozen(seed)); assert.equal(seed.length, 5);
  assert.deepEqual(seed.map(r => r.path), [...seed.map(r => r.path)].sort());
  for (const row of seed) { assert.ok(Object.isFrozen(row)); assert.ok(Buffer.isBuffer(row.bytes)); assert.equal(hash(row.bytes), row.sha256); }
  assert.equal(h.files.has(path.win32.normalize(h.lastManifest)), false); assert.ok(h.files.has(parent));
});
for (const reason of ['conflict', 'drift']) test(`AC5 actual seed rejects ${reason} without changing input contract`, async () => { const h = harness(); h.state[reason] = true; await assert.rejects(h.api.captureProtectedFixtureSeed(), /SHA-256/); });
test('AC5 actual seed failed capture never grants deletion authority and current failed promise can retry', async () => {
  const h = harness(), error = Error('failed capture'); h.state.failure = error; h.state.uncertain = true;
  await assert.rejects(h.api.protectedCaptureManifestInputs(), reported => {
    assert.ok(reported instanceof AggregateError);
    assert.ok(reported.errors.includes(error), 'preserve original capture error identity');
    assert.ok(reported.errors.some(item => item !== error && /unconfirmed|ownership|unowned/i.test(String(item))), 'also report unconfirmed leaf ownership');
    return true;
  });
  assert.ok(h.files.has(path.win32.normalize(h.lastManifest)), 'unconfirmed capture leaf must survive');
  assert.equal(h.mutations.some(([op]) => op === 'unlink'), false);
  h.state.failure = null; h.state.uncertain = false; const seed = await h.api.protectedCaptureManifestInputs(); assert.equal(seed.length, 5); assert.equal(h.captureCount, 2);
});
test('AC5 actual seed preserves same-byte replacement after capture', async () => {
  const h = harness(); h.state.replacement = true; await assert.rejects(h.api.captureProtectedFixtureSeed());
  assert.ok(h.files.has(path.win32.normalize(h.lastManifest))); assert.equal(h.mutations.some(([op]) => op === 'unlink'), false);
});
test('AC5 actual seed preserves primary and cleanup errors together', async () => {
  const h = harness(); h.state.drift = true; const cleanup = Error('cleanup'); h.state.cleanupError = cleanup;
  await assert.rejects(h.api.captureProtectedFixtureSeed(), error => error instanceof AggregateError && error.errors.includes(cleanup) && error.errors.some(e => e !== cleanup && /SHA-256/.test(String(e))));
});

test('AC5 actual cached seed retries after the current rejected promise without changing successful cache sharing', async () => {
  const h = harness(), failure = Error('before publication'); h.state.failure = failure;
  const first = h.api.protectedCaptureManifestInputs(); assert.equal(first, h.api.protectedCaptureManifestInputs());
  await assert.rejects(first, error => error === failure); h.state.failure = null;
  const retry = h.api.protectedCaptureManifestInputs(); assert.notEqual(retry, first);
  assert.equal(retry, h.api.protectedCaptureManifestInputs()); assert.equal((await retry).length, 5); assert.equal(h.captureCount, 2);
});
