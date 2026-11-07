// FR-MSG-001..007, 009..012, 015 (server): the messenger rooms. The storage PC (host) numbers and
// keeps the log; member servers keep a copy, an outbox for messages the host has not numbered yet,
// and paste into their own sessions only (contract §2–§6, §10). This module knows nothing about
// WebSocket, Express or MCP: it talks to the world through the ports in RoomServiceDeps.
import { createHash, randomBytes } from 'node:crypto';
import { entranceNotice, displayMember, hasInvalidNameChars, isForSession, planDelivery, senderLabel, stripControls, type PasteJob } from './delivery.js';
import { resolveMentions, resolveTargets, type MentionRoster } from './mentions.js';
import { resumeRoom, sequenceMessage } from './sequencing.js';
import type { Approval, Invite, MessengerSettings, PendingInvite, ReceiptEntry, RoomMeta, RoomRecord, RoomStore, Ticket } from './roomStore.js';
import {
  DEFAULT_HOLD_LIMIT, ROOM_NAME_MAX, sameNode, sessionMemberId,
  type Room, type RoomMessage, type RoomSession, type SenderKind, type SessionAgent, type SystemEvent,
} from './types.js';

type Rec = Record<string, unknown>;
type Fail = { ok: false; code: string; [key: string]: unknown };

export interface RoomTransport {
  nodeName(): string;
  isConnected(node: string): boolean;
  call(node: string, tool: string, args: Rec): Promise<Rec>;
}

export interface LocalSession {
  sessionKey: string;
  name: string;
  /** The AI agent detected in the session now, or null. Room messages are pasted only where there is one. */
  agent: SessionAgent | null;
}

/** What this server pasted a message into, and why not elsewhere (FR-MSG-002 AC-4). */
interface PasteOutcome {
  pasted: string[];
  skipped: Record<string, string>;
}

export interface RoomNetPort {
  connectInfo(): { urls: string[]; fp: string };
  /** Answers { ok: false, code: 'ROOM_LINK_INVALID', ... } when the ticket cannot make a link. */
  ensureRoomLink(input: { hostNode: string; urls: string[]; fp: string; token: string }): Promise<Rec> | Rec | void;
  dropRoomLink(hostNode: string): void;
  isContact(node: string): boolean;
}

export interface RoomKeysPort {
  issueRoomTicket(input: { roomId: string; invitee: string }): { token: string; expiresAt: string };
  revokeRoomKey(input: { roomId: string; node: string }): void;
  allowedRooms(node: string): string[] | 'all' | 'none';
}

export interface RoomServiceDeps {
  store: RoomStore;
  transport: RoomTransport;
  sessions: { list(): LocalSession[] };
  /** true when written; false for a write error; { ok:false, code } for a refusal (PASTE_MULTILINE_UNSUPPORTED). */
  paster: { paste(sessionKey: string, text: string, submit: boolean): Promise<boolean | { ok: false; code: string }> };
  notify: (change: { roomId?: string; reason: string }) => void;
  /** FR-MSG-015: posts `text` to the webhook at `url`. */
  webhook?: (url: string, text: string) => Promise<void> | void;
  net?: RoomNetPort;
  keys?: RoomKeysPort;
  now?: () => Date;
  /** Seed for ids; random by default. */
  randomId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Rec) => void;
}

export const ROOM_PEER = {
  invite: 'buildergate.room.peer.invite',
  join: 'buildergate.room.peer.join',
  decline: 'buildergate.room.peer.decline',
  sync: 'buildergate.room.peer.sync',
  post: 'buildergate.room.peer.post',
  deliver: 'buildergate.room.peer.deliver',
  member: 'buildergate.room.peer.member',
  ticket: 'buildergate.room.peer.ticket',
  forwardInvite: 'buildergate.room.peer.forward-invite',
  adopt: 'buildergate.room.peer.adopt',
  hosted: 'buildergate.room.peer.hosted',
  receipt: 'buildergate.room.peer.receipt',
  approval: 'buildergate.room.peer.approval',
} as const;

export const SYNC_INTERVAL_MS = 5_000;
const SYNC_PAGE = 500;
const JOIN_HISTORY = 200;
const PASTED_KEEP = 2_000;
const RECEIPTS_KEEP = 1_000;
const HOLD_LIMIT_MAX = 1_000;
const TEXT_MAX = 20_000;
const JOIN_WAIT_MS = 10_000;
const JOIN_WAIT_STEP_MS = 250;
const OFFLINE_CODES = new Set(['PEER_DISCONNECTED', 'PEER_NOT_FOUND', 'PEER_CALL_TIMEOUT']);
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export interface RoomSummary {
  id: string;
  name: string;
  hostNode: string;
  isHost: boolean;
  hostOnline: boolean;
  lastAt: string;
  lastText: string;
  lastFrom: string;
  lastSeq: number;
  unread: number;
  /** H-4: unread messages that name me or one of my sessions. */
  mention: number;
  held: boolean;
  invitedPending: string[];
  /** M-2: people this server invited while the host was away (보내는 중). */
  invitesWaitingHost: string[];
}

export type SendResult = {
  ok: true;
  messageId: string;
  seq: number | null;
  held: boolean;
  status: 'sequenced' | 'waiting-host';
  /** D8: pasted = sessions here really written; skipped/skippedReasons only when some were not. */
  delivery: { pasted: number; waiting: number; skipped?: number; skippedReasons?: Record<string, number> };
};

function fail(code: string, extra: Rec = {}): Fail {
  return { ok: false, code, ...extra };
}

function asRecord(value: unknown): Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function base32(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; out.length < length; i += 1) out += BASE32[bytes[i % bytes.length]! % 32];
  return out;
}

