import crypto from 'node:crypto';
import {
  createWebhookCredential,
  normalizeMcpPromptPreview,
  rotateWebhookCredential,
  serializeWebhookCredentialResponse,
  validateMcpSecurityConfig,
  validateMcpAgentStatus,
  validateMcpCloseConfirmation,
} from './McpSecurityContract.js';

type StringRecord = Record<string, unknown>;

type CloseConfirmationNonceRecord = {
  nonce: string;
  expiresAtMs: number;
};

type McpControlDeps = {
  now?: () => string;
  config?: StringRecord;
  mutateConfig?: (request: unknown) => unknown;
  sessions?: StringRecord[];
  listSessions?: (request: unknown) => unknown;
  webhooks?: StringRecord[];
  currentConfirmationNonce?: unknown;
  validateCloseConfirmation?: (request: unknown) => unknown;
  searchSessions?: (request: unknown) => unknown;
  setAlias?: (request: unknown) => unknown;
  updateAgentStatus?: (request: unknown) => unknown;
  updateProfile?: (request: unknown) => unknown;
  replyGateway?: (request: unknown) => unknown;
  closeLifecycle?: (request: unknown) => unknown;
  mutateProfile?: (request: unknown) => unknown;
  mutateWebhook?: (request: unknown) => unknown;
};

const ALLOWED_CONFIG_MODES = new Set(['env', 'generated-file', 'manual']);
const MAX_KICKOFF_PROMPT_LENGTH = 12000;
const CLOSE_CONFIRMATION_NONCE_TTL_MS = 5 * 60 * 1000;

