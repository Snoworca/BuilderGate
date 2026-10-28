// A tap on a phone sends a click whose ctrlKey is false, so the link provider's Ctrl+click
// never fires there. The key bar's Ctrl latch stands in for the held key: a tap with it on
// opens the path near the tap, as Ctrl+click does on a desktop.
import { mobileModifierLatch } from './mobileModifierLatch.ts';
import type { TerminalPathTarget } from './terminalPathDetection.ts';
import type { TerminalPathsAtPoint } from './terminalPathLinks.ts';

export interface LatchedTapPathOpenDeps {
  /** The paths at a client point (TerminalHandle.getPathsAt). */
  pathsAt(x: number, y: number): TerminalPathsAtPoint | null | undefined;
  /** Opens a path after the server check (requestTerminalPathOpen). */
  open(target: TerminalPathTarget): void;
  latch?: Pick<typeof mobileModifierLatch, 'getSnapshot' | 'consumeOnce'>;
}

/**
 * Opens the path near a tap when Ctrl is latched and spends a once latch. Returns true when it
 * opened a path, so the caller skips focusing the terminal. With Ctrl off, or no path near the
 * tap, it changes nothing and returns false.
 */
// @req FR-ARCH-013
export function openPathOnLatchedTap(x: number, y: number, deps: LatchedTapPathOpenDeps): boolean {
  const latch = deps.latch ?? mobileModifierLatch;
  if (latch.getSnapshot().ctrl === 'off') return false;
  const near = deps.pathsAt(x, y)?.near;
  if (!near) return false;
  deps.open(near);
  latch.consumeOnce();
  return true;
}
