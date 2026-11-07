// FR-MCP-016..FR-MCP-019 (#233): the peer link protocol, driven over an in-memory transport with a
// fake clock. The WebSocket transport itself is covered by peerWsTransport.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPeerLinkManager, type PeerClock, type PeerLinkManager, type PeerLinkManagerDeps } from './peerLinkManager.js';
import { DEFAULT_PEER_LINK_SETTINGS, type PeerLinkSettings } from './peerLinkSettings.js';

type Rec = Record<string, unknown>;

class FakeClock implements PeerClock {
  t = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
    await settle();
  }
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** One in-memory wire between a dialer and an acceptor; frames arrive on a later tick. */
class Wire {
  open = true;
  /** Frames the dialer sent, as parsed objects (for assertions). */
  fromDialer: Rec[] = [];
  fromAcceptor: Rec[] = [];
  dropToAcceptor = false;
  dropToDialer = false;
  dialerHandlers?: { onOpen(): void; onText(t: string): void; onClose(r?: string): void };
  acceptorHandlers?: { onText(t: string): void; onClose(r?: string): void };
  close() {
    if (!this.open) return;
    this.open = false;
    setImmediate(() => { this.dialerHandlers?.onClose('closed'); this.acceptorHandlers?.onClose('closed'); });
  }
}

interface Node {
  manager: PeerLinkManager;
  calls: Array<{ tool: string; args: Rec; actor: Rec }>;
}

function makeNode(clock: FakeClock, opts: {
  name: string;
  settings?: Partial<PeerLinkSettings>;
  acceptor?: () => Node;
  wires?: Wire[];
  toolResult?: (tool: string, args: Rec) => Rec | Promise<Rec>;
  authenticate?: PeerLinkManagerDeps['authenticate'];
  onConnected?: PeerLinkManagerDeps['onConnected'];
}): Node {
  const calls: Node['calls'] = [];
  let epochCounter = 0;
  const node: Node = { calls, manager: undefined as unknown as PeerLinkManager };
  node.manager = createPeerLinkManager({
    clock,
    random: () => 0.5,
    createEpoch: () => `${opts.name}-e${++epochCounter}`,
    dial: (_link, handlers) => {
      const wire = new Wire();
      opts.wires?.push(wire);
      wire.dialerHandlers = handlers;
      const acceptor = opts.acceptor!();
      setImmediate(() => {
        if (!wire.open) return;
        wire.acceptorHandlers = acceptor.manager.accept({
          send: (text) => {
            if (!wire.open) return;
            wire.fromAcceptor.push(JSON.parse(text));
            // Like a real socket, a frame sent before close still arrives.
            if (!wire.dropToDialer) setImmediate(() => handlers.onText(text));
          },
          close: () => wire.close(),
        }, { remoteAddress: '10.0.0.1' });
        handlers.onOpen();
      });
      return {
        send: (text) => {
          if (!wire.open) return;
          wire.fromDialer.push(JSON.parse(text));
          if (!wire.dropToAcceptor) setImmediate(() => wire.acceptorHandlers?.onText(text));
        },
        close: () => wire.close(),
      };
    },
    authenticate: opts.authenticate ?? (async (key) => (key === 'good-key'
      ? { ok: true, scopes: ['mcp:sessions.list', 'mcp:message.paste', 'mcp:message.submit'] }
      : { ok: false, code: 'PEER_AUTH_FAILED' })),
    callTool: async (tool, args, actor) => {
      calls.push({ tool, args, actor: actor as unknown as Rec });
      return opts.toolResult ? opts.toolResult(tool, args) : { ok: true, status: 'delivered' };
    },
    onConnected: opts.onConnected,
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: opts.name, ...opts.settings });
  return node;
}

const LINK = { name: 'azure', url: 'wss://azure.example/mcp/peer', accessKey: 'good-key', enabled: true };
const ALL = ['mcp:sessions.list', 'mcp:message.paste', 'mcp:message.submit'];

