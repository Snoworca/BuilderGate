import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY,
  TerminalAuthorityDebugError,
  createProductionTerminalAuthorityDebugRuntime,
  createTerminalAuthorityDebugHandlers,
  createTerminalAuthorityDebugService,
  parseTerminalAuthorityDebugIsolationRequest,
} from './TerminalAuthorityDebugService.js';

test('MIG-BGSTAB-002 production inventory exposes bounded authority audit metadata', async () => {
  let requestedAuditLimit: number | undefined;
  const runtime = createProductionTerminalAuthorityDebugRuntime({
    sessionManager: {
      getTerminalAuthorityDebugResourceInventory: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
        details: { authoritativeModelInstanceId: 'model-instance' },
      }),
    } as never,
    authority: {
      getAuthorityState: () => ({
        mode: 'promoting',
        heldPostBoundaryCount: 1,
      }) as never,
      getAuthorityAuditTrail: (_sessionId: string, limit?: number) => {
        requestedAuditLimit = limit;
        return [
          { type: 'compatibility-lease-rebind-failed', kind: 'compatibility-driver-view-missing' },
        ];
      },
    } as never,
  });

  const inspected = await runtime.inspectResources('session-audit');
  assert.deepEqual(inspected.details, {
    authoritativeModelInstanceId: 'model-instance',
    authorityState: {
      mode: 'promoting',
      heldPostBoundaryCount: 1,
    },
    authorityAuditTrail: [
      { type: 'compatibility-lease-rebind-failed', kind: 'compatibility-driver-view-missing' },
    ],
  });
  assert.equal(requestedAuditLimit, 32);
});

test('MIG-BGSTAB-002 production inventory exposes the exact attached responder view count', async () => {
  const runtime = createProductionTerminalAuthorityDebugRuntime({
    sessionManager: {
      getTerminalAuthorityDebugResourceInventory: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
    } as never,
    authority: {} as never,
    router: {
      getTerminalAuthorityResponderViews: sessionId => sessionId === 'session-detached'
        ? []
        : [{ connectionId: 'connection-1', viewGeneration: 7 }],
    },
  });

  const detached = await runtime.inspectResources('session-detached');
  const attached = await runtime.inspectResources('session-attached');

  assert.equal(detached.details?.attachedResponderViewCount, 0);
  assert.equal(attached.details?.attachedResponderViewCount, 1);
});

test('MIG-BGSTAB-002 debug evidence failures preserve bounded diagnostic metadata', async () => {
  const handlers = createTerminalAuthorityDebugHandlers({
    testIsolation: async () => {
      throw new TerminalAuthorityDebugError(
        503,
        'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE',
        'terminal-authority-debug-resource-inventory-leaked',
        {
          authorityAuditTrail: [
            {
              type: 'compatibility-lease-rebind-failed',
              kind: 'rebind-compatibility-driver-lease:compatibility-driver-view-missing',
            },
          ],
        },
      );
    },
  } as never);
  const responseEvidence = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let statusCode = 0;
    handlers.handleTestIsolation(
      { params: { id: 'session-audit' }, body: {} },
      {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: unknown) {
          resolve({ status: statusCode, body });
        },
      },
      reject,
    );
  });

  assert.deepEqual(responseEvidence, {
    status: 503,
    body: {
      error: {
        code: 'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE',
        message: 'terminal-authority-debug-resource-inventory-leaked',
        details: {
          authorityAuditTrail: [
            {
              type: 'compatibility-lease-rebind-failed',
              kind: 'rebind-compatibility-driver-lease:compatibility-driver-view-missing',
            },
          ],
        },
      },
    },
  });
});

test('MIG-BGSTAB-002 debug isolation parser accepts the exact basic legacy preparation', () => {
  assert.deepEqual(parseTerminalAuthorityDebugIsolationRequest({
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
  }), {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    operation: 'prepare',
  });
});

test('MIG-BGSTAB-002 configured retained-range preparation yields for fresh responder input after corpus apply', async () => {
  const sessionId = 'session-configured-range-yield';
  const ids = ['cleanup-token', 'isolation-lease'];
  let responderInputTurnObserved = false;
  let responderInputObservedBeforeRefresh = false;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authority: {
      beginPromotion: () => ({ ok: true }),
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({ sessionId, mode: 'server', sessionStatus: 'idle' }) as never,
      requestQueryResponderCapabilityRefresh: () => {
        responderInputObservedBeforeRefresh = responderInputTurnObserved;
        return true;
      },
      getQueryResponderCapabilityState: () => ({
        promotionEligible: true,
        hasAcceptedViewAttributes: true,
      }),
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode: 'server' } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => {
        setImmediate(() => { responderInputTurnObserved = true; });
        return {
          accepted: true,
          cleanupToken: input.cleanupToken,
          isolationLeaseId: input.isolationLeaseId,
          allAffectedViewsDrained: true,
        };
      },
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines: 10_000,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(
    responderInputObservedBeforeRefresh,
    true,
    'configured capability refresh must not run in the same event-loop turn as runtime recreation',
  );
});

