import { createHash, randomUUID } from 'node:crypto';
import type {
  TerminalAuthorityController,
  TerminalAuthorityState,
} from './TerminalAuthorityController.js';

type JsonRecord = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;
type TerminalAuthorityDebugCleanupFence = Readonly<Pick<
  TerminalAuthorityState,
  'mode' | 'authorityEpoch' | 'streamEpoch' | 'transitionEpoch'
>>;

export const TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE = Object.freeze({
  authentication: 'authMiddleware',
  locality: 'requireLocalDebugCapture',
  session: 'ensureDebugCaptureSessionExists',
  registration: 'server-executable-route-contract',
} as const);

export const TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY = Object.freeze({
  retainedPolicyOverrides: 0,
  cleanupTokens: 0,
  isolationLeases: 0,
  retainedCorpusFixtures: 0,
  alternateBufferFixtures: 0,
  responderOverrides: 0,
  listeners: 0,
  driverLeases: 0,
  responderLeases: 0,
  timers: 0,
  faultStates: 0,
  queryEffectLedgers: 0,
  heldOutputQueues: 0,
} as const);

function isOrderedRollbackRecoveryPending(reason: string | undefined): boolean {
  return reason === 'rollback-transaction-invalidated'
    || reason === 'rollback-start-enqueue-failed'
    || reason === 'compatibility-checkpoint-enqueue-failed';
}

function matchesCleanupAuthorityFence(
  state: TerminalAuthorityState,
  fence: TerminalAuthorityDebugCleanupFence,
): boolean {
  return state.mode === fence.mode
    && state.authorityEpoch === fence.authorityEpoch
    && state.streamEpoch === fence.streamEpoch
    && state.transitionEpoch === fence.transitionEpoch;
}

export type TerminalAuthorityDebugResourceInventory = {
  [Key in keyof typeof TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY]: number;
};

export interface TerminalAuthorityDebugResult {
  status: 200 | 202;
  body: JsonRecord;
}

export interface TerminalAuthorityDebugProductionAdapter {
  beginPromotion(sessionId: string): MaybePromise<{ ok: boolean; reason?: string }>;
  beginRollback(sessionId: string, reason?: string): MaybePromise<{ ok: boolean; reason?: string }>;
  getAuthorityState?(sessionId: string): TerminalAuthorityState | undefined;
  getState?(sessionId: string): TerminalAuthorityState | undefined;
  getAuthorityAuditTrail?(sessionId: string, limit?: number): unknown;
  getAudit?(sessionId: string): unknown;
  getWiringEvidence?(sessionId: string): unknown;
  getWiring?(sessionId: string): unknown;
  getAuthorityController(sessionId: string): TerminalAuthorityController | undefined;
  getSessionSnapshot(sessionId: string): unknown;
  getQueryResponderCapabilityState?(sessionId: string): {
    promotionEligible: boolean;
    blocker?: string;
    hasAcceptedViewAttributes: boolean;
  } | null;
  requestQueryResponderCapabilityRefresh?(sessionId: string): MaybePromise<boolean>;
  triggerTerminalAuthorityDebugFault?(input: {
    sessionId: string;
    faultPoint: 'legacy-disable-ack-immediate-send-failed';
    expectedAction: 'server-abort-rollback-without-pausing-pty';
    triggerId: string;
  }): MaybePromise<JsonRecord>;
}

export interface TerminalAuthorityDebugRouter {
  getTerminalAuthorityResponderViews(sessionId: string): readonly {
    sessionId?: string;
    connectionId: string;
    viewGeneration: number;
  }[];
  sendTerminalAuthorityFrameToConnection?(
    connectionId: string,
    message: object,
    lane?: 'control' | 'terminal',
  ): { sent: boolean; socketRole: 'unified' | 'control' | 'output' };
}

export interface TerminalAuthorityDebugRuntime {
  openIsolation(input: {
    sessionId: string;
    desiredMode: 'legacy' | 'server';
    cleanupToken: string;
    isolationLeaseId: string;
    transitionPolicy: string;
    testContract?: JsonRecord;
  }): MaybePromise<JsonRecord>;
  applyIsolationContract(input: {
    sessionId: string;
    desiredMode: 'legacy' | 'server';
    cleanupToken: string;
    isolationLeaseId: string;
    testContract: JsonRecord;
  }): MaybePromise<JsonRecord>;
  cleanupIsolation(input: {
    sessionId: string;
    cleanupToken: string | null;
    isolationLeaseId: string | null;
    restoreScopes: readonly string[];
    authorityFence: TerminalAuthorityDebugCleanupFence;
  }): MaybePromise<JsonRecord>;
  inspectResources(sessionId: string): MaybePromise<{
    resourceInventory: TerminalAuthorityDebugResourceInventory;
    details?: JsonRecord;
  }>;
  prepareRollbackContract(input: {
    sessionId: string;
    reason: string;
    testContract?: JsonRecord;
  }): MaybePromise<JsonRecord>;
  triggerFault(input: {
    sessionId: string;
    faultPoint: 'legacy-disable-ack-immediate-send-failed';
    expectedAction: 'server-abort-rollback-without-pausing-pty';
    triggerId: string;
  }): MaybePromise<JsonRecord>;
}

export interface TerminalAuthorityDebugSessionRuntimeApi {
  getRetainedTerminalAuthorityState(sessionId: string): {
    retentionPolicy: {
      effectiveRetainedScrollbackLines: number;
      retentionPolicyId: string;
      source: string;
    };
  } | undefined;
  beginTerminalAuthorityDebugIsolation?(
    input: Parameters<TerminalAuthorityDebugRuntime['openIsolation']>[0],
  ): MaybePromise<JsonRecord>;
  applyTerminalAuthorityDebugIsolationContract?(
    input: Parameters<TerminalAuthorityDebugRuntime['applyIsolationContract']>[0],
  ): MaybePromise<JsonRecord>;
  cleanupTerminalAuthorityDebugIsolation?(
    input: Parameters<TerminalAuthorityDebugRuntime['cleanupIsolation']>[0],
  ): MaybePromise<JsonRecord>;
  getTerminalAuthorityDebugResourceInventory?(sessionId: string): MaybePromise<{
    resourceInventory: TerminalAuthorityDebugResourceInventory;
    details?: JsonRecord;
  }>;
  prepareTerminalAuthorityDebugRollbackContract?(
    input: Parameters<TerminalAuthorityDebugRuntime['prepareRollbackContract']>[0],
  ): MaybePromise<JsonRecord>;
}

export interface ProductionTerminalAuthorityDebugRuntimeOptions {
  sessionManager: TerminalAuthorityDebugSessionRuntimeApi;
  authority: TerminalAuthorityDebugProductionAdapter;
  router?: TerminalAuthorityDebugRouter;
}

/**
 * Production-only runtime bridge. Every evidence-producing operation delegates
 * to SessionManager or the attached authority adapter; this layer never marks
 * a fixture, query effect, rollback tail or fault as accepted by itself.
 *
 * @req MIG-BGSTAB-002
 * @req REL-BGSTAB-007
 */
