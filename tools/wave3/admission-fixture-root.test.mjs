import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as actorCleanup from './fixture-actor-cleanup.mjs';
const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');
const root = 'C:\\virtual-canonical';
const parent = path.win32.join(root, 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
const key = p => path.win32.normalize(p);
function harness() {
  const filename = new URL('./admission-fixture-ownership.mjs', import.meta.url);
  const text = readFileSync(filename, 'utf8'); // Missing helper is RED before any virtual mutation.
  const map = new Map(), calls = []; let serial = 10n, nonce = 0;
  const state = { captureError: null, uncertain: false, deleteError: null, nativeError: null, invalidIdentity: false };
  const put = (p, role = 'file') => { const value = { role, dev: 9007199254740993n, ino: ++serial, birthtimeNs: 10000000000000001n, link: false }; map.set(key(p), value); return value; };
  for (const p of ['C:\\', root, path.win32.join(root, 'docs'), path.win32.join(root, 'docs/analysis')]) put(p, 'directory');
  const fs = {
    existsSync: p => map.has(key(p)),
    lstatSync(p) {
      calls.push(['stat', key(p)]); const row = map.get(key(p)); if (!row) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return { ...row, ...(state.invalidIdentity ? { ino: Number(row.ino) } : {}), isFile: () => row.role === 'file', isDirectory: () => row.role === 'directory', isSymbolicLink: () => row.link, isReparsePoint: () => row.link };
    },
    mkdirSync(p) { calls.push(['mkdir', key(p)]); if (map.has(key(p))) throw Object.assign(Error('exists'), { code: 'EEXIST' }); put(p, 'directory'); },
    unlinkSync(p) { calls.push(['unlink', key(p)]); if (state.deleteError) throw state.deleteError; map.delete(key(p)); },
    rmdirSync(p) { calls.push(['rmdir', key(p)]); if ([...map.keys()].some(x => x.startsWith(key(p) + '\\'))) throw Object.assign(Error('not empty'), { code: 'ENOTEMPTY' }); if (state.deleteError) throw state.deleteError; map.delete(key(p)); },
    rmSync() { assert.fail('recursive cleanup is forbidden'); },
    readdirSync: p => [...map.keys()].filter(x => path.win32.dirname(x) === key(p)).map(x => path.win32.basename(x)),
  };
  const collector = {
    createSegmentReparseGuard(...args) {
      assert.equal(args.length, 0, 'helper must reuse the default native guard without weak injected authority');
      return { assertSafeMany(paths, options) { calls.push(['native', paths.map(key)]); assert.equal(options.forceFresh, true); if (state.nativeError) throw state.nativeError; for (const p of paths) if (map.get(key(p))?.link) throw Error('reparse'); } };
    },
    captureFrozenProvenance(options) {
      calls.push(['capture', options]); assert.deepEqual(Object.keys(options).sort(), ['manifestPath', 'phase', 'workspaceRoot']);
      assert.equal(key(options.workspaceRoot), root); if (state.uncertain) put(options.manifestPath);
      if (state.captureError) throw state.captureError; put(options.manifestPath); return { marker: 'actual-capture-result' };
    },
  };
  const transformed = ts.transform(ts.createSourceFile(filename.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), [context => node => {
    function visit(n) { if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url') return ts.factory.createStringLiteral('file:///C:/virtual-canonical/tools/wave3/admission-fixture-ownership.mjs'); return ts.visitEachChild(n, visit, context); }
    return ts.visitNode(node, visit);
  }]);
  const compiled = ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === 'node:fs') return fs;
    if (id === 'node:path') return path.win32;
    if (id === 'node:url') return { fileURLToPath };
    if (id === 'node:crypto') return { randomUUID: () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, randomBytes: () => Buffer.alloc(16, ++nonce) };
    if (id === './fair-readmission-closure-v3.mjs') return collector;
    if (id === './fixture-actor-cleanup.mjs') return actorCleanup;
    throw Error('unreviewed helper dependency ' + id);
  }, module, module.exports);
  return { create: module.exports.createOwnedAnalysisLeaf, map, calls, put, state };
}
const writes = h => h.calls.filter(x => ['mkdir', 'unlink', 'rmdir', 'capture'].includes(x[0]));