test('MIG-BGSTAB-002 configured retained-range uses one exact refresh result without corpus-budget polling', async () => {
  const sessionId = 'session-configured-range-query-ready';
  const ids = ['cleanup-token', 'isolation-lease'];
  let capabilityReads = 0;
  let applyCalls = 0;
  let refreshCalls = 0;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 50,
    configuredRangeAuthoritySettleTimeoutMs: 40,
    authorityPollIntervalMs: 5,
    authority: {
      beginPromotion: () => ({ ok: true }),
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({ sessionId, mode: 'server', sessionStatus: 'idle' }) as never,
      requestQueryResponderCapabilityRefresh: () => {
        refreshCalls += 1;
        return true;
      },
      getQueryResponderCapabilityState: () => {
        capabilityReads += 1;
        return {
          promotionEligible: false,
          blocker: 'driver-view-attributes-unavailable',
          hasAcceptedViewAttributes: false,
        };
      },
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode: 'server' } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => {
        applyCalls += 1;
        return { accepted: true };
      },
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines: 10_000,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(applyCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(capabilityReads, 0, 'the exact refresh result must not be followed by a second reader snapshot');
});

test('MIG-BGSTAB-002 configured retained-range lets the bounded promotion gate recover after refreshed capability churn', async () => {
  const sessionId = 'session-configured-range-capability-churn';
  const ids = ['cleanup-token', 'isolation-lease'];
  let mode: 'legacy' | 'promoting' | 'server' = 'legacy';
  let promotionCalls = 0;
  let refreshCalls = 0;
  let cleanupCalls = 0;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 30,
    configuredRangeAuthoritySettleTimeoutMs: 30,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionCalls += 1;
        if (promotionCalls === 1) {
          return {
            ok: false,
            reason: 'queryResponderCapability-driver-view-attributes-unavailable-gate-failed',
          };
        }
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({
        sessionId,
        mode,
        sessionStatus: 'idle',
        authorityEpoch: 'authority-1',
        streamEpoch: 'stream-1',
        transitionEpoch: null,
      }) as never,
      requestQueryResponderCapabilityRefresh: () => {
        refreshCalls += 1;
        return true;
      },
      getQueryResponderCapabilityState: () => ({
        promotionEligible: false,
        blocker: 'driver-view-attributes-unavailable',
        hasAcceptedViewAttributes: false,
      }),
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines: 10_000,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(refreshCalls, 1, 'capability churn must not start another corpus-budget refresh loop');
  assert.equal(promotionCalls, 2, 'the bounded final promotion gate must own transient capability recovery');
  assert.equal(cleanupCalls, 0, 'transient capability churn must not tear down the configured isolation');
});

test('MIG-BGSTAB-002 promotion performs one final bounded attempt after the last poll crosses its deadline', async () => {
  const sessionId = 'session-promotion-deadline-boundary';
  const ids = ['cleanup-token', 'isolation-lease'];
  let mode: 'legacy' | 'promoting' | 'server' = 'legacy';
  let promotionCalls = 0;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 5,
    authorityPollIntervalMs: 10,
    authority: {
      beginPromotion: () => {
        promotionCalls += 1;
        if (promotionCalls === 1) {
          return { ok: false, reason: 'server-derived-canary-capability-gate-failed' };
        }
        mode = 'promoting';
        setTimeout(() => { mode = 'server'; }, 1);
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({
        sessionId,
        mode,
        sessionStatus: 'idle',
        authorityEpoch: 'authority-1',
        streamEpoch: 'stream-1',
        transitionEpoch: null,
      }) as never,
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(promotionCalls, 2);
});

test('MIG-BGSTAB-002 final promotion waits for production rollback before failed-open cleanup', async () => {
  const sessionId = 'session-promotion-final-rollback';
  const ids = ['cleanup-token', 'isolation-lease'];
  let mode: 'legacy' | 'promoting' | 'rolling-back' = 'legacy';
  let promotionCalls = 0;
  let rollbackCalls = 0;
  let cleanupMode: 'legacy' | 'promoting' | 'rolling-back' | null = null;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 5,
    authorityPollIntervalMs: 10,
    authority: {
      beginPromotion: () => {
        promotionCalls += 1;
        if (promotionCalls === 1) {
          return { ok: false, reason: 'server-derived-canary-capability-gate-failed' };
        }
        mode = 'promoting';
        setTimeout(() => { mode = 'rolling-back'; }, 1);
        setTimeout(() => { mode = 'legacy'; }, 2);
        return { ok: true };
      },
      beginRollback: () => {
        rollbackCalls += 1;
        return { ok: false, reason: 'unexpected-debug-rollback' };
      },
      getAuthorityState: () => ({
        sessionId,
        mode,
        sessionStatus: 'idle',
        authorityEpoch: 'authority-1',
        streamEpoch: 'stream-1',
        transitionEpoch: null,
      }) as never,
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: input => {
        assert.deepEqual(
          (input as typeof input & { authorityFence?: unknown }).authorityFence,
          {
            mode: 'legacy',
            authorityEpoch: 'authority-1',
            streamEpoch: 'stream-1',
            transitionEpoch: null,
          },
        );
        cleanupMode = mode;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  await assert.rejects(() => service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  }), (error: unknown) => (
    error instanceof TerminalAuthorityDebugError && error.status === 409
  ));
  assert.equal(promotionCalls, 2);
  assert.equal(rollbackCalls, 0);
  assert.equal(cleanupMode, 'legacy');
});

test('MIG-BGSTAB-002 configured retained-range preparation refreshes the current legacy capability after corpus apply', async () => {
  const sessionId = 'session-configured-range-capability-refresh';
  const ids = ['cleanup-token', 'isolation-lease'];
  let refreshCalls = 0;
  let capabilityReady = false;
  let capabilityReadyBeforeApply = false;
  let mode: 'legacy' | 'server' = 'legacy';
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    configuredRangeAuthoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({ sessionId, mode, sessionStatus: 'idle' }) as never,
      requestQueryResponderCapabilityRefresh: () => {
        refreshCalls += 1;
        capabilityReady = true;
        return true;
      },
      getQueryResponderCapabilityState: () => ({
        promotionEligible: capabilityReady,
        ...(capabilityReady ? {} : { blocker: 'driver-view-attributes-unavailable' }),
        hasAcceptedViewAttributes: capabilityReady,
      }),
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => {
        capabilityReadyBeforeApply = capabilityReady;
        return { accepted: true };
      },
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines: 10_000,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(refreshCalls, 1);
  assert.equal(capabilityReadyBeforeApply, false);
});

test('MIG-BGSTAB-002 configured retained-range preparation refreshes only the runtime recreated by corpus apply', async () => {
  const sessionId = 'session-configured-range-post-apply-capability';
  const ids = ['cleanup-token', 'isolation-lease'];
  let refreshCalls = 0;
  let capabilityReady = false;
  let promotionCalls = 0;
  let mode: 'legacy' | 'server' = 'legacy';
  let runtimeGeneration = 1;
  let refreshedRuntimeGeneration = 0;
  const callOrder: string[] = [];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    configuredRangeAuthoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        callOrder.push('promote');
        promotionCalls += 1;
        if (!capabilityReady || refreshedRuntimeGeneration !== runtimeGeneration) {
          return { ok: false, reason: 'promotion-boundary-invalidated' };
        }
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({ sessionId, mode, sessionStatus: 'idle' }) as never,
      requestQueryResponderCapabilityRefresh: () => {
        callOrder.push('refresh');
        refreshCalls += 1;
        refreshedRuntimeGeneration = runtimeGeneration;
        capabilityReady = true;
        return true;
      },
      getQueryResponderCapabilityState: () => {
        callOrder.push('read');
        return {
          promotionEligible: capabilityReady,
          ...(capabilityReady ? {} : { blocker: 'driver-view-attributes-unavailable' }),
          hasAcceptedViewAttributes: capabilityReady,
        };
      },
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => {
        callOrder.push('open');
        return {
          accepted: true,
          cleanupToken: input.cleanupToken,
          isolationLeaseId: input.isolationLeaseId,
          allAffectedViewsDrained: true,
        };
      },
      applyIsolationContract: () => {
        callOrder.push('apply');
        runtimeGeneration += 1;
        capabilityReady = false;
        return { accepted: true };
      },
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines: 10_000,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(refreshCalls, 1, 'the final runtime capability must be refreshed exactly once');
  assert.equal(promotionCalls, 1, 'promotion must start only after final runtime readiness');
  assert.equal(refreshedRuntimeGeneration, runtimeGeneration);
  assert.deepEqual(callOrder, ['open', 'apply', 'refresh', 'promote']);
});

test('MIG-BGSTAB-002 configured retained-range apply failure cleans up without refresh or promotion', async () => {
  const sessionId = 'session-configured-range-apply-failure-order';
  const ids = ['cleanup-token', 'isolation-lease'];
  let refreshCalls = 0;
  let promotionCalls = 0;
  let cleanupCalls = 0;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 10,
    configuredRangeAuthoritySettleTimeoutMs: 10,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionCalls += 1;
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({ sessionId, mode: 'legacy', sessionStatus: 'idle' }) as never,
      requestQueryResponderCapabilityRefresh: () => {
        refreshCalls += 1;
        return true;
      },
      getQueryResponderCapabilityState: () => ({
        promotionEligible: true,
        hasAcceptedViewAttributes: true,
      }),
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId, mode: 'legacy' } }),
    } as never,
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: false, reason: 'injected-apply-failure' }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  await assert.rejects(
    service.testIsolation(sessionId, {
      desiredMode: 'server',
      transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
      testContract: {
        contractVersion: 1,
        productionConfiguredRangeProbe: {
          action: 'generate-and-inject-production-configured-retained-corpus-stream',
          generator: 'ph005-fixed-width-counter-v1',
          configuredScrollbackLines: 10_000,
          materializationPolicy: 'bounded-generator-window-no-full-cell-array',
          verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
        },
      },
    }),
    /terminal-authority-debug-contract-rejected/u,
  );
  assert.equal(refreshCalls, 0);
  assert.equal(promotionCalls, 0);
  assert.equal(cleanupCalls, 1);
});

