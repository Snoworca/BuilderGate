// SEC-MCP-001 AC-2 / AC-7 (#231): external MCP access over plain HTTP, and '*' as the one way to
// allow every address. Both guards are covered: the contract (config validation and the request
// guard) and the tool service's transport boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMcpRequestGuard, validateMcpSecurityConfig } from './McpSecurityContract.js';
import { evaluateMcpTransportRequest, validateMcpListenerConfig } from './McpToolService.js';

const httpWhitelist = (externalWhitelist: string[]) => ({
  enabled: true,
  bindMode: 'whitelist',
  bindHost: '0.0.0.0',
  externalWhitelist,
  transportSecurity: 'none',
  trustedProxies: [],
  allowedOrigins: [],
});

test('SEC-MCP-001 AC-2: whitelist mode over plain HTTP is a valid configuration', () => {
  const result = validateMcpSecurityConfig(httpWhitelist(['203.0.113.0/24']));
  assert.equal(result.ok, true, JSON.stringify(result));
  const listener = validateMcpListenerConfig({
    current: { bindHost: '127.0.0.1', port: 3333 },
    candidate: { bindMode: 'whitelist', bindHost: '0.0.0.0', externalWhitelist: ['203.0.113.7'], transportSecurity: 'none' },
  });
  assert.equal(listener.ok, true, JSON.stringify(listener));
});

test('SEC-MCP-001 AC-2: a trusted TLS proxy still needs a trusted proxy', () => {
  const result = validateMcpSecurityConfig({ ...httpWhitelist(['203.0.113.0/24']), transportSecurity: 'trusted_tls_proxy' });
  assert.equal(result.code, 'MCP_TRUSTED_PROXY_DENIED');
});

test("SEC-MCP-001 AC-7: '*' is accepted in the whitelist; 0.0.0.0/0 and '*' as a trusted proxy are not", () => {
  assert.equal(validateMcpSecurityConfig(httpWhitelist(['*'])).ok, true);
  assert.equal(validateMcpSecurityConfig(httpWhitelist(['0.0.0.0/0'])).code, 'MCP_WHITELIST_DENIED');
  const proxyAny = validateMcpSecurityConfig({ ...httpWhitelist(['203.0.113.0/24']), transportSecurity: 'trusted_tls_proxy', trustedProxies: ['*'] });
  assert.equal(proxyAny.code, 'MCP_TRUSTED_PROXY_DENIED');
});

test("SEC-MCP-001 AC-2/AC-7: the tool service lets a listed or '*' address in over HTTP", () => {
  const credential = { type: 'mcp', scopes: ['mcp:sessions.read'] };
  const listed = evaluateMcpTransportRequest({ config: httpWhitelist(['203.0.113.0/24']), remoteAddress: '203.0.113.9', headers: {}, credential });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  for (const remoteAddress of ['198.51.100.9', '::ffff:198.51.100.9', '2001:db8::1']) {
    const any = evaluateMcpTransportRequest({ config: httpWhitelist(['*']), remoteAddress, headers: {}, credential });
    assert.equal(any.ok, true, `${remoteAddress}: ${JSON.stringify(any)}`);
  }
  // Control: the same request from outside the list is still refused.
  const outside = evaluateMcpTransportRequest({ config: httpWhitelist(['203.0.113.0/24']), remoteAddress: '198.51.100.9', headers: {}, credential });
  assert.equal(outside.code, 'MCP_WHITELIST_DENIED');
});

test("SEC-MCP-001 AC-2/AC-7: the contract's request guard passes '*' and a listed address over HTTP", () => {
  const request = (externalWhitelist: string[], remoteAddress: string) => evaluateMcpRequestGuard({
    config: httpWhitelist(externalWhitelist),
    remoteAddress,
    headers: {},
  });
  const blocked = ['MCP_WHITELIST_DENIED', 'MCP_TRANSPORT_TLS_REQUIRED', 'MCP_LOOPBACK_ONLY', 'MCP_TRANSPORT_DENIED'];
  // Control first: this guard does reach the whitelist decision for this request.
  assert.equal(request(['203.0.113.0/24'], '198.51.100.9').code, 'MCP_WHITELIST_DENIED');
  for (const remoteAddress of ['198.51.100.9', '2001:db8::1']) {
    const any = request(['*'], remoteAddress);
    assert.ok(!blocked.includes(String(any.code)), `${remoteAddress}: ${JSON.stringify(any)}`);
  }
  assert.ok(!blocked.includes(String(request(['203.0.113.0/24'], '203.0.113.9').code)));
});

test("SEC-MCP-001 AC-7: '*' in a stored trustedProxies list (never accepted by a save) trusts no proxy", () => {
  // McpControlConfigStore reads the file without the save-time validation, so the guard itself
  // must not read '*' as "every proxy" -- that would let any host forge X-Forwarded-For.
  const config = { ...httpWhitelist(['203.0.113.0/24']), transportSecurity: 'trusted_tls_proxy', trustedProxies: ['*'] };
  const headers = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
  const credential = { type: 'mcp', scopes: ['mcp:sessions.read'] };
  const viaTool = evaluateMcpTransportRequest({ config, remoteAddress: '198.51.100.9', headers, credential });
  assert.equal(viaTool.code, 'MCP_TRUSTED_PROXY_DENIED', JSON.stringify(viaTool));
  const viaContract = evaluateMcpRequestGuard({ config, remoteAddress: '198.51.100.9', headers });
  assert.equal(viaContract.code, 'MCP_TRUSTED_PROXY_DENIED', JSON.stringify(viaContract));
});
