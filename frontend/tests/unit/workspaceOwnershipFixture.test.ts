import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import * as core from '../e2e/workspaceLeakGuard.ts';

// REL-BGSTAB-001: transpile and execute the entire actual thin fixture module.
// Only Playwright registration/context/network ports are inert; core and FS are real.
const modulePath = new URL('../e2e/workspaceOwnershipFixture.ts', import.meta.url);
const baseUrl = 'https://localhost:2222';
type Registry = core.RegistryOptions;
type Tracker = { drain(): Promise<void>; cleanup(): Promise<core.WorkspaceCleanupResult>; deleteWorkspace(id: string): Promise<core.WorkspaceCleanupResult>; dispose(): Promise<void> };
type RequestPort = { url(): string; method(): string; failure(): { errorText: string } | null };
type ResponsePort = { url(): string; status(): number; json(): Promise<unknown>; request(): RequestPort; fromServiceWorker(): boolean; serverAddr(): Promise<{ ipAddress: string; port: number } | null> };
type Exports = {
  attachWorkspaceOwnership(context: EventEmitter, registry: Registry, owner: string): Tracker;
  deleteOwnedWorkspaceForContext(context: EventEmitter, id: string): Promise<core.WorkspaceCleanupResult>;
  createOwnedWorkspaceViaApi(request: { post(url: string, options: unknown): Promise<Pick<ResponsePort, 'url' | 'status' | 'json'>> }, registry: Registry, owner: string, data: Record<string, unknown>): Promise<{ id: string }>;
};
type FixtureCallback = (args: { context: EventEmitter }, use: (value: unknown) => Promise<void>, info: { testId: string; retry: number; workerIndex: number }) => Promise<void>;
function load(register = core.registerWorkspaceCreation) {
  const source = readFileSync(modulePath, 'utf8');
  let captured: Record<string, unknown> | undefined;
  const base = { extend(definitions: Record<string, unknown>) { captured = definitions; return {}; } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const nativeRequire = createRequire(modulePath);
  new Function('require', 'module', 'exports', '__filename', '__dirname', compiled)((id: string) => {
    if (id === '@playwright/test') return { test: base, expect: {} };
    if (/workspaceLeakGuard(?:\.ts|\.js)?$/.test(id)) return { ...core, registerWorkspaceCreation: register };
    if (id === '../../../server/src/utils/bootstrapAccessPolicy.ts') return nativeRequire(id);
    assert.ok(id.startsWith('node:'), `unexpected fixture dependency ${id}`);
    return nativeRequire(id);
  }, module, module.exports, modulePath.pathname, new URL('.', modulePath).pathname);
  const api = module.exports as Exports;
  assert.equal(typeof api.attachWorkspaceOwnership, 'function');
  assert.equal(typeof api.createOwnedWorkspaceViaApi, 'function');
  return { api, captured };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function exchange(id: string, changes: Partial<ResponsePort> = {}, requestChanges: Partial<RequestPort> = {}) {
  const request: RequestPort = { url: () => baseUrl + '/api/workspaces', method: () => 'POST', failure: () => null, ...requestChanges };
  const response: ResponsePort = { url: request.url, status: () => 201, json: async () => ({ id }), request: () => request, fromServiceWorker: () => false, serverAddr: async () => ({ ipAddress: '127.0.0.1', port: 2222 }), ...changes };
  return { request, response };
}
function emit(context: EventEmitter, pair: ReturnType<typeof exchange>) {
  context.emit('request', pair.request); context.emit('response', pair.response); context.emit('requestfinished', pair.request);
}
async function setup(run: (o: Registry, state: { ids: Set<string>; deletes: string[]; deleteStatus: number }) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), 'buildergate-fixture-unit-'));
  const state = { ids: new Set(['user', 'x', 'y', 'z']), deletes: [] as string[], deleteStatus: 200 };
  const fake: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/auth/login') return Response.json({ token: 'unit-token' });
    if (init?.method !== 'DELETE') return Response.json({ workspaces: [...state.ids].map(id => ({ id })) });
    const id = path.slice('/api/workspaces/'.length); state.deletes.push(id);
    if (state.deleteStatus === 200) state.ids.delete(id);
    return Response.json({}, { status: state.deleteStatus });
  };
  const o = { registryPath: join(parent, 'run'), runId: randomUUID(), baseUrl, fetch: fake };
  try { await core.recordWorkspaceBaseline(o); await run(o, state); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test('REL001 actual fixture tracks UI and page-fetch responses and isolates sibling contexts/retries', async () => {
  const { api } = load();
  await setup(async (o, state) => {
    const a = new EventEmitter(), b = new EventEmitter(), retry = new EventEmitter();
    const ta = api.attachWorkspaceOwnership(a, o, 'test-a/context-1/retry-0');
    const tb = api.attachWorkspaceOwnership(b, o, 'test-b/context-1/retry-0');
    const tr = api.attachWorkspaceOwnership(retry, o, 'test-a/context-1/retry-1');
    emit(a, exchange('x')); emit(b, exchange('y')); emit(retry, exchange('z'));
    await Promise.all([ta.drain(), tb.drain(), tr.drain()]);
    assert.deepEqual((await ta.cleanup()).deleted, ['x']); assert.deepEqual(state.deletes, ['x']);
    assert.ok(state.ids.has('user') && state.ids.has('y') && state.ids.has('z'));
    await tb.cleanup(); await tr.cleanup(); await Promise.all([ta.dispose(), tb.dispose(), tr.dispose()]);
    assert.deepEqual([...state.ids], ['user']);
  });
});

test('REL001 unrelated origin method and path cannot be adopted by live observer', async () => {
  const { api } = load();
  await setup(async (o, state) => {
    const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
    for (const changes of [{ url: () => 'https://foreign.invalid/api/workspaces' }, { method: () => 'GET' }, { url: () => baseUrl + '/api/workspaces/x/tabs' }]) emit(context, exchange('x', {}, changes));
    await tracker.drain(); await tracker.cleanup(); await tracker.dispose(); assert.deepEqual(state.deletes, []);
  });
});

for (const kind of ['failed', 'malformed', 'service-worker', 'route-fulfilled', 'non-loopback', 'wrong-port'] as const) {
  test(`REL001 matching ${kind} response never owns and remains observable`, async () => {
    const { api } = load();
    await setup(async (o, state) => {
      const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
      const changes: Partial<ResponsePort> = kind === 'failed' ? { status: () => 409 } : kind === 'malformed' ? { json: async () => ({ workspace: { id: 'x' } }) } : kind === 'service-worker' ? { fromServiceWorker: () => true } : kind === 'non-loopback' ? { serverAddr: async () => ({ ipAddress: '192.0.2.1', port: 2222 }) } : kind === 'wrong-port' ? { serverAddr: async () => ({ ipAddress: '127.0.0.1', port: 3333 }) } : { serverAddr: async () => null };
      emit(context, exchange('x', changes));
      await assert.rejects(tracker.drain()); await assert.rejects(tracker.cleanup());
      assert.deepEqual(state.deletes, []); assert.deepEqual(await readdir(join(o.registryPath, 'records')), []);
      await tracker.dispose().catch(() => undefined);
      for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) assert.equal(context.listenerCount(event), 0);
    });
  });
}

