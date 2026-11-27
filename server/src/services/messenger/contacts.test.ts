// FR-MSG-008, FR-MSG-009 (room links), FR-MSG-014 (contract §1, §7, §9): contacts, connection
// codes, the add-by-address request flow, room links and the LAN toggle, over in-memory fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMessengerKeys, CONTACT_SCOPES } from './keys.js';
import {
  checkContactName,
  createMessengerNet,
  decodeMessengerCode,
  type ContactHttp,
  type MessengerNet,
} from './contacts.js';
import { DEFAULT_PEER_LINK_SETTINGS, validatePeerLinkSettings, type PeerLinkSettings } from '../peer/peerLinkSettings.js';
import type { PeerStatus } from '../peer/peerLinkManager.js';
import { createLanReceiver, type LanProtocol } from './lanListener.js';

type Rec = Record<string, unknown>;
const FP_A = 'aa'.repeat(32);
const FP_B = 'bb'.repeat(32);

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'messenger-net-'));
}

interface Side {
  net: MessengerNet;
  settings: () => PeerLinkSettings;
  peers: PeerStatus[];
  dropped: string[];
  notes: string[];
  lanState: { receiving: boolean; port: number; busy: boolean; protocol: LanProtocol; allowList: string[] };
  keys: ReturnType<typeof createMessengerKeys>;
  clock: { t: number };
}

async function makeSide(name: string, opts: {
  http?: ContactHttp;
  fp?: string;
  redeemInvite?: (payload: Rec) => Promise<Rec>;
  clock?: { t: number };
  receiving?: boolean;
  protocol?: LanProtocol;
  dir?: string;
  /** Links saved before the test, e.g. one set up in the MCP panel. */
  links?: PeerLinkSettings['links'];
} = {}): Promise<Side> {
  const dir = opts.dir ?? await tempDir();
  const clock = opts.clock ?? { t: 0 };
  let current: PeerLinkSettings = { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: name, links: opts.links ?? [] };
  const peers: PeerStatus[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  // The HTTPS path is the default here so the certificate tests keep their subject; http has its own tests.
  const lanState = { receiving: opts.receiving ?? true, port: 3334, busy: false, protocol: opts.protocol ?? 'https' as LanProtocol, allowList: ['10.0.0.0/8'] };
  let n = 0;
  const keys = createMessengerKeys({ path: path.join(dir, 'keys.json'), now: () => clock.t, random: () => `${name}-key-${++n}` });
  const net = createMessengerNet({
    keys,
    peers: {
      nodeName: () => current.nodeName,
      list: () => peers,
      dropPeer: (peer) => { dropped.push(peer); },
    },
    peerSettings: {
      get: () => current,
      update: async (patch) => {
        const checked = validatePeerLinkSettings(patch, current);
        if (!checked.ok) return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: checked.fieldErrors };
        current = checked.settings;
        return { ok: true };
      },
    },
    lan: {
      status: () => ({ receiving: lanState.receiving, port: lanState.port, protocol: lanState.protocol, allowList: lanState.allowList }),
      set: async (input) => {
        const port = input.port ?? lanState.port;
        if (input.receiving && lanState.busy) return { ok: false, code: 'LAN_PORT_IN_USE', port };
        lanState.receiving = input.receiving;
        lanState.port = port;
        lanState.protocol = input.protocol ?? lanState.protocol;
        lanState.allowList = input.allowList ?? lanState.allowList;
        return { ok: true, receiving: lanState.receiving, port, protocol: lanState.protocol, allowList: lanState.allowList };
      },
    },
    certificateFingerprint: () => opts.fp ?? FP_A,
    lanAddresses: () => ['192.168.0.5', '10.1.2.3'],
    http: opts.http ?? (async () => ({ status: 0, body: {}, fingerprint: '' })),
    redeemInvite: opts.redeemInvite,
    notify: (reason) => { notes.push(reason); },
    dataPath: path.join(dir, 'contacts.json'),
    now: () => clock.t,
    random: (() => { let i = 0; return () => `${name}-r${++i}`; })(),
  });
  return { net, settings: () => current, peers, dropped, notes, lanState, keys, clock };
}

/**
 * Routes the requester's HTTP calls into the other side's contact-request handler, seen with `fp`
 * over https and with no certificate over http. `serves` limits the protocols the other side answers.
 */
function wireTo(target: () => Side, fp: { value: string }, serves: LanProtocol[] = ['http', 'https']): ContactHttp {
  return async (request) => {
    const url = new URL(request.url);
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    if (!serves.includes(protocol)) return { status: 0, body: {}, fingerprint: '' };
    const answer = await target().net.handleContactRequest({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: request.body,
      remoteAddress: '192.168.0.9',
    });
    return { ...answer, fingerprint: protocol === 'https' ? fp.value : '' };
  };
}

test('FR-MSG-008 AC-1: names with spaces, ::, @ or /, my own name and a taken name are refused with their own codes', () => {
  const context = { myName: 'alice', taken: ['Bob'] };
  assert.equal(checkContactName('김 철수', context), 'NAME_HAS_SPACE');
  assert.equal(checkContactName('a::b', context), 'NAME_INVALID_CHAR');
  assert.equal(checkContactName('a@b', context), 'NAME_INVALID_CHAR');
  assert.equal(checkContactName('a/b', context), 'NAME_INVALID_CHAR');
  assert.equal(checkContactName('a!b', context), 'NAME_INVALID_CHAR');
  assert.equal(checkContactName('', context), 'NAME_EMPTY');
  assert.equal(checkContactName('x'.repeat(33), context), 'NAME_TOO_LONG');
  assert.equal(checkContactName('ALICE', context), 'NAME_IS_SELF');
  assert.equal(checkContactName('bob', context), 'NAME_TAKEN');
  assert.equal(checkContactName('김철수_대리', context), null);
});

