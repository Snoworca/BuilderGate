import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RETAINED_STATE_DIGEST_VERSION,
  createTerminalCheckpointDispatcherRegistry,
  createTerminalCheckpointRegistrationReleaseScheduler,
  createTerminalCheckpointRuntime,
  extractTerminalCheckpointFailureBoundary,
  isGlobalTerminalCheckpointControlFailure,
  isTerminalCheckpointMutationRejection,
  resolveTerminalCheckpointInputRoute,
  terminalCheckpointRetainedStateDigest,
} from '../../src/utils/terminalCheckpointRuntime.ts';
import * as terminalCheckpointRuntimeModule from '../../src/utils/terminalCheckpointRuntime.ts';
import {
  createTerminalRawMutationAdapter,
  digestTerminalBytes,
  encodeTerminalModeRehydrate,
} from '../../src/utils/terminalRawMutationAdapter.ts';
import {
  createTerminalWriteCoordinator,
  type TerminalWriteCoordinator,
} from '../../src/utils/terminalWriteCoordinator.ts';
import type {
  TerminalCheckpointCapabilityMessage,
  TerminalCheckpointServerMessage,
  TerminalCheckpointStartMessage,
  TerminalAuthorityRollbackStartMessage,
} from '../../src/types/ws-protocol.ts';
import * as wsProtocolModule from '../../src/types/ws-protocol.ts';
import { parseTerminalCheckpointClientMessage } from '../../../server/src/types/ws-protocol.ts';
import {
  buildTerminalAuthorityViewAttributeMessages,
  respondToTerminalAuthorityViewAttributeCapability,
  TERMINAL_AUTHORITY_VIEW_ATTRIBUTES,
} from '../../src/utils/terminalViewAttributes.ts';
import {
  CONFIGURED_AUTHORITY_DIAGNOSTIC_MAX_BYTES,
  formatConfiguredAuthorityFailureDiagnostic,
  hasCurrentMountOpenInputGate,
  runCleanupAttemptSequence,
  summarizeCurrentMountInputGate,
} from '../support/terminalAuthorityDiagnostics.ts';

const encoder = new TextEncoder();

interface TerminalCheckpointInputRouteContract {
  resolveTerminalCheckpointInputRoute(state: Readonly<{
    active: boolean;
    recoveryPending: boolean;
    legacyRecoveryPending: boolean;
  }>): 'direct' | 'checkpoint-runtime' | 'pending-input-queue';
}

test('MIG-BGSTAB-002 recovery-pending user input uses the bounded transport queue and releases once with current identity', () => {
  const signature = 'MIG-BGSTAB-002 AC-4 recovery input must survive checkpoint convergence';
  const resolveRoute = (
    terminalCheckpointRuntimeModule as unknown as Partial<TerminalCheckpointInputRouteContract>
  ).resolveTerminalCheckpointInputRoute;
  assert.equal(typeof resolveRoute, 'function', signature);
  if (!resolveRoute) return;

  for (const pendingState of [
    { recoveryPending: true, legacyRecoveryPending: false },
    { recoveryPending: false, legacyRecoveryPending: true },
  ]) {
    const route = resolveRoute({ active: true, ...pendingState });
    const pending: string[] = [];
    const sent: Array<{ data: string; identity: string }> = [];
    let runtimeSubmitCalls = 0;
    let currentIdentity = 'connection-old:view-7';

    const pendingMaxBytes = 32;
    if (route === 'pending-input-queue') {
      assert.ok(encoder.encode('echo-safe-input').byteLength <= pendingMaxBytes, signature);
      pending.push('echo-safe-input');
    } else if (route === 'checkpoint-runtime') {
      runtimeSubmitCalls += 1;
    }

    currentIdentity = 'connection-current:view-8';
    const flushAfterConvergence = (): void => {
      for (const data of pending.splice(0)) {
        sent.push({ data, identity: currentIdentity });
      }
    };
    flushAfterConvergence();
    flushAfterConvergence();

    assert.equal(route, 'pending-input-queue', signature);
    assert.equal(runtimeSubmitCalls, 0, signature);
    assert.deepEqual(sent, [{
      data: 'echo-safe-input',
      identity: 'connection-current:view-8',
    }], signature);
  }

  assert.equal(resolveRoute({
    active: true,
    recoveryPending: false,
    legacyRecoveryPending: false,
  }), 'checkpoint-runtime', signature);
  assert.equal(resolveRoute({
    active: false,
    recoveryPending: false,
    legacyRecoveryPending: false,
  }), 'direct', signature);

  const view = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const submitStart = view.indexOf('const submitCapturedInput = useCallback');
  const submitEnd = view.indexOf('const syncInputReadiness = useCallback', submitStart);
  const submitChunk = view.slice(submitStart, submitEnd);
  const routeIndex = submitChunk.indexOf('resolveTerminalCheckpointInputRoute(runtimeState)');
  const queueIndex = submitChunk.indexOf('enqueuePendingInput(data, debugInput, source)', routeIndex);
  const runtimeIndex = submitChunk.indexOf('runtime.submitInput(data)', routeIndex);
  assert.ok(routeIndex >= 0 && queueIndex > routeIndex && runtimeIndex > queueIndex, signature);

  const flushStart = view.indexOf('const flushPendingInputQueue = useCallback');
  const flushEnd = view.indexOf('const enqueuePendingInput = useCallback', flushStart);
  const flushChunk = view.slice(flushStart, flushEnd);
  assert.match(flushChunk, /pendingInputQueueRef\.current = \[\][\s\S]*onInput\(entry\.data, entry\.metadata\)/u, signature);
  assert.match(flushChunk, /entry\.sessionGeneration !== sessionGenerationRef\.current/u, signature);

  const enqueueStart = view.indexOf('const enqueuePendingInput = useCallback');
  const enqueueEnd = view.indexOf('const submitCapturedInputDirect = useCallback', enqueueStart);
  const enqueueChunk = view.slice(enqueueStart, enqueueEnd);
  assert.match(enqueueChunk, /inputQueueMaxBytes/u, signature);
  assert.match(enqueueChunk, /pendingInputQueueBytesRef\.current > inputQueueMaxBytes/u, signature);
});

test('MIG-BGSTAB-002 capability view attributes are generated by the control plane without a mounted renderer', () => {
  const capability = {
    type: 'terminal-checkpoint:capability' as const,
    protocolVersion: 1 as const,
    accepted: true as const,
    authorityMode: 'legacy' as const,
    checkpointDeliveryActive: false,
    ordinalEncoding: 'canonical-uint64-decimal' as const,
    digestAlgorithms: ['sha256'] as const,
    registeredViews: [
      {
        sessionId: 'session-ready',
        viewGeneration: 7,
        driverLeaseGeneration: '11',
        acceptedViewAttributesGeneration: '13',
        viewAttributesChallengeId: 'challenge-current',
      },
      {
        sessionId: 'session-missing-identity',
        viewGeneration: 8,
      },
    ],
  };

  assert.deepEqual(buildTerminalAuthorityViewAttributeMessages(capability), [{
    type: 'terminal-authority:view-attributes',
    sessionId: 'session-ready',
    viewGeneration: 7,
    driverLeaseGeneration: '11',
    viewAttributesGeneration: '13',
    viewAttributesChallengeId: 'challenge-current',
    attributes: TERMINAL_AUTHORITY_VIEW_ATTRIBUTES,
  }]);
  assert.deepEqual(
    buildTerminalAuthorityViewAttributeMessages(capability),
    buildTerminalAuthorityViewAttributeMessages(capability),
    'same-generation capability refresh must produce the same idempotent control response',
  );
  const sent: unknown[] = [];
  const first = respondToTerminalAuthorityViewAttributeCapability(capability, message => {
    sent.push(message);
    return { ok: true as const };
  });
  const repeated = respondToTerminalAuthorityViewAttributeCapability(capability, message => {
    sent.push(message);
    return { ok: true as const };
  });
  assert.deepEqual(first, { attempted: 1, accepted: 1, failures: [] });
  assert.deepEqual(repeated, first);
  assert.equal(sent.length, 2, 'same-generation refresh must resend from the control plane');
  assert.deepEqual(
    respondToTerminalAuthorityViewAttributeCapability({
      ...capability,
      registeredViews: [capability.registeredViews[1]],
    }, () => {
      throw new Error('missing identity must not attempt a control send');
    }),
    { attempted: 0, accepted: 0, failures: [] },
  );
  assert.equal(
    TERMINAL_AUTHORITY_VIEW_ATTRIBUTES.ansi.length,
    256,
    'MIG-BGSTAB-002 AC-3 negotiates the complete xterm palette owned by the renderer appearance SSOT',
  );
  assert.deepEqual(
    [0, 15, 16, 17, 196, 232, 255].map(index => (
      TERMINAL_AUTHORITY_VIEW_ATTRIBUTES.ansi[index]
    )),
    [
      [0, 0, 0],
      [255, 255, 255],
      [0, 0, 0],
      [0, 0, 95],
      [255, 0, 0],
      [8, 8, 8],
      [238, 238, 238],
    ],
  );
  assert.deepEqual(
    respondToTerminalAuthorityViewAttributeCapability(capability, () => ({
      ok: false,
      reason: 'control-socket-not-open',
    })),
    {
      attempted: 1,
      accepted: 0,
      failures: [{
        sessionId: 'session-ready',
        viewGeneration: 7,
        reason: 'control-socket-not-open',
      }],
    },
  );
});

test('MIG-BGSTAB-002 capability view-attributes response is owned by WebSocketContext rather than TerminalView', () => {
  const contextSource = readFileSync(
    new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
    'utf8',
  );
  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    contextSource,
    /respondToTerminalAuthorityViewAttributeCapability\(\s*appliedCheckpoint,/u,
  );
  const capabilityBranchStart = contextSource.indexOf(
    "if (checkpoint.type === 'terminal-checkpoint:capability')",
  );
  const capabilityBranchEnd = contextSource.indexOf(
    "if (checkpoint.type === 'terminal-checkpoint:rejected')",
    capabilityBranchStart,
  );
  const capabilityBranch = contextSource.slice(capabilityBranchStart, capabilityBranchEnd);
  const freshnessIndex = capabilityBranch.indexOf(
    '.selectFreshCapability(checkpoint)',
  );
  const responseIndex = capabilityBranch.indexOf(
    'respondToTerminalAuthorityViewAttributeCapability(',
  );
  const leaseMergeIndex = capabilityBranch.indexOf(
    'reconcileTerminalCheckpointMutationLeases(',
  );
  const capabilityApplyIndex = capabilityBranch.indexOf(
    '.setCapability(freshCheckpoint)',
  );
  assert.ok(
    freshnessIndex >= 0
      && freshnessIndex < leaseMergeIndex
      && leaseMergeIndex < capabilityApplyIndex
      && leaseMergeIndex < responseIndex,
    'mutation leases must be installed before capability publication can flush queued input',
  );
  assert.match(
    capabilityBranch,
    /const appliedCheckpoint = terminalCheckpointDispatchersRef\.current\s*\.setCapability\(freshCheckpoint\)/u,
    'attributes and leases must use the registry capability-application result',
  );
  assert.match(
    capabilityBranch,
    /checkpointDeliveryPreparation[\s\S]*?terminal_checkpoint_preparation_not_selected/u,
    'a prepared delivery capability dropped before runtime admission must remain observable',
  );
  assert.doesNotMatch(
    terminalViewSource,
    /type:\s*['"]terminal-authority:view-attributes['"]/u,
    'renderer lifetime must not own query-responder capability admission',
  );
  assert.match(
    terminalViewSource,
    /theme:\s*TERMINAL_XTERM_THEME/u,
    'TerminalView and the control-plane composer must share one immutable appearance source',
  );
  assert.match(
    contextSource,
    /terminalCheckpointRegistrationReleaseScheduler\.schedule\(sessionId,[\s\S]*?releaseCapability\(sessionId\)[\s\S]*?requestTerminalCheckpointCapability/u,
    'only the confirmed final release may clear the per-session capability cache',
  );
});

test('MIG-BGSTAB-002 deferred future capability publishes attributes when dispatcher registration catches up', () => {
  const contextSource = readFileSync(
    new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
    'utf8',
  );
  const registerStart = contextSource.indexOf('const registerTerminalCheckpointDispatcher = useCallback(');
  const registerEnd = contextSource.indexOf('\n  const requestReconnect', registerStart);
  const registerBranch = contextSource.slice(registerStart, registerEnd);

  assert.match(registerBranch, /takeAppliedRegistrationCapability\(sessionId\)/u);
  assert.match(registerBranch, /publishAppliedTerminalCheckpointCapability\(/u);
});

test('MIG-BGSTAB-002 poisoned reload E2E cannot synthesize its capability response', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2eSource.indexOf('async function waitForAcceptedViewAttributes(');
  const helperEnd = e2eSource.indexOf('\nasync function settleLiveTerminal(', helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = e2eSource.slice(helperStart, helperEnd);
  assert.match(helper, /frame\.origin === ['"]routed-page['"]/u);
  assert.doesNotMatch(
    helper,
    /harness\.sendToServer/u,
    'the E2E must observe an actual WebSocketContext response instead of injecting one',
  );
});

test('MIG-BGSTAB-002 zero-attached producer waits for an open focused input gate', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const producerStart = e2eSource.indexOf('const zeroAttachedProducer =');
  const detachStart = e2eSource.indexOf("await page.goto('about:blank')", producerStart);
  const producerBoundary = e2eSource.slice(producerStart, detachStart);
  const readyIndex = producerBoundary.indexOf(
    'await waitForVisibleTerminalInputReady(page, sessionId)',
  );
  const sendIndex = producerBoundary.indexOf('await sendVisibleTerminalCommand(');

  assert.ok(readyIndex >= 0 && readyIndex < sendIndex,
    'the PTY producer must not type while checkpoint recovery still owns the input barrier');
  assert.match(
    e2eSource,
    /async function waitForVisibleTerminalInputReady\([\s\S]*?readInputGateSnapshot\(targetSessionId\)[\s\S]*?textarea === document\.activeElement[\s\S]*?snapshot\.gate\?\.inputReady === true/u,
    'input readiness must include the authority gate and the actual helper focus owner',
  );
});

test('MIG-BGSTAB-002 reload-safe input readiness reads the current gate without mutating transport overrides', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2eSource.indexOf('async function waitForVisibleTerminalInputReady(');
  const helperEnd = e2eSource.indexOf('\nasync function sendVisibleTerminalCommand(', helperStart);
  const helper = e2eSource.slice(helperStart, helperEnd);
  const enableIndex = helper.indexOf('.enable(targetSessionId)');
  const readGateIndex = helper.indexOf('const readGate = () =>');
  const snapshotIndex = helper.indexOf('.readInputGateSnapshot(targetSessionId)');
  const pollIndex = helper.indexOf('await expect.poll(');
  const pollReadIndex = helper.indexOf('const snapshot = await readGate();', pollIndex);

  assert.ok(
    enableIndex >= 0
      && enableIndex < pollIndex
      && readGateIndex >= 0
      && readGateIndex < pollIndex
      && snapshotIndex > readGateIndex
      && pollReadIndex > pollIndex,
    'reload must re-arm client capture and poll the current mount snapshot reader');
  assert.doesNotMatch(helper, /setInputTransportOverride/u,
    'readiness observation must not clear or otherwise mutate a transport override');
});

test('MIG-BGSTAB-002 stale ready gate cannot authorize a replacement terminal runtime', () => {
  const oldReady = {
    eventId: 1,
    kind: 'input_gate_synced',
    details: { inputReady: true, captureState: 'open', barrierReason: 'none' },
  };
  const replacementMount = { eventId: 2, kind: 'terminal_mounted', details: {} };
  assert.equal(
    hasCurrentMountOpenInputGate([oldReady]),
    true,
    'a bounded debug ring may evict the mount before its later current-runtime ready gate',
  );
  assert.equal(hasCurrentMountOpenInputGate([oldReady, replacementMount]), false);
  assert.equal(hasCurrentMountOpenInputGate([
    oldReady,
    replacementMount,
    {
      eventId: 3,
      kind: 'input_gate_synced',
      details: { inputReady: false, captureState: 'transient-blocked', barrierReason: 'restore-pending' },
    },
  ]), false);
  assert.equal(hasCurrentMountOpenInputGate([
    oldReady,
    replacementMount,
    {
      eventId: 4,
      kind: 'input_gate_synced',
      details: { inputReady: true, captureState: 'open', barrierReason: 'none' },
    },
  ]), true);
});

test('MIG-BGSTAB-002 blocked current mount reports the latest gate reason without retaining the event tape', () => {
  const events = [
    { eventId: 41, kind: 'terminal_mounted', details: {} },
    {
      eventId: 42,
      kind: 'input_gate_synced',
      details: {
        inputReady: false,
        captureState: 'transient-blocked',
        barrierReason: 'checkpoint-pending',
        restorePending: false,
        geometryReady: true,
        serverReady: true,
      },
    },
  ];

  assert.deepEqual(summarizeCurrentMountInputGate(events), {
    currentMountOpen: false,
    latestMountEventId: 41,
    latestGateEventId: 42,
    inputReady: false,
    captureState: 'transient-blocked',
    barrierReason: 'checkpoint-pending',
    restorePending: false,
    geometryReady: true,
    serverReady: true,
  });
});

test('MIG-BGSTAB-002 poisoned configured failure emits bounded redacted authority diagnostics', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const diagnosticSource = readFileSync(
    new URL('../support/terminalAuthorityDiagnostics.ts', import.meta.url),
    'utf8',
  );
  const framesStart = diagnosticSource.indexOf('function summarizeFrames(');
  const framesEnd = diagnosticSource.indexOf(
    '\nfunction summarizeResourceInventory(',
    framesStart,
  );
  assert.notEqual(framesStart, -1);
  assert.notEqual(framesEnd, -1);
  const framesHelper = diagnosticSource.slice(framesStart, framesEnd);
  assert.match(framesHelper, /\.slice\(-64\)/u);
  assert.match(framesHelper, /connectionGeneration:\s*boundedInteger\(frame\.generation\)/u);
  assert.match(framesHelper, /challengeFingerprint:\s*fingerprint/u);
  assert.match(framesHelper, /reasonFingerprint:\s*fingerprint/u);
  assert.doesNotMatch(
    framesHelper,
    /attributes\s*:/u,
    'diagnostics must not serialize terminal palette or full view attributes',
  );

  const inventoryStart = diagnosticSource.indexOf('function summarizeInventory(', framesEnd);
  const inventoryEnd = diagnosticSource.indexOf(
    '\nexport function formatConfiguredAuthorityFailureDiagnostic(',
    inventoryStart,
  );
  assert.notEqual(inventoryEnd, -1);
  const inventoryHelper = diagnosticSource.slice(inventoryStart, inventoryEnd);
  assert.match(inventoryHelper, /audit\.slice\(-32\)/u);
  assert.match(inventoryHelper, /authoritativeModelFingerprint:\s*fingerprint/u);

  const failureStart = e2eSource.indexOf(
    'if (configuredPreparation.httpStatus !== 200)',
  );
  const failureEnd = e2eSource.indexOf(
    '\n      const configuredModelInstanceAfter',
    failureStart,
  );
  assert.notEqual(failureStart, -1);
  assert.notEqual(failureEnd, -1);
  const failureBranch = e2eSource.slice(failureStart, failureEnd);
  assert.match(failureBranch, /inspectServerAuthorityTestResources\(page,\s*sessionId\)/u);
  assert.match(failureBranch, /configuredAuthorityDiagnostics=/u);
  assert.match(failureBranch, /formatConfiguredAuthorityFailureDiagnostic/u);
  assert.doesNotMatch(
    failureBranch,
    /JSON\.stringify\(configuredPreparation\)/u,
    'raw preparation bodies may contain session IDs, leases, output, or response details',
  );
});

test('MIG-BGSTAB-002 configured failure diagnostic excludes runtime secrets and has a byte ceiling', () => {
  const sessionId = 'SESSION-MARKER-PRIVATE';
  const challengeId = 'CHALLENGE-MARKER-PRIVATE';
  const connectionId = 'CONNECTION-MARKER-PRIVATE';
  const cleanupToken = 'CLEANUP-TOKEN-MARKER-PRIVATE';
  const payload = 'OUTPUT-PAYLOAD-MARKER-PRIVATE';
  const palette = 'PALETTE-MARKER-PRIVATE';
  const diagnostic = formatConfiguredAuthorityFailureDiagnostic({
    sessionId,
    preparation: {
      httpStatus: 409,
      error: {
        code: `ERROR-CODE-${sessionId}`,
        message: `ERROR-MESSAGE-${challengeId}`,
        details: {
          cleanupToken,
          isolationLeaseId: 'LEASE-MARKER-PRIVATE',
          responseText: payload.repeat(8_192),
        },
      },
      testContract: { outputData: payload, palette },
    },
    frames: Array.from({ length: 512 }, (_, index) => ({
      direction: index % 2 === 0 ? 'page-to-server' : 'server-to-page',
      generation: index,
      origin: index % 2 === 0 ? 'routed-page' : 'routed-server',
      message: {
        type: index % 2 === 0
          ? 'terminal-authority:view-attributes'
          : 'terminal-authority:view-attributes-accepted',
        sessionId,
        connectionId,
        viewGeneration: index,
        viewAttributesChallengeId: challengeId,
        accepted: index % 2 !== 0,
        reason: `REASON-${sessionId}-${challengeId}`,
        attributes: { palette, outputData: payload },
      },
    })),
    clientEvents: Array.from({ length: 128 }, (_, index) => ({
      eventId: index + 1,
      kind: index % 5 === 0
        ? 'terminal_runtime_recreation_required'
        : index % 5 === 1
          ? 'terminal_checkpoint_inactive_frame_rejected'
          : index % 5 === 2
            ? 'screen_repair_reconnect_required'
            : index % 5 === 3
              ? 'visible_output_resync_retry_attempted'
              : 'unrelated-sensitive-event',
      details: {
        reason: `RECREATE-${challengeId}-${index}`,
        ...(index % 5 === 1 ? { viewGeneration: index } : {}),
        ...(index % 5 === 2 ? { outcome: 'reconnect-required' } : {}),
        ...(index % 5 === 3 ? { attempt: index } : {}),
        outputData: payload,
      },
    })),
    inventory: {
      httpStatus: 200,
      inspectedSessionId: sessionId,
      authoritativeModelInstanceId: `MODEL-${sessionId}`,
      authorityState: {
        mode: 'promoting',
        heldPostBoundaryCount: 3,
        outputData: payload,
      },
      queryResponderCapabilityState: {
        promotionEligible: false,
        blocker: `BLOCKER-${challengeId}`,
        hasAcceptedViewAttributes: false,
        palette,
      },
      attachedResponderViewCount: 1,
      resourceInventory: {
        cleanupTokens: 1,
        isolationLeases: 1,
        payload,
      },
      authorityAuditTrail: Array.from({ length: 256 }, (_, index) => ({
        type: `AUDIT-${sessionId}`,
        kind: `KIND-${challengeId}`,
        connectionId,
        viewGeneration: index,
        streamEpoch: `STREAM-${cleanupToken}`,
        outputData: payload,
      })),
      diagnosticReadError: `READ-${sessionId}-${payload}`,
    },
  });

  for (const secret of [
    sessionId,
    challengeId,
    connectionId,
    cleanupToken,
    payload,
    palette,
    'LEASE-MARKER-PRIVATE',
  ]) {
    assert.doesNotMatch(diagnostic, new RegExp(secret, 'u'));
  }
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= CONFIGURED_AUTHORITY_DIAGNOSTIC_MAX_BYTES);
  const parsed = JSON.parse(diagnostic) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 'ph005-configured-authority-diagnostic/v1');
  assert.equal((parsed.frames as unknown[]).length, 64);
  assert.equal((parsed.clientEvents as unknown[]).length, 64);
  assert.deepEqual(
    new Set((parsed.clientEvents as Array<Record<string, unknown>>).map(event => event.kind)),
    new Set([
      'terminal_runtime_recreation_required',
      'terminal_checkpoint_inactive_frame_rejected',
      'screen_repair_reconnect_required',
      'visible_output_resync_retry_attempted',
    ]),
  );
  assert.equal(
    (parsed.clientEvents as Array<Record<string, unknown>>).some(event => (
      event.kind === 'visible_output_resync_retry_attempted'
      && Number.isSafeInteger(event.attempt)
    )),
    true,
  );
  assert.equal(
    (parsed.clientEvents as Array<Record<string, unknown>>).some(event => (
      event.kind === 'terminal_checkpoint_inactive_frame_rejected'
      && Number.isSafeInteger(event.viewGeneration)
    )),
    true,
  );
  assert.equal(((parsed.inventory as Record<string, unknown>).authorityAuditTrail as unknown[]).length, 32);
});

test('MIG-BGSTAB-002 oversized configured diagnostics preserve bounded client churn evidence', () => {
  const sessionId = 'diagnostic-session';
  const diagnostic = formatConfiguredAuthorityFailureDiagnostic({
    sessionId,
    preparation: { httpStatus: 409, error: { message: 'gate-failed' } },
    frames: Array.from({ length: 256 }, (_, frameIndex) => ({
      direction: 'server-to-page',
      generation: frameIndex,
      origin: 'routed-server',
      message: {
        type: 'terminal-checkpoint:capability',
        registeredViews: Array.from({ length: 8 }, (_, viewIndex) => ({
          sessionId,
          viewGeneration: frameIndex * 8 + viewIndex,
          viewAttributesChallengeId: `challenge-${frameIndex}-${viewIndex}`,
          driverLeaseGeneration: `driver-${frameIndex}-${viewIndex}`,
          acceptedViewAttributesGeneration: `attributes-${frameIndex}-${viewIndex}`,
        })),
      },
    })),
    clientEvents: Array.from({ length: 80 }, (_, index) => ({
      eventId: index,
      kind: 'terminal_checkpoint_inactive_frame_rejected',
      details: { reason: 'inactive-generation', viewGeneration: index },
    })),
    inventory: { authorityAuditTrail: [] },
  });

  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= CONFIGURED_AUTHORITY_DIAGNOSTIC_MAX_BYTES);
  const parsed = JSON.parse(diagnostic) as Record<string, unknown>;
  assert.equal(parsed.truncated, true);
  assert.equal((parsed.clientEvents as unknown[]).length, 64);
});

