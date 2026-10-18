// SEC-MDE-002 (#141), FR-MDE-028 AC-5, AC-6: the HTML viewer's server side.
//
// POST /api/sessions/:id/files/html-view (JWT) checks an .html/.htm file with the file API rules and
// issues a token. GET /api/html-view/<token>/<path> serves that session folder's files without a JWT,
// so the page in the editor's sandboxed iframe can load its stylesheets, scripts, images and fetches
// by relative URL. Every response of that route forces a sandboxed, opaque origin (CSP sandbox
// without allow-same-origin): the page's scripts run but cannot read the application's storage or
// call its API as the user. The application keeps frame-ancestors 'none' everywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { FileService } from '../services/FileService.js';
import type { HtmlViewResult, HtmlViewTokenStore } from '../services/HtmlViewTokenStore.js';
import { AppError, ErrorCode } from '../utils/errors.js';

export const HTML_VIEW_SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups';
export const HTML_VIEW_CSP = `${HTML_VIEW_SANDBOX}; frame-ancestors 'self'`;

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

// FR-MDE-028 AC-6: what a page commonly loads, typed so the browser uses it (nosniff is on).
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export function htmlViewContentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Each segment URL-encoded, '/' kept. */
function encodePath(relative: string): string {
  return relative.split('/').filter((s) => s !== '').map(encodeURIComponent).join('/');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  console.error('[HtmlViewRoutes] Unexpected error:', err instanceof Error ? err.name : typeof err);
  res.status(500).json(new AppError(ErrorCode.INTERNAL_ERROR).toJSON());
}

function userOf(req: Request): string {
  return (req as Request & { user?: { sub?: string } }).user?.sub ?? '';
}

/** AC-3: set on every response of the view route, before anything else answers. */
const isolationHeaders: RequestHandler = (_req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.set({
    'Content-Security-Policy': HTML_VIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    // The sandboxed page has an opaque origin, so its resource loads and fetches are cross-origin.
    // The token in the path is the only credential; no cookie or header is honoured here.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
  });
  next();
};

export interface HtmlViewRoutes {
  /** Mount under /api/sessions behind the JWT. */
  sessionRouter: Router;
  /** Mount under /api/html-view without the JWT; its DELETE uses options.auth. */
  viewRouter: Router;
}

export function createHtmlViewRoutes(fileService: FileService, store: HtmlViewTokenStore, options: { auth: RequestHandler }): HtmlViewRoutes {
  const sessionRouter = Router();

  // POST /api/sessions/:id/files/html-view  { path }
  sessionRouter.post('/:id/files/html-view', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const filePath = typeof (req.body as { path?: unknown } | undefined)?.path === 'string' ? (req.body as { path: string }).path : '';
      if (!filePath) throw new AppError(ErrorCode.INVALID_INPUT, 'path is required');
      const file = await fileService.resolveDownload(req.params.id, filePath);
      if (!HTML_EXTENSIONS.has(path.extname(file.name).toLowerCase())) throw new AppError(ErrorCode.INVALID_INPUT, 'not an .html or .htm file');
      const root = await fileService.realCwd(req.params.id);
      const relative = toPosix(path.relative(root, file.path));
      if (relative === '' || relative.startsWith('../') || path.isAbsolute(relative)) throw new AppError(ErrorCode.PATH_TRAVERSAL);
      const token = store.issue({ sessionId: req.params.id, userId: userOf(req), root });
      const folder = path.posix.dirname(relative);
      res.set('Cache-Control', 'no-store');
      res.json({
        token,
        url: `/api/html-view/${token}/${encodePath(relative)}`,
        baseUrl: folder === '.' ? `/api/html-view/${token}/` : `/api/html-view/${token}/${encodePath(folder)}/`,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/sessions/:id/files/html-view/:token/resources
  sessionRouter.get('/:id/files/html-view/:token/resources', (req: Request<{ id: string; token: string }>, res: Response) => {
    if (store.peek(req.params.token, req.params.id, userOf(req)) === null) {
      sendError(res, new AppError(ErrorCode.HTML_VIEW_TOKEN_INVALID));
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ entries: store.requests(req.params.token) });
  });

  const viewRouter = Router();

  // DELETE /api/html-view/:token (JWT)
  viewRouter.delete('/:token', options.auth, (req: Request<{ token: string }>, res: Response) => {
    if (!store.revoke(req.params.token, userOf(req))) {
      sendError(res, new AppError(ErrorCode.HTML_VIEW_TOKEN_INVALID));
      return;
    }
    res.status(204).end();
  });

  // GET /api/html-view/<token>/<path>
  viewRouter.get(/^\/([^/]+)(?:\/(.*))?$/, isolationHeaders, async (req: Request, res: Response) => {
    const match = /^\/([^/]+)(?:\/(.*))?$/.exec(req.path);
    const token = match?.[1] ?? '';
    const target = store.use(token);
    if (target === null) {
      sendError(res, new AppError(ErrorCode.HTML_VIEW_TOKEN_INVALID));
      return;
    }
    let relative: string;
    try {
      relative = (match?.[2] ?? '').split('/').map((s) => decodeURIComponent(s)).join('/');
    } catch {
      store.record(token, match?.[2] ?? '', 'blocked');
      sendError(res, new AppError(ErrorCode.PATH_TRAVERSAL));
      return;
    }
    const logged = relative.replace(/\\/g, '/');
    const outcome = (result: HtmlViewResult): void => store.record(token, logged, result);
    let file: { path: string; size: number };
    try {
      file = await fileService.resolveHtmlViewFile(target.sessionId, target.root, relative);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.SESSION_NOT_FOUND) {
        sendError(res, new AppError(ErrorCode.HTML_VIEW_TOKEN_INVALID));
        return;
      }
      outcome(err instanceof AppError && err.code === ErrorCode.PATH_NOT_FOUND ? 'not-found' : 'blocked');
      sendError(res, err);
      return;
    }
    outcome('loaded');
    res.status(200);
    res.set({ 'Content-Type': htmlViewContentType(file.path), 'Content-Length': String(file.size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file.path);
    stream.on('error', (err) => {
      console.error('[HtmlViewRoutes] Read failed:', err.message);
      res.destroy(err);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  // Anything else under the route still gets the isolation headers and no listing.
  viewRouter.use(isolationHeaders, (_req, res) => {
    sendError(res, new AppError(ErrorCode.HTML_VIEW_TOKEN_INVALID));
  });

  return { sessionRouter, viewRouter };
}