function pair(clock: FakeClock, extra: {
  dialer?: Partial<PeerLinkSettings>;
  acceptor?: Partial<PeerLinkSettings>;
  toolResult?: (tool: string, args: Rec) => Rec | Promise<Rec>;
  dialerToolResult?: (tool: string, args: Rec) => Rec | Promise<Rec>;
} = {}) {
  const wires: Wire[] = [];
  const azure = makeNode(clock, { name: 'azure', settings: extra.acceptor, toolResult: extra.toolResult });
  const corp = makeNode(clock, {
    name: 'corp', acceptor: () => azure, wires, toolResult: extra.dialerToolResult,
    settings: { links: [LINK], ...extra.dialer },
  });
  return { azure, corp, wires };
}

const statusOf = (manager: PeerLinkManager, name: string) => manager.list().find((peer) => peer.name === name);

test('FR-MCP-016 AC-3/AC-6: the dialer sends hello with the key first, the acceptor answers welcome and names the link after the node', async () => {
  const clock = new FakeClock();
  const { azure, corp, wires } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  assert.equal(wires[0]!.fromDialer[0]!.t, 'hello');
  assert.equal(wires[0]!.fromDialer[0]!.key, 'good-key');
  assert.equal(wires[0]!.fromDialer[0]!.node, 'corp');
  assert.equal(wires[0]!.fromAcceptor[0]!.t, 'welcome');
  assert.equal(statusOf(corp.manager, 'azure')?.state, 'connected');
  assert.equal(statusOf(corp.manager, 'azure')?.direction, 'outbound');
  assert.equal(statusOf(azure.manager, 'corp')?.state, 'connected');
  assert.equal(statusOf(azure.manager, 'corp')?.direction, 'inbound');
});

test('FR-MCP-016 AC-4: a wrong key gets bye and nothing else, and the link is not registered', async () => {
  const clock = new FakeClock();
  const { azure, corp, wires } = pair(clock, { dialer: { links: [{ ...LINK, accessKey: 'bad' }] } });
  corp.manager.start();
  await clock.advance(0);
  assert.deepEqual(wires[0]!.fromAcceptor.map((f) => f.t), ['bye']);
  assert.equal(wires[0]!.fromAcceptor[0]!.code, 'PEER_AUTH_FAILED');
  assert.equal(statusOf(azure.manager, 'corp'), undefined);
  assert.equal(statusOf(corp.manager, 'azure')?.lastError, 'PEER_AUTH_FAILED');
});

test('FR-MCP-016 AC-4: a connection that sends no hello within 10 s is closed', async () => {
  const clock = new FakeClock();
  const azure = makeNode(clock, { name: 'azure' });
  let closed = false;
  azure.manager.accept({ send: () => {}, close: () => { closed = true; } }, { remoteAddress: '10.0.0.1' });
  await clock.advance(9_999);
  assert.equal(closed, false);
  await clock.advance(1);
  assert.equal(closed, true);
});

test('FR-MCP-016 AC-7: a malformed frame gets bye PEER_PROTOCOL_ERROR', async () => {
  const clock = new FakeClock();
  const azure = makeNode(clock, { name: 'azure' });
  const sent: Rec[] = [];
  let closed = false;
  const handlers = azure.manager.accept({ send: (t) => sent.push(JSON.parse(t)), close: () => { closed = true; } }, {});
  handlers.onText('not json');
  await settle();
  assert.equal(sent[0]?.code, 'PEER_PROTOCOL_ERROR');
  assert.equal(closed, true);
});

test('FR-MCP-016 AC-6: a node name that breaks the rule is refused', async () => {
  const clock = new FakeClock();
  const azure = makeNode(clock, { name: 'azure' });
  const sent: Rec[] = [];
  const handlers = azure.manager.accept({ send: (t) => sent.push(JSON.parse(t)), close: () => {} }, {});
  handlers.onText(JSON.stringify({ t: 'hello', v: 1, node: 'a b', epoch: 'e', heartbeatMs: 15000, key: 'good-key' }));
  await settle();
  assert.equal(sent[0]?.t, 'bye');
});