export function createMcpControlService(deps: McpControlDeps = {}): StringRecord {
  const profiles: StringRecord[] = [];
  const webhooks = normalizeWebhooks(deps.webhooks);
  const sessionStatus = new Map<string, string>();
  const controlConfig: StringRecord = { ...asRecord(deps.config) };
  const closeConfirmationNonces = new Map<string, CloseConfirmationNonceRecord>();

  const sanitizeControlSession = (session: StringRecord): StringRecord => {
    const sanitized = sanitizeSession(session);
    const sessionKey = asString(sanitized.sessionKey);
    if (sessionKey) {
      sanitized.closeConfirmationNonce = getOrCreateCloseConfirmationNonce(closeConfirmationNonces, deps, sessionKey);
    }
    return sanitized;
  };

  const getConfig = (request: unknown = {}): StringRecord => {
    const boundary = requireUiAuth(request);
    if (boundary) {
      return boundary;
    }
    return {
      enabled: controlConfig.enabled !== false,
      bindMode: asString(controlConfig.bindMode) ?? 'loopback',
      host: asString(controlConfig.host) ?? asString(controlConfig.bindHost) ?? '127.0.0.1',
      port: Number(controlConfig.port ?? 3333),
      transportSecurity: asString(controlConfig.transportSecurity) ?? 'none',
      trustedProxies: asStringArray(controlConfig.trustedProxies),
      externalWhitelist: asStringArray(controlConfig.externalWhitelist),
      allowedOrigins: asStringArray(controlConfig.allowedOrigins),
      status: asString(controlConfig.status) ?? 'stopped',
      lastError: controlConfig.lastError ?? null,
      lastRebindResult: controlConfig.lastRebindResult ?? null,
    };
  };

  const setConfig = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const previousConfig = { ...controlConfig };
    const configPatch = sanitizeConfigPatch(input);
    const rebindRequested = configPatchRequiresRebind(configPatch, previousConfig);
    Object.assign(controlConfig, configPatch);
    const validation = validateControlSecurityConfig(controlConfig, previousConfig);
    if (validation.ok === false) {
      replaceRecord(controlConfig, previousConfig);
      return validation;
    }
    const mutationResult = asRecord(await callMaybeAsync(deps.mutateConfig, {
      ...controlConfig,
      changedFields: Object.keys(configPatch),
      rebindRequested,
    }));
    if (mutationResult.ok === false) {
      replaceRecord(controlConfig, {
        ...previousConfig,
        lastError: mutationResult.lastError ?? mutationResult.code ?? previousConfig.lastError ?? null,
        lastRebindResult: mutationResult,
      });
      return mutationResult;
    }
    if (Object.keys(mutationResult).length > 0) {
      controlConfig.lastRebindResult = mutationResult;
      controlConfig.lastError = mutationResult.lastError ?? null;
      const active = asRecord(mutationResult.active);
      if (asString(active.bindHost)) {
        controlConfig.host = asString(active.bindHost);
      }
      if (active.port !== undefined) {
        controlConfig.port = Number(active.port);
      }
      if (asString(active.listenerStatus)) {
        controlConfig.status = asString(active.listenerStatus);
      }
    }
    return getConfig({ auth: { type: 'browser-jwt' } });
  };

  const createAgentProfile = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const validation = validateAgentProfileInput(input);
    if (validation.ok === false) {
      return validation;
    }
    const now = nowIso(deps);
    const profile = {
      id: asString(input.id) ?? `agent_${crypto.randomUUID()}`,
      displayName: asString(input.displayName) ?? 'Agent',
      command: asString(input.command) ?? 'codex',
      args: asStringArray(input.args),
      aliases: asStringArray(input.aliases),
      isDefault: input.isDefault === true,
      enabled: input.enabled !== false,
      kickoffPrompt: asString(input.kickoffPrompt),
      mcpClientConfigMode: asString(input.mcpClientConfigMode) ?? 'env',
      createdAt: now,
      updatedAt: now,
      commandSummary: `${asString(input.command) ?? 'codex'} ${asStringArray(input.args).join(' ')}`.trim(),
    };
    const mutationResult = asRecord(await callMaybeAsync(deps.mutateProfile, profile));
    Object.assign(profile, mutationResult);
    profiles.push(profile);
    return profile;
  };

  const updateAgentProfile = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const validation = validateAgentProfileInput(input, true);
    if (validation.ok === false) {
      return validation;
    }
    const id = asString(input.id);
    if (!id) {
      return validationError({ id: 'required' }, input);
    }
    const updated = asRecord(await callMaybeAsync(deps.updateProfile, input));
    if (updated.ok === false) {
      return updated;
    }
    return Object.keys(updated).length > 0 ? updated : { ok: true, id };
  };

  const createWebhook = (request: unknown): StringRecord => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    if (!asString(input.targetSessionKey) && !asString(input.profileId)) {
      return validationError({ targetSessionKey: 'required' });
    }
    deps.mutateWebhook?.(input);
    const credential = createWebhookCredential({
      targetSessionKey: asString(input.targetSessionKey) ?? '',
      profileId: asString(input.profileId) ?? 'codex-env',
      mode: asString(input.mode) ?? 'send-only',
      scopes: asStringArray(input.scopes).length > 0 ? asStringArray(input.scopes) : ['mcp:webhook.invoke'],
    });
    const record = {
      ...asRecord(credential.record),
      keyId: asRecord(credential.record).id,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revoked: false,
      rateLimit: { windowSeconds: 60, burstLimit: 10 },
    };
    webhooks.push(record);
    return {
      keyId: record.keyId,
      fullKey: credential.fullKey,
      fullUrl: `/webhook/agent?key=${encodeURIComponent(String(credential.fullKey))}`,
      ...sanitizeWebhook(record),
    };
  };

  const rotateWebhook = (request: unknown): StringRecord => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const id = asString(input.id);
    const record = webhooks.find(item => asString(item.keyId) === id || asString(item.id) === id);
    if (!record) {
      return { ok: false, code: 'WEBHOOK_KEY_INVALID', auditId: createAuditId() };
    }
    deps.mutateWebhook?.({ action: 'rotate', id });
    const rotated = rotateWebhookCredential(record);
    Object.assign(record, asRecord(rotated.record));
    return {
      keyId: asString(record.keyId) ?? asString(record.id),
      fullKey: rotated.fullKey,
      fullUrl: `/webhook/agent?key=${encodeURIComponent(String(rotated.fullKey))}`,
      ...sanitizeWebhook(record),
    };
  };

  const revokeWebhook = (request: unknown): StringRecord => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const id = asString(input.id);
    const record = webhooks.find(item => asString(item.keyId) === id || asString(item.id) === id);
    if (!record) {
      return { ok: false, code: 'WEBHOOK_KEY_INVALID', auditId: createAuditId() };
    }
    deps.mutateWebhook?.({ action: 'revoke', id });
    record.revoked = true;
    record.revokedAt = asString(record.revokedAt) ?? nowIso(deps);
    return {
      keyId: asString(record.keyId) ?? asString(record.id),
      revoked: true,
      revokedAt: record.revokedAt,
      auditId: createAuditId(),
    };
  };

  const listWebhooks = (request: unknown = {}): StringRecord[] | StringRecord => {
    const boundary = requireUiAuth(request);
    return boundary ?? webhooks.map(sanitizeWebhook);
  };

  const listSessions = async (request: unknown = {}): Promise<StringRecord> => {
    const boundary = requireUiAuth(request);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const includeSelf = input.includeSelf === undefined ? true : input.includeSelf === true;
    const actorSessionKey = asString(input.actorSessionKey);
    const query = asString(input.query);
    if (query) {
      const result = asRecord(await deps.searchSessions?.({ query, includeSelf, actorSessionKey }) ?? { allowed: true, matches: filterSessions(deps, query, includeSelf, actorSessionKey, sessionStatus) });
      return {
        ...result,
        includeSelf,
        matches: Array.isArray(result.matches) ? result.matches.map(asRecord).map(sanitizeControlSession) : [],
      };
    }
    const listed = deps.listSessions
      ? await callMaybeAsync(deps.listSessions, { includeSelf, actorSessionKey })
      : filterSessions(deps, undefined, includeSelf, actorSessionKey, sessionStatus);
    const listedRecord = asRecord(listed);
    const rawSessions = Array.isArray(listed)
      ? listed
      : Array.isArray(listedRecord.sessions) ? listedRecord.sessions : [];
    return {
      includeSelf,
      sessions: rawSessions.map(asRecord).map(session => {
        const sessionKey = asString(session.sessionKey);
        const override = sessionKey ? sessionStatus.get(sessionKey) : undefined;
        return sanitizeControlSession(override ? { ...session, agentStatus: override } : session);
      }),
    };
  };

  const searchSessions = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const query = asString(input.query) ?? '';
    const result = asRecord(await deps.searchSessions?.({ query, includeSelf: input.includeSelf !== false }) ?? {
      allowed: true,
      matches: filterSessions(deps, query, true, undefined, sessionStatus).map(session => ({
        ...session,
        matchReason: deriveMatchReason(session, query),
      })),
    });
    return {
      allowed: result.allowed !== false,
      matches: Array.isArray(result.matches)
        ? result.matches.map(asRecord).map(session => {
          const sessionKey = asString(session.sessionKey);
          const override = sessionKey ? sessionStatus.get(sessionKey) : undefined;
          return sanitizeSearchMatch(sanitizeControlSession(override ? { ...session, agentStatus: override } : session));
        })
        : [],
    };
  };

  const searchTest = async (request: unknown): Promise<StringRecord> => {
    const result = await searchSessions(request);
    return {
      ...result,
      matches: Array.isArray(result.matches) ? result.matches.map(stripCloseConfirmationNonce) : [],
      readOnly: true,
    };
  };

  const setSessionAlias = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const aliasRequest = {
      sessionKey: asString(input.sessionKey),
      alias: asString(input.alias),
    };
    const result = asRecord(deps.setAlias
      ? await callMaybeAsync(deps.setAlias, aliasRequest)
      : {
        sessionKey: asString(input.sessionKey),
        alias: asString(input.alias),
        name: asString(input.alias),
        nameSource: 'user',
      });
    return sanitizeSession({ ...result, alias: result.alias ?? result.name, aliasSource: result.aliasSource ?? result.nameSource });
  };

  const replyTest = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const replyRequest = {
      source: asString(input.source) ?? 'mcp-reply-to-leader',
      target: { sessionKey: asString(input.sessionKey) },
      data: asString(input.prompt) ?? '',
      delivery: { mode: asString(input.deliveryMode) ?? 'paste', submit: false },
      replayPolicy: 'reject',
      auditContext: { purpose: 'reply-test' },
    };
    const result = asRecord(deps.replyGateway
      ? await callMaybeAsync(deps.replyGateway, replyRequest)
      : { accepted: true, auditId: createAuditId() });
    return {
      accepted: result.accepted !== false,
      auditId: result.auditId ?? createAuditId(),
      code: result.code,
    };
  };

  const closeSession = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const sessionKey = asString(input.sessionKey);
    const defaultConfirmation = () => validateMcpCloseConfirmation({
      pathSessionKey: sessionKey,
      expectedSessionKey: asString(input.expectedSessionKey),
      confirmClose: input.confirmClose === true,
      confirmationNonce: asString(input.confirmationNonce),
      currentNonce: getCurrentCloseConfirmationNonce(closeConfirmationNonces, deps, sessionKey)?.nonce,
    });
    const usesInternalConfirmation = !deps.validateCloseConfirmation;
    const confirmation = asRecord(deps.validateCloseConfirmation
      ? await callMaybeAsync(deps.validateCloseConfirmation, input)
      : defaultConfirmation());
    if (confirmation.ok === false) {
      return { ok: false, code: confirmation.code ?? 'CLOSE_CONFIRMATION_REQUIRED' };
    }
    if (usesInternalConfirmation) {
      consumeCloseConfirmationNonce(closeConfirmationNonces, sessionKey, asString(input.confirmationNonce));
    }
    const closeRequest = {
      sessionKey,
      confirmClose: true,
      confirmationNonce: asString(input.confirmationNonce),
    };
    const result = asRecord(deps.closeLifecycle
      ? await callMaybeAsync(deps.closeLifecycle, closeRequest)
      : { ok: true, status: 'closed' });
    return {
      ok: result.ok !== false,
      status: result.status ?? (result.ok === false ? 'failed' : 'closed'),
      code: result.code,
    };
  };

  const updateAgentStatus = async (request: unknown): Promise<StringRecord> => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const sessionKey = asString(input.sessionKey);
    const agentStatus = asString(input.agentStatus) ?? '';
    const validation = validateMcpAgentStatus(agentStatus);
    if (validation.ok === false) {
      return { ok: false, code: validation.code };
    }
    const updated = asRecord(await callMaybeAsync(deps.updateAgentStatus, { sessionKey, agentStatus }));
    if (updated.ok === false) {
      return { ok: false, sessionKey, agentStatus, ...updated };
    }
    if (sessionKey) {
      sessionStatus.set(sessionKey, agentStatus);
    }
    return { ...updated, ok: true, sessionKey, agentStatus };
  };

  const handleDeferredCloseSelfFailure = (request: unknown): StringRecord => {
    const boundary = requireUiAuth(request, true);
    if (boundary) {
      return boundary;
    }
    const input = asRecord(request);
    const sessionKey = asString(input.sessionKey);
    deps.replyGateway?.({
      source: 'close-self-failure-notification',
      target: { leaderSessionKey: asString(input.leaderSessionKey) },
      data: `close_self failed for ${sessionKey}`,
      delivery: { mode: 'paste', submit: false },
      replayPolicy: 'reject',
    });
    return {
      ok: true,
      sessionKey,
      bindingLifecycle: 'closing-failed',
      auditId: createAuditId(),
    };
  };

  return {
    getConfig,
    setConfig,
    createAgentProfile,
    updateAgentProfile,
    createWebhook,
    rotateWebhook,
    revokeWebhook,
    listWebhooks,
    listSessions,
    searchSessions,
    searchTest,
    setSessionAlias,
    replyTest,
    closeSession,
    updateAgentStatus,
    handleDeferredCloseSelfFailure,
  };
}

