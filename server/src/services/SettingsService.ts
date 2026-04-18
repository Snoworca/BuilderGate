import { z } from 'zod';
import type { Config, FileManagerConfig } from '../types/config.types.js';
import type {
  EditableSettingsKey,
  EditableSettingsSnapshot,
  EditableSettingsValues,
  SettingsApplySummary,
  SettingsPatchRequest,
  SettingsSaveResponse,
} from '../types/settings.types.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';
import { CryptoService } from './CryptoService.js';
import { AuthService } from './AuthService.js';
import { FileService } from './FileService.js';
import { SessionManager } from './SessionManager.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import {
  isWindowsOnlyShell,
  normalizePtyConfigForPlatform,
} from '../utils/ptyPlatformPolicy.js';

const originSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}, 'Invalid origin');

const patchSchema: z.ZodType<SettingsPatchRequest> = z.object({
  auth: z.object({
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(1).optional(),
    confirmPassword: z.string().min(1).optional(),
    durationMs: z.number().min(60000).max(86400000).optional(),
  }).strict().optional(),
  twoFactor: z.object({
    enabled: z.boolean().optional(),
    externalOnly: z.boolean().optional(),
    issuer: z.string().optional(),
    accountName: z.string().optional(),
  }).strict().optional(),
  security: z.object({
    cors: z.object({
      allowedOrigins: z.array(originSchema).optional(),
      credentials: z.boolean().optional(),
      maxAge: z.number().int().min(0).max(86400).optional(),
    }).strict().optional(),
  }).strict().optional(),
  pty: z.object({
    termName: z.string().min(1).optional(),
    defaultCols: z.number().int().min(20).max(500).optional(),
    defaultRows: z.number().int().min(5).max(200).optional(),
    useConpty: z.boolean().optional(),
    windowsPowerShellBackend: z.enum(['inherit', 'conpty', 'winpty']).optional(),
    shell: z.enum(['auto', 'powershell', 'wsl', 'bash', 'zsh', 'sh', 'cmd']).optional(),
  }).strict().optional(),
  session: z.object({
    idleDelayMs: z.number().int().min(50).max(5000).optional(),
  }).strict().optional(),
  fileManager: z.object({
    maxFileSize: z.number().int().min(1024).max(104857600).optional(),
    maxDirectoryEntries: z.number().int().min(100).max(100000).optional(),
    blockedExtensions: z.array(z.string().min(1)).optional(),
    blockedPaths: z.array(z.string().min(1)).optional(),
    cwdCacheTtlMs: z.number().int().min(100).max(60000).optional(),
  }).strict().optional(),
}).strict();

interface SettingsServiceDeps {
  runtimeConfigStore: RuntimeConfigStore;
  configRepository: ConfigFileRepository;
  cryptoService: CryptoService;
  authService: AuthService;
  getFileService: () => FileService;
  sessionManager: SessionManager;
  updateTwoFactorRuntime?: (config: Config, changedKeys: EditableSettingsKey[]) => string[];
}

export interface SaveActorContext {
  origin?: string;
}

export class SettingsService {
  constructor(
    private readonly deps: SettingsServiceDeps,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  getSettingsSnapshot(): EditableSettingsSnapshot {
    const snapshot = this.deps.runtimeConfigStore.getSnapshot();
    const shellField = snapshot.capabilities['pty.shell'];
    if (shellField) {
      const detectedShells = this.deps.sessionManager.getAvailableShells().map((shell) => shell.id);
      shellField.options = dedupe(['auto', ...detectedShells.filter((shell) => shell !== 'auto')]);
      if (!shellField.options.includes(snapshot.values.pty.shell)) {
        snapshot.values.pty.shell = 'auto';
      }
    }

    if (this.platform !== 'win32') {
      return snapshot;
    }

    const winptyCapability = this.deps.sessionManager.getPowerShellWinptyCapability();
    const powerShellBackendField = snapshot.capabilities['pty.windowsPowerShellBackend'];
    const useConptyField = snapshot.capabilities['pty.useConpty'];
    if (powerShellBackendField) {
      if (winptyCapability.checked && !winptyCapability.available) {
        powerShellBackendField.options = ['inherit', 'conpty'];
        powerShellBackendField.reason = winptyCapability.reason ?? 'winpty is unavailable on this host';
        if (useConptyField) {
          useConptyField.reason = winptyCapability.reason ?? 'winpty is unavailable on this host';
        }
      } else if (!winptyCapability.checked) {
        powerShellBackendField.reason = 'winpty availability is verified when selected';
      }
    }

    return snapshot;
  }

  validatePatch(input: unknown): SettingsPatchRequest {
    const result = patchSchema.safeParse(input);
    if (!result.success) {
      const unsupportedPaths = collectUnsupportedPaths(result.error.issues);
      if (unsupportedPaths.length > 0) {
        throw new AppError(
          ErrorCode.UNSUPPORTED_SETTING,
          'Unsupported setting',
          { paths: unsupportedPaths },
        );
      }

      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid settings patch',
        { issues: result.error.issues },
      );
    }

    return result.data;
  }