test('FR-MSG-008 AC-2: renaming me checks the name and changes the peer-link node name', async () => {
  const side = await makeSide('alice');
  assert.deepEqual(await side.net.renameMe('my name'), { ok: false, code: 'NAME_HAS_SPACE' });
  const renamed = await side.net.renameMe('홍길동_팀장');
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(side.settings().nodeName, '홍길동_팀장');
  assert.ok(side.notes.includes('me-renamed'));
});

test('FR-MSG-008 AC-4: a connection code carries my name, my LAN addresses, the certificate hash and a one-time token', async () => {
  const side = await makeSide('alice');
  const issued = side.net.connectionCode();
  assert.equal(issued.ok, true);
  assert.match(issued.code, /^bgc1\./u);
  const decoded = decodeMessengerCode(issued.code);
  assert.equal(decoded?.kind, 'contact');
  const payload = decoded!.payload;
  assert.equal(payload.name, 'alice');
  assert.deepEqual(payload.urls, ['wss://192.168.0.5:3334/mcp/peer', 'wss://10.1.2.3:3334/mcp/peer']);
  assert.equal(payload.fp, FP_A);
  assert.deepEqual(side.keys.authenticate(String(payload.token), 'bob'), { kind: 'contact', scopes: CONTACT_SCOPES });
  assert.deepEqual(side.net.connectInfo(), { urls: payload.urls, fp: FP_A });
});

test('FR-MSG-008 AC-4: redeeming a connection code adds a contact link with the token and pinned certificate, no acceptance needed', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  const redeemed = await bob.net.redeemCode(alice.net.connectionCode().code);
  assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
  assert.equal(redeemed.kind, 'contact');
  const link = bob.settings().links[0]!;
  assert.equal(link.name, 'alice');
  assert.equal(link.url, 'wss://192.168.0.5:3334/mcp/peer');
  assert.equal(link.tlsFingerprintSha256, FP_A);
  assert.equal(link.kind, 'contact', 'FR-MSG-008 AC-8 (M1): a messenger contact link is told apart from an MCP link');
  assert.deepEqual(alice.keys.authenticate(link.accessKey, 'bob'), { kind: 'contact', scopes: CONTACT_SCOPES });
  assert.deepEqual(bob.net.contactsView(), [{ name: 'alice', state: 'disconnected', address: '192.168.0.5:3334' }]);
  bob.peers.push({ name: 'alice', direction: 'outbound', state: 'connected', queued: 0 });
  assert.equal(bob.net.contactsView()[0]!.state, 'connected');
  assert.ok(bob.notes.includes('contact-added'));
});

test('FR-MSG-008 AC-4: a code from myself, a broken code and an invite code without a handler are refused', async () => {
  const alice = await makeSide('alice');
  assert.deepEqual(await alice.net.redeemCode(alice.net.connectionCode().code), { ok: false, code: 'NAME_IS_SELF' });
  assert.deepEqual(await alice.net.redeemCode('bgc1.???'), { ok: false, code: 'CODE_INVALID' });
  assert.deepEqual(await alice.net.redeemCode('hello'), { ok: false, code: 'CODE_INVALID' });
  const invite = `bgi1.${Buffer.from(JSON.stringify({ v: 1, ticket: { roomId: 'rm_a' }, invitedBy: 'bob' })).toString('base64url')}`;
  assert.deepEqual(await alice.net.redeemCode(invite), { ok: false, code: 'INVITE_UNSUPPORTED' });
  const withHook = await makeSide('carol', { redeemInvite: async (payload) => ({ ok: true, kind: 'invite', invite: { id: 'inv1', from: payload.invitedBy } }) });
  assert.deepEqual(await withHook.net.redeemCode(invite), { ok: true, kind: 'invite', invite: { id: 'inv1', from: 'bob' } });
});

test('FR-MSG-008 AC-3/AC-5: adding by address asks the other side, waits for acceptance, then links with the pinned certificate', async () => {
  const seen = { value: FP_B };
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, seen) });
  bob = await makeSide('bob', { fp: FP_B });
  const added = await alice.net.addContactByAddress({ name: 'bob', address: 'https://192.168.0.9:3333' });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(alice.net.contactsView(), [{ name: 'bob', state: 'requested', address: '192.168.0.9:3333' }]);
  const requests = bob.net.requestsView();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.fromNode, 'alice');
  assert.deepEqual(bob.net.contactsView(), [{ name: 'alice', state: 'pending-in' }]);
  assert.ok(bob.notes.includes('request-received'));

  await alice.net.tick();
  assert.equal(alice.settings().links.length, 0, 'nothing is linked before acceptance');

  assert.equal((await bob.net.acceptRequest(requests[0]!.id)).ok, true);
  assert.deepEqual(bob.net.requestsView(), []);
  await alice.net.tick();
  const link = alice.settings().links[0]!;
  assert.equal(link.name, 'bob');
  assert.equal(link.url, 'wss://192.168.0.9:3333/mcp/peer');
  assert.equal(link.tlsFingerprintSha256, FP_B);
  assert.deepEqual(bob.keys.authenticate(link.accessKey, 'alice'), { kind: 'contact', scopes: CONTACT_SCOPES });
  assert.deepEqual(alice.net.contactsView(), [{ name: 'bob', state: 'disconnected', address: '192.168.0.9:3333' }]);
  assert.deepEqual(bob.net.contactsView(), [{ name: 'alice', state: 'disconnected' }]);
});

test('FR-MSG-008 AC-3: a declined request goes away on the requester side', async () => {
  const seen = { value: FP_B };
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, seen) });
  bob = await makeSide('bob');
  await alice.net.addContactByAddress({ name: 'bob', address: '192.168.0.9' });
  await bob.net.declineRequest(bob.net.requestsView()[0]!.id);
  await alice.net.tick();
  assert.deepEqual(alice.net.contactsView(), []);
  assert.deepEqual(alice.settings().links, []);
});