export function mergeMcpControlSecurityConfig(current: StringRecord, input: StringRecord, defaults: StringRecord = {}): StringRecord {
  const bindHostInputKey = hasOwn(input, 'host') ? 'host' : hasOwn(input, 'bindHost') ? 'bindHost' : null;
  const portSource = hasOwn(input, 'port') ? input.port : current.port ?? defaults.port ?? 3333;
  return {
    enabled: hasOwn(input, 'enabled') ? input.enabled !== false : current.enabled !== false,
    bindMode: mergeStringField(current, input, 'bindMode', 'loopback'),
    bindHost: bindHostInputKey
      ? asString(input[bindHostInputKey]) ?? input[bindHostInputKey]
      : asString(current.bindHost) ?? asString(current.host) ?? asString(defaults.bindHost) ?? asString(defaults.host) ?? '127.0.0.1',
    externalWhitelist: mergeStringArrayField(current, input, 'externalWhitelist'),
    transportSecurity: mergeStringField(current, input, 'transportSecurity', 'none'),
    trustedProxies: mergeStringArrayField(current, input, 'trustedProxies'),
    allowedOrigins: mergeStringArrayField(current, input, 'allowedOrigins'),
    port: Number(portSource),
  };
}

function requireUiAuth(request: unknown, mutation = false): StringRecord | null {
  const auth = asRecord(asRecord(request).auth);
  if (auth.type !== 'browser-jwt') {
    return { ok: false, code: 'CREDENTIAL_BOUNDARY_VIOLATION' };
  }
  void mutation;
  return null;
}