function quoteName(name: string): string {
  return /^[^\s"@:]+$/u.test(name) ? name : `"${name}"`;
}

export class RoomService {
  private readonly records = new Map<string, RoomRecord>();
  private readonly logs = new Map<string, RoomMessage[]>();
  private readonly outboxes = new Map<string, RoomMessage[]>();
  /** FR-MSG-002 AC-4: receipts by room, then sequence number. */
  private readonly receipts = new Map<string, Map<number, ReceiptEntry>>();
  /** Session ids this server pasted each message into, by clientMsgId (settles when the pastes do). */
  private readonly localPastes = new Map<string, Promise<PasteOutcome>>();
  private invites: Invite[] = [];
  private approvals: Approval[] = [];
  private settings: MessengerSettings = {};
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly pasteChains = new Map<string, Promise<unknown>>();
  private readonly background = new Set<Promise<unknown>>();
  private saving: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RoomServiceDeps) {}

  // ---------------------------------------------------------------------------------------------
  // Life cycle

  async start(): Promise<void> {
    const loaded = await this.deps.store.load();
    for (const record of loaded.rooms) {
      this.records.set(record.room.id, { room: record.room, meta: { ...emptyMeta(), ...record.meta } });
      this.logs.set(record.room.id, await this.deps.store.readLog(record.room.id));
      this.outboxes.set(record.room.id, await this.deps.store.readOutbox(record.room.id));
      const stored = await this.deps.store.readReceipts(record.room.id);
      this.receipts.set(record.room.id, new Map(Object.entries(stored).map(([seq, entry]) => [Number(seq), entry])));
    }
    this.invites = loaded.invites;
    this.approvals = loaded.approvals;
    this.settings = loaded.settings;
  }

  /** FR-MSG-002 AC-3 (contract §3): sync every 5 s. */
  startLoop(intervalMs = SYNC_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when no background work (pushes, pastes, saves) is left. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  async tick(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.meta.left) continue;
      await this.reconcileSessions(record);
      if (!this.isHost(record.room)) await this.syncRoom(record.room.id);
      if (record.meta.pendingInvites.length > 0) await this.flushInvites(record.room.id);
    }
    await this.flushApprovals();
    for (const invite of this.invites.filter((candidate) => candidate.declined)) await this.flushDecline(invite);
    for (const invite of this.invites.filter((candidate) => candidate.accepting && !candidate.declined)) {
      if (this.deps.transport.isConnected(invite.room.hostNode)) await this.join(invite, invite.accepting!);
    }
  }

  /** Contract §3: a link came up — sync the rooms it hosts, deliver what waited for it. */
  onLinkConnected(node: string): void {
    this.track((async () => {
      for (const record of [...this.records.values()]) {
        if (record.meta.left) continue;
        if (sameNode(record.room.hostNode, node) && !this.isHost(record.room)) await this.syncRoom(record.room.id);
        const waiting = record.meta.pendingInvites.some((pending) => sameNode(pending.needsTicket ? record.room.hostNode : pending.via ?? pending.invitee, node)
          || (pending.needsTicket && sameNode(pending.invitee, node)));
        if (waiting) await this.flushInvites(record.room.id);
      }
      await this.flushApprovals();
      for (const invite of this.invites.filter((candidate) => candidate.declined && sameNode(candidate.room.hostNode, node))) await this.flushDecline(invite);
      for (const invite of this.invites.filter((candidate) => candidate.accepting && sameNode(candidate.room.hostNode, node))) {
        await this.join(invite, invite.accepting!);
      }
    })());
  }

  // ---------------------------------------------------------------------------------------------
  // Views (contract §9)

  state() {
    const self = this.self();
    const rooms = this.visibleRecords().map((record) => this.summary(record))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    const sessionRooms: Record<string, string[]> = {};
    for (const record of this.visibleRecords()) {
      for (const session of record.room.sessions) {
        if (!sameNode(session.node, self)) continue;
        (sessionRooms[session.sessionKey] ??= []).push(record.room.name);
      }
    }
    return {
      me: { name: self },
      hasWebhook: Boolean(this.settings.webhookUrl),
      rooms,
      invites: this.invites.filter((invite) => !invite.declined).map((invite) => ({
        id: invite.id, room: invite.room, invitedBy: invite.invitedBy, at: invite.at,
        ...(invite.message ? { message: invite.message } : {}),
        ...(invite.accepting ? { accepting: true } : {}),
      })),
      approvals: this.approvals.filter((approval) => {
        const record = this.records.get(approval.roomId);
        return record !== undefined && sameNode(record.room.createdBy, self) && (approval.remote === true || this.isHost(record.room));
      }).map(({ remote: _remote, notified: _notified, ...approval }) => ({ ...approval, roomName: this.records.get(approval.roomId)?.room.name ?? '' })),
      sessionRooms,
      unread: {
        total: rooms.reduce((sum, room) => sum + room.unread, 0),
        mention: rooms.reduce((sum, room) => sum + room.mention, 0),
      },
    };
  }

  async getRoom(roomId: string, query: { before?: number; limit?: number }): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const log = this.logOf(roomId);
    const before = query.before;
    const upTo = before === undefined ? log : log.filter((message) => (message.seq ?? 0) < before);
    const host = record.room.hostNode;
    return {
      ok: true,
      room: {
        ...record.room,
        sessions: this.sessionsWithAgents(record.room),
        isHost: this.isHost(record.room),
        invitedPending: invitedPending(record.room),
      },
      messages: this.withReceipts(roomId, upTo.slice(-limit)),
      host: {
        node: host,
        online: this.hostOnline(record.room),
        ...(record.meta.hostOfflineSince ? { offlineSince: record.meta.hostOfflineSince } : {}),
      },
      outbox: [...this.outboxOf(roomId)],
    };
  }

  search(query: string): Rec {
    const q = query.trim().toLowerCase();
    if (!q) return { ok: true, rooms: [], messages: [] };
    const records = this.visibleRecords();
    const messages: Rec[] = [];
    for (const record of records) {
      for (const message of this.logOf(record.room.id)) {
        if (message.text.toLowerCase().includes(q)) {
          messages.push({ roomId: record.room.id, roomName: record.room.name, seq: message.seq, text: message.text });
        }
      }
    }
    return {
      ok: true,
      rooms: records.filter((record) => record.room.name.toLowerCase().includes(q)).map((record) => ({ id: record.room.id, name: record.room.name })),
      messages: messages.slice(-50),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // UI operations (contract §9)

  async createRoom(input: { name: unknown; sessions: unknown; people: unknown; message?: unknown }): Promise<Rec> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > ROOM_NAME_MAX) return fail('VALIDATION_ERROR', { fieldErrors: { name: `1 to ${ROOM_NAME_MAX} characters` } });
    if (hasInvalidNameChars(name)) return fail('NAME_INVALID_CHAR', { fieldErrors: { name: 'no control characters, ] or |' } });
    const self = this.self();
    const sessions = this.localSessions(strings(input.sessions));
    if ('code' in sessions) return sessions;
    const people = [...new Set(strings(input.people).filter((node) => !sameNode(node, self)))];
    const now = this.nowIso();
    const room: Room = {
      id: this.newRoomId(), name, hostNode: self, createdBy: self, createdAt: now,
      settings: { invitePolicy: 'auto', holdLimit: DEFAULT_HOLD_LIMIT },
      people: [{ node: self, joinedAt: now, state: 'joined' }],
      sessions: sessions.map((session) => this.sessionEntry(self, session)),
      agentRun: 0, held: false, lastSeq: 0,
    };
    const record: RoomRecord = { room, meta: { ...emptyMeta() } };
    this.records.set(room.id, record);
    this.logs.set(room.id, []);
    this.outboxes.set(room.id, []);
    const message = asString(input.message)?.trim() || undefined;
    await this.serial(room.id, async () => {
      const added: RoomMessage[] = [];
      for (const node of people) {
        const result = this.hostAddInvitee(record, node, self, message);
        if (!result.ok) continue;
        added.push(...result.messages);
        record.meta.pendingInvites.push({ invitee: node, invitedBy: self, ...(message ? { message } : {}), ...this.ticketFor(record, node) });
      }
      await this.hostAppend(record, added);
    });
    this.track(this.flushInvites(room.id));
    return { ok: true, room: this.summary(record) };
  }

  postFromUi(roomId: string, text: unknown): Promise<SendResult | Fail> {
    const record = this.visible(roomId);
    if (!record) return Promise.resolve(fail('ROOM_NOT_FOUND'));
    return this.send(record, text, [], { kind: 'human' });
  }

  async markRead(roomId: string, seq: unknown): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    const value = typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : record.room.lastSeq;
    record.meta.readSeq = Math.max(record.meta.readSeq, Math.min(value, this.lastAppliedSeq(record)));
    this.changed(record.room.id, 'read');
    return { ok: true };
  }

  async invite(roomId: string, input: { sessions?: unknown; people?: unknown; message?: unknown }): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    const self = this.self();
    const message = asString(input.message)?.trim() || undefined;
    const sessions = this.localSessions(strings(input.sessions));
    if ('code' in sessions) return sessions;
    const fresh = sessions.filter((session) => !record.room.sessions.some((existing) => existing.id === sessionMemberId(self, session.sessionKey)));
    if (fresh.length > 0) {
      const added = await this.memberOp(record, { op: 'add-sessions', sessions: fresh.map((s) => ({ sessionKey: s.sessionKey, name: s.name, agent: s.agent })) });
      if (added.ok === false) return added;
    }
    const pending: string[] = [];
    let waitingHost = false;
    for (const node of [...new Set(strings(input.people))].filter((candidate) => !sameNode(candidate, self))) {
      if (this.isHost(record.room)) {
        const outcome = await this.serial(roomId, async () => {
          const result = this.hostAddInvitee(record, node, self, message);
          if (!result.ok) return result;
          if (result.approval) return { ok: true, approval: true };
          record.meta.pendingInvites.push({ invitee: node, invitedBy: self, ...(message ? { message } : {}), ...this.ticketFor(record, node) });
          await this.hostAppend(record, result.messages);
          return { ok: true };
        });
        if (outcome.ok === false) return outcome;
        if ((outcome as Rec).approval) pending.push(node);
        continue;
      }
      if (!this.deps.transport.isConnected(record.room.hostNode)) {
        record.meta.pendingInvites.push({ invitee: node, invitedBy: self, ...(message ? { message } : {}), needsTicket: true });
        waitingHost = true;
        this.changed(roomId, 'invite');
        continue;
      }
      const ticket = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.ticket, { roomId, invitee: node, ...(message ? { message } : {}) });
      if (ticket.code === 'APPROVAL_PENDING') {
        pending.push(node);
        continue;
      }
      if (ticket.ok !== true) return this.hostFailure(record, ticket);
      record.meta.pendingInvites.push({ invitee: node, invitedBy: self, ...(message ? { message } : {}), ticket: ticket.ticket as Ticket });
      this.persist();
    }
    this.track(this.flushInvites(roomId));
    return { ok: true, pending, ...(waitingHost ? { status: 'waiting-host' } : {}) };
  }

  /** FR-MSG-009 AC-6: a bgi1 code anyone can redeem once. */
  async inviteCode(roomId: string, message?: unknown): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    const text = asString(message)?.trim() || undefined;
    let ticket: Ticket | undefined;
    if (this.isHost(record.room)) {
      const made = this.makeTicket(record, '');
      if ('code' in made) return made;
      ticket = made;
    } else {
      const result = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.ticket, { roomId, invitee: '' });
      if (result.ok !== true) return this.hostFailure(record, result);
      ticket = result.ticket as Ticket;
    }
    const payload = { v: 1, ticket, invitedBy: this.self(), ...(text ? { message: text } : {}) };
    return { ok: true, code: `bgi1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}` };
  }

  /** Called by the code redeem route for a bgi1 code. */
  async redeemInvite(payload: unknown): Promise<Rec> {
    const record = asRecord(payload);
    const ticket = asRecord(record.ticket);
    const roomId = asString(ticket.roomId);
    const hostNode = asString(ticket.hostNode);
    const token = asString(ticket.token);
    if (!roomId || !hostNode || !token) return fail('CODE_INVALID');
    if (sameNode(hostNode, this.self())) return fail('NAME_IS_SELF');
    const existing = this.records.get(roomId);
    if (existing && !existing.meta.left) return fail('ALREADY_MEMBER');
    const invite: Invite = {
      id: `inv_${this.randomId()}`,
      room: { id: roomId, name: asString(ticket.roomName) ?? roomId, hostNode, people: [], sessions: [] },
      invitedBy: asString(record.invitedBy) ?? hostNode,
      ...(asString(record.message) ? { message: asString(record.message) } : {}),
      at: this.nowIso(),
      ticket: { roomId, roomName: asString(ticket.roomName) ?? roomId, hostNode, urls: strings(ticket.urls), fp: asString(ticket.fp) ?? '', token },
    };
    this.invites = [...this.invites.filter((candidate) => candidate.room.id !== roomId), invite];
    this.changed(undefined, 'invite');
    return { ok: true, kind: 'invite', invite: { id: invite.id, room: invite.room, invitedBy: invite.invitedBy, at: invite.at, ...(invite.message ? { message: invite.message } : {}) } };
  }

  async acceptInvite(inviteId: string, input: { sessions?: unknown; personOnly?: unknown; enter?: unknown }): Promise<Rec> {
    const invite = this.invites.find((candidate) => candidate.id === inviteId && !candidate.declined);
    if (!invite) return fail('INVITE_NOT_FOUND');
    const personOnly = input.personOnly === true;
    const enter = input.enter !== false;
    const sessionKeys = personOnly ? [] : strings(input.sessions);
    const sessions = this.localSessions(sessionKeys);
    if ('code' in sessions) return sessions;
    const host = invite.room.hostNode;
    if (invite.ticket && !this.deps.net?.isContact(host)) {
      const { urls, fp, token } = invite.ticket;
      const linked = asRecord(await this.deps.net?.ensureRoomLink({ hostNode: host, urls, fp, token }));
      if (linked.ok === false) return { ...linked, ok: false, code: asString(linked.code) ?? 'ROOM_LINK_INVALID' };
    }
    await this.waitFor(host);
    return this.join(invite, { sessions: sessionKeys, personOnly, enter });
  }

  async declineInvite(inviteId: string): Promise<Rec> {
    const invite = this.invites.find((candidate) => candidate.id === inviteId && !candidate.declined);
    if (!invite) return fail('INVITE_NOT_FOUND');
    invite.declined = true;
    invite.accepting = undefined;
    await this.flushDecline(invite);
    this.changed(undefined, 'invite');
    return { ok: true };
  }

  async decideApproval(approvalId: string, approve: boolean): Promise<Rec> {
    const approval = this.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) return fail('APPROVAL_NOT_FOUND');
    const record = this.records.get(approval.roomId);
    if (!record) {
      this.approvals = this.approvals.filter((candidate) => candidate.id !== approvalId);
      this.persist();
      return fail('ROOM_NOT_FOUND');
    }
    if (this.isHost(record.room)) return this.hostDecide(record, approvalId, approve);
    // FR-MSG-009 AC-3: a copy on the creator's server; the host decides.
    const result = await this.memberOp(record, { op: 'approve', approvalId, approve });
    if (result.ok === false) return result;
    this.approvals = this.approvals.filter((candidate) => candidate.id !== approvalId);
    this.changed(record.room.id, 'approval');
    return { ok: true };
  }

  async removeMember(roomId: string, memberId: string): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    const self = this.self();
    const split = memberId.indexOf('::');
    if (split > 0) {
      const owner = memberId.slice(0, split);
      if (!sameNode(owner, self) && !sameNode(record.room.createdBy, self)) return fail('NOT_CREATOR');
      return this.memberOp(record, { op: 'remove-session', sessionId: memberId });
    }
    if (sameNode(memberId, self)) return this.leave(roomId);
    if (!sameNode(record.room.createdBy, self)) return fail('NOT_CREATOR');
    return this.memberOp(record, { op: 'kick', node: memberId });
  }

  async leave(roomId: string): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    const result = await this.memberOp(record, { op: 'leave' });
    if (result.ok === false) return result;
    this.markLeft(record);
    return { ok: true };
  }

  async updateSettings(roomId: string, patch: { invitePolicy?: unknown; holdLimit?: unknown }): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    if (!sameNode(record.room.createdBy, this.self())) return fail('NOT_CREATOR');
    const checked = checkSettings(patch);
    if ('code' in checked) return checked;
    return this.memberOp(record, { op: 'settings', ...checked });
  }

  async updateSession(roomId: string, sessionKey: string, patch: { enter?: unknown; pasteAll?: unknown }): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    if (!record.room.sessions.some((session) => session.id === sessionMemberId(this.self(), sessionKey))) return fail('SESSION_NOT_IN_ROOM');
    return this.memberOp(record, {
      op: 'update-session', sessionKey,
      ...(typeof patch.enter === 'boolean' ? { enter: patch.enter } : {}),
      ...(typeof patch.pasteAll === 'boolean' ? { pasteAll: patch.pasteAll } : {}),
    });
  }

  async resume(roomId: string): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    return this.memberOp(record, { op: 'resume' });
  }

  async transfer(roomId: string, node: string): Promise<Rec> {
    const record = this.visible(roomId);
    if (!record) return fail('ROOM_NOT_FOUND');
    if (!sameNode(record.room.createdBy, this.self())) return fail('NOT_CREATOR');
    if (this.isHost(record.room)) return this.hostTransfer(record, node);
    if (!this.deps.transport.isConnected(record.room.hostNode)) return fail('HOST_OFFLINE');
    return this.memberOp(record, { op: 'transfer', node });
  }

  /** FR-MSG-012 AC-2: a new room hosted here, seeded with this server's copy of the log. */
  async continueRoom(roomId: string): Promise<Rec> {
    const old = this.visible(roomId);
    if (!old) return fail('ROOM_NOT_FOUND');
    const self = this.self();
    const now = this.nowIso();
    const live = new Set(this.deps.sessions.list().map((session) => session.sessionKey));
    const id = this.newRoomId();
    const copied = this.logOf(roomId).filter((message) => message.seq !== null)
      .map((message, index) => ({ ...message, roomId: id, seq: index + 1 }));
    const room: Room = {
      id, name: old.room.name, hostNode: self, createdBy: self, createdAt: now,
      settings: { ...old.room.settings },
      people: [
        { node: self, joinedAt: now, state: 'joined' },
        ...old.room.people.filter((person) => person.state === 'joined' && !sameNode(person.node, self))
          .map((person) => ({ node: person.node, invitedBy: self, joinedAt: now, state: 'invited' as const })),
      ],
      sessions: old.room.sessions.filter((session) => sameNode(session.node, self) && live.has(session.sessionKey)),
      agentRun: 0, held: false, lastSeq: copied.length,
    };
    const record: RoomRecord = { room, meta: { ...emptyMeta(), mySeq: copied.length, readSeq: copied.length } };
    record.meta.pendingInvites = room.people.filter((person) => person.state === 'invited')
      .map((person) => ({ invitee: person.node, invitedBy: self, ...this.ticketFor(record, person.node) }));
    this.records.set(id, record);
    this.logs.set(id, copied);
    this.outboxes.set(id, []);
    await this.deps.store.writeLog(id, copied);
    await this.serial(id, () => this.hostAppend(record, [this.systemMessage(id, 'continued', self, roomId)]));
    this.track(this.flushInvites(id));
    return { ok: true, room: this.summary(record) };
  }

  async setWebhook(url: unknown): Promise<Rec> {
    const value = typeof url === 'string' ? url.trim() : '';
    if (value && !/^https?:\/\/\S+$/u.test(value)) return fail('VALIDATION_ERROR', { fieldErrors: { webhookUrl: 'an http(s) URL' } });
    this.settings = value ? { webhookUrl: value } : {};
    await this.deps.store.saveSettings(this.settings);
    this.changed(undefined, 'settings');
    return { ok: true, hasWebhook: Boolean(value) };
  }

  // ---------------------------------------------------------------------------------------------
  // Agent tools (FR-MSG-007, contract §8). Only rooms the calling session is in.

  roomsForSession(sessionKey: string): Rec[] {
    const id = sessionMemberId(this.self(), sessionKey);
    return this.visibleRecords().filter((record) => record.room.sessions.some((session) => session.id === id)).map((record) => {
      const summary = this.summary(record);
      return {
        name: record.room.name, id: record.room.id,
        members: record.room.people.filter((person) => person.state === 'joined').length + record.room.sessions.length,
        unread: summary.unread, held: record.room.held, hostOnline: summary.hostOnline,
      };
    });
  }

  membersForSession(sessionKey: string, ref: string): Rec {
    const found = this.roomForSession(sessionKey, ref);
    if ('code' in found) return found;
    const self = this.self();
    const local = new Map(this.deps.sessions.list().map((session) => [session.sessionKey, session]));
    return {
      ok: true,
      people: found.room.people.filter((person) => person.state === 'joined').map((person) => ({
        name: person.node,
        connected: sameNode(person.node, self) || this.deps.transport.isConnected(person.node),
        contact: sameNode(person.node, self) || (this.deps.net?.isContact(person.node) ?? false),
      })),
      sessions: found.room.sessions.map((session) => {
        const mine = sameNode(session.node, self);
        return {
          mention: mine ? `@${quoteName(session.name)}` : `@${session.node}::${quoteName(session.name)}`,
          id: session.id,
          name: session.name,
          owner: session.node,
          agent: mine ? local.get(session.sessionKey)?.agent ?? null : session.agent ?? null,
        };
      }),
    };
  }

  async postFromSession(sessionKey: string, ref: string, text: unknown, to?: unknown): Promise<SendResult | Fail> {
    const found = this.roomForSession(sessionKey, ref);
    if ('code' in found) return found;
    return this.send(found, text, strings(to), { kind: 'agent', sessionKey });
  }

  historyForSession(sessionKey: string, ref: string, query: { before?: unknown; after?: unknown; limit?: unknown }): Rec {
    const found = this.roomForSession(sessionKey, ref);
    if ('code' in found) return found;
    const limit = typeof query.limit === 'number' ? Math.min(Math.max(Math.trunc(query.limit), 1), 100) : 30;
    const before = typeof query.before === 'number' ? query.before : undefined;
    const after = typeof query.after === 'number' ? query.after : undefined;
    let messages = this.logOf(found.room.id).filter((message) => message.seq !== null
      && (before === undefined || message.seq < before) && (after === undefined || message.seq > after));
    messages = after !== undefined && before === undefined ? messages.slice(0, limit) : messages.slice(-limit);
    return { ok: true, room: { id: found.room.id, name: found.room.name }, messages: this.withReceipts(found.room.id, messages) };
  }

  // ---------------------------------------------------------------------------------------------
  // Peer protocol (contract §3). `from` is the node the link authenticated.

  async peerInvite(from: string, args: Rec): Promise<Rec> {
    const room = asRecord(args.room) as unknown as Room;
    const roomId = asString(args.roomId) ?? room.id;
    if (!roomId || typeof room.name !== 'string' || !Array.isArray(room.people) || !Array.isArray(room.sessions)) return fail('VALIDATION_ERROR');
    // Only a contact, or a node holding a key for this very room, may hand out an invitation here.
    const allowed = this.deps.keys?.allowedRooms(from);
    if (!(this.deps.net?.isContact(from) ?? false) && !(Array.isArray(allowed) && allowed.includes(roomId))) return fail('INVALID_INVITE');
    const existing = this.records.get(roomId);
    if (existing && !existing.meta.left) return { ok: true, already: true };
    const self = this.self();
    const ticket = asRecord(args.ticket);
    const message = asString(args.message);
    const invite: Invite = {
      id: `inv_${this.randomId()}`,
      room: {
        id: roomId, name: room.name, hostNode: room.hostNode,
        people: room.people.filter((person) => person.state === 'joined').map((person) => person.node),
        sessions: room.sessions.map((session) => displayMember(room, session.id, self)),
      },
      invitedBy: from,
      ...(message ? { message } : {}),
      at: this.nowIso(),
      ...(asString(ticket.token) ? {
        ticket: {
          roomId, roomName: room.name, hostNode: asString(ticket.hostNode) ?? room.hostNode,
          urls: strings(ticket.urls), fp: asString(ticket.fp) ?? '', token: asString(ticket.token)!,
        },
      } : {}),
    };
    this.invites = [...this.invites.filter((candidate) => candidate.room.id !== roomId), invite];
    this.changed(undefined, 'invite');
    this.webhook(room.name, from, message ?? '방에 초대했습니다');
    return { ok: true };
  }

  async peerJoin(from: string, args: Rec): Promise<Rec> {
    const record = this.hosted(asString(args.roomId));
    if ('code' in record) return record;
    return this.serial(record.room.id, async () => {
      let person = record.room.people.find((candidate) => sameNode(candidate.node, from));
      if (!person) {
        // H-2: a room key for this room (ticket) admits; a contact key ('all') does not — that needs an invitation.
        const allowed = this.deps.keys?.allowedRooms(from);
        if (!(Array.isArray(allowed) && allowed.includes(record.room.id))) return fail('NOT_INVITED');
        person = { node: from, joinedAt: this.nowIso(), state: 'invited' };
        record.room = { ...record.room, people: [...record.room.people, person] };
      }
      if (person.state === 'approval') return fail('APPROVAL_PENDING');
      if (parseSessionArgs(args.sessions).some((session) => hasInvalidNameChars(session.name))) return fail('NAME_INVALID_CHAR');
      const joined = { ...person, state: 'joined' as const, joinedAt: this.nowIso() };
      const sessions = args.personOnly === true ? [] : parseSessionArgs(args.sessions)
        .filter((session) => !record.room.sessions.some((existing) => existing.id === sessionMemberId(from, session.sessionKey)))
        .map((session) => ({ ...this.sessionEntry(from, session), enter: session.enter, pasteAll: session.pasteAll, agent: session.agent }));
      record.room = {
        ...record.room,
        people: record.room.people.map((candidate) => candidate === person ? joined : candidate),
        sessions: [...record.room.sessions, ...sessions],
      };
      this.approvals = this.approvals.filter((approval) => !(approval.roomId === record.room.id && sameNode(approval.invitee, from)));
      await this.hostAppend(record, [this.systemMessage(record.room.id, 'joined', from)]);
      return { ok: true, room: record.room, messages: this.withReceipts(record.room.id, this.logOf(record.room.id).slice(-JOIN_HISTORY)) };
    });
  }

  async peerDecline(from: string, args: Rec): Promise<Rec> {
    const record = this.hosted(asString(args.roomId));
    if ('code' in record) return record;
    return this.serial(record.room.id, async () => {
      const person = record.room.people.find((candidate) => sameNode(candidate.node, from) && candidate.state !== 'joined');
      if (!person) return { ok: true };
      record.room = { ...record.room, people: record.room.people.filter((candidate) => candidate !== person) };
      await this.hostAppend(record, [this.systemMessage(record.room.id, 'declined', from)]);
      return { ok: true };
    });
  }

  async peerSync(from: string, args: Rec): Promise<Rec> {
    const roomId = asString(args.roomId);
    const moved = roomId ? this.records.get(roomId)?.meta.movedTo : undefined;
    if (moved && roomId && !this.isHost(this.records.get(roomId)!.room)) {
      return fail('NOT_HOST', { newHost: moved.host, ...(moved.tickets[from] ? { ticket: moved.tickets[from] } : {}) });
    }
    const record = this.hostedFor(roomId, from);
    if ('code' in record) return record;
    const afterSeq = typeof args.afterSeq === 'number' ? args.afterSeq : 0;
    const outbox = Array.isArray(args.outbox) ? args.outbox.map((message) => this.fromPeer(from, record.room.id, message)).filter(isMessage) : [];
    return this.serial(record.room.id, async () => {
      const names = parseSessionArgs(args.sessions);
      if (names.length > 0) {
        record.room = {
          ...record.room,
          sessions: record.room.sessions.map((session) => {
            const update = sameNode(session.node, from) ? names.find((candidate) => candidate.sessionKey === session.sessionKey) : undefined;
            if (!update) return session;
            const name = hasInvalidNameChars(update.name) ? session.name : update.name;
            return name === session.name && sameAgent(update.agent, session.agent) ? session : { ...session, name, agent: update.agent };
          }),
        };
      }
      await this.hostAppend(record, outbox);
      const messages = this.logOf(record.room.id).filter((message) => (message.seq ?? 0) > afterSeq).slice(0, SYNC_PAGE);
      return { ok: true, room: record.room, messages: this.withReceipts(record.room.id, messages), receipts: this.receiptViews(record.room.id) };
    });
  }

  async peerPost(from: string, args: Rec): Promise<Rec> {
    const record = this.hostedFor(asString(args.roomId), from);
    if ('code' in record) return record;
    const message = this.fromPeer(from, record.room.id, args.message);
    if (!message) return fail('VALIDATION_ERROR');
    return this.serial(record.room.id, async () => {
      const [stored] = await this.hostAppend(record, [message]);
      return { ok: true, seq: stored!.seq, held: stored!.held === true };
    });
  }

  async peerDeliver(from: string, args: Rec): Promise<Rec> {
    const roomId = asString(args.roomId) ?? '';
    const record = this.records.get(roomId);
    if (!record || record.meta.left || this.isHost(record.room) || !sameNode(record.room.hostNode, from)) return { ok: true, ignored: true };
    const room = asRecord(args.room) as unknown as Room;
    const messages = Array.isArray(args.messages) ? args.messages.filter(isMessage) : [];
    const gap = await this.serial(roomId, async () => {
      const result = await this.applyFromHost(record, room, messages);
      await this.mergeReceipts(roomId, [asRecord(args.receipts), receiptsFromMessages(messages)]);
      return result;
    });
    if (gap) this.track(this.syncRoom(roomId));
    return { ok: true };
  }

  async peerMember(from: string, args: Rec): Promise<Rec> {
    const record = this.hostedFor(asString(args.roomId), from);
    if ('code' in record) return record;
    return this.hostMemberOp(record, from, args);
  }

  async peerTicket(from: string, args: Rec): Promise<Rec> {
    const record = this.hostedFor(asString(args.roomId), from);
    if ('code' in record) return record;
    const invitee = asString(args.invitee) ?? '';
    const message = asString(args.message);
    if (!invitee) {
      const ticket = this.makeTicket(record, '');
      return 'code' in ticket ? ticket : { ok: true, ticket };
    }
    if (this.deps.net && this.deps.net.connectInfo().urls.length === 0) return fail('LAN_OFF');
    return this.serial(record.room.id, async () => {
      const result = this.hostAddInvitee(record, invitee, from, message);
      if (!result.ok) return result;
      if (result.approval) return fail('APPROVAL_PENDING');
      const ticket = this.makeTicket(record, invitee);
      if ('code' in ticket) return ticket;
      await this.hostAppend(record, result.messages);
      return { ok: true, ticket };
    });
  }

  async peerForwardInvite(from: string, args: Rec): Promise<Rec> {
    const roomId = asString(args.roomId) ?? '';
    const record = this.records.get(roomId);
    if (!record || !sameNode(record.room.hostNode, from)) return fail('NOT_IN_ROOM');
    const invitee = asString(args.invitee);
    if (!invitee) return fail('VALIDATION_ERROR');
    const ticket = asRecord(args.ticket);
    const message = asString(args.message);
    record.meta.pendingInvites.push({
      invitee, invitedBy: this.self(), ...(message ? { message } : {}),
      ...(asString(ticket.token) ? { ticket: ticket as unknown as Ticket } : {}),
    });
    this.persist();
    this.track(this.flushInvites(roomId));
    return { ok: true };
  }

  async peerAdopt(from: string, args: Rec): Promise<Rec> {
    const room = asRecord(args.room) as unknown as Room;
    const record = this.records.get(asString(args.roomId) ?? room.id ?? '');
    if (!record || !sameNode(record.room.hostNode, from) || !sameNode(room.hostNode, this.self())) return fail('NOT_IN_ROOM');
    const messages = Array.isArray(args.messages) ? args.messages.filter(isMessage) : [];
    return this.serial(record.room.id, async () => {
      record.room = room;
      this.logs.set(room.id, messages);
      await this.deps.store.writeLog(room.id, messages);
      record.meta.mySeq = room.lastSeq;
      record.meta.hostOfflineSince = undefined;
      record.meta.movedTo = undefined;
      const tickets: Record<string, Ticket> = {};
      for (const person of room.people) {
        if (person.state !== 'joined' || sameNode(person.node, this.self()) || this.deps.net?.isContact(person.node)) continue;
        const ticket = this.makeTicket(record, person.node);
        if (!('code' in ticket)) tickets[person.node] = ticket;
      }
      const waiting = this.outboxOf(room.id).map((message) => ({ ...message, seq: null }));
      await this.hostAppend(record, waiting);
      this.changed(room.id, 'room');
      return { ok: true, tickets };
    });
  }

  async peerHosted(from: string, args: Rec): Promise<Rec> {
    const roomId = asString(args.roomId) ?? '';
    const record = this.records.get(roomId);
    const newHost = asString(args.newHost);
    if (!record || !newHost || !sameNode(record.room.hostNode, from)) return fail('NOT_IN_ROOM');
    this.repoint(record, newHost, asRecord(args.ticket));
    this.track(this.syncRoom(roomId));
    return { ok: true };
  }

  /** FR-MSG-002 AC-4: a member server pasted (or did not paste) a numbered message. */
  async peerReceipt(from: string, args: Rec): Promise<Rec> {
    const record = this.hostedFor(asString(args.roomId), from);
    if ('code' in record) return record;
    const seq = typeof args.seq === 'number' ? args.seq : NaN;
    const reasons = asRecord(args.skippedReasons);
    const skipped: Record<string, string> = {};
    for (const id of strings(args.skipped)) skipped[id] = asString(reasons[id]) ?? 'SKIPPED';
    await this.serial(record.room.id, async () => this.hostReceipt(record, from, seq, { pasted: strings(args.pasted), skipped }));
    return { ok: true };
  }

  /** FR-MSG-009 AC-3: the host hands an approval card to the room's creator. */
  async peerApproval(from: string, args: Rec): Promise<Rec> {
    const roomId = asString(args.roomId) ?? '';
    const record = this.records.get(roomId);
    if (!record || !sameNode(record.room.hostNode, from) || !sameNode(record.room.createdBy, this.self())) return fail('NOT_IN_ROOM');
    const approval = asRecord(args.approval);
    const id = asString(approval.id);
    const invitee = asString(approval.invitee);
    const invitedBy = asString(approval.invitedBy);
    if (!id || !invitee || !invitedBy) return fail('VALIDATION_ERROR');
    const message = asString(approval.message);
    this.approvals = [
      ...this.approvals.filter((candidate) => candidate.id !== id),
      { id, roomId, invitee, invitedBy, ...(message ? { message } : {}), at: asString(approval.at) ?? this.nowIso(), remote: true },
    ];
    this.changed(roomId, 'approval');
    this.webhook(record.room.name, invitedBy, `${invitee} 님 참여 승인이 필요합니다`);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Sending (contract §4)

  private async send(record: RoomRecord, rawText: unknown, toEntries: string[], from: { kind: SenderKind; sessionKey?: string }): Promise<SendResult | Fail> {
    const text = typeof rawText === 'string' ? stripControls(rawText).trim() : '';
    if (!text || text.length > TEXT_MAX) return fail('VALIDATION_ERROR', { fieldErrors: { text: `1 to ${TEXT_MAX} characters` } });
    const roster = this.roster(record.room);
    const mentioned = resolveMentions(text, roster);
    if (!mentioned.ok) return mentioned;
    const targets = resolveTargets(toEntries, roster);
    if (!targets.ok) return targets;
    const self = this.self();
    const message: RoomMessage = {
      seq: null,
      clientMsgId: `cm_${this.randomId()}`,
      roomId: record.room.id,
      at: this.nowIso(),
      from: { node: self, ...(from.sessionKey ? { sessionKey: from.sessionKey } : {}), kind: from.kind },
      to: [...new Set([...mentioned.to, ...targets.to])],
      text,
    };
    const waiting = record.room.sessions.filter((session) => !sameNode(session.node, self) && isForSession(message, session.id)).length;
    if (this.isHost(record.room)) {
      const outcomes = new Map<string, Promise<PasteOutcome>>();
      const [stored] = await this.serial(record.room.id, () => this.hostAppend(record, [message], outcomes));
      const local = await (outcomes.get(message.clientMsgId) ?? Promise.resolve(EMPTY_OUTCOME));
      return {
        ok: true, messageId: message.clientMsgId, seq: stored!.seq, held: stored!.held === true,
        status: 'sequenced', delivery: deliveryOf(local, waiting),
      };
    }
    const localTargets = record.room.sessions.filter((session) => sameNode(session.node, self) && isForSession(message, session.id)).length;
    await this.serial(record.room.id, async () => {
      const outbox = [...this.outboxOf(record.room.id), message];
      this.outboxes.set(record.room.id, outbox);
      await this.deps.store.writeOutbox(record.room.id, outbox);
    });
    this.changed(record.room.id, 'message');
    const posted = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.post, { roomId: record.room.id, message });
    if (posted.ok === true) {
      // H-1: the host is there — this server's sessions get it from the host's numbered copy, held or not.
      this.hostReached(record);
      return {
        ok: true, messageId: message.clientMsgId, seq: typeof posted.seq === 'number' ? posted.seq : null,
        held: posted.held === true, status: 'sequenced', delivery: { pasted: 0, waiting: waiting + localTargets },
      };
    }
    this.hostMissed(record, posted);
    // FR-MSG-011 AC-1: host away — paste here now, unless the predicted agent run would be held (M-6).
    const pending = await this.serial(record.room.id, async () => {
      if (this.locallyHeld(record, message)) return EMPTY_OUTCOME;
      this.deliverLocally(record, [message]);
      return this.localPastes.get(message.clientMsgId) ?? EMPTY_OUTCOME;
    });
    const local = await pending;
    const settled = local.pasted.length + Object.keys(local.skipped).length;
    return {
      ok: true, messageId: message.clientMsgId, seq: null, held: false, status: 'waiting-host',
      delivery: deliveryOf(local, waiting + localTargets - settled),
    };
  }

  /** M-6: the hold the host would apply, predicted from its last count and this server's unsent messages. */
  private locallyHeld(record: RoomRecord, message: RoomMessage): boolean {
    if (message.from.kind !== 'agent') return false;
    let run = record.room.agentRun;
    for (const queued of this.outboxOf(record.room.id)) {
      if (queued.from.kind === 'human') run = 0;
      else if (queued.from.kind === 'agent') run += 1;
      if (queued.clientMsgId === message.clientMsgId) break;
    }
    return run > record.room.settings.holdLimit;
  }

  // ---------------------------------------------------------------------------------------------
  // Host side

  /** Numbers new messages (dedupe by clientMsgId), stores, pastes here and pushes to members. Run inside serial(). */
  private async hostAppend(
    record: RoomRecord, messages: RoomMessage[], outcomesOut?: Map<string, Promise<PasteOutcome>>,
  ): Promise<RoomMessage[]> {
    const log = this.logOf(record.room.id);
    const known = new Map(log.map((message) => [message.clientMsgId, message]));
    const wasHeld = record.room.held;
    const stored: RoomMessage[] = [];
    const fresh: RoomMessage[] = [];
    for (const message of messages) {
      const existing = known.get(message.clientMsgId);
      if (existing) {
        stored.push(existing);
        continue;
      }
      const next = sequenceMessage(record.room, message);
      record.room = next.room;
      known.set(next.message.clientMsgId, next.message);
      log.push(next.message);
      fresh.push(next.message);
      stored.push(next.message);
    }
    record.meta.mySeq = record.room.lastSeq;
    this.dropFromOutbox(record, fresh);
    if (fresh.length > 0) await this.deps.store.appendLog(record.room.id, fresh);
    const ledger = this.receiptsOf(record.room.id);
    for (const message of fresh) {
      if (message.from.kind === 'system' || message.seq === null) continue;
      const targets = record.room.sessions.filter((session) => isForSession(message, session.id)).length;
      ledger.set(message.seq, { targets, delivered: 0, pasted: 0, nodes: [], sessions: [] });
    }
    this.trimReceipts(ledger);
    this.deliverLocally(record, fresh);
    this.afterApply(record, fresh, wasHeld);
    this.pushDeliver(record, fresh);
    for (const message of fresh) {
      if (message.from.kind === 'system' || message.seq === null) continue;
      const seq = message.seq;
      outcomesOut?.set(message.clientMsgId, this.localPastes.get(message.clientMsgId) ?? Promise.resolve(EMPTY_OUTCOME));
      this.track(this.pastedInto(message.clientMsgId).then((outcome) => this.serial(record.room.id, async () => this.hostReceipt(record, this.self(), seq, outcome))));
    }
    this.changed(record.room.id, fresh.length > 0 ? 'message' : 'room');
    return stored;
  }

  private pushDeliver(record: RoomRecord, messages: RoomMessage[], extra: string[] = [], receipts?: Record<string, ReceiptEntry>): void {
    const self = this.self();
    const nodes = new Set([
      ...record.room.people.filter((person) => person.state === 'joined' && !sameNode(person.node, self)).map((person) => person.node),
      ...extra,
    ]);
    const room = record.room;
    for (const node of nodes) {
      if (!this.deps.transport.isConnected(node)) continue;
      this.track(this.deps.transport.call(node, ROOM_PEER.deliver, {
        roomId: room.id, room, messages: this.withReceipts(room.id, messages), ...(receipts ? { receipts } : {}),
      }));
    }
  }

  private hostAddInvitee(record: RoomRecord, invitee: string, invitedBy: string, message?: string):
    { ok: true; approval: boolean; messages: RoomMessage[] } | Fail {
    const existing = record.room.people.find((person) => sameNode(person.node, invitee));
    if (existing?.state === 'joined') return fail('ALREADY_MEMBER');
    if (existing) return { ok: true, approval: existing.state === 'approval', messages: [] };
    const now = this.nowIso();
    if (record.room.settings.invitePolicy === 'approve' && !sameNode(invitedBy, record.room.createdBy)) {
      record.room = { ...record.room, people: [...record.room.people, { node: invitee, invitedBy, joinedAt: now, state: 'approval' }] };
      const creatorIsHere = sameNode(record.room.createdBy, this.self());
      this.approvals.push({
        id: `apr_${this.randomId()}`, roomId: record.room.id, invitee, invitedBy, ...(message ? { message } : {}), at: now,
        ...(creatorIsHere ? {} : { notified: false }),
      });
      this.changed(record.room.id, 'approval');
      if (creatorIsHere) this.webhook(record.room.name, invitedBy, `${invitee} 님 참여 승인이 필요합니다`);
      else this.track(this.flushApprovals());
      return { ok: true, approval: true, messages: [] };
    }
    record.room = { ...record.room, people: [...record.room.people, { node: invitee, invitedBy, joinedAt: now, state: 'invited' }] };
    return { ok: true, approval: false, messages: [this.systemMessage(record.room.id, 'invited', invitedBy, invitee)] };
  }

  /** Changes asked by a member (or by this server for itself). */
  private async hostMemberOp(record: RoomRecord, from: string, args: Rec): Promise<Rec> {
    const op = asString(args.op);
    const isCreator = sameNode(record.room.createdBy, from);
    if (op === 'transfer') {
      if (!isCreator) return fail('NOT_CREATOR');
      return this.hostTransfer(record, asString(args.node) ?? '');
    }
    if (op === 'approve') {
      if (!isCreator) return fail('NOT_CREATOR');
      return this.hostDecide(record, asString(args.approvalId) ?? '', args.approve === true);
    }
    return this.serial(record.room.id, async () => {
      const roomId = record.room.id;
      switch (op) {
        case 'add-sessions': {
          if (parseSessionArgs(args.sessions).some((session) => hasInvalidNameChars(session.name))) return fail('NAME_INVALID_CHAR');
          const sessions = parseSessionArgs(args.sessions)
            .filter((session) => !record.room.sessions.some((existing) => existing.id === sessionMemberId(from, session.sessionKey)))
            .map((session) => ({ ...this.sessionEntry(from, session), enter: session.enter, pasteAll: session.pasteAll, agent: session.agent }));
          record.room = { ...record.room, sessions: [...record.room.sessions, ...sessions] };
          await this.hostAppend(record, sessions.map((session) => this.systemMessage(roomId, 'session-added', from, session.id)));
          return { ok: true, room: record.room };
        }
        case 'remove-session': {
          const sessionId = asString(args.sessionId) ?? '';
          const session = record.room.sessions.find((candidate) => candidate.id === sessionId);
          if (!session) return { ok: true, room: record.room };
          if (!sameNode(session.node, from) && !isCreator) return fail('NOT_CREATOR');
          record.room = { ...record.room, sessions: record.room.sessions.filter((candidate) => candidate !== session) };
          await this.hostAppend(record, [this.systemMessage(roomId, 'session-removed', from, sessionId)]);
          return { ok: true, room: record.room };
        }
        case 'update-session': {
          const id = sessionMemberId(from, asString(args.sessionKey) ?? '');
          record.room = {
            ...record.room,
            sessions: record.room.sessions.map((session) => session.id !== id ? session : {
              ...session,
              ...(typeof args.enter === 'boolean' ? { enter: args.enter } : {}),
              ...(typeof args.pasteAll === 'boolean' ? { pasteAll: args.pasteAll } : {}),
            }),
          };
          await this.hostAppend(record, []);
          return { ok: true, room: record.room };
        }
        case 'leave':
        case 'kick': {
          const node = op === 'leave' ? from : asString(args.node) ?? '';
          if (op === 'kick' && !isCreator) return fail('NOT_CREATOR');
          if (!record.room.people.some((person) => sameNode(person.node, node))) return { ok: true, room: record.room };
          record.room = {
            ...record.room,
            people: record.room.people.filter((person) => !sameNode(person.node, node)),
            sessions: record.room.sessions.filter((session) => !sameNode(session.node, node)),
          };
          this.deps.keys?.revokeRoomKey({ roomId, node });
          const event = op === 'leave' ? 'left' : 'removed';
          await this.hostAppend(record, [this.systemMessage(roomId, event, from, node)]);
          if (!sameNode(node, this.self())) this.pushDeliver(record, [], [node]);
          return { ok: true, room: record.room };
        }
        case 'settings': {
          if (!isCreator) return fail('NOT_CREATOR');
          const checked = checkSettings(args);
          if ('code' in checked) return checked;
          record.room = { ...record.room, settings: { ...record.room.settings, ...checked } };
          await this.hostAppend(record, []);
          return { ok: true, room: record.room };
        }
        case 'resume': {
          record.room = resumeRoom(record.room);
          await this.hostAppend(record, []);
          return { ok: true, room: record.room };
        }
        default:
          return fail('VALIDATION_ERROR', { fieldErrors: { op: 'unknown' } });
      }
    });
  }

  /** FR-MSG-012 AC-1: hand the log to `node` and make it the host. */
  private async hostTransfer(record: RoomRecord, node: string): Promise<Rec> {
    const self = this.self();
    if (sameNode(node, self)) return { ok: true };
    if (!record.room.people.some((person) => person.state === 'joined' && sameNode(person.node, node))) return fail('TARGET_NOT_FOUND', { name: node });
    if (!this.deps.transport.isConnected(node)) return fail('TARGET_OFFLINE', { name: node });
    await this.serial(record.room.id, () => this.hostAppend(record, [this.systemMessage(record.room.id, 'host-moved', self, node)]));
    const room = { ...record.room, hostNode: node };
    const adopted = await this.deps.transport.call(node, ROOM_PEER.adopt, { roomId: room.id, room, messages: this.logOf(room.id) });
    if (adopted.ok !== true) return fail(asString(adopted.code) ?? 'TRANSFER_FAILED');
    const tickets = asRecord(adopted.tickets) as Record<string, Ticket>;
    record.room = room;
    record.meta.movedTo = { host: node, tickets };
    record.meta.mySeq = room.lastSeq;
    const mine = tickets[self];
    if (mine && !this.deps.net?.isContact(node)) this.linkToHost(node, { urls: mine.urls, fp: mine.fp, token: mine.token });
    for (const person of room.people) {
      if (person.state !== 'joined' || sameNode(person.node, self) || sameNode(person.node, node)) continue;
      if (!this.deps.transport.isConnected(person.node)) continue;
      this.track(this.deps.transport.call(person.node, ROOM_PEER.hosted, { roomId: room.id, newHost: node, ...(tickets[person.node] ? { ticket: tickets[person.node] } : {}) }));
    }
    this.changed(room.id, 'room');
    return { ok: true };
  }

  /** FR-MSG-009 AC-3: the creator's answer to an approval, applied on the host. */
  private async hostDecide(record: RoomRecord, approvalId: string, approve: boolean): Promise<Rec> {
    const approval = this.approvals.find((candidate) => candidate.id === approvalId && candidate.roomId === record.room.id);
    if (!approval) return fail('APPROVAL_NOT_FOUND');
    this.approvals = this.approvals.filter((candidate) => candidate !== approval);
    const self = this.self();
    await this.serial(record.room.id, async () => {
      const person = record.room.people.find((candidate) => sameNode(candidate.node, approval.invitee) && candidate.state === 'approval');
      if (!person) return;
      if (!approve) {
        record.room = { ...record.room, people: record.room.people.filter((candidate) => candidate !== person) };
        await this.hostAppend(record, []);
        return;
      }
      record.room = {
        ...record.room,
        people: record.room.people.map((candidate) => candidate === person ? { ...candidate, state: 'invited' as const } : candidate),
      };
      const invited = this.systemMessage(record.room.id, 'invited', approval.invitedBy, approval.invitee);
      const direct = sameNode(approval.invitedBy, self) || this.deps.transport.isConnected(approval.invitee);
      record.meta.pendingInvites.push({
        invitee: approval.invitee, invitedBy: approval.invitedBy,
        ...(approval.message ? { message: approval.message } : {}),
        ...(direct ? this.ticketFor(record, approval.invitee) : { ...this.ticketForce(record, approval.invitee), via: approval.invitedBy }),
      });
      await this.hostAppend(record, [invited]);
    });
    this.track(this.flushInvites(record.room.id));
    return { ok: true };
  }

  /** Approval cards the host keeps for a creator on another server, sent when it is on. */
  private async flushApprovals(): Promise<void> {
    for (const approval of this.approvals.filter((candidate) => candidate.notified === false)) {
      const record = this.records.get(approval.roomId);
      if (!record || !this.isHost(record.room)) continue;
      const creator = record.room.createdBy;
      if (!this.deps.transport.isConnected(creator)) continue;
      const { notified: _notified, remote: _remote, ...card } = approval;
      const result = await this.deps.transport.call(creator, ROOM_PEER.approval, { roomId: approval.roomId, approval: card });
      if (OFFLINE_CODES.has(asString(result.code) ?? '')) continue;
      approval.notified = true;
      this.persist();
    }
  }

  /** Records that `node` got message `seq` and pasted it into `pasted`. Run inside serial() on the host. */
  private async hostReceipt(record: RoomRecord, node: string, seq: number, outcome: PasteOutcome): Promise<void> {
    const entry = this.receiptsOf(record.room.id).get(seq);
    if (!entry) return;
    const owned = (id: string) => {
      const split = id.indexOf('::');
      return split > 0 && sameNode(id.slice(0, split), node);
    };
    const nodes = new Set(entry.nodes ?? []);
    const sessions = new Set(entry.sessions ?? []);
    const skippedBy: Record<string, string> = { ...(entry.skippedBy ?? {}) };
    nodes.add(node.toLowerCase());
    for (const id of outcome.pasted.filter(owned)) {
      sessions.add(id);
      delete skippedBy[id];
    }
    for (const [id, reason] of Object.entries(outcome.skipped)) {
      if (owned(id) && !sessions.has(id)) skippedBy[id] = reason;
    }
    const reasons: Record<string, number> = {};
    for (const reason of Object.values(skippedBy)) reasons[reason] = (reasons[reason] ?? 0) + 1;
    Object.assign(entry, { nodes: [...nodes], sessions: [...sessions], delivered: nodes.size, pasted: sessions.size, skippedBy });
    const skipped = Object.keys(skippedBy).length;
    if (skipped > 0) Object.assign(entry, { skipped, skippedReasons: reasons });
    else { delete entry.skipped; delete entry.skippedReasons; }
    await this.saveReceipts(record.room.id);
    this.pushDeliver(record, [], [], { [String(seq)]: receiptView(entry) });
    this.changed(record.room.id, 'receipt');
  }

  // ---------------------------------------------------------------------------------------------
  // Member side

  /** Applies host messages in sequence order. Answers true when a gap means a sync is needed. Run inside serial(). */
  private async applyFromHost(record: RoomRecord, room: Room, messages: RoomMessage[]): Promise<boolean> {
    const wasHeld = record.room.held;
    if (room && typeof room.id === 'string' && room.id === record.room.id) record.room = room;
    const log = this.logOf(record.room.id);
    const applied: RoomMessage[] = [];
    let gap = false;
    for (const message of [...messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      if (message.seq === null || message.seq <= record.meta.mySeq) continue;
      if (message.seq !== record.meta.mySeq + 1) {
        gap = true;
        break;
      }
      const clean = stripReceipts(message);
      log.push(clean);
      applied.push(clean);
      record.meta.mySeq = message.seq;
    }
    if (applied.length > 0) await this.deps.store.appendLog(record.room.id, applied);
    if (this.dropFromOutbox(record, applied)) await this.deps.store.writeOutbox(record.room.id, this.outboxOf(record.room.id));
    this.deliverLocally(record, applied);
    this.afterApply(record, applied, wasHeld);
    for (const message of applied) {
      if (message.from.kind === 'system' || message.seq === null) continue;
      const seq = message.seq;
      this.track(this.pastedInto(message.clientMsgId).then((outcome) => this.sendReceipt(record, {
        seq, pasted: outcome.pasted, skipped: Object.keys(outcome.skipped), skippedReasons: outcome.skipped,
      })));
    }
    const self = this.self();
    if (!record.room.people.some((person) => sameNode(person.node, self))) this.markLeft(record);
    this.changed(record.room.id, applied.length > 0 ? 'message' : 'room');
    return gap;
  }

  /** FR-MSG-002 AC-4: tells the host; kept for the next sync when the host is off. */
  private async sendReceipt(record: RoomRecord, receipt: { seq: number; pasted: string[]; skipped: string[]; skippedReasons?: Record<string, string> }): Promise<void> {
    const result = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.receipt, { roomId: record.room.id, delivered: true, ...receipt });
    if (result.ok === true || !OFFLINE_CODES.has(asString(result.code) ?? '')) return;
    record.meta.pendingReceipts = [...(record.meta.pendingReceipts ?? []).filter((pending) => pending.seq !== receipt.seq), receipt].slice(-RECEIPTS_KEEP);
    this.persist();
  }

  private async flushReceipts(record: RoomRecord): Promise<void> {
    const pending = record.meta.pendingReceipts ?? [];
    if (pending.length === 0) return;
    record.meta.pendingReceipts = [];
    for (const receipt of pending) await this.sendReceipt(record, receipt);
    this.persist();
  }

  private async syncRoom(roomId: string): Promise<void> {
    for (let page = 0; page < 20; page += 1) {
      const record = this.records.get(roomId);
      if (!record || record.meta.left || this.isHost(record.room)) return;
      const self = this.self();
      const local = new Map(this.deps.sessions.list().map((session) => [session.sessionKey, session]));
      const sessions = record.room.sessions.filter((session) => sameNode(session.node, self) && local.has(session.sessionKey))
        .map((session) => ({ sessionKey: session.sessionKey, name: local.get(session.sessionKey)!.name, agent: local.get(session.sessionKey)!.agent }));
      const result = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.sync, {
        roomId, afterSeq: record.meta.mySeq, outbox: this.outboxOf(roomId), sessions,
      });
      if (result.ok !== true) {
        if (result.code === 'NOT_HOST' && typeof result.newHost === 'string') {
          this.repoint(record, result.newHost, asRecord(result.ticket));
          continue;
        }
        if (result.code === 'NOT_IN_ROOM') this.markLeft(record);
        else this.hostMissed(record, result);
        return;
      }
      this.hostReached(record);
      await this.flushReceipts(record);
      const messages = Array.isArray(result.messages) ? result.messages.filter(isMessage) : [];
      await this.serial(roomId, async () => {
        await this.applyFromHost(record, asRecord(result.room) as unknown as Room, messages);
        await this.mergeReceipts(roomId, [asRecord(result.receipts)]);
      });
      if (messages.length < SYNC_PAGE) return;
    }
  }

  private async join(invite: Invite, choice: { sessions: string[]; personOnly: boolean; enter?: boolean }): Promise<Rec> {
    const sessions = this.localSessions(choice.sessions);
    if ('code' in sessions) return sessions;
    const result = await this.deps.transport.call(invite.room.hostNode, ROOM_PEER.join, {
      roomId: invite.room.id,
      personOnly: choice.personOnly,
      sessions: sessions.map((session) => ({ sessionKey: session.sessionKey, name: session.name, agent: session.agent, enter: choice.enter !== false, pasteAll: false })),
    });
    if (result.ok !== true) {
      if (OFFLINE_CODES.has(asString(result.code) ?? '')) {
        invite.accepting = choice;
        this.persist();
        this.changed(undefined, 'invite');
        return { ok: true, pending: true, room: invite.room };
      }
      return fail(asString(result.code) ?? 'JOIN_FAILED');
    }
    const room = asRecord(result.room) as unknown as Room;
    const recent = Array.isArray(result.messages) ? result.messages.filter(isMessage) : [];
    const { messages, receipts } = await this.fetchHistory(invite.room.hostNode, room.id, recent);
    const lastSeq = Math.max(room.lastSeq, ...messages.map((message) => message.seq ?? 0));
    const record: RoomRecord = { room, meta: { ...emptyMeta(), mySeq: lastSeq, readSeq: lastSeq, pasted: messages.map((m) => m.clientMsgId) } };
    this.records.set(room.id, record);
    this.outboxes.set(room.id, []);
    await this.deps.store.writeLog(room.id, messages.map(stripReceipts));
    this.logs.set(room.id, messages.map(stripReceipts));
    await this.mergeReceipts(room.id, [receiptsFromMessages(messages), receipts]);
    this.invites = this.invites.filter((candidate) => candidate.id !== invite.id);
    this.deliverLocally(record, []);
    this.changed(room.id, 'room');
    return { ok: true, room: this.summary(record) };
  }

  /** M-5 (FR-MSG-010 AC-3): the whole log, paged from the start; the join answer's last 200 if paging fails. */
  private async fetchHistory(host: string, roomId: string, recent: RoomMessage[]): Promise<{ messages: RoomMessage[]; receipts: Rec }> {
    const bySeq = new Map<number, RoomMessage>();
    let receipts: Rec = {};
    let after = 0;
    for (let page = 0; page < 10_000; page += 1) {
      const result = await this.deps.transport.call(host, ROOM_PEER.sync, { roomId, afterSeq: after, outbox: [], sessions: [] });
      if (result.ok !== true) break;
      const messages = Array.isArray(result.messages) ? result.messages.filter(isMessage) : [];
      receipts = { ...receipts, ...asRecord(result.receipts) };
      for (const message of messages) if (message.seq !== null) bySeq.set(message.seq, message);
      if (messages.length < SYNC_PAGE) break;
      after = messages.at(-1)!.seq ?? after;
    }
    for (const message of recent) if (message.seq !== null && !bySeq.has(message.seq)) bySeq.set(message.seq, message);
    return { messages: [...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), receipts };
  }

  /** M-3: tells the host about a decline once a link to it exists; then the invitation is gone. */
  private async flushDecline(invite: Invite): Promise<void> {
    if (!this.deps.transport.isConnected(invite.room.hostNode)) {
      this.persist();
      return;
    }
    const result = await this.deps.transport.call(invite.room.hostNode, ROOM_PEER.decline, { roomId: invite.room.id });
    if (OFFLINE_CODES.has(asString(result.code) ?? '')) return;
    this.invites = this.invites.filter((candidate) => candidate !== invite);
    this.persist();
  }

  private async flushInvites(roomId: string): Promise<void> {
    const record = this.records.get(roomId);
    if (!record) return;
    for (const pending of [...record.meta.pendingInvites]) {
      if (pending.needsTicket) {
        if (!this.deps.transport.isConnected(record.room.hostNode)) continue;
        const ticket = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.ticket, {
          roomId, invitee: pending.invitee, ...(pending.message ? { message: pending.message } : {}),
        });
        if (OFFLINE_CODES.has(asString(ticket.code) ?? '')) continue;
        if (ticket.ok !== true) {
          if (ticket.code !== 'APPROVAL_PENDING') this.log({ event: 'messenger.invite.failed', roomId, invitee: pending.invitee, code: ticket.code });
          record.meta.pendingInvites = record.meta.pendingInvites.filter((candidate) => candidate !== pending);
          this.changed(roomId, 'invite');
          continue;
        }
        pending.ticket = ticket.ticket as Ticket;
        delete pending.needsTicket;
        this.changed(roomId, 'invite');
      }
      const target = pending.via ?? pending.invitee;
      if (!this.deps.transport.isConnected(target)) continue;
      const result = pending.via
        ? await this.deps.transport.call(target, ROOM_PEER.forwardInvite, {
          roomId, invitee: pending.invitee, ...(pending.ticket ? { ticket: pending.ticket } : {}), ...(pending.message ? { message: pending.message } : {}),
        })
        : await this.deps.transport.call(target, ROOM_PEER.invite, {
          roomId, room: record.room, ...(pending.ticket ? { ticket: pending.ticket } : {}), ...(pending.message ? { message: pending.message } : {}),
        });
      if (OFFLINE_CODES.has(asString(result.code) ?? '')) continue;
      if (result.ok !== true) this.log({ event: 'messenger.invite.failed', roomId, invitee: pending.invitee, code: result.code });
      record.meta.pendingInvites = record.meta.pendingInvites.filter((candidate) => candidate !== pending);
      this.persist();
    }
  }

  /** FR-MSG-001 AC-5: closed sessions leave; renamed ones follow (the host renames on sync). */
  private async reconcileSessions(record: RoomRecord): Promise<void> {
    const self = this.self();
    const live = new Map(this.deps.sessions.list().map((session) => [session.sessionKey, session]));
    for (const session of record.room.sessions.filter((candidate) => sameNode(candidate.node, self))) {
      const now = live.get(session.sessionKey);
      if (!now) {
        await this.memberOp(record, { op: 'remove-session', sessionId: session.id });
      } else if (this.isHost(record.room) && ((now.name !== session.name && !hasInvalidNameChars(now.name)) || !sameAgent(now.agent, session.agent))) {
        await this.serial(record.room.id, async () => {
          record.room = {
            ...record.room,
            sessions: record.room.sessions.map((candidate) => candidate.id === session.id
              ? { ...candidate, name: hasInvalidNameChars(now.name) ? candidate.name : now.name, agent: now.agent }
              : candidate),
          };
          await this.hostAppend(record, []);
        });
      }
    }
  }

  /** Runs a member operation on the host: here when this server hosts the room, else over the link. */
  private async memberOp(record: RoomRecord, args: Rec): Promise<Rec> {
    if (this.isHost(record.room)) {
      const result = await this.hostMemberOp(record, this.self(), { ...args, roomId: record.room.id });
      return result.ok === false ? result : { ok: true };
    }
    const result = await this.deps.transport.call(record.room.hostNode, ROOM_PEER.member, { ...args, roomId: record.room.id });
    if (result.ok !== true) return this.hostFailure(record, result);
    this.hostReached(record);
    if (result.room) {
      await this.serial(record.room.id, async () => {
        const room = asRecord(result.room) as unknown as Room;
        if (room.lastSeq > record.meta.mySeq) {
          this.track(this.syncRoom(record.room.id));
          return;
        }
        await this.applyFromHost(record, room, []);
      });
    }
    return { ok: true };
  }

  private repoint(record: RoomRecord, newHost: string, ticket: Rec): void {
    const old = record.room.hostNode;
    if (asString(ticket.token) && !this.deps.net?.isContact(newHost)) {
      this.linkToHost(newHost, { urls: strings(ticket.urls), fp: asString(ticket.fp) ?? '', token: asString(ticket.token)! });
    }
    record.room = { ...record.room, hostNode: newHost };
    record.meta.hostOfflineSince = undefined;
    this.dropLinkIfUnused(old);
    this.changed(record.room.id, 'room');
  }

  /** After a host move: link to the new host; a refused ticket is logged (sync keeps failing visibly). */
  private linkToHost(hostNode: string, ticket: { urls: string[]; fp: string; token: string }): void {
    this.track(Promise.resolve(this.deps.net?.ensureRoomLink({ hostNode, ...ticket })).then((result) => {
      const linked = asRecord(result);
      if (linked.ok === false) this.log({ event: 'messenger.room-link.failed', hostNode, code: linked.code });
    }));
  }

  private markLeft(record: RoomRecord): void {
    if (record.meta.left) return;
    record.meta.left = true;
    this.dropLinkIfUnused(record.room.hostNode);
    this.changed(record.room.id, 'room');
  }

  private dropLinkIfUnused(host: string): void {
    if (sameNode(host, this.self()) || this.deps.net?.isContact(host)) return;
    const used = [...this.records.values()].some((record) => !record.meta.left && sameNode(record.room.hostNode, host));
    if (!used) this.deps.net?.dropRoomLink(host);
  }

  // ---------------------------------------------------------------------------------------------
  // Local delivery, webhook, bookkeeping

  /** Contract §6. Marks the covered messages as pasted and queues the pastes per session. */
  private deliverLocally(record: RoomRecord, messages: RoomMessage[]): PasteJob[] {
    const self = this.self();
    // Security: only a session where an AI agent runs gets room text; in a shell it would run as a command.
    const agents = new Set(this.deps.sessions.list().filter((session) => session.agent !== null).map((session) => session.sessionKey));
    const canPaste = (sessionKey: string) => agents.has(sessionKey);
    this.greet(record, canPaste);
    if (messages.length === 0) return [];
    const alreadyPasted = new Set(record.meta.pasted);
    const jobs = planDelivery({ room: record.room, messages, selfNode: self, pasted: alreadyPasted, now: this.now(), canPaste });
    const covered = new Set(jobs.flatMap((job) => job.clientMsgIds));
    record.meta.pasted = [...record.meta.pasted, ...messages.map((m) => m.clientMsgId).filter((id) => covered.has(id))].slice(-PASTED_KEEP);
    const outcomes = new Map<string, Array<Promise<PasteOutcome>>>();
    const add = (id: string, outcome: Promise<PasteOutcome>) => outcomes.set(id, [...(outcomes.get(id) ?? []), outcome]);
    for (const job of jobs) {
      const sessionId = sessionMemberId(self, job.sessionKey);
      const done = this.enqueuePaste(job.sessionKey, job.text, job.submit)
        .then((reason): PasteOutcome => (reason === null ? { pasted: [sessionId], skipped: {} } : { pasted: [], skipped: { [sessionId]: reason } }));
      for (const id of job.clientMsgIds) add(id, done);
    }
    for (const message of messages) {
      if (alreadyPasted.has(message.clientMsgId)) continue;
      for (const session of record.room.sessions) {
        if (!sameNode(session.node, self) || canPaste(session.sessionKey) || !isForSession(message, session.id)) continue;
        add(message.clientMsgId, Promise.resolve({ pasted: [], skipped: { [session.id]: 'NO_AGENT' } }));
      }
    }
    for (const [id, list] of outcomes) {
      const before = this.localPastes.get(id) ?? Promise.resolve({ pasted: [], skipped: {} });
      this.localPastes.set(id, Promise.all([before, ...list]).then(mergeOutcomes));
    }
    return jobs;
  }

  /** FR-MSG-004 AC-4: once per session that joins — when an agent runs there (else when one first does). */
  private greet(record: RoomRecord, canPaste: (sessionKey: string) => boolean): void {
    const self = this.self();
    const mine = record.room.sessions.filter((session) => sameNode(session.node, self));
    const greeted = record.meta.greeted.filter((key) => mine.some((session) => session.sessionKey === key));
    for (const session of mine) {
      if (greeted.includes(session.sessionKey) || !canPaste(session.sessionKey)) continue;
      greeted.push(session.sessionKey);
      this.enqueuePaste(session.sessionKey, entranceNotice(record.room, self), session.enter);
    }
    record.meta.greeted = greeted;
  }

  /** Answers null when written, else why not (MULTILINE_UNSUPPORTED, PASTE_FAILED). */
  private enqueuePaste(sessionKey: string, text: string, submit: boolean): Promise<string | null> {
    const previous = this.pasteChains.get(sessionKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      const result = await this.deps.paster.paste(sessionKey, text, submit).catch(() => false as const);
      if (result === true) return null;
      const reason = typeof result === 'object' && result.code === 'PASTE_MULTILINE_UNSUPPORTED' ? 'MULTILINE_UNSUPPORTED' : 'PASTE_FAILED';
      this.log({ event: 'messenger.paste.failed', sessionKey, reason });
      return reason;
    });
    this.pasteChains.set(sessionKey, next);
    this.track(next);
    return next;
  }

  /** What this server pasted the message into and skipped; cleared once read. */
  private async pastedInto(clientMsgId: string): Promise<PasteOutcome> {
    const outcome = await (this.localPastes.get(clientMsgId) ?? Promise.resolve({ pasted: [], skipped: {} }));
    this.localPastes.delete(clientMsgId);
    return outcome;
  }

  private receiptsOf(roomId: string): Map<number, ReceiptEntry> {
    let map = this.receipts.get(roomId);
    if (!map) {
      map = new Map();
      this.receipts.set(roomId, map);
    }
    return map;
  }

  private trimReceipts(map: Map<number, ReceiptEntry>): void {
    if (map.size <= RECEIPTS_KEEP) return;
    for (const seq of [...map.keys()].sort((a, b) => a - b).slice(0, map.size - RECEIPTS_KEEP)) map.delete(seq);
  }

  private receiptViews(roomId: string): Record<string, ReceiptEntry> {
    const out: Record<string, ReceiptEntry> = {};
    for (const [seq, entry] of this.receiptsOf(roomId)) out[String(seq)] = receiptView(entry);
    return out;
  }

  private withReceipts(roomId: string, messages: RoomMessage[]): RoomMessage[] {
    const map = this.receiptsOf(roomId);
    return messages.map((message) => {
      const entry = message.seq === null ? undefined : map.get(message.seq);
      return entry ? { ...message, receipts: receiptView(entry) } : message;
    });
  }

  /** On a member: the host's receipt counts (the host keeps who acked). */
  private async mergeReceipts(roomId: string, sources: Rec[]): Promise<void> {
    const map = this.receiptsOf(roomId);
    let changed = false;
    for (const source of sources) {
      for (const [key, value] of Object.entries(source)) {
        const entry = asRecord(value);
        const seq = Number(key);
        if (!Number.isInteger(seq) || typeof entry.targets !== 'number' || typeof entry.delivered !== 'number' || typeof entry.pasted !== 'number') continue;
        map.set(seq, receiptView(entry as unknown as ReceiptEntry));
        changed = true;
      }
    }
    if (!changed) return;
    this.trimReceipts(map);
    await this.saveReceipts(roomId);
    this.changed(roomId, 'receipt');
  }

  private async saveReceipts(roomId: string): Promise<void> {
    const out: Record<string, ReceiptEntry> = {};
    for (const [seq, entry] of this.receiptsOf(roomId)) out[String(seq)] = entry;
    await this.deps.store.writeReceipts(roomId, out);
  }

  /** Webhooks for messages naming me, and the room becoming held (FR-MSG-015). */
  private afterApply(record: RoomRecord, applied: RoomMessage[], wasHeld: boolean): void {
    const self = this.self();
    const mySessions = new Set(record.room.sessions.filter((session) => sameNode(session.node, self)).map((session) => session.id));
    for (const message of applied) {
      if (sameNode(message.from.node, self) || message.from.kind === 'system') continue;
      if (message.to.some((id) => sameNode(id, self) || mySessions.has(id))) {
        this.webhook(record.room.name, senderLabel(record.room, message, self), message.text);
      }
    }
    if (!wasHeld && record.room.held) this.webhook(record.room.name, '시스템', '에이전트 메시지가 이어져 붙여넣기를 멈췄습니다');
  }

  private webhook(room: string, sender: string, text: string): void {
    const url = this.settings.webhookUrl;
    if (!url || !this.deps.webhook) return;
    const body = `[BuilderGate 메신저] ${room}: ${sender} — ${text.slice(0, 200)}`;
    this.track(Promise.resolve(this.deps.webhook(url, body)).catch(() => undefined));
  }

  private dropFromOutbox(record: RoomRecord, messages: RoomMessage[]): boolean {
    if (messages.length === 0) return false;
    const ids = new Set(messages.map((message) => message.clientMsgId));
    const outbox = this.outboxOf(record.room.id);
    const kept = outbox.filter((message) => !ids.has(message.clientMsgId));
    if (kept.length === outbox.length) return false;
    this.outboxes.set(record.room.id, kept);
    if (this.isHost(record.room)) this.track(this.deps.store.writeOutbox(record.room.id, kept));
    return true;
  }

  private hostReached(record: RoomRecord): void {
    if (!record.meta.hostOfflineSince) return;
    record.meta.hostOfflineSince = undefined;
    this.changed(record.room.id, 'host');
  }

  private hostMissed(record: RoomRecord, result: Rec): void {
    if (!OFFLINE_CODES.has(asString(result.code) ?? '') || record.meta.hostOfflineSince) return;
    record.meta.hostOfflineSince = this.nowIso();
    this.changed(record.room.id, 'host');
  }

  private hostFailure(record: RoomRecord, result: Rec): Fail {
    if (OFFLINE_CODES.has(asString(result.code) ?? '')) {
      this.hostMissed(record, result);
      return fail('HOST_OFFLINE');
    }
    return { ...result, ok: false, code: asString(result.code) ?? 'HOST_ERROR' };
  }

  private makeTicket(record: RoomRecord, invitee: string): Ticket | Fail {
    if (!this.deps.keys || !this.deps.net) return fail('MESSENGER_KEYS_UNAVAILABLE');
    const info = this.deps.net.connectInfo();
    if (info.urls.length === 0) return fail('LAN_OFF');
    const issued = this.deps.keys.issueRoomTicket({ roomId: record.room.id, invitee });
    return { roomId: record.room.id, roomName: record.room.name, hostNode: this.self(), urls: info.urls, fp: info.fp, token: issued.token };
  }

  /** A ticket for a non-contact (or {} for a contact). Run on the host. */
  private ticketFor(record: RoomRecord, invitee: string): { ticket?: Ticket } {
    return this.deps.net?.isContact(invitee) === false ? this.ticketForce(record, invitee) : {};
  }

  private ticketForce(record: RoomRecord, invitee: string): { ticket?: Ticket } {
    const ticket = this.makeTicket(record, invitee);
    return 'code' in ticket ? {} : { ticket };
  }

  private summary(record: RoomRecord): RoomSummary {
    const self = this.self();
    const log = this.logOf(record.room.id);
    const last = [...log].reverse().find((message) => message.from.kind !== 'system');
    const mine = new Set(record.room.sessions.filter((session) => sameNode(session.node, self)).map((session) => session.id));
    let unread = 0;
    let mention = 0;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const message = log[i]!;
      if ((message.seq ?? 0) <= record.meta.readSeq) break;
      if (message.from.kind === 'system' || sameNode(message.from.node, self)) continue;
      unread += 1;
      if (message.to.some((id) => sameNode(id, self) || mine.has(id))) mention += 1;
    }
    return {
      id: record.room.id,
      name: record.room.name,
      hostNode: record.room.hostNode,
      isHost: this.isHost(record.room),
      hostOnline: this.hostOnline(record.room),
      lastAt: last?.at ?? record.room.createdAt,
      lastText: last?.text.slice(0, 200) ?? '',
      lastFrom: last ? senderLabel(record.room, last, self) : '',
      lastSeq: this.lastAppliedSeq(record),
      unread,
      mention,
      held: record.room.held,
      invitedPending: invitedPending(record.room),
      invitesWaitingHost: record.meta.pendingInvites.filter((pending) => pending.needsTicket).map((pending) => pending.invitee),
    };
  }

  private roomForSession(sessionKey: string, ref: string): RoomRecord | Fail {
    const id = sessionMemberId(this.self(), sessionKey);
    const candidates = this.visibleRecords().filter((record) => record.room.id === ref || record.room.name === ref);
    if (candidates.length === 0) return fail('ROOM_NOT_FOUND', { room: ref });
    const mine = candidates.filter((record) => record.room.sessions.some((session) => session.id === id));
    if (mine.length === 0) return fail('NOT_IN_ROOM', { room: ref });
    if (mine.length > 1) return fail('AMBIGUOUS_ROOM', { room: ref, candidates: mine.map((record) => record.room.id) });
    return mine[0]!;
  }

  private roster(room: Room): MentionRoster {
    return {
      selfNode: this.self(),
      people: room.people.filter((person) => person.state === 'joined').map((person) => person.node),
      sessions: room.sessions,
    };
  }

  private localSessions(keys: string[]): LocalSession[] | Fail {
    const live = new Map(this.deps.sessions.list().map((session) => [session.sessionKey, session]));
    const missing = keys.filter((key) => !live.has(key));
    if (missing.length > 0) return fail('SESSION_NOT_FOUND', { sessions: missing });
    const sessions = [...new Set(keys)].map((key) => live.get(key)!);
    const badNames = sessions.filter((session) => hasInvalidNameChars(session.name)).map((session) => session.sessionKey);
    if (badNames.length > 0) return fail('NAME_INVALID_CHAR', { sessions: badNames });
    return sessions;
  }

  private sessionEntry(node: string, session: { sessionKey: string; name: string; agent?: SessionAgent | null }): RoomSession {
    return {
      id: sessionMemberId(node, session.sessionKey), node, sessionKey: session.sessionKey, name: session.name,
      enter: true, pasteAll: false, agent: session.agent ?? null,
    };
  }

  /** room.sessions with `agent`: live for this server's sessions, as last reported for the others. */
  private sessionsWithAgents(room: Room): RoomSession[] {
    const self = this.self();
    const live = new Map(this.deps.sessions.list().map((session) => [session.sessionKey, session.agent]));
    return room.sessions.map((session) => ({
      ...session,
      agent: sameNode(session.node, self) ? live.get(session.sessionKey) ?? null : session.agent ?? null,
    }));
  }

  private systemMessage(roomId: string, event: SystemEvent, actor?: string, subject?: string): RoomMessage {
    return {
      seq: null, clientMsgId: `cm_${this.randomId()}`, roomId, at: this.nowIso(),
      from: { node: this.self(), kind: 'system' }, to: [], text: '',
      system: { event, ...(actor ? { actor } : {}), ...(subject ? { subject } : {}) },
    };
  }

  /** A message from a member: the sender is the authenticated node (FR-MSG-004 AC-5). */
  private fromPeer(from: string, roomId: string, value: unknown): RoomMessage | undefined {
    const message = asRecord(value);
    const sender = asRecord(message.from);
    const kind = sender.kind === 'agent' ? 'agent' : sender.kind === 'human' ? 'human' : undefined;
    const clientMsgId = asString(message.clientMsgId);
    const text = asString(message.text);
    if (!kind || !clientMsgId || text === undefined || text.length > TEXT_MAX) return undefined;
    const clean = stripControls(text);
    const sessionKey = kind === 'agent' ? asString(sender.sessionKey) : undefined;
    return {
      seq: null, clientMsgId, roomId, at: asString(message.at) ?? this.nowIso(),
      from: { node: from, ...(sessionKey ? { sessionKey } : {}), kind },
      to: strings(message.to), text: clean,
    };
  }

  private hosted(roomId: string | undefined): RoomRecord | Fail {
    const record = roomId ? this.records.get(roomId) : undefined;
    if (!record) return fail('ROOM_NOT_FOUND');
    if (!this.isHost(record.room)) return fail('NOT_HOST', { newHost: record.room.hostNode });
    return record;
  }

  private hostedFor(roomId: string | undefined, from: string): RoomRecord | Fail {
    const record = this.hosted(roomId);
    if ('code' in record) return record;
    const person = record.room.people.find((candidate) => sameNode(candidate.node, from));
    return person?.state === 'joined' ? record : fail('NOT_IN_ROOM');
  }

  private async waitFor(node: string): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; waited < JOIN_WAIT_MS && !this.deps.transport.isConnected(node); waited += JOIN_WAIT_STEP_MS) {
      await sleep(JOIN_WAIT_STEP_MS);
    }
  }

  private changed(roomId: string | undefined, reason: string): void {
    this.persist();
    this.deps.notify(roomId ? { roomId, reason } : { reason });
  }

  private persist(): void {
    const snapshot = () => ({
      rooms: [...this.records.values()].map((record) => ({ room: record.room, meta: record.meta })),
      invites: this.invites,
      approvals: this.approvals,
    });
    this.saving = this.saving.then(() => this.deps.store.saveState(JSON.parse(JSON.stringify(snapshot()))))
      .catch((error: unknown) => this.log({ event: 'messenger.save.failed', message: error instanceof Error ? error.message : String(error) }));
    this.track(this.saving);
  }

  private serial<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(roomId) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    this.chains.set(roomId, settled);
    this.track(settled);
    return next;
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error: unknown) => this.log({ event: 'messenger.background.failed', message: error instanceof Error ? error.message : String(error) }));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private log(event: Rec): void {
    (this.deps.log ?? ((entry: Rec) => console.warn('[Messenger]', JSON.stringify(entry))))(event);
  }

  private self(): string {
    return this.deps.transport.nodeName();
  }

  private isHost(room: Room): boolean {
    return sameNode(room.hostNode, this.self());
  }

  private hostOnline(room: Room): boolean {
    return this.isHost(room) || this.deps.transport.isConnected(room.hostNode);
  }

  private visible(roomId: string): RoomRecord | undefined {
    const record = this.records.get(roomId);
    return record && !record.meta.left ? record : undefined;
  }

  private visibleRecords(): RoomRecord[] {
    return [...this.records.values()].filter((record) => !record.meta.left);
  }

  private logOf(roomId: string): RoomMessage[] {
    let log = this.logs.get(roomId);
    if (!log) {
      log = [];
      this.logs.set(roomId, log);
    }
    return log;
  }

  private outboxOf(roomId: string): RoomMessage[] {
    return this.outboxes.get(roomId) ?? [];
  }

  private lastAppliedSeq(record: RoomRecord): number {
    return this.isHost(record.room) ? record.room.lastSeq : record.meta.mySeq;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private randomId(): string {
    return this.deps.randomId?.() ?? base32(randomBytes(16), 16);
  }

  private newRoomId(): string {
    return `rm_${base32(createHash('sha256').update(`${this.randomId()}:${this.records.size}`).digest(), 16)}`;
  }
}

