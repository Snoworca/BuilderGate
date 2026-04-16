import type express from 'express';

interface SessionLookup {
  hasSession: (sessionId: string) => boolean;
}

export function isLoopbackRequest(ip?: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip ?? '');
}

export function requireLocalDebugCapture(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (isLoopbackRequest(req.ip)) {
    next();
    return;
  }

  res.status(403).json({
    error: {
      code: 'LOCALHOST_ONLY',
      message: 'Debug capture is only available from localhost.',
      timestamp: new Date().toISOString(),
    },
  });
}

export function ensureDebugCaptureSessionExists(sessionLookup: SessionLookup) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (sessionLookup.hasSession(req.params.id)) {
      next();
      return;
    }

    res.status(404).json({
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found.',
        timestamp: new Date().toISOString(),
      },
    });
  };
}
