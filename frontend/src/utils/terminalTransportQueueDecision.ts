export interface StaleSocketReconnectDecision {
  action: 'queue' | 'reject';
  reconnectStartedAt: number;
}

export function resolveStaleSocketReconnectDecision(input: {
  reconnectStartedAt: number | null;
  now: number;
  reconnectTtlMs: number;
}): StaleSocketReconnectDecision {
  const reconnectStartedAt = input.reconnectStartedAt ?? input.now;
  if (input.now - reconnectStartedAt <= input.reconnectTtlMs) {
    return {
      action: 'queue',
      reconnectStartedAt,
    };
  }

  return {
    action: 'reject',
    reconnectStartedAt,
  };
}
