// Pure rules behind the messenger window: folding, delivery labels, badges,
// layout, sender colours, name rules. Kept free of React and of t() so that a
// test can read every decision as a value.
// @req FR-MSG-001 FR-MSG-002 FR-MSG-005 FR-MSG-008 FR-MSG-013

import type { MessageKey } from '../../i18n/i18n.ts';
import type { Contact, MessageFrom, Receipts, RoomMessage, RoomSession, RoomSummary } from './messengerTypes.ts';

// ---------------------------------------------------------------- folding

/** A run of at least this many agent messages folds (FR-MSG-002 AC-5, mockup ⑥). */
export const FOLD_MIN_RUN = 5;
/** The newest messages of a folded run stay open. */
export const FOLD_KEEP_OPEN = 2;

export type LogItem =
  | { kind: 'message'; message: RoomMessage }
  | { kind: 'fold'; key: string; count: number; firstAt: string; lastAt: string };

const isAgent = (message: RoomMessage) => message.from.kind === 'agent' && message.system === undefined;

export function foldAgentRuns(messages: RoomMessage[], expanded: ReadonlySet<string>): LogItem[] {
  const out: LogItem[] = [];
  let index = 0;
  while (index < messages.length) {
    if (!isAgent(messages[index])) {
      out.push({ kind: 'message', message: messages[index] });
      index += 1;
      continue;
    }
    let end = index;
    while (end < messages.length && isAgent(messages[end])) end += 1;
    const run = messages.slice(index, end);
    const key = run[0].clientMsgId;
    if (run.length >= FOLD_MIN_RUN && !expanded.has(key)) {
      const folded = run.slice(0, run.length - FOLD_KEEP_OPEN);
      out.push({ kind: 'fold', key, count: folded.length, firstAt: folded[0].at, lastAt: folded[folded.length - 1].at });
      for (const message of run.slice(folded.length)) out.push({ kind: 'message', message });
    } else {
      for (const message of run) out.push({ kind: 'message', message });
    }
    index = end;
  }
  return out;
}

// ---------------------------------------------------------------- delivery

export interface Label {
  tone: 'ok' | 'wait' | 'neutral';
  key: MessageKey;
  params?: Record<string, string | number>;
}

export interface DeliveryContext {
  hostOnline: boolean;
  hostNode: string;
}

/** The three states of FR-MSG-002 AC-4: sending, delivered, pasted n/m. */
export function deliveryLabel(message: RoomMessage, context: DeliveryContext): Label | null {
  if (message.from.kind === 'system' || message.system !== undefined) return null;
  if (message.seq === null) {
    return context.hostOnline
      ? { tone: 'wait', key: 'messenger.delivery.sending' }
      : { tone: 'wait', key: 'messenger.delivery.sendingHostOff', params: { host: context.hostNode } };
  }
  if (message.held) return { tone: 'wait', key: 'messenger.delivery.held' };
  const receipts = message.receipts;
  if (receipts === undefined) return { tone: 'neutral', key: 'messenger.delivery.delivered' };
  // A person-only mention pastes nowhere, so there is no state to show.
  if (receipts.targets === 0) return null;
  // Skipped targets leave the count. The headline names the real reason: "no agent" only when
  // that is the reason for every skip (an older server sends no reasons: no agent was the only one).
  const skipped = receipts.skipped ?? 0;
  const noAgentOnly = receipts.skippedReasons === undefined || (receipts.skippedReasons.NO_AGENT ?? 0) >= skipped;
  const failed = skipped > 0 && !noAgentOnly;
  const pasteable = receipts.targets - skipped;
  if (pasteable <= 0) return { tone: 'wait', key: noAgentOnly ? 'messenger.delivery.noAgent' : 'messenger.delivery.notPasted' };
  if (receipts.pasted > 0) {
    return { tone: 'ok', key: 'messenger.delivery.pasted', params: { pasted: Math.min(receipts.pasted, pasteable), total: pasteable } };
  }
  if (failed) return { tone: 'wait', key: 'messenger.delivery.notPasted' };
  if (receipts.delivered <= 0) return { tone: 'wait', key: 'messenger.delivery.sending' };
  if (receipts.delivered < receipts.targets) {
    return { tone: 'wait', key: 'messenger.delivery.waitingCount', params: { count: receipts.targets - receipts.delivered } };
  }
  return { tone: 'neutral', key: 'messenger.delivery.delivered' };
}

