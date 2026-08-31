/**
 * WebSocket Context
 * Step 8: Single WS channel for all real-time communication
 *
 * Provides a single WebSocket connection shared across the app.
 * Handles reconnection with exponential backoff, session subscriptions,
 * and message routing to registered handlers.
 */

import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { tokenStorage } from '../services/tokenStorage';
import { setWsClientId } from '../services/api';
import type {
  ClientWsMessage,
  ScreenRepairMessage,
  ScreenRepairReconnectRequiredMessage,
  ScreenRepairRejectedMessage,
  ScreenRepairRestoreNeededMessage,
  ScreenSnapshotMessage,
  ServerWsMessage,
  RetainedTerminalMutationLease,
  TerminalCheckpointClientMessage,
  TerminalDeliveryDataGapMessage,
  TerminalOutputMessage,
  TerminalCheckpointCapabilityMessage,
  TerminalCheckpointViewRegistration,
  TerminalAuthorityRollbackStartMessage,
  TerminalCompatibilityDrainIdentity,
  TerminalLegacyResponderEnabledMessage,
  TerminalLegacyResponderSelectionIdentity,
  TerminalResponderBoundaryIdentity,
  TerminalResponderDisableBoundaryMessage,
  TerminalResponderHandoffClientMessage,
  TerminalSessionReadyMessage,
} from '../types/ws-protocol';
import {
  parseTerminalDeliveryAckRejectedMessage,
  parseTerminalCheckpointServerMessage,
  parseTerminalResponderHandoffServerMessage,
  TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
} from '../types/ws-protocol';
import {
  attachRetainedMutationLease,
  createTerminalCheckpointDispatcherRegistry,
  createTerminalCheckpointRegistrationReleaseScheduler,
  createTerminalResponderHandoffDispatcher,
  extractTerminalCheckpointFailureBoundary,
  isGlobalTerminalCheckpointControlFailure,
  isTerminalCheckpointMutationRejection,
  reconcileTerminalCheckpointMutationLeases,
  releaseTerminalCheckpointDispatcherRegistration,
  type ImmediateTerminalControlSendResult,
  type TerminalCheckpointRuntime,
  type TerminalResponderHandoffRuntime,
} from '../utils/terminalCheckpointRuntime';
import {
  getClientWsResourceLimits,
  getWsTransportMode,
  getTerminalResourceLimits,
  initializeInputReliabilityMode,
} from '../utils/inputReliabilityMode';
import {
  buildControlWebSocketUrl,
  buildSplitOutputWebSocketUrl,
  createWebSocketConnectAttemptFence,
} from '../utils/webSocketUrl';
import {
  getCachedTerminalOutputResourceLimits,
  getOutputUtf8ByteLength,
} from '../utils/terminalOutputHotPath';
import { classifyWsFrame } from '../utils/wsFrameDispatch';
import { deriveMaxBodyBytes } from '../utils/binaryFrameCodec';
import { intakeBinaryFrames } from '../utils/binaryFrameIntake';
import {
  applyTerminalBinaryControlMessage,
  buildTerminalBinaryOffer,
  buildUnknownChannelRequest,
  isTerminalBinaryControlMessage,
} from '../utils/terminalBinaryNegotiationClient';
import type { LiveOutputTokens } from '../utils/liveOutputTokens';
import {
  channelEntriesFromSubscribed,
  createTerminalChannelRegistry,
} from '../utils/terminalChannelRegistry';
import { fromJsonOutputMessage } from '../utils/terminalOutputDelivery';
import type { TerminalOutputDelivery } from '../utils/terminalOutputDelivery';
import { sendOpenBrowserWebSocketMessage } from '../utils/webSocketBackpressure';
import { respondToTerminalAuthorityViewAttributeCapability } from '../utils/terminalViewAttributes';
import {
  hasSameRestoreNeededAuthorityProof,
  matchesRestoreNeededSnapshotAuthorityProof,
} from '../utils/visibleOutputRecovery';
import {
  buildTerminalInputDebugPayload,
  registerWebSocketSendFailureHandler,
  recordTerminalDebugEvent,
  type DebugWebSocketSendFailureOverride,
} from '../utils/terminalDebugCapture';

// ============================================================================
// Types
// ============================================================================

function isCheckpointProtocolRecord(value: unknown): value is Record<string, unknown> & { type: string } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === 'string';
}

export type WsConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not-open'
        | 'missing-token'
        | 'stale-socket'
        | 'client-backpressure'
        | 'client-hard-backpressure'
        | 'send-failed';
      bufferedAmount?: number;
      payloadBytes?: number;
    };

export interface SessionHandlers {
  onScreenSnapshot?: (snapshot: ScreenSnapshotMessage) => void;
  onScreenRepair?: (repair: ScreenRepairMessage) => void;
  onScreenRepairRejected?: (rejected: ScreenRepairRejectedMessage) => void;
  onScreenRepairRestoreNeeded?: (message: ScreenRepairRestoreNeededMessage) => void;
  onScreenRepairReconnectRequired?: (message: ScreenRepairReconnectRequiredMessage) => void;
  onSubscribed?: (info: { status: string; cwd?: string; ready: boolean }) => void;
  onSessionReady?: (message: TerminalSessionReadyMessage) => void;
  /**
   * Receives a codec-neutral delivery rather than `(data, message)`. One entry
   * point, so the JSON and binary paths cannot drift apart below this line.
   */
  onOutput?: (delivery: TerminalOutputDelivery) => void;
  /**
   * The tokens currently valid for this session, for frames that do not carry
   * them. The container resolves the generation at call time — passing one in
   * from here would let a token outlive the authority it belongs to.
   */
  getLiveOutputTokens?: () => LiveOutputTokens | undefined;
  onTerminalDeliveryDataGap?: (message: TerminalDeliveryDataGapMessage) => void;
  onGraceOutputOverflow?: (reason: 'byte-cap-exceeded' | 'chunk-cap-exceeded') => void;
  onGraceAuthorityProofMismatch?: () => void;
  onStatus?: (status: string) => void;
  onError?: (message: string) => void;
  onCwd?: (cwd: string) => void;
}

interface GraceBufferedSessionState {
  snapshot?: ScreenSnapshotMessage;
  output: TerminalOutputMessage[];
  outputBytes: number;
  outputOverflowReason?: 'byte-cap-exceeded' | 'chunk-cap-exceeded';
  authorityProofMismatch?: boolean;
  restoreNeeded?: ScreenRepairRestoreNeededMessage;
  reconnectRequired?: ScreenRepairReconnectRequiredMessage;
  subscribedInfo?: { status: string; cwd?: string; ready: boolean };
  ready?: TerminalSessionReadyMessage;
  status?: string;
  cwd?: string;
  error?: string;
}

export type WorkspaceEventHandler = (data: unknown) => void;

export interface TerminalResponderHandoffViewHandlers {
  getViewGeneration: () => number;
  onResponderDisableBoundary: (
    message: TerminalResponderDisableBoundaryMessage,
    identity: TerminalResponderBoundaryIdentity,
  ) => void;
  onRollbackStart: (
    message: TerminalAuthorityRollbackStartMessage,
    identity: TerminalResponderBoundaryIdentity,
  ) => void;
  onLegacyResponderEnabled: (message: TerminalLegacyResponderEnabledMessage) => void;
}

export interface TerminalAuthorityControlSendInput {
  message: TerminalResponderHandoffClientMessage | TerminalCheckpointClientMessage;
  expectedControlSocketId: string;
  afterEnqueueOrdinal: number;
}

export interface WebSocketContextValue {
  status: WsConnectionStatus;
  clientId: string | null;
  send: (msg: ClientWsMessage) => SendResult;
  subscribeSession: (sessionId: string, handlers: SessionHandlers) => () => void;
  setWorkspaceHandlers: (handlers: Record<string, WorkspaceEventHandler>) => void;
  requestReconnect: (reason: string) => boolean;
  publishTerminalDeliveryVisibility: (input: {
    sessionId: string;
    isVisible: boolean;
    deliveryInterestRefCount?: number;
  }) => void;
  registerTerminalCheckpointDispatcher: (
    sessionId: string,
    dispatcher: TerminalCheckpointRuntime,
  ) => () => void;
  refreshTerminalCheckpointRegistration: () => void;
  registerTerminalResponderHandoffView: (
    sessionId: string,
    handlers: TerminalResponderHandoffViewHandlers,
  ) => () => void;
  registerTerminalResponderHandoffRuntime: (
    identity: TerminalCompatibilityDrainIdentity,
    runtime: TerminalResponderHandoffRuntime,
  ) => () => void;
  getTerminalControlSocketReceipt: () => ImmediateTerminalControlSendResult;
  sendTerminalAuthorityControl: (
    input: TerminalAuthorityControlSendInput,
  ) => ImmediateTerminalControlSendResult;
}