// REL-BGSTAB-001 AC-4: Chromium reports an IPv6 peer through CDP as the bracketed
// literal '[::1]', while isLoopbackIp() is written for Node's socket.remoteAddress,
// which is bare '::1'. The live 2222 runtime binds dual-stack and the browser reaches
// it over ::1, so without normalising the bracket form the fixture rejects genuine
// loopback traffic as unproven and no UI creation is ever owned.
for (const ipAddress of ['[::1]', '::1', '::ffff:127.0.0.1', '127.0.0.1'] as const) {
  test(`REL001 bracketed and bare loopback peer ${ipAddress} proves live traffic`, async () => {
    const { api } = load();
    await setup(async (o, state) => {
      const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
      emit(context, exchange('x', { serverAddr: async () => ({ ipAddress, port: 2222 }) }));
      await tracker.drain();
      assert.deepEqual(await readdir(join(o.registryPath, 'records')), [createHash('sha256').update('x').digest('hex') + '.json']);
      assert.deepEqual((await tracker.cleanup()).deleted, ['x']);
      assert.deepEqual(state.deletes, ['x']);
      await tracker.dispose();
    });
  });
}

// Bracket stripping must not widen the accepted set beyond loopback.
for (const ipAddress of ['[2001:db8::1]', '[::ffff:192.0.2.1]', '[]', '[::1', '::1]'] as const) {
  test(`REL001 bracketed non-loopback peer ${ipAddress} never owns`, async () => {
    const { api } = load();
    await setup(async (o, state) => {
      const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
      emit(context, exchange('x', { serverAddr: async () => ({ ipAddress, port: 2222 }) }));
      await assert.rejects(tracker.drain()); await assert.rejects(tracker.cleanup());
      assert.deepEqual(state.deletes, []); assert.deepEqual(await readdir(join(o.registryPath, 'records')), []);
      await tracker.dispose().catch(() => undefined);
    });
  });
}

