import crypto from 'node:crypto';
import net from 'node:net';
import {
  createDefaultMcpSecurityConfig,
  getDefaultMcpSessionScopes,
  mintMcpCapabilityToken,
  validateMcpAgentStatus,
  validateMcpSecurityConfig,
  verifyMcpCapabilityToken,
} from './McpSecurityContract.js';

type StringRecord = Record<string, unknown>;

type McpToolServiceDeps = {
  now?: () => string;
  audit?: (event: StringRecord) => void;
  log?: (event: StringRecord) => void;
  createAssignment?: (assignment: StringRecord) => unknown;
  deliverMessage?: (delivery: StringRecord) => unknown | Promise<unknown>;
  sessions?: unknown[] | (() => unknown[] | Promise<unknown[]>);
  listSessions?: (actorSessionKey: string | undefined, includeSelf: boolean) => unknown[] | Promise<unknown[]>;
  searchSessions?: (actorSessionKey: string | undefined, query: string, includeSelf: boolean) => unknown | Promise<unknown>;
  setSessionAlias?: (targetSessionKey: string, alias: string, actorSessionKey: string | undefined) => unknown | Promise<unknown>;
  claimCodes?: Map<string, StringRecord>;
  listener?: StringRecord | (() => StringRecord);
  agentLifecycle?: {
    openAgent?: (request: unknown) => unknown | Promise<unknown>;
    updateStatus?: (request: unknown) => unknown | Promise<unknown>;
    closeSession?: (request: unknown) => unknown | Promise<unknown>;
    closeSelf?: (request: unknown) => unknown | Promise<unknown>;
  };
};

type McpToolServiceState = {
  assignments: Map<string, StringRecord>;
  auditEvents: StringRecord[];
  validationResults: StringRecord[];
  listener: StringRecord;
};

type ListenerControllerDeps = {
  current?: StringRecord;
  audit?: (event: StringRecord) => void;
  healthProbe?: (candidate: StringRecord) => unknown | Promise<unknown>;
  bindListener?: (candidate: StringRecord) => unknown | Promise<unknown>;
  closeListener?: (handle: unknown) => unknown | Promise<unknown>;
  isCredentialRevoked?: (credential: StringRecord) => boolean;
};

export const BUILDERGATE_MCP_TOOL_NAMES = [
  'buildergate.session.whoami',
  'buildergate.session.claim',
  'buildergate.session.list',
  'buildergate.session.search',
  'buildergate.message.send',
  'buildergate.session.set_alias',
  'buildergate.session.open_agent',
  'buildergate.session.close',
  'buildergate.session.close_self',
  'buildergate.message.reply_to_leader',
  'buildergate.session.update_status',
] as const;

const SECRET_FIELD_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'rawtoken',
  'actortoken',
  'mcptoken',
  'secret',
  'fullkey',
  'fullurl',
  'keyhash',
  'webhookkey',
]);

