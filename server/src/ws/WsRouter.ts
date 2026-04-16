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
  ClientWsMessage,
  ReplayPendingState,
  ReplayTelemetryEvent,
  ReplayTelemetryEventInput,
  WsClientMeta,
  WsRouterObservabilitySnapshot,
} from '../types/ws-protocol.js';

const HEARTBEAT_INTERVAL = 30_000;
const REPLAY_ACK_TIMEOUT_MS = 5_000;
const MAX_RECENT_REPLAY_EVENTS = 256;

export class WsRouter {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, WsClientMeta> = new Map();
  private sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionManager: SessionManager;
  private authService: AuthService;
  private replayAckTimeoutCount = 0;
  private replayRefreshCount = 0;
  private maxReplayQueueLengthObserved = 0;
  private replayEventCounter = 0;
  private recentReplayEvents: ReplayTelemetryEvent[] = [];
  private debugReplayEventsBySession: Map<string, ReplayTelemetryEvent[]> = new Map();
  private debugReplayEnabledSessions: Set<string> = new Set();

  constructor(authService: AuthService, sessionManager: SessionManager) {
    this.authService = authService;
    this.sessionManager = sessionManager;
    this.wss = new WebSocketServer({ noServer: true });

    this.setupConnectionHandler();
    this.startHeartbeat();

    console.log('[WS] WebSocket router initialized');
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
      };
      this.clients.set(ws, meta);

      ws.send(JSON.stringify({ type: 'connected', clientId }));
      console.log(`[WS] Client connected: ${clientId}`);

      ws.on('pong', () => {
        const current = this.clients.get(ws);
        if (current) current.isAlive = true;
      });

      ws.on('message', (raw: Buffer | string) => {
        this.handleMessage(ws, raw);
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
    let msg: ClientWsMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      console.warn('[WS] Invalid JSON received');
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(ws, msg.sessionIds);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(ws, msg.sessionIds);
        break;
      case 'screen-snapshot:ready':
        this.handleScreenSnapshotReady(ws, msg.sessionId, msg.replayToken);
        break;
      case 'input':
        this.handleInput(ws, msg.sessionId, msg.data);
        break;
      case 'resize':
        this.handleResize(ws, msg.sessionId, msg.cols, msg.rows);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        console.warn(`[WS] Unknown message type: ${(msg as { type: string }).type}`);
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

      const replayState = this.markReplayPending(ws, sessionId, snapshot.seq);
      results.push({
        sessionId,
        status: session.status,
        cwd,
        ready: false,
      });
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
          origin: 'subscribe',
          clientId: meta.clientId,
          cols: snapshot.cols,
          rows: snapshot.rows,
          truncated: snapshot.truncated,
          mode,
        },
      });
    }

    this.sendTo(ws, { type: 'subscribed', sessions: results });
  }

  private handleUnsubscribe(ws: WebSocket, sessionIds: string[]): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    for (const sessionId of sessionIds) {
      this.clearReplayPendingForPair(ws, sessionId);

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

  private handleInput(ws: WebSocket, sessionId: string, data: string): void {
    const meta = this.clients.get(ws);
    const pending = meta?.replayPendingSessions.get(sessionId);
    if (pending) {
      this.recordReplayEvent({
        kind: 'input_blocked',
        sessionId,
        replayToken: pending.replayToken,
        snapshotSeq: pending.snapshotSeq,
        details: {
          inputBytes: data.length,
        },
      });
      return;
    }
    this.sessionManager.writeInput(sessionId, data);
  }

  private handleResize(_ws: WebSocket, sessionId: string, cols: number, rows: number): void {
    this.sessionManager.resize(sessionId, cols, rows);
  }

  private handleDisconnect(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    if (meta) {
      console.log(`[WS] Client disconnected: ${meta.clientId}`);
      for (const sessionId of meta.subscribedSessions) {
        this.clearReplayPendingForPair(ws, sessionId);
        const subscribers = this.sessionSubscribers.get(sessionId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            this.sessionSubscribers.delete(sessionId);
          }
        }
      }
    }

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

    this.clearReplayPendingForPair(ws, sessionId);

    const state: ReplayPendingState = {
      queuedOutput: '',
      replayToken: uuidv4(),
      snapshotSeq,
      timer: setTimeout(() => {
        this.replayAckTimeoutCount += 1;
        this.clearReplayPendingForPair(ws, sessionId);
        if (ws.readyState === WebSocket.OPEN) {
          this.sendTo(ws, { type: 'session:ready', sessionId });
          this.recordReplayEvent({
            kind: 'ready_sent',
            sessionId,
            snapshotSeq,
            details: {
              reason: 'timeout',
            },
          });
        }
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
    | { status: 'ok'; queuedOutput: string; snapshotSeq: number }
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
      snapshotSeq: pending.snapshotSeq,
    };
  }

  private clearReplayPendingForPair(ws: WebSocket, sessionId: string): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const pending = meta.replayPendingSessions.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
  }

  private appendQueuedOutput(state: ReplayPendingState, data: string): void {
    const limit = this.sessionManager.getReplayQueueLimit();
    const next = `${state.queuedOutput}${data}`;
    state.queuedOutput = next.length > limit ? next.slice(-limit) : next;
    this.maxReplayQueueLengthObserved = Math.max(this.maxReplayQueueLengthObserved, state.queuedOutput.length);
  }

  routeSessionOutput(sessionId: string, data: string): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || data.length === 0) {
      return;
    }

    const encoded = JSON.stringify({ type: 'output', sessionId, data });
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

      ws.send(encoded);
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

      clearTimeout(pending.timer);
      pending.replayToken = uuidv4();
      pending.snapshotSeq = snapshot.seq;
      pending.queuedOutput = '';
      pending.timer = setTimeout(() => {
        this.clearReplayPendingForPair(ws, sessionId);
        if (ws.readyState === WebSocket.OPEN) {
          this.sendTo(ws, { type: 'session:ready', sessionId });
          this.recordReplayEvent({
            kind: 'ready_sent',
            sessionId,
            snapshotSeq: snapshot.seq,
            details: {
              reason: 'refresh-timeout',
            },
          });
        }
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
      this.clearReplayPendingForPair(ws, sessionId);
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

  hasSubscribers(sessionId: string): boolean {
    const subscribers = this.sessionSubscribers.get(sessionId);
    return subscribers !== undefined && subscribers.size > 0;
  }

  getObservabilitySnapshot(): WsRouterObservabilitySnapshot {
    let replayPendingCount = 0;
    for (const meta of this.clients.values()) {
      replayPendingCount += meta.replayPendingSessions.size;
    }

    return {
      connectedClients: this.clients.size,
      subscribedSessionCount: this.sessionSubscribers.size,
      replayPendingCount,
      replayAckTimeoutCount: this.replayAckTimeoutCount,
      replayRefreshCount: this.replayRefreshCount,
      maxReplayQueueLengthObserved: this.maxReplayQueueLengthObserved,
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

  broadcastAll(event: string, data: object, excludeClientId?: string): void {
    const msg = JSON.stringify({ type: event, data });
    for (const [ws, meta] of this.clients) {
      if (meta.clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  sendTo(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
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
    }

    for (const [ws] of this.clients) {
      ws.terminate();
    }
    this.clients.clear();
    this.sessionSubscribers.clear();
  }
}
