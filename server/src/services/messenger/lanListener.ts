// FR-MSG-014 (committee decision A): "receive connections from the company network". A second,
// dedicated TLS listener (0.0.0.0, the main server certificate) that takes only peer links
// (/mcp/peer) and address requests (/mcp/contact-request), from loopback and private IPv4 ranges,
// and never a request relayed by a proxy (forwarding headers).
// The MCP listener the local agents use is never touched.
//
//   createLanReceiver(deps)  the toggle: { receiving, port } in data/messenger/lan.json, opened at boot
//   openLanPeerListener(o)   the listener itself
//   lanAddressAllowed(addr)  the per-connection address check
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';
import type { SSLConfig } from '../../types/config.types.js';
import { closeMcpNodeHttpListener, createMcpNodeHttpListener } from '../McpNodeHttpListener.js';
import { matchesAnyCidr } from '../McpSecurityContract.js';
import type { PeerAcceptHandlers, PeerSocket } from '../peer/peerLinkManager.js';
import { createPeerUpgradeHandler } from '../peer/peerWsTransport.js';

/** Loopback plus the private IPv4 ranges. */
export const LAN_WHITELIST: readonly string[] = Object.freeze(['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
export const DEFAULT_LAN_SETTINGS_PATH = './data/messenger/lan.json';

export interface LanListenerHandle {
  close(): Promise<void>;
}

export type LanOpenResult = { ok: true; handle: LanListenerHandle } | { ok: false; code: 'LAN_PORT_IN_USE' | 'LAN_TLS_UNAVAILABLE' };

export type LanStatus = {
  receiving: boolean;
  port: number;
};

export type LanSetResult = ({ ok: true } & LanStatus) | { ok: false; code: string; port?: number };

export interface LanReceiver {
  status(): LanStatus;
  set(input: { receiving: boolean; port?: number }): Promise<LanSetResult>;
  /** Opens the listener when the saved choice is on (boot). */
  startFromSaved(): Promise<LanSetResult>;
  /** Closes the listener without changing the saved choice (shutdown). */
  stop(): Promise<void>;
}

/** A request relayed by a proxy names another client than the socket; the LAN listener takes none of them. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'] as const;

export function carriesForwardingHeader(headers: IncomingMessage['headers']): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

export function lanAddressAllowed(remoteAddress: string): boolean {
  return remoteAddress === '::1' || matchesAnyCidr(remoteAddress, LAN_WHITELIST);
}

export function createLanReceiver(deps: {
  path?: string;
  defaultPort: number;
  open: (port: number) => Promise<LanOpenResult>;
}): LanReceiver {
  const filePath = path.resolve(deps.path ?? DEFAULT_LAN_SETTINGS_PATH);
  let state: LanStatus = loadLanStatus(filePath, deps.defaultPort);
  let handle: LanListenerHandle | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const save = () => publishStoreAtomically(filePath, JSON.stringify({ version: 1, ...state }, null, 2), { writeBackup: false, ensureDirectory: true });

  const close = async () => {
    const current = handle;
    handle = undefined;
    await current?.close();
  };

  const openOn = async (port: number): Promise<LanSetResult> => {
    const opened = await deps.open(port);
    if (!opened.ok) return { ok: false, code: opened.code, port };
    handle = opened.handle;
    return { ok: true, receiving: true, port };
  };

  const apply = async (input: { receiving: boolean; port?: number }): Promise<LanSetResult> => {
    const port = input.port ?? state.port;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, code: 'LAN_PORT_INVALID' };
    const unchanged = input.receiving === state.receiving && port === state.port && (handle !== undefined) === input.receiving;
    if (unchanged) return { ok: true, ...state };
    await close();
    if (input.receiving) {
      const opened = await openOn(port);
      if (!opened.ok) {
        state = { receiving: false, port: state.port };
        await save();
        return opened;
      }
    }
    state = { receiving: input.receiving, port };
    await save();
    return { ok: true, ...state };
  };

  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    status: () => ({ ...state }),
    set: (input) => serially(() => apply(input)),
    startFromSaved: () => serially(async () => (state.receiving && !handle ? openOn(state.port) : { ok: true, ...state })),
    stop: () => serially(close),
  };
}

export async function openLanPeerListener(options: {
  port: number;
  sslConfig: SSLConfig;
  isAllowed: (remoteAddress: string) => boolean;
  /** The peer link manager's accept. Requests are tagged via: 'lan' so the hello check knows where they came from. */
  accept: (socket: PeerSocket, request: unknown) => PeerAcceptHandlers;
  /** Answers /mcp/contact-request; false for any other path. */
  contactRequest: (request: IncomingMessage, response: ServerResponse) => boolean;
}): Promise<LanOpenResult> {
  const admitted = (request: IncomingMessage) =>
    !carriesForwardingHeader(request.headers) && options.isAllowed(request.socket.remoteAddress ?? '');
  const onUpgrade = createPeerUpgradeHandler({
    manager: { accept: (socket, request) => options.accept(socket, { ...(request as Record<string, unknown>), via: 'lan' }) },
    isAllowed: admitted,
  });
  const onRawRequest = (request: IncomingMessage, response: ServerResponse) => {
    if (!admitted(request)) return answer(request, response, 403, 'LAN_ADDRESS_DENIED');
    if (options.contactRequest(request, response)) return true;
    return answer(request, response, 404, 'NOT_FOUND');
  };
  try {
    const handle = await createMcpNodeHttpListener(
      { bindHost: '0.0.0.0', port: options.port, transportSecurity: 'direct_tls' },
      () => ({ status: 404, body: { ok: false, code: 'NOT_FOUND' } }),
      { sslConfig: options.sslConfig, onRawRequest, onUpgrade },
    );
    return { ok: true, handle: { close: () => closeMcpNodeHttpListener(handle) } };
  } catch (error) {
    // Listening is I/O: a taken port or an unreadable certificate surfaces only as an error here.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EACCES') return { ok: false, code: 'LAN_PORT_IN_USE' };
    console.warn('[Messenger] LAN listener failed:', error instanceof Error ? error.message : String(error));
    return { ok: false, code: 'LAN_TLS_UNAVAILABLE' };
  }
}

function answer(request: IncomingMessage, response: ServerResponse, status: number, code: string): true {
  request.resume();
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: false, code }));
  return true;
}

function loadLanStatus(filePath: string, defaultPort: number): LanStatus {
  const fallback = { receiving: false, port: defaultPort };
  if (!fs.existsSync(filePath)) return fallback;
  const parsed = parseRecord(fs.readFileSync(filePath, 'utf8'));
  if (!parsed) return fallback;
  const port = parsed.port;
  return {
    receiving: parsed.receiving === true,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : defaultPort,
  };
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