const TOOL_SCHEMAS: Record<string, StringRecord> = {
  'buildergate.session.whoami': {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  'buildergate.session.claim': {
    type: 'object',
    properties: {
      claimCode: { type: 'string' },
      sessionKey: { type: 'string' },
    },
    required: ['claimCode', 'sessionKey'],
    additionalProperties: false,
  },
  'buildergate.session.list': {
    type: 'object',
    properties: {
      includeSelf: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  'buildergate.session.search': {
    type: 'object',
    properties: {
      query: { type: 'string' },
      includeSelf: { type: 'boolean' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  'buildergate.message.send': {
    type: 'object',
    properties: {
      sessionKey: { type: 'string' },
      prompt: { type: 'string' },
      deliveryMode: { type: 'string', enum: ['paste', 'submit'] },
    },
    required: ['sessionKey', 'prompt'],
    additionalProperties: false,
  },
  'buildergate.session.set_alias': {
    type: 'object',
    properties: {
      sessionKey: { type: 'string' },
      alias: { type: 'string' },
    },
    required: ['sessionKey', 'alias'],
    additionalProperties: false,
  },
  'buildergate.session.open_agent': {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
      leaderSessionKey: { type: 'string' },
    },
    additionalProperties: false,
  },
  'buildergate.session.close': {
    type: 'object',
    properties: {
      sessionKey: { type: 'string' },
      expectedSessionKey: { type: 'string' },
      confirmClose: { type: 'boolean' },
      confirmationNonce: { type: 'string' },
    },
    required: ['sessionKey', 'expectedSessionKey', 'confirmClose', 'confirmationNonce'],
    additionalProperties: false,
  },
  'buildergate.session.close_self': {
    type: 'object',
    properties: {
      confirmClose: { type: 'boolean' },
      confirmationNonce: { type: 'string' },
    },
    additionalProperties: false,
  },
  'buildergate.message.reply_to_leader': {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      deliveryMode: { type: 'string', enum: ['paste', 'submit'] },
    },
    additionalProperties: false,
  },
  'buildergate.session.update_status': {
    type: 'object',
    properties: {
      agentStatus: { type: 'string' },
      statusMessage: { type: 'string' },
    },
    required: ['agentStatus'],
    additionalProperties: false,
  },
};

// @req IR-MCP-001
// @req OBS-MCP-001
export function createMcpToolService(deps: McpToolServiceDeps = {}): StringRecord {
  const state: McpToolServiceState = {
    assignments: new Map(),
    auditEvents: [],
    validationResults: [],
    listener: normalizeListenerStatus(asRecord(resolveMaybeFunction(deps.listener) ?? {})),
  };

  return {
    listTools: () => listTools(),
    callTool: (request: unknown) => callTool(deps, state, asRecord(request)),
    getStatus: () => getServiceStatus(deps, state),
    getAssignmentStatus: (request: unknown) => getAssignmentStatus(state, asRecord(request)),
    getVerificationCoverage: () => getVerificationCoverage(state),
    recordValidationResult: (request: unknown) => recordValidationResult(state, asRecord(request)),
  };
}

// @req IR-MCP-001
// @req SEC-MCP-001
export function createMcpHttpHandler(input: { service: StringRecord; listenerController?: StringRecord }): StringRecord {
  return {
    handleRequest: async (request: unknown) => handleMcpHttpRequest(input, asRecord(request)),
  };
}

// @req SEC-MCP-001
// @req OBS-MCP-001
export function createMcpListenerController(deps: ListenerControllerDeps = {}): StringRecord {
  let active = normalizeListenerStatus(deps.current ?? {});
  let activeHandle: unknown = null;
  let lastRebindResult: StringRecord | null = null;
  let lastError: string | null = null;
  const rejectedRequestCounters: Record<string, number> = {};

  const getStatus = (): StringRecord => ({
    ...active,
    enabled: active.enabled !== false,
    listenerStatus: active.listenerStatus ?? 'listening',
    activeConnectionCount: Number(active.activeConnectionCount ?? 0),
    lastRebindResult,
    lastError,
    rejectedRequestCounters,
    active,
  });

  return {
    start: async (request: unknown) => {
      const payload = asRecord(request);
      const candidate = normalizeListenerStatus({ ...active, ...payload, enabled: payload.enabled ?? true });
      if (deps.bindListener) {
        try {
          activeHandle = await deps.bindListener(candidate);
          active = normalizeListenerStatus({ ...candidate, ...listenerRuntimeStatus(activeHandle), listenerStatus: 'listening' });
          lastError = null;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          active = normalizeListenerStatus({ ...candidate, listenerStatus: 'error', lastError });
          return { ...getStatus(), ok: false, code: 'MCP_LISTENER_START_FAILED' };
        }
      } else {
        active = candidate;
      }
      return getStatus();
    },
    stop: async () => {
      const handle = activeHandle;
      activeHandle = null;
      if (handle && deps.closeListener) {
        await deps.closeListener(handle);
      }
      active = normalizeListenerStatus({ ...active, enabled: false, listenerStatus: 'stopped', activeConnectionCount: 0 });
      return getStatus();
    },
    getStatus,
    updatePolicy: (request: unknown) => {
      const payload = asRecord(request);
      const candidate = normalizeListenerStatus({
        ...active,
        ...payload,
        bindHost: asString(payload.bindHost) ?? asString(payload.host) ?? asString(active.bindHost) ?? '127.0.0.1',
        port: active.port,
        listenerStatus: active.listenerStatus,
        activeConnectionCount: active.activeConnectionCount,
      });
      const validation = validateMcpListenerConfig({ current: active, candidate });
      if (validation.ok === false) {
        return {
          ok: false,
          code: validation.code,
          active,
        };
      }
      active = candidate;
      lastError = null;
      return {
        ok: true,
        policyUpdated: true,
        active,
      };
    },
    evaluateRequest: (request: unknown) => {
      const credential = asRecord(asRecord(request).credential);
      if (deps.isCredentialRevoked?.(credential) === true) {
        const auditId = createAuditId();
        rejectedRequestCounters.TOKEN_REVOKED = (rejectedRequestCounters.TOKEN_REVOKED ?? 0) + 1;
        emitListenerAudit(deps, asRecord(request), {
          auditId,
          code: 'TOKEN_REVOKED',
          result: 'denied',
        });
        return { ok: false, code: 'TOKEN_REVOKED', auditId, dispatched: false };
      }
      const result = evaluateMcpTransportRequest({
        config: listenerConfigFromActive(active),
        ...asRecord(request),
      });
      if (result.ok === false) {
        const code = String(result.code);
        rejectedRequestCounters[code] = (rejectedRequestCounters[code] ?? 0) + 1;
        const auditId = asString(result.auditId) ?? createAuditId();
        emitListenerAudit(deps, asRecord(request), {
          auditId,
          code,
          result: 'denied',
        });
        return { ...result, auditId, dispatched: false };
      }
      return { ...result, dispatched: true };
    },
    rebind: async (request: unknown) => {
      const payload = asRecord(request);
      const current = normalizeListenerStatus(asRecord(payload.current).bindHost ? asRecord(payload.current) : active);
      const candidate = normalizeListenerStatus(asRecord(payload.candidate));
      const validation = validateMcpListenerConfig({ current, candidate });
      let candidateHandle: unknown = null;
      if (validation.ok === true && deps.bindListener) {
        try {
          candidateHandle = await deps.bindListener(candidate);
        } catch (error) {
          const auditId = createAuditId();
          lastError = error instanceof Error ? error.message : String(error);
          active = current;
          lastRebindResult = {
            ok: false,
            code: 'MCP_PORT_REBIND_FAILED',
            active,
          };
          emitListenerAudit(deps, payload, {
            auditId,
            action: 'mcp.listener.rebind',
            code: 'MCP_PORT_REBIND_FAILED',
            result: 'rollback',
          });
          return {
            ok: false,
            code: 'MCP_PORT_REBIND_FAILED',
            active,
            persisted: current,
            lastError,
            auditId,
          };
        }
      }
      const probeResult = asRecord(payload.probeResult ?? await deps.healthProbe?.(candidate) ?? { ok: true });
      if (validation.ok === false || probeResult.ok !== true) {
        if (candidateHandle && deps.closeListener) {
          await deps.closeListener(candidateHandle);
        }
        const auditId = createAuditId();
        lastError = String(probeResult.code ?? validation.code ?? 'MCP_PORT_REBIND_FAILED');
        active = current;
        lastRebindResult = {
          ok: false,
          code: 'MCP_PORT_REBIND_FAILED',
          active,
        };
        emitListenerAudit(deps, payload, {
          auditId,
          action: 'mcp.listener.rebind',
          code: 'MCP_PORT_REBIND_FAILED',
          result: 'rollback',
        });
        return {
          ok: false,
          code: 'MCP_PORT_REBIND_FAILED',
          active,
          persisted: current,
          lastError,
          auditId,
        };
      }

      const previousHandle = activeHandle;
      activeHandle = candidateHandle ?? activeHandle;
      active = normalizeListenerStatus({ ...candidate, ...listenerRuntimeStatus(candidateHandle), listenerStatus: 'listening' });
      lastError = null;
      lastRebindResult = {
        ok: true,
        active,
      };
      if (previousHandle && previousHandle !== activeHandle && deps.closeListener) {
        await deps.closeListener(previousHandle);
      }
      return {
        ok: true,
        candidateHealthProbed: true,
        active,
        oldListenerDrained: true,
        appServerRestarted: false,
        redirectServerRestarted: false,
      };
    },
  };
}

// @req SEC-MCP-001
export function validateMcpListenerConfig(input: unknown): StringRecord {
  const request = asRecord(input);
  const current = normalizeListenerStatus(asRecord(request.current));
  const candidate = asRecord(request.candidate);
  const candidateBindHost = asString(candidate.bindHost);
  const candidateConfig = {
    bindMode: asString(candidate.bindMode) ?? (candidateBindHost && isLoopbackAddress(candidateBindHost) ? 'loopback' : undefined),
    bindHost: candidateBindHost,
    externalWhitelist: stringArray(candidate.externalWhitelist),
    transportSecurity: asString(candidate.transportSecurity),
    trustedProxies: stringArray(candidate.trustedProxies),
    allowedOrigins: stringArray(candidate.allowedOrigins),
  };
  const validation = validateMcpSecurityConfig(candidateConfig, { activeConfig: current });
  if (validation.ok === false) {
    return {
      ok: false,
      code: validation.code,
      activeListener: current,
    };
  }
  if (candidateConfig.bindMode !== 'whitelist' && candidateConfig.bindHost && !isLoopbackAddress(String(candidateConfig.bindHost))) {
    return {
      ok: false,
      code: 'MCP_LOOPBACK_ONLY',
      activeListener: current,
    };
  }
  return {
    ok: true,
    candidate: normalizeListenerStatus(candidate),
  };
}

// @req SEC-MCP-001
export function evaluateMcpTransportRequest(input: unknown): StringRecord {
  const request = asRecord(input);
  const config = normalizeTransportConfig(request.config);
  const headers = normalizeHeaders(asRecord(request.headers));
  const remoteAddress = normalizeIp(asString(request.remoteAddress) ?? '');
  const transportDenial = evaluateTransportBoundary(config, remoteAddress, headers);
  if (transportDenial) {
    return deniedTransport(transportDenial);
  }

  const origin = headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    return deniedTransport('MCP_ORIGIN_DENIED');
  }

  const credential = asRecord(request.credential);
  if (credential.type === 'browser-jwt') {
    return deniedTransport('CREDENTIAL_BOUNDARY_VIOLATION');
  }
  if (credential.type === 'mcp') {
    return {
      ok: true,
      actor: sanitizeActor(credential),
    };
  }
  if (
    credential.type === 'mcp-claim-bootstrap'
    && request.allowClaimBootstrap === true
    && asString(request.requestedToolName) === 'buildergate.session.claim'
  ) {
    return {
      ok: true,
      actor: {
        type: 'mcp',
        scopes: ['mcp:session.claim'],
      },
    };
  }
  if (credential.type !== 'mcp-capability' || !asString(credential.token)) {
    return deniedTransport('INVALID_TOKEN');
  }

  const verification = verifyMcpCapabilityToken(asString(credential.token) ?? '', {
    expectedAudience: asString(request.expectedAudience) ?? 'buildergate-mcp',
    sessionKey: asString(request.sessionKey),
  });
  if (verification.allowed === false) {
    return {
      ok: false,
      code: verification.code,
      auditId: verification.auditId ?? createAuditId(),
    };
  }

  const claims = asRecord(verification.claims);
  return {
    ok: true,
    actor: {
      type: 'mcp',
      sessionKey: claims.sessionKey,
      scopes: Array.isArray(claims.scope) ? claims.scope.map(String) : [],
    },
  };
}

// @req IR-MCP-001
function listTools(): StringRecord {
  return {
    tools: BUILDERGATE_MCP_TOOL_NAMES.map((name) => ({
      name,
      description: toolDescription(name),
      inputSchema: TOOL_SCHEMAS[name],
    })),
  };
}

// @req IR-MCP-001
// @req OBS-MCP-001
async function callTool(deps: McpToolServiceDeps, state: McpToolServiceState, request: StringRecord): Promise<StringRecord> {
  const name = asString(request.name) ?? '';
  const actor = sanitizeActor(asRecord(request.actor));
  const args = asRecord(request.arguments);
  const context = {
    requestId: asString(request.requestId),
    sourceIp: asString(request.sourceIp),
  };

  switch (name) {
    case 'buildergate.session.whoami':
      return withAudit(deps, state, 'buildergate.session.whoami', actor, context, {}, await handleWhoami(deps, actor));
    case 'buildergate.session.claim':
      return withAudit(deps, state, 'buildergate.session.claim', actor, context, {}, handleClaim(deps, args));
    case 'buildergate.session.list':
      return withAudit(deps, state, 'buildergate.session.list', actor, context, {}, await handleSessionList(deps, actor, args));
    case 'buildergate.session.search':
      return withAudit(deps, state, 'buildergate.session.search', actor, context, {}, await handleSessionSearch(deps, actor, args));
    case 'buildergate.session.set_alias':
      return withAudit(deps, state, 'buildergate.session.set_alias', actor, context, {
        targetSessionKey: asString(args.sessionKey),
      }, await handleSetAlias(deps, actor, args));
    case 'buildergate.message.send':
      return handleMessageSend(deps, state, actor, args, context);
    case 'buildergate.session.update_status':
      return withAudit(deps, state, 'buildergate.session.update_status', actor, context, {}, await handleUpdateStatus(deps, actor, args));
    case 'buildergate.session.open_agent':
      return withAudit(deps, state, 'buildergate.session.open_agent', actor, context, {
        targetSessionKey: asString(args.leaderSessionKey) ?? asString(actor.sessionKey),
      }, await handleOpenAgent(deps, actor, args));
    case 'buildergate.session.close':
      return withAudit(deps, state, 'buildergate.session.close', actor, context, {
        targetSessionKey: asString(args.sessionKey),
      }, await handleCloseSession(deps, actor, args));
    case 'buildergate.session.close_self':
      return withAudit(deps, state, 'buildergate.session.close_self', actor, context, {
        targetSessionKey: asString(actor.sessionKey),
      }, await handleCloseSelf(deps, actor, args));
    case 'buildergate.message.reply_to_leader':
      return {
        ok: false,
        code: 'NOT_IMPLEMENTED',
        reason: 'placeholder-tool-surface',
      };
    default:
      return {
        ok: false,
        code: 'UNKNOWN_TOOL',
      };
  }
}

// @req IR-MCP-001
async function handleWhoami(deps: McpToolServiceDeps, actor: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:self.read');
  if (scope) {
    return scope;
  }
  const sessionKey = asString(actor.sessionKey);
  if (!sessionKey) {
    return { ok: false, code: 'UNBOUND_ACTOR' };
  }
  const session = (await resolveSessions(deps)).find((candidate) => asString(candidate.sessionKey) === sessionKey);
  if (!session) {
    return { ok: false, code: 'TARGET_NOT_FOUND' };
  }
  return sanitizeSession(session);
}

// @req IR-MCP-001
function handleClaim(deps: McpToolServiceDeps, args: StringRecord): StringRecord {
  const claimCode = asString(args.claimCode);
  const sessionKey = asString(args.sessionKey);
  if (!claimCode || !sessionKey) {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }
  const claim = deps.claimCodes?.get(claimCode);
  if (!claim) {
    return { ok: false, code: 'CLAIM_CODE_INVALID' };
  }
  const claimedSessionKey = asString(claim.sessionKey);
  if (claimedSessionKey && claimedSessionKey !== sessionKey) {
    return { ok: false, code: 'CLAIM_CODE_INVALID' };
  }
  if (claim.used === true) {
    return { ok: false, code: 'CLAIM_CODE_REUSED' };
  }
  claim.used = true;
  const token = mintMcpCapabilityToken({
    audience: 'buildergate-mcp',
    sessionKey,
    scopes: getDefaultMcpSessionScopes(),
    expiresInSeconds: 300,
  });
  return {
    ok: true,
    sessionKey,
    actorToken: asString(asRecord(token).token) ?? `mcp_claim_${crypto.randomUUID()}`,
  };
}

// @req IR-MCP-001
async function handleSessionList(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:sessions.list');
  if (scope) {
    return scope;
  }
  const actorSessionKey = asString(actor.sessionKey);
  const includeSelf = args.includeSelf !== false;
  const sessions = (await resolveSessions(deps, actorSessionKey, includeSelf))
    .filter((session) => includeSelf || asString(session.sessionKey) !== actorSessionKey)
    .map(sanitizeSession);
  return { sessions };
}

// @req IR-MCP-001
async function handleSessionSearch(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:sessions.search');
  if (scope) {
    return scope;
  }
  const query = normalizeSearch(asString(args.query) ?? '');
  if (!query) {
    return { allowed: false, code: 'TARGET_NOT_FOUND', matches: [], candidates: [] };
  }
  const includeSelf = args.includeSelf !== false;
  const actorSessionKey = asString(actor.sessionKey);
  if (deps.searchSessions) {
    const result = asRecord(await deps.searchSessions(actorSessionKey, asString(args.query) ?? '', includeSelf));
    return {
      ...result,
      matches: Array.isArray(result.matches) ? result.matches.map((match) => sanitizeSession(asRecord(match))) : [],
      candidates: Array.isArray(result.candidates) ? result.candidates.map((candidate) => sanitizeSession(asRecord(candidate))) : result.candidates,
    };
  }
  const matches = (await resolveSessions(deps))
    .filter((session) => includeSelf || asString(session.sessionKey) !== actorSessionKey)
    .map(sanitizeSession)
    .filter((session) => sessionMatchesQuery(session, query));
  return matches.length > 0
    ? { allowed: true, matches }
    : { allowed: false, code: 'TARGET_NOT_FOUND', matches: [], candidates: [] };
}

// @req IR-MCP-001
async function handleSetAlias(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:sessions.alias.write');
  if (scope) {
    return scope;
  }
  const sessionKey = asString(args.sessionKey);
  const alias = asString(args.alias)?.trim();
  if (!sessionKey || !alias) {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }
  if (deps.setSessionAlias) {
    try {
      const updated = asRecord(await deps.setSessionAlias(sessionKey, alias, asString(actor.sessionKey)));
      return {
        ok: true,
        sessionKey,
        alias,
        session: sanitizeSession({
          ...updated,
          sessionKey: updated.sessionKey ?? sessionKey,
          alias: updated.name ?? alias,
          aliasSource: updated.nameSource ?? 'user',
        }),
      };
    } catch {
      return { ok: false, code: 'TARGET_NOT_FOUND' };
    }
  }
  const sessions = await resolveSessions(deps);
  const target = sessions.find((session) => asString(session.sessionKey) === sessionKey);
  if (!target) {
    return { ok: false, code: 'TARGET_NOT_FOUND' };
  }
  target.alias = alias;
  target.name = alias;
  target.aliasSource = 'user';
  target.nameSource = 'user';
  return {
    ok: true,
    sessionKey,
    alias,
    session: sanitizeSession(target),
  };
}

// @req IR-MCP-001
// @req OBS-MCP-001
async function handleMessageSend(
  deps: McpToolServiceDeps,
  state: McpToolServiceState,
  actor: StringRecord,
  args: StringRecord,
  context: StringRecord,
): Promise<StringRecord> {
  const pasteScope = requireScope(actor, 'mcp:message.paste');
  if (pasteScope) {
    return pasteScope;
  }
  const deliveryMode = asString(args.deliveryMode) === 'submit' ? 'submit' : 'paste';
  if (deliveryMode === 'submit') {
    const submitScope = requireScope(actor, 'mcp:message.submit');
    if (submitScope) {
      return submitScope;
    }
  }
  const sessionKey = asString(args.sessionKey);
  const prompt = asString(args.prompt) ?? '';
  const target = (await resolveSessions(deps)).find((session) => asString(session.sessionKey) === sessionKey);
  if (!target || !sessionKey) {
    return { ok: false, code: 'TARGET_NOT_FOUND' };
  }

  const auditId = createAuditId();
  const assignmentId = `assignment_${crypto.randomUUID()}`;
  const promptHash = hashText(prompt);
  const promptPreview = `sha256:${promptHash.slice(0, 16)}`;
  const transitionTime = now(deps);
  const assignment = {
    assignmentId,
    status: 'delivered',
    transitions: [
      { status: 'created', at: transitionTime },
      { status: 'resolved', at: transitionTime },
      { status: 'delivered', at: transitionTime },
    ],
    promptHash,
    promptPreview,
    deliveryMode,
    target: sanitizeSession(target),
    source: sanitizeActor(actor),
    auditId,
  };
  const deliveryResult = deps.deliverMessage
    ? asRecord(await deps.deliverMessage({
      assignment,
      sessionKey,
      prompt,
      deliveryMode,
      target: sanitizeSession(target),
      actor: sanitizeActor(actor),
      context,
      auditId,
    }))
    : asRecord(deps.createAssignment?.(assignment));
  const deliveryAccepted = deliveryResult.accepted !== false
    && deliveryResult.ok !== false
    && deliveryResult.status !== 'failed';
  const status = asString(deliveryResult.status) ?? (deliveryAccepted ? 'delivered' : 'failed');
  const storedAssignment = {
    ...assignment,
    assignmentId: asString(deliveryResult.assignmentId) ?? assignmentId,
    status,
    transitions: [
      { status: 'created', at: transitionTime },
      { status: 'resolved', at: transitionTime },
      { status, at: transitionTime },
    ],
    failureCode: deliveryAccepted ? undefined : asString(deliveryResult.code) ?? 'DELIVERY_FAILED',
  };
  state.assignments.set(String(storedAssignment.assignmentId), storedAssignment);
  emitToolAudit(deps, state, {
    auditId,
    action: 'buildergate.message.send',
    actor,
    context,
    targetBinding: sanitizeSession(target),
    result: status,
    promptHash,
  });
  if (!deliveryAccepted) {
    return {
      ok: false,
      code: asString(deliveryResult.code) ?? 'DELIVERY_FAILED',
      assignmentId: storedAssignment.assignmentId,
      auditId,
      status,
    };
  }
  return {
    ok: true,
    assignmentId: storedAssignment.assignmentId,
    auditId,
    status,
  };
}

// @req IR-MCP-001
async function handleUpdateStatus(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:status.write');
  if (scope) {
    return scope;
  }
  const agentStatus = asString(args.agentStatus);
  if (!agentStatus) {
    return { ok: false, code: 'INVALID_AGENT_STATUS' };
  }
  const validation = validateMcpAgentStatus(agentStatus);
  if (validation.ok === false) {
    return { ok: false, code: validation.code };
  }
  if (deps.agentLifecycle?.updateStatus) {
    return asRecord(await deps.agentLifecycle.updateStatus({
      actor,
      agentKind: asString(args.agentKind),
      agentStatus,
      detail: redactSecretLikeText(asString(args.statusMessage) ?? asString(args.detail) ?? ''),
      statusMessage: redactSecretLikeText(asString(args.statusMessage) ?? ''),
    }));
  }
  return {
    ok: true,
    agentStatus,
    statusMessage: redactSecretLikeText(asString(args.statusMessage) ?? ''),
  };
}

async function handleOpenAgent(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:session.open');
  if (scope) {
    return scope;
  }
  if (!deps.agentLifecycle?.openAgent) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      reason: 'placeholder-tool-surface',
    };
  }
  return asRecord(await deps.agentLifecycle.openAgent({
    ...args,
    actor,
    leaderSessionKey: asString(args.leaderSessionKey) ?? asString(actor.sessionKey),
  }));
}

async function handleCloseSession(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  const scope = requireScope(actor, 'mcp:session.close');
  if (scope) {
    return scope;
  }
  const sessionKey = asString(args.sessionKey);
  if (
    !sessionKey
    || asString(args.expectedSessionKey) !== sessionKey
    || args.confirmClose !== true
    || !asString(args.confirmationNonce)
  ) {
    return { ok: false, code: 'CLOSE_CONFIRMATION_REQUIRED' };
  }
  if (!deps.agentLifecycle?.closeSession) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      reason: 'placeholder-tool-surface',
    };
  }
  return asRecord(await deps.agentLifecycle.closeSession({
    ...args,
    actor,
  }));
}