// ---------------------------------------------------------------- badges

export interface RoomBadge {
  tone: 'hold' | 'mention' | 'unread';
  text: string;
}

/** A mention count as a number: older servers sent a boolean (true counts as one). */
export function mentionCount(value: number | boolean | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' && value > 0 ? value : 0;
}

export function roomBadge(room: RoomSummary): RoomBadge | null {
  if (room.held) return { tone: 'hold', text: '!' };
  const mentions = mentionCount(room.mention);
  if (mentions > 0) return { tone: 'mention', text: `@${mentions}` };
  if (room.unread > 0) return { tone: 'unread', text: String(room.unread) };
  return null;
}

/**
 * The header button's badge (FR-MSG-013 AC-1). `pending` counts what waits for
 * me to act: invitations, approvals and contact requests (FR-MSG-010 AC-1).
 */
export function headerBadge(unread: { total: number; mention: number | boolean }, pending: number): { count: number; tone: 'danger' | 'accent' } | null {
  const count = unread.total + pending;
  if (count <= 0) return null;
  return { count, tone: mentionCount(unread.mention) > 0 || pending > 0 ? 'danger' : 'accent' };
}

export function sortRooms<T extends { lastAt: string }>(rooms: T[]): T[] {
  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  return [...rooms].sort((a, b) => time(b.lastAt) - time(a.lastAt));
}

// ---------------------------------------------------------------- layout

/** Narrower than this, the list and the conversation take turns (FR-MSG-013 AC-2). */
export const NARROW_WIDTH = 640;

export type MessengerLayout = 'split' | 'single';

export function messengerLayout(width: number, isMobile: boolean): MessengerLayout {
  return isMobile || width < NARROW_WIDTH ? 'single' : 'split';
}

export function visiblePanes(layout: MessengerLayout, openRoomId: string | null): { list: boolean; room: boolean } {
  if (layout === 'split') return { list: true, room: true };
  return openRoomId === null ? { list: true, room: false } : { list: false, room: true };
}

// ---------------------------------------------------------------- senders

export type WhoTone = 'human' | 'local' | 'remote';

export interface SenderView {
  tone: WhoTone;
  name: string;
  initial: string;
}

const initialOf = (name: string) => (Array.from(name.trim())[0] ?? '?').toUpperCase();

/** Who wrote a message, named and coloured as FR-MSG-004 AC-5 and FR-MSG-013 AC-4 say. */
export function senderView(from: MessageFrom, me: string, sessions: RoomSession[]): SenderView {
  if (from.kind !== 'agent' || from.sessionKey === undefined) {
    return { tone: 'human', name: from.node, initial: initialOf(from.node) };
  }
  const session = sessions.find((candidate) => candidate.node === from.node && candidate.sessionKey === from.sessionKey);
  const sessionName = session?.name ?? from.sessionKey;
  if (from.node === me) return { tone: 'local', name: sessionName, initial: initialOf(sessionName) };
  return { tone: 'remote', name: `${from.node}::${sessionName}`, initial: initialOf(sessionName) };
}

/** 「에이전트 없음 · 붙여넣지 않음」 for a room session without an AI agent; null otherwise or when unknown. */
export function sessionAgentNote(session: RoomSession): 'messenger.members.noAgent' | null {
  return session.agent === null ? 'messenger.members.noAgent' : null;
}

/** The display name of a member id (`node` or `node::sessionKey`). */
export function memberLabel(memberId: string, me: string, sessions: RoomSession[]): string {
  const session = sessions.find((candidate) => candidate.id === memberId);
  if (!session) return memberId;
  return session.node === me ? session.name : `${session.node}::${session.name}`;
}

