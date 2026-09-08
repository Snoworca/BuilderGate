import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LocalHttpTestFixture {
  server: Server;
  endpoint: string;
  request(input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }>;
}

// REL-BGSTAB-001: real HTTP routing with fixture-owned pipe/socket transport.
// The endpoint/listen pattern is shared with WsRouterRestoreMetadata tests;
// ordinary HTTP fixtures do not instantiate their WS router or PTY manager.
export async function withLocalHttpServer<T>(
  app: RequestListener,
  run: (fixture: LocalHttpTestFixture) => Promise<T>,
): Promise<T> {
  const name = `buildergate-http-${process.pid}-${randomUUID()}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const server = createServer(app);
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let bound = false;
  let bindError: ((error: Error) => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      bindError = reject;
      server.once('error', bindError);
      server.listen(endpoint, resolve);
    });
    bound = true;
    if (bindError) server.off('error', bindError);
    return await run({
      server,
      endpoint,
      request: input => new Promise((resolve, reject) => {
        const req = request({
          socketPath: endpoint,
          agent: false,
          method: input.method,
          path: input.path,
          headers: input.headers,
        }, response => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => resolve({
            statusCode: response.statusCode!, // The response event follows a parsed HTTP status line.
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.once('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('Local HTTP fixture request timed out')));
        req.end(input.body);
      }),
    });
  } finally {
    if (bindError) server.off('error', bindError);
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Local HTTP fixture cleanup timed out')), 2000);
        server.close(error => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
    }
    // Only a successfully bound, freshly generated endpoint belongs to us.
    // A bind failure must never unlink a pre-existing Unix path.
    if (bound && process.platform !== 'win32' && existsSync(endpoint)) unlinkSync(endpoint);
  }
}
