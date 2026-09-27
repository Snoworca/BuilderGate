import type {
  EditableSettingsKey,
  EditableSettingsValues,
  FieldCapability,
  ResourceLimitsPatch,
  ResourceLimitsSettings,
  SettingsPatchRequest,
} from '../../types';
import { t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';

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
type ResourceLimitUnit = NonNullable<FieldCapability['constraints']>['unit'];
type ResourceLimitValue = number | string;

export interface ResourceLimitFieldDefinition {
  key: Wave6ResourceLimitKey;
  labelKey: MessageKey;
  control: 'number' | 'select';
  hint?: string;
}

export interface ResourceLimitGroupDefinition {
  titleKey: MessageKey;
  fields: ResourceLimitFieldDefinition[];
}

export interface SecretPatchDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export const WAVE6_RESOURCE_LIMIT_GROUPS: ResourceLimitGroupDefinition[] = [
  {
    titleKey: 'settings.resourceGroup.serverOutput',
    fields: [
      { key: 'resourceLimits.headless.pendingOutputMaxBytes', labelKey: 'settings.resourceLimit.pendingOutputMaxBytes', control: 'number' },
      { key: 'resourceLimits.headless.pendingOutputMaxChunks', labelKey: 'settings.resourceLimit.pendingOutputMaxChunks', control: 'number' },
      { key: 'resourceLimits.ws.serverBufferedHighWaterBytes', labelKey: 'settings.resourceLimit.serverBufferedHighWaterBytes', control: 'number' },
      { key: 'resourceLimits.ws.serverBufferedHardLimitBytes', labelKey: 'settings.resourceLimit.serverBufferedHardLimitBytes', control: 'number' },
      { key: 'resourceLimits.ws.perClientOutputQueueMaxBytes', labelKey: 'settings.resourceLimit.perClientOutputQueueMaxBytes', control: 'number' },
    ],
  },
  {
    titleKey: 'settings.resourceGroup.browserQueue',
    fields: [
      { key: 'resourceLimits.clientWs.inputBackpressureBytes', labelKey: 'settings.resourceLimit.inputBackpressureBytes', control: 'number' },
      { key: 'resourceLimits.clientWs.hardReconnectBytes', labelKey: 'settings.resourceLimit.hardReconnectBytes', control: 'number' },
      { key: 'resourceLimits.terminal.inputQueueMaxBytes', labelKey: 'settings.resourceLimit.inputQueueMaxBytes', control: 'number' },
      { key: 'resourceLimits.terminal.inputQueueTtlMs', labelKey: 'settings.resourceLimit.inputQueueTtlMs', control: 'number' },
      { key: 'resourceLimits.terminal.transportOutboxMaxBytes', labelKey: 'settings.resourceLimit.transportOutboxMaxBytes', control: 'number' },
      { key: 'resourceLimits.terminal.transportOutboxTtlMs', labelKey: 'settings.resourceLimit.transportOutboxTtlMs', control: 'number' },
    ],
  },
  {
    titleKey: 'settings.resourceGroup.runtimeLimits',
    fields: [
      { key: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', labelKey: 'settings.resourceLimit.maxLiveWorkspaces', control: 'number' },
      { key: 'resourceLimits.workspaceRuntime.maxLiveTerminals', labelKey: 'settings.resourceLimit.maxLiveTerminals', control: 'number' },
      { key: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', labelKey: 'settings.resourceLimit.hiddenRuntimeTtlMs', control: 'number' },
    ],
  },
  {
    titleKey: 'settings.resourceGroup.snapshots',
    fields: [
      { key: 'resourceLimits.snapshots.perSnapshotMaxChars', labelKey: 'settings.resourceLimit.perSnapshotMaxChars', control: 'number' },
      { key: 'resourceLimits.snapshots.totalStorageBudgetChars', labelKey: 'settings.resourceLimit.totalStorageBudgetChars', control: 'number' },
      { key: 'resourceLimits.snapshots.maxEntries', labelKey: 'settings.resourceLimit.maxEntries', control: 'number' },
      { key: 'resourceLimits.snapshots.tombstoneTtlMs', labelKey: 'settings.resourceLimit.tombstoneTtlMs', control: 'number' },
    ],
  },
  {
    titleKey: 'settings.resourceGroup.hiddenOutput',
    fields: [
      { key: 'resourceLimits.terminal.hiddenOutputPolicy', labelKey: 'settings.resourceLimit.hiddenOutputPolicy', control: 'select' },
      { key: 'resourceLimits.terminal.hiddenOutputTailBytes', labelKey: 'settings.resourceLimit.hiddenOutputTailBytes', control: 'number' },
    ],
  },
];

export const WAVE6_RESOURCE_LIMIT_KEYS = WAVE6_RESOURCE_LIMIT_GROUPS.flatMap((group) =>
  group.fields.map((field) => field.key)
);

/**
 * Issue #117. The global Windows PTY backend, as the Settings page names it.
 *
 * `pty.useConpty` is node-pty's own option (`node-pty.d.ts`), mirrored into the
 * config since the first commit and rendered as a `Use ConPTY` checkbox. Beside
 * it sat an `inherit | conpty | winpty` select for the PowerShell override, so
 * one axis was presented in two vocabularies and the parent/child relation
 * between them was invisible.
 *
 * These two functions are the whole of the fix: the checkbox becomes a select
 * reading the same words, while the stored value stays the boolean the server
 * and node-pty already expect. No schema change, no migration.
 *
 * The options deliberately exclude `inherit`. `inherit` means "follow the global
 * choice", which is not something the global choice itself can do.
 */
export const TERMINAL_BACKEND_OPTIONS = ['conpty', 'winpty'] as const;

export type TerminalBackendOption = (typeof TERMINAL_BACKEND_OPTIONS)[number];

export function terminalBackendFromUseConpty(useConpty: boolean): TerminalBackendOption {
  return useConpty ? 'conpty' : 'winpty';
}

/**
 * `fallback` is the CURRENT value, not `false`.
 *
 * The select cannot emit anything outside the two options today, so this branch
 * is unreachable from the UI. It is written this way because the failure would
 * be silent and in the dangerous direction: defaulting to false drops a Windows
 * deployment to winpty, the backend this project has measured corrupting
 * PowerShell (docs/analysis/2026-04-16.powershell-rapid-enter-...). Keeping the
 * current value means an unreadable input changes nothing.
 */
export function useConptyFromTerminalBackend(value: string, fallback = true): boolean {
  if (value === 'conpty') return true;
  if (value === 'winpty') return false;
  return fallback;
}

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
      for (const problem of validateWave6ResourceLimitField(field, value, capability)) {
        errors.push(`${t(field.labelKey)}: ${problem}`);
      }
    }
  }

  return errors;
}