// ---------------------------------------------------------------- names and contacts

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u;

export type NameErrorKey =
  | 'messenger.name.error.empty'
  | 'messenger.name.error.space'
  | 'messenger.name.error.forbidden'
  | 'messenger.name.error.pattern'
  | 'messenger.name.error.duplicate'
  | 'messenger.name.error.mine';

/** The name rules of contract §1 and mockup ④, with the wording each failure gets. */
export function validatePersonName(raw: string, context: { myName: string; existing: string[] }): NameErrorKey | null {
  const name = raw.trim();
  if (name === '') return 'messenger.name.error.empty';
  if (/\s/.test(name)) return 'messenger.name.error.space';
  if (name.includes('::') || name.includes('@') || name.includes('/')) return 'messenger.name.error.forbidden';
  if (!NAME_PATTERN.test(name)) return 'messenger.name.error.pattern';
  const lower = name.toLowerCase();
  if (context.myName.toLowerCase() === lower) return 'messenger.name.error.mine';
  if (context.existing.some((other) => other.toLowerCase() === lower)) return 'messenger.name.error.duplicate';
  return null;
}

export type ContactInputKind = 'empty' | 'contact-code' | 'invite-code' | 'address' | 'invalid';

export function classifyContactInput(raw: string): ContactInputKind {
  const value = raw.trim();
  if (value === '') return 'empty';
  if (value.startsWith('bgc1.')) return 'contact-code';
  if (value.startsWith('bgi1.')) return 'invite-code';
  // The port may be left out: the server then uses the LAN port (3334).
  const match = /^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(value);
  if (!match) return 'invalid';
  const port = match[1] === undefined ? 3334 : Number(match[1]);
  return port >= 1 && port <= 65535 ? 'address' : 'invalid';
}

export type ConnectFailureKey =
  | 'messenger.connect.error.codeExpired'
  | 'messenger.connect.error.unreachable'
  | 'messenger.connect.error.fingerprint';

/** The failure wording table of mockup ④, by the server's refusal codes. */
export function connectFailureKey(code: string | undefined): ConnectFailureKey | null {
  switch (code) {
    case 'CODE_INVALID': return 'messenger.connect.error.codeExpired';
    case 'ADDRESS_UNREACHABLE': return 'messenger.connect.error.unreachable';
    case 'TLS_FINGERPRINT_CHANGED': return 'messenger.connect.error.fingerprint';
    default: return null;
  }
}

// ---------------------------------------------------------------- session picker

export interface PickableSession {
  sessionKey: string;
  name?: string;
  alias?: string;
  workspaceId?: string;
  cwd?: string;
  agentKind?: string;
  agentStatus?: string;
}

const AGENT_AT_WORK = new Set(['busy', 'starting']);
const AGENT_ASKING = new Set(['waiting_input']);

const agentName = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

/** The status chip of a session row (mockup ③, ⑤): 「Claude 작업 중」 or 「대기」. */
export function agentChip(session: { agentKind?: string; agentStatus?: string }): Label {
  const kind = session.agentKind && session.agentKind !== 'unknown' ? session.agentKind : null;
  if (kind !== null && session.agentStatus !== undefined && AGENT_AT_WORK.has(session.agentStatus)) {
    return { tone: 'ok', key: 'messenger.agent.working', params: { agent: agentName(kind) } };
  }
  if (kind !== null && session.agentStatus !== undefined && AGENT_ASKING.has(session.agentStatus)) {
    return { tone: 'ok', key: 'messenger.agent.waiting', params: { agent: agentName(kind) } };
  }
  return { tone: 'neutral', key: 'messenger.agent.idle' };
}

/** Whether a picker session runs a detected AI agent; room messages are pasted only into those. */
export function sessionHasAgent(session: { agentKind?: string }): boolean {
  return session.agentKind !== undefined && session.agentKind !== '' && session.agentKind !== 'unknown';
}

export const sessionDisplayName = (session: PickableSession) => session.alias || session.name || session.sessionKey;

