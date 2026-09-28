// FR-AITUI-007 / FR-AITUI-008 / FR-AITUI-013 / FR-AITUI-014 — the client for /api/session-snapshot.
import type { AgentTabCandidate, SaveResultItem, SessionSnapshot, SnapshotRestoreState, SnapshotStatus } from './sessionSnapshotModel.ts';
import type { RestoreReportItem, SaveItem, SnapshotPreview } from './sessionSaveAllModel.ts';

export interface SessionSnapshotClientDeps {
  apiBase: string;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getAuthHeaders: () => HeadersInit;
  parseError: (res: Response) => Promise<Error>;
}

export interface SessionSnapshotClient {
  getStatus(): Promise<SnapshotStatus>;
  getCandidates(): Promise<AgentTabCandidate[]>;
  save(tabIds: string[]): Promise<{ snapshot: SessionSnapshot; results: SaveResultItem[] }>;
  restore(tabIds: string[]): Promise<{ snapshot: SessionSnapshot | null; results: Array<{ tabId: string; restore: SnapshotRestoreState }> }>;
  discard(): Promise<void>;
  preview(): Promise<SnapshotPreview>;
  saveAll(items: SaveItem[]): Promise<{ snapshot: SessionSnapshot }>;
  retry(item: SaveItem): Promise<RestoreReportItem>;
}

export function createSessionSnapshotClient(deps: SessionSnapshotClientDeps): SessionSnapshotClient {
  const base = `${deps.apiBase}/session-snapshot`;
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json', ...deps.getAuthHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw await deps.parseError(res);
    return res.json() as Promise<T>;
  };
  return {
    getStatus: async () => read<SnapshotStatus>(await deps.authFetch(base, { headers: deps.getAuthHeaders() })),
    getCandidates: async () => (await read<{ candidates: AgentTabCandidate[] }>(
      await deps.authFetch(`${base}/candidates`, { headers: deps.getAuthHeaders() }),
    )).candidates,
    save: async (tabIds) => read(await deps.authFetch(base, json('POST', { tabIds }))),
    restore: async (tabIds) => read(await deps.authFetch(`${base}/restore`, json('POST', { tabIds }))),
    discard: async () => {
      await read(await deps.authFetch(base, json('DELETE')));
    },
    preview: async () => read<SnapshotPreview>(await deps.authFetch(`${base}/preview`, { headers: deps.getAuthHeaders() })),
    saveAll: async (items) => read(await deps.authFetch(base, json('POST', { items }))),
    retry: async (item) => (await read<{ item: RestoreReportItem }>(await deps.authFetch(`${base}/retry`, json('POST', item)))).item,
  };
}
