// FR-LOOP-001 AC-5: Tools › Loop over REST.
import { Router, Request, Response } from 'express';
import { LoopNotFoundError, LoopValidationError, type LoopService } from '../services/loop/LoopService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function handleError(res: Response, error: unknown): void {
  const appError = error instanceof LoopValidationError
    ? new AppError(ErrorCode.LOOP_INVALID, undefined, { reason: error.reason })
    : error instanceof LoopNotFoundError
      ? new AppError(ErrorCode.LOOP_NOT_FOUND)
      : error instanceof AppError ? error : null;
  if (appError) {
    res.status(appError.statusCode).json(appError.toJSON());
    return;
  }
  console.error('[Loop] Request failed:', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Loop request failed' } });
}

export function createLoopRoutes(service: LoopService): Router {
  const router = Router();
  const withLastRun = (loop: ReturnType<LoopService['list']>[number]) => ({ ...loop, lastRun: service.history(loop.id)[0] ?? null });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ loops: service.list().map(withLastRun) });
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      res.status(201).json({ loop: withLastRun(await service.create(req.body)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/:id', async (req: Request, res: Response) => {
    try {
      res.json({ loop: withLastRun(await service.update(req.params.id, req.body)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await service.remove(req.params.id);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/:id/runs', (req: Request, res: Response) => {
    try {
      if (!service.get(req.params.id)) throw new LoopNotFoundError(req.params.id);
      res.json({ runs: service.history(req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // A run can wait for hours, so this answers as soon as it has started (202).
  router.post('/:id/run', (req: Request, res: Response) => {
    try {
      res.status(202).json({ run: service.startNow(req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
