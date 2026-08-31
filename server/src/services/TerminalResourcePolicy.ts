import { createHash } from 'node:crypto';
import type { Config, ResourceLimitsConfig, StabilityModesConfig } from '../types/config.types.js';
export { getRegisteredTerminalResourcePolicyObservationDecisions } from './TerminalResourcePolicyObservations.js';

export const TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION = 'terminal-resource-policy/v1';
export const TERMINAL_RESOURCE_POLICY_PROFILE_VERSION = 'legacy-effective/v1';
export const LEGACY_TERMINAL_RESOURCE_POLICY_ID = 'legacy-effective/v1';

export interface FairTerminalDeliveryPolicyValue<T extends number | string> {
  readonly value: T;
  readonly source: string;
}

export interface FairTerminalDeliveryPolicyProjection {
  readonly strategy: FairTerminalDeliveryPolicyValue<string>;
  readonly socketSoftGateBytes: FairTerminalDeliveryPolicyValue<number>;
  readonly bulkSliceBytes: FairTerminalDeliveryPolicyValue<number>;
  readonly smallOutputBypassBytes: FairTerminalDeliveryPolicyValue<number>;
  readonly visibilityWeight: FairTerminalDeliveryPolicyValue<number>;
  readonly driverWeight: FairTerminalDeliveryPolicyValue<number>;
  readonly creditWindowBytes: FairTerminalDeliveryPolicyValue<number>;
  readonly ackTimeoutMs: FairTerminalDeliveryPolicyValue<number>;
  readonly queueMaxBytes: FairTerminalDeliveryPolicyValue<number>;
}

export function resolveFairTerminalDeliveryPolicy(limits: {
  serverBufferedHighWaterBytes: number;
  perClientOutputQueueMaxBytes: number;
  perClientControlQueueMaxBytes: number;
  outputCoalesceWindowMs: number;
}): FairTerminalDeliveryPolicyProjection {
  const outputLimit = Math.max(1, Math.floor(limits.perClientOutputQueueMaxBytes));
  const controlLimit = Math.max(1, Math.floor(limits.perClientControlQueueMaxBytes));
  const smallOutputBypassBytes = Math.max(1, Math.floor(controlLimit / 8));
  return Object.freeze({
    strategy: { value: 'deficit-round-robin', source: 'fair-scheduler-decision.json#candidate' },
    socketSoftGateBytes: {
      value: Math.max(1, Math.floor(limits.serverBufferedHighWaterBytes)),
      source: 'resourceLimits.ws.serverBufferedHighWaterBytes',
    },
    bulkSliceBytes: {
      value: Math.max(1, Math.floor(outputLimit / 16)),
      source: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    },
    smallOutputBypassBytes: {
      value: smallOutputBypassBytes,
      source: 'resourceLimits.ws.perClientControlQueueMaxBytes',
    },
    visibilityWeight: {
      value: Math.max(1, Math.floor(controlLimit / smallOutputBypassBytes)),
      source: 'resourceLimits.ws.perClientControlQueueMaxBytes',
    },
    driverWeight: {
      value: Math.max(1, Math.floor(outputLimit / Math.max(1, outputLimit / 16))),
      source: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    },
    creditWindowBytes: {
      value: outputLimit,
      source: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    },
    ackTimeoutMs: {
      value: Math.max(5_000, Math.floor(limits.outputCoalesceWindowMs)),
      source: 'ws.terminal-delivery.ack-timeout',
    },
    queueMaxBytes: {
      value: outputLimit,
      source: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    },
  });
}

export const TERMINAL_RESOURCE_POLICY_CONSUMER_IDS = [
  'server.config.schema',
  'server.config.runtime-store',
  'server.pty.headless-model',
  'server.ws.router',
  'server.ws.send-policy',
  'server.snapshot.replay-repair',
  'browser.runtime.residency',
  'browser.hidden-output',
  'browser.terminal.write-scheduler',
  'browser.terminal.recovery-scheduler',
  'browser.snapshot.persisted-storage',
] as const;