export interface WebSocketStateValue {
  status: WsConnectionStatus;
  clientId: string | null;
}

export interface WebSocketActionsValue {
  send: (msg: ClientWsMessage) => SendResult;
  subscribeSession: (sessionId: string, handlers: SessionHandlers) => () => void;
  setWorkspaceHandlers: (handlers: Record<string, WorkspaceEventHandler>) => void;
  requestReconnect: (reason: string) => boolean;
  publishTerminalDeliveryVisibility: (input: {
    sessionId: string;
    isVisible: boolean;
    deliveryInterestRefCount?: number;
  }) => void;
  registerTerminalCheckpointDispatcher: (
    sessionId: string,
    dispatcher: TerminalCheckpointRuntime,
  ) => () => void;
  refreshTerminalCheckpointRegistration: () => void;
  registerTerminalResponderHandoffView: (
    sessionId: string,
    handlers: TerminalResponderHandoffViewHandlers,
  ) => () => void;
  registerTerminalResponderHandoffRuntime: (
    identity: TerminalCompatibilityDrainIdentity,
    runtime: TerminalResponderHandoffRuntime,
  ) => () => void;
  getTerminalControlSocketReceipt: () => ImmediateTerminalControlSendResult;
  sendTerminalAuthorityControl: (
    input: TerminalAuthorityControlSendInput,
  ) => ImmediateTerminalControlSendResult;
}

const WebSocketStateContext = createContext<WebSocketStateValue | null>(null);
const WebSocketActionsContext = createContext<WebSocketActionsValue | null>(null);

// ============================================================================
// Constants
// ============================================================================

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const SUBSCRIPTION_GRACE_MS = 300;

function getReconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
}

function requestTerminalCheckpointCapability(
  socket: WebSocket,
  views: readonly TerminalCheckpointViewRegistration[],
): void {
  sendOpenBrowserWebSocketMessage({
    message: {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
      views,
    },
    socket,
    limits: getClientWsResourceLimits(),
    openReadyState: WebSocket.OPEN,
  });
}

/**
 * The C->S half of in-band negotiation (`01 §2.2`). Sent wherever the
 * checkpoint capability is: both are additive requests on a socket that has
 * just become usable, and the server answers `rejected` on the default rung.
 */
function requestTerminalBinaryCapability(socket: WebSocket): void {
  sendOpenBrowserWebSocketMessage({
    message: buildTerminalBinaryOffer(),
    socket,
    limits: getClientWsResourceLimits(),
    openReadyState: WebSocket.OPEN,
  });
}

function getWsUrl(): string {
  const token = tokenStorage.getToken();
  return buildControlWebSocketUrl({
    token,
    location: window.location,
    transportMode: getWsTransportMode(),
  });
}

