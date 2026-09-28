import type {
  McpAgentProfileInput,
  McpAgentStatus,
  McpBindingLifecycle,
  McpClientConfigMode,
  McpControlConfig,
  McpControlConfigPatch,
} from '../../types';
import { t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';

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
const MCP_CONTROL_STATUS_LABELS: Record<string, MessageKey> = {
  unknown: 'mcp.status.unknown',
  listening: 'mcp.status.listening',
  stopped: 'mcp.status.stopped',
  starting: 'mcp.status.starting',
  ready: 'mcp.status.ready',
  running: 'mcp.status.running',
  active: 'mcp.status.active',
  inactive: 'mcp.status.inactive',
  enabled: 'mcp.status.enabled',
  disabled: 'mcp.status.disabled',
  failed: 'mcp.status.failed',
  error: 'mcp.status.error',
};
const MCP_AUDIT_ACTION_LABELS: Record<string, MessageKey> = {
  'buildergate.session.whoami': 'mcp.auditAction.buildergateSessionWhoami',
  'buildergate.session.claim': 'mcp.auditAction.buildergateSessionClaim',
  'buildergate.session.list': 'mcp.auditAction.buildergateSessionList',
  'buildergate.session.search': 'mcp.auditAction.buildergateSessionSearch',
  'buildergate.session.set_alias': 'mcp.auditAction.buildergateSessionSetAlias',
  'buildergate.session.update_status': 'mcp.auditAction.buildergateSessionUpdateStatus',
  'buildergate.session.open_agent': 'mcp.auditAction.buildergateSessionOpenAgent',
  'buildergate.session.close': 'mcp.auditAction.buildergateSessionClose',
  'buildergate.session.close_self': 'mcp.auditAction.buildergateSessionCloseSelf',
  'buildergate.message.send': 'mcp.auditAction.buildergateMessageSend',
  'buildergate.message.reply_to_leader': 'mcp.auditAction.buildergateMessageReplyToLeader',
  'buildergate.workspace.list': 'mcp.auditAction.buildergateWorkspaceList',
  'buildergate.workspace.create': 'mcp.auditAction.buildergateWorkspaceCreate',
  'buildergate.workspace.rename': 'mcp.auditAction.buildergateWorkspaceRename',
  'buildergate.workspace.delete': 'mcp.auditAction.buildergateWorkspaceDelete',
  'buildergate.terminal.list': 'mcp.auditAction.buildergateTerminalList',
  'buildergate.terminal.create': 'mcp.auditAction.buildergateTerminalCreate',
  'buildergate.terminal.delete': 'mcp.auditAction.buildergateTerminalDelete',
  'buildergate.terminal.exec': 'mcp.auditAction.buildergateTerminalExec',
  'mcp.listener.rebind': 'mcp.auditAction.mcpListenerRebind',
  'mcp.request.denied': 'mcp.auditAction.mcpRequestDenied',
  'input-gateway': 'mcp.auditAction.inputGateway',
};
const MCP_AUDIT_OUTCOME_LABELS: Record<string, MessageKey> = {
  ok: 'mcp.auditOutcome.ok',
  accepted: 'mcp.auditOutcome.accepted',
  delivered: 'mcp.auditOutcome.delivered',
  denied: 'mcp.auditOutcome.denied',
  rollback: 'mcp.auditOutcome.rollback',
  failed: 'mcp.auditOutcome.failed',
  closed: 'mcp.auditOutcome.closed',
  'closing-failed': 'mcp.auditOutcome.closingFailed',
  TOKEN_REVOKED: 'mcp.auditOutcome.tokenRevoked',
  MCP_PORT_REBIND_FAILED: 'mcp.auditOutcome.mcpPortRebindFailed',
  MCP_ORIGIN_DENIED: 'mcp.auditOutcome.mcpOriginDenied',
  CREDENTIAL_BOUNDARY_VIOLATION: 'mcp.auditOutcome.credentialBoundaryViolation',
  INVALID_TOKEN: 'mcp.auditOutcome.invalidToken',
  DELIVERY_FAILED: 'mcp.auditOutcome.deliveryFailed',
  INVALID_SCOPE: 'mcp.auditOutcome.invalidScope',
};
const MCP_WEBHOOK_MODE_LABELS: Record<string, MessageKey> = {
  paste: 'mcp.webhookMode.paste',
  'send-only': 'mcp.webhookMode.sendOnly',
  submit: 'mcp.webhookMode.submit',
};
const MCP_AGENT_STATUS_LABELS: Record<McpAgentStatus, MessageKey> = {
  unknown: 'mcp.agentStatus.unknown',
  starting: 'mcp.agentStatus.starting',
  ready: 'mcp.agentStatus.ready',
  busy: 'mcp.agentStatus.busy',
  waiting_input: 'mcp.agentStatus.waitingInput',
  completed: 'mcp.agentStatus.completed',
  failed: 'mcp.agentStatus.failed',
};
const MCP_BINDING_LIFECYCLE_LABELS: Record<McpBindingLifecycle, MessageKey> = {
  live: 'mcp.lifecycle.live',
  closing: 'mcp.lifecycle.closing',
  closed: 'mcp.lifecycle.closed',
  retired: 'mcp.lifecycle.retired',
  failed: 'mcp.lifecycle.failed',
  'closing-failed': 'mcp.lifecycle.closingFailed',
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
    return t('common.unknown');
  }
  const normalized = value.trim();
  return MCP_CONTROL_STATUS_LABELS[normalized] ? t(MCP_CONTROL_STATUS_LABELS[normalized]) : t('mcp.status.unknownValue', { value: normalized });
}

