// FR-MSG-008 AC-4/AC-6, FR-MSG-009 AC-1/AC-2/AC-4: the messenger key store -- pairing tokens that
// turn into contact keys, room tickets that turn into room keys, revocation, and the guard that
// keeps a room-key link to room tools.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONTACT_SCOPES,
  ROOM_SCOPES,
  createMessengerKeys,
  guardMessengerPeerCall,
} from './keys.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'messenger-keys-'));
  return path.join(dir, 'messenger', 'keys.json');
}

function counter() {
  let n = 0;
  return () => `token-${++n}`;
}

async function makeKeys(start = 0) {
  const clock = { t: start };
  const keysPath = await tempPath();
  const keys = createMessengerKeys({ path: keysPath, now: () => clock.t, random: counter() });
  return { keys, clock, keysPath };
}

test('FR-MSG-008 AC-4: a pairing token used once becomes a contact key bound to the node that used it', async () => {
  const { keys } = await makeKeys();
  const { token, expiresAt } = keys.issuePairingToken();
  assert.equal(expiresAt, new Date(DAY).toISOString());
  assert.deepEqual(keys.authenticate(token, 'corp'), { kind: 'contact', scopes: CONTACT_SCOPES });
  // The same value keeps working for that node only.
  assert.deepEqual(keys.authenticate(token, 'CORP'), { kind: 'contact', scopes: CONTACT_SCOPES });
  assert.equal(keys.authenticate(token, 'home'), null);
  assert.equal(keys.allowedRooms('corp'), 'all');
  assert.deepEqual(CONTACT_SCOPES, ['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste', 'mcp:room']);
});

test('FR-MSG-008 AC-4: a pairing token expires after 24 hours', async () => {
  const { keys, clock } = await makeKeys();
  const { token } = keys.issuePairingToken();
  clock.t = DAY + 1;
  assert.equal(keys.authenticate(token, 'corp'), null);
});

test('FR-MSG-009 AC-1: a room ticket is one-time, limited to its room, and expires after 7 days', async () => {
  const { keys, clock } = await makeKeys();
  const ticket = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  assert.equal(ticket.expiresAt, new Date(7 * DAY).toISOString());
  assert.deepEqual(keys.authenticate(ticket.token, 'guest'), { kind: 'room', scopes: ROOM_SCOPES, rooms: ['rm_a'] });
  assert.deepEqual(keys.allowedRooms('guest'), ['rm_a']);
  // Used once: another node cannot take it.
  assert.equal(keys.authenticate(ticket.token, 'other'), null);

  const late = keys.issueRoomTicket({ roomId: 'rm_b', invitee: 'late' });
  clock.t = 7 * DAY + 1;
  assert.equal(keys.authenticate(late.token, 'late'), null);
  assert.equal(keys.allowedRooms('late'), 'none');
});

test('FR-MSG-009 AC-1: a second ticket for the same node adds its room to that node\'s room key', async () => {
  const { keys } = await makeKeys();
  const first = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  keys.authenticate(first.token, 'guest');
  const second = keys.issueRoomTicket({ roomId: 'rm_b', invitee: 'guest' });
  assert.deepEqual(keys.authenticate(second.token, 'guest'), { kind: 'room', scopes: ROOM_SCOPES, rooms: ['rm_a', 'rm_b'] });
  assert.deepEqual(keys.allowedRooms('guest'), ['rm_a', 'rm_b']);
});

test('FR-MSG-009 AC-4: kicking removes that room from the node\'s room key; the last room removes the key', async () => {
  const { keys } = await makeKeys();
  const ticket = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  keys.authenticate(ticket.token, 'guest');
  const second = keys.issueRoomTicket({ roomId: 'rm_b', invitee: 'guest' });
  keys.authenticate(second.token, 'guest');
  keys.revokeRoomKey({ roomId: 'rm_a', node: 'guest' });
  assert.deepEqual(keys.allowedRooms('guest'), ['rm_b']);
  keys.revokeRoomKey({ roomId: 'rm_b', node: 'guest' });
  assert.equal(keys.allowedRooms('guest'), 'none');
  assert.equal(keys.authenticate(second.token, 'guest'), null);
});

