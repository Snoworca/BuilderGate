// FR-FOP-007 AC-4, AC-5, FR-FEX-027 AC-5 (#140): the extraction pre-count. It reads every header of
// the archive the way the extraction job does and says how big the result is and where smart
// extraction would put it, so the client can ask before a large extraction. A refusal the job
// would raise (too large, unsupported, damaged) comes back in the body with its reason; a path the
// file API refuses is an error. Behind the JWT.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { FileService } from '../services/FileService.js';
import { precountArchive } from '../services/archive/extractJob.js';
import { isArchiveError } from '../services/archive/archiveReader.js';
import { resolveNameCollision } from '../services/fileNameCollision.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  console.error('[ArchiveRoutes] Unexpected error:', err instanceof Error ? err.name : typeof err);
  res.status(500).json(new AppError(ErrorCode.INTERNAL_ERROR).toJSON());
}

export function createArchiveRoutes(fileService: FileService): Router {
  const router = Router();

  // POST /api/sessions/:id/files/extract/precount  { path, mode: 'smart' | 'here' }
  router.post('/:id/files/extract/precount', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const body = (req.body ?? {}) as { path?: unknown; mode?: unknown };
      if (typeof body.path !== 'string' || body.path === '') throw new AppError(ErrorCode.INVALID_INPUT, 'path is required');
      if (body.mode !== 'smart' && body.mode !== 'here') throw new AppError(ErrorCode.INVALID_INPUT, 'mode must be smart or here');
      const archive = await fileService.resolveDownload(req.params.id, body.path);
      const folder = path.dirname(archive.path);
      res.set('Cache-Control', 'no-store');
      try {
        const counted = await precountArchive(archive.path, fileService.extractLimits);
        const wanted = counted.singleTopFolder ?? counted.stem;
        const targetName = body.mode === 'here'
          ? path.basename(folder)
          : resolveNameCollision(wanted, (candidate) => fs.existsSync(path.join(folder, candidate)));
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
        if (!isArchiveError(err)) throw err;
        res.json({ refusal: { code: err.code, reason: err.publicReason } });
      }
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