test('FR-MCP-017 AC-1: heartbeats go out at the shorter of the two intervals', async () => {
  const clock = new FakeClock();
  const { wires, corp } = pair(clock, { dialer: { heartbeatMs: 15_000 }, acceptor: { heartbeatMs: 5_000 } });
  corp.manager.start();
  await clock.advance(0);
  await clock.advance(10_000);
  const hbFromDialer = wires[0]!.fromDialer.filter((f) => f.t === 'hb').length;
  const hbFromAcceptor = wires[0]!.fromAcceptor.filter((f) => f.t === 'hb').length;
  assert.equal(hbFromDialer, 2);
  assert.equal(hbFromAcceptor, 2);
});

test('FR-MCP-017 AC-2/AC-3: silence past the timeout closes the link, and the dialer reconnects with backoff', async () => {
  const clock = new FakeClock();
  const { corp, wires } = pair(clock, { dialer: { heartbeatMs: 4_000 }, acceptor: { heartbeatMs: 4_000 } });
  corp.manager.start();
  await clock.advance(0);
  wires[0]!.dropToDialer = true;
  await clock.advance(9_999);
  assert.equal(statusOf(corp.manager, 'azure')?.state, 'connected');
  await clock.advance(1);
  assert.notEqual(statusOf(corp.manager, 'azure')?.state, 'connected');
  assert.equal(wires[0]!.open, false);
  // backoff 1 s (random 0.5 means no jitter)
  await clock.advance(999);
  assert.equal(wires.length, 1);
  await clock.advance(1);
  assert.equal(wires.length, 2);
  assert.equal(statusOf(corp.manager, 'azure')?.state, 'connected');
});

test('FR-MCP-017 AC-3: the reconnect wait doubles to 30 s and resets after a welcome', async () => {
  const clock = new FakeClock();
  const wires: Wire[] = [];
  let refuse = true;
  const azure = makeNode(clock, {
    name: 'azure',
    authenticate: async () => (refuse ? { ok: false, code: 'PEER_AUTH_FAILED' } : { ok: true, scopes: ALL }),
  });
  const corp = makeNode(clock, { name: 'corp', acceptor: () => azure, wires, settings: { links: [LINK] } });
  corp.manager.start();
  await clock.advance(0);
  // FR-MCP-017 AC-4: an auth failure waits the longest
  assert.equal(wires.length, 1);
  await clock.advance(29_999);
  assert.equal(wires.length, 1);
  await clock.advance(1);
  assert.equal(wires.length, 2);
  refuse = false;
  await clock.advance(30_000);
  assert.equal(statusOf(corp.manager, 'azure')?.state, 'connected');
  wires[wires.length - 1]!.close();
  await clock.advance(0);
  const before = wires.length;
  await clock.advance(1_000);
  assert.equal(wires.length, before + 1);
});

test('FR-MCP-017 AC-5: removing the link stops reconnecting and closes it', async () => {
  const clock = new FakeClock();
  const { corp, wires } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  corp.manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [] });
  await clock.advance(60_000);
  assert.equal(wires.length, 1);
  assert.equal(wires[0]!.open, false);
  assert.equal(statusOf(corp.manager, 'azure'), undefined);
});