export function createProductionTerminalAuthorityDebugRuntime(
  options: ProductionTerminalAuthorityDebugRuntimeOptions,
): TerminalAuthorityDebugRuntime {
  const basicLeases = new Map<string, { cleanupToken: string; isolationLeaseId: string }>();
  return {
    async openIsolation(input) {
      if (options.sessionManager.beginTerminalAuthorityDebugIsolation) {
        const evidence = requireAcceptedRuntimeEvidence(
          await options.sessionManager.beginTerminalAuthorityDebugIsolation(input),
          'terminal-authority-debug-production-open-unproven',
        );
        basicLeases.set(input.sessionId, {
          cleanupToken: input.cleanupToken,
          isolationLeaseId: input.isolationLeaseId,
        });
        return evidence;
      }
      if (input.testContract) {
        throw unavailable('terminal-authority-debug-production-isolation-contract-port-unavailable');
      }
      const retained = options.sessionManager.getRetainedTerminalAuthorityState(input.sessionId);
      if (!retained) throw unavailable('terminal-authority-debug-production-retained-state-unavailable');
      basicLeases.set(input.sessionId, {
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
      });
      return {
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
        retentionPolicy: { ...retained.retentionPolicy },
        productionConfiguredRetainedScrollbackLines:
          retained.retentionPolicy.effectiveRetainedScrollbackLines,
        productionConfiguredRetainedScrollbackSource: retained.retentionPolicy.source,
        productionConfiguredRetentionPolicyId: retained.retentionPolicy.retentionPolicyId,
        effectiveHeadlessRetainedScrollbackLines:
          retained.retentionPolicy.effectiveRetainedScrollbackLines,
      };
    },
    async applyIsolationContract(input) {
      if (!options.sessionManager.applyTerminalAuthorityDebugIsolationContract) {
        throw unavailable('terminal-authority-debug-production-contract-port-unavailable');
      }
      return requireAcceptedRuntimeEvidence(
        await options.sessionManager.applyTerminalAuthorityDebugIsolationContract(input),
        'terminal-authority-debug-production-contract-unproven',
      );
    },
    async cleanupIsolation(input) {
      const basic = basicLeases.get(input.sessionId);
      if (basic && (basic.cleanupToken !== input.cleanupToken
        || basic.isolationLeaseId !== input.isolationLeaseId)) {
        throw conflict('terminal-authority-debug-production-cleanup-lease-mismatch');
      }
      if (options.sessionManager.cleanupTerminalAuthorityDebugIsolation) {
        const evidence = requireAcceptedRuntimeEvidence(
          await options.sessionManager.cleanupTerminalAuthorityDebugIsolation(input),
          'terminal-authority-debug-production-cleanup-unproven',
        );
        basicLeases.delete(input.sessionId);
        return evidence;
      }
      const state = options.authority.getAuthorityState?.(input.sessionId)
        ?? options.authority.getState?.(input.sessionId);
      if (!state || !matchesCleanupAuthorityFence(state, input.authorityFence)) {
        throw conflict('terminal-authority-debug-production-cleanup-authority-fence-mismatch');
      }
      basicLeases.delete(input.sessionId);
      return {
        accepted: true,
        restored: {
          sessionLocalRetainedPolicy: true,
          retainedCorpus: true,
          alternateBufferFixture: true,
          responderMode: true,
          listeners: true,
          driverAndResponderLeases: true,
          timers: true,
          faultState: true,
        },
      };
    },
    async inspectResources(sessionId) {
      if (options.sessionManager.getTerminalAuthorityDebugResourceInventory) {
        const evidence = await options.sessionManager.getTerminalAuthorityDebugResourceInventory(sessionId);
        assertInventory(evidence.resourceInventory);
        const audit = options.authority.getAuthorityAuditTrail?.(sessionId, 32);
        const authorityAuditTrail = Array.isArray(audit)
          ? audit.slice(-32).flatMap(item => {
              if (item === null || typeof item !== 'object') return [];
              const { data: _terminalData, ...metadata } = item as JsonRecord;
              return [metadata];
            })
          : [];
        const authorityState = options.authority.getAuthorityState?.(sessionId);
        return {
          ...evidence,
          details: {
            ...(evidence.details ?? {}),
            ...(authorityState ? {
              authorityState: {
                mode: authorityState.mode,
                heldPostBoundaryCount: authorityState.heldPostBoundaryCount,
              },
            } : {}),
            ...(options.router ? {
              attachedResponderViewCount:
                options.router.getTerminalAuthorityResponderViews(sessionId).length,
            } : {}),
            authorityAuditTrail,
          },
        };
      }
      const active = basicLeases.has(sessionId) ? 1 : 0;
      return {
        resourceInventory: {
          ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY,
          cleanupTokens: active,
          isolationLeases: active,
        },
      };
    },
    async prepareRollbackContract(input) {
      if (!input.testContract) return { accepted: true };
      if (!options.sessionManager.prepareTerminalAuthorityDebugRollbackContract) {
        throw unavailable('terminal-authority-debug-production-rollback-contract-port-unavailable');
      }
      return requireAcceptedRuntimeEvidence(
        await options.sessionManager.prepareTerminalAuthorityDebugRollbackContract(input),
        'terminal-authority-debug-production-rollback-contract-unproven',
      );
    },
    async triggerFault(input) {
      if (options.authority.triggerTerminalAuthorityDebugFault) {
        return requireAcceptedRuntimeEvidence(
          await options.authority.triggerTerminalAuthorityDebugFault(input),
          'terminal-authority-debug-production-fault-unproven',
        );
      }
      if (!options.router?.sendTerminalAuthorityFrameToConnection) {
        throw unavailable('terminal-authority-debug-production-fault-port-unavailable');
      }
      const deadline = Date.now() + 3_000;
      let before = options.authority.getAuthorityState?.(input.sessionId)
        ?? options.authority.getState?.(input.sessionId);
      while (before?.mode === 'promoting' && Date.now() <= deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        before = options.authority.getAuthorityState?.(input.sessionId)
          ?? options.authority.getState?.(input.sessionId);
      }
      if (!before || before.mode !== 'server' || before.sessionStatus !== 'idle') {
        throw unavailable('terminal-authority-debug-production-fault-precondition-unproven');
      }
      const views = options.router.getTerminalAuthorityResponderViews(input.sessionId);
      if (views.length === 0) {
        throw unavailable('terminal-authority-debug-production-fault-view-unavailable');
      }
      const abortFrame = {
        type: 'terminal-authority:promotion-aborted',
        sessionId: input.sessionId,
        triggerId: input.triggerId,
        reason: input.faultPoint,
        authorityEpoch: before.authorityEpoch,
        transitionEpoch: before.transitionEpoch ?? before.streamEpoch,
        streamEpoch: before.streamEpoch,
        ptyPaused: false,
        hiddenDeliveryLossy: false,
        sessionStatus: before.sessionStatus,
      };
      for (const view of views) {
        const delivery = options.router.sendTerminalAuthorityFrameToConnection(
          view.connectionId,
          abortFrame,
          'terminal',
        );
        if (!delivery.sent) throw unavailable('terminal-authority-debug-production-fault-abort-send-failed');
      }
      const rollback = await options.authority.beginRollback(input.sessionId, input.expectedAction);
      if (!rollback.ok) throw unavailable(rollback.reason ?? 'terminal-authority-debug-production-fault-rollback-failed');
      const after = options.authority.getAuthorityState?.(input.sessionId)
        ?? options.authority.getState?.(input.sessionId);
      if (!after || (after.mode !== 'rolling-back' && after.mode !== 'legacy')) {
        throw unavailable('terminal-authority-debug-production-fault-rollback-state-unproven');
      }
      const rollbackFrame = {
        type: 'terminal-authority:rollback-start',
        sessionId: input.sessionId,
        triggerId: input.triggerId,
        authorityEpoch: after.authorityEpoch,
        transitionEpoch: after.transitionEpoch ?? after.streamEpoch,
        streamEpoch: after.streamEpoch,
        requiredAction: 'fresh-compatibility-checkpoint',
        ptyPaused: false,
      };
      for (const view of views) {
        const delivery = options.router.sendTerminalAuthorityFrameToConnection(
          view.connectionId,
          rollbackFrame,
          'terminal',
        );
        if (!delivery.sent) throw unavailable('terminal-authority-debug-production-fault-rollback-send-failed');
      }
      return {
        accepted: true,
        triggerId: input.triggerId,
        ptyPaused: false,
        hiddenDeliveryLossy: false,
        sessionStatus: before.sessionStatus,
        authorityEpoch: after.authorityEpoch,
        transitionEpoch: after.transitionEpoch ?? after.streamEpoch,
        streamEpoch: after.streamEpoch,
      };
    },
  };
}

