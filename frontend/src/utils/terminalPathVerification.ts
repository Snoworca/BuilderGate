// "화면의 파일" lists path-like text from the screen; much of it names nothing
// openable (a file the agent only mentioned, a folder, a path from another
// tree). Each one goes through the same server check as opening it, before the
// menu lists it, so a pick never ends in "file not found" (FR-ARCH-013 AC-8).
// @req FR-ARCH-013

import type { PathStat } from '../types/index.ts';
import type { TerminalPathTarget } from './terminalPathDetection.ts';
import { decideTerminalPathOpen } from './terminalPathOpen.ts';

/** The targets an open would succeed on, in the order given. At most ten come from the screen. */
export async function verifyScreenPaths(
  targets: readonly TerminalPathTarget[],
  stat: (path: string) => Promise<PathStat>,
): Promise<TerminalPathTarget[]> {
  const decisions = await Promise.all(targets.map((target) => decideTerminalPathOpen(target, stat)));
  return targets.filter((_, index) => decisions[index].kind === 'open');
}
