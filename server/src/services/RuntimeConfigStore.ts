import type { Config } from '../types/config.types.js';
import type {
  EditableSettingsKey,
  EditableSettingsSnapshot,
  EditableSettingsValues,
  FieldCapability,
  SettingsPatchRequest,
} from '../types/settings.types.js';
import { authSchema, corsSchema, fileManagerSchema, ptySchema, sessionSchema, twoFactorSchema } from '../schemas/config.schema.js';
import { config as globalConfig } from '../utils/config.js';

const EXCLUDED_SECTIONS = [
  'server.port',
  'ssl.*',
  'logging.*',
  'auth.maxDurationMs',
  'auth.jwtSecret',
  'fileManager.maxCodeFileSize',
  'bruteForce.*',
] as const;

const FIELD_SCOPES: Record<EditableSettingsKey, Omit<FieldCapability, 'available' | 'reason' | 'options'>> = {
  'auth.password': { applyScope: 'new_logins', writeOnly: true },
  'auth.durationMs': { applyScope: 'new_logins', writeOnly: false },
  'twoFactor.externalOnly': { applyScope: 'new_logins', writeOnly: false },
  'twoFactor.enabled': { applyScope: 'new_logins', writeOnly: false },
  'twoFactor.issuer': { applyScope: 'new_logins', writeOnly: false },
  'twoFactor.accountName': { applyScope: 'new_logins', writeOnly: false },
  'security.cors.allowedOrigins': { applyScope: 'immediate', writeOnly: false },
  'security.cors.credentials': { applyScope: 'immediate', writeOnly: false },
  'security.cors.maxAge': { applyScope: 'immediate', writeOnly: false },
  'pty.termName': { applyScope: 'new_sessions', writeOnly: false },
  'pty.defaultCols': { applyScope: 'new_sessions', writeOnly: false },
  'pty.defaultRows': { applyScope: 'new_sessions', writeOnly: false },
  'pty.useConpty': { applyScope: 'new_sessions', writeOnly: false },
  'pty.maxBufferSize': { applyScope: 'immediate', writeOnly: false },
  'pty.shell': { applyScope: 'new_sessions', writeOnly: false },
  'session.idleDelayMs': { applyScope: 'immediate', writeOnly: false },
  'fileManager.maxFileSize': { applyScope: 'immediate', writeOnly: false },
  'fileManager.maxDirectoryEntries': { applyScope: 'immediate', writeOnly: false },
  'fileManager.blockedExtensions': { applyScope: 'immediate', writeOnly: false },
  'fileManager.blockedPaths': { applyScope: 'immediate', writeOnly: false },
  'fileManager.cwdCacheTtlMs': { applyScope: 'immediate', writeOnly: false },
};

export class RuntimeConfigStore {
  private values: EditableSettingsValues;
  private readonly capabilities: Record<EditableSettingsKey, FieldCapability>;
  private readonly excludedSections = [...EXCLUDED_SECTIONS];
  private secretState: EditableSettingsSnapshot['secretState'];

  constructor(source: Config = globalConfig, private readonly platform: NodeJS.Platform = process.platform) {
    this.values = buildEditableValues(source);
    this.capabilities = buildFieldCapabilities(platform);
    this.secretState = {
      authPasswordConfigured: Boolean(source.auth?.password),
      smtpPasswordConfigured: false,
    };
  }

  getSnapshot(): EditableSettingsSnapshot {
    return {
      values: this.getEditableValues(),
      capabilities: this.getFieldCapabilities(),
      secretState: structuredClone(this.secretState),
      excludedSections: [...this.excludedSections],
    };
  }

  getEditableValues(): EditableSettingsValues {
    return structuredClone(this.values);
  }

  getFieldCapabilities(): Record<EditableSettingsKey, FieldCapability> {
    return structuredClone(this.capabilities);
  }

  isEditable(path: string): path is EditableSettingsKey {
    return path in this.capabilities;
  }

