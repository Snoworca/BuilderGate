import type {
  EditableSettingsKey,
  EditableSettingsValues,
  FieldCapability,
  ResourceLimitsPatch,
  ResourceLimitsSettings,
  SettingsPatchRequest,
} from '../../types';

export type Wave6ResourceLimitKey =
  | 'resourceLimits.headless.pendingOutputMaxBytes'
  | 'resourceLimits.headless.pendingOutputMaxChunks'
  | 'resourceLimits.ws.serverBufferedHighWaterBytes'
  | 'resourceLimits.ws.serverBufferedHardLimitBytes'
  | 'resourceLimits.ws.perClientOutputQueueMaxBytes'
  | 'resourceLimits.clientWs.inputBackpressureBytes'
  | 'resourceLimits.clientWs.hardReconnectBytes'
  | 'resourceLimits.terminal.inputQueueMaxBytes'
  | 'resourceLimits.terminal.inputQueueTtlMs'
  | 'resourceLimits.terminal.transportOutboxMaxBytes'
  | 'resourceLimits.terminal.transportOutboxTtlMs'
  | 'resourceLimits.workspaceRuntime.maxLiveWorkspaces'
  | 'resourceLimits.workspaceRuntime.maxLiveTerminals'
  | 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs'
  | 'resourceLimits.snapshots.perSnapshotMaxChars'
  | 'resourceLimits.snapshots.totalStorageBudgetChars'
  | 'resourceLimits.snapshots.maxEntries'
  | 'resourceLimits.snapshots.tombstoneTtlMs'
  | 'resourceLimits.terminal.hiddenOutputPolicy'
  | 'resourceLimits.terminal.hiddenOutputTailBytes';

type ResourceLimitSection = keyof ResourceLimitsSettings;
type ResourceLimitValue = number | string;

export interface ResourceLimitFieldDefinition {
  key: Wave6ResourceLimitKey;
  label: string;
  control: 'number' | 'select';
  hint?: string;
}

export interface ResourceLimitGroupDefinition {
  title: string;
  fields: ResourceLimitFieldDefinition[];
}

