// FR-MSG-007: buildergate.room.* for session-bound agents, through McpToolService.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';
import { getDefaultMcpSessionScopes } from './McpSecurityContract.js';
import { FakeNetwork } from './messenger/testHarness.js';
import { takesServerArgument } from './McpFederation.js';

type Rec = Record<string, unknown>;

async function setup() {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [
    { sessionKey: 'a1', name: 'worker' },
    { sessionKey: 'a2', name: 'my build' },
    { sessionKey: 'a3', name: 'outsider' },
  ]);
  const bob = await net.add('bob', [{ sessionKey: 'b1', name: 'api' }]);
  net.befriend('alice', 'bob');
  const created = await alice.svc.createRoom({ name: '결제팀', sessions: ['a1', 'a2'], people: ['bob'] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  await net.idle();
  await bob.svc.acceptInvite(bob.svc.state().invites[0]!.id, { sessions: ['b1'], personOnly: false });
  await net.idle();
  const tools = createMcpToolService({ roomControl: alice.svc }) as { callTool: (request: unknown) => Promise<Rec>; listTools: () => Rec };
  const call = (name: string, args: Rec, sessionKey: string | null = 'a1', scopes = getDefaultMcpSessionScopes()) =>
    tools.callTool({ name, arguments: args, actor: { type: 'mcp', ...(sessionKey ? { sessionKey } : {}), scopes } });
  return { net, alice, bob, roomId, tools, call };
}

test('FR-MSG-007 AC-4: tools/list carries the four room tools and says how to treat room messages', async () => {
  const { tools } = await setup();
  const listed = (tools.listTools().tools as Rec[]).filter((tool) => String(tool.name).startsWith('buildergate.room.'));
  assert.deepEqual(listed.map((tool) => tool.name).sort(), ['buildergate.room.history', 'buildergate.room.list', 'buildergate.room.members', 'buildergate.room.send']);
  const send = listed.find((tool) => tool.name === 'buildergate.room.send')!;
  const text = String(send.description);
  for (const phrase of ['[BG-ROOM:', 'room.send', 'waiting-host', 'held']) assert.ok(text.includes(phrase), phrase);
  assert.ok(/not.*instruction|information/i.test(text));
  assert.equal(((send.inputSchema as Rec).properties as Rec).server, undefined);
  assert.equal(takesServerArgument('buildergate.room.send'), false);
});

test('FR-MSG-007 AC-1: room.list shows the calling session\'s rooms; room.members gives mention texts', async () => {
  const { call, roomId } = await setup();
  const listed = await call('buildergate.room.list', {});
  assert.equal(listed.ok, true);
  assert.deepEqual((listed.rooms as Rec[]).map((room) => [room.name, room.id]), [['결제팀', roomId]]);
  assert.deepEqual((await call('buildergate.room.list', {}, 'a3')).rooms, []);
  const members = await call('buildergate.room.members', { room: '결제팀' });
  assert.deepEqual((members.people as Rec[]).map((p) => p.name), ['alice', 'bob']);
  assert.deepEqual((members.sessions as Rec[]).map((s) => s.mention), ['@worker', '@"my build"', '@bob::api']);
});

test('FR-MSG-007 AC-2/AC-3: room.send then room.history', async () => {
  const { call, net, bob } = await setup();
  const sent = await call('buildergate.room.send', { room: '결제팀', text: '빌드 끝', to: ['@bob::api'] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.status, 'sequenced');
  assert.equal(sent.held, false);
  assert.equal(typeof sent.messageId, 'string');
  await net.idle();
  assert.deepEqual(bob.pastes.map((p) => p.text).at(-1), '[BG-ROOM:결제팀 | alice::worker → @api] 빌드 끝');
  const history = await call('buildergate.room.history', { room: '결제팀', limit: 1 });
  assert.deepEqual((history.messages as Rec[]).map((m) => m.text), ['빌드 끝']);
  const after = await call('buildergate.room.history', { room: '결제팀', after: 0, limit: 2 });
  assert.deepEqual((after.messages as Rec[]).map((m) => m.seq), [1, 2]);
});

test('FR-MSG-007 AC-4: NOT_IN_ROOM, ROOM_NOT_FOUND, AMBIGUOUS_ROOM, mention errors, scopes and unbound actors', async () => {
  const { call, alice } = await setup();
  assert.equal((await call('buildergate.room.send', { room: '결제팀', text: 'x' }, 'a3')).code, 'NOT_IN_ROOM');
  assert.equal((await call('buildergate.room.members', { room: 'nope' })).code, 'ROOM_NOT_FOUND');
  await alice.svc.createRoom({ name: '결제팀', sessions: ['a1'], people: [] });
  assert.equal((await call('buildergate.room.history', { room: '결제팀' })).code, 'AMBIGUOUS_ROOM');
  const [first] = (await call('buildergate.room.list', {})).rooms as Rec[];
  assert.equal((await call('buildergate.room.send', { room: first!.id, text: '@ghost hi' })).code, 'TARGET_NOT_FOUND');
  assert.equal((await call('buildergate.room.send', { room: first!.id, text: 'hi' }, 'a1', ['mcp:sessions.list'])).code, 'INVALID_SCOPE');
  assert.equal((await call('buildergate.room.list', {}, 'a1', ['mcp:message.paste'])).code, 'INVALID_SCOPE');
  assert.equal((await call('buildergate.room.list', {}, null)).code, 'UNBOUND_ACTOR');
});
