// FR-FOP-007 AC-4, AC-5, FR-FEX-027 AC-5 (#140): the extraction pre-count. It reads every header of
// the archive the way the extraction job does and says how big the result is and where smart
// extraction would put it, so the client can ask before a large extraction. A refusal the job
// would raise (too large, unsupported, damaged) comes back in the body with its reason; a path the
// file API refuses is an error. Behind the JWT.
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { FileService } from '../services/FileService.js';
import { precountArchive } from '../services/archive/extractJob.js';
import { isArchiveError } from '../services/archive/archiveReader.js';
import { pathExists, resolveNameCollisionAsync } from '../services/fileNameCollision.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  console.error('[ArchiveRoutes] Unexpected error:', err instanceof Error ? err.name : typeof err);
  res.status(500).json(new AppError(ErrorCode.INTERNAL_ERROR).toJSON());
}

/** Pre-counts one session may run at once; a gzip tar is read end to end. */
export const MAX_CONCURRENT_PRECOUNTS = 2;

export function createArchiveRoutes(fileService: FileService, options: { precount?: typeof precountArchive } = {}): Router {
  const router = Router();
  const precount = options.precount ?? precountArchive;
  const running = new Map<string, number>();

  // POST /api/sessions/:id/files/extract/precount  { path, mode: 'smart' | 'here' }
  router.post('/:id/files/extract/precount', async (req: Request<{ id: string }>, res: Response) => {
    const sessionId = req.params.id;
    const active = running.get(sessionId) ?? 0;
    if (active >= MAX_CONCURRENT_PRECOUNTS) {
      sendError(res, new AppError(ErrorCode.PRECOUNT_BUSY));
      return;
    }
    running.set(sessionId, active + 1);
    // A client that leaves (closed tab, cancelled confirm) stops the walk.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const body = (req.body ?? {}) as { path?: unknown; mode?: unknown };
      if (typeof body.path !== 'string' || body.path === '') throw new AppError(ErrorCode.INVALID_INPUT, 'path is required');
      if (body.mode !== 'smart' && body.mode !== 'here') throw new AppError(ErrorCode.INVALID_INPUT, 'mode must be smart or here');
      const archive = await fileService.resolveDownload(req.params.id, body.path);
      const folder = path.dirname(archive.path);
      res.set('Cache-Control', 'no-store');
      try {
        const counted = await precount(archive.path, fileService.extractLimits, undefined, controller.signal);
        const wanted = counted.singleTopFolder ?? counted.stem;
        const targetName = body.mode === 'here'
          ? path.basename(folder)
          : await resolveNameCollisionAsync(wanted, (candidate) => pathExists(path.join(folder, candidate)));
        res.json({
          format: counted.format,
          entryCount: counted.entryCount,
          unpackedBytes: counted.unpackedBytes,
          packedBytes: counted.packedBytes,
          singleTopFolder: counted.singleTopFolder,
          targetName,
          refusal: null,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!isArchiveError(err)) throw err;
        res.json({ refusal: { code: err.code, reason: err.publicReason } });
      }
    } catch (err) {
      if (!controller.signal.aborted) sendError(res, err);
    } finally {
      const left = (running.get(sessionId) ?? 1) - 1;
      if (left <= 0) running.delete(sessionId);
      else running.set(sessionId, left);
    }
  });

  return router;
}
