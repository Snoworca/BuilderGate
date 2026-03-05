import { Router, Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager.js';
import { initSSE } from '../utils/sse.js';
import { CreateSessionRequest, InputRequest, ResizeRequest, UpdateSessionRequest, ShellType } from '../types/index.js';
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
    const validShells: ShellType[] = ['auto', 'powershell', 'wsl', 'bash'];
    if (!validShells.includes(shell)) {
      return res.status(400).json({ error: `Invalid shell type: ${shell}` });
    }
  }

  const session = sessionManager.createSession(name, shell, cwd);
  res.status(201).json(session);
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

// POST /api/sessions/:id/input - Send input to session
router.post('/:id/input', (req: Request<{ id: string }, {}, InputRequest>, res: Response) => {
  const { data } = req.body;
  const success = sessionManager.writeInput(req.params.id, data);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// POST /api/sessions/:id/resize - Resize terminal
router.post('/:id/resize', (req: Request<{ id: string }, {}, ResizeRequest>, res: Response) => {
  const { cols, rows } = req.body;
  const success = sessionManager.resize(req.params.id, cols, rows);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// GET /api/sessions/:id/stream - SSE stream for session
router.get('/:id/stream', (req: Request, res: Response) => {
  const sessionId = req.params.id;

  // Check if session exists
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Initialize SSE
  initSSE(res);

  // Add this client to the session's SSE clients
  sessionManager.addSSEClient(sessionId, res);

  // Handle client disconnect
  req.on('close', () => {
    sessionManager.removeSSEClient(sessionId, res);
  });
});

export default router;
