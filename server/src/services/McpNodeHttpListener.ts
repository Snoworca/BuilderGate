import http, { type IncomingMessage, type ServerResponse } from 'http';
import https from 'https';
import type { Duplex } from 'stream';
import type { SSLConfig } from '../types/config.types.js';
import { SSLService } from './SSLService.js';
import {
  buildMcpNodeRequestErrorResponse,
  readMcpIncomingRequestBody,
} from './McpNodeHttpBoundary.js';

type StringRecord = Record<string, unknown>;

export type McpNodeListenerHandle = {
  server: http.Server | https.Server;
  bindHost: string;
  port: number;
  listenerStatus: 'listening';
  activeConnectionCount: number;
  transportSecurity?: string;
  /** Sockets handed to onUpgrade (peer links); server.close() does not end them, so close does. */
  upgradedSockets?: Set<Duplex>;
};

export async function createMcpNodeHttpListener(
  configRecord: StringRecord,
  dispatch: (request: unknown) => unknown | Promise<unknown>,
  options: {
    sslConfig?: SSLConfig;
    /** FR-MCP-016: WebSocket upgrades (the peer link). Answers true when it took the request. */
    onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  } = {},
): Promise<McpNodeListenerHandle> {
  const bindHost = typeof configRecord.bindHost === 'string' ? configRecord.bindHost : '127.0.0.1';
  const port = Number(configRecord.port ?? 3333);
  const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
    void handleMcpNodeRequest(req, res, dispatch);
  };
  const sslService = new SSLService(options.sslConfig ?? { certPath: '', keyPath: '', caPath: '' });
  const server = configRecord.transportSecurity === 'direct_tls'
    ? https.createServer(sslService.getTLSOptions(await sslService.loadCertificates()), requestHandler)
    : http.createServer(requestHandler);
  const upgradedSockets = new Set<Duplex>();
  const handle: McpNodeListenerHandle = {
    server,
    bindHost,
    port,
    listenerStatus: 'listening',
    activeConnectionCount: 0,
    transportSecurity: typeof configRecord.transportSecurity === 'string' ? configRecord.transportSecurity : 'none',
    upgradedSockets,
  };
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!options.onUpgrade?.(request, socket, head)) {
      socket.destroy();
      return;
    }
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
  });
  server.on('connection', (socket) => {
    handle.activeConnectionCount += 1;
    socket.on('close', () => {
      handle.activeConnectionCount = Math.max(0, handle.activeConnectionCount - 1);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bindHost);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  handle.port = boundPort;
  return handle;
}

export async function closeMcpNodeHttpListener(handle: unknown): Promise<void> {
  const record = handle as Partial<McpNodeListenerHandle> | null;
  const server = record?.server;
  if (!server) {
    return;
  }
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // FR-MCP-016: a peer link keeps its socket alive with heartbeats, so close() would wait forever.
  // Turning MCP off or rebinding ends the links too; a remote must reconnect and authenticate again.
  for (const socket of record.upgradedSockets ?? []) socket.destroy();
  await closed;
}

async function handleMcpNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: (request: unknown) => unknown | Promise<unknown>,
): Promise<void> {
  try {
    const body = await readMcpIncomingRequestBody(req);
    const bearer = typeof req.headers.authorization === 'string'
      ? req.headers.authorization.match(/^Bearer\s+(.+)$/iu)?.[1]
      : undefined;
    const response = asRecord(await dispatch({
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname,
      headers: req.headers,
      credential: bearer ? classifyMcpBearerCredential(bearer) : undefined,
      body,
      remoteAddress: req.socket.remoteAddress ?? '',
    }));
    writeMcpNodeResponse(res, response);
  } catch (error) {
    console.warn('[MCP] Request handling failed:', error instanceof Error ? error.message : String(error));
    writeMcpNodeResponse(res, buildMcpNodeRequestErrorResponse(error));
  }
}

export function classifyMcpBearerCredential(token: string): StringRecord {
  return looksLikeBrowserJwt(token)
    ? { type: 'browser-jwt', token }
    : { type: 'mcp-capability', token };
}

function looksLikeBrowserJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as StringRecord;
    return payload.sub === 'admin'
      && typeof payload.jti === 'string'
      && typeof payload.exp === 'number';
  } catch {
    return false;
  }
}

function writeMcpNodeResponse(res: ServerResponse, response: StringRecord): void {
  const body = response.body ?? {};
  res.statusCode = typeof response.status === 'number' ? response.status : 500;
  for (const [name, value] of Object.entries(asRecord(response.headers))) {
    if (typeof value === 'string' || typeof value === 'number') {
      res.setHeader(name, value);
    }
  }
  res.setHeader('Content-Type', typeof response.contentType === 'string' ? response.contentType : 'application/json; charset=utf-8');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}
