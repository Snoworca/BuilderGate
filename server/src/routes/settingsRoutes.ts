import { Router, Request, Response } from 'express';
import { SettingsService } from '../services/SettingsService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

export function createSettingsRoutes(settingsService: SettingsService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(settingsService.getSettingsSnapshot());
  });

  router.patch('/', (req: Request, res: Response) => {
    try {
      const result = settingsService.savePatch(req.body, {
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      });
      res.json(result);
    } catch (error) {
      handleError(error, res);
    }
  });

  return router;
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }

  console.error('[SettingsRoutes] Unexpected error:', error);
  res.status(500).json({
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
    },
  });
}
