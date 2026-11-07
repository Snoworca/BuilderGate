// FR-MSG-008 AC-4/AC-6, FR-MSG-009 AC-1/AC-2/AC-4 (contract §7): the keys other BuilderGate servers
// present in the peer-link hello. Only SHA-256 hashes are kept (data/messenger/keys.json).
//
// - pairing token (in a bgc1 connection code): one-time, 24 h. Its first use turns it into a
//   contact key bound to the node that used it.
// - room ticket (in a bgi1 invite code or room.peer.ticket): one-time, 7 d. Its first use turns it
//   into that node's room key, which reaches only the rooms of its tickets.
// - contact key: issued when an address request is accepted, or made from a pairing token.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';

export interface MessengerKeys {
  issuePairingToken(): { token: string; expiresAt: string };
  issueRoomTicket(input: { roomId: string; invitee: string }): { token: string; expiresAt: string };
  /** Kick: removes that room from the node's room key. */
  revokeRoomKey(input: { roomId: string; node: string }): void;
  revokeContact(node: string): void;
  /** Used when accepting an address request. Replaces the node's previous contact key. */
  issueContactKey(node: string): string;
  /** null when the key is not a messenger key. First use of a pairing token -> contact key for node; first use of a ticket -> room key for node. */
  authenticate(key: string, node: string): MessengerKeyAuth | null;
  allowedRooms(node: string): string[] | 'all' | 'none';
}

export interface MessengerKeyStore extends MessengerKeys {
  /** Resolves when every change so far is on disk. */
  whenSaved(): Promise<void>;
  /** The nodes holding a contact key here (contacts that dial this server). */
  contactNodes(): string[];
}

export type MessengerKeyAuth = { kind: 'contact' | 'room'; scopes: string[]; rooms?: string[] };

export const CONTACT_SCOPES: readonly string[] = Object.freeze(['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste', 'mcp:room']);
export const ROOM_SCOPES: readonly string[] = Object.freeze(['mcp:room']);
export const DEFAULT_MESSENGER_KEYS_PATH = './data/messenger/keys.json';
export const PAIRING_TOKEN_TTL_MS = 24 * 3_600_000;
export const ROOM_TICKET_TTL_MS = 7 * 24 * 3_600_000;
export const ROOM_PEER_TOOL_PREFIX = 'buildergate.room.peer.';

interface ContactKey { node: string; hash: string; createdAt: string }
interface PairingToken { hash: string; expiresAt: string }
interface RoomTicket { hash: string; roomId: string; invitee: string; expiresAt: string }
interface RoomKey { node: string; hash: string; rooms: string[]; createdAt: string }

interface KeysFile {
  contactKeys: ContactKey[];
  pairingTokens: PairingToken[];
  roomTickets: RoomTicket[];
  roomKeys: RoomKey[];
}

