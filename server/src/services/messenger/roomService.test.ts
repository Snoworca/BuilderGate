// FR-MSG-001/002/004/005/009/010/011/012 (server parts): servers linked through a fake peer
// transport — invite → join → post → deliver, host offline → outbox → flush, hold, ticket, kick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNetwork, type FakeServer } from './testHarness.js';
import { callRoomPeerTool } from './roomPeerTools.js';

type Rec = Record<string, unknown>;

async function trio() {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'worker' }]);
  const bob = await net.add('bob', [{ sessionKey: 'b1', name: 'api' }, { sessionKey: 'b2', name: 'helper' }]);
  const carol = await net.add('carol', [{ sessionKey: 'c1', name: 'tester' }]);
  net.befriend('alice', 'bob');
  net.befriend('bob', 'carol');
  return { net, alice, bob, carol };
}

async function roomWithBob(net: FakeNetwork, alice: FakeServer, bob: FakeServer, bobSessions = ['b1', 'b2']) {
  const created = await alice.svc.createRoom({ name: '결제팀', sessions: ['a1'], people: ['bob'] }) as Rec;
  assert.equal(created.ok, true, JSON.stringify(created));
  const roomId = (created.room as Rec).id as string;
  await net.idle();
  const invite = bob.svc.state().invites[0]!;
  const accepted = await bob.svc.acceptInvite(invite.id, { sessions: bobSessions, personOnly: false }) as Rec;
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  await net.idle();
  return roomId;
}

function texts(server: FakeServer, sessionKey: string): string[] {
  return server.pastes.filter((p) => p.sessionKey === sessionKey).map((p) => p.text);
}

test('FR-MSG-001 AC-1, FR-MSG-010 AC-1/AC-3: create, invite a contact, join with sessions', async () => {
  const { net, alice, bob } = await trio();
  const created = await alice.svc.createRoom({ name: '결제팀', sessions: ['a1'], people: ['bob'], message: '같이 봐요' }) as Rec;
  const room = created.room as Rec;
  assert.match(room.id as string, /^rm_[a-z2-7]{16}$/);
  assert.equal(room.hostNode, 'alice');
  assert.deepEqual(room.invitedPending, ['bob']);
  await net.idle();
  const invites = bob.svc.state().invites;
  assert.equal(invites.length, 1);
  assert.equal(invites[0]!.invitedBy, 'alice');
  assert.equal(invites[0]!.message, '같이 봐요');
  assert.deepEqual(invites[0]!.room.sessions, ['alice::worker']);
  assert.ok(bob.webhooks.some((w) => w.startsWith('[BuilderGate 메신저] 결제팀: alice')));
  assert.ok(texts(alice, 'a1')[0]!.startsWith('[BG-ROOM:결제팀 | 안내] 이 세션이 방에 들어왔습니다.'));

  const accepted = await bob.svc.acceptInvite(invites[0]!.id, { sessions: ['b1'], personOnly: false }) as Rec;
  assert.equal(accepted.ok, true);
  await net.idle();
  assert.equal(bob.svc.state().invites.length, 0);
  const onAlice = await alice.svc.getRoom(room.id as string, {}) as Rec;
  const aliceRoom = onAlice.room as Rec;
  assert.deepEqual((aliceRoom.people as Rec[]).map((p) => [p.node, p.state]), [['alice', 'joined'], ['bob', 'joined']]);
  assert.deepEqual((aliceRoom.sessions as Rec[]).map((s) => s.id), ['alice::a1', 'bob::b1']);
  const onBob = await bob.svc.getRoom(room.id as string, {}) as Rec;
  assert.deepEqual((onBob.messages as Rec[]).map((m) => (m.system as Rec | undefined)?.event), ['invited', 'joined']);
  assert.ok(texts(bob, 'b1')[0]!.startsWith('[BG-ROOM:결제팀 | 안내]'));
  assert.equal(texts(bob, 'b2').length, 0);
});

test('FR-MSG-004 AC-1/AC-5, FR-MSG-003 AC-2: a human message is pasted only on the server that owns the named session', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  alice.pastes.length = 0;
  bob.pastes.length = 0;
  const sent = await alice.svc.postFromUi(roomId, '배포 확인 @bob::api') as Rec;
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'sequenced');
  assert.equal(sent.seq, 3);
  await net.idle();
  assert.deepEqual(bob.pastes, [{ sessionKey: 'b1', text: '[BG-ROOM:결제팀 | alice → @api] 배포 확인 @bob::api', submit: true }]);
  assert.deepEqual(alice.pastes, []);
});

test('FR-MSG-007 AC-2, FR-MSG-004 AC-5: an agent answers with room.send @alice::worker — pasted only there', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  alice.pastes.length = 0;
  bob.pastes.length = 0;
  const sent = await bob.svc.postFromSession('b1', '결제팀', '끝났습니다 @alice::worker') as Rec;
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.status, 'sequenced');
  assert.equal(typeof sent.seq, 'number');
  await net.idle();
  assert.deepEqual(alice.pastes.map((p) => p.text), ['[BG-ROOM:결제팀 | bob::api → @worker] 끝났습니다 @alice::worker']);
  assert.deepEqual(bob.pastes, []);
  const log = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.deepEqual(log.at(-1)!.from, { node: 'bob', sessionKey: 'b1', kind: 'agent' });
});

