import JSON5 from 'json5';
import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import type { Config } from '../types/config.types.js';
import type { EditableSettingsKey, EditableSettingsValues } from '../types/settings.types.js';
import { configSchema } from '../schemas/config.schema.js';
import { getConfigPath } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { normalizeRawConfigForPlatform } from '../utils/ptyPlatformPolicy.js';

interface SecretPatch {
  authPassword?: string;
  authJwtSecret?: string;
}

type PersistConfigKey = EditableSettingsKey | 'auth.jwtSecret';

interface PersistOptions {
  dryRun?: boolean;
  changedKeys?: PersistConfigKey[];
}

export interface PersistResult {
  previousConfig: Config;
  nextConfig: Config;
  renderedContent: string;
  backupPath: string;
}

export class ConfigFileRepository {
  constructor(
    private readonly configPath: string = getConfigPath(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  persistAuthPassword(authPassword: string, options: Pick<PersistOptions, 'dryRun'> = {}): PersistResult {
    return this.persistAuthSecrets({ authPassword }, options);
  }

  persistAuthSecrets(
    secrets: Pick<SecretPatch, 'authPassword' | 'authJwtSecret'>,
    options: Pick<PersistOptions, 'dryRun'> = {},
  ): PersistResult {
    try {
      const originalContent = readFileSync(this.configPath, 'utf-8');
      const rawConfig = JSON5.parse(originalContent) as Record<string, unknown>;
      const previousConfig = parseConfigForPlatform(rawConfig, this.platform);
      const mergedRawConfig = structuredClone(rawConfig);
      const changedKeys: PersistConfigKey[] = [];

      if (secrets.authPassword !== undefined) {
        setPath(mergedRawConfig, ['auth', 'password'], secrets.authPassword);
        changedKeys.push('auth.password');
      }
      if (secrets.authJwtSecret !== undefined) {
        setPath(mergedRawConfig, ['auth', 'jwtSecret'], secrets.authJwtSecret);
        changedKeys.push('auth.jwtSecret');
      }

      const nextConfig = parseConfigForPlatform(mergedRawConfig, this.platform);
      const renderedContent = renderPatchedConfig(originalContent, nextConfig, secrets, changedKeys);
      const reparsed = JSON5.parse(renderedContent);
      parseConfigForPlatform(reparsed, this.platform);

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

  persistEditableValues(
    values: EditableSettingsValues,
    secrets: SecretPatch = {},
    options: PersistOptions = {},
  ): PersistResult {
    try {
      const originalContent = readFileSync(this.configPath, 'utf-8');
      const rawConfig = JSON5.parse(originalContent) as Record<string, unknown>;
      const previousConfig = parseConfigForPlatform(rawConfig, this.platform);

      const mergedRawConfig = applyEditableValues(structuredClone(rawConfig), values, secrets, options.changedKeys);
      const nextConfig = parseConfigForPlatform(mergedRawConfig, this.platform);
      const renderedContent = renderPatchedConfig(originalContent, nextConfig, secrets, options.changedKeys);
      const reparsed = JSON5.parse(renderedContent);
      parseConfigForPlatform(reparsed, this.platform);

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
  changedKeys?: PersistConfigKey[],
): Record<string, unknown> {
    const shouldApply = (key: EditableSettingsKey) => !changedKeys || changedKeys.includes(key);

  if (shouldApply('auth.durationMs')) setPath(rawConfig, ['auth', 'durationMs'], values.auth.durationMs);
  if (shouldApply('twoFactor.enabled')) setPath(rawConfig, ['twoFactor', 'enabled'], values.twoFactor.enabled);
  if (shouldApply('twoFactor.externalOnly')) setPath(rawConfig, ['twoFactor', 'externalOnly'], values.twoFactor.externalOnly);
  if (shouldApply('twoFactor.issuer')) setPath(rawConfig, ['twoFactor', 'issuer'], values.twoFactor.issuer);
  if (shouldApply('twoFactor.accountName')) setPath(rawConfig, ['twoFactor', 'accountName'], values.twoFactor.accountName);
  if (shouldApply('security.cors.allowedOrigins')) setPath(rawConfig, ['security', 'cors', 'allowedOrigins'], values.security.cors.allowedOrigins);
  if (shouldApply('security.cors.credentials')) setPath(rawConfig, ['security', 'cors', 'credentials'], values.security.cors.credentials);
  if (shouldApply('security.cors.maxAge')) setPath(rawConfig, ['security', 'cors', 'maxAge'], values.security.cors.maxAge);
  if (shouldApply('pty.termName')) setPath(rawConfig, ['pty', 'termName'], values.pty.termName);
  if (shouldApply('pty.defaultCols')) setPath(rawConfig, ['pty', 'defaultCols'], values.pty.defaultCols);
  if (shouldApply('pty.defaultRows')) setPath(rawConfig, ['pty', 'defaultRows'], values.pty.defaultRows);
  if (shouldApply('pty.useConpty')) setPath(rawConfig, ['pty', 'useConpty'], values.pty.useConpty);
  if (shouldApply('pty.windowsPowerShellBackend')) setPath(rawConfig, ['pty', 'windowsPowerShellBackend'], values.pty.windowsPowerShellBackend);
  if (shouldApply('pty.shell')) setPath(rawConfig, ['pty', 'shell'], values.pty.shell);
  if (shouldApply('session.idleDelayMs')) setPath(rawConfig, ['session', 'idleDelayMs'], values.session.idleDelayMs);
  if (shouldApply('fileManager.maxFileSize')) setPath(rawConfig, ['fileManager', 'maxFileSize'], values.fileManager.maxFileSize);
  if (shouldApply('fileManager.maxDirectoryEntries')) setPath(rawConfig, ['fileManager', 'maxDirectoryEntries'], values.fileManager.maxDirectoryEntries);
  if (shouldApply('fileManager.blockedExtensions')) setPath(rawConfig, ['fileManager', 'blockedExtensions'], values.fileManager.blockedExtensions);
  if (shouldApply('fileManager.blockedPaths')) setPath(rawConfig, ['fileManager', 'blockedPaths'], values.fileManager.blockedPaths);
  if (shouldApply('fileManager.cwdCacheTtlMs')) setPath(rawConfig, ['fileManager', 'cwdCacheTtlMs'], values.fileManager.cwdCacheTtlMs);

  if (secrets.authPassword !== undefined && shouldApply('auth.password')) {
    setPath(rawConfig, ['auth', 'password'], secrets.authPassword);
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

function renderPatchedConfig(
  content: string,
  config: Config,
  secrets: SecretPatch,
  changedKeys?: PersistConfigKey[],
): string {
  const shouldRender = (key: PersistConfigKey) => !changedKeys || changedKeys.includes(key);
  const replacements = new Map<string, string>();

  if (shouldRender('auth.durationMs')) replacements.set('auth.durationMs', renderJson5Value(config.auth?.durationMs ?? 1800000));
  if (shouldRender('twoFactor.enabled')) replacements.set('twoFactor.enabled', renderJson5Value(config.twoFactor?.enabled ?? false));
  if (shouldRender('twoFactor.externalOnly')) replacements.set('twoFactor.externalOnly', renderJson5Value(config.twoFactor?.externalOnly ?? false));
  if (shouldRender('twoFactor.issuer')) replacements.set('twoFactor.issuer', renderJson5Value(config.twoFactor?.issuer ?? 'BuilderGate'));
  if (shouldRender('twoFactor.accountName')) replacements.set('twoFactor.accountName', renderJson5Value(config.twoFactor?.accountName ?? 'admin'));
  if (shouldRender('security.cors.allowedOrigins')) replacements.set('security.cors.allowedOrigins', renderJson5Value(config.security?.cors.allowedOrigins ?? []));
  if (shouldRender('security.cors.credentials')) replacements.set('security.cors.credentials', renderJson5Value(config.security?.cors.credentials ?? true));
  if (shouldRender('security.cors.maxAge')) replacements.set('security.cors.maxAge', renderJson5Value(config.security?.cors.maxAge ?? 86400));
  if (shouldRender('pty.termName')) replacements.set('pty.termName', renderJson5Value(config.pty.termName));
  if (shouldRender('pty.defaultCols')) replacements.set('pty.defaultCols', renderJson5Value(config.pty.defaultCols));
  if (shouldRender('pty.defaultRows')) replacements.set('pty.defaultRows', renderJson5Value(config.pty.defaultRows));
  if (shouldRender('pty.useConpty')) replacements.set('pty.useConpty', renderJson5Value(config.pty.useConpty));
  if (shouldRender('pty.windowsPowerShellBackend')) replacements.set('pty.windowsPowerShellBackend', renderJson5Value(config.pty.windowsPowerShellBackend ?? 'inherit'));
  if (shouldRender('pty.shell')) replacements.set('pty.shell', renderJson5Value(config.pty.shell));
  if (shouldRender('session.idleDelayMs')) replacements.set('session.idleDelayMs', renderJson5Value(config.session.idleDelayMs));
  if (shouldRender('fileManager.maxFileSize')) replacements.set('fileManager.maxFileSize', renderJson5Value(config.fileManager?.maxFileSize ?? 1048576));
  if (shouldRender('fileManager.maxDirectoryEntries')) replacements.set('fileManager.maxDirectoryEntries', renderJson5Value(config.fileManager?.maxDirectoryEntries ?? 10000));
  if (shouldRender('fileManager.blockedExtensions')) replacements.set('fileManager.blockedExtensions', renderJson5Value(config.fileManager?.blockedExtensions ?? []));
  if (shouldRender('fileManager.blockedPaths')) replacements.set('fileManager.blockedPaths', renderJson5Value(config.fileManager?.blockedPaths ?? []));
  if (shouldRender('fileManager.cwdCacheTtlMs')) replacements.set('fileManager.cwdCacheTtlMs', renderJson5Value(config.fileManager?.cwdCacheTtlMs ?? 1000));

  if (secrets.authPassword !== undefined) {
    replacements.set('auth.password', renderJson5Value(secrets.authPassword));
  }
  if (secrets.authJwtSecret !== undefined) {
    replacements.set('auth.jwtSecret', renderJson5Value(secrets.authJwtSecret));
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const stack: string[] = [];
  const replaced = new Set<string>();
  const insertions = new Map<string, { parentPath: string; key: string; value: string }>([
    ...(replacements.has('pty.useConpty')
      ? [['pty.useConpty', {
          parentPath: 'pty',
          key: 'useConpty',
          value: renderJson5Value(config.pty.useConpty),
        }] as const]
      : []),
    ...(replacements.has('pty.windowsPowerShellBackend')
      ? [['pty.windowsPowerShellBackend', {
          parentPath: 'pty',
          key: 'windowsPowerShellBackend',
          value: renderJson5Value(config.pty.windowsPowerShellBackend ?? 'inherit'),
        }] as const]
      : []),
    ...(replacements.has('auth.password')
      ? [['auth.password', {
          parentPath: 'auth',
          key: 'password',
          value: renderJson5Value(secrets.authPassword ?? config.auth?.password ?? ''),
        }] as const]
      : []),
    ...(replacements.has('auth.jwtSecret')
      ? [['auth.jwtSecret', {
          parentPath: 'auth',
          key: 'jwtSecret',
          value: renderJson5Value(secrets.authJwtSecret ?? config.auth?.jwtSecret ?? ''),
        }] as const]
      : []),
  ]);
  const renderedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('}')) {
      const currentPath = stack.join('.');
      for (const [path, insertion] of insertions.entries()) {
        if (replaced.has(path) || currentPath !== insertion.parentPath) {
          continue;
        }
        const parentIndent = line.match(/^(\s*)}/)?.[1] ?? '';
        renderedLines.push(`${parentIndent}  ${insertion.key}: ${insertion.value},`);
        replaced.add(path);
      }
      const closingCount = (trimmed.match(/}/g) || []).length;
      for (let index = 0; index < closingCount; index += 1) {
        stack.pop();
      }
      renderedLines.push(line);
      continue;
    }

    const objectMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*\{\s*(,?\s*(?:\/\/.*)?)?$/);
    if (objectMatch) {
      stack.push(objectMatch[2]);
      renderedLines.push(line);
      continue;
    }

    const valueMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.+)$/);
    if (!valueMatch) {
      renderedLines.push(line);
      continue;
    }

    const key = valueMatch[2];
    const path = [...stack, key].join('.');
    const replacement = replacements.get(path);
    if (!replacement) {
      renderedLines.push(line);
      continue;
    }

    replaced.add(path);
    const suffix = parseValueSuffix(valueMatch[3]);
    renderedLines.push(`${valueMatch[1]}${key}: ${replacement}${suffix.hasTrailingComma ? ',' : ''}${suffix.comment}`);
  }

  const missingReplacements = [...replacements.keys()].filter((path) => !replaced.has(path));
  const missingPtyReplacements = missingReplacements.filter((path) => path.startsWith('pty.'));
  if (missingPtyReplacements.length > 0) {
    const bodyLines = missingPtyReplacements.map((path) => {
      const value = replacements.get(path);
      return `${path.slice('pty.'.length)}: ${value},`;
    });
    if (insertRootSection(renderedLines, 'pty', bodyLines)) {
      for (const path of missingPtyReplacements) {
        replaced.add(path);
      }
    }
  }

  const missingAuthReplacements = missingReplacements.filter((path) => path.startsWith('auth.'));
  if (missingAuthReplacements.length > 0) {
    const bodyLines = missingAuthReplacements.map((path) => {
      if (path === 'auth.password') {
        return `password: ${renderJson5Value(secrets.authPassword ?? config.auth?.password ?? '')},`;
      }
      if (path === 'auth.jwtSecret') {
        return `jwtSecret: ${renderJson5Value(secrets.authJwtSecret ?? config.auth?.jwtSecret ?? '')},`;
      }
      throw new AppError(ErrorCode.CONFIG_PERSIST_FAILED, `Unsupported auth config path: ${path}`);
    });
    if (insertRootSection(renderedLines, 'auth', bodyLines)) {
      for (const path of missingAuthReplacements) {
        replaced.add(path);
      }
    }
  }

  const stillMissingReplacements = [...replacements.keys()].filter((path) => !replaced.has(path));
  if (stillMissingReplacements.length > 0) {
    throw new AppError(
      ErrorCode.CONFIG_PERSIST_FAILED,
      `Could not patch config paths: ${stillMissingReplacements.join(', ')}`,
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

function parseConfigForPlatform(rawConfig: Record<string, unknown>, platform: NodeJS.Platform): Config {
  return configSchema.parse(normalizeRawConfigForPlatform(rawConfig, platform)) as Config;
}

function insertRootSection(renderedLines: string[], sectionName: string, bodyLines: string[]): boolean {
  let rootClosingIndex = -1;
  for (let index = renderedLines.length - 1; index >= 0; index -= 1) {
    if (/^\s*}\s*$/.test(renderedLines[index])) {
      rootClosingIndex = index;
      break;
    }
  }
  if (rootClosingIndex < 0) {
    return false;
  }

  renderedLines.splice(
    rootClosingIndex,
    0,
    `  ${sectionName}: {`,
    ...bodyLines.map((line) => `    ${line}`),
    '  },',
  );
  return true;
}
