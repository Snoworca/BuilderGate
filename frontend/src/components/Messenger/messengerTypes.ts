// The shapes the messenger REST API returns (docs/design/messenger.contract.md §2, §9).
// @req FR-MSG-013

export type InvitePolicy = 'auto' | 'approve';

export interface RoomPerson {
  node: string;
  invitedBy?: string;
  joinedAt: string;
  state: 'joined' | 'invited' | 'approval';
}

export interface RoomSession {
  /** `<node>::<sessionKey>` */
  id: string;
  node: string;
  sessionKey: string;
  name: string;
  enter: boolean;
  pasteAll: boolean;
  /** The AI agent detected in the session; null means none, and then nothing is pasted into it. */
  agent?: { kind: string; status: string } | null;
}

export interface Room {
  id: string;
  name: string;
  hostNode: string;
  createdBy: string;
  createdAt: string;
  settings: { invitePolicy: InvitePolicy; holdLimit: number };
  people: RoomPerson[];
  sessions: RoomSession[];
  agentRun: number;
  held: boolean;
  lastSeq: number;
  /** The storage PC was off long enough last week that moving the room is suggested (FR-MSG-012). */
  moveSuggested?: boolean;
  offlineHours7d?: number;
}

export type SystemEvent =
  | 'joined' | 'left' | 'removed' | 'invited' | 'declined'
  | 'session-added' | 'session-removed' | 'host-moved' | 'continued';

export interface MessageFrom {
  node: string;
  sessionKey?: string;
  kind: 'human' | 'agent' | 'system';
}

export interface RoomMessage {
  seq: number | null;
  clientMsgId: string;
  roomId: string;
  at: string;
  from: MessageFrom;
  to: string[];
  text: string;
  held?: boolean;
  system?: { event: SystemEvent; actor?: string; subject?: string };
  /** Session targets and how many got it / had it pasted (GET /rooms/:id). */
  receipts?: Receipts;
  /** Agent messages in a row up to this one, as the storage PC counted (FR-MSG-005). */
  agentRun?: number;
  /** An outbox message already pasted into sessions on this PC (FR-MSG-011 AC-1). */
  localReceipt?: Pick<Receipts, 'pasted' | 'skipped' | 'skippedReasons'>;
}

export interface Receipts {
  targets: number;
  delivered: number;
  pasted: number;
  /** Targets not pasted into; `targets` includes them. */
  skipped?: number;
  skippedReasons?: { NO_AGENT?: number; PASTE_FAILED?: number; MULTILINE_UNSUPPORTED?: number };
}

export interface DeliveryCounts {
  pasted: number;
  waiting: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  hostNode: string;
  isHost: boolean;
  hostOnline: boolean;
  lastAt: string;
  lastText: string;
  lastFrom: string;
  unread: number;
  /** Messages naming me or my sessions. Older servers sent a boolean; true counts as one. */
  mention: number | boolean;
  held: boolean;
  invitedPending: string[];
  /** People whose invitation waits for the storage PC to come on (mockup ⑨). */
  invitesWaitingHost?: string[];
}

export type ContactState = 'connected' | 'disconnected' | 'requested' | 'pending-in';

export interface Contact {
  name: string;
  state: ContactState;
  /** `host:port` */
  address?: string;
  /** When the link was last up (ISO); shown only while disconnected. */
  lastSeen?: string;
  /** Why the link is not usable, when the server knows. */
  error?: 'TLS_FINGERPRINT_CHANGED' | 'LINK_SAVE_FAILED';
}

export interface Invite {
  id: string;
  /** `sessions` are display names such as `alice::worker`. */
  room: { id: string; name: string; hostNode: string; people: string[]; sessions: string[] };
  invitedBy: string;
  message?: string;
  at: string;
  /** The join is in progress. */
  accepting?: true;
}

export interface ContactRequest {
  id: string;
  fromNode: string;
  /** The requester's IP. */
  fromAddress?: string;
  at: string;
}

export interface Approval {
  id: string;
  roomId: string;
  roomName: string;
  invitedBy: string;
  invitee: string;
  message?: string;
  at: string;
}

export interface MessengerState {
  me: { name: string };
  lan: { receiving: boolean; port?: number };
  hasWebhook: boolean;
  rooms: RoomSummary[];
  contacts: Contact[];
  invites: Invite[];
  requests: ContactRequest[];
  approvals: Approval[];
  sessionRooms: Record<string, string[]>;
  unread: { total: number; mention: number | boolean };
}

export interface RoomDetail {
  room: Room;
  messages: RoomMessage[];
  host: { node: string; online: boolean; offlineSince?: string };
  outbox: RoomMessage[];
}

export interface SendResult {
  ok: true;
  messageId: string;
  seq: number | null;
  held: boolean;
  status: 'sequenced' | 'waiting-host';
  delivery: DeliveryCounts;
}

export interface SearchResult {
  rooms: Array<{ id: string; name: string }>;
  messages: Array<{ roomId: string; roomName: string; seq: number; text: string }>;
}