async function handleCloseSelf(deps: McpToolServiceDeps, actor: StringRecord, args: StringRecord): Promise<StringRecord> {
  if (!deps.agentLifecycle?.closeSelf) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      reason: 'placeholder-tool-surface',
    };
  }
  return asRecord(await deps.agentLifecycle.closeSelf({
    ...args,
    actor,
  }));
}

// @req OBS-MCP-001
function getServiceStatus(deps: McpToolServiceDeps, state: McpToolServiceState): StringRecord {
  const listener = normalizeListenerStatus(asRecord(resolveMaybeFunction(deps.listener) ?? state.listener));
  return sanitizeRecord({
    ...listener,
    recentAuditEvents: state.auditEvents.slice(-25),
    validationResults: state.validationResults.slice(-25),
  });
}

// @req OBS-MCP-001
function getAssignmentStatus(state: McpToolServiceState, request: StringRecord): StringRecord {
  const assignmentId = asString(request.assignmentId);
  const assignment = assignmentId ? state.assignments.get(assignmentId) : undefined;
  if (!assignment) {
    return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', assignmentId };
  }
  return sanitizeRecord(assignment);
}

// @req OBS-MCP-001
function getVerificationCoverage(state: McpToolServiceState): StringRecord {
  return {
    serverUnit: { status: 'covered', evidence: 'server/src/test-runner.ts' },
    mcpStreamableHttp: { status: 'covered', evidence: '/mcp tools/list and tools/call contract tests' },
    frontendUnit: { status: 'remaining', reason: 'PH-007 Tools Dialog UI task owns frontend unit coverage' },
    playwrightCoreE2E: { status: 'remaining', reason: 'PH-008 owns final Playwright validation' },
    flows: {
      loopbackSecurity: { status: 'covered', evidence: 'SEC-MCP-001 listener guard tests' },
      whitelistProxyRejection: { status: 'covered', evidence: 'SEC-MCP-001 whitelist/proxy tests' },
      toolSchemas: { status: 'covered', evidence: 'IR-MCP-001 tools/list schema tests' },
      searchAndSend: { status: 'covered', evidence: 'OBS-MCP-001 search and assignment tests' },
      openAgentReadyKickoff: { status: 'remaining', reason: 'PH-005 owns open_agent implementation' },
      replyToLeader: { status: 'remaining', reason: 'PH-005 owns reply_to_leader implementation' },
      closeSelf: { status: 'remaining', reason: 'PH-005 owns close/self-close lifecycle' },
      webhookKeyFlow: { status: 'remaining', reason: 'PH-006 owns webhook implementation' },
      redaction: { status: 'covered', evidence: 'OBS-MCP-001 audit/status redaction tests' },
      toolsDialog: { status: 'remaining', reason: 'PH-007 owns Tools dialog UI' },
    },
    validations: state.validationResults,
  };
}

