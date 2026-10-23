/**
 * One git summary poll per session, shared by every chip, path menu and Git window
 * that shows it. Subscribers declare what they need (visible, running, mode); the
 * store polls at the fastest needed rate and stops when nothing visible needs it.
 * A change of the session's status or cwd asks again at once.
 *
 * @req FR-GIT-009
 * @req FR-GIT-011
 */

import { pollInterval, type GitDemand } from './gitPollPolicy.ts';
import { GitApiError, type GitSummary } from './gitApi.ts';

export interface GitSummaryState {
  summary: GitSummary | null;
  /** Server error code of the last request, if it failed. */
  error: string | null;
  /** The shown summary is older than the last request (that request failed). */
  stale: boolean;
  loading: boolean;
}

export interface GitSummaryStoreDeps {
  fetchSummary: (sessionId: string, signal: AbortSignal) => Promise<GitSummary>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface GitSummarySubscription {
  update(demand: GitDemand): void;
  unsubscribe(): void;
}

export interface GitSummaryStore {
  subscribe(sessionId: string, demand: GitDemand, listener: () => void): GitSummarySubscription;
  get(sessionId: string): GitSummaryState;
  /** The session's tab status or cwd as the client sees them now. */
  notify(sessionId: string, seen: { status?: string; cwd?: string | null }): void;
  refresh(sessionId: string): void;
}

interface Entry {
  subs: Map<number, { demand: GitDemand; listener: () => void }>;
  state: GitSummaryState;
  timer: unknown;
  controller: AbortController | null;
  lastFetchAt: number;
  lastDurationMs: number;
  sameCount: number;
  lastJson: string;
  seenStatus?: string;
  seenCwd?: string | null;
}

const EMPTY: GitSummaryState = { summary: null, error: null, stale: false, loading: false };
const comparable = (s: GitSummary) => JSON.stringify({ ...s, checkedAt: 0 });

export function createGitSummaryStore(deps: GitSummaryStoreDeps): GitSummaryStore {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();
  let nextSub = 1;

  const entryFor = (id: string): Entry => {
    let e = entries.get(id);
    if (!e) {
      e = { subs: new Map(), state: EMPTY, timer: null, controller: null, lastFetchAt: -Infinity, lastDurationMs: 0, sameCount: 0, lastJson: '' };
      entries.set(id, e);
    }
    return e;
  };
  const emit = (e: Entry) => { for (const s of [...e.subs.values()]) s.listener(); };
  const interval = (e: Entry) => pollInterval([...e.subs.values()].map((s) => s.demand), e);
  const stopTimer = (e: Entry) => { if (e.timer !== null) { clearTimer(e.timer); e.timer = null; } };

  const schedule = (id: string, e: Entry) => {
    stopTimer(e);
    const ms = interval(e);
    if (ms === null) {
      e.controller?.abort();
      e.controller = null;
      return;
    }
    if (e.controller) return;
    const delay = Math.max(0, e.lastFetchAt + ms - now());
    if (delay === 0) { void fetchNow(id, e); return; }
    e.timer = setTimer(() => { e.timer = null; void fetchNow(id, e); }, delay);
  };

  const fetchNow = async (id: string, e: Entry) => {
    if (e.controller || interval(e) === null) return;
    stopTimer(e);
    const controller = new AbortController();
    e.controller = controller;
    const started = now();
    e.state = { ...e.state, loading: true };
    emit(e);
    try {
      const summary = await deps.fetchSummary(id, controller.signal);
      if (controller.signal.aborted) return;
      const json = comparable(summary);
      e.sameCount = json === e.lastJson ? e.sameCount + 1 : 0;
      e.lastJson = json;
      e.state = { summary, error: null, stale: false, loading: false };
    } catch (err) {
      if (controller.signal.aborted) return;
      const code = err instanceof GitApiError ? err.code : 'GIT_FAILED';
      e.state = { summary: e.state.summary, error: code, stale: e.state.summary !== null, loading: false };
    } finally {
      if (e.controller === controller) {
        e.controller = null;
        e.lastFetchAt = now();
        e.lastDurationMs = e.lastFetchAt - started;
      }
    }
    emit(e);
    if (entries.get(id) === e) schedule(id, e);
  };

  return {
    subscribe(id, demand, listener) {
      const e = entryFor(id);
      const key = nextSub++;
      e.subs.set(key, { demand, listener });
      schedule(id, e);
      return {
        update(next) {
          const sub = e.subs.get(key);
          if (!sub) return;
          sub.demand = next;
          schedule(id, e);
        },
        unsubscribe() {
          e.subs.delete(key);
          if (!e.subs.size) {
            stopTimer(e);
            e.controller?.abort();
            e.controller = null;
            entries.delete(id);
          } else schedule(id, e);
        },
      };
    },
    get(id) {
      return entries.get(id)?.state ?? EMPTY;
    },
    notify(id, seen) {
      const e = entries.get(id);
      if (!e) return;
      const changed = (seen.status !== undefined && seen.status !== e.seenStatus) || (seen.cwd !== undefined && seen.cwd !== e.seenCwd);
      if (seen.status !== undefined) e.seenStatus = seen.status;
      if (seen.cwd !== undefined) e.seenCwd = seen.cwd;
      if (changed) void fetchNow(id, e);
    },
    refresh(id) {
      const e = entries.get(id);
      if (e) void fetchNow(id, e);
    },
  };
}
