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
  TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
  TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
  compileTerminalResourcePolicy,
  createRuntimeReplacementTerminalResourceProvenance,
  createLegacyTerminalResourceDecisionSnapshot,
  createTerminalResourcePolicyObserver,
  createTerminalResourceDecisionHash,
  getRegisteredTerminalResourcePolicyObservationDecisions,
  getTerminalResourceConfigProvenance,
  type CompiledTerminalResourcePolicy,
  type TerminalResourceCandidateSelection,
  type TerminalResourceConfigProvenance,
  type TerminalResourceKey,
  type TerminalResourcePolicyConsumerId,
  type TerminalResourcePolicyDifferenceReason,
} from './TerminalResourcePolicy.js';
import type {
  SessionManager,
  TerminalResourcePolicyHeadlessDrainBoundary,
} from './SessionManager.js';
import type { WsRouter } from '../ws/WsRouter.js';
import type { WsTransportMessage } from '../ws/wsSendPolicy.js';
import {
  createTerminalResourcePolicyLeaseIssuer,
  type TerminalResourcePolicyCanaryTarget,
  type TerminalResourcePolicyLease,
  type TerminalResourcePolicyLeaseAuthority,
} from './TerminalResourcePolicyCanary.js';
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
  'resourceLimits.ws.serverBufferedHighWaterBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.ws.serverBufferedHardLimitBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 536870912) },
  'resourceLimits.ws.perClientOutputQueueMaxBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 268435456) },
  'resourceLimits.ws.perClientControlQueueMaxBytes': { applyScope: 'immediate', writeOnly: false, constraints: bytes(1024, 16777216) },
  'resourceLimits.ws.outputCoalesceWindowMs': { applyScope: 'immediate', writeOnly: false, constraints: ms(1, 1000) },
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
  'stabilityModes.wsSendMode': { applyScope: 'immediate', writeOnly: false },
  'stabilityModes.frontendRuntimeResidency': { applyScope: 'immediate', writeOnly: false },
};

const UNAVAILABLE_SETTING_PREFIX_REASONS = [
  {
    prefix: 'resourceLimits.telemetry.',
    reason: 'Reserved for a later stability wave; not applied by the current runtime',
  },
] as const;
const RESERVED_WAVE6_SETTING_REASON = 'Reserved outside the selected Wave6 Settings field set';
const RESERVED_WAVE6_SETTING_KEYS = new Set<EditableSettingsKey>([
  'stabilityModes.headlessQueueMode',
  'stabilityModes.wsSendMode',
  'stabilityModes.frontendRuntimeResidency',
  'resourceLimits.headless.writeLagWarnMs',
  'resourceLimits.headless.writeBatchMaxBytes',
  'resourceLimits.headless.overflowPolicy',
  'resourceLimits.ws.perClientControlQueueMaxBytes',
  'resourceLimits.ws.outputCoalesceWindowMs',
  'resourceLimits.terminal.visibleOutputQueueMaxBytes',
  'resourceLimits.terminal.visibleOutputMaxChunks',
  'resourceLimits.terminal.visibleFlushBudgetBytes',
  'resourceLimits.terminal.scrollbackLines',
]);
const RESERVED_WAVE6_SETTING_REASONS = new Map<EditableSettingsKey, string>(
  [...RESERVED_WAVE6_SETTING_KEYS].map((key) => [key, RESERVED_WAVE6_SETTING_REASON]),
);
const DEFAULT_WS_TRANSPORT_MODE: WsTransportMode = 'unified';

export interface PublicRuntimeConfig {
  inputReliabilityMode: InputReliabilityMode;
  wsTransportMode: WsTransportMode;
  stabilityModes: Pick<StabilityModesConfig, 'frontendRuntimeResidency'>;
  resourceLimits: Pick<ResourceLimitsConfig, 'clientWs' | 'terminal' | 'snapshots' | 'workspaceRuntime'>;
}

export interface RuntimeConfigStoreOptions {
  terminalResourcePolicy?: {
    observation: 'disabled' | 'observe';
    candidateSelection?: TerminalResourceCandidateSelection;
    authority?: TerminalResourcePolicyLeaseAuthority;
  };
}

interface HeadlessCanaryLedgerEntry {
  sequence: number;
  event: string;
  resource: TerminalResourcePolicyLease['resource'];
  consumer: TerminalResourcePolicyLease['consumer'];
  target: TerminalResourcePolicyCanaryTarget;
  policyGeneration: number;
  policyId: string;
  profileVersion: string;
  previousEffectiveDecision: number;
  nextEffectiveDecision: number;
  accepted: boolean;
  reason: string;
  rollbackResult: string | null;
}

interface HeadlessCanaryState {
  legacyDecision: number;
  effectiveDecision: number;
  policyGeneration: number;
  rollbackState: 'inactive' | 'draining' | 'closed';
  rollbackLease?: TerminalResourcePolicyLease;
  rollbackAwaitGeneration?: number;
  rollbackBoundary?: TerminalResourcePolicyHeadlessDrainBoundary;
  rollbackTargetRevoked?: boolean;
  rollbackPreviousDecision?: number;
  activeLease?: TerminalResourcePolicyLease;
  totalEvents: number;
  droppedEntries: number;
  entries: HeadlessCanaryLedgerEntry[];
}

