// A page-wide throttle for terminal output flushes.
//
// Every flush writes to xterm, and xterm renders on the next frame. With several terminals
// visible, rendering took most of the main thread (#262), which delays the timers and input
// the user is waiting on. The terminal the user works in keeps rendering every frame; other
// visible terminals render at most once every BACKGROUND_RENDER_INTERVAL_MS, and while an IME
// composition is in progress at most once every COMPOSITION_RENDER_HOLD_MAX_MS.
//
// The output scheduler writes one message per flush and asks for the next flush from xterm's
// write callback, so a lane that waited for every flush would fall behind its input. Each time a
// background lane is let through, the flushes it asks for in the next BACKGROUND_BURST_MS run at
// once, one after another, instead of waiting: the backlog is written in one burst and xterm
// still renders it once per frame.
// @req PERF-BGSTAB-027
//
// The foreground lane does not wait for an animation frame. xterm renders a write made inside a
// frame callback on the following frame, so waiting cost an echo about two frames. Its flushes
// run from a microtask as output arrives, and xterm draws them on the very next frame.
//
// Each foreground run takes one from an allowance of FOREGROUND_RUN_BURST runs that refills by
// one every FOREGROUND_RUN_REFILL_MS. A shell echo (two frames a few milliseconds apart) fits in
// the allowance. A flood uses it up at once and then gets one run per animation frame, which is
// the pace it had before. A flush asked for from inside a drain is the output scheduler
// yielding to pending input, so it always waits for the frame.
// @req PERF-BGSTAB-030

export const FOREGROUND_RUN_BURST = 3;
export const FOREGROUND_RUN_REFILL_MS = 16;
export const BACKGROUND_RENDER_INTERVAL_MS = 200;
export const COMPOSITION_RENDER_HOLD_MAX_MS = 1_000;
export const BACKGROUND_BURST_MS = 50;

export interface TerminalRenderLane {
  setVisible(visible: boolean): void;
  /** Runs `drain` when this terminal may render; a later call replaces a pending one. */
  schedule(drain: () => void): void;
  dispose(): void;
}

export interface TerminalRenderThrottle {
  register(terminalId: string): TerminalRenderLane;
  /** The terminal that last received input focus becomes the foreground. */
  noteFocus(terminalId: string): void;
  /** Per terminal, so one terminal ending a composition does not end another one's. */
  setComposing(terminalId: string, composing: boolean): void;
}

