import type {
  CORSConfig,
  PTYConfig,
  ResourceLimitsConfig,
  SessionConfig,
  StabilityModesConfig,
} from './config.types.js';

export type FieldApplyScope = 'immediate' | 'new_logins' | 'new_sessions';

export type EditableSettingsKey =
  | 'auth.password'
  | 'auth.durationMs'
  | 'twoFactor.externalOnly'
  | 'twoFactor.enabled'
  | 'twoFactor.issuer'
  | 'twoFactor.accountName'
  | 'security.cors.allowedOrigins'
  | 'security.cors.credentials'
  | 'security.cors.maxAge'
  | 'pty.termName'
  | 'pty.defaultCols'
  | 'pty.defaultRows'
  | 'pty.useConpty'
  | 'pty.windowsPowerShellBackend'
  | 'pty.shell'
  | 'session.idleDelayMs'
  | 'fileManager.maxFileSize'
  | 'fileManager.maxDirectoryEntries'
  | 'fileManager.blockedExtensions'
  | 'fileManager.blockedPaths'
  | 'fileManager.cwdCacheTtlMs'
  | 'resourceLimits.headless.pendingOutputMaxBytes'
  | 'resourceLimits.headless.pendingOutputMaxChunks'
  | 'resourceLimits.headless.writeLagWarnMs'
  | 'resourceLimits.headless.writeBatchMaxBytes'
  | 'resourceLimits.headless.overflowPolicy'
  | 'resourceLimits.ws.serverBufferedHighWaterBytes'
  | 'resourceLimits.ws.serverBufferedHardLimitBytes'
  | 'resourceLimits.ws.perClientOutputQueueMaxBytes'
  | 'resourceLimits.ws.perClientControlQueueMaxBytes'
  | 'resourceLimits.ws.outputCoalesceWindowMs'
  | 'resourceLimits.clientWs.inputBackpressureBytes'
  | 'resourceLimits.clientWs.hardReconnectBytes'
  | 'resourceLimits.terminal.visibleOutputQueueMaxBytes'
  | 'resourceLimits.terminal.visibleOutputMaxChunks'
  | 'resourceLimits.terminal.visibleFlushBudgetBytes'
  | 'resourceLimits.terminal.hiddenOutputPolicy'
  | 'resourceLimits.terminal.hiddenOutputTailBytes'
  | 'resourceLimits.terminal.inputQueueMaxBytes'
  | 'resourceLimits.terminal.inputQueueTtlMs'
  | 'resourceLimits.terminal.transportOutboxMaxBytes'
  | 'resourceLimits.terminal.transportOutboxTtlMs'
  | 'resourceLimits.terminal.scrollbackLines'
  | 'resourceLimits.snapshots.perSnapshotMaxChars'
  | 'resourceLimits.snapshots.totalStorageBudgetChars'
  | 'resourceLimits.snapshots.maxEntries'
  | 'resourceLimits.snapshots.tombstoneTtlMs'
  | 'resourceLimits.workspaceRuntime.maxLiveWorkspaces'
  | 'resourceLimits.workspaceRuntime.maxLiveTerminals'
  | 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs'
  | 'resourceLimits.telemetry.sampleIntervalMs'
  | 'resourceLimits.telemetry.recentEventLimit'
  | 'stabilityModes.headlessQueueMode'
  | 'stabilityModes.wsSendMode'
  | 'stabilityModes.frontendRuntimeResidency';

export interface FieldCapabilityConstraints {
  min?: number;
  max?: number;
  step?: number;
  unit?: 'bytes' | 'ms' | 'count' | 'chars';
}

export interface FieldCapability {
  applyScope: FieldApplyScope;
  available: boolean;
  writeOnly: boolean;
  options?: string[];
  reason?: string;
  constraints?: FieldCapabilityConstraints;
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
  enabled: boolean;
  externalOnly: boolean;
  issuer: string;
  accountName: string;
}

export interface SecurityEditableSettings {
  cors: CORSConfig;
}

export type EditablePtySettings = Pick<
  PTYConfig,
  'termName' | 'defaultCols' | 'defaultRows' | 'useConpty' | 'windowsPowerShellBackend' | 'shell'
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
  resourceLimits: ResourceLimitsConfig;
  stabilityModes: StabilityModesConfig;
}

export type ResourceLimitsPatch = {
  [Section in keyof ResourceLimitsConfig]?: Partial<ResourceLimitsConfig[Section]>;
};

export interface SettingsPatchRequest {
  auth?: Partial<AuthEditableSettings> & PasswordChangeRequest;
  twoFactor?: {
    enabled?: boolean;
    externalOnly?: boolean;
    issuer?: string;
    accountName?: string;
  };
  security?: {
    cors?: Partial<SecurityEditableSettings['cors']>;
  };
  pty?: Partial<EditablePtySettings>;
  session?: Partial<EditableSessionSettings>;
  fileManager?: Partial<EditableFileManagerSettings>;
  resourceLimits?: ResourceLimitsPatch;
  stabilityModes?: Partial<StabilityModesConfig>;
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