export interface SecretPatchDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export const WAVE6_RESOURCE_LIMIT_GROUPS: ResourceLimitGroupDefinition[] = [
  {
    title: 'Server Backpressure',
    fields: [
      { key: 'resourceLimits.headless.pendingOutputMaxBytes', label: 'Headless pending output bytes', control: 'number' },
      { key: 'resourceLimits.headless.pendingOutputMaxChunks', label: 'Headless pending output chunks', control: 'number' },
      { key: 'resourceLimits.ws.serverBufferedHighWaterBytes', label: 'Server WebSocket high water bytes', control: 'number' },
      { key: 'resourceLimits.ws.serverBufferedHardLimitBytes', label: 'Server WebSocket hard limit bytes', control: 'number' },
      { key: 'resourceLimits.ws.perClientOutputQueueMaxBytes', label: 'Per-client output queue bytes', control: 'number' },
    ],
  },
  {
    title: 'Browser Queues',
    fields: [
      { key: 'resourceLimits.clientWs.inputBackpressureBytes', label: 'Input backpressure bytes', control: 'number' },
      { key: 'resourceLimits.clientWs.hardReconnectBytes', label: 'Hard reconnect bytes', control: 'number' },
      { key: 'resourceLimits.terminal.inputQueueMaxBytes', label: 'Terminal input queue bytes', control: 'number' },
      { key: 'resourceLimits.terminal.inputQueueTtlMs', label: 'Terminal input queue TTL', control: 'number' },
      { key: 'resourceLimits.terminal.transportOutboxMaxBytes', label: 'Transport outbox bytes', control: 'number' },
      { key: 'resourceLimits.terminal.transportOutboxTtlMs', label: 'Transport outbox TTL', control: 'number' },
    ],
  },
  {
    title: 'Runtime Residency',
    fields: [
      { key: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', label: 'Live workspaces', control: 'number' },
      { key: 'resourceLimits.workspaceRuntime.maxLiveTerminals', label: 'Live terminals', control: 'number' },
      { key: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', label: 'Hidden runtime TTL', control: 'number' },
    ],
  },
  {
    title: 'Snapshots',
    fields: [
      { key: 'resourceLimits.snapshots.perSnapshotMaxChars', label: 'Per-snapshot chars', control: 'number' },
      { key: 'resourceLimits.snapshots.totalStorageBudgetChars', label: 'Total snapshot budget chars', control: 'number' },
      { key: 'resourceLimits.snapshots.maxEntries', label: 'Snapshot max entries', control: 'number' },
      { key: 'resourceLimits.snapshots.tombstoneTtlMs', label: 'Snapshot tombstone TTL', control: 'number' },
    ],
  },
  {
    title: 'Hidden Output',
    fields: [
      { key: 'resourceLimits.terminal.hiddenOutputPolicy', label: 'Hidden output policy', control: 'select' },
      { key: 'resourceLimits.terminal.hiddenOutputTailBytes', label: 'Hidden output tail bytes', control: 'number' },
    ],
  },
];

export const WAVE6_RESOURCE_LIMIT_KEYS = WAVE6_RESOURCE_LIMIT_GROUPS.flatMap((group) =>
  group.fields.map((field) => field.key)
);

export function buildSettingsPatch(
  initial: EditableSettingsValues,
  draft: EditableSettingsValues,
  secrets: SecretPatchDraft,
  capabilities: Record<EditableSettingsKey, FieldCapability>,
): SettingsPatchRequest {
  const patch: SettingsPatchRequest = {};

  if (initial.auth.durationMs !== draft.auth.durationMs || secrets.currentPassword || secrets.newPassword || secrets.confirmPassword) {
    patch.auth = {};
    if (initial.auth.durationMs !== draft.auth.durationMs) patch.auth.durationMs = draft.auth.durationMs;
    if (secrets.currentPassword) patch.auth.currentPassword = secrets.currentPassword;
    if (secrets.newPassword) patch.auth.newPassword = secrets.newPassword;
    if (secrets.confirmPassword) patch.auth.confirmPassword = secrets.confirmPassword;
  }

  if (JSON.stringify(initial.twoFactor) !== JSON.stringify(draft.twoFactor)) {
    patch.twoFactor = {
      enabled: draft.twoFactor.enabled,
      externalOnly: draft.twoFactor.externalOnly,
      issuer: draft.twoFactor.issuer,
      accountName: draft.twoFactor.accountName,
    };
  }

  if (JSON.stringify(initial.security.cors) !== JSON.stringify(draft.security.cors)) {
    patch.security = { cors: { ...draft.security.cors } };
  }

  if (JSON.stringify(initial.pty) !== JSON.stringify(draft.pty)) {
    const nextPtyPatch: NonNullable<SettingsPatchRequest['pty']> = {};
    if (initial.pty.termName !== draft.pty.termName) nextPtyPatch.termName = draft.pty.termName;
    if (initial.pty.defaultCols !== draft.pty.defaultCols) nextPtyPatch.defaultCols = draft.pty.defaultCols;
    if (initial.pty.defaultRows !== draft.pty.defaultRows) nextPtyPatch.defaultRows = draft.pty.defaultRows;
    if (initial.pty.useConpty !== draft.pty.useConpty) nextPtyPatch.useConpty = draft.pty.useConpty;
    if (initial.pty.windowsPowerShellBackend !== draft.pty.windowsPowerShellBackend) {
      nextPtyPatch.windowsPowerShellBackend = draft.pty.windowsPowerShellBackend;
    }
    if (initial.pty.shell !== draft.pty.shell) nextPtyPatch.shell = draft.pty.shell;
    if (Object.keys(nextPtyPatch).length > 0) {
      patch.pty = nextPtyPatch;
    }
  }

  if (initial.session.idleDelayMs !== draft.session.idleDelayMs) {
    patch.session = { idleDelayMs: draft.session.idleDelayMs };
  }

  if (JSON.stringify(initial.fileManager) !== JSON.stringify(draft.fileManager)) {
    patch.fileManager = { ...draft.fileManager };
  }

  const resourceLimits = buildWave6ResourceLimitsPatch(initial, draft, capabilities);
  if (resourceLimits) {
    patch.resourceLimits = resourceLimits;
  }

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value && Object.keys(value).length > 0)) as SettingsPatchRequest;
}