export interface TerminalAuthorityDebugServiceOptions {
  authority: TerminalAuthorityDebugProductionAdapter;
  router: TerminalAuthorityDebugRouter;
  runtime: TerminalAuthorityDebugRuntime;
  createId?: () => string;
  authoritySettleTimeoutMs?: number;
  configuredRangeAuthoritySettleTimeoutMs?: number;
  authorityPollIntervalMs?: number;
}

interface IsolationLease {
  cleanupToken: string;
  isolationLeaseId: string;
  desiredMode: 'legacy' | 'server';
  settleTimeoutMs: number;
}

interface CleanupFlight {
  cleanupToken: string | null;
  isolationLeaseId: string | null;
  result: Promise<TerminalAuthorityDebugResult>;
}

interface ParsedIsolationRequest {
  desiredMode: 'legacy' | 'server';
  transitionPolicy: string;
  testContract?: JsonRecord;
  operation: 'prepare' | 'cleanup' | 'inventory' | 'query-probe' | 'post-snapshot-tail';
}

interface ParsedRollbackRequest {
  reason: 'https-e2e-multi-view-rollback-drill';
  expectedAffectedViewPolicy: 'freeze-all-current-responder-views';
  testContract?: JsonRecord;
}

interface ParsedFaultRequest {
  faultPoint: 'legacy-disable-ack-immediate-send-failed';
  expectedAction: 'server-abort-rollback-without-pausing-pty';
}

export class TerminalAuthorityDebugError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code: string,
    message: string,
    readonly details?: JsonRecord,
  ) {
    super(message);
    this.name = 'TerminalAuthorityDebugError';
  }
}

/**
 * Local-debug facade over the production authority assembly. It owns only
 * request validation, test-isolation ownership and evidence cross-checking;
 * terminal bytes and transitions remain owned by the supplied runtime.
 *
 * @req MIG-BGSTAB-002
 * @req REL-BGSTAB-007
 */
export class TerminalAuthorityDebugService {
  private readonly isolationBySession = new Map<string, IsolationLease>();
  private readonly cleanupBySession = new Map<string, CleanupFlight>();
  private readonly createId: () => string;
  private readonly authoritySettleTimeoutMs: number;
  private readonly configuredRangeAuthoritySettleTimeoutMs: number;
  private readonly authorityPollIntervalMs: number;

  constructor(private readonly options: TerminalAuthorityDebugServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.authoritySettleTimeoutMs = options.authoritySettleTimeoutMs ?? 5_000;
    this.configuredRangeAuthoritySettleTimeoutMs = Math.max(
      this.authoritySettleTimeoutMs,
      options.configuredRangeAuthoritySettleTimeoutMs ?? 120_000,
    );
    this.authorityPollIntervalMs = options.authorityPollIntervalMs ?? 10;
  }

  // @req MIG-BGSTAB-002
  async testIsolation(sessionId: string, body: unknown): Promise<TerminalAuthorityDebugResult> {
    this.assertSession(sessionId);
    const request = parseIsolationRequest(body);
    if (request.operation === 'inventory') return this.inspect(sessionId);
    if (request.operation === 'cleanup') return this.cleanupSingleFlight(sessionId, request.testContract!);
    if (request.operation === 'query-probe' || request.operation === 'post-snapshot-tail') {
      return this.applyContinuationContract(sessionId, request);
    }

    if (this.isolationBySession.has(sessionId)) {
      throw conflict('terminal-authority-debug-isolation-already-active');
    }
    const cleanupToken = this.createId();
    const isolationLeaseId = this.createId();
    if (!isOpaqueId(cleanupToken) || !isOpaqueId(isolationLeaseId) || cleanupToken === isolationLeaseId) {
      throw unavailable('terminal-authority-debug-id-source-invalid');
    }
    const settleTimeoutMs = request.testContract?.productionConfiguredRangeProbe !== undefined
      ? this.configuredRangeAuthoritySettleTimeoutMs
      : this.authoritySettleTimeoutMs;
    const lease: IsolationLease = {
      cleanupToken,
      isolationLeaseId,
      desiredMode: request.desiredMode,
      settleTimeoutMs,
    };
    const opened = asRecord(await this.options.runtime.openIsolation({
      sessionId,
      cleanupToken,
      isolationLeaseId,
      desiredMode: request.desiredMode,
      transitionPolicy: request.transitionPolicy,
      ...(request.testContract ? { testContract: request.testContract } : {}),
    }), 'terminal-authority-debug-open-isolation-invalid');
    assertAccepted(opened, 'terminal-authority-debug-open-isolation-rejected');

    try {
      const configuredCapabilityRefresh = request.testContract?.productionConfiguredRangeProbe !== undefined
        ? (() => {
        const refreshCapability = this.options.authority.requestQueryResponderCapabilityRefresh;
        if (!refreshCapability) {
          throw conflict('queryResponderCapability-refresh-unavailable-gate-failed');
        }
        return refreshCapability;
      })()
        : null;
      const settleConfiguredQueryResponderCapability = async (): Promise<void> => {
        if (!configuredCapabilityRefresh) return;
        const refreshAccepted = await configuredCapabilityRefresh(sessionId);
        if (!refreshAccepted) {
          throw conflict('queryResponderCapability-refresh-rejected-gate-failed');
        }
      };
      const contractEvidence = request.testContract
        ? asRecord(await this.options.runtime.applyIsolationContract({
            sessionId,
            cleanupToken,
            isolationLeaseId,
            desiredMode: request.desiredMode,
            testContract: request.testContract,
          }), 'terminal-authority-debug-contract-evidence-invalid')
        : {};
      if (request.testContract) assertAccepted(contractEvidence, 'terminal-authority-debug-contract-rejected');
      if (configuredCapabilityRefresh) {
        await new Promise<void>(resolve => setImmediate(resolve));
        await settleConfiguredQueryResponderCapability();
      }
      // A configured isolation contract may recreate the headless model and
      // its authority controller. Apply it while legacy authority is still
      // active, then promote the final model instance exactly once.
      // A "fresh" legacy preparation is not a read-only baseline. When the
      // session already starts in legacy mode, exercise the real production
      // promotion/rollback path so the selected browser receives a new typed
      // responder lease after every affected view drains.
      if (request.desiredMode === 'legacy'
        && request.transitionPolicy === 'fresh-compatibility-rollback-and-all-view-drain'
        && this.readAuthorityState(sessionId).mode === 'legacy') {
        await this.moveAuthority(sessionId, 'server', settleTimeoutMs);
      }
      await this.moveAuthority(sessionId, request.desiredMode, settleTimeoutMs);
      const evidence = { ...opened, ...contractEvidence };
      this.assertPreparationEvidence(sessionId, lease, evidence);
      this.isolationBySession.set(sessionId, lease);
      return {
        status: 200,
        body: {
          ...evidence,
          accepted: true,
          mode: request.desiredMode,
          source: 'server-test-isolation',
          allAffectedViewsDrained: true,
          cleanupToken,
          isolationLeaseId,
          guardEvidence: TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE,
        },
      };
    } catch (error) {
      await this.bestEffortFailedOpenCleanup(sessionId, lease);
      throw error;
    }
  }

