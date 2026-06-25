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

export interface ResourceLimitsSettings {
  headless: {
    pendingOutputMaxBytes: number;
    pendingOutputMaxChunks: number;
    writeLagWarnMs: number;
    writeBatchMaxBytes: number;
    overflowPolicy: 'degrade-headless';
  };
  ws: {
    serverBufferedHighWaterBytes: number;
    serverBufferedHardLimitBytes: number;
    perClientOutputQueueMaxBytes: number;
    perClientControlQueueMaxBytes: number;
    outputCoalesceWindowMs: number;
  };
  clientWs: {
    inputBackpressureBytes: number;
    hardReconnectBytes: number;
  };
  terminal: {
    visibleOutputQueueMaxBytes: number;
    visibleOutputMaxChunks: number;
    visibleFlushBudgetBytes: number;
    hiddenOutputPolicy: 'snapshot-restore' | 'debug-tail';
    hiddenOutputTailBytes: number;
    inputQueueMaxBytes: number;
    inputQueueTtlMs: number;
    transportOutboxMaxBytes: number;
    transportOutboxTtlMs: number;
    scrollbackLines: number;
  };
  snapshots: {
    perSnapshotMaxChars: number;
    totalStorageBudgetChars: number;
    maxEntries: number;
    tombstoneTtlMs: number;
  };
  workspaceRuntime: {
    maxLiveWorkspaces: number;
    maxLiveTerminals: number;
    hiddenRuntimeTtlMs: number;
  };
  telemetry: {
    sampleIntervalMs: number;
    recentEventLimit: number;
  };
}

export interface StabilityModesSettings {
  headlessQueueMode: 'observe' | 'bounded';
  wsSendMode: 'direct' | 'safe-send-observe' | 'safe-send-enforce';
  frontendRuntimeResidency: 'legacy' | 'bounded' | 'off';
}

export interface EditableSettingsValues {
  auth: {
    durationMs: number;
  };
  twoFactor: {
    enabled: boolean;
    externalOnly: boolean;
    issuer: string;
    accountName: string;
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
    windowsPowerShellBackend: 'inherit' | 'conpty' | 'winpty';
    shell: 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';
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
  resourceLimits: ResourceLimitsSettings;
  stabilityModes: StabilityModesSettings;
}

export type ResourceLimitsPatch = {
  [Section in keyof ResourceLimitsSettings]?: Partial<ResourceLimitsSettings[Section]>;
};

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
    externalOnly?: boolean;
    issuer?: string;
    accountName?: string;
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
    windowsPowerShellBackend?: 'inherit' | 'conpty' | 'winpty';
    shell?: 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';
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
  resourceLimits?: ResourceLimitsPatch;
  stabilityModes?: Partial<StabilityModesSettings>;
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
