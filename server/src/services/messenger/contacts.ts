// FR-MSG-008, FR-MSG-009 (room links), FR-MSG-014 (contract §1, §7, §9): who this server talks to.
//
// A contact is a peer link (kind 'contact') named after the remote's own nodeName, or a node that
// holds a contact key here and dials in. Contacts are made three ways:
//   - redeeming a bgc1 connection code (no acceptance: the code carries a one-time pairing token);
//   - adding by address: an unauthenticated request to the remote's MCP listener, accepted there
//     by a person, then polled every 5 s until the key comes back (TOFU on the certificate);
//   - accepting someone else's address request.
// Room links (kind 'room') are opened with a room ticket and are not contacts.
//
// MessengerNet, the one object the rest of the messenger uses:
//
//   contactsView(): Contact[]                           for GET /api/messenger/state
//   requestsView(): ContactRequestView[]                incoming address requests waiting for me
//   connectInfo(): { urls, fp }                         wss://<LAN IPv4>:<LAN port>/mcp/peer + cert hash ([] when LAN is off)
//   ensureRoomLink({ hostNode, urls, fp, token })       link to a room host with a ticket (no-op for a contact)
//   dropRoomLink(hostNode)                              remove that room link (a contact link stays)
//   isContact(node): boolean
//   renameMe(name) · connectionCode() · redeemCode(code) · addContactByAddress({ name, address })
//   removeContact(name) · acceptRequest(id) · declineRequest(id) · lan() · setLan({ receiving, port? })
//   handleContactRequest(call)                          POST/GET /mcp/contact-request on the LAN listener
//   onPeerConnected(info)                               renames a link to the name the remote calls itself
//   tick()                                              one poll step (address requests, address rotation)
//   start() / stop()                                    tick every 5 s
//   whenIdle()                                          resolves when queued link changes are saved
//   setInviteRedeemer(fn)                               the rooms side handles bgi1 codes (else INVITE_UNSUPPORTED)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';
import { isAllowedPeerUrl, normalizeFingerprint, PEER_NAME_PATTERN, type PeerLinkEntry, type PeerLinkSettings } from '../peer/peerLinkSettings.js';
import type { PeerStatus } from '../peer/peerLinkManager.js';
import type { MessengerKeys } from './keys.js';
import type { LanSetResult, LanStatus } from './lanListener.js';

export interface Contact {
  name: string;
  state: 'connected' | 'disconnected' | 'requested' | 'pending-in';
  /** ISO time the link to this contact was last up (kept across restarts); absent before the first connection. */
  lastSeen?: string;
  /** host:port, when this server dials the contact. */
  address?: string;
  /** TLS_FINGERPRINT_CHANGED: the remote presented another certificate (FR-MSG-008 AC-5). */
  error?: string;
}

export interface ContactRequestView {
  id: string;
  fromNode: string;
  fromAddress?: string;
  at: string;
}

export type NetResult = { ok: boolean; code?: string } & Record<string, unknown>;

/** One HTTPS request to another server's MCP listener. status 0 means it could not be reached. */
export type ContactHttp = (request: { method: 'GET' | 'POST'; url: string; body?: unknown }) => Promise<{
  status: number;
  body: unknown;
  /** SHA-256 of the certificate the remote presented, lower-case hex; '' without TLS. */
  fingerprint: string;
}>;

/** An unauthenticated request to /mcp/contact-request, transport-neutral. */
export interface ContactRequestCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  remoteAddress: string;
}

