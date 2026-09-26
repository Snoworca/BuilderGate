import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const url = new URL('../../src/hooks/useWorkspaceManager.ts', import.meta.url);
const ast = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hook = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'useWorkspaceManager');
assert.ok(hook?.body, 'production workspace hook must exist');
const effects: ts.ArrowFunction[] = [];
const states: Array<{ name: string; setter: string; initial: string }> = [];
function containsGetAll(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'workspaceApi.getAll') return true;
  return ts.forEachChild(node, containsGetAll) === true;
}
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0]) && containsGetAll(node.arguments[0])) effects.push(node.arguments[0]);
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
    && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useState') {
    states.push({ name: node.name.elements[0].getText(ast), setter: node.name.elements[1].getText(ast), initial: node.initializer.arguments[0].getText(ast) });
  }
  ts.forEachChild(node, visit);
}
visit(hook.body);
// #108 added a second effect that calls workspaceApi.getAll -- the resync that runs whenever the
// socket reaches 'connected'. These cases are about the INITIAL LOAD, which is the one that also
// restores the persisted active workspace; selecting by that keeps them pointed at their subject
// instead of at whichever getAll effect happens to be first.
const initialLoadEffects = effects.filter(effect => effect.getText(ast).includes('loadActiveWorkspaceId'));
assert.equal(initialLoadEffects.length, 1, 'execute the unique production initial-load effect');
assert.equal(effects.length, 2, 'the initial load and the #108 reconnect resync are both expected');
effects.length = 0;
effects.push(initialLoadEffects[0]);
const errorHelper = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'getErrorMessage');
assert.ok(errorHelper, 'reuse the real hook error conversion');
const compiled = ts.transpileModule(`${errorHelper.getText(ast)}\nconst effect = ${effects[0].getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness() {
  const state: Record<string, unknown> = {};
  const dependencies: Record<string, unknown> = {
    loadActiveWorkspaceId: () => null,
    setActiveWorkspaceIdAndPersist: (id: unknown) => { state.activeWorkspaceId = id; },
  };
  for (const binding of states) {
    const initial = ts.transpileModule(`const initial = ${binding.initial};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const value = new Function('loadActiveWorkspaceId', `${initial}\nreturn initial;`)(dependencies.loadActiveWorkspaceId);
    state[binding.name] = typeof value === 'function' ? value() : value;
    dependencies[binding.setter] = (value: unknown) => { state[binding.name] = typeof value === 'function' ? value(state[binding.name]) : value; };
  }
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  dependencies.workspaceApi = { getAll: () => pending };
  const effect = new Function(...Object.keys(dependencies), `${compiled}\nreturn effect;`)(...Object.values(dependencies)) as () => () => void;
  const cleanup = effect();
  return { state, resolve, reject, cleanup };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
// #41: the declared default is read out of the hook instead of being copied here. A literal
// copy rots silently the first time production adds a limit key -- which is exactly what
// happened when maxTotalSessions joined the default and left this file red without anyone
// noticing. Comparing state against the freshly parsed declaration still fails if the effect
// clobbers the limits before a response arrives, which is what these cases are about.
const limitsBinding = states.find(binding => binding.name === 'limits');
assert.ok(limitsBinding, 'the hook must hold the workspace limits in state');
const defaults = new Function(`return (${limitsBinding.initial});`)() as Record<string, unknown>;
const defaultKeys = Object.keys(defaults);
assert.ok(defaultKeys.length >= 2 && defaultKeys.every(key => typeof defaults[key] === 'number'),
  'the declared default must be an object of numeric limits');

test('FR-BGSTAB-026 CAP-04 initial effect retains default limits before receipt and exposes them', () => {
  const h = harness();
  try {
    assert.deepEqual(h.state.limits, defaults);
    assert.equal(h.state.loading, true);
    const returned = hook.body!.statements.find((node): node is ts.ReturnStatement => ts.isReturnStatement(node));
    assert.ok(returned?.expression && ts.isObjectLiteralExpression(returned.expression));
    assert.ok(returned.expression.properties.some(property => property.name?.getText(ast) === 'limits'), 'hook return must expose the actual limits state');
  } finally { h.cleanup(); }
});

for (const limits of [{ maxWorkspaces: 3, maxTabsPerWorkspace: 4 }, { maxWorkspaces: 20, maxTabsPerWorkspace: 12 }, { maxWorkspaces: 3.5, maxTabsPerWorkspace: 4.5 }]) {
  test(`FR-BGSTAB-026 CAP-04 initial effect applies received ${limits.maxWorkspaces}/${limits.maxTabsPerWorkspace} limits and existing data`, async () => {
    const h = harness();
    const body = { workspaces: [{ id: 'saved-workspace' }], tabs: [{ id: 'saved-tab', workspaceId: 'saved-workspace', lastCwd: '/kept' }], gridLayouts: [], limits };
    h.resolve(body);
    await flush();
    assert.deepEqual(h.state.limits, limits);
    assert.deepEqual(h.state.workspaces, body.workspaces);
    assert.deepEqual(h.state.tabs, [{ ...body.tabs[0], status: 'idle', cwd: '/kept' }]);
    assert.equal(h.state.loading, false);
    assert.equal(h.state.error, null);
    h.cleanup();
  });
}

test('FR-BGSTAB-026 CAP-04 rejected API validation preserves defaults and exposes failure without fabricated state', async () => {
  const h = harness();
  h.reject(new Error('invalid-workspace-limits'));
  await flush();
  assert.deepEqual(h.state.limits, defaults);
  assert.equal(h.state.error, 'invalid-workspace-limits');
  assert.equal(h.state.loading, false);
  assert.deepEqual(h.state.workspaces, []);
  assert.deepEqual(h.state.tabs, []);
  h.cleanup();
});

test('FR-BGSTAB-026 CAP-04 unmounted initial effect cannot apply a late response', async () => {
  const h = harness();
  const before = structuredClone(h.state);
  h.cleanup();
  h.resolve({ workspaces: [{ id: 'late' }], tabs: [], gridLayouts: [], limits: { maxWorkspaces: 3, maxTabsPerWorkspace: 4 } });
  await flush();
  assert.deepEqual(h.state, before);
});