// @req OBS-MCP-001
function recordValidationResult(state: McpToolServiceState, request: StringRecord): StringRecord {
  const status = asString(request.status) ?? 'remaining';
  const result = sanitizeRecord({
    scenario: asString(request.scenario) ?? 'unknown',
    status,
    reason: asString(request.reason),
    evidence: asString(request.evidence),
    covered: status === 'covered',
    recordedAt: new Date().toISOString(),
  });
  state.validationResults.push(result);
  return result;
}

// @req IR-MCP-001
async function handleMcpHttpRequest(
  input: { service: StringRecord; listenerController?: StringRecord },
  request: StringRecord,
): Promise<StringRecord> {
  const parsedBody = readRequestBodySafe(request);
  const body = parsedBody.ok ? parsedBody.body : {};
  const requestedToolName = asString(asRecord(body.params).name);
  const allowClaimBootstrap = parsedBody.ok
    && body.method === 'tools/call'
    && requestedToolName === 'buildergate.session.claim'
    && asRecord(request.credential).type === undefined;
  const transportRequest = {
    ...request,
    body,
    requestedToolName,
    allowClaimBootstrap,
    credential: allowClaimBootstrap
      ? { type: 'mcp-claim-bootstrap' }
      : request.credential,
  };
  if (request.method !== 'POST' || request.path !== '/mcp') {
    return {
      status: 404,
      contentType: 'application/json; charset=utf-8',
      body: { jsonrpc: '2.0', error: { code: -32601, message: 'Not found' } },
    };
  }

  const transport = input.listenerController
    ? asRecord(await callMaybeAsync(input.listenerController.evaluateRequest, transportRequest))
    : { ok: true, actor: asRecord(transportRequest.credential) };
  if (transport.ok === false) {
    return {
      status: 403,
      contentType: 'application/json; charset=utf-8',
      body: {
        jsonrpc: '2.0',
        id: parsedBody.ok ? readJsonRpcId(body) : null,
        error: {
          code: -32000,
          message: String(transport.code),
          data: sanitizeRecord({ code: transport.code, auditId: transport.auditId }),
        },
      },
    };
  }

  if (!parsedBody.ok) {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: { code: 'MCP_JSON_PARSE_ERROR' },
        },
      },
    };
  }

  const id = body.id;
  if (body.method === 'tools/list') {
    return jsonRpcResult(id, await callMaybeAsync(input.service.listTools, body.params ?? {}));
  }
  if (body.method === 'tools/call') {
    const params = asRecord(body.params);
    return jsonRpcResult(id, await callMaybeAsync(input.service.callTool, {
      name: params.name,
      arguments: params.arguments,
      actor: transport.actor ?? request.credential,
      requestId: String(id),
      sourceIp: request.remoteAddress,
    }));
  }
  return jsonRpcResult(id, { ok: false, code: 'UNKNOWN_METHOD' });
}