test('MIG-BGSTAB-002 cleanup attempt sequence never retries a timed-out or rejected first cleanup', async () => {
  let timedOutRetryCalls = 0;
  const timedOut = await runCleanupAttemptSequence(async () => {
    timedOutRetryCalls += 1;
    throw new Error('request-timeout');
  });
  assert.equal(timedOutRetryCalls, 1);
  assert.equal(timedOut.cleanup, null);
  assert.equal(timedOut.idempotentCleanup, null);
  assert.equal(timedOut.firstError instanceof Error, true);

  let rejectedCalls = 0;
  const rejected = await runCleanupAttemptSequence(async () => {
    rejectedCalls += 1;
    return { httpStatus: 503 };
  });
  assert.equal(rejectedCalls, 1);
  assert.deepEqual(rejected.cleanup, { httpStatus: 503 });
  assert.equal(rejected.idempotentCleanup, null);

  const transientResponses = [{ httpStatus: 409 }, { httpStatus: 200 }];
  let transientCalls = 0;
  const transient = await runCleanupAttemptSequence(async () => {
    const response = transientResponses[transientCalls];
    transientCalls += 1;
    return response ?? { httpStatus: 200 };
  });
  assert.equal(transientCalls, 1);
  assert.deepEqual(transient.cleanup, { httpStatus: 409 });
  assert.equal(transient.idempotentCleanup, null);
});

test('MIG-BGSTAB-002 cleanup retries only the exact legacy-settle sentinel before idempotency proof', async () => {
  const responses = [
    {
      httpStatus: 503,
      error: {
        code: 'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE',
        message: 'terminal-authority-debug-legacy-settle-timeout',
      },
    },
    { httpStatus: 200 },
    { httpStatus: 200 },
  ];
  let calls = 0;
  const result = await runCleanupAttemptSequence(() => Promise.resolve(
    responses[calls++] ?? { httpStatus: 200 },
  ), {
    retryFirstResponse: response => (
      response.httpStatus === 503
        && response.error?.code === 'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE'
        && response.error?.message === 'terminal-authority-debug-legacy-settle-timeout'
    ),
    maxAttempts: 2,
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.cleanup, { httpStatus: 200 });
  assert.deepEqual(result.idempotentCleanup, { httpStatus: 200 });
});

test('MIG-BGSTAB-002 cleanup E2E disables the request helper internal transient retry', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const cleanupStart = e2eSource.indexOf('async function cleanupServerAuthorityTestState(');
  const cleanupEnd = e2eSource.indexOf('\nfunction expectedZeroIsolationResourceInventory()', cleanupStart);
  assert.notEqual(cleanupStart, -1);
  assert.notEqual(cleanupEnd, -1);
  const cleanupHelper = e2eSource.slice(cleanupStart, cleanupEnd);
  assert.match(
    cleanupHelper,
    /prepareServerAuthorityTestState\([\s\S]*?cleanupContract,\s*\{\s*retryTransient:\s*false\s*\}/u,
  );
});

test('MIG-BGSTAB-002 registration stabilization preserves the last capability rejection evidence', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2eSource.indexOf('async function stabilizeLiveTerminalRegistration(');
  const helperEnd = e2eSource.indexOf('\nasync function bootLiveTerminal(', helperStart);
  const helper = e2eSource.slice(helperStart, helperEnd);
  assert.match(helper, /let lastError: unknown = null/u);
  assert.match(helper, /catch \(error\) \{\s*lastError = error;/u);
  assert.match(helper, /lastError=\$\{formatErrorForDiagnostic\(lastError\)\}/u);
});

test('MIG-BGSTAB-002 registration stabilization reuses an accepted idempotent view-attributes challenge', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2eSource.indexOf('async function stabilizeLiveTerminalRegistration(');
  const helperEnd = e2eSource.indexOf('\nasync function bootLiveTerminal(', helperStart);
  const helper = e2eSource.slice(helperStart, helperEnd);
  assert.match(
    helper,
    /waitForAcceptedViewAttributes\([\s\S]*?requireDriverAcceptance,\s*5_000,\s*-1,\s*\)/u,
    'an unchanged server challenge must reuse its already accepted palette attestation',
  );
});

test('MIG-BGSTAB-002 poisoned reload failure preserves replay transaction evidence', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const failureStart = e2eSource.indexOf('if (scenarioPreparation.httpStatus !== 200)');
  const failureEnd = e2eSource.indexOf('\n        const before = scenarioIndex === 0', failureStart);
  const failureBlock = e2eSource.slice(failureStart, failureEnd);
  assert.match(failureBlock, /const replayFrames = harness\.frames\.filter/u);
  assert.match(failureBlock, /screen-snapshot:ready/u);
  assert.match(failureBlock, /const clientRecoveryEvents = await page\.evaluate/u);
  assert.match(failureBlock, /snapshot_replacement/u);
  assert.match(failureBlock, /clientRecoveryEvents=\$\{JSON\.stringify\(clientRecoveryEvents\)\}/u);
  assert.match(failureBlock, /replayFrames=\$\{JSON\.stringify\(replayFrames\)\}/u);
});

test('MIG-BGSTAB-002 poisoned reload re-enables client recovery diagnostics after navigation', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2eSource.indexOf('async function waitForServerAuthorityReplacementLiveTerminal(');
  const helperEnd = e2eSource.indexOf('\nfunction outputSequence(', helperStart);
  const helper = e2eSource.slice(helperStart, helperEnd);
  assert.match(
    helper,
    /__buildergateTerminalDebug\?\.enable\(requestedSessionId\)[\s\S]*previous\.sessionId/u,
  );
});

test('MIG-BGSTAB-002 post-snapshot test dispatch preserves the server checkpoint decision', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2eSource.indexOf('async function sendPostSnapshotTailAndWait(');
  const helperEnd = e2eSource.indexOf('\nfunction buildAlternateActiveFixtureContract(', helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = e2eSource.slice(helperStart, helperEnd);
  assert.match(
    helper,
    /if \(options\.dispatch\) \{\s*dispatchEvidence = await options\.dispatch\(\);\s*\} else if \(checkpoint\.validation\.settled\) \{/u,
    'the guarded server endpoint must return the actual 202/409 decision even when local evidence is unsettled',
  );
});

test('MIG-BGSTAB-002 configured checkpoint failure preserves generation lineage', () => {
  const e2eSource = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  assert.match(e2eSource, /configured checkpoint settlement failed/u);
  assert.match(e2eSource, /configuredCheckpoint\.validation/u);
  assert.match(e2eSource, /configuredCheckpointFrames/u);
  assert.match(e2eSource, /configuredNegotiationFrames/u);
  assert.match(e2eSource, /configuredCapabilityFrames/u);
  assert.match(e2eSource, /'terminal-checkpoint:rejected'/u);
  assert.match(e2eSource, /registeredViews\.some/u);
});

test('MIG-BGSTAB-002 cleanup attempt sequence probes idempotency only after first cleanup succeeds', async () => {
  let calls = 0;
  const result = await runCleanupAttemptSequence(async () => {
    calls += 1;
    return { httpStatus: 200, attempt: calls };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.cleanup, { httpStatus: 200, attempt: 1 });
  assert.deepEqual(result.idempotentCleanup, { httpStatus: 200, attempt: 2 });
  assert.equal(result.firstError, null);
  assert.equal(result.idempotentError, null);
});

const ACTIVE_CAPABILITY: TerminalCheckpointCapabilityMessage = {
  type: 'terminal-checkpoint:capability',
  protocolVersion: 1,
  accepted: true,
  authorityMode: 'checkpoint',
  checkpointDeliveryActive: true,
  ordinalEncoding: 'canonical-uint64-decimal',
  digestAlgorithms: ['sha256'],
  registeredViews: [{ sessionId: 'session-1', viewGeneration: 7 }],
};

const PASSIVE_CAPABILITY: TerminalCheckpointCapabilityMessage = {
  ...ACTIVE_CAPABILITY,
  authorityMode: 'legacy',
  checkpointDeliveryActive: false,
};

function identity(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    protocolVersion: 1 as const,
    sessionId: 'session-1',
    connectionId: 'connection-1',
    viewGeneration: 7,
    streamEpoch: '3',
    checkpointEpoch: '4',
    sourceSeq: '12',
    snapshotSeq: '10',
    oldestRetainedSeq: '1',
    retentionPolicyId: 'retained-10000-v1',
    ...overrides,
  };
}

function startMessage(overrides: Readonly<Record<string, unknown>> = {}): TerminalCheckpointServerMessage {
  return {
    type: 'terminal-checkpoint:start',
    ...identity(),
    sourceGeometry: { cols: 120, rows: 40 },
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: {
      algorithm: 'sha256',
      hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
    modes: { bracketedPasteMode: true, wraparoundMode: false },
    parserTail: { encoding: 'base64', data: '', encodedBytes: 0 },
    ...overrides,
  } as TerminalCheckpointServerMessage;
}

function chunkMessage(overrides: Readonly<Record<string, unknown>> = {}): TerminalCheckpointServerMessage {
  return {
    type: 'terminal-checkpoint:chunk',
    ...identity(),
    chunkIndex: 0,
    chunkCount: 1,
    encoding: 'base64',
    data: 'YWJj',
    encodedBytes: 3,
    ...overrides,
  } as TerminalCheckpointServerMessage;
}

function commitMessage(overrides: Readonly<Record<string, unknown>> = {}): TerminalCheckpointServerMessage {
  return {
    type: 'terminal-checkpoint:commit',
    ...identity(),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: {
      algorithm: 'sha256',
      hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
    ...overrides,
  } as TerminalCheckpointServerMessage;
}

function createHarness(
  sendOk = true,
  dispatchResult?: (command: Readonly<Record<string, unknown>>) => Readonly<{ accepted: boolean; reason?: string }>,
  sessionId = 'session-1',
) {
  const commands: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const recovery: string[] = [];
  const generations: number[] = [];
  const preparedReadyFailures: Array<Record<string, unknown>> = [];
  const preparedReadyDeferrals: Array<Record<string, unknown>> = [];
  let preparedReadyControlSocketId = 'control-1';
  let preparedReadyEnqueueOrdinal = 0;
  let preparedReadyReceiptAvailable = true;
  const coordinator = {
    dispatch(command: Record<string, unknown>) {
      commands.push(command);
      return dispatchResult?.(command) ?? { accepted: true };
    },
    submitCompatibility(command: Record<string, unknown>) {
      commands.push(command);
      return dispatchResult?.(command) ?? { accepted: true };
    },
    getState() {
      return {
        viewGeneration: generations.at(-1) ?? 7,
        ready: false,
        disposed: false,
        writeInFlight: false,
        pendingCommands: 0,
        pendingInputs: 0,
        pendingInputBytes: 0,
        settlementLedgerEntries: 0,
        inputSettlementLedgerEntries: 0,
        recoveryRequired: false,
        compatibilityRecoveryPending: false,
        runtimeRecreationRequired: false,
      };
    },
  };
  const runtime = createTerminalCheckpointRuntime({
    sessionId,
    initialViewGeneration: 7,
    getCoordinator: () => coordinator,
    send: (message) => {
      sent.push(message as unknown as Record<string, unknown>);
      return sendOk ? { ok: true } : { ok: false, reason: 'not-open' };
    },
    getPreparedCheckpointReadyReceipt: () => (
      preparedReadyReceiptAvailable
        ? {
            ok: true as const,
            controlSocketId: preparedReadyControlSocketId,
            enqueueOrdinal: preparedReadyEnqueueOrdinal,
          }
        : {
            ok: false as const,
            reason: 'control-socket-not-open',
            controlSocketId: preparedReadyControlSocketId,
          }
    ),
    sendPreparedCheckpointReady: ({ message, expectedControlSocketId, afterEnqueueOrdinal }) => {
      if (expectedControlSocketId !== preparedReadyControlSocketId) {
        return {
          ok: false as const,
          reason: 'control-socket-mismatch',
          controlSocketId: preparedReadyControlSocketId,
        };
      }
      if (afterEnqueueOrdinal > preparedReadyEnqueueOrdinal) {
        return {
          ok: false as const,
          reason: 'control-socket-enqueue-order-regression',
          controlSocketId: preparedReadyControlSocketId,
        };
      }
      sent.push(message as unknown as Record<string, unknown>);
      preparedReadyEnqueueOrdinal += 1;
      return {
        ok: true as const,
        controlSocketId: preparedReadyControlSocketId,
        enqueueOrdinal: preparedReadyEnqueueOrdinal,
      };
    },
    onPreparedCheckpointReadySendBlocked: failure => {
      preparedReadyFailures.push(failure);
    },
    onPreparedCheckpointReadyDeferred: deferral => {
      preparedReadyDeferrals.push(deferral);
    },
    requestFreshRecovery: reason => recovery.push(reason),
    advanceViewGeneration: generation => generations.push(generation),
  });
  return {
    commands,
    coordinator,
    generations,
    recovery,
    runtime,
    sent,
    preparedReadyFailures,
    preparedReadyDeferrals,
    replacePreparedReadyControlSocket: (controlSocketId: string) => {
      preparedReadyControlSocketId = controlSocketId;
      preparedReadyEnqueueOrdinal = 0;
    },
    advancePreparedReadyEnqueueOrdinal: () => {
      preparedReadyEnqueueOrdinal += 1;
    },
    setPreparedReadyReceiptAvailable: (available: boolean) => {
      preparedReadyReceiptAvailable = available;
    },
  };
}

test('production terminal digest is real SHA-256, not the characterization FNV digest', () => {
  assert.equal(
    digestTerminalBytes(encoder.encode('abc')),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    digestTerminalBytes(new Uint8Array()),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  const mixed = encoder.encode('ASCII / 한글 / 😀 / \u001b[31mred\u001b[0m'.repeat(37));
  assert.equal(
    digestTerminalBytes(mixed),
    `sha256:${createHash('sha256').update(mixed).digest('hex')}`,
  );
});

test('server validates negotiated view registrations and explicit recovery requests', () => {
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: 1,
    views: [{ sessionId: 'session-1', viewGeneration: 7 }],
  }).ok, true);
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: 1,
    views: [
      { sessionId: 'session-1', viewGeneration: 7 },
      { sessionId: 'session-1', viewGeneration: 8 },
    ],
  }).ok, false);
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:recovery-request',
    protocolVersion: 1,
    sessionId: 'session-1',
    failedViewGeneration: 7,
    requestedViewGeneration: 8,
    reason: 'apply-failed',
    failedStreamEpoch: '3',
    failedCheckpointEpoch: '4',
  }).ok, true);
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:recovery-request',
    protocolVersion: 1,
    sessionId: 'session-1',
    failedViewGeneration: 7,
    requestedViewGeneration: 7,
    reason: 'apply-failed',
  }).ok, false);
});

test('mode rehydrate uses a deterministic supported escape prefix in the checkpoint physical write', () => {
  const prefix = encodeTerminalModeRehydrate({
    applicationCursorKeysMode: true,
    bracketedPasteMode: true,
    insertMode: false,
    originMode: true,
    reverseWraparoundMode: false,
    sendFocusMode: true,
    wraparoundMode: false,
  });
  assert.equal(
    new TextDecoder().decode(prefix),
    '\u001b[?1h\u001b[?2004h\u001b[4l\u001b[?6h\u001b[?45l\u001b[?1004h\u001b[?7l',
  );

  const writes: Uint8Array[] = [];
  const terminal = {
    cols: 80,
    rows: 24,
    options: { windowsPty: undefined },
    write(data: string | Uint8Array, callback: () => void) {
      writes.push(typeof data === 'string' ? encoder.encode(data) : data.slice());
      callback();
    },
    reset() {},
    resize() {},
    clear() {},
  };
  const adapter = createTerminalRawMutationAdapter({
    terminal: terminal as never,
    fitAddon: { fit() {} } as never,
    markReady() {},
    releaseInput() {},
    settleInput() {},
    requestFreshRecovery() {},
    requestRuntimeRecreation() {},
    compatibilityRecoveryDrained() {},
    settle() {},
    checkpointApplied() {},
    checkpointDrained() {},
  });
  adapter.applyModes({ bracketedPasteMode: true });
  adapter.write({ kind: 'checkpoint', data: encoder.encode('body') }, () => {});
  assert.equal(writes.length, 1);
  assert.equal(new TextDecoder().decode(writes[0]), '\u001b[?2004hbody');
});

