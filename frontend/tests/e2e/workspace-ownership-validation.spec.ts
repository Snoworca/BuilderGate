import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

// REL-BGSTAB-001: authoring only until the canonical/external-runtime gate is approved.
// No server launcher, limits mutation, prefix eviction, tabs or PTY creation.
const origin = 'https://localhost:2222';
type Workspace = { id: string; name: string; viewMode: string; activeTabId: string | null };
type Tab = { id: string; workspaceId: string; sessionId: string; name: string };
type State = { workspaces: Workspace[]; tabs: Tab[]; limits: { maxWorkspaces: number } };
const signature = (state: State, ids: readonly string[]) => ids.map(id => {
  const workspace = state.workspaces.find(item => item.id === id);
  if (!workspace) throw Error(`Preserved workspace disappeared: ${id}`);
  return {
    id, name: workspace.name, viewMode: workspace.viewMode, activeTabId: workspace.activeTabId,
    tabs: state.tabs.filter(tab => tab.workspaceId === id)
      .map(tab => ({ id: tab.id, workspaceId: tab.workspaceId, sessionId: tab.sessionId, name: tab.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
});

test('B2 actual UI/API ownership preserves independent resources and rejects quota without eviction', async ({ page, request, workspaceOwnership }, info) => {
  expect(process.env.PLAYWRIGHT_BASE_URL ?? origin).toBe(origin);
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const apiOwner = `ownership-control/${info.testId}/${info.retry}/${randomUUID()}`;
  const errors: unknown[] = [];
  const deletes: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.origin === origin && /^\/api\/workspaces\/[^/]+$/.test(url.pathname) && method === 'DELETE') deletes.push(url.pathname);
    return originalFetch(input, init);
  };
  const metadata: Array<{ id: string; status: number; fromServiceWorker: boolean; serverAddr: unknown }> = [];
  const createdApiIds: string[] = [];
  let token: string | null = null;
  let initial: State | undefined;
  let finalState: State | undefined;
  let apiCreationStarted = false;
  const onRequest = (event: { url(): string; method(): string }) => {
    const url = new URL(event.url());
    if (url.origin === origin && /^\/api\/workspaces\/[^/]+$/.test(url.pathname) && event.method() === 'DELETE') deletes.push(url.pathname);
  };
  page.context().on('request', onRequest);
  const readState = async (): Promise<State> => {
    const response = await request.get(origin + '/api/workspaces', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status(), 'authenticated workspace list').toBe(200);
    const body: unknown = await response.json();
    expect(body !== null && typeof body === 'object').toBe(true);
    const state = body as State;
    expect(Array.isArray(state.workspaces)).toBe(true); expect(Array.isArray(state.tabs)).toBe(true);
    expect(Number.isInteger(state.limits?.maxWorkspaces), 'validation requires an integer capacity').toBe(true);
    expect(state.limits.maxWorkspaces).toBeGreaterThanOrEqual(1); expect(state.limits.maxWorkspaces).toBeLessThanOrEqual(50);
    expect(new Set(state.workspaces.map(item => item.id)).size).toBe(state.workspaces.length);
    for (const workspace of state.workspaces) {
      expect(typeof workspace.id).toBe('string'); expect(workspace.id.length).toBeGreaterThan(0); expect(typeof workspace.name).toBe('string');
    }
    return state;
  };
  const createApi = async (name: string): Promise<string> => {
    apiCreationStarted = true;
    const workspace = await createOwnedWorkspaceViaApi(request, registry, apiOwner, {
      headers: { Authorization: `Bearer ${token}` }, data: { name },
    });
    createdApiIds.push(workspace.id);
    expect(createdApiIds.length).toBeLessThanOrEqual(48); // two UI creations + at most 48 API creations
    return workspace.id;
  };
  const createUi = async (): Promise<string> => {
    const pending = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === origin && url.pathname === '/api/workspaces' && response.request().method() === 'POST';
    });
    await page.getByTitle('New Workspace', { exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(201);
    const body = await response.json() as { id: string };
    expect(typeof body.id).toBe('string'); expect(body.id.length).toBeGreaterThan(0);
    metadata.push({ id: body.id, status: response.status(), fromServiceWorker: response.fromServiceWorker(), serverAddr: await response.serverAddr() });
    await workspaceOwnership.drain();
    return body.id;
  };
  try {
    await login(page);
    expect(new URL(page.url()).origin).toBe(origin);
    token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    expect(typeof token).toBe('string'); expect(token?.length).toBeGreaterThan(0);
    initial = await readState();
    const capacity = initial.limits.maxWorkspaces;
    expect(capacity - initial.workspaces.length, 'four free slots required; saved workspaces are never evicted').toBeGreaterThanOrEqual(4);
    expect(capacity - initial.workspaces.length + 1, 'selected deletion plus refill must fit the absolute 50-creation budget').toBeLessThanOrEqual(50);
    const preservedIds = initial.workspaces.map(item => item.id);
    const originalSignature = signature(initial, preservedIds);
    const uiX = await createUi(); const uiY = await createUi();
    const control = await createApi('E2E-looking-user-control');
    const sibling = await createApi('E2E-looking-sibling');
    const beforeDelete = await readState();
    const keep = [...preservedIds, uiY, control, sibling];
    const keepSignature = signature(beforeDelete, keep);
    const deleted = await workspaceOwnership.deleteWorkspace(uiX);
    expect(deleted.deleted).toEqual([uiX]); expect(deleted.failed).toEqual([]);
    const afterDelete = await readState();
    expect(afterDelete.workspaces.some(item => item.id === uiX)).toBe(false);
    expect(signature(afterDelete, keep)).toEqual(keepSignature);
    expect(deletes).toEqual([`/api/workspaces/${uiX}`]);

    let expectedIds = afterDelete.workspaces.map(item => item.id).sort();
    const fills = capacity - expectedIds.length;
    expect(fills).toBeGreaterThanOrEqual(0); expect(fills + 4).toBeLessThanOrEqual(50);
    for (let i = 0; i < fills; i++) {
      const current = await readState();
      expect(current.limits.maxWorkspaces, 'capacity changed during control').toBe(capacity);
      expect(current.workspaces.map(item => item.id).sort(), 'concurrent state change; do not evict to force quota').toEqual(expectedIds);
      expectedIds = [...expectedIds, await createApi(`B2-owned-fill-${i}`)].sort();
    }
    const full = await readState(); expect(full.workspaces.length).toBe(capacity);
    expect(signature(full, keep)).toEqual(keepSignature);
    const recordsBefore = (await readdir(join(registry.registryPath, 'records'))).sort();
    const deletesBefore = deletes.length;
    let quotaStatus: number | undefined;
    // Capture actual adapter response status without changing its request or response.
    const quotaRequest = new Proxy(request, {
      get(target, key) {
        if (key === 'post') return async (...args: Parameters<typeof request.post>) => {
          const response = await target.post(...args); quotaStatus = response.status(); return response;
        };
        if (key === 'delete') return async (...args: Parameters<typeof request.delete>) => {
          deletes.push(new URL(args[0], origin).pathname); return target.delete(...args);
        };
        if (key === 'fetch') return async (...args: Parameters<typeof request.fetch>) => {
          if (args[1]?.method === 'DELETE') deletes.push(typeof args[0] === 'string' ? new URL(args[0], origin).pathname : new URL(args[0].url()).pathname);
          return target.fetch(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(createOwnedWorkspaceViaApi(quotaRequest, registry, apiOwner, {
      headers: { Authorization: `Bearer ${token}` }, data: { name: 'B2-quota-must-fail' },
    })).rejects.toThrow();
    expect(quotaStatus).toBe(409);
    expect((await readdir(join(registry.registryPath, 'records'))).sort()).toEqual(recordsBefore);
    expect(deletes.length).toBe(deletesBefore);
    const afterQuota = await readState();
    expect(afterQuota.workspaces.map(item => item.id).sort()).toEqual(expectedIds);
    expect(signature(afterQuota, keep)).toEqual(keepSignature);
    await expect(page.getByTitle(`Maximum ${capacity} workspaces`, { exact: true })).toBeDisabled();
    expect(signature(afterQuota, preservedIds)).toEqual(originalSignature);
  } catch (error) { errors.push(error); }
  finally {
    try { await workspaceOwnership.cleanup(); } catch (error) { errors.push(error); }
    if (apiCreationStarted) {
      try {
        const result = await cleanupOwnedWorkspaces({ ...registry, ownerId: apiOwner });
        if (result.failed.length) throw Error(`API owner cleanup retained failed IDs: ${JSON.stringify(result.failed)}`);
      } catch (error) { errors.push(error); }
    }
    if (token && initial) {
      try {
        finalState = await readState();
        expect(signature(finalState, initial.workspaces.map(item => item.id))).toEqual(signature(initial, initial.workspaces.map(item => item.id)));
        for (const id of createdApiIds) expect(finalState.workspaces.some(item => item.id === id)).toBe(false);
        for (const { id } of metadata) expect(finalState.workspaces.some(item => item.id === id)).toBe(false);
      } catch (error) { errors.push(error); }
    }
    globalThis.fetch = originalFetch;
    page.context().off('request', onRequest);
    try {
      await info.attach('workspace-ownership-control', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ uiResponseMetadata: metadata, observedWorkspaceDeletes: deletes, createdApiIds, preservedIds: initial?.workspaces.map(item => item.id), finalIds: finalState?.workspaces.map(item => item.id), errorCount: errors.length }), 'utf8'),
      });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Workspace ownership browser control failed');
});
