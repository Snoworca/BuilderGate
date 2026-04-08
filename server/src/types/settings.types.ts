import type {
  CORSConfig,
  PTYConfig,
  SessionConfig,
  SMTPTLSConfig,
} from './config.types.js';

export type FieldApplyScope = 'immediate' | 'new_logins' | 'new_sessions';

export type EditableSettingsKey =
  | 'auth.password'
  | 'auth.durationMs'
  | 'twoFactor.externalOnly'
  | 'twoFactor.email.enabled'
  | 'twoFactor.email.address'
  | 'twoFactor.email.otpLength'
  | 'twoFactor.email.otpExpiryMs'
  | 'twoFactor.email.smtp.host'
  | 'twoFactor.email.smtp.port'
  | 'twoFactor.email.smtp.secure'
  | 'twoFactor.email.smtp.auth.user'
  | 'twoFactor.email.smtp.auth.password'
  | 'twoFactor.email.smtp.tls.rejectUnauthorized'
  | 'twoFactor.email.smtp.tls.minVersion'
  | 'twoFactor.totp.enabled'
  | 'twoFactor.totp.issuer'
  | 'twoFactor.totp.accountName'
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

export interface AuthEditableSettings {
  durationMs: number;
}

export interface PasswordChangeRequest {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

export interface TwoFactorEditableSettings {
  externalOnly: boolean;
  email: {
    enabled: boolean;
    address: string;
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
        minVersion: SMTPTLSConfig['minVersion'];
      };
    };
  };
  totp: {
    enabled: boolean;
    issuer: string;
    accountName: string;
  };
}

export interface SecurityEditableSettings {
  cors: CORSConfig;
}

export type EditablePtySettings = Pick<
  PTYConfig,
  'termName' | 'defaultCols' | 'defaultRows' | 'useConpty' | 'maxBufferSize' | 'shell'
>;

export type EditableSessionSettings = Pick<SessionConfig, 'idleDelayMs'>;

export interface EditableFileManagerSettings {
  maxFileSize: number;
  maxDirectoryEntries: number;
  blockedExtensions: string[];
  blockedPaths: string[];
  cwdCacheTtlMs: number;
}

export interface EditableSettingsValues {
  auth: AuthEditableSettings;
  twoFactor: TwoFactorEditableSettings;
  security: SecurityEditableSettings;
  pty: EditablePtySettings;
  session: EditableSessionSettings;
  fileManager: EditableFileManagerSettings;
}

export interface SettingsPatchRequest {
  auth?: Partial<AuthEditableSettings> & PasswordChangeRequest;
  twoFactor?: {
    externalOnly?: boolean;
    email?: Partial<
      Omit<TwoFactorEditableSettings['email'], 'smtp'> & {
        smtp?: Partial<
          Omit<TwoFactorEditableSettings['email']['smtp'], 'auth' | 'tls'> & {
            auth?: { user?: string; password?: string };
            tls?: Partial<TwoFactorEditableSettings['email']['smtp']['tls']>;
          }
        >;
      }
    >;
    totp?: Partial<TwoFactorEditableSettings['totp']>;
  };
  security?: {
    cors?: Partial<SecurityEditableSettings['cors']>;
  };
  pty?: Partial<EditablePtySettings>;
  session?: Partial<EditableSessionSettings>;
  fileManager?: Partial<EditableFileManagerSettings>;
}

export interface SecretFieldState {
  authPasswordConfigured: boolean;
  smtpPasswordConfigured: boolean;
}

export interface EditableSettingsSnapshot {
  values: EditableSettingsValues;
  capabilities: Record<EditableSettingsKey, FieldCapability>;
  secretState: SecretFieldState;
  excludedSections: string[];
}

export interface SettingsApplySummary {
  immediate: EditableSettingsKey[];
  new_logins: EditableSettingsKey[];
  new_sessions: EditableSettingsKey[];
  warnings: string[];
}

export interface SettingsSaveResponse extends EditableSettingsSnapshot {
  changedKeys: EditableSettingsKey[];
  applySummary: SettingsApplySummary;
}