test('MIG-BGSTAB-002 write-pipeline probe preserves pending checkpoint mode rehydrate bytes', () => {
  const writes: Array<string | Uint8Array> = [];
  const callbacks: Array<() => void> = [];
  const terminal = {
    cols: 80,
    rows: 24,
    options: { windowsPty: undefined },
    write(data: string | Uint8Array, callback: () => void) {
      writes.push(typeof data === 'string' ? data : data.slice());
      callbacks.push(callback);
    },
    reset() {},
    resize() {},
    clear() {},
  };
  const adapter = createTerminalRawMutationAdapter({
    terminal: terminal as never,
    fitAddon: { fit() {} } as never,
    markReady() {},
    releaseInput() {},
    settleInput() {},
    requestFreshRecovery() {},
    requestRuntimeRecreation() {},
    compatibilityRecoveryDrained() {},
    settle() {},
    checkpointApplied() {},
    checkpointDrained() {},
  });

  adapter.applyModes({ bracketedPasteMode: true });
  assert.ok(adapter.probeWritePipeline, 'the raw mutation adapter must expose a write-pipeline probe');
  adapter.probeWritePipeline(() => {});
  adapter.write({ kind: 'checkpoint', data: encoder.encode('body') }, () => {});

  assert.equal(writes[0], '');
  assert.equal(new TextDecoder().decode(writes[1] as Uint8Array), '\u001b[?2004hbody');
  assert.equal(callbacks.length, 2);
});

test('dispatcher remains dormant for passive capability and never mutates or success-ACKs', () => {
  const { commands, runtime, sent } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  const unregister = registry.register('session-1', runtime);
  registry.setCapability(PASSIVE_CAPABILITY);

  const decision = registry.route(startMessage());
  assert.deepEqual(decision, { delivered: false, reason: 'checkpoint-delivery-inactive' });
  assert.equal(commands.length, 0);
  assert.equal(sent.filter(message => String(message.type).endsWith('-ack')).length, 0);
  unregister();
});

test('per-session dispatcher replacement fail-closes the old active generation', () => {
  const first = createHarness();
  const second = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.setCapability(ACTIVE_CAPABILITY);
  registry.register('session-1', first.runtime);
  registry.register('session-1', second.runtime);

  assert.equal(first.runtime.getState().active, false);
  assert.equal(first.runtime.getState().recoveryPending, false);
  assert.equal(first.runtime.getState().viewGeneration, 8);
  assert.equal(first.runtime.submitInput('stale').accepted, false);
  assert.equal(first.commands.at(-1)?.type, 'rollback-to-compatibility');
  assert.equal(second.runtime.getState().active, true);
  assert.deepEqual(registry.route(startMessage()), { delivered: true });
  assert.equal(first.commands.some(command => command.type === 'checkpoint-begin'), false);
  assert.equal(second.commands.some(command => command.type === 'checkpoint-begin'), true);
});

test('MIG-BGSTAB-002 same-session dispatcher replacement cancels its transient empty negotiation', async () => {
  const scheduled: Array<() => void> = [];
  const sent: string[] = [];
  const scheduler = createTerminalCheckpointRegistrationReleaseScheduler(callback => {
    scheduled.push(callback);
  });
  scheduler.schedule('session-1', () => sent.push('empty-negotiate'));
  scheduler.cancel('session-1');
  scheduled.shift()?.();
  assert.deepEqual(sent, [] as typeof sent, 'same-session replacement must cancel the predecessor release');

  scheduler.schedule('session-1', () => sent.push('final-release'));
  scheduled.shift()?.();
  assert.deepEqual(sent, ['final-release'], 'a final dispose must still unregister after one turn');
});

test('active per-session ingress submits start/chunk/commit/output and input to one coordinator', () => {
  const { commands, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  assert.deepEqual(registry.route(startMessage()), { delivered: true });
  assert.deepEqual(registry.route(chunkMessage()), { delivered: true });
  assert.deepEqual(registry.route(commitMessage()), { delivered: true });
  assert.deepEqual(registry.route({
    type: 'terminal-checkpoint:output',
    ...identity({ sourceSeq: '13' }),
    encoding: 'base64',
    data: 'dGFpbA==',
    encodedBytes: 4,
  }), { delivered: true });
  assert.deepEqual(runtime.submitInput('typed'), { accepted: true });

  assert.deepEqual(commands.map(command => command.type), [
    'checkpoint-begin',
    'checkpoint-chunk',
    'checkpoint-commit',
    'live',
    'queue-input',
  ]);
  assert.equal(new TextDecoder().decode(commands[1]?.data as Uint8Array), 'abc');
  assert.equal(new TextDecoder().decode(commands[3]?.data as Uint8Array), 'tail');
  assert.equal(typeof commands[4]?.settlementToken, 'string');
  assert.equal(String(commands[4]?.settlementToken).includes('typed'), false);
});

test('capability withdrawal atomically rolls recovery into a clean legacy generation', () => {
  const { commands, generations, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  runtime.handleMessage(startMessage());
  assert.equal(runtime.submitInput('private-input').accepted, true);
  runtime.coordinatorRecoveryFailed('checkpoint-digest-mismatch');
  assert.equal(runtime.getState().recoveryPending, true);

  runtime.setCapability(PASSIVE_CAPABILITY);

  assert.deepEqual(commands.slice(-2).map(command => command.type), [
    'recovery-failed',
    'rollback-to-compatibility',
  ]);
  assert.deepEqual(commands.at(-1), {
    type: 'rollback-to-compatibility',
    viewGeneration: 8,
    reason: 'checkpoint-capability-deactivated',
  });
  assert.deepEqual(runtime.getState(), {
    active: false,
    ready: false,
    disposed: false,
    recoveryPending: false,
    legacyRecoveryPending: true,
    checkpointDeliveryPreparationPending: false,
    orderedRollbackPending: false,
    viewGeneration: 8,
    registrationViewGeneration: 8,
  });
  assert.deepEqual(generations, [8]);

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
  });
  assert.equal(
    runtime.getState().active,
    false,
    'checkpoint authority reactivated before compatibility snapshot drain',
  );
  const prematureFresh = runtime.handleMessage(startMessage({ viewGeneration: 8 }));
  assert.deepEqual(prematureFresh, {
    accepted: false,
    reason: 'checkpoint-delivery-inactive',
  });
  const stale = runtime.handleMessage(startMessage());
  assert.deepEqual(stale, { accepted: false, reason: 'checkpoint-delivery-inactive' });
  const staleMetadata = {
    ...identity(),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };
  assert.deepEqual(runtime.checkpointApplied(staleMetadata), {
    accepted: false,
    reason: 'checkpoint-delivery-inactive',
  });
  assert.deepEqual(runtime.checkpointDrained(staleMetadata), {
    accepted: false,
    reason: 'checkpoint-delivery-inactive',
  });
  assert.deepEqual(runtime.coordinatorRecoveryFailed('late-old-callback', {
    viewGeneration: 7,
    streamEpoch: '3',
    checkpointEpoch: '4',
  }), { accepted: false, reason: 'stale-view-generation' });
  assert.equal(runtime.getState().recoveryPending, false, 'stale pre-rollback frame polluted new authority');

  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), { accepted: true });
  assert.equal(runtime.getState().legacyRecoveryPending, false);
  assert.equal(runtime.getState().active, true, 'checkpoint authority did not reactivate after compatibility drain');
});

test('MIG-BGSTAB-002 does not send prepared checkpoint-ready from an unproven clean runtime', () => {
  const { preparedReadyDeferrals, runtime, sent } = createHarness();
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-unproven',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });

  assert.deepEqual(sent, [], 'a runtime without a completed legacy restore cannot prove readiness');
  assert.deepEqual(preparedReadyDeferrals, [{
    checkpointDeliveryId: 'delivery-unproven',
    reason: 'compatibility-snapshot-not-completed',
  }]);
});

test('MIG-BGSTAB-002 admits a prepared checkpoint after its snapshot drained before the capability arrived', () => {
  const { runtime, sent } = createHarness();

  assert.deepEqual(
    runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }),
    { accepted: false, reason: 'legacy-recovery-not-pending' },
  );
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-late-capability',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });

  assert.equal(sent[0]?.type, 'terminal-checkpoint:ready');
  assert.equal(sent[0]?.checkpointDeliveryId, 'delivery-late-capability');
});

test('MIG-BGSTAB-002 reacquires a missing same-socket ready receipt after compatibility recovery completes', () => {
  const {
    runtime,
    sent,
    setPreparedReadyReceiptAvailable,
  } = createHarness();
  setPreparedReadyReceiptAvailable(false);

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-reacquired-receipt',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });
  assert.deepEqual(sent, [] as typeof sent, 'a missing receipt must not use the unordered send path');

  setPreparedReadyReceiptAvailable(true);
  assert.deepEqual(
    runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }),
    { accepted: true },
  );

  assert.equal(sent[0]?.type, 'terminal-checkpoint:ready');
  assert.equal(sent[0]?.checkpointDeliveryId, 'delivery-reacquired-receipt');
});

test('MIG-BGSTAB-002 observes a prepared ready blocked before a control receipt exists', () => {
  const {
    preparedReadyFailures,
    runtime,
    sent,
    setPreparedReadyReceiptAvailable,
  } = createHarness();
  setPreparedReadyReceiptAvailable(false);
  assert.deepEqual(
    runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }),
    { accepted: false, reason: 'legacy-recovery-not-pending' },
  );

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-observed-no-receipt',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });

  assert.deepEqual(sent, [] as typeof sent, 'a missing receipt must not use the unordered send path');
  assert.deepEqual(preparedReadyFailures, [{
    checkpointDeliveryId: 'delivery-observed-no-receipt',
    reason: 'control-socket-not-open',
    actualControlSocketId: 'control-1',
  }]);
});

test('MIG-BGSTAB-002 does not send or latch prepared ready across a replaced control socket', () => {
  const { replacePreparedReadyControlSocket, runtime, sent } = createHarness();
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-control-1',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });
  replacePreparedReadyControlSocket('control-2');

  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), { accepted: true });
  assert.deepEqual(sent, [] as typeof sent, 'a C1 preparation must not be sent over replacement C2');

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-control-2',
      authorityEpoch: 'authority-9',
      streamEpoch: '6',
      viewGeneration: 7,
      driverLeaseGeneration: '6',
      acceptedViewAttributesGeneration: '6',
      viewAttributesChallengeId: 'challenge-9',
    },
  });

  assert.equal(sent[0]?.checkpointDeliveryId, 'delivery-control-2');
});

test('MIG-BGSTAB-002 accepts an initial compatibility snapshot completion for the prepared generation', () => {
  const { runtime, sent } = createHarness();
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-initial-snapshot',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });

  assert.equal(runtime.getState().checkpointDeliveryPreparationPending, true);
  assert.deepEqual(
    runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }),
    { accepted: true },
  );
  assert.equal(sent[0]?.type, 'terminal-checkpoint:ready');
  assert.equal(sent[0]?.checkpointDeliveryId, 'delivery-initial-snapshot');
});

test('MIG-BGSTAB-002 sends prepared ready after a same-socket view-attributes control message', () => {
  const { advancePreparedReadyEnqueueOrdinal, runtime, sent } = createHarness();
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-after-view-attributes',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 7,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });

  advancePreparedReadyEnqueueOrdinal();

  assert.deepEqual(
    runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }),
    { accepted: true },
  );
  assert.equal(sent[0]?.type, 'terminal-checkpoint:ready');
  assert.equal(sent[0]?.checkpointDeliveryId, 'delivery-after-view-attributes');
});

test('MIG-BGSTAB-002 sends one prepared checkpoint-ready only after compatibility recovery completes', () => {
  const { runtime, sent } = createHarness();
  assert.deepEqual(runtime.beginLegacyRecovery('replacement-compatibility-snapshot'), { accepted: true });
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-8',
      authorityEpoch: 'authority-8',
      streamEpoch: '5',
      viewGeneration: 8,
      driverLeaseGeneration: '5',
      acceptedViewAttributesGeneration: '5',
      viewAttributesChallengeId: 'challenge-8',
    },
  });
  assert.deepEqual(sent, [], 'a pending compatibility snapshot must not admit a checkpoint transaction');

  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), { accepted: true });
  assert.deepEqual(sent, [{
    type: 'terminal-checkpoint:ready',
    protocolVersion: 1,
    sessionId: 'session-1',
    viewGeneration: 8,
    authorityEpoch: 'authority-8',
    streamEpoch: '5',
    driverLeaseGeneration: '5',
    acceptedViewAttributesGeneration: '5',
    viewAttributesChallengeId: 'challenge-8',
    checkpointDeliveryId: 'delivery-8',
  }]);
  assert.deepEqual(
    runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }),
    { accepted: false, reason: 'legacy-recovery-not-pending' },
  );
  assert.equal(sent.length, 1, 'duplicate recovery completion must not duplicate ready');
});

test('MIG-BGSTAB-002 stale scoped capability cannot replace the current generation or restart rollback', () => {
  const { commands, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  assert.deepEqual(runtime.rollbackToLegacy('install-generation-eight', {
    requestFreshRecovery: false,
  }), { accepted: true });
  const generationEightCapability = {
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
  };
  registry.setCapability(generationEightCapability);
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), { accepted: true });
  assert.equal(runtime.getState().active, true);

  const rollbackCountBeforeStale = commands.filter(
    command => command.type === 'rollback-to-compatibility',
  ).length;
  registry.setCapability({
    ...PASSIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 7 }],
  });

  assert.equal(runtime.getState().viewGeneration, 8);
  assert.equal(runtime.getState().active, true);
  assert.equal(
    commands.filter(command => command.type === 'rollback-to-compatibility').length,
    rollbackCountBeforeStale,
  );
  assert.deepEqual(registry.route(startMessage({ viewGeneration: 8 })), { delivered: true });
});

test('MIG-BGSTAB-002 final dispatcher replacement accepts a legitimate lower generation after lifetime reset', () => {
  const firstHarness = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  const unregisterFirst = registry.register('session-1', firstHarness.runtime);
  registry.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
  });
  assert.equal(unregisterFirst(), true);

  const replacementHarness = createHarness();
  registry.register('session-1', replacementHarness.runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  assert.equal(replacementHarness.runtime.getState().viewGeneration, 7);
  assert.equal(replacementHarness.runtime.getState().active, true);
  assert.deepEqual(registry.route(startMessage()), { delivered: true });
});

