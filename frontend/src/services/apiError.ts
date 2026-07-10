export function parseApiErrorPayload(status: number, statusText: string, data: unknown): string {
  const root = asApiRecord(data);
  const nested = asApiRecord(root?.error);
  const details = asApiRecord(root?.details) ?? asApiRecord(nested?.details);
  const message = asApiString(nested?.message) ?? asApiString(root?.message);
  const code = asApiString(nested?.code) ?? asApiString(root?.code);
  const auditId = asApiString(root?.auditId) ?? asApiString(nested?.auditId) ?? asApiString(details?.auditId);
  const fieldErrors = asApiRecord(root?.fieldErrors) ?? asApiRecord(nested?.fieldErrors);
  const rollbackErrors = asApiArray(root?.rollbackErrors)
    ?? asApiArray(details?.rollbackErrors)
    ?? asApiArray(nested?.rollbackErrors);
  const detailParts: string[] = [];

  if (code && message !== code) {
    detailParts.push(code);
  }
  if (auditId) {
    detailParts.push(`auditId: ${auditId}`);
  }
  if (fieldErrors) {
    const fieldSummary = Object.entries(fieldErrors)
      .map(([field, value]) => `${field}: ${formatApiErrorValue(value)}`)
      .join(', ');
    if (fieldSummary) {
      detailParts.push(fieldSummary);
    }
  }
  if (rollbackErrors && rollbackErrors.length > 0) {
    detailParts.push(`rollbackErrors: ${rollbackErrors.map(formatRollbackError).join('|')}`);
  }

  if (message) {
    return detailParts.length > 0 ? `${message} (${detailParts.join('; ')})` : message;
  }
  if (detailParts.length > 0) {
    return detailParts.join('; ');
  }
  return `HTTP ${status}: ${statusText || 'Request failed'}`;
}

function asApiRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asApiString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asApiArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function formatApiErrorValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(formatApiErrorValue).join('|');
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatRollbackError(value: unknown): string {
  const record = asApiRecord(value);
  if (!record) {
    return formatApiErrorValue(value);
  }
  const target = asApiString(record.target);
  const code = asApiString(record.code);
  const message = asApiString(record.message);
  return [target, code, message].filter(Boolean).join(':');
}
