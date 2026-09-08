import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// REL-BGSTAB-001: execute actual spec cleanup functions, without a browser/network.
function load(file: string, name: string, dependencies: Record<string, unknown>) {
  const text = readFileSync(new URL('../e2e/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1);
  const compiled = ts.transpileModule(found[0].getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), compiled + `;return ${name};`)(...Object.values(dependencies)) as (page: unknown, context?: unknown) => Promise<void>;
}
async function scenario(kind: 'header' | 'clipboard', failure: boolean, mismatch = false) {
  const originalFetch = globalThis.fetch;
  const originalStorage = Reflect.get(globalThis, 'localStorage');
  const storage = new Map<string, string>([
    ['cws_auth_token', 'unit-token'], ['active_workspace_id', 'x'],
    ['__bg_tc7004_owned_workspace', JSON.stringify({ workspaceId: 'x', ownerToken: 'proof', workspaceName: 'PW-proof' })],
    ['__bg_tc7004_previous_workspace', 'user'],
  ]);
  Reflect.set(globalThis, 'localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const workspaces = [{ id: 'x', name: mismatch ? 'other' : 'PW-proof' }, { id: 'y', name: 'same owner sibling' }, { id: 'user', name: 'User' }];
  const rawDeletes: string[] = [], selected: string[] = []; let reloads = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'DELETE') { rawDeletes.push(String(input)); return Response.json({}); }
    return Response.json({ workspaces });
  };
  const context = {};
  const page = { context: () => context, evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg), reload: async () => { reloads++; } };
  const expect = Object.assign((value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) }), {
    poll: (fn: () => Promise<unknown>) => ({ toBe: async (expected: unknown) => assert.equal(await fn(), expected) }),
  });
  const cleanupError = Error('selected cleanup 503');
  const cleanup = load(kind === 'header' ? 'header-context-menu-regression.spec.ts' : 'terminal-clipboard.spec.ts', kind === 'header' ? 'cleanupOwnedTc7004Workspace' : 'cleanupClipboardWorkspace', {
    TC7004_OWNED_WORKSPACE_KEY: '__bg_tc7004_owned_workspace', TC7004_PREVIOUS_WORKSPACE_KEY: '__bg_tc7004_previous_workspace', expect, waitForTerminal: async () => undefined,
    deleteOwnedWorkspaceForContext: async (actualContext: unknown, id: string) => {
      assert.equal(actualContext, context); selected.push(id);
      if (failure) throw cleanupError;
      assert.equal(id, 'x'); workspaces.splice(workspaces.findIndex(w => w.id === id), 1);
      return { deleted: [id], absent: [], failed: [] };
    },
  });
  try {
    if (mismatch) {
      await assert.rejects(cleanup(page), /ownership proof mismatch/);
      assert.deepEqual(selected, []); assert.deepEqual(rawDeletes, []);
    } else if (failure) {
      await assert.rejects(cleanup(page, { workspaceId: 'x' }), error => error === cleanupError);
      assert.deepEqual(selected, ['x']); assert.equal(storage.get('active_workspace_id'), 'x');
      assert.ok(storage.has('__bg_tc7004_owned_workspace')); assert.equal(reloads, 0);
    } else {
      await cleanup(page, { workspaceId: 'x' }); assert.deepEqual(selected, ['x']);
      assert.deepEqual(workspaces.map(w => w.id), ['y', 'user']);
      if (kind === 'header') { assert.equal(storage.get('active_workspace_id'), 'user'); assert.equal(storage.has('__bg_tc7004_owned_workspace'), false); assert.equal(reloads, 1); }
    }
    assert.deepEqual(rawDeletes, [], 'spec must delegate selected deletion to the owner-checked Node helper');
  } finally { globalThis.fetch = originalFetch; if (originalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage'); else Reflect.set(globalThis, 'localStorage', originalStorage); }
}
for (const kind of ['header', 'clipboard'] as const) {
  test(`B2 actual ${kind} selected cleanup preserves siblings and success verification`, () => scenario(kind, false));
  test(`B2 actual ${kind} cleanup failure remains visible and does not clear ownership state`, () => scenario(kind, true));
}
test('B2 actual header token/name diagnostic refuses deletion before helper', () => scenario('header', false, true));
