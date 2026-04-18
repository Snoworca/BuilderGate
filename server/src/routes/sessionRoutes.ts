import { Router, Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager.js';
import { CreateSessionRequest, UpdateSessionRequest, ShellType } from '../types/index.js';
import { AppError } from '../utils/errors.js';

const router = Router();

// GET /api/sessions - List all sessions
router.get('/', (_req: Request, res: Response) => {
  const sessions = sessionManager.getAllSessions();
  res.json(sessions);
});

// GET /api/sessions/shells - Get available shells
router.get('/shells', (_req: Request, res: Response) => {
  const shells = sessionManager.getAvailableShells();
  res.json(shells);
});

// POST /api/sessions - Create new session
router.post('/', (req: Request<{}, {}, CreateSessionRequest>, res: Response) => {
  const { name, shell, cwd } = req.body;

  // Validate shell parameter if provided
  if (shell !== undefined) {
    const validShells = new Set<ShellType>(['auto', ...sessionManager.getAvailableShells().map((entry) => entry.id)]);
    if (!validShells.has(shell)) {
      return res.status(400).json({ error: `Invalid shell type: ${shell}` });
    }
  }

  try {
    const session = sessionManager.createSession(name, shell, cwd);
    res.status(201).json(session);
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json(error.toJSON());
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/sessions/:id - Get single session
router.get('/:id', (req: Request, res: Response) => {
  const session = sessionManager.getSession(req.params.id);
  if (session) {
    res.json(session);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// DELETE /api/sessions/:id - Delete session
router.delete('/:id', (req: Request, res: Response) => {
  const success = sessionManager.deleteSession(req.params.id);
  if (success) {
    res.status(204).send();
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// PATCH /api/sessions/:id - Update session (rename, reorder)
router.patch('/:id', (req: Request<{ id: string }, {}, UpdateSessionRequest>, res: Response) => {
  const updates = req.body;

  if (updates.name !== undefined) {
    if (typeof updates.name !== 'string' || updates.name.length === 0) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }
    if (updates.name.length > 50) {
      return res.status(400).json({ error: 'Name too long (max 50 characters)' });
    }
    const validNameRegex = /^[\p{L}\p{N}\s\-_]+$/u;
    if (!validNameRegex.test(updates.name)) {
      return res.status(400).json({ error: 'Name contains invalid characters' });
    }
  }

  if (updates.sortOrder !== undefined) {
    if (!Number.isInteger(updates.sortOrder) || updates.sortOrder < 0) {
      return res.status(400).json({ error: 'Invalid sortOrder' });
    }
  }

  try {
    const session = sessionManager.updateSession(req.params.id, updates);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json(error.toJSON());
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/sessions/:id/reorder - Reorder session
router.post('/:id/reorder', (req: Request<{ id: string }, {}, { direction: string }>, res: Response) => {
  const { direction } = req.body;

  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction (must be "up" or "down")' });
  }

  const success = sessionManager.reorderSessions(req.params.id, direction as 'up' | 'down');
  if (!success) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.status(204).send();
});

// NOTE: POST /:id/input, POST /:id/resize, GET /:id/stream
// have been removed — now handled via WebSocket (Step 8)

export default router;
