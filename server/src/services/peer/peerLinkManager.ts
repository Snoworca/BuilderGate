// FR-MCP-016..FR-MCP-019 (#233): the MCP peer link. One WebSocket, opened by the dialer, carries
// requests both ways. This module holds the protocol -- handshake, heartbeat, timeout, reconnect,
// the per-link message queue with sequence numbers, results as acknowledgements, and duplicate
// suppression -- over a transport-neutral socket, so it runs on a fake clock in tests.
// The WebSocket transport is peerWsTransport.ts.
import { randomUUID } from 'node:crypto';
import {
  effectivePeerTimeoutMs,
  PEER_NAME_PATTERN,
  type PeerLinkEntry,
  type PeerLinkSettings,
} from './peerLinkSettings.js';

export interface PeerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemPeerClock: PeerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PeerSocket {
  send(text: string): void;
  close(): void;
}

export interface PeerDialHandlers {
  onOpen(): void;
  onText(text: string): void;
  onClose(reason?: string): void;
}

export interface PeerAcceptHandlers {
  onText(text: string): void;
  onClose(reason?: string): void;
}

/** Who a request that arrived over a link runs as (FR-MCP-019 AC-5). */
export interface PeerActor {
  type: 'mcp-peer';
  peer: string;
  scopes: string[];
}

export type PeerResult = Record<string, unknown>;

export interface PeerLinkManagerDeps {
  clock?: PeerClock;
  random?: () => number;
  createEpoch?: () => string;
  dial: (link: PeerLinkEntry, handlers: PeerDialHandlers) => PeerSocket;
  /** FR-MCP-016 AC-4: checks the key a dialer sent in hello. */
  authenticate: (key: string, request: unknown) => Promise<{ ok: true; scopes: string[] } | { ok: false; code: string }>;
  /** Runs an MCP tool for a request that arrived over a link. */
  callTool: (tool: string, args: Record<string, unknown>, actor: PeerActor) => Promise<PeerResult>;
  audit?: (event: Record<string, unknown>) => void;
}

export type PeerLinkState = 'connecting' | 'connected' | 'disconnected';
export type PeerMessageStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'expired' | 'unknown';

export interface PeerStatus {
  name: string;
  direction: 'outbound' | 'inbound';
  state: PeerLinkState;
  queued: number;
  lastError?: string;
  connectedAt?: string;
}

export interface PeerMessageView {
  messageId: string;
  peer: string;
  seq: number;
  status: PeerMessageStatus;
  result?: PeerResult;
}

export interface PeerLinkManager {
  start(): void;
  stop(): void;
  applySettings(settings: PeerLinkSettings): void;
  accept(socket: PeerSocket, request: unknown): PeerAcceptHandlers;
  hasPeer(name: string): boolean;
  sendMessage(input: { peer: string; args: Record<string, unknown>; scopes: string[]; hasKeys: boolean }): Promise<PeerResult>;
  call(input: { peer: string; tool: string; arguments: Record<string, unknown>; scopes: string[] }): Promise<PeerResult>;
  list(): PeerStatus[];
  messageStatus(messageId: string): PeerMessageView | undefined;
  /** Closes every link a remote opened here; they must authenticate again (key rotated, MCP off). */
  dropInbound(): void;
}

/** FR-MCP-019 AC-2: how long a send waits for its result before answering "queued". */
export const PEER_SEND_WAIT_MS = 3_000;
/** FR-MCP-019 AC-4. */
export const PEER_CALL_TIMEOUT_MS = 30_000;
/** FR-MCP-016 AC-4. */
export const PEER_HELLO_WAIT_MS = 10_000;
/** FR-MCP-017 AC-1: the shortest heartbeat interval either side will use. */
export const PEER_MIN_HEARTBEAT_MS = 1_000;
/** FR-MCP-017 AC-3. */
export const PEER_BACKOFF_MIN_MS = 1_000;
export const PEER_BACKOFF_MAX_MS = 30_000;
const PEER_BACKOFF_JITTER = 0.2;
/** FR-MCP-018 AC-7. */
const PEER_MESSAGE_HISTORY = 500;
/** FR-MCP-018 AC-4: results remembered per sender epoch, and sender epochs remembered. */
const INBOX_RESULTS = 64;
const INBOX_EPOCHS = 64;
const PROTOCOL_VERSION = 1;
const PEER_TOOL_PREFIX = 'buildergate.peer.';

