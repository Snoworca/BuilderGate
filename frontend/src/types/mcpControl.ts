export type McpClientConfigMode = 'env' | 'generated-file' | 'manual';
export type McpAgentStatus = 'unknown' | 'starting' | 'ready' | 'busy' | 'waiting_input' | 'completed' | 'failed';
export type McpBindingLifecycle = 'live' | 'closing' | 'closed' | 'retired' | 'failed' | 'closing-failed';

export interface McpRecentAuditEvent {
  auditId?: string;
  timestamp?: string;
  action?: string;
  category?: string;
  result?: string;
  reason?: string;
  code?: string;
  targetBinding?: unknown;
  target?: unknown;
  promptHash?: string;
  promptPreview?: string;
  [key: string]: unknown;
}

export interface McpControlConfig {
  enabled: boolean;
  bindMode: string;
  host: string;
  port: number;
  transportSecurity: string;
  trustedProxies: string[];
  externalWhitelist: string[];
  allowedOrigins: string[];
  status: string;
  lastError: unknown;
  lastRebindResult: unknown;
  webhookKeyHeaderName?: string;
  webhookRateLimit?: {
    windowSeconds: number;
    burstLimit: number;
  };
  fixedAccessKeyConfigured?: boolean;
  recentAuditEvents?: McpRecentAuditEvent[];
}

export type McpControlConfigPatch = Partial<Pick<
  McpControlConfig,
  'enabled' | 'bindMode' | 'host' | 'port' | 'transportSecurity' | 'trustedProxies' | 'externalWhitelist' | 'allowedOrigins' | 'webhookKeyHeaderName' | 'webhookRateLimit'
>>;

export interface McpAgentProfile {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  aliases: string[];
  isDefault: boolean;
  enabled: boolean;
  kickoffPrompt?: string;
  mcpClientConfigMode: McpClientConfigMode;
  createdAt: string;
  updatedAt: string;
  commandSummary?: string;
}

export type McpAgentProfileInput = Partial<McpAgentProfile> & {
  displayName: string;
  command: string;
};

export interface McpWebhookKey {
  keyId: string;
  id?: string;
  maskedKey: string;
  targetSessionKey?: string;
  profileId?: string;
  mode?: string;
  scopes: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revoked: boolean;
  revokedAt?: string;
  rateLimit?: {
    windowSeconds: number;
    burstLimit: number;
  };
}

export interface McpWebhookCreateResponse extends McpWebhookKey {
  fullKey: string;
  fullUrl: string;
}

export interface McpSessionRecord {
  sessionKey: string;
  sessionId?: string;
  currentSessionId?: string;
  name?: string;
  alias: string;
  nameSource?: string;
  aliasSource?: string;
  workspaceId?: string;
  tabId?: string;
  agentKind?: string;
  agentStatus?: McpAgentStatus;
  status?: string;
  role?: string;
  leaderSessionKey?: string | null;
  bindingLifecycle?: McpBindingLifecycle;
  mcpConnected?: boolean;
  leader?: boolean;
  lastSeenAt?: string;
  cwd?: string;
  recoveryCommand?: string;
  matchReason?: string;
  closeConfirmationNonce?: string;
}

export interface McpSessionClaimCode {
  ok: true;
  sessionKey: string;
  claimCode: string;
}

export interface McpFixedAccessKeyRotation {
  ok: true;
  accessKey: string;
}

export interface McpSessionListResponse {
  includeSelf: boolean;
  sessions: McpSessionRecord[];
  matches?: McpSessionRecord[];
  allowed?: boolean;
}

export interface McpSearchResponse {
  allowed: boolean;
  readOnly?: boolean;
  matches: McpSessionRecord[];
}