export type TerminalResourcePolicyConsumerId = typeof TERMINAL_RESOURCE_POLICY_CONSUMER_IDS[number];
export type TerminalResourcePolicyDifferenceReason =
  | 'legacy-only'
  | 'candidate-unavailable'
  | 'candidate-equal'
  | 'candidate-differs'
  | 'source-conflict'
  | 'runtime-divergence'
  | 'reserved-unapplied';

const RESOURCE_DEFINITIONS = {
  'resourceLimits.clientWs.hardReconnectBytes': { path: ['clientWs', 'hardReconnectBytes'], unit: 'bytes', applyBoundary: 'browser-send' },
  'resourceLimits.clientWs.inputBackpressureBytes': { path: ['clientWs', 'inputBackpressureBytes'], unit: 'bytes', applyBoundary: 'browser-send' },
  'resourceLimits.headless.overflowPolicy': { path: ['headless', 'overflowPolicy'], unit: 'enum', applyBoundary: 'new-session' },
  'resourceLimits.headless.pendingOutputMaxBytes': { path: ['headless', 'pendingOutputMaxBytes'], unit: 'bytes', applyBoundary: 'new-session' },
  'resourceLimits.headless.pendingOutputMaxChunks': { path: ['headless', 'pendingOutputMaxChunks'], unit: 'count', applyBoundary: 'new-session' },
  'resourceLimits.headless.writeBatchMaxBytes': { path: ['headless', 'writeBatchMaxBytes'], unit: 'bytes', applyBoundary: 'reserved-unapplied' },
  'resourceLimits.headless.writeLagWarnMs': { path: ['headless', 'writeLagWarnMs'], unit: 'ms', applyBoundary: 'reserved-unapplied' },
  'resourceLimits.snapshots.maxEntries': { path: ['snapshots', 'maxEntries'], unit: 'count', applyBoundary: 'snapshot-eviction' },
  'resourceLimits.snapshots.perSnapshotMaxChars': { path: ['snapshots', 'perSnapshotMaxChars'], unit: 'chars', applyBoundary: 'snapshot-read-write' },
  'resourceLimits.snapshots.tombstoneTtlMs': { path: ['snapshots', 'tombstoneTtlMs'], unit: 'ms', applyBoundary: 'snapshot-cleanup' },
  'resourceLimits.snapshots.totalStorageBudgetChars': { path: ['snapshots', 'totalStorageBudgetChars'], unit: 'chars', applyBoundary: 'snapshot-eviction' },
  'resourceLimits.terminal.hiddenOutputPolicy': { path: ['terminal', 'hiddenOutputPolicy'], unit: 'enum', applyBoundary: 'visibility-decision' },
  'resourceLimits.terminal.hiddenOutputTailBytes': { path: ['terminal', 'hiddenOutputTailBytes'], unit: 'bytes', applyBoundary: 'visibility-decision' },
  'resourceLimits.terminal.inputQueueMaxBytes': { path: ['terminal', 'inputQueueMaxBytes'], unit: 'bytes', applyBoundary: 'recovery-generation' },
  'resourceLimits.terminal.inputQueueTtlMs': { path: ['terminal', 'inputQueueTtlMs'], unit: 'ms', applyBoundary: 'recovery-generation' },
  'resourceLimits.terminal.scrollbackLines': { path: ['terminal', 'scrollbackLines'], unit: 'lines', applyBoundary: 'runtime-divergence-observation' },
  'resourceLimits.terminal.transportOutboxMaxBytes': { path: ['terminal', 'transportOutboxMaxBytes'], unit: 'bytes', applyBoundary: 'browser-transport-generation' },
  'resourceLimits.terminal.transportOutboxTtlMs': { path: ['terminal', 'transportOutboxTtlMs'], unit: 'ms', applyBoundary: 'browser-transport-generation' },
  'resourceLimits.terminal.visibleFlushBudgetBytes': { path: ['terminal', 'visibleFlushBudgetBytes'], unit: 'bytes', applyBoundary: 'browser-frame' },
  'resourceLimits.terminal.visibleOutputMaxChunks': { path: ['terminal', 'visibleOutputMaxChunks'], unit: 'count', applyBoundary: 'browser-output-generation' },
  'resourceLimits.terminal.visibleOutputQueueMaxBytes': { path: ['terminal', 'visibleOutputQueueMaxBytes'], unit: 'bytes', applyBoundary: 'browser-output-generation' },
  'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs': { path: ['workspaceRuntime', 'hiddenRuntimeTtlMs'], unit: 'ms', applyBoundary: 'runtime-residency' },
  'resourceLimits.workspaceRuntime.maxLiveTerminals': { path: ['workspaceRuntime', 'maxLiveTerminals'], unit: 'count', applyBoundary: 'runtime-residency' },
  'resourceLimits.workspaceRuntime.maxLiveWorkspaces': { path: ['workspaceRuntime', 'maxLiveWorkspaces'], unit: 'count', applyBoundary: 'runtime-residency' },
  'resourceLimits.ws.outputCoalesceWindowMs': { path: ['ws', 'outputCoalesceWindowMs'], unit: 'ms', applyBoundary: 'immediate' },
  'resourceLimits.ws.perClientControlQueueMaxBytes': { path: ['ws', 'perClientControlQueueMaxBytes'], unit: 'bytes', applyBoundary: 'immediate' },
  'resourceLimits.ws.perClientOutputQueueMaxBytes': { path: ['ws', 'perClientOutputQueueMaxBytes'], unit: 'bytes', applyBoundary: 'immediate' },
  'resourceLimits.ws.serverBufferedHardLimitBytes': { path: ['ws', 'serverBufferedHardLimitBytes'], unit: 'bytes', applyBoundary: 'immediate' },
  'resourceLimits.ws.serverBufferedHighWaterBytes': { path: ['ws', 'serverBufferedHighWaterBytes'], unit: 'bytes', applyBoundary: 'immediate' },
} as const;

