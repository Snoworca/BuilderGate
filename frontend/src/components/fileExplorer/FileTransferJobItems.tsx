// The popover lines of uploads and ZIP downloads (FR-FEX-024 AC-1/AC-3, FR-FEX-025 AC-6): a
// determinate bar, the file being sent, bytes and speed, a cancel; a finished upload with
// failures lists them with their reasons and offers 재시도 for those files only.
// @req FR-FEX-024
// @req FR-FEX-025

import { t } from '../../i18n/i18n.ts';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { IconButton } from '../common';
import { cancelFileTransfer, dismissFileTransfer, retryFileTransfer } from './fileTransferRuntime.ts';
import { getFileTransferSnapshot, selectTransferJobRows, selectUploadRunning, subscribeFileTransfers } from './fileTransferStore.ts';

/** @req FR-FEX-024 */
export function FileTransferJobItems() {
  const snapshot = useSyncExternalStore(subscribeFileTransfers, getFileTransferSnapshot);
  // Speed reads the clock; a running transfer re-renders at least once a second for it.
  const [now, setNow] = useState(() => Date.now());
  const running = selectUploadRunning(snapshot);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const rows = useMemo(() => selectTransferJobRows(snapshot, Math.max(now, Date.now())), [snapshot, now]);

  return (
    <>
      {/* FR-FEX-024 AC-5: what closing the tab would do, while it would. */}
      {running && <p className="fx-job-warn">{t('fileTransfer.popover.warn')}</p>}
      {rows.map((row) => (
        <div key={row.jobId} className={`fx-job-item fx-transfer-${row.tone}`}>
          <div className="fx-job-item-head">
            <span className="fx-job-text">{row.title}</span>
            {row.canCancel && (
              <IconButton icon="close" className="fx-job-cancel" label={t('fileTransfer.job.cancel')} onClick={() => cancelFileTransfer(row.jobId)} />
            )}
          </div>
          {row.indeterminate ? (
            <span className="fx-job-spinner" aria-hidden="true" />
          ) : (
            <span className="fx-job-bar" role="progressbar" aria-valuenow={Math.round(row.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
              <i className="fx-job-bar-fill" style={{ width: `${Math.round(row.fraction * 100)}%` }} />
            </span>
          )}
          {(row.detail !== null || row.bytes !== null) && (
            <div className="fx-job-sub">
              <span>{row.detail ?? ''}</span>
              <span>{row.bytes ?? ''}</span>
            </div>
          )}
          {row.failed.length > 0 && (
            <ul className="fx-job-fail-list">
              {row.failed.map((failure) => (
                <li key={failure.name}>
                  <span>{failure.name}</span>
                  <em>{failure.reason}</em>
                </li>
              ))}
            </ul>
          )}
          {(row.canRetry || row.canDismiss) && (
            <div className="fx-job-sub fx-job-actions">
              {row.canRetry && <button type="button" className="fx-link-button" onClick={() => retryFileTransfer(row.jobId)}>{t('fileTransfer.job.retry')}</button>}
              {row.canDismiss && <button type="button" className="fx-link-button" onClick={() => dismissFileTransfer(row.jobId)}>{t('fileTransfer.job.dismiss')}</button>}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
