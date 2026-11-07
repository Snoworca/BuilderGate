// Test harness: BuilderGate servers in one process, linked through a fake peer transport that
// dispatches buildergate.room.peer.* exactly like the peer link does (actor 'mcp-peer').
import { createMemoryRoomStore, type RoomStore } from './roomStore.js';
import { createRoomService, type RoomService } from './roomService.js';
import { callRoomPeerTool } from './roomPeerTools.js';

type Rec = Record<string, unknown>;

export interface FakeServer {
  name: string;
  svc: RoomService;
  store: RoomStore;
  pastes: Array<{ sessionKey: string; text: string; submit: boolean }>;
  sessions: Array<{ sessionKey: string; name: string; agent: { kind: string; status: string } | null }>;
  webhooks: string[];
  notes: Array<{ roomId?: string; reason: string }>;
  roomLinks: Array<{ hostNode: string; token: string }>;
  dropped: string[];
  revoked: Array<{ roomId: string; node: string }>;
  tickets: Array<{ roomId: string; invitee: string }>;
  /** Room keys this server gave out: node → rooms. */
  roomKeys: Map<string, string[]>;
  /** Pastes into these sessions fail. */
  failPaste: Set<string>;
  /** Pastes into these sessions answer this refusal (e.g. PASTE_MULTILINE_UNSUPPORTED). */
  refusePaste: Map<string, string>;
  /** What ensureRoomLink answers (default ok). */
  roomLinkResult: Record<string, unknown>;
  /** LAN receiving: off means connectInfo() has no addresses. */
  lanOn: boolean;
}

export class FakeNetwork {
  readonly servers = new Map<string, FakeServer>();
  readonly online = new Set<string>();
  readonly links = new Set<string>();
  clock = new Date(2026, 10, 7, 10, 0, 0).getTime();
  calls: Array<{ from: string; to: string; tool: string }> = [];
  /** Calls of these tools fail as if the link were down. */
  readonly dropTools = new Set<string>();

  link(a: string, b: string): void {
    this.links.add([a, b].sort().join('|'));
  }

  connected(a: string, b: string): boolean {
    return this.online.has(a) && this.online.has(b) && this.links.has([a, b].sort().join('|'));
  }

  contact(a: string, b: string): boolean {
    return this.contacts.has([a, b].sort().join('|'));
  }

  readonly contacts = new Set<string>();

  befriend(a: string, b: string): void {
    this.contacts.add([a, b].sort().join('|'));
    this.link(a, b);
  }

  async add(name: string, sessions: Array<{ sessionKey: string; name: string; agent?: { kind: string; status: string } | null }>, store = createMemoryRoomStore()): Promise<FakeServer> {
    const server: FakeServer = {
      name, store, pastes: [], webhooks: [], notes: [], roomLinks: [], dropped: [], revoked: [], tickets: [],
      roomKeys: new Map(), failPaste: new Set(), refusePaste: new Map(), roomLinkResult: { ok: true }, lanOn: true,
      sessions: sessions.map((s) => ({ agent: { kind: 'claude', status: 'ready' }, ...s })),
      svc: undefined as unknown as RoomService,
    };
    let ids = 0;
    server.svc = createRoomService({
      store,
      transport: {
        nodeName: () => name,
        isConnected: (node) => this.connected(name, node),
        call: async (node, tool, args) => {
          this.calls.push({ from: name, to: node, tool });
          if (!this.servers.has(node)) return { ok: false, code: 'PEER_NOT_FOUND', peer: node };
          if (!this.connected(name, node) || this.dropTools.has(tool)) return { ok: false, code: 'PEER_DISCONNECTED', peer: node };
          const target = this.servers.get(node)!;
          const actor = { type: 'mcp-peer', peer: name, scopes: ['mcp:room'] };
          return JSON.parse(JSON.stringify(await callRoomPeerTool(target.svc, tool, JSON.parse(JSON.stringify(args)) as Rec, actor))) as Rec;
        },
      },
      sessions: { list: () => server.sessions },
      paster: {
        paste: async (sessionKey, text, submit) => {
          if (server.failPaste.has(sessionKey)) return false;
          const refused = server.refusePaste.get(sessionKey);
          if (refused) return { ok: false as const, code: refused };
          server.pastes.push({ sessionKey, text, submit });
          return true;
        },
      },
      notify: (change) => { server.notes.push(change); },
      webhook: async (_url, text) => { server.webhooks.push(text); },
      net: {
        connectInfo: () => ({ urls: server.lanOn ? [`wss://${name}:3333/mcp/peer`] : [], fp: `fp-${name}` }),
        ensureRoomLink: async (input) => {
          server.roomLinks.push({ hostNode: input.hostNode, token: input.token });
          if (server.roomLinkResult.ok === false) return server.roomLinkResult;
          const host = this.servers.get(input.hostNode);
          const rooms = host ? [...host.tickets].filter((t) => t.invitee === name || t.invitee === '').map((t) => t.roomId) : [];
          host?.roomKeys.set(name, rooms);
          this.link(name, input.hostNode);
          return { ok: true };
        },
        dropRoomLink: (hostNode) => { server.dropped.push(hostNode); },
        isContact: (node) => this.contact(name, node),
      },
      keys: {
        issueRoomTicket: (input) => {
          server.tickets.push(input);
          return { token: `ticket-${server.tickets.length}`, expiresAt: '2026-11-14T00:00:00.000Z' };
        },
        revokeRoomKey: (input) => { server.revoked.push(input); },
        // Like keys.ts: a contact key reaches every room; a room key only its rooms.
        allowedRooms: (node) => server.roomKeys.get(node) ?? (this.contact(name, node) ? 'all' : 'none'),
      },
      now: () => new Date(this.clock),
      randomId: () => `${name}${String(++ids).padStart(4, '0')}`,
      sleep: async () => undefined,
    });
    await server.svc.start();
    await server.svc.setWebhook('https://chat.example/hook');
    this.servers.set(name, server);
    this.online.add(name);
    return server;
  }

  async idle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.all([...this.servers.values()].map((server) => server.svc.idle()));
    }
  }
}