export function createMessengerKeys(deps: { path?: string; now?: () => number; random?: () => string }): MessengerKeyStore {
  const keysPath = path.resolve(deps.path ?? DEFAULT_MESSENGER_KEYS_PATH);
  const now = deps.now ?? Date.now;
  const random = deps.random ?? (() => randomBytes(32).toString('base64url'));
  const state = loadKeysFile(keysPath);
  let saving: Promise<void> = Promise.resolve();

  const save = () => {
    const body = JSON.stringify({ version: 1, ...state }, null, 2);
    saving = saving
      .then(() => publishStoreAtomically(keysPath, body, { writeBackup: false, ensureDirectory: true }))
      .catch((error: unknown) => console.warn('[MessengerKeys] save failed:', error instanceof Error ? error.message : String(error)));
  };

  const isoAfter = (ms: number) => new Date(now() + ms).toISOString();
  const isLive = (expiresAt: string) => Date.parse(expiresAt) > now();

  const pruneExpired = () => {
    const pairing = state.pairingTokens.filter((entry) => isLive(entry.expiresAt));
    const tickets = state.roomTickets.filter((entry) => isLive(entry.expiresAt));
    if (pairing.length === state.pairingTokens.length && tickets.length === state.roomTickets.length) return;
    state.pairingTokens = pairing;
    state.roomTickets = tickets;
    save();
  };

  const setContactKey = (node: string, hash: string) => {
    state.contactKeys = state.contactKeys.filter((entry) => !sameNode(entry.node, node));
    state.contactKeys.push({ node, hash, createdAt: new Date(now()).toISOString() });
  };

  const addRoomToKey = (node: string, hash: string, roomId: string): RoomKey => {
    const existing = state.roomKeys.find((entry) => sameNode(entry.node, node));
    if (existing) {
      existing.hash = hash;
      if (!existing.rooms.includes(roomId)) existing.rooms.push(roomId);
      return existing;
    }
    const created: RoomKey = { node, hash, rooms: [roomId], createdAt: new Date(now()).toISOString() };
    state.roomKeys.push(created);
    return created;
  };

  const holdsContactKey = (node: string) => state.contactKeys.some((entry) => sameNode(entry.node, node));
  const holdsRoomKey = (node: string) => state.roomKeys.some((entry) => sameNode(entry.node, node));
  /** A ticket names its invitee, or is open ('') and then only for a node that holds no key yet. */
  const ticketFits = (ticket: RoomTicket, node: string) => {
    if (holdsContactKey(node)) return false;
    return ticket.invitee === '' ? !holdsRoomKey(node) : sameNode(ticket.invitee, node);
  };

  const contactAuth = (): MessengerKeyAuth => ({ kind: 'contact', scopes: [...CONTACT_SCOPES] });
  const roomAuth = (key: RoomKey): MessengerKeyAuth => ({ kind: 'room', scopes: [...ROOM_SCOPES], rooms: [...key.rooms] });

  const authenticate = (key: string, node: string): MessengerKeyAuth | null => {
    if (key === '') return null;
    pruneExpired();
    const hash = hashKey(key);
    const contact = state.contactKeys.find((entry) => sameHash(entry.hash, hash));
    if (contact) return sameNode(contact.node, node) ? contactAuth() : null;
    const roomKey = state.roomKeys.find((entry) => sameHash(entry.hash, hash));
    if (roomKey) return sameNode(roomKey.node, node) ? roomAuth(roomKey) : null;
    const pairing = state.pairingTokens.find((entry) => sameHash(entry.hash, hash));
    // Review H1: a first use never takes over a name that already holds a key here.
    if (pairing && holdsContactKey(node)) return null;
    if (pairing) {
      state.pairingTokens = state.pairingTokens.filter((entry) => entry !== pairing);
      setContactKey(node, hash);
      save();
      return contactAuth();
    }
    const ticket = state.roomTickets.find((entry) => sameHash(entry.hash, hash));
    if (ticket && !ticketFits(ticket, node)) return null;
    if (ticket) {
      state.roomTickets = state.roomTickets.filter((entry) => entry !== ticket);
      const created = addRoomToKey(node, hash, ticket.roomId);
      save();
      return roomAuth(created);
    }
    return null;
  };

  return {
    issuePairingToken: () => {
      const token = random();
      const expiresAt = isoAfter(PAIRING_TOKEN_TTL_MS);
      state.pairingTokens.push({ hash: hashKey(token), expiresAt });
      save();
      return { token, expiresAt };
    },
    issueRoomTicket: ({ roomId, invitee }) => {
      const token = random();
      const expiresAt = isoAfter(ROOM_TICKET_TTL_MS);
      state.roomTickets.push({ hash: hashKey(token), roomId, invitee, expiresAt });
      save();
      return { token, expiresAt };
    },
    revokeRoomKey: ({ roomId, node }) => {
      for (const entry of state.roomKeys) {
        if (sameNode(entry.node, node)) entry.rooms = entry.rooms.filter((room) => room !== roomId);
      }
      state.roomKeys = state.roomKeys.filter((entry) => entry.rooms.length > 0);
      state.roomTickets = state.roomTickets.filter((entry) => !(entry.roomId === roomId && sameNode(entry.invitee, node)));
      save();
    },
    revokeContact: (node) => {
      state.contactKeys = state.contactKeys.filter((entry) => !sameNode(entry.node, node));
      save();
    },
    issueContactKey: (node) => {
      const token = random();
      setContactKey(node, hashKey(token));
      save();
      return token;
    },
    authenticate,
    allowedRooms: (node) => {
      if (state.contactKeys.some((entry) => sameNode(entry.node, node))) return 'all';
      const roomKey = state.roomKeys.find((entry) => sameNode(entry.node, node));
      return roomKey ? [...roomKey.rooms] : 'none';
    },
    whenSaved: () => saving,
    contactNodes: () => state.contactKeys.map((entry) => entry.node),
  };
}

/**
 * FR-MSG-009 AC-2 (contract §3): a link whose scopes are exactly ['mcp:room'] (a room key, or my own room link) may
 * call room peer tools only, and a node whose key is limited to some rooms reaches only those
 * (checked on `arguments.roomId`). Answers null when the call may go on.
 */
export function guardMessengerPeerCall(
  call: { tool: string; args: Record<string, unknown>; actor: { type?: unknown; peer?: unknown; scopes?: unknown; linkScopes?: unknown } },
  allowedRooms: (node: string) => string[] | 'all' | 'none',
): { ok: false; code: 'INVALID_SCOPE' } | null {
  if (call.actor.type !== 'mcp-peer' || typeof call.actor.peer !== 'string') return null;
  // Review M4: judged from the scopes of the link, which the caller cannot narrow.
  const roomOnly = isRoomOnly(call.actor.linkScopes ?? call.actor.scopes);
  const isRoomPeerTool = call.tool.startsWith(ROOM_PEER_TOOL_PREFIX);
  if (roomOnly && !isRoomPeerTool) return refused();
  if (!isRoomPeerTool) return null;
  const allowed = allowedRooms(call.actor.peer);
  if (allowed === 'all') return null;
  // No key of mine (a fixed-key peer, or a room host over my own room link): the rooms side checks membership.
  if (allowed === 'none') return null;
  const roomId = call.args.roomId;
  return typeof roomId === 'string' && allowed.includes(roomId) ? null : refused();
}

function refused(): { ok: false; code: 'INVALID_SCOPE' } {
  return { ok: false, code: 'INVALID_SCOPE' };
}

function isRoomOnly(scopes: unknown): boolean {
  return Array.isArray(scopes) && scopes.length === 1 && scopes[0] === ROOM_SCOPES[0];
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function sameHash(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(presented, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameNode(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function loadKeysFile(keysPath: string): KeysFile {
  const empty: KeysFile = { contactKeys: [], pairingTokens: [], roomTickets: [], roomKeys: [] };
  if (!fs.existsSync(keysPath)) return empty;
  const parsed = parseJsonRecord(fs.readFileSync(keysPath, 'utf8'));
  if (!parsed) {
    console.warn('[MessengerKeys] keys.json is not valid JSON; starting with no keys');
    return empty;
  }
  return {
    contactKeys: arrayOf<ContactKey>(parsed.contactKeys),
    pairingTokens: arrayOf<PairingToken>(parsed.pairingTokens),
    roomTickets: arrayOf<RoomTicket>(parsed.roomTickets),
    roomKeys: arrayOf<RoomKey>(parsed.roomKeys),
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === 'object') as T[] : [];
}
