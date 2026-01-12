import { Router, Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager.js';
import { initSSE } from '../utils/sse.js';
import { CreateSessionRequest, InputRequest, ResizeRequest } from '../types/index.js';

const router = Router();

// GET /api/sessions - List all sessions
router.get('/', (_req: Request, res: Response) => {
  const sessions = sessionManager.getAllSessions();
  res.json(sessions);
});

// POST /api/sessions - Create new session
router.post('/', (req: Request<{}, {}, CreateSessionRequest>, res: Response) => {
  const { name } = req.body;
  const session = sessionManager.createSession(name);
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