test('REL001 cleanup and dispose await in-flight request response body and actual registry publication', async () => {
  const write = deferred<void>(); const entered = deferred<void>();
  const { api } = load(async options => { entered.resolve(); await write.promise; return core.registerWorkspaceCreation(options); });
  await setup(async (o, state) => {
    const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
    const body = deferred<unknown>(); const pair = exchange('x', { json: () => body.promise });
    context.emit('request', pair.request);
    let finished = false; const cleaning = tracker.cleanup().then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.deepEqual(state.deletes, []);
    context.emit('response', pair.response); context.emit('requestfinished', pair.request);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    body.resolve({ id: 'x' }); await entered.promise;
    let disposed = false; const disposing = tracker.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false); assert.deepEqual(state.deletes, []);
    write.resolve(); assert.deepEqual((await cleaning).deleted, ['x']); await disposing;
    assert.equal(disposed, true); assert.deepEqual(state.deletes, ['x']);
  });
});

test('REL001 request failure is observable and never turns unknown creation into an owned ID', async () => {
  const { api } = load();
  await setup(async (o, state) => {
    const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
    const pair = exchange('x', {}, { failure: () => ({ errorText: 'connection reset' }) });
    context.emit('request', pair.request); context.emit('requestfailed', pair.request);
    await assert.rejects(tracker.drain()); await assert.rejects(tracker.cleanup()); assert.deepEqual(state.deletes, []);
    await tracker.dispose().catch(() => undefined);
  });
});

