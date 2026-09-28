/**
 * File Manager Routes
 * Phase 4: File Manager Core
 *
 * All routes are mounted under /api/sessions/:id/
 * and protected by authMiddleware.
 */

import { FileSearchService } from '../services/FileSearchService.js';
import { Router, Request, Response } from 'express';
import type { FileService } from '../services/FileService.js';
import type { CopyRequest, MoveRequest, MkdirRequest, WriteRequest } from '../types/file.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';

const SVG_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

export function createFileRoutes(fileService: FileService): Router {
  // FR-FEX-013: one search service per router; searches are keyed by id and owned by a session.
  const searchService = new FileSearchService({
    resolveRoot: (sessionId, targetPath) => fileService.resolveSearchRoot(sessionId, targetPath),
  });
  const ownedSearch = (req: Request, res: Response): string | null => {
    const searchId = req.params.searchId;
    if (searchService.ownerOf(searchId) !== req.params.id) {
      res.status(404).json({ error: { code: 'INVALID_INPUT', message: 'Unknown search' } });
      return null;
    }
    return searchId;
  };

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

  // POST /api/sessions/:id/files/search — start a name search (FR-FEX-013)
  router.post('/:id/files/search', async (req: Request, res: Response) => {
    try {
      const { path: targetPath = '', query, includeIgnored } = (req.body ?? {}) as { path?: string; query?: string; includeIgnored?: boolean };
      if (typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'query is required' } });
      }
      const { id } = await searchService.start(req.params.id, { path: String(targetPath), query, includeIgnored: includeIgnored === true });
      res.status(202).json({ searchId: id });
    } catch (err) {
      handleError(err, res);
    }
  });

  // GET /api/sessions/:id/files/search/:searchId?after=N — results found since `after`
  router.get('/:id/files/search/:searchId', (req: Request, res: Response) => {
    try {
      const searchId = ownedSearch(req, res);
      if (searchId === null) return;
      const after = Number.parseInt(String(req.query.after ?? '0'), 10);
      res.json(searchService.poll(searchId, Number.isFinite(after) ? after : 0));
    } catch (err) {
      handleError(err, res);
    }
  });

  // DELETE /api/sessions/:id/files/search/:searchId — cancel
  router.delete('/:id/files/search/:searchId', (req: Request, res: Response) => {
    const searchId = ownedSearch(req, res);
    if (searchId === null) return;
    searchService.cancel(searchId);
    res.json({ success: true });
  });

  // GET /api/sessions/:id/files/stat — one path's attributes (FR-FEX-018)
  router.get('/:id/files/stat', async (req: Request, res: Response) => {
    try {
      const targetPath = req.query.path as string;
      if (!targetPath) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path query parameter is required' } });
      }
      res.json(await fileService.statPath(req.params.id, targetPath));
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

  // GET /api/sessions/:id/files/read-image
  // Raw image bytes. nosniff is set here, not left to helmet, so the MIME type
  // this route chose is the one the browser uses. SVG can carry script, so its
  // response replaces the page CSP with a sandbox that runs nothing.
  // @req IR-MDE-003
  // @req SEC-MDE-001
  router.get('/:id/files/read-image', async (req: Request, res: Response) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path query parameter is required' } });
      }
      const image = await fileService.readImageFile(req.params.id, filePath);
      res.set('Content-Type', image.mimeType);
      res.set('X-Content-Type-Options', 'nosniff');
      // Session file bytes must not land in the browser disk cache.
      res.set('Cache-Control', 'no-store');
      if (image.mimeType === 'image/svg+xml') {
        res.set('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
      }
      res.send(image.buffer);
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

  // POST /api/sessions/:id/files/write
  // @req IR-MDE-001
  router.post('/:id/files/write', async (req: Request<{ id: string }, {}, WriteRequest>, res: Response) => {
    try {
      const { path: filePath, content } = req.body;
      // content is tested by type, not truthiness: an empty string is what a
      // document the user emptied sends, and it has to be written.
      if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'path and content are required' } });
      }
      await fileService.writeFile(req.params.id, filePath, content);
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