test('FR-MSG-011 AC-1..AC-4: host offline → local sessions get it now, the outbox waits, host back → sequenced once', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  alice.pastes.length = 0;
  bob.pastes.length = 0;
  net.online.delete('alice');
  const sent = await bob.svc.postFromSession('b1', roomId, '호스트 없이 보냄') as Rec;
  assert.equal(sent.status, 'waiting-host');
  assert.equal(sent.seq, null);
  assert.deepEqual(sent.delivery, { pasted: 1, waiting: 1 });
  await net.idle();
  assert.deepEqual(texts(bob, 'b2'), ['[BG-ROOM:결제팀 | api] 호스트 없이 보냄']);
  const view = await bob.svc.getRoom(roomId, {}) as Rec;
  assert.equal((view.host as Rec).online, false);
  assert.equal(typeof (view.host as Rec).offlineSince, 'string');
  assert.equal((view.outbox as Rec[]).length, 1);
  assert.equal(bob.svc.state().rooms[0]!.hostOnline, false);

  await bob.svc.tick();
  net.online.add('alice');
  await bob.svc.tick();
  await bob.svc.tick();
  await net.idle();
  assert.deepEqual(texts(alice, 'a1'), ['[BG-ROOM:결제팀 | bob::api] 호스트 없이 보냄']);
  assert.deepEqual(texts(bob, 'b2'), ['[BG-ROOM:결제팀 | api] 호스트 없이 보냄']);
  const after = await bob.svc.getRoom(roomId, {}) as Rec;
  assert.deepEqual(after.outbox, []);
  assert.equal((after.host as Rec).online, true);
  const hostLog = ((await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).filter((m) => m.text === '호스트 없이 보냄');
  assert.equal(hostLog.length, 1);
});

test('FR-MSG-005 AC-1..AC-3: 20 agent messages in a row → held, a human message resets', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  alice.pastes.length = 0;
  const results: Rec[] = [];
  for (let i = 1; i <= 22; i += 1) {
    results.push(await bob.svc.postFromSession('b1', roomId, `step ${i}`) as Rec);
    await net.idle();
  }
  assert.deepEqual(results.map((r) => r.held), [...Array(19).fill(false), true, true, true]);
  assert.equal(texts(alice, 'a1').length, 19);
  const log = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.equal(log.at(-1)!.agentRun, 22);
  assert.equal((((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).settings as Rec).holdLimit, 20);
  assert.equal(alice.svc.state().rooms[0]!.held, true);
  assert.equal(bob.svc.state().rooms[0]!.held, true);
  assert.ok(alice.webhooks.some((w) => w.includes('결제팀')));
  await alice.svc.postFromUi(roomId, '멈춰');
  await net.idle();
  assert.equal(bob.svc.state().rooms[0]!.held, false);
  const resumed = await bob.svc.postFromSession('b1', roomId, 'again') as Rec;
  assert.equal(resumed.held, false);
});

test('FR-MSG-009 AC-1/AC-4, FR-MSG-001 AC-4: a non-contact invited by a member joins with a room ticket; the creator kicks', async () => {
  const { net, alice, bob, carol } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  const invited = await bob.svc.invite(roomId, { people: ['carol'] }) as Rec;
  assert.equal(invited.ok, true, JSON.stringify(invited));
  await net.idle();
  assert.deepEqual(alice.tickets, [{ roomId, invitee: 'carol' }]);
  const invite = carol.svc.state().invites[0]!;
  assert.equal(invite.invitedBy, 'bob');
  const accepted = await carol.svc.acceptInvite(invite.id, { sessions: ['c1'], personOnly: false }) as Rec;
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  await net.idle();
  assert.deepEqual(carol.roomLinks.map((l) => l.hostNode), ['alice']);
  const hostLog = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.ok(hostLog.some((m) => (m.system as Rec | undefined)?.event === 'invited' && (m.system as Rec).actor === 'bob' && (m.system as Rec).subject === 'carol'));
  assert.ok(texts(carol, 'c1')[0]!.startsWith('[BG-ROOM:결제팀 | 안내]'));

  await bob.svc.postFromUi(roomId, '@carol::tester 테스트 부탁');
  await net.idle();
  assert.deepEqual(texts(carol, 'c1').slice(1), ['[BG-ROOM:결제팀 | bob → @tester] @carol::tester 테스트 부탁']);

  assert.deepEqual(await bob.svc.removeMember(roomId, 'carol'), { ok: false, code: 'NOT_CREATOR' });
  const kicked = await alice.svc.removeMember(roomId, 'carol') as Rec;
  assert.equal(kicked.ok, true);
  await net.idle();
  assert.deepEqual(alice.revoked, [{ roomId, node: 'carol' }]);
  const people = (((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).people as Rec[]).map((p) => p.node);
  assert.deepEqual(people, ['alice', 'bob']);
  assert.equal(carol.svc.state().rooms.length, 0);
  assert.deepEqual(carol.dropped, ['alice']);
});

test('FR-MSG-009 AC-3: invitePolicy approve — the creator approves, then the invitee gets the invitation', async () => {
  const { net, alice, bob, carol } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  assert.deepEqual(await bob.svc.updateSettings(roomId, { invitePolicy: 'approve' }), { ok: false, code: 'NOT_CREATOR' });
  assert.equal((await alice.svc.updateSettings(roomId, { invitePolicy: 'approve' }) as Rec).ok, true);
  const invited = await bob.svc.invite(roomId, { people: ['carol'] }) as Rec;
  assert.equal(invited.ok, true);
  assert.deepEqual(invited.pending, ['carol']);
  await net.idle();
  assert.equal(carol.svc.state().invites.length, 0);
  const approvals = alice.svc.state().approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.invitee, 'carol');
  assert.ok(alice.webhooks.some((w) => w.includes('carol')));
  assert.equal((await alice.svc.decideApproval(approvals[0]!.id, true) as Rec).ok, true);
  await net.idle();
  assert.equal(carol.svc.state().invites.length, 1);
  assert.equal(carol.svc.state().invites[0]!.invitedBy, 'bob');
});

