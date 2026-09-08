import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// B2: execute actual cleanup wrappers; the independently tested owner helper is
// the observation boundary. No real browser/fetch/DELETE is called.
const targets = [
  ['terminal-shortcut-manager.spec.ts', 'deleteWorkspace'],
  ['wave1-retained-state-characterization.spec.ts', 'cleanupOwnedLiveWorkspace'],
  ['wave3-terminal-authority-fairness.spec.ts', 'deleteWave3Workspace'],
  ['wave3-terminal-authority-promotion.spec.ts', 'deleteOwnedAuthorityWorkspace'],
] as const;
function fixture(file: string, name: string, failure?: Error) {
  const ast = ts.createSourceFile(file, readFileSync(new URL(`../e2e/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const context = {}; const calls: unknown[][] = []; const rawDeletes: string[] = [];
  const storage = new Map([['ph005_authority_workspace_id', 'owned-one'], ['ph005_authority_workspace_name', 'owned'], ['__bg_retained_live_owner_owned-one', 'owner-token']]);
  const page = { context: () => context, evaluate: (callback: (value: unknown) => unknown, value: unknown) => callback(value), reload: async () => {} };
  const cache = new WeakMap<object, { id: string; name: string }>([[page, { id: 'owned-one', name: 'owned' }]]);
  const dependencies = {
    ownedAuthorityWorkspaces: cache,
    deleteOwnedWorkspaceForContext: async (...args: unknown[]) => { calls.push(args); if (failure) throw failure; return { deleted: ['owned-one'], absent: [], failed: [] }; },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: async (url: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') rawDeletes.push(url);
      return Response.json({ workspaces: [] });
    },
    expect: (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) }),
    waitForTerminal: async () => {},
  };
  const cleanup = new Function(...Object.keys(dependencies), `${compiled}\nreturn ${name};`)(...Object.values(dependencies));
  return { calls, rawDeletes, context, storage, cache, page, run: () => cleanup(page,
    name === 'cleanupOwnedLiveWorkspace' ? { workspaceId: 'owned-one', ownerToken: 'owner-token', previousWorkspaceId: null } : 'owned-one') };
}
for (const [file, name] of targets) {
  test(`B2 ${file} cleanup delegates only its selected ID to the owner helper`, async () => {
    const h = fixture(file, name); await h.run();
    assert.deepEqual(h.calls, [[h.context, 'owned-one']]); assert.deepEqual(h.rawDeletes, []);
  });
  test(`B2 ${file} cleanup preserves an owner-helper failure`, async () => {
    const failure = new Error('controlled owner cleanup failure'); const h = fixture(file, name, failure);
    await assert.rejects(h.run(), error => error === failure);
    assert.deepEqual(h.calls, [[h.context, 'owned-one']]); assert.deepEqual(h.rawDeletes, []);
    if (name === 'deleteOwnedAuthorityWorkspace') {
      assert.equal(h.cache.get(h.page)?.id, 'owned-one');
      assert.equal(h.storage.get('ph005_authority_workspace_id'), 'owned-one');
    }
  });
}
