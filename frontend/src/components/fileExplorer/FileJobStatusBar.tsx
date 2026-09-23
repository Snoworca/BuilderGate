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

import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { FileJobPopover } from './FileJobPopover.tsx';
import { isFileJobPopoverOpen, subscribeFileJobPopover, toggleFileJobPopover } from './fileJobPopoverState.ts';
import { AWAITING_LABEL, getFileJobSnapshot, selectStatusBarView, subscribeFileJobs } from './fileJobStore.ts';
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

  if (view.kind === 'hidden') return null;
  const awaiting = view.awaiting;

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
        {view.kind === 'single' ? (
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
        ) : view.kind === 'multiple' ? (
          <>
            <span className="fx-job-spinner" aria-hidden="true" />
            <span className="fx-job-text">{`${view.count}개 작업 진행 중`}</span>
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
            {AWAITING_LABEL}
          </button>
        )}
      </div>
      <FileJobPopover statusBarRef={barRef} />
    </>
  );
}
