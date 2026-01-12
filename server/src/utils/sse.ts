import { Response } from 'express';

export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Disable Nagle algorithm for immediate packet sending
  if (res.socket) {
    res.socket.setNoDelay(true);
  }
}

export function sendSSE(res: Response, event: string, data: object): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Force flush the response (works with compression middleware if present)
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}

export function sendSSEComment(res: Response, comment: string): void {
  res.write(`: ${comment}\n\n`);
}
