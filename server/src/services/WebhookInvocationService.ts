import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createWebhookCredential,
  evaluateMcpRequestGuard,
  normalizeMcpPromptPreview,
  rotateWebhookCredential,
  serializeWebhookCredentialResponse,
  validateMcpWebhookKeyHeaderName,
} from './McpSecurityContract.js';

type StringRecord = Record<string, unknown>;

type WebhookInvocationDeps = {
  now?: () => string;
  webhookRecord?: StringRecord;
  webhookRecords?: StringRecord[];
  persistWebhookRecords?: (records: StringRecord[]) => unknown | Promise<unknown>;
  defaultProfile?: StringRecord | null;
  webhookKeyHeaderName?: unknown;
  webhookRateLimit?: unknown;
  denialCode?: unknown;
  revoked?: boolean;
  rateLimited?: boolean;
  rateLimitPartition?: boolean;
  replayPending?: boolean;
  ambiguousTarget?: boolean;
  securityConfig?: StringRecord;
  audit?: (event: unknown) => unknown;
  accessLog?: (event: unknown) => unknown;
  recordAssignment?: (assignment: unknown) => unknown;
  searchSessions?: (request: unknown) => unknown;
  openAgent?: (request: unknown) => unknown;
  deliverMessage?: (request: unknown) => unknown;
  checkRateLimit?: (request: unknown) => unknown;
};

const DEFAULT_WEBHOOK_HEADER = 'X-BuilderGate-Webhook-Key';
const DEFAULT_WEBHOOK_RECORD_DATA_PATH = './data/mcp-webhook-records.json';
const MAX_QUERY_PROMPT_CHARS = 2048;