test('FR-MSG-008 AC-5: a certificate that changes while waiting stops the request with TLS_FINGERPRINT_CHANGED', async () => {
  const seen = { value: FP_B };
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, seen) });
  bob = await makeSide('bob');
  await alice.net.addContactByAddress({ name: 'bob', address: 'https://192.168.0.9:3333' });
  await bob.net.acceptRequest(bob.net.requestsView()[0]!.id);
  seen.value = FP_A;
  await alice.net.tick();
  assert.deepEqual(alice.settings().links, []);
  assert.deepEqual(alice.net.contactsView(), [{ name: 'bob', state: 'requested', address: '192.168.0.9:3333', error: 'TLS_FINGERPRINT_CHANGED' }]);
});

test('FR-MSG-008 AC-5: a linked contact whose certificate changed shows TLS_FINGERPRINT_CHANGED', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  await bob.net.redeemCode(alice.net.connectionCode().code);
  bob.peers.push({ name: 'alice', direction: 'outbound', state: 'disconnected', queued: 0, lastError: 'PEER_TLS_FINGERPRINT_MISMATCH' });
  assert.equal(bob.net.contactsView()[0]!.error, 'TLS_FINGERPRINT_CHANGED');
});

test('FR-MSG-008 AC-3 (contract §7): an unreachable address answers ADDRESS_UNREACHABLE and a bad one ADDRESS_INVALID', async () => {
  const alice = await makeSide('alice');
  assert.deepEqual(await alice.net.addContactByAddress({ name: 'bob', address: '192.168.0.9:3333' }), { ok: false, code: 'ADDRESS_UNREACHABLE' });
  assert.deepEqual(await alice.net.addContactByAddress({ name: 'bob', address: 'not an address' }), { ok: false, code: 'ADDRESS_INVALID' });
  assert.deepEqual(await alice.net.addContactByAddress({ name: 'my bob', address: '192.168.0.9' }), { ok: false, code: 'NAME_HAS_SPACE' });
});

test('contract §7: at most 20 incoming requests wait; the oldest is dropped', async () => {
  const bob = await makeSide('bob');
  for (let i = 0; i < 21; i += 1) {
    bob.clock.t = i;
    const answer = await bob.net.handleContactRequest({ method: 'POST', path: '/mcp/contact-request', query: {}, body: { fromNode: `n${i}`, secret: `secret-value-${i}-xxxxxxxx` }, remoteAddress: `10.0.0.${i}` });
    assert.equal(answer.status, 200);
  }
  const nodes = bob.net.requestsView().map((request) => request.fromNode);
  assert.equal(nodes.length, 20);
  assert.equal(nodes.includes('n0'), false);
  assert.equal(nodes.includes('n20'), true);
});

test('contract §7: a request with a bad name or secret is refused, and polling needs the right secret', async () => {
  const bob = await makeSide('bob');
  const bad = await bob.net.handleContactRequest({ method: 'POST', path: '/mcp/contact-request', query: {}, body: { fromNode: 'a b', secret: 'x'.repeat(20) }, remoteAddress: '' });
  assert.equal(bad.status, 400);
  const made = await bob.net.handleContactRequest({ method: 'POST', path: '/mcp/contact-request', query: {}, body: { fromNode: 'alice', secret: 's'.repeat(20) }, remoteAddress: '' });
  const id = String((made.body as Rec).id);
  const wrong = await bob.net.handleContactRequest({ method: 'GET', path: `/mcp/contact-request/${id}`, query: { secret: 'z'.repeat(20) }, body: undefined, remoteAddress: '' });
  assert.equal(wrong.status, 404);
  const right = await bob.net.handleContactRequest({ method: 'GET', path: `/mcp/contact-request/${id}`, query: { secret: 's'.repeat(20) }, body: undefined, remoteAddress: '' });
  assert.deepEqual(right, { status: 200, body: { ok: true, state: 'pending', name: 'bob' } });
});

test('contract §1: a link that turns out to have another name is renamed to the remote\'s own name', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  await bob.net.redeemCode(alice.net.connectionCode().code);
  bob.net.onPeerConnected({ name: 'alice', direction: 'outbound', remoteNode: 'alice_kim' });
  await bob.net.whenIdle();
  assert.equal(bob.settings().links[0]!.name, 'alice_kim');
  assert.ok(bob.notes.includes('contact-renamed'));
  // Same name: nothing happens.
  bob.notes.length = 0;
  bob.net.onPeerConnected({ name: 'alice_kim', direction: 'outbound', remoteNode: 'alice_kim' });
  await bob.net.whenIdle();
  assert.deepEqual(bob.notes, []);
});

test('FR-MSG-008 AC-6: removing a contact removes its link, revokes the key I gave it and drops its connection', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  const code = alice.net.connectionCode().code;
  await bob.net.redeemCode(code);
  const key = bob.settings().links[0]!.accessKey;
  alice.keys.authenticate(key, 'bob');
  assert.deepEqual(alice.net.contactsView(), [{ name: 'bob', state: 'disconnected' }]);
  assert.deepEqual(await alice.net.removeContact('bob'), { ok: true });
  assert.equal(alice.keys.authenticate(key, 'bob'), null);
  assert.deepEqual(alice.dropped, ['bob']);
  assert.deepEqual(alice.net.contactsView(), []);
  assert.deepEqual(await bob.net.removeContact('alice'), { ok: true });
  assert.deepEqual(bob.settings().links, []);
  assert.deepEqual(await bob.net.removeContact('nobody'), { ok: false, code: 'CONTACT_NOT_FOUND' });
});