for (const scenario of [
  {
    name: 'rejected current runtime capability refresh',
    capabilityRefresh: () => false,
    capabilityReader: () => ({
      promotionEligible: false,
      blocker: 'driver-view-attributes-unavailable',
      hasAcceptedViewAttributes: false,
    }),
    expectedApplyCalls: 1,
    expectedError: /queryResponderCapability-refresh-rejected/u,
  },
  {
    name: 'missing refresh hook with ready reader',
    capabilityRefresh: undefined,
    capabilityReader: () => ({
      promotionEligible: true,
      hasAcceptedViewAttributes: true,
    }),
    expectedApplyCalls: 0,
    expectedError: /queryResponderCapability-refresh-unavailable/u,
  },
] as const) {
  test(`MIG-BGSTAB-002 configured retained-range preparation fails closed for ${scenario.name}`, async () => {
    const sessionId = `session-configured-range-${scenario.name.replaceAll(' ', '-')}`;
    const ids = ['cleanup-token', 'isolation-lease'];
    let applyCalls = 0;
    let cleanupCalls = 0;
    let promotionCalls = 0;
    const service = createTerminalAuthorityDebugService({
      createId: () => ids.shift() ?? 'unexpected-id',
      authoritySettleTimeoutMs: 5,
      configuredRangeAuthoritySettleTimeoutMs: 5,
      authorityPollIntervalMs: 1,
      authority: {
        beginPromotion: () => {
          promotionCalls += 1;
          return { ok: true };
        },
        beginRollback: () => ({ ok: true }),
        getAuthorityState: () => ({ sessionId, mode: 'legacy', sessionStatus: 'idle' }) as never,
        ...(scenario.capabilityRefresh
          ? { requestQueryResponderCapabilityRefresh: scenario.capabilityRefresh }
          : {}),
        ...(scenario.capabilityReader
          ? { getQueryResponderCapabilityState: scenario.capabilityReader }
          : {}),
        getAuthorityController: () => ({}) as never,
        getSessionSnapshot: () => ({ state: { sessionId, mode: 'legacy' } }),
      } as never,
      router: { getTerminalAuthorityResponderViews: () => [] },
      runtime: {
        openIsolation: input => ({
          accepted: true,
          cleanupToken: input.cleanupToken,
          isolationLeaseId: input.isolationLeaseId,
          allAffectedViewsDrained: true,
        }),
        applyIsolationContract: () => {
          applyCalls += 1;
          return { accepted: true };
        },
        cleanupIsolation: () => {
          cleanupCalls += 1;
          return { accepted: true };
        },
        inspectResources: () => ({
          resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
        }),
        prepareRollbackContract: () => ({ accepted: true }),
        triggerFault: () => ({ accepted: true }),
      },
    });

    await assert.rejects(
      service.testIsolation(sessionId, {
        desiredMode: 'server',
        transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
        testContract: {
          contractVersion: 1,
          productionConfiguredRangeProbe: {
            action: 'generate-and-inject-production-configured-retained-corpus-stream',
            generator: 'ph005-fixed-width-counter-v1',
            configuredScrollbackLines: 10_000,
            materializationPolicy: 'bounded-generator-window-no-full-cell-array',
            verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
          },
        },
      }),
      scenario.expectedError,
    );
    assert.equal(applyCalls, scenario.expectedApplyCalls);
    assert.equal(promotionCalls, 0);
    assert.equal(cleanupCalls, 1);
  });
}

test('MIG-BGSTAB-002 fresh legacy isolation performs a real promotion and compatibility rollback', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  const transitions: string[] = [];
  const ids = ['cleanup-token', 'isolation-lease'];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        transitions.push('promotion');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        transitions.push('rollback');
        mode = 'legacy';
        return { ok: true };
      },
      getAuthorityState: () => ({
        sessionId: 'session-fresh-legacy',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-fresh-legacy', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-fresh-legacy', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'legacy');
  assert.deepEqual(transitions, ['promotion', 'rollback']);
});

