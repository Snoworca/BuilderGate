import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// PERF-BGSTAB-011: source contracts only; never import the physical suite.
const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');
const text = readFileSync(new URL('./fair-readmission-closure-v3.internal-core-race.test.mjs', import.meta.url), 'utf8');
const ast = ts.createSourceFile('physical.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const printer = ts.createPrinter();
function nodes(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root); return found;
}
const calls = (root, name) => nodes(root, n => ts.isCallExpression(n) && n.expression.getText(ast) === name);
const print = node => printer.printNode(ts.EmitHint.Unspecified, node, ast).replace(/\s+/g, '');
const parents = calls(ast, 'test').filter(n => ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.includes('then serially reset the fixture for junction admission'));
assert.equal(parents.length, 1, 'the actual physical parent must remain uniquely identifiable');
const parent = parents[0].arguments.at(-1);
const mapping = [
  ['SDS-AC-1 and SDS-AC-3 create an absent fixed analysis parent only after fresh native guard probes at manifest boundaries', ['actorGuard'], '[{actor:actorGuard,releaseByte:0x52}]'],
  ['SDS-AC-1 rejects a swapped docs junction before any missing analysis parent mutation', ['actorGuard'], '[{actor:actorGuard,releaseByte:0x52}]'],
  ['SDS-AC-4 proves sibling native capture completes between A retained-fd write and postflight without a collector test mode', ['actorA', 'actorB'], '[{actor:actorA,releaseByte:0x52},{actor:actorB}]'],
  ['SDS-AC-3 distinguishes the guarded postwrite probe from final leaf identity observation during same-byte replacement', ['actorA'], '[{actor:actorA,releaseByte:0x52}]'],
  ['SDS-AC-2 closes every acquired retained descriptor exactly once across write and postflight failures, and never closes an EEXIST non-descriptor', ['actorExisting', 'actorWrite', 'actorPostflight'], '[{actor:actorExisting},{actor:actorWrite},{actor:actorPostflight,releaseByte:0x52}]'],
];
function scenario(name) {
  const found = calls(parent, 'runSettledSubtest').filter(n => n.arguments[1]?.text === name);
  assert.equal(found.length, 1, name); return found[0].arguments.at(-1);
}
function enclosingFinally(node) {
  let current = node.parent;
  while (current && !ts.isTryStatement(current)) current = current.parent;
  assert.ok(current?.finallyBlock && node.pos >= current.finallyBlock.pos, 'cleanup must be in finally');
  return current;
}
function assertFailureCapture(statement, variable) {
  const clause = statement.catchClause;
  assert.ok(clause?.variableDeclaration, 'the actual body error must be captured');
  const error = clause.variableDeclaration.name.getText(ast);
  assert.ok(nodes(clause.block, n => ts.isBinaryExpression(n) && print(n) === `${variable}={error:${error}}`).length === 1,
    'preserve arbitrary thrown values, including undefined, in a tagged record');
}

test('actor cleanup wiring maps every actual spawn to the persistent parent owner set', () => {
  const owner = nodes(parent, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'ownerActors');
  assert.equal(owner.length, 1); assert.equal(print(owner[0].initializer), 'newSet()');
  const mapped = [];
  for (const [name, actors] of mapping) {
    const sites = calls(scenario(name), 'spawnWxRaceChild');
    assert.deepEqual(sites.map(n => n.parent.left?.getText(ast)), actors, name);
    for (const site of sites) {
      assert.ok(ts.isObjectLiteralExpression(site.arguments[0]));
      assert.equal(site.arguments[0].properties.filter(p => ts.isShorthandPropertyAssignment(p) && p.name.text === 'ownerActors').length, 1);
      mapped.push(site);
    }
  }
  assert.deepEqual(calls(ast, 'spawnWxRaceChild').map(n => n.pos).sort((a,b)=>a-b), mapped.map(n=>n.pos).sort((a,b)=>a-b),
    'no additional spawn can escape the exact scenario inventory');
});

test('actor spawn factory registers the actual returned handle before handing it to callers', () => {
  const factory = nodes(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === 'spawnWxRaceChild');
  assert.equal(factory.length, 1);
  const source = printer.printNode(ts.EmitHint.Unspecified, factory[0], ast);
  const fakeChild = { stdout: { setEncoding(){}, on(){} }, stderr: { setEncoding(){}, on(){} }, once(){} };
  const make = new Function('spawn', 'wxRaceChildEnvironment', 'process', `${source}; return spawnWxRaceChild;`)(
    () => fakeChild, () => ({}), { execPath: 'never-executed-node' });
  const ownerActors = new Set();
  const handle = make({ ownerActors, harness: { runnerPath: 'inert', preloaderPath: 'inert' }, actor: 'A',
    manifestPath: 'inert', phase: 'inert', collectorSourceUrl: 'inert', childWorkspaceRoot: 'inert', timeline: [] });
  assert.equal(ownerActors.size, 1); assert.equal(ownerActors.has(handle), true);
  assert.equal(handle.child, fakeChild);
});

test('five actor finally blocks retain exact release ownership and prior failures', () => {
  for (const [name, , expected] of mapping) {
    const found = calls(scenario(name), 'settleActorCleanup');
    assert.equal(found.length, 1, name);
    assert.equal(print(found[0].arguments[0]), expected);
    assert.equal(print(found[0].arguments[1]), 'releaseWxRaceChild');
    assert.equal(print(found[0].arguments[2]), 'priorFailure');
    assert.ok(ts.isAwaitExpression(found[0].parent));
    assertFailureCapture(enclosingFinally(found[0]), 'priorFailure');
  }
});

test('outer fixture deletion is owned by actual exits and retains the parent failure', () => {
  const found = calls(parent, 'cleanupExitedActors'); assert.equal(found.length, 1);
  const call = found[0];
  assert.equal(print(call.arguments[0]), 'ownerActors');
  assert.equal(print(call.arguments[1]), '[harness.ownedRoot,ownedRoot]');
  assert.equal(print(call.arguments[3]), 'parentFailure');
  assertFailureCapture(enclosingFinally(call), 'parentFailure');
  const callback = call.arguments[2]; assert.ok(ts.isArrowFunction(callback));
  for (const [name, arg] of [['removeOwnedWxRaceHarness', 'harness.ownedRoot'], ['removeOwnedWorkspace', 'ownedRoot']]) {
    const all = calls(parent, name), guarded = calls(callback, name);
    assert.equal(all.length, 1); assert.equal(guarded.length, 1);
    assert.equal(all[0], guarded[0]); assert.equal(print(all[0].arguments[0]), arg);
  }
});