  savePatch(input: unknown, actorContext: SaveActorContext = {}): SettingsSaveResponse {
    const patch = this.validatePatch(input);
    const changedKeys = extractChangedKeys(patch);
    if (changedKeys.length === 0) {
      return {
        ...this.getSettingsSnapshot(),
        changedKeys: [],
        applySummary: { immediate: [], new_logins: [], new_sessions: [], warnings: [] },
      };
    }

    const mergedValues = normalizeEditableValues(this.deps.runtimeConfigStore.mergeEditablePatch(patch));
    validatePasswordPatch(patch, this.deps.authService);
    validateCorsPatch(mergedValues, actorContext.origin);
    validatePlatformPatch(mergedValues, changedKeys, this.platform);
    validateCapabilityPatch(mergedValues, changedKeys, this.getSettingsSnapshot());
    const secrets = {
      authPassword: patch.auth?.newPassword ? this.deps.cryptoService.encrypt(patch.auth.newPassword) : undefined,
    };

    const persistResult = this.deps.configRepository.persistEditableValues(mergedValues, secrets, { dryRun: true, changedKeys });

    this.applyRuntimeConfig(persistResult.previousConfig, persistResult.nextConfig, changedKeys);

    try {
      this.deps.configRepository.writePreparedResult(persistResult);
    } catch (error) {
      this.applyRuntimeConfig(persistResult.nextConfig, persistResult.previousConfig, changedKeys);
      throw error;
    }

    const runtimeWarnings = this.applyTwoFactorRuntime(persistResult.nextConfig, changedKeys);

    return {
      ...this.getSettingsSnapshot(),
      changedKeys,
      applySummary: buildApplySummary(changedKeys, this.deps.runtimeConfigStore, runtimeWarnings),
    };
  }

  private applyRuntimeConfig(previousConfig: Config, nextConfig: Config, _changedKeys: EditableSettingsKey[]): void {
    const { authService, sessionManager, runtimeConfigStore } = this.deps;
    const fileService = this.deps.getFileService();
    const nextRuntimePty = {
      ...nextConfig.pty,
      ...normalizePtyConfigForPlatform(nextConfig.pty, this.platform),
    };
    const previousRuntimePty = {
      ...previousConfig.pty,
      ...normalizePtyConfigForPlatform(previousConfig.pty, this.platform),
    };

    try {
      runtimeConfigStore.replaceFromConfig(nextConfig);
      authService.updateRuntimeConfig({
        password: nextConfig.auth?.password ?? '',
        durationMs: nextConfig.auth?.durationMs ?? 1800000,
      });
      sessionManager.updateRuntimeConfig({
        idleDelayMs: nextConfig.session.idleDelayMs,
        pty: nextRuntimePty,
      });
      fileService.updateConfig(getFileManagerConfig(nextConfig));
    } catch (error) {
      const rollbackErrors: string[] = [];

      try {
        runtimeConfigStore.replaceFromConfig(previousConfig);
      } catch (rollbackError) {
        rollbackErrors.push(getErrorMessage(rollbackError));
      }

      try {
        authService.updateRuntimeConfig({
          password: previousConfig.auth?.password ?? '',
          durationMs: previousConfig.auth?.durationMs ?? 1800000,
        });
      } catch (rollbackError) {
        rollbackErrors.push(getErrorMessage(rollbackError));
      }

      try {
        sessionManager.updateRuntimeConfig({
          idleDelayMs: previousConfig.session.idleDelayMs,
          pty: previousRuntimePty,
        });
      } catch (rollbackError) {
        rollbackErrors.push(getErrorMessage(rollbackError));
      }

      try {
        fileService.updateConfig(getFileManagerConfig(previousConfig));
      } catch (rollbackError) {
        rollbackErrors.push(getErrorMessage(rollbackError));
      }

      throw new AppError(
        ErrorCode.CONFIG_APPLY_FAILED,
        error instanceof Error ? error.message : 'Failed to apply runtime settings',
        rollbackErrors.length > 0 ? { rollbackErrors } : undefined,
      );
    }
  }