test('MIG-BGSTAB-002 debug isolation parser accepts an integrity-bound query continuation', () => {
  const data = Buffer.from('\u001b[c', 'utf8');
  const parsed = parseTerminalAuthorityDebugIsolationRequest({
    desiredMode: 'server',
    transitionPolicy: 'preserve-current-server-authority',
    testContract: {
      contractVersion: 1,
      cleanupToken: 'cleanup-token',
      isolationLeaseId: 'isolation-lease',
      queryResponderProbe: {
        action: 'inject-live-pty-output-into-authoritative-headless-model',
        authoritativeModelInstanceId: 'model-instance',
        encoding: 'base64',
        data: data.toString('base64'),
        decodedBytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
        duplicateProbeCount: 3,
        probeSources: ['seed', 'replay', 'live'],
        expectedReplyEncoding: 'base64',
        expectedReplyData: Buffer.from('\u001b[?1;2c', 'utf8').toString('base64'),
      },
    },
  });
  assert.equal(parsed.operation, 'query-probe');
});

test('MIG-BGSTAB-002 debug isolation parser rejects an integrity mismatch without fallback', () => {
  const data = Buffer.from('tail', 'utf8');
  assert.throws(() => parseTerminalAuthorityDebugIsolationRequest({
    desiredMode: 'server',
    transitionPolicy: 'preserve-current-server-authority',
    testContract: {
      contractVersion: 1,
      cleanupToken: 'cleanup-token',
      isolationLeaseId: 'isolation-lease',
      deterministicPostSnapshotTail: {
        action: 'inject-authoritative-output-after-checkpoint-drain',
        checkpointIdentity: { sessionId: 'session' },
        encoding: 'base64',
        data: data.toString('base64'),
        decodedBytes: data.byteLength,
        sha256: '0'.repeat(64),
        expectedLiteralMarker: 'tail',
        echoSource: 'server-test-isolation-no-shell-command',
      },
    },
  }), (error: unknown) => (
    error instanceof TerminalAuthorityDebugError
    && error.status === 400
    && error.message === 'terminal-authority-debug-payload-integrity-invalid'
  ));
});

test('MIG-BGSTAB-002 debug isolation parser rejects unknown mutation fields', () => {
  assert.throws(() => parseTerminalAuthorityDebugIsolationRequest({
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    bypassGuard: true,
  }), (error: unknown) => (
    error instanceof TerminalAuthorityDebugError
    && error.status === 400
    && error.message === 'terminal-authority-debug-request-unknown-field'
  ));
});

test('MIG-BGSTAB-002 debug isolation parser rejects a mode-policy mismatch', () => {
  assert.throws(() => parseTerminalAuthorityDebugIsolationRequest({
    desiredMode: 'legacy',
    transitionPolicy: 'preserve-current-server-authority',
  }), (error: unknown) => (
    error instanceof TerminalAuthorityDebugError
    && error.status === 400
    && error.message === 'terminal-authority-debug-transition-policy-mode-mismatch'
  ));
});

test('MIG-BGSTAB-002 continuation refuses to mutate after server authority has been lost', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let continuationMutations = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        mode = 'legacy';
        return { ok: true };
      },
      getAuthorityState: () => ({ sessionId: 'session-continuation', mode, sessionStatus: 'idle' }) as never,
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-continuation', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => {
        continuationMutations += 1;
        return { accepted: true };
      },
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({ resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY } }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });
  const preparation = await service.testIsolation('session-continuation', {
    desiredMode: 'server',
    transitionPolicy: 'preserve-current-server-authority',
  });
  mode = 'rolling-back';
  const query = Buffer.from('\u001b[c', 'utf8');
  await assert.rejects(service.testIsolation('session-continuation', {
    desiredMode: 'server',
    transitionPolicy: 'preserve-current-server-authority',
    testContract: {
      contractVersion: 1,
      cleanupToken: preparation.body.cleanupToken,
      isolationLeaseId: preparation.body.isolationLeaseId,
      queryResponderProbe: {
        action: 'inject-live-pty-output-into-authoritative-headless-model',
        authoritativeModelInstanceId: 'model-instance',
        encoding: 'base64',
        data: query.toString('base64'),
        decodedBytes: query.byteLength,
        sha256: createHash('sha256').update(query).digest('hex'),
        duplicateProbeCount: 3,
        probeSources: ['seed', 'replay', 'live'],
        expectedReplyEncoding: 'base64',
        expectedReplyData: Buffer.from('\u001b[?1;2c', 'utf8').toString('base64'),
      },
    },
  }), (error: unknown) => (
    error instanceof TerminalAuthorityDebugError
    && error.message.startsWith('terminal-authority-debug-session-snapshot-identity-mismatch:')
  ));
  assert.equal(continuationMutations, 0);
});

test('MIG-BGSTAB-002 rejected continuation preserves the bounded runtime reason', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  const ids = ['cleanup-token', 'isolation-lease'];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        mode = 'legacy';
        return { ok: true };
      },
      getAuthorityState: () => ({ sessionId: 'session-rejected-continuation', mode, sessionStatus: 'idle' }) as never,
      getAuthorityController: () => ({}) as never,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-rejected-continuation', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({
        accepted: false,
        reason: 'debug-query-model-identity-mismatch',
      }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({ resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY } }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });
  const preparation = await service.testIsolation('session-rejected-continuation', {
    desiredMode: 'server',
    transitionPolicy: 'preserve-current-server-authority',
  });
  const query = Buffer.from('\u001b[c', 'utf8');

  await assert.rejects(service.testIsolation('session-rejected-continuation', {
    desiredMode: 'server',
    transitionPolicy: 'preserve-current-server-authority',
    testContract: {
      contractVersion: 1,
      cleanupToken: preparation.body.cleanupToken,
      isolationLeaseId: preparation.body.isolationLeaseId,
      queryResponderProbe: {
        action: 'inject-live-pty-output-into-authoritative-headless-model',
        authoritativeModelInstanceId: 'model-instance',
        encoding: 'base64',
        data: query.toString('base64'),
        decodedBytes: query.byteLength,
        sha256: createHash('sha256').update(query).digest('hex'),
        duplicateProbeCount: 3,
        probeSources: ['seed', 'replay', 'live'],
        expectedReplyEncoding: 'base64',
        expectedReplyData: Buffer.from('\u001b[?1;2c', 'utf8').toString('base64'),
      },
    },
  }), (error: unknown) => (
    error instanceof TerminalAuthorityDebugError
    && error.status === 503
    && error.message === 'terminal-authority-debug-continuation-rejected'
    && error.details?.reason === 'debug-query-model-identity-mismatch'
  ));
});