export interface MessengerNetDeps {
  keys: MessengerKeys & { contactNodes(): string[] };
  peers: { nodeName(): string; list(): PeerStatus[]; dropPeer(name: string): void };
  peerSettings: {
    get(): PeerLinkSettings;
    update(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  /** FR-MSG-014: the dedicated LAN listener (lanListener.ts createLanReceiver). */
  lan: {
    status(): LanStatus;
    set(input: { receiving: boolean; port?: number }): Promise<LanSetResult>;
  };
  /** SHA-256 hex of the server certificate the LAN listener uses; '' when there is none. */
  certificateFingerprint(): string;
  lanAddresses?: () => string[];
  http: ContactHttp;
  /** Provided by the rooms side: turns a bgi1 payload into an invitation. */
  redeemInvite?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notify?: (reason: string) => void;
  dataPath?: string;
  now?: () => number;
  random?: () => string;
}

export interface MessengerNet {
  contactsView(): Contact[];
  requestsView(): ContactRequestView[];
  connectInfo(): { urls: string[]; fp: string };
  ensureRoomLink(input: { hostNode: string; urls: string[]; fp: string; token: string }): Promise<NetResult>;
  dropRoomLink(hostNode: string): Promise<NetResult>;
  isContact(node: string): boolean;
  renameMe(name: string): Promise<NetResult>;
  /** LAN_OFF when receiving is off: a code without addresses could not be used. */
  connectionCode(): { ok: true; code: string; expiresAt: string } | { ok: false; code: 'LAN_OFF' };
  redeemCode(code: string): Promise<NetResult>;
  addContactByAddress(input: { name: string; address: string }): Promise<NetResult>;
  removeContact(name: string): Promise<NetResult>;
  acceptRequest(id: string): Promise<NetResult>;
  declineRequest(id: string): Promise<NetResult>;
  lan(): Promise<{ ok: true } & LanStatus>;
  setLan(input: { receiving: boolean; port?: number }): Promise<NetResult>;
  handleContactRequest(call: ContactRequestCall): Promise<{ status: number; body: Record<string, unknown> }>;
  onPeerConnected(info: { name: string; direction: 'outbound' | 'inbound'; remoteNode: string }): void;
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  whenIdle(): Promise<void>;
  setInviteRedeemer(redeem: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>): void;
}

export const DEFAULT_MESSENGER_CONTACTS_PATH = './data/messenger/contacts.json';
export const CONTACT_POLL_MS = 5_000;
export const CONTACT_REQUEST_TTL_MS = 24 * 3_600_000;
export const MAX_PENDING_CONTACT_REQUESTS = 20;
/** Review M2: one address cannot fill the waiting list. */
export const MAX_PENDING_PER_ADDRESS = 3;
/** How long a link may stay down before it tries the next address of its code. */
export const ADDRESS_ROTATE_AFTER_MS = 15_000;
/** How often lastSeen of a contact that stays connected is written again. */
export const LAST_SEEN_REFRESH_MS = 60_000;
/** FR-MSG-014: the default LAN listener port (MCP port 3333 + 1), used when an address has none. */
const DEFAULT_LAN_PORT = 3334;
const CONTACT_REQUEST_PATH = '/mcp/contact-request';
const SECRET_MIN = 8;
const SECRET_MAX = 256;
const NAME_MAX = 32;

export type ContactNameCode = 'NAME_EMPTY' | 'NAME_TOO_LONG' | 'NAME_HAS_SPACE' | 'NAME_INVALID_CHAR' | 'NAME_IS_SELF' | 'NAME_TAKEN';

/** FR-MSG-008 AC-1: null when the name may be used. `taken` compares without case. */
export function checkContactName(name: string, context: { myName: string; taken: readonly string[] }): ContactNameCode | null {
  if (name === '') return 'NAME_EMPTY';
  if (/\s/u.test(name)) return 'NAME_HAS_SPACE';
  if (!PEER_NAME_PATTERN.test(name)) return [...name].length > NAME_MAX && PEER_NAME_PATTERN.test(name.slice(0, NAME_MAX)) ? 'NAME_TOO_LONG' : 'NAME_INVALID_CHAR';
  if (sameName(name, context.myName)) return 'NAME_IS_SELF';
  if (context.taken.some((taken) => sameName(taken, name))) return 'NAME_TAKEN';
  return null;
}

export type MessengerCode = { kind: 'contact' | 'invite'; payload: Record<string, unknown> };

export function encodeMessengerCode(kind: MessengerCode['kind'], payload: Record<string, unknown>): string {
  return `${kind === 'contact' ? 'bgc1' : 'bgi1'}.${Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url')}`;
}

export function decodeMessengerCode(code: string): MessengerCode | null {
  const match = /^(bgc1|bgi1)\.([A-Za-z0-9_-]+)$/u.exec(code.trim());
  if (!match) return null;
  const payload = parseRecord(Buffer.from(match[2]!, 'base64url').toString('utf8'));
  if (!payload || payload.v !== 1) return null;
  return { kind: match[1] === 'bgc1' ? 'contact' : 'invite', payload };
}

/** Each IPv4 address of this host that another PC could reach, LAN ranges first. */
export function listLanAddresses(): string[] {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  const rank = (address: string) => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : address.startsWith('172.') ? 2 : 3);
  return [...new Set(addresses)].sort((a, b) => rank(a) - rank(b));
}

interface OutgoingRequest {
  id: string;
  name: string;
  address: string;
  secret: string;
  fp: string;
  startedAt: number;
  error?: string;
}

interface IncomingRequest {
  id: string;
  fromNode: string;
  fromAddress?: string;
  secretHash: string;
  state: 'pending' | 'accepted' | 'declined';
  at: number;
}

interface Candidates {
  urls: string[];
  index: number;
}

interface ContactsFile {
  outgoing: OutgoingRequest[];
  incoming: IncomingRequest[];
  candidates: Record<string, Candidates>;
  /** Lower-cased name -> epoch ms the link was last seen up. */
  lastSeen: Record<string, number>;
}

export function createMessengerNet(deps: MessengerNetDeps): MessengerNet {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? (() => randomBytes(24).toString('base64url'));
  const notify = deps.notify ?? (() => {});
  const lanAddresses = deps.lanAddresses ?? listLanAddresses;
  let redeemInvite = deps.redeemInvite;
  const dataPath = path.resolve(deps.dataPath ?? DEFAULT_MESSENGER_CONTACTS_PATH);
  const state = loadContactsFile(dataPath);
  /** When each link last started trying its current address (in memory). */
  const tryingSince = new Map<string, number>();
  let saving: Promise<void> = Promise.resolve();
  let linkChain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;

  const save = () => {
    const body = JSON.stringify({ version: 1, ...state }, null, 2);
    saving = saving
      .then(() => publishStoreAtomically(dataPath, body, { writeBackup: false, ensureDirectory: true }))
      .catch((error: unknown) => console.warn('[Messenger] contacts save failed:', error instanceof Error ? error.message : String(error)));
  };

  /** Link changes run one after another, each on the settings the one before left. */
  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = linkChain.then(fn);
    linkChain = run.then(() => undefined, () => undefined);
    return run;
  };

