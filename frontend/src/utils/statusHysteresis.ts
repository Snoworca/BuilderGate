/**
 * REL-BGSTAB-035: display-only hysteresis for the session "running" badge.
 *
 * AI TUIs (Claude Code with subagents especially) work in bursts, so the server's
 * running/idle verdict can flip every second or two and the badge pulses like a heartbeat.
 * Running is shown at once; a running -> idle change waits RUNNING_RELEASE_HOLD_MS and is
 * dropped if running comes back first. The server verdict itself is untouched, so agent
 * orchestration keeps its own timing.
 */

export const RUNNING_RELEASE_HOLD_MS = 3500;

export type TabStatus = 'running' | 'idle' | 'disconnected';

export interface StatusHysteresisTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const defaultTimers: StatusHysteresisTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createStatusHysteresis(
  apply: (sessionId: string, status: TabStatus) => void,
  timers: StatusHysteresisTimers = defaultTimers,
  holdMs: number = RUNNING_RELEASE_HOLD_MS,
) {
  const shown = new Map<string, TabStatus>();
  const pending = new Map<string, unknown>();

  const cancel = (id: string) => {
    const handle = pending.get(id);
    if (handle !== undefined) {
      timers.clearTimer(handle);
      pending.delete(id);
    }
  };

  const commit = (id: string, status: TabStatus) => {
    shown.set(id, status);
    apply(id, status);
  };

  return {
    update(id: string, status: TabStatus): void {
      if (status === 'idle' && shown.get(id) === 'running') {
        if (!pending.has(id)) {
          pending.set(id, timers.setTimer(() => {
            pending.delete(id);
            commit(id, 'idle');
          }, holdMs));
        }
        return;
      }
      cancel(id);
      if (shown.get(id) !== status) commit(id, status);
    },
    dispose(): void {
      for (const id of [...pending.keys()]) cancel(id);
    },
  };
}