export class RuntimeConfigStore {
  private values: EditableSettingsValues;
  private readonly capabilities: Record<EditableSettingsKey, FieldCapability>;
  private readonly excludedSections = [...EXCLUDED_SECTIONS];
  private secretState: EditableSettingsSnapshot['secretState'];
  private wsTransportMode: WsTransportMode;
  private sourceConfig: Config;
  private terminalPolicyProvenance: TerminalResourceConfigProvenance;
  private readonly terminalPolicyOptions: NonNullable<RuntimeConfigStoreOptions['terminalResourcePolicy']>;
  private terminalPolicyObserver: ReturnType<typeof createTerminalResourcePolicyObserver>;
  private readonly terminalResourcePolicyAuthority: TerminalResourcePolicyLeaseAuthority;
  private readonly terminalResourcePolicyHeadlessStates = new Map<string, HeadlessCanaryState>();
  private readonly terminalResourcePolicyBoundHeadlessManagers = new WeakSet<SessionManager>();
  readonly terminalResourcePolicyCanaryRegistries = {
    targetHandles: new Map<string, unknown>(),
    listeners: new Set<unknown>(),
    timers: new Set<unknown>(),
    retainedEntries: new Map<string, unknown>(),
  };

  constructor(
    source: Config = globalConfig,
    private readonly platform: NodeJS.Platform = process.platform,
    options: RuntimeConfigStoreOptions = {},
  ) {
    this.terminalPolicyProvenance = getTerminalResourceConfigProvenance(source);
    this.sourceConfig = structuredClone(source);
    this.values = buildEditableValues(source, platform);
    this.terminalPolicyOptions = options.terminalResourcePolicy ?? { observation: 'observe' };
    this.terminalResourcePolicyAuthority = options.terminalResourcePolicy?.authority
      ?? createTerminalResourcePolicyLeaseIssuer({
        trustedEvidence: {
          requirementId: 'OBS-BGSTAB-005',
          status: 'implemented',
          manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
        },
        contracts: [],
      });
    this.terminalPolicyObserver = createTerminalResourcePolicyObserver({
      capacity: this.values.resourceLimits.telemetry.recentEventLimit,
    });
    this.seedTerminalResourcePolicyObservations();
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

  getTerminalResourcePolicyObservation() {
    const publicConfig = this.getPublicRuntimeConfig('queue');
    const compiled = this.compileTerminalResourcePolicy();
    const decisionInputs = createLegacyTerminalResourceDecisionSnapshot(this.values, publicConfig);
    const canonicalScrollback = compiled.legacyPolicy.resources['resourceLimits.terminal.scrollbackLines'];
    const decisionStack = {
      evidenceKind: 'runtime-config-consumer-input-stack',
      inputs: decisionInputs,
      scrollback: {
        canonical: {
          value: canonicalScrollback.value,
          source: canonicalScrollback.source,
          appliedByKnownRuntimeConsumer: false,
        },
        serverHeadless: {
          value: this.sourceConfig.pty.scrollbackLines,
          source: 'pty.scrollbackLines',
          owner: 'SessionManager.initializeHeadlessState',
        },
        browserXterm: {
          value: 10_000,
          source: 'TerminalView:xterm-constructor-hardcoded',
          owner: 'TerminalView.Terminal-constructor',
        },
      },
      reservedUnapplied: [
        'resourceLimits.headless.writeBatchMaxBytes',
        'resourceLimits.headless.writeLagWarnMs',
        'resourceLimits.terminal.scrollbackLines',
      ],
      order: 'legacy-fifo',
      generation: 'runtime-config-snapshot',
    } as const;

    return {
      ...compiled,
      observationMode: this.terminalPolicyOptions.observation,
      decisionEvidence: {
        owner: 'RuntimeConfigStore',
        kind: 'consumer-input-projection',
        runtimeApplicationClaimed: false,
      } as const,
      decisionStack,
      decisionStackHash: createTerminalResourceDecisionHash(decisionStack),
      recentObservations: this.terminalPolicyObserver.snapshot(),
    };
  }

  recordTerminalResourcePolicyDecision(input: {
    consumer: TerminalResourcePolicyConsumerId;
    resource: TerminalResourceKey;
    differenceReason: TerminalResourcePolicyDifferenceReason;
  }): boolean {
    if (this.terminalPolicyOptions.observation !== 'observe') return false;
    this.terminalPolicyObserver.record({
      ...input,
      compiled: this.compileTerminalResourcePolicy(),
    });
    return true;
  }

  private seedTerminalResourcePolicyObservations(): void {
    if (this.terminalPolicyOptions.observation !== 'observe') return;
    const compiled = this.compileTerminalResourcePolicy();
    const sourceConflict = compiled.diagnostics.some((entry) => entry.code === 'source-conflict');
    for (const decision of getRegisteredTerminalResourcePolicyObservationDecisions()) {
      const differenceReason: TerminalResourcePolicyDifferenceReason =
        decision.state === 'reserved-unapplied'
          ? 'reserved-unapplied'
          : decision.state === 'divergent-legacy'
          ? 'runtime-divergence'
          : sourceConflict && decision.resource === 'resourceLimits.terminal.scrollbackLines'
            ? 'source-conflict'
            : compiled.candidate.reason === 'candidate-policy-not-selected'
              ? 'legacy-only'
              : 'candidate-unavailable';
      const compiledDecision = compiled.legacyPolicy.resources[decision.resource];
      const actualDecision = decision.state === 'reserved-unapplied'
        ? {
            legacyDecision: null,
            source: decision.source,
          }
        : decision.resource === 'resourceLimits.terminal.scrollbackLines'
          && decision.consumer === 'server.pty.headless-model'
          ? {
              legacyDecision: this.sourceConfig.pty.scrollbackLines,
              source: 'pty.scrollbackLines',
            }
          : decision.resource === 'resourceLimits.terminal.scrollbackLines'
            && decision.consumer === 'browser.terminal.write-scheduler'
            ? {
                legacyDecision: 10_000,
                source: 'TerminalView:xterm-constructor-hardcoded',
              }
            : {
                legacyDecision: compiledDecision.value,
                source: compiledDecision.source,
              };
      this.terminalPolicyObserver.record({
        consumer: decision.consumer,
        resource: decision.resource,
        compiled,
        differenceReason,
        actualDecision,
      });
    }
  }

  private resetTerminalResourcePolicyObserver(): void {
    this.terminalPolicyObserver = createTerminalResourcePolicyObserver({
      capacity: this.values.resourceLimits.telemetry.recentEventLimit,
    });
    this.seedTerminalResourcePolicyObservations();
  }

  private compileTerminalResourcePolicy(): CompiledTerminalResourcePolicy {
    return compileTerminalResourcePolicy({
      provenance: this.terminalPolicyProvenance,
      effectiveResourceLimits: this.values.resourceLimits,
      schemaVersion: TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
      profileVersion: TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
      candidateSelection: this.terminalPolicyOptions.candidateSelection,
    });
  }

  // @req REL-BGSTAB-010
  issueTerminalResourcePolicyLease(
    input: Parameters<TerminalResourcePolicyLeaseAuthority['issue']>[0],
  ) {
    return this.terminalResourcePolicyAuthority.issue(input);
  }

  // @req REL-BGSTAB-010
  previewTerminalResourcePolicyCanaryAdmission(input: {
    wsRouter: WsRouter;
    lease: TerminalResourcePolicyLease;
    incomingMessage: WsTransportMessage;
  }) {
    return input.wsRouter.previewTerminalResourcePolicyCanaryAdmission({
      lease: input.lease,
      incomingMessage: input.incomingMessage,
    });
  }

  // @req REL-BGSTAB-010
  admitTerminalResourcePolicyCanaryMessage(input: {
    wsRouter: WsRouter;
    lease: TerminalResourcePolicyLease;
    incomingMessage: WsTransportMessage;
  }) {
    return input.wsRouter.admitTerminalResourcePolicyCanaryMessage({
      lease: input.lease,
      incomingMessage: input.incomingMessage,
    });
  }

  // @req REL-BGSTAB-010
  applyTerminalResourcePolicyLease(input: {
    wsRouter: WsRouter;
    sessionManager: SessionManager;
    lease: TerminalResourcePolicyLease;
  }): {
    mode: 'candidate' | 'legacy';
    reason: string;
    previousEffectiveDecision: number;
    nextEffectiveDecision: number;
  } {
    const grant = this.terminalResourcePolicyAuthority.resolve(input.lease);
    if (!grant || grant.metadata.targetEpoch !== grant.currentTargetEpoch) {
      const current = this.readTerminalResourcePolicyDecision(input);
      return {
        mode: 'legacy',
        reason: grant ? 'lease-revoked' : 'invalid-policy-lease',
        previousEffectiveDecision: current,
        nextEffectiveDecision: current,
      };
    }
    const compatible = grant.lease.target.kind === 'ws'
      ? grant.lease.resource === 'resourceLimits.ws.perClientOutputQueueMaxBytes'
        && grant.lease.consumer === 'server.ws.router'
      : grant.lease.resource === 'resourceLimits.headless.pendingOutputMaxBytes'
        && grant.lease.consumer === 'server.pty.headless-model';
    if (!compatible) {
      const current = this.readTerminalResourcePolicyDecision(input);
      return {
        mode: 'legacy', reason: 'resource-target-mismatch',
        previousEffectiveDecision: current, nextEffectiveDecision: current,
      };
    }
    if (grant.lease.target.kind === 'ws') {
      const previous = input.wsRouter.getTerminalResourcePolicyCanaryState(grant.lease.target)
        .effectiveDecision;
      const result = input.wsRouter.activateTerminalResourcePolicyLease({ lease: grant.lease });
      const next = input.wsRouter.getTerminalResourcePolicyCanaryState(grant.lease.target)
        .effectiveDecision;
      return {
        ...result,
        previousEffectiveDecision: previous,
        nextEffectiveDecision: next,
      };
    }
    const target = grant.lease.target;
    this.ensureHeadlessCanaryLifecycleBinding(input.sessionManager);
    const state = this.getOrCreateHeadlessCanaryState(input.sessionManager, target.sessionId);
    const previous = state.effectiveDecision;
    if (state.rollbackState === 'draining') {
      return {
        mode: 'legacy', reason: 'rollback-draining',
        previousEffectiveDecision: previous, nextEffectiveDecision: previous,
      };
    }
    if (!input.sessionManager.hasTerminalResourcePolicyHeadlessTarget(target.sessionId)) {
      this.appendHeadlessCanaryLedger(state, grant.lease, {
        event: 'adapter-transition-rejected',
        previousEffectiveDecision: previous,
        nextEffectiveDecision: grant.decision,
        accepted: false,
        reason: 'headless-target-missing',
        rollbackResult: 'not-applied',
      });
      return {
        mode: 'legacy', reason: 'headless-target-missing',
        previousEffectiveDecision: previous, nextEffectiveDecision: previous,
      };
    }
    state.policyGeneration += 1;
    state.effectiveDecision = grant.decision;
    state.rollbackState = 'inactive';
    state.rollbackLease = undefined;
    state.rollbackBoundary = undefined;
    state.rollbackPreviousDecision = undefined;
    state.activeLease = grant.lease;
    this.terminalResourcePolicyCanaryRegistries.targetHandles.set(
      `headless:${target.sessionId}`,
      state,
    );
    this.terminalResourcePolicyCanaryRegistries.retainedEntries.set(
      `headless:${target.sessionId}`,
      state,
    );
    this.appendHeadlessCanaryLedger(state, grant.lease, {
      event: 'candidate-selected',
      previousEffectiveDecision: previous,
      nextEffectiveDecision: grant.decision,
      accepted: true,
      reason: 'candidate-selected',
      rollbackResult: null,
    });
    return {
      mode: 'candidate', reason: 'candidate-selected',
      previousEffectiveDecision: previous, nextEffectiveDecision: grant.decision,
    };
  }

  // @req REL-BGSTAB-010
  rollbackTerminalResourcePolicyLease(input: {
    wsRouter: WsRouter;
    sessionManager: SessionManager;
    lease: TerminalResourcePolicyLease;
  }): { state: 'draining' | 'closed'; reason: string } {
    const grant = this.terminalResourcePolicyAuthority.resolve(input.lease);
    if (!grant || grant.metadata.targetEpoch !== grant.currentTargetEpoch) {
      return { state: 'closed', reason: grant ? 'lease-revoked' : 'invalid-policy-lease' };
    }
    if (grant.lease.target.kind === 'ws') {
      return input.wsRouter.rollbackTerminalResourcePolicyLease({ lease: grant.lease });
    }
    const sessionId = grant.lease.target.sessionId;
    const state = this.terminalResourcePolicyHeadlessStates.get(sessionId);
    if (
      !state
      || state.rollbackState !== 'inactive'
      || state.activeLease !== grant.lease
    ) {
      return { state: 'closed', reason: 'lease-not-active' };
    }
    const previous = state.effectiveDecision;
    const preRollbackGeneration = state.policyGeneration;
    const rollbackBoundary = input.sessionManager
      .captureTerminalResourcePolicyHeadlessDrainBoundary(sessionId);
    state.policyGeneration += 1;
    state.effectiveDecision = state.legacyDecision;
    state.rollbackState = 'draining';
    state.rollbackLease = grant.lease;
    state.rollbackAwaitGeneration = preRollbackGeneration;
    state.rollbackBoundary = rollbackBoundary;
    state.rollbackTargetRevoked = false;
    state.rollbackPreviousDecision = previous;
    state.activeLease = undefined;
    for (const [event, reason, rollbackResult] of [
      ['rollback-requested', 'rollback-requested', 'requested'],
      ['rollback-draining', 'rollback-draining', 'draining'],
    ] as const) {
      this.appendHeadlessCanaryLedger(state, grant.lease, {
        event,
        previousEffectiveDecision: previous,
        nextEffectiveDecision: state.legacyDecision,
        accepted: true,
        reason,
        rollbackResult,
      });
    }
    if (
      !rollbackBoundary
      || !input.sessionManager.hasPendingTerminalResourcePolicyHeadlessDrainBoundary(rollbackBoundary)
    ) {
      this.closeHeadlessCanaryRollback(state);
      return { state: 'closed', reason: 'rollback-closed' };
    }
    const drainToken = Object.freeze({ sessionId, policyGeneration: state.policyGeneration });
    this.terminalResourcePolicyCanaryRegistries.timers.add(drainToken);
    void input.sessionManager.waitForTerminalResourcePolicyHeadlessDrainBoundary(
      rollbackBoundary,
    ).then((drained) => {
      if (
        drained
        && this.terminalResourcePolicyHeadlessStates.get(sessionId) === state
      ) {
        this.closeHeadlessCanaryRollback(state);
      }
    }).finally(() => {
      this.terminalResourcePolicyCanaryRegistries.timers.delete(drainToken);
    });
    return { state: 'draining', reason: 'rollback-draining' };
  }

  // @req REL-BGSTAB-010
  applyTerminalResourcePolicyLeaseBatch(input: {
    wsRouter: WsRouter;
    sessionManager: SessionManager;
    leases: readonly TerminalResourcePolicyLease[];
  }): {
    mode: 'candidate' | 'legacy';
    reason: string;
    appliedConsumers: string[];
    rolledBackConsumers: string[];
  } {
    const applied: TerminalResourcePolicyLease[] = [];
    for (const lease of input.leases) {
      const result = this.applyTerminalResourcePolicyLease({ ...input, lease });
      if (result.mode === 'candidate') {
        applied.push(lease);
        continue;
      }
      const rolledBackConsumers: string[] = [];
      for (const appliedLease of [...applied].reverse()) {
        this.rollbackTerminalResourcePolicyLease({ ...input, lease: appliedLease });
        rolledBackConsumers.unshift(appliedLease.consumer);
      }
      return {
        mode: 'legacy', reason: 'adapter-transition-failed',
        appliedConsumers: applied.map(item => item.consumer),
        rolledBackConsumers,
      };
    }
    return {
      mode: 'candidate', reason: 'candidate-selected',
      appliedConsumers: applied.map(item => item.consumer),
      rolledBackConsumers: [],
    };
  }

  // @req REL-BGSTAB-010
  getTerminalResourcePolicyCanaryLedger(input: {
    wsRouter: WsRouter;
    lease: TerminalResourcePolicyLease;
  }) {
    const grant = this.terminalResourcePolicyAuthority.resolve(input.lease);
    if (!grant) {
      return Object.freeze({
        denied: true, reason: 'invalid-policy-lease', capacity: 8,
        totalEvents: 0, droppedEntries: 0, entries: Object.freeze([]),
      });
    }
    if (grant.lease.target.kind === 'ws') {
      return input.wsRouter.getTerminalResourcePolicyCanaryLedger({ lease: grant.lease });
    }
    const state = this.terminalResourcePolicyHeadlessStates.get(grant.lease.target.sessionId);
    const entries = (state?.entries ?? []).map(entry => Object.freeze({
      ...entry,
      target: Object.freeze(structuredClone(entry.target)),
    }));
    return Object.freeze({
      capacity: 8,
      totalEvents: state?.totalEvents ?? 0,
      droppedEntries: state?.droppedEntries ?? 0,
      entries: Object.freeze(entries),
    });
  }

  // @req REL-BGSTAB-010
  previewHeadlessTerminalResourcePolicyAdmission(input: {
    sessionManager: SessionManager;
    lease: TerminalResourcePolicyLease;
    rawData: string;
  }) {
    const grant = this.terminalResourcePolicyAuthority.resolve(input.lease);
    if (!grant) {
      return { accepted: false, mode: 'legacy' as const, reason: 'invalid-policy-lease' };
    }
    if (
      grant.lease.target.kind !== 'headless'
      || grant.lease.resource !== 'resourceLimits.headless.pendingOutputMaxBytes'
      || grant.lease.consumer !== 'server.pty.headless-model'
    ) {
      return { accepted: false, mode: 'legacy' as const, reason: 'resource-target-mismatch' };
    }
    if (grant.metadata.targetEpoch !== grant.currentTargetEpoch) {
      return { accepted: false, mode: 'legacy' as const, reason: 'lease-revoked' };
    }
    if (!input.sessionManager.hasTerminalResourcePolicyHeadlessTarget(grant.lease.target.sessionId)) {
      return { accepted: false, mode: 'legacy' as const, reason: 'headless-target-missing' };
    }
    this.ensureHeadlessCanaryLifecycleBinding(input.sessionManager);
    const state = this.terminalResourcePolicyHeadlessStates.get(grant.lease.target.sessionId);
    if (
      !state
      || state.rollbackState !== 'inactive'
      || state.activeLease !== grant.lease
    ) {
      return { accepted: false, mode: 'legacy' as const, reason: 'lease-not-active' };
    }
    return {
      resource: 'resourceLimits.headless.pendingOutputMaxBytes' as const,
      consumer: 'server.pty.headless-model' as const,
      target: grant.lease.target,
      rawUtf8Bytes: Buffer.byteLength(input.rawData, 'utf8'),
    };
  }

  // @req REL-BGSTAB-010
  admitHeadlessTerminalResourcePolicyData(input: {
    sessionManager: SessionManager;
    lease: TerminalResourcePolicyLease;
    rawData: string;
  }) {
    const grant = this.terminalResourcePolicyAuthority.resolve(input.lease);
    if (!grant) {
      return {
        accepted: false, mode: 'legacy' as const,
        reason: 'invalid-policy-lease',
        enqueuedExactlyOnce: false, policyGeneration: 0,
      };
    }
    if (grant.lease.target.kind !== 'headless'
      || grant.lease.resource !== 'resourceLimits.headless.pendingOutputMaxBytes'
      || grant.lease.consumer !== 'server.pty.headless-model') {
      return {
        accepted: false, mode: 'legacy' as const, reason: 'resource-target-mismatch',
        enqueuedExactlyOnce: false, policyGeneration: 0,
      };
    }
    if (grant.metadata.targetEpoch !== grant.currentTargetEpoch) {
      return {
        accepted: false, mode: 'legacy' as const, reason: 'lease-revoked',
        enqueuedExactlyOnce: false, policyGeneration: 0,
      };
    }
    const state = this.terminalResourcePolicyHeadlessStates.get(grant.lease.target.sessionId);
    if (
      !state
      || state.rollbackState !== 'inactive'
      || state.activeLease !== grant.lease
    ) {
      return {
        accepted: false, mode: 'legacy' as const, reason: 'lease-not-active',
        enqueuedExactlyOnce: false, policyGeneration: state?.policyGeneration ?? 0,
      };
    }
    const rawBytes = Buffer.byteLength(input.rawData, 'utf8');
    const usage = input.sessionManager.getTerminalResourcePolicyHeadlessPendingUsage(
      grant.lease.target.sessionId,
      state.policyGeneration,
    );
    const budget = this.decideHeadlessAdmissionBudget(
      input.sessionManager,
      grant.lease.target.sessionId,
      state,
      rawBytes,
      usage,
    );
    const mode = budget.mode;
    const admissionGeneration = state.policyGeneration;
    const reason = mode === 'legacy'
      ? 'candidate-cap-exceeded-fallback'
      : 'candidate-admission-accepted';
    const appended = input.sessionManager.appendTerminalResourcePolicyHeadlessData(
      grant.lease.target.sessionId,
      input.rawData,
      {
        policyGeneration: admissionGeneration,
        exactlyOnceKey: `headless-${grant.metadata.issuanceSequence}-${state.totalEvents + 1}`,
        outputMaxBytes: budget.outputMaxBytes,
        outputMaxChunks: budget.outputMaxChunks,
        admissionMode: mode,
        settleFailure: (failureReason) => {
          this.settleHeadlessCanaryFailure(
            input.sessionManager,
            state,
            grant.lease,
            failureReason,
            true,
          );
        },
      },
    );
    if (!appended.ok) {
      const failureReason = appended.reason === 'target-missing'
        ? 'headless-target-missing'
        : appended.reason === 'chunk-limit'
          ? 'legacy-headless-chunk-limit'
          : 'legacy-headless-byte-limit';
      this.appendHeadlessCanaryLedger(state, grant.lease, {
        event: 'admission-rejected',
        previousEffectiveDecision: state.effectiveDecision,
        nextEffectiveDecision: state.effectiveDecision,
        accepted: false,
        reason: failureReason,
        rollbackResult: null,
      });
      this.settleHeadlessCanaryFailure(
        input.sessionManager,
        state,
        grant.lease,
        failureReason,
        false,
      );
      return {
        accepted: false, mode: 'legacy' as const, reason: failureReason,
        enqueuedExactlyOnce: false, policyGeneration: admissionGeneration,
      };
    }
    this.appendHeadlessCanaryLedger(state, grant.lease, {
      event: 'admission-accepted',
      previousEffectiveDecision: state.effectiveDecision,
      nextEffectiveDecision: state.effectiveDecision,
      accepted: true,
      reason,
      rollbackResult: null,
    });
    return {
      accepted: true, mode, reason, enqueuedExactlyOnce: true,
      policyGeneration: admissionGeneration,
    };
  }

  private readTerminalResourcePolicyDecision(input: {
    wsRouter: WsRouter;
    sessionManager: SessionManager;
    lease: TerminalResourcePolicyLease;
  }): number {
    if (input.lease.target.kind === 'ws') {
      return input.wsRouter.getTerminalResourcePolicyCanaryState(input.lease.target)
        .effectiveDecision;
    }
    return this.readHeadlessLimit(
      input.sessionManager,
      input.lease.target.kind === 'headless' ? input.lease.target.sessionId : undefined,
    );
  }

  private readHeadlessLimit(sessionManager: SessionManager, sessionId?: string): number {
    if (sessionId) {
      const sessionLimit = sessionManager.getTerminalResourcePolicyHeadlessLegacyLimit(sessionId);
      if (sessionLimit !== undefined) return sessionLimit;
    }
    return (sessionManager as unknown as {
      runtimeHeadlessQueueConfig: { limits: { pendingOutputMaxBytes: number } };
    }).runtimeHeadlessQueueConfig.limits.pendingOutputMaxBytes;
  }

  private readHeadlessPendingBytes(sessionManager: SessionManager, sessionId: string): number {
    return (sessionManager as unknown as {
      sessions: Map<string, { pendingHeadlessOutputBytes: number }>;
    }).sessions.get(sessionId)?.pendingHeadlessOutputBytes ?? 0;
  }

  private decideHeadlessAdmissionBudget(
    sessionManager: SessionManager,
    sessionId: string,
    state: HeadlessCanaryState,
    rawBytes: number,
    usage: {
      totalBytes: number;
      totalChunks: number;
      generationBytes: number;
      generationChunks: number;
      generationLegacyBytes: number;
      generationLegacyChunks: number;
    },
  ) {
    const legacyMaxChunks = sessionManager.getTerminalResourcePolicyHeadlessLegacyChunkLimit(sessionId)
      ?? this.values.resourceLimits.headless.pendingOutputMaxChunks;
    const candidate = state.rollbackState === 'inactive'
      && usage.totalBytes + rawBytes <= state.effectiveDecision
      && usage.totalChunks + 1 <= legacyMaxChunks;
    if (candidate) {
      return {
        mode: 'candidate' as const,
        outputMaxBytes: state.effectiveDecision,
        outputMaxChunks: legacyMaxChunks,
      };
    }
    return {
      mode: 'legacy' as const,
      outputMaxBytes: Math.max(0, usage.totalBytes - usage.generationLegacyBytes)
        + state.legacyDecision,
      outputMaxChunks: state.rollbackState === 'draining'
        ? Math.max(0, usage.totalChunks - usage.generationChunks) + legacyMaxChunks
        : legacyMaxChunks,
    };
  }

  private getOrCreateHeadlessCanaryState(
    sessionManager: SessionManager,
    sessionId: string,
  ): HeadlessCanaryState {
    const existing = this.terminalResourcePolicyHeadlessStates.get(sessionId);
    if (existing) return existing;
    const decision = this.readHeadlessLimit(sessionManager, sessionId);
    const state: HeadlessCanaryState = {
      legacyDecision: decision,
      effectiveDecision: decision,
      policyGeneration: 0,
      rollbackState: 'inactive',
      totalEvents: 0,
      droppedEntries: 0,
      entries: [],
    };
    this.terminalResourcePolicyHeadlessStates.set(sessionId, state);
    return state;
  }

  private ensureHeadlessCanaryLifecycleBinding(sessionManager: SessionManager): void {
    if (this.terminalResourcePolicyBoundHeadlessManagers.has(sessionManager)) return;
    const unbindAdmissionPort = sessionManager.bindTerminalResourcePolicyHeadlessAdmissionPort({
      decide: (input) => this.decideProductionHeadlessAdmission(sessionManager, input),
    });
    this.terminalResourcePolicyCanaryRegistries.listeners.add(unbindAdmissionPort);
    const unsubscribe = sessionManager.onTerminalResourcePolicyHeadlessTargetFinalized((sessionId) => {
      this.terminalResourcePolicyAuthority.revokeTarget({ kind: 'headless', sessionId });
      this.terminalResourcePolicyHeadlessStates.delete(sessionId);
      this.terminalResourcePolicyCanaryRegistries.targetHandles.delete(`headless:${sessionId}`);
      this.terminalResourcePolicyCanaryRegistries.retainedEntries.delete(`headless:${sessionId}`);
    });
    this.terminalResourcePolicyCanaryRegistries.listeners.add(unsubscribe);
    this.terminalResourcePolicyBoundHeadlessManagers.add(sessionManager);
  }

  private decideProductionHeadlessAdmission(sessionManager: SessionManager, input: {
    sessionId: string;
    rawData: string;
    pendingBytes: number;
    pendingChunks: number;
    pendingBytesByPolicyGeneration: ReadonlyMap<number, number>;
    pendingChunksByPolicyGeneration: ReadonlyMap<number, number>;
    pendingLegacyBytesByPolicyGeneration: ReadonlyMap<number, number>;
    pendingLegacyChunksByPolicyGeneration: ReadonlyMap<number, number>;
  }) {
    const state = this.terminalResourcePolicyHeadlessStates.get(input.sessionId);
    const lease = state?.rollbackState === 'draining'
      ? state.rollbackLease
      : state?.activeLease;
    if (!state || !lease || lease.target.kind !== 'headless') return undefined;
    const grant = this.terminalResourcePolicyAuthority.resolve(lease);
    if (!grant) return undefined;
    const rawBytes = Buffer.byteLength(input.rawData, 'utf8');
    const usage = {
      totalBytes: input.pendingBytes,
      totalChunks: input.pendingChunks,
      generationBytes: input.pendingBytesByPolicyGeneration.get(state.policyGeneration) ?? 0,
      generationChunks: input.pendingChunksByPolicyGeneration.get(state.policyGeneration) ?? 0,
      generationLegacyBytes: input.pendingLegacyBytesByPolicyGeneration.get(state.policyGeneration) ?? 0,
      generationLegacyChunks: input.pendingLegacyChunksByPolicyGeneration.get(state.policyGeneration) ?? 0,
    };
    const budget = this.decideHeadlessAdmissionBudget(
      sessionManager,
      input.sessionId,
      state,
      rawBytes,
      usage,
    );
    const candidate = budget.mode === 'candidate'
      && grant.metadata.targetEpoch === grant.currentTargetEpoch;
    const mode = candidate ? 'candidate' as const : 'legacy' as const;
    const reason = candidate
      ? 'candidate-admission-accepted'
      : 'candidate-cap-exceeded-fallback';
    const policyGeneration = state.policyGeneration;
    const metadata = grant.metadata;
    const exactlyOnceKey = `headless-pty-${metadata.issuanceSequence}-${policyGeneration}-${state.totalEvents + 1}`;
    return {
      mode,
      admissionMode: mode,
      reason,
      outputMaxBytes: budget.outputMaxBytes,
      outputMaxChunks: budget.outputMaxChunks,
      policyGeneration,
      exactlyOnceKey,
      record: (result: { ok: boolean; reason?: 'byte-limit' | 'chunk-limit' }) => {
        if (this.terminalResourcePolicyHeadlessStates.get(input.sessionId) !== state) return;
        const recordedReason = result.ok
          ? reason
          : result.reason === 'chunk-limit'
            ? 'legacy-headless-chunk-limit'
            : 'legacy-headless-byte-limit';
        this.appendHeadlessCanaryLedger(state, lease, {
          event: result.ok ? 'admission-accepted' : 'admission-rejected',
          previousEffectiveDecision: state.effectiveDecision,
          nextEffectiveDecision: state.effectiveDecision,
          accepted: result.ok,
          reason: recordedReason,
          rollbackResult: null,
        });
        if (!result.ok) {
          this.settleHeadlessCanaryFailure(
            sessionManager,
            state,
            lease,
            recordedReason,
            false,
          );
        }
      },
      settleFailure: (failureReason: 'headless-write-failed') => {
        this.settleHeadlessCanaryFailure(
          sessionManager,
          state,
          lease,
          failureReason,
          true,
        );
      },
    };
  }

  private settleHeadlessCanaryFailure(
    sessionManager: SessionManager,
    state: HeadlessCanaryState,
    lease: TerminalResourcePolicyLease,
    reason: string,
    recordRejection: boolean,
  ): void {
    if (
      state.rollbackState !== 'inactive'
      || state.activeLease !== lease
      || lease.target.kind !== 'headless'
    ) return;
    const sessionId = lease.target.sessionId;
    const previous = state.effectiveDecision;
    const preFailureGeneration = state.policyGeneration;
    const rollbackBoundary = sessionManager
      .captureTerminalResourcePolicyHeadlessDrainBoundary(sessionId);
    if (recordRejection) {
      this.appendHeadlessCanaryLedger(state, lease, {
        event: 'admission-rejected',
        previousEffectiveDecision: previous,
        nextEffectiveDecision: previous,
        accepted: false,
        reason,
        rollbackResult: null,
      });
    }
    state.policyGeneration += 1;
    state.effectiveDecision = state.legacyDecision;
    state.rollbackState = 'draining';
    state.rollbackLease = lease;
    state.rollbackAwaitGeneration = preFailureGeneration;
    state.rollbackBoundary = rollbackBoundary;
    state.rollbackPreviousDecision = previous;
    state.activeLease = undefined;
    this.terminalResourcePolicyAuthority.revokeTarget(lease.target);
    state.rollbackTargetRevoked = true;
    for (const [event, rollbackResult] of [
      ['rollback-requested', 'requested'],
      ['rollback-draining', 'draining'],
    ] as const) {
      this.appendHeadlessCanaryLedger(state, lease, {
        event,
        previousEffectiveDecision: previous,
        nextEffectiveDecision: state.legacyDecision,
        accepted: false,
        reason,
        rollbackResult,
      });
    }
    if (
      !rollbackBoundary
      || !sessionManager.hasPendingTerminalResourcePolicyHeadlessDrainBoundary(rollbackBoundary)
    ) {
      this.closeHeadlessCanaryRollback(state);
      return;
    }
    const drainToken = Object.freeze({
      sessionId,
      policyGeneration: preFailureGeneration,
      reason,
    });
    this.terminalResourcePolicyCanaryRegistries.timers.add(drainToken);
    void sessionManager.waitForTerminalResourcePolicyHeadlessDrainBoundary(
      rollbackBoundary,
    ).then((drained) => {
      if (drained && this.terminalResourcePolicyHeadlessStates.get(sessionId) === state) {
        this.closeHeadlessCanaryRollback(state);
      }
    }).finally(() => {
      this.terminalResourcePolicyCanaryRegistries.timers.delete(drainToken);
    });
  }

  private closeHeadlessCanaryRollback(state: HeadlessCanaryState): void {
    if (state.rollbackState !== 'draining' || !state.rollbackLease) return;
    const lease = state.rollbackLease;
    state.rollbackState = 'closed';
    if (!state.rollbackTargetRevoked) {
      this.terminalResourcePolicyAuthority.revokeTarget(lease.target);
    }
    if (lease.target.kind === 'headless') {
      this.terminalResourcePolicyCanaryRegistries.targetHandles.delete(
        `headless:${lease.target.sessionId}`,
      );
    }
    this.appendHeadlessCanaryLedger(state, lease, {
      event: 'rollback-closed',
      previousEffectiveDecision: state.rollbackPreviousDecision ?? state.effectiveDecision,
      nextEffectiveDecision: state.effectiveDecision,
      accepted: true,
      reason: 'rollback-closed',
      rollbackResult: 'closed',
    });
    state.rollbackLease = undefined;
    state.rollbackAwaitGeneration = undefined;
    state.rollbackBoundary = undefined;
    state.rollbackTargetRevoked = undefined;
    state.rollbackPreviousDecision = undefined;
  }

  private appendHeadlessCanaryLedger(
    state: HeadlessCanaryState,
    lease: TerminalResourcePolicyLease,
    input: Omit<HeadlessCanaryLedgerEntry,
      'sequence' | 'resource' | 'consumer' | 'target' | 'policyGeneration' | 'policyId' | 'profileVersion'>,
  ): void {
    state.entries.push({
      sequence: ++state.totalEvents,
      event: input.event,
      resource: lease.resource,
      consumer: lease.consumer,
      target: Object.freeze(structuredClone(lease.target)),
      policyGeneration: state.policyGeneration,
      policyId: lease.policyId,
      profileVersion: lease.profileVersion,
      previousEffectiveDecision: input.previousEffectiveDecision,
      nextEffectiveDecision: input.nextEffectiveDecision,
      accepted: input.accepted,
      reason: input.reason,
      rollbackResult: input.rollbackResult,
    });
    if (state.entries.length > 8) {
      const dropped = state.entries.length - 8;
      state.entries.splice(0, dropped);
      state.droppedEntries += dropped;
    }
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
    this.sourceConfig.resourceLimits = structuredClone(next.resourceLimits);
    this.terminalPolicyProvenance = createRuntimeReplacementTerminalResourceProvenance(next.resourceLimits);
    this.resetTerminalResourcePolicyObserver();
  }

  replaceFromConfig(config: Config): void {
    this.terminalPolicyProvenance = getTerminalResourceConfigProvenance(config);
    this.sourceConfig = structuredClone(config);
    this.values = buildEditableValues(config, this.platform);
    this.resetTerminalResourcePolicyObserver();
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
    const unavailableReason = getUnavailableSettingReason(key);
    if (unavailableReason !== undefined) {
      capabilities[key] = {
        ...capability,
        available: false,
        reason: unavailableReason,
      };
    }
  }

  capabilities['pty.shell'] = {
    ...capabilities['pty.shell'],
    options: getSettingsShellOptions(platform),
  };

  return capabilities;
}

function getUnavailableSettingReason(key: EditableSettingsKey): string | undefined {
  const reservedReason = RESERVED_WAVE6_SETTING_REASONS.get(key);
  if (reservedReason !== undefined) {
    return reservedReason;
  }

  return UNAVAILABLE_SETTING_PREFIX_REASONS.find(({ prefix }) => key.startsWith(prefix))?.reason;
}
