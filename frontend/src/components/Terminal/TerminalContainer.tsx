import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions, useWebSocketState } from '../../contexts/WebSocketContext';
import type { SendResult } from '../../contexts/WebSocketContext';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { TerminalView } from './TerminalView';
import type { GridRepairReason, TerminalHandle } from './TerminalView';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildClientInputDebugMetadata,
  buildTerminalInputDebugPayload,
  recordTerminalDebugEvent,
} from '../../utils/terminalDebugCapture';
import { getInputReliabilityMode } from '../../utils/inputReliabilityMode';
import {
  TerminalInputSequencer,
  type SequencedTerminalInput,
} from '../../utils/terminalInputSequencer';
import type {
  InputDebugMetadata,
  InputRejectedReason,
  TerminalInputBarrierReason,
  TerminalInputClosedReason,
} from '../../types/ws-protocol';

const RECONNECT_INPUT_QUEUE_TTL_MS = 3000;
const TRANSPORT_INPUT_QUEUE_TTL_MS = 1500;
const TRANSPORT_INPUT_QUEUE_BYTE_BUDGET = 64 * 1024;

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

function getUtf8ByteLength(raw: string): number {
  return new TextEncoder().encode(raw).length;
}

function inputContainsEnter(raw: string): boolean {
  return raw.includes('\r') || raw.includes('\n');
}

