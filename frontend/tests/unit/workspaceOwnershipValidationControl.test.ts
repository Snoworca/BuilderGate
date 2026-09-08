import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

// REL-BGSTAB-001: execute the actual validation callback; all browser/network ports are inert.
async function run(options: { capacity?: number; leakUi?: boolean; attachFails?: boolean; bodyFails?: boolean; cleanupFails?: boolean; quotaDelete?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buildergate-validation-control-'));
  await mkdir(join(root, 'records'));
  const oldFetch = globalThis.fetch, oldStorage = Reflect.get(globalThis, 'localStorage');
  const oldDir = process.env.BUILDERGATE_E2E_RUN_DIR, oldRun = process.env.BUILDERGATE_E2E_RUN_ID;
  process.env.BUILDERGATE_E2E_RUN_DIR = root; process.env.BUILDERGATE_E2E_RUN_ID = 'unit-run';
  Reflect.set(globalThis, 'localStorage', { getItem: () => 'unit-token' });
  const capacity = options.capacity ?? 4;
  const state = { workspaces: [] as { id: string; name: string; viewMode: string; activeTabId: null }[], tabs: [], limits: { maxWorkspaces: capacity } };
  const apiIds: string[] = [], uiIds: string[] = [], actualDeletes: string[] = [];
  const context = new EventEmitter(); let sequence = 0, clicks = 0, postCount = 0;
  let pendingResponse: ((value: unknown) => void) | undefined;
  let attachment: Record<string, unknown> | undefined;
  const bodyError = Error('original body failure'), attachmentError = Error('attachment failure'), cleanupError = Error('original cleanup failure');
  const erase = async (id: string) => { actualDeletes.push(id); state.workspaces = state.workspaces.filter(item => item.id !== id); await unlink(join(root, 'records', id)).catch(() => undefined); };
  const fakeFetch: typeof fetch = async input => { const id = new URL(String(input)).pathname.split('/').at(-1)!; await erase(id); return Response.json({}); };
  globalThis.fetch = fakeFetch;
  const make = async (name: string, ui: boolean) => {
    const id = `${ui ? 'ui' : 'api'}-${++sequence}`;
    state.workspaces.push({ id, name, viewMode: 'tab', activeTabId: null });
    await writeFile(join(root, 'records', id), '{}', 'utf8'); (ui ? uiIds : apiIds).push(id);
    return { id };
  };
  const request = {
    get: async () => ({ status: () => 200, json: async () => structuredClone(state) }),
    post: async (_url: string, input: { data: { name: string } }) => {
      postCount++;
      if (state.workspaces.length >= capacity) {
        if (options.quotaDelete) await globalThis.fetch('https://localhost:2222/api/workspaces/not-owned', { method: 'DELETE' });
        return { status: () => 409, json: async () => ({ error: 'quota' }) };
      }
      const body = await make(input.data.name, false); return { status: () => 201, json: async () => body };
    },
  };
  const page = {
    context: () => context, url: () => 'https://localhost:2222/', evaluate: async (fn: () => unknown) => fn(),
    waitForResponse: () => new Promise(resolve => { pendingResponse = resolve; }),
    getByTitle: () => ({ click: async () => {
      clicks++; const body = await make('UI', true);
      pendingResponse?.({ status: () => 201, json: async () => body, fromServiceWorker: () => false, serverAddr: async () => ({ ipAddress: '127.0.0.1', port: 2222 }) });
    } }),
  };
  const ownership = {
    drain: async () => undefined,
    deleteWorkspace: async (id: string) => { await globalThis.fetch('https://localhost:2222/api/workspaces/' + id, { method: 'DELETE' }); return { deleted: [id], absent: [], failed: [] }; },
    cleanup: async () => { if (options.cleanupFails) throw cleanupError; if (!options.leakUi) for (const id of uiIds.filter(id => state.workspaces.some(item => item.id === id))) await globalThis.fetch('https://localhost:2222/api/workspaces/' + id, { method: 'DELETE' }); },
  };
  const expect = (value: unknown, message?: string) => ({
    toBe: (expected: unknown) => assert.equal(value, expected, message),
    toEqual: (expected: unknown) => assert.deepEqual(value, expected, message),
    toBeGreaterThan: (expected: number) => assert.ok(Number(value) > expected, message),
    toBeGreaterThanOrEqual: (expected: number) => assert.ok(Number(value) >= expected, message),
    toBeLessThanOrEqual: (expected: number) => assert.ok(Number(value) <= expected, message),
    toBeDisabled: async () => assert.equal(state.workspaces.length, capacity),
    rejects: { toThrow: async () => assert.rejects(value as Promise<unknown>) },
  });
  let callback!: (args: unknown, info: unknown) => Promise<void>;
  const module = { exports: {} };
  const sourceUrl = new URL('../e2e/workspace-ownership-validation.spec.ts', import.meta.url);
  const compiled = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const nativeRequire = createRequire(sourceUrl);
  new Function('require', 'module', 'exports', compiled)((id: string) => {
    if (id === './workspaceOwnershipFixture') return { expect, test: (_name: string, fn: typeof callback) => { callback = fn; }, createOwnedWorkspaceViaApi: async (client: typeof request, _registry: unknown, _owner: string, input: { data: { name: string } }) => { const response = await client.post('https://localhost:2222/api/workspaces', input); if (response.status() !== 201) throw Error('quota'); return response.json(); } };
    if (id === './workspaceLeakGuard') return { cleanupOwnedWorkspaces: async (registry: { fetch?: typeof fetch }) => { for (const id of apiIds.filter(id => state.workspaces.some(item => item.id === id))) await (registry.fetch ?? globalThis.fetch)('https://localhost:2222/api/workspaces/' + id, { method: 'DELETE' }); return { deleted: apiIds, absent: [], failed: [] }; } };
    if (id === './helpers') return { login: async () => { if (options.bodyFails) throw bodyError; } };
    assert.ok(id.startsWith('node:')); return nativeRequire(id);
  }, module, module.exports);
  let failure: unknown;
  try {
    await callback({ page, request, workspaceOwnership: ownership }, { testId: 'control', retry: 0, attach: async (_name: string, data: { body: Buffer }) => { if (options.attachFails) throw attachmentError; attachment = JSON.parse(data.body.toString('utf8')); } });
  } catch (error) { failure = error; }
  const fetchRestored = globalThis.fetch === fakeFetch;
  globalThis.fetch = oldFetch; if (oldStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage'); else Reflect.set(globalThis, 'localStorage', oldStorage);
  if (oldDir === undefined) delete process.env.BUILDERGATE_E2E_RUN_DIR; else process.env.BUILDERGATE_E2E_RUN_DIR = oldDir;
  if (oldRun === undefined) delete process.env.BUILDERGATE_E2E_RUN_ID; else process.env.BUILDERGATE_E2E_RUN_ID = oldRun;
  await rm(root, { recursive: true, force: true });
  return { failure, attachment, clicks, postCount, actualDeletes, bodyError, attachmentError, cleanupError, fetchRestored };
}

test('B2 validation observes exactly one UI selected DELETE and restores global fetch', async () => {
  const result = await run(); assert.equal(result.failure, undefined);
  const deletes = result.attachment?.observedWorkspaceDeletes as string[];
  assert.equal(deletes.filter(value => value.endsWith('/ui-1')).length, 1);
  assert.equal(result.actualDeletes.filter(id => id === 'ui-1').length, 1); assert.equal(result.fetchRestored, true);
});
test('B2 validation catches default core global-fetch DELETE during quota failure', async () => { const result = await run({ quotaDelete: true }); assert.ok(result.failure); assert.equal(result.fetchRestored, true); });
test('B2 validation aggregates attachment failure with original body error', async () => {
  const result = await run({ bodyFails: true, cleanupFails: true, attachFails: true }); assert.ok(result.failure instanceof AggregateError);
  assert.ok(result.failure.errors.includes(result.bodyError)); assert.ok(result.failure.errors.includes(result.cleanupError)); assert.ok(result.failure.errors.includes(result.attachmentError)); assert.equal(result.fetchRestored, true);
});
test('B2 validation final absence check detects a leaked successful UI ID', async () => { const result = await run({ leakUi: true }); assert.ok(result.failure); });
test('B2 validation rejects capacity50 empty-state creation budget before UI/API creation', async () => { const result = await run({ capacity: 50 }); assert.ok(result.failure); assert.equal(result.clicks, 0); assert.equal(result.postCount, 0); });