// @req IR-MCP-001
function jsonRpcResult(id: unknown, result: unknown): StringRecord {
  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: {
      jsonrpc: '2.0',
      id,
      result,
    },
  };
}

// @req IR-MCP-001
function readRequestBody(request: StringRecord): StringRecord {
  const body = request.body;
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString('utf-8')) as StringRecord;
  }
  if (typeof body === 'string') {
    return JSON.parse(body) as StringRecord;
  }
  return asRecord(body);
}

// @req IR-MCP-001
function readRequestBodySafe(request: StringRecord): { ok: true; body: StringRecord } | { ok: false; body: StringRecord } {
  try {
    return { ok: true, body: readRequestBody(request) };
  } catch {
    return { ok: false, body: {} };
  }
}

// @req IR-MCP-001
function readJsonRpcId(body: StringRecord): unknown {
  return body.id ?? null;
}

// @req IR-MCP-001
async function resolveSessions(
  deps: McpToolServiceDeps,
  actorSessionKey?: string,
  includeSelf = true,
): Promise<StringRecord[]> {
  const raw = deps.listSessions
    ? await deps.listSessions(actorSessionKey, includeSelf)
    : Array.isArray(deps.sessions) ? deps.sessions : await callMaybeAsync(deps.sessions);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(asRecord);
}

