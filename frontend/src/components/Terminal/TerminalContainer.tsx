import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions, useWebSocketState } from '../../contexts/WebSocketContext';
import type { SendResult } from '../../contexts/WebSocketContext';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { TerminalView } from './TerminalView';
import type { GridRepairReason, TerminalHandle, TerminalPasteInputResult } from './TerminalView';
import type { TerminalShortcutState } from '../../types';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildClientInputDebugMetadata,
  isTerminalDebugCaptureEnabled,
  recordTerminalDebugEvent,
  resolveTerminalInputDebugPayload,
} from '../../utils/terminalDebugCapture';
import {
  getInputReliabilityMode,
  getTerminalResourceLimits,
  getWsTransportMode,
} from '../../utils/inputReliabilityMode';
import {
  getCachedTerminalOutputResourceLimits,
  getOutputUtf8ByteLength as getUtf8ByteLength,
} from '../../utils/terminalOutputHotPath';
import type { TerminalOutputDelivery } from '../../utils/terminalOutputDelivery';
import { createLiveOutputTokenStore, type LiveOutputTokens } from '../../utils/liveOutputTokens';
import type { TerminalOutputPolicySelectionCoordinator } from '../../utils/terminalOutputScheduler';
import { classifySessionError, sessionErrorTerminatesSession } from '../../utils/sessionCloseClassification';
import { TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS } from '../../utils/terminalReplayGuard';
import {
  beginHiddenOutputReplay,
  clearHiddenOutputState,
  createHiddenOutputReplayState,
  createHiddenOutputState,
  finishHiddenOutputReplay,
  resolveHiddenOutput,
  shouldClearHiddenOutputAfterSnapshotRecovery,
} from '../../utils/terminalHiddenOutput';
import {
  beginVisibleOutputRecovery,
  beginBrowserViewOnlyDataGapRecovery,
  advanceTerminalCompatibilityPostAckConvergence,
  classifyVisibleResyncOutputBatch,
  createTerminalCompatibilityPostAckConvergence,
  createTerminalCompatibilityProgressTimeout,
  createTerminalContainerRestoreAdapter,
  createVisibleOutputRecoveryAttemptBudget,
  createVisibleOutputMutationFence,
  createVisibleOutputRecoveryCoordinator,
  createVisibleOutputRecoveryState,
  finishVisibleOutputRecovery,
  hasSameRestoreNeededAuthorityProof,
  matchesRestoreNeededSnapshotAuthorityProof,
  recordVisibleOutputRecoverySendFailure,
  recordVisibleOutputRecoverySendSuccess,
  resolveVisibleOutputRecoveryBarrierReason,
  shouldForceAuthoritativeRecoveryConvergence,
  shouldForceInitialCheckpointAuthorityRecoveryConvergence,
  shouldSuppressLegacySnapshotDuringCheckpointAuthority,
  type VisibleOutputRecoveryCoordinator,
  type BoundTerminalRestoreAdapter,
  type VisibleOutputMutationFence,
  type VisibleOutputRecoveryScope,
  type TerminalCompatibilityPostAckConvergenceState,
  type TerminalCompatibilityProgressTimeout,
} from '../../utils/visibleOutputRecovery';
import {
  TerminalInputSequencer,
  type SequencedTerminalInput,
} from '../../utils/terminalInputSequencer';
import { resolveStaleSocketReconnectDecision } from '../../utils/terminalTransportQueueDecision';
import type {
  InputDebugMetadata,
  InputRejectedReason,
  ScreenRepairFailedReason,
  ScreenRepairMessage,
  ScreenRepairReconnectRequiredMessage,
  ScreenRepairRejectedMessage,
  ScreenRepairRestoreNeededMessage,
  TerminalDeliveryDataGapMessage,
  TerminalSessionReadyMessage,
  TerminalInputBarrierReason,
  TerminalInputClosedReason,
} from '../../types/ws-protocol';

const RECONNECT_INPUT_QUEUE_TTL_MS = 3000;

interface TransportOutboxEntry extends SequencedTerminalInput {
  queuedAt: number;
  expiresAt: number;
  sessionGeneration: number;
  containsEnter: boolean;
  byteLength: number;
  barrierReason: TerminalInputBarrierReason;
  source: string;
  detailReason: string;
}

interface TransportQueueDecision {
  action: 'queue' | 'reject';
  rejectReason: InputRejectedReason;
  barrierReason: TerminalInputBarrierReason;
  detailReason: string;
  ttlMs: number;
}

function mapClosedReasonToRejectReason(closedReason: TerminalInputClosedReason): InputRejectedReason {
  switch (closedReason) {
    case 'session-exited':
      return 'session-closed';
    case 'session-missing':
      return 'session-missing';
    case 'server-error':
      return 'server-error';
    case 'auth-expired':
      return 'auth-expired';
    case 'ws-closed-without-reconnect':
      return 'transport-closed';
    case 'terminal-hidden':
    case 'terminal-disposed':
    case 'workspace-or-session-changed':
    case 'none':
    default:
      return 'context-changed';
  }
}

function mapSendFailureToRejectReason(reason: Exclude<SendResult, { ok: true }>['reason']): InputRejectedReason {
  return reason === 'missing-token' ? 'auth-expired' : 'transport-closed';
}

function inputContainsEnter(raw: string): boolean {
  return raw.includes('\r') || raw.includes('\n');
}

function getTransportOutboxLimits(): { transportOutboxMaxBytes: number; transportOutboxTtlMs: number } {
  const limits = getTerminalResourceLimits();
  return {
    transportOutboxMaxBytes: limits.transportOutboxMaxBytes,
    transportOutboxTtlMs: limits.transportOutboxTtlMs,
  };
}

function resolveInputDebugPayload(
  data: string,
  metadata: InputDebugMetadata | undefined,
  sessionId: string,
) {
  return resolveTerminalInputDebugPayload(data, metadata, {
    captureEnabled: isTerminalDebugCaptureEnabled(sessionId),
  });
}

interface Props {
  sessionId: string;
  workspaceId: string;
  terminalShortcutState: TerminalShortcutState | null;
  isVisible: boolean;
  isGridSurface: boolean;
  clipboardContextKey?: string | null;
  outputPolicySelectionCoordinator?: TerminalOutputPolicySelectionCoordinator;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange?: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function propsAreEqual(prev: Props, next: Props): boolean {
  return prev.sessionId === next.sessionId
    && prev.workspaceId === next.workspaceId
    && prev.terminalShortcutState === next.terminalShortcutState
    && prev.isVisible === next.isVisible
    && prev.isGridSurface === next.isGridSurface
    && prev.clipboardContextKey === next.clipboardContextKey
    && prev.outputPolicySelectionCoordinator === next.outputPolicySelectionCoordinator;
}

const FALLBACK_EMPTY_MESSAGE = '[BuilderGate] Fallback snapshot unavailable. Waiting for new output...\r\n';
const VISIBLE_OUTPUT_RECOVERY_MAX_SEND_RETRIES = 2;
const VISIBLE_OUTPUT_RECOVERY_MAX_FRESH_SNAPSHOT_ATTEMPTS = 3;
const VISIBLE_OUTPUT_RECOVERY_MAX_RECONNECT_ATTEMPTS = 3;
const MAX_SUPERSEDED_VISIBLE_RESYNC_KEYS = 32;

function getVisibleOutputResyncTokenKey(repairToken: string, replayToken: string): string {
  return `${repairToken}\u0000${replayToken}`;
}

function rememberSupersededVisibleResyncKey(keys: Set<string>, key: string): void {
  keys.add(key);
  while (keys.size > MAX_SUPERSEDED_VISIBLE_RESYNC_KEYS) {
    const oldest = keys.values().next().value as string | undefined;
    if (oldest === undefined) break;
    keys.delete(oldest);
  }
}

function waitForRuntimeLayoutSettle(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function buildUnavailableInputResult(source: string): TerminalPasteInputResult {
  return {
    ok: false,
    reason: 'context-changed',
    source,
    captureState: 'closed',
    barrierReason: 'none',
    closedReason: 'terminal-disposed',
  };
}

interface SnapshotPayload {
  seq: number;
  data: string;
  mode: 'authoritative' | 'fallback';
  truncated: boolean;
  replayToken: string;
  windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber?: number };
  authorityEpoch?: string;
  authorityRevision?: number;
  coversThroughSeq?: number;
  supersedesReplayToken?: string;
  parserComplete?: boolean;
  pendingEscapeTailAnsi?: string;
}

interface ActiveVisibleOutputResync {
  coordinator: VisibleOutputRecoveryCoordinator;
  restoreAdapter: BoundTerminalRestoreAdapter;
  scope: VisibleOutputRecoveryScope;
  transactionId: string;
  repairToken: string;
  replayToken: string;
  snapshotSeq: number;
  authorityEpoch: string;
  authorityRevision: number;
  coversThroughSeq: number;
  supersedesReplayToken?: string;
  connectionGeneration: number;
  sessionGeneration: number;
  hiddenSkippedBytes: number;
  nextChunkOrdinal: number;
  matchingServerReadyLatched: boolean;
  viewGeneration: number;
  xtermGeneration: number;
  liveLaneIdlePromise: Promise<boolean>;
  clearRecoveryTimers: () => void;
}

export const TerminalContainer = memo(
  forwardRef<TerminalHandle, Props>(function TerminalContainer(
    { sessionId, workspaceId, terminalShortcutState, isVisible, isGridSurface, clipboardContextKey, outputPolicySelectionCoordinator, onStatusChange, onCwdChange },
    ref
  ) {
    const terminalRef = useRef<TerminalHandle>(null);
    const isVisibleRef = useRef(isVisible);
    const isGridSurfaceRef = useRef(isGridSurface);
    const initialRestorePendingRef = useRef(true);
    const historySeenRef = useRef(false);
    const pendingSnapshotRef = useRef<SnapshotPayload | null>(null);
    const latestReceivedSnapshotReadyIdentityRef = useRef<{
      replayToken: string;
      snapshotSeq: number;
    } | null>(null);
    const pendingCheckpointAuthoritySnapshotRef = useRef<SnapshotPayload | null>(null);
    const compatibilityAuthorityReadyRef = useRef(false);
    const snapshotApplyInProgressRef = useRef(false);
    const sessionReadyRef = useRef(false);
    const visibleRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resizeRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gridRepairInFlightRef = useRef<Promise<void> | null>(null);
    const gridVisibleRef = useRef(false);
    const pendingGridScreenRepairRef = useRef<GridRepairReason | null>(null);
    const flushPendingGridScreenRepairRef = useRef<() => void>(() => {});
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const screenRepairInFlightRef = useRef<{
      sessionId: string;
      cols: number;
      rows: number;
      reason: GridRepairReason;
    } | null>(null);
    const lastCompletedScreenRepairRef = useRef<{
      sessionId: string;
      cols: number;
      rows: number;
      reason: GridRepairReason;
      completedAt: number;
    } | null>(null);
    const lastStatusRef = useRef<WorkspaceTabRuntime['status'] | null>(null);
    const sessionGenerationRef = useRef(1);
    const generationSessionIdRef = useRef(sessionId);
    const transportClosedReasonRef = useRef<TerminalInputClosedReason>('none');
    const transportOutboxRef = useRef<TransportOutboxEntry[]>([]);
    const transportOutboxBytesRef = useRef(0);
    const transportOutboxExpiryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    const deliverSequencedInputRef = useRef<(input: SequencedTerminalInput, reason: string) => void>(() => {});
    const inputSequencerRef = useRef<TerminalInputSequencer | null>(null);
    const reconnectStartedAtRef = useRef<number | null>(null);
    const reconnectTtlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const {
      send,
      subscribeSession,
      requestReconnect,
      publishTerminalDeliveryVisibility,
    } = useWebSocketActions();
    const { status: wsStatus, clientId: wsClientId } = useWebSocketState();
    const { invalidateHostLayouts } = useTerminalRuntimeContext();
    const wsStatusRef = useRef(wsStatus);
    const lastAppliedSnapshotRef = useRef<{
      seq: number;
      mode: 'authoritative' | 'fallback';
      truncated: boolean;
      data: string;
      replayToken: string;
      connectionGeneration: number;
    } | null>(null);
    const hiddenOutputStateRef = useRef(createHiddenOutputState());
    const hiddenOutputReplayStateRef = useRef(createHiddenOutputReplayState());
    const visibleOutputRecoveryStateRef = useRef(createVisibleOutputRecoveryState());
    const visibleOutputRecoveryAttemptBudgetRef = useRef(
      createVisibleOutputRecoveryAttemptBudget({
        maxFreshSnapshotAttempts: VISIBLE_OUTPUT_RECOVERY_MAX_FRESH_SNAPSHOT_ATTEMPTS,
        maxReconnectAttempts: VISIBLE_OUTPUT_RECOVERY_MAX_RECONNECT_ATTEMPTS,
      }),
    );
    const activeVisibleOutputResyncRef = useRef<ActiveVisibleOutputResync | null>(null);
    const compatibilityPostAckConvergenceRef = useRef<
      TerminalCompatibilityPostAckConvergenceState | null
    >(null);
    const compatibilityPostAckTimeoutRef = useRef<TerminalCompatibilityProgressTimeout | null>(null);
    const supersededVisibleOutputResyncKeysRef = useRef(new Set<string>());
    const visibleOutputResyncEpochRef = useRef(0);
    const visibleOutputMutationFenceRef = useRef<VisibleOutputMutationFence | null>(null);

    if (!visibleOutputMutationFenceRef.current) {
      visibleOutputMutationFenceRef.current = createVisibleOutputMutationFence();
    }
    const wsClientIdRef = useRef<string | null>(null);
    const wsConnectionGenerationRef = useRef(0);
    /**
     * The live-path tokens (`08:224`). Added alongside the three existing refs
     * rather than merged with them, so JSON-observable behaviour is untouched.
     * Reads and writes carry both generations, which is how the three
     * invalidation triggers of `08:223` collapse into one rule.
     */
    const liveOutputTokenRef = useRef(createLiveOutputTokenStore());
    const liveOutputTokenGeneration = useCallback(
      () => `${wsConnectionGenerationRef.current}:${sessionGenerationRef.current}`,
      [],
    );
    /**
     * Records a token where it becomes the client's notion of the current
     * identity — not merely where a message carrying one arrived.
     *
     * Those coincide for a snapshot, whose token is the new identity the moment
     * it lands (the sibling `latestReceivedSnapshotReadyIdentityRef` treats it
     * exactly that way). They do not coincide for `session:ready` during a
     * recovery, where the token is correlation evidence and the handler may
     * still reject it as stale.
     */
    const recordLiveOutputTokens = useCallback((tokens: LiveOutputTokens): void => {
      liveOutputTokenRef.current.update(sessionId, liveOutputTokenGeneration(), tokens);
    }, [liveOutputTokenGeneration, sessionId]);

    const requestBoundedVisibleRecoveryReconnect = useCallback((reason: string): boolean => {
      const decision = visibleOutputRecoveryAttemptBudgetRef.current.consume('reconnect');
      if (!decision.allowed) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_retry_budget_exhausted', {
          kind: 'reconnect',
          reason,
          attempts: decision.attempt,
        });
        return false;
      }
      recordTerminalDebugEvent(sessionId, 'visible_output_resync_retry_attempted', {
        kind: 'reconnect',
        reason,
        attempt: decision.attempt,
      });
      recordTerminalDebugEvent(sessionId, 'visible_output_resync_reconnect_requested', {
        reason,
        attempt: decision.attempt,
      });
      return requestReconnect(reason);
    }, [requestReconnect, sessionId]);

    if (!inputSequencerRef.current) {
      inputSequencerRef.current = new TerminalInputSequencer((input, reason) => {
        deliverSequencedInputRef.current(input, reason);
      });
    }

    isVisibleRef.current = isVisible;
    isGridSurfaceRef.current = isGridSurface;
    wsStatusRef.current = wsStatus;
    if (wsClientId && wsClientIdRef.current !== wsClientId) {
      wsClientIdRef.current = wsClientId;
      wsConnectionGenerationRef.current += 1;
    }

    const bumpSessionGeneration = useCallback((reason: string) => {
      sessionGenerationRef.current += 1;
      recordTerminalDebugEvent(sessionId, 'input_session_generation_bumped', {
        reason,
        sessionGeneration: sessionGenerationRef.current,
      });
    }, [sessionId]);

    const clearTransportClosedReason = useCallback((reason: string) => {
      const currentReason = transportClosedReasonRef.current;
      if (currentReason === 'none') {
        return;
      }
      if (reason === 'ws-connected' && currentReason !== 'ws-closed-without-reconnect') {
        return;
      }
      transportClosedReasonRef.current = 'none';
      recordTerminalDebugEvent(sessionId, 'input_transport_closed_reason_cleared', { reason });
    }, [sessionId]);

    const markTransportClosed = useCallback((closedReason: TerminalInputClosedReason, reason: string) => {
      const currentReason = transportClosedReasonRef.current;
      if (
        closedReason === 'ws-closed-without-reconnect'
        && currentReason !== 'none'
        && currentReason !== 'ws-closed-without-reconnect'
      ) {
        return;
      }
      if (currentReason !== closedReason) {
        transportClosedReasonRef.current = closedReason;
        bumpSessionGeneration(reason);
      }
    }, [bumpSessionGeneration]);

