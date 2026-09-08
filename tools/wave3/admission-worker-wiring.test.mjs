import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as actorCleanup from './fixture-actor-cleanup.mjs';
import * as lifecycle from './admission-worker-lifecycle.mjs';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');
const scenarios = [['trust', 'runWorkerRace'], ['seal', 'runNativeSealWorker'], ['lexical', 'runNativeLexicalWorker']];
function find(root, predicate) { const found = []; function visit(n) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); } visit(root); return found; }
function source(kind) { const text = readFileSync(new URL(`./fair-readmission-closure-v3.${kind}-race.test.mjs`, import.meta.url), 'utf8'); return ts.createSourceFile(`${kind}.mjs`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); }
const calls = (root, text) => find(root, n => ts.isCallExpression(n) && n.expression.getText() === text);

import { loadFixtureHarness } from './internal/admission-fixture-test-harness.mjs';
const ownedEnvironment = () => loadFixtureHarness('trust');

function compiledWorker(kind, functionName, ports) {
  const ast = source(kind), fn = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === functionName);
  assert.equal(fn.length, 1);
  const transformed = ts.transform(fn[0], [context => node => {
    function visit(n) {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return ts.factory.createCallExpression(ts.factory.createIdentifier('loadModulePort'), undefined, n.arguments);
      return ts.visitEachChild(n, visit, context);
    }
    return ts.visitNode(node, visit);
  }]);
  const code = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], ast);
  return new Function(...Object.keys(ports), `${code}; return ${functionName};`)(...Object.values(ports));
}

test('worker wiring harness loads the actual ownership capability with inert native and filesystem ports', () => {
  const h = ownedEnvironment(), leaf = h.loadHelper().createOwnedAnalysisLeaf('worker-harness');
  const manifest = leaf.capture('worker-harness');
  assert.equal(JSON.parse(h.fs.readFileSync(leaf.manifestPath, 'utf8')).phase, manifest.phase);
  leaf.cleanup(); assert.equal(h.fs.existsSync(leaf.manifestPath), false);
  assert.ok(h.nativeChecks.length > 0);
});

