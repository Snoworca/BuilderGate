import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as actorCleanup from './fixture-actor-cleanup.mjs';
const require = createRequire(import.meta.url), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const root = 'C:\\virtual-canonical', parent = path.win32.join(root, 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
function load(name) {
  const url = new URL('./fair-readmission-closure-v3.' + name + '.test.mjs', import.meta.url);
  const text = readFileSync(url, 'utf8'), ast = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const callbacks = new Map(), mutations = [], present = new Set(), identities = new Map(), nativeChecks = [], loadedModules = [];
  let identity = 9007199254740992n, nonce = 0;
  const key = p => path.win32.normalize(p);
  const put = (p, role) => { present.add(key(p)); identities.set(key(p), { dev: 1n, ino: ++identity, birthtimeNs: 10000000000000001n, role }); };
  for (const p of ['C:\\', root, path.win32.join(root, 'docs'), path.win32.join(root, 'docs/analysis')]) put(p, 'directory');
  const fs = {
    existsSync: p => present.has(key(p)),
    lstatSync(p) { const row = identities.get(key(p)); if (!row) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { ...row, isFile: () => row.role === 'file', isDirectory: () => row.role === 'directory', isSymbolicLink: () => false, isReparsePoint: () => false }; },
    mkdirSync(p) { mutations.push(['mkdir', key(p)]); if (present.has(key(p))) throw Object.assign(Error('exists'), { code: 'EEXIST' }); put(p, 'directory'); },
    writeFileSync(p, data, options) { assert.equal(options.flag, 'wx'); assert.equal(options.encoding, 'utf8'); if (present.has(key(p))) throw Object.assign(Error('exists'), { code: 'EEXIST' }); mutations.push(['write', key(p), data]); put(p, 'file'); identities.get(key(p)).bytes = Buffer.from(data, options.encoding); },
    rmSync(p) { mutations.push(['rm', key(p)]); present.delete(key(p)); identities.delete(key(p)); },
    rmdirSync(p) { mutations.push(['rmdir', key(p)]); assert.ok(![...present].some(x => path.win32.dirname(x) === key(p))); present.delete(key(p)); identities.delete(key(p)); },
    unlinkSync(p) { mutations.push(['unlink', key(p)]); present.delete(key(p)); identities.delete(key(p)); },
    readdirSync: p => [...present].filter(x => path.win32.dirname(x) === key(p)),
    readFileSync: p => {
      assert.equal(new URL(p).protocol, 'file:');
      return readFileSync(new URL('./' + path.win32.basename(fileURLToPath(p)), import.meta.url), 'utf8');
    },
  };
  const collector = {
    createSegmentReparseGuard(...args) { assert.equal(args.length, 0); return { assertSafeMany(paths, options) { assert.equal(options.forceFresh, true); nativeChecks.push(paths.map(key)); } }; },
    captureFrozenProvenance(options) {
      if (Object.keys(options).some(k => !['workspaceRoot', 'manifestPath', 'phase'].includes(k))) throw Error('unsupported capture options native authority');
      assert.equal(key(options.workspaceRoot), root);
      if (identities.get(key(options.manifestPath))?.role === 'directory') throw Error('directory role rejected');
      throw Error('normal capture fixture not supplied in this directory-role control');
    },
  };
  const cache = new Map();
  function executeModule(moduleUrl, moduleAst) {
  const transformed = ts.transform(moduleAst, [context => node => {
    function visit(n) {
      if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url') return ts.factory.createStringLiteral(`file:///C:/virtual-canonical/tools/wave3/${path.basename(moduleUrl.pathname)}`);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return ts.factory.createCallExpression(ts.factory.createIdentifier('loadModulePort'), undefined, n.arguments);
      return ts.visitEachChild(n, visit, context);
    }
    return ts.visitNode(node, visit);
  }]);
  const code = ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const processPort = { pid: 777, cwd: () => root, env: {} };
  const resolveModule = id => {
    if (id instanceof URL) {
      const expectedBase = 'file:///C:/virtual-canonical/tools/wave3/';
      assert.ok(id.href.startsWith(expectedBase), 'dynamic module URL must remain in the virtual checkout');
      id = './' + id.href.slice(expectedBase.length);
    }
    if (id === 'node:assert/strict') return assert;
    if (id === 'node:fs') return fs;
    if (id === 'node:path') return path.win32;
    if (id === 'node:url') return { fileURLToPath };
    if (id === 'node:crypto') return { randomBytes: () => Buffer.alloc(8, ++nonce), randomUUID: () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, createHash: require('node:crypto').createHash };
    if (id === 'node:test') return (title, ...args) => callbacks.set(title, args.at(-1));
    if (id === './fair-readmission-closure-v3.mjs') return collector;
    if (id === './fixture-actor-cleanup.mjs') return actorCleanup;
    if (id === './admission-fixture-ownership.mjs') {
      if (!cache.has(id)) {
        const helperUrl = new URL(id, import.meta.url);
        const helperAst = ts.createSourceFile(helperUrl.pathname, readFileSync(helperUrl, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        loadedModules.push(id); cache.set(id, executeModule(helperUrl, helperAst));
      }
      return cache.get(id);
    }
    throw Error('unreviewed wiring dependency ' + id);
  };
  new Function('require', 'module', 'exports', 'process', 'loadModulePort', code)(resolveModule, module, module.exports, processPort, async id => resolveModule(id));
  return module.exports;
  }
  executeModule(url, ast);
  return { callbacks, mutations, present, text, ast, fs, nativeChecks, loadedModules, loadHelper() {
    const helperUrl = new URL('./admission-fixture-ownership.mjs', import.meta.url);
    return executeModule(helperUrl, ts.createSourceFile(helperUrl.pathname, readFileSync(helperUrl, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  } };
}
test('AC5 wiring loads the actual helper in the same inert environment with separate parent and nonce mutations', () => {
  const h = load('trust'); const helper = h.loadHelper(); const leaf = helper.createOwnedAnalysisLeaf('directory-control');
  leaf.createDirectory(); leaf.cleanup();
  assert.ok(h.present.has(parent)); assert.equal(h.present.has(path.win32.normalize(leaf.manifestPath)), false);
  assert.ok(h.nativeChecks.length > 0);
  assert.equal(h.mutations.filter(([op, target]) => op === 'mkdir' && target === parent).length, 1);
  assert.equal(h.mutations.filter(([op, target]) => op === 'rmdir' && target === leaf.manifestPath).length, 1);
});
for (const [name, match] of [['trust', 'rejects real directory leaves'], ['seal', 'rejects an unexpected manifest-leaf directory']]) {
  test(`AC5 actual ${name} directory-role callback never mutates original checkout paths`, async () => {
    const h = load(name); const matches = [...h.callbacks].filter(([title]) => title.includes(match)); assert.equal(matches.length, 1);
    // Later scenario assertions need richer collector ports; preserve any error but
    // inspect the real setup/finally mutations before classifying the observed path.
    let scenarioError; try { await matches[0][1](); } catch (error) { scenarioError = error; }
    assert.ok(h.mutations.length > 0, 'actual directory adversary must execute, not an omitted callback');
    const leaves = h.mutations.filter(([, target]) => path.win32.dirname(target) === parent);
    assert.ok(leaves.some(([operation]) => operation === 'mkdir'), 'directory-role nonce must still be created');
    for (const [operation, target] of h.mutations) {
      if (target === parent) { assert.equal(operation, 'mkdir', 'shared parent can only be established, never cleaned'); assert.ok(h.nativeChecks.length > 0); }
      else assert.equal(path.win32.dirname(target), parent, 'nonce mutations belong to the virtual module checkout');
    }
    if (scenarioError) throw scenarioError;
  });
}
test('AC5 actual remediation pre-existing regular sentinel callback preserves its assertions and shared parent', async () => {
  const h = load('remediation');
  const selected = [...h.callbacks].filter(([title]) => title === 'test capture helper preserves a pre-existing manifest leaf when its absence precondition fails');
  assert.equal(selected.length, 1, 'execute the current actual callback, not a removed helper or replacement stub');
  await selected[0][1]();
  assert.ok(h.mutations.some(([operation, , data]) => operation === 'write' && data === '{"owned":"pre-existing"}\n'));
  assert.ok(h.present.has(parent), 'shared canonical analysis parent must not be removed by leaf cleanup');
  assert.equal(h.mutations.some(([operation, target]) => target === parent && ['rmdir', 'rm'].includes(operation)), false);
});
