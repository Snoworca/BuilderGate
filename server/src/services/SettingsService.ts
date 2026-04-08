import { z } from 'zod';
import type { AuthConfig, Config, FileManagerConfig, TwoFactorConfig } from '../types/config.types.js';
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
import { TwoFactorService } from './TwoFactorService.js';
import { SessionManager } from './SessionManager.js';
import { AppError, ErrorCode } from '../utils/errors.js';

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
    externalOnly: z.boolean().optional(),
    email: z.object({
      enabled: z.boolean().optional(),
      address: z.string().email().optional(),
      otpLength: z.number().int().min(4).max(8).optional(),
      otpExpiryMs: z.number().int().min(60000).max(600000).optional(),
      smtp: z.object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        secure: z.boolean().optional(),
        auth: z.object({
          user: z.string().min(1).optional(),
          password: z.string().min(1).optional(),
        }).strict().optional(),
        tls: z.object({
          rejectUnauthorized: z.boolean().optional(),
          minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).optional(),
        }).strict().optional(),
      }).strict().optional(),
    }).strict().optional(),
    totp: z.object({
      enabled: z.boolean().optional(),
      issuer: z.string().optional(),
      accountName: z.string().optional(),
    }).strict().optional(),
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
    maxBufferSize: z.number().int().min(1024).max(10485760).optional(),
    shell: z.enum(['auto', 'powershell', 'wsl', 'bash']).optional(),
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
  getTwoFactorService: () => TwoFactorService | undefined;
  setTwoFactorService: (service: TwoFactorService | undefined) => void;
  getFileService: () => FileService;
  sessionManager: SessionManager;
}

export interface SaveActorContext {
  origin?: string;
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  getSettingsSnapshot(): EditableSettingsSnapshot {
    return this.deps.runtimeConfigStore.getSnapshot();
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
    validatePlatformPatch(mergedValues);
    validateTwoFactorSecretState(
      mergedValues,
      this.deps.runtimeConfigStore.getSnapshot().secretState.smtpPasswordConfigured || Boolean(patch.twoFactor?.email?.smtp?.auth?.password),
    );

    const secrets = {
      authPassword: patch.auth?.newPassword ? this.deps.cryptoService.encrypt(patch.auth.newPassword) : undefined,
      smtpPassword: patch.twoFactor?.email?.smtp?.auth?.password
        ? this.deps.cryptoService.encrypt(patch.twoFactor.email.smtp.auth.password)
        : undefined,
    };

    const persistResult = this.deps.configRepository.persistEditableValues(mergedValues, secrets, { dryRun: true });

    this.applyRuntimeConfig(persistResult.previousConfig, persistResult.nextConfig, changedKeys);

    try {
      this.deps.configRepository.writePreparedResult(persistResult);
    } catch (error) {
      this.applyRuntimeConfig(persistResult.nextConfig, persistResult.previousConfig, changedKeys);
      throw error;
    }

    return {
      ...this.getSettingsSnapshot(),
      changedKeys,
      applySummary: buildApplySummary(changedKeys, this.deps.runtimeConfigStore),
    };
  }

  private applyRuntimeConfig(previousConfig: Config, nextConfig: Config, changedKeys: EditableSettingsKey[]): void {
    const { authService, sessionManager, runtimeConfigStore } = this.deps;
    const fileService = this.deps.getFileService();
    const previousTwoFactorService = this.deps.getTwoFactorService();
    let replacementTwoFactorService = previousTwoFactorService;

    try {
      if (changedKeys.some((key) => key.startsWith('twoFactor.'))) {
        const anyEnabled = nextConfig.twoFactor?.email?.enabled || nextConfig.twoFactor?.totp?.enabled;
        if (anyEnabled && nextConfig.twoFactor) {
          replacementTwoFactorService = new TwoFactorService(nextConfig.twoFactor, this.deps.cryptoService);
        } else {
          replacementTwoFactorService = undefined;
        }
      }

      runtimeConfigStore.replaceFromConfig(nextConfig);
      authService.updateRuntimeConfig({
        password: nextConfig.auth?.password ?? '',
        durationMs: nextConfig.auth?.durationMs ?? 1800000,
      });
      sessionManager.updateRuntimeConfig({
        idleDelayMs: nextConfig.session.idleDelayMs,
        pty: nextConfig.pty,
      });
      fileService.updateConfig(getFileManagerConfig(nextConfig));

      if (replacementTwoFactorService !== previousTwoFactorService) {
        previousTwoFactorService?.destroy();
        this.deps.setTwoFactorService(replacementTwoFactorService);
      }
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
          pty: previousConfig.pty,
        });
      } catch (rollbackError) {
        rollbackErrors.push(getErrorMessage(rollbackError));
      }

      try {
        fileService.updateConfig(getFileManagerConfig(previousConfig));
      } catch (rollbackError) {
        rollbackErrors.push(getErrorMessage(rollbackError));
      }

      if (replacementTwoFactorService && replacementTwoFactorService !== previousTwoFactorService) {
        try {
          replacementTwoFactorService.destroy();
        } catch (rollbackError) {
          rollbackErrors.push(getErrorMessage(rollbackError));
        }
      }

      try {
        this.deps.setTwoFactorService(previousTwoFactorService);
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
}