test('MIG-BGSTAB-002 failed-open server isolation rolls authority back before resource cleanup', async () => {
  const calls: string[] = [];
  let mode: 'legacy' | 'server' = 'legacy';
  const ids = ['cleanup-token', 'isolation-lease'];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        calls.push('promotion');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        calls.push('rollback');
        mode = 'legacy';
        return { ok: true };
      },
      getAuthorityState: () => ({
        sessionId: 'session-debug',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => undefined,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug', mode } }),
    },
    router: {
      getTerminalAuthorityResponderViews: () => [],
    },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        calls.push('cleanup');
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  await assert.rejects(
    service.testIsolation('session-debug', {
      desiredMode: 'server',
      transitionPolicy: 'preserve-current-server-authority',
    }),
    (error: unknown) => (
      error instanceof TerminalAuthorityDebugError
      && error.message === 'terminal-authority-debug-controller-unavailable'
    ),
  );
  assert.deepEqual(
    calls,
    ['promotion', 'rollback', 'cleanup'],
    'failed-open cleanup must restore authority before tearing down isolation resources',
  );
});

test('MIG-BGSTAB-002 model replacement reacquires recovery ACK inside one isolation lease', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        if (promotionAttempts === 1) return { ok: false, reason: 'server-recovery-ack-missing' };
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({
        sessionId: 'session-debug-recovery',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-recovery', mode } }),
    },
    router: {
      getTerminalAuthorityResponderViews: () => [],
    },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-recovery', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(promotionAttempts, 2);
});

test('MIG-BGSTAB-002 invalidated promotion boundary recovers before retrying isolation promotion', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let promotionAttempts = 0;
  let rollbackAttempts = 0;
  let rollingBackReads = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        if (promotionAttempts === 1) {
          mode = 'rolling-back';
          return { ok: false, reason: 'promotion-boundary-invalidated' };
        }
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        return { ok: false, reason: 'competing-debug-rollback' };
      },
      getAuthorityState: () => {
        if (mode === 'rolling-back') {
          rollingBackReads += 1;
          if (rollingBackReads >= 3) mode = 'legacy';
        }
        return {
          sessionId: 'session-debug-boundary-recovery',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-boundary-recovery', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-boundary-recovery', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(promotionAttempts, 2);
  assert.equal(rollbackAttempts, 0);
});

test('MIG-BGSTAB-002 invalidated rollback transaction waits for production-owned recovery before legacy isolation settles', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) {
          mode = 'rolling-back';
          setTimeout(() => { mode = 'legacy'; }, 5);
          return { ok: false, reason: 'rollback-transaction-invalidated' };
        }
        return { ok: false, reason: 'competing-debug-rollback' };
      },
      getAuthorityState: () => ({
        sessionId: 'session-debug-rollback-recovery',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-rollback-recovery', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-rollback-recovery', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'legacy');
  assert.equal(rollbackAttempts, 1, 'production recovery owns the invalidated transaction replacement');
});

test('MIG-BGSTAB-002 legacy isolation waits for topology-owned rollback start recovery', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'server';
  let rollbackAttempts = 0;
  let rollingBackReads = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => ({ ok: false, reason: 'unexpected-promotion' }),
      beginRollback: () => {
        rollbackAttempts += 1;
        mode = 'rolling-back';
        return { ok: false, reason: 'rollback-start-enqueue-failed' };
      },
      getAuthorityState: () => {
        if (mode === 'rolling-back') {
          rollingBackReads += 1;
          if (rollingBackReads >= 3) mode = 'legacy';
        }
        return {
          sessionId: 'session-debug-rollback-start-recovery',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-rollback-start-recovery', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-rollback-start-recovery', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'legacy');
  assert.equal(rollbackAttempts, 1);
});

test('MIG-BGSTAB-002 configured retained range receives its bounded extended ACK settlement window', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  const startedAt = Date.now();
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 5,
    configuredRangeAuthoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        if (Date.now() - startedAt < 25) {
          return { ok: false, reason: 'server-recovery-ack-missing' };
        }
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        mode = 'rolling-back';
        setTimeout(() => { mode = 'legacy'; }, 25);
        return { ok: true };
      },
      getAuthorityState: () => ({
        sessionId: 'session-configured-range',
        mode,
        sessionStatus: 'idle',
      }) as never,
      requestQueryResponderCapabilityRefresh: () => true,
      getQueryResponderCapabilityState: () => ({
        promotionEligible: true,
        hasAcceptedViewAttributes: true,
      }),
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-configured-range', mode } }),
    },
    router: {
      getTerminalAuthorityResponderViews: () => [],
    },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-configured-range', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines: 10_000,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
      },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.ok(Date.now() - startedAt >= 25);
  const cleanup = await service.testIsolation('session-configured-range', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: result.body.cleanupToken,
        isolationLeaseId: result.body.isolationLeaseId,
        restoreScopes: [
          'session-local-retained-policy',
          'retained-corpus',
          'alternate-buffer-fixture',
          'responder-mode',
          'listeners',
          'driver-and-responder-leases',
          'timers',
          'fault-state',
        ],
      },
    },
  });
  assert.equal(cleanup.status, 200);
  assert.equal(mode, 'legacy');
});

test('MIG-BGSTAB-002 model replacement waits for the recovery view to reconnect inside one isolation lease', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        if (promotionAttempts === 1) return { ok: false, reason: 'server-recovery-view-unavailable' };
        if (promotionAttempts === 2) return { ok: false, reason: 'server-recovery-capable-view-unavailable' };
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({
        sessionId: 'session-debug-reconnect',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-reconnect', mode } }),
    },
    router: {
      getTerminalAuthorityResponderViews: () => [],
    },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-reconnect', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(promotionAttempts, 3);
});