function validateAgentProfileInput(input: StringRecord, partial = false): StringRecord {
  const fieldErrors: StringRecord = {};
  const displayName = asString(input.displayName);
  const command = asString(input.command);
  if (
    (!partial || input.displayName !== undefined)
    && (!displayName || Array.from(displayName).length > 80 || /[\u0000-\u001f\u007f]/u.test(displayName))
  ) {
    fieldErrors.displayName = 'invalid';
  }
  if (
    (!partial || input.command !== undefined)
    && (!command || /[\u0000-\u001f\u007f]/u.test(command))
  ) {
    fieldErrors.command = 'invalid';
  }
  if (input.args !== undefined && !Array.isArray(input.args)) {
    fieldErrors.args = 'must-be-array';
  }
  const aliases = asStringArray(input.aliases);
  if (input.aliases !== undefined && aliases.length !== new Set(aliases).size) {
    fieldErrors.aliases = 'duplicate';
  }
  if (input.mcpClientConfigMode !== undefined && !ALLOWED_CONFIG_MODES.has(String(input.mcpClientConfigMode))) {
    fieldErrors.mcpClientConfigMode = 'invalid';
  }
  if (String(input.kickoffPrompt ?? '').length > MAX_KICKOFF_PROMPT_LENGTH) {
    fieldErrors.kickoffPrompt = 'too-large';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return validationError(fieldErrors, input);
  }
  return { ok: true };
}

