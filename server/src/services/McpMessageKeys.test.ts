// FR-MCP-015 (#232): keys -- named keys and key combinations sent to the target session. Since
// FR-MCP-023 they go through buildergate.terminal.input, never with text and never with a sender tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';

type Rec = Record<string, unknown>;

const SESSIONS = [
  { sessionKey: 'k-lead', sessionId: 's-lead', alias: 'leader', bindingLifecycle: 'live' },
  { sessionKey: 'k-work', sessionId: 's-work', alias: 'worker', bindingLifecycle: 'live', leaderSessionKey: 'k-lead' },
];

function setup() {
  const delivered: Rec[] = [];
  const service = createMcpToolService({
    listSessions: () => SESSIONS,
    deliverMessage: (delivery: Rec) => { delivered.push(delivery); return { ok: true, status: 'delivered' }; },
  }) as { callTool: (r: unknown) => Promise<Rec>; listTools: () => Rec };
  const send = (scopes: string[], args: Rec) => service.callTool({
    name: 'buildergate.terminal.input',
    arguments: { target: 'worker', ...args },
    actor: { type: 'mcp', sessionKey: 'k-lead', scopes },
  });
  return { service, delivered, send };
}

const FULL = ['mcp:message.paste', 'mcp:message.submit', 'mcp:sessions.list'];
const PASTE_ONLY = ['mcp:message.paste', 'mcp:sessions.list'];
const keyNames = (delivery: Rec | undefined) => ((delivery?.keys ?? []) as Rec[]).map((key) => key.name);

test('FR-MCP-015 AC-1: keys alone are sent, with no prompt and no sender tag', async () => {
  const { delivered, send } = setup();
  const result = await send(FULL, { keys: ['down', 'Down', 'enter'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.prompt, '');
  assert.deepEqual(keyNames(delivered[0]), ['down', 'down', 'enter']);
});

test('FR-MCP-015 AC-1: neither a prompt nor keys is a validation error', async () => {
  const { delivered, send } = setup();
  const result = await send(FULL, {});
  assert.equal(result.code, 'VALIDATION_ERROR');
  assert.equal(delivered.length, 0);
});

test('FR-MCP-015 AC-4: an unknown or ambiguous key sends nothing and names a replacement', async () => {
  const { delivered, send } = setup();
  const result = await send(FULL, { keys: ['down', 'shift+enter'] });
  assert.equal(result.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(result.fieldErrors), /newline/);
  assert.equal(delivered.length, 0);
});

test('FR-MCP-015 AC-5: a key that submits needs the submit scope; other keys do not', async () => {
  const { delivered, send } = setup();
  const denied = await send(PASTE_ONLY, { keys: ['down', 'enter'] });
  assert.equal(denied.ok, false);
  assert.equal(delivered.length, 0);
  const newline = await send(PASTE_ONLY, { keys: ['newline'] });
  assert.equal(newline.ok, false);
  const allowed = await send(PASTE_ONLY, { keys: ['down', 'esc', 'ctrl+c', 'shift+tab'] });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.deepEqual(keyNames(delivered[0]), ['down', 'esc', 'ctrl+c', 'shift+tab']);
});

test('FR-MCP-015: the terminal.input schema offers keys and requires no prompt', () => {
  const { service } = setup();
  const tool = (service.listTools().tools as Rec[]).find((entry) => entry.name === 'buildergate.terminal.input')!;
  const schema = tool.inputSchema as Rec;
  assert.equal(((schema.properties as Rec).keys as Rec).type, 'array');
  assert.match(String(((schema.properties as Rec).keys as Rec).description), /shift\+tab|newline/);
  assert.equal(((schema.required ?? []) as string[]).includes('prompt'), false);
});
