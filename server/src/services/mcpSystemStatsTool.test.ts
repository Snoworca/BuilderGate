// FR-MCP-028: buildergate.system.stats -- one item per server, merged over the linked servers so a
// leading session sees every server's load in one call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';

type Rec = Record<string, unknown>;
const TOOL = 'buildergate.system.stats';
const LOCAL = { hostname: 'DESKTOP-LCF0D3R', platform: 'win32', cpu: { model: 'AMD Ryzen 9', cores: 32, usagePercent: 60 } };
const REMOTE = { hostname: 'beom-5700g', platform: 'linux', cpu: { model: 'AMD Ryzen 7 5700G', cores: 16, usagePercent: 10 } };

function setup(options: { stats?: boolean; peers?: Record<string, 'connected' | 'disconnected'> } = {}) {
  const peers = options.peers ?? {};
  const peerLinks = {
    nodeName: () => 'master',
    hasPeer: (name: string) => name in peers,
    sendMessage: async () => ({ ok: true }),
    call: async (input: { peer: string; tool: string }) => (input.tool === TOOL ? { ok: true, servers: [{ ...REMOTE }] } : { ok: false, code: 'UNKNOWN_TOOL' }),
    list: () => Object.entries(peers).map(([name, state]) => ({ name, direction: 'outbound', state, queued: 0 })),
    messageStatus: () => undefined,
  };
  const service = createMcpToolService({
    ...(options.stats === false ? {} : { systemStats: { snapshot: async () => ({ ...LOCAL }) } }),
    peerLinks,
  } as never) as { callTool: (r: unknown) => Promise<Rec>; listTools: () => Rec };
  const call = (args: Rec, scopes = ['mcp:sessions.list']) => service.callTool({ name: TOOL, arguments: args, actor: { type: 'mcp', sessionKey: 'k', scopes } })
    .then((result) => (result.structuredContent ?? result) as Rec);
  return { service, call };
}

test('FR-MCP-028 AC-1: the tool is listed and takes a server argument', () => {
  const { service } = setup();
  const tools = (service.listTools().tools as Rec[]);
  const tool = tools.find((entry) => entry.name === TOOL);
  assert.ok(tool, 'listed');
  assert.ok(((tool.inputSchema as Rec).properties as Rec).server, 'takes server');
  assert.match(String(tool.description), /CPU/);
});

test('FR-MCP-028 AC-1: this server answers one item in servers', async () => {
  const { call } = setup();
  const result = await call({});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((result.servers as Rec[]).map((item) => [item.server, item.hostname]), [['master', 'DESKTOP-LCF0D3R']]);
});

test('FR-MCP-028 AC-1: it needs mcp:sessions.list, and says so when stats are not available', async () => {
  assert.equal((await setup().call({}, ['mcp:message.paste'])).code, 'INVALID_SCOPE');
  assert.equal((await setup({ stats: false }).call({})).code, 'SYSTEM_STATS_UNAVAILABLE');
});

test('FR-MCP-028 AC-5: without a server argument every connected server answers; the others are unreachable', async () => {
  const { call } = setup({ peers: { 'beom-5700g': 'connected', 'gpu-vm': 'disconnected' } });
  const result = await call({});
  assert.deepEqual((result.servers as Rec[]).map((item) => [item.server, item.hostname]), [
    ['master', 'DESKTOP-LCF0D3R'],
    ['beom-5700g', 'beom-5700g'],
  ]);
  assert.deepEqual((result.unreachable as Rec[]).map((entry) => [entry.server, entry.code]), [['gpu-vm', 'PEER_DISCONNECTED']]);
  const one = await call({ server: 'beom-5700g' });
  assert.deepEqual((one.servers as Rec[]).map((item) => item.server), ['beom-5700g']);
});
