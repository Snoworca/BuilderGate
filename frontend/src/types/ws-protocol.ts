/**
 * WebSocket Message Protocol Types
 * Shared type definitions for client-server WS communication.
 * Server has a copy at server/src/types/ws-protocol.ts
 */

// ============================================================================
// Client → Server Messages
// ============================================================================

export type InputReliabilityMode = 'observe' | 'queue' | 'strict';

export type TerminalInputBarrierReason =
  | 'none'
  | 'restore-pending'
  | 'replay-pending'
  | 'initial-geometry-pending'
  | 'repair-server-not-ready'
  | 'ws-reconnecting-short';

export type TerminalInputClosedReason =
  | 'none'
  | 'terminal-hidden'
  | 'terminal-disposed'
  | 'session-exited'
  | 'session-missing'
  | 'server-error'
  | 'auth-expired'
  | 'workspace-or-session-changed'
  | 'ws-closed-without-reconnect';

export type ReconnectState = 'connected' | 'reconnecting' | 'disconnected';

export interface TerminalInputTransportState {
  serverReady: boolean;
  barrierReason: TerminalInputBarrierReason;
  closedReason: TerminalInputClosedReason;
  reconnectState?: ReconnectState;
  sessionGeneration: number;
}

export type TerminalInputTransportOverride = Partial<TerminalInputTransportState>;

export interface InputDebugMetadata {
  captureSeq?: number;
  compositionSeq?: number;
  clientObservedByteLength?: number;
  clientObservedCodePointCount?: number;
  clientObservedGraphemeCount?: number;
  clientObservedGraphemeApproximate?: boolean;
  clientObservedHasHangul?: boolean;
  clientObservedHasCjk?: boolean;
  clientObservedHasEnter?: boolean;
}

export type InputRejectedReason =
  | 'timeout'
  | 'timeout-enter-safety'
  | 'queue-overflow'
  | 'context-changed'
  | 'session-missing'
  | 'session-closed'
  | 'server-error'
  | 'auth-expired'
  | 'transport-closed'
  | 'invalid-sequence'
  | 'invalid-payload'
  | 'mode-observe-only';

export type ClientWsMessage =
  | { type: 'subscribe';   sessionIds: string[] }
  | { type: 'unsubscribe'; sessionIds: string[] }
  | { type: 'screen-snapshot:ready'; sessionId: string; replayToken: string }
  | ScreenRepairRequestMessage
  | ScreenRepairReadyMessage
  | ScreenRepairFailedMessage
  | {
      type: 'input';
      sessionId: string;
      data: string;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      metadata?: InputDebugMetadata;
    }
  | { type: 'repair-replay'; sessionId: string }
  | { type: 'resize';      sessionId: string; cols: number; rows: number }
  | { type: 'ping' };

// ============================================================================
// Server → Client Messages
// ============================================================================

export type ScreenSnapshotMode = 'authoritative' | 'fallback';
export type ScreenSnapshotSource = 'headless';
export type WindowsPtyBackend = 'conpty' | 'winpty';
export type ScreenRepairReason = 'manual' | 'workspace' | 'resize';
export type ScreenRepairBufferType = 'normal' | 'alternate';
export type ScreenRepairFailedReason =
  | 'not-ready'
  | 'ime-active'
  | 'input-active'
  | 'user-scrolled'
  | 'geometry-mismatch'
  | 'buffer-mismatch'
  | 'write-failed';
export type ScreenRepairRejectedReason =
  | 'not-subscribed'
  | 'pending'
  | 'geometry-mismatch'
  | 'buffer-mismatch'
  | 'headless-degraded'
  | 'generation-failed'
  | 'apply-rejected';

export interface WindowsPtyInfo {
  backend: WindowsPtyBackend;
  buildNumber?: number;
}

export interface ScreenSnapshotMessage {
  type: 'screen-snapshot';
  sessionId: string;
  replayToken: string;
  seq: number;
  cols: number;
  rows: number;
  mode: ScreenSnapshotMode;
  data: string;
  truncated: boolean;
  source: ScreenSnapshotSource;
  windowsPty?: WindowsPtyInfo;
}

export interface ScreenRepairRequestMessage {
  type: 'screen-repair';
  sessionId: string;
  cols: number;
  rows: number;
  reason: ScreenRepairReason;
  clientAtBottom: boolean;
  clientBufferType: ScreenRepairBufferType;
}