function validationError(fieldErrors: StringRecord, source: StringRecord = {}): StringRecord {
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    requestId: createAuditId(),
    fieldErrors,
    promptPreview: normalizeMcpPromptPreview({ prompt: asString(source.kickoffPrompt) ?? asString(source.prompt), maxChars: 80 }),
  };
}

function sanitizeConfigPatch(input: StringRecord): StringRecord {
  const patch: StringRecord = {};
  for (const key of [
    'enabled',
    'bindMode',
    'host',
    'port',
    'transportSecurity',
    'trustedProxies',
    'externalWhitelist',
    'allowedOrigins',
  ]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      patch[key] = input[key];
    }
  }
  return patch;
}

function configPatchRequiresRebind(patch: StringRecord, previousConfig: StringRecord): boolean {
  const hostChanged = Object.prototype.hasOwnProperty.call(patch, 'host')
    && (asString(patch.host) ?? '127.0.0.1') !== (asString(previousConfig.host) ?? asString(previousConfig.bindHost) ?? '127.0.0.1');
  const portChanged = Object.prototype.hasOwnProperty.call(patch, 'port')
    && Number(patch.port ?? 3333) !== Number(previousConfig.port ?? 3333);
  const enabledChanged = Object.prototype.hasOwnProperty.call(patch, 'enabled')
    && (patch.enabled !== false) !== (previousConfig.enabled !== false);
  const transportSecurityChanged = Object.prototype.hasOwnProperty.call(patch, 'transportSecurity')
    && (asString(patch.transportSecurity) ?? 'none') !== (asString(previousConfig.transportSecurity) ?? 'none');
  return hostChanged || portChanged || enabledChanged || transportSecurityChanged;
}