test('FR-MSG-009: a room link is kept out of the contact list and is not a contact', async () => {
  const bob = await makeSide('bob');
  await bob.net.ensureRoomLink({ hostNode: 'host1', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 'ticket-1' });
  const link = bob.settings().links[0]!;
  assert.equal(link.kind, 'room');
  assert.equal(link.accessKey, 'ticket-1');
  assert.deepEqual(bob.net.contactsView(), []);
  assert.equal(bob.net.isContact('host1'), false);
  // A newer ticket replaces the key.
  await bob.net.ensureRoomLink({ hostNode: 'host1', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 'ticket-2' });
  assert.equal(bob.settings().links.length, 1);
  assert.equal(bob.settings().links[0]!.accessKey, 'ticket-2');
  await bob.net.dropRoomLink('host1');
  assert.deepEqual(bob.settings().links, []);
});

test('FR-MSG-009: a room link to someone who is already a contact changes nothing', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  await bob.net.redeemCode(alice.net.connectionCode().code);
  const before = JSON.stringify(bob.settings().links);
  await bob.net.ensureRoomLink({ hostNode: 'alice', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 'ticket-1' });
  assert.equal(JSON.stringify(bob.settings().links), before);
  assert.equal(bob.net.isContact('alice'), true);
  await bob.net.dropRoomLink('alice');
  assert.equal(bob.settings().links.length, 1, 'dropRoomLink leaves a contact link alone');
});

test('FR-MSG-008 AC-4 (contract §7): a link that does not come up moves to the next address of its code', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  await bob.net.redeemCode(alice.net.connectionCode().code);
  bob.peers.push({ name: 'alice', direction: 'outbound', state: 'connecting', queued: 0 });
  bob.clock.t = 5_000;
  await bob.net.tick();
  assert.equal(bob.settings().links[0]!.url, 'wss://192.168.0.5:3334/mcp/peer');
  bob.clock.t = 20_000;
  await bob.net.tick();
  assert.equal(bob.settings().links[0]!.url, 'wss://10.1.2.3:3334/mcp/peer');
  bob.peers[0]!.state = 'connected';
  bob.clock.t = 60_000;
  await bob.net.tick();
  assert.equal(bob.settings().links[0]!.url, 'wss://10.1.2.3:3334/mcp/peer');
});

test('FR-MSG-014: the LAN toggle goes to the dedicated listener and reports its port; the MCP config is not touched', async () => {
  const side = await makeSide('alice', { receiving: false });
  const rest = { protocol: 'https', allowList: ['10.0.0.0/8'] };
  assert.deepEqual(await side.net.lan(), { ok: true, receiving: false, port: 3334, ...rest });
  assert.deepEqual(await side.net.setLan({ receiving: true, port: 4000 }), { ok: true, receiving: true, port: 4000, ...rest });
  assert.deepEqual(await side.net.lan(), { ok: true, receiving: true, port: 4000, ...rest });
  assert.ok(side.notes.includes('lan-changed'));
  assert.deepEqual(await side.net.setLan({ receiving: false }), { ok: true, receiving: false, port: 4000, ...rest });
});

test('FR-MSG-014: a busy port answers LAN_PORT_IN_USE with the port', async () => {
  const side = await makeSide('alice', { receiving: false });
  side.lanState.busy = true;
  assert.deepEqual(await side.net.setLan({ receiving: true }), { ok: false, code: 'LAN_PORT_IN_USE', port: 3334 });
});

test('FR-MSG-014: without a server certificate LAN receiving answers LAN_TLS_UNAVAILABLE and changes nothing', async () => {
  const side = await makeSide('alice', { fp: '', receiving: false });
  assert.deepEqual(await side.net.setLan({ receiving: true }), { ok: false, code: 'LAN_TLS_UNAVAILABLE', reason: 'NO_SERVER_CERTIFICATE' });
  assert.equal(side.lanState.receiving, false);
});

