import { normalizeMcpPromptPreview } from './McpSecurityContract.js';

export const INPUT_REJECTED_REPLAY_PENDING = 'INPUT_REJECTED_REPLAY_PENDING';
export const INPUT_REJECTED_ENTER_POLICY = 'INPUT_REJECTED_ENTER_POLICY';

export const INPUT_GATEWAY_DENIAL_CODES = [
  INPUT_REJECTED_REPLAY_PENDING,
  INPUT_REJECTED_ENTER_POLICY,
  'STALE_SESSION_ID',
  'TARGET_NOT_LIVE',
  'TARGET_NOT_FOUND',
  'AMBIGUOUS_TARGET',
  'WEBHOOK_RATE_LIMITED',
  'WEBHOOK_PROMPT_TOO_LARGE',
  'WEBHOOK_KEY_REVOKED',
  'WEBHOOK_HEADER_FORBIDDEN',
  'WEBHOOK_KEY_INVALID',
  'INVALID_AGENT_STATUS',
  'INVALID_BINDING_LIFECYCLE',
  'CLOSE_CONFIRMATION_REQUIRED',
  'MCP_WHITELIST_EMPTY',
  'MCP_WHITELIST_DENIED',
] as const;

export const SESSION_INPUT_GATEWAY_INGRESS_SOURCES = [
  'websocket',
  'restore',
  'mcp-message-send',
  'mcp-reply-to-leader',
  'open-agent-command',
  'open-agent-kickoff',
  'webhook',
  'close-self-failure-notification',
  'control-close-live-session',
] as const;

type StringRecord = Record<string, unknown>;
type InputGatewayDenialCode = typeof INPUT_GATEWAY_DENIAL_CODES[number] | string;

type SessionInputGatewayDeps = {
  writeInput: (write: StringRecord) => unknown;
  auditInput?: (event: StringRecord) => void;
  transitionSessionActivity?: (event: StringRecord) => void;
  transitionLifecycle?: (event: StringRecord) => void;
  resolveTarget?: (request: StringRecord) => unknown;
  resolveLeader?: (request: StringRecord) => unknown;
  readReplayState?: (request: StringRecord) => unknown;
  evaluateInputPolicy?: (request: StringRecord) => unknown;
};

type SubmitInputResult = {
  accepted: boolean;
  code?: InputGatewayDenialCode;
  auditId?: string;
  includeSelf?: boolean;
  sessionActivityAfter?: string;
  followerLifecycleAfter?: string;
};

const REPLAY_DENIAL = {
  accepted: false,
  code: INPUT_REJECTED_REPLAY_PENDING,
} as const;

// @req FR-MCP-002
// @req IR-MCP-004
// @req IR-MCP-005
export function createSessionInputGateway(deps: SessionInputGatewayDeps): {
  submitInput: (request: unknown) => SubmitInputResult;
} {
  return {
    submitInput: (request: unknown) => submitInputThroughGateway(deps, asRecord(request)),
  };
}

// @req FR-MCP-002
// @req IR-MCP-004
// @req IR-MCP-005
export async function submitMcpMessageInput(
  gateway: { submitInput: (request: unknown) => SubmitInputResult | Promise<SubmitInputResult> },
  request: unknown,
): Promise<SubmitInputResult> {
  return gateway.submitInput({ ...asRecord(request), source: 'mcp-message-send' });
}

// @req FR-MCP-002
// @req IR-MCP-004
// @req IR-MCP-005
export async function submitWebhookInput(
  gateway: { submitInput: (request: unknown) => SubmitInputResult | Promise<SubmitInputResult> },
  request: unknown,
): Promise<SubmitInputResult> {
  return gateway.submitInput({ ...asRecord(request), source: 'webhook' });
}

