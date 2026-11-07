// FR-MSG-001..015: the shapes of docs/design/messenger.contract.md §2. Plain data, no behaviour.

export type InvitePolicy = 'auto' | 'approve';
export type PersonState = 'joined' | 'invited' | 'approval';
export type SenderKind = 'human' | 'agent' | 'system';
export type SystemEvent =
  | 'joined' | 'left' | 'removed' | 'invited' | 'declined'
  | 'session-added' | 'session-removed' | 'host-moved' | 'continued';

export interface RoomPerson {
  node: string;
  invitedBy?: string;
  joinedAt: string;
  state: PersonState;
}

export interface RoomSession {
  /** `<node>::<sessionKey>` */
  id: string;
  node: string;
  sessionKey: string;
  name: string;
  enter: boolean;
  pasteAll: boolean;
  /** The AI agent its owner server detects there, or null (nothing is pasted then). */
  agent?: SessionAgent | null;
}

export interface SessionAgent {
  kind: string;
  status: string;
}

export interface RoomSettings {
  invitePolicy: InvitePolicy;
  holdLimit: number;
}

export interface Room {
  id: string;
  name: string;
  hostNode: string;
  createdBy: string;
  createdAt: string;
  settings: RoomSettings;
  people: RoomPerson[];
  sessions: RoomSession[];
  agentRun: number;
  held: boolean;
  lastSeq: number;
}

export interface RoomMessage {
  seq: number | null;
  clientMsgId: string;
  roomId: string;
  at: string;
  from: { node: string; sessionKey?: string; kind: SenderKind };
  to: string[];
  text: string;
  held?: boolean;
  /** FR-MSG-002 AC-4: set by the host once numbered — receiving sessions, servers that acked, sessions pasted. */
  receipts?: { targets: number; delivered: number; pasted: number; skipped?: number; skippedReasons?: Record<string, number> };
  system?: { event: SystemEvent; actor?: string; subject?: string };
}

export const DEFAULT_HOLD_LIMIT = 20;
export const ROOM_NAME_MAX = 60;

export function sessionMemberId(node: string, sessionKey: string): string {
  return `${node}::${sessionKey}`;
}

export function sameNode(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
