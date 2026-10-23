/**
 * One git summary poll per session, shared by every chip, path menu and Git window
 * that shows it. Subscribers declare what they need (visible, running, mode); the
 * store polls at the fastest needed rate and stops when nothing visible needs it.
 * A change of the session's status or cwd asks again at once.
 *
 * @req FR-GIT-009
 * @req FR-GIT-011
 * @req REL-BGSTAB-052
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
  /** When the last answer arrived, kept even when the summary object is reused (AC-5). */
  checkedAt?: number;
}

export interface GitSummaryStoreDeps {
  fetchSummary: (sessionId: string, signal: AbortSignal) => Promise<GitSummary>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** The document's visibility (tests); the real document when there is one. */
  visibility?: { hidden: () => boolean; onChange: (fn: () => void) => void };
}

function documentVisibility(): GitSummaryStoreDeps['visibility'] {
  if (typeof document === 'undefined') return undefined;
  return {
    hidden: () => document.visibilityState === 'hidden',
    onChange: (fn) => document.addEventListener('visibilitychange', fn),
  };
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
  // REL-BGSTAB-052 AC-4: a browser tab in the background polls nothing; each poll would run
  // git on the server (~360 an hour per chip). Back in view, every session asks once at once.
  const visibility = deps.visibility ?? documentVisibility();
  const hidden = () => visibility?.hidden() ?? false;

  const entryFor = (id: string): Entry => {
    let e = entries.get(id);
    if (!e) {
      e = { subs: new Map(), state: EMPTY, timer: null, controller: null, lastFetchAt: -Infinity, lastDurationMs: 0, sameCount: 0, lastJson: '' };
      entries.set(id, e);
    }
    return e;
  };
  const emit = (e: Entry) => { for (const s of [...e.subs.values()]) s.listener(); };
  const interval = (e: Entry) => (hidden() ? null : pollInterval([...e.subs.values()].map((s) => s.demand), e));
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
    // REL-BGSTAB-052 AC-5: once something is shown, a poll in progress changes nothing on
    // screen, so it is not announced; only a first load is.
    if (e.state.summary === null) {
      e.state = { ...e.state, loading: true };
      emit(e);
    }
    const before = e.state;
    try {
      const summary = await deps.fetchSummary(id, controller.signal);
      if (controller.signal.aborted) return;
      const json = comparable(summary);
      const same = json === e.lastJson;
      e.sameCount = same ? e.sameCount + 1 : 0;
      e.lastJson = json;
      // An unchanged answer keeps the object a window renders from, so nothing re-renders.
      const reuse = same && before.summary !== null && before.error === null && !before.loading;
      e.state = reuse
        ? Object.assign(before, { checkedAt: now() }) // same object: listeners need not hear it
        : { summary, error: null, stale: false, loading: false, checkedAt: now() };
    } catch (err) {
      if (controller.signal.aborted) return;
      const code = err instanceof GitApiError ? err.code : 'GIT_FAILED';
      e.state = { summary: e.state.summary, error: code, stale: e.state.summary !== null, loading: false, checkedAt: e.state.checkedAt };
    } finally {
      if (e.controller === controller) {
        e.controller = null;
        e.lastFetchAt = now();
        e.lastDurationMs = e.lastFetchAt - started;
      }
    }
    if (e.state !== before) emit(e);
    if (entries.get(id) === e) schedule(id, e);
  };

  // Back in view, the sessions ask one after another (0-1 s apart) rather than all at once:
  // each ask runs git, and for a WSL session wsl.exe, on the server.
  visibility?.onChange(() => {
    let order = 0;
    for (const [id, e] of entries) {
      stopTimer(e);
      if (hidden() || interval(e) === null) { schedule(id, e); continue; }
      const delay = Math.min(1_000, order * 250);
      order += 1;
      if (delay === 0) void fetchNow(id, e);
      else e.timer = setTimer(() => { e.timer = null; void fetchNow(id, e); }, delay);
    }
  });

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
