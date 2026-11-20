// FR-TODO-001/003/004: the to-do list over REST, for the panel.
import { Router, Request, Response } from 'express';
import { TodoNotFoundError, TodoValidationError, type TodoService } from '../services/todo/TodoService.js';

function handleError(res: Response, error: unknown): void {
  if (error instanceof TodoValidationError) {
    res.status(400).json({ error: { code: 'TODO_INVALID', message: error.message, details: { reason: error.reason } } });
    return;
  }
  if (error instanceof TodoNotFoundError) {
    res.status(404).json({ error: { code: 'TODO_NOT_FOUND', message: error.message } });
    return;
  }
  console.error('[Todo] Request failed:', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'To-do request failed' } });
}

function idOf(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0) return id;
  res.status(404).json({ error: { code: 'TODO_NOT_FOUND', message: `to-do not found: ${req.params.id}` } });
  return null;
}

export function createTodoRoutes(service: TodoService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({ todos: service.list() });
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const { parentId, title, detail } = req.body ?? {};
      res.status(201).json({ todo: await service.add({ parentId: parentId ?? null, title, detail }) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const id = idOf(req, res);
    if (id === null) return;
    try {
      const { title, detail, done } = req.body ?? {};
      res.json({ todo: await service.update(id, { title, detail, done }) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const id = idOf(req, res);
    if (id === null) return;
    try {
      res.json({ removed: await service.remove(id) });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
