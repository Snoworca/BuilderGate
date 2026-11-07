// FR-MSG-002 AC-3 (contract §2): the messenger's files under data/messenger/. Writes to one file
// are chained so two saves never interleave; nothing here blocks a thread.
import fs from 'node:fs/promises';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';
import type { Room, RoomMessage } from './types.js';

export const DEFAULT_MESSENGER_DIR = './data/messenger';

export interface Ticket {
  roomId: string;
  roomName: string;
  hostNode: string;
  urls: string[];
  fp: string;
  token: string;
}

/** An invitation still to be sent to `invitee` (FR-MSG-010 AC-4: kept until that PC is on). */
export interface PendingInvite {
  invitee: string;
  invitedBy: string;
  message?: string;
  ticket?: Ticket;
  /** Sent through this member, which knows the invitee (after an approval). */
  via?: string;
  /** M-2: asked while the host was away; the ticket is requested when the host link is up. */
  needsTicket?: boolean;
}

export interface RoomMeta {
  readSeq: number;
  /** The last sequence number applied here. */
  mySeq: number;
  hostOfflineSince?: string;
  /** clientMsgIds already pasted here (bounded). */
  pasted: string[];
  /** Local sessions that got the entrance notice. */
  greeted: string[];
  pendingInvites: PendingInvite[];
  /** This server left, or was removed from, the room. */
  left?: boolean;
  /** FR-MSG-002 AC-4: receipts the host did not get (it was off); sent again after a sync. */
  pendingReceipts?: Array<{ seq: number; pasted: string[]; skipped: string[]; skippedReasons?: Record<string, string> }>;
  /** Set on the old host after a transfer, for members that still sync here. */
  movedTo?: { host: string; tickets: Record<string, Ticket> };
}

export interface RoomRecord {
  room: Room;
  meta: RoomMeta;
}

export interface Invite {
  id: string;
  room: { id: string; name: string; hostNode: string; people: string[]; sessions: string[] };
  invitedBy: string;
  message?: string;
  at: string;
  ticket?: Ticket;
  /** M-3: declined while the host was away; sent when a link to the host exists, then removed. */
  declined?: boolean;
  /** Accepted, waiting for the link to the host to join. */
  accepting?: { sessions: string[]; personOnly: boolean; enter?: boolean };
}

export interface Approval {
  id: string;
  roomId: string;
  invitee: string;
  invitedBy: string;
  message?: string;
  at: string;
  /** On the creator's server: a copy of an approval the host keeps (FR-MSG-009 AC-3). */
  remote?: boolean;
  /** On the host: whether the creator's server has the card (false while it is off). */
  notified?: boolean;
}

/** FR-MSG-002 AC-4: per sequence number. `nodes`/`sessions` are kept on the host only. */
export interface ReceiptEntry {
  targets: number;
  delivered: number;
  pasted: number;
  skipped?: number;
  /** Count per reason (NO_AGENT, PASTE_FAILED). */
  skippedReasons?: Record<string, number>;
  nodes?: string[];
  sessions?: string[];
  /** Host only: session id → why it was not pasted. */
  skippedBy?: Record<string, string>;
}

export interface MessengerSettings {
  webhookUrl?: string;
}

export interface MessengerState {
  rooms: RoomRecord[];
  invites: Invite[];
  approvals: Approval[];
}

export interface RoomStore {
  load(): Promise<MessengerState & { settings: MessengerSettings }>;
  saveState(state: MessengerState): Promise<void>;
  saveSettings(settings: MessengerSettings): Promise<void>;
  readLog(roomId: string): Promise<RoomMessage[]>;
  appendLog(roomId: string, messages: RoomMessage[]): Promise<void>;
  writeLog(roomId: string, messages: RoomMessage[]): Promise<void>;
  readOutbox(roomId: string): Promise<RoomMessage[]>;
  writeOutbox(roomId: string, messages: RoomMessage[]): Promise<void>;
  readReceipts(roomId: string): Promise<Record<string, ReceiptEntry>>;
  writeReceipts(roomId: string, receipts: Record<string, ReceiptEntry>): Promise<void>;
}

const ROOM_ID = /^rm_[A-Za-z0-9]{1,64}$/;

function checkRoomId(roomId: string): void {
  if (!ROOM_ID.test(roomId)) throw new Error(`ROOM_ID_INVALID: ${roomId}`);
}

