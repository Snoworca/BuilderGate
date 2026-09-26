import type { WsChannelRole, WsTransportMode } from '../types/ws-protocol';

export interface WebSocketUrlLocation {
  protocol: string;
  host: string;
}

export interface BuildControlWebSocketUrlOptions {
  token: string | null;
  location: WebSocketUrlLocation;
  transportMode: WsTransportMode;
  /**
   * #111 / #18 criterion 11: the per-tab identity the server keys its dedup record by.
   *
   * Omitted when the browser cannot produce one (blocked storage). Absent means absent --
   * an empty parameter would be a claim of identity the client cannot back, and the server
   * falls back to connection-scoped behaviour rather than treating '' as a shared client.
   */
  logicalClientId?: string;
}

export interface SplitOutputMetadata {
  wsTransportMode?: WsTransportMode;
  channel?: WsChannelRole;
  clientGroupId?: string;
  pairToken?: string;
}

export interface BuildSplitOutputWebSocketUrlOptions {
  token: string | null;
  location: WebSocketUrlLocation;
  metadata: SplitOutputMetadata;
}

export interface WebSocketConnectAttemptFence {
  begin(): number;
  isCurrent(generation: number): boolean;
  invalidate(): void;
}

// @req MIG-BGSTAB-002 AC-3 AC-4
export function createWebSocketConnectAttemptFence(): WebSocketConnectAttemptFence {
  let generation = 0;
  return Object.freeze({
    begin: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
    invalidate: () => { generation += 1; },
  });
}

function toWsProtocol(protocol: string): 'ws:' | 'wss:' {
  return protocol === 'https:' ? 'wss:' : 'ws:';
}

function buildBaseUrl(location: WebSocketUrlLocation, params: URLSearchParams): string {
  return `${toWsProtocol(location.protocol)}//${location.host}/ws?${params.toString()}`;
}

export function buildControlWebSocketUrl({
  token,
  location,
  transportMode,
  logicalClientId,
}: BuildControlWebSocketUrlOptions): string {
  const params = new URLSearchParams({ token: token || '' });
  if (logicalClientId && logicalClientId.trim().length > 0) {
    params.set('logicalClientId', logicalClientId);
  }
  if (transportMode === 'split' || transportMode === 'split-shadow') {
    params.set('mode', 'split');
    params.set('channel', 'control');
  }
  return buildBaseUrl(location, params);
}

export function buildSplitOutputWebSocketUrl({
  token,
  location,
  metadata,
}: BuildSplitOutputWebSocketUrlOptions): string | null {
  if (
    metadata.wsTransportMode !== 'split'
    || metadata.channel !== 'control'
    || !metadata.clientGroupId
    || !metadata.pairToken
  ) {
    return null;
  }

  const params = new URLSearchParams({
    token: token || '',
    mode: 'split',
    channel: 'output',
    clientGroupId: metadata.clientGroupId,
    pairToken: metadata.pairToken,
  });
  return buildBaseUrl(location, params);
}

