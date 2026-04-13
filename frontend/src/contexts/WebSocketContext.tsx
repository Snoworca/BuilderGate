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
import type { ClientWsMessage, ScreenSnapshotMessage, ServerWsMessage } from '../types/ws-protocol';

// ============================================================================
// Types
// ============================================================================

export type WsConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface SessionHandlers {
  onScreenSnapshot?: (snapshot: ScreenSnapshotMessage) => void;
  onSubscribed?: (info: { status: string; cwd?: string }) => void;
  onOutput?: (data: string) => void;
  onStatus?: (status: string) => void;
  onError?: (message: string) => void;
  onCwd?: (cwd: string) => void;
}

export type WorkspaceEventHandler = (data: unknown) => void;

export interface WebSocketContextValue {
  status: WsConnectionStatus;
  clientId: string | null;
  send: (msg: ClientWsMessage) => void;
  subscribeSession: (sessionId: string, handlers: SessionHandlers) => () => void;
  setWorkspaceHandlers: (handlers: Record<string, WorkspaceEventHandler>) => void;
}

export interface WebSocketStateValue {
  status: WsConnectionStatus;
  clientId: string | null;
}

export interface WebSocketActionsValue {
  send: (msg: ClientWsMessage) => void;
  subscribeSession: (sessionId: string, handlers: SessionHandlers) => () => void;
  setWorkspaceHandlers: (handlers: Record<string, WorkspaceEventHandler>) => void;
}

const WebSocketStateContext = createContext<WebSocketStateValue | null>(null);
const WebSocketActionsContext = createContext<WebSocketActionsValue | null>(null);

// ============================================================================
// Constants
// ============================================================================

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

function getReconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
}

function getWsUrl(): string {
  const token = tokenStorage.getToken();
  // Same origin — backend serves both API and frontend assets
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host; // includes port
  return `${protocol}//${host}/ws?token=${encodeURIComponent(token || '')}`;
}

// ============================================================================
// Provider
// ============================================================================

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsConnectionStatus>('disconnected');
  const [clientId, setClientId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptReconnectRef = useRef<() => void>(() => {});
  const sessionHandlersRef = useRef<Map<string, SessionHandlers>>(new Map());
  const workspaceHandlersRef = useRef<Record<string, WorkspaceEventHandler>>({});
  const activeSubscriptionsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  // ------ Message handler ------
  const handleMessage = useCallback((event: MessageEvent) => {
    let msg: ServerWsMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Connection events
    if (msg.type === 'connected') {
      setClientId(msg.clientId);
      setWsClientId(msg.clientId);
      return;
    }
    if (msg.type === 'pong') return;

    // Subscribed response — route status to handlers
    if (msg.type === 'subscribed') {
      for (const info of msg.sessions) {
        const handlers = sessionHandlersRef.current.get(info.sessionId);
        if (!handlers) continue;
        if (info.status === 'error') {
          handlers.onError?.('Session not found');
        } else {
          handlers.onSubscribed?.({ status: info.status, cwd: info.cwd });
          handlers.onStatus?.(info.status);
          if (info.cwd) handlers.onCwd?.(info.cwd);
        }
      }
      return;
    }

    // Session events (have sessionId field)
    if ('sessionId' in msg) {
      const sessionId = (msg as { sessionId: string }).sessionId;
      const handlers = sessionHandlersRef.current.get(sessionId);
      if (!handlers) return;

      switch (msg.type) {
        case 'screen-snapshot':
          handlers.onScreenSnapshot?.(msg);
          break;
        case 'output':
          handlers.onOutput?.(msg.data);
          break;
        case 'status':
          handlers.onStatus?.(msg.status);
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
  }, []);

  // ------ Connect ------
  const connect = useCallback(() => {
    const token = tokenStorage.getToken();
    if (!token) {
      setStatus('disconnected');
      return;
    }

    const url = getWsUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus('reconnecting');

    ws.onopen = () => {
      if (!mountedRef.current) return;
      reconnectAttemptRef.current = 0;
      setStatus('connected');
      console.log('[WS] Connected');

      // Re-subscribe to active sessions
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
      wsRef.current = null;
      setClientId(null);
      setWsClientId(null);
      attemptReconnectRef.current();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [handleMessage]);

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
      if (mountedRef.current) connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    attemptReconnectRef.current = attemptReconnect;
  }, [attemptReconnect]);

  // ------ Lifecycle ------
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // ------ Public API ------
  const send = useCallback((msg: ClientWsMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const subscribeSession = useCallback((sessionId: string, handlers: SessionHandlers): (() => void) => {
    // Always update handlers (re-render may provide new callbacks)
    sessionHandlersRef.current.set(sessionId, handlers);

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
        activeSubscriptionsRef.current.delete(sessionId);

        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({ type: 'unsubscribe', sessionIds: [sessionId] }));
        }
      }
      // If currentHandlers !== myHandlers, a newer instance already took over — skip cleanup
    };
  }, []);

  const setWorkspaceHandlers = useCallback((handlers: Record<string, WorkspaceEventHandler>) => {
    workspaceHandlersRef.current = handlers;
  }, []);

  const stateValue = useMemo<WebSocketStateValue>(() => ({
    status,
    clientId,
  }), [status, clientId]);

  const actionsValue = useMemo<WebSocketActionsValue>(() => ({
    send,
    subscribeSession,
    setWorkspaceHandlers,
  }), [send, subscribeSession, setWorkspaceHandlers]);

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
