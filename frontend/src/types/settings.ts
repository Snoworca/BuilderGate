export type FieldApplyScope = 'immediate' | 'new_logins' | 'new_sessions';

export type EditableSettingsKey =
  | 'auth.password'
  | 'auth.durationMs'
  | 'twoFactor.enabled'
  | 'twoFactor.email'
  | 'twoFactor.otpLength'
  | 'twoFactor.otpExpiryMs'
  | 'twoFactor.smtp.host'
  | 'twoFactor.smtp.port'
  | 'twoFactor.smtp.secure'
  | 'twoFactor.smtp.auth.user'
  | 'twoFactor.smtp.auth.password'
  | 'twoFactor.smtp.tls.rejectUnauthorized'
  | 'twoFactor.smtp.tls.minVersion'
  | 'security.cors.allowedOrigins'
  | 'security.cors.credentials'
  | 'security.cors.maxAge'
  | 'pty.termName'
  | 'pty.defaultCols'
  | 'pty.defaultRows'
  | 'pty.useConpty'
  | 'pty.maxBufferSize'
  | 'pty.shell'
  | 'session.idleDelayMs'
  | 'fileManager.maxFileSize'
  | 'fileManager.maxDirectoryEntries'
  | 'fileManager.blockedExtensions'
  | 'fileManager.blockedPaths'
  | 'fileManager.cwdCacheTtlMs';

export interface FieldCapability {
  applyScope: FieldApplyScope;
  available: boolean;
  writeOnly: boolean;
  options?: string[];
  reason?: string;
}

export interface EditableSettingsValues {
  auth: {
    durationMs: number;
  };
  twoFactor: {
    enabled: boolean;
    email: string;
    otpLength: number;
    otpExpiryMs: number;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      auth: {
        user: string;
      };
      tls: {
        rejectUnauthorized: boolean;
        minVersion: 'TLSv1.2' | 'TLSv1.3';
      };
    };
  };
  security: {
    cors: {
      allowedOrigins: string[];
      credentials: boolean;
      maxAge: number;
    };
  };
  pty: {
    termName: string;
    defaultCols: number;
    defaultRows: number;
    useConpty: boolean;
    maxBufferSize: number;
    shell: 'auto' | 'powershell' | 'wsl' | 'bash';
  };
  session: {
    idleDelayMs: number;
  };
  fileManager: {
    maxFileSize: number;
    maxDirectoryEntries: number;
    blockedExtensions: string[];
    blockedPaths: string[];
    cwdCacheTtlMs: number;
  };
}

export interface SettingsSnapshot {
  values: EditableSettingsValues;
  capabilities: Record<EditableSettingsKey, FieldCapability>;
  secretState: {
    authPasswordConfigured: boolean;
    smtpPasswordConfigured: boolean;
  };
  excludedSections: string[];
}

export interface SettingsPatchRequest {
  auth?: {
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
    durationMs?: number;
  };
  twoFactor?: {
    enabled?: boolean;
    email?: string;
    otpLength?: number;
    otpExpiryMs?: number;
    smtp?: {
      host?: string;
      port?: number;
      secure?: boolean;
      auth?: {
        user?: string;
        password?: string;
      };
      tls?: {
        rejectUnauthorized?: boolean;
        minVersion?: 'TLSv1.2' | 'TLSv1.3';
      };
    };
  };
  security?: {
    cors?: {
      allowedOrigins?: string[];
      credentials?: boolean;
      maxAge?: number;
    };
  };
  pty?: {
    termName?: string;
    defaultCols?: number;
    defaultRows?: number;
    useConpty?: boolean;
    maxBufferSize?: number;
    shell?: 'auto' | 'powershell' | 'wsl' | 'bash';
  };
  session?: {
    idleDelayMs?: number;
  };
  fileManager?: {
    maxFileSize?: number;
    maxDirectoryEntries?: number;
    blockedExtensions?: string[];
    blockedPaths?: string[];
    cwdCacheTtlMs?: number;
  };
}

export interface SettingsApplySummary {
  immediate: EditableSettingsKey[];
  new_logins: EditableSettingsKey[];
  new_sessions: EditableSettingsKey[];
  warnings: string[];
}

export interface SettingsSaveResponse extends SettingsSnapshot {
  changedKeys: EditableSettingsKey[];
  applySummary: SettingsApplySummary;
}