test('FR-MSG-010 AC-4: an invitation to a PC that is off is delivered when it comes back; decline leaves a system line', async () => {
  const { net, alice, bob } = await trio();
  net.online.delete('bob');
  const created = await alice.svc.createRoom({ name: 'later', sessions: [], people: ['bob'] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await net.idle();
  net.online.add('bob');
  assert.equal(bob.svc.state().invites.length, 0);
  await alice.svc.tick();
  await net.idle();
  assert.equal(bob.svc.state().invites.length, 1);
  assert.equal((await bob.svc.declineInvite(bob.svc.state().invites[0]!.id) as Rec).ok, true);
  await net.idle();
  const log = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.equal((log.at(-1)!.system as Rec).event, 'declined');
  assert.deepEqual(alice.svc.state().rooms[0]!.invitedPending, []);
});

test('FR-MSG-001 AC-5: a closed session leaves the room with a system message; renamed sessions follow', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  bob.sessions = bob.sessions.filter((s) => s.sessionKey !== 'b2');
  bob.sessions[0]!.name = 'api-v2';
  await bob.svc.tick();
  await net.idle();
  const room = (await alice.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.deepEqual((room.sessions as Rec[]).map((s) => [s.id, s.name]), [['alice::a1', 'worker'], ['bob::b1', 'api-v2']]);
  const log = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.ok(log.some((m) => (m.system as Rec | undefined)?.event === 'session-removed' && (m.system as Rec).subject === 'bob::b2'));
});

test('FR-MSG-002 AC-3: rooms and logs survive a restart; FR-MSG-001 AC-2/AC-6 unread, mention and search', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.postFromUi(roomId, '@bob 확인해 주세요 결제 오류');
  await net.idle();
  const summary = bob.svc.state().rooms[0]!;
  assert.equal(summary.unread, 1);
  assert.equal(summary.mention, 1);
  assert.equal(bob.svc.state().unread.mention, 1);
  assert.equal(bob.svc.state().unread.total, 1);
  assert.equal((await bob.svc.markRead(roomId, summary.lastSeq as number) as Rec).ok, true);
  assert.equal(bob.svc.state().rooms[0]!.unread, 0);
  const found = bob.svc.search('결제') as Rec;
  assert.deepEqual((found.rooms as Rec[]).map((r) => r.name), ['결제팀']);
  assert.equal((found.messages as Rec[]).length, 1);
  assert.deepEqual(bob.svc.state().sessionRooms, { b1: ['결제팀'], b2: ['결제팀'] });

  const again = await net.add('bob2', [{ sessionKey: 'b1', name: 'api' }], bob.store);
  const reloaded = again.svc.state().rooms;
  assert.equal(reloaded.length, 1);
  assert.equal((await again.svc.getRoom(roomId, {}) as Rec & { messages: unknown[] }).messages.length, 3);
});

test('FR-MSG-012 AC-1: the creator moves the room to a member while the host is on; members follow', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  assert.deepEqual(await bob.svc.transfer(roomId, 'alice'), { ok: false, code: 'NOT_CREATOR' });
  const moved = await alice.svc.transfer(roomId, 'bob') as Rec;
  assert.equal(moved.ok, true, JSON.stringify(moved));
  await net.idle();
  assert.equal(bob.svc.state().rooms[0]!.isHost, true);
  assert.equal(alice.svc.state().rooms[0]!.hostNode, 'bob');
  alice.pastes.length = 0;
  const sent = await alice.svc.postFromUi(roomId, '새 호스트로') as Rec;
  assert.equal(sent.status, 'sequenced');
  await net.idle();
  const log = (await bob.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.equal(log.at(-1)!.text, '새 호스트로');
  assert.ok(log.some((m) => (m.system as Rec | undefined)?.event === 'host-moved'));
  net.online.delete('bob');
  assert.deepEqual(await alice.svc.transfer(roomId, 'alice'), { ok: false, code: 'HOST_OFFLINE' });
});

test('FR-MSG-012 AC-2/AC-3: with the host gone, a member continues in a new room seeded with its copy', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.postFromUi(roomId, '이전 기록');
  await net.idle();
  net.online.delete('alice');
  await bob.svc.tick();
  assert.equal(bob.svc.state().rooms[0]!.hostNode, 'alice');
  const continued = await bob.svc.continueRoom(roomId) as Rec;
  assert.equal(continued.ok, true);
  const newId = (continued.room as Rec).id as string;
  assert.notEqual(newId, roomId);
  const view = await bob.svc.getRoom(newId, {}) as Rec;
  assert.equal(((view.room as Rec).hostNode), 'bob');
  const textsInNew = (view.messages as Rec[]).map((m) => m.text);
  assert.ok(textsInNew.includes('이전 기록'));
  assert.equal(((view.messages as Rec[]).at(-1)!.system as Rec).event, 'continued');
  assert.deepEqual((view.room as Rec).invitedPending ?? ((view.room as Rec).people as Rec[]).filter((p) => p.state === 'invited').map((p) => p.node), ['alice']);
});

