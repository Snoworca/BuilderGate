import { Router, Request, Response } from 'express';
import type { CommandPresetKind } from '../types/commandPreset.types.js';
import { CommandPresetService } from '../services/CommandPresetService.js';
import { AppError } from '../utils/errors.js';

export function createCommandPresetRoutes(commandPresetService: CommandPresetService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json({ presets: commandPresetService.getAll() });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const preset = await commandPresetService.createPreset(req.body);
      res.status(201).json(preset);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const preset = await commandPresetService.updatePreset(req.params.id, req.body);
      res.json(preset);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await commandPresetService.deletePreset(req.params.id);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/order', async (req: Request, res: Response) => {
    try {
      const { kind, presetIds } = req.body;
      await commandPresetService.reorderPresets(kind as CommandPresetKind, Array.isArray(presetIds) ? presetIds : []);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }

  console.error('[CommandPresetRoutes] Unexpected error:', error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
    },
  });
}
