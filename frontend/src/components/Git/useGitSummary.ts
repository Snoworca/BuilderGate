/**
 * A component's view of a session's git summary. Subscribes while mounted with what
 * it needs (visible, running, mode) and tells the store when the session's status or
 * cwd changes, which asks again at once.
 *
 * @req FR-GIT-009
 * @req FR-GIT-011
 */
import { useEffect, useRef, useState } from 'react';
import type { GitDemand } from './gitPollPolicy.ts';
import type { GitSummaryState, GitSummaryStore, GitSummarySubscription } from './gitSummaryStore.ts';
import { gitSummaryStore } from './gitStores.ts';

export interface UseGitSummaryOptions extends GitDemand {
  status?: string;
  cwd?: string | null;
  /** Tests pass their own store. */
  store?: GitSummaryStore;
}

export function useGitSummary(sessionId: string, options: UseGitSummaryOptions): GitSummaryState {
  const store = options.store ?? gitSummaryStore();
  const [state, setState] = useState<GitSummaryState>(() => store.get(sessionId));
  const subRef = useRef<GitSummarySubscription | null>(null);
  const { visible, running, mode, wsl, status, cwd } = options;

  useEffect(() => {
    const sub = store.subscribe(sessionId, { visible, running, mode, wsl }, () => setState(store.get(sessionId)));
    subRef.current = sub;
    setState(store.get(sessionId));
    return () => { sub.unsubscribe(); subRef.current = null; };
    // The demand is pushed by the effect below; re-subscribing on every change would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessionId]);

  useEffect(() => {
    subRef.current?.update({ visible, running, mode, wsl });
  }, [visible, running, mode, wsl]);

  useEffect(() => {
    store.notify(sessionId, { status, cwd });
  }, [store, sessionId, status, cwd]);

  return state;
}