test('AC5 leaf allocation is immutable module-relative and rejects invalid prefixes without IO', () => {
  const h = harness();
  for (const prefix of ['', '../outside', 'a/b', 'a\\b', 'C:drive', '.', 'space prefix']) assert.throws(() => h.create(prefix));
  assert.equal(h.calls.length, 0);
  const leaf = h.create('valid-prefix'); assert.ok(Object.isFrozen(leaf)); assert.equal(key(leaf.workspaceRoot), root); assert.equal(path.win32.dirname(leaf.manifestPath), parent); assert.deepEqual(writes(h), []);
});
test('AC5 capture creates guarded parent once and cleans only owned nonce with exact BigInt identity', () => {
  const h = harness(), a = h.create('a'), b = h.create('b');
  assert.deepEqual(a.capture('phase-a'), { marker: 'actual-capture-result' }); b.capture('phase-b');
  assert.ok(h.calls.findIndex(x => x[0] === 'native') < h.calls.findIndex(x => x[0] === 'mkdir'));
  a.cleanup(); assert.equal(h.map.has(key(a.manifestPath)), false); assert.equal(h.map.has(key(b.manifestPath)), true); assert.equal(h.map.has(parent), true);
  assert.throws(() => a.capture('again')); assert.throws(() => a.createDirectory());
  h.put(a.manifestPath); const before = writes(h).length; a.cleanup(); assert.equal(writes(h).length, before); assert.equal(h.map.has(key(a.manifestPath)), true);
});
test('AC5 collision and uncertain failed capture preserve leaves and cannot reacquire', () => {
  const h = harness(), collision = h.create('collision'); h.put(collision.manifestPath);
  assert.throws(() => collision.capture('phase')); assert.throws(() => collision.createDirectory());
  assert.throws(() => collision.cleanup()); assert.equal(h.map.has(key(collision.manifestPath)), true);
  const uncertain = h.create('uncertain'); h.state.captureError = Error('capture failed'); h.state.uncertain = true;
  assert.throws(() => uncertain.capture('phase'), error => error === h.state.captureError); assert.throws(() => uncertain.cleanup()); assert.equal(h.map.has(key(uncertain.manifestPath)), true);
});
for (const mutation of ['identity', 'role', 'parent-reparse', 'leaf-reparse', 'invalid-identity']) test(`AC5 cleanup preserves ${mutation} replacement`, () => {
  const h = harness(), leaf = h.create('change'); leaf.capture('phase');
  if (mutation === 'identity') h.map.get(key(leaf.manifestPath)).ino += 1n;
  if (mutation === 'role') h.map.get(key(leaf.manifestPath)).role = 'directory';
  if (mutation === 'parent-reparse') h.map.get(parent).link = true;
  if (mutation === 'leaf-reparse') h.map.get(key(leaf.manifestPath)).link = true;
  if (mutation === 'invalid-identity') h.state.invalidIdentity = true;
  const before = writes(h).length; assert.throws(() => leaf.cleanup()); assert.equal(writes(h).length, before); assert.ok(h.map.has(key(leaf.manifestPath)));
});
test('AC5 directory role permits only empty owned directory cleanup and retains shared parent', () => {
  const h = harness(), leaf = h.create('directory'); leaf.createDirectory(); h.put(path.win32.join(leaf.manifestPath, 'sibling'));
  assert.throws(() => leaf.cleanup()); assert.ok(h.map.has(key(leaf.manifestPath)));
  h.map.delete(key(path.win32.join(leaf.manifestPath, 'sibling'))); leaf.cleanup(); assert.ok(h.map.has(parent));
});
test('AC5 cleanup preserves primary and native/deletion failures including undefined and identity deduplication', () => {
  const h = harness(), leaf = h.create('errors'); leaf.capture('phase'); const failure = Error('delete'); h.state.deleteError = failure;
  assert.throws(() => leaf.cleanup({ error: undefined }), error => error instanceof AggregateError && error.errors.includes(undefined) && error.errors.includes(failure));
  assert.throws(() => leaf.cleanup({ error: failure }), error => error === failure);
  h.state.deleteError = null; leaf.cleanup();
  let caught = false; try { leaf.cleanup({ error: undefined }); } catch (error) { caught = true; assert.equal(error, undefined); } assert.equal(caught, true);
});
test('AC5 native validation rejection is before creation and absence cleanup retires capability', () => {
  const h = harness(), leaf = h.create('native'); h.state.nativeError = Error('native');
  assert.throws(() => leaf.capture('phase')); assert.deepEqual(writes(h), []);
  h.state.nativeError = null; leaf.cleanup(); h.put(leaf.manifestPath); leaf.cleanup(); assert.ok(h.map.has(key(leaf.manifestPath))); assert.throws(() => leaf.capture('again'));
});

test('AC5 adjacent BigInt identities above 2^53 cannot collapse into the same cleanup owner', () => {
  const h = harness(), leaf = h.create('precision');
  // These adjacent values round to the same Number; exact BigInt comparison is required.
  leaf.capture('phase');
  const row = h.map.get(key(leaf.manifestPath));
  // dev is already 2^53+1 in the recorded sample; its successor rounds differently,
  // whereas the predecessor and 2^53+1 collide when coerced to Number.
  assert.equal(row.dev, 9007199254740993n);
  row.dev = 9007199254740992n;
  const before = writes(h).length; assert.throws(() => leaf.cleanup());
  assert.equal(writes(h).length, before); assert.ok(h.map.has(key(leaf.manifestPath)));
});

for (const target of [root, path.win32.join(root, 'docs'), path.win32.join(root, 'docs/analysis')]) {
  for (const role of ['file', 'reparse']) test(`AC5 ${target} ${role} is rejected before mutation`, () => {
    const h = harness(), leaf = h.create('boundary'); const row = h.map.get(key(target));
    if (role === 'file') row.role = 'file'; else row.link = true;
    assert.throws(() => leaf.createDirectory()); assert.deepEqual(writes(h), []);
  });
}
test('AC5 missing checkout root cannot be created as a side effect of nonce acquisition', () => {
  const h = harness(), leaf = h.create('missing-root'); h.map.delete(root);
  assert.throws(() => leaf.capture('phase')); assert.deepEqual(writes(h), []);
});