// ============================================================================
// Provider
// ============================================================================

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsConnectionStatus>('disconnected');
  const [clientId, setClientId] = useState<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const wsRef = useRef<WebSocket | null>(null);
  const outputWsRef = useRef<WebSocket | null>(null);
  // The channel table lives here because the mapping is connection-scoped: a
  // view-scoped owner would lose it on an unmount even though the connection,
  // and therefore the channels, survived (`08:199`).
  const channelRegistryRef = useRef(createTerminalChannelRegistry());
  const handleMessageRef = useRef<(event: MessageEvent) => void>(() => undefined);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptReconnectRef = useRef<() => void>(() => {});
  const sessionHandlersRef = useRef<Map<string, SessionHandlers>>(new Map());
  const terminalCheckpointDispatchersRef = useRef(createTerminalCheckpointDispatcherRegistry());
  const [terminalCheckpointRegistrationReleaseScheduler] = useState(
    () => createTerminalCheckpointRegistrationReleaseScheduler(),
  );
  const [connectAttemptFence] = useState(() => createWebSocketConnectAttemptFence());
  const terminalResponderHandoffViewsRef = useRef(
    new Map<string, TerminalResponderHandoffViewHandlers>(),
  );
  const [terminalResponderHandoffState] = useState(() => {
    let selectedLegacyResponderIdentity: TerminalLegacyResponderSelectionIdentity | null = null;
    return Object.freeze({
      dispatcher: createTerminalResponderHandoffDispatcher({
        readSelectedLegacyResponderIdentity: () => selectedLegacyResponderIdentity,
      }),
      setSelectedLegacyResponderIdentity: (
        identity: TerminalLegacyResponderSelectionIdentity | null,
      ): void => {
        selectedLegacyResponderIdentity = identity;
      },
    });
  });
  const retainedMutationLeasesRef = useRef<Map<string, RetainedTerminalMutationLease>>(new Map());
  const controlConnectionIdRef = useRef<string | null>(null);
  const controlSocketEnqueueOrdinalRef = useRef(0);
  const terminalDeliveryCapabilityRef = useRef<{
    accepted: boolean;
    connectionEpoch: string | null;
  }>({ accepted: false, connectionEpoch: null });
  const terminalDeliveryVisibilityRef = useRef<Map<string, {
    generation: bigint;
    isVisible: boolean;
    deliveryInterestRefCount: number;
  }>>(new Map());
  const sendTerminalAuthorityControlRef = useRef<(
    input: TerminalAuthorityControlSendInput,
  ) => ImmediateTerminalControlSendResult>(() => ({
    ok: false,
    reason: 'control-socket-not-open',
    controlSocketId: '',
  }));
  const workspaceHandlersRef = useRef<Record<string, WorkspaceEventHandler>>({});
  const debugSendFailureOverrideRef = useRef<Required<DebugWebSocketSendFailureOverride> | null>(null);
  const activeSubscriptionsRef = useRef<Set<string>>(new Set());
  const pendingUnsubscribeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const graceBufferedSessionsRef = useRef<Map<string, GraceBufferedSessionState>>(new Map());
  const mountedRef = useRef(true);

  const bufferGraceMessage = useCallback((sessionId: string, msg: ServerWsMessage) => {
    const current = graceBufferedSessionsRef.current.get(sessionId) ?? { output: [], outputBytes: 0 };

    switch (msg.type) {
      case 'screen-snapshot':
        if (current.reconnectRequired || current.authorityProofMismatch) {
          recordTerminalDebugEvent(sessionId, 'websocket_grace_snapshot_after_reconnect_ignored', {
            replayToken: msg.replayToken,
            snapshotSeq: msg.seq,
          });
          break;
        }
        if (
          current.restoreNeeded
          && (
            !matchesRestoreNeededSnapshotAuthorityProof(current.restoreNeeded, msg)
          )
        ) {
          recordTerminalDebugEvent(sessionId, 'websocket_grace_snapshot_generation_mismatch', {
            replayToken: msg.replayToken,
            snapshotSeq: msg.seq,
            expectedReplayToken: current.restoreNeeded.replayToken,
            expectedSnapshotSeq: current.restoreNeeded.snapshotSeq,
          });
          current.authorityProofMismatch = true;
          current.snapshot = undefined;
          current.ready = undefined;
          current.output = [];
          current.outputBytes = 0;
          break;
        }
        current.snapshot = msg;
        // A ready frame can only complete the snapshot generation that was
        // already observed. Snapshot replacement therefore invalidates any
        // older grace-buffered ready token.
        current.ready = undefined;
        if (!current.restoreNeeded) {
          current.output = [];
          current.outputBytes = 0;
          current.outputOverflowReason = undefined;
        }
        break;
      case 'screen-repair':
      case 'screen-repair:rejected':
        recordTerminalDebugEvent(sessionId, 'screen_repair_grace_buffer_skipped', {
          type: msg.type,
          reason: msg.type === 'screen-repair:rejected' ? msg.reason : null,
        });
        break;
      case 'screen-repair:restore-needed':
        if (current.reconnectRequired) {
          recordTerminalDebugEvent(sessionId, 'screen_repair_restore_after_reconnect_ignored', {
            repairToken: msg.repairToken,
            replayToken: msg.replayToken,
            snapshotSeq: msg.snapshotSeq,
          });
          break;
        }
        if (!hasSameRestoreNeededAuthorityProof(msg, msg)) {
          recordTerminalDebugEvent(sessionId, 'screen_repair_restore_grace_invalid_proof_ignored', {
            repairToken: msg.repairToken,
            replayToken: msg.replayToken,
            snapshotSeq: msg.snapshotSeq,
          });
          current.authorityProofMismatch = true;
          current.restoreNeeded = undefined;
          current.snapshot = undefined;
          current.ready = undefined;
          current.output = [];
          current.outputBytes = 0;
          break;
        }
        if (
          current.restoreNeeded?.repairToken === msg.repairToken
          && current.restoreNeeded.replayToken === msg.replayToken
          && current.restoreNeeded.snapshotSeq === msg.snapshotSeq
        ) {
          if (!hasSameRestoreNeededAuthorityProof(current.restoreNeeded, msg)) {
            recordTerminalDebugEvent(sessionId, 'screen_repair_restore_grace_proof_mismatch_ignored', {
              repairToken: msg.repairToken,
              replayToken: msg.replayToken,
              snapshotSeq: msg.snapshotSeq,
            });
            current.authorityProofMismatch = true;
            current.restoreNeeded = undefined;
            current.snapshot = undefined;
            current.ready = undefined;
            current.output = [];
            current.outputBytes = 0;
            break;
          }
          recordTerminalDebugEvent(sessionId, 'screen_repair_restore_grace_duplicate_ignored', {
            repairToken: msg.repairToken,
            replayToken: msg.replayToken,
            snapshotSeq: msg.snapshotSeq,
          });
          break;
        }
        current.restoreNeeded = msg;
        current.authorityProofMismatch = false;
        current.reconnectRequired = undefined;
        current.snapshot = undefined;
        current.ready = undefined;
        current.output = [];
        current.outputBytes = 0;
        current.outputOverflowReason = undefined;
        break;
      case 'screen-repair:reconnect-required':
        current.reconnectRequired = msg;
        current.restoreNeeded = undefined;
        current.snapshot = undefined;
        current.ready = undefined;
        current.output = [];
        current.outputBytes = 0;
        current.outputOverflowReason = undefined;
        break;
      case 'output':
        {
          if (current.reconnectRequired) {
            break;
          }
          if (
            current.restoreNeeded
            && msg.replayToken !== current.restoreNeeded.replayToken
          ) {
            recordTerminalDebugEvent(sessionId, 'websocket_grace_output_generation_mismatch', {
              replayToken: msg.replayToken ?? null,
              expectedReplayToken: current.restoreNeeded.replayToken,
              screenSeq: msg.screenSeq ?? null,
            });
            break;
          }
          if (current.outputOverflowReason) {
            break;
          }
          const limits = getTerminalResourceLimits();
          const messageBytes = getOutputUtf8ByteLength(msg.data);
          const byteOverflow = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;
          const chunkOverflow = current.output.length + 1 > limits.visibleOutputMaxChunks;
          if (byteOverflow || chunkOverflow) {
            current.output = [];
            current.outputBytes = 0;
            current.outputOverflowReason = byteOverflow
              ? 'byte-cap-exceeded'
              : 'chunk-cap-exceeded';
            recordTerminalDebugEvent(sessionId, 'websocket_grace_output_overflow', {
              reason: current.outputOverflowReason,
              messageBytes,
              maxBytes: limits.visibleOutputQueueMaxBytes,
              maxChunks: limits.visibleOutputMaxChunks,
            });
            break;
          }
          current.output.push(msg);
          current.outputBytes += messageBytes;
        }
        break;
      case 'status':
        current.status = msg.status;
        break;
      case 'session:ready':
        if (current.reconnectRequired) {
          break;
        }
        if (
          current.restoreNeeded
          && (
            !current.snapshot
            || msg.replayToken !== current.restoreNeeded.replayToken
            || msg.snapshotSeq !== current.restoreNeeded.snapshotSeq
          )
        ) {
          recordTerminalDebugEvent(sessionId, 'websocket_grace_ready_generation_mismatch', {
            replayToken: msg.replayToken ?? null,
            snapshotSeq: msg.snapshotSeq ?? null,
            expectedReplayToken: current.restoreNeeded.replayToken,
            expectedSnapshotSeq: current.restoreNeeded.snapshotSeq,
          });
          break;
        }
        if (
          current.snapshot
          && !current.restoreNeeded
          && (
            msg.replayToken !== current.snapshot.replayToken
            || msg.snapshotSeq !== current.snapshot.seq
          )
        ) {
          recordTerminalDebugEvent(sessionId, 'websocket_grace_ready_snapshot_mismatch', {
            replayToken: msg.replayToken ?? null,
            snapshotSeq: msg.snapshotSeq ?? null,
            expectedReplayToken: current.snapshot.replayToken,
            expectedSnapshotSeq: current.snapshot.seq,
          });
          break;
        }
        current.ready = msg;
        break;
      case 'input:rejected':
        recordTerminalDebugEvent(msg.sessionId, 'server_input_rejected', {
          reason: msg.reason,
          inputSeqStart: msg.inputSeqStart ?? null,
          inputSeqEnd: msg.inputSeqEnd ?? null,
          buffered: true,
        });
        break;
      case 'cwd':
        current.cwd = msg.cwd;
        break;
      case 'session:error':
        current.error = msg.message;
        break;
      case 'session:exited':
        current.error = `Shell exited with code ${msg.exitCode}`;
        break;
    }

    graceBufferedSessionsRef.current.set(sessionId, current);
  }, []);

  const flushGraceBuffer = useCallback((sessionId: string, handlers: SessionHandlers) => {
    const buffered = graceBufferedSessionsRef.current.get(sessionId);
    if (!buffered) {
      return;
    }

    graceBufferedSessionsRef.current.delete(sessionId);
    const recoveryTerminal = Boolean(buffered.reconnectRequired) || Boolean(buffered.authorityProofMismatch);
    const recoveryBlocked = recoveryTerminal || Boolean(buffered.outputOverflowReason) || Boolean(buffered.restoreNeeded);
    const recoverySnapshotReady = !buffered.restoreNeeded || Boolean(buffered.snapshot);
    if (!recoveryTerminal && buffered.restoreNeeded) {
      handlers.onScreenRepairRestoreNeeded?.(buffered.restoreNeeded);
    }
    if (buffered.reconnectRequired) {
      handlers.onScreenRepairReconnectRequired?.(buffered.reconnectRequired);
    }
    if (buffered.outputOverflowReason) {
      handlers.onGraceOutputOverflow?.(buffered.outputOverflowReason);
    }
    if (buffered.authorityProofMismatch) {
      handlers.onGraceAuthorityProofMismatch?.();
    }
    if (buffered.subscribedInfo) {
      handlers.onSubscribed?.({
        ...buffered.subscribedInfo,
        ready: recoveryBlocked ? false : buffered.subscribedInfo.ready,
      });
    }
    if (!recoveryTerminal && !buffered.outputOverflowReason && buffered.snapshot) {
      handlers.onScreenSnapshot?.(buffered.snapshot);
    }
    if (buffered.status) {
      handlers.onStatus?.(buffered.status);
    }
    if (buffered.cwd) {
      handlers.onCwd?.(buffered.cwd);
    }
    if (!recoveryTerminal && recoverySnapshotReady) {
      for (const output of buffered.output) {
        handlers.onOutput?.(fromJsonOutputMessage(output.data, output));
      }
    }
    if (!recoveryTerminal && recoverySnapshotReady && !buffered.outputOverflowReason && buffered.ready) {
      handlers.onSessionReady?.(buffered.ready);
    }
    if (buffered.error) {
      handlers.onError?.(buffered.error);
    }
  }, []);

  const listNegotiatedTerminalCheckpointViews = useCallback((): readonly TerminalCheckpointViewRegistration[] => (
    terminalCheckpointDispatchersRef.current.listViews().map(view => ({
      ...view,
      queryReplyCapability: 'terminal.query-reply-input.v1' as const,
      parserResponderCapability: 'terminal.parser-responder-disable.v1' as const,
    }))
  ), []);

  const requestCurrentTerminalCheckpointCapability = useCallback((): void => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    requestTerminalCheckpointCapability(socket, listNegotiatedTerminalCheckpointViews());
    requestTerminalBinaryCapability(socket);
  }, [listNegotiatedTerminalCheckpointViews]);

  const publishAppliedTerminalCheckpointCapability = useCallback((
    appliedCheckpoint: TerminalCheckpointCapabilityMessage,
  ): void => {
    const controlSocketId = controlConnectionIdRef.current;
    if (!controlSocketId) return;
    const response = respondToTerminalAuthorityViewAttributeCapability(
      appliedCheckpoint,
      message => sendTerminalAuthorityControlRef.current({
        message,
        expectedControlSocketId: controlSocketId,
        afterEnqueueOrdinal: controlSocketEnqueueOrdinalRef.current,
      }),
    );
    for (const failure of response.failures) {
      recordTerminalDebugEvent(failure.sessionId, 'terminal_view_attributes_push_failed', {
        reason: failure.reason,
        viewGeneration: failure.viewGeneration,
      });
    }
  }, []);

  // @req REL-BGSTAB-012 AC-1 AC-7
  const flushTerminalDeliveryVisibility = useCallback((): void => {
    if (!terminalDeliveryCapabilityRef.current.accepted) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const [sessionId, visibility] of terminalDeliveryVisibilityRef.current) {
      sendOpenBrowserWebSocketMessage({
        message: {
          type: 'terminal-delivery:visibility',
          sessionId,
          visibilityGeneration: visibility.generation.toString(),
          isVisible: visibility.isVisible,
          deliveryInterestRefCount: visibility.deliveryInterestRefCount,
        },
        socket,
        limits: getClientWsResourceLimits(),
        openReadyState: WebSocket.OPEN,
      });
    }
  }, []);

  // @req REL-BGSTAB-012 AC-1 AC-7
  const publishTerminalDeliveryVisibility = useCallback((input: {
    sessionId: string;
    isVisible: boolean;
    deliveryInterestRefCount?: number;
  }): void => {
    const current = terminalDeliveryVisibilityRef.current.get(input.sessionId);
    const deliveryInterestRefCount = input.deliveryInterestRefCount ?? 1;
    if (
      current
      && current.isVisible === input.isVisible
      && current.deliveryInterestRefCount === deliveryInterestRefCount
    ) {
      return;
    }
    const generation = (current?.generation ?? 0n) + 1n;
    terminalDeliveryVisibilityRef.current.set(input.sessionId, {
      generation,
      isVisible: input.isVisible,
      deliveryInterestRefCount,
    });
    flushTerminalDeliveryVisibility();
  }, [flushTerminalDeliveryVisibility]);

  // ------ Message handler ------
  const handleMessage = useCallback((event: MessageEvent) => {
    const frame = classifyWsFrame(event.data);
    if (frame.kind === 'binary') {
      const report = intakeBinaryFrames(frame.buffer, {
        maxBodyBytes: deriveMaxBodyBytes(getCachedTerminalOutputResourceLimits()),
        channelState: channelRegistryRef.current.channelState,
        lookupChannel: channelRegistryRef.current.lookup,
        // A session with no attached handler cannot be served: the grace buffer
        // holds JSON messages, not deliveries, so a frame arriving mid-detach
        // is reported rather than queued.
        liveTokens: id => sessionHandlersRef.current.get(id)?.getLiveOutputTokens?.(),
        deliverOutput: (id, delivery) => {
          sessionHandlersRef.current.get(id)?.onOutput?.(delivery);
        },
      });
      // `01:433` — an unknown channel is recovered, never dropped. Only that
      // channel is asked about, so one stale id cannot restart the connection.
      const recovery = buildUnknownChannelRequest(report.unroutable);
      if (recovery && wsRef.current?.readyState === WebSocket.OPEN) {
        sendOpenBrowserWebSocketMessage({
          message: recovery,
          socket: wsRef.current,
          limits: getClientWsResourceLimits(),
          openReadyState: WebSocket.OPEN,
        });
      }
      if (report.fatal || report.scoped.length > 0 || report.unroutable.length > 0) {
        console.warn('[WS] binary frame rejected', {
          fatal: report.fatal?.code,
          scoped: report.scoped.map(rejection => rejection.code),
          unroutable: report.unroutable,
          delivered: report.delivered,
        });
      }
      return;
    }
    if (frame.kind !== 'json') {
      // A Blob means `binaryType` was left at its default; malformed JSON means
      // the peer sent something unparseable. Both used to vanish silently.
      console.warn('[WS] unreadable frame', frame);
      return;
    }
    const rawMessage: unknown = frame.message;

    // `01 §2.2` layer 2. Placed first because a control message that fell
    // through to the generic path would be logged as an unknown type and the
    // channel table would never be seeded.
    if (isTerminalBinaryControlMessage(rawMessage)) {
      const outcome = applyTerminalBinaryControlMessage(rawMessage, channelRegistryRef.current);
      if (outcome.kind === 'rejected' || outcome.kind === 'ignored') {
        console.warn('[WS] binary negotiation not in effect', outcome);
      }
      return;
    }

    if (
      isCheckpointProtocolRecord(rawMessage)
      && (
        rawMessage.type === 'terminal-authority:responder-disable-boundary'
        || rawMessage.type === 'terminal-authority:rollback-start'
        || rawMessage.type === 'terminal-authority:legacy-responder-enabled'
      )
    ) {
      const parsedHandoff = parseTerminalResponderHandoffServerMessage(rawMessage);
      if (!parsedHandoff.ok) {
        const sessionId = typeof rawMessage.sessionId === 'string' ? rawMessage.sessionId : null;
        if (sessionId) {
          recordTerminalDebugEvent(sessionId, 'terminal_authority_handoff_frame_rejected', {
            type: rawMessage.type,
            reason: parsedHandoff.reason,
          });
        }
        return;
      }

      const handoff = parsedHandoff.message;
      const handlers = terminalResponderHandoffViewsRef.current.get(handoff.sessionId);
      if (handoff.type === 'terminal-authority:legacy-responder-enabled') {
        terminalResponderHandoffState.setSelectedLegacyResponderIdentity(handoff);
        const routeResult = terminalResponderHandoffState.dispatcher.route(handoff);
        if (routeResult.accepted) {
          handlers?.onLegacyResponderEnabled(handoff);
        } else if (
          routeResult.reason === 'legacy-responder-view-unavailable'
          && handlers
          && controlConnectionIdRef.current === handoff.connectionId
          && handlers.getViewGeneration() === handoff.viewGeneration
          && handoff.checkpointApplied
          && handoff.postSnapshotTailDrained
        ) {
          // @req MIG-BGSTAB-002 AC-2 AC-4 AC-5
          // A runtime recreated after the rollback quorum has no local drain
          // entry to route through. The server rebind frame is admissible only
          // for the exact live control connection/view and only after the
          // compatibility checkpoint and post-snapshot tail are proven.
          handlers.onLegacyResponderEnabled(handoff);
          recordTerminalDebugEvent(handoff.sessionId, 'terminal_authority_legacy_enable_rebound', {
            viewGeneration: handoff.viewGeneration,
            completedViewQuorum: routeResult.completedViewQuorum,
            matchedViewCount: 1,
          });
        } else {
          recordTerminalDebugEvent(handoff.sessionId, 'terminal_authority_legacy_enable_rejected', {
            reason: routeResult.reason ?? 'legacy-enable-rejected',
            viewGeneration: handoff.viewGeneration,
            completedViewQuorum: routeResult.completedViewQuorum,
            matchedViewCount: routeResult.matchedViewCount,
          });
        }
        return;
      }

      const connectionId = controlConnectionIdRef.current;
      const currentViewGeneration = handlers?.getViewGeneration();
      const candidateViews = handoff.type === 'terminal-authority:responder-disable-boundary'
        ? handoff.requiredResponderViews
        : handoff.affectedViews;
      const currentView = connectionId && currentViewGeneration !== undefined
        ? candidateViews.find(view => (
            view.connectionId === connectionId
            && view.viewGeneration === currentViewGeneration
          ))
        : undefined;
      if (!handlers || !currentView || !connectionId) {
        recordTerminalDebugEvent(handoff.sessionId, 'terminal_authority_view_frame_unmatched', {
          type: handoff.type,
          connectionId,
          viewGeneration: currentViewGeneration ?? null,
        });
        return;
      }

      if (handoff.type === 'terminal-authority:responder-disable-boundary') {
        if (currentView.responderLeaseId !== handoff.responderLeaseId) {
          recordTerminalDebugEvent(handoff.sessionId, 'terminal_authority_disable_lease_mismatch', {
            viewGeneration: currentView.viewGeneration,
          });
          return;
        }
        handlers.onResponderDisableBoundary(handoff, {
          sessionId: handoff.sessionId,
          connectionId,
          viewGeneration: currentView.viewGeneration,
          transitionEpoch: handoff.transitionEpoch,
          authorityEpoch: handoff.authorityEpoch,
          streamEpoch: handoff.streamEpoch,
          responderLeaseId: handoff.responderLeaseId,
          boundarySourceSeq: handoff.boundarySourceSeq,
        });
        return;
      }

      terminalResponderHandoffState.setSelectedLegacyResponderIdentity(null);
      handlers.onRollbackStart(handoff, {
        sessionId: handoff.sessionId,
        connectionId,
        viewGeneration: currentView.viewGeneration,
        transitionEpoch: handoff.transitionEpoch,
        authorityEpoch: handoff.authorityEpoch,
        streamEpoch: handoff.streamEpoch,
        responderLeaseId: handoff.responderLeaseId,
        boundarySourceSeq: handoff.boundarySourceSeq,
      });
      return;
    }

    if (
      isCheckpointProtocolRecord(rawMessage)
      && rawMessage.type.startsWith('terminal-checkpoint:')
    ) {
      const parsedCheckpoint = parseTerminalCheckpointServerMessage(rawMessage);
      if (!parsedCheckpoint.ok) {
        const failureReason = `checkpoint-invalid-frame:${parsedCheckpoint.reason}`;
        const failureBoundary = extractTerminalCheckpointFailureBoundary(rawMessage);
        const sessionId = typeof rawMessage.sessionId === 'string' && rawMessage.sessionId.length > 0
          ? rawMessage.sessionId
          : null;
        if (isGlobalTerminalCheckpointControlFailure(rawMessage)) {
          terminalCheckpointDispatchersRef.current.failActive(
            failureReason,
            failureBoundary,
          );
        } else if (sessionId) {
          recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_invalid_frame_rejected', {
            type: rawMessage.type,
            reason: parsedCheckpoint.reason,
          });
          terminalCheckpointDispatchersRef.current.failSession(
            sessionId,
            failureReason,
            failureBoundary,
          );
        } else {
          terminalCheckpointDispatchersRef.current.failActive(
            failureReason,
            failureBoundary,
          );
        }
        return;
      }

      const checkpoint = parsedCheckpoint.message;
      if (checkpoint.type === 'terminal-checkpoint:capability') {
        const freshCheckpoint = terminalCheckpointDispatchersRef.current
          .selectFreshCapability(checkpoint);
        if (!freshCheckpoint) {
          const preparation = checkpoint.checkpointDeliveryPreparation;
          const preparedView = checkpoint.registeredViews?.find(view => (
            view.viewGeneration === preparation?.viewGeneration
          ));
          if (preparation && preparedView) {
            recordTerminalDebugEvent(
              preparedView.sessionId,
              'terminal_checkpoint_preparation_not_selected',
              {
                checkpointDeliveryId: preparation.checkpointDeliveryId,
                viewGeneration: preparation.viewGeneration,
              },
            );
          }
          return;
        }
        retainedMutationLeasesRef.current = reconcileTerminalCheckpointMutationLeases(
          retainedMutationLeasesRef.current,
          freshCheckpoint,
          freshCheckpoint,
        );
        const appliedCheckpoint = terminalCheckpointDispatchersRef.current
          .setCapability(freshCheckpoint);
        retainedMutationLeasesRef.current = reconcileTerminalCheckpointMutationLeases(
          retainedMutationLeasesRef.current,
          freshCheckpoint,
          appliedCheckpoint,
        );
        if (!appliedCheckpoint) return;
        const controlSocketId = controlConnectionIdRef.current;
        if (controlSocketId) {
          const response = respondToTerminalAuthorityViewAttributeCapability(
            appliedCheckpoint,
            message => sendTerminalAuthorityControlRef.current({
              message,
              expectedControlSocketId: controlSocketId,
              afterEnqueueOrdinal: controlSocketEnqueueOrdinalRef.current,
            }),
          );
          for (const failure of response.failures) {
            recordTerminalDebugEvent(failure.sessionId, 'terminal_view_attributes_push_failed', {
              reason: failure.reason,
              viewGeneration: failure.viewGeneration,
            });
          }
        }
        return;
      }
      if (checkpoint.type === 'terminal-checkpoint:rejected') {
        if (checkpoint.sessionId) {
          recordTerminalDebugEvent(checkpoint.sessionId, 'terminal_checkpoint_server_rejected', {
            phase: checkpoint.phase,
            reason: checkpoint.reason,
          });
        }
        if (isTerminalCheckpointMutationRejection(checkpoint)) {
          return;
        }
        if (isGlobalTerminalCheckpointControlFailure(checkpoint)) {
          terminalCheckpointDispatchersRef.current.failActive(
            `checkpoint-server-rejected:${checkpoint.reason}`,
          );
        } else if (checkpoint.sessionId) {
          terminalCheckpointDispatchersRef.current.route(checkpoint);
        } else {
          terminalCheckpointDispatchersRef.current.failActive(
            `checkpoint-server-rejected:${checkpoint.reason}`,
          );
        }
        return;
      }

      if (
        checkpoint.type === 'terminal-checkpoint:continuity-rebound'
        || checkpoint.type === 'terminal-checkpoint:fresh-checkpoint-required'
      ) {
        return;
      }

      const routeResult = terminalCheckpointDispatchersRef.current.route(checkpoint);
      if (routeResult.delivered) {
        return;
      }
      if (routeResult.handled) {
        return;
      }

      recordTerminalDebugEvent(checkpoint.sessionId, 'terminal_checkpoint_inactive_frame_rejected', {
        type: checkpoint.type,
        reason: routeResult.reason,
        streamEpoch: checkpoint.streamEpoch,
        checkpointEpoch: checkpoint.checkpointEpoch,
        sourceSeq: checkpoint.sourceSeq,
        snapshotSeq: checkpoint.snapshotSeq,
        viewGeneration: checkpoint.viewGeneration,
      });
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendOpenBrowserWebSocketMessage({
          message: {
            type: 'terminal-checkpoint:failure-ack',
            protocolVersion: checkpoint.protocolVersion,
            sessionId: checkpoint.sessionId,
            viewGeneration: checkpoint.viewGeneration,
            streamEpoch: checkpoint.streamEpoch,
            checkpointEpoch: checkpoint.checkpointEpoch,
            sourceSeq: checkpoint.sourceSeq,
            snapshotSeq: checkpoint.snapshotSeq,
            oldestRetainedSeq: checkpoint.oldestRetainedSeq,
            retentionPolicyId: checkpoint.retentionPolicyId,
            reason: 'apply-failed',
          },
          socket,
          limits: getClientWsResourceLimits(),
          openReadyState: WebSocket.OPEN,
        });
      }
      return;
    }

    if (!isCheckpointProtocolRecord(rawMessage)) {
      return;
    }

    const msg = rawMessage as ServerWsMessage;

    // Connection events
    if (msg.type === 'connected') {
      if (msg.channel === 'output') {
        const control = wsRef.current;
        if (control?.readyState === WebSocket.OPEN) {
          requestTerminalCheckpointCapability(
            control,
            listNegotiatedTerminalCheckpointViews(),
          );
          requestTerminalBinaryCapability(control);
        }
        return;
      }
      retainedMutationLeasesRef.current.clear();
      controlConnectionIdRef.current = msg.connectionId ?? msg.clientId;
      controlSocketEnqueueOrdinalRef.current = 0;
      terminalDeliveryCapabilityRef.current = { accepted: false, connectionEpoch: null };
      setClientId(msg.clientId);
      setWsClientId(msg.clientId);
      const control = wsRef.current;
      if (control?.readyState === WebSocket.OPEN) {
        sendOpenBrowserWebSocketMessage({
          message: {
            type: 'terminal-delivery:capability',
            protocolVersion: 1,
            supportsHiddenDataGapRecovery: true,
          },
          socket: control,
          limits: getClientWsResourceLimits(),
          openReadyState: WebSocket.OPEN,
        });
      }
      const outputUrl = buildSplitOutputWebSocketUrl({
        token: tokenStorage.getToken(),
        location: window.location,
        metadata: msg,
      });
      if (outputUrl) {
        outputWsRef.current?.close();
        const output = new WebSocket(outputUrl);
        output.binaryType = 'arraybuffer';
        outputWsRef.current = output;
        output.onmessage = event => {
          if (outputWsRef.current === output) handleMessageRef.current(event);
        };
        output.onclose = () => {
          if (outputWsRef.current === output) outputWsRef.current = null;
        };
        output.onerror = () => {
          // The control socket remains authoritative and can reconnect or
          // receive a replacement output pairing independently.
        };
      }
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'terminal-delivery:capability') {
      terminalDeliveryCapabilityRef.current = {
        accepted: msg.accepted,
        connectionEpoch: msg.connectionEpoch,
      };
      if (msg.accepted) {
        flushTerminalDeliveryVisibility();
      }
      return;
    }

    // Subscribed response — route status to handlers
    if (msg.type === 'subscribed') {
      // Sessions without the channel fields are skipped, so this is a no-op
      // until the server gains a binary encode surface (`08:194`).
      const refusedRebinds = channelRegistryRef.current.registerAll(
        channelEntriesFromSubscribed(msg.sessions),
      );
      for (const info of msg.sessions) {
        const handlers = sessionHandlersRef.current.get(info.sessionId);
        if (!handlers) {
          if (
            activeSubscriptionsRef.current.has(info.sessionId) &&
            pendingUnsubscribeTimersRef.current.has(info.sessionId)
          ) {
            const current = graceBufferedSessionsRef.current.get(info.sessionId) ?? { output: [], outputBytes: 0 };
            current.subscribedInfo = { status: info.status, cwd: info.cwd, ready: info.ready };
            if (info.cwd) {
              current.cwd = info.cwd;
            }
            if (info.status === 'error') {
              current.error = 'Session not found';
            } else {
              current.status = info.status;
            }
            graceBufferedSessionsRef.current.set(info.sessionId, current);
          }
          continue;
        }
        if (info.status === 'error') {
          handlers.onError?.('Session not found');
        } else {
          handlers.onSubscribed?.({ status: info.status, cwd: info.cwd, ready: info.ready });
          if (info.ready) {
            handlers.onSessionReady?.({ type: 'session:ready', sessionId: info.sessionId });
          }
          handlers.onStatus?.(info.status);
          if (info.cwd) handlers.onCwd?.(info.cwd);
        }
      }
      // Reported after the sessions are dispatched, not before. The server
      // reassigned a channel it still owed to another session, which `01:392`
      // forbids, and this is the last point at which that is legible — from
      // here the codec reports the dropped frames as ordinary retired-channel
      // traffic. But it is a diagnostic, so it must not be able to preempt the
      // functional work: placed above, a throwing `console` would leave the
      // registry mutated and every session in this message undispatched.
      for (const refused of refusedRebinds) {
        console.warn('[WS] refused channel rebind', refused);
      }
      return;
    }

    // Session events (have sessionId field)
    if ('sessionId' in msg) {
      const sessionId = (msg as { sessionId: string }).sessionId;
      if (msg.type === 'terminal-delivery:ack-rejected') {
        const parsedAckRejection = parseTerminalDeliveryAckRejectedMessage(rawMessage);
        if (parsedAckRejection.ok) {
          recordTerminalDebugEvent(parsedAckRejection.message.sessionId, 'terminal_delivery_ack_rejected', {
            connectionEpoch: parsedAckRejection.message.connectionEpoch,
            deliverySeq: parsedAckRejection.message.deliverySeq,
            reason: parsedAckRejection.message.reason,
          }, undefined, { includeInputReliabilityMode: false });
        }
        return;
      }
      if (msg.type === 'input:rejected') {
        recordTerminalDebugEvent(sessionId, 'server_input_rejected', {
          reason: msg.reason,
          inputSeqStart: msg.inputSeqStart ?? null,
          inputSeqEnd: msg.inputSeqEnd ?? null,
        });
      }
      const handlers = sessionHandlersRef.current.get(sessionId);
      if (!handlers) {
        if (msg.type === 'screen-repair' || msg.type === 'screen-repair:rejected') {
          recordTerminalDebugEvent(sessionId, 'screen_repair_handler_missing', {
            type: msg.type,
            reason: msg.type === 'screen-repair:rejected' ? msg.reason : null,
          });
          return;
        }
        if (
          activeSubscriptionsRef.current.has(sessionId) &&
          pendingUnsubscribeTimersRef.current.has(sessionId)
        ) {
          bufferGraceMessage(sessionId, msg);
        }
        return;
      }

      switch (msg.type) {
        case 'terminal-delivery:data-gap': {
          handlers.onTerminalDeliveryDataGap?.(msg);
          terminalCheckpointDispatchersRef.current.failSession(
            sessionId,
            'hidden-data-gap-authoritative-recovery-required',
            {
              viewGeneration: msg.viewGeneration,
              streamEpoch: msg.streamEpoch,
              checkpointEpoch: msg.checkpointEpoch,
            },
          );
          break;
        }
        case 'screen-snapshot':
          handlers.onScreenSnapshot?.(msg);
          break;
        case 'screen-repair':
          handlers.onScreenRepair?.(msg);
          break;
        case 'screen-repair:rejected':
          handlers.onScreenRepairRejected?.(msg);
          break;
        case 'screen-repair:restore-needed':
          handlers.onScreenRepairRestoreNeeded?.(msg);
          break;
        case 'screen-repair:reconnect-required':
          handlers.onScreenRepairReconnectRequired?.(msg);
          break;
        case 'output':
          handlers.onOutput?.(fromJsonOutputMessage(msg.data, msg));
          break;
        case 'status':
          handlers.onStatus?.(msg.status);
          break;
        case 'session:ready':
          handlers.onSessionReady?.(msg);
          // A replacement replay can retain the existing xterm runtime, so
          // registration does not naturally re-run. Re-negotiate only after
          // the replay ACK has produced session:ready; this binds the live
          // view to the new snapshot lineage rather than the superseded one.
          requestCurrentTerminalCheckpointCapability();
          break;
        case 'input:rejected':
          break;
        case 'cwd':
          handlers.onCwd?.(msg.cwd);
          break;
        case 'session:error':
          handlers.onError?.(msg.message);
          break;
        case 'session:exited':
          handlers.onError?.(`Shell exited with code ${msg.exitCode}`);
          break;
      }
      return;
    }

    // Workspace/tab/grid events
    const wsHandler = workspaceHandlersRef.current[msg.type];
    if (wsHandler && 'data' in msg) {
      wsHandler((msg as { data: unknown }).data);
    }
  }, [
    bufferGraceMessage,
    flushTerminalDeliveryVisibility,
    listNegotiatedTerminalCheckpointViews,
    requestCurrentTerminalCheckpointCapability,
    terminalResponderHandoffState,
  ]);
  handleMessageRef.current = handleMessage;

  // ------ Connect ------
  const connect = useCallback(async () => {
    const connectAttemptGeneration = connectAttemptFence.begin();
    const token = tokenStorage.getToken();
    if (!token) {
      setStatus('disconnected');
      return;
    }

    await initializeInputReliabilityMode();
    if (!mountedRef.current || !connectAttemptFence.isCurrent(connectAttemptGeneration)) return;

    terminalCheckpointDispatchersRef.current.setCapability(null);
    terminalResponderHandoffState.setSelectedLegacyResponderIdentity(null);
    controlConnectionIdRef.current = null;
    controlSocketEnqueueOrdinalRef.current = 0;
    // Cleared rather than retired: channel ids are connection-scoped and the
    // next connection can reissue them to different sessions (`08:196`).
    channelRegistryRef.current.clear();
    outputWsRef.current?.close();
    outputWsRef.current = null;
    const url = getWsUrl();
    const ws = new WebSocket(url);
    // Set before the fence check below can return: a socket that skipped this
    // would deliver Blobs, which a synchronous handler cannot read.
    ws.binaryType = 'arraybuffer';
    if (!mountedRef.current || !connectAttemptFence.isCurrent(connectAttemptGeneration)) {
      ws.close();
      return;
    }
    wsRef.current = ws;
    setStatus('reconnecting');

    ws.onopen = () => {
      if (!mountedRef.current) return;
      if (wsRef.current !== ws) return;
      // Recovery messages buffered during a handler grace interval belong to
      // the socket that delivered them. Replaying them after a reconnect can
      // let an old reconnect-required frame close the replacement socket.
      graceBufferedSessionsRef.current.clear();
      reconnectAttemptRef.current = 0;
      setStatus('connected');
      console.log('[WS] Connected');

      requestTerminalCheckpointCapability(
        ws,
        listNegotiatedTerminalCheckpointViews(),
      );
      requestTerminalBinaryCapability(ws);

      // Re-subscribe only after the additive capability request is ordered on
      // this socket. The current server still answers legacy/inactive.
      if (activeSubscriptionsRef.current.size > 0) {
        const sessionIds = Array.from(activeSubscriptionsRef.current);
        ws.send(JSON.stringify({ type: 'subscribe', sessionIds }));
      }
    };

    ws.onmessage = (event) => {
      // Ignore messages from stale WebSocket connections (e.g., WS1 closing
      // while WS2 is already active after React StrictMode double mount).
      // Without this guard, both WS1 and WS2 deliver the same PTY output
      // to handleMessage, causing double writes to the terminal.
      if (wsRef.current !== ws) return;
      handleMessage(event);
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      outputWsRef.current?.close();
      outputWsRef.current = null;
      terminalCheckpointDispatchersRef.current.setCapability(null);
      terminalResponderHandoffState.setSelectedLegacyResponderIdentity(null);
      terminalDeliveryCapabilityRef.current = { accepted: false, connectionEpoch: null };
      controlConnectionIdRef.current = null;
      controlSocketEnqueueOrdinalRef.current = 0;
      setClientId(null);
      setWsClientId(null);
      attemptReconnectRef.current();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [connectAttemptFence, handleMessage, listNegotiatedTerminalCheckpointViews, terminalResponderHandoffState]);

  // ------ Reconnect with exponential backoff ------
  const attemptReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
      setStatus('disconnected');
      console.warn('[WS] Max reconnect attempts reached');
      return;
    }

    setStatus('reconnecting');
    const delay = getReconnectDelay(reconnectAttemptRef.current);
    reconnectAttemptRef.current++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current}/${RECONNECT_MAX_ATTEMPTS})`);
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) void connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    attemptReconnectRef.current = attemptReconnect;
  }, [attemptReconnect]);

  useEffect(() => {
    return registerWebSocketSendFailureHandler((override) => {
      debugSendFailureOverrideRef.current = override
        ? {
            reason: override.reason,
            count: Math.max(1, override.count ?? 1),
          }
        : null;
    });
  }, []);

  // ------ Lifecycle ------
  useEffect(() => {
    mountedRef.current = true;
    void connect();

    return () => {
      mountedRef.current = false;
      connectAttemptFence.invalidate();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      for (const timer of pendingUnsubscribeTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingUnsubscribeTimersRef.current.clear();
      graceBufferedSessionsRef.current.clear();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (outputWsRef.current) {
        outputWsRef.current.close();
        outputWsRef.current = null;
      }
    };
  }, [connect, connectAttemptFence]);

  // ------ Public API ------
  const send = useCallback((msg: ClientWsMessage): SendResult => {
    const debugOverride = debugSendFailureOverrideRef.current;
    if (msg.type === 'input' && debugOverride && debugOverride.count > 0) {
      debugOverride.count -= 1;
      if (debugOverride.count <= 0) {
        debugSendFailureOverrideRef.current = null;
      }
      const debugInput = buildTerminalInputDebugPayload(msg.data, {
        captureSeq: msg.metadata?.captureSeq,
        compositionSeq: msg.metadata?.compositionSeq,
      });
      recordTerminalDebugEvent(msg.sessionId, debugOverride.reason === 'send-failed'
        ? 'ws_send_failed_exception'
        : 'ws_send_debug_failure_forced', {
        ...debugInput.details,
        inputSeqStart: msg.inputSeqStart ?? null,
        inputSeqEnd: msg.inputSeqEnd ?? null,
        sendResultReason: debugOverride.reason,
        wsStatus: statusRef.current,
      }, debugInput.preview);
      return { ok: false, reason: debugOverride.reason };
    }

    const token = tokenStorage.getToken();
    if (!token) {
      if (msg.type === 'input') {
        const debugInput = buildTerminalInputDebugPayload(msg.data, {
          captureSeq: msg.metadata?.captureSeq,
          compositionSeq: msg.metadata?.compositionSeq,
        });
        recordTerminalDebugEvent(msg.sessionId, 'ws_send_rejected_missing_token', {
          ...debugInput.details,
          inputSeqStart: msg.inputSeqStart ?? null,
          inputSeqEnd: msg.inputSeqEnd ?? null,
          wsStatus: statusRef.current,
        }, debugInput.preview);
      }
      return { ok: false, reason: 'missing-token' };
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const wireMessage = attachRetainedMutationLease(msg, retainedMutationLeasesRef.current);
      const result = sendOpenBrowserWebSocketMessage({
        message: wireMessage,
        socket: ws,
        limits: getClientWsResourceLimits(),
        openReadyState: WebSocket.OPEN,
        onHardBackpressure: () => {
          ws.close();
        },
      });
      if (result.ok) {
        if (controlSocketEnqueueOrdinalRef.current < Number.MAX_SAFE_INTEGER) {
          controlSocketEnqueueOrdinalRef.current += 1;
        }
        return result;
      }

      if (msg.type === 'input') {
        const debugInput = buildTerminalInputDebugPayload(msg.data, {
          captureSeq: msg.metadata?.captureSeq,
          compositionSeq: msg.metadata?.compositionSeq,
        });
        recordTerminalDebugEvent(msg.sessionId, result.reason === 'send-failed'
          ? 'ws_send_failed_exception'
          : 'ws_send_rejected_client_backpressure', {
          ...debugInput.details,
          inputSeqStart: msg.inputSeqStart ?? null,
          inputSeqEnd: msg.inputSeqEnd ?? null,
          sendResultReason: result.reason,
          wsStatus: statusRef.current,
          bufferedAmount: result.bufferedAmount ?? null,
          payloadBytes: result.payloadBytes ?? null,
        }, debugInput.preview);
      }

      return result;
    }

    const reason = ws && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)
      ? 'stale-socket'
      : 'not-open';
    if (msg.type === 'input') {
      const debugInput = buildTerminalInputDebugPayload(msg.data, {
        captureSeq: msg.metadata?.captureSeq,
        compositionSeq: msg.metadata?.compositionSeq,
      });
      recordTerminalDebugEvent(msg.sessionId, 'ws_send_rejected_not_open', {
        ...debugInput.details,
        inputSeqStart: msg.inputSeqStart ?? null,
        inputSeqEnd: msg.inputSeqEnd ?? null,
        sendResultReason: reason,
        wsStatus: statusRef.current,
        readyState: ws?.readyState ?? null,
      }, debugInput.preview);
    }
    return { ok: false, reason };
  }, []);

  const getTerminalControlSocketReceipt = useCallback((): ImmediateTerminalControlSendResult => {
    const socket = wsRef.current;
    const controlSocketId = controlConnectionIdRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !controlSocketId) {
      return {
        ok: false,
        reason: 'control-socket-not-open',
        controlSocketId: controlSocketId ?? '',
      };
    }
    return {
      ok: true,
      controlSocketId,
      enqueueOrdinal: controlSocketEnqueueOrdinalRef.current,
    };
  }, []);

  const sendTerminalAuthorityControl = useCallback((
    input: TerminalAuthorityControlSendInput,
  ): ImmediateTerminalControlSendResult => {
    const socket = wsRef.current;
    const controlSocketId = controlConnectionIdRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !controlSocketId) {
      return {
        ok: false,
        reason: 'control-socket-not-open',
        controlSocketId: controlSocketId ?? input.expectedControlSocketId,
      };
    }
    if (controlSocketId !== input.expectedControlSocketId) {
      return {
        ok: false,
        reason: 'control-socket-mismatch',
        controlSocketId,
      };
    }
    if (
      !Number.isSafeInteger(input.afterEnqueueOrdinal)
      || input.afterEnqueueOrdinal < 0
      || input.afterEnqueueOrdinal > controlSocketEnqueueOrdinalRef.current
      || controlSocketEnqueueOrdinalRef.current >= Number.MAX_SAFE_INTEGER
    ) {
      return {
        ok: false,
        reason: 'control-socket-enqueue-order-regression',
        controlSocketId,
      };
    }
    const debugOverride = debugSendFailureOverrideRef.current;
    if (input.message.type === 'input' && debugOverride && debugOverride.count > 0) {
      debugOverride.count -= 1;
      if (debugOverride.count <= 0) debugSendFailureOverrideRef.current = null;
      return {
        ok: false,
        reason: debugOverride.reason,
        controlSocketId,
      };
    }
    if (!tokenStorage.getToken()) {
      return { ok: false, reason: 'missing-token', controlSocketId };
    }
    const result = sendOpenBrowserWebSocketMessage({
      message: input.message,
      socket,
      limits: getClientWsResourceLimits(),
      openReadyState: WebSocket.OPEN,
      onHardBackpressure: () => socket.close(),
    });
    if (!result.ok) {
      return { ok: false, reason: result.reason, controlSocketId };
    }
    controlSocketEnqueueOrdinalRef.current += 1;
    return {
      ok: true,
      controlSocketId,
      enqueueOrdinal: controlSocketEnqueueOrdinalRef.current,
    };
  }, []);
  sendTerminalAuthorityControlRef.current = sendTerminalAuthorityControl;

  const subscribeSession = useCallback((sessionId: string, handlers: SessionHandlers): (() => void) => {
    const pendingTimer = pendingUnsubscribeTimersRef.current.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingUnsubscribeTimersRef.current.delete(sessionId);
    }

    // Always update handlers (re-render may provide new callbacks)
    sessionHandlersRef.current.set(sessionId, handlers);
    flushGraceBuffer(sessionId, handlers);

    // Only send WS subscribe if not already subscribed (prevents duplicate on re-mount)
    const alreadySubscribed = activeSubscriptionsRef.current.has(sessionId);
    activeSubscriptionsRef.current.add(sessionId);

    if (!alreadySubscribed) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', sessionIds: [sessionId] }));
      }
    }

    // Capture this specific handlers reference for cleanup identity check
    const myHandlers = handlers;

    // Return cleanup function
    return () => {
      // Only remove if this cleanup's handlers are still the active ones.
      // During grid↔tab view transitions, a new instance may have already
      // registered its handlers via set() before this cleanup runs.
      const currentHandlers = sessionHandlersRef.current.get(sessionId);
      if (currentHandlers === myHandlers) {
        sessionHandlersRef.current.delete(sessionId);
        const timer = setTimeout(() => {
          pendingUnsubscribeTimersRef.current.delete(sessionId);
          if (sessionHandlersRef.current.has(sessionId)) {
            return;
          }

          graceBufferedSessionsRef.current.delete(sessionId);
          activeSubscriptionsRef.current.delete(sessionId);
          // Retired, not removed: frames already in flight belong to a session
          // the client has discarded, so they are a silent drop with a
          // diagnostic rather than an unknown-channel rejection (`08:196`).
          channelRegistryRef.current.retireSession(sessionId);
          const currentWs = wsRef.current;
          if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify({ type: 'unsubscribe', sessionIds: [sessionId] }));
          }
        }, SUBSCRIPTION_GRACE_MS);
        pendingUnsubscribeTimersRef.current.set(sessionId, timer);
      }
      // If currentHandlers !== myHandlers, a newer instance already took over — skip cleanup
    };
  }, [flushGraceBuffer]);

  const setWorkspaceHandlers = useCallback((handlers: Record<string, WorkspaceEventHandler>) => {
    workspaceHandlersRef.current = handlers;
  }, []);

  const registerTerminalResponderHandoffView = useCallback((
    sessionId: string,
    handlers: TerminalResponderHandoffViewHandlers,
  ): (() => void) => {
    terminalResponderHandoffViewsRef.current.set(sessionId, handlers);
    return () => {
      if (terminalResponderHandoffViewsRef.current.get(sessionId) === handlers) {
        terminalResponderHandoffViewsRef.current.delete(sessionId);
      }
    };
  }, []);

  const registerTerminalResponderHandoffRuntime = useCallback((
    identity: TerminalCompatibilityDrainIdentity,
    runtime: TerminalResponderHandoffRuntime,
  ): (() => void) => terminalResponderHandoffState.dispatcher.register(identity, runtime), [
    terminalResponderHandoffState,
  ]);

  const registerTerminalCheckpointDispatcher = useCallback((
    sessionId: string,
    dispatcher: TerminalCheckpointRuntime,
  ): (() => void) => {
    terminalCheckpointRegistrationReleaseScheduler.cancel(sessionId);
    const unregisterLocal = terminalCheckpointDispatchersRef.current.register(sessionId, dispatcher);
    const registrationCapability = terminalCheckpointDispatchersRef.current
      .takeAppliedRegistrationCapability(sessionId);
    if (registrationCapability) {
      retainedMutationLeasesRef.current = reconcileTerminalCheckpointMutationLeases(
        retainedMutationLeasesRef.current,
        registrationCapability,
        registrationCapability,
      );
      publishAppliedTerminalCheckpointCapability(registrationCapability);
    }
    requestCurrentTerminalCheckpointCapability();
    return () => {
      let released = false;
      const remainingViews = releaseTerminalCheckpointDispatcherRegistration({
        sessionId,
        leases: retainedMutationLeasesRef.current,
        unregister: () => {
          released = unregisterLocal();
          return released;
        },
        listViews: terminalCheckpointDispatchersRef.current.listViews,
      });
      if (!released) return;
      terminalCheckpointRegistrationReleaseScheduler.schedule(sessionId, () => {
        terminalCheckpointDispatchersRef.current.releaseCapability(sessionId);
        const socket = wsRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          requestTerminalCheckpointCapability(
            socket,
            listNegotiatedTerminalCheckpointViews(),
          );
        }
      });
      void remainingViews;
    };
  }, [
    listNegotiatedTerminalCheckpointViews,
    publishAppliedTerminalCheckpointCapability,
    requestCurrentTerminalCheckpointCapability,
    terminalCheckpointRegistrationReleaseScheduler,
  ]);

  const requestReconnect = useCallback((reason: string): boolean => {
    const socket = wsRef.current;
    if (!socket) {
      if (!reconnectTimerRef.current) {
        attemptReconnectRef.current();
      }
      return true;
    }
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      return true;
    }
    try {
      setStatus('reconnecting');
      socket.close(4001, reason.slice(0, 123));
      return true;
    } catch {
      return false;
    }
  }, []);

  const stateValue = useMemo<WebSocketStateValue>(() => ({
    status,
    clientId,
  }), [status, clientId]);

  const actionsValue = useMemo<WebSocketActionsValue>(() => ({
    send,
    subscribeSession,
    setWorkspaceHandlers,
    requestReconnect,
    publishTerminalDeliveryVisibility,
    registerTerminalCheckpointDispatcher,
    refreshTerminalCheckpointRegistration: requestCurrentTerminalCheckpointCapability,
    registerTerminalResponderHandoffView,
    registerTerminalResponderHandoffRuntime,
    getTerminalControlSocketReceipt,
    sendTerminalAuthorityControl,
  }), [
    getTerminalControlSocketReceipt,
    publishTerminalDeliveryVisibility,
    registerTerminalCheckpointDispatcher,
    registerTerminalResponderHandoffRuntime,
    registerTerminalResponderHandoffView,
    requestCurrentTerminalCheckpointCapability,
    requestReconnect,
    send,
    sendTerminalAuthorityControl,
    subscribeSession,
    setWorkspaceHandlers,
  ]);

  return (
    <WebSocketStateContext.Provider value={stateValue}>
      <WebSocketActionsContext.Provider value={actionsValue}>
        {children}
      </WebSocketActionsContext.Provider>
    </WebSocketStateContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useWebSocket(): WebSocketContextValue {
  return {
    ...useWebSocketState(),
    ...useWebSocketActions(),
  };
}

export function useWebSocketState(): WebSocketStateValue {
  const ctx = useContext(WebSocketStateContext);
  if (!ctx) throw new Error('useWebSocketState must be used within WebSocketProvider');
  return ctx;
}

export function useWebSocketActions(): WebSocketActionsValue {
  const ctx = useContext(WebSocketActionsContext);
  if (!ctx) throw new Error('useWebSocketActions must be used within WebSocketProvider');
  return ctx;
}
