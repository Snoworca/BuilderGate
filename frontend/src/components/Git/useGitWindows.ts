/**
 * The app's Git windows: open/minimize/close with gitWindowModel, saved to
 * localStorage, and restored once the session list is known (ended sessions stay closed).
 *
 * @req FR-GIT-004
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GIT_WINDOWS_KEY, closeGitWindow, emptyGitWindows, focusGitWindow, minimizeGitWindow, openGitWindow,
  restoreGitWindows, serializeGitWindows, type GitOpenTarget, type GitWindowsState,
} from './gitWindowModel.ts';
import { gitSummaryStore } from './gitStores.ts';

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export interface UseGitWindowsInput {
  /** Live session ids; empty until the workspace state has loaded. */
  sessionIds: readonly string[];
  workspaceOf: (sessionId: string) => string | null;
}

export interface UseGitWindowsResult {
  state: GitWindowsState;
  open: (sessionId: string, target?: GitOpenTarget) => void;
  minimize: (sessionId: string) => void;
  close: (sessionId: string) => void;
  focus: (sessionId: string) => void;
}

export function useGitWindows({ sessionIds, workspaceOf }: UseGitWindowsInput): UseGitWindowsResult {
  const [state, setState] = useState<GitWindowsState>(emptyGitWindows);
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current || sessionIds.length === 0) return;
    restored.current = true;
    setState(restoreGitWindows(storage()?.getItem(GIT_WINDOWS_KEY) ?? null, new Set(sessionIds), Date.now()));
  }, [sessionIds]);

  useEffect(() => {
    if (!restored.current) return;
    try { storage()?.setItem(GIT_WINDOWS_KEY, serializeGitWindows(state)); } catch { /* a convenience */ }
  }, [state]);

  const open = useCallback((sessionId: string, target: GitOpenTarget = 'auto') => {
    const workspaceId = workspaceOf(sessionId);
    if (!workspaceId) return;
    const summary = gitSummaryStore().get(sessionId).summary;
    restored.current = true;
    setState((s) => openGitWindow(s, { sessionId, workspaceId, repoRoot: summary?.repo ? summary.root : null, target, now: Date.now() }).state);
  }, [workspaceOf]);
  const minimize = useCallback((sessionId: string) => setState((s) => minimizeGitWindow(s, sessionId)), []);
  const close = useCallback((sessionId: string) => setState((s) => closeGitWindow(s, sessionId)), []);
  const focus = useCallback((sessionId: string) => setState((s) => focusGitWindow(s, sessionId, Date.now())), []);
  return { state, open, minimize, close, focus };
}