export function createWebhookInvocationService(deps: WebhookInvocationDeps = {}): StringRecord {
  let webhookKeyHeaderName = asString(deps.webhookKeyHeaderName) ?? DEFAULT_WEBHOOK_HEADER;
  const records = normalizeWebhookRecords(deps);
  let persistChain: Promise<unknown> = Promise.resolve();
  let lifecycleChain: Promise<unknown> = Promise.resolve();
  const status = {
    rateLimit: normalizeWebhookRateLimit(deps.webhookRateLimit) ?? {
      windowSeconds: 60,
      burstLimit: 10,
    },
  };

  const persistSnapshot = async (snapshotRecords: StringRecord[]): Promise<void> => {
    if (!deps.persistWebhookRecords) {
      return;
    }
    const snapshot = snapshotRecords.map(record => sanitizeWebhookRecord(record));
    const next = persistChain.then(
      () => deps.persistWebhookRecords?.(snapshot),
      () => deps.persistWebhookRecords?.(snapshot),
    );
    persistChain = next.catch(() => undefined);
    await next;
  };

  const waitForLifecycleIdle = async (): Promise<void> => {
    await lifecycleChain.catch(() => undefined);
  };

  const persistRecords = async (): Promise<void> => {
    await waitForLifecycleIdle();
    await persistSnapshot(records);
  };

  const runLifecycleMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycleChain.then(operation, operation);
    lifecycleChain = next.catch(() => undefined);
    return await next;
  };

  const persistUsageMetadata = async (auditId: string): Promise<void> => {
    try {
      await persistRecords();
    } catch (error) {
      deps.audit?.({
        auditId,
        actorType: 'webhook',
        result: 'metadata-persist-failed',
        code: 'WEBHOOK_METADATA_PERSIST_FAILED',
      });
      console.warn('[WebhookInvocationService] Failed to persist webhook usage metadata:', error);
    }
  };

  const createWebhookKey = async (request: unknown): Promise<StringRecord> => runLifecycleMutation(async () => {
    const input = asRecord(request);
    const targetSessionKey = asString(input.targetSessionKey);
    const profileId = asString(input.profileId);
    const scopes = Object.prototype.hasOwnProperty.call(input, 'scopes') ? asStringArray(input.scopes) : ['mcp:webhook.invoke'];
    const fieldErrors: StringRecord = {};
    if (!targetSessionKey && !profileId) {
      fieldErrors.targetSessionKey = 'required_without_profileId';
      fieldErrors.profileId = 'required_without_targetSessionKey';
    }
    if (scopes.length === 0) {
      fieldErrors.scopes = 'required';
    }
    if (Object.keys(fieldErrors).length > 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        fieldErrors,
        auditId: `audit_${crypto.randomUUID()}`,
      };
    }
    const credential = createWebhookCredential({
      targetSessionKey: targetSessionKey ?? '',
      profileId: profileId ?? 'default',
      mode: asString(input.mode) ?? 'send-only',
      scopes,
    });
    const record = {
      ...asRecord(credential.record),
      keyId: asRecord(credential.record).id,
      targetSessionKey,
      expiresAt: input.expiresAt,
      revoked: false,
      rateLimit: status.rateLimit,
    };
    await persistSnapshot([...records, record]);
    records.push(record);
    return {
      fullKey: credential.fullKey,
      fullUrl: buildWebhookUrl(asString(record.keyId), asString(credential.fullKey)),
      record: sanitizeWebhookRecord(record),
    };
  });

  const listWebhookKeys = (): StringRecord[] => records.map(record => sanitizeWebhookRecord(record));

  const rotateWebhookKey = async (request: unknown): Promise<StringRecord> => runLifecycleMutation(async () => {
    const input = asRecord(request);
    const id = asString(input.id) ?? asString(input.keyId);
    const record = records.find(item => asString(item.keyId) === id || asString(item.id) === id);
    if (!record) {
      return { ok: false, code: 'WEBHOOK_KEY_INVALID', auditId: `audit_${crypto.randomUUID()}` };
    }
    const rotated = rotateWebhookCredential(record);
    const nextRecord = {
      ...record,
      ...asRecord(rotated.record),
      keyId: asString(asRecord(rotated.record).id) ?? asString(record.keyId) ?? id,
      revoked: false,
      revokedAt: undefined,
    };
    await persistSnapshot(records.map(item => item === record ? nextRecord : item));
    Object.assign(record, nextRecord);
    return {
      fullKey: rotated.fullKey,
      fullUrl: buildWebhookUrl(asString(record.keyId), asString(rotated.fullKey)),
      record: sanitizeWebhookRecord(record),
    };
  });

  const revokeWebhookKey = async (request: unknown): Promise<StringRecord> => runLifecycleMutation(async () => {
    const input = asRecord(request);
    const id = asString(input.id) ?? asString(input.keyId);
    const record = records.find(item => asString(item.keyId) === id || asString(item.id) === id);
    if (!record) {
      return { ok: false, code: 'WEBHOOK_KEY_INVALID', auditId: `audit_${crypto.randomUUID()}` };
    }
    const nextRecord = {
      ...record,
      revoked: true,
      revokedAt: asString(record.revokedAt) ?? nowIso(deps),
    };
    await persistSnapshot(records.map(item => item === record ? nextRecord : item));
    Object.assign(record, nextRecord);
    return {
      keyId: asString(record.keyId) ?? asString(record.id),
      revoked: true,
      revokedAt: record.revokedAt,
      auditId: `audit_${crypto.randomUUID()}`,
    };
  });

  const getWebhookConfig = (): StringRecord => ({
    webhookKeyHeaderName,
    rateLimit: status.rateLimit,
  });

  const setWebhookConfig = (request: unknown): StringRecord => {
    const input = asRecord(request);
    const hasHeaderName = Object.prototype.hasOwnProperty.call(input, 'webhookKeyHeaderName');
    const hasRateLimit = Object.prototype.hasOwnProperty.call(input, 'rateLimit');
    const headerName = hasHeaderName ? asString(input.webhookKeyHeaderName) ?? '' : webhookKeyHeaderName;
    const validation = validateMcpWebhookKeyHeaderName(headerName);
    if (validation.ok === false) {
      return { ok: false, code: validation.code };
    }
    const nextRateLimit = hasRateLimit ? normalizeWebhookRateLimit(input.rateLimit) : status.rateLimit;
    if (!nextRateLimit) {
      return { ok: false, code: 'WEBHOOK_RATE_LIMIT_INVALID' };
    }
    webhookKeyHeaderName = headerName;
    status.rateLimit = nextRateLimit;
    return {
      ok: true,
      webhookKeyHeaderName,
      rateLimit: status.rateLimit,
    };
  };

  const getWebhookStatus = (): StringRecord => ({
    rateLimit: status.rateLimit,
    webhookKeyHeaderName,
  });

  const invokeWebhook = async (request: unknown): Promise<StringRecord> => {
    const input = asRecord(request);
    const query = asRecord(input.query);
    const headers = normalizeHeaders(asRecord(input.headers));
    const queryKey = asString(query.key);
    const headerKey = headers[webhookKeyHeaderName.toLowerCase()];
    const prompt = asString(query.prompt) ?? asString(input.prompt) ?? '';
    const auditId = `audit_${crypto.randomUUID()}`;
    const credentialKind = headerKey ? 'header' : 'query';

    if (asString(deps.denialCode)) {
      return deny(deps, input, asString(deps.denialCode) ?? 'WEBHOOK_KEY_INVALID', auditId);
    }

    if (queryKey && headerKey && queryKey !== headerKey) {
      return deny(deps, input, 'WEBHOOK_KEY_INVALID', auditId);
    }

    if (!queryKey && !headerKey) {
      return deny(deps, input, 'WEBHOOK_KEY_INVALID', auditId);
    }

    const providedKey = headerKey ?? queryKey ?? '';
    const expectedHeader = webhookKeyHeaderName.toLowerCase();
    const hasOnlyWrongHeader = Object.keys(headers).some(key => key.includes('webhook-key'))
      && !headers[expectedHeader]
      && !queryKey;
    if (hasOnlyWrongHeader) {
      return deny(deps, input, 'WEBHOOK_KEY_INVALID', auditId);
    }

    await waitForLifecycleIdle();
    const record = findWebhookRecord(records, providedKey);
    if (!record) {
      return deny(deps, input, 'WEBHOOK_KEY_INVALID', auditId);
    }
    if (record.revoked === true || deps.revoked === true) {
      return deny(deps, input, 'WEBHOOK_KEY_REVOKED', auditId);
    }
    if (deps.replayPending === true) {
      return deny(deps, input, 'INPUT_REJECTED_REPLAY_PENDING', auditId);
    }
    if (String(asString(input.method) ?? 'GET').toUpperCase() === 'GET' && prompt.length > MAX_QUERY_PROMPT_CHARS) {
      return deny(deps, input, 'WEBHOOK_PROMPT_TOO_LARGE', auditId);
    }

    const effectiveClientIp = asString(input.remoteAddress) ?? '127.0.0.1';
    const rateLimitResult = asRecord(await deps.checkRateLimit?.({
      keyId: asString(record.keyId) ?? asString(record.id) ?? 'wh_1',
      effectiveClientIp,
      windowSeconds: status.rateLimit.windowSeconds,
      burstLimit: status.rateLimit.burstLimit,
    }) ?? { ok: true });
    if (rateLimitResult.ok === false || deps.rateLimited === true) {
      return deny(deps, input, asString(rateLimitResult.code) ?? 'WEBHOOK_RATE_LIMITED', auditId);
    }

    if (isExpired(record, deps)) {
      return deny(deps, input, 'WEBHOOK_KEY_INVALID', auditId);
    }

    const preliminaryPolicy = asRecord(evaluateMcpRequestGuard({
      config: deps.securityConfig,
      remoteAddress: asString(input.remoteAddress) ?? '127.0.0.1',
      headers: asHeaderInput(input.headers),
      credential: { type: 'webhook-key', key: providedKey, record },
      dispatchKind: 'webhook',
      requestedWebhook: {
        targetSessionKey: asString(record.targetSessionKey),
        profileId: asString(record.profileId),
        mode: asString(record.mode),
      },
    }));
    if (preliminaryPolicy.allowed === false) {
      return deny(deps, input, asString(preliminaryPolicy.code) ?? 'WEBHOOK_KEY_INVALID', auditId);
    }

    const targetQuery = asString(query.target);
    const targetSessionKey = asString(record.targetSessionKey);
    let deliveryTargetSessionKey = targetSessionKey;
    if (targetQuery) {
      const search = asRecord(await deps.searchSessions?.({ query: targetQuery, includeSelf: true }) ?? { allowed: false, code: 'TARGET_NOT_FOUND' });
      if (search.allowed === false) {
        return deny(deps, input, asString(search.code) ?? 'TARGET_NOT_FOUND', auditId);
      }
      const matches = Array.isArray(search.matches) ? search.matches.map(asRecord) : [];
      if (matches.length > 1) {
        return deny(deps, input, 'AMBIGUOUS_TARGET', auditId);
      }
      if (matches.length < 1) {
        return deny(deps, input, 'TARGET_NOT_FOUND', auditId);
      }
      deliveryTargetSessionKey = asString(matches[0]?.sessionKey) ?? deliveryTargetSessionKey;
    }
    if (targetSessionKey && deliveryTargetSessionKey !== targetSessionKey) {
      return deny(deps, input, 'WEBHOOK_BINDING_DENIED', auditId);
    }

    const assignment = {
      assignmentId: `assignment_${crypto.randomUUID()}`,
      sourceSessionKey: '0',
      callerSessionId: '0',
      promptHash: hashText(prompt),
      promptPreview: normalizeMcpPromptPreview({ prompt, maxChars: 80 }),
      actorType: 'webhook',
      targetSessionKey: deliveryTargetSessionKey,
      auditId,
    };

    if (!deliveryTargetSessionKey) {
      const profile = deps.defaultProfile;
      if (!profile || profile.enabled === false) {
        return deny(deps, input, 'AGENT_PROFILE_NOT_FOUND', auditId);
      }
      deps.recordAssignment?.(assignment);
      deps.audit?.({ auditId, actorType: 'webhook', credentialKind, result: 'accepted', promptHash: assignment.promptHash });
      deps.accessLog?.(redactWebhookAccess(input, auditId, 'accepted'));
      const openResult = asRecord(await deps.openAgent?.({
        profileId: asString(profile.id) ?? asString(record.profileId) ?? 'default',
        kickoffPrompt: prompt,
        actor: { type: 'webhook', sessionKey: '0' },
      }) ?? { ok: true });
      if (openResult.ok !== false) {
        markWebhookUsed(record, deps);
        await persistUsageMetadata(auditId);
      }
      const opened = openResult.ok !== false;
      return {
        ok: opened,
        assignmentId: assignment.assignmentId,
        auditId,
        openedSessionKey: openResult.sessionKey,
        ...(!opened ? pickProviderFailureFields(openResult, 'openAgentAuditId') : {}),
      };
    }

    deps.recordAssignment?.(assignment);
    deps.audit?.({ auditId, actorType: 'webhook', credentialKind, result: 'accepted', promptHash: assignment.promptHash });
    deps.accessLog?.(redactWebhookAccess(input, auditId, 'accepted'));
    const deliveryResult = asRecord(await deps.deliverMessage?.({
      assignment,
      sessionKey: deliveryTargetSessionKey,
      prompt,
      deliveryMode: 'paste',
      actor: { type: 'webhook', sessionKey: '0' },
      auditContext: { auditId, actorType: 'webhook' },
    }) ?? { ok: true, accepted: true });
    if (deliveryResult.ok !== false && deliveryResult.accepted !== false) {
      markWebhookUsed(record, deps);
      await persistUsageMetadata(auditId);
    }
    const delivered = deliveryResult.ok !== false && deliveryResult.accepted !== false;
    return {
      ok: delivered,
      assignmentId: assignment.assignmentId,
      auditId,
      status: deliveryResult.status ?? 'delivered',
      ...(!delivered ? pickProviderFailureFields(deliveryResult, 'deliveryAuditId') : {}),
    };
  };

  return {
    createWebhookKey,
    listWebhookKeys,
    rotateWebhookKey,
    revokeWebhookKey,
    getWebhookConfig,
    setWebhookConfig,
    getWebhookStatus,
    invokeWebhook,
  };
}

