// FR-MCP-021 (#234): buildergate.file.upload_url, the MCP tool that opens a one-use upload URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';

type Rec = Record<string, unknown>;

function setup(origin?: string) {
  const opened: string[] = [];
  const service = createMcpToolService({
    listSessions: () => [],
    fileUploads: {
      open: async (sessionId: string) => {
        opened.push(sessionId);
        return sessionId === 's-1'
          ? { ok: true, path: '/mcp/fu?t=abc', directory: '/work/proj', expiresAt: '2026-11-04T00:10:00.000Z' }
          : { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { sessionId: 'not a live session' } };
      },
    },
    mcpOrigin: () => 'http://127.0.0.1:3333',
  } as never) as { callTool: (r: unknown) => Promise<Rec>; listTools: () => Rec };
  const call = (scopes: string[], args: Rec) => service.callTool({
    name: 'buildergate.file.upload_url', arguments: args, actor: { type: 'mcp', scopes }, origin,
  });
  return { service, opened, call };
}

const SUBMIT = ['mcp:message.submit'];

test('FR-MCP-021 AC-2: the URL is built on the address the MCP request came to', async () => {
  const { call } = setup('https://azure.example:3333');
  const result = await call(SUBMIT, { sessionId: 's-1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.url, 'https://azure.example:3333/mcp/fu?t=abc');
  assert.equal(result.path, '/mcp/fu?t=abc');
  assert.equal(result.directory, '/work/proj');
  assert.match(String(result.usage), /curl -T/);
});

test('FR-MCP-021 AC-2: without a request address (a call over a peer link) the listener address is used', async () => {
  const { call } = setup(undefined);
  assert.equal((await call(SUBMIT, { sessionId: 's-1' })).url, 'http://127.0.0.1:3333/mcp/fu?t=abc');
});

test('FR-MCP-021 AC-1: sessionId is required, the session must be live, and the submit scope is needed', async () => {
  const { call, opened } = setup('http://h');
  assert.equal((await call(SUBMIT, {})).code, 'VALIDATION_ERROR');
  assert.equal((await call(SUBMIT, { sessionId: 's-gone' })).code, 'VALIDATION_ERROR');
  assert.equal((await call(['mcp:message.paste'], { sessionId: 's-1' })).ok, false);
  assert.deepEqual(opened, ['s-gone']);
});

test('FR-MCP-021: the tool is listed and requires sessionId', () => {
  const { service } = setup();
  const tool = (service.listTools().tools as Rec[]).find((entry) => entry.name === 'buildergate.file.upload_url')!;
  assert.ok(tool, 'listed');
  assert.deepEqual((tool.inputSchema as Rec).required, ['sessionId']);
  assert.match(String(tool.description), /once/);
});

test('FR-MCP-021 AC-7: the listener judges an upload address by its IP list alone', async () => {
  const { createMcpListenerController } = await import('./McpToolService.js');
  const controller = (whitelist: string[]) => createMcpListenerController({
    current: { enabled: true, bindMode: 'whitelist', bindHost: '0.0.0.0', port: 3333, externalWhitelist: whitelist, transportSecurity: 'direct_tls', listenerStatus: 'listening' },
  }) as { evaluateAddress: (request: unknown) => Rec };
  const listed = controller(['10.0.0.0/8']);
  assert.equal(listed.evaluateAddress({ remoteAddress: '10.1.2.3', headers: {} }).ok, true);
  assert.equal(listed.evaluateAddress({ remoteAddress: '::ffff:192.168.1.5', headers: {} }).ok, false);
  assert.equal(controller(['*']).evaluateAddress({ remoteAddress: '203.0.113.9', headers: {} }).ok, true);
});