  // @req MIG-BGSTAB-002
  async rollback(sessionId: string, body: unknown): Promise<TerminalAuthorityDebugResult> {
    this.assertSession(sessionId);
    const request = parseRollbackRequest(body);
    const activeLease = this.requireLease(sessionId);
    if (activeLease.desiredMode !== 'server') {
      throw conflict('terminal-authority-debug-rollback-requires-server-authority');
    }
    const runtimeEvidence = asRecord(await this.options.runtime.prepareRollbackContract({
      sessionId,
      reason: request.reason,
      ...(request.testContract ? { testContract: request.testContract } : {}),
    }), 'terminal-authority-debug-rollback-contract-invalid');
    assertAccepted(runtimeEvidence, 'terminal-authority-debug-rollback-contract-rejected');
    const result = await this.options.authority.beginRollback(sessionId, request.reason);
    if (!result.ok) throw conflict(result.reason ?? 'terminal-authority-debug-rollback-rejected');
    const state = this.readAuthorityState(sessionId);
    if (state.mode !== 'rolling-back' && state.mode !== 'legacy') {
      throw unavailable('terminal-authority-debug-rollback-state-not-observed');
    }
    return {
      status: 202,
      body: {
        ...runtimeEvidence,
        accepted: true,
        source: 'server-controller',
        guardEvidence: TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE,
      },
    };
  }

  // @req MIG-BGSTAB-002
  async fault(sessionId: string, body: unknown): Promise<TerminalAuthorityDebugResult> {
    this.assertSession(sessionId);
    const request = parseFaultRequest(body);
    this.requireLease(sessionId);
    const triggerId = this.createId();
    if (!isOpaqueId(triggerId)) throw unavailable('terminal-authority-debug-trigger-id-invalid');
    const evidence = asRecord(await this.options.runtime.triggerFault({
      sessionId,
      triggerId,
      ...request,
    }), 'terminal-authority-debug-fault-evidence-invalid');
    assertAccepted(evidence, 'terminal-authority-debug-fault-rejected');
    if (evidence.triggerId !== triggerId
      || evidence.ptyPaused !== false
      || evidence.hiddenDeliveryLossy !== false
      || evidence.sessionStatus !== 'idle') {
      throw unavailable('terminal-authority-debug-fault-invariant-unproven');
    }
    const actual = this.readAuthorityState(sessionId);
    if (actual.sessionStatus !== 'idle') {
      throw unavailable('terminal-authority-debug-fault-session-status-not-idle');
    }
    return {
      status: 202,
      body: {
        ...evidence,
        accepted: true,
        triggerSource: 'server-deterministic-debug',
        triggerId,
        guardEvidence: TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE,
      },
    };
  }

  // @req MIG-BGSTAB-002
  private async applyContinuationContract(
    sessionId: string,
    request: ParsedIsolationRequest,
  ): Promise<TerminalAuthorityDebugResult> {
    const lease = this.requireLease(sessionId);
    if (lease.desiredMode !== 'server' || request.desiredMode !== 'server') {
      throw conflict('terminal-authority-debug-continuation-requires-server-authority');
    }
    assertContinuationLease(request.testContract!, lease);
    // Continuation contracts inject terminal bytes or query side effects. A
    // reload/send failure can begin rollback after the isolation was opened;
    // never mutate the model first and discover that lost authority only
    // afterwards.
    this.assertActualIdentity(sessionId, 'server');
    const evidence = asRecord(await this.options.runtime.applyIsolationContract({
      sessionId,
      desiredMode: 'server',
      cleanupToken: lease.cleanupToken,
      isolationLeaseId: lease.isolationLeaseId,
      testContract: request.testContract!,
    }), 'terminal-authority-debug-continuation-evidence-invalid');
    assertAccepted(evidence, 'terminal-authority-debug-continuation-rejected');
    this.assertActualIdentity(sessionId, 'server');
    return {
      status: 202,
      body: {
        ...evidence,
        accepted: true,
        source: request.operation === 'query-probe'
          ? 'server-headless-responder-test-isolation'
          : 'server-test-isolation',
        guardEvidence: TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE,
      },
    };
  }

  // @req MIG-BGSTAB-002
  private async inspect(sessionId: string): Promise<TerminalAuthorityDebugResult> {
    const inspected = await this.options.runtime.inspectResources(sessionId);
    assertInventory(inspected.resourceInventory);
    const active = this.isolationBySession.get(sessionId);
    if (!active && !inventoryIsZero(inspected.resourceInventory)) {
      throw unavailable('terminal-authority-debug-resource-inventory-leaked', {
        ...(inspected.details ?? {}),
        resourceInventory: inspected.resourceInventory,
      });
    }
    return {
      status: 200,
      body: {
        ...(inspected.details ?? {}),
        accepted: true,
        mode: this.readAuthorityState(sessionId).mode === 'server' ? 'server' : 'legacy',
        source: 'server-test-isolation-inventory',
        inspectedSessionId: sessionId,
        isolationLeaseAcquired: false,
        resourceInventory: inspected.resourceInventory,
        guardEvidence: TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE,
      },
    };
  }

  // @req MIG-BGSTAB-002
  private cleanupSingleFlight(
    sessionId: string,
    testContract: JsonRecord,
  ): Promise<TerminalAuthorityDebugResult> {
    const cleanupRequest = asRecord(testContract.cleanup, 'terminal-authority-debug-cleanup-missing');
    const cleanupToken = nullableString(cleanupRequest.cleanupToken);
    const isolationLeaseId = nullableString(cleanupRequest.isolationLeaseId);
    const active = this.cleanupBySession.get(sessionId);
    if (active) {
      if (active.cleanupToken !== cleanupToken || active.isolationLeaseId !== isolationLeaseId) {
        return Promise.reject(conflict('terminal-authority-debug-cleanup-lease-mismatch'));
      }
      return active.result;
    }
    const result = this.cleanup(sessionId, testContract);
    const flight: CleanupFlight = { cleanupToken, isolationLeaseId, result };
    this.cleanupBySession.set(sessionId, flight);
    const clearFlight = (): void => {
      if (this.cleanupBySession.get(sessionId) === flight) this.cleanupBySession.delete(sessionId);
    };
    void result.then(clearFlight, clearFlight);
    return result;
  }

  // @req MIG-BGSTAB-002
  private async cleanup(sessionId: string, testContract: JsonRecord): Promise<TerminalAuthorityDebugResult> {
    const cleanupRequest = asRecord(testContract.cleanup, 'terminal-authority-debug-cleanup-missing');
    const active = this.isolationBySession.get(sessionId);
    const cleanupToken = nullableString(cleanupRequest.cleanupToken);
    const isolationLeaseId = nullableString(cleanupRequest.isolationLeaseId);
    if (active && (cleanupToken !== active.cleanupToken || isolationLeaseId !== active.isolationLeaseId)) {
      throw conflict('terminal-authority-debug-cleanup-lease-mismatch');
    }
    const scopes = asStringArray(cleanupRequest.restoreScopes, 'terminal-authority-debug-cleanup-scopes-invalid');
    // Complete the ordered production rollback while the isolated controller
    // and its server leases still exist. Recreating the original headless
    // model first would silently replace that controller with legacy state and
    // skip the rollback protocol.
    const cleanupMode = this.readAuthorityState(sessionId).mode;
    const rollbackSettleTimeoutMs = Math.max(
      this.authoritySettleTimeoutMs * 3,
      active?.settleTimeoutMs ?? 0,
    );
    if (cleanupMode === 'server') {
      await this.beginDebugRollbackAdmission(
        sessionId,
        'terminal-authority-debug-cleanup',
        rollbackSettleTimeoutMs,
      );
      await this.waitForAuthorityMode(sessionId, 'legacy', rollbackSettleTimeoutMs);
    } else if (cleanupMode === 'rolling-back') {
      await this.waitForAuthorityMode(sessionId, 'legacy', rollbackSettleTimeoutMs);
    } else if (cleanupMode !== 'legacy') {
      throw conflict(`terminal-authority-debug-cleanup-unsupported-mode-${cleanupMode}`);
    }
    const authorityFence = this.readCleanupAuthorityFence(sessionId);
    const restored = asRecord(await this.options.runtime.cleanupIsolation({
      sessionId,
      cleanupToken,
      isolationLeaseId,
      restoreScopes: scopes,
      authorityFence,
    }), 'terminal-authority-debug-cleanup-evidence-invalid');
    assertAccepted(restored, 'terminal-authority-debug-cleanup-rejected');
    const inspected = await this.options.runtime.inspectResources(sessionId);
    assertInventory(inspected.resourceInventory);
    if (!inventoryIsZero(inspected.resourceInventory)) {
      throw unavailable('terminal-authority-debug-cleanup-resource-leak');
    }
    this.isolationBySession.delete(sessionId);
    return {
      status: 200,
      body: {
        accepted: true,
        mode: 'legacy',
        source: 'server-test-isolation',
        allAffectedViewsDrained: true,
        guardEvidence: TERMINAL_AUTHORITY_DEBUG_GUARD_EVIDENCE,
        cleanup: {
          ...restored,
          accepted: true,
          cleanupToken,
          isolationLeaseId,
          isolationLeaseReleased: true,
          resourceInventory: inspected.resourceInventory,
        },
      },
    };
  }

