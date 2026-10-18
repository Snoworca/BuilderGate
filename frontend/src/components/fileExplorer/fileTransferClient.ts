// The explorer's client for the file transfer routes (docs/design/file-transfer.api-contract.md):
//   POST   /api/sessions/:id/files/upload/check        conflicts and refusals before sending
//   PUT    /api/sessions/:id/files/upload?dir&path&conflict   one file, raw bytes
//   POST   /api/sessions/:id/files/zip/precount         count and size of a ZIP
//   POST   /api/sessions/:id/files/zip/token            single-use download token
//   GET    /api/sessions/:id/files/zip/jobs/:jobId      streaming progress
//   DELETE /api/sessions/:id/files/zip/jobs/:jobId      cancel
// The upload goes through XMLHttpRequest because fetch reports no upload progress. Network and
// auth are injected (api.ts wires the real ones), as in fileJobClient.ts.
// @req FR-FEX-022
// @req FR-FEX-024
// @req FR-FEX-025

export type UploadConflictMode = 'fail' | 'overwrite' | 'rename' | 'skip';

export interface UploadCheckRequest {
  dir: string;
  files: readonly { path: string; size: number }[];
}

export interface UploadCheckConflict {
  path: string;
  existing: { size: number | null; modified: string | null; isDirectory: boolean };
  decisions: readonly ('overwrite' | 'rename' | 'skip')[];
  /** The free name the server proposes for 둘 다 유지 (e.g. 'assets (2)'). */
  renameTo?: string;
}

export interface UploadCheckResult {
  conflicts: readonly UploadCheckConflict[];
  rejected: readonly { path: string; code: string }[];
}

export interface PutFileRequest {
  sessionId: string;
  dir: string;
  /** Relative to `dir`, '/'-separated; a folder upload keeps its subfolders. */
  path: string;
  conflict: UploadConflictMode;
  body: Blob;
  signal: AbortSignal;
  onProgress: (sentBytes: number) => void;
}

export interface PutFileResult {
  name: string;
  path: string;
  size: number;
  skipped: boolean;
}

export interface ZipPrecount {
  name: string;
  fileCount: number;
  totalBytes: number;
  excluded: readonly string[];
  skippedBlocked: number;
}

export interface ZipToken {
  token: string;
  url: string;
  name: string;
  jobId: string;
}

export interface ZipJobStatus {
  state: string;
  sentBytes: number;
  totalBytes: number;
}

/** The part of XMLHttpRequest the upload uses, so a test can stand in for it. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  readonly upload: { onprogress: ((event: { loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

export interface FileTransferClientDeps {
  apiBase: string;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getAuthHeaders: () => HeadersInit;
  parseError: (res: Response) => Promise<Error>;
  createXhr: () => XhrLike;
}

/** A transfer that did not complete: the HTTP status (0 when the connection dropped) and the server's code. */
export class TransferError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TransferError';
    this.status = status;
    this.code = code;
  }
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function errorOf(status: number, text: string): TransferError {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === 'string' ? body.error.code : `HTTP_${status}`;
    const message = typeof body.error?.message === 'string' ? body.error.message : code;
    return new TransferError(status, code, message);
  } catch {
    return new TransferError(status, `HTTP_${status}`, `HTTP ${status}`);
  }
}

export interface FileTransferClient {
  checkUpload(sessionId: string, request: UploadCheckRequest): Promise<UploadCheckResult>;
  putFile(request: PutFileRequest): Promise<PutFileResult>;
  zipPrecount(sessionId: string, paths: readonly string[]): Promise<ZipPrecount>;
  zipToken(sessionId: string, paths: readonly string[]): Promise<ZipToken>;
  zipJob(sessionId: string, jobId: string): Promise<ZipJobStatus>;
  zipCancel(sessionId: string, jobId: string): Promise<void>;
}

/** @req FR-FEX-024 */
export function createFileTransferClient(deps: FileTransferClientDeps): FileTransferClient {
  const { apiBase, authFetch, getAuthHeaders, parseError, createXhr } = deps;
  const base = (sessionId: string) => `${apiBase}/sessions/${encodeURIComponent(sessionId)}/files`;
  const postJson = async <T>(url: string, body: unknown): Promise<T> => {
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    return await res.json() as T;
  };

  return {
    checkUpload: (sessionId, request) => postJson<UploadCheckResult>(`${base(sessionId)}/upload/check`, request),

    putFile(request) {
      return new Promise<PutFileResult>((resolve, reject) => {
        if (request.signal.aborted) {
          reject(abortError());
          return;
        }
        const query = `dir=${encodeURIComponent(request.dir)}&path=${encodeURIComponent(request.path)}&conflict=${request.conflict}`;
        const xhr = createXhr();
        xhr.open('PUT', `${base(request.sessionId)}/upload?${query}`);
        const headers = new Headers(getAuthHeaders());
        headers.forEach((value, name) => {
          // Headers lower-cases names; the server reads them case-insensitively either way.
          xhr.setRequestHeader(name === 'authorization' ? 'Authorization' : name, value);
        });
        // Content-Length comes from the Blob; the browser sets it and forbids setting it here.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        const onAbort = () => xhr.abort();
        request.signal.addEventListener('abort', onAbort, { once: true });
        const settle = () => request.signal.removeEventListener('abort', onAbort);
        xhr.upload.onprogress = (event) => request.onProgress(event.loaded);
        xhr.onload = () => {
          settle();
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText) as PutFileResult);
            } catch {
              reject(new TransferError(xhr.status, 'BAD_RESPONSE', 'unreadable upload response'));
            }
            return;
          }
          reject(errorOf(xhr.status, xhr.responseText));
        };
        xhr.onerror = () => {
          settle();
          reject(new TransferError(0, 'NETWORK', 'the connection dropped'));
        };
        xhr.onabort = () => {
          settle();
          reject(abortError());
        };
        xhr.send(request.body);
      });
    },

    zipPrecount: (sessionId, paths) => postJson<ZipPrecount>(`${base(sessionId)}/zip/precount`, { paths }),
    zipToken: (sessionId, paths) => postJson<ZipToken>(`${base(sessionId)}/zip/token`, { paths }),

    async zipJob(sessionId, jobId) {
      const res = await authFetch(`${base(sessionId)}/zip/jobs/${encodeURIComponent(jobId)}`, { headers: getAuthHeaders() });
      if (res.status === 404) return { state: 'gone', sentBytes: 0, totalBytes: 0 };
      if (!res.ok) throw await parseError(res);
      return await res.json() as ZipJobStatus;
    },

    async zipCancel(sessionId, jobId) {
      const res = await authFetch(`${base(sessionId)}/zip/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok && res.status !== 404) throw await parseError(res);
    },
  };
}
