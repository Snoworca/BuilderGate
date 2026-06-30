export type HiddenOutputPolicy = 'write-hidden' | 'snapshot-restore' | 'debug-tail';

export interface HiddenOutputState {
  skipped: boolean;
  skippedBytes: number;
  debugTail: string;
}

export interface HiddenOutputDecision {
  action: 'write' | 'skip';
  nextState: HiddenOutputState;
}

export interface HiddenOutputReplayState {
  pending: boolean;
  restoreBarrierOwned: boolean;
}

export interface HiddenOutputReplayTransition {
  replayState: HiddenOutputReplayState;
  initialRestorePending: boolean;
}

export function createHiddenOutputState(): HiddenOutputState {
  return {
    skipped: false,
    skippedBytes: 0,
    debugTail: '',
  };
}

export function createHiddenOutputReplayState(): HiddenOutputReplayState {
  return {
    pending: false,
    restoreBarrierOwned: false,
  };
}

export function resolveHiddenOutput(
  state: HiddenOutputState,
  input: {
    isVisible: boolean;
    byteLength: number;
    data?: string;
    hiddenOutputPolicy?: HiddenOutputPolicy;
    hiddenOutputTailBytes?: number;
  },
): HiddenOutputDecision {
  const hiddenOutputPolicy = input.hiddenOutputPolicy ?? 'snapshot-restore';

  if (hiddenOutputPolicy === 'write-hidden') {
    return {
      action: 'write',
      nextState: state,
    };
  }

  if (input.isVisible && !state.skipped) {
    return {
      action: 'write',
      nextState: state,
    };
  }

  return {
    action: 'skip',
    nextState: {
      skipped: true,
      skippedBytes: state.skippedBytes + Math.max(0, input.byteLength),
      debugTail: appendDebugTail(
        state.debugTail,
        input.data ?? '',
        hiddenOutputPolicy === 'debug-tail' ? input.hiddenOutputTailBytes ?? 0 : 0,
      ),
    },
  };
}

export function beginHiddenOutputReplay(
  state: HiddenOutputReplayState,
  initialRestorePending: boolean,
): HiddenOutputReplayTransition {
  if (state.pending) {
    return {
      replayState: state,
      initialRestorePending,
    };
  }

  return {
    replayState: {
      pending: true,
      restoreBarrierOwned: !initialRestorePending,
    },
    initialRestorePending: true,
  };
}

export function finishHiddenOutputReplay(
  state: HiddenOutputReplayState,
  initialRestorePending: boolean,
): HiddenOutputReplayTransition {
  return {
    replayState: createHiddenOutputReplayState(),
    initialRestorePending: state.restoreBarrierOwned ? false : initialRestorePending,
  };
}

export function shouldClearHiddenOutputAfterSnapshotRecovery(input: {
  snapshotMode: 'authoritative' | 'fallback';
  fallbackDataLength: number;
  localRestoreSucceeded: boolean;
}): boolean {
  if (input.snapshotMode === 'authoritative') {
    return true;
  }
  if (input.fallbackDataLength > 0) {
    return true;
  }
  return input.localRestoreSucceeded;
}

export function clearHiddenOutputState(state: HiddenOutputState): HiddenOutputState {
  if (!state.skipped && state.skippedBytes === 0 && state.debugTail.length === 0) {
    return state;
  }

  return createHiddenOutputState();
}

function appendDebugTail(current: string, next: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  const merged = `${current}${next}`;
  if (getUtf8ByteLength(merged) <= maxBytes) {
    return merged;
  }

  let tail = '';
  let byteLength = 0;
  for (const char of Array.from(merged).reverse()) {
    const charBytes = getUtf8ByteLength(char);
    if (byteLength + charBytes > maxBytes) {
      break;
    }
    tail = `${char}${tail}`;
    byteLength += charBytes;
  }
  return tail;
}

function getUtf8ByteLength(raw: string): number {
  return new TextEncoder().encode(raw).length;
}
