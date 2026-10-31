// FR-USAGE-005 / FR-USAGE-006: usage limits over REST.
import { Router, Request, Response } from 'express';
import { UsageSettingsError, type UsageLimitsService } from '../services/usage/UsageLimitsService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function handleError(res: Response, error: unknown): void {
  const appError = error instanceof UsageSettingsError
    ? new AppError(ErrorCode.INVALID_INPUT, undefined, { field: error.field })
    : error instanceof AppError ? error : null;
  if (appError) {
    res.status(appError.statusCode).json(appError.toJSON());
    return;
  }
  console.error('[Usage] Request failed:', error instanceof Error ? error.message : error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Usage limits request failed' } });
}

export function createUsageLimitsRoutes(service: Pick<UsageLimitsService, 'getState' | 'refresh' | 'updateSettings' | 'testChannel'>): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      res.json(await service.getState());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/refresh', async (_req: Request, res: Response) => {
    try {
      await service.refresh();
      res.json(await service.getState());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/settings', async (req: Request, res: Response) => {
    try {
      await service.updateSettings(req.body ?? {});
      res.json(await service.getState());
    } catch (error) {
      handleError(res, error);
    }
  });

  // FR-USAGE-006 AC-5: the send's outcome is the answer, so a failed send is still a 200.
  router.post('/test', async (req: Request, res: Response) => {
    try {
      const channel = req.body?.channel;
      if (channel !== 'googleChat' && channel !== 'telegram') throw new AppError(ErrorCode.INVALID_INPUT, undefined, { field: 'channel' });
      res.json(await service.testChannel(channel, req.body?.values ?? {}));
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
