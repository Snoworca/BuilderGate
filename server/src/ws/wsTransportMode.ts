export type WsTransportMode = 'unified' | 'split-shadow' | 'split';
export type WsChannelRole = 'single' | 'control' | 'output';

export type WsTransportRequest =
  | {
      ok: true;
      requestedMode: WsTransportMode;
      channelRole: WsChannelRole;
      clientGroupId?: string;
      pairToken?: string;
    }
  | {
      ok: false;
      statusCode: 400 | 403;
      reason:
        | 'invalid-mode'
        | 'invalid-channel'
        | 'missing-channel'
        | 'missing-output-pairing'
        | 'split-disabled';
    };

export function parseWsTransportRequest(
  url: URL,
  configuredMode: WsTransportMode,
): WsTransportRequest {
  const rawMode = url.searchParams.get('mode');
  if (rawMode === null || rawMode === '' || rawMode === 'unified') {
    return {
      ok: true,
      requestedMode: 'unified',
      channelRole: 'single',
    };
  }

  if (rawMode !== 'split') {
    return {
      ok: false,
      statusCode: 400,
      reason: 'invalid-mode',
    };
  }

  if (configuredMode === 'unified') {
    return {
      ok: false,
      statusCode: 400,
      reason: 'split-disabled',
    };
  }

  const rawChannel = url.searchParams.get('channel');
  if (rawChannel === null || rawChannel === '') {
    return {
      ok: false,
      statusCode: 400,
      reason: 'missing-channel',
    };
  }
  if (rawChannel !== 'control' && rawChannel !== 'output') {
    return {
      ok: false,
      statusCode: 400,
      reason: 'invalid-channel',
    };
  }

  if (rawChannel === 'control') {
    return {
      ok: true,
      requestedMode: configuredMode,
      channelRole: 'control',
    };
  }

  const clientGroupId = url.searchParams.get('clientGroupId');
  const pairToken = url.searchParams.get('pairToken');
  if (!clientGroupId || !pairToken) {
    return {
      ok: false,
      statusCode: 400,
      reason: 'missing-output-pairing',
    };
  }

  return {
    ok: true,
    requestedMode: configuredMode,
    channelRole: 'output',
    clientGroupId,
    pairToken,
  };
}