for (const [kind, functionName] of scenarios) {
  for (const earlyPermit of [true, false]) {
  test(`AC2/5 ${kind} actual Worker retains real capability through ${earlyPermit ? 'early' : 'late'} cleanup permit`, async () => {
    const h = ownedEnvironment(), helper = h.loadHelper(), events = [], messages = [];
    const lexicalAst = source('lexical');
    const lexicalDeclarations = lexicalAst.statements.filter(n => ts.isVariableStatement(n)
      && n.declarationList.declarations.some(d => ['dynamicImportSources', 'dynamicImportTargets'].includes(d.name.getText())));
    const lexicalAssertion = find(lexicalAst, n => ts.isFunctionDeclaration(n) && n.name?.text === 'assertDynamicClosureRows');
    assert.equal(lexicalDeclarations.length, 2); assert.equal(lexicalAssertion.length, 1);
    const lexical = new Function('assert', `${lexicalDeclarations.map(n=>n.getText()).join('\n')}\n${lexicalAssertion[0].getText()}\nreturn { check: assertDynamicClosureRows, rows: [...dynamicImportSources,...dynamicImportTargets] };`)(assert);
    let leaf, startPassed = false, verified = false;
    const slots = new Int32Array(new ArrayBuffer(20)); slots[3] = Number(earlyPermit); slots[4] = Number(earlyPermit);
    const processPort = { exitCode: 0 };
    const createOwnedAnalysisLeaf = prefix => {
      assert.equal(leaf, undefined); leaf = helper.createOwnedAnalysisLeaf(prefix);
      return Object.freeze({ ...leaf, capture(phase) {
        assert.equal(startPassed, true, 'early cleanup permission never authorizes capture before start release');
        events.push('capture');
        const manifest = leaf.capture(phase);
        // Populate the inert native result with the actual scenario's required
        // source inventory, then execute its unchanged lexical assertion.
        if (kind === 'lexical') for (const required of lexical.rows) manifest.protectedInput.value.sourceClosureRows.push({ path: required });
        return manifest;
      }, cleanup(prior) {
        assert.equal(verified, true, 'parent must inspect retained manifest before normal cleanup');
        events.push('worker-cleanup'); return leaf.cleanup(prior);
      } });
    };
    const ports = { ...lifecycle, ...actorCleanup, assert, workerData: { index: 0, leaf: 'C:/inert/legacy.json', manifestPath: 'C:/inert/legacy.json', collectorUrl: 'inert', barrier: slots.buffer, controlBuffer: slots.buffer },
      workspaceRoot: 'C:\\virtual-canonical', process: processPort, createOwnedAnalysisLeaf,
      loadModulePort: async () => ({ ...helper, captureFrozenProvenance() { throw Error('unowned raw capture'); } }),
      assertDynamicClosureRows: lexical.check,
      parentPort: { postMessage(message) {
        messages.push(message);
        if (message.phase === 'ready') {
          assert.equal(message.manifestPath, leaf?.manifestPath); assert.equal(h.fs.existsSync(message.manifestPath), false);
          events.push('ready');
        }
        if (message.phase === 'captured') {
          assert.equal(message.manifestPath, leaf.manifestPath);
          assert.equal(message.sha256, JSON.parse(h.fs.readFileSync(leaf.manifestPath, 'utf8')).protectedInput.sha256);
          assert.match(message.sha256, /^[a-f0-9]{64}$/);
          assert.equal(h.fs.existsSync(leaf.manifestPath), true);
          assert.equal(JSON.parse(h.fs.readFileSync(leaf.manifestPath, 'utf8')).phase, `${kind}-native-worker-0`);
          events.push('captured');
          if (earlyPermit) { verified = true; events.push('parent-verified'); }
        }
      } },
      Atomics: { add(a,i,v) { const old=a[i]; a[i]+=v; return old; }, load(a,i) { return a[i]; },
        wait(a,i) {
          if (i === 1) { startPassed=true; a[1]=1; events.push('start-release'); return 'ok'; }
          assert.equal(earlyPermit, false);
          assert.equal(i, 3, 'index0 waits only on its dedicated cleanup slot');
          assert.equal(a[i], 0); assert.equal(verified, false);
          assert.ok(events.includes('captured'), 'cleanup wait follows captured notification');
          assert.equal(h.fs.existsSync(leaf.manifestPath), true, 'file remains live while parent has not verified it');
          assert.equal(events.includes('worker-cleanup'), false);
          assert.equal(JSON.parse(h.fs.readFileSync(leaf.manifestPath, 'utf8')).phase, `${kind}-native-worker-0`);
          events.push('cleanup-wait'); verified = true; events.push('parent-verified'); a[i] = 1;
          return 'ok';
        },
        store(a,i,v) { a[i]=v; return v; }, notify() { return 0; } },
    };
    await compiledWorker(kind, functionName, ports)();
    assert.equal(processPort.exitCode, 0); assert.equal(messages.some(m=>m.phase==='error'), false);
    assert.ok(events.indexOf('start-release') < events.indexOf('capture'));
    assert.ok(events.indexOf('parent-verified') < events.indexOf('worker-cleanup'));
    assert.equal(events.includes('cleanup-wait'), !earlyPermit);
    assert.ok(events.includes('worker-cleanup')); assert.equal(h.fs.existsSync(leaf.manifestPath), false);
  });
  }
  test(`AC2/5 ${kind} Worker function preserves nested original and cleanup error details`, async () => {
    const messages = [], failure = new AggregateError([Error('original-detail-marker'), new AggregateError([Error('cleanup-detail-marker')], 'nested')], 'combined');
    const data = { index: 0, leaf: 'C:/inert/a.json', manifestPath: 'C:/inert/a.json', collectorUrl: 'inert', barrier: new ArrayBuffer(20), controlBuffer: new ArrayBuffer(20) };
    const run = compiledWorker(kind, functionName, { ...lifecycle,
      workerData: data, parentPort: { postMessage: m => messages.push(m) }, process: { exitCode: 0 },
      loadModulePort: async () => { throw failure; }, createOwnedAnalysisLeaf: () => { throw failure; },
      Atomics: { add() { assert.fail('failure before ready must not reach start'); }, wait() { assert.fail('no blocking wait'); }, load() { return 1; } },
    });
    await run();
    const errors = messages.filter(m => m.phase === 'error');
    assert.equal(errors.length, 1);
    const encoded = JSON.stringify(errors[0]);
    assert.match(encoded, /original-detail-marker/); assert.match(encoded, /cleanup-detail-marker/);
  });

  test(`AC2/5 ${kind} parent owns Worker records and never adopts manifest deletion`, () => {
    const ast = source(kind);
    const parents = calls(ast, 'test'); assert.equal(parents.length, 1);
    const parent = parents[0].arguments.at(-1);
    assert.equal(calls(parent, 'registerWorker').length > 0, true, 'every created Worker must be registered before later construction can throw');
    assert.equal(calls(parent, 'releaseAndAwaitWorkers').length, 1, 'one outer release-all/exit barrier retains prior failures');
    assert.equal(calls(parent, 'recordWorkerPhase').length > 0, true, 'listener must bind actual Worker entry to ready/captured paths');
    const deletes = find(parent, n => ts.isCallExpression(n) && /(?:unlinkSync|rmSync|rmdirSync|removeOwnedLeaf|removeTestLeaf)$/.test(n.expression.getText()));
    assert.deepEqual(deletes, [], 'parent cannot delete Worker-owned manifests even on failure');
    const allocations = find(ast, n => ts.isNewExpression(n) && n.expression.getText() === 'SharedArrayBuffer');
    assert.ok(allocations.some(n => /\*\s*5/.test(n.arguments[0].getText())), 'slots0/1/2 retained and cleanup slots3/4 added');
    const worker = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === functionName)[0];
    assert.equal(calls(worker, 'createOwnedAnalysisLeaf').length, 1, 'Worker mints its own capability');
    assert.equal(find(worker, n => ts.isCallExpression(n) && /\.cleanup$/.test(n.expression.getText())).length, 1, 'Worker alone cleans its capability');
  });
}