test('FR-MSG-001 AC-4: anyone can leave; the owner can take a session out', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  assert.equal((await bob.svc.removeMember(roomId, 'bob::b2') as Rec).ok, true);
  await net.idle();
  let room = (await alice.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.deepEqual((room.sessions as Rec[]).map((s) => s.id), ['alice::a1', 'bob::b1']);
  assert.equal((await bob.svc.leave(roomId) as Rec).ok, true);
  await net.idle();
  room = (await alice.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.deepEqual((room.people as Rec[]).map((p) => p.node), ['alice']);
  assert.deepEqual((room.sessions as Rec[]).map((s) => s.id), ['alice::a1']);
  assert.equal(bob.svc.state().rooms.length, 0);
});

test('FR-MSG-009 AC-6: an invite code redeemed by a stranger joins through the ticket', async () => {
  const { net, alice, bob } = await trio();
  const dave = await net.add('dave', [{ sessionKey: 'd1', name: 'ops' }]);
  const roomId = await roomWithBob(net, alice, bob);
  const code = await bob.svc.inviteCode(roomId, '들어와요') as Rec;
  assert.match(code.code as string, /^bgi1\./);
  const payload = JSON.parse(Buffer.from((code.code as string).slice(5), 'base64url').toString('utf8')) as Rec;
  const redeemed = await dave.svc.redeemInvite(payload) as Rec;
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.kind, 'invite');
  const invite = dave.svc.state().invites[0]!;
  assert.equal(invite.message, '들어와요');
  const accepted = await dave.svc.acceptInvite(invite.id, { sessions: [], personOnly: true }) as Rec;
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  await net.idle();
  const people = (((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).people as Rec[]).map((p) => p.node);
  assert.deepEqual(people, ['alice', 'bob', 'dave']);
});

test('FR-MSG-015 AC-2: a message naming me from another node goes to the webhook', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  bob.webhooks.length = 0;
  await alice.svc.postFromUi(roomId, `@bob ${'긴 본문 '.repeat(60)}`);
  await net.idle();
  assert.equal(bob.webhooks.length, 1);
  assert.ok(bob.webhooks[0]!.startsWith('[BuilderGate 메신저] 결제팀: alice — @bob 긴 본문'));
  assert.ok(bob.webhooks[0]!.length <= '[BuilderGate 메신저] 결제팀: alice — '.length + 200);
});

test('FR-MSG-001: mention errors come back before anything is sent', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  assert.deepEqual(await alice.svc.postFromUi(roomId, '@nobody hi'), { ok: false, code: 'TARGET_NOT_FOUND', name: 'nobody' });
  assert.deepEqual(await alice.svc.postFromUi('rm_missing', 'hi'), { ok: false, code: 'ROOM_NOT_FOUND' });
  assert.equal((await alice.svc.createRoom({ name: '', sessions: [], people: [] }) as Rec).code, 'VALIDATION_ERROR');
});

function receiptsOf(view: Rec, text: string): Rec | undefined {
  return ((view.messages as Rec[]).find((m) => m.text === text))?.receipts as Rec | undefined;
}

test('FR-MSG-002 AC-4: receipts — targets at send time, servers that acked, sessions pasted; members see them too', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.postFromUi(roomId, '모두에게');
  await net.idle();
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), '모두에게'), { targets: 3, delivered: 2, pasted: 3 });
  assert.deepEqual(receiptsOf(await bob.svc.getRoom(roomId, {}), '모두에게'), { targets: 3, delivered: 2, pasted: 3 });

  bob.failPaste.add('b2');
  await alice.svc.postFromUi(roomId, '@bob::helper 하나만');
  await net.idle();
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), '@bob::helper 하나만'), {
    targets: 1, delivered: 2, pasted: 0, skipped: 1, skippedReasons: { PASTE_FAILED: 1 },
  });
});

test('FR-MSG-002 AC-4, FR-MSG-011: the sender\'s own early pastes count once the host numbers the message', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  net.online.delete('alice');
  await bob.svc.postFromSession('b1', roomId, '오프라인 중');
  await net.idle();
  assert.equal(receiptsOf(await bob.svc.getRoom(roomId, {}), '오프라인 중'), undefined);
  net.online.add('alice');
  await bob.svc.tick();
  await net.idle();
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), '오프라인 중'), { targets: 2, delivered: 2, pasted: 2 });
  assert.deepEqual(receiptsOf(await bob.svc.getRoom(roomId, {}), '오프라인 중'), { targets: 2, delivered: 2, pasted: 2 });
});

