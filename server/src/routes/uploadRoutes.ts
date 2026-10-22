// FR-FEX-023 (#139): file upload. The pre-check reports name conflicts and the files the server
// would refuse; the upload itself streams the raw request body into a hidden temporary file in the
// destination folder and renames it into place after the last byte. Both sit behind the JWT.
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { once } from 'node:events';
import type { FileService } from '../services/FileService.js';
import { newUploadTempName, type UploadTempRegistry } from '../services/upload/uploadTemp.js';
import { placeExclusively } from '../services/upload/placeExclusively.js';
import { pathExists, resolveNameCollisionAsync } from '../services/fileNameCollision.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { armRequestIdleTimeout, DEFAULT_UPLOAD_IDLE_TIMEOUT_MS } from '../middleware/requestBodyDeadline.js';

type ConflictDecision = 'fail' | 'overwrite' | 'rename' | 'skip';
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

function fsError(err: unknown, action: string): AppError {
  if (err instanceof AppError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return new AppError(ErrorCode.PERMISSION_DENIED);
  // A file where a folder of the path should be.
  if (code === 'EEXIST' || code === 'ENOTDIR') return new AppError(ErrorCode.FILE_ALREADY_EXISTS);
  if (code === 'ENOSPC') return new AppError(ErrorCode.FILE_OPERATION_FAILED, 'No space left on the device');
  return new AppError(ErrorCode.FILE_OPERATION_FAILED, `${action} failed: ${(err as Error).message}`);
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

type ReceiveOutcome = { kind: 'done'; size: number } | { kind: 'aborted' } | { kind: 'failed'; error: unknown };

/**
 * Copies the request body into the temp file. The request is piped, never put in a pipeline: a
 * write error or the size limit stops the writing but leaves the request alone, so the client can
 * still be answered. A request that closes before its last byte is the client going away. The temp
 * file is closed before this returns, which Windows needs to rename or delete it.
 */
async function receiveBody(req: Request, tempPath: string, limit: number, open: (filePath: string) => Writable): Promise<ReceiveOutcome> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        callback(new AppError(ErrorCode.FILE_TOO_LARGE));
        return;
      }
      callback(null, chunk);
    },
  });
  const file = open(tempPath);
  const outcome = await new Promise<ReceiveOutcome>((resolve) => {
    let settled = false;
    const settle = (value: ReceiveOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.once('aborted', () => settle({ kind: 'aborted' }));
    req.once('close', () => {
      if (!req.complete) settle({ kind: 'aborted' });
    });
    counter.once('error', (error) => settle({ kind: 'failed', error }));
    file.once('error', (error) => settle({ kind: 'failed', error }));
    file.once('finish', () => settle({ kind: 'done', size }));
    req.pipe(counter).pipe(file);
  });
  if (outcome.kind !== 'done') {
    req.unpipe(counter);
    counter.unpipe(file);
    counter.destroy();
    if (!file.destroyed) file.destroy();
  }
  if (!(file as Writable & { closed?: boolean }).closed) await once(file, 'close').catch(() => undefined);
  return outcome;
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
  // 'wx': the random name is ours alone.
  const openTempFile = options.createWriteStream ?? ((filePath: string) => fs.createWriteStream(filePath, { flags: 'wx' }));

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

    let tempPath: string | null = null;
    const discardTemp = async (): Promise<void> => {
      if (tempPath === null) return;
      const stale = tempPath;
      tempPath = null;
      await fsp.unlink(stale).catch(() => undefined);
      await registry.remove(stale);
    };

    try {
      const query = req.query as Record<string, unknown>;
      const dir = typeof query.dir === 'string' ? query.dir : '';
      const relativePath = typeof query.path === 'string' ? query.path : '';
      const conflict = (typeof query.conflict === 'string' ? query.conflict : 'fail') as ConflictDecision;
      if (!DECISIONS.has(conflict)) throw new AppError(ErrorCode.INVALID_INPUT, 'conflict must be fail, overwrite, rename or skip');

      const target = await fileService.resolveUploadTarget(sessionId, dir, relativePath);
      const limit = fileService.maxUploadFileSize;
      const declared = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
      if (declared !== null && (!Number.isFinite(declared) || declared < 0)) throw new AppError(ErrorCode.INVALID_INPUT, 'Invalid Content-Length');
      // AC-4: refused before a byte is written when the declared size is already too large.
      if (declared !== null && declared > limit) throw new AppError(ErrorCode.FILE_TOO_LARGE);

      let finalPath = target.target;
      const existing = await fsp.lstat(finalPath).catch(() => null);
      if (existing !== null) {
        if (conflict === 'skip') {
          res.json({ name: path.basename(finalPath), path: toPosix(path.relative(target.realCwd, finalPath)), size: 0, skipped: true });
          return;
        }
        // AC-7: a conflict is answered without writing; overwrite never replaces a folder.
        if (conflict === 'fail' || (conflict === 'overwrite' && existing.isDirectory())) {
          throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
        }
      }

      const parent = path.dirname(finalPath);
      try {
        await fsp.mkdir(parent, { recursive: true });
      } catch (err) {
        throw fsError(err, 'Create directory');
      }
      await fileService.revalidateUploadParent(sessionId, target.realCwd, parent);

      tempPath = path.join(parent, newUploadTempName());
      await registry.add(tempPath);
      const outcome = await receiveBody(req, tempPath, limit, openTempFile);
      if (outcome.kind === 'aborted') {
        // The client went away (or went idle): there is nobody to answer.
        await discardTemp();
        return;
      }
      if (outcome.kind === 'failed') {
        // The server stopped writing; the client is still there and gets the reason.
        throw outcome.error instanceof AppError ? outcome.error : fsError(outcome.error, 'Write');
      }
      const received = outcome.size;

      // AC-7: placed without replacing anything unless overwrite was asked for, so a name taken
      // while the bytes arrived (another upload, a shell) is never lost.
      if (conflict === 'overwrite') {
        const now = await fsp.lstat(finalPath).catch(() => null);
        if (now?.isDirectory()) throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
        try {
          await fsp.rename(tempPath, finalPath);
        } catch (err) {
          throw fsError(err, 'Rename');
        }
      } else {
        try {
          finalPath = await placeExclusively(tempPath, finalPath, conflict === 'rename');
        } catch (err) {
          throw fsError(err, 'Place');
        }
        await fsp.unlink(tempPath).catch(() => undefined);
      }
      const placed = tempPath;
      tempPath = null;
      await registry.remove(placed);
      res.json({ name: path.basename(finalPath), path: toPosix(path.relative(target.realCwd, finalPath)), size: received, skipped: false });
    } catch (err) {
      await discardTemp();
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