test('FR-MCP-018 AC-1/AC-3, FR-MCP-019 AC-2: a message runs on the other side and its result comes back', async () => {
  const clock = new FakeClock();
  const { corp, azure, wires } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  const result = await corp.manager.sendMessage({ peer: 'azure', args: { target: 'worker', prompt: 'hi' }, scopes: ALL, hasKeys: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'delivered');
  assert.equal(typeof result.messageId, 'string');
  const msg = wires[0]!.fromDialer.find((f) => f.t === 'msg')!;
  assert.equal(msg.seq, 1);
  assert.equal(msg.epoch, 'corp-e1');
  assert.equal(azure.calls[0]!.tool, 'buildergate.message.send');
  assert.deepEqual(azure.calls[0]!.args, { target: 'worker', prompt: 'hi', includeSender: false });
  assert.equal(azure.calls[0]!.actor.type, 'mcp-peer');
  assert.equal(azure.calls[0]!.actor.peer, 'corp');
});

test('FR-MCP-018 AC-2/AC-7, FR-MCP-019 AC-2/AC-3: while disconnected a message is queued, then sent in order on reconnect', async () => {
  const clock = new FakeClock();
  const { corp, azure, wires } = pair(clock);
  const first = corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'one' }, scopes: ALL, hasKeys: false });
  const second = corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'two' }, scopes: ALL, hasKeys: false });
  await clock.advance(3_000);
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, 'queued');
  assert.equal(r2.status, 'queued');
  assert.equal(corp.manager.messageStatus(r1.messageId as string)?.status, 'queued');
  assert.equal(statusOf(corp.manager, 'azure')?.queued, 2);
  corp.manager.start();
  await clock.advance(0);
  assert.deepEqual(azure.calls.map((c) => c.args.prompt), ['one', 'two']);
  assert.deepEqual(wires[0]!.fromDialer.filter((f) => f.t === 'msg').map((f) => f.seq), [1, 2]);
  assert.equal(corp.manager.messageStatus(r1.messageId as string)?.status, 'delivered');
  assert.equal(statusOf(corp.manager, 'azure')?.queued, 0);
  assert.equal(corp.manager.messageStatus('nope'), undefined);
});

test('FR-MCP-018 AC-3: the receiver runs one message at a time, in order', async () => {
  const clock = new FakeClock();
  const order: string[] = [];
  const { corp } = pair(clock, {
    toolResult: async (_tool, args) => {
      order.push(`start ${args.prompt}`);
      await new Promise<void>((resolve) => clock.setTimeout(resolve, args.prompt === 'slow' ? 500 : 10));
      order.push(`end ${args.prompt}`);
      return { ok: true, status: 'delivered' };
    },
  });
  corp.manager.start();
  await clock.advance(0);
  void corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'slow' }, scopes: ALL, hasKeys: false });
  void corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'fast' }, scopes: ALL, hasKeys: false });
  await clock.advance(1_000);
  assert.deepEqual(order, ['start slow', 'end slow', 'start fast', 'end fast']);
});

test('FR-MCP-018 AC-4: a message resent after a reconnect is not run twice', async () => {
  const clock = new FakeClock();
  const { corp, azure, wires } = pair(clock, { dialer: { heartbeatMs: 4_000 }, acceptor: { heartbeatMs: 4_000 } });
  corp.manager.start();
  await clock.advance(0);
  wires[0]!.dropToDialer = true; // the result never comes back
  const pending = corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'once' }, scopes: ALL, hasKeys: false });
  await clock.advance(3_000);
  assert.equal((await pending).status, 'queued');
  assert.equal(azure.calls.length, 1);
  assert.equal(corp.manager.messageStatus((await pending).messageId as string)?.status, 'sent');
  await clock.advance(10_000); // timeout, reconnect after 1 s
  await clock.advance(1_000);
  assert.equal(wires.length, 2);
  assert.equal(wires[1]!.fromDialer.filter((f) => f.t === 'msg').length, 1, 'resent');
  assert.equal(azure.calls.length, 1, 'not run again');
  assert.equal(corp.manager.messageStatus((await pending).messageId as string)?.status, 'delivered');
});

