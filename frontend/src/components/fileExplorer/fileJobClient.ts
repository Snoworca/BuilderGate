// The explorer's client for the server's file jobs (server/src/routes/fileJobRoutes.ts):
//   POST   /api/file-jobs                  -> 202 {jobId}
//   POST   /api/file-jobs/:jobId/decision
//   DELETE /api/file-jobs/:jobId           cancel
//   GET    /api/file-jobs[?sessionId=]     {jobs: [...pendingDecision]}
// fetch and auth are injected (api.ts wires the real ones), so this module
// stays free of the app's token storage and can be exercised without a network.
// @req FR-FEX-005

import {
  buildDeleteJobRequest,
  buildPasteJobRequest,
  clearFileExplorerClipboard,
  getFileExplorerClipboard,
  type DeleteJobRequest,
  type ExplorerSelection,
  type PasteJobRequest,
  type PasteTarget,
} from './fileExplorerClipboard.ts';
import type { ConfirmPort, FileJobChoice } from './fileExplorerPorts.ts';
import { isAbsolutePathSyntax } from './fileTreeState.ts';

export type FileJobRequest = PasteJobRequest | DeleteJobRequest;

export interface FileJobDecision {
  decisionId: string;
  choice: FileJobChoice;
  applyToAll?: boolean;
}

export interface FileJobClientDeps {
  apiBase: string;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getAuthHeaders: () => HeadersInit;
  parseError: (res: Response) => Promise<Error>;
}

export interface FileJobClient {
  submit(request: FileJobRequest): Promise<{ jobId: string }>;
  decide(jobId: string, decision: FileJobDecision): Promise<void>;
  cancel(jobId: string): Promise<void>;
  list(sessionId?: string): Promise<unknown[]>;
}

// The server validates against the session cwd but operates relative to its
// own process cwd, so it refuses a relative path; refusing here names the bug
// on the client side. The syntax rule lives with the other path syntax in
// fileTreeState.ts.
function assertAbsolute(request: FileJobRequest): void {
  const paths = request.operation === 'delete' ? request.sources : [...request.sources, request.destPath];
  const bad = paths.find((p) => !isAbsolutePathSyntax(p));
  if (bad !== undefined) {
    throw new Error(`file job paths must be absolute: ${bad}`);
  }
}

/** @req FR-FEX-005 */
export function createFileJobClient(deps: FileJobClientDeps): FileJobClient {
  const { apiBase, authFetch, getAuthHeaders, parseError } = deps;
  const jsonHeaders = (): HeadersInit => ({ 'Content-Type': 'application/json', ...getAuthHeaders() });

  return {
    async submit(request) {
      assertAbsolute(request);
      const res = await authFetch(`${apiBase}/file-jobs`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(request),
      });
      if (!res.ok) throw await parseError(res);
      const body = await res.json() as { jobId: string };
      return { jobId: body.jobId };
    },

    async decide(jobId, decision) {
      const res = await authFetch(`${apiBase}/file-jobs/${encodeURIComponent(jobId)}/decision`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(decision),
      });
      if (!res.ok) throw await parseError(res);
    },

    async cancel(jobId) {
      const res = await authFetch(`${apiBase}/file-jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw await parseError(res);
    },

    async list(sessionId) {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const res = await authFetch(`${apiBase}/file-jobs${query}`, { headers: getAuthHeaders() });
      if (!res.ok) throw await parseError(res);
      const body = await res.json() as { jobs: unknown[] };
      return body.jobs;
    },
  };
}

type Submitter = Pick<FileJobClient, 'submit'>;

/**
 * Asks once, then submits a delete job only on 'confirm'. '..' is never a
 * target; a selection with nothing else asks nothing and sends nothing.
 * @req FR-FEX-005
 */
export async function requestDelete(input: {
  client: Submitter;
  confirm: ConfirmPort;
  selection: ExplorerSelection;
}): Promise<{ jobId: string } | null> {
  const request = buildDeleteJobRequest(input.selection);
  if (!request) return null;
  const answer = await input.confirm('delete', { paths: request.sources });
  if (answer !== 'confirm') return null;
  return input.client.submit(request);
}

/**
 * Pastes the shared clipboard into the target directory. A cut is consumed
 * only after the server accepted the job (and only if the clipboard was not
 * replaced meanwhile), so a failed paste can be retried; a copy stays.
 * @req FR-FEX-005
 */
export async function pasteFromClipboard(input: {
  client: Submitter;
  target: PasteTarget;
}): Promise<{ jobId: string } | null> {
  const clipboard = getFileExplorerClipboard();
  if (!clipboard) return null;
  const request = buildPasteJobRequest(clipboard, input.target);
  if (!request) return null;
  const result = await input.client.submit(request);
  if (clipboard.mode === 'cut' && getFileExplorerClipboard() === clipboard) {
    clearFileExplorerClipboard();
  }
  return result;
}
