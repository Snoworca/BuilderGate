/**
 * WebSocket Router
 * Step 8: SSE+HTTP → WebSocket single channel migration
 *
 * Manages WebSocket connections, JWT authentication on upgrade,
 * message routing, ping/pong heartbeat, and session subscriptions.
 */

import { WebSocket, WebSocketServer } from 'ws';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { ClientWsMessage, WsClientMeta } from '../types/ws-protocol.js';

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

export class WsRouter {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, WsClientMeta> = new Map();
  private sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionManager: SessionManager;

  constructor(server: https.Server, authService: AuthService, sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.wss = new WebSocketServer({ noServer: true });

    this.setupUpgradeHandler(server, authService);
    this.setupConnectionHandler();
    this.startHeartbeat();

    console.log('[WS] WebSocket router initialized');
  }

  // ==========================================================================
  // Upgrade Handler (JWT Authentication)
  // ==========================================================================

  private setupUpgradeHandler(server: https.Server, authService: AuthService): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Only handle /ws path
      const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Extract JWT token from query parameter
      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Verify JWT
      const result = authService.verifyToken(token);
      if (!result.valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Complete the upgrade
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req, result.payload);
      });
    });
  }

  // ==========================================================================
  // Connection Handler
  // ==========================================================================

  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      const clientId = uuidv4();
      const meta: WsClientMeta = {
        clientId,
        isAlive: true,
        subscribedSessions: new Set(),
      };
      this.clients.set(ws, meta);

      // Send connected message with clientId
      ws.send(JSON.stringify({ type: 'connected', clientId }));
      console.log(`[WS] Client connected: ${clientId}`);

      // Handle pong responses
      ws.on('pong', () => {
        const m = this.clients.get(ws);
        if (m) m.isAlive = true;
      });

      // Handle incoming messages
      ws.on('message', (raw: Buffer | string) => {
        this.handleMessage(ws, raw);
      });

      // Handle disconnect
      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Client error (${clientId}):`, err.message);
      });
    });
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

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

  // ==========================================================================
  // Subscribe / Unsubscribe
  // ==========================================================================

  private handleSubscribe(ws: WebSocket, sessionIds: string[]): void {
    const results: Array<{ sessionId: string; status: string; cwd?: string }> = [];

    for (const id of sessionIds) {
      // Register subscription
      if (!this.sessionSubscribers.has(id)) {
        this.sessionSubscribers.set(id, new Set());
      }
      this.sessionSubscribers.get(id)!.add(ws);

      const meta = this.clients.get(ws);
      if (meta) meta.subscribedSessions.add(id);

      // Check session existence and get status
      const session = this.sessionManager.getSession(id);
      if (session) {
        const cwd = this.sessionManager.getLastCwd(id) ?? undefined;
        results.push({ sessionId: id, status: session.status, cwd });
        // Flush buffered output to this WS client
        this.sessionManager.flushBufferToWs(id, ws);
      } else {
        results.push({ sessionId: id, status: 'error' });
      }
    }

    ws.send(JSON.stringify({ type: 'subscribed', sessions: results }));
  }

  private handleUnsubscribe(ws: WebSocket, sessionIds: string[]): void {
    for (const id of sessionIds) {
      const subs = this.sessionSubscribers.get(id);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) this.sessionSubscribers.delete(id);
      }

      const meta = this.clients.get(ws);
      if (meta) meta.subscribedSessions.delete(id);
    }
  }

  // ==========================================================================
  // Input / Resize
  // ==========================================================================

  private handleInput(_ws: WebSocket, sessionId: string, data: string): void {
    this.sessionManager.writeInput(sessionId, data);
  }

  private handleResize(_ws: WebSocket, sessionId: string, cols: number, rows: number): void {
    this.sessionManager.resize(sessionId, cols, rows);
  }

  // ==========================================================================
  // Disconnect Cleanup
  // ==========================================================================

  private handleDisconnect(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    if (meta) {
      console.log(`[WS] Client disconnected: ${meta.clientId}`);
      // Remove from all session subscriptions
      for (const sessionId of meta.subscribedSessions) {
        const subs = this.sessionSubscribers.get(sessionId);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) this.sessionSubscribers.delete(sessionId);
        }
      }
    }
    this.clients.delete(ws);
  }

  // ==========================================================================
  // Heartbeat (ping/pong)
  // ==========================================================================

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

  // ==========================================================================
  // Public API (used by SessionManager and workspaceRoutes)
  // ==========================================================================

  /** Get all WS clients subscribed to a session */
  getSubscribers(sessionId: string): Set<WebSocket> | undefined {
    return this.sessionSubscribers.get(sessionId);
  }

  /** Check if a session has any WS subscribers */
  hasSubscribers(sessionId: string): boolean {
    const subs = this.sessionSubscribers.get(sessionId);
    return subs !== undefined && subs.size > 0;
  }

  /** Broadcast to all connected clients (workspace events) */
  broadcastAll(event: string, data: object, excludeClientId?: string): void {
    const msg = JSON.stringify({ type: event, data });
    for (const [ws, meta] of this.clients) {
      if (meta.clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /** Send a message to a specific WS client */
  sendTo(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Clean up on server shutdown */
  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [ws] of this.clients) {
      ws.terminate();
    }
    this.clients.clear();
    this.sessionSubscribers.clear();
  }
}