test('FR-MSG-014 AC-3: over http receiving turns on without a certificate; choosing https still needs one', async () => {
  const side = await makeSide('alice', { fp: '', receiving: false, protocol: 'http' });
  const on = await side.net.setLan({ receiving: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(side.lanState.receiving, true);
  assert.deepEqual(await side.net.setLan({ receiving: true, protocol: 'https' }), { ok: false, code: 'LAN_TLS_UNAVAILABLE', reason: 'NO_SERVER_CERTIFICATE' });
  assert.equal(side.lanState.protocol, 'http');
});

test('FR-MSG-014 AC-4: the allow list goes to the listener with the rest of the LAN settings', async () => {
  const side = await makeSide('alice', { protocol: 'http' });
  const saved = await side.net.setLan({ receiving: true, allowList: ['*'] });
  assert.equal(saved.ok, true);
  assert.deepEqual(side.lanState.allowList, ['*']);
  assert.deepEqual((await side.net.lan()).allowList, ['*']);
});

test('FR-MSG-008 AC-4, FR-MSG-009 AC-1: over http the addresses handed out are ws:// and carry no certificate hash', async () => {
  const alice = await makeSide('alice', { protocol: 'http' });
  assert.deepEqual(alice.net.connectInfo(), { urls: ['ws://192.168.0.5:3334/mcp/peer', 'ws://10.1.2.3:3334/mcp/peer'], fp: '' });
  const payload = decodeMessengerCode(alice.net.connectionCode().code)!.payload;
  assert.deepEqual(payload.urls, ['ws://192.168.0.5:3334/mcp/peer', 'ws://10.1.2.3:3334/mcp/peer']);
  assert.equal(payload.fp, '');
  const bob = await makeSide('bob', { protocol: 'http' });
  assert.equal((await bob.net.redeemCode(alice.net.connectionCode().code)).ok, true);
  const link = bob.settings().links[0]!;
  assert.equal(link.url, 'ws://192.168.0.5:3334/mcp/peer');
  assert.equal(link.tlsFingerprintSha256, undefined);
});

test('FR-MSG-008 AC-7: an address without a scheme tries http first and links over ws:// with no certificate pinned', async () => {
  const seen = { value: FP_B };
  const urls: string[] = [];
  let bob: Side;
  const wired = wireTo(() => bob, seen);
  const alice = await makeSide('alice', { http: async (request) => { urls.push(request.url); return wired(request); } });
  bob = await makeSide('bob', { protocol: 'http' });
  assert.equal((await alice.net.addContactByAddress({ name: 'bob', address: '192.168.0.9:3334' })).ok, true);
  await bob.net.acceptRequest(bob.net.requestsView()[0]!.id);
  await alice.net.tick();
  assert.match(urls[0]!, /^http:\/\/192\.168\.0\.9:3334\/mcp\/contact-request$/u);
  assert.ok(urls.every((url) => url.startsWith('http://')), urls.join(','));
  const link = alice.settings().links[0]!;
  assert.equal(link.url, 'ws://192.168.0.9:3334/mcp/peer');
  assert.equal(link.tlsFingerprintSha256, undefined);
});

test('FR-MSG-008 AC-7: an address without a scheme falls back to https when http does not answer, and pins the certificate', async () => {
  const seen = { value: FP_B };
  const urls: string[] = [];
  let bob: Side;
  const wired = wireTo(() => bob, seen, ['https']);
  const alice = await makeSide('alice', { http: async (request) => { urls.push(request.url); return wired(request); } });
  bob = await makeSide('bob', { fp: FP_B });
  assert.equal((await alice.net.addContactByAddress({ name: 'bob', address: '192.168.0.9:3334' })).ok, true);
  assert.deepEqual(urls, ['http://192.168.0.9:3334/mcp/contact-request', 'https://192.168.0.9:3334/mcp/contact-request']);
  await bob.net.acceptRequest(bob.net.requestsView()[0]!.id);
  await alice.net.tick();
  const link = alice.settings().links[0]!;
  assert.equal(link.url, 'wss://192.168.0.9:3334/mcp/peer');
  assert.equal(link.tlsFingerprintSha256, FP_B);
});

test('FR-MSG-008 AC-7: a scheme written in the address is the only one tried', async () => {
  const urls: string[] = [];
  const alice = await makeSide('alice', { http: async (request) => { urls.push(request.url); return { status: 0, body: {}, fingerprint: '' }; } });
  await alice.net.addContactByAddress({ name: 'bob', address: 'http://192.168.0.9:3334' });
  await alice.net.addContactByAddress({ name: 'bob', address: 'https://192.168.0.9:3334' });
  assert.deepEqual(urls, ['http://192.168.0.9:3334/mcp/contact-request', 'https://192.168.0.9:3334/mcp/contact-request']);
});

test('FR-MSG-014: with receiving off there are no addresses to hand out, and a connection code answers LAN_OFF', async () => {
  const side = await makeSide('alice', { receiving: false });
  assert.deepEqual(side.net.connectInfo(), { urls: [], fp: FP_A });
  assert.deepEqual(side.net.connectionCode(), { ok: false, code: 'LAN_OFF' });
});

test('contract §7: the rooms side can attach the invite redeemer after creation', async () => {
  const side = await makeSide('alice');
  const invite = `bgi1.${Buffer.from(JSON.stringify({ v: 1, ticket: { roomId: 'rm_a' }, invitedBy: 'bob' })).toString('base64url')}`;
  side.net.setInviteRedeemer(async () => ({ kind: 'invite', invite: { id: 'inv9' } }));
  assert.deepEqual(await side.net.redeemCode(invite), { ok: true, kind: 'invite', invite: { id: 'inv9' } });
});

async function postRequest(side: Side, fromNode: string, secret: string, remoteAddress = '10.0.0.1') {
  return side.net.handleContactRequest({ method: 'POST', path: '/mcp/contact-request', query: {}, body: { fromNode, secret }, remoteAddress });
}

async function poll(side: Side, id: string, secret: string) {
  return side.net.handleContactRequest({ method: 'GET', path: `/mcp/contact-request/${id}`, query: { secret }, body: undefined, remoteAddress: '' });
}

test('review M1: an accepted request hands out its key once, and removing the contact leaves nothing to poll', async () => {
  const bob = await makeSide('bob');
  const made = await postRequest(bob, 'alice', 'secret-1234');
  const id = String((made.body as Rec).id);
  await bob.net.acceptRequest(id);
  const first = await poll(bob, id, 'secret-1234');
  assert.equal((first.body as Rec).state, 'accepted');
  assert.equal((await poll(bob, id, 'secret-1234')).status, 404);
  await bob.net.removeContact('alice');
  assert.equal(bob.keys.authenticate(String((first.body as Rec).key), 'alice'), null);
});

test('review M1: removing a contact also drops its waiting requests', async () => {
  const bob = await makeSide('bob');
  await postRequest(bob, 'alice', 'secret-1234');
  assert.deepEqual(await bob.net.removeContact('alice'), { ok: true });
  assert.deepEqual(bob.net.requestsView(), []);
});

test('review M2: a second request from the same name while one waits answers 409, and one address may hold 3 at most', async () => {
  const bob = await makeSide('bob');
  assert.equal((await postRequest(bob, 'alice', 'secret-1234')).status, 200);
  assert.equal((await postRequest(bob, 'alice', 'other-secret')).status, 409);
  assert.equal((await postRequest(bob, 'n1', 'secret-1234', '10.9.9.9')).status, 200);
  assert.equal((await postRequest(bob, 'n2', 'secret-1234', '10.9.9.9')).status, 200);
  assert.equal((await postRequest(bob, 'n3', 'secret-1234', '10.9.9.9')).status, 200);
  assert.equal((await postRequest(bob, 'n4', 'secret-1234', '10.9.9.9')).status, 429);
});

test('review H1: a request from a name that is already my contact is refused', async () => {
  const bob = await makeSide('bob');
  bob.keys.issueContactKey('alice');
  const answer = await postRequest(bob, 'alice', 'secret-1234');
  assert.equal(answer.status, 409);
  assert.equal((answer.body as Rec).code, 'NAME_TAKEN');
});

test('review L4: a malformed id answers 404, not an error', async () => {
  const bob = await makeSide('bob');
  assert.equal((await poll(bob, '%E0%A4%A', 'x')).status, 404);
});

test('review L2: a request that failed is still dropped after 24 hours', async () => {
  const seen = { value: FP_B };
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, seen) });
  bob = await makeSide('bob');
  await alice.net.addContactByAddress({ name: 'bob', address: 'https://192.168.0.9:3333' });
  seen.value = FP_A;
  await alice.net.tick();
  assert.equal(alice.net.contactsView()[0]!.error, 'TLS_FINGERPRINT_CHANGED');
  alice.clock.t = 24 * 3_600_000 + 1;
  await alice.net.tick();
  assert.deepEqual(alice.net.contactsView(), []);
});