export interface SessionGroup<T extends PickableSession> {
  workspaceId: string;
  /** '' for sessions outside every known workspace. */
  name: string;
  sessions: T[];
}

/**
 * Sessions grouped by workspace in the sidebar's order. The search follows
 * session.search: every word must appear in the name, folder or workspace name,
 * in any order, ignoring case.
 */
export function groupSessions<T extends PickableSession>(
  sessions: T[],
  workspaces: Array<{ id: string; name: string; sortOrder: number }>,
  query: string,
): SessionGroup<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ordered = [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder);
  const nameOf = (id: string | undefined) => ordered.find((workspace) => workspace.id === id)?.name ?? '';
  const matches = (session: T) => {
    const haystack = `${sessionDisplayName(session)} ${session.cwd ?? ''} ${nameOf(session.workspaceId)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };
  const groups: SessionGroup<T>[] = ordered.map((workspace) => ({ workspaceId: workspace.id, name: workspace.name, sessions: [] }));
  const loose: SessionGroup<T> = { workspaceId: '', name: '', sessions: [] };
  for (const session of sessions) {
    if (!matches(session)) continue;
    const group = groups.find((candidate) => candidate.workspaceId === session.workspaceId) ?? loose;
    group.sessions.push(session);
  }
  return [...groups, loose].filter((group) => group.sessions.length > 0);
}

// ---------------------------------------------------------------- log

/** Older pages, the latest page and my outbox, oldest first, once per clientMsgId. */
export function mergeRoomMessages(older: RoomMessage[], latest: RoomMessage[], outbox: RoomMessage[]): RoomMessage[] {
  const seen = new Set<string>();
  const out: RoomMessage[] = [];
  for (const message of [...older, ...latest, ...outbox]) {
    if (seen.has(message.clientMsgId)) continue;
    seen.add(message.clientMsgId);
    out.push(message);
  }
  return out;
}

// ---------------------------------------------------------------- contact status and skip reasons

export type RelativeUnit = 'minute' | 'hour' | 'day';

/** The value and unit Intl.RelativeTimeFormat is given for a past time (negative = ago). */
export function relativeTimeParts(iso: string, now: Date): { value: number; unit: RelativeUnit } | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - now.getTime()) / 60_000);
  if (Math.abs(minutes) < 60) return { value: minutes, unit: 'minute' };
  if (Math.abs(minutes) < 60 * 24) return { value: Math.round(minutes / 60), unit: 'hour' };
  return { value: Math.round(minutes / (60 * 24)), unit: 'day' };
}

export type ContactStatusKey =
  | 'messenger.contact.connected'
  | 'messenger.contact.offline'
  | 'messenger.contact.offlineSince'
  | 'messenger.contact.requested'
  | 'messenger.contact.pendingIn'
  | 'messenger.contact.fingerprintChanged'
  | 'messenger.error.LINK_SAVE_FAILED';

/** A contact's state line: an error first, then the state; 「PC 꺼짐 · n시간 전」 only while disconnected. */
export function contactStatus(contact: Contact, now: Date): { key: ContactStatusKey; ago?: { value: number; unit: RelativeUnit } } {
  if (contact.error === 'TLS_FINGERPRINT_CHANGED') return { key: 'messenger.contact.fingerprintChanged' };
  if (contact.error === 'LINK_SAVE_FAILED') return { key: 'messenger.error.LINK_SAVE_FAILED' };
  switch (contact.state) {
    case 'connected': return { key: 'messenger.contact.connected' };
    case 'requested': return { key: 'messenger.contact.requested' };
    case 'pending-in': return { key: 'messenger.contact.pendingIn' };
    default: {
      const ago = contact.lastSeen === undefined ? null : relativeTimeParts(contact.lastSeen, now);
      return ago === null ? { key: 'messenger.contact.offline' } : { key: 'messenger.contact.offlineSince', ago };
    }
  }
}

export type SkipReasonKey = 'messenger.delivery.skippedNoAgent' | 'messenger.delivery.skippedFailed' | 'messenger.delivery.skippedMultiline' | 'messenger.delivery.skippedNotReady';

/** Why some targets were not pasted into, one hint per reason (「1개 세션은 에이전트 없음」). */
export function skipReasonHints(receipts: Receipts | undefined): Array<{ key: SkipReasonKey; count: number }> {
  const reasons = receipts?.skippedReasons;
  if (!reasons) return [];
  const hints: Array<{ key: SkipReasonKey; count: number }> = [];
  if ((reasons.NO_AGENT ?? 0) > 0) hints.push({ key: 'messenger.delivery.skippedNoAgent', count: reasons.NO_AGENT as number });
  if ((reasons.PASTE_FAILED ?? 0) > 0) hints.push({ key: 'messenger.delivery.skippedFailed', count: reasons.PASTE_FAILED as number });
  if ((reasons.MULTILINE_UNSUPPORTED ?? 0) > 0) hints.push({ key: 'messenger.delivery.skippedMultiline', count: reasons.MULTILINE_UNSUPPORTED as number });
  if ((reasons.AGENT_NOT_READY ?? 0) > 0) hints.push({ key: 'messenger.delivery.skippedNotReady', count: reasons.AGENT_NOT_READY as number });
  return hints;
}

/** The composer's 'storage PC is off' notice, dropped once the storage PC is reachable again. */
export function composerNotice(notice: 'waiting-host' | null, hostOnline: boolean): 'waiting-host' | null {
  return notice === 'waiting-host' && !hostOnline ? notice : null;
}

// ---------------------------------------------------------------- room names and invitations

/** The room name rule the server applies: 1..60 characters, no control characters, ']' or '|'. */
export function validateRoomName(raw: string): 'messenger.form.nameRequired' | 'messenger.form.nameInvalidChar' | null {
  const name = raw.trim();
  if (name.length < 1 || name.length > 60) return 'messenger.form.nameRequired';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\]|]/.test(name)) return 'messenger.form.nameInvalidChar';
  return null;
}

/** POST /rooms/:id/invite answers waiting-host when the storage PC is off: queued, not sent. */
export function inviteOutcome(result: { ok: true; status?: string }): 'sent' | 'waiting-host' {
  return result.status === 'waiting-host' ? 'waiting-host' : 'sent';
}

// ---------------------------------------------------------------- run count, local paste, Enter, move

/** 「연속 19/20」 for an agent message (mockup ⑥, FR-MSG-005 AC-2). */
export function agentRunLabel(message: RoomMessage, holdLimit: number): { key: 'messenger.delivery.agentRun'; params: { n: number; limit: number } } | null {
  if (message.from.kind !== 'agent' || typeof message.agentRun !== 'number') return null;
  return { key: 'messenger.delivery.agentRun', params: { n: message.agentRun, limit: holdLimit } };
}

/** 「붙여넣음 · 이 PC 안」 for a message still waiting for the storage PC (mockup ⑩, FR-MSG-011 AC-1). */
export function localReceiptLabel(message: RoomMessage): Label | null {
  if (message.seq !== null || !message.localReceipt || message.localReceipt.pasted <= 0) return null;
  return { tone: 'ok', key: 'messenger.delivery.pastedHere' };
}

/** The chosen sessions with their 「받은 메시지를 바로 입력」 choice, on unless switched off (FR-MSG-001 AC-1). */
export function sessionSelections(chosen: ReadonlySet<string>, enterOff: ReadonlySet<string>): Array<{ sessionKey: string; enter: boolean }> {
  return [...chosen].map((sessionKey) => ({ sessionKey, enter: !enterOff.has(sessionKey) }));
}

/** The 「보관 PC 옮기기」 suggestion, shown on the storage PC only (FR-MSG-012 AC-1). */
export function moveSuggestion(room: { hostNode: string; moveSuggested?: boolean; offlineHours7d?: number }, me: string): { hours: number } | null {
  if (!room.moveSuggested || room.hostNode.toLowerCase() !== me.toLowerCase()) return null;
  return { hours: room.offlineHours7d ?? 0 };
}