function pickProviderFailureFields(providerResult: StringRecord, providerAuditIdKey: string): StringRecord {
  const result: StringRecord = {};
  for (const key of ['code', 'message', 'details', 'fieldErrors']) {
    if (providerResult[key] !== undefined) {
      result[key] = providerResult[key];
    }
  }
  const providerAuditId = asString(providerResult.auditId);
  if (providerAuditId) {
    result[providerAuditIdKey] = providerAuditId;
  }
  return result;
}

export function createWebhookRecordFileStore(options: { dataPath?: string } = {}): StringRecord {
  const dataFilePath = path.resolve(options.dataPath ?? DEFAULT_WEBHOOK_RECORD_DATA_PATH);
  return {
    getDataFilePath: () => dataFilePath,
    loadRecords: async (): Promise<StringRecord[]> => {
      await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
      try {
        const raw = await fs.readFile(dataFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as { webhooks?: unknown[] };
        return Array.isArray(parsed.webhooks) ? parsed.webhooks.map(asRecord) : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[WebhookInvocationService] Failed to load webhook store:', error);
        }
        return [];
      }
    },
    saveRecords: async (records: unknown): Promise<StringRecord> => {
      const webhooks = (Array.isArray(records) ? records : [])
        .map(asRecord)
        .map(record => sanitizeWebhookRecord(record));
      await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
      const tempPath = `${dataFilePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify({
        version: 1,
        webhooks,
        updatedAt: new Date().toISOString(),
      }, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tempPath, dataFilePath);
      return { ok: true, path: dataFilePath, count: webhooks.length };
    },
  };
}

export function sanitizeWebhookPublicRecord(value: unknown): StringRecord {
  const record = { ...asRecord(value) };
  delete record.keyHash;
  delete record.fullKey;
  delete record.fullUrl;
  return record;
}

function normalizeWebhookRecords(deps: WebhookInvocationDeps): StringRecord[] {
  const records = Array.isArray(deps.webhookRecords) ? deps.webhookRecords.map(asRecord) : [];
  const record = asRecord(deps.webhookRecord);
  if (Object.keys(record).length > 0) {
    records.unshift(record);
  }
  return records.map((item, index) => {
    const fullKey = asString(item.fullKey);
    const keyHash = fullKey ? hashWebhookKey(fullKey) : asString(item.keyHash);
    const missingKeyHash = !keyHash;
    return {
      keyId: asString(item.keyId) ?? asString(item.id) ?? `wh_${index + 1}`,
      id: asString(item.id) ?? asString(item.keyId) ?? `wh_${index + 1}`,
      keyHash,
      maskedKey: asString(item.maskedKey) ?? 'bgwh_****_key',
      targetSessionKey: asString(item.targetSessionKey),
      profileId: asString(item.profileId) ?? 'codex-env',
      mode: asString(item.mode) ?? 'send-only',
      scopes: asStringArray(item.scopes).length > 0 ? asStringArray(item.scopes) : ['mcp:webhook.invoke'],
      createdAt: asString(item.createdAt) ?? new Date().toISOString(),
      lastUsedAt: item.lastUsedAt ?? null,
      expiresAt: item.expiresAt ?? null,
      revoked: item.revoked === true || missingKeyHash,
      revokedAt: item.revokedAt ?? (missingKeyHash ? new Date().toISOString() : undefined),
      invalidReason: missingKeyHash ? 'WEBHOOK_KEY_HASH_MISSING' : item.invalidReason,
      rateLimit: asRecord(item.rateLimit).windowSeconds ? item.rateLimit : { windowSeconds: 60, burstLimit: 10 },
    };
  });
}

function findWebhookRecord(records: StringRecord[], fullKey: string): StringRecord | null {
  const keyHash = hashWebhookKey(fullKey);
  return records.find(record => asString(record.keyHash) === keyHash) ?? null;
}

function sanitizeWebhookRecord(record: StringRecord): StringRecord {
  return {
    keyId: asString(record.keyId) ?? asString(record.id),
    id: asString(record.id) ?? asString(record.keyId),
    keyHash: asString(record.keyHash),
    maskedKey: asString(record.maskedKey),
    targetSessionKey: record.targetSessionKey,
    profileId: record.profileId,
    mode: record.mode,
    scopes: Array.isArray(record.scopes) ? record.scopes.map(String) : [],
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    revoked: record.revoked === true,
    revokedAt: record.revokedAt,
    rateLimit: record.rateLimit ?? { windowSeconds: 60, burstLimit: 10 },
  };
}

function deny(deps: WebhookInvocationDeps, request: StringRecord, code: string, auditId: string): StringRecord {
  deps.audit?.({ auditId, actorType: 'webhook', result: 'denied', code });
  deps.accessLog?.(redactWebhookAccess(request, auditId, code));
  return { ok: false, code, auditId };
}

function redactWebhookAccess(request: StringRecord, auditId: string, result: string): StringRecord {
  const prompt = asString(asRecord(request.query).prompt) ?? asString(request.prompt) ?? '';
  return {
    auditId,
    result,
    method: request.method,
    path: asString(request.path) ?? String(asString(request.url) ?? '').split('?')[0],
    promptPreview: prompt ? `sha256:${hashText(prompt).slice(0, 16)}` : '',
  };
}

function buildWebhookUrl(keyId: string | undefined, fullKey: string | undefined): string {
  return `/webhook/agent?id=${encodeURIComponent(keyId ?? '')}&key=${encodeURIComponent(fullKey ?? '')}`;
}

function normalizeHeaders(headers: StringRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function asHeaderInput(value: unknown): Record<string, string | string[] | undefined> {
  const record = asRecord(value);
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue === 'string' || Array.isArray(headerValue)) {
      result[key] = headerValue as string | string[];
    }
  }
  return result;
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashWebhookKey(value: string): string {
  return `sha256:${hashText(value)}`;
}

function isExpired(record: StringRecord, deps: WebhookInvocationDeps): boolean {
  const expiresAt = asString(record.expiresAt);
  if (!expiresAt) {
    return false;
  }
  const expiresTime = Date.parse(expiresAt);
  const nowTime = Date.parse(nowIso(deps));
  return Number.isFinite(expiresTime) && Number.isFinite(nowTime) && expiresTime <= nowTime;
}

function markWebhookUsed(record: StringRecord, deps: WebhookInvocationDeps): void {
  record.lastUsedAt = nowIso(deps);
}

function nowIso(deps: WebhookInvocationDeps): string {
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

function normalizeWebhookRateLimit(value: unknown): { windowSeconds: number; burstLimit: number } | null {
  const record = asRecord(value);
  const windowSeconds = Number(record.windowSeconds);
  const burstLimit = Number(record.burstLimit);
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || !Number.isInteger(burstLimit) || burstLimit < 1) {
    return null;
  }
  return { windowSeconds, burstLimit };
}
