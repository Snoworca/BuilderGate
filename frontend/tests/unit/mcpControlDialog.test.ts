import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildMcpAgentProfileInput,
  buildMcpControlConfigPatch,
  createMcpSecurityDraft,
  formatMcpAuditAction,
  formatMcpAuditOutcome,
  formatMcpAgentStatus,
  formatMcpBindingLifecycle,
  formatMcpControlStatus,
  formatMcpControlListInput,
  formatMcpWebhookMode,
  normalizeMcpWebhookMode,
  parseMcpControlListInput,
  validateMcpAgentDraft,
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

test('T-PH007-01 FR-MCP-005 MCP settings dialog exposes Korean tabs and security controls', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');

  for (const label of ['보안', '에이전트 프로필', '웹훅', '세션', '감사/상태']) {
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

test('MCP settings dialog uses Korean labels for every visible configuration panel', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');

  const koreanLabels = [
    'MCP 엔드포인트 사용', '바인드 모드', '호스트 주소', '포트', '전송 보안',
    '웹훅 헤더', '웹훅 요청 제한 시간(초)', '웹훅 순간 요청 한도', '외부 IP/CIDR 허용 목록',
    '신뢰 프록시', '허용 오리진', '프로필 이름', '실행 명령', '설정 방식',
    '사용', '기본 프로필', '실행 인수', '별칭', '시작 프롬프트', '대상 세션',
    '프로필 ID', '전달 방식', '만료 시각', '권한 범위', '전체 키', '전체 URL',
    '검색', '전달 테스트 프롬프트', '감사 기록', '최근 오류', '최근 재바인드',
  ];

  for (const label of koreanLabels) {
    expectSource(dialogSource, new RegExp(label.replace(/[()]/g, '\\$&')), `Dialog must expose Korean label ${label}`);
  }

  for (const englishLabel of [
    'MCP endpoint enabled', 'Bind mode', 'Transport security', 'Trusted proxies',
    'Allowed origins', 'Profile name', 'Config mode', 'Target session', 'Reply test prompt',
    'Last error', 'Audit stream', 'Recent audit events',
  ]) {
    assert.doesNotMatch(dialogSource, new RegExp(englishLabel), `Dialog must not expose English label ${englishLabel}`);
  }
});

test('MCP settings localizes runtime statuses, audit values, and webhook delivery modes', () => {
  assert.equal(formatMcpControlStatus('listening'), '수신 대기');
  assert.equal(formatMcpControlStatus('stopped'), '중지됨');
  assert.equal(formatMcpAuditAction('mcp.listener.rebind'), 'MCP 리스너 재바인드');
  assert.equal(formatMcpAuditAction('buildergate.message.reply_to_leader'), '리더에게 응답 전달');
  assert.equal(formatMcpAuditOutcome('rollback'), '되돌림');
  assert.equal(formatMcpAuditOutcome('MCP_ORIGIN_DENIED'), '허용되지 않은 오리진');
  assert.equal(formatMcpWebhookMode('paste'), '붙여넣기');
  assert.equal(formatMcpWebhookMode('submit'), '전송 후 엔터');
  assert.equal(normalizeMcpWebhookMode('붙여넣기'), 'paste');
});

test('T-PH007-01 FR-MCP-005 agent profile panel supports edit/save for full profile fields', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');

  expectSource(dialogSource, /editingAgentId/, 'Agent profile UI must track edit mode');
  expectSource(dialogSource, /handleEditAgent/, 'Agent profile UI must expose an edit handler');
  expectSource(dialogSource, /mcpControlApi\.updateAgent/, 'Agent profile UI must save edits through updateAgent');
  expectSource(dialogSource, /isDefault/, 'Agent profile UI must edit the default profile flag');
  expectSource(dialogSource, /buildMcpAgentProfileInput/, 'Agent profile UI must build a complete profile payload');
  expectSource(dialogSource, /validateMcpAgentDraft/, 'Agent profile UI must validate all editable profile fields before save');
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
  expectSource(typeSource, /bindingLifecycle\?:\s*McpBindingLifecycle/, 'MCP session type must include binding lifecycle status');
  expectSource(typeSource, /mcpConnected\?:\s*boolean/, 'MCP session type must include MCP connection status');
  expectSource(dialogSource, /session\.sessionId/, 'Sessions panel must render runtime sessionId');
  expectSource(dialogSource, /session\.currentSessionId/, 'Sessions panel must render currentSessionId');
  expectSource(dialogSource, /session\.bindingLifecycle/, 'Sessions panel must render lifecycle status');
  expectSource(dialogSource, /session\.mcpConnected/, 'Sessions panel must render MCP connection status');
});

test('MCP settings session panel issues a one-time Claude Code connection claim', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const apiSource = readSource('src/services/api.ts');
  const typeSource = readSource('src/types/mcpControl.ts');

  expectSource(dialogSource, /handleCreateSessionClaimCode/, 'Sessions panel must create a session claim code');
  expectSource(dialogSource, /mcpControlApi\.createSessionClaimCode/, 'Sessions panel must call the claim-code API');
  expectSource(dialogSource, /일회성 연결 코드/, 'Sessions panel must label the one-time connection code in Korean');
  expectSource(dialogSource, /연결 코드 발급/, 'Sessions panel must expose a claim-code action');
  expectSource(apiSource, /createSessionClaimCode[\s\S]*\/claim-code/, 'MCP control API must call the claim-code route');
  expectSource(typeSource, /McpSessionClaimCode/, 'MCP control types must expose a one-time claim code response');
});

