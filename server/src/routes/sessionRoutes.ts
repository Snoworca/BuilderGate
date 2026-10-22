import { Router, Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager.js';
import { CreateSessionRequest, UpdateSessionRequest, ShellType } from '../types/index.js';
import type { SessionCleanupReason } from '../types/ws-protocol.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface SessionRoutesOptions {
  onSessionDeleting?: (sessionId: string, reason: SessionCleanupReason) => unknown | Promise<unknown>;
  onSessionDeleted?: (sessionId: string, reason: SessionCleanupReason) => unknown | Promise<unknown>;
}

export function createSessionRoutes(options: SessionRoutesOptions = {}): Router {
  const router = Router();

  // GET /api/sessions - List all sessions
  router.get('/', (_req: Request, res: Response) => {
    const sessions = sessionManager.getAllSessions();
    res.json(sessions);
  });

  // GET /api/sessions/shells - Get available shells
  router.get('/shells', async (_req: Request, res: Response) => {
    const shells = await sessionManager.getAvailableShells();
    res.json(shells);
  });

  // POST /api/sessions - Create new session
  router.post('/', async (req: Request<{}, {}, CreateSessionRequest>, res: Response) => {
    const { name, shell, cwd } = req.body;

    // Validate shell parameter if provided
    if (shell !== undefined) {
      const validShells = new Set<ShellType>(['auto', ...(await sessionManager.getAvailableShells()).map((entry) => entry.id)]);
      if (!validShells.has(shell)) {
        return res.status(400).json({ error: { code: ErrorCode.INVALID_INPUT, message: `Invalid shell type: ${shell}` } });
      }
    }

    try {
      const session = sessionManager.createSession(name, shell, cwd);
      res.status(201).json(session);
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json(error.toJSON());
      }
      return res.status(500).json({ error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' } });
    }
  });

  // GET /api/sessions/:id - Get single session
  router.get('/:id', (req: Request, res: Response) => {
    const session = sessionManager.getSession(req.params.id);
    if (session) {
      res.json(session);
    } else {
      res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
    }
  });

  // DELETE /api/sessions/:id - Delete session
  router.delete('/:id', async (req: Request, res: Response) => {
    const reason: SessionCleanupReason = 'direct-session-delete';
    if (!sessionManager.hasSession(req.params.id)) {
      res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
      return;
    }

    try {
      await options.onSessionDeleting?.(req.params.id, reason);
      const success = await sessionManager.terminateSession(req.params.id, { reason });
      if (success) {
        await options.onSessionDeleted?.(req.params.id, reason);
        res.status(204).send();
      } else {
        res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
      }
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json(error.toJSON());
      }
      console.warn('[SessionRoutes] Failed to delete session:', error);
      return res.status(500).json({ error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' } });
    }
  });

  // PATCH /api/sessions/:id - Update session (rename, reorder)
  router.patch('/:id', (req: Request<{ id: string }, {}, UpdateSessionRequest>, res: Response) => {
    const updates = req.body;

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || updates.name.length === 0) {
        return res.status(400).json({ error: { code: ErrorCode.NAME_REQUIRED, message: 'Name cannot be empty' } });
      }
      if (updates.name.length > 50) {
        return res.status(400).json({ error: { code: ErrorCode.NAME_TOO_LONG, message: 'Name too long (max 50 characters)' } });
      }
      const validNameRegex = /^[\p{L}\p{N}\s\-_]+$/u;
      if (!validNameRegex.test(updates.name)) {
        return res.status(400).json({ error: { code: ErrorCode.INVALID_NAME, message: 'Name contains invalid characters' } });
      }
    }

    if (updates.sortOrder !== undefined) {
      if (!Number.isInteger(updates.sortOrder) || updates.sortOrder < 0) {
        return res.status(400).json({ error: { code: ErrorCode.INVALID_INPUT, message: 'Invalid sortOrder' } });
      }
    }

    try {
      const session = sessionManager.updateSession(req.params.id, updates);
      if (!session) {
        return res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
      }
      res.json(session);
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json(error.toJSON());
      }
      res.status(500).json({ error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' } });
    }
  });

  // POST /api/sessions/:id/reorder - Reorder session
  router.post('/:id/reorder', (req: Request<{ id: string }, {}, { direction: string }>, res: Response) => {
    const { direction } = req.body;

    if (!['up', 'down'].includes(direction)) {
      return res.status(400).json({ error: { code: ErrorCode.INVALID_INPUT, message: 'Invalid direction (must be "up" or "down")' } });
    }

    const success = sessionManager.reorderSessions(req.params.id, direction as 'up' | 'down');
    if (!success) {
      return res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
    }
    res.status(204).send();
  });

  // GET /api/sessions/:id/editor-wait - the GUI editor the session waits on, for a terminal that attaches late (FR-ARCH-014 AC-2)
  router.get('/:id/editor-wait', (req: Request<{ id: string }>, res: Response) => {
    if (!sessionManager.hasSession(req.params.id)) {
      return res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
    }
    res.json({ editor: sessionManager.getEditorWait(req.params.id) });
  });

  // POST /api/sessions/:id/editor-wait/close - end the GUI editor the session waits on (FR-ARCH-014 AC-4)
  router.post('/:id/editor-wait/close', async (req: Request<{ id: string }, {}, { pid?: unknown }>, res: Response) => {
    const pid = req.body?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: { code: ErrorCode.INVALID_INPUT, message: 'pid must be a positive integer' } });
    }
    try {
      const result = await sessionManager.closeEditorWait(req.params.id, pid);
      if (!result) {
        return res.status(404).json({ error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' } });
      }
      if (!result.ok) {
        return res.status(409).json({ error: { code: result.code, message: 'That editor is not the one this session is waiting on' } });
      }
      res.status(204).send();
    } catch (error) {
      // Express 4 does not catch a rejected handler; a failed process query or kill lands here.
      console.error('[Sessions] closing the waited-on editor failed:', error);
      res.status(500).json({ error: { code: ErrorCode.INTERNAL_ERROR, message: 'Could not close the editor' } });
    }
  });

  // NOTE: POST /:id/input, POST /:id/resize, GET /:id/stream
  // have been removed — now handled via WebSocket (Step 8)

  return router;
}

export default createSessionRoutes();
