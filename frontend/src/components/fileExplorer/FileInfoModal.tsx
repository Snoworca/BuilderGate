// FR-FEX-018: the information modal. Drawn inside the explorer body like the window's
// question modal (never portalled, no aria-modal), so it blocks only this explorer.
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { t } from '../../i18n/i18n.ts';
import { fileApi } from '../../services/api.ts';
import type { PathStat } from '../../types/index.ts';
import { copyTextToClipboard } from '../../utils/clipboardCopy.ts';
import { buildInfoRows, formatInfoTable, type InfoRow } from './fileInfoModel.ts';
import { formatEntryModified } from './fileListView.ts';

export interface FileInfoModalProps {
  sessionId: string;
  path: string;
  onClose: () => void;
}

export function FileInfoModal({ sessionId, path, onClose }: FileInfoModalProps) {
  const [stat, setStat] = useState<PathStat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fileApi.statPath(sessionId, path)
      .then((result) => { if (live) setStat(result); })
      .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [sessionId, path]);

  useEffect(() => { boxRef.current?.focus(); }, []);

  const rows: InfoRow[] = stat === null ? [] : buildInfoRows(stat, formatEntryModified);

  const copy = (text: string) => {
    copyTextToClipboard(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => setCopied(false));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The explorer's own keys (type-to-filter, Delete, Ctrl+C) must not act behind it.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const name = stat?.name ?? path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="fx-window-modal">
      <div className="fx-window-modal-scrim" onClick={onClose} />
      <div className="fx-window-modal-box fx-info-box" role="dialog" aria-label={t('fileExplorer.info.title', { name })} ref={boxRef} tabIndex={-1} onKeyDown={handleKeyDown}>
        <div className="fx-window-modal-title">{t('fileExplorer.info.title', { name })}</div>
        {error !== null && <div className="fx-window-modal-message" role="alert">{t('fileExplorer.info.failed', { message: error })}</div>}
        {error === null && stat === null && <div className="fx-window-modal-message">{t('fileExplorer.info.loading')}</div>}
        {rows.length > 0 && (
          <table className="fx-info-table">
            <tbody>
              {rows.map((row) => (
                <tr key={row.labelKey}>
                  <th scope="row">{t(row.labelKey)}</th>
                  <td>{row.value}</td>
                  <td className="fx-info-copy-cell">
                    <button type="button" className="fx-info-copy" title={t('fileExplorer.info.copy')} aria-label={`${t('fileExplorer.info.copy')}: ${t(row.labelKey)}`} onClick={() => copy(row.value)}>⧉</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="fx-window-modal-actions">
          {copied && <span className="fx-info-copied" role="status">{t('fileExplorer.info.copied')}</span>}
          <button type="button" className="fx-confirm-button" disabled={rows.length === 0} onClick={() => copy(formatInfoTable(rows))}>{t('fileExplorer.info.copyAll')}</button>
          <button type="button" className="fx-confirm-button" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