test('FR-MSG-008 AC-8 (supersedes review L3): adding by address someone I hold a room link to turns that link into a contact link', async () => {
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, { value: FP_B }) });
  bob = await makeSide('bob', { protocol: 'http' });
  await alice.net.ensureRoomLink({ hostNode: 'bob', urls: ['ws://192.168.0.9:3334/mcp/peer'], fp: '', token: 'ticket-1' });
  const added = await alice.net.addContactByAddress({ name: 'BOB', address: '192.168.0.9:3334' });
  assert.equal(added.ok, true, JSON.stringify(added));
  await bob.net.acceptRequest(bob.net.requestsView()[0]!.id);
  await alice.net.tick();
  await alice.net.whenIdle();
  const links = alice.settings().links;
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.notEqual(links[0]!.kind, 'room');
  assert.notEqual(links[0]!.accessKey, 'ticket-1');
  assert.equal(alice.net.isContact('bob'), true);
});

test('review H4 / FR-MSG-008 AC-2: my name cannot change while a contact link, contact key or room link exists', async () => {
  const alice = await makeSide('alice');
  alice.keys.issueContactKey('bob');
  assert.deepEqual(await alice.net.renameMe('alice2'), { ok: false, code: 'NAME_HAS_CONTACTS' });
  await alice.net.removeContact('bob');
  const bob = await makeSide('bob');
  await alice.net.redeemCode(bob.net.connectionCode().code);
  assert.deepEqual(await alice.net.renameMe('alice2'), { ok: false, code: 'NAME_HAS_CONTACTS' });
  await alice.net.removeContact('bob');
  // A room host binds my room key to my name too.
  await alice.net.ensureRoomLink({ hostNode: 'host1', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 't' });
  assert.deepEqual(await alice.net.renameMe('alice2'), { ok: false, code: 'NAME_HAS_CONTACTS' });
  await alice.net.dropRoomLink('host1');
  assert.equal((await alice.net.renameMe('alice2')).ok, true);
});

test('FR-MSG-014: an address without a port goes to the default LAN port (MCP port + 1)', async () => {
  const urls: string[] = [];
  const alice = await makeSide('alice', { http: async (request) => { urls.push(request.url); return { status: 0, body: {}, fingerprint: '' }; } });
  await alice.net.addContactByAddress({ name: 'bob', address: '192.168.0.9' });
  assert.deepEqual(urls, ['http://192.168.0.9:3334/mcp/contact-request', 'https://192.168.0.9:3334/mcp/contact-request']);
});

test('FR-MSG-008: a contact shows when its link was last up, and that survives a restart', async () => {
  const dir = await tempDir();
  const clock = { t: 1_000 };
  const bob = await makeSide('bob', { dir, clock });
  bob.keys.issueContactKey('alice');
  assert.equal(bob.net.contactsView()[0]!.lastSeen, undefined);
  bob.net.onPeerConnected({ name: 'alice', direction: 'inbound', remoteNode: 'alice' });
  await bob.net.whenIdle();
  assert.equal(bob.net.contactsView()[0]!.lastSeen, new Date(1_000).toISOString());

  // While it stays up, the time moves on (saved at most once a minute).
  bob.peers.push({ name: 'alice', direction: 'inbound', state: 'connected', queued: 0 });
  clock.t = 30_000;
  await bob.net.tick();
  assert.equal(bob.net.contactsView()[0]!.lastSeen, new Date(1_000).toISOString());
  clock.t = 61_000;
  await bob.net.tick();
  assert.equal(bob.net.contactsView()[0]!.lastSeen, new Date(61_000).toISOString());
  await bob.net.whenIdle();

  const restarted = await makeSide('bob', { dir, clock });
  assert.equal(restarted.net.contactsView()[0]!.lastSeen, new Date(61_000).toISOString());
});

test('FR-MSG-008: lastSeen follows a link renamed to the remote\'s name, and goes with a removed contact', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  bob.clock.t = 5_000;
  await bob.net.redeemCode(alice.net.connectionCode().code);
  bob.net.onPeerConnected({ name: 'alice', direction: 'outbound', remoteNode: 'alice_kim' });
  await bob.net.whenIdle();
  assert.deepEqual(bob.net.contactsView().map((contact) => [contact.name, contact.lastSeen]), [['alice_kim', new Date(5_000).toISOString()]]);
  await bob.net.removeContact('alice_kim');
  await bob.net.redeemCode(alice.net.connectionCode().code);
  assert.equal(bob.net.contactsView()[0]!.lastSeen, undefined);
});

test('FR-MSG-008 AC-7: the https retry sends a fresh secret, not the one that went out in the clear over http', async () => {
  const secrets: unknown[] = [];
  const alice = await makeSide('alice', { http: async (request) => { secrets.push((request.body as { secret?: unknown } | undefined)?.secret); return { status: 0, body: {}, fingerprint: '' }; } });
  await alice.net.addContactByAddress({ name: 'bob', address: '192.168.0.9:3334' });
  assert.equal(secrets.length, 2);
  assert.notEqual(secrets[0], secrets[1]);
});

