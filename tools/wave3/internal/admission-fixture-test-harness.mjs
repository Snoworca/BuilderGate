const harnessModuleBase = new URL('../admission-fixture-wiring.test.mjs', import.meta.url).href;
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as actorCleanup from '../fixture-actor-cleanup.mjs';
const require = createRequire(harnessModuleBase), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const root = 'C:\\virtual-canonical', parent = path.win32.join(root, 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
export function loadFixtureHarness(name) {
  const url = new URL('./fair-readmission-closure-v3.' + name + '.test.mjs', harnessModuleBase);
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
      return readFileSync(new URL('./' + path.win32.basename(fileURLToPath(p)), harnessModuleBase), 'utf8');
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
      const manifest = { phase: options.phase, protectedInput: { sha256: 'a'.repeat(64), value: {
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
        const helperUrl = new URL(id, harnessModuleBase);
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
    const helperUrl = new URL('./admission-fixture-ownership.mjs', harnessModuleBase);
    return executeModule(helperUrl, ts.createSourceFile(helperUrl.pathname, readFileSync(helperUrl, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  } };
}