test('MIG-BGSTAB-002 promotion waits for the replacement legacy lease admission to reopen', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        if (promotionAttempts === 1) {
          return { ok: false, reason: 'promotion-candidate-admission-not-legacy' };
        }
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({
        sessionId: 'session-debug-legacy-rebind',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-legacy-rebind', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-legacy-rebind', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(promotionAttempts, 2);
});

test('MIG-BGSTAB-002 promotion retry observes authority that converged between state read and command', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        mode = 'server';
        return { ok: false, reason: 'server-derived-canary-mode-gate-failed' };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => ({
        sessionId: 'session-debug-converged-race',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-converged-race', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-converged-race', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(promotionAttempts, 1);
});

test('MIG-BGSTAB-002 promotion waits for an in-flight compatibility rollback before touching replay state', async () => {
  let mode: 'rolling-back' | 'legacy' | 'server' = 'rolling-back';
  let stateReads = 0;
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        assert.equal(mode, 'legacy', 'promotion must not supersede replay while rollback owns the lane');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => ({ ok: true }),
      getAuthorityState: () => {
        stateReads += 1;
        if (mode === 'rolling-back' && stateReads >= 3) mode = 'legacy';
        return {
          sessionId: 'session-debug-wait-rollback',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-wait-rollback', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-wait-rollback', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(promotionAttempts, 1);
});

test('MIG-BGSTAB-002 promotion observes an active production rollback without starting a debug rollback', async () => {
  let mode: 'rolling-back' | 'legacy' | 'server' = 'rolling-back';
  let stateReads = 0;
  let rollbackAttempts = 0;
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        assert.equal(mode, 'legacy');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        return { ok: false, reason: 'rollback-transaction-invalidated' };
      },
      getAuthorityState: () => {
        stateReads += 1;
        if (mode === 'rolling-back' && stateReads >= 3) mode = 'legacy';
        return {
          sessionId: 'session-debug-production-rollback-owner',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-production-rollback-owner', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-production-rollback-owner', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(rollbackAttempts, 0, 'production owns the active rollback transaction');
  assert.equal(promotionAttempts, 1);
});

test('MIG-BGSTAB-002 promotion observes aborted topology recovery without starting a debug rollback', async () => {
  let mode: 'aborted' | 'rolling-back' | 'legacy' | 'server' = 'aborted';
  let stateReads = 0;
  let rollbackAttempts = 0;
  let promotionAttempts = 0;
  const observedModes: string[] = [];
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        assert.equal(mode, 'legacy');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        return { ok: true };
      },
      getAuthorityState: () => {
        stateReads += 1;
        if (mode === 'aborted' && stateReads >= 3) mode = 'rolling-back';
        if (mode === 'rolling-back' && stateReads >= 5) mode = 'legacy';
        observedModes.push(mode);
        return {
          sessionId: 'session-debug-aborted-topology-owner',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-aborted-topology-owner', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-aborted-topology-owner', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(rollbackAttempts, 0, 'production owns aborted topology recovery');
  assert.equal(promotionAttempts, 1);
  assert.ok(observedModes.includes('aborted'));
  assert.ok(observedModes.includes('rolling-back'));
  assert.ok(observedModes.includes('legacy'));
});

for (const recoveryMode of ['promoting', 'rolling-back', 'aborted'] as const) {
  test(`MIG-BGSTAB-002 promotion fails closed without overlapping cleanup when ${recoveryMode} recovery stalls`, async () => {
    let rollbackAttempts = 0;
    let promotionAttempts = 0;
    let cleanupCalls = 0;
    const ids = ['cleanup-token', 'isolation-lease'];
    const controller = {} as never;
    const sessionId = `session-debug-stalled-${recoveryMode}`;
    const service = createTerminalAuthorityDebugService({
      createId: () => ids.shift() ?? 'unexpected-id',
      authoritySettleTimeoutMs: 5,
      authorityPollIntervalMs: 1,
      authority: {
        beginPromotion: () => {
          promotionAttempts += 1;
          return { ok: false, reason: 'unexpected-promotion' };
        },
        beginRollback: () => {
          rollbackAttempts += 1;
          return { ok: false, reason: 'competing-debug-rollback' };
        },
        getAuthorityState: () => ({
          sessionId,
          mode: recoveryMode,
          sessionStatus: 'idle',
        }) as never,
        getAuthorityController: () => controller,
        getSessionSnapshot: () => ({ state: { sessionId, mode: recoveryMode } }),
      },
      router: { getTerminalAuthorityResponderViews: () => [] },
      runtime: {
        openIsolation: input => ({
          accepted: true,
          cleanupToken: input.cleanupToken,
          isolationLeaseId: input.isolationLeaseId,
          allAffectedViewsDrained: true,
        }),
        applyIsolationContract: () => ({ accepted: true }),
        cleanupIsolation: () => {
          cleanupCalls += 1;
          return { accepted: true };
        },
        inspectResources: () => ({
          resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
        }),
        prepareRollbackContract: () => ({ accepted: true }),
        triggerFault: () => ({ accepted: true }),
      },
    });

    await assert.rejects(
      service.testIsolation(sessionId, {
        desiredMode: 'server',
        transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
      }),
      (error: unknown) => (
        error instanceof TerminalAuthorityDebugError
        && error.status === 409
        && error.code === 'TERMINAL_AUTHORITY_DEBUG_CONFLICT'
        && error.message === 'terminal-authority-debug-server-settle-timeout'
      ),
    );

    assert.equal(promotionAttempts, 0);
    assert.equal(rollbackAttempts, 0);
    assert.equal(cleanupCalls, 0, 'debug cleanup must not tear down isolation during production recovery');
  });
}

test('MIG-BGSTAB-002 promotion waits for a stalled production compatibility rollback before retrying', async () => {
  let mode: 'rolling-back' | 'legacy' | 'server' = 'rolling-back';
  let stateReads = 0;
  let rollbackAttempts = 0;
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        assert.equal(mode, 'legacy');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        return { ok: false, reason: 'competing-debug-rollback' };
      },
      getAuthorityState: () => {
        stateReads += 1;
        if (mode === 'rolling-back' && stateReads >= 3) mode = 'legacy';
        return {
          sessionId: 'session-debug-resume-rollback',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-resume-rollback', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-resume-rollback', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  assert.equal(result.status, 200);
  assert.equal(rollbackAttempts, 0);
  assert.equal(promotionAttempts, 1);
});

test('MIG-BGSTAB-002 promotion waits for production topology recovery without resuming rollback', async () => {
  let mode: 'rolling-back' | 'legacy' | 'server' = 'rolling-back';
  let stateReads = 0;
  let rollbackAttempts = 0;
  let promotionAttempts = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        promotionAttempts += 1;
        assert.equal(mode, 'legacy');
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        return { ok: false, reason: 'rollback-transaction-invalidated' };
      },
      getAuthorityState: () => {
        stateReads += 1;
        if (mode === 'rolling-back' && stateReads >= 4) mode = 'legacy';
        return {
          sessionId: 'session-debug-invalidated-resume',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-invalidated-resume', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const result = await service.testIsolation('session-debug-invalidated-resume', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'server');
  assert.equal(rollbackAttempts, 0);
  assert.equal(promotionAttempts, 1);
});

test('MIG-BGSTAB-002 cleanup waits through the ordered rollback drain before releasing isolation', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackReads = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 10,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        mode = 'rolling-back';
        return { ok: true };
      },
      getAuthorityState: () => {
        if (mode === 'rolling-back') {
          rollbackReads += 1;
          // Windows timers commonly round the 1ms poll to a 15.6ms tick. Two
          // reads still prove that cleanup waited instead of releasing on the
          // first rolling-back observation without making a 30ms bound flaky.
          if (rollbackReads >= 2) mode = 'legacy';
        }
        return {
          sessionId: 'session-debug-rollback-drain',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-rollback-drain', mode } }),
    },
    router: {
      getTerminalAuthorityResponderViews: () => [],
    },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({
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
      }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation('session-debug-rollback-drain', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  const cleanup = await service.testIsolation('session-debug-rollback-drain', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: preparation.body.cleanupToken,
        isolationLeaseId: preparation.body.isolationLeaseId,
        restoreScopes: [
          'session-local-retained-policy',
          'retained-corpus',
          'alternate-buffer-fixture',
          'responder-mode',
          'listeners',
          'driver-and-responder-leases',
          'timers',
          'fault-state',
        ],
      },
    },
  });
  assert.equal(cleanup.status, 200);
  assert.equal(mode, 'legacy');
});

test('MIG-BGSTAB-002 cleanup waits for topology-owned recovery after rollback start admission fails', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollingBackReads = 0;
  let rollbackAttempts = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        mode = 'rolling-back';
        return { ok: false, reason: 'rollback-start-enqueue-failed' };
      },
      getAuthorityState: () => {
        if (mode === 'rolling-back') {
          rollingBackReads += 1;
          if (rollingBackReads >= 3) mode = 'legacy';
        }
        return {
          sessionId: 'session-debug-topology-owned-cleanup',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-topology-owned-cleanup', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation('session-debug-topology-owned-cleanup', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  const cleanup = await service.testIsolation('session-debug-topology-owned-cleanup', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: preparation.body.cleanupToken,
        isolationLeaseId: preparation.body.isolationLeaseId,
        restoreScopes: ['session-local-retained-policy'],
      },
    },
  });

  assert.equal(cleanup.status, 200);
  assert.equal(mode, 'legacy');
  assert.equal(rollbackAttempts, 1);
  assert.equal(cleanupCalls, 1);
});

test('MIG-BGSTAB-002 cleanup retries transient zero-view rollback admission before releasing isolation', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const sessionId = 'session-debug-transient-zero-view-cleanup';
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) {
          return { ok: false, reason: 'compatibility-view-unavailable' };
        }
        mode = 'rolling-back';
        setTimeout(() => { mode = 'legacy'; }, 1);
        return { ok: true };
      },
      getAuthorityState: () => ({
        sessionId,
        mode,
        sessionStatus: 'idle',
        authorityEpoch: 'authority-1',
        streamEpoch: 'stream-1',
        transitionEpoch: 'transition-1',
      }) as never,
      getAuthorityController: () => ({} as never),
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  const cleanup = await service.testIsolation(sessionId, {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: preparation.body.cleanupToken,
        isolationLeaseId: preparation.body.isolationLeaseId,
        restoreScopes: ['session-local-retained-policy'],
      },
    },
  });

  assert.equal(cleanup.status, 200);
  assert.equal(rollbackAttempts, 2);
  assert.equal(mode, 'legacy');
  assert.equal(cleanupCalls, 1);
});