test('FR-MSG-009 AC-3: after the storage PC moved, the approval card still reaches the creator and is answered via the host', async () => {
  const { net, alice, bob, carol } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  assert.equal((await alice.svc.transfer(roomId, 'bob') as Rec).ok, true);
  await net.idle();
  assert.equal((await alice.svc.updateSettings(roomId, { invitePolicy: 'approve' }) as Rec).ok, true);
  await net.idle();
  alice.webhooks.length = 0;
  const invited = await bob.svc.invite(roomId, { people: ['carol'] }) as Rec;
  assert.deepEqual(invited.pending, ['carol']);
  await net.idle();
  assert.equal(bob.svc.state().approvals.length, 0);
  const approvals = alice.svc.state().approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.invitee, 'carol');
  assert.ok(alice.webhooks.some((w) => w.includes('carol')));
  assert.equal(carol.svc.state().invites.length, 0);
  assert.equal((await alice.svc.decideApproval(approvals[0]!.id, true) as Rec).ok, true);
  await net.idle();
  assert.equal(alice.svc.state().approvals.length, 0);
  assert.equal(carol.svc.state().invites.length, 1);
  assert.equal(carol.svc.state().invites[0]!.invitedBy, 'bob');
});

test('FR-MSG-009 AC-3: an approval waits for the creator\'s PC to come back', async () => {
  const { net, alice, bob } = await trio();
  const dave = await net.add('dave', []);
  net.befriend('bob', 'dave');
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.transfer(roomId, 'bob');
  await alice.svc.updateSettings(roomId, { invitePolicy: 'approve' });
  await net.idle();
  net.online.delete('alice');
  await bob.svc.invite(roomId, { people: ['dave'] });
  await net.idle();
  net.online.add('alice');
  await bob.svc.tick();
  await net.idle();
  assert.equal(alice.svc.state().approvals.length, 1);
  assert.equal((await alice.svc.decideApproval(alice.svc.state().approvals[0]!.id, false) as Rec).ok, true);
  await net.idle();
  const people = (((await bob.svc.getRoom(roomId, {}) as Rec).room as Rec).people as Rec[]).map((p) => p.node);
  assert.deepEqual(people, ['alice', 'bob']);
  assert.equal(dave.svc.state().invites.length, 0);
});

test('FR-MSG-010 AC-3: a room link that cannot be made answers ROOM_LINK_INVALID at once, and the invite stays', async () => {
  const { net, alice, bob, carol } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await bob.svc.invite(roomId, { people: ['carol'] });
  await net.idle();
  carol.roomLinkResult = { ok: false, code: 'ROOM_LINK_INVALID', reason: 'no wss URL' };
  const invite = carol.svc.state().invites[0]!;
  const accepted = await carol.svc.acceptInvite(invite.id, { sessions: ['c1'], personOnly: false });
  assert.deepEqual(accepted, { ok: false, code: 'ROOM_LINK_INVALID', reason: 'no wss URL' });
  assert.equal(carol.svc.state().invites.length, 1);
  assert.equal((carol.svc.state().invites[0] as Rec).accepting, undefined);
  assert.ok(!net.calls.some((c) => c.from === 'carol' && c.tool === 'buildergate.room.peer.join'));
});

test('FR-MSG-009 AC-1/AC-6: with LAN receiving off the host has no address to hand out — LAN_OFF', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  alice.lanOn = false;
  assert.deepEqual(await alice.svc.inviteCode(roomId), { ok: false, code: 'LAN_OFF' });
  assert.deepEqual(await bob.svc.inviteCode(roomId), { ok: false, code: 'LAN_OFF' });
  assert.deepEqual(await bob.svc.invite(roomId, { people: ['carol'] }), { ok: false, code: 'LAN_OFF' });
});

test('FR-MSG-002 AC-4: a receipt that could not reach the host is sent again after the next successful sync', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  net.dropTools.add('buildergate.room.peer.receipt');
  await alice.svc.postFromUi(roomId, '재전송');
  await net.idle();
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), '재전송'), { targets: 3, delivered: 1, pasted: 1 });
  net.dropTools.clear();
  await bob.svc.tick();
  await net.idle();
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), '재전송'), { targets: 3, delivered: 2, pasted: 3 });
  await bob.svc.tick();
  await net.idle();
  assert.equal(net.calls.filter((c) => c.from === 'bob' && c.tool === 'buildergate.room.peer.receipt').length, 2);
});