  const myName = () => deps.peers.nodeName();
  const links = () => deps.peerSettings.get().links;
  const contactLinks = () => links().filter((link) => link.kind !== 'room');
  const findLink = (name: string) => links().find((link) => sameName(link.name, name));
  const statusOf = (name: string, direction: PeerStatus['direction']) =>
    deps.peers.list().find((peer) => peer.direction === direction && sameName(peer.name, name));

  const saveLinks = async (next: PeerLinkEntry[]): Promise<NetResult> => {
    const result = await deps.peerSettings.update({ links: next });
    return result.ok === false ? { ok: false, code: 'LINK_SAVE_FAILED', fieldErrors: result.fieldErrors } : { ok: true };
  };

  const takenNames = () => [
    ...links().map((link) => link.name),
    ...deps.keys.contactNodes(),
    ...state.outgoing.map((request) => request.name),
  ];

  const setCandidates = (name: string, urls: string[]) => {
    for (const key of Object.keys(state.candidates)) if (sameName(key, name)) delete state.candidates[key];
    if (urls.length > 1) state.candidates[name] = { urls, index: 0 };
    tryingSince.set(name, now());
    save();
  };

  // -------------------------------------------------------------------------------------------
  // Last seen

  const markSeen = (name: string) => {
    state.lastSeen[name.toLowerCase()] = now();
    save();
  };