test('MIG-BGSTAB-002 cleanup bounds persistent zero-view rollback admission failure', async () => {
  let mode: 'legacy' | 'server' = 'legacy';
  let rollbackAttempts = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const sessionId = 'session-debug-persistent-zero-view-cleanup';
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 20,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        return { ok: false, reason: 'compatibility-view-unavailable' };
      },
      getAuthorityState: () => ({ sessionId, mode, sessionStatus: 'idle' }) as never,
      getAuthorityController: () => ({} as never),
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  await assert.rejects(
    service.testIsolation(sessionId, {
      desiredMode: 'legacy',
      transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
      testContract: {
        contractVersion: 1,
        cleanup: {
          action: 'restore-session-test-isolation-by-token-and-lease',
          cleanupToken: preparation.body.cleanupToken,
          isolationLeaseId: preparation.body.isolationLeaseId,
          restoreScopes: ['session-local-retained-policy'],
        },
      },
    }),
    (error: unknown) => (
      error instanceof TerminalAuthorityDebugError
      && error.status === 409
      && error.message === 'compatibility-view-unavailable'
    ),
  );
  assert.ok(rollbackAttempts >= 2 && rollbackAttempts <= 64, `attempts=${rollbackAttempts}`);
  assert.equal(mode, 'server');
  assert.equal(cleanupCalls, 0);
});

test('MIG-BGSTAB-002 duplicate cleanup for one token and lease joins the active rollback transaction', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        mode = 'rolling-back';
        return { ok: true };
      },
      getAuthorityState: () => ({
        sessionId: 'session-debug-cleanup-single-flight',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => ({} as never),
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-cleanup-single-flight', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });
  const sessionId = 'session-debug-cleanup-single-flight';
  const preparation = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  const request = {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: preparation.body.cleanupToken,
        isolationLeaseId: preparation.body.isolationLeaseId,
        restoreScopes: ['session-local-retained-policy'],
      },
    },
  };

  const first = service.testIsolation(sessionId, request);
  await new Promise<void>(resolve => setImmediate(resolve));
  const duplicate = service.testIsolation(sessionId, request);
  await new Promise<void>(resolve => setImmediate(resolve));
  mode = 'legacy';
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(rollbackAttempts, 1, 'a duplicate request cannot restart the active rollback');
  assert.equal(cleanupCalls, 1, 'one token and lease must restore runtime resources exactly once');
});

test('MIG-BGSTAB-002 conflicting cleanup cannot disturb the active rollback transaction', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        mode = 'rolling-back';
        return { ok: true };
      },
      getAuthorityState: () => ({
        sessionId: 'session-debug-cleanup-conflict',
        mode,
        sessionStatus: 'idle',
      }) as never,
      getAuthorityController: () => ({} as never),
      getSessionSnapshot: () => ({
        state: { sessionId: 'session-debug-cleanup-conflict', mode },
      }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });
  const sessionId = 'session-debug-cleanup-conflict';
  const preparation = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  const cleanupRequest = (cleanupToken: unknown, isolationLeaseId: unknown) => ({
    desiredMode: 'legacy' as const,
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain' as const,
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken,
        isolationLeaseId,
        restoreScopes: ['session-local-retained-policy'],
      },
    },
  });
  const active = service.testIsolation(sessionId, cleanupRequest(
    preparation.body.cleanupToken,
    preparation.body.isolationLeaseId,
  ));
  await new Promise<void>(resolve => setImmediate(resolve));
  const assertConflict = (request: ReturnType<typeof cleanupRequest>) => assert.rejects(
    service.testIsolation(sessionId, request),
    (error: unknown) => (
      error instanceof TerminalAuthorityDebugError
      && error.status === 409
      && error.code === 'TERMINAL_AUTHORITY_DEBUG_CONFLICT'
      && error.message === 'terminal-authority-debug-cleanup-lease-mismatch'
    ),
  );

  await assertConflict(cleanupRequest('different-cleanup-token', preparation.body.isolationLeaseId));
  await assertConflict(cleanupRequest(preparation.body.cleanupToken, 'different-isolation-lease'));
  assert.equal(rollbackAttempts, 1, 'conflicting ownership cannot restart the active rollback');
  assert.equal(cleanupCalls, 0, 'conflicting ownership cannot release isolation resources');

  mode = 'legacy';
  const result = await active;
  assert.equal(result.status, 200);
  assert.equal(rollbackAttempts, 1);
  assert.equal(cleanupCalls, 1);
});

