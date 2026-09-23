// The thin progress row at the bottom of an explorer window (design 4.4): the
// latest job this window started — bar, kind, `processed / total`, cancel — and
// '외 N개' when there are more, which opens the app's popover. Jobs from other
// windows or clients show on the status bar only. No job, no row.
//
// It reads the store itself from the window's workspaceId, so the window only
// has to place it.
// @req FR-FEX-008

import { useMemo, useSyncExternalStore } from 'react';
import { fileJobApi } from '../../services/api.ts';
import { openFileJobPopover } from './fileJobPopoverState.ts';
import { getFileJobSnapshot, selectProgressRowView, selectWindowJobs, subscribeFileJobs } from './fileJobStore.ts';
import './FileJobStatus.css';

export interface FileExplorerProgressRowProps {
  workspaceId: string;
}

// The job's own done event removes the row, so a failed request only needs a trace.
function cancelFileJob(jobId: string): void {
  fileJobApi.cancel(jobId).catch((error: unknown) => {
    console.warn('[file-job] cancel failed', jobId, error);
  });
}

/** @req FR-FEX-008 */
export function FileExplorerProgressRow({ workspaceId }: FileExplorerProgressRowProps) {
  const snapshot = useSyncExternalStore(subscribeFileJobs, getFileJobSnapshot);
  const jobs = useMemo(() => selectWindowJobs(snapshot, workspaceId), [snapshot, workspaceId]);
  const view = useMemo(() => selectProgressRowView(jobs), [jobs]);

  if (view === null) return null;

  return (
    <div className="fx-job-row" role="status">
      {view.indeterminate ? (
        <span className="fx-job-spinner" aria-hidden="true" />
      ) : (
        <span className="fx-job-bar" aria-hidden="true">
          <i className="fx-job-bar-fill" style={{ width: `${Math.round(view.fraction * 100)}%` }} />
        </span>
      )}
      <span className="fx-job-text">{view.label}</span>
      <span className="fx-job-count">{`${view.processedEntries} / ${view.totalEntries}`}</span>
      {view.moreCount > 0 && (
        <button type="button" className="fx-job-more" onClick={() => openFileJobPopover()}>
          {`외 ${view.moreCount}개`}
        </button>
      )}
      <button
        type="button"
        className="fx-job-cancel"
        aria-label="취소"
        title="취소"
        onClick={() => cancelFileJob(view.jobId)}
      >
        ×
      </button>
    </div>
  );
}