// @req IR-MCP-001
function requireScope(actor: StringRecord, scope: string): StringRecord | null {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  return scopes.includes(scope) ? null : { ok: false, code: 'INVALID_SCOPE' };
}

// @req OBS-MCP-001
function withAudit(
  deps: McpToolServiceDeps,
  state: McpToolServiceState,
  action: string,
  actor: StringRecord,
  context: StringRecord,
  auditExtras: StringRecord,
  result: StringRecord,
): StringRecord {
  emitToolAudit(deps, state, {
    action,
    actor,
    context,
    result: result.ok === false ? 'denied' : 'ok',
    reason: result.ok === false ? result.code : undefined,
    ...auditExtras,
  });
  return result;
}

// @req OBS-MCP-001
function emitToolAudit(deps: McpToolServiceDeps, state: McpToolServiceState, event: StringRecord): string {
  const actor = asRecord(event.actor);
  const auditId = asString(event.auditId) ?? createAuditId();
  const targetSessionKey = asString(event.targetSessionKey);
  const targetBinding = event.targetBinding ?? (targetSessionKey ? { sessionKey: targetSessionKey } : undefined);
  const auditEvent = sanitizeRecord({
    auditId,
    action: event.action,
    actorType: asString(actor.type) ?? 'mcp',
    actorSessionKey: asString(actor.sessionKey),
    sourceIp: asString(asRecord(event.context).sourceIp),
    requestId: asString(asRecord(event.context).requestId),
    scopes: Array.isArray(actor.scopes) ? actor.scopes.map(String) : [],
    targetBinding,
    result: event.result,
    reason: event.reason,
    code: event.code,
    promptHash: event.promptHash,
    timestamp: new Date().toISOString(),
  });
  state.auditEvents.push(auditEvent);
  deps.audit?.(auditEvent);
  return auditId;
}

