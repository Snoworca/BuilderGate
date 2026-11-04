// FR-MCP-021 (#234): one-use upload URLs. buildergate.file.upload_url opens one for a session; the
// file sent to it lands in the session's working folder as it was when the URL was opened. The
// first upload request uses the URL up, whether it finishes, fails or is cut off.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { AppError, ErrorCode } from '../utils/errors.js';
import { armRequestIdleTimeout, DEFAULT_UPLOAD_IDLE_TIMEOUT_MS } from '../middleware/requestBodyDeadline.js';
import { storeUploadBody } from './upload/storeUpload.js';
import type { UploadTempRegistry } from './upload/uploadTemp.js';

export const MCP_FILE_UPLOAD_PATH = '/mcp/fu';
/** FR-MCP-021 AC-6: an unused URL closes after this long. */
export const MCP_FILE_UPLOAD_TTL_MS = 10 * 60_000;
/** URLs open at once; opening more is refused (UPLOAD_URLS_FULL) rather than dropping a live one. */
const MAX_OPEN_URLS = 256;

export interface McpFileUploadFiles {
  uploadDirectoryOf(sessionId: string): Promise<string>;
  resolveUploadTargetInDirectory(directory: string, fileName: string): Promise<string>;
  revalidateUploadParentIn(directory: string, parent: string): Promise<void>;
  readonly maxUploadFileSize: number;
}