type Frame = Record<string, unknown> & { t: string };

interface Connection {
  socket: PeerSocket;
  role: 'dialer' | 'acceptor';
  ready: boolean;
  closed: boolean;
  peer?: Peer;
  /** FR-MCP-019 AC-5: scopes a request arriving on this connection may use at most. */
  linkScopes: () => string[];
  heartbeatMs: number;
  heartbeatTimer?: unknown;
  watchTimer?: unknown;
  request: unknown;
  helloSeen?: boolean;
}

interface OutboxEntry {
  messageId: string;
  peer: string;
  seq: number;
  args: Record<string, unknown>;
  scopes: string[];
  bytes: number;
  status: PeerMessageStatus;
  sentOn?: Connection;
  result?: PeerResult;
  expiryTimer?: unknown;
  waiters: Array<() => void>;
}

interface PendingCall {
  resolve: (result: PeerResult) => void;
  timer: unknown;
}

interface Peer {
  name: string;
  /**
   * FR-MCP-018 AC-1: the sender epoch of this peer's queue. A new Peer (a link turned off and on,
   * removed and added) gets a new one, so its sequence restarting at 1 is not taken as a duplicate.
   */
  epoch: string;
  direction: 'outbound' | 'inbound';
  link?: PeerLinkEntry;
  conn?: Connection;
  dialing?: Connection;
  state: PeerLinkState;
  lastError?: string;
  connectedAt?: number;
  outbox: OutboxEntry[];
  nextSeq: number;
  backoffMs: number;
  waitLongest: boolean;
  retryTimer?: unknown;
  calls: Map<string, PendingCall>;
  /** Runs incoming messages one at a time (FR-MCP-018 AC-3). */
  runChain: Promise<unknown>;
}

interface InboxBox {
  last: number;
  results: Map<number, Promise<PeerResult>>;
}