test('FR-MCP-018 AC-5: a message never sent expires, one sent without a result becomes unknown; keys expire sooner', async () => {
  const clock = new FakeClock();
  const { corp } = pair(clock, {
    toolResult: (_tool, args) => (args.prompt === 'lost' ? new Promise<Rec>(() => {}) : { ok: true, status: 'delivered' }),
  });
  const keys = corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', keys: ['down'] }, scopes: ALL, hasKeys: true });
  await clock.advance(3_000);
  const text = corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 't' }, scopes: ALL, hasKeys: false });
  await clock.advance(3_000);
  assert.equal(corp.manager.messageStatus((await keys).messageId as string)?.status, 'expired');
  assert.equal(corp.manager.messageStatus((await text).messageId as string)?.status, 'queued');
  corp.manager.start();
  await clock.advance(0);
  assert.equal(corp.manager.messageStatus((await text).messageId as string)?.status, 'delivered');
  const lost = corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'lost' }, scopes: ALL, hasKeys: false });
  await clock.advance(3_000);
  assert.equal((await lost).status, 'queued');
  await clock.advance(57_000);
  assert.equal(corp.manager.messageStatus((await lost).messageId as string)?.status, 'unknown');
  assert.equal(statusOf(corp.manager, 'azure')?.queued, 0);
});

test('FR-MCP-018 AC-6: the queue holds at most maxQueuedMessages', async () => {
  const clock = new FakeClock();
  const { corp } = pair(clock, { dialer: { maxQueuedMessages: 2 } });
  const results = [1, 2, 3].map((n) => corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: `m${n}` }, scopes: ALL, hasKeys: false }));
  await clock.advance(3_000);
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map((r) => r.status ?? r.code), ['queued', 'queued', 'PEER_QUEUE_FULL']);
});

test('FR-MCP-018 AC-7: a refused message is failed and carries the remote result', async () => {
  const clock = new FakeClock();
  const { corp } = pair(clock, { toolResult: () => ({ ok: false, code: 'TARGET_NOT_FOUND' }) });
  corp.manager.start();
  await clock.advance(0);
  const result = await corp.manager.sendMessage({ peer: 'azure', args: { target: 'x', prompt: 'p' }, scopes: ALL, hasKeys: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'TARGET_NOT_FOUND');
});

test('FR-MCP-019 AC-4: peer.call returns the remote result, fails fast when disconnected, and times out after 30 s', async () => {
  const clock = new FakeClock();
  let hang = false;
  const { corp, azure } = pair(clock, {
    toolResult: (tool) => (hang ? new Promise<Rec>(() => {}) : { ok: true, tool }),
  });
  const offline = await corp.manager.call({ peer: 'azure', tool: 'buildergate.session.list', arguments: {}, scopes: ALL });
  assert.equal(offline.code, 'PEER_DISCONNECTED');
  assert.equal((await corp.manager.call({ peer: 'ghost', tool: 'x', arguments: {}, scopes: ALL })).code, 'PEER_NOT_FOUND');
  corp.manager.start();
  await clock.advance(0);
  const result = await corp.manager.call({ peer: 'azure', tool: 'buildergate.session.list', arguments: { includeSelf: true }, scopes: ALL });
  assert.deepEqual(result, { ok: true, tool: 'buildergate.session.list' });
  assert.deepEqual(azure.calls[0]!.args, { includeSelf: true });
  hang = true;
  const slow = corp.manager.call({ peer: 'azure', tool: 'buildergate.session.list', arguments: {}, scopes: ALL });
  await clock.advance(30_000);
  assert.equal((await slow).code, 'PEER_CALL_TIMEOUT');
});

test('FR-MCP-019 AC-5: the remote runs with the link scopes intersected with the caller scopes', async () => {
  const clock = new FakeClock();
  const { corp, azure } = pair(clock, { dialer: { inboundScopes: ['mcp:sessions.list'] } });
  corp.manager.start();
  await clock.advance(0);
  // corp -> azure: azure's link scopes come from the key (all three); the caller only has paste
  await corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'p' }, scopes: ['mcp:message.paste', 'mcp:terminals.exec'], hasKeys: false });
  assert.deepEqual(azure.calls[0]!.actor.scopes, ['mcp:message.paste']);
  // azure -> corp: corp's link scopes are its inboundScopes
  await azure.manager.call({ peer: 'corp', tool: 'buildergate.session.list', arguments: {}, scopes: ALL });
  assert.deepEqual(corp.calls[0]!.actor.scopes, ['mcp:sessions.list']);
});