test('REL001 actual API adapter publishes POST ID before returning and subsequent tab failure retains cleanup ownership', async () => {
  const write = deferred<void>(); const entered = deferred<void>();
  const { api } = load(async options => { entered.resolve(); await write.promise; return core.registerWorkspaceCreation(options); });
  await setup(async (o, state) => {
    const sent: unknown[] = []; let returned = false;
    const request = { post: async (url: string, options: unknown) => { sent.push([url, options]); return exchange('x').response; } };
    const options = { data: { name: 'test' }, headers: { Authorization: 'Bearer explicit-test-token' }, timeout: 7000 };
    const creation = api.createOwnedWorkspaceViaApi(request, o, 'owner', options).then(value => { returned = true; return value; });
    await entered.promise; assert.equal(returned, false); write.resolve(); assert.equal((await creation).id, 'x');
    assert.deepEqual(sent, [[baseUrl + '/api/workspaces', options]]);
    assert.equal((sent[0] as unknown[])[1], options, 'all caller POST options retain identity and auth headers');
    await assert.rejects(Promise.reject(Error('controlled later tab setup failure')));
    assert.deepEqual((await core.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner' })).deleted, ['x']); assert.deepEqual(state.deletes, ['x']);
  });
});

test('REL001 API adapter rejects quota failure without adopting list IDs or evicting user workspaces', async () => {
  const { api } = load();
  await setup(async (o, state) => {
    const request = { post: async () => exchange('user', { status: () => 409 }).response };
    await assert.rejects(api.createOwnedWorkspaceViaApi(request, o, 'owner', { name: 'same' }));
    assert.deepEqual((await core.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner' })).deleted, []); assert.deepEqual(state.deletes, []);
  });
});

test('REL001 API adapter validates registry run and owner before any POST', async () => {
  const { api } = load();
  await setup(async (o) => {
    const before = await readdir(join(o.registryPath, 'records'));
    const cases = [
      { registry: { ...o, baseUrl: 'https://foreign.invalid' }, owner: 'owner' },
      { registry: { ...o, registryPath: '' }, owner: 'owner' },
      { registry: { ...o, runId: 'different-run' }, owner: 'owner' },
      { registry: o, owner: '' },
    ];
    for (const item of cases) {
      let posts = 0;
      const request = { post: async () => { posts += 1; return exchange('x').response; } };
      await assert.rejects(api.createOwnedWorkspaceViaApi(request, item.registry, item.owner, { data: { name: 'test' } }));
      assert.equal(posts, 0, 'invalid ownership cannot initiate even a controlled workspace POST');
      assert.deepEqual(await readdir(join(o.registryPath, 'records')), before);
    }
  });
});

test('REL001 automatic fixture rejects mismatched run metadata before user test execution', async () => {
  const { captured } = load(); assert.ok(captured);
  const definition = captured.workspaceOwnership; assert.ok(Array.isArray(definition));
  const callback = definition[0] as FixtureCallback;
  await setup(async (o, state) => {
    const keys = ['BUILDERGATE_E2E_RUN_DIR', 'BUILDERGATE_E2E_RUN_ID', 'PLAYWRIGHT_BASE_URL'];
    const previous = keys.map(key => process.env[key]);
    process.env.BUILDERGATE_E2E_RUN_DIR = o.registryPath; process.env.BUILDERGATE_E2E_RUN_ID = 'mismatched-run'; process.env.PLAYWRIGHT_BASE_URL = baseUrl;
    const context = new EventEmitter(); let used = false;
    try {
      await assert.rejects(callback({ context }, async () => { used = true; }, { testId: 'invalid-run', retry: 0, workerIndex: 0 }));
      assert.equal(used, false, 'test/UI creation must not begin with invalid persisted ownership');
      assert.deepEqual(state.deletes, []); assert.deepEqual(await readdir(join(o.registryPath, 'records')), []);
      for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) assert.equal(context.listenerCount(event), 0);
    } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
  });
});

test('REL001 captured actual base.extend auto fixture installs before use and cleans/disposes after failed test body', async () => {
  const { captured } = load(); assert.ok(captured);
  const definition = captured.workspaceOwnership;
  assert.ok(Array.isArray(definition)); assert.equal((definition[1] as { auto?: boolean }).auto, true);
  const callback = definition[0] as FixtureCallback; assert.equal(typeof callback, 'function');
  await setup(async (o, state) => {
    const keys = ['BUILDERGATE_E2E_RUN_DIR', 'BUILDERGATE_E2E_RUN_ID', 'PLAYWRIGHT_BASE_URL'];
    const previous = keys.map(key => process.env[key]); const originalFetch = globalThis.fetch;
    process.env.BUILDERGATE_E2E_RUN_DIR = o.registryPath; process.env.BUILDERGATE_E2E_RUN_ID = o.runId; process.env.PLAYWRIGHT_BASE_URL = baseUrl; globalThis.fetch = o.fetch!;
    const context = new EventEmitter(); const failure = Error('test body failed');
    try {
      await assert.rejects(callback({ context }, async () => {
        assert.ok(context.listenerCount('request') > 0); assert.ok(context.listenerCount('response') > 0);
        emit(context, exchange('x')); throw failure;
      }, { testId: 'a', retry: 0, workerIndex: 0 }), error => error === failure);
      assert.deepEqual(state.deletes, ['x']); assert.ok(state.ids.has('user'));
      for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) assert.equal(context.listenerCount(event), 0);
    } finally { globalThis.fetch = originalFetch; keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
  });
});

test('REL001 mock-only workspace specs remain on base fixture and cannot collect synthetic ownership', () => {
  for (const file of ['auth-bootstrap.spec.ts', 'settings-password-policy.spec.ts', 'settings-resource-limits.spec.ts']) {
    const source = readFileSync(new URL('../e2e/' + file, import.meta.url), 'utf8');
    assert.ok(source.includes('@playwright/test')); assert.ok(!source.includes('workspaceOwnershipFixture'));
  }
});

test('REL001 IPv6 loopback response is live and selected deletion preserves another workspace of the same owner', async () => {
  const { api } = load();
  await setup(async (o, state) => {
    const context = new EventEmitter(); const tracker = api.attachWorkspaceOwnership(context, o, 'owner');
    emit(context, exchange('x', { serverAddr: async () => ({ ipAddress: '::1', port: 2222 }) }));
    emit(context, exchange('y')); await tracker.drain();
    assert.deepEqual((await tracker.deleteWorkspace('x')).deleted, ['x']);
    assert.deepEqual(state.deletes, ['x']); assert.ok(state.ids.has('y'));
    assert.equal((await readdir(join(o.registryPath, 'records'))).length, 1);
    await assert.rejects(tracker.deleteWorkspace('user')); assert.deepEqual(state.deletes, ['x']);
    assert.deepEqual((await api.deleteOwnedWorkspaceForContext(context, 'y')).deleted, ['y']);
    await assert.rejects(api.deleteOwnedWorkspaceForContext(new EventEmitter(), 'user'));
    await tracker.dispose();
  });
});

for (const bodyFails of [false, true]) {
  test(`REL001 automatic fixture exposes cleanup503 with body failure ${bodyFails} and retains records`, async () => {
    const { captured } = load(); assert.ok(captured);
    const definition = captured.workspaceOwnership; assert.ok(Array.isArray(definition));
    const callback = definition[0] as FixtureCallback;
    await setup(async (o, state) => {
      const keys = ['BUILDERGATE_E2E_RUN_DIR', 'BUILDERGATE_E2E_RUN_ID', 'PLAYWRIGHT_BASE_URL'];
      const previous = keys.map(key => process.env[key]); const originalFetch = globalThis.fetch;
      process.env.BUILDERGATE_E2E_RUN_DIR = o.registryPath; process.env.BUILDERGATE_E2E_RUN_ID = o.runId; process.env.PLAYWRIGHT_BASE_URL = baseUrl; globalThis.fetch = o.fetch!;
      state.deleteStatus = 503; const context = new EventEmitter(); const bodyError = Error('distinct body failure');
      try {
        await assert.rejects(callback({ context }, async () => {
          emit(context, exchange('x')); if (bodyFails) throw bodyError;
        }, { testId: 'cleanup-test', retry: 0, workerIndex: 0 }), error => {
          if (bodyFails) {
            assert.ok(error instanceof AggregateError, 'both test body and cleanup failure must survive');
            assert.ok(error.errors.includes(bodyError));
            assert.ok(error.errors.some(item => item !== bodyError && /503|cleanup|delete/i.test(String(item))));
          } else assert.match(String(error), /503|cleanup|delete/i);
          return true;
        });
        assert.deepEqual(state.deletes, ['x']); assert.ok(state.ids.has('x'));
        assert.equal((await readdir(join(o.registryPath, 'records'))).length, 1);
        for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) assert.equal(context.listenerCount(event), 0);
      } finally { globalThis.fetch = originalFetch; keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
    });
  });
}
