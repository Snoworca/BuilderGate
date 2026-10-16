// FR-FEX-021 (#130): file downloads. The token route sits under /api/sessions behind the JWT and
// checks the path with the file API's rules; the download route needs only the token, so a plain
// link can start the browser's own download (desktop and mobile), and streams the file.
import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { FileService } from '../services/FileService.js';
import type { DownloadTokenStore } from '../services/DownloadTokenStore.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  console.error('[DownloadRoutes] Unexpected error:', err);
  res.status(500).json(new AppError(ErrorCode.INTERNAL_ERROR).toJSON());
}

/** RFC 6266: an ASCII fallback name and the exact name as UTF-8. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function createDownloadTokenRoutes(fileService: FileService, store: DownloadTokenStore): Router {
  const router = Router();
  // POST /api/sessions/:id/files/download-token  { path }
  router.post('/:id/files/download-token', async (req: Request<{ id: string }, unknown, { path?: unknown }>, res: Response) => {
    try {
      const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!filePath) {
        res.status(400).json({ error: { code: ErrorCode.INVALID_INPUT, message: 'path is required' } });
        return;
      }
      const target = await fileService.resolveDownload(req.params.id, filePath);
      const token = store.issue({ sessionId: req.params.id, path: target.path, name: target.name });
      res.set('Cache-Control', 'no-store');
      res.json({ token, url: `/api/downloads/${token}`, name: target.name, size: target.size });
    } catch (err) {
      sendError(res, err);
    }
  });
  return router;
}

export function createDownloadRoutes(store: DownloadTokenStore): Router {
  const router = Router();
  // GET /api/downloads/:token
  router.get('/:token', async (req: Request<{ token: string }>, res: Response) => {
    const target = store.consume(req.params.token);
    if (target === null) {
      sendError(res, new AppError(ErrorCode.DOWNLOAD_TOKEN_INVALID));
      return;
    }
    // The file can change between the token and the download; it must still be a regular file.
    const stat = await fs.promises.stat(target.path).catch(() => null);
    if (stat === null) {
      sendError(res, new AppError(ErrorCode.PATH_NOT_FOUND));
      return;
    }
    if (!stat.isFile()) {
      sendError(res, new AppError(ErrorCode.NOT_A_FILE));
      return;
    }
    res.status(200);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': contentDisposition(target.name || path.basename(target.path)),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(target.path);
    stream.on('error', (err) => {
      console.error('[DownloadRoutes] Read failed:', err.message);
      res.destroy(err);
    });
    // A closed connection closes the file.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  return router;
}