test('MIG-BGSTAB-002 empty server capability remains an authoritative fail-closed withdrawal', () => {
  const { commands, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  const emptyWithdrawal: TerminalCheckpointCapabilityMessage = {
    ...PASSIVE_CAPABILITY,
    registeredViews: [],
  };
  const selected = registry.selectFreshCapability(emptyWithdrawal);
  assert.deepEqual(selected, emptyWithdrawal);
  registry.setCapability(selected);

  assert.equal(runtime.getState().active, false);
  assert.equal(runtime.getState().legacyRecoveryPending, true);
  assert.equal(commands.at(-1)?.type, 'rollback-to-compatibility');
});

test('MIG-BGSTAB-002 final release clears cached authority after transient same-turn replacement', () => {
  const firstHarness = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  const unregisterFirst = registry.register('session-1', firstHarness.runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  assert.equal(firstHarness.runtime.getState().active, true);
  assert.equal(unregisterFirst(), true);

  const transientReplacement = createHarness();
  const unregisterTransient = registry.register('session-1', transientReplacement.runtime);
  assert.equal(
    transientReplacement.runtime.getState().active,
    true,
    'same-turn replacement must inherit authority until final release is confirmed',
  );
  assert.equal(unregisterTransient(), true);

  const releaseCapability = (
    registry as unknown as { releaseCapability?: (sessionId: string) => void }
  ).releaseCapability;
  assert.equal(typeof releaseCapability, 'function');
  releaseCapability?.('session-1');

  const finalReplacement = createHarness();
  registry.register('session-1', finalReplacement.runtime);

  assert.equal(finalReplacement.runtime.getState().active, false);
  assert.deepEqual(finalReplacement.commands, []);
});

test('explicit runtime rollback and null capability are idempotent legacy transitions', () => {
  const { commands, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  assert.deepEqual(runtime.rollbackToLegacy('operator-rollback'), { accepted: true });
  assert.equal(runtime.getState().viewGeneration, 8);
  assert.equal(runtime.getState().recoveryPending, false);
  runtime.setCapability(null);
  assert.equal(runtime.getState().viewGeneration, 8, 'already-legacy null capability advanced twice');
  assert.equal(commands.filter(command => command.type === 'rollback-to-compatibility').length, 1);
});

test('MIG-BGSTAB-002 rollback-start installs a same-view replacement boundary before the next checkpoint', () => {
  const { commands, recovery, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  assert.deepEqual(runtime.handleMessage(startMessage()), { accepted: true });

  const rollbackStart: TerminalAuthorityRollbackStartMessage = {
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-2',
    streamEpoch: '4',
    responderLeaseId: 'responder-2',
    driverLeaseId: 'driver-2',
    boundarySourceSeq: '13',
    checkpointEpoch: '5',
    affectedViews: [{
      connectionId: 'connection-1',
      viewGeneration: 7,
      responderLeaseId: 'responder-2',
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '4',
      acceptedViewAttributesGeneration: '4',
    }],
  };
  assert.deepEqual(runtime.beginCompatibilityRollback(rollbackStart), { accepted: true });
  assert.deepEqual(commands.at(-1), {
    type: 'install-rollback-checkpoint-boundary',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
    reason: 'terminal-authority-rollback-start',
  });

  assert.deepEqual(runtime.handleMessage(startMessage({
    streamEpoch: '4',
    checkpointEpoch: '5',
    sourceSeq: '13',
    snapshotSeq: '13',
    oldestRetainedSeq: '1',
  })), { accepted: true });
  assert.equal(commands.filter(command => command.type === 'checkpoint-begin').length, 2);
  assert.equal(recovery.length, 0, 'explicit rollback replacement must not start a failure/reconnect loop');
});

test('MIG-BGSTAB-002 drained ordered rollback consumes passive capability without rotating the view', () => {
  const { commands, generations, recovery, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  const rollbackStart: TerminalAuthorityRollbackStartMessage = {
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-2',
    streamEpoch: '4',
    responderLeaseId: 'responder-2',
    driverLeaseId: 'driver-2',
    boundarySourceSeq: '13',
    checkpointEpoch: '5',
    affectedViews: [{
      connectionId: 'connection-1',
      viewGeneration: 7,
      responderLeaseId: 'responder-2',
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '4',
      acceptedViewAttributesGeneration: '4',
    }],
  };
  const rollbackIdentity = {
    streamEpoch: '4',
    checkpointEpoch: '5',
    sourceSeq: '13',
    snapshotSeq: '13',
    oldestRetainedSeq: '1',
  };

  assert.deepEqual(runtime.beginCompatibilityRollback(rollbackStart), { accepted: true });
  assert.equal(runtime.getState().legacyRecoveryPending, true);
  assert.equal(
    resolveTerminalCheckpointInputRoute(runtime.getState()),
    'pending-input-queue',
    'input arriving after rollback-start must stay outside the draining checkpoint coordinator',
  );
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), {
    accepted: false,
    reason: 'ordered-rollback-enable-required',
  });
  assert.deepEqual(runtime.completeLegacyRecovery({
    source: 'legacy-responder-enabled',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
  }), {
    accepted: false,
    reason: 'ordered-rollback-not-committed',
  });
  assert.deepEqual(runtime.handleMessage(startMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.handleMessage(chunkMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.handleMessage(commitMessage(rollbackIdentity)), { accepted: true });
  const lifecycle = {
    ...identity(rollbackIdentity),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };
  assert.deepEqual(runtime.checkpointApplied(lifecycle), { accepted: true });
  assert.deepEqual(runtime.checkpointDrained(lifecycle), { accepted: true });
  assert.deepEqual(runtime.completeLegacyRecovery({
    source: 'legacy-responder-enabled',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
  }), {
    accepted: false,
    reason: 'ordered-rollback-not-committed',
  }, 'checkpoint drain alone must not commit before passive capability');

  assert.deepEqual(runtime.setCapability({
    ...PASSIVE_CAPABILITY,
    compatibilityRecoveryRole: 'selected-responder',
  }), { accepted: true });
  assert.deepEqual(runtime.getState(), {
    active: false,
    ready: false,
    disposed: false,
    recoveryPending: false,
    legacyRecoveryPending: true,
    checkpointDeliveryPreparationPending: false,
    orderedRollbackPending: true,
    viewGeneration: 7,
    registrationViewGeneration: 7,
  });
  assert.deepEqual(generations, [], 'an ordered handoff must retain the mounted xterm generation');
  assert.deepEqual(recovery, [], 'an ordered handoff must not request another snapshot or reconnect');
  assert.equal(
    commands.some(command => command.type === 'rollback-to-compatibility'),
    false,
    'the already drained rollback checkpoint must not install a second compatibility generation',
  );

  const commandCountBeforeEnable = commands.length;
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), {
    accepted: false,
    reason: 'ordered-rollback-enable-required',
  });
  assert.deepEqual(runtime.completeLegacyRecovery({
    source: 'legacy-responder-enabled',
    viewGeneration: 7,
    streamEpoch: '999',
    checkpointEpoch: '5',
  }), {
    accepted: false,
    reason: 'ordered-rollback-enable-identity-mismatch',
  });
  assert.deepEqual(runtime.completeLegacyRecovery({
    source: 'legacy-responder-enabled',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
  }), { accepted: true });
  assert.equal(runtime.getState().legacyRecoveryPending, false);
  assert.equal(commands.length, commandCountBeforeEnable + 1);
  assert.deepEqual(commands.at(-1), {
    type: 'complete-ordered-compatibility-recovery',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
  }, 'legacy-responder-enabled must release coordinator authority without another xterm reset');

  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const enableStart = terminalViewSource.indexOf('onLegacyResponderEnabled:');
  const enableEnd = terminalViewSource.indexOf('\n        },', enableStart);
  const enableHandler = terminalViewSource.slice(enableStart, enableEnd);
  const runtimeCommit = enableHandler.indexOf('checkpointRuntime.completeLegacyRecovery({');
  const inputRelease = enableHandler.indexOf('checkpointInputBarrierRef.current = false');
  assert.ok(runtimeCommit >= 0, 'legacy responder enable must commit the checkpoint runtime handoff');
  assert.ok(inputRelease > runtimeCommit, 'input must remain gated until the runtime handoff is committed');
  const coordinatorStart = terminalViewSource.indexOf('terminalWriteCoordinatorRef.current = createTerminalWriteCoordinator');
  const markReadyStart = terminalViewSource.indexOf('markReady:', coordinatorStart);
  const markReadyEnd = terminalViewSource.indexOf('releaseInput:', markReadyStart);
  const markReadyHandler = terminalViewSource.slice(markReadyStart, markReadyEnd);
  assert.match(
    markReadyHandler,
    /resolveTerminalCheckpointInputRoute\(\s*checkpointRuntime\.getState\(\)/u,
    'checkpoint drain must preserve the rollback input barrier until legacy responder enable',
  );
  const mutationOwnerStart = terminalViewSource.indexOf('const checkpointOwnsTerminalMutation');
  const mutationOwnerEnd = terminalViewSource.indexOf('\n      };', mutationOwnerStart);
  const mutationOwner = terminalViewSource.slice(mutationOwnerStart, mutationOwnerEnd);
  assert.match(mutationOwner, /state\.active \|\| state\.recoveryPending/u);
  assert.match(mutationOwner, /state\.orderedRollbackPending/u);
  assert.doesNotMatch(
    mutationOwner,
    /!state\.legacyRecoveryPending/u,
    'ordered rollback remains checkpoint-owned until the passive capability is committed',
  );

  const authorityStateStart = terminalViewSource.indexOf('onAuthorityStateChange:');
  const authorityStateEnd = terminalViewSource.indexOf('\n        },', authorityStateStart);
  const authorityStateHandler = terminalViewSource.slice(authorityStateStart, authorityStateEnd);
  assert.match(
    authorityStateHandler,
    /checkpointInputBarrierRef\.current = state === 'checkpoint-pending'/u,
    'authority state transitions must derive the input barrier from the current state',
  );
  assert.doesNotMatch(
    authorityStateHandler,
    /if \(state !== 'checkpoint-drained'\)/u,
    'a drained checkpoint must clear a previously armed input barrier',
  );
  assert.match(
    authorityStateHandler,
    /if \(state === 'legacy'\) \{[\s\S]*checkpointMutationLeaseBarrierRef\.current = false;/u,
    'a completed passive legacy recovery must release its mutation lease barrier',
  );
});

test('REL-BGSTAB-007/012 ordered rollback fences local restore until legacy responder enable', () => {
  const signature =
    'REL-BGSTAB-007 AC-8/AC-12 and REL-BGSTAB-012 AC-6: passive ordered rollback must keep local repair and input behind the server handoff';
  const { commands, recovery, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  const rollbackStart: TerminalAuthorityRollbackStartMessage = {
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-2',
    streamEpoch: '4',
    responderLeaseId: 'responder-2',
    driverLeaseId: 'driver-2',
    boundarySourceSeq: '13',
    checkpointEpoch: '5',
    affectedViews: [{
      connectionId: 'connection-1',
      viewGeneration: 7,
      responderLeaseId: 'responder-2',
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '4',
      acceptedViewAttributesGeneration: '4',
    }],
  };
  const rollbackIdentity = {
    streamEpoch: '4',
    checkpointEpoch: '5',
    sourceSeq: '13',
    snapshotSeq: '13',
    oldestRetainedSeq: '1',
  };
  const lifecycle = {
    ...identity(rollbackIdentity),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };

  assert.deepEqual(runtime.beginCompatibilityRollback(rollbackStart), { accepted: true }, signature);
  assert.deepEqual(runtime.handleMessage(startMessage(rollbackIdentity)), { accepted: true }, signature);
  assert.deepEqual(runtime.handleMessage(chunkMessage(rollbackIdentity)), { accepted: true }, signature);
  assert.deepEqual(runtime.handleMessage(commitMessage(rollbackIdentity)), { accepted: true }, signature);
  assert.deepEqual(runtime.checkpointApplied(lifecycle), { accepted: true }, signature);
  assert.deepEqual(runtime.checkpointDrained(lifecycle), { accepted: true }, signature);
  assert.deepEqual(runtime.setCapability({
    ...PASSIVE_CAPABILITY,
    compatibilityRecoveryRole: 'selected-responder',
  }), { accepted: true }, signature);
  assert.equal(runtime.getState().orderedRollbackPending, true, signature);
  assert.equal(resolveTerminalCheckpointInputRoute(runtime.getState()), 'pending-input-queue', signature);

  const pendingInput: Array<{ data: string; kind: 'key' | 'paste' }> = [];
  for (const input of [
    { data: 'typed-before-enable', kind: 'key' },
    { data: 'pasted-before-enable', kind: 'paste' },
  ] as const) {
    assert.equal(resolveTerminalCheckpointInputRoute(runtime.getState()), 'pending-input-queue', signature);
    pendingInput.push(input);
  }

  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const restoreStart = terminalViewSource.indexOf('const restoreStoredSnapshot = useCallback');
  const restoreEnd = terminalViewSource.indexOf('const applySnapshotReplacement', restoreStart);
  const restoreStoredSnapshot = terminalViewSource.slice(restoreStart, restoreEnd);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, signature);
  const cacheRead = restoreStoredSnapshot.indexOf('const snapshot = loadStoredSnapshot();');
  const repairWrite = restoreStoredSnapshot.indexOf('writeReplayDataWithProbe');
  const releasePending = restoreStoredSnapshot.indexOf('releaseRestorePending');
  assert.ok(cacheRead > 0 && repairWrite > cacheRead && releasePending > repairWrite, signature);

  const preReadFence = restoreStoredSnapshot.slice(0, cacheRead);
  assert.match(
    preReadFence,
    /checkpointState\?\.active\s*\|\|\s*checkpointState\?\.recoveryPending\s*\|\|\s*checkpointState\?\.orderedRollbackPending/u,
    'the passive ordered rollback must return before reading or writing a local snapshot',
  );
  const postWriteFence = restoreStoredSnapshot.slice(repairWrite, releasePending);
  assert.match(
    postWriteFence,
    /currentCheckpointState\?\.active\s*\|\|\s*currentCheckpointState\?\.recoveryPending\s*\|\|\s*currentCheckpointState\?\.orderedRollbackPending/u,
    'authority acquired during an asynchronous repair write must return before restorePending release',
  );

  const localRepairWrites: string[] = [];
  let restorePendingLeaks = 0;
  const requestLocalRestoreAtCurrentBoundary = (): boolean => {
    const state = runtime.getState();
    if (state.active || state.recoveryPending || state.orderedRollbackPending) {
      return false;
    }
    localRepairWrites.push('poisoned-local-history');
    restorePendingLeaks += 1;
    return true;
  };
  assert.equal(requestLocalRestoreAtCurrentBoundary(), false, signature);
  assert.equal(localRepairWrites.length, 0, 'ordered rollback must produce zero local repair writes');
  assert.equal(restorePendingLeaks, 0, 'a rejected local restore must not leak restorePending');

  assert.deepEqual(runtime.completeLegacyRecovery({
    source: 'legacy-responder-enabled',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
  }), { accepted: true }, signature);
  assert.equal(runtime.getState().orderedRollbackPending, false, signature);

  const forwardedInput: Array<{ data: string; kind: 'key' | 'paste' }> = [];
  const flushPendingInput = (): void => {
    forwardedInput.push(...pendingInput.splice(0));
  };
  flushPendingInput();
  flushPendingInput();
  assert.deepEqual(forwardedInput, [
    { data: 'typed-before-enable', kind: 'key' },
    { data: 'pasted-before-enable', kind: 'paste' },
  ], 'queued key and paste input must each forward exactly once after legacy responder enable');
  assert.equal(recovery.length, 0, 'local restore rejection must not mutate stale or dataGap recovery state');
  assert.equal(
    commands.filter(command => (
      command.type === 'recovery-failed'
      || command.type === 'rollback-to-compatibility'
    )).length,
    0,
    'local restore rejection must not add a stale/dataGap compatibility mutation',
  );
});

test('MIG-BGSTAB-002 passive rollback observer releases only after its own snapshot drain', () => {
  const { runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  const rollbackStart: TerminalAuthorityRollbackStartMessage = {
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-2',
    streamEpoch: '4',
    responderLeaseId: 'responder-2',
    driverLeaseId: 'driver-2',
    boundarySourceSeq: '13',
    checkpointEpoch: '5',
    affectedViews: [{
      connectionId: 'connection-1',
      viewGeneration: 7,
      responderLeaseId: 'responder-2',
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '4',
      acceptedViewAttributesGeneration: '4',
    }],
  };
  const rollbackIdentity = {
    streamEpoch: '4',
    checkpointEpoch: '5',
    sourceSeq: '13',
    snapshotSeq: '13',
    oldestRetainedSeq: '1',
  };

  assert.deepEqual(runtime.beginCompatibilityRollback(rollbackStart), { accepted: true });
  assert.deepEqual(runtime.handleMessage(startMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.handleMessage(chunkMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.handleMessage(commitMessage(rollbackIdentity)), { accepted: true });
  const lifecycle = {
    ...identity(rollbackIdentity),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };
  assert.deepEqual(runtime.checkpointApplied(lifecycle), { accepted: true });
  assert.deepEqual(runtime.checkpointDrained(lifecycle), { accepted: true });
  assert.deepEqual(runtime.setCapability({
    ...PASSIVE_CAPABILITY,
    compatibilityRecoveryRole: 'selected-responder',
  } as never), { accepted: true });
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), {
    accepted: false,
    reason: 'ordered-rollback-enable-required',
  }, 'the selected responder remains fenced until its exact enable frame arrives');
  assert.deepEqual(runtime.setCapability({
    ...PASSIVE_CAPABILITY,
    compatibilityRecoveryRole: 'passive-snapshot',
  } as never), { accepted: true });
  assert.deepEqual(runtime.setCapability(PASSIVE_CAPABILITY), { accepted: true },
    'a same-generation re-registration must not erase the passive rollback role before snapshot recovery');
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), { accepted: true });
  assert.equal(runtime.getState().legacyRecoveryPending, false);
});

test('MIG-BGSTAB-002 ordered rollback completion releases the real coordinator checkpoint authority', () => {
  const events: string[] = [];
  let coordinator: TerminalWriteCoordinator | null = null;
  const runtime = createTerminalCheckpointRuntime({
    sessionId: 'session-1',
    initialViewGeneration: 7,
    getCoordinator: () => coordinator,
    send: () => ({ ok: true }),
    requestFreshRecovery: reason => events.push(`recovery:${reason}`),
    advanceViewGeneration: generation => events.push(`generation:${generation}`),
  });
  coordinator = createTerminalWriteCoordinator({
    viewGeneration: 7,
    digestBytes: digestTerminalBytes,
    adapter: {
      write: (_command, callback) => callback(),
      resetParser: () => events.push('reset'),
      resize: () => {},
      applyModes: () => {},
      clearScreen: () => {},
      fit: () => ({ cols: 80, rows: 24 }),
      setWindowsPty: () => {},
      checkpointApplied: metadata => {
        const result = runtime.checkpointApplied(metadata);
        if (!result.accepted) throw new Error(result.reason);
      },
      checkpointDrained: metadata => {
        const result = runtime.checkpointDrained(metadata);
        if (!result.accepted) throw new Error(result.reason);
      },
      markReady: () => {},
      releaseInput: () => {},
      settleInput: () => {},
      requestFreshRecovery: reason => events.push(`adapter-recovery:${reason}`),
      requestRuntimeRecreation: reason => events.push(`recreate:${reason}`),
      compatibilityRecoveryDrained: generation => events.push(`legacy-drained:${generation}`),
      settle: () => {},
    },
    timeoutMs: 100,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
    pendingInputMaxBytes: 1024,
    pendingInputMaxCount: 16,
    pendingInputTtlMs: 1000,
    settlementLedgerMaxEntries: 16,
    settlementLedgerTtlMs: 1000,
  });
  runtime.setCapability(ACTIVE_CAPABILITY);
  const rollbackStart: TerminalAuthorityRollbackStartMessage = {
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-2',
    streamEpoch: '4',
    responderLeaseId: 'responder-2',
    driverLeaseId: 'driver-2',
    boundarySourceSeq: '13',
    checkpointEpoch: '5',
    affectedViews: [{
      connectionId: 'connection-1',
      viewGeneration: 7,
      responderLeaseId: 'responder-2',
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '4',
      acceptedViewAttributesGeneration: '4',
    }],
  };
  const rollbackIdentity = {
    streamEpoch: '4',
    checkpointEpoch: '5',
    sourceSeq: '13',
    snapshotSeq: '13',
    oldestRetainedSeq: '1',
  };

  assert.deepEqual(runtime.beginCompatibilityRollback(rollbackStart), { accepted: true });
  assert.deepEqual(runtime.handleMessage(startMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.handleMessage(chunkMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.handleMessage(commitMessage(rollbackIdentity)), { accepted: true });
  assert.deepEqual(runtime.setCapability(PASSIVE_CAPABILITY), { accepted: true });
  assert.deepEqual(runtime.completeLegacyRecovery({
    source: 'legacy-responder-enabled',
    viewGeneration: 7,
    streamEpoch: '4',
    checkpointEpoch: '5',
  }), { accepted: true });

  assert.deepEqual(coordinator.submitCompatibility({
    type: 'reset',
    viewGeneration: 7,
  }), { accepted: true }, 'drained ordered checkpoint still owned the compatibility writer');
  assert.equal(events.filter(event => event === 'reset').length, 2,
    'ordered completion must admit exactly one later compatibility reset without replaying the checkpoint reset');
});

test('runtime replacement rehydrates legacy recovery without duplicating an in-flight reconnect', () => {
  const { commands, recovery, runtime } = createHarness();

  assert.deepEqual(runtime.rollbackToLegacy('runtime-replacement-handoff', {
    requestFreshRecovery: false,
  }), { accepted: true });
  assert.equal(runtime.getState().legacyRecoveryPending, true);
  assert.deepEqual(recovery, []);
  assert.deepEqual(commands.at(-1), {
    type: 'rollback-to-compatibility',
    viewGeneration: 8,
    reason: 'runtime-replacement-handoff',
  });
});

test('active capability is scoped to its negotiated session view generation', () => {
  const { commands, runtime } = createHarness();
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'other', viewGeneration: 7 }],
  });
  assert.equal(runtime.getState().active, false);
  assert.equal(runtime.handleMessage(startMessage()).accepted, false);
  assert.equal(commands.length, 0);
});

test('unsupported checkpoint mode fails before coordinator begin can reset or resize', () => {
  const { commands, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  const decision = runtime.handleMessage(startMessage({ modes: { unsupportedMode: true } }));
  assert.equal(decision.accepted, false);
  assert.deepEqual(commands.map(command => command.type), ['recovery-failed']);
});

test('coordinator apply/drain lifecycle emits actual gated ACKs in order', () => {
  const { runtime, sent } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  runtime.handleMessage(startMessage());
  runtime.handleMessage(chunkMessage());
  runtime.handleMessage(commitMessage());

  const metadata = {
    ...identity(),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };
  runtime.checkpointApplied(metadata);
  runtime.checkpointDrained(metadata);

  assert.deepEqual(sent.map(message => message.type), [
    'terminal-checkpoint:apply-ack',
    'terminal-checkpoint:drain-ack',
  ]);
  assert.equal(sent[0]?.appliedThroughSeq, '10');
  assert.equal(sent[1]?.drainedThroughSeq, '12');
  assert.equal(parseTerminalCheckpointClientMessage(sent[0]).ok, true);
  assert.equal(parseTerminalCheckpointClientMessage(sent[1]).ok, true);
});

test('session-scoped asynchronous ACK rejection is routed back into recovery', () => {
  const { commands, recovery, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  registry.route(startMessage());
  registry.route(chunkMessage());
  registry.route(commitMessage());

  assert.deepEqual(registry.route({
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: 1,
    phase: 'ack',
    reason: 'checkpoint-not-active',
    sessionId: 'session-1',
    ackIdentity: {
      sessionId: 'session-1',
      connectionId: 'connection-1',
      viewGeneration: 7,
      streamEpoch: '3',
      checkpointEpoch: '4',
    },
  }), {
    handled: true,
    delivered: false,
    reason: 'checkpoint-server-rejected:checkpoint-not-active',
  });
  assert.equal(commands.at(-1)?.type, 'recovery-failed');
  assert.deepEqual(recovery, ['checkpoint-server-rejected:checkpoint-not-active']);
});

test('MIG-BGSTAB-002 ignores a delayed ACK rejection whose checkpoint identity predates the active transaction', () => {
  const { commands, recovery, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  registry.route(startMessage());

  assert.deepEqual(registry.route({
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: 1,
    phase: 'ack',
    reason: 'checkpoint-not-active',
    sessionId: 'session-1',
    ackIdentity: {
      sessionId: 'session-1',
      connectionId: 'connection-1',
      viewGeneration: 7,
      streamEpoch: '2',
      checkpointEpoch: '3',
    },
  }), {
    handled: true,
    delivered: false,
    reason: 'stale-server-rejection',
  });
  assert.equal(commands.some(command => command.type === 'recovery-failed'), false);
  assert.deepEqual(recovery, []);
  assert.equal(runtime.getState().recoveryPending, false);
});

test('MIG-BGSTAB-002 ignores a delayed pre-rollback ACK rejection after installing its replacement boundary', () => {
  const { commands, recovery, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  registry.route(startMessage());

  assert.deepEqual(runtime.beginCompatibilityRollback({
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-2',
    streamEpoch: '4',
    responderLeaseId: 'responder-2',
    driverLeaseId: 'driver-2',
    boundarySourceSeq: '13',
    checkpointEpoch: '5',
    affectedViews: [{
      connectionId: 'connection-1',
      viewGeneration: 7,
      responderLeaseId: 'responder-2',
      queryReplyCapability: 'terminal.query-reply-input.v1',
      parserResponderCapability: 'terminal.parser-responder-disable.v1',
      driverLeaseGeneration: '4',
      acceptedViewAttributesGeneration: '4',
    }],
  }), { accepted: true });

  assert.deepEqual(registry.route({
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: 1,
    phase: 'ack',
    reason: 'invalid-message',
    sessionId: 'session-1',
    ackIdentity: {
      sessionId: 'session-1',
      connectionId: 'connection-1',
      viewGeneration: 7,
      streamEpoch: '3',
      checkpointEpoch: '4',
    },
  }), {
    handled: true,
    delivered: false,
    reason: 'stale-rollback-server-rejection',
  });
  assert.equal(commands.some(command => command.type === 'recovery-failed'), false);
  assert.deepEqual(recovery, []);
  assert.equal(runtime.getState().orderedRollbackPending, true);
});

test('MIG-BGSTAB-002 isolates an uncorrelatable ACK rejection after a fresh checkpoint starts', () => {
  const { commands, recovery, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  registry.route(startMessage());

  assert.deepEqual(registry.route({
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: 1,
    phase: 'ack',
    reason: 'checkpoint-not-active',
    sessionId: 'session-1',
  }), {
    handled: true,
    delivered: false,
    reason: 'uncorrelatable-server-rejection',
  });
  assert.equal(commands.some(command => command.type === 'recovery-failed'), false);
  assert.deepEqual(recovery, []);
  assert.equal(runtime.getState().recoveryPending, false);
});

test('MIG-BGSTAB-002 isolates an uncorrelatable ACK rejection before a checkpoint starts', () => {
  const { recovery, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);

  assert.deepEqual(runtime.handleMessage({
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: 1,
    phase: 'ack',
    reason: 'invalid-message',
    sessionId: 'session-1',
  }), { accepted: false, reason: 'uncorrelatable-server-rejection' });
  assert.deepEqual(recovery, []);
  assert.equal(runtime.getState().recoveryPending, false);
});

test('MIG-BGSTAB-002 isolates an ACK rejection that omits the active connection identity', () => {
  const { commands, recovery, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  registry.route(startMessage());

  assert.deepEqual(registry.route({
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: 1,
    phase: 'ack',
    reason: 'checkpoint-not-active',
    sessionId: 'session-1',
    ackIdentity: {
      sessionId: 'session-1',
      viewGeneration: 7,
      streamEpoch: '3',
      checkpointEpoch: '4',
    },
  }), {
    handled: true,
    delivered: false,
    reason: 'uncorrelatable-server-rejection',
  });
  assert.equal(commands.some(command => command.type === 'recovery-failed'), false);
  assert.deepEqual(recovery, []);
  assert.equal(runtime.getState().recoveryPending, false);
});

test('capability withdrawal advertises the clean rollback generation on reconnect', () => {
  const { generations, runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  registry.setCapability(null);
  assert.equal(runtime.getState().recoveryPending, false);
  assert.deepEqual(registry.listViews(), [{ sessionId: 'session-1', viewGeneration: 8 }]);

  registry.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
  });
  assert.deepEqual(registry.route(startMessage({
    viewGeneration: 8,
    streamEpoch: '4',
    checkpointEpoch: '1',
  })), {
    handled: true,
    delivered: false,
    reason: 'checkpoint-delivery-inactive',
  });
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), { accepted: true });
  assert.deepEqual(registry.route(startMessage({
    viewGeneration: 8,
    streamEpoch: '4',
    checkpointEpoch: '1',
  })), { delivered: true });
  assert.deepEqual(generations, [8]);
});

test('malformed active session frame installs fail-closed recovery instead of leaving a pending barrier', () => {
  const { commands, recovery, runtime, sent } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  assert.deepEqual(
    registry.failSession('session-1', 'checkpoint-invalid-frame:invalid-checkpoint-modes'),
    {
      handled: true,
      delivered: false,
      reason: 'checkpoint-invalid-frame:invalid-checkpoint-modes',
    },
  );
  assert.equal(commands.at(-1)?.type, 'recovery-failed');
  assert.deepEqual(recovery, ['checkpoint-invalid-frame:invalid-checkpoint-modes']);
  assert.equal(sent.filter(message => message.type === 'terminal-checkpoint:recovery-request').length, 1);
});

test('malformed session failure is isolated to its registered active view', () => {
  const active = createHarness();
  const legacy = createHarness(true, undefined, 'session-2');
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', active.runtime);
  registry.register('session-2', legacy.runtime);
  registry.setCapability(ACTIVE_CAPABILITY);

  assert.deepEqual(
    registry.failSession('session-2', 'checkpoint-invalid-frame:invalid-checkpoint-modes'),
    { delivered: false, reason: 'checkpoint-delivery-inactive' },
  );
  assert.equal(legacy.runtime.getState().recoveryPending, false);
  assert.equal(legacy.commands.length, 0);
  assert.equal(legacy.sent.length, 0);

  assert.equal(
    registry.failActive('checkpoint-invalid-frame:checkpoint-session-unavailable'),
    1,
  );
  assert.equal(active.runtime.getState().recoveryPending, true);
  assert.equal(legacy.runtime.getState().recoveryPending, false);
});

test('malformed start preserves parseable offending generation and epoch in the recovery fence', () => {
  const { runtime, sent } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  assert.equal(runtime.handleMessage(startMessage({
    streamEpoch: '1', checkpointEpoch: '5', sourceSeq: '10', snapshotSeq: '10',
  })).accepted, true);

  const malformed = {
    type: 'terminal-checkpoint:start',
    sessionId: 'session-1',
    viewGeneration: 9,
    streamEpoch: '1',
    checkpointEpoch: '9',
    modes: { unsupportedMode: true },
  };
  const boundary = extractTerminalCheckpointFailureBoundary(malformed);
  assert.deepEqual(boundary, {
    viewGeneration: 9,
    streamEpoch: '1',
    checkpointEpoch: '9',
  });
  registry.failSession('session-1', 'checkpoint-invalid-frame:invalid-checkpoint-modes', boundary);
  const recoveryRequest = sent
    .filter(message => message.type === 'terminal-checkpoint:recovery-request')
    .at(-1);
  assert.equal(recoveryRequest?.failedViewGeneration, 9);
  assert.equal(recoveryRequest?.requestedViewGeneration, 10);
  assert.equal(recoveryRequest?.failedCheckpointEpoch, '9');

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 10 }],
  });
  assert.deepEqual(runtime.handleMessage(startMessage({
    viewGeneration: 10,
    streamEpoch: '1',
    checkpointEpoch: '9',
    sourceSeq: '20',
    snapshotSeq: '20',
  })), { accepted: false, reason: 'fresh-recovery-generation-required' });
  assert.equal(runtime.getState().registrationViewGeneration, 11);
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 11 }],
  });
  assert.equal(runtime.handleMessage(startMessage({
    viewGeneration: 11,
    streamEpoch: '1',
    checkpointEpoch: '10',
    sourceSeq: '20',
    snapshotSeq: '20',
  })).accepted, true);
});

