import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildMcpControlConfigPatch,
  createMcpSecurityDraft,
  formatMcpControlListInput,
  parseMcpControlListInput,
  validateMcpWebhookDraft,
  validateMcpSecurityDraft,
} from '../../src/components/McpControlManager/mcpControlDialogModel.ts';
import { parseApiErrorPayload } from '../../src/services/apiError.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDir, '../..');

function readSource(relativePath: string): string {
  const absolutePath = resolve(frontendRoot, relativePath);
  assert.ok(
    existsSync(absolutePath),
    `${relativePath} is missing: MCP Tools dialog UI is not implemented`,
  );
  return readFileSync(absolutePath, 'utf8');
}

function expectSource(source: string, pattern: RegExp, message: string): void {
  assert.match(source, pattern, `${message}: MCP Tools dialog UI is not implemented`);
}

test('T-PH007-01 FR-MCP-005 desktop Tools menu exposes MCP settings dialog outside generic Settings', () => {
  const headerSource = readSource('src/components/Header/Header.tsx');
  const appSource = readSource('src/App.tsx');
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const settingsSource = readSource('src/components/Settings/SettingsPage.tsx');

  expectSource(headerSource, /onOpenMcpControlManager/, 'Header must expose an MCP control manager opener');
  expectSource(headerSource, /MCP 설정|MCP 관리/, 'Desktop Tools menu must include an MCP settings entry');
  expectSource(appSource, /McpControlDialog/, 'App must render the MCP control dialog');
  expectSource(appSource, /showMcpControlDialog|mcpControlDialogOpen/, 'App must own MCP dialog open state');
  expectSource(dialogSource, /data-testid=["']mcp-control-dialog["']/, 'Dialog must expose a stable test id');
  expectSource(dialogSource, /title=["']MCP 관리["']|MCP 관리/, 'Dialog title must be MCP 관리');
  assert.doesNotMatch(
    settingsSource,
    /externalWhitelist|MCP 설정|MCP 관리/,
    'MCP whitelist settings must not be placed in the generic Settings screen',
  );
});

test('T-PH007-01 FR-MCP-005 dialog exposes fixed MCP tabs and Security whitelist controls', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');

  for (const label of ['Security', 'Agent Profiles', 'Webhooks', 'Sessions', 'Audit/Status']) {
    expectSource(dialogSource, new RegExp(label.replace('/', '\\/')), `Dialog must expose ${label} tab`);
  }

  expectSource(dialogSource, /externalWhitelist/, 'Security tab must edit external whitelist');
  expectSource(dialogSource, /trustedProxies/, 'Security tab must edit trusted proxies');
  expectSource(dialogSource, /allowedOrigins/, 'Security tab must edit allowed origins');
  expectSource(dialogSource, /webhookKeyHeaderName/, 'Security tab must edit webhook header name');
  expectSource(dialogSource, /webhookRateLimit|webhookRateLimitWindowSecondsText/, 'Security tab must edit webhook rate limit settings');
  expectSource(dialogSource, /role=["']alert["']/, 'Security tab must display validation errors through an alert path');
  expectSource(dialogSource, /mcpControlApi\.getConfig/, 'Dialog must load config through the MCP control API');
  expectSource(dialogSource, /mcpControlApi\.patchConfig/, 'Dialog must save config through the MCP control API');
});

test('T-PH007-01 IR-MCP-004 sessions panel exposes nonce-backed close confirmation', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');

  expectSource(dialogSource, /closeConfirmationNonce/, 'Sessions panel must use server-issued close confirmation nonce');
  expectSource(dialogSource, /mcpControlApi\.closeSession/, 'Sessions panel must call the MCP closeSession API');
  expectSource(dialogSource, /confirmClose\s*:\s*true/, 'Close request must send an explicit confirmClose true flag');
  expectSource(dialogSource, /expectedSessionKey\s*:\s*session\.sessionKey/, 'Close request must echo the expected target session key');
  expectSource(dialogSource, /닫기|Close/, 'Sessions panel must expose a close action label');
});

test('T-PH007-01 FR-MCP-001 sessions panel exposes runtime UUID session ids and status fields', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const typeSource = readSource('src/types/mcpControl.ts');

  expectSource(typeSource, /sessionId\?:\s*string/, 'MCP session type must include runtime sessionId');
  expectSource(typeSource, /currentSessionId\?:\s*string/, 'MCP session type must include currentSessionId');
  expectSource(typeSource, /bindingLifecycle\?:\s*string/, 'MCP session type must include binding lifecycle status');
  expectSource(typeSource, /mcpConnected\?:\s*boolean/, 'MCP session type must include MCP connection status');
  expectSource(dialogSource, /session\.sessionId/, 'Sessions panel must render runtime sessionId');
  expectSource(dialogSource, /session\.currentSessionId/, 'Sessions panel must render currentSessionId');
  expectSource(dialogSource, /session\.bindingLifecycle/, 'Sessions panel must render lifecycle status');
  expectSource(dialogSource, /session\.mcpConnected/, 'Sessions panel must render MCP connection status');
});

test('T-PH007-01 FR-MCP-002 reply test defaults to Hello World and submits with enter', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const apiSource = readSource('src/services/api.ts');

  expectSource(dialogSource, /DEFAULT_REPLY_TEST_PROMPT\s*=\s*['"]Hello, World!['"]/, 'Reply test prompt must default to Hello, World!');
  expectSource(dialogSource, /useState\(DEFAULT_REPLY_TEST_PROMPT\)/, 'Reply test input must initialize with the default prompt');
  expectSource(apiSource, /replyTest[\s\S]*deliveryMode:\s*['"]submit['"]/, 'Reply test API must request submit delivery so Enter is included');
});

test('T-PH007-01 IR-MCP-005 webhook credential surfaces are one-time and cleared on non-create paths', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');

  expectSource(dialogSource, /handleReloadWebhooks[\s\S]*setWebhookCredential\(null\)/, 'Webhook reload must clear one-time full secrets');
  expectSource(dialogSource, /handleRevokeWebhook[\s\S]*setWebhookCredential\(null\)/, 'Webhook revoke must clear one-time full secrets');
  expectSource(dialogSource, /activeTab\s*!==\s*['"]webhooks['"][\s\S]*setWebhookCredential\(null\)/, 'Leaving the Webhooks tab must clear one-time full secrets');
  expectSource(dialogSource, /autoComplete=["']off["']/, 'Full webhook secret inputs must disable browser autocomplete');
  expectSource(dialogSource, /onDismissCredential/, 'One-time webhook credential surface must have an explicit dismiss action');
});

test('T-PH007-01 IR-MCP-005 webhook create validates routing target and scopes before POST', () => {
  assert.match(validateMcpWebhookDraft({
    targetSessionKey: '',
    profileId: '',
    scopesText: 'mcp:webhook.invoke',
  }) ?? '', /session|profile|target|대상/i);

  assert.match(validateMcpWebhookDraft({
    targetSessionKey: 'target-session',
    profileId: '',
    scopesText: '',
  }) ?? '', /scope|스코프/i);

  assert.equal(validateMcpWebhookDraft({
    targetSessionKey: '',
    profileId: 'profile-default',
    scopesText: 'mcp:webhook.invoke',
  }), null);
});

test('T-PH007-01 FR-MCP-003 sessions query input does not trigger full dialog reload', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const loadSessionsStart = dialogSource.indexOf('const loadSessions = useCallback');
  const loadSessionsEnd = dialogSource.indexOf('const loadAll = useCallback', loadSessionsStart);
  assert.notEqual(loadSessionsStart, -1, 'loadSessions callback must exist');
  assert.notEqual(loadSessionsEnd, -1, 'loadSessions callback must appear before loadAll');
  const loadSessionsSource = dialogSource.slice(loadSessionsStart, loadSessionsEnd);

  assert.doesNotMatch(
    loadSessionsSource,
    /sessionQuery/,
    'loadSessions must not depend on sessionQuery because typing in search must not recreate loadAll',
  );
  expectSource(dialogSource, /loadSessions\(''\)/, 'Initial dialog load should still fetch sessions with an empty query');
});

test('T-PH007-01 FR-MCP-005 security list parser normalizes line and comma separated values', () => {
  assert.deepEqual(parseMcpControlListInput(' 203.0.113.7/32,\n198.51.100.0/24\n\n '), [
    '203.0.113.7/32',
    '198.51.100.0/24',
  ]);
  assert.equal(formatMcpControlListInput(['203.0.113.7/32', '198.51.100.0/24']), '203.0.113.7/32\n198.51.100.0/24');
});

test('T-PH007-01 FR-MCP-005 security draft validation blocks unsafe whitelist states before PATCH', () => {
  const draft = createMcpSecurityDraft({
    enabled: true,
    bindMode: 'whitelist',
    host: '0.0.0.0',
    port: 3333,
    transportSecurity: 'trusted_tls_proxy',
    trustedProxies: ['10.0.0.0/24'],
    externalWhitelist: [],
    allowedOrigins: [],
    status: 'ready',
    lastError: null,
    lastRebindResult: null,
    webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
    webhookRateLimit: { windowSeconds: 60, burstLimit: 10 },
  });

  assert.match(validateMcpSecurityDraft(draft) ?? '', /whitelist|화이트|허용/i);

  const unsafeDraft = { ...draft, externalWhitelistText: '0.0.0.0/0' };
  assert.match(validateMcpSecurityDraft(unsafeDraft) ?? '', /0\.0\.0\.0\/0|wide|전체|unsafe/i);

  const unsafePaddedPrefixDraft = { ...draft, externalWhitelistText: '0.0.0.0/00' };
  assert.match(validateMcpSecurityDraft(unsafePaddedPrefixDraft) ?? '', /0\.0\.0\.0\/0|wide|전체|unsafe/i);

  const invalidOriginDraft = {
    ...draft,
    externalWhitelistText: '203.0.113.7/32',
    allowedOriginsText: 'not a url',
  };
  assert.match(validateMcpSecurityDraft(invalidOriginDraft) ?? '', /origin|URL|오리진/i);

  const invalidCidrDraft = {
    ...draft,
    externalWhitelistText: 'not-a-cidr',
  };
  assert.match(validateMcpSecurityDraft(invalidCidrDraft) ?? '', /CIDR|whitelist|IPv4/i);

  const missingTlsDraft = {
    ...draft,
    externalWhitelistText: '203.0.113.7/32',
    transportSecurity: 'none',
  };
  assert.match(validateMcpSecurityDraft(missingTlsDraft) ?? '', /TLS|transport/i);

  const missingProxyDraft = {
    ...draft,
    externalWhitelistText: '203.0.113.7/32',
    transportSecurity: 'trusted_tls_proxy',
    trustedProxiesText: '',
  };
  assert.match(validateMcpSecurityDraft(missingProxyDraft) ?? '', /proxy|Trusted/i);

  const trailingSlashOriginDraft = {
    ...draft,
    externalWhitelistText: '203.0.113.7/32',
    allowedOriginsText: 'https://localhost:2222/',
  };
  assert.match(validateMcpSecurityDraft(trailingSlashOriginDraft) ?? '', /origin|URL|slash|오리진/i);

  const nonLoopbackDraft = {
    ...draft,
    bindMode: 'loopback',
    host: '0.0.0.0',
    transportSecurity: 'none',
    externalWhitelistText: '',
    trustedProxiesText: '',
  };
  assert.match(validateMcpSecurityDraft(nonLoopbackDraft) ?? '', /loopback|127|MCP_LOOPBACK_ONLY/i);
});

test('T-PH007-01 FR-MCP-005 security draft builds MCP control config patch with whitelist fields', () => {
  const draft = createMcpSecurityDraft({
    enabled: false,
    bindMode: 'loopback',
    host: '127.0.0.1',
    port: 3333,
    transportSecurity: 'none',
    trustedProxies: [],
    externalWhitelist: ['203.0.113.7/32'],
    allowedOrigins: ['https://localhost:2222'],
    status: 'ready',
    lastError: null,
    lastRebindResult: null,
    webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
    webhookRateLimit: { windowSeconds: 60, burstLimit: 10 },
  });

  assert.deepEqual(buildMcpControlConfigPatch(draft), {
    enabled: false,
    bindMode: 'loopback',
    host: '127.0.0.1',
    port: 3333,
    transportSecurity: 'none',
    trustedProxies: [],
    externalWhitelist: ['203.0.113.7/32'],
    allowedOrigins: ['https://localhost:2222'],
    webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
    webhookRateLimit: { windowSeconds: 60, burstLimit: 10 },
  });
});

test('T-PH007-01 IR-MCP-004 security draft validates and saves webhook rate limit settings', () => {
  const draft = createMcpSecurityDraft({
    enabled: true,
    bindMode: 'loopback',
    host: '127.0.0.1',
    port: 3333,
    transportSecurity: 'none',
    trustedProxies: [],
    externalWhitelist: [],
    allowedOrigins: [],
    status: 'ready',
    lastError: null,
    lastRebindResult: null,
    webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
    webhookRateLimit: { windowSeconds: 30, burstLimit: 4 },
  });

  assert.equal(draft.webhookRateLimitWindowSecondsText, '30');
  assert.equal(draft.webhookRateLimitBurstLimitText, '4');
  assert.equal(validateMcpSecurityDraft(draft), null);
  assert.deepEqual(buildMcpControlConfigPatch(draft).webhookRateLimit, {
    windowSeconds: 30,
    burstLimit: 4,
  });

  assert.match(validateMcpSecurityDraft({
    ...draft,
    webhookRateLimitWindowSecondsText: '0',
  }) ?? '', /rate|limit|초|정수/i);
});

test('T-PH007-01 IR-MCP-004 MCP control API flat errors keep message, code, and field details', () => {
  assert.equal(
    parseApiErrorPayload(400, 'Bad Request', {
      ok: false,
      code: 'MCP_CONTROL_CONFIG_PERSIST_FAILED',
      message: 'persist failed',
      rollbackErrors: [{
        target: 'control',
        code: 'CONTROL_RESTORE_FAILED',
        message: 'control rollback failed',
      }],
    }),
    'persist failed (MCP_CONTROL_CONFIG_PERSIST_FAILED; rollbackErrors: control:CONTROL_RESTORE_FAILED:control rollback failed)',
  );

  assert.equal(
    parseApiErrorPayload(400, 'Bad Request', {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Invalid MCP config',
      auditId: 'audit-config-1',
      fieldErrors: {
        externalWhitelist: 'CIDR is invalid',
        allowedOrigins: ['Origin must not include a path'],
      },
    }),
    'Invalid MCP config (VALIDATION_ERROR; auditId: audit-config-1; externalWhitelist: CIDR is invalid, allowedOrigins: Origin must not include a path)',
  );

  assert.equal(
    parseApiErrorPayload(403, 'Forbidden', {
      error: {
        code: 'MCP_ORIGIN_DENIED',
        message: 'MCP_ORIGIN_DENIED',
        details: { auditId: 'audit-nested-1' },
      },
    }),
    'MCP_ORIGIN_DENIED (auditId: audit-nested-1)',
  );
});
