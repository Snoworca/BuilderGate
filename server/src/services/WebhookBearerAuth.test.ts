import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createWebhookInvocationService } from './WebhookInvocationService.js';
import { createMcpControlConfigFileStore } from './McpControlConfigStore.js';

// FR-MCP-014: the webhook key travels as `Authorization: Bearer <key>` (or the key query),
// and there is no webhook header-name setting any more.

type Call = (request: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;

function createService() {
  const service = createWebhookInvocationService({
    now: () => '2026-07-09T05:00:00.000Z',
    webhookRecord: {
      keyId: 'wh_1',
      fullKey: 'webhook-full-key',
      targetSessionKey: 'target-session',
      profileId: 'codex-env',
      mode: 'open-or-send',
      scopes: ['mcp:webhook.invoke'],
      expiresAt: '2026-07-10T00:00:00.000Z',
    },
    webhookRecords: [{ keyId: 'wh_1', fullKey: 'webhook-full-key' }],
    defaultProfile: { id: 'codex-env', enabled: true },
    searchSessions: () => ({ allowed: true, matches: [{ sessionKey: 'target-session' }] }),
    openAgent: () => ({ ok: true }),
    deliverMessage: () => ({ ok: true, accepted: true }),
    checkRateLimit: () => ({ ok: true }),
  }) as Record<string, unknown>;
  const call = (name: string, request: unknown) => (service[name] as Call)(request);
  return { call };
}

function invoke(headers: Record<string, string>, query: Record<string, string> = { prompt: 'hello' }) {
  return {
    method: 'GET',
    path: '/webhook/agent',
    url: '/webhook/agent',
    remoteAddress: '127.0.0.1',
    headers,
    query,
  };
}

// @req FR-MCP-014
test('FR-MCP-014 AC-1: a Bearer webhook key is accepted', async () => {
  const { call } = createService();
  const result = await call('invokeWebhook', invoke({ authorization: 'Bearer webhook-full-key' }));
  assert.notEqual(result.ok, false, JSON.stringify(result));
});

// @req FR-MCP-014
test('FR-MCP-014 AC-1: a wrong, non-Bearer or old-header key is refused', async () => {
  const { call } = createService();
  const cases: Record<string, string>[] = [
    { authorization: 'Bearer wrong-key' },
    { authorization: 'Basic webhook-full-key' },
    { authorization: 'webhook-full-key' },
    { 'x-buildergate-webhook-key': 'webhook-full-key' },
    {},
  ];
  for (const headers of cases) {
    const result = await call('invokeWebhook', invoke(headers));
    assert.equal(result.ok, false, JSON.stringify(headers));
    assert.equal(result.code, 'WEBHOOK_KEY_INVALID', JSON.stringify(headers));
  }
});

// @req FR-MCP-014
test('FR-MCP-014 AC-1: the key query still works, and a Bearer key that disagrees with it is refused', async () => {
  const { call } = createService();
  const query = await call('invokeWebhook', invoke({}, { key: 'webhook-full-key', prompt: 'hello' }));
  assert.notEqual(query.ok, false, JSON.stringify(query));
  const conflict = await call('invokeWebhook', invoke(
    { authorization: 'Bearer webhook-full-key-other' },
    { key: 'webhook-full-key', prompt: 'hello' },
  ));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'WEBHOOK_KEY_INVALID');
});

// @req FR-MCP-014
test('FR-MCP-014 AC-2: webhook config has no header name and ignores one sent to it', async () => {
  const { call } = createService();
  const config = await call('getWebhookConfig', {});
  assert.equal('webhookKeyHeaderName' in config, false, JSON.stringify(config));
  const set = await call('setWebhookConfig', {
    webhookKeyHeaderName: 'X-Custom',
    rateLimit: { windowSeconds: 30, burstLimit: 4 },
  });
  assert.equal(set.ok, true);
  assert.equal('webhookKeyHeaderName' in set, false);
  assert.deepEqual(set.rateLimit, { windowSeconds: 30, burstLimit: 4 });
});

// @req FR-MCP-014
test('FR-MCP-014 AC-2: the stored config drops an old header name without a warning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-fr-mcp-014-'));
  try {
    const dataPath = path.join(dir, 'mcp-control-config.json');
    await fs.writeFile(dataPath, JSON.stringify({
      version: 1,
      config: {
        enabled: true,
        bindMode: 'loopback',
        host: '127.0.0.1',
        port: 3333,
        transportSecurity: 'none',
        webhookKeyHeaderName: 'X-Old-Header',
        webhookRateLimit: { windowSeconds: 30, burstLimit: 4 },
      },
    }));
    const warnings: unknown[] = [];
    const store = createMcpControlConfigFileStore({ dataPath, warn: (event: unknown) => warnings.push(event) }) as Record<string, unknown>;
    const loaded = await (store.loadConfig as Call)({});
    assert.equal('webhookKeyHeaderName' in loaded, false, JSON.stringify(loaded));
    assert.deepEqual(loaded.webhookRateLimit, { windowSeconds: 30, burstLimit: 4 });
    assert.deepEqual(warnings, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