export function createRoomService(deps: RoomServiceDeps): RoomService {
  return new RoomService(deps);
}

function emptyMeta(): RoomMeta {
  return { readSeq: 0, mySeq: 0, pasted: [], greeted: [], pendingInvites: [] as PendingInvite[] };
}

function invitedPending(room: Room): string[] {
  return room.people.filter((person) => person.state !== 'joined').map((person) => person.node);
}

function isMessage(value: unknown): value is RoomMessage {
  const message = asRecord(value);
  return typeof message.clientMsgId === 'string' && typeof message.text === 'string'
    && (message.seq === null || typeof message.seq === 'number') && Array.isArray(message.to) && typeof asRecord(message.from).node === 'string';
}

const EMPTY_OUTCOME: PasteOutcome = Object.freeze({ pasted: [], skipped: {} }) as PasteOutcome;

function deliveryOf(local: PasteOutcome, waiting: number): SendResult['delivery'] {
  const reasons: Record<string, number> = {};
  for (const reason of Object.values(local.skipped)) reasons[reason] = (reasons[reason] ?? 0) + 1;
  const skipped = Object.keys(local.skipped).length;
  return { pasted: local.pasted.length, waiting, ...(skipped > 0 ? { skipped, skippedReasons: reasons } : {}) };
}