// @req FR-MCP-002
// @req IR-MCP-004
// @req IR-MCP-005
function submitInputThroughGateway(
  deps: SessionInputGatewayDeps,
  request: StringRecord,
): SubmitInputResult {
  const source = asString(request.source) ?? 'mcp-message-send';
  const replayState = asRecord(deps.readReplayState?.(request));
  if (request.replayPolicy === 'reject' && (replayState.replayPending === true || replayState.screenRepairPending === true)) {
    return REPLAY_DENIAL;
  }

  const policy = asRecord(deps.evaluateInputPolicy?.(request) ?? { ok: true });
  if (isDenied(policy)) {
    return denyWithAudit(deps, request, String(policy.code));
  }

  const enterPolicyDenial = evaluateEnterPolicy(request);
  if (enterPolicyDenial) {
    return denyWithAudit(deps, request, enterPolicyDenial);
  }

  const targetResult = resolveGatewayTarget(deps, request, source);
  if (isDenied(targetResult)) {
    const denied = denyWithAudit(deps, request, String(targetResult.code));
    return source === 'mcp-reply-to-leader'
      ? { ...denied, followerLifecycleAfter: 'live' }
      : denied;
  }

  const binding = asRecord(targetResult.binding ?? targetResult);
  const data = asString(request.data) ?? '';
  const activityAfter = resolveIdleActivityAfter(request);
  const shouldWrite = data.length > 0;
  if (source === 'close-self-failure-notification') {
    deps.transitionLifecycle?.({
      from: 'closing',
      to: 'closing-failed',
      sessionKey: actorSessionKey(request),
      reason: 'close-self-failure-notification',
    });
  }

  let accepted = true;
  if (shouldWrite) {
    accepted = writeLowLevelInput(deps, request, binding, data);
  }

  const auditId = shouldAudit(source, request) ? auditGatewayInput(deps, request, accepted ? 'accepted' : 'write-failed') : undefined;
  if (!accepted) {
    return {
      accepted: false,
      code: 'TARGET_NOT_LIVE',
      ...(auditId ? { auditId } : {}),
    };
  }

  return {
    accepted: true,
    ...(auditId ? { auditId } : {}),
    ...(asRecord(request.target).self === true ? { includeSelf: true } : {}),
    ...(activityAfter ? { sessionActivityAfter: activityAfter } : {}),
    ...(source === 'close-self-failure-notification' ? { followerLifecycleAfter: 'closing-failed' } : {}),
  };
}

// @req FR-MCP-002
// @req IR-MCP-004
// @req IR-MCP-005
function resolveGatewayTarget(
  deps: SessionInputGatewayDeps,
  request: StringRecord,
  source: string,
): StringRecord {
  if (source === 'mcp-reply-to-leader' || source === 'close-self-failure-notification') {
    return asRecord(deps.resolveLeader?.(request) ?? { ok: false, code: 'TARGET_NOT_LIVE' });
  }
  return asRecord(deps.resolveTarget?.(request) ?? { ok: false, code: 'TARGET_NOT_FOUND' });
}

// @req FR-MCP-002
// @req IR-MCP-005
function evaluateEnterPolicy(request: StringRecord): InputGatewayDenialCode | null {
  const source = asString(request.source) ?? 'mcp-message-send';
  if (!['mcp-message-send', 'mcp-reply-to-leader', 'open-agent-command', 'open-agent-kickoff'].includes(source)) {
    return null;
  }

  const data = asString(request.data) ?? '';
  const hasEnter = data.includes('\r') || data.includes('\n');
  const delivery = asRecord(request.delivery);
  const actor = asRecord(request.actor);
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  const submitRequested = delivery.submit === true || delivery.mode === 'submit';
  const hasSubmitScope = scopes.includes('mcp:message.submit');
  if (submitRequested && !hasSubmitScope) {
    return INPUT_REJECTED_ENTER_POLICY;
  }
  if (hasEnter && (!submitRequested || !hasSubmitScope)) {
    return INPUT_REJECTED_ENTER_POLICY;
  }
  return null;
}

