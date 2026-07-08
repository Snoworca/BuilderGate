import { Router, Request, Response } from 'express';
import { RecoveryOptionService } from '../services/RecoveryOptionService.js';
import type { CreateRecoveryOptionInput, RecoveryOption, UpdateRecoveryOptionInput } from '../types/recoveryOption.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface RecoveryOptionRouteHooks {
  onOptionUpdated?: (option: RecoveryOption) => void | Promise<void>;
  onOptionDeleted?: (id: string) => void | Promise<void>;
}

// @req SEC-AITUI-001
export function createRecoveryOptionRoutes(
  recoveryOptionService: RecoveryOptionService,
  hooks: RecoveryOptionRouteHooks = {},
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json({ options: recoveryOptionService.getAll() });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const option = await recoveryOptionService.createOption(readBodyObject(req.body) as unknown as CreateRecoveryOptionInput);
      res.status(201).json(option);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const option = await recoveryOptionService.updateOption(req.params.id, readBodyObject(req.body) as unknown as UpdateRecoveryOptionInput);
      await hooks.onOptionUpdated?.(option);
      res.json(option);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await recoveryOptionService.deleteOption(req.params.id);
      await hooks.onOptionDeleted?.(req.params.id);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/order', async (req: Request, res: Response) => {
    try {
      const { optionIds } = readBodyObject(req.body);
      await recoveryOptionService.reorderOptions(optionIds);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}

// @req SEC-AITUI-001
function readBodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option request body must be an object');
  }
  return body as Record<string, unknown>;
}

// @req SEC-AITUI-001
function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }

  console.error('[RecoveryOptionRoutes] Unexpected error:', error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
    },
  });
}