test('FR-MSG-008 AC-6: a revoked contact key no longer authenticates; issueContactKey replaces the old one', async () => {
  const { keys } = await makeKeys();
  const first = keys.issueContactKey('corp');
  assert.deepEqual(keys.authenticate(first, 'corp'), { kind: 'contact', scopes: CONTACT_SCOPES });
  const second = keys.issueContactKey('corp');
  assert.equal(keys.authenticate(first, 'corp'), null);
  assert.deepEqual(keys.authenticate(second, 'corp'), { kind: 'contact', scopes: CONTACT_SCOPES });
  keys.revokeContact('corp');
  assert.equal(keys.authenticate(second, 'corp'), null);
  assert.equal(keys.allowedRooms('corp'), 'none');
});

test('FR-MSG-008: a key that is not a messenger key answers null', async () => {
  const { keys } = await makeKeys();
  assert.equal(keys.authenticate('fixed-mcp-key', 'corp'), null);
  assert.equal(keys.authenticate('', 'corp'), null);
});

test('FR-MSG-008/009: keys are stored hashed and survive a restart', async () => {
  const { keys, keysPath } = await makeKeys();
  const contact = keys.issueContactKey('corp');
  const ticket = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  keys.authenticate(ticket.token, 'guest');
  const pairing = keys.issuePairingToken();
  await keys.whenSaved();
  const raw = await fs.readFile(keysPath, 'utf8');
  for (const plain of [contact, ticket.token, pairing.token]) assert.equal(raw.includes(plain), false, plain);
  const again = createMessengerKeys({ path: keysPath, now: () => 0 });
  assert.deepEqual(again.authenticate(contact, 'corp'), { kind: 'contact', scopes: CONTACT_SCOPES });
  assert.deepEqual(again.allowedRooms('guest'), ['rm_a']);
  assert.deepEqual(again.authenticate(pairing.token, 'home'), { kind: 'contact', scopes: CONTACT_SCOPES });
});

const roomActor = { type: 'mcp-peer', peer: 'guest', scopes: ['mcp:room'] };

test('FR-MSG-009 AC-2: a room-key link may call room peer tools only', () => {
  const allowed = () => ['rm_a'] as string[];
  for (const tool of ['buildergate.session.list', 'buildergate.message.send', 'buildergate.sessions.search']) {
    assert.deepEqual(guardMessengerPeerCall({ tool, args: {}, actor: roomActor }, allowed), { ok: false, code: 'INVALID_SCOPE' }, tool);
  }
  assert.equal(guardMessengerPeerCall({ tool: 'buildergate.room.peer.sync', args: { roomId: 'rm_a' }, actor: roomActor }, allowed), null);
});

test('FR-MSG-009 AC-2: a room-key link may reach only the rooms of its key', () => {
  const allowed = () => ['rm_a'] as string[];
  for (const tool of ['join', 'sync', 'post', 'decline', 'member']) {
    const name = `buildergate.room.peer.${tool}`;
    assert.equal(guardMessengerPeerCall({ tool: name, args: { roomId: 'rm_a' }, actor: roomActor }, allowed), null, name);
    assert.deepEqual(guardMessengerPeerCall({ tool: name, args: { roomId: 'rm_b' }, actor: roomActor }, allowed), { ok: false, code: 'INVALID_SCOPE' }, name);
  }
  assert.deepEqual(guardMessengerPeerCall({ tool: 'buildergate.room.peer.invite', args: {}, actor: roomActor }, allowed), { ok: false, code: 'INVALID_SCOPE' });
});

test('FR-MSG-009 AC-2: contacts and fixed-key peers are not narrowed by the guard', () => {
  const contact = { type: 'mcp-peer', peer: 'corp', scopes: CONTACT_SCOPES };
  assert.equal(guardMessengerPeerCall({ tool: 'buildergate.session.list', args: {}, actor: contact }, () => 'all'), null);
  assert.equal(guardMessengerPeerCall({ tool: 'buildergate.room.peer.invite', args: {}, actor: contact }, () => 'all'), null);
  const fixed = { type: 'mcp-peer', peer: 'azure', scopes: ['mcp:sessions.list'] };
  assert.equal(guardMessengerPeerCall({ tool: 'buildergate.room.peer.deliver', args: { roomId: 'rm_x' }, actor: fixed }, () => 'none'), null);
  assert.equal(guardMessengerPeerCall({ tool: 'buildergate.session.list', args: {}, actor: { type: 'mcp-session', scopes: ['mcp:room'] } }, () => 'none'), null);
});