// @req FR-MCP-002
// @req IR-MCP-004
function writeLowLevelInput(
  deps: SessionInputGatewayDeps,
  request: StringRecord,
  binding: StringRecord,
  data: string,
): boolean {
  const metadata = buildWriteMetadata(request);
  const result = deps.writeInput({
    sessionId: binding.currentSessionId,
    currentSessionId: binding.currentSessionId,
    sessionKey: binding.sessionKey,
    targetSessionKey: binding.sessionKey,
    data,
    metadata,
    inputSeqStart: request.inputSeqStart,
    inputSeqEnd: request.inputSeqEnd,
  });
  const record = asRecord(result);
  return result !== false && record.ok !== false;
}

// @req IR-MCP-004
// @req IR-MCP-005
function buildWriteMetadata(request: StringRecord): StringRecord {
  const callerMetadata = asRecord(sanitizeGatewayMetadata(request.metadata));
  const gatewayMetadata = asRecord(sanitizeGatewayMetadata({
    source: request.source,
    actorType: asRecord(request.actor).type,
    delivery: request.delivery,
    inputEventKind: request.inputEventKind,
    auditContext: request.auditContext,
  }));
  return {
    ...callerMetadata,
    ...gatewayMetadata,
  };
}

// @req IR-MCP-004
// @req IR-MCP-005
function denyWithAudit(
  deps: SessionInputGatewayDeps,
  request: StringRecord,
  code: InputGatewayDenialCode,
): SubmitInputResult {
  const auditId = shouldAudit(asString(request.source) ?? '', request)
    ? auditGatewayInput(deps, request, String(code), code)
    : undefined;
  return {
    accepted: false,
    code,
    ...(auditId ? { auditId } : {}),
  };
}

// @req IR-MCP-004
// @req IR-MCP-005
function auditGatewayInput(
  deps: SessionInputGatewayDeps,
  request: StringRecord,
  outcome: string,
  code?: InputGatewayDenialCode,
): string {
  const auditId = createAuditId();
  const auditContext = asRecord(request.auditContext);
  const promptPreviewMaxChars = Math.min(Number(auditContext.promptPreviewMaxChars ?? 24), 24);
  const event = asRecord(sanitizeGatewayMetadata({
    auditId,
    category: 'input-gateway',
    source: request.source,
    actorType: asRecord(request.actor).type,
    target: sanitizeGatewayMetadata(request.target),
    outcome,
    code,
    promptPreview: normalizePromptPreview(asString(request.data) ?? '', promptPreviewMaxChars),
    timestamp: new Date().toISOString(),
  }));
  deps.auditInput?.(event);
  return auditId;
}

// @req IR-MCP-004
// @req IR-MCP-005
function normalizePromptPreview(prompt: string, maxChars: number): string {
  return normalizeMcpPromptPreview({
    prompt: prompt
      .replace(/\btoken=[^\s&]+/gi, 'token=[REDACTED]')
      .replace(/\bsecret=[^\s&]+/gi, 'secret=[REDACTED]'),
    maxChars,
  });
}

// @req IR-MCP-004
// @req IR-MCP-005
function sanitizeGatewayMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeGatewayMetadata);
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecretLikeText(value) : value;
  }

  const output: StringRecord = {};
  for (const [key, item] of Object.entries(value as StringRecord)) {
    if (['data', 'fullKey', 'fullUrl', 'rawToken', 'token', 'keyHash'].includes(key)) {
      continue;
    }
    output[key] = sanitizeGatewayMetadata(item);
  }
  return output;
}

// @req IR-MCP-004
// @req IR-MCP-005
function redactSecretLikeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|key|webhook_key)=[^\s&]+/gi, '$1=[REDACTED]');
}

function shouldAudit(source: string, request: StringRecord): boolean {
  return source === 'webhook' || request.auditContext !== undefined;
}

function resolveIdleActivityAfter(request: StringRecord): string | null {
  if (request.sessionKind !== 'ai-tui') {
    return null;
  }
  return asString(request.currentActivity) ?? 'idle';
}

function isDenied(result: StringRecord): boolean {
  return result.ok === false || result.allowed === false;
}

function actorSessionKey(request: StringRecord): string | undefined {
  return asString(asRecord(request.actor).sessionKey);
}

function createAuditId(): string {
  return `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}
