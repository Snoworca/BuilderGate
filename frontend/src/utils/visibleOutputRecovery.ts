export interface VisibleOutputRecoveryState {
  pending: boolean;
  retryCount: number;
  staleTerminal: boolean;
}

export type VisibleOutputRecoveryFailureDecision =
  | { action: 'retry'; state: VisibleOutputRecoveryState }
  | { action: 'abandon'; state: VisibleOutputRecoveryState };

export function createVisibleOutputRecoveryState(): VisibleOutputRecoveryState {
  return {
    pending: false,
    retryCount: 0,
    staleTerminal: false,
  };
}

export function beginVisibleOutputRecovery(state: VisibleOutputRecoveryState): {
  state: VisibleOutputRecoveryState;
  shouldSend: boolean;
} {
  if (state.pending || state.staleTerminal) {
    return { state, shouldSend: false };
  }

  return {
    state: {
      pending: true,
      retryCount: 0,
      staleTerminal: false,
    },
    shouldSend: true,
  };
}

export function recordVisibleOutputRecoverySendSuccess(state: VisibleOutputRecoveryState): VisibleOutputRecoveryState {
  if (!state.pending) {
    return state;
  }
  return {
    pending: true,
    retryCount: 0,
    staleTerminal: false,
  };
}

export function recordVisibleOutputRecoverySendFailure(
  state: VisibleOutputRecoveryState,
  maxRetries: number,
): VisibleOutputRecoveryFailureDecision {
  if (!state.pending) {
    return { action: 'abandon', state: createVisibleOutputRecoveryState() };
  }

  const retryCount = state.retryCount + 1;
  if (retryCount >= maxRetries) {
    return {
      action: 'abandon',
      state: {
        pending: false,
        retryCount: 0,
        staleTerminal: true,
      },
    };
  }

  return {
    action: 'retry',
    state: {
      pending: true,
      retryCount,
      staleTerminal: false,
    },
  };
}

export function finishVisibleOutputRecovery(
  state: VisibleOutputRecoveryState,
  options: { keepTerminalStale?: boolean } = {},
): VisibleOutputRecoveryState {
  if (!state.pending && !state.staleTerminal) {
    return state;
  }
  return {
    pending: false,
    retryCount: 0,
    staleTerminal: Boolean(options.keepTerminalStale),
  };
}

export function isVisibleOutputRecoveryBlocking(state: VisibleOutputRecoveryState): boolean {
  return state.pending || state.staleTerminal;
}

export function resolveVisibleOutputRecoveryBarrierReason(
  state: VisibleOutputRecoveryState,
): 'none' | 'visible-output-recovery' {
  return isVisibleOutputRecoveryBlocking(state) ? 'visible-output-recovery' : 'none';
}
