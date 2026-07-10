import type {
  McpAgentProfileInput,
  McpAgentStatus,
  McpBindingLifecycle,
  McpClientConfigMode,
  McpControlConfig,
  McpControlConfigPatch,
} from '../../types';

export interface McpSecurityDraft {
  enabled: boolean;
  bindMode: string;
  host: string;
  portText: string;
  transportSecurity: string;
  trustedProxiesText: string;
  externalWhitelistText: string;
  allowedOriginsText: string;
  webhookKeyHeaderName: string;
  webhookRateLimitWindowSecondsText: string;
  webhookRateLimitBurstLimitText: string;
}

export interface McpWebhookDraftValidationInput {
  targetSessionKey: string;
  profileId: string;
  scopesText: string;
}

export interface McpAgentDraftValidationInput {
  displayName: string;
  command: string;
  argsText: string;
  aliasesText: string;
  enabled: boolean;
  isDefault: boolean;
  kickoffPrompt: string;
  mcpClientConfigMode: McpClientConfigMode;
}

const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const MAX_AGENT_DISPLAY_NAME_LENGTH = 80;
const MAX_KICKOFF_PROMPT_LENGTH = 12000;
const ALLOWED_AGENT_CONFIG_MODES = new Set<McpClientConfigMode>(['env', 'generated-file', 'manual']);
const MCP_AGENT_STATUSES = new Set<McpAgentStatus>(['unknown', 'starting', 'ready', 'busy', 'waiting_input', 'completed', 'failed']);
const MCP_BINDING_LIFECYCLES = new Set<McpBindingLifecycle>(['live', 'closing', 'closed', 'retired', 'failed', 'closing-failed']);
const MCP_CONTROL_STATUS_LABELS: Record<string, string> = {
  unknown: '알 수 없음',
  listening: '수신 대기',
  stopped: '중지됨',
  starting: '시작 중',
  ready: '준비됨',
  running: '실행 중',
  active: '활성',
  inactive: '비활성',
  enabled: '사용',
  disabled: '사용 안 함',
  failed: '실패',
  error: '오류',
};
const MCP_AUDIT_ACTION_LABELS: Record<string, string> = {
  'buildergate.session.whoami': '내 세션 정보 조회',
  'buildergate.session.claim': '세션 등록',
  'buildergate.session.list': '세션 목록 조회',
  'buildergate.session.search': '세션 검색',
  'buildergate.session.set_alias': '세션 별칭 설정',
  'buildergate.session.update_status': '세션 상태 갱신',
  'buildergate.session.open_agent': '에이전트 열기',
  'buildergate.session.close': '세션 닫기',
  'buildergate.session.close_self': '내 세션 닫기',
  'buildergate.message.send': '메시지 전달',
  'buildergate.message.reply_to_leader': '리더에게 응답 전달',
  'mcp.listener.rebind': 'MCP 리스너 재바인드',
  'mcp.request.denied': 'MCP 요청 거부',
  'input-gateway': '입력 게이트웨이',
};
const MCP_AUDIT_OUTCOME_LABELS: Record<string, string> = {
  ok: '성공',
  accepted: '접수됨',
  delivered: '전달됨',
  denied: '거부됨',
  rollback: '되돌림',
  failed: '실패',
  closed: '닫힘',
  'closing-failed': '닫기 실패',
  TOKEN_REVOKED: '폐기된 토큰',
  MCP_PORT_REBIND_FAILED: 'MCP 포트 재바인드 실패',
  MCP_ORIGIN_DENIED: '허용되지 않은 오리진',
  CREDENTIAL_BOUNDARY_VIOLATION: '자격 증명 경계 위반',
  INVALID_TOKEN: '유효하지 않은 토큰',
  DELIVERY_FAILED: '전달 실패',
  INVALID_SCOPE: '권한 범위가 유효하지 않음',
};
const MCP_WEBHOOK_MODE_LABELS: Record<string, string> = {
  paste: '붙여넣기',
  'send-only': '전송 전용',
  submit: '전송 후 엔터',
};
const MCP_AGENT_STATUS_LABELS: Record<McpAgentStatus, string> = {
  unknown: '알 수 없음',
  starting: '시작 중',
  ready: '준비됨',
  busy: '작업 중',
  waiting_input: '입력 대기',
  completed: '완료됨',
  failed: '실패',
};
const MCP_BINDING_LIFECYCLE_LABELS: Record<McpBindingLifecycle, string> = {
  live: '활성',
  closing: '종료 중',
  closed: '종료됨',
  retired: '해제됨',
  failed: '실패',
  'closing-failed': '종료 실패',
};

export function parseMcpControlListInput(input: string): string[] {
  return input
    .split(/[,\r\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function formatMcpControlListInput(values: string[] | undefined): string {
  return (values ?? []).join('\n');
}

export function formatMcpControlStatus(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '알 수 없음';
  }
  const normalized = value.trim();
  return MCP_CONTROL_STATUS_LABELS[normalized] ?? `알 수 없는 상태: ${normalized}`;
}

export function formatMcpAuditAction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '감사';
  }
  const normalized = value.trim();
  return MCP_AUDIT_ACTION_LABELS[normalized] ?? `작업 코드: ${normalized}`;
}