function receiptView(entry: ReceiptEntry): ReceiptEntry {
  return {
    targets: entry.targets, delivered: entry.delivered, pasted: entry.pasted,
    ...(typeof entry.skipped === 'number' && entry.skipped > 0 ? { skipped: entry.skipped, skippedReasons: { ...(entry.skippedReasons ?? {}) } } : {}),
  };
}

function mergeOutcomes(outcomes: PasteOutcome[]): PasteOutcome {
  const pasted = new Set<string>();
  const skipped: Record<string, string> = {};
  for (const outcome of outcomes) {
    for (const id of outcome.pasted) pasted.add(id);
    Object.assign(skipped, outcome.skipped);
  }
  for (const id of pasted) delete skipped[id];
  return { pasted: [...pasted], skipped };
}

function sameAgent(a: SessionAgent | null | undefined, b: SessionAgent | null | undefined): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.kind === b.kind && a.status === b.status);
}

function parseAgent(value: unknown): SessionAgent | null {
  const agent = asRecord(value);
  return typeof agent.kind === 'string' && agent.kind ? { kind: agent.kind, status: asString(agent.status) ?? 'unknown' } : null;
}

function stripReceipts(message: RoomMessage): RoomMessage {
  const { receipts: _receipts, ...rest } = message;
  return rest;
}