function validateControlSecurityConfig(candidate: StringRecord, active: StringRecord): StringRecord {
  return asRecord(validateMcpSecurityConfig(
    toSecurityConfig(candidate),
    { activeConfig: toSecurityConfig(active) },
  ));
}

function toSecurityConfig(config: StringRecord): StringRecord {
  return {
    enabled: config.enabled !== false,
    bindMode: asString(config.bindMode) ?? 'loopback',
    bindHost: asString(config.host) ?? asString(config.bindHost) ?? '127.0.0.1',
    externalWhitelist: securityStringArrayField(config, 'externalWhitelist'),
    transportSecurity: asString(config.transportSecurity) ?? 'none',
    trustedProxies: securityStringArrayField(config, 'trustedProxies'),
    allowedOrigins: securityStringArrayField(config, 'allowedOrigins'),
  };
}

function securityStringArrayField(config: StringRecord, key: string): unknown {
  const value = config[key];
  return Array.isArray(value) || value === undefined ? asStringArray(value) : value;
}

function mergeStringField(current: StringRecord, input: StringRecord, key: string, fallback: string): unknown {
  if (hasOwn(input, key)) {
    return asString(input[key]) ?? input[key];
  }
  return asString(current[key]) ?? fallback;
}

function mergeStringArrayField(current: StringRecord, input: StringRecord, key: string): unknown {
  if (hasOwn(input, key)) {
    return Array.isArray(input[key]) ? asStringArray(input[key]) : input[key];
  }
  return Array.isArray(current[key]) ? asStringArray(current[key]) : [];
}