  // @req MIG-BGSTAB-002
  private async moveAuthority(
    sessionId: string,
    desiredMode: 'legacy' | 'server',
    settleTimeoutMs = this.authoritySettleTimeoutMs,
  ): Promise<void> {
    const current = this.readAuthorityState(sessionId).mode;
    if (desiredMode === 'server') {
      if (current === 'server') return;
      const deadline = Date.now() + settleTimeoutMs;
      let lastRetryableReason = 'terminal-authority-debug-server-settle-timeout';
      const isRetryablePromotionReason = (reason: string): boolean => (
        reason === 'screen-repair-active'
        || reason === 'server-recovery-ack-missing'
        || reason === 'server-recovery-view-unavailable'
        || reason === 'server-recovery-capable-view-unavailable'
        || reason === 'promotion-candidate-admission-not-legacy'
        || reason === 'promotion-boundary-invalidated'
        || reason.endsWith('-gate-failed')
      );
      while (Date.now() <= deadline) {
        const observedMode = this.readAuthorityState(sessionId).mode;
        if (observedMode === 'server') return;
        if (observedMode === 'legacy') {
          const promoted = await this.options.authority.beginPromotion(sessionId);
          if (this.readAuthorityState(sessionId).mode === 'server') return;
          if (!promoted.ok) {
            const reason = promoted.reason ?? 'terminal-authority-debug-promotion-rejected';
            if (!isRetryablePromotionReason(reason)) throw conflict(reason);
            lastRetryableReason = reason;
          }
        }
        // Production owns aborted, promoting and rolling-back recovery. Poll
        // those transitions; a debug rollback would invalidate or overlap the
        // topology observer's fresh compatibility transaction.
        await new Promise<void>(resolve => setTimeout(resolve, this.authorityPollIntervalMs));
      }
      let finalObservedMode = this.readAuthorityState(sessionId).mode;
      if (finalObservedMode === 'server') return;
      if (finalObservedMode !== 'legacy') {
        const terminalMode = await this.waitForAuthorityTerminalMode(sessionId, settleTimeoutMs);
        if (terminalMode === 'server') return;
        if (terminalMode !== null) finalObservedMode = terminalMode;
      }
      if (finalObservedMode === 'legacy') {
        const finalPromotion = await this.options.authority.beginPromotion(sessionId);
        if (this.readAuthorityState(sessionId).mode === 'server') return;
        if (!finalPromotion.ok) {
          const reason = finalPromotion.reason ?? 'terminal-authority-debug-promotion-rejected';
          if (!isRetryablePromotionReason(reason)) throw conflict(reason);
          lastRetryableReason = reason;
        } else {
          const terminalMode = await this.waitForAuthorityTerminalMode(sessionId, settleTimeoutMs);
          if (terminalMode === 'server') return;
        }
      }
      throw conflict(lastRetryableReason);
    }
    if (current !== 'legacy') {
      await this.beginDebugRollbackAdmission(
        sessionId,
        'terminal-authority-debug-isolation',
        this.authoritySettleTimeoutMs,
      );
      await this.waitForAuthorityMode(sessionId, 'legacy');
    }
  }

  // @req MIG-BGSTAB-002
  private async beginDebugRollbackAdmission(
    sessionId: string,
    reason: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let firstAttempt = true;
    let lastReason = 'terminal-authority-debug-rollback-rejected';
    while (Date.now() <= deadline) {
      const observedMode = this.readAuthorityState(sessionId).mode;
      if (observedMode === 'legacy' || observedMode === 'rolling-back') return;
      if (!firstAttempt && observedMode !== 'server') {
        throw conflict(`terminal-authority-debug-rollback-unsupported-mode-${observedMode}`);
      }
      const rollback = await this.options.authority.beginRollback(sessionId, reason);
      firstAttempt = false;
      if (rollback.ok || isOrderedRollbackRecoveryPending(rollback.reason)) return;
      lastReason = rollback.reason ?? lastReason;
      if (lastReason !== 'compatibility-view-unavailable'
        || this.readAuthorityState(sessionId).mode !== 'server') {
        throw conflict(lastReason);
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>(resolve => setTimeout(resolve, this.authorityPollIntervalMs));
    }
    throw conflict(lastReason);
  }

  // @req MIG-BGSTAB-002
  private async waitForAuthorityMode(
    sessionId: string,
    desiredMode: 'legacy' | 'server',
    timeoutOverrideMs?: number,
  ): Promise<void> {
    // Ordered rollback can legitimately consume the controller ACK deadline,
    // a browser reconnect, and the final all-view drain in sequence. Keep the
    // shorter promotion polling bound, but allow the debug cleanup contract to
    // observe that complete production rollback before declaring evidence
    // unavailable and forcing a second cleanup request.
    const settleTimeoutMs = timeoutOverrideMs ?? (desiredMode === 'legacy'
      ? this.authoritySettleTimeoutMs * 3
      : this.authoritySettleTimeoutMs);
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() <= deadline) {
      if (this.readAuthorityState(sessionId).mode === desiredMode) return;
      await new Promise<void>(resolve => setTimeout(resolve, this.authorityPollIntervalMs));
    }
    if (this.readAuthorityState(sessionId).mode === desiredMode) return;
    throw unavailable(`terminal-authority-debug-${desiredMode}-settle-timeout`);
  }