// @req SEC-MCP-001
// @req OBS-MCP-001
function emitListenerAudit(deps: ListenerControllerDeps, request: StringRecord, event: StringRecord): void {
  const credential = asRecord(request.credential);
  deps.audit?.(sanitizeRecord({
    auditId: event.auditId,
    action: event.action ?? 'mcp.request.denied',
    actorType: asString(credential.type) ?? 'unknown',
    actorSessionKey: asString(credential.sessionKey),
    sourceIp: asString(request.remoteAddress),
    effectiveClientIp: asString(request.remoteAddress),
    reason: event.code,
    code: event.code,
    result: event.result,
    outcome: event.result,
    timestamp: new Date().toISOString(),
  }));
}

// @req OBS-MCP-001
function sanitizeSession(session: StringRecord): StringRecord {
  return sanitizeRecord({
    alias: asString(session.alias) ?? asString(session.name) ?? asString(session.sessionKey) ?? 'session',
    agentKind: asString(session.agentKind) ?? 'terminal',
    agentStatus: asString(session.agentStatus) ?? 'unknown',
    bindingLifecycle: asString(session.bindingLifecycle) ?? 'live',
    mcpConnected: session.mcpConnected === true,
    leader: session.leader === true,
    leaderSessionKey: session.leaderSessionKey ?? null,
    workspaceId: session.workspaceId,
    tabId: session.tabId ?? session.id,
    sessionId: session.sessionId ?? session.currentSessionId,
    currentSessionId: session.currentSessionId ?? session.sessionId,
    sessionKey: session.sessionKey,
    lastSeenAt: session.lastSeenAt ?? session.updatedAt ?? new Date().toISOString(),
  });
}

// @req OBS-MCP-001
function sanitizeActor(actor: StringRecord): StringRecord {
  return sanitizeRecord({
    type: actor.type ?? 'mcp',
    sessionKey: actor.sessionKey,
    leaderSessionKey: actor.leaderSessionKey,
    scopes: Array.isArray(actor.scopes) ? actor.scopes.map(String) : [],
  });
}

// @req OBS-MCP-001
function sanitizeRecord(value: unknown): StringRecord {
  return asRecord(sanitizeValue(value));
}

// @req OBS-MCP-001
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === 'string') {
    return redactSecretLikeText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const output: StringRecord = {};
  for (const [key, item] of Object.entries(value as StringRecord)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      continue;
    }
    output[key] = sanitizeValue(item);
  }
  return output;
}

// @req OBS-MCP-001
function redactSecretLikeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|key|webhook_key)=([^\s&]+)/gi, '$1=[REDACTED]');
}

// @req SEC-MCP-001
function normalizeTransportConfig(input: unknown): {
  enabled: boolean;
  bindMode: string;
  externalWhitelist: string[];
  transportSecurity: string;
  trustedProxies: string[];
  allowedOrigins: string[];
} {
  const defaults = createDefaultMcpSecurityConfig();
  const config = asRecord(input);
  return {
    enabled: config.enabled !== false,
    bindMode: asString(config.bindMode) ?? asString(defaults.bindMode) ?? 'loopback',
    externalWhitelist: stringArray(config.externalWhitelist),
    transportSecurity: asString(config.transportSecurity) ?? asString(defaults.transportSecurity) ?? 'none',
    trustedProxies: stringArray(config.trustedProxies),
    allowedOrigins: stringArray(config.allowedOrigins),
  };
}

// @req SEC-MCP-001
function listenerConfigFromActive(active: StringRecord): StringRecord {
  return {
    enabled: active.enabled !== false,
    bindMode: active.bindMode ?? 'loopback',
    bindHost: active.bindHost ?? '127.0.0.1',
    externalWhitelist: active.externalWhitelist ?? [],
    transportSecurity: active.transportSecurity ?? 'none',
    trustedProxies: active.trustedProxies ?? [],
    allowedOrigins: active.allowedOrigins ?? [],
  };
}

