import { Router, type Request, type Response } from 'express';
import type { SessionSnapshotService, SnapshotSaveItem } from '../services/SessionSnapshotService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

// FR-AITUI-007 / FR-AITUI-008 / FR-AITUI-013 / FR-AITUI-014 — mounted behind the auth middleware (AC-5).

const MAX_TAB_IDS = 500;
const MAX_ARGS = 64;

function isTabId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/** FR-AITUI-013 AC-3: the shape of one item; the service judges what it means. */
function readSaveItem(raw: unknown): SnapshotSaveItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Each item must be an object');
  }
  const item = raw as Record<string, unknown>;
  if (!isTabId(item.tabId)) throw new AppError(ErrorCode.INVALID_INPUT, 'Each item needs a tab id');
  const optionalString = (key: string, max: number): string | undefined => {
    const value = item[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > max) throw new AppError(ErrorCode.INVALID_INPUT, `${key} is invalid`);
    return value;
  };
  let args: string[] | undefined;
  if (item.args !== undefined) {
    if (!Array.isArray(item.args) || item.args.length > MAX_ARGS || item.args.some((arg) => typeof arg !== 'string')) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'args must be an array of strings');
    }
    args = item.args as string[];
  }
  return {
    tabId: item.tabId,
    mode: item.mode as SnapshotSaveItem['mode'],
    ...(item.agent !== undefined ? { agent: item.agent as SnapshotSaveItem['agent'] } : {}),
    ...(optionalString('launcher', 200) !== undefined ? { launcher: optionalString('launcher', 200) } : {}),
    ...(args ? { args } : {}),
    ...(optionalString('sessionId', 200) !== undefined ? { sessionId: optionalString('sessionId', 200) } : {}),
    ...(optionalString('command', 2000) !== undefined ? { command: optionalString('command', 2000) } : {}),
  };
}

function readSaveItems(body: unknown): SnapshotSaveItem[] {
  const { items } = body as { items?: unknown };
  if (!Array.isArray(items) || items.length > MAX_TAB_IDS) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'items must be an array');
  }
  return items.map(readSaveItem);
}

function readTabIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Request body must be an object');
  }
  const { tabIds } = body as { tabIds?: unknown };
  if (!Array.isArray(tabIds) || tabIds.length > MAX_TAB_IDS || tabIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'tabIds must be an array of tab ids');
  }
  return [...new Set(tabIds as string[])];
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }
  console.error('[SessionSnapshot] Request failed:', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Session snapshot request failed' } });
}

export function createSessionSnapshotRoutes(service: SessionSnapshotService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/candidates', (_req: Request, res: Response) => {
    try {
      res.json({ candidates: service.getCandidates() });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get('/preview', async (_req: Request, res: Response) => {
    try {
      res.json(await service.preview());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (body && typeof body === 'object' && !Array.isArray(body) && 'items' in body) {
        res.json(await service.saveAll(readSaveItems(body)));
        return;
      }
      res.json(await service.save(readTabIds(req.body)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/restore', async (req: Request, res: Response) => {
    try {
      res.json(await service.restore(readTabIds(req.body)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/retry', async (req: Request, res: Response) => {
    try {
      res.json({ item: await service.retry(readSaveItem(req.body)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete('/', async (_req: Request, res: Response) => {
    try {
      await service.discard();
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
