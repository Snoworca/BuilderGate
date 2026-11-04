// FR-MCP-022 (#235): the master's MCP tools treat every linked server as one -- lists merge the
// connected servers, items carry server and target, other tools take a server argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';
import { DEFAULT_PEER_LINK_SETTINGS } from './peer/peerLinkSettings.js';

type Rec = Record<string, unknown>;

const LOCAL_SESSIONS = [
  { sessionKey: 'k-lead', sessionId: 's-lead', alias: 'leader', bindingLifecycle: 'live' },
  { sessionKey: 'k-fix', sessionId: 's-fix', alias: 'git viewer 개선', bindingLifecycle: 'live' },
];
const ALL = ['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste', 'mcp:message.submit', 'mcp:workspaces.read', 'mcp:terminals.read'];

interface PeerBehaviour {
  state?: 'connected' | 'disconnected' | 'connecting';
  answer?: (tool: string, args: Rec) => Rec | Promise<Rec>;
}

function setup(peers: Record<string, PeerBehaviour>, options: { search?: (query: string) => Rec } = {}) {
  const calls: Array<{ peer: string; tool: string; arguments: Rec; scopes: string[] }> = [];
  const sent: Rec[] = [];
  const delivered: Rec[] = [];
  const peerLinks = {
    nodeName: () => 'master',
    hasPeer: (name: string) => name in peers,
    sendMessage: async (input: Rec) => { sent.push(input); return { ok: true, status: 'queued', messageId: 'm-1' }; },
    call: async (input: { peer: string; tool: string; arguments: Rec; scopes: string[] }) => {
      calls.push(input);
      const peer = peers[input.peer];
      if (!peer || peer.state !== undefined && peer.state !== 'connected') return { ok: false, code: 'PEER_DISCONNECTED', peer: input.peer };
      return peer.answer ? peer.answer(input.tool, input.arguments) : { ok: false, code: 'UNKNOWN_TOOL' };
    },
    list: () => Object.entries(peers).map(([name, peer]) => ({ name, direction: 'outbound', state: peer.state ?? 'connected', queued: 0 })),
    messageStatus: () => undefined,
  };
  const service = createMcpToolService({
    listSessions: () => LOCAL_SESSIONS,
    searchSessions: (_actor: string | undefined, query: string) => options.search?.(query) ?? { allowed: false, code: 'TARGET_NOT_FOUND', matches: [], candidates: [] },
    deliverMessage: (delivery: Rec) => { delivered.push(delivery); return { ok: true, status: 'delivered' }; },
    workspaceControl: {
      listWorkspaces: () => [{ id: 'ws-1', name: 'Main', sortOrder: 0 }],
      listTerminals: () => [],
    },
    peerLinks,
  } as never) as { callTool: (r: unknown) => Promise<Rec>; listTools: () => Rec };
  const callAs = (actor: Rec, name: string, args: Rec) => service.callTool({ name, arguments: args, actor });
  const call = (name: string, args: Rec, scopes = ALL) => callAs({ type: 'mcp', sessionKey: 'k-lead', scopes }, name, args);
  return { service, calls, sent, delivered, call, callAs };
}

const remoteSessions = (...aliases: string[]) => async (tool: string) => (tool === 'buildergate.session.list'
  ? { sessions: aliases.map((alias, i) => ({ sessionKey: `k-${alias}`, sessionId: `s-${i}`, alias, server: 'its-own-name' })) }
  : { ok: false, code: 'UNKNOWN_TOOL' });

test('FR-MCP-022 AC-1/AC-2: session.list merges the connected servers; every item names its server and target', async () => {
  const { call, calls } = setup({ 'pc-a': { answer: remoteSessions('worker') }, 'pc-b': { answer: remoteSessions('tester', 'docs') } });
  const result = await call('buildergate.session.list', {});
  const sessions = result.sessions as Rec[];
  assert.deepEqual(sessions.map((s) => [s.server, s.alias, s.target]), [
    ['master', 'leader', 'master/k-lead'],
    ['master', 'git viewer 개선', 'master/k-fix'],
    ['pc-a', 'worker', 'pc-a/k-worker'],
    ['pc-b', 'tester', 'pc-b/k-tester'],
    ['pc-b', 'docs', 'pc-b/k-docs'],
  ]);
  assert.deepEqual(result.unreachable, []);
  assert.deepEqual(calls.map((c) => [c.peer, c.tool]), [['pc-a', 'buildergate.session.list'], ['pc-b', 'buildergate.session.list']]);
  assert.deepEqual(calls[0]!.scopes, ALL, 'the caller scopes go along; the link narrows them');
});

test('FR-MCP-022 AC-3: a server that is down or slower than 3 s is left out and named in unreachable', async () => {
  const started = Date.now();
  const { call } = setup({
    'pc-a': { answer: remoteSessions('worker') },
    'pc-b': { state: 'disconnected' },
    'pc-c': { answer: () => new Promise<Rec>(() => undefined) },
    'pc-d': { answer: () => ({ ok: false, code: 'INVALID_SCOPE' }) },
  });
  const result = await call('buildergate.session.list', {});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2900 && elapsed < 4500, `waited ${elapsed} ms`);
  assert.deepEqual((result.sessions as Rec[]).map((s) => s.target), ['master/k-lead', 'master/k-fix', 'pc-a/k-worker']);
  assert.deepEqual(result.unreachable, [
    { server: 'pc-b', code: 'PEER_DISCONNECTED' },
    { server: 'pc-c', code: 'PEER_TIMEOUT' },
    { server: 'pc-d', code: 'INVALID_SCOPE' },
  ]);
});