export function formatMcpAuditOutcome(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '성공';
  }
  const normalized = value.trim();
  return MCP_AUDIT_OUTCOME_LABELS[normalized] ?? `결과 코드: ${normalized}`;
}

export function formatMcpWebhookMode(value: string): string {
  const normalized = value.trim();
  return MCP_WEBHOOK_MODE_LABELS[normalized] ?? normalized;
}

export function normalizeMcpWebhookMode(value: string): string {
  const normalized = value.trim();
  const matchedMode = Object.entries(MCP_WEBHOOK_MODE_LABELS)
    .find(([, label]) => label === normalized)?.[0];
  return matchedMode ?? normalized;
}

export function createMcpSecurityDraft(config: McpControlConfig): McpSecurityDraft {
  return {
    enabled: Boolean(config.enabled),
    bindMode: config.bindMode || 'loopback',
    host: config.host || '127.0.0.1',
    portText: String(config.port ?? ''),
    transportSecurity: config.transportSecurity || 'none',
    trustedProxiesText: formatMcpControlListInput(config.trustedProxies),
    externalWhitelistText: formatMcpControlListInput(config.externalWhitelist),
    allowedOriginsText: formatMcpControlListInput(config.allowedOrigins),
    webhookKeyHeaderName: config.webhookKeyHeaderName || 'X-BuilderGate-Webhook-Key',
    webhookRateLimitWindowSecondsText: String(config.webhookRateLimit?.windowSeconds ?? 60),
    webhookRateLimitBurstLimitText: String(config.webhookRateLimit?.burstLimit ?? 10),
  };
}

export function validateMcpSecurityDraft(draft: McpSecurityDraft): string | null {
  const port = Number(draft.portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '포트는 1-65535 범위의 정수여야 합니다.';
  }

  if (draft.bindMode !== 'whitelist' && !isLoopbackAddress(draft.host.trim())) {
    return '로컬 전용 모드는 127.0.0.0/8 또는 ::1 호스트만 사용할 수 있습니다.';
  }

  const externalWhitelist = parseMcpControlListInput(draft.externalWhitelistText);
  if (draft.bindMode === 'whitelist' && externalWhitelist.length === 0) {
    return '허용 목록 모드는 외부 IP/CIDR 허용 목록이 필요합니다.';
  }

  if (externalWhitelist.some(isWideOpenCidr)) {
    return '0.0.0.0/0 또는 ::/0 같은 전체 허용 목록은 사용할 수 없습니다.';
  }

  if (externalWhitelist.some(value => !isValidIpv4Cidr(value))) {
    return '허용 목록은 IPv4 또는 IPv4/CIDR 형식이어야 합니다.';
  }

  const trustedProxies = parseMcpControlListInput(draft.trustedProxiesText);
  if (trustedProxies.some(value => !isValidIpv4Cidr(value))) {
    return '신뢰 프록시는 IPv4 또는 IPv4/CIDR 형식이어야 합니다.';
  }

  if (
    draft.bindMode === 'whitelist'
    && draft.transportSecurity !== 'direct_tls'
    && draft.transportSecurity !== 'trusted_tls_proxy'
  ) {
    return '허용 목록 모드는 직접 TLS 또는 신뢰 프록시 TLS 전송 보안이 필요합니다.';
  }

  if (draft.bindMode === 'whitelist' && draft.transportSecurity === 'trusted_tls_proxy' && trustedProxies.length === 0) {
    return '신뢰 프록시 TLS 전송 보안은 신뢰 프록시 설정이 필요합니다.';
  }

  const allowedOrigins = parseMcpControlListInput(draft.allowedOriginsText);
  if (allowedOrigins.some(origin => !isValidHttpOrigin(origin))) {
    return '허용 오리진은 http 또는 https URL 오리진 형식이어야 합니다.';
  }

  const headerName = draft.webhookKeyHeaderName.trim();
  if (!HEADER_NAME_PATTERN.test(headerName)) {
    return '웹훅 헤더 이름은 HTTP 헤더 이름 형식이어야 합니다.';
  }

  if (['authorization', 'cookie', 'set-cookie'].includes(headerName.toLowerCase())) {
    return 'Authorization/Cookie 계열 헤더는 웹훅 키 헤더로 사용할 수 없습니다.';
  }

  const rateWindowSeconds = Number(draft.webhookRateLimitWindowSecondsText);
  const burstLimit = Number(draft.webhookRateLimitBurstLimitText);
  if (!Number.isInteger(rateWindowSeconds) || rateWindowSeconds < 1 || !Number.isInteger(burstLimit) || burstLimit < 1) {
    return '웹훅 요청 제한값은 1 이상의 정수여야 합니다.';
  }

  return null;
}

