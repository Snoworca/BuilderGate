/**
 * File Manager Routes
 * Phase 4: File Manager Core
 *
 * All routes are mounted under /api/sessions/:id/
 * and protected by authMiddleware.
 */

import { Router, Request, Response } from 'express';
import type { FileService } from '../services/FileService.js';
import type { CopyRequest, MoveRequest, MkdirRequest } from '../types/file.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';

export function createFileRoutes(fileService: FileService): Router {
  const router = Router();

  // GET /api/sessions/:id/cwd
  router.get('/:id/cwd', async (req: Request, res: Response) => {
    try {
      const cwd = await fileService.getCwd(req.params.id);
      res.json({ cwd });
    } catch (err) {
      handleError(err, res);
    }
  });

  // GET /api/sessions/:id/files
  router.get('/:id/files', async (req: Request, res: Response) => {
    try {
      const targetPath = req.query.path as string | undefined;
      const listing = await fileService.listDirectory(req.params.id, targetPath);
      res.json(listing);
    } catch (err) {
      handleError(err, res);
    }
  });

  // GET /api/sessions/:id/files/read
  router.get('/:id/files/read', async (req: Request, res: Response) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path query parameter is required' } });
      }
      const content = await fileService.readFile(req.params.id, filePath);
      res.json(content);
    } catch (err) {
      handleError(err, res);
    }
  });

  // POST /api/sessions/:id/files/copy
  router.post('/:id/files/copy', async (req: Request<{ id: string }, {}, CopyRequest>, res: Response) => {
    try {
      const { source, destination } = req.body;
      if (!source || !destination) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'source and destination are required' } });
      }
      await fileService.copyFile(req.params.id, source, destination);
      res.json({ success: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  // POST /api/sessions/:id/files/move
  router.post('/:id/files/move', async (req: Request<{ id: string }, {}, MoveRequest>, res: Response) => {
    try {
      const { source, destination } = req.body;
      if (!source || !destination) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'source and destination are required' } });
      }
      await fileService.moveFile(req.params.id, source, destination);
      res.json({ success: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  // DELETE /api/sessions/:id/files
  router.delete('/:id/files', async (req: Request, res: Response) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path query parameter is required' } });
      }
      await fileService.deleteFile(req.params.id, filePath);
      res.json({ success: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  // POST /api/sessions/:id/files/mkdir
  router.post('/:id/files/mkdir', async (req: Request<{ id: string }, {}, MkdirRequest>, res: Response) => {
    try {
      const { path: dirPath, name } = req.body;
      if (!dirPath || !name) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path and name are required' } });
      }
      await fileService.createDirectory(req.params.id, dirPath, name);
      res.json({ success: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
  } else {
    console.error('[FileRoutes] Unexpected error:', err);
    res.status(500).json({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
        timestamp: new Date().toISOString(),
      },
    });
  }
}
