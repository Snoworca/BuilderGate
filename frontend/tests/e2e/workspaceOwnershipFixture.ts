import { test as base, type APIRequestContext, type BrowserContext, type Request, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { isLoopbackIp } from '../../../server/src/utils/bootstrapAccessPolicy.ts';
import {
  cleanupOwnedWorkspaces, deleteOwnedWorkspace, registerWorkspaceCreation, validateWorkspaceOwner,
  type RegistryOptions, type WorkspaceCleanupResult,
} from './workspaceLeakGuard.ts';

export * from '@playwright/test';

export interface WorkspaceOwnershipTracker {
  drain(): Promise<void>;
  cleanup(): Promise<WorkspaceCleanupResult>;
  deleteWorkspace(id: string): Promise<WorkspaceCleanupResult>;
  dispose(): Promise<void>;
}
const trackers = new WeakMap<BrowserContext, WorkspaceOwnershipTracker>();

function successfulCleanup(result: WorkspaceCleanupResult): WorkspaceCleanupResult {
  if (result.failed.length) throw Error(`Owned workspace cleanup failed: ${JSON.stringify(result.failed)}`);
  return result;
}

export function attachWorkspaceOwnership(context: BrowserContext, registry: RegistryOptions, ownerId: string): WorkspaceOwnershipTracker {
  if (trackers.has(context)) throw Error('Workspace ownership is already attached to this context');
  if (!registry.registryPath || !registry.runId || !ownerId) throw Error('Workspace ownership run and owner are required');
  const origin = new URL(registry.baseUrl).origin;
  const requests = new Map<Request, { promise: Promise<void>; finish(): void; responded: boolean }>();
  const writes = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let disposed = false;
  const matches = (request: Request) => {
    if (request.method() !== 'POST' || !URL.canParse(request.url())) return false;
    const url = new URL(request.url());
    return url.origin === origin && url.pathname === '/api/workspaces';
  };
  const onRequest = (request: Request) => {
    if (!matches(request) || requests.has(request)) return;
    let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    requests.set(request, { promise, finish, responded: false });
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    if (!matches(request)) return;
    const pending = requests.get(request);
    if (!pending) { errors.push(Error('Workspace response has no observed creation request')); return; }
    pending.responded = true;
    const write = (async () => {
      if (response.status() !== 201) throw Error(`Workspace creation returned ${response.status()}`);
      const address = await response.serverAddr();
      if (response.fromServiceWorker() || !address || address.port !== 2222 || !isLoopbackIp(address.ipAddress)) {
        throw Error('Workspace creation response is not proven live loopback traffic');
      }
      const body: unknown = await response.json();
      await registerWorkspaceCreation({ ...registry, ownerId, proof: {
        url: response.url(), method: request.method(), status: response.status(), body,
      } });
    })();
    writes.add(write);
    void write.then(() => { writes.delete(write); }, error => { errors.push(error); writes.delete(write); });
  };
  const finishRequest = (request: Request) => {
    const pending = requests.get(request);
    if (!pending) return;
    pending.finish(); requests.delete(request);
  };
  const onFinished = (request: Request) => {
    const pending = requests.get(request);
    if (pending && !pending.responded) errors.push(Error('Workspace creation finished without an observed response'));
    finishRequest(request);
  };
  const onFailed = (request: Request) => {
    if (!requests.has(request)) return;
    errors.push(Error(request.failure()?.errorText ?? 'Workspace creation request failed'));
    finishRequest(request);
  };
  const drain = async () => {
    while (requests.size || writes.size) {
      await Promise.allSettled([...Array.from(requests.values(), pending => pending.promise), ...writes]);
    }
    if (errors.length) throw new AggregateError(errors, 'Workspace ownership tracking failed');
  };
  const tracker: WorkspaceOwnershipTracker = {
    drain,
    async cleanup() {
      await drain();
      return successfulCleanup(await cleanupOwnedWorkspaces({ ...registry, ownerId }));
    },
    async deleteWorkspace(workspaceId) {
      await drain();
      return successfulCleanup(await deleteOwnedWorkspace({ ...registry, ownerId, workspaceId }));
    },
    async dispose() {
      try { await drain(); }
      finally {
        if (!disposed) {
          disposed = true;
          context.off('request', onRequest); context.off('response', onResponse);
          context.off('requestfinished', onFinished); context.off('requestfailed', onFailed);
          trackers.delete(context);
        }
      }
    },
  };
  context.on('request', onRequest); context.on('response', onResponse);
  context.on('requestfinished', onFinished); context.on('requestfailed', onFailed);
  trackers.set(context, tracker);
  return tracker;
}

export async function deleteOwnedWorkspaceForContext(context: BrowserContext, workspaceId: string): Promise<WorkspaceCleanupResult> {
  const tracker = trackers.get(context);
  if (!tracker) throw Error('Context has no workspace ownership');
  return tracker.deleteWorkspace(workspaceId);
}

export async function createOwnedWorkspaceViaApi(
  request: APIRequestContext, registry: RegistryOptions, ownerId: string,
  options: Parameters<APIRequestContext['post']>[1],
): Promise<{ id: string }> {
  const checked = await validateWorkspaceOwner({ ...registry, ownerId });
  const response = await request.post(new URL('/api/workspaces', checked.baseUrl).href, options);
  const body: unknown = await response.json();
  await registerWorkspaceCreation({ ...checked, ownerId, proof: {
    url: response.url(), method: 'POST', status: response.status(), body,
  } });
  return body as { id: string }; // The registry validated the direct response ID.
}

export const test = base.extend<{ workspaceOwnership: WorkspaceOwnershipTracker }>({
  workspaceOwnership: [async ({ context }, use, info) => {
    const ownerId = `${info.testId}/${info.retry}/${info.workerIndex}/${randomUUID()}`;
    const registry = await validateWorkspaceOwner({
      registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
      runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '',
      baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222',
      ownerId,
    });
    const tracker = attachWorkspaceOwnership(context, registry, ownerId);
    const failures: unknown[] = [];
    try { await use(tracker); } catch (error) { failures.push(error); }
    try { await tracker.cleanup(); } catch (error) { failures.push(error); }
    try { await tracker.dispose(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Test and workspace cleanup failed');
  }, { auto: true }],
});