function hasOwn(record: StringRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function replaceRecord(target: StringRecord, source: StringRecord): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

async function callMaybeAsync(fn: ((request: unknown) => unknown) | undefined, request: unknown): Promise<unknown> {
  return fn ? await fn(request) : undefined;
}

function normalizeWebhooks(value: unknown): StringRecord[] {
  const raw = Array.isArray(value) ? value.map(asRecord) : [];
  return raw.map((record, index) => ({
    keyId: asString(record.keyId) ?? asString(record.id) ?? `wh_${index + 1}`,
    id: asString(record.id) ?? asString(record.keyId) ?? `wh_${index + 1}`,
    maskedKey: asString(record.maskedKey) ?? 'bgwh_****_key',
    targetSessionKey: record.targetSessionKey,
    profileId: record.profileId,
    mode: record.mode,
    scopes: asStringArray(record.scopes),
    lastUsedAt: record.lastUsedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    revoked: record.revoked === true,
    rateLimit: record.rateLimit ?? { windowSeconds: 60, burstLimit: 10 },
  }));
}

function sanitizeWebhook(record: StringRecord): StringRecord {
  return {
    keyId: asString(record.keyId) ?? asString(record.id),
    id: asString(record.id) ?? asString(record.keyId),
    maskedKey: asString(record.maskedKey),
    targetSessionKey: record.targetSessionKey,
    profileId: record.profileId,
    mode: record.mode,
    scopes: asStringArray(record.scopes),
    lastUsedAt: record.lastUsedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    revoked: record.revoked === true,
    revokedAt: record.revokedAt,
    rateLimit: record.rateLimit ?? { windowSeconds: 60, burstLimit: 10 },
  };
}

function filterSessions(
  deps: McpControlDeps,
  query?: string,
  includeSelf = true,
  actorSessionKey?: string,
  statusOverrides?: Map<string, string>,
): StringRecord[] {
  const normalizedQuery = query?.trim().toLowerCase();
  return (Array.isArray(deps.sessions) ? deps.sessions.map(asRecord) : [])
    .filter(session => includeSelf || !actorSessionKey || asString(session.sessionKey) !== actorSessionKey)
    .filter(session => !normalizedQuery || searchableText(session).includes(normalizedQuery))
    .map(session => {
      const key = asString(session.sessionKey);
      const agentStatus = key ? statusOverrides?.get(key) : undefined;
      return agentStatus ? { ...session, agentStatus } : { ...session };
    });
}

function searchableText(session: StringRecord): string {
  return [
    session.alias,
    session.name,
    session.agentKind,
    session.role,
    session.cwd,
    session.recoveryCommand,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
}

function sanitizeSession(session: StringRecord): StringRecord {
  const sessionKey = asString(session.sessionKey);
  return {
    sessionKey,
    name: asString(session.name) ?? asString(session.alias) ?? sessionKey,
    alias: asString(session.alias) ?? asString(session.name) ?? sessionKey,
    nameSource: asString(session.nameSource) ?? asString(session.aliasSource),
    aliasSource: asString(session.aliasSource) ?? asString(session.nameSource),
    workspaceId: session.workspaceId,
    tabId: session.tabId,
    agentKind: session.agentKind,
    agentStatus: asString(session.agentStatus) ?? 'unknown',
    role: session.role,
    cwd: session.cwd,
    recoveryCommand: session.recoveryCommand,
    matchReason: session.matchReason,
  };
}

function sanitizeSearchMatch(session: StringRecord): StringRecord {
  return {
    ...sanitizeSession(session),
    closeConfirmationNonce: session.closeConfirmationNonce,
    status: session.status ?? session.agentStatus,
    matchReason: session.matchReason,
  };
}

function stripCloseConfirmationNonce(session: unknown): StringRecord {
  const record = { ...asRecord(session) };
  delete record.closeConfirmationNonce;
  return record;
}

function getOrCreateCloseConfirmationNonce(
  records: Map<string, CloseConfirmationNonceRecord>,
  deps: McpControlDeps,
  sessionKey: string,
): string {
  const current = getCurrentCloseConfirmationNonce(records, deps, sessionKey);
  if (current) {
    return current.nonce;
  }
  const nonce = `close_${crypto.randomUUID()}`;
  records.set(sessionKey, {
    nonce,
    expiresAtMs: currentTimeMs(deps) + CLOSE_CONFIRMATION_NONCE_TTL_MS,
  });
  return nonce;
}

function getCurrentCloseConfirmationNonce(
  records: Map<string, CloseConfirmationNonceRecord>,
  deps: McpControlDeps,
  sessionKey?: string,
): CloseConfirmationNonceRecord | undefined {
  if (!sessionKey) {
    return undefined;
  }
  purgeExpiredCloseConfirmationNonces(records, deps);
  return records.get(sessionKey);
}

function consumeCloseConfirmationNonce(
  records: Map<string, CloseConfirmationNonceRecord>,
  sessionKey?: string,
  nonce?: string,
): void {
  if (!sessionKey || !nonce) {
    return;
  }
  const current = records.get(sessionKey);
  if (current?.nonce === nonce) {
    records.delete(sessionKey);
  }
}

function purgeExpiredCloseConfirmationNonces(records: Map<string, CloseConfirmationNonceRecord>, deps: McpControlDeps): void {
  const nowMs = currentTimeMs(deps);
  for (const [sessionKey, record] of records.entries()) {
    if (record.expiresAtMs <= nowMs) {
      records.delete(sessionKey);
    }
  }
}

function currentTimeMs(deps: McpControlDeps): number {
  const parsed = Date.parse(nowIso(deps));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function deriveMatchReason(session: StringRecord, query: string): string {
  const normalized = query.toLowerCase();
  if (String(session.role ?? '').toLowerCase().includes(normalized)) {
    return 'role';
  }
  if (String(session.recoveryCommand ?? '').toLowerCase().includes(normalized)) {
    return 'recoveryCommand';
  }
  if (String(session.agentKind ?? '').toLowerCase().includes(normalized)) {
    return 'agentKind';
  }
  if (String(session.cwd ?? '').toLowerCase().includes(normalized)) {
    return 'cwd';
  }
  return 'alias';
}

function createAuditId(): string {
  return `audit_${crypto.randomUUID()}`;
}

function nowIso(deps: McpControlDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(item => item.trim() !== '') : [];
}
