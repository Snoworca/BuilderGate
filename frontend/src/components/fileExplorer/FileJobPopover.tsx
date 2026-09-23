// The small popover above the status bar's right end (design 4.2): one line per
// job with its bar and a cancel button. It is a popover, not a window, so it
// joins no dialog stack and cannot be dragged or resized; a press anywhere
// outside it closes it. A press on the status bar is not "outside" — the bar
// toggles the popover itself and would otherwise close and reopen it.
// @req FR-FEX-008

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { fileJobApi } from '../../services/api.ts';
import { closeFileJobPopover, isFileJobPopoverOpen, subscribeFileJobPopover } from './fileJobPopoverState.ts';
import { decidePopoverOutsideClose, getFileJobSnapshot, selectPopoverRows, subscribeFileJobs } from './fileJobStore.ts';
import './FileJobStatus.css';

export interface FileJobPopoverProps {
  statusBarRef: RefObject<HTMLElement | null>;
}

// The job's own done event removes its line, so a failed request only needs a trace.
function cancelFileJob(jobId: string): void {
  fileJobApi.cancel(jobId).catch((error: unknown) => {
    console.warn('[file-job] cancel failed', jobId, error);
  });
}

/** @req FR-FEX-008 */
export function FileJobPopover({ statusBarRef }: FileJobPopoverProps) {
  const open = useSyncExternalStore(subscribeFileJobPopover, isFileJobPopoverOpen);
  const snapshot = useSyncExternalStore(subscribeFileJobs, getFileJobSnapshot);
  const rows = useMemo(() => selectPopoverRows(snapshot), [snapshot]);
  const popoverRef = useRef<HTMLDivElement>(null);
  const empty = rows.length === 0;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inPopover = popoverRef.current?.contains(target) ?? false;
      const inStatusBar = statusBarRef.current?.contains(target) ?? false;
      if (decidePopoverOutsideClose(inPopover, inStatusBar)) closeFileJobPopover();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, statusBarRef]);

  // The last job finishing closes it, so the next job does not pop it open unasked.
  useEffect(() => {
    if (open && empty) closeFileJobPopover();
  }, [open, empty]);

  if (!open || rows.length === 0) return null;

  return (
    <div ref={popoverRef} className="fx-job-popover" role="dialog" aria-label="파일 작업">
      <h6 className="fx-job-popover-title">파일 작업</h6>
      {rows.map((row) => (
        <div key={row.jobId} className="fx-job-item">
          <div className="fx-job-item-head">
            <span className="fx-job-text">{row.label}</span>
            <button
              type="button"
              className="fx-job-cancel"
              aria-label="취소"
              title="취소"
              onClick={() => cancelFileJob(row.jobId)}
            >
              ×
            </button>
          </div>
          {row.indeterminate ? (
            <span className="fx-job-spinner" aria-hidden="true" />
          ) : (
            <span className="fx-job-bar" aria-hidden="true">
              <i className="fx-job-bar-fill" style={{ width: `${Math.round(row.fraction * 100)}%` }} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
