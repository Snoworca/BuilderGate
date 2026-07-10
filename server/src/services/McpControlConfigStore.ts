import fs from 'node:fs/promises';
import path from 'node:path';
import {
  validateMcpSecurityConfig,
  validateMcpWebhookKeyHeaderName,
} from './McpSecurityContract.js';

type StringRecord = Record<string, unknown>;
type McpControlConfigStoreOptions = {
  dataPath?: string;
  warn?: (event: StringRecord) => void;
};
type MergeStoredMcpControlConfigOptions = {
  dataPath?: string;
  warn?: (event: StringRecord) => void;
};

const DEFAULT_MCP_CONTROL_CONFIG_DATA_PATH = './data/mcp-control-config.json';
const DEFAULT_WEBHOOK_HEADER = 'X-BuilderGate-Webhook-Key';
const DEFAULT_WEBHOOK_RATE_LIMIT = { windowSeconds: 60, burstLimit: 10 };

export function createMcpControlConfigFileStore(options: McpControlConfigStoreOptions = {}): StringRecord {
  const dataFilePath = path.resolve(options.dataPath ?? DEFAULT_MCP_CONTROL_CONFIG_DATA_PATH);
  const warn = options.warn ?? ((event: StringRecord) => {
    console.warn('[McpControlConfigStore] MCP control config fallback:', event);
  });
  return {
    getDataFilePath: () => dataFilePath,
    loadConfig: async (): Promise<StringRecord> => {
      await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
      try {
        const raw = await fs.readFile(dataFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as { config?: unknown };
        const validation = validatePersistedMcpControlConfig(parsed.config);
        if (validation.ok === false) {
          warn({
            code: asString(validation.code) ?? 'MCP_CONTROL_CONFIG_INVALID',
            path: dataFilePath,
            message: asString(validation.message) ?? 'Ignoring invalid persisted MCP control config',
          });
          return {};
        }
        return sanitizeMcpControlConfig(parsed.config);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          warn({
            code: 'MCP_CONTROL_CONFIG_LOAD_FAILED',
            path: dataFilePath,
            message: error instanceof Error ? error.message : 'Failed to load MCP control config',
          });
        }
        return {};
      }
    },
    saveConfig: async (config: unknown): Promise<StringRecord> => {
      const sanitized = sanitizeMcpControlConfig(config);
      const validation = validatePersistedMcpControlConfig(sanitized);
      if (validation.ok === false) {
        return validation;
      }
      await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
      const tempPath = `${dataFilePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify({
        version: 1,
        config: sanitized,
        updatedAt: new Date().toISOString(),
      }, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tempPath, dataFilePath);
      return { ok: true, path: dataFilePath, config: sanitized };
    },
  };
}

export function sanitizeMcpControlConfig(value: unknown): StringRecord {
  const record = asRecord(value);
  const webhookRateLimit = normalizeRateLimit(record.webhookRateLimit);
  const config: StringRecord = {};

  if (record.enabled !== undefined) config.enabled = record.enabled !== false;
  if (asString(record.bindMode)) config.bindMode = asString(record.bindMode);
  if (asString(record.host) || asString(record.bindHost)) {
    config.host = asString(record.host) ?? asString(record.bindHost);
    config.bindHost = asString(record.bindHost) ?? asString(record.host);
  }
  if (record.port !== undefined && Number.isInteger(Number(record.port))) config.port = Number(record.port);
  if (asString(record.transportSecurity)) config.transportSecurity = asString(record.transportSecurity);
  if (Array.isArray(record.trustedProxies)) config.trustedProxies = asStringArray(record.trustedProxies);
  if (Array.isArray(record.externalWhitelist)) config.externalWhitelist = asStringArray(record.externalWhitelist);
  if (Array.isArray(record.allowedOrigins)) config.allowedOrigins = asStringArray(record.allowedOrigins);
  if (asString(record.webhookKeyHeaderName)) config.webhookKeyHeaderName = asString(record.webhookKeyHeaderName);
  if (webhookRateLimit) config.webhookRateLimit = webhookRateLimit;

  return config;
}

export function mergeStoredMcpControlConfig(
  defaults: unknown,
  stored: unknown,
  options: MergeStoredMcpControlConfigOptions = {},
): StringRecord {
  const defaultConfig = asRecord(defaults);
  const storedConfig = sanitizeMcpControlConfig(stored);
  const storedValidation = validatePersistedMcpControlConfig(storedConfig);
  if (storedValidation.ok === false) {
    options.warn?.({
      code: asString(storedValidation.code) ?? 'MCP_CONTROL_CONFIG_INVALID',
      path: options.dataPath ?? DEFAULT_MCP_CONTROL_CONFIG_DATA_PATH,
      message: asString(storedValidation.message) ?? 'Ignoring invalid persisted MCP control config',
    });
  }
  const safeStoredConfig = storedValidation.ok === false ? {} : storedConfig;
  const merged = {
    ...defaultConfig,
    ...safeStoredConfig,
  };
  const host = asString(merged.host) ?? asString(merged.bindHost) ?? '127.0.0.1';
  return {
    ...merged,
    host,
    bindHost: asString(merged.bindHost) ?? host,
    webhookKeyHeaderName: asString(merged.webhookKeyHeaderName) ?? DEFAULT_WEBHOOK_HEADER,
    webhookRateLimit: normalizeRateLimit(merged.webhookRateLimit) ?? DEFAULT_WEBHOOK_RATE_LIMIT,
  };
}

export function validatePersistedMcpControlConfig(value: unknown): StringRecord {
  const record = asRecord(value);
  const securityValidation = asRecord(validateMcpSecurityConfig({
    enabled: record.enabled !== false,
    bindMode: asString(record.bindMode) ?? 'loopback',
    bindHost: asString(record.bindHost) ?? asString(record.host) ?? '127.0.0.1',
    externalWhitelist: Array.isArray(record.externalWhitelist) ? asStringArray(record.externalWhitelist) : [],
    transportSecurity: asString(record.transportSecurity) ?? 'none',
    trustedProxies: Array.isArray(record.trustedProxies) ? asStringArray(record.trustedProxies) : [],
    allowedOrigins: Array.isArray(record.allowedOrigins) ? asStringArray(record.allowedOrigins) : [],
  }));
  if (securityValidation.ok === false) {
    return securityValidation;
  }
  const webhookHeaderValidation = asRecord(validateMcpWebhookKeyHeaderName(
    asString(record.webhookKeyHeaderName) ?? DEFAULT_WEBHOOK_HEADER,
  ));
  if (webhookHeaderValidation.ok === false) {
    return webhookHeaderValidation;
  }
  if (record.webhookRateLimit !== undefined && !normalizeRateLimit(record.webhookRateLimit)) {
    return { ok: false, code: 'WEBHOOK_RATE_LIMIT_INVALID' };
  }
  return { ok: true };
}

function normalizeRateLimit(value: unknown): { windowSeconds: number; burstLimit: number } | null {
  const record = asRecord(value);
  const windowSeconds = Number(record.windowSeconds);
  const burstLimit = Number(record.burstLimit);
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || !Number.isInteger(burstLimit) || burstLimit < 1) {
    return null;
  }
  return { windowSeconds, burstLimit };
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
