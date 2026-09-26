import { Router, type Request, type Response } from 'express';
import type { SessionSnapshotService } from '../services/SessionSnapshotService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

// FR-AITUI-007 / FR-AITUI-008 — mounted behind the auth middleware (AC-5).

const MAX_TAB_IDS = 500;

function readTabIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Request body must be an object');
  }
  const { tabIds } = body as { tabIds?: unknown };
  if (!Array.isArray(tabIds) || tabIds.length > MAX_TAB_IDS || tabIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'tabIds must be an array of tab ids');
  }
  return [...new Set(tabIds as string[])];
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }
  console.error('[SessionSnapshot] Request failed:', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Session snapshot request failed' } });
}

export function createSessionSnapshotRoutes(service: SessionSnapshotService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/candidates', (_req: Request, res: Response) => {
    try {
      res.json({ candidates: service.getCandidates() });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      res.json(await service.save(readTabIds(req.body)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/restore', async (req: Request, res: Response) => {
    try {
      res.json(await service.restore(readTabIds(req.body)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/', async (_req: Request, res: Response) => {
    try {
      await service.discard();
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
