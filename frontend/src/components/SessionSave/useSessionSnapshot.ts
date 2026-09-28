// FR-AITUI-009 / FR-AITUI-015 — the client state behind the header button, the
// save dialog and the restore report.
import { useCallback, useEffect, useState } from 'react';
import { sessionSnapshotApi } from '../../services/api.ts';
import type { AgentTabCandidate, SnapshotStatus } from './sessionSnapshotModel.ts';
import type { RestoreReportItem, SaveItem, SnapshotPreview } from './sessionSaveAllModel.ts';

const CANDIDATE_POLL_MS = 15_000;
/** While a resumed agent is still being looked for, the report is read this often. */
const REPORT_POLL_MS = 2_000;

export interface SessionSnapshotState {
  status: SnapshotStatus | null;
  candidates: AgentTabCandidate[];
  refresh: () => Promise<void>;
  preview: () => Promise<SnapshotPreview>;
  saveAll: (items: SaveItem[]) => Promise<void>;
  retry: (item: SaveItem) => Promise<RestoreReportItem>;
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

  const waiting = status?.report?.some((item) => item.result === 'waiting') ?? false;
  useEffect(() => {
    if (!enabled || !waiting) return undefined;
    const timer = window.setInterval(() => {
      sessionSnapshotApi.getStatus().then(setStatus).catch(() => undefined);
    }, REPORT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, waiting]);

  const preview = useCallback(() => sessionSnapshotApi.preview(), []);

  const saveAll = useCallback(async (items: SaveItem[]) => {
    await sessionSnapshotApi.saveAll(items);
    await refresh();
  }, [refresh]);

  const retry = useCallback(async (item: SaveItem) => {
    const result = await sessionSnapshotApi.retry(item);
    await refresh();
    return result;
  }, [refresh]);

  const discard = useCallback(async () => {
    await sessionSnapshotApi.discard();
    await refresh();
  }, [refresh]);

  return { status, candidates, refresh, preview, saveAll, retry, discard };
}
