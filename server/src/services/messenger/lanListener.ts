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
import { isValidAddressAllowList, matchesWhitelist } from '../McpSecurityContract.js';
import type { PeerAcceptHandlers, PeerSocket } from '../peer/peerLinkManager.js';
import { createPeerUpgradeHandler } from '../peer/peerWsTransport.js';

/** Loopback plus the private IPv4 ranges. */
/** FR-MSG-014 AC-4: the default allow list, the internal network. Loopback is allowed outside any list. */
export const LAN_WHITELIST: readonly string[] = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
export const DEFAULT_LAN_SETTINGS_PATH = './data/messenger/lan.json';

export interface LanListenerHandle {
  close(): Promise<void>;
}

export type LanOpenResult = { ok: true; handle: LanListenerHandle } | { ok: false; code: 'LAN_PORT_IN_USE' | 'LAN_TLS_UNAVAILABLE' };

/** FR-MSG-014 AC-3: http by default; https serves the main server certificate. */
export type LanProtocol = 'http' | 'https';
export const LAN_PROTOCOLS: readonly LanProtocol[] = Object.freeze(['http', 'https']);

export type LanStatus = {
  receiving: boolean;
  port: number;
  protocol: LanProtocol;
  allowList: string[];
};

export type LanSetResult = ({ ok: true } & LanStatus) | { ok: false; code: string; port?: number };

export type LanSetInput = { receiving: boolean; port?: number; protocol?: LanProtocol; allowList?: string[] };

export interface LanReceiver {
  status(): LanStatus;
  set(input: LanSetInput): Promise<LanSetResult>;
  /** FR-MSG-014 AC-4: loopback always; otherwise the saved allow list, read per request. */
  isAllowed(remoteAddress: string): boolean;
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

export function lanAddressAllowed(remoteAddress: string, allowList: readonly string[] = LAN_WHITELIST): boolean {
  return remoteAddress === '::1' || matchesWhitelist(remoteAddress, ['127.0.0.0/8', ...allowList]);
}

export function createLanReceiver(deps: {
  path?: string;
  defaultPort: number;
  open: (options: { port: number; protocol: LanProtocol }) => Promise<LanOpenResult>;
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

  const openOn = async (port: number, protocol: LanProtocol): Promise<LanSetResult> => {
    const opened = await deps.open({ port, protocol });
    if (!opened.ok) return { ok: false, code: opened.code, port };
    handle = opened.handle;
    return { ok: true, ...state, receiving: true, port, protocol };
  };

  const apply = async (input: LanSetInput): Promise<LanSetResult> => {
    const port = input.port ?? state.port;
    const protocol = input.protocol ?? state.protocol;
    const allowList = input.allowList ?? state.allowList;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, code: 'LAN_PORT_INVALID' };
    if (!LAN_PROTOCOLS.includes(protocol)) return { ok: false, code: 'LAN_PROTOCOL_INVALID' };
    if (!isValidAddressAllowList(allowList)) return { ok: false, code: 'LAN_ALLOW_LIST_INVALID' };
    // The allow list is read per request, so changing it alone never reopens the listener.
    const listenerUnchanged = input.receiving === state.receiving && port === state.port && protocol === state.protocol
      && (handle !== undefined) === input.receiving;
    if (!listenerUnchanged) {
      await close();
      if (input.receiving) {
        const opened = await openOn(port, protocol);
        if (!opened.ok) {
          state = { ...state, receiving: false };
          await save();
          return opened;
        }
      }
    }
    state = { receiving: input.receiving, port, protocol, allowList: [...allowList] };
    await save();
    return { ok: true, ...state, allowList: [...state.allowList] };
  };

  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    status: () => ({ ...state, allowList: [...state.allowList] }),
    set: (input) => serially(() => apply(input)),
    isAllowed: (remoteAddress) => lanAddressAllowed(remoteAddress, state.allowList),
    startFromSaved: () => serially(async () => (state.receiving && !handle ? openOn(state.port, state.protocol) : { ok: true, ...state })),
    stop: () => serially(close),
  };
}

export async function openLanPeerListener(options: {
  port: number;
  protocol: LanProtocol;
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
      { bindHost: '0.0.0.0', port: options.port, transportSecurity: options.protocol === 'https' ? 'direct_tls' : 'none' },
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
  const fallback: LanStatus = { receiving: false, port: defaultPort, protocol: 'http', allowList: [...LAN_WHITELIST] };
  if (!fs.existsSync(filePath)) return fallback;
  const parsed = parseRecord(fs.readFileSync(filePath, 'utf8'));
  if (!parsed) return fallback;
  const port = parsed.port;
  return {
    receiving: parsed.receiving === true,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : defaultPort,
    // A file saved before the protocol choice came from an https-only listener: keep https so the
    // wss:// addresses other PCs saved for this one keep working. Only a new install starts on http.
    protocol: LAN_PROTOCOLS.includes(parsed.protocol as LanProtocol) ? parsed.protocol as LanProtocol : 'https',
    allowList: isValidAddressAllowList(parsed.allowList) ? [...parsed.allowList] : fallback.allowList,
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