  mergeEditablePatch(patch: SettingsPatchRequest): EditableSettingsValues {
    const next = this.getEditableValues();

    if (patch.auth?.durationMs !== undefined) {
      next.auth.durationMs = patch.auth.durationMs;
    }

    if (patch.twoFactor?.externalOnly !== undefined) {
      next.twoFactor.externalOnly = patch.twoFactor.externalOnly;
    }
    if (patch.twoFactor?.enabled !== undefined) {
      next.twoFactor.enabled = patch.twoFactor.enabled;
    }
    if (patch.twoFactor?.issuer !== undefined) {
      next.twoFactor.issuer = patch.twoFactor.issuer;
    }
    if (patch.twoFactor?.accountName !== undefined) {
      next.twoFactor.accountName = patch.twoFactor.accountName;
    }

    if (patch.security?.cors?.allowedOrigins !== undefined) {
      next.security.cors.allowedOrigins = [...patch.security.cors.allowedOrigins];
    }
    if (patch.security?.cors?.credentials !== undefined) {
      next.security.cors.credentials = patch.security.cors.credentials;
    }
    if (patch.security?.cors?.maxAge !== undefined) {
      next.security.cors.maxAge = patch.security.cors.maxAge;
    }

    if (patch.pty?.termName !== undefined) {
      next.pty.termName = patch.pty.termName;
    }
    if (patch.pty?.defaultCols !== undefined) {
      next.pty.defaultCols = patch.pty.defaultCols;
    }
    if (patch.pty?.defaultRows !== undefined) {
      next.pty.defaultRows = patch.pty.defaultRows;
    }
    if (patch.pty?.useConpty !== undefined) {
      next.pty.useConpty = patch.pty.useConpty;
    }
    if (patch.pty?.maxBufferSize !== undefined) {
      next.pty.maxBufferSize = patch.pty.maxBufferSize;
    }
    if (patch.pty?.shell !== undefined) {
      next.pty.shell = patch.pty.shell;
    }

    if (patch.session?.idleDelayMs !== undefined) {
      next.session.idleDelayMs = patch.session.idleDelayMs;
    }

    if (patch.fileManager?.maxFileSize !== undefined) {
      next.fileManager.maxFileSize = patch.fileManager.maxFileSize;
    }
    if (patch.fileManager?.maxDirectoryEntries !== undefined) {
      next.fileManager.maxDirectoryEntries = patch.fileManager.maxDirectoryEntries;
    }
    if (patch.fileManager?.blockedExtensions !== undefined) {
      next.fileManager.blockedExtensions = [...patch.fileManager.blockedExtensions];
    }
    if (patch.fileManager?.blockedPaths !== undefined) {
      next.fileManager.blockedPaths = [...patch.fileManager.blockedPaths];
    }
    if (patch.fileManager?.cwdCacheTtlMs !== undefined) {
      next.fileManager.cwdCacheTtlMs = patch.fileManager.cwdCacheTtlMs;
    }

    return next;
  }

  replaceValues(next: EditableSettingsValues): void {
    this.values = structuredClone(next);
  }

  replaceFromConfig(config: Config): void {
    this.values = buildEditableValues(config);
    this.secretState = {
      authPasswordConfigured: Boolean(config.auth?.password),
      smtpPasswordConfigured: false,
    };
  }
}

function buildEditableValues(source: Config): EditableSettingsValues {
  const authDefaults = authSchema.parse({});
  const ptyDefaults = ptySchema.parse({});
  const sessionDefaults = sessionSchema.parse({});
  const twoFactorDefaults = twoFactorSchema.parse({});
  const corsDefaults = corsSchema.parse({});
  const fileManagerDefaults = fileManagerSchema.parse({});

  return {
    auth: {
      durationMs: source.auth?.durationMs ?? authDefaults.durationMs,
    },
    twoFactor: {
      enabled: source.twoFactor?.enabled ?? twoFactorDefaults.enabled,
      externalOnly: source.twoFactor?.externalOnly ?? twoFactorDefaults.externalOnly,
      issuer: source.twoFactor?.issuer ?? twoFactorDefaults.issuer,
      accountName: source.twoFactor?.accountName ?? twoFactorDefaults.accountName,
    },
    security: {
      cors: {
        allowedOrigins: source.security?.cors.allowedOrigins ?? corsDefaults.allowedOrigins,
        credentials: source.security?.cors.credentials ?? corsDefaults.credentials,
        maxAge: source.security?.cors.maxAge ?? corsDefaults.maxAge,
      },
    },
    pty: {
      termName: source.pty.termName ?? ptyDefaults.termName,
      defaultCols: source.pty.defaultCols ?? ptyDefaults.defaultCols,
      defaultRows: source.pty.defaultRows ?? ptyDefaults.defaultRows,
      useConpty: source.pty.useConpty ?? ptyDefaults.useConpty,
      maxBufferSize: source.pty.maxBufferSize ?? ptyDefaults.maxBufferSize,
      shell: source.pty.shell ?? ptyDefaults.shell,
    },
    session: {
      idleDelayMs: source.session.idleDelayMs ?? sessionDefaults.idleDelayMs,
    },
    fileManager: {
      maxFileSize: source.fileManager?.maxFileSize ?? fileManagerDefaults.maxFileSize,
      maxDirectoryEntries: source.fileManager?.maxDirectoryEntries ?? fileManagerDefaults.maxDirectoryEntries,
      blockedExtensions: source.fileManager?.blockedExtensions ?? fileManagerDefaults.blockedExtensions,
      blockedPaths: source.fileManager?.blockedPaths ?? fileManagerDefaults.blockedPaths,
      cwdCacheTtlMs: source.fileManager?.cwdCacheTtlMs ?? fileManagerDefaults.cwdCacheTtlMs,
    },
  };
}

function buildFieldCapabilities(platform: NodeJS.Platform): Record<EditableSettingsKey, FieldCapability> {
  const capabilities = {} as Record<EditableSettingsKey, FieldCapability>;

  for (const [key, capability] of Object.entries(FIELD_SCOPES) as Array<[EditableSettingsKey, typeof FIELD_SCOPES[EditableSettingsKey]]>) {
    capabilities[key] = {
      ...capability,
      available: true,
    };
  }

  capabilities['pty.useConpty'] = {
    ...capabilities['pty.useConpty'],
    available: platform === 'win32',
    reason: platform === 'win32' ? undefined : 'Windows-only PTY backend',
  };

  capabilities['pty.shell'] = {
    ...capabilities['pty.shell'],
    options: platform === 'win32'
      ? ['auto', 'powershell', 'wsl', 'bash']
      : ['auto', 'bash'],
  };

  return capabilities;
}