/**
 * What is wrong with one resource-limit value, in words that stand beside the
 * field: the rule it breaks and the value it holds now (FR-UIDS-003). The list
 * form above prefixes each with the field's label.
 */
export function validateWave6ResourceLimitField(
  field: ResourceLimitFieldDefinition,
  value: ResourceLimitValue,
  capability: FieldCapability,
): string[] {
  if (field.control === 'select') {
    const options = capability.options ?? [];
    if (options.length > 0 && !options.includes(String(value))) {
      return [t('settings.validation.notInList', { value: String(value) })];
    }
    return [];
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return [typeof value === 'number' && Number.isNaN(value)
      ? t('settings.validation.integerEmpty')
      : t('settings.validation.integerInvalid', { value: String(value) })];
  }

  const problems: string[] = [];
  const constraints = capability.constraints;
  const unit = resourceLimitUnitLabel(constraints?.unit);
  const current = t('settings.validation.currentValue', { value, unit });
  if (constraints?.min !== undefined && value < constraints.min) {
    problems.push(t('settings.validation.min', { min: constraints.min, unit, current }));
  }
  if (constraints?.max !== undefined && value > constraints.max) {
    problems.push(t('settings.validation.max', { max: constraints.max, unit, current }));
  }
  if (constraints?.step !== undefined && constraints.step > 0) {
    const base = constraints.min ?? 0;
    const distance = (value - base) / constraints.step;
    if (!Number.isInteger(distance)) {
      problems.push(t('settings.validation.step', { step: constraints.step, unit, current }));
    }
  }
  return problems;
}

const RESOURCE_LIMIT_UNIT_LABELS: Record<NonNullable<ResourceLimitUnit>, MessageKey | null> = {
  bytes: 'settings.unit.bytes',
  ms: null,
  count: 'settings.unit.count',
  chars: 'settings.unit.chars',
};

/** The unit a resource-limit value is shown with, beside the input rather than in its label. */
export function resourceLimitUnitLabel(unit: ResourceLimitUnit): string {
  if (unit === undefined) return '';
  const key = RESOURCE_LIMIT_UNIT_LABELS[unit];
  return key ? t(key) : unit;
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
