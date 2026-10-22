// The "화면의 파일" paths of an open terminal menu, as the server confirms them
// openable (FR-ARCH-013 AC-8). Until the check for this exact list answers, the
// list is empty and pending; a check for a menu that has since moved on is dropped.
// @req FR-ARCH-013

import { useEffect, useState } from 'react';
import { fileApi } from '../services/api';
import type { TerminalPathTarget } from '../utils/terminalPathDetection';
import { verifyScreenPaths } from '../utils/terminalPathVerification';

export interface VerifiedScreenPaths {
  screen: TerminalPathTarget[];
  pending: boolean;
}

export function useVerifiedScreenPaths(
  sessionId: string | null,
  screen: readonly TerminalPathTarget[] | null,
): VerifiedScreenPaths {
  const [result, setResult] = useState<{ source: readonly TerminalPathTarget[]; verified: TerminalPathTarget[] } | null>(null);

  useEffect(() => {
    if (sessionId === null || screen === null || screen.length === 0) return;
    let live = true;
    verifyScreenPaths(screen, (path) => fileApi.statPath(sessionId, path))
      .then((verified) => {
        if (live) setResult({ source: screen, verified });
      })
      .catch((error: unknown) => {
        console.warn('[terminal-path] screen path check failed', error);
        if (live) setResult({ source: screen, verified: [] });
      });
    return () => {
      live = false;
    };
  }, [sessionId, screen]);

  if (screen === null || screen.length === 0) return { screen: [], pending: false };
  if (result === null || result.source !== screen) return { screen: [], pending: true };
  return { screen: result.verified, pending: false };
}
