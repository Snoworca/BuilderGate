// The 새 파일 window (FR-FEX-029): a folder, a name field and 만들기.
//
// Drawn inside the explorer's window body like FileExplorerWindowModal, so it
// blocks that window only. The window itself calls create: a refusal from the
// server (the name appeared since the listing) keeps it open with the reason,
// which a promise resolved before the request could not do.
// @req FR-FEX-029

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { t } from '../../i18n/i18n.ts';
import { isFileExistsError, validateNewFileName, type ListedEntry } from './newFileModel.ts';

export interface NewFileRequest {
  /** The folder the file is made in. */
  directory: string;
  /** What the window already lists there; an exact match is refused before asking the server. */
  entries: readonly ListedEntry[];
  /** Makes the file; rejects with the server's error. */
  create: (name: string) => Promise<void>;
}

interface PendingRequest extends NewFileRequest {
  id: number;
  resolve: (name: string | null) => void;
}

export interface NewFileDialogState {
  current: PendingRequest | null;
  /** Opens the window; resolves with the created name, or null when cancelled. */
  ask: (request: NewFileRequest) => Promise<string | null>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNewFileDialog(): NewFileDialogState {
  const [current, setCurrent] = useState<PendingRequest | null>(null);
  const nextIdRef = useRef(0);
  const ask = useCallback((request: NewFileRequest) => new Promise<string | null>((resolve) => {
    const entry: PendingRequest = {
      ...request,
      id: nextIdRef.current++,
      resolve: (name) => {
        setCurrent((shown) => (shown === entry ? null : shown));
        resolve(name);
      },
    };
    // One at a time: a second request while one is open cancels the first.
    setCurrent((shown) => {
      shown?.resolve(null);
      return entry;
    });
  }), []);
  return useMemo(() => ({ current, ask }), [ask, current]);
}

export function NewFileDialog({ dialog }: { dialog: NewFileDialogState }) {
  if (dialog.current === null) return null;
  return <NewFileSurface key={dialog.current.id} request={dialog.current} />;
}

function NewFileSurface({ request }: { request: PendingRequest }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const check = validateNewFileName(value, request.entries);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const error = serverError ?? (
    check.kind === 'invalid'
      ? t(check.reason === 'separator' ? 'fileExplorer.newFile.error.separator' : 'fileExplorer.newFile.error.reserved')
      : check.kind === 'exists'
        ? t(check.isDir ? 'fileExplorer.newFile.error.existsFolder' : 'fileExplorer.newFile.error.existsFile', { name: check.name })
        : null
  );
  const canCreate = check.kind === 'ok' && serverError === null && !busy;

  const submit = () => {
    if (!canCreate || check.kind !== 'ok') return;
    const name = check.name;
    setBusy(true);
    request.create(name).then(() => request.resolve(name), (failure: unknown) => {
      setBusy(false);
      setServerError(isFileExistsError(failure)
        ? t('fileExplorer.newFile.error.existsNow', { name })
        : t('fileExplorer.newFile.error.failed', { message: failure instanceof Error ? failure.message : String(failure) }));
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The window's own shortcuts (Delete, Ctrl+C, arrows) must not act on the list behind.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) request.resolve(null);
    } else if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="fx-window-modal fx-new-file">
      <div className="fx-window-modal-scrim" />
      <div className="fx-window-modal-box fx-new-file-box" role="dialog" aria-label={t('fileExplorer.newFile.title')} onKeyDown={handleKeyDown}>
        <div className="fx-window-modal-title">{t('fileExplorer.newFile.title')}</div>
        <div className="fx-new-file-field">
          <span className="fx-new-file-label">{t('fileExplorer.newFile.location')}</span>
          <div className="fx-new-file-location" title={request.directory}><bdi>{request.directory}</bdi></div>
        </div>
        <label className="fx-new-file-field">
          <span className="fx-new-file-label">{t('fileExplorer.newFile.name')}</span>
          <input
            ref={inputRef}
            className={`fx-new-file-input${error !== null ? ' is-error' : ''}`}
            value={value}
            placeholder={t('fileExplorer.newFile.placeholder')}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            disabled={busy}
            onChange={(event) => {
              setValue(event.target.value);
              setServerError(null);
            }}
          />
        </label>
        <div className={`fx-new-file-message${error !== null ? ' is-error' : ''}`} role={error !== null ? 'alert' : undefined}>
          {error ?? t('fileExplorer.newFile.hint')}
        </div>
        <div className="fx-window-modal-actions">
          <button type="button" className="fx-confirm-button" disabled={busy} onClick={() => request.resolve(null)}>{t('common.cancel')}</button>
          <button type="button" className="fx-confirm-button fx-primary" disabled={!canCreate} onClick={submit}>{t('fileExplorer.newFile.create')}</button>
        </div>
      </div>
    </div>
  );
}