  const seenOf = (name: string): { lastSeen: string } | Record<string, never> => {
    const at = state.lastSeen[name.toLowerCase()];
    return at === undefined ? {} : { lastSeen: new Date(at).toISOString() };
  };

  const refreshSeen = () => {
    for (const peer of deps.peers.list()) {
      if (peer.state !== 'connected') continue;
      const at = state.lastSeen[peer.name.toLowerCase()];
      if (at === undefined || now() - at >= LAST_SEEN_REFRESH_MS) markSeen(peer.name);
    }
  };

  const moveSeen = (from: string, to: string) => {
    const at = state.lastSeen[from.toLowerCase()];
    delete state.lastSeen[from.toLowerCase()];
    if (at !== undefined) state.lastSeen[to.toLowerCase()] = at;
  };

  // -------------------------------------------------------------------------------------------
  // Views

  const linkContact = (link: PeerLinkEntry): Contact => {
    const status = statusOf(link.name, 'outbound');
    const error = status?.lastError === 'PEER_TLS_FINGERPRINT_MISMATCH' ? 'TLS_FINGERPRINT_CHANGED' : undefined;
    return {
      name: link.name,
      state: status?.state === 'connected' ? 'connected' : 'disconnected',
      address: addressOfUrl(link.url),
      ...seenOf(link.name),
      ...(error ? { error } : {}),
    };
  };

  const contactsView = (): Contact[] => {
    const view: Contact[] = contactLinks().map(linkContact);
    const listed = (name: string) => view.some((contact) => sameName(contact.name, name));
    for (const node of deps.keys.contactNodes()) {
      if (listed(node)) continue;
      view.push({ name: node, state: statusOf(node, 'inbound')?.state === 'connected' ? 'connected' : 'disconnected', ...seenOf(node) });
    }
    for (const request of state.outgoing) {
      if (listed(request.name)) continue;
      view.push({ name: request.name, state: 'requested', address: request.address, ...(request.error ? { error: request.error } : {}) });
    }
    for (const request of pendingIncoming()) {
      if (!listed(request.fromNode)) view.push({ name: request.fromNode, state: 'pending-in' });
    }
    return view;
  };

  const pendingIncoming = () => state.incoming.filter((request) => request.state === 'pending');

  const requestsView = (): ContactRequestView[] => pendingIncoming().map((request) => ({
    id: request.id,
    fromNode: request.fromNode,
    ...(request.fromAddress ? { fromAddress: request.fromAddress } : {}),
    at: new Date(request.at).toISOString(),
  }));

  const connectInfo = () => {
    const { receiving, port } = deps.lan.status();
    const urls = receiving ? lanAddresses().map((address) => `wss://${address}:${port}/mcp/peer`) : [];
    return { urls, fp: deps.certificateFingerprint() };
  };

  const isContact = (node: string) =>
    contactLinks().some((link) => sameName(link.name, node)) || deps.keys.allowedRooms(node) === 'all';

  // -------------------------------------------------------------------------------------------
  // Me, codes

  const renameMe = async (name: string): Promise<NetResult> => {
    if (name === myName()) return { ok: true, name };
    const code = checkContactName(name, { myName: '', taken: takenNames() });
    if (code) return { ok: false, code };
    // FR-MSG-008 AC-2 (review H4): contacts and room hosts bind the keys they gave me to my name; a new name would lock me out.
    if (links().length > 0 || deps.keys.contactNodes().length > 0) return { ok: false, code: 'NAME_HAS_CONTACTS' };
    const result = await deps.peerSettings.update({ nodeName: name });
    if (result.ok === false) return { ok: false, code: 'NAME_INVALID_CHAR', fieldErrors: result.fieldErrors };
    notify('me-renamed');
    return { ok: true, name };
  };

  const connectionCode: MessengerNet['connectionCode'] = () => {
    const { urls, fp } = connectInfo();
    if (urls.length === 0) return { ok: false, code: 'LAN_OFF' };
    const { token, expiresAt } = deps.keys.issuePairingToken();
    return { ok: true as const, code: encodeMessengerCode('contact', { name: myName(), urls, fp, token }), expiresAt };
  };

