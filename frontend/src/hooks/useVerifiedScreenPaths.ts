// The paths of an open terminal menu, as the server confirms them openable: the
// one near the press (FR-ARCH-013 AC-9) and the "화면의 파일" list (AC-8). Until
// the check for this exact menu answers, the near path is shown pending and the
// list is empty and pending; a check for a menu that has since moved on is dropped.
// @req FR-ARCH-013

import { useEffect, useState } from 'react';
import { fileApi } from '../services/api';
import type { TerminalPathTarget } from '../utils/terminalPathDetection';
import type { TerminalPathsAtPoint } from '../utils/terminalPathLinks';
import { checkMenuPaths } from '../utils/terminalPathVerification';

export interface VerifiedTerminalPaths {
  near: TerminalPathTarget | null;
  nearPending: boolean;
  screen: TerminalPathTarget[];
  pending: boolean;
}

interface Checked {
  source: TerminalPathsAtPoint;
  near: TerminalPathTarget | null;
  screen: TerminalPathTarget[];
}

export function useVerifiedScreenPaths(
  sessionId: string | null,
  paths: TerminalPathsAtPoint | null,
): VerifiedTerminalPaths {
  const [checked, setChecked] = useState<Checked | null>(null);
  const hasAny = paths !== null && (paths.near !== null || paths.screen.length > 0);

  useEffect(() => {
    if (sessionId === null || paths === null || !hasAny) return;
    let live = true;
    const stat = (path: string) => fileApi.statPath(sessionId, path);
    // AC-12: the check ends after MENU_PATH_CHECK_TIMEOUT_MS even when the server never answers.
    checkMenuPaths(paths, stat)
      .then((result) => {
        if (live) setChecked({ source: paths, ...result });
      })
      .catch((error: unknown) => {
        console.warn('[terminal-path] menu path check failed', error);
        if (live) setChecked({ source: paths, near: null, screen: [] });
      });
    return () => {
      live = false;
    };
  }, [sessionId, paths, hasAny]);

  if (paths === null || !hasAny) return { near: null, nearPending: false, screen: [], pending: false };
  if (checked === null || checked.source !== paths) {
    return { near: paths.near, nearPending: paths.near !== null, screen: [], pending: paths.screen.length > 0 };
  }
  return { near: checked.near, nearPending: false, screen: checked.screen, pending: false };
}
