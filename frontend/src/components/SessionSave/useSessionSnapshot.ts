// FR-AITUI-009 — the client state behind the header button, the save dialog,
// the restore banner and the restore dialog.
import { useCallback, useEffect, useState } from 'react';
import { sessionSnapshotApi } from '../../services/api.ts';
import type { AgentTabCandidate, SaveResultItem, SnapshotRestoreState, SnapshotStatus } from './sessionSnapshotModel.ts';

const CANDIDATE_POLL_MS = 15_000;

export interface SessionSnapshotState {
  status: SnapshotStatus | null;
  candidates: AgentTabCandidate[];
  refresh: () => Promise<void>;
  save: (tabIds: string[]) => Promise<SaveResultItem[]>;
  restore: (tabIds: string[]) => Promise<Array<{ tabId: string; restore: SnapshotRestoreState }>>;
  discard: () => Promise<void>;
}

export function useSessionSnapshot(enabled: boolean): SessionSnapshotState {
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [candidates, setCandidates] = useState<AgentTabCandidate[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextCandidates] = await Promise.all([
        sessionSnapshotApi.getStatus(),
        sessionSnapshotApi.getCandidates(),
      ]);
      setStatus(nextStatus);
      setCandidates(nextCandidates);
    } catch (error) {
      console.warn('[SessionSnapshot] refresh failed', error);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, CANDIDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  const save = useCallback(async (tabIds: string[]) => {
    const { results } = await sessionSnapshotApi.save(tabIds);
    await refresh();
    return results;
  }, [refresh]);

  const restore = useCallback(async (tabIds: string[]) => {
    const { results } = await sessionSnapshotApi.restore(tabIds);
    await refresh();
    return results;
  }, [refresh]);

  const discard = useCallback(async () => {
    await sessionSnapshotApi.discard();
    await refresh();
  }, [refresh]);

  return { status, candidates, refresh, save, restore, discard };
}
