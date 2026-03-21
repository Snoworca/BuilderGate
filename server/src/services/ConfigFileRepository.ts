import JSON5 from 'json5';
import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import type { Config } from '../types/config.types.js';
import type { EditableSettingsValues } from '../types/settings.types.js';
import { configSchema } from '../schemas/config.schema.js';
import { getConfigPath } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface SecretPatch {
  authPassword?: string;
  smtpPassword?: string;
}

interface PersistOptions {
  dryRun?: boolean;
}

export interface PersistResult {
  previousConfig: Config;
  nextConfig: Config;
  renderedContent: string;
  backupPath: string;
}

export class ConfigFileRepository {
  constructor(private readonly configPath: string = getConfigPath()) {}

  persistEditableValues(
    values: EditableSettingsValues,
    secrets: SecretPatch = {},
    options: PersistOptions = {},
  ): PersistResult {
    try {
      const originalContent = readFileSync(this.configPath, 'utf-8');
      const rawConfig = JSON5.parse(originalContent) as Record<string, unknown>;
      const previousConfig = configSchema.parse(rawConfig) as Config;

      const mergedRawConfig = applyEditableValues(structuredClone(rawConfig), values, secrets);
      const nextConfig = configSchema.parse(mergedRawConfig) as Config;
      const renderedContent = renderPatchedConfig(originalContent, nextConfig, secrets);
      const reparsed = JSON5.parse(renderedContent);
      configSchema.parse(reparsed);

      if (!options.dryRun) {
        this.writePreparedResult({
          previousConfig,
          nextConfig,
          renderedContent,
          backupPath: `${this.configPath}.bak`,
        });
      }

      return {
        previousConfig,
        nextConfig,
        renderedContent,
        backupPath: `${this.configPath}.bak`,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        ErrorCode.CONFIG_PERSIST_FAILED,
        error instanceof Error ? error.message : 'Unknown configuration persistence error',
      );
    }
  }

  writePreparedResult(result: PersistResult): void {
    try {
      copyFileSync(this.configPath, result.backupPath);
      writeFileSync(this.configPath, result.renderedContent, 'utf-8');
    } catch (error) {
      throw new AppError(
        ErrorCode.CONFIG_PERSIST_FAILED,
        error instanceof Error ? error.message : 'Unknown configuration persistence error',
      );
    }
  }
}