test('MIG-BGSTAB-002 cleanup observes a stalled production rollback without restarting it', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  let rollbackReads = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const controller = {} as never;
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 10,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        throw new Error('cleanup must not restart an existing production rollback');
      },
      getAuthorityState: () => {
        if (mode === 'rolling-back') {
          rollbackReads += 1;
          if (rollbackReads >= 3) mode = 'legacy';
        }
        return {
          sessionId: 'session-debug-stalled-cleanup',
          mode,
          sessionStatus: 'idle',
        } as never;
      },
      getAuthorityController: () => controller,
      getSessionSnapshot: () => ({ state: { sessionId: 'session-debug-stalled-cleanup', mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => ({ accepted: true }),
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation('session-debug-stalled-cleanup', {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  mode = 'rolling-back';
  const cleanup = await service.testIsolation('session-debug-stalled-cleanup', {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: preparation.body.cleanupToken,
        isolationLeaseId: preparation.body.isolationLeaseId,
        restoreScopes: ['session-local-retained-policy'],
      },
    },
  });
  assert.equal(cleanup.status, 200);
  assert.equal(rollbackAttempts, 0);
  assert.equal(mode, 'legacy');
});

test('MIG-BGSTAB-002 cleanup waits for a zero-view production rollback to converge before releasing the exact isolation lease', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  let recoveryReads = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const sessionId = 'session-debug-zero-view-cleanup';
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 100,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        throw new Error('cleanup must not restart the topology-owned zero-view rollback');
      },
      getAuthorityState: () => {
        if (mode === 'rolling-back') {
          recoveryReads += 1;
          if (recoveryReads >= 3) mode = 'legacy';
        }
        return { sessionId, mode, sessionStatus: 'idle' } as never;
      },
      getAuthorityController: () => ({} as never),
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: input => {
        cleanupCalls += 1;
        assert.equal(input.cleanupToken, 'cleanup-token');
        assert.equal(input.isolationLeaseId, 'isolation-lease');
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  mode = 'rolling-back';
  const cleanup = await service.testIsolation(sessionId, {
    desiredMode: 'legacy',
    transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
    testContract: {
      contractVersion: 1,
      cleanup: {
        action: 'restore-session-test-isolation-by-token-and-lease',
        cleanupToken: preparation.body.cleanupToken,
        isolationLeaseId: preparation.body.isolationLeaseId,
        restoreScopes: ['session-local-retained-policy'],
      },
    },
  });

  assert.equal(cleanup.status, 200);
  assert.equal(mode, 'legacy');
  assert.equal(rollbackAttempts, 0, 'cleanup must not restart the topology-owned rollback');
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(
    (cleanup.body.cleanup as { resourceInventory: unknown }).resourceInventory,
    TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY,
  );
});

test('MIG-BGSTAB-002 cleanup fails closed when zero-view rollback recovery never converges', async () => {
  let mode: 'legacy' | 'server' | 'rolling-back' = 'legacy';
  let rollbackAttempts = 0;
  let cleanupCalls = 0;
  const ids = ['cleanup-token', 'isolation-lease'];
  const sessionId = 'session-debug-zero-view-cleanup-timeout';
  const service = createTerminalAuthorityDebugService({
    createId: () => ids.shift() ?? 'unexpected-id',
    authoritySettleTimeoutMs: 2,
    authorityPollIntervalMs: 1,
    authority: {
      beginPromotion: () => {
        mode = 'server';
        return { ok: true };
      },
      beginRollback: () => {
        rollbackAttempts += 1;
        throw new Error('cleanup must not restart the topology-owned zero-view rollback');
      },
      getAuthorityState: () => ({ sessionId, mode, sessionStatus: 'idle' }) as never,
      getAuthorityController: () => ({} as never),
      getSessionSnapshot: () => ({ state: { sessionId, mode } }),
    },
    router: { getTerminalAuthorityResponderViews: () => [] },
    runtime: {
      openIsolation: input => ({
        accepted: true,
        cleanupToken: input.cleanupToken,
        isolationLeaseId: input.isolationLeaseId,
        allAffectedViewsDrained: true,
      }),
      applyIsolationContract: () => ({ accepted: true }),
      cleanupIsolation: () => {
        cleanupCalls += 1;
        return { accepted: true };
      },
      inspectResources: () => ({
        resourceInventory: { ...TERMINAL_AUTHORITY_DEBUG_ZERO_INVENTORY },
      }),
      prepareRollbackContract: () => ({ accepted: true }),
      triggerFault: () => ({ accepted: true }),
    },
  });

  const preparation = await service.testIsolation(sessionId, {
    desiredMode: 'server',
    transitionPolicy: 'capability-gated-limited-promotion-and-all-view-drain',
  });
  mode = 'rolling-back';

  await assert.rejects(
    service.testIsolation(sessionId, {
      desiredMode: 'legacy',
      transitionPolicy: 'fresh-compatibility-rollback-and-all-view-drain',
      testContract: {
        contractVersion: 1,
        cleanup: {
          action: 'restore-session-test-isolation-by-token-and-lease',
          cleanupToken: preparation.body.cleanupToken,
          isolationLeaseId: preparation.body.isolationLeaseId,
          restoreScopes: ['session-local-retained-policy'],
        },
      },
    }),
    (error: unknown) => (
      error instanceof TerminalAuthorityDebugError
      && error.status === 503
      && error.message === 'terminal-authority-debug-legacy-settle-timeout'
    ),
  );
  assert.equal(rollbackAttempts, 0);
  assert.equal(cleanupCalls, 0, 'a non-converged authority cannot release isolation resources');
});