export function createFileRoomStore(dir: string = DEFAULT_MESSENGER_DIR): RoomStore {
  const root = path.resolve(dir);
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(file: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(file) ?? Promise.resolve()).then(work, work);
    chains.set(file, next.catch(() => undefined));
    return next;
  };
  const roomFile = (roomId: string, suffix: string) => {
    checkRoomId(roomId);
    return path.join(root, 'rooms', `${roomId}${suffix}`);
  };
  const readJson = async <T>(file: string, fallback: T): Promise<T> => {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      console.warn(`[Messenger] Ignoring unreadable ${path.basename(file)}`);
      return fallback;
    }
  };
  const readLines = async (file: string): Promise<RoomMessage[]> => {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const messages: RoomMessage[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as RoomMessage);
      } catch {
        console.warn(`[Messenger] Skipping a broken line in ${path.basename(file)}`);
      }
    }
    return messages;
  };
  const toLines = (messages: RoomMessage[]) => messages.map((message) => `${JSON.stringify(message)}\n`).join('');
  const publish = (file: string, contents: string) => serial(file, () => publishStoreAtomically(file, contents, { writeBackup: false, ensureDirectory: true }));

  return {
    async load() {
      const state = await readJson<Partial<MessengerState>>(path.join(root, 'rooms.json'), {});
      const invites = await readJson<Partial<MessengerState>>(path.join(root, 'invites.json'), {});
      const settings = await readJson<MessengerSettings>(path.join(root, 'settings.json'), {});
      return {
        rooms: Array.isArray(state.rooms) ? state.rooms : [],
        invites: Array.isArray(invites.invites) ? invites.invites : [],
        approvals: Array.isArray(invites.approvals) ? invites.approvals : [],
        settings: typeof settings.webhookUrl === 'string' ? { webhookUrl: settings.webhookUrl } : {},
      };
    },
    async saveState(state) {
      await Promise.all([
        publish(path.join(root, 'rooms.json'), JSON.stringify({ rooms: state.rooms }, null, 2)),
        publish(path.join(root, 'invites.json'), JSON.stringify({ invites: state.invites, approvals: state.approvals }, null, 2)),
      ]);
    },
    saveSettings: (settings) => publish(path.join(root, 'settings.json'), JSON.stringify(settings, null, 2)),
    readLog: async (roomId) => readLines(roomFile(roomId, '.jsonl')),
    appendLog: async (roomId, messages) => {
      const file = roomFile(roomId, '.jsonl');
      await serial(file, async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, toLines(messages), 'utf8');
      });
    },
    writeLog: async (roomId, messages) => publish(roomFile(roomId, '.jsonl'), toLines(messages)),
    readOutbox: async (roomId) => readLines(roomFile(roomId, '.outbox.jsonl')),
    writeOutbox: async (roomId, messages) => {
      const file = roomFile(roomId, '.outbox.jsonl');
      if (messages.length > 0) return publish(file, toLines(messages));
      await serial(file, () => fs.rm(file, { force: true }));
    },
    readReceipts: async (roomId) => readJson<Record<string, ReceiptEntry>>(roomFile(roomId, '.receipts.json'), {}),
    writeReceipts: async (roomId, receipts) => publish(roomFile(roomId, '.receipts.json'), JSON.stringify(receipts)),
  };
}

/** For tests: the same contract, kept in memory (values are copied in and out). */
export function createMemoryRoomStore(): RoomStore {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  let state: MessengerState = { rooms: [], invites: [], approvals: [] };
  let settings: MessengerSettings = {};
  const logs = new Map<string, RoomMessage[]>();
  const outboxes = new Map<string, RoomMessage[]>();
  const receipts = new Map<string, Record<string, ReceiptEntry>>();
  return {
    load: async () => copy({ ...state, settings }),
    saveState: async (next) => { state = copy(next); },
    saveSettings: async (next) => { settings = copy(next); },
    readLog: async (roomId) => copy(logs.get(roomId) ?? []),
    appendLog: async (roomId, messages) => {
      checkRoomId(roomId);
      logs.set(roomId, [...(logs.get(roomId) ?? []), ...copy(messages)]);
    },
    writeLog: async (roomId, messages) => { logs.set(roomId, copy(messages)); },
    readOutbox: async (roomId) => copy(outboxes.get(roomId) ?? []),
    writeOutbox: async (roomId, messages) => { outboxes.set(roomId, copy(messages)); },
    readReceipts: async (roomId) => copy(receipts.get(roomId) ?? {}),
    writeReceipts: async (roomId, value) => { receipts.set(roomId, copy(value)); },
  };
}