test('FR-MCP-022 AC-1: workspace.list is merged too', async () => {
  const { call } = setup({ 'pc-a': { answer: () => ({ ok: true, workspaces: [{ workspaceId: 'w-9', name: 'Remote' }] }) } });
  const result = await call('buildergate.workspace.list', {});
  assert.deepEqual((result.workspaces as Rec[]).map((w) => [w.server, w.name]), [['master', 'Main'], ['pc-a', 'Remote']]);
});

test('FR-MCP-022 AC-9: search merges by score across servers, keeps score and matchType, and limits the matches', async () => {
  const match = (key: string, score: number) => ({ sessionKey: key, sessionId: `s-${key}`, alias: key, score, matchType: 'word-alias', matchSource: 'user-alias' });
  const many = Array.from({ length: 25 }, (_, i) => match(`r${i}`, 300 - i));
  const { call, calls } = setup(
    { 'pc-a': { answer: () => ({ allowed: true, matches: [match('best', 600), ...many] }) } },
    { search: () => ({ allowed: true, matches: [match('local', 510)] }) },
  );
  const result = await call('buildergate.session.search', { query: '복구 판단' });
  assert.equal(result.allowed, true);
  const matches = result.matches as Rec[];
  assert.equal(matches.length, 10, 'default limit');
  assert.equal(result.total, 27);
  assert.deepEqual(matches.slice(0, 2).map((m) => [m.target, m.score, m.matchType]), [['pc-a/best', 600, 'word-alias'], ['master/local', 510, 'word-alias']]);
  assert.equal(calls[0]!.arguments.query, '복구 판단');
  assert.equal(((await call('buildergate.session.search', { query: 'x', limit: 50 })).matches as Rec[]).length, 20, 'at most 20');
  assert.equal(((await call('buildergate.session.search', { query: 'x', limit: 3 })).matches as Rec[]).length, 3);
});

test('FR-MCP-022 AC-9: equal top scores on two servers are ambiguous; the local one comes first', async () => {
  const match = (key: string) => ({ sessionKey: key, sessionId: `s-${key}`, alias: 'build', score: 1000, matchType: 'exact-alias', matchSource: 'user-alias' });
  const { call } = setup({ 'pc-a': { answer: () => ({ allowed: true, matches: [match('remote')] }) } }, { search: () => ({ allowed: true, matches: [match('local')] }) });
  const result = await call('buildergate.session.search', { query: 'build' });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AMBIGUOUS_TARGET');
  assert.deepEqual((result.candidates as Rec[]).map((m) => m.target), ['master/local', 'pc-a/remote']);
});

test('FR-MCP-022 AC-3/AC-9: nothing found anywhere is TARGET_NOT_FOUND with the unreachable servers', async () => {
  const { call } = setup({ 'pc-a': { answer: () => ({ allowed: false, code: 'TARGET_NOT_FOUND', matches: [] }) }, 'pc-b': { state: 'disconnected' } });
  const result = await call('buildergate.session.search', { query: 'nothing' });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'TARGET_NOT_FOUND');
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unreachable, [{ server: 'pc-b', code: 'PEER_DISCONNECTED' }]);
});

test('FR-MCP-022 AC-4: server picks where a tool runs; this server or none runs here; an unknown name is refused', async () => {
  const { call, calls } = setup({ 'pc-a': { answer: (tool, args) => ({ ok: true, ranOn: 'pc-a', tool, args }) } });
  const remote = await call('buildergate.terminal.list', { server: 'pc-a', workspaceName: 'Remote' });
  assert.equal(remote.ranOn, 'pc-a');
  assert.deepEqual(calls[0]!.arguments, { workspaceName: 'Remote' }, 'server is taken off');
  const here = await call('buildergate.workspace.list', { server: 'master' });
  assert.deepEqual((here.workspaces as Rec[]).map((w) => w.name), ['Main']);
  assert.equal(calls.length, 1, 'naming this server runs here only');
  const unknown = await call('buildergate.workspace.list', { server: 'nowhere' });
  assert.equal(unknown.code, 'SERVER_NOT_FOUND');
});

test('FR-MCP-022 AC-2/AC-4: message.send takes "<server>/<key>", server as a prefix, and this server name', async () => {
  const { call, sent, delivered } = setup({ 'pc-a': {} });
  await call('buildergate.message.send', { target: 'pc-a/k-worker', prompt: 'hi' });
  await call('buildergate.message.send', { server: 'pc-a', target: 'k-worker', prompt: 'hi' });
  assert.deepEqual(sent.map((s) => (s.args as Rec).target), ['k-worker', 'k-worker']);
  const local = await call('buildergate.message.send', { target: 'master/k-fix', prompt: 'hi' });
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.equal(delivered.length, 1);
});