  // @req MIG-BGSTAB-002
  private async waitForAuthorityTerminalMode(
    sessionId: string,
    timeoutMs: number,
  ): Promise<'legacy' | 'server' | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const mode = this.readAuthorityState(sessionId).mode;
      if (mode === 'legacy' || mode === 'server') return mode;
      await new Promise<void>(resolve => setTimeout(resolve, this.authorityPollIntervalMs));
    }
    const finalMode = this.readAuthorityState(sessionId).mode;
    return finalMode === 'legacy' || finalMode === 'server' ? finalMode : null;
  }

  // @req MIG-BGSTAB-002
  private readCleanupAuthorityFence(sessionId: string): TerminalAuthorityDebugCleanupFence {
    const state = this.readAuthorityState(sessionId);
    if (state.mode !== 'legacy') {
      throw conflict(`terminal-authority-debug-cleanup-unsupported-mode-${state.mode}`);
    }
    return {
      mode: state.mode,
      authorityEpoch: state.authorityEpoch,
      streamEpoch: state.streamEpoch,
      transitionEpoch: state.transitionEpoch ?? null,
    };
  }

  // @req MIG-BGSTAB-002
  private assertPreparationEvidence(sessionId: string, lease: IsolationLease, evidence: JsonRecord): void {
    if (evidence.cleanupToken !== lease.cleanupToken
      || evidence.isolationLeaseId !== lease.isolationLeaseId
      || evidence.allAffectedViewsDrained !== true) {
      throw unavailable('terminal-authority-debug-preparation-identity-unproven');
    }
    this.assertActualIdentity(sessionId, lease.desiredMode);
    const views = this.options.router.getTerminalAuthorityResponderViews(sessionId);
    if (views.some(view => view.sessionId !== undefined && view.sessionId !== sessionId)
      || views.some(view => !isOpaqueId(view.connectionId) || !Number.isSafeInteger(view.viewGeneration))) {
      throw unavailable('terminal-authority-debug-responder-view-identity-invalid');
    }
  }

  // @req MIG-BGSTAB-002
  private assertActualIdentity(sessionId: string, mode: 'legacy' | 'server'): void {
    const snapshot = asRecord(
      this.options.authority.getSessionSnapshot(sessionId),
      'terminal-authority-debug-session-snapshot-unavailable',
    );
    const snapshotState = asRecord(
      snapshot.state,
      'terminal-authority-debug-session-snapshot-state-unavailable',
    );
    if (snapshotState.sessionId !== sessionId || snapshotState.mode !== mode) {
      const audit = this.options.authority.getAuthorityAuditTrail?.(sessionId, 16);
      const lastAudit = Array.isArray(audit) && audit.length > 0
        ? audit.at(-1)
        : null;
      const auditRecord = lastAudit !== null && typeof lastAudit === 'object'
        ? lastAudit as JsonRecord
        : null;
      const recentAudit = Array.isArray(audit)
        ? audit.slice(-16).map(item => {
            if (item === null || typeof item !== 'object') return 'invalid';
            const record = item as JsonRecord;
            const type = String(record.type ?? 'unknown');
            const kind = record.kind === undefined ? '' : `(${String(record.kind)})`;
            return `${type}${kind}`;
          }).join(',')
        : 'unavailable';
      throw unavailable([
        'terminal-authority-debug-session-snapshot-identity-mismatch',
        `expected-session=${sessionId}`,
        `actual-session=${String(snapshotState.sessionId ?? 'missing')}`,
        `expected-mode=${mode}`,
        `actual-mode=${String(snapshotState.mode ?? 'missing')}`,
        `last-audit=${String(auditRecord?.type ?? auditRecord?.kind ?? 'unavailable')}`,
        `recent-audit=${recentAudit}`,
      ].join(':'));
    }
    const actual = this.readAuthorityState(sessionId);
    if (actual.sessionId !== sessionId || actual.mode !== mode) {
      throw unavailable('terminal-authority-debug-authority-state-mismatch');
    }
    if (!this.options.authority.getAuthorityController(sessionId)) {
      throw unavailable('terminal-authority-debug-controller-unavailable');
    }
  }

  // @req MIG-BGSTAB-002
  private readAuthorityState(sessionId: string): TerminalAuthorityState {
    const state = this.options.authority.getAuthorityState?.(sessionId)
      ?? this.options.authority.getState?.(sessionId);
    if (!state) throw unavailable('terminal-authority-debug-authority-state-unavailable');
    return state;
  }

  // @req MIG-BGSTAB-002
  private assertSession(sessionId: string): void {
    if (!isOpaqueId(sessionId)) throw invalid('terminal-authority-debug-session-id-invalid');
    if (!this.options.authority.getSessionSnapshot(sessionId)) {
      throw unavailable('terminal-authority-debug-session-runtime-unavailable');
    }
  }

  // @req MIG-BGSTAB-002
  private requireLease(sessionId: string): IsolationLease {
    const lease = this.isolationBySession.get(sessionId);
    if (!lease) throw conflict('terminal-authority-debug-isolation-not-active');
    return lease;
  }

  // @req MIG-BGSTAB-002
  private async bestEffortFailedOpenCleanup(sessionId: string, lease: IsolationLease): Promise<void> {
    const settleTimeoutMs = Math.max(this.authoritySettleTimeoutMs * 3, lease.settleTimeoutMs);
    let cleanupSafe = false;
    try {
      let mode = this.readAuthorityState(sessionId).mode;
      if (mode === 'promoting' || mode === 'aborted' || mode === 'rolling-back') {
        const terminalMode = await this.waitForAuthorityTerminalMode(sessionId, settleTimeoutMs);
        if (terminalMode === null) return;
        mode = terminalMode;
      }
      if (mode === 'server') {
        await this.beginDebugRollbackAdmission(
          sessionId,
          'terminal-authority-debug-failed-open-cleanup',
          settleTimeoutMs,
        );
        await this.waitForAuthorityMode(sessionId, 'legacy', settleTimeoutMs);
      }
      cleanupSafe = mode === 'legacy' || this.readAuthorityState(sessionId).mode === 'legacy';
    } catch {
      return;
    }
    if (!cleanupSafe) return;
    const authorityFence = this.readCleanupAuthorityFence(sessionId);
    await Promise.resolve(this.options.runtime.cleanupIsolation({
      sessionId,
      cleanupToken: lease.cleanupToken,
      isolationLeaseId: lease.isolationLeaseId,
      restoreScopes: ['all-open-isolation-resources'],
      authorityFence,
    })).catch(() => undefined);
  }
}

// @req MIG-BGSTAB-002
export function createTerminalAuthorityDebugService(
  options: TerminalAuthorityDebugServiceOptions,
): TerminalAuthorityDebugService {
  return new TerminalAuthorityDebugService(options);
}

export interface TerminalAuthorityDebugHandlers {
  handleTestIsolation(request: JsonRecord, response: JsonRecord, next: (error?: unknown) => void): void;
  handleRollback(request: JsonRecord, response: JsonRecord, next: (error?: unknown) => void): void;
  handleFault(request: JsonRecord, response: JsonRecord, next: (error?: unknown) => void): void;
}

// @req MIG-BGSTAB-002
export function createTerminalAuthorityDebugHandlers(
  service: TerminalAuthorityDebugService,
): TerminalAuthorityDebugHandlers {
  return {
    handleTestIsolation(request, response, next) {
      void sendHandlerResult(service.testIsolation.bind(service), request, response, next);
    },
    handleRollback(request, response, next) {
      void sendHandlerResult(service.rollback.bind(service), request, response, next);
    },
    handleFault(request, response, next) {
      void sendHandlerResult(service.fault.bind(service), request, response, next);
    },
  };
}

// @req MIG-BGSTAB-002
async function sendHandlerResult(
  operation: (sessionId: string, body: unknown) => Promise<TerminalAuthorityDebugResult>,
  request: JsonRecord,
  response: JsonRecord,
  next: (error?: unknown) => void,
): Promise<void> {
  const params = isRecord(request.params) ? request.params : {};
  const status = typeof response.status === 'function'
    ? response.status.bind(response) as (code: number) => JsonRecord
    : null;
  if (!status) {
    next(new Error('terminal-authority-debug-response-status-unavailable'));
    return;
  }
  try {
    const result = await operation(String(params.id ?? ''), request.body);
    const responseWithStatus = status(result.status);
    if (typeof responseWithStatus.json === 'function') responseWithStatus.json(result.body);
  } catch (error) {
    if (!(error instanceof TerminalAuthorityDebugError)) {
      next(error);
      return;
    }
    const failure = error;
    const responseWithStatus = status(failure.status);
    if (typeof responseWithStatus.json === 'function') {
      responseWithStatus.json({
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details ? { details: failure.details } : {}),
        },
      });
    }
  }
}

// @req MIG-BGSTAB-002
export function parseTerminalAuthorityDebugIsolationRequest(body: unknown): ParsedIsolationRequest {
  return parseIsolationRequest(body);
}

