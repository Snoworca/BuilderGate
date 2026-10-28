// "화면의 파일" lists path-like text from the screen; much of it names nothing
// openable (a file the agent only mentioned, a folder, a path from another
// tree). Each one goes through the same server check as opening it, before the
// menu lists it, so a pick never ends in "file not found" (FR-ARCH-013 AC-8).
// @req FR-ARCH-013

import type { PathStat } from '../types/index.ts';
import type { TerminalPathTarget } from './terminalPathDetection.ts';
import type { TerminalPathsAtPoint } from './terminalPathLinks.ts';
import { decideTerminalPathOpen } from './terminalPathOpen.ts';

/** FR-ARCH-013 AC-12: how long an open menu waits for the check before it gives up. */
export const MENU_PATH_CHECK_TIMEOUT_MS = 5000;

/** The targets an open would succeed on, in the order given. At most ten come from the screen. */
export async function verifyScreenPaths(
  targets: readonly TerminalPathTarget[],
  stat: (path: string) => Promise<PathStat>,
): Promise<TerminalPathTarget[]> {
  const decisions = await Promise.all(targets.map((target) => decideTerminalPathOpen(target, stat)));
  return targets.filter((_, index) => decisions[index].kind === 'open');
}

/**
 * The menu's paths as the server confirms them: the one near the press (AC-9) and the screen
 * list (AC-8). The near path is usually on the screen list too, so each path is asked once.
 * A check that has not answered within `timeoutMs` ends with the paths unchecked (AC-12): the
 * menu stops showing '확인 중…', and a pick still runs the open check.
 */
// @req FR-ARCH-013
export async function checkMenuPaths(
  paths: TerminalPathsAtPoint,
  stat: (path: string) => Promise<PathStat>,
  timeoutMs: number = MENU_PATH_CHECK_TIMEOUT_MS,
): Promise<{ near: TerminalPathTarget | null; screen: TerminalPathTarget[] }> {
  const near = paths.near;
  const targets = near !== null && !paths.screen.some((target) => target.path === near.path)
    ? [near, ...paths.screen]
    : paths.screen;
  const checked = verifyScreenPaths(targets, stat).then((verified) => {
    const openable = new Set(verified.map((target) => target.path));
    return {
      near: near !== null && openable.has(near.path) ? near : null,
      screen: paths.screen.filter((target) => openable.has(target.path)),
    };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ near: TerminalPathTarget | null; screen: TerminalPathTarget[] }>((resolve) => {
    timer = setTimeout(() => resolve({ near, screen: [...paths.screen] }), timeoutMs);
  });
  try {
    return await Promise.race([checked, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
