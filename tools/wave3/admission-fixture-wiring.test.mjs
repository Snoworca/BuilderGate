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
  const faults = { scenarioError: null, cleanupError: null, replaceOnManifestRead: false, invalidCapturePublishes: false };
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
    unlinkSync(p) { mutations.push(['unlink', key(p)]); if (faults.cleanupError) throw faults.cleanupError; present.delete(key(p)); identities.delete(key(p)); },
    readdirSync: p => [...present].filter(x => path.win32.dirname(x) === key(p)),
    readFileSync: (p, encoding) => {
      if (typeof p === 'string' && identities.has(key(p))) {
        if (faults.scenarioError) throw faults.scenarioError;
        const bytes = identities.get(key(p)).bytes;
        if (faults.replaceOnManifestRead && path.win32.dirname(key(p)) === parent) {
          put(p, 'file'); identities.get(key(p)).bytes = bytes;
        }
        return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
      }
      assert.equal(new URL(p).protocol, 'file:');
      return readFileSync(new URL('./' + path.win32.basename(fileURLToPath(p)), import.meta.url), 'utf8');
    },
  };
  const collector = {
    createSegmentReparseGuard(...args) { assert.equal(args.length, 0); return { assertSafeMany(paths, options) { assert.equal(options.forceFresh, true); nativeChecks.push(paths.map(key)); } }; },
    captureFrozenProvenance(options) {
      if (Object.keys(options).some(k => !['workspaceRoot', 'manifestPath', 'phase'].includes(k))) {
        if (faults.invalidCapturePublishes) { put(options.manifestPath, 'file'); identities.get(key(options.manifestPath)).bytes = Buffer.from('uncertain'); }
        throw Error('unsupported capture options native authority');
      }
      assert.equal(path.win32.resolve(options.workspaceRoot), root);
      if (identities.get(key(options.manifestPath))?.role === 'directory') throw Error('directory role rejected');
      mutations.push(['capture', key(options.manifestPath), options]);
      const manifest = { phase: options.phase, protectedInput: { value: {
        sourceClosureRows: [{ kind: 'source', path: 'server/src/services/TerminalResourcePolicyCanary.test.ts', sha256: 'a'.repeat(64) }],
        git: { commandPrefix: ['C:/Program Files/Git/cmd/git.exe', '-c', 'core.longpaths=true'] },
      } } };
      if (options.phase === 'snapshot-native-rows') {
        const inputRows = [['source', 'server/src/ws/WsRouter.ts'], ['config_lock', 'server/config.json5'], ['fixture', 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json']].map(([kind, relative]) => {
          const bytes = Buffer.from(`inert-${kind}-bytes`, 'utf8'); const absolute = path.win32.join(root, relative);
          put(absolute, 'file'); identities.get(key(absolute)).bytes = bytes;
          return { kind, path: relative, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
        });
        manifest.protectedInput.value.sourceClosureRows = inputRows.filter(row => row.kind === 'source');
        manifest.protectedInput.value.configLockRows = inputRows.filter(row => row.kind === 'config_lock');
        manifest.protectedInput.value.fixtureRows = inputRows.filter(row => row.kind === 'fixture');
      }
      put(options.manifestPath, 'file'); identities.get(key(options.manifestPath)).bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      return manifest;
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
  return { callbacks, mutations, present, text, ast, fs, nativeChecks, loadedModules, faults, loadHelper() {
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

for (const [name, title] of [
  ['lexical', 'SDS-AC-1 and SDS-AC-4 retain private native capture, fixed Git, and a complete default frozen closure'],
  ['wave', 'SDS-AC-3 publishes a deterministic deduplicated source closure only after native capture succeeds'],
]) {
  test(`AC5 actual ${name} normal capture persists manifest and cleans only helper-owned nonce`, async () => {
    const h = load(name); const callback = h.callbacks.get(title); assert.equal(typeof callback, 'function');
    await callback();
    assert.ok(h.loadedModules.includes('./admission-fixture-ownership.mjs'), 'actual capability module must own capture');
    const captures = h.mutations.filter(([operation]) => operation === 'capture'); assert.equal(captures.length, 1);
    assert.equal(path.win32.dirname(captures[0][1]), parent);
    assert.equal(h.present.has(captures[0][1]), false); assert.equal(h.present.has(parent), true);
    assert.equal(h.mutations.some(([operation, target]) => ['rm', 'rmdir', 'unlink'].includes(operation) && target === parent), false);
  });
  test(`AC5 actual ${name} post-capture scenario and cleanup errors are both preserved`, async () => {
    const h = load(name); const scenario = Error('scenario read failure'), cleanup = Error('cleanup failure');
    h.faults.scenarioError = scenario; h.faults.cleanupError = cleanup;
    await assert.rejects(h.callbacks.get(title)(), error => {
      assert.ok(error instanceof AggregateError); assert.ok(error.errors.includes(scenario)); assert.ok(error.errors.includes(cleanup)); return true;
    });
    const captures = h.mutations.filter(([operation]) => operation === 'capture'); assert.equal(captures.length, 1);
    assert.ok(h.present.has(captures[0][1]), 'failed cleanup must retain owned manifest');
  });
}
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

const snapshotTitle = 'SDS-AC-3 publishes source, config, and fixture manifest rows whose digests match their native capture bytes';
test('AC5 actual snapshot normal capture preserves all three row digest assertions and helper-owned cleanup', async () => {
  const h = load('snapshot'); await h.callbacks.get(snapshotTitle)();
  assert.ok(h.loadedModules.includes('./admission-fixture-ownership.mjs'));
  const captures = h.mutations.filter(([op]) => op === 'capture'); assert.equal(captures.length, 1);
  assert.equal(h.present.has(captures[0][1]), false); assert.ok(h.present.has(parent));
});
test('AC5 actual snapshot cleanup cannot delete a post-capture same-byte foreign replacement', async () => {
  const h = load('snapshot'); h.faults.replaceOnManifestRead = true;
  await assert.rejects(h.callbacks.get(snapshotTitle)());
  const captures = h.mutations.filter(([op]) => op === 'capture'); assert.equal(captures.length, 1);
  assert.ok(h.present.has(captures[0][1]), 'replacement must survive cleanup');
  assert.equal(h.mutations.some(([op, target]) => op === 'unlink' && target === captures[0][1]), false);
});
test('AC5 actual snapshot retains original scenario and cleanup errors together', async () => {
  const h = load('snapshot'), scenario = Error('snapshot scenario'), cleanup = Error('snapshot cleanup');
  h.faults.scenarioError = scenario; h.faults.cleanupError = cleanup;
  await assert.rejects(h.callbacks.get(snapshotTitle)(), error => error instanceof AggregateError && error.errors.includes(scenario) && error.errors.includes(cleanup));
});
for (const prefix of ['SDS-AC-1 keeps the protected snapshot private', 'SDS-AC-2 rejects caller reparse and snapshot state']) {
  test(`AC5 snapshot raw invalid admission preserves unconfirmed publication: ${prefix}`, async () => {
    const h = load('snapshot'); h.faults.invalidCapturePublishes = true;
    const callback = [...h.callbacks].find(([title]) => title.startsWith(prefix))?.[1]; assert.equal(typeof callback, 'function');
    await assert.rejects(callback());
    assert.equal(h.mutations.some(([op]) => ['unlink', 'rm', 'rmdir'].includes(op)), false, 'rejected raw capture never granted ownership');
    assert.ok([...h.present].some(p => path.win32.dirname(p) === parent));
  });
}
