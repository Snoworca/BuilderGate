// FR-MCP-025: an agent already connected with the MCP key binds that same connection to its
// BuilderGate session with one buildergate.session.claim call -- no second MCP entry, no reconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultMcpSessionScopes, getFixedMcpAccessKeyScopes, verifyMcpCapabilityToken } from './McpSecurityContract.js';
import { createMcpHttpHandler, createMcpListenerController, createMcpToolService } from './McpToolService.js';
import { classifyMcpBearerCredential } from './McpNodeHttpListener.js';
import { mintMcpCapabilityToken } from './McpSecurityContract.js';

const realTokens: string[] = [];
function mintToken(request: Rec, _label: string): string {
  const token = String((mintMcpCapabilityToken(request as never) as Rec).token);
  realTokens.push(token);
  return token;
}

type Rec = Record<string, unknown>;

// A tool only the MCP key may use (mcp:workspaces.write, SEC-MCP-004).
const KEY_ONLY_TOOL = 'buildergate.workspace.rename';
const KEY_ONLY_ARGS = { workspaceId: 'ws-1', name: 'x' };

const SESSION = {
  sessionId: 'sess-1',
  sessionKey: 'key-1',
  workspaceId: 'ws-1',
  tabId: 'tab-1',
  alias: 'agent',
  agentKind: 'claude',
  bindingLifecycle: 'live',
  agentStatus: 'ready',
  mcpConnected: true,
};

type Caller = { sessionKey: string; sessionId: string; agent: boolean };
const AGENT: Caller = { sessionKey: 'key-1', sessionId: 'sess-1', agent: true };
const NOT_AGENT: Caller = { ...AGENT, agent: false };

