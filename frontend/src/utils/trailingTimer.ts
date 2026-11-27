// Runs an action once activity has stopped for `delayMs`, with at most one armed timer.
//
// A debounce that clears and re-arms a timer on every touch costs two timer operations per
// output write; with many terminals writing, that churn showed up in the main-thread profile
// (#262). Here a touch only records the time. The single timer, when it fires early, re-arms
// itself for the time that is still left.
// @req PERF-BGSTAB-028

export interface TrailingTimer {
  touch(): void;
  cancel(): void;
}

export interface TrailingTimerOptions {
  delayMs: number;
  onIdle: () => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createTrailingTimer(options: TrailingTimerOptions): TrailingTimer {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let lastTouch = 0;
  let handle: unknown = null;

  const arm = (ms: number): void => {
    handle = setTimer(() => {
      const remaining = options.delayMs - (now() - lastTouch);
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      handle = null;
      options.onIdle();
    }, ms);
  };

  return {
    touch() {
      lastTouch = now();
      if (handle === null) arm(options.delayMs);
    },
    cancel() {
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
  };
}
