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
type ResourceLimitUnit = NonNullable<FieldCapability['constraints']>['unit'];
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
    title: '서버 출력 조절',
    fields: [
      { key: 'resourceLimits.headless.pendingOutputMaxBytes', label: '헤드리스 대기 출력 크기', control: 'number' },
      { key: 'resourceLimits.headless.pendingOutputMaxChunks', label: '헤드리스 대기 출력 조각 수', control: 'number' },
      { key: 'resourceLimits.ws.serverBufferedHighWaterBytes', label: '서버 WebSocket 경고 수위', control: 'number' },
      { key: 'resourceLimits.ws.serverBufferedHardLimitBytes', label: '서버 WebSocket 최대 버퍼', control: 'number' },
      { key: 'resourceLimits.ws.perClientOutputQueueMaxBytes', label: '클라이언트별 출력 대기열 크기', control: 'number' },
    ],
  },
  {
    title: '브라우저 대기열',
    fields: [
      { key: 'resourceLimits.clientWs.inputBackpressureBytes', label: '입력 조절 시작 크기', control: 'number' },
      { key: 'resourceLimits.clientWs.hardReconnectBytes', label: '강제 재연결 크기', control: 'number' },
      { key: 'resourceLimits.terminal.inputQueueMaxBytes', label: '터미널 입력 대기열 크기', control: 'number' },
      { key: 'resourceLimits.terminal.inputQueueTtlMs', label: '터미널 입력 대기열 유지 시간', control: 'number' },
      { key: 'resourceLimits.terminal.transportOutboxMaxBytes', label: '전송 대기함 크기', control: 'number' },
      { key: 'resourceLimits.terminal.transportOutboxTtlMs', label: '전송 대기함 유지 시간', control: 'number' },
    ],
  },
  {
    title: '실행 유지 한도',
    fields: [
      { key: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', label: '동시에 유지할 워크스페이스 수', control: 'number' },
      { key: 'resourceLimits.workspaceRuntime.maxLiveTerminals', label: '동시에 유지할 터미널 수', control: 'number' },
      { key: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', label: '숨긴 런타임 유지 시간', control: 'number' },
    ],
  },
  {
    title: '스냅샷',
    fields: [
      { key: 'resourceLimits.snapshots.perSnapshotMaxChars', label: '스냅샷 1개 최대 글자 수', control: 'number' },
      { key: 'resourceLimits.snapshots.totalStorageBudgetChars', label: '스냅샷 전체 글자 수 한도', control: 'number' },
      { key: 'resourceLimits.snapshots.maxEntries', label: '스냅샷 최대 개수', control: 'number' },
      { key: 'resourceLimits.snapshots.tombstoneTtlMs', label: '삭제된 스냅샷 기록 유지 시간', control: 'number' },
    ],
  },
  {
    title: '숨긴 세션 출력',
    fields: [
      { key: 'resourceLimits.terminal.hiddenOutputPolicy', label: '숨긴 세션 출력 처리 방식', control: 'select' },
      { key: 'resourceLimits.terminal.hiddenOutputTailBytes', label: '숨긴 세션 출력 보관 크기', control: 'number' },
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
      for (const problem of validateWave6ResourceLimitField(field, value, capability)) {
        errors.push(`${field.label}: ${problem}`);
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
      return [`목록에 있는 값만 고를 수 있습니다. 지금 값은 ${String(value)}입니다.`];
    }
    return [];
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    const current = typeof value === 'number' && Number.isNaN(value) ? '비어 있습니다' : `${String(value)}입니다`;
    return [`정수를 입력하세요. 지금 값은 ${current}.`];
  }

  const problems: string[] = [];
  const constraints = capability.constraints;
  const unit = resourceLimitUnitLabel(constraints?.unit);
  const current = `지금 값은 ${value}${unit}입니다.`;
  if (constraints?.min !== undefined && value < constraints.min) {
    problems.push(`${constraints.min}${unit} 이상이어야 합니다. ${current}`);
  }
  if (constraints?.max !== undefined && value > constraints.max) {
    problems.push(`${constraints.max}${unit} 이하여야 합니다. ${current}`);
  }
  if (constraints?.step !== undefined && constraints.step > 0) {
    const base = constraints.min ?? 0;
    const distance = (value - base) / constraints.step;
    if (!Number.isInteger(distance)) {
      problems.push(`${constraints.step}${unit} 단위로 입력하세요. ${current}`);
    }
  }
  return problems;
}

const RESOURCE_LIMIT_UNIT_LABELS: Record<NonNullable<ResourceLimitUnit>, string> = {
  bytes: '바이트',
  ms: 'ms',
  count: '개',
  chars: '자',
};

/** The unit a resource-limit value is shown with, beside the input rather than in its label. */
export function resourceLimitUnitLabel(unit: ResourceLimitUnit): string {
  return unit === undefined ? '' : RESOURCE_LIMIT_UNIT_LABELS[unit] ?? unit;
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
