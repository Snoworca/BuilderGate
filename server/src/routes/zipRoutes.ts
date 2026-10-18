// FR-FEX-025 (#139): the ZIP download's pre-count, its single-use token and the job it reports
// progress through. All behind the JWT; the archive itself streams from GET /api/downloads/:token.
import { Router, type Request, type Response } from 'express';
import type { DownloadTokenStore } from '../services/DownloadTokenStore.js';
import type { ZipArchiveService } from '../services/ZipArchiveService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }
  console.error('[ZipRoutes] Unexpected error:', err);
  res.status(500).json(new AppError(ErrorCode.INTERNAL_ERROR).toJSON());
}

/** A non-empty array of strings ('' is the session root), or an INVALID_INPUT error. */
function readPaths(body: unknown): string[] {
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'paths must be a non-empty array of strings');
  }
  return paths as string[];
}

export function createZipRoutes(store: DownloadTokenStore, zip: ZipArchiveService): Router {
  const router = Router();

  // POST /api/sessions/:id/files/zip/precount  { paths }
  router.post('/:id/files/zip/precount', async (req: Request<{ id: string }>, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await zip.precount(req.params.id, readPaths(req.body)));
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/sessions/:id/files/zip/token  { paths }
  router.post('/:id/files/zip/token', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const paths = readPaths(req.body);
      // The count checks every path and sizes the job's progress bar.
      const counted = await zip.precount(req.params.id, paths);
      const jobId = zip.createJob(req.params.id, counted.totalBytes);
      const token = store.issue({ kind: 'zip', sessionId: req.params.id, paths, name: counted.name, jobId });
      res.set('Cache-Control', 'no-store');
      res.json({ token, url: `/api/downloads/${token}`, name: counted.name, jobId });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/sessions/:id/files/zip/jobs/:jobId
  router.get('/:id/files/zip/jobs/:jobId', (req: Request<{ id: string; jobId: string }>, res: Response) => {
    const job = zip.getJob(req.params.id, req.params.jobId);
    if (job === null) {
      sendError(res, new AppError(ErrorCode.ZIP_JOB_NOT_FOUND));
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json(job);
  });

  // DELETE /api/sessions/:id/files/zip/jobs/:jobId
  router.delete('/:id/files/zip/jobs/:jobId', (req: Request<{ id: string; jobId: string }>, res: Response) => {
    if (!zip.cancelJob(req.params.id, req.params.jobId)) {
      sendError(res, new AppError(ErrorCode.ZIP_JOB_NOT_FOUND));
      return;
    }
    res.json(zip.getJob(req.params.id, req.params.jobId));
  });

  return router;
}