function applyEditableValues(
  rawConfig: Record<string, unknown>,
  values: EditableSettingsValues,
  secrets: SecretPatch,
): Record<string, unknown> {
  setPath(rawConfig, ['auth', 'durationMs'], values.auth.durationMs);
  setPath(rawConfig, ['twoFactor', 'enabled'], values.twoFactor.enabled);
  setPath(rawConfig, ['twoFactor', 'email'], values.twoFactor.email);
  setPath(rawConfig, ['twoFactor', 'otpLength'], values.twoFactor.otpLength);
  setPath(rawConfig, ['twoFactor', 'otpExpiryMs'], values.twoFactor.otpExpiryMs);
  setPath(rawConfig, ['twoFactor', 'smtp', 'host'], values.twoFactor.smtp.host);
  setPath(rawConfig, ['twoFactor', 'smtp', 'port'], values.twoFactor.smtp.port);
  setPath(rawConfig, ['twoFactor', 'smtp', 'secure'], values.twoFactor.smtp.secure);
  setPath(rawConfig, ['twoFactor', 'smtp', 'auth', 'user'], values.twoFactor.smtp.auth.user);
  setPath(rawConfig, ['twoFactor', 'smtp', 'tls', 'rejectUnauthorized'], values.twoFactor.smtp.tls.rejectUnauthorized);
  setPath(rawConfig, ['twoFactor', 'smtp', 'tls', 'minVersion'], values.twoFactor.smtp.tls.minVersion);
  setPath(rawConfig, ['security', 'cors', 'allowedOrigins'], values.security.cors.allowedOrigins);
  setPath(rawConfig, ['security', 'cors', 'credentials'], values.security.cors.credentials);
  setPath(rawConfig, ['security', 'cors', 'maxAge'], values.security.cors.maxAge);
  setPath(rawConfig, ['pty', 'termName'], values.pty.termName);
  setPath(rawConfig, ['pty', 'defaultCols'], values.pty.defaultCols);
  setPath(rawConfig, ['pty', 'defaultRows'], values.pty.defaultRows);
  setPath(rawConfig, ['pty', 'useConpty'], values.pty.useConpty);
  setPath(rawConfig, ['pty', 'maxBufferSize'], values.pty.maxBufferSize);
  setPath(rawConfig, ['pty', 'shell'], values.pty.shell);
  setPath(rawConfig, ['session', 'idleDelayMs'], values.session.idleDelayMs);
  setPath(rawConfig, ['fileManager', 'maxFileSize'], values.fileManager.maxFileSize);
  setPath(rawConfig, ['fileManager', 'maxDirectoryEntries'], values.fileManager.maxDirectoryEntries);
  setPath(rawConfig, ['fileManager', 'blockedExtensions'], values.fileManager.blockedExtensions);
  setPath(rawConfig, ['fileManager', 'blockedPaths'], values.fileManager.blockedPaths);
  setPath(rawConfig, ['fileManager', 'cwdCacheTtlMs'], values.fileManager.cwdCacheTtlMs);

  if (secrets.authPassword !== undefined) {
    setPath(rawConfig, ['auth', 'password'], secrets.authPassword);
  }
  if (secrets.smtpPassword !== undefined) {
    setPath(rawConfig, ['twoFactor', 'smtp', 'auth', 'password'], secrets.smtpPassword);
  }

  return rawConfig;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function renderPatchedConfig(content: string, config: Config, secrets: SecretPatch): string {
  const replacements = new Map<string, string>([
    ['auth.durationMs', renderJson5Value(config.auth?.durationMs ?? 1800000)],
    ['twoFactor.enabled', renderJson5Value(config.twoFactor?.enabled ?? false)],
    ['twoFactor.email', renderJson5Value(config.twoFactor?.email ?? '')],
    ['twoFactor.otpLength', renderJson5Value(config.twoFactor?.otpLength ?? 6)],
    ['twoFactor.otpExpiryMs', renderJson5Value(config.twoFactor?.otpExpiryMs ?? 300000)],
    ['twoFactor.smtp.host', renderJson5Value(config.twoFactor?.smtp?.host ?? '')],
    ['twoFactor.smtp.port', renderJson5Value(config.twoFactor?.smtp?.port ?? 587)],
    ['twoFactor.smtp.secure', renderJson5Value(config.twoFactor?.smtp?.secure ?? false)],
    ['twoFactor.smtp.auth.user', renderJson5Value(config.twoFactor?.smtp?.auth.user ?? '')],
    ['twoFactor.smtp.tls.rejectUnauthorized', renderJson5Value(config.twoFactor?.smtp?.tls?.rejectUnauthorized ?? true)],
    ['twoFactor.smtp.tls.minVersion', renderJson5Value(config.twoFactor?.smtp?.tls?.minVersion ?? 'TLSv1.2')],
    ['security.cors.allowedOrigins', renderJson5Value(config.security?.cors.allowedOrigins ?? [])],
    ['security.cors.credentials', renderJson5Value(config.security?.cors.credentials ?? true)],
    ['security.cors.maxAge', renderJson5Value(config.security?.cors.maxAge ?? 86400)],
    ['pty.termName', renderJson5Value(config.pty.termName)],
    ['pty.defaultCols', renderJson5Value(config.pty.defaultCols)],
    ['pty.defaultRows', renderJson5Value(config.pty.defaultRows)],
    ['pty.useConpty', renderJson5Value(config.pty.useConpty)],
    ['pty.maxBufferSize', renderJson5Value(config.pty.maxBufferSize)],
    ['pty.shell', renderJson5Value(config.pty.shell)],
    ['session.idleDelayMs', renderJson5Value(config.session.idleDelayMs)],
    ['fileManager.maxFileSize', renderJson5Value(config.fileManager?.maxFileSize ?? 1048576)],
    ['fileManager.maxDirectoryEntries', renderJson5Value(config.fileManager?.maxDirectoryEntries ?? 10000)],
    ['fileManager.blockedExtensions', renderJson5Value(config.fileManager?.blockedExtensions ?? [])],
    ['fileManager.blockedPaths', renderJson5Value(config.fileManager?.blockedPaths ?? [])],
    ['fileManager.cwdCacheTtlMs', renderJson5Value(config.fileManager?.cwdCacheTtlMs ?? 1000)],
  ]);

  if (secrets.authPassword !== undefined) {
    replacements.set('auth.password', renderJson5Value(secrets.authPassword));
  }
  if (secrets.smtpPassword !== undefined) {
    replacements.set('twoFactor.smtp.auth.password', renderJson5Value(secrets.smtpPassword));
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const stack: string[] = [];
  const replaced = new Set<string>();

  const renderedLines = lines.map((line) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('}')) {
      const closingCount = (trimmed.match(/}/g) || []).length;
      for (let index = 0; index < closingCount; index += 1) {
        stack.pop();
      }
      return line;
    }

    const objectMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*\{\s*(,?\s*(?:\/\/.*)?)?$/);
    if (objectMatch) {
      stack.push(objectMatch[2]);
      return line;
    }

    const valueMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.+)$/);
    if (!valueMatch) {
      return line;
    }

    const key = valueMatch[2];
    const path = [...stack, key].join('.');
    const replacement = replacements.get(path);
    if (!replacement) {
      return line;
    }

    replaced.add(path);
    const suffix = parseValueSuffix(valueMatch[3]);
    return `${valueMatch[1]}${key}: ${replacement}${suffix.hasTrailingComma ? ',' : ''}${suffix.comment}`;
  });

  const missingReplacements = [...replacements.keys()].filter((path) => !replaced.has(path));
  if (missingReplacements.length > 0) {
    throw new AppError(
      ErrorCode.CONFIG_PERSIST_FAILED,
      `Could not patch config paths: ${missingReplacements.join(', ')}`,
    );
  }

  return renderedLines.join(newline);
}

function renderJson5Value(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  return String(value);
}

function parseValueSuffix(rawValue: string): { hasTrailingComma: boolean; comment: string } {
  const commentIndex = findCommentStart(rawValue);
  const valueWithoutComment = commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue;
  const hasTrailingComma = valueWithoutComment.trimEnd().endsWith(',');
  const comment = commentIndex >= 0 ? ` ${rawValue.slice(commentIndex).trimStart()}` : '';

  return { hasTrailingComma, comment };
}

function findCommentStart(rawValue: string): number {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < rawValue.length - 1; index += 1) {
    const current = rawValue[index];
    const next = rawValue[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (current === '\\') {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && current === '\'') {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && current === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && current === '/' && next === '/') {
      return index;
    }
  }

  return -1;
}