  const redeemContactCode = (payload: Record<string, unknown>) => serially(async (): Promise<NetResult> => {
    const name = payload.name;
    const urls = Array.isArray(payload.urls) ? payload.urls.filter((url): url is string => typeof url === 'string' && isAllowedPeerUrl(url)) : [];
    const token = payload.token;
    if (typeof name !== 'string' || !PEER_NAME_PATTERN.test(name) || urls.length === 0 || typeof token !== 'string' || token === '') {
      return { ok: false, code: 'CODE_INVALID' };
    }
    if (sameName(name, myName())) return { ok: false, code: 'NAME_IS_SELF' };
    const fingerprint = typeof payload.fp === 'string' ? normalizeFingerprint(payload.fp) : undefined;
    const link: PeerLinkEntry = { name, url: urls[0]!, accessKey: token, enabled: true, ...(fingerprint ? { tlsFingerprintSha256: fingerprint } : {}) };
    const saved = await saveLinks([...links().filter((entry) => !sameName(entry.name, name)), link]);
    if (!saved.ok) return saved;
    state.outgoing = state.outgoing.filter((request) => !sameName(request.name, name));
    setCandidates(name, urls);
    notify('contact-added');
    return { ok: true, kind: 'contact', contact: linkContact(link) };
  });

  const redeemCode = async (code: string): Promise<NetResult> => {
    const decoded = decodeMessengerCode(code);
    if (!decoded) return { ok: false, code: 'CODE_INVALID' };
    if (decoded.kind === 'contact') return redeemContactCode(decoded.payload);
    if (!redeemInvite) return { ok: false, code: 'INVITE_UNSUPPORTED' };
    return { ok: true, ...(await redeemInvite(decoded.payload)) } as NetResult;
  };

  // -------------------------------------------------------------------------------------------
  // Add by address (requester side)

  const addContactByAddress = async (input: { name: string; address: string }): Promise<NetResult> => {
    const code = checkContactName(input.name, { myName: myName(), taken: takenNames() });
    if (code) return { ok: false, code };
    const address = parseAddress(input.address);
    if (!address) return { ok: false, code: 'ADDRESS_INVALID' };
    const secret = random();
    const answer = await deps.http({ method: 'POST', url: `https://${address}${CONTACT_REQUEST_PATH}`, body: { fromNode: myName(), secret } });
    if (answer.status === 0) return { ok: false, code: 'ADDRESS_UNREACHABLE' };
    const body = asRecord(answer.body);
    if (answer.status !== 200 || body.ok !== true || typeof body.id !== 'string') {
      return { ok: false, code: typeof body.code === 'string' ? body.code : 'REQUEST_REFUSED' };
    }
    state.outgoing.push({ id: body.id, name: input.name, address, secret, fp: answer.fingerprint, startedAt: now() });
    save();
    notify('request-sent');
    return { ok: true, contact: { name: input.name, state: 'requested', address } };
  };

  const dropOutgoing = (request: OutgoingRequest, reason: string) => {
    state.outgoing = state.outgoing.filter((entry) => entry !== request);
    save();
    notify(reason);
  };

  const pollOutgoing = async (request: OutgoingRequest) => {
    if (now() - request.startedAt > CONTACT_REQUEST_TTL_MS) {
      dropOutgoing(request, 'request-expired');
      return;
    }
    if (request.error) return;
    const answer = await deps.http({
      method: 'GET',
      url: `https://${request.address}${CONTACT_REQUEST_PATH}/${encodeURIComponent(request.id)}?secret=${encodeURIComponent(request.secret)}`,
    });
    if (answer.status === 0) return;
    if (answer.fingerprint !== request.fp) {
      request.error = 'TLS_FINGERPRINT_CHANGED';
      save();
      notify('request-failed');
      return;
    }
    const body = asRecord(answer.body);
    if (answer.status === 404) {
      dropOutgoing(request, 'request-gone');
      return;
    }
    if (body.state === 'declined') {
      dropOutgoing(request, 'request-declined');
      return;
    }
    if (body.state !== 'accepted' || typeof body.key !== 'string') return;
    const key = body.key;
    const saved = await serially(async () => {
      const fingerprint = normalizeFingerprint(request.fp);
      const link: PeerLinkEntry = {
        name: request.name,
        url: `wss://${request.address}/mcp/peer`,
        accessKey: key,
        enabled: true,
        ...(fingerprint ? { tlsFingerprintSha256: fingerprint } : {}),
      };
      const result = await saveLinks([...links().filter((entry) => !sameName(entry.name, request.name)), link]);
      if (result.ok) setCandidates(request.name, []);
      return result;
    });
    if (!saved.ok) {
      request.error = 'LINK_SAVE_FAILED';
      save();
      notify('request-failed');
      return;
    }
    dropOutgoing(request, 'contact-added');
  };