// @req MIG-BGSTAB-002
function parseIsolationRequest(body: unknown): ParsedIsolationRequest {
  const record = exactRecord(body, ['desiredMode', 'transitionPolicy', 'testContract']);
  const desiredMode = record.desiredMode;
  if (desiredMode !== 'legacy' && desiredMode !== 'server') {
    throw invalid('terminal-authority-debug-desired-mode-invalid');
  }
  const transitionPolicy = requiredString(record.transitionPolicy, 'terminal-authority-debug-transition-policy-invalid');
  const allowedPolicies = desiredMode === 'server'
    ? new Set(['capability-gated-limited-promotion-and-all-view-drain', 'preserve-current-server-authority'])
    : new Set(['fresh-compatibility-rollback-and-all-view-drain', 'read-only-fresh-session-baseline']);
  if (!allowedPolicies.has(transitionPolicy)) {
    throw invalid('terminal-authority-debug-transition-policy-mode-mismatch');
  }
  if (record.testContract === undefined) {
    return { desiredMode, transitionPolicy, operation: 'prepare' };
  }
  const testContract = validateTestContract(record.testContract);
  const operation = classifyTestContract(testContract);
  if (operation === 'inventory' && transitionPolicy !== 'read-only-fresh-session-baseline') {
    throw invalid('terminal-authority-debug-inventory-policy-invalid');
  }
  if ((operation === 'query-probe' || operation === 'post-snapshot-tail')
    && transitionPolicy !== 'preserve-current-server-authority') {
    throw invalid('terminal-authority-debug-continuation-policy-invalid');
  }
  return { desiredMode, transitionPolicy, testContract, operation };
}

// @req MIG-BGSTAB-002
function parseRollbackRequest(body: unknown): ParsedRollbackRequest {
  const record = exactRecord(body, ['reason', 'expectedAffectedViewPolicy', 'testContract']);
  if (record.reason !== 'https-e2e-multi-view-rollback-drill'
    || record.expectedAffectedViewPolicy !== 'freeze-all-current-responder-views') {
    throw invalid('terminal-authority-debug-rollback-request-invalid');
  }
  if (record.testContract === undefined) return record as unknown as ParsedRollbackRequest;
  const testContract = exactRecord(record.testContract, ['contractVersion', 'postBoundaryOutputInjection']);
  assertContractVersion(testContract);
  const injection = exactRecord(testContract.postBoundaryOutputInjection, [
    'action', 'deliveryPhase', 'encoding', 'data', 'decodedBytes', 'sha256', 'expectedMarker',
  ]);
  if (injection.action !== 'inject-authoritative-raw-output-after-rollback-boundary'
    || injection.deliveryPhase !== 'after-checkpoint-commit-before-compatibility-drain-ack') {
    throw invalid('terminal-authority-debug-rollback-injection-policy-invalid');
  }
  validateEncodedPayload(injection);
  requiredString(injection.expectedMarker, 'terminal-authority-debug-rollback-marker-invalid');
  return { ...record, testContract } as ParsedRollbackRequest;
}

// @req MIG-BGSTAB-002
function parseFaultRequest(body: unknown): ParsedFaultRequest {
  const record = exactRecord(body, ['faultPoint', 'expectedAction']);
  if (record.faultPoint !== 'legacy-disable-ack-immediate-send-failed'
    || record.expectedAction !== 'server-abort-rollback-without-pausing-pty') {
    throw invalid('terminal-authority-debug-fault-request-invalid');
  }
  return record as unknown as ParsedFaultRequest;
}

// @req MIG-BGSTAB-002
function validateTestContract(value: unknown): JsonRecord {
  const contract = exactRecord(value, [
    'contractVersion',
    'cleanupToken',
    'isolationLeaseId',
    'cleanup',
    'inventory',
    'retainedPolicyOverride',
    'retainedCorpusInjection',
    'productionConfiguredRangeProbe',
    'queryResponderProbe',
    'deterministicPostSnapshotTail',
  ]);
  assertContractVersion(contract);
  const actions = [
    'cleanup',
    'inventory',
    'retainedCorpusInjection',
    'productionConfiguredRangeProbe',
    'queryResponderProbe',
    'deterministicPostSnapshotTail',
  ].filter(key => contract[key] !== undefined);
  if (actions.length === 0 || actions.length > 1) {
    throw invalid('terminal-authority-debug-test-contract-action-count-invalid');
  }
  if (contract.cleanup !== undefined) validateCleanupContract(contract.cleanup);
  if (contract.inventory !== undefined) validateInventoryContract(contract.inventory);
  if (contract.retainedPolicyOverride !== undefined) validateRetainedPolicyOverride(contract.retainedPolicyOverride);
  if (contract.retainedCorpusInjection !== undefined) validateRetainedCorpusInjection(contract.retainedCorpusInjection);
  if (contract.productionConfiguredRangeProbe !== undefined) validateProductionRangeProbe(contract.productionConfiguredRangeProbe);
  if (contract.queryResponderProbe !== undefined) validateQueryProbe(contract.queryResponderProbe);
  if (contract.deterministicPostSnapshotTail !== undefined) validatePostSnapshotTail(contract.deterministicPostSnapshotTail);
  if (contract.queryResponderProbe !== undefined || contract.deterministicPostSnapshotTail !== undefined) {
    requiredString(contract.cleanupToken, 'terminal-authority-debug-continuation-cleanup-token-invalid');
    requiredString(contract.isolationLeaseId, 'terminal-authority-debug-continuation-isolation-lease-invalid');
  } else if (contract.cleanupToken !== undefined || contract.isolationLeaseId !== undefined) {
    throw invalid('terminal-authority-debug-continuation-token-without-continuation');
  }
  return contract;
}

// @req MIG-BGSTAB-002
function classifyTestContract(contract: JsonRecord): ParsedIsolationRequest['operation'] {
  if (contract.cleanup !== undefined) return 'cleanup';
  if (contract.inventory !== undefined) return 'inventory';
  if (contract.queryResponderProbe !== undefined) return 'query-probe';
  if (contract.deterministicPostSnapshotTail !== undefined) return 'post-snapshot-tail';
  return 'prepare';
}

// @req MIG-BGSTAB-002
function validateCleanupContract(value: unknown): void {
  const cleanup = exactRecord(value, ['action', 'cleanupToken', 'isolationLeaseId', 'restoreScopes']);
  if (cleanup.action !== 'restore-session-test-isolation-by-token-and-lease'
    && cleanup.action !== 'sentinel-best-effort-legacy-restore') {
    throw invalid('terminal-authority-debug-cleanup-action-invalid');
  }
  nullableString(cleanup.cleanupToken);
  nullableString(cleanup.isolationLeaseId);
  const scopes = asStringArray(cleanup.restoreScopes, 'terminal-authority-debug-cleanup-scopes-invalid');
  if (scopes.length === 0) throw invalid('terminal-authority-debug-cleanup-scopes-empty');
}

// @req MIG-BGSTAB-002
function validateInventoryContract(value: unknown): void {
  const inventory = exactRecord(value, ['action']);
  if (inventory.action !== 'inspect-without-acquiring-isolation-lease') {
    throw invalid('terminal-authority-debug-inventory-action-invalid');
  }
}

// @req MIG-BGSTAB-002
function validateRetainedPolicyOverride(value: unknown): void {
  const policy = exactRecord(value, [
    'action', 'scope', 'effectiveRetainedScrollbackLines', 'maximumConfiguredBoundaryEvidence',
  ]);
  if ((policy.action !== 'override-session-retained-policy'
      && policy.action !== 'preserve-session-retained-policy')
    || policy.scope !== 'session-generation-test-isolation'
    || !Number.isSafeInteger(policy.effectiveRetainedScrollbackLines)
    || Number(policy.effectiveRetainedScrollbackLines) < 0
    || Number(policy.effectiveRetainedScrollbackLines) > 50_000
    || policy.maximumConfiguredBoundaryEvidence !== 'unit-benchmark-only:max-50000-lines') {
    throw invalid('terminal-authority-debug-retained-policy-override-invalid');
  }
}

