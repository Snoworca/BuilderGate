import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type { BrowserContext } from '@playwright/test';
import { recordWorkspaceBaseline } from '../e2e/workspaceLeakGuard.ts';
import { attachWorkspaceOwnership } from '../e2e/workspaceOwnershipFixture.ts';

// #57 removed the E2E password fallback. These tests never reach a real login -- they stub
// fetch -- but the leak guard reads the password before calling it, so the process needs one.
process.env.BUILDERGATE_PASSWORD ??= 'test-only-password';


// B2: execute actual promotion setup with controlled browser response events and
// the real ownership registry. No browser, HTTP request or actual DELETE occurs.
async function harness(run: (h: {
  ensure(): Promise<void>; storage: Map<string, string>; posts: string[]; deletes: string[]; tabRequests: string[];
  failTab: { value: boolean }; drain(): Promise<void>; records(): Promise<string[]>;
}) => Promise<void>) {
  const ast = ts.createSourceFile('promotion.ts', readFileSync(new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ensureOwnedAuthorityWorkspace');
  assert.ok(helper);
  const declarations = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .filter(node => ['AUTHORITY_WORKSPACE_PREFIX', 'ownedAuthorityWorkspaces'].includes(node.name.getText(ast)));
  const code = ts.transpileModule(declarations.map(node => `const ${node.getText(ast)};`).join('\n') + '\n' + helper.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const parent = await mkdtemp(join(tmpdir(), 'buildergate-promotion-owner-'));
  const registryPath = join(parent, 'run');
  const context = new EventEmitter();
  const storage = new Map<string, string>();
  const workspaces = new Map<string, string>([['user-unowned', 'PH5A-user-saved']]);
  const posts: string[] = []; const deletes: string[] = []; const tabRequests: string[] = []; const failTab = { value: false };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'https://localhost:2222');
    assert.equal(url.origin, 'https://localhost:2222');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/auth/login') return Response.json({ token: 'fixture-token' });
    if (url.pathname === '/api/workspaces' && method === 'GET') return Response.json({ workspaces: [...workspaces].map(([id, name]) => ({ id, name })) });
    if (url.pathname === '/api/workspaces' && method === 'POST') {
      const workspace = { id: `created-${posts.length + 1}`, name: JSON.parse(String(init?.body)).name };
      posts.push(workspace.id); workspaces.set(workspace.id, workspace.name);
      const request = { method: () => 'POST', url: () => url.href };
      context.emit('request', request);
      context.emit('response', { request: () => request, status: () => 201, url: () => url.href,
        serverAddr: async () => ({ ipAddress: '127.0.0.1', port: 2222 }), fromServiceWorker: () => false, json: async () => workspace });
      context.emit('requestfinished', request);
      return Response.json(workspace, { status: 201 });
    }
    if (method === 'POST' && url.pathname.endsWith('/tabs')) {
      tabRequests.push(url.pathname);
      return Response.json({ sessionId: 'fixture-session' }, { status: failTab.value ? 500 : 201 });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/workspaces/')) {
      deletes.push(url.pathname); workspaces.delete(url.pathname.split('/').at(-1)!); return Response.json({});
    }
    return assert.fail(`unexpected fake request ${method} ${url.pathname}`);
  };
  const registry = { registryPath, runId: 'promotion-test', baseUrl: 'https://localhost:2222', fetch: fakeFetch };
  await recordWorkspaceBaseline(registry);
  const tracker = attachWorkspaceOwnership(context as unknown as BrowserContext, registry, 'owner');
  const ensure = new Function('fetch', 'localStorage', code + '\nreturn ensureOwnedAuthorityWorkspace;')(fakeFetch, {
    getItem: (key: string) => key === 'cws_auth_token' ? 'fixture-token' : storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  });
  const page = { evaluate: (callback: (input: unknown) => unknown, input: unknown) => callback(input),
    reload: async () => {}, getByRole: () => ({ click: async () => {} }), waitForTimeout: async () => {} };
  try {
    await run({ ensure: () => ensure(page), storage, posts, deletes, tabRequests, failTab, drain: () => tracker.drain(),
      records: async () => Promise.all((await readdir(join(registryPath, 'records'))).map(async file => JSON.parse(await readFile(join(registryPath, 'records', file), 'utf8')).workspaceId)) });
  } finally { await tracker.dispose(); await rm(parent, { recursive: true, force: true }); }
}

test('B2 promotion setup never adopts an unowned workspace from localStorage and GET', async () => {
  await harness(async h => {
    h.storage.set('ph005_authority_workspace_id', 'user-unowned');
    h.storage.set('ph005_authority_workspace_name', 'PH5A-user-saved');
    await h.ensure(); await h.drain();
    assert.deepEqual(h.posts, ['created-1']);
    assert.deepEqual(h.tabRequests, ['/api/workspaces/created-1/tabs'], 'no tab mutation may target the unowned cached ID');
    assert.equal(h.storage.get('active_workspace_id'), 'created-1');
    assert.deepEqual(h.deletes, []);
    assert.deepEqual(await h.records(), ['created-1']);
  });
});
test('B2 promotion setup reuses only its own successful same-page creation', async () => {
  await harness(async h => {
    await h.ensure(); await h.ensure(); await h.drain();
    assert.deepEqual(h.posts, ['created-1']);
    assert.deepEqual(await h.records(), ['created-1']);
    assert.deepEqual(h.deletes, []);
  });
});
test('B2 failed tab setup leaves registered creation for owner cleanup and never promotes the reuse cache', async () => {
  await harness(async h => {
    h.failTab.value = true; await assert.rejects(h.ensure(), /tab create returned 500/); await h.drain();
    assert.deepEqual(await h.records(), ['created-1']);
    assert.deepEqual(h.deletes, []);
    h.failTab.value = false; await h.ensure(); await h.drain();
    assert.deepEqual(h.posts, ['created-1', 'created-2']);
    assert.equal(h.storage.get('active_workspace_id'), 'created-2');
    assert.deepEqual((await h.records()).sort(), ['created-1', 'created-2']);
  });
});