export interface ScreenRepairReadyMessage {
  type: 'screen-repair:ready';
  sessionId: string;
  repairToken: string;
}

export interface ScreenRepairFailedMessage {
  type: 'screen-repair:failed';
  sessionId: string;
  repairToken: string;
  reason: ScreenRepairFailedReason;
}

export interface ScreenRepairRowPatch {
  y: number;
  ansi: string;
  text: string;
  wrapped: boolean;
}

export interface ScreenRepairMessage {
  type: 'screen-repair';
  sessionId: string;
  repairToken: string;
  seq: number;
  cols: number;
  rows: number;
  bufferType: ScreenRepairBufferType;
  cursor: { x: number; y: number; hidden?: boolean };
  viewportRows: ScreenRepairRowPatch[];
  ansiPatch: string;
  source: 'headless';
}

export interface ScreenRepairRejectedMessage {
  type: 'screen-repair:rejected';
  sessionId: string;
  repairToken?: string;
  reason: ScreenRepairRejectedReason;
  cols?: number;
  rows?: number;
}

export type ServerWsMessage =
  // Session events
  | ScreenSnapshotMessage
  | ScreenRepairMessage
  | ScreenRepairRejectedMessage
  | { type: 'output';         sessionId: string; data: string }
  | { type: 'status';         sessionId: string; status: 'running' | 'idle' }
  | { type: 'session:ready';  sessionId: string }
  | {
      type: 'input:rejected';
      sessionId: string;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      reason: InputRejectedReason;
    }
  | { type: 'cwd';            sessionId: string; cwd: string }
  | { type: 'session:error';  sessionId: string; message: string }
  | { type: 'session:exited'; sessionId: string; exitCode: number }
  // Subscribe response
  | { type: 'subscribed';     sessions: SubscribedSessionInfo[] }
  // Workspace events
  | { type: 'workspace:created';   data: unknown }
  | { type: 'workspace:updated';   data: unknown }
  | { type: 'workspace:deleted';   data: unknown }
  | { type: 'workspace:deleting';  data: unknown }
  | { type: 'workspace:reordered'; data: unknown }
  // Tab events
  | { type: 'tab:added';        data: unknown }
  | { type: 'tab:updated';      data: unknown }
  | { type: 'tab:removed';      data: unknown }
  | { type: 'tab:reordered';    data: unknown }
  | { type: 'tab:disconnected'; data: unknown }
  // Grid events
  | { type: 'grid:updated'; data: unknown }
  // Connection events
  | { type: 'connected'; clientId: string }
  | { type: 'pong' };

export interface SubscribedSessionInfo {
  sessionId: string;
  status: string;
  cwd?: string;
  ready: boolean;
}

export type ReplayTelemetryValue = string | number | boolean | null;

export type ReplayEventKind =
  | 'resize_requested'
  | 'resize_skipped'
  | 'snapshot_sent'
  | 'snapshot_refreshed'
  | 'ack_ok'
  | 'ack_stale'
  | 'input_blocked'
  | 'replay_input_would_queue'
  | 'replay_input_would_reject'
  | 'input_queued'
  | 'input_queue_overflow'
  | 'input_rejected'
  | 'input_flushed'
  | 'input_flushed_timeout'
  | 'output_queued'
  | 'output_flushed'
  | 'ready_sent'
  | 'screen_repair_requested'
  | 'screen_repair_sent'
  | 'screen_repair_rejected'
  | 'screen_repair_ack_ok'
  | 'screen_repair_ack_stale'
  | 'screen_repair_failed'
  | 'screen_repair_ack_timeout'
  | 'screen_repair_output_queued'
  | 'screen_repair_output_flushed'
  | 'screen_repair_queue_overflow';

export interface ReplayTelemetryEventInput {
  kind: ReplayEventKind;
  sessionId: string;
  replayToken?: string;
  repairToken?: string;
  snapshotSeq?: number;
  details?: Record<string, ReplayTelemetryValue>;
}

export interface ReplayTelemetryEvent extends ReplayTelemetryEventInput {
  eventId: number;
  recordedAt: string;
}

export interface WsRouterObservabilitySnapshot {
  connectedClients: number;
  subscribedSessionCount: number;
  replayPendingCount: number;
  screenRepairPendingCount: number;
  replayAckTimeoutCount: number;
  screenRepairAckTimeoutCount: number;
  replayRefreshCount: number;
  maxReplayQueueLengthObserved: number;
  recentReplayEvents: ReplayTelemetryEvent[];
}
