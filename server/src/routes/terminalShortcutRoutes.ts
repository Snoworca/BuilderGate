import { Router, Request, Response } from 'express';
import { TerminalShortcutService } from '../services/TerminalShortcutService.js';
import { AppError } from '../utils/errors.js';

export function createTerminalShortcutRoutes(
  terminalShortcutService: TerminalShortcutService,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json(terminalShortcutService.getState());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put('/profile', async (req: Request, res: Response) => {
    try {
      res.json(await terminalShortcutService.setProfileSelection(req.body));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/bindings', async (req: Request, res: Response) => {
    try {
      const binding = await terminalShortcutService.createBinding(req.body);
      res.status(201).json(binding);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch('/bindings/:id', async (req: Request, res: Response) => {
    try {
      res.json(await terminalShortcutService.updateBinding(req.params.id, req.body));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/bindings/:id', async (req: Request, res: Response) => {
    try {
      await terminalShortcutService.deleteBinding(req.params.id);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/reset', async (req: Request, res: Response) => {
    try {
      res.json(await terminalShortcutService.resetScope(req.body));
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

  console.error('[TerminalShortcutRoutes] Unexpected error:', error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
    },
  });
}