export function buildMcpControlConfigPatch(draft: McpSecurityDraft): McpControlConfigPatch {
  return {
    enabled: draft.enabled,
    bindMode: draft.bindMode,
    host: draft.host.trim(),
    port: Number(draft.portText),
    transportSecurity: draft.transportSecurity,
    trustedProxies: parseMcpControlListInput(draft.trustedProxiesText),
    externalWhitelist: parseMcpControlListInput(draft.externalWhitelistText),
    allowedOrigins: parseMcpControlListInput(draft.allowedOriginsText),
    webhookKeyHeaderName: draft.webhookKeyHeaderName.trim(),
    webhookRateLimit: {
      windowSeconds: Number(draft.webhookRateLimitWindowSecondsText),
      burstLimit: Number(draft.webhookRateLimitBurstLimitText),
    },
  };
}

export function validateMcpWebhookDraft(draft: McpWebhookDraftValidationInput): string | null {
  if (!draft.targetSessionKey.trim() && !draft.profileId.trim()) {
    return '웹훅 키는 대상 세션 또는 에이전트 프로필이 필요합니다.';
  }

  if (parseMcpControlListInput(draft.scopesText).length === 0) {
    return '웹훅 키는 하나 이상의 권한 범위가 필요합니다.';
  }

  return null;
}

export function validateMcpAgentDraft(draft: McpAgentDraftValidationInput): string | null {
  const displayName = draft.displayName.trim();
  const command = draft.command.trim();
  if (!displayName || Array.from(displayName).length > MAX_AGENT_DISPLAY_NAME_LENGTH || hasControlCharacter(displayName)) {
    return '에이전트 프로필 이름은 1-80자이며 제어 문자를 포함할 수 없습니다.';
  }

  if (!command || hasControlCharacter(command)) {
    return '에이전트 프로필 실행 명령이 필요하며 제어 문자를 포함할 수 없습니다.';
  }

  if (!ALLOWED_AGENT_CONFIG_MODES.has(draft.mcpClientConfigMode)) {
    return '에이전트 프로필 설정 방식 값이 올바르지 않습니다.';
  }

  const aliases = parseMcpControlListInput(draft.aliasesText);
  if (aliases.length !== new Set(aliases).size) {
    return '에이전트 프로필 별칭에는 중복 값을 사용할 수 없습니다.';
  }

  if (draft.kickoffPrompt.length > MAX_KICKOFF_PROMPT_LENGTH) {
    return '에이전트 프로필 시작 프롬프트가 너무 깁니다.';
  }

  return null;
}

export function buildMcpAgentProfileInput(draft: McpAgentDraftValidationInput): McpAgentProfileInput {
  return {
    displayName: draft.displayName.trim(),
    command: draft.command.trim(),
    args: parseMcpControlListInput(draft.argsText),
    aliases: parseMcpControlListInput(draft.aliasesText),
    isDefault: draft.isDefault,
    enabled: draft.enabled,
    kickoffPrompt: draft.kickoffPrompt.trim() || undefined,
    mcpClientConfigMode: draft.mcpClientConfigMode,
  };
}

export function formatMcpAgentStatus(value: unknown): string {
  if (typeof value === 'string' && MCP_AGENT_STATUSES.has(value as McpAgentStatus)) {
    return MCP_AGENT_STATUS_LABELS[value as McpAgentStatus];
  }
  if (value === null || value === undefined || value === '') {
    return '알 수 없음';
  }
  return `알 수 없는 상태: ${String(value)}`;
}

export function formatMcpBindingLifecycle(value: unknown): string {
  if (typeof value === 'string' && MCP_BINDING_LIFECYCLES.has(value as McpBindingLifecycle)) {
    return MCP_BINDING_LIFECYCLE_LABELS[value as McpBindingLifecycle];
  }
  if (value === null || value === undefined || value === '') {
    return '수명 주기 정보 없음';
  }
  return `알 수 없는 수명 주기: ${String(value)}`;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function isWideOpenCidr(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '::/0') {
    return true;
  }
  const [address, prefixText, extra] = normalized.split('/');
  if (extra !== undefined || prefixText === undefined || !isValidIpv4Address(address) || !/^\d+$/.test(prefixText)) {
    return false;
  }
  const prefix = Number(prefixText);
  return Number.isInteger(prefix) && prefix === 0;
}

function isValidHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    return url.origin === value;
  } catch {
    return false;
  }
}

function isValidIpv4Cidr(value: string): boolean {
  const [address, prefixText, extra] = value.split('/');
  if (extra !== undefined || !isValidIpv4Address(address)) {
    return false;
  }
  if (prefixText === undefined) {
    return true;
  }
  if (!/^\d+$/.test(prefixText)) {
    return false;
  }
  const prefix = Number(prefixText);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function isValidIpv4Address(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const numeric = Number(part);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 255;
  });
}

function isLoopbackAddress(value: string): boolean {
  if (value === '::1') {
    return true;
  }
  if (!isValidIpv4Address(value)) {
    return false;
  }
  return value.split('.')[0] === '127';
}
