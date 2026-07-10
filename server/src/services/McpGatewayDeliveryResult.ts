type StringRecord = Record<string, unknown>;

export function buildMcpGatewayDeliveryResponse(result: unknown): StringRecord {
  const record = asRecord(result);
  const accepted = record.accepted === true;
  return {
    ok: accepted,
    accepted,
    status: accepted ? 'delivered' : 'failed',
    code: accepted ? undefined : record.code ?? 'DELIVERY_FAILED',
    auditId: record.auditId,
    ...pickMcpGatewayFailureFields(record),
  };
}

function pickMcpGatewayFailureFields(result: StringRecord): StringRecord {
  if (result.accepted === true && result.ok !== false && result.status !== 'failed') {
    return {};
  }
  const fields: StringRecord = {};
  for (const key of ['message', 'details', 'fieldErrors']) {
    if (result[key] !== undefined) {
      fields[key] = result[key];
    }
  }
  return fields;
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}