export function formatMcpAuditAction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return t('mcp.auditAction.fallback');
  }
  const normalized = value.trim();
  return MCP_AUDIT_ACTION_LABELS[normalized] ? t(MCP_AUDIT_ACTION_LABELS[normalized]) : t('mcp.auditAction.code', { value: normalized });
}

export function formatMcpAuditOutcome(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return t('mcp.auditOutcome.ok');
  }
  const normalized = value.trim();
  return MCP_AUDIT_OUTCOME_LABELS[normalized] ? t(MCP_AUDIT_OUTCOME_LABELS[normalized]) : t('mcp.auditOutcome.code', { value: normalized });
}

export function formatMcpWebhookMode(value: string): string {
  const normalized = value.trim();
  return MCP_WEBHOOK_MODE_LABELS[normalized] ? t(MCP_WEBHOOK_MODE_LABELS[normalized]) : normalized;
}

export function normalizeMcpWebhookMode(value: string): string {
  const normalized = value.trim();
  const matchedMode = Object.entries(MCP_WEBHOOK_MODE_LABELS)
    .find(([, labelKey]) => t(labelKey) === normalized)?.[0];
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
    return t('mcp.validation.port');
  }

  if (draft.bindMode !== 'whitelist' && !isLoopbackAddress(draft.host.trim())) {
    return t('mcp.validation.loopbackHost');
  }

  const externalWhitelist = parseMcpControlListInput(draft.externalWhitelistText);
  if (draft.bindMode === 'whitelist' && externalWhitelist.length === 0) {
    return t('mcp.validation.whitelistRequired');
  }

  if (externalWhitelist.some(isWideOpenCidr)) {
    return t('mcp.validation.wideOpen');
  }

  if (externalWhitelist.some(value => !isValidIpv4Cidr(value))) {
    return t('mcp.validation.whitelistFormat');
  }

  const trustedProxies = parseMcpControlListInput(draft.trustedProxiesText);
  if (trustedProxies.some(value => !isValidIpv4Cidr(value))) {
    return t('mcp.validation.trustedProxyFormat');
  }

  if (
    draft.bindMode === 'whitelist'
    && draft.transportSecurity !== 'direct_tls'
    && draft.transportSecurity !== 'trusted_tls_proxy'
  ) {
    return t('mcp.validation.whitelistTls');
  }

  if (draft.bindMode === 'whitelist' && draft.transportSecurity === 'trusted_tls_proxy' && trustedProxies.length === 0) {
    return t('mcp.validation.trustedProxyRequired');
  }

  const allowedOrigins = parseMcpControlListInput(draft.allowedOriginsText);
  if (allowedOrigins.some(origin => !isValidHttpOrigin(origin))) {
    return t('mcp.validation.originFormat');
  }

  const headerName = draft.webhookKeyHeaderName.trim();
  if (!HEADER_NAME_PATTERN.test(headerName)) {
    return t('mcp.validation.headerFormat');
  }

  if (['authorization', 'cookie', 'set-cookie'].includes(headerName.toLowerCase())) {
    return t('mcp.validation.headerForbidden');
  }

  const rateWindowSeconds = Number(draft.webhookRateLimitWindowSecondsText);
  const burstLimit = Number(draft.webhookRateLimitBurstLimitText);
  if (!Number.isInteger(rateWindowSeconds) || rateWindowSeconds < 1 || !Number.isInteger(burstLimit) || burstLimit < 1) {
    return t('mcp.validation.rateLimit');
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
    return t('mcp.validation.webhookTarget');
  }

  if (parseMcpControlListInput(draft.scopesText).length === 0) {
    return t('mcp.validation.webhookScopes');
  }

  return null;
}

export function validateMcpAgentDraft(draft: McpAgentDraftValidationInput): string | null {
  const displayName = draft.displayName.trim();
  const command = draft.command.trim();
  if (!displayName || Array.from(displayName).length > MAX_AGENT_DISPLAY_NAME_LENGTH || hasControlCharacter(displayName)) {
    return t('mcp.validation.agentName');
  }

  if (!command || hasControlCharacter(command)) {
    return t('mcp.validation.agentCommand');
  }

  if (!ALLOWED_AGENT_CONFIG_MODES.has(draft.mcpClientConfigMode)) {
    return t('mcp.validation.agentConfigMode');
  }

  const aliases = parseMcpControlListInput(draft.aliasesText);
  if (aliases.length !== new Set(aliases).size) {
    return t('mcp.validation.agentAliasDuplicate');
  }

  if (draft.kickoffPrompt.length > MAX_KICKOFF_PROMPT_LENGTH) {
    return t('mcp.validation.agentKickoffTooLong');
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
    return t(MCP_AGENT_STATUS_LABELS[value as McpAgentStatus]);
  }
  if (value === null || value === undefined || value === '') {
    return t('common.unknown');
  }
  return t('mcp.status.unknownValue', { value: String(value) });
}

export function formatMcpBindingLifecycle(value: unknown): string {
  if (typeof value === 'string' && MCP_BINDING_LIFECYCLES.has(value as McpBindingLifecycle)) {
    return t(MCP_BINDING_LIFECYCLE_LABELS[value as McpBindingLifecycle]);
  }
  if (value === null || value === undefined || value === '') {
    return t('mcp.lifecycle.none');
  }
  return t('mcp.lifecycle.unknownValue', { value: String(value) });
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
