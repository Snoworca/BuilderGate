type StringRecord = Record<string, unknown>;

type McpControlConfigCoordinatorInput = {
  body: unknown;
  controlService: StringRecord | null;
  webhookService: StringRecord | null;
  configStore?: StringRecord | null;
  validateWebhookHeaderName: (headerName: string) => unknown;
};

export async function applyMcpControlConfigPatch(input: McpControlConfigCoordinatorInput): Promise<StringRecord> {
  const body = asRecord(input.body);
  const previousControl = asRecord(await callService(input.controlService, 'getConfig', { auth: { type: 'browser-jwt' } }));
  if (isMcpControlRouteFailure(previousControl)) {
    return previousControl;
  }
  const previousWebhook = asRecord(await callService(input.webhookService, 'getWebhookConfig', {}));
  if (isMcpControlRouteFailure(previousWebhook)) {
    return previousWebhook;
  }
  const webhookPatchValidation = validateWebhookPatch(body, input.validateWebhookHeaderName);
  if (webhookPatchValidation.ok === false) {
    return webhookPatchValidation;
  }

  const control = asRecord(await callService(input.controlService, 'setConfig', {
    ...body,
    auth: { type: 'browser-jwt' },
  }));
  if (control.ok === false) {
    return control;
  }

  const webhookPatch = asRecord(webhookPatchValidation.webhookPatch);
  if (Object.keys(webhookPatch).length > 0) {
    try {
      const webhookResult = asRecord(await callService(input.webhookService, 'setWebhookConfig', webhookPatch));
      if (webhookResult.ok === false) {
        const rollbackErrors = await restoreMcpControlConfig(input, previousControl, previousWebhook);
        return withRollbackErrors(webhookResult, rollbackErrors);
      }
    } catch (error) {
      const rollbackErrors = await restoreMcpControlConfig(input, previousControl, previousWebhook);
      return withRollbackErrors({
        ok: false,
        code: 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED',
        message: error instanceof Error ? error.message : 'Failed to apply webhook config',
      }, rollbackErrors);
    }
  }

  const webhook = asRecord(await callService(input.webhookService, 'getWebhookConfig', {}));
  if (isMcpControlRouteFailure(webhook)) {
    const rollbackErrors = await restoreMcpControlConfig(input, previousControl, previousWebhook);
    return withRollbackErrors(webhook, rollbackErrors);
  }
  const response = {
    ...control,
    webhookKeyHeaderName: webhook.webhookKeyHeaderName,
    webhookRateLimit: webhook.rateLimit,
  };

  try {
    const saveConfig = input.configStore?.saveConfig as ((payload: unknown) => unknown | Promise<unknown>) | undefined;
    if (saveConfig) {
      const persisted = asRecord(await saveConfig({
        ...control,
        host: control.host,
        bindHost: control.host,
        webhookKeyHeaderName: webhook.webhookKeyHeaderName,
        webhookRateLimit: webhook.rateLimit,
      }));
      if (persisted.ok === false) {
        const rollbackErrors = await restoreMcpControlConfig(input, previousControl, previousWebhook);
        return withRollbackErrors(persisted, rollbackErrors);
      }
    }
  } catch (error) {
    const rollbackErrors = await restoreMcpControlConfig(input, previousControl, previousWebhook);
    return withRollbackErrors({
      ok: false,
      code: 'MCP_CONTROL_CONFIG_PERSIST_FAILED',
      message: error instanceof Error ? error.message : 'Failed to persist MCP control config',
    }, rollbackErrors);
  }

  return response;
}

function isMcpControlRouteFailure(result: StringRecord): boolean {
  return result.ok === false || result.allowed === false;
}

async function restoreMcpControlConfig(
  input: McpControlConfigCoordinatorInput,
  previousControl: StringRecord,
  previousWebhook: StringRecord,
): Promise<StringRecord[]> {
  const rollbackErrors: StringRecord[] = [];

  try {
    const controlRestore = asRecord(await callService(input.controlService, 'setConfig', {
      ...previousControl,
      auth: { type: 'browser-jwt' },
    }));
    if (controlRestore.ok === false) {
      rollbackErrors.push(toRollbackError('control', controlRestore));
    }
  } catch (error) {
    rollbackErrors.push(toRollbackException('control', error));
  }

  try {
    const webhookRestore = asRecord(await callService(input.webhookService, 'setWebhookConfig', {
      webhookKeyHeaderName: previousWebhook.webhookKeyHeaderName,
      rateLimit: previousWebhook.rateLimit,
    }));
    if (webhookRestore.ok === false) {
      rollbackErrors.push(toRollbackError('webhook', webhookRestore));
    }
  } catch (error) {
    rollbackErrors.push(toRollbackException('webhook', error));
  }

  return rollbackErrors;
}

function withRollbackErrors(result: StringRecord, rollbackErrors: StringRecord[]): StringRecord {
  return rollbackErrors.length > 0 ? { ...result, rollbackErrors } : result;
}

function toRollbackError(target: string, result: StringRecord): StringRecord {
  return {
    target,
    code: asString(result.code) ?? 'MCP_CONTROL_CONFIG_ROLLBACK_FAILED',
    message: asString(result.message) ?? 'Failed to restore previous MCP control config',
  };
}

function toRollbackException(target: string, error: unknown): StringRecord {
  return {
    target,
    code: 'MCP_CONTROL_CONFIG_ROLLBACK_FAILED',
    message: error instanceof Error ? error.message : 'Failed to restore previous MCP control config',
  };
}

function validateWebhookPatch(
  body: StringRecord,
  validateWebhookHeaderName: (headerName: string) => unknown,
): StringRecord {
  const hasWebhookHeaderName = Object.prototype.hasOwnProperty.call(body, 'webhookKeyHeaderName');
  const hasWebhookRateLimit = Object.prototype.hasOwnProperty.call(body, 'webhookRateLimit');
  const webhookPatch: StringRecord = {};

  if (hasWebhookHeaderName) {
    const headerName = typeof body.webhookKeyHeaderName === 'string' ? body.webhookKeyHeaderName.trim() : '';
    const headerValidation = asRecord(validateWebhookHeaderName(headerName));
    if (headerValidation.ok === false) {
      return headerValidation;
    }
    webhookPatch.webhookKeyHeaderName = headerName;
  }

  if (hasWebhookRateLimit) {
    const rateLimit = asRecord(body.webhookRateLimit);
    const windowSeconds = Number(rateLimit.windowSeconds);
    const burstLimit = Number(rateLimit.burstLimit);
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || !Number.isInteger(burstLimit) || burstLimit < 1) {
      return { ok: false, code: 'WEBHOOK_RATE_LIMIT_INVALID' };
    }
    webhookPatch.rateLimit = { windowSeconds, burstLimit };
  }

  return { ok: true, webhookPatch };
}

async function callService(service: StringRecord | null, name: string, payload: unknown): Promise<unknown> {
  const fn = service?.[name];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'MCP_CONTROL_ROUTE_UNAVAILABLE' };
  }
  return await (fn as (request: unknown) => unknown | Promise<unknown>)(payload);
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
