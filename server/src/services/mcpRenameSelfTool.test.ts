// FR-MCP-029: buildergate.session.rename_self -- an agent renames its own session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';

type Rec = Record<string, unknown>;
const TOOL = 'buildergate.session.rename_self';

function setup() {
  const calls: Array<{ target: string; alias: string; actor: string | undefined }> = [];
  const service = createMcpToolService({
    setSessionAlias: async (target: string, alias: string, actor?: string) => {
      calls.push({ target, alias, actor });
      return { sessionKey: target, name: alias, nameSource: 'user' };
    },
  } as never) as { callTool: (r: unknown) => Promise<Rec>; listTools: () => Rec };
  const call = (args: Rec, actor: Rec = { type: 'mcp', sessionKey: 'me', scopes: ['mcp:self.read', 'mcp:status.write'] }) =>
    service.callTool({ name: TOOL, arguments: args, actor }).then((result) => (result.structuredContent ?? result) as Rec);
  return { service, call, calls };
}

test('FR-MCP-029 AC-1: the tool is listed and takes only a name', () => {
  const tool = (setup().service.listTools().tools as Rec[]).find((entry) => entry.name === TOOL);
  assert.ok(tool, 'listed');
  const schema = tool.inputSchema as Rec;
  assert.deepEqual(Object.keys(schema.properties as Rec), ['name']);
  assert.deepEqual(schema.required, ['name']);
});

test('FR-MCP-029 AC-1/AC-3: renames the session the connection is bound to, with the default agent scopes', async () => {
  const { call, calls } = setup();
  const result = await call({ name: '  총괄  ' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.name, '총괄');
  assert.equal(result.sessionKey, 'me');
  assert.deepEqual(calls, [{ target: 'me', alias: '총괄', actor: 'me' }]);
});

test('FR-MCP-029 AC-1: another session cannot be named through it', async () => {
  const { call, calls } = setup();
  await call({ name: 'x', sessionKey: 'other' });
  assert.ok(calls.every((entry) => entry.target === 'me'));
});

test('FR-MCP-029 AC-2: a bad name, a missing scope and an unbound connection are refused', async () => {
  const { call, calls } = setup();
  assert.equal((await call({ name: '   ' })).code, 'VALIDATION_ERROR');
  assert.equal((await call({ name: 'x'.repeat(33) })).code, 'VALIDATION_ERROR');
  assert.equal((await call({ name: 1 })).code, 'VALIDATION_ERROR');
  assert.equal((await call({ name: 'ok' }, { type: 'mcp', sessionKey: 'me', scopes: ['mcp:self.read'] })).code, 'INVALID_SCOPE');
  assert.equal((await call({ name: 'ok' }, { type: 'mcp', scopes: ['mcp:status.write'] })).code, 'UNBOUND_ACTOR');
  assert.equal(calls.length, 0);
});