test('global capability and negotiate rejection scope wins over an injected sessionId', () => {
  // The injected sessionId is the point of this test, so each frame is bound to a
  // variable: TypeScript only applies excess-property checking to fresh literals,
  // and these predicates deliberately read a narrow subset of the wire frame.
  const capabilityWithSessionId = {
    type: 'terminal-checkpoint:capability',
    sessionId: 'session-1',
  };
  const negotiateRejectionWithSessionId = {
    type: 'terminal-checkpoint:rejected',
    phase: 'negotiate',
    sessionId: 'session-1',
  };
  const phaselessRejectionWithSessionId = {
    type: 'terminal-checkpoint:rejected',
    sessionId: 'session-1',
  };
  const ackRejectionWithSessionId = {
    type: 'terminal-checkpoint:rejected',
    phase: 'ack',
    sessionId: 'session-1',
  };
  const startWithSessionId = {
    type: 'terminal-checkpoint:start',
    sessionId: 'session-1',
  };
  assert.equal(isGlobalTerminalCheckpointControlFailure(capabilityWithSessionId), true);
  assert.equal(isGlobalTerminalCheckpointControlFailure(negotiateRejectionWithSessionId), true);
  assert.equal(isGlobalTerminalCheckpointControlFailure(phaselessRejectionWithSessionId), true);
  assert.equal(isGlobalTerminalCheckpointControlFailure(ackRejectionWithSessionId), false);
  assert.equal(isGlobalTerminalCheckpointControlFailure(startWithSessionId), false);
});

test('resize lease rejection remains observable without failing checkpoint recovery', () => {
  const resizeRejection = {
    type: 'terminal-checkpoint:rejected',
    phase: 'ack',
    reason: 'invalid-message',
    rejectedMessageType: 'resize',
    sessionId: 'session-1',
  };
  const nonMutationRejection = {
    type: 'terminal-checkpoint:rejected',
    phase: 'ack',
    reason: 'invalid-message',
    sessionId: 'session-1',
  };
  assert.equal(isTerminalCheckpointMutationRejection(resizeRejection), true);
  assert.equal(isTerminalCheckpointMutationRejection(nonMutationRejection), false);
});

test('higher malformed boundary monotonically supersedes an in-flight recovery request', () => {
  const { runtime, sent } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  runtime.coordinatorRecoveryFailed('first-malformed', {
    viewGeneration: 8,
    streamEpoch: '1',
    checkpointEpoch: '8',
  });
  runtime.coordinatorRecoveryFailed('higher-malformed', {
    viewGeneration: 10,
    streamEpoch: '1',
    checkpointEpoch: '10',
  });

  assert.equal(runtime.getState().registrationViewGeneration, 11);
  const recoveryRequests = sent.filter(
    message => message.type === 'terminal-checkpoint:recovery-request',
  );
  assert.equal(recoveryRequests.length, 2);
  assert.equal(recoveryRequests[1]?.failedViewGeneration, 10);
  assert.equal(recoveryRequests[1]?.requestedViewGeneration, 11);
  assert.equal(recoveryRequests[1]?.failedCheckpointEpoch, '10');

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 11 }],
  });
  assert.deepEqual(runtime.handleMessage(startMessage({
    viewGeneration: 11,
    streamEpoch: '1',
    checkpointEpoch: '10',
    sourceSeq: '20',
    snapshotSeq: '20',
  })), { accepted: false, reason: 'fresh-recovery-generation-required' });
  assert.equal(runtime.getState().registrationViewGeneration, 12);
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 12 }],
  });
  assert.equal(runtime.handleMessage(startMessage({
    viewGeneration: 12,
    streamEpoch: '1',
    checkpointEpoch: '11',
    sourceSeq: '20',
    snapshotSeq: '20',
  })).accepted, true);
});

test('unexpected higher valid start also advances an in-flight recovery boundary', () => {
  const { runtime, sent } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  runtime.coordinatorRecoveryFailed('first-failure', {
    viewGeneration: 8,
    streamEpoch: '1',
    checkpointEpoch: '8',
  });

  assert.equal(runtime.handleMessage(startMessage({
    viewGeneration: 10,
    streamEpoch: '1',
    checkpointEpoch: '10',
    sourceSeq: '20',
    snapshotSeq: '20',
  })).accepted, false);
  assert.equal(runtime.getState().registrationViewGeneration, 11);
  const latestRequest = sent
    .filter(message => message.type === 'terminal-checkpoint:recovery-request')
    .at(-1);
  assert.equal(latestRequest?.failedViewGeneration, 10);
  assert.equal(latestRequest?.requestedViewGeneration, 11);
  assert.equal(latestRequest?.failedCheckpointEpoch, '10');
});

test('stale rejected start cannot lower the last accepted recovery epoch fence', () => {
  const { commands, runtime, sent } = createHarness(true, command => (
    command.type === 'checkpoint-begin' && command.checkpointEpoch === '4'
      ? { accepted: false, reason: 'stale-checkpoint-epoch' }
      : { accepted: true }
  ));
  runtime.setCapability(ACTIVE_CAPABILITY);
  assert.equal(runtime.handleMessage(startMessage({
    streamEpoch: '1', checkpointEpoch: '5', sourceSeq: '10', snapshotSeq: '10',
  })).accepted, true);

  assert.equal(runtime.handleMessage(startMessage({
    streamEpoch: '1', checkpointEpoch: '4', sourceSeq: '10', snapshotSeq: '10',
  })).accepted, false);
  // `Array.prototype.findLast` is ES2023; this project compiles against the ES2022
  // browser lib inherited from tsconfig.app.json.
  const recoveryRequest = [...sent].reverse().find(
    message => message.type === 'terminal-checkpoint:recovery-request',
  );
  assert.equal(recoveryRequest?.failedCheckpointEpoch, '5');

  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
  });
  assert.deepEqual(runtime.handleMessage(startMessage({
    viewGeneration: 8,
    streamEpoch: '1',
    checkpointEpoch: '5',
    sourceSeq: '20',
    snapshotSeq: '20',
  })), { accepted: false, reason: 'fresh-recovery-generation-required' });
  assert.equal(commands.some(command => (
    command.type === 'install-recovery-generation' && command.checkpointEpoch === '5'
  )), false);

  assert.equal(runtime.getState().registrationViewGeneration, 9);
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 9 }],
  });
  assert.equal(runtime.handleMessage(startMessage({
    viewGeneration: 9,
    streamEpoch: '1',
    checkpointEpoch: '6',
    sourceSeq: '20',
    snapshotSeq: '20',
  })).accepted, true);
});

test('reentrant coordinator rejection preserves the maximum offending epoch fence', () => {
  let runtimeRef: ReturnType<typeof createHarness>['runtime'] | null = null;
  const harness = createHarness(true, command => {
    if (command.type === 'checkpoint-begin' && command.checkpointEpoch === '6') {
      runtimeRef?.coordinatorRecoveryFailed('stale-snapshot-seq');
      return { accepted: false, reason: 'stale-snapshot-seq' };
    }
    return { accepted: true };
  });
  runtimeRef = harness.runtime;
  harness.runtime.setCapability(ACTIVE_CAPABILITY);
  assert.equal(harness.runtime.handleMessage(startMessage({
    streamEpoch: '1', checkpointEpoch: '5', sourceSeq: '10', snapshotSeq: '10',
  })).accepted, true);
  assert.equal(harness.runtime.handleMessage(startMessage({
    streamEpoch: '1', checkpointEpoch: '6', sourceSeq: '9', snapshotSeq: '9',
  })).accepted, false);

  const recoveryRequest = harness.sent
    .filter(message => message.type === 'terminal-checkpoint:recovery-request')
    .at(-1);
  assert.equal(recoveryRequest?.failedCheckpointEpoch, '6');
});

test('coordinator-originated failure sends checkpoint recovery request even without manual repair', () => {
  const { commands, runtime, sent } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  runtime.handleMessage(startMessage());
  runtime.coordinatorRecoveryFailed('terminal-write-timeout');

  assert.equal(commands.at(-1)?.type, 'recovery-failed');
  assert.equal(sent.some(message => message.type === 'terminal-checkpoint:failure-ack'), true);
  const recoveryRequest = sent.find(message => message.type === 'terminal-checkpoint:recovery-request');
  assert.equal(recoveryRequest?.sessionId, 'session-1');
  assert.equal(recoveryRequest?.failedViewGeneration, 7);
  assert.equal(recoveryRequest?.requestedViewGeneration, 8);
  assert.equal(parseTerminalCheckpointClientMessage(recoveryRequest).ok, true);
});

test('ACK send failure fails closed and a newer epoch installs a new view generation before recovery', () => {
  const { commands, generations, recovery, runtime, sent } = createHarness(false);
  runtime.setCapability(ACTIVE_CAPABILITY);
  runtime.handleMessage(startMessage());
  runtime.handleMessage(chunkMessage());
  runtime.handleMessage(commitMessage());

  runtime.checkpointApplied({
    ...identity(),
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  });
  assert.equal(commands.at(-1)?.type, 'recovery-failed');
  assert.deepEqual(recovery, ['checkpoint-apply-ack-send-failed']);
  assert.equal(sent.filter(message => message.type === 'terminal-checkpoint:drain-ack').length, 0);
  const recoveryRequest = sent.find(message => message.type === 'terminal-checkpoint:recovery-request');
  assert.equal(recoveryRequest?.requestedViewGeneration, 8);
  assert.equal(parseTerminalCheckpointClientMessage(recoveryRequest).ok, true);

  const fresh = startMessage(identity({
    viewGeneration: 8,
    streamEpoch: '4',
    checkpointEpoch: '1',
    sourceSeq: '20',
    snapshotSeq: '20',
  }));
  runtime.setCapability({
    ...ACTIVE_CAPABILITY,
    registeredViews: [{ sessionId: 'session-1', viewGeneration: 8 }],
  });
  runtime.handleMessage(fresh);
  assert.deepEqual(generations, [8]);
  assert.deepEqual(commands.slice(-2).map(command => command.type), [
    'install-recovery-generation',
    'checkpoint-begin',
  ]);
});

test('stale-generation or wrong-session ingress is rejected without polluting fresh authority', () => {
  const { commands, recovery, runtime } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);

  assert.equal(runtime.handleMessage(startMessage({ sessionId: 'other' })).accepted, false);
  assert.equal(runtime.handleMessage(startMessage({ viewGeneration: 6 })).accepted, false);
  assert.deepEqual(commands.map(command => command.type), []);
  assert.deepEqual(recovery, []);
  assert.equal(runtime.getState().recoveryPending, false);
});

