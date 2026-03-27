import { Router, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import type { WorkspaceService } from '../services/WorkspaceService.js';
import type { WsRouter } from '../ws/WsRouter.js';
import type { ShellType } from '../types/index.js';

export function createWorkspaceRoutes(workspaceService: WorkspaceService): Router {
  const router = Router();

  // Helper to get WsRouter from Express app
  function getWsRouter(req: Request): WsRouter | undefined {
    return req.app.get('wsRouter') as WsRouter | undefined;
  }

  // ============================================================================
  // Broadcast Helper (WS only — SSE removed in Step 8)
  // ============================================================================

  function broadcast(event: string, data: object, excludeClientId?: string, req?: Request): void {
    if (req) {
      const wsRouter = getWsRouter(req);
      wsRouter?.broadcastAll(event, data, excludeClientId);
    }
  }

  // NOTE: GET /stream SSE endpoint removed — now handled via WebSocket (Step 8)

  // ============================================================================
  // Workspace CRUD — PUT /order must be before /:id
  // ============================================================================

  // GET /api/workspaces — Full state
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const state = workspaceService.getState();
      res.json(state);
    } catch (error) {
      handleError(res, error);
    }
  });

  // PUT /api/workspaces/order — Reorder workspaces (before /:id)
  router.put('/order', async (req: Request, res: Response) => {
    try {
      const { workspaceIds } = req.body;
      await workspaceService.reorderWorkspaces(workspaceIds);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('workspace:reordered', { workspaceIds }, clientId, req);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /api/workspaces — Create workspace
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      const workspace = await workspaceService.createWorkspace(name);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('workspace:created', workspace, clientId, req);
      res.status(201).json(workspace);
    } catch (error) {
      handleError(res, error);
    }
  });

  // PATCH /api/workspaces/:id — Update workspace
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const workspace = await workspaceService.updateWorkspace(req.params.id, req.body);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('workspace:updated', { id: workspace.id, changes: req.body }, clientId, req);
      res.json(workspace);
    } catch (error) {
      handleError(res, error);
    }
  });

  // DELETE /api/workspaces/:id — Delete workspace
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('workspace:deleting', { id: req.params.id }, clientId, req);
      await workspaceService.deleteWorkspace(req.params.id);
      broadcast('workspace:deleted', { id: req.params.id }, clientId, req);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  // ============================================================================
  // Tab Management
  // ============================================================================

  // POST /api/workspaces/:id/tabs — Add tab
  router.post('/:id/tabs', async (req: Request, res: Response) => {
    try {
      const { shell, name } = req.body;
      const tab = await workspaceService.addTab(req.params.id, shell as ShellType | undefined, name);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('tab:added', tab, clientId, req);
      res.status(201).json(tab);
    } catch (error) {
      handleError(res, error);
    }
  });

  // PUT /api/workspaces/:id/tab-order — Reorder tabs
  router.put('/:id/tab-order', async (req: Request, res: Response) => {
    try {
      const { tabIds } = req.body;
      await workspaceService.reorderTabs(req.params.id, tabIds);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('tab:reordered', { workspaceId: req.params.id, tabIds }, clientId, req);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  // PATCH /api/workspaces/:wid/tabs/:tid — Update tab
  router.patch('/:wid/tabs/:tid', async (req: Request, res: Response) => {
    try {
      const tab = await workspaceService.updateTab(req.params.tid, req.body);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('tab:updated', { id: tab.id, workspaceId: tab.workspaceId, changes: req.body }, clientId, req);
      res.json(tab);
    } catch (error) {
      handleError(res, error);
    }
  });

  // DELETE /api/workspaces/:wid/tabs/:tid — Delete tab
  router.delete('/:wid/tabs/:tid', async (req: Request, res: Response) => {
    try {
      await workspaceService.deleteTab(req.params.wid, req.params.tid);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('tab:removed', { id: req.params.tid, workspaceId: req.params.wid }, clientId, req);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /api/workspaces/:wid/tabs/:tid/restart — Restart tab
  router.post('/:wid/tabs/:tid/restart', async (req: Request, res: Response) => {
    try {
      const tab = await workspaceService.restartTab(req.params.wid, req.params.tid);
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('tab:updated', { id: tab.id, workspaceId: tab.workspaceId, changes: { sessionId: tab.sessionId } }, clientId, req);
      res.json(tab);
    } catch (error) {
      handleError(res, error);
    }
  });

  // ============================================================================
  // Grid Layout
  // ============================================================================

  // PUT /api/workspaces/:id/grid — Update grid layout
  router.put('/:id/grid', async (req: Request, res: Response) => {
    try {
      const { columns, rows, tabOrder, cellSizes } = req.body;
      const layout = await workspaceService.updateGridLayout(req.params.id, { columns, rows, tabOrder, cellSizes });
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('grid:updated', layout, clientId, req);
      res.json(layout);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}

// ============================================================================
// Error Handler
// ============================================================================

function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
  } else {
    console.error('[WorkspaceRoutes] Unexpected error:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', timestamp: new Date().toISOString() } });
  }
}