test('FR-MCP-022 AC-5: a request that came over a link gets this server only and cannot pick a remote', async () => {
  const { callAs, calls } = setup({ 'pc-a': { answer: remoteSessions('worker') } });
  const peerActor = { type: 'mcp-peer', peer: 'corp', scopes: ALL };
  const listed = await callAs(peerActor, 'buildergate.session.list', {});
  assert.deepEqual((listed.sessions as Rec[]).map((s) => s.target), ['master/k-lead', 'master/k-fix']);
  assert.equal(calls.length, 0);
  const picked = await callAs(peerActor, 'buildergate.workspace.list', { server: 'pc-a' });
  assert.equal(picked.code, 'PEER_RELAY_REFUSED');
});

test('FR-MCP-022 AC-6: tools/list shows a server property on the tools that take it', async () => {
  const { service } = setup({});
  const tools = (service.listTools().tools as Rec[]);
  const schemaOf = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as Rec).properties as Rec;
  for (const name of ['buildergate.session.list', 'buildergate.session.search', 'buildergate.message.send', 'buildergate.terminal.list']) {
    assert.ok(schemaOf(name).server, name);
  }
  for (const name of ['buildergate.session.whoami', 'buildergate.session.claim', 'buildergate.peer.call']) {
    assert.equal(schemaOf(name).server, undefined, name);
  }
  const description = String(tools.find((t) => t.name === 'buildergate.session.search')!.description);
  assert.match(description, /linked|connected/i);
});

test('FR-MCP-022 AC-10: requests over a link may search sessions by default', () => {
  assert.ok(DEFAULT_PEER_LINK_SETTINGS.inboundScopes.includes('mcp:sessions.search'));
});

test('FR-MCP-022 AC-4 (review H1/L2): server with sessionKey or alias and no target goes to that server; no double prefix', async () => {
  const { call, sent, delivered } = setup({ 'pc-a': {} });
  await call('buildergate.message.send', { server: 'pc-a', alias: 'worker', prompt: 'hi' });
  await call('buildergate.message.send', { server: 'pc-a', sessionKey: 'k-worker', prompt: 'hi' });
  await call('buildergate.message.send', { server: 'pc-a', target: 'pc-a/k-worker', prompt: 'hi' });
  assert.deepEqual(sent.map((s) => (s.args as Rec).target), ['worker', 'k-worker', 'k-worker']);
  assert.equal(delivered.length, 0, 'nothing reached a local session');
  const unknown = await call('buildergate.message.send', { server: 'nowhere', target: 'k-fix', prompt: 'hi' });
  assert.equal(unknown.code, 'SERVER_NOT_FOUND');
  const none = await call('buildergate.message.send', { server: 'pc-a', prompt: 'hi' });
  assert.equal(none.code, 'VALIDATION_ERROR');
  assert.equal(delivered.length, 0);
});

test('FR-MCP-022 AC-1 (review M2): a linked server named like this one is left out of merged lists', async () => {
  const { call, calls } = setup({ master: { answer: remoteSessions('impostor') }, 'pc-a': { answer: remoteSessions('worker') } });
  const result = await call('buildergate.session.list', {});
  assert.deepEqual((result.sessions as Rec[]).map((s) => s.target), ['master/k-lead', 'master/k-fix', 'pc-a/k-worker']);
  assert.deepEqual(result.unreachable, [{ server: 'master', code: 'PEER_NAME_IS_SELF' }]);
  assert.ok(!calls.some((c) => c.peer === 'master'));
  const local = await call('buildergate.message.send', { target: 'master/k-fix', prompt: 'hi' });
  assert.equal(local.ok, true, 'this server name still means this server');
});

test('FR-MCP-022 AC-3 (review M4): a list this server cannot answer still merges the servers that can', async () => {
  const { call } = setup({ 'pc-a': { answer: () => ({ ok: true, terminals: [{ terminalId: 't-1', workspaceName: 'Remote' }] }) } });
  const result = await call('buildergate.terminal.list', { workspaceName: 'Remote' });
  assert.deepEqual((result.terminals as Rec[]).map((t) => [t.server, t.terminalId]), [['pc-a', 't-1']]);
  assert.deepEqual(result.unreachable, [{ server: 'master', code: 'TARGET_NOT_FOUND' }]);
  const nowhere = setup({}).call('buildergate.terminal.list', { workspaceName: 'Remote' });
  assert.equal((await nowhere).code, 'TARGET_NOT_FOUND', 'with no answer anywhere the local error stands');
});

test('FR-MCP-022 AC-9 (review L1): total counts what each server found, not only what it sent', async () => {
  const match = (key: string, score: number) => ({ sessionKey: key, sessionId: `s-${key}`, alias: key, score });
  const { call } = setup({ 'pc-a': { answer: () => ({ allowed: true, matches: [match('a', 500), match('b', 400)], total: 40 }) } }, { search: () => ({ allowed: true, matches: [match('l', 300)] }) });
  const result = await call('buildergate.session.search', { query: 'x' });
  assert.equal(result.total, 41);
});
