/**
 * How often a session's git summary is asked for: by the fastest visible subscriber
 * (Git window or a running session: 3 s; otherwise 10 s), slower for slow
 * repositories (x5 of the last answer time, at most 30 s) and for answers that keep
 * coming back the same (10 in a row: 10 s). Nothing visible: no polling. A WSL session's
 * fast interval is 5 s (PERF-GIT-001 AC-2).
 *
 * @req FR-GIT-009
 * @req FR-GIT-011
 */

export interface GitDemand {
  visible: boolean;
  /** The session's tab.status is running (an agent or command is working). */
  running: boolean;
  mode: 'chip' | 'window' | 'menu';
  /** The session's shell is WSL: each git call also starts wsl.exe. */
  wsl?: boolean;
}

export interface PollState { lastDurationMs: number; sameCount: number }

export const FAST_MS = 3_000;
/** PERF-GIT-001 AC-2: one wsl.exe call measured over 250 ms (p50 359 ms), so WSL sessions poll every 5 s. */
export const WSL_FAST_MS = 5_000;
export const IDLE_MS = 10_000;
export const SLOW_CAP_MS = 30_000;

export function pollInterval(demands: readonly GitDemand[], state: PollState): number | null {
  const visible = demands.filter((d) => d.visible);
  if (!visible.length) return null;
  const fast = visible.some((d) => d.wsl) ? WSL_FAST_MS : FAST_MS;
  let ms = visible.some((d) => d.mode === 'window' || d.running) ? fast : IDLE_MS;
  if (state.lastDurationMs > 1_000) ms = Math.max(ms, Math.min(SLOW_CAP_MS, state.lastDurationMs * 5));
  if (state.sameCount >= 10) ms = Math.max(ms, IDLE_MS);
  return ms;
}