// @req SEC-MCP-001
function evaluateTransportBoundary(
  config: ReturnType<typeof normalizeTransportConfig>,
  remoteAddress: string,
  headers: Record<string, string>,
): string | null {
  if (config.enabled === false) {
    return 'MCP_TRANSPORT_DENIED';
  }

  if (config.bindMode === 'whitelist') {
    if (config.externalWhitelist.length === 0) {
      return 'MCP_WHITELIST_EMPTY';
    }
    if (config.transportSecurity !== 'direct_tls' && config.transportSecurity !== 'trusted_tls_proxy') {
      return 'MCP_TRANSPORT_TLS_REQUIRED';
    }
    const clientAddress = resolveClientAddress(config, remoteAddress, headers);
    if (typeof clientAddress !== 'string') {
      return clientAddress.code;
    }
    return matchesAnyCidr(clientAddress, config.externalWhitelist) ? null : 'MCP_WHITELIST_DENIED';
  }

  return isLoopbackAddress(remoteAddress) ? null : 'MCP_LOOPBACK_ONLY';
}

// @req SEC-MCP-001
function resolveClientAddress(
  config: ReturnType<typeof normalizeTransportConfig>,
  remoteAddress: string,
  headers: Record<string, string>,
): string | { code: string } {
  if (config.transportSecurity !== 'trusted_tls_proxy') {
    return remoteAddress;
  }
  if (!matchesAnyCidr(remoteAddress, config.trustedProxies)) {
    return { code: 'MCP_TRUSTED_PROXY_DENIED' };
  }
  if (headers['x-forwarded-proto'] !== 'https') {
    return { code: 'MCP_TRANSPORT_DENIED' };
  }
  return normalizeIp(String(headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() ?? '');
}

// @req SEC-MCP-001
function deniedTransport(code: string): StringRecord {
  return {
    ok: false,
    code,
    auditId: createAuditId(),
  };
}

// @req SEC-MCP-001
function normalizeListenerStatus(input: StringRecord): StringRecord {
  return {
    enabled: input.enabled !== false,
    bindMode: input.bindMode ?? 'loopback',
    bindHost: input.bindHost ?? '127.0.0.1',
    port: Number(input.port ?? 3333),
    listenerStatus: input.listenerStatus ?? 'listening',
    activeConnectionCount: Number(input.activeConnectionCount ?? 0),
    lastRebindResult: input.lastRebindResult ?? null,
    lastError: input.lastError ?? null,
    rejectedRequestCounters: input.rejectedRequestCounters ?? {},
    externalWhitelist: input.externalWhitelist ?? [],
    trustedProxies: input.trustedProxies ?? [],
    transportSecurity: input.transportSecurity ?? 'none',
    allowedOrigins: input.allowedOrigins ?? [],
    generation: input.generation,
    appServerGeneration: input.appServerGeneration,
  };
}

// @req OBS-MCP-001
function listenerRuntimeStatus(handle: unknown): StringRecord {
  const record = asRecord(handle);
  const output: StringRecord = {};
  for (const key of ['bindHost', 'port', 'listenerStatus', 'activeConnectionCount']) {
    if (record[key] !== undefined) {
      output[key] = record[key];
    }
  }
  return output;
}

// @req IR-MCP-001
function toolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    'buildergate.session.whoami': 'Return the current MCP session binding.',
    'buildergate.session.claim': 'Bind a one-time claim code to a session.',
    'buildergate.session.list': 'List live MCP-visible sessions.',
    'buildergate.session.search': 'Search live sessions by alias or key.',
    'buildergate.message.send': 'Send a paste or submit request to a session.',
    'buildergate.session.set_alias': 'Set a user alias for a session.',
    'buildergate.session.open_agent': 'Placeholder for the PH-005 agent launch tool.',
    'buildergate.session.close': 'Placeholder for the PH-005 close tool.',
    'buildergate.session.close_self': 'Placeholder for the PH-005 self-close tool.',
    'buildergate.message.reply_to_leader': 'Placeholder for the PH-005 leader reply tool.',
    'buildergate.session.update_status': 'Update MCP-visible agent status.',
  };
  return descriptions[name] ?? name;
}

// @req IR-MCP-001
function sessionMatchesQuery(session: StringRecord, query: string): boolean {
  return [
    session.alias,
    session.sessionKey,
    session.sessionId,
    session.tabId,
    session.workspaceId,
    session.agentKind,
  ].some((value) => normalizeSearch(value).includes(query));
}

// @req IR-MCP-001
function normalizeSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// @req SEC-MCP-001
function matchesAnyCidr(address: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => matchesCidr(address, cidr));
}

// @req SEC-MCP-001
function matchesCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText ?? '32');
  const addressInt = ipv4ToInt(address);
  const networkInt = ipv4ToInt(network ?? '');
  if (addressInt === null || networkInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressInt & mask) === (networkInt & mask);
}

// @req SEC-MCP-001
function ipv4ToInt(address: string): number | null {
  const normalized = normalizeIp(address);
  if (net.isIP(normalized) !== 4) {
    return null;
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((octets[0] ?? 0) << 24) >>> 0)
    + (((octets[1] ?? 0) << 16) >>> 0)
    + (((octets[2] ?? 0) << 8) >>> 0)
    + ((octets[3] ?? 0) >>> 0);
}

// @req SEC-MCP-001
function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeIp(address);
  return normalized === '::1' || (net.isIP(normalized) === 4 && normalized.split('.')[0] === '127');
}

// @req SEC-MCP-001
function normalizeIp(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

// @req SEC-MCP-001
function normalizeHeaders(input: StringRecord): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      headers[key.toLowerCase()] = value[0];
    }
  }
  return headers;
}

// @req OBS-MCP-001
function hashText(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

// @req OBS-MCP-001
function createAuditId(): string {
  return `audit_${crypto.randomUUID()}`;
}

// @req OBS-MCP-001
function now(deps: McpToolServiceDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

// @req IR-MCP-001
async function callMaybeAsync(fnOrValue: unknown, arg?: unknown): Promise<unknown> {
  if (typeof fnOrValue !== 'function') {
    return fnOrValue;
  }
  return await (fnOrValue as (value?: unknown) => unknown)(arg);
}

// @req IR-MCP-001
function resolveMaybeFunction(value: unknown): unknown {
  return typeof value === 'function' ? (value as () => unknown)() : value;
}

// @req IR-MCP-001
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

// @req IR-MCP-001
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// @req IR-MCP-001
function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}
