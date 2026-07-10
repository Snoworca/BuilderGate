import crypto from 'node:crypto';
import net from 'node:net';

export const MCP_DENIAL_CODES = [
  'UNBOUND_ACTOR',
  'INVALID_SCOPE',
  'TARGET_NOT_FOUND',
  'AMBIGUOUS_TARGET',
  'STALE_SESSION_ID',
  'TARGET_NOT_LIVE',
  'INPUT_REJECTED_REPLAY_PENDING',
  'INPUT_REJECTED_ENTER_POLICY',
  'SELF_CLOSE_DENIED_NO_LEADER',
  'MCP_PORT_REBIND_FAILED',
  'WEBHOOK_KEY_INVALID',
  'MCP_WHITELIST_EMPTY',
  'MCP_WHITELIST_DENIED',
  'MCP_LOOPBACK_ONLY',
  'MCP_TRANSPORT_TLS_REQUIRED',
  'MCP_TRUSTED_PROXY_DENIED',
  'MCP_TRANSPORT_DENIED',
  'MCP_ORIGIN_DENIED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REPLAYED',
  'INVALID_TOKEN_AUDIENCE',
  'CREDENTIAL_BOUNDARY_VIOLATION',
  'WEBHOOK_BINDING_DENIED',
  'WEBHOOK_HEADER_FORBIDDEN',
  'INVALID_AGENT_STATUS',
  'INVALID_BINDING_LIFECYCLE',
  'CLOSE_CONFIRMATION_REQUIRED',
] as const;

type McpDenialCode = typeof MCP_DENIAL_CODES[number];

type StringRecord = Record<string, unknown>;

type McpSecurityConfig = {
  enabled?: boolean;
  bindMode?: string;
  bindHost?: string;
  externalWhitelist?: string[];
  transportSecurity?: string;
  trustedProxies?: string[];
  allowedOrigins?: string[];
};

type GuardRequest = {
  config?: McpSecurityConfig;
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
  credential?: {
    type?: string;
    token?: string;
    key?: string;
    fullKey?: string;
    record?: {
      keyHash?: string;
      targetSessionKey?: string;
      profileId?: string;
      mode?: string;
      scopes?: string[];
    };
  };
  dispatchKind?: string;
  expectedAudience?: string;
  sessionKey?: string;
  requiredScope?: string;
  requestedWebhook?: {
    targetSessionKey?: string;
    profileId?: string;
    mode?: string;
  };
};

type McpClaims = {
  aud: string;
  sessionKey: string;
  scope: string[];
  jti: string;
  iat: number;
  exp: number;
};

const DEFAULT_MCP_SCOPES = [
  'mcp:self.read',
  'mcp:sessions.list',
  'mcp:sessions.search',
  'mcp:message.paste',
  'mcp:status.write',
] as const;
const FIXED_MCP_ACCESS_KEY_SCOPES = [
  'mcp:sessions.list',
  'mcp:sessions.search',
  'mcp:message.paste',
  'mcp:message.submit',
] as const;

const TOKEN_SIGNING_SECRET = crypto.randomBytes(32);
const ALLOWED_AGENT_STATUS = new Set(['unknown', 'starting', 'ready', 'busy', 'waiting_input', 'completed', 'failed']);
const ALLOWED_BINDING_LIFECYCLE = new Set(['live', 'closing', 'closed', 'retired', 'failed', 'closing-failed']);
const ALLOWED_BIND_MODES = new Set(['loopback', 'whitelist']);
const ALLOWED_TRANSPORT_SECURITY = new Set(['none', 'direct_tls', 'trusted_tls_proxy']);
const FORBIDDEN_WEBHOOK_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'forwarded',
  'host',
  'content-length',
]);

// @req SEC-MCP-001
export function createDefaultMcpSecurityConfig(): McpSecurityConfig {
  return {
    enabled: true,
    bindMode: 'loopback',
    bindHost: '127.0.0.1',
    externalWhitelist: [],
    transportSecurity: 'none',
    trustedProxies: [],
    allowedOrigins: [],
  };
}

