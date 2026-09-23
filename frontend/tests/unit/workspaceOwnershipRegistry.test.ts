import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import * as guard from '../e2e/workspaceLeakGuard.ts';

// #57 removed the E2E password fallback. These tests never reach a real login -- they stub
// fetch -- but the leak guard reads the password before calling it, so the process needs one.
process.env.BUILDERGATE_PASSWORD ??= 'test-only-password';

// REL-BGSTAB-001 / B2: actual guard exports, isolated fetch and real Temp files.
type Options = { registryPath: string; runId: string; baseUrl: string; fetch: typeof fetch };
type Proof = { url: string; method: string; status: number; body: unknown };
type Result = { deleted: string[]; absent: string[]; failed: { workspaceId: string; reason: string }[] };
type Core = {
  recordWorkspaceBaseline(options: Options): Promise<void>;
  registerWorkspaceCreation(options: Options & { ownerId: string; proof: Proof }): Promise<{ workspaceId: string; registered: boolean }>;
  cleanupOwnedWorkspaces(options: Options & { ownerId?: string }): Promise<Result>;
  deleteOwnedWorkspace(options: Options & { ownerId: string; workspaceId: string }): Promise<Result>;
  removeWorkspacesCreatedDuringRun(options: Options): Promise<void>;
};
function core(): Core {
  // Must precede setup: the old hook ignores options and must never reach real fetch.
  for (const name of ['registerWorkspaceCreation', 'cleanupOwnedWorkspaces']) {
    assert.equal(typeof Reflect.get(guard, name), 'function', `actual guard export ${name} required`);
  }
  return guard as unknown as Core;
}
const baseUrl = 'https://localhost:2222';
const proof = (id: string): Proof => ({ url: baseUrl + '/api/workspaces', method: 'POST', status: 201, body: { id, name: 'same E2E-looking name' } });
const recordPath = (root: string, id: string) => join(root, 'records', createHash('sha256').update(id).digest('hex') + '.json');
async function fixture(run: (api: Core, options: Options, state: {
  ids: Set<string>; deletes: string[]; login: number; list: number; malformedList: boolean;
  deleteStatus: Map<string, number>; throwDelete: Set<string>;
}) => Promise<void>) {
  const api = core();
  const parent = await mkdtemp(join(tmpdir(), 'buildergate-owned-registry-'));
  const state = { ids: new Set(['user-before', 'user-during', 'owned-x', 'owned-y']), deletes: [] as string[], login: 200, list: 200, malformedList: false, deleteStatus: new Map<string, number>(), throwDelete: new Set<string>() };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    assert.equal(url.origin, baseUrl);
    if (url.pathname === '/api/auth/login' && method === 'POST') return Response.json({ token: 'test-token' }, { status: state.login });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    if (url.pathname === '/api/workspaces' && method === 'GET') return Response.json(state.malformedList ? { workspaces: null } : { workspaces: [...state.ids].map(id => ({ id, name: 'same E2E-looking name' })) }, { status: state.list });
    assert.equal(method, 'DELETE'); assert.ok(url.pathname.startsWith('/api/workspaces/'));
    const id = decodeURIComponent(url.pathname.slice('/api/workspaces/'.length)); state.deletes.push(id);
    if (state.throwDelete.has(id)) throw Error('controlled DELETE transport failure');
    const status = state.deleteStatus.get(id) ?? 200;
    if (status === 200 || status === 404) state.ids.delete(id);
    return Response.json({}, { status });
  };
  const options = { registryPath: join(parent, 'run'), runId: randomUUID(), baseUrl, fetch: fakeFetch };
  try { await api.recordWorkspaceBaseline(options); await run(api, options, state); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
const register = (api: Core, o: Options, id: string, ownerId = 'owner-x') => api.registerWorkspaceCreation({ ...o, ownerId, proof: proof(id) });

function deleteOne(api: Core, options: unknown): Promise<Result> {
  const method = Reflect.get(api, 'deleteOwnedWorkspace');
  assert.equal(typeof method, 'function', 'B2 explicit deletion requires the dedicated single-ID export');
  return Reflect.apply(method, api, [options]) as Promise<Result>;
}

test('REL001 explicit owned deletion removes only one workspace even when an owner has siblings', async () => {
  await fixture(async (api, o, state) => {
    await register(api, o, 'owned-x'); await register(api, o, 'owned-y');
    assert.deepEqual(await deleteOne(api, { ...o, ownerId: 'owner-x', workspaceId: 'owned-x' }), {
      deleted: ['owned-x'], absent: [], failed: [],
    });
    assert.deepEqual(state.deletes, ['owned-x']);
    assert.ok(state.ids.has('owned-y'));
    assert.equal(JSON.parse(await readFile(recordPath(o.registryPath, 'owned-y'), 'utf8')).ownerId, 'owner-x');
    await assert.rejects(readFile(recordPath(o.registryPath, 'owned-x')), { code: 'ENOENT' });
  });
});

test('REL001 explicit deletion refuses unowned and other-owner IDs without deleting any workspace', async () => {
  await fixture(async (api, o, state) => {
    await register(api, o, 'owned-x'); await register(api, o, 'owned-y', 'owner-y');
    // Assert export presence before assert.rejects so its absence cannot pass as ownership rejection.
    assert.equal(typeof Reflect.get(api, 'deleteOwnedWorkspace'), 'function');
    for (const workspaceId of ['user-before', 'user-during', 'owned-y', 'unknown-id']) {
      await assert.rejects(deleteOne(api, { ...o, ownerId: 'owner-x', workspaceId }));
    }
    assert.deepEqual(state.deletes, []);
    for (const id of ['owned-x', 'owned-y']) assert.equal(JSON.parse(await readFile(recordPath(o.registryPath, id), 'utf8')).workspaceId, id);
  });
});

test('REL001 explicit deletion rejects missing or invalid target and owner instead of sweeping the owner', async () => {
  await fixture(async (api, o, state) => {
    await register(api, o, 'owned-x'); await register(api, o, 'owned-y');
    assert.equal(typeof Reflect.get(api, 'deleteOwnedWorkspace'), 'function');
    const valid = { ...o, ownerId: 'owner-x', workspaceId: 'owned-x' };
    for (const invalid of [
      ...[undefined, null, '', ' ', 5].map(workspaceId => ({ ...valid, workspaceId })),
      ...[undefined, null, '', ' ', 5].map(ownerId => ({ ...valid, ownerId })),
      { ...o, ownerId: 'owner-x' }, { ...o, workspaceId: 'owned-x' },
    ]) await assert.rejects(deleteOne(api, invalid));
    assert.deepEqual(state.deletes, []);
    assert.equal((await readdir(join(o.registryPath, 'records'))).length, 2);
    assert.ok(state.ids.has('owned-x') && state.ids.has('owned-y'));
  });
});

test('REL001 ownership registry uses successful direct POST response IDs and rejects invalid proofs', async () => {
  await fixture(async (api, o) => {
    assert.deepEqual(await register(api, o, 'owned-x'), { workspaceId: 'owned-x', registered: true });
    for (const invalid of [
      { ...proof('bad'), status: 409 }, { ...proof('bad'), status: 500 }, { ...proof('bad'), status: 200 },
      { ...proof('bad'), method: 'GET' }, { ...proof('bad'), url: 'https://foreign.invalid/api/workspaces' },
      { ...proof('bad'), url: baseUrl + '/api/workspaces/other' }, { ...proof('bad'), body: { workspace: { id: 'bad' } } },
      { ...proof('bad'), body: { id: '' } }, { ...proof('bad'), body: null },
    ]) await assert.rejects(api.registerWorkspaceCreation({ ...o, ownerId: 'owner-x', proof: invalid }));
    assert.equal((await readdir(join(o.registryPath, 'records'))).filter(x => x.endsWith('.json')).length, 1);
  });
});

test('REL001 owner cleanup preserves concurrent user and sibling; global teardown consumes only remaining proven IDs', async () => {
  await fixture(async (api, o, state) => {
    await register(api, o, 'owned-x'); await register(api, o, 'owned-y', 'owner-y');
    assert.deepEqual(await api.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner-x' }), { deleted: ['owned-x'], absent: [], failed: [] });
    assert.deepEqual(state.deletes, ['owned-x']); assert.ok(state.ids.has('owned-y')); assert.ok(state.ids.has('user-during'));
    await api.removeWorkspacesCreatedDuringRun(o);
    assert.deepEqual(state.deletes, ['owned-x', 'owned-y']);
    assert.deepEqual([...state.ids].sort(), ['user-before', 'user-during']);
  });
});

test('REL001 duplicate registration is idempotent and owner conflict cannot reassign cleanup authority', async () => {
  await fixture(async (api, o, state) => {
    await register(api, o, 'owned-x');
    assert.deepEqual(await register(api, o, 'owned-x'), { workspaceId: 'owned-x', registered: false });
    await assert.rejects(register(api, o, 'owned-x', 'owner-y'));
    assert.deepEqual(await api.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner-y' }), { deleted: [], absent: [], failed: [] });
    assert.deepEqual(state.deletes, []);
    assert.equal(JSON.parse(await readFile(recordPath(o.registryPath, 'owned-x'), 'utf8')).ownerId, 'owner-x');
  });
});

test('REL001 independent process writers publish complete per-ID records without losing concurrent registrations', async () => {
  await fixture(async (api, o, state) => {
    const moduleUrl = new URL('../e2e/workspaceLeakGuard.ts', import.meta.url).href;
    const write = (id: string) => new Promise<void>((resolve, reject) => {
      const args = { registryPath: o.registryPath, runId: o.runId, baseUrl, ownerId: 'owner-x', proof: proof(id) };
      const code = `import {registerWorkspaceCreation} from ${JSON.stringify(moduleUrl)}; globalThis.fetch=()=>{throw Error('network forbidden in writer')}; await registerWorkspaceCreation(${JSON.stringify(args)});`;
      const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
      child.once('error', reject); child.once('close', (exit, signal) => exit === 0 && signal === null ? resolve() : reject(Error(`writer failed ${exit}/${signal}: ${stderr}`)));
    });
    const ids = ['owned-x', 'owned-y', 'owned-z']; state.ids.add('owned-z');
    await Promise.all([...ids, ...ids, ...ids].map(write));
    for (const id of ids) assert.deepEqual(JSON.parse(await readFile(recordPath(o.registryPath, id), 'utf8')), { runId: o.runId, ownerId: 'owner-x', workspaceId: id });
    assert.equal((await readdir(join(o.registryPath, 'records'))).length, 3, 'publication leaves neither lost records nor pending files');
    const result = await api.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner-x' });
    assert.deepEqual(result.deleted.sort(), ids.sort()); assert.deepEqual(result.failed, []);
  });
});

for (const failure of ['auth', 'list', 'malformed-list', 'corrupt-record', 'partial-publication', 'wrong-run'] as const) {
  test(`REL001 ${failure} fails closed before any workspace DELETE and preserves evidence`, async () => {
    await fixture(async (api, o, state) => {
      await register(api, o, 'owned-x');
      if (failure === 'auth') state.login = 401;
      if (failure === 'list') state.list = 503;
      if (failure === 'malformed-list') state.malformedList = true;
      if (failure === 'corrupt-record') await writeFile(recordPath(o.registryPath, 'owned-x'), '{broken', 'utf8');
      if (failure === 'partial-publication') await writeFile(join(o.registryPath, 'records', '.pending-interrupted'), '{', 'utf8');
      const before = await readFile(recordPath(o.registryPath, 'owned-x'), 'utf8');
      await assert.rejects(api.cleanupOwnedWorkspaces({ ...o, runId: failure === 'wrong-run' ? 'different-run' : o.runId }));
      assert.deepEqual(state.deletes, []); assert.equal(await readFile(recordPath(o.registryPath, 'owned-x'), 'utf8'), before);
    });
  });
}

test('REL001 DELETE errors retain failed IDs; 404 is absent and never counted as a deletion', async () => {
  await fixture(async (api, o, state) => {
    for (const id of ['owned-x', 'owned-y', 'owned-z']) { state.ids.add(id); await register(api, o, id); }
    state.deleteStatus.set('owned-x', 503); state.throwDelete.add('owned-y'); state.deleteStatus.set('owned-z', 404);
    const result = await api.cleanupOwnedWorkspaces(o);
    assert.deepEqual(result.deleted, []); assert.deepEqual(result.absent, ['owned-z']);
    assert.deepEqual(result.failed.map(x => x.workspaceId).sort(), ['owned-x', 'owned-y']);
    assert.ok(result.failed.every(x => typeof x.reason === 'string' && x.reason.length > 0));
    for (const id of ['owned-x', 'owned-y']) assert.equal(JSON.parse(await readFile(recordPath(o.registryPath, id), 'utf8')).workspaceId, id);
    await assert.rejects(readFile(recordPath(o.registryPath, 'owned-z')), { code: 'ENOENT' });
    await assert.rejects(api.removeWorkspacesCreatedDuringRun(o), 'global wrapper must expose unresolved cleanup');
    state.deleteStatus.clear(); state.throwDelete.clear();
    assert.deepEqual((await api.cleanupOwnedWorkspaces(o)).deleted.sort(), ['owned-x', 'owned-y']);
  });
});

test('REL001 setup rejects authentication and list failures without publishing an empty ownership registry', async () => {
  const api = core(); const parent = await mkdtemp(join(tmpdir(), 'buildergate-owned-setup-'));
  try {
    for (const failure of ['auth', 'list']) {
      const registryPath = join(parent, failure); const calls: string[] = [];
      const controlled: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); calls.push(init?.method ?? 'GET');
        if (url.pathname.endsWith('/login')) return Response.json({ token: 'test-token' }, { status: failure === 'auth' ? 401 : 200 });
        return Response.json({}, { status: 503 });
      };
      await assert.rejects(api.recordWorkspaceBaseline({ registryPath, runId: randomUUID(), baseUrl, fetch: controlled }));
      assert.ok(!calls.includes('DELETE'));
      await assert.rejects(readFile(join(registryPath, 'run.json')), { code: 'ENOENT' });
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('REL001 explicit null setup rejects before fetch or registry creation', async () => {
  const api = core();
  const parent = await mkdtemp(join(tmpdir(), 'buildergate-owned-null-'));
  const envKeys = ['BUILDERGATE_E2E_OWNERSHIP_ROOT', 'BUILDERGATE_E2E_BASELINE',
    'BUILDERGATE_E2E_RUN_DIR', 'BUILDERGATE_E2E_RUN_ID', 'PLAYWRIGHT_BASE_URL', 'NODE_TLS_REJECT_UNAUTHORIZED'];
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    process.env.BUILDERGATE_E2E_OWNERSHIP_ROOT = parent;
    process.env.BUILDERGATE_E2E_BASELINE = join(parent, 'legacy-baseline.json');
    delete process.env.BUILDERGATE_E2E_RUN_DIR;
    delete process.env.BUILDERGATE_E2E_RUN_ID;
    process.env.PLAYWRIGHT_BASE_URL = baseUrl;
    globalThis.fetch = async input => {
      fetchCalls += 1;
      const url = new URL(String(input));
      assert.equal(url.origin, baseUrl);
      return Response.json(url.pathname.endsWith('/login') ? { token: 'test-token' } : { workspaces: [] });
    };
    const rejected = await Reflect.apply(api.recordWorkspaceBaseline, undefined, [null])
      .then(() => false, (error: unknown) => error instanceof Error);
    assert.deepEqual({ rejected, fetchCalls, files: await readdir(parent) }, {
      rejected: true, fetchCalls: 0, files: [],
    }, 'explicit invalid input must not become default global setup');
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test('REL001 overlapping owner cleanup keeps TLS override until the last operation finishes', async () => {
  await fixture(async (api, o) => {
    await register(api, o, 'owned-x', 'owner-a');
    await register(api, o, 'owned-y', 'owner-b');
    function loginBarrier() {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const releasedPromise = new Promise<void>(resolve => { release = resolve; });
      const fetch: typeof globalThis.fetch = async (input, init) => {
        if (new URL(String(input)).pathname === '/api/auth/login') {
          entered();
          await releasedPromise;
        }
        return o.fetch(input, init);
      };
      return { enteredPromise, release, fetch };
    }
    const a = loginBarrier(); const b = loginBarrier();
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    let first: Promise<Result> | undefined; let second: Promise<Result> | undefined;
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
      first = api.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner-a', fetch: a.fetch });
      await a.enteredPromise;
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
      second = api.cleanupOwnedWorkspaces({ ...o, ownerId: 'owner-b', fetch: b.fetch });
      await b.enteredPromise;
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
      a.release();
      assert.deepEqual((await first).deleted, ['owned-x']);
      const whileSecondActive = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      b.release();
      assert.deepEqual((await second).deleted, ['owned-y']);
      assert.deepEqual({ whileSecondActive, afterBoth: process.env.NODE_TLS_REJECT_UNAUTHORIZED }, {
        whileSecondActive: '0', afterBoth: '1',
      }, 'one owner finishing must not undo another owner\'s active TLS scope');
    } finally {
      a.release(); b.release();
      await Promise.allSettled([first, second].filter((operation): operation is Promise<Result> => operation !== undefined));
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    }
  });
});