test('FR-MSG-008: contactNodes lists the nodes holding a contact key here', async () => {
  const { keys } = await makeKeys();
  keys.issueContactKey('corp');
  const pairing = keys.issuePairingToken();
  keys.authenticate(pairing.token, 'home');
  assert.deepEqual(keys.contactNodes(), ['corp', 'home']);
  keys.revokeContact('corp');
  assert.deepEqual(keys.contactNodes(), ['home']);
});

test('review H1: a ticket made for one node cannot be used under another node\'s name', async () => {
  const { keys } = await makeKeys();
  const ticket = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  assert.equal(keys.authenticate(ticket.token, 'bob'), null);
  assert.deepEqual(keys.authenticate(ticket.token, 'guest'), { kind: 'room', scopes: ROOM_SCOPES, rooms: ['rm_a'] });
});

test('review H1: a ticket cannot take over a contact\'s name, and an open ticket cannot take over a room guest', async () => {
  const { keys } = await makeKeys();
  const contactKey = keys.issueContactKey('bob');
  const named = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'bob' });
  assert.equal(keys.authenticate(named.token, 'bob'), null);
  assert.deepEqual(keys.authenticate(contactKey, 'bob'), { kind: 'contact', scopes: CONTACT_SCOPES });
  const first = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  keys.authenticate(first.token, 'guest');
  const open = keys.issueRoomTicket({ roomId: 'rm_b', invitee: '' });
  assert.equal(keys.authenticate(open.token, 'guest'), null, 'an open ticket may not join an existing room key');
  assert.deepEqual(keys.authenticate(first.token, 'guest'), { kind: 'room', scopes: ROOM_SCOPES, rooms: ['rm_a'] });
  assert.deepEqual(keys.authenticate(open.token, 'newcomer'), { kind: 'room', scopes: ROOM_SCOPES, rooms: ['rm_b'] });
});

test('review H1: a pairing token cannot take over a name that already holds a contact key', async () => {
  const { keys } = await makeKeys();
  const existing = keys.issueContactKey('bob');
  const pairing = keys.issuePairingToken();
  assert.equal(keys.authenticate(pairing.token, 'bob'), null);
  assert.deepEqual(keys.authenticate(existing, 'bob'), { kind: 'contact', scopes: CONTACT_SCOPES });
});

test('review: after a second ticket the first room-key value stops working', async () => {
  const { keys } = await makeKeys();
  const first = keys.issueRoomTicket({ roomId: 'rm_a', invitee: 'guest' });
  keys.authenticate(first.token, 'guest');
  const second = keys.issueRoomTicket({ roomId: 'rm_b', invitee: 'guest' });
  keys.authenticate(second.token, 'guest');
  assert.equal(keys.authenticate(first.token, 'guest'), null);
});

test('review M4/H2: room-only is judged from the link scopes, not the scopes the caller sent', () => {
  const sneaky = { type: 'mcp-peer', peer: 'guest', scopes: [], linkScopes: ['mcp:room'] };
  assert.deepEqual(guardMessengerPeerCall({ tool: 'buildergate.session.list', args: {}, actor: sneaky }, () => ['rm_a']), { ok: false, code: 'INVALID_SCOPE' });
  // A room host calling deliver over my outbound room link: no key of mine, membership is checked by the rooms side.
  const host = { type: 'mcp-peer', peer: 'host1', scopes: ['mcp:room'], linkScopes: ['mcp:room'] };
  assert.equal(guardMessengerPeerCall({ tool: 'buildergate.room.peer.deliver', args: { roomId: 'rm_x' }, actor: host }, () => 'none'), null);
  assert.deepEqual(guardMessengerPeerCall({ tool: 'buildergate.session.list', args: {}, actor: host }, () => 'none'), { ok: false, code: 'INVALID_SCOPE' });
});