export function buildWave6ResourceLimitsPatch(
  initial: EditableSettingsValues,
  draft: EditableSettingsValues,
  capabilities: Record<EditableSettingsKey, FieldCapability>,
): ResourceLimitsPatch | undefined {
  const patch: ResourceLimitsPatch = {};

  for (const key of WAVE6_RESOURCE_LIMIT_KEYS) {
    if (!capabilities[key]?.available) {
      continue;
    }

    const initialValue = getResourceLimitValue(initial, key);
    const draftValue = getResourceLimitValue(draft, key);
    if (Object.is(initialValue, draftValue)) {
      continue;
    }

    const { section, field } = parseResourceLimitKey(key);
    const sectionPatch = (patch[section] ?? {}) as Record<string, ResourceLimitValue>;
    sectionPatch[field] = draftValue;
    patch[section] = sectionPatch as never;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function validateWave6ResourceLimitDraft(
  draft: EditableSettingsValues,
  capabilities: Record<EditableSettingsKey, FieldCapability>,
): string[] {
  const errors: string[] = [];

  for (const group of WAVE6_RESOURCE_LIMIT_GROUPS) {
    for (const field of group.fields) {
      const capability = capabilities[field.key];
      if (!capability?.available) {
        continue;
      }

      const value = getResourceLimitValue(draft, field.key);
      if (field.control === 'select') {
        const options = capability.options ?? [];
        if (options.length > 0 && !options.includes(String(value))) {
          errors.push(`${field.label} must be a supported option.`);
        }
        continue;
      }

      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        errors.push(`${field.label} must be a finite integer.`);
        continue;
      }

      const constraints = capability.constraints;
      if (constraints?.min !== undefined && value < constraints.min) {
        errors.push(`${field.label} must be at least ${constraints.min}.`);
      }
      if (constraints?.max !== undefined && value > constraints.max) {
        errors.push(`${field.label} must be at most ${constraints.max}.`);
      }
      if (constraints?.step !== undefined && constraints.step > 0) {
        const base = constraints.min ?? 0;
        const distance = (value - base) / constraints.step;
        if (!Number.isInteger(distance)) {
          errors.push(`${field.label} must use step ${constraints.step}.`);
        }
      }
    }
  }

  return errors;
}

export function getResourceLimitValue(values: EditableSettingsValues, key: Wave6ResourceLimitKey): ResourceLimitValue {
  const { section, field } = parseResourceLimitKey(key);
  return (values.resourceLimits[section] as Record<string, ResourceLimitValue>)[field];
}

export function setResourceLimitValue(
  values: EditableSettingsValues,
  key: Wave6ResourceLimitKey,
  value: ResourceLimitValue,
): void {
  const { section, field } = parseResourceLimitKey(key);
  (values.resourceLimits[section] as Record<string, ResourceLimitValue>)[field] = value;
}

export function parseResourceLimitInput(value: string): number {
  if (value.trim() === '') {
    return Number.NaN;
  }
  return Number(value);
}

export function formatResourceLimitInput(value: ResourceLimitValue): string {
  return typeof value === 'number' && !Number.isFinite(value) ? '' : String(value);
}

export function resourceLimitTestId(key: Wave6ResourceLimitKey): string {
  return `settings-${key.replace(/\./g, '-')}`;
}

function parseResourceLimitKey(key: Wave6ResourceLimitKey): { section: ResourceLimitSection; field: string } {
  const [, section, ...rest] = key.split('.');
  return {
    section: section as ResourceLimitSection,
    field: rest.join('.'),
  };
}
