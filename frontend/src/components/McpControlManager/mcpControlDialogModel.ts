import type { McpControlConfig, McpControlConfigPatch } from '../../types';

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

const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

export function parseMcpControlListInput(input: string): string[] {
  return input
    .split(/[,\r\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function formatMcpControlListInput(values: string[] | undefined): string {
  return (values ?? []).join('\n');
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
    return 'Port는 1-65535 범위의 정수여야 합니다.';
  }

  if (draft.bindMode !== 'whitelist' && !isLoopbackAddress(draft.host.trim())) {
    return 'Loopback 모드는 127.0.0.0/8 또는 ::1 host만 사용할 수 있습니다.';
  }

  const externalWhitelist = parseMcpControlListInput(draft.externalWhitelistText);
  if (draft.bindMode === 'whitelist' && externalWhitelist.length === 0) {
    return 'Whitelist 모드는 외부 IP/CIDR 허용 목록이 필요합니다.';
  }

  if (externalWhitelist.some(isWideOpenCidr)) {
    return '0.0.0.0/0 또는 ::/0 같은 전체 허용 whitelist는 사용할 수 없습니다.';
  }

  if (externalWhitelist.some(value => !isValidIpv4Cidr(value))) {
    return 'Whitelist는 IPv4 또는 IPv4/CIDR 형식이어야 합니다.';
  }

  const trustedProxies = parseMcpControlListInput(draft.trustedProxiesText);
  if (trustedProxies.some(value => !isValidIpv4Cidr(value))) {
    return 'Trusted proxies는 IPv4 또는 IPv4/CIDR 형식이어야 합니다.';
  }

  if (
    draft.bindMode === 'whitelist'
    && draft.transportSecurity !== 'direct_tls'
    && draft.transportSecurity !== 'trusted_tls_proxy'
  ) {
    return 'Whitelist 모드는 direct_tls 또는 trusted_tls_proxy transport가 필요합니다.';
  }

  if (draft.bindMode === 'whitelist' && draft.transportSecurity === 'trusted_tls_proxy' && trustedProxies.length === 0) {
    return 'trusted_tls_proxy transport는 Trusted proxies 설정이 필요합니다.';
  }

  const allowedOrigins = parseMcpControlListInput(draft.allowedOriginsText);
  if (allowedOrigins.some(origin => !isValidHttpOrigin(origin))) {
    return 'Allowed origins는 http 또는 https URL origin 형식이어야 합니다.';
  }

  const headerName = draft.webhookKeyHeaderName.trim();
  if (!HEADER_NAME_PATTERN.test(headerName)) {
    return 'Webhook header 이름은 HTTP header 이름 형식이어야 합니다.';
  }

  if (['authorization', 'cookie', 'set-cookie'].includes(headerName.toLowerCase())) {
    return 'Authorization/Cookie 계열 header는 webhook key header로 사용할 수 없습니다.';
  }

  const rateWindowSeconds = Number(draft.webhookRateLimitWindowSecondsText);
  const burstLimit = Number(draft.webhookRateLimitBurstLimitText);
  if (!Number.isInteger(rateWindowSeconds) || rateWindowSeconds < 1 || !Number.isInteger(burstLimit) || burstLimit < 1) {
    return 'Webhook rate limit은 1 이상의 정수여야 합니다.';
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
    return 'Webhook key는 대상 session 또는 agent profile이 필요합니다.';
  }

  if (parseMcpControlListInput(draft.scopesText).length === 0) {
    return 'Webhook key는 하나 이상의 scope가 필요합니다.';
  }

  return null;
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
