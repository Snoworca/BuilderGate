// FR-MCP-012: buildergate.notify sends a notification to the user's open browser pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';
import { getDefaultMcpSessionScopes, getFixedMcpAccessKeyScopes } from './McpSecurityContract.js';

type Rec = Record<string, unknown>;

const SESSIONS = [
  { sessionKey: 'k-work', sessionId: 's-work', alias: 'worker', workspaceId: 'ws-1', tabId: 'tab-7', bindingLifecycle: 'live' },
];

function setup(connected = 2) {
  const sent: Rec[] = [];
  let clock = 0;
  const service = createMcpToolService({
    listSessions: () => SESSIONS,
    notifyBrowsers: (payload: Rec) => { sent.push(payload); return connected; },
    nowMs: () => clock,
  }) as { callTool: (r: unknown) => Promise<Rec>; listTools: () => Rec };
  const notify = (actor: Rec, args: Rec) => service.callTool({ name: 'buildergate.notify', arguments: args, actor });
  return { service, sent, notify, advance: (ms: number) => { clock += ms; } };
}

const sessionActor = { type: 'mcp', sessionKey: 'k-work', scopes: getDefaultMcpSessionScopes() };
const fixedKeyActor = { type: 'mcp-fixed-access-key', scopes: getFixedMcpAccessKeyScopes() };

test('FR-MCP-012 AC-1: a session caller sends the notification with its sender to every page', async () => {
  const { notify, sent } = setup(3);
  const result = await notify(sessionActor, { title: 'Build done', body: 'All 533 tests pass', level: 'success' });
  assert.equal(result.ok, true);
  assert.equal(result.deliveredTo, 3);
  assert.equal(typeof result.notificationId, 'string');
  assert.equal(sent.length, 1);
  const payload = sent[0];
  assert.equal(payload.id, result.notificationId);
  assert.equal(payload.title, 'Build done');
  assert.equal(payload.body, 'All 533 tests pass');
  assert.equal(payload.level, 'success');
  assert.equal(typeof payload.at, 'string');
  assert.deepEqual(payload.from, { alias: 'worker', sessionKey: 'k-work', workspaceId: 'ws-1', tabId: 'tab-7' });
});

test('FR-MCP-012 AC-1: the fixed key has no sender, level defaults to info, body is optional', async () => {
  const { notify, sent } = setup(0);
  const result = await notify(fixedKeyActor, { title: 'Hi' });
  assert.equal(result.ok, true);
  assert.equal(result.deliveredTo, 0, 'no page open');
  assert.equal(sent[0].level, 'info');
  assert.equal(sent[0].body, '');
  assert.equal(sent[0].from, null);
});

test('FR-MCP-012 AC-1: invalid arguments are refused and nothing is sent', async () => {
  const { notify, sent } = setup();
  for (const args of [{}, { title: '' }, { title: '   ' }, { title: 'x'.repeat(101) }, { title: 'ok', body: 'x'.repeat(501) }, { title: 'ok', level: 'loud' }]) {
    assert.equal((await notify(sessionActor, args)).code, 'VALIDATION_ERROR', JSON.stringify(args).slice(0, 40));
  }
  assert.equal(sent.length, 0);
});

test('FR-MCP-012 AC-2: more than 6 calls a minute by one caller are rate limited', async () => {
  const { notify, sent, advance } = setup();
  for (let i = 0; i < 6; i += 1) assert.equal((await notify(sessionActor, { title: `n${i}` })).ok, true);
  assert.equal((await notify(sessionActor, { title: 'n7' })).code, 'RATE_LIMITED');
  assert.equal((await notify(fixedKeyActor, { title: 'other caller' })).ok, true, 'limits are per caller');
  advance(60_001);
  assert.equal((await notify(sessionActor, { title: 'later' })).ok, true);
  assert.equal(sent.length, 8);
});

test('FR-MCP-012 AC-3: both default scope sets hold mcp:notify, and a caller without it is refused', async () => {
  assert.ok(getDefaultMcpSessionScopes().includes('mcp:notify'));
  assert.ok(getFixedMcpAccessKeyScopes().includes('mcp:notify'));
  const { notify, sent } = setup();
  assert.equal((await notify({ type: 'mcp', sessionKey: 'k-work', scopes: ['mcp:sessions.list'] }, { title: 'x' })).code, 'INVALID_SCOPE');
  assert.equal(sent.length, 0);
});

test('FR-MCP-012 AC-1: tools/list advertises notify with its schema', () => {
  const { service } = setup();
  const tool = (service.listTools().tools as Rec[]).find(t => t.name === 'buildergate.notify');
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool!.inputSchema as Rec).properties as Rec).sort(), ['body', 'level', 'title']);
});
