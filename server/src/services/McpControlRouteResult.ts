import crypto from 'node:crypto';

type StringRecord = Record<string, unknown>;

export function isMcpControlRouteFailure(result: StringRecord): boolean {
  return result.ok === false || result.allowed === false;
}

export function buildMcpControlRouteFailure(
  result: StringRecord,
  createRequestId: () => string = () => `req_${crypto.randomUUID()}`,
): { status: number; body: StringRecord } {
  const code = asString(result.code) ?? 'MCP_CONTROL_ERROR';
  const body: StringRecord = {
    ok: false,
    code,
    message: asString(result.message) ?? code,
    requestId: result.requestId ?? result.auditId ?? createRequestId(),
  };
  copyIfPresent(result, body, 'fieldErrors');
  copyIfPresent(result, body, 'auditId');
  copyIfPresent(result, body, 'details');
  copyIfPresent(result, body, 'rollbackErrors');
  return {
    status: statusForMcpControlCode(code),
    body,
  };
}

export function statusForMcpControlCode(code: string): number {
  if (code === 'CREDENTIAL_BOUNDARY_VIOLATION' || code === 'MISSING_TOKEN' || code === 'INVALID_TOKEN') {
    return 401;
  }
  if (code === 'VALIDATION_ERROR' || code === 'CLOSE_CONFIRMATION_REQUIRED') {
    return 400;
  }
  if (code === 'TARGET_NOT_FOUND' || code === 'AGENT_PROFILE_NOT_FOUND' || code === 'WEBHOOK_KEY_INVALID') {
    return 404;
  }
  if (code.includes('DENIED') || code === 'INVALID_SCOPE') {
    return 403;
  }
  if (code === 'WEBHOOK_RATE_LIMITED') {
    return 429;
  }
  return 400;
}

function copyIfPresent(source: StringRecord, target: StringRecord, key: string): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
