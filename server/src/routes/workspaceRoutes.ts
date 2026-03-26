import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { initSSE, sendSSE } from '../utils/sse.js';
import { AppError } from '../utils/errors.js';
import type { WorkspaceService } from '../services/WorkspaceService.js';
import type { ShellType } from '../types/index.js';

// SSE client tracking
interface SSEClient {
  id: string;
  res: Response;
}

export function createWorkspaceRoutes(workspaceService: WorkspaceService): Router {
  const router = Router();
  const sseClients: Set<SSEClient> = new Set();

  // ============================================================================
  // SSE Broadcast Helper
  // ============================================================================

  function broadcast(event: string, data: object, excludeClientId?: string): void {
    for (const client of sseClients) {
      if (client.id !== excludeClientId) {
        try {
          sendSSE(client.res, event, data);
        } catch {
          sseClients.delete(client);
        }
      }
    }
  }

  // ============================================================================
  // Workspace SSE Endpoint — GET /api/workspaces/stream
  // Must be registered BEFORE /:id routes
  // ============================================================================

  router.get('/stream', (req: Request, res: Response) => {
    initSSE(res);

    const clientId = uuidv4();
    const client: SSEClient = { id: clientId, res };
    sseClients.add(client);

    // Send client ID so frontend can pass it in API calls
    sendSSE(res, 'connected', { clientId });

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(client);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    });
  });

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
      broadcast('workspace:reordered', { workspaceIds }, clientId);
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
      broadcast('workspace:created', workspace, clientId);
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
      broadcast('workspace:updated', { id: workspace.id, changes: req.body }, clientId);
      res.json(workspace);
    } catch (error) {
      handleError(res, error);
    }
  });

  // DELETE /api/workspaces/:id — Delete workspace
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const clientId = req.headers['x-client-id'] as string | undefined;
      broadcast('workspace:deleting', { id: req.params.id }, clientId);
      await workspaceService.deleteWorkspace(req.params.id);
      broadcast('workspace:deleted', { id: req.params.id }, clientId);
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
      broadcast('tab:added', tab, clientId);
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
      broadcast('tab:reordered', { workspaceId: req.params.id, tabIds }, clientId);
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
      broadcast('tab:updated', { id: tab.id, workspaceId: tab.workspaceId, changes: req.body }, clientId);
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
      broadcast('tab:removed', { id: req.params.tid, workspaceId: req.params.wid }, clientId);
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
      broadcast('tab:updated', { id: tab.id, workspaceId: tab.workspaceId, changes: { sessionId: tab.sessionId } }, clientId);
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
      broadcast('grid:updated', layout, clientId);
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