  /** A link that stays down past ADDRESS_ROTATE_AFTER_MS moves on to the next address of its code. */
  const rotateAddresses = () => serially(async () => {
    const next = links().map((link) => {
      const candidates = state.candidates[link.name];
      if (!candidates || candidates.urls.length < 2) return link;
      const since = tryingSince.get(link.name);
      if (since === undefined || statusOf(link.name, 'outbound')?.state === 'connected') {
        tryingSince.set(link.name, now());
        return link;
      }
      if (now() - since < ADDRESS_ROTATE_AFTER_MS) return link;
      candidates.index = (candidates.index + 1) % candidates.urls.length;
      tryingSince.set(link.name, now());
      return { ...link, url: candidates.urls[candidates.index]! };
    });
    if (next.every((link, index) => link === links()[index])) return;
    save();
    await saveLinks(next);
  });

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const request of [...state.outgoing]) await pollOutgoing(request);
      pruneIncoming();
      refreshSeen();
      await rotateAddresses();
    } finally {
      ticking = false;
    }
  };

  // -------------------------------------------------------------------------------------------
  // Address requests (receiving side)

  const pruneIncoming = () => {
    const kept = state.incoming.filter((request) => request.state === 'pending' || now() - request.at <= CONTACT_REQUEST_TTL_MS);
    if (kept.length === state.incoming.length) return;
    state.incoming = kept;
    save();
  };

  const receiveRequest = (call: ContactRequestCall) => {
    const body = asRecord(call.body);
    const fromNode = body.fromNode;
    const secret = body.secret;
    if (typeof fromNode !== 'string' || !PEER_NAME_PATTERN.test(fromNode) || sameName(fromNode, myName())
      || typeof secret !== 'string' || secret.length < SECRET_MIN || secret.length > SECRET_MAX) {
      return { status: 400, body: { ok: false, code: 'INVALID_REQUEST' } };
    }
    // Review H1/M2: a request never replaces a contact or a request that is already waiting.
    if (isContact(fromNode)) return { status: 409, body: { ok: false, code: 'NAME_TAKEN' } };
    const pending = pendingIncoming();
    if (pending.some((entry) => sameName(entry.fromNode, fromNode))) return { status: 409, body: { ok: false, code: 'REQUEST_PENDING' } };
    if (call.remoteAddress && pending.filter((entry) => entry.fromAddress === call.remoteAddress).length >= MAX_PENDING_PER_ADDRESS) {
      return { status: 429, body: { ok: false, code: 'TOO_MANY_REQUESTS' } };
    }
    const request: IncomingRequest = {
      id: random(),
      fromNode,
      ...(call.remoteAddress ? { fromAddress: call.remoteAddress } : {}),
      secretHash: sha256(secret),
      state: 'pending',
      at: now(),
    };
    state.incoming.push(request);
    const waiting = pendingIncoming();
    if (waiting.length > MAX_PENDING_CONTACT_REQUESTS) {
      const dropped = new Set(waiting.slice(0, waiting.length - MAX_PENDING_CONTACT_REQUESTS));
      state.incoming = state.incoming.filter((entry) => !dropped.has(entry));
    }
    save();
    notify('request-received');
    return { status: 200, body: { ok: true, id: request.id, name: myName() } };
  };

  const answerPoll = (id: string, secret: string | undefined) => {
    const request = state.incoming.find((entry) => entry.id === id);
    if (!request || secret === undefined || !sameHash(request.secretHash, sha256(secret))) {
      return { status: 404, body: { ok: false, code: 'NOT_FOUND' } };
    }
    if (request.state === 'declined') {
      state.incoming = state.incoming.filter((entry) => entry !== request);
      save();
      return { status: 200, body: { ok: true, state: 'declined', name: myName() } };
    }
    if (request.state === 'pending') return { status: 200, body: { ok: true, state: 'pending', name: myName() } };
    // Review M1: the key goes out once; the request is gone after that.
    state.incoming = state.incoming.filter((entry) => entry !== request);
    save();
    const key = deps.keys.issueContactKey(request.fromNode);
    notify('contact-added');
    return { status: 200, body: { ok: true, state: 'accepted', name: myName(), key } };
  };

  const handleContactRequest = async (call: ContactRequestCall) => {
    if (call.method === 'POST' && call.path === CONTACT_REQUEST_PATH) return receiveRequest(call);
    const prefix = `${CONTACT_REQUEST_PATH}/`;
    const id = call.path.startsWith(prefix) ? decodedSegment(call.path.slice(prefix.length)) : undefined;
    if (call.method === 'GET' && id !== undefined) return answerPoll(id, call.query.secret);
    return { status: 404, body: { ok: false, code: 'NOT_FOUND' } };
  };

  const decide = async (id: string, decision: 'accepted' | 'declined'): Promise<NetResult> => {
    const request = pendingIncoming().find((entry) => entry.id === id);
    if (!request) return { ok: false, code: 'REQUEST_NOT_FOUND' };
    request.state = decision;
    request.at = now();
    save();
    notify(decision === 'accepted' ? 'request-accepted' : 'request-declined');
    return { ok: true };
  };

  // -------------------------------------------------------------------------------------------
  // Removing, renaming, room links

  const removeContact = (name: string) => serially(async (): Promise<NetResult> => {
    const link = contactLinks().find((entry) => sameName(entry.name, name));
    const keyHolder = deps.keys.contactNodes().find((node) => sameName(node, name));
    const outgoing = state.outgoing.filter((request) => sameName(request.name, name));
    const incoming = state.incoming.filter((request) => sameName(request.fromNode, name));
    if (!link && !keyHolder && outgoing.length === 0 && incoming.length === 0) return { ok: false, code: 'CONTACT_NOT_FOUND' };
    if (link) {
      const saved = await saveLinks(links().filter((entry) => entry !== link));
      if (!saved.ok) return saved;
      setCandidates(link.name, []);
    }
    if (keyHolder) {
      deps.keys.revokeContact(keyHolder);
      deps.peers.dropPeer(keyHolder);
    }
    state.outgoing = state.outgoing.filter((request) => !outgoing.includes(request));
    state.incoming = state.incoming.filter((request) => !incoming.includes(request));
    delete state.lastSeen[name.toLowerCase()];
    save();
    notify('contact-removed');
    return { ok: true };
  });

  const onPeerConnected: MessengerNet['onPeerConnected'] = ({ name, direction, remoteNode }) => {
    markSeen(name);
    if (direction !== 'outbound' || sameName(name, remoteNode) || !PEER_NAME_PATTERN.test(remoteNode)) return;
    void serially(async () => {
      const link = links().find((entry) => entry.name === name);
      if (!link || link.kind === 'room') return;
      if (sameName(remoteNode, myName()) || links().some((entry) => sameName(entry.name, remoteNode))) return;
      const saved = await saveLinks(links().map((entry) => (entry === link ? { ...entry, name: remoteNode } : entry)));
      if (!saved.ok) return;
      const candidates = state.candidates[name];
      delete state.candidates[name];
      if (candidates) state.candidates[remoteNode] = candidates;
      moveSeen(name, remoteNode);
      save();
      notify('contact-renamed');
    });
  };

  const ensureRoomLink: MessengerNet['ensureRoomLink'] = (input) => serially(async () => {
    if (isContact(input.hostNode)) return { ok: true };
    const urls = input.urls.filter(isAllowedPeerUrl);
    if (!PEER_NAME_PATTERN.test(input.hostNode) || urls.length === 0 || input.token === '') return { ok: false, code: 'ROOM_LINK_INVALID' };
    const fingerprint = normalizeFingerprint(input.fp);
    const link: PeerLinkEntry = {
      name: input.hostNode,
      url: urls[0]!,
      accessKey: input.token,
      enabled: true,
      kind: 'room',
      ...(fingerprint ? { tlsFingerprintSha256: fingerprint } : {}),
    };
    const saved = await saveLinks([...links().filter((entry) => !sameName(entry.name, input.hostNode)), link]);
    if (saved.ok) setCandidates(input.hostNode, urls);
    return saved;
  });

  const dropRoomLink: MessengerNet['dropRoomLink'] = (hostNode) => serially(async () => {
    const link = links().find((entry) => entry.kind === 'room' && sameName(entry.name, hostNode));
    if (!link) return { ok: true };
    const saved = await saveLinks(links().filter((entry) => entry !== link));
    if (saved.ok) setCandidates(link.name, []);
    return saved;
  });

  // -------------------------------------------------------------------------------------------
  // LAN receiving (FR-MSG-014)

  const lan = async () => ({ ok: true as const, ...deps.lan.status() });

  const setLan: MessengerNet['setLan'] = async (input) => {
    if (input.receiving && deps.certificateFingerprint() === '') {
      return { ok: false, code: 'LAN_TLS_UNAVAILABLE', reason: 'NO_SERVER_CERTIFICATE' };
    }
    const result = await deps.lan.set(input);
    if (result.ok) notify('lan-changed');
    return result;
  };

  return {
    contactsView,
    requestsView,
    connectInfo,
    ensureRoomLink,
    dropRoomLink,
    isContact,
    renameMe,
    connectionCode,
    redeemCode,
    addContactByAddress,
    removeContact,
    acceptRequest: (id) => decide(id, 'accepted'),
    declineRequest: (id) => decide(id, 'declined'),
    lan,
    setLan,
    handleContactRequest,
    onPeerConnected,
    tick,
    start: () => {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, CONTACT_POLL_MS);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    setInviteRedeemer: (redeem) => { redeemInvite = redeem; },
    whenIdle: async () => {
      await linkChain;
      await saving;
    },
  };
}