test('production wiring registers the dormant dispatcher and isolates raw xterm mutation construction', () => {
  const context = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const compositionRoot = readFileSync(new URL('../../src/utils/terminalWriteCoordinatorRuntime.ts', import.meta.url), 'utf8');

  assert.match(context, /createTerminalCheckpointDispatcherRegistry\(\)/u);
  assert.match(context, /terminalCheckpointDispatchersRef\.current\s*\.setCapability\(freshCheckpoint\)/u);
  assert.match(context, /terminalCheckpointDispatchersRef\.current\.route\(checkpoint\)/u);
  assert.match(context, /terminalCheckpointDispatchersRef\.current\.failSession\(\s*sessionId,/u);
  assert.match(context, /extractTerminalCheckpointFailureBoundary\(rawMessage\)/u);
  assert.match(context, /isGlobalTerminalCheckpointControlFailure\(rawMessage\)/u);
  assert.match(context, /isGlobalTerminalCheckpointControlFailure\(checkpoint\)/u);
  assert.match(context, /terminalCheckpointDispatchersRef\.current\.failActive\(/u);
  assert.match(context, /if \(routeResult\.handled\)\s*\{\s*return;/u);
  assert.match(context, /type:\s*'terminal-checkpoint:negotiate'/u);
  assert.match(context, /terminalCheckpointDispatchersRef\.current\.listViews\(\)/u);
  assert.match(
    context,
    /refreshTerminalCheckpointRegistration:\s*requestCurrentTerminalCheckpointCapability/u,
    'a runtime generation advance must be able to renegotiate the current dispatcher views',
  );
  assert.match(view, /registerTerminalCheckpointDispatcher\(\s*sessionId,\s*checkpointRuntime/u);
  assert.match(
    view,
    /advanceViewGeneration:[\s\S]*?refreshTerminalCheckpointRegistration\(\)/u,
    'advancing the local recovery generation must publish a fresh checkpoint negotiation',
  );
  assert.match(view, /runtime\.submitInput\(data\)/u);
  assert.match(view, /legacy-output-during-checkpoint-authority/u);
  assert.match(view, /pendingInputMaxBytes:\s*coordinatorInputLimits\.inputQueueMaxBytes/u);
  assert.match(view, /settlementLedgerMaxEntries:\s*coordinatorLimits\.visibleOutputMaxChunks/u);
  assert.doesNotMatch(view, /terminalRawMutationAdapter/u);
  assert.match(compositionRoot, /from '\.\/terminalRawMutationAdapter\.ts'/u);
});

test('MIG-BGSTAB-002 production client pairs split output before same-view renegotiation', () => {
  const context = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');
  assert.match(context, /buildControlWebSocketUrl\([\s\S]*?getWsTransportMode\(\)/u);
  assert.match(context, /buildSplitOutputWebSocketUrl\([\s\S]*?metadata:\s*msg/u);
  assert.match(context, /outputWsRef\.current\s*=\s*output/u);
  assert.match(context, /output\.onmessage\s*=\s*event\s*=>[\s\S]*?handleMessageRef\.current\(event\)/u);
  assert.match(
    context,
    /if \(msg\.channel === 'output'\)[\s\S]*?requestTerminalCheckpointCapability\([\s\S]*?listNegotiatedTerminalCheckpointViews\(\)/u,
    'the paired output connected frame must trigger the current same-view capability negotiation',
  );
  assert.match(
    context,
    /const connectAttemptGeneration\s*=\s*connectAttemptFence\.begin\(\);[\s\S]*?await initializeInputReliabilityMode\(\);[\s\S]*?!connectAttemptFence\.isCurrent\(connectAttemptGeneration\)/u,
    'an async StrictMode predecessor must not create a stale control socket after remount',
  );
});

test('real coordinator lifecycle sends apply then drain ACK before releasing queued input', () => {
  const events: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let coordinator: TerminalWriteCoordinator | null = null;
  const runtime = createTerminalCheckpointRuntime({
    sessionId: 'session-1',
    initialViewGeneration: 7,
    getCoordinator: () => coordinator,
    send: (message) => {
      sent.push(message as unknown as Record<string, unknown>);
      events.push(message.type);
      return { ok: true };
    },
    requestFreshRecovery: reason => events.push(`recovery:${reason}`),
    advanceViewGeneration: generation => events.push(`generation:${generation}`),
  });
  coordinator = createTerminalWriteCoordinator({
    viewGeneration: 7,
    digestBytes: digestTerminalBytes,
    adapter: {
      write: (_command, callback) => callback(),
      resetParser: () => events.push('reset'),
      resize: () => events.push('resize'),
      applyModes: () => events.push('modes'),
      clearScreen: () => {},
      fit: () => ({ cols: 80, rows: 24 }),
      setWindowsPty: () => {},
      checkpointApplied: (metadata) => {
        const result = runtime.checkpointApplied(metadata);
        if (!result.accepted) throw new Error(result.reason);
      },
      checkpointDrained: (metadata) => {
        const result = runtime.checkpointDrained(metadata);
        if (!result.accepted) throw new Error(result.reason);
      },
      markReady: () => events.push('ready'),
      releaseInput: data => events.push(`input:${data}`),
      settleInput: (token, outcome) => events.push(`input-settlement:${token}:${outcome}`),
      requestFreshRecovery: reason => events.push(`adapter-recovery:${reason}`),
      requestRuntimeRecreation: reason => events.push(`recreate:${reason}`),
      compatibilityRecoveryDrained: generation => events.push(`legacy-drained:${generation}`),
      settle: () => {},
    },
    timeoutMs: 100,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
    pendingInputMaxBytes: 1024,
    pendingInputMaxCount: 16,
    pendingInputTtlMs: 1000,
    settlementLedgerMaxEntries: 16,
    settlementLedgerTtlMs: 1000,
  });
  runtime.setCapability(ACTIVE_CAPABILITY);
  const transactionIdentity = identity({ sourceSeq: '10' });
  runtime.handleMessage(startMessage(transactionIdentity));
  runtime.submitInput('queued');
  runtime.handleMessage(chunkMessage(transactionIdentity));
  runtime.handleMessage(commitMessage(transactionIdentity));

  assert.deepEqual(sent.map(message => message.type), [
    'terminal-checkpoint:apply-ack',
    'terminal-checkpoint:drain-ack',
  ]);
  assert.ok(events.indexOf('terminal-checkpoint:apply-ack') < events.indexOf('terminal-checkpoint:drain-ack'));
  assert.ok(events.indexOf('terminal-checkpoint:drain-ack') < events.indexOf('ready'));
  assert.ok(events.indexOf('ready') < events.indexOf('input:queued'));
  assert.equal(coordinator.getState().ready, true);

  assert.equal(runtime.handleMessage({
    type: 'terminal-checkpoint:output',
    ...identity({ sourceSeq: '13' }),
    encoding: 'base64',
    data: 'dGFpbA==',
    encodedBytes: 4,
  }).accepted, true);
  assert.deepEqual(
    sent.filter(message => message.type === 'terminal-checkpoint:drain-ack')
      .map(message => message.drainedThroughSeq),
    ['10', '13'],
    'a live tail that drains after initial readiness must advance the cumulative drain ACK',
  );
});

test('REL-BGSTAB-012 blocks ready and input until matching checkpoint drain ACK', () => {
  const signature = 'REL-BGSTAB-012 AC-6: only the matching apply and drain ACK release readiness and input; a mismatch converges to a fresh checkpoint';
  const { commands, runtime, sent } = createHarness();
  runtime.setCapability(ACTIVE_CAPABILITY);
  const transactionIdentity = identity({ sourceSeq: '10' });

  assert.equal(runtime.handleMessage(startMessage(transactionIdentity)).accepted, true, signature);
  assert.equal(runtime.submitInput('queued-before-drain').accepted, true, signature);
  assert.equal(runtime.handleMessage(chunkMessage(transactionIdentity)).accepted, true, signature);
  assert.equal(runtime.handleMessage(commitMessage(transactionIdentity)).accepted, true, signature);

  assert.equal(
    commands.filter(command => command.type === 'queue-input').length,
    1,
    signature,
  );
  assert.deepEqual(
    sent.filter(message => (
      message.type === 'terminal-checkpoint:apply-ack'
      || message.type === 'terminal-checkpoint:drain-ack'
    )),
    [],
    signature,
  );
  assert.equal(
    (runtime.getState() as unknown as { readyBarrier?: unknown }).readyBarrier,
    'matching-checkpoint-drain-ack',
    signature,
  );

  const lifecycle = {
    ...transactionIdentity,
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };
  assert.deepEqual(runtime.checkpointDrained({
    ...lifecycle,
    checkpointEpoch: 'stale-checkpoint-epoch',
  }), {
    accepted: false,
    reason: 'checkpoint-identity-mismatch',
  }, signature);
  assert.equal((runtime.getState() as unknown as { ready?: unknown }).ready, false, signature);
  assert.deepEqual(runtime.checkpointApplied(lifecycle), { accepted: true }, signature);
  assert.equal((runtime.getState() as unknown as { ready?: unknown }).ready, false, signature);
  assert.deepEqual(runtime.checkpointDrained(lifecycle), { accepted: true }, signature);
  assert.equal((runtime.getState() as unknown as { ready?: unknown }).ready, true, signature);
  const runCoordinatorDrain = (drainIdentity: 'matching' | 'mismatched') => {
    const releases: string[] = [];
    const coordinatorRecoveries: string[] = [];
    const lifecycleSent: Array<Record<string, unknown>> = [];
    let coordinatedRuntime: ReturnType<typeof createTerminalCheckpointRuntime> | null = null;
    let coordinator: TerminalWriteCoordinator | null = null;
    coordinatedRuntime = createTerminalCheckpointRuntime({
      sessionId: 'session-1',
      initialViewGeneration: 7,
      getCoordinator: () => coordinator,
      send: message => {
        lifecycleSent.push(message as unknown as Record<string, unknown>);
        return { ok: true };
      },
      requestFreshRecovery: () => {},
      advanceViewGeneration: () => {},
    });
    coordinator = createTerminalWriteCoordinator({
      viewGeneration: 7,
      digestBytes: digestTerminalBytes,
      adapter: {
        write: (_command, callback) => callback(),
        resetParser: () => {},
        resize: () => {},
        applyModes: () => {},
        clearScreen: () => {},
        fit: () => ({ cols: 80, rows: 24 }),
        setWindowsPty: () => {},
        checkpointApplied: metadata => {
          const result = coordinatedRuntime?.checkpointApplied(metadata);
          if (!result?.accepted) throw new Error(result?.reason);
        },
        checkpointDrained: metadata => {
          const result = coordinatedRuntime?.checkpointDrained(
            drainIdentity === 'matching'
              ? metadata
              : { ...metadata, checkpointEpoch: 'stale-checkpoint-epoch' },
          );
          if (!result?.accepted) throw new Error(result?.reason);
        },
        markReady: () => {},
        releaseInput: data => releases.push(data),
        settleInput: () => {},
        requestFreshRecovery: reason => coordinatorRecoveries.push(reason),
        requestRuntimeRecreation: () => {},
        compatibilityRecoveryDrained: () => {},
        settle: () => {},
      },
      timeoutMs: 100,
      postCheckpointMaxBytes: 1024,
      postCheckpointMaxChunks: 16,
      pendingInputMaxBytes: 1024,
      pendingInputMaxCount: 16,
      pendingInputTtlMs: 1000,
      settlementLedgerMaxEntries: 16,
      settlementLedgerTtlMs: 1000,
    });
    coordinatedRuntime.setCapability(ACTIVE_CAPABILITY);
    assert.equal(coordinatedRuntime.handleMessage(startMessage(transactionIdentity)).accepted, true, signature);
    assert.equal(coordinatedRuntime.submitInput('queued-before-drain-a').accepted, true, signature);
    assert.equal(coordinatedRuntime.submitInput('queued-before-drain-b').accepted, true, signature);
    assert.equal(coordinatedRuntime.handleMessage(chunkMessage(transactionIdentity)).accepted, true, signature);
    assert.equal(coordinatedRuntime.handleMessage(commitMessage(transactionIdentity)).accepted, true, signature);
    return { coordinator, coordinatorRecoveries, lifecycleSent, releases, runtime: coordinatedRuntime };
  };

  const mismatchedDrain = runCoordinatorDrain('mismatched');
  assert.equal(mismatchedDrain.coordinator.getState().ready, false, signature);
  assert.equal(mismatchedDrain.runtime.getState().ready, false, signature);
  assert.deepEqual(mismatchedDrain.releases, [], signature);
  assert.deepEqual(mismatchedDrain.lifecycleSent.map(message => message.type), [
    'terminal-checkpoint:apply-ack',
  ], signature);
  assert.deepEqual(mismatchedDrain.coordinatorRecoveries, [
    'checkpoint-drained-callback-failed',
  ], signature);

  const matchingDrain = runCoordinatorDrain('matching');
  assert.equal(matchingDrain.coordinator.getState().ready, true, signature);
  assert.equal(matchingDrain.runtime.getState().ready, true, signature);
  assert.deepEqual(matchingDrain.lifecycleSent.map(message => message.type), [
    'terminal-checkpoint:apply-ack',
    'terminal-checkpoint:drain-ack',
  ], signature);
  assert.deepEqual(matchingDrain.releases, [
    'queued-before-drain-a',
    'queued-before-drain-b',
  ], signature);

  const failureHarness = createHarness();
  failureHarness.runtime.setCapability(ACTIVE_CAPABILITY);
  assert.equal(failureHarness.runtime.handleMessage(startMessage(transactionIdentity)).accepted, true, signature);
  assert.deepEqual(failureHarness.runtime.coordinatorRecoveryFailed('checkpoint-drain-ack-mismatch', {
    ...lifecycle,
    checkpointEpoch: 'stale-checkpoint-epoch',
  }), { accepted: true }, signature);
  assert.equal(failureHarness.runtime.getState().recoveryPending, true, signature);
  assert.equal(
    failureHarness.sent.some(message => (
      message.type === 'terminal-checkpoint:recovery-request'
      && message.reason === 'drain-failed'
      && message.requestedViewGeneration === 8
    )),
    true,
    signature,
  );
  assert.deepEqual(failureHarness.recovery, ['checkpoint-drain-ack-mismatch'], signature);
  assert.deepEqual(failureHarness.runtime.submitInput('blocked-after-drain-failure'), {
    accepted: false,
    reason: 'checkpoint-recovery-pending',
  }, signature);
});

test('real active-to-passive rollback settles input and admits a fresh legacy snapshot stream', () => {
  const events: string[] = [];
  const physicalWrites: Array<() => void> = [];
  const authorityStates: string[] = [];
  const inputSettlements: Array<{ token: string; outcome: string }> = [];
  let coordinator: TerminalWriteCoordinator | null = null;
  const runtime = createTerminalCheckpointRuntime({
    sessionId: 'session-1',
    initialViewGeneration: 7,
    getCoordinator: () => coordinator,
    send: () => ({ ok: true }),
    requestFreshRecovery: reason => events.push(`recovery:${reason}`),
    advanceViewGeneration: generation => events.push(`generation:${generation}`),
    onAuthorityStateChange: state => authorityStates.push(state),
  });
  coordinator = createTerminalWriteCoordinator({
    viewGeneration: 7,
    digestBytes: digestTerminalBytes,
    adapter: {
      write: (command, callback) => {
        events.push(command.kind);
        physicalWrites.push(callback);
      },
      resetParser: () => events.push('reset'),
      resize: () => {},
      applyModes: () => {},
      clearScreen: () => {},
      fit: () => ({ cols: 80, rows: 24 }),
      setWindowsPty: () => {},
      checkpointApplied: () => {},
      checkpointDrained: () => {},
      markReady: () => {},
      releaseInput: () => events.push('forbidden-input-release'),
      settleInput: (token, outcome) => inputSettlements.push({ token, outcome }),
      requestFreshRecovery: reason => runtime.coordinatorRecoveryFailed(reason),
      requestRuntimeRecreation: reason => events.push(`recreate:${reason}`),
      compatibilityRecoveryDrained: generation => events.push(`legacy-drained:${generation}`),
      settle: () => {},
    },
    timeoutMs: 100,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
    pendingInputMaxBytes: 1024,
    pendingInputMaxCount: 16,
    pendingInputTtlMs: 1000,
    settlementLedgerMaxEntries: 16,
    settlementLedgerTtlMs: 1000,
  });
  runtime.setCapability(ACTIVE_CAPABILITY);
  assert.equal(runtime.handleMessage(startMessage()).accepted, true);
  assert.equal(runtime.submitInput('never-log-or-release-this').accepted, true);

  assert.equal(runtime.setCapability(PASSIVE_CAPABILITY).accepted, true);
  assert.equal(runtime.getState().recoveryPending, false);
  assert.equal(runtime.getState().legacyRecoveryPending, true);
  assert.equal(coordinator.getState().recoveryRequired, false);
  assert.equal(coordinator.getState().compatibilityRecoveryPending, true);
  assert.deepEqual(runtime.submitInput('must-remain-blocked'), {
    accepted: false,
    reason: 'legacy-recovery-pending',
  });
  assert.deepEqual(inputSettlements, [{
    token: 'session-1:7:input:1',
    outcome: 'superseded',
  }]);
  assert.equal(JSON.stringify(inputSettlements).includes('never-log-or-release-this'), false);

  assert.equal(coordinator.submitCompatibility({ type: 'reset', viewGeneration: 8 }).accepted, true);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'repair', data: 'legacy-snapshot',
  }).accepted, true);
  assert.equal(coordinator.submitCompatibility({
    type: 'write', viewGeneration: 8, kind: 'live', data: 'post-snapshot-output',
  }).accepted, true);
  assert.equal(runtime.getState().legacyRecoveryPending, true, 'input barrier opened before physical drain completion');
  assert.deepEqual(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }), {
    accepted: false,
    reason: 'compatibility-recovery-drain-pending',
  });
  physicalWrites.shift()?.();
  physicalWrites.shift()?.();
  assert.equal(runtime.completeLegacyRecovery({ source: 'compatibility-snapshot' }).accepted, true);
  assert.equal(runtime.getState().legacyRecoveryPending, false);
  assert.deepEqual(events, [
    'generation:8',
    'recovery:checkpoint-capability-deactivated',
    'reset',
    'repair',
    'live',
    'legacy-drained:8',
  ]);
  assert.deepEqual(authorityStates, [
    'checkpoint-pending',
    'checkpoint-pending',
    'legacy-recovery-pending',
    'legacy',
  ]);
});

interface TerminalResponderBoundaryIdentity {
  sessionId: string;
  connectionId: string;
  viewGeneration: number;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  responderLeaseId: string;
  boundarySourceSeq: string;
}

interface TerminalCompatibilityDrainIdentity extends TerminalResponderBoundaryIdentity {
  checkpointEpoch: string;
  drainedThroughSourceSeq: string;
  checkpointApplied: true;
  postSnapshotTailDrained: true;
}

interface TerminalLegacyResponderSelectionIdentity extends TerminalCompatibilityDrainIdentity {
  driverLeaseId: string;
  driverLeaseGeneration: string;
  acceptedViewAttributesGeneration: string;
  queryReplyCapability: 'terminal.query-reply-input.v1';
  parserResponderCapability: 'terminal.parser-responder-disable.v1';
  snapshotSeq: string;
}

interface TerminalLegacyResponderEnabledMessage extends TerminalLegacyResponderSelectionIdentity {
  type: 'terminal-authority:legacy-responder-enabled';
  affectedViewCount: number;
}

interface TerminalResponderHandoffResult {
  accepted: boolean;
  reason?: string;
  promotionAbortRequired?: boolean;
  compatibilityDrainIdentity?: TerminalCompatibilityDrainIdentity;
}

interface TerminalResponderHandoffRuntime {
  readonly lifecycleGeneration: number;
  disableLegacyParserRepliesAtBoundary(
    identity: TerminalResponderBoundaryIdentity,
  ): Promise<TerminalResponderHandoffResult>;
  restoreLegacyParserRepliesAfterCompatibilityDrain(
    identity: TerminalCompatibilityDrainIdentity,
  ): Promise<TerminalResponderHandoffResult>;
  applyLegacyResponderEnabled(
    identity: TerminalLegacyResponderSelectionIdentity,
  ): TerminalResponderHandoffResult;
  handleLegacyParserQueryBroadcast(input: {
    sessionId: string;
    driverLeaseId: string;
    driverLeaseGeneration: string;
    data: string;
  }): Readonly<{
    identity: TerminalLegacyResponderSelectionIdentity;
    replies: readonly string[];
  }>;
  dispose(reason: 'runtime-replaced'): void;
  submitUserInput(input: {
    data: string;
    kind: 'key' | 'paste' | 'ime' | 'mouse';
  }): TerminalResponderHandoffResult;
  getState(): {
    legacyParserRepliesEnabled: boolean;
    promotionAbortRequired: boolean;
    compatibilityDrainCompleted: boolean;
  };
}

interface ImmediateControlSendSuccess {
  ok: true;
  controlSocketId: string;
  enqueueOrdinal: number;
}

interface ImmediateControlSendFailure {
  ok: false;
  reason: string;
  queued?: boolean;
  controlSocketId: string;
}

interface TerminalResponderEnableRouteResult extends TerminalResponderHandoffResult {
  completedViewQuorum: boolean;
  matchedViewCount: number;
}

interface TerminalLegacyQueryBroadcastResult {
  deliveries: readonly Readonly<{
    connectionId: string;
    viewGeneration: number;
    replyCount: number;
  }>[];
  replyCount: number;
  serverAcceptedReplyCount: number;
  ptyEffectCount: number;
}

interface TerminalResponderHandoffDispatcher {
  register(
    identity: TerminalCompatibilityDrainIdentity,
    runtime: TerminalResponderHandoffRuntime,
  ): () => void;
  route(message: TerminalLegacyResponderEnabledMessage): TerminalResponderEnableRouteResult;
  broadcastLegacyParserQuery(input: {
    query: Readonly<{
      sessionId: string;
      driverLeaseId: string;
      driverLeaseGeneration: string;
      data: string;
    }>;
    acceptReply: (reply: Readonly<{
      identity: TerminalLegacyResponderSelectionIdentity;
      data: string;
      replyOrdinal: number;
    }>) => Readonly<{ accepted: boolean; ptyEffectApplied: boolean }>;
  }): TerminalLegacyQueryBroadcastResult;
}

interface TerminalResponderHandoffWireContract {
  parseTerminalResponderHandoffServerMessage(value: unknown):
    | Readonly<{ ok: true; message: TerminalLegacyResponderEnabledMessage }>
    | Readonly<{ ok: false; reason: string }>;
}

interface TerminalResponderHandoffContract {
  createTerminalResponderHandoffRuntime(options: {
    identity: TerminalResponderBoundaryIdentity;
    lifecycleGeneration: number;
    legacyParserRepliesInitiallyEnabled: boolean;
    awaitOutputIdleWithFifoProbe: (
      identity: TerminalResponderBoundaryIdentity,
    ) => Promise<boolean>;
    awaitCompatibilityDrain: (
      identity: TerminalCompatibilityDrainIdentity,
    ) => Promise<boolean>;
    flushPendingQueryRepliesImmediately: (
      identity: TerminalResponderBoundaryIdentity,
    ) => Promise<Readonly<ImmediateControlSendSuccess | ImmediateControlSendFailure>>
      | Readonly<ImmediateControlSendSuccess | ImmediateControlSendFailure>;
    setLegacyParserRepliesEnabled: (enabled: boolean) => void;
    sendResponderControl: (input: {
      message: Readonly<Record<string, unknown>>;
      expectedControlSocketId: string;
      afterEnqueueOrdinal: number;
    }) => Readonly<ImmediateControlSendSuccess | ImmediateControlSendFailure>;
    onPromotionAbortRequired: (reason: string) => void;
    onRecoveryRestartRequired?: (reason: 'runtime-replaced') => void;
    resolveLegacyParserQueryReplies?: (data: string) => readonly string[];
    forwardUserInput: (input: {
      data: string;
      kind: 'key' | 'paste' | 'ime' | 'mouse';
    }) => void;
  }): TerminalResponderHandoffRuntime;
  createTerminalResponderHandoffDispatcher(options: {
    readSelectedLegacyResponderIdentity: () => TerminalLegacyResponderSelectionIdentity | null;
  }): TerminalResponderHandoffDispatcher;
}

const PROMOTION_BROWSER_IDENTITY: TerminalResponderBoundaryIdentity = Object.freeze({
  sessionId: 'session-1',
  connectionId: 'connection-a',
  viewGeneration: 7,
  transitionEpoch: '8',
  authorityEpoch: 'authority-7',
  streamEpoch: '8',
  responderLeaseId: 'responder-browser-7',
  boundarySourceSeq: '41',
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createDeferredBoolean() {
  return createDeferred<boolean>();
}

test('terminalCheckpointRuntime promotion disables parser replies before positional disable ACK while preserving user input', async () => {
  const signature =
    'MIG-BGSTAB-002 AC-2 positional parser disable barrier 계약 부재 때문에 실패';
  const createHandoffRuntime = (
    terminalCheckpointRuntimeModule as unknown as Partial<TerminalResponderHandoffContract>
  ).createTerminalResponderHandoffRuntime;
  assert.equal(typeof createHandoffRuntime, 'function', signature);
  if (!createHandoffRuntime) return;

  const events: string[] = [];
  const responderControls: Array<Readonly<Record<string, unknown>>> = [];
  const forwardedUserInputs: Array<{ data: string; kind: string }> = [];
  const fifoDrain = createDeferredBoolean();
  const runtime = createHandoffRuntime({
    identity: PROMOTION_BROWSER_IDENTITY,
    lifecycleGeneration: 1,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: async () => {
      events.push('scheduler-and-xterm-fifo-probe-started');
      const drained = await fifoDrain.promise;
      if (drained) events.push('scheduler-and-xterm-fifo-drained');
      return drained;
    },
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => {
      events.push('query-reply-immediate-send-succeeded');
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 10 };
    },
    setLegacyParserRepliesEnabled: enabled => {
      events.push(enabled ? 'parser-replies-enabled' : 'parser-replies-disabled');
    },
    sendResponderControl: input => {
      const { message } = input;
      assert.equal(input.expectedControlSocketId, 'control-socket-a');
      assert.equal(input.afterEnqueueOrdinal, 10);
      responderControls.push(message);
      events.push(String(message.type));
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 11 };
    },
    onPromotionAbortRequired: reason => events.push(`promotion-abort:${reason}`),
    forwardUserInput: input => {
      forwardedUserInputs.push(input);
      events.push(`user:${input.kind}`);
    },
  });

  const disabling = runtime.disableLegacyParserRepliesAtBoundary(PROMOTION_BROWSER_IDENTITY);
  await Promise.resolve();
  assert.equal(runtime.getState().legacyParserRepliesEnabled, true, signature);
  assert.equal(events.includes('terminal-authority:responder-disabled'), false, signature);

  for (const input of [
    { data: 'k', kind: 'key' },
    { data: 'paste', kind: 'paste' },
    { data: '한', kind: 'ime' },
    { data: '\x1b[<0;10;5M', kind: 'mouse' },
  ] as const) {
    assert.equal(runtime.submitUserInput(input).accepted, true, signature);
  }
  assert.deepEqual(forwardedUserInputs.map(input => input.kind), [
    'key', 'paste', 'ime', 'mouse',
  ], signature);

  fifoDrain.resolve(true);
  assert.equal((await disabling).accepted, true, signature);
  assert.equal(runtime.getState().legacyParserRepliesEnabled, false, signature);
  assert.deepEqual(responderControls, [{
    type: 'terminal-authority:responder-disabled',
    ...PROMOTION_BROWSER_IDENTITY,
  }], 'disable ACK must carry the full frozen responder/boundary identity');
  assert.ok(
    events.indexOf('scheduler-and-xterm-fifo-drained')
      < events.indexOf('query-reply-immediate-send-succeeded'),
    signature,
  );
  assert.ok(
    events.indexOf('query-reply-immediate-send-succeeded')
      < events.indexOf('parser-replies-disabled'),
    signature,
  );
  assert.ok(
    events.indexOf('parser-replies-disabled')
      < events.indexOf('terminal-authority:responder-disabled'),
    signature,
  );

  const staleAckCount = events.filter(
    event => event === 'terminal-authority:responder-disabled',
  ).length;
  const stale = await runtime.disableLegacyParserRepliesAtBoundary({
    ...PROMOTION_BROWSER_IDENTITY,
    viewGeneration: PROMOTION_BROWSER_IDENTITY.viewGeneration - 1,
  });
  assert.equal(stale.accepted, false, signature);
  assert.equal(
    events.filter(event => event === 'terminal-authority:responder-disabled').length,
    staleAckCount,
    signature,
  );

  const failedEvents: string[] = [];
  const failedRuntime = createHandoffRuntime({
    identity: PROMOTION_BROWSER_IDENTITY,
    lifecycleGeneration: 2,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => {
      failedEvents.push('query-reply-immediate-send-queued');
      return { ok: false, reason: 'query-reply-send-queued', queued: true, controlSocketId: 'control-socket-a' };
    },
    setLegacyParserRepliesEnabled: enabled => failedEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      failedEvents.push(String(message.type));
      return { ok: false, reason: 'control-send-queued', queued: true, controlSocketId: 'control-socket-a' };
    },
    onPromotionAbortRequired: reason => failedEvents.push(`promotion-abort:${reason}`),
    forwardUserInput: () => {},
  });
  const failed = await failedRuntime.disableLegacyParserRepliesAtBoundary(
    PROMOTION_BROWSER_IDENTITY,
  );
  assert.equal(failed.accepted, false, signature);
  assert.equal(failedEvents.includes('terminal-authority:responder-disabled'), false, signature);
  assert.equal(failedRuntime.getState().legacyParserRepliesEnabled, true, signature);
  assert.deepEqual(failedEvents, [
    'query-reply-immediate-send-queued',
    'promotion-abort:query-reply-send-queued',
  ], signature);
  assert.equal(failedRuntime.getState().promotionAbortRequired, true, signature);

  const flushFailedEvents: string[] = [];
  const flushFailedRuntime = createHandoffRuntime({
    identity: PROMOTION_BROWSER_IDENTITY,
    lifecycleGeneration: 3,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => ({
      ok: false,
      reason: 'query-reply-send-failed',
      controlSocketId: 'control-socket-a',
    }),
    setLegacyParserRepliesEnabled: enabled => flushFailedEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      flushFailedEvents.push(String(message.type));
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 21 };
    },
    onPromotionAbortRequired: reason => flushFailedEvents.push(`promotion-abort:${reason}`),
    forwardUserInput: () => {},
  });
  assert.equal((await flushFailedRuntime.disableLegacyParserRepliesAtBoundary(PROMOTION_BROWSER_IDENTITY)).accepted, false);
  assert.deepEqual(flushFailedEvents, ['promotion-abort:query-reply-send-failed']);
  assert.equal(flushFailedRuntime.getState().promotionAbortRequired, true);

  for (const [label, plannedControlSocketId, plannedEnqueueOrdinal, expectedReason] of [
    [
      'control socket mismatch',
      'control-socket-b',
      41,
      'responder-control-socket-mismatch',
    ],
    [
      'enqueue ordinal regression',
      'control-socket-a',
      39,
      'responder-control-enqueue-order-regression',
    ],
  ] as const) {
    const mismatchEvents: string[] = [];
    let atomicPrimitiveInvocations = 0;
    let underlyingControlSendSideEffects = 0;
    const mismatchRuntime = createHandoffRuntime({
      identity: PROMOTION_BROWSER_IDENTITY,
      lifecycleGeneration: 4,
      legacyParserRepliesInitiallyEnabled: true,
      awaitOutputIdleWithFifoProbe: async () => true,
      awaitCompatibilityDrain: async () => true,
      flushPendingQueryRepliesImmediately: () => ({
        ok: true,
        controlSocketId: 'control-socket-a',
        enqueueOrdinal: 40,
      }),
      setLegacyParserRepliesEnabled: enabled => mismatchEvents.push(`parser:${enabled}`),
      sendResponderControl: input => {
        atomicPrimitiveInvocations += 1;
        assert.equal(input.expectedControlSocketId, 'control-socket-a', label);
        assert.equal(input.afterEnqueueOrdinal, 40, label);
        if (plannedControlSocketId !== input.expectedControlSocketId) {
          return {
            ok: false,
            reason: 'responder-control-socket-mismatch',
            controlSocketId: plannedControlSocketId,
          };
        }
        if (plannedEnqueueOrdinal <= input.afterEnqueueOrdinal) {
          return {
            ok: false,
            reason: 'responder-control-enqueue-order-regression',
            controlSocketId: plannedControlSocketId,
          };
        }
        underlyingControlSendSideEffects += 1;
        return {
          ok: true,
          controlSocketId: plannedControlSocketId,
          enqueueOrdinal: plannedEnqueueOrdinal,
        };
      },
      onPromotionAbortRequired: reason => mismatchEvents.push(`promotion-abort:${reason}`),
      forwardUserInput: () => {},
    });
    const mismatch = await mismatchRuntime.disableLegacyParserRepliesAtBoundary(PROMOTION_BROWSER_IDENTITY);
    assert.equal(mismatch.accepted, false, label);
    assert.equal(mismatch.promotionAbortRequired, true, label);
    assert.equal(mismatch.reason, expectedReason, label);
    assert.equal(mismatchRuntime.getState().legacyParserRepliesEnabled, false, label);
    assert.equal(mismatchRuntime.getState().promotionAbortRequired, true, label);
    assert.equal(mismatchEvents.some(event => event.startsWith('promotion-abort:')), true, label);
    assert.equal(atomicPrimitiveInvocations, 1, label);
    assert.equal(
      underlyingControlSendSideEffects,
      0,
      `${label} must fail before the atomic primitive writes the disable ACK`,
    );
  }

  for (const invalidEnqueueOrdinal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let invalidFlushAckSendInvocations = 0;
    const invalidFlushReceiptRuntime = createHandoffRuntime({
      identity: PROMOTION_BROWSER_IDENTITY,
      lifecycleGeneration: 6,
      legacyParserRepliesInitiallyEnabled: true,
      awaitOutputIdleWithFifoProbe: async () => true,
      awaitCompatibilityDrain: async () => true,
      flushPendingQueryRepliesImmediately: () => ({
        ok: true,
        controlSocketId: 'control-socket-a',
        enqueueOrdinal: invalidEnqueueOrdinal,
      }),
      setLegacyParserRepliesEnabled: () => {},
      sendResponderControl: () => {
        invalidFlushAckSendInvocations += 1;
        return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 100 };
      },
      onPromotionAbortRequired: () => {},
      forwardUserInput: () => {},
    });
    const invalidFlushReceipt = await invalidFlushReceiptRuntime
      .disableLegacyParserRepliesAtBoundary(PROMOTION_BROWSER_IDENTITY);
    assert.deepEqual(invalidFlushReceipt, {
      accepted: false,
      reason: 'query-reply-flush-invalid-enqueue-ordinal',
      promotionAbortRequired: true,
    }, 'a query-reply flush receipt ordinal must be a non-negative safe integer');
    assert.equal(invalidFlushAckSendInvocations, 0);
    assert.equal(invalidFlushReceiptRuntime.getState().legacyParserRepliesEnabled, true);

    const invalidAckReceiptRuntime = createHandoffRuntime({
      identity: PROMOTION_BROWSER_IDENTITY,
      lifecycleGeneration: 7,
      legacyParserRepliesInitiallyEnabled: true,
      awaitOutputIdleWithFifoProbe: async () => true,
      awaitCompatibilityDrain: async () => true,
      flushPendingQueryRepliesImmediately: () => ({
        ok: true,
        controlSocketId: 'control-socket-a',
        enqueueOrdinal: 90,
      }),
      setLegacyParserRepliesEnabled: () => {},
      sendResponderControl: input => {
        assert.equal(input.expectedControlSocketId, 'control-socket-a');
        assert.equal(input.afterEnqueueOrdinal, 90);
        return {
          ok: true,
          controlSocketId: input.expectedControlSocketId,
          enqueueOrdinal: invalidEnqueueOrdinal,
        };
      },
      onPromotionAbortRequired: () => {},
      forwardUserInput: () => {},
    });
    const invalidAckReceipt = await invalidAckReceiptRuntime
      .disableLegacyParserRepliesAtBoundary(PROMOTION_BROWSER_IDENTITY);
    assert.deepEqual(invalidAckReceipt, {
      accepted: false,
      reason: 'responder-control-invalid-enqueue-ordinal',
      promotionAbortRequired: true,
    }, 'a responder-control send receipt ordinal must be a non-negative safe integer');
  }

  const ackFailureEvents: string[] = [];
  const ackFailureRuntime = createHandoffRuntime({
    identity: PROMOTION_BROWSER_IDENTITY,
    lifecycleGeneration: 5,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => {
      ackFailureEvents.push('query:control-socket-a:20');
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 20 };
    },
    setLegacyParserRepliesEnabled: enabled => ackFailureEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      ackFailureEvents.push(`ack:${String(message.type)}:control-socket-a`);
      return { ok: false, reason: 'disable-ack-send-queued', queued: true, controlSocketId: 'control-socket-a' };
    },
    onPromotionAbortRequired: reason => ackFailureEvents.push(`promotion-abort:${reason}`),
    forwardUserInput: () => {},
  });
  const ackFailure = await ackFailureRuntime.disableLegacyParserRepliesAtBoundary(
    PROMOTION_BROWSER_IDENTITY,
  );
  assert.deepEqual(ackFailure, {
    accepted: false,
    reason: 'disable-ack-send-queued',
    promotionAbortRequired: true,
  }, signature);
  assert.deepEqual(ackFailureEvents, [
    'query:control-socket-a:20',
    'parser:false',
    'ack:terminal-authority:responder-disabled:control-socket-a',
    'promotion-abort:disable-ack-send-queued',
  ], 'query replies must enter the same control socket before ACK and ACK queueing must abort');
  assert.equal(ackFailureRuntime.getState().legacyParserRepliesEnabled, false, 'ordered compatibility recovery owns re-enable after ACK failure');
  assert.equal(ackFailureRuntime.getState().promotionAbortRequired, true, signature);

  const cancelledDrain = createDeferredBoolean();
  const cancelledEvents: string[] = [];
  const cancelledControls: Array<Readonly<Record<string, unknown>>> = [];
  const cancelledRuntime = createHandoffRuntime({
    identity: PROMOTION_BROWSER_IDENTITY,
    lifecycleGeneration: 10,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: () => cancelledDrain.promise,
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 50,
    }),
    setLegacyParserRepliesEnabled: enabled => cancelledEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      cancelledControls.push(message);
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 51 };
    },
    onPromotionAbortRequired: reason => cancelledEvents.push(`promotion-abort:${reason}`),
    onRecoveryRestartRequired: reason => cancelledEvents.push(`recovery-restart:${reason}`),
    forwardUserInput: () => {},
  });
  const createReplacementRuntime = () => createHandoffRuntime({
    identity: { ...PROMOTION_BROWSER_IDENTITY, viewGeneration: 8 },
    lifecycleGeneration: 11,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 60,
    }),
    setLegacyParserRepliesEnabled: () => {},
    sendResponderControl: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 61,
    }),
    onPromotionAbortRequired: () => {},
    forwardUserInput: () => {},
  });
  assert.equal(cancelledRuntime.lifecycleGeneration, 10, signature);
  const cancelledDisable = cancelledRuntime.disableLegacyParserRepliesAtBoundary(
    PROMOTION_BROWSER_IDENTITY,
  );
  await Promise.resolve();
  const replacementRuntime = createReplacementRuntime();
  assert.equal(replacementRuntime.lifecycleGeneration, 11, signature);
  cancelledRuntime.dispose('runtime-replaced');
  cancelledDrain.resolve(true);
  assert.deepEqual(await cancelledDisable, {
    accepted: false,
    reason: 'runtime-disposed',
  }, 'a replaced runtime must cancel an in-flight disable barrier');
  assert.deepEqual(cancelledEvents, [
    'recovery-restart:runtime-replaced',
  ], 'replacement may request recovery restart but cannot mutate the parser or emit abort ACKs');
  assert.deepEqual(cancelledControls, [], 'a disposed generation cannot emit a stale disable ACK');

  const pendingFlush = createDeferred<
    Readonly<ImmediateControlSendSuccess | ImmediateControlSendFailure>
  >();
  const pendingFlushEvents: string[] = [];
  let pendingFlushParserMutations = 0;
  let pendingFlushControlSendInvocations = 0;
  const pendingFlushRuntime = createHandoffRuntime({
    identity: PROMOTION_BROWSER_IDENTITY,
    lifecycleGeneration: 12,
    legacyParserRepliesInitiallyEnabled: true,
    awaitOutputIdleWithFifoProbe: async () => {
      pendingFlushEvents.push('fifo-end');
      return true;
    },
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => {
      pendingFlushEvents.push('async-query-flush-pending');
      return pendingFlush.promise;
    },
    setLegacyParserRepliesEnabled: () => {
      pendingFlushParserMutations += 1;
    },
    sendResponderControl: () => {
      pendingFlushControlSendInvocations += 1;
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 121 };
    },
    onPromotionAbortRequired: reason => pendingFlushEvents.push(`promotion-abort:${reason}`),
    onRecoveryRestartRequired: reason => pendingFlushEvents.push(`recovery-restart:${reason}`),
    forwardUserInput: () => {},
  });
  const pendingFlushDisable = pendingFlushRuntime.disableLegacyParserRepliesAtBoundary(
    PROMOTION_BROWSER_IDENTITY,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    pendingFlushEvents,
    ['fifo-end', 'async-query-flush-pending'],
    'the disposal race must be parked after FIFO completion inside the async query flush',
  );
  pendingFlushRuntime.dispose('runtime-replaced');
  pendingFlushRuntime.dispose('runtime-replaced');
  pendingFlush.resolve({ ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 120 });
  assert.deepEqual(await pendingFlushDisable, {
    accepted: false,
    reason: 'runtime-disposed',
  }, 'late async flush resolution must not resume a disposed handoff generation');
  assert.equal(pendingFlushParserMutations, 0);
  assert.equal(pendingFlushControlSendInvocations, 0);
  assert.deepEqual(pendingFlushEvents, [
    'fifo-end',
    'async-query-flush-pending',
    'recovery-restart:runtime-replaced',
  ], 'dispose must request exactly one recovery restart and suppress all late side effects');
});