export interface TerminalRenderThrottleOptions {
  now?: () => number;
  queueMicrotask?: (run: () => void) => void;
  requestFrame?: (run: () => void) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface LaneState {
  id: string;
  visible: boolean;
  disposed: boolean;
  lastRun: number;
  burstUntil: number;
  pending: (() => void) | null;
  timer: unknown;
  frameRequested: boolean;
  // PERF-BGSTAB-030: the foreground run allowance, and whether a drain is running right now.
  microtaskQueued: boolean;
  running: boolean;
  runAllowance: number;
  allowanceAt: number;
}

export function createTerminalRenderThrottle(options: TerminalRenderThrottleOptions = {}): TerminalRenderThrottle {
  const now = options.now ?? (() => performance.now());
  const enqueueMicrotask = options.queueMicrotask ?? ((run) => queueMicrotask(run));
  const requestFrame = options.requestFrame ?? ((run) => { requestAnimationFrame(() => run()); });
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const lanes = new Set<LaneState>();
  let focusedId: string | null = null;
  // Terminal id -> when its composition started.
  const compositions = new Map<string, number>();
  const compositionStartedAt = (): number => Math.min(...compositions.values());

  const visibleCount = (): number => {
    let count = 0;
    for (const lane of lanes) if (lane.visible && !lane.disposed) count += 1;
    return count;
  };
  const isForeground = (lane: LaneState): boolean => lane.id === focusedId || (lane.visible && visibleCount() <= 1);

  const cancelTimer = (lane: LaneState): void => {
    if (lane.timer !== null) clearTimer(lane.timer);
    lane.timer = null;
  };

  // `startsBurst` is false for the rest of a burst, so a late continuation cannot open another.
  const run = (lane: LaneState, startsBurst: boolean): void => {
    lane.frameRequested = false;
    if (lane.disposed || !lane.pending) return;
    const drain = lane.pending;
    lane.pending = null;
    cancelTimer(lane);
    const at = now();
    lane.lastRun = at;
    if (startsBurst) lane.burstUntil = at + BACKGROUND_BURST_MS;
    lane.running = true;
    try {
      drain();
    } finally {
      lane.running = false;
    }
  };

  // @req PERF-BGSTAB-030
  const takeForegroundRun = (lane: LaneState): boolean => {
    const at = now();
    lane.runAllowance = Math.min(FOREGROUND_RUN_BURST, lane.runAllowance + (at - lane.allowanceAt) / FOREGROUND_RUN_REFILL_MS);
    lane.allowanceAt = at;
    if (lane.runAllowance < 1) return false;
    lane.runAllowance -= 1;
    return true;
  };

  const runOnNextFrame = (lane: LaneState): void => {
    cancelTimer(lane);
    if (lane.frameRequested) return;
    lane.frameRequested = true;
    requestFrame(() => {
      // A frame that comes before a foreground run is due (a fast display) waits for the next.
      if (!lane.disposed && lane.pending && isForeground(lane) && !takeForegroundRun(lane)) {
        lane.frameRequested = false;
        runOnNextFrame(lane);
        return;
      }
      run(lane, true);
    });
  };

  // @req PERF-BGSTAB-030
  const runFromMicrotask = (lane: LaneState): void => {
    cancelTimer(lane);
    if (lane.microtaskQueued) return;
    lane.microtaskQueued = true;
    enqueueMicrotask(() => {
      lane.microtaskQueued = false;
      if (lane.disposed || !lane.pending) return;
      if (!isForeground(lane)) {
        // Focus or visibility moved on in the same task: give the run back and decide again.
        lane.runAllowance = Math.min(FOREGROUND_RUN_BURST, lane.runAllowance + 1);
        decide(lane);
        return;
      }
      run(lane, true);
    });
  };

  const decide = (lane: LaneState): void => {
    if (lane.disposed || !lane.pending) return;
    if (isForeground(lane)) {
      // A frame or microtask already asked for takes the pending flush.
      if (lane.frameRequested || lane.microtaskQueued) return;
      if (!lane.running && takeForegroundRun(lane)) {
        runFromMicrotask(lane);
        return;
      }
      runOnNextFrame(lane);
      return;
    }
    if (lane.timer !== null || lane.frameRequested) return;
    if (now() <= lane.burstUntil) {
      // The rest of a burst: write it now, xterm renders it on its next frame.
      lane.timer = setTimer(() => { lane.timer = null; run(lane, false); }, 0);
      return;
    }
    if (compositions.size > 0) {
      const since = Math.max(compositionStartedAt(), lane.lastRun);
      const wait = Math.max(0, since + COMPOSITION_RENDER_HOLD_MAX_MS - now());
      lane.timer = setTimer(() => { lane.timer = null; runOnNextFrame(lane); }, wait);
      return;
    }
    const wait = lane.lastRun + BACKGROUND_RENDER_INTERVAL_MS - now();
    if (wait <= 0) {
      runOnNextFrame(lane);
      return;
    }
    lane.timer = setTimer(() => { lane.timer = null; decide(lane); }, wait);
  };

  const reconsiderAll = (): void => {
    for (const lane of lanes) {
      if (!lane.pending) continue;
      cancelTimer(lane);
      decide(lane);
    }
  };

  return {
    register(terminalId) {
      const lane: LaneState = {
        id: terminalId, visible: false, disposed: false, lastRun: Number.NEGATIVE_INFINITY,
        burstUntil: Number.NEGATIVE_INFINITY, pending: null, timer: null, frameRequested: false,
        microtaskQueued: false, running: false, runAllowance: FOREGROUND_RUN_BURST, allowanceAt: now(),
      };
      lanes.add(lane);
      return {
        setVisible(visible) {
          if (lane.visible === visible) return;
          lane.visible = visible;
          reconsiderAll();
        },
        schedule(drain) {
          lane.pending = drain;
          decide(lane);
        },
        dispose() {
          lane.disposed = true;
          lane.pending = null;
          cancelTimer(lane);
          lanes.delete(lane);
          // The focus stays: a terminal whose runtime is rebuilt registers again under its id.
          compositions.delete(lane.id);
          reconsiderAll();
        },
      };
    },
    noteFocus(terminalId) {
      if (focusedId === terminalId) return;
      focusedId = terminalId;
      reconsiderAll();
    },
    setComposing(terminalId, next) {
      if (compositions.has(terminalId) === next) return;
      if (next) compositions.set(terminalId, now());
      else compositions.delete(terminalId);
      reconsiderAll();
    },
  };
}

/** The page-wide throttle every terminal shares. */
export const terminalRenderThrottle = createTerminalRenderThrottle();
