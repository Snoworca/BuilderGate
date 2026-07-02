import type { WsChannelRole, WsTransportMode } from '../types/ws-protocol';

export interface WebSocketUrlLocation {
  protocol: string;
  host: string;
}

export interface BuildControlWebSocketUrlOptions {
  token: string | null;
  location: WebSocketUrlLocation;
  transportMode: WsTransportMode;
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
}: BuildControlWebSocketUrlOptions): string {
  const params = new URLSearchParams({ token: token || '' });
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

