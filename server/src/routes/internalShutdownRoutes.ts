import { Router, type Request } from 'express';
import type { GracefulShutdownResult } from '../services/gracefulShutdown.js';

const SHUTDOWN_TOKEN_HEADER = 'x-buildergate-shutdown-token';

export interface InternalShutdownRouteOptions {
  env?: NodeJS.ProcessEnv;
  token?: string;
  performShutdown: (reason: string) => Promise<GracefulShutdownResult | Record<string, unknown>>;
  getRemoteAddress?: (req: Request) => string | undefined;
  scheduleExitDelayMs?: number;
  exit?: (code: number) => void;
}

export function isInternalShutdownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === 'production'
    && env.BUILDERGATE_INTERNAL_MODE === 'app'
    && typeof env.BUILDERGATE_SHUTDOWN_TOKEN === 'string'
    && env.BUILDERGATE_SHUTDOWN_TOKEN.trim() !== ''
  );
}

export function isLoopbackSocketAddress(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function getHeaderToken(req: Request): string {
  const header = req.headers[SHUTDOWN_TOKEN_HEADER];
  if (Array.isArray(header)) {
    return header[0] ?? '';
  }
  return typeof header === 'string' ? header : '';
}

function jsonError(code: string, message: string): { error: { code: string; message: string; timestamp: string } } {
  return {
    error: {
      code,
      message,
      timestamp: new Date().toISOString(),
    },
  };
}

export function createInternalShutdownRoutes(options: InternalShutdownRouteOptions): Router {
  const router = Router();
  const env = options.env ?? process.env;
  const token = options.token ?? env.BUILDERGATE_SHUTDOWN_TOKEN ?? '';
  const enabled = isInternalShutdownEnabled(env) && token.trim() !== '';

  if (!enabled) {
    return router;
  }

  const getRemoteAddress = options.getRemoteAddress ?? ((req: Request) => req.socket.remoteAddress);
  const scheduleExitDelayMs = options.scheduleExitDelayMs ?? 25;
  const exit = options.exit ?? process.exit;

  router.post('/shutdown', async (req, res) => {
    if (!isLoopbackSocketAddress(getRemoteAddress(req))) {
      res.status(403).json(jsonError('LOCALHOST_ONLY', 'Internal shutdown is only available from loopback sockets.'));
      return;
    }

    if (getHeaderToken(req) !== token) {
      res.status(401).json(jsonError('INVALID_SHUTDOWN_TOKEN', 'Invalid internal shutdown token.'));
      return;
    }

    try {
      const result = await options.performShutdown('internal-shutdown');
      const payload: Record<string, unknown> = { ...result };
      payload.ok = true;
      res.status(200).json(payload);
      const timer = setTimeout(() => exit(0), scheduleExitDelayMs);
      timer.unref?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Shutdown] Internal shutdown failed:', message);
      res.status(500).json({
        ok: false,
        ...jsonError('SHUTDOWN_FAILED', message),
      });
    }
  });

  return router;
}
