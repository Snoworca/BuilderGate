/**
 * Redraws several terminals one after another (REL-BGSTAB-053).
 *
 * A redraw resizes the PTY one row smaller and back, so the program inside paints its whole
 * screen. Doing that for every pane of a grid at once is a burst of full-screen output; one
 * terminal every 100 ms spreads it out. A new request replaces whatever is left of the last one,
 * and a delayed request (after a workspace or tab switch) reads its targets when it comes due,
 * so it redraws what is on screen then.
 *
 * REL-BGSTAB-058: a delayed request after a tab switch may ask to resize only when another
 * screen or device resized the PTY meanwhile; every other request always resizes.
 */
import type { RedrawNudgePolicy } from '../components/Terminal/terminalRedrawNudge';

export interface RedrawTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface TerminalRedrawScheduler {
  /** Redraws these terminals now, the first at once and each next one `gapMs` later. */
  redraw(tabIds: readonly string[]): void;
  /** Redraws the terminals `targets()` names once `delayMs` has passed. */
  redrawAfter(delayMs: number, targets: () => readonly string[], nudge?: RedrawNudgePolicy): void;
  cancel(): void;
}

export const REDRAW_GAP_MS = 100;

const browserTimers: RedrawTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function createTerminalRedrawScheduler(options: {
  run: (tabId: string, nudge: RedrawNudgePolicy) => void;
  timers?: RedrawTimers;
  gapMs?: number;
}): TerminalRedrawScheduler {
  const timers = options.timers ?? browserTimers;
  const gapMs = options.gapMs ?? REDRAW_GAP_MS;
  let timer: unknown = null;

  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const runFrom = (tabIds: readonly string[], index: number, nudge: RedrawNudgePolicy) => {
    timer = null;
    if (index >= tabIds.length) return;
    options.run(tabIds[index], nudge);
    if (index + 1 < tabIds.length) timer = timers.setTimeout(() => runFrom(tabIds, index + 1, nudge), gapMs);
  };

  return {
    redraw(tabIds) {
      cancel();
      runFrom([...tabIds], 0, 'always');
    },
    redrawAfter(delayMs, targets, nudge = 'always') {
      cancel();
      timer = timers.setTimeout(() => runFrom([...targets()], 0, nudge), delayMs);
    },
    cancel,
  };
}

/**
 * Which terminals a redraw covers: in the grid every terminal of the workspace (the one asked
 * for first), in the tab view only the one asked for.
 */
export function redrawTargetTabIds(input: {
  viewMode: 'grid' | 'tab';
  tabs: readonly { id: string }[];
  tabId: string | null;
}): string[] {
  if (input.viewMode === 'tab') return input.tabId ? [input.tabId] : [];
  const others = input.tabs.map((tab) => tab.id).filter((id) => id !== input.tabId);
  return input.tabId && input.tabs.some((tab) => tab.id === input.tabId) ? [input.tabId, ...others] : others;
}

/**
 * A move from one tab to another tab that both existed before and after (REL-BGSTAB-053 AC-4).
 * Creating a tab or closing the shown one also changes the active tab, but is not a switch.
 */
export function isTabSwitch(input: {
  previousTabId: string | null;
  tabId: string | null;
  previousTabIds: readonly string[];
  tabIds: readonly string[];
}): boolean {
  const { previousTabId, tabId } = input;
  if (!previousTabId || !tabId || previousTabId === tabId) return false;
  return input.tabIds.includes(previousTabId) && input.previousTabIds.includes(tabId);
}