test('FR-MSG-004 AC-2: joining with 「받은 메시지를 바로 입력」 off sets enter false on the joining sessions', async () => {
  const { net, alice, bob } = await trio();
  await alice.svc.createRoom({ name: 'r', sessions: [], people: ['bob'] });
  await net.idle();
  await bob.svc.acceptInvite(bob.svc.state().invites[0]!.id, { sessions: ['b1'], personOnly: false, enter: false });
  await net.idle();
  const roomId = alice.svc.state().rooms[0]!.id;
  const sessions = ((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).sessions as Rec[];
  assert.deepEqual(sessions.map((s) => [s.id, s.enter]), [['bob::b1', false]]);
  assert.equal(bob.pastes[0]!.submit, false);
});

test('security: a session without a detected agent gets nothing pasted — not messages, not the entrance notice', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'worker' }]);
  const bob = await net.add('bob', [{ sessionKey: 'b1', name: 'api' }, { sessionKey: 'b2', name: 'shell', agent: null }]);
  net.befriend('alice', 'bob');
  const created = await alice.svc.createRoom({ name: '결제팀', sessions: ['a1'], people: ['bob'] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await net.idle();
  await bob.svc.acceptInvite(bob.svc.state().invites[0]!.id, { sessions: ['b1', 'b2'], personOnly: false });
  await net.idle();
  assert.equal(texts(bob, 'b2').length, 0);

  await alice.svc.postFromUi(roomId, 'echo hacked');
  await bob.svc.tick();
  await net.idle();
  assert.equal(texts(bob, 'b2').length, 0);
  assert.equal(texts(bob, 'b1').at(-1), '[BG-ROOM:결제팀 | alice] echo hacked');
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), 'echo hacked'), {
    targets: 3, delivered: 2, pasted: 2, skipped: 1, skippedReasons: { NO_AGENT: 1 },
  });
  const sessions = ((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).sessions as Rec[];
  assert.deepEqual(sessions.map((s) => [s.id, s.agent]), [
    ['alice::a1', { kind: 'claude', status: 'ready' }],
    ['bob::b1', { kind: 'claude', status: 'ready' }],
    ['bob::b2', null],
  ]);

  // An agent starts in that session: the entrance notice and new messages from then on; nothing old replayed.
  bob.sessions[1]!.agent = { kind: 'codex', status: 'busy' };
  await alice.svc.postFromUi(roomId, '새 메시지');
  await net.idle();
  const b2 = texts(bob, 'b2');
  assert.equal(b2.length, 2);
  assert.ok(b2[0]!.startsWith('[BG-ROOM:결제팀 | 안내]'));
  assert.equal(b2[1], '[BG-ROOM:결제팀 | alice] 새 메시지');
  await bob.svc.tick();
  await net.idle();
  const after = ((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).sessions as Rec[];
  assert.deepEqual(after.find((s) => s.id === 'bob::b2')!.agent, { kind: 'codex', status: 'busy' });
});

test('security: the host does not paste into its own sessions without an agent either', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'sh', agent: null }, { sessionKey: 'a2', name: 'ai' }]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: ['a1', 'a2'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await alice.svc.postFromSession('a2', roomId, 'ls -la');
  await net.idle();
  assert.equal(texts(alice, 'a1').length, 0);
  assert.deepEqual(receiptsOf(await alice.svc.getRoom(roomId, {}), 'ls -la'), {
    targets: 1, delivered: 1, pasted: 0, skipped: 1, skippedReasons: { NO_AGENT: 1 },
  });
});

function steps(server: FakeServer, sessionKey: string): string[] {
  return texts(server, sessionKey).filter((t) => t.includes('] step '));
}

test('H-1: with the host reachable, a member pastes its own sessions only after the host numbers the message (held stops them)', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  for (let i = 1; i <= 22; i += 1) {
    await bob.svc.postFromSession('b1', roomId, `step ${i}`);
    await net.idle();
  }
  assert.equal(steps(bob, 'b2').length, 19);
});

test('H-1/M-6: with the host away, local pastes stop at the hold limit and while the room is held', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.updateSettings(roomId, { holdLimit: 3 });
  await net.idle();
  net.online.delete('alice');
  for (let i = 1; i <= 5; i += 1) await bob.svc.postFromSession('b1', roomId, `step ${i}`);
  await net.idle();
  assert.deepEqual(steps(bob, 'b2'), [1, 2].map((i) => `[BG-ROOM:결제팀 | api] step ${i}`));
  await bob.svc.postFromUi(roomId, '사람');
  await bob.svc.postFromSession('b1', roomId, 'step 6');
  await net.idle();
  assert.equal(steps(bob, 'b2').at(-1), '[BG-ROOM:결제팀 | api] step 6');
});

test('H-2: a kicked contact cannot join again without a new invite', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.removeMember(roomId, 'bob');
  await net.idle();
  const again = await callRoomPeerTool(alice.svc, 'buildergate.room.peer.join', { roomId, sessions: [], personOnly: true }, { type: 'mcp-peer', peer: 'bob', scopes: ['mcp:room'] });
  assert.equal(again.code, 'NOT_INVITED');
});

