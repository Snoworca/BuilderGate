/**
 * Request body deadlines (FR-FEX-023, #139 review).
 *
 * Node's server-wide `requestTimeout` (300 s by default) cuts off any request whose body has not
 * fully arrived in time, and it has no per-route exception. A large upload on a slow link takes
 * longer than that, so the HTTPS server turns it off and this middleware puts it back for every
 * request except the upload PUT. The upload instead gets an idle timeout: it may take as long as
 * it needs, but not stall. Both apply before authentication, so an unauthenticated slow body is
 * bounded either way.
 */
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';

/** Node's default requestTimeout, which this middleware stands in for. */
export const DEFAULT_REQUEST_BODY_DEADLINE_MS = 300_000;
/** How long an upload may go without a byte before it is dropped. */
export const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 60_000;

const UPLOAD_PATH = /^\/api\/sessions\/[^/]+\/files\/upload(?:\?|$)/;

export function isUploadRequest(method: string | undefined, url: string | undefined): boolean {
  return method === 'PUT' && UPLOAD_PATH.test(url ?? '');
}

/**
 * Destroys `req` when no body byte arrives for `idleMs`, through the socket's own inactivity timer
 * (the HTTP parser resets it on every read, without taking the body out of the stream). The timer
 * is switched off once the body has fully arrived, so placing the file is not cut short; the
 * server sets its keep-alive timeout again when the response finishes.
 */
export function armRequestIdleTimeout(req: IncomingMessage, idleMs: number): void {
  if (req.complete) return;
  req.setTimeout(idleMs, () => {
    if (!req.complete) req.destroy(new Error(`No request body bytes for ${idleMs} ms`));
  });
  req.once('end', () => req.setTimeout(0));
}

export function createRequestBodyDeadline(options: { deadlineMs?: number; exemptIdleMs?: number } = {}): RequestHandler {
  const deadlineMs = options.deadlineMs ?? DEFAULT_REQUEST_BODY_DEADLINE_MS;
  const exemptIdleMs = options.exemptIdleMs ?? DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;
  return (req, res, next) => {
    if (isUploadRequest(req.method, req.originalUrl ?? req.url)) {
      armRequestIdleTimeout(req, exemptIdleMs);
    } else if (!req.complete) {
      const timer = setTimeout(() => {
        if (!req.complete) req.destroy(new Error(`Request body not received within ${deadlineMs} ms`));
      }, deadlineMs);
      const clear = (): void => clearTimeout(timer);
      req.once('end', clear);
      req.once('close', clear);
      res.once('close', clear);
    }
    next();
  };
}
