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
import type { ClientWsMessage, ReplayPendingState, WsClientMeta } from '../types/ws-protocol.js';

const HEARTBEAT_INTERVAL = 30_000;
const REPLAY_ACK_TIMEOUT_MS = 5_000;

export class WsRouter {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, WsClientMeta> = new Map();
  private sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionManager: SessionManager;
  private authService: AuthService;

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
      case 'history:ready':
        this.handleHistoryReady(ws, msg.sessionId);
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
    const results: Array<{ sessionId: string; status: string; cwd?: string }> = [];
    const meta = this.clients.get(ws);
    if (!meta) return;

    for (const sessionId of sessionIds) {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        results.push({ sessionId, status: 'error' });
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
      results.push({ sessionId, status: session.status, cwd });

      if (alreadySubscribed) {
        continue;
      }

      const replay = this.sessionManager.getReplaySnapshot(sessionId);
      if (replay && replay.data.length > 0) {
        this.markReplayPending(ws, sessionId);
        this.sendTo(ws, {
          type: 'history',
          sessionId,
          data: replay.data,
          truncated: replay.truncated,
        });
      }
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

  private handleHistoryReady(ws: WebSocket, sessionId: string): void {
    const queuedOutput = this.clearReplayPendingForPair(ws, sessionId);
    if (!queuedOutput || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.sendTo(ws, { type: 'output', sessionId, data: queuedOutput });
  }

  private handleInput(_ws: WebSocket, sessionId: string, data: string): void {
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

  private markReplayPending(ws: WebSocket, sessionId: string): void {
    const meta = this.clients.get(ws);
    if (!meta || meta.replayPendingSessions.has(sessionId)) {
      return;
    }

    const state: ReplayPendingState = {
      queuedOutput: '',
      timer: setTimeout(() => {
        this.clearReplayPendingForPair(ws, sessionId);
      }, REPLAY_ACK_TIMEOUT_MS),
    };
    state.timer.unref();
    meta.replayPendingSessions.set(sessionId, state);
  }

  private clearReplayPendingForPair(ws: WebSocket, sessionId: string): string {
    const meta = this.clients.get(ws);
    if (!meta) return '';

    const pending = meta.replayPendingSessions.get(sessionId);
    if (!pending) return '';

    clearTimeout(pending.timer);
    meta.replayPendingSessions.delete(sessionId);
    return pending.queuedOutput;
  }

  private appendQueuedOutput(state: ReplayPendingState, data: string): void {
    const limit = this.sessionManager.getReplayQueueLimit();
    const next = `${state.queuedOutput}${data}`;
    state.queuedOutput = next.length > limit ? next.slice(-limit) : next;
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
        continue;
      }

      ws.send(encoded);
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

  getSubscribers(sessionId: string): Set<WebSocket> | undefined {
    return this.sessionSubscribers.get(sessionId);
  }

  hasSubscribers(sessionId: string): boolean {
    const subscribers = this.sessionSubscribers.get(sessionId);
    return subscribers !== undefined && subscribers.size > 0;
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
