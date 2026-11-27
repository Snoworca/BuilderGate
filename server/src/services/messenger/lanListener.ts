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
import { systemPeerClock, type PeerAcceptHandlers, type PeerClock, type PeerSocket } from '../peer/peerLinkManager.js';
import { createPeerUpgradeHandler } from '../peer/peerWsTransport.js';

/** Loopback plus the private IPv4 ranges. */
/** FR-MSG-014 AC-4: the default allow list, the internal network. Loopback is allowed outside any list. */
export const LAN_WHITELIST: readonly string[] = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
export const DEFAULT_LAN_SETTINGS_PATH = './data/messenger/lan.json';
/** FR-MSG-014 AC-6: a listener that is on but cannot open tries again after this, doubling up to the max. */
export const LAN_RETRY_MIN_MS = 5_000;
export const LAN_RETRY_MAX_MS = 60_000;

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
  /** FR-MSG-014 AC-6: why a listener that is on is not open; it is being tried again. */
  error?: string;
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
  timer?: Pick<PeerClock, 'setTimeout' | 'clearTimeout'>;
  /** FR-MSG-014 AC-6 (M2): receiving opened on a retry, or fell back to retrying; nobody asked, so tell. */
  onChange?: () => void;
}): LanReceiver {
  const filePath = path.resolve(deps.path ?? DEFAULT_LAN_SETTINGS_PATH);
  const timer = deps.timer ?? systemPeerClock;
  /** The saved choice; whether the listener is open is `handle`. */
  let state: LanStatus = loadLanStatus(filePath, deps.defaultPort);
  let handle: LanListenerHandle | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let openError: string | undefined;
  let retry: unknown;
  let retryMs = LAN_RETRY_MIN_MS;
  /** L1: set by stop(), so a retry that was already due does not open the listener after shutdown. */
  let stopped = false;

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

  const stopRetrying = () => {
    if (retry !== undefined) timer.clearTimeout(retry);
    retry = undefined;
    retryMs = LAN_RETRY_MIN_MS;
    openError = undefined;
  };

  /** FR-MSG-014 AC-6: a listener that is on but cannot open says why and tries again later. */
  const retryLater = (code: string) => {
    openError = code;
    if (retry !== undefined) timer.clearTimeout(retry);
    retry = timer.setTimeout(() => {
      retry = undefined;
      void serially(async () => {
        if (stopped) return;
        await openSaved();
        if (handle !== undefined) deps.onChange?.();
      });
    }, retryMs);
    retryMs = Math.min(retryMs * 2, LAN_RETRY_MAX_MS);
  };

  const openSaved = async (): Promise<LanSetResult> => {
    if (!state.receiving || handle) return { ok: true, ...state };
    const opened = await openOn(state.port, state.protocol);
    if (opened.ok) stopRetrying();
    else retryLater(opened.code);
    return opened;
  };

  const apply = async (input: LanSetInput): Promise<LanSetResult> => {
    const port = input.port ?? state.port;
    const protocol = input.protocol ?? state.protocol;
    const allowList = input.allowList ?? state.allowList;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, code: 'LAN_PORT_INVALID' };
    if (!LAN_PROTOCOLS.includes(protocol)) return { ok: false, code: 'LAN_PROTOCOL_INVALID' };
    if (!isValidAddressAllowList(allowList)) return { ok: false, code: 'LAN_ALLOW_LIST_INVALID' };
    // FR-MSG-014 AC-6 (L2): each apply starts the retry wait over.
    retryMs = LAN_RETRY_MIN_MS;
    // The allow list is read per request, so changing it alone never reopens the listener -- nor
    // tries to open one that is on and being retried (FR-MSG-014 AC-6, L2).
    const retrying = openError !== undefined;
    const listenerUnchanged = input.receiving === state.receiving && port === state.port && protocol === state.protocol
      && ((handle !== undefined) === input.receiving || (input.receiving && retrying));
    if (!listenerUnchanged) {
      await close();
      if (input.receiving) {
        const opened = await openOn(port, protocol);
        if (!opened.ok) {
          // FR-MSG-014 AC-6: a choice that is already on stays on and keeps trying; turning it on fails off.
          const keepOn = state.receiving;
          state = keepOn ? { receiving: true, port, protocol, allowList: [...allowList] } : { ...state, receiving: false };
          await save();
          if (keepOn) {
            retryLater(opened.code);
            deps.onChange?.();
          } else {
            stopRetrying();
          }
          return opened;
        }
      }
      stopRetrying();
    }
    state = { receiving: input.receiving, port, protocol, allowList: [...allowList] };
    await save();
    return { ok: true, ...view() };
  };

  // FR-MSG-014 AC-6: receiving means the listener is open, not only that it was turned on.
  const view = (): LanStatus => ({ ...state, receiving: handle !== undefined, allowList: [...state.allowList], ...(openError ? { error: openError } : {}) });

  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    status: view,
    set: (input) => serially(() => apply(input)),
    isAllowed: (remoteAddress) => lanAddressAllowed(remoteAddress, state.allowList),
    startFromSaved: () => serially(async () => {
      stopped = false;
      return openSaved();
    }),
    stop: () => serially(async () => {
      stopped = true;
      stopRetrying();
      await close();
    }),
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
