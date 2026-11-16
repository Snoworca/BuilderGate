import { isAgentChoicePrompt, isChoiceAnsweringInput } from '../utils/agentChoicePrompt.js';

/** FR-AITUI-024 AC-2: quiet time after the last output before the screen is read. */
export const AWAITING_INPUT_SETTLE_MS = 250;
/** FR-AITUI-024 AC-2: longest a read is put off while the output keeps coming. */
export const AWAITING_INPUT_MAX_WAIT_MS = 1500;

type TimerHandle = unknown;

export interface AgentAwaitingInputTrackerOptions {
  /** The bottom rows of the session's screen, or null when it has none. */
  readScreen(sessionId: string): Promise<string | null> | string | null;
  /** Called only when a session's answer flips. */
  onChange(sessionId: string, awaiting: boolean): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

interface Entry {
  timer: TimerHandle | null;
  scheduledAt: number;
  lastOutputAt: number;
  awaiting: boolean;
  /** Bumped by an answering key, so a read already in flight cannot set the mark again. */
  generation: number;
}

/**
 * FR-AITUI-024: whether each session's agent waits on a choice prompt. Output
 * schedules one read of the screen once it settles (or at the latest after the
 * max wait); nothing polls. An answering key clears the mark at once; moving
 * through the menu leaves it to the next read.
 */
export class AgentAwaitingInputTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(private readonly options: AgentAwaitingInputTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  noteOutput(sessionId: string): void {
    const entry = this.entry(sessionId);
    const now = this.now();
    entry.lastOutputAt = now;
    if (entry.timer !== null) return;
    entry.scheduledAt = now;
    entry.timer = this.setTimer(() => this.fire(sessionId), AWAITING_INPUT_SETTLE_MS);
  }

  noteInput(sessionId: string, data: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || !isChoiceAnsweringInput(data)) return;
    entry.generation += 1;
    this.set(sessionId, entry, false);
  }

  isAwaiting(sessionId: string): boolean {
    return this.entries.get(sessionId)?.awaiting ?? false;
  }

  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer !== null) this.clearTimer(entry.timer);
    this.entries.delete(sessionId);
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { timer: null, scheduledAt: 0, lastOutputAt: 0, awaiting: false, generation: 0 };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private fire(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.timer = null;
    const now = this.now();
    const quietFor = now - entry.lastOutputAt;
    if (quietFor < AWAITING_INPUT_SETTLE_MS && now - entry.scheduledAt < AWAITING_INPUT_MAX_WAIT_MS) {
      const wait = Math.min(AWAITING_INPUT_SETTLE_MS - quietFor, AWAITING_INPUT_MAX_WAIT_MS - (now - entry.scheduledAt));
      entry.timer = this.setTimer(() => this.fire(sessionId), wait);
      return;
    }
    void this.evaluate(sessionId, entry);
  }

  private async evaluate(sessionId: string, entry: Entry): Promise<void> {
    const generation = entry.generation;
    let screen: string | null = null;
    try {
      screen = await this.options.readScreen(sessionId);
    } catch {
      screen = null;
    }
    if (this.entries.get(sessionId) !== entry || entry.generation !== generation) return;
    this.set(sessionId, entry, screen !== null && isAgentChoicePrompt(screen));
  }

  private set(sessionId: string, entry: Entry, awaiting: boolean): void {
    if (entry.awaiting === awaiting) return;
    entry.awaiting = awaiting;
    this.options.onChange(sessionId, awaiting);
  }
}