export interface McpFileUploads {
  /** FR-MCP-021 AC-1/AC-2. */
  open(sessionId: string): Promise<Record<string, unknown>>;
  /** Answers a request to /mcp/fu; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

interface Grant {
  sessionId: string;
  directory: string;
  expiresAt: number;
}

export function createMcpFileUploads(deps: {
  files: McpFileUploadFiles;
  registry: UploadTempRegistry;
  now?: () => number;
  openTempFile?: (filePath: string) => Writable;
  /**
   * FR-MCP-021 AC-7: the MCP listener's address rules (IP list, trusted proxy) for this request;
   * a refusal code, or null to go on. The token is the credential, so no MCP key is asked for.
   */
  checkAccess?: (req: IncomingMessage) => string | null;
  maxOpen?: number;
}): McpFileUploads {
  const maxOpen = deps.maxOpen ?? MAX_OPEN_URLS;
  const now = deps.now ?? Date.now;
  const grants = new Map<string, Grant>();

  const prune = () => {
    const at = now();
    for (const [token, grant] of grants) if (grant.expiresAt <= at) grants.delete(token);
  };

  const live = (token: string | null): Grant | undefined => {
    const grant = token ? grants.get(token) : undefined;
    return grant && grant.expiresAt > now() ? grant : undefined;
  };

  const open: McpFileUploads['open'] = async (sessionId) => {
    if (!sessionId) return validation({ sessionId: 'required' });
    let directory: string;
    try {
      directory = await deps.files.uploadDirectoryOf(sessionId);
    } catch (error) {
      if (error instanceof AppError) return validation({ sessionId: 'not a live session' });
      throw error;
    }
    prune();
    if (grants.size >= maxOpen) {
      return { ok: false, code: 'UPLOAD_URLS_FULL', message: `${maxOpen} upload URLs are open; use or let some expire first.` };
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now() + MCP_FILE_UPLOAD_TTL_MS;
    grants.set(token, { sessionId, directory, expiresAt });
    return {
      ok: true,
      path: `${MCP_FILE_UPLOAD_PATH}?t=${token}`,
      directory,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  };

  const upload = async (req: IncomingMessage, res: ServerResponse, url: URL, grant: Grant) => {
    armRequestIdleTimeout(req, DEFAULT_UPLOAD_IDLE_TIMEOUT_MS);
    try {
      const name = url.searchParams.get('name') ?? headerName(req.headers['x-file-name']);
      if (!name) throw new AppError(ErrorCode.INVALID_UPLOAD_PATH, 'Give the file name as ?name= or X-File-Name');
      const target = await deps.files.resolveUploadTargetInDirectory(grant.directory, name);
      const stored = await storeUploadBody({
        body: req,
        target,
        conflict: 'rename',
        limit: deps.files.maxUploadFileSize,
        registry: deps.registry,
        revalidateParent: (parent) => deps.files.revalidateUploadParentIn(grant.directory, parent),
        openTempFile: deps.openTempFile,
      });
      if (stored.kind === 'aborted') return;
      const size = stored.kind === 'stored' ? stored.size : 0;
      sendJson(res, 200, { ok: true, name: path.basename(stored.finalPath), size, directory: grant.directory });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(ErrorCode.INTERNAL_ERROR);
      if (!(error instanceof AppError)) console.error('[McpFileUpload] Unexpected error:', error);
      refuse(req, res, appError.statusCode, appError.toJSON());
    }
  };

  const handle: McpFileUploads['handle'] = (req, res) => {
    // Every request to the MCP listener passes here first, before its own error handling: the
    // path is compared as text, so a target that is not a URL (GET http://[ ...) cannot throw.
    const target = req.url ?? '/';
    const query = target.indexOf('?');
    if ((query < 0 ? target : target.slice(0, query)) !== MCP_FILE_UPLOAD_PATH) return false;
    const url = new URL(target, 'http://upload');
    const denied = deps.checkAccess?.(req) ?? null;
    if (denied) {
      refuse(req, res, 403, { error: { code: denied, message: 'This address may not use the MCP listener.' } });
      return true;
    }
    const token = url.searchParams.get('t');
    const grant = live(token);
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') {
      if (!grant) refuse(req, res, 410, gone());
      else sendPage(res);
      return true;
    }
    if (method !== 'PUT' && method !== 'POST') {
      res.setHeader('Allow', 'GET, PUT, POST');
      refuse(req, res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use PUT or POST' } });
      return true;
    }
    if (!grant) {
      refuse(req, res, 410, gone());
      return true;
    }
    // FR-MCP-021 AC-5: the first upload request uses the URL up, whatever happens next.
    grants.delete(token!);
    void upload(req, res, url, grant);
    return true;
  };

  return { open, handle };
}

function validation(fieldErrors: Record<string, string>): Record<string, unknown> {
  return { ok: false, code: 'VALIDATION_ERROR', fieldErrors };
}

function gone(): Record<string, unknown> {
  return { error: { code: 'UPLOAD_URL_GONE', message: 'This upload URL was used, has expired, or never existed. Open a new one.' } };
}

function headerName(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Answers early: the rest of the body is read and dropped so the answer reaches the client. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  if (!req.complete) {
    res.setHeader('Connection', 'close');
    req.resume();
  }
  sendJson(res, status, body);
}

function sendPage(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // The token is in the URL: never send it on as a Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
  res.end(UPLOAD_PAGE);
}

const UPLOAD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BuilderGate upload</title>
<style>body{font:15px system-ui,sans-serif;margin:40px auto;max-width:480px;padding:0 16px;color:#222}
button{font:inherit;padding:6px 14px}#s{margin-top:16px;white-space:pre-wrap}</style></head>
<body><h1>Upload a file</h1><p>This link works once. / 이 주소는 한 번만 쓸 수 있습니다.</p>
<input id="f" type="file"> <button id="b">Upload</button><div id="s"></div>
<script>
document.getElementById('b').onclick=async()=>{const f=document.getElementById('f').files[0];const s=document.getElementById('s');
if(!f){s.textContent='Choose a file.';return;}document.getElementById('b').disabled=true;s.textContent='Uploading...';
try{const r=await fetch(location.pathname+location.search+'&name='+encodeURIComponent(f.name),{method:'PUT',body:f});
const j=await r.json();s.textContent=r.ok?'Saved as '+j.name+' ('+j.size+' bytes)':'Failed: '+((j.error&&j.error.message)||r.status);}
catch(e){s.textContent='Failed: '+e;}};
</script></body></html>`;
