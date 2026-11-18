import { isAgentChoicePrompt, isChoiceAnsweringInput, showsAgentPromptOrWork } from '../utils/agentChoicePrompt.js';

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
 * max wait); nothing polls. Once set, the mark stays until a read shows the agent
 * moved on (AC-6) or the session ends: an answering key only arms a read (AC-3), so
 * a form of several questions keeps it between them and a scrolled menu keeps it.
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
    if (!entry || !entry.awaiting || !isChoiceAnsweringInput(data)) return;
    // AC-3: an answer does not clear the mark by itself. A form of several questions
    // goes on to the next one, and the screen read after the agent's reply decides:
    // another menu keeps the mark, the agent shown moved on clears it (AC-6). A read
    // already in flight saw the old menu, so the key arms a fresh one after it.
    entry.generation += 1;
    this.noteOutput(sessionId);
  }

  isAwaiting(sessionId: string): boolean {
    return this.entries.get(sessionId)?.awaiting ?? false;
  }

  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer !== null) this.clearTimer(entry.timer);
    this.entries.delete(sessionId);
    // A session that dies on a menu would otherwise leave its tab marked.
    if (entry.awaiting) this.options.onChange(sessionId, false);
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
    if (this.entries.get(sessionId) !== entry) return;
    // A read that started before an answer saw the menu as it was: it may keep the
    // mark but must not decide anything new; the read the answer armed does that.
    if (entry.generation !== generation) return;
    const waiting = screen !== null && isAgentChoicePrompt(screen);
    // AC-6: a menu scrolled out of view is still unanswered. Once marked, a screen
    // that shows no menu clears the mark only when it shows the agent moved on.
    if (!waiting && entry.awaiting && screen !== null && !showsAgentPromptOrWork(screen)) return;
    this.set(sessionId, entry, waiting);
  }

  private set(sessionId: string, entry: Entry, awaiting: boolean): void {
    if (entry.awaiting === awaiting) return;
    entry.awaiting = awaiting;
    this.options.onChange(sessionId, awaiting);
  }
}
