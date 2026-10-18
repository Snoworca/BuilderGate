// The app's bottom status bar for file jobs (design 4.1). It counts every job
// the socket reports, whichever window or client started it, and takes no room
// when there is none: the terminal grid above only gives up a row while a job
// runs. Pressing it toggles the popover (4.2); a job waiting for an answer adds
// a button that brings back the explorer window that must ask it (4.3), since
// the question may only be asked inside that window (FR-FEX-009).
//
// This is not components/StatusBar, which no render path reaches and which
// carries concepts from an older layout.
// @req FR-FEX-008
// @req FR-FEX-009
// @req FR-FEX-024
//
// Uploads and ZIP downloads are jobs the browser drives itself; they come from fileTransferStore
// and are counted on the same bar (FR-FEX-024 AC-1).

import { t, tn } from '../../i18n/i18n.ts';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { FileJobPopover } from './FileJobPopover.tsx';
import { isFileJobPopoverOpen, subscribeFileJobPopover, toggleFileJobPopover } from './fileJobPopoverState.ts';
import { AWAITING_LABEL, getFileJobSnapshot, selectStatusBarView, subscribeFileJobs } from './fileJobStore.ts';
import { getFileTransferSnapshot, selectTransferJobRows, subscribeFileTransfers } from './fileTransferStore.ts';
import './FileJobStatus.css';

export interface FileJobStatusBarProps {
  /** Opens (or raises) the explorer window of the workspace whose job is waiting. */
  onRevive: (workspaceId: string) => void;
}

function percentOf(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** @req FR-FEX-008 @req FR-FEX-009 */
export function FileJobStatusBar({ onRevive }: FileJobStatusBarProps) {
  const snapshot = useSyncExternalStore(subscribeFileJobs, getFileJobSnapshot);
  const view = useMemo(() => selectStatusBarView(snapshot), [snapshot]);
  const popoverOpen = useSyncExternalStore(subscribeFileJobPopover, isFileJobPopoverOpen);
  // The popover asks whether a press landed here: pressing the bar toggles the
  // popover itself, so that press must not also count as an outside press.
  const barRef = useRef<HTMLDivElement>(null);
  const transfers = useSyncExternalStore(subscribeFileTransfers, getFileTransferSnapshot);
  const transferRows = useMemo(() => selectTransferJobRows(transfers, 0), [transfers]);

  if (view.kind === 'hidden' && transferRows.length === 0) return null;
  const awaiting = view.kind === 'hidden' ? null : view.awaiting;
  // One transfer and no server job: its own bar and title, as one server job shows its file.
  const onlyTransfer = view.kind === 'hidden' && transferRows.length === 1 ? transferRows[0] : null;
  const serverCount = view.kind === 'single' ? 1 : view.kind === 'multiple' ? view.count : 0;
  const totalCount = serverCount + transferRows.length;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleFileJobPopover();
    }
  };

  return (
    <>
      <div
        ref={barRef}
        className="fx-job-statusbar"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        onClick={() => toggleFileJobPopover()}
        onKeyDown={onKeyDown}
      >
        {onlyTransfer !== null ? (
          <>
            {onlyTransfer.indeterminate ? (
              <span className="fx-job-spinner" aria-hidden="true" />
            ) : (
              <span className="fx-job-bar" aria-hidden="true">
                <i className="fx-job-bar-fill" style={{ width: percentOf(onlyTransfer.fraction) }} />
              </span>
            )}
            <span className={`fx-job-text${onlyTransfer.tone === 'warn' ? ' fx-job-warn-text' : ''}`}>{onlyTransfer.title}</span>
            {!onlyTransfer.indeterminate && <span className="fx-job-pct">{percentOf(onlyTransfer.fraction)}</span>}
          </>
        ) : view.kind === 'single' && transferRows.length === 0 ? (
          <>
            {view.indeterminate ? (
              <span className="fx-job-spinner" aria-hidden="true" />
            ) : (
              <span className="fx-job-bar" aria-hidden="true">
                <i className="fx-job-bar-fill" style={{ width: percentOf(view.fraction) }} />
              </span>
            )}
            <span className="fx-job-text">{view.currentFile ?? ''}</span>
            {!view.indeterminate && <span className="fx-job-pct">{percentOf(view.fraction)}</span>}
          </>
        ) : view.kind === 'multiple' || totalCount > 1 ? (
          <>
            <span className="fx-job-spinner" aria-hidden="true" />
            <span className="fx-job-text">{tn('fileExplorer.job.runningCount', view.kind === 'multiple' && transferRows.length === 0 ? view.count : totalCount)}</span>
          </>
        ) : null}
        {awaiting !== null && (
          <button
            type="button"
            className="fx-job-awaiting"
            onClick={(event) => {
              // The bar under it toggles the popover; this press is only for the window.
              event.stopPropagation();
              onRevive(awaiting.workspaceId);
            }}
          >
            <span className="fx-job-awaiting-dot" aria-hidden="true" />
            {t(AWAITING_LABEL)}
          </button>
        )}
      </div>
      <FileJobPopover statusBarRef={barRef} />
    </>
  );
}