/** 'host', 'host:port' or 'https://host:port' to 'host:port' (port 3333 when left out). */
function parseAddress(text: string): string | null {
  const trimmed = text.trim();
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return null;
  const url = new URL(candidate);
  if (url.hostname === '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.username !== '') return null;
  return `${url.hostname}:${url.port || DEFAULT_LAN_PORT}`;
}

/** A path segment decoded, or undefined when its escapes are malformed. */
function decodedSegment(segment: string): string | undefined {
  if (segment === '' || /%(?![0-9A-Fa-f]{2})/u.test(segment)) return undefined;
  const bytes = Buffer.from(segment.replace(/%([0-9A-Fa-f]{2})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}

function addressOfUrl(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || DEFAULT_LAN_PORT}`;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function loadContactsFile(dataPath: string): ContactsFile {
  const empty: ContactsFile = { outgoing: [], incoming: [], candidates: {}, lastSeen: {} };
  if (!fs.existsSync(dataPath)) return empty;
  const parsed = parseRecord(fs.readFileSync(dataPath, 'utf8'));
  if (!parsed) {
    console.warn('[Messenger] contacts.json is not valid JSON; starting empty');
    return empty;
  }
  return {
    outgoing: Array.isArray(parsed.outgoing) ? parsed.outgoing as OutgoingRequest[] : [],
    incoming: Array.isArray(parsed.incoming) ? parsed.incoming as IncomingRequest[] : [],
    candidates: asRecord(parsed.candidates) as Record<string, Candidates>,
    lastSeen: Object.fromEntries(Object.entries(asRecord(parsed.lastSeen)).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
  };
}
