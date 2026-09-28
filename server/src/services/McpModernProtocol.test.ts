// IR-MCP-006: MCP revision 2026-07-28 (stateless) served next to the 2025-11-25 session protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHttpHandler, createMcpToolService, MCP_SUPPORTED_PROTOCOL_VERSIONS } from './McpToolService.js';
import { getFixedMcpAccessKeyScopes } from './McpSecurityContract.js';

type Rec = Record<string, unknown>;

const MODERN = '2026-07-28';

function createHandler() {
  const service = createMcpToolService({
    listSessions: () => [{ sessionKey: 'k-1', sessionId: 's-1', alias: 'build', bindingLifecycle: 'live' }],
  });
  const listenerController = {
    evaluateRequest: (request: Rec) => {
      const credential = (request.credential ?? {}) as Rec;
      return credential.token === 'good-key'
        ? { ok: true, actor: { type: 'mcp-fixed-access-key', scopes: getFixedMcpAccessKeyScopes() } }
        : { ok: false, code: 'INVALID_TOKEN', auditId: 'audit_x' };
    },
  };
  const handler = createMcpHttpHandler({ service, listenerController }) as { handleRequest: (r: unknown) => Promise<Rec> };
  return handler;
}

function modernBody(method: string, params: Rec = {}, id: unknown = 1, version = MODERN): Rec {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

function modernHeaders(body: Rec, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const params = (body.params ?? {}) as Rec;
  const meta = (params._meta ?? {}) as Rec;
  const headers: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'mcp-protocol-version': String(meta['io.modelcontextprotocol/protocolVersion']),
    'mcp-method': String(body.method),
    ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

async function post(handler: { handleRequest: (r: unknown) => Promise<Rec> }, body: Rec, headers: Record<string, string>, token = 'good-key') {
  const response = await handler.handleRequest({
    method: 'POST',
    path: '/mcp',
    headers,
    credential: token ? { type: 'mcp-capability', token } : undefined,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    remoteAddress: '127.0.0.1',
  });
  return { status: response.status as number, headers: (response.headers ?? {}) as Rec, body: response.body as Rec };
}

test('IR-MCP-006 AC-3: server/discover advertises versions, capabilities and identity', async () => {
  const handler = createHandler();
  const body = modernBody('server/discover');
  const response = await post(handler, body, modernHeaders(body));
  assert.equal(response.status, 200);
  const result = response.body.result as Rec;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, [...MCP_SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal((result.supportedVersions as string[])[0], MODERN);
  assert.ok((result.supportedVersions as string[]).includes('2025-11-25'));
  assert.ok((result.capabilities as Rec).tools);
  assert.equal(((result._meta as Rec)['io.modelcontextprotocol/serverInfo'] as Rec).name, 'BuilderGate MCP Server');
  assert.equal(typeof result.instructions, 'string');
  assert.equal(typeof result.ttlMs, 'number');
  assert.ok(['public', 'private'].includes(String(result.cacheScope)));
  assert.equal(response.headers['mcp-session-id'], undefined, 'no session is minted');
});

test('IR-MCP-006 AC-1/AC-4: stateless tools/list and tools/call with per-request Bearer', async () => {
  const handler = createHandler();
  const listBody = modernBody('tools/list');
  const list = await post(handler, listBody, modernHeaders(listBody));
  assert.equal(list.status, 200);
  const listResult = list.body.result as Rec;
  assert.equal(listResult.resultType, 'complete');
  assert.equal(listResult.cacheScope, 'private');
  assert.equal(typeof listResult.ttlMs, 'number');
  const names = (listResult.tools as Rec[]).map(tool => String(tool.name));
  assert.deepEqual(names, [...names].sort(), 'deterministic order');
  const again = await post(handler, listBody, modernHeaders(listBody));
  assert.deepEqual((again.body.result as Rec).tools, listResult.tools);

  const callBody = modernBody('tools/call', { name: 'buildergate.session.list', arguments: {} }, 2);
  const call = await post(handler, callBody, modernHeaders(callBody));
  assert.equal(call.status, 200);
  const callResult = call.body.result as Rec;
  assert.equal(callResult.resultType, 'complete');
  assert.ok(((callResult._meta as Rec)['io.modelcontextprotocol/serverInfo'] as Rec).name);
  assert.equal(call.headers['mcp-session-id'], undefined);

  const denied = await post(handler, callBody, modernHeaders(callBody), 'bad-key');
  assert.equal(denied.status, 403, 'each request authenticates on its own');
});

test('IR-MCP-006 AC-1: a Base64 sentinel Mcp-Name is decoded before comparison', async () => {
  const handler = createHandler();
  const callBody = modernBody('tools/call', { name: 'buildergate.session.list', arguments: {} });
  const encoded = `=?base64?${Buffer.from('buildergate.session.list', 'utf8').toString('base64')}?=`;
  const response = await post(handler, callBody, modernHeaders(callBody, { 'mcp-name': encoded }));
  assert.equal(response.status, 200);
});

test('IR-MCP-006 AC-2: header problems answer 400 / -32020', async () => {
  const handler = createHandler();
  const callBody = modernBody('tools/call', { name: 'buildergate.session.list', arguments: {} });
  for (const overrides of [
    { 'mcp-protocol-version': undefined },
    { 'mcp-protocol-version': '2025-11-25' },
    { 'mcp-method': undefined },
    { 'mcp-method': 'tools/list' },
    { 'mcp-name': undefined },
    { 'mcp-name': 'buildergate.session.search' },
  ]) {
    const response = await post(handler, callBody, modernHeaders(callBody, overrides));
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.equal((response.body.error as Rec).code, -32020, JSON.stringify(overrides));
    assert.equal(response.body.id, 1);
  }
});

test('IR-MCP-006 AC-2: unsupported version answers 400 / -32022 with supported and requested', async () => {
  const handler = createHandler();
  const body = modernBody('tools/list', {}, 7, '1900-01-01');
  const response = await post(handler, body, modernHeaders(body));
  assert.equal(response.status, 400);
  const error = response.body.error as Rec;
  assert.equal(error.code, -32022);
  assert.deepEqual((error.data as Rec).supported, [...MCP_SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal((error.data as Rec).requested, '1900-01-01');
});

test('IR-MCP-006 AC-2: unknown modern method answers 404 / -32601', async () => {
  const handler = createHandler();
  const body = modernBody('prompts/list');
  const response = await post(handler, body, modernHeaders(body));
  assert.equal(response.status, 404);
  assert.equal((response.body.error as Rec).code, -32601);
});

test('IR-MCP-006 AC-5: initialize keeps the legacy session and clamps the version', async () => {
  const handler = createHandler();
  const init = async (protocolVersion: string) => post(handler, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } },
  }, { 'content-type': 'application/json' });
  const legacy = await init('2025-06-18');
  assert.equal(legacy.status, 200);
  assert.equal((legacy.body.result as Rec).protocolVersion, '2025-06-18');
  assert.equal(typeof legacy.headers['mcp-session-id'], 'string');
  const unknown = await init('2099-01-01');
  assert.equal((unknown.body.result as Rec).protocolVersion, '2025-11-25');
});

test('IR-MCP-006 AC-6: tools/call results carry content, structuredContent and isError in both eras', async () => {
  const handler = createHandler();
  const ok = modernBody('tools/call', { name: 'buildergate.session.list', arguments: {} });
  const okResult = (await post(handler, ok, modernHeaders(ok))).body.result as Rec;
  assert.equal(okResult.isError, false);
  const content = okResult.content as Rec[];
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.deepEqual(JSON.parse(String(content[0].text)), okResult.structuredContent);
  assert.ok(Array.isArray((okResult.structuredContent as Rec).sessions));

  const failing = modernBody('tools/call', { name: 'buildergate.session.whoami', arguments: {} });
  const failResult = (await post(handler, failing, modernHeaders(failing))).body.result as Rec;
  assert.equal(failResult.isError, true);

  // Legacy era: the same wrapping, raw fields kept for existing callers.
  const init = await post(handler, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  }, { 'content-type': 'application/json' });
  const sessionId = String(init.headers['mcp-session-id']);
  const legacy = await post(handler, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buildergate.session.list', arguments: {} },
  }, { 'content-type': 'application/json', 'mcp-session-id': sessionId });
  const legacyResult = legacy.body.result as Rec;
  assert.equal(legacyResult.isError, false);
  assert.ok(Array.isArray(legacyResult.content));
  assert.ok(Array.isArray(legacyResult.sessions), 'raw fields stay for legacy callers');
});
