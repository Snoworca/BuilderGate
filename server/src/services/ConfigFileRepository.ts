import JSON5 from 'json5';
import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import type {
  Config,
  ResourceLimitsConfig,
  StabilityModesConfig,
} from '../types/config.types.js';
import type { EditableSettingsKey, EditableSettingsValues } from '../types/settings.types.js';
import {
  configSchema,
  resourceLimitsSchema,
  stabilityModesSchema,
} from '../schemas/config.schema.js';
import { getConfigPath } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { normalizeRawConfigForPlatform } from '../utils/ptyPlatformPolicy.js';

interface SecretPatch {
  authPassword?: string;
  authJwtSecret?: string;
}

type PersistConfigKey = EditableSettingsKey | 'auth.jwtSecret';

const RESOURCE_LIMIT_SECTION_NAMES = [
  'headless',
  'ws',
  'clientWs',
  'terminal',
  'snapshots',
  'workspaceRuntime',
  'telemetry',
] as const;

type ResourceLimitSectionName = typeof RESOURCE_LIMIT_SECTION_NAMES[number];

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
  const resourceLimits = values.resourceLimits ?? resourceLimitsSchema.parse({});
  const stabilityModes = values.stabilityModes ?? stabilityModesSchema.parse({});

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
  if (shouldApply('resourceLimits.headless.pendingOutputMaxBytes')) setPath(rawConfig, ['resourceLimits', 'headless', 'pendingOutputMaxBytes'], resourceLimits.headless.pendingOutputMaxBytes);
  if (shouldApply('resourceLimits.headless.pendingOutputMaxChunks')) setPath(rawConfig, ['resourceLimits', 'headless', 'pendingOutputMaxChunks'], resourceLimits.headless.pendingOutputMaxChunks);
  if (shouldApply('resourceLimits.headless.writeLagWarnMs')) setPath(rawConfig, ['resourceLimits', 'headless', 'writeLagWarnMs'], resourceLimits.headless.writeLagWarnMs);
  if (shouldApply('resourceLimits.headless.writeBatchMaxBytes')) setPath(rawConfig, ['resourceLimits', 'headless', 'writeBatchMaxBytes'], resourceLimits.headless.writeBatchMaxBytes);
  if (shouldApply('resourceLimits.headless.overflowPolicy')) setPath(rawConfig, ['resourceLimits', 'headless', 'overflowPolicy'], resourceLimits.headless.overflowPolicy);
  if (shouldApply('resourceLimits.ws.serverBufferedHighWaterBytes')) setPath(rawConfig, ['resourceLimits', 'ws', 'serverBufferedHighWaterBytes'], resourceLimits.ws.serverBufferedHighWaterBytes);
  if (shouldApply('resourceLimits.ws.serverBufferedHardLimitBytes')) setPath(rawConfig, ['resourceLimits', 'ws', 'serverBufferedHardLimitBytes'], resourceLimits.ws.serverBufferedHardLimitBytes);
  if (shouldApply('resourceLimits.ws.perClientOutputQueueMaxBytes')) setPath(rawConfig, ['resourceLimits', 'ws', 'perClientOutputQueueMaxBytes'], resourceLimits.ws.perClientOutputQueueMaxBytes);
  if (shouldApply('resourceLimits.ws.perClientControlQueueMaxBytes')) setPath(rawConfig, ['resourceLimits', 'ws', 'perClientControlQueueMaxBytes'], resourceLimits.ws.perClientControlQueueMaxBytes);
  if (shouldApply('resourceLimits.ws.outputCoalesceWindowMs')) setPath(rawConfig, ['resourceLimits', 'ws', 'outputCoalesceWindowMs'], resourceLimits.ws.outputCoalesceWindowMs);
  if (shouldApply('resourceLimits.clientWs.inputBackpressureBytes')) setPath(rawConfig, ['resourceLimits', 'clientWs', 'inputBackpressureBytes'], resourceLimits.clientWs.inputBackpressureBytes);
  if (shouldApply('resourceLimits.clientWs.hardReconnectBytes')) setPath(rawConfig, ['resourceLimits', 'clientWs', 'hardReconnectBytes'], resourceLimits.clientWs.hardReconnectBytes);
  if (shouldApply('resourceLimits.terminal.visibleOutputQueueMaxBytes')) setPath(rawConfig, ['resourceLimits', 'terminal', 'visibleOutputQueueMaxBytes'], resourceLimits.terminal.visibleOutputQueueMaxBytes);
  if (shouldApply('resourceLimits.terminal.visibleOutputMaxChunks')) setPath(rawConfig, ['resourceLimits', 'terminal', 'visibleOutputMaxChunks'], resourceLimits.terminal.visibleOutputMaxChunks);
  if (shouldApply('resourceLimits.terminal.visibleFlushBudgetBytes')) setPath(rawConfig, ['resourceLimits', 'terminal', 'visibleFlushBudgetBytes'], resourceLimits.terminal.visibleFlushBudgetBytes);
  if (shouldApply('resourceLimits.terminal.hiddenOutputPolicy')) setPath(rawConfig, ['resourceLimits', 'terminal', 'hiddenOutputPolicy'], resourceLimits.terminal.hiddenOutputPolicy);
  if (shouldApply('resourceLimits.terminal.hiddenOutputTailBytes')) setPath(rawConfig, ['resourceLimits', 'terminal', 'hiddenOutputTailBytes'], resourceLimits.terminal.hiddenOutputTailBytes);
  if (shouldApply('resourceLimits.terminal.inputQueueMaxBytes')) setPath(rawConfig, ['resourceLimits', 'terminal', 'inputQueueMaxBytes'], resourceLimits.terminal.inputQueueMaxBytes);
  if (shouldApply('resourceLimits.terminal.inputQueueTtlMs')) setPath(rawConfig, ['resourceLimits', 'terminal', 'inputQueueTtlMs'], resourceLimits.terminal.inputQueueTtlMs);
  if (shouldApply('resourceLimits.terminal.transportOutboxMaxBytes')) setPath(rawConfig, ['resourceLimits', 'terminal', 'transportOutboxMaxBytes'], resourceLimits.terminal.transportOutboxMaxBytes);
  if (shouldApply('resourceLimits.terminal.transportOutboxTtlMs')) setPath(rawConfig, ['resourceLimits', 'terminal', 'transportOutboxTtlMs'], resourceLimits.terminal.transportOutboxTtlMs);
  if (shouldApply('resourceLimits.terminal.scrollbackLines')) setPath(rawConfig, ['resourceLimits', 'terminal', 'scrollbackLines'], resourceLimits.terminal.scrollbackLines);
  if (shouldApply('resourceLimits.snapshots.perSnapshotMaxChars')) setPath(rawConfig, ['resourceLimits', 'snapshots', 'perSnapshotMaxChars'], resourceLimits.snapshots.perSnapshotMaxChars);
  if (shouldApply('resourceLimits.snapshots.totalStorageBudgetChars')) setPath(rawConfig, ['resourceLimits', 'snapshots', 'totalStorageBudgetChars'], resourceLimits.snapshots.totalStorageBudgetChars);
  if (shouldApply('resourceLimits.snapshots.maxEntries')) setPath(rawConfig, ['resourceLimits', 'snapshots', 'maxEntries'], resourceLimits.snapshots.maxEntries);
  if (shouldApply('resourceLimits.snapshots.tombstoneTtlMs')) setPath(rawConfig, ['resourceLimits', 'snapshots', 'tombstoneTtlMs'], resourceLimits.snapshots.tombstoneTtlMs);
  if (shouldApply('resourceLimits.workspaceRuntime.maxLiveWorkspaces')) setPath(rawConfig, ['resourceLimits', 'workspaceRuntime', 'maxLiveWorkspaces'], resourceLimits.workspaceRuntime.maxLiveWorkspaces);
  if (shouldApply('resourceLimits.workspaceRuntime.maxLiveTerminals')) setPath(rawConfig, ['resourceLimits', 'workspaceRuntime', 'maxLiveTerminals'], resourceLimits.workspaceRuntime.maxLiveTerminals);
  if (shouldApply('resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs')) setPath(rawConfig, ['resourceLimits', 'workspaceRuntime', 'hiddenRuntimeTtlMs'], resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs);
  if (shouldApply('resourceLimits.telemetry.sampleIntervalMs')) setPath(rawConfig, ['resourceLimits', 'telemetry', 'sampleIntervalMs'], resourceLimits.telemetry.sampleIntervalMs);
  if (shouldApply('resourceLimits.telemetry.recentEventLimit')) setPath(rawConfig, ['resourceLimits', 'telemetry', 'recentEventLimit'], resourceLimits.telemetry.recentEventLimit);
  if (shouldApply('stabilityModes.headlessQueueMode')) setPath(rawConfig, ['stabilityModes', 'headlessQueueMode'], stabilityModes.headlessQueueMode);
  if (shouldApply('stabilityModes.wsSendMode')) setPath(rawConfig, ['stabilityModes', 'wsSendMode'], stabilityModes.wsSendMode);
  if (shouldApply('stabilityModes.frontendRuntimeResidency')) setPath(rawConfig, ['stabilityModes', 'frontendRuntimeResidency'], stabilityModes.frontendRuntimeResidency);

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
  const resourceLimits = resourceLimitsSchema.parse(config.resourceLimits);
  const stabilityModes = stabilityModesSchema.parse(config.stabilityModes);

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
  if (shouldRender('resourceLimits.headless.pendingOutputMaxBytes')) replacements.set('resourceLimits.headless.pendingOutputMaxBytes', renderJson5Value(resourceLimits.headless.pendingOutputMaxBytes));
  if (shouldRender('resourceLimits.headless.pendingOutputMaxChunks')) replacements.set('resourceLimits.headless.pendingOutputMaxChunks', renderJson5Value(resourceLimits.headless.pendingOutputMaxChunks));
  if (shouldRender('resourceLimits.headless.writeLagWarnMs')) replacements.set('resourceLimits.headless.writeLagWarnMs', renderJson5Value(resourceLimits.headless.writeLagWarnMs));
  if (shouldRender('resourceLimits.headless.writeBatchMaxBytes')) replacements.set('resourceLimits.headless.writeBatchMaxBytes', renderJson5Value(resourceLimits.headless.writeBatchMaxBytes));
  if (shouldRender('resourceLimits.headless.overflowPolicy')) replacements.set('resourceLimits.headless.overflowPolicy', renderJson5Value(resourceLimits.headless.overflowPolicy));
  if (shouldRender('resourceLimits.ws.serverBufferedHighWaterBytes')) replacements.set('resourceLimits.ws.serverBufferedHighWaterBytes', renderJson5Value(resourceLimits.ws.serverBufferedHighWaterBytes));
  if (shouldRender('resourceLimits.ws.serverBufferedHardLimitBytes')) replacements.set('resourceLimits.ws.serverBufferedHardLimitBytes', renderJson5Value(resourceLimits.ws.serverBufferedHardLimitBytes));
  if (shouldRender('resourceLimits.ws.perClientOutputQueueMaxBytes')) replacements.set('resourceLimits.ws.perClientOutputQueueMaxBytes', renderJson5Value(resourceLimits.ws.perClientOutputQueueMaxBytes));
  if (shouldRender('resourceLimits.ws.perClientControlQueueMaxBytes')) replacements.set('resourceLimits.ws.perClientControlQueueMaxBytes', renderJson5Value(resourceLimits.ws.perClientControlQueueMaxBytes));
  if (shouldRender('resourceLimits.ws.outputCoalesceWindowMs')) replacements.set('resourceLimits.ws.outputCoalesceWindowMs', renderJson5Value(resourceLimits.ws.outputCoalesceWindowMs));
  if (shouldRender('resourceLimits.clientWs.inputBackpressureBytes')) replacements.set('resourceLimits.clientWs.inputBackpressureBytes', renderJson5Value(resourceLimits.clientWs.inputBackpressureBytes));
  if (shouldRender('resourceLimits.clientWs.hardReconnectBytes')) replacements.set('resourceLimits.clientWs.hardReconnectBytes', renderJson5Value(resourceLimits.clientWs.hardReconnectBytes));
  if (shouldRender('resourceLimits.terminal.visibleOutputQueueMaxBytes')) replacements.set('resourceLimits.terminal.visibleOutputQueueMaxBytes', renderJson5Value(resourceLimits.terminal.visibleOutputQueueMaxBytes));
  if (shouldRender('resourceLimits.terminal.visibleOutputMaxChunks')) replacements.set('resourceLimits.terminal.visibleOutputMaxChunks', renderJson5Value(resourceLimits.terminal.visibleOutputMaxChunks));
  if (shouldRender('resourceLimits.terminal.visibleFlushBudgetBytes')) replacements.set('resourceLimits.terminal.visibleFlushBudgetBytes', renderJson5Value(resourceLimits.terminal.visibleFlushBudgetBytes));
  if (shouldRender('resourceLimits.terminal.hiddenOutputPolicy')) replacements.set('resourceLimits.terminal.hiddenOutputPolicy', renderJson5Value(resourceLimits.terminal.hiddenOutputPolicy));
  if (shouldRender('resourceLimits.terminal.hiddenOutputTailBytes')) replacements.set('resourceLimits.terminal.hiddenOutputTailBytes', renderJson5Value(resourceLimits.terminal.hiddenOutputTailBytes));
  if (shouldRender('resourceLimits.terminal.inputQueueMaxBytes')) replacements.set('resourceLimits.terminal.inputQueueMaxBytes', renderJson5Value(resourceLimits.terminal.inputQueueMaxBytes));
  if (shouldRender('resourceLimits.terminal.inputQueueTtlMs')) replacements.set('resourceLimits.terminal.inputQueueTtlMs', renderJson5Value(resourceLimits.terminal.inputQueueTtlMs));
  if (shouldRender('resourceLimits.terminal.transportOutboxMaxBytes')) replacements.set('resourceLimits.terminal.transportOutboxMaxBytes', renderJson5Value(resourceLimits.terminal.transportOutboxMaxBytes));
  if (shouldRender('resourceLimits.terminal.transportOutboxTtlMs')) replacements.set('resourceLimits.terminal.transportOutboxTtlMs', renderJson5Value(resourceLimits.terminal.transportOutboxTtlMs));
  if (shouldRender('resourceLimits.terminal.scrollbackLines')) replacements.set('resourceLimits.terminal.scrollbackLines', renderJson5Value(resourceLimits.terminal.scrollbackLines));
  if (shouldRender('resourceLimits.snapshots.perSnapshotMaxChars')) replacements.set('resourceLimits.snapshots.perSnapshotMaxChars', renderJson5Value(resourceLimits.snapshots.perSnapshotMaxChars));
  if (shouldRender('resourceLimits.snapshots.totalStorageBudgetChars')) replacements.set('resourceLimits.snapshots.totalStorageBudgetChars', renderJson5Value(resourceLimits.snapshots.totalStorageBudgetChars));
  if (shouldRender('resourceLimits.snapshots.maxEntries')) replacements.set('resourceLimits.snapshots.maxEntries', renderJson5Value(resourceLimits.snapshots.maxEntries));
  if (shouldRender('resourceLimits.snapshots.tombstoneTtlMs')) replacements.set('resourceLimits.snapshots.tombstoneTtlMs', renderJson5Value(resourceLimits.snapshots.tombstoneTtlMs));
  if (shouldRender('resourceLimits.workspaceRuntime.maxLiveWorkspaces')) replacements.set('resourceLimits.workspaceRuntime.maxLiveWorkspaces', renderJson5Value(resourceLimits.workspaceRuntime.maxLiveWorkspaces));
  if (shouldRender('resourceLimits.workspaceRuntime.maxLiveTerminals')) replacements.set('resourceLimits.workspaceRuntime.maxLiveTerminals', renderJson5Value(resourceLimits.workspaceRuntime.maxLiveTerminals));
  if (shouldRender('resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs')) replacements.set('resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', renderJson5Value(resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs));
  if (shouldRender('resourceLimits.telemetry.sampleIntervalMs')) replacements.set('resourceLimits.telemetry.sampleIntervalMs', renderJson5Value(resourceLimits.telemetry.sampleIntervalMs));
  if (shouldRender('resourceLimits.telemetry.recentEventLimit')) replacements.set('resourceLimits.telemetry.recentEventLimit', renderJson5Value(resourceLimits.telemetry.recentEventLimit));
  if (shouldRender('stabilityModes.headlessQueueMode')) replacements.set('stabilityModes.headlessQueueMode', renderJson5Value(stabilityModes.headlessQueueMode));
  if (shouldRender('stabilityModes.wsSendMode')) replacements.set('stabilityModes.wsSendMode', renderJson5Value(stabilityModes.wsSendMode));
  if (shouldRender('stabilityModes.frontendRuntimeResidency')) replacements.set('stabilityModes.frontendRuntimeResidency', renderJson5Value(stabilityModes.frontendRuntimeResidency));

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
  for (const [path, value] of replacements.entries()) {
    if (!path.startsWith('resourceLimits.') && !path.startsWith('stabilityModes.')) {
      continue;
    }

    const segments = path.split('.');
    insertions.set(path, {
      parentPath: segments.slice(0, -1).join('.'),
      key: segments[segments.length - 1],
      value,
    });
  }
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

  for (const sectionName of RESOURCE_LIMIT_SECTION_NAMES) {
    const sectionPrefix = `resourceLimits.${sectionName}.`;
    const missingSectionReplacements = missingReplacements.filter(
      (path) => path.startsWith(sectionPrefix) && !replaced.has(path),
    );
    if (missingSectionReplacements.length === 0) {
      continue;
    }

    if (insertNestedSection(renderedLines, 'resourceLimits', sectionName, renderResourceLimitSectionBody(sectionName, resourceLimits[sectionName]))) {
      for (const path of missingSectionReplacements) {
        replaced.add(path);
      }
    }
  }

  const missingResourceLimitReplacements = missingReplacements.filter(
    (path) => path.startsWith('resourceLimits.') && !replaced.has(path),
  );
  if (missingResourceLimitReplacements.length > 0 && insertRootSection(renderedLines, 'resourceLimits', renderResourceLimitsRootBody(resourceLimits))) {
    for (const path of missingResourceLimitReplacements) {
      replaced.add(path);
    }
  }

  const missingStabilityModeReplacements = missingReplacements.filter(
    (path) => path.startsWith('stabilityModes.') && !replaced.has(path),
  );
  if (missingStabilityModeReplacements.length > 0 && insertRootSection(renderedLines, 'stabilityModes', renderStabilityModesBody(stabilityModes))) {
    for (const path of missingStabilityModeReplacements) {
      replaced.add(path);
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

function renderResourceLimitsRootBody(resourceLimits: ResourceLimitsConfig): string[] {
  return RESOURCE_LIMIT_SECTION_NAMES.flatMap((sectionName) => [
    `${sectionName}: {`,
    ...renderResourceLimitSectionBody(sectionName, resourceLimits[sectionName]).map((line) => `  ${line}`),
    '},',
  ]);
}

function renderResourceLimitSectionBody(
  sectionName: ResourceLimitSectionName,
  section: ResourceLimitsConfig[ResourceLimitSectionName],
): string[] {
  return Object.entries(section).map(([key, value]) => `${key}: ${renderJson5Value(value)},`);
}

function renderStabilityModesBody(stabilityModes: StabilityModesConfig): string[] {
  return Object.entries(stabilityModes).map(([key, value]) => `${key}: ${renderJson5Value(value)},`);
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

function insertNestedSection(renderedLines: string[], parentPath: string, sectionName: string, bodyLines: string[]): boolean {
  const stack: string[] = [];

  for (let index = 0; index < renderedLines.length; index += 1) {
    const line = renderedLines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('}')) {
      if (stack.join('.') === parentPath) {
        const parentIndent = line.match(/^(\s*)}/)?.[1] ?? '';
        renderedLines.splice(
          index,
          0,
          `${parentIndent}  ${sectionName}: {`,
          ...bodyLines.map((bodyLine) => `${parentIndent}    ${bodyLine}`),
          `${parentIndent}  },`,
        );
        return true;
      }

      const closingCount = (trimmed.match(/}/g) || []).length;
      for (let closeIndex = 0; closeIndex < closingCount; closeIndex += 1) {
        stack.pop();
      }
      continue;
    }

    const objectMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*\{\s*(,?\s*(?:\/\/.*)?)?$/);
    if (objectMatch) {
      stack.push(objectMatch[2]);
    }
  }

  return false;
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
