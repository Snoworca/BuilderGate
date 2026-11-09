// SEC-MCP-002 AC-1 / IR-MCP-001: a session-bound MCP token lives as long as its session, not five
// minutes; and whoami tells a fixed-key caller why it has no session instead of INVALID_SCOPE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDefaultMcpSessionScopes,
  getFixedMcpAccessKeyScopes,
  mintMcpCapabilityToken,
  verifyMcpCapabilityToken,
} from './McpSecurityContract.js';
import { createMcpToolService } from './McpToolService.js';
import { createMcpAgentTokenStore } from './mcpAgentTokenStore.js';

type Rec = Record<string, unknown>;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function verifyLater(token: string, laterMs: number): Rec {
  const realNow = Date.now;
  const start = realNow();
  Date.now = () => start + laterMs;
  try {
    return verifyMcpCapabilityToken(token, { expectedAudience: 'buildergate-mcp' }) as Rec;
  } finally {
    Date.now = realNow;
  }
}

test('SEC-MCP-002 AC-1: a token minted without a lifetime has no exp and still verifies a year later', () => {
  const minted = mintMcpCapabilityToken({ audience: 'buildergate-mcp', sessionKey: 'k1', scopes: getDefaultMcpSessionScopes() });
  assert.equal((minted.claims as Rec).exp, undefined);
  assert.equal(verifyLater(String(minted.token), ONE_YEAR_MS).allowed, true);
});

test('SEC-MCP-002 AC-1: a token minted with a lifetime still expires', () => {
  const minted = mintMcpCapabilityToken({ audience: 'buildergate-mcp', sessionKey: 'k1', scopes: [], expiresInSeconds: 60 });
  assert.equal(verifyLater(String(minted.token), 61_000).code, 'TOKEN_EXPIRED');
});

test('SEC-MCP-002 AC-1: the agent token store mints session tokens that do not expire, and revoke still ends them', () => {
  const store = createMcpAgentTokenStore();
  const minted = store.mint({ audience: 'buildergate-mcp', sessionKey: 'k1', scopes: getDefaultMcpSessionScopes() });
  const token = String(minted.token);
  assert.equal((minted.claims as Rec).exp, undefined);
  assert.equal(verifyLater(token, ONE_YEAR_MS).allowed, true);
  assert.equal(store.isRevoked({ token }), false);
  store.revoke({ sessionKey: 'k1' });
  assert.equal(store.isRevoked({ token }), true);
});

test('SEC-MCP-002 AC-1: session.claim hands back a token that does not expire', async () => {
  const claimCodes = new Map<string, Rec>([['claim_x', {
    claimCode: 'claim_x', sessionKey: 'k1', used: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }]]);
  const service = createMcpToolService({
    claimCodes,
    resolveClaimSession: () => ({ sessionKey: 'k1', bindingLifecycle: 'live' }),
  } as never) as Rec;
  const callTool = service.callTool as (request: unknown) => Promise<Rec>;
  const result = await callTool({
    name: 'buildergate.session.claim',
    arguments: { claimCode: 'claim_x', sessionKey: 'k1' },
    actor: { type: 'mcp', scopes: ['mcp:session.claim'] },
  });
  const structured = (result.structuredContent ?? result) as Rec;
  assert.equal(structured.ok, true, JSON.stringify(result));
  assert.equal(verifyLater(String(structured.actorToken), ONE_YEAR_MS).allowed, true);
});

test('IR-MCP-001: whoami from the fixed access key answers UNBOUND_ACTOR and says how to bind', async () => {
  const service = createMcpToolService({ sessions: [{ sessionKey: 'k1', bindingLifecycle: 'live' }] } as never) as Rec;
  const callTool = service.callTool as (request: unknown) => Promise<Rec>;
  const result = await callTool({
    name: 'buildergate.session.whoami',
    arguments: {},
    actor: { type: 'mcp-fixed-access-key', scopes: getFixedMcpAccessKeyScopes() },
  });
  const structured = (result.structuredContent ?? result) as Rec;
  assert.equal(structured.code, 'UNBOUND_ACTOR', JSON.stringify(result));
  assert.match(String(structured.message), /BUILDERGATE_MCP_TOKEN/);
});

test('IR-MCP-001: whoami from a session token still returns the session', async () => {
  const service = createMcpToolService({ sessions: [{ sessionKey: 'k1', bindingLifecycle: 'live', alias: 'me' }] } as never) as Rec;
  const callTool = service.callTool as (request: unknown) => Promise<Rec>;
  const result = await callTool({
    name: 'buildergate.session.whoami',
    arguments: {},
    actor: { type: 'mcp', sessionKey: 'k1', scopes: getDefaultMcpSessionScopes() },
  });
  const structured = (result.structuredContent ?? result) as Rec;
  assert.equal(structured.sessionKey, 'k1', JSON.stringify(result));
});