  private applyTwoFactorRuntime(config: Config, changedKeys: EditableSettingsKey[]): string[] {
    if (!this.deps.updateTwoFactorRuntime) {
      return [];
    }

    if (!changedKeys.some((key) => key === 'twoFactor.enabled' || key === 'twoFactor.issuer' || key === 'twoFactor.accountName')) {
      return [];
    }

    try {
      return this.deps.updateTwoFactorRuntime(config, changedKeys);
    } catch (error) {
      console.error('[SettingsService] TOTP runtime refresh failed after save:', error);
      return ['TOTP runtime refresh failed after saving settings. Restart the server or reapply the 2FA settings.'];
    }
  }
}

function extractChangedKeys(patch: SettingsPatchRequest): EditableSettingsKey[] {
  const changed = new Set<EditableSettingsKey>();

  if (patch.auth?.durationMs !== undefined) changed.add('auth.durationMs');
  if (patch.auth?.newPassword) changed.add('auth.password');
  if (patch.twoFactor?.externalOnly !== undefined) changed.add('twoFactor.externalOnly');
  if (patch.twoFactor?.enabled !== undefined) changed.add('twoFactor.enabled');
  if (patch.twoFactor?.issuer !== undefined) changed.add('twoFactor.issuer');
  if (patch.twoFactor?.accountName !== undefined) changed.add('twoFactor.accountName');
  if (patch.security?.cors?.allowedOrigins !== undefined) changed.add('security.cors.allowedOrigins');
  if (patch.security?.cors?.credentials !== undefined) changed.add('security.cors.credentials');
  if (patch.security?.cors?.maxAge !== undefined) changed.add('security.cors.maxAge');
  if (patch.pty?.termName !== undefined) changed.add('pty.termName');
  if (patch.pty?.defaultCols !== undefined) changed.add('pty.defaultCols');
  if (patch.pty?.defaultRows !== undefined) changed.add('pty.defaultRows');
  if (patch.pty?.useConpty !== undefined) changed.add('pty.useConpty');
  if (patch.pty?.windowsPowerShellBackend !== undefined) changed.add('pty.windowsPowerShellBackend');
  if (patch.pty?.shell !== undefined) changed.add('pty.shell');
  if (patch.session?.idleDelayMs !== undefined) changed.add('session.idleDelayMs');
  if (patch.fileManager?.maxFileSize !== undefined) changed.add('fileManager.maxFileSize');
  if (patch.fileManager?.maxDirectoryEntries !== undefined) changed.add('fileManager.maxDirectoryEntries');
  if (patch.fileManager?.blockedExtensions !== undefined) changed.add('fileManager.blockedExtensions');
  if (patch.fileManager?.blockedPaths !== undefined) changed.add('fileManager.blockedPaths');
  if (patch.fileManager?.cwdCacheTtlMs !== undefined) changed.add('fileManager.cwdCacheTtlMs');

  return [...changed];
}

function normalizeEditableValues(values: EditableSettingsValues): EditableSettingsValues {
  return {
    ...values,
    security: {
      cors: {
        ...values.security.cors,
        allowedOrigins: dedupe(values.security.cors.allowedOrigins.map((origin) => origin.trim())),
      },
    },
    pty: {
      ...values.pty,
      termName: values.pty.termName.trim(),
    },
    fileManager: {
      ...values.fileManager,
      blockedExtensions: dedupe(values.fileManager.blockedExtensions.map(normalizeExtension)),
      blockedPaths: dedupe(values.fileManager.blockedPaths.map((entry) => entry.trim())),
    },
  };
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function collectUnsupportedPaths(issues: z.ZodIssue[]): string[] {
  const unsupported = new Set<string>();

  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') {
      continue;
    }

    for (const key of issue.keys) {
      unsupported.add([...issue.path, key].join('.'));
    }
  }

  return [...unsupported];
}

function validatePasswordPatch(patch: SettingsPatchRequest, authService: AuthService): void {
  const authPatch = patch.auth;
  if (!authPatch) {
    return;
  }

  const requestedPasswordChange = Boolean(authPatch.currentPassword || authPatch.newPassword || authPatch.confirmPassword);
  if (!requestedPasswordChange) {
    return;
  }

  if (!authPatch.currentPassword) {
    throw new AppError(ErrorCode.CURRENT_PASSWORD_REQUIRED);
  }

  if (!authPatch.newPassword || !authPatch.confirmPassword) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'New password and confirmation are required');
  }

  if (authPatch.newPassword !== authPatch.confirmPassword) {
    throw new AppError(ErrorCode.PASSWORD_CONFIRM_MISMATCH);
  }

  if (!authService.validatePassword(authPatch.currentPassword)) {
    throw new AppError(ErrorCode.INVALID_CURRENT_PASSWORD);
  }
}