test('H-3: names with control characters, "]" or "|" are refused; a bad rename over sync is not applied', async () => {
  const { net, alice, bob } = await trio();
  assert.equal((await alice.svc.createRoom({ name: 'a|b', sessions: [], people: [] }) as Rec).code, 'NAME_INVALID_CHAR');
  assert.equal((await alice.svc.createRoom({ name: 'a\u001bb', sessions: [], people: [] }) as Rec).code, 'NAME_INVALID_CHAR');
  alice.sessions[0]!.name = 'bad]name';
  assert.equal((await alice.svc.createRoom({ name: 'ok', sessions: ['a1'], people: [] }) as Rec).code, 'NAME_INVALID_CHAR');
  alice.sessions[0]!.name = 'worker';
  const roomId = await roomWithBob(net, alice, bob);
  bob.sessions[0]!.name = 'x\u001b[2Jy';
  await bob.svc.tick();
  await net.idle();
  const room = (await alice.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.equal((room.sessions as Rec[]).find((s) => s.id === 'bob::b1')!.name, 'api');
});

test('M-2: a member invites while the host is away — kept as sending, the ticket is asked when the host comes back', async () => {
  const { net, alice, bob, carol } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  net.online.delete('alice');
  assert.deepEqual(await bob.svc.invite(roomId, { people: ['carol'] }), { ok: true, pending: [], status: 'waiting-host' });
  assert.deepEqual(bob.svc.state().rooms[0]!.invitesWaitingHost, ['carol']);
  net.online.add('alice');
  bob.svc.onLinkConnected('alice');
  await net.idle();
  assert.equal(carol.svc.state().invites.length, 1);
  assert.deepEqual(bob.svc.state().rooms[0]!.invitesWaitingHost, []);
});

test('M-3: a decline that cannot reach the host is sent when it can', async () => {
  const { net, alice, bob } = await trio();
  const created = await alice.svc.createRoom({ name: 'r', sessions: [], people: ['bob'] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await net.idle();
  net.online.delete('alice');
  assert.equal((await bob.svc.declineInvite(bob.svc.state().invites[0]!.id) as Rec).ok, true);
  assert.equal(bob.svc.state().invites.length, 0);
  net.online.add('alice');
  await bob.svc.tick();
  await net.idle();
  const log = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.equal((log.at(-1)!.system as Rec).event, 'declined');
});

test('M-5: joining copies the whole history, not only the last 200', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', []);
  const bob = await net.add('bob', []);
  net.befriend('alice', 'bob');
  const created = await alice.svc.createRoom({ name: 'r', sessions: [], people: ['bob'] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  for (let i = 0; i < 250; i += 1) await alice.svc.postFromUi(roomId, `m${i}`);
  await net.idle();
  await bob.svc.acceptInvite(bob.svc.state().invites[0]!.id, { sessions: [], personOnly: true });
  await net.idle();
  const log = await bob.store.readLog(roomId);
  assert.equal(log.length, 252);
  assert.deepEqual(log.map((m) => m.seq), Array.from({ length: 252 }, (_, i) => i + 1));
});

test('peerInvite: an invitation from a node that is neither a contact nor holds that room is refused', async () => {
  const { carol } = await trio();
  const result = await callRoomPeerTool(carol.svc, 'buildergate.room.peer.invite', {
    roomId: 'rm_x', room: { id: 'rm_x', name: 'spam', hostNode: 'mallory', people: [], sessions: [] },
  }, { type: 'mcp-peer', peer: 'mallory', scopes: ['mcp:room'] });
  assert.equal(result.code, 'INVALID_INVITE');
  assert.equal(carol.svc.state().invites.length, 0);
  assert.equal(carol.webhooks.length, 0);
});

test('FR-MSG-003 AC-5: message.to keeps the order the mentions appear in, first occurrence kept', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.postFromUi(roomId, '@bob::api 먼저, @worker 다음, @bob 그리고 @bob::api 다시');
  await bob.svc.postFromSession('b1', roomId, '@bob::helper 확인', ['@alice::worker', 'bob::b2']);
  await net.idle();
  const log = (await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[];
  assert.deepEqual(log.at(-2)!.to, ['bob::b1', 'alice::a1', 'bob']);
  assert.deepEqual(log.at(-1)!.to, ['bob::b2', 'alice::a1']);
});

test('D8: the send answer counts what was really pasted here, with reasons; multi-line refusal is its own reason', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'one' }, { sessionKey: 'a2', name: 'two' }, { sessionKey: 'a3', name: 'three' }]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: ['a1', 'a2', 'a3'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  alice.bracketed.add('a1');
  alice.refusePaste.set('a2', 'PASTE_MULTILINE_UNSUPPORTED');
  alice.failPaste.add('a3');
  const sent = await alice.svc.postFromUi(roomId, '줄1\n줄2') as Rec;
  assert.deepEqual(sent.delivery, { pasted: 1, waiting: 0, skipped: 2, skippedReasons: { MULTILINE_UNSUPPORTED: 1, PASTE_FAILED: 1 } });
  await net.idle();
  const message = ((await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).at(-1)!;
  assert.deepEqual(message.receipts, { targets: 3, delivered: 1, pasted: 1, skipped: 2, skippedReasons: { MULTILINE_UNSUPPORTED: 1, PASTE_FAILED: 1 } });
});

test('FR-MSG-004 AC-2: a session whose screen is not a ready agent TUI (no bracketed paste) is skipped as AGENT_NOT_READY, even for one line and even inside a batch', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'one' }, { sessionKey: 'a2', name: 'two' }]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: ['a1', 'a2'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  alice.bracketed.add('a1');
  alice.refusePaste.set('a2', 'AGENT_NOT_READY');
  const sent = await alice.svc.postFromUi(roomId, '한 줄') as Rec;
  assert.deepEqual(sent.delivery, { pasted: 1, waiting: 0, skipped: 1, skippedReasons: { AGENT_NOT_READY: 1 } });
  await net.idle();
  const message = ((await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).at(-1)!;
  assert.deepEqual(message.receipts, { targets: 2, delivered: 1, pasted: 1, skipped: 1, skippedReasons: { AGENT_NOT_READY: 1 } });
});

test('D9: control characters are stripped when a message is made (local and over the link); history keeps tabs', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  await alice.svc.postFromUi(roomId, 'x\u001b[31my\u0007\tz');
  await bob.svc.postFromSession('b1', roomId, 'b\u001b]0;title\u0007ell\u009b');
  await net.idle();
  const texts2 = ((await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).slice(-2).map((m) => m.text);
  assert.deepEqual(texts2, ['x[31my\tz', 'b]0;titleell']);
  const onBob = ((await bob.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).slice(-2).map((m) => m.text);
  assert.deepEqual(onBob, texts2);
});

test('FR-MSG-011 AC-1: while the host is away, the outbox message says what this PC already pasted', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  net.online.delete('alice');
  await bob.svc.postFromSession('b1', roomId, '여기서만');
  await net.idle();
  const outbox = (await bob.svc.getRoom(roomId, {}) as Rec).outbox as Rec[];
  assert.deepEqual(outbox.map((m) => m.localReceipt), [{ pasted: 1 }]);
});

test('FR-MSG-001 AC-1: sessions may be given as {sessionKey, enter}; enter defaults to on', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'one' }, { sessionKey: 'a2', name: 'two' }, { sessionKey: 'a3', name: 'three' }]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: [{ sessionKey: 'a1', enter: false }, 'a2'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  assert.equal((await alice.svc.invite(roomId, { sessions: [{ sessionKey: 'a3', enter: false }] }) as Rec).ok, true);
  const sessions = ((await alice.svc.getRoom(roomId, {}) as Rec).room as Rec).sessions as Rec[];
  assert.deepEqual(sessions.map((s) => [s.sessionKey, s.enter]), [['a1', false], ['a2', true], ['a3', false]]);
});

