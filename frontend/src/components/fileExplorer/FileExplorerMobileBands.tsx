// The two bands a phone stacks above its file bar (FR-FEX-026 AC-2, AC-5): the selection band
// — count, 여러 개 선택, 전체 선택, close — and, while an upload of this window runs, the progress
// band, whose tap opens the job popover and whose 44 px button cancels the upload.
// @req FR-FEX-026

import { t } from '../../i18n/i18n.ts';
import { useMemo, useSyncExternalStore } from 'react';
import { IconButton } from '../common';
import { openFileJobPopover } from './fileJobPopoverState.ts';
import { cancelFileTransfer } from './fileTransferRuntime.ts';
import { getFileTransferSnapshot, selectMobileUploadBand, subscribeFileTransfers } from './fileTransferStore.ts';
import { selectionBandText } from './fileTransferModel.ts';

export interface FileExplorerSelectionBandProps {
  count: number;
  multiSelect: boolean;
  onToggleMultiSelect: () => void;
  onSelectAll: () => void;
  /** Clears the selection and leaves the multi-select mode. */
  onClear: () => void;
}

/** @req FR-FEX-026 */
export function FileExplorerSelectionBand({ count, multiSelect, onToggleMultiSelect, onSelectAll, onClear }: FileExplorerSelectionBandProps) {
  return (
    <div className="fx-mobile-band fx-selection-band">
      <b className="fx-mobile-band-text">{selectionBandText(count)}</b>
      <button
        type="button"
        className={`fx-band-button${multiSelect ? ' is-pressed' : ''}`}
        aria-pressed={multiSelect}
        onClick={onToggleMultiSelect}
      >
        {t('fileTransfer.selection.multi')}
      </button>
      <button type="button" className="fx-band-button" onClick={onSelectAll}>{t('fileTransfer.selection.all')}</button>
      <IconButton icon="close" className="fx-mobile-band-cancel" label={t('fileTransfer.selection.clear')} onClick={onClear} />
    </div>
  );
}

/** @req FR-FEX-026 */
export function FileExplorerUploadBand({ workspaceId }: { workspaceId: string }) {
  const snapshot = useSyncExternalStore(subscribeFileTransfers, getFileTransferSnapshot);
  const band = useMemo(() => selectMobileUploadBand(snapshot, workspaceId), [snapshot, workspaceId]);
  if (band === null) return null;
  const percent = Math.round(band.fraction * 100);
  return (
    <div className="fx-mobile-band fx-upload-band">
      <button type="button" className="fx-upload-band-body" aria-label={t('fileTransfer.band.open')} onClick={() => openFileJobPopover()}>
        <span className="fx-upload-band-row">
          <span className="fx-mobile-band-text">{band.text}</span>
          <span>{`${percent}%`}</span>
        </span>
        <span className="fx-job-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <i className="fx-job-bar-fill" style={{ width: `${percent}%` }} />
        </span>
      </button>
      <IconButton icon="close" className="fx-mobile-band-cancel" label={t('fileTransfer.band.cancel')} onClick={() => cancelFileTransfer(band.jobId)} />
    </div>
  );
}
