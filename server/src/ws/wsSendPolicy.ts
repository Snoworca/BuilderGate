export type WsTransportMessageKind = 'output' | 'control' | 'terminal-control';

export interface WsTransportMessage {
  kind: WsTransportMessageKind;
  payload: string;
  byteLength: number;
  queuedAt: number;
  sessionId?: string;
  outputData?: string;
}

export interface WsTransportQueueState {
  controlItems: WsTransportMessage[];
  controlHead: number;
  terminalItems: WsTransportMessage[];
  terminalHead: number;
  outputBytes: number;
  controlBytes: number;
  sending: boolean;
  flushTimer: NodeJS.Timeout | null;
}

export function createWsTransportQueueState(): WsTransportQueueState {
  return {
    controlItems: [],
    controlHead: 0,
    terminalItems: [],
    terminalHead: 0,
    outputBytes: 0,
    controlBytes: 0,
    sending: false,
    flushTimer: null,
  };
}

export function createWsTransportMessage(message: object, now = Date.now()): WsTransportMessage {
  const output = isOutputMessage(message) ? message : null;
  const kind = output ? 'output' : getControlMessageKind(message);
  const payload = JSON.stringify(message);
  return {
    kind,
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

export function getTransportQueuedMessageCount(state: WsTransportQueueState): number {
  return getQueuedCount(state.controlItems, state.controlHead)
    + getQueuedCount(state.terminalItems, state.terminalHead);
}

export function hasTransportQueuedMessages(state: WsTransportQueueState): boolean {
  return getTransportQueuedMessageCount(state) > 0;
}

export function getLastTerminalTransportMessage(state: WsTransportQueueState): WsTransportMessage | undefined {
  compactIfNeeded(state, 'terminal');
  if (state.terminalHead >= state.terminalItems.length) {
    return undefined;
  }
  return state.terminalItems[state.terminalItems.length - 1];
}

export function replaceLastTerminalTransportMessage(
  state: WsTransportQueueState,
  message: WsTransportMessage,
): void {
  compactIfNeeded(state, 'terminal');
  if (state.terminalHead >= state.terminalItems.length) {
    state.terminalItems.push(message);
    return;
  }
  state.terminalItems[state.terminalItems.length - 1] = message;
}

export function pushTransportMessage(state: WsTransportQueueState, message: WsTransportMessage): void {
  if (message.kind === 'control') {
    state.controlItems.push(message);
    return;
  }
  state.terminalItems.push(message);
}

export function peekNextTransportMessage(state: WsTransportQueueState): WsTransportMessage | undefined {
  if (state.controlHead < state.controlItems.length) {
    return state.controlItems[state.controlHead];
  }
  return state.terminalItems[state.terminalHead];
}

export function dequeueNextTransportMessage(state: WsTransportQueueState): WsTransportMessage | undefined {
  if (state.controlHead < state.controlItems.length) {
    const next = state.controlItems[state.controlHead];
    state.controlHead += 1;
    compactIfNeeded(state, 'control');
    return next;
  }
  if (state.terminalHead < state.terminalItems.length) {
    const next = state.terminalItems[state.terminalHead];
    state.terminalHead += 1;
    compactIfNeeded(state, 'terminal');
    return next;
  }
  return undefined;
}

export function getTransportMessagesInPriorityOrder(state: WsTransportQueueState): WsTransportMessage[] {
  return [
    ...state.controlItems.slice(state.controlHead),
    ...state.terminalItems.slice(state.terminalHead),
  ];
}

export function clearTransportMessages(state: WsTransportQueueState): void {
  state.controlItems = [];
  state.controlHead = 0;
  state.terminalItems = [];
  state.terminalHead = 0;
}

function isOutputMessage(message: object): message is { type: 'output'; sessionId: string; data: string } {
  const record = message as Record<string, unknown>;
  return record.type === 'output'
    && typeof record.sessionId === 'string'
    && typeof record.data === 'string';
}

function getControlMessageKind(message: object): Exclude<WsTransportMessageKind, 'output'> {
  const record = message as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  return isTerminalOrderedControlMessage(record, type) ? 'terminal-control' : 'control';
}

function isTerminalOrderedControlMessage(record: Record<string, unknown>, type: string): boolean {
  if (type !== 'input:rejected' && typeof record.sessionId === 'string') {
    return true;
  }
  return type === 'screen-snapshot'
    || type === 'screen-repair'
    || type === 'session:ready'
    || type === 'subscribed';
}

function getQueuedCount(items: WsTransportMessage[], head: number): number {
  return Math.max(0, items.length - head);
}

function compactIfNeeded(state: WsTransportQueueState, lane: 'control' | 'terminal'): void {
  if (lane === 'control') {
    if (state.controlHead > 32 && state.controlHead * 2 >= state.controlItems.length) {
      state.controlItems = state.controlItems.slice(state.controlHead);
      state.controlHead = 0;
    }
    return;
  }

  if (state.terminalHead > 32 && state.terminalHead * 2 >= state.terminalItems.length) {
    state.terminalItems = state.terminalItems.slice(state.terminalHead);
    state.terminalHead = 0;
  }
}
