import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

// REL-BGSTAB-001 / B2: after-minus-before and name similarity do not establish
// ownership. These replace the old selector tests that endorsed deleting any
// newly observed workspace, including one created concurrently by a user.
// Execute the real setup/teardown exports; every fetch is an isolated fake.
async function withGuard(
  respond: (method: string, path: string) => Response,
  run: (guard: typeof import('../e2e/workspaceLeakGuard.ts'), deletes: string[]) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-b2-setup-test-'));
  const keys = ['BUILDERGATE_E2E_BASELINE', 'BUILDERGATE_E2E_OWNERSHIP_ROOT',
    'PLAYWRIGHT_BASE_URL', 'BUILDERGATE_PASSWORD', 'NODE_TLS_REJECT_UNAUTHORIZED'] as const;
  const original = new Map(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const deletes: string[] = [];
  try {
    process.env.BUILDERGATE_E2E_BASELINE = join(directory, 'legacy-baseline.json');
    process.env.BUILDERGATE_E2E_OWNERSHIP_ROOT = join(directory, 'ownership');
    process.env.PLAYWRIGHT_BASE_URL = 'https://localhost:2222';
    process.env.BUILDERGATE_PASSWORD = 'test-only-password';
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.origin, 'https://localhost:2222', 'no foreign origin is permitted in this fake transport');
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'DELETE') deletes.push(url.pathname);
      return respond(method, url.pathname);
    };
    // BASELINE_PATH is captured during module evaluation; each test gets a new
    // instance only after its two storage paths and fake transport are installed.
    const url = new URL('../e2e/workspaceLeakGuard.ts', import.meta.url);
    url.searchParams.set('b2-isolation', randomUUID());
    const guard = await import(url.href) as typeof import('../e2e/workspaceLeakGuard.ts');
    assert.equal(typeof guard.recordWorkspaceBaseline, 'function');
    assert.equal(typeof guard.removeWorkspacesCreatedDuringRun, 'function');
    await run(guard, deletes);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const existing = { id: 'user-before', name: 'Main' };
const concurrent = { id: 'user-during', name: 'PW-IME-looks-like-a-test' };

// No successful POST is observed by any case: no workspace is test-owned.
test('B2 actual teardown never deletes a concurrent user workspace after successful setup', async () => {
  let phase = 'setup';
  await withGuard((method, path) => {
    if (method === 'POST' && path === '/api/auth/login') return json({ token: 'fake-token' });
    if (method === 'GET' && path === '/api/workspaces') return json({ workspaces: phase === 'setup' ? [existing] : [existing, concurrent] });
    if (method === 'DELETE' && path.startsWith('/api/workspaces/')) return new Response(null, { status: 204 });
    return assert.fail(`unexpected fake request ${method} ${path}`);
  }, async (guard, deletes) => {
    await guard.recordWorkspaceBaseline();
    phase = 'cleanup';
    await guard.removeWorkspacesCreatedDuringRun();
    assert.deepEqual(deletes, [], 'list differences and test-looking names grant no deletion authority');
  });
});

for (const failedStage of ['authentication', 'workspace-list'] as const) {
  test(`B2 actual ${failedStage} setup failure is visible and grants no teardown authority`, async () => {
    let phase = 'setup';
    await withGuard((method, path) => {
      if (method === 'POST' && path === '/api/auth/login') {
        return phase === 'setup' && failedStage === 'authentication'
          ? json({ error: 'auth-unavailable' }, 401) : json({ token: 'fake-token' });
      }
      if (method === 'GET' && path === '/api/workspaces') {
        return phase === 'setup' ? json({ error: 'workspace-list-unavailable' }, 503)
          : json({ workspaces: [existing, concurrent] });
      }
      if (method === 'DELETE' && path.startsWith('/api/workspaces/')) return new Response(null, { status: 204 });
      return assert.fail(`unexpected fake request ${method} ${path}`);
    }, async (guard, deletes) => {
      const setupRejected = await guard.recordWorkspaceBaseline().then(() => false, error => error instanceof Error);
      phase = 'cleanup'; // Auth/list recover: failed setup must still grant no authority.
      // A missing/invalid run may explicitly reject cleanup or safely do nothing.
      // Either outcome must preserve every workspace; never mask the setup result.
      await guard.removeWorkspacesCreatedDuringRun().then(() => undefined, () => undefined);
      assert.deepEqual({ setupRejected, deletes }, { setupRejected: true, deletes: [] });
    });
  });
}