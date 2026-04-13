/**
 * WebSocket Message Protocol Types
 * Shared type definitions for client-server WS communication.
 * Server has a copy at server/src/types/ws-protocol.ts
 */

// ============================================================================
// Client → Server Messages
// ============================================================================

export type ClientWsMessage =
  | { type: 'subscribe';   sessionIds: string[] }
  | { type: 'unsubscribe'; sessionIds: string[] }
  | { type: 'history:ready'; sessionId: string }
  | { type: 'input';       sessionId: string; data: string }
  | { type: 'resize';      sessionId: string; cols: number; rows: number }
  | { type: 'ping' };

// ============================================================================
// Server → Client Messages
// ============================================================================

export type ScreenSnapshotMode = 'authoritative' | 'fallback';
export type ScreenSnapshotSource = 'headless';

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
}

export type ServerWsMessage =
  // Session events
  | { type: 'history';        sessionId: string; data: string; truncated: boolean }
  | { type: 'output';         sessionId: string; data: string }
  | { type: 'status';         sessionId: string; status: 'running' | 'idle' }
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
}