function extractChangedKeys(patch: SettingsPatchRequest): EditableSettingsKey[] {
  const changed = new Set<EditableSettingsKey>();

  if (patch.auth?.durationMs !== undefined) changed.add('auth.durationMs');
  if (patch.auth?.newPassword) changed.add('auth.password');
  if (patch.twoFactor?.externalOnly !== undefined) changed.add('twoFactor.externalOnly');
  if (patch.twoFactor?.email?.enabled !== undefined) changed.add('twoFactor.email.enabled');
  if (patch.twoFactor?.email?.address !== undefined) changed.add('twoFactor.email.address');
  if (patch.twoFactor?.email?.otpLength !== undefined) changed.add('twoFactor.email.otpLength');
  if (patch.twoFactor?.email?.otpExpiryMs !== undefined) changed.add('twoFactor.email.otpExpiryMs');
  if (patch.twoFactor?.email?.smtp?.host !== undefined) changed.add('twoFactor.email.smtp.host');
  if (patch.twoFactor?.email?.smtp?.port !== undefined) changed.add('twoFactor.email.smtp.port');
  if (patch.twoFactor?.email?.smtp?.secure !== undefined) changed.add('twoFactor.email.smtp.secure');
  if (patch.twoFactor?.email?.smtp?.auth?.user !== undefined) changed.add('twoFactor.email.smtp.auth.user');
  if (patch.twoFactor?.email?.smtp?.auth?.password !== undefined) changed.add('twoFactor.email.smtp.auth.password');
  if (patch.twoFactor?.email?.smtp?.tls?.rejectUnauthorized !== undefined) changed.add('twoFactor.email.smtp.tls.rejectUnauthorized');
  if (patch.twoFactor?.email?.smtp?.tls?.minVersion !== undefined) changed.add('twoFactor.email.smtp.tls.minVersion');
  if (patch.twoFactor?.totp?.enabled !== undefined) changed.add('twoFactor.totp.enabled');
  if (patch.twoFactor?.totp?.issuer !== undefined) changed.add('twoFactor.totp.issuer');
  if (patch.twoFactor?.totp?.accountName !== undefined) changed.add('twoFactor.totp.accountName');
  if (patch.security?.cors?.allowedOrigins !== undefined) changed.add('security.cors.allowedOrigins');
  if (patch.security?.cors?.credentials !== undefined) changed.add('security.cors.credentials');
  if (patch.security?.cors?.maxAge !== undefined) changed.add('security.cors.maxAge');
  if (patch.pty?.termName !== undefined) changed.add('pty.termName');
  if (patch.pty?.defaultCols !== undefined) changed.add('pty.defaultCols');
  if (patch.pty?.defaultRows !== undefined) changed.add('pty.defaultRows');
  if (patch.pty?.useConpty !== undefined) changed.add('pty.useConpty');
  if (patch.pty?.maxBufferSize !== undefined) changed.add('pty.maxBufferSize');
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
    twoFactor: {
      ...values.twoFactor,
      email: {
        ...values.twoFactor.email,
        address: values.twoFactor.email.address.trim(),
        smtp: {
          ...values.twoFactor.email.smtp,
          host: values.twoFactor.email.smtp.host.trim(),
          auth: {
            user: values.twoFactor.email.smtp.auth.user.trim(),
          },
        },
      },
    },
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

function validatePlatformPatch(values: EditableSettingsValues): void {
  if (process.platform !== 'win32' && values.pty.useConpty) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'ConPTY is only available on Windows');
  }

  if (process.platform !== 'win32' && (values.pty.shell === 'powershell' || values.pty.shell === 'wsl')) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Selected shell is not supported on this platform');
  }

  if (values.twoFactor.email.enabled) {
    if (!values.twoFactor.email.address || !values.twoFactor.email.smtp.host || !values.twoFactor.email.smtp.auth.user) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '2FA email requires address and SMTP settings');
    }
  }
}

function validateTwoFactorSecretState(values: EditableSettingsValues, hasSmtpPassword: boolean): void {
  if (values.twoFactor.email.enabled && !hasSmtpPassword) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, '2FA email requires an SMTP password');
  }
}

function buildApplySummary(changedKeys: EditableSettingsKey[], runtimeConfigStore: RuntimeConfigStore): SettingsApplySummary {
  const capabilities = runtimeConfigStore.getFieldCapabilities();
  const summary: SettingsApplySummary = {
    immediate: [],
    new_logins: [],
    new_sessions: [],
    warnings: [],
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
