export type WsTransportMessageKind = 'output' | 'control';

export interface WsTransportMessage {
  kind: WsTransportMessageKind;
  payload: string;
  byteLength: number;
  queuedAt: number;
  sessionId?: string;
  outputData?: string;
}

export interface WsTransportQueueState {
  items: WsTransportMessage[];
  outputBytes: number;
  controlBytes: number;
  sending: boolean;
  flushTimer: NodeJS.Timeout | null;
}

export function createWsTransportQueueState(): WsTransportQueueState {
  return {
    items: [],
    outputBytes: 0,
    controlBytes: 0,
    sending: false,
    flushTimer: null,
  };
}

export function createWsTransportMessage(message: object, now = Date.now()): WsTransportMessage {
  const output = isOutputMessage(message) ? message : null;
  const payload = JSON.stringify(message);
  return {
    kind: output ? 'output' : 'control',
    payload,
    byteLength: Buffer.byteLength(payload, 'utf8'),
    queuedAt: now,
    ...(output ? { sessionId: output.sessionId, outputData: output.data } : {}),
  };
}

export function tryCoalesceOutputMessage(
  existing: WsTransportMessage,
  incoming: WsTransportMessage,
  coalesceWindowMs: number,
): WsTransportMessage | null {
  if (
    existing.kind !== 'output'
    || incoming.kind !== 'output'
    || !existing.sessionId
    || existing.sessionId !== incoming.sessionId
    || existing.outputData === undefined
    || incoming.outputData === undefined
    || incoming.queuedAt - existing.queuedAt > coalesceWindowMs
  ) {
    return null;
  }

  return createWsTransportMessage({
    type: 'output',
    sessionId: existing.sessionId,
    data: `${existing.outputData}${incoming.outputData}`,
  }, existing.queuedAt);
}

function isOutputMessage(message: object): message is { type: 'output'; sessionId: string; data: string } {
  const record = message as Record<string, unknown>;
  return record.type === 'output'
    && typeof record.sessionId === 'string'
    && typeof record.data === 'string';
}