function receiptsFromMessages(messages: RoomMessage[]): Rec {
  const out: Rec = {};
  for (const message of messages) if (message.receipts && message.seq !== null) out[String(message.seq)] = message.receipts;
  return out;
}

function parseSessionArgs(value: unknown): Array<{ sessionKey: string; name: string; enter: boolean; pasteAll: boolean; agent: SessionAgent | null }> {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item) => typeof item.sessionKey === 'string' && item.sessionKey !== '').map((item) => ({
    sessionKey: item.sessionKey as string,
    name: asString(item.name) ?? (item.sessionKey as string),
    enter: item.enter !== false,
    pasteAll: item.pasteAll === true,
    agent: parseAgent(item.agent),
  }));
}

function checkSettings(patch: Rec): { invitePolicy?: 'auto' | 'approve'; holdLimit?: number } | Fail {
  const out: { invitePolicy?: 'auto' | 'approve'; holdLimit?: number } = {};
  if (patch.invitePolicy !== undefined) {
    if (patch.invitePolicy !== 'auto' && patch.invitePolicy !== 'approve') return fail('VALIDATION_ERROR', { fieldErrors: { invitePolicy: 'auto or approve' } });
    out.invitePolicy = patch.invitePolicy;
  }
  if (patch.holdLimit !== undefined) {
    const limit = patch.holdLimit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HOLD_LIMIT_MAX) {
      return fail('VALIDATION_ERROR', { fieldErrors: { holdLimit: `1 to ${HOLD_LIMIT_MAX}` } });
    }
    out.holdLimit = limit;
  }
  return out;
}
