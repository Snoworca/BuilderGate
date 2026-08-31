export interface TerminalReplayWriteLease {
  release: () => void;
}

export const TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS = 2_000;

export interface TerminalReplayInputGuard {
  beginReplayWrite: () => TerminalReplayWriteLease;
  shouldSuppressXtermData: (provenance?: 'parser-generated' | 'user-input') => boolean;
  reset: () => void;
}

export interface TerminalReplayFifoWriteOptions {
  data: string;
  guard: TerminalReplayInputGuard;
  write: (data: string, onWritten: () => void) => void;
  isCurrent: () => boolean;
  timeoutMs: number;
  existingLease?: TerminalReplayWriteLease;
}

/**
 * Suppresses xterm query replies generated while retained terminal state is
 * replayed into the parser. Leases are generation-bound so late write
 * callbacks from a disposed or replaced terminal cannot affect a new view.
 */
// @req REL-BGSTAB-009
export function createTerminalReplayInputGuard(): TerminalReplayInputGuard {
  let generation = 0;
  let nextLeaseId = 0;
  const activeLeaseIds = new Set<number>();

  return {
    beginReplayWrite() {
      const leaseGeneration = generation;
      const leaseId = ++nextLeaseId;
      let released = false;
      activeLeaseIds.add(leaseId);
      return {
        release() {
          if (released) return;
          released = true;
          if (leaseGeneration !== generation) return;
          activeLeaseIds.delete(leaseId);
        },
      };
    },
    shouldSuppressXtermData(provenance = 'parser-generated') {
      return provenance === 'parser-generated' && activeLeaseIds.size > 0;
    },
    reset() {
      generation += 1;
      activeLeaseIds.clear();
    },
  };
}

/**
 * Writes retained state directly to xterm's parser lane. A missing primary
 * callback is followed by an empty write on that same xterm FIFO; only the
 * probe callback proves completion. Both waits are bounded and every terminal
 * path releases exactly the lease that this write acquired.
 */
// @req REL-BGSTAB-009
export function writeTerminalReplayWithFifoProbe(
  options: TerminalReplayFifoWriteOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    const replayLease = options.existingLease ?? options.guard.beginReplayWrite();
    let settled = false;
    let callbackTimeout: ReturnType<typeof setTimeout> | null = null;
    let probeTimeout: ReturnType<typeof setTimeout> | null = null;

    const settle = (written: boolean): void => {
      if (settled) return;
      settled = true;
      if (callbackTimeout) clearTimeout(callbackTimeout);
      if (probeTimeout) clearTimeout(probeTimeout);
      replayLease.release();
      resolve(written && options.isCurrent());
    };

    const enqueueFifoProbe = (): void => {
      if (settled) return;
      try {
        options.write('', () => settle(true));
        const nextProbeTimeout = setTimeout(() => settle(false), options.timeoutMs);
        if (settled) {
          clearTimeout(nextProbeTimeout);
        } else {
          probeTimeout = nextProbeTimeout;
        }
      } catch {
        settle(false);
      }
    };

    callbackTimeout = setTimeout(enqueueFifoProbe, options.timeoutMs);
    try {
      options.write(options.data, () => settle(true));
    } catch {
      settle(false);
    }
  });
}