// ---- FR-MSG-008 AC-8 (#267): one link per remote server ----

test('FR-MSG-008 AC-8: redeeming the code of someone I hold a room link to turns that link into a contact link', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  await bob.net.ensureRoomLink({ hostNode: 'alice', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 'ticket-1' });
  assert.equal((await bob.net.redeemCode(alice.net.connectionCode().code)).ok, true);
  const links = bob.settings().links;
  assert.equal(links.length, 1);
  assert.notEqual(links[0]!.kind, 'room');
  assert.notEqual(links[0]!.accessKey, 'ticket-1');
  assert.equal(bob.net.isContact('alice'), true);
  assert.deepEqual(bob.net.contactsView().map((contact) => contact.name), ['alice']);
});

test('FR-MSG-008 AC-8: accepting the request of someone I hold a room link to keeps one link, does not give the room key contact scope, and shows them as a connected contact', async () => {
  const alice = await makeSide('alice');
  await alice.net.ensureRoomLink({ hostNode: 'bob', urls: ['ws://10.0.0.7:3334/mcp/peer'], fp: '', token: 'ticket-1' });
  const answer = await postRequest(alice, 'bob', 'secret-1234', '10.0.0.7');
  assert.equal(answer.status, 200);
  assert.equal((await alice.net.acceptRequest((answer.body as Rec).id as string)).ok, true);
  assert.equal((await poll(alice, (answer.body as Rec).id as string, 'secret-1234')).status, 200, 'bob collects its contact key');
  await alice.net.whenIdle();
  const links = alice.settings().links;
  assert.equal(links.length, 1);
  assert.equal(links[0]!.kind, 'room', 'the link still holds a room ticket, so it keeps room scope until a contact key arrives');
  // My room link to bob is up: bob is shown connected.
  alice.peers.push({ name: 'bob', direction: 'outbound', state: 'connected', queued: 0 });
  assert.deepEqual(alice.net.contactsView().map((contact) => [contact.name, contact.state]), [['bob', 'connected']]);
});

test('FR-MSG-008 AC-8: a contact link renamed to the remote\'s own name merges with my room link of that name to the same server', async () => {
  const alice = await makeSide('alice');
  const bobOld = await makeSide('bob-pc', { protocol: 'http' });
  // The code's addresses are 192.168.0.5 and 10.1.2.3; the room ticket named the second one.
  await alice.net.redeemCode(bobOld.net.connectionCode().code);
  await alice.net.ensureRoomLink({ hostNode: 'bob', urls: ['ws://10.1.2.3:3334/mcp/peer'], fp: '', token: 'ticket-1' });
  assert.equal(alice.settings().links.length, 2);
  const contactLink = alice.settings().links.find((link) => link.name === 'bob-pc')!;
  alice.net.onPeerConnected({ name: 'bob-pc', direction: 'outbound', remoteNode: 'bob' });
  await alice.net.whenIdle();
  const links = alice.settings().links;
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.equal(links[0]!.name, 'bob');
  assert.equal(links[0]!.url, contactLink.url);
  assert.equal(links[0]!.accessKey, contactLink.accessKey);
  assert.notEqual(links[0]!.kind, 'room');
  assert.equal(alice.net.isContact('bob'), true);
});

test('FR-MSG-008 AC-8: a contact link is not merged into another contact link that already has the remote\'s name', async () => {
  const alice = await makeSide('alice');
  const bob = await makeSide('bob');
  const carol = await makeSide('carol');
  await bob.net.redeemCode(alice.net.connectionCode().code);
  await bob.net.redeemCode(carol.net.connectionCode().code);
  bob.net.onPeerConnected({ name: 'carol', direction: 'outbound', remoteNode: 'alice' });
  await bob.net.whenIdle();
  assert.deepEqual(bob.settings().links.map((link) => link.name), ['alice', 'carol']);
});

test('FR-MSG-014 AC-6: while the listener failed to open there are no addresses to hand out, and a connection code answers LAN_OFF', async () => {
  const dir = await tempDir();
  const lanPath = path.join(dir, 'lan.json');
  await fs.writeFile(lanPath, JSON.stringify({ version: 1, receiving: true, port: 3334, protocol: 'http', allowList: ['10.0.0.0/8'] }));
  const lan = createLanReceiver({
    path: lanPath,
    defaultPort: 3334,
    open: async () => ({ ok: false, code: 'LAN_PORT_IN_USE' }),
    timer: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  await lan.startFromSaved();
  const net = createMessengerNet({
    keys: createMessengerKeys({ path: path.join(dir, 'keys.json') }),
    peers: { nodeName: () => 'alice', list: () => [], dropPeer: () => {} },
    peerSettings: { get: () => ({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'alice' }), update: async () => ({ ok: true }) },
    lan,
    certificateFingerprint: () => '',
    lanAddresses: () => ['192.168.0.5'],
    http: async () => ({ status: 0, body: {}, fingerprint: '' }),
    dataPath: path.join(dir, 'contacts.json'),
  });
  assert.deepEqual(net.connectInfo().urls, []);
  assert.deepEqual(net.connectionCode(), { ok: false, code: 'LAN_OFF' });
  assert.equal((await net.lan()).error, 'LAN_PORT_IN_USE');
});

// ---- second review round (#267): same server only, real names ----

test('FR-MSG-008 AC-8 (P4): a contact added by address is named by the remote\'s own name once it accepts', async () => {
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, { value: FP_B }) });
  bob = await makeSide('bob', { protocol: 'http' });
  await alice.net.addContactByAddress({ name: 'bobby', address: '192.168.0.9:3334' });
  await bob.net.acceptRequest(bob.net.requestsView()[0]!.id);
  await alice.net.tick();
  await alice.net.whenIdle();
  assert.deepEqual(alice.settings().links.map((link) => link.name), ['bob']);
  assert.deepEqual(alice.net.contactsView().map((contact) => contact.name), ['bob']);
});