// @req SEC-MCP-001
export function validateMcpSecurityConfig(
  candidate: McpSecurityConfig,
  context: { activeConfig?: unknown } = {},
): StringRecord {
  const bindMode = candidate.bindMode ?? 'loopback';
  const transportSecurity = candidate.transportSecurity ?? 'none';
  if (!ALLOWED_BIND_MODES.has(bindMode)) {
    return validationDenied('MCP_TRANSPORT_DENIED', context.activeConfig);
  }
  if (!ALLOWED_TRANSPORT_SECURITY.has(transportSecurity)) {
    return validationDenied('MCP_TRANSPORT_DENIED', context.activeConfig);
  }
  if (!isValidOriginList(candidate.allowedOrigins ?? [])) {
    return validationDenied('MCP_ORIGIN_DENIED', context.activeConfig);
  }
  if (!isValidOptionalCidrList(candidate.externalWhitelist)) {
    return validationDenied('MCP_WHITELIST_DENIED', context.activeConfig);
  }
  if (hasWideOpenIpv4Cidr(candidate.externalWhitelist)) {
    return validationDenied('MCP_WHITELIST_DENIED', context.activeConfig);
  }
  if (!isValidOptionalCidrList(candidate.trustedProxies)) {
    return validationDenied('MCP_TRUSTED_PROXY_DENIED', context.activeConfig);
  }

  if (bindMode === 'whitelist') {
    if (!Array.isArray(candidate.externalWhitelist) || candidate.externalWhitelist.length === 0) {
      return validationDenied('MCP_WHITELIST_EMPTY', context.activeConfig);
    }
    if (transportSecurity !== 'direct_tls' && transportSecurity !== 'trusted_tls_proxy') {
      return validationDenied('MCP_TRANSPORT_TLS_REQUIRED', context.activeConfig);
    }
    if (
      transportSecurity === 'trusted_tls_proxy'
      && (!Array.isArray(candidate.trustedProxies) || candidate.trustedProxies.length === 0)
    ) {
      return validationDenied('MCP_TRUSTED_PROXY_DENIED', context.activeConfig);
    }
  } else if (candidate.bindHost && !isLoopbackAddress(candidate.bindHost)) {
    return validationDenied('MCP_LOOPBACK_ONLY', context.activeConfig);
  }

  return {
    ok: true,
    config: candidate,
  };
}

// @req SEC-MCP-001
export function evaluateMcpRequestGuard(request: GuardRequest): StringRecord {
  const config = request.config ?? createDefaultMcpSecurityConfig();
  const headers = normalizeHeaders(request.headers ?? {});
  const remoteAddress = normalizeIp(String(request.remoteAddress ?? ''));

  if (request.credential?.type === 'browser-jwt') {
    return denied('CREDENTIAL_BOUNDARY_VIOLATION');
  }

  if (config.enabled === false) {
    return denied('MCP_TRANSPORT_DENIED');
  }

  if (config.bindMode === 'whitelist') {
    const clientAddressResult = resolveWhitelistedClientAddress(config, remoteAddress, headers);
    if (!clientAddressResult.ok) {
      return denied(clientAddressResult.code);
    }
    if (!matchesAnyCidr(clientAddressResult.clientAddress, config.externalWhitelist ?? [])) {
      return denied('MCP_WHITELIST_DENIED');
    }
  } else if (!isLoopbackAddress(remoteAddress)) {
    return denied('MCP_LOOPBACK_ONLY');
  }

  const origin = headers.origin;
  if (origin && (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.includes(origin))) {
    return denied('MCP_ORIGIN_DENIED');
  }

  return validateDispatchCredential(request);
}

// @req SEC-MCP-001
export function rebindMcpListener(request: {
  current: unknown;
  candidate: unknown;
  probeResult?: { ok?: boolean; code?: string };
}): StringRecord {
  if (!isCandidateMcpListenerSafe(request.candidate)) {
    return {
      ok: false,
      code: 'MCP_PORT_REBIND_FAILED',
      activeConfig: request.current,
      persistedConfigUpdated: false,
      auditId: createAuditId(),
    };
  }

  if (request.probeResult?.ok !== true) {
    return {
      ok: false,
      code: 'MCP_PORT_REBIND_FAILED',
      activeConfig: request.current,
      persistedConfigUpdated: false,
      auditId: createAuditId(),
    };
  }

  return {
    ok: true,
    activeConfig: request.candidate,
    candidateHealthProbed: true,
    oldListenerDrained: true,
    persistedConfigUpdated: true,
    appHttpsServerRestarted: false,
    redirectServerRestarted: false,
  };
}

