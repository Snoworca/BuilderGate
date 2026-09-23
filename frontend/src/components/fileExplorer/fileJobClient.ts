// The explorer's client for the server's file jobs (server/src/routes/fileJobRoutes.ts):
//   POST   /api/file-jobs                  -> 202 {jobId}
//   POST   /api/file-jobs/:jobId/decision
//   DELETE /api/file-jobs/:jobId           cancel
//   GET    /api/file-jobs[?sessionId=]     {jobs: [...pendingDecision]}
// fetch and auth are injected (api.ts wires the real ones), so this module
// stays free of the app's token storage and can be exercised without a network.
// @req FR-FEX-005

import {
  beginClipboardPaste,
  buildDeleteJobRequest,
  buildPasteJobRequest,
  clearFileExplorerClipboard,
  endClipboardPaste,
  getFileExplorerClipboard,
  isMoveIntoOwnSource,
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
  /**
   * Called with the submitted sources once the server accepted the job --
   * not on confirm, so a refused POST leaves the caller's selection alone.
   */
  onAccepted?: (sources: readonly string[]) => void;
}): Promise<{ jobId: string } | null> {
  const request = buildDeleteJobRequest(input.selection);
  if (!request) return null;
  const answer = await input.confirm('delete', { paths: request.sources });
  if (answer !== 'confirm') return null;
  const result = await input.client.submit(request);
  input.onAccepted?.(request.sources);
  return result;
}

/**
 * Pastes the shared clipboard into the target directory. A cut is consumed
 * only after the server accepted the job (and only if the clipboard was not
 * replaced meanwhile), so a failed paste can be retried; a copy stays.
 * A paste of a clipboard value that is already being pasted -- from any tab,
 * window or the editor's panel -- sends nothing and resolves null.
 * @req FR-FEX-005
 */
export async function pasteFromClipboard(input: {
  client: Submitter;
  target: PasteTarget;
}): Promise<{ jobId: string } | null> {
  const clipboard = getFileExplorerClipboard();
  if (!clipboard) return null;
  // Said here rather than returned as a silent null: the user pressed paste and
  // should see why nothing happened.
  if (isMoveIntoOwnSource(clipboard, input.target)) {
    throw new Error('폴더를 그 자신 안으로 옮길 수 없습니다');
  }
  const request = buildPasteJobRequest(clipboard, input.target);
  if (!request) return null;
  if (!beginClipboardPaste(clipboard)) return null;
  try {
    const result = await input.client.submit(request);
    if (clipboard.mode === 'cut' && getFileExplorerClipboard() === clipboard) {
      clearFileExplorerClipboard();
    }
    return result;
  } finally {
    endClipboardPaste(clipboard);
  }
}

export interface SingleFlight {
  /** Runs `task` unless one is still running; then resolves null and runs nothing. */
  run<T>(task: () => Promise<T>): Promise<T | null>;
}

/**
 * A second paste pressed before the first submit settled would send the same
 * cut twice (the clipboard is consumed only after the server accepts).
 * @req FR-FEX-005
 */
export function createSingleFlight(): SingleFlight {
  let busy = false;
  return {
    async run(task) {
      if (busy) return null;
      busy = true;
      try {
        return await task();
      } finally {
        busy = false;
      }
    },
  };
}