test('FR-MSG-004 AC-3: messages arriving together for one session go as one bracketed block when 2004 is on, else one by one', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  bob.bracketed.add('b1');
  bob.pastes.length = 0;
  net.online.delete('bob');
  for (const text of ['하나', '둘', '셋']) await alice.svc.postFromUi(roomId, text);
  net.online.add('bob');
  await bob.svc.tick();
  await net.idle();
  assert.deepEqual(texts(bob, 'b1'), ['[BG-ROOM:결제팀 | alice] 하나\n[BG-ROOM:결제팀 | alice] 둘\n[BG-ROOM:결제팀 | alice] 셋']);
  assert.deepEqual(texts(bob, 'b2'), ['하나', '둘', '셋'].map((t) => `[BG-ROOM:결제팀 | alice] ${t}`));
  const log = ((await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).slice(-3);
  assert.deepEqual(log.map((m) => (m.receipts as Rec).pasted), [3, 3, 3]);
});

test('FR-MSG-012 AC-1: members report how long the host was away; over 1 h in 7 days suggests moving (host view only)', async () => {
  const { net, alice, bob } = await trio();
  const roomId = await roomWithBob(net, alice, bob);
  net.online.delete('alice');
  await bob.svc.tick();
  net.clock += 61 * 60_000;
  net.online.add('alice');
  await bob.svc.tick();
  await net.idle();
  const hostView = (await alice.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.equal(hostView.moveSuggested, true);
  assert.equal(hostView.offlineHours7d, 1);
  const memberView = (await bob.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.equal(memberView.moveSuggested, undefined);
  net.clock += 8 * 24 * 3_600_000;
  const later = (await alice.svc.getRoom(roomId, {}) as Rec).room as Rec;
  assert.equal(later.moveSuggested, false);
  assert.equal(later.offlineHours7d, 0);
});

test('FR-MSG-004 AC-3 (real timing): messages arriving while a paste is in flight go as one block right after it; the first is never delayed', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'one' }]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: ['a1'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await net.idle();
  alice.bracketed.add('a1');
  alice.pastes.length = 0;
  alice.pasteMs = 300;
  const first = alice.svc.postFromUi(roomId, '첫째');
  let pastesWhenFirstAnswered = -1;
  void first.then(() => { pastesWhenFirstAnswered = alice.pastes.length; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = alice.svc.postFromUi(roomId, '둘째');
  const third = alice.svc.postFromUi(roomId, '셋째');
  const firstDone = await first;
  const [secondDone, thirdDone] = await Promise.all([second, third]);
  assert.deepEqual(texts(alice, 'a1'), ['[BG-ROOM:r | alice] 첫째', '[BG-ROOM:r | alice] 둘째\n[BG-ROOM:r | alice] 셋째']);
  for (const done of [firstDone, secondDone, thirdDone]) assert.deepEqual((done as Rec).delivery, { pasted: 1, waiting: 0 });
  // Not wall-clock thresholds (load-sensitive): the first answers on its own paste; three messages take two pastes.
  assert.equal(pastesWhenFirstAnswered, 1);
  assert.equal(alice.pastes.length, 2);
});

test('FR-MSG-004 AC-3: a message after the previous paste finished is not held back', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'one' }]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: ['a1'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await alice.svc.postFromUi(roomId, '하나');
  alice.sleeps.length = 0;
  await alice.svc.postFromUi(roomId, '둘');
  assert.deepEqual(alice.sleeps, []);
});