// @req SEC-MCP-002
export function mintMcpCapabilityToken(input: {
  audience: string;
  scopes: string[];
  sessionKey: string;
  expiresInSeconds?: number;
}): StringRecord {
  const now = Math.floor(Date.now() / 1000);
  const claims: McpClaims = {
    aud: input.audience,
    sessionKey: input.sessionKey,
    scope: [...input.scopes],
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + Math.max(1, input.expiresInSeconds ?? 300),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = signTokenPayload(payload);

  return {
    token: `${payload}.${signature}`,
    claims,
  };
}

// @req SEC-MCP-002
export function verifyMcpCapabilityToken(token: string, expected: {
  expectedAudience: string;
  sessionKey?: string;
}): StringRecord {
  const claims = parseAndVerifyToken(token);
  if (!claims) {
    return denied('INVALID_TOKEN');
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return denied('TOKEN_EXPIRED');
  }
  if (claims.aud !== expected.expectedAudience) {
    return denied('INVALID_TOKEN_AUDIENCE');
  }
  if (expected.sessionKey && claims.sessionKey !== expected.sessionKey) {
    return denied('STALE_SESSION_ID');
  }
  return {
    allowed: true,
    claims,
  };
}

// @req SEC-MCP-002
export function getDefaultMcpSessionScopes(): string[] {
  return [...DEFAULT_MCP_SCOPES];
}

// @req SEC-MCP-002
export function createMcpFixedAccessKey(): StringRecord {
  const accessKey = `bgmcp_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    accessKey,
    keyHash: hashMcpFixedAccessKey(accessKey),
  };
}

// @req SEC-MCP-002
export function verifyMcpFixedAccessKey(accessKey: string, expectedHash: string): boolean {
  return Boolean(accessKey)
    && Boolean(expectedHash)
    && timingSafeEqual(hashMcpFixedAccessKey(accessKey), expectedHash);
}

// @req SEC-MCP-002
export function getFixedMcpAccessKeyScopes(): string[] {
  return [...FIXED_MCP_ACCESS_KEY_SCOPES];
}

// @req SEC-MCP-002
export function isMcpFixedAccessKeyHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

// @req SEC-MCP-002
export function authorizeMcpScope(
  actor: { scopes?: string[]; sessionKey?: string; leaderSessionKey?: string | null },
  requiredScope: string,
  context: { targetSessionKey?: string } = {},
): StringRecord {
  if (!Array.isArray(actor.scopes) || !actor.scopes.includes(requiredScope)) {
    return denied('INVALID_SCOPE');
  }
  if (requiredScope === 'mcp:session.close_self') {
    if (!actor.leaderSessionKey || context.targetSessionKey !== actor.sessionKey) {
      return denied('SELF_CLOSE_DENIED_NO_LEADER');
    }
  }

  return { allowed: true };
}

// @req SEC-MCP-002
export function createWebhookCredential(input: {
  targetSessionKey: string;
  profileId: string;
  mode: string;
  scopes: string[];
}): StringRecord {
  const fullKey = createWebhookSecret();
  const record = {
    id: `wh_${crypto.randomUUID()}`,
    keyHash: hashWebhookSecret(fullKey),
    maskedKey: maskWebhookSecret(fullKey),
    targetSessionKey: input.targetSessionKey,
    profileId: input.profileId,
    mode: input.mode,
    scopes: [...input.scopes],
    createdAt: new Date().toISOString(),
  };

  return {
    fullKey,
    record,
  };
}

// @req SEC-MCP-002
export function rotateWebhookCredential(record: StringRecord): StringRecord {
  const fullKey = createWebhookSecret();

  return {
    fullKey,
    record: {
      ...record,
      keyHash: hashWebhookSecret(fullKey),
      maskedKey: maskWebhookSecret(fullKey),
      rotatedAt: new Date().toISOString(),
    },
  };
}

// @req SEC-MCP-002
export function authorizeWebhookInvocation(
  credential: { targetSessionKey?: string; profileId?: string; mode?: string; scopes?: string[] },
  requested: { targetSessionKey?: string; profileId?: string; mode?: string },
): StringRecord {
  const scopeAllowed = Array.isArray(credential.scopes) && credential.scopes.includes('mcp:webhook.invoke');
  const bindingAllowed = credential.targetSessionKey === requested.targetSessionKey
    && credential.profileId === requested.profileId
    && credential.mode === requested.mode;

  if (!scopeAllowed || !bindingAllowed) {
    return denied('WEBHOOK_BINDING_DENIED');
  }

  return { allowed: true };
}

// @req IR-MCP-005
export function normalizeMcpPromptPreview(input: { prompt?: string; maxChars?: number }): string {
  const maxChars = Math.max(0, input.maxChars ?? 120);
  const redacted = String(input.prompt ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bwebhook_key=[^\s&]+/gi, 'webhook_key=[REDACTED]')
    .replace(/\bkey=[^\s&]+/gi, 'key=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return redacted.length > maxChars ? redacted.slice(0, maxChars).trimEnd() : redacted;
}

// @req IR-MCP-005
export function createMcpOperationalStatus(input: {
  auditRecentEventsLimit?: number;
  events?: unknown[];
}): StringRecord {
  const limit = Math.max(0, input.auditRecentEventsLimit ?? 25);
  const events = Array.isArray(input.events) ? input.events : [];
  const recentAuditEvents = events
    .slice(-limit)
    .map((event) => redactAuditEvent(asRecord(event)));

  return {
    recentAuditEvents,
  };
}

// @req IR-MCP-005
export function validateMcpWebhookKeyHeaderName(headerName: string): StringRecord {
  const normalized = headerName.trim().toLowerCase();
  if (
    FORBIDDEN_WEBHOOK_HEADERS.has(normalized)
    || normalized.startsWith('x-forwarded-')
    || normalized.length === 0
    || !isValidHttpToken(headerName)
  ) {
    return {
      ok: false,
      code: 'WEBHOOK_HEADER_FORBIDDEN',
    };
  }

  return {
    ok: true,
    value: headerName,
  };
}

// @req IR-MCP-005
export function serializeWebhookCredentialResponse(input: {
  operation: string;
  fullKey?: string;
  fullUrl?: string;
  record?: StringRecord;
}): StringRecord {
  const response: StringRecord = {
    operation: input.operation,
    record: sanitizeWebhookRecord(input.record ?? {}),
  };

  if (input.operation === 'create' || input.operation === 'rotate') {
    response.fullKey = input.fullKey;
    response.fullUrl = input.fullUrl;
  }

  return response;
}

// @req IR-MCP-005
export function validateMcpAgentStatus(status: string): StringRecord {
  if (!ALLOWED_AGENT_STATUS.has(status)) {
    return {
      ok: false,
      code: 'INVALID_AGENT_STATUS',
    };
  }

  return {
    ok: true,
    value: status,
  };
}

// @req IR-MCP-005
export function validateMcpBindingLifecycle(lifecycle: string): StringRecord {
  if (!ALLOWED_BINDING_LIFECYCLE.has(lifecycle)) {
    return {
      ok: false,
      code: 'INVALID_BINDING_LIFECYCLE',
    };
  }

  return {
    ok: true,
    value: lifecycle,
  };
}

// @req IR-MCP-005
export function mapMcpInputRejection(input: { reason?: string }): StringRecord {
  if (input.reason === 'replay-pending') {
    return denied('INPUT_REJECTED_REPLAY_PENDING');
  }

  return denied('INPUT_REJECTED_ENTER_POLICY');
}

// @req IR-MCP-005
export function validateMcpCloseConfirmation(input: {
  pathSessionKey?: string;
  confirmClose?: boolean;
  expectedSessionKey?: string;
  confirmationNonce?: string;
  currentNonce?: string;
}): StringRecord {
  if (
    input.confirmClose !== true
    || !input.confirmationNonce
    || input.confirmationNonce !== input.currentNonce
    || input.pathSessionKey !== input.expectedSessionKey
  ) {
    return {
      ok: false,
      code: 'CLOSE_CONFIRMATION_REQUIRED',
    };
  }

  return {
    ok: true,
  };
}

function validationDenied(code: McpDenialCode, activeConfig: unknown): StringRecord {
  return {
    ok: false,
    code,
    activeConfig,
  };
}

function validateDispatchCredential(request: GuardRequest): StringRecord {
  if (request.dispatchKind === 'webhook') {
    return validateWebhookCredential(request);
  }

  const credential = request.credential;
  if (!credential || credential.type !== 'mcp-capability' || !credential.token) {
    return denied('UNBOUND_ACTOR');
  }

  const verification = verifyMcpCapabilityToken(credential.token, {
    expectedAudience: request.expectedAudience ?? 'buildergate-mcp',
    sessionKey: request.sessionKey,
  });
  if (verification.allowed === false) {
    return verification;
  }

  if (request.requiredScope) {
    const claims = asRecord(verification.claims);
    return authorizeMcpScope({
      scopes: Array.isArray(claims.scope) ? claims.scope.map(String) : [],
      sessionKey: typeof claims.sessionKey === 'string' ? claims.sessionKey : undefined,
      leaderSessionKey: null,
    }, request.requiredScope, {
      targetSessionKey: request.sessionKey,
    });
  }

  return verification;
}

function validateWebhookCredential(request: GuardRequest): StringRecord {
  const credential = request.credential;
  if (!credential || credential.type !== 'webhook-key') {
    return denied('WEBHOOK_KEY_INVALID');
  }

  const rawKey = credential.key ?? credential.fullKey ?? credential.token;
  const expectedHash = credential.record?.keyHash;
  if (!rawKey || !expectedHash || !timingSafeEqual(hashWebhookSecret(rawKey), expectedHash)) {
    return denied('WEBHOOK_KEY_INVALID');
  }

  if (!credential.record || !request.requestedWebhook) {
    return denied('WEBHOOK_BINDING_DENIED');
  }

  return authorizeWebhookInvocation(credential.record, request.requestedWebhook);
}

function isCandidateMcpListenerSafe(candidate: unknown): boolean {
  const candidateRecord = asRecord(candidate);
  const bindMode = typeof candidateRecord.bindMode === 'string' ? candidateRecord.bindMode : 'loopback';
  const bindHost = typeof candidateRecord.bindHost === 'string'
    ? candidateRecord.bindHost
    : typeof candidateRecord.host === 'string'
      ? candidateRecord.host
      : undefined;

  if (bindMode === 'whitelist') {
    return validateMcpSecurityConfig(candidateRecord).ok === true;
  }

  if (bindMode !== 'loopback') {
    return false;
  }

  return !bindHost || isLoopbackAddress(bindHost);
}

function denied(code: McpDenialCode): StringRecord {
  return {
    allowed: false,
    code,
    auditId: createAuditId(),
  };
}

function createAuditId(): string {
  return `audit_${crypto.randomUUID()}`;
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      normalized[key.toLowerCase()] = value[0];
    }
  }
  return normalized;
}

function resolveWhitelistedClientAddress(
  config: McpSecurityConfig,
  remoteAddress: string,
  headers: Record<string, string>,
): { ok: true; clientAddress: string } | { ok: false; code: McpDenialCode } {
  if (config.transportSecurity === 'trusted_tls_proxy') {
    const forwardedFor = headers['x-forwarded-for'];
    if (!forwardedFor || !matchesAnyCidr(remoteAddress, config.trustedProxies ?? [])) {
      return { ok: false, code: 'MCP_TRUSTED_PROXY_DENIED' };
    }
    if (headers['x-forwarded-proto'] !== 'https') {
      return { ok: false, code: 'MCP_TRANSPORT_DENIED' };
    }
    return { ok: true, clientAddress: normalizeIp(forwardedFor.split(',')[0]?.trim() ?? '') };
  }

  return { ok: true, clientAddress: remoteAddress };
}

function matchesAnyCidr(address: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => matchesCidr(address, cidr));
}

function isValidOptionalCidrList(cidrs: unknown): boolean {
  return cidrs === undefined || (Array.isArray(cidrs) && cidrs.every(isValidIpv4Cidr));
}

function isValidIpv4Cidr(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const [network, prefixText, extra] = value.split('/');
  if (extra !== undefined || !network || ipv4ToInt(normalizeIp(network)) === null) {
    return false;
  }
  if (prefixText === undefined) {
    return true;
  }
  const prefix = Number(prefixText);
  return /^\d+$/u.test(prefixText) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function hasWideOpenIpv4Cidr(cidrs: unknown): boolean {
  return Array.isArray(cidrs) && cidrs.some(isWideOpenIpv4Cidr);
}

function isWideOpenIpv4Cidr(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const [network, prefixText, extra] = value.split('/');
  if (extra !== undefined || !network || prefixText === undefined || ipv4ToInt(normalizeIp(network)) === null) {
    return false;
  }
  const prefix = Number(prefixText);
  return /^\d+$/u.test(prefixText) && Number.isInteger(prefix) && prefix === 0;
}

function isValidOriginList(origins: unknown): boolean {
  return Array.isArray(origins) && origins.every(isValidOrigin);
}

function isValidOrigin(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.origin === value && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function matchesCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText ?? '32');
  const addressInt = ipv4ToInt(address);
  const networkInt = ipv4ToInt(normalizeIp(network ?? ''));
  if (addressInt === null || networkInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressInt & mask) === (networkInt & mask);
}

function ipv4ToInt(address: string): number | null {
  if (net.isIP(address) !== 4) {
    return null;
  }
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return (((octets[0] ?? 0) << 24) >>> 0)
    + (((octets[1] ?? 0) << 16) >>> 0)
    + (((octets[2] ?? 0) << 8) >>> 0)
    + ((octets[3] ?? 0) >>> 0);
}

function normalizeIp(address: string): string {
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length);
  }
  return address;
}

function isLoopbackAddress(address: string): boolean {
  if (address === '::1') {
    return true;
  }
  const normalized = normalizeIp(address);
  return net.isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signTokenPayload(payload: string): string {
  return crypto.createHmac('sha256', TOKEN_SIGNING_SECRET).update(payload).digest('base64url');
}

function parseAndVerifyToken(token: string): McpClaims | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !timingSafeEqual(signature, signTokenPayload(payload))) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Partial<McpClaims>;
    if (
      typeof claims.aud !== 'string'
      || typeof claims.sessionKey !== 'string'
      || !Array.isArray(claims.scope)
      || typeof claims.jti !== 'string'
    ) {
      return null;
    }
    return claims as McpClaims;
  } catch {
    return null;
  }
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf-8');
  const rightBuffer = Buffer.from(right, 'utf-8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidHttpToken(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function createWebhookSecret(): string {
  return `bgwh_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashWebhookSecret(secret: string): string {
  return `sha256:${crypto.createHash('sha256').update(secret).digest('hex')}`;
}

function hashMcpFixedAccessKey(accessKey: string): string {
  return `sha256:${crypto.createHash('sha256').update(accessKey).digest('hex')}`;
}

function maskWebhookSecret(secret: string): string {
  const tail = secret.slice(-6);
  return `bgwh_****_${tail}`;
}

function redactAuditEvent(event: StringRecord): StringRecord {
  const redacted: StringRecord = {};
  for (const key of ['auditId', 'timestamp', 'category', 'code', 'target']) {
    if (event[key] !== undefined) {
      redacted[key] = event[key];
    }
  }
  return redacted;
}

function sanitizeWebhookRecord(record: StringRecord): StringRecord {
  const sanitized: StringRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'fullKey' || key === 'fullUrl' || key === 'keyHash') {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}