test('terminalCheckpointRuntime rollback enables legacy parser replies only after fresh compatibility drain', async () => {
  const signature =
    'MIG-BGSTAB-002 AC-5 compatibility drain responder restore 계약 부재 때문에 실패';
  const handoffContract = (
    terminalCheckpointRuntimeModule as unknown as Partial<TerminalResponderHandoffContract>
  );
  const parseResponderHandoff = (
    wsProtocolModule as unknown as Partial<TerminalResponderHandoffWireContract>
  ).parseTerminalResponderHandoffServerMessage;
  const createHandoffRuntime = handoffContract.createTerminalResponderHandoffRuntime;
  const createHandoffDispatcher = handoffContract.createTerminalResponderHandoffDispatcher;
  assert.equal(
    typeof parseResponderHandoff,
    'function',
    'MIG-BGSTAB-002 AC-5 typed legacy-responder-enabled protocol parser missing',
  );
  assert.equal(typeof createHandoffRuntime, 'function', signature);
  assert.equal(
    typeof createHandoffDispatcher,
    'function',
    'MIG-BGSTAB-002 AC-5 typed legacy-responder-enabled dispatcher contract missing',
  );
  if (!parseResponderHandoff || !createHandoffRuntime || !createHandoffDispatcher) return;

  const rollbackIdentity: TerminalCompatibilityDrainIdentity = {
    ...PROMOTION_BROWSER_IDENTITY,
    viewGeneration: 8,
    transitionEpoch: '9',
    streamEpoch: '9',
    responderLeaseId: 'responder-compatibility-9',
    boundarySourceSeq: '52',
    checkpointEpoch: '9001',
    drainedThroughSourceSeq: '52',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  };
  const peerRollbackIdentity: TerminalCompatibilityDrainIdentity = {
    ...rollbackIdentity,
    connectionId: 'connection-b',
  };
  const selectedLegacyResponderIdentity: TerminalLegacyResponderSelectionIdentity = {
    ...rollbackIdentity,
    driverLeaseId: 'driver-compatibility-9',
    driverLeaseGeneration: '9',
    acceptedViewAttributesGeneration: '9',
    queryReplyCapability: 'terminal.query-reply-input.v1',
    parserResponderCapability: 'terminal.parser-responder-disable.v1',
    snapshotSeq: '50',
  };
  const peerLegacyResponderIdentity: TerminalLegacyResponderSelectionIdentity = {
    ...selectedLegacyResponderIdentity,
    connectionId: peerRollbackIdentity.connectionId,
  };
  const compatibilityDrain = createDeferredBoolean();
  const peerCompatibilityDrain = createDeferredBoolean();
  const events: string[] = [];
  const responderControls: Array<Readonly<Record<string, unknown>>> = [];
  const forwardedUserInputs: string[] = [];
  let selectedParserQueryCalls = 0;
  let peerParserQueryCalls = 0;
  const runtime = createHandoffRuntime({
    identity: rollbackIdentity,
    lifecycleGeneration: 20,
    legacyParserRepliesInitiallyEnabled: false,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => {
      events.push('fresh-compatibility-drain-started');
      const drained = await compatibilityDrain.promise;
      if (drained) events.push('fresh-compatibility-drained');
      return drained;
    },
    flushPendingQueryRepliesImmediately: () => ({ ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 30 }),
    setLegacyParserRepliesEnabled: enabled => {
      events.push(enabled ? 'parser-replies-enabled' : 'parser-replies-disabled');
    },
    sendResponderControl: ({ message }) => {
      responderControls.push(message);
      events.push(String(message.type));
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 31 };
    },
    onPromotionAbortRequired: reason => events.push(`promotion-abort:${reason}`),
    resolveLegacyParserQueryReplies: data => {
      selectedParserQueryCalls += 1;
      return data === '\x1b[5n' ? ['\x1b[0n'] : [];
    },
    forwardUserInput: input => forwardedUserInputs.push(input.kind),
  });

  const peerEvents: string[] = [];
  const peerResponderControls: Array<Readonly<Record<string, unknown>>> = [];
  const peerRuntime = createHandoffRuntime({
    identity: peerRollbackIdentity,
    lifecycleGeneration: 21,
    legacyParserRepliesInitiallyEnabled: false,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: () => peerCompatibilityDrain.promise,
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-b',
      enqueueOrdinal: 32,
    }),
    setLegacyParserRepliesEnabled: enabled => peerEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      peerResponderControls.push(message);
      return { ok: true, controlSocketId: 'control-socket-b', enqueueOrdinal: 33 };
    },
    onPromotionAbortRequired: reason => peerEvents.push(`promotion-abort:${reason}`),
    resolveLegacyParserQueryReplies: data => {
      peerParserQueryCalls += 1;
      return data === '\x1b[5n' ? ['\x1b[0n'] : [];
    },
    forwardUserInput: () => {},
  });
  const dispatcher = createHandoffDispatcher({
    readSelectedLegacyResponderIdentity: () => selectedLegacyResponderIdentity,
  });
  const unregisterPrimary = dispatcher.register(rollbackIdentity, runtime);
  const unregisterPeer = dispatcher.register(peerRollbackIdentity, peerRuntime);
  const primaryEnableMessage: TerminalLegacyResponderEnabledMessage = {
    type: 'terminal-authority:legacy-responder-enabled',
    ...selectedLegacyResponderIdentity,
    affectedViewCount: 2,
  };
  const peerEnableMessage: TerminalLegacyResponderEnabledMessage = {
    type: 'terminal-authority:legacy-responder-enabled',
    ...peerLegacyResponderIdentity,
    affectedViewCount: 2,
  };
  const parsedPrimaryEnable = parseResponderHandoff(primaryEnableMessage);
  assert.equal(parsedPrimaryEnable.ok, true, 'the official RED source must execute the typed server-enable parser');
  if (parsedPrimaryEnable.ok) {
    assert.deepEqual(parsedPrimaryEnable.message, primaryEnableMessage);
  }
  assert.equal(parseResponderHandoff({
    ...primaryEnableMessage,
    affectedViewCount: 1.5,
  }).ok, false, 'the official parser contract must reject a noncanonical all-view quorum count');
  for (const malformedLeaseIdentity of [
    { responderLeaseId: '' },
    { driverLeaseId: '' },
    { driverLeaseGeneration: '09' },
    { acceptedViewAttributesGeneration: '09' },
    { snapshotSeq: '050' },
    { queryReplyCapability: 'terminal.query-reply-input.v2' },
    { parserResponderCapability: '' },
  ] as const) {
    assert.equal(
      parseResponderHandoff({ ...primaryEnableMessage, ...malformedLeaseIdentity }).ok,
      false,
      `selected responder/driver lease identity must fail closed for ${JSON.stringify(malformedLeaseIdentity)}`,
    );
  }

  const restoring = runtime.restoreLegacyParserRepliesAfterCompatibilityDrain(rollbackIdentity);
  const peerRestoring = peerRuntime.restoreLegacyParserRepliesAfterCompatibilityDrain(
    peerRollbackIdentity,
  );
  await Promise.resolve();
  assert.equal(runtime.getState().legacyParserRepliesEnabled, false, signature);
  assert.equal(events.includes('terminal-authority:compatibility-drained'), false, signature);
  const earlyEnable = dispatcher.route(primaryEnableMessage);
  assert.equal(earlyEnable.accepted, false);
  assert.equal(earlyEnable.reason, 'compatibility-drain-pending');
  assert.equal(earlyEnable.completedViewQuorum, false);
  assert.equal(earlyEnable.matchedViewCount, 0);
  assert.equal(runtime.getState().legacyParserRepliesEnabled, false, signature);
  assert.deepEqual(responderControls, [], 'an early server-enable frame cannot emit a compatibility control ACK');
  assert.equal(runtime.submitUserInput({ data: 'still-live', kind: 'key' }).accepted, true, signature);
  assert.deepEqual(forwardedUserInputs, ['key'], signature);

  const stale = await runtime.restoreLegacyParserRepliesAfterCompatibilityDrain({
    ...rollbackIdentity,
    viewGeneration: rollbackIdentity.viewGeneration - 1,
  });
  assert.equal(stale.accepted, false, signature);
  assert.equal(runtime.getState().legacyParserRepliesEnabled, false, signature);

  compatibilityDrain.resolve(true);
  assert.equal((await restoring).accepted, true, signature);
  const oneViewDrainEnable = dispatcher.route(primaryEnableMessage);
  assert.equal(oneViewDrainEnable.accepted, false);
  assert.equal(oneViewDrainEnable.reason, 'compatibility-view-quorum-pending');
  assert.equal(oneViewDrainEnable.completedViewQuorum, false);
  assert.equal(oneViewDrainEnable.matchedViewCount, 0);
  assert.equal(runtime.getState().legacyParserRepliesEnabled, false);
  assert.equal(peerRuntime.getState().legacyParserRepliesEnabled, false);
  peerCompatibilityDrain.resolve(true);
  assert.equal((await peerRestoring).accepted, true, signature);
  assert.equal(
    runtime.getState().legacyParserRepliesEnabled,
    false,
    'a local compatibility drain ACK cannot enable the parser before the server all-view quorum',
  );
  assert.deepEqual(responderControls, [{
    type: 'terminal-authority:compatibility-drained',
    ...rollbackIdentity,
  }], 'compatibility drain ACK must carry the full epoch/checkpoint/view identity');
  assert.deepEqual(peerResponderControls, [{
    type: 'terminal-authority:compatibility-drained',
    ...peerRollbackIdentity,
  }], 'every registered view must complete and ACK its own fresh compatibility drain');
  assert.ok(
    events.indexOf('fresh-compatibility-drained')
      < events.indexOf('terminal-authority:compatibility-drained'),
    signature,
  );
  assert.equal(events.includes('parser-replies-enabled'), false, signature);
  const staleEnable = dispatcher.route({
    ...primaryEnableMessage,
    connectionId: 'stale-connection',
  });
  assert.equal(staleEnable.accepted, false, 'server enable frame must match the full compatibility identity');
  assert.equal(staleEnable.matchedViewCount, 0);
  assert.equal(runtime.getState().legacyParserRepliesEnabled, false, signature);
  assert.equal(peerRuntime.getState().legacyParserRepliesEnabled, false, signature);
  const wrongQuorumCount = dispatcher.route({
    ...primaryEnableMessage,
    affectedViewCount: 1,
  });
  assert.equal(wrongQuorumCount.accepted, false, 'the typed enable frame must carry the server all-view quorum size');
  assert.equal(wrongQuorumCount.matchedViewCount, 0);
  const staleDriverLease = dispatcher.route({
    ...primaryEnableMessage,
    driverLeaseId: 'driver-compatibility-stale',
  });
  assert.equal(staleDriverLease.accepted, false, 'enable routing must fence the selected driver lease identity');
  assert.equal(staleDriverLease.matchedViewCount, 0);
  const staleResponderLease = dispatcher.route({
    ...primaryEnableMessage,
    responderLeaseId: 'responder-compatibility-stale',
  });
  assert.equal(staleResponderLease.accepted, false, 'enable routing must fence the selected responder lease identity');
  assert.equal(staleResponderLease.matchedViewCount, 0);
  assert.deepEqual(dispatcher.route(primaryEnableMessage), {
    accepted: true,
    completedViewQuorum: true,
    matchedViewCount: 1,
  }, 'after both drain ACKs, one exact selected driver/responder frame enables only that runtime');
  assert.equal(runtime.getState().legacyParserRepliesEnabled, true, signature);
  assert.equal(peerRuntime.getState().legacyParserRepliesEnabled, false, 'the non-selected peer parser must remain disabled after quorum');
  const peerEnable = dispatcher.route(peerEnableMessage);
  assert.equal(peerEnable.accepted, false, 'a peer full-identity frame cannot self-select query authority');
  assert.equal(peerEnable.matchedViewCount, 0);
  assert.equal(peerRuntime.getState().legacyParserRepliesEnabled, false);
  assert.ok(
    events.indexOf('terminal-authority:compatibility-drained')
      < events.indexOf('parser-replies-enabled'),
    signature,
  );

  const staleLeaseBroadcast = dispatcher.broadcastLegacyParserQuery({
    query: {
      sessionId: rollbackIdentity.sessionId,
      driverLeaseId: selectedLegacyResponderIdentity.driverLeaseId,
      driverLeaseGeneration: '8',
      data: '\x1b[5n',
    },
    acceptReply: () => {
      throw new Error('a stale driver lease query cannot reach server acceptance');
    },
  });
  assert.equal(staleLeaseBroadcast.replyCount, 0);
  assert.equal(staleLeaseBroadcast.serverAcceptedReplyCount, 0);
  assert.equal(staleLeaseBroadcast.ptyEffectCount, 0);
  assert.equal(selectedParserQueryCalls, 0);
  assert.equal(peerParserQueryCalls, 0);

  let serverAcceptedReplyCount = 0;
  let ptyEffectCount = 0;
  const broadcast = dispatcher.broadcastLegacyParserQuery({
    query: {
      sessionId: rollbackIdentity.sessionId,
      driverLeaseId: selectedLegacyResponderIdentity.driverLeaseId,
      driverLeaseGeneration: selectedLegacyResponderIdentity.driverLeaseGeneration,
      data: '\x1b[5n',
    },
    acceptReply: reply => {
      assert.deepEqual(reply, {
        identity: selectedLegacyResponderIdentity,
        data: '\x1b[0n',
        replyOrdinal: 0,
      }, 'server acceptance must receive the selected runtime full responder/driver lease identity');
      serverAcceptedReplyCount += 1;
      ptyEffectCount += 1;
      return { accepted: true, ptyEffectApplied: true };
    },
  });
  assert.deepEqual(broadcast.deliveries, [
    {
      connectionId: rollbackIdentity.connectionId,
      viewGeneration: rollbackIdentity.viewGeneration,
      replyCount: 1,
    },
    {
      connectionId: peerRollbackIdentity.connectionId,
      viewGeneration: peerRollbackIdentity.viewGeneration,
      replyCount: 0,
    },
  ], 'one broadcast query must yield one selected reply and zero peer replies');
  assert.equal(broadcast.replyCount, 1);
  assert.equal(broadcast.serverAcceptedReplyCount, 1);
  assert.equal(broadcast.ptyEffectCount, 1);
  assert.equal(serverAcceptedReplyCount, 1, 'the server must accept exactly one reply for the broadcast query');
  assert.equal(ptyEffectCount, 1, 'the broadcast query may create exactly one PTY write effect');
  assert.equal(selectedParserQueryCalls, 1, 'only the selected enabled parser may inspect the broadcast query');
  assert.equal(peerParserQueryCalls, 0, 'the disabled peer parser must not generate a competing reply');
  unregisterPrimary();
  unregisterPeer();

  const distributedDispatcher = createHandoffDispatcher({
    readSelectedLegacyResponderIdentity: () => selectedLegacyResponderIdentity,
  });
  const unregisterDistributedPrimary = distributedDispatcher.register(rollbackIdentity, runtime);
  assert.deepEqual(distributedDispatcher.route({
    ...primaryEnableMessage,
    affectedViewCount: 2,
  }), {
    accepted: true,
    completedViewQuorum: true,
    matchedViewCount: 1,
  }, 'a selected browser must trust the server all-view quorum when remote views live in other browser processes');
  unregisterDistributedPrimary();

  const failedEvents: string[] = [];
  const failedRuntime = createHandoffRuntime({
    identity: rollbackIdentity,
    lifecycleGeneration: 21,
    legacyParserRepliesInitiallyEnabled: false,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => false,
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 40,
    }),
    setLegacyParserRepliesEnabled: enabled => failedEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      failedEvents.push(String(message.type));
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 41 };
    },
    onPromotionAbortRequired: reason => failedEvents.push(`promotion-abort:${reason}`),
    forwardUserInput: input => cancelledEvents.push(`user:${input.kind}`),
  });
  const failed = await failedRuntime.restoreLegacyParserRepliesAfterCompatibilityDrain(
    rollbackIdentity,
  );
  assert.equal(failed.accepted, false, signature);
  assert.equal(failedRuntime.getState().legacyParserRepliesEnabled, false, signature);
  assert.equal(failedEvents.includes('terminal-authority:compatibility-drained'), false, signature);

  const cancelledDrain = createDeferredBoolean();
  const cancelledEvents: string[] = [];
  const cancelledControls: Array<Readonly<Record<string, unknown>>> = [];
  const cancelledRuntime = createHandoffRuntime({
    identity: rollbackIdentity,
    lifecycleGeneration: 30,
    legacyParserRepliesInitiallyEnabled: false,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: () => cancelledDrain.promise,
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 70,
    }),
    setLegacyParserRepliesEnabled: enabled => cancelledEvents.push(`parser:${enabled}`),
    sendResponderControl: ({ message }) => {
      cancelledControls.push(message);
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 71 };
    },
    onPromotionAbortRequired: reason => cancelledEvents.push(`promotion-abort:${reason}`),
    onRecoveryRestartRequired: reason => cancelledEvents.push(`recovery-restart:${reason}`),
    forwardUserInput: () => {},
  });
  const createReplacementRuntime = () => createHandoffRuntime({
    identity: { ...rollbackIdentity, viewGeneration: rollbackIdentity.viewGeneration + 1 },
    lifecycleGeneration: 31,
    legacyParserRepliesInitiallyEnabled: false,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async () => true,
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 80,
    }),
    setLegacyParserRepliesEnabled: () => {},
    sendResponderControl: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 81,
    }),
    onPromotionAbortRequired: () => {},
    forwardUserInput: () => {},
  });
  assert.equal(cancelledRuntime.lifecycleGeneration, 30, signature);
  const cancelledRestore = cancelledRuntime.restoreLegacyParserRepliesAfterCompatibilityDrain(
    rollbackIdentity,
  );
  await Promise.resolve();
  const replacementRuntime = createReplacementRuntime();
  assert.equal(replacementRuntime.lifecycleGeneration, 31, signature);
  cancelledRuntime.dispose('runtime-replaced');
  cancelledRuntime.dispose('runtime-replaced');
  cancelledDrain.resolve(true);
  assert.deepEqual(await cancelledRestore, {
    accepted: false,
    reason: 'runtime-disposed',
  }, 'a replaced runtime must cancel an in-flight rollback drain');
  assert.deepEqual(cancelledEvents, [
    'recovery-restart:runtime-replaced',
  ], 'double dispose must request recovery restart exactly once without parser mutation');
  assert.deepEqual(cancelledControls, [], 'a disposed generation cannot emit compatibility-drained');
  const disposedResult = {
    accepted: false,
    reason: 'runtime-disposed',
  };
  assert.deepEqual(
    cancelledRuntime.applyLegacyResponderEnabled(selectedLegacyResponderIdentity),
    disposedResult,
    'a late server enable frame cannot revive a disposed runtime generation',
  );
  assert.deepEqual(
    await cancelledRuntime.disableLegacyParserRepliesAtBoundary(rollbackIdentity),
    disposedResult,
  );
  assert.deepEqual(
    await cancelledRuntime.restoreLegacyParserRepliesAfterCompatibilityDrain(rollbackIdentity),
    disposedResult,
  );
  assert.deepEqual(
    cancelledRuntime.submitUserInput({ data: 'late-input', kind: 'key' }),
    disposedResult,
  );
  assert.deepEqual(cancelledEvents, [
    'recovery-restart:runtime-replaced',
  ], 'all late entry points must stay side-effect free after runtime disposal');
  assert.deepEqual(cancelledControls, [], signature);
});