test('FR-MCP-019 AC-6: a peer tool is refused when it arrives over a link', async () => {
  const clock = new FakeClock();
  const { corp, azure } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  const result = await corp.manager.call({ peer: 'azure', tool: 'buildergate.peer.call', arguments: {}, scopes: ALL });
  assert.equal(result.code, 'PEER_RELAY_REFUSED');
  assert.equal(azure.calls.length, 0);
});

test('FR-MCP-016 AC-6: a reconnect under the same name replaces the older connection on the acceptor', async () => {
  const clock = new FakeClock();
  const { corp, azure, wires } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  // a second dialer that claims the same node name
  const other = makeNode(clock, { name: 'corp', acceptor: () => azure, wires, settings: { links: [LINK] } });
  other.manager.start();
  await clock.advance(0);
  assert.equal(wires[0]!.open, false);
  assert.equal(azure.manager.list().filter((p) => p.name === 'corp').length, 1);
});

// ---- review round 1 (#233) ----

test('FR-MCP-018 AC-4: turning a link off and on again does not make later messages look like duplicates', async () => {
  const clock = new FakeClock();
  const { corp, azure } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  await corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'before' }, scopes: ALL, hasKeys: false });
  corp.manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [{ ...LINK, enabled: false }] });
  await clock.advance(0);
  corp.manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [LINK] });
  await clock.advance(0);
  const after = await corp.manager.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'after' }, scopes: ALL, hasKeys: false });
  assert.equal(after.status, 'delivered');
  assert.deepEqual(azure.calls.map((c) => c.args.prompt), ['before', 'after']);
});

test('FR-MCP-016: dropInbound closes the links remotes opened here, so they must authenticate again', async () => {
  const clock = new FakeClock();
  const { corp, azure, wires } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  azure.manager.dropInbound();
  await clock.advance(0);
  assert.equal(wires[0]!.open, false);
  await clock.advance(1_000);
  assert.equal(wires.length, 2);
  assert.equal(statusOf(azure.manager, 'corp')?.state, 'connected');
});

test('FR-MCP-019 AC-1: an inbound peer that is gone with nothing queued is forgotten', async () => {
  const clock = new FakeClock();
  const { corp, azure } = pair(clock);
  corp.manager.start();
  await clock.advance(0);
  assert.equal(azure.manager.hasPeer('corp'), true);
  corp.manager.stop();
  await clock.advance(0);
  assert.equal(azure.manager.hasPeer('corp'), false);
  assert.equal(statusOf(azure.manager, 'corp'), undefined);
});

test('FR-MCP-017 AC-4: a certificate fingerprint mismatch waits the longest before trying again', async () => {
  const clock = new FakeClock();
  let dials = 0;
  const manager = createPeerLinkManager({
    clock,
    random: () => 0.5,
    dial: (_link, handlers) => {
      dials += 1;
      setImmediate(() => handlers.onClose('PEER_TLS_FINGERPRINT_MISMATCH'));
      return { send: () => {}, close: () => {} };
    },
    authenticate: async () => ({ ok: false, code: 'x' }),
    callTool: async () => ({}),
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [LINK] });
  manager.start();
  await clock.advance(0);
  await clock.advance(29_999);
  assert.equal(dials, 1);
  await clock.advance(1);
  assert.equal(dials, 2);
  assert.equal(manager.list()[0]!.lastError, 'PEER_TLS_FINGERPRINT_MISMATCH');
});