    const syncInputTransportState = useCallback((reason: string) => {
      const currentWsStatus = wsStatusRef.current;
      let serverReady = sessionReadyRef.current;
      let barrierReason: TerminalInputBarrierReason = 'none';
      let closedReason = transportClosedReasonRef.current;

      if (currentWsStatus === 'connected') {
        reconnectStartedAtRef.current = null;
        if (closedReason === 'ws-closed-without-reconnect') {
          closedReason = 'none';
          transportClosedReasonRef.current = 'none';
        }
      } else if (currentWsStatus === 'reconnecting') {
        serverReady = false;
        if (closedReason === 'none') {
          const startedAt = reconnectStartedAtRef.current ?? Date.now();
          reconnectStartedAtRef.current = startedAt;
          if (Date.now() - startedAt <= RECONNECT_INPUT_QUEUE_TTL_MS) {
            barrierReason = 'ws-reconnecting-short';
          } else {
            closedReason = 'ws-closed-without-reconnect';
            if (transportClosedReasonRef.current !== closedReason) {
              transportClosedReasonRef.current = closedReason;
              bumpSessionGeneration('reconnect-ttl-expired');
            }
          }
        }
      } else {
        serverReady = false;
        if (closedReason === 'none') {
          closedReason = 'ws-closed-without-reconnect';
          if (transportClosedReasonRef.current !== closedReason) {
            transportClosedReasonRef.current = closedReason;
            bumpSessionGeneration('ws-disconnected');
          }
        }
      }

      if (closedReason === 'none' && barrierReason === 'none') {
        const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);
        if (compatibilityPostAckConvergenceRef.current !== null) {
          serverReady = false;
          barrierReason = 'replay-pending';
        } else if (visibleRecoveryBarrier !== 'none') {
          serverReady = false;
          barrierReason = visibleRecoveryBarrier;
        } else if (
          initialRestorePendingRef.current
          || snapshotApplyInProgressRef.current
          || pendingSnapshotRef.current !== null
        ) {
          serverReady = false;
          barrierReason = 'replay-pending';
        } else if (!serverReady) {
          barrierReason = 'repair-server-not-ready';
        }
      }

      terminalRef.current?.setInputTransportState({
        serverReady,
        barrierReason,
        closedReason,
        reconnectState: currentWsStatus,
        sessionGeneration: sessionGenerationRef.current,
      });
      recordTerminalDebugEvent(sessionId, 'input_transport_state_synced', {
        reason,
        serverReady,
        barrierReason,
        closedReason,
        reconnectState: currentWsStatus,
        sessionGeneration: sessionGenerationRef.current,
      });
    }, [bumpSessionGeneration, sessionId]);

    const recordTransportInputRejected = useCallback((
      kind: 'transport_input_rejected' | 'transport_input_would_reject',
      input: SequencedTerminalInput,
      rejectReason: InputRejectedReason,
      detailReason: string,
      source: string,
      queuedAt?: number,
      barrierReason: TerminalInputBarrierReason = 'none',
    ) => {
      const debugInput = resolveInputDebugPayload(input.data, input.metadata, sessionId);
      recordTerminalDebugEvent(sessionId, kind, {
        ...debugInput.details,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        logicalChunkCount: input.logicalChunkCount,
        reason: rejectReason,
        detailReason,
        source,
        barrierReason,
        queuedMs: queuedAt === undefined ? null : Math.max(0, Date.now() - queuedAt),
        queuedSessionGeneration: 'sessionGeneration' in input ? (input as TransportOutboxEntry).sessionGeneration : null,
        currentSessionGeneration: sessionGenerationRef.current,
        reconnectState: wsStatusRef.current,
      }, debugInput.preview);
    }, [sessionId]);

    const recordTransportInputQueueEvent = useCallback((
      kind:
        | 'transport_input_queued'
        | 'transport_input_would_queue'
        | 'transport_input_queue_overflow'
        | 'transport_input_flushed',
      input: SequencedTerminalInput,
      details: Record<string, string | number | boolean | null>,
    ) => {
      const debugInput = resolveInputDebugPayload(input.data, input.metadata, sessionId);
      recordTerminalDebugEvent(sessionId, kind, {
        ...debugInput.details,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        logicalChunkCount: input.logicalChunkCount,
        ...details,
      }, debugInput.preview);
    }, [sessionId]);

    const clearTransportOutboxExpiryTimers = useCallback(() => {
      for (const timer of transportOutboxExpiryTimersRef.current) {
        clearTimeout(timer);
      }
      transportOutboxExpiryTimersRef.current.clear();
    }, []);

    const rejectTransportOutbox = useCallback((
      rejectReason: InputRejectedReason,
      detailReason: string = rejectReason,
    ) => {
      const entries = transportOutboxRef.current;
      if (entries.length === 0) {
        return;
      }

      transportOutboxRef.current = [];
      transportOutboxBytesRef.current = 0;
      for (const entry of entries) {
        recordTransportInputRejected(
          'transport_input_rejected',
          entry,
          rejectReason,
          detailReason,
          entry.source,
          entry.queuedAt,
          entry.barrierReason,
        );
      }
    }, [recordTransportInputRejected]);

    const classifyTransportQueueDecision = useCallback((
      sendFailure?: Exclude<SendResult, { ok: true }>,
    ): TransportQueueDecision => {
      const { transportOutboxTtlMs } = getTransportOutboxLimits();

      if (!isVisibleRef.current) {
        return {
          action: 'reject',
          rejectReason: 'context-changed',
          barrierReason: 'none',
          detailReason: 'terminal-hidden',
          ttlMs: transportOutboxTtlMs,
        };
      }

      const closedReason = transportClosedReasonRef.current;
      if (closedReason !== 'none') {
        return {
          action: 'reject',
          rejectReason: mapClosedReasonToRejectReason(closedReason),
          barrierReason: 'none',
          detailReason: closedReason,
          ttlMs: transportOutboxTtlMs,
        };
      }

      if (sendFailure?.reason === 'missing-token') {
        return {
          action: 'reject',
          rejectReason: 'auth-expired',
          barrierReason: 'none',
          detailReason: 'missing-token',
          ttlMs: transportOutboxTtlMs,
        };
      }

      if (sendFailure?.reason === 'stale-socket') {
        const staleSocketDecision = resolveStaleSocketReconnectDecision({
          reconnectStartedAt: reconnectStartedAtRef.current,
          now: Date.now(),
          reconnectTtlMs: RECONNECT_INPUT_QUEUE_TTL_MS,
        });
        reconnectStartedAtRef.current = staleSocketDecision.reconnectStartedAt;
        if (staleSocketDecision.action === 'queue') {
          return {
            action: 'queue',
            rejectReason: 'transport-closed',
            barrierReason: 'ws-reconnecting-short',
            detailReason: 'stale-socket',
            ttlMs: RECONNECT_INPUT_QUEUE_TTL_MS,
          };
        }

        return {
          action: 'reject',
          rejectReason: 'transport-closed',
          barrierReason: 'none',
          detailReason: 'stale-socket',
          ttlMs: transportOutboxTtlMs,
        };
      }

      if (
        sendFailure?.reason === 'client-backpressure'
        || sendFailure?.reason === 'client-hard-backpressure'
      ) {
        return {
          action: 'queue',
          rejectReason: 'transport-closed',
          barrierReason: 'client-backpressure',
          detailReason: sendFailure.reason,
          ttlMs: transportOutboxTtlMs,
        };
      }

      const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);
      if (compatibilityPostAckConvergenceRef.current !== null) {
        return {
          action: 'queue',
          rejectReason: 'timeout',
          barrierReason: 'replay-pending',
          detailReason: 'compatibility-post-ack-convergence',
          ttlMs: transportOutboxTtlMs,
        };
      }
      if (visibleRecoveryBarrier !== 'none') {
        return {
          action: 'queue',
          rejectReason: 'timeout',
          barrierReason: visibleRecoveryBarrier,
          detailReason: visibleRecoveryBarrier,
          ttlMs: transportOutboxTtlMs,
        };
      }

      const currentWsStatus = wsStatusRef.current;
      if (currentWsStatus === 'reconnecting') {
        const startedAt = reconnectStartedAtRef.current ?? Date.now();
        reconnectStartedAtRef.current = startedAt;
        if (Date.now() - startedAt <= RECONNECT_INPUT_QUEUE_TTL_MS) {
          return {
            action: 'queue',
            rejectReason: 'transport-closed',
            barrierReason: 'ws-reconnecting-short',
            detailReason: sendFailure ? `send-${sendFailure.reason}` : 'ws-reconnecting-short',
            ttlMs: RECONNECT_INPUT_QUEUE_TTL_MS,
          };
        }

        return {
          action: 'reject',
          rejectReason: 'transport-closed',
          barrierReason: 'none',
          detailReason: 'ws-closed-without-reconnect',
          ttlMs: transportOutboxTtlMs,
        };
      }

      if (currentWsStatus === 'disconnected') {
        return {
          action: 'reject',
          rejectReason: 'transport-closed',
          barrierReason: 'none',
          detailReason: 'ws-disconnected',
          ttlMs: transportOutboxTtlMs,
        };
      }

      if (sendFailure) {
        return {
          action: 'queue',
          rejectReason: mapSendFailureToRejectReason(sendFailure.reason),
          barrierReason: 'repair-server-not-ready',
          detailReason: `send-${sendFailure.reason}`,
          ttlMs: transportOutboxTtlMs,
        };
      }

      if (!sessionReadyRef.current) {
        return {
          action: 'queue',
          rejectReason: 'timeout',
          barrierReason: 'repair-server-not-ready',
          detailReason: 'session-not-ready',
          ttlMs: transportOutboxTtlMs,
        };
      }

      return {
        action: 'reject',
        rejectReason: 'transport-closed',
        barrierReason: 'none',
        detailReason: 'send-unavailable',
        ttlMs: transportOutboxTtlMs,
      };
    }, []);

    const scheduleTransportOutboxExpiry = useCallback((ttlMs: number) => {
      const timer = setTimeout(() => {
        transportOutboxExpiryTimersRef.current.delete(timer);
        const now = Date.now();
        const remaining: TransportOutboxEntry[] = [];
        let remainingBytes = 0;

        for (const entry of transportOutboxRef.current) {
          if (now > entry.expiresAt) {
            recordTransportInputRejected(
              'transport_input_rejected',
              entry,
              entry.containsEnter ? 'timeout-enter-safety' : 'timeout',
              entry.containsEnter ? 'timeout-enter-safety' : 'timeout',
              entry.source,
              entry.queuedAt,
              entry.barrierReason,
            );
            continue;
          }
          remaining.push(entry);
          remainingBytes += entry.byteLength;
        }

        transportOutboxRef.current = remaining;
        transportOutboxBytesRef.current = remainingBytes;
      }, ttlMs + 25);
      transportOutboxExpiryTimersRef.current.add(timer);
    }, [recordTransportInputRejected]);

    const enqueueTransportInput = useCallback((
      input: SequencedTerminalInput,
      decision: TransportQueueDecision,
      source: string,
    ) => {
      const mode = getInputReliabilityMode();
      if (mode === 'observe') {
        recordTransportInputQueueEvent('transport_input_would_queue', input, {
          reason: 'mode-observe-only',
          source,
          barrierReason: decision.barrierReason,
          detailReason: decision.detailReason,
          sessionGeneration: sessionGenerationRef.current,
          reconnectState: wsStatusRef.current,
        });
        return;
      }

      const debugInput = resolveInputDebugPayload(input.data, input.metadata, sessionId);
      const byteLength =
        typeof debugInput.details.byteLength === 'number'
          ? debugInput.details.byteLength
          : getUtf8ByteLength(input.data);
      const { transportOutboxMaxBytes } = getTransportOutboxLimits();
      const now = Date.now();
      const entry: TransportOutboxEntry = {
        ...input,
        metadata: input.metadata ?? buildClientInputDebugMetadata(debugInput.details),
        queuedAt: now,
        expiresAt: now + decision.ttlMs,
        sessionGeneration: sessionGenerationRef.current,
        containsEnter: input.metadata?.clientObservedHasEnter === true || inputContainsEnter(input.data),
        byteLength,
        barrierReason: decision.barrierReason,
        source,
        detailReason: decision.detailReason,
      };

      if (entry.byteLength > transportOutboxMaxBytes) {
        recordTransportInputQueueEvent('transport_input_queue_overflow', entry, {
          reason: 'queue-overflow',
          source,
          attemptedByteLength: entry.byteLength,
          pendingQueueBytes: transportOutboxBytesRef.current,
          queuedByteBudget: transportOutboxMaxBytes,
        });
        recordTransportInputRejected(
          'transport_input_rejected',
          entry,
          'queue-overflow',
          'queue-overflow',
          source,
          entry.queuedAt,
          entry.barrierReason,
        );
        return;
      }

      transportOutboxRef.current.push(entry);
      transportOutboxBytesRef.current += entry.byteLength;
      while (
        transportOutboxBytesRef.current > transportOutboxMaxBytes
        && transportOutboxRef.current.length > 0
      ) {
        const overflowed = transportOutboxRef.current.shift();
        if (!overflowed) {
          break;
        }
        transportOutboxBytesRef.current -= overflowed.byteLength;
        recordTransportInputQueueEvent('transport_input_queue_overflow', overflowed, {
          reason: 'queue-overflow',
          source: overflowed.source,
          pendingQueueBytes: transportOutboxBytesRef.current,
          queuedByteBudget: transportOutboxMaxBytes,
        });
        recordTransportInputRejected(
          'transport_input_rejected',
          overflowed,
          'queue-overflow',
          'queue-overflow',
          overflowed.source,
          overflowed.queuedAt,
          overflowed.barrierReason,
        );
      }

      recordTransportInputQueueEvent('transport_input_queued', entry, {
        source,
        barrierReason: decision.barrierReason,
        detailReason: decision.detailReason,
        sessionGeneration: entry.sessionGeneration,
        ttlMs: decision.ttlMs,
        pendingQueueDepth: transportOutboxRef.current.length,
        pendingQueueBytes: transportOutboxBytesRef.current,
      });
      scheduleTransportOutboxExpiry(decision.ttlMs);
    }, [
      recordTransportInputQueueEvent,
      recordTransportInputRejected,
      scheduleTransportOutboxExpiry,
      sessionId,
    ]);

    const transmitSequencedInput = useCallback((
      input: SequencedTerminalInput,
      source: string,
    ): SendResult => {
      const debugInput = resolveInputDebugPayload(input.data, input.metadata, sessionId);
      const metadata = input.metadata ?? buildClientInputDebugMetadata(debugInput.details);
      const result = send({
        type: 'input',
        sessionId,
        data: input.data,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        metadata,
      });

      if (result.ok) {
        recordTerminalDebugEvent(sessionId, 'ws_input_sent', {
          ...debugInput.details,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          logicalChunkCount: input.logicalChunkCount,
          source,
          sessionGeneration: sessionGenerationRef.current,
        }, debugInput.preview);
      }

      return result;
    }, [send, sessionId]);

    const restoreTransportOutboxFront = useCallback((entries: TransportOutboxEntry[]) => {
      if (entries.length === 0) {
        return;
      }
      transportOutboxRef.current = [...entries, ...transportOutboxRef.current];
      transportOutboxBytesRef.current = transportOutboxRef.current.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
      const nextExpiry = Math.max(
        0,
        Math.min(...entries.map(entry => entry.expiresAt)) - Date.now(),
      );
      scheduleTransportOutboxExpiry(nextExpiry);
    }, [scheduleTransportOutboxExpiry]);

    const flushTransportOutbox = useCallback((reason: string) => {
      if (transportOutboxRef.current.length === 0) {
        return;
      }

      const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);
      const readyForFlush = Boolean(
        isVisibleRef.current
        && transportClosedReasonRef.current === 'none'
        && sessionReadyRef.current
        && wsStatusRef.current === 'connected'
        && compatibilityPostAckConvergenceRef.current === null
        && visibleRecoveryBarrier === 'none',
      );
      if (!readyForFlush) {
        const blockedDecision = classifyTransportQueueDecision();
        if (blockedDecision.action === 'reject') {
          rejectTransportOutbox(blockedDecision.rejectReason, blockedDecision.detailReason);
        }
        return;
      }

      const entries = transportOutboxRef.current;
      transportOutboxRef.current = [];
      transportOutboxBytesRef.current = 0;
      const now = Date.now();

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.sessionGeneration !== sessionGenerationRef.current) {
          recordTransportInputRejected(
            'transport_input_rejected',
            entry,
            'context-changed',
            'context-changed',
            entry.source,
            entry.queuedAt,
            entry.barrierReason,
          );
          continue;
        }
        if (now > entry.expiresAt) {
          recordTransportInputRejected(
            'transport_input_rejected',
            entry,
            entry.containsEnter ? 'timeout-enter-safety' : 'timeout',
            entry.containsEnter ? 'timeout-enter-safety' : 'timeout',
            entry.source,
            entry.queuedAt,
            entry.barrierReason,
          );
          continue;
        }

        const result = transmitSequencedInput(entry, `outbox-${reason}`);
        if (!result.ok) {
          const retryDecision = classifyTransportQueueDecision(result);
          if (retryDecision.action === 'queue' && getInputReliabilityMode() !== 'observe') {
            const remainingEntries = entries.slice(index);
            restoreTransportOutboxFront(remainingEntries);
            recordTransportInputQueueEvent('transport_input_queued', entry, {
              reason: 'flush-deferred',
              source: entry.source,
              barrierReason: retryDecision.barrierReason,
              detailReason: retryDecision.detailReason,
              pendingQueueDepth: transportOutboxRef.current.length,
              pendingQueueBytes: transportOutboxBytesRef.current,
            });
            setTimeout(() => {
              flushTransportOutbox(`retry-${retryDecision.detailReason}`);
            }, 50);
            return;
          }

          recordTransportInputRejected(
            'transport_input_rejected',
            entry,
            retryDecision.rejectReason,
            retryDecision.detailReason,
            entry.source,
            entry.queuedAt,
            entry.barrierReason,
          );
          for (const remaining of entries.slice(index + 1)) {
            recordTransportInputRejected(
              'transport_input_rejected',
              remaining,
              retryDecision.rejectReason,
              retryDecision.detailReason,
              remaining.source,
              remaining.queuedAt,
              remaining.barrierReason,
            );
          }
          return;
        }

        recordTransportInputQueueEvent('transport_input_flushed', entry, {
          reason,
          source: entry.source,
          barrierReason: entry.barrierReason,
          queuedMs: Math.max(0, now - entry.queuedAt),
          sessionGeneration: entry.sessionGeneration,
        });
      }
    }, [
      classifyTransportQueueDecision,
      recordTransportInputQueueEvent,
      recordTransportInputRejected,
      rejectTransportOutbox,
      restoreTransportOutboxFront,
      transmitSequencedInput,
    ]);

    const deliverSequencedInput = useCallback((
      input: SequencedTerminalInput,
      reason: string,
    ) => {
      const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);
      if (
        sessionReadyRef.current
        && transportClosedReasonRef.current === 'none'
        && wsStatusRef.current === 'connected'
        && isVisibleRef.current
        && compatibilityPostAckConvergenceRef.current === null
        && visibleRecoveryBarrier === 'none'
      ) {
        const result = transmitSequencedInput(input, `sequencer-${reason}`);
        if (result.ok) {
          return;
        }

        const decision = classifyTransportQueueDecision(result);
        if (decision.action === 'queue') {
          enqueueTransportInput(input, decision, `send-failure-${result.reason}`);
          setTimeout(() => {
            flushTransportOutbox(`send-failure-${result.reason}`);
          }, 25);
          return;
        }

        const mode = getInputReliabilityMode();
        recordTransportInputRejected(
          mode === 'observe' ? 'transport_input_would_reject' : 'transport_input_rejected',
          input,
          decision.rejectReason,
          decision.detailReason,
          `send-failure-${result.reason}`,
          undefined,
          decision.barrierReason,
        );
        return;
      }

      const decision = classifyTransportQueueDecision();
      if (decision.action === 'queue') {
        enqueueTransportInput(input, decision, `sequencer-${reason}`);
        return;
      }

      const mode = getInputReliabilityMode();
      recordTransportInputRejected(
        mode === 'observe' ? 'transport_input_would_reject' : 'transport_input_rejected',
        input,
        decision.rejectReason,
        decision.detailReason,
        `sequencer-${reason}`,
        undefined,
        decision.barrierReason,
      );
    }, [
      classifyTransportQueueDecision,
      enqueueTransportInput,
      flushTransportOutbox,
      recordTransportInputRejected,
      transmitSequencedInput,
    ]);

    deliverSequencedInputRef.current = deliverSequencedInput;

    const flushTransportPipeline = useCallback((reason: string) => {
      inputSequencerRef.current?.flush(reason);
      flushTransportOutbox(reason);
      return transportOutboxRef.current.length === 0;
    }, [flushTransportOutbox]);

    useEffect(() => {
      if (generationSessionIdRef.current !== sessionId) {
        // The outgoing id, before it is overwritten. The generation bump below
        // already makes that entry unreadable, but only dropping it by its own
        // key actually removes it — otherwise every session this view has ever
        // shown stays in the map for the life of the component.
        liveOutputTokenRef.current.forget(generationSessionIdRef.current);
        generationSessionIdRef.current = sessionId;
        bumpSessionGeneration('session-id-changed');
      }
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
      pendingSnapshotRef.current = null;
      latestReceivedSnapshotReadyIdentityRef.current = null;
      // Cleared alongside its sibling above, and unconditionally like the rest
      // of this block. The generation bump at the top of this effect only fires
      // when the sessionId actually changed, but the effect also re-runs on a
      // callback identity change — and on that path the sibling identity is
      // discarded while a generation-stamped token would survive.
      liveOutputTokenRef.current.forget(sessionId);
      pendingCheckpointAuthoritySnapshotRef.current = null;
      compatibilityAuthorityReadyRef.current = false;
      snapshotApplyInProgressRef.current = false;
      sessionReadyRef.current = false;
      visibleOutputRecoveryStateRef.current = createVisibleOutputRecoveryState();
      visibleOutputRecoveryAttemptBudgetRef.current.resetForNewScope();
      compatibilityPostAckConvergenceRef.current = null;
      compatibilityPostAckTimeoutRef.current?.clear();
      compatibilityPostAckTimeoutRef.current = null;
      if (visibleRepairTimerRef.current) {
        clearTimeout(visibleRepairTimerRef.current);
        visibleRepairTimerRef.current = null;
      }
      gridRepairInFlightRef.current = null;
      gridVisibleRef.current = false;
      pendingGridScreenRepairRef.current = null;
      screenRepairInFlightRef.current = null;
      lastCompletedScreenRepairRef.current = null;
      if (resizeRepairTimerRef.current) {
        clearTimeout(resizeRepairTimerRef.current);
        resizeRepairTimerRef.current = null;
      }
      transportClosedReasonRef.current = 'none';
      reconnectStartedAtRef.current = null;
      if (reconnectTtlTimerRef.current) {
        clearTimeout(reconnectTtlTimerRef.current);
        reconnectTtlTimerRef.current = null;
      }
      lastResizeRef.current = null;
      lastSentResizeRef.current = null;
      lastStatusRef.current = null;
      inputSequencerRef.current?.reset(1);
      supersededVisibleOutputResyncKeysRef.current.clear();
      visibleOutputResyncEpochRef.current += 1;
      visibleOutputMutationFenceRef.current?.invalidateSpeculative();
      rejectTransportOutbox('context-changed', 'session-attached-reset');
      lastAppliedSnapshotRef.current = null;
      syncInputTransportState('session-attached');
      recordTerminalDebugEvent(sessionId, 'session_attached');
      return () => {
        compatibilityPostAckConvergenceRef.current = null;
        compatibilityPostAckTimeoutRef.current?.clear();
        compatibilityPostAckTimeoutRef.current = null;
        const activeResync = activeVisibleOutputResyncRef.current;
        if (activeResync) {
          activeResync.clearRecoveryTimers();
          activeResync.restoreAdapter.handle({
            type: 'dispose',
          });
          activeVisibleOutputResyncRef.current = null;
        }
        markTransportClosed('workspace-or-session-changed', 'session-detached');
        syncInputTransportState('session-detached');
        flushTransportPipeline('session-detached');
        rejectTransportOutbox('context-changed', 'session-detached');
        recordTerminalDebugEvent(sessionId, 'session_detached');
      };
    }, [
      bumpSessionGeneration,
      flushTransportPipeline,
      markTransportClosed,
      rejectTransportOutbox,
      sessionId,
      syncInputTransportState,
    ]);

    useEffect(() => {
      recordTerminalDebugEvent(sessionId, 'visibility_changed', {
        visible: isVisible,
      });
      publishTerminalDeliveryVisibility({
        sessionId,
        isVisible: isVisible && isGridSurface,
        deliveryInterestRefCount: 1,
      });
    }, [isGridSurface, isVisible, publishTerminalDeliveryVisibility, sessionId]);

    const sendResizeIfNeeded = useCallback((cols: number, rows: number, reason: string) => {
      const lastSent = lastSentResizeRef.current;
      if (lastSent && lastSent.cols === cols && lastSent.rows === rows) {
        recordTerminalDebugEvent(sessionId, 'grid_repair_resize_suppressed', {
          reason,
          cols,
          rows,
        });
        return;
      }

      recordTerminalDebugEvent(sessionId, 'grid_repair_resize_sent', {
        reason,
        cols,
        rows,
      });
      const resizeResult = send({ type: 'resize', sessionId, cols, rows });
      if (resizeResult.ok) {
        lastSentResizeRef.current = { cols, rows };
        return;
      }

      recordTerminalDebugEvent(sessionId, 'grid_repair_resize_send_failed', {
        reason,
        sendResultReason: resizeResult.reason,
        reconnectState: wsStatusRef.current,
      });
    }, [send, sessionId]);

    const shouldSuppressScreenRepairRequest = useCallback((
      reason: GridRepairReason,
      cols: number,
      rows: number,
    ): boolean => {
      const inFlight = screenRepairInFlightRef.current;
      if (inFlight && inFlight.sessionId === sessionId && inFlight.cols === cols && inFlight.rows === rows) {
        return true;
      }

      if (reason !== 'manual') {
        const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);
        if (visibleRecoveryBarrier !== 'none') {
          return false;
        }

        const completed = lastCompletedScreenRepairRef.current;
        if (
          completed
          && completed.sessionId === sessionId
          && completed.cols === cols
          && completed.rows === rows
          && Date.now() - completed.completedAt < 400
        ) {
          return true;
        }
      }

      return false;
    }, [sessionId]);

    const finishHiddenOutputRecovery = useCallback((source: string, restored: boolean) => {
      if (!hiddenOutputStateRef.current.skipped && !hiddenOutputReplayStateRef.current.pending) {
        return;
      }

      hiddenOutputStateRef.current = clearHiddenOutputState(hiddenOutputStateRef.current);
      const transition = finishHiddenOutputReplay(
        hiddenOutputReplayStateRef.current,
        initialRestorePendingRef.current,
      );
      hiddenOutputReplayStateRef.current = transition.replayState;
      initialRestorePendingRef.current = transition.initialRestorePending;
      recordTerminalDebugEvent(sessionId, 'hidden_output_recovery_finished', {
        source,
        restored,
      });
    }, [sessionId]);

    const finishVisibleOutputRecoveryIfPending = useCallback((
      source: string,
      options: { keepTerminalStale?: boolean } = {},
    ) => {
      if (!visibleOutputRecoveryStateRef.current.pending && !visibleOutputRecoveryStateRef.current.staleTerminal) {
        return;
      }

      visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(
        visibleOutputRecoveryStateRef.current,
        options,
      );
      if (!visibleOutputRecoveryStateRef.current.staleTerminal) {
        terminalRef.current?.clearVisibleOutputRecovery();
      }
      recordTerminalDebugEvent(sessionId, 'visible_output_recovery_finished', {
        source,
        keepTerminalStale: Boolean(options.keepTerminalStale),
      });
      const finishReason = `visible-output-recovery-finished-${source}`;
      syncInputTransportState(finishReason);
      flushTransportOutbox(finishReason);
    }, [flushTransportOutbox, sessionId, syncInputTransportState]);

    const handleScreenSnapshotAckSendFailure = useCallback((
      snapshot: SnapshotPayload,
      path: 'stale' | 'duplicate' | 'applied' | 'checkpoint-authority-ignored'
        | 'checkpoint-authority-superseded-in-flight',
      reason: Exclude<SendResult, { ok: true }>['reason'],
    ) => {
      recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_send_failed', {
        seq: snapshot.seq,
        mode: snapshot.mode,
        reason,
        path,
      });
      visibleOutputResyncEpochRef.current += 1;
      visibleOutputMutationFenceRef.current?.invalidateSpeculative();
      sessionReadyRef.current = false;
      const started = beginVisibleOutputRecovery(
        finishVisibleOutputRecovery(visibleOutputRecoveryStateRef.current),
      );
      visibleOutputRecoveryStateRef.current = started.state;
      finishVisibleOutputRecoveryIfPending('screen-snapshot-ack-send-failed', {
        keepTerminalStale: true,
      });
      requestBoundedVisibleRecoveryReconnect('screen-snapshot-ack-send-failed');
    }, [finishVisibleOutputRecoveryIfPending, requestBoundedVisibleRecoveryReconnect, sessionId]);

    // @req REL-BGSTAB-008
    const recordVisibleOutputResyncState = useCallback((
      runtime: ActiveVisibleOutputResync,
      source: string,
    ) => {
      const state = runtime.coordinator.getState(runtime.scope);
      if (!state) {
        return;
      }
      recordTerminalDebugEvent(sessionId, 'visible_output_resync_state', {
        source,
        transactionId: state.transactionId,
        repairToken: state.repairToken,
        replayToken: state.replayToken,
        connectionGeneration: state.connectionGeneration,
        sessionGeneration: state.sessionGeneration,
        viewGeneration: state.viewGeneration,
        xtermGeneration: state.xtermGeneration,
        staleTerminal: state.staleTerminal,
        terminalFailed: state.terminalFailed,
        currentViewTransactionReady: state.currentViewTransactionReady,
        retainedHistoryEquivalent: false,
        provisionalLocalState: state.provisionalLocalState,
        hiddenDirty: state.hiddenDirty,
        hiddenSkipped: state.hiddenSkipped,
        hiddenSkippedBytes: runtime.hiddenSkippedBytes,
        heldOutputBytes: state.heldOutputBytes,
        heldOutputChunks: state.heldChunks.length,
        activeTimerCount: state.activeTimerCount,
        activeListenerCount: state.activeListenerCount,
        activeTransactionCount: activeVisibleOutputResyncRef.current === runtime ? 1 : 0,
        disposed: state.disposed,
      });
    }, [sessionId]);

    const recordCompatibilityPostAckState = useCallback((
      state: TerminalCompatibilityPostAckConvergenceState,
      source: string,
    ) => {
      recordTerminalDebugEvent(sessionId, 'visible_output_resync_state', {
        source,
        transactionId: `compatibility:${state.replayToken}:${state.snapshotSeq}`,
        repairToken: null,
        replayToken: state.replayToken,
        snapshotSeq: state.snapshotSeq,
        connectionGeneration: state.connectionGeneration,
        sessionGeneration: state.sessionGeneration,
        viewGeneration: state.viewGeneration,
        xtermGeneration: state.viewGeneration,
        staleTerminal: false,
        terminalFailed: false,
        currentViewTransactionReady: state.currentViewTransactionReady,
        retainedHistoryEquivalent: false,
        provisionalLocalState: !state.currentViewTransactionReady,
        hiddenDirty: false,
        hiddenSkipped: false,
        hiddenSkippedBytes: 0,
        heldOutputBytes: state.heldOutputBytes,
        heldOutputChunks: state.pendingOutputIds.length,
        activeTimerCount: state.pendingOutputIds.length,
        activeListenerCount: state.currentViewTransactionReady ? 0 : 1,
        activeTransactionCount: state.currentViewTransactionReady ? 0 : 1,
        acknowledgementReceived: state.acknowledgementReceived,
        serverReadyLatched: state.serverReadyLatched,
        receivedOutputChunks: state.receivedOutputChunks,
        receivedOutputBytes: state.receivedOutputBytes,
        disposed: false,
      });
    }, [sessionId]);

    const isCurrentCompatibilityPostAckState = useCallback((
      state: TerminalCompatibilityPostAckConvergenceState,
    ): boolean => (
      compatibilityPostAckConvergenceRef.current === state
      && state.sessionId === sessionId
      && state.connectionGeneration === wsConnectionGenerationRef.current
      && state.sessionGeneration === sessionGenerationRef.current
    ), [sessionId]);

    const clearCompatibilityPostAckTimeout = useCallback(() => {
      compatibilityPostAckTimeoutRef.current?.clear();
      compatibilityPostAckTimeoutRef.current = null;
    }, []);

    const failCompatibilityPostAckConvergence = useCallback((reason: string) => {
      const state = compatibilityPostAckConvergenceRef.current;
      if (!state) return;
      clearCompatibilityPostAckTimeout();
      recordCompatibilityPostAckState(state, `compatibility-post-ack-failed:${reason}`);
      compatibilityPostAckConvergenceRef.current = null;
      sessionReadyRef.current = false;
      syncInputTransportState('compatibility-post-ack-failed');
      requestBoundedVisibleRecoveryReconnect(`compatibility-post-ack-failed:${reason}`);
    }, [
      clearCompatibilityPostAckTimeout,
      recordCompatibilityPostAckState,
      requestBoundedVisibleRecoveryReconnect,
      syncInputTransportState,
    ]);

    const armCompatibilityPostAckTimeout = useCallback((
      state: TerminalCompatibilityPostAckConvergenceState,
    ) => {
      clearCompatibilityPostAckTimeout();
      compatibilityPostAckTimeoutRef.current = createTerminalCompatibilityProgressTimeout({
        timeoutMs: TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS,
        onTimeout: () => {
          const current = compatibilityPostAckConvergenceRef.current;
          if (
            current
            && current.sessionId === state.sessionId
            && current.replayToken === state.replayToken
            && current.snapshotSeq === state.snapshotSeq
            && current.connectionGeneration === state.connectionGeneration
            && current.sessionGeneration === state.sessionGeneration
            && current.viewGeneration === state.viewGeneration
          ) {
            failCompatibilityPostAckConvergence('convergence-timeout');
          }
        },
      });
      compatibilityPostAckTimeoutRef.current.progress();
    }, [clearCompatibilityPostAckTimeout, failCompatibilityPostAckConvergence]);

    const recordCompatibilityPostAckProgress = useCallback(() => {
      compatibilityPostAckTimeoutRef.current?.progress();
    }, []);

    const finishCompatibilityPostAckConvergence = useCallback((
      state: TerminalCompatibilityPostAckConvergenceState,
    ) => {
      if (!state.currentViewTransactionReady || !isCurrentCompatibilityPostAckState(state)) {
        return;
      }
      clearCompatibilityPostAckTimeout();
      recordCompatibilityPostAckState(state, 'authoritative-snapshot-tail-drained');
      recordTerminalDebugEvent(sessionId, 'terminal_compatibility_post_ack_tail_drained', {
        replayToken: state.replayToken,
        snapshotSeq: state.snapshotSeq,
        connectionGeneration: state.connectionGeneration,
        sessionGeneration: state.sessionGeneration,
        viewGeneration: state.viewGeneration,
        currentViewTransactionReady: true,
        heldOutputBytes: 0,
        heldOutputChunks: 0,
        receivedOutputChunks: state.receivedOutputChunks,
        receivedOutputBytes: state.receivedOutputBytes,
      });
      compatibilityPostAckConvergenceRef.current = null;
      finishHiddenOutputRecovery('compatibility-post-ack-tail', true);
      finishVisibleOutputRecoveryIfPending('authoritative-resync');
      visibleOutputRecoveryAttemptBudgetRef.current.resetAfterConvergence();
      syncInputTransportState('compatibility-post-ack-tail-drained');
      flushPendingGridScreenRepairRef.current();
    }, [
      finishHiddenOutputRecovery,
      finishVisibleOutputRecoveryIfPending,
      clearCompatibilityPostAckTimeout,
      isCurrentCompatibilityPostAckState,
      recordCompatibilityPostAckState,
      sessionId,
      syncInputTransportState,
    ]);

    useEffect(() => () => clearCompatibilityPostAckTimeout(), [clearCompatibilityPostAckTimeout]);

    const clearScreenRepairInFlightForTerminalOutcome = useCallback((
      outcome: 'restore-needed' | 'reconnect-required',
    ) => {
      const inFlight = screenRepairInFlightRef.current;
      if (!inFlight || inFlight.sessionId !== sessionId) {
        return;
      }
      screenRepairInFlightRef.current = null;
      recordTerminalDebugEvent(sessionId, 'screen_repair_in_flight_finished', {
        outcome,
        cols: inFlight.cols,
        rows: inFlight.rows,
        reason: inFlight.reason,
      });
    }, [sessionId]);

    // @req REL-BGSTAB-008
    const handleScreenRepairRestoreNeeded = useEffectEvent((
      message: ScreenRepairRestoreNeededMessage,
    ) => {
      if (!hasSameRestoreNeededAuthorityProof(message, message)) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_restore_invalid_proof_ignored', {
          repairToken: message.repairToken,
          replayToken: message.replayToken,
          snapshotSeq: message.snapshotSeq,
        });
        requestBoundedVisibleRecoveryReconnect('restore-needed-invalid-authority-proof');
        return;
      }
      const incomingKey = getVisibleOutputResyncTokenKey(message.repairToken, message.replayToken);
      if (supersededVisibleOutputResyncKeysRef.current.has(incomingKey)) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_restore_stale_ignored', {
          repairToken: message.repairToken,
          replayToken: message.replayToken,
        });
        return;
      }
      const previous = activeVisibleOutputResyncRef.current;
      if (previous) {
        if (
          message.repairToken === previous.repairToken
          && message.replayToken === previous.replayToken
          && message.snapshotSeq === previous.snapshotSeq
        ) {
          if (!hasSameRestoreNeededAuthorityProof(previous, message)) {
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_restore_proof_mismatch_ignored', {
              repairToken: message.repairToken,
              replayToken: message.replayToken,
              snapshotSeq: message.snapshotSeq,
            });
            requestBoundedVisibleRecoveryReconnect('restore-needed-authority-proof-mismatch');
            return;
          }
          recordTerminalDebugEvent(sessionId, 'visible_output_resync_restore_duplicate_ignored', {
            repairToken: message.repairToken,
            replayToken: message.replayToken,
            snapshotSeq: message.snapshotSeq,
          });
          return;
        }
        rememberSupersededVisibleResyncKey(
          supersededVisibleOutputResyncKeysRef.current,
          getVisibleOutputResyncTokenKey(previous.repairToken, previous.replayToken),
        );
        previous.clearRecoveryTimers();
        previous.restoreAdapter.handle({
          type: 'dispose',
        });
        activeVisibleOutputResyncRef.current = null;
      }
      clearScreenRepairInFlightForTerminalOutcome('restore-needed');
      visibleOutputResyncEpochRef.current += 1;
      visibleOutputMutationFenceRef.current?.invalidateSpeculative();

      const connectionGeneration = wsConnectionGenerationRef.current;
      const currentSessionGeneration = sessionGenerationRef.current;
      const scope: VisibleOutputRecoveryScope = {
        clientId: wsClientIdRef.current ?? 'client-unidentified',
        sessionId,
      };
      const transactionId = [
        message.repairToken,
        message.replayToken,
        connectionGeneration,
        currentSessionGeneration,
      ].join(':');
      const terminalLimits = getCachedTerminalOutputResourceLimits();
      const viewGeneration = visibleOutputResyncEpochRef.current;
      const xtermGeneration = visibleOutputResyncEpochRef.current;
      const runtime = {} as ActiveVisibleOutputResync;
      const restoreTimerHandles = new Map<string, ReturnType<typeof setTimeout>>();
      const restoreTimerChunkIds = new Map<string, string>();
      const completionProbeHandles = new Map<string, ReturnType<typeof setTimeout>>();
      const clearRestoreTimers = (): void => {
        for (const handle of restoreTimerHandles.values()) clearTimeout(handle);
        for (const handle of completionProbeHandles.values()) clearTimeout(handle);
        restoreTimerHandles.clear();
        restoreTimerChunkIds.clear();
        completionProbeHandles.clear();
      };
      const coordinator = createVisibleOutputRecoveryCoordinator({
        maxHeldBytes: terminalLimits.visibleOutputQueueMaxBytes,
        maxHeldChunks: terminalLimits.visibleOutputMaxChunks,
        transportMode: getWsTransportMode(),
        adapter: {
          // @req REL-BGSTAB-008
          enqueueScheduledOutput(write) {
            const terminal = terminalRef.current;
            const timerId = `write:${write.chunk.chunkId}`;
            restoreTimerChunkIds.set(timerId, write.chunk.chunkId);
            runtime.restoreAdapter.handle({
              type: 'arm-write-timeout',
              timerId,
              pendingChunkId: write.chunk.chunkId,
            });
            const completion = terminal?.writeAndWait(write.chunk.data) ?? Promise.resolve(false);
            void completion.then((written) => {
              if (activeVisibleOutputResyncRef.current !== runtime) {
                return;
              }
              if (written) {
                write.onWritten();
                recordVisibleOutputResyncState(runtime, 'held-output-written');
                return;
              }
              runtime.restoreAdapter.handle({
                type: 'recovery-failed',
                reason: 'parser-reset-failed',
              });
              visibleOutputMutationFenceRef.current?.invalidateSpeculative();
              visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(
                visibleOutputRecoveryStateRef.current,
                { keepTerminalStale: true },
              );
              recordVisibleOutputResyncState(runtime, 'held-output-write-failed');
              syncInputTransportState('visible-output-resync-write-failed');
            });
          },
          // @req REL-BGSTAB-009
          scheduleRestoreTimer(timer) {
            const existing = restoreTimerHandles.get(timer.timerId);
            if (existing) clearTimeout(existing);
            const handle = setTimeout(() => {
              restoreTimerHandles.delete(timer.timerId);
              const pendingChunkId = restoreTimerChunkIds.get(timer.timerId);
              restoreTimerChunkIds.delete(timer.timerId);
              if (activeVisibleOutputResyncRef.current !== runtime || !pendingChunkId) return;
              runtime.restoreAdapter.handle({
                type: 'write-callback-timeout',
                timerId: timer.timerId,
                pendingChunkId,
              });
            }, TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS);
            restoreTimerHandles.set(timer.timerId, handle);
          },
          // @req REL-BGSTAB-009
          cancelRestoreTimer(timerId) {
            const handle = restoreTimerHandles.get(timerId);
            if (handle) clearTimeout(handle);
            restoreTimerHandles.delete(timerId);
            restoreTimerChunkIds.delete(timerId);
          },
          // @req REL-BGSTAB-009
          enqueueCompletionProbe(probe) {
            const timeoutHandle = setTimeout(() => {
              completionProbeHandles.delete(probe.probeId);
              if (activeVisibleOutputResyncRef.current !== runtime) return;
              runtime.restoreAdapter.handle({
                type: 'completion-probe-timeout',
                probeId: probe.probeId,
                repairToken: runtime.repairToken,
                replayToken: runtime.replayToken,
              });
            }, TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS);
            completionProbeHandles.set(probe.probeId, timeoutHandle);
            const completion = terminalRef.current?.probeOutputFifo() ?? Promise.resolve(false);
            void completion.then((written) => {
              const currentHandle = completionProbeHandles.get(probe.probeId);
              if (currentHandle) clearTimeout(currentHandle);
              completionProbeHandles.delete(probe.probeId);
              if (activeVisibleOutputResyncRef.current !== runtime) return;
              if (!written) {
                runtime.restoreAdapter.handle({
                  type: 'completion-probe-timeout',
                  probeId: probe.probeId,
                  repairToken: runtime.repairToken,
                  replayToken: runtime.replayToken,
                });
                return;
              }
              probe.onWritten();
            });
          },
          // @req REL-BGSTAB-008
          setCurrentViewReady(change) {
            if (!change.ready || activeVisibleOutputResyncRef.current !== runtime) {
              return;
            }
            clearRestoreTimers();
            recordVisibleOutputResyncState(runtime, 'authoritative-snapshot-tail-drained');
            finishHiddenOutputRecovery('authoritative-resync', true);
            finishVisibleOutputRecoveryIfPending('authoritative-resync');
            // The coordinator reaches this callback only after the matching
            // snapshot ACK and matching server-ready token have both crossed
            // the generation fence.
            visibleOutputRecoveryAttemptBudgetRef.current.resetAfterConvergence();
            rememberSupersededVisibleResyncKey(
              supersededVisibleOutputResyncKeysRef.current,
              getVisibleOutputResyncTokenKey(runtime.repairToken, runtime.replayToken),
            );
            activeVisibleOutputResyncRef.current = null;
            // Only the repairToken died here. The store cannot drop one field,
            // so it drops both and puts the replayToken straight back.
            //
            // Putting it back is not belt-and-braces: the snapshot that
            // converged this resync had to carry `runtime.replayToken` — the
            // authority proof compares them for equality — so that token is the
            // one on screen, and `lastAppliedSnapshotRef` still holds it as a
            // live comparison operand. Convergence also schedules no further
            // snapshot, so dropping it would leave the store empty until the
            // next recovery, which is exactly the stretch it exists to cover
            // (`08:209` — outside R1/R2 the live path has nowhere else to learn
            // it, and `activeVisibleOutputResyncRef` is null from here).
            liveOutputTokenRef.current.forget(sessionId);
            recordLiveOutputTokens({ replayToken: runtime.replayToken });
          },
          // @req REL-BGSTAB-008
          abortRepair(aborted) {
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_repair_aborted', {
              repairToken: aborted.repairToken,
            });
          },
          // @req REL-BGSTAB-008
          requestFreshSnapshot(request) {
            const budgetDecision = visibleOutputRecoveryAttemptBudgetRef.current.consume('fresh-snapshot');
            if (!budgetDecision.allowed) {
              recordTerminalDebugEvent(sessionId, 'visible_output_resync_retry_budget_exhausted', {
                kind: 'fresh-snapshot',
                replayToken: request.replayToken,
                reason: request.reason,
                attempts: budgetDecision.attempt,
              });
              return;
            }
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_snapshot_requested', {
              replayToken: request.replayToken,
              reason: request.reason,
              attempt: budgetDecision.attempt,
            });
            const result = send({
              type: 'repair-replay',
              sessionId,
              supersedeReplayToken: request.replayToken,
              repairToken: runtime.repairToken,
            });
            if (!result.ok) {
              requestBoundedVisibleRecoveryReconnect('fresh-snapshot-send-failed');
            }
          },
          // @req REL-BGSTAB-008
          publishOutcome(outcome) {
            clearRestoreTimers();
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_outcome', {
              outcome: outcome.outcome,
              reason: outcome.reason,
            });
          },
          // @req REL-BGSTAB-008
          acknowledgeRepairSuccess(ack) {
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_ready', {
              repairToken: ack.repairToken,
              replayToken: runtime.replayToken,
              snapshotSeq: runtime.snapshotSeq,
              retainedHistoryEquivalent: false,
            });
            const ackResult = send({
              type: 'screen-snapshot:ready',
              sessionId,
              replayToken: runtime.replayToken,
              snapshotSeq: runtime.snapshotSeq,
            });
            runtime.restoreAdapter.handle({
              type: ackResult.ok ? 'repair-acknowledged' : 'repair-ack-failed',
              reason: ackResult.ok ? undefined : ackResult.reason,
            });
          },
          // @req REL-BGSTAB-008
          directWrite() {
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_direct_write_blocked');
          },
          // @req REL-BGSTAB-008
          activateSplitOutput() {
            recordTerminalDebugEvent(sessionId, 'visible_output_resync_split_activation_blocked');
          },
        },
      });
      const restoreIdentity = {
        transactionId,
        repairToken: message.repairToken,
        replayToken: message.replayToken,
        connectionGeneration,
        sessionGeneration: currentSessionGeneration,
        viewGeneration,
        xtermGeneration,
      };
      const restoreAdapter = createTerminalContainerRestoreAdapter({
        coordinator,
        scope,
        identity: restoreIdentity,
      });
      const restoreTerminal = terminalRef.current;
      restoreTerminal?.bindRestoreCoordinator({
        coordinator,
        scope,
        identity: restoreIdentity,
      });
      const liveLaneIdlePromise = restoreTerminal?.awaitOutputIdle() ?? Promise.resolve(false);
      Object.assign(runtime, {
        coordinator,
        restoreAdapter,
        scope,
        transactionId,
        repairToken: message.repairToken,
        replayToken: message.replayToken,
        snapshotSeq: message.snapshotSeq,
        authorityEpoch: message.authorityEpoch!,
        authorityRevision: message.authorityRevision!,
        coversThroughSeq: message.coversThroughSeq!,
        supersedesReplayToken: message.supersedesReplayToken,
        connectionGeneration,
        sessionGeneration: currentSessionGeneration,
        hiddenSkippedBytes: hiddenOutputStateRef.current.skippedBytes,
        nextChunkOrdinal: 0,
        matchingServerReadyLatched: false,
        viewGeneration,
        xtermGeneration,
        liveLaneIdlePromise,
        clearRecoveryTimers: clearRestoreTimers,
      });
      const started = restoreAdapter.begin({
        serverReadyLatched: false,
        hiddenDirty: hiddenOutputStateRef.current.skipped,
        hiddenSkipped: hiddenOutputStateRef.current.skipped,
      });
      if (started.ignored || !started.state) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_ignored', {
          reason: 'transport-mode-limitation',
          requestedTransportMode: getWsTransportMode(),
        });
        return;
      }

      started.state.staleTerminal = true;
      activeVisibleOutputResyncRef.current = runtime;
      // Recorded here rather than on arrival, because most early returns above
      // reject the message as invalid, stale or duplicate.
      //
      // ⚠️ Not all of them do. The transport-mode return is a client capability
      // limitation, not a rejection — in split mode `restoreAdapter.begin()`
      // returns `ignored` and this line is never reached even though the
      // message's tokens are valid and current. Consequence: in split mode the
      // repairToken reaches the store only through `handleScreenRepair`.
      recordLiveOutputTokens({
        replayToken: runtime.replayToken,
        repairToken: runtime.repairToken,
      });
      void liveLaneIdlePromise.then((idle) => {
        if (activeVisibleOutputResyncRef.current !== runtime) return;
        restoreTerminal?.clearVisibleOutputRecovery();
        if (!idle) {
          runtime.restoreAdapter.handle({
            type: 'recovery-failed',
            reason: 'parser-reset-failed',
          });
          return;
        }
        runtime.restoreAdapter.handle({ type: 'live-lane-idle' });
      });
      sessionReadyRef.current = false;
      const cleared = finishVisibleOutputRecovery(visibleOutputRecoveryStateRef.current);
      visibleOutputRecoveryStateRef.current = beginVisibleOutputRecovery(cleared).state;
      syncInputTransportState('screen-repair-restore-needed');
      recordTerminalDebugEvent(sessionId, 'screen_repair_restore_needed', {
        repairToken: message.repairToken,
        replayToken: message.replayToken,
        snapshotSeq: message.snapshotSeq,
        reason: message.reason,
        outcome: message.outcome,
      });
      recordVisibleOutputResyncState(runtime, 'restore-needed');
    });

    // @req REL-BGSTAB-008
    const handleScreenRepairReconnectRequired = useEffectEvent((
      message: ScreenRepairReconnectRequiredMessage,
    ) => {
      const runtime = activeVisibleOutputResyncRef.current;
      if (runtime) {
        if (message.repairToken !== runtime.repairToken) {
          recordTerminalDebugEvent(sessionId, 'visible_output_resync_reconnect_stale_ignored', {
            repairToken: message.repairToken,
          });
          return;
        }
        clearScreenRepairInFlightForTerminalOutcome('reconnect-required');
        runtime.restoreAdapter.handle({
          type: 'recovery-failed',
          reason: message.reason,
          outcome: message.outcome,
        });
        visibleOutputMutationFenceRef.current?.invalidateSpeculative();
        recordVisibleOutputResyncState(runtime, 'reconnect-required');
        syncInputTransportState('screen-repair-reconnect-required');
        recordTerminalDebugEvent(sessionId, 'screen_repair_reconnect_required', {
          repairToken: message.repairToken,
          reason: message.reason,
          outcome: message.outcome,
        });
        requestBoundedVisibleRecoveryReconnect('screen-repair-reconnect-required');
        return;
      }
      clearScreenRepairInFlightForTerminalOutcome('reconnect-required');
      visibleOutputResyncEpochRef.current += 1;
      visibleOutputMutationFenceRef.current?.invalidateSpeculative();
      const started = beginVisibleOutputRecovery(
        finishVisibleOutputRecovery(visibleOutputRecoveryStateRef.current),
      );
      visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(started.state, {
        keepTerminalStale: true,
      });
      syncInputTransportState('screen-repair-reconnect-required');
      recordTerminalDebugEvent(sessionId, 'screen_repair_reconnect_required', {
        repairToken: message.repairToken,
        reason: message.reason,
        outcome: message.outcome,
      });
      requestBoundedVisibleRecoveryReconnect('screen-repair-reconnect-required');
    });

    // @req REL-BGSTAB-008
    const applyActiveVisibleResyncSnapshot = useCallback((snapshot: SnapshotPayload): boolean => {
      const activeResync = activeVisibleOutputResyncRef.current;
      const activeState = activeResync?.coordinator.getState(activeResync.scope);
      if (
        !activeResync
        || !activeState
        || activeState.terminalFailed
        || activeState.disposed
        || !matchesRestoreNeededSnapshotAuthorityProof(activeResync, snapshot)
        || activeResync.connectionGeneration !== wsConnectionGenerationRef.current
        || activeResync.sessionGeneration !== sessionGenerationRef.current
      ) {
        return false;
      }
      if (snapshot.mode === 'authoritative') {
        activeResync.restoreAdapter.handle({
          type: 'authoritative-snapshot-applied',
          snapshotSeq: snapshot.seq,
          parserBoundary: snapshot.parserComplete === false ? 'incomplete' : 'complete',
          parserComplete: snapshot.parserComplete,
          pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi ?? '',
          authorityRevision: snapshot.authorityRevision,
        });
        recordVisibleOutputResyncState(activeResync, 'authoritative-snapshot-applied');
      } else {
        const state = activeResync.coordinator.getState(activeResync.scope);
        if (state) {
          state.staleTerminal = true;
          state.currentViewTransactionReady = false;
          state.retainedHistoryEquivalent = false;
          state.provisionalLocalState = true;
        }
        recordVisibleOutputResyncState(activeResync, 'provisional-snapshot-applied');
      }
      return true;
    }, [recordVisibleOutputResyncState]);

    const requestScreenRepair = useCallback((reason: GridRepairReason) => {
      if (!isVisibleRef.current) {
        return;
      }

      if (!sessionReadyRef.current) {
        pendingGridScreenRepairRef.current = reason;
        recordTerminalDebugEvent(sessionId, 'screen_repair_deferred_not_ready', { reason });
        return;
      }

      const readiness = terminalRef.current?.getScreenRepairReadiness();
      if (!readiness) {
        pendingGridScreenRepairRef.current = reason;
        recordTerminalDebugEvent(sessionId, 'screen_repair_deferred_not_ready', {
          reason,
          detailReason: 'terminal-missing',
        });
        return;
      }
      if (!readiness.ok) {
        const eventName = readiness.reason === 'user-scrolled'
          ? 'screen_repair_deferred_user_scrollback'
          : `screen_repair_deferred_${readiness.reason.replace(/-/g, '_')}`;
        recordTerminalDebugEvent(sessionId, eventName, {
          reason,
          detailReason: readiness.reason,
          cols: readiness.cols ?? null,
          rows: readiness.rows ?? null,
          atBottom: readiness.atBottom ?? null,
          bufferType: readiness.bufferType ?? null,
        });
        if (readiness.reason === 'not-ready') {
          pendingGridScreenRepairRef.current = reason;
        }
        return;
      }

      const geometry = lastResizeRef.current ?? { cols: readiness.cols, rows: readiness.rows };
      sendResizeIfNeeded(geometry.cols, geometry.rows, reason);
      if (shouldSuppressScreenRepairRequest(reason, geometry.cols, geometry.rows)) {
        recordTerminalDebugEvent(sessionId, 'screen_repair_request_suppressed', {
          reason,
          cols: geometry.cols,
          rows: geometry.rows,
        });
        return;
      }

      recordTerminalDebugEvent(
        sessionId,
        reason === 'workspace'
          ? 'workspace_repair_requested'
          : reason === 'resize'
            ? 'resize_repair_requested'
            : 'manual_repair_requested',
      );
      screenRepairInFlightRef.current = {
        sessionId,
        cols: geometry.cols,
        rows: geometry.rows,
        reason,
      };
      const repairResult = send({
        type: 'screen-repair',
        sessionId,
        cols: geometry.cols,
        rows: geometry.rows,
        reason,
        clientAtBottom: readiness.atBottom,
        clientBufferType: readiness.bufferType,
      });
      if (!repairResult.ok) {
        screenRepairInFlightRef.current = null;
        const recoveryDecision = recordVisibleOutputRecoverySendFailure(
          visibleOutputRecoveryStateRef.current,
          VISIBLE_OUTPUT_RECOVERY_MAX_SEND_RETRIES,
        );
        visibleOutputRecoveryStateRef.current = recoveryDecision.state;
        syncInputTransportState(`visible-output-recovery-send-${recoveryDecision.action}`);
        recordTerminalDebugEvent(sessionId, 'screen_repair_send_failed', {
          reason,
          sendResultReason: repairResult.reason,
          reconnectState: wsStatusRef.current,
          visibleOutputRecoveryAction: recoveryDecision.action,
        });
        if (recoveryDecision.action === 'retry') {
          window.setTimeout(() => requestScreenRepair(reason), 100);
        }
        return;
      }

      if (visibleOutputRecoveryStateRef.current.pending) {
        visibleOutputRecoveryStateRef.current = recordVisibleOutputRecoverySendSuccess(
          visibleOutputRecoveryStateRef.current,
        );
        syncInputTransportState('visible-output-recovery-repair-sent');
        recordTerminalDebugEvent(sessionId, 'visible_output_recovery_repair_sent', {
          reason,
          cols: geometry.cols,
          rows: geometry.rows,
        });
      }
    }, [send, sendResizeIfNeeded, sessionId, shouldSuppressScreenRepairRequest, syncInputTransportState]);

    const flushPendingGridScreenRepair = useCallback(() => {
      const pendingReason = pendingGridScreenRepairRef.current;
      if (!pendingReason || !isVisibleRef.current || !sessionReadyRef.current) {
        return;
      }

      pendingGridScreenRepairRef.current = null;
      requestScreenRepair(pendingReason);
    }, [requestScreenRepair]);
    flushPendingGridScreenRepairRef.current = flushPendingGridScreenRepair;

    const runGridLayoutRepair = useCallback((reason: GridRepairReason) => {
      if (!isVisibleRef.current || !isGridSurfaceRef.current) {
        return;
      }

      if (gridRepairInFlightRef.current) {
        return;
      }

      const repair = (async () => {
        recordTerminalDebugEvent(sessionId, 'grid_layout_repair_started', { reason });
        invalidateHostLayouts();
        await waitForRuntimeLayoutSettle();
        const layoutRepaired = await (terminalRef.current?.repairLayout(`grid-${reason}-repair`) ?? Promise.resolve(false));
        if (!layoutRepaired) {
          recordTerminalDebugEvent(sessionId, 'grid_layout_repair_skipped', {
            reason,
            skipReason: 'ime-wait-cancelled-or-terminal-missing',
          });
          return;
        }
        requestScreenRepair(reason);
      })();

      gridRepairInFlightRef.current = repair;
      void repair.finally(() => {
        if (gridRepairInFlightRef.current === repair) {
          gridRepairInFlightRef.current = null;
        }
      });
    }, [invalidateHostLayouts, requestScreenRepair, sessionId]);

    useImperativeHandle(ref, () => ({
      submitOutput: (data, metadata) => terminalRef.current?.submitOutput(data, metadata),
      writeAndWait: (data) => terminalRef.current?.writeAndWait(data) ?? Promise.resolve(false),
      writeRecoveryTailAndWait: (data) => (
        terminalRef.current?.writeRecoveryTailAndWait(data) ?? Promise.resolve(false)
      ),
      awaitOutputIdle: () => terminalRef.current?.awaitOutputIdle() ?? Promise.resolve(false),
      probeOutputFifo: () => terminalRef.current?.probeOutputFifo() ?? Promise.resolve(false),
      getAuthorityViewGeneration: () => terminalRef.current?.getAuthorityViewGeneration() ?? null,
      isCheckpointAuthorityActive: () => terminalRef.current?.isCheckpointAuthorityActive() ?? false,
      isCompatibilityRecoveryPending: () => (
        terminalRef.current?.isCompatibilityRecoveryPending() ?? false
      ),
      bindRestoreCoordinator: (options) => (
        terminalRef.current?.bindRestoreCoordinator(options)
        ?? createTerminalContainerRestoreAdapter(options)
      ),
      submitClear: () => terminalRef.current?.submitClear(),
      focus: (reason) => terminalRef.current?.focus(reason),
      hasSelection: () => terminalRef.current?.hasSelection() ?? false,
      getSelection: () => terminalRef.current?.getSelection() ?? '',
      getMouseTrackingActive: () => terminalRef.current?.getMouseTrackingActive() ?? false,
      clearSelection: () => terminalRef.current?.clearSelection(),
      copySelection: (source) => terminalRef.current?.copySelection(source) ?? Promise.resolve({
        ok: false,
        action: 'copy',
        source: source ?? 'keyboard',
        reason: 'context-changed',
      }),
      pasteClipboard: (source) => terminalRef.current?.pasteClipboard(source) ?? Promise.resolve({
        ok: false,
        action: 'paste',
        source: source ?? 'command-preset',
        reason: 'context-changed',
      }),
      pasteText: (data, source) => terminalRef.current?.pasteText(data, source) ?? {
        ok: false,
        action: 'paste',
        source: source ?? 'command-preset',
        reason: 'context-changed',
      },
      invalidateClipboardContext: () => terminalRef.current?.invalidateClipboardContext(),
      fit: () => terminalRef.current?.fit(),
      repairLayout: (reason) => terminalRef.current?.repairLayout(reason) ?? Promise.resolve(false),
      requestGridRepair: (reason = 'manual') => runGridLayoutRepair(reason),
      sendInput: (data) => terminalRef.current?.sendInput(data) ?? buildUnavailableInputResult('imperative'),
      restoreSnapshot: () => terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false),
      replaceWithSnapshot: (data, shouldApply, options) => (
        terminalRef.current?.replaceWithSnapshot(data, shouldApply, options) ?? Promise.resolve(false)
      ),
      getScreenRepairReadiness: () => terminalRef.current?.getScreenRepairReadiness() ?? { ok: false, reason: 'not-ready' },
      applyScreenRepair: (repair) => terminalRef.current?.applyScreenRepair(repair) ?? Promise.resolve({ ok: false, reason: 'not-ready' }),
      clearVisibleOutputRecovery: () => terminalRef.current?.clearVisibleOutputRecovery(),
      releasePending: () => terminalRef.current?.releasePending(),
      completeCheckpointTakeover: () => terminalRef.current?.completeCheckpointTakeover(),
      setInputTransportState: (state) => terminalRef.current?.setInputTransportState(state),
      setServerReady: (ready) => terminalRef.current?.setServerReady(ready),
      setWindowsPty: (info) => terminalRef.current?.setWindowsPty(info),
      captureRetainedState: () => terminalRef.current?.captureRetainedState() ?? null,
    }), [runGridLayoutRepair]);

    const handleStatus = useEffectEvent((status: string) => {
      const nextStatus = status as WorkspaceTabRuntime['status'];
      const previousStatus = lastStatusRef.current;
      onStatusChange(sessionId, nextStatus);
      lastStatusRef.current = nextStatus;
      recordTerminalDebugEvent(sessionId, 'status_received', {
        status: nextStatus,
        previousStatus,
      });
    });

    const handleCwd = useEffectEvent((cwd: string) => {
      onCwdChange?.(sessionId, cwd);
    });

    const handleError = useEffectEvent((message: string) => {
      console.error('Session error:', message);
      sessionReadyRef.current = false;
      const closedReason = classifySessionError(message);
      markTransportClosed(closedReason, 'session-error');
      syncInputTransportState('session-error');
      flushTransportPipeline('session-error');
      rejectTransportOutbox(mapClosedReasonToRejectReason(closedReason), closedReason);
      // Only a session that is actually gone becomes `disconnected`: that status
      // unmounts the terminal host, so a server-side failure reported for a
      // running session would destroy a live terminal.
      if (sessionErrorTerminatesSession(message)) {
        onStatusChange(sessionId, 'disconnected');
      }
    });

    const handleSubscribed = useEffectEvent((info: { status: string; cwd?: string; ready: boolean }) => {
      if (activeVisibleOutputResyncRef.current) {
        sessionReadyRef.current = false;
        syncInputTransportState('subscribed-during-visible-output-resync');
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_subscribed_ready_ignored', {
          status: info.status,
          ready: info.ready,
          cwdPresent: Boolean(info.cwd),
        });
        return;
      }
      sessionReadyRef.current = info.ready;
      if (info.ready) {
        clearTransportClosedReason('subscribed-ready');
      }
      syncInputTransportState('subscribed');
      recordTerminalDebugEvent(sessionId, 'session_subscribed', {
        status: info.status,
        ready: info.ready,
        cwdPresent: Boolean(info.cwd),
      });
      if (info.ready) {
        flushPendingGridScreenRepair();
        flushTransportPipeline('subscribed-ready');
      }
    });

    const handleSessionReady = useEffectEvent((message: TerminalSessionReadyMessage) => {
      // Deliberately NOT recorded here. THREE of the paths below reject this
      // message as not-current — the two in-flight-recovery comparisons and the
      // snapshot-identity gate on the no-recovery path — so recording on
      // arrival would make a token the handler is about to reject into the live
      // one. Each accept path records at its own point.
      const compatibilityPostAckRecovery = compatibilityPostAckConvergenceRef.current;
      if (compatibilityPostAckRecovery) {
        if (!isCurrentCompatibilityPostAckState(compatibilityPostAckRecovery)) {
          failCompatibilityPostAckConvergence('ready-stale-runtime-identity');
          return;
        }
        if (
          message.replayToken === undefined
          || message.snapshotSeq === undefined
          || message.replayToken !== compatibilityPostAckRecovery.replayToken
          || message.snapshotSeq !== compatibilityPostAckRecovery.snapshotSeq
        ) {
          recordTerminalDebugEvent(sessionId, 'terminal_compatibility_post_ack_ready_ignored', {
            reason: message.replayToken === undefined || message.snapshotSeq === undefined
              ? 'missing-authority-identity'
              : 'stale-authority-identity',
            receivedReplayToken: message.replayToken ?? null,
            receivedSnapshotSeq: message.snapshotSeq ?? null,
            expectedReplayToken: compatibilityPostAckRecovery.replayToken,
            expectedSnapshotSeq: compatibilityPostAckRecovery.snapshotSeq,
          });
          return;
        }
        const ready = advanceTerminalCompatibilityPostAckConvergence(
          compatibilityPostAckRecovery,
          {
            type: 'server-ready-latched',
            sessionId,
            replayToken: message.replayToken,
            snapshotSeq: message.snapshotSeq,
            connectionGeneration: wsConnectionGenerationRef.current,
            sessionGeneration: sessionGenerationRef.current,
            viewGeneration: compatibilityPostAckRecovery.viewGeneration,
          },
        );
        if (!ready.accepted) {
          failCompatibilityPostAckConvergence('ready-identity-mismatch');
          return;
        }
        compatibilityPostAckConvergenceRef.current = ready.state;
        recordLiveOutputTokens({ replayToken: message.replayToken });
        recordCompatibilityPostAckProgress();
        sessionReadyRef.current = true;
        clearTransportClosedReason('compatibility-post-ack-session-ready');
        recordCompatibilityPostAckState(ready.state, 'compatibility-post-ack-server-ready-latched');
        syncInputTransportState('compatibility-post-ack-session-ready-latched');
        if (ready.converged) {
          finishCompatibilityPostAckConvergence(ready.state);
        }
        return;
      }
      const activeResync = activeVisibleOutputResyncRef.current;
      if (activeResync) {
        const recoveryState = activeResync.coordinator.getState(activeResync.scope);
        const hasRecoveryToken = message.replayToken !== undefined;
        const matchesRecovery = (
          message.repairToken === activeResync.repairToken
          && message.replayToken === activeResync.replayToken
          && message.snapshotSeq === activeResync.snapshotSeq
        );
        if (!hasRecoveryToken || !matchesRecovery) {
          recordTerminalDebugEvent(sessionId, 'visible_output_resync_ready_ignored', {
            reason: hasRecoveryToken ? 'stale-token' : 'missing-token',
          });
          return;
        }
        if (!recoveryState || recoveryState.terminalFailed || recoveryState.disposed) {
          recordTerminalDebugEvent(sessionId, 'visible_output_resync_ready_ignored', {
            reason: 'terminal-failed',
          });
          return;
        }
        activeResync.matchingServerReadyLatched = true;
        recordLiveOutputTokens({
          replayToken: message.replayToken,
          repairToken: message.repairToken,
        });
        sessionReadyRef.current = true;
        clearTransportClosedReason('session-ready-resync-latched');
        activeResync.restoreAdapter.handle({
          type: 'server-ready-latched',
          repairToken: message.repairToken,
          replayToken: message.replayToken,
        });
        recordVisibleOutputResyncState(activeResync, 'server-ready-latched');
        syncInputTransportState('session-ready-resync-latched');
        return;
      }
      if (
        message.replayToken !== undefined
        && message.snapshotSeq !== undefined
        && visibleOutputRecoveryAttemptBudgetRef.current.resetAfterMatchingReconnectConvergence({
          connectionGeneration: wsConnectionGenerationRef.current,
          replayToken: message.replayToken,
          snapshotSeq: message.snapshotSeq,
        })
      ) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_retry_budget_reset', {
          source: 'replacement-socket-authoritative-ready',
          replayToken: message.replayToken,
          snapshotSeq: message.snapshotSeq,
        });
      }
      const latestReceivedSnapshotReadyIdentity = latestReceivedSnapshotReadyIdentityRef.current;
      if (
        latestReceivedSnapshotReadyIdentity
        && (
          message.replayToken !== latestReceivedSnapshotReadyIdentity.replayToken
          || message.snapshotSeq !== latestReceivedSnapshotReadyIdentity.snapshotSeq
        )
      ) {
        recordTerminalDebugEvent(sessionId, 'terminal_session_ready_snapshot_identity_ignored', {
          receivedReplayToken: message.replayToken ?? null,
          receivedSnapshotSeq: message.snapshotSeq ?? null,
          expectedReplayToken: latestReceivedSnapshotReadyIdentity.replayToken,
          expectedSnapshotSeq: latestReceivedSnapshotReadyIdentity.snapshotSeq,
        });
        return;
      }
      // Below the snapshot-identity gate above, not before it. Reaching here
      // requires no compatibility recovery and no active resync — both of those
      // branches return unconditionally — so this is the no-recovery accept
      // path, and it is the first point at which the gate has agreed the token
      // matches the latest snapshot the client actually received.
      recordLiveOutputTokens({ replayToken: message.replayToken });
      sessionReadyRef.current = true;
      clearTransportClosedReason('session-ready');
      syncInputTransportState('session-ready');
      recordTerminalDebugEvent(sessionId, 'session_ready_received');
      flushPendingGridScreenRepair();
      flushTransportPipeline('session-ready');
    });

    // @req REL-BGSTAB-008
    const handleVisibleResyncSnapshotBeforeApply = useEffectEvent((snapshot: SnapshotPayload): boolean => {
      const activeVisibleResync = activeVisibleOutputResyncRef.current;
      if (!activeVisibleResync) {
        return false;
      }
      const isCurrentGeneration = (
        activeVisibleResync.connectionGeneration === wsConnectionGenerationRef.current
        && activeVisibleResync.sessionGeneration === sessionGenerationRef.current
      );
      if (!isCurrentGeneration) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_snapshot_stale_ignored', {
          seq: snapshot.seq,
          mode: snapshot.mode,
          connectionGeneration: wsConnectionGenerationRef.current,
          sessionGeneration: sessionGenerationRef.current,
          replayTokenMatches: activeVisibleResync.replayToken === snapshot.replayToken,
          receivedReplayToken: snapshot.replayToken,
          activeReplayToken: activeVisibleResync.replayToken,
          activeRepairToken: activeVisibleResync.repairToken,
          viewGeneration: activeVisibleResync.viewGeneration,
          xtermGeneration: activeVisibleResync.xtermGeneration,
        });
        return true;
      }
      if (!matchesRestoreNeededSnapshotAuthorityProof(activeVisibleResync, snapshot)) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_snapshot_authority_proof_mismatch', {
          expectedSnapshotSeq: activeVisibleResync.snapshotSeq,
          receivedSnapshotSeq: snapshot.seq,
          mode: snapshot.mode,
        });
        requestBoundedVisibleRecoveryReconnect('snapshot-authority-proof-mismatch');
        return true;
      }
      const recoveryState = activeVisibleResync.coordinator.getState(activeVisibleResync.scope);
      if (!recoveryState || recoveryState.terminalFailed || recoveryState.disposed) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_failed_snapshot_ignored', {
          replayToken: snapshot.replayToken,
          seq: snapshot.seq,
          mode: snapshot.mode,
        });
        return true;
      }
      if (snapshot.mode === 'authoritative') {
        return false;
      }
      applyActiveVisibleResyncSnapshot(snapshot);
      historySeenRef.current = true;
      lastAppliedSnapshotRef.current = {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        data: snapshot.data,
        replayToken: snapshot.replayToken,
        connectionGeneration: wsConnectionGenerationRef.current,
      };
      // The second application point, so it records like the first. The store
      // already holds this exact value — the authority proof above pins
      // `snapshot.replayToken` to the active resync's — but that argument rests
      // on three separate invariants, and any one of them could be changed
      // without anyone noticing this line was relying on it.
      recordLiveOutputTokens({ replayToken: snapshot.replayToken });
      recordTerminalDebugEvent(sessionId, 'visible_output_resync_provisional_awaiting_reconnect', {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
      });
      initialRestorePendingRef.current = false;
      syncInputTransportState('screen-snapshot-provisional-visible-resync');
      return true;
    });

    const isCurrentActiveVisibleResyncSnapshot = useEffectEvent((snapshot: SnapshotPayload): boolean => {
      const activeResync = activeVisibleOutputResyncRef.current;
      const recoveryState = activeResync?.coordinator.getState(activeResync.scope);
      return Boolean(
        activeResync
        && recoveryState
        && !recoveryState.terminalFailed
        && !recoveryState.disposed
        && matchesRestoreNeededSnapshotAuthorityProof(activeResync, snapshot)
        && activeResync.connectionGeneration === wsConnectionGenerationRef.current
        && activeResync.sessionGeneration === sessionGenerationRef.current,
      );
    });

    const handleScreenSnapshot = useEffectEvent(async (snapshot: SnapshotPayload) => {
      latestReceivedSnapshotReadyIdentityRef.current = {
        replayToken: snapshot.replayToken,
        snapshotSeq: snapshot.seq,
      };
      recordTerminalDebugEvent(sessionId, 'screen_snapshot_received', {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        byteLength: getUtf8ByteLength(snapshot.data),
      }, snapshot.data);
      pendingSnapshotRef.current = snapshot;
      if (!terminalRef.current) {
        recordTerminalDebugEvent(sessionId, 'screen_snapshot_deferred_until_visible', {
          seq: snapshot.seq,
          visible: isVisible,
          hasTerminal: Boolean(terminalRef.current),
        });
        requestAnimationFrame(() => {
          if (pendingSnapshotRef.current && !snapshotApplyInProgressRef.current && terminalRef.current) {
            void handleScreenSnapshot(pendingSnapshotRef.current);
          }
        });
        return;
      }
      if (snapshotApplyInProgressRef.current) {
        return;
      }

      snapshotApplyInProgressRef.current = true;
      try {
        while (pendingSnapshotRef.current) {
          const nextSnapshot = pendingSnapshotRef.current;
          pendingSnapshotRef.current = null;

          if (handleVisibleResyncSnapshotBeforeApply(nextSnapshot)) {
            continue;
          }

          const lastApplied = lastAppliedSnapshotRef.current;
          const forceCurrentActiveReplacement = isCurrentActiveVisibleResyncSnapshot(nextSnapshot);
          const checkpointAuthorityActive = terminalRef.current?.isCheckpointAuthorityActive() === true;
          const forceInitialCheckpointAuthorityRecoveryConvergence = (
            shouldForceInitialCheckpointAuthorityRecoveryConvergence({
              checkpointAuthorityActive,
              initialRestorePending: initialRestorePendingRef.current,
              snapshotMode: nextSnapshot.mode,
              hasLastAppliedSnapshot: lastApplied !== null,
            })
          );
          const compatibilityRecoverySnapshot = nextSnapshot.mode === 'authoritative'
            && terminalRef.current?.isCompatibilityRecoveryPending() === true;
          const forceReplacementRecoveryConvergence = forceInitialCheckpointAuthorityRecoveryConvergence
            || compatibilityRecoverySnapshot
            || shouldForceAuthoritativeRecoveryConvergence({
              recoveryBlocking: resolveVisibleOutputRecoveryBarrierReason(
                visibleOutputRecoveryStateRef.current,
              ) !== 'none',
              snapshotMode: nextSnapshot.mode,
              replayToken: nextSnapshot.replayToken,
              currentConnectionGeneration: wsConnectionGenerationRef.current,
              lastApplied,
            });
          if (shouldSuppressLegacySnapshotDuringCheckpointAuthority({
            checkpointAuthorityActive,
            compatibilityRecoveryPending: compatibilityRecoverySnapshot,
            snapshotMode: nextSnapshot.mode,
          }) && !forceReplacementRecoveryConvergence) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_checkpoint_authority_ignored', {
              seq: nextSnapshot.seq,
              replayToken: nextSnapshot.replayToken,
              ...(nextSnapshot.authorityEpoch !== undefined
                ? { authorityEpoch: nextSnapshot.authorityEpoch }
                : {}),
              ...(nextSnapshot.authorityRevision !== undefined
                ? { authorityRevision: nextSnapshot.authorityRevision }
                : {}),
            });
            const ackResult = send({
              type: 'screen-snapshot:ready',
              sessionId,
              replayToken: nextSnapshot.replayToken,
              snapshotSeq: nextSnapshot.seq,
            });
            if (!ackResult.ok) {
              handleScreenSnapshotAckSendFailure(nextSnapshot, 'checkpoint-authority-ignored', ackResult.reason);
            }
            continue;
          }
          if (
            compatibilityRecoverySnapshot
            && resolveVisibleOutputRecoveryBarrierReason(
              visibleOutputRecoveryStateRef.current,
            ) === 'none'
          ) {
            const recovery = beginVisibleOutputRecovery(visibleOutputRecoveryStateRef.current);
            visibleOutputRecoveryStateRef.current = recovery.state;
            sessionReadyRef.current = false;
            syncInputTransportState('compatibility-snapshot-recovery-started');
          }
          const isStale = !forceCurrentActiveReplacement
            && !forceReplacementRecoveryConvergence
            && !!lastApplied
            && nextSnapshot.seq < lastApplied.seq;
          const hasSameSnapshotContent = !!lastApplied
            && nextSnapshot.mode === lastApplied.mode
            && nextSnapshot.truncated === lastApplied.truncated
            && nextSnapshot.data === lastApplied.data;
          const isDuplicate = !forceCurrentActiveReplacement
            && !forceReplacementRecoveryConvergence
            && hasSameSnapshotContent
            && nextSnapshot.seq === lastApplied.seq;

          if (isStale) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_stale_ignored', {
              seq: nextSnapshot.seq,
              appliedSeq: lastApplied.seq,
            });
            const ackResult = send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            if (!ackResult.ok) {
              handleScreenSnapshotAckSendFailure(nextSnapshot, 'stale', ackResult.reason);
            }
            continue;
          }

          if (isDuplicate) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_ignored', {
              seq: nextSnapshot.seq,
              mode: nextSnapshot.mode,
            });
            const ackResult = send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            if (!ackResult.ok) {
              handleScreenSnapshotAckSendFailure(nextSnapshot, 'duplicate', ackResult.reason);
            }
            continue;
          }

          let hiddenOutputRecoverySucceeded = false;
          let visibleOutputRecoverySnapshotSucceeded = false;

          if (nextSnapshot.mode === 'fallback') {
            if (nextSnapshot.data.length > 0) {
              const applied = await (terminalRef.current?.replaceWithSnapshot(nextSnapshot.data) ?? Promise.resolve(false));
              if (!applied) {
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_apply_skipped', {
                  seq: nextSnapshot.seq,
                  mode: nextSnapshot.mode,
                  reason: 'ime-wait-cancelled-or-terminal-missing',
                });
                continue;
              }
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_applied', {
                seq: nextSnapshot.seq,
                byteLength: getUtf8ByteLength(nextSnapshot.data),
              }, nextSnapshot.data);
              hiddenOutputRecoverySucceeded = shouldClearHiddenOutputAfterSnapshotRecovery({
                snapshotMode: 'fallback',
                fallbackDataLength: nextSnapshot.data.length,
                localRestoreSucceeded: false,
              });
            } else {
              const restored = await terminalRef.current?.restoreSnapshot();
              if (!restored) {
                const applied = await (terminalRef.current?.replaceWithSnapshot(FALLBACK_EMPTY_MESSAGE) ?? Promise.resolve(false));
                if (!applied) {
                  recordTerminalDebugEvent(sessionId, 'screen_snapshot_apply_skipped', {
                    seq: nextSnapshot.seq,
                    mode: nextSnapshot.mode,
                    reason: 'fallback-placeholder-not-applied',
                  });
                  continue;
                }
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_placeholder_applied', {
                  seq: nextSnapshot.seq,
                }, FALLBACK_EMPTY_MESSAGE);
              } else {
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_local_restore', {
                  seq: nextSnapshot.seq,
                  snapshotScope: 'viewport-only',
                });
                hiddenOutputRecoverySucceeded = shouldClearHiddenOutputAfterSnapshotRecovery({
                  snapshotMode: 'fallback',
                  fallbackDataLength: 0,
                  localRestoreSucceeded: true,
                });
                visibleOutputRecoverySnapshotSucceeded = true;
              }
            }
          } else {
            if (forceCurrentActiveReplacement) {
              const currentRuntime = activeVisibleOutputResyncRef.current;
              const liveLaneIdle = await (currentRuntime?.liveLaneIdlePromise ?? Promise.resolve(false));
              if (
                !liveLaneIdle
                || currentRuntime !== activeVisibleOutputResyncRef.current
                || currentRuntime?.replayToken !== nextSnapshot.replayToken
                || currentRuntime.snapshotSeq !== nextSnapshot.seq
              ) {
                recordTerminalDebugEvent(sessionId, 'visible_output_resync_snapshot_wait_rejected', {
                  seq: nextSnapshot.seq,
                  replayToken: nextSnapshot.replayToken,
                  reason: liveLaneIdle ? 'stale-runtime' : 'live-lane-not-idle',
                });
                continue;
              }
            }
            const replacementConnectionGeneration = wsConnectionGenerationRef.current;
            const requiresAuthoritativeMutationFence = forceCurrentActiveReplacement
              || forceReplacementRecoveryConvergence;
            let replacementRejectionReason: string | null = null;
            const shouldApplyAuthoritativeSnapshot = () => (
              (
                !forceCurrentActiveReplacement
                || isCurrentActiveVisibleResyncSnapshot(nextSnapshot)
              )
              && (
                !forceReplacementRecoveryConvergence
                || (
                  wsConnectionGenerationRef.current === replacementConnectionGeneration
                  && (
                    forceInitialCheckpointAuthorityRecoveryConvergence
                    || resolveVisibleOutputRecoveryBarrierReason(
                      visibleOutputRecoveryStateRef.current,
                    ) !== 'none'
                  )
                )
              )
            );
            const replaceAuthoritativeSnapshot = () => (
              terminalRef.current?.replaceWithSnapshot(
                nextSnapshot.data,
                requiresAuthoritativeMutationFence ? shouldApplyAuthoritativeSnapshot : undefined,
                {
                  onRejected: (reason) => {
                    replacementRejectionReason = reason;
                  },
                  ...(requiresAuthoritativeMutationFence
                    ? {
                      failedHeldCoverage: {
                        snapshotSeq: nextSnapshot.seq,
                        coversThroughSeq: nextSnapshot.coversThroughSeq ?? nextSnapshot.seq,
                        replayToken: nextSnapshot.replayToken,
                        supersedesReplayToken: nextSnapshot.supersedesReplayToken,
                        authorityEpoch: nextSnapshot.authorityEpoch,
                        authorityRevision: nextSnapshot.authorityRevision,
                        connectionGeneration: replacementConnectionGeneration,
                      },
                    }
                    : {}),
                },
              ) ?? Promise.resolve(false)
            );
            let applied: boolean;
            try {
              if (requiresAuthoritativeMutationFence) {
                const mutation = await visibleOutputMutationFenceRef.current!.runAuthoritative(
                  replaceAuthoritativeSnapshot,
                );
                applied = mutation.accepted && mutation.value;
              } else {
                applied = await replaceAuthoritativeSnapshot();
              }
            } catch (error) {
              const failedRuntime = activeVisibleOutputResyncRef.current;
              if (
                forceCurrentActiveReplacement
                && failedRuntime
                && failedRuntime.replayToken === nextSnapshot.replayToken
                && failedRuntime.snapshotSeq === nextSnapshot.seq
              ) {
                failedRuntime.restoreAdapter.handle({
                  type: 'recovery-failed',
                  reason: 'parser-reset-failed',
                });
                visibleOutputMutationFenceRef.current?.invalidateSpeculative();
                visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(
                  visibleOutputRecoveryStateRef.current,
                  { keepTerminalStale: true },
                );
                recordVisibleOutputResyncState(failedRuntime, 'authoritative-snapshot-apply-rejected');
                syncInputTransportState('visible-output-resync-authoritative-apply-rejected');
              }
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_apply_failed', {
                seq: nextSnapshot.seq,
                mode: nextSnapshot.mode,
                reason: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            if (requiresAuthoritativeMutationFence && !shouldApplyAuthoritativeSnapshot()) {
              recordTerminalDebugEvent(sessionId, 'visible_output_resync_failed_snapshot_ignored', {
                replayToken: nextSnapshot.replayToken,
                seq: nextSnapshot.seq,
                mode: nextSnapshot.mode,
              });
              continue;
            }
            if (!applied) {
              const checkpointAuthoritySuperseded = (
                replacementRejectionReason === 'checkpoint-authority-active'
                && terminalRef.current?.isCheckpointAuthorityActive() === true
                && terminalRef.current?.isCompatibilityRecoveryPending() !== true
              );
              if (checkpointAuthoritySuperseded) {
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_checkpoint_authority_superseded', {
                  seq: nextSnapshot.seq,
                  replayToken: nextSnapshot.replayToken,
                });
                const ackResult = send({
                  type: 'screen-snapshot:ready',
                  sessionId,
                  replayToken: nextSnapshot.replayToken,
                  snapshotSeq: nextSnapshot.seq,
                });
                if (!ackResult.ok) {
                  handleScreenSnapshotAckSendFailure(nextSnapshot, 'checkpoint-authority-superseded-in-flight', ackResult.reason);
                } else {
                  initialRestorePendingRef.current = false;
                  terminalRef.current?.completeCheckpointTakeover();
                }
                continue;
              }
              if (
                terminalRef.current?.isCheckpointAuthorityActive() === true
                || terminalRef.current?.isCompatibilityRecoveryPending() === true
              ) {
                pendingCheckpointAuthoritySnapshotRef.current = nextSnapshot;
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_checkpoint_authority_deferred', {
                  seq: nextSnapshot.seq,
                  replayToken: nextSnapshot.replayToken,
                });
                continue;
              }
              const failedRuntime = activeVisibleOutputResyncRef.current;
              if (
                forceCurrentActiveReplacement
                && failedRuntime
                && failedRuntime.replayToken === nextSnapshot.replayToken
                && failedRuntime.snapshotSeq === nextSnapshot.seq
              ) {
                failedRuntime.restoreAdapter.handle({
                  type: 'recovery-failed',
                  reason: 'parser-reset-failed',
                });
                visibleOutputMutationFenceRef.current?.invalidateSpeculative();
                visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(
                  visibleOutputRecoveryStateRef.current,
                  { keepTerminalStale: true },
                );
                recordVisibleOutputResyncState(failedRuntime, 'authoritative-snapshot-apply-failed');
                syncInputTransportState('visible-output-resync-authoritative-apply-failed');
              }
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_apply_skipped', {
                seq: nextSnapshot.seq,
                mode: nextSnapshot.mode,
                reason: 'ime-wait-cancelled-or-terminal-missing',
              });
              if (requiresAuthoritativeMutationFence) {
                requestBoundedVisibleRecoveryReconnect('authoritative-snapshot-apply-rejected');
              }
              continue;
            }
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_authoritative_applied', {
              seq: nextSnapshot.seq,
              byteLength: getUtf8ByteLength(nextSnapshot.data),
            }, nextSnapshot.data);
            hiddenOutputRecoverySucceeded = shouldClearHiddenOutputAfterSnapshotRecovery({
              snapshotMode: 'authoritative',
              fallbackDataLength: nextSnapshot.data.length,
              localRestoreSucceeded: false,
            });
            visibleOutputRecoverySnapshotSucceeded = true;
          }

          const activeVisibleResyncApplied = applyActiveVisibleResyncSnapshot(nextSnapshot);
          if (activeVisibleResyncApplied) {
            hiddenOutputRecoverySucceeded = false;
            visibleOutputRecoverySnapshotSucceeded = false;
          }

          terminalRef.current?.setWindowsPty(nextSnapshot.windowsPty);

          historySeenRef.current = true;
          lastAppliedSnapshotRef.current = {
            seq: nextSnapshot.seq,
            mode: nextSnapshot.mode,
            truncated: nextSnapshot.truncated,
            data: nextSnapshot.data,
            replayToken: nextSnapshot.replayToken,
            connectionGeneration: wsConnectionGenerationRef.current,
          };
          // Here rather than on arrival. The stale, duplicate and
          // checkpoint-authority gates all sit above and skip without applying,
          // so an arrival record would publish a token the handler goes on to
          // refuse. This is also the snapshot that was actually applied —
          // `nextSnapshot` off the pending queue, not the argument the handler
          // was called with.
          recordLiveOutputTokens({ replayToken: nextSnapshot.replayToken });
          if (!activeVisibleResyncApplied) {
            let compatibilityPostAckState: TerminalCompatibilityPostAckConvergenceState | null = null;
            if (nextSnapshot.mode === 'authoritative' && forceReplacementRecoveryConvergence) {
              const viewGeneration = terminalRef.current?.getAuthorityViewGeneration() ?? null;
              if (viewGeneration === null) {
                sessionReadyRef.current = false;
                syncInputTransportState('compatibility-post-ack-view-unavailable');
                requestBoundedVisibleRecoveryReconnect('compatibility-post-ack-view-unavailable');
                continue;
              }
              const terminalLimits = getCachedTerminalOutputResourceLimits();
              compatibilityPostAckState = createTerminalCompatibilityPostAckConvergence(
                {
                  sessionId,
                  replayToken: nextSnapshot.replayToken,
                  snapshotSeq: nextSnapshot.seq,
                  connectionGeneration: wsConnectionGenerationRef.current,
                  sessionGeneration: sessionGenerationRef.current,
                  viewGeneration,
                },
                {
                  maxHeldBytes: terminalLimits.visibleOutputQueueMaxBytes,
                  maxHeldChunks: terminalLimits.visibleOutputMaxChunks,
                },
              );
              compatibilityPostAckConvergenceRef.current = compatibilityPostAckState;
              armCompatibilityPostAckTimeout(compatibilityPostAckState);
              sessionReadyRef.current = false;
              recordCompatibilityPostAckState(
                compatibilityPostAckState,
                'compatibility-snapshot-acknowledged',
              );
            }
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent', {
              seq: nextSnapshot.seq,
              mode: nextSnapshot.mode,
            });
            const ackResult = send({
              type: 'screen-snapshot:ready',
              sessionId,
              replayToken: nextSnapshot.replayToken,
              snapshotSeq: nextSnapshot.seq,
            });
            if (!ackResult.ok) {
              if (compatibilityPostAckConvergenceRef.current === compatibilityPostAckState) {
                clearCompatibilityPostAckTimeout();
                compatibilityPostAckConvergenceRef.current = null;
              }
              handleScreenSnapshotAckSendFailure(nextSnapshot, 'applied', ackResult.reason);
              continue;
            } else if (nextSnapshot.mode === 'authoritative') {
              visibleOutputRecoveryAttemptBudgetRef.current.armReconnectConvergence({
                connectionGeneration: wsConnectionGenerationRef.current,
                replayToken: nextSnapshot.replayToken,
                snapshotSeq: nextSnapshot.seq,
              });
            }
          }
          initialRestorePendingRef.current = false;
          if (hiddenOutputRecoverySucceeded) {
            finishHiddenOutputRecovery('screen-snapshot', true);
          }
          if (
            visibleOutputRecoverySnapshotSucceeded
            && compatibilityPostAckConvergenceRef.current === null
          ) {
            finishVisibleOutputRecoveryIfPending('screen-snapshot');
          }
          syncInputTransportState('screen-snapshot-applied');
        }
      } finally {
        snapshotApplyInProgressRef.current = false;
        if (pendingSnapshotRef.current) {
          void handleScreenSnapshot(pendingSnapshotRef.current);
        } else if (
          compatibilityAuthorityReadyRef.current
          && pendingCheckpointAuthoritySnapshotRef.current
        ) {
          const deferredSnapshot = pendingCheckpointAuthoritySnapshotRef.current;
          pendingCheckpointAuthoritySnapshotRef.current = null;
          compatibilityAuthorityReadyRef.current = false;
          void handleScreenSnapshot(deferredSnapshot);
        } else {
          syncInputTransportState('screen-snapshot-apply-settled');
        }
      }
    });

    const handleCompatibilityAuthorityReady = useEffectEvent(() => {
      const deferredSnapshot = pendingCheckpointAuthoritySnapshotRef.current;
      if (!deferredSnapshot) {
        return;
      }
      compatibilityAuthorityReadyRef.current = true;
      if (!terminalRef.current) {
        return;
      }
      if (snapshotApplyInProgressRef.current) return;
      pendingCheckpointAuthoritySnapshotRef.current = null;
      compatibilityAuthorityReadyRef.current = false;
      void handleScreenSnapshot(deferredSnapshot);
    });

    const handleScreenRepair = useEffectEvent(async (repair: ScreenRepairMessage) => {
      if (activeVisibleOutputResyncRef.current) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_legacy_repair_ignored', {
          repairToken: repair.repairToken,
          phase: 'before-apply',
        });
        return;
      }
      const resyncEpochBeforeApply = visibleOutputResyncEpochRef.current;
      recordTerminalDebugEvent(sessionId, 'screen_repair_received', {
        repairToken: repair.repairToken,
        seq: repair.seq,
        cols: repair.cols,
        rows: repair.rows,
        bufferType: repair.bufferType,
        rowCount: repair.viewportRows.length,
        byteLength: getUtf8ByteLength(repair.ansiPatch),
      }, repair.ansiPatch);

      const mutation = await visibleOutputMutationFenceRef.current!.runSpeculative(() => (
        terminalRef.current?.applyScreenRepair(repair)
          ?? Promise.resolve({ ok: false as const, reason: 'not-ready' as ScreenRepairFailedReason })
      ));
      if (!mutation.accepted) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_legacy_repair_ignored', {
          repairToken: repair.repairToken,
          phase: 'mutation-fenced',
        });
        return;
      }
      const result = mutation.value;
      if (
        activeVisibleOutputResyncRef.current
        || visibleOutputResyncEpochRef.current !== resyncEpochBeforeApply
      ) {
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_legacy_repair_ignored', {
          repairToken: repair.repairToken,
          phase: 'after-apply',
        });
        return;
      }
      const inFlight = screenRepairInFlightRef.current;
      if (result.ok) {
        const ackResult = send({ type: 'screen-repair:ready', sessionId, repairToken: repair.repairToken });
        if (!ackResult.ok) {
          recordTerminalDebugEvent(sessionId, 'screen_repair_ack_send_failed', {
            repairToken: repair.repairToken,
            seq: repair.seq,
            reason: ackResult.reason,
          });
          clearScreenRepairInFlightForTerminalOutcome('reconnect-required');
          visibleOutputResyncEpochRef.current += 1;
          visibleOutputMutationFenceRef.current?.invalidateSpeculative();
          sessionReadyRef.current = false;
          const started = beginVisibleOutputRecovery(
            finishVisibleOutputRecovery(visibleOutputRecoveryStateRef.current),
          );
          visibleOutputRecoveryStateRef.current = started.state;
          finishVisibleOutputRecoveryIfPending('screen-repair-ack-send-failed', {
            keepTerminalStale: true,
          });
          requestBoundedVisibleRecoveryReconnect('screen-repair-ack-send-failed');
          return;
        }
        lastCompletedScreenRepairRef.current = {
          sessionId,
          cols: repair.cols,
          rows: repair.rows,
          reason: inFlight?.reason ?? 'manual',
          completedAt: Date.now(),
        };
        // `08:222` names screen-repair as an update source, and `08:214` keeps
        // 0x03 on JSON for v1, so this is a permanent one. Recorded after the
        // ACK rather than on arrival: everything above this point can still
        // refuse the repair.
        recordLiveOutputTokens({ repairToken: repair.repairToken });
        recordTerminalDebugEvent(sessionId, 'screen_repair_ack_sent', {
          repairToken: repair.repairToken,
          seq: repair.seq,
        });
        finishHiddenOutputRecovery('screen-repair', true);
        finishVisibleOutputRecoveryIfPending('screen-repair');
      } else {
        const failedResult = send({
          type: 'screen-repair:failed',
          sessionId,
          repairToken: repair.repairToken,
          reason: result.reason,
        });
        if (!failedResult.ok) {
          recordTerminalDebugEvent(sessionId, 'screen_repair_failed_send_failed', {
            repairToken: repair.repairToken,
            seq: repair.seq,
            applyReason: result.reason,
            sendResultReason: failedResult.reason,
          });
        }
        finishVisibleOutputRecoveryIfPending('screen-repair-failed', { keepTerminalStale: true });
      }

      if (screenRepairInFlightRef.current?.sessionId === sessionId) {
        screenRepairInFlightRef.current = null;
      }
    });

    const handleScreenRepairRejected = useEffectEvent((rejected: ScreenRepairRejectedMessage) => {
      const activeResync = activeVisibleOutputResyncRef.current;
      if (activeResync) {
        if (!rejected.repairToken || rejected.repairToken !== activeResync.repairToken) {
          recordTerminalDebugEvent(sessionId, 'visible_output_resync_legacy_rejected_ignored', {
            repairToken: rejected.repairToken ?? null,
            reason: rejected.reason,
          });
          return;
        }
        activeResync.restoreAdapter.handle({
          type: 'recovery-failed',
          reason: rejected.reason,
          outcome: 'fresh-snapshot-started',
        });
        visibleOutputMutationFenceRef.current?.invalidateSpeculative();
        recordVisibleOutputResyncState(activeResync, 'legacy-repair-rejected');
        syncInputTransportState('visible-output-resync-legacy-repair-rejected');
        return;
      }
      recordTerminalDebugEvent(sessionId, 'screen_repair_rejected', {
        repairToken: rejected.repairToken ?? null,
        reason: rejected.reason,
        cols: rejected.cols ?? null,
        rows: rejected.rows ?? null,
      });
      if (screenRepairInFlightRef.current?.sessionId === sessionId) {
        screenRepairInFlightRef.current = null;
      }
      finishVisibleOutputRecoveryIfPending('screen-repair-rejected', { keepTerminalStale: true });
    });

    const handleTerminalDeliveryDataGap = useEffectEvent((message: TerminalDeliveryDataGapMessage) => {
      if (message.sessionId !== sessionId) return;
      const activeResync = activeVisibleOutputResyncRef.current;
      if (!activeResync) return;
      const result = activeResync.restoreAdapter.handle({
        type: 'hidden-data-gap',
        visibilityGeneration: message.visibilityGeneration,
        lastDeliveredSeq: message.lastDeliveredSeq,
      });
      if (result.ignored || !result.state) return;
      const nextState = beginBrowserViewOnlyDataGapRecovery(
        visibleOutputRecoveryStateRef.current,
      );
      if (
        nextState === visibleOutputRecoveryStateRef.current
        && nextState.pending
        && nextState.staleTerminal
      ) {
        return;
      }
      visibleOutputRecoveryStateRef.current = nextState;
      sessionReadyRef.current = false;
      terminalRef.current?.setServerReady(false);
      syncInputTransportState('hidden-data-gap-authoritative-recovery');
      recordTerminalDebugEvent(sessionId, 'terminal_hidden_data_gap_recovery_started', {
        visibilityGeneration: message.visibilityGeneration,
        connectionId: message.connectionId,
        viewGeneration: message.viewGeneration,
        streamEpoch: message.streamEpoch,
        checkpointEpoch: message.checkpointEpoch,
        snapshotSeq: message.snapshotSeq,
        oldestRetainedSeq: message.oldestRetainedSeq,
        retentionPolicyId: message.retentionPolicyId,
        sourceViewStale: nextState.staleTerminal,
        sourceViewReady: false,
        authoritativeRecoveryRequested: true,
        recoveryScope: 'browser-view-only',
      });
    });

    useEffect(() => {
      if (pendingSnapshotRef.current && !snapshotApplyInProgressRef.current && terminalRef.current) {
        void handleScreenSnapshot(pendingSnapshotRef.current);
      } else if (
        compatibilityAuthorityReadyRef.current
        && pendingCheckpointAuthoritySnapshotRef.current
        && !snapshotApplyInProgressRef.current
        && terminalRef.current
      ) {
        const deferredSnapshot = pendingCheckpointAuthoritySnapshotRef.current;
        pendingCheckpointAuthoritySnapshotRef.current = null;
        compatibilityAuthorityReadyRef.current = false;
        void handleScreenSnapshot(deferredSnapshot);
      }
    });

    useEffect(() => {
      return () => {
        if (visibleRepairTimerRef.current) {
          clearTimeout(visibleRepairTimerRef.current);
          visibleRepairTimerRef.current = null;
        }
        if (resizeRepairTimerRef.current) {
          clearTimeout(resizeRepairTimerRef.current);
          resizeRepairTimerRef.current = null;
        }
        if (reconnectTtlTimerRef.current) {
          clearTimeout(reconnectTtlTimerRef.current);
          reconnectTtlTimerRef.current = null;
        }
        clearTransportOutboxExpiryTimers();
        inputSequencerRef.current?.dispose();
      };
    }, [clearTransportOutboxExpiryTimers]);

    useEffect(() => {
      syncInputTransportState('render-sync');
    });

    useEffect(() => {
      if (reconnectTtlTimerRef.current) {
        clearTimeout(reconnectTtlTimerRef.current);
        reconnectTtlTimerRef.current = null;
      }

      if (wsStatus === 'connected') {
        reconnectStartedAtRef.current = null;
        clearTransportClosedReason('ws-connected');
        syncInputTransportState('ws-connected');
        flushTransportPipeline('ws-connected');
        return;
      }

      const activeResync = activeVisibleOutputResyncRef.current;
      if (activeResync) {
        activeResync.restoreAdapter.handle({
          type: 'connection-closed',
        });
        visibleOutputMutationFenceRef.current?.invalidateSpeculative();
        recordVisibleOutputResyncState(activeResync, 'connection-closed');
        activeVisibleOutputResyncRef.current = null;
      }
      const compatibilityPostAckRecovery = compatibilityPostAckConvergenceRef.current;
      if (compatibilityPostAckRecovery) {
        recordCompatibilityPostAckState(compatibilityPostAckRecovery, 'connection-closed');
        compatibilityPostAckConvergenceRef.current = null;
        clearCompatibilityPostAckTimeout();
      }
      visibleOutputRecoveryAttemptBudgetRef.current.clearPendingReconnectConvergence();

      if (wsStatus === 'reconnecting') {
        if (reconnectStartedAtRef.current === null) {
          reconnectStartedAtRef.current = Date.now();
        }
        syncInputTransportState('ws-reconnecting');
        reconnectTtlTimerRef.current = setTimeout(() => {
          markTransportClosed('ws-closed-without-reconnect', 'reconnect-ttl-expired');
          syncInputTransportState('reconnect-ttl-expired');
          flushTransportPipeline('reconnect-ttl-expired');
          rejectTransportOutbox('transport-closed', 'ws-closed-without-reconnect');
        }, RECONNECT_INPUT_QUEUE_TTL_MS + 25);
        return;
      }

      markTransportClosed('ws-closed-without-reconnect', 'ws-disconnected');
      syncInputTransportState('ws-disconnected');
      flushTransportPipeline('ws-disconnected');
      rejectTransportOutbox('transport-closed', 'ws-disconnected');
    }, [
      clearCompatibilityPostAckTimeout,
      clearTransportClosedReason,
      flushTransportPipeline,
      markTransportClosed,
      recordCompatibilityPostAckState,
      recordVisibleOutputResyncState,
      rejectTransportOutbox,
      syncInputTransportState,
      wsStatus,
    ]);

    useEffect(function subscribeSessionRuntime() {
      const unsubscribe = subscribeSession(sessionId, {
        onSubscribed: handleSubscribed,
        onSessionReady: handleSessionReady,
        onTerminalDeliveryDataGap: handleTerminalDeliveryDataGap,
        onScreenSnapshot: (snapshot) => {
          void handleScreenSnapshot(snapshot);
        },
        onScreenRepair: (repair) => {
          void handleScreenRepair(repair);
        },
        onScreenRepairRejected: handleScreenRepairRejected,
        onScreenRepairRestoreNeeded: handleScreenRepairRestoreNeeded,
        onScreenRepairReconnectRequired: handleScreenRepairReconnectRequired,
        onGraceAuthorityProofMismatch: () => {
          sessionReadyRef.current = false;
          const recovery = beginVisibleOutputRecovery(visibleOutputRecoveryStateRef.current);
          visibleOutputRecoveryStateRef.current = recovery.state;
          syncInputTransportState('websocket-grace-authority-proof-mismatch');
          recordTerminalDebugEvent(sessionId, 'websocket_grace_authority_proof_mismatch');
          requestBoundedVisibleRecoveryReconnect('websocket-grace-authority-proof-mismatch');
        },
        onGraceOutputOverflow: (reason) => {
          const recovery = beginVisibleOutputRecovery(visibleOutputRecoveryStateRef.current);
          visibleOutputRecoveryStateRef.current = recovery.state;
          syncInputTransportState('websocket-grace-output-overflow');
          recordTerminalDebugEvent(sessionId, 'websocket_grace_output_restore_requested', {
            reason,
            shouldSend: recovery.shouldSend,
          });
          if (recovery.shouldSend) {
            const result = send({ type: 'repair-replay', sessionId });
            if (!result.ok) {
              visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(
                visibleOutputRecoveryStateRef.current,
                { keepTerminalStale: true },
              );
              syncInputTransportState('websocket-grace-output-repair-send-failed');
            }
          }
        },
        // Binary frames carry neither token, so the context reads them from
        // here. The generation is resolved on each call rather than captured:
        // a captured one would keep answering after the authority it belongs
        // to has been replaced.
        getLiveOutputTokens: () => liveOutputTokenRef.current.get(sessionId, liveOutputTokenGeneration()),
        onOutput: (delivery: TerminalOutputDelivery) => {
          const compatibilityPostAckConvergence = compatibilityPostAckConvergenceRef.current;
          if (compatibilityPostAckConvergence) {
            if (!isCurrentCompatibilityPostAckState(compatibilityPostAckConvergence)) {
              failCompatibilityPostAckConvergence('stale-runtime-identity');
              return;
            }
            if (delivery.replayToken !== compatibilityPostAckConvergence.replayToken) {
              recordTerminalDebugEvent(sessionId, 'terminal_compatibility_post_ack_output_ignored', {
                reason: 'replay-token-mismatch',
                receivedReplayToken: delivery.replayToken ?? null,
                expectedReplayToken: compatibilityPostAckConvergence.replayToken,
              });
              failCompatibilityPostAckConvergence('output-replay-token-mismatch');
              return;
            }
            const postAckChunks = delivery.chunks;
            if (postAckChunks === null || postAckChunks.some(chunk => chunk.screenSeq === undefined)) {
              failCompatibilityPostAckConvergence(
                postAckChunks === null ? 'invalid-source-segments' : 'missing-screen-sequence',
              );
              return;
            }
            for (const chunk of postAckChunks) {
              const current = compatibilityPostAckConvergenceRef.current;
              if (!current || !isCurrentCompatibilityPostAckState(current)) {
                return;
              }
              const outputId = chunk.chunkId
                ?? `${current.connectionGeneration}:${current.receivedOutputChunks + 1}:${chunk.screenSeq}`;
              const arrival = advanceTerminalCompatibilityPostAckConvergence(current, {
                type: 'output-arrived',
                sessionId,
                replayToken: delivery.replayToken,
                snapshotSeq: current.snapshotSeq,
                connectionGeneration: current.connectionGeneration,
                sessionGeneration: current.sessionGeneration,
                viewGeneration: current.viewGeneration,
                outputId,
                screenSeq: chunk.screenSeq!,
                byteLength: chunk.byteLength,
              });
              if (!arrival.accepted) {
                failCompatibilityPostAckConvergence('stale-or-covered-output');
                return;
              }
              compatibilityPostAckConvergenceRef.current = arrival.state;
              recordCompatibilityPostAckProgress();
              recordCompatibilityPostAckState(arrival.state, 'compatibility-post-ack-output-held');
              const completion = terminalRef.current?.writeRecoveryTailAndWait(chunk.data)
                ?? Promise.resolve(false);
              void completion.then((written) => {
                const pending = compatibilityPostAckConvergenceRef.current;
                if (!pending || !isCurrentCompatibilityPostAckState(pending)) {
                  return;
                }
                if (!written) {
                  failCompatibilityPostAckConvergence('post-ack-output-write-failed');
                  return;
                }
                const drained = advanceTerminalCompatibilityPostAckConvergence(pending, {
                  type: 'output-drained',
                  sessionId,
                  replayToken: pending.replayToken,
                  snapshotSeq: pending.snapshotSeq,
                  connectionGeneration: pending.connectionGeneration,
                  sessionGeneration: pending.sessionGeneration,
                  viewGeneration: pending.viewGeneration,
                  outputId,
                });
                if (!drained.accepted) {
                  failCompatibilityPostAckConvergence('post-ack-output-drain-mismatch');
                  return;
                }
                compatibilityPostAckConvergenceRef.current = drained.state;
                recordCompatibilityPostAckProgress();
                recordCompatibilityPostAckState(drained.state, 'compatibility-post-ack-output-drained');
                if (drained.converged) {
                  finishCompatibilityPostAckConvergence(drained.state);
                }
              });
            }
            return;
          }
          const activeResync = activeVisibleOutputResyncRef.current;
          if (activeResync) {
            if (
              activeResync.connectionGeneration !== wsConnectionGenerationRef.current
              || activeResync.sessionGeneration !== sessionGenerationRef.current
            ) {
              recordTerminalDebugEvent(sessionId, 'visible_output_resync_output_ignored', {
                reason: 'stale-generation',
                hasReplayToken: delivery.replayToken !== undefined,
              });
              return;
            }
            const recoveryChunks = delivery.chunks;
            if (
              recoveryChunks === null
              || (delivery.repairToken !== undefined && delivery.repairToken !== activeResync.repairToken)
            ) {
              recordTerminalDebugEvent(sessionId, 'visible_output_resync_output_ignored', {
                reason: recoveryChunks === null
                  ? 'invalid-source-segments'
                  : 'stale-or-incomplete-output-identity',
                hasReplayToken: delivery.replayToken !== undefined,
                hasChunkId: delivery.whole.chunkId !== undefined,
                hasScreenSeq: delivery.whole.screenSeq !== undefined,
                matchingServerReadyLatched: activeResync.matchingServerReadyLatched,
              });
              return;
            }
            const recoveryAdmissions = classifyVisibleResyncOutputBatch({
              activeReplayToken: activeResync.replayToken,
              outputReplayToken: delivery.replayToken,
              matchingServerReadyLatched: activeResync.matchingServerReadyLatched,
              chunks: recoveryChunks,
            });
            if (recoveryAdmissions === null) {
              recordTerminalDebugEvent(sessionId, 'visible_output_resync_output_ignored', {
                reason: 'stale-or-incomplete-output-identity',
                hasReplayToken: delivery.replayToken !== undefined,
                matchingServerReadyLatched: activeResync.matchingServerReadyLatched,
              });
              return;
            }
            for (const chunk of recoveryChunks) {
              activeResync.nextChunkOrdinal += 1;
              const recoveryResult = activeResync.restoreAdapter.handle({
                type: 'output-arrived',
                chunk: {
                  chunkId: chunk.chunkId
                    ?? `${activeResync.connectionGeneration}:${activeResync.nextChunkOrdinal}`,
                  screenSeq: chunk.screenSeq,
                  data: chunk.data,
                },
              });
              if (recoveryResult.state?.terminalFailed) {
                visibleOutputMutationFenceRef.current?.invalidateSpeculative();
              }
            }
            recordVisibleOutputResyncState(activeResync, 'output-held');
            return;
          }
          const byteLength = delivery.whole.byteLength;
          const terminalLimits = getCachedTerminalOutputResourceLimits();
          const hiddenDecision = resolveHiddenOutput(hiddenOutputStateRef.current, {
            isVisible: isVisibleRef.current,
            byteLength,
            data: delivery.previewText,
            hiddenOutputPolicy: terminalLimits.hiddenOutputPolicy,
            hiddenOutputTailBytes: terminalLimits.hiddenOutputTailBytes,
          });
          hiddenOutputStateRef.current = hiddenDecision.nextState;

          recordTerminalDebugEvent(sessionId, 'live_output_received', {
            byteLength,
            visible: isVisibleRef.current,
            hiddenOutputAction: hiddenDecision.action,
            deliveryIdentityPresent: delivery.ack !== undefined,
          }, delivery.previewText);
          if (hiddenDecision.action === 'skip') {
            recordTerminalDebugEvent(sessionId, 'hidden_output_skipped', {
              byteLength,
              skippedBytes: hiddenDecision.nextState.skippedBytes,
              debugTailBytes: getUtf8ByteLength(hiddenDecision.nextState.debugTail),
              hiddenOutputPolicy: terminalLimits.hiddenOutputPolicy,
            }, hiddenDecision.nextState.debugTail);
            return;
          }

          const deliveryIdentity = delivery.ack;

          const liveChunks = delivery.chunks;
          if (liveChunks === null) {
            terminalRef.current?.submitOutput(delivery.whole.data, {
              screenSeq: delivery.whole.screenSeq,
              replayToken: delivery.replayToken,
              authorityEpoch: delivery.whole.authorityEpoch,
              authorityRevision: delivery.whole.authorityRevision,
              connectionGeneration: wsConnectionGenerationRef.current,
              onWritten: deliveryIdentity !== undefined
                ? () => {
                    const result = send({
                      type: 'terminal-delivery:ack',
                      sessionId,
                      ...deliveryIdentity,
                    });
                    recordTerminalDebugEvent(sessionId, 'terminal_delivery_ack_attempted', {
                      connectionEpoch: deliveryIdentity.connectionEpoch,
                      deliverySeq: deliveryIdentity.deliverySeq,
                      accepted: result.ok,
                      reason: result.ok ? null : result.reason,
                    });
                  }
                : undefined,
            });
            return;
          }
          let remainingAcceptedChunks = liveChunks.length;
          const acknowledgeAcceptedOutput = deliveryIdentity !== undefined
            ? () => {
                remainingAcceptedChunks -= 1;
                if (remainingAcceptedChunks === 0) {
                  const result = send({
                    type: 'terminal-delivery:ack',
                    sessionId,
                    ...deliveryIdentity,
                  });
                  recordTerminalDebugEvent(sessionId, 'terminal_delivery_ack_attempted', {
                    connectionEpoch: deliveryIdentity.connectionEpoch,
                    deliverySeq: deliveryIdentity.deliverySeq,
                    accepted: result.ok,
                    reason: result.ok ? null : result.reason,
                  });
                }
              }
            : undefined;
          for (const chunk of liveChunks) {
            terminalRef.current?.submitOutput(chunk.data, {
              screenSeq: chunk.screenSeq,
              replayToken: delivery.replayToken,
              authorityEpoch: chunk.authorityEpoch,
              authorityRevision: chunk.authorityRevision,
              connectionGeneration: wsConnectionGenerationRef.current,
              onWritten: acknowledgeAcceptedOutput,
            });
          }
        },
        onStatus: handleStatus,
        onError: handleError,
        onCwd: handleCwd,
      });
      return unsubscribe;
    }, [
      failCompatibilityPostAckConvergence,
      finishCompatibilityPostAckConvergence,
      isCurrentCompatibilityPostAckState,
      recordCompatibilityPostAckState,
      recordCompatibilityPostAckProgress,
      recordVisibleOutputResyncState,
      requestBoundedVisibleRecoveryReconnect,
      send,
      sessionId,
      subscribeSession,
      syncInputTransportState,
    ]);

    const handleInput = useCallback((data: string, metadata?: InputDebugMetadata) => {
      const debugInput = resolveInputDebugPayload(data, metadata, sessionId);
      recordTerminalDebugEvent(sessionId, 'terminal_input_sequencer_received', {
        ...debugInput.details,
        sessionGeneration: sessionGenerationRef.current,
        sessionReady: sessionReadyRef.current,
        reconnectState: wsStatusRef.current,
      }, debugInput.preview);
      inputSequencerRef.current?.submit(data, metadata ?? buildClientInputDebugMetadata(debugInput.details));
    }, [sessionId]);

    const handleResize = useCallback((cols: number, rows: number) => {
      lastResizeRef.current = { cols, rows };
      sendResizeIfNeeded(cols, rows, 'terminal-resize');
      if (!isVisibleRef.current || !isGridSurfaceRef.current) {
        return;
      }
      if (resizeRepairTimerRef.current) {
        clearTimeout(resizeRepairTimerRef.current);
      }
      resizeRepairTimerRef.current = setTimeout(() => {
        resizeRepairTimerRef.current = null;
        requestScreenRepair('resize');
      }, 150);
    }, [requestScreenRepair, sendResizeIfNeeded]);

    useEffect(() => {
      const nextVisible = isVisible && isGridSurface;
      const wasVisible = gridVisibleRef.current;
      gridVisibleRef.current = nextVisible;

      if (!nextVisible || wasVisible) {
        return;
      }

      if (visibleRepairTimerRef.current) {
        clearTimeout(visibleRepairTimerRef.current);
      }
      visibleRepairTimerRef.current = setTimeout(() => {
        visibleRepairTimerRef.current = null;
        runGridLayoutRepair('workspace');
      }, 250);
    }, [isGridSurface, isVisible, runGridLayoutRepair]);

    const handleMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !isGridSurfaceRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runGridLayoutRepair('manual');
    }, [runGridLayoutRepair]);

    const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !isGridSurfaceRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runGridLayoutRepair('manual');
    }, [runGridLayoutRepair]);

    const handleManualRepair = useCallback(() => {
      runGridLayoutRepair('manual');
    }, [runGridLayoutRepair]);

    const handleVisibleOutputOverflow = useCallback((info: {
      reason: string;
      droppedBytes: number;
      pendingBytes: number;
    }) => {
      const requiresFreshCompatibilitySnapshot = info.reason.startsWith('terminal-authority-recovery:');
      const recovery = beginVisibleOutputRecovery(visibleOutputRecoveryStateRef.current);
      visibleOutputRecoveryStateRef.current = recovery.state;
      syncInputTransportState('visible-output-recovery-started');
      if (requiresFreshCompatibilitySnapshot) {
        recordTerminalDebugEvent(sessionId, 'terminal_authority_fresh_compatibility_snapshot_requested', {
          reason: info.reason,
          pending: recovery.state.pending,
          staleTerminal: recovery.state.staleTerminal,
        });
        if (!recovery.shouldSend) {
          recordTerminalDebugEvent(sessionId, 'visible_output_recovery_suppressed', {
            reason: info.reason,
            droppedBytes: info.droppedBytes,
            pendingBytes: info.pendingBytes,
            pending: recovery.state.pending,
            staleTerminal: recovery.state.staleTerminal,
          });
          return;
        }
        const budgetDecision = visibleOutputRecoveryAttemptBudgetRef.current.consume('fresh-snapshot');
        if (!budgetDecision.allowed) {
          recordTerminalDebugEvent(sessionId, 'visible_output_resync_retry_budget_exhausted', {
            kind: 'fresh-snapshot',
            reason: info.reason,
            attempts: budgetDecision.attempt,
          });
          return;
        }
        recordTerminalDebugEvent(sessionId, 'visible_output_resync_retry_attempted', {
          kind: 'fresh-snapshot',
          reason: info.reason,
          attempt: budgetDecision.attempt,
        });
        const snapshotRequest = send({ type: 'repair-replay', sessionId });
        if (!snapshotRequest.ok) {
          requestBoundedVisibleRecoveryReconnect('terminal-authority-fresh-snapshot-send-failed');
        }
        return;
      }
      if (!recovery.shouldSend) {
        recordTerminalDebugEvent(sessionId, 'visible_output_recovery_suppressed', {
          reason: info.reason,
          droppedBytes: info.droppedBytes,
          pendingBytes: info.pendingBytes,
          pending: recovery.state.pending,
          staleTerminal: recovery.state.staleTerminal,
        });
        if (info.reason === 'restore-pending-output-admission-rejected') {
          const activeResync = activeVisibleOutputResyncRef.current;
          activeResync?.restoreAdapter.handle({
            type: 'recovery-failed',
            reason: 'parser-reset-failed',
          });
          visibleOutputMutationFenceRef.current?.invalidateSpeculative();
          visibleOutputRecoveryStateRef.current = finishVisibleOutputRecovery(
            visibleOutputRecoveryStateRef.current,
            { keepTerminalStale: true },
          );
          if (activeResync) {
            recordVisibleOutputResyncState(activeResync, 'restore-buffer-admission-rejected');
          }
          requestBoundedVisibleRecoveryReconnect('restore-buffer-admission-rejected');
          syncInputTransportState('restore-buffer-admission-rejected');
        }
        return;
      }

      recordTerminalDebugEvent(sessionId, 'visible_output_recovery_started', {
        reason: info.reason,
        droppedBytes: info.droppedBytes,
        pendingBytes: info.pendingBytes,
      });

      if (!isVisibleRef.current) {
        finishVisibleOutputRecoveryIfPending('visible-output-overflow-not-visible', { keepTerminalStale: true });
        return;
      }

      if (isGridSurfaceRef.current) {
        runGridLayoutRepair('workspace');
      } else {
        requestScreenRepair('workspace');
      }
    }, [
      finishVisibleOutputRecoveryIfPending,
      recordVisibleOutputResyncState,
      requestBoundedVisibleRecoveryReconnect,
      requestScreenRepair,
      runGridLayoutRepair,
      send,
      sessionId,
      syncInputTransportState,
    ]);

    useEffect(() => {
      if (!isVisible || !hiddenOutputStateRef.current.skipped) {
        return undefined;
      }
      if (hiddenOutputReplayStateRef.current.pending) {
        return undefined;
      }

      let cancelled = false;
      const skippedBeforeRecovery = hiddenOutputStateRef.current;
      const replayTransition = beginHiddenOutputReplay(
        hiddenOutputReplayStateRef.current,
        initialRestorePendingRef.current,
      );
      hiddenOutputReplayStateRef.current = replayTransition.replayState;
      initialRestorePendingRef.current = replayTransition.initialRestorePending;
      recordTerminalDebugEvent(sessionId, 'hidden_output_recovery_started', {
        skippedBytes: skippedBeforeRecovery.skippedBytes,
        debugTailBytes: getUtf8ByteLength(skippedBeforeRecovery.debugTail),
      }, skippedBeforeRecovery.debugTail);

      const restoreMutation = visibleOutputMutationFenceRef.current!.runSpeculative(() => (
        terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false)
      ));
      void restoreMutation.then((mutation) => {
        if (cancelled) {
          return;
        }
        if (!mutation.accepted) {
          recordTerminalDebugEvent(sessionId, 'hidden_output_recovery_mutation_fenced', {
            skippedBytes: hiddenOutputStateRef.current.skippedBytes,
          });
          return;
        }
        const restored = mutation.value;
        if (restored) {
          const activeResync = activeVisibleOutputResyncRef.current;
          if (activeResync) {
            const state = activeResync.coordinator.getState(activeResync.scope);
            if (state) {
              state.staleTerminal = true;
              state.currentViewTransactionReady = false;
              state.retainedHistoryEquivalent = false;
              state.provisionalLocalState = true;
            }
            recordVisibleOutputResyncState(activeResync, 'provisional-local-restore');
            syncInputTransportState('visible-output-resync-provisional-local-restore');
            return;
          }
          finishHiddenOutputRecovery('local-snapshot', true);
          if (isGridSurfaceRef.current) {
            runGridLayoutRepair('workspace');
          } else {
            requestScreenRepair('workspace');
          }
          return;
        }

        recordTerminalDebugEvent(sessionId, 'hidden_output_recovery_restore_failed', {
          skippedBytes: hiddenOutputStateRef.current.skippedBytes,
          debugTailBytes: getUtf8ByteLength(hiddenOutputStateRef.current.debugTail),
        }, hiddenOutputStateRef.current.debugTail);
        terminalRef.current?.releasePending();
        if (isGridSurfaceRef.current) {
          runGridLayoutRepair('workspace');
        } else {
          requestScreenRepair('workspace');
        }
      });

      return () => {
        cancelled = true;
      };
    }, [
      finishHiddenOutputRecovery,
      isVisible,
      recordVisibleOutputResyncState,
      requestScreenRepair,
      runGridLayoutRepair,
      sessionId,
      syncInputTransportState,
    ]);

    return (
      <div
        style={{ display: isVisible ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0 }}
        onPointerDownCapture={handlePointerDownCapture}
        onMouseDownCapture={handleMouseDownCapture}
        onAuxClickCapture={handleMouseDownCapture}
      >
        <TerminalView
          ref={terminalRef}
          sessionId={sessionId}
          workspaceId={workspaceId}
          terminalShortcutState={terminalShortcutState}
          isVisible={isVisible}
          clipboardContextKey={clipboardContextKey}
          outputPolicyConnectionId={wsClientId ?? wsClientIdRef.current ?? 'client-unidentified'}
          outputPolicyReconnectGeneration={wsConnectionGenerationRef.current}
          outputPolicySelectionCoordinator={outputPolicySelectionCoordinator}
          onInput={handleInput}
          flushPendingUserInputBeforeQueryReply={flushTransportPipeline}
          onResize={handleResize}
          onManualRepair={isGridSurface ? handleManualRepair : undefined}
          onRestorePendingSettled={flushPendingGridScreenRepair}
          onCompatibilityAuthorityReady={handleCompatibilityAuthorityReady}
          onVisibleOutputOverflow={handleVisibleOutputOverflow}
        />
      </div>
    );
  }),
  propsAreEqual,
);