function validateCorsPatch(values: EditableSettingsValues, origin?: string): void {
  const allowedOrigins = values.security.cors.allowedOrigins;
  if (values.security.cors.credentials && allowedOrigins.includes('*')) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Wildcard origins cannot be used with credentials');
  }

  if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
    throw new AppError(ErrorCode.CURRENT_ORIGIN_BLOCKED);
  }

  for (const blockedExtension of values.fileManager.blockedExtensions) {
    if (!blockedExtension.startsWith('.')) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Blocked extensions must begin with a dot');
    }
  }

  for (const blockedPath of values.fileManager.blockedPaths) {
    if (/\s/.test(blockedPath)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Blocked paths cannot contain whitespace');
    }
  }
}

function validatePlatformPatch(
  values: EditableSettingsValues,
  changedKeys: EditableSettingsKey[],
  platform: NodeJS.Platform = process.platform,
): void {
  const normalizedPty = normalizePtyConfigForPlatform(values.pty, platform);

  if (platform !== 'win32' && changedKeys.includes('pty.useConpty') && values.pty.useConpty !== normalizedPty.useConpty) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'ConPTY is only available on Windows');
  }

  if (
    platform !== 'win32'
    && changedKeys.includes('pty.windowsPowerShellBackend')
    && values.pty.windowsPowerShellBackend !== normalizedPty.windowsPowerShellBackend
  ) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'PowerShell backend override is only available on Windows');
  }

  if (platform !== 'win32' && changedKeys.includes('pty.shell') && isWindowsOnlyShell(values.pty.shell)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Selected shell is not supported on this platform');
  }

}

function validateCapabilityPatch(
  values: EditableSettingsValues,
  changedKeys: EditableSettingsKey[],
  snapshot: EditableSettingsSnapshot,
): void {
  if (changedKeys.includes('pty.useConpty') && !snapshot.capabilities['pty.useConpty']?.available) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, snapshot.capabilities['pty.useConpty']?.reason ?? 'Selected PTY backend is unavailable on this host');
  }

  if (changedKeys.includes('pty.useConpty') && values.pty.useConpty === false) {
    const allowedBackends = snapshot.capabilities['pty.windowsPowerShellBackend']?.options ?? [];
    if (!allowedBackends.includes('winpty')) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        snapshot.capabilities['pty.windowsPowerShellBackend']?.reason ?? 'winpty is unavailable on this host',
      );
    }
  }

  if (changedKeys.includes('pty.windowsPowerShellBackend')) {
    const allowed = snapshot.capabilities['pty.windowsPowerShellBackend']?.options ?? [];
    const selectedBackend = values.pty.windowsPowerShellBackend ?? 'inherit';
    if (!allowed.includes(selectedBackend)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        snapshot.capabilities['pty.windowsPowerShellBackend']?.reason ?? 'Selected PowerShell backend is unavailable on this host',
      );
    }
  }

  if (changedKeys.includes('pty.shell')) {
    const allowed = snapshot.capabilities['pty.shell']?.options ?? [];
    if (!allowed.includes(values.pty.shell)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Selected shell is not supported on this host');
    }
  }
}

function buildApplySummary(
  changedKeys: EditableSettingsKey[],
  runtimeConfigStore: RuntimeConfigStore,
  warnings: string[] = [],
): SettingsApplySummary {
  const capabilities = runtimeConfigStore.getFieldCapabilities();
  const summary: SettingsApplySummary = {
    immediate: [],
    new_logins: [],
    new_sessions: [],
    warnings: [...warnings],
  };

  for (const key of changedKeys) {
    const capability = capabilities[key];
    if (!capability?.available) {
      continue;
    }
    summary[capability.applyScope].push(key);
  }

  return summary;
}

function getFileManagerConfig(config: Config): FileManagerConfig {
  return {
    maxFileSize: config.fileManager?.maxFileSize ?? 1048576,
    maxCodeFileSize: config.fileManager?.maxCodeFileSize ?? 524288,
    maxDirectoryEntries: config.fileManager?.maxDirectoryEntries ?? 10000,
    blockedExtensions: [...(config.fileManager?.blockedExtensions ?? ['.exe', '.dll', '.so', '.bin'])],
    blockedPaths: [...(config.fileManager?.blockedPaths ?? ['.ssh', '.gnupg', '.aws'])],
    cwdCacheTtlMs: config.fileManager?.cwdCacheTtlMs ?? 1000,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
