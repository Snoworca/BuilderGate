import type { WsTransportMode } from '../types/ws-protocol';

export interface SplitSubscriptionFlushState {
  transportMode: WsTransportMode;
  splitOutputReady: boolean;
  splitControlFallback: boolean;
  forceControl?: boolean;
}

export interface SplitOutputCloseAction {
  splitControlFallback: boolean;
  flushControlSubscriptions: boolean;
}

export function shouldFlushControlSubscriptions({
  transportMode,
  splitOutputReady,
  splitControlFallback,
  forceControl,
}: SplitSubscriptionFlushState): boolean {
  return Boolean(
    forceControl
    || transportMode !== 'split'
    || splitOutputReady
    || splitControlFallback,
  );
}

export function resolveSplitOutputCloseAction(): SplitOutputCloseAction {
  return {
    splitControlFallback: true,
    flushControlSubscriptions: true,
  };
}