export const TERMINAL_RESOURCE_KEYS = Object.freeze(
  Object.keys(RESOURCE_DEFINITIONS).sort((left, right) => left.localeCompare(right)),
) as readonly TerminalResourceKey[];
export type TerminalResourceKey = keyof typeof RESOURCE_DEFINITIONS;
type TerminalResourceScalar = number | string;

export interface TerminalResourceCandidateSelection {
  policyId: string;
  profileVersion: string;
}

type SanitizedPresence =
  | { presence: 'absent' }
  | { presence: 'unknown-effective' }
  | { presence: 'present-valid'; value: TerminalResourceScalar }
  | { presence: 'present-invalid'; invalidKind: string };

export interface TerminalResourceConfigProvenance {
  origin: 'raw-loader' | 'strict-loader' | 'config-repository' | 'fallback-defaults'
    | 'runtime-replacement' | 'effective-only-unknown' | 'test-explicit';
  canonicalResources?: Partial<Record<TerminalResourceKey, SanitizedPresence>>;
  canonicalScrollback: SanitizedPresence;
  legacyScrollback: SanitizedPresence;
}

const CONFIG_PROVENANCE = new WeakMap<Config, TerminalResourceConfigProvenance>();

function hasOwn(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizeScrollbackPresence(container: Record<string, unknown> | undefined): SanitizedPresence {
  if (!hasOwn(container, 'scrollbackLines')) return { presence: 'absent' };
  const value = container?.scrollbackLines;
  if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0 && value <= 50_000) {
    return { presence: 'present-valid', value };
  }
  const invalidKind = value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number'
        ? Number.isFinite(value) ? 'number-out-of-range-or-fractional' : 'number-non-finite'
        : typeof value;
  return { presence: 'present-invalid', invalidKind };
}

const RESOURCE_ENUM_VALUES: Partial<Record<TerminalResourceKey, readonly string[]>> = {
  'resourceLimits.headless.overflowPolicy': ['degrade-headless'],
  'resourceLimits.terminal.hiddenOutputPolicy': ['write-hidden', 'snapshot-restore', 'debug-tail'],
};