test('FR-MCP-017 AC-1: a heartbeat interval below 1 s from the other side is raised to 1 s', async () => {
  const clock = new FakeClock();
  const azure = makeNode(clock, { name: 'azure' });
  const sent: Rec[] = [];
  const handlers = azure.manager.accept({ send: (t) => sent.push(JSON.parse(t)), close: () => {} }, {});
  handlers.onText(JSON.stringify({ t: 'hello', v: 1, node: 'corp', epoch: 'e', heartbeatMs: 1, key: 'good-key' }));
  await clock.advance(999);
  assert.equal(sent.filter((f) => f.t === 'hb').length, 0);
  await clock.advance(1);
  assert.equal(sent.filter((f) => f.t === 'hb').length, 1);
});

test('FR-MCP-020 AC-2: a link without a key (one that could not be decrypted) is not dialed', async () => {
  const clock = new FakeClock();
  const { corp, wires } = pair(clock, { dialer: { links: [{ ...LINK, accessKey: '' }] } });
  corp.manager.start();
  await clock.advance(60_000);
  assert.equal(wires.length, 0);
  assert.equal(statusOf(corp.manager, 'azure')?.lastError, 'PEER_KEY_MISSING');
});

test('FR-MSG-008/009: authenticate is told which node the hello came from, so a key can be bound to it', async () => {
  const clock = new FakeClock();
  const seen: Array<{ key: string; node: string }> = [];
  const azure = makeNode(clock, {
    name: 'azure',
    authenticate: async (key, _request, node) => {
      seen.push({ key, node });
      return { ok: true, scopes: ['mcp:room'] };
    },
  });
  const corp = makeNode(clock, { name: '김철수_대리', acceptor: () => azure, settings: { links: [LINK] } });
  corp.manager.start();
  await clock.advance(0);
  assert.deepEqual(seen, [{ key: 'good-key', node: '김철수_대리' }]);
  assert.equal(statusOf(azure.manager, '김철수_대리')?.state, 'connected');
});

test('FR-MSG-008 (contract 1): the dialer learns the name the remote calls itself when the link comes up', async () => {
  const clock = new FakeClock();
  const connected: Array<Record<string, unknown>> = [];
  const azure = makeNode(clock, { name: 'real-name' });
  const corp = makeNode(clock, {
    name: 'corp',
    acceptor: () => azure,
    settings: { links: [LINK] },
    onConnected: (info) => connected.push({ ...info }),
  });
  corp.manager.start();
  await clock.advance(0);
  assert.deepEqual(connected, [{ name: 'azure', direction: 'outbound', remoteNode: 'real-name' }]);
});

test('FR-MSG-008 AC-6 / FR-MSG-009 AC-4: dropPeer closes the connection of one peer and leaves the others', async () => {
  const clock = new FakeClock();
  const azure = makeNode(clock, { name: 'azure' });
  const corp = makeNode(clock, { name: 'corp', acceptor: () => azure, settings: { links: [LINK] } });
  const home = makeNode(clock, { name: 'home', acceptor: () => azure, settings: { links: [LINK] } });
  corp.manager.start();
  home.manager.start();
  await clock.advance(0);
  assert.equal(statusOf(azure.manager, 'corp')?.state, 'connected');
  azure.manager.dropPeer('corp');
  await clock.advance(0);
  assert.equal(statusOf(azure.manager, 'corp'), undefined);
  assert.equal(statusOf(azure.manager, 'home')?.state, 'connected');
});

test('review H2/M4: a room link gives the other side room scope only, and the actor carries the link scopes', async () => {
  const clock = new FakeClock();
  const azure = makeNode(clock, { name: 'azure' });
  const corp = makeNode(clock, { name: 'corp', acceptor: () => azure, settings: { links: [{ ...LINK, kind: 'room' }] } });
  corp.manager.start();
  await clock.advance(0);
  await azure.manager.call({ peer: 'corp', tool: 'buildergate.session.list', arguments: {}, scopes: ['mcp:sessions.list', 'mcp:room'] });
  assert.deepEqual(corp.calls[0]!.actor.scopes, ['mcp:room']);
  assert.deepEqual(corp.calls[0]!.actor.linkScopes, ['mcp:room']);
});