function setup(options: { resolveCallerSession?: (request: Rec) => Promise<Caller | undefined>; tokenStore?: Rec } = {}) {
  let fixedKey = 'bgmcp_old';
  const claimCodes = new Map<string, Rec>();
  const issue = (code: string, sessionKey = SESSION.sessionKey) => claimCodes.set(code, {
    claimCode: code, sessionKey, used: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const service = createMcpToolService({
    claimCodes,
    sessions: [SESSION],
    resolveClaimSession: (sessionKey: string) => (sessionKey === SESSION.sessionKey ? SESSION : undefined),
    ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
  } as never);
  const listenerController = createMcpListenerController({
    current: { bindHost: '127.0.0.1', port: 3333, generation: 1 },
    resolveFixedAccessKeyActor: (token: string) => (token === fixedKey
      ? { type: 'mcp-fixed-access-key', scopes: getFixedMcpAccessKeyScopes() }
      : undefined),
    ...(options.tokenStore ? { isCredentialRevoked: options.tokenStore.isRevoked } : {}),
  } as never);
  const handler = createMcpHttpHandler({ service, listenerController, resolveCallerSession: options.resolveCallerSession } as never) as Rec;
  let id = 0;
  const post = async (body: Rec, sessionId?: string, bearer: string | null = fixedKey): Promise<Rec> => (await (handler.handleRequest as (r: unknown) => Promise<Rec>)({
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    credential: bearer ? classifyMcpBearerCredential(bearer) : undefined,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: ++id, ...body }), 'utf8'),
    remoteAddress: '127.0.0.1',
    localPort: 3333,
    remotePort: 52344,
    // The node listener names every socket (McpNodeHttpListener connectionIdOf).
    connectionId: 'c1',
  }));
  const connect = async (bearer: string | null = fixedKey): Promise<string> => {
    const init = await post({ method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Claude Code', version: '2' } } }, undefined, bearer);
    assert.equal(init.status, 200, JSON.stringify(init.body));
    return String((init.headers as Rec)['mcp-session-id']);
  };
  const call = async (sessionId: string, name: string, args: Rec = {}, bearer?: string | null): Promise<Rec> => {
    const response = await post({ method: 'tools/call', params: { name, arguments: args } }, sessionId, bearer);
    const body = response.body as Rec;
    if (body.error) return { transportError: body.error, status: response.status };
    const result = body.result as Rec;
    return (result.structuredContent ?? result) as Rec;
  };
  return { issue, connect, call, rotate: (next: string) => { fixedKey = next; } };
}

test('FR-MCP-025 AC-1: claim over the MCP-key connection binds that connection; no token in the answer', async () => {
  const mcp = setup();
  const sessionId = await mcp.connect();
  assert.equal((await mcp.call(sessionId, 'buildergate.session.whoami')).code, 'UNBOUND_ACTOR');
  mcp.issue('claim_a');
  const claimed = await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_a', sessionKey: SESSION.sessionKey });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.actorToken, undefined, 'the token stays on the server side of this connection');
  const whoami = await mcp.call(sessionId, 'buildergate.session.whoami');
  // whoami answers the session record itself (no ok field).
  assert.equal(whoami.sessionKey, SESSION.sessionKey, JSON.stringify(whoami));
  assert.equal(whoami.code, undefined, JSON.stringify(whoami));
});

test('FR-MCP-025 AC-2: the bound connection keeps the MCP key scopes as well', async () => {
  const mcp = setup();
  const sessionId = await mcp.connect();
  mcp.issue('claim_b');
  assert.equal((await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_b', sessionKey: SESSION.sessionKey })).ok, true);
  // workspaces.write / terminals.exec are MCP-key-only scopes (SEC-MCP-004); a bound session must not lose them.
  const listed = await mcp.call(sessionId, 'buildergate.workspace.list');
  assert.notEqual(listed.code, 'INVALID_SCOPE', JSON.stringify(listed));
});

test('FR-MCP-025 AC-3: a regenerated MCP key takes its scopes away at once; the session binding stays', async () => {
  // FR-MCP-026 AC-5 (user requirement 2026-11-16): a key change must not cut a bound agent off.
  const mcp = setup();
  const sessionId = await mcp.connect();
  mcp.issue('claim_c');
  assert.equal((await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_c', sessionKey: SESSION.sessionKey })).ok, true);
  assert.notEqual((await mcp.call(sessionId, KEY_ONLY_TOOL, KEY_ONLY_ARGS)).code, 'INVALID_SCOPE', 'the key scopes before rotation');
  mcp.rotate('bgmcp_new');
  assert.equal((await mcp.call(sessionId, 'buildergate.session.whoami', {}, 'bgmcp_old')).sessionKey, SESSION.sessionKey);
  assert.equal((await mcp.call(sessionId, KEY_ONLY_TOOL, KEY_ONLY_ARGS, 'bgmcp_old')).code, 'INVALID_SCOPE', 'the old key no longer adds its scopes');
});

test('FR-MCP-025 AC-4: a wrong, reused or mismatched code is refused and leaves the connection unbound', async () => {
  const mcp = setup();
  const sessionId = await mcp.connect();
  assert.equal((await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_none', sessionKey: SESSION.sessionKey })).code, 'CLAIM_CODE_INVALID');
  mcp.issue('claim_d', 'key-other');
  assert.equal((await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_d', sessionKey: SESSION.sessionKey })).code, 'CLAIM_CODE_INVALID');
  assert.equal((await mcp.call(sessionId, 'buildergate.session.whoami')).code, 'UNBOUND_ACTOR');
  mcp.issue('claim_e');
  assert.equal((await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_e', sessionKey: SESSION.sessionKey })).ok, true);
  assert.equal((await mcp.call(sessionId, 'buildergate.session.claim', { claimCode: 'claim_e', sessionKey: SESSION.sessionKey })).code !== undefined, true);
});

test('FR-MCP-025 (review H1): a token handed out by claim never carries the MCP key scopes', async () => {
  // The stateless path returns this token to the caller; it must not outlive a key rotation with
  // MCP-key-only powers (SEC-MCP-002 AC-10, SEC-MCP-004).
  const claimCodes = new Map<string, Rec>([['claim_h', {
    claimCode: 'claim_h', sessionKey: SESSION.sessionKey, used: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }]]);
  const service = createMcpToolService({
    claimCodes,
    resolveClaimSession: () => SESSION,
  } as never) as Rec;
  const result = await (service.callTool as (r: unknown) => Promise<Rec>)({
    name: 'buildergate.session.claim',
    arguments: { claimCode: 'claim_h', sessionKey: SESSION.sessionKey },
    actor: { type: 'mcp-fixed-access-key', scopes: getFixedMcpAccessKeyScopes() },
  });
  const structured = (result.structuredContent ?? result) as Rec;
  assert.equal(structured.ok, true, JSON.stringify(result));
  const verified = verifyMcpCapabilityToken(String(structured.actorToken), { expectedAudience: 'buildergate-mcp' }) as Rec;
  const scopes = ((verified.claims as Rec)?.scope ?? (verified.claims as Rec)?.scopes ?? verified.scopes) as unknown;
  const list = Array.isArray(scopes) ? scopes.map(String) : String(scopes ?? '').split(' ');
  assert.deepEqual([...list].sort(), [...getDefaultMcpSessionScopes()].sort(), JSON.stringify(verified));
});


test('FR-MCP-026 AC-1/AC-2: an agent in a BuilderGate terminal acts as its session with no setup; one lookup per socket', async () => {
  const asked: Rec[] = [];
  const mcp = setup({ resolveCallerSession: async (request) => { asked.push(request); return AGENT; } });
  const sessionId = await mcp.connect();
  assert.equal(asked.length, 0, 'initialize answers without asking the OS');
  const whoami = await mcp.call(sessionId, 'buildergate.session.whoami');
  assert.equal(whoami.sessionKey, SESSION.sessionKey, JSON.stringify(whoami));
  assert.deepEqual(asked.map((r) => [r.remoteAddress, r.listenerPort, r.clientPort]), [['127.0.0.1', 3333, 52344]]);
  await mcp.call(sessionId, 'buildergate.session.whoami');
  assert.equal(asked.length, 1, 'the same socket is not looked up again');
  // A valid MCP key still adds its own scopes.
  assert.notEqual((await mcp.call(sessionId, KEY_ONLY_TOOL, KEY_ONLY_ARGS)).code, 'INVALID_SCOPE');
});

test('FR-MCP-026 AC-5: a key change does not cut a terminal agent off; a stale or missing key still connects as the session', async () => {
  const mcp = setup({ resolveCallerSession: async () => AGENT });
  const sessionId = await mcp.connect();
  mcp.rotate('bgmcp_new');
  const after = await mcp.call(sessionId, 'buildergate.session.whoami', {}, 'bgmcp_old');
  assert.equal(after.sessionKey, SESSION.sessionKey, JSON.stringify(after));
  assert.equal((await mcp.call(sessionId, KEY_ONLY_TOOL, KEY_ONLY_ARGS, 'bgmcp_old')).code, 'INVALID_SCOPE', 'a stale key adds nothing');
  const stale = await mcp.connect('bgmcp_old');
  assert.equal((await mcp.call(stale, 'buildergate.session.whoami', {}, 'bgmcp_old')).sessionKey, SESSION.sessionKey);
  const none = await mcp.connect(null);
  assert.equal((await mcp.call(none, 'buildergate.session.whoami', {}, null)).sessionKey, SESSION.sessionKey);
});

test('FR-MCP-026 AC-6: after a restart the old connection id is taken back, without a reconnect', async () => {
  const mcp = setup({ resolveCallerSession: async () => AGENT });
  const forgotten = '11111111-2222-3333-4444-555555555555';
  const whoami = await mcp.call(forgotten, 'buildergate.session.whoami');
  assert.equal(whoami.sessionKey, SESSION.sessionKey, JSON.stringify(whoami));
  const outside = setup({ resolveCallerSession: async () => undefined });
  outside.rotate('bgmcp_new');
  assert.ok((await outside.call(forgotten, 'buildergate.session.whoami', {}, 'bgmcp_old')).transportError, 'an unknown caller with a bad key still gets nothing');
});

test('FR-MCP-026 AC-3: a caller outside BuilderGate terminals stays on the MCP key alone', async () => {
  const mcp = setup({ resolveCallerSession: async () => undefined });
  const sessionId = await mcp.connect();
  assert.equal((await mcp.call(sessionId, 'buildergate.session.whoami')).code, 'UNBOUND_ACTOR');
  assert.notEqual((await mcp.call(sessionId, KEY_ONLY_TOOL, KEY_ONLY_ARGS)).code, 'INVALID_SCOPE');
  const failing = setup({ resolveCallerSession: async () => { throw new Error('lookup failed'); } });
  const other = await failing.connect();
  assert.equal((await failing.call(other, 'buildergate.session.whoami')).code, 'UNBOUND_ACTOR');
  failing.rotate('bgmcp_new');
  assert.equal((await failing.connect('bgmcp_old').catch(() => 'refused')), 'refused', 'a stale key outside a terminal is refused');
});


test('FR-MCP-026 AC-7 (review C1): without a valid key, a terminal process that is not an agent CLI gets nothing', async () => {
  // A tunnel (ssh -R, ngrok) started in a terminal relays remote requests from loopback.
  const mcp = setup({ resolveCallerSession: async () => NOT_AGENT });
  const refused = await (async () => { try { await mcp.connect(null); return 'connected'; } catch { return 'refused'; } })();
  assert.equal(refused, 'refused', 'no key + not an agent: initialize is refused');
  mcp.rotate('bgmcp_new');
  assert.ok((await mcp.call('11111111-2222-3333-4444-555555555555', 'buildergate.session.whoami', {}, 'bgmcp_old')).transportError);
  // With a valid key the same process is bound (the key already allows more than the session).
  const keyed = setup({ resolveCallerSession: async () => NOT_AGENT });
  const sid = await keyed.connect();
  assert.equal((await keyed.call(sid, 'buildergate.session.whoami')).sessionKey, SESSION.sessionKey);
});

test('FR-MCP-026 AC-8 (review M5): a browser JWT is never turned into a session actor', async () => {
  const mcp = setup({ resolveCallerSession: async () => AGENT });
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: 'admin', jti: 'j', exp: 9_999_999_999 })).toString('base64url'), 'sig'].join('.');
  const refused = await (async () => { try { await mcp.connect(jwt); return 'connected'; } catch { return 'refused'; } })();
  assert.equal(refused, 'refused');
});

test('FR-MCP-026 AC-8 (review H2): a revoked session token is not minted again for the same terminal', async () => {
  const revoked = new Set<string>();
  const minted: string[] = [];
  const tokenStore = {
    mint: (request: Rec) => {
      const token = `tok_${minted.length + 1}`;
      minted.push(token);
      return { token: mintToken(request, token) };
    },
    isRevoked: (credential: Rec) => revoked.has(String(credential.token)),
  };
  const mcp = setup({ resolveCallerSession: async () => AGENT, tokenStore });
  const sid = await mcp.connect(null);
  assert.equal((await mcp.call(sid, 'buildergate.session.whoami', {}, null)).sessionKey, SESSION.sessionKey);
  for (const token of realTokens) revoked.add(token);
  const after = await mcp.call(sid, 'buildergate.session.whoami', {}, null);
  assert.ok(after.transportError || after.code, `revoked stays revoked: ${JSON.stringify(after)}`);
  assert.equal(minted.length, 1, 'no second token for the same terminal session');
});

test('FR-MCP-026 AC-8 (review M4): inside a terminal, a key holder can still claim another session', async () => {
  const mcp = setup({ resolveCallerSession: async () => ({ ...AGENT, sessionKey: 'key-other', sessionId: 'other' }) });
  const sid = await mcp.connect();
  mcp.issue('claim_t');
  const claimed = await mcp.call(sid, 'buildergate.session.claim', { claimCode: 'claim_t', sessionKey: SESSION.sessionKey });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal((await mcp.call(sid, 'buildergate.session.whoami')).sessionKey, SESSION.sessionKey);
});