interface Props {
  sessionId: string;
  isVisible: boolean;
  isGridSurface: boolean;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange?: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function propsAreEqual(prev: Props, next: Props): boolean {
  return prev.sessionId === next.sessionId
    && prev.isVisible === next.isVisible
    && prev.isGridSurface === next.isGridSurface;
}

const FALLBACK_EMPTY_MESSAGE = '[BuilderGate] Fallback snapshot unavailable. Waiting for new output...\r\n';

function waitForRuntimeLayoutSettle(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

interface SnapshotPayload {
  seq: number;
  data: string;
  mode: 'authoritative' | 'fallback';
  truncated: boolean;
  replayToken: string;
  windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber?: number };
}

export const TerminalContainer = memo(
  forwardRef<TerminalHandle, Props>(function TerminalContainer(
    { sessionId, isVisible, isGridSurface, onStatusChange, onCwdChange },
    ref
  ) {
    const terminalRef = useRef<TerminalHandle>(null);
    const isVisibleRef = useRef(isVisible);
    const isGridSurfaceRef = useRef(isGridSurface);
    const initialRestorePendingRef = useRef(true);
    const historySeenRef = useRef(false);
    const pendingSnapshotRef = useRef<SnapshotPayload | null>(null);
    const snapshotApplyInProgressRef = useRef(false);
    const sessionReadyRef = useRef(false);
    const visibleRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gridRepairInFlightRef = useRef<Promise<void> | null>(null);
    const gridVisibleRef = useRef(false);
    const pendingGridRepairReplayRef = useRef<GridRepairReason | null>(null);
    const repairSnapshotPendingRef = useRef(false);
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
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
    const { send, subscribeSession } = useWebSocketActions();
    const { status: wsStatus } = useWebSocketState();
    const { invalidateHostLayouts } = useTerminalRuntimeContext();
    const wsStatusRef = useRef(wsStatus);
    const lastAppliedSnapshotRef = useRef<{
      seq: number;
      mode: 'authoritative' | 'fallback';
      truncated: boolean;
      data: string;
    } | null>(null);

    if (!inputSequencerRef.current) {
      inputSequencerRef.current = new TerminalInputSequencer((input, reason) => {
        deliverSequencedInputRef.current(input, reason);
      });
    }

    isVisibleRef.current = isVisible;
    isGridSurfaceRef.current = isGridSurface;
    wsStatusRef.current = wsStatus;

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
        if (repairSnapshotPendingRef.current) {
          serverReady = false;
          barrierReason = 'repair-server-not-ready';
        } else if (
          initialRestorePendingRef.current
          || snapshotApplyInProgressRef.current
          || pendingSnapshotRef.current !== null
        ) {
          serverReady = false;
          barrierReason = 'replay-pending';
        } else if (!serverReady && barrierReason === 'none') {
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
      const debugInput = buildTerminalInputDebugPayload(input.data, {
        captureSeq: input.metadata?.captureSeq,
        compositionSeq: input.metadata?.compositionSeq,
      });
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
      const debugInput = buildTerminalInputDebugPayload(input.data, {
        captureSeq: input.metadata?.captureSeq,
        compositionSeq: input.metadata?.compositionSeq,
      });
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
      if (!isVisibleRef.current) {
        return {
          action: 'reject',
          rejectReason: 'context-changed',
          barrierReason: 'none',
          detailReason: 'terminal-hidden',
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      const closedReason = transportClosedReasonRef.current;
      if (closedReason !== 'none') {
        return {
          action: 'reject',
          rejectReason: mapClosedReasonToRejectReason(closedReason),
          barrierReason: 'none',
          detailReason: closedReason,
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      if (sendFailure?.reason === 'missing-token') {
        return {
          action: 'reject',
          rejectReason: 'auth-expired',
          barrierReason: 'none',
          detailReason: 'missing-token',
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      if (sendFailure?.reason === 'stale-socket') {
        return {
          action: 'reject',
          rejectReason: 'transport-closed',
          barrierReason: 'none',
          detailReason: 'stale-socket',
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
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
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      if (currentWsStatus === 'disconnected') {
        return {
          action: 'reject',
          rejectReason: 'transport-closed',
          barrierReason: 'none',
          detailReason: 'ws-disconnected',
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      if (sendFailure) {
        return {
          action: 'queue',
          rejectReason: mapSendFailureToRejectReason(sendFailure.reason),
          barrierReason: 'repair-server-not-ready',
          detailReason: `send-${sendFailure.reason}`,
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      if (!sessionReadyRef.current) {
        return {
          action: 'queue',
          rejectReason: 'timeout',
          barrierReason: 'repair-server-not-ready',
          detailReason: 'session-not-ready',
          ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
        };
      }

      return {
        action: 'reject',
        rejectReason: 'transport-closed',
        barrierReason: 'none',
        detailReason: 'send-unavailable',
        ttlMs: TRANSPORT_INPUT_QUEUE_TTL_MS,
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

      const debugInput = buildTerminalInputDebugPayload(input.data, {
        captureSeq: input.metadata?.captureSeq,
        compositionSeq: input.metadata?.compositionSeq,
      });
      const byteLength =
        typeof debugInput.details.byteLength === 'number'
          ? debugInput.details.byteLength
          : getUtf8ByteLength(input.data);
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

      if (entry.byteLength > TRANSPORT_INPUT_QUEUE_BYTE_BUDGET) {
        recordTransportInputQueueEvent('transport_input_queue_overflow', entry, {
          reason: 'queue-overflow',
          source,
          attemptedByteLength: entry.byteLength,
          pendingQueueBytes: transportOutboxBytesRef.current,
          queuedByteBudget: TRANSPORT_INPUT_QUEUE_BYTE_BUDGET,
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
        transportOutboxBytesRef.current > TRANSPORT_INPUT_QUEUE_BYTE_BUDGET
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
          queuedByteBudget: TRANSPORT_INPUT_QUEUE_BYTE_BUDGET,
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
    ]);

    const transmitSequencedInput = useCallback((
      input: SequencedTerminalInput,
      source: string,
    ): SendResult => {
      const debugInput = buildTerminalInputDebugPayload(input.data, {
        captureSeq: input.metadata?.captureSeq,
        compositionSeq: input.metadata?.compositionSeq,
      });
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

      const readyForFlush = Boolean(
        isVisibleRef.current
        && transportClosedReasonRef.current === 'none'
        && sessionReadyRef.current
        && wsStatusRef.current === 'connected',
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
      if (
        sessionReadyRef.current
        && transportClosedReasonRef.current === 'none'
        && wsStatusRef.current === 'connected'
        && isVisibleRef.current
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
    }, [flushTransportOutbox]);

    useEffect(() => {
      if (generationSessionIdRef.current !== sessionId) {
        generationSessionIdRef.current = sessionId;
        bumpSessionGeneration('session-id-changed');
      }
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
      pendingSnapshotRef.current = null;
      snapshotApplyInProgressRef.current = false;
      sessionReadyRef.current = false;
      if (visibleRepairTimerRef.current) {
        clearTimeout(visibleRepairTimerRef.current);
        visibleRepairTimerRef.current = null;
      }
      gridRepairInFlightRef.current = null;
      gridVisibleRef.current = false;
      pendingGridRepairReplayRef.current = null;
      repairSnapshotPendingRef.current = false;
      transportClosedReasonRef.current = 'none';
      reconnectStartedAtRef.current = null;
      if (reconnectTtlTimerRef.current) {
        clearTimeout(reconnectTtlTimerRef.current);
        reconnectTtlTimerRef.current = null;
      }
      lastResizeRef.current = null;
      lastStatusRef.current = null;
      inputSequencerRef.current?.reset(1);
      rejectTransportOutbox('context-changed', 'session-attached-reset');
      lastAppliedSnapshotRef.current = null;
      syncInputTransportState('session-attached');
      recordTerminalDebugEvent(sessionId, 'session_attached');
      return () => {
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
    }, [isVisible, sessionId]);

    const requestRepairReplay = useCallback((reason: GridRepairReason) => {
      if (!isVisibleRef.current) {
        return;
      }
      if (!isGridSurfaceRef.current) {
        return;
      }

      if (!sessionReadyRef.current) {
        pendingGridRepairReplayRef.current = reason;
        recordTerminalDebugEvent(sessionId, 'grid_repair_replay_deferred', { reason });
        return;
      }

      const lastResize = lastResizeRef.current;
      if (lastResize) {
        recordTerminalDebugEvent(sessionId, 'grid_repair_resize_sent', {
          reason,
          cols: lastResize.cols,
          rows: lastResize.rows,
        });
        const resizeResult = send({ type: 'resize', sessionId, cols: lastResize.cols, rows: lastResize.rows });
        if (!resizeResult.ok) {
          recordTerminalDebugEvent(sessionId, 'grid_repair_resize_send_failed', {
            reason,
            sendResultReason: resizeResult.reason,
            reconnectState: wsStatusRef.current,
          });
        }
      }

      sessionReadyRef.current = false;
      syncInputTransportState('repair-replay-requested');
      recordTerminalDebugEvent(
        sessionId,
        reason === 'workspace'
          ? 'workspace_repair_requested'
          : 'manual_repair_requested',
      );
      repairSnapshotPendingRef.current = true;
      syncInputTransportState('repair-replay-pending');
      const repairResult = send({ type: 'repair-replay', sessionId });
      if (!repairResult.ok) {
        recordTerminalDebugEvent(sessionId, 'repair_replay_send_failed', {
          reason,
          sendResultReason: repairResult.reason,
          reconnectState: wsStatusRef.current,
        });
      }
    }, [send, sessionId, syncInputTransportState]);

    const flushPendingGridRepairReplay = useCallback(() => {
      const pendingReason = pendingGridRepairReplayRef.current;
      if (!pendingReason || !isVisibleRef.current || !isGridSurfaceRef.current || !sessionReadyRef.current) {
        return;
      }

      pendingGridRepairReplayRef.current = null;
      requestRepairReplay(pendingReason);
    }, [requestRepairReplay]);

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
        await (terminalRef.current?.repairLayout(`grid-${reason}-repair`) ?? Promise.resolve());
        requestRepairReplay(reason);
      })();

      gridRepairInFlightRef.current = repair;
      void repair.finally(() => {
        if (gridRepairInFlightRef.current === repair) {
          gridRepairInFlightRef.current = null;
        }
      });
    }, [invalidateHostLayouts, requestRepairReplay, sessionId]);

    useImperativeHandle(ref, () => ({
      write: (data) => terminalRef.current?.write(data),
      clear: () => terminalRef.current?.clear(),
      focus: (reason) => terminalRef.current?.focus(reason),
      hasSelection: () => terminalRef.current?.hasSelection() ?? false,
      getSelection: () => terminalRef.current?.getSelection() ?? '',
      clearSelection: () => terminalRef.current?.clearSelection(),
      fit: () => terminalRef.current?.fit(),
      repairLayout: (reason) => terminalRef.current?.repairLayout(reason) ?? Promise.resolve(),
      requestGridRepair: (reason = 'manual') => runGridLayoutRepair(reason),
      sendInput: (data) => terminalRef.current?.sendInput(data),
      restoreSnapshot: () => terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false),
      replaceWithSnapshot: (data) => terminalRef.current?.replaceWithSnapshot(data) ?? Promise.resolve(),
      releasePending: () => terminalRef.current?.releasePending(),
      setInputTransportState: (state) => terminalRef.current?.setInputTransportState(state),
      setServerReady: (ready) => terminalRef.current?.setServerReady(ready),
      setWindowsPty: (info) => terminalRef.current?.setWindowsPty(info),
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
      const closedReason = message.includes('Session not found')
        ? 'session-missing'
        : message.startsWith('Shell exited')
          ? 'session-exited'
          : 'server-error';
      markTransportClosed(closedReason, 'session-error');
      syncInputTransportState('session-error');
      flushTransportPipeline('session-error');
      rejectTransportOutbox(mapClosedReasonToRejectReason(closedReason), closedReason);
      onStatusChange(sessionId, 'disconnected');
    });

    const handleSubscribed = useEffectEvent((info: { status: string; cwd?: string; ready: boolean }) => {
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
        flushPendingGridRepairReplay();
        flushTransportPipeline('subscribed-ready');
      }
    });

    const handleSessionReady = useEffectEvent(() => {
      sessionReadyRef.current = true;
      clearTransportClosedReason('session-ready');
      syncInputTransportState('session-ready');
      recordTerminalDebugEvent(sessionId, 'session_ready_received');
      flushPendingGridRepairReplay();
      flushTransportPipeline('session-ready');
    });

    const handleScreenSnapshot = useEffectEvent(async (snapshot: SnapshotPayload) => {
      recordTerminalDebugEvent(sessionId, 'screen_snapshot_received', {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        byteLength: snapshot.data.length,
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

          const lastApplied = lastAppliedSnapshotRef.current;
          const isStale = !!lastApplied && nextSnapshot.seq < lastApplied.seq;
          const hasSameSnapshotContent = !!lastApplied
            && nextSnapshot.mode === lastApplied.mode
            && nextSnapshot.truncated === lastApplied.truncated
            && nextSnapshot.data === lastApplied.data;
          const isDuplicate = hasSameSnapshotContent && nextSnapshot.seq === lastApplied.seq;
          const shouldReapplyDuplicateForRepair = hasSameSnapshotContent && repairSnapshotPendingRef.current;

          if (isStale) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_stale_ignored', {
              seq: nextSnapshot.seq,
              appliedSeq: lastApplied.seq,
            });
            const ackResult = send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            if (!ackResult.ok) {
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_send_failed', {
                seq: nextSnapshot.seq,
                mode: nextSnapshot.mode,
                reason: ackResult.reason,
                path: 'stale',
              });
            }
            continue;
          }

          if (isDuplicate && !shouldReapplyDuplicateForRepair) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_ignored', {
              seq: nextSnapshot.seq,
              mode: nextSnapshot.mode,
            });
            const ackResult = send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            if (!ackResult.ok) {
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_send_failed', {
                seq: nextSnapshot.seq,
                mode: nextSnapshot.mode,
                reason: ackResult.reason,
                path: 'duplicate',
              });
            }
            continue;
          }
          if (shouldReapplyDuplicateForRepair) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_reapplied_for_repair', {
              seq: nextSnapshot.seq,
              previousSeq: lastApplied?.seq ?? null,
              mode: nextSnapshot.mode,
            });
          }

          historySeenRef.current = true;
          terminalRef.current?.setWindowsPty(nextSnapshot.windowsPty);

          if (nextSnapshot.mode === 'fallback') {
            if (nextSnapshot.data.length > 0) {
              await terminalRef.current?.replaceWithSnapshot(nextSnapshot.data);
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_applied', {
                seq: nextSnapshot.seq,
                byteLength: nextSnapshot.data.length,
              }, nextSnapshot.data);
            } else {
              const restored = await terminalRef.current?.restoreSnapshot();
              if (!restored) {
                await terminalRef.current?.replaceWithSnapshot(FALLBACK_EMPTY_MESSAGE);
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_placeholder_applied', {
                  seq: nextSnapshot.seq,
                }, FALLBACK_EMPTY_MESSAGE);
              } else {
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_local_restore', {
                  seq: nextSnapshot.seq,
                });
              }
            }
          } else {
            await terminalRef.current?.replaceWithSnapshot(nextSnapshot.data);
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_authoritative_applied', {
              seq: nextSnapshot.seq,
              byteLength: nextSnapshot.data.length,
            }, nextSnapshot.data);
          }

          lastAppliedSnapshotRef.current = {
            seq: nextSnapshot.seq,
            mode: nextSnapshot.mode,
            truncated: nextSnapshot.truncated,
            data: nextSnapshot.data,
          };
          recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent', {
            seq: nextSnapshot.seq,
            mode: nextSnapshot.mode,
          });
          const ackResult = send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
          if (!ackResult.ok) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_send_failed', {
              seq: nextSnapshot.seq,
              mode: nextSnapshot.mode,
              reason: ackResult.reason,
              path: 'applied',
            });
          }
          initialRestorePendingRef.current = false;
          repairSnapshotPendingRef.current = false;
          syncInputTransportState('screen-snapshot-applied');
        }
      } finally {
        snapshotApplyInProgressRef.current = false;
        if (pendingSnapshotRef.current) {
          void handleScreenSnapshot(pendingSnapshotRef.current);
        } else {
          syncInputTransportState('screen-snapshot-apply-settled');
        }
      }
    });

    useEffect(() => {
      if (pendingSnapshotRef.current && !snapshotApplyInProgressRef.current && terminalRef.current) {
        void handleScreenSnapshot(pendingSnapshotRef.current);
      }
    });

    useEffect(() => {
      return () => {
        if (visibleRepairTimerRef.current) {
          clearTimeout(visibleRepairTimerRef.current);
          visibleRepairTimerRef.current = null;
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
      clearTransportClosedReason,
      flushTransportPipeline,
      markTransportClosed,
      rejectTransportOutbox,
      syncInputTransportState,
      wsStatus,
    ]);

    useEffect(() => {
      const unsubscribe = subscribeSession(sessionId, {
        onSubscribed: handleSubscribed,
        onSessionReady: handleSessionReady,
        onScreenSnapshot: (snapshot) => {
          void handleScreenSnapshot(snapshot);
        },
        onOutput: (data) => {
          recordTerminalDebugEvent(sessionId, 'live_output_received', {
            byteLength: data.length,
          }, data);
          terminalRef.current?.write(data);
        },
        onStatus: handleStatus,
        onError: handleError,
        onCwd: handleCwd,
      });
      return unsubscribe;
    }, [sessionId, subscribeSession]);

    const handleInput = useCallback((data: string, metadata?: InputDebugMetadata) => {
      const debugInput = buildTerminalInputDebugPayload(data, {
        captureSeq: metadata?.captureSeq,
        compositionSeq: metadata?.compositionSeq,
      });
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
      const result = send({ type: 'resize', sessionId, cols, rows });
      if (!result.ok) {
        recordTerminalDebugEvent(sessionId, 'resize_send_failed', {
          cols,
          rows,
          reason: result.reason,
          reconnectState: wsStatusRef.current,
        });
      }
    }, [sessionId, send]);

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
          isVisible={isVisible}
          onInput={handleInput}
          onResize={handleResize}
          onManualRepair={isGridSurface ? handleManualRepair : undefined}
        />
      </div>
    );
  }),
  propsAreEqual,
);
