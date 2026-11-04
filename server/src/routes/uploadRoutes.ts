// FR-FEX-023 (#139): file upload. The pre-check reports name conflicts and the files the server
// would refuse; the upload itself streams the raw request body into a hidden temporary file in the
// destination folder and renames it into place after the last byte. Both sit behind the JWT.
import { Router, type Request, type Response } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import type { FileService } from '../services/FileService.js';
import type { UploadTempRegistry } from '../services/upload/uploadTemp.js';
import { storeUploadBody, type UploadConflict } from '../services/upload/storeUpload.js';
import { pathExists, resolveNameCollisionAsync } from '../services/fileNameCollision.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { armRequestIdleTimeout, DEFAULT_UPLOAD_IDLE_TIMEOUT_MS } from '../middleware/requestBodyDeadline.js';

const DECISIONS: ReadonlySet<string> = new Set(['fail', 'overwrite', 'rename', 'skip']);

/** FR-FEX-023 AC-8: uploads one session may run at the same time. */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 6;

const REFUSAL_CODES: ReadonlySet<string> = new Set([
  ErrorCode.PATH_TRAVERSAL, ErrorCode.PATH_BLOCKED, ErrorCode.INVALID_UPLOAD_PATH, ErrorCode.FILE_TOO_LARGE,
]);

function sendError(res: Response, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  console.error('[UploadRoutes] Unexpected error:', err);
  res.status(500).json(new AppError(ErrorCode.INTERNAL_ERROR).toJSON());
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

export interface UploadRouteOptions {
  registry: UploadTempRegistry;
  maxConcurrentPerSession?: number;
  /** An upload with no body byte for this long is dropped (default 60 s). */
  idleTimeoutMs?: number;
  /** Opens the temp file for writing; tests replace it to inject write errors. */
  createWriteStream?: (filePath: string) => Writable;
}

export function createUploadRoutes(fileService: FileService, options: UploadRouteOptions): Router {
  const router = Router();
  const { registry } = options;
  const maxConcurrent = options.maxConcurrentPerSession ?? DEFAULT_MAX_CONCURRENT_UPLOADS;
  const running = new Map<string, number>();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;
  const openTempFile = options.createWriteStream;

  // POST /api/sessions/:id/files/upload/check  { dir, files: [{ path, size }] }
  router.post('/:id/files/upload/check', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const body = (req.body ?? {}) as { dir?: unknown; files?: unknown };
      const dir = typeof body.dir === 'string' ? body.dir : '';
      if (!Array.isArray(body.files)) throw new AppError(ErrorCode.INVALID_INPUT, 'files must be an array');
      const files = body.files.filter((f): f is { path: string; size?: unknown } => typeof (f as { path?: unknown })?.path === 'string');
      // The folder itself is checked once, and its error is the request's error.
      await fileService.resolveUploadTarget(req.params.id, dir, '_');
      const limit = fileService.maxUploadFileSize;
      const rejected: Array<{ path: string; code: string }> = [];
      const conflicts = new Map<string, Record<string, unknown>>();
      for (const file of files) {
        let target;
        try {
          target = await fileService.resolveUploadTarget(req.params.id, dir, file.path);
          if (typeof file.size === 'number' && file.size > limit) throw new AppError(ErrorCode.FILE_TOO_LARGE);
        } catch (err) {
          if (err instanceof AppError && REFUSAL_CODES.has(err.code)) {
            rejected.push({ path: file.path, code: err.code });
            continue;
          }
          throw err;
        }
        // A folder upload conflicts on its top-level name; the files inside follow that decision.
        const top = target.segments[0];
        if (conflicts.has(top)) continue;
        const existing = await fsp.lstat(path.join(target.dirPath, top)).catch(() => null);
        if (existing === null) continue;
        const uploadingFolder = target.segments.length > 1;
        const sameKind = existing.isDirectory() === uploadingFolder;
        conflicts.set(top, {
          path: top,
          existing: { size: existing.size, modified: existing.mtime.toISOString(), isDirectory: existing.isDirectory() },
          // FR-FOP-004 AC-7: a file never replaces a folder, nor a folder a file.
          decisions: sameKind ? ['overwrite', 'rename', 'skip'] : ['rename', 'skip'],
          renameTo: await resolveNameCollisionAsync(top, (candidate) => pathExists(path.join(target.dirPath, candidate))),
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ conflicts: [...conflicts.values()], rejected });
    } catch (err) {
      sendError(res, err);
    }
  });

  // PUT /api/sessions/:id/files/upload?dir=&path=&conflict=fail|overwrite|rename|skip  (raw bytes)
  router.put('/:id/files/upload', async (req: Request<{ id: string }>, res: Response) => {
    const sessionId = req.params.id;
    // Not tied to the server's request timeout (which a long upload would outlast), but a stalled
    // upload must not hold its slot and its temp file forever.
    armRequestIdleTimeout(req, idleTimeoutMs);
    const active = running.get(sessionId) ?? 0;
    if (active >= maxConcurrent) {
      sendError(res, new AppError(ErrorCode.UPLOAD_BUSY));
      return;
    }
    running.set(sessionId, active + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (running.get(sessionId) ?? 1) - 1;
      if (left <= 0) running.delete(sessionId);
      else running.set(sessionId, left);
    };
    res.once('close', release);

    try {
      const query = req.query as Record<string, unknown>;
      const dir = typeof query.dir === 'string' ? query.dir : '';
      const relativePath = typeof query.path === 'string' ? query.path : '';
      const conflict = (typeof query.conflict === 'string' ? query.conflict : 'fail') as UploadConflict;
      if (!DECISIONS.has(conflict)) throw new AppError(ErrorCode.INVALID_INPUT, 'conflict must be fail, overwrite, rename or skip');

      const target = await fileService.resolveUploadTarget(sessionId, dir, relativePath);
      const stored = await storeUploadBody({
        body: req,
        target: target.target,
        conflict,
        limit: fileService.maxUploadFileSize,
        registry,
        revalidateParent: (parent) => fileService.revalidateUploadParent(sessionId, target.realCwd, parent),
        openTempFile,
      });
      // The client went away (or went idle): there is nobody to answer.
      if (stored.kind === 'aborted') return;
      const relative = toPosix(path.relative(target.realCwd, stored.finalPath));
      if (stored.kind === 'skipped') {
        res.json({ name: path.basename(stored.finalPath), path: relative, size: 0, skipped: true });
        return;
      }
      res.json({ name: path.basename(stored.finalPath), path: relative, size: stored.size, skipped: false });
    } catch (err) {
      if (!res.headersSent && !req.complete) {
        // The rest of the body is not wanted: it is read and dropped (so the answer reaches the
        // client instead of a reset) and the connection closes once the answer is out.
        res.set('Connection', 'close');
        req.resume();
      }
      sendError(res, err);
    } finally {
      if (res.writableFinished || res.destroyed) release();
    }
  });

  return router;
}
