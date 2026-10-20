// Small pieces of the explorer window for transfers (#139): the chip naming the folder a drop
// goes to (FR-FEX-022 AC-4), the dimmed rows still arriving at the bottom of the list
// (FR-FEX-024 AC-2) and the toast that reports a finished or cancelled upload.
// @req FR-FEX-022
// @req FR-FEX-024
// @req FR-FEX-030

import { t } from '../../i18n/i18n.ts';
import { useEffect } from 'react';
import { Icon } from '../common';
import type { PendingUploadRow } from './fileTransferStore.ts';

export interface DropChipTarget {
  /** The directory row's name, or null when the folder on screen is the target. */
  name: string | null;
  dir: string;
  /** FR-FEX-030: an explorer drag says what the drop does, or why it cannot land. */
  drag?: { op: 'move' | 'copy'; copyHint: string } | { op: 'deny'; reason: string };
}

function lastName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? dir;
}

/** FR-FEX-022 AC-4: read out as it changes, so a screen reader hears the target too. */
export function FileExplorerDropChip({ target }: { target: DropChipTarget | null }) {
  return (
    <div className={`fx-drop-chip${target === null ? '' : ' is-shown'}`} aria-live="polite">
      {target !== null && target.drag !== undefined && (
        target.drag.op === 'deny'
          ? (
            <>
              <Icon name="alert" size={14} />
              <span className="fx-drop-deny-text">{target.drag.reason}</span>
            </>
          )
          : (
            <>
              <Icon name={target.drag.op === 'copy' ? 'copy' : 'move'} size={14} />
              <span>{t(target.drag.op === 'copy' ? 'fileExplorer.drag.copyTo' : 'fileExplorer.drag.moveTo', { name: target.name ?? lastName(target.dir) })}</span>
              {target.drag.op === 'move' && <small className="fx-drop-hint">{target.drag.copyHint}</small>}
            </>
          )
      )}
      {target !== null && target.drag === undefined && (
        <>
          <Icon name="upload" size={14} />
          <span>{target.name === null ? t('fileTransfer.drop.here') : t('fileTransfer.drop.into', { name: target.name })}</span>
          <code className="fx-drop-path">{target.dir}</code>
        </>
      )}
    </div>
  );
}

/** FR-FEX-024 AC-2: pinned under the listing, so a re-sort never moves them. */
export function FileExplorerPendingRows({ rows }: { rows: readonly PendingUploadRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="fx-pending-rows" role="presentation">
      {rows.map((row, index) => {
        const percent = Math.round(row.fraction * 100);
        return (
          <div key={row.key} className={`fx-row fx-pending-row${index === 0 ? ' fx-pending-first' : ''}`} data-pending={row.name}>
            <span className="fx-name fx-col-name">
              <Icon name="upload" size={14} />
              <span className="fx-pending-name">{row.name}</span>
            </span>
            <span className="fx-meta fx-col-modified">
              <span className="fx-pending-pct" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>{`${percent}%`}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface FileExplorerToastState {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

const TOAST_MS = 3200;

/** A line at the bottom of the window that leaves by itself; its action is optional. */
export function FileExplorerToast({ toast, onDismiss }: { toast: FileExplorerToastState | null; onDismiss: () => void }) {
  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  if (toast === null) return null;
  return (
    <div className="fx-toast" role="status">
      <span>{toast.message}</span>
      {toast.actionLabel !== undefined && (
        <button
          type="button"
          className="fx-toast-action"
          onClick={() => {
            toast.onAction?.();
            onDismiss();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}