export function createPeerLinkManager(deps: PeerLinkManagerDeps, initial: PeerLinkSettings): PeerLinkManager {
  const clock = deps.clock ?? systemPeerClock;
  const random = deps.random ?? Math.random;
  const createEpoch = deps.createEpoch ?? randomUUID;
  const peers = new Map<string, Peer>();
  const messages = new Map<string, OutboxEntry>();
  const finished: string[] = [];
  const inbox = new Map<string, InboxBox>();
  let settings = initial;
  let started = false;

  const audit = (event: Record<string, unknown>) => deps.audit?.({ at: new Date(clock.now()).toISOString(), ...event });

  // -------------------------------------------------------------------------------------------
  // Peers

  const newPeer = (name: string, direction: Peer['direction'], link?: PeerLinkEntry): Peer => ({
    name,
    epoch: createEpoch(),
    direction,
    link,
    state: 'disconnected',
    outbox: [],
    nextSeq: 1,
    backoffMs: PEER_BACKOFF_MIN_MS,
    waitLongest: false,
    calls: new Map(),
    runChain: Promise.resolve(),
  });

  const syncLinks = () => {
    const wanted = new Map(settings.links.filter((link) => link.enabled).map((link) => [link.name, link]));
    for (const peer of [...peers.values()]) {
      if (peer.direction !== 'outbound') continue;
      const link = wanted.get(peer.name);
      if (!link) {
        removePeer(peer);
      } else if (!sameLink(peer.link!, link)) {
        peer.link = link;
        restartOutbound(peer);
      }
    }
    for (const link of wanted.values()) {
      if (peers.get(link.name)?.direction === 'outbound') continue;
      const inbound = peers.get(link.name);
      if (inbound) dropConnection(inbound.conn);
      const peer = newPeer(link.name, 'outbound', link);
      if (inbound) {
        peer.outbox = inbound.outbox;
        peer.nextSeq = inbound.nextSeq;
      }
      peers.set(link.name, peer);
      if (started) dial(peer);
    }
  };

  const removePeer = (peer: Peer) => {
    peers.delete(peer.name);
    cancelRetry(peer);
    dropConnection(peer.dialing);
    dropConnection(peer.conn);
    for (const entry of [...peer.outbox]) finish(peer, entry, entry.sentOn || entry.status === 'sent' ? 'unknown' : 'expired');
  };

  const restartOutbound = (peer: Peer) => {
    cancelRetry(peer);
    dropConnection(peer.dialing);
    dropConnection(peer.conn);
    peer.backoffMs = PEER_BACKOFF_MIN_MS;
    if (started) dial(peer);
  };

  const cancelRetry = (peer: Peer) => {
    if (peer.retryTimer !== undefined) clock.clearTimeout(peer.retryTimer);
    peer.retryTimer = undefined;
  };

  /** Closes a connection and forgets it; its own close event then has nothing to undo. */
  const dropConnection = (conn: Connection | undefined) => {
    if (!conn) return;
    detach(conn);
    conn.socket.close();
  };

  // -------------------------------------------------------------------------------------------
  // Connections

  const send = (conn: Connection, frame: Record<string, unknown>) => {
    if (!conn.closed) conn.socket.send(JSON.stringify(frame));
  };

  /** Closes a connection that broke; a dialer then tries again (FR-MCP-017 AC-3). */
  const closeAndRetry = (conn: Connection) => {
    const peer = conn.peer;
    const current = peer !== undefined && (peer.conn === conn || peer.dialing === conn);
    dropConnection(conn);
    if (peer && current && peer.direction === 'outbound' && peers.get(peer.name) === peer) scheduleRetry(peer);
  };

  const bye = (conn: Connection, code: string) => {
    send(conn, { t: 'bye', code });
    closeAndRetry(conn);
  };

  const watch = (conn: Connection, ms: number) => {
    if (conn.watchTimer !== undefined) clock.clearTimeout(conn.watchTimer);
    conn.watchTimer = clock.setTimeout(() => {
      if (conn.closed) return;
      audit({ event: 'peer.timeout', peer: conn.peer?.name, role: conn.role });
      if (conn.peer) conn.peer.lastError = 'PEER_TIMEOUT';
      closeAndRetry(conn);
    }, ms);
  };

  const beat = (conn: Connection) => {
    conn.heartbeatTimer = clock.setTimeout(() => {
      if (conn.closed) return;
      send(conn, { t: 'hb' });
      beat(conn);
    }, conn.heartbeatMs);
  };

  /** Stops a connection's timers and unlinks it from its peer; the socket is left to the caller. */
  const detach = (conn: Connection) => {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.heartbeatTimer !== undefined) clock.clearTimeout(conn.heartbeatTimer);
    if (conn.watchTimer !== undefined) clock.clearTimeout(conn.watchTimer);
    const peer = conn.peer;
    if (!peer) return;
    if (peer.dialing === conn) peer.dialing = undefined;
    if (peer.conn !== conn) return;
    peer.conn = undefined;
    peer.state = 'disconnected';
    peer.connectedAt = undefined;
    for (const entry of peer.outbox) entry.sentOn = undefined;
    for (const [id, pending] of peer.calls) {
      clock.clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'PEER_DISCONNECTED', peer: peer.name });
      peer.calls.delete(id);
    }
    audit({ event: 'peer.disconnected', peer: peer.name, direction: peer.direction });
    forgetIfIdle(peer);
  };

  /** An inbound peer that is gone and has nothing queued is forgotten, so "name/..." is local again. */
  const forgetIfIdle = (peer: Peer) => {
    if (peer.direction === 'inbound' && !peer.conn && peer.outbox.length === 0 && peers.get(peer.name) === peer) {
      peers.delete(peer.name);
    }
  };

  /** The transport reports the socket closed. A connection this side already dropped is detached and stays put. */
  const onClosed = (conn: Connection) => {
    if (!conn.closed) closeAndRetry(conn);
  };

  const becomeReady = (conn: Connection, peer: Peer, remoteHeartbeatMs: number) => {
    conn.ready = true;
    conn.peer = peer;
    conn.heartbeatMs = Math.max(PEER_MIN_HEARTBEAT_MS, Math.min(settings.heartbeatMs, remoteHeartbeatMs));
    if (peer.dialing === conn) peer.dialing = undefined;
    peer.conn = conn;
    peer.state = 'connected';
    peer.connectedAt = clock.now();
    peer.lastError = undefined;
    peer.backoffMs = PEER_BACKOFF_MIN_MS;
    peer.waitLongest = false;
    watch(conn, effectivePeerTimeoutMs(settings));
    beat(conn);
    audit({ event: 'peer.connected', peer: peer.name, direction: peer.direction });
    flush(peer);
  };

  const dial = (peer: Peer) => {
    const link = peer.link!;
    if (!link.accessKey) {
      // FR-MCP-020 AC-2: a key that could not be read here (another machine) is asked for again.
      peer.state = 'disconnected';
      peer.lastError = 'PEER_KEY_MISSING';
      return;
    }
    const conn: Connection = {
      socket: { send: () => {}, close: () => {} },
      role: 'dialer',
      ready: false,
      closed: false,
      peer,
      linkScopes: () => settings.inboundScopes,
      heartbeatMs: settings.heartbeatMs,
      request: undefined,
    };
    peer.dialing = conn;
    peer.state = 'connecting';
    const handlers: PeerDialHandlers = {
      onOpen: () => {
        if (conn.closed) return;
        send(conn, { t: 'hello', v: PROTOCOL_VERSION, node: settings.nodeName, epoch: peer.epoch, heartbeatMs: settings.heartbeatMs, key: link.accessKey });
        watch(conn, effectivePeerTimeoutMs(settings));
      },
      onText: (text) => receive(conn, text),
      onClose: (reason) => {
        if (!conn.closed && !conn.ready && reason) {
          peer.lastError = reason;
          // FR-MCP-017 AC-4: a certificate that is not the pinned one will not change by itself.
          peer.waitLongest = reason === 'PEER_TLS_FINGERPRINT_MISMATCH';
        }
        onClosed(conn);
      },
    };
    const socket = tryDial(link, handlers);
    if (typeof socket === 'string') {
      peer.lastError = socket;
      closeAndRetry(conn);
      return;
    }
    conn.socket = socket;
  };

  const tryDial = (link: PeerLinkEntry, handlers: PeerDialHandlers): PeerSocket | string => {
    try {
      return deps.dial(link, handlers);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const scheduleRetry = (peer: Peer) => {
    if (!started || peer.retryTimer !== undefined) return;
    peer.state = 'disconnected';
    const base = peer.waitLongest ? PEER_BACKOFF_MAX_MS : peer.backoffMs;
    const delay = Math.round(base * (1 + (random() * 2 - 1) * PEER_BACKOFF_JITTER));
    peer.backoffMs = Math.min(peer.backoffMs * 2, PEER_BACKOFF_MAX_MS);
    peer.retryTimer = clock.setTimeout(() => {
      peer.retryTimer = undefined;
      if (peers.get(peer.name) === peer && started) dial(peer);
    }, delay);
  };

  const accept = (socket: PeerSocket, request: unknown): PeerAcceptHandlers => {
    const conn: Connection = {
      socket,
      role: 'acceptor',
      ready: false,
      closed: false,
      linkScopes: () => [],
      heartbeatMs: settings.heartbeatMs,
      request,
    };
    watch(conn, PEER_HELLO_WAIT_MS);
    return {
      onText: (text) => receive(conn, text),
      onClose: () => onClosed(conn),
    };
  };

  const handleHello = async (conn: Connection, frame: Frame) => {
    const node = frame.node;
    if (frame.v !== PROTOCOL_VERSION || typeof node !== 'string' || !PEER_NAME_PATTERN.test(node)
      || typeof frame.epoch !== 'string' || !isPositiveInt(frame.heartbeatMs) || typeof frame.key !== 'string') {
      bye(conn, 'PEER_PROTOCOL_ERROR');
      return;
    }
    // Stop the hello wait while the key is checked; the check has no time limit of its own.
    if (conn.watchTimer !== undefined) clock.clearTimeout(conn.watchTimer);
    const auth = await deps.authenticate(frame.key, conn.request);
    if (conn.closed) return;
    if (!auth.ok) {
      audit({ event: 'peer.auth_failed', node, code: auth.code });
      bye(conn, auth.code);
      return;
    }
    const existing = peers.get(node);
    if (existing?.direction === 'outbound') {
      bye(conn, 'PEER_NAME_IN_USE');
      return;
    }
    const peer = existing ?? newPeer(node, 'inbound');
    if (peer.conn) dropConnection(peer.conn);
    peers.set(node, peer);
    const scopes = [...auth.scopes];
    conn.linkScopes = () => scopes;
    send(conn, { t: 'welcome', v: PROTOCOL_VERSION, node: settings.nodeName, epoch: peer.epoch, heartbeatMs: settings.heartbeatMs });
    becomeReady(conn, peer, frame.heartbeatMs as number);
  };

  const receive = (conn: Connection, text: string) => {
    if (conn.closed) return;
    const frame = parseFrame(text);
    if (!frame) {
      bye(conn, 'PEER_PROTOCOL_ERROR');
      return;
    }
    if (!conn.ready) {
      receiveBeforeReady(conn, frame);
      return;
    }
    watch(conn, effectivePeerTimeoutMs(settings));
    const peer = conn.peer!;
    switch (frame.t) {
      case 'hb':
        return;
      case 'bye':
        peer.lastError = typeof frame.code === 'string' ? frame.code : 'PEER_CLOSED';
        closeAndRetry(conn);
        return;
      case 'msg':
        receiveMessage(conn, peer, frame);
        return;
      case 'msg-result':
        receiveMessageResult(peer, frame);
        return;
      case 'call':
        void receiveCall(conn, peer, frame);
        return;
      case 'call-result':
        receiveCallResult(peer, frame);
        return;
      default:
        bye(conn, 'PEER_PROTOCOL_ERROR');
    }
  };

  const receiveBeforeReady = (conn: Connection, frame: Frame) => {
    if (conn.role === 'acceptor') {
      if (frame.t !== 'hello' || conn.helloSeen) {
        bye(conn, 'PEER_PROTOCOL_ERROR');
        return;
      }
      conn.helloSeen = true;
      void handleHello(conn, frame);
      return;
    }
    const peer = conn.peer!;
    if (frame.t === 'bye') {
      peer.lastError = typeof frame.code === 'string' ? frame.code : 'PEER_CLOSED';
      peer.waitLongest = peer.lastError === 'PEER_AUTH_FAILED' || peer.lastError === 'PEER_NAME_IN_USE';
      closeAndRetry(conn);
      return;
    }
    if (frame.t !== 'welcome' || !isPositiveInt(frame.heartbeatMs)) {
      peer.lastError = 'PEER_PROTOCOL_ERROR';
      closeAndRetry(conn);
      return;
    }
    becomeReady(conn, peer, frame.heartbeatMs as number);
  };

  // -------------------------------------------------------------------------------------------
  // Messages out (FR-MCP-018)

  const flush = (peer: Peer) => {
    const conn = peer.conn;
    if (!conn) return;
    for (const entry of peer.outbox) {
      if (entry.sentOn === conn) continue;
      entry.sentOn = conn;
      entry.status = 'sent';
      send(conn, { t: 'msg', epoch: peer.epoch, seq: entry.seq, args: entry.args, scopes: entry.scopes });
    }
  };

  const finish = (peer: Peer, entry: OutboxEntry, status: PeerMessageStatus, result?: PeerResult) => {
    const index = peer.outbox.indexOf(entry);
    if (index >= 0) peer.outbox.splice(index, 1);
    if (entry.expiryTimer !== undefined) clock.clearTimeout(entry.expiryTimer);
    entry.status = status;
    entry.result = result;
    entry.sentOn = undefined;
    finished.push(entry.messageId);
    while (finished.length > PEER_MESSAGE_HISTORY) messages.delete(finished.shift()!);
    for (const waiter of entry.waiters.splice(0)) waiter();
    forgetIfIdle(peer);
  };

  const view = (entry: OutboxEntry): PeerResult => {
    const base = { messageId: entry.messageId, peer: entry.peer, seq: entry.seq };
    switch (entry.status) {
      case 'delivered':
        return { ok: true, status: 'delivered', ...base, result: entry.result };
      case 'failed':
        return { ok: false, status: 'failed', code: asString(entry.result?.code) ?? 'PEER_REMOTE_FAILED', ...base, result: entry.result };
      case 'expired':
        return { ok: false, status: 'expired', code: 'PEER_MESSAGE_EXPIRED', ...base };
      case 'unknown':
        return { ok: false, status: 'unknown', code: 'PEER_MESSAGE_UNKNOWN', ...base };
      default:
        return { ok: true, status: 'queued', ...base };
    }
  };

  const sendMessage: PeerLinkManager['sendMessage'] = async (input) => {
    const peer = peers.get(input.peer);
    if (!peer) return { ok: false, code: 'PEER_NOT_FOUND', peer: input.peer };
    const bytes = Buffer.byteLength(JSON.stringify(input.args));
    const queuedBytes = peer.outbox.reduce((sum, entry) => sum + entry.bytes, 0);
    if (peer.outbox.length >= settings.maxQueuedMessages || queuedBytes + bytes > settings.maxQueuedBytes) {
      return { ok: false, code: 'PEER_QUEUE_FULL', peer: peer.name, queued: peer.outbox.length };
    }
    const entry: OutboxEntry = {
      messageId: randomUUID(),
      peer: peer.name,
      seq: peer.nextSeq++,
      args: input.args,
      scopes: [...input.scopes],
      bytes,
      status: 'queued',
      waiters: [],
    };
    const ttl = input.hasKeys ? Math.min(settings.keyQueueTtlMs, settings.queueTtlMs) : settings.queueTtlMs;
    entry.expiryTimer = clock.setTimeout(() => {
      const owner = peers.get(entry.peer);
      if (owner && owner.outbox.includes(entry)) finish(owner, entry, entry.status === 'sent' ? 'unknown' : 'expired');
    }, ttl);
    messages.set(entry.messageId, entry);
    peer.outbox.push(entry);
    flush(peer);
    if (!peer.conn) return view(entry);
    return new Promise<PeerResult>((resolve) => {
      const timer = clock.setTimeout(() => {
        entry.waiters = entry.waiters.filter((waiter) => waiter !== done);
        resolve(view(entry));
      }, PEER_SEND_WAIT_MS);
      const done = () => {
        clock.clearTimeout(timer);
        resolve(view(entry));
      };
      entry.waiters.push(done);
    });
  };

  const receiveMessageResult = (peer: Peer, frame: Frame) => {
    if (frame.epoch !== peer.epoch || !isPositiveInt(frame.seq)) return;
    const entry = peer.outbox.find((candidate) => candidate.seq === frame.seq);
    if (!entry) return;
    const result = asRecord(frame.result);
    finish(peer, entry, result.ok === false ? 'failed' : 'delivered', result);
  };

  // -------------------------------------------------------------------------------------------
  // Messages in (FR-MCP-018 AC-3/AC-4)

  const receiveMessage = (conn: Connection, peer: Peer, frame: Frame) => {
    if (typeof frame.epoch !== 'string' || !isPositiveInt(frame.seq) || !isRecord(frame.args)) {
      bye(conn, 'PEER_PROTOCOL_ERROR');
      return;
    }
    const seq = frame.seq as number;
    const box = inboxFor(peer.name, frame.epoch);
    const reply = (result: PeerResult) => {
      const current = peer.conn;
      if (current) send(current, { t: 'msg-result', epoch: frame.epoch, seq, result });
    };
    if (seq <= box.last) {
      const prior = box.results.get(seq);
      if (prior) void prior.then(reply);
      else reply({ ok: true, status: 'duplicate' });
      return;
    }
    box.last = seq;
    const actor: PeerActor = { type: 'mcp-peer', peer: peer.name, scopes: intersect(conn.linkScopes(), frame.scopes) };
    const args = { ...(frame.args as Record<string, unknown>), includeSender: false };
    const run = peer.runChain.then(() => runTool('buildergate.message.send', args, actor));
    peer.runChain = run;
    box.results.set(seq, run);
    while (box.results.size > INBOX_RESULTS) box.results.delete(box.results.keys().next().value!);
    void run.then(reply);
  };

  const inboxFor = (peerName: string, senderEpoch: string): InboxBox => {
    const key = `${peerName}\u0000${senderEpoch}`;
    let box = inbox.get(key);
    if (!box) {
      box = { last: 0, results: new Map() };
      inbox.set(key, box);
      while (inbox.size > INBOX_EPOCHS) inbox.delete(inbox.keys().next().value!);
    }
    return box;
  };

  const runTool = async (tool: string, args: Record<string, unknown>, actor: PeerActor): Promise<PeerResult> => {
    audit({ event: 'peer.request', peer: actor.peer, tool });
    try {
      return asRecord(await deps.callTool(tool, args, actor));
    } catch (error) {
      return { ok: false, code: 'PEER_REMOTE_ERROR', message: error instanceof Error ? error.message : String(error) };
    }
  };

  // -------------------------------------------------------------------------------------------
  // Calls (FR-MCP-019 AC-4/AC-6)

  const call: PeerLinkManager['call'] = async (input) => {
    const peer = peers.get(input.peer);
    if (!peer) return { ok: false, code: 'PEER_NOT_FOUND', peer: input.peer };
    const conn = peer.conn;
    if (!conn) return { ok: false, code: 'PEER_DISCONNECTED', peer: peer.name };
    const id = randomUUID();
    return new Promise<PeerResult>((resolve) => {
      const timer = clock.setTimeout(() => {
        peer.calls.delete(id);
        resolve({ ok: false, code: 'PEER_CALL_TIMEOUT', peer: peer.name });
      }, PEER_CALL_TIMEOUT_MS);
      peer.calls.set(id, { resolve, timer });
      send(conn, { t: 'call', id, tool: input.tool, arguments: input.arguments, scopes: input.scopes });
    });
  };

  const receiveCall = async (conn: Connection, peer: Peer, frame: Frame) => {
    if (typeof frame.id !== 'string' || typeof frame.tool !== 'string') {
      bye(conn, 'PEER_PROTOCOL_ERROR');
      return;
    }
    const result = frame.tool.startsWith(PEER_TOOL_PREFIX)
      ? { ok: false, code: 'PEER_RELAY_REFUSED', message: 'buildergate.peer.* cannot be called over a link' }
      : await runTool(frame.tool, asRecord(frame.arguments), {
        type: 'mcp-peer',
        peer: peer.name,
        scopes: intersect(conn.linkScopes(), frame.scopes),
      });
    const current = peer.conn;
    if (current) send(current, { t: 'call-result', id: frame.id, result });
  };

  const receiveCallResult = (peer: Peer, frame: Frame) => {
    const pending = typeof frame.id === 'string' ? peer.calls.get(frame.id) : undefined;
    if (!pending) return;
    peer.calls.delete(frame.id as string);
    clock.clearTimeout(pending.timer);
    pending.resolve(asRecord(frame.result));
  };

  // -------------------------------------------------------------------------------------------

  syncLinks();

  return {
    start: () => {
      if (started) return;
      started = true;
      for (const peer of peers.values()) if (peer.direction === 'outbound' && !peer.conn && !peer.dialing) dial(peer);
    },
    stop: () => {
      started = false;
      for (const peer of peers.values()) {
        cancelRetry(peer);
        dropConnection(peer.dialing);
        dropConnection(peer.conn);
      }
    },
    applySettings: (next) => {
      const renamed = next.nodeName !== settings.nodeName;
      settings = next;
      syncLinks();
      if (renamed) for (const peer of peers.values()) if (peer.direction === 'outbound') restartOutbound(peer);
    },
    accept,
    hasPeer: (name) => peers.has(name),
    dropInbound: () => {
      for (const peer of [...peers.values()]) if (peer.direction === 'inbound') dropConnection(peer.conn);
    },
    sendMessage,
    call,
    list: () => [...peers.values()].map((peer) => ({
      name: peer.name,
      direction: peer.direction,
      state: peer.state,
      queued: peer.outbox.length,
      ...(peer.lastError ? { lastError: peer.lastError } : {}),
      ...(peer.connectedAt !== undefined ? { connectedAt: new Date(peer.connectedAt).toISOString() } : {}),
    })),
    messageStatus: (messageId) => {
      const entry = messages.get(messageId);
      if (!entry) return undefined;
      return {
        messageId: entry.messageId,
        peer: entry.peer,
        seq: entry.seq,
        status: entry.status,
        ...(entry.result ? { result: entry.result } : {}),
      };
    },
  };
}

function sameLink(a: PeerLinkEntry, b: PeerLinkEntry): boolean {
  return a.url === b.url && a.accessKey === b.accessKey && a.tlsFingerprintSha256 === b.tlsFingerprintSha256;
}

/** FR-MCP-019 AC-5: the caller's scopes only narrow the link's. */
function intersect(linkScopes: string[], callerScopes: unknown): string[] {
  const caller = new Set(Array.isArray(callerScopes) ? callerScopes.filter((scope) => typeof scope === 'string') : []);
  return linkScopes.filter((scope) => caller.has(scope));
}

function parseFrame(text: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(value) && typeof value.t === 'string' ? value as Frame : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