test('MCP security panel rotates a fixed access key only after confirmation and exposes a copy action', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const apiSource = readSource('src/services/api.ts');
  const typeSource = readSource('src/types/mcpControl.ts');

  expectSource(dialogSource, /MessageBox/, 'Fixed access-key rotation must use the shared confirmation dialog');
  expectSource(dialogSource, /handleRequestFixedAccessKeyRotation/, 'Security panel must request fixed access-key rotation');
  expectSource(dialogSource, /mcpControlApi\.rotateFixedAccessKey/, 'Security panel must call the fixed access-key API');
  expectSource(dialogSource, /고정 인증키 재생성/, 'Security panel must label fixed access-key regeneration in Korean');
  expectSource(dialogSource, /정말로 재생성하시겠습니까\?/, 'Fixed access-key regeneration must require explicit confirmation');
  expectSource(dialogSource, /복사/, 'Generated fixed access key must expose a Korean copy action');
  expectSource(dialogSource, /navigator\.clipboard\.writeText/, 'Fixed access key copy action must use the clipboard API');
  expectSource(apiSource, /rotateFixedAccessKey[\s\S]*\/access-key\/rotate/, 'MCP control API must call the fixed access-key rotation route');
  expectSource(typeSource, /McpFixedAccessKeyRotation/, 'MCP control types must expose the one-time fixed access-key response');
});

test('T-PH007-01 FR-MCP-002 reply test defaults to Hello World and submits with enter', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const apiSource = readSource('src/services/api.ts');

  expectSource(dialogSource, /DEFAULT_REPLY_TEST_PROMPT\s*=\s*['"]Hello, World!['"]/, 'Reply test prompt must default to Hello, World!');
  expectSource(dialogSource, /useState\(DEFAULT_REPLY_TEST_PROMPT\)/, 'Reply test input must initialize with the default prompt');
  expectSource(apiSource, /replyTest[\s\S]*deliveryMode:\s*['"]submit['"]/, 'Reply test API must request submit delivery so Enter is included');
});

test('T-PH007-01 IR-MCP-005 session statuses surface invalid enum values explicitly', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const typeSource = readSource('src/types/mcpControl.ts');

  expectSource(typeSource, /McpAgentStatus/, 'MCP session type must use an explicit agentStatus enum');
  expectSource(typeSource, /McpBindingLifecycle/, 'MCP session type must use an explicit bindingLifecycle enum');
  expectSource(dialogSource, /formatMcpAgentStatus\(session\.agentStatus \?\? session\.status\)/, 'Sessions panel must format agentStatus through runtime validation');
  expectSource(dialogSource, /formatMcpBindingLifecycle\(session\.bindingLifecycle\)/, 'Sessions panel must format bindingLifecycle through runtime validation');
  assert.equal(formatMcpAgentStatus('ready'), '준비됨');
  assert.equal(formatMcpAgentStatus('sleeping'), '알 수 없는 상태: sleeping');
  assert.equal(formatMcpBindingLifecycle('live'), '활성');
  assert.equal(formatMcpBindingLifecycle('active'), '알 수 없는 수명 주기: active');
});

test('T-PH007-01 IR-MCP-005 Audit Status tab renders recent redacted audit events from config', () => {
  const dialogSource = readSource('src/components/McpControlManager/McpControlDialog.tsx');
  const typeSource = readSource('src/types/mcpControl.ts');

  expectSource(typeSource, /recentAuditEvents\?:\s*McpRecentAuditEvent\[\]/, 'MCP config type must include recent audit events');
  expectSource(dialogSource, /recentAuditEvents/, 'Audit Status tab must read recent audit events');
  expectSource(dialogSource, /summarizeAuditEvent/, 'Audit Status tab must render redacted audit summaries');
  assert.doesNotMatch(dialogSource, /REST status only/, 'Audit Status tab must not be a REST-only placeholder');
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
  }) ?? '', /권한 범위/i);

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

test('T-PH007-01 FR-MCP-005 agent profile draft validation and payload cover all editable fields', () => {
  const draft = {
    displayName: 'Codex Worker',
    command: 'codex',
    argsText: '--model\ngpt-5',
    aliasesText: 'builder\nworker',
    enabled: true,
    isDefault: true,
    kickoffPrompt: 'Hello, World!',
    mcpClientConfigMode: 'generated-file' as const,
  };

  assert.equal(validateMcpAgentDraft(draft), null);
  assert.deepEqual(buildMcpAgentProfileInput(draft), {
    displayName: 'Codex Worker',
    command: 'codex',
    args: ['--model', 'gpt-5'],
    aliases: ['builder', 'worker'],
    enabled: true,
    isDefault: true,
    kickoffPrompt: 'Hello, World!',
    mcpClientConfigMode: 'generated-file',
  });
  assert.match(validateMcpAgentDraft({ ...draft, displayName: '' }) ?? '', /이름|name/i);
  assert.match(validateMcpAgentDraft({ ...draft, command: 'bad\u0000command' }) ?? '', /command|제어/i);
  assert.match(validateMcpAgentDraft({ ...draft, aliasesText: 'dup\ndup' }) ?? '', /중복|duplicate/i);
  assert.match(validateMcpAgentDraft({ ...draft, mcpClientConfigMode: 'bad' as never }) ?? '', /설정 방식/i);
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
  assert.equal(
    validateMcpSecurityDraft(missingTlsDraft),
    '허용 목록 모드는 직접 TLS 또는 신뢰 프록시 TLS 전송 보안이 필요합니다.',
  );

  const missingProxyDraft = {
    ...draft,
    externalWhitelistText: '203.0.113.7/32',
    transportSecurity: 'trusted_tls_proxy',
    trustedProxiesText: '',
  };
  assert.equal(
    validateMcpSecurityDraft(missingProxyDraft),
    '신뢰 프록시 TLS 전송 보안은 신뢰 프록시 설정이 필요합니다.',
  );

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