test('FR-MSG-008 AC-8 (M1): the remote\'s name is not taken from a room link to another server; the typed name stays', async () => {
  let bob: Side;
  const alice = await makeSide('alice', { http: wireTo(() => bob, { value: FP_B }) });
  bob = await makeSide('bob', { protocol: 'http' });
  await alice.net.ensureRoomLink({ hostNode: 'bob', urls: ['ws://10.0.0.7:3334/mcp/peer'], fp: '', token: 'ticket-1' });
  await alice.net.addContactByAddress({ name: 'bobby', address: '192.168.0.9:3334' });
  await bob.net.acceptRequest(bob.net.requestsView()[0]!.id);
  await alice.net.tick();
  await alice.net.whenIdle();
  assert.deepEqual(alice.settings().links.map((link) => [link.name, link.kind]), [['bob', 'room'], ['bobby', 'contact']]);
});

test('FR-MSG-008 AC-8 (M1): a typed name equal to a room link to another server is NAME_TAKEN', async () => {
  const alice = await makeSide('alice');
  await alice.net.ensureRoomLink({ hostNode: 'host1', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 't' });
  assert.deepEqual(await alice.net.addContactByAddress({ name: 'HOST1', address: '10.0.0.8' }), { ok: false, code: 'NAME_TAKEN' });
});

test('FR-MSG-008 AC-8 (M1): a connection code does not replace a room link of the same name to another server', async () => {
  const alice = await makeSide('alice', { fp: FP_B });
  const bob = await makeSide('bob');
  await bob.net.ensureRoomLink({ hostNode: 'alice', urls: ['wss://10.0.0.7:3333/mcp/peer'], fp: FP_A, token: 'ticket-1' });
  assert.deepEqual(await bob.net.redeemCode(alice.net.connectionCode().code), { ok: false, code: 'NAME_TAKEN' });
  assert.deepEqual(bob.settings().links.map((link) => [link.name, link.accessKey]), [['alice', 'ticket-1']]);
});

test('FR-MSG-008 AC-8 (M1): no merge with a room link to another server, and an MCP link without a messenger kind is never merged', async () => {
  const alice = await makeSide('alice');
  const bobOld = await makeSide('bob-pc');
  await alice.net.redeemCode(bobOld.net.connectionCode().code);
  await alice.net.ensureRoomLink({ hostNode: 'bob', urls: ['wss://10.0.0.99:3334/mcp/peer'], fp: FP_B, token: 'ticket-1' });
  alice.net.onPeerConnected({ name: 'bob-pc', direction: 'outbound', remoteNode: 'bob' });
  await alice.net.whenIdle();
  assert.deepEqual(alice.settings().links.map((link) => link.name), ['bob-pc', 'bob']);

  // An MCP-configured link (no messenger kind) to the very server of a room link.
  const carol = await makeSide('carol', { links: [{ name: 'dave-mcp', url: 'wss://10.0.0.7:3334/mcp/peer', accessKey: 'fixed', enabled: true }] });
  await carol.net.ensureRoomLink({ hostNode: 'dave', urls: ['wss://10.0.0.7:3334/mcp/peer'], fp: FP_A, token: 'ticket-2' });
  carol.net.onPeerConnected({ name: 'dave-mcp', direction: 'outbound', remoteNode: 'dave' });
  await carol.net.whenIdle();
  assert.deepEqual(carol.settings().links.map((link) => [link.name, link.kind]), [['dave-mcp', undefined], ['dave', 'room']]);
});

// ---- third review round (#267): a remote never names a link after someone else ----

async function holdContactKey(side: Side, node: string) {
  const request = await postRequest(side, node, 'secret-1234', '10.0.0.5');
  const id = String((request.body as Rec).id);
  await side.net.acceptRequest(id);
  await poll(side, id, 'secret-1234');
}

test('FR-MSG-008 AC-8 (H1): a server added by address that calls itself after an existing contact keeps the typed name', async () => {
  let mallory: Side;
  const alice = await makeSide('alice', { http: wireTo(() => mallory, { value: FP_B }) });
  await holdContactKey(alice, 'carol');
  mallory = await makeSide('carol', { protocol: 'http' });
  assert.equal((await alice.net.addContactByAddress({ name: 'mallory', address: '192.168.0.66:3334' })).ok, true);
  await mallory.net.acceptRequest(mallory.net.requestsView()[0]!.id);
  await alice.net.tick();
  await alice.net.whenIdle();
  assert.deepEqual(alice.settings().links.map((link) => link.name), ['mallory']);
});

test('FR-MSG-008 AC-8 (H1): a link is not renamed on connection after an existing contact', async () => {
  const alice = await makeSide('alice');
  await holdContactKey(alice, 'carol');
  await alice.net.redeemCode((await makeSide('bob')).net.connectionCode().code);
  alice.net.onPeerConnected({ name: 'bob', direction: 'outbound', remoteNode: 'carol' });
  await alice.net.whenIdle();
  assert.deepEqual(alice.settings().links.map((link) => link.name), ['bob']);
});

test('FR-MSG-008 AC-8 (M2): a link set up in the MCP panel keeps having no messenger kind when renamed on connection', async () => {
  const carol = await makeSide('carol', { links: [{ name: 'dave-mcp', url: 'wss://10.0.0.7:3334/mcp/peer', accessKey: 'fixed', enabled: true }] });
  carol.net.onPeerConnected({ name: 'dave-mcp', direction: 'outbound', remoteNode: 'dave' });
  await carol.net.whenIdle();
  assert.deepEqual(carol.settings().links.map((link) => [link.name, link.kind]), [['dave', undefined]]);
});