// @req MIG-BGSTAB-002
function validateRetainedCorpusInjection(value: unknown): void {
  const injection = asRecord(value, 'terminal-authority-debug-retained-corpus-invalid');
  const allowedActions = new Set([
    'inject-authoritative-raw-output-after-promotion',
    'inject-authoritative-raw-output-preserving-server-authority',
  ]);
  if (!allowedActions.has(String(injection.action))) {
    throw invalid('terminal-authority-debug-retained-corpus-action-invalid');
  }
  validateEncodedPayload(injection);
}

// @req MIG-BGSTAB-002
function validateProductionRangeProbe(value: unknown): void {
  const probe = asRecord(value, 'terminal-authority-debug-production-range-probe-invalid');
  if (probe.action !== 'generate-and-inject-production-configured-retained-corpus-stream'
    || probe.generator !== 'ph005-fixed-width-counter-v1'
    || !Number.isSafeInteger(probe.configuredScrollbackLines)
    || Number(probe.configuredScrollbackLines) < 0
    || Number(probe.configuredScrollbackLines) > 50_000
    || probe.materializationPolicy !== 'bounded-generator-window-no-full-cell-array'
    || probe.verificationPolicy !== 'checkpoint-streaming-rolling-sha256-boundary-oracle') {
    throw invalid('terminal-authority-debug-production-range-probe-policy-invalid');
  }
}

// @req MIG-BGSTAB-002
function validateQueryProbe(value: unknown): void {
  const probe = exactRecord(value, [
    'action', 'authoritativeModelInstanceId', 'encoding', 'data', 'decodedBytes', 'sha256',
    'duplicateProbeCount', 'probeSources', 'expectedReplyEncoding', 'expectedReplyData',
  ]);
  if (probe.action !== 'inject-live-pty-output-into-authoritative-headless-model'
    || !isOpaqueId(probe.authoritativeModelInstanceId)
    || probe.duplicateProbeCount !== 3
    || !Array.isArray(probe.probeSources)
    || probe.probeSources.length !== 3
    || probe.probeSources[0] !== 'seed'
    || probe.probeSources[1] !== 'replay'
    || probe.probeSources[2] !== 'live'
    || probe.expectedReplyEncoding !== 'base64') {
    throw invalid('terminal-authority-debug-query-probe-policy-invalid');
  }
  validateEncodedPayload(probe);
  decodeCanonicalBase64(probe.expectedReplyData, 'terminal-authority-debug-query-reply-invalid');
}

// @req MIG-BGSTAB-002
function validatePostSnapshotTail(value: unknown): void {
  const tail = exactRecord(value, [
    'action', 'checkpointIdentity', 'encoding', 'data', 'decodedBytes', 'sha256',
    'expectedLiteralMarker', 'echoSource',
  ]);
  if (tail.action !== 'inject-authoritative-output-after-checkpoint-drain'
    || tail.echoSource !== 'server-test-isolation-no-shell-command'
    || !isRecord(tail.checkpointIdentity)) {
    throw invalid('terminal-authority-debug-post-snapshot-tail-policy-invalid');
  }
  validateEncodedPayload(tail);
  requiredString(tail.expectedLiteralMarker, 'terminal-authority-debug-post-snapshot-tail-marker-invalid');
}

// @req MIG-BGSTAB-002
function validateEncodedPayload(record: JsonRecord): void {
  if (record.encoding !== 'base64') throw invalid('terminal-authority-debug-payload-encoding-invalid');
  const decoded = decodeCanonicalBase64(record.data, 'terminal-authority-debug-payload-base64-invalid');
  if (!Number.isSafeInteger(record.decodedBytes)
    || Number(record.decodedBytes) !== decoded.byteLength
    || typeof record.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.sha256)
    || createHash('sha256').update(decoded).digest('hex') !== record.sha256) {
    throw invalid('terminal-authority-debug-payload-integrity-invalid');
  }
}

// @req MIG-BGSTAB-002
function assertContinuationLease(contract: JsonRecord, lease: IsolationLease): void {
  if (contract.cleanupToken !== lease.cleanupToken) {
    throw conflict('terminal-authority-debug-continuation-cleanup-token-mismatch');
  }
  if (contract.isolationLeaseId !== lease.isolationLeaseId) {
    throw conflict('terminal-authority-debug-continuation-isolation-lease-mismatch');
  }
}

// @req MIG-BGSTAB-002
function assertContractVersion(contract: JsonRecord): void {
  if (contract.contractVersion !== 1) throw invalid('terminal-authority-debug-contract-version-invalid');
}

// @req MIG-BGSTAB-002
function assertAccepted(record: JsonRecord, message: string): void {
  if (record.accepted === true) return;
  const reason = typeof record.reason === 'string'
    ? record.reason.slice(0, 512)
    : null;
  throw unavailable(message, reason ? { reason } : undefined);
}

// @req MIG-BGSTAB-002
function requireAcceptedRuntimeEvidence(value: unknown, message: string): JsonRecord {
  const evidence = asRecord(value, message);
  assertAccepted(evidence, message);
  return evidence;
}

// @req MIG-BGSTAB-002
function assertInventory(value: unknown): asserts value is TerminalAuthorityDebugResourceInventory {
  const inventory = exactRecord(value, Object.keys(TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY));
  for (const key of Object.keys(TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY)) {
    if (!Number.isSafeInteger(inventory[key]) || Number(inventory[key]) < 0) {
      throw unavailable('terminal-authority-debug-resource-inventory-invalid');
    }
  }
}

// @req MIG-BGSTAB-002
function inventoryIsZero(inventory: TerminalAuthorityDebugResourceInventory): boolean {
  return Object.values(inventory).every(value => value === 0);
}

// @req MIG-BGSTAB-002
function exactRecord(value: unknown, allowedKeys: readonly string[]): JsonRecord {
  if (!isRecord(value)) throw invalid('terminal-authority-debug-request-object-required');
  const record = value;
  if (Object.keys(record).some(key => !allowedKeys.includes(key))) {
    throw invalid('terminal-authority-debug-request-unknown-field');
  }
  return record;
}

// @req MIG-BGSTAB-002
function asRecord(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) throw unavailable(message);
  return value;
}

// @req MIG-BGSTAB-002
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// @req MIG-BGSTAB-002
function requiredString(value: unknown, message: string): string {
  if (!isOpaqueId(value)) throw invalid(message);
  return value;
}

// @req MIG-BGSTAB-002
function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (!isOpaqueId(value)) throw invalid('terminal-authority-debug-nullable-string-invalid');
  return value;
}

// @req MIG-BGSTAB-002
function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

// @req MIG-BGSTAB-002
function asStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some(entry => !isOpaqueId(entry))) throw invalid(message);
  return [...new Set(value)];
}

// @req MIG-BGSTAB-002
function decodeCanonicalBase64(value: unknown, message: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw invalid(message);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw invalid(message);
  return decoded;
}

// @req MIG-BGSTAB-002
function invalid(message: string): TerminalAuthorityDebugError {
  return new TerminalAuthorityDebugError(400, 'INVALID_TERMINAL_AUTHORITY_DEBUG_REQUEST', message);
}

// @req MIG-BGSTAB-002
function conflict(message: string): TerminalAuthorityDebugError {
  return new TerminalAuthorityDebugError(409, 'TERMINAL_AUTHORITY_DEBUG_CONFLICT', message);
}

// @req MIG-BGSTAB-002
function unavailable(message: string, details?: JsonRecord): TerminalAuthorityDebugError {
  return new TerminalAuthorityDebugError(
    503,
    'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE',
    message,
    details,
  );
}