test('MIG-BGSTAB-002 compatibility drain coalesces concurrent cumulative watermarks', async () => {
  const createHandoffRuntime = (
    terminalCheckpointRuntimeModule as unknown as TerminalResponderHandoffContract
  ).createTerminalResponderHandoffRuntime;
  const base: TerminalCompatibilityDrainIdentity = {
    ...PROMOTION_BROWSER_IDENTITY,
    viewGeneration: 8,
    transitionEpoch: '9',
    streamEpoch: '9',
    responderLeaseId: 'responder-compatibility-9',
    boundarySourceSeq: '52',
    checkpointEpoch: '9001',
    drainedThroughSourceSeq: '52',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
  };
  const drain = createDeferredBoolean();
  const drainCalls: TerminalCompatibilityDrainIdentity[] = [];
  const controls: Array<Readonly<Record<string, unknown>>> = [];
  const runtime = createHandoffRuntime({
    identity: base,
    lifecycleGeneration: 40,
    legacyParserRepliesInitiallyEnabled: false,
    awaitOutputIdleWithFifoProbe: async () => true,
    awaitCompatibilityDrain: async identity => {
      drainCalls.push(identity);
      return drain.promise;
    },
    flushPendingQueryRepliesImmediately: () => ({
      ok: true,
      controlSocketId: 'control-socket-a',
      enqueueOrdinal: 90,
    }),
    setLegacyParserRepliesEnabled: () => {},
    sendResponderControl: ({ message }) => {
      controls.push(message);
      return { ok: true, controlSocketId: 'control-socket-a', enqueueOrdinal: 91 };
    },
    onPromotionAbortRequired: () => {},
    forwardUserInput: () => {},
  });

  const first = runtime.restoreLegacyParserRepliesAfterCompatibilityDrain(base);
  await Promise.resolve();
  const latest = { ...base, drainedThroughSourceSeq: '53' };
  const second = runtime.restoreLegacyParserRepliesAfterCompatibilityDrain(latest);
  assert.equal(drainCalls.length, 1, 'one view may own only one compatibility-drain probe');
  drain.resolve(true);
  assert.deepEqual(await Promise.all([first, second]), [
    { accepted: true, compatibilityDrainIdentity: latest },
    { accepted: true, compatibilityDrainIdentity: latest },
  ]);
  assert.equal(drainCalls.length, 1, 'a cumulative watermark must join the in-flight drain');
  assert.deepEqual(controls, [{
    type: 'terminal-authority:compatibility-drained',
    ...latest,
  }], 'the single control ACK must carry the newest cumulative watermark observed before idle');
  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const completionStart = terminalViewSource.indexOf('const completeCompatibilityRollback = (');
  const completionEnd = terminalViewSource.indexOf('\n      terminalWriteCoordinatorRef.current', completionStart);
  const completion = terminalViewSource.slice(completionStart, completionEnd);
  assert.match(
    completion,
    /result\.compatibilityDrainIdentity\s*\?\? compatibilityIdentity/u,
    'TerminalView must register the same latest identity that the single-flight runtime ACKed',
  );
});

function retainedStateStart(overrides = {}) {
  const base = {
    contentDigest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    retainedActiveBuffer: 'normal' as const,
    retainedCursor: { x: 1, y: 2 },
    retainedSavedCursor: null,
    retainedStateDigestVersion: RETAINED_STATE_DIGEST_VERSION,
    ...overrides,
  };
  const message = startMessage(base) as TerminalCheckpointStartMessage;
  return startMessage({
    ...base,
    retainedStateDigest: terminalCheckpointRetainedStateDigest(message),
  });
}

function routeRetainedStateStart(message: TerminalCheckpointServerMessage) {
  const { runtime } = createHarness();
  const registry = createTerminalCheckpointDispatcherRegistry();
  const unregister = registry.register('session-1', runtime);
  registry.setCapability(ACTIVE_CAPABILITY);
  try {
    return registry.route(message);
  } finally {
    unregister();
  }
}

test('IR-BGSTAB-002 AC-6 fail-closes an unknown digest version with its own reason', () => {
  const decision = routeRetainedStateStart(startMessage({
    contentDigest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    retainedActiveBuffer: 'normal',
    retainedCursor: { x: 1, y: 2 },
    retainedSavedCursor: null,
    retainedStateDigest: `sha256:${'0'.repeat(64)}`,
    retainedStateDigestVersion: 99,
  }));
  assert.deepEqual(decision, {
    delivered: false,
    handled: true,
    reason: 'checkpoint-retained-state-digest-version-unknown',
  });
});

test('IR-BGSTAB-002 AC-6 keeps a wrong value distinct from a wrong version', () => {
  const decision = routeRetainedStateStart(startMessage({
    contentDigest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    retainedActiveBuffer: 'normal',
    retainedCursor: { x: 1, y: 2 },
    retainedSavedCursor: null,
    retainedStateDigest: `sha256:${'0'.repeat(64)}`,
    retainedStateDigestVersion: RETAINED_STATE_DIGEST_VERSION,
  }));
  assert.deepEqual(decision, {
    delivered: false,
    handled: true,
    reason: 'checkpoint-retained-state-digest-mismatch',
  });
});

test('IR-BGSTAB-002 AC-6 boundary control: a sound digest on a known version is delivered', () => {
  // Without this the two refusals above could come from anything in the path.
  assert.deepEqual(routeRetainedStateStart(retainedStateStart()), { delivered: true });
});
