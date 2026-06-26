import type { ClientWsMessage } from '../types/ws-protocol';
import type { ClientWsResourceLimitsRuntimeConfig } from './inputReliabilityMode';

export type BrowserBackpressureDecision =
  | { action: 'send' }
  | {
      action: 'backpressure';
      reason: 'client-backpressure';
      bufferedAmount: number;
      payloadBytes: number;
    }
  | {
      action: 'hard-reconnect';
      reason: 'client-hard-backpressure';
      bufferedAmount: number;
      payloadBytes: number;
    };

export interface BrowserBackpressureInput {
  messageType: ClientWsMessage['type'];
  serializedPayload: string;
  bufferedAmount: number;
  limits: ClientWsResourceLimitsRuntimeConfig;
}

export interface BrowserBufferedAmountSource {
  readyState: number;
  bufferedAmount: number;
}

export interface OpenBrowserWebSocketLike extends BrowserBufferedAmountSource {
  send(payload: string): void;
}

export type OpenBrowserWebSocketSendResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-open' | 'client-backpressure' | 'client-hard-backpressure';
      bufferedAmount?: number;
      payloadBytes?: number;
    };

export interface OpenBrowserWebSocketSendInput {
  message: ClientWsMessage;
  socket: OpenBrowserWebSocketLike;
  limits: ClientWsResourceLimitsRuntimeConfig;
  openReadyState?: number;
  onHardBackpressure?: () => void;
}

const textEncoder = new TextEncoder();

export function getUtf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

export function getBrowserInputBackpressureLowWaterBytes(limits: ClientWsResourceLimitsRuntimeConfig): number {
  return Math.floor(limits.inputBackpressureBytes / 2);
}

export function isBrowserInputBackpressureRecovered(
  bufferedAmount: number,
  limits: ClientWsResourceLimitsRuntimeConfig,
): boolean {
  return normalizeBufferedAmount(bufferedAmount) < getBrowserInputBackpressureLowWaterBytes(limits);
}

export function readOpenBrowserBufferedAmount(
  source: BrowserBufferedAmountSource | null | undefined,
  openReadyState = 1,
): number | null {
  if (!source || source.readyState !== openReadyState) {
    return null;
  }
  return normalizeBufferedAmount(source.bufferedAmount);
}

export function evaluateBrowserInputBackpressure(input: BrowserBackpressureInput): BrowserBackpressureDecision {
  if (input.messageType !== 'input') {
    return { action: 'send' };
  }

  const bufferedAmount = normalizeBufferedAmount(input.bufferedAmount);
  const payloadBytes = getUtf8ByteLength(input.serializedPayload);
  const projectedBytes = bufferedAmount + payloadBytes;

  if (
    bufferedAmount >= input.limits.hardReconnectBytes
    || projectedBytes > input.limits.hardReconnectBytes
  ) {
    return {
      action: 'hard-reconnect',
      reason: 'client-hard-backpressure',
      bufferedAmount,
      payloadBytes,
    };
  }

  if (
    bufferedAmount >= input.limits.inputBackpressureBytes
    || projectedBytes > input.limits.inputBackpressureBytes
  ) {
    return {
      action: 'backpressure',
      reason: 'client-backpressure',
      bufferedAmount,
      payloadBytes,
    };
  }

  return { action: 'send' };
}

export function sendOpenBrowserWebSocketMessage(input: OpenBrowserWebSocketSendInput): OpenBrowserWebSocketSendResult {
  const bufferedAmount = readOpenBrowserBufferedAmount(input.socket, input.openReadyState ?? 1);
  if (bufferedAmount === null) {
    return { ok: false, reason: 'not-open' };
  }

  const serializedPayload = JSON.stringify(input.message);
  const decision = evaluateBrowserInputBackpressure({
    messageType: input.message.type,
    serializedPayload,
    bufferedAmount,
    limits: input.limits,
  });

  if (decision.action === 'hard-reconnect') {
    input.onHardBackpressure?.();
    return {
      ok: false,
      reason: decision.reason,
      bufferedAmount: decision.bufferedAmount,
      payloadBytes: decision.payloadBytes,
    };
  }

  if (decision.action === 'backpressure') {
    return {
      ok: false,
      reason: decision.reason,
      bufferedAmount: decision.bufferedAmount,
      payloadBytes: decision.payloadBytes,
    };
  }

  input.socket.send(serializedPayload);
  return { ok: true };
}

function normalizeBufferedAmount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