function sanitizeCanonicalResourcePresence(
  resourceLimits: Record<string, unknown> | undefined,
  key: TerminalResourceKey,
): SanitizedPresence {
  const definition = RESOURCE_DEFINITIONS[key];
  const section = asRecord(resourceLimits?.[definition.path[0]]);
  const field = definition.path[1];
  if (!hasOwn(section, field)) return { presence: 'absent' };
  const value = section?.[field];
  const enumValues = RESOURCE_ENUM_VALUES[key];
  if (enumValues !== undefined) {
    return typeof value === 'string' && enumValues.includes(value)
      ? { presence: 'present-valid', value }
      : { presence: 'present-invalid', invalidKind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? { presence: 'present-valid', value }
    : {
        presence: 'present-invalid',
        invalidKind: value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value === 'number'
              ? 'number-non-finite'
              : typeof value,
      };
}

export function captureTerminalResourceConfigProvenance(
  rawConfig: unknown,
  origin: TerminalResourceConfigProvenance['origin'] = 'raw-loader',
): TerminalResourceConfigProvenance {
  const raw = asRecord(rawConfig);
  const resourceLimits = asRecord(raw?.resourceLimits);
  const canonicalResources = Object.fromEntries(
    TERMINAL_RESOURCE_KEYS.map((key) => [key, sanitizeCanonicalResourcePresence(resourceLimits, key)]),
  ) as Record<TerminalResourceKey, SanitizedPresence>;
  const canonicalScrollback = sanitizeScrollbackPresence(asRecord(resourceLimits?.terminal));
  canonicalResources['resourceLimits.terminal.scrollbackLines'] = canonicalScrollback;
  return {
    origin,
    canonicalResources,
    canonicalScrollback,
    legacyScrollback: sanitizeScrollbackPresence(asRecord(raw?.pty)),
  };
}

export function registerTerminalResourceConfigProvenance(
  config: Config,
  rawConfig: unknown,
  origin: TerminalResourceConfigProvenance['origin'],
): Config {
  CONFIG_PROVENANCE.set(config, captureTerminalResourceConfigProvenance(rawConfig, origin));
  return config;
}

export function getTerminalResourceConfigProvenance(config: Config): TerminalResourceConfigProvenance {
  const registered = CONFIG_PROVENANCE.get(config);
  return registered === undefined
      ? {
        origin: 'effective-only-unknown',
        canonicalResources: Object.fromEntries(
          TERMINAL_RESOURCE_KEYS.map((key) => [key, { presence: 'unknown-effective' }]),
        ) as Record<TerminalResourceKey, SanitizedPresence>,
        canonicalScrollback: { presence: 'unknown-effective' },
        legacyScrollback: { presence: 'unknown-effective' },
      }
    : structuredClone(registered);
}

export function createRuntimeReplacementTerminalResourceProvenance(
  resourceLimits: ResourceLimitsConfig,
): TerminalResourceConfigProvenance {
  return {
    origin: 'runtime-replacement',
    canonicalResources: Object.fromEntries(
      TERMINAL_RESOURCE_KEYS.map((key) => [key, {
        presence: 'present-valid',
        value: getEffectiveValue(resourceLimits, key),
      }]),
    ) as Record<TerminalResourceKey, SanitizedPresence>,
    canonicalScrollback: { presence: 'present-valid', value: resourceLimits.terminal.scrollbackLines },
    legacyScrollback: { presence: 'absent' },
  };
}

export interface CompileTerminalResourcePolicyInput {
  provenance?: TerminalResourceConfigProvenance;
  rawConfig?: {
    resourceLimits?: { terminal?: { scrollbackLines?: unknown } };
    pty?: { scrollbackLines?: unknown };
  };
  effectiveResourceLimits: ResourceLimitsConfig;
  schemaVersion: string;
  profileVersion: string;
  candidateSelection?: TerminalResourceCandidateSelection;
}

export interface TerminalResourcePolicyValue<T extends TerminalResourceScalar = TerminalResourceScalar> {
  value: T;
  unit: string;
  source: string;
  sourceKind: 'canonical-explicit' | 'legacy-explicit' | 'schema-default'
    | 'effective-only-unknown' | 'runtime-replacement';
  applyBoundary: string;
  legacyAlias?: string;
}

export interface LegacyTerminalResourcePolicy {
  policyId: string;
  schemaVersion: string;
  profileVersion: string;
  resources: Record<TerminalResourceKey, TerminalResourcePolicyValue>;
  terminal: { scrollbackLines: TerminalResourcePolicyValue<number> };
}

export interface TerminalResourceCandidateResult {
  status: 'available' | 'unavailable';
  policyId?: string;
  profileVersion?: string;
  reason?: 'candidate-policy-not-selected' | 'candidate-policy-not-registered'
    | 'candidate-policy-version-not-registered' | 'candidate-policy-not-stable';
  resources?: Record<TerminalResourceKey, TerminalResourcePolicyValue>;
}

export interface CompiledTerminalResourcePolicy {
  mode: 'observe';
  appliedPolicyId: string;
  provenance: TerminalResourceConfigProvenance;
  legacyPolicy: LegacyTerminalResourcePolicy;
  candidate: TerminalResourceCandidateResult;
  comparison?: {
    legacyPolicyId: string;
    candidatePolicyId: string;
    differences: Array<{ resource: TerminalResourceKey; legacyValue: unknown; candidateValue: unknown }>;
  };
  diagnostics: Array<{
    code: 'source-conflict';
    resource: 'terminal.scrollbackLines';
    canonicalSource: 'resourceLimits.terminal.scrollbackLines';
    legacySource: 'pty.scrollbackLines';
  }>;
}

export class TerminalResourcePolicyInputError extends Error {
  constructor(
    public readonly resource: string,
    public readonly reason: 'invalid-source-value',
  ) {
    super(`${reason}: ${resource}`);
    this.name = 'TerminalResourcePolicyInputError';
  }
}

export function getRegisteredTerminalResourcePolicyProfiles(): Array<{
  policyId: string;
  profileVersion: string;
  stability: 'draft' | 'evolving' | 'stable';
  contractId: string;
}> {
  // No stable candidate contract exists in the current SRS. Do not infer one
  // from a similarly named requirement or a self-declared profile.
  return [];
}

function getEffectiveValue(resourceLimits: ResourceLimitsConfig, key: TerminalResourceKey): TerminalResourceScalar {
  const [section, field] = RESOURCE_DEFINITIONS[key].path;
  return (resourceLimits as unknown as Record<string, Record<string, TerminalResourceScalar>>)[section][field];
}

export function getTerminalResourcePolicyUnit(key: TerminalResourceKey): string {
  return RESOURCE_DEFINITIONS[key].unit;
}

function resolveScrollback(
  provenance: TerminalResourceConfigProvenance,
  effectiveValue: number,
): { value: number; source: string; sourceKind: TerminalResourcePolicyValue['sourceKind']; legacyAlias?: string } {
  if (provenance.canonicalScrollback.presence === 'present-invalid') {
    throw new TerminalResourcePolicyInputError('terminal.scrollbackLines', 'invalid-source-value');
  }
  if (provenance.canonicalScrollback.presence === 'present-valid') {
    return {
      value: provenance.canonicalScrollback.value as number,
      source: 'resourceLimits.terminal.scrollbackLines',
      sourceKind: provenance.origin === 'runtime-replacement' ? 'runtime-replacement' : 'canonical-explicit',
    };
  }
  if (provenance.legacyScrollback.presence === 'present-invalid') {
    throw new TerminalResourcePolicyInputError('terminal.scrollbackLines', 'invalid-source-value');
  }
  if (provenance.legacyScrollback.presence === 'present-valid') {
    return {
      value: provenance.legacyScrollback.value as number,
      source: 'pty.scrollbackLines',
      sourceKind: 'legacy-explicit',
      legacyAlias: 'pty.scrollbackLines',
    };
  }
  return {
    value: effectiveValue,
    source: 'resourceLimits.terminal.scrollbackLines',
    sourceKind: provenance.canonicalScrollback.presence === 'unknown-effective'
      ? 'effective-only-unknown'
      : 'schema-default',
  };
}

export function compileTerminalResourcePolicy(
  input: CompileTerminalResourcePolicyInput,
): CompiledTerminalResourcePolicy {
  const provenance = input.provenance
    ?? (input.rawConfig === undefined
      ? {
          origin: 'effective-only-unknown' as const,
          canonicalResources: Object.fromEntries(
            TERMINAL_RESOURCE_KEYS.map((key) => [key, { presence: 'unknown-effective' as const }]),
          ) as Record<TerminalResourceKey, SanitizedPresence>,
          canonicalScrollback: { presence: 'unknown-effective' as const },
          legacyScrollback: { presence: 'unknown-effective' as const },
        }
      : captureTerminalResourceConfigProvenance(input.rawConfig, 'test-explicit'));
  const resources = {} as Record<TerminalResourceKey, TerminalResourcePolicyValue>;
  for (const key of TERMINAL_RESOURCE_KEYS) {
    const definition = RESOURCE_DEFINITIONS[key];
    const presence = provenance.canonicalResources?.[key]
      ?? (key === 'resourceLimits.terminal.scrollbackLines'
        ? provenance.canonicalScrollback
        : provenance.origin === 'effective-only-unknown'
          ? { presence: 'unknown-effective' as const }
          : { presence: 'absent' as const });
    if (presence.presence === 'present-invalid') {
      throw new TerminalResourcePolicyInputError(
        key === 'resourceLimits.terminal.scrollbackLines' ? 'terminal.scrollbackLines' : key,
        'invalid-source-value',
      );
    }
    resources[key] = {
      value: getEffectiveValue(input.effectiveResourceLimits, key),
      unit: definition.unit,
      source: key,
      sourceKind: provenance.origin === 'runtime-replacement'
        ? 'runtime-replacement'
        : presence.presence === 'present-valid'
          ? 'canonical-explicit'
          : presence.presence === 'unknown-effective'
          ? 'effective-only-unknown'
          : 'schema-default',
      applyBoundary: definition.applyBoundary,
    };
  }
  const scrollback = resolveScrollback(
    provenance,
    input.effectiveResourceLimits.terminal.scrollbackLines,
  );
  resources['resourceLimits.terminal.scrollbackLines'] = {
    ...resources['resourceLimits.terminal.scrollbackLines'],
    ...scrollback,
  };
  const legacyPolicy: LegacyTerminalResourcePolicy = {
    policyId: LEGACY_TERMINAL_RESOURCE_POLICY_ID,
    schemaVersion: input.schemaVersion,
    profileVersion: input.profileVersion,
    resources,
    terminal: {
      scrollbackLines: resources['resourceLimits.terminal.scrollbackLines'] as TerminalResourcePolicyValue<number>,
    },
  };
  const diagnostics: CompiledTerminalResourcePolicy['diagnostics'] = [];
  if (
    provenance.canonicalScrollback.presence === 'present-valid'
    && provenance.legacyScrollback.presence === 'present-valid'
    && provenance.canonicalScrollback.value !== provenance.legacyScrollback.value
  ) {
    diagnostics.push({
      code: 'source-conflict',
      resource: 'terminal.scrollbackLines',
      canonicalSource: 'resourceLimits.terminal.scrollbackLines',
      legacySource: 'pty.scrollbackLines',
    });
  }
  const candidate: TerminalResourceCandidateResult = input.candidateSelection === undefined
    ? { status: 'unavailable', reason: 'candidate-policy-not-selected' }
    : {
        status: 'unavailable',
        policyId: input.candidateSelection.policyId,
        profileVersion: input.candidateSelection.profileVersion,
        reason: 'candidate-policy-not-registered',
      };

  return {
    mode: 'observe',
    appliedPolicyId: legacyPolicy.policyId,
    provenance: structuredClone(provenance),
    legacyPolicy,
    candidate,
    diagnostics,
  };
}

export interface TerminalResourcePolicyObservation {
  consumer: TerminalResourcePolicyConsumerId;
  resource: TerminalResourceKey;
  legacyDecision: TerminalResourceScalar | null;
  candidateDecision: TerminalResourceScalar | null;
  source: string;
  unit: string;
  schemaVersion: string;
  profileVersion: string;
  differenceReason: TerminalResourcePolicyDifferenceReason;
}

const CONSUMER_ID_SET = new Set<string>(TERMINAL_RESOURCE_POLICY_CONSUMER_IDS);
const RESOURCE_KEY_SET = new Set<string>(TERMINAL_RESOURCE_KEYS);
const DECISION_SOURCE_SET = new Set<string>([
  ...TERMINAL_RESOURCE_KEYS,
  'pty.scrollbackLines',
  'TerminalView:xterm-constructor-hardcoded',
]);
const DIFFERENCE_REASON_SET = new Set<string>([
  'legacy-only',
  'candidate-unavailable',
  'candidate-equal',
  'candidate-differs',
  'source-conflict',
  'runtime-divergence',
  'reserved-unapplied',
] satisfies TerminalResourcePolicyDifferenceReason[]);

interface TerminalResourceActualDecision {
  legacyDecision: TerminalResourceScalar | null;
  source: string;
}

export function createTerminalResourcePolicyObserver(options: { capacity: number }): {
  record: (input: {
    consumer: TerminalResourcePolicyConsumerId;
    resource: TerminalResourceKey;
    compiled: CompiledTerminalResourcePolicy;
    differenceReason: TerminalResourcePolicyDifferenceReason;
    actualDecision?: TerminalResourceActualDecision;
  }) => void;
  snapshot: () => TerminalResourcePolicyObservation[];
} {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) {
    throw new RangeError('TerminalResourcePolicy observer capacity must be a positive integer');
  }
  const observations: TerminalResourcePolicyObservation[] = [];
  return {
    record(input): void {
      if (!CONSUMER_ID_SET.has(input.consumer)) throw new TypeError('consumer must be an allowlist value');
      if (!RESOURCE_KEY_SET.has(input.resource)) throw new TypeError('resource must be an allowlist value');
      if (!DIFFERENCE_REASON_SET.has(input.differenceReason)) throw new TypeError('differenceReason must be an allowlist value');
      const legacy = input.compiled.legacyPolicy.resources[input.resource];
      const actualDecision = input.actualDecision ?? {
        legacyDecision: legacy.value,
        source: legacy.source,
      };
      if (!DECISION_SOURCE_SET.has(actualDecision.source)) throw new TypeError('actualDecision.source must be an allowlist value');
      if (
        actualDecision.legacyDecision !== null
        && typeof actualDecision.legacyDecision !== 'string'
        && (typeof actualDecision.legacyDecision !== 'number' || !Number.isFinite(actualDecision.legacyDecision))
      ) {
        throw new TypeError('actualDecision.legacyDecision must be a finite scalar or null');
      }
      if (
        (input.differenceReason === 'reserved-unapplied')
        !== (actualDecision.legacyDecision === null)
      ) {
        throw new TypeError('reserved-unapplied decisions must use a null legacyDecision');
      }
      if (actualDecision.legacyDecision === null) {
        if (actualDecision.source !== input.resource) {
          throw new TypeError('reserved-unapplied source must match the resource allowlist key');
        }
      } else if (actualDecision.source === 'pty.scrollbackLines') {
        if (
          input.resource !== 'resourceLimits.terminal.scrollbackLines'
          || typeof actualDecision.legacyDecision !== 'number'
        ) {
          throw new TypeError('pty.scrollbackLines is only valid for numeric terminal scrollback decisions');
        }
      } else if (actualDecision.source === 'TerminalView:xterm-constructor-hardcoded') {
        if (
          input.resource !== 'resourceLimits.terminal.scrollbackLines'
          || actualDecision.legacyDecision !== 10_000
        ) {
          throw new TypeError('TerminalView hardcoded source must use its known scrollback decision');
        }
      } else if (
        actualDecision.source !== input.resource
        || actualDecision.legacyDecision !== legacy.value
      ) {
        throw new TypeError('canonical actualDecision must match the compiled resource decision');
      }
      const candidate = input.compiled.candidate.status === 'available'
        ? input.compiled.candidate.resources?.[input.resource]
        : undefined;
      observations.push({
        consumer: input.consumer,
        resource: input.resource,
        legacyDecision: actualDecision.legacyDecision,
        candidateDecision: candidate?.value ?? null,
        source: actualDecision.source,
        unit: legacy.unit,
        schemaVersion: input.compiled.legacyPolicy.schemaVersion,
        profileVersion: input.compiled.legacyPolicy.profileVersion,
        differenceReason: input.differenceReason,
      });
      if (observations.length > options.capacity) {
        observations.splice(0, observations.length - options.capacity);
      }
    },
    snapshot: () => observations.map((entry) => ({ ...entry })),
  };
}

export type TerminalResourceConsumerState = 'consumed' | 'reserved-unapplied' | 'divergent-legacy';
interface RuntimePolicyConfigView {
  stabilityModes: StabilityModesConfig;
  resourceLimits: ResourceLimitsConfig;
}

interface PublicRuntimeResourceView {
  resourceLimits: Pick<ResourceLimitsConfig, 'clientWs' | 'terminal' | 'snapshots' | 'workspaceRuntime'>;
}

export function createLegacyTerminalResourceDecisionSnapshot(
  editable: RuntimePolicyConfigView,
  publicConfig: PublicRuntimeResourceView,
): Record<string, unknown> {
  return {
    admission: {
      headlessQueueMode: editable.stabilityModes.headlessQueueMode,
      wsSendMode: editable.stabilityModes.wsSendMode,
    },
    cap: {
      ...structuredClone(editable.resourceLimits.headless),
      ...structuredClone(editable.resourceLimits.ws),
      ...structuredClone(publicConfig.resourceLimits.terminal),
      maxLiveWorkspaces: publicConfig.resourceLimits.workspaceRuntime.maxLiveWorkspaces,
      maxLiveTerminals: publicConfig.resourceLimits.workspaceRuntime.maxLiveTerminals,
    },
    expiry: {
      inputQueueTtlMs: publicConfig.resourceLimits.terminal.inputQueueTtlMs,
      transportOutboxTtlMs: publicConfig.resourceLimits.terminal.transportOutboxTtlMs,
      tombstoneTtlMs: publicConfig.resourceLimits.snapshots.tombstoneTtlMs,
      hiddenRuntimeTtlMs: publicConfig.resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs,
    },
    drop: {
      hiddenOutputPolicy: publicConfig.resourceLimits.terminal.hiddenOutputPolicy,
      hiddenOutputTailBytes: publicConfig.resourceLimits.terminal.hiddenOutputTailBytes,
    },
    reconnect: structuredClone(publicConfig.resourceLimits.clientWs),
    recovery: structuredClone(publicConfig.resourceLimits.snapshots),
    order: 'legacy-fifo',
    generation: 'runtime-config-snapshot',
  };
}

export function createTerminalResourceDecisionHash(decisions: unknown): string {
  return createHash('sha256').update(JSON.stringify(decisions)).digest('hex');
}

export function createLegacyAppliedPolicyIds(
  policyId = LEGACY_TERMINAL_RESOURCE_POLICY_ID,
): Record<TerminalResourcePolicyConsumerId, string> {
  return Object.fromEntries(
    TERMINAL_RESOURCE_POLICY_CONSUMER_IDS.map((consumerId) => [consumerId, policyId]),
  ) as Record<TerminalResourcePolicyConsumerId, string>;
}
