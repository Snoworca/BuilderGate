import type {
  Config,
  ResourceLimitsConfig,
  StabilityModesConfig,
  WsTransportMode,
} from '../types/config.types.js';
import type { InputReliabilityMode } from '../types/ws-protocol.js';
import type {
  EditableSettingsKey,
  EditableSettingsSnapshot,
  EditableSettingsValues,
  FieldCapability,
  ResourceLimitsPatch,
  SettingsPatchRequest,
} from '../types/settings.types.js';
import {
  authSchema,
  corsSchema,
  fileManagerSchema,
  ptySchema,
  resourceLimitsSchema,
  sessionSchema,
  stabilityModesSchema,
  twoFactorSchema,
} from '../schemas/config.schema.js';
import { config as globalConfig } from '../utils/config.js';
import {
  getSettingsShellOptions,
  normalizePtyConfigForPlatform,
} from '../utils/ptyPlatformPolicy.js';

const EXCLUDED_SECTIONS = [
  'server.port',
  'ssl.*',
  'logging.*',
  'auth.maxDurationMs',
  'auth.jwtSecret',
  'fileManager.maxCodeFileSize',
  'bruteForce.*',
] as const;

const bytes = (min: number, max: number): FieldCapability['constraints'] => ({ min, max, step: 1, unit: 'bytes' });
const count = (min: number, max: number): FieldCapability['constraints'] => ({ min, max, step: 1, unit: 'count' });
const chars = (min: number, max: number): FieldCapability['constraints'] => ({ min, max, step: 1, unit: 'chars' });
const ms = (min: number, max: number): FieldCapability['constraints'] => ({ min, max, step: 1, unit: 'ms' });

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
  'pty.windowsPowerShellBackend': { applyScope: 'new_sessions', writeOnly: false },
  'pty.shell': { applyScope: 'new_sessions', writeOnly: false },
  'session.idleDelayMs': { applyScope: 'immediate', writeOnly: false },
  'fileManager.maxFileSize': { applyScope: 'immediate', writeOnly: false },
  'fileManager.maxDirectoryEntries': { applyScope: 'immediate', writeOnly: false },
  'fileManager.blockedExtensions': { applyScope: 'immediate', writeOnly: false },
  'fileManager.blockedPaths': { applyScope: 'immediate', writeOnly: false },
  'fileManager.cwdCacheTtlMs': { applyScope: 'immediate', writeOnly: false },
  'resourceLimits.headless.pendingOutputMaxBytes': { applyScope: 'new_sessions', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.headless.pendingOutputMaxChunks': { applyScope: 'new_sessions', writeOnly: false, constraints: count(1, 65536) },
  'resourceLimits.headless.writeLagWarnMs': { applyScope: 'new_sessions', writeOnly: false, constraints: ms(1, 60000) },
  'resourceLimits.headless.writeBatchMaxBytes': { applyScope: 'new_sessions', writeOnly: false, constraints: bytes(1024, 1048576) },
  'resourceLimits.headless.overflowPolicy': { applyScope: 'new_sessions', writeOnly: false },
  'resourceLimits.ws.serverBufferedHighWaterBytes': { applyScope: 'new_sessions', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.ws.serverBufferedHardLimitBytes': { applyScope: 'new_sessions', writeOnly: false, constraints: bytes(1024, 536870912) },
  'resourceLimits.ws.perClientOutputQueueMaxBytes': { applyScope: 'new_sessions', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.ws.perClientControlQueueMaxBytes': { applyScope: 'new_sessions', writeOnly: false, constraints: bytes(1024, 16777216) },
  'resourceLimits.ws.outputCoalesceWindowMs': { applyScope: 'new_sessions', writeOnly: false, constraints: ms(1, 1000) },
  'resourceLimits.clientWs.inputBackpressureBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.clientWs.hardReconnectBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 536870912) },
  'resourceLimits.terminal.visibleOutputQueueMaxBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.terminal.visibleOutputMaxChunks': { applyScope: 'immediate', writeOnly: false, constraints: count(1, 65536) },
  'resourceLimits.terminal.visibleFlushBudgetBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 16777216) },
  'resourceLimits.terminal.hiddenOutputPolicy': { applyScope: 'immediate', writeOnly: false },
  'resourceLimits.terminal.hiddenOutputTailBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(0, 16777216) },
  'resourceLimits.terminal.inputQueueMaxBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 16777216) },
  'resourceLimits.terminal.inputQueueTtlMs': { applyScope: 'immediate', writeOnly: false, constraints: ms(1, 60000) },
  'resourceLimits.terminal.transportOutboxMaxBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 16777216) },
  'resourceLimits.terminal.transportOutboxTtlMs': { applyScope: 'immediate', writeOnly: false, constraints: ms(1, 60000) },
  'resourceLimits.terminal.scrollbackLines': { applyScope: 'immediate', writeOnly: false, constraints: count(0, 50000) },
  'resourceLimits.snapshots.perSnapshotMaxChars': { applyScope: 'immediate', writeOnly: false, constraints: chars(1024, 50000000) },
  'resourceLimits.snapshots.totalStorageBudgetChars': { applyScope: 'immediate', writeOnly: false, constraints: chars(1024, 200000000) },
  'resourceLimits.snapshots.maxEntries': { applyScope: 'immediate', writeOnly: false, constraints: count(1, 1024) },
  'resourceLimits.snapshots.tombstoneTtlMs': { applyScope: 'immediate', writeOnly: false, constraints: ms(1000, 604800000) },
  'resourceLimits.workspaceRuntime.maxLiveWorkspaces': { applyScope: 'immediate', writeOnly: false, constraints: count(1, 10) },
  'resourceLimits.workspaceRuntime.maxLiveTerminals': { applyScope: 'immediate', writeOnly: false, constraints: count(1, 128) },
  'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs': { applyScope: 'immediate', writeOnly: false, constraints: ms(1000, 3600000) },
  'resourceLimits.telemetry.sampleIntervalMs': { applyScope: 'new_sessions', writeOnly: false, constraints: ms(1000, 3600000) },
  'resourceLimits.telemetry.recentEventLimit': { applyScope: 'new_sessions', writeOnly: false, constraints: count(1, 10000) },
  'stabilityModes.headlessQueueMode': { applyScope: 'new_sessions', writeOnly: false },
  'stabilityModes.wsSendMode': { applyScope: 'new_sessions', writeOnly: false },
  'stabilityModes.frontendRuntimeResidency': { applyScope: 'immediate', writeOnly: false },
};

const WAVE0_UNAPPLIED_SETTING_PREFIXES = [
  'resourceLimits.headless.',
  'resourceLimits.ws.',
  'resourceLimits.telemetry.',
] as const;
const WAVE0_UNAPPLIED_SETTING_KEYS = new Set<EditableSettingsKey>([
  'stabilityModes.headlessQueueMode',
  'stabilityModes.wsSendMode',
]);
const WAVE0_UNAPPLIED_REASON = 'Reserved for a later stability wave; not applied by the current runtime';
const DEFAULT_WS_TRANSPORT_MODE: WsTransportMode = 'unified';

export interface PublicRuntimeConfig {
  inputReliabilityMode: InputReliabilityMode;
  wsTransportMode: WsTransportMode;
  stabilityModes: Pick<StabilityModesConfig, 'frontendRuntimeResidency'>;
  resourceLimits: Pick<ResourceLimitsConfig, 'clientWs' | 'terminal' | 'snapshots' | 'workspaceRuntime'>;
}

export class RuntimeConfigStore {
  private values: EditableSettingsValues;
  private readonly capabilities: Record<EditableSettingsKey, FieldCapability>;
  private readonly excludedSections = [...EXCLUDED_SECTIONS];
  private secretState: EditableSettingsSnapshot['secretState'];
  private wsTransportMode: WsTransportMode;

  constructor(source: Config = globalConfig, private readonly platform: NodeJS.Platform = process.platform) {
    this.values = buildEditableValues(source, platform);
    this.wsTransportMode = source.realtime?.wsTransportMode ?? DEFAULT_WS_TRANSPORT_MODE;
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

  getPublicRuntimeConfig(inputReliabilityMode: InputReliabilityMode): PublicRuntimeConfig {
    return {
      inputReliabilityMode,
      wsTransportMode: this.wsTransportMode,
      stabilityModes: {
        frontendRuntimeResidency: this.values.stabilityModes.frontendRuntimeResidency,
      },
      resourceLimits: {
        clientWs: structuredClone(this.values.resourceLimits.clientWs),
        terminal: structuredClone(this.values.resourceLimits.terminal),
        snapshots: structuredClone(this.values.resourceLimits.snapshots),
        workspaceRuntime: structuredClone(this.values.resourceLimits.workspaceRuntime),
      },
    };
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
    if (patch.pty?.windowsPowerShellBackend !== undefined) {
      next.pty.windowsPowerShellBackend = patch.pty.windowsPowerShellBackend;
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

    if (patch.resourceLimits !== undefined) {
      next.resourceLimits = mergeResourceLimits(next.resourceLimits, patch.resourceLimits);
    }

    if (patch.stabilityModes !== undefined) {
      next.stabilityModes = stabilityModesSchema.parse({
        ...next.stabilityModes,
        ...patch.stabilityModes,
      });
    }

    return next;
  }

  replaceValues(next: EditableSettingsValues): void {
    this.values = structuredClone(next);
  }

  replaceFromConfig(config: Config): void {
    this.values = buildEditableValues(config, this.platform);
    this.wsTransportMode = config.realtime?.wsTransportMode ?? DEFAULT_WS_TRANSPORT_MODE;
    this.secretState = {
      authPasswordConfigured: Boolean(config.auth?.password),
      smtpPasswordConfigured: false,
    };
  }
}

function buildEditableValues(source: Config, platform: NodeJS.Platform): EditableSettingsValues {
  const authDefaults = authSchema.parse({});
  const ptyDefaults = ptySchema.parse({});
  const sessionDefaults = sessionSchema.parse({});
  const twoFactorDefaults = twoFactorSchema.parse({});
  const corsDefaults = corsSchema.parse({});
  const fileManagerDefaults = fileManagerSchema.parse({});
  const resourceLimits = resourceLimitsSchema.parse(source.resourceLimits);
  const stabilityModes = stabilityModesSchema.parse(source.stabilityModes);

  const normalizedPty = normalizePtyConfigForPlatform({
    useConpty: source.pty.useConpty ?? ptyDefaults.useConpty,
    windowsPowerShellBackend: source.pty.windowsPowerShellBackend ?? ptyDefaults.windowsPowerShellBackend,
    shell: source.pty.shell ?? ptyDefaults.shell,
  }, platform);

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
      useConpty: normalizedPty.useConpty,
      windowsPowerShellBackend: normalizedPty.windowsPowerShellBackend,
      shell: normalizedPty.shell,
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
    resourceLimits,
    stabilityModes,
  };
}

function mergeResourceLimits(current: ResourceLimitsConfig, patch: ResourceLimitsPatch): ResourceLimitsConfig {
  return resourceLimitsSchema.parse({
    headless: patch.headless === undefined ? current.headless : { ...current.headless, ...patch.headless },
    ws: patch.ws === undefined ? current.ws : { ...current.ws, ...patch.ws },
    clientWs: patch.clientWs === undefined ? current.clientWs : { ...current.clientWs, ...patch.clientWs },
    terminal: patch.terminal === undefined ? current.terminal : { ...current.terminal, ...patch.terminal },
    snapshots: patch.snapshots === undefined ? current.snapshots : { ...current.snapshots, ...patch.snapshots },
    workspaceRuntime: patch.workspaceRuntime === undefined ? current.workspaceRuntime : { ...current.workspaceRuntime, ...patch.workspaceRuntime },
    telemetry: patch.telemetry === undefined ? current.telemetry : { ...current.telemetry, ...patch.telemetry },
  });
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

  capabilities['pty.windowsPowerShellBackend'] = {
    ...capabilities['pty.windowsPowerShellBackend'],
    available: platform === 'win32',
    reason: platform === 'win32' ? undefined : 'Windows-only PowerShell backend override',
    options: ['inherit', 'conpty', 'winpty'],
  };

  capabilities['resourceLimits.headless.overflowPolicy'] = {
    ...capabilities['resourceLimits.headless.overflowPolicy'],
    options: ['degrade-headless'],
  };

  capabilities['resourceLimits.terminal.hiddenOutputPolicy'] = {
    ...capabilities['resourceLimits.terminal.hiddenOutputPolicy'],
    options: ['write-hidden', 'snapshot-restore', 'debug-tail'],
  };

  capabilities['stabilityModes.headlessQueueMode'] = {
    ...capabilities['stabilityModes.headlessQueueMode'],
    options: ['observe', 'bounded'],
  };

  capabilities['stabilityModes.wsSendMode'] = {
    ...capabilities['stabilityModes.wsSendMode'],
    options: ['direct', 'safe-send-observe', 'safe-send-enforce'],
  };

  capabilities['stabilityModes.frontendRuntimeResidency'] = {
    ...capabilities['stabilityModes.frontendRuntimeResidency'],
    options: ['legacy', 'bounded', 'off'],
  };

  for (const [key, capability] of Object.entries(capabilities) as Array<[EditableSettingsKey, FieldCapability]>) {
    if (isWave0UnappliedSetting(key)) {
      capabilities[key] = {
        ...capability,
        available: false,
        reason: WAVE0_UNAPPLIED_REASON,
      };
    }
  }

  capabilities['pty.shell'] = {
    ...capabilities['pty.shell'],
    options: getSettingsShellOptions(platform),
  };

  return capabilities;
}

function isWave0UnappliedSetting(key: EditableSettingsKey): boolean {
  return WAVE0_UNAPPLIED_SETTING_KEYS.has(key)
    || WAVE0_UNAPPLIED_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}
