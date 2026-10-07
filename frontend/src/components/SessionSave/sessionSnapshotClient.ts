// FR-AITUI-007 / FR-AITUI-008 / FR-AITUI-013 / FR-AITUI-014 — the client for /api/session-snapshot.
import type { AgentTabCandidate, SaveResultItem, SessionSnapshot, SnapshotRestoreState, SnapshotStatus } from './sessionSnapshotModel.ts';
import type { RestoreReportItem, SaveItem, SnapshotPreview } from './sessionSaveAllModel.ts';
import type { HandRestoreItem, SnapshotDetail, SnapshotList } from './sessionRestoreModel.ts';

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
  /** FR-AITUI-017 AC-4 */
  listSnapshots(): Promise<SnapshotList>;
  /** FR-AITUI-018 AC-5/AC-6 */
  getSnapshot(id: string): Promise<SnapshotDetail>;
  /** FR-AITUI-017 AC-5 */
  deleteSnapshot(id: string): Promise<void>;
  /** FR-AITUI-018 AC-5..AC-7 */
  restoreFrom(id: string, items: HandRestoreItem[], activeWorkspaceId: string | null): Promise<RestoreReportItem[]>;
  /** FR-AITUI-018 AC-3 */
  acknowledgeReport(reportId: string): Promise<void>;
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
    listSnapshots: async () => read<SnapshotList>(await deps.authFetch(`${base}/list`, { headers: deps.getAuthHeaders() })),
    getSnapshot: async (id) => read<SnapshotDetail>(await deps.authFetch(`${base}/list/${encodeURIComponent(id)}`, { headers: deps.getAuthHeaders() })),
    deleteSnapshot: async (id) => {
      await read(await deps.authFetch(`${base}/list/${encodeURIComponent(id)}`, json('DELETE')));
    },
    restoreFrom: async (id, items, activeWorkspaceId) => (await read<{ results: RestoreReportItem[] }>(
      await deps.authFetch(`${base}/list/${encodeURIComponent(id)}/restore`, json('POST', { items, activeWorkspaceId })),
    )).results,
    acknowledgeReport: async (reportId) => {
      await read(await deps.authFetch(`${base}/report/ack`, json('POST', { reportId })));
    },
  };
}
