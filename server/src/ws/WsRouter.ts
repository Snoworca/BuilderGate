/**
 * WebSocket Router
 * Step 8: SSE+HTTP -> WebSocket single channel migration
 *
 * Manages WebSocket connections, JWT authentication on upgrade,
 * message routing, ping/pong heartbeat, and session subscriptions.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type {
  RealtimeConfig,
  ResourceLimitsConfig,
  ServerWsResourceLimitsConfig,
  StabilityModesConfig,
} from '../types/config.types.js';
import {
  stabilityModesSchema,
  wsResourceLimitsSchema,
} from '../schemas/config.schema.js';
import type {
  ClientWsMessage,
  InputDebugMetadata,
  InputRejectedReason,
  InputReliabilityMode,
  QueuedReplayInput,
  ReplayPendingState,
  ReplayTelemetryEvent,
  ReplayTelemetryEventInput,
  ScreenRepairBufferType,
  ScreenRepairFailedReason,
  ScreenRepairPendingState,
  ScreenRepairReason,
  ScreenRepairRejectedReason,
  ScreenRepairRequestMessage,
  WsClientMeta,
  WsRouterObservabilitySnapshot,
} from '../types/ws-protocol.js';
import { buildInputDebugDetails, sanitizeClientInputDebugMetadata } from '../utils/inputDebugMetadata.js';
import { inputReliabilityMode as configuredInputReliabilityMode } from '../utils/inputReliabilityMode.js';
import {
  createWsTransportMessage,
  createWsTransportQueueState,
  tryCoalesceOutputMessage,
  type WsTransportMessage,
  type WsTransportQueueState,
} from './wsSendPolicy.js';

const HEARTBEAT_INTERVAL = 30_000;
const REPLAY_ACK_TIMEOUT_MS = 5_000;
const SCREEN_REPAIR_ACK_TIMEOUT_MS = 5_000;
const MAX_RECENT_REPLAY_EVENTS = 256;
const MAX_REPLAY_QUEUED_INPUT_BYTES = 64 * 1024;
const MAX_REPLAY_QUEUED_INPUT_AGE_MS = 3_000;
const MAX_INPUT_SEQUENCE_SPAN = 1024;
const TRANSPORT_FLUSH_RETRY_MS = 25;

type PartialResourceLimits = {
  [K in keyof ResourceLimitsConfig]?: Partial<ResourceLimitsConfig[K]>;
};

interface WsRouterOptions {
  inputReliabilityMode?: InputReliabilityMode;
  realtime?: Partial<RealtimeConfig>;
  resourceLimits?: PartialResourceLimits;
  stabilityModes?: Partial<StabilityModesConfig>;
}

interface RuntimeSendPolicyConfig {
  mode: StabilityModesConfig['wsSendMode'];
  limits: ServerWsResourceLimitsConfig;
}

type InputValidationResult =
  | {
      ok: true;
      sessionId: string;
      data: string;
      metadata?: InputDebugMetadata;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      byteLength: number;
    }
  | {
      ok: false;
      reason: 'invalid-payload' | 'invalid-sequence';
      sessionId?: string;
      data?: string;
      inputSeqStart?: number;
      inputSeqEnd?: number;
    };

export class WsRouter {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, WsClientMeta> = new Map();
  private sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionManager: SessionManager;
  private authService: AuthService;
  private replayAckTimeoutCount = 0;
  private screenRepairAckTimeoutCount = 0;
  private replayRefreshCount = 0;
  private maxReplayQueueLengthObserved = 0;
  private replayEventCounter = 0;
  private recentReplayEvents: ReplayTelemetryEvent[] = [];
  private debugReplayEventsBySession: Map<string, ReplayTelemetryEvent[]> = new Map();
  private debugReplayEnabledSessions: Set<string> = new Set();
  private readonly inputReliabilityMode: InputReliabilityMode;
  private readonly runtimeSendPolicyConfig: RuntimeSendPolicyConfig;
  private transportQueues: Map<WebSocket, WsTransportQueueState> = new Map();
  private maxTransportQueuedBytesObserved = 0;
  private maxServerBufferedAmountObserved = 0;
  private transportBackpressureObserveCount = 0;
  private transportSlowClientCloseCount = 0;
  private transportQueueOverflowCount = 0;
  private transportSendErrorCount = 0;
  private transportOutputCoalesceCount = 0;

  constructor(authService: AuthService, sessionManager: SessionManager, options: WsRouterOptions = {}) {
    this.authService = authService;
    this.sessionManager = sessionManager;
    this.inputReliabilityMode = options.inputReliabilityMode ?? configuredInputReliabilityMode;
    this.runtimeSendPolicyConfig = {
      mode: stabilityModesSchema.parse(options.stabilityModes).wsSendMode,
      limits: cloneServerWsResourceLimits(wsResourceLimitsSchema.parse(options.resourceLimits?.ws)),
    };
    this.wss = new WebSocketServer({ noServer: true });

    this.setupConnectionHandler();
    this.startHeartbeat();

    console.log('[WS] WebSocket router initialized');
  }

  updateRuntimeConfig(next: {
    resourceLimits?: PartialResourceLimits;
    stabilityModes?: Partial<StabilityModesConfig>;
  }): void {
    const previousMode = this.runtimeSendPolicyConfig.mode;
    if (next.resourceLimits?.ws) {
      this.runtimeSendPolicyConfig.limits = cloneServerWsResourceLimits(wsResourceLimitsSchema.parse({
        ...this.runtimeSendPolicyConfig.limits,
        ...next.resourceLimits.ws,
      }));
    }
    if (next.stabilityModes?.wsSendMode) {
      this.runtimeSendPolicyConfig.mode = stabilityModesSchema.parse({
        wsSendMode: next.stabilityModes.wsSendMode,
      }).wsSendMode;
    }
    if (previousMode === 'safe-send-enforce' && this.runtimeSendPolicyConfig.mode !== 'safe-send-enforce') {
      this.flushAndClearTransportQueuesForPolicyRollback();
    }
  }

  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const result = this.authService.verifyToken(token);
    if (!result.valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req, result.payload);
    });
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      const clientId = uuidv4();
      const meta: WsClientMeta = {
        clientId,
        isAlive: true,
        subscribedSessions: new Set(),
        replayPendingSessions: new Map(),
        screenRepairPendingSessions: new Map(),
      };
      this.clients.set(ws, meta);

      this.sendTo(ws, { type: 'connected', clientId });
      console.log(`[WS] Client connected: ${clientId}`);

      ws.on('pong', () => {
        const current = this.clients.get(ws);
        if (current) current.isAlive = true;
      });

      ws.on('message', (raw: Buffer | string) => {
        try {
          this.handleMessage(ws, raw);
        } catch (error) {
          this.handleMessageError(ws, raw, error);
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Client error (${clientId}):`, err.message);
      });
    });
  }

  private handleMessage(ws: WebSocket, raw: Buffer | string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      console.warn('[WS] Invalid JSON received');
      return;
    }

    if (!isRecord(msg) || typeof msg.type !== 'string') {
      console.warn('[WS] Invalid message shape received');
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(ws, (msg as Extract<ClientWsMessage, { type: 'subscribe' }>).sessionIds);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(ws, (msg as Extract<ClientWsMessage, { type: 'unsubscribe' }>).sessionIds);
        break;
      case 'screen-snapshot:ready':
        this.handleScreenSnapshotReady(
          ws,
          (msg as Extract<ClientWsMessage, { type: 'screen-snapshot:ready' }>).sessionId,
          (msg as Extract<ClientWsMessage, { type: 'screen-snapshot:ready' }>).replayToken,
        );
        break;
      case 'screen-repair':
        void this.handleScreenRepairRequest(ws, msg).catch((error) => {
          console.error('[WS] Screen repair request failed:', error);
        });
        break;
      case 'screen-repair:ready':
        {
          const repairReady = msg as unknown as Extract<ClientWsMessage, { type: 'screen-repair:ready' }>;
        this.handleScreenRepairReady(
          ws,
          repairReady.sessionId,
          repairReady.repairToken,
        );
        }
        break;
      case 'screen-repair:failed':
        {
          const repairFailed = msg as unknown as Extract<ClientWsMessage, { type: 'screen-repair:failed' }>;
        this.handleScreenRepairFailed(
          ws,
          repairFailed.sessionId,
          repairFailed.repairToken,
          repairFailed.reason,
        );
        }
        break;
      case 'input':
        this.handleInput(ws, msg);
        break;
      case 'repair-replay':
        this.handleRepairReplay(ws, (msg as Extract<ClientWsMessage, { type: 'repair-replay' }>).sessionId);
        break;
      case 'resize':
        this.handleResize(
          ws,
          (msg as Extract<ClientWsMessage, { type: 'resize' }>).sessionId,
          (msg as Extract<ClientWsMessage, { type: 'resize' }>).cols,
          (msg as Extract<ClientWsMessage, { type: 'resize' }>).rows,
        );
        break;
      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        break;
      default:
        console.warn(`[WS] Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  private handleMessageError(ws: WebSocket, raw: Buffer | string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[WS] Message handler failed:', message);

    const parsed = this.tryParseRawMessage(raw);
    const sessionId = isRecord(parsed) && typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? parsed.sessionId
      : null;
    if (sessionId) {
      this.sendTo(ws, {
        type: 'session:error',
        sessionId,
        message: 'WebSocket message handling failed',
      });
    }
  }

  private tryParseRawMessage(raw: Buffer | string): unknown {
    try {
      return JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return null;
    }
  }

  private handleSubscribe(ws: WebSocket, sessionIds: string[]): void {
    const results: Array<{ sessionId: string; status: string; cwd?: string; ready: boolean }> = [];
    const meta = this.clients.get(ws);
    if (!meta) return;

    for (const sessionId of sessionIds) {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        results.push({ sessionId, status: 'error', ready: false });
        continue;
      }

      if (!this.sessionSubscribers.has(sessionId)) {
        this.sessionSubscribers.set(sessionId, new Set());
      }

      const subscribers = this.sessionSubscribers.get(sessionId)!;
      const alreadySubscribed = subscribers.has(ws);
      subscribers.add(ws);
      meta.subscribedSessions.add(sessionId);

      const cwd = this.sessionManager.getLastCwd(sessionId) ?? undefined;
      this.recordReplayEvent({
        kind: 'snapshot_sent',
        sessionId,
        details: {
          phase: 'subscribe-begin',
          clientId: meta.clientId,
          alreadySubscribed,
        },
      });

      if (alreadySubscribed) {
        results.push({
          sessionId,
          status: session.status,
          cwd,
          ready: !meta.replayPendingSessions.has(sessionId) && this.sessionManager.isSessionReady(sessionId),
        });
        continue;
      }

      const snapshot = this.sessionManager.getScreenSnapshot(sessionId);
      if (!snapshot) {
        results.push({
          sessionId,
          status: session.status,
          cwd,
          ready: this.sessionManager.isSessionReady(sessionId),
        });
        continue;
      }

      const replayState = this.sendSnapshotReplay(ws, sessionId, snapshot, 'subscribe');
      results.push({
        sessionId,
        status: session.status,
        cwd,
        ready: false,
      });
      void replayState;
    }

    this.sendTo(ws, { type: 'subscribed', sessions: results });
  }

  private handleUnsubscribe(ws: WebSocket, sessionIds: string[]): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    for (const sessionId of sessionIds) {
      this.clearReplayPendingForPair(ws, sessionId, 'context-changed');
      this.clearScreenRepairPendingForPair(ws, sessionId, 'context-changed');

      const subscribers = this.sessionSubscribers.get(sessionId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          this.sessionSubscribers.delete(sessionId);
        }
      }

      meta.subscribedSessions.delete(sessionId);
    }
  }

  private handleScreenSnapshotReady(ws: WebSocket, sessionId: string, replayToken: string): void {
    const replayResult = this.consumeReplayPendingForPair(ws, sessionId, replayToken);
    if (replayResult.status !== 'ok') {
      this.recordReplayEvent({
        kind: 'ack_stale',
        sessionId,
        replayToken,
        snapshotSeq: replayResult.snapshotSeq,
        details: {
          reason: replayResult.reason,
          activeReplayToken: replayResult.activeReplayToken ?? null,
        },
      });
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.recordReplayEvent({
      kind: 'ack_ok',
      sessionId,
      replayToken,
      snapshotSeq: replayResult.snapshotSeq,
      details: {
        queuedBytes: replayResult.queuedOutput.length,
        queuedInputBytes: replayResult.queuedInputBytes,
        queuedInputCount: replayResult.queuedInputs.length,
      },
    });

    if (replayResult.queuedOutput.length > 0) {
      this.sendTo(ws, { type: 'output', sessionId, data: replayResult.queuedOutput });
      this.recordReplayEvent({
        kind: 'output_flushed',
        sessionId,
        replayToken,
        snapshotSeq: replayResult.snapshotSeq,
        details: {
          outputBytes: replayResult.queuedOutput.length,
        },
      });
    }

    this.flushQueuedReplayInputs(ws, sessionId, replayToken, replayResult.snapshotSeq, replayResult.queuedInputs, 'ack');

    this.sendTo(ws, { type: 'session:ready', sessionId });
    this.recordReplayEvent({
      kind: 'ready_sent',
      sessionId,
      replayToken,
      snapshotSeq: replayResult.snapshotSeq,
      details: {
        reason: 'ack',
      },
    });
  }

  private handleInput(ws: WebSocket, rawMessage: unknown): void {
    const input = this.validateInputMessage(rawMessage);
    if (!input.ok) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: input.reason,
      });
      return;
    }

    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(input.sessionId);
    if (!this.sessionManager.getSession(input.sessionId)) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'session-missing',
      });
      return;
    }

    if (pending) {
      const queuedInput: QueuedReplayInput = {
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        queuedAt: Date.now(),
        byteLength: input.byteLength,
      };

      if (this.inputReliabilityMode === 'observe') {
        this.recordReplayEvent({
          kind: 'replay_input_would_queue',
          sessionId: input.sessionId,
          replayToken: pending.replayToken,
          snapshotSeq: pending.snapshotSeq,
          details: {
            mode: this.inputReliabilityMode,
            reason: 'mode-observe-only',
            ...this.buildQueuedInputReplayDetails(queuedInput),
          },
        });
        return;
      }

      if (!this.appendQueuedInput(ws, input.sessionId, pending, queuedInput)) {
        return;
      }
      this.recordReplayEvent({
        kind: 'input_queued',
        sessionId: input.sessionId,
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
        details: {
          mode: this.inputReliabilityMode,
          queuedInputBytes: pending.queuedInputBytes,
          queuedInputCount: pending.queuedInputs.length,
          ...this.buildQueuedInputReplayDetails(queuedInput),
        },
      });
      return;
    }

    let inputAccepted = false;
    try {
      inputAccepted = this.sessionManager.writeInput(input.sessionId, input.data, input.metadata, {
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
      });
    } catch (error) {
      console.error('[WS] PTY input write failed:', error);
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'server-error',
      });
      return;
    }

    if (!inputAccepted) {
      this.rejectInput(ws, {
        sessionId: input.sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'server-error',
      });
    }
  }

  private handleResize(_ws: WebSocket, sessionId: string, cols: number, rows: number): void {
    this.sessionManager.resize(sessionId, cols, rows);
  }

  private handleRepairReplay(ws: WebSocket, sessionId: string): void {
    const meta = this.clients.get(ws);
    if (!meta || !meta.subscribedSessions.has(sessionId)) {
      return;
    }

    if (meta.replayPendingSessions.has(sessionId)) {
      return;
    }

    const snapshot = this.sessionManager.getScreenSnapshot(sessionId);
    if (!snapshot) {
      return;
    }

    this.sendSnapshotReplay(ws, sessionId, snapshot, 'repair');
  }

  private async handleScreenRepairRequest(ws: WebSocket, message: unknown): Promise<void> {
    const request = this.validateScreenRepairRequest(message);
    if (!request.ok) {
      if (request.sessionId) {
        this.sendScreenRepairRejected(ws, request.sessionId, request.reason);
      }
      return;
    }

    const { sessionId, cols, rows, reason, clientBufferType } = request.message;
    const meta = this.clients.get(ws);
    this.recordReplayEvent({
      kind: 'screen_repair_requested',
      sessionId,
      details: {
        reason,
        cols,
        rows,
        clientAtBottom: request.message.clientAtBottom,
        clientBufferType,
      },
    });

    if (!meta || !meta.subscribedSessions.has(sessionId)) {
      this.sendScreenRepairRejected(ws, sessionId, 'not-subscribed', undefined, cols, rows);
      return;
    }
    if (!request.message.clientAtBottom) {
      this.sendScreenRepairRejected(ws, sessionId, 'apply-rejected', undefined, cols, rows);
      return;
    }
    if (meta.replayPendingSessions.has(sessionId) || this.getScreenRepairPendingSessions(meta).has(sessionId)) {
      this.sendScreenRepairRejected(ws, sessionId, 'pending', undefined, cols, rows);
      return;
    }

    const pending = this.markScreenRepairPending(ws, sessionId, 0);
    const repair = await this.sessionManager.getScreenRepair(sessionId, {
      cols,
      rows,
      bufferType: clientBufferType,
    });
    if (!repair.ok) {
      this.clearScreenRepairPendingForPair(ws, sessionId, 'generation-failed');
      this.sendScreenRepairRejected(ws, sessionId, this.mapScreenRepairRejectReason(repair.reason), undefined, cols, rows);
      return;
    }
    const activePending = this.getScreenRepairPendingSessions(meta).get(sessionId);
    if (
      ws.readyState !== WebSocket.OPEN
      || !meta.subscribedSessions.has(sessionId)
      || meta.replayPendingSessions.has(sessionId)
      || activePending !== pending
    ) {
      if (activePending === pending) {
        this.clearScreenRepairPendingForPair(ws, sessionId, 'context-changed');
      }
      this.sendScreenRepairRejected(ws, sessionId, 'pending', undefined, cols, rows);
      return;
    }

    this.armScreenRepairAckTimeout(ws, sessionId, pending, repair.payload.seq);
    this.sendTo(ws, {
      type: 'screen-repair',
      sessionId,
      repairToken: pending.repairToken,
      seq: repair.payload.seq,
      cols: repair.payload.cols,
      rows: repair.payload.rows,
      bufferType: repair.payload.bufferType,
      cursor: repair.payload.cursor,
      viewportRows: repair.payload.viewportRows,
      ansiPatch: repair.payload.ansiPatch,
      source: 'headless',
    });
    this.recordReplayEvent({
      kind: 'screen_repair_sent',
      sessionId,
      repairToken: pending.repairToken,
      snapshotSeq: repair.payload.seq,
      details: {
        reason,
        cols: repair.payload.cols,
        rows: repair.payload.rows,
        bufferType: repair.payload.bufferType,
        rowCount: repair.payload.viewportRows.length,
        byteLength: repair.payload.ansiPatch.length,
      },
    });
  }

  private handleScreenRepairReady(ws: WebSocket, sessionId: string, repairToken: string): void {
    const result = this.consumeScreenRepairPendingForPair(ws, sessionId, repairToken);
    if (result.status !== 'ok') {
      this.recordReplayEvent({
        kind: 'screen_repair_ack_stale',
        sessionId,
        repairToken,
        snapshotSeq: result.screenSeq,
        details: {
          reason: result.reason,
          activeRepairToken: result.activeRepairToken ?? null,
        },
      });
      return;
    }

    this.recordReplayEvent({
      kind: 'screen_repair_ack_ok',
      sessionId,
      repairToken,
      snapshotSeq: result.screenSeq,
      details: {
        queuedBytes: result.ackQueuedOutputBytes,
        totalQueuedBytes: result.queuedOutputBytes,
      },
    });
    this.flushScreenRepairQueuedOutput(ws, sessionId, repairToken, result.screenSeq, result.ackQueuedOutput, 'ack');
    if (ws.readyState === WebSocket.OPEN) {
      this.sendTo(ws, { type: 'session:ready', sessionId });
    }
  }

  private handleScreenRepairFailed(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    reason: ScreenRepairFailedReason,
  ): void {
    const result = this.consumeScreenRepairPendingForPair(ws, sessionId, repairToken);
    if (result.status !== 'ok') {
      this.recordReplayEvent({
        kind: 'screen_repair_ack_stale',
        sessionId,
        repairToken,
        snapshotSeq: result.screenSeq,
        details: {
          reason: result.reason,
          clientFailureReason: reason,
          activeRepairToken: result.activeRepairToken ?? null,
        },
      });
      return;
    }

    this.recordReplayEvent({
      kind: 'screen_repair_failed',
      sessionId,
      repairToken,
      snapshotSeq: result.screenSeq,
      details: {
        reason,
        queuedBytes: result.queuedOutputBytes,
      },
    });
    this.flushScreenRepairQueuedOutput(ws, sessionId, repairToken, result.screenSeq, result.queuedOutput, 'failed');
    if (ws.readyState === WebSocket.OPEN) {
      this.sendTo(ws, { type: 'session:ready', sessionId });
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    if (meta) {
      console.log(`[WS] Client disconnected: ${meta.clientId}`);
      for (const sessionId of meta.subscribedSessions) {
        this.clearReplayPendingForPair(ws, sessionId, 'transport-closed');
        this.clearScreenRepairPendingForPair(ws, sessionId, 'transport-closed');
        const subscribers = this.sessionSubscribers.get(sessionId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            this.sessionSubscribers.delete(sessionId);
          }
        }
      }
    }

    this.clearTransportQueueState(ws);
    this.clients.delete(ws);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, meta] of this.clients) {
        if (!meta.isAlive) {
          console.log(`[WS] Client ${meta.clientId} failed heartbeat, terminating`);
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);

    this.heartbeatTimer.unref();
  }

  private markReplayPending(ws: WebSocket, sessionId: string, snapshotSeq: number): ReplayPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }

    this.clearReplayPendingForPair(ws, sessionId, 'context-changed');

    const state: ReplayPendingState = {
      queuedOutput: '',
      queuedInputs: [],
      queuedInputBytes: 0,
      replayToken: uuidv4(),
      snapshotSeq,
      timer: setTimeout(() => {
        this.handleReplayAckTimeout(ws, sessionId, state.replayToken, snapshotSeq, 'timeout');
      }, REPLAY_ACK_TIMEOUT_MS),
    };
    state.timer.unref();
    meta.replayPendingSessions.set(sessionId, state);
    return state;
  }

  private consumeReplayPendingForPair(
    ws: WebSocket,
    sessionId: string,
    replayToken: string,
  ):
    | {
        status: 'ok';
        queuedOutput: string;
        queuedInputs: QueuedReplayInput[];
        queuedInputBytes: number;
        snapshotSeq: number;
      }
    | { status: 'stale'; reason: 'missing' | 'token-mismatch'; snapshotSeq?: number; activeReplayToken?: string } {
    const meta = this.clients.get(ws);
    if (!meta) {
      return { status: 'stale', reason: 'missing' };
    }

    const pending = meta.replayPendingSessions.get(sessionId);
    if (!pending) {
      return { status: 'stale', reason: 'missing' };
    }
    if (pending.replayToken !== replayToken) {
      return {
        status: 'stale',
        reason: 'token-mismatch',
        snapshotSeq: pending.snapshotSeq,
        activeReplayToken: pending.replayToken,
      };
    }

    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    return {
      status: 'ok',
      queuedOutput: pending.queuedOutput,
      queuedInputs: pending.queuedInputs,
      queuedInputBytes: pending.queuedInputBytes,
      snapshotSeq: pending.snapshotSeq,
    };
  }

  private clearReplayPendingForPair(
    ws: WebSocket,
    sessionId: string,
    reason: InputRejectedReason = 'context-changed',
  ): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const pending = meta.replayPendingSessions.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    this.rejectQueuedReplayInputs(ws, sessionId, pending, reason);
  }

  private appendQueuedOutput(state: ReplayPendingState, data: string): void {
    const limit = this.sessionManager.getReplayQueueLimit();
    const next = `${state.queuedOutput}${data}`;
    state.queuedOutput = next.length > limit ? next.slice(-limit) : next;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, state.queuedOutput.length);
  }

  private getScreenRepairPendingSessions(meta: WsClientMeta): Map<string, ScreenRepairPendingState> {
    if (!meta.screenRepairPendingSessions) {
      meta.screenRepairPendingSessions = new Map();
    }
    return meta.screenRepairPendingSessions;
  }

  private markScreenRepairPending(ws: WebSocket, sessionId: string, screenSeq: number): ScreenRepairPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }

    const repairToken = uuidv4();
    const state: ScreenRepairPendingState = {
      queuedOutput: '',
      queuedOutputBytes: 0,
      queuedOutputChunks: [],
      repairToken,
      screenSeq,
    };
    this.getScreenRepairPendingSessions(meta).set(sessionId, state);
    return state;
  }

  private armScreenRepairAckTimeout(
    ws: WebSocket,
    sessionId: string,
    state: ScreenRepairPendingState,
    screenSeq: number,
  ): void {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.screenSeq = screenSeq;
    state.timer = setTimeout(() => {
      this.handleScreenRepairAckTimeout(ws, sessionId, state.repairToken, screenSeq);
    }, SCREEN_REPAIR_ACK_TIMEOUT_MS);
    state.timer.unref();
  }

  private consumeScreenRepairPendingForPair(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
  ):
    | {
        status: 'ok';
        queuedOutput: string;
        queuedOutputBytes: number;
        ackQueuedOutput: string;
        ackQueuedOutputBytes: number;
        screenSeq: number;
      }
    | { status: 'stale'; reason: 'missing' | 'token-mismatch'; screenSeq?: number; activeRepairToken?: string } {
    const meta = this.clients.get(ws);
    if (!meta) {
      return { status: 'stale', reason: 'missing' };
    }

    const pendingSessions = this.getScreenRepairPendingSessions(meta);
    const pending = pendingSessions.get(sessionId);
    if (!pending) {
      return { status: 'stale', reason: 'missing' };
    }
    if (pending.repairToken !== repairToken) {
      return {
        status: 'stale',
        reason: 'token-mismatch',
        screenSeq: pending.screenSeq,
        activeRepairToken: pending.repairToken,
      };
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pendingSessions.delete(sessionId);
    const ackQueued = this.getScreenRepairAckQueuedOutput(pending);
    return {
      status: 'ok',
      queuedOutput: pending.queuedOutput,
      queuedOutputBytes: pending.queuedOutputBytes,
      ackQueuedOutput: ackQueued.data,
      ackQueuedOutputBytes: ackQueued.byteLength,
      screenSeq: pending.screenSeq,
    };
  }

  private getScreenRepairAckQueuedOutput(state: ScreenRepairPendingState): { data: string; byteLength: number } {
    if (state.queuedOutputChunks.length === 0) {
      return {
        data: state.queuedOutput,
        byteLength: Buffer.byteLength(state.queuedOutput, 'utf8'),
      };
    }

    const chunks = state.queuedOutputChunks.filter((chunk) => (
      typeof chunk.screenSeq !== 'number' || chunk.screenSeq > state.screenSeq
    ));
    return {
      data: chunks.map((chunk) => chunk.data).join(''),
      byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    };
  }

  private clearScreenRepairPendingForPair(ws: WebSocket, sessionId: string, _reason: string): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const pendingSessions = this.getScreenRepairPendingSessions(meta);
    const pending = pendingSessions.get(sessionId);
    if (!pending) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pendingSessions.delete(sessionId);
    this.flushScreenRepairQueuedOutput(ws, sessionId, pending.repairToken, pending.screenSeq, pending.queuedOutput, 'clear');
  }

  private appendScreenRepairQueuedOutput(
    ws: WebSocket,
    sessionId: string,
    state: ScreenRepairPendingState,
    data: string,
    outputScreenSeq?: number,
  ): boolean {
    const limit = this.sessionManager.getReplayQueueLimit();
    const outputByteLength = Buffer.byteLength(data, 'utf8');
    const nextByteLength = state.queuedOutputBytes + outputByteLength;
    if (nextByteLength > limit) {
      const queuedOutput = state.queuedOutput;
      const meta = this.clients.get(ws);
      if (meta) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        this.getScreenRepairPendingSessions(meta).delete(sessionId);
      }

      this.recordReplayEvent({
        kind: 'screen_repair_queue_overflow',
        sessionId,
        repairToken: state.repairToken,
        snapshotSeq: state.screenSeq,
        details: {
          queuedBytes: state.queuedOutputBytes,
          outputBytes: outputByteLength,
          maxQueuedBytes: limit,
        },
      });
      this.flushScreenRepairQueuedOutput(ws, sessionId, state.repairToken, state.screenSeq, `${queuedOutput}${data}`, 'overflow');
      return false;
    }

    state.queuedOutputChunks.push({ data, byteLength: outputByteLength, screenSeq: outputScreenSeq });
    state.queuedOutput = `${state.queuedOutput}${data}`;
    state.queuedOutputBytes = nextByteLength;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, state.queuedOutputBytes);
    return true;
  }

  private handleScreenRepairAckTimeout(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    screenSeq: number,
  ): void {
    const meta = this.clients.get(ws);
    const pending = meta ? this.getScreenRepairPendingSessions(meta).get(sessionId) : undefined;
    if (!meta || !pending || pending.repairToken !== repairToken) {
      return;
    }

    this.screenRepairAckTimeoutCount += 1;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.getScreenRepairPendingSessions(meta).delete(sessionId);
    this.recordReplayEvent({
      kind: 'screen_repair_ack_timeout',
      sessionId,
      repairToken,
      snapshotSeq: screenSeq,
      details: {
        queuedBytes: pending.queuedOutputBytes,
      },
    });
    this.flushScreenRepairQueuedOutput(ws, sessionId, repairToken, screenSeq, pending.queuedOutput, 'timeout');
    if (ws.readyState === WebSocket.OPEN) {
      this.sendTo(ws, { type: 'session:ready', sessionId });
    }
  }

  private flushScreenRepairQueuedOutput(
    ws: WebSocket,
    sessionId: string,
    repairToken: string,
    screenSeq: number,
    queuedOutput: string,
    phase: 'ack' | 'failed' | 'timeout' | 'overflow' | 'clear',
  ): void {
    if (queuedOutput.length === 0 || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.sendTo(ws, { type: 'output', sessionId, data: queuedOutput });
    this.recordReplayEvent({
      kind: 'screen_repair_output_flushed',
      sessionId,
      repairToken,
      snapshotSeq: screenSeq,
      details: {
        phase,
        outputBytes: Buffer.byteLength(queuedOutput, 'utf8'),
      },
    });
  }

  private sendScreenRepairRejected(
    ws: WebSocket,
    sessionId: string,
    reason: ScreenRepairRejectedReason,
    repairToken?: string,
    cols?: number,
    rows?: number,
  ): void {
    this.sendTo(ws, {
      type: 'screen-repair:rejected',
      sessionId,
      repairToken,
      reason,
      cols,
      rows,
    });
    this.recordReplayEvent({
      kind: 'screen_repair_rejected',
      sessionId,
      repairToken,
      details: {
        reason,
        cols: cols ?? null,
        rows: rows ?? null,
      },
    });
  }

  private mapScreenRepairRejectReason(reason: 'geometry-mismatch' | 'buffer-mismatch' | 'headless-degraded' | 'generation-failed'): ScreenRepairRejectedReason {
    return reason;
  }

  private validateScreenRepairRequest(message: unknown):
    | { ok: true; message: ScreenRepairRequestMessage }
    | { ok: false; sessionId?: string; reason: ScreenRepairRejectedReason } {
    if (!isRecord(message)) {
      return { ok: false, reason: 'generation-failed' };
    }

    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const cols = message.cols;
    const rows = message.rows;
    const reason = message.reason;
    const clientAtBottom = message.clientAtBottom;
    const clientBufferType = message.clientBufferType;

    if (
      !sessionId
      || typeof cols !== 'number'
      || typeof rows !== 'number'
      || !Number.isSafeInteger(cols)
      || !Number.isSafeInteger(rows)
      || cols <= 0
      || rows <= 0
    ) {
      return { ok: false, sessionId, reason: 'geometry-mismatch' };
    }
    if (!isScreenRepairReason(reason)) {
      return { ok: false, sessionId, reason: 'generation-failed' };
    }
    if (typeof clientAtBottom !== 'boolean') {
      return { ok: false, sessionId, reason: 'apply-rejected' };
    }
    if (!isScreenRepairBufferType(clientBufferType)) {
      return { ok: false, sessionId, reason: 'buffer-mismatch' };
    }

    return {
      ok: true,
      message: {
        type: 'screen-repair',
        sessionId,
        cols,
        rows,
        reason,
        clientAtBottom,
        clientBufferType,
      },
    };
  }

  private appendQueuedInput(
    ws: WebSocket,
    sessionId: string,
    state: ReplayPendingState,
    input: QueuedReplayInput,
  ): boolean {
    if (state.queuedInputBytes + input.byteLength > MAX_REPLAY_QUEUED_INPUT_BYTES) {
      this.recordReplayEvent({
        kind: this.inputReliabilityMode === 'observe' ? 'replay_input_would_reject' : 'input_queue_overflow',
        sessionId,
        replayToken: state.replayToken,
        snapshotSeq: state.snapshotSeq,
        details: {
          mode: this.inputReliabilityMode,
          reason: 'queue-overflow',
          queuedInputBytes: state.queuedInputBytes,
          queuedInputCount: state.queuedInputs.length,
          maxQueuedInputBytes: MAX_REPLAY_QUEUED_INPUT_BYTES,
          ...this.buildQueuedInputReplayDetails(input),
        },
      });
      this.rejectInput(ws, {
        sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: 'queue-overflow',
        replayToken: state.replayToken,
        snapshotSeq: state.snapshotSeq,
      });
      return false;
    }

    state.queuedInputs.push(input);
    state.queuedInputBytes += input.byteLength;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, state.queuedInputBytes);
    return true;
  }

  private handleReplayAckTimeout(
    ws: WebSocket,
    sessionId: string,
    replayToken: string,
    snapshotSeq: number,
    readyReason: 'timeout' | 'refresh-timeout',
  ): void {
    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(sessionId);
    if (!meta || !pending || pending.replayToken !== replayToken) {
      return;
    }

    this.replayAckTimeoutCount += 1;
    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);

    this.flushQueuedReplayInputs(ws, sessionId, replayToken, snapshotSeq, pending.queuedInputs, 'timeout');

    if (ws.readyState === WebSocket.OPEN) {
      this.sendTo(ws, { type: 'session:ready', sessionId });
      this.recordReplayEvent({
        kind: 'ready_sent',
        sessionId,
        replayToken,
        snapshotSeq,
        details: {
          reason: readyReason,
        },
      });
    }
  }

  private flushQueuedReplayInputs(
    ws: WebSocket,
    sessionId: string,
    replayToken: string,
    snapshotSeq: number,
    inputs: QueuedReplayInput[],
    phase: 'ack' | 'timeout',
  ): void {
    for (const input of inputs) {
      const ageMs = Date.now() - input.queuedAt;
      const hasEnter = input.data.includes('\r') || input.data.includes('\n');

      if (phase === 'timeout' && hasEnter) {
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: 'timeout-enter-safety',
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      if (ageMs > MAX_REPLAY_QUEUED_INPUT_AGE_MS) {
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: 'timeout',
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      let inputAccepted = false;
      try {
        inputAccepted = this.sessionManager.writeInput(sessionId, input.data, input.metadata, {
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
        });
      } catch (error) {
        console.error('[WS] Queued PTY input write failed:', error);
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: 'server-error',
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      if (!inputAccepted) {
        this.rejectInput(ws, {
          sessionId,
          data: input.data,
          metadata: input.metadata,
          inputSeqStart: input.inputSeqStart,
          inputSeqEnd: input.inputSeqEnd,
          reason: 'session-missing',
          replayToken,
          snapshotSeq,
        });
        continue;
      }

      this.recordReplayEvent({
        kind: phase === 'timeout' ? 'input_flushed_timeout' : 'input_flushed',
        sessionId,
        replayToken,
        snapshotSeq,
        details: {
          phase,
          ageMs,
          ...this.buildQueuedInputReplayDetails(input),
        },
      });
    }
  }

  private rejectQueuedReplayInputs(
    ws: WebSocket,
    sessionId: string,
    pending: ReplayPendingState,
    reason: InputRejectedReason,
  ): void {
    for (const input of pending.queuedInputs) {
      this.rejectInput(ws, {
        sessionId,
        data: input.data,
        metadata: input.metadata,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason,
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
      });
    }
  }

  private rejectInput(
    ws: WebSocket,
    input: {
      sessionId?: string;
      data?: string;
      metadata?: InputDebugMetadata;
      inputSeqStart?: number;
      inputSeqEnd?: number;
      reason: InputRejectedReason;
      replayToken?: string;
      snapshotSeq?: number;
    },
  ): void {
    const sessionId = input.sessionId;
    const canRouteReject = typeof sessionId === 'string' && sessionId.length > 0;
    const rejectSent = canRouteReject && ws.readyState === WebSocket.OPEN;
    if (rejectSent) {
      this.sendTo(ws, {
        type: 'input:rejected',
        sessionId,
        inputSeqStart: input.inputSeqStart,
        inputSeqEnd: input.inputSeqEnd,
        reason: input.reason,
      });
    }

    this.recordReplayEvent({
      kind: 'input_rejected',
      sessionId: canRouteReject ? sessionId : 'unknown',
      replayToken: input.replayToken,
      snapshotSeq: input.snapshotSeq,
      details: {
        reason: input.reason,
        rejectSent,
        ...(typeof input.inputSeqStart === 'number' ? { inputSeqStart: input.inputSeqStart } : {}),
        ...(typeof input.inputSeqEnd === 'number' ? { inputSeqEnd: input.inputSeqEnd } : {}),
        ...(typeof input.data === 'string' ? buildInputDebugDetails(input.data, input.metadata) : {}),
      },
    });
  }

  private buildQueuedInputReplayDetails(input: QueuedReplayInput): Record<string, string | number | boolean | null> {
    return {
      ...buildInputDebugDetails(input.data, input.metadata),
      inputSeqStart: input.inputSeqStart ?? null,
      inputSeqEnd: input.inputSeqEnd ?? null,
      queuedAt: input.queuedAt,
      byteLength: input.byteLength,
    };
  }

  private validateInputMessage(message: unknown): InputValidationResult {
    if (!isRecord(message)) {
      return { ok: false, reason: 'invalid-payload' };
    }

    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const data = typeof message.data === 'string' ? message.data : undefined;
    const inputSeqStart = typeof message.inputSeqStart === 'number' && Number.isSafeInteger(message.inputSeqStart)
      ? message.inputSeqStart
      : undefined;
    const inputSeqEnd = typeof message.inputSeqEnd === 'number' && Number.isSafeInteger(message.inputSeqEnd)
      ? message.inputSeqEnd
      : undefined;

    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof data !== 'string') {
      return {
        ok: false,
        reason: 'invalid-payload',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    const byteLength = Buffer.byteLength(data, 'utf8');
    if (byteLength > MAX_REPLAY_QUEUED_INPUT_BYTES) {
      return {
        ok: false,
        reason: 'invalid-payload',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    const hasSeqStart = Object.prototype.hasOwnProperty.call(message, 'inputSeqStart');
    const hasSeqEnd = Object.prototype.hasOwnProperty.call(message, 'inputSeqEnd');
    if (Object.prototype.hasOwnProperty.call(message, 'inputSeq')) {
      return {
        ok: false,
        reason: 'invalid-sequence',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    if (hasSeqStart !== hasSeqEnd) {
      return {
        ok: false,
        reason: 'invalid-sequence',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
      };
    }

    if (hasSeqStart && hasSeqEnd) {
      if (
        typeof message.inputSeqStart !== 'number'
        || typeof message.inputSeqEnd !== 'number'
        || !Number.isSafeInteger(message.inputSeqStart)
        || !Number.isSafeInteger(message.inputSeqEnd)
        || message.inputSeqStart < 1
        || message.inputSeqEnd < message.inputSeqStart
        || message.inputSeqEnd - message.inputSeqStart + 1 > MAX_INPUT_SEQUENCE_SPAN
      ) {
        return {
          ok: false,
          reason: 'invalid-sequence',
          sessionId,
          data,
          inputSeqStart,
          inputSeqEnd,
        };
      }
    }

    const metadataRecord = sanitizeClientInputDebugMetadata(
      isRecord(message.metadata) ? message.metadata as InputDebugMetadata : undefined,
    );
    const metadata = Object.keys(metadataRecord).length > 0
      ? metadataRecord as InputDebugMetadata
      : undefined;

    return {
      ok: true,
      sessionId,
      data,
      metadata,
      inputSeqStart,
      inputSeqEnd,
      byteLength,
    };
  }

  private sendSnapshotReplay(
    ws: WebSocket,
    sessionId: string,
    snapshot: ReturnType<SessionManager['getScreenSnapshot']> extends infer T ? NonNullable<T> : never,
    origin: 'subscribe' | 'repair',
  ): ReplayPendingState {
    const meta = this.clients.get(ws);
    if (!meta) {
      throw new Error('Missing WebSocket client metadata');
    }

    const replayState = this.markReplayPending(ws, sessionId, snapshot.seq);
    const mode = snapshot.health === 'healthy' && !(snapshot.truncated && snapshot.data.length === 0)
      ? 'authoritative'
      : 'fallback';

    this.sendTo(ws, {
      type: 'screen-snapshot',
      sessionId,
      replayToken: replayState.replayToken,
      seq: snapshot.seq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      mode,
      data: snapshot.data,
      truncated: snapshot.truncated,
      source: 'headless',
      windowsPty: snapshot.windowsPty,
    });
    this.recordReplayEvent({
      kind: 'snapshot_sent',
      sessionId,
      replayToken: replayState.replayToken,
      snapshotSeq: snapshot.seq,
      details: {
        origin,
        clientId: meta.clientId,
        cols: snapshot.cols,
        rows: snapshot.rows,
        truncated: snapshot.truncated,
        mode,
      },
    });

    return replayState;
  }

  routeSessionOutput(sessionId: string, data: string, outputScreenSeq?: number): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || data.length === 0) {
      return;
    }

    for (const ws of subscribers) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      const meta = this.clients.get(ws);
      const pending = meta?.replayPendingSessions.get(sessionId);
      if (pending) {
        this.appendQueuedOutput(pending, data);
        this.recordReplayEvent({
          kind: 'output_queued',
          sessionId,
          replayToken: pending.replayToken,
          snapshotSeq: pending.snapshotSeq,
          details: {
            outputBytes: data.length,
            queuedBytes: pending.queuedOutput.length,
          },
        });
        continue;
      }

      const repairPending = meta ? this.getScreenRepairPendingSessions(meta).get(sessionId) : undefined;
      if (repairPending) {
        const queued = this.appendScreenRepairQueuedOutput(ws, sessionId, repairPending, data, outputScreenSeq);
        if (queued) {
          this.recordReplayEvent({
            kind: 'screen_repair_output_queued',
            sessionId,
            repairToken: repairPending.repairToken,
            snapshotSeq: repairPending.screenSeq,
            details: {
              outputBytes: Buffer.byteLength(data, 'utf8'),
              outputScreenSeq: outputScreenSeq ?? null,
              queuedBytes: repairPending.queuedOutputBytes,
            },
          });
        }
        continue;
      }

      this.sendTo(ws, { type: 'output', sessionId, data });
    }
  }

  refreshReplaySnapshots(sessionId: string): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const snapshot = this.sessionManager.getScreenSnapshot(sessionId);
    if (!snapshot) {
      return;
    }

    const mode = snapshot.health === 'healthy' && !(snapshot.truncated && snapshot.data.length === 0)
      ? 'authoritative'
      : 'fallback';

    for (const ws of subscribers) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      const meta = this.clients.get(ws);
      const pending = meta?.replayPendingSessions.get(sessionId);
      if (!pending) {
        continue;
      }
      this.replayRefreshCount += 1;

      const refreshedSnapshotCoversQueuedOutput = mode === 'authoritative' && snapshot.data.length > 0;

      clearTimeout(pending.timer);
      pending.replayToken = uuidv4();
      pending.snapshotSeq = snapshot.seq;
      if (refreshedSnapshotCoversQueuedOutput) {
        pending.queuedOutput = '';
      }
      const refreshReplayToken = pending.replayToken;
      pending.timer = setTimeout(() => {
        this.handleReplayAckTimeout(ws, sessionId, refreshReplayToken, snapshot.seq, 'refresh-timeout');
      }, REPLAY_ACK_TIMEOUT_MS);
      pending.timer.unref();

      this.sendTo(ws, {
        type: 'screen-snapshot',
        sessionId,
        replayToken: pending.replayToken,
        seq: snapshot.seq,
        cols: snapshot.cols,
        rows: snapshot.rows,
        mode,
        data: snapshot.data,
        truncated: snapshot.truncated,
        source: 'headless',
        windowsPty: snapshot.windowsPty,
      });
      this.recordReplayEvent({
        kind: 'snapshot_refreshed',
        sessionId,
        replayToken: pending.replayToken,
        snapshotSeq: snapshot.seq,
        details: {
          origin: 'refresh',
          clientId: meta?.clientId ?? null,
          cols: snapshot.cols,
          rows: snapshot.rows,
          truncated: snapshot.truncated,
          mode,
        },
      });
    }
  }

  clearSessionState(sessionId: string): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers) {
      return;
    }

    for (const ws of subscribers) {
      this.clearReplayPendingForPair(ws, sessionId, 'session-missing');
      this.clearScreenRepairPendingForPair(ws, sessionId, 'session-missing');
      const meta = this.clients.get(ws);
      meta?.subscribedSessions.delete(sessionId);
    }

    this.sessionSubscribers.delete(sessionId);
  }

  clearReplayEvents(sessionId?: string): void {
    if (!sessionId) {
      this.recentReplayEvents = [];
      this.debugReplayEventsBySession.clear();
      return;
    }
    this.recentReplayEvents = this.recentReplayEvents.filter((event) => event.sessionId !== sessionId);
    this.debugReplayEventsBySession.delete(sessionId);
  }

  enableDebugReplayCapture(sessionId: string): void {
    this.debugReplayEnabledSessions.add(sessionId);
    this.debugReplayEventsBySession.delete(sessionId);
  }

  disableDebugReplayCapture(sessionId: string): void {
    this.debugReplayEnabledSessions.delete(sessionId);
    this.debugReplayEventsBySession.delete(sessionId);
  }

  getDebugReplayEvents(sessionId: string, limit = 200): ReplayTelemetryEvent[] {
    const events = this.debugReplayEventsBySession.get(sessionId) ?? [];
    return events.slice(-Math.max(1, limit));
  }

  getSubscribers(sessionId: string): Set<WebSocket> | undefined {
    return this.sessionSubscribers.get(sessionId);
  }

  sendSessionEvent(sessionId: string, event: string, payload: object): void {
    const subscribers = this.getSubscribers(sessionId);
    if (!subscribers) {
      return;
    }
    for (const ws of subscribers) {
      this.sendTo(ws, { type: event, sessionId, ...payload });
    }
  }

  hasSubscribers(sessionId: string): boolean {
    const subscribers = this.sessionSubscribers.get(sessionId);
    return subscribers !== undefined && subscribers.size > 0;
  }

  getObservabilitySnapshot(): WsRouterObservabilitySnapshot {
    let replayPendingCount = 0;
    let screenRepairPendingCount = 0;
    let transportQueuedClientCount = 0;
    let transportOutputQueuedBytes = 0;
    let transportControlQueuedBytes = 0;
    for (const meta of this.clients.values()) {
      replayPendingCount += meta.replayPendingSessions.size;
      screenRepairPendingCount += this.getScreenRepairPendingSessions(meta).size;
    }
    for (const ws of this.clients.keys()) {
      const transport = this.transportQueues.get(ws);
      if (!transport) {
        continue;
      }
      if (transport.items.length > 0) {
        transportQueuedClientCount += 1;
      }
      transportOutputQueuedBytes += transport.outputBytes;
      transportControlQueuedBytes += transport.controlBytes;
    }

    return {
      connectedClients: this.clients.size,
      subscribedSessionCount: this.sessionSubscribers.size,
      replayPendingCount,
      screenRepairPendingCount,
      replayAckTimeoutCount: this.replayAckTimeoutCount,
      screenRepairAckTimeoutCount: this.screenRepairAckTimeoutCount,
      replayRefreshCount: this.replayRefreshCount,
      maxReplayQueueLengthObserved: this.maxReplayQueueLengthObserved,
      transportQueuedClientCount,
      transportOutputQueuedBytes,
      transportControlQueuedBytes,
      maxTransportQueuedBytesObserved: this.maxTransportQueuedBytesObserved,
      maxServerBufferedAmountObserved: this.maxServerBufferedAmountObserved,
      transportBackpressureObserveCount: this.transportBackpressureObserveCount,
      transportSlowClientCloseCount: this.transportSlowClientCloseCount,
      transportQueueOverflowCount: this.transportQueueOverflowCount,
      transportSendErrorCount: this.transportSendErrorCount,
      transportOutputCoalesceCount: this.transportOutputCoalesceCount,
      recentReplayEvents: [...this.recentReplayEvents],
    };
  }

  recordReplayEvent(event: ReplayTelemetryEventInput): void {
    const nextEvent: ReplayTelemetryEvent = {
      eventId: ++this.replayEventCounter,
      recordedAt: new Date().toISOString(),
      ...event,
    };

    this.recentReplayEvents.push(nextEvent);
    if (this.recentReplayEvents.length > MAX_RECENT_REPLAY_EVENTS) {
      this.recentReplayEvents.splice(0, this.recentReplayEvents.length - MAX_RECENT_REPLAY_EVENTS);
    }

    if (!this.debugReplayEnabledSessions.has(event.sessionId)) {
      return;
    }

    const sessionEvents = this.debugReplayEventsBySession.get(event.sessionId) ?? [];
    sessionEvents.push(nextEvent);
    if (sessionEvents.length > MAX_RECENT_REPLAY_EVENTS) {
      sessionEvents.splice(0, sessionEvents.length - MAX_RECENT_REPLAY_EVENTS);
    }
    this.debugReplayEventsBySession.set(event.sessionId, sessionEvents);
  }

  private getTransportQueueState(ws: WebSocket): WsTransportQueueState {
    const existing = this.transportQueues.get(ws);
    if (existing) {
      return existing;
    }
    const next = createWsTransportQueueState();
    this.transportQueues.set(ws, next);
    return next;
  }

  private sendTransportMessage(ws: WebSocket, message: WsTransportMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const mode = this.runtimeSendPolicyConfig.mode;
    const bufferedAmount = this.getServerBufferedAmount(ws);
    this.maxServerBufferedAmountObserved = Math.max(this.maxServerBufferedAmountObserved, bufferedAmount);

    if (mode === 'direct') {
      this.sendRawTransportMessage(ws, message);
      return;
    }

    const limits = this.runtimeSendPolicyConfig.limits;
    if (bufferedAmount >= limits.serverBufferedHardLimitBytes) {
      if (mode === 'safe-send-observe') {
        this.transportBackpressureObserveCount += 1;
        this.sendRawTransportMessage(ws, message);
        return;
      }
      this.closeBackpressuredClient(ws, 'server-buffered-hard-limit');
      return;
    }

    const state = this.getTransportQueueState(ws);
    if (mode === 'safe-send-observe') {
      if (bufferedAmount >= limits.serverBufferedHighWaterBytes || state.items.length > 0) {
        this.transportBackpressureObserveCount += 1;
      }
      this.sendRawTransportMessage(ws, message);
      return;
    }

    if (bufferedAmount >= limits.serverBufferedHighWaterBytes || state.sending || state.items.length > 0) {
      this.enqueueTransportMessage(ws, state, message);
      return;
    }

    this.sendRawTransportMessage(ws, message, state);
  }

  private enqueueTransportMessage(
    ws: WebSocket,
    state: WsTransportQueueState,
    message: WsTransportMessage,
  ): void {
    const limits = this.runtimeSendPolicyConfig.limits;
    if (message.kind === 'output') {
      const last = state.items[state.items.length - 1];
      const coalesced = last
        ? tryCoalesceOutputMessage(last, message, limits.outputCoalesceWindowMs)
        : null;
      if (coalesced) {
        const nextOutputBytes = state.outputBytes - last.byteLength + coalesced.byteLength;
        if (nextOutputBytes > limits.perClientOutputQueueMaxBytes) {
          this.transportQueueOverflowCount += 1;
          this.closeBackpressuredClient(ws, 'output-queue-overflow');
          return;
        }
        state.items[state.items.length - 1] = coalesced;
        state.outputBytes = nextOutputBytes;
        this.transportOutputCoalesceCount += 1;
        this.updateTransportQueueHighWater(state);
        this.scheduleTransportFlush(ws, state);
        return;
      }

      if (state.outputBytes + message.byteLength > limits.perClientOutputQueueMaxBytes) {
        this.transportQueueOverflowCount += 1;
        this.closeBackpressuredClient(ws, 'output-queue-overflow');
        return;
      }
      state.outputBytes += message.byteLength;
      state.items.push(message);
      this.updateTransportQueueHighWater(state);
      this.scheduleTransportFlush(ws, state);
      return;
    }

    if (state.controlBytes + message.byteLength > limits.perClientControlQueueMaxBytes) {
      this.transportQueueOverflowCount += 1;
      this.closeBackpressuredClient(ws, 'control-queue-overflow');
      return;
    }
    state.controlBytes += message.byteLength;
    state.items.push(message);
    this.updateTransportQueueHighWater(state);
    this.scheduleTransportFlush(ws, state);
  }

  private flushTransportQueue(ws: WebSocket): void {
    const state = this.transportQueues.get(ws);
    if (!state || state.sending || state.items.length === 0 || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const limits = this.runtimeSendPolicyConfig.limits;
    const bufferedAmount = this.getServerBufferedAmount(ws);
    this.maxServerBufferedAmountObserved = Math.max(this.maxServerBufferedAmountObserved, bufferedAmount);
    if (bufferedAmount >= limits.serverBufferedHardLimitBytes) {
      this.closeBackpressuredClient(ws, 'server-buffered-hard-limit');
      return;
    }
    if (bufferedAmount >= limits.serverBufferedHighWaterBytes) {
      this.scheduleTransportFlush(ws, state);
      return;
    }

    const next = state.items.shift();
    if (!next) {
      return;
    }
    if (next.kind === 'output') {
      state.outputBytes = Math.max(0, state.outputBytes - next.byteLength);
    } else {
      state.controlBytes = Math.max(0, state.controlBytes - next.byteLength);
    }
    this.sendRawTransportMessage(ws, next, state);
  }

  private sendRawTransportMessage(
    ws: WebSocket,
    message: WsTransportMessage,
    state = this.transportQueues.get(ws),
  ): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (state && this.runtimeSendPolicyConfig.mode !== 'direct') {
      state.sending = true;
    }

    try {
      ws.send(message.payload, (error?: Error) => {
        if (state) {
          state.sending = false;
        }
        if (error) {
          this.transportSendErrorCount += 1;
          if (this.runtimeSendPolicyConfig.mode === 'safe-send-enforce') {
            this.closeBackpressuredClient(ws, 'send-callback-error');
          } else {
            console.warn('[WS] WebSocket send callback failed:', error);
          }
          return;
        }
        this.flushTransportQueue(ws);
      });
    } catch (error) {
      if (state) {
        state.sending = false;
      }
      this.transportSendErrorCount += 1;
      console.warn('[WS] WebSocket send failed:', error);
      if (this.runtimeSendPolicyConfig.mode === 'safe-send-enforce') {
        this.closeBackpressuredClient(ws, 'send-failed');
      }
    }
  }

  private closeBackpressuredClient(ws: WebSocket, reason: string): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.transportSlowClientCloseCount += 1;
    this.clearTransportQueueState(ws);
    try {
      ws.close(1013, `WebSocket backpressure: ${reason}`);
    } catch {
      ws.terminate();
    }
  }

  private clearTransportQueueState(ws: WebSocket): void {
    const state = this.transportQueues.get(ws);
    if (!state) {
      return;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
    }
    state.items = [];
    state.outputBytes = 0;
    state.controlBytes = 0;
    state.sending = false;
    state.flushTimer = null;
    this.transportQueues.delete(ws);
  }

  private flushAndClearTransportQueuesForPolicyRollback(): void {
    for (const [ws, state] of this.transportQueues) {
      const queued = [...state.items];
      this.clearTransportQueueState(ws);
      for (const message of queued) {
        this.sendRawTransportMessage(ws, message, undefined);
      }
    }
  }

  private updateTransportQueueHighWater(state: WsTransportQueueState): void {
    this.maxTransportQueuedBytesObserved = Math.max(
      this.maxTransportQueuedBytesObserved,
      state.outputBytes + state.controlBytes,
    );
  }

  private getServerBufferedAmount(ws: WebSocket): number {
    return typeof ws.bufferedAmount === 'number' && Number.isFinite(ws.bufferedAmount)
      ? Math.max(0, ws.bufferedAmount)
      : 0;
  }

  private scheduleTransportFlush(ws: WebSocket, state = this.transportQueues.get(ws)): void {
    if (!state || state.flushTimer || state.items.length === 0 || this.runtimeSendPolicyConfig.mode !== 'safe-send-enforce') {
      return;
    }

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flushTransportQueue(ws);
      const next = this.transportQueues.get(ws);
      if (next && next.items.length > 0 && !next.sending) {
        this.scheduleTransportFlush(ws, next);
      }
    }, TRANSPORT_FLUSH_RETRY_MS);
    state.flushTimer.unref();
  }

  broadcastAll(event: string, data: object, excludeClientId?: string): void {
    for (const [ws, meta] of this.clients) {
      if (meta.clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        this.sendTo(ws, { type: event, data });
      }
    }
  }

  sendTo(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      this.sendTransportMessage(ws, createWsTransportMessage(msg));
    }
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [, meta] of this.clients) {
      for (const pending of meta.replayPendingSessions.values()) {
        clearTimeout(pending.timer);
      }
      for (const pending of this.getScreenRepairPendingSessions(meta).values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
      }
    }

    for (const [ws] of this.clients) {
      this.clearTransportQueueState(ws);
      ws.terminate();
    }
    this.clients.clear();
    this.transportQueues.clear();
    this.sessionSubscribers.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScreenRepairReason(value: unknown): value is ScreenRepairReason {
  return value === 'manual' || value === 'workspace' || value === 'resize';
}

function cloneServerWsResourceLimits(source: ServerWsResourceLimitsConfig): ServerWsResourceLimitsConfig {
  return {
    serverBufferedHighWaterBytes: source.serverBufferedHighWaterBytes,
    serverBufferedHardLimitBytes: source.serverBufferedHardLimitBytes,
    perClientOutputQueueMaxBytes: source.perClientOutputQueueMaxBytes,
    perClientControlQueueMaxBytes: source.perClientControlQueueMaxBytes,
    outputCoalesceWindowMs: source.outputCoalesceWindowMs,
  };
}

function isScreenRepairBufferType(value: unknown): value is ScreenRepairBufferType {
  return value === 'normal' || value === 'alternate';
}
